/**
 * S-38 観測器 — ここが「ループ」「複製」「在庫」「到達」「介入」の語彙を持つ側。
 *
 * 核（core.js）は状態と遷移表しか知らない。「そこにループが在る」「複製が続いている」は
 * 全部この層の決めごとである。事前登録は criteria.json、ここはその実装。
 *
 * ループの見つけ方（criteria.json の scales.matchMode）:
 *   'cavity'       主。**状態 2 だけに囲まれた有界な空洞**（4 連結の 0 の成分で、
 *                  その 4 近傍の外側が全部 2）を 1 つのループと数える。
 *                  腕が伸びていても穴は残るので、複製の途中でも数えられる
 *   'cavityStrict' 空洞が正典と同じ 4x4 の矩形であることまで要求する
 *   'exactBlock'   空洞の外接矩形を 3 マス広げた窓が、正典の同じ窓と
 *                  **4 回転を除いて完全に一致する**ことまで要求する（最も厳しい）
 *
 * 依存ゼロ・古典スクリプト。Node と ブラウザで共用する。
 */
(function (global) {
  'use strict';

  var S38 = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('./core.js') : global.S38;

  var SHEATH = 2;

  // ------------------------------------------------------------ 正典の図形
  // 原典 Langton (1984) fig. 6 "Self-reproducing loop"（TIME = 0）。
  // 走査版 PDF から起こした本文の該当箇所と、Sayama/Bachmutsky の loops.java の
  // langtonLoop[] が 1 文字も違わずに一致した。
  var CANON_LINES = [
    ' 22222222',
    '2170140142',
    '2022222202',
    '272    212',
    '212    212',
    '202    212',
    '272    212',
    '21222222122222',
    '207107107111112',
    ' 2222222222222',
  ];

  function canonBlock() { return S38.parseBlock(CANON_LINES); }

  // ------------------------------------------------------------ 型紙の族
  /**
   * D3（型紙特異性）の母集団。**同じ規則に、違う図形を与えて走らせる**。
   *  T1 正典
   *  T2 データ環の中身だけを引き直したもの（外形は同じ・中身が違う）
   *  T3 外接矩形の中身を全部引き直したもの（状態の多重集合だけ同じ）
   *  T4 正典の鏡像（原典の表は 4 回転対称だが鏡映対称ではない）
   *  T5 空の鞘の箱（空洞は持つが指示を 1 つも持たない）
   */
  function templates(seed) {
    var canon = canonBlock();
    // 空洞だけを持ち、指示（データ環の中身）を 1 つも持たない図形。
    // 「鞘に囲まれた空洞」という形の徴候だけが正典と同じ。
    var t5 = S38.parseBlock([
      '22222222',
      '20000002',
      '20000002',
      '20000002',
      '20000002',
      '22222222',
    ]);
    return {
      T1_canon: canon,
      T2_ringShuffled: S38.shuffleBlock(canon, seed + 11, function (x, y, v) {
        return isRingSite(x, y);
      }),
      T3_blockShuffled: S38.shuffleBlock(canon, seed + 22, null),
      T4_mirror: S38.mirrorBlock(canon),
      T5_unrelated: t5,
    };
  }

  /** 正典で「データ環」にあたる格子点（行 1..8 の外周）。T2 の引き直しの範囲。 */
  function isRingSite(x, y) {
    if (y < 1 || y > 8) return false;
    if (x < 1 || x > 8) return false;
    return (y === 1 || y === 8 || x === 1 || x === 8);
  }

  // ------------------------------------------------------------ ループの検出

  /**
   * 場から「ループ」を拾う。
   * opts: { minCavity, maxCavity, matchMode, margin }
   * 返すもの: [{ size, x0,y0,x1,y1, cx, cy, rect, exact, nearBorder }]
   */
  function detectLoops(field, opts) {
    opts = opts || {};
    var minCavity = opts.minCavity == null ? 4 : opts.minCavity;
    var maxCavity = opts.maxCavity == null ? 64 : opts.maxCavity;
    var mode = opts.matchMode || 'cavity';
    var margin = opts.margin == null ? 3 : opts.margin;
    var w = field.w, h = field.h, a = field.s;
    var seen = new Uint8Array(w * h);
    var found = [];
    var stack = new Int32Array(w * h);

    for (var start = 0; start < a.length; start++) {
      if (a[start] !== 0 || seen[start]) continue;
      // 状態 0 の 4 連結成分を掘る
      var sp = 0; stack[sp++] = start; seen[start] = 1;
      var sites = [];
      var ok = true;                       // 外周が全部 2 か
      var touches = false;                 // 場の端に触れたか
      var x0 = w, y0 = h, x1 = -1, y1 = -1;
      while (sp > 0) {
        var i = stack[--sp];
        sites.push(i);
        var x = i % w, y = (i / w) | 0;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true;
        var nb = [y > 0 ? i - w : -1, y < h - 1 ? i + w : -1,
                  x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1];
        for (var k = 0; k < 4; k++) {
          var j = nb[k];
          if (j < 0) continue;
          if (a[j] === 0) { if (!seen[j]) { seen[j] = 1; stack[sp++] = j; } }
          else if (a[j] !== SHEATH) ok = false;
        }
      }
      if (touches || !ok) continue;
      if (sites.length < minCavity || sites.length > maxCavity) continue;

      var rect = (sites.length === (x1 - x0 + 1) * (y1 - y0 + 1));
      var rec = {
        size: sites.length, x0: x0, y0: y0, x1: x1, y1: y1,
        cx: Math.round((x0 + x1) / 2), cy: Math.round((y0 + y1) / 2),
        rect: rect, exact: false,
        nearBorder: (x0 - margin < 0 || y0 - margin < 0 || x1 + margin >= w || y1 + margin >= h),
      };
      rec.exact = rec.nearBorder ? false : matchesCanonWindow(field, rec, margin);
      if (mode === 'cavityStrict' && !(rect && rec.size === CANON_CAVITY.size)) continue;
      if (mode === 'exactBlock' && !rec.exact) continue;
      found.push(rec);
    }
    return found;
  }

  var CANON_WINDOWS = null;

  /** 正典の空洞（4x4 = 16）とその窓を一度だけ求めておく。 */
  var CANON_CAVITY = (function () {
    var b = canonBlock();
    var f = S38.makeField(b.w + 8, b.h + 8, 0);
    f = S38.writeBlock(f, b, 4, 4);
    var got = detectLoops(f, { matchMode: 'cavity', margin: 3 });
    var c = got[0];
    return { size: c ? c.size : 16, rect: c ? c.rect : true };
  })();

  /** 正典の 10x10 窓（空洞の外接矩形 ±3）の 4 回転ぶん。 */
  CANON_WINDOWS = (function () {
    var b = canonBlock();
    var pad = 4;
    var f = S38.makeField(b.w + 2 * pad, b.h + 2 * pad, 0);
    f = S38.writeBlock(f, b, pad, pad);
    var got = detectLoops(f, { matchMode: 'cavity', margin: 3 });
    var c = got[0];
    var m = 3;
    var w0 = c.x0 - m, w1 = c.x1 + m, h0 = c.y0 - m, h1 = c.y1 + m;
    var bw = w1 - w0 + 1, bh = h1 - h0 + 1;
    var s = new Uint8Array(bw * bh);
    for (var y = 0; y < bh; y++)
      for (var x = 0; x < bw; x++) s[y * bw + x] = f.s[(h0 + y) * f.w + (w0 + x)];
    var out = [], cur = { w: bw, h: bh, s: s };
    for (var r = 0; r < 4; r++) { out.push(cur); cur = S38.rotateBlock(cur); }
    return out;
  })();

  function matchesCanonWindow(field, rec, m) {
    if (!CANON_WINDOWS) return false;          // 正典の窓を組んでいる最中は判定しない
    var bw = rec.x1 - rec.x0 + 1 + 2 * m, bh = rec.y1 - rec.y0 + 1 + 2 * m;
    for (var r = 0; r < CANON_WINDOWS.length; r++) {
      var cw = CANON_WINDOWS[r];
      if (cw.w !== bw || cw.h !== bh) continue;
      var same = true;
      for (var y = 0; y < bh && same; y++)
        for (var x = 0; x < bw; x++) {
          if (field.s[(rec.y0 - m + y) * field.w + (rec.x0 - m + x)] !== cw.s[y * cw.w + x]) { same = false; break; }
        }
      if (same) return true;
    }
    return false;
  }

  /**
   * 生存の検算用（K-12）。**別の書き方**で同じものを数える——
   * 1 点ずつ独立に塗り直し、成分の代表点を集合で持つ。速くないが索引を共有しない。
   */
  function detectLoopsBrute(field, opts) {
    opts = opts || {};
    var minCavity = opts.minCavity == null ? 4 : opts.minCavity;
    var maxCavity = opts.maxCavity == null ? 64 : opts.maxCavity;
    var w = field.w, h = field.h, a = field.s;
    var reps = {};
    for (var i = 0; i < a.length; i++) {
      if (a[i] !== 0) continue;
      var mark = {}, queue = [i], ok = true, touches = false, rep = i, n = 0;
      mark[i] = 1;
      while (queue.length) {
        var j = queue.pop(); n++;
        if (j < rep) rep = j;
        var x = j % w, y = (j / w) | 0;
        if (x === 0 || y === 0 || x === w - 1 || y === h - 1) touches = true;
        var nb = [y > 0 ? j - w : -1, y < h - 1 ? j + w : -1, x > 0 ? j - 1 : -1, x < w - 1 ? j + 1 : -1];
        for (var k = 0; k < 4; k++) {
          var q = nb[k]; if (q < 0) continue;
          if (a[q] === 0) { if (!mark[q]) { mark[q] = 1; queue.push(q); } }
          else if (a[q] !== SHEATH) ok = false;
        }
        if (n > maxCavity + 1) break;
      }
      if (!ok || touches) continue;
      if (n < minCavity || n > maxCavity) continue;
      reps[rep] = 1;
    }
    return Object.keys(reps).length;
  }

  // ------------------------------------------------------------ 追跡（在庫と到達）

  /**
   * 時系列のループ集合から「在庫」と「到達」を出す。
   *   在庫 (inventory) … ある時刻に同時に存在したループの数の最大
   *   到達 (attainment) … **新しい場所に初めて現れた**回数と、その相異なる時刻の数
   *
   * 同一性の規則（criteria.json の scales.identityRadius）:
   *   重心が既知のどの同一性からも identityRadius より遠ければ「新しい」。
   *   一度数えた同一性は消さない（消えたループが再び現れても数え直さない）。
   */
  function makeTracker(opts) {
    opts = opts || {};
    var R = opts.identityRadius == null ? 4 : opts.identityRadius;
    var known = [];            // [{cx,cy,firstT}]
    var emergenceTimes = {};   // t -> 何個
    var maxLive = 0, maxLiveT = 0;
    var clippedTotal = 0;
    var series = [];

    function observe(t, loops, population) {
      var live = 0, newHere = 0, clipped = 0;
      for (var i = 0; i < loops.length; i++) {
        var L = loops[i];
        if (L.nearBorder) { clipped++; if (population === 'M1_interior') continue; }
        live++;
        var hit = -1;
        for (var k = 0; k < known.length; k++) {
          var dx = known[k].cx - L.cx, dy = known[k].cy - L.cy;
          if (dx * dx + dy * dy <= R * R) { hit = k; break; }
        }
        if (hit < 0) { known.push({ cx: L.cx, cy: L.cy, firstT: t }); newHere++; }
      }
      clippedTotal += clipped;
      if (live > maxLive) { maxLive = live; maxLiveT = t; }
      if (newHere > 0) emergenceTimes[t] = (emergenceTimes[t] || 0) + newHere;
      series.push({ t: t, live: live, clipped: clipped, cum: known.length });
      return live;
    }

    function result(T) {
      var times = Object.keys(emergenceTimes).map(Number).sort(function (a, b) { return a - b; });
      var afterZero = times.filter(function (x) { return x > 0; });
      return {
        maxLoopCount: maxLive, maxLoopCountAt: maxLiveT,
        finalLoopCount: series.length ? series[series.length - 1].live : 0,
        cumulativeLoops: known.length,
        emergenceEvents: afterZero.length,
        emergenceTimes: afterZero,
        firstEmergenceT: afterZero.length ? afterZero[0] : null,
        lastEmergenceT: afterZero.length ? afterZero[afterZero.length - 1] : null,
        newLoopsAfterZero: afterZero.reduce(function (s, x) { return s + emergenceTimes[x]; }, 0),
        clippedObservations: clippedTotal,
        stillGrowingAtT: afterZero.length ? (afterZero[afterZero.length - 1] > 0.75 * T) : false,
        known: known,
        series: series,
      };
    }
    return { observe: observe, result: result };
  }

  // ------------------------------------------------------------ 走らせて測る

  /**
   * 1 本の走行を観測する。
   * opts: { field, table, steps, writes, sampleEvery, matchMode, minCavity, maxCavity,
   *         identityRadius, population, keepFrames }
   */
  function observeRun(opts) {
    var tr = makeTracker({ identityRadius: opts.identityRadius });
    var every = opts.sampleEvery || 1;
    var det = { matchMode: opts.matchMode || 'cavity', minCavity: opts.minCavity,
                maxCavity: opts.maxCavity, margin: 3 };
    var pop = opts.population || 'M1_interior';
    var frames = [];
    var lastField = null;
    var hashes = [];
    S38.run({
      field: opts.field, table: opts.table, steps: opts.steps, writes: opts.writes,
      onStep: function (t, f) {
        lastField = f;
        if (t % every === 0) tr.observe(t, detectLoops(f, det), pop);
        if (opts.keepFrames && opts.keepFrames.indexOf(t) >= 0) frames.push({ t: t, hash: S38.hashField(f) });
        if (opts.hashEvery && t % opts.hashEvery === 0) hashes.push(S38.hashField(f));
      },
    });
    var r = tr.result(opts.steps);
    r.finalHash = S38.hashField(lastField);
    r.supportHash = S38.hashSupport(lastField);
    r.frames = frames;
    r.hashes = hashes;
    r.field = lastField;
    return r;
  }

  // ------------------------------------------------------------ 介入 D4: 依存の散らばり

  /**
   * 「親の 1 点を突いたとき、子の領域の何点が変わるか」。
   *
   * 加法的な（線形な）規則では **厳密に 1** になる——これが参照点 RP-b で、実装の外から来る。
   * 予定表で描いているだけの系では **0**（子は親に依存しない）。
   *
   * opts: { field, table, steps, writes, sites, targetRect, tDaughter, perturb }
   *   perturb(v) … 既定は (v+1) mod 8
   */
  function dependencySpread(opts) {
    var perturb = opts.perturb || function (v) { return (v + 1) % 8; };
    var rect = opts.targetRect, tD = opts.tDaughter;
    var base = fieldAt(opts, tD);
    var baseWin = cut(base, rect);
    var out = [];
    for (var i = 0; i < opts.sites.length; i++) {
      var s = opts.sites[i];
      var f0 = S38.cloneField(opts.field);
      var j = s.y * f0.w + s.x;
      f0.s[j] = perturb(f0.s[j]);
      var f = fieldAt({ field: f0, table: opts.table, writes: opts.writes }, tD);
      var win = cut(f, rect);
      var d = 0;
      for (var k = 0; k < win.length; k++) if (win[k] !== baseWin[k]) d++;
      out.push({ x: s.x, y: s.y, state0: opts.field.s[j], spread: d });
    }
    return out;
  }

  function fieldAt(opts, t) {
    var res = null;
    S38.run({ field: opts.field, table: opts.table, steps: t, writes: opts.writes,
      onStep: function (tt, f) { if (tt === t) res = f; } });
    return res;
  }

  function cut(f, rect) {
    var out = [];
    for (var y = rect.y0; y <= rect.y1; y++)
      for (var x = rect.x0; x <= rect.x1; x++)
        out.push((x < 0 || y < 0 || x >= f.w || y >= f.h) ? 0 : f.s[y * f.w + x]);
    return out;
  }

  // ------------------------------------------------------------ 予定表で描く系

  /**
   * A3（予定表による書き込み）の腕。**規則は何もしない**。
   * 周期 period ごとに、あらかじめ決めた並びへ正典の図形を書き込むだけ。
   * 親から子へ情報は 1 ビットも流れない。
   */
  function stampSchedule(block, ox, oy, period, pitch, nGen, fw, fh) {
    var writes = [];
    for (var g = 1; g <= nGen; g++) {
      for (var i = -g; i <= g; i++) {
        for (var j = -g; j <= g; j++) {
          if (Math.max(Math.abs(i), Math.abs(j)) !== g) continue;
          var x = ox + pitch * i, y = oy + pitch * j;
          if (fw != null && (x < 3 || y < 3 || x + block.w + 3 > fw || y + block.h + 3 > fh)) continue;
          writes.push({ t: g * period, block: block, x: x, y: y });
        }
      }
    }
    return writes;
  }

  var api = {
    SHEATH: SHEATH, CANON_LINES: CANON_LINES, canonBlock: canonBlock,
    CANON_CAVITY: CANON_CAVITY, CANON_WINDOWS: CANON_WINDOWS,
    templates: templates, isRingSite: isRingSite,
    detectLoops: detectLoops, detectLoopsBrute: detectLoopsBrute,
    makeTracker: makeTracker, observeRun: observeRun,
    dependencySpread: dependencySpread, fieldAt: fieldAt, cut: cut,
    stampSchedule: stampSchedule,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.S38obs = api;
})(typeof window !== 'undefined' ? window : this);
