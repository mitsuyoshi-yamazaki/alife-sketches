/**
 * S-49 核 — トーラス平面上の重力場の計算と、物体の時間発展だけ。
 *
 * 上位概念（cell / membrane / gene / organism / catalyst / fitness / alive 等）は無い。
 * ここにあるのは「座標」「源」「物体」「力」「ポテンシャル」「積分」という、
 * ニュートン力学そのものの語彙だけである（本題材はそもそも生物学の語彙を要しない）。
 * 判定に使う名前つきの検出器（wrapForceFraction 等）は observer.js 側に置く。
 *
 * 依存ゼロ・古典スクリプト。Node（module.exports）とブラウザ（window.S49）で共用する。
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- 乱数・状態ハッシュ

  /** mulberry32。シードを固定すれば完全に再現する。 */
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** FNV-1a 32bit を、物体の位置・速度の生バイト列にかける（K-36。浮動小数点まで含めて厳密な再現性を見る）。 */
  function hashState(state) {
    var n = state.count;
    var buf = new Float64Array(n * 4);
    for (var i = 0; i < n; i++) {
      buf[i * 4] = state.x[i]; buf[i * 4 + 1] = state.y[i];
      buf[i * 4 + 2] = state.vx[i]; buf[i * 4 + 3] = state.vy[i];
    }
    var bytes = new Uint8Array(buf.buffer);
    var h = 0x811c9dc5;
    for (var j = 0; j < bytes.length; j++) { h ^= bytes[j]; h = Math.imul(h, 0x01000193) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  // ---------------------------------------------------------------- トーラス幾何

  /** [0,L) へ折り畳む。 */
  function wrap1(x, L) { L = L || 1; var m = x % L; return m < 0 ? m + L : m; }

  /** b-a の最近接鏡像変位（[-L/2, L/2) に丸めた差。d_s の定義そのもの）。 */
  function nearestDelta(d, L) { L = L || 1; return d - L * Math.round(d / L); }

  /** トーラス上の最短距離（最大 L/√2 で飽和）。 */
  function torusDist(ax, ay, bx, by, L) {
    var dx = nearestDelta(bx - ax, L), dy = nearestDelta(by - ay, L);
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ---------------------------------------------------------------- 鏡像の打ち切り集合

  var offsetCache = {};
  /** N_img と打ち切り形（'square'|'circle'）から (nx,ny) の一覧を作る（キャッシュ付き）。 */
  function imageOffsets(N, shape) {
    var key = N + ':' + shape;
    var cached = offsetCache[key];
    if (cached) return cached;
    var nxs = [], nys = [];
    for (var ny = -N; ny <= N; ny++) {
      for (var nx = -N; nx <= N; nx++) {
        if (shape === 'circle' && nx * nx + ny * ny > N * N) continue;
        nxs.push(nx); nys.push(ny);
      }
    }
    var out = { nx: Float64Array.from(nxs), ny: Float64Array.from(nys), count: nxs.length };
    offsetCache[key] = out;
    return out;
  }

  // ---------------------------------------------------------------- 場（力・ポテンシャル）

  /**
   * 位置 (x,y) における全源からの重力の力と位置エネルギー。criteria.systemParameters.forceLaw /
   * potentialLaw そのもの。sources は {x,y,gm: Float64Array, count}。
   */
  function fieldAt(x, y, sources, N, shape, eps, L) {
    var off = imageOffsets(N, shape);
    var onx = off.nx, ony = off.ny, m = off.count;
    var eps2 = eps * eps;
    var fx = 0, fy = 0, phi = 0;
    for (var s = 0; s < sources.count; s++) {
      var gm = sources.gm[s];
      if (gm === 0) continue;
      var ddx = nearestDelta(x - sources.x[s], L);
      var ddy = nearestDelta(y - sources.y[s], L);
      for (var k = 0; k < m; k++) {
        var vx = ddx + onx[k] * L, vy = ddy + ony[k] * L;
        var r2 = vx * vx + vy * vy;
        var denom2 = r2 + eps2;
        var denom = Math.sqrt(denom2);
        var invDenom3 = 1 / (denom2 * denom);
        fx -= gm * vx * invDenom3;
        fy -= gm * vy * invDenom3;
        phi -= gm / denom;
      }
    }
    return { fx: fx, fy: fy, phi: phi };
  }

  /** fieldAt の格子版。gridSize×gridSize、セル中心をサンプルする。三つの Float64Array を返す。 */
  function fieldGrid(sources, N, shape, eps, L, gridSize) {
    var n = gridSize * gridSize;
    var Fx = new Float64Array(n), Fy = new Float64Array(n), Phi = new Float64Array(n);
    for (var iy = 0; iy < gridSize; iy++) {
      var y = (iy + 0.5) / gridSize * L;
      for (var ix = 0; ix < gridSize; ix++) {
        var x = (ix + 0.5) / gridSize * L;
        var f = fieldAt(x, y, sources, N, shape, eps, L);
        var i = iy * gridSize + ix;
        Fx[i] = f.fx; Fy[i] = f.fy; Phi[i] = f.phi;
      }
    }
    return { Fx: Fx, Fy: Fy, Phi: Phi, gridSize: gridSize, L: L };
  }

  // ---------------------------------------------------------------- 源配置・初期条件の生成（乱数はここでしか使わない）

  /**
   * 重力源を配置する。位置だけを configSeed で振り、互いのトーラス距離が minSep 以上になるまで
   * 棄却再抽選する（GM は固定値。userSpecification どおり乱数にしない）。
   */
  function makeSources(configSeed, gmList, minSep, L) {
    var rnd = rng(configSeed);
    var xs = [], ys = [], rejections = 0;
    for (var i = 0; i < gmList.length; i++) {
      for (;;) {
        var x = rnd() * L, y = rnd() * L, ok = true;
        for (var j = 0; j < xs.length; j++) {
          if (torusDist(x, y, xs[j], ys[j], L) < minSep) { ok = false; break; }
        }
        if (ok) { xs.push(x); ys.push(y); break; }
        rejections++;
      }
    }
    return { x: Float64Array.from(xs), y: Float64Array.from(ys), gm: Float64Array.from(gmList), count: gmList.length, rejections: rejections };
  }

  /**
   * 物体の初期状態を作る。位置は T² 上一様（いずれかの源から rejectRadius 以内は棄却再抽選）、
   * 速度は方向一様・速さ Uniform(speedRange)。
   */
  function makeInitialConditions(icSeed, count, speedRange, sources, rejectRadius, L) {
    var rnd = rng(icSeed);
    var xs = [], ys = [], vxs = [], vys = [], rejections = 0;
    for (var i = 0; i < count; i++) {
      var x, y;
      for (;;) {
        x = rnd() * L; y = rnd() * L;
        var tooClose = false;
        for (var j = 0; j < sources.count; j++) {
          if (torusDist(x, y, sources.x[j], sources.y[j], L) < rejectRadius) { tooClose = true; break; }
        }
        if (!tooClose) break;
        rejections++;
      }
      var speed = speedRange[0] + rnd() * (speedRange[1] - speedRange[0]);
      var angle = rnd() * 2 * Math.PI;
      xs.push(x); ys.push(y); vxs.push(speed * Math.cos(angle)); vys.push(speed * Math.sin(angle));
    }
    return {
      x: Float64Array.from(xs), y: Float64Array.from(ys),
      vx: Float64Array.from(vxs), vy: Float64Array.from(vys),
      count: count, rejections: rejections
    };
  }

  function cloneState(state) {
    return { x: Float64Array.from(state.x), y: Float64Array.from(state.y), vx: Float64Array.from(state.vx), vy: Float64Array.from(state.vy), count: state.count };
  }

  // ---------------------------------------------------------------- 積分法

  function computeAccelInto(state, sources, N, shape, eps, L, outAx, outAy) {
    for (var i = 0; i < state.count; i++) {
      var f = fieldAt(state.x[i], state.y[i], sources, N, shape, eps, L);
      outAx[i] = f.fx; outAy[i] = f.fy;
    }
  }

  /** velocity Verlet（シンプレクティック2次）。破壊的に state を進める。 */
  function VerletIntegrator(state, sources, N, shape, eps, L) {
    this.state = state; this.sources = sources; this.N = N; this.shape = shape; this.eps = eps; this.L = L;
    this.ax = new Float64Array(state.count); this.ay = new Float64Array(state.count);
    this._nax = new Float64Array(state.count); this._nay = new Float64Array(state.count);
    computeAccelInto(state, sources, N, shape, eps, L, this.ax, this.ay);
  }
  VerletIntegrator.prototype.step = function (dt) {
    var st = this.state, n = st.count, L = this.L, ax = this.ax, ay = this.ay;
    var i;
    for (i = 0; i < n; i++) {
      st.x[i] = wrap1(st.x[i] + st.vx[i] * dt + 0.5 * ax[i] * dt * dt, L);
      st.y[i] = wrap1(st.y[i] + st.vy[i] * dt + 0.5 * ay[i] * dt * dt, L);
    }
    computeAccelInto(st, this.sources, this.N, this.shape, this.eps, this.L, this._nax, this._nay);
    for (i = 0; i < n; i++) {
      st.vx[i] += 0.5 * (ax[i] + this._nax[i]) * dt;
      st.vy[i] += 0.5 * (ay[i] + this._nay[i]) * dt;
    }
    var tx = this.ax; this.ax = this._nax; this._nax = tx;
    var ty = this.ay; this.ay = this._nay; this._nay = ty;
  };

  /** 陽的 Euler（negativeControls[2]）。 r ← r+v dt; v ← v+a dt（両方とも旧値を使う）。 */
  function EulerIntegrator(state, sources, N, shape, eps, L) {
    this.state = state; this.sources = sources; this.N = N; this.shape = shape; this.eps = eps; this.L = L;
    this._ax = new Float64Array(state.count); this._ay = new Float64Array(state.count);
  }
  EulerIntegrator.prototype.step = function (dt) {
    var st = this.state, n = st.count, L = this.L, ax = this._ax, ay = this._ay;
    computeAccelInto(st, this.sources, this.N, this.shape, this.eps, this.L, ax, ay);
    for (var i = 0; i < n; i++) {
      var nx = st.x[i] + st.vx[i] * dt, ny = st.y[i] + st.vy[i] * dt;
      st.vx[i] += ax[i] * dt; st.vy[i] += ay[i] * dt;
      st.x[i] = wrap1(nx, L); st.y[i] = wrap1(ny, L);
    }
  };

  // ---------------------------------------------------------------- エネルギー・生存の検算

  /** 物体ごとの E = ½|v|² + Φ(r)（Φ は力と同一の N・打ち切り形）。 */
  function energyPerObject(state, sources, N, shape, eps, L) {
    var n = state.count, E = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var f = fieldAt(state.x[i], state.y[i], sources, N, shape, eps, L);
      E[i] = 0.5 * (state.vx[i] * state.vx[i] + state.vy[i] * state.vy[i]) + f.phi;
    }
    return E;
  }

  /** 生存の検算（K-30）: 状態が持つ物体数が期待どおりか。数値がすべて有限か。 */
  function stateHealthy(state, expectedCount) {
    if (state.count !== expectedCount) return false;
    for (var i = 0; i < state.count; i++) {
      if (!isFinite(state.x[i]) || !isFinite(state.y[i]) || !isFinite(state.vx[i]) || !isFinite(state.vy[i])) return false;
      if (state.x[i] < 0 || state.x[i] >= 1e9) return false; // wrap1 の不変条件（L は正）
    }
    return true;
  }

  var api = {
    rng: rng, hashState: hashState,
    wrap1: wrap1, nearestDelta: nearestDelta, torusDist: torusDist,
    imageOffsets: imageOffsets, fieldAt: fieldAt, fieldGrid: fieldGrid,
    makeSources: makeSources, makeInitialConditions: makeInitialConditions, cloneState: cloneState,
    computeAccelInto: computeAccelInto, VerletIntegrator: VerletIntegrator, EulerIntegrator: EulerIntegrator,
    energyPerObject: energyPerObject, stateHealthy: stateHealthy
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.S49 = api;
  if (typeof global !== 'undefined' && global && !global.S49) global.S49 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
