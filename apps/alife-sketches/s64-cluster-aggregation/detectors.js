/**
 * S-64 の検出器: G（合体の木の Horton–Strahler 次数）・S（位置だけの対の密度の段）・
 * H-strict（部品の残留）・動きやすさ・大きさ分布・ゲル化（貫通）判定・参照点の構築。
 *
 * 観測器は core.js が作る sys.mergeLog / sys.units / sys.finishedUnits / sys.compMembers /
 * 粒子の位置だけを読む——塊の所属表（R腕の物理が使うもの）は読むが、それは※参照の腕を比べる
 * ためであって、判定の主（M-rigid/M-flex）の検出器はここでも結合の記録と位置だけを使う。
 *
 * 依存ゼロ。Node 専用（Buffer/crypto は使わない）。
 */
'use strict';
const S64 = require('./core.js');

function mean(a) { return a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0; }
function median(a) { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }
function sd(a) { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) * (v - m)))); }

// ================================================================ 検出器G: Horton–Strahler

/** 現在の componentCount と ufDegree から、生きている根の次数の一覧を返す。 */
function liveDegrees(sys) {
  const roots = new Set();
  for (let i = 0; i < sys.N; i++) roots.add(S64.ufFind(sys, i));
  return Array.from(roots).map((r) => sys.ufDegree[r]);
}

/** ① K_G・K_G,res・深さ比・ΔK_G の材料。qualify = N_k>=Nmin && median(m)>=mMin && 貫通しない。 */
function strahlerSummary(sys, opts) {
  opts = opts || {};
  const nMin = opts.nMin != null ? opts.nMin : 5;
  const mMin = opts.mMin != null ? opts.mMin : 8;
  const degrees = liveDegrees(sys);
  const K_G = degrees.length ? Math.max.apply(null, degrees) : 0;
  // 次数ごとの unit（finished + active）から N_k・median m
  const byOrder = ordersTable(sys);
  let K_G_res = 0;
  for (const row of byOrder) if (row.k >= 1 && row.N_k >= nMin && row.medianM >= mMin && !row.anyPercolating) K_G_res++;
  const mMax = Math.max(1, ...sys.compMembers ? Array.from(sys.compMembers.values()).map((m) => m.length) : [1]);
  const depthRatio = mMax > 1 ? K_G / Math.log2(mMax) : 0;
  return { K_G, K_G_res, depthRatio, mMax, byOrder };
}

/** 次数ごとの集計（units.jsonl の元になる表）。同格の規則 = Strahler（質量比knobは省略。notes.mdに明記）。 */
function ordersTable(sys) {
  const all = sys.finishedUnits.concat(Array.from(sys.units.values()).filter((u) => u.active));
  const byK = new Map();
  for (const u of all) {
    if (!byK.has(u.degree)) byK.set(u.degree, []);
    byK.get(u.degree).push(u);
  }
  const rows = [];
  for (const [k, units] of byK.entries()) {
    const ms = units.map((u) => u.m);
    rows.push({ k, N_k: units.length, medianM: median(ms) || 0, units, anyPercolating: units.some((u) => u._percolates) });
  }
  rows.sort((a, b) => a.k - b.k);
  return rows;
}

/**
 * knobs「同格の合体の規則」の再判定: sys.mergeLog（結合の生成順の記録）を、次数の割り当てだけ
 * 別の規則で置き換えて再生する。物理は再計算しない（結合の生成の順序そのものは規則に依らない）。
 * ruleFn(sizeA, sizeB) -> true なら「同格」（次数+1）、false なら「異なる」（次数はmaxのまま）。
 */
