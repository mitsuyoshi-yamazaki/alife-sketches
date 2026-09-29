/**
 * S-57: 観測器。criteria.json の observerDetails / orderParameters を実装する。
 * core.js の物理には触れない（力学と観測器を分ける）。
 *
 *   - 結合グラフ（接触 → 持続する結合 → 塊の連結成分）— 単一スナップショットでも使える
 *   - 形（A・q）とトポロジー型（K/C/R/Y/N）— 同上
 *   - 塊の同一性の追跡（相互過半）・資格ある持続的分裂／持続的な合成の検出（ClusterTracker）— 時系列
 *   - 向き（h・h_shuf）・④ 緩和と活動・⑤ エネルギーの台帳 — 時系列
 *
 * Node と viewer.html（ブラウザ）の両方で使う。ブラウザでは <script src="core.js"> の後に
 * <script src="tracking.js"> を読めば window.S57Track として使える（UMD 風。core.js と同じ形）。
 * 依存ゼロ。
 */
(function (global) {
'use strict';
const S57 = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : global.S57;

// ================================================================ 結合グラフ

/** 瞬間の接触（r < rb）の辺一覧 [[i,j],...] i<j。 */
function contactEdges(st, rb) {
  const cand = S57.neighborPairsCellList(st, Math.max(rb, 1e-9));
  const L = st.L, out = [];
  for (let k = 0; k < cand.count; k++) {
    const i = cand.I[k], j = cand.J[k];
    const dx = S57.minImage(st.x[i] - st.x[j], L), dy = S57.minImage(st.y[i] - st.y[j], L);
    if (dx * dx + dy * dy < rb * rb) out.push([i, j]);
  }
  return out;
}

/** 直近 maxLen フレームの接触辺集合を保持し、全フレームに共通する辺（持続する結合）を返す。 */
class BondHistory {
  constructor(maxLen) { this.maxLen = maxLen; this.frames = []; }
  push(edges) {
    const set = new Set(edges.map(([i, j]) => i + '_' + j));
    this.frames.push(set);
    if (this.frames.length > this.maxLen) this.frames.shift();
  }
  /** maxLen 枚そろって初めて意味を持つ（それまでは「まだ持続と呼べない」＝空集合）。 */
  persistent() {
    if (this.frames.length < this.maxLen) return [];
    let common = this.frames[0];
    for (let k = 1; k < this.frames.length; k++) {
      const nxt = new Set();
      for (const key of common) if (this.frames[k].has(key)) nxt.add(key);
      common = nxt;
    }
    return Array.from(common).map((key) => key.split('_').map(Number));
  }
}

/** N粒子・辺一覧から連結成分を求める。戻り値: {membership(Int32Array), components:[{members,size,edgeCount}]} */
function connectedComponents(N, edges) {
  const adj = new Array(N);
  for (let i = 0; i < N; i++) adj[i] = [];
  for (const [i, j] of edges) { adj[i].push(j); adj[j].push(i); }
  const membership = new Int32Array(N).fill(-1);
  const components = [];
  for (let s = 0; s < N; s++) {
    if (membership[s] !== -1) continue;
    const idx = components.length, stack = [s], members = [];
    membership[s] = idx;
    while (stack.length) {
      const u = stack.pop(); members.push(u);
      for (const v of adj[u]) if (membership[v] === -1) { membership[v] = idx; stack.push(v); }
    }
    let edgeCount = 0;
    for (const m of members) edgeCount += adj[m].length;
    edgeCount /= 2;
    components.push({ members, size: members.length, edgeCount, adj });
  }
  return { membership, components, adj };
}

// ================================================================ 形・トポロジー

/** BFS で連結成分内の座標を最近接鏡像で展開する。周期境界をまたぐ塊は wrapped=true。 */
function unwrapComponent(st, members, adj) {
  const L = st.L;
  const pos = new Map();
  const start = members[0];
  pos.set(start, [st.x[start], st.y[start]]);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const u = queue.shift();
    const [ux, uy] = pos.get(u);
    for (const v of adj[u]) {
      if (seen.has(v)) continue;
      seen.add(v);
      const dx = S57.minImage(st.x[v] - st.x[u], L), dy = S57.minImage(st.y[v] - st.y[u], L);
      pos.set(v, [ux + dx, uy + dy]);
      queue.push(v);
    }
  }
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const m of members) {
    const [x, y] = pos.get(m);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
  }
  const wrapped = (maxX - minX) > L / 2 || (maxY - minY) > L / 2;
  return { pos, wrapped };
}

