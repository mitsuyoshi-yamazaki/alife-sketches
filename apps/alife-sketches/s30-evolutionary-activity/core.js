/**
 * S-30 の核。
 *
 * **この核は上位概念の語彙を持たない。** 出てくるのは「枠（slot）」「印（mark）」「場（field）」
 * 「重み（weight）」「引き手（picker）」だけで、生物学の語は1つも無い（cell / gene / organism /
 * catalyst / fitness / alive は識別子にも分岐にも現れない）。selftest.js が語彙の検査を機械で行う。
 *
 * 系:
 *   - n 個の枠が並ぶ。各枠は width 個の印を持ち、各印は 0..span-1 の整数
 *   - 1 事象ごとに「読み出す枠 from」と「書き込まれる枠 into」を引き、from の内容を into へ写す
 *   - 写すときに各位置は確率 mu で一様に引き直される
 *   - 各枠は場 field から決まるスカラー weight を持つ。引き手はこれに従って偏る（beta が強さ）
 *
 * **本スケッチの制御対象は「引き手のどれを一様に置き換えるか」である**。
 * from の引き手・into の引き手・場の対応、の3箇所それぞれに「偏る／忘れる」がある。
 *
 *   sourceMode : 'biased'（exp(+beta*w) に比例）／'flat'（一様）
 *   targetMode : 'biased'（exp(-beta*w) に比例）／'flat'（一様）／'replay'（外から渡された列をそのまま使う）
 *   fieldMode  : 'plain'（場をそのまま使う）／'shuffled'（場の値の多重集合は保ったまま対応だけ入れ替える）
 *
 * beta = 0 では exp(0) = 1 がすべての枠で厳密に成り立ち、偏る引き手は一様な引き手と
 * **同じ添字・同じ乱数消費**になる。したがって beta=0 の 'biased' と 'flat' は状態ハッシュまで一致する
 * （selftest の PC1 が検査する恒等式）。
 *
 * 依存ゼロ・古典スクリプト。Node とブラウザで共用する（module.exports と window.S30 の両方へ出す）。
 */
