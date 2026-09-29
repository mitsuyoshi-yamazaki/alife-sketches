/*
 * S-37 核。
 *
 * ここが知っているのは 4 つだけ:
 *   - 遷移表 (table)  … 長さ 128 の 0/1 列。幅 7 の窓を 1 ビットへ写す
 *   - 格子   (row)    … 長さ N の 0/1 列。端は環状につながる
 *   - 世代   (generation) … 表の束を、与えられた順位に従って次の束へ置き換える
 *   - 選び方 (selection)  … 順位の上位を写し、残りを切り貼りと反転で作る
 *
 * 「適合度」「個体」「生きている」「遺伝子」「λ」「カオスの縁」はここには無い。
 * 順位 (order) は外から渡される。何を基準に並べたかを核は知らない。
 */
(function (factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.S37 = api;
})(function () {
  'use strict';

  var WINDOW = 7;          // 窓の幅（半径 3）
  var RADIUS = 3;
  var TABLE_SIZE = 128;    // 2^7

  // ------------------------------------------------------------------ 乱数

  /** mulberry32。種を固定すれば完全に再現する。 */
  function makeRng(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randInt(rng, n) { return (rng() * n) | 0; }

  /** Knuth 法。対数で足すので平均が大きくても下溢しない。 */
  function poisson(rng, mean) {
    if (mean <= 0) return 0;
    var target = -mean, sum = 0, k = 0;
    do { k++; sum += Math.log(1 - rng()); } while (sum > target);
    return k - 1;
  }

  // ------------------------------------------------------------------ 遷移表

  function emptyTable() { return new Uint8Array(TABLE_SIZE); }

  /** 1 の個数をちょうど `ones` 個にした表（置き場所は一様）。 */
  function tableWithOnes(rng, ones) {
    var t = emptyTable(), i, j, tmp;
    for (i = 0; i < ones; i++) t[i] = 1;
    for (i = TABLE_SIZE - 1; i > 0; i--) {
      j = randInt(rng, i + 1); tmp = t[i]; t[i] = t[j]; t[j] = tmp;
    }
    return t;
  }

  /** 1 の個数を 0..128 から一様に選んでから置く（＝1 の割合が一様に散る）。 */
  function tableUniformOverOnes(rng) {
    return tableWithOnes(rng, randInt(rng, TABLE_SIZE + 1));
  }

  /** 各桁を独立に 1/2 で立てる（＝1 の個数は二項分布）。 */
  function tableBernoulli(rng) {
    var t = emptyTable();
    for (var i = 0; i < TABLE_SIZE; i++) t[i] = rng() < 0.5 ? 1 : 0;
    return t;
  }

  function countOnes(table) {
    var c = 0;
    for (var i = 0; i < TABLE_SIZE; i++) c += table[i];
    return c;
  }

  function hamming(a, b) {
    var c = 0;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) c++;
    return c;
  }

  /** 桁の並びだけを崩し、1 の個数は厳密に保つ。 */
  function shuffleTable(table, rng) {
    var t = Uint8Array.from(table), i, j, tmp;
    for (i = TABLE_SIZE - 1; i > 0; i--) {
      j = randInt(rng, i + 1); tmp = t[i]; t[i] = t[j]; t[j] = tmp;
    }
    return t;
  }

  function tableToHex(table) {
    var s = '', i, v;
    for (i = 0; i < TABLE_SIZE; i += 4) {
      v = (table[i] << 3) | (table[i + 1] << 2) | (table[i + 2] << 1) | table[i + 3];
      s += v.toString(16);
    }
    return s;
  }

  function tableFromHex(hex) {
    var t = emptyTable(), i, v;
    for (i = 0; i < 32; i++) {
      v = parseInt(hex.charAt(i), 16);
      t[i * 4] = (v >> 3) & 1; t[i * 4 + 1] = (v >> 2) & 1;
      t[i * 4 + 2] = (v >> 1) & 1; t[i * 4 + 3] = v & 1;
    }
    return t;
  }

  // ------------------------------------------------------------------ 格子（素朴）

  /** 素朴な 1 歩。窓の番号は左端が最上位。近道の検算の相手になる。 */
  function stepRow(table, cur, next) {
    var N = cur.length, i, k, idx;
    for (i = 0; i < N; i++) {
      idx = 0;
      for (k = -RADIUS; k <= RADIUS; k++) {
        idx = (idx << 1) | cur[(i + k + N) % N];
      }
      next[i] = table[idx];
    }
    return next;
  }

  function randomRow(rng, N, oneProb) {
    var r = new Uint8Array(N);
    for (var i = 0; i < N; i++) r[i] = rng() < oneProb ? 1 : 0;
    return r;
  }

  /** ちょうど `ones` 個だけ 1 を置いた格子。 */
  function rowWithOnes(rng, N, ones) {
    var r = new Uint8Array(N), i, j, tmp;
    for (i = 0; i < ones; i++) r[i] = 1;
    for (i = N - 1; i > 0; i--) { j = randInt(rng, i + 1); tmp = r[i]; r[i] = r[j]; r[j] = tmp; }
    return r;
  }

  function rowOnes(row) {
    var c = 0;
    for (var i = 0; i < row.length; i++) c += row[i];
    return c;
  }

  function matchFraction(row, bit) {
    var c = 0;
    for (var i = 0; i < row.length; i++) if (row[i] === bit) c++;
    return c / row.length;
  }

  function allMatch(row, bit) {
    for (var i = 0; i < row.length; i++) if (row[i] !== bit) return false;
    return true;
  }

  // ------------------------------------------------------------------ 格子（詰めた形）

  /*
   * 12 桁の窓を引くと 6 マスぶんの出力がまとめて出る索引を作り、
   * 格子を 32 ビット語へ詰めて進める。素朴版と一致することは selftest で見る。
   */

  /*
   * 表の番号づけは「窓の左端が最上位」（0000000 が 0 番、1111111 が 127 番）。
   * 詰めた格子では右へ行くほど上位の桁になるので、7 桁を裏返してから引く。
   */
  var REV7 = (function () {
    var r = new Uint8Array(128), i, m, v;
    for (i = 0; i < 128; i++) { v = 0; for (m = 0; m < 7; m++) v |= ((i >>> m) & 1) << (6 - m); r[i] = v; }
    return r;
  })();

  function buildWindowIndex(table, out) {
    var win = out || new Uint8Array(4096), w, j, v;
    for (w = 0; w < 4096; w++) {
      v = 0;
      for (j = 0; j < 6; j++) v |= table[REV7[(w >>> j) & 127]] << j;
      win[w] = v;
    }
    return win;
  }

  function Runner(N) {
    this.N = N;
    this.W = ((N + 31) >>> 5) + 1;
    this.Wx = ((N + 12 + 31) >>> 5) + 1;
    this.cur = new Uint32Array(this.W);
    this.nxt = new Uint32Array(this.W);
    this.ext = new Uint32Array(this.Wx);
    this.win = new Uint8Array(4096);
    this.out = new Uint8Array(N);
    this.topMask = (N & 31) === 0 ? 0xFFFFFFFF : ((1 << (N & 31)) - 1) >>> 0;
    this.topWord = (N - 1) >>> 5;
  }

  Runner.prototype._pack = function (row) {
    var i, W = this.W, cur = this.cur;
    for (i = 0; i < W; i++) cur[i] = 0;
    for (i = 0; i < this.N; i++) if (row[i]) cur[i >>> 5] |= (1 << (i & 31));
  };

  Runner.prototype._unpack = function (dst) {
    var cur = this.cur, i;
    for (i = 0; i < this.N; i++) dst[i] = (cur[i >>> 5] >>> (i & 31)) & 1;
    return dst;
  };

  Runner.prototype._bit = function (i) { return (this.cur[i >>> 5] >>> (i & 31)) & 1; };

  /** ext の第 k 桁 = 格子の第 (k-3) マス（環状）。窓を素直に引けるようにする。 */
  Runner.prototype._buildExt = function () {
    var W = this.W, Wx = this.Wx, cur = this.cur, ext = this.ext, N = this.N, i, carry = 0, v;
    for (i = 0; i < W; i++) { v = cur[i]; ext[i] = ((v << 3) | carry) >>> 0; carry = v >>> 29; }
    for (i = W; i < Wx; i++) { ext[i] = carry; carry = 0; }
    ext[0] |= (this._bit(N - 3)) | (this._bit(N - 2) << 1) | (this._bit(N - 1) << 2);
    for (i = 0; i < 9; i++) {
      if (this._bit(i)) { var q = N + 3 + i; ext[q >>> 5] |= (1 << (q & 31)); }
    }
  };

  Runner.prototype._step = function () {
    var N = this.N, W = this.W, ext = this.ext, nxt = this.nxt, win = this.win;
    var p, wi, sh, w, v, oi, os;
    for (p = 0; p < W; p++) nxt[p] = 0;
    this._buildExt();
    for (p = 0; p < N; p += 6) {
      wi = p >>> 5; sh = p & 31;
      w = ext[wi] >>> sh;
      if (sh) w |= (ext[wi + 1] << (32 - sh));
      v = win[w & 0xFFF];
      oi = p >>> 5; os = p & 31;
      nxt[oi] |= (v << os);
      if (os > 26) nxt[oi + 1] |= (v >>> (32 - os));
    }
    nxt[this.topWord] &= this.topMask;
    for (p = this.topWord + 1; p < W; p++) nxt[p] = 0;
    var sw = this.cur; this.cur = this.nxt; this.nxt = sw;
  };

  Runner.prototype._same = function (a, b) {
    for (var i = 0; i <= this.topWord; i++) if (a[i] !== b[i]) return false;
    return true;
  };

  Runner.prototype._uniform = function () {
    var cur = this.cur, i, first = cur[0] & 1;
    var full = first ? 0xFFFFFFFF : 0;
    for (i = 0; i < this.topWord; i++) if (cur[i] !== (full >>> 0)) return -1;
    if ((cur[this.topWord] & this.topMask) !== ((full & this.topMask) >>> 0)) return -1;
    return first;
  };

  /**
   * 表 `table` のもとで `row0` を最大 `maxSteps` 歩進める。
   * 途中で「動かなくなった」「全マスが同じ値になった」ら、そこから先は
   * 数えなくても最後の姿が決まるので打ち切る（止まった理由を返す）。
   */
  Runner.prototype.run = function (table, row0, maxSteps) {
    buildWindowIndex(table, this.win);
    this._pack(row0);
    var s = 0, stop = 'cap', uni;
    uni = this._uniform();
    if (uni >= 0) { stop = 'uniform'; }
    while (s < maxSteps && stop === 'cap') {
      var before = this.cur;
      this._step();
      s++;
      if (this._same(this.cur, before)) { stop = 'fixed'; break; }
      uni = this._uniform();
      if (uni >= 0) { stop = 'uniform'; break; }
    }
    if (stop === 'uniform') {
      // 全マスが同じ b になったら、次は b→table[b?127:0] の 2 状態だけを行き来する
      var b = uni, rest = maxSteps - s, a0 = table[0], a1 = table[127];
      while (rest > 0) {
        var nb = b ? a1 : a0;
        if (nb === b) { b = nb; break; }
        b = nb; rest--;
        if (rest > 0) { var nb2 = b ? a1 : a0; if (nb2 === b) break; b = nb2; rest--; }
      }
      var row = this.out;
      for (var i = 0; i < this.N; i++) row[i] = b;
      return { row: row, steps: maxSteps, stop: 'uniform', settledAt: s };
    }
    return { row: this._unpack(this.out), steps: s, stop: stop, settledAt: s };
  };

  // ------------------------------------------------------------------ 世代

  /**
   * 選び方。`order` は「良い順に並べた添字」で、何で並べたかは核の関心ではない。
   *  opts.eliteCount   上位いくつをそのまま写すか
   *  opts.parents      'all' 全体から親を引く / 'elite' 上位からだけ引く
   *  opts.crossover    'single' 1 点で切り貼り / 'none' 片親を写すだけ
   *  opts.pairYield    1 組の親から取る子の数（1 か 2）
   *  opts.mutMean      反転する桁数の平均
   *  opts.minDistance  上位との距離がこれ未満の子は採らない（0 で無効）
   *  opts.shuffleElite true なら上位を順位ではなく籤で選ぶ（＝並べた意味を消す）
   */
  function nextGeneration(tables, order, rng, opts) {
    var n = tables.length;
    var eliteCount = opts.eliteCount;
    var pick = order;
    if (opts.shuffleElite) {
      pick = order.slice();
      for (var i = pick.length - 1; i > 0; i--) {
        var j = randInt(rng, i + 1), tmp = pick[i]; pick[i] = pick[j]; pick[j] = tmp;
      }
    }
    var elite = [], k;
    for (k = 0; k < eliteCount; k++) elite.push(Uint8Array.from(tables[pick[k]]));
    var pool = opts.parents === 'elite' ? elite : tables;
    var out = elite.slice(), tries = 0, maxTries = (n - eliteCount) * 200;
    while (out.length < n && tries < maxTries) {
      tries++;
      var pa = pool[randInt(rng, pool.length)], pb = pool[randInt(rng, pool.length)];
      var kids = [];
      if (opts.crossover === 'single') {
        var cut = 1 + randInt(rng, TABLE_SIZE - 1);
        var c1 = emptyTable(), c2 = emptyTable(), q;
        for (q = 0; q < TABLE_SIZE; q++) {
          c1[q] = q < cut ? pa[q] : pb[q];
          c2[q] = q < cut ? pb[q] : pa[q];
        }
        kids = opts.pairYield === 2 ? [c1, c2] : [rng() < 0.5 ? c1 : c2];
      } else {
        kids = [Uint8Array.from(rng() < 0.5 ? pa : pb)];
      }
      for (var m = 0; m < kids.length && out.length < n; m++) {
        var kid = kids[m], flips = poisson(rng, opts.mutMean), f;
        for (f = 0; f < flips; f++) { var pos = randInt(rng, TABLE_SIZE); kid[pos] ^= 1; }
        if (opts.minDistance > 0 && !farEnough(kid, elite, opts.minDistance)) continue;
        out.push(kid);
      }
    }
    while (out.length < n) out.push(tableUniformOverOnes(rng));  // 籤が尽きたときの埋め
    return { tables: out, tries: tries };
  }

  function farEnough(kid, elite, minDistance) {
    var sum = 0;
    for (var i = 0; i < elite.length; i++) sum += hamming(kid, elite[i]);
    return (sum / elite.length) >= minDistance;
  }

  // ------------------------------------------------------------------ 指紋

  function fnv1a(str) {
    var h = 0x811c9dc5, i;
    for (i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  function rowHash(row) {
    var s = '', i;
    for (i = 0; i < row.length; i++) s += row[i];
    return fnv1a(s);
  }

  function tableHash(table) { return fnv1a(tableToHex(table)); }

  /** 表の束の指紋。順序も込みで一致を見る（腕どうしの同一性の決着用）。 */
  function poolHash(tables) {
    var s = '';
    for (var i = 0; i < tables.length; i++) s += tableToHex(tables[i]);
    return fnv1a(s);
  }

  return {
    WINDOW: WINDOW, RADIUS: RADIUS, TABLE_SIZE: TABLE_SIZE,
    makeRng: makeRng, randInt: randInt, poisson: poisson,
    emptyTable: emptyTable, tableWithOnes: tableWithOnes,
    tableUniformOverOnes: tableUniformOverOnes, tableBernoulli: tableBernoulli,
    countOnes: countOnes, hamming: hamming, shuffleTable: shuffleTable,
    tableToHex: tableToHex, tableFromHex: tableFromHex,
    stepRow: stepRow, randomRow: randomRow, rowWithOnes: rowWithOnes, rowOnes: rowOnes,
    matchFraction: matchFraction, allMatch: allMatch,
    buildWindowIndex: buildWindowIndex, Runner: Runner,
    nextGeneration: nextGeneration,
    fnv1a: fnv1a, rowHash: rowHash, tableHash: tableHash, poolHash: poolHash,
  };
});