/** 六方円盤（間隔 s）の n 粒子の慣性半径。criteria: R_g,disc(n) = 1.1σ·√(n√3/(4π))。 */
function hexDiscRg(n, s) { s = s || 1.1; return s * Math.sqrt(n * Math.sqrt(3) / (4 * Math.PI)); }

/** A（非球状度）・q（慣性半径 / 円盤参照）。回り込む塊は null（呼び出し側で円でない側に数える）。 */
function shapeDescriptors(st, members, adj) {
  const { pos, wrapped } = unwrapComponent(st, members, adj);
  if (wrapped) return { A: null, q: null, Rg: null, wrapped: true };
  const n = members.length;
  let cx = 0, cy = 0;
  for (const m of members) { const [x, y] = pos.get(m); cx += x; cy += y; }
  cx /= n; cy /= n;
  let Ixx = 0, Iyy = 0, Ixy = 0;
  for (const m of members) {
    const [x, y] = pos.get(m); const dx = x - cx, dy = y - cy;
    Ixx += dy * dy; Iyy += dx * dx; Ixy -= dx * dy;
  }
  Ixx /= n; Iyy /= n; Ixy /= n;
  const tr = Ixx + Iyy, det = Ixx * Iyy - Ixy * Ixy;
  const disc = Math.max(0, tr * tr / 4 - det);
  const l1 = tr / 2 + Math.sqrt(disc), l2 = tr / 2 - Math.sqrt(disc);
  const A = (l1 + l2) < 1e-12 ? 0 : Math.pow((l1 - l2) / (l1 + l2), 2);
  const Rg = Math.sqrt(Math.max(0, l1 + l2));
  const q = Rg / hexDiscRg(n);
  return { A, q, Rg, wrapped: false };
}

/** 揺らした六方円盤の A・q の分布（selftest の帰無値較正・referencePoints[0] に使う）。 */
function jitteredHexDisc(n, sdFrac, rnd, s) {
  s = s || 1.1;
  const perRow = Math.ceil(Math.sqrt(n));
  const pts = [];
  let idx = 0;
  for (let row = 0; idx < n; row++) {
    for (let col = 0; col < perRow && idx < n; col++) {
      const x = (col + (row % 2 ? 0.5 : 0)) * s, y = row * s * Math.sqrt(3) / 2;
      pts.push([x + (rnd() - 0.5) * sdFrac * s, y + (rnd() - 0.5) * sdFrac * s]);
      idx++;
    }
  }
  let cx = 0, cy = 0;
  for (const [x, y] of pts) { cx += x; cy += y; }
  cx /= n; cy /= n;
  let Ixx = 0, Iyy = 0, Ixy = 0;
  for (const [x, y] of pts) { const dx = x - cx, dy = y - cy; Ixx += dy * dy; Iyy += dx * dx; Ixy -= dx * dy; }
  Ixx /= n; Iyy /= n; Ixy /= n;
  const tr = Ixx + Iyy, det = Ixx * Iyy - Ixy * Ixy;
  const disc = Math.max(0, tr * tr / 4 - det);
  const l1 = tr / 2 + Math.sqrt(disc), l2 = tr / 2 - Math.sqrt(disc);
  const A = (l1 + l2) < 1e-12 ? 0 : Math.pow((l1 - l2) / (l1 + l2), 2);
  const q = Math.sqrt(Math.max(0, l1 + l2)) / hexDiscRg(n, s);
  return { A, q };
}

/** トポロジー型: K密(平均次数>=3.5) → C鎖(枝なし・閉路なし) → R環(枝なし・閉路1) → Y枝(枝あり・閉路なし) → N網目(枝あり・閉路あり)。 */
function topologyClass(members, edgeCount, adj) {
  const n = members.length;
  const avgDeg = n > 0 ? 2 * edgeCount / n : 0;
  if (avgDeg >= 3.5) return 'K';
  let maxDeg = 0;
  for (const m of members) maxDeg = Math.max(maxDeg, adj[m].length);
  const hasBranch = maxDeg >= 3;
  const cyclomatic = edgeCount - n + 1; // 連結成分なので +1（独立閉路数）
  const hasCycle = cyclomatic > 0;
  if (!hasBranch && !hasCycle) return 'C';
  if (!hasBranch && hasCycle) return 'R';
  if (hasBranch && !hasCycle) return 'Y';
  return 'N';
}

