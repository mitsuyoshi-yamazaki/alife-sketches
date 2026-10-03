/**
 * S-72 v1.1.0 リアルタイム制の対戦の進行（viewer の下の、画面を持たない部分）。人間 1 人 対 bot（または観戦）を、
 * ヘッドレスの playMatch と**同じエンジン（realtime.js）**の上で進める。ラウンド制の session.js と並ぶもので、書き換えていない。
 *
 * 流れ:
 *   create → 開始時の配置（盤は止まる。人間は積んで start() を押す）→ advance() を一定の間隔で呼ぶ（1 回 = 1 ティック）。
 *   人間の配置は待ち行列（pending）に積まれ、**次のティックの境目**に bot の手と同時に適用される（advance の中）。
 *   一時停止中も積める（適用は再開後の最初の境目）。置けるかの検査はクリック時の盤で行うが、適用の時点の盤で再び判定される（エンジンが正）。
 *
 * 同時手番の扱い（F10 と同じ規律）: bot の手は人間が置き終えるまで（開始時）・その境目まで（走行中）、session のどこにも無い。
 * bot は盤と自分の残高だけを見る（人間の待ち行列は見えない）。
 *
 * 自陣の操作者（v1.1.1）: 人間の席（席 0 = 左／左上）には、対戦の開始時から bot が作ってある（その席のシードで。人間が操作している間は呼ばれず、乱数も進まない）。
 * 人間は対戦の途中で「bot に任せる（delegate）／取り戻す（reclaim）」を切り替えられる。任せている間、その席は他の bot と同じに D ティックごとに
 * 判断し、人間は置けない（待ち行列は任せた時点で捨てる）。切り替えの時刻（advance を呼んだ回数 = game.gt）が同じなら同じ試合になる。
 *
 * 人間の試合は標本にしない。このファイルは生ログを書かない。
 *
 * 依存ゼロ・古典スクリプト。Node とブラウザで共用（Node: `require('./rtsession.js')` / ブラウザ: `window.S72RTSession`）。
 */
