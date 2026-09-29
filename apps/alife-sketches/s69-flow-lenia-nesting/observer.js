/**
 * S-69: 検出器（Node 専用）。criteria.json の observerDetails と1対1で対応させる。
 * 要素の状態（各セルの A_i・P・ℓ・Ψ）と、そこから作り直した U・F だけを読む
 * （シミュレーションの側は生き物・部品・種の個体のデータ構造を持たない）。
 *
 * 実装上の簡略化（notes.md へ申し送り済み）: D-iso の merge tree は「閾値を上から掃く連結成分の
 * 包含関係」で構築する（教科書的な永続ホモロジーの実装ではなく、記述された振る舞い——峰の持続・
 * 群の持続・畳み込み——を素直な連結成分の包含で近似したもの）。
 */
'use strict';
const N = 128, CELLS = N * N;

/* ---------------------------------------------------------------- 汎用: 連結成分（トーラス・一周検出） */

/**
 * mask(idx)->bool の 8 連結成分。一周する成分（格子を展開して同じセルに2通りで着く）を検出する。
 * 戻り値: [{ id, cells:[idx...], size, wraps:bool, bboxMinX,minY,maxX,maxY(展開座標系) }]
 */
function connectedComponents(maskFn) {
  const labels = new Int32Array(CELLS).fill(-1);
  const comps = [];
  const ux = new Int32Array(CELLS), uy = new Int32Array(CELLS);
  const stampAt = new Int32Array(CELLS).fill(-1);
  let stamp = 0;
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (let start = 0; start < CELLS; start++) {
    if (labels[start] !== -1 || !maskFn(start)) continue;
    const id = comps.length;
    stamp++;
    const sx = start % N, sy = (start / N) | 0;
    const queue = [start];
    labels[start] = id; ux[start] = sx; uy[start] = sy; stampAt[start] = stamp;
    let head = 0, wraps = false;
    const cells = [];
    let minX = sx, maxX = sx, minY = sy, maxY = sy;
    while (head < queue.length) {
      const cur = queue[head++];
      cells.push(cur);
      const cx = cur % N, cy = (cur / N) | 0;
      const cux = ux[cur], cuy = uy[cur];
      for (let k = 0; k < 8; k++) {
        const nx = (cx + NB[k][0] + N) % N, ny = (cy + NB[k][1] + N) % N;
        const nidx = ny * N + nx;
        if (!maskFn(nidx)) continue;
        const nux = cux + NB[k][0], nuy = cuy + NB[k][1];
        if (labels[nidx] === -1) {
          labels[nidx] = id; ux[nidx] = nux; uy[nidx] = nuy; stampAt[nidx] = stamp;
          queue.push(nidx);
        } else if (labels[nidx] === id) {
          if (stampAt[nidx] === stamp && (ux[nidx] !== nux || uy[nidx] !== nuy)) wraps = true;
        }
      }
      if (cx < minX) minX = cx; if (cx > maxX) maxX = cx;
    }
    for (const c of cells) { const uxx = ux[c], uyy = uy[c]; if (uxx < minX) minX = uxx; if (uxx > maxX) maxX = uxx; if (uyy < minY) minY = uyy; if (uyy > maxY) maxY = uyy; }
    comps.push({ id: id, cells: cells, size: cells.length, wraps: wraps, minX, maxX, minY, maxY });
  }
  return { labels: labels, comps: comps };
}

function centroid(cells) {
  // 展開座標を使わない単純重心（トーラスの周期性は無視。生き物の径程度の広がりなら十分）。
  let sx = 0, sy = 0;
  for (const c of cells) { sx += c % N; sy += (c / N) | 0; }
  return { x: sx / cells.length, y: sy / cells.length };
}

/* ---------------------------------------------------------------- D-M（生き物） */

const THETA_M = 0.05, D_M_MIN_AREA = 9, D_M_MAX_AREA = (N * N) / 4, D_M_MIN_MASS = 20;

