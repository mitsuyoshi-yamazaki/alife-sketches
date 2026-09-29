/**
 * S-49 観測器 — criteria.json の orderParameters をそのままコードにしたもの。
 * 「回り込み」「不連続」「収束」といった判定語彙はここにだけ置く（core.js は力学だけを知る）。
 *
 * 依存ゼロ・古典スクリプト。Node（module.exports、core.js を require）と
 * ブラウザ（window.S49Observer、window.S49 を参照）で共用する。
 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./core.js'));
  } else {
    global.S49Observer = factory(global.S49);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';

  // ---------------------------------------------------------------- 基本統計

  function percentile(values, p) {
    var arr = Array.prototype.slice.call(values).sort(function (a, b) { return a - b; });
    var n = arr.length;
    if (n === 0) return NaN;
    if (n === 1) return arr[0];
    var idx = (p / 100) * (n - 1);
    var lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return arr[lo];
    return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
  }
  function median(values) { return percentile(values, 50); }

  function magnitudeArray(Fx, Fy) {
    var n = Fx.length, out = new Float64Array(n);
    for (var i = 0; i < n; i++) out[i] = Math.sqrt(Fx[i] * Fx[i] + Fy[i] * Fy[i]);
    return out;
  }

  /** 格子上の |F| の中央値（forceFieldDiscontinuity・imageSumConvergence が使う大域尺度 F_med）。 */
  function fieldMedianMagnitude(grid) { return median(magnitudeArray(grid.Fx, grid.Fy)); }

  // ---------------------------------------------------------------- wrapForceFraction / netForceReversalFraction
  //
  // 両方とも「その腕自身の N_img（=full）」対「N_img=0（最近接鏡像のみ、=min）」の比較として定義する
  // （criteria predictionTable: A3 では『F_1とF_0の差』、A1 では『F_16とF_0の差』——full 側の N が腕ごとに違う）。

  /**
   * 回り込み寄与の相対的な大きさ w(r) = |F_full-F_min| / denom(r)。
   * denominator: 'max'（既定）/ 'full' / 'min' / 'medianGlobal'（knobs[0]）。
   */
  function wrapForceFraction(gridFull, gridMin, opts) {
    opts = opts || {};
    var denom = opts.denominator || 'max';
    var n = gridFull.Fx.length;
    var w = new Float64Array(n);
    var globalMedian = opts.globalMedian; // medianGlobal のときだけ使う
    for (var i = 0; i < n; i++) {
      var dfx = gridFull.Fx[i] - gridMin.Fx[i], dfy = gridFull.Fy[i] - gridMin.Fy[i];
      var num = Math.sqrt(dfx * dfx + dfy * dfy);
      var mFull = Math.sqrt(gridFull.Fx[i] * gridFull.Fx[i] + gridFull.Fy[i] * gridFull.Fy[i]);
      var mMin = Math.sqrt(gridMin.Fx[i] * gridMin.Fx[i] + gridMin.Fy[i] * gridMin.Fy[i]);
      var d;
      if (denom === 'full') d = mFull;
      else if (denom === 'min') d = mMin;
      else if (denom === 'medianGlobal') d = globalMedian;
      else d = Math.max(mFull, mMin); // 'max'（既定）
      w[i] = d > 0 ? num / d : 0; // 0/0 は 0 と定義する（negativeControls[0] の GM=0 腕）
    }
    return { perPoint: w, median: median(w), p90: percentile(w, 90) };
  }

  /**
   * F_full と F_min のなす角が angleDegThreshold（既定90°）を超える検査点の割合。
   * どちらかのベクトルがほぼ零（GM=0 腕・格子対称点）の場合は「反転していない」として数える。
   */
  function netForceReversalFraction(gridFull, gridMin, angleDegThreshold) {
    var thr = angleDegThreshold == null ? 90 : angleDegThreshold;
    var cosThr = Math.cos(thr * Math.PI / 180);
    var n = gridFull.Fx.length, count = 0;
    var allMag = magnitudeArray(gridFull.Fx, gridFull.Fy);
    var scale = median(allMag) || 1;
    var zeroGuard = scale * 1e-9;
    for (var i = 0; i < n; i++) {
      var ax = gridFull.Fx[i], ay = gridFull.Fy[i], bx = gridMin.Fx[i], by = gridMin.Fy[i];
      var ma = Math.sqrt(ax * ax + ay * ay), mb = Math.sqrt(bx * bx + by * by);
      if (ma < zeroGuard || mb < zeroGuard) continue;
      var cosTheta = (ax * bx + ay * by) / (ma * mb);
      if (cosTheta < cosThr) count++;
    }
    return count / n;
  }

  // ---------------------------------------------------------------- forceFieldDiscontinuity

  /**
   * カット軌跡での力の跳び。各源ごとに4本の走査線（x方向カットを2つの高さで、y方向カットを2つの
   * 位置で横切る）を取り、隣接点間の |F| の最大跳びを F_med で正規化する。D = 全走査線中の最大値。
   */
  function forceFieldDiscontinuity(sources, N, shape, eps, L, Fmed, opts) {
    opts = opts || {};
    var halfWidth = opts.halfWidth != null ? opts.halfWidth : L / 1000;
    var numPoints = opts.numPoints || 201;
    var maxJump = 0;
    var perSource = [];
    for (var s = 0; s < sources.count; s++) {
      var sx = sources.x[s], sy = sources.y[s];
      var cutX = Core.wrap1(sx + L / 2, L), cutY = Core.wrap1(sy + L / 2, L);
      var lines = [
        { along: 'x', fixed: sy, cross: cutX },
        { along: 'x', fixed: Core.wrap1(sy + 0.25 * L, L), cross: cutX },
        { along: 'y', fixed: sx, cross: cutY },
        { along: 'y', fixed: Core.wrap1(sx + 0.25 * L, L), cross: cutY }
      ];
      var sourceMax = 0;
      lines.forEach(function (line) {
        var prevMag = null;
        for (var k = 0; k < numPoints; k++) {
          var t = -halfWidth + (2 * halfWidth) * k / (numPoints - 1);
          var coord = Core.wrap1(line.cross + t, L);
          var x = line.along === 'x' ? coord : line.fixed;
          var y = line.along === 'x' ? line.fixed : coord;
          var f = Core.fieldAt(x, y, sources, N, shape, eps, L);
          var mag = Math.sqrt(f.fx * f.fx + f.fy * f.fy);
          if (prevMag !== null) {
            var jump = Math.abs(mag - prevMag) / Fmed;
            if (jump > sourceMax) sourceMax = jump;
          }
          prevMag = mag;
        }
      });
      perSource.push(sourceMax);
      if (sourceMax > maxJump) maxJump = sourceMax;
    }
    return { D: maxJump, perSource: perSource };
  }

  // ---------------------------------------------------------------- imageSumConvergence

  /**
   * 鏡像和の打ち切りが十分か。N の梯子で隣接する N 同士の力の差（p95、F_med 正規化）と、
   * その比（理論 O(1/N) なら≈2）、そして正方 vs 円打ち切りの差を返す。
   */
  function imageSumConvergence(sources, Ns, gridSize, eps, L, Fmed) {
    var grids = Ns.map(function (N) { return Core.fieldGrid(sources, N, 'square', eps, L, gridSize); });
    var pairsP95 = [];
    for (var i = 0; i < Ns.length - 1; i++) {
      var a = grids[i], b = grids[i + 1];
      var diffs = new Float64Array(a.Fx.length);
      for (var k = 0; k < diffs.length; k++) {
        var dfx = a.Fx[k] - b.Fx[k], dfy = a.Fy[k] - b.Fy[k];
        diffs[k] = Math.sqrt(dfx * dfx + dfy * dfy) / Fmed;
      }
      pairsP95.push({ Na: Ns[i], Nb: Ns[i + 1], p95: percentile(diffs, 95) });
    }
    var ratios = [];
    for (i = 0; i < pairsP95.length - 1; i++) {
      ratios.push(pairsP95[i].p95 > 0 && pairsP95[i + 1].p95 > 0 ? pairsP95[i].p95 / pairsP95[i + 1].p95 : null);
    }
    // 形の独立性: 最大の N で正方 vs 円
    var Nmax = Ns[Ns.length - 1];
    var squareGrid = grids[grids.length - 1];
    var circleGrid = Core.fieldGrid(sources, Nmax, 'circle', eps, L, gridSize);
    var shapeDiffs = new Float64Array(squareGrid.Fx.length);
    for (k = 0; k < shapeDiffs.length; k++) {
      var sdx = squareGrid.Fx[k] - circleGrid.Fx[k], sdy = squareGrid.Fy[k] - circleGrid.Fy[k];
      shapeDiffs[k] = Math.sqrt(sdx * sdx + sdy * sdy) / Fmed;
    }
    return { pairsP95: pairsP95, ratios: ratios, shapeDiffP95: percentile(shapeDiffs, 95), Ns: Ns };
  }

  // ---------------------------------------------------------------- energyDrift（時間方向の畳み方は複数の統計量を用意する。knobs[2]）

  function linregSlope(xs, ys) {
    var n = xs.length, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (var i = 0; i < n; i++) { sx += xs[i]; sy += ys[i]; sxx += xs[i] * xs[i]; sxy += xs[i] * ys[i]; }
    var denom = n * sxx - sx * sx;
    return denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  }

  /** series: E(t) の1軌道ぶんの時系列。times: 対応する時刻。statType: 'max'|'rms'|'endpoint'|'slope'。 */
  function driftRaw(series, times, statType) {
    var e0 = series[0];
    var absDiffs = series.map(function (e) { return Math.abs(e - e0); });
    if (statType === 'rms') {
      var s = 0; absDiffs.forEach(function (d) { s += d * d; }); return Math.sqrt(s / absDiffs.length);
    }
    if (statType === 'endpoint') return absDiffs[absDiffs.length - 1];
    if (statType === 'slope') {
      var slope = linregSlope(times, series);
      return Math.abs(slope) * (times[times.length - 1] - times[0]);
    }
    var mx = 0; absDiffs.forEach(function (d) { if (d > mx) mx = d; }); return mx; // 'max'（既定）
  }

  // ---------------------------------------------------------------- trajectoryDivergenceFromNoWrap

  function trajectoryDivergence(stateA, stateB, L) {
    var n = stateA.count, sep = new Float64Array(n);
    var satLimit = L / Math.SQRT2;
    var saturated = 0;
    for (var i = 0; i < n; i++) {
      sep[i] = Core.torusDist(stateA.x[i], stateA.y[i], stateB.x[i], stateB.y[i], L);
      if (sep[i] >= satLimit - 1e-9) saturated++;
    }
    return { perObject: sep, median: median(sep), saturatedCount: saturated };
  }

  // ---------------------------------------------------------------- positiveControls 用の補助

  /** ∮_T² F dA ≈ 0（F=-∇Φ かつ Φ が周期的なので厳密に成り立つはずの恒等式）。 */
  function divergenceIntegralCheck(grid, Fmed) {
    var n = grid.Fx.length, sumFx = 0, sumFy = 0;
    for (var i = 0; i < n; i++) { sumFx += grid.Fx[i]; sumFy += grid.Fy[i]; }
    return { relFx: Math.abs(sumFx) / (Fmed * n), relFy: Math.abs(sumFy) / (Fmed * n) };
  }

  /** 力が、力と同じ設定で計算したポテンシャルの中心差分と一致するか（positiveControls[2]②。保存の唯一の根拠）。 */
  function numericGradientCheck(points, sources, N, shape, eps, L, h) {
    h = h || 1e-6;
    var errs = [];
    points.forEach(function (p) {
      var x = p[0], y = p[1];
      var f = Core.fieldAt(x, y, sources, N, shape, eps, L);
      var phiXp = Core.fieldAt(x + h, y, sources, N, shape, eps, L).phi;
      var phiXm = Core.fieldAt(x - h, y, sources, N, shape, eps, L).phi;
      var phiYp = Core.fieldAt(x, y + h, sources, N, shape, eps, L).phi;
      var phiYm = Core.fieldAt(x, y - h, sources, N, shape, eps, L).phi;
      var numFx = -(phiXp - phiXm) / (2 * h), numFy = -(phiYp - phiYm) / (2 * h);
      var mag = Math.max(Math.sqrt(f.fx * f.fx + f.fy * f.fy), 1e-12);
      var errx = f.fx - numFx, erry = f.fy - numFy;
      errs.push(Math.sqrt(errx * errx + erry * erry) / mag);
    });
    return { perPoint: errs, max: Math.max.apply(null, errs) };
  }

  var api = {
    percentile: percentile, median: median, magnitudeArray: magnitudeArray, fieldMedianMagnitude: fieldMedianMagnitude,
    wrapForceFraction: wrapForceFraction, netForceReversalFraction: netForceReversalFraction,
    forceFieldDiscontinuity: forceFieldDiscontinuity, imageSumConvergence: imageSumConvergence,
    linregSlope: linregSlope, driftRaw: driftRaw, trajectoryDivergence: trajectoryDivergence,
    divergenceIntegralCheck: divergenceIntegralCheck, numericGradientCheck: numericGradientCheck
  };
  return api;
});
