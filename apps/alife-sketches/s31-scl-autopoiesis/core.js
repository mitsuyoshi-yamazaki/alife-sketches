/**
 * S-31 核 — 格子上の3種の粒子と、近傍の種・結合状態だけで決まる遷移規則。
 *
 * **このファイルは上位概念の語彙を持たない。**
 * 膜・区画・細胞・生命・触媒・自己生成・境界といった語は 1 つも使わない（識別子にも分岐にも）。
 * ここにあるのは「種A / 種B / 種C の粒子」「近傍」「つなぎ（join）」「遷移規則」だけである。
 * それらを何と呼ぶかは observe.js 側の語彙にあたる。
 *
 * 格子はトーラス。各マスはちょうど 1 つの占有状態を持つ:
 *   0 = 空き / 1 = 種A / 2 = 種B / 3 = 種C
 *
 * 規則（すべて局所・確率的）:
 *   combine : 種B の Moore-8 近傍にある種A 2 個が、種C 1 個と空き 1 個になる
 *   split   : 種C 1 個と隣の空き 1 個が、種A 2 個になる（つなぎは切れる）
 *   join    : 次数 2 未満の種C どうしが Moore-8 で隣接していればつながる
 *   move    : 粒子が von Neumann 近傍へ 1 歩動く（下の表に従って入れ替わる）
 *   splice  : 次数 0 の種C が、既にあるつなぎ 1 本を切って自分を割り込ませる（任意規則 X1）
 *
 * 入れ替えの表（move）:
 *          相手が 空き   種A        種B   次数0の種C   次数1以上の種C
 *   種A         移る   （無変化）   不可     入替       入替（permeableA のとき・後述）
 *   種B         移る    入替        不可     入替       **不可**
 *   次数0種C    移る    入替        不可     入替       不可
 *   次数1+種C   自分からは動かない
 *
 * 保存量（実装の検査に使う）:
 *   nA + 2*nC   … combine で -2+2=0、split で +2-2=0
 *   nEmpty - nC … combine で +1-1=0、split で -1+1=0
 *   nB          … どの規則も種B を作らず壊さない
 *
 * 依存ゼロ・古典スクリプト。Node とブラウザで共用する。
 */
