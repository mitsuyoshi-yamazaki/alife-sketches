/**
 * S-13 の観測器: Ripley の K(r)・L(r)−r・最近傍距離分布 G(r)・空地関数 F(r)・J(r)、
 * およびシミュレーションによる帰無包絡線と大域検定。
 *
 * **ここから先だけが「構造」を語る。** core.js の運動則の側には無い語彙を使ってよい唯一の場所。
 *
 * 依存ゼロ。core.js と同じく Node とブラウザで共用する（古典スクリプト・UMD 風）。
 *
 * ---- トーラス上での不偏推定量 ----
 *
 * 面積 A = size² のトーラスに n 点。**端効果の補正は要らない**——周期距離がそのまま
 * 正しい距離で、どの点も「外側」を持たないからである。r ≤ size/2 なら半径 r の円板は
 * 自分自身と重ならず面積はちょうど πr² になる。したがって一様独立な n 点（二項過程）では
 *
 *     E[ Σ_{i≠j} 1(d_ij ≤ r) ] = n(n−1) · πr² / A
 *
 * が**厳密に**成り立つ。よって
 *
 *     K̂(r) = A / (n(n−1)) · Σ_{i≠j} 1(d_ij ≤ r)      →  E[K̂(r)] = πr²
 *
 * これは実装の外から来る恒等式で、正コントロールに使える（method K-18）。
 * L 変換 L(r) = √(K(r)/π) は分散を安定させ、帰無を **L(r) − r ≡ 0** という
 * 水平線にする（Ripley 1977）。
 */