// ================================================================ 向き（h・h_shuf）

/** 持続する結合のうち V_dd <= thr（既定 -1.0）の割合。edges は [i,j] の持続する結合一覧。 */
function headTailFraction(st, edges, rs, rc, thr) {
  thr = thr == null ? -1.0 : thr;
  if (edges.length === 0) return null;
  let count = 0;
  const L = st.L;
  for (const [i, j] of edges) {
    const dx = S57.minImage(st.x[i] - st.x[j], L), dy = S57.minImage(st.y[i] - st.y[j], L);
    const out = S57.pairInteraction(dx, dy, st.phi[i], st.phi[j], rs, rc);
    if (out && out.Vdd <= thr) count++;
  }
  return count / edges.length;
}
/** h_shuf: 同じ位置で向きだけを一様に引き直した h（trials 回平均）。 */
function headTailFractionShuffled(st, edges, rs, rc, thr, rnd, trials) {
  trials = trials || 10;
  if (edges.length === 0) return null;
  let sum = 0;
  const L = st.L;
  for (let t = 0; t < trials; t++) {
    const phiRand = new Map();
    for (const [i, j] of edges) { if (!phiRand.has(i)) phiRand.set(i, rnd() * 2 * Math.PI); if (!phiRand.has(j)) phiRand.set(j, rnd() * 2 * Math.PI); }
    let count = 0;
    for (const [i, j] of edges) {
      const dx = S57.minImage(st.x[i] - st.x[j], L), dy = S57.minImage(st.y[i] - st.y[j], L);
      const out = S57.pairInteraction(dx, dy, phiRand.get(i), phiRand.get(j), rs, rc);
      if (out && out.Vdd <= (thr == null ? -1.0 : thr)) count++;
    }
    sum += count / edges.length;
  }
  return sum / trials;
}

// ================================================================ 塊の追跡（相互過半）・分裂・持続的な合成

class ClusterTracker {
  constructor(opt) {
    this.nMin = opt.nMin; this.tauAge = opt.tauAge; this.tauP = opt.tauP; this.rb = opt.rb;
    this.history = new BondHistory(3);
    this.nextId = 1;
    this.prev = null; // {t, N, membership, components, stableIds, ages, edgesByComp: Map(localIdx->edges)}
    this.events = []; // {type:'fission'|'fusion'|'dissolve'|'absorbed', ...}
    this.ambiguous = [];
    this.pendingFissions = []; // {parentStableId, f1,f2, countdown, tAt}
    this.pendingFusions = []; // {intoIdRef:{id}, parentIds:[...], parentMemberSets:[Set], parentBondSets:[Set], countdown, tAt}
  }

