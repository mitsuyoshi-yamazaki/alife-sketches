/*
 * S-19 measures — 観測器。**偏りを語るのはこの層だけ**。
 *
 * 族の全員（Gini・上位x%占有率・平均/中央値・エントロピー・Hoover・Palma・20:20・Theil・CV）は
 * ローレンツ曲線 L(p) の汎関数である。違うのは「どこで切るか」だけ。
 * だから曲線そのものを主に報告し、スカラーは族として横並びに扱う。
 *
 * 依存ゼロ。Node と ブラウザで共用する（UMD 風）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && typeof module.exports === 'object') module.exports = api;
  if (typeof window !== 'undefined') window.S19M = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function makeRng(seed) {
    var a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 事前登録した p の格子: 0.01 .. 0.99（99 点）。単一の p を選ばない。
  var P_GRID = (function () {
    var g = [];
    for (var k = 1; k <= 99; k++) g.push(k / 100);
    return g;
  })();

  function sortedAsc(values) {
    var a = Float64Array.from(values);
    a.sort();
    return a;
  }

  // 累積比の折れ線。points[k] = (k/n, c_k/S)、k = 0..n
  function cumShares(sorted) {
    var n = sorted.length, c = new Float64Array(n + 1), s = 0, i;
    for (i = 0; i < n; i++) { s += sorted[i]; c[i + 1] = s; }
    if (s <= 0) { for (i = 0; i <= n; i++) c[i] = i / n; return { cum: c, total: 0, degenerate: true }; }
    for (i = 0; i <= n; i++) c[i] = c[i] / s;
    return { cum: c, total: s, degenerate: false };
  }

  // L(p) を線形補間で返す
  function lorenzAt(sorted, pGrid) {
    var cs = cumShares(sorted), n = sorted.length, out = new Float64Array(pGrid.length);
    for (var t = 0; t < pGrid.length; t++) {
      var x = pGrid[t] * n;
      var k = Math.floor(x);
      if (k >= n) { out[t] = cs.cum[n]; continue; }
      var frac = x - k;
      out[t] = cs.cum[k] + frac * (cs.cum[k + 1] - cs.cum[k]);
    }
    return out;
  }

  // T(p) = p - L(p)。完全均等なら全ての p で 0。
  function lorenzGap(values, pGrid) {
    var g = pGrid || P_GRID;
    var L = lorenzAt(sortedAsc(values), g);
    var out = new Float64Array(g.length);
    for (var i = 0; i < g.length; i++) out[i] = g[i] - L[i];
    return out;
  }

  // ------------------------------------------------------------ 族の 10 指標
  function gini(values) {
    var a = sortedAsc(values), n = a.length, s = 0, w = 0, i;
    if (n === 0) return NaN;
    for (i = 0; i < n; i++) { s += a[i]; w += (2 * (i + 1) - n - 1) * a[i]; }
    if (s <= 0) return 0;
    return w / (n * s);
  }

  // ローレンツ曲線の台形積分から出す Gini（plug-in 公式と一致するはず: PC3）
  function giniFromLorenz(values) {
    var a = sortedAsc(values), n = a.length;
    var cs = cumShares(a), area = 0;
    for (var k = 1; k <= n; k++) area += (cs.cum[k - 1] + cs.cum[k]) / 2 * (1 / n);
    return 1 - 2 * area;
  }

  function topShare(values, q) { // 上位 q（0<q<1）の占有率
    var a = sortedAsc(values);
    var L = lorenzAt(a, [1 - q]);
    return 1 - L[0];
  }

  function bottomShare(values, q) {
    var a = sortedAsc(values);
    return lorenzAt(a, [q])[0];
  }

  function mean(values) { var s = 0; for (var i = 0; i < values.length; i++) s += values[i]; return s / values.length; }

  function median(values) {
    var a = sortedAsc(values), n = a.length;
    if (n === 0) return NaN;
    return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
  }

  function meanMedian(values) {
    var md = median(values);
    if (!(md > 0)) return Infinity;
    return mean(values) / md;
  }

  function hoover(values) {
    var a = sortedAsc(values), n = a.length, cs = cumShares(a), best = 0;
    for (var k = 0; k <= n; k++) { var d = k / n - cs.cum[k]; if (d > best) best = d; }
    return best;
  }

  function palma(values) {
    var b = bottomShare(values, 0.40);
    if (!(b > 0)) return Infinity;
    return topShare(values, 0.10) / b;
  }

  function ratio2020(values) {
    var b = bottomShare(values, 0.20);
    if (!(b > 0)) return Infinity;
    return topShare(values, 0.20) / b;
  }

  function theil(values) {
    var mu = mean(values), n = values.length, s = 0;
    if (!(mu > 0)) return 0;
    for (var i = 0; i < n; i++) {
      var r = values[i] / mu;
      if (r > 0) s += r * Math.log(r);
    }
    return s / n;
  }

  // 1 - H/ln(n)。「エントロピー」の偏り向きの版。
  function redundancy(values) {
    var n = values.length, tot = 0, i;
    if (n < 2) return NaN;
    for (i = 0; i < n; i++) tot += values[i];
    if (!(tot > 0)) return 0;
    var H = 0;
    for (i = 0; i < n; i++) {
      var s = values[i] / tot;
      if (s > 0) H -= s * Math.log(s);
    }
    return 1 - H / Math.log(n);
  }

  function cv(values) {
    var mu = mean(values), n = values.length, s = 0;
    if (!(mu > 0)) return Infinity;
    for (var i = 0; i < n; i++) { var d = values[i] - mu; s += d * d; }
    return Math.sqrt(s / n) / mu;
  }

  var CORE_CUTS = ['gini', 'top10', 'top01', 'meanMedian', 'redundancy'];
  var EXTENDED_CUTS = ['hoover', 'palma', 'ratio2020', 'theil', 'cv'];
  var ALL_CUTS = CORE_CUTS.concat(EXTENDED_CUTS);

  var MEASURES = {
    gini: gini,
    top10: function (v) { return topShare(v, 0.10); },
    top01: function (v) { return topShare(v, 0.01); },
    meanMedian: meanMedian,
    redundancy: redundancy,
    hoover: hoover,
    palma: palma,
    ratio2020: ratio2020,
    theil: theil,
    cv: cv
  };

  function allMeasures(values) {
    var out = {};
    for (var i = 0; i < ALL_CUTS.length; i++) {
      var k = ALL_CUTS[i], v = MEASURES[k](values);
      out[k] = isFinite(v) ? v : null; // 非有限は null。除外して黙らない（criteria の nonFiniteRule）
    }
    return out;
  }

  // ------------------------------------------------------------ 参照点（K-24）
  // R0: 同じ人数へ同じ総量を i.i.d. Uniform で配る。族は全員スケール不変なので n だけで決まる。
  // R0b: 同じ総量を多項分布で配る（「ランダム配分」のもう一つの読み方）。
  function drawIidUniform(n, rng) {
    var a = new Float64Array(n);
    for (var i = 0; i < n; i++) a[i] = rng();
    return a;
  }

  function drawMultinomial(n, total, rng) {
    var a = new Float64Array(n);
    for (var t = 0; t < total; t++) a[Math.floor(rng() * n)] += 1;
    return a;
  }

  var _refCache = {};
  function referenceTable(n, kind, reps, seed) {
    var key = n + '|' + kind + '|' + reps + '|' + seed;
    if (_refCache[key]) return _refCache[key];
    var rng = makeRng(seed || 20260911);
    var acc = {}, i, k;
    for (i = 0; i < ALL_CUTS.length; i++) acc[ALL_CUTS[i]] = [];
    for (var r = 0; r < reps; r++) {
      var v = kind === 'multinomial' ? drawMultinomial(n, 20 * n, rng) : drawIidUniform(n, rng);
      var m = allMeasures(v);
      for (i = 0; i < ALL_CUTS.length; i++) { k = ALL_CUTS[i]; if (m[k] !== null) acc[k].push(m[k]); }
    }
    var out = { n: n, kind: kind, reps: reps, mean: {}, lo: {}, hi: {}, sd: {} };
    for (i = 0; i < ALL_CUTS.length; i++) {
      k = ALL_CUTS[i];
      var arr = acc[k].slice().sort(function (a, b) { return a - b; });
      if (arr.length === 0) { out.mean[k] = null; out.lo[k] = null; out.hi[k] = null; out.sd[k] = null; continue; }
      var mu = 0, j;
      for (j = 0; j < arr.length; j++) mu += arr[j];
      mu /= arr.length;
      var sd = 0;
      for (j = 0; j < arr.length; j++) sd += (arr[j] - mu) * (arr[j] - mu);
      sd = Math.sqrt(sd / arr.length);
      out.mean[k] = mu; out.sd[k] = sd;
      out.lo[k] = arr[Math.floor(0.025 * (arr.length - 1))];
      out.hi[k] = arr[Math.ceil(0.975 * (arr.length - 1))];
    }
    _refCache[key] = out;
    return out;
  }

  // 超過比 E = M_obs / M_ref。族の全員が帰無値 1.0 を持つ共通の尺度になる（K-10）。
  function excessRatios(values, ref) {
    var m = allMeasures(values), out = {};
    for (var i = 0; i < ALL_CUTS.length; i++) {
      var k = ALL_CUTS[i];
      var r = ref.mean[k];
      out[k] = (m[k] === null || r === null || !(Math.abs(r) > 1e-12)) ? null : m[k] / r;
    }
    return out;
  }

  // ------------------------------------------------------------ 曲線の大域検定（K-23）
  // obs: Float64Array(T(p))、nulls: Float64Array の配列。
  // データ1本 + 帰無 N 本 の計 N+1 本から平均・標準偏差を出し、studentized MAD を順位付けする。
  function globalTest(obs, nulls) {
    var N = nulls.length, m = obs.length, i, t;
    var curves = [obs].concat(nulls);
    var mu = new Float64Array(m), sd = new Float64Array(m);
    for (t = 0; t < m; t++) {
      var s = 0;
      for (i = 0; i < curves.length; i++) s += curves[i][t];
      mu[t] = s / curves.length;
    }
    for (t = 0; t < m; t++) {
      var q = 0;
      for (i = 0; i < curves.length; i++) { var d = curves[i][t] - mu[t]; q += d * d; }
      sd[t] = Math.sqrt(q / curves.length);
    }
    function mad(curve, studentize) {
      var best = 0, at = 0;
      for (var k = 0; k < m; k++) {
        var den = studentize ? (sd[k] > 1e-12 ? sd[k] : 1e-12) : 1;
        var v = Math.abs(curve[k] - mu[k]) / den;
        if (v > best) { best = v; at = k; }
      }
      return { value: best, at: at };
    }
    var obsStud = mad(obs, true), obsRaw = mad(obs, false);
    var geStud = 1, geRaw = 1;
    for (i = 0; i < N; i++) {
      if (mad(nulls[i], true).value >= obsStud.value) geStud++;
      if (mad(nulls[i], false).value >= obsRaw.value) geRaw++;
    }
    // 各点包絡線（下から2番目・上から2番目）
    var lo = new Float64Array(m), hi = new Float64Array(m), outside = new Uint8Array(m);
    var col = new Float64Array(N);
    var exitLo = -1, exitHi = -1, outCount = 0;
    for (t = 0; t < m; t++) {
      for (i = 0; i < N; i++) col[i] = nulls[i][t];
      var sorted = Array.prototype.slice.call(col).sort(function (a, b) { return a - b; });
      lo[t] = sorted[Math.min(1, N - 1)];
      hi[t] = sorted[Math.max(N - 2, 0)];
      if (obs[t] < lo[t] || obs[t] > hi[t]) { outside[t] = 1; outCount++; if (exitLo < 0) exitLo = t; exitHi = t; }
    }
    return {
      pStudentized: geStud / (N + 1),
      pRaw: geRaw / (N + 1),
      madStudentized: obsStud.value,
      madStudentizedAt: obsStud.at,
      madRaw: obsRaw.value,
      madRawAt: obsRaw.at,
      envelopeLo: Array.prototype.slice.call(lo),
      envelopeHi: Array.prototype.slice.call(hi),
      outsideIndex: Array.prototype.slice.call(outside),
      outsideFraction: outCount / m,
      exitLoIndex: exitLo,
      exitHiIndex: exitHi,
      nullMean: Array.prototype.slice.call(mu),
      nullSd: Array.prototype.slice.call(sd)
    };
  }

  // 散らばりの尺度: (max - min) / median。非有限は除外して件数を返す。
  function spread(values) {
    var v = [], i;
    for (i = 0; i < values.length; i++) if (values[i] !== null && isFinite(values[i])) v.push(values[i]);
    var dropped = values.length - v.length;
    if (v.length < 2) return { spread: null, n: v.length, dropped: dropped, min: null, max: null, median: null };
    v.sort(function (a, b) { return a - b; });
    var md = v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
    return {
      spread: Math.abs(md) > 1e-12 ? (v[v.length - 1] - v[0]) / Math.abs(md) : null,
      n: v.length, dropped: dropped, min: v[0], max: v[v.length - 1], median: md
    };
  }

  function spearman(a, b) {
    function ranks(x) {
      var idx = x.map(function (v, i) { return [v, i]; });
      idx.sort(function (p, q) { return p[0] - q[0]; });
      var r = new Array(x.length), i = 0;
      while (i < idx.length) {
        var j = i;
        while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
        var avg = (i + j) / 2 + 1;
        for (var k = i; k <= j; k++) r[idx[k][1]] = avg;
        i = j + 1;
      }
      return r;
    }
    var pairs = [];
    for (var i = 0; i < a.length; i++) if (a[i] !== null && b[i] !== null && isFinite(a[i]) && isFinite(b[i])) pairs.push([a[i], b[i]]);
    if (pairs.length < 3) return null;
    var ra = ranks(pairs.map(function (p) { return p[0]; }));
    var rb = ranks(pairs.map(function (p) { return p[1]; }));
    var ma = 0, mb = 0, i2;
    for (i2 = 0; i2 < ra.length; i2++) { ma += ra[i2]; mb += rb[i2]; }
    ma /= ra.length; mb /= rb.length;
    var num = 0, da = 0, db = 0;
    for (i2 = 0; i2 < ra.length; i2++) {
      var x = ra[i2] - ma, y = rb[i2] - mb;
      num += x * y; da += x * x; db += y * y;
    }
    if (da <= 0 || db <= 0) return null;
    return num / Math.sqrt(da * db);
  }

  return {
    P_GRID: P_GRID,
    makeRng: makeRng,
    sortedAsc: sortedAsc,
    cumShares: cumShares,
    lorenzAt: lorenzAt,
    lorenzGap: lorenzGap,
    gini: gini,
    giniFromLorenz: giniFromLorenz,
    topShare: topShare,
    bottomShare: bottomShare,
    mean: mean,
    median: median,
    meanMedian: meanMedian,
    hoover: hoover,
    palma: palma,
    ratio2020: ratio2020,
    theil: theil,
    redundancy: redundancy,
    cv: cv,
    CORE_CUTS: CORE_CUTS,
    EXTENDED_CUTS: EXTENDED_CUTS,
    ALL_CUTS: ALL_CUTS,
    MEASURES: MEASURES,
    allMeasures: allMeasures,
    drawIidUniform: drawIidUniform,
    drawMultinomial: drawMultinomial,
    referenceTable: referenceTable,
    excessRatios: excessRatios,
    globalTest: globalTest,
    spread: spread,
    spearman: spearman
  };
});
