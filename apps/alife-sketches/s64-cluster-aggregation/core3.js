/**
 * S-64 reg3（3本目）: 案 Gp（射影つきの Brownian 刻み）の力学。剛体円板（芯 r>=1）・伸び縮みの
 * 幅つきの結合の窓 [1,1+w]・角の窓 θ0±Δθ を、力もエネルギー関数も持たずに、Gauss–Seidel の
 * 射影（対・三つ組ごとに和0の変位で破れを戻す）で守る。criteria-3.json system 節のコード化。
 *
 * run(main・1本目)の core.js・stepBD、run(reg2・2本目)の stepBD2 は一切変更しない——本ファイルは
 * 別ファイル（S1指示・s2-implement.md §1「3本目の力学は別ファイルに分けてよい」）。
 * core.js から createSystem/initReplicate/formBond/ufFind/finalizeUnits/buildCellList/
 * forEachPairWithin/minImageD/wrapPos/subStream/gaussianFactory/wrapAngle/pickNearestDirection/
 * hasNaNCoords/initHash を再利用する（重複実装しない）。
 *
 * 上位概念の語彙は使わない。どの補正も対か「粒子とその結合相手」の三つ組の位置しか読まない
 * （塊のID・大きさは読まない）。Node とブラウザの両方で使う（UMD 風）。依存ゼロ。
 */