(function (root, factory) {
  var api = factory(
    typeof require === 'function' ? require('./patterns.js') : root.S72Patterns,
    typeof require === 'function' ? require('./realtime.js') : root.S72RT
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S72RTSession = api;
})(typeof self !== 'undefined' ? self : this, function (P, RT) {
  'use strict';

  /**
   * opts: { mode: '2p'|'4p', human: 席 | null（null = 人間の席が無い。全席 bot の観戦で、取り戻すことはできない）,
   *         delegate: true なら人間の席（席 0）を最初から bot に任せる（取り戻せる）,
   *         bots: ['B7', …]（席ごとの bot の id。人間の席の値は、その席を bot に任せたときの bot の種類）,
   *         seed: 数, rules: { w, h, D, recoverEvery, bankMax, bankInit, K, W, Pmax, maxTicks } }
   */
  function create(opts) {
    var game = new RT.RTGame(Object.assign({ mode: opts.mode || '2p' }, opts.rules || {}));
    var np = game.np, human = opts.human === undefined ? 0 : opts.human, seed = opts.seed >>> 0;
    var labels = [], idxOf = {};
    for (var p = 0; p < np; p++) {
      var lab = (opts.bots && opts.bots[p]) || 'B2';
      idxOf[lab] = (idxOf[lab] === undefined) ? 0 : idxOf[lab] + 1;
      labels.push({ label: lab, idx: idxOf[lab] });
    }
    var set = RT.createBots(game, { seats: labels, seed: seed }); // 人間の席にも bot を作っておく（呼ぶのは任せている間だけ。作っただけでは乱数は進まない）
    var delegated = human !== null && !!opts.delegate;           // 人間の席を bot に任せているか
    var pending = [];     // 人間の待ち行列（依頼の配列。依頼 = 盤の座標のセルの配列）。次の境目で engine へ渡す
    var pendingKeys = {};
    var lastReveal = null, lastApplied = null;
    var self = {};

    function key(x, y) { return x + ',' + y; }
    function pendingCount() { return Object.keys(pendingKeys).length; }
    function flat() { return pending.reduce(function (a, req) { return a.concat(req); }, []); }

    self.game = game;
    self.human = human;
    self.labels = labels;
    self.rules = function () { return Object.assign({}, game.cfg); };
    self.shelf = function () { return P.SHELF; };
    self.pending = function () { return flat(); };
    self.lastReveal = function () { return lastReveal; };
    self.lastApplied = function () { return lastApplied; };
    self.phase = function () { return game.phase; };
    self.humanActive = function () { return human !== null && game.players[human].active; };
    /** 人間の席を bot に任せているか（人間の席が無い観戦では false）。 */
    self.delegated = function () { return delegated; };
    /** 人間の席が今、人間に操作されているか。 */
    self.humanControls = function () { return human !== null && !delegated; };
    /** 人間の席の bot の id（任せたときに動く bot）。人間の席が無ければ null。 */
    self.seatBot = function () { return human === null ? null : labels[human].label; };
    /** 今、人間が置けるか（開始時の配置・走行中・一時停止中。終局後・敗退後・bot に任せている間は置けない）。 */
    self.canPlace = function () { return self.humanActive() && !delegated && game.phase !== 'done'; };
    /** 任せる／取り戻すを今できるか（人間の席が生きていて、終局前）。 */
    self.canDelegate = function () { return self.humanActive() && !delegated && game.phase !== 'done'; };
    self.canReclaim = function () { return self.humanActive() && delegated && game.phase !== 'done'; };
    self.isOpening = function () { return game.phase === 'opening'; };
    self.isRunning = function () { return game.phase === 'running'; };
    self.isOver = function () { return game.phase === 'done'; };
    self.bank = function () { return human === null ? 0 : game.players[human].bank; };
    self.cost = function () { return pendingCount(); };

    /** 人間の待ち行列に加えられるセルか: 自陣の中・今の盤で生きたセルの上でない・既に積んでいない。理由を返す。 */
    function check(x, y) {
      if (human === null || game.phase === 'done') return 'not-your-turn';
      if (!game.players[human].active) return 'eliminated';
      if (delegated) return 'delegated';
      if (!game.inZone(human, x, y)) return 'outside-zone';
      if (game.sims[0].get(x, y) !== 0) return 'on-live-cell';
      if (pendingKeys[key(x, y)]) return 'already-pending';
      return null;
    }

    function validate(cells) {
      var fresh = [], seen = {};
      for (var i = 0; i < cells.length; i++) {
        var k = key(cells[i][0], cells[i][1]);
        if (seen[k]) continue;
        seen[k] = true;
        var why = check(cells[i][0], cells[i][1]);
        if (why) return { ok: false, reason: why, cell: cells[i] };
        fresh.push(cells[i]);
      }
      if (pendingCount() + fresh.length > self.bank()) return { ok: false, reason: 'over-bank', cost: pendingCount() + fresh.length, bank: self.bank() };
      return { ok: true, fresh: fresh };
    }
    self.test = function (cells) { var r = validate(cells); return r.ok ? { ok: true, added: r.fresh.length } : r; };

    /** セルの集合を、全部置けるときだけ待ち行列へ加える。1 つでも無効・残高超過なら何も加えない（理由を返す）。 */
    self.addCells = function (cells) {
      var r = validate(cells);
      if (!r.ok) return r;
      if (r.fresh.length) {
        pending.push(r.fresh.map(function (c) { return [c[0], c[1]]; }));
        r.fresh.forEach(function (c) { pendingKeys[key(c[0], c[1])] = true; });
      }
      return { ok: true, added: r.fresh.length };
    };

    /** パターンを置く。(x0, y0) は向きを施した後の外接矩形の左上（盤の座標）。 */
    self.stamp = function (patternId, orient, x0, y0) {
      var pat = P.BY_ID[patternId];
      if (!pat) return { ok: false, reason: 'unknown-pattern' };
      return self.addCells(P.orient(pat.cells, orient).map(function (c) { return [x0 + c[0], y0 + c[1]]; }));
    };

    /** 自由描画: 1 セルずつ。積んであれば外す。 */
    self.toggle = function (x, y) {
      if (pendingKeys[key(x, y)]) {
        pending = pending.map(function (req) { return req.filter(function (c) { return !(c[0] === x && c[1] === y); }); })
          .filter(function (req) { return req.length > 0; });
        delete pendingKeys[key(x, y)];
        return { ok: true, removed: true };
      }
      return self.addCells([[x, y]]);
    };

    self.removeLast = function () {
      var req = pending[pending.length - 1];
      if (!req) return false;
      var c = req.pop();
      delete pendingKeys[key(c[0], c[1])];
      if (req.length === 0) pending.pop();
      return true;
    };
    self.clearPending = function () { pending = []; pendingKeys = {}; };

    /** 人間の待ち行列を engine の待ち行列へ渡す（適用の境目で）。 */
    function flushHuman() {
      var reqs = pending;
      self.clearPending();
      if (human === null || delegated) return [];
      reqs.forEach(function (req) { game.request(human, req); });
      return reqs;
    }

    /** bot を呼ぶ境目で、人間が操作している席（bot を呼ばない席）。 */
    function heldSeat() { return human !== null && !delegated ? human : null; }

    /**
     * 人間の席を bot に任せる。待ち行列（まだ適用されていない予約）はここで捨て、捨てたセル数を返す（画面のログに出す）。
     * 任せた後の最初の判断は、次に game.gt が D の倍数になる境目（開始時の配置の前なら start()）。
     */
    self.delegate = function () {
      if (!self.canDelegate()) return { ok: false, reason: human === null ? 'no-seat' : delegated ? 'already-delegated' : !game.players[human].active ? 'eliminated' : 'over' };
      var dropped = pendingCount();
      self.clearPending();
      delegated = true;
      return { ok: true, dropped: dropped, gt: game.gt };
    };

    /** 取り戻す。以後は人間が置ける（bot は呼ばれない。乱数の系列はそこで止まり、次に任せたときに続きから動く）。 */
    self.reclaim = function () {
      if (!self.canReclaim()) return { ok: false, reason: human === null ? 'no-seat' : !delegated ? 'not-delegated' : !game.players[human].active ? 'eliminated' : 'over' };
      delegated = false;
      return { ok: true, gt: game.gt };
    };

    function humanReveal(reqs, placed) {
      var cells = reqs.reduce(function (a, req) { return a.concat(req); }, []);
      return { seat: human, who: 'human', names: cells.length ? ['human'] : [], cells: cells, cost: cells.length, placed: placed[human] };
    }

    /**
     * 開始時の配置。ここで初めて bot が決め、全員の手が同時に盤へ入る（時刻 0）。
     * 返り値 = 公開する手（席ごとの { seat, who, names, cells（盤の座標）, cost, placed }）。
     */
    self.start = function () {
      if (game.phase !== 'opening') throw new Error('start: phase=' + game.phase);
      var reveal = RT.botDecisions(game, set, heldSeat());
      var reqs = flushHuman();
      var placed = game.open(null);
      reveal.forEach(function (r) { r.placed = placed[r.seat]; });
      if (heldSeat() !== null) reveal[human] = humanReveal(reqs, placed);
      lastReveal = reveal;
      lastApplied = { gt: 0, placed: placed, rejects: [] };
      return reveal;
    };

    /**
     * 1 ティック進める（step → 判定 → この境目で bot の判断（D ごと）→ 待ち行列の適用）。
     * 返り値: { ticked, gt, reveal（bot を呼んだ境目だけ）, placed（席ごとに置かれたセル）, rejects（この境目の却下）, done }。
     */
    self.advance = function () {
      if (game.phase !== 'running') return { ticked: false, done: game.phase === 'done' };
      var nRej = game.rejects.length;
      game.tick();
      var out = { ticked: true, gt: game.gt, reveal: null, placed: null, rejects: [], dropped: 0, done: game.phase === 'done' };
      // 判定は適用の前（README）。この境目で敗退した人間の待ち行列は適用されずに捨てる——黙って消さず、件数を返す
      if (human !== null && pending.length && !game.players[human].active) {
        out.dropped = pending.reduce(function (n, req) { return n + req.length; }, 0);
        self.clearPending();
      }
      if (game.phase !== 'running') return out;
      if (game.gt % game.cfg.D === 0) out.reveal = RT.botDecisions(game, set, heldSeat());
      var reqs = flushHuman();
      var placed = game.applyQueue();
      out.placed = placed;
      out.rejects = game.rejects.slice(nRej);
      if (out.reveal) {
        out.reveal.forEach(function (r) { r.placed = placed[r.seat]; });
        if (heldSeat() !== null) out.reveal[human] = humanReveal(reqs, placed);
        lastReveal = out.reveal;
      }
      lastApplied = { gt: game.gt, placed: placed, rejects: out.rejects };
      return out;
    };

    /** 今この時点の窓の試算（周期化までの猶予）。窓が満ちる前は null。 */
    self.liveWindow = function () { return game.windowNow(); };

    /** 画面に出す要約。 */
    self.info = function () {
      var counts = [], players = [];
      for (var q = 0; q < np; q++) {
        var pl = game.players[q];
        counts.push(pl.active ? game.countOf(q) : 0);
        players.push({ seat: q, who: (q === human && !delegated) ? 'human' : labels[q].label, bank: pl.bank, active: pl.active, elimGt: pl.elimGt, elimCause: pl.elimCause, wasted: pl.wasted });
      }
      var c = game.cfg;
      return {
        mode: c.mode, phase: game.phase, gt: game.gt, maxTicks: c.maxTicks, counts: counts, players: players, delegated: delegated,
        firstContact: game.firstContact, result: game.result, lastWindow: game.lastJudge, bank: self.bank(), cost: self.cost(),
        bankMax: c.bankMax, recoverEvery: c.recoverEvery, D: c.D, K: c.K, W: c.W,
        nextRecoverIn: game.nextRecoverIn(), nextJudgeIn: game.nextJudgeIn(), nextBotIn: c.D - (game.gt % c.D),
      };
    };
    return self;
  }

  return { create: create };
});
