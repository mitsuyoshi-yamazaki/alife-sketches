/**
 * S-72 v1.1.1 の追加の bot 4 体（B8〜B11。ユーザ直接指示 2026-10-02）。
 *
 * **事前登録の bot（bots.js の B0〜B7）は書き換えていない**。ここは新しいファイルで、B0〜B7 は bots.js へそのまま委ねる（makeBot の振り分け）。
 * 4 体とも単純で決定論的（各自のシードの乱数だけを使う。bot の系列は hash(シード, bot の id, 番号) ＝ B0〜B7 と同じ規則）。
 * 判断の頻度は B0〜B7 と同じ（リアルタイム制は D ティックごと、ラウンド制はラウンドの頭）。置ける場所の判定は bots.js と同じ（自陣の中の死んだセル）。
 *
 *   B8  ランダムな行動 — 「棚の形をランダムな向き・自陣のランダムな位置へ」「ランダムなセルを 1〜残高の数だけ」「待つ」から一様に選ぶ。
 *                       待つが 2 回続いたら次は必ず置く（開始時の配置の判断も必ず置く）。選んだ形が残高を超えるなら置ける形から選び直す。置けるものが無いときだけ待つ
 *   B9  小さく頻繁     — 5 セル以下の形（blinker・block・glider・R ペントミノ）から**目標の形を 1 つ**選び、残高が貯まるまで待ち、
 *                       ランダムな向き・自陣のランダムな位置へ置く
 *   B10 投射型         — 動く形（glider・LWSS）と銃（確率 GUN_PROB）から目標の形を選び、残高が貯まるまで待ち、相手のほうへ進む向きで自陣の前線側に置く。
 *                       4 人戦では生き残っている相手の 1 人をランダムに狙う
 *   B11 自陣型         — その場に留まる形（block・beehive・blinker・eater1・R ペントミノ・acorn・diehard）から目標の形を選び、残高が貯まるまで待ち、
 *                       自陣のランダムな位置へ置く
 *
 * B9〜B11 は同じ型（目標方式）: **目標の形を 1 つ選び、残高が目標のコストに届くまで待ち、置けたら次の目標を選ぶ**。
 * 「今置けるものから選ぶ」作りだと、既定の収入（D = 30 ティックごとに +3）では最も安い形に偏り、「小さい形」「留まる形」「投射する形」を好む性格が潰れるため。
 * 目標が自陣に置き場所が無くて置けないときは、その判断のうちに「今の残高で買えて、今置ける形」から選び直して置く（無ければ目標を空にして待ち、次の判断で選び直す。無限に待たない）。
 * 目標の候補は コスト ≤ 銀行の上限（view.C）の形だけ（上限を超える形は貯めても買えず、永久に待つため）。
 * 開始時の配置の判断（view で判定: リアルタイム制は gt === 0、ラウンド制は round === 1）は、今の残高で買える目標を選ぶ（開始時に何も置かないと開始と同時に全滅するため）。
 *
 * 「動く形／留まる形」は**手で書いたラベルではない**。棚の各形を単独で走らせて機械的に決めた表（shelfTable）から引く:
 *   動く形（moves）   — ある周期 p ≤ P_max のあと、同じ形が（0 でない量だけ）平行移動して現れる（宇宙船）
 *   投射する形（projects）— 動く形ではないが、元の形の周りは周期 p ≤ P_max で繰り返しつつ、外へ流れ（セル）を送り出し続ける（銃）
 *   留まる形（stays）  — それ以外（静物・振動子・カオス的に拡がる／消える種）
 * 進む向きも同じ方針で、形を単独で HORIZON ティック（数周期）走らせたときの重心の移動から決める。
 *
 * 依存ゼロ・古典スクリプト。Node とブラウザで共用（Node: `require('./bots-extra.js')` / ブラウザ: `window.S72BotsExtra`）。
 */
