/**
 * O-lcs: 局所因果状態の場から対称と瓦を見つける濾過器（criteria.json observerDetails.olcs）。
 * 過去/未来の光円錐を数え上げ、出現5回以上の過去を無作為な順で併合（Shalizi 2006 のχ²検定）し、
 * 状態の場 S(i,t) を作る。その S へ symmetry.js の生成元探索・瓦探し（O-sym と同じ手続き）を当てる。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.S66Olcs = factory(root.S66Symmetry, root.S66Olang);
})(typeof self !== 'undefined' ? self : this, function (Sym, Olang) {
  'use strict';
  if (!Sym) Sym = require('./symmetry.js');
  if (!Olang) Olang = require('./olang.js');

  // ── χ² の片側 p 値（Numerical Recipes 型の正則化不完全ガンマ関数） ──
  function lgamma(x) {
    const g = 7;
    const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
      -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
    x -= 1;
    let a = c[0];
    const t = x + g + 0.5;
    for (let i = 1; i < g + 2; i++) a += c[i] / (x + i);
    return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
  }
  function gammaincLowerP(a, x) {
    if (x <= 0) return 0;
    if (x < a + 1) {
      let sum = 1 / a, term = sum, ap = a;
      for (let n = 1; n < 500; n++) { ap += 1; term *= x / ap; sum += term; if (Math.abs(term) < Math.abs(sum) * 1e-14) break; }
      return sum * Math.exp(-x + a * Math.log(x) - lgamma(a));
    }
    let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
    for (let i = 1; i < 500; i++) {
      const an = -i * (i - a); b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
      c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d;
      const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-14) break;
    }
    const Q = Math.exp(-x + a * Math.log(x) - lgamma(a)) * h;
    return 1 - Q;
  }
  function chiSquarePValue(stat, df) {
    if (df <= 0) return 1;
    return Math.max(0, Math.min(1, 1 - gammaincLowerP(df / 2, stat / 2)));
  }

  function computeOffsets(h, r, isFuture) {
    const offsets = [];
    if (!isFuture) for (let k = 0; k <= h; k++) { const span = r * k; for (let u = -span; u <= span; u++) offsets.push([u, -k]); }
    else for (let k = 1; k <= h; k++) { const span = r * k; for (let u = -span; u <= span; u++) offsets.push([u, k]); }
    return offsets;
  }
  /**
   * タプルの鍵。素の場は 0/1 なので、文字列連結ではなく乗算-加算で数値へ畳み込む
   * （Number は 2^53 まで正確。offsets は h-<=4 でも高々 25 要素なので余裕がある）。
   * 高速化前は行×列ごとの文字列連結が支配的コストになり、N=16384×768行の1走行が数分かかっていた。
   */
  function tupleKey(field, i, t, offsets) {
    let k = 0;
    for (let o = 0; o < offsets.length; o++) { const u = offsets[o][0], dk = offsets[o][1]; k = k * 2 + field.get(i + u, t + dk); }
    return k;
  }

  function countPasts(field, tRange, offsetsPast, offsetsFuture, n, stride) {
    const pastMap = new Map();
    for (let t = tRange[0]; t < tRange[1]; t++) {
      for (let i = 0; i < n; i += stride) {
        const pk = tupleKey(field, i, t, offsetsPast);
        const fk = tupleKey(field, i, t, offsetsFuture);
        let e = pastMap.get(pk);
        if (!e) { e = { count: 0, futures: new Map() }; pastMap.set(pk, e); }
        e.count++;
        e.futures.set(fk, (e.futures.get(fk) || 0) + 1);
      }
    }
    return pastMap;
  }

  function chiSquareTestHomogeneous(mapA, mapB) {
    const cats = new Set(); for (const k of mapA.keys()) cats.add(k); for (const k of mapB.keys()) cats.add(k);
    let totalA = 0, totalB = 0;
    for (const c of mapA.values()) totalA += c;
    for (const c of mapB.values()) totalB += c;
    const N = totalA + totalB;
    let chi2 = 0, df = 0;
    for (const cat of cats) {
      const oa = mapA.get(cat) || 0, ob = mapB.get(cat) || 0, rowTotal = oa + ob;
      if (rowTotal === 0) continue;
      const ea = totalA * rowTotal / N, eb = totalB * rowTotal / N;
      if (ea > 0) chi2 += (oa - ea) * (oa - ea) / ea;
      if (eb > 0) chi2 += (ob - eb) * (ob - eb) / eb;
      df++;
    }
    df = Math.max(df - 1, 0);
    if (df === 0) return 1;
    return chiSquarePValue(chi2, df);
  }

  function mergeStates(pastMap, alpha, rng, minCount) {
    const entries = Array.from(pastMap.entries());
    const frequent = entries.filter(([, e]) => e.count >= minCount);
    const rareEntries = entries.filter(([, e]) => e.count < minCount);
    const rareCount = rareEntries.reduce((s, [, e]) => s + e.count, 0);
    for (let i = frequent.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const tmp = frequent[i]; frequent[i] = frequent[j]; frequent[j] = tmp; }
    const states = []; const pastToState = new Map();
    for (const [pk, e] of frequent) {
      let assigned = -1;
      for (let s = 0; s < states.length; s++) {
        const p = chiSquareTestHomogeneous(e.futures, states[s].futures);
        if (p >= alpha) { assigned = s; break; }
      }
      if (assigned === -1) { states.push({ futures: new Map(e.futures), count: e.count }); assigned = states.length - 1; }
      else { const st = states[assigned]; st.count += e.count; for (const [fk, c] of e.futures) st.futures.set(fk, (st.futures.get(fk) || 0) + c); }
      pastToState.set(pk, assigned);
    }
    const totalPoints = entries.reduce((s, [, e]) => s + e.count, 0);
    return { states, pastToState, rareCount, totalPoints, frequentPastCount: frequent.length, rarePastCount: rareEntries.length };
  }

  function buildStateField(field, tRange, offsetsPast, pastToState, n) {
    const grid = new Array(tRange[1]);
    for (let t = tRange[0]; t < tRange[1]; t++) {
      const row = new Int32Array(n);
      for (let i = 0; i < n; i++) {
        const pk = tupleKey(field, i, t, offsetsPast);
        row[i] = pastToState.has(pk) ? pastToState.get(pk) : -1;
      }
      grid[t] = row;
    }
    return grid;
  }

  /**
   * rawGrid: Uint8Array行の配列（元の時空）。n: 格子幅。baseRange: 学習の生の窓 [t0,t1)（例 [128,1024)）。
   * r: 規則の半径（ECA=1, K1=2）。rng: 併合の無作為な順の乱数。opts: h-,h+,alpha,minCount,stride,domain探索の各種既定。
   */
  function analyze(rawGrid, n, baseRange, r, rng, opts) {
    opts = opts || {};
    const hMinus = opts.hMinus != null ? opts.hMinus : 3, hPlus = opts.hPlus != null ? opts.hPlus : 2;
    const alpha = opts.alpha != null ? opts.alpha : 0.05, minCount = opts.minCount != null ? opts.minCount : 5;
    const stride = opts.stride || 1;
    const offsetsPast = computeOffsets(hMinus, r, false), offsetsFuture = computeOffsets(hPlus, r, true);
    const field = Sym.makeField(rawGrid, n);
    const learnRange = [baseRange[0] + hMinus, baseRange[1] - hPlus];
    if (learnRange[1] <= learnRange[0]) throw new Error('olcs.analyze: 学習の窓が h-/h+ より短い');

    const pastMap = countPasts(field, learnRange, offsetsPast, offsetsFuture, n, stride);
    const merged = mergeStates(pastMap, alpha, rng, minCount);
    const stateCount = merged.states.length;
    const rareShare = merged.totalPoints ? merged.rareCount / merged.totalPoints : 0;
    const stateFreqs = merged.states.map((s) => s.count / merged.totalPoints);

    const sGrid = buildStateField(field, learnRange, offsetsPast, merged.pastToState, n);
    const sField = Sym.makeField(sGrid, n);

    const gen = Sym.searchGenerators(sField, learnRange, rng, {
      sampleCount: opts.sampleCount, kappa: opts.kappa, dtMax: opts.dtMax, dxMax: opts.dxMax,
    });

    let hasDomain = false, fDom = 0, foundTiles = [], domainRows = null, sOfS = null;
    if (gen.hasBoth) {
      const s = gen.spatialGen.dx;
      const tiling = Sym.findTiles(sField, s, learnRange, { rhoTile: opts.rhoTile, stride: opts.tileStride });
      const b = gen.b;
      const IminBits = opts.IminBits != null ? opts.IminBits : 9, q = opts.q != null ? opts.q : 1;
      const logInvB = b > 0 && b < 1 ? Math.log2(1 / b) : (b <= 0 ? 32 : 0.001);
      const IminCells = logInvB > 0 ? IminBits / logInvB : Infinity;
      if (tiling.foundTiles.length) {
        const templates = Olang.buildTemplates(tiling.foundTiles.map((t) => t.symbols));
        domainRows = new Array(rawGrid.length);
        let domainCells = 0, totalCells = 0;
        for (let t = learnRange[0]; t < learnRange[1]; t++) {
          const { domain } = Olang.analyzeRow(sGrid[t], templates, IminCells, q);
          domainRows[t] = domain;
          for (let i = 0; i < n; i++) { totalCells++; if (domain[i]) domainCells++; }
        }
        fDom = totalCells ? domainCells / totalCells : 0;
        hasDomain = true; foundTiles = tiling.foundTiles; sOfS = s;
      }
    }

    return {
      hMinus, hPlus, stateCount, rareShare, stateFreqs,
      spatialGen: gen.spatialGen, temporalGen: gen.temporalGen, topShifts: gen.topShifts, b: gen.b,
      hasDomain, fDom, foundTiles, s: sOfS, domainRows, sGrid, learnRange,
      frequentPastCount: merged.frequentPastCount, rarePastCount: merged.rarePastCount,
    };
  }

  return { analyze, chiSquarePValue, chiSquareTestHomogeneous, computeOffsets, mergeStates, countPasts };
});
