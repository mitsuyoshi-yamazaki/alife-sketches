/**
 * S-15 の観測器。
 *
 * **核と別ファイルにしているのは、語彙の分離を物理的に見えるようにするため**
 * （method K-5）。`core.js` には「膜」「ミセル」「層」という語が無い。
 * ここから先だけが、粒子の配置を生物学の語で読む。
 *
 * 測るもの:
 *
 *   largeFraction   大きい集合体に属する鎖の割合。**塊があるかしか言わない量**
 *                   （method K-24 の実演として、あえて登録して残す）
 *   stratification  層構造。「尾は尾の側・頭は頭の側を向いているか」。**帰無値 0（厳密）**
 *   tailToTail      向かい合わせ対。尾端どうしが接し、向きが反平行な接触対の割合
 *   P(d), S(d)      鎖の向きの相関を重心間距離 d の関数として出した曲線。
 *                   **帰無値はどちらも全ての d で 0（厳密）**
 *   anisotropy      集合体の慣性テンソル固有値比。線状なら大きく、充填した円なら 1
 *
 * 参照点は「同じ重心・向きだけ無作為」（core.cloneWithRandomOrientations）。
 * ポアソン配置は参照点にしない——塊の有無しか言わないため（method K-24）。
 */
(function (root, factory) {
  var api = factory(typeof require === 'function' ? require('./core.js') : root.S15);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S15STATS = api;
})(typeof self !== 'undefined' ? self : this, function (S15) {
  'use strict';

  var wrap = S15.wrap, mod = S15.mod;

  /** 鎖の軸ベクトル（頭 → 尾端の向き）。 */
  function axes(sys) {
    var ux = new Float64Array(sys.n), uy = new Float64Array(sys.n);
    for (var i = 0; i < sys.n; i++) { ux[i] = Math.cos(sys.theta[i]); uy[i] = Math.sin(sys.theta[i]); }
    return { ux: ux, uy: uy };
  }

  function headPos(sys, i, u) {
    var p = sys.params, b = p.bond * (p.kinds.length - 1) / 2;
    return [mod(sys.cx[i] - u.ux[i] * b, p.size), mod(sys.cy[i] - u.uy[i] * b, p.size)];
  }
  function tailPos(sys, i, u) {
    var p = sys.params, b = p.bond * (p.kinds.length - 1) / 2;
    return [mod(sys.cx[i] + u.ux[i] * b, p.size), mod(sys.cy[i] + u.uy[i] * b, p.size)];
  }

  /**
   * 接触している鎖の対を列挙する。
   *
   * **連結の半径を新たに選んでいない**——系が相互作用に使う rc をそのまま使う
   * （method K-10「粒度を系から借りる」）。S-02 が踏んだ「連結半径という第二の自由度」を
   * 持ち込まないための設計である。
   */
  function contactPairs(sys) {
    var p = sys.params, g = sys.grid, L = sys.beadsPerChain, rc2 = p.rc * p.rc;
    var seen = new Set();
    var pairs = [];
    for (var a = 0; a < sys.beadCount; a++) {
      var ma = (a / L) | 0;
      var ax = sys.bx[a], ay = sys.by[a];
      var gcx = mod(Math.floor(ax / g.cellSize), g.cells);
      var gcy = mod(Math.floor(ay / g.cellSize), g.cells);
      for (var oy = -1; oy <= 1; oy++) {
        var ny = mod(gcy + oy, g.cells);
        for (var ox = -1; ox <= 1; ox++) {
          var nx = mod(gcx + ox, g.cells);
          var arr = g.bucket[ny * g.cells + nx];
          for (var t = 0; t < arr.length; t++) {
            var b = arr[t];
            if (b <= a) continue;
            var mb = (b / L) | 0;
            if (mb === ma) continue;
            var dx = wrap(sys.bx[b] - ax, p.size), dy = wrap(sys.by[b] - ay, p.size);
            if (dx * dx + dy * dy >= rc2) continue;
            var lo = ma < mb ? ma : mb, hi = ma < mb ? mb : ma;
            var key = lo * sys.n + hi;
            if (seen.has(key)) continue;
            seen.add(key);
            pairs.push([lo, hi]);
          }
        }
      }
    }
    return pairs;
  }

  /** 接触で繋がる連結成分（＝集合体）。 */
  function aggregates(sys, pairs) {
    var parent = new Int32Array(sys.n);
    for (var i = 0; i < sys.n; i++) parent[i] = i;
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    for (var k = 0; k < pairs.length; k++) {
      var ra = find(pairs[k][0]), rb = find(pairs[k][1]);
      if (ra !== rb) parent[ra] = rb;
    }
    var members = new Map();
    for (var m = 0; m < sys.n; m++) {
      var r = find(m);
      if (!members.has(r)) members.set(r, []);
      members.get(r).push(m);
    }
    var list = Array.from(members.values());
    list.sort(function (a, b) { return b.length - a.length; });
    return { list: list, labelOf: find };
  }

  /**
   * 層構造。鎖 i の軸 u_i と、その周りの「尾の多い向き」g_i の内積を平均する。
   *
   * g_i は**鎖 i のどれかの粒子と接触しうる範囲**——重心から (鎖の半長 + rc) 以内——に
   * ある**他の鎖の**粒子について、種B なら +1・種A なら -1 の重みを付けた単位ベクトルの
   * 和である。i 自身の粒子は入らない。
   *
   * この範囲は系から借りたものである（method K-10）: 鎖の長さも rc も系がもともと持って
   * いる量で、観測器が新たに選んだ半径ではない。
   *
   * **帰無値は厳密に 0** である——向きを無作為に引き直すと u_i は周囲と独立になり、
   * 内積の期待値が 0 になる（2 次元の一様な向き）。g_i は i の向きに依存しない。
   */
  function stratification(sys, u, subset) {
    var p = sys.params, g = sys.grid, L = sys.beadsPerChain;
    var reach = p.bond * (L - 1) / 2 + p.rc;
    var reach2 = reach * reach;
    var span = Math.ceil(reach / g.cellSize);
    var sum = 0, cnt = 0;
    var idx = subset || null;
    var count = idx ? idx.length : sys.n;
    for (var q = 0; q < count; q++) {
      var i = idx ? idx[q] : q;
      var cxi = sys.cx[i], cyi = sys.cy[i];
      var gx = 0, gy = 0;
      var gcx = mod(Math.floor(cxi / g.cellSize), g.cells);
      var gcy = mod(Math.floor(cyi / g.cellSize), g.cells);
      for (var oy = -span; oy <= span; oy++) {
        var ny = mod(gcy + oy, g.cells);
        for (var ox = -span; ox <= span; ox++) {
          var nx = mod(gcx + ox, g.cells);
          var arr = g.bucket[ny * g.cells + nx];
          for (var t = 0; t < arr.length; t++) {
            var b = arr[t];
            if (((b / L) | 0) === i) continue;
            var dx = wrap(sys.bx[b] - cxi, p.size), dy = wrap(sys.by[b] - cyi, p.size);
            var d2 = dx * dx + dy * dy;
            if (d2 >= reach2 || d2 === 0) continue;
            var d = Math.sqrt(d2);
            var s = sys.beadKind[b] === 1 ? 1 : -1;
            gx += s * dx / d; gy += s * dy / d;
          }
        }
      }
      var gl = Math.sqrt(gx * gx + gy * gy);
      if (gl < 1e-9) continue;
      sum += (u.ux[i] * gx + u.uy[i] * gy) / gl;
      cnt++;
    }
    return { value: cnt ? sum / cnt : 0, counted: cnt };
  }

  /**
   * 向かい合わせ対の割合。接触している鎖の対のうち、
   *   ① 尾端どうしが rc 未満で接している
   *   ② 頭どうしは尾端どうしより bond だけ以上遠い
   *   ③ 軸の内積が -0.5 未満（なす角 120 度超）
   * を全て満たすものの割合。二重層の内側で必ず起きる形である。
   */
  function tailToTail(sys, u, pairs, inSet) {
    var p = sys.params, rc2 = p.rc * p.rc, b = p.bond * (p.kinds.length - 1) / 2;
    var hit = 0, tot = 0;
    for (var k = 0; k < pairs.length; k++) {
      var i = pairs[k][0], j = pairs[k][1];
      if (inSet && !(inSet[i] && inSet[j])) continue;
      tot++;
      var dot = u.ux[i] * u.ux[j] + u.uy[i] * u.uy[j];
      if (dot >= -0.5) continue;
      var tix = sys.cx[i] + u.ux[i] * b, tiy = sys.cy[i] + u.uy[i] * b;
      var tjx = sys.cx[j] + u.ux[j] * b, tjy = sys.cy[j] + u.uy[j] * b;
      var dtx = wrap(tjx - tix, p.size), dty = wrap(tjy - tiy, p.size);
      var dt2 = dtx * dtx + dty * dty;
      if (dt2 >= rc2) continue;
      var hix = sys.cx[i] - u.ux[i] * b, hiy = sys.cy[i] - u.uy[i] * b;
      var hjx = sys.cx[j] - u.ux[j] * b, hjy = sys.cy[j] - u.uy[j] * b;
      var dhx = wrap(hjx - hix, p.size), dhy = wrap(hjy - hiy, p.size);
      var dh = Math.sqrt(dhx * dhx + dhy * dhy), dt = Math.sqrt(dt2);
      if (dh < dt + p.bond) continue;
      hit++;
    }
    return { value: tot ? hit / tot : 0, pairs: tot, hits: hit };
  }

  /**
   * 向きの相関を重心間距離の関数として出す。
   *   P(d) = <u_i . u_j>            （極性。頭と尾の向きが揃っているか）
   *   S(d) = <2 (u_i . u_j)^2 - 1>  （ネマティック。反平行も「揃っている」と数える）
   * **どちらも 2 次元の一様な向きのもとで厳密に 0** になる。
   *
   * 参照点（向きだけ無作為）は重心を動かさないので、**各ビンの対の数は完全に一致する**。
   * つまりこの曲線は「塊の大きさ」を完全に相殺した量である。
   */
  function orientationCurves(sys, u, dMax, dBin) {
    var p = sys.params;
    var nb = Math.round(dMax / dBin);
    var sumP = new Float64Array(nb), sumS = new Float64Array(nb), cnt = new Float64Array(nb);
    for (var i = 0; i < sys.n; i++) {
      for (var j = i + 1; j < sys.n; j++) {
        var dx = wrap(sys.cx[j] - sys.cx[i], p.size), dy = wrap(sys.cy[j] - sys.cy[i], p.size);
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d >= dMax) continue;
        var bi = Math.floor(d / dBin);
        if (bi >= nb) continue;
        var dot = u.ux[i] * u.ux[j] + u.uy[i] * u.uy[j];
        sumP[bi] += dot; sumS[bi] += 2 * dot * dot - 1; cnt[bi]++;
      }
    }
    var d = [], P = [], S = [], c = [];
    for (var b = 0; b < nb; b++) {
      d.push((b + 0.5) * dBin);
      c.push(cnt[b]);
      P.push(cnt[b] ? sumP[b] / cnt[b] : 0);
      S.push(cnt[b] ? sumS[b] / cnt[b] : 0);
    }
    return { d: d, P: P, S: S, count: c };
  }

  /**
   * 集合体の形。接触グラフを幅優先で辿って周期境界をほどき、慣性テンソルの固有値比を出す。
   * ほどけない（辿り直すと別のずれになる）集合体はトーラスを一周しているので、
   * **上限に張り付いた事例**として別に数える（method K-26）。
   */
  function aggregateShape(sys, members, pairs) {
    var p = sys.params;
    var inSet = new Set(members);
    var adj = new Map();
    members.forEach(function (m) { adj.set(m, []); });
    for (var k = 0; k < pairs.length; k++) {
      var a = pairs[k][0], b = pairs[k][1];
      if (!inSet.has(a) || !inSet.has(b)) continue;
      adj.get(a).push(b); adj.get(b).push(a);
    }
    var pos = new Map();
    var start = members[0];
    pos.set(start, [sys.cx[start], sys.cy[start]]);
    var queue = [start], wrapsAround = false;
    while (queue.length) {
      var cur = queue.shift();
      var cp = pos.get(cur);
      var nbrs = adj.get(cur);
      for (var t = 0; t < nbrs.length; t++) {
        var nb = nbrs[t];
        var dx = wrap(sys.cx[nb] - sys.cx[cur], p.size);
        var dy = wrap(sys.cy[nb] - sys.cy[cur], p.size);
        var want = [cp[0] + dx, cp[1] + dy];
        if (!pos.has(nb)) { pos.set(nb, want); queue.push(nb); }
        else {
          var got = pos.get(nb);
          if (Math.abs(got[0] - want[0]) > 1e-6 || Math.abs(got[1] - want[1]) > 1e-6) wrapsAround = true;
        }
      }
    }
    var xs = [], ys = [];
    pos.forEach(function (v) { xs.push(v[0]); ys.push(v[1]); });
    var n = xs.length;
    var mx = xs.reduce(function (a, b) { return a + b; }, 0) / n;
    var my = ys.reduce(function (a, b) { return a + b; }, 0) / n;
    var sxx = 0, syy = 0, sxy = 0;
    for (var q = 0; q < n; q++) {
      var ax = xs[q] - mx, ay = ys[q] - my;
      sxx += ax * ax; syy += ay * ay; sxy += ax * ay;
    }
    sxx /= n; syy /= n; sxy /= n;
    var tr = sxx + syy, det = sxx * syy - sxy * sxy;
    var disc = Math.max(0, tr * tr / 4 - det);
    var l1 = tr / 2 + Math.sqrt(disc), l2 = tr / 2 - Math.sqrt(disc);
    return {
      size: members.length,
      anisotropy: l2 > 1e-9 ? l1 / l2 : Infinity,
      rg: Math.sqrt(Math.max(0, tr)),
      wrapsAround: wrapsAround,
    };
  }

  function median(arr) {
    if (!arr.length) return 0;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  /** 秩序変数をひととおり測る。 */
  function measure(sys, opts) {
    var o = opts || {};
    var minSize = o.minAggregateSize == null ? 8 : o.minAggregateSize;
    var dMax = o.dMax == null ? 6.0 : o.dMax;
    var dBin = o.dBin == null ? 0.25 : o.dBin;

    var u = axes(sys);
    var pairs = contactPairs(sys);
    var agg = aggregates(sys, pairs);
    var large = agg.list.filter(function (m) { return m.length >= minSize; });
    var inLarge = new Uint8Array(sys.n);
    var largeMembers = [];
    large.forEach(function (m) { m.forEach(function (i) { inLarge[i] = 1; largeMembers.push(i); }); });

    var shapes = large.map(function (m) { return aggregateShape(sys, m, pairs); });
    var strat = stratification(sys, u, largeMembers.length ? largeMembers : null);
    var t2t = tailToTail(sys, u, pairs, largeMembers.length ? inLarge : null);
    var curves = orientationCurves(sys, u, dMax, dBin);

    return {
      n: sys.n,
      minAggregateSize: minSize,
      aggregateCount: large.length,
      largestAggregate: agg.list.length ? agg.list[0].length : 0,
      largestFractionOfAll: (agg.list.length ? agg.list[0].length : 0) / sys.n,
      largeFraction: largeMembers.length / sys.n,
      stratification: strat.value,
      stratificationCounted: strat.counted,
      tailToTail: t2t.value,
      tailToTailPairs: t2t.pairs,
      contactPairs: pairs.length,
      anisotropyMedian: median(shapes.map(function (s) { return isFinite(s.anisotropy) ? s.anisotropy : 1e6; })),
      wrappingAggregates: shapes.filter(function (s) { return s.wrapsAround; }).length,
      meanAggregateSize: large.length ? largeMembers.length / large.length : 0,
      curves: curves,
      energyPerChain: sys.energy / sys.n,
    };
  }

  /**
   * 参照点のアンサンブル。同じ重心・向きだけ無作為な系を R 本作り、同じ観測器を当てる。
   */
  function nullEnsemble(sys, seed, R, opts) {
    var rng = S15.makeRng(seed);
    var out = [];
    for (var r = 0; r < R; r++) {
      var c = S15.cloneWithRandomOrientations(sys, rng);
      out.push(measure(c, opts));
    }
    return out;
  }

  /**
   * **強いほうの参照点**（method K-17）。重心も排除体積も守ったまま、向きだけを
   * 引き直したアンサンブル。1 本の長い回転専用の鎖から間隔を空けて標本を取る。
   */
  function stericNullEnsemble(sys, seed, R, opts, burnIn, gap) {
    var rng = S15.makeRng(seed);
    var ref = S15.cloneWithFeasibleOrientations(sys, rng, burnIn == null ? 30 : burnIn);
    var out = [];
    for (var r = 0; r < R; r++) {
      for (var g = 0; g < (gap == null ? 10 : gap); g++) S15.rotationSweep(ref, rng);
      out.push(measure(ref, opts));
    }
    return out;
  }

  /**
   * 強い参照点を 1 本の回転専用の鎖として回し、**複数のノブ設定で同時に測る**。
   * ノブ感度の解析で、設定ごとに参照点を作り直さないためにある。
   */
  function stericNullEnsembleMulti(sys, seed, R, optsList, burnIn, gap) {
    var rng = S15.makeRng(seed);
    var ref = S15.cloneWithFeasibleOrientations(sys, rng, burnIn == null ? 30 : burnIn);
    var out = optsList.map(function () { return []; });
    for (var r = 0; r < R; r++) {
      for (var g = 0; g < (gap == null ? 10 : gap); g++) S15.rotationSweep(ref, rng);
      for (var k = 0; k < optsList.length; k++) out[k].push(measure(ref, optsList[k]));
    }
    return out;
  }

  /**
   * 曲線全体を 1 回で検定する（method K-23）。
   * studentized MAD = max_b |T(b) - mean(b)| / sd(b)。平均と標準偏差はデータ 1 本と
   * 帰無 R 本の計 R+1 本から取り、データの順位で p を出す（厳密なモンテカルロ検定）。
   * **どこかのビンで外れた、という読み方をしない。**
   */
  function globalCurveTest(dataCurve, nullCurves, minCount, counts) {
    var nb = dataCurve.length;
    var mask = [];
    for (var b = 0; b < nb; b++) mask.push(counts[b] >= minCount);
    var all = [dataCurve].concat(nullCurves);
    var mean = new Float64Array(nb), sd = new Float64Array(nb);
    for (var q = 0; q < nb; q++) {
      if (!mask[q]) continue;
      var s = 0, s2 = 0;
      for (var k = 0; k < all.length; k++) { s += all[k][q]; s2 += all[k][q] * all[k][q]; }
      mean[q] = s / all.length;
      sd[q] = Math.sqrt(Math.max(1e-18, s2 / all.length - mean[q] * mean[q]));
    }
    function mad(curve) {
      var m = 0, at = -1;
      for (var b2 = 0; b2 < nb; b2++) {
        if (!mask[b2]) continue;
        var v = Math.abs(curve[b2] - mean[b2]) / sd[b2];
        if (v > m) { m = v; at = b2; }
      }
      return { mad: m, at: at };
    }
    var dataMad = mad(dataCurve);
    var ge = 0;
    for (var k2 = 0; k2 < all.length; k2++) if (mad(all[k2]).mad >= dataMad.mad) ge++;
    var lo = [], hi = [];
    for (var b3 = 0; b3 < nb; b3++) {
      var col = nullCurves.map(function (c) { return c[b3]; }).sort(function (x, y) { return x - y; });
      lo.push(col.length ? col[Math.floor(col.length * 0.025)] : 0);
      hi.push(col.length ? col[Math.min(col.length - 1, Math.ceil(col.length * 0.975))] : 0);
    }
    return {
      mad: dataMad.mad, madAtBin: dataMad.at,
      p: ge / all.length,
      maskedBins: mask.filter(Boolean).length,
      envelopeLo: lo, envelopeHi: hi, nullMean: Array.from(mean),
    };
  }

  /** 帰無 R 本の中でのデータの順位から片側 p を出す（スカラー用）。 */
  function scalarTest(value, nullValues) {
    var ge = 1;
    for (var i = 0; i < nullValues.length; i++) if (nullValues[i] >= value) ge++;
    var sorted = nullValues.slice().sort(function (a, b) { return a - b; });
    return {
      p: ge / (nullValues.length + 1),
      nullMax: sorted.length ? sorted[sorted.length - 1] : 0,
      nullMean: nullValues.reduce(function (a, b) { return a + b; }, 0) / Math.max(1, nullValues.length),
      null975: sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.975))] : 0,
    };
  }

  /**
   * **本番で使う判定規則そのもの**（criteria.json の decisionRule）。
   *
   * selftest も run.js もこの 1 つの関数を呼ぶ。K-15 が要求するのは
   * 「検出器が反応するか」ではなく「**本番の判定規則が正コントロールを拾うか**」であり、
   * 規則が 2 箇所に書かれていればその検査は成立しない。
   */
  function evaluate(m, weakNulls, strongNulls, th, minPairsPerBin) {
    var weakStrat = weakNulls.map(function (x) { return x.stratification; });
    var strongStrat = strongNulls.map(function (x) { return x.stratification; });
    var tWeak = scalarTest(m.stratification, weakStrat);
    var tStrong = scalarTest(m.stratification, strongStrat);
    var mp = minPairsPerBin == null ? 30 : minPairsPerBin;
    // 判定に使うのは P(d)（極性）。S(d)（ネマティック）は報告だけする（criteria rev2）。
    var curve = globalCurveTest(m.curves.P, strongNulls.map(function (x) { return x.curves.P; }), mp, m.curves.count);
    var curveWeak = globalCurveTest(m.curves.P, weakNulls.map(function (x) { return x.curves.P; }), mp, m.curves.count);
    var curveS = globalCurveTest(m.curves.S, strongNulls.map(function (x) { return x.curves.S; }), mp, m.curves.count);
    var curveSweak = globalCurveTest(m.curves.S, weakNulls.map(function (x) { return x.curves.S; }), mp, m.curves.count);
    var L1 = m.largeFraction >= th.largeFractionMin;
    var L2 = tWeak.p <= th.scalarP;
    var L3 = tStrong.p <= th.scalarP;
    var L4 = m.stratification >= th.stratificationFloor;
    var L5 = curve.p <= th.curveP;
    var layered = L1 && L2 && L3 && L4 && L5;
    var t2tStrong = scalarTest(m.tailToTail, strongNulls.map(function (x) { return x.tailToTail; }));
    var shape = null;
    if (layered) {
      if (m.tailToTail >= th.tailToTailFloor && m.anisotropyMedian >= th.anisotropyPlanar) shape = 'planar';
      else if (m.tailToTail < th.tailToTailFloor && m.anisotropyMedian < th.anisotropyPlanar) shape = 'granular';
      else shape = 'mixed';
    }
    return {
      layered: layered, shape: shape,
      terms: { L1: L1, L2: L2, L3: L3, L4: L4, L5: L5 },
      onlyWeakReference: L1 && L2 && L4 && curveWeak.p <= th.curveP,
      stratification: m.stratification,
      stratWeakNullMean: tWeak.nullMean, stratWeakNullMax: tWeak.nullMax, stratWeakP: tWeak.p,
      stratStrongNullMean: tStrong.nullMean, stratStrongNullMax: tStrong.nullMax, stratStrongP: tStrong.p,
      stratExcess: m.stratification - tStrong.nullMean,
      stratExcessWeak: m.stratification - tWeak.nullMean,
      curveP: curve.p, curveMad: curve.mad, curveMadAtBin: curve.madAtBin, curveBins: curve.maskedBins,
      curveWeakP: curveWeak.p,
      curveS_strongP: curveS.p, curveS_mad: curveS.mad, curveS_madAtBin: curveS.madAtBin, curveS_weakP: curveSweak.p,
      curveLastBin: m.curves.count.length - 1,
      tailToTail: m.tailToTail, tailToTailStrongNullMean: t2tStrong.nullMean, tailToTailP: t2tStrong.p,
      anisotropy: m.anisotropyMedian, largeFraction: m.largeFraction,
      sizeRelativeToPC1: m.stratification / 0.984,
    };
  }

  return {
    axes: axes, headPos: headPos, tailPos: tailPos,
    contactPairs: contactPairs, aggregates: aggregates,
    stratification: stratification, tailToTail: tailToTail,
    orientationCurves: orientationCurves, aggregateShape: aggregateShape,
    measure: measure, nullEnsemble: nullEnsemble, stericNullEnsemble: stericNullEnsemble, stericNullEnsembleMulti: stericNullEnsembleMulti,
    globalCurveTest: globalCurveTest, scalarTest: scalarTest, evaluate: evaluate,
    median: median,
  };
});
