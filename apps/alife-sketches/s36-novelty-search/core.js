/**
 * S-36 の核。
 *
 * ここが知っているのは **格子・経路・重みベクトル・選び方** の4つだけである。
 * 目的・新奇さ・適応・生死・到達といった上位概念の語は1つも持たない
 * （`selftest.js` が注釈を落として機械検査する）。
 *
 * - **格子** … `blocked` が 1 の枡は通れない。周囲は必ず塞がっている
 * - **経路** … 重みベクトルが枡と向きから決める、歩みの列
 * - **重みベクトル** … 16 の局所符号 × 6 の選択肢 = 96 個の実数。各符号で最大の成分が選ばれる
 * - **選び方** … 次の代の親の添字を返す関数。**外から渡される**。核はその中身を知らない
 *
 * Node（`module.exports`）とブラウザ（`window.S36`）で共用する古典スクリプト。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.S36 = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function () {
  'use strict';

  /* 向き 0=上 1=右 2=下 3=左 */
  var DX = [0, 1, 0, -1];
  var DY = [-1, 0, 1, 0];

  var CODE_COUNT = 16;    /* (前・左・右が塞がっているか) 8 通り × 記憶 1 ビット */
  var PICK_COUNT = 6;     /* (進む・左へ回る・右へ回る) 3 通り × 記憶の次の値 2 通り */
  var VECTOR_SIZE = CODE_COUNT * PICK_COUNT;  /* = 96 */

  /* ------------------------------------------------------------------ 乱数 */

  /** 種を固定した 32 ビット乱数（mulberry32）。同じ種なら完全に同じ列を返す。 */
  function makeRng(seed) {
    var s = (seed >>> 0);
    function u32() {
      s = (s + 0x6D2B79F5) >>> 0;
      var t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0);
    }
    function unit() { return u32() / 4294967296; }
    var spare = null;
    return {
      u32: u32,
      unit: unit,
      below: function (n) { return u32() % n; },
      /** Box–Muller。予備を1つ持つので、消費する乱数の数は 2 個につき 2 回。 */
      normal: function () {
        if (spare !== null) { var v = spare; spare = null; return v; }
        var u = 1 - unit(), w = unit();
        var r = Math.sqrt(-2 * Math.log(u));
        spare = r * Math.sin(2 * Math.PI * w);
        return r * Math.cos(2 * Math.PI * w);
      },
      peek: function () { return s >>> 0; }
    };
  }

  /* ------------------------------------------------------------------ 格子 */

  /** ASCII の行から格子を作る。`#` が塞がった枡。`#` と `.` 以外の字は印として位置だけ覚える。 */
  function latticeFromRows(rows) {
    var h = rows.length, w = rows[0].length, i, x, y, ch;
    var blocked = new Uint8Array(w * h);
    var marks = {};
    for (y = 0; y < h; y++) {
      if (rows[y].length !== w) throw new Error('行の長さが揃っていない: ' + y);
      for (x = 0; x < w; x++) {
        ch = rows[y].charAt(x);
        i = y * w + x;
        blocked[i] = (ch === '#') ? 1 : 0;
        if (ch !== '#' && ch !== '.') marks[ch] = i;
      }
    }
    return { w: w, h: h, blocked: blocked, marks: marks };
  }

  function latticeToRows(lat) {
    var rows = [], x, y, line;
    for (y = 0; y < lat.h; y++) {
      line = '';
      for (x = 0; x < lat.w; x++) line += lat.blocked[y * lat.w + x] ? '#' : '.';
      rows.push(line);
    }
    return rows;
  }

  /** 深さ優先の掘り進みで、輪を1つも持たない格子を作る（一辺 = cells*2+1）。 */
  function carveLattice(cells, rng) {
    var w = cells * 2 + 1, h = w;
    var blocked = new Uint8Array(w * h);
    blocked.fill(1);
    var seen = new Uint8Array(cells * cells);
    var stack = [0], cand = new Int32Array(4);
    seen[0] = 1;
    blocked[1 * w + 1] = 0;
    while (stack.length) {
      var cur = stack[stack.length - 1];
      var cx = cur % cells, cy = (cur / cells) | 0, n = 0, d, nx, ny;
      for (d = 0; d < 4; d++) {
        nx = cx + DX[d]; ny = cy + DY[d];
        if (nx < 0 || ny < 0 || nx >= cells || ny >= cells) continue;
        if (seen[ny * cells + nx]) continue;
        cand[n++] = d;
      }
      if (!n) { stack.pop(); continue; }
      d = cand[rng.below(n)];
      nx = cx + DX[d]; ny = cy + DY[d];
      seen[ny * cells + nx] = 1;
      blocked[(ny * 2 + 1) * w + (nx * 2 + 1)] = 0;
      blocked[(cy * 2 + 1 + DY[d]) * w + (cx * 2 + 1 + DX[d])] = 0;
      stack.push(ny * cells + nx);
    }
    return { w: w, h: h, blocked: blocked, marks: {} };
  }

  /** 周囲1枡だけ塞いだ、中身が空の格子。 */
  function hollowLattice(w, h) {
    var blocked = new Uint8Array(w * h), x, y;
    for (x = 0; x < w; x++) { blocked[x] = 1; blocked[(h - 1) * w + x] = 1; }
    for (y = 0; y < h; y++) { blocked[y * w] = 1; blocked[y * w + w - 1] = 1; }
    return { w: w, h: h, blocked: blocked, marks: {} };
  }

  /** 幅1の一本道（長さ len）。 */
  function corridorLattice(len) {
    var w = len + 2, h = 3;
    var blocked = new Uint8Array(w * h);
    blocked.fill(1);
    for (var x = 1; x <= len; x++) blocked[1 * w + x] = 0;
    return { w: w, h: h, blocked: blocked, marks: {} };
  }

  /** 幅1の階段（右へ1・下へ1 を n 回）。直線距離は道に沿って単調に減る。 */
  function stairLattice(n) {
    var side = 2 * n + 3, i;
    var blocked = new Uint8Array(side * side);
    blocked.fill(1);
    var x = 1, y = 1;
    blocked[y * side + x] = 0;
    for (i = 0; i < n; i++) {
      x += 1; blocked[y * side + x] = 0;
      y += 1; blocked[y * side + x] = 0;
    }
    return { w: side, h: side, blocked: blocked, marks: {} };
  }

  /** ある枡から四近傍で何歩かかるか。届かない枡は -1。 */
  function stepCounts(lat, from) {
    var n = lat.w * lat.h, out = new Int32Array(n), i;
    for (i = 0; i < n; i++) out[i] = -1;
    if (lat.blocked[from]) return out;
    var queue = new Int32Array(n), head = 0, tail = 0;
    out[from] = 0; queue[tail++] = from;
    while (head < tail) {
      var p = queue[head++], d;
      for (d = 0; d < 4; d++) {
        var q = p + DY[d] * lat.w + DX[d];
        if (q < 0 || q >= n) continue;
        if (lat.blocked[q] || out[q] >= 0) continue;
        out[q] = out[p] + 1;
        queue[tail++] = q;
      }
    }
    return out;
  }

  function openCells(lat) {
    var out = [], i;
    for (i = 0; i < lat.w * lat.h; i++) if (!lat.blocked[i]) out.push(i);
    return out;
  }

  /* -------------------------------------------------------- 重みベクトル */

  function makeVector(rng) {
    var v = new Float64Array(VECTOR_SIZE), i;
    for (i = 0; i < VECTOR_SIZE; i++) v[i] = rng.normal();
    return v;
  }

  /** 元のベクトルは書き換えず、新しいベクトルを返す。 */
  function perturb(vector, rng, rate, scale) {
    var out = new Float64Array(vector.length), i;
    for (i = 0; i < vector.length; i++) {
      out[i] = vector[i] + (rng.unit() < rate ? rng.normal() * scale : 0);
    }
    return out;
  }

  /** 重みベクトルが表す、16 符号ごとの選択肢の番号（＝表の中身）。 */
  function picksOf(vector) {
    var out = new Uint8Array(CODE_COUNT), c, j, base, best, bv, v;
    for (c = 0; c < CODE_COUNT; c++) {
      base = c * PICK_COUNT; best = 0; bv = vector[base];
      for (j = 1; j < PICK_COUNT; j++) { v = vector[base + j]; if (v > bv) { bv = v; best = j; } }
      out[c] = best;
    }
    return out;
  }

  /* ------------------------------------------------------------------ 経路 */

  /**
   * 重みベクトルの表に従って `steps` 歩だけ進み、経路を返す。
   * 決定的。同じ (格子, ベクトル, 起点, 向き) なら常に同じ経路。
   */
  function traceLattice(opt) {
    var lat = opt.lattice, vec = opt.vector, steps = opt.steps | 0;
    var w = lat.w, blocked = lat.blocked;
    var pos = opt.origin | 0, head = (opt.heading | 0) & 3, reg = 0;
    var visits = new Int32Array(steps + 1);
    var picks = new Uint8Array(steps);
    var t, ahead, lh, rh, code, base, best, bv, j, v, move, fwd;
    visits[0] = pos;
    for (t = 0; t < steps; t++) {
      fwd = pos + DY[head] * w + DX[head];
      ahead = blocked[fwd];
      lh = (head + 3) & 3; rh = (head + 1) & 3;
      code = ((ahead << 2)
        | (blocked[pos + DY[lh] * w + DX[lh]] << 1)
        | blocked[pos + DY[rh] * w + DX[rh]]) * 2 + reg;
      base = code * PICK_COUNT; best = 0; bv = vec[base];
      for (j = 1; j < PICK_COUNT; j++) { v = vec[base + j]; if (v > bv) { bv = v; best = j; } }
      picks[t] = best;
      move = best % 3; reg = (best / 3) | 0;
      if (move === 0) { if (!ahead) pos = fwd; }
      else if (move === 1) head = lh;
      else head = rh;
      visits[t + 1] = pos;
    }
    return { visits: visits, picks: picks, last: pos, heading: head, register: reg };
  }

  /* ------------------------------------------------------------------ 世代 */

  /**
   * 次の代を作る。**選び方 `chooser` は外から渡される**——
   * 核は `chooser(count, rng)` が親の添字を返すことしか知らない。
   */
  function advance(opt) {
    var vectors = opt.vectors, rng = opt.rng;
    var parents = opt.chooser(vectors.length, rng);
    var next = new Array(vectors.length), i;
    for (i = 0; i < vectors.length; i++) {
      next[i] = perturb(vectors[parents[i]], rng, opt.rate, opt.scale);
    }
    return { vectors: next, parents: parents };
  }

  /* ------------------------------------------------------------ 状態の要約 */

  /** FNV-1a を 32 ビットで回した要約。数の列から 8 桁の 16 進を返す。 */
  function digest(feed) {
    var hv = 0x811c9dc5 >>> 0;
    function mix(x) {
      hv = (hv ^ (x & 255)) >>> 0; hv = Math.imul(hv, 16777619) >>> 0;
      hv = (hv ^ ((x >>> 8) & 255)) >>> 0; hv = Math.imul(hv, 16777619) >>> 0;
      hv = (hv ^ ((x >>> 16) & 255)) >>> 0; hv = Math.imul(hv, 16777619) >>> 0;
      hv = (hv ^ ((x >>> 24) & 255)) >>> 0; hv = Math.imul(hv, 16777619) >>> 0;
    }
    feed(mix);
    return ('00000000' + hv.toString(16)).slice(-8);
  }

  /** 重みベクトルの集まりを要約する（小数第6位までを整数化して混ぜる）。 */
  function digestVectors(vectors) {
    return digest(function (mix) {
      for (var i = 0; i < vectors.length; i++) {
        var v = vectors[i];
        for (var j = 0; j < v.length; j++) mix(Math.round(v[j] * 1e6) | 0);
      }
    });
  }

  return {
    DX: DX, DY: DY,
    CODE_COUNT: CODE_COUNT, PICK_COUNT: PICK_COUNT, VECTOR_SIZE: VECTOR_SIZE,
    makeRng: makeRng,
    latticeFromRows: latticeFromRows, latticeToRows: latticeToRows,
    carveLattice: carveLattice, hollowLattice: hollowLattice, corridorLattice: corridorLattice,
    stairLattice: stairLattice,
    stepCounts: stepCounts, openCells: openCells,
    makeVector: makeVector, perturb: perturb, picksOf: picksOf,
    traceLattice: traceLattice, advance: advance,
    digest: digest, digestVectors: digestVectors
  };
});
