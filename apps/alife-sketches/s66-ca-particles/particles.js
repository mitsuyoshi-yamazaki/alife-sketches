/**
 * S-66: 粒子の段（L2）。observerDetails.blobsAndChains・strictParticle・typeSignature・looseParticle。
 * 欠陥 D(i,t)（観測器ごと）から: 行の塊 → 行をまたぐ連結 → 鎖（分岐・合流の無い極大な列）→
 * 厳密な粒子の区間（内在的な周期 (P,d) と領域の文脈つきの素のセル一致）→ 型の正準形。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.S66Particles = factory(root.S66);
})(typeof self !== 'undefined' ? self : this, function (Core) {
  'use strict';
  if (!Core) Core = require('./core.js');

  function circularForwardGap(prevEnd, nextStart, n) { return (((nextStart - prevEnd - 1) % n) + n) % n; }
  function circularSpan(start, end, n) { return ((end - start + n) % n) + 1; }

  function findRowBlobs(D, n, gMerge) {
    let anyDomain = false;
    for (let i = 0; i < n; i++) if (!D[i]) { anyDomain = true; break; }
    if (!anyDomain) return [{ start: 0, end: n - 1, wraps: false, width: n, fullRing: true }];
    let startIdx = -1;
    for (let i = 0; i < n; i++) if (!D[i]) { startIdx = i; break; }
    const runs = [];
    let i = 0;
    while (i < n) {
      const idx = (startIdx + 1 + i) % n;
      if (!D[idx]) { i++; continue; }
      const runStart = idx; let len = 0;
      while (i < n) { const idx2 = (startIdx + 1 + i) % n; if (!D[idx2]) break; len++; i++; }
      const runEndIdx = (startIdx + 1 + i - 1 + n) % n;
      runs.push({ start: runStart, end: runEndIdx, wraps: runStart > runEndIdx, width: len, fullRing: false });
    }
    if (runs.length <= 1) return runs;
    const merged = [Object.assign({}, runs[0])];
    for (let k = 1; k < runs.length; k++) {
      const prev = merged[merged.length - 1];
      const gap = circularForwardGap(prev.end, runs[k].start, n);
      if (gap <= gMerge) { prev.end = runs[k].end; prev.width = circularSpan(prev.start, prev.end, n); prev.wraps = prev.start > prev.end; }
      else merged.push(Object.assign({}, runs[k]));
    }
    return merged;
  }

  function expandInterval(iv, by, n) {
    if (iv.fullRing) return iv;
    const start = ((iv.start - by) % n + n) % n, end = ((iv.end + by) % n + n) % n;
    return { start, end, wraps: start > end, width: circularSpan(start, end, n), fullRing: false };
  }
  function intervalCells(iv, n) {
    const set = new Set();
    if (iv.fullRing) { for (let c = 0; c < n; c++) set.add(c); return set; }
    if (!iv.wraps) for (let c = iv.start; c <= iv.end; c++) set.add(c);
    else { for (let c = iv.start; c < n; c++) set.add(c); for (let c = 0; c <= iv.end; c++) set.add(c); }
    return set;
  }
  function intervalsOverlap(a, b, n) {
    const setA = intervalCells(a, n);
    const cellsB = intervalCells(b, n);
    for (const c of cellsB) if (setA.has(c)) return true;
    return false;
  }

  /** 行ごとの塊 → 隣接行への連結（r_link 拡張して重なるか）を作る。 */
  function buildBlobRows(defectRows, tRange, n, gMerge) {
    const blobRows = new Array(tRange[1]);
    let nextId = 0;
    for (let t = tRange[0]; t < tRange[1]; t++) {
      const blobs = findRowBlobs(defectRows[t], n, gMerge);
      for (const b of blobs) { b.id = nextId++; b.t = t; b.succ = []; b.pred = []; }
      blobRows[t] = blobs;
    }
    return blobRows;
  }
  /**
   * 行どうしの連結。行あたりの塊が多いと素朴な総当たり O(k1*k2) は遅くなる（実測: 欠陥密度が高い
   * 本番規模の走行で全体の支配的コストになっていた）ので、start でソートした二本針の走査 O(k1+k2)
   * にする。円環をまたぐ塊（高々各行1つ）だけは別扱いで総当たりする。
   */
  function linkBlobRows(blobRows, tRange, n, rLink) {
    for (let t = tRange[0]; t < tRange[1] - 1; t++) linkPair(blobRows[t], blobRows[t + 1], n, rLink);
  }
  function linkPair(curBlobs, nxtBlobs, n, rLink) {
    const curExp = curBlobs.map((b) => ({ blob: b, exp: expandInterval(b, rLink, n) }));
    const plainCur = curExp.filter((e) => !e.exp.wraps && !e.exp.fullRing).sort((a, b) => a.exp.start - b.exp.start);
    const wrapCur = curExp.filter((e) => e.exp.wraps || e.exp.fullRing);
    const plainNxt = nxtBlobs.filter((b) => !b.wraps && !b.fullRing).sort((a, b) => a.start - b.start);
    const wrapNxt = nxtBlobs.filter((b) => b.wraps || b.fullRing);

    let i = 0, j = 0;
    while (i < plainCur.length && j < plainNxt.length) {
      const A = plainCur[i].exp, B = plainNxt[j];
      if (A.end < B.start) { i++; continue; }
      if (B.end < A.start) { j++; continue; }
      plainCur[i].blob.succ.push(B); B.pred.push(plainCur[i].blob);
      if (A.end <= B.end) i++; else j++;
    }
    for (const wc of wrapCur) for (const b of nxtBlobs) { if (intervalsOverlap(wc.exp, b, n)) { wc.blob.succ.push(b); b.pred.push(wc.blob); } }
    for (const wn of wrapNxt) for (const ce of plainCur) { if (intervalsOverlap(ce.exp, wn, n)) { ce.blob.succ.push(wn); wn.pred.push(ce.blob); } }
    // 円環をまたぐ塊どうし（前行・次行の両方が跨ぐ、稀）の組も落とさない
    for (const wc of wrapCur) for (const wn of wrapNxt) { if (intervalsOverlap(wc.exp, wn, n)) { wc.blob.succ.push(wn); wn.pred.push(wc.blob); } }
  }

  /** 鎖 = 分岐・合流の無い極大な塊の列（幅 w_max 超は鎖に入れない）。 */
  function buildChains(blobRows, tRange, n, wMax) {
    const isBridge = (b) => b.width <= wMax;
    const bijectiveNext = (b) => (isBridge(b) && b.succ.length === 1 && isBridge(b.succ[0]) && b.succ[0].pred.length === 1) ? b.succ[0] : null;
    const bijectivePrev = (b) => (isBridge(b) && b.pred.length === 1 && isBridge(b.pred[0]) && b.pred[0].succ.length === 1) ? b.pred[0] : null;
    const visited = new Set();
    const chains = [];
    for (let t = tRange[0]; t < tRange[1]; t++) {
      for (const b of blobRows[t]) {
        if (visited.has(b.id)) continue;
        if (!isBridge(b)) { chains.push({ blobs: [b], wide: true }); visited.add(b.id); continue; }
        if (bijectivePrev(b)) continue; // 途中の要素は起点にしない
        const chain = [b]; visited.add(b.id);
        let cur = b, nxt;
        while ((nxt = bijectiveNext(cur))) { chain.push(nxt); visited.add(nxt.id); cur = nxt; }
        chains.push({ blobs: chain, wide: false });
      }
    }
    return chains;
  }

  /** 厳密な粒子: 鎖の中で (P,d) が (境界の余白 m を含めて)raw cell と blob 位置が一致する区間を、P=1..Pmax の順に貪欲に探す。 */
  function findStrictSegments(chain, rawGrid, n, r, opts) {
    opts = opts || {};
    const Pmax = opts.Pmax || 12, m = opts.m != null ? opts.m : 4, nRep = opts.nRep || 4;
    const blobs = chain.blobs;
    const L = blobs.length;
    const consumed = new Array(L).fill(false);
    const segments = [];
    if (chain.wide || L < 2) return segments;

    function cellMatch(t, x, dt, dx) {
      const row1 = rawGrid[t], row2 = rawGrid[t + dt];
      const xi = ((x % n) + n) % n, xj = ((x + dx) % n + n) % n;
      return row1[xi] === row2[xj];
    }
    function contextMatches(idx, P, d) {
      const b1 = blobs[idx], b2 = blobs[idx + P];
      if (b1.fullRing || b2.fullRing) return false;
      // 位置の一致 (a,e が d だけずれる)
      const a1 = b1.start, e1 = b1.end, a2 = b2.start, e2 = b2.end;
      if (((a1 + d) % n + n) % n !== a2) return false;
      if (((e1 + d) % n + n) % n !== e2) return false;
      // 素のセル一致 x in [a1-m, e1+m]
      const lo = a1 - m, hi = e1 + m;
      for (let x = lo; x <= hi; x++) if (!cellMatch(blobs[idx].t, x, P, d)) return false;
      return true;
    }

    for (let P = 1; P <= Pmax && consumed.some((v) => !v); P++) {
      // 候補 d
      const dRange = []; for (let d = -r * P; d <= r * P; d++) dRange.push(d);
      for (const d of dRange) {
        // match[idx] = true なら idx -> idx+P の遷移が条件を満たす（idx が未消費のときだけ試す）
        let runStart = -1;
        for (let idx = 0; idx <= L - P - 1; idx++) {
          const usable = !consumed[idx] && !consumed[idx + P];
          const ok = usable && contextMatches(idx, P, d);
          if (ok) { if (runStart === -1) runStart = idx; }
          if (!ok || idx === L - P - 1) {
            if (runStart !== -1) {
              const runEnd = ok ? idx : idx - 1; // idx (inclusive) の最後の成功
              const segLen = (runEnd - runStart) + P + 1; // 行数
              if (segLen >= nRep * P) {
                const segBlobs = blobs.slice(runStart, runEnd + P + 1);
                for (let k = runStart; k <= runEnd + P; k++) consumed[k] = true;
                segments.push({ P, d, v: d / P, startIdx: runStart, endIdx: runEnd + P, blobs: segBlobs, length: segLen });
              }
              runStart = -1;
            }
          }
        }
      }
    }
    segments.sort((a, b) => a.startIdx - b.startIdx);
    return segments;
  }

  /** 型の署名（正準形）: 区間の最初の P 行の [min a - m, max e + m] の素のセルを並べ、P 通りの巡回で最小のものを採る。 */
  function typeSignature(seg, rawGrid, n, m) {
    const { P, d } = seg;
    const first = seg.blobs.slice(0, P);
    let minA = Infinity, maxE = -Infinity;
    for (const b of first) { if (!b.fullRing) { minA = Math.min(minA, b.start); maxE = Math.max(maxE, b.end); } }
    const lo = minA - m, hi = maxE + m;
    const rows = [];
    for (let k = 0; k < P; k++) {
      const t = first[k].t; const row = [];
      for (let x = lo; x <= hi; x++) row.push(rawGrid[t][((x % n) + n) % n]);
      rows.push(row.join(','));
    }
    let best = null;
    for (let k = 0; k < P; k++) {
      const rotated = rows.slice(k).concat(rows.slice(0, k)).join('|');
      if (best === null || rotated < best) best = rotated;
    }
    return { canonical: best, P, d, v: d / P, width: hi - lo + 1 };
  }

  /** 表面の周期版（欠陥の形だけ。knob）: raw cell を使わず blob の幅の列だけで正準形を作る。 */
  function surfaceSignature(seg) {
    const first = seg.blobs.slice(0, seg.P);
    const widths = first.map((b) => (b.fullRing ? -1 : b.width));
    let best = null;
    for (let k = 0; k < widths.length; k++) {
      const rotated = widths.slice(k).concat(widths.slice(0, k)).join(',');
      if (best === null || rotated < best) best = rotated;
    }
    return best;
  }

  /** 緩い粒子（Rupe の coherent structure）: 幅 w_max 以下・長さ T_loose 以上の鎖。周期は問わない。 */
  function findLooseParticles(chains, tLoose, wMax) {
    const out = [];
    for (const chain of chains) {
      if (chain.wide) continue;
      const L = chain.blobs.length;
      if (L < tLoose) continue;
      const anyWide = chain.blobs.some((b) => !b.fullRing && b.width > wMax);
      if (anyWide) continue;
      const first = chain.blobs[0].start, last = chain.blobs[L - 1].start;
      // 平均速度: 0.1刻みに丸め
      const dtSpan = chain.blobs[L - 1].t - chain.blobs[0].t;
      let disp = last - first; // 単純な差（周期境界での折り返しは無視。幅が小さいので稀）
      const vRaw = dtSpan > 0 ? disp / dtSpan : 0;
      const v = Math.round(vRaw * 10) / 10;
      out.push({ chain, length: L, v });
    }
    return out;
  }

  return {
    findRowBlobs, buildBlobRows, linkBlobRows, buildChains,
    findStrictSegments, typeSignature, surfaceSignature, findLooseParticles,
    expandInterval, intervalsOverlap, intervalCells,
  };
});
