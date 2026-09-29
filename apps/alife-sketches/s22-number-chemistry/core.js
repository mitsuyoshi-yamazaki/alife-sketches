/**
 * S-22 の核。分子は整数 2..M、反応は加減乗除のうち有限個。それだけを書く。
 *
 * このファイルが知っているのは次だけである:
 *
 *   容器には N 個の整数が入っている。順序つきで相異なる 2 個 (a, b) を一様に引き、
 *   規則の組のうち適用できるものを一様に 1 つ選んで積 p を作る。
 *
 *     add: p = a + b        （a + b ≤ M のとき）
 *     sub: p = b − a        （a < b かつ b − a ≥ 2 のとき）
 *     mul: p = a · b        （a · b ≤ M のとき）
 *     div: p = b / a        （a < b かつ a が b を割り切るとき）
 *
 *   scheme A（主）: 積 p は b を置き換える。a は残る（触媒）。
 *   scheme B（ノブ）: 積 p は容器の一様乱択の 1 分子を置き換える。a も b も残る。
 *   適用できる規則が無ければ何も起きない（弾性衝突）。流入は無く N は一定。
 *
 * **ここには「組織」「自己維持」「閉包」「回復」という語が無い。** 整数と規則と容器だけである。
 * 何が「組織」かを語るのは stats.js の仕事。
 *
 * このファイルにあるもう一つの種類のものは、**数論の事実**（gcd・素数・素因数の個数）である。
 * これらは系の外から来る恒等式（method K-18）の材料で、上位概念ではない。
 *
 * 依存ゼロ。Node（生ログ生成）とブラウザ（可視化）が同じファイルを読む。
 *
 * 出典（アイデアのみ。コードは参照していない）:
 *   Dittrich, P., Ziegler, J. & Banzhaf, W. (2001) "Artificial Chemistries — A Review",
 *   Artificial Life 7(3), 225-275. §2.2.2 の number-division chemistry
 *   （「s2 is transformed to s2/s1. Thus, s1 acts as a catalyst」）と §2.2.1 の
 *   触媒的な流れ反応器（積が乱択の 1 分子を置き換える）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S22 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 乱数
   * ------------------------------------------------------------------ */

  /** 決定論的な擬似乱数（mulberry32）。同じシードで完全に再現する。 */
  function makeRng(seed) {
    var a = (seed >>> 0) || 1;
    var f = function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    f.state = function () { return a; };
    f.setState = function (s) { a = s | 0; };
    return f;
  }

  /* ------------------------------------------------------------------ *
   * 数論の事実（実装の外から来る恒等式の材料）
   * ------------------------------------------------------------------ */

  function gcd(a, b) {
    a = Math.abs(a); b = Math.abs(b);
    while (b) { var t = a % b; a = b; b = t; }
    return a;
  }

  function isPrime(n) {
    if (n < 2) return false;
    if (n % 2 === 0) return n === 2;
    for (var d = 3; d * d <= n; d += 2) if (n % d === 0) return false;
    return true;
  }

  /** 素因数の個数（重複を数える）。Ω(12) = 3。 */
  function omega(n) {
    var c = 0;
    for (var d = 2; d * d <= n; d++) while (n % d === 0) { n /= d; c++; }
    if (n > 1) c++;
    return c;
  }

  /** 相異なる素因数の配列。 */
  function primeFactors(n) {
    var out = [];
    for (var d = 2; d * d <= n; d++) {
      if (n % d === 0) { out.push(d); while (n % d === 0) n /= d; }
    }
    if (n > 1) out.push(n);
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 規則
   * ------------------------------------------------------------------ */

  /** 4 つの規則。apply(a, b, M) は積を返し、適用できなければ 0 を返す。 */
  var RULES = {
    add: { id: 'add', symbol: '+', apply: function (a, b, M) { var p = a + b; return p <= M ? p : 0; } },
    sub: { id: 'sub', symbol: '−', apply: function (a, b) { return (a < b && b - a >= 2) ? b - a : 0; } },
    mul: { id: 'mul', symbol: '×', apply: function (a, b, M) { var p = a * b; return p <= M ? p : 0; } },
    div: { id: 'div', symbol: '÷', apply: function (a, b) { return (a < b && b % a === 0) ? b / a : 0; } },
  };

  /** 腕の名前 → 規則の id の並び。乱択表の腕は rulesForArm が作る。 */
  var ARMS = {
    'add-sub': ['add', 'sub'], 'mul-div': ['mul', 'div'],
    'add-div': ['add', 'div'], 'mul-sub': ['mul', 'sub'],
    'all4': ['add', 'sub', 'mul', 'div'],
    'add': ['add'], 'mul': ['mul'], 'sub': ['sub'], 'div': ['div'],
    'add-mul': ['add', 'mul'], 'sub-div': ['sub', 'div'],
    'none': [],
    'random-dense': null, 'random-sparse': null,
  };
  var TABLE_SEED = 20260912;

  function ruleSet(ids) {
    return ids.map(function (id) { return RULES[id]; });
  }

  /** 順序対 (a, b) ∈ [2, M]^2 のうち、適用できる規則が 1 つ以上あるものの割合。 */
  function pairDensity(rules, M) {
    var n = 0, tot = 0;
    for (var a = 2; a <= M; a++) for (var b = 2; b <= M; b++) {
      tot++;
      for (var r = 0; r < rules.length; r++) if (rules[r].apply(a, b, M)) { n++; break; }
    }
    return tot ? n / tot : 0;
  }

  /**
   * 乱択の反応表。順序対 (a, b) ごとに確率 density で反応し、積は 2..M から b を除いて一様。
   * 表は seed で決まる（化学は 1 つ。反応器のシードとは別）。
   */
  function randomTable(M, density, seed) {
    var rng = makeRng(seed), W = M + 1, tab = new Int32Array(W * W);
    for (var a = 2; a <= M; a++) for (var b = 2; b <= M; b++) {
      if (rng() < density) {
        var p = 2 + Math.floor(rng() * (M - 2)); // 2..M−1 に写し、b を飛ばす
        if (p >= b) p++;
        tab[a * W + b] = p;
      }
    }
    return {
      id: 'table', symbol: '?', density: density, seed: seed, table: tab,
      apply: function (a, b) { return tab[a * W + b]; },
    };
  }

  /** 腕の名前から規則の並びを作る。乱択表の密度は対応する算術の腕から測る。 */
  function rulesForArm(arm, M) {
    if (arm === 'random-dense') return [randomTable(M, pairDensity(ruleSet(ARMS['add-sub']), M), TABLE_SEED)];
    if (arm === 'random-sparse') return [randomTable(M, pairDensity(ruleSet(ARMS['mul-div']), M), TABLE_SEED + 1)];
    if (!(arm in ARMS)) throw new Error('unknown arm: ' + arm);
    return ruleSet(ARMS[arm]);
  }

  /** 種の名前を置換で付け替えた同型の規則（K-36 の検査用）。perm[x] が x の新しい名前。 */
  function permutedRules(rules, perm, M) {
    var inv = new Int32Array(M + 1);
    for (var x = 2; x <= M; x++) inv[perm[x]] = x;
    return rules.map(function (r) {
      return {
        id: r.id + "'", symbol: r.symbol,
        apply: function (a, b, MM) { var p = r.apply(inv[a], inv[b], MM); return p ? perm[p] : 0; },
      };
    });
  }

  /** (a, b) に適用できる規則ごとの積（観測器が閉包を作るときに使う）。 */
  function products(rules, a, b, M, out) {
    var k = 0;
    for (var r = 0; r < rules.length; r++) {
      var p = rules[r].apply(a, b, M);
      if (p) out[k++] = p;
    }
    return k;
  }

  /* ------------------------------------------------------------------ *
   * 容器
   * ------------------------------------------------------------------ */

  var DEFAULTS = { M: 60, N: 236, scheme: 'A', seed: 1 };

  /**
   * 容器を作る。opts: { M, N, rules, scheme:'A'|'B', seed, init?: 整数の配列（長さ N） }
   */
  function createReactor(opts) {
    var o = {};
    for (var k in DEFAULTS) o[k] = DEFAULTS[k];
    for (var k2 in opts) if (opts[k2] !== undefined) o[k2] = opts[k2];
    if (!o.rules) throw new Error('rules required');
    var R = {
      M: o.M, N: o.N, rules: o.rules, scheme: o.scheme, seed: o.seed,
      rng: makeRng(o.seed),
      mol: new Int32Array(o.N), count: new Int32Array(o.M + 1),
      nSpecies: 0, step: 0, reactions: 0,
      ledger: 0,        // Σ (ln 消えた分子 − ln 積)。lnMass の帳簿
      catalystLog: 0,   // div 反応の Σ ln a（T4 の恒等式用）
      onExtinct: null,  // function (species, R)。count が 0 になったときに呼ぶ
      _cand: new Int32Array(8), _candRule: new Int32Array(8),
      last: { reacted: false, a: 0, b: 0, p: 0, rule: -1, pos: -1, i: -1, j: -1 },
    };
    for (var i = 0; i < o.N; i++) {
      R.mol[i] = o.init ? o.init[i] : 2 + Math.floor(R.rng() * (o.M - 1));
      if (R.count[R.mol[i]]++ === 0) R.nSpecies++;
    }
    return R;
  }

  /** 別の容器として複製する（乱数は新しいシードで始める）。 */
  function cloneReactor(R, seed) {
    var C = createReactor({ M: R.M, N: R.N, rules: R.rules, scheme: R.scheme, seed: seed, init: R.mol });
    C.step = R.step; C.reactions = R.reactions; C.ledger = R.ledger; C.catalystLog = R.catalystLog;
    return C;
  }

  /** 位置 pos の分子を p に置き換え、帳簿と count を更新する。 */
  function replaceAt(R, pos, p) {
    var old = R.mol[pos];
    R.mol[pos] = p;
    if (R.count[p]++ === 0) R.nSpecies++;
    R.ledger += Math.log(old) - Math.log(p);
    if (--R.count[old] === 0) {
      R.nSpecies--;
      if (R.onExtinct) R.onExtinct(old, R);
    }
  }

  /** 1 衝突。 */
  function stepReactor(R) {
    var N = R.N, rng = R.rng, M = R.M, L = R.last;
    var i = Math.floor(rng() * N), j = Math.floor(rng() * (N - 1));
    if (j >= i) j++;
    var a = R.mol[i], b = R.mol[j], rules = R.rules, k = 0;
    for (var r = 0; r < rules.length; r++) {
      var p = rules[r].apply(a, b, M);
      if (p) { R._cand[k] = p; R._candRule[k] = r; k++; }
    }
    R.step++;
    L.a = a; L.b = b; L.i = i; L.j = j;
    if (k === 0) { L.reacted = false; L.p = 0; L.rule = -1; L.pos = -1; return L; }
    var sel = k === 1 ? 0 : Math.floor(rng() * k);
    var prod = R._cand[sel];
    L.reacted = true; L.p = prod; L.rule = R._candRule[sel];
    if (rules[L.rule].id === 'div') R.catalystLog += Math.log(a);
    if (R.scheme === 'A') { L.pos = j; replaceAt(R, j, prod); }
    else { var t = Math.floor(rng() * N); L.pos = t; replaceAt(R, t, prod); }
    R.reactions++;
    return L;
  }

  function runSteps(R, n) {
    for (var s = 0; s < n; s++) stepReactor(R);
    return R;
  }

  /** count ≥ theta の種（昇順）。 */
  function presentSpecies(R, theta) {
    var th = theta || 1, out = [];
    for (var x = 2; x <= R.M; x++) if (R.count[x] >= th) out.push(x);
    return out;
  }

  /** count ≥ theta の種の所属表（長さ M+1 の Uint8Array）。 */
  function presentMask(R, theta) {
    var th = theta || 1, m = new Uint8Array(R.M + 1);
    for (var x = 2; x <= R.M; x++) if (R.count[x] >= th) m[x] = 1;
    return m;
  }

  /**
   * 種 x の分子を全部、残りの分子から一様に引いた複製で置き換える（N を保つ）。
   * rng2 は走行本体と別の乱数。残りが無ければ何もしない。返り値は置き換えた個数。
   */
  function removeSpecies(R, x, rng2) {
    var n = R.count[x];
    if (n === 0 || n === R.N) return 0;
    var rest = [];
    for (var i = 0; i < R.N; i++) if (R.mol[i] !== x) rest.push(R.mol[i]);
    for (var j = 0; j < R.N; j++) {
      if (R.mol[j] !== x) continue;
      var p = rest[Math.floor(rng2() * rest.length)];
      R.mol[j] = p;
      R.count[p]++;
      R.ledger += Math.log(x) - Math.log(p);
    }
    R.count[x] = 0;
    R.nSpecies--;
    return n;
  }

  /** 分子配列から数え直した count（観測器が古い状態を見ていないかの検算用）。 */
  function recount(R) {
    var c = new Int32Array(R.M + 1);
    for (var i = 0; i < R.N; i++) c[R.mol[i]]++;
    return c;
  }

  /** count ベクトルの FNV-1a 指紋（K-36）。 */
  function stateHash(R) {
    var h = 2166136261;
    for (var x = 2; x <= R.M; x++) {
      var v = R.count[x];
      h ^= v & 0xff; h = Math.imul(h, 16777619);
      h ^= (v >>> 8) & 0xff; h = Math.imul(h, 16777619);
      h ^= (v >>> 16) & 0xff; h = Math.imul(h, 16777619);
      h ^= (v >>> 24) & 0xff; h = Math.imul(h, 16777619);
    }
    return ('00000000' + (h >>> 0).toString(16)).slice(-8);
  }

  /** 置換を戻して数えた count の指紋（K-36 のラベル置換の検査用）。inv[y] = 元の名前。 */
  function stateHashUnpermuted(R, inv) {
    var c = new Int32Array(R.M + 1);
    for (var x = 2; x <= R.M; x++) c[inv[x]] = R.count[x];
    var h = 2166136261;
    for (var y = 2; y <= R.M; y++) {
      var v = c[y];
      h ^= v & 0xff; h = Math.imul(h, 16777619);
      h ^= (v >>> 8) & 0xff; h = Math.imul(h, 16777619);
      h ^= (v >>> 16) & 0xff; h = Math.imul(h, 16777619);
      h ^= (v >>> 24) & 0xff; h = Math.imul(h, 16777619);
    }
    return ('00000000' + (h >>> 0).toString(16)).slice(-8);
  }

  /* ------------------------------------------------------------------ *
   * 容器の数論的な読み（実装の外から来る不変量の材料）
   * ------------------------------------------------------------------ */

  /** 容器の全分子の gcd。 */
  function gcdAll(R) {
    var g = 0;
    for (var x = 2; x <= R.M; x++) if (R.count[x] > 0) g = gcd(g, x);
    return g;
  }

  /** 容器に現れる素因数の集合（昇順の配列）。 */
  function primeSupport(R) {
    var seen = new Uint8Array(R.M + 1), out = [];
    for (var x = 2; x <= R.M; x++) {
      if (R.count[x] === 0) continue;
      var pf = primeFactors(x);
      for (var i = 0; i < pf.length; i++) if (!seen[pf[i]]) { seen[pf[i]] = 1; out.push(pf[i]); }
    }
    return out.sort(function (p, q) { return p - q; });
  }

  /** Σ ln s（全分子）。 */
  function lnMass(R) {
    var s = 0;
    for (var x = 2; x <= R.M; x++) if (R.count[x]) s += R.count[x] * Math.log(x);
    return s;
  }

  /** 素数の分子の個数と、合成数の分子の個数。 */
  function primeCounts(R) {
    var p = 0, c = 0;
    for (var x = 2; x <= R.M; x++) if (R.count[x]) { if (isPrime(x)) p += R.count[x]; else c += R.count[x]; }
    return { prime: p, composite: c };
  }

  /** 容器の中に反応できる順序対が 1 つも無いか（吸収状態か）。 */
  function isFrozen(R) {
    var present = presentSpecies(R, 1), M = R.M, rules = R.rules;
    for (var i = 0; i < present.length; i++) {
      for (var j = 0; j < present.length; j++) {
        var a = present[i], b = present[j];
        if (a === b && R.count[a] < 2) continue;
        for (var r = 0; r < rules.length; r++) if (rules[r].apply(a, b, M)) return false;
      }
    }
    return true;
  }

  return {
    DEFAULTS: DEFAULTS, RULES: RULES, ARMS: ARMS, TABLE_SEED: TABLE_SEED,
    makeRng: makeRng, gcd: gcd, isPrime: isPrime, omega: omega, primeFactors: primeFactors,
    ruleSet: ruleSet, pairDensity: pairDensity, randomTable: randomTable, rulesForArm: rulesForArm,
    permutedRules: permutedRules, products: products,
    createReactor: createReactor, cloneReactor: cloneReactor, stepReactor: stepReactor, runSteps: runSteps,
    presentSpecies: presentSpecies, presentMask: presentMask, removeSpecies: removeSpecies,
    recount: recount, stateHash: stateHash, stateHashUnpermuted: stateHashUnpermuted,
    gcdAll: gcdAll, primeSupport: primeSupport, lnMass: lnMass, primeCounts: primeCounts, isFrozen: isFrozen,
  };
});
