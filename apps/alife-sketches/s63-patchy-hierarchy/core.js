/**
 * S-63: 2つの結合尺度の自己集合（パッチ粒子）― 核（物理）
 *
 * 1種類の円板・2次元周期境界。粒子は向かい合う極に強く広いパッチ A と弱く狭いパッチ B を持つ。
 * 対ポテンシャルは WCA の芯（等方）から角度窓つきの引力（w(r)·Σ ε_pq g_p g_q）を引いたもの。
 * 力とトルクは1つの対ポテンシャルの厳密な勾配（解析的に導出。selftest で数値微分と突き合わせる）。
 * 積分は BAOAB（Leimkuhler–Matthews）を並進・回転の両方に同じ形で使う不足減衰 Langevin。
 *
 * 上位概念の語彙（cell/membrane/gene/organism/catalyst/fitness/alive）は使わない。
 * 「パッチ」「結合」はコロイド文献の語（C1: Morphew ら 2018）で、ここでは幾何と力学だけで定義する。
 *
 * 依存ゼロ。Node（run.js・selftest.js）とブラウザ（viewer.html）が同じファイルを読む。
 * 出典: criteria.json の sources / sourceFidelity / borrowedConstants / system / protocol を見よ。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S63 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ================================================================ 乱数（S-56 と同じ設計）

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
  function subStream(seed, streamId) { return makeRng(hash32(seed >>> 0, streamId >>> 0)); }

  /** Box–Muller の1つ（Kahan 加算などとは無関係。標準正規乱数）。 */
  function gaussian(rng) {
    var u1 = Math.max(rng(), 1e-12), u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  // ================================================================ Kahan 加算器

  function kahanNew() { return { sum: 0, c: 0 }; }
  function kahanAdd(k, x) {
    var y = x - k.c, t = k.sum + y;
    k.c = (t - k.sum) - y;
    k.sum = t;
    return k;
  }

  // ================================================================ 単位・幾何定数

  var SIGMA = 1, M = 1, INERTIA = M * SIGMA * SIGMA / 8; // I = mσ²/8 = 0.125
  var WCA_RMIN = Math.pow(2, 1 / 6);
  var DEG = Math.PI / 180;
  var A_CHI = Math.cos(32 * DEG), A_CLO = Math.cos(45 * DEG);
  var B_CHI = Math.cos(4 * DEG), B_CLO = Math.cos(16 * DEG);
  var R0 = 1.10, RC = 1.35;

  // ================================================================ ポテンシャルの構成要素

  /** WCA の芯。V=4[(1/r)^12-(1/r)^6]+1 (r<2^{1/6})。F=-dV/dr。 */
  function wcaVF(r) {
    if (r >= WCA_RMIN) return { V: 0, F: 0 };
    var inv = 1 / r, s2 = inv * inv, s6 = s2 * s2 * s2, s12 = s6 * s6;
    var V = 4 * (s12 - s6) + 1;
    var F = 4 * (12 * s12 - 6 * s6) * inv;
    return { V: V, F: F };
  }

  /** 五次の平滑段 S(x)=10x³-15x⁴+6x⁵ とその導関数（x∈[0,1] の外はクランプ）。 */
  function smoothstepGD(x) {
    if (x <= 0) return { S: 0, dS: 0 };
    if (x >= 1) return { S: 1, dS: 0 };
    var x2 = x * x;
    return { S: 10 * x2 * x - 15 * x2 * x2 + 6 * x2 * x2 * x, dS: 30 * x2 * (1 - x) * (1 - x) };
  }

  /** 動径窓 w(r) と dw/dr。w=1 (r<=r0)、1-S (r0<r<rc)、0 (r>=rc)。 */
  function radialWindowGD(r, r0, rc) {
    if (r <= r0) return { w: 1, dw: 0 };
    if (r >= rc) return { w: 0, dw: 0 };
    var sg = smoothstepGD((r - r0) / (rc - r0));
    return { w: 1 - sg.S, dw: -sg.dS / (rc - r0) };
  }

  /** 角度窓 g_p(c)=S((c-clo)/(chi-clo)) と dg/dc。 */
  function angularWindowGD(c, chi, clo) {
    var sg = smoothstepGD((c - clo) / (chi - clo));
    return { g: sg.S, dg: sg.dS / (chi - clo) };
  }

  /**
   * 対の相互作用パラメータ。isotropic なら角度窓を使わず g≡1・トルク0（NC3）。
   * epsAB=0 の腕（A-R1x）・epsBB=epsAB=0（NC2）・全て0（NC1）も同じ式で自然に扱える。
   */
  function buildParams(opt) {
    return {
      epsAA: opt.epsAA || 0, epsBB: opt.epsBB || 0, epsAB: opt.epsAB || 0,
      isotropic: !!opt.isotropic, epsIso: opt.epsIso || 0,
      r0: opt.r0 != null ? opt.r0 : R0, rc: opt.rc != null ? opt.rc : RC,
      gammaT: opt.gammaT != null ? opt.gammaT : 1.0,
      gammaR: (opt.gammaT != null ? opt.gammaT : 1.0) * (8 / 3),
      I: INERTIA, m: M, dt: opt.dt || 0.002,
    };
  }

  /**
   * 1対の相互作用: 力・トルク・エネルギーを解析的な厳密勾配で返す。
   * dx,dy は j−i の最近接鏡像変位（呼び出し側が最小像を渡す）。
   * 戻り値: { V, Fix,Fiy, taui,tauj }（Fjx=-Fix, Fjy=-Fiy は呼び出し側で反映）。
   *
   * 導出: V=V_WCA(r) − w(r)Σ、Σ=Σ_{p,q}ε_pq g_p(c_i^p) g_q(c_j^q)。
   * F_i=-∂V/∂r_i=(dV/dr)u+perp(∂V/∂u)/r（u=r̂_ij、perp(v)=v-(v·u)u）、τ_i=-∂V/∂φ_i。
   * V, dV/dr, dV/du（接線成分), dV/dφi, dV/dφj をそれぞれ求めてから最後に1箇所で組み立てる。
   */
  function pairForceTorque(dx, dy, r, phii, phij, p) {
    var ux = dx / r, uy = dy / r;
    var wca = wcaVF(r);
    var V = wca.V, dVdr = -wca.F;
    var dVtanX = 0, dVtanY = 0, dVdphii = 0, dVdphij = 0;

    if (r < p.rc) {
      var rw = radialWindowGD(r, p.r0, p.rc);
      if (p.isotropic) {
        V += -rw.w * p.epsIso;
        dVdr += -rw.dw * p.epsIso;
      } else {
        var cphi_i = Math.cos(phii), sphi_i = Math.sin(phii);
        var cphi_j = Math.cos(phij), sphi_j = Math.sin(phij);
        var aix = cphi_i, aiy = sphi_i, ajx = cphi_j, ajy = sphi_j;
        var aiPerpX = -sphi_i, aiPerpY = cphi_i, ajPerpX = -sphi_j, ajPerpY = cphi_j;
        var uDotAi = ux * aix + uy * aiy;
        var uDotAj = ux * ajx + uy * ajy;
        var uDotAiPerp = ux * aiPerpX + uy * aiPerpY;
        var uDotAjPerp = ux * ajPerpX + uy * ajPerpY;

        var ciA = uDotAi, ciB = -uDotAi, cjA = -uDotAj, cjB = uDotAj;
        var gA_i = angularWindowGD(ciA, A_CHI, A_CLO), gB_i = angularWindowGD(ciB, B_CHI, B_CLO);
        var gA_j = angularWindowGD(cjA, A_CHI, A_CLO), gB_j = angularWindowGD(cjB, B_CHI, B_CLO);
        var GiA = gA_i.g, GiB = gB_i.g, GjA = gA_j.g, GjB = gB_j.g;

        var Sigma = p.epsAA * GiA * GjA + p.epsAB * GiA * GjB + p.epsAB * GiB * GjA + p.epsBB * GiB * GjB;
        V += -rw.w * Sigma;
        dVdr += -rw.dw * Sigma;

        if (rw.w > 0) {
          var coefA_i = p.epsAA * GjA + p.epsAB * GjB;
          var coefB_i = p.epsAB * GjA + p.epsBB * GjB;
          var coefA_j = p.epsAA * GiA + p.epsAB * GiB;
          var coefB_j = p.epsAB * GiA + p.epsBB * GiB;

          var dSigmaDuX = gA_i.dg * aix * coefA_i - gB_i.dg * aix * coefB_i
            - gA_j.dg * ajx * coefA_j + gB_j.dg * ajx * coefB_j;
          var dSigmaDuY = gA_i.dg * aiy * coefA_i - gB_i.dg * aiy * coefB_i
            - gA_j.dg * ajy * coefA_j + gB_j.dg * ajy * coefB_j;
          dVtanX = -rw.w * dSigmaDuX; dVtanY = -rw.w * dSigmaDuY;

          var dSigmaDphii = gA_i.dg * uDotAiPerp * coefA_i - gB_i.dg * uDotAiPerp * coefB_i;
          var dSigmaDphij = -gA_j.dg * uDotAjPerp * coefA_j + gB_j.dg * uDotAjPerp * coefB_j;
          dVdphii = -rw.w * dSigmaDphii;
          dVdphij = -rw.w * dSigmaDphij;
        }
      }
    }
    // dVtan（∂V/∂u の生の2D勾配）の接線成分だけを使う: perp(v)=v-(v·u)u
    var dot = dVtanX * ux + dVtanY * uy;
    var perpX = dVtanX - dot * ux, perpY = dVtanY - dot * uy;
    var Fix = dVdr * ux + perpX / r;
    var Fiy = dVdr * uy + perpY / r;
    var taui = -dVdphii, tauj = -dVdphij;
    return { V: V, Fix: Fix, Fiy: Fiy, taui: taui, tauj: tauj };
  }

  /** 数値微分（並進・r方向）。selftest の勾配検査に使う。 */
  function numericDVdr(r, phii, phij, p, h) {
    h = h || 1e-6 * Math.max(r, 1);
    var vp = pairForceTorque(r + h, 0, r + h, phii, phij, p).V;
    var vm = pairForceTorque(r - h, 0, r - h, phii, phij, p).V;
    return (vp - vm) / (2 * h);
  }

  // ================================================================ 系（状態）

  function createSystem(N, L) {
    return {
      N: N, L: L,
      x: new Float64Array(N), y: new Float64Array(N), phi: new Float64Array(N),
      vx: new Float64Array(N), vy: new Float64Array(N), omega: new Float64Array(N),
    };
  }

  function wrapPos(v, L) { v = v % L; if (v < 0) v += L; return v; }
  function wrapAll(sys) { for (var i = 0; i < sys.N; i++) { sys.x[i] = wrapPos(sys.x[i], sys.L); sys.y[i] = wrapPos(sys.y[i], sys.L); } }
  function minImageD(dx, L) { if (dx > L / 2) dx -= L; else if (dx < -L / 2) dx += L; return dx; }

  // ---------------------------------------------------------------- 近傍探索（セル分割）

  /**
   * セルへ粒子を割り当てる（永続バッファ版・性能）。ncell<3、または希薄すぎて格子がNに比べ
   * 大きすぎるとき（ncell²がNの20倍を超える）null を返し、呼び出し側は素朴な全対探索へ落ちる。
   *
   * **型付き配列の連結リスト**（head[cell]→粒子、next[粒子]→同じセルの次の粒子、-1で終端）を
   * `sys._cellCache` へキャッシュし、ncellが変わらない限り毎ステップ再確保しない
   * （箱の一辺Lとカットオフrcは走行中変わらないので、通常は初回の1回だけ確保する）。
   * 中身（どの粒子がどのセルにいるか）は毎回 head を -1 で埋め直して作り直す（O(N+ncell²)、確保なし）。
   */
  function buildCells(sys, rc) {
    var L = sys.L, ncell = Math.floor(L / rc);
    if (ncell < 3) return null;
    if (ncell * ncell > 20 * Math.max(1, sys.N)) return null;
    var cache = sys._cellCache;
    if (!cache || cache.ncell !== ncell || cache.next.length !== sys.N) {
      cache = sys._cellCache = { ncell: ncell, head: new Int32Array(ncell * ncell), next: new Int32Array(sys.N) };
    }
    var cellSize = L / ncell;
    var head = cache.head, next = cache.next;
    head.fill(-1);
    for (var i = 0; i < sys.N; i++) {
      var cx = Math.min(ncell - 1, (sys.x[i] / cellSize) | 0);
      var cy = Math.min(ncell - 1, (sys.y[i] / cellSize) | 0);
      var c = cy * ncell + cx;
      next[i] = head[c]; head[c] = i;
    }
    return { ncell: ncell, cellSize: cellSize, head: head, next: next };
  }

  var HALF_STENCIL = [[0, 0], [1, 0], [1, 1], [0, 1], [-1, 1]];

  /**
   * 近傍対 (i,j, dx,dy, r) を1つずつ cb(i,j,dx,dy,r) へ渡す。rc 以内の対だけ（周期境界・最小像）。
   * セル分割が使えれば O(N)、使えなければ O(N²) の全対探索。
   * （観測器・検出器から低頻度で呼ばれる経路向け。力の本番計算は computeForcesTorques が
   * このコールバック方式を使わず直接インライン化している――関数呼び出し・オブジェクト確保を
   * 避けるため。数式は完全に同じ）
   */
  function forEachPair(sys, rc, cb) {
    var N = sys.N, L = sys.L, x = sys.x, y = sys.y, rc2 = rc * rc, halfL = L / 2;
    var grid = buildCells(sys, rc);
    if (!grid) {
      for (var i = 0; i < N; i++) for (var j = i + 1; j < N; j++) {
        var dx = x[j] - x[i], dy = y[j] - y[i];
        if (dx > halfL) dx -= L; else if (dx < -halfL) dx += L;
        if (dy > halfL) dy -= L; else if (dy < -halfL) dy += L;
        var r2 = dx * dx + dy * dy;
        if (r2 < rc2 && r2 > 1e-12) cb(i, j, dx, dy, Math.sqrt(r2));
      }
      return;
    }
    var ncell = grid.ncell, head = grid.head, next = grid.next;
    for (var cy = 0; cy < ncell; cy++) for (var cx = 0; cx < ncell; cx++) {
      for (var s = 0; s < HALF_STENCIL.length; s++) {
        var off = HALF_STENCIL[s];
        var nx = ((cx + off[0]) % ncell + ncell) % ncell;
        var ny = ((cy + off[1]) % ncell + ncell) % ncell;
        var sameCell = off[0] === 0 && off[1] === 0;
        for (var a = head[cy * ncell + cx]; a >= 0; a = next[a]) {
          var bStart = sameCell ? next[a] : head[ny * ncell + nx];
          for (var b = bStart; b >= 0; b = next[b]) {
            var dx = x[b] - x[a], dy = y[b] - y[a];
            if (dx > halfL) dx -= L; else if (dx < -halfL) dx += L;
            if (dy > halfL) dy -= L; else if (dy < -halfL) dy += L;
            var r2 = dx * dx + dy * dy;
            if (r2 < rc2 && r2 > 1e-12) cb(a, b, dx, dy, Math.sqrt(r2));
          }
        }
      }
    }
  }

  /** 全力・全トルク・全エネルギー（セル分割を使う本番経路）。 */
  /**
   * 本番の力・トルク計算（性能を優先した経路）。pairForceTorque と**同じ式**を、
   * (1) 角度cos/sinを粒子ごとに1回だけ前計算 (2) 対ごとのオブジェクト確保を無くし
   * ローカル変数だけで計算 (3) fx/fy/tau/cos/sinのバッファを sys に永続化して毎ステップの
   * Float64Array確保を無くす、という3点で高速化している。
   * 数式が pairForceTorque と一致することは selftest の「近道の検算」（このcomputeForcesTorques
   * と computeForcesTorquesBrute／pairForceTorque経由の比較）で確認する。
   */
  function computeForcesTorques(sys, p) {
    var N = sys.N;
    if (!sys._fx || sys._fx.length !== N) {
      sys._fx = new Float64Array(N); sys._fy = new Float64Array(N); sys._tau = new Float64Array(N);
      sys._cosPhi = new Float64Array(N); sys._sinPhi = new Float64Array(N);
    }
    var fx = sys._fx, fy = sys._fy, tau = sys._tau, cosPhi = sys._cosPhi, sinPhi = sys._sinPhi;
    fx.fill(0); fy.fill(0); tau.fill(0);
    for (var i = 0; i < N; i++) { cosPhi[i] = Math.cos(sys.phi[i]); sinPhi[i] = Math.sin(sys.phi[i]); }

    var isotropic = p.isotropic, epsIso = p.epsIso, epsAA = p.epsAA, epsBB = p.epsBB, epsAB = p.epsAB;
    var r0 = p.r0, rc = p.rc, rInvRange = 1 / (p.rc - p.r0);
    var AInvRange = 1 / (A_CHI - A_CLO), BInvRange = 1 / (B_CHI - B_CLO);
    var Uacc = 0;

    function evalPair(a, b, dx, dy, r) {
      var ux = dx / r, uy = dy / r;
      var V = 0, dVdr = 0, dVtanX = 0, dVtanY = 0, dVdphia = 0, dVdphib = 0;
      if (r < WCA_RMIN) {
        var invr = 1 / r, s2 = invr * invr, s6 = s2 * s2 * s2, s12 = s6 * s6;
        V += 4 * (s12 - s6) + 1;
        dVdr += -(4 * (12 * s12 - 6 * s6) * invr);
      }
      if (r < rc) {
        var rw = 0, rdw = 0;
        if (r <= r0) { rw = 1; } else {
          var xr = (r - r0) * rInvRange, xr2 = xr * xr;
          var Sr = 10 * xr2 * xr - 15 * xr2 * xr2 + 6 * xr2 * xr2 * xr;
          var dSr = 30 * xr2 * (1 - xr) * (1 - xr);
          rw = 1 - Sr; rdw = -dSr * rInvRange;
        }
        if (isotropic) {
          V += -rw * epsIso; dVdr += -rdw * epsIso;
        } else {
          var aix = cosPhi[a], aiy = sinPhi[a], ajx = cosPhi[b], ajy = sinPhi[b];
          var uDotAi = ux * aix + uy * aiy, uDotAj = ux * ajx + uy * ajy;
          var uDotAiPerp = ux * -aiy + uy * aix, uDotAjPerp = ux * -ajy + uy * ajx;
          var ciA = uDotAi, ciB = -uDotAi, cjA = -uDotAj, cjB = uDotAj;
          var GiA = 0, dgiA = 0, GiB = 0, dgiB = 0, GjA = 0, dgjA = 0, GjB = 0, dgjB = 0, x1, x12;
          x1 = (ciA - A_CLO) * AInvRange;
          if (x1 > 0) { if (x1 >= 1) GiA = 1; else { x12 = x1 * x1; GiA = 10 * x12 * x1 - 15 * x12 * x12 + 6 * x12 * x12 * x1; dgiA = 30 * x12 * (1 - x1) * (1 - x1) * AInvRange; } }
          x1 = (ciB - B_CLO) * BInvRange;
          if (x1 > 0) { if (x1 >= 1) GiB = 1; else { x12 = x1 * x1; GiB = 10 * x12 * x1 - 15 * x12 * x12 + 6 * x12 * x12 * x1; dgiB = 30 * x12 * (1 - x1) * (1 - x1) * BInvRange; } }
          x1 = (cjA - A_CLO) * AInvRange;
          if (x1 > 0) { if (x1 >= 1) GjA = 1; else { x12 = x1 * x1; GjA = 10 * x12 * x1 - 15 * x12 * x12 + 6 * x12 * x12 * x1; dgjA = 30 * x12 * (1 - x1) * (1 - x1) * AInvRange; } }
          x1 = (cjB - B_CLO) * BInvRange;
          if (x1 > 0) { if (x1 >= 1) GjB = 1; else { x12 = x1 * x1; GjB = 10 * x12 * x1 - 15 * x12 * x12 + 6 * x12 * x12 * x1; dgjB = 30 * x12 * (1 - x1) * (1 - x1) * BInvRange; } }

          var Sigma = epsAA * GiA * GjA + epsAB * GiA * GjB + epsAB * GiB * GjA + epsBB * GiB * GjB;
          V += -rw * Sigma; dVdr += -rdw * Sigma;
          if (rw > 0) {
            var coefA_i = epsAA * GjA + epsAB * GjB, coefB_i = epsAB * GjA + epsBB * GjB;
            var coefA_j = epsAA * GiA + epsAB * GiB, coefB_j = epsAB * GiA + epsBB * GiB;
            var dSigmaDuX = dgiA * aix * coefA_i - dgiB * aix * coefB_i - dgjA * ajx * coefA_j + dgjB * ajx * coefB_j;
            var dSigmaDuY = dgiA * aiy * coefA_i - dgiB * aiy * coefB_i - dgjA * ajy * coefA_j + dgjB * ajy * coefB_j;
            dVtanX = -rw * dSigmaDuX; dVtanY = -rw * dSigmaDuY;
            var dSigmaDphii = dgiA * uDotAiPerp * coefA_i - dgiB * uDotAiPerp * coefB_i;
            var dSigmaDphij = -dgjA * uDotAjPerp * coefA_j + dgjB * uDotAjPerp * coefB_j;
            dVdphia = -rw * dSigmaDphii; dVdphib = -rw * dSigmaDphij;
          }
        }
      }
      var dot = dVtanX * ux + dVtanY * uy;
      var perpX = dVtanX - dot * ux, perpY = dVtanY - dot * uy;
      var Fix = dVdr * ux + perpX / r, Fiy = dVdr * uy + perpY / r;
      fx[a] += Fix; fy[a] += Fiy; fx[b] -= Fix; fy[b] -= Fiy;
      tau[a] += -dVdphia; tau[b] += -dVdphib;
      Uacc += V;
    }

    forEachPair(sys, p.rc, evalPair);
    return { fx: fx, fy: fy, tau: tau, U: Uacc };
  }

  /** computeForcesTorques() と同じ式の、全対探索だけを使う参照実装（selftest の突き合わせ用）。 */
  function computeForcesTorquesBrute(sys, p) {
    var N = sys.N, L = sys.L, fx = new Float64Array(N), fy = new Float64Array(N), tau = new Float64Array(N);
    var Uk = kahanNew();
    for (var i = 0; i < N; i++) for (var j = i + 1; j < N; j++) {
      var dx = minImageD(sys.x[j] - sys.x[i], L), dy = minImageD(sys.y[j] - sys.y[i], L);
      var r2 = dx * dx + dy * dy;
      if (r2 >= p.rc * p.rc || r2 < 1e-12) continue;
      var r = Math.sqrt(r2);
      var ft = pairForceTorque(dx, dy, r, sys.phi[i], sys.phi[j], p);
      fx[i] += ft.Fix; fy[i] += ft.Fiy; fx[j] -= ft.Fix; fy[j] -= ft.Fiy;
      tau[i] += ft.taui; tau[j] += ft.tauj;
      kahanAdd(Uk, ft.V);
    }
    return { fx: fx, fy: fy, tau: tau, U: Uk.sum };
  }

  /**
   * E-nonrec（較正腕）: 奇数番 i と偶数番 j の対だけ、パッチの力とトルクを i にだけ掛け j に
   * 反作用を掛けない（WCA の芯は相反のまま）。criteria.json positiveControls[7] の定義どおり。
   */
  function computeForcesTorquesNonrecip(sys, p) {
    var N = sys.N, L = sys.L, fx = new Float64Array(N), fy = new Float64Array(N), tau = new Float64Array(N);
    var Uk = kahanNew();
    for (var i = 0; i < N; i++) for (var j = i + 1; j < N; j++) {
      var dx = minImageD(sys.x[j] - sys.x[i], L), dy = minImageD(sys.y[j] - sys.y[i], L);
      var r2 = dx * dx + dy * dy;
      if (r2 >= p.rc * p.rc || r2 < 1e-12) continue;
      var r = Math.sqrt(r2);
      var wca = wcaVF(r);
      fx[i] += -wca.F * (dx / r); fy[i] += -wca.F * (dy / r);
      fx[j] -= -wca.F * (dx / r); fy[j] -= -wca.F * (dy / r);
      kahanAdd(Uk, wca.V);
      var full = pairForceTorque(dx, dy, r, sys.phi[i], sys.phi[j], p);
      var patchFix = full.Fix - (-wca.F * (dx / r)), patchFiy = full.Fiy - (-wca.F * (dy / r));
      kahanAdd(Uk, full.V - wca.V);
      var iOdd = (i % 2) === 1, jOdd = (j % 2) === 1;
      if (iOdd && !jOdd) {
        // i(奇)→j(偶) にだけ力とトルクを掛ける: j が押され、i は押されない
        fx[j] -= patchFix; fy[j] -= patchFiy; tau[j] += full.tauj;
      } else if (jOdd && !iOdd) {
        fx[i] += patchFix; fy[i] += patchFiy; tau[i] += full.taui;
      } else {
        fx[i] += patchFix; fy[i] += patchFiy; tau[i] += full.taui;
        fx[j] -= patchFix; fy[j] -= patchFiy; tau[j] += full.tauj;
      }
    }
    return { fx: fx, fy: fy, tau: tau, U: Uk.sum };
  }

  // ---------------------------------------------------------------- 積分器（BAOAB）

  /**
   * BAOAB を並進 (x,y,vx,vy) と回転 (phi,omega) の同じ形で1段だけ進める。
   * forceFn(sys,p) は {fx,fy,tau,U} を返すこと。熱 Q は O 段の運動エネルギー変化の和（Kahan）。
   * opts.noTorque: true なら回転の O/B 段はそのまま回すが、力の計算で得た tau を 0 として扱う
   *   （E-notorque 較正腕。力は勾配のまま、というのは並進の力は変えずトルクだけ切ることを指す）。
   */
  function baoabStep(sys, p, T, forceFn, Qkahan, opts) {
    opts = opts || {};
    var N = sys.N, dt = p.dt, halfDt = dt / 2;
    var c1t = Math.exp(-p.gammaT * dt), c1r = Math.exp(-p.gammaR * dt);
    var sigT = Math.sqrt((1 - c1t * c1t) * T / p.m);
    var sigR = Math.sqrt((1 - c1r * c1r) * T / p.I);

    if (!sys._f) sys._f = forceFn(sys, p);
    var f = sys._f;
    var i;
    // B: 半キック
    for (i = 0; i < N; i++) {
      sys.vx[i] += halfDt * f.fx[i] / p.m; sys.vy[i] += halfDt * f.fy[i] / p.m;
      var tq = opts.noTorque ? 0 : f.tau[i];
      sys.omega[i] += halfDt * tq / p.I;
    }
    // A: 半ドリフト
    for (i = 0; i < N; i++) { sys.x[i] += halfDt * sys.vx[i]; sys.y[i] += halfDt * sys.vy[i]; sys.phi[i] += halfDt * sys.omega[i]; }
    wrapAll(sys);
    // O: 熱浴（Ornstein–Uhlenbeck）。Q = ΔK（並進+回転）を Kahan 加算。
    var Kbefore = kineticEnergyBoth(sys);
    var needsNoise = sigT > 0 || sigR > 0;
    if (needsNoise && !opts.rng) throw new Error('baoabStep: T>0（熱浴あり）には opts.rng が必要');
    for (i = 0; i < N; i++) {
      sys.vx[i] = c1t * sys.vx[i] + (sigT > 0 ? sigT * gaussian(opts.rng) : 0);
      sys.vy[i] = c1t * sys.vy[i] + (sigT > 0 ? sigT * gaussian(opts.rng) : 0);
      sys.omega[i] = c1r * sys.omega[i] + (sigR > 0 ? sigR * gaussian(opts.rng) : 0);
    }
    var Kafter = kineticEnergyBoth(sys);
    if (Qkahan) kahanAdd(Qkahan, Kafter.Kt + Kafter.Kr - Kbefore.Kt - Kbefore.Kr);
    // A: 半ドリフト
    for (i = 0; i < N; i++) { sys.x[i] += halfDt * sys.vx[i]; sys.y[i] += halfDt * sys.vy[i]; sys.phi[i] += halfDt * sys.omega[i]; }
    wrapAll(sys);
    var f2 = forceFn(sys, p);
    // B: 半キック
    for (i = 0; i < N; i++) {
      sys.vx[i] += halfDt * f2.fx[i] / p.m; sys.vy[i] += halfDt * f2.fy[i] / p.m;
      var tq2 = opts.noTorque ? 0 : f2.tau[i];
      sys.omega[i] += halfDt * tq2 / p.I;
    }
    sys._f = f2;
    return f2.U;
  }

  /** 陽的 Euler（PC-E の E-euler 専用の較正腕。熱雑音は入れない＝決定的な力だけの1段）。 */
  function eulerStep(sys, p, forceFn) {
    var f = forceFn(sys, p), N = sys.N, dt = p.dt;
    for (var i = 0; i < N; i++) {
      sys.x[i] += dt * sys.vx[i]; sys.y[i] += dt * sys.vy[i]; sys.phi[i] += dt * sys.omega[i];
      sys.vx[i] += dt * f.fx[i] / p.m; sys.vy[i] += dt * f.fy[i] / p.m; sys.omega[i] += dt * f.tau[i] / p.I;
    }
    wrapAll(sys);
    sys._f = null;
    return f.U;
  }

  function kineticEnergyBoth(sys) {
    var Kt = 0, Kr = 0, N = sys.N;
    for (var i = 0; i < N; i++) {
      Kt += 0.5 * M * (sys.vx[i] * sys.vx[i] + sys.vy[i] * sys.vy[i]);
      Kr += 0.5 * INERTIA * sys.omega[i] * sys.omega[i];
    }
    return { Kt: Kt, Kr: Kr };
  }

  function totalMomentum(sys) {
    var px = 0, py = 0, Lz = 0;
    for (var i = 0; i < sys.N; i++) {
      px += M * sys.vx[i]; py += M * sys.vy[i];
      Lz += M * (sys.x[i] * sys.vy[i] - sys.y[i] * sys.vx[i]) + INERTIA * sys.omega[i];
    }
    return { px: px, py: py, Lz: Lz };
  }
  function zeroMomentum(sys) {
    var p = totalMomentum(sys), N = sys.N;
    var dvx = p.px / (M * N), dvy = p.py / (M * N);
    for (var i = 0; i < N; i++) { sys.vx[i] -= dvx; sys.vy[i] -= dvy; }
  }

  // ================================================================ 初期配置

  /** 逐次無作為付加（最小間隔 minDist）。1e6 回失敗したら三角格子へ切り替える。 */
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
      var rowH = minDist * Math.sqrt(3) / 2, nRows = Math.ceil(L / rowH), n = 0;
      for (var r = 0; r < nRows && n < N; r++) {
        var offset = (r % 2) * minDist / 2, nCols = Math.ceil(L / minDist);
        for (var c = 0; c < nCols && n < N; c++) {
          x[n] = wrapPos(offset + c * minDist + (rng() - 0.5) * minDist * 0.05, L);
          y[n] = wrapPos(r * rowH + (rng() - 0.5) * minDist * 0.05, L);
          n++;
        }
      }
    }
    return { x: x, y: y, fellBackToLattice: fellBack };
  }

  /** Maxwell 速度＋角速度（並進T,回転Tは同じ熱浴温度）。全運動量を0へ差し引く。 */
  function maxwellVelocities(N, T, rng) {
    var vx = new Float64Array(N), vy = new Float64Array(N), omega = new Float64Array(N);
    var sigT = Math.sqrt(T / M), sigR = Math.sqrt(T / INERTIA);
    for (var i = 0; i < N; i++) { vx[i] = sigT * gaussian(rng); vy[i] = sigT * gaussian(rng); omega[i] = sigR * gaussian(rng); }
    var px = 0, py = 0;
    for (i = 0; i < N; i++) { px += vx[i]; py += vy[i]; }
    var dvx = px / N, dvy = py / N;
    for (i = 0; i < N; i++) { vx[i] -= dvx; vy[i] -= dvy; }
    return { vx: vx, vy: vy, omega: omega };
  }

  /**
   * 理想の三角形の蜂の巣（3.12.12）を手組みする。criteria.json referencePoints[2] 用。
   *
   * 各三角形の頂点は中心向き（A、三角形内の2結合）と外向き（B、隣の三角形への1結合）を持つ
   * （idealHoneycombTriangles の設計: phi=ang+π で A 極を中心へ向ける）。BFS で隣の三角形を
   * 「外向きの頂点から bondB だけ先に、頭を向き合わせて」置いていくことで、格子の式を仮定せず
   * 重なりなく蜂の巣（各三角形が3つの隣と結合）を組み立てる。同じ中心が2度置かれたら（周回で
   * 閉じたら）そこで打ち切る。
   */
  function idealHoneycombTriangles(nTriangles, bondA, bondB) {
    bondB = bondB == null ? bondA : bondB;
    var rTri = bondA / Math.sqrt(3);
    var placed = []; // { cx, cy, base }
    var seen = []; // 重複排除用（cx,cyの丸め）
    function key(cx, cy) { return Math.round(cx * 1000) + ',' + Math.round(cy * 1000); }
    var seenSet = {};
    var queue = [{ cx: 0, cy: 0, base: -Math.PI / 2 }];
    seenSet[key(0, 0)] = true;
    while (placed.length < nTriangles && queue.length > 0) {
      var t = queue.shift();
      placed.push(t);
      if (placed.length >= nTriangles) break;
      for (var v = 0; v < 3; v++) {
        var ang = t.base + v * (2 * Math.PI / 3);
        var dirX = Math.cos(ang), dirY = Math.sin(ang);
        var ncx = t.cx + (2 * rTri + bondB) * dirX, ncy = t.cy + (2 * rTri + bondB) * dirY;
        var k = key(ncx, ncy);
        if (seenSet[k]) continue;
        seenSet[k] = true;
        queue.push({ cx: ncx, cy: ncy, base: ang + Math.PI });
      }
    }
    var x = [], y = [], phi = [];
    for (var i = 0; i < placed.length; i++) {
      var pt = placed[i];
      for (var vv = 0; vv < 3; vv++) {
        var a2 = pt.base + vv * (2 * Math.PI / 3);
        x.push(pt.cx + rTri * Math.cos(a2));
        y.push(pt.cy + rTri * Math.sin(a2));
        phi.push(a2 + Math.PI); // A極（結合相手2つ）が三角形の中心を向く
      }
    }
    return { x: Float64Array.from(x), y: Float64Array.from(y), phi: Float64Array.from(phi), n: x.length, triangles: placed.length };
  }

  // ================================================================ エクスポート

  return {
    makeRng: makeRng, subStream: subStream, hash32: hash32, gaussian: gaussian,
    kahanNew: kahanNew, kahanAdd: kahanAdd,
    SIGMA: SIGMA, M: M, INERTIA: INERTIA, WCA_RMIN: WCA_RMIN, R0: R0, RC: RC,
    A_CHI: A_CHI, A_CLO: A_CLO, B_CHI: B_CHI, B_CLO: B_CLO,
    wcaVF: wcaVF, smoothstepGD: smoothstepGD, radialWindowGD: radialWindowGD, angularWindowGD: angularWindowGD,
    buildParams: buildParams, pairForceTorque: pairForceTorque, numericDVdr: numericDVdr,
    createSystem: createSystem, wrapPos: wrapPos, wrapAll: wrapAll, minImageD: minImageD,
    forEachPair: forEachPair, buildCells: buildCells,
    computeForcesTorques: computeForcesTorques, computeForcesTorquesBrute: computeForcesTorquesBrute,
    computeForcesTorquesNonrecip: computeForcesTorquesNonrecip,
    baoabStep: baoabStep, eulerStep: eulerStep,
    kineticEnergyBoth: kineticEnergyBoth, totalMomentum: totalMomentum, zeroMomentum: zeroMomentum,
    randomSequentialFill: randomSequentialFill, maxwellVelocities: maxwellVelocities,
    idealHoneycombTriangles: idealHoneycombTriangles,
  };
});
