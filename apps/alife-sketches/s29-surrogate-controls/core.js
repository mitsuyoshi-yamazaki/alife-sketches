/*
 * S-29 核 — 代理データの生成器の階層と、再実装した判定器・収支の検査。
 *
 * 依存ゼロ・古典スクリプト。Node（CommonJS）とブラウザ（window.S29）で共用する。
 *
 * 語彙の規約: この核は上位概念の語彙を識別子・分岐に持たない。扱うのは
 * 「表（rows × cols）」「列（channel）」「並べ替え」「差分」「恒等式」だけである。
 * 入力表の列名（他スケッチの生ログの欄名）は文字列データとしてのみ現れる。
 */
(function (global) {
  'use strict';

  // ------------------------------------------------------------ 乱数

  /** 決定的な 32bit 乱数。同じ種なら完全に同じ列を返す。 */
  function makeRng(seed) {
    var s = (seed >>> 0) || 1;
    return function () {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    };
  }

  /** 正規乱数（Box-Muller）。 */
  function makeGauss(rng) {
    var spare = null;
    return function () {
      if (spare !== null) { var v = spare; spare = null; return v; }
      var u = 0, w = 0, r = 0;
      do {
        u = rng() * 2 - 1; w = rng() * 2 - 1; r = u * u + w * w;
      } while (r <= 0 || r >= 1);
      var f = Math.sqrt(-2 * Math.log(r) / r);
      spare = w * f;
      return u * f;
    };
  }

  /** Fisher-Yates。与えた配列を複製して返す（元を書き換えない）。 */
  function shuffled(arr, rng) {
    var out = arr.slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  }

  function identityOrder(n) {
    var a = new Array(n);
    for (var i = 0; i < n; i++) a[i] = i;
    return a;
  }

  // ------------------------------------------------------------ 離散フーリエ変換

  // 系列は 20〜110 点と短いので、素朴な O(n^2) の変換に回転因子表を添えて使う。
  // 長さを選ばない（2 のべき乗へ詰めない）ので、スペクトルの意味が系列長に依存しない。
  var TWIDDLE = {};
  function twiddle(n) {
    if (TWIDDLE[n]) return TWIDDLE[n];
    var half = (n >> 1) + 1;
    var cos = new Float64Array(half * n), sin = new Float64Array(half * n);
    for (var k = 0; k < half; k++) {
      for (var t = 0; t < n; t++) {
        var a = -2 * Math.PI * k * t / n;
        cos[k * n + t] = Math.cos(a);
        sin[k * n + t] = Math.sin(a);
      }
    }
    TWIDDLE[n] = { n: n, half: half, cos: cos, sin: sin };
    return TWIDDLE[n];
  }

  /** 実数列 → 半スペクトル {re, im}（k = 0..floor(n/2)）。 */
  function halfSpectrum(x) {
    var n = x.length, tw = twiddle(n), half = tw.half;
    var re = new Float64Array(half), im = new Float64Array(half);
    for (var k = 0; k < half; k++) {
      var sr = 0, si = 0, base = k * n;
      for (var t = 0; t < n; t++) {
        sr += x[t] * tw.cos[base + t];
        si += x[t] * tw.sin[base + t];
      }
      re[k] = sr; im[k] = si;
    }
    return { re: re, im: im, n: n };
  }

  /** 半スペクトル → 実数列（共役対称を仮定した逆変換）。 */
  function fromHalfSpectrum(sp) {
    var n = sp.n, tw = twiddle(n), half = tw.half;
    var out = new Float64Array(n);
    for (var t = 0; t < n; t++) {
      var acc = sp.re[0];
      for (var k = 1; k < half; k++) {
        var isMirror = (k * 2 === n);
        // 回転因子表は exp(-i*2pi*k*t/n) を持つので、逆変換 Re(X_k exp(+i*2pi*k*t/n)) は
        // re*cos(-a) + im*(-sin(-a)) すなわち re*cos + im*sin になる
        var c = tw.cos[k * n + t], s = tw.sin[k * n + t];
        var term = sp.re[k] * c + sp.im[k] * s;
        acc += isMirror ? term : 2 * term;
      }
      out[t] = acc / n;
    }
    return out;
  }

  /** パワースペクトル（半分）。 */
  function powerSpectrum(x) {
    var sp = halfSpectrum(x), p = new Float64Array(sp.re.length);
    for (var k = 0; k < p.length; k++) p[k] = sp.re[k] * sp.re[k] + sp.im[k] * sp.im[k];
    return p;
  }

  // ------------------------------------------------------------ 基本統計

  function mean(a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; }

  function median(a) {
    if (!a.length) return 0;
    var b = a.slice().sort(function (x, y) { return x - y; });
    var m = b.length >> 1;
    return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
  }

  function sd(a) {
    if (a.length < 2) return 0;
    var m = mean(a), s = 0;
    for (var i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
    return Math.sqrt(s / (a.length - 1));
  }

  /** 遅れ1の自己相関。定数列では 0 を返す。 */
  function acf1(x) {
    var n = x.length;
    if (n < 3) return 0;
    var m = mean(x), num = 0, den = 0;
    for (var i = 0; i < n; i++) den += (x[i] - m) * (x[i] - m);
    if (den <= 1e-300) return 0;
    for (var j = 1; j < n; j++) num += (x[j] - m) * (x[j - 1] - m);
    return num / den;
  }

  /**
   * 順位。**同値には平均順位を割り当てる**。
   * 出現順で割り振ると、値が全部同じ列でも順位が 0,1,2,... になり、
   * 並べ替えても順位相関が 1 に見える——測る道具が現象を作る（K-38）。
   */
  function ranks(x) {
    var n = x.length, idx = identityOrder(n);
    idx.sort(function (a, b) { return x[a] - x[b] || a - b; });
    var r = new Array(n), i = 0;
    while (i < n) {
      var j = i;
      while (j + 1 < n && x[idx[j + 1]] === x[idx[i]]) j++;
      var mid = (i + j) / 2;
      for (var k = i; k <= j; k++) r[idx[k]] = mid;
      i = j + 1;
    }
    return r;
  }

  /** Spearman 順位相関。 */
  function spearman(a, b) {
    var ra = ranks(a), rb = ranks(b), n = a.length;
    if (n < 3) return 0;
    var ma = (n - 1) / 2, num = 0, da = 0, db = 0;
    for (var i = 0; i < n; i++) {
      num += (ra[i] - ma) * (rb[i] - ma);
      da += (ra[i] - ma) * (ra[i] - ma);
      db += (rb[i] - ma) * (rb[i] - ma);
    }
    return (da <= 0 || db <= 0) ? 0 : num / Math.sqrt(da * db);
  }

  /** 多重集合（値の並べ替え不変な内容）が一致するかの最大差。 */
  function multisetGap(a, b) {
    if (a.length !== b.length) return Infinity;
    var x = a.slice().sort(function (p, q) { return p - q; });
    var y = b.slice().sort(function (p, q) { return p - q; });
    var g = 0;
    for (var i = 0; i < x.length; i++) g = Math.max(g, Math.abs(x[i] - y[i]));
    return g;
  }

  /** パワースペクトルの相対距離（0 が一致）。 */
  function spectrumGap(a, b) {
    var pa = powerSpectrum(a), pb = powerSpectrum(b);
    var num = 0, den = 0;
    for (var k = 1; k < pa.length; k++) { num += Math.abs(pa[k] - pb[k]); den += pa[k]; }
    return den <= 1e-300 ? 0 : num / den;
  }

  /** 決定的な状態ハッシュ（K-36）。文字列 → 16 進 16 桁。 */
  function hashString(s) {
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      h1 ^= c; h1 = Math.imul(h1, 16777619) >>> 0;
      h2 = (Math.imul(h2 ^ c, 2654435761) + ((h2 << 7) | (h2 >>> 25))) >>> 0;
    }
    var a = ('00000000' + h1.toString(16)).slice(-8);
    var b = ('00000000' + h2.toString(16)).slice(-8);
    return a + b;
  }

  /** 表の状態ハッシュ。値を 9 桁へ丸めてから畳む。 */
  function hashTable(table) {
    var parts = [];
    for (var c = 0; c < table.cols.length; c++) {
      parts.push(table.cols[c]);
      var col = table.data[c];
      for (var i = 0; i < col.length; i++) parts.push(col[i].toPrecision(9));
    }
    return hashString(parts.join('|'));
  }

  // ------------------------------------------------------------ 表

  /**
   * 表 = { cols: [列名], data: [列ごとの Float64Array], n: 行数, meta: {...} }
   * すべての生成器はこの形だけを見る。
   */
  function makeTable(cols, columns, meta, fixed) {
    var n = columns[0].length;
    var data = columns.map(function (c) { return Float64Array.from(c); });
    return { cols: cols.slice(), data: data, n: n, meta: meta || {}, fixed: (fixed || []).slice() };
  }

  function cloneTable(t) {
    return {
      cols: t.cols.slice(), data: t.data.map(function (c) { return Float64Array.from(c); }),
      n: t.n, meta: t.meta, fixed: (t.fixed || []).slice(),
    };
  }

  /** 代理の対象になる列（固定列＝索引と参照点は対象外）。 */
  function movableIndices(t) {
    var fixed = t.fixed || [], out = [];
    for (var c = 0; c < t.cols.length; c++) if (fixed.indexOf(t.cols[c]) < 0) out.push(c);
    return out;
  }

  function colOf(t, name) {
    var i = t.cols.indexOf(name);
    return i < 0 ? null : t.data[i];
  }

  // ------------------------------------------------------------ 代理生成器の階層

  /** 位相を無作為化した実数列（平均は保たれる）。 */
  function phaseRandomise(x, rng) {
    var sp = halfSpectrum(x), n = sp.n, half = sp.re.length;
    var re = new Float64Array(half), im = new Float64Array(half);
    re[0] = sp.re[0]; im[0] = 0;          // 直流成分（＝総和）は保つ
    for (var k = 1; k < half; k++) {
      var amp = Math.sqrt(sp.re[k] * sp.re[k] + sp.im[k] * sp.im[k]);
      if (k * 2 === n) {                   // 偶数長の折り返し点は実数でなければならない
        re[k] = (rng() < 0.5 ? -1 : 1) * amp; im[k] = 0;
      } else {
        var ph = rng() * 2 * Math.PI;
        re[k] = amp * Math.cos(ph); im[k] = amp * Math.sin(ph);
      }
    }
    return fromHalfSpectrum({ re: re, im: im, n: n });
  }

  /** 参照列の順位へ、値の並びを写す（順位写像）。 */
  function mapToRanks(sortedValues, reference) {
    var idx = identityOrder(reference.length);
    idx.sort(function (a, b) { return reference[a] - reference[b] || a - b; });
    var out = new Float64Array(reference.length);
    for (var i = 0; i < idx.length; i++) out[idx[i]] = sortedValues[i];
    return out;
  }

  /** G1: 振幅調整フーリエ変換（AAFT）。 */
  function aaft(x, rng) {
    var n = x.length;
    var gauss = makeGauss(rng);
    var g = new Array(n);
    for (var i = 0; i < n; i++) g[i] = gauss();
    g.sort(function (a, b) { return a - b; });
    var y = mapToRanks(g, x);                       // データを正規化した列へ
    var yPhase = phaseRandomise(y, rng);            // 位相を壊す
    var sortedX = Array.prototype.slice.call(x).sort(function (a, b) { return a - b; });
    return mapToRanks(sortedX, yPhase);             // 元の値の集合へ戻す
  }

  /**
   * G2: 反復 AAFT（iAAFT）。
   *
   * 原典（Schreiber & Schmitz 1996 / 2000）の記述どおり:
   *   ①値を昇順に並べた表と、元の系列のフーリエ振幅 |S_k| を保存する
   *   ②復元なしの無作為並べ替えから始める
   *   ③各反復は 2 段: (a) フーリエ振幅を |S_k| で置き換えて戻す（位相は保つ）
   *                    (b) 順位写像で元の値の集合へ戻す
   *   ④「並べ替えが起きなくなった時点」が不動点であり、有限 N では有限回で到達する
   * 返すのは分布側の系列 r^(∞)（＝値の多重集合が厳密に一致する側）。
   */
  function iaaft(x, rng, iterations) {
    var n = x.length;
    var target = powerSpectrum(x);
    var amp = new Float64Array(target.length);
    for (var k = 0; k < amp.length; k++) amp[k] = Math.sqrt(target[k]);
    var sortedX = Array.prototype.slice.call(x).sort(function (a, b) { return a - b; });
    var cur = Float64Array.from(shuffled(Array.prototype.slice.call(x), rng));
    var maxIters = iterations || 40;
    var used = 0;
    for (var it = 0; it < maxIters; it++) {
      var sp = halfSpectrum(cur);
      var re = new Float64Array(sp.re.length), im = new Float64Array(sp.re.length);
      for (var j = 0; j < sp.re.length; j++) {
        var a = Math.sqrt(sp.re[j] * sp.re[j] + sp.im[j] * sp.im[j]);
        if (a <= 1e-300) { re[j] = amp[j]; im[j] = 0; }
        else { re[j] = sp.re[j] / a * amp[j]; im[j] = sp.im[j] / a * amp[j]; }
        if (j * 2 === n) im[j] = 0;
      }
      im[0] = 0;
      var back = fromHalfSpectrum({ re: re, im: im, n: n });
      var next = mapToRanks(sortedX, back);         // 最後は必ず振幅調整で終える
      used = it + 1;
      var moved = false;
      for (var q = 0; q < n; q++) if (next[q] !== cur[q]) { moved = true; break; }
      cur = next;
      if (!moved) break;                            // 不動点（並べ替えが起きなくなった）
    }
    cur.iaaftIterations = used;
    return cur;
  }

  /** 原典の相対食い違い: sum_k (S^(i)_k - S_k)^2 / sum_k S_k^2。 */
  function spectrumDiscrepancy(x, y) {
    var px = powerSpectrum(x), py = powerSpectrum(y);
    var num = 0, den = 0;
    for (var k = 0; k < px.length; k++) {
      var a = Math.sqrt(px[k]), b = Math.sqrt(py[k]);
      num += (b - a) * (b - a); den += a * a;
    }
    return den <= 1e-300 ? 0 : num / den;
  }

  /** G3: 循環ブロック・ブートストラップ。 */
  function circularBlocks(x, rng, blockLen) {
    var n = x.length;
    var b = Math.max(2, Math.min(n, blockLen | 0));
    var out = new Float64Array(n), pos = 0;
    while (pos < n) {
      var start = Math.floor(rng() * n);
      for (var i = 0; i < b && pos < n; i++, pos++) out[pos] = x[(start + i) % n];
    }
    return out;
  }

  /** 階層の宣言。「何を保ち、何を壊すか」をここに書き、selftest が機械検査する。 */
  var LEVELS = [
    {
      id: 'G0', name: '完全置換（列ごと独立）',
      preserves: ['列ごとの値の多重集合'],
      destroys: ['時間順序', '自己相関', 'スペクトル', '行（同時刻）のチャネル間の対応'],
      joint: false,
    },
    {
      id: 'G1', name: 'AAFT（列ごと独立）',
      preserves: ['列ごとの値の多重集合', 'パワースペクトル（近似）'],
      destroys: ['時間順序', '非線形構造', '行（同時刻）のチャネル間の対応'],
      joint: false,
    },
    {
      id: 'G2', name: 'iAAFT（列ごと独立）',
      preserves: ['列ごとの値の多重集合', 'パワースペクトル（AAFT より厳密）'],
      destroys: ['時間順序', '非線形構造', '行（同時刻）のチャネル間の対応'],
      joint: false,
    },
    {
      id: 'G3', name: 'ブロック・ブートストラップ（列ごと独立）',
      preserves: ['ブロック長以内の局所的な時間構造', '値の分布（近似）'],
      destroys: ['ブロックをまたぐ構造', '値の多重集合（復元抽出のため）', '行のチャネル間の対応'],
      joint: false,
    },
    {
      id: 'G4', name: '行の置換（結合）',
      preserves: ['行（同時刻のチャネルの組）の多重集合', '列ごとの値の多重集合', '同時刻の恒等式'],
      destroys: ['時間順序', '自己相関', '単調性', '差分の恒等式'],
      joint: true,
    },
    {
      id: 'G5', name: '差分の置換（結合）',
      preserves: ['差分ベクトルの多重集合', '両端の値', '総和', '単調性', '差分と同時刻の恒等式'],
      destroys: ['差分の時間順序', '値の多重集合'],
      joint: true,
    },
  ];

  var LEVEL_IDS = LEVELS.map(function (l) { return l.id; });

  /**
   * 表から代理表を作る。
   * opts: { blockLen, iaaftIterations }
   */
  function surrogate(table, levelId, seed, opts) {
    opts = opts || {};
    var n = table.n;
    var out = cloneTable(table);
    var rng = makeRng(seed);
    var blockLen = opts.blockLen || Math.max(2, Math.floor(n / 8));
    var iters = opts.iaaftIterations || 20;
    var move = movableIndices(table);
    var q, c, i;

    if (levelId === 'G0') {
      for (q = 0; q < move.length; q++) {
        c = move[q];
        var s0 = makeRng(seed + 1013 * (c + 1));
        out.data[c] = Float64Array.from(shuffled(Array.prototype.slice.call(table.data[c]), s0));
      }
    } else if (levelId === 'G1') {
      for (q = 0; q < move.length; q++) { c = move[q]; out.data[c] = aaft(table.data[c], makeRng(seed + 2027 * (c + 1))); }
    } else if (levelId === 'G2') {
      for (q = 0; q < move.length; q++) { c = move[q]; out.data[c] = iaaft(table.data[c], makeRng(seed + 3041 * (c + 1)), iters); }
    } else if (levelId === 'G3') {
      for (q = 0; q < move.length; q++) { c = move[q]; out.data[c] = circularBlocks(table.data[c], makeRng(seed + 4051 * (c + 1)), blockLen); }
    } else if (levelId === 'G4') {
      var perm = shuffled(identityOrder(n), rng);
      for (q = 0; q < move.length; q++) {
        c = move[q];
        var col = new Float64Array(n);
        for (i = 0; i < n; i++) col[i] = table.data[c][perm[i]];
        out.data[c] = col;
      }
    } else if (levelId === 'G5') {
      var order = shuffled(identityOrder(Math.max(0, n - 1)), rng);
      for (q = 0; q < move.length; q++) {
        c = move[q];
        var src = table.data[c];
        var col2 = new Float64Array(n);
        col2[0] = src[0];
        for (i = 1; i < n; i++) {
          var k = order[i - 1];
          col2[i] = col2[i - 1] + (src[k + 1] - src[k]);
        }
        out.data[c] = col2;
      }
    } else {
      throw new Error('unknown level ' + levelId);
    }
    // meta は元の表のものをそのまま引き継ぐ（収支の計算に要る定数が入っているため）。
    // 上書きすると S-02 の収支が評価できなくなる——予測表の外れがこの欠陥を捕まえた。
    out.meta = table.meta;
    out.level = levelId;
    out.seed = seed;
    return out;
  }

  // ------------------------------------------------------------ 生成器そのものを疑う（K-17 を自分へ）

  /**
   * 元の表と代理表で、宣言した統計量が実際に保たれ／壊れているかを測る。
   * 返すのは数値だけで、合否の判定は selftest 側で閾値と突き合わせる。
   */
  function structureProbe(original, surro) {
    var n = original.n, move = movableIndices(original);
    var msGap = 0, specGap = 0, absSpearman = 0, acfGap = 0;
    var spSum = 0, specSum = 0, acfSum = 0;
    for (var q = 0; q < move.length; q++) {
      var c = move[q];
      var a = original.data[c], b = surro.data[c];
      msGap = Math.max(msGap, relGap(multisetGap(Array.prototype.slice.call(a), Array.prototype.slice.call(b)), a));
      var sg = spectrumGap(a, b); specGap = Math.max(specGap, sg); specSum += sg;
      var sp = Math.abs(spearman(Array.prototype.slice.call(a), Array.prototype.slice.call(b)));
      absSpearman = Math.max(absSpearman, sp); spSum += sp;
      var ag = Math.abs(acf1(a) - acf1(b)); acfGap = Math.max(acfGap, ag); acfSum += ag;
    }
    var k = Math.max(1, move.length);
    return {
      multisetGap: msGap,
      spectrumGap: specGap,
      meanSpectrumGap: specSum / k,
      maxAbsSpearman: absSpearman,
      meanAbsSpearman: spSum / k,
      acf1Gap: acfGap,
      meanAcf1Gap: acfSum / k,
      rowMultisetGap: rowMultisetGap(original, surro),
      incrementRowMultisetGap: incrementRowMultisetGap(original, surro),
      endpointGap: endpointGap(original, surro),
      n: n,
    };
  }

  function relGap(gap, ref) {
    var scale = 0;
    for (var i = 0; i < ref.length; i++) scale = Math.max(scale, Math.abs(ref[i]));
    return scale > 0 ? gap / scale : gap;
  }

  function rowKeys(t) {
    var move = movableIndices(t), keys = new Array(t.n);
    for (var i = 0; i < t.n; i++) {
      var parts = new Array(move.length);
      for (var q = 0; q < move.length; q++) parts[q] = t.data[move[q]][i].toPrecision(9);
      keys[i] = parts.join(',');
    }
    return keys;
  }

  function multisetOfStringsGap(a, b) {
    if (a.length !== b.length) return 1;
    var m = {}, i, k;
    for (i = 0; i < a.length; i++) { k = a[i]; m[k] = (m[k] || 0) + 1; }
    var miss = 0;
    for (i = 0; i < b.length; i++) {
      k = b[i];
      if (m[k]) m[k]--; else miss++;
    }
    return miss / a.length;
  }

  function rowMultisetGap(a, b) { return multisetOfStringsGap(rowKeys(a), rowKeys(b)); }

  function incrementRows(t) {
    var move = movableIndices(t), keys = new Array(Math.max(0, t.n - 1));
    for (var i = 1; i < t.n; i++) {
      var parts = new Array(move.length);
      for (var q = 0; q < move.length; q++) {
        var c = move[q];
        parts[q] = (t.data[c][i] - t.data[c][i - 1]).toPrecision(9);
      }
      keys[i - 1] = parts.join(',');
    }
    return keys;
  }

  function incrementRowMultisetGap(a, b) { return multisetOfStringsGap(incrementRows(a), incrementRows(b)); }

  function endpointGap(a, b) {
    var g = 0, move = movableIndices(a);
    for (var q = 0; q < move.length; q++) {
      var c = move[q];
      var s = 0;
      for (var i = 0; i < a.n; i++) s = Math.max(s, Math.abs(a.data[c][i]));
      var d = Math.max(Math.abs(a.data[c][0] - b.data[c][0]), Math.abs(a.data[c][a.n - 1] - b.data[c][b.n - 1]));
      g = Math.max(g, s > 0 ? d / s : d);
    }
    return g;
  }

  // ------------------------------------------------------------ 判定器（他スケッチからの再実装）

  // 各判定器は表だけを受け取り、{ t1, t2, value1, value2 } を返す。
  // t1 = その源が事前登録した主の規則、t2 = 同じ源の第二の規則。
  // 借りている閾値は BORROWED にまとめ、観測器のノブとは別に扱う（K-51）。

  var BORROWED = {
    'S-02': { clusterFraction: 0.5, spreadRatio: 1.5, minClusterSize: 10, clusterRadius: 1.5 },
    'S-04': { speciesEntropyRatio: 0.5, dominantFraction: 0.5, tailFraction: 0.2, capacity: 300 },
    'S-06': { cyclicRatio: 1.5, ringStates: 4, sites: 22500 },
    'S-13': { pointwiseEnvelope: '各点包絡線の外（走査版）' },
    'S-16': { taskTypesCredited: 1, maxRankCredited: 1 },
  };

  /** 窓の集約。aggregate は 'mean' | 'median' | 'last'。 */
  function tailAggregate(col, tailFraction, aggregate) {
    var n = col.length;
    if (aggregate === 'last') return col[n - 1];
    var from = Math.max(0, n - Math.max(1, Math.round(n * tailFraction)));
    var w = Array.prototype.slice.call(col, from);
    return aggregate === 'median' ? median(w) : mean(w);
  }

  var DETECTORS = {
    // S-02: 半径 1.5 で繋がる規模10以上の成分に属する割合が 0.5 以上（登録どおり終端の1時点）。
    'S-02': function (t, knob) {
      var cf = tailAggregate(colOf(t, 'clusterFraction'), knob.tailFraction, knob.aggregate);
      var sr = tailAggregate(colOf(t, 'spreadRatio'), knob.tailFraction, knob.aggregate);
      return { t1: cf >= BORROWED['S-02'].clusterFraction, t2: sr >= BORROWED['S-02'].spreadRatio, v1: cf, v2: sr };
    },
    // S-04: 最後の窓の平均 speciesEntropyRatio が 0.5 以下（＝配列情報が保たれている）。
    'S-04': function (t, knob) {
      var se = tailAggregate(colOf(t, 'speciesEntropyRatio'), knob.tailFraction, knob.aggregate);
      var df = tailAggregate(colOf(t, 'dominantFraction'), knob.tailFraction, knob.aggregate);
      return { t1: se <= BORROWED['S-04'].speciesEntropyRatio, t2: df >= BORROWED['S-04'].dominantFraction, v1: se, v2: df };
    },
    // S-06: cyclicRatio が 1.5 以上（輪に沿って回る波）。第二項は 4 状態すべての存続。
    'S-06': function (t, knob) {
      var cr = tailAggregate(colOf(t, 'cyclicRatio'), knob.tailFraction, knob.aggregate);
      var rs = tailAggregate(colOf(t, 'ringStatesPresent'), knob.tailFraction, knob.aggregate);
      return { t1: cr >= BORROWED['S-06'].cyclicRatio, t2: rs >= BORROWED['S-06'].ringStates - 1e-9, v1: cr, v2: rs };
    },
    // S-13: 各点包絡線を走査して「どこかの半径で外れたら構造あり」（S-13 が偽陽性率 0.530 を実測した手続き）。
    'S-13': function (t) {
      var L = colOf(t, 'Lminus'), lo = colOf(t, 'LminusEnvLo'), hi = colOf(t, 'LminusEnvHi');
      var G = colOf(t, 'G'), glo = colOf(t, 'GEnvLo'), ghi = colOf(t, 'GEnvHi');
      var outL = 0, outG = 0;
      for (var i = 0; i < t.n; i++) {
        if (L[i] < lo[i] || L[i] > hi[i]) outL++;
        if (G[i] < glo[i] || G[i] > ghi[i]) outG++;
      }
      return { t1: outL > 0, t2: outG > 0, v1: outL / t.n, v2: outG / t.n };
    },
    // S-16: 終端までに credited となった演算の種類数が 1 以上。
    'S-16': function (t, knob) {
      var tt = tailAggregate(colOf(t, 'taskTypesCredited'), knob.tailFraction, knob.aggregate);
      var mr = tailAggregate(colOf(t, 'maxRankCredited'), knob.tailFraction, knob.aggregate);
      return { t1: tt >= BORROWED['S-16'].taskTypesCredited, t2: mr >= BORROWED['S-16'].maxRankCredited, v1: tt, v2: mr };
    },
  };

  // ------------------------------------------------------------ 収支（見せるために作られていないチャネル）

  // 各条件は { id, kind, test(table, tol) -> 破れの最大値 } を返す。
  // kind: 'pointwise'（同時刻の恒等式）/ 'monotone'（累積量）/ 'range'（値域）

  function maxViolation(t, f) {
    var v = 0;
    for (var i = 0; i < t.n; i++) v = Math.max(v, f(i));
    return v;
  }

  function monotoneViolation(col) {
    var v = 0;
    for (var i = 1; i < col.length; i++) v = Math.max(v, col[i - 1] - col[i]);
    return v;
  }

  var BUDGETS = {
    'S-02': [
      { id: 'B02-a', kind: 'pointwise', tol: 1e-9, note: '規模10以上の成分に属する粒子数が、成分の数 × 10 を下回らない',
        test: function (t) {
          var cf = colOf(t, 'clusterFraction'), cc = colOf(t, 'clusterCount'), n = t.meta.particles;
          return maxViolation(t, function (i) { return Math.max(0, BORROWED['S-02'].minClusterSize * cc[i] - cf[i] * n); }) / Math.max(1, n);
        } },
      { id: 'B02-b', kind: 'range', tol: 1e-9, note: '割合が [0,1] に入り、成分の数が 0 以上',
        test: function (t) {
          var cf = colOf(t, 'clusterFraction'), cc = colOf(t, 'clusterCount');
          return maxViolation(t, function (i) { return Math.max(0, -cf[i], cf[i] - 1, -cc[i]); });
        } },
    ],
    'S-04': [
      { id: 'B04-a', kind: 'pointwise', tol: 1e-9, note: '手組みの一致率は最頻の占有率を超えない',
        test: function (t) {
          var mf = colOf(t, 'masterFraction'), df = colOf(t, 'dominantFraction');
          return maxViolation(t, function (i) { return Math.max(0, mf[i] - df[i]); });
        } },
      { id: 'B04-b', kind: 'pointwise', tol: 1e-9, note: '種の多様度は種数の対数で頭打ちになる',
        test: function (t) {
          var se = colOf(t, 'speciesEntropyRatio'), sc = colOf(t, 'speciesCount');
          var denom = Math.log2(BORROWED['S-04'].capacity);
          return maxViolation(t, function (i) {
            var cap = Math.log2(Math.max(1, sc[i])) / denom;
            return Math.max(0, se[i] - cap);
          });
        } },
      { id: 'B04-c', kind: 'pointwise', tol: 1e-9, note: '最頻の占有率は 1/種数 を下回らない',
        test: function (t) {
          var df = colOf(t, 'dominantFraction'), sc = colOf(t, 'speciesCount');
          return maxViolation(t, function (i) { return Math.max(0, 1 / Math.max(1, sc[i]) - df[i]); });
        } },
    ],
    'S-06': [
      { id: 'B06-a', kind: 'pointwise', tol: 1e-6, note: '格子の点は消えも増えもしない（6 つの状態の総和が一定）',
        test: function (t) {
          var cs = ['c0', 'c1', 'c2', 'c3', 'c4', 'c5'].map(function (k) { return colOf(t, k); });
          var sites = BORROWED['S-06'].sites;
          return maxViolation(t, function (i) {
            var s = 0; for (var c = 0; c < cs.length; c++) s += cs[c][i];
            return Math.abs(s - sites) / sites;
          });
        } },
      { id: 'B06-b', kind: 'pointwise', tol: 2e-4, note: '占有率は空き点の数から一意に決まる',
        test: function (t) {
          var c0 = colOf(t, 'c0'), occ = colOf(t, 'occupancy'), sites = BORROWED['S-06'].sites;
          return maxViolation(t, function (i) { return Math.abs((1 - c0[i] / sites) - occ[i]); });
        } },
      { id: 'B06-c', kind: 'pointwise', tol: 1e-9, note: '存続している輪の状態の数は、個数が正の状態の数に等しい',
        test: function (t) {
          var cs = ['c1', 'c2', 'c3', 'c4'].map(function (k) { return colOf(t, k); });
          var rs = colOf(t, 'ringStatesPresent');
          return maxViolation(t, function (i) {
            var k = 0; for (var c = 0; c < cs.length; c++) if (cs[c][i] > 0.5) k++;
            return Math.abs(k - rs[i]);
          });
        } },
    ],
    'S-13': [
      { id: 'B13-a', kind: 'pointwise', tol: 3e-4, note: '3 つの曲線は J(r)(1-F(r)) = 1-G(r) で結ばれている',
        test: function (t) {
          var G = colOf(t, 'G'), F = colOf(t, 'F'), J = colOf(t, 'J');
          return maxViolation(t, function (i) { return Math.abs(J[i] * (1 - F[i]) - (1 - G[i])); });
        } },
      { id: 'B13-b', kind: 'monotone', tol: 1e-9, note: '2 つの分布関数は半径について非減少',
        test: function (t) { return Math.max(monotoneViolation(colOf(t, 'G')), monotoneViolation(colOf(t, 'F'))); } },
      { id: 'B13-c', kind: 'monotone', tol: 1e-6, note: '累積の数え上げ K(r) = pi (L(r))^2 は半径について非減少',
        test: function (t) {
          var L = colOf(t, 'Lminus'), r = colOf(t, 'rIndex');
          var k = new Float64Array(t.n);
          for (var i = 0; i < t.n; i++) { var lv = L[i] + r[i]; k[i] = Math.PI * lv * lv; }
          var scale = Math.max(1e-9, k[t.n - 1]);
          return monotoneViolation(k) / scale;
        } },
      { id: 'B13-d', kind: 'range', tol: 1e-9, note: '2 つの分布関数は [0,1] に入る',
        test: function (t) {
          var G = colOf(t, 'G'), F = colOf(t, 'F');
          return maxViolation(t, function (i) { return Math.max(0, -G[i], G[i] - 1, -F[i], F[i] - 1); });
        } },
    ],
    'S-16': [
      { id: 'B16-a', kind: 'pointwise', tol: 1e-9, note: '個体数の増減は、産まれた数と取り除かれた数の差に等しい',
        test: function (t) {
          var p = colOf(t, 'population'), b = colOf(t, 'births'), d = colOf(t, 'reaps');
          var p0 = p[0], b0 = b[0], d0 = d[0];
          var scale = Math.max(1, Math.abs(p[t.n - 1] - p0) + 1);
          return maxViolation(t, function (i) { return Math.abs((p[i] - p0) - ((b[i] - b0) - (d[i] - d0))); }) / scale;
        } },
      { id: 'B16-b', kind: 'monotone', tol: 1e-9, note: '累積の数え上げ（産まれた数・取り除かれた数・実行命令数）は非減少',
        test: function (t) {
          var g = 0;
          ['births', 'reaps', 'instr'].forEach(function (k) {
            var col = colOf(t, k);
            var scale = Math.max(1, Math.abs(col[t.n - 1] - col[0]));
            g = Math.max(g, monotoneViolation(col) / scale);
          });
          return g;
        } },
      { id: 'B16-c', kind: 'monotone', tol: 1e-9, note: '「これまでに見た最大」の欄は非減少',
        test: function (t) {
          var g = 0;
          ['taskTypesCredited', 'maxRankCredited', 'maxDepth'].forEach(function (k) {
            var col = colOf(t, k);
            var scale = Math.max(1, Math.abs(col[t.n - 1] - col[0]));
            g = Math.max(g, monotoneViolation(col) / scale);
          });
          return g;
        } },
      { id: 'B16-d', kind: 'range', tol: 1e-9, note: '個体数は 0 以上',
        test: function (t) {
          var p = colOf(t, 'population');
          return maxViolation(t, function (i) { return Math.max(0, -p[i]); });
        } },
    ],
  };

  /** 収支の総合判定。tolScale で許容を一括して振れる（観測器のノブ）。 */
  function budgetCheck(sourceId, table, tolScale) {
    var list = BUDGETS[sourceId] || [];
    var scale = tolScale || 1;
    var details = [], ok = true;
    for (var i = 0; i < list.length; i++) {
      var v = list[i].test(table);
      var pass = v <= list[i].tol * scale;
      if (!pass) ok = false;
      details.push({ id: list[i].id, kind: list[i].kind, violation: v, tol: list[i].tol * scale, pass: pass });
    }
    return { ok: ok, details: details };
  }

  /** 収支の種別ごとの合否（どの種類の収支がどの段で破れるか）。 */
  function budgetByKind(sourceId, table, tolScale) {
    var res = budgetCheck(sourceId, table, tolScale);
    var out = { pointwise: true, monotone: true, range: true };
    res.details.forEach(function (d) { if (!d.pass) out[d.kind] = false; });
    return out;
  }

  var DEFAULT_KNOB = { tailFraction: 0.2, aggregate: 'last', tolScale: 1 };

  /** 1 枚の表に、1 つの源の判定器と収支を当てる。 */
  function judge(sourceId, table, knob) {
    var k = knob || DEFAULT_KNOB;
    var d = DETECTORS[sourceId](table, k);
    var b = budgetCheck(sourceId, table, k.tolScale);
    return {
      term1: !!d.t1,
      term2: !!(d.t1 && d.t2),
      term3: !!(d.t1 && d.t2 && b.ok),
      budgetOk: b.ok,
      v1: d.v1, v2: d.v2,
      budget: b.details,
    };
  }

  // ------------------------------------------------------------ 見せるための小さい標本（viewer 用）

  // file:// では fetch が使えないので、viewer が動かす標本だけをここに埋める。
  // 中身は既作の生ログから抜いた実データ（run.js が使う全量ではない）。
  var SAMPLE = null;
  function setSample(s) { SAMPLE = s; }
  function getSample() { return SAMPLE; }

  var api = {
    makeRng: makeRng, makeGauss: makeGauss, shuffled: shuffled,
    halfSpectrum: halfSpectrum, fromHalfSpectrum: fromHalfSpectrum, powerSpectrum: powerSpectrum,
    mean: mean, median: median, sd: sd, acf1: acf1, ranks: ranks, spearman: spearman,
    multisetGap: multisetGap, spectrumGap: spectrumGap,
    hashString: hashString, hashTable: hashTable,
    makeTable: makeTable, cloneTable: cloneTable, colOf: colOf, movableIndices: movableIndices,
    phaseRandomise: phaseRandomise, aaft: aaft, iaaft: iaaft, circularBlocks: circularBlocks,
    spectrumDiscrepancy: spectrumDiscrepancy,
    LEVELS: LEVELS, LEVEL_IDS: LEVEL_IDS, surrogate: surrogate,
    structureProbe: structureProbe, rowMultisetGap: rowMultisetGap,
    incrementRowMultisetGap: incrementRowMultisetGap, endpointGap: endpointGap,
    DETECTORS: DETECTORS, BUDGETS: BUDGETS, BORROWED: BORROWED,
    budgetCheck: budgetCheck, budgetByKind: budgetByKind, judge: judge,
    tailAggregate: tailAggregate, DEFAULT_KNOB: DEFAULT_KNOB,
    setSample: setSample, getSample: getSample,
    get SAMPLE() { return SAMPLE; },
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.S29 = api;
})(typeof window !== 'undefined' ? window : globalThis);
