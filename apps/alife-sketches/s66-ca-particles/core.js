/**
 * S-66: 核。1次元セルオートマトン（ECA と範囲2の K1 規則）の力学だけを持つ。
 * 上位概念の語彙（領域・粒子・反応など）はここには無い——それは observer* / particles.js / chemistry.js /
 * hierarchy.js の仕事。Node とブラウザで共用（UMD）。依存ゼロ・古典スクリプト。
 *
 * ビット並列の更新: N は必ず32の倍数（全ての腕で 2^12 以上）。ワード w のビット b が
 * グローバルなセル位置 g = w*32+b を表す（LSB=b=0 が先頭）。全体が1つの円環（周期境界）になるよう
 * ワード間の繰り上がりを扱う。K1-fall（N=200）だけは32の倍数でないので素朴実装を使う。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.S66 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── 種つき乱数（mulberry32）。決定論的・高速・依存ゼロ ──
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function fnv1a(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return h >>> 0;
  }

  /** 走行の seed とタグ（腕名・用途）から独立な部分乱数系列を作る。K-145 の決定性の土台。 */
  function subRng(seed, tag) { return mulberry32(fnv1a(String(seed) + '|' + String(tag))); }

  // ── 規則表（Wolfram の番号付け。k = 4l+2c+r、bit k が出力） ──
  function ecaBits(ruleNumber) {
    const bits = new Uint8Array(8);
    for (let k = 0; k < 8; k++) bits[k] = (ruleNumber >>> k) & 1;
    return bits;
  }
  function ecaNaiveStep(row, bits) {
    const n = row.length, out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const l = row[(i - 1 + n) % n], c = row[i], r = row[(i + 1) % n];
      out[i] = bits[(l << 2) | (c << 1) | r];
    }
    return out;
  }

  // K1: 範囲2。近傍 (s-2..s+2) -> k=16a+8b+4c+2d+e（32通り）。ruleNumber は BigInt 対応の文字列/数値。
  function k1Bits(ruleNumberBig) {
    const big = BigInt(ruleNumberBig);
    const bits = new Uint8Array(32);
    for (let k = 0; k < 32; k++) bits[k] = Number((big >> BigInt(k)) & 1n);
    return bits;
  }
  function k1NaiveStep(row, bits) {
    const n = row.length, out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const a = row[(i - 2 + n) % n], b = row[(i - 1 + n) % n], c = row[i], d = row[(i + 1) % n], e = row[(i + 2) % n];
      out[i] = bits[(a << 4) | (b << 3) | (c << 2) | (d << 1) | e];
    }
    return out;
  }

  // ── ビット詰め（ワード配列）。N は32の倍数であること ──
  function packRow(row) {
    const nWords = row.length >>> 5;
    const words = new Uint32Array(nWords);
    for (let w = 0; w < nWords; w++) {
      let word = 0;
      const base = w * 32;
      for (let b = 0; b < 32; b++) word |= (row[base + b] & 1) << b;
      words[w] = word >>> 0;
    }
    return words;
  }
  function unpackRow(words, n) {
    const row = new Uint8Array(n);
    const nWords = words.length;
    for (let w = 0; w < nWords; w++) {
      const word = words[w], base = w * 32;
      for (let b = 0; b < 32; b++) row[base + b] = (word >>> b) & 1;
    }
    return row;
  }

  /** シフトしたセル値の配列（グローバルな円環で by だけ「左」= 位置が by 小さい方 のセルを each word に持ってくる）。 */
  function shiftCellsLeft(words, by) {
    // 出力[w] のビット b は cell(g-by) の値。g-by の位置は同じ word 内か前の word にまたがる。
    const nWords = words.length, out = new Uint32Array(nWords);
    for (let w = 0; w < nWords; w++) {
      const prev = words[(w - 1 + nWords) % nWords];
      out[w] = (((words[w] << by) >>> 0) | (prev >>> (32 - by))) >>> 0;
    }
    return out;
  }
  function shiftCellsRight(words, by) {
    const nWords = words.length, out = new Uint32Array(nWords);
    for (let w = 0; w < nWords; w++) {
      const next = words[(w + 1) % nWords];
      out[w] = ((words[w] >>> by) | ((next << (32 - by)) >>> 0)) >>> 0;
    }
    return out;
  }

  // ── ビット並列のステップ（既知の閉じた式を持つ規則） ──
  const ECA_FORMULA = {
    54: (L, C, R) => (C ^ (L | R)) >>> 0,
    18: (L, C, R) => ((~C) & (L ^ R)) >>> 0,
    30: (L, C, R) => (L ^ (C | R)) >>> 0,
    204: (L, C, R) => C >>> 0,
  };
  function stepEcaWords(words, ruleNumber) {
    const f = ECA_FORMULA[ruleNumber];
    if (!f) throw new Error('ECA ' + ruleNumber + ' の閉じたビット式が無い（core.js の ECA_FORMULA に足すこと）');
    const L = shiftCellsLeft(words, 1), R = shiftCellsRight(words, 1);
    const out = new Uint32Array(words.length);
    for (let w = 0; w < words.length; w++) out[w] = f(L[w], words[w], R[w]);
    return out;
  }

  /** K1（任意の32エントリ表）。1になっている項だけを和で足す一般形（項数は表次第。K1 の腕は小規模なので十分速い）。 */
  function stepK1Words(words, bits) {
    const L2 = shiftCellsLeft(words, 2), L1 = shiftCellsLeft(words, 1);
    const R1 = shiftCellsRight(words, 1), R2 = shiftCellsRight(words, 2);
    const out = new Uint32Array(words.length);
    for (let k = 0; k < 32; k++) {
      if (!bits[k]) continue;
      const a = (k >> 4) & 1, b = (k >> 3) & 1, c = (k >> 2) & 1, d = (k >> 1) & 1, e = k & 1;
      for (let w = 0; w < words.length; w++) {
        let term = 0xFFFFFFFF;
        term &= a ? L2[w] : (~L2[w]);
        term &= b ? L1[w] : (~L1[w]);
        term &= c ? words[w] : (~words[w]);
        term &= d ? R1[w] : (~R1[w]);
        term &= e ? R2[w] : (~R2[w]);
        out[w] = (out[w] | term) >>> 0;
      }
    }
    return out;
  }

  /** 規則の記述からステッパを作る。system.rules に従い、eca なら閉じた式、k1 なら一般形。 */
  function makeRule(kind, ruleNumber) {
    if (kind === 'eca') {
      const bits = ecaBits(ruleNumber);
      return {
        kind, ruleNumber, bits,
        stepWords: (words) => stepEcaWords(words, ruleNumber),
        stepNaive: (row) => ecaNaiveStep(row, bits),
      };
    }
    if (kind === 'k1') {
      const bits = k1Bits(ruleNumber);
      return {
        kind, ruleNumber, bits,
        stepWords: (words) => stepK1Words(words, bits),
        stepNaive: (row) => k1NaiveStep(row, bits),
      };
    }
    throw new Error('未知の規則種 ' + kind);
  }

  const RULES = {
    E54: { kind: 'eca', ruleNumber: 54 },
    E18: { kind: 'eca', ruleNumber: 18 },
    E30: { kind: 'eca', ruleNumber: 30 },
    NC204: { kind: 'eca', ruleNumber: 204 },
    K1: { kind: 'k1', ruleNumber: 2614700074 },
  };

  /** 初期の行を密度 rho0 で独立に作る。 */
  function initRow(n, rho0, rng) {
    const row = new Uint8Array(n);
    for (let i = 0; i < n; i++) row[i] = rng() < rho0 ? 1 : 0;
    return row;
  }

  /** 時空図（rows 行 × n 列の Uint8Array の配列）を、ワード表現から t0..t0+rows-1 だけ展開しつつ進める。 */
  function evolveGrid(initialRow, rule, totalSteps, opts) {
    opts = opts || {};
    const n = initialRow.length;
    const useWords = (n % 32 === 0) && rule.stepWords;
    let words = useWords ? packRow(initialRow) : null;
    let row = useWords ? null : initialRow.slice();
    const grid = new Array(totalSteps + 1);
    grid[0] = initialRow.slice();
    for (let t = 1; t <= totalSteps; t++) {
      if (useWords) { words = rule.stepWords(words); grid[t] = unpackRow(words, n); }
      else { row = rule.stepNaive(row); grid[t] = row.slice(); }
    }
    return grid;
  }

  /** 状態を先へ進めるだけ（グリッドを保持しない。長時間走行の非観測区間用）。 */
  function advance(state, rule, steps) {
    const n = state.n;
    if (state.words) { let w = state.words; for (let i = 0; i < steps; i++) w = rule.stepWords(w); return { n, words: w }; }
    let row = state.row; for (let i = 0; i < steps; i++) row = rule.stepNaive(row); return { n, row };
  }
  function makeState(row) {
    const n = row.length;
    if (n % 32 === 0) return { n, words: packRow(row) };
    return { n, row: row.slice() };
  }
  function stateToRow(state) { return state.words ? unpackRow(state.words, state.n) : state.row.slice(); }

  /** 時空図（rows×n）の窓を、状態から steps だけ進めながら取り出す（メモリを抑えるため rows 分だけ保持）。 */
  function captureWindow(state, rule, rows) {
    const n = state.n;
    const grid = new Array(rows);
    let cur = state;
    for (let i = 0; i < rows; i++) {
      grid[i] = stateToRow(cur);
      cur = advance(cur, rule, 1);
    }
    return { grid, state: cur };
  }

  function hashRow(row) {
    let h = 0x811c9dc5;
    for (let i = 0; i < row.length; i++) { h ^= row[i]; h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(16);
  }
  function hashGridSample(grid, everyRow, everyCol) {
    let h = 0x811c9dc5;
    for (let t = 0; t < grid.length; t += (everyRow || 1)) {
      const row = grid[t];
      for (let i = 0; i < row.length; i += (everyCol || 1)) { h ^= row[i]; h = Math.imul(h, 0x01000193); h ^= t; h = Math.imul(h, 0x01000193); }
    }
    return (h >>> 0).toString(16);
  }

  /** 語の回転すべてのうち辞書順最小（正準形）。配列（0/1）を受け取り文字列を返す。 */
  function canonicalRotation(bits) {
    const s = Array.prototype.join.call(bits, '');
    let best = s;
    for (let k = 1; k < s.length; k++) {
      const rot = s.slice(k) + s.slice(0, k);
      if (rot < best) best = rot;
    }
    return best;
  }

  /** 復元抽出（ブートストラップ）で配列から同じ長さの標本を1つ作る。 */
  function bootstrapResample(arr, rng) {
    const out = new Array(arr.length);
    for (let i = 0; i < arr.length; i++) out[i] = arr[Math.floor(rng() * arr.length)];
    return out;
  }

  function mean(a) { return a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN; }
  function median(a) { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
  function sd(a) { if (a.length < 2) return NaN; const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / (a.length - 1)); }

  /** 最小二乗の傾き・切片（x,y は同じ長さ）。 */
  function linreg(xs, ys) {
    const n = xs.length; const mx = mean(xs), my = mean(ys);
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sxx += (xs[i] - mx) * (xs[i] - mx); sxy += (xs[i] - mx) * (ys[i] - my); }
    const slope = sxx > 0 ? sxy / sxx : NaN;
    const intercept = my - slope * mx;
    return { slope, intercept };
  }

  return {
    mulberry32, fnv1a, subRng,
    ecaBits, ecaNaiveStep, k1Bits, k1NaiveStep,
    packRow, unpackRow, shiftCellsLeft, shiftCellsRight,
    stepEcaWords, stepK1Words, makeRule, RULES,
    initRow, evolveGrid, advance, makeState, stateToRow, captureWindow,
    hashRow, hashGridSample, canonicalRotation, bootstrapResample,
    mean, median, sd, linreg,
  };
});
