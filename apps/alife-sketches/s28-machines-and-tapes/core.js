/**
 * S-28 「機械とテープ」の核。
 *
 * 容器には記号列が N 本ある。衝突のたびに 2 本を引き、片方を**折り返して**（fold）
 * 機械にし、もう片方を**読ませて**新しい列を作る。折り返される列と読まれる列は
 * 同じ資源であり、**同じ列がどちらにもなる**。
 *
 * 折り返し: 列を 8 ビットへ XOR で畳み、2 状態の変換器の表にする。
 *   表の 1 項 = (書き方 1bit, 次状態 1bit)。項は (状態 q, 入力 a) の 4 通り。
 *   書き方 0 = 入力をそのまま出す / 1 = 反転して出す。
 *   出力は入力 1 記号につき 1 記号なので、積の長さは常に L。
 *
 * この層に生物の語彙は無い（「組織」「自己触媒」「複製」「触媒」「適応度」は
 * 観測器 stats.js の語彙である）。依存ゼロ・古典スクリプト・Node とブラウザで共用。
 */
(function (global) {
  'use strict';

  // ------------------------------------------------------------ 乱数

  /** xorshift32。seed が同じなら完全に同じ列を返す。 */
  function Rng(seed) { this.s = (seed >>> 0) || 0x9e3779b9; }
  Rng.prototype.u32 = function () {
    var s = this.s;
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    this.s = s;
    return s;
  };
  /** n が 2 の冪なら偏りは厳密に 0。本スケッチの N・|Ω| は全て 2 の冪。 */
  Rng.prototype.int = function (n) { return this.u32() % n; };
  Rng.prototype.float = function () { return this.u32() / 4294967296; };

  function mix32(h) {
    h = Math.imul(h ^ (h >>> 15), 0x2545f491);
    h ^= h >>> 13;
    h = Math.imul(h, 0x27d4eb2d);
    return (h ^ (h >>> 16)) >>> 0;
  }
  function hash2(a, b, k) {
    return mix32(Math.imul(a + 1, 0x9e3779b1) ^ Math.imul(b + 1, 0x85ebca6b) ^ Math.imul(k + 1, 0xc2b2ae35));
  }

  // ------------------------------------------------------------ 折り返しと作用

  var W_MASK = 0x55;  // 表 8 ビットのうち「書き方」の 4 ビット

  /** 列 s（長さ L のビット列）→ 8 ビットの機械符号。L=8 では恒等。 */
  function fold(s, L) {
    var b = 0;
    for (var j = 0; j < L; j++) if ((s >>> j) & 1) b ^= 1 << (j & 7);
    return b;
  }

  /** 機械符号 mc を列 t に当てる。状態 0 から始め、左から 1 記号ずつ読んで 1 記号ずつ出す。 */
  function applyCode(mc, t, L) {
    var q = 0, out = 0;
    for (var i = 0; i < L; i++) {
      var a = (t >>> i) & 1;
      var e = ((q << 1) | a) << 1;
      if (a ^ ((mc >>> e) & 1)) out |= 1 << i;
      q = (mc >>> (e + 1)) & 1;
    }
    return out;
  }

  /**
   * 原典寄りの作用。列を**円環**と見なし、読み手の「頭部」4 ビットが最初に一致した位置から
   * 折り返した表を当てて書き戻す。頭部は表のビットを二重に使う（原典:「In order to cover
   * 16 bits by 7 bits, several bits are used twice.」）。一致する位置が無ければ反応しない（-1）。
   *
   * これにより、**同じ列でも誰が読むかで別の積になる**——原典が言う
   * 「Which machine is translated from a given tape is dependent on what kind of a machine
   * reads the tape.」の、位置に落とした版にあたる。
   */
  function applyFrame(mc, t, L) {
    var h = mc & 0x0f, r = -1, k, b, w;
    for (k = 0; k < L; k++) {
      w = 0;
      for (b = 0; b < 4; b++) if ((t >>> ((k + b) % L)) & 1) w |= 1 << b;
      if (w === h) { r = k; break; }
    }
    if (r < 0) return -1;
    var q = 0, out = t;
    for (var i = 0; i < L; i++) {
      var pos = (r + i) % L;
      var a = (t >>> pos) & 1;
      var e = ((q << 1) | a) << 1;
      if (a ^ ((mc >>> e) & 1)) out |= 1 << pos; else out &= ~(1 << pos);
      q = (mc >>> (e + 1)) & 1;
    }
    return out & ((1 << L) - 1);
  }

  /**
   * 書き方の 4 ビットだけで決まる 4 つの族。**実装の外から来る恒等式**にあたる。
   *   copy  (0x00): 出力 = 入力        → 積は読まれた列そのもの
   *   flip  (0x55): 出力 = 入力の反転  → 積は読まれた列の補列
   *   zero  (0x44): 書き方 w(q,a)=a    → 出力は常に 0、積は 0^L（読まれた列に依らない）
   *   one   (0x11): 書き方 w(q,a)=1-a  → 出力は常に 1、積は 1^L（読まれた列に依らない）
   * 次状態の 4 ビットは自由なので、各族の機械符号はちょうど 16 通り。
   */
  var FAMILY = { 0: 'copy', 85: 'flip', 68: 'zero', 17: 'one' };
  function familyOfCode(mc) { return FAMILY[mc & W_MASK] || 'other'; }
  function familyOf(s, L) { return familyOfCode(fold(s, L)); }

  // ------------------------------------------------------------ 規則（腕ごと）

  function permutation(size, seed) {
    var p = new Int32Array(size), r = new Rng(seed), i, j, t;
    for (i = 0; i < size; i++) p[i] = i;
    for (i = size - 1; i > 0; i--) { j = r.u32() % (i + 1); t = p[i]; p[i] = p[j]; p[j] = t; }
    return p;
  }

  /**
   * 積の作り方。すべて (m, t) → 積 の決定的な関数。
   *   fold          : 本系。m を折り返した機械が t を読む
   *   relabelReader : **同じ配置の、忘れ方だけ違う参照点**。機械の顔ぶれ（256 通りの変換器）も
   *                   反応回数も同じまま、「どの列がどの機械になるか」の対応だけを忘れる
   *   relabelRead   : 同上・読まれる側の対応だけを忘れる
   *   randomTable   : 積を (m,t) の乱択表から引く。変換器の構造を丸ごと忘れる
   *   noRead        : 積が読まれた列に依らない（積 = g(m)）。構造はあるが読みが効かない
   *   shift         : 積 = t+1（mod |Ω|）。読みは完全に効くが一方向で、有限集合の上で閉じない
   *   elastic       : 何も書かない
   */
  function makeRule(mode, L, tableSeed) {
    var mask = (1 << L) - 1, size = mask + 1, perm;
    if (mode === 'fold') {
      return { mode: mode, writes: true, product: function (m, t) { return applyCode(fold(m, L), t, L); } };
    }
    if (mode === 'frame') {
      return { mode: mode, writes: true, selective: true,
        product: function (m, t) { return applyFrame(fold(m, L), t, L); } };
    }
    if (mode === 'split') {
      return { mode: mode, writes: true, exogenousReader: true,
        product: function (m, t) { return applyCode(fold(m, L), t, L); } };
    }
    if (mode === 'relabelReader') {
      perm = permutation(size, tableSeed);
      return { mode: mode, writes: true, perm: perm,
        product: function (m, t) { return applyCode(fold(perm[m], L), t, L); } };
    }
    if (mode === 'relabelRead') {
      perm = permutation(size, (tableSeed ^ 0x5bf03635) | 0);
      return { mode: mode, writes: true, perm: perm,
        product: function (m, t) { return applyCode(fold(m, L), perm[t], L); } };
    }
    if (mode === 'randomTable') {
      return { mode: mode, writes: true, product: function (m, t) { return hash2(m, t, tableSeed) & mask; } };
    }
    if (mode === 'noRead') {
      return { mode: mode, writes: true,
        product: function (m, t) { return hash2(m, 0, (tableSeed ^ 0x1b873593) | 0) & mask; } };
    }
    if (mode === 'shift') {
      return { mode: mode, writes: true, product: function (m, t) { return (t + 1) & mask; } };
    }
    if (mode === 'elastic') {
      return { mode: mode, writes: false, product: function (m, t) { return t; } };
    }
    throw new Error('unknown mode: ' + mode);
  }

  var MODES = ['fold', 'frame', 'split', 'relabelReader', 'relabelRead',
               'randomTable', 'noRead', 'shift', 'elastic'];

  // ------------------------------------------------------------ 容器

  /**
   * opts: { L, N, seed, tableSeed, mode, scheme, eps, init, recent }
   *   scheme 'flux'      : 積は一様乱択の枠へ入る（希釈流）。読み手も読まれた列も残る
   *   scheme 'transform' : 積は読まれた枠へ入る（読み手だけ残る）
   *   eps                : 出力 1 記号あたりの反転確率（外から加える雑音）
   *   recent             : 直近の衝突を何件覚えるか（役割ごとの母集団に使う）
   */
  function createVessel(opts) {
    opts = opts || {};
    var L = opts.L || 8, N = opts.N || 128, mask = (1 << L) - 1;
    var st = {
      L: L, N: N, mask: mask, size: mask + 1,
      mode: opts.mode || 'fold',
      scheme: opts.scheme || 'flux',
      eps: opts.eps || 0,
      seed: opts.seed == null ? 1 : opts.seed,
      tableSeed: opts.tableSeed == null ? 20260913 : opts.tableSeed,
      slots: new Int32Array(N),
      counts: new Int32Array(mask + 1),
      writtenAt: new Int32Array(N),
      collisions: 0, writes: 0, reactions: 0, bitsChanged: 0, distinct: 0, lastSetChange: 0,
      last: null, recent: null,
    };
    st.rule = makeRule(st.mode, L, st.tableSeed | 0);
    st.rng = new Rng(st.seed);
    var cap = opts.recent || 0;
    if (cap > 0) st.recent = { cap: cap, n: 0, idx: 0, m: new Int32Array(cap), t: new Int32Array(cap) };
    for (var i = 0; i < N; i++) {
      var v = opts.init ? (opts.init[i % opts.init.length] & mask) : (st.rng.u32() & mask);
      st.slots[i] = v;
      if (st.counts[v]++ === 0) st.distinct++;
      st.writtenAt[i] = -1;
    }
    if (st.rule.exogenousReader) st.readerPool = Int32Array.from(st.slots);
    return st;
  }

  function step(st) {
    var N = st.N;
    var i = st.rng.u32() % N, j = st.rng.u32() % N;
    while (j === i) j = st.rng.u32() % N;
    var m = st.readerPool ? st.readerPool[i] : st.slots[i], t = st.slots[j];
    st.collisions++;
    var p = st.rule.product(m, t);
    if (p < 0) { st.last = { i: i, j: j, m: m, t: t, p: -1 }; return st.last; }
    st.reactions++;
    var w = p ^ t;
    for (var b = 0; b < st.L; b++) if ((w >>> b) & 1) st.bitsChanged++;
    if (st.eps > 0) for (b = 0; b < st.L; b++) if (st.rng.float() < st.eps) p ^= (1 << b);
    st.last = { i: i, j: j, m: m, t: t, p: p };
    if (st.recent) {
      var r = st.recent;
      r.m[r.idx] = m; r.t[r.idx] = t;
      r.idx = (r.idx + 1) % r.cap;
      if (r.n < r.cap) r.n++;
    }
    if (!st.rule.writes) return st.last;
    var k = st.scheme === 'transform' ? j : (st.rng.u32() % N);
    var old = st.slots[k];
    if (--st.counts[old] === 0) { st.distinct--; st.lastSetChange = st.collisions; }
    if (st.counts[p]++ === 0) { st.distinct++; st.lastSetChange = st.collisions; }
    st.slots[k] = p;
    st.writtenAt[k] = st.collisions;
    st.writes++;
    return st.last;
  }

  function run(st, n) { for (var i = 0; i < n; i++) step(st); return st; }

  /** 観測器が見ている数え上げが、枠から数え直したものと一致するかを外から確かめるための素朴版。 */
  function recount(st) {
    var c = new Int32Array(st.size), d = 0;
    for (var i = 0; i < st.N; i++) if (c[st.slots[i]]++ === 0) d++;
    return { counts: c, distinct: d };
  }

  /** 枠の並びまで含めた状態のハッシュ（FNV-1a）。 */
  function hashState(st) {
    var h = 0x811c9dc5;
    for (var i = 0; i < st.N; i++) {
      var v = st.slots[i];
      for (var b = 0; b < 4; b++) { h ^= (v >>> (b * 8)) & 255; h = Math.imul(h, 0x01000193) >>> 0; }
    }
    return ('0000000' + (h >>> 0).toString(16)).slice(-8);
  }

  /** 近道: (m,t) の積を全部先に引いておく表。素朴な applyCode と一致しなければならない。 */
  function productTable(L) {
    var size = 1 << L;
    if (size > 256) throw new Error('productTable は L<=8 でだけ使う（L=' + L + '）');
    var tbl = new Uint8Array(size * size);
    for (var m = 0; m < size; m++) {
      var mc = fold(m, L);
      for (var t = 0; t < size; t++) tbl[(m << L) + t] = applyCode(mc, t, L);
    }
    return tbl;
  }

  var api = {
    applyFrame: applyFrame,
    Rng: Rng, mix32: mix32, hash2: hash2,
    fold: fold, applyCode: applyCode, familyOfCode: familyOfCode, familyOf: familyOf,
    W_MASK: W_MASK, FAMILY_CODES: { copy: 0x00, flip: 0x55, zero: 0x44, one: 0x11 },
    permutation: permutation, makeRule: makeRule, MODES: MODES,
    createVessel: createVessel, step: step, run: run,
    recount: recount, hashState: hashState, productTable: productTable,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.S28 = api;
})(typeof window !== 'undefined' ? window : this);
