/**
 * S-21 の核。長さ L の 0/1 の語の集まり（pool）と、その複写の規則だけを書く。
 *
 * このファイルが知っているのは次だけである:
 *
 *   語は L 桁の 0/1 で、32bit の語 W = ceil(L/32) 個に詰める。原点 = 全て 0 の語。
 *   語の「類」d は原点（または基準語 anchor）からの Hamming 距離 ∈ {0..L}。
 *   類ごとに重み w[d] がある。次の pool は、重みに比例して親を N 回引き、
 *   複写のとき各桁を独立に確率 mu で反転して作る（非重複世代・N 一定）。
 *
 *   同じ規則の無限個体群版は、類の頻度 x_d の写像
 *       x'_k = Σ_j P(j→k) w[j] x_j / Σ_j w[j] x_j
 *   で、P(j→k) は類 j の語の複写が類 k に落ちる確率（解析式）。
 *   重みが類だけで決まるので、この (L+1) 状態への縮約は 2^L 状態の写像と厳密に一致する。
 *
 * **w[0] はこのファイルの中では単なる一つの数**である。それが「峰」であり、原点が「主配列」で、
 * 反転が「変異」で、w が「適応度」だと語る語彙はここには無い。それは stats.js の仕事である。
 *
 * 依存ゼロ。Node（生ログ生成）とブラウザ（可視化）が同じファイルを読む。
 *
 * 出典（アイデアのみ。コードは参照していない）:
 *   Eigen, M. (1971) Naturwissenschaften 58, 465 — 単峯地形と誤り閾値（原典には到達していない）
 *   Cerf, R. & Dalmau, J. (2023) arXiv:2306.09221 — 離散時間の写像 x_{n+1}(u) = Σ_v x_n(v) f(v) M(v,u) / Σ_v x_n(v) f(v)
 *   Alves, D. & Fontanari, J.F. (1997) arXiv:cond-mat/9709247 — 有限個体群での閾値
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S21 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 乱数・ビット操作
   * ------------------------------------------------------------------ */

  function mix32(x) {
    x = (x ^ (x >>> 16)) >>> 0; x = Math.imul(x, 0x7feb352d) >>> 0;
    x = (x ^ (x >>> 15)) >>> 0; x = Math.imul(x, 0x846ca68b) >>> 0;
    return (x ^ (x >>> 16)) >>> 0;
  }

  /**
   * 決定論的な擬似乱数（sfc32・周期 ≈ 2^128）。seed と stream の組で完全に再現する。
   * 返す関数は [0,1) の実数を返す。
   */
  function makeRng(seed, stream) {
    var s = (seed >>> 0), t = ((stream || 0) >>> 0);
    var a = mix32(s + 0x9e3779b9), b = mix32(a ^ t), c = mix32(b + 0x85ebca6b), d = mix32(c ^ (t + 0xc2b2ae35));
    var fn = function () {
      a |= 0; b |= 0; c |= 0; d |= 0;
      var r = (a + b | 0) + d | 0;
      d = d + 1 | 0;
      a = b ^ (b >>> 9);
      b = c + (c << 3) | 0;
      c = (c << 21) | (c >>> 11);
      c = c + r | 0;
      return (r >>> 0) / 4294967296;
    };
    for (var i = 0; i < 12; i++) fn();
    return fn;
  }

  /** 32bit の語の立っているビットの数。 */
  function popcount32(v) {
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    return Math.imul((v + (v >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
  }

  /** 素朴版（近道の検算用）。 */
  function popcount32Naive(v) {
    var n = 0;
    for (var i = 0; i < 32; i++) if ((v >>> i) & 1) n++;
    return n;
  }

  function wordsPer(L) { return Math.ceil(L / 32); }

  /* ------------------------------------------------------------------ *
   * 重み表
   * ------------------------------------------------------------------ */

  /** 類 0 だけ sigma、他は 1。 */
  function weightsOnePeak(L, sigma) {
    var w = new Float64Array(L + 1);
    for (var d = 0; d <= L; d++) w[d] = 1;
    w[0] = sigma;
    return w;
  }

  /** 類 0 が sigmaA、類 d > L/2 が sigmaB、他は 1。 */
  function weightsPeakAndPlain(L, sigmaA, sigmaB) {
    var w = new Float64Array(L + 1);
    for (var d = 0; d <= L; d++) w[d] = (2 * d > L) ? sigmaB : 1;
    w[0] = sigmaA;
    return w;
  }

  /** 全て 1。 */
  function weightsFlat(L) {
    var w = new Float64Array(L + 1);
    for (var d = 0; d <= L; d++) w[d] = 1;
    return w;
  }

  /* ------------------------------------------------------------------ *
   * pool（有限個体群）
   * ------------------------------------------------------------------ */

  var DEFAULTS = {
    L: 20,            // 桁数
    N: 1000,          // 語の数（一定）
    mu: 0.05,         // 1桁あたりの反転確率（0 以上 1 未満）
    weights: null,    // 類ごとの重み Float64Array(L+1)。null なら weightsOnePeak(L, 10)
    init: 'origin',   // 'origin' | 'poles'（N/2 を原点・N/2 を全 1 に）| 'uniform'（一様乱択）
    anchor: 'fixed',  // 'fixed'（重みの類は原点からの距離）| 'redraw'（毎世代ランダムな基準語からの距離）
    seed: 1,
    stream: 0,
  };

  function createPool(opts) {
    var o = {};
    for (var k in DEFAULTS) o[k] = DEFAULTS[k];
    if (opts) for (var k2 in opts) if (opts[k2] !== undefined) o[k2] = opts[k2];
    if (!(o.mu >= 0 && o.mu < 1)) throw new Error('mu は 0 以上 1 未満');
    if (o.L < 1 || o.L > 96) throw new Error('L は 1..96');
    var L = o.L, N = o.N, W = wordsPer(L);
    var P = {
      L: L, N: N, W: W, mu: o.mu,
      weights: o.weights || weightsOnePeak(L, 10),
      anchorMode: o.anchor,
      seed: o.seed, stream: o.stream,
      rng: makeRng(o.seed, o.stream),
      gen: 0,
      words: new Uint32Array(N * W),
      next: new Uint32Array(N * W),
      dist: new Uint8Array(N),      // 原点からの距離（観測用）
      cls: new Uint8Array(N),       // 基準語からの距離（重み用。anchor が fixed なら dist と同じ）
      anchor: new Uint32Array(W),   // 基準語（fixed なら全て 0）
      mask: (L % 32 === 0) ? 0xffffffff : ((1 << (L % 32)) - 1) >>> 0,
      invLog: o.mu > 0 ? 1 / Math.log(1 - o.mu) : 0,
      // 作業領域
      order: new Int32Array(N), start: new Int32Array(L + 2), cum: new Float64Array(L + 1),
      count: new Int32Array(L + 1),
    };
    if (P.weights.length !== L + 1) throw new Error('weights の長さは L+1');
    if (o.init === 'poles') {
      for (var i = N >> 1; i < N; i++) setAllOnes(P, i);
    } else if (o.init === 'uniform') {
      for (var i2 = 0; i2 < N; i2++) {
        for (var j = 0; j < W; j++) P.words[i2 * W + j] = (Math.floor(P.rng() * 4294967296) >>> 0);
        P.words[i2 * W + W - 1] &= P.mask;
      }
    }
    recount(P);
    return P;
  }

  function setAllOnes(P, i) {
    for (var j = 0; j < P.W; j++) P.words[i * P.W + j] = 0xffffffff;
    P.words[i * P.W + P.W - 1] &= P.mask;
  }

  /** 語 i の原点からの距離を数え直す。 */
  function distOf(P, words, i) {
    var d = 0, o = i * P.W;
    for (var j = 0; j < P.W; j++) d += popcount32(words[o + j]);
    return d;
  }

  /** 語 i の基準語からの距離。 */
  function clsOf(P, words, i) {
    var d = 0, o = i * P.W;
    for (var j = 0; j < P.W; j++) d += popcount32((words[o + j] ^ P.anchor[j]) >>> 0);
    return d;
  }

  /** dist・cls・類の個数を全部数え直す（初期化と検算に使う）。 */
  function recount(P) {
    for (var d = 0; d <= P.L; d++) P.count[d] = 0;
    for (var i = 0; i < P.N; i++) {
      P.dist[i] = distOf(P, P.words, i);
      P.cls[i] = (P.anchorMode === 'fixed') ? P.dist[i] : clsOf(P, P.words, i);
      P.count[P.dist[i]]++;
    }
    return P;
  }

  /** 幾何スキップで、語 q（next 側）の各桁を確率 mu で反転する。 */
  function flipGeometric(P, words, q) {
    if (P.mu <= 0) return;
    var L = P.L, o = q * P.W, rng = P.rng, invLog = P.invLog;
    var pos = Math.floor(Math.log(1 - rng()) * invLog);
    while (pos < L) {
      words[o + (pos >>> 5)] ^= (1 << (pos & 31));
      pos += 1 + Math.floor(Math.log(1 - rng()) * invLog);
    }
  }

  /** 素朴版: 桁を1つずつ見て確率 mu で反転する（近道の検算用）。 */
  function flipNaive(P, words, q) {
    var o = q * P.W;
    for (var pos = 0; pos < P.L; pos++) {
      if (P.rng() < P.mu) words[o + (pos >>> 5)] ^= (1 << (pos & 31));
    }
  }

  /**
   * 1世代。重みに比例して親を N 回引き、複写して反転する。
   * 親の選び方: 類ごとに語を束ね（計数ソート）、類を「個数×重み」の累積で二分探索して選び、類の中は一様。
   */
  function stepPool(P) {
    var N = P.N, L = P.L, W = P.W, rng = P.rng, w = P.weights;
    var words = P.words, next = P.next, cls = P.cls, dist = P.dist;
    if (P.anchorMode === 'redraw') {
      for (var j = 0; j < W; j++) P.anchor[j] = (Math.floor(rng() * 4294967296) >>> 0);
      P.anchor[W - 1] &= P.mask;
      for (var i0 = 0; i0 < N; i0++) cls[i0] = clsOf(P, words, i0);
    }
    // 計数ソート: 類 c の語は order[start[c] .. start[c+1])
    var start = P.start, order = P.order, cum = P.cum;
    for (var c = 0; c <= L + 1; c++) start[c] = 0;
    for (var i = 0; i < N; i++) start[cls[i] + 1]++;
    for (var c2 = 0; c2 <= L; c2++) start[c2 + 1] += start[c2];
    var fill = new Int32Array(L + 1);
    for (var i2 = 0; i2 < N; i2++) { var cc = cls[i2]; order[start[cc] + fill[cc]] = i2; fill[cc]++; }
    var total = 0;
    for (var c3 = 0; c3 <= L; c3++) { total += (start[c3 + 1] - start[c3]) * w[c3]; cum[c3] = total; }
    if (!(total > 0)) throw new Error('重みの合計が 0');
    var ndist = new Uint8Array(N), ncls = new Uint8Array(N);
    var fixed = P.anchorMode === 'fixed';
    for (var k = 0; k < N; k++) {
      // 類を二分探索
      var u = rng() * total, lo = 0, hi = L;
      while (lo < hi) { var mid = (lo + hi) >> 1; if (cum[mid] > u) hi = mid; else lo = mid + 1; }
      var b0 = start[lo], b1 = start[lo + 1];
      var src = order[b0 + ((rng() * (b1 - b0)) | 0)];
      var o = src * W, q = k * W;
      for (var j2 = 0; j2 < W; j2++) next[q + j2] = words[o + j2];
      flipGeometric(P, next, k);
      var d = 0;
      for (var j3 = 0; j3 < W; j3++) d += popcount32(next[q + j3]);
      ndist[k] = d;
      ncls[k] = fixed ? d : 0;
    }
    P.words = next; P.next = words; P.dist = ndist; P.cls = fixed ? ndist : ncls;
    // 類の個数（原点からの距離）
    var count = P.count;
    for (var c4 = 0; c4 <= L; c4++) count[c4] = 0;
    for (var i3 = 0; i3 < N; i3++) count[ndist[i3]]++;
    P.gen++;
    return P;
  }

  /** 桁ごとの 1 の個数（長さ L）。O(N·L)。 */
  function siteCounts(P) {
    var L = P.L, W = P.W, N = P.N, out = new Int32Array(L), words = P.words;
    for (var i = 0; i < N; i++) {
      var o = i * W;
      for (var j = 0; j < W; j++) {
        var v = words[o + j];
        if (!v) continue;
        var base = j * 32, lim = Math.min(32, L - base);
        for (var b = 0; b < lim; b++) if ((v >>> b) & 1) out[base + b]++;
      }
    }
    return out;
  }

  /** pool の状態ハッシュ（FNV-1a 32bit を語の並びと距離に当てる）。 */
  function hashPool(P) {
    var h = 2166136261;
    var words = P.words, n = P.N * P.W;
    for (var i = 0; i < n; i++) {
      var v = words[i];
      h ^= (v & 0xff); h = Math.imul(h, 16777619);
      h ^= ((v >>> 8) & 0xff); h = Math.imul(h, 16777619);
      h ^= ((v >>> 16) & 0xff); h = Math.imul(h, 16777619);
      h ^= (v >>> 24); h = Math.imul(h, 16777619);
    }
    for (var k = 0; k < P.N; k++) { h ^= P.dist[k]; h = Math.imul(h, 16777619); }
    h ^= P.gen; h = Math.imul(h, 16777619);
    return ('00000000' + (h >>> 0).toString(16)).slice(-8);
  }

  /* ------------------------------------------------------------------ *
   * 無限個体群の写像（解析）
   * ------------------------------------------------------------------ */

  /** 二項係数の表 C[n][k]（n ≤ L）。 */
  function binomialTable(L) {
    var C = [];
    for (var n = 0; n <= L; n++) {
      C.push(new Float64Array(n + 1));
      C[n][0] = 1; C[n][n] = 1;
      for (var k = 1; k < n; k++) C[n][k] = C[n - 1][k - 1] + C[n - 1][k];
    }
    return C;
  }

  /**
   * 類の遷移確率 P(j→k)（長さ (L+1)^2、[j*(L+1)+k]）。
   * 類 j の語の複写で、j 個の 1 のうち i 個が 0 へ、L−j 個の 0 のうち m 個が 1 へ反転すると k = j − i + m。
   */
  function classTransition(L, mu) {
    var n = L + 1, T = new Float64Array(n * n), C = binomialTable(L);
    var pm = new Float64Array(n), pq = new Float64Array(n);
    pm[0] = 1; pq[0] = 1;
    for (var t = 1; t <= L; t++) { pm[t] = pm[t - 1] * mu; pq[t] = pq[t - 1] * (1 - mu); }
    for (var j = 0; j <= L; j++) {
      for (var i = 0; i <= j; i++) {
        var a = C[j][i] * pm[i] * pq[j - i];
        if (a === 0) continue;
        for (var m = 0; m <= L - j; m++) {
          var b = C[L - j][m] * pm[m] * pq[L - j - m];
          T[j * n + (j - i + m)] += a * b;
        }
      }
    }
    return T;
  }

  /** 写像を1回。x（長さ L+1）→ 新しい配列。 */
  function mapStep(x, T, w, L) {
    var n = L + 1, y = new Float64Array(n), phi = 0;
    for (var j = 0; j < n; j++) {
      var s = w[j] * x[j];
      if (s === 0) continue;
      phi += s;
      var row = j * n;
      for (var k = 0; k < n; k++) y[k] += T[row + k] * s;
    }
    for (var k2 = 0; k2 < n; k2++) y[k2] /= phi;
    return y;
  }

  function initialShares(L, init) {
    var x = new Float64Array(L + 1);
    if (init === 'poles') { x[0] = 0.5; x[L] = 0.5; }
    else if (init === 'uniform') { var C = binomialTable(L); for (var d = 0; d <= L; d++) x[d] = C[L][d] / Math.pow(2, L); }
    else x[0] = 1;
    return x;
  }

  /**
   * 写像の固定点（主固有ベクトル）。行列 A[k][j] = T[j][k] w[j] を繰り返し 2 乗して A^(2^s) x0 を取る。
   * 各段で最大成分で割って桁溢れを防ぐ。squarings 回で実効 2^squarings 回の反復。
   */
  function fixedPoint(T, w, L, squarings) {
    var n = L + 1, S = squarings || 26;
    var A = new Float64Array(n * n);
    for (var k = 0; k < n; k++) for (var j = 0; j < n; j++) A[k * n + j] = T[j * n + k] * w[j];
    function normalize(M) {
      var mx = 0;
      for (var i = 0; i < M.length; i++) if (M[i] > mx) mx = M[i];
      if (mx > 0) for (var i2 = 0; i2 < M.length; i2++) M[i2] /= mx;
    }
    normalize(A);
    var prev = null, x = null;
    for (var s = 0; s < S; s++) {
      var B = new Float64Array(n * n);
      for (var i = 0; i < n; i++) {
        for (var p = 0; p < n; p++) {
          var a = A[i * n + p];
          if (a === 0) continue;
          for (var q = 0; q < n; q++) B[i * n + q] += a * A[p * n + q];
        }
      }
      normalize(B);
      A = B;
      // 途中経過: x = A · (原点に 1) を正規化
      var y = new Float64Array(n), tot = 0;
      for (var r = 0; r < n; r++) { y[r] = A[r * n + 0]; tot += y[r]; }
      for (var r2 = 0; r2 < n; r2++) y[r2] /= tot;
      if (prev) {
        var diff = 0;
        for (var r3 = 0; r3 < n; r3++) diff = Math.max(diff, Math.abs(y[r3] - prev[r3]));
        if (diff < 1e-14 && s >= 8) { x = y; break; }
      }
      prev = y; x = y;
    }
    return x;
  }

  /**
   * 写像を T 世代走らせ、窓 [winStart, T) の時間平均を返す。
   * shares の観測（類 0・類 ≤1・類 ≤2・d > L/2・平均 d）は core が数えるだけで、名前は付けない。
   */
  function mapRun(opts) {
    var L = opts.L, T = opts.T, winStart = opts.winStart, w = opts.weights;
    var Tr = opts.transition || classTransition(L, opts.mu);
    var x = opts.x0 ? Float64Array.from(opts.x0) : initialShares(L, opts.init);
    var half = (L + 1) / 2;
    var acc = { c0: 0, c1: 0, c2: 0, far: 0, dmean: 0, n: 0, firstC0: 0, secondC0: 0, n1: 0, n2: 0, lowD: 0 };
    var series = opts.seriesPoints ? [] : null;
    var every = opts.seriesPoints ? Math.max(1, Math.floor(T / opts.seriesPoints)) : 0;
    var mid = winStart + Math.floor((T - winStart) / 2);
    for (var t = 0; t < T; t++) {
      if (series && t % every === 0) series.push(+x[0].toFixed(6));
      if (t >= winStart) {
        var far = 0, dm = 0;
        for (var d = 0; d <= L; d++) { dm += d * x[d]; if (d > L / 2) far += x[d]; }
        acc.c0 += x[0]; acc.c1 += x[0] + x[1]; acc.c2 += x[0] + x[1] + (L >= 2 ? x[2] : 0);
        acc.far += far; acc.dmean += dm / L; acc.n++;
        if (dm / L < 0.5) acc.lowD++;
        if (t < mid) { acc.firstC0 += x[0]; acc.n1++; } else { acc.secondC0 += x[0]; acc.n2++; }
      }
      x = mapStep(x, Tr, w, L);
    }
    void half;
    return {
      c0: acc.c0 / acc.n, c1: acc.c1 / acc.n, c2: acc.c2 / acc.n, far: acc.far / acc.n,
      dmean: acc.dmean / acc.n, lowDRate: acc.lowD / acc.n,
      firstC0: acc.firstC0 / acc.n1, secondC0: acc.secondC0 / acc.n2,
      final: x, series: series,
    };
  }

  /**
   * 2^L 語の写像（縮約の検算用。L ≤ 10）。x は長さ 2^L、原点は語 0。
   * 返り値は類に集約した長さ L+1 の配列。
   */
  function fullMapRun(L, mu, w, T, init) {
    var M = 1 << L, x = new Float64Array(M);
    if (init === 'poles') { x[0] = 0.5; x[M - 1] = 0.5; } else x[0] = 1;
    var pm = new Float64Array(L + 1), pq = new Float64Array(L + 1);
    pm[0] = 1; pq[0] = 1;
    for (var t = 1; t <= L; t++) { pm[t] = pm[t - 1] * mu; pq[t] = pq[t - 1] * (1 - mu); }
    var pc = new Uint8Array(M);
    for (var u = 0; u < M; u++) pc[u] = popcount32(u);
    for (var step = 0; step < T; step++) {
      var y = new Float64Array(M), phi = 0;
      for (var v = 0; v < M; v++) {
        var s = w[pc[v]] * x[v];
        if (s === 0) continue;
        phi += s;
        for (var u2 = 0; u2 < M; u2++) { var dd = pc[(u2 ^ v) >>> 0]; y[u2] += s * pm[dd] * pq[L - dd]; }
      }
      for (var k = 0; k < M; k++) y[k] /= phi;
      x = y;
    }
    var out = new Float64Array(L + 1);
    for (var u3 = 0; u3 < M; u3++) out[pc[u3]] += x[u3];
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 閉形式（逆反転を無視した近似・恒等式）
   * ------------------------------------------------------------------ */

  /** 類 0 の割合の閉形式 (σ(1−μ)^L − 1)/(σ − 1)（負なら 0）。 */
  function closedFormShare(sigma, mu, L) {
    var v = (sigma * Math.pow(1 - mu, L) - 1) / (sigma - 1);
    return v > 0 ? v : 0;
  }

  /** 閉形式が水準 eps を横切る μ: 1 − ((1 + eps(σ−1))/σ)^(1/L)。eps=0 で 1 − σ^(−1/L)。 */
  function closedFormRoot(sigma, L, eps) {
    var e = eps || 0;
    return 1 - Math.pow((1 + e * (sigma - 1)) / sigma, 1 / L);
  }

  /** 二つの重み σ_A・σ_B の素朴な交差点 1 − (σ_B/σ_A)^(1/L)。 */
  function naiveCrossover(sigmaA, sigmaB, L) {
    return 1 - Math.pow(sigmaB / sigmaA, 1 / L);
  }

  return {
    DEFAULTS: DEFAULTS,
    makeRng: makeRng, popcount32: popcount32, popcount32Naive: popcount32Naive, wordsPer: wordsPer,
    weightsOnePeak: weightsOnePeak, weightsPeakAndPlain: weightsPeakAndPlain, weightsFlat: weightsFlat,
    createPool: createPool, stepPool: stepPool, recount: recount, distOf: distOf, clsOf: clsOf,
    flipGeometric: flipGeometric, flipNaive: flipNaive, siteCounts: siteCounts, hashPool: hashPool,
    binomialTable: binomialTable, classTransition: classTransition, mapStep: mapStep,
    initialShares: initialShares, fixedPoint: fixedPoint, mapRun: mapRun, fullMapRun: fullMapRun,
    closedFormShare: closedFormShare, closedFormRoot: closedFormRoot, naiveCrossover: naiveCrossover,
  };
});
