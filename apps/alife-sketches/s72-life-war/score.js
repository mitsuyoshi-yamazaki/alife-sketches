/**
 * S-72 の 2 本目の run `score`（得点制のライフゲーム戦争）の審判。criteria.score.json の system（総量 L・得点・終了 (a)(b)(c)・決着）と
 * filledByS1 F1〜F12 をそのまま書く。**core.js・game.js・realtime.js・bots*.js は書き換えず、require して使う**（登録時の sha256 は
 * criteria.score.json system.implementationBase）。生死の更新は core.js の Sim.step のままで、**得点の勘定は step の前の盤（t の盤）を
 * 読んで外側で数える**（scoreGains。core.js に得点の語は無い）。
 *
 * 規則（既定値は DEFAULTS。値の出所は criteria.score.json system）:
 *   - 盤 160 × 96・外は常に死んだセル・2 人戦のみ。自陣は左右の端の幅 zoneW = 40（中立地帯は残りの 80 列）。席 0 = 左、席 1 = 右。
 *   - 開始時の配置だけ盤が止まる（全員が互いの手を見ずに同時に置く）。初期の銀行 bankInit = 12。以後は止まらない。
 *     銀行は recoverEvery = 10 ティックごとに 1 回復し、上限 bankMax = 60 で止まる。置く依頼は待ち行列に入り、次の境目で適用する。
 *   - 総量 L = 120（F6）: 1 試合で銀行へ入る総量（初期の 12 を含む）を L で打ち切る。満杯で止まった回復は総量に数えず wasted に数える。
 *     「設置できない」= 総量が L に届き、かつ残高 0（F3。待ち行列の適用の直後に判定。以後は戻らない）。
 *   - 得点: ティック t → t+1 の更新で、t の盤で生きていて生きた近傍が 4 以上のセル（過密で死ぬ）について、そのセルの近傍の生きたセルのうち
 *     所属が違うものの数を、その所属の席の得点に足す。過疎の死・生き残り・誕生では動かない。同じティックに両者が得点してよい。
 *   - 終了（F2 の境目の順序）: step（得点を数える）→ gt += 1 → (a) 一方（または両方）の所属セル数が 0 → 銀行の回復 →
 *     (b) 両者が「設置できない」状態で gt − max(T_u, T_s) ≥ n（n = 320）→ (c) gt ≥ maxTicks（3,600）→ 続くなら bot の判断（D = 30 ごと）→ 待ち行列の適用。
 *     開始時は 両者の開始の判断 → 適用 → (a)（第 0 ティック）。同じ境目で複数が成り立てば理由は (a) > (b) > (c) の順で 1 つ。
 *     決着は終了の理由によらず得点の多い方の勝ち・同点は引き分け（F5。(a) でも「全滅した側の負け」ではない）。
 *   - 周期化の敗退は無い（勝利条件が得点に置き換わった）。
 *   - separate（C4 の分離盤）: 各席が自分のセルだけの盤で戦う。得点の勘定は同じ関数なので、同じ所属だけの過密死を数えない限り 0 のまま（負コントロール）。
 *
 * 時間の取り方は realtime.js と同じ: 盤の状態 S_g = g 回 step した後の盤。tick() は step して S_{g+1} にし、(a)(b)(c) と回復までを行う。
 * その直後（同じ境目）に bot の判断（botDecisions）と待ち行列の適用（applyQueue）が入る。
 *
 * 依存ゼロ・古典スクリプト。Node とブラウザで共用（Node: `require('./score.js')` / ブラウザ: `window.S72Score`）。
 */