function replayStrahlerWithRule(mergeLog, N, ruleFn) {
  const parent = new Int32Array(N), degree = new Int32Array(N), size = new Int32Array(N).fill(1);
  for (let i = 0; i < N; i++) parent[i] = i;
  function find(i) { let r = i; while (parent[r] !== r) r = parent[r]; while (parent[i] !== r) { const n = parent[i]; parent[i] = r; i = n; } return r; }
  let maxDegree = 0;
  for (const ev of mergeLog) {
    if (ev.type !== 'merge') continue;
    const ra = find(ev.i), rb = find(ev.j);
    if (ra === rb) continue;
    const da = degree[ra], db = degree[rb], sa = size[ra], sb = size[rb];
    const same = ruleFn(sa, sb, da, db);
    const nd = same ? Math.max(da, db) + 1 : Math.max(da, db);
    const keep = sa >= sb ? ra : rb, drop = keep === ra ? rb : ra;
    parent[drop] = keep; size[keep] = sa + sb; degree[keep] = nd;
    maxDegree = Math.max(maxDegree, nd);
  }
  return maxDegree;
}
const SAME_DEGREE_RULES = {
  strahler: (sa, sb, da, db) => da === db,
  massRatioHalf: (sa, sb) => Math.min(sa, sb) / Math.max(sa, sb) >= 0.5,
  massRatioQuarter: (sa, sb) => Math.min(sa, sb) / Math.max(sa, sb) >= 0.25,
};

/** ランダムな合体の木（referencePoints[0]）。N個の要素をランダムに対にして finalComponents 個になるまで合体。 */
function randomCoalescentTree(N, finalComponents, rng) {
  let degree = new Int32Array(N).fill(0);
  let alive = Array.from({ length: N }, (_, i) => i);
  let sizes = new Int32Array(N).fill(1);
  while (alive.length > finalComponents) {
    const ia = Math.floor(rng() * alive.length);
    let ib = Math.floor(rng() * (alive.length - 1));
    if (ib >= ia) ib++;
    const a = alive[ia], b = alive[ib];
    const da = degree[a], db = degree[b];
    const nd = da === db ? da + 1 : Math.max(da, db);
    degree[a] = nd; sizes[a] = sizes[a] + sizes[b];
    const removeIdx = Math.max(ia, ib), keepIdx = Math.min(ia, ib);
    alive.splice(removeIdx, 1);
    if (keepIdx === ia) { /* a kept at ia */ } else { alive[keepIdx] = a; }
  }
  const finalDegrees = alive.map((i) => degree[i]);
  const K = finalDegrees.length ? Math.max.apply(null, finalDegrees) : 0;
  return { K, finalDegrees, N_k_by_degree: (() => { const m = {}; for (const d of finalDegrees) m[d] = (m[d] || 0) + 1; return m; })() };
}

// ================================================================ 検出器S: 対の密度 C(r) と区分直線

/** C(r): 対数刻み b のビンで対の密度を数える。O(N * 近傍数)。 */
function pairDensity(sys, rMin, rMax, ratio) {
  ratio = ratio || 1.12;
  const nBins = Math.max(1, Math.ceil(Math.log(rMax / rMin) / Math.log(ratio)));
  const edges = new Array(nBins + 1);
  for (let k = 0; k <= nBins; k++) edges[k] = rMin * Math.pow(ratio, k);
  const counts = new Array(nBins).fill(0);
  const cl = S64.buildCellList(sys, Math.min(rMax, sys.L / 2 - 1e-6));
  S64.forEachPairWithin(cl, sys, rMax, (i, j, dx, dy) => {
    const r = Math.sqrt(dx * dx + dy * dy);
    if (r < rMin) return;
    let bin = Math.floor(Math.log(r / rMin) / Math.log(ratio));
    if (bin >= 0 && bin < nBins) counts[bin] += 2; // 対は (i,j) 1回だけ渡るので両方向を数える
  });
  const rho = sys.N / (sys.L * sys.L);
  const out = [];
  for (let k = 0; k < nBins; k++) {
    const r0 = edges[k], r1 = edges[k + 1], rMid = Math.sqrt(r0 * r1);
    const area = Math.PI * (r1 * r1 - r0 * r0);
    const C = counts[k] / (sys.N * area);
    out.push({ r: rMid, C: Math.max(C, 1e-12), rho });
  }
  return out;
}

