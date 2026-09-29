/**
 * S-15 の核: 2種類の端点を持つ剛体3粒子鎖の Monte Carlo
 *
 * 系にあるのは次の4つだけである:
 *
 *   ① 粒子    2 種類（種A・種B）。種ごとに排除半径を持つ
 *   ② 鎖      3 個の粒子が一直線に固定された剛体。並びは [A, B, B]
 *   ③ 向き    鎖の角度 theta。粒子の位置はこれと重心から決まる
 *   ④ 接触    距離 rc 未満の粒子対。1 件あたり eps[k1][k2] のエネルギーを持つ
 *
 * 規則は Metropolis の受容だけである。鎖を1つ選び、平行移動か回転を提案し、
 * exp(-dE) で受け入れる（エネルギーは kT を単位に取ってあるので温度は eps に吸収される）。
 * 排除半径より近づく提案は必ず捨てる。
 *
 * **既定では非零の相互作用は eps[B][B] ただ1つ**である。種A は「他を引かないかさ」として
 * しか働かない。制御変数はこの eps[B][B] の強さと、種A の排除半径である。
 *
 * 語彙について: この核には「膜」「ミセル」「小胞」「二重層」「親水」「疎水」という語も
 * 概念も無い。あるのは粒子・向き・接触・エネルギーだけで、集合体の呼び名は
 * 観測器（stats.js）の側にしかない。核は自分が何を作っているかを知らない。
 *
 * 依存ゼロ。Node（生ログ生成）とブラウザ（可視化）が同じファイルを読む。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S15 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TAU = Math.PI * 2;

  /** 決定論的な 32bit 乱数。同じシードで完全に再現する。 */
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var DEFAULTS = {
    size: 50,          // 正方トーラスの一辺
    density: 0.10,     // 単位面積あたりの鎖の数
    bond: 1.0,         // 鎖の中の粒子間隔（固定）
    kinds: [0, 1, 1],  // 鎖の並び。index 0 が種A
    radius: [0.45, 0.45], // 種ごとの排除半径
    rc: 1.6,           // 接触の距離（相互作用の切断半径）
    eps: [[0, 0], [0, -1.0]], // eps[k1][k2]。接触1件あたりのエネルギー（kT 単位）
    stepTrans: 0.30,   // 平行移動の提案幅
    stepRot: 0.50,     // 回転の提案幅（ラジアン）
  };

  /** トーラス上の最短差分。 */
  function wrap(d, size) {
    if (d > size * 0.5) return d - size;
    if (d < -size * 0.5) return d + size;
    return d;
  }

  function mod(v, m) { var r = v % m; return r < 0 ? r + m : r; }

  /**
   * 制御変数から相互作用行列を作る。
   *
   * @param {number} w      種B どうしの接触 1 件あたりの利得（正の数。eps[B][B] = -w）
   * @param {string} couple どの組が引き合うか
   *   'B'    種B どうしだけ（既定。非零は1つ）
   *   'none' どの組も引き合わない（駆動を切る）
   *   'all'  すべての組が等しく引き合う（種の区別を相互作用から消す）
   */
  function makeEps(w, couple) {
    if (couple === 'none') return [[0, 0], [0, 0]];
    if (couple === 'all') return [[-w, -w], [-w, -w]];
    return [[0, 0], [0, -w]];
  }

  // ------------------------------------------------------------------ 索引
  //
  // 粒子を一様格子に登録する。鎖が動くたびに差分で更新する（総当たりと一致することを
  // selftest が確かめる）。セル辺は rc 以上に取るので探索は 3x3 セルで足りる。

  function makeGrid(sys) {
    var p = sys.params;
    var minCell = Math.max(p.rc, p.radius[0] + p.radius[0], p.radius[0] + p.radius[1], p.radius[1] + p.radius[1]);
    var cells = Math.max(1, Math.floor(p.size / minCell));
    var bucket = new Array(cells * cells);
    for (var c = 0; c < cells * cells; c++) bucket[c] = [];
    return {
      cells: cells,
      cellSize: p.size / cells,
      bucket: bucket,
      beadCell: new Int32Array(sys.beadCount).fill(-1),
      beadSlot: new Int32Array(sys.beadCount).fill(-1),
    };
  }

  function cellOf(sys, x, y) {
    var g = sys.grid;
    var cx = mod(Math.floor(x / g.cellSize), g.cells);
    var cy = mod(Math.floor(y / g.cellSize), g.cells);
    return cy * g.cells + cx;
  }

  function insertBead(sys, b) {
    var g = sys.grid;
    var c = cellOf(sys, sys.bx[b], sys.by[b]);
    g.beadCell[b] = c;
    g.beadSlot[b] = g.bucket[c].length;
    g.bucket[c].push(b);
  }

  function removeBead(sys, b) {
    var g = sys.grid;
    var c = g.beadCell[b];
    if (c < 0) return;
    var s = g.beadSlot[b];
    var arr = g.bucket[c];
    var last = arr.pop();
    if (last !== b) { arr[s] = last; g.beadSlot[last] = s; }
    g.beadCell[b] = -1;
    g.beadSlot[b] = -1;
  }

  function rebuildGrid(sys) {
    var g = sys.grid;
    for (var c = 0; c < g.bucket.length; c++) g.bucket[c].length = 0;
    g.beadCell.fill(-1);
    for (var b = 0; b < sys.beadCount; b++) insertBead(sys, b);
  }

  // ------------------------------------------------------------------ 系

  /** 鎖 i の重心と向きから、粒子の位置を書き直す。 */
  function placeBeads(sys, i) {
    var p = sys.params, L = p.kinds.length;
    var ux = Math.cos(sys.theta[i]), uy = Math.sin(sys.theta[i]);
    var mid = (L - 1) / 2;
    for (var k = 0; k < L; k++) {
      var off = (k - mid) * p.bond;
      var b = i * L + k;
      sys.bx[b] = mod(sys.cx[i] + ux * off, p.size);
      sys.by[b] = mod(sys.cy[i] + uy * off, p.size);
    }
  }

  /** 与えた位置・向きで鎖 i を置いたときの、他の鎖との接触エネルギー。 */
  function chainEnergyAt(sys, cxv, cyv, th, tmpX, tmpY) {
    var p = sys.params, g = sys.grid, L = p.kinds.length;
    var ux = Math.cos(th), uy = Math.sin(th);
    var mid = (L - 1) / 2;
    var rc2 = p.rc * p.rc;
    var total = 0;
    for (var k = 0; k < L; k++) {
      var off = (k - mid) * p.bond;
      var px = mod(cxv + ux * off, p.size);
      var py = mod(cyv + uy * off, p.size);
      if (tmpX) { tmpX[k] = px; tmpY[k] = py; }
      var kind = p.kinds[k];
      var epsRow = p.eps[kind];
      var rad = p.radius[kind];
      var gcx = mod(Math.floor(px / g.cellSize), g.cells);
      var gcy = mod(Math.floor(py / g.cellSize), g.cells);
      for (var oy = -1; oy <= 1; oy++) {
        var ny = mod(gcy + oy, g.cells);
        for (var ox = -1; ox <= 1; ox++) {
          var nx = mod(gcx + ox, g.cells);
          var arr = g.bucket[ny * g.cells + nx];
          for (var t = 0; t < arr.length; t++) {
            var b = arr[t];
            var dx = wrap(sys.bx[b] - px, p.size);
            var dy = wrap(sys.by[b] - py, p.size);
            var d2 = dx * dx + dy * dy;
            if (d2 >= rc2) continue;
            var kb = sys.beadKind[b];
            var s = rad + p.radius[kb];
            if (d2 < s * s) return Infinity;
            total += epsRow[kb];
          }
        }
      }
    }
    return total;
  }

  /**
   * 系を作る。鎖は「重なりが出ない位置が見つかるまで引き直す」逐次追加で撒く。
   * 初期配置のエネルギーが有限であることを selftest が確かめる。
   */
  function createSystem(opts, seed) {
    var p = {};
    Object.keys(DEFAULTS).forEach(function (k) { p[k] = DEFAULTS[k]; });
    Object.keys(opts || {}).forEach(function (k) { if (opts[k] != null) p[k] = opts[k]; });

    var L = p.kinds.length;
    var n = Math.max(1, Math.round(p.density * p.size * p.size));
    var sys = {
      params: p, n: n, beadsPerChain: L, beadCount: n * L,
      cx: new Float64Array(n), cy: new Float64Array(n), theta: new Float64Array(n),
      bx: new Float64Array(n * L), by: new Float64Array(n * L),
      beadKind: new Int32Array(n * L),
      sweep: 0, accepted: 0, attempted: 0, energy: 0, placementRetries: 0,
    };
    for (var i = 0; i < n; i++) for (var k = 0; k < L; k++) sys.beadKind[i * L + k] = p.kinds[k];
    sys.grid = makeGrid(sys);

    var rng = makeRng(seed);
    var tmpX = new Float64Array(L), tmpY = new Float64Array(L);
    for (var m = 0; m < n; m++) {
      var placed = false;
      for (var attempt = 0; attempt < 800; attempt++) {
        var x = rng() * p.size, y = rng() * p.size, th = rng() * TAU;
        if (isFinite(chainEnergyAt(sys, x, y, th, tmpX, tmpY))) {
          sys.cx[m] = x; sys.cy[m] = y; sys.theta[m] = th;
          placed = true;
          break;
        }
        sys.placementRetries++;
      }
      if (!placed) {
        sys.cx[m] = rng() * p.size; sys.cy[m] = rng() * p.size; sys.theta[m] = rng() * TAU;
      }
      placeBeads(sys, m);
      for (var q = 0; q < L; q++) insertBead(sys, m * L + q);
    }
    sys.rng = rng;
    sys.energy = totalEnergy(sys);
    return sys;
  }

  /** 総当たりで全エネルギーを数える（索引を使わない。検算用かつ初期値用）。 */
  function totalEnergy(sys) {
    var p = sys.params, L = sys.beadsPerChain, rc2 = p.rc * p.rc;
    var e = 0;
    for (var a = 0; a < sys.beadCount; a++) {
      var ca = Math.floor(a / L);
      for (var b = a + 1; b < sys.beadCount; b++) {
        if (Math.floor(b / L) === ca) continue;
        var dx = wrap(sys.bx[b] - sys.bx[a], p.size);
        var dy = wrap(sys.by[b] - sys.by[a], p.size);
        var d2 = dx * dx + dy * dy;
        if (d2 >= rc2) continue;
        var ka = sys.beadKind[a], kb = sys.beadKind[b];
        var s = p.radius[ka] + p.radius[kb];
        if (d2 < s * s) return Infinity;
        e += p.eps[ka][kb];
      }
    }
    return e;
  }

  /**
   * 1 回の提案。鎖 i を平行移動か回転させ、Metropolis で受容する。
   * 自分の粒子を索引から外してからエネルギーを測るので、自己相互作用は入らない。
   */
  function tryMove(sys, i, rng) {
    var p = sys.params, L = sys.beadsPerChain;
    var tmpX = sys._tx || (sys._tx = new Float64Array(L));
    var tmpY = sys._ty || (sys._ty = new Float64Array(L));

    for (var k = 0; k < L; k++) removeBead(sys, i * L + k);

    var eOld = chainEnergyAt(sys, sys.cx[i], sys.cy[i], sys.theta[i], null, null);

    var nx = sys.cx[i], ny = sys.cy[i], nth = sys.theta[i];
    if (rng() < 0.5) {
      nx = mod(nx + (rng() * 2 - 1) * p.stepTrans, p.size);
      ny = mod(ny + (rng() * 2 - 1) * p.stepTrans, p.size);
    } else {
      nth = mod(nth + (rng() * 2 - 1) * p.stepRot, TAU);
    }
    var eNew = chainEnergyAt(sys, nx, ny, nth, tmpX, tmpY);

    var accept;
    if (!isFinite(eNew)) accept = !isFinite(eOld);
    else if (!isFinite(eOld)) accept = true;
    else {
      var dE = eNew - eOld;
      accept = dE <= 0 || rng() < Math.exp(-dE);
    }

    sys.attempted++;
    if (accept) {
      sys.cx[i] = nx; sys.cy[i] = ny; sys.theta[i] = nth;
      placeBeads(sys, i);
      sys.accepted++;
      if (isFinite(eNew) && isFinite(eOld)) sys.energy += eNew - eOld;
    }
    for (var q = 0; q < L; q++) insertBead(sys, i * L + q);
    return accept;
  }

  /** 1 スイープ = 鎖の数だけ提案する。 */
  function stepSweep(sys, rng) {
    var r = rng || sys.rng;
    for (var t = 0; t < sys.n; t++) {
      tryMove(sys, Math.floor(r() * sys.n) % sys.n, r);
    }
    sys.sweep++;
  }

  /**
   * 重心をそのままに、向きだけを無作為に引き直した複製を返す。
   *
   * **これが参照点である**（method K-24）。塊の大きさも位置もまったく同じで、
   * 向きの情報だけが無い系になる。一様な配置（ポアソン）との比較は
   * 「塊があるか」しか言わないので参照点にしない。
   */
  function cloneWithRandomOrientations(sys, rng) {
    var copy = shallowClone(sys);
    for (var i = 0; i < copy.n; i++) {
      copy.theta[i] = rng() * TAU;
      placeBeads(copy, i);
    }
    rebuildGrid(copy);
    return copy;
  }

  /**
   * 重心はそのまま、**向きだけを排除体積を守りながら**引き直した複製を返す。
   *
   * 素朴に角度を引き直すと（cloneWithRandomOrientations）、実際の系では決して
   * 起きない「重なった配置」が参照点に混ざる。それでは「引力が層を作った」のか
   * 「かさが向きを揃えただけ」なのかが分けられない（method K-17）。
   *
   * そこで eps を全て 0 にした系（＝残るのは排除半径だけ）を作り、重心を固定したまま
   * 回転だけの Metropolis を回す。提案は小刻みではなく**角度そのものの引き直し**なので、
   * 数スイープで前の向きを忘れる。
   */
  function cloneWithFeasibleOrientations(sys, rng, sweeps) {
    var copy = shallowClone(sys);
    var p = {};
    Object.keys(sys.params).forEach(function (k) { p[k] = sys.params[k]; });
    p.eps = [[0, 0], [0, 0]];
    copy.params = p;
    var t = sweeps == null ? 10 : sweeps;
    for (var s = 0; s < t; s++) rotationSweep(copy, rng);
    return copy;
  }

  /** 回転だけのスイープ。提案は角度の引き直し（前の向きに依存しない）。 */
  function rotationSweep(sys, rng) {
    var L = sys.beadsPerChain;
    for (var t = 0; t < sys.n; t++) {
      var i = Math.floor(rng() * sys.n) % sys.n;
      for (var k = 0; k < L; k++) removeBead(sys, i * L + k);
      var eOld = chainEnergyAt(sys, sys.cx[i], sys.cy[i], sys.theta[i], null, null);
      var nth = rng() * TAU;
      var eNew = chainEnergyAt(sys, sys.cx[i], sys.cy[i], nth, null, null);
      var accept;
      if (!isFinite(eNew)) accept = !isFinite(eOld);
      else if (!isFinite(eOld)) accept = true;
      else { var dE = eNew - eOld; accept = dE <= 0 || rng() < Math.exp(-dE); }
      sys.attempted++;
      if (accept) { sys.theta[i] = nth; placeBeads(sys, i); sys.accepted++; }
      for (var q = 0; q < L; q++) insertBead(sys, i * L + q);
    }
    sys.sweep++;
  }

  function shallowClone(sys) {
    var copy = {
      params: sys.params, n: sys.n, beadsPerChain: sys.beadsPerChain, beadCount: sys.beadCount,
      cx: Float64Array.from(sys.cx), cy: Float64Array.from(sys.cy), theta: Float64Array.from(sys.theta),
      bx: Float64Array.from(sys.bx), by: Float64Array.from(sys.by),
      beadKind: Int32Array.from(sys.beadKind),
      sweep: sys.sweep, accepted: 0, attempted: 0, energy: 0, placementRetries: 0,
    };
    copy.grid = makeGrid(copy);
    rebuildGrid(copy);
    return copy;
  }

  /** 位置・向きを外から与えて系を組む（手組みの対照を作るため）。 */
  function fromChains(chains, opts) {
    var p = {};
    Object.keys(DEFAULTS).forEach(function (k) { p[k] = DEFAULTS[k]; });
    Object.keys(opts || {}).forEach(function (k) { if (opts[k] != null) p[k] = opts[k]; });
    var L = p.kinds.length, n = chains.length;
    var sys = {
      params: p, n: n, beadsPerChain: L, beadCount: n * L,
      cx: new Float64Array(n), cy: new Float64Array(n), theta: new Float64Array(n),
      bx: new Float64Array(n * L), by: new Float64Array(n * L),
      beadKind: new Int32Array(n * L),
      sweep: 0, accepted: 0, attempted: 0, energy: 0, placementRetries: 0,
    };
    for (var i = 0; i < n; i++) {
      for (var k = 0; k < L; k++) sys.beadKind[i * L + k] = p.kinds[k];
      sys.cx[i] = mod(chains[i][0], p.size);
      sys.cy[i] = mod(chains[i][1], p.size);
      sys.theta[i] = mod(chains[i][2], TAU);
    }
    sys.grid = makeGrid(sys);
    for (var m = 0; m < n; m++) placeBeads(sys, m);
    rebuildGrid(sys);
    sys.energy = totalEnergy(sys);
    return sys;
  }

  /** 1 レプリケートを回す。 */
  function runReplicate(opts, seed, sweeps, onProgress, progressEvery) {
    var sys = createSystem(opts, seed);
    var rng = makeRng(seed ^ 0x5bf03635);
    var every = progressEvery || 100;
    for (var t = 0; t < sweeps; t++) {
      stepSweep(sys, rng);
      if (onProgress && (t + 1) % every === 0) onProgress(sys, t + 1);
    }
    return sys;
  }

  return {
    TAU: TAU,
    DEFAULTS: DEFAULTS,
    makeRng: makeRng,
    makeEps: makeEps,
    wrap: wrap,
    mod: mod,
    createSystem: createSystem,
    fromChains: fromChains,
    placeBeads: placeBeads,
    rebuildGrid: rebuildGrid,
    chainEnergyAt: chainEnergyAt,
    totalEnergy: totalEnergy,
    tryMove: tryMove,
    stepSweep: stepSweep,
    cloneWithRandomOrientations: cloneWithRandomOrientations,
    cloneWithFeasibleOrientations: cloneWithFeasibleOrientations,
    rotationSweep: rotationSweep,
    shallowClone: shallowClone,
    runReplicate: runReplicate,
  };
});
