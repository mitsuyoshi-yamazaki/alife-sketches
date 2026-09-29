/**
 * S-21 の観測器。**ここから先だけが「主配列」「準種の雲」「合意配列」「エラー閾値」を語る。**
 * core.js の側には語・重み・反転・類の個数しか無い。
 *
 * ---- 秩序変数（criteria.json の orderParameters） ----
 *
 *   x̄_0   = 原点の語（主配列）の頻度の時間平均                     … P0（主）
 *   P1/P2 = Hamming 距離 ≤ 1 / ≤ 2 の雲の頻度の時間平均           … 母集団の別定義（K-30）
 *   PC    = 合意配列（桁ごとの多数決）が主配列に一致した調査の割合  … 同上
 *   P̄_B   = 対極側の半空間（d > L/2）の頻度の時間平均              … 峰+平原の腕
 *   μ_σmax = d̄/L の時間的標準偏差が最大になる μ                     … 参照点を持たない定義（Alves & Fontanari 1997）
 *
 * ---- 閾値の読み方（criteria.json の thresholds） ----
 *
 *   格子の最小の非零 μ_1 で値 ≥ ε でなければ「維持なし」。
 *   μ_1 から順に見て、値が初めて ε を下回る区間で線形補間した μ を閾値とする。
 *   同じ規則を無限個体群の写像（core の mapRun）にも当てる——参照点（K-9 の A4）。
 *
 * 依存ゼロ。core.js と同じく Node とブラウザで共用する（古典スクリプト・UMD 風）。
 */
