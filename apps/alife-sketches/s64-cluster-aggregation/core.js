/**
 * S-64 の核。2次元周期箱の円板 N 個。粒子ごとに独立な過減衰 Langevin（熱浴つき）で拡散し、
 * 接触（r<1σ）で切れない結合を作る。結合は上位の単位（塊・所属表）を読まない規則で、
 * 塊の階層は検出器の側（detectors.js）が結合の生成の記録と位置から作る。
 *
 * 腕:
 *   M-rigid / M-flex … 粒子ごとの独立な力学（本ファイルの stepBD）
 *   NC-DLA / NC-nobond / NC-ghost … stepBD の設定（armConfig）だけが違う変種
 *   R0 / R-0.7 / R-1 / R-1rot … 塊を剛体として動かす※参照（本ファイルの stepKMC）
 *
 * criteria.json system 節のコード化。上位概念の語彙（cluster/organism 等）は識別子や分岐に
 * 使わない——塊の所属表を「物理の力学」が読むのは R 腕（※参照）だけで、そこは criteria.json が
 * 明示的に※と認めた腕である。M/NC の力学（本ファイルの stepBD）は粒子の位置・結合の相手だけを読む。
 *
 * Node とブラウザの両方で使う（UMD 風）。ESM にしない。依存ゼロ。
 */
