/**
 * S-58 の観測器（criteria.json observerDetails をそのままコードにしたもの）。
 * 上位概念（生物学）の語彙を使ってよいのはここだけ。core.js は使わない。
 *
 * 塊(bond graph→連結成分)・形(慣性テンソル)・分裂/融合(持続する事象)・組(共に動く持続する結び)・
 * 追跡(Π)・パターンの型(第1層/第2層)を提供する。Node/ブラウザ両対応(UMD)。
 */
'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.S58T = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function minImageDelta(a, b, L) { let d = a - b; d -= L * Math.round(d / L); return d; }

  // ── 塊(bond graph → 連結成分) ────────────────────────────────────────
  class UnionFind {
    constructor(n) { this.parent = new Int32Array(n); for (let i = 0; i < n; i++) this.parent[i] = i; }
    find(a) { while (this.parent[a] !== a) { this.parent[a] = this.parent[this.parent[a]]; a = this.parent[a]; } return a; }
    union(a, b) { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent[ra] = rb; }
  }

  /** 隣接(minImage距離<rb)のペアを、core.findOverlappingPairsと同じ形の探索器を受けて求める。 */
  function contactPairs(sys, rb, findPairsFn) { return findPairsFn(sys, rb); }

  /** 連結成分(塊)を作る。edges=[[i,j],...]。戻り値: {clusters:[{id,members:[idx,...]}], membership:Int32Array}。 */
  function buildClusters(N, edges) {
    const uf = new UnionFind(N);
    for (const [i, j] of edges) uf.union(i, j);
    const byRoot = new Map();
    for (let i = 0; i < N; i++) {
      const r = uf.find(i);
      if (!byRoot.has(r)) byRoot.set(r, []);
      byRoot.get(r).push(i);
    }
    const clusters = []; const membership = new Int32Array(N).fill(-1);
    let cid = 0;
    for (const members of byRoot.values()) {
      const id = cid++;
      for (const m of members) membership[m] = id;
      clusters.push({ id, members, size: members.length });
    }
    return { clusters, membership };
  }

  /** 直近3スナップショットすべてで結合しているペアだけを残す持続する結合の履歴器。 */
  class PersistentBonds {
    constructor(windowLen) { this.windowLen = windowLen || 3; this.history = []; }
    push(edgeKeySet) { this.history.push(edgeKeySet); if (this.history.length > this.windowLen) this.history.shift(); }
    persistentEdges() {
      if (this.history.length < this.windowLen) return null;
      let inter = this.history[0];
      for (let k = 1; k < this.history.length; k++) {
        const next = new Set();
        for (const e of inter) if (this.history[k].has(e)) next.add(e);
        inter = next;
      }
      return inter;
    }
  }
  function edgeKey(i, j) { return i < j ? i + '_' + j : j + '_' + i; }

  // ── 形(慣性テンソル): A(非円形度)・q(回転半径比) ───────────────────────
  /** クラスタ内メンバーを周期境界から展開(unwrap)する。edgesはクラスタ内の結合(BFS用の辺)。 */
  function unwrapCluster(members, x, y, L, adjacency) {
    const pos = new Map();
    const start = members[0];
    pos.set(start, [x[start], y[start]]);
    const visited = new Set([start]);
    const queue = [start];
    while (queue.length) {
      const u = queue.shift();
      const [ux, uy] = pos.get(u);
      const neigh = adjacency.get(u) || [];
      for (const v of neigh) {
        if (visited.has(v)) continue;
        const dx = minImageDelta(x[v], x[u], L), dy = minImageDelta(y[v], y[u], L);
        pos.set(v, [ux + dx, uy + dy]);
        visited.add(v); queue.push(v);
      }
    }
    // adjacencyで到達できなかった孤立メンバー(単独粒子など)は素の座標を使う
    for (const m of members) if (!pos.has(m)) pos.set(m, [x[m], y[m]]);
    return pos;
  }
  function hexDiscRg(n) { return 1.05 * Math.sqrt(n * Math.sqrt(3) / (4 * Math.PI)); }
  /** 戻り値: {A, q, wrapRank}。回り込む塊(箱の半分を超える広がり)は形を計算せず wrapRank=1 を返す。 */
  function clusterShape(members, x, y, L, adjacency) {
    if (members.length < 2) return { A: 0, q: 0, wrapRank: 0 };
    const posMap = unwrapCluster(members, x, y, L, adjacency);
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const m of members) { const [px, py] = posMap.get(m); minX = Math.min(minX, px); maxX = Math.max(maxX, px); minY = Math.min(minY, py); maxY = Math.max(maxY, py); }
    if (maxX - minX > L / 2 || maxY - minY > L / 2) return { A: null, q: null, wrapRank: 1 };
    let cx = 0, cy = 0;
    for (const m of members) { const [px, py] = posMap.get(m); cx += px; cy += py; }
    cx /= members.length; cy /= members.length;
    let Ixx = 0, Iyy = 0, Ixy = 0;
    for (const m of members) {
      const [px, py] = posMap.get(m); const dx = px - cx, dy = py - cy;
      Ixx += dy * dy; Iyy += dx * dx; Ixy -= dx * dy;
    }
    Ixx /= members.length; Iyy /= members.length; Ixy /= members.length;
    const tr = Ixx + Iyy, det = Ixx * Iyy - Ixy * Ixy, disc = Math.max(0, tr * tr / 4 - det);
    const l1 = tr / 2 + Math.sqrt(disc), l2 = tr / 2 - Math.sqrt(disc);
    const A = (l1 + l2) < 1e-12 ? 0 : Math.pow((l1 - l2) / (l1 + l2), 2);
    const Rg = Math.sqrt(Math.max(0, l1 + l2));
    const q = Rg / hexDiscRg(members.length);
    return { A, q, wrapRank: 0 };
  }
  function isNonCircular(shape, Athr, qThr) {
    if (shape.wrapRank >= 1) return true;
    return shape.A >= Athr || shape.q >= qThr;
  }

  // ── クラスタの追跡(識別の継続・年齢・分裂/融合の資格判定と持続の確認) ─────
  /**
   * 相互過半(重なりがどちらの大きさの過半)で同一クラスタとみなし年齢を引き継ぐ。
   * 分裂/融合は「資格あり(次コマで割れる/一つになる)」を検出後、tauP 経過するまで
   * 断片の同一性を追い、その間ずっと分かれた(または一つの)ままなら persistent と確定する。
   */
  class ClusterTracker {
    constructor(opts) {
      this.nMin = opts.nMin; this.tauAge = opts.tauAge; this.tauP = opts.tauP;
      this.dtSnap = opts.dtSnap || 1;
      this.prev = null; // {clusters, membership, idInfo: Map(oldId -> {trackId, age, members:Set})}
      this.nextTrackId = 1;
      this.events = []; // {type:'fission'|'fusion', t, parentSize, fragSizes, persistent}
      this.pending = []; // 資格ありだがまだ持続を確認していない候補
      this.trackIdOfMembers = new Map(); // trackId -> Set(members) (直近)
      this.ambiguous = [];
    }
    /** foundClusters = {clusters:[{id,members}], membership}。t = 現在時刻。 */
    step(foundClusters, t) {
      const curById = new Map();
      for (const c of foundClusters.clusters) curById.set(c.id, { members: new Set(c.members), size: c.members.length });

      // 継続の対応づけ: 各"現在の塊"に対し、直近の追跡集合との重なりが最大のものを探す
      const matches = new Map(); // curClusterId -> {trackId, overlapFrac}
      if (this.trackIdOfMembers.size) {
        for (const [cid, info] of curById) {
          let best = null, bestOverlap = 0;
          for (const [trackId, prevSet] of this.trackIdOfMembers) {
            let ov = 0; for (const m of info.members) if (prevSet.has(m)) ov++;
            const fracCur = ov / info.members.size, fracPrev = ov / prevSet.size;
            if (fracCur > 0.5 && fracPrev > 0.5 && ov > bestOverlap) { bestOverlap = ov; best = trackId; }
          }
          if (best != null) matches.set(cid, best);
        }
      }
      // 新しい追跡状態を構築
      const newTrackSets = new Map();
      const idInfoNow = new Map();
      for (const [cid, info] of curById) {
        let trackId = matches.get(cid);
        let age;
        if (trackId != null) { age = (this.ageOf.get(trackId) || 0) + this.dtSnap; }
        else { trackId = this.nextTrackId++; age = 0; }
        newTrackSets.set(trackId, info.members);
        idInfoNow.set(cid, { trackId, age, size: info.size });
      }
      this.ageOf = new Map(); for (const [tid, info] of idInfoNow) this.ageOf.set(info.trackId, info.age);
      // qualifies判定(パターン: n>=nMin かつ age>=tauAge)
      for (const [cid, info] of idInfoNow) info.qualifies = info.size >= this.nMin && info.age >= this.tauAge;

      // 分裂/融合の"資格あり"候補を検出: 直近の各trackIdの旧メンバーが、今どのtrackIdへ分散したか
      if (this.trackIdOfMembers.size) {
        const oldToNewTracks = new Map(); // oldTrackId -> Map(newTrackId -> count)
        for (const [oldTid, oldSet] of this.trackIdOfMembers) {
          const dist = new Map();
          for (const m of oldSet) {
            for (const [newTid, newSet] of newTrackSets) if (newSet.has(m)) { dist.set(newTid, (dist.get(newTid) || 0) + 1); break; }
          }
          oldToNewTracks.set(oldTid, dist);
        }
        for (const [oldTid, dist] of oldToNewTracks) {
          const oldSize = this.trackIdOfMembers.get(oldTid).size;
          const oldAge = this.ageOf2 ? this.ageOf2.get(oldTid) || 0 : 0;
          if (dist.size >= 2 && oldAge >= this.tauAge && oldSize >= 2 * this.nMin) {
            const fragSizes = Array.from(dist.entries()).map(([tid, cnt]) => ({ tid, cnt })).sort((a, b) => b.cnt - a.cnt);
            const minFrag = Math.max(this.nMin, Math.ceil(0.2 * oldSize));
            const qualifyingFrags = fragSizes.filter((f) => f.cnt >= minFrag);
            if (qualifyingFrags.length >= 2) {
              this.pending.push({
                type: 'fission', tStart: t, deadline: t + this.tauP,
                fragA: qualifyingFrags[0].tid, fragB: qualifyingFrags[1].tid,
                parentSize: oldSize, fragSizes: qualifyingFrags.map((f) => f.cnt),
              });
            }
          }
        }
        // 融合の資格: 2つ以上のold trackが1つのnew trackへ合流
        const newFromOlds = new Map();
        for (const [oldTid, dist] of oldToNewTracks) {
          for (const [newTid] of dist) { if (!newFromOlds.has(newTid)) newFromOlds.set(newTid, []); newFromOlds.get(newTid).push(oldTid); }
        }
        for (const [newTid, olds] of newFromOlds) {
          const qualifyingOlds = olds.filter((oldTid) => {
            const oldSet = this.trackIdOfMembers.get(oldTid);
            const oldAge = this.ageOf2 ? this.ageOf2.get(oldTid) || 0 : 0;
            return oldSet.size >= this.nMin && oldAge >= this.tauAge;
          });
          if (qualifyingOlds.length >= 2) {
            this.pending.push({ type: 'fusion', tStart: t, deadline: t + this.tauP, mergedTrack: newTid, oldSizes: qualifyingOlds.map((o) => this.trackIdOfMembers.get(o).size) });
          }
        }
      }

      // pending の判定を進める: fission→2断片が一度も同じtrackに戻らずn_min以上を保ったか
      const stillPending = [];
      for (const ev of this.pending) {
        if (ev.type === 'fission') {
          const aPresent = newTrackSets.has(ev.fragA), bPresent = newTrackSets.has(ev.fragB);
          const aSize = aPresent ? newTrackSets.get(ev.fragA).size : 0, bSize = bPresent ? newTrackSets.get(ev.fragB).size : 0;
          const broken = !aPresent || !bPresent || aSize < this.nMin || bSize < this.nMin;
          if (broken) { continue; } // 資格を失った(併合し直した・縮んだ)→ 破棄(件数に入れない)
          if (t >= ev.deadline) { this.events.push({ type: 'fission', t: ev.tStart, parentSize: ev.parentSize, fragSizes: ev.fragSizes, persistent: true }); continue; }
          stillPending.push(ev);
        } else {
          const present = newTrackSets.has(ev.mergedTrack);
          const size = present ? newTrackSets.get(ev.mergedTrack).size : 0;
          if (!present || size < this.nMin) continue;
          if (t >= ev.deadline) { this.events.push({ type: 'fusion', t: ev.tStart, oldSizes: ev.oldSizes, mergedSize: size, persistent: true }); continue; }
          stillPending.push(ev);
        }
      }
      this.pending = stillPending;

      this.trackIdOfMembers = newTrackSets;
      this.ageOf2 = this.ageOf;
      this.prevCurToInfo = idInfoNow;
      return idInfoNow; // cid -> {trackId, age, size, qualifies}
    }
    /** 観測窓の終わりで、なお解決していない候補は「判定不能」として別枠に落とす。 */
    finalize() {
      for (const ev of this.pending) this.ambiguous.push(Object.assign({ reason: '窓の終わりまでに持続を確認できなかった' }, ev));
      this.pending = [];
    }
  }

  // ── 組(共に動く持続する結び。Φ2) ──────────────────────────────────────
  /** 隙間(最近接粒子間距離−σ)を求める(簡易: 両塊の全メンバー間最小距離)。 */
  function minGapBetween(membersP, membersQ, x, y, L) {
    let best = Infinity;
    for (const i of membersP) for (const j of membersQ) {
      const dx = minImageDelta(x[i], x[j], L), dy = minImageDelta(y[i], y[j], L);
      best = Math.min(best, Math.hypot(dx, dy) - 1);
    }
    return best;
  }

  /** 組の持続を追う軽量トラッカー: パターンtrackId対ごとに連続成立コマ数を数える。 */
  class LinkTracker {
    constructor(tauLink, dtSnap) { this.tauLink = tauLink; this.dtSnap = dtSnap || 1; this.active = new Map(); }
    key(a, b) { return a < b ? a + '_' + b : b + '_' + a; }
    /** linkedPairs = [[trackIdA, trackIdB], ...]（このコマで条件を満たす対）。戻り値: 持続link(tauLink到達)集合。 */
    step(linkedPairs) {
      const nowSet = new Set(linkedPairs.map(([a, b]) => this.key(a, b)));
      for (const k of Array.from(this.active.keys())) if (!nowSet.has(k)) this.active.delete(k);
      const persistent = [];
      for (const k of nowSet) {
        const dur = (this.active.get(k) || 0) + this.dtSnap;
        this.active.set(k, dur);
        if (dur >= this.tauLink) persistent.push(k);
      }
      return persistent;
    }
  }

  // ── 追跡(Π) ────────────────────────────────────────────────────────
  /**
   * Π = P_AB - P_BA。P_AB = A粒子の「最近接Bへの単位ベクトル・速度」の平均、P_BAはその逆。
   * R以内に相手を持つ粒子だけで平均する。戻り値: {PI, PAB, PBA, coverage}。
   */
  function pursuitMetric(sys, R) {
    const N = sys.N, L = sys.L;
    let sumA = 0, cntA = 0, sumB = 0, cntB = 0;
    const idxByType = [[], []];
    for (let i = 0; i < N; i++) idxByType[sys.type[i]].push(i);
    function nearestOther(i, otherList) {
      let best = -1, bestD = Infinity, bdx = 0, bdy = 0;
      for (const j of otherList) {
        const dx = minImageDelta(sys.x[j], sys.x[i], L), dy = minImageDelta(sys.y[j], sys.y[i], L);
        const d = Math.hypot(dx, dy);
        if (d < bestD) { bestD = d; best = j; bdx = dx; bdy = dy; }
      }
      return { j: best, d: bestD, dx: bdx, dy: bdy };
    }
    for (const i of idxByType[0]) {
      const n = nearestOther(i, idxByType[1]);
      if (n.j < 0 || n.d > R || n.d < 1e-9) continue;
      const ex = n.dx / n.d, ey = n.dy / n.d;
      sumA += sys.vx[i] * ex + sys.vy[i] * ey; cntA++;
    }
    for (const j of idxByType[1]) {
      const n = nearestOther(j, idxByType[0]);
      if (n.j < 0 || n.d > R || n.d < 1e-9) continue;
      const ex = n.dx / n.d, ey = n.dy / n.d;
      sumB += sys.vx[j] * ex + sys.vy[j] * ey; cntB++;
    }
    const PAB = cntA ? sumA / cntA : 0, PBA = cntB ? sumB / cntB : 0;
    const coverage = N ? (cntA + cntB) / N : 0;
    return { PI: PAB - PBA, PAB, PBA, coverage };
  }

  return {
    minImageDelta, UnionFind, buildClusters, PersistentBonds, edgeKey,
    unwrapCluster, hexDiscRg, clusterShape, isNonCircular,
    ClusterTracker, minGapBetween, LinkTracker, pursuitMetric,
  };
});
