/**
 * S-72 の対戦の進行（viewer の下にある、画面を持たない部分）。人間 1 人 対 bot（または bot 同士の観戦）を、
 * run.js が測るのと**同じエンジン（core.js・game.js・bots.js）**の上で進める。
 *
 * 同時手番の扱い（criteria.json system.filledByS1 F10）: **人間が置き終えるまで bot の手は決めない・公開しない**。
 * bot の決定は commit() の中で初めて行われ、返り値でだけ公開される（それまで session のどこにも bot の手は無い）。
 * bot はラウンド頭の盤面（人間の今回の手を含まない）だけを見るので、commit の時点で決めても同時手番と同じである。
 *
 * 人間の試合は標本にしない。このファイルは生ログを書かない。
 *
 * 依存ゼロ・古典スクリプト。Node とブラウザで共用（Node: `require('./session.js')` / ブラウザ: `window.S72Session`）。
 */
(function (root, factory) {
  var api = factory(
    typeof require === 'function' ? require('./core.js') : root.S72,
    typeof require === 'function' ? require('./patterns.js') : root.S72Patterns,
    typeof require === 'function' ? require('./game.js') : root.S72Game,
    typeof require === 'function' ? require('./bots.js') : root.S72Bots,
    typeof require === 'function' ? require('./bots-extra.js') : root.S72BotsExtra
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S72Session = api;
})(typeof self !== 'undefined' ? self : this, function (S, P, G, Bots, Extra) {
  'use strict';

  /**
   * opts: { mode: '2p'|'4p', human: 席 | null（null = 自陣（席 0）も bot の操作＝全席 bot。ラウンド制では開始時の選択だけ）, bots: ['B7', …]（席ごと。人間の席は無視）,
   *         seed: 数, rules: { w, h, R, B, C, W, Pmax, maxRounds } }
   */
  function create(opts) {
    var cfg = Object.assign({ mode: opts.mode || '2p' }, opts.rules || {});
    var game = new G.Game(cfg);
    var np = game.np, human = opts.human === undefined ? 0 : opts.human, seed = opts.seed >>> 0;
    var labels = [], idxOf = {};
    for (var p = 0; p < np; p++) {
      var lab = (opts.bots && opts.bots[p]) || 'B2';
      idxOf[lab] = (idxOf[lab] === undefined) ? 0 : idxOf[lab] + 1;
      labels.push({ label: lab, idx: idxOf[lab] });
    }
    // 人間の席には bot を置かない（乱数も消費しない）。bot の系列は席ではなく bot に付く（match.js と同じ）
    // v1.1.1: B8〜B11（bots-extra.js）も作れる。B0〜B7 は Extra が bots.js へ委ねる（書き換えていない）
    var bots = labels.map(function (l, p) { return p === human ? null : Extra.makeBot(l.label, Bots.rngSeedFor(seed, l.label, l.idx), l.label); });
    var viewSims = labels.map(function () { return new S.Sim(game.cfg.w, game.cfg.h, 0); });
    var pending = [];      // 人間の今回の手（盤の座標）
    var pendingKeys = {};
    var lastReveal = null; // 直近のラウンドで公開した手（commit の返り値と同じ）
    var self = {};

    function key(x, y) { return x + ',' + y; }

    function begin() { if (game.phase === 'idle') game.startRound(); }
    begin();

    self.game = game;
    self.human = human;
    self.labels = labels;
    self.rules = function () { return Object.assign({}, game.cfg); };
    self.shelf = function () { return P.SHELF; };
    self.pending = function () { return pending.slice(); };
    self.lastReveal = function () { return lastReveal; };
    self.humanActive = function () { return human !== null && game.players[human].active; };
    self.isHumanTurn = function () { return self.humanActive() && game.phase === 'placing'; };
    /** 次のラウンドへ進められるか（人間が敗退していても、bot だけで進められる）。 */
    self.canAdvance = function () { return game.phase === 'placing'; };
    self.isOver = function () { return game.phase === 'done'; };
    self.bank = function () { return human === null ? 0 : game.players[human].bank; };
    self.cost = function () { return pending.length; };

    /** 人間の手に加えられるセルか: 自陣の中・生きたセルの上でない・既に積んでいない。理由を返す。 */
    function check(x, y) {
      if (human === null || game.phase !== 'placing') return 'not-your-turn';
      if (!game.players[human].active) return 'eliminated';
      if (!game.inZone(human, x, y)) return 'outside-zone';
      if (game.simOf(human).get(x, y) !== 0) return 'on-live-cell';
      if (pendingKeys[key(x, y)]) return 'already-pending';
      return null;
    }

    /** セルの集合が全部置けるかを調べる（何も加えない）。ghost の色分けに使う。 */
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
      if (pending.length + fresh.length > self.bank()) return { ok: false, reason: 'over-bank', cost: pending.length + fresh.length, bank: self.bank() };
      return { ok: true, fresh: fresh };
    }
    self.test = function (cells) { var r = validate(cells); return r.ok ? { ok: true, added: r.fresh.length } : r; };

    /** セルの集合を、全部置けるときだけ加える。残高を超える・1 つでも無効なら何も加えない（理由を返す）。 */
    self.addCells = function (cells) {
      var r = validate(cells);
      if (!r.ok) return r;
      r.fresh.forEach(function (c) { pending.push(c); pendingKeys[key(c[0], c[1])] = true; });
      return { ok: true, added: r.fresh.length };
    };

    /** パターンを置く。(x0, y0) は向きを施した後の外接矩形の左上（盤の座標）。 */
    self.stamp = function (patternId, orient, x0, y0) {
      var pat = P.BY_ID[patternId];
      if (!pat) return { ok: false, reason: 'unknown-pattern' };
      var cells = P.orient(pat.cells, orient).map(function (c) { return [x0 + c[0], y0 + c[1]]; });
      return self.addCells(cells);
    };

    /** 自由描画: 1 セルずつ。積んであれば外す。 */
    self.toggle = function (x, y) {
      if (pendingKeys[key(x, y)]) {
        pending = pending.filter(function (c) { return !(c[0] === x && c[1] === y); });
        delete pendingKeys[key(x, y)];
        return { ok: true, removed: true };
      }
      return self.addCells([[x, y]]);
    };

    self.removeLast = function () {
      var c = pending.pop();
      if (c) delete pendingKeys[key(c[0], c[1])];
      return !!c;
    };
    self.clearPending = function () { pending = []; pendingKeys = {}; };

    /**
     * 置き終えた。ここで初めて bot が決め、全員の手が同時に盤へ入る。
     * 返り値 = 公開する手 { seat: { who: 'human'|bot の id, names, cells（盤の座標）, cost } }。
     */
    self.commit = function () {
      if (game.phase !== 'placing') throw new Error('commit: phase=' + game.phase);
      var reqs = [], reveal = [];
      for (var p = 0; p < np; p++) {
        if (!game.players[p].active) { reqs.push(null); reveal.push({ seat: p, who: 'eliminated', names: [], cells: [], cost: 0 }); continue; }
        if (p === human) {
          reqs.push(pending.slice());
          reveal.push({ seat: p, who: 'human', names: pending.length ? ['human'] : [], cells: pending.slice(), cost: pending.length });
          continue;
        }
        var view = game.fillView(p, viewSims[p]);
        var dec = bots[p].decide(view);
        var cells = dec.cells.map(function (c) { return game.toTrue(p, c[0], c[1]); });
        reqs.push(cells);
        reveal.push({ seat: p, who: labels[p].label, names: dec.names, cells: cells, cost: dec.cost, look: dec.look });
      }
      var placed = game.place(reqs);
      reveal.forEach(function (r) { r.placed = placed[r.seat]; });
      lastReveal = reveal;
      self.clearPending();
      return reveal;
    };

    self.isRunning = function () { return game.phase === 'running'; };

    /** 1 tick 進める。ラウンドが終わったら（終局でなければ）次のラウンドの頭へ進める。 */
    self.tick = function () {
      if (game.phase !== 'running') return { ticked: false };
      game.tick();
      var roundEnded = game.phase === 'idle';
      if (roundEnded) game.startRound();
      return { ticked: true, roundEnded: roundEnded };
    };

    /** 今のラウンドを最後まで進める（テスト・早送り用）。 */
    self.runRound = function () {
      var guard = game.cfg.R + 1;
      while (game.phase === 'running' && guard-- > 0) self.tick();
    };

    /** 今の tick の直近 W ティックの窓での、席ごとの非周期セル数（ラウンド末の判定と同じ数え方の試算）。 */
    self.liveWindow = function () {
      var win = game.sims[0].lastSnapshots(game.cfg.W);
      if (!win) return null;
      var wj = S.analyzeWindow(win, game.cfg.w, game.cfg.Pmax), nonPeriodic = [], owned = [];
      for (var q = 0; q < np; q++) { nonPeriodic.push(wj.np[q + 1]); owned.push(wj.owned[q + 1]); }
      return { np: nonPeriodic, owned: owned, n: wj.n };
    };

    /** 画面に出す要約。 */
    self.info = function () {
      var counts = [], players = [];
      for (var p = 0; p < np; p++) {
        var pl = game.players[p];
        counts.push(pl.active ? game.countOf(p) : 0);
        players.push({ seat: p, who: p === human ? 'human' : labels[p].label, bank: pl.bank, active: pl.active, elimGt: pl.elimGt, elimCause: pl.elimCause });
      }
      var pc = game.pc.length ? game.pc[game.pc.length - 1] : null;
      return {
        mode: game.cfg.mode, round: game.round, maxRounds: game.cfg.maxRounds, phase: game.phase, k: game.k, gt: game.gt, R: game.cfg.R,
        counts: counts, players: players, firstContact: game.firstContact, result: game.result,
        lastWindow: pc ? { np: pc.np, owned: pc.ow } : null, bank: self.bank(), cost: self.cost(),
      };
    };
    return self;
  }

  return { create: create };
});