function buildASigma(state) {
  const out = new Float64Array(CELLS);
  for (let c = 0; c < state.C; c++) { const A = state.A[c]; for (let i = 0; i < CELLS; i++) out[i] += A[i]; }
  return out;
}

/** D-M 候補（資格の一部。閉じ込めは追跡側が時系列から判定する）。 */
function detectCreatureCandidates(ASigma, thetaM) {
  thetaM = thetaM === undefined ? THETA_M : thetaM;
  const { labels, comps } = connectedComponents((i) => ASigma[i] >= thetaM);
  const out = [];
  for (const comp of comps) {
    if (comp.wraps) continue; // 大域の模様として別カウント
    if (comp.size < D_M_MIN_AREA || comp.size > D_M_MAX_AREA) continue;
    let mass = 0; for (const c of comp.cells) mass += ASigma[c];
    if (mass < D_M_MIN_MASS) continue;
    const cen = centroid(comp.cells);
    out.push({ cells: comp.cells, size: comp.size, mass: mass, centroid: cen });
  }
  const wrapCount = comps.filter((c) => c.wraps).length;
  return { candidates: out, globalPatternCount: wrapCount, labels: labels };
}

/** 慣性半径の2乗（トーラス補正なしの単純版。生き物の径程度なら妥当）。 */
function radiusOfGyrationSq(cells, ASigma, cx, cy) {
  let s = 0, m = 0;
  for (const c of cells) {
    const x = c % N, y = (c / N) | 0, w = ASigma[c];
    const dx = x - cx, dy = y - cy;
    s += w * (dx * dx + dy * dy); m += w;
  }
  return m > 0 ? s / m : 0;
}

/* ---------------------------------------------------------------- D-iso（総質量の等値線の入れ子の木） */

const Q_ISO = 1.4, PI_MIN = Math.log(1.5), A_MIN = 9;

/**
 * 1つの生き物（cells の集合）に対して、θ_m から q 倍ずつ増える閾値で連結成分を作り、
 * 包含関係で木を作る。持続 >= πMin かつ 面積 >= aMin の節だけ残し、1つの子だけの節は畳む。
 * 戻り値: { K, hasNode(輪の判定用にノード配列), tree }
 */
