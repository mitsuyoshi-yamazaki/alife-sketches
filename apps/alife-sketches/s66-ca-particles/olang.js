/**
 * O-lang: 領域の言語を人が書き込んだ濾過器（criteria.json observerDetails.olang）。
 * 瓦（ワイルドカードつきの周期パターン）× 位相ごとに、行が矛盾しない極大な区間を探し、
 * 情報量（固定セルの数）が I_min 以上のものを資格ある区間とする。セル x は、資格ある区間の
 * ラベル集合 |Λ(x)|=1 かつ近傍 q が同じラベルのときだけ領域のセル。それ以外は欠陥。
 *
 * 空間は周期境界（円環）として扱う——ラップアラウンドする区間も正しく数える。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.S66Olang = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 腕ごとの瓦（言語）の定義。NC は E54 の言語を当てる（Shalizi の罠の検査）。 */
  const TILE_SPECS = {
    E54: ['0001', '1110'], E54long: ['0001', '1110'], E54d20: ['0001', '1110'],
    NCfrozen: ['0001', '1110'], NCrowshuffle: ['0001', '1110'], NCiid: ['0001', '1110'], NCE30: ['0001', '1110'],
    E18: ['0*'], E18long: ['0*'],
    K1: ['0*', '110*'], K1fall: ['0*', '110*'],
  };

  /** patterns: 文字列（'0001'・'0*' 等）または記号の配列（ワイルドカード無し。O-sym/O-lcs の見つけた瓦用）。 */
  function buildTemplates(patterns) {
    return patterns.map((s) => {
      if (Array.isArray(s)) return { name: s.join(','), period: s.length, template: s.slice() };
      const chars = s.split('');
      const template = chars.map((ch) => (ch === '*' ? null : Number(ch)));
      return { name: s, period: template.length, template };
    });
  }

  /** 1つの瓦×位相について、行（円環）上の資格ある区間を全て求める。 */
  function scanPhase(row, tile, phase, Imin) {
    const n = row.length, p = tile.period, tpl = tile.template;
    const matchable = new Uint8Array(n), fixedHere = new Uint8Array(n);
    for (let j = 0; j < n; j++) {
      const tp = (((j - phase) % p) + p) % p;
      const w = tpl[tp];
      if (w === null) { matchable[j] = 1; fixedHere[j] = 0; }
      else { matchable[j] = row[j] === w ? 1 : 0; fixedHere[j] = 1; }
    }
    let startIdx = -1;
    for (let j = 0; j < n; j++) if (!matchable[j]) { startIdx = j; break; }
    const intervals = [];
    if (startIdx === -1) {
      let fixedCount = 0; for (let j = 0; j < n; j++) fixedCount += fixedHere[j];
      if (fixedCount >= Imin) intervals.push({ tileName: tile.name, phase, start: 0, end: n - 1, wraps: false, fixedCount, length: n });
      return intervals;
    }
    let i = 0;
    while (i < n) {
      const idx = (startIdx + 1 + i) % n;
      if (!matchable[idx]) { i++; continue; }
      const runStart = idx; let fixedCount = 0, len = 0;
      while (i < n) {
        const idx2 = (startIdx + 1 + i) % n;
        if (!matchable[idx2]) break;
        fixedCount += fixedHere[idx2]; len++; i++;
      }
      const runEndIdx = (startIdx + 1 + i - 1 + n) % n;
      if (fixedCount >= Imin) intervals.push({ tileName: tile.name, phase, start: runStart, end: runEndIdx, wraps: runStart > runEndIdx, fixedCount, length: len });
    }
    return intervals;
  }

  function allIntervalsForRow(row, templates, Imin) {
    const intervals = [];
    for (const tile of templates) for (let phase = 0; phase < tile.period; phase++) {
      intervals.push.apply(intervals, scanPhase(row, tile, phase, Imin));
    }
    return intervals;
  }

  function labelId(iv) { return iv.tileName + '#' + iv.phase; }

  /** 1行を解析: domain(1=領域,0=欠陥) と labelKey（領域なら "tile#phase"、欠陥なら null）を返す。 */
  function analyzeRow(row, templates, Imin, q) {
    const n = row.length;
    const intervals = allIntervalsForRow(row, templates, Imin);
    const count = new Int32Array(n), mixed = new Uint8Array(n);
    const singleId = new Array(n).fill(null);
    for (const iv of intervals) {
      const id = labelId(iv);
      const markCell = (c) => {
        if (count[c] === 0) { count[c] = 1; singleId[c] = id; }
        else if (singleId[c] === id) { /* 同じラベルの重複区間 */ }
        else { count[c]++; mixed[c] = 1; }
      };
      if (!iv.wraps) { for (let c = iv.start; c <= iv.end; c++) markCell(c); }
      else { for (let c = iv.start; c < n; c++) markCell(c); for (let c = 0; c <= iv.end; c++) markCell(c); }
    }
    const rawDomainLabel = new Array(n);
    for (let x = 0; x < n; x++) rawDomainLabel[x] = (count[x] === 1 && !mixed[x]) ? singleId[x] : null;
    const domain = new Uint8Array(n), labelKey = new Array(n).fill(null);
    for (let x = 0; x < n; x++) {
      if (rawDomainLabel[x] === null) continue;
      let ok = true;
      for (let d = -q; d <= q; d++) {
        const c = ((x + d) % n + n) % n;
        if (rawDomainLabel[c] !== rawDomainLabel[x]) { ok = false; break; }
      }
      if (ok) { domain[x] = 1; labelKey[x] = rawDomainLabel[x]; }
    }
    return { domain, labelKey, intervals };
  }

  /** グリッド（行の配列）全体を解析。 rowRange = [start,end) を渡せばその範囲だけ処理して f_dom を計算する。 */
  function analyzeGrid(grid, tileNames, Imin, q, rowRange) {
    const templates = buildTemplates(tileNames);
    const t0 = rowRange ? rowRange[0] : 0, t1 = rowRange ? rowRange[1] : grid.length;
    const domainRows = new Array(grid.length), labelRows = new Array(grid.length);
    let domainCells = 0, totalCells = 0;
    for (let t = t0; t < t1; t++) {
      const { domain, labelKey } = analyzeRow(grid[t], templates, Imin, q);
      domainRows[t] = domain; labelRows[t] = labelKey;
      for (let i = 0; i < domain.length; i++) { totalCells++; if (domain[i]) domainCells++; }
    }
    return { domainRows, labelRows, fDom: totalCells ? domainCells / totalCells : 0, tileNames };
  }

  /** Boccara の変換（正コントロール向け）: 長さ4の窓が Λ54 のどれかの位相と矛盾しない ⇔ 1の数が奇数。 */
  function boccaraWindowIsDomain(w4) { return (w4[0] + w4[1] + w4[2] + w4[3]) % 2 === 1; }

  return { TILE_SPECS, buildTemplates, analyzeRow, analyzeGrid, boccaraWindowIsDomain, scanPhase };
});