/**
 * 1〜maxSeg 本の区分直線を動的計画法で当てる（x=ln r, y=ln C）。各区間の幅>=minSpan(=ln(2.5))。
 * 本数は BIC で選ぶ。登録は最大4本だが、本実装は計算量の都合で maxSeg=3 に簡略化（raw/notes.mdに明記）。
 */
function fitPiecewiseLinear(points, minSpan, maxSeg) {
  maxSeg = maxSeg || 3;
  const pts = points.filter((p) => p.C > 0).map((p) => ({ x: Math.log(p.r), y: Math.log(p.C) }));
  const M = pts.length;
  if (M < 4) return { segments: [], k: 0 };
  // prefix sums
  const Sx = [0], Sy = [0], Sxx = [0], Sxy = [0];
  for (let i = 0; i < M; i++) {
    Sx.push(Sx[i] + pts[i].x); Sy.push(Sy[i] + pts[i].y);
    Sxx.push(Sxx[i] + pts[i].x * pts[i].x); Sxy.push(Sxy[i] + pts[i].x * pts[i].y);
  }
  function segFit(i, j) { // 点 i..j (inclusive, 0-based) の最小二乗直線とSSE
    const n = j - i + 1;
    const sx = Sx[j + 1] - Sx[i], sy = Sy[j + 1] - Sy[i], sxx = Sxx[j + 1] - Sxx[i], sxy = Sxy[j + 1] - Sxy[i];
    const denom = n * sxx - sx * sx;
    let slope, intercept;
    if (Math.abs(denom) < 1e-12) { slope = 0; intercept = sy / n; }
    else { slope = (n * sxy - sx * sy) / denom; intercept = (sy - slope * sx) / n; }
    let sse = 0;
    for (let k = i; k <= j; k++) { const e = pts[k].y - (intercept + slope * pts[k].x); sse += e * e; }
    return { slope, intercept, sse, n };
  }
  function spanOk(i, j) { return pts[j].x - pts[i].x >= minSpan; }
  const segCache = new Map();
  function fit(i, j) { const key = i + '_' + j; if (!segCache.has(key)) segCache.set(key, segFit(i, j)); return segCache.get(key); }

  let best = null;
  for (let k = 1; k <= maxSeg; k++) {
    // DP: dp[k][j] = { sse, breaks: [...] } 最小 SSE で k 本、点0..jをカバー
    const dp = new Array(k + 1);
    for (let kk = 0; kk <= k; kk++) dp[kk] = new Array(M).fill(null);
    for (let j = 0; j < M; j++) { if (spanOk(0, j)) dp[1][j] = { sse: fit(0, j).sse, breaks: [0] }; }
    for (let kk = 2; kk <= k; kk++) {
      for (let j = kk - 1; j < M; j++) {
        let bestSse = Infinity, bestBreaks = null;
        for (let i = kk - 2; i < j; i++) {
          if (!dp[kk - 1][i]) continue;
          if (!spanOk(i + 1, j)) continue;
          const s = dp[kk - 1][i].sse + fit(i + 1, j).sse;
          if (s < bestSse) { bestSse = s; bestBreaks = dp[kk - 1][i].breaks.concat([i + 1]); }
        }
        if (bestBreaks) dp[kk][j] = { sse: bestSse, breaks: bestBreaks };
      }
    }
    const final = dp[k][M - 1];
    if (!final) continue;
    const nParams = 2 * k;
    const bic = M * Math.log(Math.max(final.sse / M, 1e-12)) + nParams * Math.log(M);
    if (!best || bic < best.bic) {
      const breaks = final.breaks.concat([M]);
      const segments = [];
      for (let s = 0; s < breaks.length - 1; s++) {
        const i = breaks[s], j = breaks[s + 1] - 1;
        const f = fit(i, j);
        segments.push({ x0: pts[i].x, x1: pts[j].x, r0: Math.exp(pts[i].x), r1: Math.exp(pts[j].x), slope: f.slope, intercept: f.intercept, sse: f.sse, n: f.n });
      }
      best = { bic, k, segments };
    }
  }
  return best || { segments: [], k: 0 };
}

