/**
 * S-66: O-sym と O-lcs が共用する「素の場から対称と瓦を自動で見つける」手続き。
 * 言語を書き込まない（criteria.json observerDetails.osym・olcs の (1)(2) を任意の記号の場に一般化）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.S66Symmetry = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 場のアクセサ: field.get(i,t) が円環（空間だけ周期）でセル/状態の記号を返す。 */
  function makeField(grid, n) {
    return { get: (i, t) => grid[t][((i % n) + n) % n], n, rows: grid.length };
  }

  /** 生成元の探索。dt∈[0,dtMax]・dx∈[-dxMax,dxMax]（dt=0はdx≥1）。 */
  function searchGenerators(field, tRange, rng, opts) {
    opts = opts || {};
    const sampleCount = opts.sampleCount || 200000, kappa = opts.kappa != null ? opts.kappa : 0.5;
    const dtMax = opts.dtMax != null ? opts.dtMax : 16, dxMax = opts.dxMax != null ? opts.dxMax : 16;
    const n = field.n, t0 = tRange[0], t1 = tRange[1];
    const validT1 = t1 - dtMax;
    if (validT1 <= t0) throw new Error('symmetry.searchGenerators: 窓が dtMax より短い');

    const freq = new Map(); let total = 0;
    for (let t = t0; t < t1; t++) for (let i = 0; i < n; i++) { const v = field.get(i, t); freq.set(v, (freq.get(v) || 0) + 1); total++; }
    let b = 0; for (const c of freq.values()) b += (c / total) * (c / total);

    const combos = [];
    for (let dt = 0; dt <= dtMax; dt++) {
      const dxLo = dt === 0 ? 1 : -dxMax;
      for (let dx = dxLo; dx <= dxMax; dx++) combos.push([dx, dt]);
    }
    const matchCounts = new Float64Array(combos.length);
    for (let k = 0; k < sampleCount; k++) {
      const i = Math.floor(rng() * n);
      const t = t0 + Math.floor(rng() * Math.max(1, validT1 - t0));
      const v1 = field.get(i, t);
      for (let c = 0; c < combos.length; c++) {
        const [dx, dt] = combos[c];
        if (field.get(i + dx, t + dt) === v1) matchCounts[c]++;
      }
    }
    const results = combos.map(([dx, dt], c) => {
      const a = matchCounts[c] / sampleCount;
      const e = (a - b) / (1 - b);
      return { dx, dt, a, e, candidate: e >= kappa };
    });

    const candidates = results.filter((r) => r.candidate);
    const spatialCands = candidates.filter((r) => r.dt === 0);
    let spatialGen = null;
    if (spatialCands.length) spatialGen = spatialCands.reduce((best, r) => (r.dx < best.dx ? r : best));
    const temporalCands = candidates.filter((r) => r.dt >= 1);
    let temporalGen = null;
    if (temporalCands.length) {
      const minDt = Math.min.apply(null, temporalCands.map((r) => r.dt));
      const atMinDt = temporalCands.filter((r) => r.dt === minDt);
      atMinDt.sort((a, c) => (c.e - a.e) || (Math.abs(a.dx) - Math.abs(c.dx)));
      temporalGen = atMinDt[0];
    }
    const topShifts = results.slice().sort((a, c) => c.e - a.e).slice(0, 10);
    return { b, spatialGen, temporalGen, candidates, topShifts, hasBoth: !!(spatialGen && temporalGen) };
  }

  function canonicalRotationSeq(seq) {
    let best = null;
    for (let k = 0; k < seq.length; k++) {
      const rot = seq.slice(k).concat(seq.slice(0, k)).join(',');
      if (best === null || rot < best) best = rot;
    }
    return best;
  }

  /** 見つけた瓦: 長さ s の周期(長さ2sの窓)を持つ位置の語を数え、累積割合 rhoTile まで採る。 */
  function findTiles(field, s, tRange, opts) {
    opts = opts || {};
    const rhoTile = opts.rhoTile != null ? opts.rhoTile : 0.9;
    const stride = opts.stride || 1;
    const n = field.n, t0 = tRange[0], t1 = tRange[1];
    const freq = new Map(); let totalWindows = 0;
    for (let t = t0; t < t1; t += stride) {
      for (let i = 0; i < n; i++) {
        let periodic = true;
        for (let k = 0; k < s; k++) { if (field.get(i + k, t) !== field.get(i + k + s, t)) { periodic = false; break; } }
        if (!periodic) continue;
        totalWindows++;
        const word = []; for (let k = 0; k < s; k++) word.push(field.get(i + k, t));
        const canon = canonicalRotationSeq(word);
        freq.set(canon, (freq.get(canon) || 0) + 1);
      }
    }
    const sorted = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]);
    const foundTiles = []; let cum = 0;
    for (const [word, count] of sorted) {
      foundTiles.push({ word, symbols: word.split(',').map(Number), count, share: totalWindows ? count / totalWindows : 0 });
      cum += count;
      if (totalWindows && cum / totalWindows >= rhoTile) break;
    }
    return { foundTiles, totalWindows, distinctWords: sorted.length };
  }

  return { makeField, searchGenerators, findTiles, canonicalRotationSeq };
});