function buildDIso(cells, ASigma, thetaM, q, piMin, aMin) {
  thetaM = thetaM === undefined ? THETA_M : thetaM; q = q === undefined ? Q_ISO : q;
  piMin = piMin === undefined ? PI_MIN : piMin; aMin = aMin === undefined ? A_MIN : aMin;
  const cellSet = new Set(cells);
  let maxA = 0; for (const c of cells) if (ASigma[c] > maxA) maxA = ASigma[c];
  const thresholds = [];
  for (let th = thetaM; th <= maxA * 1.0001; th *= q) thresholds.push(th);
  if (thresholds.length === 0) thresholds.push(thetaM);
  // レベルごとの連結成分（cellSet 内に制限）
  const levels = thresholds.map((th) => connectedComponents((i) => cellSet.has(i) && ASigma[i] >= th).comps.filter((c) => !c.wraps));
  // 木を下(j=0, root)から上(j=J, 葉)へ、包含で親を割り当てる
  // ノード: {level, compIdx, cells, parent:null, children:[]}
  const nodesByLevel = levels.map((comps, j) => comps.map((comp, ci) => ({ level: j, threshold: thresholds[j], cells: comp.cells, size: comp.size, parent: null, children: [] })));
  for (let j = 1; j < nodesByLevel.length; j++) {
    for (const node of nodesByLevel[j]) {
      // 親候補: level j-1 のうち、node の代表セルを含む成分
      const rep = node.cells[0];
      let parent = null;
      for (const cand of nodesByLevel[j - 1]) { if (cand.cells.indexOf(rep) >= 0) { parent = cand; break; } }
      if (parent) { node.parent = parent; parent.children.push(node); }
    }
  }
  const root = nodesByLevel[0][0] || null;
  if (!root) return { K: 0, root: null, nodes: [] };
  // 持続: 各ノードについて、そのノードが単独の子として存在し続ける最後のレベル(死)と最初のレベル(生)。
  // 単純化: 生 = node.level（最初に現れたレベル）。死 = 親が別の子を持つに至った最小の親レベル（=node.level-1 で
  // 兄弟がいなければさらに遡ってよいが、簡略化として node.level を死の代わりに使い、
  // persistence = ln(そのノードの cells 内の A の最大値 / node.threshold) とする（峰の実際の高さで代理する）。
  function peakHeight(node) { let m = 0; for (const c of node.cells) if (ASigma[c] > m) m = ASigma[c]; return m; }
  function assignPersistence(node) {
    const height = peakHeight(node);
    node.persistence = node.threshold > 0 ? Math.log(Math.max(height, node.threshold * 1e-6) / node.threshold) : 0;
    node.children.forEach(assignPersistence);
  }
  assignPersistence(root);
  // フィルタ: persistence>=piMin かつ size>=aMin（root は常に残す）。畳み込み: 1子だけの節は子で置き換える。
  function filterCollapse(node, isRoot) {
    let children = node.children.map((c) => filterCollapse(c, false)).filter(Boolean);
    // 孫を平坦化（子が畳まれて消えた場合、その孫を直接の子にする）— filterCollapseは常に生き残るノードかnullを返す
    if (!isRoot && (node.persistence < piMin || node.size < aMin)) {
      // このノードは消えるが、子は残す（親へ繋ぎ直す）
      return children.length === 1 ? children[0] : (children.length > 1 ? { __multi: children } : null);
    }
    // 1子だけなら畳む（子の内容をこのノードとして使う。ただしこのノード自身の cells/threshold は保持しつつ子を継承）
    while (children.length === 1 && !children[0].__multi) { const only = children[0]; children = only.children; node._collapsedInto = only; }
    const flat = [];
    children.forEach((c) => { if (c && c.__multi) flat.push(...c.__multi); else if (c) flat.push(c); });
    return { level: node.level, threshold: node.threshold, size: node.size, persistence: node.persistence, children: flat, cells: node.cells };
  }
  let filteredRoot = filterCollapse(root, true);
  if (filteredRoot && filteredRoot.__multi) filteredRoot = { level: 0, threshold: thetaM, size: root.size, persistence: Infinity, children: filteredRoot.__multi, cells: root.cells };
  function depth(node) { if (!node.children || node.children.length === 0) return 1; return 1 + Math.max(...node.children.map(depth)); }
  const K = filteredRoot ? depth(filteredRoot) : 1;
  return { K: K, root: filteredRoot, allNodes: nodesByLevel, thresholds: thresholds };
}

/** filteredRoot の全ノード（根含む）を平らな配列で返す。 */
function flattenIsoTree(root) {
  if (!root) return [];
  const out = [root];
  (root.children || []).forEach((c) => out.push(...flattenIsoTree(c)));
  return out;
}

/* ---------------------------------------------------------------- 入れ子（輪）の判定: 有界な穴 + 囲いの割合 */

/**
 * ある部品集合（各要素 {cells}）から、輪(X が Y を穴の中に囲う)を探す。
 * 有界な穴 H = X の cells の外側にある背景成分のうち、生き物の外に繋がらないもの。
 *
 * 囲いの割合の定義（実装上の操作化。notes.md へ申し送り）: 登録は「Y の外周の隣のうち X に属する割合」と
 * 書くが、X と Y が真に隣接する（間に隙間が無い）場合、同じ閾値では両者は連結成分として分離できず
 * （どちらも前景で隣接すれば同一成分になる）、逆に隙間（薄い谷）があれば Y 自身の外周は主に谷（X でも
 * Y でもない背景）に接し比率が上がらない。**どちらの幾何でも一貫して働く操作化として、
 * 「穴 H の外周（H に隣接し H の外側にあるセル）のうち X に属する割合」を囲いの割合に使う**——
 * これは「この穴の壁は X で出来ているか」を直接問うもので、Y が穴を占める割合によらず定義できる。
 */
