/**
 * S-71 の観測器: excessNeighborRatio・genomeSegregationIndex・pursuitAsymmetryIndex・
 * perceptionAttributionRho・spatialScaleCount。
 *
 * **ここから先だけが「構造」を語る。** core.js の運動則の側には無い語彙を使ってよい唯一の場所。
 *
 * ## 禁則7（既にある道具を書き直さない）に従った流用
 *
 * spatialScaleCount（OP5）は S-13（Ripley K・L(r)−r・包絡・大域検定）の観測器をそのまま使う。
 * S-13 はトーラス境界（境界を跨ぐ距離も測る）を前提にしており端効果の補正が要らないが、本系は
 * 「相互作用は境界を跨がない」ため OP5 の既定測り方（素のユークリッド距離）では端効果の補正が
 * 要る。したがって既定測り方の K(r) 推定量（Ripley の等方補正）は新規に書くが、
 * ①r の格子作り ②点ごとの包絡線（pointwiseEnvelope） は S-13 の stats.js（S13S）を
 * Node では require、ブラウザでは script タグ経由の global（S13/S13S）でそのまま借りる。
 * knob `pairDistanceMetric=torus` の測り直しは、境界補正が要らなくなる（S-13 の前提と一致する）ので
 * S-13 の ripley() をまるごと呼ぶ（新規実装しない）。
 */
