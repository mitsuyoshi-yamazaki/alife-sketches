/**
 * S-32 観測器 — criteria.json に登録した検出器の実装。
 *
 * 核（core.js）と分けてあるのは、生物学・統計の語彙（アトラクタ・臨界・相）を
 * こちら側にだけ置くため。核は「ノード・入力・真理値表・同期更新」しか知らない。
 *
 * Node とブラウザで共用する（古典スクリプト）。
 */
(function (global) {
  'use strict';

  var C = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('./core.js') : global.S32;

  // ------------------------------------------------ 理論の側（借り物・K-51）

  /** Derrida–Pomeau の焼きなまし写像。配線が 'replace' のとき。 */
  function mapStep(d, K, p) { return 2 * p * (1 - p) * (1 - Math.pow(1 - d, K)); }

  /** 傾き 2Kp(1−p)。 */
  function derridaSlope(K, p) { return 2 * K * p * (1 - p); }

  /** 2Kp(1−p)=1 の2根。K<2 では存在しない。 */
  function pcLow(K) { return (1 - Math.sqrt(1 - 2 / K)) / 2; }
  function pcHigh(K) { return (1 + Math.sqrt(1 - 2 / K)) / 2; }

  /**
   * 1ステップ後の食い違い数の**厳密な**期待値（近似ではない）。
   * m ノードが食い違っているとき、あるノードの K 本の入力のどれかが食い違う確率 q。
   *   replace :  q = 1 − (1 − m/N)^K
   *   distinct:  q = 1 − C(N−m, K)/C(N, K)  （自己を除くので母数は N−1 本から選ぶ）
   */
  function exactOneStep(N, K, p, m, wiring) {
    var q, i;
    if (wiring === 'distinct') {
      // 自分以外の N−1 本から相異なる K 本。食い違っているのが m 本のうち
      // 自分自身が食い違っているかで場合分けせず、平均を取る（ノードは一様）。
      // 食い違っていない N−1−(m − [self]) 本から K 本すべてを選ぶ確率の平均。
      var acc = 0;
      for (var self = 0; self <= 1; self++) {
        var w = (self === 1 ? m - 1 : m);          // 自分を除いた食い違い数
        var avail = N - 1, good = avail - w;        // 食い違っていない候補の数
        var pr = 1;
        for (i = 0; i < K; i++) pr *= (good - i) / (avail - i);
        if (pr < 0) pr = 0;
        var weight = (self === 1 ? m / N : (N - m) / N);
        acc += weight * (1 - pr);
      }
      q = acc;
    } else {
      q = 1 - Math.pow(1 - m / N, K);
    }
    return N * 2 * p * (1 - p) * q;
  }

  // ------------------------------------------------ 基本の統計

  function sum(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s; }
  function mean(a) { return a.length ? sum(a) / a.length : NaN; }

  function quantile(sorted, f) {
    if (!sorted.length) return null;
    var i = Math.floor(f * (sorted.length - 1));
    if (i < 0) i = 0; if (i >= sorted.length) i = sorted.length - 1;
    return sorted[i];
  }
  function median(arr) {
    var a = arr.slice().sort(function (x, y) { return x - y; });
    return quantile(a, 0.5);
  }
  function quantiles(arr) {
    var a = arr.slice().sort(function (x, y) { return x - y; });
    return { n: a.length, min: a[0] == null ? null : a[0],
      q10: quantile(a, 0.10), q25: quantile(a, 0.25), q50: quantile(a, 0.50),
      q75: quantile(a, 0.75), q90: quantile(a, 0.90), q99: quantile(a, 0.99),
      max: a.length ? a[a.length - 1] : null, mean: a.length ? mean(a) : null };
  }

  /** 最小二乗の傾きと切片。 */
  function ols(xs, ys) {
    var n = xs.length, mx = mean(xs), my = mean(ys), sxy = 0, sxx = 0;
    for (var i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) * (xs[i] - mx); }
    var b = sxx === 0 ? 0 : sxy / sxx;
    return { slope: b, intercept: my - b * mx };
  }

  // ------------------------------------------------ A1: 損傷の増幅率

  /**
   * 網ごとの集計から腕の m_t 列を作る。
   *   cells: [{ mSum: [t], nPairs, aliveSum: [t], aliveCount: [t] }]
   *   pop:   'ALL' | 'ALIVE'
   */
  function armSeries(cells, pop, floor) {
    var T = cells[0].mSum.length, out = new Array(T), t, i, num, den;
    for (t = 0; t < T; t++) {
      num = 0; den = 0;
      for (i = 0; i < cells.length; i++) {
        if (pop === 'ALIVE') { num += cells[i].aliveSum[t]; den += cells[i].aliveCount[t]; }
        else { num += cells[i].mSum[t]; den += cells[i].nPairs; }
      }
      out[t] = den > 0 ? num / den : 0;
      if (!(out[t] > floor)) out[t] = floor;
    }
    return out;
  }

  /** 窓の中で m_t が全点とも床に張り付いている腕か（K-50 の「死んだ腕」）。 */
  function isDeadArm(m, tLo, tHi, floor) {
    for (var t = tLo; t <= tHi + 1 && t < m.length; t++) if (m[t] > floor * 1.0000001) return false;
    return true;
  }

  /** sBar = 窓 [tLo,tHi] の比の幾何平均。log を返す。死んだ腕は −∞。 */
  function logSBar(m, tLo, tHi, aggregator, floor) {
    var t;
    if (floor != null && isDeadArm(m, tLo, tHi, floor)) return -Infinity;
    if (aggregator === 'ols-slope-of-log-m') {
      var xs = [], ys = [];
      for (t = tLo; t <= tHi + 1 && t < m.length; t++) { xs.push(t); ys.push(Math.log(m[t])); }
      return ols(xs, ys).slope;
    }
    var acc = 0, n = 0;
    for (t = tLo; t <= tHi && t + 1 < m.length; t++) { acc += Math.log(m[t + 1]) - Math.log(m[t]); n++; }
    return n ? acc / n : 0;
  }

  /** 網を単位に復元抽出して log sBar の標準誤差を出す。 */
  function bootstrapLogSBar(cells, opt, B, rng) {
    var vals = [], b, i, pick;
    for (b = 0; b < B; b++) {
      pick = new Array(cells.length);
      for (i = 0; i < cells.length; i++) pick[i] = cells[(rng() * cells.length) | 0];
      vals.push(logSBar(armSeries(pick, opt.pop, opt.floor), opt.tLo, opt.tHi, opt.aggregator, opt.floor));
    }
    var fin = vals.filter(function (x) { return isFinite(x); });
    if (!fin.length) return { se: 0, lo68: -Infinity, hi68: -Infinity };
    var mu = mean(fin), v = 0;
    for (i = 0; i < fin.length; i++) v += (fin[i] - mu) * (fin[i] - mu);
    fin.sort(function (x, y) { return x - y; });
    return { se: Math.sqrt(v / Math.max(1, fin.length - 1)), lo68: quantile(fin, 0.16), hi68: quantile(fin, 0.84) };
  }

  // ------------------------------------------------ 交点の検出（登録した規則）

  /**
   * points: [{ p, logS, se }]（p の昇順）
   * opt: { orientation: +1|-1, floorLog, threshold(=log の閾値。既定 0) }
   * 戻り: { detected, reason, pHat, signs, determined }
   */
  function detectCrossing(points, opt) {
    var orientation = opt.orientation == null ? 1 : opt.orientation;
    var floorLog = opt.floorLog == null ? 0.004 : opt.floorLog;
    var thr = opt.threshold == null ? 0 : opt.threshold;

    var pts = points.map(function (q) { return { p: q.p, v: q.logS - thr, se: q.se }; });
    if (orientation < 0) pts = pts.slice().reverse();

    var det = pts.map(function (q) { return !isFinite(q.v) ? true : Math.abs(q.v) > Math.max(2 * q.se, floorLog); });
    var signs = pts.map(function (q, i) { return det[i] ? (q.v > 0 ? 1 : -1) : 0; });

    var seq = [], idx = [];
    for (var i = 0; i < signs.length; i++) if (signs[i] !== 0) { seq.push(signs[i]); idx.push(i); }
    if (seq.length < 2) return { detected: false, reason: 'too-few-determined', pHat: null, signs: signs, determined: det };

    var changes = [];
    for (i = 1; i < seq.length; i++) if (seq[i] !== seq[i - 1]) changes.push(i);
    if (changes.length === 0) {
      return { detected: false, reason: seq[0] > 0 ? 'all-positive' : 'all-negative', pHat: null, signs: signs, determined: det };
    }
    if (changes.length > 1) return { detected: false, reason: 'multiple-changes', pHat: null, signs: signs, determined: det };
    var c = changes[0];
    if (!(seq[c - 1] === -1 && seq[c] === 1)) {
      return { detected: false, reason: 'reversed', pHat: null, signs: signs, determined: det };
    }
    var a = pts[idx[c - 1]], b = pts[idx[c]];
    var pHat = (!isFinite(a.v) || !isFinite(b.v) || a.v === b.v)
      ? (a.p + b.p) / 2
      : a.p + (b.p - a.p) * (0 - a.v) / (b.v - a.v);
    return { detected: true, reason: 'crossing', pHat: pHat, signs: signs, determined: det,
             bracket: [Math.min(a.p, b.p), Math.max(a.p, b.p)] };
  }

  /** 交点の bootstrap。cellsByP: [{p, cells}]。 */
  function bootstrapCrossing(cellsByP, opt, B, rng) {
    var vals = [], b, i, j, pts, pick, r;
    for (b = 0; b < B; b++) {
      pts = [];
      for (i = 0; i < cellsByP.length; i++) {
        var cells = cellsByP[i].cells;
        pick = new Array(cells.length);
        for (j = 0; j < cells.length; j++) pick[j] = cells[(rng() * cells.length) | 0];
        pts.push({ p: cellsByP[i].p, logS: logSBar(armSeries(pick, opt.pop, opt.floor), opt.tLo, opt.tHi, opt.aggregator, opt.floor), se: cellsByP[i].se });
      }
      r = detectCrossing(pts, opt);
      if (r.detected) vals.push(r.pHat);
    }
    vals.sort(function (x, y) { return x - y; });
    if (!vals.length) return { n: 0, lo68: null, hi68: null, lo95: null, hi95: null, halfWidth68: null };
    return { n: vals.length, lo68: quantile(vals, 0.16), hi68: quantile(vals, 0.84),
             lo95: quantile(vals, 0.025), hi95: quantile(vals, 0.975),
             halfWidth68: (quantile(vals, 0.84) - quantile(vals, 0.16)) / 2 };
  }

  // ------------------------------------------------ A2: 閉じた軌道の数え方

  /**
   * 1つの網の走行列から、登録した母集団・識別規則・細かさの全組合せを一度に数える。
   *   runs: [{ period, entry, steps, orbitKey, orbitOnes, truncated }]（上限 high で走らせたもの）
   *   cap:  この腕の上限。steps > cap の走行は「打ち切られた」とみなす（**近道**。selftest で検算する）
   * 戻り: { byPop: {...}, counts: { rule: { nInit: k } }, stop: { rule: { miss: k } }, ceilingHit: {...} }
   */
  function countNetwork(runs, cap, nInits, rules, missList) {
    var seen = {}, attractorPeriods = {}, i, r, key, rule;
    for (rule = 0; rule < rules.length; rule++) seen[rules[rule]] = {};
    var counts = {}, stop = {}, stopState = {};
    rules.forEach(function (rl) {
      counts[rl] = {}; stop[rl] = {}; stopState[rl] = { miss: 0, done: {} };
      attractorPeriods[rl] = [];
    });

    var periodsInit = [], periodsCensored = [], periodsCompleted = [], truncCount = 0;
    var entryCounts = {}, periodCounts = {};

    for (i = 0; i < runs.length; i++) {
      r = runs[i];
      var truncated = r.truncated || r.steps > cap;
      if (truncated) {
        truncCount++;
        periodsCensored.push(cap);
      } else {
        periodsInit.push(r.period);
        periodsCompleted.push(r.period);
        periodsCensored.push(r.period);
        periodCounts[r.period] = (periodCounts[r.period] || 0) + 1;
        var eb = r.entry;
        entryCounts[eb] = (entryCounts[eb] || 0) + 1;
      }
      rules.forEach(function (rl) {
        if (truncated) { stopState[rl].miss++; }
        else {
          if (rl === 'orbit-key') key = r.orbitKey;
          else if (rl === 'period-only') key = 'P' + r.period;
          else key = 'P' + r.period + '|' + r.orbitOnes;
          if (!seen[rl][key]) { seen[rl][key] = 1; attractorPeriods[rl].push(r.period); stopState[rl].miss = 0; }
          else stopState[rl].miss++;
        }
        missList.forEach(function (mv) {
          if (stopState[rl].done[mv] === undefined && stopState[rl].miss >= mv) {
            stopState[rl].done[mv] = attractorPeriods[rl].length;
          }
        });
      });
      nInits.forEach(function (ni) {
        if (i + 1 === ni) rules.forEach(function (rl) { counts[rl][ni] = attractorPeriods[rl].length; });
      });
    }
    rules.forEach(function (rl) {
      nInits.forEach(function (ni) { if (counts[rl][ni] === undefined) counts[rl][ni] = attractorPeriods[rl].length; });
      stop[rl] = {};
      missList.forEach(function (mv) {
        stop[rl][mv] = stopState[rl].done[mv] === undefined ? attractorPeriods[rl].length : stopState[rl].done[mv];
      });
    });

    return {
      periodsInit: periodsInit,
      periodsAttractors: attractorPeriods['orbit-key'] || [],
      periodsCompleted: periodsCompleted,
      periodsCensored: periodsCensored,
      truncCount: truncCount,
      periodCounts: periodCounts,
      entryCounts: entryCounts,
      counts: counts,
      stop: stop,
      nDistinct: (attractorPeriods['orbit-key'] || []).length,
    };
  }

  /** log(中央値) vs log(N) の傾きと bootstrap 2SE。 */
  function fitExponent(byN, B, rng) {
    var Ns = Object.keys(byN).map(Number).sort(function (a, b) { return a - b; });
    var xs = [], ys = [], usable = [];
    Ns.forEach(function (N) {
      var v = median(byN[N].map(function (c) { return c.value; }));
      if (v != null && v > 0) { xs.push(Math.log(N)); ys.push(Math.log(v)); usable.push(N); }
    });
    if (xs.length < 3) return { slope: null, se: null, n: xs.length };
    var base = ols(xs, ys).slope;
    var vals = [], b, i;
    for (b = 0; b < B; b++) {
      var bx = [], by = [];
      for (i = 0; i < usable.length; i++) {
        var cells = byN[usable[i]], pick = [];
        for (var j = 0; j < cells.length; j++) pick.push(cells[(rng() * cells.length) | 0].value);
        var mv = median(pick);
        if (mv > 0) { bx.push(Math.log(usable[i])); by.push(Math.log(mv)); }
      }
      if (bx.length >= 3) vals.push(ols(bx, by).slope);
    }
    var mu = mean(vals), v2 = 0;
    for (i = 0; i < vals.length; i++) v2 += (vals[i] - mu) * (vals[i] - mu);
    var se = vals.length > 1 ? Math.sqrt(v2 / (vals.length - 1)) : null;
    return { slope: base, se: se, n: xs.length, medians: ys.map(Math.exp), Ns: usable };
  }

  var api = {
    mapStep: mapStep, derridaSlope: derridaSlope, pcLow: pcLow, pcHigh: pcHigh,
    exactOneStep: exactOneStep,
    sum: sum, mean: mean, median: median, quantile: quantile, quantiles: quantiles, ols: ols,
    armSeries: armSeries, logSBar: logSBar, isDeadArm: isDeadArm, bootstrapLogSBar: bootstrapLogSBar,
    detectCrossing: detectCrossing, bootstrapCrossing: bootstrapCrossing,
    countNetwork: countNetwork, fitExponent: fitExponent,
  };

  global.S32stats = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
