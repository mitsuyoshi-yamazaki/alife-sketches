/**
 * S-24 の核。二つの系の規則だけを書く。
 *
 * ---- 系 A: 外部総和型の二状態格子（α-非同期） ----
 *
 *   L×L のトーラス。各セルは 0 か 1。近傍は Moore の 8 セルで、その 1 の数を s とする。
 *   局所規則 f(v, s) は二つの集合で決まる:
 *
 *       v = 0 のとき  f = 1  iff  s ∈ turnOn
 *       v = 1 のとき  f = 1  iff  s ∈ stayOn
 *
 *   既定は turnOn = {3}, stayOn = {2,3}（Conway の B3/S23）。
 *   1 ステップでは、各セルが独立に確率 alpha で選ばれ、選ばれたセルは**前の配置**から
 *   計算した f(v, s) を取る。選ばれなかったセルは据え置き。alpha = 1 が同期更新。
 *
 *   mix = true のときは各ステップの先頭で配置を無作為に並べ替える（空間の相関だけを忘れる）。
 *
 * ---- 系 B: 1 次元の接触過程（連続時間） ----
 *
 *   環状の N サイト。各サイトは活性 (1) か非活性 (0)。活性サイトは率 1 で非活性になり、
 *   率 lambda で左右どちらかの隣（各 1/2）を活性にする（隣が既に活性なら何も起きない）。
 *   実装は活性サイトの一覧から 1 つ選び、確率 1/(1+lambda) で消し、さもなくば隣を選んで
 *   活性化する。時間は事象 1 回ごとに 1/(N_a·(1+lambda)) 進む（N_a は活性サイト数）。
 *
 * **このファイルには『生きている』『死ぬ』『誕生』『相』『転移』『臨界』の語は無い。**
 * それらを語るのは stats.js（観測器）の仕事である。
 *
 * 依存ゼロ。Node（生ログ生成）とブラウザ（可視化）が同じファイルを読む。
 *
 * 出典（アイデアのみ。コードは参照していない）:
 *   Fatès, N. (2010) "Does Life resist asynchrony?" in Adamatzky (ed.) Game of Life Cellular
 *   Automata, Springer, 257-274.（α-非同期更新の定義 §3）
 *   Hinrichsen, H. (2000) Adv. Phys. 49, 815. 式 (85)（接触過程の率）
 *   乱数は mulberry32（S-17 の core.js と同じ算法）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S24 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 乱数・ハッシュ
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

  /** 配列の中身の FNV-1a 指紋（状態ハッシュ。K-36）。 */
  function fingerprint(arr) {
    var h = 2166136261;
    for (var i = 0; i < arr.length; i++) {
      h ^= arr[i]; h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  /* ------------------------------------------------------------------ *
   * 系 A: 格子
   * ------------------------------------------------------------------ */

  /** 近傍数の集合 → 9 ビットのマスク。 */
  function maskOf(list) {
    var m = 0;
    for (var i = 0; i < list.length; i++) m |= (1 << list[i]);
    return m;
  }

  var RULES = {
    life: { turnOn: [3], stayOn: [2, 3] },
    flip: { turnOn: [0, 1, 2, 3, 4, 5, 6, 7, 8], stayOn: [] },
    fill: { turnOn: [1, 2, 3, 4, 5, 6, 7, 8], stayOn: [0, 1, 2, 3, 4, 5, 6, 7, 8] },
  };

  var GRID_DEFAULTS = {
    L: 64,
    alpha: 1,
    density: 0.5,
    rule: 'life',   // RULES のキー、または {turnOn:[...], stayOn:[...]}
    mix: false,     // 真なら各ステップの先頭で配置を無作為に並べ替える
    seed: 1,
  };

  function createGrid(opts) {
    var o = {};
    for (var k in GRID_DEFAULTS) o[k] = GRID_DEFAULTS[k];
    if (opts) for (var k2 in opts) if (opts[k2] !== undefined) o[k2] = opts[k2];
    var rule = typeof o.rule === 'string' ? RULES[o.rule] : o.rule;
    if (!rule) throw new Error('unknown rule: ' + o.rule);
    var G = {
      L: o.L, n: o.L * o.L, alpha: o.alpha, mix: !!o.mix, seed: o.seed,
      ruleName: typeof o.rule === 'string' ? o.rule : 'custom',
      onMask: maskOf(rule.turnOn), keepMask: maskOf(rule.stayOn),
      rng: makeRng(o.seed), t: 0,
      x: new Uint8Array(o.L * o.L), y: new Uint8Array(o.L * o.L),
    };
    for (var i = 0; i < G.n; i++) G.x[i] = G.rng() < o.density ? 1 : 0;
    return G;
  }

  /** 局所規則。v ∈ {0,1}、s ∈ 0..8。 */
  function localRule(G, v, s) {
    return v ? ((G.keepMask >> s) & 1) : ((G.onMask >> s) & 1);
  }

  /** 配置を無作為に並べ替える（Fisher–Yates）。 */
  function shuffleGrid(G) {
    var x = G.x, rng = G.rng;
    for (var j = G.n - 1; j > 0; j--) {
      var r = (rng() * (j + 1)) | 0, t = x[j]; x[j] = x[r]; x[r] = t;
    }
  }

  /**
   * 1 ステップ。返り値は { unstable: 前の配置で f≠v だったセル数, changed: 実際に変えたセル数 }。
   * 選抜の乱数は f≠v のセルでだけ引く（f=v のセルは選ばれても変わらないので分布は同じ）。
   */
  function stepGrid(G) {
    if (G.mix) shuffleGrid(G);
    var L = G.L, x = G.x, y = G.y, rng = G.rng, alpha = G.alpha;
    var onMask = G.onMask, keepMask = G.keepMask;
    var unstable = 0, changed = 0;
    for (var r = 0; r < L; r++) {
      var up = ((r + L - 1) % L) * L, dn = ((r + 1) % L) * L, row = r * L;
      for (var c = 0; c < L; c++) {
        var lf = (c + L - 1) % L, rt = (c + 1) % L;
        var s = x[up + lf] + x[up + c] + x[up + rt] + x[row + lf] + x[row + rt] +
                x[dn + lf] + x[dn + c] + x[dn + rt];
        var v = x[row + c];
        var f = v ? ((keepMask >> s) & 1) : ((onMask >> s) & 1);
        if (f !== v) {
          unstable++;
          if (alpha >= 1 || rng() < alpha) { y[row + c] = f; changed++; } else y[row + c] = v;
        } else y[row + c] = v;
      }
    }
    G.x = y; G.y = x;
    G.t++;
    return { unstable: unstable, changed: changed };
  }

  /** 近傍の 1 の数を全セルぶん（素朴版。検算用）。 */
  function neighbourCounts(G) {
    var L = G.L, x = G.x, out = new Uint8Array(G.n);
    for (var r = 0; r < L; r++) {
      for (var c = 0; c < L; c++) {
        var s = 0;
        for (var dr = -1; dr <= 1; dr++) {
          for (var dc = -1; dc <= 1; dc++) {
            if (dr === 0 && dc === 0) continue;
            s += x[((r + dr + L) % L) * L + ((c + dc + L) % L)];
          }
        }
        out[r * L + c] = s;
      }
    }
    return out;
  }

  /** 配置だけから数える『選ばれたら変わるセル』の割合。選抜列によらない。 */
  function unstableFraction(G) {
    var s = neighbourCounts(G), x = G.x, n = 0;
    for (var i = 0; i < G.n; i++) if (localRule(G, x[i], s[i]) !== x[i]) n++;
    return n / G.n;
  }

  /** 1 のセルの割合。 */
  function onesFraction(G) {
    var n = 0, x = G.x;
    for (var i = 0; i < G.n; i++) n += x[i];
    return n / G.n;
  }

  function hashGrid(G) { return fingerprint(G.x); }

  /** 全セルを 0 にする。 */
  function clearGrid(G) { G.x.fill(0); }

  /** 座標の並び [[r,c],...] を 1 にする（既知の配置を置く用）。 */
  function placeCells(G, cells, r0, c0) {
    var L = G.L;
    for (var i = 0; i < cells.length; i++) {
      G.x[((cells[i][0] + r0 + L) % L) * L + ((cells[i][1] + c0 + L) % L)] = 1;
    }
  }

  var OBJECTS = {
    block: [[0, 0], [0, 1], [1, 0], [1, 1]],
    blinker: [[0, 0], [0, 1], [0, 2]],
    glider: [[0, 1], [1, 2], [2, 0], [2, 1], [2, 2]],
  };

  /* ------------------------------------------------------------------ *
   * 系 B: 1 次元の接触過程
   * ------------------------------------------------------------------ */

  var CHAIN_DEFAULTS = { N: 1024, lambda: 3.3, density: 1, seed: 1 };

  function createChain(opts) {
    var o = {};
    for (var k in CHAIN_DEFAULTS) o[k] = CHAIN_DEFAULTS[k];
    if (opts) for (var k2 in opts) if (opts[k2] !== undefined) o[k2] = opts[k2];
    var C = {
      N: o.N, lambda: o.lambda, seed: o.seed, rng: makeRng(o.seed), t: 0, events: 0,
      s: new Uint8Array(o.N), act: new Int32Array(o.N), pos: new Int32Array(o.N), na: 0,
    };
    for (var i = 0; i < o.N; i++) {
      if (C.rng() < o.density) { C.s[i] = 1; C.act[C.na] = i; C.pos[i] = C.na; C.na++; }
      else C.pos[i] = -1;
    }
    return C;
  }

  /** 事象 1 回。時間を 1/(N_a(1+λ)) 進める。N_a = 0 なら何もしない。 */
  function eventChain(C) {
    var na = C.na;
    if (na === 0) return false;
    var rng = C.rng, lam = C.lambda, N = C.N;
    C.t += 1 / (na * (1 + lam));
    C.events++;
    var k = (rng() * na) | 0, i = C.act[k];
    if (rng() < 1 / (1 + lam)) {
      C.s[i] = 0; C.na--;
      var last = C.act[C.na]; C.act[k] = last; C.pos[last] = k; C.pos[i] = -1;
    } else {
      var j = rng() < 0.5 ? (i + 1) % N : (i + N - 1) % N;
      if (!C.s[j]) { C.s[j] = 1; C.act[C.na] = j; C.pos[j] = C.na; C.na++; }
    }
    return true;
  }

  /** 時刻 tTarget に達するまで事象を回す。 */
  function advanceChain(C, tTarget) {
    while (C.t < tTarget && C.na > 0) eventChain(C);
    return C;
  }

  function activeFraction(C) { return C.na / C.N; }

  /** 活性一覧（近道）を配置の総当たりと突き合わせる（検算用）。 */
  function chainBookkeepingOk(C) {
    var n = 0;
    for (var i = 0; i < C.N; i++) {
      if (C.s[i]) { n++; if (C.pos[i] < 0 || C.act[C.pos[i]] !== i) return false; }
      else if (C.pos[i] !== -1) return false;
    }
    return n === C.na;
  }

  function hashChain(C) { return fingerprint(C.s); }

  return {
    GRID_DEFAULTS: GRID_DEFAULTS, CHAIN_DEFAULTS: CHAIN_DEFAULTS, RULES: RULES, OBJECTS: OBJECTS,
    makeRng: makeRng, fingerprint: fingerprint, maskOf: maskOf,
    createGrid: createGrid, stepGrid: stepGrid, localRule: localRule, shuffleGrid: shuffleGrid,
    neighbourCounts: neighbourCounts, unstableFraction: unstableFraction, onesFraction: onesFraction,
    hashGrid: hashGrid, clearGrid: clearGrid, placeCells: placeCells,
    createChain: createChain, eventChain: eventChain, advanceChain: advanceChain,
    activeFraction: activeFraction, chainBookkeepingOk: chainBookkeepingOk, hashChain: hashChain,
  };
});
