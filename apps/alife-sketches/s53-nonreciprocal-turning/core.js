/**
 * S-53 核 — 非相反な1次元「転回する慣性スピン鎖」。
 *
 * 個体 i=0..N-1（配列添字。論文の boid 番号は添字+1）が1本の鎖状に並び、隣接からの
 * トルクだけで角度 θ_i(t) を動かす。慣性 χ・線形弾性 k・3次の非線形 α・摩擦 γ の
 * 「反応」項に、大きさ τ^A = k·δ_A の「能動」項を重ねる。能動項は左右で符号が違うので、
 * 左隣からの実効結合は k(1+δ_A)、右隣からの実効結合は k(1−δ_A) になる（非相反）。
 * 添字 0 の個体だけは外から θ を与えられる駆動端（転回プロトコル）で、自身のニュートン
 * 方程式を持たない。
 *
 * このファイルには「群れ」も「情報」も「波面」も無い。あるのは角度・角速度・トルク・
 * 結線という力学の語彙だけで、それらの呼び名は上位（run.js / selftest.js / viewer.html）
 * の側にしかない。
 *
 * 依存ゼロ・古典スクリプト。Node（module.exports）とブラウザ（window.S53）で共用する。
 *
 * 出典（アイデアと式のみ。コードは公開されていないので参照していない）:
 *   Sandoval, M. "Information transfer enhanced by non-reciprocity in a model of
 *   turning flocks", arXiv:2604.23808（ar5iv 版・本文日付 2026-08-10）
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- 乱数・状態ハッシュ

  /** mulberry32。シードを固定すれば完全に再現する。 */
  function makeRng(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6d2b79f5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** FNV-1a 32bit。θ・ω の生バイト列にかける（method.md K-36。腕どうしが「差が無い」のか「同一」なのかを決着できる）。 */
  function hashState(theta, omega) {
    var n = theta.length;
    var buf = new Float64Array(n * 2);
    for (var i = 0; i < n; i++) { buf[i * 2] = theta[i]; buf[i * 2 + 1] = omega[i]; }
    var bytes = new Uint8Array(buf.buffer);
    var h = 0x811c9dc5;
    for (var j = 0; j < bytes.length; j++) { h ^= bytes[j]; h = Math.imul(h, 0x01000193) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  // ---------------------------------------------------------------- 既定値（borrowedConstants）

  var DEFAULTS = {
    N: 100,                    // 母集団（criteria: N_paper=100。50/200 も掃引する）
    chi: 1.0,                  // χ（スピンの自己回転モーメント。SRC1 §III）
    k: 20.0,                   // k（線形 torque 係数。SRC1 §III）
    alpha: 100000.0,           // α（3次の非線形 torque 係数。SRC1 §III）
    gamma: 0.7,                // γ（摩擦。SRC1 §III）
    omega0: 0.26,              // ω_0（転回角速度・物理単位 s^-1。SRC1 §III の4値の1つが既定）
    dt: 0.001,                 // 積分刻み（物理単位 s。SRC1 §III）
    dtScale: 1.0,              // knob: timestepRefinement（1.0 か 0.5）
    deltaA: 0.0,               // δ_A（非相反性のノブ。主たる操作変数）
    thetaI: Math.PI / 2,       // θ_I（初期角）
    thetaFT: Math.PI,          // θ_FT（目標角・反時計回り U ターン）
    tF: 31.3,                  // t̃_F（無次元の積分上限。ceilings C1）
    boundary: 'free',          // 右端の扱い: 'free'（既定）| 'fixed'（RP7）
    topology: 'chain',         // 'chain'（既定）| 'random2regular'（NC3=A10）| 'ring'（PC1専用の内部検査）
    wiringSeed: 0,             // random2regular の結線を決める乱数
    rewireLimit: 100,          // ceilings C4: 引き直し上限
    integrator: 'semiImplicit',// 'semiImplicit'（既定・シンプレクティック Euler）| 'rk4'
    torqueForm: 'eq3',         // 'eq3'（既定・τ^A=kδ_A を代入した形）| 'eq2'（τ^A を陽に持つ形。PC3 の検算）
    driven: true,              // 転回プロトコルを与えるか（false なら θ_0 は θ_I に固定 = 駆動を切る=NC1=A8）
    coupling: true,            // false なら弾性・能動トルクを0にする（伝達路を切る=NC2=A9）。k 自体は0にしない
    icNoise: 0,                // 初期角への白色雑音の振幅（rad）。頑健性の腕でのみ使う
    icNoiseSeed: 0,
    tolerances: [0.02],        // 到達判定の許容（既定 2%。knob: arrivalToleranceVariants）
    lyapunovWindow: [1, 10],   // t̃ の窓
    divergeThetaMax: 4 * Math.PI,  // ceilings C3
    divergeOmegaMax: 1000,
  };

  function withDefaults(p) {
    var out = {};
    Object.keys(DEFAULTS).forEach(function (k) { out[k] = DEFAULTS[k]; });
    Object.keys(p || {}).forEach(function (k) { if (p[k] !== undefined) out[k] = p[k]; });
    return out;
  }

  function sqrtChiOverK(p) { return Math.sqrt(p.chi / p.k); }
  function tildeToPhysicalTime(tTilde, p) { return tTilde * sqrtChiOverK(p); }
  function physicalToTildeTime(t, p) { return t / sqrtChiOverK(p); }
  function omegaToTilde(omega0, p) { return omega0 * sqrtChiOverK(p); }
  function omegaFromTilde(omega0Tilde, p) { return omega0Tilde / sqrtChiOverK(p); }

  // ---------------------------------------------------------------- 結線（chain / random2regular / ring）

  /**
   * 無作為な2-正則グラフを構成モデル（半辺のランダム対合）で作る。自己ループ・多重辺・
   * 非連結（複数サイクルへ分裂）は捨てて引き直す（ceilings C4）。捨てた結線は全て
   * discarded へ記録する——「捨てた結線を残さないと無作為結線の母集団が実際には
   * 何だったのか分からなくなる」（criteria）。
   */
  function buildRandom2Regular(n, seed, limit) {
    var rng = makeRng(seed);
    var discarded = [];
    for (var attempt = 0; attempt < limit; attempt++) {
      var half = [];
      for (var i = 0; i < n; i++) { half.push(i); half.push(i); }
      for (var j = half.length - 1; j > 0; j--) {
        var r = Math.floor(rng() * (j + 1));
        var tmp = half[j]; half[j] = half[r]; half[r] = tmp;
      }
      var edges = [], bad = false, reason = '';
      var pairSeen = {}, degree = new Int32Array(n);
      for (var e = 0; e < half.length; e += 2) {
        var a = half[e], b = half[e + 1];
        if (a === b) { bad = true; reason = '自己ループ'; break; }
        var key = a < b ? a + '-' + b : b + '-' + a;
        if (pairSeen[key]) { bad = true; reason = '多重辺'; break; }
        pairSeen[key] = 1;
        edges.push([a, b]);
        degree[a]++; degree[b]++;
      }
      if (!bad) {
        for (var d = 0; d < n; d++) { if (degree[d] !== 2) { bad = true; reason = '次数不足'; break; } }
      }
      if (!bad) {
        var adj = []; for (var v = 0; v < n; v++) adj.push([]);
        edges.forEach(function (ed) { adj[ed[0]].push(ed[1]); adj[ed[1]].push(ed[0]); });
        var seen = new Uint8Array(n), stack = [0], cnt = 1;
        seen[0] = 1;
        while (stack.length) {
          var u = stack.pop();
          adj[u].forEach(function (w) { if (!seen[w]) { seen[w] = 1; cnt++; stack.push(w); } });
        }
        if (cnt !== n) { bad = true; reason = '非連結（' + cnt + '/' + n + '）'; }
      }
      if (bad) { discarded.push({ attempt: attempt, reason: reason, edgeCount: edges.length }); continue; }

      // 各ノードの2辺を発生順で L型・R型に割る（任意だが固定の規約。README に明記）。
      var left = new Int32Array(n).fill(-1), right = new Int32Array(n).fill(-1);
      var assigned = new Int32Array(n);
      edges.forEach(function (ed) {
        var a2 = ed[0], b2 = ed[1];
        if (assigned[a2] === 0) left[a2] = b2; else right[a2] = b2;
        assigned[a2]++;
        if (assigned[b2] === 0) left[b2] = a2; else right[b2] = a2;
        assigned[b2]++;
      });
      return {
        ok: true, left: left, right: right, rightFixed: new Uint8Array(n),
        dynamicFrom: 1, discarded: discarded, tries: attempt + 1,
      };
    }
    return { ok: false, left: null, right: null, discarded: discarded, tries: limit };
  }

  function buildLinks(p) {
    var n = p.N;
    if (p.topology === 'ring') {
      var left = new Int32Array(n), right = new Int32Array(n);
      for (var i = 0; i < n; i++) { left[i] = (i - 1 + n) % n; right[i] = (i + 1) % n; }
      return { ok: true, left: left, right: right, rightFixed: new Uint8Array(n), dynamicFrom: 0, discarded: [] };
    }
    if (p.topology === 'random2regular') return buildRandom2Regular(n, p.wiringSeed, p.rewireLimit);
    // 'chain'（既定）
    var l2 = new Int32Array(n), r2 = new Int32Array(n), rf = new Uint8Array(n);
    for (var i2 = 0; i2 < n; i2++) {
      l2[i2] = i2 > 0 ? i2 - 1 : -1;
      r2[i2] = i2 < n - 1 ? i2 + 1 : -1;
      if (i2 === n - 1) rf[i2] = p.boundary === 'fixed' ? 1 : 0;
    }
    return { ok: true, left: l2, right: r2, rightFixed: rf, dynamicFrom: 1, discarded: [] };
  }

  // ---------------------------------------------------------------- 駆動端（転回プロトコル）

  /** i=0 の θ を外から与える。driven=false なら常に θ_I（NC1=A8 の「駆動を切る」）。 */
  function driveTheta(t, p) {
    if (!p.driven) return p.thetaI;
    var tSwitch = Math.PI / (2 * p.omega0);
    if (t <= tSwitch) return p.thetaI + p.omega0 * t;
    return p.thetaFT;
  }

  // ---------------------------------------------------------------- トルク（式(2)と式(3)。PC3 で一致を検算する）

  /**
   * i のトルク（摩擦込み）。th0 は i=0 の現在値を明示的に渡す（配列の第0要素に頼らない——
   * RK4 の中間段では配列の該当スロットが古いままなことがあるため）。
   *
   * form='eq3': τ^A=kδ_A を代入し k(1±δ_A) にまとめた形。
   * form='eq2': τ^A を陽に持つ元の形（τ_iL=−τ^A(θ_i−θ_{i−1})・τ_iR=−τ^A(θ_{i+1}−θ_i)）を
   *   そのまま別々に加算する。数学的には同じ式だが、別のコード経路として書くことで
   *   δ_A の入れ方の符号ミスを互いに検算できる（原典が両方の形を本文に書いている）。
   *
   * th0 が null のとき（'ring' 位相。駆動端が無い）は添字0を特別扱いしない——
   * th0 が非 null のとき（'chain'/'random2regular'。添字0が駆動端）だけ、隣接が
   * 添字0を指したら th0 に読み替える。この区別を落とすと、ring では添字0を隣に
   * 持つ2個体の結合が消える（S2 実装中に見つけた実際のバグ。raw/notes.md 参照）。
   *
   * p.coupling===false（NC2=A9「伝達路を切る」）のときは弾性・能動トルクの寄与を
   * 0にする。**p.k 自体を0にはしない**——k は無次元化 t̃=t√(k/χ) の単位系そのものに
   * 使われているので、k=0 は √(χ/k)=Infinity・積分ステップ数=Infinity という
   * 同期的な無限ループを生む（S2 実装中に実際に踏んだバグ。raw/notes.md 参照）。
   */
  function torqueAt(theta, omega, i, th0, p, links, form) {
    var coupling = p.coupling !== false;
    var k = coupling ? p.k : 0, alpha = coupling ? p.alpha : 0, deltaA = p.deltaA, tauA = k * deltaA;
    var self = theta[i];
    var tq = -p.gamma * omega[i];
    var L = links.left[i];
    if (L >= 0) {
      var thL = (th0 !== null && L === 0) ? th0 : theta[L];
      var dL = thL - self;
      if (form === 'eq2') tq += (k * dL + alpha * dL * dL * dL) + (-tauA * (self - thL));
      else tq += k * (1 + deltaA) * dL + alpha * dL * dL * dL;
    }
    var R = links.right[i];
    var thR = R >= 0 ? ((th0 !== null && R === 0) ? th0 : theta[R]) : (links.rightFixed[i] ? p.thetaI : null);
    if (thR !== null) {
      var dR = thR - self;
      if (form === 'eq2') tq += (k * dR + alpha * dR * dR * dR) + (-tauA * (thR - self));
      else tq += k * (1 - deltaA) * dR + alpha * dR * dR * dR;
    }
    return tq;
  }

  // ---------------------------------------------------------------- 積分（半陰的Euler / RK4）

  /** 半陰的（シンプレクティック）Euler。前進 Euler は調和振動子に無条件不安定なので使わない。 */
  function stepSemiImplicit(state, dt, form) {
    var p = state.p, n = state.n, th = state.theta, om = state.omega, links = state.links;
    var from = links.dynamicFrom;
    var tBefore = state.t;
    var th0AtT = from === 0 ? null : driveTheta(tBefore, p);
    var newOm = new Float64Array(n);
    for (var i = from; i < n; i++) newOm[i] = om[i] + dt * torqueAt(th, om, i, th0AtT, p, links, form) / p.chi;
    for (var i2 = from; i2 < n; i2++) { om[i2] = newOm[i2]; th[i2] += dt * om[i2]; }
    state.t = tBefore + dt;
    if (from > 0) th[0] = driveTheta(state.t, p);
    state.step++;
  }

  function addScaled(a, b, s, from, n) {
    var out = Float64Array.from(a);
    for (var i = from; i < n; i++) out[i] = a[i] + s * b[i];
    return out;
  }

  /** RK4。境界（駆動端）の値は各段の評価時刻で正しく取り直す。 */
  function stepRK4(state, dt, form) {
    var p = state.p, n = state.n, links = state.links, from = links.dynamicFrom;
    var th = state.theta, om = state.omega;
    function deriv(thArr, omArr, tEval) {
      var th0 = from === 0 ? null : driveTheta(tEval, p);
      var dTh = new Float64Array(n), dOm = new Float64Array(n);
      for (var i = from; i < n; i++) {
        dTh[i] = omArr[i];
        dOm[i] = torqueAt(thArr, omArr, i, th0, p, links, form) / p.chi;
      }
      return { dTh: dTh, dOm: dOm, th0: th0 };
    }
    var t0 = state.t;
    var k1 = deriv(th, om, t0);
    var th2 = addScaled(th, k1.dTh, dt / 2, from, n), om2 = addScaled(om, k1.dOm, dt / 2, from, n);
    var k2 = deriv(th2, om2, t0 + dt / 2);
    var th3 = addScaled(th, k2.dTh, dt / 2, from, n), om3 = addScaled(om, k2.dOm, dt / 2, from, n);
    var k3 = deriv(th3, om3, t0 + dt / 2);
    var th4 = addScaled(th, k3.dTh, dt, from, n), om4 = addScaled(om, k3.dOm, dt, from, n);
    var k4 = deriv(th4, om4, t0 + dt);
    for (var i = from; i < n; i++) {
      th[i] += (dt / 6) * (k1.dTh[i] + 2 * k2.dTh[i] + 2 * k3.dTh[i] + k4.dTh[i]);
      om[i] += (dt / 6) * (k1.dOm[i] + 2 * k2.dOm[i] + 2 * k3.dOm[i] + k4.dOm[i]);
    }
    state.t = t0 + dt;
    if (from > 0) th[0] = driveTheta(state.t, p);
    state.step++;
  }

  function checkDivergence(state) {
    var p = state.p, th = state.theta, om = state.omega, from = state.links.dynamicFrom;
    for (var i = from; i < state.n; i++) {
      if (Math.abs(th[i]) > p.divergeThetaMax || Math.abs(om[i]) > p.divergeOmegaMax) {
        state.diverged = true;
        state.divergeInfo = { step: state.step, t: state.t, i: i, theta: th[i], omega: om[i] };
        return true;
      }
    }
    return false;
  }

  function createState(p, opts) {
    opts = opts || {};
    var links = buildLinks(p);
    if (!links.ok) return { ok: false, discardedWirings: links.discarded, tries: links.tries };
    var n = p.N;
    var theta = new Float64Array(n), omega = new Float64Array(n);
    var icRng = p.icNoise ? makeRng(p.icNoiseSeed || 0) : null;
    for (var i = 0; i < n; i++) {
      var noise = icRng ? (icRng() * 2 - 1) * p.icNoise : 0;
      theta[i] = p.thetaI + (i >= links.dynamicFrom ? noise : 0);
    }
    if (opts.initialAmplitudeFn) {
      for (var j = 0; j < n; j++) theta[j] = p.thetaI + opts.initialAmplitudeFn(j);
    }
    theta[0] = links.dynamicFrom === 0 ? theta[0] : driveTheta(0, p);
    return {
      ok: true, p: p, n: n, t: 0, step: 0,
      theta: theta, omega: omega, links: links, diverged: false, divergeInfo: null,
    };
  }

  // ---------------------------------------------------------------- 本番1条件の走行

  /**
   * 1条件（腕×シード）を t̃_F まで走らせる。到達判定（複数の許容を同時に）・数値光円錐
   * （eps=0。制御走行は θ_I 一様場と数学的に恒等なので別走行を要らない——理由は
   * README/notes.md に明記）・リャプノフ窓の D(t̃) を1パスで集める。
   */
  function runOne(pIn, opts) {
    var p = withDefaults(pIn);
    opts = opts || {};
    var state = createState(p);
    if (!state.ok) return { ok: false, discardedWirings: state.discardedWirings, tries: state.tries };
    var n = state.n, links = state.links, from = links.dynamicFrom;

    var dt = p.dt * (p.dtScale || 1);
    var s2 = sqrtChiOverK(p);
    var tPhysicalF = tildeToPhysicalTime(p.tF, p);
    var nSteps = Math.max(1, Math.round(tPhysicalF / dt));

    var tolerances = p.tolerances || [0.02];
    var arrivalTol = {};
    tolerances.forEach(function (tol) { arrivalTol[tol] = new Float64Array(n); arrivalTol[tol].fill(NaN); });
    var arrivalEps0 = new Int32Array(n).fill(-1);
    var thetaFT = p.thetaFT, thetaI = p.thetaI, span = Math.abs(thetaFT - thetaI);

    var lw = p.lyapunovWindow || [1, 10];
    var T1 = tildeToPhysicalTime(lw[0], p), T2 = tildeToPhysicalTime(lw[1], p);
    var D1 = null, D2 = null;

    function currentD() {
      var s = 0;
      for (var i = from; i < n; i++) { var d = state.theta[i] - thetaI; s += d * d; }
      return Math.sqrt(s);
    }

    function sample() {
      var tTilde = physicalToTildeTime(state.t, p);
      for (var i = from; i < n; i++) {
        if (arrivalEps0[i] < 0 && state.theta[i] !== thetaI) arrivalEps0[i] = state.step;
        var errFrac = Math.abs(state.theta[i] - thetaFT) / span;
        for (var ti = 0; ti < tolerances.length; ti++) {
          var tol = tolerances[ti];
          if (isNaN(arrivalTol[tol][i]) && errFrac <= tol) arrivalTol[tol][i] = tTilde;
        }
      }
      if (D1 === null && state.t >= T1) D1 = currentD();
      if (D2 === null && state.t >= T2) D2 = currentD();
    }
    sample();

    var stepFn = p.integrator === 'rk4' ? stepRK4 : stepSemiImplicit;
    var form = p.torqueForm || 'eq3';
    var stepsRun = 0;
    for (var s = 0; s < nSteps; s++) {
      stepFn(state, dt, form);
      stepsRun++;
      sample();
      if (checkDivergence(state)) break;
    }
    if (D1 === null) D1 = currentD();
    if (D2 === null) D2 = currentD();

    return {
      ok: true, n: n, from: from, nSteps: nSteps, stepsRun: stepsRun, dt: dt,
      diverged: state.diverged, divergeInfo: state.divergeInfo,
      tTildeFinal: physicalToTildeTime(state.t, p),
      thetaFinal: state.theta, omegaFinal: state.omega,
      arrivalEps0: arrivalEps0, arrivalTol: arrivalTol,
      D1: D1, D2: D2, lyapunovWindow: lw,
      discardedWirings: links.discarded || [],
      stateHash: hashState(state.theta, state.omega),
      params: p,
    };
  }

  // ---------------------------------------------------------------- 観測器（12本）
  //
  // ここから先だけが「群れ」「波面」「効率」を語る。核の側には無い語彙を使ってよい唯一の場所。

  function pearsonCorrelation(xs, ys) {
    var n = xs.length;
    if (n < 2) return 0;
    var mx = 0, my = 0;
    for (var i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    var sxx = 0, syy = 0, sxy = 0;
    for (var i2 = 0; i2 < n; i2++) {
      var dx = xs[i2] - mx, dy = ys[i2] - my;
      sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
    }
    if (sxx <= 0 || syy <= 0) return 0;
    return sxy / Math.sqrt(sxx * syy);
  }

  /** y を x へ回帰した傾き dy/dx。frontSpeed の「到達時刻→距離」に使う。 */
  function linRegSlope(xs, ys) {
    var n = xs.length;
    if (n < 2) return 0;
    var mx = 0, my = 0;
    for (var i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    var sxx = 0, sxy = 0;
    for (var i2 = 0; i2 < n; i2++) { var dx = xs[i2] - mx; sxy += dx * (ys[i2] - my); sxx += dx * dx; }
    return sxx > 0 ? sxy / sxx : 0;
  }

  /** 原典の測り方: 到達順に並べた距離-時刻の対から、隣り合う対の瞬時速度 Δd/Δt を平均する。 */
  function instantaneousSpeedAvg(ts, ds) {
    var speeds = [];
    for (var k = 1; k < ds.length; k++) {
      var dt = ts[k] - ts[k - 1], dd = ds[k] - ds[k - 1];
      if (dt !== 0) speeds.push(dd / dt);
    }
    if (!speeds.length) return 0;
    var s = 0; for (var i = 0; i < speeds.length; i++) s += speeds[i];
    return s / speeds.length;
  }

  /**
   * 事前登録した秩序変数12本をまとめて出す。
   * opts: { tolerance, censoring: 'exclude'|'censor', efficiencyTypoReading: 'default'|'typo' }
   */
  function computeObservers(result, opts) {
    opts = opts || {};
    var tol = opts.tolerance != null ? opts.tolerance : 0.02;
    var censoring = opts.censoring || 'exclude';
    var n = result.n, from = result.from;
    var populationSize = n - from;
    var arr = result.arrivalTol[tol];
    if (!arr) throw new Error('この許容 ' + tol + ' は runOne の tolerances に含まれていない');

    var ts = [], ds = [];
    var reachedCount = 0;
    for (var i = from; i < n; i++) {
      if (!isNaN(arr[i])) { reachedCount++; ts.push(arr[i]); ds.push(i - from); }
      else if (censoring === 'censor') { ts.push(result.tTildeFinal); ds.push(i - from); }
    }
    var enough = reachedCount >= 5;
    var frontCorrelation = enough ? pearsonCorrelation(ts, ds) : false;
    var frontSpeed = enough ? linRegSlope(ts, ds) : 0;
    var frontSpeedPaper = enough ? instantaneousSpeedAvg(ts, ds) : 0;

    var thetaI = result.params.thetaI, thetaFT = result.params.thetaFT, span = thetaFT - thetaI;
    var etaRaw = new Float64Array(n), etaClipped = new Float64Array(n);
    for (var i2 = from; i2 < n; i2++) {
      var v = (result.thetaFinal[i2] - thetaI) / span;
      etaRaw[i2] = v;
      etaClipped[i2] = Math.max(0, Math.min(1, v));
    }
    var typoReading = opts.efficiencyTypoReading === 'typo';
    var eta35Index = 34; // 論文の boid 35 = 0 始まりの添字34
    var efficiency35 = typoReading ? 1 : (eta35Index < n ? etaRaw[eta35Index] : NaN);

    var reachedFraction2pctCount = reachedCount;
    var reachedFraction2pct = reachedFraction2pctCount / populationSize;

    var reachedEps0 = 0;
    for (var i3 = from; i3 < n; i3++) if (result.arrivalEps0[i3] >= 0) reachedEps0++;
    var reachedFraction = reachedEps0 / populationSize;

    var s2 = 0, s4 = 0;
    for (var i4 = from; i4 < n; i4++) {
      var d = result.thetaFinal[i4] - thetaI;
      var d2 = d * d;
      s2 += d2; s4 += d2 * d2;
    }
    var spreadCount = s4 > 0 ? (s2 * s2) / s4 : 1.0;

    var lw = result.lyapunovWindow;
    var lyapunov = (result.D1 > 0 && result.D2 !== null)
      ? Math.log(result.D2 / result.D1) / (lw[1] - lw[0]) : (result.D1 === 0 && result.D2 === 0 ? 0 : null);

    var cx = 0, cy = 0;
    for (var i5 = from; i5 < n; i5++) { cx += Math.cos(result.thetaFinal[i5]); cy += Math.sin(result.thetaFinal[i5]); }
    var alignmentOrder = Math.sqrt(cx * cx + cy * cy) / populationSize;

    var mean = 0;
    for (var i6 = from; i6 < n; i6++) mean += result.thetaFinal[i6];
    mean /= populationSize;
    var varSum = 0;
    for (var i7 = from; i7 < n; i7++) { var dv = result.thetaFinal[i7] - mean; varSum += dv * dv; }
    var dispersionAngle = Math.sqrt(varSum / populationSize);

    return {
      frontSpeed: frontSpeed,
      frontSpeedPaper: frontSpeedPaper,
      efficiency35: efficiency35,
      efficiencyProfile: { raw: Array.from(etaRaw.slice(from)), clipped: Array.from(etaClipped.slice(from)) },
      reachedFraction: reachedFraction,
      reachedFraction2pct: reachedFraction2pct,
      frontCorrelation: frontCorrelation,
      spreadCount: spreadCount,
      lyapunov: lyapunov,
      alignmentOrder: alignmentOrder,
      dispersionAngle: dispersionAngle,
      reachedCount2pct: reachedCount,
      populationSize: populationSize,
      arrivalTimes2pct: ts, arrivalDistances2pct: ds,
    };
  }

  // ---------------------------------------------------------------- 正コントロール専用のユーティリティ

  /** H = Σχθ̇_i²/2 + Σ[k(θ_{i+1}-θ_i)²/2 + α(θ_{i+1}-θ_i)⁴/4]（PC4・nonreciprocityAudit の式そのまま）。 */
  function totalEnergy(theta, omega, n, chi, k, alpha) {
    var h = 0;
    for (var i = 1; i < n; i++) h += chi * omega[i] * omega[i] / 2;
    for (var i2 = 0; i2 < n - 1; i2++) {
      var d = theta[i2 + 1] - theta[i2];
      h += (k * d * d) / 2 + (alpha * d * d * d * d) / 4;
    }
    return h;
  }

  /**
   * PC4: γ=0・小振幅初期擾乱・駆動を切った鎖で、δ_A=0 では H が保存し δ_A≠0 では保存しないことを見る。
   */
  function runEnergyAudit(pIn) {
    var p = withDefaults(Object.assign({}, pIn, { gamma: 0, driven: false, topology: 'chain' }));
    var state = createState(p, {});
    if (!state.ok) return { ok: false };
    var H0 = totalEnergy(state.theta, state.omega, state.n, p.chi, p.k, p.alpha);
    var dt = p.dt * (p.dtScale || 1);
    var nSteps = Math.max(1, Math.round(tildeToPhysicalTime(p.tF, p) / dt));
    var stepFn = p.integrator === 'rk4' ? stepRK4 : stepSemiImplicit;
    for (var s = 0; s < nSteps; s++) {
      stepFn(state, dt, p.torqueForm || 'eq3');
      if (checkDivergence(state)) break;
    }
    var Hf = totalEnergy(state.theta, state.omega, state.n, p.chi, p.k, p.alpha);
    var relChange = Math.abs(Hf - H0) / Math.max(Math.abs(H0), 1e-12);
    return { ok: true, H0: H0, Hf: Hf, relChange: relChange, diverged: state.diverged };
  }

  /**
   * PC1: α=γ=δ_A=0・周期境界・単一フーリエモードの小振幅初期擾乱で、振幅の時間発展が
   * 理論の分散関係 ω(q)=2√(k/χ)|sin(q/2)|（h=1・個体間隔を長さの単位に取る）に従うかを見る。
   */
  function runDispersionCheck(pIn, mode, amplitude) {
    var p = withDefaults(Object.assign({}, pIn, {
      gamma: 0, alpha: 0, deltaA: 0, driven: false, topology: 'ring',
    }));
    var n = p.N;
    var q = (2 * Math.PI * mode) / n;
    var omegaTheory = 2 * Math.sqrt(p.k / p.chi) * Math.abs(Math.sin(q / 2));
    var state = createState(p, { initialAmplitudeFn: function (j) { return amplitude * Math.cos(q * j); } });
    var dt = p.dt * (p.dtScale || 1);
    var stepFn = p.integrator === 'rk4' ? stepRK4 : stepSemiImplicit;
    var periodPhysical = omegaTheory > 0 ? (2 * Math.PI) / omegaTheory : Infinity;
    var nStepsOnePeriod = Math.max(8, Math.min(200000, Math.round(periodPhysical / dt)));
    var samples = [];
    for (var s = 0; s < nStepsOnePeriod; s++) {
      stepFn(state, dt, 'eq3');
      var amp = 0;
      for (var i = 0; i < n; i++) amp += (state.theta[i] - p.thetaI) * Math.cos(q * i);
      amp = (amp * 2) / n;
      samples.push({ t: state.t, amp: amp });
    }
    return { q: q, omegaTheory: omegaTheory, samples: samples };
  }

  // ---------------------------------------------------------------- 出力

  var API = {
    DEFAULTS: DEFAULTS, withDefaults: withDefaults,
    makeRng: makeRng, hashState: hashState,
    sqrtChiOverK: sqrtChiOverK, tildeToPhysicalTime: tildeToPhysicalTime, physicalToTildeTime: physicalToTildeTime,
    omegaToTilde: omegaToTilde, omegaFromTilde: omegaFromTilde,
    buildLinks: buildLinks, buildRandom2Regular: buildRandom2Regular,
    driveTheta: driveTheta, torqueAt: torqueAt,
    stepSemiImplicit: stepSemiImplicit, stepRK4: stepRK4, checkDivergence: checkDivergence,
    createState: createState, runOne: runOne,
    pearsonCorrelation: pearsonCorrelation, linRegSlope: linRegSlope, instantaneousSpeedAvg: instantaneousSpeedAvg,
    computeObservers: computeObservers,
    totalEnergy: totalEnergy, runEnergyAudit: runEnergyAudit, runDispersionCheck: runDispersionCheck,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (typeof global !== 'undefined') global.S53 = API;
})(typeof window !== 'undefined' ? window : (typeof self !== 'undefined' ? self : this));