  /** 1フレーム進める。st=系の状態、t=時刻、nearEnd=NVEの終わり20τ以内か。 */
  step(st, t, nearEnd) {
    const N = st.N;
    const inst = contactEdges(st, this.rb);
    this.history.push(inst);
    const persistent = this.history.persistent();
    const cc = connectedComponents(N, persistent);
    const nMin = this.nMin;

    const stableIds = new Array(cc.components.length).fill(null);
    const ages = new Array(cc.components.length).fill(0);

    if (this.prev) {
      const overlap = new Map();
      for (let pid = 0; pid < N; pid++) {
        const prevLocal = this.prev.membership[pid], currLocal = cc.membership[pid];
        if (prevLocal < 0 || currLocal < 0) continue;
        const key = prevLocal + '_' + currLocal;
        overlap.set(key, (overlap.get(key) || 0) + 1);
      }
      for (let ci = 0; ci < cc.components.length; ci++) {
        const c = cc.components[ci];
        if (c.size < nMin) continue;
        let bestPrev = -1, bestCount = 0;
        for (let pi = 0; pi < this.prev.components.length; pi++) {
          const cnt = overlap.get(pi + '_' + ci) || 0;
          if (cnt > bestCount) { bestCount = cnt; bestPrev = pi; }
        }
        if (bestPrev >= 0) {
          const prevSize = this.prev.components[bestPrev].size;
          if (bestCount > prevSize / 2 && bestCount > c.size / 2) {
            stableIds[ci] = this.prev.stableIds[bestPrev];
            ages[ci] = this.prev.ages[bestPrev] + 1;
          }
        }
      }
    }
    for (let ci = 0; ci < cc.components.length; ci++) {
      if (cc.components[ci].size < nMin) continue;
      if (stableIds[ci] === null) { stableIds[ci] = this.nextId++; ages[ci] = 0; }
    }

    if (this.prev) {
      // ---- 資格ある分裂の候補 ----
      for (let pi = 0; pi < this.prev.components.length; pi++) {
        const parent = this.prev.components[pi];
        const parentAge = this.prev.ages[pi];
        if (this.prev.stableIds[pi] == null || parent.size < 2 * nMin || parentAge < this.tauAge) continue;
        const dest = new Map();
        for (const pidPart of parent.members) {
          const currLocal = cc.membership[pidPart];
          if (currLocal < 0) continue;
          dest.set(currLocal, (dest.get(currLocal) || 0) + 1);
        }
        const gate = Math.max(nMin, Math.ceil(0.2 * parent.size));
        const frags = Array.from(dest.entries()).filter(([, n]) => n >= gate).sort((a, b) => b[1] - a[1]);
        if (frags.length >= 2) {
          const f1 = stableIds[frags[0][0]], f2 = stableIds[frags[1][0]];
          if (f1 != null && f2 != null && f1 !== f2) {
            if (nearEnd) this.ambiguous.push({ t, kind: 'fission', parentStableId: this.prev.stableIds[pi] });
            else this.pendingFissions.push({ tAt: t, parentStableId: this.prev.stableIds[pi], f1, f2, countdown: this.tauP });
          }
        }
      }
      // ---- 資格ある合成の候補（2つ以上の親が同じ塊へ）----
      const mergeInto = new Map();
      for (let pi = 0; pi < this.prev.components.length; pi++) {
        const parent = this.prev.components[pi];
        if (this.prev.stableIds[pi] == null || parent.size < nMin || this.prev.ages[pi] < this.tauAge) continue;
        const dest = new Map();
        for (const pidPart of parent.members) {
          const currLocal = cc.membership[pidPart];
          if (currLocal < 0) continue;
          dest.set(currLocal, (dest.get(currLocal) || 0) + 1);
        }
        let bestLocal = -1, bestCnt = 0;
        for (const [cl, cnt] of dest) if (cnt > bestCnt) { bestCnt = cnt; bestLocal = cl; }
        const gate = Math.max(nMin, Math.ceil(0.2 * parent.size));
        if (bestLocal >= 0 && bestCnt >= gate) {
          if (!mergeInto.has(bestLocal)) mergeInto.set(bestLocal, []);
          mergeInto.get(bestLocal).push(pi);
        }
      }
      for (const [currLocal, parents] of mergeInto) {
        if (parents.length < 2) continue;
        if (nearEnd) { this.ambiguous.push({ t, kind: 'fusion', parents: parents.map((pi) => this.prev.stableIds[pi]) }); continue; }
        const parentMemberSets = parents.map((pi) => new Set(this.prev.components[pi].members));
        const parentBondSets = parents.map((pi) => {
          const memberSet = new Set(this.prev.components[pi].members);
          const set = new Set();
          for (const [a, b] of persistentPairsWithin(this.prevPersistentEdges, memberSet)) set.add(a + '_' + b);
          return set;
        });
        this.pendingFusions.push({
          tAt: t, parentIds: parents.map((pi) => this.prev.stableIds[pi]),
          intoIdAtMerge: stableIds[currLocal], parentMemberSets, parentBondSets, countdown: this.tauP,
        });
      }
      // ---- 溶解／吸収（分裂でも合成でもなく消えた塊）----
      const involvedInFission = new Set(); // 分裂候補親を除く
      for (let pi = 0; pi < this.prev.components.length; pi++) {
        const id = this.prev.stableIds[pi];
        if (id == null) continue;
        const stillPresent = stableIds.indexOf(id) >= 0;
        if (stillPresent) continue;
        // このidが今フレームどこへ行ったか
        const dest = new Map();
        for (const pidPart of this.prev.components[pi].members) {
          const currLocal = cc.membership[pidPart];
          if (currLocal < 0) continue;
          dest.set(currLocal, (dest.get(currLocal) || 0) + 1);
        }
        let bestLocal = -1, bestCnt = 0;
        for (const [cl, cnt] of dest) if (cnt > bestCnt) { bestCnt = cnt; bestLocal = cl; }
        const destSize = bestLocal >= 0 ? cc.components[bestLocal].size : 0;
        if (bestLocal >= 0 && destSize >= nMin && !mergeInto.has(bestLocal)) {
          this.events.push({ type: 'absorbed', t, stableId: id, intoLocal: bestLocal });
        } else if (bestLocal < 0 || destSize < nMin) {
          this.events.push({ type: 'dissolve', t, stableId: id });
        }
      }
    }

    // 現フレームの持続結合を親追跡用に保存
    this.prevPersistentEdges = persistent;

    // ---- 分裂候補の更新 ----
    const idToLocal = new Map();
    for (let ci = 0; ci < cc.components.length; ci++) if (stableIds[ci] != null) idToLocal.set(stableIds[ci], ci);
    this.pendingFissions = this.pendingFissions.filter((p) => {
      const l1 = idToLocal.get(p.f1), l2 = idToLocal.get(p.f2);
      const alive1 = l1 !== undefined && cc.components[l1].size >= nMin;
      const alive2 = l2 !== undefined && cc.components[l2].size >= nMin;
      const merged = l1 !== undefined && l1 === l2;
      if (merged || !alive1 || !alive2) return false;
      p.countdown--;
      if (p.countdown <= 0) { this.events.push({ type: 'fission', t: p.tAt, parentStableId: p.parentStableId, f1: p.f1, f2: p.f2 }); return false; }
      return true;
    });

    // ---- 合成候補の更新（successorが単一塊のままで、各親の50%の粒子・50%の結合を保つか）----
    this.pendingFusions = this.pendingFusions.filter((p) => {
      // successor は intoIdAtMerge を継いだ塊が唯一存在し続けているか
      const local = idToLocal.get(p.intoIdAtMerge);
      if (local === undefined) return false; // 消えた→不成立
      const successorMembers = new Set(cc.components[local].members);
      for (const ms of p.parentMemberSets) {
        let kept = 0; for (const m of ms) if (successorMembers.has(m)) kept++;
        if (kept < 0.5 * ms.size) return false;
      }
      p.countdown--;
      if (p.countdown <= 0) {
        // 各親の内部結合の50%以上が今も結合として残っているか
        const nowSet = new Set(persistent.map(([a, b]) => a + '_' + b));
        let ok = true;
        for (const bs of p.parentBondSets) {
          if (bs.size === 0) continue;
          let kept = 0; for (const key of bs) if (nowSet.has(key)) kept++;
          if (kept < 0.5 * bs.size) { ok = false; break; }
        }
        if (ok) this.events.push({ type: 'fusion', t: p.tAt, parents: p.parentIds, into: p.intoIdAtMerge });
        return false;
      }
      return true;
    });

    this.prev = { t, N, membership: cc.membership, components: cc.components, stableIds, ages };
    return { membership: cc.membership, components: cc.components, stableIds, ages, persistentEdges: persistent };
  }