'use strict';
(function (root, factory) {
  var api = factory(typeof module === 'object' && module.exports ? require('./core.js') : root.S64);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S64Gp = api;
})(typeof self !== 'undefined' ? self : this, function (S64) {
  // ================================================================ 腕の設定（Gp専用）

  /**
   * hasAngleWindow:true で角の窓（deltaTheta）。frozenIfBonded:true で「種または結合済みは動かない」
   * （NC-DLA3）。bondRequiresFrozenPeer:true で「動く同士は結合しない」。ghost:true で結合は記録の
   * みで拘束を持たない（NC-ghost3。芯だけが全対に掛かる）。formBonds:false は結合を一切作らない
   * （NC-nobond3）。
   */
  var GP_ARM_CONFIG = {
    'M-rigid3': { hasAngleWindow: true, deltaTheta: 0.1, frozenIfBonded: false, formBonds: true, ghost: false, bondRequiresFrozenPeer: false },
    'M-flex3': { hasAngleWindow: false, deltaTheta: 0, frozenIfBonded: false, formBonds: true, ghost: false, bondRequiresFrozenPeer: false },
    'M-stiff3': { hasAngleWindow: true, deltaTheta: 0.03, frozenIfBonded: false, formBonds: true, ghost: false, bondRequiresFrozenPeer: false },
    'NC-DLA3': { hasAngleWindow: false, deltaTheta: 0, frozenIfBonded: true, formBonds: true, ghost: false, bondRequiresFrozenPeer: true, seededFraction: 0.01 },
    'NC-nobond3': { hasAngleWindow: false, deltaTheta: 0, frozenIfBonded: false, formBonds: false, ghost: false, bondRequiresFrozenPeer: false },
    'NC-ghost3': { hasAngleWindow: false, deltaTheta: 0, frozenIfBonded: false, formBonds: true, ghost: true, bondRequiresFrozenPeer: false },
  };
  function armConfigFor3(arm) {
    var c = GP_ARM_CONFIG[arm];
    if (!c) throw new Error('未知の腕(reg3): ' + arm);
    return c;
  }

  var BOND_W = 0.1; // system.constraints (C2): w=0.1（全ての Gp 腕で同じ）
  var PROJ_TOL = 0.01; // system.projection の許容
  var PROJ_MAX_SWEEPS = 200; // system.projection の上限

  function isFrozenGp(sys, cfg, i) {
    if (!cfg.frozenIfBonded) return false;
    if (sys._seedSet && sys._seedSet.has(i)) return true;
    return sys.bondNbrs[i].length > 0;
  }

  function moveParticle(sys, i, dx, dy, state) {
    sys.x[i] = S64.wrapPos(sys.x[i] + dx, sys.L);
    sys.y[i] = S64.wrapPos(sys.y[i] + dy, sys.L);
    sys.ux[i] += dx; sys.uy[i] += dy;
    state.sumCorrX += dx; state.sumCorrY += dy;
    if (state.moved) state.moved.add(i); // controls3.js の単体検査（Set）向け
    if (state.movedFlags && !state.movedFlags[i]) { // stepGp3 の高速経路（型付き配列。次の掃引の作業リストの種）
      state.movedFlags[i] = 1;
      if (state.movedList) state.movedList.push(i);
    }
  }

  /** 対 i-j を距離 desiredR へ戻す（system.projection の「対の補正」）。止まった側は動かさない。 */
  function correctPairToDistance(sys, cfg, i, j, desiredR, state) {
    var dx = S64.minImageD(sys.x[i] - sys.x[j], sys.L), dy = S64.minImageD(sys.y[i] - sys.y[j], sys.L);
    var r = Math.hypot(dx, dy);
    if (r < 1e-12) return 0; // 縮退（実用上は起きない）
    var delta = desiredR - r;
    if (Math.abs(delta) < 1e-15) return 0;
    var ux = dx / r, uy = dy / r;
    var iFz = isFrozenGp(sys, cfg, i), jFz = isFrozenGp(sys, cfg, j);
    if (iFz && jFz) return 0; // 両方止まっている: 相対距離は変えられない（かつ生成時に既に妥当）
    if (iFz) moveParticle(sys, j, -ux * delta, -uy * delta, state);
    else if (jFz) moveParticle(sys, i, ux * delta, uy * delta, state);
    else { moveParticle(sys, i, ux * delta / 2, uy * delta / 2, state); moveParticle(sys, j, -ux * delta / 2, -uy * delta / 2, state); }
    return Math.abs(delta);
  }

  /** 芯（対）: r<1 のときだけ 1 へ戻す。system.constraints (C1)。 */
  function processCorePair(sys, cfg, pair, state) {
    var i = pair[0], j = pair[1];
    var dx = S64.minImageD(sys.x[i] - sys.x[j], sys.L), dy = S64.minImageD(sys.y[i] - sys.y[j], sys.L);
    var r = Math.hypot(dx, dy);
    if (r >= 1) return 0;
    return correctPairToDistance(sys, cfg, i, j, 1, state);
  }

  /** 結合の窓（対）: r<1 なら1へ、r>1+w なら1+wへ。system.constraints (C2)。 */
  function processBondWindow(sys, cfg, bond, state) {
    var i = bond.i, j = bond.j;
    var dx = S64.minImageD(sys.x[i] - sys.x[j], sys.L), dy = S64.minImageD(sys.y[i] - sys.y[j], sys.L);
    var r = Math.hypot(dx, dy);
    if (r < 1) return correctPairToDistance(sys, cfg, i, j, 1, state);
    if (r > 1 + BOND_W) return correctPairToDistance(sys, cfg, i, j, 1 + BOND_W, state);
    return 0;
  }

  /**
   * 角の窓（三つ組）: system.projection の「角の補正」。
   * ∇_bθ=perp(w)/|w|²、∇_aθ=−perp(u)/|u|²、∇_vθ=−(∇_aθ+∇_bθ)（perp(v)=(-vy,vx)）。
   * λ = e / Σ|∇_kθ|²。x_k ← x_k − λ∇_kθ。
   */
  function processAngleWindow(sys, cfg, tri, state) {
    var L = sys.L;
    var ux = S64.minImageD(sys.x[tri.a] - sys.x[tri.v], L), uy = S64.minImageD(sys.y[tri.a] - sys.y[tri.v], L);
    var wx = S64.minImageD(sys.x[tri.b] - sys.x[tri.v], L), wy = S64.minImageD(sys.y[tri.b] - sys.y[tri.v], L);
    var ru2 = ux * ux + uy * uy, rw2 = wx * wx + wy * wy;
    if (ru2 < 1e-18 || rw2 < 1e-18) return 0;
    var theta = Math.atan2(ux * wy - uy * wx, ux * wx + uy * wy);
    var d = S64.wrapAngle(theta - tri.theta0);
    var dTheta = tri.dTheta;
    var e;
    if (d > dTheta) e = d - dTheta;
    else if (d < -dTheta) e = d + dTheta;
    else return 0;
    if (isFrozenGp(sys, cfg, tri.a) || isFrozenGp(sys, cfg, tri.v) || isFrozenGp(sys, cfg, tri.b)) return Math.abs(e); // 登録の腕では起きない（防御的）
    var gax = uy / ru2, gay = -ux / ru2;
    var gbx = -wy / rw2, gby = wx / rw2;
    var gvx = -(gax + gbx), gvy = -(gay + gby);
    var sumSq = gax * gax + gay * gay + gbx * gbx + gby * gby + gvx * gvx + gvy * gvy;
    if (sumSq < 1e-300) return Math.abs(e);
    var lambda = e / sumSq;
    moveParticle(sys, tri.a, -lambda * gax, -lambda * gay, state);
    moveParticle(sys, tri.v, -lambda * gvx, -lambda * gvy, state);
    moveParticle(sys, tri.b, -lambda * gbx, -lambda * gby, state);
    return Math.abs(e);
  }

  /** 結合 i-j の生成の瞬間、j側・i側それぞれに角の窓を1本足す（system.angleWindows）。 */
  function addAngleWindows3(sys, i, j, dTheta) {
    var a = S64.pickNearestDirection(sys, j, i, i);
    if (a >= 0 && a !== i) addAngleWindowTriple(sys, a, j, i, dTheta);
    var b = S64.pickNearestDirection(sys, i, j, j);
    if (b >= 0 && b !== j) addAngleWindowTriple(sys, b, i, j, dTheta);
  }
  function addAngleWindowTriple(sys, a, v, b, dTheta) {
    var ux = S64.minImageD(sys.x[a] - sys.x[v], sys.L), uy = S64.minImageD(sys.y[a] - sys.y[v], sys.L);
    var wx = S64.minImageD(sys.x[b] - sys.x[v], sys.L), wy = S64.minImageD(sys.y[b] - sys.y[v], sys.L);
    var theta0 = Math.atan2(ux * wy - uy * wx, ux * wx + uy * wy);
    sys.angleList.push({ a: a, v: v, b: b, theta0: theta0, dTheta: dTheta });
  }

  /** 粒子 -> その粒子が絡む拘束の添字、の隣接表（作業リストの本体。刻みごとに1回だけ作る）。 */
  function buildAdjacency(n, list, endpoints) {
    var byParticle = new Array(n);
    for (var i = 0; i < n; i++) byParticle[i] = [];
    for (var k = 0; k < list.length; k++) {
      var ep = endpoints(list[k]);
      for (var e2 = 0; e2 < ep.length; e2++) byParticle[ep[e2]].push(k);
    }
    return byParticle;
  }
  function corePairEndpoints(pr) { return pr; }
  function bondEndpoints(bd) { return [bd.i, bd.j]; }
  function angleEndpoints(tr) { return [tr.a, tr.v, tr.b]; }

  /**
   * 1刻み: (1) 全粒子が独立な雑音で動く（frozen は 0） (2) 射影（Gauss–Seidel・作業リスト）
   * (3) 結合の生成。戻り値: { sweeps, residual, capped, maxCoord, nan, centroidIdentity, formedCount }。
   */
  function stepGp3(sys, p, rng, gaussian, cfg) {
    var N = sys.N, dt = p.dt, D0 = p.D0;
    var noiseAmp = Math.sqrt(2 * D0 * dt);
    var state = { sumCorrX: 0, sumCorrY: 0, moved: new Set() };
    var sumAbsXi = 0;
    for (var i = 0; i < N; i++) {
      if (isFrozenGp(sys, cfg, i)) continue;
      var gx = noiseAmp * gaussian(), gy = noiseAmp * gaussian();
      sys.x[i] = S64.wrapPos(sys.x[i] + gx, sys.L);
      sys.y[i] = S64.wrapPos(sys.y[i] + gy, sys.L);
      sys.ux[i] += gx; sys.uy[i] += gy;
      sumAbsXi += Math.hypot(gx, gy);
    }
    sys.step++; sys.t += dt;

    // ---- 射影 ----
    var cl = S64.buildCellList(sys, 1.2);
    var corePairs = [];
    S64.forEachPairWithin(cl, sys, 1.2, function (i, j, dx, dy, r2) {
      if (!cfg.ghost && S64.isBonded(sys, i, j)) return; // 通常: 結合の窓の対は別枠。ghost: 全対を芯で見る
      if (isFrozenGp(sys, cfg, i) && isFrozenGp(sys, cfg, j)) return;
      corePairs.push([i, j]);
    });
    var bondWindowList = [];
    if (!cfg.ghost) {
      for (var bi = 0; bi < sys.bondList.length; bi++) {
        var bd = sys.bondList[bi];
        if (isFrozenGp(sys, cfg, bd.i) && isFrozenGp(sys, cfg, bd.j)) continue;
        bondWindowList.push(bd);
      }
    }
    var angleTriples = cfg.hasAngleWindow ? sys.angleList : [];

    // 作業リストの隣接表（刻みごとに1回だけ）。2回目以降の掃引は、前の掃引で動いた粒子に絡む
    // 拘束の添字だけを隣接表から集めて処理する——O(拘束の全数)ではなく O(動いた粒子の次数の和) になる。
    var byParticleCore = buildAdjacency(N, corePairs, corePairEndpoints);
    var byParticleBond = buildAdjacency(N, bondWindowList, bondEndpoints);
    var byParticleAngle = buildAdjacency(N, angleTriples, angleEndpoints);
    var visitedCore = new Uint8Array(corePairs.length);
    var visitedBond = new Uint8Array(bondWindowList.length);
    var visitedAngle = new Uint8Array(angleTriples.length);

    var sweeps = 0, maxViolLast = 0;
    var totalCorrX = 0, totalCorrY = 0;
    var prevMovedList = null; // null = 最初の掃引（全件を見る）
    while (sweeps < PROJ_MAX_SWEEPS) {
      sweeps++;
      var maxViol = 0;
      var sweepState = { sumCorrX: 0, sumCorrY: 0, movedFlags: new Uint8Array(N), movedList: [] };
      if (prevMovedList === null) {
        for (var c1 = 0; c1 < corePairs.length; c1++) { var v1 = processCorePair(sys, cfg, corePairs[c1], sweepState); if (v1 > maxViol) maxViol = v1; }
        for (var c2 = 0; c2 < bondWindowList.length; c2++) { var v2 = processBondWindow(sys, cfg, bondWindowList[c2], sweepState); if (v2 > maxViol) maxViol = v2; }
        for (var c3 = 0; c3 < angleTriples.length; c3++) { var v3 = processAngleWindow(sys, cfg, angleTriples[c3], sweepState); if (v3 > maxViol) maxViol = v3; }
      } else {
        var touchedCore = [], touchedBond = [], touchedAngle = [];
        for (var m = 0; m < prevMovedList.length; m++) {
          var pidx = prevMovedList[m];
          var lc = byParticleCore[pidx];
          for (var a1 = 0; a1 < lc.length; a1++) { var ci = lc[a1]; if (!visitedCore[ci]) { visitedCore[ci] = 1; touchedCore.push(ci); } }
          var lb = byParticleBond[pidx];
          for (var a2 = 0; a2 < lb.length; a2++) { var bi2 = lb[a2]; if (!visitedBond[bi2]) { visitedBond[bi2] = 1; touchedBond.push(bi2); } }
          var la = byParticleAngle[pidx];
          for (var a3 = 0; a3 < la.length; a3++) { var ai2 = la[a3]; if (!visitedAngle[ai2]) { visitedAngle[ai2] = 1; touchedAngle.push(ai2); } }
        }
        for (var t1 = 0; t1 < touchedCore.length; t1++) { var v1b = processCorePair(sys, cfg, corePairs[touchedCore[t1]], sweepState); if (v1b > maxViol) maxViol = v1b; visitedCore[touchedCore[t1]] = 0; }
        for (var t2 = 0; t2 < touchedBond.length; t2++) { var v2b = processBondWindow(sys, cfg, bondWindowList[touchedBond[t2]], sweepState); if (v2b > maxViol) maxViol = v2b; visitedBond[touchedBond[t2]] = 0; }
        for (var t3 = 0; t3 < touchedAngle.length; t3++) { var v3b = processAngleWindow(sys, cfg, angleTriples[touchedAngle[t3]], sweepState); if (v3b > maxViol) maxViol = v3b; visitedAngle[touchedAngle[t3]] = 0; }
      }
      totalCorrX += sweepState.sumCorrX; totalCorrY += sweepState.sumCorrY;
      maxViolLast = maxViol;
      prevMovedList = sweepState.movedList;
      if (maxViol < PROJ_TOL) break;
    }
    var capped = sweeps >= PROJ_MAX_SWEEPS && maxViolLast >= PROJ_TOL;

    // ---- 結合の生成（射影の後、r<1+w の未結合対を (i<j) 昇順に） ----
    var formed = 0;
    if (cfg.formBonds) {
      var candidates = [];
      S64.forEachPairWithin(cl, sys, 1 + BOND_W, function (i, j, dx, dy, r2) {
        if (S64.isBonded(sys, i, j)) return;
        if (cfg.bondRequiresFrozenPeer) {
          var iFz = isFrozenGp(sys, cfg, i), jFz = isFrozenGp(sys, cfg, j);
          if (iFz === jFz) return; // 動く同士・止まった同士は結合しない
        }
        candidates.push([Math.min(i, j), Math.max(i, j)]);
      });
      candidates.sort(function (A, B) { return A[0] - B[0] || A[1] - B[1]; });
      for (var cc = 0; cc < candidates.length; cc++) {
        var a2 = candidates[cc][0], b2 = candidates[cc][1];
        if (S64.isBonded(sys, a2, b2)) continue;
        var dxn = S64.minImageD(sys.x[a2] - sys.x[b2], sys.L), dyn = S64.minImageD(sys.y[a2] - sys.y[b2], sys.L);
        var rn = Math.hypot(dxn, dyn);
        if (rn >= 1 + BOND_W) continue;
        var res = S64.formBond(sys, a2, b2, rn);
        if (res.formed) { formed++; if (cfg.hasAngleWindow) addAngleWindows3(sys, a2, b2, cfg.deltaTheta); }
      }
    }

    var maxCoord = 0;
    for (var ci2 = 0; ci2 < N; ci2++) if (sys.bondNbrs[ci2].length > maxCoord) maxCoord = sys.bondNbrs[ci2].length;
    var nan = S64.hasNaNCoords(sys);
    var centroidIdentity = null;
    if (!cfg.frozenIfBonded && sumAbsXi > 1e-300) centroidIdentity = Math.hypot(totalCorrX, totalCorrY) / sumAbsXi;

    return { sweeps: sweeps, residual: maxViolLast, capped: capped, maxCoord: maxCoord, nan: nan, centroidIdentity: centroidIdentity, formedCount: formed };
  }

  return {
    GP_ARM_CONFIG: GP_ARM_CONFIG, armConfigFor3: armConfigFor3, BOND_W: BOND_W, PROJ_TOL: PROJ_TOL, PROJ_MAX_SWEEPS: PROJ_MAX_SWEEPS,
    isFrozenGp: isFrozenGp, correctPairToDistance: correctPairToDistance,
    processCorePair: processCorePair, processBondWindow: processBondWindow, processAngleWindow: processAngleWindow,
    addAngleWindows3: addAngleWindows3, addAngleWindowTriple: addAngleWindowTriple,
    stepGp3: stepGp3,
  };
});
