/**
 * S-24 の観測器と転移検出器。**ここから先だけが「活性」「凍結」「臨界」「転移」を語る。**
 * core.js の側には格子の規則と接触過程の率しか無い。
 *
 * ---- 秩序変数 ----
 *
 *   activity(t) = 配置 x^t の『選ばれたら変わるセル』の割合（Fatès 2010 の activity）。
 *                 固定点で厳密に 0。接触過程では活性サイトの割合をこれに当てる。
 *   density(t)  = 1 のセルの割合（記述子）。
 *
 * ---- 転移検出器（系に依らない。criteria.json rev3 の detector 節） ----
 *
 *   制御変数の値ごとに腕（R 本のレプリケート）の平均曲線 ā(t) を作り、登録した窓 [tEnd/10, tEnd] で
 *   ln ā vs ln t の最小二乗の傾き s を取る。公表された臨界の減衰指数 δ_ref を参照点にして
 *
 *       Z(c) = s(c) + δ_ref        Z<0: 臨界の冪より速く減る（吸収相へ）／ Z>0: 遅い（活性相）
 *
 *   を秩序統計量にする。**δ_ref は実装の外から来る**（Hinrichsen 2000 Table 2。K-18）。
 *   窓の中で ā が全点 0 の腕は「死んだ腕」として Z = −∞（符号は決まっている）とする。
 *
 *   レプリケートの再抽出（bootstrap）で SE(Z) を出し、|Z| > 2·SE の点だけ符号を『決まっている』とする。
 *   決まった符号が（吸収相の側から見て）「負 → 正」と 1 度だけ変わるときに限り『転移を検出』し、
 *   交点を線形補間で出す。orientation = −1 の系（活性相が制御変数の小さい側にある。α-Life）では
 *   並びを逆順にしてから同じ規則を当てる。
 *
 *   曲率 Δ = s_late − s_early（Fatès 2010 §4.3 の指数を使わない読み方）も同時に出すが、
 *   **記述子であって判定に使わない**（rev3 の revisionReason 参照）。
 *
 * 依存ゼロ。core.js と同じく Node とブラウザで共用する（古典スクリプト・UMD 風）。
 */