  finalize() { this.pendingFissions = []; this.pendingFusions = []; }
}
function persistentPairsWithin(edges, memberSet) {
  const out = [];
  for (const [a, b] of edges) if (memberSet.has(a) && memberSet.has(b)) out.push([a, b]);
  return out;
}

// ================================================================ ④ 緩和と活動

function movingAverage(series, halfWindow) {
  const n = series.length, out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let lo = Math.max(0, i - halfWindow), hi = Math.min(n - 1, i + halfWindow), s = 0, c = 0;
    for (let j = lo; j <= hi; j++) { s += series[j]; c++; }
    out[i] = s / c;
  }
  return out;
}
function stddev(arr) {
  const n = arr.length; if (n === 0) return 0;
  let m = 0; for (const v of arr) m += v; m /= n;
  let s = 0; for (const v of arr) s += (v - m) * (v - m);
  return Math.sqrt(s / n);
}
function leastSquaresSlope(ts, ys) {
  const n = ts.length; if (n < 2) return 0;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += ts[i]; sy += ys[i]; sxx += ts[i] * ts[i]; sxy += ts[i] * ys[i]; }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return 0;
  return (n * sxy - sx * sy) / denom;
}
/** series: {name: [...]}（t と同じ長さ）。opt: {smoothTau, dtSample, wStart, wEnd, bandFrac, bandSdMult}。 */
function relaxationAndActivity(t, series, opt) {
  const results = {};
  const halfWin = Math.max(1, Math.round(opt.smoothTau / 2 / opt.dtSample));
  for (const name of Object.keys(series)) {
    const raw = series[name];
    const smoothed = movingAverage(raw, halfWin);
    const wIdx = []; for (let i = 0; i < t.length; i++) if (t[i] >= opt.wStart && t[i] <= opt.wEnd) wIdx.push(i);
    const wVals = wIdx.map((i) => smoothed[i]);
    const mean = wVals.reduce((a, b) => a + b, 0) / Math.max(1, wVals.length);
    const sd = stddev(wVals);
    const band = Math.max(opt.bandSdMult * sd, opt.bandFrac * Math.abs(mean));
    let tauRelax = null;
    for (let i = 0; i < t.length; i++) {
      if (Math.abs(smoothed[i] - mean) <= band) {
        let stays = true;
        for (let j = i; j < t.length; j++) if (Math.abs(smoothed[j] - mean) > band) { stays = false; break; }
        if (stays) { tauRelax = t[i] - t[0]; break; }
      }
    }
    const wT = wIdx.map((i) => t[i]);
    const b = leastSquaresSlope(wT, wVals);
    results[name] = { mean, sd, band, tauRelax, slope: b };
  }
  return results;
}