(function (root, factory) {
  var api = factory(
    typeof require === 'function' ? require('./core.js') : root.S72,
    typeof require === 'function' ? require('./game.js') : root.S72Game,
    function () { return typeof require === 'function' ? require('./bots-score.js') : root.S72BotsScore; }
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S72Score = api;
})(typeof self !== 'undefined' ? self : this, function (S, G, botsModule) {
  'use strict';

  var VERSION = '1.0.0';

  /** criteria.score.json system の値（走行の規則はそこが正。これは写し。selftest が突き合わせる）。 */
  var DEFAULTS = Object.freeze({
    mode: '2p', w: 160, h: 96, zoneW: 40,
    D: 30,            // bot が方策を呼ばれる間隔（ティック）
    recoverEvery: 10, // 銀行が 1 セル回復する間隔
    bankMax: 60,      // 銀行の上限
    bankInit: 12,     // 初期の銀行
    L: 120,           // 1 試合の総量の上限（初期の銀行を含む）
    n: 320,           // 終了条件 (b) の静止の長さ
    maxTicks: 3600,   // 終了条件 (c) の時間上限
    horizon: 120,     // bot が見る先読みの地平（view.R）
    separate: false,  // true なら各席が自分のセルだけの盤（C4）
    W: 60, Pmax: 30,  // G.Game の fillView が読む欄（この run では使わない）
  });

  /** 腕 C2 の狭い盤（自陣の幅 40 のまま中立地帯を 32 列にする）。 */
  var NARROW_W = 112;

  var NTAG = S.NTAG;

  function checkCfg(c) {
    ['w', 'h', 'zoneW', 'D', 'recoverEvery', 'bankMax', 'bankInit', 'L', 'n', 'maxTicks', 'horizon'].forEach(function (k) {
      if (!isFinite(c[k]) || Math.floor(c[k]) !== c[k] || c[k] < (k === 'bankInit' ? 0 : 1)) throw new Error('score: ' + k + ' は整数でなければならない（' + c[k] + '）');
    });
    if (c.mode !== '2p') throw new Error('score: 2 人戦のみ（mode=' + c.mode + '）');
    if (c.w < 2 * c.zoneW + 1) throw new Error('score: 盤の幅は 自陣 2 つ + 中立地帯 1 列以上でなければならない（w=' + c.w + ' zoneW=' + c.zoneW + '）');
    if (c.bankInit > c.bankMax) throw new Error('score: 初期の銀行は上限以下でなければならない');
    if (c.bankInit > c.L) throw new Error('score: 初期の銀行は総量 L 以下でなければならない');
  }

  /** 盤の幅 = 自陣 2 つ + 中立地帯。画面が「中立地帯の幅」を直接いじるときに使う。 */
  function boardWidth(zoneW, neutralW) { return 2 * zoneW + neutralW; }

  // ------------------------------------------------------------------ 得点の勘定（step の前の盤を読む）
  /**
   * t の盤（sim.cur）で、過密で死ぬセル（生きていて生きた近傍が 4 以上）について、近傍の生きたセルのうちそのセルと所属が違うものの数を
   * **その所属の札**の得点として out[札] へ足す（out は長さ NTAG の配列。呼び側がゼロにしておく）。得点の合計を返す。
   * events（配列）が渡されたら、得点を生んだ死 1 つにつき { x, y, owner（死ぬセルの席 = 札 − 1）, gain: [席 0 の得点, 席 1 の得点, …] } を足す。
   * 生死の判定は札を見ない（core.js の step と同じ B3/S23）ので、ここで数えるのは「死ぬ瞬間の近傍の札」だけ。
   */
  function scoreGains(sim, out, events) {
    var L = sim.cur, sw = sim.sw, bin = L.bin, tag = L.tag, total = 0;
    for (var y = L.yMin; y <= L.yMax; y++) {
      if (L.rowMax[y] < 0) continue;
      var base = (y + 1) * sw + 1;
      for (var x = L.rowMin[y]; x <= L.rowMax[y]; x++) {
        var i = base + x;
        if (bin[i] === 0) continue;
        var n = bin[i - sw - 1] + bin[i - sw] + bin[i - sw + 1] + bin[i - 1] + bin[i + 1] + bin[i + sw - 1] + bin[i + sw] + bin[i + sw + 1];
        if (n < 4) continue; // 近傍 4 以上だけが過密で死ぬ
        var t = tag[i], g = 0, u;
        u = tag[i - sw - 1]; if (u !== 0 && u !== t) { out[u]++; g++; }
        u = tag[i - sw]; if (u !== 0 && u !== t) { out[u]++; g++; }
        u = tag[i - sw + 1]; if (u !== 0 && u !== t) { out[u]++; g++; }
        u = tag[i - 1]; if (u !== 0 && u !== t) { out[u]++; g++; }
        u = tag[i + 1]; if (u !== 0 && u !== t) { out[u]++; g++; }
        u = tag[i + sw - 1]; if (u !== 0 && u !== t) { out[u]++; g++; }
        u = tag[i + sw]; if (u !== 0 && u !== t) { out[u]++; g++; }
        u = tag[i + sw + 1]; if (u !== 0 && u !== t) { out[u]++; g++; }
        if (g > 0) {
          total += g;
          if (events) {
            var gain = [], nb = [tag[i - sw - 1], tag[i - sw], tag[i - sw + 1], tag[i - 1], tag[i + 1], tag[i + sw - 1], tag[i + sw], tag[i + sw + 1]], q;
            for (q = 0; q < 4; q++) gain.push(0);
            for (q = 0; q < 8; q++) if (nb[q] !== 0 && nb[q] !== t && nb[q] <= 4) gain[nb[q] - 1]++;
            events.push({ x: x, y: y, owner: t - 1, gain: gain });
          }
        }
      }
    }
    return total;
  }

  // ------------------------------------------------------------------ 審判
  /**
   * 得点制の審判。G.Game の借用: 席・自陣内の判定・鏡映・札の見え方（fillView）・接触（_contact）・盤の要約（_tickHash）。
   * cfg は DEFAULTS の上書き。flags の narrow / separate は playMatch が cfg へ写す。
   */
  function ScoreGame(cfgIn) {
    var cfg = Object.assign({}, DEFAULTS, cfgIn || {});
    checkCfg(cfg);
    this.cfg = cfg;
    this.np = 2;
    this.zones = [
      { x0: 0, x1: cfg.zoneW - 1, y0: 0, y1: cfg.h - 1 },
      { x0: cfg.w - cfg.zoneW, x1: cfg.w - 1, y0: 0, y1: cfg.h - 1 },
    ];
    this.flips = [G.seatFlip('2p', 0), G.seatFlip('2p', 1)];
    this.sims = [new S.Sim(cfg.w, cfg.h, 0)];
    if (cfg.separate) this.sims.push(new S.Sim(cfg.w, cfg.h, 0));
    this.players = [];
    this.queue = [];
    for (var p = 0; p < 2; p++) {
      this.players.push({
        bank: cfg.bankInit, total: cfg.bankInit, active: true,
        wasted: 0, wastedFirst: null, wastedLast: null, // 満杯で捨てた回復の数と、最初・最後のティック
        reachedGt: cfg.bankInit >= cfg.L ? 0 : null,    // 総量が L に届いたティック
        unableGt: null,                                  // 「設置できない」になったティック（F3）
        disposed: 0,                                     // 端数の処分で置いたセルの数
      });
      this.queue.push([]);
    }
    this.round = 0; this.k = 0;       // G.Game の共有部が読む欄（この run にラウンドは無い）
    this.calls = 0;                   // bot を呼んだ回数（開始時の配置 = 1）
    this.gt = 0; this.phase = 'opening';
    this.hash = 0x811c9dc5;
    this.firstContact = null; this.contactChecks = 0;
    this.result = null;
    this.rejects = [];                // [gt, 席, 'over-bank'|'partial', 依頼のセル数, 有効なセル数, 銀行, 自陣外, 生きたセル]
    this.placements = [];             // [gt, 席, 置いたセル数]
    this.scores = [0, 0];
    this.Ts = 0;                      // 最後に得点が動いたティック（動いていなければ 0。F4）
    this.scoreTicks = 0;              // 得点が動いたティックの数
    this.firstScoreGt = null;         // 最初に得点が動いたティック
    this.afterTu = null;              // 両者が設置できなくなった後（境目が T_u より後）に入った得点の合計（T_u が無ければ null）
    this.series = [];                 // 30 ティックごとの [gt, 得点 0, 得点 1]
    this.lastGains = [0, 0];          // 直近の tick で入った得点
    this.lastEvents = [];             // 直近の tick で得点を生んだ過密死（trackEvents のときだけ）
    this.trackEvents = false;
    this._buf = new Int32Array(NTAG);
  }
  ['simOf', 'countOf', 'inZone', 'activeSeats', 'toTrue', 'toCanon', '_contact', '_tickHash'].forEach(function (m) {
    ScoreGame.prototype[m] = G.Game.prototype[m];
  });
  ScoreGame.prototype.startRound = function () { throw new Error('score: ラウンドは無い'); };
  ScoreGame.prototype.place = function () { throw new Error('score: place ではなく request + applyQueue'); };

  /** 依頼を待ち行列へ入れる（盤の座標のセルの配列）。検証は適用の時点で行う。 */
  ScoreGame.prototype.request = function (seat, cells) {
    if (this.phase === 'done' || !cells || !cells.length) return false;
    this.queue[seat].push(cells.map(function (c) { return [c[0], c[1]]; }));
    return true;
  };

  /** 両者が「設置できない」か・そのティック T_u（遅い方）。 */
  ScoreGame.prototype.bothUnable = function () {
    return this.players[0].unableGt !== null && this.players[1].unableGt !== null;
  };
  ScoreGame.prototype.Tu = function () {
    return this.bothUnable() ? Math.max(this.players[0].unableGt, this.players[1].unableGt) : null;
  };

  /**
   * 待ち行列を今の境目で適用する（全席同時。判定は適用の時点の盤。F2）。席ごと・依頼の順に、課金が残高を超える依頼は丸ごと却下、
   * 生きたセル・自陣の外は置かず課金もしない。返り値: 席ごとに実際に置かれたセルの配列。適用の直後に各自の「設置できない」を更新する（F3）。
   */
  ScoreGame.prototype.applyQueue = function () {
    var self = this, plans = [], banks = [], p;
    for (p = 0; p < 2; p++) {
      var pl = this.players[p], reqs = this.queue[p], bank = pl.bank, taken = {}, plan = [], sim = this.simOf(p);
      this.queue[p] = [];
      if (this.phase !== 'done') {
        reqs.forEach(function (req) {
          var valid = [], local = {}, outside = 0, live = 0;
          req.forEach(function (c) {
            var key = c[0] + ',' + c[1];
            if (local[key] || taken[key]) return;
            local[key] = true;
            if (!self.inZone(p, c[0], c[1])) { outside++; return; }
            if (sim.get(c[0], c[1]) !== 0) { live++; return; }
            valid.push(c);
          });
          if (valid.length > bank) { self.rejects.push([self.gt, p, 'over-bank', req.length, valid.length, bank, outside, live]); return; }
          if (outside > 0 || live > 0) self.rejects.push([self.gt, p, 'partial', req.length, valid.length, bank, outside, live]);
          bank -= valid.length;
          valid.forEach(function (c) { taken[c[0] + ',' + c[1]] = true; plan.push(c); });
        });
      }
      plans.push(plan); banks.push(bank);
    }
    var any = false;
    for (p = 0; p < 2; p++) {
      var simP = this.simOf(p);
      plans[p].forEach(function (c) { simP.set(c[0], c[1], p + 1); });
      this.players[p].bank = banks[p];
      if (plans[p].length) { any = true; this.placements.push([this.gt, p, plans[p].length]); }
    }
    if (any) {
      this.hash = S.foldHash(this.hash, this._tickHash());
      this._contact();
    }
    for (p = 0; p < 2; p++) { // F3: 適用の直後に（総量 = L かつ残高 = 0）となった最初の境目
      var q = this.players[p];
      if (q.unableGt === null && q.total >= this.cfg.L && q.bank === 0) q.unableGt = this.gt;
    }
    return plans;
  };

  /** 開始時の配置。reqs[p] = 盤の座標のセルの配列（無ければ null）。全員同時。時刻 0 の盤を作り、(a) の判定までを行う（第 0 ティック）。 */
  ScoreGame.prototype.open = function (reqs) {
    if (this.phase !== 'opening') throw new Error('open: phase=' + this.phase);
    var self = this;
    (reqs || []).forEach(function (cells, p) { if (cells) self.request(p, cells); });
    this.phase = 'running';
    var placed = this.applyQueue();
    this.hash = S.foldHash(this.hash, this._tickHash());
    this._contact();
    this.series.push([0, 0, 0]);
    this._checkA();
    return placed;
  };

  /** (a): 一方（または両方）の所属セル数が 0 なら終了（その境目に予約していた配置は適用しない）。 */
  ScoreGame.prototype._checkA = function () {
    if (this.phase === 'done') return true;
    var zero = [];
    for (var p = 0; p < 2; p++) if (this.countOf(p) === 0) zero.push(p);
    if (!zero.length) return false;
    this._finish('a', zero);
    return true;
  };

  ScoreGame.prototype._finish = function (reason, aSeats) {
    var s = this.scores, code = s[0] > s[1] ? 'L' : s[0] < s[1] ? 'R' : 'D';
    var cKind = null;
    if (reason === 'c') {
      var tu = this.Tu();
      cKind = tu === null ? 'c1' : (this.Ts > tu && this.gt - this.Ts < this.cfg.n ? 'c2' : 'c3');
    }
    this.result = {
      code: code, winner: code === 'L' ? 0 : code === 'R' ? 1 : null, reason: reason, aSeats: aSeats || [], cKind: cKind,
      gt: this.gt, scores: [s[0], s[1]], finalCounts: [this.countOf(0), this.countOf(1)],
    };
    this.phase = 'done';
  };

  /** 1 ティック進める（得点を数える → step → (a) → 銀行の回復 → (b) → (c)）。置くのはこの後（applyQueue）。 */
  ScoreGame.prototype.tick = function () {
    if (this.phase !== 'running') throw new Error('tick: phase=' + this.phase);
    var cfg = this.cfg, buf = this._buf, i, p;
    buf.fill(0);
    var events = this.trackEvents ? [] : null;
    for (i = 0; i < this.sims.length; i++) scoreGains(this.sims[i], buf, events);
    var g0 = buf[1], g1 = buf[2], hv = 0;
    for (i = 0; i < this.sims.length; i++) { this.sims[i].step(); hv = (hv + this.sims[i].hsum) | 0; }
    this.gt += 1; this.k = this.gt;
    this.hash = S.foldHash(S.foldHash(S.foldHash(this.hash, hv >>> 0), g0), g1);
    this.lastGains = [g0, g1]; this.lastEvents = events || [];
    if (g0 + g1 > 0) {
      this.scores[0] += g0; this.scores[1] += g1;
      this.Ts = this.gt; this.scoreTicks += 1;
      if (this.firstScoreGt === null) this.firstScoreGt = this.gt;
    }
    // T_u の後（境目が T_u より後）に入った得点（reportedMeasures.lateScoringShare）。T_u は適用の直後に決まるので、tick の時点で在れば必ず前の境目
    var tu = this.Tu();
    if (tu !== null) this.afterTu = (this.afterTu || 0) + g0 + g1;
    this._contact();
    if (this.gt % 30 === 0) this.series.push([this.gt, this.scores[0], this.scores[1]]);
    if (this._checkA()) return;
    // 銀行の回復（F6）
    if (this.gt % cfg.recoverEvery === 0) {
      for (p = 0; p < 2; p++) {
        var pl = this.players[p];
        if (pl.total >= cfg.L) continue;
        if (pl.bank >= cfg.bankMax) {
          pl.wasted += 1; if (pl.wastedFirst === null) pl.wastedFirst = this.gt; pl.wastedLast = this.gt;
        } else {
          pl.bank += 1; pl.total += 1;
          if (pl.total >= cfg.L) pl.reachedGt = this.gt;
        }
      }
    }
    // (b) 静止（F4）
    if (tu !== null && this.gt - Math.max(tu, this.Ts) >= cfg.n) { this._finish('b'); return; }
    // (c) 時間上限
    if (this.gt >= cfg.maxTicks) this._finish('c');
  };

  ScoreGame.prototype.nextRecoverIn = function () { return this.cfg.recoverEvery - (this.gt % this.cfg.recoverEvery); };

  /** 終了条件 (b) の進み具合（画面用）。since = 両者が設置できなくなった後の、静止の経過ティック（まだ両者が設置できなければ null）。 */
  ScoreGame.prototype.progressB = function () {
    var tu = this.Tu();
    return {
      unable: [this.players[0].unableGt !== null, this.players[1].unableGt !== null], unableGt: [this.players[0].unableGt, this.players[1].unableGt],
      bothUnable: tu !== null, Tu: tu, Ts: this.Ts, n: this.cfg.n,
      since: tu === null ? null : Math.max(0, this.gt - Math.max(tu, this.Ts)),
    };
  };

  /**
   * bot が見る盤。realtime.js と同じ作り（v1.0.0 の fillView をそのまま使い、ラウンドの欄を読み替える）に、F7 の得点・総量・L を足す。
   * round = bot を呼んだ通し番号（開始時 = 1）・R = 先読みの地平・C = 銀行の上限・score = [自分, 相手]・total = 入金済みの総量・L。
   */
  ScoreGame.prototype.fillView = function (p, dst) {
    var v = G.Game.prototype.fillView.call(this, p, dst), cfg = this.cfg;
    v.round = this.calls; v.maxRounds = null; v.R = cfg.horizon; v.B = null; v.C = cfg.bankMax;
    v.gt = this.gt; v.D = cfg.D; v.rt = true;
    v.score = [this.scores[p], this.scores[1 - p]];
    v.total = this.players[p].total; v.L = cfg.L;
    return v;
  };

  // ------------------------------------------------------------------ bot の呼び出し
  /**
   * 今の境目で bot を呼ぶ。その時点の盤・自分の残高・得点だけを見て決め、依頼を待ち行列へ入れる（相手の待ち行列は見えない）。
   * humanSeat = 人間が操作している席（その席の bot は呼ばない。乱数も進めない）。bot の無い席も人間の席として扱う。
   * 返り値: 席ごとの公開用の記録 { seat, who, names, cells（盤の座標）, cost, look, target, orient, snipe, disposal }。
   */
  function botDecisions(game, set, humanSeat) {
    var reveal = [];
    game.calls += 1;
    set.bots.forEach(function (bot, p) {
      if (!bot || p === humanSeat) { reveal.push({ seat: p, who: 'human', names: [], cells: [], cost: 0 }); return; }
      var dec = bot.decide(game.fillView(p, set.views[p]));
      var cells = dec.cells.map(function (c) { return game.toTrue(p, c[0], c[1]); });
      if (cells.length) game.request(p, cells);
      var rec = {
        seat: p, who: set.seats[p].label, names: dec.names, cells: cells, cost: dec.cost, look: dec.look || null,
        target: dec.target === undefined ? null : dec.target, orient: dec.orient === undefined ? null : dec.orient,
        snipe: dec.snipe || null, disposal: null,
      };
      if (dec.disposal) {
        rec.disposal = { cells: cells, notPlaced: dec.disposal.notPlaced, bankBefore: dec.disposal.bankBefore, target: dec.disposal.target };
        game.players[p].disposed += cells.length;
      }
      reveal.push(rec);
    });
    return reveal;
  }

  // ------------------------------------------------------------------ ヘッドレスの試合
  function cfgFromFlags(flags) {
    var f = flags || {}, out = {};
    if (f.narrow) out.w = NARROW_W;
    if (f.separate) out.separate = true;
    return out;
  }

  /** 終わった盤を（誰も置かずに）時間上限まで影で走らせる（ceilings「静止の長さ n」の記録）。分離盤は定義上得点が動かないので走らせない。 */
  function shadowRun(game) {
    var cfg = game.cfg, res = game.result;
    if (cfg.separate) return { moved: false, first: null, flip: false, final: res.scores.slice(), note: 'separate' };
    var sim = new S.Sim(cfg.w, cfg.h, 0), buf = new Int32Array(NTAG), sc = res.scores.slice(), gt = res.gt, first = null, prevHs = null;
    sim.copyFrom(game.sims[0]);
    while (gt < cfg.maxTicks) {
      buf.fill(0);
      var g = scoreGains(sim, buf, null);
      sim.step(); gt++;
      if (g > 0) { sc[0] += buf[1]; sc[1] += buf[2]; if (first === null) first = gt; }
      if (prevHs === sim.hsum && sim.cur.counts[1] === sim.alt.counts[1] && sim.cur.counts[2] === sim.alt.counts[2] && sameTags(sim.cur.tag, sim.alt.tag)) break; // 静物だけの盤: 以後は動かない
      prevHs = sim.hsum;
    }
    var code = sc[0] > sc[1] ? 'L' : sc[0] < sc[1] ? 'R' : 'D';
    return { moved: first !== null, first: first, flip: code !== res.code, final: sc, note: null };
  }

  function sameTags(a, b) {
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  /**
   * 試合を最後まで走らせる（bot 対 bot）。spec = { id, arm, kind, seats: [{label, idx}], seed, policyAll?, flags?: {narrow, separate}, rngSeeds? }。
   * spec → row（JSON にできる形。生ログの 1 行）。opts.rules は規則の値の上書き。opts.makeBot は bot の作り方の差し替え（検査用の台本）。
   * opts.onPlaced(game, placed)（置いた直後）・opts.onTick(game)（毎ティックの直後・置く前）・opts.onDecisions(game, reveal)（bot を呼んだ直後・適用の前）は
   * 観察のための鉤で、結果を変えない。opts.shadow = true なら (b) で終わった試合の影の走行を行う。
   */
  function playMatch(spec, opts) {
    opts = opts || {};
    var BS = botsModule(), t0 = Date.now();
    var cfg = Object.assign({}, opts.rules || {}, cfgFromFlags(spec.flags));
    var game = new ScoreGame(cfg);
    var set = BS.createBots(game, { seats: spec.seats, seed: spec.seed, policyAll: spec.policyAll, rngSeeds: spec.rngSeeds, makeBot: opts.makeBot });
    var rec = { pl: [], dp: [], lk: [], sn: [], idle: [0, 0], calls: 0 };
    var note = function (reveal) {
      if (opts.onDecisions) opts.onDecisions(game, reveal);
      rec.calls += 1;
      reveal.forEach(function (r) {
        if (r.names.length) rec.pl.push([game.gt, r.seat, r.names.join('+'), r.cost, r.cells.length]); else rec.idle[r.seat] += 1;
        if (r.look) rec.lk.push([game.gt, r.seat, r.look.values, r.look.chosen, r.look.ties, r.look.skipped || null, r.look.names]);
        if (r.snipe) rec.sn.push([game.gt, r.seat, r.snipe.targets, r.snipe.candidates, r.snipe.truncated, r.snipe.values, r.snipe.nullValue, r.snipe.sniped, r.cost]);
        if (r.disposal) rec.dp.push([game.gt, r.seat, r.cells.length, r.disposal.notPlaced, r.disposal.bankBefore, r.disposal.target]);
      });
    };
    var placed;
    note(botDecisions(game, set, null));
    placed = game.open(null);
    if (opts.onPlaced) opts.onPlaced(game, placed);
    while (game.phase === 'running') {
      game.tick();
      if (opts.onTick) opts.onTick(game);
      if (game.phase !== 'running') break;
      if (game.gt % game.cfg.D === 0) note(botDecisions(game, set, null));
      placed = game.applyQueue();
      if (opts.onPlaced) opts.onPlaced(game, placed);
    }
    return buildRow(game, spec, rec, t0, opts);
  }

  /** 終わった試合 → 生ログの 1 行。 */
  function buildRow(game, spec, rec, t0, opts) {
    var r = game.result, pl = game.players, mixed = 0, ties = 0, neutral = 0, births = 0;
    game.sims.forEach(function (sm) { mixed += sm.mixed; ties += sm.ties; neutral += sm.neutralBirths; births += sm.births; });
    var row = {
      id: spec.id, arm: spec.arm, kind: spec.kind, seed: spec.seed, seats: spec.seats.map(function (s) { return s.label; }),
      ext: !!(spec.kind && spec.kind.indexOf('ext') === 0),
      res: r.code, reason: r.reason, aSeats: r.aSeats, cKind: r.cKind, gt: r.gt, sc: r.scores,
      ct: game.firstContact !== null, fc: game.firstContact,
      mb: mixed, tb: ties, nb: neutral, bn: births,
      un: [pl[0].unableGt, pl[1].unableGt], Tu: game.Tu(), Ts: game.Ts > 0 ? game.Ts : null,
      nSc: game.scoreTicks, fsc: game.firstScoreGt, aTu: game.afterTu,
      tot: [pl[0].total, pl[1].total], was: [pl[0].wasted, pl[1].wasted],
      wspan: [pl[0].wasted ? [pl[0].wastedFirst, pl[0].wastedLast] : null, pl[1].wasted ? [pl[1].wastedFirst, pl[1].wastedLast] : null],
      rch: [pl[0].reachedGt, pl[1].reachedGt], bk: [pl[0].bank, pl[1].bank], dsp: [pl[0].disposed, pl[1].disposed],
      fin: r.finalCounts, calls: rec.calls, idle: rec.idle,
      pl: rec.pl, rj: game.rejects, dp: rec.dp, lk: rec.lk, sn: rec.sn,
      h: S.hex8(game.hash), ms: 0,
    };
    if (r.reason === 'c') row.ser = game.series.filter(function (e) { return e[0] > r.gt - 600; });
    if (r.reason === 'b' && opts && opts.shadow) row.sh = shadowRun(game);
    row.ms = Date.now() - t0;
    return row;
  }

  /** 生ログの 1 行 → 要約の行（スカラーだけ。1MB 未満に収まる。OP1〜OP7・knobs・reportedMeasures はこれだけから再計算できる）。 */
  function summarize(row) {
    return {
      id: row.id, arm: row.arm, kind: row.kind, l: row.seats[0], r: row.seats[1], seed: row.seed, ext: row.ext,
      res: row.res, reason: row.reason, aZero: row.aSeats.length ? row.aSeats.join('') : null, cKind: row.cKind, gt: row.gt,
      sL: row.sc[0], sR: row.sc[1], ct: row.ct, fc: row.fc, mb: row.mb, tb: row.tb, nb: row.nb,
      unL: row.un[0], unR: row.un[1], Tu: row.Tu, Ts: row.Ts, nSc: row.nSc, fsc: row.fsc, aTu: row.aTu,
      totL: row.tot[0], totR: row.tot[1], wasL: row.was[0], wasR: row.was[1], bkL: row.bk[0], bkR: row.bk[1],
      dspL: row.dsp[0], dspR: row.dsp[1], finL: row.fin[0], finR: row.fin[1], h: row.h,
    };
  }

  return {
    VERSION: VERSION, DEFAULTS: DEFAULTS, NARROW_W: NARROW_W, ScoreGame: ScoreGame, scoreGains: scoreGains, boardWidth: boardWidth,
    botDecisions: botDecisions, playMatch: playMatch, shadowRun: shadowRun, summarize: summarize, cfgFromFlags: cfgFromFlags,
  };
});