(function (root, factory) {
  var api = factory(
    typeof require === 'function' ? require('./core.js') : root.S72,
    typeof require === 'function' ? require('./patterns.js') : root.S72Patterns,
    typeof require === 'function' ? require('./bots.js') : root.S72Bots
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S72BotsExtra = api;
})(typeof self !== 'undefined' ? self : this, function (S, P, Bots) {
  'use strict';

  var EXTRA_IDS = ['B8', 'B9', 'B10', 'B11'];
  var EXTRA_NAMES = {
    B8: 'ランダムな行動（random）', B9: '小さく頻繁（small）', B10: '投射型（projector）', B11: '自陣型（homebody）',
  };
  var ALL_IDS = Bots.BOT_IDS.concat(EXTRA_IDS);
  var ALL_NAMES = Object.assign({}, Bots.BOT_NAMES, EXTRA_NAMES);

  var TRIALS = Bots.TRIALS;      // 位置の試行の上限（bots.js と同じ）
  var ORI = Bots.ORI;            // 棚の形ごとの D4 の 8 通りの向き
  var SMALL_MAX = 5;             // B9: 小さい形の上限（セル数）
  var MAX_WAITS = 2;             // B8: 待つが続けてよい回数
  var FRONT_DEPTH = 8;           // B10: 前線側の幅（相手側の端からのセル数）
  var GUN_PROB = 0.1;            // B10: 目標に銃を選ぶ確率。銃は 36 セルで、既定の収入では貯めるのに 12 回の判断（360 ティック）かかり、貯めている間は新しい形が出ない。1/2 では待ってばかりで周期化に負けやすい（README の比較）
  var DIR_COS = 0.5;             // B10: 進む向きと相手の向きのなす角が 60 度未満（cos > 0.5）
  var MAX_ORI = 8;

  /** 形の表を作るときの単独走行の設定。horizon = 120 は銃の 4 周期・グライダー／LWSS の 30 周期。 */
  var TABLE = { horizon: 120, pmax: 30, arena: 240, margin: 4, from: 60 };

  function ri(r, lo, hi) { return lo + Math.floor(r() * (hi - lo + 1)); }
  function key(x, y) { return x + ',' + y; }
  function pick(r, list) { return list[Math.floor(r() * list.length)]; }
  /** 一様な並べ替え（Fisher–Yates）。先頭が一様な選択になり、置けなければ次を試せる。 */
  function shuffled(r, list) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  // ------------------------------------------------------------------ 形の表（単独で走らせて機械的に決める）
  var scratch = null;
  function arena() {
    if (!scratch) scratch = new S.Sim(TABLE.arena, TABLE.arena, 0);
    scratch.reset();
    return scratch;
  }

  function liveCells(sim) {
    var L = sim.cur, sw = sim.sw, out = [];
    for (var y = L.yMin; y <= L.yMax; y++) {
      if (L.rowMax[y] < 0) continue;
      var base = (y + 1) * sw + 1;
      for (var x = L.rowMin[y]; x <= L.rowMax[y]; x++) if (L.tag[base + x]) out.push([x, y]);
    }
    return out;
  }

  function centroid(cells) {
    var sx = 0, sy = 0;
    cells.forEach(function (c) { sx += c[0]; sy += c[1]; });
    return [sx / cells.length, sy / cells.length];
  }

  /** 形を盤の中央に置いて ticks ティック走らせる。collect なら全ティックのセルを返し、でなければ最初と最後だけ。 */
  function runAlone(cells, ticks, collect) {
    var sim = arena(), bb = P.bbox(cells), mid = TABLE.arena / 2;
    var ox = mid - Math.floor(bb.w / 2) - bb.x0, oy = mid - Math.floor(bb.h / 2) - bb.y0;
    cells.forEach(function (c) { sim.set(ox + c[0], oy + c[1], 1); });
    var box = { x0: ox + bb.x0, y0: oy + bb.y0, x1: ox + bb.x1, y1: oy + bb.y1 };
    var first = liveCells(sim), frames = collect ? [first] : null;
    for (var t = 1; t <= ticks; t++) {
      sim.step();
      if (collect) frames.push(liveCells(sim));
    }
    return { first: first, last: collect ? frames[ticks] : liveCells(sim), frames: frames, box: box };
  }

  function minCorner(cells) {
    var mx = Infinity, my = Infinity;
    cells.forEach(function (c) { if (c[0] < mx) mx = c[0]; if (c[1] < my) my = c[1]; });
    return [mx, my];
  }

  /** 平行移動を無視した形の鍵（順序に依らない）。 */
  function shapeKey(cells) {
    var m = minCorner(cells);
    return cells.map(function (c) { return (c[0] - m[0]) + ',' + (c[1] - m[1]); }).sort().join(';');
  }

  function insideKey(cells, b) {
    return cells.filter(function (c) { return c[0] >= b.x0 && c[0] <= b.x1 && c[1] >= b.y0 && c[1] <= b.y1; })
      .map(function (c) { return key(c[0], c[1]); }).sort().join(';');
  }

  function countOutside(cells, b) {
    return cells.filter(function (c) { return c[0] < b.x0 || c[0] > b.x1 || c[1] < b.y0 || c[1] > b.y1; }).length;
  }

  /**
   * 棚の 1 つの形を単独で走らせて分類する。
   *   ① 周期 p ≤ P_max で同じ形が現れ、位置が 0 でない量だけずれる → moves（宇宙船。速度 (dx, dy) / p）
   *   ② 位置が同じで同じ形が現れる（静物・振動子）→ stays（returns = p）
   *   ③ 最初の外接矩形（周り margin）の中の様子が、第 from ティック以降に周期 p ≤ P_max で繰り返し、かつ外のセル数が増え続ける → projects（銃）
   *   ④ それ以外（カオス的に拡がる・消える）→ stays（returns = null）
   */
  function classify(pat) {
    var run = runAlone(pat.cells, TABLE.horizon, true), fr = run.frames, row = { id: pat.id, cost: pat.cost, cls: 'stays', returns: null, ship: null, source: null };
    var base = shapeKey(fr[0]), m0 = minCorner(fr[0]), p;
    for (p = 1; p <= TABLE.pmax; p++) {
      if (fr[p].length !== fr[0].length || shapeKey(fr[p]) !== base) continue;
      var m = minCorner(fr[p]), dx = m[0] - m0[0], dy = m[1] - m0[1];
      if (dx !== 0 || dy !== 0) { row.cls = 'moves'; row.ship = { period: p, dx: dx, dy: dy }; return row; }
      row.returns = p; return row; // 静物・振動子
    }
    var b = run.box, R = { x0: b.x0 - TABLE.margin, y0: b.y0 - TABLE.margin, x1: b.x1 + TABLE.margin, y1: b.y1 + TABLE.margin };
    var keys = [], outs = [], t;
    for (t = TABLE.from; t <= TABLE.horizon; t++) { keys[t] = insideKey(fr[t], R); outs[t] = countOutside(fr[t], R); }
    for (p = 1; p <= TABLE.pmax && TABLE.from + 2 * p <= TABLE.horizon; p++) {
      var same = true;
      for (t = TABLE.from; t <= TABLE.from + p && same; t++) if (keys[t] !== keys[t + p]) same = false;
      if (same && outs[TABLE.from + 2 * p] > outs[TABLE.from]) { row.cls = 'projects'; row.source = { period: p, outside: outs[TABLE.from + 2 * p] }; return row; }
    }
    return row;
  }

  /** 形を単独で horizon ティック走らせたときの重心の移動（向きの単位ベクトルつき）。消えれば null。 */
  function directionOf(cells) {
    var run = runAlone(cells, TABLE.horizon, false);
    if (!run.last.length) return null;
    var a = centroid(run.first), c = centroid(run.last), dx = c[0] - a[0], dy = c[1] - a[1], len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1) return null;
    return { dx: dx, dy: dy, len: len, ux: dx / len, uy: dy / len };
  }

  var cache = null;
  /**
   * 棚の分類表と、動く形・投射する形の 8 通りの向きごとの進む向き。最初に使うときに作る（棚 10 種 + 24 通りの単独走行。数十 ms）。
   * rows = 棚の順の分類、movers / projectors / stayers = 形の id の配列、dirs[id] = 向きごとの { o, cells, box, dir }。
   */
  function shelfTable() {
    if (cache) return cache;
    var rows = P.SHELF.map(classify), dirs = {}, byId = {};
    var ids = function (cls) { return rows.filter(function (x) { return x.cls === cls; }).map(function (x) { return x.id; }); };
    rows.forEach(function (x) {
      byId[x.id] = x;
      if (x.cls === 'stays') return;
      dirs[x.id] = ORI[x.id].map(function (o) { return { o: o.o, cells: o.cells, box: o.box, dir: directionOf(o.cells) }; });
    });
    cache = { rows: rows, byId: byId, movers: ids('moves'), projectors: ids('projects'), stayers: ids('stays'), dirs: dirs, params: Object.assign({}, TABLE) };
    return cache;
  }

  /** 表の説明（README・selftest の出力用）。 */
  function describeTable() {
    return shelfTable().rows.map(function (x) {
      var how = x.cls === 'moves' ? '周期 ' + x.ship.period + ' で (' + x.ship.dx + ', ' + x.ship.dy + ') だけ平行移動する（宇宙船）'
        : x.cls === 'projects' ? '周りは周期 ' + x.source.period + ' で繰り返し、外へ流れ続ける（外のセル ' + x.source.outside + '）'
        : x.returns !== null ? '周期 ' + x.returns + ' で元の位置へ戻る（静物・振動子）' : '戻らない・飛ばない（カオス的に拡がる／消える）';
      return { id: x.id, cost: x.cost, cls: x.cls, how: how };
    });
  }

  // ------------------------------------------------------------------ 置き場所
  function cellsAt(ori, x0, y0) { return ori.cells.map(function (c) { return [x0 + c[0], y0 + c[1]]; }); }

  /** 全セルが自陣の中の死んだセルか（bots.js の fits と同じ判定）。 */
  function fits(view, cells) {
    for (var i = 0; i < cells.length; i++) {
      var x = cells[i][0], y = cells[i][1];
      if (x < 0 || y < 0 || x >= view.zoneW || y >= view.zoneH) return false;
      if (view.sim.get(x, y) !== 0) return false;
    }
    return true;
  }

  /**
   * 向き ori の形を、外接矩形の右端が xrR = [lo, hi]・下端が ybR = [lo, hi]（null は自陣の全域）にあるように乱択の位置へ置く（最大 TRIALS 回）。
   * 置けなければ null。exhaustive（B9〜B11 が使う）なら、乱択で見つからないときに全ての位置を数え上げて一様に選ぶ——
   * 「置き場所が無い」を本当に無いときだけにする（B8 は従来どおり乱択の試行だけ。乱数の消費を変えない）。
   */
  function placeIn(view, r, ori, xrR, ybR, exhaustive) {
    var b = ori.box;
    var xr0 = Math.max(xrR ? xrR[0] : 0, b.w - 1), xr1 = Math.min(xrR ? xrR[1] : view.zoneW - 1, view.zoneW - 1);
    var yb0 = Math.max(ybR ? ybR[0] : 0, b.h - 1), yb1 = Math.min(ybR ? ybR[1] : view.zoneH - 1, view.zoneH - 1);
    if (xr0 > xr1 || yb0 > yb1) return null;
    for (var t = 0; t < TRIALS; t++) {
      var xr = ri(r, xr0, xr1), yb = ri(r, yb0, yb1);
      var cells = cellsAt(ori, xr - b.w + 1, yb - b.h + 1);
      if (fits(view, cells)) return cells;
    }
    if (!exhaustive) return null;
    var all = [];
    for (var y = yb0; y <= yb1; y++) for (var x = xr0; x <= xr1; x++) {
      var c = cellsAt(ori, x - b.w + 1, y - b.h + 1);
      if (fits(view, c)) all.push(c);
    }
    return all.length ? all[ri(r, 0, all.length - 1)] : null;
  }

  function affordable(id, bank) { return P.BY_ID[id].cost <= bank; }

  /** 棚の形 id を、ランダムな向き・自陣のランダムな位置へ。置けなければ null。 */
  function placeShape(view, r, id) {
    var cells = placeIn(view, r, ORI[id][ri(r, 0, MAX_ORI - 1)], null, null);
    return cells ? { cells: cells, names: [id] } : null;
  }

  // ------------------------------------------------------------------ B8 ランダムな行動
  /** ランダムなセルを 1〜残高の数だけ（自陣の死んだセルから重複なく）。 */
  function randomCells(view, r) {
    if (view.bank < 1) return null;
    var n = ri(r, 1, view.bank), cells = [], seen = {};
    for (var t = 0; t < n * 30 && cells.length < n; t++) {
      var x = ri(r, 0, view.zoneW - 1), y = ri(r, 0, view.zoneH - 1), k = key(x, y);
      if (seen[k] || view.sim.get(x, y) !== 0) continue;
      seen[k] = true; cells.push([x, y]);
    }
    return cells.length ? { cells: cells, names: ['cells'] } : null;
  }

  /** 棚の形を一様に選ぶ。残高を超えるなら、置ける形から選び直す。置ける形が無ければ null。 */
  function randomShape(view, r) {
    var pat = pick(r, P.SHELF);
    if (pat.cost > view.bank) {
      var aff = P.SHELF.filter(function (p) { return p.cost <= view.bank; });
      if (!aff.length) return null;
      pat = pick(r, aff);
    }
    return placeShape(view, r, pat.id);
  }

  function decideRandom(view, r, st) {
    var must = st.waits >= MAX_WAITS || isOpening(view); // 待つが 2 回続いたら次は必ず置く。開始時の配置の判断も必ず置く（途中で任された最初の判断は対象外）
    var act = Math.floor(r() * (must ? 2 : 3));        // 0 形・1 セル・2 待つ（一様）
    var got = null;
    if (act === 0) got = randomShape(view, r) || randomCells(view, r); // 形が置けなければ（残高・場所）置けるもの（セル）へ
    else if (act === 1) got = randomCells(view, r);
    st.waits = got ? 0 : st.waits + 1;
    return got;
  }

  // ------------------------------------------------------------------ B9〜B11 の目標方式
  /** 形 id を、ランダムな向き・自陣のランダムな位置へ（向きを一様に並べ、置ける向きが見つかるまで試す）。置き場所が無ければ null。 */
  function placeTarget(view, r, id) {
    var order = shuffled(r, ORI[id]);
    for (var i = 0; i < order.length; i++) {
      var cells = placeIn(view, r, order[i], null, null, true);
      if (cells) return { cells: cells, names: [id] };
    }
    return null;
  }

  /** 開始時の配置の判断か（リアルタイム制は第 0 ティック、ラウンド制はラウンド 1）。途中で任された最初の判断は開始時ではない。 */
  function isOpening(view) { return view.rt === true ? view.gt === 0 : view.round === 1; }

  /**
   * 目標方式: st.target（形の id）を持ち、残高が目標のコストに届くまで待ち（目標は持ち越す）、置けたら目標を空にする（次の判断で選び直す）。
   *   - 目標の候補は常に コスト ≤ view.C（銀行の上限。リアルタイム制は bankMax、ラウンド制は C）の形だけ。上限を超える形は貯めても買えない。
   *     持ち越した目標が上限を超えたら選び直す。候補が空なら待つ
   *   - 目標に置き場所が無ければ、**今の残高で買えて、かつ今置ける形**から選び直し、その判断で置く。無ければ目標を空にして待ち、次の判断で選び直す
   *   - 開始時の配置の判断（isOpening）だけは、今の残高で買える形から目標を選ぶ（開始時に何も置かないと開始と同時に全滅する）
   * spec = { pool: 形の id の配列, choose(r, list): 1 つ選ぶ, place(view, r, id): 置いて { cells, names } か null }。
   */
  function decideTarget(view, r, st, spec) {
    var cap = view.C === undefined ? Infinity : view.C;
    var pool = spec.pool().filter(function (id) { return P.BY_ID[id].cost <= cap; });
    var bought = function (id) { return affordable(id, view.bank); };
    if (st.target !== null && pool.indexOf(st.target) < 0) st.target = null; // 持ち越した目標が上限を超えたら選び直す
    if (st.target === null) {
      var from = isOpening(view) ? pool.filter(bought) : pool;
      st.target = from.length ? spec.choose(r, from) : null;
    }
    if (st.target === null || !bought(st.target)) return null; // 目標のコストに届くまで待つ（候補が空でも待つ）
    var got = spec.place(view, r, st.target);
    if (got) { st.target = null; return got; }
    var rest = pool.filter(function (id) { return id !== st.target && bought(id); }); // 置き場所が無い目標: 今買える形から選び直す
    st.target = null;
    while (rest.length) {
      var id = spec.choose(r, rest);
      got = spec.place(view, r, id);
      if (got) return got;
      rest = rest.filter(function (x) { return x !== id; });
    }
    return null; // 買えて置ける形が無い: 待ち、次の判断で目標を選び直す
  }

  // ------------------------------------------------------------------ B10 投射型
  /** 生き残っている相手の札（自分から見た札 2〜np）。盤に 1 つもセルが無い（開始時の配置）ときは全員。 */
  function aliveOpponents(view) {
    var all = [], seen = [];
    for (var L = 2; L <= view.np; L++) { all.push(L); if (view.sim.cur.counts[L] > 0) seen.push(L); }
    return seen.length ? seen : all;
  }

  /** 自陣の中心から、札 L の相手の自陣の中心への向き（自分の座標系。2: 左右の隣 +x、3: 上下の隣 +y、4: 対角 +x +y）。 */
  function targetVector(view, L) {
    var vx = (L === 2 || L === 4) ? view.w - view.zoneW : 0, vy = (L === 3 || L === 4) ? view.h - view.zoneH : 0;
    var len = Math.sqrt(vx * vx + vy * vy);
    return { L: L, vx: vx, vy: vy, x: vx / len, y: vy / len };
  }

  /** 形 id を、相手 tv のほうへ進む向きで、自陣の前線側（相手側の端の近く）へ。置けなければ null。 */
  function placeProjector(view, r, id, tv) {
    var eligible = shelfTable().dirs[id].filter(function (d) {
      return d.dir && d.dir.ux * tv.x + d.dir.uy * tv.y > DIR_COS && d.box.w <= view.zoneW && d.box.h <= view.zoneH;
    });
    var xrR = tv.vx > 0 ? [view.zoneW - FRONT_DEPTH, view.zoneW - 1] : null, ybR = tv.vy > 0 ? [view.zoneH - FRONT_DEPTH, view.zoneH - 1] : null;
    var order = shuffled(r, eligible); // 進む向きが相手のほうを向く向きを一様に並べ、置ける向きが見つかるまで試す
    for (var i = 0; i < order.length; i++) {
      var cells = placeIn(view, r, order[i], xrR, ybR, true);
      if (cells) return { cells: cells, names: [id], target: tv.L, orient: order[i].o };
    }
    return null;
  }

  /** 狙う相手を生き残りから一様に選び（置けなければ次の相手）、形 id をその方向へ。 */
  function placeLauncher(view, r, id) {
    var opp = shuffled(r, aliveOpponents(view));
    for (var i = 0; i < opp.length; i++) {
      var got = placeProjector(view, r, id, targetVector(view, opp[i]));
      if (got) return got;
    }
    return null;
  }

  /** 目標の形: 銃（投射する形）は確率 GUN_PROB、それ以外は動く形から一様に。 */
  function chooseLauncher(r, list) {
    var T = shelfTable(), guns = list.filter(function (id) { return T.byId[id].cls === 'projects'; }), movers = list.filter(function (id) { return T.byId[id].cls === 'moves'; });
    if (guns.length && (!movers.length || r() < GUN_PROB)) return pick(r, guns);
    return pick(r, movers);
  }

  // ------------------------------------------------------------------ B9〜B11 の方針
  var TARGETS = {
    B9: { pool: function () { return P.SHELF.filter(function (p) { return p.cells.length <= SMALL_MAX; }).map(function (p) { return p.id; }); }, choose: pick, place: placeTarget },
    B10: { pool: function () { var T = shelfTable(); return T.movers.concat(T.projectors); }, choose: chooseLauncher, place: placeLauncher },
    B11: { pool: function () { return shelfTable().stayers; }, choose: pick, place: placeTarget },
  };

  // ------------------------------------------------------------------ bot
  function isExtra(id) { return EXTRA_IDS.indexOf(id) >= 0; }

  /** B0〜B7 は bots.js へ委ねる（書き換えていない）。B8〜B11 はここの方策。 */
  function makeBot(policy, rngSeed, label) {
    if (!isExtra(policy)) return Bots.makeBot(policy, rngSeed, label);
    // B8 の開始時の配置の判断は必ず置く（decideRandom の isOpening）: 開始時に何も置かないと開始と同時に全滅する（F1）ので、そこで「待つ」を選ぶと「ずっと行動しない」と同じ結果になる。
    // 開始時かどうかは view で判定する（リアルタイム制は gt === 0、ラウンド制は round === 1）。bot を作った時点ではなく、途中で任された最初の判断は開始時ではない（B8 の読み替え。README に記載）
    var r = S.rng(rngSeed >>> 0), st, fn;
    if (policy === 'B8') { st = { waits: 0 }; fn = decideRandom; }
    else { st = { target: null }; fn = function (view, rr, state) { return decideTarget(view, rr, state, TARGETS[policy]); }; }
    return {
      policy: policy, label: label, state: st, // state は検査用（B9〜B11 の持ち越している目標 st.target）
      decide: function (view) {
        var got = fn(view, r, st) || { cells: [], names: [] };
        return { cells: got.cells, names: got.names, cost: got.cells.length, look: null, label: label, target: got.target === undefined ? null : got.target, orient: got.orient === undefined ? null : got.orient };
      },
    };
  }

  /** 画面・ログに出す名前（'B9 小さく頻繁'）。 */
  function displayName(id) { return id + ' ' + String(ALL_NAMES[id] || '').replace(/（.*$/, ''); }

  return {
    EXTRA_IDS: EXTRA_IDS, ALL_IDS: ALL_IDS, ALL_NAMES: ALL_NAMES, isExtra: isExtra, makeBot: makeBot, rngSeedFor: Bots.rngSeedFor,
    isOpening: isOpening, displayName: displayName, shelfTable: shelfTable, describeTable: describeTable, aliveOpponents: aliveOpponents, targetVector: targetVector,
    SMALL_MAX: SMALL_MAX, MAX_WAITS: MAX_WAITS, FRONT_DEPTH: FRONT_DEPTH, GUN_PROB: GUN_PROB, DIR_COS: DIR_COS, TABLE: TABLE,
  };
});