(function (root, factory) {
  var S13, S13S;
  if (typeof module === 'object' && module.exports) {
    S13 = require('../s13-ripley-k/core.js');
    S13S = require('../s13-ripley-k/stats.js');
  } else {
    S13 = root.S13; S13S = root.S13S;
  }
  var api = factory(S13, S13S);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S54S = api;
})(typeof self !== 'undefined' ? self : this, function (S13, S13S) {
  'use strict';

  // ------------------------------------------------- 円と矩形の幾何（数値積分）
  //
  // 解析式の場合分け（辺だけに掛かる／角に掛かる）を避け、1次元の厳密な y 幅を x について
  // シンプソン則で積分する。境界・角のどちらでも同じコードで正しく動く。

  /** 円板 (cx,cy,R) と矩形 [0,L]^2 の交わりの面積。 */
  function circleRectArea(cx, cy, R, L, steps) {
    var n = steps || 200; if (n % 2 === 1) n++;
    var xlo = Math.max(0, cx - R), xhi = Math.min(L, cx + R);
    if (xhi <= xlo) return 0;
    var dx = (xhi - xlo) / n, area = 0;
    for (var k = 0; k <= n; k++) {
      var x = xlo + k * dx;
      var lim = R * R - (x - cx) * (x - cx);
      var half = lim > 0 ? Math.sqrt(lim) : 0;
      var ylo = Math.max(0, cy - half), yhi = Math.min(L, cy + half);
      var h = Math.max(0, yhi - ylo);
      var w = (k === 0 || k === n) ? 1 : (k % 2 === 1 ? 4 : 2);
      area += w * h;
    }
    return area * dx / 3;
  }

  /**
   * 円周 (cx,cy,d) のうち矩形 [0,L]^2 の内側にある割合（Ripley 等方補正の重み 1/w）を**解析的**に求める。
   *
   * 最初は等間隔32サンプルで数値近似していたが、r が場の半分近く(250)まで届くこの登録では、
   * 角付近で真の割合が小さい（円周のごく一部だけが矩形内）ケースが多発し、離散化の粗さ
   * （1/32刻み）が 1/w の分散を暴れさせて**帰無どうしの比較ですら誤検出が頻発する**ことが
   * selftest で判明した（2026-09-19。CSR同士を比べても「連結な超過区間」が0〜9本と暴れた）。
   * そこで矩形を4つの半平面の交わりとみなし、各半平面が円周上に作る弧（cosθ/sinθの閾値条件）を
   * 厳密に求めて円環（mod 2π）上で交差を取る、解析的な弧長の算出に置き換えた。
   */
  function arcWhereCosGE(centerAngle, k) {
    if (k <= -1) return { full: true };
    if (k >= 1) return { empty: true };
    var half = Math.acos(k);
    return { start: centerAngle - half, width: 2 * half };
  }
  function arcWhereCosLE(centerAngle, k) {
    if (k <= -1) return { empty: true };
    if (k >= 1) return { full: true };
    var half = Math.acos(k);
    return { start: centerAngle + half, width: 2 * Math.PI - 2 * half };
  }
  /** 区間 [a,b]（既にある程度展開済み）と、周期 2π で繰り返す弧 [lo,hi] の交わり。 */
  function intersectWithPeriodicArc(iv, lo, hi) {
    var out = [];
    for (var s = -1; s <= 1; s++) {
      var lo2 = lo + s * Math.PI * 2, hi2 = hi + s * Math.PI * 2;
      var a = Math.max(iv[0], lo2), b = Math.min(iv[1], hi2);
      if (b > a) out.push([a, b]);
    }
    return out;
  }
  function intersectArcList(list, arc) {
    if (arc.empty) return [];
    if (arc.full) return list;
    var out = [];
    list.forEach(function (iv) { out = out.concat(intersectWithPeriodicArc(iv, arc.start, arc.start + arc.width)); });
    return out;
  }

  /** 円周 (cx,cy,d) のうち矩形 [0,L]^2 の内側にある割合。0〜1。 */
  function circleInsideFraction(cx, cy, d, L) {
    var leftArc = arcWhereCosGE(0, -cx / d);              // x>=0
    var rightArc = arcWhereCosLE(0, (L - cx) / d);         // x<=L
    var bottomArc = arcWhereCosGE(Math.PI / 2, -cy / d);   // y>=0
    var topArc = arcWhereCosLE(Math.PI / 2, (L - cy) / d); // y<=L
    var work = [[0, Math.PI * 2]];
    work = intersectArcList(work, leftArc);
    work = intersectArcList(work, rightArc);
    work = intersectArcList(work, bottomArc);
    work = intersectArcList(work, topArc);
    var measure = 0;
    work.forEach(function (iv) { measure += iv[1] - iv[0]; });
    return measure / (Math.PI * 2);
  }

  // ------------------------------------------------------- OP1 excessNeighborRatio

  /**
   * @param {object} w 世界（core.js の createWorld が返す形）
   * @param {number} rMax OP1 を適用する知覚半径の上限（既定150。criteria.json ceilings）
   */
  function excessNeighborRatio(w, rMax) {
    var L = w.L, n = w.n, cap = rMax == null ? 150 : rMax;
    var excludedGenomes = [];
    w.genomes.forEach(function (g, gi) { if (g.R > cap) excludedGenomes.push(gi); });

    var sumRatio = 0, count = 0;
    for (var i = 0; i < n; i++) {
      var g = w.genomes[w.genomeIndex[i]];
      if (g.R > cap) continue;
      var ni = 0;
      for (var j = 0; j < n; j++) {
        if (j === i) continue;
        var dx = w.x[j] - w.x[i], dy = w.y[j] - w.y[i];
        if (dx * dx + dy * dy < g.R * g.R) ni++;
      }
      var aEff = circleRectArea(w.x[i], w.y[i], g.R, L);
      var expected = (n - 1) * aEff / (L * L);
      if (expected > 0) { sumRatio += ni / expected; count++; }
    }
    return { value: count > 0 ? sumRatio / count : NaN, qualifying: count, excludedGenomes: excludedGenomes };
  }

  // ------------------------------------------------- OP2 genomeSegregationIndex

  /** rSeg 内の近傍ペア（無向、距離のみで判定。相互作用と同じく境界を跨がない）を列挙する。 */
  function neighborPairsWithin(w, rSeg) {
    var pairs = [];
    for (var i = 0; i < w.n; i++) {
      for (var j = i + 1; j < w.n; j++) {
        var dx = w.x[j] - w.x[i], dy = w.y[j] - w.y[i];
        if (dx * dx + dy * dy < rSeg * rSeg) pairs.push([i, j]);
      }
    }
    return pairs;
  }

  function sameLabelFraction(pairs, labels) {
    if (pairs.length === 0) return NaN;
    var same = 0;
    for (var k = 0; k < pairs.length; k++) if (labels[pairs[k][0]] === labels[pairs[k][1]]) same++;
    return same / pairs.length;
  }

  /** Fisher-Yates。個体数を保ったままラベルだけを無作為に並べ替える（199回の帰無で使う）。 */
  function shuffleLabels(labels, rng) {
    var out = labels.slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  }

  /**
   * @param {number} rSeg 既定50（criteria.json orderParameters[1].scale）
   * @param {function} rngPermute ④のためのラベル入替え専用 rng ストリーム
   * @param {number} permutations 既定199
   */
  function genomeSegregationIndex(w, rSeg, rngPermute, permutations) {
    var nGenomes = w.genomes.length;
    if (nGenomes < 2) return { value: NaN, nullMean: NaN };
    var perms = permutations == null ? 199 : permutations;
    var pairs = neighborPairsWithin(w, rSeg);
    var labels = w.genomeIndex;
    var observed = sameLabelFraction(pairs, labels);
    if (pairs.length === 0) return { value: NaN, nullMean: NaN, pairCount: 0 };

    var nullSum = 0;
    for (var p = 0; p < perms; p++) {
      var shuffled = shuffleLabels(labels, rngPermute);
      nullSum += sameLabelFraction(pairs, shuffled);
    }
    var nullMean = nullSum / perms;
    return { value: nullMean > 0 ? observed / nullMean : NaN, nullMean: nullMean, observed: observed, pairCount: pairs.length };
  }

  // ------------------------------------------------- OP3 pursuitAsymmetryIndex

  /** レシピ内の相異なるゲノム行の全無順序ペア。 */
  function distinctGenomePairs(nGenomes) {
    var out = [];
    for (var a = 0; a < nGenomes; a++) for (var b = a + 1; b < nGenomes; b++) out.push([a, b]);
    return out;
  }

  /**
   * b型粒子（速度が非零）から見た「最も近い a型粒子への方向」と自分の速度方向の cos。
   * 戻り値は {sum, cnt}（b型粒子のうち有効なものにわたる和と件数）。
   */
  function directedCos(w, aGenome, bGenome, minSpeed) {
    var sum = 0, cnt = 0;
    for (var i = 0; i < w.n; i++) {
      if (w.genomeIndex[i] !== bGenome) continue;
      var speed = Math.hypot(w.vx[i], w.vy[i]);
      if (speed < minSpeed) continue;
      var bestD2 = Infinity, bestJ = -1;
      for (var j = 0; j < w.n; j++) {
        if (w.genomeIndex[j] !== aGenome) continue;
        var dx = w.x[j] - w.x[i], dy = w.y[j] - w.y[i];
        var d2 = dx * dx + dy * dy;
        if (d2 < bestD2) { bestD2 = d2; bestJ = j; }
      }
      if (bestJ < 0) continue;
      var dist = Math.sqrt(bestD2);
      if (dist <= 0) continue;
      var ux = (w.x[bestJ] - w.x[i]) / dist, uy = (w.y[bestJ] - w.y[i]) / dist;
      sum += (w.vx[i] * ux + w.vy[i] * uy) / speed;
      cnt++;
    }
    return { sum: sum, cnt: cnt };
  }

  var ZERO_VELOCITY_THRESHOLD = 1e-6;

  /** 1時点の pursuitAsymmetryIndex とゼロ速度個体の割合。 */
  function pursuitAsymmetryAtInstant(w) {
    var nGenomes = w.genomes.length;
    var zeroCount = 0;
    for (var i = 0; i < w.n; i++) if (Math.hypot(w.vx[i], w.vy[i]) < ZERO_VELOCITY_THRESHOLD) zeroCount++;
    var zeroFraction = zeroCount / w.n;

    var pairs = distinctGenomePairs(nGenomes);
    if (pairs.length === 0) return { value: NaN, zeroFraction: zeroFraction, pairCount: 0 };

    var deltas = [];
    for (var k = 0; k < pairs.length; k++) {
      var a = pairs[k][0], b = pairs[k][1];
      var cBA = directedCos(w, a, b, ZERO_VELOCITY_THRESHOLD); // b から見た a への方向
      var cAB = directedCos(w, b, a, ZERO_VELOCITY_THRESHOLD); // a から見た b への方向
      if (cBA.cnt === 0 || cAB.cnt === 0) continue;
      deltas.push(Math.abs(cBA.sum / cBA.cnt - cAB.sum / cAB.cnt));
    }
    var value = deltas.length > 0 ? deltas.reduce(function (s, v) { return s + v; }, 0) / deltas.length : NaN;
    return { value: value, zeroFraction: zeroFraction, pairCount: pairs.length, evaluatedPairs: deltas.length };
  }

  /** 測定窓（複数時点）にわたる平均。ゼロ速度割合の時間平均が20%を超えたらNaN（population.deadCountedAs③）。 */
  function pursuitAsymmetryOverWindow(instants) {
    var meanZero = instants.reduce(function (s, r) { return s + r.zeroFraction; }, 0) / instants.length;
    if (meanZero > 0.2) return { value: NaN, meanZeroFraction: meanZero, reason: 'zero-velocity-particles>20%' };
    var valid = instants.filter(function (r) { return !isNaN(r.value); });
    if (valid.length === 0) return { value: NaN, meanZeroFraction: meanZero, reason: 'no-genome-pairs' };
    var value = valid.reduce(function (s, r) { return s + r.value; }, 0) / valid.length;
    return { value: value, meanZeroFraction: meanZero, nInstants: valid.length };
  }

  // ------------------------------------------------- OP4 perceptionAttributionRho

  /** レシピのゲノム行から A(r) = 全無順序ペアの |Ra-Rb|/max(Ra,Rb) の平均。個体数で重み付けしない。 */
  function perceptionAsymmetryOfRecipe(rows) {
    var pairs = distinctGenomePairs(rows.length);
    if (pairs.length === 0) return NaN;
    var sum = 0;
    pairs.forEach(function (p) {
      var Ra = rows[p[0]].genome.R, Rb = rows[p[1]].genome.R;
      sum += Math.abs(Ra - Rb) / Math.max(Ra, Rb);
    });
    return sum / pairs.length;
  }

  /** Spearman順位相関。NaNを含む組は捨てる。同順位は平均順位。 */
  function spearman(xs, ys) {
    var pts = [];
    for (var i = 0; i < xs.length; i++) if (isFinite(xs[i]) && isFinite(ys[i])) pts.push([xs[i], ys[i]]);
    var n = pts.length;
    if (n < 3) return NaN;
    function rank(values) {
      var idx = values.map(function (v, i) { return i; }).sort(function (a, b) { return values[a] - values[b]; });
      var ranks = new Array(values.length);
      var i = 0;
      while (i < idx.length) {
        var j = i;
        while (j + 1 < idx.length && values[idx[j + 1]] === values[idx[i]]) j++;
        var avgRank = (i + j) / 2 + 1;
        for (var k = i; k <= j; k++) ranks[idx[k]] = avgRank;
        i = j + 1;
      }
      return ranks;
    }
    var rx = rank(pts.map(function (p) { return p[0]; }));
    var ry = rank(pts.map(function (p) { return p[1]; }));
    var mx = rx.reduce(function (a, b) { return a + b; }, 0) / n;
    var my = ry.reduce(function (a, b) { return a + b; }, 0) / n;
    var sxy = 0, sxx = 0, syy = 0;
    for (var k2 = 0; k2 < n; k2++) {
      var dx = rx[k2] - mx, dy = ry[k2] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    return (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : NaN;
  }

  // ------------------------------------------------- OP5 spatialScaleCount

  /** 既定測り方: 素のユークリッド距離 + Ripley 等方補正（境界を跨がない相互作用に合わせる）。 */
  function edgeCorrectedRipley(pts, rs) {
    var n = pts.n, L = pts.size, A = L * L;
    var bins = new Float64Array(rs.count);
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < n; j++) {
        if (i === j) continue;
        var dx = pts.x[j] - pts.x[i], dy = pts.y[j] - pts.y[i];
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d > rs.rMax || d <= 0) continue;
        var k = S13S.binOf(d, rs);
        if (k < 0) continue;
        var w = circleInsideFraction(pts.x[i], pts.y[i], d, L);
        bins[k] += w > 0 ? 1 / w : 0;
      }
    }
    var cum = new Float64Array(rs.count), acc = 0;
    for (var b = 0; b < rs.count; b++) { acc += bins[b]; cum[b] = acc; }
    var scale = n > 1 ? A / (n * (n - 1)) : 0;
    var Lminus = new Float64Array(rs.count);
    for (var kk = 0; kk < rs.count; kk++) {
      var K = scale * cum[kk];
      Lminus[kk] = Math.sqrt(Math.max(0, K) / Math.PI) - rs.r[kk];
    }
    return Lminus;
  }

  /** 曲線が包絡の外にある**連結な区間の本数**。S-13 の excursion() は総本数(bin数)を返すため別実装が必要。 */
  function countExcursionRegions(curve, env) {
    var regions = 0, wasOut = false;
    for (var k = 0; k < curve.length; k++) {
      var v = curve[k];
      var out = isFinite(v) && isFinite(env.lo[k]) && (v < env.lo[k] || v > env.hi[k]);
      if (out && !wasOut) regions++;
      wasOut = out;
    }
    return regions;
  }

  /**
   * spatialScaleCount。既定は境界補正つきユークリッド距離。knob `torus:true` で S-13 の
   * トーラス版（境界補正なし）をそのまま呼ぶ（禁則7: 新規実装しない）。
   * @param {{x,y,n,size}} pts 最終時点の配置
   * @param {function} rngCsr ⑤CSR包絡専用の rng ストリーム
   */
  function spatialScaleCount(pts, rngCsr, opts) {
    var o = opts || {};
    var rs = S13S.makeRGrid(o.rMin || 5, o.dr || 1, o.count || 246); // 5..250
    var torus = !!o.torus;
    var curve = torus ? S13S.ripley(pts, rs).Lminus : edgeCorrectedRipley(pts, rs);

    var nullCurves = [];
    for (var t = 0; t < (o.csrReps || 99); t++) {
      var csr = S13.poissonPoints(pts.n, pts.size, rngCsr);
      nullCurves.push(torus ? S13S.ripley(csr, rs).Lminus : edgeCorrectedRipley(csr, rs));
    }
    var env = S13S.pointwiseEnvelope(nullCurves, 2);
    var count = countExcursionRegions(curve, env);
    return { count: count, curve: curve, envelope: env, rs: rs };
  }

  return {
    circleRectArea: circleRectArea, circleInsideFraction: circleInsideFraction,
    excessNeighborRatio: excessNeighborRatio,
    neighborPairsWithin: neighborPairsWithin, sameLabelFraction: sameLabelFraction, shuffleLabels: shuffleLabels,
    genomeSegregationIndex: genomeSegregationIndex,
    distinctGenomePairs: distinctGenomePairs, directedCos: directedCos,
    ZERO_VELOCITY_THRESHOLD: ZERO_VELOCITY_THRESHOLD,
    pursuitAsymmetryAtInstant: pursuitAsymmetryAtInstant, pursuitAsymmetryOverWindow: pursuitAsymmetryOverWindow,
    perceptionAsymmetryOfRecipe: perceptionAsymmetryOfRecipe, spearman: spearman,
    edgeCorrectedRipley: edgeCorrectedRipley, countExcursionRegions: countExcursionRegions, spatialScaleCount: spatialScaleCount,
  };
});