(function (root, factory) {
  var api = factory(typeof module === 'object' && module.exports ? require('./core.js') : root.S21);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S21S = api;
})(typeof self !== 'undefined' ? self : this, function (S21) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 1本の走行を観測する
   * ------------------------------------------------------------------ */

  /** 合意配列（桁ごとの多数決・同数は 1 と見なさない）が主配列（全 0）に一致するか。 */
  function consensusIsMaster(counts, N) {
    for (var s = 0; s < counts.length; s++) if (2 * counts[s] >= N) return false;
    return true;
  }

  /**
   * cfg = { L, N, mu, weights, init, anchor, seed, stream, T, winStart, quarterStart,
   *         censusEvery, seriesPoints }
   * T 世代走らせ、窓 [winStart, T) と第二窓 [quarterStart, T) の両方で時間平均を取る。
   */
  function observeRun(cfg) {
    var t0 = Date.now();
    var P = S21.createPool({
      L: cfg.L, N: cfg.N, mu: cfg.mu, weights: cfg.weights, init: cfg.init || 'origin',
      anchor: cfg.anchor || 'fixed', seed: cfg.seed, stream: cfg.stream || 0,
    });
    var L = P.L, N = P.N, T = cfg.T, ws = cfg.winStart, qs = cfg.quarterStart === undefined ? ws : cfg.quarterStart;
    var census = cfg.censusEvery || 25, half = L / 2;
    var mid = ws + Math.floor((T - ws) / 2);
    var a = { m: 0, c1: 0, c2: 0, far: 0, d: 0, d2: 0, n: 0, first: 0, second: 0, n1: 0, n2: 0, zero: 0, cons: 0, censuses: 0 };
    var q = { m: 0, c1: 0, c2: 0, far: 0, n: 0 };
    var series = [], every = cfg.seriesPoints ? Math.max(1, Math.floor(T / cfg.seriesPoints)) : 0;
    var minMaster = N;
    for (var t = 0; t < T; t++) {
      var cnt = P.count;
      if (every && t % every === 0) series.push(+(cnt[0] / N).toFixed(5));
      if (t >= ws) {
        var far = 0, dsum = 0;
        for (var d = 0; d <= L; d++) { dsum += d * cnt[d]; if (d > half) far += cnt[d]; }
        var m = cnt[0] / N, dn = dsum / (N * L);
        a.m += m; a.c1 += (cnt[0] + cnt[1]) / N; a.c2 += (cnt[0] + cnt[1] + (L >= 2 ? cnt[2] : 0)) / N;
        a.far += far / N; a.d += dn; a.d2 += dn * dn; a.n++;
        if (cnt[0] === 0) a.zero++;
        if (cnt[0] < minMaster) minMaster = cnt[0];
        if (t < mid) { a.first += m; a.n1++; } else { a.second += m; a.n2++; }
        if ((t - ws) % census === 0) { a.censuses++; if (consensusIsMaster(S21.siteCounts(P), N)) a.cons++; }
        if (t >= qs) { q.m += m; q.c1 += (cnt[0] + cnt[1]) / N; q.c2 += (cnt[0] + cnt[1] + (L >= 2 ? cnt[2] : 0)) / N; q.far += far / N; q.n++; }
      }
      S21.stepPool(P);
    }
    var dvar = a.d2 / a.n - (a.d / a.n) * (a.d / a.n);
    var hist = [];
    for (var h = 0; h <= L; h++) hist.push(P.count[h]);
    return {
      L: L, N: N, mu: cfg.mu, seed: cfg.seed, stream: cfg.stream || 0, T: T, winStart: ws, quarterStart: qs,
      init: cfg.init || 'origin', anchor: cfg.anchor || 'fixed',
      master: a.m / a.n, cloud1: a.c1 / a.n, cloud2: a.c2 / a.n, far: a.far / a.n,
      dMean: a.d / a.n, dStd: Math.sqrt(Math.max(dvar, 0)),
      consensus: a.censuses ? a.cons / a.censuses : 0, censuses: a.censuses,
      firstHalf: a.first / a.n1, secondHalf: a.second / a.n2,
      stationary: Math.abs(a.first / a.n1 - a.second / a.n2) <= 0.05,
      zeroMasterRate: a.zero / a.n, minMaster: minMaster,
      masterQ: q.n ? q.m / q.n : 0, cloud1Q: q.n ? q.c1 / q.n : 0, cloud2Q: q.n ? q.c2 / q.n : 0, farQ: q.n ? q.far / q.n : 0,
      finalHist: hist, hash: S21.hashPool(P), series: every ? series : undefined,
      ms: Date.now() - t0,
    };
  }

  /* ------------------------------------------------------------------ *
   * 参照点（無限個体群の写像に同じ観測を当てる）
   * ------------------------------------------------------------------ */

  /**
   * 各 μ について写像を T 世代走らせ、同じ窓で同じ量を取る。固定点も添える。
   * 返り値: { mus, traj: [{c0,c1,c2,far,dmean,lowDRate,firstC0,secondC0}], fixed: [x0], trajQ: [...] }
   */
  function referenceCurve(L, weights, mus, T, winStart, quarterStart, init) {
    var traj = [], trajQ = [], fixed = [], fixedC1 = [], fixedC2 = [], fixedFar = [];
    for (var i = 0; i < mus.length; i++) {
      var Tr = S21.classTransition(L, mus[i]);
      var r = S21.mapRun({ L: L, mu: mus[i], weights: weights, T: T, winStart: winStart, init: init, transition: Tr });
      traj.push({ c0: r.c0, c1: r.c1, c2: r.c2, far: r.far, dmean: r.dmean, lowDRate: r.lowDRate, firstC0: r.firstC0, secondC0: r.secondC0 });
      var rq = S21.mapRun({ L: L, mu: mus[i], weights: weights, T: T, winStart: quarterStart, init: init, transition: Tr });
      trajQ.push({ c0: rq.c0, c1: rq.c1, c2: rq.c2, far: rq.far });
      var fp = S21.fixedPoint(Tr, weights, L);
      var farF = 0;
      for (var d = 0; d <= L; d++) if (d > L / 2) farF += fp[d];
      fixed.push(fp[0]); fixedC1.push(fp[0] + fp[1]); fixedC2.push(fp[0] + fp[1] + (L >= 2 ? fp[2] : 0)); fixedFar.push(farF);
    }
    return { mus: mus, traj: traj, trajQ: trajQ, fixed: fixed, fixedC1: fixedC1, fixedC2: fixedC2, fixedFar: fixedFar };
  }

  /* ------------------------------------------------------------------ *
   * 閾値の読み方（criteria.json thresholds）
   * ------------------------------------------------------------------ */

  function lerp(x0, y0, x1, y1, y) { return y1 === y0 ? x0 : x0 + (y - y0) * (x1 - x0) / (y1 - y0); }

  /**
   * 下向きの交差。mus は昇順（mus[0] は 0 でもよい）。
   * 維持の要求: 最小の非零 μ で値 ≥ eps。満たさなければ status 'noMaintenance'。
   */
  function thresholdFromCurve(mus, vals, eps) {
    var i1 = 0;
    while (i1 < mus.length && mus[i1] <= 0) i1++;
    if (i1 >= mus.length) return { mu: null, status: 'noGrid', edge: false, recrossings: 0, j: -1 };
    if (!(vals[i1] >= eps)) return { mu: null, status: 'noMaintenance', edge: false, recrossings: 0, j: i1, valueAtFirst: vals[i1] };
    var j = -1;
    for (var k = i1 + 1; k < mus.length; k++) if (vals[k] < eps) { j = k; break; }
    if (j < 0) return { mu: null, status: 'noCrossing', edge: true, recrossings: 0, j: -1, valueAtFirst: vals[i1] };
    var rec = 0, below = true;
    for (var k2 = j + 1; k2 < mus.length; k2++) {
      var nowBelow = vals[k2] < eps;
      if (nowBelow !== below) { rec++; below = nowBelow; }
    }
    return {
      mu: lerp(mus[j - 1], vals[j - 1], mus[j], vals[j], eps),
      status: 'ok', edge: j === mus.length - 1, recrossings: rec, j: j, valueAtFirst: vals[i1],
    };
  }

  /** 上向きの交差（P̄_B の 0.5 交差）。最初の格子点で値 < level であること。 */
  function crossUp(mus, vals, level) {
    if (!(vals[0] < level)) return { mu: null, status: 'startsAbove', edge: false, j: 0 };
    var j = -1;
    for (var k = 1; k < mus.length; k++) if (vals[k] >= level) { j = k; break; }
    if (j < 0) return { mu: null, status: 'noCrossing', edge: true, j: -1 };
    var rec = 0, above = true;
    for (var k2 = j + 1; k2 < mus.length; k2++) { var na = vals[k2] >= level; if (na !== above) { rec++; above = na; } }
    return { mu: lerp(mus[j - 1], vals[j - 1], mus[j], vals[j], level), status: 'ok', edge: j === mus.length - 1, j: j, recrossings: rec };
  }

  /** 揺らぎ最大の μ（3 点放物線で補間）。mus[0] = 0 の点は除く。 */
  function fluctuationPeak(mus, stds) {
    var i1 = 0;
    while (i1 < mus.length && mus[i1] <= 0) i1++;
    var best = -1, bv = -Infinity;
    for (var k = i1; k < mus.length; k++) if (stds[k] > bv) { bv = stds[k]; best = k; }
    if (best < 0) return { mu: null, status: 'noGrid', edge: true };
    if (best === i1 || best === mus.length - 1) return { mu: mus[best], status: 'edge', edge: true, j: best };
    var y0 = stds[best - 1], y1 = stds[best], y2 = stds[best + 1], h = mus[best] - mus[best - 1];
    var den = (y0 - 2 * y1 + y2);
    var off = den === 0 ? 0 : 0.5 * (y0 - y2) / den;
    if (off > 1) off = 1; if (off < -1) off = -1;
    return { mu: mus[best] + off * h, status: 'ok', edge: false, j: best, peak: y1 };
  }

  /* ------------------------------------------------------------------ *
   * 集約・当てはめ
   * ------------------------------------------------------------------ */

  function median(xs) {
    var v = xs.filter(function (x) { return x !== null && x !== undefined && !isNaN(x); }).sort(function (p, q) { return p - q; });
    var n = v.length;
    if (!n) return null;
    return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  }

  function mean(xs) {
    var v = xs.filter(function (x) { return x !== null && x !== undefined && !isNaN(x); });
    if (!v.length) return null;
    return v.reduce(function (a, b) { return a + b; }, 0) / v.length;
  }

  function spread(xs) {
    var v = xs.filter(function (x) { return x !== null && x !== undefined && !isNaN(x); });
    if (!v.length) return null;
    return Math.max.apply(null, v) - Math.min.apply(null, v);
  }

  /** 最小二乗の傾き（xs, ys は同じ長さ・null を除く）。 */
  function slope(xs, ys) {
    var n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var i = 0; i < xs.length; i++) {
      if (ys[i] === null || ys[i] === undefined || isNaN(ys[i]) || !isFinite(ys[i])) continue;
      n++; sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i];
    }
    if (n < 2) return null;
    var vx = sxx / n - (sx / n) * (sx / n);
    return vx > 0 ? (sxy / n - (sx / n) * (sy / n)) / vx : null;
  }

  /** log μ_c を log L に当てた傾き。 */
  function slopeLogLog(Ls, mus) {
    var xs = [], ys = [];
    for (var i = 0; i < Ls.length; i++) { xs.push(Math.log(Ls[i])); ys.push(mus[i] === null || mus[i] <= 0 ? NaN : Math.log(mus[i])); }
    return slope(xs, ys);
  }

  /** Δ(N) = ref − obs(N) を Δ>0 の点だけで log-log に当て、α̂ = −傾き。 */
  function fitExponent(Ns, deltas) {
    var xs = [], ys = [], nonpos = 0;
    for (var i = 0; i < Ns.length; i++) {
      if (deltas[i] === null || deltas[i] === undefined || isNaN(deltas[i])) { nonpos++; continue; }
      if (deltas[i] <= 0) { nonpos++; continue; }
      xs.push(Math.log(Ns[i])); ys.push(Math.log(deltas[i]));
    }
    var s = slope(xs, ys);
    return { alpha: s === null ? null : -s, used: xs.length, nonpositive: nonpos };
  }

  /**
   * 腕の閾値。curvesBySeed = [{mus, vals}, ...]。
   * 中央値（主）と、平均曲線に規則を当てたもの（ノブ）を両方返す。
   */
  function armThreshold(curvesBySeed, eps) {
    var per = curvesBySeed.map(function (c) { return thresholdFromCurve(c.mus, c.vals, eps); });
    var mus = per.map(function (p) { return p.mu; });
    var n = curvesBySeed[0].mus.length, avg = new Array(n);
    for (var j = 0; j < n; j++) {
      var s = 0;
      for (var i = 0; i < curvesBySeed.length; i++) s += curvesBySeed[i].vals[j];
      avg[j] = s / curvesBySeed.length;
    }
    var ofMean = thresholdFromCurve(curvesBySeed[0].mus, avg, eps);
    return {
      perSeed: per, mus: mus, median: median(mus),
      definedCount: per.filter(function (p) { return p.status === 'ok'; }).length,
      edgeCount: per.filter(function (p) { return p.edge; }).length,
      noMaintenance: per.filter(function (p) { return p.status === 'noMaintenance'; }).length,
      recrossings: per.map(function (p) { return p.recrossings; }),
      ofMeanCurve: ofMean.mu, ofMeanStatus: ofMean.status, meanCurve: avg,
    };
  }

  /* ------------------------------------------------------------------ *
   * 判定規則（criteria.json decisions）
   * ------------------------------------------------------------------ */

  function decideScaling(Ls, muObs, muRef, tol) {
    var sObs = slopeLogLog(Ls, muObs), sRef = slopeLogLog(Ls, muRef);
    return {
      slopeObs: sObs, slopeRef: sRef,
      sameSlopeAsReference: sObs !== null && sRef !== null && Math.abs(sObs - sRef) <= tol,
      refDeviationFromMinusOne: sRef === null ? null : Math.abs(sRef + 1),
    };
  }

  /** r(L,N) の表から向きと収束を判定する。ratios[L][N] */
  function decideFiniteN(Ls, Ns, ratios, tolDir, tolConv) {
    var nMin = Ns[0], nMax = Ns[Ns.length - 1];
    var allBelow = true, allAbove = true, allConv = true, monotone = true;
    Ls.forEach(function (L) {
      var r0 = ratios[L][nMin], r1 = ratios[L][nMax];
      if (!(r0 < 1 - tolDir)) allBelow = false;
      if (!(r0 > 1 + tolDir)) allAbove = false;
      if (!(Math.abs(r1 - 1) <= tolConv)) allConv = false;
      for (var i = 1; i < Ns.length; i++) if (!(ratios[L][Ns[i]] >= ratios[L][Ns[i - 1]] - 1e-9)) monotone = false;
    });
    return {
      direction: allBelow ? 'lower' : allAbove ? 'higher' : 'unresolved',
      convergesWithin: allConv, monotone: monotone,
    };
  }

  function decideExponent(fit, bands, minUsed) {
    if (fit.nonpositive >= 3 || fit.used < (minUsed || 3) || fit.alpha === null) return 'unresolved';
    if (fit.alpha >= bands.oneOverN[0] && fit.alpha <= bands.oneOverN[1]) return '1/N';
    if (fit.alpha >= bands.oneOverSqrtN[0] && fit.alpha <= bands.oneOverSqrtN[1]) return '1/sqrtN';
    return 'neither';
  }

  return {
    consensusIsMaster: consensusIsMaster, observeRun: observeRun, referenceCurve: referenceCurve,
    thresholdFromCurve: thresholdFromCurve, crossUp: crossUp, fluctuationPeak: fluctuationPeak,
    median: median, mean: mean, spread: spread, slope: slope, slopeLogLog: slopeLogLog, fitExponent: fitExponent,
    armThreshold: armThreshold, decideScaling: decideScaling, decideFiniteN: decideFiniteN, decideExponent: decideExponent,
  };
});