function findEnclosures(parts, creatureCellSet, enclosureRatio) {
  enclosureRatio = enclosureRatio === undefined ? 0.8 : enclosureRatio;
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const partOfCell = new Map();
  parts.forEach((p, pi) => p.cells.forEach((c) => partOfCell.set(c, pi)));
  const results = [];
  for (let xi = 0; xi < parts.length; xi++) {
    const X = parts[xi];
    const xSet = new Set(X.cells);
    const bgMask = (i) => !xSet.has(i);
    const { comps } = connectedComponents(bgMask);
    const creatureSet = creatureCellSet;
    const outsideCompIds = new Set();
    for (const comp of comps) { for (const c of comp.cells) { if (!creatureSet.has(c)) { outsideCompIds.add(comp.id); break; } } }
    for (const comp of comps) {
      if (outsideCompIds.has(comp.id) || comp.wraps) continue;
      const holeSet = new Set(comp.cells);
      let boundaryTotal = 0, boundaryInX = 0;
      const seenBoundary = new Set();
      for (const c of comp.cells) {
        const cx = c % N, cy = (c / N) | 0;
        for (const [dx, dy] of NB) {
          const nx = (cx + dx + N) % N, ny = (cy + dy + N) % N, nidx = ny * N + nx;
          if (holeSet.has(nidx) || seenBoundary.has(nidx)) continue;
          seenBoundary.add(nidx);
          boundaryTotal++;
          if (xSet.has(nidx)) boundaryInX++;
        }
      }
      const ratio = boundaryTotal > 0 ? boundaryInX / boundaryTotal : 0;
      if (ratio < enclosureRatio) continue;
      const yIdx = new Map();
      for (const c of comp.cells) { const pi = partOfCell.get(c); if (pi !== undefined && pi !== xi) yIdx.set(pi, (yIdx.get(pi) || 0) + 1); }
      for (const [yi, cnt] of yIdx) results.push({ outer: xi, inner: yi, ratio: ratio, holeSize: comp.size, innerCellsInHole: cnt });
    }
  }
  return results;
}

/** 部品 X の厚さ（cells から X の縁までの距離の平均。簡略: 内部からの最短距離をBFSで求め平均する）。 */
function partThickness(part) {
  const set = new Set(part.cells);
  const dist = new Map();
  const queue = [];
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  for (const c of part.cells) {
    const cx = c % N, cy = (c / N) | 0;
    let isEdge = false;
    for (const [dx, dy] of NB) { const nx = (cx + dx + N) % N, ny = (cy + dy + N) % N; if (!set.has(ny * N + nx)) { isEdge = true; break; } }
    if (isEdge) { dist.set(c, 0); queue.push(c); }
  }
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head++]; const cx = cur % N, cy = (cur / N) | 0, d = dist.get(cur);
    for (const [dx, dy] of NB) {
      const nx = (cx + dx + N) % N, ny = (cy + dy + N) % N, nidx = ny * N + nx;
      if (!set.has(nidx) || dist.has(nidx)) continue;
      dist.set(nidx, d + 1); queue.push(nidx);
    }
  }
  let sum = 0; for (const c of part.cells) sum += (dist.get(c) || 0);
  return part.cells.length ? sum / part.cells.length : 0;
}

/* ---------------------------------------------------------------- D-basin（流れの行き先の盆） */

/**
 * 相対の流れ（総質量で重み付けた F̄ から生き物の重心速度を引いたもの）を 8 近傍の最近方向へ丸め、
 * 指し先を辿って行き着く固定点/閉路ごとに盆を作る。大きさ 0.05 未満は自分（固定点）とする。
 */