// ================================================================ ⑤ エネルギーの台帳

/** ledger: [{t,E}]（0.1τごとNVE）。kMeanNve=⟨K⟩_NVE。分母は ⟨K⟩（|E(0)|は使わない）。 */
function energyLedgerAnalysis(ledger, kMeanNve) {
  const E0 = ledger[0].E;
  let maxDrift = 0;
  for (const row of ledger) maxDrift = Math.max(maxDrift, Math.abs(row.E - E0));
  const ts = ledger.map((r) => r.t), Es = ledger.map((r) => r.E);
  const b = leastSquaresSlope(ts, Es);
  const tSpan = ts[ts.length - 1] - ts[0];
  const relDriftMax = kMeanNve > 0 ? maxDrift / kMeanNve : maxDrift;
  const trendFraction = maxDrift > 0 ? Math.abs(b * tSpan) / maxDrift : 0;
  const trendAbs = kMeanNve > 0 ? Math.abs(b * tSpan) / kMeanNve : Math.abs(b * tSpan);
  return { relDriftMax, trendFraction, trendAbs, maxDrift, slope: b };
}

/**
 * torqueBalanceMax: 無作為な pairCount 対で |τi+τj+r_ij×Fi| / (|τi|+|τj|+|r_ij×Fi|) の最大。
 * variant を渡すと、実際に走行に使っている力則（central/nonrecip）で評価する
 * ——渡さない（'normal'）と常に釣り合うので、較正腕の破れを測るには variant 必須。
 */
function torqueBalanceSample(st, params, rnd, pairCount, variant) {
  const N = st.N;
  let maxRatio = 0;
  for (let k = 0; k < pairCount; k++) {
    const i = Math.floor(rnd() * N);
    let j = Math.floor(rnd() * N);
    if (j === i) j = (j + 1) % N;
    const d = S57.pairDiagnostic(st, params, i, j, variant);
    if (!d) continue;
    const cross = d.rijx * d.Fiy - d.rijy * d.Fix;
    const num = Math.abs(d.taui + d.tauj + cross);
    const den = Math.abs(d.taui) + Math.abs(d.tauj) + Math.abs(cross);
    const ratio = den > 1e-12 ? num / den : num;
    if (ratio > maxRatio) maxRatio = ratio;
  }
  return maxRatio;
}

const api = {
  contactEdges, BondHistory, connectedComponents,
  unwrapComponent, hexDiscRg, shapeDescriptors, jitteredHexDisc, topologyClass,
  headTailFraction, headTailFractionShuffled,
  ClusterTracker,
  movingAverage, stddev, leastSquaresSlope, relaxationAndActivity,
  energyLedgerAnalysis, torqueBalanceSample,
};
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.S57Track = api;
if (typeof global !== 'undefined' && global && !global.S57Track) global.S57Track = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