(function (root, factory) {
  var api = factory(typeof module === 'object' && module.exports ? require('./core.js') : root.S13);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S13S = api;
})(typeof self !== 'undefined' ? self : this, function (S13) {
  'use strict';

  /** r の格子。単一の半径を選ばないことが本スケッチの主題なので、これが「スケール」にあたる。 */
  function makeRGrid(rMin, dr, count) {
    var r = new Float64Array(count);
    for (var k = 0; k < count; k++) r[k] = rMin + k * dr;
    return { rMin: rMin, dr: dr, count: count, r: r, rMax: rMin + (count - 1) * dr };
  }

  /** 距離 d を「d ≤ r_k を満たす最小の k」へ割り当てる。範囲外は −1。 */
  function binOf(d, rs) {
    var k = Math.ceil((d - rs.rMin) / rs.dr - 1e-12);
    if (k < 0) k = 0;
    return k >= rs.count ? -1 : k;
  }

  function cumulate(bins) {
    var out = new Float64Array(bins.length), acc = 0;
    for (var k = 0; k < bins.length; k++) { acc += bins[k]; out[k] = acc; }
    return out;
  }

  /**
   * K(r)・L(r)−r・G(r) を1パスで出す。
   * ペア走査の途中で各点の最近傍距離も取れるので、G はただで付いてくる。
   * @param {object} pts {x,y,n,size}
   */
  function ripley(pts, rs) {
    var n = pts.n, size = pts.size, A = size * size;
    var idx = S13.makeIndex(pts.x, pts.y, n, size, rs.rMax / 3);
    var bins = new Float64Array(rs.count);
    var nnBins = new Float64Array(rs.count);
    var nnd = new Float64Array(n);
    for (var q = 0; q < n; q++) nnd[q] = Infinity;

    for (var i = 0; i < n; i++) {
      (function (i2) {
        S13.forEachNear(idx, pts.x[i2], pts.y[i2], rs.rMax, function (j, d2) {
          if (j <= i2) return;
          var d = Math.sqrt(d2);
          var b = binOf(d, rs);
          if (b >= 0) bins[b] += 1;
          if (d < nnd[i2]) nnd[i2] = d;
          if (d < nnd[j]) nnd[j] = d;
        });
      })(i);
    }
    for (var m = 0; m < n; m++) {
      if (nnd[m] < Infinity) { var bb = binOf(nnd[m], rs); if (bb >= 0) nnBins[bb] += 1; }
    }

    var cum = cumulate(bins), nnCum = cumulate(nnBins);
    var K = new Float64Array(rs.count), L = new Float64Array(rs.count), G = new Float64Array(rs.count);
    var scale = n > 1 ? A / (n * (n - 1)) : 0;
    for (var k = 0; k < rs.count; k++) {
      K[k] = scale * 2 * cum[k];
      L[k] = Math.sqrt(K[k] / Math.PI) - rs.r[k];
      G[k] = n > 0 ? nnCum[k] / n : 0;
    }
    return { K: K, Lminus: L, G: G, nnd: nnd, lambda: n / A };
  }

  /**
   * 空地関数 F(r)。規則格子に置いた検査点から最近接粒子までの距離の分布。
   * 検査点を規則格子にするのは、余分な乱数を持ち込まないため（再現性）。
   */
  function emptySpace(pts, rs, side) {
    var n = pts.n, size = pts.size;
    var per = side || 64;
    var idx = S13.makeIndex(pts.x, pts.y, n, size, Math.max(size / 128, size / Math.sqrt(Math.max(2, n / 2))));
    var bins = new Float64Array(rs.count), tot = per * per;
    for (var a = 0; a < per; a++) {
      for (var b = 0; b < per; b++) {
        var px = (a + 0.5) / per * size, py = (b + 0.5) / per * size;
        var d = S13.nearestDist(idx, px, py, rs.rMax, -1);
        if (d < Infinity) { var k = binOf(d, rs); if (k >= 0) bins[k] += 1; }
      }
    }
    var cum = cumulate(bins), F = new Float64Array(rs.count);
    for (var q = 0; q < rs.count; q++) F[q] = cum[q] / tot;
    return F;
  }

  /**
   * J(r) = (1 − G(r)) / (1 − F(r))。帰無は全ての r で 1。
   * 1 − F(r) が小さいところは数値が暴れるので、しきい値未満は NaN にして報告範囲から外す。
   */
  function jFunction(G, F, minTail) {
    var lim = minTail == null ? 0.05 : minTail;
    var J = new Float64Array(G.length);
    for (var k = 0; k < G.length; k++) {
      var tail = 1 - F[k];
      J[k] = tail > lim ? (1 - G[k]) / tail : NaN;
    }
    return J;
  }

  /** ポアソン（強度 λ）での G・F の理論値 1 − exp(−λπr²)。正コントロールに使う。 */
  function poissonCdf(lambda, rs) {
    var out = new Float64Array(rs.count);
    for (var k = 0; k < rs.count; k++) out[k] = 1 - Math.exp(-lambda * Math.PI * rs.r[k] * rs.r[k]);
    return out;
  }

  /** 4つの曲線をまとめて出す。 */
  function measureAll(pts, rs, fSide) {
    var rp = ripley(pts, rs);
    var F = emptySpace(pts, rs, fSide);
    return {
      n: pts.n, lambda: rp.lambda,
      K: rp.K, Lminus: rp.Lminus, G: rp.G, F: F, J: jFunction(rp.G, F),
    };
  }

  // --------------------------------------------------- 帰無包絡線と大域検定

  /**
   * 同じ n・同じトーラスの二項過程を s 本作り、4つの曲線を集める。
   * **これが K-19 の実装そのもの**——ノブを振るなら同じノブを帰無過程にも振る。
   */
  function nullCurves(n, size, rs, s, seed, fSide) {
    var rng = S13.makeRng(seed);
    var out = { Lminus: [], G: [], F: [], J: [], K: [] };
    for (var t = 0; t < s; t++) {
      var pts = S13.poissonPoints(n, size, rng);
      var m = measureAll(pts, rs, fSide);
      out.Lminus.push(m.Lminus); out.G.push(m.G); out.F.push(m.F); out.J.push(m.J); out.K.push(m.K);
    }
    return out;
  }

  /**
   * 各 r で下から kth 番目・上から kth 番目を取る各点包絡線。
   * s=99, k=2 で公称の各点被覆率は 96%。**各点なので、r を走査すれば当然外れやすくなる**——
   * その分を測るのが本スケッチの眼目のひとつ。
   */
  function pointwiseEnvelope(curves, kth) {
    var s = curves.length, m = curves[0].length, k = kth || 2;
    var lo = new Float64Array(m), hi = new Float64Array(m);
    var mean = new Float64Array(m), sd = new Float64Array(m);
    var buf = new Float64Array(s);
    for (var c = 0; c < m; c++) {
      var cnt = 0, sum = 0, sum2 = 0;
      for (var t = 0; t < s; t++) {
        var v = curves[t][c];
        buf[cnt++] = v;
        if (isFinite(v)) { sum += v; sum2 += v * v; }
      }
      var arr = Array.prototype.slice.call(buf.subarray(0, cnt)).filter(isFinite).sort(function (a, b) { return a - b; });
      if (arr.length === 0) { lo[c] = NaN; hi[c] = NaN; mean[c] = NaN; sd[c] = NaN; continue; }
      var ki = Math.min(arr.length - 1, k - 1);
      lo[c] = arr[ki]; hi[c] = arr[arr.length - 1 - ki];
      var nn = arr.length;
      mean[c] = sum / nn;
      sd[c] = Math.sqrt(Math.max(0, sum2 / nn - mean[c] * mean[c]));
    }
    return { lo: lo, hi: hi, mean: mean, sd: sd, s: s, kth: k };
  }

  /**
   * 大域検定（厳密なモンテカルロ順位検定）。
   *
   * データ1本 + 帰無 s 本の計 s+1 本から各 r の平均・標準偏差を取り、
   * MAD = max_r |T(r) − mean(r)| （studentized なら / sd(r)）を全本に付けて順位を出す。
   * p = (データ以上の MAD を持つ本数) / (s+1)。
   *
   * **studentize しないと、分散の大きい r が暗黙に選ばれる。**
   * 「半径を1つ選ぶ」のを避けたはずが、重み付けの形で戻ってくる——両方報告する。
   */
  function madTest(data, curves, studentize, mask) {
    var s = curves.length, m = data.length;
    var all = [data].concat(curves);
    var mean = new Float64Array(m), sd = new Float64Array(m);
    for (var c = 0; c < m; c++) {
      var sum = 0, sum2 = 0, cnt = 0;
      for (var t = 0; t <= s; t++) {
        var v = all[t][c];
        if (isFinite(v)) { sum += v; sum2 += v * v; cnt++; }
      }
      mean[c] = cnt ? sum / cnt : NaN;
      sd[c] = cnt ? Math.sqrt(Math.max(0, sum2 / cnt - mean[c] * mean[c])) : NaN;
    }
    var mads = new Float64Array(s + 1);
    var argAt = -1, bestSeen = -1;
    for (var t2 = 0; t2 <= s; t2++) {
      var best = 0, arg = -1;
      for (var c2 = 0; c2 < m; c2++) {
        if (mask && !mask[c2]) continue;
        var v2 = all[t2][c2];
        if (!isFinite(v2) || !isFinite(mean[c2])) continue;
        var dev = Math.abs(v2 - mean[c2]);
        if (studentize) { if (!(sd[c2] > 1e-12)) continue; dev /= sd[c2]; }
        if (dev > best) { best = dev; arg = c2; }
      }
      mads[t2] = best;
      if (t2 === 0) { argAt = arg; bestSeen = best; }
    }
    var ge = 0;
    for (var t3 = 0; t3 <= s; t3++) if (mads[t3] >= mads[0]) ge++;
    return { mad: mads[0], p: ge / (s + 1), rank: ge, argIndex: argAt, nullMads: mads, peak: bestSeen };
  }

  /**
   * 曲線が包絡線の外にある r の**区間**をまとめる。
   * **報告するのは単一の r ではなく、この区間である。**
   */
  function excursion(curve, env, rs) {
    var lo = null, hi = null, cnt = 0, peakDev = 0, peakIdx = -1, peakSign = 0;
    for (var k = 0; k < rs.count; k++) {
      var v = curve[k];
      if (!isFinite(v) || !isFinite(env.lo[k])) continue;
      var out = v < env.lo[k] || v > env.hi[k];
      if (out) {
        cnt++;
        if (lo === null) lo = rs.r[k];
        hi = rs.r[k];
      }
      var d = v > env.hi[k] ? v - env.hi[k] : (v < env.lo[k] ? env.lo[k] - v : 0);
      if (d > peakDev) { peakDev = d; peakIdx = k; peakSign = v > env.hi[k] ? 1 : -1; }
    }
    var absPeak = 0, absIdx = -1;
    for (var q = 0; q < rs.count; q++) {
      if (isFinite(curve[q]) && Math.abs(curve[q] - (isFinite(env.mean[q]) ? env.mean[q] : 0)) > absPeak) {
        absPeak = Math.abs(curve[q] - env.mean[q]); absIdx = q;
      }
    }
    return {
      exitLo: lo, exitHi: hi, exitCount: cnt, exitFraction: cnt / rs.count,
      peakExcess: peakDev, peakExcessR: peakIdx >= 0 ? rs.r[peakIdx] : null, peakSign: peakSign,
      rPeak: absIdx >= 0 ? rs.r[absIdx] : null,
      peakDeviation: absIdx >= 0 ? curve[absIdx] - env.mean[absIdx] : 0,
      valueAtPeak: absIdx >= 0 ? curve[absIdx] : NaN,
    };
  }

  /** r の格子の中で値 r に最も近い添字。S-02 が争った半径を曲線の上に落とすのに使う。 */
  function indexOfR(rs, r) {
    var best = 0, bd = Infinity;
    for (var k = 0; k < rs.count; k++) { var d = Math.abs(rs.r[k] - r); if (d < bd) { bd = d; best = k; } }
    return best;
  }

  return {
    makeRGrid: makeRGrid, binOf: binOf, ripley: ripley, emptySpace: emptySpace,
    jFunction: jFunction, poissonCdf: poissonCdf, measureAll: measureAll,
    nullCurves: nullCurves, pointwiseEnvelope: pointwiseEnvelope, madTest: madTest,
    excursion: excursion, indexOfR: indexOfR,
  };
});
