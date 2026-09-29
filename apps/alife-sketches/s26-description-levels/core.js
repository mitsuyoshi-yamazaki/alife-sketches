/**
 * S-26 の核。**層0の局所規則と場だけ**を書く。
 *
 * このファイルが知っているのは次だけである:
 *
 *   L×L のトーラス。各マスは 0 か 1。
 *   前の配置の Moore 8 近傍の 1 の数を s として、
 *       v = 0 のとき  次は 1  iff  s ∈ turnOn
 *       v = 1 のとき  次は 1  iff  s ∈ stayOn
 *   既定は turnOn = {3}, stayOn = {2,3}。
 *
 *   別の規則も2つ持つ（対照のため）:
 *       drift  … new[x][y] = old[x−1][y−1]。場全体が (1,1) だけ動く
 *       refill … 毎ステップ、各マスを独立に確率 density で 1 にする（前の配置を見ない）
 *
 * そして「置く形」の座標表を持つ。これは**マスの並びであって、それ以上の何かではない**。
 * 表の値が正しいか（周期がいくつか）は、このファイルではなく selftest.js が
 * Life の規則そのものから機械で確かめる。
 *
 * **このファイルには『層』『対象』『個体』『持続』『自己維持』『生きている』『死ぬ』の語が無い。**
 * 層0・層1・層2という区分も、対象を作る粗視化も、すべて levels.js（観測器）の側にある。
 * ここにあるのはマス・近傍・数・規則だけである。
 *
 * 依存ゼロ。Node（生ログ生成）とブラウザ（可視化）が同じファイルを読む。
 *
 * 出典（アイデアのみ。コードは参照していない）:
 *   Conway の二状態外部総和型規則（Gardner, M. (1970) Scientific American 223(4), 120-123 で
 *   紹介されたもの）。座標表の形は広く知られた配置だが、**本ファイルの座標は自分で書き、
 *   周期と変位を規則から機械で確かめている**（selftest.js の PC1）。
 *   乱数は mulberry32（S-17 の core.js と同じ算法）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S26 = api;
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

  /** 配置そのものから作る指紋（K-36 の状態ハッシュ）。FNV-1a。 */
  function hashCells(cells) {
    var h = 2166136261;
    for (var i = 0; i < cells.length; i++) {
      h ^= cells[i]; h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  /* ------------------------------------------------------------------ *
   * 置く形の座標表（[x, y] の並び。原点は左上）
   * ------------------------------------------------------------------ */

  var SHAPES = {
    block:   [[0,0],[1,0],[0,1],[1,1]],
    beehive: [[1,0],[2,0],[0,1],[3,1],[1,2],[2,2]],
    loaf:    [[1,0],[2,0],[0,1],[3,1],[1,2],[3,2],[2,3]],
    boat:    [[0,0],[1,0],[0,1],[2,1],[1,2]],
    tub:     [[1,0],[0,1],[2,1],[1,2]],
    ship:    [[0,0],[1,0],[0,1],[2,1],[1,2],[2,2]],
    blinker: [[0,0],[1,0],[2,0]],
    toad:    [[1,0],[2,0],[3,0],[0,1],[1,1],[2,1]],
    glider:  [[1,0],[2,1],[0,2],[1,2],[2,2]],
    eater:   [[0,0],[1,0],[0,1],[2,1],[2,2],[2,3],[3,3]],
    // 36 マス・9 行。周期と生成物の変位は selftest.js が規則から確かめる。
    gosper: [
      [24,0],
      [22,1],[24,1],
      [12,2],[13,2],[20,2],[21,2],[34,2],[35,2],
      [11,3],[15,3],[20,3],[21,3],[34,3],[35,3],
      [0,4],[1,4],[10,4],[16,4],[20,4],[21,4],
      [0,5],[1,5],[10,5],[14,5],[16,5],[17,5],[22,5],[24,5],
      [10,6],[16,6],[24,6],
      [11,7],[15,7],
      [12,8],[13,8]
    ]
  };

  /* ------------------------------------------------------------------ *
   * 場
   * ------------------------------------------------------------------ */

  var DEFAULTS = {
    L: 96,
    turnOn: [3],
    stayOn: [2, 3],
    mode: 'local',   // 'local' | 'drift' | 'refill'
    driftX: 1,
    driftY: 1,
    density: 0.03,   // mode='refill' のとき各マスが 1 になる確率
    seed: 1,
  };

  function createField(opts) {
    var o = {};
    for (var k in DEFAULTS) o[k] = DEFAULTS[k];
    if (opts) for (var k2 in opts) if (opts[k2] !== undefined) o[k2] = opts[k2];
    var L = o.L;
    o.cells = new Uint8Array(L * L);
    o.next = new Uint8Array(L * L);
    o.t = 0;
    o.rng = makeRng(o.seed);
    // 規則を索引表にする（s は 0..8）
    o.onTable = new Uint8Array(9);
    o.stayTable = new Uint8Array(9);
    o.turnOn.forEach(function (s) { if (s >= 0 && s <= 8) o.onTable[s] = 1; });
    o.stayOn.forEach(function (s) { if (s >= 0 && s <= 8) o.stayTable[s] = 1; });
    // トーラスの巻き込み表（剰余演算を内側のループから追い出す）
    o.dec = new Int32Array(L);
    o.inc = new Int32Array(L);
    for (var i = 0; i < L; i++) { o.dec[i] = (i + L - 1) % L; o.inc[i] = (i + 1) % L; }
    o.changed = 0;   // 直前の1ステップで値が変わったマスの数（記述子として観測器が読む）
    return o;
  }

  /** 座標表を (ox, oy) へ置く（トーラスで巻き込む）。 */
  function place(F, shape, ox, oy) {
    var L = F.L;
    for (var i = 0; i < shape.length; i++) {
      var x = (((ox + shape[i][0]) % L) + L) % L;
      var y = (((oy + shape[i][1]) % L) + L) % L;
      F.cells[y * L + x] = 1;
    }
    return F;
  }

  /** 一様乱数で場を埋める（密度 d）。 */
  function fillRandom(F, d, rng) {
    var r = rng || F.rng;
    for (var i = 0; i < F.cells.length; i++) F.cells[i] = r() < d ? 1 : 0;
    return F;
  }

  /** 1ステップ。mode によって規則が変わる。 */
  function stepField(F) {
    var L = F.L, cur = F.cells, nxt = F.next;
    var changed = 0, i;
    if (F.mode === 'refill') {
      var d = F.density, rng = F.rng;
      for (i = 0; i < cur.length; i++) {
        var v0 = rng() < d ? 1 : 0;
        if (v0 !== cur[i]) changed++;
        nxt[i] = v0;
      }
    } else if (F.mode === 'drift') {
      var dx = F.driftX, dy = F.driftY;
      for (var y2 = 0; y2 < L; y2++) {
        var sy = (((y2 - dy) % L) + L) % L;
        for (var x2 = 0; x2 < L; x2++) {
          var sx = (((x2 - dx) % L) + L) % L;
          var v1 = cur[sy * L + sx];
          if (v1 !== cur[y2 * L + x2]) changed++;
          nxt[y2 * L + x2] = v1;
        }
      }
    } else {
      var dec = F.dec, inc = F.inc, on = F.onTable, stay = F.stayTable;
      for (var y = 0; y < L; y++) {
        var yu = dec[y] * L, yd = inc[y] * L, yc = y * L;
        for (var x = 0; x < L; x++) {
          var xl = dec[x], xr = inc[x];
          var s = cur[yu + xl] + cur[yu + x] + cur[yu + xr]
                + cur[yc + xl] +                cur[yc + xr]
                + cur[yd + xl] + cur[yd + x] + cur[yd + xr];
          var v = cur[yc + x];
          var w = v ? stay[s] : on[s];
          if (w !== v) changed++;
          nxt[yc + x] = w;
        }
      }
    }
    F.cells = nxt; F.next = cur;
    F.t++;
    F.changed = changed;
    return F;
  }

  /** 素朴な1ステップ（近道の検算用。剰余演算を毎回行う）。 */
  function stepFieldNaive(F) {
    var L = F.L, cur = F.cells, out = new Uint8Array(L * L);
    for (var y = 0; y < L; y++) {
      for (var x = 0; x < L; x++) {
        var s = 0;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            var xx = (((x + dx) % L) + L) % L, yy = (((y + dy) % L) + L) % L;
            s += cur[yy * L + xx];
          }
        }
        var v = cur[y * L + x];
        out[y * L + x] = v ? (F.stayOn.indexOf(s) >= 0 ? 1 : 0) : (F.turnOn.indexOf(s) >= 0 ? 1 : 0);
      }
    }
    return out;
  }

  function countOnes(cells) {
    var n = 0;
    for (var i = 0; i < cells.length; i++) n += cells[i];
    return n;
  }

  /** 場全体を (dx, dy) だけ平行移動した配置を返す（元は変えない）。 */
  function translated(cells, L, dx, dy) {
    var out = new Uint8Array(L * L);
    for (var y = 0; y < L; y++) {
      var ty = (((y + dy) % L) + L) % L;
      for (var x = 0; x < L; x++) {
        var tx = (((x + dx) % L) + L) % L;
        out[ty * L + tx] = cells[y * L + x];
      }
    }
    return out;
  }

  return {
    DEFAULTS: DEFAULTS, SHAPES: SHAPES,
    makeRng: makeRng, hashCells: hashCells,
    createField: createField, place: place, fillRandom: fillRandom,
    stepField: stepField, stepFieldNaive: stepFieldNaive,
    countOnes: countOnes, translated: translated,
  };
});
