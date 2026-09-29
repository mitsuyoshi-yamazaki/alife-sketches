/**
 * S-59 の核。2次元周期箱の円板 N 個。各粒子は型 F(餌)/S(構造材)/W(廃物) の1つを持ち、
 * 反応で型が変わる。対ポテンシャルは芯(WCA、型に依らない)＋滑らかな井戸(型ペアで係数が違う
 * c_ab・g(r))。力学は慣性と熱浴を持つ BAOAB の Langevin。反応は3つ(光 W→F・崩壊 S→W・
 * 触媒 F→S)で、型が変わる瞬間のポテンシャルの跳び ΔU_jump をその反応の化学エネルギーが払う
 * (q<0 なら拒否)。太陽・化学・運動・ポテンシャル・熱の5区画の台帳が全体で保存する。
 *
 * criteria.json の system 節をそのままコードにしたもの。上位概念の語彙(cell / membrane /
 * division / organism 等)は使わない――観測器(tracking.js)の側だけがそれを使ってよい。
 *
 * Node とブラウザの両方で使う(UMD 風)。ESM にしない(file:// で開けるように)。依存ゼロ。
 */
'use strict';
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S59 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // ── 単位: σ(円板の直径)=1, m=1, kT=1(熱浴の温度), τ=σ√(m/kT)=1 ─────────────
  var TYPE_F = 0, TYPE_S = 1, TYPE_W = 2;
  var RM = Math.pow(2, 1 / 6); // 芯の極小(=WCAの切り点)

  // ================================================================ 乱数

  /** mulberry32。速い・十分にばらける・決定的。 */
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash32(a, b) {
    var h = (a ^ 0x9e3779b9) >>> 0;
    h = Math.imul(h ^ b, 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }
  /** seed から独立した部分ストリームを作る(streamId: 0=位置,1=速度,2=型,3=theta,4=熱浴,5=反応 …)。 */
  function subStream(seed, streamId) { return makeRng(hash32(seed >>> 0, streamId >>> 0)); }

  function gaussianFactory(rng) {
    var spare = null;
    return function gaussian() {
      if (spare !== null) { var v = spare; spare = null; return v; }
      var u, v2, s2;
      do { u = 2 * rng() - 1; v2 = 2 * rng() - 1; s2 = u * u + v2 * v2; } while (s2 >= 1 || s2 === 0);
      var mul = Math.sqrt(-2 * Math.log(s2) / s2);
      spare = v2 * mul;
      return u * mul;
    };
  }
  /** Knuth の Poisson 標本(λ が小さい前提。本件は Φ·dt~0.01〜0.02)。 */
  function poissonSample(rng, lambda) {
    if (lambda <= 0) return 0;
    var L = Math.exp(-lambda), k = 0, p = 1;
    do { k++; p *= rng(); } while (p > L);
    return k - 1;
  }

  // ================================================================ Kahan(補償和)

  function makeKahan() { return { sum: 0, c: 0 }; }
  function kahanAdd(acc, v) {
    var y = v - acc.c, t = acc.sum + y;
    acc.c = (t - acc.sum) - y; acc.sum = t;
  }

  // ================================================================ パラメータ

  /**
   * criteria.json system/protocol 節のコード化。呼び出し側が変えるのは主に
   * epsS(またはepsMode)・Phi・seed・sunMode・freeArm・decayMode・leakMode・reactionsEnabled。
   */
  function defaultParams(overrides) {
    var p = {
      L: 64, N: 1024, dt: 0.005, gamma: 1, kT: 1,
      rm: RM, w: 1.0, rc: RM + 1.0,
      epsWS: 1,
      epsMode: 'const', epsS: 2, // 'const'(M・A-noWS・A-dusk・A-free・NC・PC-S) | 'theta'(SEL: eps=2+theta)
      kDecayBase: 0.01, decayMode: 'const', // 'const' | 'thetaPCS'(k_d·(1.5-theta))
      kCat: 1, rCat: 1.5,
      uF: 50, uS: 40, uW: 0, ePh: 50,
      Phi: 2,
      sunPhotons0: Math.ceil(2600 * 2), // 光子の初期の個数(main系)。dusk/freeは呼び出し側が上書き
      freeArm: false, // A-free: 尽きた後もSunを引かずに払う
      reactionsEnabled: true, // NC-static: 反応を全て止める
      mutSigma: 0.03,
      leakMode: 'none', // 'none' | 'jumpleak' | 'freephoto'(PC-E較正専用)
      seed: 5901,
    };
    var out = {};
    for (var k in p) out[k] = p[k];
    if (overrides) for (var k2 in overrides) out[k2] = overrides[k2];
    return out;
  }

  /** S粒子の凝集の強さ ε_i。epsMode='theta'(SEL)なら 2+θ、それ以外は params.epsS(定数)。 */
  function epsForParticle(sys, i, p) { return p.epsMode === 'theta' ? (2 + sys.theta[i]) : p.epsS; }

  // ================================================================ 系(状態)

  function createSystem(N, L) {
    return {
      N: N, L: L, t: 0,
      type: new Uint8Array(N),
      x: new Float64Array(N), y: new Float64Array(N),
      vx: new Float64Array(N), vy: new Float64Array(N),
      theta: new Float64Array(N),
      sunPhotons: 0,
      H: makeKahan(), Err: makeKahan(),
      unpaidWork: 0, leakCounter: 0,
      refused: { count: 0, qSum: 0, byType: { light: 0, decay: 0, catalysis: 0 } },
      reactionTotals: { light: 0, decay: 0, catalysis: 0 },
      flow: { sun: 0, chemToU: 0, uToChem: 0, chemToH: 0, bathToK: 0, kToBath: 0 },
      _f: null,
    };
  }
  function wrapPos(v, L) { v = v % L; if (v < 0) v += L; return v; }
  function wrapAll(sys) { for (var i = 0; i < sys.N; i++) { sys.x[i] = wrapPos(sys.x[i], sys.L); sys.y[i] = wrapPos(sys.y[i], sys.L); } }
  function minImageD(dx, L) { if (dx > L / 2) dx -= L; else if (dx < -L / 2) dx += L; return dx; }

  /** 最小間隔 minGap の逐次付加(周期境界・セル表で近傍探索。O(N)に近い)。 */
  function randomSequentialFill(N, L, minGap, rng) {
    var x = new Float64Array(N), y = new Float64Array(N);
    var cellSize = Math.max(minGap, 0.5);
    var nc = Math.max(1, Math.floor(L / cellSize));
    var w = L / nc;
    function cellOf(v) { return Math.min(nc - 1, Math.floor(wrapPos(v, L) / w)); }
    var buckets = new Map();
    function key(ci, cj) { return ci * nc + cj; }
    var fellBack = false;
    for (var n = 0; n < N; n++) {
      var placed = false;
      for (var attempt = 0; attempt < 3000 && !placed; attempt++) {
        var px = rng() * L, py = rng() * L;
        var ci = cellOf(px), cj = cellOf(py), ok = true;
        outer:
        for (var di = -1; di <= 1 && ok; di++) {
          for (var dj = -1; dj <= 1; dj++) {
            var kk = key(((ci + di) % nc + nc) % nc, ((cj + dj) % nc + nc) % nc);
            var list = buckets.get(kk);
            if (!list) continue;
            for (var a = 0; a < list.length; a++) {
              var idx = list[a];
              var dx = minImageD(px - x[idx], L), dy = minImageD(py - y[idx], L);
              if (Math.hypot(dx, dy) < minGap) { ok = false; break outer; }
            }
          }
        }
        if (ok) {
          x[n] = px; y[n] = py;
          var kk2 = key(ci, cj);
          if (!buckets.has(kk2)) buckets.set(kk2, []);
          buckets.get(kk2).push(n);
          placed = true;
        }
      }
      if (!placed) { x[n] = rng() * L; y[n] = rng() * L; fellBack = true; }
    }
    return { x: x, y: y, fellBack: fellBack };
  }

  /** Maxwell 速度分布(Box-Muller)。全運動量を0へ差し引く。 */
  function maxwellVelocities(N, T, rng) {
    var vx = new Float64Array(N), vy = new Float64Array(N), sigma = Math.sqrt(T);
    var gaussian = gaussianFactory(rng);
    for (var i = 0; i < N; i++) { vx[i] = sigma * gaussian(); vy[i] = sigma * gaussian(); }
    var px = 0, py = 0;
    for (i = 0; i < N; i++) { px += vx[i]; py += vy[i]; }
    var dvx = px / N, dvy = py / N;
    for (i = 0; i < N; i++) { vx[i] -= dvx; vy[i] -= dvy; }
    return { vx: vx, vy: vy };
  }

  /**
   * 1本の走行を初期化する(criteria.json protocol.init)。型は無作為に S(初期θ一様)・F・W を割り当てる。
   * counts = { S, F, W }(既定 S=205・F=102・W=717。合計はNと一致させること)。
   */
  function initReplicate(p, counts) {
    var N = p.N;
    var sys = createSystem(N, p.L);
    var posRng = subStream(p.seed, 0), velRng = subStream(p.seed, 1);
    var typeRng = subStream(p.seed, 2), thetaRng = subStream(p.seed, 3);
    var fill = randomSequentialFill(N, p.L, 0.9, posRng);
    sys.x.set(fill.x); sys.y.set(fill.y); sys.fellBack = fill.fellBack;
    var mv = maxwellVelocities(N, p.kT, velRng);
    sys.vx.set(mv.vx); sys.vy.set(mv.vy);
    counts = counts || { S: 205, F: 102, W: 717 };
    var labels = [];
    for (var s = 0; s < counts.S; s++) labels.push(TYPE_S);
    for (var f = 0; f < counts.F; f++) labels.push(TYPE_F);
    for (var w = 0; w < counts.W; w++) labels.push(TYPE_W);
    while (labels.length < N) labels.push(TYPE_F);
    labels.length = N;
    // フィッシャー–イェーツで無作為に並べ替えてから割り当てる(型と位置を無相関にする)。
    for (var i = labels.length - 1; i > 0; i--) {
      var j = Math.floor(typeRng() * (i + 1));
      var tmp = labels[i]; labels[i] = labels[j]; labels[j] = tmp;
    }
    for (i = 0; i < N; i++) {
      sys.type[i] = labels[i];
      sys.theta[i] = sys.type[i] === TYPE_S ? thetaRng() : 0;
    }
    sys.sunPhotons = p.sunPhotons0;
    return sys;
  }

  // ================================================================ 対ポテンシャル

  /** 芯(WCA。r<r_m のみ非零。型に依らない)。 */
  function coreVF(r) {
    if (r >= RM) return { V: 0, F: 0 };
    var s2 = 1 / (r * r), s6 = s2 * s2 * s2, s12 = s6 * s6;
    return { V: 4 * (s12 - s6) + 1, F: 4 * (12 * s12 - 6 * s6) / r };
  }
  /** 井戸の形 g(r)。r<r_m→1、r_m<=r<r_c→五次の切り替え、以遠→0。 */
  function wellShape(r, rm, w) {
    if (r < rm) return 1;
    var rc = rm + w;
    if (r >= rc) return 0;
    var x = (r - rm) / w;
    return 1 - 10 * x * x * x + 15 * x * x * x * x - 6 * x * x * x * x * x;
  }
  /** dg/dr(r_m<=r<r_c の区間のみ非零)。 */
  function wellShapeDeriv(r, rm, w) {
    if (r < rm) return 0;
    var rc = rm + w;
    if (r >= rc) return 0;
    var x = (r - rm) / w;
    return (-30 * x * x * (1 - x) * (1 - x)) / w;
  }
  /** 型ペアの井戸係数 c_ab。S-S=引力(-ε_ij)・W-S=斥力(+ε_WS)・他=0。 */
  function pairCoef(typeA, epsA, typeB, epsB, epsWS) {
    if (typeA === TYPE_S && typeB === TYPE_S) return -((epsA + epsB) / 2);
    if ((typeA === TYPE_S && typeB === TYPE_W) || (typeA === TYPE_W && typeB === TYPE_S)) return epsWS;
    return 0;
  }
  /** V(r)=V_c(r)+c·g(r)、F(r)=-dV/dr の解析的な厳密勾配。 */
  function pairVF(r, c, rm, w) {
    var core = coreVF(r);
    if (c === 0) return core;
    var g = wellShape(r, rm, w), dg = wellShapeDeriv(r, rm, w);
    return { V: core.V + c * g, F: core.F - c * dg };
  }

  /** 数値微分(中心差分)。selftest の勾配検査に使う。 */
  function numericF(r, c, rm, w, h) {
    h = h || 1e-6 * Math.max(r, 1);
    return -(pairVF(r + h, c, rm, w).V - pairVF(r - h, c, rm, w).V) / (2 * h);
  }

  // ================================================================ セル表(近傍探索)

  /** cellSize 以上の格子でセル表を作る(周期境界)。cellSize は使うどの打ち切りよりも大きくすること。 */
  function buildCellList(sys, cellSize) {
    var L = sys.L, nc = Math.max(3, Math.floor(L / cellSize)), w = L / nc;
    var buckets = new Array(nc * nc);
    for (var k = 0; k < buckets.length; k++) buckets[k] = [];
    function cellOf(v) { return Math.min(nc - 1, Math.floor(wrapPos(v, L) / w)); }
    for (var i = 0; i < sys.N; i++) buckets[cellOf(sys.x[i]) * nc + cellOf(sys.y[i])].push(i);
    return { nc: nc, w: w, buckets: buckets, cellOf: cellOf };
  }
  /**
   * セル表を使い、rMax(<=セルの一辺)以内の対を1回ずつ cb(i,j,dx,dy,r2) で渡す。
   * dx,dy は i から見た最小像変位。近道の高速化――全対との一致は selftest の「近道の検算」で見る。
   */
  function forEachPairWithin(cl, sys, rMax, cb) {
    var nc = cl.nc, L = sys.L, halfL = L / 2, rMax2 = rMax * rMax;
    for (var ci = 0; ci < nc; ci++) {
      for (var cj = 0; cj < nc; cj++) {
        var here = cl.buckets[ci * nc + cj];
        for (var di = 0; di <= 1; di++) {
          for (var dj = (di === 0 ? 0 : -1); dj <= 1; dj++) {
            var oci = ((ci + di) % nc + nc) % nc, ocj = ((cj + dj) % nc + nc) % nc;
            if (di === 0 && dj === 0 && !(oci === ci && ocj === cj)) continue;
            var other = cl.buckets[oci * nc + ocj];
            for (var a = 0; a < here.length; a++) {
              var startB = (oci === ci && ocj === cj) ? a + 1 : 0;
              for (var b = startB; b < other.length; b++) {
                var i = here[a], j = other[b];
                if (i === j) continue;
                var dx = sys.x[i] - sys.x[j], dy = sys.y[i] - sys.y[j];
                if (dx > halfL) dx -= L; else if (dx < -halfL) dx += L;
                if (dy > halfL) dy -= L; else if (dy < -halfL) dy += L;
                var r2 = dx * dx + dy * dy;
                if (r2 < rMax2) cb(i, j, dx, dy, r2);
              }
            }
          }
        }
      }
    }
  }
  /** 粒子 i の rMax 以内の近傍を [[j,r],...] で返す(反応の会計で使う。呼び出し頻度は低い)。 */
  function neighborsWithin(cl, sys, i, rMax) {
    var out = [], L = sys.L, nc = cl.nc;
    var ci = cl.cellOf(sys.x[i]), cj = cl.cellOf(sys.y[i]);
    for (var di = -1; di <= 1; di++) {
      for (var dj = -1; dj <= 1; dj++) {
        var oci = ((ci + di) % nc + nc) % nc, ocj = ((cj + dj) % nc + nc) % nc;
        var bucket = cl.buckets[oci * nc + ocj];
        for (var a = 0; a < bucket.length; a++) {
          var j = bucket[a];
          if (j === i) continue;
          var dx = minImageD(sys.x[i] - sys.x[j], L), dy = minImageD(sys.y[i] - sys.y[j], L);
          var r = Math.hypot(dx, dy);
          if (r < rMax) out.push([j, r]);
        }
      }
    }
    return out;
  }

  // ================================================================ 力とエネルギー

  /**
   * 全対の力・U・触媒候補数(rCat以内のS隣接をFごとに数える)をセル表で計算する。
   * cl を渡せば再構築しない(反応段は位置が動かないので使い回せる)。
   */
  function computeForces(sys, p, cl) {
    var N = sys.N;
    var fx = new Float64Array(N), fy = new Float64Array(N);
    var U = 0;
    var sCatalystCount = new Int32Array(N);
    if (!cl) cl = buildCellList(sys, p.rc);
    forEachPairWithin(cl, sys, p.rc, function (i, j, dx, dy, r2) {
      var r = Math.sqrt(r2);
      var ti = sys.type[i], tj = sys.type[j];
      var epsi = ti === TYPE_S ? epsForParticle(sys, i, p) : 0;
      var epsj = tj === TYPE_S ? epsForParticle(sys, j, p) : 0;
      var c = pairCoef(ti, epsi, tj, epsj, p.epsWS);
      var vf = pairVF(r, c, p.rm, p.w);
      U += vf.V;
      var fr = vf.F / r, fxp = fr * dx, fyp = fr * dy;
      fx[i] += fxp; fy[i] += fyp; fx[j] -= fxp; fy[j] -= fyp;
      if (r < p.rCat) {
        if (ti === TYPE_F && tj === TYPE_S) sCatalystCount[i]++;
        else if (tj === TYPE_F && ti === TYPE_S) sCatalystCount[j]++;
      }
    });
    return { fx: fx, fy: fy, U: U, sCatalystCount: sCatalystCount, cellList: cl };
  }

  /** 遅いが素直な全対探索(selftest専用の「近道の検算」参照実装)。computeForces と数式は同一。 */
  function computeForcesReference(sys, p) {
    var N = sys.N, L = sys.L;
    var fx = new Float64Array(N), fy = new Float64Array(N);
    var U = 0;
    for (var i = 0; i < N; i++) {
      for (var j = i + 1; j < N; j++) {
        var dx = minImageD(sys.x[i] - sys.x[j], L), dy = minImageD(sys.y[i] - sys.y[j], L);
        var r2 = dx * dx + dy * dy;
        if (r2 >= p.rc * p.rc) continue;
        var r = Math.sqrt(r2);
        var ti = sys.type[i], tj = sys.type[j];
        var epsi = ti === TYPE_S ? epsForParticle(sys, i, p) : 0;
        var epsj = tj === TYPE_S ? epsForParticle(sys, j, p) : 0;
        var c = pairCoef(ti, epsi, tj, epsj, p.epsWS);
        var vf = pairVF(r, c, p.rm, p.w);
        U += vf.V;
        var fr = vf.F / r, fxp = fr * dx, fyp = fr * dy;
        fx[i] += fxp; fy[i] += fyp; fx[j] -= fxp; fy[j] -= fyp;
      }
    }
    return { fx: fx, fy: fy, U: U };
  }

  /** 反応する粒子1個だけの型/eps変更による ΔU_jump = Σ_j [V_new(r_ij) - V_old(r_ij)]。 */
  function deltaUJump(cl, sys, i, oldType, oldEps, newType, newEps, p) {
    var neigh = neighborsWithin(cl, sys, i, p.rc);
    var sum = 0;
    for (var k = 0; k < neigh.length; k++) {
      var j = neigh[k][0], r = neigh[k][1];
      var tj = sys.type[j];
      var epsj = tj === TYPE_S ? epsForParticle(sys, j, p) : 0;
      var g = wellShape(r, p.rm, p.w);
      var oldC = pairCoef(oldType, oldEps, tj, epsj, p.epsWS);
      var newC = pairCoef(newType, newEps, tj, epsj, p.epsWS);
      sum += (newC - oldC) * g;
    }
    return { dUjump: sum, neighbors: neigh };
  }

  function kineticEnergy(sys) {
    var K = 0; for (var i = 0; i < sys.N; i++) K += 0.5 * (sys.vx[i] * sys.vx[i] + sys.vy[i] * sys.vy[i]);
    return K;
  }
  function totalMomentum(sys) {
    var px = 0, py = 0; for (var i = 0; i < sys.N; i++) { px += sys.vx[i]; py += sys.vy[i]; } return { px: px, py: py };
  }
  function typeCounts(sys) {
    var c = { F: 0, S: 0, W: 0 };
    for (var i = 0; i < sys.N; i++) { if (sys.type[i] === TYPE_F) c.F++; else if (sys.type[i] === TYPE_S) c.S++; else c.W++; }
    return c;
  }
  function chemTotal(sys, p) {
    var c = typeCounts(sys); return c.F * p.uF + c.S * p.uS + c.W * p.uW;
  }
  function sunEnergy(sys, p) { return sys.sunPhotons * p.ePh; }
  /** E_tot = Sun+Chem+K+U+H(H は Kahan の sum)。 */
  function eTot(sys, p, U) { return sunEnergy(sys, p) + chemTotal(sys, p) + kineticEnergy(sys) + U + sys.H.sum; }

  // ================================================================ 積分(BAOAB)+反応

  function halfKick(sys, fx, fy, dtHalf) {
    for (var i = 0; i < sys.N; i++) { sys.vx[i] += dtHalf * fx[i]; sys.vy[i] += dtHalf * fy[i]; }
  }
  function halfDrift(sys, dtHalf) {
    for (var i = 0; i < sys.N; i++) { sys.x[i] += dtHalf * sys.vx[i]; sys.y[i] += dtHalf * sys.vy[i]; }
  }
  function applyBath(sys, gamma, dt, kT, gaussian) {
    var c = Math.exp(-gamma * dt), sigma = Math.sqrt(Math.max(0, 1 - c * c) * kT);
    for (var i = 0; i < sys.N; i++) {
      sys.vx[i] = c * sys.vx[i] + sigma * gaussian();
      sys.vy[i] = c * sys.vy[i] + sigma * gaussian();
    }
  }

  /**
   * 1刻み進める(BAOAB→反応: 光→崩壊→触媒)。events(受け皿。省略可)に誕生・拒否・反応の生ログを積む。
   * 戻り値: { closureResidual(反応があった刻みだけ数値、無ければnull) }。
   */
  function stepSystem(sys, p, rng, gaussian, events) {
    if (!sys._f) sys._f = computeForces(sys, p);
    var kStart = kineticEnergy(sys), Estart = kStart + sys._f.U;

    halfKick(sys, sys._f.fx, sys._f.fy, 0.5 * p.dt);
    halfDrift(sys, 0.5 * p.dt);

    var kBeforeO = kineticEnergy(sys);
    applyBath(sys, p.gamma, p.dt, p.kT, gaussian);
    var kAfterO = kineticEnergy(sys);
    var deltaKO = kAfterO - kBeforeO;

    halfDrift(sys, 0.5 * p.dt);
    wrapAll(sys);

    var f2 = computeForces(sys, p);
    halfKick(sys, f2.fx, f2.fy, 0.5 * p.dt);

    var kEnd = kineticEnergy(sys), Eend = kEnd + f2.U;
    var errStep = (Eend - Estart) - deltaKO;
    kahanAdd(sys.Err, errStep);
    kahanAdd(sys.H, -deltaKO); // 熱浴との交換: H -= ΔK_O

    sys._f = f2;
    sys.t += p.dt;

    if (!p.reactionsEnabled) return { closureResidual: null, anyReaction: false };

    var cl = f2.cellList;
    var beforeU = f2.U;
    var sumDUjump = 0;
    var any = false;

    function payAndApply(kind, i, oldType, oldEps, newType, newEps, chemDelta, ePhBonus, sunPay) {
      var res = deltaUJump(cl, sys, i, oldType, oldEps, newType, newEps, p);
      var dU = res.dUjump;
      var q;
      if (p.leakMode === 'jumpleak') {
        q = chemDelta + (ePhBonus || 0); // ΔU_jumpを払わない(拒否もしない)
        sys.leakCounter += dU;
      } else {
        q = chemDelta + (ePhBonus || 0) - dU;
        if (q < 0) {
          sys.refused.count++; sys.refused.qSum += q; sys.refused.byType[kind]++;
          if (events && events.onRefusal) {
            var nearS = 0, nearW = 0;
            for (var k = 0; k < res.neighbors.length; k++) {
              var nt = sys.type[res.neighbors[k][0]];
              if (nt === TYPE_S) nearS++; else if (nt === TYPE_W) nearW++;
            }
            events.onRefusal({ t: sys.t, kind: kind, i: i, q: q, dUjump: dU, nearS: nearS, nearW: nearW });
          }
          return false;
        }
      }
      kahanAdd(sys.H, q);
      sys.type[i] = newType;
      sumDUjump += dU;
      any = true;
      sys.reactionTotals[kind]++;
      if (events && events.onReaction) events.onReaction({ t: sys.t, kind: kind, i: i, q: q, dUjump: dU });
      return true;
    }

    // ① 光: W→F。Sun の蓄えが尽きていれば(freeArmでなければ)出ない。
    if (sys.sunPhotons > 0 || p.freeArm) {
      var lambda = p.Phi * p.dt;
      var nPhotons = poissonSample(rng, lambda);
      for (var ph = 0; ph < nPhotons; ph++) {
        if (sys.sunPhotons <= 0 && !p.freeArm) break;
        var wList = [];
        for (var wi = 0; wi < sys.N; wi++) if (sys.type[wi] === TYPE_W) wList.push(wi);
        if (wList.length === 0) break;
        var pick = wList[Math.floor(rng() * wList.length)];
        var paid = sys.sunPhotons > 0;
        var ok = payAndApply('light', pick, TYPE_W, 0, TYPE_F, 0, p.uW - p.uF, p.ePh);
        if (ok) {
          if (paid && !(p.leakMode === 'freephoto')) { sys.sunPhotons--; }
          else if (p.freeArm && !paid) { sys.unpaidWork += p.ePh; }
          else if (p.leakMode === 'freephoto') { sys.leakCounter += p.ePh; }
          sys.flow.sun += p.ePh;
        }
      }
    }

    // ② 崩壊: S→W(粒子ごと独立にベルヌーイ)。
    for (var si = 0; si < sys.N; si++) {
      if (sys.type[si] !== TYPE_S) continue;
      var rate = p.kDecayBase * (p.decayMode === 'thetaPCS' ? (1.5 - sys.theta[si]) : 1);
      var pDecay = 1 - Math.exp(-Math.max(0, rate) * p.dt);
      if (rng() < pDecay) {
        var epsOld = epsForParticle(sys, si, p);
        payAndApply('decay', si, TYPE_S, epsOld, TYPE_W, 0, p.uS - p.uW, 0);
      }
    }

    // ③ 触媒: F→S(rCat以内にS>=2個ある候補のみ。候補判定は本刻み開始時点のsCatalystCountを使う――
    // ΔU_jumpとqは反応の適用時にその時点の近傍で厳密に計算するので、候補判定の僅かな古さは
    // エネルギー会計の正しさに影響しない)。
    for (var fi = 0; fi < sys.N; fi++) {
      if (sys.type[fi] !== TYPE_F) continue;
      if (f2.sCatalystCount[fi] < 2) continue;
      var pCat = 1 - Math.exp(-p.kCat * p.dt);
      if (rng() < pCat) {
        var neigh = neighborsWithin(cl, sys, fi, p.rCat);
        var thetaSum = 0, thetaN = 0, catalystIdx = [];
        for (var n = 0; n < neigh.length; n++) {
          var jn = neigh[n][0];
          if (sys.type[jn] === TYPE_S) { thetaSum += sys.theta[jn]; thetaN++; catalystIdx.push(jn); }
        }
        if (thetaN < 2) continue; // 反応の適用時に再確認(近傍がこの刻み中に変わった稀なケース)
        var newTheta = thetaSum / thetaN + gaussian() * p.mutSigma;
        // [0,1] で反射
        var guard = 0;
        while ((newTheta < 0 || newTheta > 1) && guard < 20) {
          if (newTheta < 0) newTheta = -newTheta;
          if (newTheta > 1) newTheta = 2 - newTheta;
          guard++;
        }
        newTheta = Math.min(1, Math.max(0, newTheta));
        var newEps = p.epsMode === 'theta' ? (2 + newTheta) : p.epsS;
        var oldTheta = sys.theta[fi];
        var applied = payAndApply('catalysis', fi, TYPE_F, 0, TYPE_S, newEps, p.uF - p.uS, 0);
        if (applied) {
          sys.theta[fi] = newTheta;
          if (events && events.onBirth) {
            events.onBirth({ t: sys.t, i: fi, theta: newTheta, catalystMeanTheta: thetaSum / thetaN, catalystIdx: catalystIdx });
          }
        } else {
          sys.theta[fi] = oldTheta;
        }
      }
    }

    var closureResidual = null;
    if (any) {
      var f3 = computeForces(sys, p, cl);
      closureResidual = (f3.U - beforeU) - sumDUjump;
      sys._f = f3;
    }
    return { closureResidual: closureResidual, anyReaction: any };
  }

  // ================================================================ エクスポート

  return {
    TYPE_F: TYPE_F, TYPE_S: TYPE_S, TYPE_W: TYPE_W, RM: RM,
    makeRng: makeRng, subStream: subStream, hash32: hash32, gaussianFactory: gaussianFactory, poissonSample: poissonSample,
    makeKahan: makeKahan, kahanAdd: kahanAdd,
    defaultParams: defaultParams, epsForParticle: epsForParticle,
    createSystem: createSystem, wrapPos: wrapPos, wrapAll: wrapAll, minImageD: minImageD,
    randomSequentialFill: randomSequentialFill, maxwellVelocities: maxwellVelocities, initReplicate: initReplicate,
    coreVF: coreVF, wellShape: wellShape, wellShapeDeriv: wellShapeDeriv, pairCoef: pairCoef, pairVF: pairVF, numericF: numericF,
    buildCellList: buildCellList, forEachPairWithin: forEachPairWithin, neighborsWithin: neighborsWithin,
    computeForces: computeForces, computeForcesReference: computeForcesReference, deltaUJump: deltaUJump,
    kineticEnergy: kineticEnergy, totalMomentum: totalMomentum, typeCounts: typeCounts, chemTotal: chemTotal, sunEnergy: sunEnergy, eTot: eTot,
    halfKick: halfKick, halfDrift: halfDrift, applyBath: applyBath, stepSystem: stepSystem,
  };
});