/** 隣接区間の傾きの差<delta を併合し、型（fractal/dense-flat/uniform/cutoff/other）を付け、K_S を返す。 */
function classifySegments(fit, rho, delta) {
  delta = delta != null ? delta : 0.2;
  let segs = fit.segments.slice();
  let merged = true;
  while (merged && segs.length > 1) {
    merged = false;
    for (let i = 0; i < segs.length - 1; i++) {
      if (Math.abs(segs[i].slope - segs[i + 1].slope) < delta) {
        const a = segs[i], b = segs[i + 1];
        const n = a.n + b.n;
        segs[i] = { x0: a.x0, x1: b.x1, r0: a.r0, r1: b.r1, slope: (a.slope * a.n + b.slope * b.n) / n, intercept: a.intercept, sse: a.sse + b.sse, n };
        segs.splice(i + 1, 1);
        merged = true;
        break;
      }
    }
  }
  const typed = segs.map((s) => {
    const Cmid = Math.exp(s.intercept + s.slope * (s.x0 + s.x1) / 2);
    let type;
    if (s.slope < -1.0) type = 'cutoff';
    else if (s.slope >= -1.0 && s.slope <= -0.2) type = 'fractal';
    else if (Math.abs(s.slope) < 0.2) type = Cmid >= 3 * rho ? 'dense-flat' : 'uniform';
    else type = 'other';
    return Object.assign({}, s, { type, Cmid });
  });
  const K_S = typed.filter((s) => s.type === 'fractal' || s.type === 'dense-flat').length;
  const fractalSegs = typed.filter((s) => s.type === 'fractal');
  const widest = fractalSegs.sort((a, b) => (b.x1 - b.x0) - (a.x1 - a.x0))[0];
  const Df_S = widest ? 2 + widest.slope : null;
  return { segments: typed, K_S, Df_S };
}

/**
 * 箱数え法のDf（knobs「Dfの測り方」の第3の値）。1つの成分（周期境界をまたがないもの）の
 * 局所展開した点集合を、辺 b の格子で覆い、占有した箱の数 N(b) を数える。
 * b∈[2, Rg] を対数刻みで5点取り、ln N(b) 対 ln b の傾きの符号を反転したものがDf。
 */
function boxCountingDf(pos, memberList, Rg) {
  if (!pos || memberList.length < 8 || !Rg || Rg < 2) return null;
  const bs = [];
  for (let k = 0; k < 5; k++) bs.push(2 * Math.pow(Rg / 2, k / 4));
  const pts = [];
  for (const b of bs) {
    const occ = new Set();
    for (const idx of memberList) { const [x, y] = pos.get(idx); occ.add(Math.floor(x / b) + '_' + Math.floor(y / b)); }
    pts.push({ lnB: Math.log(b), lnN: Math.log(occ.size) });
  }
  const n = pts.length, mx = mean(pts.map((p) => p.lnB)), my = mean(pts.map((p) => p.lnN));
  let sxx = 0, sxy = 0;
  for (const p of pts) { sxx += (p.lnB - mx) ** 2; sxy += (p.lnB - mx) * (p.lnN - my); }
  return sxx > 1e-9 ? -(sxy / sxx) : null;
}

/** rMinの知恵（knob）だけを変えてS検出器を再当てはめする（対の密度は再計算せず、既存の点を絞り込むだけ）。 */
function refitDetectorS(points, rho, opts) {
  const rMin = opts.rMin, rMax = opts.rMax;
  const filtered = points.filter((p) => p.r >= rMin && p.r <= rMax);
  const fit = fitPiecewiseLinear(filtered, opts.minSpan, opts.maxSeg || 3);
  return classifySegments(fit, rho, opts.delta);
}

