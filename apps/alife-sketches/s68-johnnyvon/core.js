/**
 * S-68 JohnnyVon: 核（core）。連続2次元空間を漂う T 字形 codon の場の力学と、
 * 局所の有限状態機械（自分と、結合で指す最大3つの近傍の状態だけを読む）だけを持つ。
 * criteria.json system / splitRuleAudit を参照。**上位概念の語彙を持たない**——
 * 鎖・二本鎖・系譜・個体・選択の速さ等の指標はここに無い（観測器 detectors.js の仕事）。
 * Node とブラウザで共用（UMD）。依存ゼロ。
 *
 * 状態は codon ごとの位置・角・速度・型・結合の指し先・2つの有限状態・2つの時計だけ
 * （criteria.json system.state）。N は走行中ずっと固定（88）——流れの腕は codon を
 * 「置き換える」だけで、配列を伸び縮みさせない。
 */
(function (global) {
  'use strict';

  var PI = Math.PI;
  var TWO_PI = 2 * PI;

  // ---- 定数（criteria.json borrowedConstants・staticPrecomputation.derivedConstants） ----
  var DT = 0.15;
  var MASS = 1;
  var INERTIA = 13.888888888888889; // Σ(ℓ/18)·ℓ²/3, 赤7・青7・紫緑4（黄は縦棒に重なるので数えない）
  var ARM_LEN = { red: 7, blue: 7, py: 4, yellow: 1 };
  var RADIUS_SMALL = 0.01;
  var RADIUS_LARGE_YELLOW = 6;
  var RADIUS_LARGE_OTHER = 4;
  var ARM_FORCE_RB = 1.8;
  var ARM_FORCE_PY = 1.0;
  var STRAIGHTEN_RB = 1.0;
  var STRAIGHTEN_PY = 0.5;
  var ANGLE_TOL_RB_DEFAULT = PI / 256;
  var ANGLE_TOL_RB_WIDE = PI / 64;
  var ANGLE_TOL_PY = PI / 3;
  var SPLIT_HOLD_STEPS = 1000; // iterations_after_split = 150 / dt
  var A_V = Math.pow(0.9, DT);   // linear_viscosity 側の残存率
  var A_W = Math.pow(0.95, DT);  // angular_viscosity 側の残存率
  var C_L = 1 - Math.pow(0.1, DT);  // linear_spring_damping
  var C_A = 1 - Math.pow(0.01, DT); // angular_spring_damping

  var SLS_0 = 0, SLS_1 = 1, SLS_2 = 2;
  var SPS_X = 0, SPS_Y = 1, SPS_Z = 2;

  function normalizeAngle(a) {
    a = a % TWO_PI;
    if (a <= -PI) a += TWO_PI;
    if (a > PI) a -= TWO_PI;
    return a;
  }

  // ---- 乱数（mulberry32 + Box-Muller）。シード固定で完全に再現する ----
  function makeRng(seed) {
    var s = seed >>> 0;
    function next() {
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    var spareGauss = null;
    return {
      next: next,
      gauss: function () {
        if (spareGauss !== null) { var g = spareGauss; spareGauss = null; return g; }
        var u1 = Math.max(next(), 1e-12), u2 = next();
        var r = Math.sqrt(-2 * Math.log(u1));
        var theta = TWO_PI * u2;
        spareGauss = r * Math.sin(theta);
        return r * Math.cos(theta);
      },
      int: function (n) { return Math.floor(next() * n); },
    };
  }
  /** 文字列タグから決定的に派生シードを作る（32bit）。較正・観測器の乱数を本筋の乱数から分ける。 */
  function subSeed(seed, tag) {
    var h = (seed >>> 0) ^ 0x9E3779B9;
    for (var i = 0; i < tag.length; i++) { h = Math.imul(h ^ tag.charCodeAt(i), 0x85EBCA6B); h ^= h >>> 13; }
    return (h ^ (h >>> 16)) >>> 0;
  }

  // ---- FSM局所性の計装（selftest K-139 / splitRuleAudit.enforcement が読む） ----
  var FSM_STATS = { calls: 0, maxCodonsPerCall: 0, everExceeded4: false };
  function resetFsmStats() { FSM_STATS.calls = 0; FSM_STATS.maxCodonsPerCall = 0; FSM_STATS.everExceeded4 = false; }
  function getFsmStats() { return { calls: FSM_STATS.calls, maxCodonsPerCall: FSM_STATS.maxCodonsPerCall, everExceeded4: FSM_STATS.everExceeded4 }; }

  /**
   * 状態機械の純粋関数。受け取れるのは「自分」と「結合で指す近傍（最大3つ）」の状態の写しだけ
   * （sls・sps・zClock のみ）。連結成分やグラフ探索は一切行わない——それは観測器の仕事。
   * self: { sls, sps, zClock, hasRed, hasBlue, hasPy }
   * red/blue/py: { sls, sps } または null（近傍がいない）
   */
  function fsmStep(self, red, blue, py) {
    FSM_STATS.calls++;
    var n = 1 + (red ? 1 : 0) + (blue ? 1 : 0) + (py ? 1 : 0);
    if (n > FSM_STATS.maxCodonsPerCall) FSM_STATS.maxCodonsPerCall = n;
    if (n > 4) FSM_STATS.everExceeded4 = true;

    var exactlyOneRB = (self.hasRed ? 1 : 0) + (self.hasBlue ? 1 : 0) === 1;
    var hasPy = self.hasPy;
    var pySls = py ? py.sls : null; // 近傍がいなければ「その近傍の状態」は偽と読む

    // strand_location_state（Table 4）
    var newSls;
    if (self.sls === SLS_0) {
      newSls = (exactlyOneRB && hasPy) ? SLS_1 : SLS_0;
    } else if (self.sls === SLS_1) {
      if (!exactlyOneRB || !hasPy) newSls = SLS_0;
      else if (hasPy && (pySls === SLS_1 || pySls === SLS_2)) newSls = SLS_2;
      else newSls = SLS_1;
    } else { // SLS_2
      if (!exactlyOneRB || !hasPy || (hasPy && pySls === SLS_0)) newSls = SLS_0;
      else newSls = SLS_2;
    }

    // splitting_state（Table 5）。「自分が2」等は strand_location_state（self.sls、更新前の値）を読む
    var pyNot1 = hasPy ? (pySls !== SLS_1) : false; // 近傍がいなければ偽（K-139 の absentNeighbour）
    var newSps;
    if (self.sps === SPS_X) {
      var toY = (self.sls === SLS_2 && hasPy && pySls === SLS_2 && !self.hasRed) ||
        (self.sls !== SLS_1 && pyNot1 && (red ? red.sps === SPS_Y : false));
      newSps = toY ? SPS_Y : SPS_X;
    } else if (self.sps === SPS_Y) {
      var toZ = (self.sls === SLS_2 && hasPy && pySls === SLS_2 && !self.hasBlue) ||
        (self.sls !== SLS_1 && pyNot1 && (blue ? blue.sps === SPS_Z : false));
      newSps = toZ ? SPS_Z : SPS_Y;
    } else { // SPS_Z
      var toX = (!self.hasRed && self.zClock >= SPLIT_HOLD_STEPS) || (red ? red.sps === SPS_X : false);
      newSps = toX ? SPS_X : SPS_Z;
    }
    return { sls: newSls, sps: newSps };
  }

  // ---- 系の生成 ----
  function makeSystem(N, L) {
    var A = function (T) { return new T(N); };
    return {
      N: N, L: L, step: 0,
      x: A(Float64Array), y: A(Float64Array), phi: A(Float64Array),
      vx: A(Float64Array), vy: A(Float64Array), w: A(Float64Array),
      type: A(Uint8Array),
      redBond: fillInt32(N, -1), blueBond: fillInt32(N, -1), pyBond: fillInt32(N, -1),
      sls: A(Uint8Array), sps: A(Uint8Array),
      zClock: A(Uint32Array), yellowClock: A(Uint32Array), yellowLarge: A(Uint8Array),
      birthId: A(Uint32Array), nextBirthId: N,
      ledger: { Q_bath: 0, D_damp: 0, J_form: 0, J_break: 0, J_yellow_on: 0, J_yellow_off: 0, W_straight: 0, J_turnover_out: 0, J_turnover_in: 0 },
      maxForceRatio: 0,
    };
  }
  function fillInt32(n, v) { var a = new Int32Array(n); a.fill(v); return a; }

  function dirVec(a) { return [Math.cos(a), Math.sin(a)]; }
  function armDir(sys, i, color) {
    var phi = sys.phi[i];
    if (color === 'red') return phi + PI;
    if (color === 'blue') return phi;
    return phi + PI / 2; // 'py' か 'yellow'
  }
  function tip(sys, i, color) {
    var d = armDir(sys, i, color);
    var v = dirVec(d);
    var len = ARM_LEN[color];
    return [sys.x[i] + v[0] * len, sys.y[i] + v[1] * len];
  }
  function yellowCenter(sys, i) { return tip(sys, i, 'yellow'); }
  /**
   * 全 codon の4種の腕の先端座標を一度に計算する（性能用）。cos/sin は codon ごとに1回だけ
   * 計算し、符号の反転で4本の腕へ使い回す（tip() の毎回の三角関数呼び出しと配列確保を避ける）。
   */
  function computeArmTips(sys) {
    var N = sys.N;
    var redX = new Float64Array(N), redY = new Float64Array(N);
    var blueX = new Float64Array(N), blueY = new Float64Array(N);
    var pyX = new Float64Array(N), pyY = new Float64Array(N);
    var yelX = new Float64Array(N), yelY = new Float64Array(N);
    for (var i = 0; i < N; i++) {
      var c = Math.cos(sys.phi[i]), s = Math.sin(sys.phi[i]);
      redX[i] = sys.x[i] - 7 * c; redY[i] = sys.y[i] - 7 * s;
      blueX[i] = sys.x[i] + 7 * c; blueY[i] = sys.y[i] + 7 * s;
      pyX[i] = sys.x[i] - 4 * s; pyY[i] = sys.y[i] + 4 * c;
      yelX[i] = sys.x[i] - 1 * s; yelY[i] = sys.y[i] + 1 * c;
    }
    return { redX: redX, redY: redY, blueX: blueX, blueY: blueY, pyX: pyX, pyY: pyY, yelX: yelX, yelY: yelY };
  }
  function pyRadius(sys, i, params) {
    if (params.forcePySmall) return RADIUS_SMALL;
    return (sys.redBond[i] !== -1 || sys.blueBond[i] !== -1) ? RADIUS_LARGE_OTHER : RADIUS_SMALL;
  }
  function yellowRadius(sys, i) { return sys.yellowLarge[i] ? RADIUS_LARGE_YELLOW : RADIUS_SMALL; }

  /** 種の準備した seed の初期状態を作る（system.initial）。spec.arm に応じた腕の初期状態。 */
  function buildInitial(spec) {
    var N = spec.N || 88;
    var L = spec.L || 165;
    var sys = makeSystem(N, L);
    var rng = makeRng(spec.seed >>> 0);
    var idx = 0;

    function placeSeedChain(startIdx, typesStr, cx, cy) {
      var n = typesStr.length;
      var totalW = (n - 1) * 14;
      var x0 = cx - totalW / 2;
      for (var k = 0; k < n; k++) {
        var i = startIdx + k;
        sys.x[i] = x0 + k * 14; sys.y[i] = cy; sys.phi[i] = 0;
        sys.vx[i] = 0; sys.vy[i] = 0; sys.w[i] = 0;
        sys.type[i] = typesStr.charAt(k) === '1' ? 1 : 0;
        sys.sls[i] = 0; sys.sps[i] = 0;
        if (k > 0) { sys.blueBond[i - 1] = i; sys.redBond[i] = i - 1; }
        sys.birthId[i] = i;
      }
      return startIdx + n;
    }
    function placeFree(startIdx, count, typeBalanced) {
      var types = [];
      if (typeBalanced) {
        for (var t = 0; t < count; t++) types.push(t < count / 2 ? 0 : 1);
        // Fisher-Yates シャッフル（この seed の乱数で）
        for (var s = types.length - 1; s > 0; s--) { var j = rng.int(s + 1); var tmp = types[s]; types[s] = types[j]; types[j] = tmp; }
      }
      var sigmaV = Math.sqrt(spec.kT / MASS), sigmaW = Math.sqrt(spec.kT / INERTIA);
      for (var k = 0; k < count; k++) {
        var i = startIdx + k;
        sys.x[i] = rng.next() * L; sys.y[i] = rng.next() * L; sys.phi[i] = (rng.next() * TWO_PI) - PI;
        sys.vx[i] = rng.gauss() * sigmaV; sys.vy[i] = rng.gauss() * sigmaV; sys.w[i] = rng.gauss() * sigmaW;
        sys.type[i] = typeBalanced ? types[k] : (rng.next() < 0.5 ? 0 : 1);
        sys.sls[i] = 0; sys.sps[i] = 0;
        sys.birthId[i] = i;
      }
      return startIdx + count;
    }

    if (spec.arm === 'R-seed8' || spec.arm === 'NC-nosplit') {
      idx = placeSeedChain(0, '00011001', L / 2, L / 2);
      idx = placeFree(idx, N - idx, true);
    } else if (spec.arm === 'R-seed82') {
      idx = placeSeedChain(0, '00011001', L / 2, L / 2);
      idx = placeSeedChain(idx, '00', L / 2, L / 4);
      idx = placeFree(idx, N - idx, true);
    } else {
      idx = placeFree(0, N, true);
    }
    sys.nextBirthId = N;
    return sys;
  }

  function stateHash(sys) {
    // 決定性の確認用の軽いハッシュ（暗号強度は要らない）。浮動小数は固定小数へ丸めてから畳み込む。
    var h1 = 2166136261 >>> 0;
    function mix(v) { h1 = Math.imul(h1 ^ v, 16777619) >>> 0; }
    function mixFloat(f) { mix(Math.round(f * 1e6) | 0); }
    for (var i = 0; i < sys.N; i++) {
      mixFloat(sys.x[i]); mixFloat(sys.y[i]); mixFloat(sys.phi[i]);
      mixFloat(sys.vx[i]); mixFloat(sys.vy[i]); mixFloat(sys.w[i]);
      mix(sys.type[i]); mix(sys.redBond[i] + 1); mix(sys.blueBond[i] + 1); mix(sys.pyBond[i] + 1);
      mix(sys.sls[i]); mix(sys.sps[i]); mix(sys.zClock[i]); mix(sys.yellowClock[i]); mix(sys.yellowLarge[i]);
    }
    return ('00000000' + h1.toString(16)).slice(-8);
  }

  function snapshot(sys) {
    var codons = [];
    for (var i = 0; i < sys.N; i++) {
      codons.push({
        i: i, birthId: sys.birthId[i],
        x: Math.round(sys.x[i] * 100) / 100, y: Math.round(sys.y[i] * 100) / 100, phi: Math.round(sys.phi[i] * 1000) / 1000,
        type: sys.type[i], red: sys.redBond[i], blue: sys.blueBond[i], py: sys.pyBond[i],
        sls: sys.sls[i], sps: sys.sps[i], yellowLarge: sys.yellowLarge[i],
      });
    }
    return { step: sys.step, codons: codons };
  }

  function kineticEnergy(sys) {
    var ke = 0;
    for (var i = 0; i < sys.N; i++) ke += 0.5 * MASS * (sys.vx[i] * sys.vx[i] + sys.vy[i] * sys.vy[i]) + 0.5 * INERTIA * sys.w[i] * sys.w[i];
    return ke;
  }
  function springEnergy(sys) {
    var pe = 0;
    for (var i = 0; i < sys.N; i++) {
      var j = sys.blueBond[i];
      if (j !== -1) { var tr = tip(sys, i, 'blue'), tb = tip(sys, j, 'red'); pe += 0.5 * ARM_FORCE_RB * dist2(tr, tb); }
      var k = sys.pyBond[i];
      if (k !== -1 && i < k) { var tp1 = tip(sys, i, 'py'), tp2 = tip(sys, k, 'py'); pe += 0.5 * ARM_FORCE_PY * dist2(tp1, tp2); }
    }
    return pe;
  }
  function yellowEnergy(sys, params) {
    var pe = 0;
    var largeList = [];
    for (var i = 0; i < sys.N; i++) if (sys.yellowLarge[i]) largeList.push(i);
    for (var a = 0; a < largeList.length; a++) for (var b = a + 1; b < largeList.length; b++) {
      var i = largeList[a], j = largeList[b];
      var d = Math.sqrt(dist2(yellowCenter(sys, i), yellowCenter(sys, j)));
      if (d < 12) pe += 0.5 * params.c_y * (12 - d) * (12 - d);
    }
    return pe;
  }
  function totalEnergy(sys, params) { return kineticEnergy(sys) + springEnergy(sys) + yellowEnergy(sys, params); }
  function dist2(a, b) { var dx = a[0] - b[0], dy = a[1] - b[1]; return dx * dx + dy * dy; }

  /**
   * 1歩進める。events はこの歩に起きた出来事の配列（呼び出し側が rawLogPlan へ流す）。
   * params: { kT, c_y, delta, angleTolRB, forcePySmall, forceYellowSmall, turnoverEnabled, L }
   */
  function step(sys, rng, params) {
    var N = sys.N, L = sys.L;
    var events = [];
    var Fx = new Float64Array(N), Fy = new Float64Array(N), Tq = new Float64Array(N);
    var tips0 = computeArmTips(sys); // 現在の状態（力を計算する時点）の腕の先端

    // ①力とトルク（現在の状態から）
    function addForce(i, fx, fy, ax, ay) {
      Fx[i] += fx; Fy[i] += fy;
      Tq[i] += (ax - sys.x[i]) * fy - (ay - sys.y[i]) * fx;
    }
    // 結合ばね（赤青・紫緑）
    for (var i = 0; i < N; i++) {
      var j = sys.blueBond[i];
      if (j !== -1) {
        var fx = ARM_FORCE_RB * (tips0.redX[j] - tips0.blueX[i]), fy = ARM_FORCE_RB * (tips0.redY[j] - tips0.blueY[i]);
        addForce(i, fx, fy, tips0.blueX[i], tips0.blueY[i]); addForce(j, -fx, -fy, tips0.redX[j], tips0.redY[j]);
      }
    }
    for (i = 0; i < N; i++) {
      var k = sys.pyBond[i];
      if (k !== -1 && i < k) {
        var fx2 = ARM_FORCE_PY * (tips0.pyX[k] - tips0.pyX[i]), fy2 = ARM_FORCE_PY * (tips0.pyY[k] - tips0.pyY[i]);
        addForce(i, fx2, fy2, tips0.pyX[i], tips0.pyY[i]); addForce(k, -fx2, -fy2, tips0.pyX[k], tips0.pyY[k]);
      }
    }
    // 黄の斥力
    var largeList = [];
    for (i = 0; i < N; i++) if (sys.yellowLarge[i]) largeList.push(i);
    for (var a = 0; a < largeList.length; a++) for (var b = a + 1; b < largeList.length; b++) {
      var yi = largeList[a], yj = largeList[b];
      var dx = tips0.yelX[yi] - tips0.yelX[yj], dy = tips0.yelY[yi] - tips0.yelY[yj];
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d > 0 && d < 12) {
        var mag = params.c_y * (12 - d);
        var ux = dx / d, uy = dy / d; // yj から yi へ押す向き
        var frx = mag * ux, fry = mag * uy;
        addForce(yi, frx, fry, tips0.yelX[yi], tips0.yelY[yi]); addForce(yj, -frx, -fry, tips0.yelX[yj], tips0.yelY[yj]);
      }
    }
    // まっすぐにする力（回転だけ。反作用なし）
    for (i = 0; i < N; i++) applyStraighten(i, 'blue', sys.blueBond[i], STRAIGHTEN_RB);
    for (i = 0; i < N; i++) applyStraighten(i, 'red', sys.redBond[i], STRAIGHTEN_RB);
    for (i = 0; i < N; i++) applyStraighten(i, 'py', sys.pyBond[i], STRAIGHTEN_PY);
    function applyStraighten(i, color, j, s) {
      if (j === -1) return;
      var armAngle = armDir(sys, i, color);
      var toPartner = Math.atan2(sys.y[j] - sys.y[i], sys.x[j] - sys.x[i]);
      var theta = normalizeAngle(armAngle - toPartner);
      Tq[i] += -s * theta;
    }
    var netFx = 0, netFy = 0, sumAbsAll = 1e-300;
    for (i = 0; i < N; i++) { netFx += Fx[i]; netFy += Fy[i]; sumAbsAll += Math.abs(Fx[i]) + Math.abs(Fy[i]); }
    var forceRatio = (Math.abs(netFx) + Math.abs(netFy)) / sumAbsAll;
    sys.maxForceRatio = Math.max(sys.maxForceRatio, forceRatio);

    // W_straight: まっすぐにする力（非保存・反作用なし）だけがωに与える厳密なΔKE。
    // ステップ②の速度更新の前のω（wBefore）から、その力の分だけを単独で加えた場合の
    // ΔKE=½I((w+Δw)²−w²)で測る（保存力＝ばね・黄の分は⑤で位置が動きポテンシャルが変化した
    // 時点で相殺される想定なので口座を立てない。残差にO(dt)の誤差として現れる。K-146・記録のみ）
    var wBefore = sys.w.slice();
    var wStraightSum = 0;
    for (i = 0; i < N; i++) {
      var tqStraight = 0;
      if (sys.blueBond[i] !== -1) tqStraight += strAngleTorque(i, 'blue', sys.blueBond[i], STRAIGHTEN_RB);
      if (sys.redBond[i] !== -1) tqStraight += strAngleTorque(i, 'red', sys.redBond[i], STRAIGHTEN_RB);
      if (sys.pyBond[i] !== -1) tqStraight += strAngleTorque(i, 'py', sys.pyBond[i], STRAIGHTEN_PY);
      var dw = tqStraight * DT / INERTIA;
      wStraightSum += 0.5 * INERTIA * ((wBefore[i] + dw) * (wBefore[i] + dw) - wBefore[i] * wBefore[i]);
    }
    function strAngleTorque(i, color, j, s) {
      var armAngle = armDir(sys, i, color);
      var toPartner = Math.atan2(sys.y[j] - sys.y[i], sys.x[j] - sys.x[i]);
      return -s * normalizeAngle(armAngle - toPartner);
    }
    sys.ledger.W_straight += wStraightSum;

    // ②速度の更新
    for (i = 0; i < N; i++) { sys.vx[i] += Fx[i] * DT / MASS; sys.vy[i] += Fy[i] * DT / MASS; sys.w[i] += Tq[i] * DT / INERTIA; }

    // ③ばねの減衰（結合の番号順）
    var keBefore2 = kineticEnergy(sys);
    for (i = 0; i < N; i++) {
      var jb = sys.blueBond[i];
      if (jb !== -1) dampPair(i, jb);
    }
    for (i = 0; i < N; i++) {
      var jp = sys.pyBond[i];
      if (jp !== -1 && i < jp) dampPair(i, jp);
    }
    function dampPair(p, q) {
      var avx = (sys.vx[p] + sys.vx[q]) / 2, avy = (sys.vy[p] + sys.vy[q]) / 2;
      sys.vx[p] += C_L * (avx - sys.vx[p]); sys.vy[p] += C_L * (avy - sys.vy[p]);
      sys.vx[q] += C_L * (avx - sys.vx[q]); sys.vy[q] += C_L * (avy - sys.vy[q]);
      sys.w[p] *= (1 - C_A); sys.w[q] *= (1 - C_A);
    }
    var keAfter2 = kineticEnergy(sys);
    sys.ledger.D_damp += (keAfter2 - keBefore2);

    // ④粘性と熱浴
    var sigmaV = 0.176391 * Math.sqrt(params.kT), sigmaW = 0.033158 * Math.sqrt(params.kT);
    var keBefore3 = kineticEnergy(sys);
    for (i = 0; i < N; i++) {
      sys.vx[i] = A_V * sys.vx[i] + sigmaV * rng.gauss();
      sys.vy[i] = A_V * sys.vy[i] + sigmaV * rng.gauss();
      sys.w[i] = A_W * sys.w[i] + sigmaW * rng.gauss();
    }
    var keAfter3 = kineticEnergy(sys);
    sys.ledger.Q_bath += (keAfter3 - keBefore3);

    // ⑤位置の更新
    for (i = 0; i < N; i++) { sys.x[i] += sys.vx[i] * DT; sys.y[i] += sys.vy[i] * DT; sys.phi[i] += sys.w[i] * DT; }
    // ⑥壁（鏡映反射）
    for (i = 0; i < N; i++) {
      if (sys.x[i] < 0) { sys.x[i] = -sys.x[i]; sys.vx[i] = -sys.vx[i]; }
      else if (sys.x[i] > L) { sys.x[i] = 2 * L - sys.x[i]; sys.vx[i] = -sys.vx[i]; }
      if (sys.y[i] < 0) { sys.y[i] = -sys.y[i]; sys.vy[i] = -sys.vy[i]; }
      else if (sys.y[i] > L) { sys.y[i] = 2 * L - sys.y[i]; sys.vy[i] = -sys.vy[i]; }
    }

    var tips1 = computeArmTips(sys); // 移動後（切断・生成の判定はこちら）

    // ⑦結合の切断
    for (i = 0; i < N; i++) {
      var jbb = sys.blueBond[i];
      if (jbb !== -1) {
        var dxbb = tips1.blueX[i] - tips1.redX[jbb], dybb = tips1.blueY[i] - tips1.redY[jbb];
        var d2 = Math.sqrt(dxbb * dxbb + dybb * dybb);
        if (d2 > RADIUS_LARGE_OTHER + RADIUS_LARGE_OTHER) {
          var pe = 0.5 * ARM_FORCE_RB * (RADIUS_LARGE_OTHER + RADIUS_LARGE_OTHER) * (RADIUS_LARGE_OTHER + RADIUS_LARGE_OTHER);
          sys.ledger.J_break += pe;
          events.push({ type: 'rb-break', step: sys.step, i: i, j: jbb, cause: 'distance' });
          sys.blueBond[i] = -1; sys.redBond[jbb] = -1;
        }
      }
    }
    for (i = 0; i < N; i++) {
      var jpp = sys.pyBond[i];
      if (jpp !== -1 && i < jpp) {
        var rI = pyRadius(sys, i, params), rJ = pyRadius(sys, jpp, params);
        var dxpp = tips1.pyX[i] - tips1.pyX[jpp], dypp = tips1.pyY[i] - tips1.pyY[jpp];
        var dpy = Math.sqrt(dxpp * dxpp + dypp * dypp);
        if (dpy > rI + rJ) {
          var pe2 = 0.5 * ARM_FORCE_PY * (rI + rJ) * (rI + rJ);
          sys.ledger.J_break += pe2;
          events.push({ type: 'pg-break', step: sys.step, i: i, j: jpp, cause: 'distance' });
          sys.pyBond[i] = -1; sys.pyBond[jpp] = -1;
        }
      }
    }

    // ⑧結合の生成（先端の座標は tips1 を使い回す。O(N^2) だが N=88 でスカラー演算だけなので軽い）
    formBonds();
    function formBonds() {
      var tolRB = params.angleTolRB || ANGLE_TOL_RB_DEFAULT;
      var candRB = [];
      for (var ii = 0; ii < N; ii++) {
        if (sys.redBond[ii] !== -1) continue;
        var rx = tips1.redX[ii], ry = tips1.redY[ii], phiI = sys.phi[ii];
        for (var jj = 0; jj < N; jj++) {
          if (ii === jj || sys.blueBond[jj] !== -1) continue;
          var ddx = rx - tips1.blueX[jj], ddy = ry - tips1.blueY[jj];
          var dd2 = ddx * ddx + ddy * ddy;
          if (dd2 >= 0.0004) continue; // 0.02^2
          var ang = Math.abs(normalizeAngle(sys.phi[jj] - phiI));
          if (ang > tolRB) continue;
          candRB.push({ i: ii, j: jj, d: Math.sqrt(dd2) });
        }
      }
      candRB.sort(function (p, q) { return p.d - q.d || (p.i - q.i) || (p.j - q.j); });
      var rejectedRB = 0;
      candRB.forEach(function (c) {
        if (sys.redBond[c.i] !== -1 || sys.blueBond[c.j] !== -1) { rejectedRB++; return; }
        sys.redBond[c.i] = c.j; sys.blueBond[c.j] = c.i;
        var pe = 0.5 * ARM_FORCE_RB * c.d * c.d;
        sys.ledger.J_form += pe;
        events.push({ type: 'rb-form', step: sys.step, i: c.i, j: c.j, d: c.d, ctx: bondContext(c.i, c.j) });
      });
      if (rejectedRB > 0) events.push({ type: 'rb-conflict', step: sys.step, rejected: rejectedRB });

      var candPY = [];
      for (var pi = 0; pi < N; pi++) {
        if (sys.pyBond[pi] !== -1 || sys.type[pi] !== 0) continue; // 紫（型0）から緑（型1）へ
        var pix = tips1.pyX[pi], piy = tips1.pyY[pi], phiP = sys.phi[pi];
        var riOuter = pyRadius(sys, pi, params);
        for (var pj = 0; pj < N; pj++) {
          if (pi === pj || sys.pyBond[pj] !== -1 || sys.type[pj] !== 1) continue;
          var rj = pyRadius(sys, pj, params);
          if (riOuter === RADIUS_LARGE_OTHER && rj === RADIUS_LARGE_OTHER) continue; // large同士は始めない
          var pdx = pix - tips1.pyX[pj], pdy = piy - tips1.pyY[pj];
          var dp2 = pdx * pdx + pdy * pdy;
          var rsum = riOuter + rj;
          if (dp2 >= rsum * rsum) continue;
          var angp = Math.abs(normalizeAngle(phiP - sys.phi[pj] - PI));
          if (angp > ANGLE_TOL_PY) continue;
          candPY.push({ i: pi, j: pj, d: Math.sqrt(dp2) });
        }
      }
      candPY.sort(function (p, q) { return p.d - q.d || (p.i - q.i) || (p.j - q.j); });
      var rejectedPY = 0;
      candPY.forEach(function (c) {
        if (sys.pyBond[c.i] !== -1 || sys.pyBond[c.j] !== -1) { rejectedPY++; return; }
        sys.pyBond[c.i] = c.j; sys.pyBond[c.j] = c.i;
        var pe2 = 0.5 * ARM_FORCE_PY * c.d * c.d;
        sys.ledger.J_form += pe2;
        events.push({ type: 'pg-form', step: sys.step, i: c.i, j: c.j, d: c.d });
      });
      if (rejectedPY > 0) events.push({ type: 'pg-conflict', step: sys.step, rejected: rejectedPY });
    }
    function bondContext(i, j) {
      var iHeld = sys.pyBond[i] !== -1, jHeld = sys.pyBond[j] !== -1;
      if (!iHeld && !jHeld) return 'spontaneous';
      if (iHeld && jHeld) return 'template';
      return 'semi-held';
    }

    // ⑨場の大きさ（赤青・紫緑は導出。黄は状態機械の結果で⑩と一緒に扱う）
    // ⑩状態機械と時計（同期更新。旧状態から新状態へ）
    var oldSls = sys.sls.slice(), oldSps = sys.sps.slice(), oldZClock = sys.zClock.slice();
    var newSls = new Uint8Array(N), newSps = new Uint8Array(N);
    for (i = 0; i < N; i++) {
      var r = sys.redBond[i], bl = sys.blueBond[i], py = sys.pyBond[i];
      var self = { sls: oldSls[i], sps: oldSps[i], zClock: oldZClock[i], hasRed: r !== -1, hasBlue: bl !== -1, hasPy: py !== -1 };
      var redN = r !== -1 ? { sls: oldSls[r], sps: oldSps[r] } : null;
      var blueN = bl !== -1 ? { sls: oldSls[bl], sps: oldSps[bl] } : null;
      var pyN = py !== -1 ? { sls: oldSls[py], sps: oldSps[py] } : null;
      var out = fsmStep(self, redN, blueN, pyN);
      newSls[i] = out.sls; newSps[i] = out.sps;
    }
    for (i = 0; i < N; i++) {
      var enteredZ = newSps[i] === SPS_Z && oldSps[i] !== SPS_Z;
      sys.sls[i] = newSls[i]; sys.sps[i] = newSps[i];
      if (newSps[i] === SPS_Z) sys.zClock[i] = (oldSps[i] === SPS_Z) ? oldZClock[i] + 1 : 1;
      else sys.zClock[i] = 0;
      if (enteredZ && !params.forceYellowSmall) {
        var before = pairYellowEnergyOf(i);
        sys.yellowLarge[i] = 1; sys.yellowClock[i] = 0;
        var after = pairYellowEnergyOf(i);
        sys.ledger.J_yellow_on += (after - before);
        events.push({ type: 'z-enter', step: sys.step, i: i });
      } else if (enteredZ) {
        events.push({ type: 'z-enter', step: sys.step, i: i });
      }
      if (sys.yellowLarge[i]) {
        sys.yellowClock[i]++;
        if (sys.yellowClock[i] >= SPLIT_HOLD_STEPS) {
          var before2 = pairYellowEnergyOf(i);
          sys.yellowLarge[i] = 0; sys.yellowClock[i] = 0;
          var after2 = pairYellowEnergyOf(i);
          sys.ledger.J_yellow_off += (before2 - after2);
          events.push({ type: 'yellow-off', step: sys.step, i: i });
        }
      }
    }
    function pairYellowEnergyOf(idx) {
      if (!sys.yellowLarge[idx]) return 0;
      var pe = 0, ci = yellowCenter(sys, idx);
      for (var m = 0; m < N; m++) {
        if (m === idx || !sys.yellowLarge[m]) continue;
        var d = Math.sqrt(dist2(ci, yellowCenter(sys, m)));
        if (d < 12) pe += 0.5 * params.c_y * (12 - d) * (12 - d);
      }
      return pe;
    }

    // ⑪入れ替え（流れの腕のみ）
    if (params.turnoverEnabled && params.delta > 0) {
      for (i = 0; i < N; i++) {
        if (rng.next() >= params.delta) continue;
        var keOld = 0.5 * MASS * (sys.vx[i] * sys.vx[i] + sys.vy[i] * sys.vy[i]) + 0.5 * INERTIA * sys.w[i] * sys.w[i];
        sys.ledger.J_turnover_out += keOld;
        // 結合を強制的に外す（相手の指し先も消す）。断裂扱いで J_break を積む
        breakAllBonds(i);
        var oldType = sys.type[i];
        sys.x[i] = rng.next() * L; sys.y[i] = rng.next() * L; sys.phi[i] = rng.next() * TWO_PI - PI;
        var sV = Math.sqrt(params.kT / MASS), sW = Math.sqrt(params.kT / INERTIA);
        sys.vx[i] = rng.gauss() * sV; sys.vy[i] = rng.gauss() * sV; sys.w[i] = rng.gauss() * sW;
        sys.type[i] = rng.next() < 0.5 ? 0 : 1;
        sys.sls[i] = 0; sys.sps[i] = 0; sys.zClock[i] = 0; sys.yellowClock[i] = 0; sys.yellowLarge[i] = 0;
        var keNew = 0.5 * MASS * (sys.vx[i] * sys.vx[i] + sys.vy[i] * sys.vy[i]) + 0.5 * INERTIA * sys.w[i] * sys.w[i];
        sys.ledger.J_turnover_in += keNew;
        var oldBirth = sys.birthId[i];
        sys.birthId[i] = sys.nextBirthId++;
        events.push({ type: 'turnover', step: sys.step, i: i, oldBirthId: oldBirth, newBirthId: sys.birthId[i], oldType: oldType, newType: sys.type[i] });
      }
    }
    function breakAllBonds(i) {
      if (sys.redBond[i] !== -1) { var p = sys.redBond[i]; sys.blueBond[p] = -1; sys.redBond[i] = -1; events.push({ type: 'rb-break', step: sys.step, i: p, j: i, cause: 'turnover' }); }
      if (sys.blueBond[i] !== -1) { var q = sys.blueBond[i]; sys.redBond[q] = -1; sys.blueBond[i] = -1; events.push({ type: 'rb-break', step: sys.step, i: i, j: q, cause: 'turnover' }); }
      if (sys.pyBond[i] !== -1) { var r2 = sys.pyBond[i]; sys.pyBond[r2] = -1; sys.pyBond[i] = -1; events.push({ type: 'pg-break', step: sys.step, i: i, j: r2, cause: 'turnover' }); }
    }

    sys.step++;
    return { events: events, forceRatio: forceRatio };
  }

  var CORE = {
    DT: DT, MASS: MASS, INERTIA: INERTIA, ARM_LEN: ARM_LEN, RADIUS_SMALL: RADIUS_SMALL,
    RADIUS_LARGE_YELLOW: RADIUS_LARGE_YELLOW, RADIUS_LARGE_OTHER: RADIUS_LARGE_OTHER,
    ARM_FORCE_RB: ARM_FORCE_RB, ARM_FORCE_PY: ARM_FORCE_PY, STRAIGHTEN_RB: STRAIGHTEN_RB, STRAIGHTEN_PY: STRAIGHTEN_PY,
    ANGLE_TOL_RB_DEFAULT: ANGLE_TOL_RB_DEFAULT, ANGLE_TOL_RB_WIDE: ANGLE_TOL_RB_WIDE, ANGLE_TOL_PY: ANGLE_TOL_PY,
    SPLIT_HOLD_STEPS: SPLIT_HOLD_STEPS, A_V: A_V, A_W: A_W, C_L: C_L, C_A: C_A,
    SLS_0: SLS_0, SLS_1: SLS_1, SLS_2: SLS_2, SPS_X: SPS_X, SPS_Y: SPS_Y, SPS_Z: SPS_Z,
    normalizeAngle: normalizeAngle, makeRng: makeRng, subSeed: subSeed,
    fsmStep: fsmStep, resetFsmStats: resetFsmStats, getFsmStats: getFsmStats,
    makeSystem: makeSystem, buildInitial: buildInitial, stateHash: stateHash, snapshot: snapshot,
    tip: tip, armDir: armDir, dirVec: dirVec, yellowCenter: yellowCenter, pyRadius: pyRadius, yellowRadius: yellowRadius,
    kineticEnergy: kineticEnergy, springEnergy: springEnergy, yellowEnergy: yellowEnergy, totalEnergy: totalEnergy, dist2: dist2,
    step: step,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CORE;
  global.S68Core = CORE;
})(typeof window !== 'undefined' ? window : globalThis);
