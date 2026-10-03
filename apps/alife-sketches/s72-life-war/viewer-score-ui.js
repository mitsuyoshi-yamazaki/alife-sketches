/**
 * S-72 run score の画面（viewer-score.html）の振る舞い。ページから切り出した古典スクリプト（ページの末尾で読む）。
 * 規則は scoresession.js（score.js・bots-score.js）が持ち、ここは表示と入力だけ。selftest-score-viewer.js（§26）が最小の DOM の代役の上で動かして検査する。
 */
(function () {
  'use strict';
  var P = window.S72Patterns, Score = window.S72Score, BS = window.S72BotsScore, Extra = window.S72BotsExtra, SS = window.S72ScoreSession;
  var DEF = Score.DEFAULTS;                                   // criteria.score.json system の値（selftest が突き合わせている）
  var COLORS = ['#000', '#5b9bff', '#ff6b6b'];                // 札 1 = 席 0（左）・札 2 = 席 1（右）
  var SEAT_NAMES = ['左', '右'];
  var NEUTRAL_DEFAULT = DEF.w - 2 * DEF.zoneW;                // 中立地帯の既定の幅
  var NEUTRAL_NARROW = Score.NARROW_W - 2 * DEF.zoneW;        // 狭い盤（腕 C2）の中立地帯の幅
  var REGISTERED = BS.GRID_IDS;                               // 登録の 11 体（botGrid の並び）
  var OUTSIDE = Extra.ALL_IDS.filter(function (b) { return REGISTERED.indexOf(b) < 0; });
  var DEFAULT_BOTS = { bot0: 'B2', bot1: 'B3' };
  var PLACED_MARK_TICKS = 15;                                 // 置かれたセルの白い縁を残すティック数
  var FLASH_SECONDS = 0.4, FLASH_MIN_TICKS = 6, FLASH_RING = 2; // 得点が入ったセルの強調: 速さ × 0.4 秒ぶん（少なくとも 6 ティック）・枠は死んだセルから 2 セル外まで
  var LOG_MAX = 120;
  var TAP_SLOP_PX = 10;                                         // 指で押してから離すまでにこれ以上動いたら、タップではなくスクロールとみなす
  /** 規則の欄: [規則の鍵, 入力欄の id, 下限, 上限, 表示名]。システム境界（画面の入力）の検証表。 */
  var FIELDS = [
    ['zoneW', 'zw', 8, 100, '自陣の幅'], ['neutralW', 'nw', 1, 400, '中立地帯の幅'], ['h', 'bh', 24, 300, '盤の高さ'],
    ['D', 'pD', 1, 600, 'D'], ['recoverEvery', 'pRec', 1, 600, '回復の間隔'], ['bankMax', 'pBM', 1, 500, '銀行の上限'], ['bankInit', 'pBI', 1, 500, '初期の銀行'],
    ['L', 'pL', 1, 2000, 'L（総量の上限）'], ['n', 'pN', 1, 100000, 'n（静止の長さ）'], ['maxTicks', 'pT', 60, 100000, '時間上限'],
  ];
  var CKIND_TEXT = { c1: 'まだ設置できる側が残っていた', c2: '両者が設置できなくなった後も、最後の n ティックの間に得点が動いていた', c3: '両者が設置できず静止していたが、n が満ちる前に上限に達した' };
  var NAME_JA = { refuse: '孤立 1 セル', snipe: '狙撃', dispose: '端数の処分' };
  var WHY = { 'delegated': '自陣は bot に任せている（「取り戻す」で置ける）', 'outside-zone': '自陣の外には置けない', 'on-live-cell': '生きたセルの上には置けない', 'already-pending': '既に置いてある', 'not-your-turn': '今は置けない', 'over-bank': '残高を超える', 'unknown-pattern': '不明な形' };
  function $(id) { return document.getElementById(id); }
  var cv = $('board'), ctx = cv.getContext('2d');
  var E = {};
  ['seat', 'bot0', 'bot1', 'seed', 'zw', 'nw', 'bh', 'pD', 'pRec', 'pBM', 'pBI', 'pL', 'pN', 'pT'].forEach(function (id) { E[id] = $(id); });

  var st = { session: null, selId: 'glider', cur: [], drawMode: false, hover: null, paintOp: null, running: false, paused: false,
    marks: [], flashes: [], gainShow: [null, null], tap: null, cellPx: 5, log: [], scoreLog: null, unableLogged: [false, false], rafId: 0, autoTimer: 0, acc: 0, last: 0 };
  function fmt(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }

  // ------------------------------------------------------------------ 設定
  function fillBotSelects() {
    ['bot0', 'bot1'].forEach(function (id) {
      var groups = [['登録の 11 体（botGrid の並び）', REGISTERED], ['登録の外（動くが、走行では測っていない）', OUTSIDE]];
      groups.forEach(function (g) {
        var og = document.createElement('optgroup'); og.label = g[0];
        g[1].forEach(function (b) { var o = document.createElement('option'); o.value = b; o.textContent = BS.displayName(b); og.appendChild(o); });
        E[id].appendChild(og);
      });
      E[id].value = DEFAULT_BOTS[id];
    });
  }
  /** [下限, 上限] の整数だけを通す。 */
  function intOf(el, lo, hi, name) {
    var v = Number(el.value);
    if (el.value === '' || !isFinite(v) || Math.floor(v) !== v || v < lo || v > hi) return { error: name + ' は ' + fmt(lo) + '〜' + fmt(hi) + ' の整数' };
    return { value: v };
  }

  /** 画面の入力 → 対戦の設定。不正なら error を返す（システム境界での検証）。 */
  function parseSettings() {
    var rules = {}, err = null;
    FIELDS.forEach(function (f) { var r = intOf(E[f[1]], f[2], f[3], f[4]); if (r.error) err = err || r.error; else rules[f[0]] = r.value; });
    var seed = intOf(E.seed, 0, 4294967295, 'シード');
    if (seed.error) err = err || seed.error;
    ['bot0', 'bot1'].forEach(function (id) { if (REGISTERED.indexOf(E[id].value) < 0 && OUTSIDE.indexOf(E[id].value) < 0) err = err || 'bot の種類が不明: ' + E[id].value; });
    if (E.seat.value !== 'human' && E.seat.value !== 'spectate') err = err || '操作者が不明: ' + E.seat.value;
    if (err) return { error: err };
    if (rules.bankInit > rules.bankMax) return { error: '初期の銀行は銀行の上限以下でなければならない' };
    if (rules.bankInit > rules.L) return { error: '初期の銀行は総量 L 以下でなければならない' };
    rules.w = Score.boardWidth(rules.zoneW, rules.neutralW);
    delete rules.neutralW;
    // 自陣の席（左）はいつも在り、bot に任せて始めるなら delegate（途中で取り戻せる）
    return { value: { human: 0, delegate: E.seat.value === 'spectate', bots: [E.bot0.value, E.bot1.value], seed: seed.value, rules: rules } };
  }
  function seatName(p) { return SEAT_NAMES[p]; }
  /** 席の操作者の名前。人間が操作している自陣は「あなた」、bot は「B9 小さく頻繁」の形（bot に任せている自陣も bot の名前）。 */
  function who(p) {
    var s = st.session;
    if (p === s.human && !s.delegated()) return 'あなた';
    return BS.displayName(s.labels[p].label);
  }
  function seatLabel(p) { return seatName(p) + '（' + who(p) + '）'; }
  /** 自陣（席 0）を今、bot が操作しているか。 */
  function botSeat() { var s = st.session; return !!s && s.delegated(); }
  /**
   * 自陣の操作者の表示（「いま」の行・ボタン・注記）を、走っている対戦に合わせる。
   * 選択欄（seat・bot0）は**次の対戦の設定だけ**で、ここから書き戻さない（走行中の切り替えが次の対戦・Harness の封筒へ漏れないように）。
   * 走っている対戦を切り替える入口は「bot に任せる／取り戻す」のボタンだけ。
   */
  function refreshOperator() {
    var s = st.session, bar = $('handover'), now = $('opNow'), note = $('opNote');
    if (!s) { bar.classList.add('hide'); now.textContent = 'いま: -'; note.textContent = ''; return; }
    var name = BS.displayName(s.seatBot()), tail = ' 下の「次の対戦の設定」は「新しい対戦」から反映され、走っている対戦は変えない。';
    bar.classList.remove('hide');
    now.textContent = 'いま: ' + (s.isOver() ? '対戦は終了した' : s.delegated() ? 'bot（' + name + '）が操作している' : '人間が操作している');
    bar.textContent = s.delegated() ? '取り戻す' : 'bot に任せる';
    bar.disabled = !(s.canDelegate() || s.canReclaim());
    note.textContent = (s.isOver() ? '' : s.delegated() ? 'bot が ' + s.game.cfg.D + ' ティックごとに判断する。人間は置けない。「取り戻す」で自分で置ける。'
      : 'いつでも「bot に任せる」でこの対戦の bot（' + name + '）に渡せる（予約中の配置は捨てる）。') + tail;
    $('turnTitle').textContent = s.delegated() ? '自陣は bot に任せ中（置けない）' : 'あなたの配置（リアルタイム）';
  }

  /** 自陣を bot に任せる／取り戻す（開始前・走行中）。入口は「bot に任せる／取り戻す」のボタンだけ。 */
  function applyOperator(toBot) {
    var s = st.session;
    if (!s) return;
    clearTimeout(st.autoTimer); // 前の自動開始の予約は、操作者が変わったら取り消す（発火時の操作者で開始してしまわないように）
    var when = s.isOpening() ? '開始前' : 't=' + s.game.gt, r;
    if (toBot) {
      r = s.delegate();
      if (!r.ok) { refresh(); return; }
      logLine(when + ' 自陣を bot（' + BS.displayName(s.seatBot()) + '）に任せた' + (r.dropped ? '。予約していた配置 ' + r.dropped + ' セルは捨てた' : ''));
    } else {
      r = s.reclaim();
      if (!r.ok) { refresh(); return; }
      logLine(when + ' 自陣を取り戻した（以後は人間が置ける）');
    }
    st.hover = null; say(''); buildLegend(); refresh();
    if (toBot && s.isOpening() && $('auto').checked) scheduleAutoStart();
  }
  /** 自陣が bot のときの自動開始（開始前だけ）。発火時にもう一度、bot が操作していて一時停止でないことを確かめる。 */
  function scheduleAutoStart() {
    clearTimeout(st.autoTimer);
    st.autoTimer = setTimeout(function () { if (botSeat() && !st.paused) startOpening(); }, 50);
  }

  // ------------------------------------------------------------------ 対戦の開始
  function cfgError(m) { Harness.say(m, true); $('cfgMsg').textContent = '設定が不正: ' + m; }

  function newGame() {
    var parsed = parseSettings(), session = null;
    // 設定が不正なら（作れなければ）、走っている対戦は止めずにそのまま残す
    if (parsed.error) { cfgError(parsed.error); return false; }
    try { session = SS.create(parsed.value); } catch (e) { cfgError(e.message); return false; }
    $('cfgMsg').textContent = '';
    stopLoop();
    st.session = session;
    st.paused = false; $('pause').textContent = '一時停止';
    st.marks = []; st.flashes = []; st.gainShow = [null, null]; st.log = []; st.scoreLog = null; st.unableLogged = [false, false]; st.hover = null;
    st.cellPx = Math.max(2, Math.floor(1000 / session.game.cfg.w));
    cv.width = session.game.cfg.w * st.cellPx; cv.height = session.game.cfg.h * st.cellPx;
    var c = session.game.cfg;
    logLine('対戦を始めた: 得点制・自陣（左）は' + (botSeat() ? 'bot（' + BS.displayName(session.seatBot()) + '）が操作' : '人間が操作') + '・右は ' + BS.displayName(session.labels[1].label) +
      '・シード ' + parsed.value.seed + '・盤 ' + c.w + '×' + c.h + '（自陣 ' + c.zoneW + ' 列・中立地帯 ' + (c.w - 2 * c.zoneW) + ' 列）');
    buildLegend(); setPattern(st.selId); fillRuleNote(); refresh();
    // パラメータの読み込み後は Harness が一時停止にする（2026-09-15 ユーザ規則）。自動開始はその停止を上書きしない
    if (botSeat() && $('auto').checked) scheduleAutoStart();
    return true;
  }
  function fillRuleNote() {
    var c = st.session.game.cfg;
    $('ruleNote').textContent = 'この対戦の規則: 総量 L = ' + fmt(c.L) + '（初期の銀行 ' + c.bankInit + ' を含む。回復が銀行へ入るたびに数え、届くと回復は止まる）・' +
      '静止 n = ' + fmt(c.n) + '・時間上限 ' + fmt(c.maxTicks) + '・銀行は ' + c.recoverEvery + ' ティックごとに 1 回復（上限 ' + c.bankMax + '）・bot の判断 D = ' + c.D + '。' +
      '「設置できない」= 総量が L に届き、かつ銀行 0。終了条件 (b) は両者がそうなった後に数え始め、得点が動くと数え直す。';
  }
  function buildLegend() {
    var h = '';
    for (var p = 0; p < 2; p++) h += '<span><span class="sw" style="background:' + COLORS[p + 1] + '"></span>' + seatLabel(p) + '</span>';
    h += '<span>薄い帯 = 自陣</span><span>白い縁 = 置かれたセル</span><span>塗り + 枠 = 得点が入ったセル（得点を得た側の色）</span>';
    $('legend').innerHTML = h;
  }

  // ------------------------------------------------------------------ 形の棚と向き
  function norm(cells) {
    var mx = Infinity, my = Infinity;
    cells.forEach(function (c) { if (c[0] < mx) mx = c[0]; if (c[1] < my) my = c[1]; });
    return cells.map(function (c) { return [c[0] - mx, c[1] - my]; });
  }
  function rot90(cells) { return norm(cells.map(function (c) { return [-c[1], c[0]]; })); }
  function mirror(cells) { return norm(cells.map(function (c) { return [-c[0], c[1]]; })); }
  function setPattern(id) {
    st.selId = id; st.cur = P.orient(P.BY_ID[id].cells, 0);
    [].forEach.call($('shelf').children, function (b) { b.classList.toggle('sel', b.getAttribute('data-id') === id); });
    updateCosts();
  }

  function buildShelf() {
    var shelf = $('shelf');
    P.SHELF.forEach(function (p) {
      var b = document.createElement('button'), c = document.createElement('canvas');
      b.setAttribute('data-id', p.id); b.title = p.name + '（コスト ' + p.cost + '）';
      var bb = P.bbox(p.cells), k = Math.max(1, Math.min(Math.floor(44 / bb.w), Math.floor(30 / bb.h), 6));
      c.width = 44; c.height = 30;
      var x = c.getContext('2d'); x.fillStyle = '#d8dee9';
      p.cells.forEach(function (q) { x.fillRect(Math.floor((44 - bb.w * k) / 2) + (q[0] - bb.x0) * k, Math.floor((30 - bb.h * k) / 2) + (q[1] - bb.y0) * k, k, k); });
      var t = document.createElement('span'); t.textContent = p.name.replace('Gosper glider gun', '銃') + ' ' + p.cost;
      b.appendChild(c); b.appendChild(t);
      b.onclick = function () { st.drawMode = false; setMode(); setPattern(p.id); };
      shelf.appendChild(b);
    });
  }
  function setMode() {
    $('modePat').classList.toggle('sel', !st.drawMode); $('modeDraw').classList.toggle('sel', st.drawMode);
    cv.style.touchAction = st.drawMode ? 'none' : 'manipulation';
    updateCosts();
  }

  // ------------------------------------------------------------------ 置く
  /** 今、人間が置けるか。開始時の配置・走行中・一時停止中のいつでも（自陣を bot に任せている間と終局後は置けない）。 */
  function humanTurn() { return !!st.session && st.session.canPlace(); }
  function say(m, bad) { var e = $('msg'); e.textContent = m || ''; e.style.color = bad ? 'var(--bad)' : 'var(--warn)'; }
  function report(r, okText) {
    if (r.ok) { say(okText || ''); return; }
    say('置けない: ' + (WHY[r.reason] || r.reason) + (r.reason === 'over-bank' ? '（' + r.cost + ' > ' + r.bank + '）' : ''), true);
  }
  function cellFromEvent(ev) {
    var r = cv.getBoundingClientRect(), g = st.session.game.cfg;
    var x = Math.floor((ev.clientX - r.left) * (cv.width / r.width) / st.cellPx), y = Math.floor((ev.clientY - r.top) * (cv.height / r.height) / st.cellPx);
    return (x < 0 || y < 0 || x >= g.w || y >= g.h) ? null : [x, y];
  }
  function stampAt(h) {
    var bb = P.bbox(st.cur), ox = h[0] - Math.floor(bb.w / 2), oy = h[1] - Math.floor(bb.h / 2);
    return st.cur.map(function (c) { return [ox + c[0], oy + c[1]]; });
  }

  function stampHere(s, h) { report(s.addCells(stampAt(h)), s.isOpening() ? '置いた' : '予約した（次のティックの境目に適用）'); }
  function onDown(ev) {
    if (ev.button !== 0) return; // 主ボタン（指・ペンの接触を含む）だけ。右・中クリックでは置かない
    var s = st.session;
    if (s && s.delegated() && !s.isOver()) { say('自陣は bot に任せている。置くには「取り戻す」を押す', true); return; }
    if (!s || !humanTurn()) return;
    var h = cellFromEvent(ev); if (!h) return;
    st.hover = h;
    if (!st.drawMode && ev.pointerType === 'touch') {
      // 指でのパターンは離したときに確定する。スワイプ（盤の上からのスクロール）では置かない——動けば pointercancel か、離した位置のずれで捨てる
      st.tap = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, cell: h, session: s };
      draw(); return;
    }
    ev.preventDefault();
    if (st.drawMode) {
      var had = s.pending().some(function (c) { return c[0] === h[0] && c[1] === h[1]; });
      st.paintOp = had ? 'erase' : 'add'; paint(h);
      try { cv.setPointerCapture(ev.pointerId); } catch (e) { /* 捕捉できなくても描画は続けられる */ }
    } else {
      stampHere(s, h);
    }
    updateCosts(); draw();
  }
  function paint(h) {
    var pend = st.session.pending().some(function (c) { return c[0] === h[0] && c[1] === h[1]; });
    if (st.paintOp === 'erase' && pend) st.session.toggle(h[0], h[1]);
    else if (st.paintOp === 'add' && !pend) report(st.session.toggle(h[0], h[1]), '');
  }
  /** 2 つのセルの間を直線で結ぶセル列（両端を含む）。速くドラッグしても飛ばさずに描くため。 */
  function lineCells(a, b) {
    var n = Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])), out = [];
    for (var i = 0; i <= n; i++) out.push(n === 0 ? [a[0], a[1]] : [Math.round(a[0] + (b[0] - a[0]) * i / n), Math.round(a[1] + (b[1] - a[1]) * i / n)]);
    return out;
  }
  function onMove(ev) {
    if (!st.session) return;
    var prev = st.hover;
    st.hover = cellFromEvent(ev);
    if (st.paintOp && st.hover && humanTurn()) { lineCells(prev || st.hover, st.hover).forEach(paint); updateCosts(); }
    draw();
  }
  function onUp(ev) {
    st.paintOp = null;
    var t = st.tap; st.tap = null;
    if (!t || !ev || ev.type !== 'pointerup' || ev.pointerId !== t.id || t.session !== st.session) return;
    if (Math.abs(ev.clientX - t.x) > TAP_SLOP_PX || Math.abs(ev.clientY - t.y) > TAP_SLOP_PX) return;
    if (!humanTurn()) return;
    stampHere(t.session, t.cell); updateCosts(); draw();
  }

  // ------------------------------------------------------------------ 進行
  function stopLoop() { st.running = false; cancelAnimationFrame(st.rafId); clearTimeout(st.autoTimer); }
  function addMarks(placed, until) {
    placed.forEach(function (cells, seat) { cells.forEach(function (c) { st.marks.push([c[0], c[1], seat, until]); }); });
    st.marks = st.marks.filter(function (m) { return m[3] > st.session.game.gt; });
  }
  function describe(reveal) {
    return reveal.map(function (r) {
      var n = r.placed ? r.placed.length : 0, what = r.who === 'human' ? '' : r.names.map(function (x) { return NAME_JA[x] || x; }).join('+') + ' ';
      return seatName(r.seat) + '（' + (r.who === 'human' ? 'あなた' : BS.displayName(r.who)) + '）: ' + (n ? what + n + ' セル' : '置かなかった');
    }).join(' ／ ');
  }
  /** 得点が入ったティック: 過密死で得点を生んだセルを、得点を得た側の色で一瞬強調する（events は advance ごとに作り直される）。 */
  function noteScoring(r) {
    if (r.gains[0] + r.gains[1] === 0) return;
    var gt = st.session.game.gt, life = Math.max(FLASH_MIN_TICKS, Math.round(Number($('speed').value) * FLASH_SECONDS));
    st.flashes = st.flashes.filter(function (f) { return f.until > gt; });
    r.events.forEach(function (e) {
      [0, 1].forEach(function (p) { if (e.gain[p] > 0) st.flashes.push({ x: e.x, y: e.y, seat: p, gt: gt, until: gt + life, life: life }); });
    });
    [0, 1].forEach(function (p) {
      if (r.gains[p] <= 0) return;
      var prev = st.gainShow[p], base = prev && prev.until > gt ? prev.n : 0; // 表示中の「+n」に足す（1 フレームに数ティック進むと、最後のティックだけが残っていた）
      st.gainShow[p] = { n: base + r.gains[p], gt: gt, until: gt + life };
    });
    logScore(gt, r.gains);
  }
  /** 続けて入った得点は 1 行にまとめる（出来事の行が流れないように）。 */
  function logScore(gt, gains) {
    var cur = st.scoreLog, last = st.log.length - 1, merge = !!cur && last >= 0 && st.log[last] === cur.text;
    if (merge) { cur.t1 = gt; cur.g = [cur.g[0] + gains[0], cur.g[1] + gains[1]]; cur.n += 1; }
    else cur = st.scoreLog = { t0: gt, t1: gt, g: gains.slice(), n: 1, text: '' };
    cur.text = (cur.t0 === cur.t1 ? 't=' + cur.t0 : 't=' + cur.t0 + '〜' + cur.t1) + ' 得点 ' + seatName(0) + ' +' + cur.g[0] + '・' + seatName(1) + ' +' + cur.g[1] + (cur.n > 1 ? '（' + cur.n + ' ティック）' : '');
    if (merge) { st.log[last] = cur.text; renderLog(); } else logLine(cur.text);
  }
  function noteUnable() {
    var g = st.session.game;
    [0, 1].forEach(function (p) {
      var t = g.players[p].unableGt;
      if (t !== null && !st.unableLogged[p]) { st.unableLogged[p] = true; logLine('t=' + t + ' ' + seatLabel(p) + ' は設置できなくなった（総量 L を使い切り、銀行 0）'); }
    });
  }
  /** 開始時の配置を確定して時間を動かす。ここで初めて bot の手が公開される。 */
  function startOpening() {
    var s = st.session;
    if (!s || st.running || !s.isOpening()) return;
    // 人間が操作している席の開始時の配置が空なら開始しない（ボタンの無効化だけに頼らず、どの経路でもここで止める）
    if (!s.canStart()) { say('最初の種を 1 セル以上置いてから開始する（空では開始できない）', true); return; }
    var reveal;
    try { reveal = s.start(); } catch (e) { failRun(e); return; }
    addMarks(reveal.map(function (r) { return r.placed || []; }), s.game.gt + PLACED_MARK_TICKS);
    logLine('開始時の配置 — ' + describe(reveal));
    noteUnable(); say('');
    st.running = true;
    if (s.isOver()) { endGame(); return; }
    loop(); refresh();
  }

  /** n ティック進める。終局か、これ以上進められなければ true。 */
  function stepTicks(n) {
    var s = st.session, g = s.game;
    for (var i = 0; i < n; i++) {
      var r = s.advance();
      if (!r.ticked) return true;
      noteScoring(r);
      if (r.placed) addMarks(r.placed, g.gt + PLACED_MARK_TICKS);
      if (r.reveal) {
        var line = describe(r.reveal.filter(function (x) { return x.who !== 'human' && x.placed && x.placed.length; }));
        if (line) logLine('t=' + g.gt + ' ' + line);
      }
      if (r.dropped) logLine('t=' + g.gt + ' 予約していた配置 ' + r.dropped + ' セルは、終局の境目だったため適用せずに捨てた');
      r.rejects.forEach(function (j) { if (j[1] === s.human && !s.delegated()) logLine('t=' + g.gt + ' あなたの配置を却下/一部無効: ' + (j[2] === 'over-bank' ? '残高超過' : '適用の時点で生きたセル・自陣の外のセルを除いた') + '（依頼 ' + j[3] + ' セル）'); });
      noteUnable();
      if (r.done) return true;
    }
    return false;
  }
  /** 進行中の例外（bot の不具合など）は握りつぶさず、止めて画面に出す。 */
  function failRun(e) {
    stopLoop();
    logLine('対戦の進行中にエラー: ' + e.message);
    $('banner').className = 'banner over'; $('banner').textContent = '対戦の進行中にエラー: ' + e.message;
    refresh();
  }
  function advanceFrame(n) {
    try { return stepTicks(n); } catch (e) { failRun(e); return false; }
  }

  /** 速さ（ティック/秒）で進める。一時停止中は進めない。 */
  function loop() {
    cancelAnimationFrame(st.rafId);
    st.last = performance.now(); st.acc = 0;
    st.rafId = requestAnimationFrame(function frame(now) {
      if (!st.running) return;
      var dt = Math.min(250, now - st.last); st.last = now;
      if (!st.paused) {
        st.acc += dt * Number($('speed').value) / 1000;
        var n = Math.floor(st.acc); st.acc -= n;
        if (n > 0) {
          var done = advanceFrame(n);
          if (!st.running) return;
          refresh();
          if (done) { endGame(); return; }
        }
      }
      st.rafId = requestAnimationFrame(frame);
    });
  }
  function endGame() {
    var s = st.session;
    st.running = false;
    // 終局では、最後のティックに入った得点の強調だけを残す（古い強調が止まった盤に居座らないように）
    st.flashes = st.flashes.filter(function (f) { return f.gt === s.game.gt; });
    st.gainShow = st.gainShow.map(function (g) { return g && g.gt === s.game.gt ? g : null; });
    noteUnable();
    logLine('終局: ' + resultText(s.info().result));
    refresh();
  }

  // ------------------------------------------------------------------ 表示
  function renderLog() { var el = $('log'); el.textContent = st.log.join('\n'); el.scrollTop = el.scrollHeight; }
  function logLine(t) {
    st.log.push(t); if (st.log.length > LOG_MAX) st.log.shift();
    renderLog();
  }
  /** 終了の理由と勝敗（(a) はどちらが 0 か、(c) は 3 つの内訳）。 */
  function resultText(r) {
    if (!r) return '';
    var sc = r.scores[0] + ' 対 ' + r.scores[1];
    var head = r.code === 'D' ? '引き分け（' + sc + '）' : '勝者: ' + seatLabel(r.winner) + '（' + sc + '）';
    var why = r.reason === 'a' ? '(a) 総セル数 0（' + r.aSeats.map(seatName).join('・') + '。勝敗は得点で決まる）'
      : r.reason === 'b' ? '(b) 静止（両者が設置できず、得点が n ティック動かなかった）'
      : '(c) 時間上限（' + (CKIND_TEXT[r.cKind] || '') + '）';
    return head + ' — 終わり方: ' + why + '（第 ' + fmt(r.gt) + ' ティック）';
  }
  function updateCosts() {
    var s = st.session; if (!s) return;
    var bank = s.bank(), cost = s.cost(), pc = st.drawMode ? 1 : st.cur.length;
    Harness.num('bank', bank, 4); Harness.num('cost', cost, 4); Harness.num('left', bank - cost, 4); Harness.num('patCost', pc, 4);
    [].forEach.call($('shelf').children, function (b) {
      b.classList.toggle('dim', s.canPlace() && P.BY_ID[b.getAttribute('data-id')].cost > bank - cost);
    });
    updateGo(s);
  }
  /** 「開始」の札と押せるか。待ち行列の増減のたびに呼ぶ（人間が操作する席は最初の種が 1 セル以上要る。F12）。 */
  function updateGo(s) {
    $('go').textContent = s.delegated() ? '開始（自陣の最初の配置は bot が置く）' : '開始（最初の配置を置き終えた）';
    $('go').disabled = !s.isOpening() || !s.canStart();
    $('go').title = s.isOpening() && !s.canStart() ? '最初の種を 1 セル以上置く（空では開始できない）' : '最初の配置を置き終えた。相手の手が公開されて時間が動き出す';
  }
  /** 席ごとの得点・セル数・銀行・残りの総量・設置の状態（両者の得点を大きく）。 */
  function renderSides(info, s) {
    var g = s.game, gt = g.gt;
    for (var p = 0; p < 2; p++) {
      var pl = info.players[p], show = st.gainShow[p], win = info.result && info.result.winner === p;
      $('nm' + p).textContent = seatLabel(p);
      $('sc' + p).textContent = info.scores[p];
      $('gn' + p).textContent = show && show.until > gt ? '+' + show.n : '';
      $('ct' + p).textContent = info.counts[p];
      $('bk' + p).textContent = pl.bank + ' / ' + info.bankMax + (pl.bank >= info.bankMax && pl.remaining > 0 ? '（満杯）' : '');
      $('rm' + p).textContent = pl.remaining + ' / ' + info.L;
      $('un' + p).textContent = pl.unable ? '置けない（t=' + pl.unableGt + '）' : '置ける';
      $('side' + p).classList.toggle('win', !!win);
    }
  }
  /** 経過ティックと上限・終了条件 (b) の進み具合・終了の理由と勝敗。 */
  function renderProgress(info) {
    var b = info.progressB, over = info.phase === 'done';
    $('tkTxt').textContent = fmt(info.gt) + ' / ' + fmt(info.maxTicks);
    $('tkGauge').style.width = Math.min(100, Math.round(100 * info.gt / info.maxTicks)) + '%';
    if (b.bothUnable) {
      $('bTxt').textContent = '静止 ' + fmt(b.since) + ' / ' + fmt(b.n) + ' ティック（得点が動くと戻る）';
      $('bGauge').style.width = Math.min(100, Math.round(100 * b.since / b.n)) + '%';
    } else {
      $('bTxt').textContent = '数え始め前（置けない: ' + seatName(0) + ' ' + (b.unable[0] ? 'はい' : 'いいえ') + '・' + seatName(1) + ' ' + (b.unable[1] ? 'はい' : 'いいえ') + '）';
      $('bGauge').style.width = '0%';
    }
    $('resultLine').textContent = over ? '終局 — ' + resultText(info.result) : '';
  }
  function renderStatus(info, s) {
    var b = info.progressB, over = info.phase === 'done', opening = info.phase === 'opening';
    $('stRec').textContent = opening || over ? '-' : info.nextRecoverIn + ' ティック';
    $('stBot').textContent = opening ? '（開始時に判断）' : over ? '-' : info.nextBotIn + ' ティック（D=' + info.D + '）';
    $('stContact').textContent = info.firstContact === null ? 'まだ' : info.firstContact;
    $('stTs').textContent = b.Ts > 0 ? b.Ts : 'まだ';
    $('stTu').textContent = b.Tu === null ? 'まだ' : b.Tu;
  }
  function banner(info, s) {
    var b = $('banner');
    if (s.isOver()) { b.className = 'banner over'; b.textContent = '終局 — ' + resultText(info.result); }
    else if (s.isOpening()) {
      b.className = 'banner turn';
      b.textContent = s.canPlace()
        ? '開始時の配置: 盤は止まっている。自陣（薄い帯）の死んだセルへ、銀行 ' + s.bank() + ' までで最初の種を置く（相手の手はまだ見えない）。置き終えたら「開始」。' +
          '得点は相手のセルを過密で殺したときだけ入る。総量は ' + fmt(info.L) + '（初期の銀行を含む）なので、使いどころを選ぶ。'
        : '自陣は bot（' + who(0) + '）が操作する: 「開始」で全員の最初の配置が同時に公開されて時間が動き出す（「取り戻す」で自分で置ける）。';
    } else if (st.paused) { b.className = 'banner turn'; b.textContent = '一時停止中（t = ' + info.gt + '）。' + (s.delegated() ? '自陣は bot に任せている。' : '置いた分は再開後の最初のティックの境目に適用される。'); }
    else if (s.delegated()) { b.className = 'banner turn'; b.textContent = 'リアルタイム進行中（t = ' + info.gt + ' / ' + fmt(info.maxTicks) + '）。自陣は bot（' + who(0) + '）に任せている。「取り戻す」で自分で置ける。'; }
    else { b.className = 'banner turn'; b.textContent = 'リアルタイム進行中（t = ' + info.gt + ' / ' + fmt(info.maxTicks) + '）。クリックで置いた分は次のティックの境目に適用される。'; }
  }
  function refresh() {
    var s = st.session; if (!s) return;
    var info = s.info();
    renderSides(info, s); renderProgress(info); renderStatus(info, s); banner(info, s);
    $('step').disabled = !(st.running && st.paused && !s.isOver());
    $('pause').disabled = s.isOver(); // 終局後は止めるものが無い
    ['undo', 'clear', 'rot', 'flip'].forEach(function (id) { $(id).disabled = !humanTurn(); });
    refreshOperator();
    updateCosts(); draw();
  }
  function zoneBands() {
    var g = st.session.game, cp = st.cellPx;
    for (var p = 0; p < 2; p++) {
      var z = g.zones[p], mine = p === st.session.human;
      ctx.fillStyle = hexA(COLORS[p + 1], mine ? 0.16 : 0.07);
      ctx.fillRect(z.x0 * cp, z.y0 * cp, (z.x1 - z.x0 + 1) * cp, (z.y1 - z.y0 + 1) * cp);
      if (mine) { ctx.strokeStyle = hexA(COLORS[p + 1], 0.55); ctx.lineWidth = 1; ctx.strokeRect(z.x0 * cp + 0.5, z.y0 * cp + 0.5, (z.x1 - z.x0 + 1) * cp - 1, (z.y1 - z.y0 + 1) * cp - 1); }
    }
  }
  function hexA(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  /** 得点が入ったセル: 過密で死んだセルの位置を、得点を得た側の色で塗り、5×5 の枠で囲む（時間とともに薄れる）。 */
  function drawFlashes(cp, gt) {
    st.flashes.forEach(function (f) {
      if (f.until <= gt) return;
      var a = Math.min(1, (f.until - gt) / f.life), col = COLORS[f.seat + 1];
      ctx.fillStyle = hexA(col, 0.4 + 0.6 * a); ctx.fillRect(f.x * cp, f.y * cp, cp, cp);
      ctx.lineWidth = 2; ctx.strokeStyle = hexA(col, a); ctx.strokeRect((f.x - FLASH_RING) * cp, (f.y - FLASH_RING) * cp, (2 * FLASH_RING + 1) * cp, (2 * FLASH_RING + 1) * cp);
      ctx.lineWidth = 1; ctx.strokeStyle = hexA('#ffffff', 0.85 * a); ctx.strokeRect(f.x * cp - 0.5, f.y * cp - 0.5, cp + 1, cp + 1);
    });
  }

  function draw() {
    var s = st.session; if (!s) return;
    var g = s.game, cp = st.cellPx, L = g.sims[0].cur, sw = g.sims[0].sw;
    ctx.fillStyle = '#05070b'; ctx.fillRect(0, 0, cv.width, cv.height);
    zoneBands();
    for (var y = L.yMin; y <= L.yMax; y++) {
      if (L.rowMax[y] < 0) continue;
      var base = (y + 1) * sw + 1;
      for (var x = L.rowMin[y]; x <= L.rowMax[y]; x++) {
        var t = L.tag[base + x];
        if (t) { ctx.fillStyle = COLORS[t]; ctx.fillRect(x * cp, y * cp, cp - (cp > 3 ? 1 : 0), cp - (cp > 3 ? 1 : 0)); }
      }
    }
    ctx.lineWidth = 1; ctx.strokeStyle = '#ffffff';
    st.marks.forEach(function (m) { if (m[3] > g.gt) ctx.strokeRect(m[0] * cp - 0.5, m[1] * cp - 0.5, cp + 1, cp + 1); });
    drawFlashes(cp, g.gt);
    drawPending(cp);
  }
  function drawPending(cp) {
    var s = st.session; if (!humanTurn()) return;
    ctx.fillStyle = hexA(COLORS[s.human + 1], 0.55);
    s.pending().forEach(function (c) { ctx.fillRect(c[0] * cp, c[1] * cp, cp, cp); });
    if (!st.hover) return;
    var cells = st.drawMode ? [st.hover] : stampAt(st.hover), r = s.test(cells);
    ctx.fillStyle = r.ok ? 'rgba(74,222,128,0.5)' : 'rgba(255,107,107,0.45)';
    cells.forEach(function (c) { ctx.fillRect(c[0] * cp, c[1] * cp, cp, cp); });
  }

  // ------------------------------------------------------------------ 規則の既定値・広さ・パラメータ
  /** 規則の数値を既定（criteria.score.json system = Score.DEFAULTS）へ戻す。操作者・bot・シードは触らない。 */
  function applyDefaults() {
    E.zw.value = DEF.zoneW; E.nw.value = NEUTRAL_DEFAULT; E.bh.value = DEF.h;
    E.pD.value = DEF.D; E.pRec.value = DEF.recoverEvery; E.pBM.value = DEF.bankMax; E.pBI.value = DEF.bankInit;
    E.pL.value = DEF.L; E.pN.value = DEF.n; E.pT.value = DEF.maxTicks;
  }
  /** 説明文の既定値（data-def）を Score.DEFAULTS から埋める（本文に数値を二重に書かない）。 */
  function fillDefs() {
    [].forEach.call(document.querySelectorAll('[data-def]'), function (el) { el.textContent = fmt(DEF[el.getAttribute('data-def')]); });
    $('rulesNote').textContent = '既定値は criteria.score.json の system（盤 ' + DEF.w + '×' + DEF.h + '・自陣 ' + DEF.zoneW + ' 列・中立地帯 ' + NEUTRAL_DEFAULT + ' 列・初期の銀行 ' + DEF.bankInit +
      '・回復 ' + DEF.recoverEvery + ' ティックごとに 1・上限 ' + DEF.bankMax + '・D=' + DEF.D + '・L=' + DEF.L + '・n=' + DEF.n + '・時間上限 ' + fmt(DEF.maxTicks) + '）。' +
      '「狭い盤」は中立地帯 ' + NEUTRAL_NARROW + ' 列（腕 C2。盤 ' + Score.NARROW_W + '×' + DEF.h + '）。bot は盤と自分の残高・得点・総量だけを見る（あなたの待ち行列は見えない）。';
  }
  function resize(scale) {
    E.nw.value = Math.max(1, Math.round(NEUTRAL_DEFAULT * scale));
    E.bh.value = Math.max(24, Math.round(DEF.h * scale));
    if (newGame()) Harness.say('中立地帯 ' + E.nw.value + ' 列・高さ ' + E.bh.value + ' にして新しい対戦を始めた');
  }

  // ------------------------------------------------------------------ 配線
  applyDefaults(); fillBotSelects(); fillDefs(); buildShelf();
  cv.addEventListener('pointerdown', onDown); cv.addEventListener('pointermove', onMove);
  cv.addEventListener('pointerup', onUp); cv.addEventListener('pointercancel', onUp);
  cv.addEventListener('pointerleave', function () { st.hover = null; st.paintOp = null; st.tap = null; draw(); });
  $('modePat').onclick = function () { st.drawMode = false; setMode(); draw(); };
  $('modeDraw').onclick = function () { st.drawMode = true; setMode(); draw(); };
  $('rot').onclick = function () { st.cur = rot90(st.cur); draw(); };
  $('flip').onclick = function () { st.cur = mirror(st.cur); draw(); };
  $('undo').onclick = function () { if (st.session) { st.session.removeLast(); say(''); refresh(); } };
  $('clear').onclick = function () { if (st.session) { st.session.clearPending(); say(''); refresh(); } };
  $('go').onclick = function () { st.paused = false; $('pause').textContent = '一時停止'; startOpening(); };
  $('pause').onclick = function () {
    st.paused = !st.paused; $('pause').textContent = st.paused ? '再開' : '一時停止';
    // 観戦の開始時の配置で止まっていたなら、再開で走り出す
    if (!st.paused && !st.running && st.session && st.session.isOpening() && botSeat()) startOpening();
    refresh();
  };
  $('step').onclick = function () { if (st.running && st.paused) { var done = advanceFrame(1); if (!st.running) return; refresh(); if (done) endGame(); } };
  $('speed').oninput = function () { Harness.num('speedOut', $('speed').value, 3); };
  $('newgame').onclick = newGame;
  $('again').onclick = newGame;
  $('seedUp').onclick = function () { E.seed.value = Number(E.seed.value) + 1; newGame(); };
  $('narrow').onclick = function () { E.zw.value = DEF.zoneW; E.nw.value = NEUTRAL_NARROW; };
  $('reset').onclick = function () { applyDefaults(); };
  // 選択欄（操作者・bot の種類）は次の対戦の設定だけ。走っている対戦には作用しない（Harness の復元が発火する合成の change も含む）。切り替えはボタンだけ
  E.seat.onchange = function () { refreshOperator(); };
  $('handover').onclick = function () { var s = st.session; if (s) applyOperator(!s.delegated()); };
  document.addEventListener('keydown', function (ev) {
    if (/INPUT|SELECT|TEXTAREA/.test(ev.target.tagName)) return;
    if (ev.key === 'r') { st.cur = rot90(st.cur); draw(); } else if (ev.key === 'f') { st.cur = mirror(st.cur); draw(); }
    else if (ev.key === 'z' && st.session) { st.session.removeLast(); refresh(); }
  });

  Harness.mount({
    id: 'S-72', run: 'score', version: '1.0.0',
    inputs: ['seat', 'bot0', 'bot1', 'seed', 'zw', 'nw', 'bh', 'pD', 'pRec', 'pBM', 'pBI', 'pL', 'pN', 'pT'],
    canvases: ['board'],
    resize: resize,
    pause: function () { st.paused = true; $('pause').textContent = '再開'; refresh(); },
    onRestore: function () { newGame(); },
    paramNames: {
      seat: { category: 's', code: 'seat', full: 'seat' },
      bot0: { category: 's', code: 'b0', full: 'bot_left' }, bot1: { category: 's', code: 'b1', full: 'bot_right' },
      seed: { category: 's', code: 'seed', full: 'seed' },
      zw: { category: 's', code: 'zw', full: 'zone_w' }, nw: { category: 's', code: 'nw', full: 'neutral_w' }, bh: { category: 's', code: 'h', full: 'board_h' },
      pD: { category: 'p', code: 'D', full: 'bot_interval' }, pRec: { category: 'p', code: 'rec', full: 'recover_every' }, pBM: { category: 'p', code: 'bmax', full: 'bank_max' },
      pBI: { category: 'p', code: 'binit', full: 'bank_init' }, pL: { category: 'p', code: 'L', full: 'total_limit' }, pN: { category: 'p', code: 'n', full: 'still_ticks' },
      pT: { category: 'p', code: 'ticks', full: 'max_ticks' },
    },
  });
  if (!st.session) newGame();
  setMode();
})();