'use strict';
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S64 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  // ── 単位: σ=1, kT=1, D0=1, μ=D0/kT=1, τ_B=σ²/D0=1 ──────────────────────

  // ================================================================ 乱数

  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function hash32(a, b) {
    var h = (a ^ 0x9e3779b9) >>> 0;
    h = Math.imul(h ^ b, 0x85ebca6b) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
    return (h ^ (h >>> 16)) >>> 0;
  }
  /** streamId: 0=位置,1=雑音,2=R腕の選択/向き,3=PC/合成の構造,4=ブートストラップ,5=参照の合体木 … */
  function subStream(seed, streamId) { return makeRng(hash32(seed >>> 0, streamId >>> 0)); }

  function gaussianFactory(rng) {
    var spare = null;
    return function gaussian() {
      if (spare !== null) { var v = spare; spare = null; return v; }
      var u, v2, s2;
      do { u = 2 * rng() - 1; v2 = 2 * rng() - 1; s2 = u * u + v2 * v2; } while (s2 >= 1 || s2 === 0);
      var mul = Math.sqrt(-2 * Math.log(s2) / s2);
      spare = v2 * mul;
      return u * mul;
    };
  }

  // ================================================================ 幾何

  function wrapPos(v, L) { v = v % L; if (v < 0) v += L; return v; }
  function minImageD(dx, L) { var h = L / 2; if (dx > h) dx -= L; else if (dx < -h) dx += L; return dx; }
  function wrapAll(sys) { for (var i = 0; i < sys.N; i++) { sys.x[i] = wrapPos(sys.x[i], sys.L); sys.y[i] = wrapPos(sys.y[i], sys.L); } }

  /** 最小間隔 minGap の逐次付加（周期境界・セル表で近傍探索）。 */
  function randomSequentialFill(N, L, minGap, rng) {
    var x = new Float64Array(N), y = new Float64Array(N);
    var cellSize = Math.max(minGap, 0.5);
    var nc = Math.max(1, Math.floor(L / cellSize));
    var w = L / nc;
    function cellOf(v) { return Math.min(nc - 1, Math.floor(wrapPos(v, L) / w)); }
    var buckets = new Map();
    function key(ci, cj) { return ci * nc + cj; }
    var fellBack = false;
    for (var n = 0; n < N; n++) {
      var placed = false;
      for (var attempt = 0; attempt < 4000 && !placed; attempt++) {
        var px = rng() * L, py = rng() * L;
        var ci = cellOf(px), cj = cellOf(py), ok = true;
        outer:
        for (var di = -1; di <= 1 && ok; di++) {
          for (var dj = -1; dj <= 1; dj++) {
            var kk = key(((ci + di) % nc + nc) % nc, ((cj + dj) % nc + nc) % nc);
            var list = buckets.get(kk);
            if (!list) continue;
            for (var a = 0; a < list.length; a++) {
              var idx = list[a];
              var dx = minImageD(px - x[idx], L), dy = minImageD(py - y[idx], L);
              if (Math.hypot(dx, dy) < minGap) { ok = false; break outer; }
            }
          }
        }
        if (ok) {
          x[n] = px; y[n] = py;
          var kk2 = key(ci, cj);
          if (!buckets.has(kk2)) buckets.set(kk2, []);
          buckets.get(kk2).push(n);
          placed = true;
        }
      }
      if (!placed) { x[n] = rng() * L; y[n] = rng() * L; fellBack = true; }
    }
    return { x: x, y: y, fellBack: fellBack };
  }

  // ================================================================ セル表

  function buildCellList(sys, cellSize) {
    var L = sys.L, nc = Math.max(3, Math.floor(L / cellSize)), w = L / nc;
    var buckets = new Array(nc * nc);
    for (var k = 0; k < buckets.length; k++) buckets[k] = [];
    function cellOf(v) { return Math.min(nc - 1, Math.floor(wrapPos(v, L) / w)); }
    for (var i = 0; i < sys.N; i++) buckets[cellOf(sys.x[i]) * nc + cellOf(sys.y[i])].push(i);
    return { nc: nc, w: w, buckets: buckets, cellOf: cellOf };
  }
  function forEachPairWithin(cl, sys, rMax, cb) {
    var nc = cl.nc, L = sys.L, halfL = L / 2, rMax2 = rMax * rMax;
    for (var ci = 0; ci < nc; ci++) {
      for (var cj = 0; cj < nc; cj++) {
        var here = cl.buckets[ci * nc + cj];
        for (var di = 0; di <= 1; di++) {
          for (var dj = (di === 0 ? 0 : -1); dj <= 1; dj++) {
            var oci = ((ci + di) % nc + nc) % nc, ocj = ((cj + dj) % nc + nc) % nc;
            if (di === 0 && dj === 0 && !(oci === ci && ocj === cj)) continue;
            var other = cl.buckets[oci * nc + ocj];
            for (var a = 0; a < here.length; a++) {
              var startB = (oci === ci && ocj === cj) ? a + 1 : 0;
              for (var b = startB; b < other.length; b++) {
                var i = here[a], j = other[b];
                if (i === j) continue;
                var dx = sys.x[i] - sys.x[j], dy = sys.y[i] - sys.y[j];
                if (dx > halfL) dx -= L; else if (dx < -halfL) dx += L;
                if (dy > halfL) dy -= L; else if (dy < -halfL) dy += L;
                var r2 = dx * dx + dy * dy;
                if (r2 < rMax2) cb(i, j, dx, dy, r2);
              }
            }
          }
        }
      }
    }
  }
  /** 粒子 i の rMax 以内の近傍 [[j,dx,dy,r],...]（最小像）。呼び出し頻度は低い想定。 */
  function neighborsWithin(cl, sys, i, rMax) {
    var out = [], L = sys.L, nc = cl.nc;
    var ci = cl.cellOf(sys.x[i]), cj = cl.cellOf(sys.y[i]);
    for (var di = -1; di <= 1; di++) {
      for (var dj = -1; dj <= 1; dj++) {
        var oci = ((ci + di) % nc + nc) % nc, ocj = ((cj + dj) % nc + nc) % nc;
        var bucket = cl.buckets[oci * nc + ocj];
        for (var a = 0; a < bucket.length; a++) {
          var j = bucket[a];
          if (j === i) continue;
          var dx = minImageD(sys.x[i] - sys.x[j], L), dy = minImageD(sys.y[i] - sys.y[j], L);
          var r = Math.hypot(dx, dy);
          if (r < rMax) out.push([j, dx, dy, r]);
        }
      }
    }
    return out;
  }

  // ================================================================ パラメータ

  function defaultParams(overrides) {
    var p = {
      N: 2048, phi: 0.10, L: 0, // L は phi から自動で決める（0 のままなら computeL）
      dt: 0.003, D0: 1, kT: 1, mu: 1,
      kc: 25, kb: 25, klock: 25, ktheta: 10, // ktheta: reg2 の角のばね（F3）の剛さ。run(main)は使わない
      rOn: 1.0, rCore: 1.0, minGap: 1.1,
      seed: 6401,
      arm: 'M-rigid', // 'M-rigid'|'M-flex'|'NC-DLA'|'NC-nobond'|'NC-ghost'|(reg2)'M-rigid2'|'M-flex2'|'M-stiff'|'NC-DLA2'
    };
    var out = {};
    for (var k in p) out[k] = p[k];
    if (overrides) for (var k2 in overrides) out[k2] = overrides[k2];
    // reg2 M-stiff: 全ての剛さを4倍・dtを1/4（μ·k·dtを保つ）。呼び出し側が明示指定していれば尊重する。
    if (out.arm === 'M-stiff') {
      if (!overrides || overrides.kb == null) out.kb = 100;
      if (!overrides || overrides.kc == null) out.kc = 100;
      if (!overrides || overrides.ktheta == null) out.ktheta = 40;
      if (!overrides || overrides.dt == null) out.dt = 0.00075;
    }
    if (!out.L) out.L = computeL(out.N, out.phi);
    return out;
  }
  /** L = sqrt(N*pi/(4*phi))（円板の面積分率 phi = N*pi*(sigma/2)^2 / L^2、sigma=1）。 */
  function computeL(N, phi) { return Math.sqrt(N * Math.PI / (4 * phi)); }

  /**
   * 腕ごとの力学の設定。M-rigid/M-flex/NC-DLA/NC-nobond/NC-ghost は run(main・1本目)が使う——
   * 挙動を変えないこと（selftestがハッシュで検査する）。M-rigid2/M-flex2/M-stiff/NC-DLA2 は
   * run(reg2・2本目)専用の新しい力学（F1:結合の自然長=直径・F2:結合した対にも芯を残す・
   * F3:角のばね）。bondL0Mode:'sigma' で l0=σ 固定（F1）、coreOnBonded:true で結合済みの対にも
   * 芯を掛ける（F2）、hasAngleSprings:true で3体の角のばね（F3。stepBD2 だけが対応）。
   */
  var ARM_CONFIG = {
    'M-rigid': { bondsHaveForce: true, hasLockSprings: true, frozenIfBonded: false, formBonds: true },
    'M-flex': { bondsHaveForce: true, hasLockSprings: false, frozenIfBonded: false, formBonds: true },
    'NC-DLA': { bondsHaveForce: true, hasLockSprings: true, frozenIfBonded: true, formBonds: true },
    'NC-nobond': { bondsHaveForce: false, hasLockSprings: false, frozenIfBonded: false, formBonds: false },
    'NC-ghost': { bondsHaveForce: false, hasLockSprings: false, frozenIfBonded: false, formBonds: true },
    // ── reg2（2本目）専用。stepBD2 でだけ使う ──────────────────────────
    'M-rigid2': { bondsHaveForce: true, hasLockSprings: false, hasAngleSprings: true, coreOnBonded: true, bondL0Mode: 'sigma', frozenIfBonded: false, formBonds: true },
    'M-flex2': { bondsHaveForce: true, hasLockSprings: false, hasAngleSprings: false, coreOnBonded: true, bondL0Mode: 'sigma', frozenIfBonded: false, formBonds: true },
    'M-stiff': { bondsHaveForce: true, hasLockSprings: false, hasAngleSprings: true, coreOnBonded: true, bondL0Mode: 'sigma', frozenIfBonded: false, formBonds: true },
    'NC-DLA2': { bondsHaveForce: true, hasLockSprings: false, hasAngleSprings: false, coreOnBonded: true, bondL0Mode: 'sigma', frozenIfBonded: true, formBonds: true, seededFraction: 0.01, bondRequiresFrozenPeer: true },
  };
  function armConfigFor(arm) {
    var c = ARM_CONFIG[arm];
    if (!c) throw new Error('未知の腕: ' + arm);
    return c;
  }

  // ================================================================ 系（状態）

  function createSystem(N, L) {
    return {
      N: N, L: L, t: 0, step: 0,
      x: new Float64Array(N), y: new Float64Array(N),
      ux: new Float64Array(N), uy: new Float64Array(N), // 巻き戻さない座標（雑駁な累積変位）
      // 結合（切れない）: bondNbrs[i] = [j,...]、bondList = [{i,j,l0,step,t}]（生成順）
      bondNbrs: Array.from({ length: N }, function () { return []; }),
      bondL0: Array.from({ length: N }, function () { return new Map(); }), // j -> l0
      bondList: [],
      // 角を固めるばね（M-rigid/NC-DLA のみ）。結合ではない（観測器のグラフに入らない）。
      lockNbrs: Array.from({ length: N }, function () { return []; }),
      lockL0: Array.from({ length: N }, function () { return new Map(); }),
      lockList: [],
      // reg2（F3）: 3体の角のばね（bond-bending）。{a,v,b,theta0}。結合ではない（観測器のグラフに入らない）。
      angleList: [],
      // 結合の連結成分（union-find）。particle 単位。root だけが有効な size/degree/unitId を持つ。
      ufParent: (function () { var a = new Int32Array(N); for (var i = 0; i < N; i++) a[i] = i; return a; })(),
      ufSize: (function () { var a = new Int32Array(N); a.fill(1); return a; })(),
      ufDegree: new Int32Array(N), // 0 = 単粒子
      componentCount: N,
      // 塊の現在のメンバー一覧（root -> Array<idx>）。小さい方を大きい方へ併合（small-to-large）。
      compMembers: (function () { var m = new Map(); for (var i = 0; i < N; i++) m.set(i, [i]); return m; })(),
      // 検出器G: 流れ（unit）の台帳。rootUnit[root] = 現在アクティブな unit id
      rootUnit: (function () { var a = new Int32Array(N); for (var i = 0; i < N; i++) a[i] = i; return a; })(),
      units: (function () {
        var m = new Map();
        for (var i = 0; i < N; i++) m.set(i, { id: i, degree: 0, startStep: 0, startT: 0, m: 1, parts: [], active: true, _startCentroid: [0, 0] });
        return m;
      })(),
      nextUnitId: N,
      sampleRng: null, // initReplicate が subStream(seed,9) を割り当てる（H-strict の対の標本用）
      finishedUnits: [],
      mergeLog: [], // {step,t,i,j,sizeA,sizeB,degA,degB,newDegree,type:'merge'|'cycle',multi}
      // 台帳（記録のみ）
      U: 0, Qbath: 0, QbathC: 0, // Kahan
      QSek: 0, QSekC: 0, Einj: 0, EinjC: 0, // reg2: Sekimotoの台形則の熱・結合生成の瞬間の注入エネルギー（Kahan）
      sigmaFmax: 0, // |ΣF|/Σ|F| の走行内最大
      tauFmax: 0, // reg2: |Σr×F|/Σ|r||F| の走行内最大
      cycleCount: 0,
      maxBondStretch: 0,
      // マイクロ観測（動きやすさ用）: 各粒子が現在の結合の組を持ってからの経過時間・開始位置
      lastTopoChangeStep: new Int32Array(N),
      _f: null,
    };
  }

  function kahanAdd(state, key, v) {
    var c = key + 'C';
    var y = v - state[c], t = state[key] + y;
    state[c] = (t - state[key]) - y; state[key] = t;
  }

  // ================================================================ Union-Find + 検出器G の台帳

  /** unit を finalize するときに、メンバーのスナップショットと H-strict 用の対の標本を残す。 */
  function snapshotUnit(sys, u, memberArr) {
    u.memberSnapshot = memberArr.slice();
    var m2 = u.memberSnapshot.length;
    var cx = 0, cy = 0, k;
    for (k = 0; k < m2; k++) { cx += sys.ux[u.memberSnapshot[k]]; cy += sys.uy[u.memberSnapshot[k]]; }
    u._endCentroid = m2 ? [cx / m2, cy / m2] : [0, 0];
    if (m2 >= 8 && sys.sampleRng) {
      var pairs = [], seen = new Set(), guard = 0, maxPairs = Math.min(500, Math.floor(m2 * (m2 - 1) / 2));
      while (pairs.length < maxPairs && guard < maxPairs * 25) {
        guard++;
        var a2 = u.memberSnapshot[Math.floor(sys.sampleRng() * m2)], b2 = u.memberSnapshot[Math.floor(sys.sampleRng() * m2)];
        if (a2 === b2) continue;
        var key2 = Math.min(a2, b2) + '_' + Math.max(a2, b2);
        if (seen.has(key2)) continue;
        seen.add(key2);
        var dxp = minImageD(sys.x[a2] - sys.x[b2], sys.L), dyp = minImageD(sys.y[a2] - sys.y[b2], sys.L);
        pairs.push([a2, b2, Math.hypot(dxp, dyp)]);
      }
      u._samplePairs = pairs;
    }
  }

  function ufFind(sys, i) {
    var root = i;
    while (sys.ufParent[root] !== root) root = sys.ufParent[root];
    while (sys.ufParent[i] !== root) { var next = sys.ufParent[i]; sys.ufParent[i] = root; i = next; }
    return root;
  }

  /**
   * 結合 i-j を生成する（重複は無視）。union-find を更新し、検出器Gの流れ（unit）台帳を進める。
   * armForBonds が false（NC-nobond）なら呼ばれない前提。戻り値: {formed, cycle, merge}。
   */
  function formBond(sys, i, j, l0) {
    if (i === j) return { formed: false };
    if (sys.bondL0[i].has(j)) return { formed: false }; // 既に結合
    sys.bondNbrs[i].push(j); sys.bondNbrs[j].push(i);
    sys.bondL0[i].set(j, l0); sys.bondL0[j].set(i, l0);
    sys.bondList.push({ i: i, j: j, l0: l0, step: sys.step, t: sys.t });
    sys.lastTopoChangeStep[i] = sys.step; sys.lastTopoChangeStep[j] = sys.step;

    var ra = ufFind(sys, i), rb = ufFind(sys, j);
    if (ra === rb) {
      sys.cycleCount++;
      var unitSame = sys.units.get(sys.rootUnit[ra]);
      sys.mergeLog.push({ step: sys.step, t: sys.t, i: i, j: j, sizeA: sys.ufSize[ra], sizeB: sys.ufSize[ra], degA: sys.ufDegree[ra], degB: sys.ufDegree[ra], newDegree: sys.ufDegree[ra], type: 'cycle' });
      return { formed: true, cycle: true, merge: false };
    }
    var da = sys.ufDegree[ra], db = sys.ufDegree[rb];
    var newDegree = da === db ? da + 1 : Math.max(da, db);
    var unitA = sys.units.get(sys.rootUnit[ra]), unitB = sys.units.get(sys.rootUnit[rb]);
    // union 前の独立コピー（union-by-size で drop 側の compMembers エントリが消えるため、先に確保する）
    var membersOfA = sys.compMembers.get(ra).slice(), membersOfB = sys.compMembers.get(rb).slice();

    // union by size(small-to-large): 小さい方の compMembers を大きい方へ push
    var keep = sys.ufSize[ra] >= sys.ufSize[rb] ? ra : rb;
    var drop = keep === ra ? rb : ra;
    var keepMembers = sys.compMembers.get(keep), dropMembers = sys.compMembers.get(drop);
    for (var m = 0; m < dropMembers.length; m++) keepMembers.push(dropMembers[m]);
    sys.compMembers.delete(drop);
    sys.ufParent[drop] = keep;
    sys.ufSize[keep] = sys.ufSize[ra] + sys.ufSize[rb];
    sys.ufDegree[keep] = newDegree;

    var winnerUnit, loserUnit, newUnitId;
    if (da === db) {
      unitA.active = false; unitA.endStep = sys.step; unitA.endT = sys.t; unitA.endReason = 'absorbed-equal';
      unitB.active = false; unitB.endStep = sys.step; unitB.endT = sys.t; unitB.endReason = 'absorbed-equal';
      snapshotUnit(sys, unitA, membersOfA); snapshotUnit(sys, unitB, membersOfB);
      sys.finishedUnits.push(unitA); sys.finishedUnits.push(unitB);
      newUnitId = sys.nextUnitId++;
      var newCx = 0, newCy = 0, allMembersNow = keepMembers; // union 後（keepMembers は push 済み）
      for (var nm = 0; nm < allMembersNow.length; nm++) { newCx += sys.ux[allMembersNow[nm]]; newCy += sys.uy[allMembersNow[nm]]; }
      var newUnit = { id: newUnitId, degree: newDegree, startStep: sys.step, startT: sys.t, m: unitA.m + unitB.m, parts: [unitA.id, unitB.id], active: true, _startCentroid: [newCx / allMembersNow.length, newCy / allMembersNow.length] };
      sys.units.set(newUnitId, newUnit);
      sys.rootUnit[keep] = newUnitId;
    } else {
      winnerUnit = da > db ? unitA : unitB;
      loserUnit = da > db ? unitB : unitA;
      var loserMembers = da > db ? membersOfB : membersOfA;
      loserUnit.active = false; loserUnit.endStep = sys.step; loserUnit.endT = sys.t; loserUnit.endReason = 'absorbed-lower';
      snapshotUnit(sys, loserUnit, loserMembers);
      sys.finishedUnits.push(loserUnit);
      winnerUnit.m += loserUnit.m;
      winnerUnit.parts.push(loserUnit.id);
      sys.rootUnit[keep] = winnerUnit.id;
    }
    sys.componentCount--;
    sys.mergeLog.push({ step: sys.step, t: sys.t, i: i, j: j, sizeA: sys.ufSize[ra] || 1, sizeB: sys.ufSize[rb] || 1, degA: da, degB: db, newDegree: newDegree, type: 'merge' });
    return { formed: true, cycle: false, merge: true };
  }

  /** 走行の終わりに残っているアクティブな unit をすべて finalize（打ち切りの印）。 */
  function finalizeUnits(sys) {
    var membersByUnitId = new Map();
    sys.compMembers.forEach(function (members, root) { membersByUnitId.set(sys.rootUnit[root], members); });
    sys.units.forEach(function (u) {
      if (u.active) {
        u.active = false; u.endStep = sys.step; u.endT = sys.t; u.endReason = 'truncated';
        snapshotUnit(sys, u, membersByUnitId.get(u.id) || []);
        sys.finishedUnits.push(u);
      }
    });
  }

  // ================================================================ 力（core/bond/lock）

  /** 芯: r<rCore のみ。U=(kc/2)(1-r)^2, F=kc(1-r)（引き離す向き）。 */
  function coreVF(r, kc) { if (r >= 1) return { V: 0, F: 0 }; var d = 1 - r; return { V: 0.5 * kc * d * d, F: kc * d }; }
  /**
   * 結合/ロックのばね: U=(k/2)(r-l0)^2、力は −k(1−ℓ0/r)·r_ij の形（l0=0でも定義される）。
   * F はここでは r 方向のスカラー(=-dV/dr=-k(r-l0))。呼び出し側で (F/r)*r_ij ベクトルにする
   * ——これで F_vector = -k(r-l0)/r * r_ij = -k(1-l0/r)*r_ij と一致する。
   */
  function springVF(r, l0, k) { var d = r - l0; return { V: 0.5 * k * d * d, F: -k * d }; }

  function numericSpringF(r, l0, k, h) { h = h || 1e-6 * Math.max(r, 1); return -(springVF(r + h, l0, k).V - springVF(r - h, l0, k).V) / (2 * h); }
  function numericCoreF(r, kc, h) { h = h || 1e-6; return -(coreVF(r + h, kc).V - coreVF(r - h, kc).V) / (2 * h); }

  function isBonded(sys, i, j) { return sys.bondL0[i].has(j); }
  function isLocked(sys, i, j) { return sys.lockL0[i].has(j); }

  /**
   * 全力・U・ΣF の計算。cfg = armConfigFor(arm)。cl を渡せば再構築しない。
   * cfg.bondsHaveForce=false（NC-ghost）のとき、結合済みの対にも芯を掛ける（結合はばねを持たない）。
   * cfg.coreOnBonded=true（reg2・F2）のとき、bondsHaveForceでも結合済みの対から芯を外さない
   * （結合のばねに「足す」復元力になる）。
   */
  function computeForces(sys, p, cfg, cl) {
    var N = sys.N;
    var fx = new Float64Array(N), fy = new Float64Array(N);
    var U = 0;
    // reg2のΣr×F検査用（run1は読まない・追加のみ）。対・三つ組ごとに「その相互作用に実際に使った
    // 相対ベクトル」で局所トルクを足す——中心力(core/bond/lock)は対ごとに構成上ちょうど0
    // （dx*fyp-dy*fxp=fr*(dx*dy-dy*dx)=0）、角のばねも頂点まわりで構成上ちょうど0（addAngleForceEnergy
    // が返す）。周期境界の「巻き戻さない絶対座標」に頼らないので像のまたぎに影響されない。
    var tau = 0, absRF = 0;
    if (!cl) cl = buildCellList(sys, p.rCore);
    forEachPairWithin(cl, sys, p.rCore, function (i, j, dx, dy, r2) {
      var bonded = isBonded(sys, i, j);
      if (bonded && cfg.bondsHaveForce && !cfg.coreOnBonded) return; // core はばねに置き換わる（run1）
      var r = Math.sqrt(r2);
      var vf = coreVF(r, p.kc);
      U += vf.V;
      var fr = vf.F / r, fxp = fr * dx, fyp = fr * dy;
      fx[i] += fxp; fy[i] += fyp; fx[j] -= fxp; fy[j] -= fyp;
      tau += dx * fyp - dy * fxp; absRF += Math.hypot(dx, dy) * Math.hypot(fxp, fyp);
    });
    // 結合ばね
    if (cfg.bondsHaveForce) {
      for (var b = 0; b < sys.bondList.length; b++) {
        var bd = sys.bondList[b];
        var dx = minImageD(sys.x[bd.i] - sys.x[bd.j], sys.L), dy = minImageD(sys.y[bd.i] - sys.y[bd.j], sys.L);
        var r = Math.hypot(dx, dy) || 1e-12;
        var vf = springVF(r, bd.l0, p.kb);
        U += vf.V;
        if (r > sys.maxBondStretch) sys.maxBondStretch = r;
        var fr = vf.F / r, fxp = fr * dx, fyp = fr * dy;
        fx[bd.i] += fxp; fy[bd.i] += fyp; fx[bd.j] -= fxp; fy[bd.j] -= fyp;
        tau += dx * fyp - dy * fxp; absRF += Math.hypot(dx, dy) * Math.hypot(fxp, fyp);
      }
    }
    // 角を固めるばね（run1・M-rigid/NC-DLA）
    if (cfg.hasLockSprings) {
      for (var l = 0; l < sys.lockList.length; l++) {
        var ld = sys.lockList[l];
        var dx2 = minImageD(sys.x[ld.i] - sys.x[ld.j], sys.L), dy2 = minImageD(sys.y[ld.i] - sys.y[ld.j], sys.L);
        var r3 = Math.hypot(dx2, dy2) || 1e-12;
        var vf2 = springVF(r3, ld.l0, p.klock);
        U += vf2.V;
        var fr2 = vf2.F / r3, fxp2 = fr2 * dx2, fyp2 = fr2 * dy2;
        fx[ld.i] += fxp2; fy[ld.i] += fyp2; fx[ld.j] -= fxp2; fy[ld.j] -= fyp2;
        tau += dx2 * fyp2 - dy2 * fxp2; absRF += Math.hypot(dx2, dy2) * Math.hypot(fxp2, fyp2);
      }
    }
    // 3体の角のばね（reg2・F3。bond-bendingの曲げエネルギー）
    if (cfg.hasAngleSprings) {
      for (var m = 0; m < sys.angleList.length; m++) {
        var ae = addAngleForceEnergy(sys, sys.angleList[m], p.ktheta, fx, fy);
        U += ae.V; tau += ae.tau; absRF += ae.absRF;
      }
    }
    return { fx: fx, fy: fy, U: U, cellList: cl, tau: tau, absRF: absRF };
  }

  /** 遅いが素直な全対探索（近道の検算の参照実装）。 */
  function computeForcesReference(sys, p, cfg) {
    var N = sys.N, L = sys.L;
    var fx = new Float64Array(N), fy = new Float64Array(N);
    var U = 0, tau = 0, absRF = 0;
    for (var i = 0; i < N; i++) {
      for (var j = i + 1; j < N; j++) {
        var dx = minImageD(sys.x[i] - sys.x[j], L), dy = minImageD(sys.y[i] - sys.y[j], L);
        var r2 = dx * dx + dy * dy;
        if (r2 >= p.rCore * p.rCore) continue;
        var bonded = isBonded(sys, i, j);
        if (bonded && cfg.bondsHaveForce && !cfg.coreOnBonded) continue;
        var r = Math.sqrt(r2);
        var vf = coreVF(r, p.kc);
        U += vf.V;
        var fr = vf.F / r, fxp = fr * dx, fyp = fr * dy;
        fx[i] += fxp; fy[i] += fyp; fx[j] -= fxp; fy[j] -= fyp;
        tau += dx * fyp - dy * fxp; absRF += Math.hypot(dx, dy) * Math.hypot(fxp, fyp);
      }
    }
    if (cfg.bondsHaveForce) {
      for (var b = 0; b < sys.bondList.length; b++) {
        var bd = sys.bondList[b];
        var dxb = minImageD(sys.x[bd.i] - sys.x[bd.j], L), dyb = minImageD(sys.y[bd.i] - sys.y[bd.j], L);
        var rb = Math.hypot(dxb, dyb) || 1e-12;
        var vfb = springVF(rb, bd.l0, p.kb);
        U += vfb.V;
        var frb = vfb.F / rb, fxpb = frb * dxb, fypb = frb * dyb;
        fx[bd.i] += fxpb; fy[bd.i] += fypb; fx[bd.j] -= fxpb; fy[bd.j] -= fypb;
        tau += dxb * fypb - dyb * fxpb; absRF += Math.hypot(dxb, dyb) * Math.hypot(fxpb, fypb);
      }
    }
    if (cfg.hasLockSprings) {
      for (var l = 0; l < sys.lockList.length; l++) {
        var ld = sys.lockList[l];
        var dxl = minImageD(sys.x[ld.i] - sys.x[ld.j], L), dyl = minImageD(sys.y[ld.i] - sys.y[ld.j], L);
        var rl = Math.hypot(dxl, dyl) || 1e-12;
        var vfl = springVF(rl, ld.l0, p.klock);
        U += vfl.V;
        var frl = vfl.F / rl, fxpl = frl * dxl, fypl = frl * dyl;
        fx[ld.i] += fxpl; fy[ld.i] += fypl; fx[ld.j] -= fxpl; fy[ld.j] -= fypl;
        tau += dxl * fypl - dyl * fxpl; absRF += Math.hypot(dxl, dyl) * Math.hypot(fxpl, fypl);
      }
    }
    if (cfg.hasAngleSprings) {
      for (var m = 0; m < sys.angleList.length; m++) {
        var ae = addAngleForceEnergy(sys, sys.angleList[m], p.ktheta, fx, fy);
        U += ae.V; tau += ae.tau; absRF += ae.absRF;
      }
    }
    return { fx: fx, fy: fy, U: U, tau: tau, absRF: absRF };
  }

  // ================================================================ 角を固めるばね（M-rigid/NC-DLA）

  /** 結合 i-j の生成の瞬間、j の他の結合相手のうち角が90°に最も近い k を選び i-k にばねを足す（対称にi側も）。 */
  function addLockSprings(sys, i, j) {
    function pick(center, other, exclude) {
      var nbrs = sys.bondNbrs[center];
      var best = -1, bestErr = Infinity;
      var dOx = minImageD(sys.x[other] - sys.x[center], sys.L), dOy = minImageD(sys.y[other] - sys.y[center], sys.L);
      var angO = Math.atan2(dOy, dOx);
      for (var a = 0; a < nbrs.length; a++) {
        var k = nbrs[a];
        if (k === exclude) continue;
        var dkx = minImageD(sys.x[k] - sys.x[center], sys.L), dky = minImageD(sys.y[k] - sys.y[center], sys.L);
        var angK = Math.atan2(dky, dkx);
        var diff = Math.abs(angK - angO);
        if (diff > Math.PI) diff = 2 * Math.PI - diff;
        var err = Math.abs(diff - Math.PI / 2);
        if (err < bestErr - 1e-12 || (Math.abs(err - bestErr) <= 1e-12 && (best === -1 || k < best))) { bestErr = err; best = k; }
      }
      return best;
    }
    // j の（i を除く）結合相手 k を選び i-k にロック
    var k = pick(j, i, i);
    if (k >= 0 && k !== i && !isBonded(sys, i, k) && !isLocked(sys, i, k)) addLock(sys, i, k);
    var l = pick(i, j, j);
    if (l >= 0 && l !== j && !isBonded(sys, j, l) && !isLocked(sys, j, l)) addLock(sys, j, l);
  }
  function addLock(sys, i, j) {
    var dx = minImageD(sys.x[i] - sys.x[j], sys.L), dy = minImageD(sys.y[i] - sys.y[j], sys.L);
    var r = Math.hypot(dx, dy);
    sys.lockNbrs[i].push(j); sys.lockNbrs[j].push(i);
    sys.lockL0[i].set(j, r); sys.lockL0[j].set(i, r);
    sys.lockList.push({ i: i, j: j, l0: r });
  }

  // ================================================================ 3体の角のばね（reg2・F3・bond-bending）

  /** x を (-π, π] へ包む。 */
  function wrapAngle(x) {
    x = x % (2 * Math.PI);
    if (x <= -Math.PI) x += 2 * Math.PI;
    if (x > Math.PI) x -= 2 * Math.PI;
    return x;
  }

  /**
   * 角 center から見て、方向 dirTo（center→dirToの向き）に最も近い既存の結合相手 k
   * （exclude を除く）を選ぶ。無ければ -1。同点は k の番号の小さいほう。
   */
  function pickNearestDirection(sys, center, dirTo, exclude) {
    var dOx = minImageD(sys.x[dirTo] - sys.x[center], sys.L), dOy = minImageD(sys.y[dirTo] - sys.y[center], sys.L);
    var angO = Math.atan2(dOy, dOx);
    var nbrs = sys.bondNbrs[center];
    var best = -1, bestErr = Infinity;
    for (var a = 0; a < nbrs.length; a++) {
      var k = nbrs[a];
      if (k === exclude) continue;
      var dkx = minImageD(sys.x[k] - sys.x[center], sys.L), dky = minImageD(sys.y[k] - sys.y[center], sys.L);
      var angK = Math.atan2(dky, dkx);
      var err = Math.abs(wrapAngle(angK - angO));
      if (err < bestErr - 1e-12 || (Math.abs(err - bestErr) <= 1e-12 && (best === -1 || k < best))) { bestErr = err; best = k; }
    }
    return best;
  }

  /**
   * 結合 i-j の生成の瞬間、j 側と i 側それぞれに3体の角のばね(bond-bending)を1本ずつ足す
   * （registration §system.angleSprings）。j に他の結合が無ければ j 側は足さない（i 側も同様）。
   * 同じ塊の中の2粒子が触れてできた結合（閉路）にも同じ規則で足す（呼び出し側は区別しない）。
   */
  function addAngleSprings(sys, i, j) {
    var a = pickNearestDirection(sys, j, i, i); // j側: j→i に角度で最も近い j の結合相手
    if (a >= 0 && a !== i) addAngleSpring(sys, a, j, i); // 三つ組 (a, j, i)。頂点 j
    var b = pickNearestDirection(sys, i, j, j); // i側: i→j に角度で最も近い i の結合相手
    if (b >= 0 && b !== j) addAngleSpring(sys, b, i, j); // 三つ組 (b, i, j)。頂点 i
  }
  /** 三つ組 (a,v,b)・頂点v。θ0 = 生成の瞬間の符号つきの角（a−v から b−v へ）。 */
  function addAngleSpring(sys, a, v, b) {
    var ux = minImageD(sys.x[a] - sys.x[v], sys.L), uy = minImageD(sys.y[a] - sys.y[v], sys.L);
    var wx = minImageD(sys.x[b] - sys.x[v], sys.L), wy = minImageD(sys.y[b] - sys.y[v], sys.L);
    var theta0 = Math.atan2(ux * wy - uy * wx, ux * wx + uy * wy);
    sys.angleList.push({ a: a, v: v, b: b, theta0: theta0 });
  }
  /**
   * 三つ組 tri={a,v,b,theta0} の力とエネルギーを fx/fy へ加算し、U を返す。
   * U=(kTheta/2)wrap(θ-θ0)²、θ=atan2(cross(u,w),dot(u,w))（u=a-v, w=b-v の符号つき角）。
   * θは大域回転・並進で不変（差ベクトルだけで決まる）なので、この力は構成上 ΣF=0・Σr×F=0 を満たす。
   */
  function addAngleForceEnergy(sys, tri, kTheta, fx, fy) {
    var L = sys.L;
    var ux = minImageD(sys.x[tri.a] - sys.x[tri.v], L), uy = minImageD(sys.y[tri.a] - sys.y[tri.v], L);
    var wx = minImageD(sys.x[tri.b] - sys.x[tri.v], L), wy = minImageD(sys.y[tri.b] - sys.y[tri.v], L);
    var ru2 = ux * ux + uy * uy, rw2 = wx * wx + wy * wy;
    if (ru2 < 1e-18 || rw2 < 1e-18) return { V: 0, tau: 0, absRF: 0 }; // 縮退（実用上は起きない）
    var theta = Math.atan2(ux * wy - uy * wx, ux * wx + uy * wy);
    var dth = wrapAngle(theta - tri.theta0);
    var coef = kTheta * dth; // dU/dθ
    // dθ/db = perp(w)/rw2, dθ/da = -perp(u)/ru2, dθ/dv = -(dθ/da+dθ/db)
    var Fbx = -coef * (-wy) / rw2, Fby = -coef * (wx) / rw2; // F_b = -coef*dθ/db
    var Fax = coef * (-uy) / ru2, Fay = coef * (ux) / ru2;   // F_a = -coef*dθ/da = coef*perp(u)/ru2
    var Fvx = -Fax - Fbx, Fvy = -Fay - Fby;
    fx[tri.a] += Fax; fy[tri.a] += Fay;
    fx[tri.b] += Fbx; fy[tri.b] += Fby;
    fx[tri.v] += Fvx; fy[tri.v] += Fvy;
    // 頂点v周りの局所トルク（u×Fa + w×Fb。Fvの寄与は0——vが原点なので）。ΣF_triple=0なので
    // 原点によらず一致する（構成上ちょうど0。numeric勾配・selftestで確認）。
    var tauLocal = (ux * Fay - uy * Fax) + (wx * Fby - wy * Fbx);
    var absRFLocal = Math.hypot(ux, uy) * Math.hypot(Fax, Fay) + Math.hypot(wx, wy) * Math.hypot(Fbx, Fby);
    return { V: 0.5 * kTheta * dth * dth, tau: tauLocal, absRF: absRFLocal };
  }

  // ================================================================ 1刻み（M/NC 腕）

  /**
   * 過減衰 Langevin の Euler–Maruyama 1歩 + 結合の生成。
   * cfg = armConfigFor(p.arm)。events（省略可）に merges を積む。
   * 戻り値: { formedBonds: n, multiMerge: bool }
   */
  function stepBD(sys, p, rng, gaussian, cfg) {
    cfg = cfg || armConfigFor(p.arm);
    if (!sys._f) sys._f = computeForces(sys, p, cfg);
    var f = sys._f;
    var N = sys.N, dt = p.dt, mu = p.mu, D0 = p.D0;
    var noiseAmp = Math.sqrt(2 * D0 * dt);
    var sumFx = 0, sumFy = 0, sumAbsF = 0;
    for (var i = 0; i < N; i++) {
      sumFx += f.fx[i]; sumFy += f.fy[i]; sumAbsF += Math.abs(f.fx[i]) + Math.abs(f.fy[i]);
      var frozen = cfg.frozenIfBonded && sys.bondNbrs[i].length > 0;
      var dx, dy;
      if (frozen) { dx = 0; dy = 0; }
      else {
        dx = mu * f.fx[i] * dt + noiseAmp * gaussian();
        dy = mu * f.fy[i] * dt + noiseAmp * gaussian();
      }
      sys.x[i] = wrapPos(sys.x[i] + dx, sys.L);
      sys.y[i] = wrapPos(sys.y[i] + dy, sys.L);
      sys.ux[i] += dx; sys.uy[i] += dy;
    }
    var ratio = sumAbsF > 1e-300 ? (Math.abs(sumFx) + Math.abs(sumFy)) / sumAbsF : 0;
    if (ratio > sys.sigmaFmax) sys.sigmaFmax = ratio;

    sys.step++; sys.t += dt;
    var f2 = computeForces(sys, p, cfg);
    sys.U = f2.U;
    // 台帳（記録のみ・K-146）: 連続区間の熱（Sekimotoのトラペゾイド則）は簡略化して積まない
    // （raw/notes.md に申し送り）。結合の生成で消える芯のエネルギーだけを Q_bath へ積む(下)。
    // このため U(t)-U(0)+Q_bath(t)=0 の台帳の残差は厳密には閉じない——判定には使わない(K-146)。

    // 結合の生成: 現在位置で r<rOn の未結合対を (i<j) 昇順に。
    var formedCount = 0, mergesThisStep = 0;
    if (cfg.formBonds) {
      var candidates = [];
      forEachPairWithin(f2.cellList, sys, p.rOn, function (i, j, dx2, dy2, r2) {
        if (isBonded(sys, i, j)) return;
        var a = Math.min(i, j), b = Math.max(i, j);
        candidates.push([a, b, Math.sqrt(r2)]);
      });
      candidates.sort(function (A, B) { return A[0] - B[0] || A[1] - B[1]; });
      for (var c = 0; c < candidates.length; c++) {
        var i2 = candidates[c][0], j2 = candidates[c][1];
        if (isBonded(sys, i2, j2)) continue; // 直前の結合で状況が変わっていることがある
        var dxn = minImageD(sys.x[i2] - sys.x[j2], sys.L), dyn = minImageD(sys.y[i2] - sys.y[j2], sys.L);
        var rn = Math.hypot(dxn, dyn);
        if (rn >= p.rOn) continue;
        // 結合の直前の芯エネルギーが消える分を熱へ足す(結合の生成での不可逆な散逸)
        var coreBefore = coreVF(rn, p.kc).V;
        var res = formBond(sys, i2, j2, rn);
        if (res.formed) {
          formedCount++;
          if (res.merge) mergesThisStep++;
          kahanAdd(sys, 'Qbath', coreBefore);
          if (cfg.hasLockSprings) addLockSprings(sys, i2, j2);
        }
      }
      if (formedCount > 0) f2 = computeForces(sys, p, cfg); // ばね/ロックが増えたので取り直す
    }
    sys._f = f2;
    return { formedCount: formedCount, mergesThisStep: mergesThisStep, multiMerge: mergesThisStep >= 2 };
  }

  /**
   * reg2（2本目）専用の1刻み。stepBD と同じ Euler–Maruyama だが:
   *  - 結合の自然長 l0（F1）: cfg.bondL0Mode==='sigma' なら σ=p.rOn 固定。生成時の距離を使わない
   *  - 芯は結合した対にも残る（F2。computeForces 側で cfg.coreOnBonded として処理済み）
   *  - 角のばね（F3。cfg.hasAngleSprings）を lockSprings の代わりに使う
   *  - エネルギーの台帳: Q_Sek（Sekimotoの台形則）・E_inj（結合生成の瞬間の注入）・
   *    Σr×F（sys.ux/uy=巻き戻さない座標を使う。周期境界をまたぐ対の絶対座標での torque は
   *    偽の非零を生むため、中心力(core/bond)は対ごとに厳密0、角のばねも頂点周りで厳密0——
   *    このため巻き戻さない座標を使えば大域の原点に依らず一致する）
   * run(main・1本目)の stepBD は変更していない——完全に別関数（selftest がハッシュで確認する）。
   */
  function stepBD2(sys, p, rng, gaussian, cfg) {
    cfg = cfg || armConfigFor(p.arm);
    if (!sys._f) sys._f = computeForces(sys, p, cfg);
    var f = sys._f;
    var N = sys.N, dt = p.dt, mu = p.mu, D0 = p.D0;
    var noiseAmp = Math.sqrt(2 * D0 * dt);
    var sumFx = 0, sumFy = 0, sumAbsF = 0;
    var dxArr = new Float64Array(N), dyArr = new Float64Array(N);
    for (var i = 0; i < N; i++) {
      sumFx += f.fx[i]; sumFy += f.fy[i]; sumAbsF += Math.abs(f.fx[i]) + Math.abs(f.fy[i]);
      // NC-DLA2: 種(sys._seedSet)も結合前から動かない（run1のNC-DLAは「結合を持てば止まる」だけ
      // だったが、reg2は種がt=0から止まっている必要がある。sys._seedSetが無い腕は影響を受けない）。
      var frozen = cfg.frozenIfBonded && (sys.bondNbrs[i].length > 0 || (sys._seedSet && sys._seedSet.has(i)));
      var dx, dy;
      if (frozen) { dx = 0; dy = 0; }
      else {
        dx = mu * f.fx[i] * dt + noiseAmp * gaussian();
        dy = mu * f.fy[i] * dt + noiseAmp * gaussian();
      }
      dxArr[i] = dx; dyArr[i] = dy;
      sys.x[i] = wrapPos(sys.x[i] + dx, sys.L);
      sys.y[i] = wrapPos(sys.y[i] + dy, sys.L);
      sys.ux[i] += dx; sys.uy[i] += dy;
    }
    var ratio = sumAbsF > 1e-300 ? (Math.abs(sumFx) + Math.abs(sumFy)) / sumAbsF : 0;
    if (ratio > sys.sigmaFmax) sys.sigmaFmax = ratio;
    // Σr×F（f=このステップ開始時の力。対・三つ組ごとの局所トルクは構成上ちょうど0——
    // computeForcesが対ごとに実際使った相対ベクトルで集計済み。周期境界の絶対座標に頼らない）。
    var tauRatio = f.absRF > 1e-300 ? Math.abs(f.tau) / f.absRF : 0;
    if (tauRatio > sys.tauFmax) sys.tauFmax = tauRatio;

    sys.step++; sys.t += dt;

    var formedCount = 0, mergesThisStep = 0;
    var fPre = computeForces(sys, p, cfg); // 位置更新後・結合生成前（セル表はここから取る）
    if (cfg.formBonds) {
      var candidates = [];
      forEachPairWithin(fPre.cellList, sys, p.rOn, function (i, j, dx2, dy2, r2) {
        if (isBonded(sys, i, j)) return;
        var a = Math.min(i, j), b = Math.max(i, j);
        candidates.push([a, b, Math.sqrt(r2)]);
      });
      candidates.sort(function (A, B) { return A[0] - B[0] || A[1] - B[1]; });
      for (var c = 0; c < candidates.length; c++) {
        var i2 = candidates[c][0], j2 = candidates[c][1];
        if (isBonded(sys, i2, j2)) continue;
        // NC-DLA2（cfg.bondRequiresFrozenPeer）: 動く粒子どうしは結合しない。
        // 少なくとも一方が止まっている（種、または既に結合を持つ）ときだけ結合する。
        if (cfg.bondRequiresFrozenPeer) {
          var iStopped = sys.bondNbrs[i2].length > 0 || (sys._seedSet && sys._seedSet.has(i2));
          var jStopped = sys.bondNbrs[j2].length > 0 || (sys._seedSet && sys._seedSet.has(j2));
          if (!iStopped && !jStopped) continue;
        }
        var dxn = minImageD(sys.x[i2] - sys.x[j2], sys.L), dyn = minImageD(sys.y[i2] - sys.y[j2], sys.L);
        var rn = Math.hypot(dxn, dyn);
        if (rn >= p.rOn) continue;
        var l0 = cfg.bondL0Mode === 'sigma' ? p.rOn : rn; // F1: 自然長=σ固定
        var res = formBond(sys, i2, j2, l0);
        if (res.formed) {
          formedCount++;
          if (res.merge) mergesThisStep++;
          kahanAdd(sys, 'Einj', springVF(rn, l0, p.kb).V); // 生成の瞬間のばねの位置エネルギー(E_inj)
          if (cfg.hasAngleSprings) addAngleSprings(sys, i2, j2);
        }
      }
    }
    // Sekimotoの台形則: Q_Sek += Σ 0.5*(F(x)+F(x'))·Δx。台形則が近似する∫F·dxは「実際に辿った
    // 経路」上の積分——移動そのものは新しい結合が生まれる前の力(旧い位相)で起きたので、F(x')も
    // 旧い位相・新しい位置(fPre)で評価する（結合の生成で不連続に現れるエネルギーはE_injが別に
    // 担う）。ここをf2(結合生成後)にすると、Δxが知らない新しい結合のばねの傾きまで積んでしまい、
    // 残差が桁で膨らむ（PC-ledgerClosureで発見）。
    var qStep = 0;
    for (var k = 0; k < N; k++) qStep += 0.5 * (f.fx[k] + fPre.fx[k]) * dxArr[k] + 0.5 * (f.fy[k] + fPre.fy[k]) * dyArr[k];
    kahanAdd(sys, 'QSek', qStep);

    var f2 = (formedCount > 0) ? computeForces(sys, p, cfg) : fPre;
    sys.U = f2.U;
    sys._f = f2;
    return { formedCount: formedCount, mergesThisStep: mergesThisStep, multiMerge: mergesThisStep >= 2 };
  }

  /** 現在の結合の最大の長さ（走行内の最大ではなく、"いま"の値。破綻の検出器に使う）。NaN があれば Infinity。 */
  function currentMaxBondStretch(sys) {
    var L = sys.L, worst = 0;
    for (var b = 0; b < sys.bondList.length; b++) {
      var bd = sys.bondList[b];
      var dx = minImageD(sys.x[bd.i] - sys.x[bd.j], L), dy = minImageD(sys.y[bd.i] - sys.y[bd.j], L);
      var r = Math.hypot(dx, dy);
      if (!isFinite(r)) return Infinity;
      if (r > worst) worst = r;
    }
    return worst;
  }
  function hasNaNCoords(sys) {
    for (var i = 0; i < sys.N; i++) { if (!isFinite(sys.x[i]) || !isFinite(sys.y[i])) return true; }
    return false;
  }

  // ================================================================ R腕（※参照・剛体の運動学的モンテカルロ）

  /** 塊 c（root）の重心（周期境界: 最小像でルート粒子から展開して平均）。 */
  function clusterCentroid(sys, root) {
    var members = sys.compMembers.get(root);
    var rx = sys.x[members[0]], ry = sys.y[members[0]];
    var sx = 0, sy = 0;
    for (var k = 0; k < members.length; k++) {
      sx += minImageD(sys.x[members[k]] - rx, sys.L);
      sy += minImageD(sys.y[members[k]] - ry, sys.L);
    }
    return { x: wrapPos(rx + sx / members.length, sys.L), y: wrapPos(ry + sy / members.length, sys.L) };
  }
  function clusterRadius(sys, root, cx, cy) {
    var members = sys.compMembers.get(root), rmax = 0;
    for (var k = 0; k < members.length; k++) {
      var dx = minImageD(sys.x[members[k]] - cx, sys.L), dy = minImageD(sys.y[members[k]] - cy, sys.L);
      rmax = Math.max(rmax, Math.hypot(dx, dy));
    }
    return rmax;
  }

  /**
   * R腕の1イベント。cfg={gamma, rot(bool), delta}。cl は近傍探索用（rCore+delta 程度のセルサイズで
   * 都度渡す）。戻り値: { dtElapsed, merged }。componentCount<=1 なら何もしない。
   */
  function stepKMC(sys, p, rng, cfg, cl) {
    var roots = [];
    sys.compMembers.forEach(function (_, root) { roots.push(root); });
    if (roots.length <= 1) return { dtElapsed: 0, merged: false, noEvent: true };

    var weights = new Array(roots.length);
    var kinds = new Array(roots.length); // 'T' か 'R'（回転。R-1rot のみ）
    var total = 0;
    for (var r = 0; r < roots.length; r++) {
      var n = sys.ufSize[roots[r]];
      var wT = 4 * p.D0 * Math.pow(n, cfg.gamma) / (cfg.delta * cfg.delta);
      weights[r] = wT; kinds[r] = 'T'; total += wT;
    }
    var rotBase = roots.length;
    if (cfg.rot) {
      for (var r2 = 0; r2 < roots.length; r2++) {
        var n2 = sys.ufSize[roots[r2]];
        if (n2 <= 1) { weights.push(0); kinds.push('R'); continue; }
        var c = clusterCentroid(sys, roots[r2]);
        var Rmax = Math.max(clusterRadius(sys, roots[r2], c.x, c.y), 1e-6);
        var Dr = p.D0 / sumSqDistFromCentroid(sys, roots[r2], c.x, c.y);
        var thetaDelta = Math.min(0.1 / Rmax, 0.1);
        var wR = 2 * Dr / (thetaDelta * thetaDelta);
        weights.push(wR); total += wR;
      }
    }
    if (total <= 0 || !isFinite(total)) return { dtElapsed: 0, merged: false, noEvent: true };
    var pick = rng() * total, acc = 0, idx = -1;
    for (var q = 0; q < weights.length; q++) { acc += weights[q]; if (pick <= acc) { idx = q; break; } }
    if (idx < 0) idx = weights.length - 1;
    var dtElapsed = 1 / total;
    var kind = kinds[idx];
    var rootIdx = idx < roots.length ? idx : idx - rotBase;
    var root = roots[rootIdx];
    var merged = false;
    if (kind === 'T') {
      var ang = rng() * 2 * Math.PI, ux = Math.cos(ang), uy = Math.sin(ang);
      merged = kmcTranslate(sys, p, root, ux, uy, cfg.delta);
    } else {
      merged = kmcRotate(sys, p, root, cfg.delta, rng);
    }
    sys.step++; sys.t += dtElapsed;
    return { dtElapsed: dtElapsed, merged: merged, noEvent: false };
  }

  function sumSqDistFromCentroid(sys, root, cx, cy) {
    var members = sys.compMembers.get(root), s = 0;
    for (var k = 0; k < members.length; k++) {
      var dx = minImageD(sys.x[members[k]] - cx, sys.L), dy = minImageD(sys.y[members[k]] - cy, sys.L);
      s += dx * dx + dy * dy;
    }
    return Math.max(s, 1e-9);
  }

  /**
   * 候補（cのメンバー以外で近い粒子）を集める。
   * 性能: R腕は1イベントごとに塊を1つだけ動かすため、毎回セル表を作り直す(O(N)のバケツ確保)と
   * イベント数×N のアロケーションになり実測で致命的に遅い。**sys._kmcCellList にセル表を1本だけ
   * 保持し、cellRefreshEvery イベントごとに作り直す**（他は使い回す。粒子は1イベントにつき
   * δ=0.1σ 程度しか動かないので、セルの一辺(~1.1σ)をまたぐ頻度は低く、取りこぼしても次の
   * リフレッシュで解消する——衝突判定そのものは常に実座標で行うので、セル表が多少古くても
   * 誤って通過させることは無い。取りこぼし得るのは「わずかに古いせいで見つからない近傍候補」
   * だけで、次のイベントで作り直されるセル表が拾う。raw/notes.md に簡略化として明記）。
   */
  var KMC_CELL_REFRESH = 40;
  /** sys._kmcCellRefreshOverride があれば既定の40の代わりに使う（reg2の近傍表再利用の検査専用。
   * 既定はundefinedなのでrun1・reg2の通常経路は影響を受けない）。 */
  function getKmcCellList(sys, extra) {
    var refresh = sys._kmcCellRefreshOverride != null ? sys._kmcCellRefreshOverride : KMC_CELL_REFRESH;
    var need = !sys._kmcCellList || sys._kmcCellListAge >= refresh || sys._kmcCellListExtra < extra;
    if (need) {
      sys._kmcCellList = buildCellList(sys, 1.0 + extra);
      sys._kmcCellListAge = 0;
      sys._kmcCellListExtra = extra;
    } else {
      sys._kmcCellListAge++;
    }
    return sys._kmcCellList;
  }
  function gatherOutsideCandidates(sys, root, extra) {
    var members = sys.compMembers.get(root);
    var inSet = new Set(members);
    var cl = getKmcCellList(sys, extra);
    var seen = new Set(), out = [];
    for (var k = 0; k < members.length; k++) {
      var nb = neighborsWithin(cl, sys, members[k], 1.0 + extra);
      for (var a = 0; a < nb.length; a++) {
        var j = nb[a][0];
        if (inSet.has(j) || seen.has(j)) continue;
        seen.add(j); out.push(j);
      }
    }
    return out;
  }

  /** root を方向(ux,uy)へ最大 delta だけ剛体で動かす。接触するなら二分法で接触点まで戻し結合。 */
  function kmcTranslate(sys, p, root, ux, uy, delta) {
    var members = sys.compMembers.get(root);
    var outside = gatherOutsideCandidates(sys, root, delta + 1e-6);
    function overlapAt(s) {
      for (var k = 0; k < members.length; k++) {
        var mi = members[k];
        var mx = sys.x[mi] + s * ux, my = sys.y[mi] + s * uy;
        for (var a = 0; a < outside.length; a++) {
          var j = outside[a];
          var dx = minImageD(mx - sys.x[j], sys.L), dy = minImageD(my - sys.y[j], sys.L);
          if (dx * dx + dy * dy < 1) return true;
        }
      }
      return false;
    }
    var s = delta, touched = overlapAt(delta);
    if (touched) {
      var lo = 0, hi = delta;
      for (var it = 0; it < 24; it++) { var mid = 0.5 * (lo + hi); if (overlapAt(mid)) hi = mid; else lo = mid; }
      s = lo;
    }
    for (var k2 = 0; k2 < members.length; k2++) {
      var mi2 = members[k2];
      sys.x[mi2] = wrapPos(sys.x[mi2] + s * ux, sys.L); sys.y[mi2] = wrapPos(sys.y[mi2] + s * uy, sys.L);
      sys.ux[mi2] += s * ux; sys.uy[mi2] += s * uy;
    }
    if (!touched) return false;
    return bondTouchingAfterMove(sys, root, outside);
  }

  /** root を重心まわりに最大 deltaTheta だけ回転。接触するなら角を二分法で戻し結合。 */
  function kmcRotate(sys, p, root, deltaThetaCap, rng) {
    var members = sys.compMembers.get(root);
    if (members.length <= 1) return false;
    var c = clusterCentroid(sys, root);
    var Rmax = Math.max(clusterRadius(sys, root, c.x, c.y), 1e-6);
    var thetaDelta = Math.min(0.1 / Rmax, 0.1);
    var sign = rng() < 0.5 ? -1 : 1;
    var outside = gatherOutsideCandidates(sys, root, thetaDelta * Rmax + 1e-6);
    var local = members.map(function (mi) { return [minImageD(sys.x[mi] - c.x, sys.L), minImageD(sys.y[mi] - c.y, sys.L)]; });
    function overlapAt(theta) {
      var cs = Math.cos(theta), sn = Math.sin(theta);
      for (var k = 0; k < members.length; k++) {
        var lx = local[k][0], ly = local[k][1];
        var mx = c.x + lx * cs - ly * sn, my = c.y + lx * sn + ly * cs;
        for (var a = 0; a < outside.length; a++) {
          var j = outside[a];
          var dx = minImageD(mx - sys.x[j], sys.L), dy = minImageD(my - sys.y[j], sys.L);
          if (dx * dx + dy * dy < 1) return true;
        }
      }
      return false;
    }
    var full = sign * thetaDelta, touched = overlapAt(full), theta = full;
    if (touched) {
      var lo = 0, hi = thetaDelta;
      for (var it = 0; it < 20; it++) { var mid = 0.5 * (lo + hi); if (overlapAt(sign * mid)) hi = mid; else lo = mid; }
      theta = sign * lo;
    }
    var cs2 = Math.cos(theta), sn2 = Math.sin(theta);
    for (var k2 = 0; k2 < members.length; k2++) {
      var mi = members[k2], lx = local[k2][0], ly = local[k2][1];
      var nx = c.x + lx * cs2 - ly * sn2, ny = c.y + lx * sn2 + ly * cs2;
      var dxr = minImageD(nx - sys.x[mi], sys.L), dyr = minImageD(ny - sys.y[mi], sys.L);
      sys.x[mi] = wrapPos(sys.x[mi] + dxr, sys.L); sys.y[mi] = wrapPos(sys.y[mi] + dyr, sys.L);
      sys.ux[mi] += dxr; sys.uy[mi] += dyr;
    }
    if (!touched) return false;
    return bondTouchingAfterMove(sys, root, outside);
  }

  /** 移動後、距離<=1+1e-6 の対をすべて結合する（R腕の接触=即結合。l0=生成時のr）。 */
  function bondTouchingAfterMove(sys, root, outside) {
    var members = sys.compMembers.get(root);
    var pairs = [];
    for (var k = 0; k < members.length; k++) {
      var mi = members[k];
      for (var a = 0; a < outside.length; a++) {
        var j = outside[a];
        if (isBonded(sys, mi, j)) continue;
        var dx = minImageD(sys.x[mi] - sys.x[j], sys.L), dy = minImageD(sys.y[mi] - sys.y[j], sys.L);
        var r = Math.hypot(dx, dy);
        if (r <= 1 + 1e-6) pairs.push([Math.min(mi, j), Math.max(mi, j), r]);
      }
    }
    if (!pairs.length) return false;
    pairs.sort(function (A, B) { return A[0] - B[0] || A[1] - B[1]; });
    var any = false;
    for (var p2 = 0; p2 < pairs.length; p2++) {
      if (isBonded(sys, pairs[p2][0], pairs[p2][1])) continue;
      var res = formBond(sys, pairs[p2][0], pairs[p2][1], pairs[p2][2]);
      if (res.formed) any = true;
    }
    return any;
  }

  // ================================================================ R腕2（reg2専用・展開座標・自己像の結合）

  /**
   * members を bondNbrs で BFS 展開し、周期境界をまたがない局所座標を作る（回転の局所座標・貫通の判定用）。
   * 戻り値: {local:Map(idx->[lx,ly])（開始粒子からの相対）, cx,cy（局所重心）, startX,startY（開始粒子の絶対座標）,
   * spanX,spanY（局所座標の広がり）, selfImage(bool・周期境界を介して自分とつながるか)}。
   * detectors.js の unwrapCluster と同型（core.js は detectors.js を require できないための重複。軽量）。
   */
  function unfoldMembers(sys, members) {
    var inSet = new Set(members);
    var local = new Map();
    var start = members[0];
    local.set(start, [0, 0]);
    var visited = new Set([start]);
    var queue = [start];
    var selfImage = false;
    var minX = 0, maxX = 0, minY = 0, maxY = 0;
    while (queue.length) {
      var cur = queue.shift();
      var cp = local.get(cur);
      var nbrs = sys.bondNbrs[cur];
      for (var k = 0; k < nbrs.length; k++) {
        var nb = nbrs[k];
        if (!inSet.has(nb)) continue;
        var dx = minImageD(sys.x[nb] - sys.x[cur], sys.L), dy = minImageD(sys.y[nb] - sys.y[cur], sys.L);
        var cand = [cp[0] + dx, cp[1] + dy];
        if (!visited.has(nb)) {
          visited.add(nb); local.set(nb, cand); queue.push(nb);
          if (cand[0] < minX) minX = cand[0]; if (cand[0] > maxX) maxX = cand[0];
          if (cand[1] < minY) minY = cand[1]; if (cand[1] > maxY) maxY = cand[1];
        } else {
          var ep = local.get(nb);
          if (Math.abs(ep[0] - cand[0]) > sys.L / 2 || Math.abs(ep[1] - cand[1]) > sys.L / 2) selfImage = true;
        }
      }
    }
    var cx = 0, cy = 0, m = members.length;
    for (var a = 0; a < m; a++) { var lp = local.get(members[a]); cx += lp[0]; cy += lp[1]; }
    cx /= m; cy /= m;
    return { local: local, cx: cx, cy: cy, startX: sys.x[start], startY: sys.y[start], spanX: maxX - minX, spanY: maxY - minY, selfImage: selfImage };
  }

  /**
   * reg2 専用の R 腕1イベント。criteria-2.json system.referenceDynamics の変更点:
   *  (i) 回転の局所座標は結合に沿って展開した座標で取る（unfoldMembers。1本目の最小像はL/2を
   *      越える塊を歪めた。S4 §4.1）——ただし性能のため、塊の見かけの半径が 0.2L 未満なら
   *      最小像でも歪まない（周期像をまたがない）ので、その場合は run(main)と同じ安い関数
   *      （clusterCentroid/clusterRadius）を使い、大きい塊のときだけ展開する（notes.mdに明記）
   *  (ii) 動かした塊の粒子と自分の周期像の粒子の接触も結合する（回転でだけ起きうる。剛体回転は
   *       真の対距離を保つので、これは周期像との距離だけが変わりうる） → kmcRotate2 が行う
   *  (iii) 展開した広がりがL以上の塊（貫通）は回転しない（回転の重みを0にする。回さなかった
   *        回数を rotSkippedSpanning として返す）
   *  (iv) 事象の上限は呼び出し側（replicate2.js）が数える
   * run(main・1本目)の stepKMC は変更していない——完全に別関数。
   */
  function stepKMC2(sys, p, rng, cfg) {
    var roots = [];
    sys.compMembers.forEach(function (_, root) { roots.push(root); });
    if (roots.length <= 1) return { dtElapsed: 0, merged: false, noEvent: true, rotSkippedSpanning: 0 };

    var weights = new Array(roots.length);
    var total = 0;
    for (var r = 0; r < roots.length; r++) {
      var n = sys.ufSize[roots[r]];
      var wT = 4 * p.D0 * Math.pow(n, cfg.gamma) / (cfg.delta * cfg.delta);
      weights[r] = wT; total += wT;
    }
    var rotBase = roots.length;
    var rotMeta = new Array(roots.length);
    var rotSkippedSpanning = 0;
    if (cfg.rot) {
      for (var r2 = 0; r2 < roots.length; r2++) {
        var n2 = sys.ufSize[roots[r2]];
        if (n2 <= 1) { weights.push(0); continue; }
        var root2 = roots[r2];
        var c2 = clusterCentroid(sys, root2);
        var Rmax2 = Math.max(clusterRadius(sys, root2, c2.x, c2.y), 1e-6);
        var cheap = Rmax2 < sys.L * 0.2;
        var spanning = false, sumSq2;
        if (cheap) {
          sumSq2 = sumSqDistFromCentroid(sys, root2, c2.x, c2.y);
        } else {
          var members2 = sys.compMembers.get(root2);
          var fr2 = unfoldMembers(sys, members2);
          spanning = fr2.spanX >= sys.L || fr2.spanY >= sys.L || fr2.selfImage;
          if (!spanning) {
            sumSq2 = 0; var Rm2 = 1e-6;
            for (var mi3 = 0; mi3 < members2.length; mi3++) {
              var lp3 = fr2.local.get(members2[mi3]); var rx3 = lp3[0] - fr2.cx, ry3 = lp3[1] - fr2.cy;
              sumSq2 += rx3 * rx3 + ry3 * ry3; Rm2 = Math.max(Rm2, Math.hypot(rx3, ry3));
            }
            Rmax2 = Math.max(Rm2, 1e-6); sumSq2 = Math.max(sumSq2, 1e-9);
          }
        }
        rotMeta[r2] = { cheap: cheap };
        if (spanning) { weights.push(0); rotSkippedSpanning++; continue; }
        var Dr2 = p.D0 / Math.max(sumSq2, 1e-9);
        var thetaDelta2 = Math.min(0.1 / Rmax2, 0.1);
        var wR2 = 2 * Dr2 / (thetaDelta2 * thetaDelta2);
        weights.push(wR2); total += wR2;
      }
    }
    if (total <= 0 || !isFinite(total)) return { dtElapsed: 0, merged: false, noEvent: true, rotSkippedSpanning: rotSkippedSpanning };
    var pick = rng() * total, acc = 0, idx = -1;
    for (var q = 0; q < weights.length; q++) { acc += weights[q]; if (pick <= acc) { idx = q; break; } }
    if (idx < 0) idx = weights.length - 1;
    var dtElapsed = 1 / total;
    var kind = idx < roots.length ? 'T' : 'R';
    var rootIdx = idx < roots.length ? idx : idx - rotBase;
    var root = roots[rootIdx];
    var merged = false;
    if (kind === 'T') {
      var ang = rng() * 2 * Math.PI, ux = Math.cos(ang), uy = Math.sin(ang);
      merged = kmcTranslate(sys, p, root, ux, uy, cfg.delta);
    } else {
      var meta = rotMeta[rootIdx];
      merged = (meta && !meta.cheap) ? kmcRotate2(sys, p, root, cfg.delta, rng) : kmcRotate(sys, p, root, cfg.delta, rng);
    }
    sys.step++; sys.t += dtElapsed;
    return { dtElapsed: dtElapsed, merged: merged, noEvent: false, rotSkippedSpanning: rotSkippedSpanning };
  }

  /** kmcRotate の展開座標(unfoldMembers)版。大きい・貫通しうる塊にだけ使う（stepKMC2が判定）。
   * 移動後、自分の周期像との接触（真の対距離ではなく周期像だけがもたらす近さ）も結合する。 */
  function kmcRotate2(sys, p, root, deltaThetaCap, rng) {
    var members = sys.compMembers.get(root);
    if (members.length <= 1) return false;
    var frame = unfoldMembers(sys, members);
    var cx = wrapPos(frame.startX + frame.cx, sys.L), cy = wrapPos(frame.startY + frame.cy, sys.L);
    var Rmax = 1e-6;
    var local = members.map(function (mi) {
      var lp = frame.local.get(mi); var rx = lp[0] - frame.cx, ry = lp[1] - frame.cy;
      Rmax = Math.max(Rmax, Math.hypot(rx, ry));
      return [rx, ry];
    });
    var thetaDelta = Math.min(0.1 / Rmax, 0.1);
    var sign = rng() < 0.5 ? -1 : 1;
    var outside = gatherOutsideCandidates(sys, root, thetaDelta * Rmax + 1e-6);
    function overlapAt(theta) {
      var cs = Math.cos(theta), sn = Math.sin(theta);
      for (var k = 0; k < members.length; k++) {
        var lx = local[k][0], ly = local[k][1];
        var mx = cx + lx * cs - ly * sn, my = cy + lx * sn + ly * cs;
        for (var a2 = 0; a2 < outside.length; a2++) {
          var j = outside[a2];
          var dx = minImageD(mx - sys.x[j], sys.L), dy = minImageD(my - sys.y[j], sys.L);
          if (dx * dx + dy * dy < 1) return true;
        }
      }
      return false;
    }
    var full = sign * thetaDelta, touched = overlapAt(full), theta = full;
    if (touched) {
      var lo = 0, hi = thetaDelta;
      for (var it = 0; it < 20; it++) { var mid = 0.5 * (lo + hi); if (overlapAt(sign * mid)) hi = mid; else lo = mid; }
      theta = sign * lo;
    }
    var cs2 = Math.cos(theta), sn2 = Math.sin(theta);
    for (var k2 = 0; k2 < members.length; k2++) {
      var mi = members[k2], lx = local[k2][0], ly = local[k2][1];
      var nx = cx + lx * cs2 - ly * sn2, ny = cy + lx * sn2 + ly * cs2;
      var dxr = minImageD(nx - sys.x[mi], sys.L), dyr = minImageD(ny - sys.y[mi], sys.L);
      sys.x[mi] = wrapPos(sys.x[mi] + dxr, sys.L); sys.y[mi] = wrapPos(sys.y[mi] + dyr, sys.L);
      sys.ux[mi] += dxr; sys.uy[mi] += dyr;
    }
    var any = false;
    if (touched) any = bondTouchingAfterMove(sys, root, outside) || any;
    // 自分の周期像との接触（回転でだけ起きうる）。広がりがLに近いときだけ調べる（O(m^2)だが滅多に無い）。
    var spanNow = Math.max(frame.spanX, frame.spanY);
    if (spanNow >= sys.L - 2.2) {
      var selfPairs = [];
      for (var i1 = 0; i1 < members.length; i1++) {
        for (var j1 = i1 + 1; j1 < members.length; j1++) {
          var mi1 = members[i1], mj1 = members[j1];
          if (isBonded(sys, mi1, mj1)) continue;
          var dxp = minImageD(sys.x[mi1] - sys.x[mj1], sys.L), dyp = minImageD(sys.y[mi1] - sys.y[mj1], sys.L);
          var rp = Math.hypot(dxp, dyp);
          if (rp <= 1 + 1e-6) selfPairs.push([Math.min(mi1, mj1), Math.max(mi1, mj1), rp]);
        }
      }
      if (selfPairs.length) {
        selfPairs.sort(function (A, B) { return A[0] - B[0] || A[1] - B[1]; });
        for (var sp = 0; sp < selfPairs.length; sp++) {
          if (isBonded(sys, selfPairs[sp][0], selfPairs[sp][1])) continue;
          var res2 = formBond(sys, selfPairs[sp][0], selfPairs[sp][1], selfPairs[sp][2]);
          if (res2.formed) any = true;
        }
      }
    }
    return any;
  }

  // ================================================================ 初期化

  function initReplicate(p) {
    var N = p.N;
    var sys = createSystem(N, p.L);
    var posRng = subStream(p.seed, 0);
    var fill = randomSequentialFill(N, p.L, p.minGap, posRng);
    sys.x.set(fill.x); sys.y.set(fill.y);
    sys.fellBack = fill.fellBack;
    sys.sampleRng = subStream(p.seed, 9); // H-strict の対の標本
    return sys;
  }

  /** t=0の位置のハッシュ（K-145: 同じ (phi,seed) は全腕で共有することの確認に使う）。 */
  function initHash(sys) {
    var parts = [];
    for (var i = 0; i < sys.N; i++) parts.push(sys.x[i].toFixed(6) + ',' + sys.y[i].toFixed(6));
    return require0('crypto').createHash('sha256').update(parts.join(';')).digest('hex').slice(0, 16);
  }
  function require0(name) { return (typeof require !== 'undefined') ? require(name) : null; }

  // ================================================================ エクスポート

  return {
    makeRng: makeRng, subStream: subStream, hash32: hash32, gaussianFactory: gaussianFactory,
    wrapPos: wrapPos, minImageD: minImageD, wrapAll: wrapAll, randomSequentialFill: randomSequentialFill,
    buildCellList: buildCellList, forEachPairWithin: forEachPairWithin, neighborsWithin: neighborsWithin,
    defaultParams: defaultParams, computeL: computeL, armConfigFor: armConfigFor, ARM_CONFIG: ARM_CONFIG,
    createSystem: createSystem, kahanAdd: kahanAdd,
    ufFind: ufFind, formBond: formBond, finalizeUnits: finalizeUnits,
    coreVF: coreVF, springVF: springVF, numericSpringF: numericSpringF, numericCoreF: numericCoreF,
    isBonded: isBonded, isLocked: isLocked,
    computeForces: computeForces, computeForcesReference: computeForcesReference,
    addLockSprings: addLockSprings, addLock: addLock,
    stepBD: stepBD,
    clusterCentroid: clusterCentroid, clusterRadius: clusterRadius, stepKMC: stepKMC,
    gatherOutsideCandidates: gatherOutsideCandidates, kmcTranslate: kmcTranslate, kmcRotate: kmcRotate,
    initReplicate: initReplicate, initHash: initHash,
    // ── reg2（2本目）専用 ──────────────────────────────────────────────
    wrapAngle: wrapAngle, pickNearestDirection: pickNearestDirection,
    addAngleSprings: addAngleSprings, addAngleSpring: addAngleSpring, addAngleForceEnergy: addAngleForceEnergy,
    stepBD2: stepBD2, currentMaxBondStretch: currentMaxBondStretch, hasNaNCoords: hasNaNCoords,
    unfoldMembers: unfoldMembers, stepKMC2: stepKMC2, kmcRotate2: kmcRotate2,
  };
});
