/**
 * S-65: 小さい統計の道具（中央値・Spearman・ICC・χ²・AR(1)代理系列による「まだ動いている」判定）。
 * 依存ゼロ。Node とブラウザで共用。
 */
(function (global) {
  'use strict';

  function mean(a) { return a.length ? a.reduce(function (s, v) { return s + v; }, 0) / a.length : null; }
  function sd(a) {
    if (a.length < 2) return 0;
    var m = mean(a);
    return Math.sqrt(a.reduce(function (s, v) { return s + (v - m) * (v - m); }, 0) / (a.length - 1));
  }
  function median(a) {
    if (!a.length) return null;
    var b = a.slice().sort(function (x, y) { return x - y; });
    var n = b.length;
    return n % 2 ? b[(n - 1) / 2] : (b[n / 2 - 1] + b[n / 2]) / 2;
  }
  function movingMedian(a, win) {
    var out = [];
    for (var i = 0; i < a.length; i++) {
      var lo = Math.max(0, i - Math.floor(win / 2)), hi = Math.min(a.length, lo + win);
      out.push(median(a.slice(lo, hi)));
    }
    return out;
  }

  function rank(a) {
    var idx = a.map(function (v, i) { return i; }).sort(function (i, j) { return a[i] - a[j]; });
    var r = new Array(a.length);
    var i = 0;
    while (i < idx.length) {
      var j = i;
      while (j + 1 < idx.length && a[idx[j + 1]] === a[idx[i]]) j++;
      var avg = (i + j) / 2 + 1;
      for (var k = i; k <= j; k++) r[idx[k]] = avg;
      i = j + 1;
    }
    return r;
  }

  function spearman(xs, ys) {
    if (xs.length < 3 || xs.length !== ys.length) return null;
    var rx = rank(xs), ry = rank(ys);
    var mx = mean(rx), my = mean(ry);
    var num = 0, dx2 = 0, dy2 = 0;
    for (var i = 0; i < rx.length; i++) { var dx = rx[i] - mx, dy = ry[i] - my; num += dx * dy; dx2 += dx * dx; dy2 += dy * dy; }
    if (dx2 === 0 || dy2 === 0) return 0;
    return num / Math.sqrt(dx2 * dy2);
  }

  /** ICC(1): 一元配置ランダム効果（groups: [[値...], [値...], ...]）。 */
  function icc1(groups) {
    var all = [].concat.apply([], groups);
    var N = all.length, k = groups.length;
    if (k < 2 || N <= k) return null;
    var grand = mean(all);
    var ssBetween = 0, ssWithin = 0;
    groups.forEach(function (g) {
      var gm = mean(g);
      ssBetween += g.length * (gm - grand) * (gm - grand);
      g.forEach(function (v) { ssWithin += (v - gm) * (v - gm); });
    });
    var dfB = k - 1, dfW = N - k;
    var msB = ssBetween / dfB, msW = dfW > 0 ? ssWithin / dfW : 0;
    var nbar = N / k;
    var denom = msB + (nbar - 1) * msW;
    if (denom <= 0) return 0;
    return Math.max(0, (msB - msW) / denom);
  }

  /** χ²適合度検定（観測度数 vs 期待度数）。p値は Wilson-Hilferty のガンマ近似。 */
  function chiSquareGOF(observed, expected) {
    var chi2 = 0, df = observed.length - 1;
    for (var i = 0; i < observed.length; i++) { var e = expected[i]; if (e > 0) chi2 += (observed[i] - e) * (observed[i] - e) / e; }
    var p = 1 - chiSquareCDF(chi2, df);
    return { chi2: chi2, df: df, p: p };
  }
  function chiSquareCDF(x, k) {
    if (x <= 0) return 0;
    return lowerGammaReg(k / 2, x / 2);
  }
  function lowerGammaReg(a, x) {
    if (x < a + 1) {
      var sum = 1 / a, term = sum, n = 1;
      for (var i = 0; i < 200; i++) { term *= x / (a + n); sum += term; if (Math.abs(term) < 1e-12 * Math.abs(sum)) break; n++; }
      return sum * Math.exp(-x + a * Math.log(x) - logGamma(a));
    }
    var b = x + 1 - a, c = 1e308, d = 1 / b, h = d;
    for (i = 1; i < 200; i++) {
      var an = -i * (i - a);
      b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
      c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
      d = 1 / d; var del = d * c; h *= del; if (Math.abs(del - 1) < 1e-12) break;
    }
    return 1 - Math.exp(-x + a * Math.log(x) - logGamma(a)) * h;
  }
  function logGamma(x) {
    var g = 7, c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
    x -= 1; var a = c[0], t = x + g + 0.5;
    for (var i = 1; i < g + 2; i++) a += c[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }

  /** OLS の傾きの t 値。 */
  function slopeT(ys) {
    var n = ys.length;
    if (n < 3) return null;
    var xs = ys.map(function (_, i) { return i; });
    var mx = mean(xs), my = mean(ys);
    var sxx = 0, sxy = 0;
    for (var i = 0; i < n; i++) { sxx += (xs[i] - mx) * (xs[i] - mx); sxy += (xs[i] - mx) * (ys[i] - my); }
    if (sxx === 0) return null;
    var slope = sxy / sxx;
    var resid = ys.map(function (y, i) { return y - (my + slope * (xs[i] - mx)); });
    var sse = resid.reduce(function (s, r) { return s + r * r; }, 0);
    var dof = n - 2; if (dof <= 0) return null;
    var se = Math.sqrt(sse / dof / sxx);
    return se > 0 ? slope / se : null;
  }

  /** AR(1) の遅れ1自己相関と残差sdを推定し、同じ性質の代理系列を1本作る。 */
  function fitAR1(ys) {
    var n = ys.length;
    var m = mean(ys);
    var num = 0, den = 0;
    for (var i = 1; i < n; i++) { num += (ys[i] - m) * (ys[i - 1] - m); den += (ys[i - 1] - m) * (ys[i - 1] - m); }
    var phi = den > 0 ? num / den : 0;
    phi = Math.max(-0.98, Math.min(0.98, phi));
    var resid = [];
    for (i = 1; i < n; i++) resid.push((ys[i] - m) - phi * (ys[i - 1] - m));
    return { mean: m, phi: phi, residSd: sd(resid) };
  }
  function surrogateAR1(n, fit, rngFn) {
    var out = [fit.mean];
    for (var i = 1; i < n; i++) {
      var u1 = Math.max(1e-12, rngFn()), u2 = rngFn();
      var z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      out.push(fit.mean + fit.phi * (out[i - 1] - fit.mean) + z * fit.residSd);
    }
    return out;
  }

  /** 「まだ動いている」判定: 傾きの|t|が、同じAR(1)代理1000本の|t|の95%点を越えるか。 */
  function stillDrifting(ys, nSurrogate, rngFn) {
    if (ys.length < 10) return { notImplemented: true, reason: '系列がW内で10点未満（判定に要る最小の長さに届かない）' };
    var t = slopeT(ys);
    if (t == null) return { drifting: false, notImplemented: true, reason: '傾きのt値が計算できなかった（分散が0）' };
    var fit = fitAR1(ys);
    var ts = [];
    for (var i = 0; i < nSurrogate; i++) { var surr = surrogateAR1(ys.length, fit, rngFn); var st = slopeT(surr); if (st != null) ts.push(Math.abs(st)); }
    ts.sort(function (a, b) { return a - b; });
    if (!ts.length) return { drifting: false, notImplemented: true, reason: '代理系列のt値が1本も計算できなかった' };
    var p95 = ts[Math.floor(0.95 * ts.length)];
    return { drifting: Math.abs(t) > p95, tValue: t, p95: p95 };
  }

  var ST = {
    mean: mean, sd: sd, median: median, movingMedian: movingMedian, rank: rank, spearman: spearman,
    icc1: icc1, chiSquareGOF: chiSquareGOF, slopeT: slopeT, fitAR1: fitAR1, surrogateAR1: surrogateAR1, stillDrifting: stillDrifting,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = ST;
  global.S65Stats = ST;
})(typeof window !== 'undefined' ? window : globalThis);
