/**
 * S-17 の核。二つの側（side 0 / side 1）が持つ形質と、その対戦・複製の規則だけを書く。
 *
 * このファイルが知っているのは次だけである:
 *
 *   形質は L 個の位置それぞれが 0 か 1 を取る並びで、32bit 整数1個に詰める。
 *   side 0 の形質 a と side 1 の形質 b が対戦すると、位置ごとに次の値が付く:
 *
 *       a_i = b_i          … 1
 *       a_i = 1, b_i = 0   … w
 *       a_i = 0, b_i = 1   … 0
 *
 *   その平均 S(a,b) ∈ [0,1] が side 0 の取り分で、side 1 の取り分は 1 − S(a,b)。
 *   各個体は相手側から E 体を引いて対戦し、取り分の平均から cost·(1 の個数)/L を引いた値を
 *   「重み」として持つ。次の並びは、重みの大きい方が勝つ2体の籤を N 回引いて作り、
 *   各位置を確率 mu で反転させる。両側は同じ「前の並び」を見て同時に更新される。
 *
 * **w はこのファイルの中では単なる一つの数**である。0 のとき「相手と同じ位置を持つほど取り分が
 * 大きい」規則になり、1 のとき「1 を持つことが相手によらず損をしない」規則になる。
 * その二つがどう違うかを語る語彙（順序があるか・強くなったか・回っているだけか）は
 * ここには無い。それは stats.js の仕事である。
 *
 * 依存ゼロ。Node（生ログ生成）とブラウザ（可視化）が同じファイルを読む。
 *
 * 出典（アイデアのみ。コードは参照していない）:
 *   Agrawal, A. & Lively, C.M. (2002) "Infection genetics: gene-for-gene versus
 *   matching-alleles models and all points in between", Evolutionary Ecology Research 4, 79-90.
 *   位置ごとの表のうち (a=1,b=0) の1マスだけを w で動かすと二つの古典モデルが連続に繋がる。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S17 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 乱数・ビット操作
   * ------------------------------------------------------------------ */

  /** 決定論的な擬似乱数（mulberry32）。同じシードで完全に再現する。 */
  function makeRng(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 立っているビットの数。L <= 30 を前提にする。 */
  function popcount(v) {
    v = v - ((v >> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
    v = (v + (v >> 4)) & 0x0f0f0f0f;
    return (Math.imul(v, 0x01010101) >>> 24);
  }

  /** popcount の素朴版（近道の検算用）。 */
  function popcountNaive(v, L) {
    var n = 0;
    for (var i = 0; i < L; i++) if ((v >> i) & 1) n++;
    return n;
  }

  function maskOf(L) { return L >= 31 ? 0x7fffffff : ((1 << L) - 1); }

  /* ------------------------------------------------------------------ *
   * 対戦
   * ------------------------------------------------------------------ */

  /**
   * side 0 の形質 a と side 1 の形質 b の対戦で、side 0 が得る取り分 S(a,b) ∈ [0,1]。
   * side 1 の取り分は 1 − S(a,b)（和は常に 1）。
   */
  function scorePair(a, b, L, w, mask) {
    var m = mask === undefined ? maskOf(L) : mask;
    var p01 = popcount((~a) & b & m);   // a=0, b=1 の位置
    var p10 = popcount(a & (~b) & m);   // a=1, b=0 の位置
    return 1 - (p01 + (1 - w) * p10) / L;
  }

  /** 同じもの。位置を1つずつ見る素朴版（近道の検算用）。 */
  function scorePairNaive(a, b, L, w) {
    var s = 0;
    for (var i = 0; i < L; i++) {
      var ai = (a >> i) & 1, bi = (b >> i) & 1;
      if (ai === bi) s += 1;
      else if (ai === 1) s += w;
    }
    return s / L;
  }

  /**
   * 一様に引いた相手すべてに対する S(a,·) の平均。**解析式**。
   *   E_b[S(a,b)] = 1/2 + w·(a の 1 の個数)/(2L)
   * w = 0 ではどの a でも厳密に 1/2 になる。実装の外から来る恒等式なので正コントロールに使う。
   */
  function meanScoreAgainstUniform(a, L, w) {
    return 0.5 + w * popcount(a & maskOf(L)) / (2 * L);
  }

  /* ------------------------------------------------------------------ *
   * 並び（世代）
   * ------------------------------------------------------------------ */

  var DEFAULTS = {
    L: 24,            // 位置の数
    N: 64,            // 片側の個体数
    w: 0,             // 位置ごとの表のうち (a=1,b=0) のマスの値
    cost: 0,          // 1 の個数に比例して重みから引く量（L で割った割合に対して）
    mu: 0.01,         // 位置ごとの反転確率（数値なら両側共通、[m0,m1] なら側ごと）
    encounters: 8,    // 1体あたりの対戦回数（allEncounters が真なら無視）
    allEncounters: false, // 真なら相手側の全員と対戦する（標本誤差ゼロ）
    selection: 'tournament', // 'tournament' | 'none'（重みを使わず一様に引く）
    mode: 'encounter',       // 'encounter' | 'objective'（相手を見ず固定の的に合わせる）
    targetOnes: null,        // objective のとき、両側の的の 1 の個数を揃える（null なら一様乱択）
    frozen: [false, false],  // 真の側は複製も反転もしない
    seed: 1,
  };

  /** 的を1つ引く。targetOnes を指定したときは 1 の個数をちょうどその数にする。 */
  function pickTarget(o) {
    if (o.targetOnes === undefined || o.targetOnes === null) {
      return Math.floor(o.rng() * 4294967296) & o.mask;
    }
    var idx = [];
    for (var i = 0; i < o.L; i++) idx.push(i);
    for (var j = o.L - 1; j > 0; j--) {
      var r = (o.rng() * (j + 1)) | 0, t = idx[j]; idx[j] = idx[r]; idx[r] = t;
    }
    var v = 0;
    for (var k = 0; k < o.targetOnes; k++) v |= (1 << idx[k]);
    return v & o.mask;
  }

  function createWorld(opts) {
    var o = {};
    for (var k in DEFAULTS) o[k] = DEFAULTS[k];
    if (opts) for (var k2 in opts) if (opts[k2] !== undefined) o[k2] = opts[k2];
    o.frozen = [!!o.frozen[0], !!o.frozen[1]];
    o.muSide = (typeof o.mu === 'number') ? [o.mu, o.mu] : [o.mu[0], o.mu[1]];
    o.mask = maskOf(o.L);
    o.rng = makeRng(o.seed);
    o.gen = 0;
    o.side = [new Int32Array(o.N), new Int32Array(o.N)];
    for (var r = 0; r < 2; r++) {
      for (var i = 0; i < o.N; i++) {
        o.side[r][i] = (Math.floor(o.rng() * 4294967296) & o.mask);
      }
    }
    // 'objective' のときに使う固定の的。相手側とは無関係。
    // targetOnes を指定すると、両側の的の 1 の個数をちょうどその数に揃える。
    o.target = [pickTarget(o), pickTarget(o)];
    if (opts && opts.init) { o.side[0].set(opts.init[0]); o.side[1].set(opts.init[1]); }
    o.weight = [new Float64Array(o.N), new Float64Array(o.N)];
    return o;
  }

  /** 片側の重みを計算する。opp は「前の並び」でなければならない。 */
  function weighSide(W, role, own, opp) {
    var out = W.weight[role];
    var N = W.N, L = W.L, w = W.w, mask = W.mask, rng = W.rng;
    var E = W.allEncounters ? N : W.encounters;
    for (var i = 0; i < N; i++) {
      var a = own[i];
      var acc = 0;
      if (W.mode === 'objective') {
        // 相手を見ない。固定の的と一致する位置の割合。
        acc = (L - popcount((a ^ W.target[role]) & mask)) / L;
      } else if (W.allEncounters) {
        for (var j = 0; j < N; j++) {
          var s = role === 0 ? scorePair(a, opp[j], L, w, mask) : scorePair(opp[j], a, L, w, mask);
          acc += role === 0 ? s : 1 - s;
        }
        acc /= N;
      } else {
        for (var e = 0; e < E; e++) {
          var b = opp[(rng() * N) | 0];
          var s2 = role === 0 ? scorePair(a, b, L, w, mask) : scorePair(b, a, L, w, mask);
          acc += role === 0 ? s2 : 1 - s2;
        }
        acc /= E;
      }
      out[i] = acc - W.cost * popcount(a & mask) / L;
    }
    return out;
  }

  /** 重みから次の並びを作る（籤 → 反転）。 */
  function nextSide(W, own, weight, dst, role) {
    var N = W.N, L = W.L, rng = W.rng, mu = W.muSide[role || 0], mask = W.mask;
    for (var i = 0; i < N; i++) {
      var pick;
      if (W.selection === 'none') {
        pick = own[(rng() * N) | 0];
      } else {
        var x = (rng() * N) | 0, y = (rng() * N) | 0;
        pick = weight[x] >= weight[y] ? own[x] : own[y];
      }
      var t = pick;
      for (var p = 0; p < L; p++) if (rng() < mu) t ^= (1 << p);
      dst[i] = t & mask;
    }
    return dst;
  }

  /** 1世代。両側は同じ「前の並び」を見て同時に更新される。 */
  function stepWorld(W) {
    var pre0 = W.side[0], pre1 = W.side[1];
    var w0 = weighSide(W, 0, pre0, pre1);
    var w1 = weighSide(W, 1, pre1, pre0);
    var n0 = new Int32Array(W.N), n1 = new Int32Array(W.N);
    if (W.frozen[0]) n0.set(pre0); else nextSide(W, pre0, w0, n0, 0);
    if (W.frozen[1]) n1.set(pre1); else nextSide(W, pre1, w1, n1, 1);
    W.side[0] = n0; W.side[1] = n1;
    W.gen++;
    return W;
  }

  /* ------------------------------------------------------------------ *
   * 走らせ役
   * ------------------------------------------------------------------ */

  /** 位置ごとの 1 の割合。 */
  function oneFraction(traits, L) {
    var f = new Float64Array(L), N = traits.length;
    for (var i = 0; i < N; i++) {
      var t = traits[i];
      for (var p = 0; p < L; p++) if ((t >> p) & 1) f[p]++;
    }
    for (var q = 0; q < L; q++) f[q] /= N;
    return f;
  }

  /**
   * generations 世代走らせ、archiveEvery 世代ごとに両側の並びを控える。
   * 返り値の archive[role][k] は k 番目に控えた並び（Int32Array のコピー）。
   */
  function runWorld(opts, generations, archiveEvery, onArchive) {
    var W = createWorld(opts);
    var arch = [[], []], gens = [], freq = [[], []];
    function take() {
      arch[0].push(Int32Array.from(W.side[0]));
      arch[1].push(Int32Array.from(W.side[1]));
      freq[0].push(oneFraction(W.side[0], W.L));
      freq[1].push(oneFraction(W.side[1], W.L));
      gens.push(W.gen);
      if (onArchive) onArchive(W, arch, gens);
    }
    take();
    for (var g = 0; g < generations; g++) {
      stepWorld(W);
      if (W.gen % archiveEvery === 0) take();
    }
    return { world: W, archive: arch, gens: gens, freq: freq, L: W.L, N: W.N, w: W.w };
  }

  /** 並びの中身をそのまま足し合わせた指紋（再現性の検査用）。 */
  function fingerprint(arr) {
    var h = 2166136261;
    for (var i = 0; i < arr.length; i++) {
      h ^= arr[i]; h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  return {
    DEFAULTS: DEFAULTS,
    makeRng: makeRng, popcount: popcount, popcountNaive: popcountNaive, maskOf: maskOf,
    scorePair: scorePair, scorePairNaive: scorePairNaive,
    meanScoreAgainstUniform: meanScoreAgainstUniform,
    pickTarget: pickTarget, createWorld: createWorld, weighSide: weighSide, nextSide: nextSide, stepWorld: stepWorld,
    oneFraction: oneFraction, runWorld: runWorld, fingerprint: fingerprint,
  };
});
