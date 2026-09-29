/**
 * S-56: 競合する2つの長さ（SALR）― 核（物理と、単一スナップショットの検出器）
 *
 * 1種類の粒子・2次元周期境界。対ポテンシャルは芯（WCA・柔らかい斥力）＋尾（二重指数の
 * 引力/斥力・IR 型の規格化）を五次の切り替えで滑らかに打ち切ったもの。力はその厳密な勾配。
 * velocity Verlet（シンプレクティック）で積分し、全エネルギー・全運動量を保存する。
 *
 * このファイルには「塊」より上の生物学的な語彙（cell/membrane/gene/organism/catalyst/
 * fitness/alive）を一切使わない。「塊（cluster）」は物理・コロイド系の語（SALR文献の用語）
 * であり、ここでは幾何の結合成分として定義する。時間方向の追跡（同一性・分裂・融合・
 * 緩和・エネルギー台帳の解析）は tracking.js（Node専用）に分離した——viewer.html は
 * このファイルの単一スナップショット検出器だけで足りる。
 *
 * 依存ゼロ。Node（run.js・selftest.js）とブラウザ（viewer.html）が同じファイルを読む。
 *
 * 出典: criteria.json の sources / sourceFidelity / borrowedConstants を見よ。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S56 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

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

  /** 32bit 整数のハッシュ（seed と枝番から独立した部分ストリームを作る）。 */
  function hash32(a, b) {
    var h = (a ^ 0x9e3779b9) >>> 0;
    h = Math.imul(h ^ b, 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }

  /** seed から独立した部分ストリームの乱数器を作る（streamId: 0=位置, 1=速度, ...）。 */
  function subStream(seed, streamId) {
    return makeRng(hash32(seed >>> 0, streamId >>> 0));
  }

  // ================================================================ 対ポテンシャル

  var SIGMA = 1, EPS_C = 1; // 単位系: σ=1, ε=1, m=1

  /**
   * 対ポテンシャルの構成。既定の打ち切り（rc=6*Rr, rs=rc-Rr。ただし epsR=0 なら
   * rc=6*Ra, rs=rc-Ra ― NC1・NC2 用）は明示指定が無い時だけ自動で埋める。
   * mode: 'smooth'（既定・五次切り替え）/ 'raw'（打ち切りで不連続）/ 'shift'（値だけ連続）。
   */
  function buildPotential(opt) {
    var Ra = opt.Ra, Rr = opt.Rr, epsA = opt.epsA, epsR = opt.epsR;
    var sigmaC = Math.pow(2, -1 / 6) * SIGMA;
    var rCoreCut = Math.pow(2, 1 / 6) * sigmaC; // = SIGMA
    var scaleForRc = epsR === 0 ? Ra : Rr;
    var rc = opt.rc != null ? opt.rc : 6 * scaleForRc;
    var rs = opt.rs != null ? opt.rs : rc - scaleForRc;
    var mode = opt.mode || 'smooth';
    var pot = {
      Ra: Ra, Rr: Rr, epsA: epsA, epsR: epsR, sigmaC: sigmaC, rCoreCut: rCoreCut,
      rc: rc, rs: rs, mode: mode, rc2: rc * rc,
    };
    if (mode === 'shift') pot.vAtRc = baseVF(rc, pot).V;
    return pot;
  }

  /** 芯 + 尾（切り替えを掛ける「前」の値）。r=0 でも有限。 */
  function baseVF(r, p) {
    var vCore = 0, fCore = 0;
    if (r < p.rCoreCut) {
      var sr6 = Math.pow(p.sigmaC / r, 6), sr12 = sr6 * sr6;
      vCore = 4 * EPS_C * (sr12 - sr6) + EPS_C;
      fCore = 4 * EPS_C * (12 * sr12 - 6 * sr6) / r; // = -d(vCore)/dr
    }
    var ea = p.epsA * SIGMA * SIGMA / (p.Ra * p.Ra);
    var er = p.epsR * SIGMA * SIGMA / (p.Rr * p.Rr);
    var eA = Math.exp(-r / p.Ra), eR = Math.exp(-r / p.Rr);
    var vTail = -ea * eA + er * eR;
    var fTail = -(ea / p.Ra) * eA + (er / p.Rr) * eR; // = -d(vTail)/dr... see below
    // dVtail/dr = ea/Ra * eA - er/Rr * eR  =>  fTail(=-dV/dr) = -ea/Ra*eA + er/Rr*eR
    return { V: vCore + vTail, F: fCore + fTail };
  }

  /** 五次の切り替え関数と導関数（dS/dr）。 */
  function switchFn(r, p) {
    if (r <= p.rs) return { S: 1, dS: 0 };
    if (r >= p.rc) return { S: 0, dS: 0 };
    var x = (r - p.rs) / (p.rc - p.rs);
    var S = 1 - 10 * x * x * x + 15 * x * x * x * x - 6 * x * x * x * x * x;
    var dSdx = -30 * x * x * (1 - x) * (1 - x);
    return { S: S, dS: dSdx / (p.rc - p.rs) };
  }

  /**
   * V(r) と F(r) = -dV/dr。mode='smooth' は switch を掛けた解析的な厳密勾配、
   * 'raw' は rc で単純に打ち切り（値も力も不連続）、'shift' は V(r)-V(rc) で値だけ連続。
   */
  function pairVF(r, p) {
    if (r >= p.rc) return { V: 0, F: 0 };
    var base = baseVF(r, p);
    if (p.mode === 'raw') return { V: base.V, F: base.F };
    if (p.mode === 'shift') return { V: base.V - p.vAtRc, F: base.F };
    var sw = switchFn(r, p);
    // V = base.V * S ; dV/dr = dbase/dr * S + base.V * dS/dr = -base.F*S + base.V*dS
    // F = -dV/dr = base.F*S - base.V*dS
    return { V: base.V * sw.S, F: base.F * sw.S - base.V * sw.dS };
  }

  /** 数値微分（中心差分）。selftest の勾配検査に使う。 */
  function numericF(r, p, h) {
    h = h || 1e-5 * Math.max(r, 1);
    var vp = pairVF(r + h, p).V, vm = pairVF(r - h, p).V;
    return -(vp - vm) / (2 * h);
  }

  // ================================================================ 系（状態）

  function createSystem(N, L) {
    return { N: N, L: L, x: new Float64Array(N), y: new Float64Array(N), vx: new Float64Array(N), vy: new Float64Array(N) };
  }

  function wrapPos(v, L) { v = v % L; if (v < 0) v += L; return v; }

  function wrapAll(sys) {
    for (var i = 0; i < sys.N; i++) { sys.x[i] = wrapPos(sys.x[i], sys.L); sys.y[i] = wrapPos(sys.y[i], sys.L); }
  }

  /** 最近接鏡像の変位（成分ごと）。呼び出し側が rc < L/2 を保証すること。 */
  function minImageD(dx, L) {
    if (dx > L / 2) dx -= L; else if (dx < -L / 2) dx += L;
    return dx;
  }

  // ---------------------------------------------------------------- 力
  // 打ち切り rc が L/2 に近い（大きい Rr の主格子で L/2=25, rc=15）ため、
  // 格子分割の恩恵は薄い。正しさを優先し、rc 以内かを判定するだけの素朴な全対探索にする。

  /**
   * 通常（相反的）の力とエネルギー。ホットループなので pairVF() を呼ばず展開する
   * （オブジェクト割り当てを避け、N〜1750・8万ステップ級の走行を現実的な時間に収める）。
   */
  function computeForces(sys, pot) {
    var N = sys.N, L = sys.L, x = sys.x, y = sys.y, halfL = L / 2;
    var fx = new Float64Array(N), fy = new Float64Array(N);
    var U = 0, rc2 = pot.rc2;
    var sigmaC = pot.sigmaC, rCoreCut = pot.rCoreCut;
    var invRa = 1 / pot.Ra, invRr = 1 / pot.Rr;
    var ea = pot.epsA * SIGMA * SIGMA / (pot.Ra * pot.Ra), er = pot.epsR * SIGMA * SIGMA / (pot.Rr * pot.Rr);
    var mode = pot.mode, rs = pot.rs, invSwitchRange = 1 / (pot.rc - pot.rs), vAtRc = pot.vAtRc || 0;
    for (var i = 0; i < N; i++) {
      var xi = x[i], yi = y[i];
      for (var j = i + 1; j < N; j++) {
        var dx = xi - x[j], dy = yi - y[j];
        if (dx > halfL) dx -= L; else if (dx < -halfL) dx += L;
        if (dy > halfL) dy -= L; else if (dy < -halfL) dy += L;
        var r2 = dx * dx + dy * dy;
        if (r2 >= rc2 || r2 < 1e-12) continue;
        var r = Math.sqrt(r2);
        var vCore = 0, fCore = 0;
        if (r < rCoreCut) {
          var s2 = sigmaC / r; s2 = s2 * s2; var sr6 = s2 * s2 * s2, sr12 = sr6 * sr6;
          vCore = 4 * EPS_C * (sr12 - sr6) + EPS_C;
          fCore = 4 * EPS_C * (12 * sr12 - 6 * sr6) / r;
        }
        var eA = Math.exp(-r * invRa), eR = Math.exp(-r * invRr);
        var vTail = -ea * eA + er * eR;
        var fTail = -(ea * invRa) * eA + (er * invRr) * eR;
        var V, F;
        if (mode === 'raw') { V = vCore + vTail; F = fCore + fTail; }
        else if (mode === 'shift') { V = vCore + vTail - vAtRc; F = fCore + fTail; }
        else {
          var S = 1, dS = 0;
          if (r > rs) {
            var xw = (r - rs) * invSwitchRange, xw2 = xw * xw;
            S = 1 - 10 * xw * xw2 + 15 * xw2 * xw2 - 6 * xw2 * xw2 * xw;
            dS = (-30 * xw2 * (1 - xw) * (1 - xw)) * invSwitchRange;
          }
          var base = vCore + vTail, baseF = fCore + fTail;
          V = base * S; F = baseF * S - base * dS;
        }
        U += V;
        var fr = F / r, fxp = fr * dx, fyp = fr * dy;
        fx[i] += fxp; fy[i] += fyp;
        fx[j] -= fxp; fy[j] -= fyp;
      }
    }
    return { fx: fx, fy: fy, U: U };
  }

  // Verlet 近傍リスト（production性能の最適化）は neighbors.js（Node専用）に分離した
  // ――core.js を800行以内に保つためと、ブラウザ側(viewer.html)はNが小さくこの最適化を
  // 必要としないため。computeForces() と数式は完全に同一（力の値は変えない）。

  /** computeForces() の展開版と突き合わせるための、遅いが素直な参照実装（selftest 専用）。 */
  function computeForcesReference(sys, pot) {
    var N = sys.N, L = sys.L, x = sys.x, y = sys.y;
    var fx = new Float64Array(N), fy = new Float64Array(N);
    var U = 0, rc2 = pot.rc2;
    for (var i = 0; i < N; i++) {
      for (var j = i + 1; j < N; j++) {
        var dx = minImageD(x[i] - x[j], L), dy = minImageD(y[i] - y[j], L);
        var r2 = dx * dx + dy * dy;
        if (r2 >= rc2 || r2 < 1e-12) continue;
        var r = Math.sqrt(r2);
        var vf = pairVF(r, pot);
        U += vf.V;
        var fr = vf.F / r, fxp = fr * dx, fyp = fr * dy;
        fx[i] += fxp; fy[i] += fyp;
        fx[j] -= fxp; fy[j] -= fyp;
      }
    }
    return { fx: fx, fy: fy, U: U };
  }

  /**
   * 非相反な較正腕（E-nonrec）専用: 奇数番→偶数番の向きにだけ尾の斥力(epsR項)を掛ける
   * （偶数番は奇数番から押されるが、奇数番は偶数番から押されない）。芯と引力は相反のまま。
   * エネルギー U はこの非相反な系では「保存されるべき量」の意味を失うが、参考として
   * 相反成分＋非相反成分を対称に足した合計を返す（診断用途のみ）。
   */
  function computeForcesNonrecip(sys, pot) {
    var N = sys.N, L = sys.L, x = sys.x, y = sys.y;
    var fx = new Float64Array(N), fy = new Float64Array(N);
    var U = 0, rc2 = pot.rc2;
    var potNoR = buildPotential({ Ra: pot.Ra, Rr: pot.Rr, epsA: pot.epsA, epsR: 0, rc: pot.rc, rs: pot.rs, mode: pot.mode });
    var potROnly = buildPotential({ Ra: pot.Ra, Rr: pot.Rr, epsA: 0, epsR: pot.epsR, rc: pot.rc, rs: pot.rs, mode: pot.mode });
    for (var i = 0; i < N; i++) {
      for (var j = i + 1; j < N; j++) {
        var dx = minImageD(x[i] - x[j], L), dy = minImageD(y[i] - y[j], L);
        var r2 = dx * dx + dy * dy;
        if (r2 >= rc2 || r2 < 1e-12) continue;
        var r = Math.sqrt(r2);
        var vfRecip = pairVF(r, potNoR); // 芯+引力（相反）
        U += vfRecip.V;
        var frRecip = vfRecip.F / r;
        fx[i] += frRecip * dx; fy[i] += frRecip * dy;
        fx[j] -= frRecip * dx; fy[j] -= frRecip * dy;
        var vfR = pairVF(r, potROnly); // 斥力の尾だけ
        U += vfR.V;
        var frR = vfR.F / r;
        var iOdd = (i % 2) === 1, jOdd = (j % 2) === 1;
        // 奇数番 i が偶数番 j を押す: j が力を受ける。逆(j が奇数, i が偶数)も同様。
        if (iOdd && !jOdd) { fx[j] -= frR * dx; fy[j] -= frR * dy; }
        else if (jOdd && !iOdd) { fx[i] += frR * dx; fy[i] += frR * dy; }
        else { fx[i] += frR * dx; fy[i] += frR * dy; fx[j] -= frR * dx; fy[j] -= frR * dy; }
      }
    }
    return { fx: fx, fy: fy, U: U };
  }

  // ---------------------------------------------------------------- 積分器

  function velocityVerletStep(sys, pot, dt, forceFn) {
    forceFn = forceFn || computeForces;
    if (!sys._f) sys._f = forceFn(sys, pot);
    var N = sys.N, f = sys._f;
    for (var i = 0; i < N; i++) {
      sys.vx[i] += 0.5 * dt * f.fx[i];
      sys.vy[i] += 0.5 * dt * f.fy[i];
      sys.x[i] += dt * sys.vx[i];
      sys.y[i] += dt * sys.vy[i];
    }
    wrapAll(sys);
    var f2 = forceFn(sys, pot);
    for (i = 0; i < N; i++) {
      sys.vx[i] += 0.5 * dt * f2.fx[i];
      sys.vy[i] += 0.5 * dt * f2.fy[i];
    }
    sys._f = f2;
    return f2.U;
  }

  /** 陽的 Euler（PC-E の E-euler 専用の較正腕）。 */
  function eulerStep(sys, pot, dt, forceFn) {
    forceFn = forceFn || computeForces;
    var f = forceFn(sys, pot);
    var N = sys.N;
    for (var i = 0; i < N; i++) {
      sys.x[i] += dt * sys.vx[i];
      sys.y[i] += dt * sys.vy[i];
      sys.vx[i] += dt * f.fx[i];
      sys.vy[i] += dt * f.fy[i];
    }
    wrapAll(sys);
    sys._f = null;
    return f.U;
  }

  function kineticEnergy(sys) {
    var K = 0;
    for (var i = 0; i < sys.N; i++) K += 0.5 * (sys.vx[i] * sys.vx[i] + sys.vy[i] * sys.vy[i]);
    return K;
  }

  /** 2次元の等分配: K = N·T (k_B=1・質量1・2自由度)。 */
  function instTemperature(sys) { return kineticEnergy(sys) / sys.N; }

  function totalMomentum(sys) {
    var px = 0, py = 0;
    for (var i = 0; i < sys.N; i++) { px += sys.vx[i]; py += sys.vy[i]; }
    return { px: px, py: py };
  }

  function zeroMomentum(sys) {
    var p = totalMomentum(sys);
    var dvx = p.px / sys.N, dvy = p.py / sys.N;
    for (var i = 0; i < sys.N; i++) { sys.vx[i] -= dvx; sys.vy[i] -= dvy; }
  }

  /** 熱浴（速度の縮尺）。作動したら true を返す。 */
  function thermostatRescale(sys, Ttarget) {
    var Tinst = instTemperature(sys);
    if (Tinst < 1e-12) return false;
    var s = Math.sqrt(Ttarget / Tinst);
    for (var i = 0; i < sys.N; i++) { sys.vx[i] *= s; sys.vy[i] *= s; }
    return true;
  }

  // ================================================================ 初期配置

  /** 逐次無作為付加（最小間隔 minDist）。10^6 回失敗したら揺らした三角格子へ切り替える。 */
  function randomSequentialFill(N, L, minDist, rng) {
    var x = new Float64Array(N), y = new Float64Array(N);
    var placed = 0, attempts = 0, maxAttempts = 1e6;
    while (placed < N && attempts < maxAttempts) {
      attempts++;
      var cx = rng() * L, cy = rng() * L, ok = true;
      for (var k = 0; k < placed; k++) {
        var dx = minImageD(cx - x[k], L), dy = minImageD(cy - y[k], L);
        if (dx * dx + dy * dy < minDist * minDist) { ok = false; break; }
      }
      if (ok) { x[placed] = cx; y[placed] = cy; placed++; }
    }
    var fellBack = placed < N;
    if (fellBack) {
      var lat = jitteredTriangularFill(N, L, minDist, rng);
      x = lat.x; y = lat.y;
    }
    return { x: x, y: y, fellBackToLattice: fellBack };
  }

  /** 三角格子で箱を埋め、微小に揺らす（フォールバック）。 */
  function jitteredTriangularFill(N, L, spacing, rng) {
    var x = new Float64Array(N), y = new Float64Array(N);
    var rowH = spacing * Math.sqrt(3) / 2;
    var nRows = Math.ceil(L / rowH), n = 0;
    for (var r = 0; r < nRows && n < N; r++) {
      var offset = (r % 2) * spacing / 2;
      var nCols = Math.ceil(L / spacing);
      for (var c = 0; c < nCols && n < N; c++) {
        x[n] = wrapPos(offset + c * spacing + (rng() - 0.5) * spacing * 0.05, L);
        y[n] = wrapPos(r * rowH + (rng() - 0.5) * spacing * 0.05, L);
        n++;
      }
    }
    return { x: x, y: y };
  }

  /** 原点に最も近い n 点からなる六方円盤（間隔 spacing）。中心を (0,0) とする局所座標。 */
  function hexagonalBlob(n, spacing) {
    var rowH = spacing * Math.sqrt(3) / 2;
    var pts = [], R = Math.ceil(Math.sqrt(n)) + 3;
    for (var r = -R; r <= R; r++) {
      var offset = ((r % 2) + 2) % 2 * spacing / 2;
      for (var c = -R; c <= R; c++) {
        var px = offset + c * spacing, py = r * rowH;
        pts.push([px, py, px * px + py * py]);
      }
    }
    pts.sort(function (a, b) { return a[2] - b[2]; });
    var out = pts.slice(0, n);
    return { x: Float64Array.from(out.map(function (p) { return p[0]; })), y: Float64Array.from(out.map(function (p) { return p[1]; })) };
  }

  /** Maxwell 速度分布（Box-Muller）。全運動量を 0 へ差し引く。 */
  function maxwellVelocities(N, T, rng) {
    var vx = new Float64Array(N), vy = new Float64Array(N), sigma = Math.sqrt(T);
    for (var i = 0; i < N; i++) {
      var u1 = Math.max(rng(), 1e-12), u2 = rng();
      var mag = sigma * Math.sqrt(-2 * Math.log(u1));
      vx[i] = mag * Math.cos(2 * Math.PI * u2);
      var u3 = Math.max(rng(), 1e-12), u4 = rng();
      var mag2 = sigma * Math.sqrt(-2 * Math.log(u3));
      vy[i] = mag2 * Math.sin(2 * Math.PI * u4);
    }
    var px = 0, py = 0;
    for (i = 0; i < N; i++) { px += vx[i]; py += vy[i]; }
    var dvx = px / N, dvy = py / N;
    for (i = 0; i < N; i++) { vx[i] -= dvx; vy[i] -= dvy; }
    return { vx: vx, vy: vy };
  }

  // ================================================================ 塊（結合成分）の検出

  /**
   * r < rb の対を結んだグラフの連結成分。周期境界込み。n>=nMin だけ「塊」として返す
   * （小さい成分も membership 配列には残る＝分母は常に N）。
   * 各塊に回り込みの階数（0/1/2）と展開済み（unwrapped）座標を付ける。
   */
  function findClusters(sys, rb, nMin) {
    var N = sys.N, L = sys.L, x = sys.x, y = sys.y, rb2 = rb * rb;
    var adj = [];
    for (var i = 0; i < N; i++) adj.push([]);
    for (i = 0; i < N; i++) {
      for (var j = i + 1; j < N; j++) {
        var dx = minImageD(x[i] - x[j], L), dy = minImageD(y[i] - y[j], L);
        if (dx * dx + dy * dy < rb2) { adj[i].push([j, dx, dy]); adj[j].push([i, -dx, -dy]); }
      }
    }
    var visited = new Int8Array(N), membership = new Int32Array(N).fill(-1);
    var clusters = [];
    for (i = 0; i < N; i++) {
      if (visited[i]) continue;
      var members = [i], ux = new Map([[i, [0, 0]]]);
      visited[i] = 1;
      var windingVecs = [];
      var queue = [i], qi = 0;
      while (qi < queue.length) {
        var u = queue[qi++]; var u0 = ux.get(u);
        for (var k = 0; k < adj[u].length; k++) {
          var e = adj[u][k], v = e[0];
          var propose = [u0[0] + e[1], u0[1] + e[2]];
          if (!visited[v]) {
            visited[v] = 1; ux.set(v, propose); members.push(v); queue.push(v);
          } else {
            var existing = ux.get(v);
            var disc = [propose[0] - existing[0], propose[1] - existing[1]];
            if (disc[0] * disc[0] + disc[1] * disc[1] > 1e-6) windingVecs.push(disc);
          }
        }
      }
      var rank = windingRank(windingVecs, L);
      var clusterId = clusters.length;
      for (k = 0; k < members.length; k++) membership[members[k]] = clusterId;
      clusters.push({ id: clusterId, members: members, size: members.length, wrapRank: rank, unwrapped: ux, qualifies: members.length >= nMin });
    }
    return { clusters: clusters, membership: membership };
  }

  /** discrepancy ベクトル群が張る格子の階数（0/1/2）。ベクトルは L の整数倍にほぼ近いはず。 */
  function windingRank(vecs, L) {
    if (vecs.length === 0) return 0;
    var first = null;
    for (var i = 0; i < vecs.length; i++) {
      var v = vecs[i];
      if (Math.sqrt(v[0] * v[0] + v[1] * v[1]) < 0.3 * L) continue; // 丸め誤差ノイズ除去
      if (!first) { first = v; continue; }
      var cross = first[0] * v[1] - first[1] * v[0];
      if (Math.abs(cross) > 0.3 * L * L) return 2;
    }
    return first ? 1 : 0;
  }

  /** 塊の非相反度 A = (λ1-λ2)/(λ1+λ2)（unwrapped 座標の慣性テンソル）。回り込む塊(rank>=1)には定義しない。 */
  function asphericity(cluster) {
    if (cluster.wrapRank >= 1 || cluster.members.length < 2) return null;
    var members = cluster.members, ux = cluster.unwrapped, n = members.length;
    var cx = 0, cy = 0;
    for (var i = 0; i < n; i++) { var p = ux.get(members[i]); cx += p[0]; cy += p[1]; }
    cx /= n; cy /= n;
    var Ixx = 0, Iyy = 0, Ixy = 0;
    for (i = 0; i < n; i++) {
      var p2 = ux.get(members[i]), dx = p2[0] - cx, dy = p2[1] - cy;
      Ixx += dy * dy; Iyy += dx * dx; Ixy -= dx * dy;
    }
    Ixx /= n; Iyy /= n; Ixy /= n;
    var tr = Ixx + Iyy, det = Ixx * Iyy - Ixy * Ixy;
    var disc = Math.max(0, tr * tr / 4 - det);
    var l1 = tr / 2 + Math.sqrt(disc), l2 = tr / 2 - Math.sqrt(disc);
    if (l1 + l2 < 1e-12) return 0;
    return Math.abs(l1 - l2) / (l1 + l2);
  }

  // ================================================================ 構造因子 S(k)

  /**
   * S(k) = |Σ exp(i k·r)|²/N。許される k = (2π/L)(nx,ny)、0<|k|<=kMax。殻幅 2π/L で殻平均。
   */
  function structureFactor(sys, kMax) {
    var N = sys.N, L = sys.L, x = sys.x, y = sys.y, dk = 2 * Math.PI / L;
    var nMax = Math.ceil(kMax / dk);
    var shellW = dk, nShells = Math.ceil(kMax / shellW);
    var shellSum = new Float64Array(nShells + 1), shellCount = new Int32Array(nShells + 1);
    var points = []; // { kx, ky, kMag, S }
    for (var nx = -nMax; nx <= nMax; nx++) {
      for (var ny = -nMax; ny <= nMax; ny++) {
        if (nx === 0 && ny === 0) continue;
        var kx = nx * dk, ky = ny * dk, kMag = Math.sqrt(kx * kx + ky * ky);
        if (kMag > kMax || kMag < 1e-9) continue;
        var re = 0, im = 0;
        for (var i = 0; i < N; i++) { var ph = kx * x[i] + ky * y[i]; re += Math.cos(ph); im += Math.sin(ph); }
        var S = (re * re + im * im) / N;
        var shell = Math.min(nShells, Math.floor(kMag / shellW));
        shellSum[shell] += S; shellCount[shell]++;
        points.push({ kx: kx, ky: ky, kMag: kMag, S: S });
      }
    }
    var shells = [];
    for (var s = 0; s <= nShells; s++) {
      if (shellCount[s] === 0) continue;
      shells.push({ shellIndex: s, kMag: (s + 0.5) * shellW, Save: shellSum[s] / shellCount[s], count: shellCount[s] });
    }
    var peak = null;
    for (s = 0; s < shells.length; s++) if (!peak || shells[s].Save > peak.Save) peak = shells[s];
    return { shells: shells, points: points, peak: peak, dk: dk };
  }

  // ================================================================ 形態（粗視化格子）

  /**
   * 1σ 格子へ粒子数を数え、幅1σのガウスで平滑化。ρ_thr 以上を「濃い」とする。
   * 濃い相・薄い相それぞれの連結成分（4近傍・周期境界・5セル未満は捨てる）と、
   * 各成分の回り込みの階数・粒子重みの平均asphericity Aを返す。
   */
  function morphologyGrid(sys, opt) {
    var L = sys.L, cell = 1, nG = Math.round(L / cell);
    var counts = new Float64Array(nG * nG);
    for (var i = 0; i < sys.N; i++) {
      var gx = Math.min(nG - 1, Math.floor(sys.x[i] / cell)), gy = Math.min(nG - 1, Math.floor(sys.y[i] / cell));
      counts[gy * nG + gx]++;
    }
    var smoothed = gaussianBlurPeriodic(counts, nG, 1);
    var thr = opt.rhoThr;
    var dense = new Uint8Array(nG * nG);
    for (i = 0; i < nG * nG; i++) dense[i] = smoothed[i] >= thr ? 1 : 0;
    var denseComp = gridComponents(dense, nG, 1, opt.minCells || 5);
    var dilute = new Uint8Array(nG * nG);
    for (i = 0; i < nG * nG; i++) dilute[i] = smoothed[i] < thr ? 1 : 0;
    var diluteComp = gridComponents(dilute, nG, 1, opt.minCells || 5);
    var denseFrac = 0; for (i = 0; i < nG * nG; i++) denseFrac += dense[i]; denseFrac /= (nG * nG);
    return { nG: nG, cell: cell, smoothed: smoothed, dense: denseComp, dilute: diluteComp, denseFraction: denseFrac };
  }

  function gaussianBlurPeriodic(field, n, sigma) {
    var radius = Math.ceil(3 * sigma), kernel = [];
    var sum = 0;
    for (var k = -radius; k <= radius; k++) { var w = Math.exp(-(k * k) / (2 * sigma * sigma)); kernel.push(w); sum += w; }
    for (k = 0; k < kernel.length; k++) kernel[k] /= sum;
    var tmp = new Float64Array(n * n), out = new Float64Array(n * n);
    for (var y = 0; y < n; y++) for (var x = 0; x < n; x++) {
      var acc = 0;
      for (k = -radius; k <= radius; k++) { var xx = ((x + k) % n + n) % n; acc += field[y * n + xx] * kernel[k + radius]; }
      tmp[y * n + x] = acc;
    }
    for (y = 0; y < n; y++) for (x = 0; x < n; x++) {
      acc = 0;
      for (k = -radius; k <= radius; k++) { var yy = ((y + k) % n + n) % n; acc += tmp[yy * n + x] * kernel[k + radius]; }
      out[y * n + x] = acc;
    }
    return out;
  }

  /** 二値格子（周期境界・4近傍）の連結成分。各成分の回り込みの階数と cell 数を返す。 */
  function gridComponents(mask, n, cellSize, minCells) {
    var visited = new Uint8Array(n * n), comps = [];
    for (var idx0 = 0; idx0 < n * n; idx0++) {
      if (!mask[idx0] || visited[idx0]) continue;
      var sy0 = Math.floor(idx0 / n), sx0 = idx0 % n;
      var cells = [[sx0, sy0]], ux = new Map([[idx0, [0, 0]]]);
      visited[idx0] = 1;
      var windingVecs = [], queue = [idx0], qi = 0;
      while (qi < queue.length) {
        var u = queue[qi++]; var ux0 = ux.get(u), cx = u % n, cy = Math.floor(u / n);
        var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
        for (var d = 0; d < 4; d++) {
          var nx2 = cx + dirs[d][0], ny2 = cy + dirs[d][1];
          var wrapDx = 0, wrapDy = 0;
          var wnx = nx2, wny = ny2;
          if (wnx < 0) { wnx += n; wrapDx = -n; } else if (wnx >= n) { wnx -= n; wrapDx = n; }
          if (wny < 0) { wny += n; wrapDy = -n; } else if (wny >= n) { wny -= n; wrapDy = n; }
          if (!mask[wny * n + wnx]) continue;
          var v = wny * n + wnx;
          var propose = [ux0[0] + dirs[d][0] * cellSize + wrapDx * cellSize, ux0[1] + dirs[d][1] * cellSize + wrapDy * cellSize];
          if (!visited[v]) { visited[v] = 1; ux.set(v, propose); cells.push([wnx, wny]); queue.push(v); }
          else {
            var existing = ux.get(v);
            var disc = [propose[0] - existing[0], propose[1] - existing[1]];
            if (disc[0] * disc[0] + disc[1] * disc[1] > 1e-6) windingVecs.push(disc);
          }
        }
      }
      if (cells.length < minCells) continue;
      comps.push({ cells: cells, size: cells.length, wrapRank: windingRank(windingVecs, n * cellSize) });
    }
    return comps;
  }

  /** 形態の型 G/U/D/M/C/E/S/B/L/X を observerDetails.morphologyClasses の順で判定する。 */
  function classifyMorphology(mg, avgDenseA, avgDiluteA) {
    var denseFrac = mg.denseFraction, diluteFrac = 1 - denseFrac;
    if (denseFrac < 0.03) return { type: 'G', reason: '濃い面積<3%' };
    if (diluteFrac < 0.03) return { type: 'U', reason: '薄い面積<3%' };
    var denseN = mg.dense.length, diluteN = mg.dilute.length;
    var denseRank0 = mg.dense.every(function (c) { return c.wrapRank === 0; });
    var denseRank1 = mg.dense.filter(function (c) { return c.wrapRank === 1; }).length;
    var diluteRank1 = mg.dilute.filter(function (c) { return c.wrapRank === 1; }).length;
    var denseRank2 = mg.dense.filter(function (c) { return c.wrapRank === 2; }).length;
    if (denseN === 1 && mg.dense[0].wrapRank === 0) return { type: 'D', reason: '濃い成分1つ・階数0' };
    if (denseN === 1 && denseRank1 === 1 && diluteN === 1 && diluteRank1 === 1) return { type: 'M', reason: '箱を横切るスラブ' };
    if (denseN >= 2 && denseRank0 && avgDenseA != null && avgDenseA < 0.5) return { type: 'C', reason: '濃い成分>=2・階数0・A平均<0.5' };
    if (denseN >= 2 && denseRank0 && avgDenseA != null && avgDenseA >= 0.5) return { type: 'E', reason: '濃い成分>=2・階数0・A平均>=0.5' };
    if (denseRank1 >= 2 && diluteRank1 >= 2 && denseRank2 === 0) return { type: 'S', reason: '階数1の濃い/薄い成分>=2' };
    if (denseRank2 >= 1) {
      var diluteAllRank0 = mg.dilute.every(function (c) { return c.wrapRank === 0; });
      if (diluteAllRank0 && diluteN >= 2 && avgDiluteA != null && avgDiluteA < 0.5) return { type: 'B', reason: '階数2の濃い成分・薄い成分は階数0が2個以上・穴A平均<0.5' };
      return { type: 'L', reason: '階数2の濃い成分があり薄い成分に階数>=1、または穴A平均>=0.5' };
    }
    return {
      type: 'X', reason: '混在', detail: {
        denseComponents: denseN, diluteComponents: diluteN, denseRank0: denseRank0,
        denseRank1: denseRank1, diluteRank1: diluteRank1, denseRank2: denseRank2,
      },
    };
  }

  // ================================================================ 静的な事前計算（S1 の staticPrecomputation を独立に再計算）

  /** Bessel J0（Abramowitz–Stegun 9.4 の多項式近似。|誤差|<1.6e-8 程度）。 */
  function besselJ0(x) {
    x = Math.abs(x);
    if (x < 3) {
      var y = (x / 3) * (x / 3);
      return 1 - 2.2499997 * y + 1.2656208 * y * y - 0.3163866 * y * y * y
        + 0.0444479 * Math.pow(y, 4) - 0.0039444 * Math.pow(y, 5) + 0.00021 * Math.pow(y, 6);
    }
    var z = 3 / x;
    var f0 = 0.79788456 - 0.00000077 * z - 0.00552740 * z * z - 0.00009512 * Math.pow(z, 3)
      + 0.00137237 * Math.pow(z, 4) - 0.00072805 * Math.pow(z, 5) + 0.00014476 * Math.pow(z, 6);
    var theta0 = x - 0.78539816 - 0.04166397 * z - 0.00003954 * z * z + 0.00262573 * Math.pow(z, 3)
      - 0.00054125 * Math.pow(z, 4) - 0.00029333 * Math.pow(z, 5) + 0.00013558 * Math.pow(z, 6);
    return f0 / Math.sqrt(x) * Math.cos(theta0);
  }

  /**
   * V̂(k) = 2π∫ w(r) J0(kr) r dr。w(r) = 切り替えを掛けた V_tail（芯の内側 r<σ は w(σ) で埋める）。
   * シンプソン法で数値積分する。rMax は既定で pot.rc。
   */
  function tailFourier(k, pot, rMax, steps) {
    rMax = rMax || pot.rc; steps = steps || 4000;
    if (steps % 2 === 1) steps++;
    var h = rMax / steps, sum = 0;
    var wAtSigma = tailValueAt(SIGMA, pot);
    for (var i = 0; i <= steps; i++) {
      var r = i * h;
      var w = r < SIGMA ? wAtSigma : tailValueAt(r, pot);
      var integrand = w * besselJ0(k * r) * r;
      var coef = (i === 0 || i === steps) ? 1 : (i % 2 === 1 ? 4 : 2);
      sum += coef * integrand;
    }
    return 2 * Math.PI * (h / 3) * sum;
  }

  /** 切り替えを掛けた V_tail(r)（芯を含まない）。 */
  function tailValueAt(r, pot) {
    if (r >= pot.rc) return 0;
    var ea = pot.epsA * SIGMA * SIGMA / (pot.Ra * pot.Ra);
    var er = pot.epsR * SIGMA * SIGMA / (pot.Rr * pot.Rr);
    var vTail = -ea * Math.exp(-r / pot.Ra) + er * Math.exp(-r / pot.Rr);
    if (pot.mode !== 'smooth') return vTail;
    return vTail * switchFn(r, pot).S;
  }

  /** 尾の V̂(k) の最小を与える k* から λ* = 2π/k*。k は kStep 刻みで [kMin,kMax] を走査。 */
  function findLambdaStar(pot, kMin, kMax, kStep) {
    kMin = kMin || 0.02; kMax = kMax || 3.0; kStep = kStep || 0.01;
    var best = null;
    for (var k = kMin; k <= kMax; k += kStep) {
      var vhat = tailFourier(k, pot);
      if (!best || vhat < best.vhat) best = { k: k, vhat: vhat };
    }
    return { kStar: best.k, vhatAtKstar: best.vhat, lambdaStar: 2 * Math.PI / best.k };
  }

  function vhatZero(pot) { return tailFourier(1e-6, pot); }

  /** |V_tail(σ)|（芯を含まない尾だけの値。切り替えは r=σ << rc なので S=1）。 */
  function vTailAtSigma(pot) {
    var ea = pot.epsA * SIGMA * SIGMA / (pot.Ra * pot.Ra);
    var er = pot.epsR * SIGMA * SIGMA / (pot.Rr * pot.Rr);
    return -ea * Math.exp(-SIGMA / pot.Ra) + er * Math.exp(-SIGMA / pot.Rr);
  }

  /**
   * T=0 の理想六方配置における最適な塊の大きさ n*。間隔 a を [0.94,1.04]σ で粗く走査し、
   * 1粒子あたりエネルギー e(n)（六方円盤・n 点）を最小化する n を nMin..nMax で探す。
   */
  function optimalClusterSize(pot, nMin, nMax) {
    nMin = nMin || 2; nMax = nMax || 80;
    var bestOverall = null;
    var aGrid = [0.94, 0.96, 0.98, 1.0, 1.02, 1.04];
    var energies = [];
    for (var n = nMin; n <= nMax; n++) {
      var bestForN = null;
      for (var ai = 0; ai < aGrid.length; ai++) {
        var blob = hexagonalBlob(n, aGrid[ai] * SIGMA);
        var e = pairEnergySum(blob.x, blob.y, pot) / n;
        if (!bestForN || e < bestForN) bestForN = e;
      }
      energies.push({ n: n, e: bestForN });
      if (!bestOverall || bestForN < bestOverall.e) bestOverall = { n: n, e: bestForN };
    }
    return { nStar: bestOverall.n, eStar: bestOverall.e, curve: energies };
  }

  /** 小さな有限集合（周期境界なし）の対エネルギー合計。 */
  function pairEnergySum(x, y, pot) {
    var n = x.length, U = 0;
    for (var i = 0; i < n; i++) for (var j = i + 1; j < n; j++) {
      var dx = x[i] - x[j], dy = y[i] - y[j], r = Math.sqrt(dx * dx + dy * dy);
      if (r < pot.rc) U += pairVF(r, pot).V;
    }
    return U;
  }

  // ================================================================ エクスポート

  return {
    makeRng: makeRng, subStream: subStream, hash32: hash32,
    buildPotential: buildPotential, pairVF: pairVF, baseVF: baseVF, switchFn: switchFn, numericF: numericF,
    createSystem: createSystem, wrapPos: wrapPos, wrapAll: wrapAll, minImageD: minImageD,
    computeForces: computeForces, computeForcesReference: computeForcesReference, computeForcesNonrecip: computeForcesNonrecip,
    velocityVerletStep: velocityVerletStep, eulerStep: eulerStep,
    kineticEnergy: kineticEnergy, instTemperature: instTemperature, totalMomentum: totalMomentum,
    zeroMomentum: zeroMomentum, thermostatRescale: thermostatRescale,
    randomSequentialFill: randomSequentialFill, jitteredTriangularFill: jitteredTriangularFill,
    hexagonalBlob: hexagonalBlob, maxwellVelocities: maxwellVelocities,
    findClusters: findClusters, windingRank: windingRank, asphericity: asphericity,
    structureFactor: structureFactor,
    morphologyGrid: morphologyGrid, classifyMorphology: classifyMorphology, gridComponents: gridComponents,
    besselJ0: besselJ0, tailFourier: tailFourier, tailValueAt: tailValueAt, findLambdaStar: findLambdaStar,
    vhatZero: vhatZero, vTailAtSigma: vTailAtSigma, optimalClusterSize: optimalClusterSize, pairEnergySum: pairEnergySum,
    SIGMA: SIGMA, EPS_C: EPS_C,
  };
});
