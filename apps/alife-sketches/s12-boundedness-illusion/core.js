/**
 * S-12 の核。Node とブラウザで共用する（UMD 風）。
 *
 * 二部構成:
 *   (A) 系      … 語の集まりを写しながら進める。上位概念の語彙を持たない
 *                  （word / bit / block / tier / score / pool / copy / noise だけ）
 *   (B) 当てはめ … 「ここまでのデータだけを見て上限を予測する」手続き。
 *                  こちらは観測器の側なので比喩的な語を使ってよい
 *
 * 系の作り: 長さ L のビット列（word）を count 本持つ。各世代、全部を作り直す
 * ——トーナメントで親を選び、写し、Poisson(flips) 個のビットを反転する。
 * ビット列は先頭から block に区切られている。block k は「block 0..k-1 が
 * 全て 1 で埋まっている」ときだけ意味を持ち、block k 自身が全て 1 で埋まると
 * score が gains[k] 増えて block k+1 が開く。block の中は score に効かない
 * （partial=0 のとき）ので、中は純粋な浮動になる。
 *
 * block の幅を k とともに広げると、block k を埋めるまでの待ち時間が幾何級数的に
 * 伸びる。これが「早期に見ると止まって見えるが、延ばすと超える」構造を
 * 作為なしに生む。幅を一定にすれば伸びない（対照 even）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.S12 = api;
})(this, function () {
  'use strict';

  // ==================================================== 乱数（mulberry32・シード固定）

  function makeRng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function poisson(rng, mean) {
    if (!(mean > 0)) return 0;
    var lim = Math.exp(-mean), k = 0, p = 1;
    do { k++; p *= rng(); } while (p > lim);
    return k - 1;
  }

  function popcount32(x) {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0f0f0f0f;
    return (x * 0x01010101) >>> 24;
  }

  // ==================================================== (A) 系

  /** block の境界とマスクを先に畳んでおく。深さの判定を毎世代やるため。 */
  function makeLayout(blockSizes) {
    var blocks = [], start = 0, k, i, w, bit, masks, map;
    for (k = 0; k < blockSizes.length; k++) {
      var size = blockSizes[k];
      map = {};
      for (i = 0; i < size; i++) {
        bit = start + i;
        w = bit >>> 5;
        map[w] = (map[w] || 0) | (1 << (bit & 31));
      }
      masks = [];
      Object.keys(map).forEach(function (key) { masks.push([key | 0, map[key] | 0]); });
      masks.sort(function (a, b) { return a[0] - b[0]; });
      blocks.push({ start: start, size: size, masks: masks });
      start += size;
    }
    return { blocks: blocks, length: start, words: Math.max(1, Math.ceil(start / 32)) };
  }

  var DEFAULTS = {
    count: 100,          // 語の本数
    flips: 0.6,          // 1 回の写しあたりの反転ビット数の期待値（Poisson）
    tournament: 2,       // 親選びの標本数。1 にすると選択が消える
    blockSizes: null,    // 必須
    gains: null,         // 各 block を埋めたときの score の増分
    partial: 0,          // 開いている block の中の 1 の割合に与える部分点
    base: 1              // score の基底（参照点 A4。比が 0/0 にならないようにする）
  };

  function createSystem(params, seed) {
    var p = {};
    Object.keys(DEFAULTS).forEach(function (k) { p[k] = DEFAULTS[k]; });
    Object.keys(params || {}).forEach(function (k) { p[k] = params[k]; });
    if (!p.blockSizes || !p.blockSizes.length) throw new Error('blockSizes 必須');
    if (!p.gains) p.gains = p.blockSizes.map(function () { return 1; });
    if (p.gains.length !== p.blockSizes.length) throw new Error('gains の長さが合わない');

    var lay = makeLayout(p.blockSizes);
    var W = lay.words, N = p.count;
    var cum = [0], k;
    for (k = 0; k < p.gains.length; k++) cum.push(cum[k] + p.gains[k]);

    var st = {
      params: p, layout: lay, W: W, N: N, L: lay.length,
      cum: cum,                       // cum[d] = 深さ d のときの累積 gain
      ceiling: p.base + cum[cum.length - 1] + 0, // 解析的に到達しうる最大 score
      pool: new Uint32Array(N * W),
      next: new Uint32Array(N * W),
      score: new Float64Array(N),
      depth: new Int32Array(N),
      rng: makeRng(seed),
      seed: seed,
      t: 0
    };
    // partial がある場合、最後の block を埋め切ると partial 分は cum に吸収される
    refreshAll(st);
    return st;
  }

  /** 1 本の word の深さ（先頭から何 block 埋まっているか）。 */
  function depthOf(st, idx) {
    var base = idx * st.W, blocks = st.layout.blocks, pool = st.pool;
    var k, m, ms, ok;
    for (k = 0; k < blocks.length; k++) {
      ms = blocks[k].masks; ok = true;
      for (m = 0; m < ms.length; m++) {
        if ((pool[base + ms[m][0]] & ms[m][1]) !== ms[m][1]) { ok = false; break; }
      }
      if (!ok) return k;
    }
    return blocks.length;
  }

  /** 開いている block の中に立っている 1 の数。 */
  function onesInBlock(st, idx, k) {
    var blocks = st.layout.blocks;
    if (k < 0 || k >= blocks.length) return 0;
    var base = idx * st.W, ms = blocks[k].masks, n = 0, m;
    for (m = 0; m < ms.length; m++) n += popcount32(st.pool[base + ms[m][0]] & ms[m][1]);
    return n;
  }

  function scoreOf(st, idx) {
    var d = depthOf(st, idx);
    var s = st.params.base + st.cum[d];
    if (st.params.partial > 0 && d < st.layout.blocks.length) {
      s += st.params.partial * (onesInBlock(st, idx, d) / st.layout.blocks[d].size);
    }
    return s;
  }

  /** 現在の pool から score/depth を作り直す。毎世代ここを通す（古い値を見ない・K-12）。 */
  function refreshAll(st) {
    for (var i = 0; i < st.N; i++) { st.depth[i] = depthOf(st, i); st.score[i] = scoreOf(st, i); }
  }

  function pickParent(st) {
    var k = st.params.tournament, N = st.N, rng = st.rng;
    var best = (rng() * N) | 0, i, c, ties = 1;
    for (i = 1; i < k; i++) {
      c = (rng() * N) | 0;
      if (st.score[c] > st.score[best]) { best = c; ties = 1; }
      else if (st.score[c] === st.score[best]) { ties++; if (rng() * ties < 1) best = c; }
    }
    return best;
  }

  /** 1 世代。全本を作り直す（同期更新）。 */
  function stepOnce(st) {
    var N = st.N, W = st.W, L = st.L, rng = st.rng, m = st.params.flips;
    var pool = st.pool, next = st.next, j, w, src, dst, nf, f, bit;
    for (j = 0; j < N; j++) {
      src = pickParent(st) * W; dst = j * W;
      for (w = 0; w < W; w++) next[dst + w] = pool[src + w];
      nf = poisson(rng, m);
      for (f = 0; f < nf; f++) {
        bit = (rng() * L) | 0;
        next[dst + (bit >>> 5)] ^= (1 << (bit & 31));
      }
    }
    st.pool = next; st.next = pool;
    refreshAll(st);
    st.t++;
  }

  function advance(st, steps) { for (var i = 0; i < steps; i++) stepOnce(st); }

  /** その時刻の観測。系の側ではなく観測器の側の関数。 */
  function observe(st) {
    var N = st.N, i, sum = 0, mx = -Infinity, dsum = 0, dmx = 0;
    for (i = 0; i < N; i++) {
      sum += st.score[i]; dsum += st.depth[i];
      if (st.score[i] > mx) mx = st.score[i];
      if (st.depth[i] > dmx) dmx = st.depth[i];
    }
    return { t: st.t, mean: sum / N, max: mx, meanDepth: dsum / N, maxDepth: dmx };
  }

  /**
   * 1 レプリケートを tMax まで走らせ、全世代の平均 score と最大 score を配列で返す。
   * 添字 t（0..tMax）がそのまま時刻。
   */
  function runTrajectory(params, seed, tMax, onProgress) {
    var st = createSystem(params, seed);
    var mean = new Float64Array(tMax + 1), max = new Float64Array(tMax + 1);
    var depth = new Int32Array(tMax + 1);
    var o = observe(st);
    mean[0] = o.mean; max[0] = o.max; depth[0] = o.maxDepth;
    for (var t = 1; t <= tMax; t++) {
      stepOnce(st);
      o = observe(st);
      mean[t] = o.mean; max[t] = o.max; depth[t] = o.maxDepth;
      if (onProgress && (t % 20000) === 0) onProgress(t, tMax);
    }
    return { mean: mean, max: max, depth: depth, tMax: tMax, ceiling: st.ceiling, seed: seed };
  }

  // ==================================================== (B) 当てはめと予測

  /** [lo, hi] を対数等間隔で n 点。整数へ丸めて重複を落とす。 */
  function logGrid(lo, hi, n) {
    var out = [], prev = -1, i, v;
    lo = Math.max(1, Math.floor(lo));
    for (i = 0; i < n; i++) {
      v = Math.round(lo * Math.pow(hi / lo, n === 1 ? 0 : i / (n - 1)));
      if (v > prev) { out.push(v); prev = v; }
    }
    return out;
  }

  function linGrid(lo, hi, n) {
    var out = [], prev = -1, i, v;
    for (i = 0; i < n; i++) {
      v = Math.round(lo + (hi - lo) * (n === 1 ? 0 : i / (n - 1)));
      if (v > prev) { out.push(v); prev = v; }
    }
    return out;
  }

  /** y = p + q*u に対する厳密な最小二乗（2 変数）。 */
  function lsq2(us, ys) {
    var n = us.length, su = 0, suu = 0, sy = 0, suy = 0, i;
    for (i = 0; i < n; i++) { su += us[i]; suu += us[i] * us[i]; sy += ys[i]; suy += us[i] * ys[i]; }
    var det = n * suu - su * su;
    var p, q;
    if (Math.abs(det) < 1e-300) { p = sy / n; q = 0; }
    else { q = (n * suy - su * sy) / det; p = (sy - q * su) / n; }
    var sse = 0, r;
    for (i = 0; i < n; i++) { r = ys[i] - (p + q * us[i]); sse += r * r; }
    return { p: p, q: q, sse: sse };
  }

  /**
   * 双曲線 y(t) = p + q * t/(t+b) を当てはめる。上限は p+q（硬い漸近線）。
   * b は 1 次元なので、b を対数格子で走査して内側は厳密な線形最小二乗で解く。
   * その後、最良点の左右を黄金分割で詰める。局所解に落ちない。
   */
  function fitHyperbolic(ts, ys, opts) {
    opts = opts || {};
    var bLo = opts.bLo != null ? opts.bLo : Math.max(1e-3, ts[0] / 1000);
    var bHi = opts.bHi != null ? opts.bHi : ts[ts.length - 1] * 1000;
    var n = ts.length, us = new Array(n), i;
    function evalAt(b) {
      for (i = 0; i < n; i++) us[i] = ts[i] / (ts[i] + b);
      return lsq2(us, ys);
    }
    var steps = opts.coarse || 240;
    var best = null, bestB = bLo, lb;
    for (var g = 0; g < steps; g++) {
      lb = Math.log(bLo) + (Math.log(bHi) - Math.log(bLo)) * (g / (steps - 1));
      var b = Math.exp(lb), r = evalAt(b);
      if (!best || r.sse < best.sse) { best = r; bestB = b; }
    }
    // 黄金分割で log b を詰める
    var span = (Math.log(bHi) - Math.log(bLo)) / (steps - 1);
    var lo = Math.log(bestB) - span, hi = Math.log(bestB) + span;
    var phi = (Math.sqrt(5) - 1) / 2;
    var x1 = hi - phi * (hi - lo), x2 = lo + phi * (hi - lo);
    var f1 = evalAt(Math.exp(x1)).sse, f2 = evalAt(Math.exp(x2)).sse;
    for (var it = 0; it < 80; it++) {
      if (f1 < f2) { hi = x2; x2 = x1; f2 = f1; x1 = hi - phi * (hi - lo); f1 = evalAt(Math.exp(x1)).sse; }
      else { lo = x1; x1 = x2; f1 = f2; x2 = lo + phi * (hi - lo); f2 = evalAt(Math.exp(x2)).sse; }
    }
    var bFit = Math.exp((lo + hi) / 2), fin = evalAt(bFit);
    if (fin.sse > best.sse) { bFit = bestB; fin = evalAt(bestB); }
    return {
      model: 'hyperbolic', p: fin.p, q: fin.q, b: bFit, sse: fin.sse, n: n,
      ceiling: fin.p + fin.q, k: 3,
      railedLow: bFit <= bLo * 1.0001, railedHigh: bFit >= bHi * 0.9999,
      bLo: bLo, bHi: bHi
    };
  }

  /**
   * 冪 y(t) = p + q * ((1 + b t)^a - 1)。a > 0 なら上限を持たない。
   * (a, b) を 2 次元の対数格子で走査し、内側は線形最小二乗。
   */
  function fitPower(ts, ys, opts) {
    opts = opts || {};
    var aLo = opts.aLo != null ? opts.aLo : 0.005, aHi = opts.aHi != null ? opts.aHi : 2.0;
    var bLo = opts.bLo != null ? opts.bLo : Math.max(1e-6, 1 / (ts[ts.length - 1] * 1000));
    var bHi = opts.bHi != null ? opts.bHi : 1000 / Math.max(1, ts[0]);
    var n = ts.length, us = new Array(n), i, na = opts.na || 60, nb = opts.nb || 60;
    var best = null, bestA = aLo, bestB = bLo;
    function evalAt(a, b) {
      for (i = 0; i < n; i++) us[i] = Math.pow(1 + b * ts[i], a) - 1;
      return lsq2(us, ys);
    }
    for (var ia = 0; ia < na; ia++) {
      var a = Math.exp(Math.log(aLo) + (Math.log(aHi) - Math.log(aLo)) * ia / (na - 1));
      for (var ib = 0; ib < nb; ib++) {
        var b = Math.exp(Math.log(bLo) + (Math.log(bHi) - Math.log(bLo)) * ib / (nb - 1));
        var r = evalAt(a, b);
        if (isFinite(r.sse) && (!best || r.sse < best.sse)) { best = r; bestA = a; bestB = b; }
      }
    }
    return { model: 'power', p: best.p, q: best.q, a: bestA, b: bestB, sse: best.sse, n: n, k: 4 };
  }

  function bic(fit) {
    return fit.n * Math.log(Math.max(fit.sse, 1e-300) / fit.n) + fit.k * Math.log(fit.n);
  }

  /**
   * 「T までのデータだけを見て上限を予測する」手続き。
   * grid: 'log'（既定・[1,T] の対数等間隔 48 点）か 'lin'。
   * series: 'mean'（既定）か 'max'。
   */
  function project(traj, T, opts) {
    opts = opts || {};
    var nPts = opts.points || 48;
    var ts = (opts.grid === 'lin') ? linGrid(1, T, nPts) : logGrid(1, T, nPts);
    var arr = (opts.series === 'max') ? traj.max : traj.mean;
    var ys = ts.map(function (t) { return arr[t]; });
    var h = fitHyperbolic(ts, ys, opts.fit);
    var out = { T: T, ceiling: h.ceiling, b: h.b, p: h.p, q: h.q, sse: h.sse,
                railedHigh: h.railedHigh, railedLow: h.railedLow, points: ts.length,
                yAtT: arr[T] };
    if (opts.withPower) {
      var pw = fitPower(ts, ys, opts.fit);
      out.powerA = pw.a; out.powerSse = pw.sse;
      out.dBic = bic(pw) - bic(h);   // 負なら冪のほうが良い
    }
    return out;
  }

  /**
   * 予測と、その 10 倍の時刻での実測を突き合わせる。
   * ratio = 予測上限 / 10T での実測。当たっていれば 1.0（帰無値）、
   * illusion が起きていれば 1 未満。
   */
  function checkHorizon(traj, T, factor, opts) {
    var pr = project(traj, T, opts);
    var tLate = Math.min(traj.tMax, T * (factor || 10));
    var arr = ((opts && opts.series) === 'max') ? traj.max : traj.mean;
    var yLate = arr[tLate];
    return {
      T: T, tLate: tLate, ceiling: pr.ceiling, yAtT: pr.yAtT, yLate: yLate,
      ratio: pr.ceiling / yLate, exceeded: yLate > pr.ceiling,
      b: pr.b, railedHigh: pr.railedHigh, railedLow: pr.railedLow,
      dBic: pr.dBic, powerA: pr.powerA
    };
  }

  // ==================================================== 統計の道具

  function median(xs) {
    if (!xs.length) return NaN;
    var a = xs.slice().sort(function (x, y) { return x - y; }), n = a.length;
    return n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2;
  }
  function mean(xs) { var s = 0, i; for (i = 0; i < xs.length; i++) s += xs[i]; return s / xs.length; }

  // ==================================================== 既定の系（run と viewer が共有）

  /** 幅が k とともに広がる梯子。待ち時間が幾何級数的に伸びる。 */
  function ladderBlocks(nBlocks, b0) {
    var out = [], k;
    for (k = 0; k < nBlocks; k++) out.push((b0 || 2) + k);
    return out;
  }
  function evenBlocks(nBlocks, b) {
    var out = [], k;
    for (k = 0; k < nBlocks; k++) out.push(b);
    return out;
  }

  // ==================================================== 事前登録した判定規則

  /**
   * 事前登録した判定。run.js と selftest.js が**同じ関数**を呼ぶ（K-15）。
   * rows は checkHorizon の返り値の配列（登録した T 全部ぶん）。
   *
   * illusion = 「登録した全ての T で、予測上限を 10T の実測が超える」
   *            かつ「最大の T でも比が recoverThreshold 以下（＝回復していない）」
   *
   * 第 2 項が要る。有界な系でも収束前なら第 1 項は立ちうるので、
   * 「T を伸ばしても比が 1 へ戻らない」ことまで見ないと有界と非有界を分けられない。
   */
  function illusionVerdict(rows, opts) {
    opts = opts || {};
    var recover = opts.recoverThreshold != null ? opts.recoverThreshold : 0.95;
    var exceedAll = rows.length > 0 && rows.every(function (r) { return r.exceeded; });
    var nExceeded = rows.filter(function (r) { return r.exceeded; }).length;
    var last = rows[rows.length - 1];
    var noRecovery = !!last && last.ratio <= recover;
    return {
      exceedAll: exceedAll, nExceeded: nExceeded, nHorizons: rows.length,
      ratioLast: last ? last.ratio : NaN, noRecovery: noRecovery,
      ratioMedian: median(rows.map(function (r) { return r.ratio; })),
      illusion: exceedAll && noRecovery,
      recoverThreshold: recover
    };
  }

  return {
    makeRng: makeRng, poisson: poisson, popcount32: popcount32,
    makeLayout: makeLayout, createSystem: createSystem,
    depthOf: depthOf, onesInBlock: onesInBlock, scoreOf: scoreOf, refreshAll: refreshAll,
    stepOnce: stepOnce, advance: advance, observe: observe, runTrajectory: runTrajectory,
    logGrid: logGrid, linGrid: linGrid, lsq2: lsq2,
    fitHyperbolic: fitHyperbolic, fitPower: fitPower, bic: bic,
    project: project, checkHorizon: checkHorizon, illusionVerdict: illusionVerdict,
    median: median, mean: mean,
    ladderBlocks: ladderBlocks, evenBlocks: evenBlocks,
    DEFAULTS: DEFAULTS
  };
});
