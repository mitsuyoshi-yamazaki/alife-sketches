/**
 * S-69: 規則の標本抽出（Table 1）と1歩の時間発展（式3・式5・式8・式9・式10・式11）。
 * core.js（低水準の道具: FFT・核・成長・輸送）の上に積む層。Node とブラウザ共用（UMD）。
 * ブラウザでは <script src="core.js"> の後に読み込むこと（window.S69 に依存）。
 */
(function (global) {
  'use strict';
  var S69 = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : global.S69;

  var N = 128, CELLS = N * N;

  /** 接続行列 M（例 [[3,2],[2,3]]）→ [c0,c1] の並び（i を先、j を後、個数ぶん繰り返す）。 */
  function buildConnectivity(M) {
    var out = [];
    for (var i = 0; i < M.length; i++) {
      for (var j = 0; j < M[i].length; j++) {
        for (var k = 0; k < M[i][j]; k++) out.push([i, j]);
      }
    }
    return out;
  }

  function drawKernelParams(rng) {
    return {
      r: 0.2 + rng() * 0.8,
      a: [rng(), rng(), rng()],
      b: [rng(), rng(), rng()],
      w: [0.01 + rng() * 0.49, 0.01 + rng() * 0.49, 0.01 + rng() * 0.49],
      mu: 0.05 + rng() * 0.45,
      sigma: 0.001 + rng() * 0.199,
    };
  }

  /**
   * 規則を Table 1 の範囲から無作為に引く。draw の順序を固定することで、同じ mainConnectivity を
   * 使う腕（M-mix・R-terr・M-food・NC-neutral・NC-avg）が同じ seed で同じ大域の核・同じ種の h を
   * 共有する（K-145）。foodConnectivity は M-food だけが渡す——**共有する draw の後に追加で引く**ので、
   * 他の腕の draw 列を乱さない。
   */
  function sampleRule(rng, mainConnectivity, multiSpecies, nSpecies, foodConnectivity) {
    var R = 2 + rng() * 23;
    var mainKernels = mainConnectivity.map(function (c) {
      var k = drawKernelParams(rng); k.c0 = c[0]; k.c1 = c[1]; return k;
    });
    var h = null, speciesH = null;
    if (!multiSpecies) {
      h = mainConnectivity.map(function () { return rng(); });
    } else {
      speciesH = [];
      for (var s = 0; s < nSpecies; s++) {
        var v = mainConnectivity.map(function () { return S69.gaussian(rng); });
        speciesH.push(v);
      }
    }
    var foodKernels = [];
    if (foodConnectivity && foodConnectivity.length) {
      foodKernels = foodConnectivity.map(function (c) {
        var k = drawKernelParams(rng); k.c0 = c[0]; k.c1 = c[1]; return k;
      });
      if (!multiSpecies) {
        h = h.concat(foodConnectivity.map(function () { return rng(); }));
      } else {
        for (var s2 = 0; s2 < nSpecies; s2++) {
          speciesH[s2] = speciesH[s2].concat(foodConnectivity.map(function () { return S69.gaussian(rng); }));
        }
      }
    }
    return {
      R: R, kernels: mainKernels.concat(foodKernels), h: h, speciesH: speciesH,
      thetaA: 2, s: 0.65, n: 2, dt: 0.2,
    };
  }

  /** 核ごとの b が全て小さい（=無効化された核）かを数える。ruleSampleControl の一部。 */
  function countZeroedKernels(kernels) {
    var z = 0;
    kernels.forEach(function (k) {
      if (Math.abs(k.b[0]) + Math.abs(k.b[1]) + Math.abs(k.b[2]) < 1e-12) z++;
    });
    return z;
  }

  /** 状態と、それに紐づく使い回しバッファを作る（GC 圧を抑える）。 */
  function createState(opts) {
    var C = opts.C, hasFood = !!opts.hasFood, multiSpecies = !!opts.multiSpecies;
    var pDim = opts.pDim || 0;
    var A = []; for (var c = 0; c < C; c++) A.push(new Float64Array(CELLS));
    var st = {
      N: N, C: C, hasFood: hasFood, multiSpecies: multiSpecies, pDim: pDim,
      A: A, Psi: hasFood ? new Float64Array(CELLS) : null, Rsv: 0,
      P: multiSpecies ? new Float64Array(CELLS * pDim) : null,
      label: multiSpecies ? new Int32Array(CELLS) : null,
      dye: opts.dye ? [] : null, dyeChannels: opts.dye ? C : 0,
      driveOff: !!opts.driveOff, mixMode: opts.mixMode || 'softmax',
      t: 0,
      kernelSpectra: null, ruleSpec: null,
      _buf: {
        U: (function () { var u = []; for (var i = 0; i < C; i++) u.push(new Float64Array(CELLS)); return u; })(),
        gUx: (function () { var u = []; for (var i = 0; i < C; i++) u.push(new Float64Array(CELLS)); return u; })(),
        gUy: (function () { var u = []; for (var i = 0; i < C; i++) u.push(new Float64Array(CELLS)); return u; })(),
        gSx: new Float64Array(CELLS), gSy: new Float64Array(CELLS),
        ASigma: new Float64Array(CELLS),
        Fx: (function () { var u = []; for (var i = 0; i < C; i++) u.push(new Float64Array(CELLS)); return u; })(),
        Fy: (function () { var u = []; for (var i = 0; i < C; i++) u.push(new Float64Array(CELLS)); return u; })(),
        Adst: (function () { var u = []; for (var i = 0; i < C; i++) u.push(new Float64Array(CELLS)); return u; })(),
        outre: new Float64Array(CELLS), outim: new Float64Array(CELLS),
        incoming: multiSpecies ? S69.makeIncomingBuffers(CELLS, 32) : null,
        newP: multiSpecies ? new Float64Array(CELLS * pDim) : null,
        newLabel: multiSpecies ? new Int32Array(CELLS) : null,
        vecScratch: multiSpecies ? new Float64Array(pDim) : null,
      },
      cum: { clippedTotal: 0, maxAbsDispBeforeClip: 0, foodDecayCum: 0, foodDigestCum: 0, foodRegenCum: 0 },
    };
    if (opts.dye) { for (var d = 0; d < C; d++) st.dye.push(new Float64Array(CELLS)); }
    return st;
  }

  /** ruleSpec を state に取り付け、核のスペクトルを1回だけ作る（毎歩は使い回す）。 */
  function attachRule(state, ruleSpec) {
    state.ruleSpec = ruleSpec;
    state.kernelSpectra = ruleSpec.kernels.map(function (k) { return S69.buildKernelSpectrum(k, ruleSpec.R, N); });
  }

  function fieldArray(state, f) { return f < state.C ? state.A[f] : state.Psi; }

  /** 1歩進める。戻り値は歩の統計（保存則・切り詰め・流れの活動など）。 */
  function stepOnce(state, rng) {
    var C = state.C, buf = state._buf, ker = state.ruleSpec, N2 = CELLS;
    var i, c;
    for (c = 0; c < C; c++) buf.U[c].fill(0);

    if (!state.driveOff) {
      var numFields = C + (state.hasFood ? 1 : 0);
      var fieldHat = [];
      for (var f = 0; f < numFields; f++) {
        var re = Float64Array.from(fieldArray(state, f)), im = new Float64Array(N2);
        S69.fft2d(re, im, N, false);
        fieldHat.push({ re: re, im: im });
      }
      for (var ki = 0; ki < ker.kernels.length; ki++) {
        var k = ker.kernels[ki], spec = state.kernelSpectra[ki];
        if (spec.zeroed) continue;
        var fh = fieldHat[k.c0];
        buf.outre.set(fh.re); buf.outim.set(fh.im);
        S69.complexMulInto(fh.re, fh.im, spec.re, spec.im, buf.outre, buf.outim);
        S69.fft2d(buf.outre, buf.outim, N, true);
        var targetU = buf.U[k.c1];
        if (!state.multiSpecies) {
          var h = ker.h[ki];
          for (i = 0; i < N2; i++) targetU[i] += h * S69.growth(buf.outre[i], k.mu, k.sigma);
        } else {
          var P = state.P, pDim = state.pDim;
          for (i = 0; i < N2; i++) targetU[i] += P[i * pDim + ki] * S69.growth(buf.outre[i], k.mu, k.sigma);
        }
      }
    }

    for (i = 0; i < N2; i++) {
      var s = 0; for (c = 0; c < C; c++) s += state.A[c][i];
      buf.ASigma[i] = s;
    }
    S69.sobel(buf.ASigma, N, buf.gSx, buf.gSy);
    for (c = 0; c < C; c++) S69.sobel(buf.U[c], N, buf.gUx[c], buf.gUy[c]);

    var thetaA = ker.thetaA, nExp = ker.n, dt = ker.dt, sHalf = ker.s, clipMax = 4 - sHalf;
    for (c = 0; c < C; c++) {
      var Fx = buf.Fx[c], Fy = buf.Fy[c], gUx = buf.gUx[c], gUy = buf.gUy[c];
      for (i = 0; i < N2; i++) {
        var alpha = Math.pow(buf.ASigma[i] / thetaA, nExp);
        if (alpha < 0) alpha = 0; else if (alpha > 1) alpha = 1;
        Fx[i] = (1 - alpha) * gUx[i] - alpha * buf.gSx[i];
        Fy[i] = (1 - alpha) * gUy[i] - alpha * buf.gSy[i];
      }
    }

    if (state.multiSpecies) S69.resetIncoming(buf.incoming);
    var clippedTotal = 0, maxDisp = 0;
    var onDistribute = state.multiSpecies
      ? function (srcIdx, dstIdx, weight) { S69.accumulateIncoming(buf.incoming, srcIdx, dstIdx, weight); }
      : null;
    for (c = 0; c < C; c++) {
      var r = S69.transportChannel(state.A[c], buf.Fx[c], buf.Fy[c], N, dt, sHalf, clipMax, buf.Adst[c], onDistribute);
      clippedTotal += r.clippedCount;
      if (r.maxAbsDispBeforeClip > maxDisp) maxDisp = r.maxAbsDispBeforeClip;
      if (state.dye) {
        var dyeDst = new Float64Array(N2);
        S69.transportChannel(state.dye[c], buf.Fx[c], buf.Fy[c], N, dt, sHalf, clipMax, dyeDst, null);
        state.dye[c] = dyeDst;
      }
    }
    for (c = 0; c < C; c++) { var tmp = state.A[c]; state.A[c].set(buf.Adst[c]); void tmp; }

    var incomingOverflow = 0;
    if (state.multiSpecies) {
      incomingOverflow = buf.incoming.overflow;
      if (state.mixMode === 'average') S69.mixAverage(state.P, state.label, buf.incoming, N2, state.pDim, buf.newP, buf.newLabel, buf.vecScratch);
      else S69.mixSoftmax(state.P, state.label, buf.incoming, N2, state.pDim, rng, buf.newP, buf.newLabel);
    }

    var foodStats = null;
    if (state.hasFood) foodStats = stepFood(state, ker, rng);

    var flowActivity = 0, sumAU = 0;
    for (c = 0; c < C; c++) {
      var Ac = state.A[c], Fxc = buf.Fx[c], Fyc = buf.Fy[c], Uc = buf.U[c];
      for (i = 0; i < N2; i++) {
        flowActivity += Ac[i] * (Fxc[i] * Fxc[i] + Fyc[i] * Fyc[i]);
        sumAU += Ac[i] * Uc[i];
      }
    }
    state.cum.clippedTotal += clippedTotal;
    if (maxDisp > state.cum.maxAbsDispBeforeClip) state.cum.maxAbsDispBeforeClip = maxDisp;
    state.t += 1;
    return { clippedCount: clippedTotal, maxAbsDispBeforeClip: maxDisp, flowActivity: flowActivity, sumAU: sumAU, foodStats: foodStats, incomingOverflow: incomingOverflow };
  }

  /**
   * 食物（式11・閉じた台帳）。①分解 ②消化 ③再生。分解した物質は Rsv へ、Rsv から正方を再生する
   * （原典の食物は外から足すだけだが、本件は自前で「閉じた台帳」を足した。criteria.json system.food）。
   */
  function stepFood(state, ker, rng) {
    var N2 = CELLS, C = state.C;
    var rhoDecay = ker.foodParams.rhoDecay, rhoDigest = ker.foodParams.rhoDigest, pFood = ker.foodParams.pFood;
    var decaySum = 0, digestSum = 0;
    var ASigma = state._buf.ASigma; // 直前の値のままでよい(輸送前後で総量は変わらない前提の近似) -> 再計算する
    for (var i = 0; i < N2; i++) {
      var aSigma = 0; for (var c = 0; c < C; c++) aSigma += state.A[c][i];
      if (aSigma <= 0) continue;
      var lost = aSigma * rhoDecay;
      for (c = 0; c < C; c++) state.A[c][i] -= state.A[c][i] * rhoDecay;
      decaySum += lost; state.Rsv += lost;
      var aSigma2 = aSigma - lost;
      var psi = state.Psi[i];
      var d = Math.min(psi, aSigma2 * rhoDigest);
      if (d > 0 && aSigma2 > 0) {
        for (c = 0; c < C; c++) state.A[c][i] += d * (state.A[c][i] / aSigma2);
        state.Psi[i] -= d;
        digestSum += d;
      }
    }
    var regenSum = 0;
    if (rng() < pFood && state.Rsv >= 25) {
      var cx = Math.floor(rng() * N), cy = Math.floor(rng() * N);
      for (var dy = 0; dy < 5; dy++) {
        for (var dx = 0; dx < 5; dx++) {
          var xi = (cx + dx) % N, yi = (cy + dy) % N;
          state.Psi[yi * N + xi] += 1; regenSum += 1;
        }
      }
      state.Rsv -= 25;
    }
    state.cum.foodDecayCum += decaySum; state.cum.foodDigestCum += digestSum; state.cum.foodRegenCum += regenSum;
    return { decay: decaySum, digest: digestSum, regen: regenSum, rsv: state.Rsv };
  }

  function totalMass(A) { var s = 0; for (var i = 0; i < A.length; i++) s += A[i]; return s; }

  /** チャネルごとの総質量。M-food は ΣA+ΣΨ+Rsv も返す。 */
  function massLedger(state) {
    var perChannel = state.A.map(totalMass);
    var out = { perChannel: perChannel };
    if (state.hasFood) out.closedLedger = perChannel.reduce(function (a, b) { return a + b; }, 0) + totalMass(state.Psi) + state.Rsv;
    return out;
  }

  var Engine = {
    N: N, CELLS: CELLS, buildConnectivity: buildConnectivity, drawKernelParams: drawKernelParams,
    sampleRule: sampleRule, countZeroedKernels: countZeroedKernels,
    createState: createState, attachRule: attachRule, stepOnce: stepOnce, massLedger: massLedger, totalMass: totalMass,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Engine;
  if (typeof window !== 'undefined') window.S69Engine = Engine;
})(this);
