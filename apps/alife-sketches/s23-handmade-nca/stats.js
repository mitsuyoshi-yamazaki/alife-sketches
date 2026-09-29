/**
 * S-23 の観測器。**ここから先だけが「目標に届いた」「再生した」を語る。**
 * core.js の側には格子点・場・印・占有・種別しか無い。
 *
 * ---- 母集団（K-30） ----
 *   占有 = a > thr（既定 0.1。原典の mature の閾値）。占有点のラベルは round(c) を 1..K に丸める。
 *
 * ---- 秩序変数 ----
 *   classIoU  … ラベル k ごとの IoU（|pred_k ∩ tgt_k| / |pred_k ∪ tgt_k|）と、その平均 mIoU（k=1..K。空は含めない）
 *   maskIoU   … ラベルを無視した占有の IoU
 *   bestShift … ±maxShift の平行移動を許した最大の mIoU（位置の記憶が無くても形が戻ったか）
 *   recovery  … (IoU_after − IoU_damaged) / (IoU_grow − IoU_damaged)。分母が floor 未満なら null（答えない）
 *
 * ---- 判定（criteria.json の decision） ----
 *   decide(rep, crit)     … 1 本
 *   decideArm(reps, crit) … 腕（シード間中央値）。1 本ごとの率も返す
 *
 * 依存ゼロ・古典スクリプト・UMD 風（Node では module.exports、ブラウザでは window.S23S）。
 */
