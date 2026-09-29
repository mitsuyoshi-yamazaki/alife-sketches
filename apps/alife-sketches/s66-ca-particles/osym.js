/**
 * O-sym: 素の場から対称（並進の生成元）と瓦を自動で見つける濾過器（言語を書き込まない）。
 * criteria.json observerDetails.osym。手続きは symmetry.js（生成元探索・瓦探し）を使い、
 * 見つけた瓦へ O-lang と同じ区間の手続き（olang.js）を、情報量を log2(1/b) 単位で当てる。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else {
    root.S66Osym = factory(root.S66Symmetry, root.S66Olang);
  }
})(typeof self !== 'undefined' ? self : this, function (Sym, Olang) {
  'use strict';
  if (!Sym) Sym = require('./symmetry.js');
  if (!Olang) Olang = require('./olang.js');

  /**
   * grid: 行の配列（Uint8Array）。tRange: 生成元探索・瓦探しの窓 [t0,t1)。rng: 乱数。
   * opts: { kappa, rhoTile, IminBits, q, sampleCount, dtMax, dxMax, tileStride }
   */
  function analyze(grid, n, tRange, rng, opts) {
    opts = opts || {};
    const field = Sym.makeField(grid, n);
    const gen = Sym.searchGenerators(field, tRange, rng, {
      sampleCount: opts.sampleCount, kappa: opts.kappa, dtMax: opts.dtMax, dxMax: opts.dxMax,
    });

    if (!gen.hasBoth) {
      return {
        hasDomain: false, b: gen.b, spatialGen: null, temporalGen: null, topShifts: gen.topShifts,
        foundTiles: [], fDom: 0, domainRows: null,
      };
    }

    const s = gen.spatialGen.dx;
    const tiling = Sym.findTiles(field, s, tRange, { rhoTile: opts.rhoTile, stride: opts.tileStride });
    const b = gen.b;
    const IminBits = opts.IminBits != null ? opts.IminBits : 9;
    const q = opts.q != null ? opts.q : 1;
    const logInvB = b > 0 && b < 1 ? Math.log2(1 / b) : (b <= 0 ? 32 : 0.001);
    const IminCells = logInvB > 0 ? IminBits / logInvB : Infinity;

    if (!tiling.foundTiles.length) {
      return {
        hasDomain: false, b, spatialGen: gen.spatialGen, temporalGen: gen.temporalGen, topShifts: gen.topShifts,
        foundTiles: [], fDom: 0, domainRows: null,
      };
    }

    const templates = Olang.buildTemplates(tiling.foundTiles.map((t) => t.symbols));
    const domainRows = new Array(grid.length);
    let domainCells = 0, totalCells = 0;
    for (let t = tRange[0]; t < tRange[1]; t++) {
      const { domain } = Olang.analyzeRow(grid[t], templates, IminCells, q);
      domainRows[t] = domain;
      for (let i = 0; i < domain.length; i++) { totalCells++; if (domain[i]) domainCells++; }
    }
    const fDom = totalCells ? domainCells / totalCells : 0;

    return {
      hasDomain: true, b, spatialGen: gen.spatialGen, temporalGen: gen.temporalGen, topShifts: gen.topShifts,
      foundTiles: tiling.foundTiles, s, fDom, domainRows, IminCells,
    };
  }

  return { analyze };
});