function detectorS(sys, rMinFactor, opts) {
  opts = opts || {};
  const rMin = opts.rMin != null ? opts.rMin : 1.5;
  const rMax = Math.min(opts.rMax != null ? opts.rMax : sys.L / 4, sys.L / 2 - 1e-6);
  const points = pairDensity(sys, rMin, rMax, opts.ratio || 1.12);
  const fit = fitPiecewiseLinear(points, opts.minSpan != null ? opts.minSpan : Math.log(2.5), opts.maxSeg || 3);
  const rho = sys.N / (sys.L * sys.L);
  const cls = classifySegments(fit, rho, opts.delta != null ? opts.delta : 0.2);
  return Object.assign({ points }, cls);
}

// ================================================================ 塊の展開（周期境界をまたぐ座標の局所展開）とゲル化

/**
 * members（同じ連結成分）を bond グラフで BFS し、周期境界をまたがない局所座標を作る。貫通を検出する。
 * 戻り値に spanX/spanY（展開した座標の x/y の広がり）も含む——reg2 の貫通の定義②
 * 「展開した座標の x か y の広がりが L 以上」に使う（run1 の gelationCheck は percolates だけを読むので
 * この追加フィールドは run1 の挙動に影響しない）。
 */
function unwrapCluster(sys, members) {
  const inSet = new Set(members);
  const pos = new Map();
  const start = members[0];
  pos.set(start, [sys.x[start], sys.y[start]]);
  const visited = new Set([start]);
  const queue = [start];
  let percolates = false;
  let minX = sys.x[start], maxX = sys.x[start], minY = sys.y[start], maxY = sys.y[start];
  while (queue.length) {
    const cur = queue.shift();
    const [cx, cy] = pos.get(cur);
    for (const nb of sys.bondNbrs[cur]) {
      if (!inSet.has(nb)) continue;
      const dx = S64.minImageD(sys.x[nb] - sys.x[cur], sys.L), dy = S64.minImageD(sys.y[nb] - sys.y[cur], sys.L);
      const cand = [cx + dx, cy + dy];
      if (!visited.has(nb)) {
        visited.add(nb); pos.set(nb, cand); queue.push(nb);
        if (cand[0] < minX) minX = cand[0]; if (cand[0] > maxX) maxX = cand[0];
        if (cand[1] < minY) minY = cand[1]; if (cand[1] > maxY) maxY = cand[1];
      } else {
        const [ex, ey] = pos.get(nb);
        if (Math.abs(ex - cand[0]) > sys.L / 2 || Math.abs(ey - cand[1]) > sys.L / 2) percolates = true;
      }
    }
  }
  return { pos, percolates, spanX: maxX - minX, spanY: maxY - minY };
}

/** ゲル化: 全成分を走査し、貫通する成分があるか・その粒子割合を返す。 */
function gelationCheck(sys) {
  const roots = new Set();
  for (let i = 0; i < sys.N; i++) roots.add(S64.ufFind(sys, i));
  let percolatingMembers = 0, any = false;
  for (const r of roots) {
    const members = sys.compMembers.get(r);
    if (!members || members.length < 3) continue;
    const { percolates } = unwrapCluster(sys, members);
    if (percolates) { any = true; percolatingMembers += members.length; }
  }
  return { percolates: any, gelFraction: percolatingMembers / sys.N };
}

// ================================================================ 段ごとの性質（perOrderProperties）と H-strict

