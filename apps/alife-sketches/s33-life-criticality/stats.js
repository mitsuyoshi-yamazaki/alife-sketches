/**
 * S-33 観測器 — 冪則かどうかを判定する道具一式。
 *
 * 処方は Clauset, Shalizi & Newman (2009) "Power-law distributions in empirical data",
 * SIAM Review 51(4):661-703, arXiv:0706.1062（ar5iv で本文へ到達した）に従う:
 *   ① 離散の最尤法で指数を推定 ② Kolmogorov–Smirnov 距離が最小になる x_min を選ぶ
 *   ③ 半母数ブートストラップで適合度の p 値を出す ④ 対立分布と尤度比検定で比べる
 *
 * ここは**観測器の側**なので、生物学・統計学の語彙を使ってよい（核 core.js との違い）。
 * 依存ゼロ・古典スクリプト。Node とブラウザで共用。
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- 特殊関数

  var CHEB = [-1.3026537197817094, 6.4196979235649026e-1, 1.9476473204185836e-2,
    -9.561514786808631e-3, -9.46595344482036e-4, 3.66839497852761e-4,
    4.2523324806907e-5, -2.0278578112534e-5, -1.624290004647e-6,
    1.303655835580e-6, 1.5626441722e-8, -8.5238095915e-8, 6.529054439e-9,
    5.059343495e-9, -9.91364156e-10, -2.27365122e-10, 9.6467911e-11,
    2.394038e-12, -6.886027e-12, 8.94487e-13, 3.13092e-13, -1.12708e-13,
    3.81e-16, 7.106e-15];

  /** 補誤差関数（Numerical Recipes の Chebyshev 近似）。 */
  function erfc(x) {
    var z = Math.abs(x), t = 2 / (2 + z), ty = 4 * t - 2;
    var d = 0, dd = 0, tmp, j;
    for (j = CHEB.length - 1; j > 0; j--) { tmp = d; d = ty * d - dd + CHEB[j]; dd = tmp; }
    var ans = t * Math.exp(-z * z + 0.5 * (CHEB[0] + ty * d) - dd);
    return x >= 0 ? ans : 2 - ans;
  }

  /** 標準正規の上側確率。 */
  function normQ(z) { return 0.5 * erfc(z / Math.SQRT2); }

  var LOGCACHE = {};
  function logsFor(q) {
    var k = '' + q, a = LOGCACHE[k];
    if (a) return a;
    a = new Float64Array(24);
    for (var i = 0; i < 24; i++) a[i] = Math.log(q + i);
    LOGCACHE[k] = a;
    return a;
  }

  /**
   * Hurwitz ゼータ ζ(s,q) = Σ_{k≥0} (q+k)^{-s}（s>1, q>0）。Euler–Maclaurin。
   * **実装の外から来る検査**: ζ(2,1)=π²/6, ζ(4,1)=π⁴/90（selftest の PC で使う）。
   */
  function hzeta(s, q) {
    var N = 24, sum = 0, i;
    var lg = logsFor(q);
    for (i = 0; i < N; i++) sum += Math.exp(-s * lg[i]);
    var a = q + N, la = Math.log(a);
    sum += Math.exp((1 - s) * la) / (s - 1);
    sum += 0.5 * Math.exp(-s * la);
    var p1 = Math.exp(-(s + 1) * la);
    sum += s * p1 / 12;
    sum -= s * (s + 1) * (s + 2) * Math.exp(-(s + 3) * la) / 720;
    sum += s * (s + 1) * (s + 2) * (s + 3) * (s + 4) * Math.exp(-(s + 5) * la) / 30240;
    sum -= s * (s + 1) * (s + 2) * (s + 3) * (s + 4) * (s + 5) * (s + 6) * Math.exp(-(s + 7) * la) / 1209600;
    return sum;
  }

  // ---------------------------------------------------------------- 離散冪則

  /** 対数尤度 ℒ(α) = −n ln ζ(α,x_min) − α Σ ln x_i。 */
  function plLogLik(alpha, xmin, n, sumLog) {
    return -n * Math.log(hzeta(alpha, xmin)) - alpha * sumLog;
  }

  /** 黄金分割で最尤の α を求める。 */
  function plFit(tail, xmin) {
    var n = tail.length, sumLog = 0, i;
    for (i = 0; i < n; i++) sumLog += Math.log(tail[i]);
    var lo = 1.0005, hi = 25, gr = (Math.sqrt(5) - 1) / 2;
    var b = hi - gr * (hi - lo), c = lo + gr * (hi - lo);
    var fb = plLogLik(b, xmin, n, sumLog), fc = plLogLik(c, xmin, n, sumLog);
    for (i = 0; i < 60; i++) {
      if (fb > fc) { hi = c; c = b; fc = fb; b = hi - gr * (hi - lo); fb = plLogLik(b, xmin, n, sumLog); }
      else { lo = b; b = c; fb = fc; c = lo + gr * (hi - lo); fc = plLogLik(c, xmin, n, sumLog); }
      if (hi - lo < 1e-7) break;
    }
    var alpha = (lo + hi) / 2;
    var ll = plLogLik(alpha, xmin, n, sumLog);
    // 標準誤差は対数尤度の二階差分から（ζ' ζ'' を書かずに済む）
    var h = 1e-3;
    var d2 = (plLogLik(alpha + h, xmin, n, sumLog) - 2 * ll + plLogLik(alpha - h, xmin, n, sumLog)) / (h * h);
    var se = d2 < 0 ? Math.sqrt(-1 / d2) : NaN;
    return { alpha: alpha, logLik: ll, n: n, xmin: xmin, se: se, sumLog: sumLog };
  }

  /** Clauset らの近似式 α ≈ 1 + n[Σ ln(x_i/(x_min−0.5))]^{-1}（x_min ≳ 6 で 1% 以内）。 */
  function plFitApprox(tail, xmin) {
    var n = tail.length, s = 0;
    for (var i = 0; i < n; i++) s += Math.log(tail[i] / (xmin - 0.5));
    return 1 + n / s;
  }

  /** 冪則の累積分布 P(x) = 1 − ζ(α,x+1)/ζ(α,x_min)。 */
  function plCdf(x, alpha, xmin, Z) { return 1 - hzeta(alpha, x + 1) / Z; }

  /**
   * KS 距離 D = max_{x≥x_min} |S(x) − P(x)|（Clauset らの定義。S も P も累積分布）。
   * ζ(α,v+1) は ζ(α,v) − v^{−α} で繰り上げられるので、裾の相異なる値ごとに
   * Euler–Maclaurin を呼び直さずに済む（近道。selftest で素朴版と突き合わせる）。
   */
  function ksDist(tail, alpha, xmin) {
    var n = tail.length, Z = hzeta(alpha, xmin), D = 0, i = 0;
    var cur = xmin, zcur = Z, drift = 0;
    while (i < n) {
      var v = tail[i], j = i;
      while (j < n && tail[j] === v) j++;
      var target = v + 1;
      if (target > cur) {
        if (target - cur <= 4096 && drift < 20000) {
          for (var k = cur; k < target; k++) zcur -= Math.pow(k, -alpha);
          drift += (target - cur);
        } else { zcur = hzeta(alpha, target); drift = 0; }
        cur = target;
      }
      var P = 1 - zcur / Z;
      var d = Math.abs(j / n - P);
      if (d > D) D = d;
      i = j;
    }
    return D;
  }

  /** 素朴な KS 距離（近道の検算用）。 */
  function ksDistNaive(tail, alpha, xmin) {
    var n = tail.length, Z = hzeta(alpha, xmin), D = 0, i = 0;
    while (i < n) {
      var v = tail[i], j = i;
      while (j < n && tail[j] === v) j++;
      var P = 1 - hzeta(alpha, v + 1) / Z;
      var d = Math.abs(j / n - P);
      if (d > D) D = d;
      i = j;
    }
    return D;
  }

  /**
   * x_min を KS 距離の最小化で選ぶ。候補は data の相異なる値（多すぎれば対数間隔で間引く）。
   * minTail 未満しか残らない候補は捨てる（**登録項目**）。
   */
  function chooseXmin(sorted, opts) {
    opts = opts || {};
    var minTail = opts.minTail || 50, maxCand = opts.maxCand || 30;
    var n = sorted.length, uniq = [], i;
    for (i = 0; i < n; i++) if (i === 0 || sorted[i] !== sorted[i - 1]) uniq.push(sorted[i]);
    // 残る裾が minTail 以上の候補だけ
    var cands = [];
    for (i = 0; i < uniq.length; i++) {
      var v = uniq[i];
      var lo = lowerBound(sorted, v);
      if (n - lo >= minTail) cands.push(v);
    }
    if (cands.length === 0) return null;
    if (cands.length > maxCand) {
      var pick = [], step = (cands.length - 1) / (maxCand - 1);
      for (i = 0; i < maxCand; i++) pick.push(cands[Math.round(i * step)]);
      cands = pick.filter(function (v, k, a) { return k === 0 || v !== a[k - 1]; });
    }
    var best = null;
    for (i = 0; i < cands.length; i++) {
      var xm = cands[i], lo2 = lowerBound(sorted, xm);
      var tail = sorted.slice(lo2);
      var f = plFit(tail, xm);
      var D = ksDist(tail, f.alpha, xm);
      if (!best || D < best.D) best = { xmin: xm, alpha: f.alpha, D: D, ntail: tail.length, logLik: f.logLik, se: f.se };
    }
    return best;
  }

  function lowerBound(sorted, v) {
    var lo = 0, hi = sorted.length;
    while (lo < hi) { var mid = (lo + hi) >> 1; if (sorted[mid] < v) lo = mid + 1; else hi = mid; }
    return lo;
  }

  // ---------------------------------------------------------------- 合成標本

  /** 離散冪則からの厳密な抽出（表 + 連続近似の裾）。正コントロールの源（K-18）。 */
  function plSampler(alpha, xmin, rand) {
    var M = 4000, cum = new Float64Array(M), Z = hzeta(alpha, xmin), acc = 0;
    for (var i = 0; i < M; i++) { acc += Math.pow(xmin + i, -alpha) / Z; cum[i] = acc; }
    var last = xmin + M - 1, tailP = 1 - acc;
    return function () {
      var u = rand();
      if (u < acc) {
        var lo = 0, hi = M - 1;
        while (lo < hi) { var mid = (lo + hi) >> 1; if (cum[mid] < u) lo = mid + 1; else hi = mid; }
        return xmin + lo;
      }
      // 裾は連続近似 x = (last+0.5)·v^{-1/(α−1)}
      var v = (1 - u) / (tailP > 0 ? tailP : 1e-12);
      if (v <= 0) v = 1e-12;
      var x = Math.round((last + 0.5) * Math.pow(v, -1 / (alpha - 1)));
      return x > last ? x : last + 1;
    };
  }

  function samplePL(alpha, xmin, n, rand) {
    var g = plSampler(alpha, xmin, rand), out = new Array(n);
    for (var i = 0; i < n; i++) out[i] = g();
    return out;
  }

  /**
   * 適合度の p 値（Clauset らの半母数ブートストラップ）。
   * 「x_min 以上は当てはめた冪則から、未満は観測値から復元抽出」で合成標本を作り、
   * それぞれに**同じ x_min 選択を含む当てはめ**を当て直して KS を比べる。
   */
  function gofP(sorted, fit, nsynth, rand, opts) {
    var n = sorted.length, below = [], i;
    for (i = 0; i < n; i++) { if (sorted[i] < fit.xmin) below.push(sorted[i]); else break; }
    var ntail = n - below.length, pTail = ntail / n;
    var gen = plSampler(fit.alpha, fit.xmin, rand);
    var worse = 0, used = 0;
    for (var s = 0; s < nsynth; s++) {
      var syn = new Array(n);
      for (i = 0; i < n; i++) {
        if (rand() < pTail) syn[i] = gen();
        else syn[i] = below.length ? below[(rand() * below.length) | 0] : fit.xmin;
      }
      syn.sort(function (a, b) { return a - b; });
      var f2 = chooseXmin(syn, opts);
      if (!f2) continue;
      used++;
      if (f2.D >= fit.D) worse++;
    }
    return { p: used ? worse / used : NaN, nsynth: used };
  }

  // ---------------------------------------------------------------- 対立分布

  /** 離散（幾何）指数分布 p(x) = (1−e^{−λ})e^{−λ(x−x_min)}。閉形式の最尤。 */
  function fitExp(tail, xmin) {
    var n = tail.length, s = 0, i;
    for (i = 0; i < n; i++) s += tail[i] - xmin;
    var m = s / n;
    if (m <= 0) return { lam: Infinity, logLik: 0, each: function () { return 0; } };
    var lam = Math.log(1 + 1 / m);
    var ll = n * Math.log(1 - Math.exp(-lam)) - lam * s;
    return {
      lam: lam, logLik: ll,
      each: function (x) { return Math.log(1 - Math.exp(-lam)) - lam * (x - xmin); }
    };
  }

  /**
   * 離散化した対数正規 p(x) ∝ (1/x)exp(−(ln x−μ)²/2σ²), x ≥ x_min。
   * 正規化は log-sum-exp で取る——冪則の極限（μ→−∞, σ→∞ で μ/σ² 固定）へ寄ると
   * 素朴な和は桁落ちで全滅する（本番前に実際に起きた: μ=−992 で R が −5591 になった）。
   */
  function lognormLogNorm(mu, sg, xmin) {
    var M = 800, lg = [], mx = -Infinity, x, l, v;
    for (x = xmin; x < xmin + M; x++) {
      l = Math.log(x);
      v = -l - (l - mu) * (l - mu) / (2 * sg * sg);
      lg.push(v);
      if (v > mx) mx = v;
    }
    var a = xmin + M - 0.5;
    var q = normQ((Math.log(a) - mu) / sg);
    var lt = q > 0 ? Math.log(sg) + 0.5 * Math.log(2 * Math.PI) + Math.log(q) : -Infinity;
    if (lt > mx) mx = lt;
    if (!isFinite(mx)) return -Infinity;
    var sum = 0;
    for (var i = 0; i < lg.length; i++) sum += Math.exp(lg[i] - mx);
    if (isFinite(lt)) sum += Math.exp(lt - mx);
    return mx + Math.log(sum);
  }

  function fitLognorm(tail, xmin) {
    var n = tail.length, i, lx = new Float64Array(n), m = 0;
    for (i = 0; i < n; i++) { lx[i] = Math.log(tail[i]); m += lx[i]; }
    m /= n;
    var v = 0;
    for (i = 0; i < n; i++) v += (lx[i] - m) * (lx[i] - m);
    v = Math.sqrt(v / n) || 0.5;
    var f = function (par) {
      var mu = par[0], sg = Math.abs(par[1]);
      if (!(sg > 0.03) || sg > 15 || !isFinite(mu) || mu < -60 || mu > 60) return 1e18;
      var lc = lognormLogNorm(mu, sg, xmin);
      if (!isFinite(lc)) return 1e18;
      var ll = 0;
      for (var k = 0; k < n; k++) ll += -lx[k] - (lx[k] - mu) * (lx[k] - mu) / (2 * sg * sg);
      return -(ll - n * lc);
    };
    var best = nelderMead(f, [m, v], 0.5, 260);
    // 冪則の極限（μ が下へ逃げる）からも一度当て直す
    var alt = nelderMead(f, [-12, 3], 0.8, 260);
    if (alt.fx < best.fx) best = alt;
    var mu = best.x[0], sg = Math.abs(best.x[1]);
    var lc = lognormLogNorm(mu, sg, xmin);
    return {
      mu: mu, sigma: sg, logLik: -best.fx,
      each: function (x) {
        var l = Math.log(x);
        return -l - (l - mu) * (l - mu) / (2 * sg * sg) - lc;
      }
    };
  }

  /**
   * 切断冪則 p(x) ∝ x^{−α}e^{−λx}（λ=0 で冪則に一致する入れ子）。正規化は log-sum-exp。
   *
   * **裾は ζ(α,X+1)·e^{−λ(X+1)} で閉じる。** λ=0 のとき
   * Σ_{x≥x_min} x^{−α} = Σ_{x=x_min}^{X} x^{−α} + ζ(α,X+1) は恒等式なので、
   * この形だと**入れ子の一致が厳密に成り立つ**。
   * 素朴に打ち切ると規格化が小さく出て、真の冪則に対して LR が 14 まで膨らんだ
   * （α=1.8・x_min=6 で log の差 7.9e-4 × n=9000 = 7.1）——本番前に PC-B が捕まえた。
   */
  function truncLogNorm(alpha, lam, xmin) {
    var HARD = 20000;
    var mx = -Infinity, lg = [], x, v, last = xmin, ended = false;
    for (x = xmin; x < xmin + HARD; x++) {
      v = -alpha * Math.log(x) - lam * x;
      lg.push(v);
      if (v > mx) mx = v;
      last = x;
      if (x > xmin + 80 && v < mx - 60) { ended = true; break; }
    }
    if (!isFinite(mx)) return -Infinity;
    var sum = 0;
    for (var i = 0; i < lg.length; i++) sum += Math.exp(lg[i] - mx);
    if (!ended) {
      var z = hzeta(alpha > 1.0005 ? alpha : 1.0005, last + 1);
      var lt = Math.log(z) - lam * (last + 1);
      sum += Math.exp(lt - mx);
    }
    return mx + Math.log(sum);
  }

  function fitTrunc(tail, xmin, alpha0) {
    var n = tail.length, sumLog = 0, sumX = 0, i;
    for (i = 0; i < n; i++) { sumLog += Math.log(tail[i]); sumX += tail[i]; }
    var f = function (par) {
      var a = par[0], lam = Math.abs(par[1]);
      if (!(a > -3) || a > 30 || !isFinite(lam) || lam > 5) return 1e18;
      var lc = truncLogNorm(a, lam, xmin);
      if (!isFinite(lc)) return 1e18;
      return -(-a * sumLog - lam * sumX - n * lc);
    };
    var best = nelderMead(f, [alpha0, 1e-4], 0.3, 220);
    var a = best.x[0], lam = Math.abs(best.x[1]);
    var lc = truncLogNorm(a, lam, xmin);
    return {
      alpha: a, lam: lam, logLik: -best.fx,
      each: function (x) { return -a * Math.log(x) - lam * x - lc; }
    };
  }

  /** Nelder–Mead（2次元）。 */
  function nelderMead(f, x0, step, iters) {
    var d = x0.length, simplex = [], i, j;
    simplex.push({ x: x0.slice(), fx: f(x0) });
    for (i = 0; i < d; i++) {
      var p = x0.slice(); p[i] += step;
      simplex.push({ x: p, fx: f(p) });
    }
    for (var it = 0; it < iters; it++) {
      simplex.sort(function (a, b) { return a.fx - b.fx; });
      var best = simplex[0], worst = simplex[d];
      var cen = new Array(d);
      for (j = 0; j < d; j++) { cen[j] = 0; for (i = 0; i < d; i++) cen[j] += simplex[i].x[j]; cen[j] /= d; }
      var ref = new Array(d);
      for (j = 0; j < d; j++) ref[j] = cen[j] + (cen[j] - worst.x[j]);
      var fr = f(ref);
      if (fr < best.fx) {
        var exp2 = new Array(d);
        for (j = 0; j < d; j++) exp2[j] = cen[j] + 2 * (cen[j] - worst.x[j]);
        var fe = f(exp2);
        simplex[d] = fe < fr ? { x: exp2, fx: fe } : { x: ref, fx: fr };
      } else if (fr < simplex[d - 1].fx) {
        simplex[d] = { x: ref, fx: fr };
      } else {
        var con = new Array(d);
        for (j = 0; j < d; j++) con[j] = cen[j] + 0.5 * (worst.x[j] - cen[j]);
        var fc = f(con);
        if (fc < worst.fx) simplex[d] = { x: con, fx: fc };
        else {
          for (i = 1; i <= d; i++) {
            for (j = 0; j < d; j++) simplex[i].x[j] = best.x[j] + 0.5 * (simplex[i].x[j] - best.x[j]);
            simplex[i].fx = f(simplex[i].x);
          }
        }
      }
    }
    simplex.sort(function (a, b) { return a.fx - b.fx; });
    return simplex[0];
  }

  /** Vuong の尤度比検定（入れ子でない対立）。R>0 なら冪則側。 */
  function vuong(l1, l2) {
    var n = l1.length, R = 0, i;
    for (i = 0; i < n; i++) R += l1[i] - l2[i];
    var mean = R / n, v = 0;
    for (i = 0; i < n; i++) { var d = l1[i] - l2[i] - mean; v += d * d; }
    var sigma = Math.sqrt(v / n);
    if (!(sigma > 0)) return { R: R, sigma: 0, z: 0, p: 1 };
    var z = R / (Math.sqrt(n) * sigma);
    return { R: R, sigma: sigma, z: z, p: erfc(Math.abs(z) / Math.SQRT2) };
  }

  /**
   * 入れ子（冪則 ⊂ 切断冪則）の検定。λ=0 は母数空間の境界なので、
   * 漸近分布は ½δ₀ + ½χ²₁ になる。p = ½·erfc(√(LR/2))。
   */
  function nestedP(LR) {
    if (!(LR > 0)) return 1;
    return 0.5 * erfc(Math.sqrt(LR / 2));
  }

  // ---------------------------------------------------------------- 別の当てはめ法

  /** 対数ビンの最小二乗。mult はビン幅の倍率（**登録項目**）。 */
  function logBinFit(tail, xmin, mult) {
    var edges = [], e = xmin, max = tail[tail.length - 1];
    while (e <= max * mult) { edges.push(e); e *= mult; }
    if (edges.length < 3) return { alpha: NaN, nbins: 0 };
    var counts = new Array(edges.length - 1).fill(0), i, j = 0;
    for (i = 0; i < tail.length; i++) {
      var v = tail[i];
      while (j + 1 < edges.length - 1 && v >= edges[j + 1]) j++;
      // 単調なので直接探す
      var k = Math.floor(Math.log(v / xmin) / Math.log(mult));
      if (k >= 0 && k < counts.length) counts[k]++;
    }
    var xs = [], ys = [];
    for (i = 0; i < counts.length; i++) {
      if (counts[i] === 0) continue;               // 空のビンは落とす（登録項目）
      var w = edges[i + 1] - edges[i];
      var cen = Math.sqrt(edges[i] * edges[i + 1]);
      xs.push(Math.log(cen));
      ys.push(Math.log(counts[i] / (w * tail.length)));
    }
    if (xs.length < 3) return { alpha: NaN, nbins: xs.length };
    var fitls = ols(xs, ys);
    return { alpha: -fitls.slope, nbins: xs.length, r2: fitls.r2 };
  }

  /** 累積分布の最小二乗（CCDF を両対数で直線に当てる）。 */
  function ccdfFit(tail, xmin) {
    var n = tail.length, xs = [], ys = [], i = 0;
    while (i < n) {
      var v = tail[i], j = i;
      while (j < n && tail[j] === v) j++;
      var cc = (n - i) / n;
      if (cc > 0 && v > 0) { xs.push(Math.log(v)); ys.push(Math.log(cc)); }
      i = j;
    }
    if (xs.length < 3) return { alpha: NaN, npts: xs.length };
    var f = ols(xs, ys);
    return { alpha: 1 - f.slope, npts: xs.length, r2: f.r2 };
  }

  function ols(xs, ys) {
    var n = xs.length, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, i;
    for (i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; syy += ys[i] * ys[i]; }
    var den = n * sxx - sx * sx;
    var slope = den === 0 ? NaN : (n * sxy - sx * sy) / den;
    var inter = (sy - slope * sx) / n;
    var ssTot = syy - sy * sy / n, ssRes = 0;
    for (i = 0; i < n; i++) { var r = ys[i] - (inter + slope * xs[i]); ssRes += r * r; }
    return { slope: slope, intercept: inter, r2: ssTot > 0 ? 1 - ssRes / ssTot : NaN };
  }

  // ---------------------------------------------------------------- 一式

  /**
   * 事前登録した判定の一式。
   * mode: 'ks'（KS 最小の x_min）または数値（x_min を固定）。
   * method: 'mle' | 'logbin' | 'ccdf'。
   */
  function analyse(values, cfg, rand) {
    cfg = cfg || {};
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var opts = { minTail: cfg.minTail || 50, maxCand: cfg.maxCand || 30 };
    var fit;
    if (cfg.xminMode === 'ks' || cfg.xminMode === undefined) {
      fit = chooseXmin(sorted, opts);
      if (!fit) return { verdict: 'no-xmin', n: sorted.length };
    } else {
      var xm = cfg.xminMode;
      var lo = lowerBound(sorted, xm);
      var tail0 = sorted.slice(lo);
      if (tail0.length < opts.minTail) return { verdict: 'insufficient-tail', n: sorted.length, ntail: tail0.length, xmin: xm };
      var f0 = plFit(tail0, xm);
      fit = { xmin: xm, alpha: f0.alpha, D: ksDist(tail0, f0.alpha, xm), ntail: tail0.length, logLik: f0.logLik, se: f0.se };
    }
    var lo2 = lowerBound(sorted, fit.xmin);
    var tail = sorted.slice(lo2);

    var alphaByMethod = { mle: fit.alpha };
    if (cfg.wantMethods !== false) {
      alphaByMethod.logbin12 = logBinFit(tail, fit.xmin, 1.2).alpha;
      alphaByMethod.logbin15 = logBinFit(tail, fit.xmin, 1.5).alpha;
      alphaByMethod.logbin20 = logBinFit(tail, fit.xmin, 2.0).alpha;
      alphaByMethod.ccdf = ccdfFit(tail, fit.xmin).alpha;
      alphaByMethod.approx = plFitApprox(tail, fit.xmin);
    }
    var out = {
      n: sorted.length, xmin: fit.xmin, alpha: fit.alpha, se: fit.se,
      D: fit.D, ntail: fit.ntail, alphaByMethod: alphaByMethod,
      max: sorted[sorted.length - 1], median: sorted[(sorted.length / 2) | 0]
    };
    if (cfg.full === false) { out.verdict = 'alpha-only'; return out; }

    // 適合度
    var g = gofP(sorted, fit, cfg.nsynth || 200, rand, opts);
    out.pGof = g.p; out.nsynth = g.nsynth;

    // 対立分布
    var Z = hzeta(fit.alpha, fit.xmin), lnZ = Math.log(Z);
    var lpl = tail.map(function (x) { return -fit.alpha * Math.log(x) - lnZ; });
    var fe = fitExp(tail, fit.xmin);
    var fl = fitLognorm(tail, fit.xmin);
    var ft = fitTrunc(tail, fit.xmin, fit.alpha);
    var vExp = vuong(lpl, tail.map(fe.each));
    var vLog = vuong(lpl, tail.map(fl.each));
    var LRt = 2 * (ft.logLik - fit.logLik);
    out.alt = {
      exp: { R: vExp.R, p: vExp.p, lam: fe.lam },
      lognorm: { R: vLog.R, p: vLog.p, mu: fl.mu, sigma: fl.sigma },
      trunc: { LR: LRt, p: nestedP(LRt), alpha: ft.alpha, lam: ft.lam }
    };

    // **事前登録した判定規則**
    var pGofCut = cfg.pGof !== undefined ? cfg.pGof : 0.10;
    var pLrCut = cfg.pLr !== undefined ? cfg.pLr : 0.10;
    var pLrNested = cfg.pLrNested !== undefined ? cfg.pLrNested : 0.05;
    var nTailMin = cfg.nTailMin !== undefined ? cfg.nTailMin : 1000;
    if (fit.ntail < nTailMin) out.verdict = 'insufficient-tail';
    else if (!(out.pGof >= pGofCut)) out.verdict = 'rejected-gof';
    else if (vExp.p < pLrCut && vExp.R < 0) out.verdict = 'beaten-exp';
    else if (vLog.p < pLrCut && vLog.R < 0) out.verdict = 'beaten-lognorm';
    else if (out.alt.trunc.p < pLrNested) out.verdict = 'beaten-trunc';
    else out.verdict = 'powerlaw';
    return out;
  }

  var api = {
    erfc: erfc, normQ: normQ, hzeta: hzeta,
    plLogLik: plLogLik, plFit: plFit, plFitApprox: plFitApprox, plCdf: plCdf,
    ksDist: ksDist, ksDistNaive: ksDistNaive, chooseXmin: chooseXmin, lowerBound: lowerBound,
    plSampler: plSampler, samplePL: samplePL, gofP: gofP,
    fitExp: fitExp, fitLognorm: fitLognorm, fitTrunc: fitTrunc,
    lognormLogNorm: lognormLogNorm, truncLogNorm: truncLogNorm,
    nelderMead: nelderMead, vuong: vuong, nestedP: nestedP,
    logBinFit: logBinFit, ccdfFit: ccdfFit, ols: ols, analyse: analyse
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.S33stats = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
