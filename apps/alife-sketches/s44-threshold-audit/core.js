/**
 * S-44: 閾値の自己導出監査 — 核（統計の道具だけ）
 *
 * ここには対象系の語彙は一切無い（S-02の粒子・S-08の反応拡散・S-21の複写、
 * どれも知らない）。あるのは「数の並びから閾値を導く」ための道具だけである。
 *
 *   - 2成分ガウス混合(EM) + BIC(k=1 vs k=2)ゲート … 主
 *   - Otsu法（ヒストグラムのクラス間分散を最大化する1点） … 対照
 *   - Sarleの二峰性係数 … 事前ゲート（二峰と呼べるかの目安）
 *   - スイープ順を保った参照からの閾値の逆算（周辺分布の谷 → 元の掃引軸への逆写像）
 *
 * 依存ゼロ。Node（run.js・selftest.js）とブラウザ（viewer.html）が同じファイルを読む。
 * 乱数はシード固定（S-02 と同じ mulberry32 系の PRNG。移植ではなく同じ公開アルゴリズムを
 * 独立に書いたもの——出典: https://github.com/bryc/code/blob/master/jshash/PRNGs.md の記述を
 * 参考にした一般に知られた実装）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S44 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------- 乱数

  /** mulberry32。シードを固定すれば完全に再現する。 */
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Box-Muller。rng は [0,1) を返す関数。 */
  function sampleNormal(rng) {
    var u1 = Math.max(rng(), 1e-12);
    var u2 = rng();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  // ------------------------------------------------------------- 基本統計

  function mean(xs) {
    if (xs.length === 0) return NaN;
    var s = 0;
    for (var i = 0; i < xs.length; i++) s += xs[i];
    return s / xs.length;
  }

  /** 母集団分散（n で割る）。EM の分散推定・BC の計算ともこちらに揃える。 */
  function variance(xs, m) {
    if (xs.length === 0) return NaN;
    var mu = m === undefined ? mean(xs) : m;
    var s = 0;
    for (var i = 0; i < xs.length; i++) { var d = xs[i] - mu; s += d * d; }
    return s / xs.length;
  }

  function std(xs, m) { return Math.sqrt(variance(xs, m)); }

  /** 標本の歪度 g1 = m3 / m2^1.5（母集団モーメント）。 */
  function skewness(xs) {
    var m = mean(xs), n = xs.length;
    var m2 = 0, m3 = 0;
    for (var i = 0; i < n; i++) { var d = xs[i] - m; m2 += d * d; m3 += d * d * d; }
    m2 /= n; m3 /= n;
    if (m2 <= 0) return 0;
    return m3 / Math.pow(m2, 1.5);
  }

  /** 超過尖度 g2 = m4/m2^2 - 3（母集団モーメント）。 */
  function excessKurtosis(xs) {
    var m = mean(xs), n = xs.length;
    var m2 = 0, m4 = 0;
    for (var i = 0; i < n; i++) { var d = xs[i] - m; m2 += d * d; m4 += d * d * d * d; }
    m2 /= n; m4 /= n;
    if (m2 <= 0) return 0;
    return m4 / (m2 * m2) - 3;
  }

  /**
   * Sarleの二峰性係数。BC = (g1^2 + 1) / (g2 + 3(n-1)^2/((n-2)(n-3)))
   * 一様分布で 5/9 になる（criteria.json の借り物の定数）。n<=3 は未定義として NaN を返す。
   */
  function bimodalityCoefficient(xs) {
    var n = xs.length;
    if (n <= 3) return NaN;
    var g1 = skewness(xs), g2 = excessKurtosis(xs);
    var correction = (3 * (n - 1) * (n - 1)) / ((n - 2) * (n - 3));
    return (g1 * g1 + 1) / (g2 + correction);
  }

  // ------------------------------------------------------------- ヒストグラム

  /** 等幅ビンのヒストグラム。境界は [min, max] を bins 等分。 */
  function histogram(xs, bins) {
    var min = Infinity, max = -Infinity;
    for (var i = 0; i < xs.length; i++) { if (xs[i] < min) min = xs[i]; if (xs[i] > max) max = xs[i]; }
    if (!(max > min)) { max = min + 1; } // 全点同一値のときの退避
    var edges = new Array(bins + 1);
    var width = (max - min) / bins;
    for (var b = 0; b <= bins; b++) edges[b] = min + b * width;
    var counts = new Array(bins).fill(0);
    for (var j = 0; j < xs.length; j++) {
      var idx = Math.floor((xs[j] - min) / width);
      if (idx < 0) idx = 0;
      if (idx >= bins) idx = bins - 1;
      counts[idx]++;
    }
    return { edges: edges, counts: counts, min: min, max: max, width: width, n: xs.length };
  }

  // ------------------------------------------------------------- Otsu法

  /**
   * Otsu法（累積和による高速版）。ヒストグラムを2クラスに割り、
   * クラス間分散 w0*w1*(mu0-mu1)^2 を最大化する境界を返す。
   * @returns {threshold, betweenVar, binIndex} binIndex はその境界の左側にある最後のビンの添字
   */
  function otsuFast(hist) {
    var bins = hist.counts.length;
    var centers = new Array(bins);
    for (var b = 0; b < bins; b++) centers[b] = (hist.edges[b] + hist.edges[b + 1]) / 2;

    var total = 0, totalWeighted = 0;
    for (b = 0; b < bins; b++) { total += hist.counts[b]; totalWeighted += hist.counts[b] * centers[b]; }
    if (total === 0) return { threshold: (hist.min + hist.max) / 2, betweenVar: 0, binIndex: -1 };

    var cumCount = 0, cumWeighted = 0;
    var best = { betweenVar: -1, binIndex: -1 };
    for (var k = 0; k < bins - 1; k++) {
      cumCount += hist.counts[k];
      cumWeighted += hist.counts[k] * centers[k];
      var w0 = cumCount / total, w1 = 1 - w0;
      if (w0 <= 0 || w1 <= 0) continue;
      var mu0 = cumWeighted / cumCount;
      var mu1 = (totalWeighted - cumWeighted) / (total - cumCount);
      var betweenVar = w0 * w1 * (mu0 - mu1) * (mu0 - mu1);
      if (betweenVar > best.betweenVar) best = { betweenVar: betweenVar, binIndex: k };
    }
    if (best.binIndex < 0) return { threshold: (hist.min + hist.max) / 2, betweenVar: 0, binIndex: -1 };
    return { threshold: hist.edges[best.binIndex + 1], betweenVar: best.betweenVar, binIndex: best.binIndex };
  }

  /**
   * 同じ定義の総当たり版（累積和を使わず、境界ごとに両クラスの和をゼロから数え直す）。
   * 「近道の検算」——高速化した累積和が素朴な総当たりと一致するかを selftest で突き合わせる。
   */
  function otsuBrute(hist) {
    var bins = hist.counts.length;
    var centers = new Array(bins);
    for (var b = 0; b < bins; b++) centers[b] = (hist.edges[b] + hist.edges[b + 1]) / 2;
    var total = 0;
    for (b = 0; b < bins; b++) total += hist.counts[b];
    if (total === 0) return { threshold: (hist.min + hist.max) / 2, betweenVar: 0, binIndex: -1 };

    var best = { betweenVar: -1, binIndex: -1 };
    for (var k = 0; k < bins - 1; k++) {
      var n0 = 0, s0 = 0, n1 = 0, s1 = 0;
      for (var i = 0; i <= k; i++) { n0 += hist.counts[i]; s0 += hist.counts[i] * centers[i]; }
      for (var j = k + 1; j < bins; j++) { n1 += hist.counts[j]; s1 += hist.counts[j] * centers[j]; }
      if (n0 === 0 || n1 === 0) continue;
      var w0 = n0 / total, w1 = n1 / total;
      var mu0 = s0 / n0, mu1 = s1 / n1;
      var betweenVar = w0 * w1 * (mu0 - mu1) * (mu0 - mu1);
      if (betweenVar > best.betweenVar) best = { betweenVar: betweenVar, binIndex: k };
    }
    if (best.binIndex < 0) return { threshold: (hist.min + hist.max) / 2, betweenVar: 0, binIndex: -1 };
    return { threshold: hist.edges[best.binIndex + 1], betweenVar: best.betweenVar, binIndex: best.binIndex };
  }

  /** 値の配列から直接 Otsu 閾値を求める便宜関数。 */
  function otsuThreshold(xs, bins) {
    var h = histogram(xs, bins || 50);
    return otsuFast(h);
  }

  // ------------------------------------------------------------- GMM(k=1,2) + BIC

  function normalPdf(x, mu, sigma) {
    var s = Math.max(sigma, 1e-12);
    var z = (x - mu) / s;
    return Math.exp(-0.5 * z * z) / (s * Math.sqrt(2 * Math.PI));
  }

  function normalLogPdf(x, mu, sigma) {
    var s = Math.max(sigma, 1e-12);
    var z = (x - mu) / s;
    return -0.5 * z * z - Math.log(s) - 0.5 * Math.log(2 * Math.PI);
  }

  /** k=1: 単一ガウスの最尤推定（閉形式）。 */
  function fitGaussian1(xs) {
    var mu = mean(xs);
    var sigma2 = variance(xs, mu);
    var sigma = Math.sqrt(Math.max(sigma2, 1e-12));
    var logLik = 0;
    for (var i = 0; i < xs.length; i++) logLik += normalLogPdf(xs[i], mu, sigma);
    return { mu: mu, sigma: sigma, logLik: logLik, k: 1, numParams: 2 };
  }

  /**
   * EM の1反復（E-step + M-step）。viewer.html がこれを繰り返し呼んで収束の過程を
   * そのままアニメーションできるよう、収束ループ（emOnce）から独立させてある。
   * @returns {mu1,mu2,sigma1,sigma2,w1,w2,logLik,degenerate}
   */
  function emStep(xs, state, varFloor) {
    var n = xs.length;
    var mu1 = state.mu1, mu2 = state.mu2, s1 = state.sigma1, s2 = state.sigma2, w1 = state.w1, w2 = state.w2;
    var resp = new Array(n);
    var logLik = 0;
    for (var i = 0; i < n; i++) {
      var p1 = w1 * normalPdf(xs[i], mu1, s1);
      var p2 = w2 * normalPdf(xs[i], mu2, s2);
      var denom = p1 + p2;
      if (denom <= 0) { resp[i] = 0.5; logLik += -745; continue; } // アンダーフローの退避（発散扱い）
      resp[i] = p1 / denom;
      logLik += Math.log(denom);
    }
    var sumR1 = 0, sumR2 = 0, sumX1 = 0, sumX2 = 0;
    for (i = 0; i < n; i++) {
      sumR1 += resp[i]; sumR2 += (1 - resp[i]);
      sumX1 += resp[i] * xs[i]; sumX2 += (1 - resp[i]) * xs[i];
    }
    if (sumR1 <= 1e-9 || sumR2 <= 1e-9) return { degenerate: true, logLik: logLik }; // 一方の成分が空になった＝退化
    var newMu1 = sumX1 / sumR1, newMu2 = sumX2 / sumR2;
    var sv1 = 0, sv2 = 0;
    for (i = 0; i < n; i++) {
      var d1 = xs[i] - newMu1, d2 = xs[i] - newMu2;
      sv1 += resp[i] * d1 * d1;
      sv2 += (1 - resp[i]) * d2 * d2;
    }
    return {
      degenerate: false, logLik: logLik,
      mu1: newMu1, mu2: newMu2,
      sigma1: Math.sqrt(Math.max(sv1 / sumR1, varFloor)), sigma2: Math.sqrt(Math.max(sv2 / sumR2, varFloor)),
      w1: sumR1 / n, w2: sumR2 / n,
    };
  }

  /**
   * k=2 の EM を1回、与えた初期値から収束まで回す（emStep を繰り返すだけ）。
   * @param {number[]} xs
   * @param {{mu1:number,mu2:number,sigma1:number,sigma2:number,w1:number,w2:number}} init
   * @param {number} maxIter
   * @param {number} varFloor 分散の下限（退化防止。全体分散の小さな割合）
   */
  function emOnce(xs, init, maxIter, varFloor) {
    var state = {
      mu1: init.mu1, mu2: init.mu2,
      sigma1: Math.max(init.sigma1, Math.sqrt(varFloor)), sigma2: Math.max(init.sigma2, Math.sqrt(varFloor)),
      w1: init.w1, w2: init.w2,
    };
    var prevLogLik = -Infinity, iter = 0, converged = false;

    for (iter = 0; iter < maxIter; iter++) {
      var next = emStep(xs, state, varFloor);
      if (next.degenerate) { converged = false; break; }
      var logLik = next.logLik;
      state = { mu1: next.mu1, mu2: next.mu2, sigma1: next.sigma1, sigma2: next.sigma2, w1: next.w1, w2: next.w2 };
      if (Math.abs(logLik - prevLogLik) < 1e-9 * (Math.abs(prevLogLik) + 1)) { prevLogLik = logLik; converged = true; iter++; break; }
      prevLogLik = logLik;
    }

    var mu1 = state.mu1, mu2 = state.mu2, s1 = state.sigma1, s2 = state.sigma2, w1 = state.w1, w2 = state.w2;
    if (mu1 > mu2) { var tm = mu1; mu1 = mu2; mu2 = tm; var ts = s1; s1 = s2; s2 = ts; var tw = w1; w1 = w2; w2 = tw; }
    return {
      mu1: mu1, mu2: mu2, sigma1: s1, sigma2: s2, w1: w1, w2: w2,
      logLik: prevLogLik, iterations: iter, converged: converged, k: 2, numParams: 5,
    };
  }

  /**
   * k=2 の EM を複数のランダム初期値から再起動し、収束した中で対数尤度最大のものを採る。
   * ceilings（criteria.json）: maxIter 既定 500・restarts 既定 20。
   * @returns {best, all, discarded, valleySpread}
   */
  function fitGmm2(xs, opts) {
    opts = opts || {};
    var restarts = opts.restarts || 20;
    var maxIter = opts.maxIter || 500;
    var rng = opts.rng || makeRng(1);
    var overallSd = std(xs) || 1;
    var varFloor = Math.pow(overallSd * 1e-3, 2) || 1e-12;

    var n = xs.length;
    var sorted = xs.slice().sort(function (a, b) { return a - b; });
    var results = [];
    for (var r = 0; r < restarts; r++) {
      // 初期値: データから無作為に2点を平均の種にする（K-means++ 風ではなく単純な無作為選択。
      // 再起動回数で頑健性を担保する方針は criteria.json の ceilings 欄の通り）
      var i1 = Math.floor(rng() * n), i2 = Math.floor(rng() * n);
      var mu1 = sorted[i1], mu2 = sorted[i2];
      if (mu1 === mu2) mu2 = sorted[Math.min(n - 1, i2 + 1)];
      var init = { mu1: mu1, mu2: mu2, sigma1: overallSd / 2, sigma2: overallSd / 2, w1: 0.5, w2: 0.5 };
      var res = emOnce(xs, init, maxIter, varFloor);
      results.push(res);
    }
    var converged = results.filter(function (r) { return r.converged; });
    var discarded = results.length - converged.length;
    if (converged.length === 0) return { best: null, all: results, discarded: discarded, ok: false };

    converged.sort(function (a, b) { return b.logLik - a.logLik; });
    var best = converged[0];

    // 初期値依存の頑健性: 収束解の谷の位置が観測範囲に対してどれだけ散らばるか
    var valleys = converged.map(function (r) { return findValley(r); }).filter(function (v) { return v !== null; });
    var range = (Math.max.apply(null, xs) - Math.min.apply(null, xs)) || 1;
    var valleySpread = valleys.length > 1
      ? (Math.max.apply(null, valleys) - Math.min.apply(null, valleys)) / range
      : 0;

    return { best: best, all: results, discarded: discarded, ok: true, valleySpread: valleySpread, valleys: valleys };
  }

  /** BIC = -2*logLik + numParams*ln(n)。小さいほど良い。 */
  function bic(fit, n) {
    return -2 * fit.logLik + fit.numParams * Math.log(n);
  }

  /**
   * 2成分の密度が等しくなる点（谷）を、両平均のあいだで数値的に探す。
   * 解析的に二次方程式を解く方法もあるが、複数根の選別がかえって複雑になるため、
   * 素朴な走査+二分法を採る（正しさが読みやすいことを優先した）。
   * 谷が見つからない（符号が変わらない）場合は null を返す。
   */
  function findValley(gmm2) {
    var lo = Math.min(gmm2.mu1, gmm2.mu2), hi = Math.max(gmm2.mu1, gmm2.mu2);
    if (hi <= lo) return lo;
    function f(x) {
      return gmm2.w1 * normalPdf(x, gmm2.mu1, gmm2.sigma1) - gmm2.w2 * normalPdf(x, gmm2.mu2, gmm2.sigma2);
    }
    var steps = 4000;
    var prevX = lo, prevF = f(lo);
    var crossing = null;
    for (var i = 1; i <= steps; i++) {
      var x = lo + (hi - lo) * (i / steps);
      var fx = f(x);
      if ((prevF <= 0 && fx > 0) || (prevF >= 0 && fx < 0)) { crossing = [prevX, x]; break; }
      prevX = x; prevF = fx;
    }
    if (!crossing) return null;
    var a = crossing[0], b = crossing[1];
    var fa = f(a);
    for (var it = 0; it < 60; it++) {
      var mid = (a + b) / 2;
      var fm = f(mid);
      if ((fa <= 0 && fm > 0) || (fa >= 0 && fm < 0)) { b = mid; } else { a = mid; fa = fm; }
    }
    return (a + b) / 2;
  }

  /**
   * BIC(k=1 vs k=2) ゲート。k=1 が勝てば「棄権」——一致/不一致を判定しない。
   * k=2 が勝てば、その GMM と谷を返す。
   */
  function chooseComponents(xs, opts) {
    var g1 = fitGaussian1(xs);
    var bic1 = bic(g1, xs.length);
    var g2fit = fitGmm2(xs, opts);
    if (!g2fit.ok) {
      return { abstain: true, reason: 'k=2 が全初期値で発散した（技術的棄権）', bic1: bic1, discarded: g2fit.discarded };
    }
    var bic2 = bic(g2fit.best, xs.length);
    var valley = findValley(g2fit.best);
    if (bic1 <= bic2) {
      return { abstain: true, reason: 'BIC が k=1 を選好', bic1: bic1, bic2: bic2, gmm1: g1, gmm2: g2fit.best, valley: valley, discarded: g2fit.discarded, valleySpread: g2fit.valleySpread };
    }
    return { abstain: false, bic1: bic1, bic2: bic2, gmm1: g1, gmm2: g2fit.best, valley: valley, discarded: g2fit.discarded, valleySpread: g2fit.valleySpread };
  }

  // ------------------------------------------------------------- 一致判定

  function relativeDistance(a, b, range) {
    if (!(range > 0)) return Infinity;
    return Math.abs(a - b) / range;
  }

  /** decisionRule: d<=0.10 一致, 0.10<d<=0.25 部分一致, d>0.25 不一致。 */
  function classify(d) {
    if (!isFinite(d)) return '判定不能';
    if (d <= 0.10) return '一致';
    if (d <= 0.25) return '部分一致';
    return '不一致';
  }

  // ------------------------------------------------------------- スイープ順を保った参照からの逆算

  /**
   * points（{x, y} の配列、x 昇順・y は単調減少を想定）から、y が初めて thresholdY を
   * 下回る区間を線形補間して x を返す（S-21 自身の crossingRule と同じ考え方）。
   * 一度も下回らなければ null。
   */
  function firstCrossing(points, thresholdY) {
    for (var i = 1; i < points.length; i++) {
      var prev = points[i - 1], cur = points[i];
      if (prev.y >= thresholdY && cur.y < thresholdY) {
        var t = (prev.y - thresholdY) / (prev.y - cur.y);
        return prev.x + t * (cur.x - prev.x);
      }
    }
    return null;
  }

  // ------------------------------------------------------------- ブートストラップ雑音床

  /**
   * 谷の位置のブートストラップ標準偏差（criteria.json noiseFloor: 「S2で対象ごとに直接測り直す」）。
   * 軽量化のため再起動回数を落とす（頑健性そのものは fitGmm2 の本走行側で見る）。
   */
  function bootstrapValleySE(xs, opts) {
    opts = opts || {};
    var resamples = opts.resamples || 200;
    var restarts = opts.restarts || 5;
    var maxIter = opts.maxIter || 200;
    var rng = opts.rng || makeRng(2);
    var n = xs.length;
    var valleys = [];
    var abstained = 0;
    for (var b = 0; b < resamples; b++) {
      var sample = new Array(n);
      for (var i = 0; i < n; i++) sample[i] = xs[Math.floor(rng() * n)];
      var chosen = chooseComponents(sample, { restarts: restarts, maxIter: maxIter, rng: rng });
      if (chosen.abstain || chosen.valley === null || chosen.valley === undefined) { abstained++; continue; }
      valleys.push(chosen.valley);
    }
    if (valleys.length < 2) return { sd: NaN, n: valleys.length, abstained: abstained };
    var m = mean(valleys);
    var sd = std(valleys, m);
    return { sd: sd, n: valleys.length, abstained: abstained, mean: m };
  }

  // ------------------------------------------------------------- 合成データ（コントロール用）

  /** 正コントロール: 分離した2正規分布の混合。既知の交点を解析的に返す。 */
  function synthBimodal(opts, seed) {
    opts = opts || {};
    var n = opts.n || 500;
    var mu1 = opts.mu1 !== undefined ? opts.mu1 : 0;
    var mu2 = opts.mu2 !== undefined ? opts.mu2 : 5; // 5 標準偏差分離れる（sigma=1 の既定で）
    var sigma1 = opts.sigma1 !== undefined ? opts.sigma1 : 1;
    var sigma2 = opts.sigma2 !== undefined ? opts.sigma2 : 1;
    var p1 = opts.p1 !== undefined ? opts.p1 : 0.7; // 7:3
    var rng = makeRng(seed);
    var xs = new Array(n);
    for (var i = 0; i < n; i++) {
      if (rng() < p1) xs[i] = mu1 + sigma1 * sampleNormal(rng);
      else xs[i] = mu2 + sigma2 * sampleNormal(rng);
    }
    var known = analyticCrossing(mu1, sigma1, p1, mu2, sigma2, 1 - p1);
    return { xs: xs, knownCrossing: known, params: { mu1: mu1, sigma1: sigma1, p1: p1, mu2: mu2, sigma2: sigma2 } };
  }

  /** 負コントロール: 単一正規分布（真の二峰なし）。 */
  function synthUnimodal(opts, seed) {
    opts = opts || {};
    var n = opts.n || 500;
    var mu = opts.mu !== undefined ? opts.mu : 0;
    var sigma = opts.sigma !== undefined ? opts.sigma : 1;
    var rng = makeRng(seed);
    var xs = new Array(n);
    for (var i = 0; i < n; i++) xs[i] = mu + sigma * sampleNormal(rng);
    return { xs: xs };
  }

  /** 既知の2正規分布から交点を解析的に求める（合成コントロールの答え合わせ用）。 */
  function analyticCrossing(mu1, sigma1, w1, mu2, sigma2, w2) {
    return findValley({ mu1: mu1, mu2: mu2, sigma1: sigma1, sigma2: sigma2, w1: w1, w2: w2 });
  }

  return {
    makeRng: makeRng,
    sampleNormal: sampleNormal,
    mean: mean,
    variance: variance,
    std: std,
    skewness: skewness,
    excessKurtosis: excessKurtosis,
    bimodalityCoefficient: bimodalityCoefficient,
    histogram: histogram,
    otsuFast: otsuFast,
    otsuBrute: otsuBrute,
    otsuThreshold: otsuThreshold,
    normalPdf: normalPdf,
    normalLogPdf: normalLogPdf,
    fitGaussian1: fitGaussian1,
    emStep: emStep,
    emOnce: emOnce,
    fitGmm2: fitGmm2,
    bic: bic,
    findValley: findValley,
    chooseComponents: chooseComponents,
    relativeDistance: relativeDistance,
    classify: classify,
    firstCrossing: firstCrossing,
    bootstrapValleySE: bootstrapValleySE,
    synthBimodal: synthBimodal,
    synthUnimodal: synthUnimodal,
    analyticCrossing: analyticCrossing,
  };
});
