/**
 * S-30 の観測器。**生物学の語彙はここにだけ許される**（核 core.js の側には無い）。
 *
 * Bedau–Packard 系の進化的活性は「成分（component）の使用回数を積み上げた量」である。
 * 積み上げる先を決めるのに 4 つの自由度があり、本ファイルはその 4 つを別々の軸として持つ:
 *
 *   1. **分け方**（何を1つの成分と数えるか）      : PARTITIONS（遺伝子座×対立遺伝子／遺伝子型／
 *                                                   対立遺伝子のみ／系統／表現型、および粗さの族）
 *   2. **積み上げ方**（1世代で何を足すか）        : 'concentration'（個体数を足す。Bedau 1992/1998）
 *                                                   ／'presence'（居れば 1 を足す）
 *   3. **母集団**（誰の活性を合計するか）          : P1 現存／P2 一度でも現れた全部／
 *                                                   P3 持続の濾過を通ったもの（MODES）／P4 個体で重みづけ
 *   4. **閾値**（どこから「適応的」と数えるか）    : 参照点の分布から導く（run.js 側）
 *
 * 成分の添字は分け方ごとに有界（遺伝子型だけ非有界なので Map で番号を振る）。
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- 分け方

  /**
   * 分け方の定義。`blocks` は遺伝子座をいくつまとめるか、`group` は対立遺伝子をいくつの組へ潰すか。
   * kind: 'locusBlock'（遺伝子座の塊×その塊の値）／'genotype'／'allele'／'lineage'／'phenotype'
   */
  function makePartitions(width, span, phenoBins) {
    var P = [];
    function locusBlock(id, title, b, g, main) {
      var nb = Math.floor(width / b);
      var vals = Math.pow(g, b);
      P.push({ id: id, title: title, kind: 'locusBlock', block: b, group: g,
               size: nb * vals, perIndividual: nb, main: !!main });
    }
    locusBlock('C1-locusAllele', '遺伝子座×対立遺伝子', 1, span, true);
    P.push({ id: 'C2-genotype', title: '遺伝子型（全体）', kind: 'genotype', size: 0, perIndividual: 1, main: true });
    P.push({ id: 'C3-allele', title: '対立遺伝子のみ（座を忘れる）', kind: 'allele', size: span, perIndividual: width, main: true });
    P.push({ id: 'C4-lineage', title: '系統（創始者の札）', kind: 'lineage', size: 0, perIndividual: 1, main: true });
    P.push({ id: 'C5-phenotype', title: '表現型（重みの階級）', kind: 'phenotype', size: phenoBins, perIndividual: 1, main: true });
    // 階級の数を振るためだけの2本（K-19 の感度比のノブ。主の分け方ではない）
    P.push({ id: 'K-pheno8', title: '表現型（階級 8）', kind: 'phenotype', bins: 8, size: 8, perIndividual: 1, main: false });
    P.push({ id: 'K-pheno32', title: '表現型（階級 32）', kind: 'phenotype', bins: 32, size: 32, perIndividual: 1, main: false });
    // 粗さの族。「遺伝子座の塊 b ×値の組 g」という同じ分け方のまま、b（分け方）と g（細かさ）を振る。
    // **b=1,g=2 と b=2,g=2 は成分の総数が同じ**（K-22: 効くのは形の名前ではなく何を固定するか）。
    var b, g, gs = [];
    for (g = 2; g <= span; g++) if (span % g === 0) gs.push(g);
    for (b = 1; b <= 3; b++) {
      if (width % b !== 0) continue;
      for (var gi = 0; gi < gs.length; gi++) {
        g = gs[gi];
        if (b === 1 && g === span) continue; // それは C1 そのもの
        locusBlock('G-b' + b + 'g' + g, '座' + b + 'つの塊×' + g + '通りの値', b, g, false);
      }
    }
    return P;
  }

  // ---------------------------------------------------------------- 集計器

  function makeTally(size) {
    var bounded = size > 0;
    return {
      bounded: bounded,
      size: bounded ? size : 0,
      map: bounded ? null : new Map(),
      actC: bounded ? new Float64Array(size) : [],   // 濃度を足す積み上げ
      actP: bounded ? new Float64Array(size) : [],   // 在ればを足す積み上げ
      cnt: bounded ? new Int32Array(size) : [],      // 今の世代の個体数
      runLen: bounded ? new Int32Array(size) : [],   // 連続して現れている世代数
      firstGen: bounded ? new Int32Array(size).fill(-1) : [],
      lastGen: bounded ? new Int32Array(size).fill(-2) : [],
      ever: 0,
      touched: [],   // 最後に観測した世代に現れていた添字（要約はこれを「現存」と読む）
    };
  }

  function tallyIndex(t, key) {
    if (t.bounded) return key;
    var i = t.map.get(key);
    if (i === undefined) {
      i = t.actC.length;
      t.map.set(key, i);
      t.actC.push(0); t.actP.push(0); t.cnt.push(0); t.runLen.push(0);
      t.firstGen.push(-1); t.lastGen.push(-2);
      t.size = i + 1;
    }
    return i;
  }

  // ---------------------------------------------------------------- 観測器

  /**
   * 1 つの走行に張り付く観測器。`observe(state, gen)` を 1 世代ごとに呼ぶ。
   */
  function makeObserver(st, opts) {
    opts = opts || {};
    var phenoBins = opts.phenoBins || 16;
    var parts = makePartitions(st.width, st.span, phenoBins);
    var tallies = parts.map(function (p) { return makeTally(p.size); });
    var buf = new Uint8Array(st.width);
    return {
      parts: parts, tallies: tallies, gens: 0, phenoBins: phenoBins,
      buf: buf, st: st,
      // record を立てると、1 世代ごとの (成分の添字, 個体数) の並びを控える。
      // **代理データ法の対照（K-58）はこの控えだけから作る**——新しい模擬を1つも書かない。
      record: !!opts.record,
      trace: opts.record ? parts.map(function () { return []; }) : null,
    };
  }

  /** 塊 b・組 g の分け方で、個体 buf の成分添字を out へ書く。 */
  function locusBlockKeys(buf, width, span, b, g, out) {
    var nb = Math.floor(width / b), vals = Math.pow(g, b);
    var shrink = span / g;
    for (var k = 0; k < nb; k++) {
      var v = 0;
      for (var j = 0; j < b; j++) {
        var m = buf[k * b + j];
        var gi = Math.floor(m / shrink);
        if (gi >= g) gi = g - 1;
        v = v * g + gi;
      }
      out[k] = k * vals + v;
    }
    return nb;
  }

  var keyBuf = new Int32Array(64);

  /** 1 世代ぶんの観測。系の状態は一切変えない。 */
  function observe(ob) {
    var st = ob.st, n = st.n, width = st.width, span = st.span;
    var parts = ob.parts, tallies = ob.tallies;
    var gen = ob.gens;
    var pi, t, p, i, j, idx, nb;

    // 今の世代の個体数を数える
    for (pi = 0; pi < parts.length; pi++) {
      t = tallies[pi];
      for (j = 0; j < t.touched.length; j++) t.cnt[t.touched[j]] = 0;
      t.touched.length = 0;
    }

    for (i = 0; i < n; i++) {
      var base = i * width;
      for (j = 0; j < width; j++) ob.buf[j] = st.marks[base + j];
      for (pi = 0; pi < parts.length; pi++) {
        p = parts[pi]; t = tallies[pi];
        if (p.kind === 'locusBlock') {
          nb = locusBlockKeys(ob.buf, width, span, p.block, p.group, keyBuf);
          for (j = 0; j < nb; j++) {
            idx = keyBuf[j];
            if (t.cnt[idx] === 0) t.touched.push(idx);
            t.cnt[idx]++;
          }
        } else if (p.kind === 'allele') {
          for (j = 0; j < width; j++) {
            idx = ob.buf[j];
            if (t.cnt[idx] === 0) t.touched.push(idx);
            t.cnt[idx]++;
          }
        } else {
          var key;
          if (p.kind === 'genotype') {
            key = 0;
            for (j = 0; j < width; j++) key = key * span + ob.buf[j];
          } else if (p.kind === 'lineage') {
            key = st.label[i];
          } else { // phenotype
            var bins = p.bins || ob.phenoBins;
            key = Math.floor(st.w[i] * bins);
            if (key >= bins) key = bins - 1;
            if (key < 0) key = 0;
          }
          idx = tallyIndex(t, key);
          if (t.cnt[idx] === 0) t.touched.push(idx);
          t.cnt[idx]++;
        }
      }
    }

    // 積み上げと、持続の更新。**前の世代に居たかは世代の刻印で判定する**（集合を作らない）
    for (pi = 0; pi < parts.length; pi++) {
      t = tallies[pi];
      for (j = 0; j < t.touched.length; j++) {
        idx = t.touched[j];
        t.actC[idx] += t.cnt[idx];
        t.actP[idx] += 1;
        t.runLen[idx] = (t.lastGen[idx] === gen - 1) ? t.runLen[idx] + 1 : 1;
        t.lastGen[idx] = gen;
        if (t.firstGen[idx] < 0) { t.firstGen[idx] = gen; t.ever++; }
      }
    }
    if (ob.record) {
      for (pi = 0; pi < parts.length; pi++) {
        if (!parts[pi].main) { ob.trace[pi].push(null); continue; }
        t = tallies[pi];
        var row = new Int32Array(t.touched.length * 2);
        for (j = 0; j < t.touched.length; j++) {
          row[2 * j] = t.touched[j];
          row[2 * j + 1] = t.cnt[t.touched[j]];
        }
        ob.trace[pi].push(row);
      }
    }
    ob.gens++;
  }

  // --------------------------------------------- 代理データ法の対照（K-58）

  /**
   * 控えた並びだけから対照を作る。**新しい模擬を走らせない**。
   *
   *   'order'   : 世代の順序を並べ替える。各成分の活性の総和は不変で、
   *               「最後に現れていたのは誰か」と持続の長さだけが壊れる
   *   'relabel' : 世代ごとに成分の名前を、一度でも現れた成分の集合から一様に引き直す
   *               （単射）。世代をまたぐ同一性が壊れる
   */
  function surrogatePartition(ob, pi, mode, rng, rule, filterLen) {
    var t0 = ob.tallies[pi], p = ob.parts[pi], rows = ob.trace[pi];
    var G = rows.length, i, j, k;

    // 一度でも現れた成分の一覧（名前の付け替え先）
    var pool = [];
    for (i = 0; i < t0.size; i++) if (t0.firstGen[i] >= 0) pool.push(i);
    var E = pool.length;
    var span = Math.max(t0.size, E) + 1;

    var order = [];
    for (i = 0; i < G; i++) order.push(i);
    if (mode === 'order') {
      for (i = G - 1; i > 0; i--) { j = Math.floor(rng() * (i + 1)); k = order[i]; order[i] = order[j]; order[j] = k; }
    }

    var actC = new Float64Array(span), actP = new Float64Array(span);
    var runLen = new Int32Array(span), lastGen = new Int32Array(span).fill(-2);
    var firstGen = new Int32Array(span).fill(-1);
    var cnt = new Int32Array(span);
    var present = [], presentCnt = [];
    var ever = 0;

    for (var gi = 0; gi < G; gi++) {
      var row = rows[order[gi]];
      if (!row) continue;
      var m = row.length / 2;
      present = []; presentCnt = [];
      for (i = 0; i < m; i++) {
        var idx = row[2 * i], c = row[2 * i + 1];
        if (mode === 'relabel') {
          // 部分 Fisher–Yates。1 世代のあいだ単射になる
          var r = i + Math.floor(rng() * (E - i));
          if (r >= E) r = E - 1;
          var tmp = pool[i]; pool[i] = pool[r]; pool[r] = tmp;
          idx = pool[i];
        }
        actC[idx] += c; actP[idx] += 1;
        runLen[idx] = (lastGen[idx] === gi - 1) ? runLen[idx] + 1 : 1;
        lastGen[idx] = gi;
        if (firstGen[idx] < 0) { firstGen[idx] = gi; ever++; }
        cnt[idx] = c;
        present.push(idx); presentCnt.push(c);
      }
    }

    var act = rule === 'presence' ? actP : actC;
    var valsP1 = [], valsP3 = [], sumP1 = 0, sumP3 = 0, sumP2 = 0, maxA = 0, sumW = 0, wN = 0;
    var hist = new Int32Array(HIST_BINS);
    for (i = 0; i < span; i++) if (firstGen[i] >= 0) sumP2 += act[i];
    for (i = 0; i < present.length; i++) {
      var a = act[present[i]];
      valsP1.push(a); sumP1 += a;
      if (a > maxA) maxA = a;
      hist[histBin(a)]++;
      if (runLen[present[i]] >= filterLen) { valsP3.push(a); sumP3 += a; }
      sumW += a * presentCnt[i]; wN += presentCnt[i];
    }
    var newLate = 0, cutg = Math.floor(G * 0.75);
    for (i = 0; i < span; i++) if (firstGen[i] >= cutg) newLate++;

    return {
      id: p.id, componentSpace: p.size, perIndividual: p.perIndividual,
      D_P1: present.length, D_P2: ever, D_P3: valsP3.length,
      Acum_P1: sumP1, Acum_P2: sumP2, Acum_P3: sumP3,
      Amean_P1: present.length ? sumP1 / present.length : 0,
      Amean_P3: valsP3.length ? sumP3 / valsP3.length : 0,
      Amean_P4: wN ? sumW / wN : 0,
      Amed_P1: median(valsP1), Amed_P3: median(valsP3),
      Amax: maxA, Aq95: quantile(valsP1, 0.95),
      newLate: newLate, hist: Array.prototype.slice.call(hist),
    };
  }

  function surrogateSummarise(ob, mode, rng, rule, filterLen) {
    var out = {};
    for (var pi = 0; pi < ob.parts.length; pi++) {
      if (!ob.parts[pi].main) continue;
      out[ob.parts[pi].id] = surrogatePartition(ob, pi, mode, rng, rule, filterLen);
    }
    return out;
  }

  // ------------------------------------------------------- 要約（母集団ごと）

  var HIST_BINS = 44;
  /** 活性 a を対数階級へ落とす（階級 k の下端は 2^(k/2)）。 */
  function histBin(a) {
    if (!(a > 0)) return 0;
    var k = Math.floor(2 * Math.log2(a));
    if (k < 0) k = 0;
    if (k >= HIST_BINS) k = HIST_BINS - 1;
    return k;
  }

  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function quantile(arr, q) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var pos = (a.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
    return a[lo] + (a[hi] - a[lo]) * (pos - lo);
  }

  /**
   * 1 つの分け方について、母集団 4 通りの要約を返す。
   * `rule` は 'concentration' か 'presence'。
   */
  function summarisePartition(ob, pi, rule, filterLen) {
    var t = ob.tallies[pi], p = ob.parts[pi];
    var act = rule === 'presence' ? t.actP : t.actC;
    var present = t.touched;           // 最後に観測した世代に現れていた添字
    var valsP1 = [], valsP3 = [], sumP1 = 0, sumP3 = 0, sumP2 = 0, maxA = 0;
    var hist = new Int32Array(HIST_BINS);
    var i, idx, a;

    var everCount = 0;
    for (i = 0; i < t.size; i++) {
      if (t.firstGen[i] >= 0) { sumP2 += act[i]; everCount++; }
    }
    for (i = 0; i < present.length; i++) {
      idx = present[i]; a = act[idx];
      valsP1.push(a); sumP1 += a;
      if (a > maxA) maxA = a;
      hist[histBin(a)]++;
      if (t.runLen[idx] >= filterLen) { valsP3.push(a); sumP3 += a; }
    }
    // P4: 個体で重みづけ（成分を今の個体数で重みづけて平均する）
    var sumW = 0, wN = 0;
    for (i = 0; i < present.length; i++) {
      idx = present[i];
      sumW += act[idx] * t.cnt[idx];
      wN += t.cnt[idx];
    }

    // 直近 1/4 で初めて現れた成分の数（新規性）
    var newLate = 0, cut = Math.floor(ob.gens * 0.75);
    for (i = 0; i < t.size; i++) if (t.firstGen[i] >= cut) newLate++;

    return {
      id: p.id, componentSpace: p.size, perIndividual: p.perIndividual,
      D_P1: present.length,
      D_P2: everCount,
      D_P3: valsP3.length,
      Acum_P1: sumP1, Acum_P2: sumP2, Acum_P3: sumP3,
      Amean_P1: present.length ? sumP1 / present.length : 0,
      Amean_P3: valsP3.length ? sumP3 / valsP3.length : 0,
      Amean_P4: wN ? sumW / wN : 0,
      Amed_P1: median(valsP1),
      Amed_P3: median(valsP3),
      Amax: maxA,
      Aq95: quantile(valsP1, 0.95),
      newLate: newLate,
      hist: Array.prototype.slice.call(hist),
    };
  }

  function summarise(ob, rule, filterLen) {
    var out = {};
    for (var pi = 0; pi < ob.parts.length; pi++) {
      out[ob.parts[pi].id] = summarisePartition(ob, pi, rule, filterLen);
    }
    return out;
  }

  /** 収支の検算（K-28）。濃度で積み上げた活性の「一度でも現れた全部」の合計は厳密に決まる。 */
  function conservationExpectation(ob, pi) {
    var p = ob.parts[pi];
    return ob.gens * ob.st.n * p.perIndividual;
  }

  // -------------------------------------------------- 閾値（参照点から導く）

  /**
   * Th1: 実系と参照点の活性ヒストグラムが交わる階級の下端（Standish 2000 が記述した手続き）。
   * 両者を面積 1 へ正規化してから、参照点のほうが下回り始める最初の階級を返す。
   */
  function crossoverThreshold(histReal, histShadow) {
    var sr = 0, ss = 0, i;
    for (i = 0; i < histReal.length; i++) { sr += histReal[i]; ss += histShadow[i]; }
    if (sr === 0 || ss === 0) return null;
    for (i = histReal.length - 1; i >= 0; i--) {
      var r = histReal[i] / sr, s = histShadow[i] / ss;
      if (s > r) return Math.pow(2, (i + 1) / 2);
    }
    return Math.pow(2, 0.5);
  }

  /** 閾値を超えた現存成分の数（A_pos）。 */
  function countAbove(ob, pi, rule, a0) {
    var t = ob.tallies[pi];
    var act = rule === 'presence' ? t.actP : t.actC;
    var c = 0;
    for (var i = 0; i < t.touched.length; i++) if (act[t.touched[i]] > a0) c++;
    return c;
  }

  /** 窓 [a0,a1] に入る現存成分の数（A_new。1998 の「a0 を囲む小さな窓」）。 */
  function countInWindow(ob, pi, rule, a0, a1) {
    var t = ob.tallies[pi];
    var act = rule === 'presence' ? t.actP : t.actC;
    var c = 0, a;
    for (var i = 0; i < t.touched.length; i++) {
      a = act[t.touched[i]];
      if (a >= a0 && a <= a1) c++;
    }
    return c;
  }

  var api = {
    makePartitions: makePartitions,
    makeObserver: makeObserver,
    observe: observe,
    surrogateSummarise: surrogateSummarise,
    surrogatePartition: surrogatePartition,
    summarise: summarise,
    summarisePartition: summarisePartition,
    conservationExpectation: conservationExpectation,
    crossoverThreshold: crossoverThreshold,
    countAbove: countAbove,
    countInWindow: countInWindow,
    median: median,
    quantile: quantile,
    histBin: histBin,
    HIST_BINS: HIST_BINS,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.S30A = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
