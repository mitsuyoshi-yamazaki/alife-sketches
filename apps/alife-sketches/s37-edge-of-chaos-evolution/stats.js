/*
 * S-37 観測器と題材の側。核が持たない語彙（λ・カオスの縁・課題・適合度）はここにある。
 *
 *  §1 課題（何を正解と呼ぶか）と採点
 *  §2 λ の定義（4 通り。「どれが正しいか」は決めずに制御変数の軸にする）
 *  §3 ヒストグラム・峰の探し方・事前登録した判定
 */
(function (factory) {
  'use strict';
  var api = factory(typeof require === 'function' ? require('./core.js') : window.S37);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.S37stats = api;
})(function (C) {
  'use strict';

  // ================================================================ §1 課題

  /*
   * 初期配置の分布は題材の側の自由度である（Fatès 2011 が 3 つを名前で区別し、
   * 同じ GKL 規則の成績が 82% とも 97.8% とも報告されてきたと書いている）。
   *   muB  一様に 1 配置を引く（各マス独立に 1/2）
   *   muD  p を [0,1] から一様に引き、各マスを Bernoulli(p)
   *   mu1  1 の個数 k を {0..N} から一様に引き、その個数の配置を一様に
   *   mhc  mu1 を「ちょうど半分が ρ<ρc、半分が ρ>ρc」になるよう均した形
   *        （Mitchell–Hraber–Crutchfield 1993 が対称性の崩れを避けるために課した条件）
   */
  function makeCases(rng, n, N, dist) {
    var out = [], i, k, p;
    var half = (N - 1) / 2;
    for (i = 0; i < n; i++) {
      if (dist === 'muB') {
        out.push(C.randomRow(rng, N, 0.5));
      } else if (dist === 'muD') {
        p = rng();
        out.push(C.randomRow(rng, N, p));
      } else if (dist === 'mu1') {
        k = C.randInt(rng, N + 1);
        out.push(C.rowWithOnes(rng, N, k));
      } else {                       // mhc
        if (i * 2 < n) k = C.randInt(rng, half + 1);          // 0..(N-1)/2  → ρ < 1/2
        else k = half + 1 + C.randInt(rng, N - half);         // (N+1)/2..N  → ρ > 1/2
        out.push(C.rowWithOnes(rng, N, k));
      }
    }
    return out;
  }

  /** 課題ごとの「正解の最終状態」。uniform は全マス同じ値、row は初期配置そのもの。 */
  function targetOf(task, row) {
    var N = row.length, ones = C.rowOnes(row);
    if (task === 'density') return { kind: 'uniform', bit: ones * 2 > N ? 1 : 0 };
    if (task === 'or') return { kind: 'uniform', bit: ones > 0 ? 1 : 0 };
    if (task === 'identity') return { kind: 'row', row: row };
    throw new Error('unknown task ' + task);
  }

  /** 採点。proportional は一致したマスの割合、performance は全一致なら 1。 */
  function scoreRow(finalRow, target, mode) {
    var i, c = 0, N = finalRow.length;
    if (target.kind === 'uniform') {
      if (mode === 'performance') return C.allMatch(finalRow, target.bit) ? 1 : 0;
      return C.matchFraction(finalRow, target.bit);
    }
    for (i = 0; i < N; i++) if (finalRow[i] === target.row[i]) c++;
    if (mode === 'performance') return c === N ? 1 : 0;
    return c / N;
  }

  /** 表 1 枚を課題の一式に当てたときの平均点。 */
  function evaluate(runner, table, cases, targets, mode, maxSteps) {
    var s = 0, i, res;
    for (i = 0; i < cases.length; i++) {
      res = runner.run(table, cases[i], maxSteps);
      s += scoreRow(res.row, targets[i], mode);
    }
    return s / cases.length;
  }

  /** Gács–Kurdyumov–Levin 規則を定義どおりに組む（近傍は左端が最上位）。 */
  function gklTable() {
    var t = C.emptyTable(), n, c, l1, l3, r1, r3, maj;
    for (n = 0; n < 128; n++) {
      c = (n >>> 3) & 1;
      l1 = (n >>> 4) & 1; l3 = (n >>> 6) & 1;
      r1 = (n >>> 2) & 1; r3 = n & 1;
      maj = c === 0 ? (c + l1 + l3) : (c + r1 + r3);
      t[n] = maj >= 2 ? 1 : 0;
    }
    return t;
  }

  /** 恒等規則（中央のマスをそのまま写す）。恒等課題の解になる。 */
  function identityTable() {
    var t = C.emptyTable();
    for (var n = 0; n < 128; n++) t[n] = (n >>> 3) & 1;
    return t;
  }

  /** 近傍に 1 があれば 1。or 課題の解になる。λ は定義により 127/128。 */
  function orTable() {
    var t = C.emptyTable();
    for (var n = 0; n < 128; n++) t[n] = n === 0 ? 0 : 1;
    return t;
  }

  // ================================================================ §2 λ の定義

  /*
   * Langton の λ は「静止状態 q を任意に 1 つ選び、遷移表のうち非静止状態へ写す割合」。
   * "one state q is chosen arbitrarily to be quiescent"（Mitchell ら 1993 §4）——
   * この arbitrarily が題材の側の自由度である。2 状態では少なくとも 4 通りある。
   */
  var LAMBDA_DEFS = {
    // 静止状態 = 0。λ = 1 を出す桁の割合（Mitchell らと Packard が使った形）
    d0: { lo: 0, hi: 1, fn: function (t) { return C.countOnes(t) / 128; } },
    // 静止状態 = 1。λ = 0 を出す桁の割合
    d1: { lo: 0, hi: 1, fn: function (t) { return (128 - C.countOnes(t)) / 128; } },
    // 0↔1 の交換対称で畳む（課題自身が持つ対称性に合わせる）
    dfold: { lo: 0, hi: 0.5, fn: function (t) { var v = C.countOnes(t) / 128; return Math.min(v, 1 - v); } },
    // 強い静止条件。均質な近傍 0000000 と 1111111 は数に入れない
    dstrong: {
      lo: 0, hi: 1,
      fn: function (t) {
        var c = C.countOnes(t) - t[127];
        if (t[0] === 1) c -= 1;
        return c / 126;
      },
    },
  };

  function lambdaOf(table, def) { return LAMBDA_DEFS[def].fn(table); }

  // ================================================================ §3 分布の形

  function histogram(values, def, width) {
    var lo = LAMBDA_DEFS[def].lo, hi = LAMBDA_DEFS[def].hi;
    var nb = Math.max(1, Math.round((hi - lo) / width));
    var h = new Array(nb), i, b;
    for (i = 0; i < nb; i++) h[i] = 0;
    for (i = 0; i < values.length; i++) {
      b = Math.floor((values[i] - lo) / width);
      if (b >= nb) b = nb - 1;
      if (b < 0) b = 0;
      h[b]++;
    }
    return { lo: lo, width: width, counts: h, n: values.length,
             centers: h.map(function (_, j) { return lo + (j + 0.5) * width; }) };
  }

  /**
   * 峰の探し方。両隣より高く、全体の minShare 以上を占め、かつ
   * **地形的な突出**（その峰から、より高い区間へ下って行くときに通る最も高い鞍部との差）が
   * 最高峰の高さの prominenceShare 以上あるものだけを峰とする。
   *
   * 突出の条件が要る理由: 完全に平らな分布でも、区間の刻みが値の刻みと約分できないと
   * 高さが 80/90/80/90 と交互になり、素朴な「両隣より高い」だけでは 7 本の峰が立つ。
   * 本番前に平坦な入力で実際に出た（selftest PK1）。
   */
  function findPeaks(hist, minShare, prominenceShare) {
    var c = hist.counts, n = c.length, raw = [], i, j, floor = minShare * hist.n;
    i = 0;
    while (i < n) {
      if (c[i] <= floor) { i++; continue; }
      j = i; while (j + 1 < n && c[j + 1] === c[i]) j++;
      var leftOk = (i === 0) || c[i - 1] < c[i];
      var rightOk = (j === n - 1) || c[j + 1] < c[j];
      if (leftOk && rightOk) raw.push({ bin: (i + j) >> 1, height: c[i] });
      i = j + 1;
    }
    var gmax = 0;
    for (i = 0; i < n; i++) if (c[i] > gmax) gmax = c[i];
    var cut = (prominenceShare === undefined ? 0 : prominenceShare) * gmax;
    var peaks = [];
    for (var k = 0; k < raw.length; k++) {
      var b = raw[k].bin, h = raw[k].height, m, key;
      m = Infinity; key = 0;
      for (j = b - 1; j >= 0; j--) { if (c[j] >= h) { key = m; break; } m = Math.min(m, c[j]); }
      if (j < 0) key = 0;
      var colL = isFinite(key) ? key : 0;
      m = Infinity; key = 0;
      for (j = b + 1; j < n; j++) { if (c[j] >= h) { key = m; break; } m = Math.min(m, c[j]); }
      if (j >= n) key = 0;
      var colR = isFinite(key) ? key : 0;
      var prom = h - Math.max(colL, colR);
      if (prom >= cut) peaks.push({ bin: b, height: h, prominence: prom });
    }
    peaks.sort(function (a, b2) { return b2.height - a.height || a.bin - b2.bin; });
    return peaks;
  }

  /** 2 つの主峰のあいだの谷。峰が 1 つなら谷は無い（比 1）。 */
  function dipBetween(hist, a, b) {
    var lo = Math.min(a, b), hi = Math.max(a, b), i, m = Infinity;
    for (i = lo + 1; i < hi; i++) m = Math.min(m, hist.counts[i]);
    if (!isFinite(m)) return null;
    return m;
  }

  /**
   * 事前登録した判定。reg は criteria.json の verdict 節。
   *   locked を渡すと、峰の位置を探し直さずその位置で高さだけ読む（＝選択規則を固定した腕）。
   */
  function verdict(values, def, width, reg, locked) {
    var hist = histogram(values, def, width);
    var lo = LAMBDA_DEFS[def].lo, hi = LAMBDA_DEFS[def].hi;
    var mean = 0, i;
    for (i = 0; i < values.length; i++) mean += values[i];
    mean = values.length ? mean / values.length : NaN;
    var sd = 0;
    for (i = 0; i < values.length; i++) sd += (values[i] - mean) * (values[i] - mean);
    sd = values.length > 1 ? Math.sqrt(sd / (values.length - 1)) : 0;

    var peaks = findPeaks(hist, reg.minPeakShare, reg.prominenceShare);
    var binsOf = null;
    if (locked && locked.length === 2) {
      binsOf = locked.slice();
    } else if (peaks.length >= 2) {
      binsOf = [peaks[0].bin, peaks[1].bin].sort(function (x, y) { return x - y; });
    } else if (peaks.length === 1) {
      binsOf = [peaks[0].bin];
    } else {
      binsOf = [];
    }

    var pos = binsOf.map(function (b) { return hist.lo + (b + 0.5) * hist.width; });
    var dip = binsOf.length === 2 ? dipBetween(hist, binsOf[0], binsOf[1]) : null;
    var peakMean = binsOf.length === 2
      ? (hist.counts[binsOf[0]] + hist.counts[binsOf[1]]) / 2
      : (binsOf.length === 1 ? hist.counts[binsOf[0]] : 0);
    var dipRatio = (dip !== null && dip > 0) ? peakMean / dip
      : (dip === 0 ? Infinity : 1);

    var bimodal = binsOf.length === 2 && dipRatio >= reg.dipCut;

    // 峰の位置がどこか。tol は 1 区間ぶん
    var tol = reg.tolBins * width;
    var half = def === 'dfold' ? LAMBDA_DEFS[def].hi : 0.5;   // 畳んだ定義では境界が中心
    var crit = (reg.lambdaC || []).map(function (v) {
      return def === 'd1' ? 1 - v : (def === 'dfold' ? Math.min(v, 1 - v) : v);
    });
    function nearAny(x, list) {
      for (var k = 0; k < list.length; k++) if (Math.abs(x - list[k]) <= tol) return true;
      return false;
    }
    var allCrit = pos.length > 0 && pos.every(function (x) { return nearAny(x, crit); });
    var allHalf = pos.length > 0 && pos.every(function (x) { return Math.abs(x - half) <= tol; });

    var where = allCrit ? 'critical' : (allHalf ? 'near-half' : 'other');
    var label;
    if (bimodal && where === 'critical') label = 'packard';
    else if (bimodal && where === 'near-half') label = 'near-half-bimodal';
    else if (bimodal) label = 'bimodal-other';
    else if (where === 'near-half') label = 'unimodal-half';
    else if (where === 'critical') label = 'unimodal-critical';
    else label = 'other';

    var offs = pos.map(function (x) { return Math.abs(x - (def === 'dfold' ? 0.5 : 0.5)); });
    var peakOffset = offs.length ? offs.reduce(function (a, b) { return a + b; }, 0) / offs.length : NaN;
    var meanOffset = 0;
    for (i = 0; i < values.length; i++) meanOffset += Math.abs(values[i] - 0.5);
    meanOffset = values.length ? meanOffset / values.length : NaN;

    return {
      n: values.length, def: def, width: width, lo: lo, hi: hi,
      mean: mean, sd: sd, meanOffset: meanOffset,
      nPeaks: peaks.length, peakBins: binsOf, peakPos: pos,
      peakHeights: binsOf.map(function (b) { return hist.counts[b]; }),
      dip: dip, dipRatio: dipRatio, bimodal: bimodal, where: where,
      peakOffset: peakOffset, label: label, counts: hist.counts,
    };
  }

  /** 二項分布 C(128,k)/2^128 ——「表の空間そのものの密度」。実装の外から来る参照点。 */
  function binomialDensity() {
    var logC = new Float64Array(129), i, lg = 0, out = new Float64Array(129);
    // log C(128,k) を漸化式で
    logC[0] = 0;
    for (i = 1; i <= 128; i++) logC[i] = logC[i - 1] + Math.log((129 - i) / i);
    for (i = 0; i <= 128; i++) { lg = logC[i] - 128 * Math.LN2; out[i] = Math.exp(lg); }
    return out;
  }

  function quantile(sorted, q) {
    if (!sorted.length) return NaN;
    var p = (sorted.length - 1) * q, lo = Math.floor(p), hi = Math.ceil(p);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (p - lo);
  }

  return {
    makeCases: makeCases, targetOf: targetOf, scoreRow: scoreRow, evaluate: evaluate,
    gklTable: gklTable, identityTable: identityTable, orTable: orTable,
    LAMBDA_DEFS: LAMBDA_DEFS, lambdaOf: lambdaOf,
    histogram: histogram, findPeaks: findPeaks, dipBetween: dipBetween,
    verdict: verdict, binomialDensity: binomialDensity, quantile: quantile,
  };
});