(function (global) {
  'use strict';

  // ------------------------------------------------------------------ 乱数

  /** mulberry32。32bit 種から決定的に [0,1) を返す。 */
  function makeRng(seed) {
    var a = seed >>> 0;
    function next() {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
    next.draws = 0;
    return function () { next.draws++; return next(); };
  }

  /** 2 つの 32bit を混ぜて種を作る（腕ごとに独立な系列が要るとき用）。 */
  function mixSeed(a, b) {
    var x = (a ^ 0x9E3779B9) >>> 0;
    x = Math.imul(x ^ (b >>> 0), 0x85EBCA6B) >>> 0;
    x = (x ^ (x >>> 13)) >>> 0;
    return Math.imul(x, 0xC2B2AE35) >>> 0;
  }

  // ------------------------------------------------- Fenwick（重みつきの引き手）

  /**
   * 部分和の木。update は O(log n)、pick は O(log n)。
   * 素朴な線形走査と同じ添字を返すことを selftest が突き合わせる（近道の検算・K-12）。
   */
  function makeFenwick(n) {
    return { n: n, t: new Float64Array(n + 1) };
  }

  function fenBuild(f, w) {
    var n = f.n, t = f.t, i, j;
    for (i = 0; i <= n; i++) t[i] = 0;
    for (i = 1; i <= n; i++) {
      t[i] += w[i - 1];
      j = i + (i & -i);
      if (j <= n) t[j] += t[i];
    }
  }

  function fenAdd(f, i, delta) {
    var n = f.n, t = f.t, k = i + 1;
    while (k <= n) { t[k] += delta; k += k & -k; }
  }

  function fenTotal(f) {
    // 木の根までの部分和を足し上げる（n までの前置和）。
    var t = f.t, k = f.n, s = 0;
    while (k > 0) { s += t[k]; k -= k & -k; }
    return s;
  }

  /** 累積が target を初めて超える添字を返す（0 起点）。 */
  function fenPick(f, target) {
    var n = f.n, t = f.t, pos = 0, step = 1;
    while (step * 2 <= n) step *= 2;
    for (; step > 0; step >>= 1) {
      if (pos + step <= n && t[pos + step] <= target) {
        pos += step;
        target -= t[pos];
      }
    }
    if (pos >= n) pos = n - 1;
    return pos;
  }

  /** 素朴な線形走査。近道の検算に使う。 */
  function scanPick(w, total, u) {
    var target = u * total, acc = 0, i;
    for (i = 0; i < w.length; i++) {
      acc += w[i];
      if (acc > target) return i;
    }
    return w.length - 1;
  }

  // ------------------------------------------------------------------ 場

  /**
   * 場は width × span × span の表。位置 i の値は field[i][m_i][m_{(i+1) mod width}]。
   * 隣接する位置どうしが絡むので、1 箇所を変えると 2 項が動く。
   */
  function buildField(width, span, seed) {
    var rnd = makeRng(seed >>> 0);
    var size = width * span * span;
    var f = new Float64Array(size);
    for (var i = 0; i < size; i++) f[i] = rnd();
    return f;
  }

  /** 値の多重集合はそのままに、対応だけ入れ替える（Fisher–Yates）。 */
  function shuffleField(field, seed) {
    var rnd = makeRng(seed >>> 0);
    var out = Float64Array.from(field);
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var tmp = out[i]; out[i] = out[j]; out[j] = tmp;
    }
    return out;
  }

  /** 1 つの峰だけが高い場（手で組んだ正コントロール用）。 */
  function buildSingleRidgeField(width, span, peakMark) {
    var f = new Float64Array(width * span * span);
    for (var i = 0; i < width; i++) {
      for (var a = 0; a < span; a++) {
        for (var b = 0; b < span; b++) {
          f[(i * span + a) * span + b] = (a === peakMark ? 1 : 0);
        }
      }
    }
    return f;
  }

  // ------------------------------------------------------------------ 系

  var DEFAULTS = {
    n: 120,
    width: 12,
    span: 4,
    beta: 2,
    mu: 1 / 12,
    seed: 1,
    fieldSeed: 424242,
    sourceMode: 'biased',
    targetMode: 'biased',
    fieldMode: 'plain',
    fieldShuffleSeed: 777,
    field: null,
    schedule: null,        // targetMode==='replay' のとき使う Int32Array
    recordSchedule: false, // into の列を控えるか
  };

  function create(opts) {
    var o = {}, k;
    for (k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) o[k] = DEFAULTS[k];
    for (k in (opts || {})) if (Object.prototype.hasOwnProperty.call(opts, k)) o[k] = opts[k];

    var n = o.n, width = o.width, span = o.span;
    var field = o.field || buildField(width, span, o.fieldSeed);
    if (o.fieldMode === 'shuffled') field = shuffleField(field, o.fieldShuffleSeed);

    var st = {
      n: n, width: width, span: span,
      beta: o.beta, mu: o.mu,
      sourceMode: o.sourceMode, targetMode: o.targetMode, fieldMode: o.fieldMode,
      field: field,
      marks: new Uint8Array(n * width),
      label: new Int32Array(n),
      w: new Float64Array(n),
      wIn: new Float64Array(n),
      wOut: new Float64Array(n),
      fenIn: makeFenwick(n),
      fenOut: makeFenwick(n),
      schedule: o.schedule || null,
      scheduleAt: 0,
      recorded: o.recordSchedule ? [] : null,
      events: 0,
      rng: makeRng(o.seed >>> 0),
      lastFrom: -1, lastInto: -1,
    };

    // 初期配置: 枠ごとに独立に引いた印。控えの札（label）は枠の添字そのもの。
    var i, j;
    for (i = 0; i < n; i++) {
      for (j = 0; j < width; j++) st.marks[i * width + j] = Math.floor(st.rng() * span);
      st.label[i] = i;
    }
    for (i = 0; i < n; i++) refreshWeight(st, i);
    fenBuild(st.fenIn, st.wIn);
    fenBuild(st.fenOut, st.wOut);
    return st;
  }

  /** 枠 i のスカラーと 2 本の重みを引き直す。 */
  function refreshWeight(st, i) {
    var width = st.width, span = st.span, m = st.marks, f = st.field;
    var base = i * width, s = 0, j, a, b;
    for (j = 0; j < width; j++) {
      a = m[base + j];
      b = m[base + ((j + 1) % width)];
      s += f[(j * span + a) * span + b];
    }
    var v = s / width;
    st.w[i] = v;
    st.wIn[i] = Math.exp(st.beta * v);
    st.wOut[i] = Math.exp(-st.beta * v);
  }

  function pickIn(st) {
    var u = st.rng();
    if (st.sourceMode === 'flat') return Math.floor(u * st.n);
    return fenPick(st.fenIn, u * fenTotal(st.fenIn));
  }

  function pickOut(st) {
    if (st.targetMode === 'replay') {
      st.rng(); // 乱数消費を他の腕と揃える
      var idx = st.schedule[st.scheduleAt % st.schedule.length];
      st.scheduleAt++;
      return idx;
    }
    var u = st.rng();
    if (st.targetMode === 'flat') return Math.floor(u * st.n);
    return fenPick(st.fenOut, u * fenTotal(st.fenOut));
  }

  /** 1 事象。読み出す枠を引き、書き込まれる枠を引き、写して揺らす。 */
  function step(st) {
    var from = pickIn(st);
    var into = pickOut(st);
    var width = st.width, span = st.span, m = st.marks, mu = st.mu;
    var src = from * width, dst = into * width, j, v;
    for (j = 0; j < width; j++) {
      v = m[src + j];
      if (st.rng() < mu) v = Math.floor(st.rng() * span);
      m[dst + j] = v;
    }
    st.label[into] = st.label[from];

    var oldIn = st.wIn[into], oldOut = st.wOut[into];
    refreshWeight(st, into);
    fenAdd(st.fenIn, into, st.wIn[into] - oldIn);
    fenAdd(st.fenOut, into, st.wOut[into] - oldOut);

    if (st.recorded) st.recorded.push(into);
    st.lastFrom = from; st.lastInto = into;
    st.events++;
    return st;
  }

  function run(st, k) {
    for (var i = 0; i < k; i++) step(st);
    return st;
  }

  // ------------------------------------------------------------- 状態ハッシュ

  /** FNV-1a 32bit を 2 本回して 64bit 相当の 16 桁を返す（K-36）。 */
  function hashState(st) {
    var h1 = 0x811c9dc5 >>> 0, h2 = 0x01000193 >>> 0;
    function mix(x) {
      h1 = Math.imul(h1 ^ (x & 0xff), 16777619) >>> 0;
      h2 = Math.imul(h2 ^ ((x >>> 8) & 0xffff), 2166136261) >>> 0;
    }
    var i;
    for (i = 0; i < st.marks.length; i++) mix(st.marks[i]);
    for (i = 0; i < st.n; i++) { mix(st.label[i] & 0xff); mix((st.label[i] >>> 8) & 0xff); }
    mix(st.events & 0xff); mix((st.events >>> 8) & 0xff);
    mix((st.events >>> 16) & 0xff); mix((st.events >>> 24) & 0xff);
    var s1 = ('00000000' + h1.toString(16)).slice(-8);
    var s2 = ('00000000' + h2.toString(16)).slice(-8);
    return s1 + s2;
  }

  /** 枠の内容を 1 つの整数へ畳む（span^width が 2^32 未満のときだけ使える）。 */
  function encode(st, i) {
    var base = i * st.width, v = 0, j;
    for (j = 0; j < st.width; j++) v = v * st.span + st.marks[base + j];
    return v;
  }

  // ------------------------------------------------------------------ 露出

  var api = {
    makeRng: makeRng,
    mixSeed: mixSeed,
    makeFenwick: makeFenwick,
    fenBuild: fenBuild,
    fenAdd: fenAdd,
    fenTotal: fenTotal,
    fenPick: fenPick,
    scanPick: scanPick,
    buildField: buildField,
    shuffleField: shuffleField,
    buildSingleRidgeField: buildSingleRidgeField,
    create: create,
    step: step,
    run: run,
    refreshWeight: refreshWeight,
    hashState: hashState,
    encode: encode,
    DEFAULTS: DEFAULTS,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (global) global.S30 = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