function buildDBasin(cells, Fbar_x, Fbar_y, comCellVx, comCellVy, minMassFrac, ASigma) {
  minMassFrac = minMassFrac === undefined ? 0.05 : minMassFrac;
  const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const cellSet = new Set(cells);
  const pointer = new Map();
  for (const c of cells) {
    const rx = Fbar_x[c] - comCellVx, ry = Fbar_y[c] - comCellVy;
    const mag = Math.sqrt(rx * rx + ry * ry);
    if (mag < 0.05) { pointer.set(c, c); continue; }
    let best = 0, bestDot = -Infinity;
    for (let k = 0; k < 8; k++) {
      const d = DIRS[k], dm = Math.sqrt(d[0] * d[0] + d[1] * d[1]);
      const dot = (rx * d[0] + ry * d[1]) / dm;
      if (dot > bestDot) { bestDot = dot; best = k; }
    }
    const cx = c % N, cy = (c / N) | 0;
    const nx = (cx + DIRS[best][0] + N) % N, ny = (cy + DIRS[best][1] + N) % N, nidx = ny * N + nx;
    pointer.set(c, cellSet.has(nidx) ? nidx : c);
  }
  // functional graph の到達成分（固定点/閉路）を求める
  const basinOf = new Map(); // cell -> 代表(閉路/固定点の最小index)
  for (const c of cells) {
    if (basinOf.has(c)) continue;
    const path = []; const onPath = new Map();
    let cur = c;
    while (!basinOf.has(cur) && !onPath.has(cur)) { onPath.set(cur, path.length); path.push(cur); cur = pointer.get(cur); }
    let rep;
    if (basinOf.has(cur)) rep = basinOf.get(cur);
    else { const cycleStart = onPath.get(cur); rep = Math.min(...path.slice(cycleStart)); }
    for (const p of path) basinOf.set(p, rep);
  }
  const groups = new Map();
  for (const c of cells) { const r = basinOf.get(c); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(c); }
  let parts = Array.from(groups.values()).map((cs) => ({ cells: cs, size: cs.length }));
  // 小さい盆（質量割合 < minMassFrac）は境界を最も長く共有する盆へ併せる
  let totalMass = 0; for (const c of cells) totalMass += ASigma[c];
  parts = mergeSmallParts(parts, cells, totalMass, minMassFrac, ASigma);
  return parts.filter((p) => p.size >= A_MIN);
}

function mergeSmallParts(parts, allCells, totalMass, minMassFrac, ASigma) {
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  let changed = true, iter = 0;
  while (changed && iter < 20) {
    changed = false; iter++;
    const cellToPart = new Map();
    parts.forEach((p, pi) => p.cells.forEach((c) => cellToPart.set(c, pi)));
    for (let pi = 0; pi < parts.length; pi++) {
      let mass = 0; for (const c of parts[pi].cells) mass += ASigma[c];
      if (totalMass > 0 && mass / totalMass >= minMassFrac) continue;
      const shareCount = new Map();
      for (const c of parts[pi].cells) {
        const cx = c % N, cy = (c / N) | 0;
        for (const [dx, dy] of NB) {
          const nx = (cx + dx + N) % N, ny = (cy + dy + N) % N, nidx = ny * N + nx;
          const other = cellToPart.get(nidx);
          if (other !== undefined && other !== pi) shareCount.set(other, (shareCount.get(other) || 0) + 1);
        }
      }
      if (shareCount.size === 0) continue;
      let best = -1, bestCount = -1;
      for (const [k, v] of shareCount) { if (v > bestCount) { bestCount = v; best = k; } }
      parts[best].cells = parts[best].cells.concat(parts[pi].cells);
      parts[best].size = parts[best].cells.length;
      parts.splice(pi, 1);
      changed = true;
      break;
    }
  }
  return parts;
}

/* ---------------------------------------------------------------- D-chan（優勢なチャネル） */

function buildDChan(cells, state, threshold) {
  threshold = threshold === undefined ? 0.6 : threshold;
  const cellSet = new Set(cells);
  const labelOf = (i) => {
    let aSigma = 0; for (let c = 0; c < state.C; c++) aSigma += state.A[c][i];
    if (aSigma <= 0) return 'mixed';
    for (let c = 0; c < state.C; c++) { if (state.A[c][i] / aSigma >= threshold) return c; }
    return 'mixed';
  };
  const labelMap = new Map();
  for (const c of cells) labelMap.set(c, labelOf(c));
  const { comps } = connectedComponents((i) => cellSet.has(i) && labelMap.has(i) ? sameLabelKey(labelMap, i) !== undefined : false);
  // connectedComponents は adjacency のみ(mask)で境界を割るので、ラベル別に個別にマスクして呼ぶ
  const parts = [];
  const labelsUsed = new Set(labelMap.values());
  for (const lab of labelsUsed) {
    const { comps: subComps } = connectedComponents((i) => cellSet.has(i) && labelMap.get(i) === lab);
    subComps.forEach((sc) => { if (sc.size >= A_MIN) parts.push({ cells: sc.cells, size: sc.size, label: lab }); });
  }
  return parts;
}
function sameLabelKey() { return true; }

