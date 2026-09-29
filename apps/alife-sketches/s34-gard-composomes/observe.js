/**
 * S-34 の観測器。**生物学・遺伝の語彙はこちら側にだけ置く**（核は持たない）。
 *
 * ここが決めること（＝ criteria.json に事前登録した項目）:
 *   - 組成の「似ている」を何で測るか（euclid / cosine / kl）
 *   - 「遺伝している」を、伝達（kinship）・安定（homeostasis）・記憶（memoryRatio）・
 *     蓄積（selectionGain）のどれで言うか
 *   - 分裂の標本雑音に対する参照（解析値）
 */
(function (global) {
  'use strict';

  var S34 = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('./core.js') : global.S34;

  /** 個数ベクトル -> 割合。 */
  function share(counts) {
    var k = counts.length, out = new Float64Array(k), N = 0, i;
    for (i = 0; i < k; i++) N += counts[i];
    if (N <= 0) return out;
    for (i = 0; i < k; i++) out[i] = counts[i] / N;
    return out;
  }

  function sqDist(f, g) {
    var s = 0;
    for (var i = 0; i < f.length; i++) { var d = f[i] - g[i]; s += d * d; }
    return s;
  }

  /** 単体上の最大距離は √2。H=1 で同一、H=0 で最も遠い。 */
  function simEuclid(f, g) { return 1 - Math.sqrt(sqDist(f, g) / 2); }

  function simCosine(f, g) {
    var a = 0, b = 0, c = 0;
    for (var i = 0; i < f.length; i++) { a += f[i] * g[i]; b += f[i] * f[i]; c += g[i] * g[i]; }
    if (b <= 0 || c <= 0) return 0;
    return a / Math.sqrt(b * c);
  }

  var EPS = 1e-9;
  function simKL(f, g) {
    var k = f.length, d = 0, i, sf = 0, sg = 0, ff = new Float64Array(k), gg = new Float64Array(k);
    for (i = 0; i < k; i++) { ff[i] = f[i] + EPS; gg[i] = g[i] + EPS; sf += ff[i]; sg += gg[i]; }
    for (i = 0; i < k; i++) { ff[i] /= sf; gg[i] /= sg; }
    for (i = 0; i < k; i++) d += ff[i] * Math.log(ff[i] / gg[i]) + gg[i] * Math.log(gg[i] / ff[i]);
    return Math.exp(-d / 2);
  }

  var SIMS = { euclid: simEuclid, cosine: simCosine, kl: simKL };
  function similarity(kind, f, g) { return (SIMS[kind] || simEuclid)(f, g); }

  /**
   * 分裂の標本雑音の解析値（多変量超幾何）。
   *   E[ sum_i (m_i/M - f_i)^2 ] = (1 - sum f_i^2) * (N - M) / (M * (N - 1))
   * 実装の外から来る恒等式（K-18）。積と数え上げで結ばれているので K-28 の限定にも耐える。
   */
  function samplingNullSq(f, N, M) {
    var s = 0;
    for (var i = 0; i < f.length; i++) s += f[i] * f[i];
    if (M <= 0 || N <= 1) return NaN;
    return (1 - s) * (N - M) / (M * (N - 1));
  }

  /** 単体の接空間の一様な向き（総和 0・ノルム 1）。 */
  function randomDirection(kinds, rng) {
    var v = new Float64Array(kinds), m = 0, i;
    for (i = 0; i < kinds; i++) v[i] = S34.normal(rng);
    for (i = 0; i < kinds; i++) m += v[i];
    m /= kinds;
    var nn = 0;
    for (i = 0; i < kinds; i++) { v[i] -= m; nn += v[i] * v[i]; }
    nn = Math.sqrt(nn) || 1;
    for (i = 0; i < kinds; i++) v[i] /= nn;
    return v;
  }

  /** f に delta*dir を足して単体へ戻す（負を 0 で止めて正規化）。 */
  function perturbShare(f, dir, delta) {
    var k = f.length, out = new Float64Array(k), s = 0, i;
    for (i = 0; i < k; i++) { out[i] = Math.max(0, f[i] + delta * dir[i]); s += out[i]; }
    if (s <= 0) return Float64Array.from(f);
    for (i = 0; i < k; i++) out[i] /= s;
    return out;
  }

  /**
   * 記憶の比。生まれた直後の組成 f0 に delta の摂動を入れ、
   * 決定論版で「splitAt まで育てて半分にする」を 1 回通したあと、
   * 残っているずれ ÷ 入れたずれ を返す。
   * 帰無（相互の上乗せが無い系）の解析値は 2^(-A/(A-outflow))。完全な伝達なら 1。
   */
  function memoryRatio(P, f0, dir, delta, dt) {
    var k = P.kinds, work = S34.makeWork(k);
    var N0 = P.splitAt / 2;
    var f1 = perturbShare(f0, dir, delta);
    var d0 = Math.sqrt(sqDist(f0, f1));
    if (!(d0 > 0)) return NaN;
    var a = new Float64Array(k), b = new Float64Array(k);
    for (var i = 0; i < k; i++) { a[i] = f0[i] * N0; b[i] = f1[i] * N0; }
    var ra = S34.growHalveDeterministic(P, a, dt, work);
    var rb = S34.growHalveDeterministic(P, b, dt, work);
    var d1 = Math.sqrt(sqDist(share(ra.n), share(rb.n)));
    return d1 / d0;
  }

  /** 決定論版の写像を s 回まわす（組成の行き先を見る）。 */
  function iterateMap(P, f0, steps, dt) {
    var k = P.kinds, work = S34.makeWork(k), n = new Float64Array(k), i;
    for (i = 0; i < k; i++) n[i] = f0[i] * (P.splitAt / 2);
    var path = [share(n)];
    for (var s = 0; s < steps; s++) {
      var r = S34.growHalveDeterministic(P, n, dt, work);
      n = r.n;
      path.push(share(n));
    }
    return path;
  }

  /** 単連結法（最近傍）で組成を塊に分ける。閾値は「1 - 類似度」で測る。 */
  function clusterCount(shares, thr, kind) {
    var n = shares.length, parent = [], i, j;
    for (i = 0; i < n; i++) parent.push(i);
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    for (i = 0; i < n; i++) {
      for (j = i + 1; j < n; j++) {
        if (1 - similarity(kind, shares[i], shares[j]) <= thr) {
          var a = find(i), b = find(j);
          if (a !== b) parent[a] = b;
        }
      }
    }
    var seen = {};
    for (i = 0; i < n; i++) seen[find(i)] = 1;
    return Object.keys(seen).length;
  }

  function median(xs) {
    var v = xs.filter(function (x) { return typeof x === 'number' && isFinite(x); }).slice().sort(function (a, b) { return a - b; });
    if (!v.length) return NaN;
    var m = v.length >> 1;
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }
  function mean(xs) {
    var v = xs.filter(function (x) { return typeof x === 'number' && isFinite(x); });
    if (!v.length) return NaN;
    var s = 0;
    for (var i = 0; i < v.length; i++) s += v[i];
    return s / v.length;
  }
  function quantile(xs, q) {
    var v = xs.filter(function (x) { return typeof x === 'number' && isFinite(x); }).slice().sort(function (a, b) { return a - b; });
    if (!v.length) return NaN;
    var p = (v.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
    return v[lo] + (v[hi] - v[lo]) * (p - lo);
  }

  var API = {
    share: share, sqDist: sqDist,
    simEuclid: simEuclid, simCosine: simCosine, simKL: simKL, similarity: similarity, SIM_KINDS: ['euclid', 'cosine', 'kl'],
    samplingNullSq: samplingNullSq,
    randomDirection: randomDirection, perturbShare: perturbShare,
    memoryRatio: memoryRatio, iterateMap: iterateMap,
    clusterCount: clusterCount,
    median: median, mean: mean, quantile: quantile,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.S34O = API;
})(typeof window !== 'undefined' ? window : globalThis);