/** 1つの unit（塊。m>=1）の形の量。周期境界をまたぐ塊（percolates）は R_g/A を計算しない。 */
function unitShape(sys, memberList) {
  const { pos, percolates } = unwrapCluster(sys, memberList);
  const m = memberList.length;
  if (percolates || m < 2) return { m, Rg: null, A: null, percolates };
  let cx = 0, cy = 0;
  for (const idx of memberList) { const [px, py] = pos.get(idx); cx += px; cy += py; }
  cx /= m; cy /= m;
  let Rg2 = 0, Ixx = 0, Iyy = 0, Ixy = 0;
  for (const idx of memberList) {
    const [px, py] = pos.get(idx); const dx = px - cx, dy = py - cy;
    Rg2 += dx * dx + dy * dy; Ixx += dy * dy; Iyy += dx * dx; Ixy -= dx * dy;
  }
  Rg2 /= m;
  const tr = Ixx + Iyy, det = Ixx * Iyy - Ixy * Ixy;
  const disc = Math.max(0, tr * tr / 4 - det);
  const l1 = tr / 2 + Math.sqrt(disc), l2 = tr / 2 - Math.sqrt(disc);
  const A = (l1 + l2) > 1e-12 ? Math.pow((l1 - l2) / (l1 + l2), 2) : 0;
  return { m, Rg: Math.sqrt(Rg2), A, percolates, pos, cx, cy };
}

/** 部品どうしの結合数 z_parts・閉路 ℓ_parts・最大部品割合・n_parts（unit.parts の直接の子だけを部品とする）。 */
function partsGraph(sys, unit) {
  const parts = unit.parts || [];
  if (!parts.length) return { n_parts: unit.degree === 0 ? 0 : 0, z_parts: null, ell_parts: null, maxPartFraction: 1 };
  const memberOfPart = new Map(); // particle -> partIndex
  const all = collectPartMembers(sys, parts);
  all.forEach((arr, idx) => { for (const p of arr) memberOfPart.set(p, idx); });
  let crossBonds = 0;
  const seen = new Set();
  for (let pi = 0; pi < all.length; pi++) {
    for (const particle of all[pi]) {
      for (const nb of sys.bondNbrs[particle]) {
        const pj = memberOfPart.get(nb);
        if (pj == null || pj === pi) continue;
        const key = Math.min(particle, nb) + '_' + Math.max(particle, nb);
        if (seen.has(key)) continue;
        seen.add(key); crossBonds++;
      }
    }
  }
  const nParts = all.length;
  const totalM = all.reduce((s, arr) => s + arr.length, 0) || 1;
  const maxPartFraction = Math.max(...all.map((arr) => arr.length)) / totalM;
  const z_parts = nParts > 0 ? 2 * crossBonds / nParts : null;
  const ell_parts = nParts > 0 ? (crossBonds - nParts + 1) / nParts : null;
  // reg2(criteria-2.json observerDetails.perOrderProperties): μ_joint = 異なる部品をつなぐ結合の数
  // /(n_parts-1)（記録のみ）。run1はこの欄を読まないので追加は挙動に影響しない。
  const mu_joint = nParts > 1 ? crossBonds / (nParts - 1) : null;
  return { n_parts: nParts, z_parts, ell_parts, maxPartFraction, mu_joint };
}

/** unit id のリストから、それぞれの現在のメンバー一覧を復元する（finishedUnits は m を保持するのみなので、
 * 実際のメンバーは sys.compMembers から辿れない場合がある——unit finalize 時に memberSnapshot を持たせる。 */
function collectPartMembers(sys, partIds) {
  return partIds.map((id) => {
    const u = sys.units.get(id);
    return (u && u.memberSnapshot) || [];
  });
}

// ================================================================ H-strict（部品が部品として残るか）

/**
 * H-strict（部品が部品として残るか）。criteria.json は「終わりに c_P<=0.2 かつ s_P>=0.9」を
 * retained の基準とする——分離度・形の保持ともに「終わり」時点の値で判定する（parts-retention.jsonl
 * には吸収時と終わりの両方を残す設計だが、本実装は判定に使う終わり時点の値だけを持つ。簡略化は
 * raw/notes.md に明記）。s_P は吸収時（_samplePairs に記録済みの距離）と現在の距離の比較で、
 * 形の変化そのものは吸収時からの変化として正しく測る。
 * m<8（criteria.json の m_min）の部品は判定対象外（null）。
 */
