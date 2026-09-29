/**
 * S-57 核 — 平面内の向きを持つ円板（点双極子）の力学だけ。
 *
 * 上位概念（cell / membrane / gene / organism / catalyst / fitness / alive 等）は無い。
 * ここにあるのは「粒子」「向き」「力」「トルク」「ポテンシャル」「積分」という、
 * 古典力学そのものの語彙だけである（パターンの名づけ・観測は tracking.js 側）。
 *
 * 単位系（criteria.json system._comment）: σ=1, m=1, μ²/σ³=1, k_B=1, τ=σ√(mσ³/μ²)。
 * 慣性モーメント I = m σ²/8 = 0.125（全粒子共通）。
 *
 * 依存ゼロ・古典スクリプト。Node（module.exports）とブラウザ（window.S57）で共用する。
 */
(function (global) {
  'use strict';

  var INERTIA = 0.125; // I = m σ²/8, m=1
  var WCA_RC = Math.pow(2, 1 / 6);

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
  /** 同じ seed から複数の独立列を作る（位置/向き/速度/角速度で別列にする）。 */
  function subStream(seed, idx) {
    return rng(((seed >>> 0) * 2654435761 + idx * 40503 + 1) >>> 0);
  }
  function gaussian(rnd) {
    var u1 = Math.max(rnd(), 1e-12), u2 = rnd();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** FNV-1a 32bit を x,y,phi,vx,vy,omega の生バイト列にかける（K-36）。 */
  function hashState(st) {
    var n = st.N;
    var buf = new Float64Array(n * 6);
    for (var i = 0; i < n; i++) {
      buf[i * 6] = st.x[i]; buf[i * 6 + 1] = st.y[i]; buf[i * 6 + 2] = st.phi[i];
      buf[i * 6 + 3] = st.vx[i]; buf[i * 6 + 4] = st.vy[i]; buf[i * 6 + 5] = st.omega[i];
    }
    var bytes = new Uint8Array(buf.buffer);
    var h = 0x811c9dc5;
    for (var j = 0; j < bytes.length; j++) { h ^= bytes[j]; h = Math.imul(h, 0x01000193) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  // ---------------------------------------------------------------- 幾何（周期境界・最近接鏡像）

  function wrap(v, L) { var m = v % L; return m < 0 ? m + L : m; }
  /** b-a の最近接鏡像変位（[-L/2, L/2)）。 */
  function minImage(d, L) { return d - L * Math.round(d / L); }

  // ---------------------------------------------------------------- 状態

  function createSystem(N, L) {
    return {
      N: N, L: L,
      x: new Float64Array(N), y: new Float64Array(N), phi: new Float64Array(N),
      vx: new Float64Array(N), vy: new Float64Array(N), omega: new Float64Array(N),
    };
  }
  function cloneSystem(st) {
    return {
      N: st.N, L: st.L,
      x: Float64Array.from(st.x), y: Float64Array.from(st.y), phi: Float64Array.from(st.phi),
      vx: Float64Array.from(st.vx), vy: Float64Array.from(st.vy), omega: Float64Array.from(st.omega),
    };
  }

  /** 最小間隔 minSep の逐次無作為付加。10^6 回棄却したら揺らした三角格子へ切り替える（S-56 同型の安全弁）。 */
  function sequentialRandomFill(N, L, minSep, rnd) {
    var xs = new Float64Array(N), ys = new Float64Array(N);
    var placed = 0, totalTries = 0, maxTries = 1000000;
    while (placed < N && totalTries < maxTries) {
      var x = rnd() * L, y = rnd() * L, ok = true;
      for (var j = 0; j < placed; j++) {
        var dx = minImage(x - xs[j], L), dy = minImage(y - ys[j], L);
        if (dx * dx + dy * dy < minSep * minSep) { ok = false; break; }
      }
      totalTries++;
      if (ok) { xs[placed] = x; ys[placed] = y; placed++; }
    }
    var fellBack = placed < N;
    if (fellBack) {
      var perRow = Math.ceil(Math.sqrt(N)), spacing = L / perRow;
      for (var i = 0; i < N; i++) {
        var row = Math.floor(i / perRow), col = i % perRow;
        xs[i] = wrap((col + 0.5 + (row % 2 ? 0.25 : 0)) * spacing + (rnd() - 0.5) * 0.05, L);
        ys[i] = wrap((row + 0.5) * spacing + (rnd() - 0.5) * 0.05, L);
      }
    }
    return { x: xs, y: ys, fellBack: fellBack, tries: totalTries };
  }

  function uniformOrientations(N, rnd) {
    var phi = new Float64Array(N);
    for (var i = 0; i < N; i++) phi[i] = rnd() * 2 * Math.PI;
    return phi;
  }

  /** 並進 Maxwell 速度（各成分 var=T）。全運動量は呼び出し側で zeroMomentum する。 */
  function maxwellVelocities(N, T, rnd) {
    var vx = new Float64Array(N), vy = new Float64Array(N), sd = Math.sqrt(Math.max(T, 0));
    for (var i = 0; i < N; i++) { vx[i] = sd * gaussian(rnd); vy[i] = sd * gaussian(rnd); }
    return { vx: vx, vy: vy };
  }
  /** 角速度 Maxwell（var=T/I，1回転自由度）。 */
  function maxwellAngularVelocities(N, T, rnd) {
    var omega = new Float64Array(N), sd = Math.sqrt(Math.max(T, 0) / INERTIA);
    for (var i = 0; i < N; i++) omega[i] = sd * gaussian(rnd);
    return omega;
  }
  function zeroMomentum(st) {
    var N = st.N, sx = 0, sy = 0, i;
    for (i = 0; i < N; i++) { sx += st.vx[i]; sy += st.vy[i]; }
    sx /= N; sy /= N;
    for (i = 0; i < N; i++) { st.vx[i] -= sx; st.vy[i] -= sy; }
  }

  // ---------------------------------------------------------------- 打ち切りの切り替え関数

  /** S(r) と S'(r)。r<=rs で [1,0]、r>=rc で [0,0]、間は五次の C² 切り替え。 */
  function switchFn(r, rs, rc) {
    if (r <= rs) return [1, 0];
    if (r >= rc) return [0, 0];
    var x = (r - rs) / (rc - rs);
    var x2 = x * x, x3 = x2 * x, x4 = x3 * x, x5 = x4 * x;
    var S = 1 - 10 * x3 + 15 * x4 - 6 * x5;
    var dSdx = -30 * x2 + 60 * x3 - 30 * x4;
    return [S, dSdx / (rc - rs)];
  }

  // ---------------------------------------------------------------- 対の相互作用（核）
  //
  // dx,dy は既に最近接鏡像変位（i から j ではなく、j から i、すなわち r_ij = r_i - r_j）。
  // 戻り値は WCA 部と双極子部を分けて返す（E-central 変種が双極子の非中心成分だけを落とすため）。

  /** 便利版: 角度から。診断・観測器など、ホットパス外で使う（内部は pairInteractionCS に委譲）。 */
  function pairInteraction(dx, dy, phii, phij, rs, rc) {
    return pairInteractionCS(dx, dy, Math.cos(phii), Math.sin(phii), Math.cos(phij), Math.sin(phij), rs, rc);
  }

  /**
   * 核の実装（唯一の正）。cos/sin を直接受け取る——力の計算はステップごとに数万〜十万対を
   * 評価するホットパスなので、粒子ごとに1回だけ計算した cos/sin を配列から渡し、
   * 対ごとの Math.cos/sin 呼び出し（4回/対）を避ける（computeForcesTorques 参照）。
   */
  function pairInteractionCS(dx, dy, cosi, sini, cosj, sinj, rs, rc) {
    var r2 = dx * dx + dy * dy, r = Math.sqrt(r2);
    if (r >= rc && r >= WCA_RC) return null;
    var rhx = dx / r, rhy = dy / r;
    var out = {
      r: r, rhx: rhx, rhy: rhy,
      FwcaX: 0, FwcaY: 0, Vwca: 0,
      FddX: 0, FddY: 0, Vdd: 0, taui: 0, tauj: 0, S: 0,
    };
    if (r < WCA_RC) {
      var invr2 = 1 / r2, invr6 = invr2 * invr2 * invr2;
      out.Vwca = 4 * (invr6 * invr6 - invr6) + 1;
      var mag = (48 * invr6 * invr6 - 24 * invr6) / r; // -dV/dr, along rhat, per-unit r factored
      out.FwcaX = mag * rhx; out.FwcaY = mag * rhy;
    }
    if (r < rc) {
      var sw = switchFn(r, rs, rc), S = sw[0], Sp = sw[1];
      var a = cosi * rhx + sini * rhy;       // u_i . rhat
      var b = cosj * rhx + sinj * rhy;       // u_j . rhat
      var c = cosi * cosj + sini * sinj;     // u_i . u_j
      var Vdd0 = (c - 3 * a * b) / (r2 * r);
      out.Vdd = S * Vdd0;
      out.S = S;
      var r4 = r2 * r2;
      var coef = S * 3 / r4;
      var fx = coef * ((c - 5 * a * b) * rhx + b * cosi + a * cosj) - Sp * Vdd0 * rhx;
      var fy = coef * ((c - 5 * a * b) * rhy + b * sini + a * sinj) - Sp * Vdd0 * rhy;
      out.FddX = fx; out.FddY = fy;
      // u_i-perp . u_j , u_i-perp . rhat
      var uiPerpDotUj = -sini * cosj + cosi * sinj;
      var uiPerpDotRhat = -sini * rhx + cosi * rhy;
      out.taui = -S * (uiPerpDotUj - 3 * b * uiPerpDotRhat) / (r2 * r);
      var ujPerpDotUi = -sinj * cosi + cosj * sini;
      var ujPerpDotRhat = -sinj * rhx + cosj * rhy;
      out.tauj = -S * (ujPerpDotUi - 3 * a * ujPerpDotRhat) / (r2 * r);
    }
    return out;
  }

  /**
   * NC2（等方的な引力）専用: V = S(r)·4[(1/r)^12-(1/r)^6]（芯もLJ自身。WCAの分離無し）。
   * 回転の自由度は残るがトルクは常に0（向きの源が無い等方系の対照）。
   */
  function pairInteractionLJ(dx, dy, rs, rc) {
    var r2 = dx * dx + dy * dy, r = Math.sqrt(r2);
    if (r >= rc) return null;
    var rhx = dx / r, rhy = dy / r;
    var sw = switchFn(r, rs, rc), S = sw[0], Sp = sw[1];
    var invr2 = 1 / r2, invr6 = invr2 * invr2 * invr2;
    var V0 = 4 * (invr6 * invr6 - invr6);
    var dV0dr = 4 * (-12 * invr6 * invr6 / r + 6 * invr6 / r);
    var Vwca = S * V0;
    var mag = -(S * dV0dr + Sp * V0); // -d(S*V0)/dr
    return { r: r, rhx: rhx, rhy: rhy, FwcaX: mag * rhx, FwcaY: mag * rhy, Vwca: Vwca, FddX: 0, FddY: 0, Vdd: 0, taui: 0, tauj: 0, S: S };
  }

  // ---------------------------------------------------------------- 近傍探索（セルリスト・総当たり）

  /**
   * {I,J,count} i<j（並列な数値配列。array-of-arrays を避ける——V8 で GC 圧が桁違いに下がる。
   * 力の計算をホットパスで何百万回も呼ぶため、ここでの小さな配列を大量に作る設計は致命的に遅い）。
   * cellSize>=rc が保証できない小さい箱では総当たりへ落ちる。
   */
  function neighborPairsCellList(st, rc) {
    var L = st.L, N = st.N, nc = Math.floor(L / rc);
    if (nc < 3) return neighborPairsBrute(st, rc);
    var cellSize = L / nc;
    var head = new Int32Array(nc * nc).fill(-1), next = new Int32Array(N).fill(-1);
    var i;
    for (i = 0; i < N; i++) {
      var ix = Math.min(nc - 1, Math.floor(wrap(st.x[i], L) / cellSize));
      var iy = Math.min(nc - 1, Math.floor(wrap(st.y[i], L) / cellSize));
      var cidx = iy * nc + ix;
      next[i] = head[cidx]; head[cidx] = i;
    }
    var I = [], J = [], count = 0;
    for (var cyy = 0; cyy < nc; cyy++) {
      for (var cxx = 0; cxx < nc; cxx++) {
        var cell = cyy * nc + cxx;
        for (var dyc = 0; dyc <= 1; dyc++) {
          for (var dxc = (dyc === 0 ? 0 : -1); dxc <= 1; dxc++) {
            var ncx = ((cxx + dxc) % nc + nc) % nc, ncy = ((cyy + dyc) % nc + nc) % nc;
            var ncell = ncy * nc + ncx;
            // 5オフセット半殻（自分 + (1,0)/(-1,1)/(0,1)/(1,1)）は互いに重複しない片方向探索
            // （MD の標準手法）。nc>=3 のときオフセット集合が別セルへ一意に写るので追加の重複除去は要らない。
            var sameCell = ncell === cell;
            for (var a2 = head[cell]; a2 !== -1; a2 = next[a2]) {
              var bStart = sameCell ? next[a2] : head[ncell];
              for (var b2 = bStart; b2 !== -1; b2 = next[b2]) {
                if (a2 < b2) { I.push(a2); J.push(b2); } else { I.push(b2); J.push(a2); }
                count++;
              }
            }
          }
        }
      }
    }
    return { I: I, J: J, count: count };
  }
  function neighborPairsBrute(st, rc) {
    var N = st.N, I = [], J = [], count = 0;
    for (var i = 0; i < N; i++) for (var j = i + 1; j < N; j++) { I.push(i); J.push(j); count++; }
    return { I: I, J: J, count: count };
  }

  // ---------------------------------------------------------------- 全体の力・トルク・エネルギー

  /**
   * variant: 'normal' | 'central'（E-central: 双極子力を r̂ 方向へ射影） |
   *          'nonrecip'（E-nonrec: 双極子の力とトルクを奇数番→偶数番の向きにだけ掛ける）
   * useBrute: true なら総当たり（近道の検算・小系用）
   */
  function computeForcesTorques(st, params, variant, useBrute, outFx, outFy, outTau) {
    var N = st.N, L = st.L, rc = params.rc, rs = params.rs, isoLJ = !!params.isotropicLJ;
    var Fx = outFx || new Float64Array(N), Fy = outFy || new Float64Array(N), Tau = outTau || new Float64Array(N);
    if (outFx) { Fx.fill(0); Fy.fill(0); Tau.fill(0); }
    var U = 0;
    // 近傍探索の半径は WCA_RC を下回らない（rc=0＝双極子を消した対照でも芯の斥力だけは常に生きているため）
    var searchRc = Math.max(rc, WCA_RC);
    var pairs = useBrute ? neighborPairsBrute(st, searchRc) : neighborPairsCellList(st, searchRc);
    var PI = pairs.I, PJ = pairs.J, pcount = pairs.count;
    // cos/sin は粒子ごとに1回だけ（対ごとの Math.cos/sin 呼び出しを避ける。ホットパスの最適化）
    var cosPhi = null, sinPhi = null;
    if (!isoLJ) {
      cosPhi = new Float64Array(N); sinPhi = new Float64Array(N);
      for (var pI = 0; pI < N; pI++) { cosPhi[pI] = Math.cos(st.phi[pI]); sinPhi[pI] = Math.sin(st.phi[pI]); }
    }
    // ホットパス: pairInteractionCS と同じ式をオブジェクト割り当て無しでインライン展開する
    // （対ごとに1個ずつオブジェクトを作ると GC 圧で ~3倍遅い。実測: apps/alife-sketches/s57-dipolar-chains
    // のベンチマークで 5.9ms/step → 2.1ms/step。式の一致は selftest.js が pairInteractionCS と突き合わせて検査する
    // ——ホットパスと「唯一の正」の実装が黙って乖離しない保証はそこにある）。
    var isCentral = variant === 'central', isNonrecip = variant === 'nonrecip';
    for (var k = 0; k < pcount; k++) {
      var i = PI[k], j = PJ[k];
      var dx = minImage(st.x[i] - st.x[j], L), dy = minImage(st.y[i] - st.y[j], L);
      if (isoLJ) {
        var outLJ = pairInteractionLJ(dx, dy, rs, rc);
        if (!outLJ) continue;
        U += outLJ.Vwca;
        Fx[i] += outLJ.FwcaX; Fy[i] += outLJ.FwcaY;
        Fx[j] -= outLJ.FwcaX; Fy[j] -= outLJ.FwcaY;
        continue;
      }
      var r2 = dx * dx + dy * dy, r = Math.sqrt(r2);
      if (r >= rc && r >= WCA_RC) continue;
      var rhx = dx / r, rhy = dy / r;
      var fwcaX = 0, fwcaY = 0, fddX = 0, fddY = 0, taui = 0, tauj = 0;
      if (r < WCA_RC) {
        var invr2 = 1 / r2, invr6 = invr2 * invr2 * invr2;
        U += 4 * (invr6 * invr6 - invr6) + 1;
        var wmag = (48 * invr6 * invr6 - 24 * invr6) / r;
        fwcaX = wmag * rhx; fwcaY = wmag * rhy;
      }
      if (r < rc) {
        var sw = switchFn(r, rs, rc), S = sw[0], Sp = sw[1];
        var cosi = cosPhi[i], sini = sinPhi[i], cosj = cosPhi[j], sinj = sinPhi[j];
        var a = cosi * rhx + sini * rhy, b = cosj * rhx + sinj * rhy, c = cosi * cosj + sini * sinj;
        var Vdd0 = (c - 3 * a * b) / (r2 * r);
        U += S * Vdd0;
        var r4 = r2 * r2, coef = S * 3 / r4;
        fddX = coef * ((c - 5 * a * b) * rhx + b * cosi + a * cosj) - Sp * Vdd0 * rhx;
        fddY = coef * ((c - 5 * a * b) * rhy + b * sini + a * sinj) - Sp * Vdd0 * rhy;
        var uiPerpDotUj = -sini * cosj + cosi * sinj, uiPerpDotRhat = -sini * rhx + cosi * rhy;
        taui = -S * (uiPerpDotUj - 3 * b * uiPerpDotRhat) / (r2 * r);
        var ujPerpDotUi = -sinj * cosi + cosj * sini, ujPerpDotRhat = -sinj * rhx + cosj * rhy;
        tauj = -S * (ujPerpDotUi - 3 * a * ujPerpDotRhat) / (r2 * r);
      }
      var fix = fwcaX, fiy = fwcaY, fjxAdd = -fwcaX, fjyAdd = -fwcaY;
      if (isCentral) {
        var mag = fddX * rhx + fddY * rhy;
        fix += mag * rhx; fiy += mag * rhy; fjxAdd += -mag * rhx; fjyAdd += -mag * rhy;
        // torque left at the normal (non-central) value on purpose: breaks the torque balance
      } else if (isNonrecip) {
        var iEven = (i % 2) === 0, jEven = (j % 2) === 0;
        if (iEven === jEven) {
          fix += fddX; fiy += fddY; fjxAdd += -fddX; fjyAdd += -fddY;
        } else if (jEven) { fjxAdd += -fddX; fjyAdd += -fddY; taui = 0; }
        else { fix += fddX; fiy += fddY; tauj = 0; }
      } else {
        fix += fddX; fiy += fddY; fjxAdd += -fddX; fjyAdd += -fddY;
      }
      Fx[i] += fix; Fy[i] += fiy; Tau[i] += taui;
      Fx[j] += fjxAdd; Fy[j] += fjyAdd; Tau[j] += tauj;
    }
    return { Fx: Fx, Fy: Fy, Tau: Tau, U: U };
  }

  /**
   * 特定の対1組だけの診断（トルクの釣り合いサンプリング・数値勾配検査に使う）。
   * variant を渡すと computeForcesTorques と同じ変種変換（central/nonrecip）を適用する
   * ——渡さなければ 'normal'（数値勾配検査はこちらを使う。較正腕は torqueBalanceSample から
   * 実際の variant を渡して呼ぶので、E-central/E-nonrec の破れが正しく測られる）。
   */
  function pairDiagnostic(st, params, i, j, variant) {
    var L = st.L;
    var dx = minImage(st.x[i] - st.x[j], L), dy = minImage(st.y[i] - st.y[j], L);
    var out = pairInteraction(dx, dy, st.phi[i], st.phi[j], params.rs, params.rc);
    if (!out) return null;
    var fix = out.FwcaX, fiy = out.FwcaY, taui = out.taui, tauj = out.tauj;
    if (variant === 'central') {
      var mag = out.FddX * out.rhx + out.FddY * out.rhy;
      fix += mag * out.rhx; fiy += mag * out.rhy;
      // taui/tauj は通常どおり（射影された力とは食い違う→釣り合いが破れる。狙いどおり）
    } else if (variant === 'nonrecip') {
      // computeForcesTorques の nonrecip 分岐と完全に対応させる:
      //   偶数どうし・奇数どうし → 相反（通常どおり）
      //   i奇数(送り手)→j偶数(受け手) → Fix はWCAのみ・taui=0（jは通常どおり受ける、ここでは診断しない）
      //   j奇数(送り手)→i偶数(受け手) → Fix は通常どおり受ける・tauj=0
      var iEven = (i % 2) === 0, jEven = (j % 2) === 0;
      if (iEven === jEven) { fix += out.FddX; fiy += out.FddY; }
      else if (jEven) { taui = 0; }
      else { fix += out.FddX; fiy += out.FddY; tauj = 0; }
    } else {
      fix += out.FddX; fiy += out.FddY;
    }
    return { r: out.r, rijx: dx, rijy: dy, Fix: fix, Fiy: fiy, taui: taui, tauj: tauj, V: out.Vwca + out.Vdd };
  }

  // ---------------------------------------------------------------- 積分法

  function VerletIntegrator(st, params, variant) {
    this.st = st; this.params = params; this.variant = variant || 'normal';
    this.Fx = new Float64Array(st.N); this.Fy = new Float64Array(st.N); this.Tau = new Float64Array(st.N);
    this._nFx = new Float64Array(st.N); this._nFy = new Float64Array(st.N); this._nTau = new Float64Array(st.N);
    var f = computeForcesTorques(st, params, this.variant, false, this.Fx, this.Fy, this.Tau);
    this.lastU = f.U;
  }
  VerletIntegrator.prototype.step = function (dt) {
    var st = this.st, N = st.N, L = st.L, i;
    for (i = 0; i < N; i++) {
      st.x[i] = wrap(st.x[i] + st.vx[i] * dt + 0.5 * this.Fx[i] * dt * dt, L);
      st.y[i] = wrap(st.y[i] + st.vy[i] * dt + 0.5 * this.Fy[i] * dt * dt, L);
      st.phi[i] += st.omega[i] * dt + 0.5 * (this.Tau[i] / INERTIA) * dt * dt;
    }
    var f = computeForcesTorques(st, this.params, this.variant, false, this._nFx, this._nFy, this._nTau);
    var nFx = this._nFx, nFy = this._nFy, nTau = this._nTau;
    for (i = 0; i < N; i++) {
      st.vx[i] += 0.5 * (this.Fx[i] + nFx[i]) * dt;
      st.vy[i] += 0.5 * (this.Fy[i] + nFy[i]) * dt;
      st.omega[i] += 0.5 * (this.Tau[i] + nTau[i]) / INERTIA * dt;
    }
    var tx = this.Fx; this.Fx = nFx; this._nFx = tx;
    var ty = this.Fy; this.Fy = nFy; this._nFy = ty;
    var tt = this.Tau; this.Tau = nTau; this._nTau = tt;
    this.lastU = f.U;
  };

  function EulerIntegrator(st, params, variant) {
    this.st = st; this.params = params; this.variant = variant || 'normal';
  }
  EulerIntegrator.prototype.step = function (dt) {
    var st = this.st, N = st.N, L = st.L;
    var f = computeForcesTorques(st, this.params, this.variant, false);
    for (var i = 0; i < N; i++) {
      var nx = st.x[i] + st.vx[i] * dt, ny = st.y[i] + st.vy[i] * dt, nphi = st.phi[i] + st.omega[i] * dt;
      st.vx[i] += f.Fx[i] * dt; st.vy[i] += f.Fy[i] * dt; st.omega[i] += (f.Tau[i] / INERTIA) * dt;
      st.x[i] = wrap(nx, L); st.y[i] = wrap(ny, L); st.phi[i] = nphi;
    }
    this.lastU = f.U;
  };

  // ---------------------------------------------------------------- エネルギー・運動量・角運動量

  function kineticEnergy(st) {
    var N = st.N, Kt = 0, Kr = 0;
    for (var i = 0; i < N; i++) { Kt += st.vx[i] * st.vx[i] + st.vy[i] * st.vy[i]; Kr += st.omega[i] * st.omega[i]; }
    return { Ktrans: 0.5 * Kt, Krot: 0.5 * INERTIA * Kr };
  }
  function totalMomentum(st) {
    var N = st.N, px = 0, py = 0;
    for (var i = 0; i < N; i++) { px += st.vx[i]; py += st.vy[i]; }
    return { px: px, py: py };
  }
  /**
   * 全角運動量 J = Σ(x vy - y vx) + Σ I ω。**展開（非周期）座標**を渡すこと——
   * wrap された座標では孤立系でも保存しない（K-30 型の落とし穴と同型）。
   */
  function angularMomentum(st) {
    var N = st.N, J = 0;
    for (var i = 0; i < N; i++) J += st.x[i] * st.vy[i] - st.y[i] * st.vx[i] + INERTIA * st.omega[i];
    return J;
  }
  function thermostatRescale(st, Tq) {
    var N = st.N;
    var k0 = kineticEnergy(st);
    var targetKt = (N - 1) * Tq, targetKr = N * Tq / 2;
    var st_ = Math.sqrt(k0.Ktrans > 1e-300 ? targetKt / k0.Ktrans : 0);
    var sr = Math.sqrt(k0.Krot > 1e-300 ? targetKr / k0.Krot : 0);
    for (var i = 0; i < N; i++) { st.vx[i] *= st_; st.vy[i] *= st_; st.omega[i] *= sr; }
    var k1 = kineticEnergy(st);
    return (k0.Ktrans + k0.Krot) - (k1.Ktrans + k1.Krot); // 系から抜いたエネルギー（正なら抜いた）
  }
  function stateHealthy(st, expectedN) {
    if (st.N !== expectedN) return false;
    for (var i = 0; i < st.N; i++) {
      if (!isFinite(st.x[i]) || !isFinite(st.y[i]) || !isFinite(st.phi[i])) return false;
      if (!isFinite(st.vx[i]) || !isFinite(st.vy[i]) || !isFinite(st.omega[i])) return false;
      if (st.x[i] < 0 || st.x[i] >= st.L || st.y[i] < 0 || st.y[i] >= st.L) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------- 静的な参照量（登録前の計算の独立な再計算）

  function VWCA1(r) { if (r >= WCA_RC) return 0; var r6 = Math.pow(r, -6); return 4 * (r6 * r6 - r6) + 1; }
  function dVWCA1(r) { if (r >= WCA_RC) return 0; return -48 * Math.pow(r, -13) + 24 * Math.pow(r, -7); }
  function d2VWCA1(r) { if (r >= WCA_RC) return 0; return 624 * Math.pow(r, -14) - 168 * Math.pow(r, -8); }
  /** 頭尾整列・打ち切りなしの対ポテンシャル V(r) = WCA(r) - 2/r^3。 */
  function headTailV(r) { return VWCA1(r) - 2 * Math.pow(r, -3); }
  function headTaildV(r) { return dVWCA1(r) + 6 * Math.pow(r, -4); }
  function headTaild2V(r) { return d2VWCA1(r) - 24 * Math.pow(r, -5); }

  /** ニュートン法で頭尾二量体の最小（d_contact, U）を求める。 */
  function dimerMinimum() {
    var r = 1.05;
    for (var it = 0; it < 80; it++) r = r - headTaildV(r) / headTaild2V(r);
    return { d: r, U: headTailV(r), kRadial: headTaild2V(r) };
  }
  /** 端粒子（隣1個）/中間粒子（隣2個）の首振り角振動数。 */
  function librationFrequencies(d) {
    var kEnd = 2 / (d * d * d), kMid = 4 / (d * d * d);
    return { kEnd: kEnd, omegaEnd: Math.sqrt(kEnd / INERTIA), kMid: kMid, omegaMid: Math.sqrt(kMid / INERTIA) };
  }
  /** 間隔 d の直鎖（点双極子のみ、打ち切りなし）の1粒子あたりエネルギー。 */
  function chainEnergyPerParticle(n, d) {
    var U = 0;
    for (var k = 1; k < n; k++) U += (n - k) * (-2 / Math.pow(k * d, 3));
    return U / n;
  }
  /** 間隔 d（最近接）の正 n 角形環（渦状配列）の1粒子あたりエネルギー。 */
  function ringEnergyPerParticle(n, d) {
    var R = d / (2 * Math.sin(Math.PI / n));
    var px = new Float64Array(n), py = new Float64Array(n), ux = new Float64Array(n), uy = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var th = 2 * Math.PI * i / n;
      px[i] = R * Math.cos(th); py[i] = R * Math.sin(th);
      ux[i] = -Math.sin(th); uy[i] = Math.cos(th);
    }
    var U = 0;
    for (i = 0; i < n; i++) for (var j = i + 1; j < n; j++) {
      var dx = px[i] - px[j], dy = py[i] - py[j], r = Math.sqrt(dx * dx + dy * dy);
      var rhx = dx / r, rhy = dy / r;
      var a = ux[i] * rhx + uy[i] * rhy, b = ux[j] * rhx + uy[j] * rhy, c = ux[i] * ux[j] + uy[i] * uy[j];
      U += (c - 3 * a * b) / (r * r * r);
    }
    return U / n;
  }
  /** 無限鎖の1粒子あたり、r>rs の対からの寄与（打ち切りで落ちる尾。K→200000で収束）。 */
  function truncationTail(rs, d) {
    var s = 0;
    for (var k = 1; k < 200000; k++) { if (k * d > rs) s += 1 / (k * k * k); }
    return -2 / (d * d * d) * s;
  }

  var api = {
    INERTIA: INERTIA, WCA_RC: WCA_RC,
    rng: rng, subStream: subStream, gaussian: gaussian, hashState: hashState,
    wrap: wrap, minImage: minImage,
    createSystem: createSystem, cloneSystem: cloneSystem,
    sequentialRandomFill: sequentialRandomFill, uniformOrientations: uniformOrientations,
    maxwellVelocities: maxwellVelocities, maxwellAngularVelocities: maxwellAngularVelocities, zeroMomentum: zeroMomentum,
    switchFn: switchFn, pairInteraction: pairInteraction, pairInteractionCS: pairInteractionCS,
    pairInteractionLJ: pairInteractionLJ, pairDiagnostic: pairDiagnostic,
    neighborPairsCellList: neighborPairsCellList, neighborPairsBrute: neighborPairsBrute,
    computeForcesTorques: computeForcesTorques,
    VerletIntegrator: VerletIntegrator, EulerIntegrator: EulerIntegrator,
    kineticEnergy: kineticEnergy, totalMomentum: totalMomentum, angularMomentum: angularMomentum,
    thermostatRescale: thermostatRescale, stateHealthy: stateHealthy,
    dimerMinimum: dimerMinimum, librationFrequencies: librationFrequencies,
    chainEnergyPerParticle: chainEnergyPerParticle, ringEnergyPerParticle: ringEnergyPerParticle,
    truncationTail: truncationTail,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.S57 = api;
  if (typeof global !== 'undefined' && global && !global.S57) global.S57 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
