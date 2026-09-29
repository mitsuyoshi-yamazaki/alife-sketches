/**
 * S-62 の核。2次元の三角格子（斜交座標・最近接6方向）に水(W)・親水の単量体(H)・疎水の単量体(T)を置く。
 * 力学は2つの局所試行の Metropolis: ①単量体と隣の水の交換（最近接の接触エネルギー χ）
 * ②隣り合う2単量体の結合の形成・切断（型と結合価だけを見る局所の反応。形成は熱浴へ ε_b を渡し、
 * 切断は熱浴から受け取る）。criteria.json の system 節をそのままコードにしたもの。
 *
 * 上位概念（重合体・ミセル・自己集合 等）の語彙はここでは使わない――鎖・塊のID は核に無い。
 * 同一性の追跡・段の判定は観測器（tracking.js）の側だけが持つ（s2-implement.md の禁則）。
 *
 * Node とブラウザの両方で使う（UMD 風）。ESM にしない。依存ゼロ。
 */
'use strict';
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S62 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  var SITE_W = 0, SITE_H = 1, SITE_T = 2;
  // 斜交座標の最近接6方向（system.space のとおり）
  var DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, -1], [-1, 1]];

  // ================================================================ 乱数（S-59 と同じ mulberry32・独立部分ストリーム）
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
  /** streamId: 0=初期位置の並べ替え, 1=初期型の並べ替え, 2=力学(交換/結合の全試行), 3=R-preの自己回避の歩み, 4=観測器の帰無配置の標本(tracking.js/replicate.js が使う) */
  function subStream(seed, streamId) { return makeRng(hash32(seed >>> 0, streamId >>> 0)); }

  // ================================================================ パラメータ
  function defaultParams(overrides) {
    var p = {
      L: 128, phi: 0.20, fH: 0.25, chi: 1.2, epsB: 8, kT: 1,
      kb: 3,             // 結合の試行の頻度（0=結合なし）
      allphobic: false,  // NC-allphobic: H も水を嫌う（H-W・T-W が χ、T-H は 0）
      seed: 6201,
      kTT: null,         // E-2T 較正: T の交換だけ別の温度で受理する（null なら kT と同じ）
    };
    var out = {};
    for (var k in p) out[k] = p[k];
    if (overrides) for (var k2 in overrides) out[k2] = overrides[k2];
    return out;
  }

  function idx(i, j, L) { i = ((i % L) + L) % L; j = ((j % L) + L) % L; return i * L + j; }
  function ijOf(s, L) { return [Math.floor(s / L), s % L]; }
  function neighborSite(s, d, L) {
    var ij = ijOf(s, L);
    return idx(ij[0] + DIRS[d][0], ij[1] + DIRS[d][1], L);
  }
  /**
   * idx() の高速版。**i・j が [-1, L] の範囲にあるときだけ正しい**(DIRSのオフセット±1を
   * 有効な座標へ足した場合に限る)。モジュロ演算を避けるための、ホットパス専用の限定版。
   * 一般の(範囲を跨ぐ可能性がある)呼び出しは idx() を使うこと。
   */
  function idxNear(i, j, L) {
    if (i < 0) i += L; else if (i >= L) i -= L;
    if (j < 0) j += L; else if (j >= L) j -= L;
    return i * L + j;
  }
  /** sAの6隣にsBがあるか(配列を作らない。ホットパスの結合の拘束チェックで使う)。 */
  function isSiteNeighbor(sA, sB, L) {
    var i = (sA / L) | 0, j = sA % L;
    for (var d = 0; d < 6; d++) if (idxNear(i + DIRS[d][0], j + DIRS[d][1], L) === sB) return true;
    return false;
  }

  // ================================================================ 系(状態)
  /**
   * siteType: 0=W,1=H,2=T（サイトごと）。siteMon: そのサイトの単量体番号（-1なら水）。
   * monType/monSite: 単量体ごとの型・現在のサイト。monBond0/monBond1: 結合相手の単量体番号（無ければ-1）。
   * H は monBond0 だけを使う（monBond1 は常に-1）。T は monBond0・monBond1 の両方を使いうる。
   */
  function createSystem(L, Nmon) {
    return {
      L: L, t: 0,
      siteType: new Uint8Array(L * L),
      siteMon: new Int32Array(L * L).fill(-1),
      Nmon: Nmon,
      monType: new Uint8Array(Nmon),
      monSite: new Int32Array(Nmon),
      monBond0: new Int32Array(Nmon).fill(-1),
      monBond1: new Int32Array(Nmon).fill(-1),
      bondFormedAt: new Map(), // key: 'm_n'(m<n) -> t（結合の年齢）
      // 整数の台帳
      C_TW: 0, C_TH: 0, C_HW: 0, Nbond: 0,
      // 経路ごとの累積係数（criteria system.ledger の q_c^χ・q_c^b）
      q: {
        exH: { chi: 0, b: 0 }, exT: { chi: 0, b: 0 },
        form: { chi: 0, b: 0 }, brk: { chi: 0, b: 0 },
      },
      nForm: 0, nBreak: 0,
    };
  }

  function valenceOf(sys, m) { return (sys.monBond0[m] >= 0 ? 1 : 0) + (sys.monBond1[m] >= 0 ? 1 : 0); }
  function isBondedTo(sys, m, n) { return sys.monBond0[m] === n || sys.monBond1[m] === n; }
  function bondKey(m, n) { return m < n ? m + '_' + n : n + '_' + m; }

  function addBondSlot(sys, m, n) {
    if (sys.monBond0[m] < 0) sys.monBond0[m] = n; else sys.monBond1[m] = n;
  }
  function removeBondSlot(sys, m, n) {
    if (sys.monBond0[m] === n) sys.monBond0[m] = -1; else if (sys.monBond1[m] === n) sys.monBond1[m] = -1;
  }

  /** 接触の係数（0か1）。allphobic なら H も水を嫌う代わりに T-H は0。 */
  function contactCoefAndClass(a, b, allphobic) {
    if ((a === SITE_T && b === SITE_W) || (a === SITE_W && b === SITE_T)) return { coef: 1, cls: 'TW' };
    if (allphobic) {
      if ((a === SITE_H && b === SITE_W) || (a === SITE_W && b === SITE_H)) return { coef: 1, cls: 'HW' };
      return { coef: 0, cls: (a === SITE_T && b === SITE_H) || (a === SITE_H && b === SITE_T) ? 'TH' : 'other' };
    }
    if ((a === SITE_T && b === SITE_H) || (a === SITE_H && b === SITE_T)) return { coef: 1, cls: 'TH' };
    return { coef: 0, cls: 'other' };
  }

  /**
   * サイト A・B にそれぞれ仮の型 ta・tb を置いたときの、A・B に触れる全対の接触係数の和と
   * クラス別内訳。**ホットパス**(交換試行のたびに2回呼ばれる)なのでオブジェクトを割り当てない――
   * 戻り値は使い回しの1つのスクラッチオブジェクトを毎回上書きして返す(呼び出し側はすぐ読むこと。
   * 2つの結果を同時に保持したい場合は呼び出し側でフィールドをコピーする。tryExchangeがその形)。
   */
  var LCS_SCRATCH = { sum: 0, tw: 0, th: 0, hw: 0 };
  function classCode(a, b, allphobic) {
    if ((a === SITE_T && b === SITE_W) || (a === SITE_W && b === SITE_T)) return 1; // TW
    if (allphobic) return (a === SITE_H && b === SITE_W) || (a === SITE_W && b === SITE_H) ? 3 : 0; // HW / other(TH含む)
    return (a === SITE_T && b === SITE_H) || (a === SITE_H && b === SITE_T) ? 2 : 0; // TH / other
  }
  function localContactSum(sys, A, B, taA, taB) {
    var L = sys.L, allphobic = sys.allphobic, sum = 0, tw = 0, th = 0, hw = 0;
    var iA = (A / L) | 0, jA = A % L, iB = (B / L) | 0, jB = B % L;
    for (var d = 0; d < 6; d++) {
      var n = idxNear(iA + DIRS[d][0], jA + DIRS[d][1], L);
      var tn = n === A ? taA : n === B ? taB : sys.siteType[n];
      var c = classCode(taA, tn, allphobic);
      if (c === 1) { sum++; tw++; } else if (c === 2) { sum++; th++; } else if (c === 3) { sum++; hw++; }
    }
    for (d = 0; d < 6; d++) {
      var n2 = idxNear(iB + DIRS[d][0], jB + DIRS[d][1], L);
      var tn2 = n2 === A ? taA : n2 === B ? taB : sys.siteType[n2];
      var c2 = classCode(taB, tn2, allphobic);
      if (c2 === 1) { sum++; tw++; } else if (c2 === 2) { sum++; th++; } else if (c2 === 3) { sum++; hw++; }
    }
    LCS_SCRATCH.sum = sum; LCS_SCRATCH.tw = tw; LCS_SCRATCH.th = th; LCS_SCRATCH.hw = hw;
    return LCS_SCRATCH;
  }

  function activeContacts(sys) { return sys.allphobic ? sys.C_TW + sys.C_HW : sys.C_TW + sys.C_TH; }

  // ================================================================ 初期化
  /** 型と数(system.sites)。N_mon=round(φL²)、N_H=round(f_H·N_mon)。 */
  function monomerCounts(L, phi, fH) {
    var Nmon = Math.round(phi * L * L);
    var NH = Math.round(fH * Nmon);
    var NT = Nmon - NH;
    return { Nmon: Nmon, NH: NH, NT: NT };
  }

  /** 一様乱数で重ならない Nmon 個の位置へ、型を無作為に割り当てて置く（結合0本・準備段なし。K-141）。 */
  function initUniform(p) {
    var L = p.L, counts = monomerCounts(L, p.phi, p.fH);
    var sys = createSystem(L, counts.Nmon);
    sys.allphobic = !!p.allphobic;
    var posRng = subStream(p.seed, 0), typeRng = subStream(p.seed, 1);
    // 位置: フィッシャー–イェーツでサイト番号を並べ替えて先頭 Nmon 個を使う(密度0.2程度なので衝突なし・高速)
    var allSites = new Int32Array(L * L);
    for (var s = 0; s < L * L; s++) allSites[s] = s;
    for (s = L * L - 1; s > 0; s--) {
      var j = Math.floor(posRng() * (s + 1));
      var tmp = allSites[s]; allSites[s] = allSites[j]; allSites[j] = tmp;
    }
    var labels = new Uint8Array(counts.Nmon);
    for (var h = 0; h < counts.NH; h++) labels[h] = SITE_H;
    for (var t = counts.NH; t < counts.Nmon; t++) labels[t] = SITE_T;
    for (var i = labels.length - 1; i > 0; i--) {
      var jj = Math.floor(typeRng() * (i + 1));
      var tv = labels[i]; labels[i] = labels[jj]; labels[jj] = tv;
    }
    for (var m = 0; m < counts.Nmon; m++) {
      var site = allSites[m];
      sys.monType[m] = labels[m];
      sys.monSite[m] = site;
      sys.siteType[site] = labels[m];
      sys.siteMon[site] = m;
    }
    recomputeContactCounts(sys);
    return sys;
  }

  /**
   * R-pre: 819本の四量体 H–T3 を、長さ4の無作為な自己回避の格子の歩みとして逐次に置く（重なりは棄却）。
   * 結合は形成した状態で置き、結合の試行を行わない（kb=0で凍結。呼び出し側が p.kb=0 にすること）。
   */
  function initPrePlaced(p) {
    var L = p.L, counts = monomerCounts(L, p.phi, p.fH);
    var nTetramer = Math.floor(counts.NH); // H1個が頭。四量体の数=NH個（Nmonがぴったり4NHでなければ1本分NTが減る）
    var sys = createSystem(L, 0); // Nmonは後で確定
    sys.allphobic = false;
    var rng = subStream(p.seed, 3);
    var occupied = new Uint8Array(L * L);
    var placedMon = []; // {type, site}
    var bondsToMake = []; // [ [monIdxA, monIdxB], ... ]（連番で割り当てた後にidへ変換）
    var actuallyPlaced = 0, attempts = 0, maxAttempts = nTetramer * 4000;
    for (var k = 0; k < nTetramer && attempts < maxAttempts; k++) {
      var placedThis = null;
      for (var tries = 0; tries < 400; tries++) {
        attempts++;
        var startSite = Math.floor(rng() * L * L);
        var walk = [startSite];
        var ok = !occupied[startSite];
        var localOcc = new Set(ok ? [startSite] : []);
        if (ok) {
          for (var step = 0; step < 3 && ok; step++) {
            var cand = [];
            for (var d = 0; d < 6; d++) {
              var ns = neighborSite(walk[walk.length - 1], d, L);
              if (!occupied[ns] && !localOcc.has(ns)) cand.push(ns);
            }
            if (cand.length === 0) { ok = false; break; }
            var pick = cand[Math.floor(rng() * cand.length)];
            walk.push(pick); localOcc.add(pick);
          }
        }
        if (ok && walk.length === 4) { placedThis = walk; break; }
      }
      if (!placedThis) continue; // 置けなかった四量体は諦める(actuallyPlacedがNHよりわずかに少なくなりうる。record)
      for (var w = 0; w < 4; w++) occupied[placedThis[w]] = 1;
      var baseIdx = placedMon.length;
      placedMon.push({ type: SITE_H, site: placedThis[0] });
      placedMon.push({ type: SITE_T, site: placedThis[1] });
      placedMon.push({ type: SITE_T, site: placedThis[2] });
      placedMon.push({ type: SITE_T, site: placedThis[3] });
      bondsToMake.push([baseIdx, baseIdx + 1], [baseIdx + 1, baseIdx + 2], [baseIdx + 2, baseIdx + 3]);
      actuallyPlaced++;
    }
    var Nmon = placedMon.length;
    sys.Nmon = Nmon;
    sys.monType = new Uint8Array(Nmon); sys.monSite = new Int32Array(Nmon);
    sys.monBond0 = new Int32Array(Nmon).fill(-1); sys.monBond1 = new Int32Array(Nmon).fill(-1);
    for (var mi = 0; mi < Nmon; mi++) {
      sys.monType[mi] = placedMon[mi].type; sys.monSite[mi] = placedMon[mi].site;
      sys.siteType[placedMon[mi].site] = placedMon[mi].type; sys.siteMon[placedMon[mi].site] = mi;
    }
    for (var bi = 0; bi < bondsToMake.length; bi++) {
      var a = bondsToMake[bi][0], b = bondsToMake[bi][1];
      addBondSlot(sys, a, b); addBondSlot(sys, b, a);
      sys.Nbond++; sys.bondFormedAt.set(bondKey(a, b), 0);
    }
    sys.prePlacedRequested = nTetramer; sys.prePlacedActual = actuallyPlaced;
    recomputeContactCounts(sys);
    return sys;
  }

  /** 素朴な総当たり（近道の検算の参照実装）で C_TW・C_TH・C_HW を数え直す。 */
  function recomputeContactCounts(sys) {
    var L = sys.L, C_TW = 0, C_TH = 0, C_HW = 0;
    for (var s = 0; s < L * L; s++) {
      var ij = ijOf(s, L), a = sys.siteType[s];
      for (var d = 0; d < 3; d++) { // 3方向だけ辿れば各対を1回ずつ数えられる((1,0)(0,1)(1,-1)の3つで十分。他3つは逆向き)
        var n = idx(ij[0] + DIRS[d][0], ij[1] + DIRS[d][1], L);
        var r = contactCoefAndClass(a, sys.siteType[n], sys.allphobic);
        if (r.cls === 'TW') C_TW++; else if (r.cls === 'TH') C_TH++; else if (r.cls === 'HW') C_HW++;
      }
    }
    sys.C_TW = C_TW; sys.C_TH = C_TH; sys.C_HW = C_HW;
    return { C_TW: C_TW, C_TH: C_TH, C_HW: C_HW };
  }

  function energyConf(sys, p) { return p.chi * activeContacts(sys) - p.epsB * sys.Nbond; }

  // ================================================================ MC 試行

  /** 交換試行: 単量体mを方向dへ。隣が水なら結合の拘束を確かめて提案。 */
  var EXCHANGE_RESULT = { proposed: false, accepted: false }; // ホットパス用の使い回し戻り値
  function tryExchange(sys, p, rng, m, d) {
    var A = sys.monSite[m], B = neighborSite(A, d, sys.L);
    if (sys.siteMon[B] !== -1) { EXCHANGE_RESULT.proposed = false; return EXCHANGE_RESULT; }
    // 結合の拘束: mの全ての結合相手がBの最近接であること(配列を作らずbond0/bond1を直接見る)
    var p0 = sys.monBond0[m], p1 = sys.monBond1[m];
    if (p0 >= 0 && !isSiteNeighbor(B, sys.monSite[p0], sys.L)) { EXCHANGE_RESULT.proposed = false; return EXCHANGE_RESULT; }
    if (p1 >= 0 && !isSiteNeighbor(B, sys.monSite[p1], sys.L)) { EXCHANGE_RESULT.proposed = false; return EXCHANGE_RESULT; }
    var typeM = sys.monType[m];
    var before = localContactSum(sys, A, B, typeM, SITE_W);
    var beforeSum = before.sum, beforeTW = before.tw, beforeTH = before.th, beforeHW = before.hw;
    var after = localContactSum(sys, A, B, SITE_W, typeM); // beforeを上書きするので値は先に取り出し済み
    var dContacts = after.sum - beforeSum;
    var dE = p.chi * dContacts;
    var kTeff = (typeM === SITE_T && p.kTT != null) ? p.kTT : p.kT;
    var accept = dE <= 0 || rng() < Math.exp(-dE / kTeff);
    if (!accept) { EXCHANGE_RESULT.proposed = true; EXCHANGE_RESULT.accepted = false; return EXCHANGE_RESULT; }
    // 適用
    sys.siteType[A] = SITE_W; sys.siteMon[A] = -1;
    sys.siteType[B] = typeM; sys.siteMon[B] = m;
    sys.monSite[m] = B;
    sys.C_TW += after.tw - beforeTW; sys.C_TH += after.th - beforeTH; sys.C_HW += after.hw - beforeHW;
    var ch = typeM === SITE_H ? sys.q.exH : sys.q.exT;
    ch.chi += -dContacts; // -ΔE/χ 分（結合の項は0）
    EXCHANGE_RESULT.proposed = true; EXCHANGE_RESULT.accepted = true;
    return EXCHANGE_RESULT;
  }

  /** 結合試行: 単量体mの方向d。隣に単量体があれば形成/切断を判定して提案。 */
  // ホットパス用の使い回し戻り値(呼び出し側は結果を読んだらすぐ使う。channel: 0=無し・1=form・2=brk)
  var BOND_RESULT = { proposed: false, accepted: false, channel: 0, m: -1, n: -1 };
  function tryBondEvent(sys, p, rng, m, d, t) {
    var A = sys.monSite[m], B = neighborSite(A, d, sys.L);
    var n = sys.siteMon[B];
    if (n === -1) { BOND_RESULT.proposed = false; return BOND_RESULT; }
    var typeM = sys.monType[m], typeN = sys.monType[n];
    if (typeM === SITE_H && typeN === SITE_H) { BOND_RESULT.proposed = false; return BOND_RESULT; }
    var bonded = isBondedTo(sys, m, n);
    var valM = valenceOf(sys, m), valN = valenceOf(sys, n);
    if (!bonded) {
      var canForm;
      if ((typeM === SITE_H && typeN === SITE_T) || (typeM === SITE_T && typeN === SITE_H)) canForm = valM === 0 && valN === 0;
      else if (typeM === SITE_T && typeN === SITE_T) canForm = (valM === 0 && valN === 1) || (valM === 1 && valN === 0);
      else canForm = false;
      if (!canForm) { BOND_RESULT.proposed = false; return BOND_RESULT; }
      var dE = -p.epsB; // 常に <=0 (epsB>0) なので必ず受理(min(1,e^{8/kT})=1)。式は一般形のまま書く
      var accept = dE <= 0 ? true : rng() < Math.exp(-dE / p.kT);
      if (!accept) { BOND_RESULT.proposed = true; BOND_RESULT.accepted = false; return BOND_RESULT; }
      addBondSlot(sys, m, n); addBondSlot(sys, n, m);
      sys.Nbond++; sys.nForm++;
      sys.bondFormedAt.set(bondKey(m, n), t);
      sys.q.form.b += 1;
      BOND_RESULT.proposed = true; BOND_RESULT.accepted = true; BOND_RESULT.channel = 1; BOND_RESULT.m = m; BOND_RESULT.n = n;
      return BOND_RESULT;
    } else {
      var canBreak;
      if ((typeM === SITE_H && typeN === SITE_T) || (typeM === SITE_T && typeN === SITE_H)) {
        var tVal = typeM === SITE_T ? valM : valN;
        canBreak = tVal === 1;
      } else if (typeM === SITE_T && typeN === SITE_T) canBreak = valM === 1 || valN === 1;
      else canBreak = false;
      if (!canBreak) { BOND_RESULT.proposed = false; return BOND_RESULT; }
      var dE2 = p.epsB;
      var accept2 = rng() < Math.exp(-dE2 / p.kT);
      if (!accept2) { BOND_RESULT.proposed = true; BOND_RESULT.accepted = false; return BOND_RESULT; }
      removeBondSlot(sys, m, n); removeBondSlot(sys, n, m);
      sys.Nbond--; sys.nBreak++;
      sys.bondFormedAt.delete(bondKey(m, n));
      sys.q.brk.b += -1; // -ΔNbond=+1の符号規約: q_c^b は ΔN_bond の累積。切断はΔNbond=-1
      BOND_RESULT.proposed = true; BOND_RESULT.accepted = true; BOND_RESULT.channel = 2; BOND_RESULT.m = m; BOND_RESULT.n = n;
      return BOND_RESULT;
    }
  }

  /**
   * 1刻み進める: 交換の試行 Nmon 回 + 結合の試行 round(kb*Nmon) 回を無作為な順に混ぜて実行する
   * （remaining-count法で、配列を作らず一様な順列と等価な順序を作る）。
   * events(省略可): { onForm(m,n,t), onBreak(m,n,t) }
   */
  function stepSystem(sys, p, rng, events) {
    var nBondTrials = Math.round(p.kb * sys.Nmon);
    var remEx = sys.Nmon, remBond = nBondTrials;
    var t = sys.t + 1;
    while (remEx > 0 || remBond > 0) {
      var pickBond = remBond > 0 && (remEx === 0 || rng() < remBond / (remEx + remBond));
      var m = Math.floor(rng() * sys.Nmon), d = Math.floor(rng() * 6);
      if (pickBond) {
        var r = tryBondEvent(sys, p, rng, m, d, t);
        if (r.accepted && events) {
          if (r.channel === 1 && events.onForm) events.onForm(r.m, r.n, t);
          else if (r.channel === 2 && events.onBreak) events.onBreak(r.m, r.n, t);
        }
        remBond--;
      } else {
        tryExchange(sys, p, rng, m, d);
        remEx--;
      }
    }
    sys.t = t;
  }

  // ================================================================ 状態ハッシュ(K-36)

  function fnv1a(bytesIter) {
    var h = 0x811c9dc5;
    for (var i = 0; i < bytesIter.length; i++) { h ^= bytesIter[i]; h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16);
  }
  /** サイトの型列 + 結合の組(正規化してソート)を連結してハッシュ。決定的な再現性の検査に使う(K-36)。 */
  function stateHash(sys) {
    var arr = Array.from(sys.siteType);
    var bonds = [];
    for (var m = 0; m < sys.Nmon; m++) {
      if (sys.monBond0[m] >= 0 && sys.monBond0[m] > m) bonds.push(m + ':' + sys.monBond0[m]);
      if (sys.monBond1[m] >= 0 && sys.monBond1[m] > m) bonds.push(m + ':' + sys.monBond1[m]);
    }
    bonds.sort();
    var s = arr.join('') + '|' + bonds.join(',');
    var bytes = [];
    for (var i = 0; i < s.length; i++) bytes.push(s.charCodeAt(i) & 0xff);
    return fnv1a(bytes);
  }

  return {
    SITE_W: SITE_W, SITE_H: SITE_H, SITE_T: SITE_T, DIRS: DIRS,
    makeRng: makeRng, hash32: hash32, subStream: subStream,
    defaultParams: defaultParams, idx: idx, ijOf: ijOf, neighborSite: neighborSite,
    createSystem: createSystem, valenceOf: valenceOf, isBondedTo: isBondedTo, bondKey: bondKey,
    contactCoefAndClass: contactCoefAndClass, localContactSum: localContactSum, activeContacts: activeContacts,
    monomerCounts: monomerCounts, initUniform: initUniform, initPrePlaced: initPrePlaced,
    recomputeContactCounts: recomputeContactCounts, energyConf: energyConf,
    tryExchange: tryExchange, tryBondEvent: tryBondEvent, stepSystem: stepSystem,
    stateHash: stateHash,
  };
});