(function (root, factory) {
  var api = factory(typeof module === 'object' && module.exports ? require('./core.js') : root.S24);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S24S = api;
})(typeof self !== 'undefined' ? self : this, function (S24) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 時間の格子
   * ------------------------------------------------------------------ */

  /** t=0 と、1..tMax の 10 進 1 桁あたり perDecade 点の幾何級数（整数に丸め、重複除去）。 */
  function sampleTimes(tMax, perDecade) {
    var out = [0], last = 0;
    for (var k = 0; ; k++) {
      var t = Math.round(Math.pow(10, k / perDecade));
      if (t > tMax) break;
      if (t !== last) { out.push(t); last = t; }
    }
    if (last !== tMax) out.push(tMax);
    return out;
  }

  /** 記録した時刻列から、より粗い perDecade の格子に載る点の添字を選ぶ。 */
  function subsampleIndex(times, tMax, perDecade) {
    var want = {}, coarse = sampleTimes(tMax, perDecade);
    for (var i = 0; i < coarse.length; i++) want[coarse[i]] = true;
    var idx = [];
    for (var j = 0; j < times.length; j++) if (want[times[j]]) idx.push(j);
    return idx;
  }

  /* ------------------------------------------------------------------ *
   * 走らせて曲線を取る
   * ------------------------------------------------------------------ */

  /**
   * 格子を tMax まで走らせ、times の各時刻で activity と density を記録する。
   * activity=0 の配置は固定点なので、それ以降は同じ値で埋める（criteria.json scale.frozenShortcut）。
   */
  function runGridCurve(G, times) {
    var tMax = times[times.length - 1];
    var act = new Array(times.length), den = new Array(times.length);
    var k = 0, frozenAt = null, t0 = Date.now();
    for (var t = 0; t <= tMax; t++) {
      var want = (k < times.length && times[k] === t);
      if (want) den[k] = S24.onesFraction(G);
      var r = S24.stepGrid(G);           // r.unstable は x^t の不安定セル数
      if (want) { act[k] = r.unstable / G.n; k++; }
      if (r.unstable === 0) {            // x^t は固定点。x^{t+1} = x^t
        frozenAt = t;
        var d0 = S24.onesFraction(G);
        while (k < times.length) { act[k] = 0; den[k] = d0; k++; }
        break;
      }
    }
    return { activity: act, density: den, frozenAt: frozenAt, hash: S24.hashGrid(G), ms: Date.now() - t0 };
  }

  /** 接触過程を times の各時刻まで進め、活性サイトの割合を記録する。 */
  function runChainCurve(C, times) {
    var act = new Array(times.length), extinctAt = null, t0 = Date.now();
    for (var k = 0; k < times.length; k++) {
      S24.advanceChain(C, times[k]);
      act[k] = S24.activeFraction(C);
      if (C.na === 0 && extinctAt === null) extinctAt = C.t;
    }
    return { activity: act, extinctAt: extinctAt, hash: S24.hashChain(C), events: C.events, ms: Date.now() - t0 };
  }

  /** 定常窓 [lo,hi] の記述子（粗い掃引用）。 */
  function stationaryStats(times, activity, density, lo, hi, n) {
    var a = [], d = [];
    for (var i = 0; i < times.length; i++) if (times[i] >= lo && times[i] <= hi) { a.push(activity[i]); d.push(density[i]); }
    var ma = mean(a), md = mean(d), va = 0;
    for (var j = 0; j < a.length; j++) va += (a[j] - ma) * (a[j] - ma);
    va = a.length > 1 ? va / (a.length - 1) : 0;
    return { activity: ma, density: md, chi: n * va, samples: a.length };
  }

  /* ------------------------------------------------------------------ *
   * 小さな道具
   * ------------------------------------------------------------------ */

  function mean(xs) { var s = 0; for (var i = 0; i < xs.length; i++) s += xs[i]; return xs.length ? s / xs.length : NaN; }
  function median(xs) {
    var a = xs.slice().sort(function (p, q) { return p - q; }), n = a.length;
    if (!n) return NaN;
    return n % 2 ? a[(n - 1) / 2] : 0.5 * (a[n / 2 - 1] + a[n / 2]);
  }
  function percentile(xs, p) {
    var a = xs.slice().sort(function (u, v) { return u - v; }), n = a.length;
    if (!n) return NaN;
    var r = p * (n - 1), lo = Math.floor(r), hi = Math.ceil(r);
    return a[lo] + (a[hi] - a[lo]) * (r - lo);
  }
  function sd(xs) {
    var f = xs.filter(function (x) { return isFinite(x); });
    if (f.length < 2) return 0;
    var m = mean(f), s = 0;
    for (var i = 0; i < f.length; i++) s += (f[i] - m) * (f[i] - m);
    return Math.sqrt(s / (f.length - 1));
  }

  /** 腕の平均曲線（時刻ごとにレプリケートを mean か median で畳む）。 */
  function aggregateCurves(curves, agg) {
    var m = curves[0].length, out = new Array(m);
    for (var i = 0; i < m; i++) {
      var col = [];
      for (var r = 0; r < curves.length; r++) col.push(curves[r][i]);
      out[i] = agg === 'median' ? median(col) : mean(col);
    }
    return out;
  }

  /** ln y vs ln t の最小二乗の傾き（lo ≤ t ≤ hi、t>0、y に floor を敷く）。点が 2 未満なら NaN。 */
  function logSlope(times, ys, lo, hi, floor) {
    var xs = [], zs = [];
    for (var i = 0; i < times.length; i++) {
      if (times[i] < lo || times[i] > hi || times[i] <= 0) continue;
      xs.push(Math.log(times[i])); zs.push(Math.log(Math.max(ys[i], floor)));
    }
    var n = xs.length;
    if (n < 2) return NaN;
    var mx = mean(xs), mz = mean(zs), sxx = 0, sxz = 0;
    for (var j = 0; j < n; j++) { sxx += (xs[j] - mx) * (xs[j] - mx); sxz += (xs[j] - mx) * (zs[j] - mz); }
    return sxx > 0 ? sxz / sxx : NaN;
  }

  /** 登録した窓: [tEnd·startFrac, tEnd]、幾何平均で二分。 */
  function windowOf(tEnd, startFrac) {
    var lo = tEnd * (startFrac === undefined ? 0.1 : startFrac);
    return { lo: lo, mid: Math.sqrt(lo * tEnd), hi: tEnd };
  }

  /** 窓の中で ā が正の点の数。全点 0 の腕は「死んだ腕」。 */
  function positiveCount(times, curve, win) {
    var n = 0;
    for (var i = 0; i < times.length; i++) if (times[i] >= win.lo && times[i] <= win.hi && curve[i] > 0) n++;
    return n;
  }

  /**
   * 1 本の平均曲線から統計量を出す。
   *   z = sAll + delta（主）／ delta 曲率 = sLate − sEarly（記述子）
   * 窓の中が全点 0 なら dead（z = −∞）。
   */
  function armStatistic(times, curve, win, floor, delta) {
    if (positiveCount(times, curve, win) < 2) {
      return { dead: true, z: -Infinity, sAll: -Infinity, sEarly: NaN, sLate: NaN, curvature: NaN };
    }
    var sA = logSlope(times, curve, win.lo, win.hi, floor);
    var sE = logSlope(times, curve, win.lo, win.mid, floor);
    var sL = logSlope(times, curve, win.mid, win.hi, floor);
    return { dead: false, z: sA + delta, sAll: sA, sEarly: sE, sLate: sL, curvature: sL - sE };
  }

  /* ------------------------------------------------------------------ *
   * 転移検出器
   * ------------------------------------------------------------------ */

  var DETECTOR_DEFAULTS = {
    startFrac: 0.1,      // 窓の始端 = tEnd × startFrac
    floorCells: 1,       // 平均曲線に敷く下限 = floorCells / (R × n)
    agg: 'mean',         // 'mean' | 'median'
    B: 200,              // bootstrap の回数
    seed: 4242,
    seFactor: 2,         // |Z| > seFactor × SE で『決まっている』
    delta: 0.451,        // 参照する臨界の減衰指数（Hinrichsen 2000 Table 2）
    orientation: 1,      // +1: 吸収相が制御変数の小さい側（接触過程）／ −1: 大きい側（α-Life）
  };

  /**
   * values[k]: 制御変数の値（昇順）。arms[k]: その値の腕 = レプリケート曲線の配列（times と揃う）。
   * opts: { times, tEnd, n（1 本あたりのセル数。floor 用）, delta, orientation, startFrac, floorCells, agg, B, seed, seFactor }
   */
  function locateTransition(values, arms, opts) {
    var o = {};
    for (var k in DETECTOR_DEFAULTS) o[k] = DETECTOR_DEFAULTS[k];
    for (var k2 in opts) if (opts[k2] !== undefined) o[k2] = opts[k2];
    var times = o.times, tEnd = o.tEnd || times[times.length - 1];
    var win = windowOf(tEnd, o.startFrac);
    var rng = S24.makeRng(o.seed);
    var K = values.length, points = [];

    for (var i = 0; i < K; i++) {
      var curves = arms[i], R = curves.length;
      var floor = o.floorCells / (R * o.n);
      var st = armStatistic(times, aggregateCurves(curves, o.agg), win, floor, o.delta);
      var boots = [], deadBoots = 0;
      for (var b = 0; b < o.B; b++) {
        var pick = [];
        for (var r = 0; r < R; r++) pick.push(curves[(rng() * R) | 0]);
        var s2 = armStatistic(times, aggregateCurves(pick, o.agg), win, floor, o.delta);
        if (s2.dead) deadBoots++;
        boots.push(s2.z);
      }
      var se = sd(boots);
      var determined = st.dead || (isFinite(st.z) && Math.abs(st.z) > o.seFactor * se);
      points.push({
        value: values[i], R: R, z: st.z, sAll: st.sAll, sEarly: st.sEarly, sLate: st.sLate, curvature: st.curvature,
        dead: st.dead, se: se, determined: determined, deadBootRate: deadBoots / o.B, boots: boots,
      });
    }

    var main = crossingOf(points, o.orientation);

    // 交点の bootstrap（各腕を独立に再抽出。決まっているかの判定は本体の SE を固定して使う）
    var crossings = [], detectedCount = 0;
    for (var bb = 0; bb < o.B; bb++) {
      var pts = [];
      for (var j = 0; j < K; j++) {
        var p = points[j], z = p.boots[bb];
        pts.push({ value: p.value, z: z, dead: !isFinite(z) && z < 0,
          determined: (!isFinite(z) && z < 0) || (isFinite(z) && Math.abs(z) > o.seFactor * p.se) });
      }
      var cr = crossingOf(pts, o.orientation);
      if (cr.detected) { crossings.push(cr.crossing); detectedCount++; }
    }

    return {
      detected: main.detected, reason: main.reason, crossing: main.crossing, midpointUsed: main.midpointUsed,
      lower: main.lower, upper: main.upper,
      ci68: crossings.length ? [percentile(crossings, 0.16), percentile(crossings, 0.84)] : null,
      ci95: crossings.length ? [percentile(crossings, 0.025), percentile(crossings, 0.975)] : null,
      bootDetectRate: detectedCount / o.B,
      window: win,
      options: { startFrac: o.startFrac, floorCells: o.floorCells, agg: o.agg, B: o.B, seFactor: o.seFactor, tEnd: tEnd, delta: o.delta, orientation: o.orientation },
      curvatureReading: curvatureCrossing(points, o.orientation),
      points: points.map(function (p) {
        return { value: p.value, R: p.R, z: p.z === -Infinity ? null : p.z, dead: p.dead, se: p.se,
          determined: p.determined, sign: p.determined ? (p.dead || p.z < 0 ? -1 : 1) : 0,
          sAll: p.sAll === -Infinity ? null : p.sAll, sEarly: p.sEarly, sLate: p.sLate, curvature: p.curvature,
          deadBootRate: p.deadBootRate };
      }),
    };
  }

  /**
   * 決まった符号の並びが（吸収相の側から見て）「負 → 正」と 1 度だけ変わるときだけ交点を返す。
   * pts: [{value, z, dead, determined}]（value 昇順）。orientation = −1 なら並びを逆順にして当てる。
   */
  function crossingOf(pts, orientation) {
    var seq = (orientation === -1) ? pts.slice().reverse() : pts.slice();
    var idx = [];
    for (var i = 0; i < seq.length; i++) if (seq[i].determined) idx.push(i);
    if (idx.length < 2) return { detected: false, reason: idx.length ? 'only-one-determined' : 'none-determined' };
    var changes = 0, dir = null;
    for (var j = 1; j < idx.length; j++) {
      var a = seq[idx[j - 1]].z > 0, b = seq[idx[j]].z > 0;
      if (a !== b) { changes++; dir = (!a && b) ? 'neg-to-pos' : 'pos-to-neg'; }
    }
    if (changes === 0) return { detected: false, reason: seq[idx[0]].z > 0 ? 'all-positive' : 'all-negative' };
    if (changes > 1) return { detected: false, reason: 'multiple-changes' };
    if (dir !== 'neg-to-pos') return { detected: false, reason: 'reversed' };
    // 決まった負の最後と、その後の決まった正の最初で挟む
    var iNeg = -1, iPos = -1;
    for (var m = 0; m < idx.length; m++) { if (seq[idx[m]].z < 0) iNeg = idx[m]; else if (iNeg >= 0 && iPos < 0) iPos = idx[m]; }
    // 挟んだ区間の中で、最初に符号が変わる隣り合う対を取る
    for (var p = iNeg; p < iPos; p++) {
      var lo = seq[p], hi = seq[p + 1];
      if (lo.z < 0 && hi.z >= 0) {
        var mid = !isFinite(lo.z) || !isFinite(hi.z);
        var c = mid ? 0.5 * (lo.value + hi.value) : lo.value + (0 - lo.z) / (hi.z - lo.z) * (hi.value - lo.value);
        return { detected: true, reason: 'neg-to-pos', crossing: c, midpointUsed: mid, lower: lo.value, upper: hi.value };
      }
    }
    return { detected: false, reason: 'no-adjacent-crossing' };
  }

  /**
   * 指数を使わない読み方（Fatès 2010 の曲率 Δ の符号が変わる点）。**記述子であって判定に使わない。**
   * 決まっている判定は固定の閾値 |Δ| > 0.05 で行う（死んだ腕は曲率を持たないので決まっている負とする）。
   */
  var CURVATURE_FLOOR = 0.05;
  function curvatureCrossing(points, orientation) {
    var pts = points.map(function (p) {
      var dead = p.dead;
      return { value: p.value, z: dead ? -Infinity : p.curvature, dead: dead,
        determined: dead || (isFinite(p.curvature) && Math.abs(p.curvature) > CURVATURE_FLOOR) };
    });
    var r = crossingOf(pts, orientation);
    return { detected: r.detected, reason: r.reason, crossing: r.detected ? r.crossing : null,
      curvature: points.map(function (p) { return isFinite(p.curvature) ? +p.curvature.toPrecision(4) : null; }) };
  }

  /* ------------------------------------------------------------------ *
   * 判定（criteria.json の decision 節）
   * ------------------------------------------------------------------ */

  /** 接触過程の較正: 検出かつ |λ̂ − λ_c| ≤ tol。 */
  function decideCP(result, lambdaC, tol) {
    var dist = result.detected ? Math.abs(result.crossing - lambdaC) : null;
    return { detected: result.detected, distance: dist, pass: !!(result.detected && dist <= tol), tol: tol, lambdaC: lambdaC };
  }

  /** α-Life: 各 L の交点・公表値との距離・L 間の移動。 */
  function decideLife(byL, alphaC, tol, sizes) {
    var out = { perL: {}, onPublishedValue: null, distance: null, shifts: [] };
    for (var i = 0; i < sizes.length; i++) {
      var L = sizes[i], r = byL[L];
      out.perL[L] = { detected: r.detected, crossing: r.detected ? r.crossing : null, ci68: r.ci68, reason: r.reason };
    }
    var big = byL[sizes[sizes.length - 1]];
    if (big.detected) {
      out.distance = Math.abs(big.crossing - alphaC);
      out.onPublishedValue = out.distance <= tol;
    } else out.onPublishedValue = false;
    for (var j = 1; j < sizes.length; j++) {
      var a = byL[sizes[j - 1]], b = byL[sizes[j]];
      if (a.detected && b.detected) {
        var ha = a.ci68 ? (a.ci68[1] - a.ci68[0]) / 2 : NaN, hb = b.ci68 ? (b.ci68[1] - b.ci68[0]) / 2 : NaN;
        var diff = b.crossing - a.crossing;
        out.shifts.push({ from: sizes[j - 1], to: sizes[j], diff: diff, halfWidths: [ha, hb],
                          moved: isFinite(ha) && isFinite(hb) ? Math.abs(diff) > ha + hb : null });
      } else out.shifts.push({ from: sizes[j - 1], to: sizes[j], diff: null, moved: null });
    }
    return out;
  }

  return {
    DETECTOR_DEFAULTS: DETECTOR_DEFAULTS,
    sampleTimes: sampleTimes, subsampleIndex: subsampleIndex,
    runGridCurve: runGridCurve, runChainCurve: runChainCurve, stationaryStats: stationaryStats,
    mean: mean, median: median, percentile: percentile, sd: sd,
    aggregateCurves: aggregateCurves, logSlope: logSlope, windowOf: windowOf,
    positiveCount: positiveCount, armStatistic: armStatistic,
    locateTransition: locateTransition, crossingOf: crossingOf, curvatureCrossing: curvatureCrossing,
    decideCP: decideCP, decideLife: decideLife,
  };
});