(function (global) {
  'use strict';

  var EMPTY = 0, A = 1, B = 2, C = 3;

  // ------------------------------------------------------------------ 乱数

  /** mulberry32。同じ種で完全に再現する。 */
  function Rng(seed) { this.s = (seed >>> 0) || 1; }
  Rng.prototype.next = function () {
    this.s = (this.s + 0x6D2B79F5) >>> 0;
    var t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  Rng.prototype.int = function (n) { return (this.next() * n) | 0; };

  // ------------------------------------------------------------------ 既定値

  var DEFAULTS = {
    w: 32, h: 32,
    seed: 1,
    nB: 2,                // 種B の個数
    holeFrac: 0.12,       // 初期の空きの割合
    pCombine: 1.5,        // 種B 1 個・1 sweep あたりの combine 試行の「率」（1 を超えてよい）
    pSplit: 0.012,        // 種C 1 個・1 sweep あたりの split 確率
    pJoin: 0.60,          // 次数 2 未満の種C 1 個・1 sweep あたりの join 試行率
    pSplice: 0.60,        // X1 が有効なときの splice 試行率
    moveAttempts: 1.0,    // 1 sweep の move 試行回数 ÷ マス数

    // --- 骨（どの腕でも外さない） ---
    permeableA: true,     // 種A は「つながった種C」と入れ替われる（種B は入れ替われない）
    holeForSplit: true,   // split には隣に空きが要る（＝ nEmpty - nC が保存される）

    // --- 任意規則。腕はこの 3 つの on/off で作る ---
    rSplice: false,       // X1: 次数 0 の種C が既存のつなぎへ割り込む
    rAngle: false,        // X2: 1 個の種C に付く 2 本のつなぎは 90 度以上離れていること
    rTear: false,         // X3: 入れ替えでつなぎが伸びきるとき切れる（false なら入れ替えを拒む）
    rInhibit: false,      // X4: 次数 0 の種C は、Moore-8 に次数 2 の種C が 2 個以上あるとつながれない
    rRebond: false,       // X5: split の跡地で、近傍の種C を結び直す

    combineMode: 'local', // 'local' = 種B の近傍 / 'uniform' = 同率で格子の一様な場所 / 'off'
  };

  // ------------------------------------------------------------------ 場

  var D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  var D8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

  function makeField(opt) {
    var o = {};
    Object.keys(DEFAULTS).forEach(function (k) { o[k] = DEFAULTS[k]; });
    Object.keys(opt || {}).forEach(function (k) { o[k] = opt[k]; });

    var w = o.w | 0, h = o.h | 0, n = w * h;
    var f = {
      opt: o, w: w, h: h, n: n,
      sp: new Uint8Array(n),
      pid: new Int32Array(n),   // 種B・種C にだけ振る通し番号。move で持ち歩く
      j0: new Int32Array(n),
      j1: new Int32Array(n),
      birth: [],                // pid -> 生まれた sweep
      nextPid: 0,
      bPids: [],                // 種B の pid（不変。位置は毎回走査して求める＝古い索引を持たない）
      t: 0,
      rng: new Rng(o.seed),
      ev: null,
      nb4: new Int32Array(n * 4),
      nb8: new Int32Array(n * 8),
      D8: D8,
    };
    f.j0.fill(-1); f.j1.fill(-1); f.pid.fill(-1);
    resetEvents(f);

    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var s = y * w + x, k;
        for (k = 0; k < 4; k++) f.nb4[s * 4 + k] = ((y + D4[k][1] + h) % h) * w + ((x + D4[k][0] + w) % w);
        for (k = 0; k < 8; k++) f.nb8[s * 8 + k] = ((y + D8[k][1] + h) % h) * w + ((x + D8[k][0] + w) % w);
      }
    }
    return f;
  }

  function resetEvents(f) {
    f.ev = { combine: 0, split: 0, join: 0, unjoin: 0, splice: 0, spliceTry: 0,
             move: 0, moveTry: 0, pass: 0, passTry: 0, cross: 0, tear: 0, rebond: 0 };
  }

  function newPid(f) { var id = f.nextPid++; f.birth[id] = f.t; return id; }

  /** 初期配置。全面を種A にし、空きを撒き、種B を等間隔に置く。 */
  function seedField(f) {
    var i, n = f.n;
    for (i = 0; i < n; i++) { f.sp[i] = A; f.pid[i] = -1; f.j0[i] = -1; f.j1[i] = -1; }
    var holes = Math.round(f.opt.holeFrac * n), placed = 0, guard = 0;
    while (placed < holes && guard++ < n * 50) {
      var s = f.rng.int(n);
      if (f.sp[s] === A) { f.sp[s] = EMPTY; placed++; }
    }
    var nb = f.opt.nB | 0, cols = Math.max(1, Math.ceil(Math.sqrt(nb)));
    for (i = 0; i < nb; i++) {
      var bx, by;
      if (nb === 1) { bx = f.w >> 1; by = f.h >> 1; }
      else if (nb === 2) { bx = Math.round(f.w * (i === 0 ? 0.25 : 0.75)); by = f.h >> 1; }
      else { bx = Math.round(f.w * ((i % cols) + 0.5) / cols); by = Math.round(f.h * (((i / cols) | 0) + 0.5) / cols); }
      var t = (by % f.h) * f.w + (bx % f.w);
      f.sp[t] = B; f.pid[t] = newPid(f); f.j0[t] = -1; f.j1[t] = -1;
      f.bPids.push(f.pid[t]);
    }
    return f;
  }

  function create(opt) { return seedField(makeField(opt)); }

  // ------------------------------------------------------------------ つなぎ

  function deg(f, s) { return (f.j0[s] >= 0 ? 1 : 0) + (f.j1[s] >= 0 ? 1 : 0); }
  function joined(f, s, t) { return f.j0[s] === t || f.j1[s] === t; }

  function linkRaw(f, s, t) {
    if (f.j0[s] < 0) f.j0[s] = t; else f.j1[s] = t;
    if (f.j0[t] < 0) f.j0[t] = s; else f.j1[t] = s;
  }
  function unlinkRaw(f, s, t) {
    if (f.j0[s] === t) f.j0[s] = -1; else if (f.j1[s] === t) f.j1[s] = -1;
    if (f.j0[t] === s) f.j0[t] = -1; else if (f.j1[t] === s) f.j1[t] = -1;
  }
  function addJoin(f, s, t) { linkRaw(f, s, t); f.ev.join++; }
  function dropJoin(f, s, t) { unlinkRaw(f, s, t); f.ev.unjoin++; }
  function dropAllJoins(f, s) {
    if (f.j0[s] >= 0) dropJoin(f, s, f.j0[s]);
    if (f.j1[s] >= 0) dropJoin(f, s, f.j1[s]);
  }

  /** トーラス上の最短差分。 */
  function dx(f, s, t) {
    var d = (t % f.w) - (s % f.w);
    if (d * 2 > f.w) d -= f.w; else if (d * 2 < -f.w) d += f.w;
    return d;
  }
  function dy(f, s, t) {
    var d = ((t / f.w) | 0) - ((s / f.w) | 0);
    if (d * 2 > f.h) d -= f.h; else if (d * 2 < -f.h) d += f.h;
    return d;
  }
  function adj8(f, s, t) {
    if (s === t) return false;
    var a = dx(f, s, t), b = dy(f, s, t);
    return a >= -1 && a <= 1 && b >= -1 && b <= 1;
  }

  function site(f, x, y) { return (((y % f.h) + f.h) % f.h) * f.w + (((x % f.w) + f.w) % f.w); }

  /**
   * 交差の検査。斜めのつなぎ (s,t) は、もう一方の対角どうしのつなぎと交わる。
   * 交差を許すと「単純な閉じた折れ線」でなくなり、Pick の恒等式（selftest の正コントロール）が崩れる。
   */
  function crosses(f, s, t) {
    var a = dx(f, s, t), b = dy(f, s, t);
    if (a === 0 || b === 0) return false;
    var sx = s % f.w, sy = (s / f.w) | 0;
    return joined(f, site(f, sx, sy + b), site(f, sx + a, sy));
  }

  /** X2: 既に 1 本つながっている種C に 2 本目を付けるとき、角度が 90 度未満なら拒む。 */
  function angleOk(f, s, t) {
    if (!f.opt.rAngle) return true;
    var other = f.j0[s] >= 0 ? f.j0[s] : f.j1[s];
    if (other < 0 || other === t) return true;
    return dx(f, s, other) * dx(f, s, t) + dy(f, s, other) * dy(f, s, t) <= 0;
  }

  /**
   * X4: 次数 0 の種C は、Moore-8 の近傍に次数 2 の種C が 2 個以上あるとつながれない。
   * 鎖の「端」や「切れ目」ではつながれるが、鎖の「わき」ではつながれない、という形になる。
   */
  function inhibited(f, s) {
    if (!f.opt.rInhibit) return false;
    if (deg(f, s) !== 0) return false;
    var n2 = 0;
    for (var k = 0; k < 8; k++) {
      var t = f.nb8[s * 8 + k];
      if (f.sp[t] === C && deg(f, t) === 2) { n2++; if (n2 > 1) return true; }
    }
    return false;
  }

  function canJoin(f, s, t) {
    if (s === t) return false;
    if (f.sp[s] !== C || f.sp[t] !== C) return false;
    if (joined(f, s, t)) return false;
    if (deg(f, s) >= 2 || deg(f, t) >= 2) return false;
    if (!adj8(f, s, t)) return false;
    if (inhibited(f, s) || inhibited(f, t)) return false;
    if (crosses(f, s, t)) { f.ev.cross++; return false; }
    if (!angleOk(f, s, t) || !angleOk(f, t, s)) return false;
    return true;
  }

  // ------------------------------------------------------------------ 規則

  function tryCombine(f, center) {
    var pool = [], k, t;
    for (k = 0; k < 8; k++) { t = f.nb8[center * 8 + k]; if (f.sp[t] === A) pool.push(t); }
    if (pool.length < 2) return false;
    var i = f.rng.int(pool.length), j = f.rng.int(pool.length - 1);
    if (j >= i) j++;
    var a1 = pool[i], a2 = pool[j];
    f.sp[a1] = C; f.pid[a1] = newPid(f); f.j0[a1] = -1; f.j1[a1] = -1;
    f.sp[a2] = EMPTY; f.pid[a2] = -1;
    f.ev.combine++;
    return true;
  }

  function trySplit(f, s) {
    var hole = -1;
    if (f.opt.holeForSplit) {
      var holes = [], k, t;
      for (k = 0; k < 4; k++) { t = f.nb4[s * 4 + k]; if (f.sp[t] === EMPTY) holes.push(t); }
      if (!holes.length) return false;
      hole = holes[f.rng.int(holes.length)];
    }
    dropAllJoins(f, s);
    f.sp[s] = A; f.pid[s] = -1;
    if (hole >= 0) { f.sp[hole] = A; f.pid[hole] = -1; }
    f.ev.split++;
    if (f.opt.rRebond) tryRebond(f, s);
    return true;
  }

  /**
   * X5: 跡地の結び直し。Moore-8 の「次数 1 の種C」の対で結べるものを極大に結び、
   * そのあと「次数 0 の種C」を加えてもう一度回す。
   */
  function matchPairs(f, list) {
    var pairs = [], i, j, made = 0;
    for (i = 0; i < list.length; i++) {
      for (j = i + 1; j < list.length; j++) {
        if (canJoin(f, list[i], list[j])) pairs.push(list[i], list[j]);
      }
    }
    var order = [];
    for (i = 0; i < pairs.length; i += 2) order.push(i);
    shuffle(f, order);
    for (i = 0; i < order.length; i++) {
      var a = pairs[order[i]], b = pairs[order[i] + 1];
      if (canJoin(f, a, b)) { addJoin(f, a, b); made++; }
    }
    return made;
  }

  function tryRebond(f, s) {
    var m = [], k, t, made = 0;
    for (k = 0; k < 8; k++) { t = f.nb8[s * 8 + k]; if (f.sp[t] === C && deg(f, t) === 1) m.push(t); }
    made += matchPairs(f, m);
    for (k = 0; k < 8; k++) { t = f.nb8[s * 8 + k]; if (f.sp[t] === C && deg(f, t) === 0) m.push(t); }
    made += matchPairs(f, m.filter(function (x) { return f.sp[x] === C && deg(f, x) < 2; }));
    f.ev.rebond += made;
    return made;
  }

  /** マス s にいる種C を to へ動かしたとき、Moore-8 を超えるつなぎの相手を out に集める。 */
  function stretched(f, s, to, out) {
    var cnt = 0, p;
    p = f.j0[s]; if (p >= 0 && p !== to && !adj8(f, to, p)) { out.push(p); cnt++; }
    p = f.j1[s]; if (p >= 0 && p !== to && !adj8(f, to, p)) { out.push(p); cnt++; }
    return cnt;
  }

  /** s の中身（つなぎ込み）を空きマス t へ移す。 */
  function relocate(f, s, t) {
    var p;
    p = f.j0[s]; if (p >= 0) { if (f.j0[p] === s) f.j0[p] = t; else if (f.j1[p] === s) f.j1[p] = t; }
    p = f.j1[s]; if (p >= 0) { if (f.j0[p] === s) f.j0[p] = t; else if (f.j1[p] === s) f.j1[p] = t; }
    f.sp[t] = f.sp[s]; f.pid[t] = f.pid[s]; f.j0[t] = f.j0[s]; f.j1[t] = f.j1[s];
    f.sp[s] = EMPTY; f.pid[s] = -1; f.j0[s] = -1; f.j1[s] = -1;
  }

  /**
   * s（つなぎを持たない粒子）と t（つなぎを持ちうる粒子）を入れ替える。
   * **s 側につなぎがある呼び出しは想定しない**（move の表のとおり、動くのは次数 0 の粒子だけ）。
   */
  function swap(f, s, t) {
    var sp = f.sp[s], pid = f.pid[s];
    f.sp[s] = EMPTY; f.pid[s] = -1;
    relocate(f, t, s);
    f.sp[t] = sp; f.pid[t] = pid; f.j0[t] = -1; f.j1[t] = -1;
  }

  /** 入れ替えの後に、種C が新しい交差を作っていないか。 */
  function madeCross(f, cSite) {
    var p;
    p = f.j0[cSite]; if (p >= 0 && crosses(f, cSite, p)) return true;
    p = f.j1[cSite]; if (p >= 0 && crosses(f, cSite, p)) return true;
    return false;
  }

  function tryMove(f, s) {
    var sp = f.sp[s];
    if (sp === EMPTY) return false;
    if (sp === C && deg(f, s) > 0) return false;
    f.ev.moveTry++;
    var t = f.nb4[s * 4 + f.rng.int(4)];
    var tp = f.sp[t];

    if (tp === EMPTY) { relocate(f, s, t); f.ev.move++; return true; }
    if (tp === B) return false;
    if (tp === A) {
      if (sp === A) return false;          // 同種の入れ替えは場を変えない
      swap(f, s, t); f.ev.move++; return true;
    }
    if (tp !== C) return false;
    if (deg(f, t) === 0) { swap(f, s, t); f.ev.move++; return true; }

    // ここから「つながった種C を通り抜ける」経路。種A だけが通れる。
    if (sp !== A || !f.opt.permeableA) return false;
    f.ev.passTry++;
    var torn = [], k;
    stretched(f, t, s, torn);
    if (torn.length && !f.opt.rTear) return false;
    swap(f, s, t);                          // 種C は s へ、種A は t へ
    for (k = 0; k < torn.length; k++) unlinkRaw(f, s, torn[k]);
    if (madeCross(f, s)) {
      for (k = 0; k < torn.length; k++) linkRaw(f, s, torn[k]);
      swap(f, t, s);                        // 戻す
      f.ev.cross++;
      return false;
    }
    f.ev.tear += torn.length;
    f.ev.move++; f.ev.pass++;
    return true;
  }

  /** X1 splice: 次数 0 の種C が、隣り合う「つながった 2 個」の間へ割り込む。 */
  function trySplice(f, s) {
    var cand = [], k, m, u, v;
    for (k = 0; k < 8; k++) {
      u = f.nb8[s * 8 + k];
      if (f.sp[u] !== C) continue;
      for (m = k + 1; m < 8; m++) {
        v = f.nb8[s * 8 + m];
        if (f.sp[v] === C && joined(f, u, v)) cand.push(u, v);
      }
    }
    f.ev.spliceTry++;
    if (!cand.length) return false;
    var pick = f.rng.int(cand.length >> 1) * 2;
    u = cand[pick]; v = cand[pick + 1];
    unlinkRaw(f, u, v);
    if (canJoin(f, s, u) && canJoin(f, s, v)) {
      linkRaw(f, s, u); linkRaw(f, s, v);
      f.ev.splice++; f.ev.join += 2; f.ev.unjoin++;
      return true;
    }
    if (joined(f, s, u)) unlinkRaw(f, s, u);
    linkRaw(f, u, v);
    return false;
  }

  // ------------------------------------------------------------------ 1 sweep

  function shuffle(f, arr) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = f.rng.int(i + 1), tmp = arr[i];
      arr[i] = arr[j]; arr[j] = tmp;
    }
  }

  var ORDER8 = [0, 1, 2, 3, 4, 5, 6, 7];

  /** 率 r（1 を超えてよい）から、この sweep での試行回数を引く。整数部 + ベルヌーイの端数。 */
  function drawCount(f, r) {
    var k = Math.floor(r);
    return (f.rng.next() < r - k) ? k + 1 : k;
  }

  function step(f) {
    var o = f.opt, n = f.n, i, s, k;
    resetEvents(f);

    // 1. move
    var tries = Math.round(o.moveAttempts * n);
    for (i = 0; i < tries; i++) tryMove(f, f.rng.int(n));

    // 2/3. 走査 1 回で種C と種B の位置を取り直す（古い索引を持たない）
    var cs = [], bs = [];
    for (s = 0; s < n; s++) {
      if (f.sp[s] === C) cs.push(s);
      else if (f.sp[s] === B) bs.push(s);
    }
    for (i = 0; i < cs.length; i++) if (f.rng.next() < o.pSplit) trySplit(f, cs[i]);

    if (o.combineMode === 'local') {
      for (i = 0; i < bs.length; i++) {
        var rep = drawCount(f, o.pCombine);
        for (k = 0; k < rep; k++) tryCombine(f, bs[i]);
      }
    } else if (o.combineMode === 'uniform') {
      var nb = bs.length || (o.nB | 0);
      for (i = 0; i < nb; i++) {
        var rep2 = drawCount(f, o.pCombine);
        for (k = 0; k < rep2; k++) tryCombine(f, f.rng.int(n));
      }
    }

    // 4. join
    cs.length = 0;
    for (s = 0; s < n; s++) if (f.sp[s] === C && deg(f, s) < 2) cs.push(s);
    shuffle(f, cs);
    for (i = 0; i < cs.length; i++) {
      s = cs[i];
      if (f.sp[s] !== C || deg(f, s) >= 2) continue;
      if (f.rng.next() >= o.pJoin) continue;
      // **毎回 恒等な並びへ戻してから混ぜる。** 戻さないと ORDER8 の中身が呼び出しをまたいで
      // 持ち越され、同じシードでも走行ごとに違う結果になる（本番前の再現性の検査が捕まえた）
      for (k = 0; k < 8; k++) ORDER8[k] = k;
      shuffle(f, ORDER8);
      for (k = 0; k < 8; k++) {
        var t = f.nb8[s * 8 + ORDER8[k]];
        if (canJoin(f, s, t)) { addJoin(f, s, t); break; }
      }
    }

    // 5. splice（X1）
    if (o.rSplice) {
      cs.length = 0;
      for (s = 0; s < n; s++) if (f.sp[s] === C && deg(f, s) === 0) cs.push(s);
      shuffle(f, cs);
      for (i = 0; i < cs.length; i++) {
        s = cs[i];
        if (f.sp[s] === C && deg(f, s) === 0 && f.rng.next() < o.pSplice) trySplice(f, s);
      }
    }

    f.t++;
    return f;
  }

  // ------------------------------------------------------------------ 検算

  function counts(f) {
    var c = { EMPTY: 0, A: 0, B: 0, C: 0, joins: 0, degSum: 0, free: 0 };
    for (var s = 0; s < f.n; s++) {
      var sp = f.sp[s];
      if (sp === EMPTY) c.EMPTY++;
      else if (sp === A) c.A++;
      else if (sp === B) c.B++;
      else {
        c.C++;
        var d = deg(f, s);
        c.degSum += d;
        if (d === 0) c.free++;
      }
    }
    c.joins = c.degSum / 2;
    return c;
  }

  /** 種B の pid -> 現在のマス。**毎回走査して作る**（古い索引を持ち回らない）。 */
  function locate(f, pids) {
    var want = {}, out = {};
    for (var i = 0; i < pids.length; i++) want[pids[i]] = 1;
    for (var s = 0; s < f.n; s++) if (f.pid[s] >= 0 && want[f.pid[s]]) out[f.pid[s]] = s;
    return out;
  }

  /** つなぎの対称性・適格性の全数検査。 */
  function auditJoins(f) {
    var bad = [];
    for (var s = 0; s < f.n; s++) {
      if (f.sp[s] !== C && (f.j0[s] >= 0 || f.j1[s] >= 0)) bad.push('種C でないマス ' + s + ' につなぎがある');
      if (f.j0[s] >= 0 && f.j0[s] === f.j1[s]) bad.push('同じ相手と 2 本 ' + s);
      var ps = [f.j0[s], f.j1[s]];
      for (var k = 0; k < 2; k++) {
        var p = ps[k];
        if (p < 0) continue;
        if (f.sp[p] !== C) bad.push('つなぎの相手 ' + p + ' が種C でない（' + s + ' から）');
        if (!joined(f, p, s)) bad.push('つなぎが片側だけ ' + s + '->' + p);
        if (!adj8(f, s, p)) bad.push('つなぎが Moore-8 を超えている ' + s + '-' + p);
      }
    }
    return bad;
  }

  /** 交差したつなぎが 1 本も無いこと（Pick の恒等式の前提）。 */
  function auditCrossings(f) {
    var bad = [];
    for (var s = 0; s < f.n; s++) {
      if (f.sp[s] !== C) continue;
      var ps = [f.j0[s], f.j1[s]];
      for (var k = 0; k < 2; k++) {
        var p = ps[k];
        if (p < 0 || p < s) continue;
        if (crosses(f, s, p)) bad.push('交差 ' + s + '-' + p);
      }
    }
    return bad;
  }

  function hashState(f) {
    var hh = 2166136261 >>> 0;
    function mix(v) {
      v = v | 0;
      for (var b = 0; b < 4; b++) { hh ^= (v >>> (b * 8)) & 255; hh = Math.imul(hh, 0x01000193) >>> 0; }
    }
    for (var s = 0; s < f.n; s++) { mix(f.sp[s]); mix(f.j0[s]); mix(f.j1[s]); }
    mix(f.t);
    return ('0000000' + (hh >>> 0).toString(16)).slice(-8);
  }

  /** 素朴な総当たりの Moore-8（索引 nb8 の検算用）。 */
  function bruteNeighbours(f, s) {
    var out = [], sx = s % f.w, sy = (s / f.w) | 0;
    for (var yy = -1; yy <= 1; yy++) {
      for (var xx = -1; xx <= 1; xx++) {
        if (!xx && !yy) continue;
        out.push(site(f, sx + xx, sy + yy));
      }
    }
    return out.sort(function (a, b) { return a - b; });
  }

  var api = {
    EMPTY: EMPTY, A: A, B: B, C: C, D8: D8, D4: D4,
    DEFAULTS: DEFAULTS, Rng: Rng,
    create: create, makeField: makeField, seedField: seedField, step: step,
    deg: deg, joined: joined, addJoin: addJoin, dropJoin: dropJoin, dropAllJoins: dropAllJoins,
    linkRaw: linkRaw, unlinkRaw: unlinkRaw,
    canJoin: canJoin, inhibited: inhibited, tryRebond: tryRebond, matchPairs: matchPairs, crosses: crosses, angleOk: angleOk, adj8: adj8, dx: dx, dy: dy, site: site,
    relocate: relocate, swap: swap, stretched: stretched,
    tryMove: tryMove, tryCombine: tryCombine, trySplit: trySplit, trySplice: trySplice,
    counts: counts, locate: locate, drawCount: drawCount, auditJoins: auditJoins, auditCrossings: auditCrossings,
    hashState: hashState, bruteNeighbours: bruteNeighbours, newPid: newPid,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.S31 = api;
})(typeof window !== 'undefined' ? window : this);