(function (root, factory) {
  var api = factory(typeof module === 'object' && module.exports ? require('./core.js') : root.S23);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S23S = api;
})(typeof self !== 'undefined' ? self : this, function (S23) {
  'use strict';

  /** 占有×ラベルの盤面。 */
  function labelsOf(W, thr, K) {
    var n = W.n, a = W.cur, c = W.cur.subarray(S23.CH.c * n, (S23.CH.c + 1) * n);
    var out = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      if (a[i] > thr) {
        var lab = Math.round(c[i]);
        if (!(lab >= 1)) lab = 1; if (lab > K) lab = K;
        out[i] = lab;
      }
    }
    return out;
  }

  function classIoU(pred, tgt, K) {
    var inter = new Float64Array(K + 1), uni = new Float64Array(K + 1);
    var mInter = 0, mUni = 0, occ = 0;
    for (var i = 0; i < pred.length; i++) {
      var p = pred[i], t = tgt[i];
      if (p > 0) occ++;
      if (p === t && p > 0) { inter[p]++; uni[p]++; }
      else { if (p > 0) uni[p]++; if (t > 0) uni[t]++; }
      var po = p > 0, to = t > 0;
      if (po && to) mInter++;
      if (po || to) mUni++;
    }
    var per = [], sum = 0;
    for (var k = 1; k <= K; k++) { var v = uni[k] > 0 ? inter[k] / uni[k] : 0; per.push(v); sum += v; }
    return { perClass: per, mean: sum / K, mask: mUni > 0 ? mInter / mUni : 0, occupied: occ };
  }

  /** 素朴版（近道の検算用）: 集合を配列で作ってから数える。 */
  function classIoUNaive(pred, tgt, K) {
    var per = [];
    for (var k = 1; k <= K; k++) {
      var A = [], B = [];
      for (var i = 0; i < pred.length; i++) { if (pred[i] === k) A.push(i); if (tgt[i] === k) B.push(i); }
      var setB = {}; for (var b = 0; b < B.length; b++) setB[B[b]] = 1;
      var inter = 0; for (var a = 0; a < A.length; a++) if (setB[A[a]]) inter++;
      var union = A.length + B.length - inter;
      per.push(union > 0 ? inter / union : 0);
    }
    return { perClass: per, mean: per.reduce(function (x, y) { return x + y; }, 0) / K };
  }

  /** pred を (dx, dy) ずらした盤面（外側は 0）。 */
  function shifted(pred, L, dx, dy) {
    var out = new Uint8Array(pred.length);
    for (var y = 0; y < L; y++) {
      var sy = y - dy; if (sy < 0 || sy >= L) continue;
      for (var x = 0; x < L; x++) {
        var sx = x - dx; if (sx < 0 || sx >= L) continue;
        out[y * L + x] = pred[sy * L + sx];
      }
    }
    return out;
  }

  function bestShift(pred, tgt, K, L, maxShift) {
    var best = -1, bdx = 0, bdy = 0;
    for (var dy = -maxShift; dy <= maxShift; dy++) for (var dx = -maxShift; dx <= maxShift; dx++) {
      var v = classIoU(shifted(pred, L, dx, dy), tgt, K).mean;
      if (v > best) { best = v; bdx = dx; bdy = dy; }
    }
    return { iou: best, dx: bdx, dy: bdy };
  }

  function recovery(iouGrow, iouDamaged, iouAfter, floor) {
    var den = iouGrow - iouDamaged;
    if (!(den >= floor)) return null;
    return (iouAfter - iouDamaged) / den;
  }

  function labelHash(labels) { return S23.hashBytes(labels); }

  function median(xs) {
    var v = xs.filter(function (x) { return x !== null && x !== undefined && !isNaN(x); })
      .sort(function (p, q) { return p - q; });
    var n = v.length;
    if (!n) return null;
    return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  }

  /**
   * 1 本の判定。rep = { iouGrow, iouHalf, iouPersist (none のみ), ratio (損傷手順のみ), protocol }
   * crit = criteria.json の thresholds。
   */
  function decide(rep, crit) {
    var growth = rep.iouGrow >= crit.reached ? 'reached' : (rep.iouGrow >= crit.approached ? 'approached' : 'notReached');
    var settled = Math.abs(rep.iouGrow - rep.iouHalf) <= crit.settledDelta;
    var persistent = (rep.iouPersist === null || rep.iouPersist === undefined) ? null : (rep.iouPersist >= rep.iouGrow - crit.persistentDrop);
    var regen = null;
    if (rep.ratio === null) regen = 'undefined';
    else if (rep.ratio !== undefined) regen = rep.ratio >= crit.regenerates ? 'regenerates' : (rep.ratio >= crit.partialRegeneration ? 'partial' : 'none');
    return { growth: growth, settled: settled, persistent: persistent, regeneration: regen };
  }

  /** 腕の判定（シード間中央値）。 */
  function decideArm(reps, crit) {
    var mGrow = median(reps.map(function (r) { return r.iouGrow; }));
    var mHalf = median(reps.map(function (r) { return r.iouHalf; }));
    var pers = reps.map(function (r) { return r.iouPersist; }).filter(function (x) { return x !== null && x !== undefined; });
    var mPersist = pers.length ? median(pers) : null;
    var ratios = reps.map(function (r) { return r.ratio; });
    var defined = ratios.filter(function (x) { return x !== null && x !== undefined; });
    var mRatio = defined.length ? median(defined) : null;
    var arm = decide({ iouGrow: mGrow, iouHalf: mHalf, iouPersist: mPersist, ratio: ratios.some(function (x) { return x !== undefined; }) ? (defined.length * 2 >= ratios.length ? mRatio : null) : undefined }, crit);
    function frac(f) { return reps.filter(f).length / reps.length; }
    var per = reps.map(function (r) { return decide(r, crit); });
    return {
      n: reps.length,
      iouGrow: mGrow, iouHalf: mHalf, iouPersist: mPersist, ratio: mRatio,
      ratioDefinedCount: defined.length,
      iouGrowMin: Math.min.apply(null, reps.map(function (r) { return r.iouGrow; })),
      iouGrowMax: Math.max.apply(null, reps.map(function (r) { return r.iouGrow; })),
      growth: arm.growth, settled: arm.settled, persistent: arm.persistent, regeneration: arm.regeneration,
      perReplicate: {
        reached: frac(function (r, i) { return per[i].growth === 'reached'; }),
        approached: frac(function (r, i) { return per[i].growth === 'approached'; }),
        settled: frac(function (r, i) { return per[i].settled; }),
        persistent: pers.length ? per.filter(function (d) { return d.persistent === true; }).length / pers.length : null,
        regenerates: defined.length ? per.filter(function (d) { return d.regeneration === 'regenerates'; }).length / reps.length : null,
        partial: defined.length ? per.filter(function (d) { return d.regeneration === 'partial'; }).length / reps.length : null,
        undefinedRatio: per.filter(function (d) { return d.regeneration === 'undefined'; }).length / reps.length,
      },
    };
  }

  return {
    labelsOf: labelsOf, classIoU: classIoU, classIoUNaive: classIoUNaive, shifted: shifted, bestShift: bestShift,
    recovery: recovery, labelHash: labelHash, median: median, decide: decide, decideArm: decideArm,
  };
});