/* ---------------------------------------------------------------- D-param（パラメータの地図の領域） */

function buildDParam(cells, state, mode, deltaP) {
  deltaP = deltaP === undefined ? 0.5 : deltaP;
  const cellSet = new Set(cells);
  const pDim = state.pDim;
  if (mode === 'softmax') {
    // 同じ P（値そのもの）の連結成分。P はコピーで作られるため厳密等価で十分（浮動小数の丸め誤差を吸収する軽い許容差）。
    const keyOf = (i) => { let s = ''; for (let d = 0; d < pDim; d++) s += Math.round(state.P[i * pDim + d] * 1e6) + ','; return s; };
    const keyMap = new Map();
    for (const c of cells) keyMap.set(c, keyOf(c));
    const parts = [];
    const seen = new Set();
    for (const c of cells) {
      const k = keyMap.get(c);
      if (seen.has(k)) continue;
      const { comps } = connectedComponents((i) => cellSet.has(i) && keyMap.get(i) === k);
      comps.forEach((sc) => { if (sc.size >= A_MIN) parts.push({ cells: sc.cells, size: sc.size, key: k }); });
      seen.add(k);
    }
    return mergeAllOverlaps(parts);
  }
  // NC-avg: 隣どうしの距離 < deltaP で繋ぐ
  const dist2 = (i, j) => { let s = 0; for (let d = 0; d < pDim; d++) { const diff = state.P[i * pDim + d] - state.P[j * pDim + d]; s += diff * diff; } return Math.sqrt(s); };
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
  const uf = new Map(); cells.forEach((c) => uf.set(c, c));
  function find(x) { while (uf.get(x) !== x) { uf.set(x, uf.get(uf.get(x))); x = uf.get(x); } return x; }
  function union(a, b) { const ra = find(a), rb = find(b); if (ra !== rb) uf.set(ra, rb); }
  for (const c of cells) {
    const cx = c % N, cy = (c / N) | 0;
    for (const [dx, dy] of NB) {
      const nx = (cx + dx + N) % N, ny = (cy + dy + N) % N, nidx = ny * N + nx;
      if (!cellSet.has(nidx)) continue;
      if (dist2(c, nidx) < deltaP) union(c, nidx);
    }
  }
  const groups = new Map();
  for (const c of cells) { const r = find(c); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(c); }
  const parts = Array.from(groups.values()).filter((g) => g.length >= A_MIN).map((g) => ({ cells: g, size: g.length }));
  return parts;
}
function mergeAllOverlaps(parts) { return parts; }

const ObsExports = {
  N, CELLS, THETA_M, D_M_MIN_AREA, D_M_MAX_AREA, D_M_MIN_MASS, Q_ISO, PI_MIN, A_MIN,
  connectedComponents, centroid, buildASigma, detectCreatureCandidates, radiusOfGyrationSq,
  buildDIso, flattenIsoTree, findEnclosures, partThickness, buildDBasin, buildDChan, buildDParam,
};
// observer.js は外部依存ゼロ（fs等を使わない）ので、viewer.html の生きた重ね描き（D-Mの枠・D-isoのK）にも
// そのまま使う。UMD 化して window.S69Observer からも読めるようにする（K-80と同じ「同じ経路」の考え方）。
if (typeof module !== 'undefined' && module.exports) module.exports = ObsExports;
if (typeof window !== 'undefined') window.S69Observer = ObsExports;
