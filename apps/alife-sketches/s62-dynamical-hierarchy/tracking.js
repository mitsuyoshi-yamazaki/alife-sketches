/**
 * S-62 の観測器(criteria.json observerDetails をそのままコードにしたもの)。
 * 上位概念(重合体・ミセル 等)の語彙を使ってよいのはここだけ。core.js は使わない(s2-implement.md の禁則)。
 *
 * U1(結合グラフの連結成分)・U2(Tどうしの最近接の接触グラフの連結成分・持続の追跡)・
 * U3(持続するU2どうしの結び)・段の資格・H-strict・内と外の分離(P_io)・大きさの自己制限・
 * 経路(φ_pre・β_in)・分裂/融合・帰無配置(無作為配置・U2の剛体置き直し)を提供する。
 *
 * Node/ブラウザ両対応(UMD)。依存は core.js の座標ヘルパのみ。
 */
'use strict';
(function (root, factory) {
  var api = factory(typeof module === 'object' && module.exports ? require('./core.js') : root.S62);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S62T = api;
})(typeof self !== 'undefined' ? self : this, function (S62) {
  var SITE_H = S62.SITE_H, SITE_T = S62.SITE_T;

  // ── Union-Find ──────────────────────────────────────────────────────
  function UnionFind(n) { this.parent = new Int32Array(n); for (var i = 0; i < n; i++) this.parent[i] = i; }
  UnionFind.prototype.find = function (a) { while (this.parent[a] !== a) { this.parent[a] = this.parent[this.parent[a]]; a = this.parent[a]; } return a; };
  UnionFind.prototype.union = function (a, b) { var ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent[ra] = rb; };

  // ── U1: 結合グラフの連結成分(単量体2個以上) ────────────────────────────
  function buildU1(sys) {
    var uf = new UnionFind(sys.Nmon);
    for (var m = 0; m < sys.Nmon; m++) {
      if (sys.monBond0[m] >= 0) uf.union(m, sys.monBond0[m]);
      if (sys.monBond1[m] >= 0) uf.union(m, sys.monBond1[m]);
    }
    var byRoot = new Map();
    for (m = 0; m < sys.Nmon; m++) {
      var r = uf.find(m);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r).push(m);
    }
    var chains = [];
    for (var arr of byRoot.values()) if (arr.length >= 2) chains.push({ members: arr, size: arr.length });
    return chains;
  }

  /** 鎖の頭(H)。鎖は規則により必ずHを1つだけ端に持つ(不変量。selftestが確かめる)。 */
  function chainHead(sys, chain) {
    for (var i = 0; i < chain.members.length; i++) if (sys.monType[chain.members[i]] === SITE_H) return chain.members[i];
    return null;
  }

  // ── T-Tの最近接の接触グラフ(周期境界込み) ────────────────────────────
  /**
   * allMon=trueなら「全単量体(TとH)の最近接」で連結成分を作る(knobs「U2の分け方」の代替値)。
   * 既定(allMon省略/false)は「Tどうしの最近接」。
   */
  function buildTContactGraph(sys, allMon) {
    var L = sys.L;
    var tSites = [];
    for (var m = 0; m < sys.Nmon; m++) if (allMon || sys.monType[m] === SITE_T) tSites.push(m);
    var idxOf = new Map(); for (var k = 0; k < tSites.length; k++) idxOf.set(tSites[k], k);
    var uf = new UnionFind(tSites.length);
    for (k = 0; k < tSites.length; k++) {
      var m2 = tSites[k], site = sys.monSite[m2];
      var ij = S62.ijOf(site, L);
      for (var d = 0; d < 6; d++) {
        var n = S62.idx(ij[0] + S62.DIRS[d][0], ij[1] + S62.DIRS[d][1], L);
        var nm = sys.siteMon[n];
        if (nm >= 0 && (allMon || sys.monType[nm] === SITE_T)) uf.union(k, idxOf.get(nm));
      }
    }
    var byRoot = new Map();
    for (k = 0; k < tSites.length; k++) { var r = uf.find(k); if (!byRoot.has(r)) byRoot.set(r, []); byRoot.get(r).push(tSites[k]); }
    return Array.from(byRoot.values());
  }

  /**
   * U2の候補。既定はTどうしの最近接でn2min以上(members=そのT+それに結合したH)。
   * allMon=trueなら「全単量体の最近接」で連結成分を作り、その中のT数がn2min以上のものを候補にする
   * (knobs「U2の分け方」の代替値。sameQuantityAs: U2の成員)。
   */
  function buildU2Candidates(sys, n2min, allMon) {
    var comps = buildTContactGraph(sys, allMon);
    var out = [];
    for (var c = 0; c < comps.length; c++) {
      var compMembers = comps[c];
      var tMembers = allMon ? compMembers.filter(function (m) { return sys.monType[m] === SITE_T; }) : compMembers;
      if (tMembers.length < n2min) continue;
      var hSet = new Set();
      if (allMon) {
        for (var i0 = 0; i0 < compMembers.length; i0++) if (sys.monType[compMembers[i0]] === SITE_H) hSet.add(compMembers[i0]);
      } else {
        for (var i = 0; i < tMembers.length; i++) {
          var m = tMembers[i];
          if (sys.monBond0[m] >= 0 && sys.monType[sys.monBond0[m]] === SITE_H) hSet.add(sys.monBond0[m]);
          if (sys.monBond1[m] >= 0 && sys.monType[sys.monBond1[m]] === SITE_H) hSet.add(sys.monBond1[m]);
        }
      }
      out.push({ tMembers: tMembers, hMembers: Array.from(hSet), nT: tMembers.length });
    }
    return out;
  }

  /**
   * U2の同一性の継続の追跡器。step(candidates) を各スナップショットで呼ぶ。
   * 戻り値: candidates と同じ順に { trackId, consecutive(このtrackが連続して候補だった回数) } を返す。
   * 同一性: 直前のtrackのTの過半(>=50%)が今回のある候補に入っていれば、その最大のものが引き継ぐ(定義どおり)。
   */
  function U2IdentityTracker() { this.nextId = 1; this.prevTracks = []; /* [{id,tSet,consecutive}] */ }
  U2IdentityTracker.prototype.step = function (candidates) {
    var self = this;
    var used = new Set();
    var results = candidates.map(function () { return null; });
    // 各旧trackについて、最も多くの旧Tを含む今回の候補を探す(過半なら継続)
    for (var pi = 0; pi < this.prevTracks.length; pi++) {
      var pt = this.prevTracks[pi];
      var best = -1, bestOverlap = 0;
      for (var ci = 0; ci < candidates.length; ci++) {
        var ov = 0, tset = candidates[ci].tMembers;
        for (var i = 0; i < tset.length; i++) if (pt.tSet.has(tset[i])) ov++;
        if (ov > bestOverlap) { bestOverlap = ov; best = ci; }
      }
      if (best >= 0 && bestOverlap / pt.tSet.size > 0.5 && !used.has(best)) {
        used.add(best);
        results[best] = { trackId: pt.id, consecutive: pt.consecutive + 1 };
      }
    }
    var newTracks = [];
    for (var ci2 = 0; ci2 < candidates.length; ci2++) {
      if (!results[ci2]) results[ci2] = { trackId: self.nextId++, consecutive: 1 };
      newTracks.push({ id: results[ci2].trackId, tSet: new Set(candidates[ci2].tMembers), consecutive: results[ci2].consecutive });
    }
    this.prevTracks = newTracks;
    return results;
  };

  // ── U3: 持続するU2どうしの結び ────────────────────────────────────────
  /** 2つのU2(members配列=T+Hの単量体id)の最近接の格子距離(周期境界。6方向グラフのBFS距離。上限探索3まで)。 */
  function minLatticeGap(sys, membersA, membersB, maxSearch) {
    maxSearch = maxSearch || 3;
    var L = sys.L;
    var setB = new Set(membersB.map(function (m) { return sys.monSite[m]; }));
    var best = Infinity;
    for (var i = 0; i < membersA.length; i++) {
      var site = sys.monSite[membersA[i]];
      // BFS半径maxSearchまで
      var visited = new Map(); visited.set(site, 0);
      var queue = [site], qi = 0;
      if (setB.has(site)) { best = Math.min(best, 0); continue; }
      while (qi < queue.length) {
        var s = queue[qi++], dist = visited.get(s);
        if (dist >= maxSearch) continue;
        var ij = S62.ijOf(s, L);
        for (var d = 0; d < 6; d++) {
          var n = S62.idx(ij[0] + S62.DIRS[d][0], ij[1] + S62.DIRS[d][1], L);
          if (visited.has(n)) continue;
          visited.set(n, dist + 1);
          if (setB.has(n)) { best = Math.min(best, dist + 1); }
          queue.push(n);
        }
      }
    }
    return best;
  }

  /**
   * 瞬間の結び: 持続するU2の対のうち格子距離<=g3のもの一覧([i,j],...)。tagged=[{members,trackId}]。
   * **全対をminLatticeGapで総当たりするとO(U2数²)で、候補数が多い早い時刻に極端に重くなる
   * (実測: ベンチマークの31%がこの関数だった)。** 代わりに、成員のサイトから直接g3歩のBFSを行い、
   * 途中で出会った「他の単位に属するサイト」を記録する形にする——計算量は総メンバー数(<=N_T)に
   * 比例し、単位の数の2乗には依らない。
   */
  function instantLinks(sys, tagged, g3) {
    var L = sys.L;
    var siteToUnit = new Map();
    for (var u = 0; u < tagged.length; u++) {
      var members = tagged[u].members;
      for (var i = 0; i < members.length; i++) siteToUnit.set(sys.monSite[members[i]], u);
    }
    var seenPair = new Set(), links = [];
    for (var pair of siteToUnit) {
      var startSite = pair[0], unitIdx = pair[1];
      var visited = new Map(); visited.set(startSite, 0);
      var queue = [startSite], qi = 0;
      while (qi < queue.length) {
        var s = queue[qi++], dist = visited.get(s);
        if (dist >= g3) continue;
        var ij = S62.ijOf(s, L);
        for (var d = 0; d < 6; d++) {
          var n = S62.idx(ij[0] + S62.DIRS[d][0], ij[1] + S62.DIRS[d][1], L);
          if (visited.has(n)) continue;
          visited.set(n, dist + 1);
          queue.push(n);
          var otherUnit = siteToUnit.get(n);
          if (otherUnit != null && otherUnit !== unitIdx) {
            var a = Math.min(unitIdx, otherUnit), b = Math.max(unitIdx, otherUnit), key = a + '_' + b;
            if (!seenPair.has(key)) { seenPair.add(key); links.push([a, b]); }
          }
        }
      }
    }
    return links;
  }

  /** 結びの持続の追跡(LinkTracker。tauLinkスナップショット続いたら持続)。 */
  function LinkTracker(tauLink) { this.tauLink = tauLink; this.active = new Map(); }
  LinkTracker.prototype.key = function (a, b) { return a < b ? a + '_' + b : b + '_' + a; };
  LinkTracker.prototype.step = function (keyedPairs /* [[keyA,keyB],...] trackId基準 */) {
    var self = this, nowSet = new Set(keyedPairs.map(function (p) { return self.key(p[0], p[1]); }));
    for (var k of Array.from(this.active.keys())) if (!nowSet.has(k)) this.active.delete(k);
    var persistent = [];
    for (var kk of nowSet) {
      var dur = (this.active.get(kk) || 0) + 1;
      this.active.set(kk, dur);
      if (dur >= this.tauLink) persistent.push(kk);
    }
    return persistent;
  };

  /** U3=持続する結びの連結成分(U2を2つ以上含むもの)。 trackedU2=[{trackId, members, nT}]。 */
  function buildU3(trackedU2, persistentLinkKeys) {
    var idxOfTrack = new Map(); for (var i = 0; i < trackedU2.length; i++) idxOfTrack.set(trackedU2[i].trackId, i);
    var uf = new UnionFind(trackedU2.length);
    for (var k = 0; k < persistentLinkKeys.length; k++) {
      var parts = persistentLinkKeys[k].split('_').map(Number);
      var ia = idxOfTrack.get(parts[0]), ib = idxOfTrack.get(parts[1]);
      if (ia != null && ib != null) uf.union(ia, ib);
    }
    var byRoot = new Map();
    for (i = 0; i < trackedU2.length; i++) { var r = uf.find(i); if (!byRoot.has(r)) byRoot.set(r, []); byRoot.get(r).push(trackedU2[i]); }
    var out = [];
    for (var arr of byRoot.values()) if (arr.length >= 2) out.push(arr);
    return out;
  }

  // ── 内と外の分離 P_io ────────────────────────────────────────────────
  /**
   * 単位(members=T+Hの単量体id配列)のb(6隣がすべて同じ単位のTであるTの割合)とrho_io
   * (Hの重心からの平均距離/Tの重心からの平均距離。周期境界は最小像で展開)。
   */
  function unitShape(sys, members) {
    var L = sys.L;
    var memberSet = new Set(members);
    var tList = members.filter(function (m) { return sys.monType[m] === SITE_T; });
    var hList = members.filter(function (m) { return sys.monType[m] === SITE_H; });
    if (tList.length === 0) return { b: 0, rhoIO: 1, hasH: hList.length > 0 };
    // 展開(unwrap): 最初のTを基準に最小像でBFS展開した座標を作る
    var ref = S62.ijOf(sys.monSite[tList[0]], L);
    var pos = new Map();
    function unwrapFrom(m0) {
      var start = sys.monSite[m0]; pos.set(m0, [0, 0]);
      var visited = new Set([m0]), queue = [m0], qi = 0;
      var siteToMon = new Map(); for (var mm of members) siteToMon.set(sys.monSite[mm], mm);
      while (qi < queue.length) {
        var u = queue[qi++], up = pos.get(u), usite = sys.monSite[u], uij = S62.ijOf(usite, L);
        for (var d = 0; d < 6; d++) {
          var nsite = S62.idx(uij[0] + S62.DIRS[d][0], uij[1] + S62.DIRS[d][1], L);
          var v = siteToMon.get(nsite);
          if (v == null || visited.has(v)) continue;
          pos.set(v, [up[0] + S62.DIRS[d][0], up[1] + S62.DIRS[d][1]]);
          visited.add(v); queue.push(v);
        }
      }
    }
    unwrapFrom(tList[0]);
    // BFSで届かなかった成員(周期境界を挟んで直接繋がっていない=結合で繋がっているだけ等)は元のij差分で近似
    for (var mi = 0; mi < members.length; mi++) {
      var mm2 = members[mi];
      if (!pos.has(mm2)) {
        var ij2 = S62.ijOf(sys.monSite[mm2], L);
        var di = ij2[0] - ref[0], dj = ij2[1] - ref[1];
        if (di > L / 2) di -= L; else if (di < -L / 2) di += L;
        if (dj > L / 2) dj -= L; else if (dj < -L / 2) dj += L;
        pos.set(mm2, [di, dj]);
      }
    }
    function centroid(list) {
      var cx = 0, cy = 0; for (var i = 0; i < list.length; i++) { var p = pos.get(list[i]); cx += p[0]; cy += p[1]; }
      return [cx / list.length, cy / list.length];
    }
    var cT = centroid(tList), cH = hList.length ? centroid(hList) : null;
    function meanDist(list, c) {
      var s = 0; for (var i = 0; i < list.length; i++) { var p = pos.get(list[i]); s += Math.hypot(p[0] - c[0], p[1] - c[1]); }
      return list.length ? s / list.length : 0;
    }
    var rT = meanDist(tList, cT);
    var rhoIO = 1;
    if (cH) { var rH = meanDist(hList, cH); rhoIO = rT > 1e-9 ? rH / rT : (rH > 0 ? Infinity : 1); }
    // b: 6隣がすべて同じ単位の成員であるTの割合
    var nGood = 0;
    for (var ti = 0; ti < tList.length; ti++) {
      var site = sys.monSite[tList[ti]], ij = S62.ijOf(site, L), allIn = true;
      for (var d = 0; d < 6; d++) {
        var nsite = S62.idx(ij[0] + S62.DIRS[d][0], ij[1] + S62.DIRS[d][1], L);
        var nm = sys.siteMon[nsite];
        if (nm == null || nm < 0 || !memberSet.has(nm)) { allIn = false; break; }
      }
      if (allIn) nGood++;
    }
    var b = tList.length ? nGood / tList.length : 0;
    // 慣性テンソル(全成員T+H)からRg・A・重心(unwrap座標。呼び出し側が時系列で追う場合は
    // 周期境界をまたいだ差分を最小像で正しく取れる連続量になる)。
    var cx = 0, cy = 0;
    for (var mi2 = 0; mi2 < members.length; mi2++) { var pp = pos.get(members[mi2]); cx += pp[0]; cy += pp[1]; }
    cx /= members.length; cy /= members.length;
    var Ixx = 0, Iyy = 0, Ixy = 0;
    for (mi2 = 0; mi2 < members.length; mi2++) {
      var p2 = pos.get(members[mi2]), dx = p2[0] - cx, dy = p2[1] - cy;
      Ixx += dy * dy; Iyy += dx * dx; Ixy -= dx * dy;
    }
    Ixx /= members.length; Iyy /= members.length; Ixy /= members.length;
    var tr = Ixx + Iyy, det = Ixx * Iyy - Ixy * Ixy, disc = Math.max(0, tr * tr / 4 - det);
    var l1 = tr / 2 + Math.sqrt(disc), l2 = tr / 2 - Math.sqrt(disc);
    var A = (l1 + l2) < 1e-12 ? 0 : Math.pow((l1 - l2) / (l1 + l2), 2);
    var Rg = Math.sqrt(Math.max(0, l1 + l2));
    // cx,cyはref(tList[0])からの相対unwrap座標なので、絶対座標(ref+相対)を返す。
    // どの成員がtList[0]になるかは呼び出しごとに変わりうるので、呼び出し側が時系列を追うときは
    // 「mod Lの生の重心」どうしの最小像差分を毎回取って積算すること(絶対座標を跨って引き算しない)。
    var absCx = ref[0] + cx, absCy = ref[1] + cy;
    var rawCx = ((absCx % L) + L) % L, rawCy = ((absCy % L) + L) % L;
    return { b: b, rhoIO: rhoIO, hasH: hList.length > 0, Rg: Rg, A: A, rawCx: rawCx, rawCy: rawCy };
  }

  /** P_io判定(criteria observerDetails.propertyPanel)。 */
  function pIo(shape, bThr, rhoThr) {
    bThr = bThr == null ? 0.2 : bThr; rhoThr = rhoThr == null ? 1.3 : rhoThr;
    return shape.hasH && shape.b >= bThr && shape.rhoIO >= rhoThr;
  }

  // ── 帰無配置 ────────────────────────────────────────────────────────
  /** 無作為配置でのΦ2_inst相当(密度=NT/L²の点をL²サイトへ無作為に置いた連結成分でn>=n2minに入る割合)。 */
  function nullPhi2Inst(L, NT, n2min, rng) {
    var occ = new Uint8Array(L * L);
    var placed = 0, sites = [];
    while (placed < NT) {
      var s = Math.floor(rng() * L * L);
      if (!occ[s]) { occ[s] = 1; sites.push(s); placed++; }
    }
    var uf = new UnionFind(sites.length);
    var idxOf = new Map(); for (var k = 0; k < sites.length; k++) idxOf.set(sites[k], k);
    for (k = 0; k < sites.length; k++) {
      var ij = S62.ijOf(sites[k], L);
      for (var d = 0; d < 6; d++) {
        var n = S62.idx(ij[0] + S62.DIRS[d][0], ij[1] + S62.DIRS[d][1], L);
        if (occ[n]) uf.union(k, idxOf.get(n));
      }
    }
    var sizeOf = new Map();
    for (k = 0; k < sites.length; k++) { var r = uf.find(k); sizeOf.set(r, (sizeOf.get(r) || 0) + 1); }
    var num = 0;
    for (var sz of sizeOf.values()) if (sz >= n2min) num += sz;
    return sites.length ? num / sites.length : 0;
  }

  /** 60°回転(system.spaceの斜交座標)。(i,j)->(-j,i+j)を rot(0..5)回適用。 */
  function rot60(i, j, times) {
    for (var t = 0; t < ((times % 6) + 6) % 6; t++) { var ni = -j, nj = i + j; i = ni; j = nj; }
    return [i, j];
  }

  /**
   * U3の帰無値: 各持続するU2を剛体として無作為な位置・60°刻みの向きへ置き直し(重なり拒否)、
   * その合成配置でのΦ3_inst相当(結びの割合)を返す。tagged=[{members(単量体id), trackId}]。
   */
  function nullPhi3Inst(sys, tagged, g3, rng) {
    if (tagged.length < 2) return 0;
    var L = sys.L;
    // 各単位の(T+H)の相対座標(基準T)を作る
    var rel = tagged.map(function (u) {
      var t0 = u.members.find(function (m) { return sys.monType[m] === SITE_T; }) || u.members[0];
      var base = S62.ijOf(sys.monSite[t0], L);
      return u.members.map(function (m) {
        var ij = S62.ijOf(sys.monSite[m], L);
        var di = ij[0] - base[0], dj = ij[1] - base[1];
        if (di > L / 2) di -= L; else if (di < -L / 2) di += L;
        if (dj > L / 2) dj -= L; else if (dj < -L / 2) dj += L;
        return [di, dj];
      });
    });
    var occ = new Set();
    var placedSites = []; // 単位ごとのTのサイト集合(結び判定用)
    for (var u = 0; u < rel.length; u++) {
      var ok = false, sitesThis = [];
      for (var attempt = 0; attempt < 30 && !ok; attempt++) {
        var pi = Math.floor(rng() * L), pj = Math.floor(rng() * L), rt = Math.floor(rng() * 6);
        var candSites = [];
        var conflict = false;
        for (var m = 0; m < rel[u].length; m++) {
          var r = rot60(rel[u][m][0], rel[u][m][1], rt);
          var si = ((pi + r[0]) % L + L) % L, sj = ((pj + r[1]) % L + L) % L;
          var sidx = si * L + sj;
          if (occ.has(sidx)) { conflict = true; break; }
          candSites.push(sidx);
        }
        if (!conflict) { ok = true; sitesThis = candSites; }
      }
      for (var s2 = 0; s2 < sitesThis.length; s2++) occ.add(sitesThis[s2]);
      placedSites.push(sitesThis);
    }
    // 結び判定(格子距離<=g3。BFSは重いので簡略に最小ユークリッド距離の周期最小像で近似)
    function minGapSets(a, b) {
      var best = Infinity;
      for (var i = 0; i < a.length; i++) {
        var ii = Math.floor(a[i] / L), ij2 = a[i] % L;
        for (var j = 0; j < b.length; j++) {
          var ji = Math.floor(b[j] / L), jj = b[j] % L;
          var di = ii - ji, dj = ij2 - jj;
          if (di > L / 2) di -= L; else if (di < -L / 2) di += L;
          if (dj > L / 2) dj -= L; else if (dj < -L / 2) dj += L;
          best = Math.min(best, Math.hypot(di, dj));
        }
      }
      return best;
    }
    var linkedFlag = new Array(rel.length).fill(false);
    for (var a = 0; a < rel.length; a++) {
      for (var b = a + 1; b < rel.length; b++) {
        if (minGapSets(placedSites[a], placedSites[b]) <= g3 + 0.5) { linkedFlag[a] = true; linkedFlag[b] = true; }
      }
    }
    var num = 0, den = 0;
    for (var k = 0; k < tagged.length; k++) { den += tagged[k].nT; if (linkedFlag[k]) num += tagged[k].nT; }
    return den > 0 ? num / den : 0;
  }

  // ── Jaccard(H-strictの一体性 ι) ─────────────────────────────────────
  function jaccard(setA, setB) {
    if (setA.size === 0 && setB.size === 0) return 1;
    var inter = 0; for (var x of setA) if (setB.has(x)) inter++;
    var union = setA.size + setB.size - inter;
    return union > 0 ? inter / union : 1;
  }

  // ── 拡散(D_k): 周期境界のmod L位置から「巻き戻さない」軌跡を積算する ──────
  /**
   * state = {init,ux,uy,rawX,rawY} を呼び出し側が識別子ごとに保持し、新しい生の(mod L)重心を
   * 渡すたびに更新する。ux,uy が周期境界を跨いでも連続な(unwrapした)軌跡になる。
   */
  function advanceUnwrapped(state, rawX, rawY, L) {
    if (!state.init) { state.init = true; state.ux = rawX; state.uy = rawY; state.rawX = rawX; state.rawY = rawY; return state; }
    var dx = rawX - state.rawX, dy = rawY - state.rawY;
    if (dx > L / 2) dx -= L; else if (dx < -L / 2) dx += L;
    if (dy > L / 2) dy -= L; else if (dy < -L / 2) dy += L;
    state.ux += dx; state.uy += dy;
    state.rawX = rawX; state.rawY = rawY;
    return state;
  }

  /**
   * trajectories = [[{idx,ux,uy},...], ...](識別子ごとの時系列。idxはスナップショットの通し番号)。
   * lags(idxの差の配列)ごとに平均二乗変位を出し、MSD=4·D·(lag·dtPerIdx)の傾きからDを求める(2次元)。
   */
  function computeMSD(trajectories, lags, dtPerIdx) {
    var lagOut = [], msdOut = [];
    for (var li = 0; li < lags.length; li++) {
      var lag = lags[li], sum = 0, n = 0;
      for (var tr of trajectories) {
        var byIdx = new Map(); for (var k = 0; k < tr.length; k++) byIdx.set(tr[k].idx, tr[k]);
        for (var k2 = 0; k2 < tr.length; k2++) {
          var a = tr[k2], b = byIdx.get(a.idx + lag);
          if (!b) continue;
          var dx = b.ux - a.ux, dy = b.uy - a.uy;
          sum += dx * dx + dy * dy; n++;
        }
      }
      lagOut.push(lag); msdOut.push(n ? sum / n : null);
    }
    var xs = [], ys = [];
    for (var i = 0; i < lagOut.length; i++) if (msdOut[i] != null) { xs.push(lagOut[i] * dtPerIdx); ys.push(msdOut[i]); }
    var D = null;
    if (xs.length >= 2) {
      var mx = mean(xs), my = mean(ys), sxx = 0, sxy = 0;
      for (i = 0; i < xs.length; i++) { sxx += (xs[i] - mx) * (xs[i] - mx); sxy += (xs[i] - mx) * (ys[i] - my); }
      if (sxx > 1e-9) D = (sxy / sxx) / 4;
    }
    return { lags: lagOut, msd: msdOut, D: D };
  }
  function mean(arr) { return arr.length ? arr.reduce(function (a, b) { return a + b; }, 0) / arr.length : 0; }

  // ── 並びの秩序 ψ6(U3の中で結びを4つ以上持つU2) ────────────────────────
  /**
   * linkPairsInGroup = [[trackIdA,trackIdB],...](そのスナップショットで持続していた結びのうち、
   * このU3成分の内側にあるものだけ)。membersByTrackId = Map<trackId, members配列>。
   * 戻り値: [{trackId,psi6,degree},...](次数4以上のU2だけ)。
   */
  function psi6ForGroup(sys, membersByTrackId, linkPairsInGroup) {
    var neighbors = new Map();
    function addN(a, b) { if (!neighbors.has(a)) neighbors.set(a, []); neighbors.get(a).push(b); }
    for (var p = 0; p < linkPairsInGroup.length; p++) { addN(linkPairsInGroup[p][0], linkPairsInGroup[p][1]); addN(linkPairsInGroup[p][1], linkPairsInGroup[p][0]); }
    var centroidCache = new Map();
    function centroidOf(tid) {
      if (!centroidCache.has(tid)) { var shp = unitShape(sys, membersByTrackId.get(tid)); centroidCache.set(tid, [shp.rawCx, shp.rawCy]); }
      return centroidCache.get(tid);
    }
    var out = [], L = sys.L;
    for (var pair of neighbors) {
      var tid = pair[0], nbs = pair[1];
      if (nbs.length < 4) continue;
      var c0 = centroidOf(tid), sumRe = 0, sumIm = 0;
      for (var n = 0; n < nbs.length; n++) {
        var c1 = centroidOf(nbs[n]), di = c1[0] - c0[0], dj = c1[1] - c0[1];
        if (di > L / 2) di -= L; else if (di < -L / 2) di += L;
        if (dj > L / 2) dj -= L; else if (dj < -L / 2) dj += L;
        // 斜交座標(i,j)を三角格子の実座標(x,y)へ変換してから角度を取る(そうしないと6方向が
        // 60°間隔にならず、ψ6が6回対称を正しく測れない。系統(i,j)->(x,y): x=i+0.5j, y=(√3/2)j)
        var dx = di + 0.5 * dj, dy = (Math.sqrt(3) / 2) * dj;
        var theta = Math.atan2(dy, dx);
        sumRe += Math.cos(6 * theta); sumIm += Math.sin(6 * theta);
      }
      out.push({ trackId: tid, degree: nbs.length, psi6: Math.hypot(sumRe / nbs.length, sumIm / nbs.length) });
    }
    return out;
  }

  // ── 分裂・融合の「候補+成り行き」(K-144) ────────────────────────────────
  /**
   * 持続するU2の分裂・融合を、候補の判定(この関数のstep呼び出し内)と、τ_pスナップショット以内の
   * 成り行き(戻った/断片が溶けた/残った、割れ戻った/残った)の追跡に分けて提供する。
   * s59のClusterTracker(塊の分裂/融合)と同じ設計を、U2トラック(trackId+Tの集合)向けに書き直した。
   */
  function FissionFusionTracker(n2min, tauP) {
    this.n2min = n2min; this.tauP = tauP;
    this.prevPersistent = new Map(); // trackId -> Set(T ids)
    this.pending = []; // {type,tStart,deadline,...}
    this.events = [];
  }
  /**
   * currAll = [{trackId, tSet(Set)}, ...](このスナップショットの**全候補**。持続していなくてもよい
   * ——分裂した直後の断片はまだ持続の資格(3スナップショット)を満たさないため)。
   * currPersistentIds = Set(このスナップショットで持続と判定されたtrackId)。
   */
  FissionFusionTracker.prototype.step = function (t, currAll, currPersistentIds) {
    var currByTrack = new Map(); for (var c = 0; c < currAll.length; c++) currByTrack.set(currAll[c].trackId, currAll[c].tSet);
    var fired = [];

    // ① 分裂の候補: 前回persistentだったtrackの T が、今回2つ以上のtrackへ分かれたか
    for (var pair of this.prevPersistent) {
      var oldTrack = pair[0], oldSet = pair[1], oldSize = oldSet.size;
      var dist = new Map(); // 新trackId -> 重なりの数
      for (var t2 of oldSet) {
        for (var pair2 of currByTrack) { if (pair2[1].has(t2)) { dist.set(pair2[0], (dist.get(pair2[0]) || 0) + 1); break; } }
      }
      // 断片ごとの実際のT集合も保存する(成り行きの判定に「吸収されたか」を見るため必要)
      var fragSetOf = new Map();
      for (var t2b of oldSet) {
        for (var pair2b of currByTrack) { if (pair2b[1].has(t2b)) { if (!fragSetOf.has(pair2b[0])) fragSetOf.set(pair2b[0], new Set()); fragSetOf.get(pair2b[0]).add(t2b); break; } }
      }
      var fragList = Array.from(dist.entries()).map(function (e) { return { trackId: e[0], size: e[1] }; }).sort(function (a, b) { return b.size - a.size; });
      var minFrag = Math.max(this.n2min, Math.ceil(0.2 * oldSize));
      var allQualifying = fragList.filter(function (f) { return f.size >= minFrag; });
      if (allQualifying.length >= 2) {
        var fragA = allQualifying[0].trackId, fragB = allQualifying[1].trackId;
        this.pending.push({
          type: 'fission', tStart: t, stepsLeft: this.tauP, parentTrack: oldTrack, parentSize: oldSize,
          fragA: fragA, fragB: fragB, fragSizes: [allQualifying[0].size, allQualifying[1].size],
          fragAOrigSet: fragSetOf.get(fragA), fragBOrigSet: fragSetOf.get(fragB),
        });
        fired.push({ t, type: 'fission-candidate', parentTrack: oldTrack, parentSize: oldSize, fragA: fragA, fragB: fragB, fragSizes: [allQualifying[0].size, allQualifying[1].size] });
      }
    }

    // ② 融合の候補: 2つ以上の旧persistentトラックが、各々「過半」を今回の同じtrackへ渡したか
    var contributionsToNew = new Map(); // 新trackId -> [{oldTrack,frac}]
    for (var pair3 of this.prevPersistent) {
      var oldTrack2 = pair3[0], oldSet2 = pair3[1];
      var dist2 = new Map();
      for (var t3 of oldSet2) { for (var pair4 of currByTrack) { if (pair4[1].has(t3)) { dist2.set(pair4[0], (dist2.get(pair4[0]) || 0) + 1); break; } } }
      for (var np of dist2) {
        var newTrack = np[0], cnt = np[1];
        if (cnt / oldSet2.size > 0.5) {
          if (!contributionsToNew.has(newTrack)) contributionsToNew.set(newTrack, []);
          contributionsToNew.get(newTrack).push({ oldTrack: oldTrack2, oldSize: oldSet2.size });
        }
      }
    }
    for (var cn of contributionsToNew) {
      var newTrack2 = cn[0], contributors = cn[1];
      if (contributors.length >= 2) {
        this.pending.push({ type: 'fusion', tStart: t, stepsLeft: this.tauP, mergedTrack: newTrack2, oldTracks: contributors.map(function (c) { return c.oldTrack; }), oldSizes: contributors.map(function (c) { return c.oldSize; }) });
        fired.push({ t, type: 'fusion-candidate', mergedTrack: newTrack2, oldTracks: contributors.map(function (c) { return c.oldTrack; }), oldSizes: contributors.map(function (c) { return c.oldSize; }) });
      }
    }

    // ③ 保留中の事象の成り行きを更新
    var stillPending = [];
    for (var e = 0; e < this.pending.length; e++) {
      var ev = this.pending[e]; ev.stepsLeft--;
      if (ev.type === 'fission') {
        var aSet = currByTrack.get(ev.fragA), bSet = currByTrack.get(ev.fragB);
        var aPresent = !!aSet, bPresent = !!bSet;
        var outcome = null;
        if (!aPresent && !bPresent) {
          outcome = '断片が溶けた';
        } else if (aPresent && bPresent) {
          // 両方まだ別のtrackIdとして存在。T集合の重なりが大きければ実質同じ候補に戻ったとみなす
          var ov = 0; for (var xx of aSet) if (bSet.has(xx)) ov++;
          var minSize = Math.min(aSet.size, bSet.size);
          if (minSize > 0 && ov / minSize >= 0.8) outcome = '戻った';
        } else {
          // 片方だけ存在。消えた側の元のT集合が、残った側に(過半)吸収されていれば「戻った」、
          // そうでなければ「断片が溶けた」(単に候補の資格を失って消えた)
          var survivorSet = aPresent ? aSet : bSet;
          var goneOrigSet = aPresent ? ev.fragBOrigSet : ev.fragAOrigSet;
          var absorbed = 0; if (goneOrigSet) for (var yy of goneOrigSet) if (survivorSet.has(yy)) absorbed++;
          outcome = (goneOrigSet && goneOrigSet.size > 0 && absorbed / goneOrigSet.size >= 0.5) ? '戻った' : '断片が溶けた';
        }
        if (outcome) { this.events.push({ t: ev.tStart, type: 'fission', parentTrack: ev.parentTrack, parentSize: ev.parentSize, fragSizes: ev.fragSizes, outcome: outcome, tOutcome: t }); continue; }
        if (ev.stepsLeft <= 0) { this.events.push({ t: ev.tStart, type: 'fission', parentTrack: ev.parentTrack, parentSize: ev.parentSize, fragSizes: ev.fragSizes, outcome: '残った', tOutcome: t }); continue; }
        stillPending.push(ev);
      } else {
        var mSet = currByTrack.get(ev.mergedTrack);
        var mAlive = mSet && mSet.size >= this.n2min;
        if (!mAlive) { this.events.push({ t: ev.tStart, type: 'fusion', oldTracks: ev.oldTracks, oldSizes: ev.oldSizes, outcome: '残った(消滅)', tOutcome: t }); continue; }
        // 「割れ戻った」: 併合先のtrackが今回のfission候補検出に引っかかっている(=直後に割れた)
        var splitBack = fired.some(function (f) { return f.type === 'fission-candidate' && f.parentTrack === ev.mergedTrack; });
        if (splitBack) { this.events.push({ t: ev.tStart, type: 'fusion', oldTracks: ev.oldTracks, oldSizes: ev.oldSizes, outcome: '割れ戻った', tOutcome: t }); continue; }
        if (ev.stepsLeft <= 0) { this.events.push({ t: ev.tStart, type: 'fusion', oldTracks: ev.oldTracks, oldSizes: ev.oldSizes, outcome: '残った', tOutcome: t }); continue; }
        stillPending.push(ev);
      }
    }
    this.pending = stillPending;

    // 次回のprevPersistentを更新(今回persistentだったものだけ)
    var newPrev = new Map();
    for (var pc of currAll) if (currPersistentIds.has(pc.trackId)) newPrev.set(pc.trackId, pc.tSet);
    this.prevPersistent = newPrev;

    return fired;
  };
  FissionFusionTracker.prototype.finalize = function (t) {
    for (var i = 0; i < this.pending.length; i++) {
      var ev = this.pending[i];
      if (ev.type === 'fission') this.events.push({ t: ev.tStart, type: 'fission', parentTrack: ev.parentTrack, parentSize: ev.parentSize, fragSizes: ev.fragSizes, outcome: '判定不能(窓の終わり)', tOutcome: t });
      else this.events.push({ t: ev.tStart, type: 'fusion', oldTracks: ev.oldTracks, oldSizes: ev.oldSizes, outcome: '判定不能(窓の終わり)', tOutcome: t });
    }
    this.pending = [];
  };

  return {
    UnionFind: UnionFind,
    buildU1: buildU1, chainHead: chainHead,
    buildTContactGraph: buildTContactGraph, buildU2Candidates: buildU2Candidates, U2IdentityTracker: U2IdentityTracker,
    minLatticeGap: minLatticeGap, instantLinks: instantLinks, LinkTracker: LinkTracker, buildU3: buildU3,
    unitShape: unitShape, pIo: pIo,
    nullPhi2Inst: nullPhi2Inst, nullPhi3Inst: nullPhi3Inst, rot60: rot60,
    jaccard: jaccard, advanceUnwrapped: advanceUnwrapped, computeMSD: computeMSD, psi6ForGroup: psi6ForGroup,
    FissionFusionTracker: FissionFusionTracker,
  };
});
