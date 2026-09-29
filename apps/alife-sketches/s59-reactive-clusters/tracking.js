/**
 * S-59 の観測器(criteria.json observerDetails をそのままコードにしたもの)。
 * 上位概念(生物学)の語彙を使ってよいのはここだけ。core.js は使わない(s2-implement.md の禁則)。
 *
 * 塊(S-Sの持続する結合→連結成分)・形(慣性テンソルのAとq)・穴(環の検出)・型分類(K/R/E/B/S)・
 * 分裂/融合(持続する事象・原因の判定)・組(共に動く持続する結び。Φ2)・選択(誕生のθ)を提供する。
 * Node/ブラウザ両対応(UMD)。依存ゼロ。
 */
'use strict';
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S59T = api;
})(typeof self !== 'undefined' ? self : this, function () {
  function minImageDelta(a, b, L) { var d = a - b; d -= L * Math.round(d / L); return d; }

  // ── 塊(bond graph → 連結成分) ────────────────────────────────────────
  function UnionFind(n) {
    this.parent = new Int32Array(n);
    for (var i = 0; i < n; i++) this.parent[i] = i;
  }
  UnionFind.prototype.find = function (a) {
    while (this.parent[a] !== a) { this.parent[a] = this.parent[this.parent[a]]; a = this.parent[a]; }
    return a;
  };
  UnionFind.prototype.union = function (a, b) {
    var ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent[ra] = rb;
  };

  /** members(粒子番号の配列。塊の候補母集団)と edges([[i,j],...])から連結成分を作る。 */
  function buildClusters(members, edges) {
    var idxOf = new Map(); for (var m = 0; m < members.length; m++) idxOf.set(members[m], m);
    var uf = new UnionFind(members.length);
    for (var e = 0; e < edges.length; e++) {
      var a = idxOf.get(edges[e][0]), b = idxOf.get(edges[e][1]);
      if (a != null && b != null) uf.union(a, b);
    }
    var byRoot = new Map();
    for (var i = 0; i < members.length; i++) {
      var r = uf.find(i);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r).push(members[i]);
    }
    var clusters = [], cid = 0;
    for (var arr of byRoot.values()) clusters.push({ id: cid++, members: arr, size: arr.length });
    return clusters;
  }

  /** S-S の対で r<rb の接触(全対探索。S粒子数は高々数百なので十分速い)。 */
  function findBonds(sys, rb, TYPE_S) {
    var sIdx = [];
    for (var i = 0; i < sys.N; i++) if (sys.type[i] === TYPE_S) sIdx.push(i);
    var pairs = [];
    for (var a = 0; a < sIdx.length; a++) {
      for (var b = a + 1; b < sIdx.length; b++) {
        var ii = sIdx[a], jj = sIdx[b];
        var dx = minImageDelta(sys.x[ii], sys.x[jj], sys.L), dy = minImageDelta(sys.y[ii], sys.y[jj], sys.L);
        var r = Math.hypot(dx, dy);
        if (r < rb) pairs.push([ii, jj, r]);
      }
    }
    return { sIdx: sIdx, pairs: pairs };
  }

  /** 直近 windowLen スナップショットすべてで結合しているペアだけを残す持続する結合の履歴器。 */
  function PersistentBonds(windowLen) { this.windowLen = windowLen || 3; this.history = []; }
  PersistentBonds.prototype.push = function (edgeKeySet) {
    this.history.push(edgeKeySet); if (this.history.length > this.windowLen) this.history.shift();
  };
  PersistentBonds.prototype.persistentEdges = function () {
    if (this.history.length < this.windowLen) return null;
    var inter = this.history[0];
    for (var k = 1; k < this.history.length; k++) {
      var next = new Set(); for (var e of inter) if (this.history[k].has(e)) next.add(e);
      inter = next;
    }
    return inter;
  };
  function edgeKey(i, j) { return i < j ? i + '_' + j : j + '_' + i; }

  // ── 形(慣性テンソル): A(非円形度)・q(回転半径比) ───────────────────────
  function unwrapCluster(members, x, y, L, adjacency) {
    var pos = new Map(), start = members[0];
    pos.set(start, [x[start], y[start]]);
    var visited = new Set([start]), queue = [start], qi = 0;
    while (qi < queue.length) {
      var u = queue[qi++], up = pos.get(u), neigh = adjacency.get(u) || [];
      for (var k = 0; k < neigh.length; k++) {
        var v = neigh[k];
        if (visited.has(v)) continue;
        var dx = minImageDelta(x[v], x[u], L), dy = minImageDelta(y[v], y[u], L);
        pos.set(v, [up[0] + dx, up[1] + dy]); visited.add(v); queue.push(v);
      }
    }
    for (var m = 0; m < members.length; m++) if (!pos.has(members[m])) pos.set(members[m], [x[members[m]], y[members[m]]]);
    return pos;
  }
  /** 六方円盤の回転半径(間隔 a=1.10σ 既定)。 */
  function hexDiscRg(n, a) { a = a || 1.10; return a * Math.sqrt(n * Math.sqrt(3) / (4 * Math.PI)); }
  /** 戻り値: {A,q,wrapRank,posMap}。半分を超えて広がる塊(回り込み)は形を計算しない。 */
  function clusterShape(members, x, y, L, adjacency, hexA) {
    if (members.length < 2) return { A: 0, q: 0, wrapRank: 0, posMap: null };
    var posMap = unwrapCluster(members, x, y, L, adjacency);
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var m = 0; m < members.length; m++) {
      var p = posMap.get(members[m]);
      if (p[0] < minX) minX = p[0]; if (p[0] > maxX) maxX = p[0];
      if (p[1] < minY) minY = p[1]; if (p[1] > maxY) maxY = p[1];
    }
    if (maxX - minX > L / 2 || maxY - minY > L / 2) return { A: null, q: null, wrapRank: 1, posMap: posMap };
    var cx = 0, cy = 0;
    for (m = 0; m < members.length; m++) { var pp = posMap.get(members[m]); cx += pp[0]; cy += pp[1]; }
    cx /= members.length; cy /= members.length;
    var Ixx = 0, Iyy = 0, Ixy = 0;
    for (m = 0; m < members.length; m++) {
      var p2 = posMap.get(members[m]), dx = p2[0] - cx, dy = p2[1] - cy;
      Ixx += dy * dy; Iyy += dx * dx; Ixy -= dx * dy;
    }
    Ixx /= members.length; Iyy /= members.length; Ixy /= members.length;
    var tr = Ixx + Iyy, det = Ixx * Iyy - Ixy * Ixy, disc = Math.max(0, tr * tr / 4 - det);
    var l1 = tr / 2 + Math.sqrt(disc), l2 = tr / 2 - Math.sqrt(disc);
    var A = (l1 + l2) < 1e-12 ? 0 : Math.pow((l1 - l2) / (l1 + l2), 2);
    var Rg = Math.sqrt(Math.max(0, l1 + l2));
    var q = Rg / hexDiscRg(members.length, hexA);
    return { A: A, q: q, wrapRank: 0, posMap: posMap, cx: cx, cy: cy };
  }

  // ── 穴(環の検出): 半径radiusの円盤をstepの格子へ塗り、外から塗りつぶせない空きを探す ────
  /** posMap(unwrapされた座標)から穴の面積の一覧(σ²)を返す(minArea未満は捨てる)。回り込む塊には定義しない。 */
  function findHoles(members, posMap, radius, step, minArea) {
    radius = radius || 0.75; step = step || 0.25; minArea = minArea != null ? minArea : 2;
    if (!posMap || members.length < 3) return [];
    var minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (var m = 0; m < members.length; m++) {
      var p = posMap.get(members[m]);
      if (p[0] - radius < minX) minX = p[0] - radius; if (p[0] + radius > maxX) maxX = p[0] + radius;
      if (p[1] - radius < minY) minY = p[1] - radius; if (p[1] + radius > maxY) maxY = p[1] + radius;
    }
    var pad = step * 3;
    minX -= pad; minY -= pad; maxX += pad; maxY += pad;
    var nx = Math.max(4, Math.ceil((maxX - minX) / step)), ny = Math.max(4, Math.ceil((maxY - minY) / step));
    var filled = new Uint8Array(nx * ny);
    var r2 = radius * radius;
    // 各メンバーの半径内のセルだけを塗る(バウンディングボックス限定で高速化)
    for (m = 0; m < members.length; m++) {
      var pm = posMap.get(members[m]);
      var i0 = Math.max(0, Math.floor((pm[0] - radius - minX) / step));
      var i1 = Math.min(nx - 1, Math.ceil((pm[0] + radius - minX) / step));
      var j0 = Math.max(0, Math.floor((pm[1] - radius - minY) / step));
      var j1 = Math.min(ny - 1, Math.ceil((pm[1] + radius - minY) / step));
      for (var jj = j0; jj <= j1; jj++) {
        var cy2 = minY + (jj + 0.5) * step;
        for (var ii = i0; ii <= i1; ii++) {
          var cx2 = minX + (ii + 0.5) * step;
          var dx = cx2 - pm[0], dy = cy2 - pm[1];
          if (dx * dx + dy * dy <= r2) filled[jj * nx + ii] = 1;
        }
      }
    }
    // 外枠から4近傍で塗りつぶせる空きを「外」とする(BFS)
    var outside = new Uint8Array(nx * ny);
    var queue = [], qi = 0;
    function tryPush(i, j) {
      if (i < 0 || i >= nx || j < 0 || j >= ny) return;
      var idx = j * nx + i;
      if (filled[idx] || outside[idx]) return;
      outside[idx] = 1; queue.push(idx);
    }
    for (var i = 0; i < nx; i++) { tryPush(i, 0); tryPush(i, ny - 1); }
    for (var j = 0; j < ny; j++) { tryPush(0, j); tryPush(nx - 1, j); }
    while (qi < queue.length) {
      var idx0 = queue[qi++], x0 = idx0 % nx, y0 = Math.floor(idx0 / nx);
      tryPush(x0 + 1, y0); tryPush(x0 - 1, y0); tryPush(x0, y0 + 1); tryPush(x0, y0 - 1);
    }
    // 塗られておらず外にも繋がっていないセル=穴の候補。連結成分に分けて面積を出す
    var visited = new Uint8Array(nx * ny), holes = [];
    var allCandidates = []; // minArea未満も含む全ての穴候補(ceilings/small-holes.json用)
    for (var idx1 = 0; idx1 < nx * ny; idx1++) {
      if (filled[idx1] || outside[idx1] || visited[idx1]) continue;
      var comp = [idx1]; visited[idx1] = 1; var qi2 = 0, q2 = [idx1];
      while (qi2 < q2.length) {
        var u = q2[qi2++], ux = u % nx, uy = Math.floor(u / nx);
        var neigh4 = [[ux + 1, uy], [ux - 1, uy], [ux, uy + 1], [ux, uy - 1]];
        for (var n = 0; n < 4; n++) {
          var nxp = neigh4[n][0], nyp = neigh4[n][1];
          if (nxp < 0 || nxp >= nx || nyp < 0 || nyp >= ny) continue;
          var nidx = nyp * nx + nxp;
          if (filled[nidx] || outside[nidx] || visited[nidx]) continue;
          visited[nidx] = 1; comp.push(nidx); q2.push(nidx);
        }
      }
      var area = comp.length * step * step;
      allCandidates.push({ area: area, cells: comp.length });
      if (area >= minArea) holes.push({ area: area, cells: comp.length });
    }
    holes.allCandidates = allCandidates; // 配列に非列挙のおまけ情報として載せる(既存の呼び出し側は影響を受けない)
    return holes;
  }

  /** 型(優先順): S(回り込む)＞R(穴あり)＞E(A>=Athr)＞B(A<Athr かつ q>=qThr)＞K(それ以外)。 */
  function classifyPattern(shape, holes, Athr, qThr) {
    Athr = Athr == null ? 0.5 : Athr; qThr = qThr == null ? 1.35 : qThr;
    if (shape.wrapRank >= 1) return 'S';
    if (holes && holes.length > 0) return 'R';
    if (shape.A >= Athr) return 'E';
    if (shape.A < Athr && shape.q >= qThr) return 'B';
    return 'K';
  }
  /** E・B・S の粒子割合(環Rと丸い塊Kは円状の側)。 */
  function nonCircularFraction(taggedClusters) {
    var num = 0, den = 0;
    for (var c = 0; c < taggedClusters.length; c++) {
      var cl = taggedClusters[c];
      den += cl.size;
      if (cl.patternType === 'E' || cl.patternType === 'B' || cl.patternType === 'S') num += cl.size;
    }
    return den > 0 ? num / den : 0;
  }
  /** S-58型の定義(比較用): A>=0.5 または q>=1.35 または回り込む。 */
  function nonCircularFractionS58Style(clustersWithShape, Athr, qThr) {
    Athr = Athr == null ? 0.5 : Athr; qThr = qThr == null ? 1.35 : qThr;
    var num = 0, den = 0;
    for (var c = 0; c < clustersWithShape.length; c++) {
      var cl = clustersWithShape[c];
      den += cl.size;
      var nc = cl.wrapRank >= 1 || (cl.A != null && cl.A >= Athr) || (cl.q != null && cl.q >= qThr);
      if (nc) num += cl.size;
    }
    return den > 0 ? num / den : 0;
  }

  // ── 崩壊による切断か力による分離か ──────────────────────────────────────
  /**
   * parentMembers/parentEdges(t-1の持続結合)から decayedSet(その間にWになった粒子)を除いた残りが、
   * fragAMembers・fragBMembers を(代表点で)既に別成分へ分けているなら「崩壊による切断」。
   */
  function classifyFissionCause(parentMembers, parentEdges, decayedSet, fragAMembers, fragBMembers) {
    var remaining = parentMembers.filter(function (m) { return !decayedSet.has(m); });
    var edges = parentEdges.filter(function (e) { return !decayedSet.has(e[0]) && !decayedSet.has(e[1]); });
    var clusters = buildClusters(remaining, edges);
    var rootOf = new Map();
    for (var c = 0; c < clusters.length; c++) for (var m = 0; m < clusters[c].members.length; m++) rootOf.set(clusters[c].members[m], c);
    var aRoots = new Set(), bRoots = new Set();
    for (var i = 0; i < fragAMembers.length; i++) { var r = rootOf.get(fragAMembers[i]); if (r != null) aRoots.add(r); }
    for (var j = 0; j < fragBMembers.length; j++) { var r2 = rootOf.get(fragBMembers[j]); if (r2 != null) bRoots.add(r2); }
    var overlap = false;
    for (var ar of aRoots) if (bRoots.has(ar)) overlap = true;
    return (!overlap && aRoots.size > 0 && bRoots.size > 0) ? 'decay-cut' : 'force-separation';
  }

  // ── クラスタの追跡(同一性の継続・年齢・分裂/融合の資格判定と持続の確認) ─────
  function ClusterTracker(opts) {
    this.nMin = opts.nMin; this.tauAge = opts.tauAge; this.tauP = opts.tauP; this.dtSnap = opts.dtSnap || 1;
    this.nextTrackId = 1;
    this.events = []; this.pending = []; this.ambiguous = [];
    this.trackIdOfMembers = new Map(); this.ageOf = new Map();
    this.prevEdges = []; // 直近に渡された edges(このstep呼び出しの「親」の持続結合グラフとして次回使う)
  }
  /**
   * clusters/t/decayedSet に加え、今回の観測が使った持続結合 edges([[i,j],...])を渡す。
   * 分裂の原因判定(classifyFissionCause)は「t-1時点の親の持続結合グラフ」を要求するため、
   * ここで受け取った edges は**次回の呼び出し**で this.prevEdges として使う(1回遅らせる)。
   */
  ClusterTracker.prototype.step = function (clusters, t, decayedSet, edges) {
    var edgesForThisCall = this.prevEdges; // t-1時点の親の持続結合グラフ
    var self = this;
    var curById = new Map();
    for (var c = 0; c < clusters.length; c++) curById.set(clusters[c].id, { members: new Set(clusters[c].members), size: clusters[c].members.length });

    var matches = new Map();
    if (this.trackIdOfMembers.size) {
      for (var pair of curById) {
        var cid = pair[0], info = pair[1];
        var best = null, bestOverlap = 0;
        for (var pair2 of this.trackIdOfMembers) {
          var trackId = pair2[0], prevSet = pair2[1];
          var ov = 0; for (var m of info.members) if (prevSet.has(m)) ov++;
          var fracCur = ov / info.members.size, fracPrev = ov / prevSet.size;
          if (fracCur > 0.5 && fracPrev > 0.5 && ov > bestOverlap) { bestOverlap = ov; best = trackId; }
        }
        if (best != null) matches.set(cid, best);
      }
    }
    var newTrackSets = new Map(), idInfoNow = new Map(), newAgeOf = new Map();
    for (var pair3 of curById) {
      var cid2 = pair3[0], info2 = pair3[1];
      var trackId2 = matches.get(cid2), age;
      if (trackId2 != null) age = (this.ageOf.get(trackId2) || 0) + this.dtSnap;
      else { trackId2 = this.nextTrackId++; age = 0; }
      newTrackSets.set(trackId2, info2.members);
      newAgeOf.set(trackId2, age);
      idInfoNow.set(cid2, { trackId: trackId2, age: age, size: info2.size, qualifies: info2.size >= this.nMin && age >= this.tauAge });
    }

    if (this.trackIdOfMembers.size) {
      var oldToNewTracks = new Map();
      for (var oldPair of this.trackIdOfMembers) {
        var oldTid = oldPair[0], oldSet = oldPair[1];
        var dist = new Map();
        for (var mm of oldSet) {
          for (var newPair of newTrackSets) { if (newPair[1].has(mm)) { dist.set(newPair[0], (dist.get(newPair[0]) || 0) + 1); break; } }
        }
        oldToNewTracks.set(oldTid, dist);
      }
      for (var otPair of oldToNewTracks) {
        var oldTid2 = otPair[0], dist2 = otPair[1];
        var oldSize = this.trackIdOfMembers.get(oldTid2).size;
        var oldAge = this.ageOf.get(oldTid2) || 0;
        if (dist2.size >= 2 && oldAge >= this.tauAge && oldSize >= 2 * this.nMin) {
          var fragSizes = Array.from(dist2.entries()).map(function (e) { return { tid: e[0], cnt: e[1] }; }).sort(function (a, b) { return b.cnt - a.cnt; });
          var minFrag = Math.max(this.nMin, Math.ceil(0.2 * oldSize));
          var qualifyingFrags = fragSizes.filter(function (f) { return f.cnt >= minFrag; });
          if (qualifyingFrags.length >= 2) {
            var parentMembers = Array.from(this.trackIdOfMembers.get(oldTid2));
            var cause = decayedSet ? classifyFissionCause(parentMembers, edgesForThisCall, decayedSet,
              Array.from(newTrackSets.get(qualifyingFrags[0].tid) || []), Array.from(newTrackSets.get(qualifyingFrags[1].tid) || [])) : 'unknown';
            this.pending.push({
              type: 'fission', tStart: t, deadline: t + this.tauP,
              fragA: qualifyingFrags[0].tid, fragB: qualifyingFrags[1].tid,
              parentSize: oldSize, fragSizes: qualifyingFrags.map(function (f) { return f.cnt; }), cause: cause,
            });
          }
        }
      }
      var newFromOlds = new Map();
      for (var otPair2 of oldToNewTracks) {
        var oldTid3 = otPair2[0], dist3 = otPair2[1];
        for (var dPair of dist3) { var newTid = dPair[0]; if (!newFromOlds.has(newTid)) newFromOlds.set(newTid, []); newFromOlds.get(newTid).push(oldTid3); }
      }
      for (var nfPair of newFromOlds) {
        var newTid2 = nfPair[0], olds = nfPair[1];
        var qualifyingOlds = olds.filter((function (self2) { return function (oldTid4) {
          var oldSet2 = self2.trackIdOfMembers.get(oldTid4), oldAge2 = self2.ageOf.get(oldTid4) || 0;
          return oldSet2.size >= self2.nMin && oldAge2 >= self2.tauAge;
        }; })(this));
        if (qualifyingOlds.length >= 2) {
          this.pending.push({ type: 'fusion', tStart: t, deadline: t + this.tauP, mergedTrack: newTid2, oldSizes: qualifyingOlds.map((function (self3) { return function (o) { return self3.trackIdOfMembers.get(o).size; }; })(this)) });
        }
      }
    }

    var stillPending = [];
    for (var e = 0; e < this.pending.length; e++) {
      var ev = this.pending[e];
      if (ev.type === 'fission') {
        var aPresent = newTrackSets.has(ev.fragA), bPresent = newTrackSets.has(ev.fragB);
        var aSize = aPresent ? newTrackSets.get(ev.fragA).size : 0, bSize = bPresent ? newTrackSets.get(ev.fragB).size : 0;
        var broken = !aPresent || !bPresent || aSize < this.nMin || bSize < this.nMin;
        if (broken) continue;
        if (t >= ev.deadline) { this.events.push({ type: 'fission', t: ev.tStart, parentSize: ev.parentSize, fragSizes: ev.fragSizes, cause: ev.cause, persistent: true }); continue; }
        stillPending.push(ev);
      } else {
        var present = newTrackSets.has(ev.mergedTrack), size = present ? newTrackSets.get(ev.mergedTrack).size : 0;
        if (!present || size < this.nMin) continue;
        if (t >= ev.deadline) { this.events.push({ type: 'fusion', t: ev.tStart, oldSizes: ev.oldSizes, mergedSize: size, persistent: true }); continue; }
        stillPending.push(ev);
      }
    }
    this.pending = stillPending;
    this.trackIdOfMembers = newTrackSets;
    this.ageOf = newAgeOf;
    this.prevEdges = edges || [];
    return idInfoNow;
  };
  ClusterTracker.prototype.finalize = function () {
    for (var i = 0; i < this.pending.length; i++) this.ambiguous.push(Object.assign({ reason: '窓の終わりまでに持続を確認できなかった' }, this.pending[i]));
    this.pending = [];
  };

  // ── 組(共に動く持続する結び。Φ2) ──────────────────────────────────────
  function minGapBetween(membersP, membersQ, x, y, L) {
    var best = Infinity;
    for (var i = 0; i < membersP.length; i++) for (var j = 0; j < membersQ.length; j++) {
      var dx = minImageDelta(x[membersP[i]], x[membersQ[j]], L), dy = minImageDelta(y[membersP[i]], y[membersQ[j]], L);
      best = Math.min(best, Math.hypot(dx, dy) - 1);
    }
    return best;
  }
  function LinkTracker(tauLink, dtSnap) { this.tauLink = tauLink; this.dtSnap = dtSnap || 1; this.active = new Map(); }
  LinkTracker.prototype.key = function (a, b) { return a < b ? a + '_' + b : b + '_' + a; };
  LinkTracker.prototype.step = function (linkedPairs) {
    var self = this, nowSet = new Set(linkedPairs.map(function (p) { return self.key(p[0], p[1]); }));
    for (var k of Array.from(this.active.keys())) if (!nowSet.has(k)) this.active.delete(k);
    var persistent = [];
    for (var kk of nowSet) {
      var dur = (this.active.get(kk) || 0) + this.dtSnap;
      this.active.set(kk, dur);
      if (dur >= this.tauLink) persistent.push(kk);
    }
    return persistent;
  };

  // ── 選択(誕生のθ) ──────────────────────────────────────────────────
  /** births = [{t,theta}]。窓ごとの平均差(遅い窓−早い窓)。件数不足(<minCount)は null(判定不能)。 */
  function deltaThetaBirth(births, windowE, windowW, minCount) {
    minCount = minCount || 50;
    var eVals = births.filter(function (b) { return b.t >= windowE[0] && b.t < windowE[1]; }).map(function (b) { return b.theta; });
    var wVals = births.filter(function (b) { return b.t >= windowW[0] && b.t < windowW[1]; }).map(function (b) { return b.theta; });
    if (eVals.length < minCount || wVals.length < minCount) return { value: null, eCount: eVals.length, wCount: wVals.length };
    var meanE = eVals.reduce(function (a, b) { return a + b; }, 0) / eVals.length;
    var meanW = wVals.reduce(function (a, b) { return a + b; }, 0) / wVals.length;
    return { value: meanW - meanE, eCount: eVals.length, wCount: wVals.length, meanE: meanE, meanW: meanW };
  }

  return {
    minImageDelta: minImageDelta, UnionFind: UnionFind, buildClusters: buildClusters, findBonds: findBonds,
    PersistentBonds: PersistentBonds, edgeKey: edgeKey,
    unwrapCluster: unwrapCluster, hexDiscRg: hexDiscRg, clusterShape: clusterShape,
    findHoles: findHoles, classifyPattern: classifyPattern, nonCircularFraction: nonCircularFraction, nonCircularFractionS58Style: nonCircularFractionS58Style,
    classifyFissionCause: classifyFissionCause, ClusterTracker: ClusterTracker,
    minGapBetween: minGapBetween, LinkTracker: LinkTracker, deltaThetaBirth: deltaThetaBirth,
  };
});