function hStrictForPart(sys, part) {
  const members = part.memberSnapshot || [];
  const m = members.length;
  if (m < 8) return null;
  const inSet = new Set(members);
  let inside = 0, cross = 0;
  for (const p of members) {
    for (const nb of sys.bondNbrs[p]) {
      if (inSet.has(nb)) inside++; else cross++;
    }
  }
  inside /= 2; // 両側から数えた
  const c_P = inside > 0 ? cross / inside : (cross > 0 ? Infinity : 0);
  const pairs = part._samplePairs || [];
  let kept = 0;
  for (const [a, b, dAtAbsorb] of pairs) {
    const dx = S64.minImageD(sys.x[a] - sys.x[b], sys.L), dy = S64.minImageD(sys.y[a] - sys.y[b], sys.L);
    const dNow = Math.hypot(dx, dy);
    if (Math.abs(dNow - dAtAbsorb) < 0.3) kept++;
  }
  const s_P = pairs.length ? kept / pairs.length : null;
  const retained = c_P <= 0.2 && s_P != null && s_P >= 0.9;
  return { m, c_P, s_P, retained };
}

// ================================================================ 動きやすさ（簡略: 生涯の重心変位/観測時間）
// criteria.json は「粒子の組が変わらない区間ごとの変位を集めて D̂=Σ|Δr|²/(4ΣΔt)」と定義するが、
// 本実装は簡略化して「unit の生涯（startT〜endT）ひと区間の重心変位」で近似する（raw/notes.md）。

function unitMobility(sys, unit) {
  const members = unit.memberSnapshot || [];
  if (!members.length || unit._startCentroid == null || unit._endCentroid == null) return null;
  const dt = (unit.endT != null ? unit.endT : sys.t) - unit.startT;
  if (dt < 1) return null; // 観測時間 >=1τ_B
  const dx = unit._endCentroid[0] - unit._startCentroid[0], dy = unit._endCentroid[1] - unit._startCentroid[1];
  const D_hat = (dx * dx + dy * dy) / (4 * dt);
  return { D_hat, dt, m: members.length };
}

// ================================================================ 大きさ分布

function sizeDistribution(sys) {
  const roots = new Set();
  for (let i = 0; i < sys.N; i++) roots.add(S64.ufFind(sys, i));
  const counts = new Map();
  for (const r of roots) { const s = sys.ufSize[r]; counts.set(s, (counts.get(s) || 0) + 1); }
  return Array.from(counts.entries()).map(([s, n]) => ({ s, n })).sort((a, b) => a.s - b.s);
}

function weightedMeanSize(sizeDist) {
  let num = 0, den = 0;
  for (const row of sizeDist) { num += row.s * row.s * row.n; den += row.s * row.n; }
  return den > 0 ? num / den : 0;
}

// ================================================================ KS距離（大きさ分布の比較）

function ksDistance(sizesA, sizesB) {
  const all = sizesA.concat(sizesB).slice().sort((a, b) => a - b);
  const na = sizesA.length, nb = sizesB.length;
  if (!na || !nb) return null;
  const sa = sizesA.slice().sort((a, b) => a - b), sb = sizesB.slice().sort((a, b) => a - b);
  let i = 0, j = 0, maxD = 0;
  for (const v of all) {
    while (i < na && sa[i] <= v) i++;
    while (j < nb && sb[j] <= v) j++;
    maxD = Math.max(maxD, Math.abs(i / na - j / nb));
  }
  return maxD;
}

module.exports = {
  mean, median, sd,
  liveDegrees, strahlerSummary, ordersTable, randomCoalescentTree,
  replayStrahlerWithRule, SAME_DEGREE_RULES,
  pairDensity, fitPiecewiseLinear, classifySegments, detectorS, refitDetectorS, boxCountingDf,
  unwrapCluster, gelationCheck,
  unitShape, partsGraph, collectPartMembers,
  hStrictForPart,
  unitMobility, sizeDistribution, weightedMeanSize, ksDistance,
};
