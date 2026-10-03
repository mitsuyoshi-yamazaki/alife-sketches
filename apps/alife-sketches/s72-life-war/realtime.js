/**
 * S-72 v1.1.0 リアルタイム制のエンジン（ユーザ直接指示 2026-10-02: 「手番が来るまで世界が止まると忙しない」）。
 *
 * **ラウンド制（v1.0.0）は core.js・game.js・bots.js・match.js にそのまま残してあり、このファイルはそれらを書き換えない**
 * （事前登録した実験が測ったのはラウンド制。selftest §12 が v1.0.0 の生ログを再生して一致を確かめる）。
 * ここはその上に、時間が止まらない進行（モード `realtime`）を足す。ヘッドレスの bot 対 bot（playMatch）も持つ（将来の測り直し用）。
 *
 * 規則（新しいモード。既定値は DEFAULTS）:
 *   - 開始時の配置だけは止まる: t=0 の前に全員が同時に（互いの手を見ずに）最初の種を置く。初期の銀行は 12。以後は止まらない。
 *   - 銀行は recoverEvery（10）ティックごとに 1 セル回復し、bankMax（60）で止まる。
 *   - いつでも置ける: 依頼は待ち行列に入り、次のティックの境目（tick() の直後の applyQueue()）で適用する。
 *     置けるのは自陣の死んだセルだけで、**適用の時点の盤**で判定する（F2: 生きたセル・自陣の外は置かず課金もしない／
 *     課金が残高を超える依頼は丸ごと却下）。
 *   - bot は D（30）ティックごとに、その時点の盤と残高で方策を呼ぶ（置かずに待ってよい）。bot は人間の待ち行列を見ない。
 *   - 全滅: 所属セルが 0 になった時点で敗退（毎ティック）。
 *   - 周期化: K（10）ティックごとに、直近 W（60）ティックの窓で v1.0.0 と同じセルごとの判定（並進なし・周期 ≤ P_max・所属込み）を行う。
 *     **ただし設置によってセルが生きた瞬間（そのセルのそのティックの状態）はワイルドカード**（どの比較にも一致）。
 *     孤立した 1 セルを時々置くだけで判定を免れる抜け道を塞ぎ、置いたセルが規則に従って起こした変化だけを「動いている」に数える。
 *   - 時間上限: maxTicks（3,600）。2 人以上が残ればセル数で決着（同数は引き分け）。同時敗退はその時点のセル数（v1.0.0 と同じ）。
 *
 * 時間の取り方: 盤の状態 S_g = g 回 step した後の盤。tick() は step して S_{g+1} にし、敗退・回復・周期化の判定までを行う。
 * その直後（同じ境目）に bot の決定と待ち行列の適用が入る。置いたセルは S_{g+1} の上に生きる（そのティックの状態がワイルドカード）。
 * 窓の写し（Sim の輪）の時刻 g の項は、適用の後に取り直す（置いたセルを含む）。
 *
 * v1.1.1: 規則（DEFAULTS・判定・敗退）は 1.1.0 のまま。追加の bot B8〜B11（bots-extra.js）を makeBot が作れるようにし、botDecisions が人間の席を
 * 飛ばせるようにした（rtsession.js の「bot に任せる／取り戻す」）。playMatch に観察の鉤 onDecisions を足した。
 *
 * 依存ゼロ・古典スクリプト。Node とブラウザで共用（Node: `require('./realtime.js')` / ブラウザ: `window.S72RT`）。
 */
(function (root, factory) {
  var api = factory(
    typeof require === 'function' ? require('./core.js') : root.S72,
    typeof require === 'function' ? require('./game.js') : root.S72Game,
    typeof require === 'function' ? require('./bots.js') : root.S72Bots,
    typeof require === 'function' ? require('./bots-extra.js') : root.S72BotsExtra
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S72RT = api;
})(typeof self !== 'undefined' ? self : this, function (S, G, Bots, Extra) {
  'use strict';

  // 1.1.1: 追加の bot B8〜B11（bots-extra.js）・自陣の操作者の切り替え（rtsession.js）。規則（DEFAULTS）は 1.1.0 のまま
  var VERSION = '1.1.1';

  /** リアルタイム制の既定値（ユーザ指示 2026-10-02。旧版の収入 R=120 で B=12・繰り越し上限 C=60 と同じ速さ・同じ上限）。 */
  var DEFAULTS = Object.freeze({
    mode: '2p', w: 160, h: 96,
    D: 30,            // bot が方策を呼ばれる間隔（ティック）
    recoverEvery: 10, // 銀行が 1 セル回復する間隔
    bankMax: 60,      // 銀行の上限（ゲームごとに固定）
    bankInit: 12,     // 初期の銀行（v1.0.0 の最初の種と同じ）
    K: 10,            // 周期化の判定の間隔
    W: 60, Pmax: 30,  // 窓と周期の上限（v1.0.0 と同じ）
    maxTicks: 3600,   // 時間上限（旧版の 30 ラウンド × 120）
    horizon: 120,     // bot の先読み・延命グライダーが見る地平（v1.0.0 の R と同じ）
    periodic: true,   // false なら周期化の敗退を外す（記録だけ残す）
    wildcard: true,   // false なら設置の瞬間をワイルドカードにしない（検査用の負コントロール。規則ではない）
    separate: false,  // 共有部（G.Game の借用メソッド）が読む。常に false
  });

  var NTAG = S.NTAG;

  // ------------------------------------------------------------------ 窓の周期判定（ワイルドカードつき）
  /**
   * core.js の analyzeWindow と同じ判定に、ワイルドカードを足したもの。
   * wild = { 点の添字: Uint8Array(n) }（その点の、窓の中の時刻 k がワイルドカードなら 1）。無ければ（null）v1.0.0 と同じ結果になる。
   * 点 c が周期 p で繰り返す ⇔ 窓の中の k と k+p がともに入る全ての k で、c の札が等しい **か、どちらかがワイルドカード**。
   * 返り値は analyzeWindow と同じ owned / np（札 1〜NEUTRAL ごと）。npAlive（札を無視した読み）は持たない。
   */
  function analyzeWindowRT(win, w, Pmax, wild) {
    var owned = new Int32Array(NTAG), np = new Int32Array(NTAG);
    var out = { owned: owned, np: np, n: 0, pmax: Pmax };
    if (!win) return out;
    var snaps = win.snaps, n = snaps.length, sw = w + 2;
    out.n = n;
    var pm = Math.min(Pmax, n - 1), s0 = snaps[0];
    for (var y = win.y0; y <= win.y1; y++) {
      for (var x = win.x0; x <= win.x1; x++) {
        var i = (y + 1) * sw + x + 1, mask = 0, constant = true, f = s0[i];
        for (var k = 0; k < n; k++) {
          var v = snaps[k][i];
          if (v) mask |= (1 << v);
          if (v !== f) constant = false;
        }
        if (mask === 0) continue;
        var L;
        for (L = 1; L < NTAG; L++) if (mask & (1 << L)) owned[L]++;
        if (constant) continue; // 全時刻で同じ札（ワイルドカードがあっても同じ）= 周期 1
        var wf = wild ? wild[i] : undefined, per = false;
        for (var p = wf ? 1 : 2; p <= pm && !per; p++) { // 非定数の点は p = 1 では繰り返さない（ワイルドカードがあるときだけ p = 1 も見る）
          var ok = true;
          for (var k2 = 0; k2 + p < n; k2++) {
            if (snaps[k2][i] !== snaps[k2 + p][i] && !(wf && (wf[k2] || wf[k2 + p]))) { ok = false; break; }
          }
          if (ok) per = true;
        }
        if (per) continue;
        for (L = 1; L < NTAG; L++) if (mask & (1 << L)) np[L]++;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ 審判
  function checkCfg(c) {
    ['w', 'h', 'D', 'recoverEvery', 'bankMax', 'bankInit', 'K', 'W', 'Pmax', 'maxTicks', 'horizon'].forEach(function (k) {
      if (!isFinite(c[k]) || Math.floor(c[k]) !== c[k] || c[k] < (k === 'bankInit' ? 0 : 1)) throw new Error('realtime: ' + k + ' は整数でなければならない（' + c[k] + '）');
    });
    if (c.W < 2) throw new Error('realtime: W は 2 以上');
    if (c.bankInit > c.bankMax) throw new Error('realtime: 初期の銀行は上限以下でなければならない');
  }

  /**
   * リアルタイム制の審判。G.Game の借用: 席・自陣・鏡映・札の見え方（fillView）・接触・敗退の処理（_eliminate・_resolveCap）。
   * 敗退と決着は v1.0.0 と同じコードなので、4 人戦の中立・敗退者のセル・同時敗退の扱いは v1.0.0 と同じ。
   */
  function RTGame(cfgIn) {
    var cfg = Object.assign({}, DEFAULTS, cfgIn || {});
    checkCfg(cfg);
    this.cfg = cfg;
    this.np = G.seatCount(cfg.mode);
    this.zones = G.zonesFor(cfg.mode, cfg.w, cfg.h);
    this.flips = []; for (var s = 0; s < this.np; s++) this.flips.push(G.seatFlip(cfg.mode, s));
    this.sims = [new S.Sim(cfg.w, cfg.h, cfg.W)];
    this.players = [];
    this.queue = [];
    for (var p = 0; p < this.np; p++) {
      this.players.push({ bank: cfg.bankInit, active: true, elimGt: null, elimCause: null, cntAtElim: null, wasted: 0 });
      this.queue.push([]);
    }
    this.round = 0; this.k = 0;       // G.Game の共有部が読む（リアルタイム制にラウンドは無い）
    this.calls = 0;                   // bot を呼んだ回数（開始時の配置 = 1）
    this.gt = 0; this.phase = 'opening';
    this.hash = 0x811c9dc5;
    this.firstContact = null; this.contactChecks = 0;
    this.result = null;
    this.elims = [];                  // [{seat, gt, cause}]
    this.rejects = [];                // [gt, 席, 'over-bank'|'partial', 依頼のセル数, 有効なセル数, 銀行, 自陣外, 生きたセル]
    this.placements = [];             // [gt, 席, 置いたセル数]
    this.pc = [];                     // K ごとの周期の判定 [gt, 席ごとの非周期セル数…, 席ごとの所属セル数…]
    this.lastJudge = null;            // 直近の判定 { gt, np, ow, n }
    this.wildRing = new Array(cfg.W); // 時刻 t % W → その時刻にワイルドカードの点の添字の配列
  }
  RTGame.prototype = Object.create(G.Game.prototype);
  RTGame.prototype.constructor = RTGame;
  RTGame.prototype.startRound = function () { throw new Error('realtime: ラウンドは無い'); };
  RTGame.prototype.place = function () { throw new Error('realtime: place ではなく request + applyQueue'); };

  RTGame.prototype._finish = function (winners, cls, capped) {
    G.Game.prototype._finish.call(this, winners, cls, capped);
    this.result.rounds = null; // ラウンドは無い
  };

  /** 依頼を待ち行列へ入れる（盤の座標のセルの配列）。検証は適用の時点で行う。 */
  RTGame.prototype.request = function (seat, cells) {
    if (this.phase === 'done' || !this.players[seat].active || !cells || !cells.length) return false;
    this.queue[seat].push(cells.map(function (c) { return [c[0], c[1]]; }));
    return true;
  };

  /**
   * 待ち行列を今の境目で適用する（全席同時。判定は適用の時点の盤）。席ごと・依頼の順に、課金が残高を超える依頼は丸ごと却下、
   * 生きたセル・自陣の外は置かず課金もしない。返り値: 席ごとに実際に置かれたセルの配列。
   */
  RTGame.prototype.applyQueue = function () {
    var self = this, sim = this.sims[0], plans = [], banks = [], p;
    for (p = 0; p < this.np; p++) {
      var pl = this.players[p], reqs = this.queue[p], bank = pl.bank, taken = {}, plan = [];
      this.queue[p] = [];
      if (pl.active && this.phase !== 'done') {
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
    for (p = 0; p < this.np; p++) {
      plans[p].forEach(function (c) { sim.set(c[0], c[1], p + 1); });
      this.players[p].bank = banks[p];
      if (plans[p].length) { any = true; this.placements.push([this.gt, p, plans[p].length]); }
    }
    if (any) {
      this._resnapshot(plans);
      this.hash = S.foldHash(this.hash, this._tickHash());
      this._contact();
    }
    return plans;
  };

  /** 時刻 gt の窓の項を、置いたセルを含めて取り直し、置いたセルをその時刻のワイルドカードに登録する。 */
  RTGame.prototype._resnapshot = function (plans) {
    var sim = this.sims[0], idx = this.wildRing[this.gt % this.cfg.W] || [];
    sim.ringN -= 1; sim.snapshot();
    plans.forEach(function (cells) { cells.forEach(function (c) { idx.push((c[1] + 1) * sim.sw + c[0] + 1); }); });
    this.wildRing[this.gt % this.cfg.W] = idx;
  };

  /** 開始時の配置。reqs[p] = 盤の座標のセルの配列（無ければ null）。全員同時。時刻 0 の盤を作り、全滅の判定までを行う。 */
  RTGame.prototype.open = function (reqs) {
    if (this.phase !== 'opening') throw new Error('open: phase=' + this.phase);
    var self = this;
    this.sims[0].snapshot(); // 時刻 0（空の盤）の項
    this.wildRing[0] = [];
    (reqs || []).forEach(function (cells, p) { if (cells) self.request(p, cells); });
    this.phase = 'running';
    var placed = this.applyQueue();
    this.hash = S.foldHash(this.hash, this._tickHash());
    this._contact();
    this._judge(false);
    return placed;
  };

  /**
   * 時刻 g の窓の判定（直近 W ティック。ワイルドカードを反映）。窓が満ちていなければ null。
   * partial = true なら、満ちる前は「これまでの分」の窓で試算する（表示用。敗退の判定には使わない）。
   */
  RTGame.prototype._analyze = function (partial) {
    var cfg = this.cfg, sim = this.sims[0], win = sim.lastSnapshots(partial ? Math.min(cfg.W, sim.ringN) : cfg.W);
    if (!win) return null;
    var n = win.snaps.length, t0 = this.gt - n + 1, wild = null, t, j;
    if (cfg.wildcard) {
      wild = {};
      for (t = t0; t < t0 + n; t++) {
        var arr = this.wildRing[t % cfg.W];
        if (arr) for (j = 0; j < arr.length; j++) (wild[arr[j]] || (wild[arr[j]] = new Uint8Array(n)))[t - t0] = 1;
      }
    }
    var wj = analyzeWindowRT(win, cfg.w, cfg.Pmax, wild), np = [], ow = [];
    for (var p = 0; p < this.np; p++) { np.push(wj.np[p + 1]); ow.push(wj.owned[p + 1]); }
    return { gt: this.gt, np: np, ow: ow, n: wj.n };
  };

  /** 今この時点の窓の試算（viewer の「周期化までの猶予」。判定そのものは K ごと・窓が満ちてから）。満ちる前は n < W の窓での試算。 */
  RTGame.prototype.windowNow = function () { return this._analyze(true); };

  /** 敗退の判定。全滅は毎回。periodicDue のときは同じ境目で周期化も見る（同じ境目の敗退は全て同時）。 */
  RTGame.prototype._judge = function (periodicDue) {
    if (this.phase === 'done') return;
    var elim = [], extinct = {}, act = this.activeSeats(), i, p;
    for (i = 0; i < act.length; i++) {
      p = act[i];
      if (this.countOf(p) === 0) { elim.push({ seat: p, cause: 'E' }); extinct[p] = true; }
    }
    if (periodicDue) {
      var wj = this._analyze();
      if (wj) {
        this.lastJudge = wj;
        this.pc.push([wj.gt].concat(wj.np, wj.ow));
        if (this.cfg.periodic) {
          for (i = 0; i < act.length; i++) {
            p = act[i];
            if (!extinct[p] && wj.ow[p] > 0 && wj.np[p] === 0) elim.push({ seat: p, cause: 'P' });
          }
        }
      }
    }
    if (elim.length) this._eliminate(elim);
  };

  /** 1 ティック進める（step → 全滅 → 銀行の回復 → K ごとに周期化 → 時間上限）。置くのはこの後（applyQueue）。 */
  RTGame.prototype.tick = function () {
    if (this.phase !== 'running') throw new Error('tick: phase=' + this.phase);
    var cfg = this.cfg, sim = this.sims[0], p;
    sim.step();
    this.gt += 1; this.k = this.gt;
    this.wildRing[this.gt % cfg.W] = [];
    this.hash = S.foldHash(this.hash, sim.hsum >>> 0);
    this._contact();
    if (this.gt % cfg.recoverEvery === 0) {
      for (p = 0; p < this.np; p++) {
        var pl = this.players[p];
        if (!pl.active) continue;
        if (pl.bank >= cfg.bankMax) pl.wasted += 1; else pl.bank += 1;
      }
    }
    this._judge(this.gt % cfg.K === 0 && this.gt >= cfg.W);
    if (this.phase !== 'done' && this.gt >= cfg.maxTicks) this._resolveCap();
  };

  RTGame.prototype.nextRecoverIn = function () { return this.cfg.recoverEvery - (this.gt % this.cfg.recoverEvery); };
  RTGame.prototype.nextJudgeIn = function () {
    var K = this.cfg.K, g = this.gt;
    do { g += K - (g % K); } while (g < this.cfg.W); // 窓が満ちる前の K の倍数では判定しない
    return g - this.gt;
  };

  /**
   * bot が見る盤。v1.0.0 の fillView（自分の座標系・自分 = 札 1）をそのまま使い、ラウンドの欄を読み替える:
   * round = bot を呼んだ通し番号（開始時の配置 = 1）、R = 先読みの地平（horizon）、C = 銀行の上限。gt・D・rt を足す。
   */
  RTGame.prototype.fillView = function (p, dst) {
    var v = G.Game.prototype.fillView.call(this, p, dst), cfg = this.cfg;
    v.round = this.calls; v.maxRounds = null; v.R = cfg.horizon; v.B = null; v.C = cfg.bankMax;
    v.gt = this.gt; v.D = cfg.D; v.rt = true;
    return v;
  };

  // ------------------------------------------------------------------ bot の読み替え
  /**
   * v1.0.0 の方策をそのまま使う。変えるのは**延命グライダーを前提にした B4・B5 の「いつ動くか」だけ**。
   * v1.0.0 の B4・B5 はラウンド頭（R ティックごと）に 1 回、延命グライダー（5 セル。窓の終わりまで自陣の中を飛ぶ位置）と、残りの銀行の使い道
   * （B4: イーター／ブロック、B5: 銀行が 41 以上なら銃）を決めた。D ティックごとに呼ばれるリアルタイム制で毎回動くと、
   * 延命が 3 セルずつの銀行の取り合いになり（B5 は銃に届かない）意味が変わる。そこで「ラウンド頭」を
   * 「直近の延命グライダーから horizon（R = 120）ティック以上経った呼び出し」と読み替え、**その呼び出しでだけ v1.0.0 の方策をそのまま呼び、
   * それ以外の呼び出しでは待つ**（銀行は貯まる）。最初の呼び出し（開始時の配置）では動く。延命グライダーが置けなければ次の呼び出しで再び動く。
   * 他の 6 体（B0・B1・B2・B3・B6・B7）は方策も系列も v1.0.0 のまま（B0 は通し番号 1 = 開始時の配置でだけ置く）。
   * B8〜B11（v1.1.1 で追加。bots-extra.js）は読み替え無し: D ティックごとに呼ばれるたびに、その時点の盤と残高で 1 回判断する。
   */
  function makeBot(policy, rngSeed, label) {
    var inner = Extra.makeBot(policy, rngSeed, label), lastExt = null; // B0〜B7 は Extra が bots.js へ委ねる
    if (policy !== 'B4' && policy !== 'B5') return inner;
    return {
      policy: policy, label: label,
      decide: function (view) {
        if (lastExt !== null && view.gt - lastExt < view.R) return { cells: [], names: [], cost: 0, look: null, label: label };
        var dec = inner.decide(view);
        if (dec.names.indexOf('glider-ext') >= 0) lastExt = view.gt;
        return dec;
      },
    };
  }

  /**
   * 試合の bot を作る。o = { seats: [{label, idx, rngSeed?}], seed, policyAll?, skip? }（skip = 人間の席。bot を置かない）。
   * 乱数の系列は v1.0.0 と同じく hash(シード, bot の id, 番号)。
   */
  function createBots(game, o) {
    var bots = o.seats.map(function (st, p) {
      if (p === o.skip) return null;
      var rs = st.rngSeed !== undefined ? st.rngSeed : Bots.rngSeedFor(o.seed, st.label, st.idx);
      return makeBot(o.policyAll || st.label, rs, st.label);
    });
    var views = o.seats.map(function () { return new S.Sim(game.cfg.w, game.cfg.h, 0); });
    return { bots: bots, views: views, seats: o.seats };
  }

  /**
   * 今の境目で bot を呼ぶ。その時点の盤・自分の残高だけを見て決め、依頼を待ち行列へ入れる（人間の待ち行列は見えない）。
   * humanSeat = 人間が操作している席（無ければ省略／null）。その席の bot は呼ばない（乱数も進めない）。bot の無い席（createBots の skip）も人間の席として扱う。
   * 返り値: 席ごとの公開用の記録 { seat, who, names, cells（盤の座標）, cost, look, target, orient }（target・orient は B10 だけが埋める）。
   */
  function botDecisions(game, set, humanSeat) {
    var reveal = [];
    game.calls += 1;
    set.bots.forEach(function (bot, p) {
      if (!game.players[p].active) { reveal.push({ seat: p, who: 'eliminated', names: [], cells: [], cost: 0 }); return; }
      if (!bot || p === humanSeat) { reveal.push({ seat: p, who: 'human', names: [], cells: [], cost: 0 }); return; }
      var dec = bot.decide(game.fillView(p, set.views[p]));
      var cells = dec.cells.map(function (c) { return game.toTrue(p, c[0], c[1]); });
      if (cells.length) game.request(p, cells);
      reveal.push({ seat: p, who: set.seats[p].label, names: dec.names, cells: cells, cost: dec.cost, look: dec.look, target: dec.target === undefined ? null : dec.target, orient: dec.orient === undefined ? null : dec.orient });
    });
    return reveal;
  }

  // ------------------------------------------------------------------ ヘッドレスの試合
  function botId(i) { return 'B' + i; }

  /** 2 人戦の仕様（番号の小さい方を左。同じ bot どうしは番号 0/1）。id は match.js の形に合わせる。 */
  function pairSpec(i, j, seed, extra) {
    return Object.assign({
      id: 'RT:pair:' + botId(i) + '-' + botId(j) + ':' + seed, kind: 'rt', mode: '2p',
      seats: [{ label: botId(i), idx: 0 }, { label: botId(j), idx: i === j ? 1 : 0 }], seed: seed,
    }, extra || {});
  }

  /** 4 人戦の仕様（席順は set の並びのまま）。 */
  function quadSpec(set, seed, extra) {
    return Object.assign({
      id: 'RT:quad:' + set.map(botId).join('-') + ':' + seed, kind: 'rt', mode: '4p',
      seats: set.map(function (b) { return { label: botId(b), idx: 0 }; }), seed: seed,
    }, extra || {});
  }

  /**
   * リアルタイムの試合を最後まで走らせる（bot 対 bot）。spec → row（JSON にできる形）。
   * opts.rules は規則の値の上書き。opts.onPlaced(game, placedBy)（置いた直後）・opts.onTick(game)（毎ティックの直後・置く前）・
   * opts.onDecisions(game, reveal)（bot を呼んだ直後・待ち行列の適用の前。reveal は botDecisions の返り値）は観察のための鉤で、結果を変えない。
   */
  function playMatch(spec, opts) {
    opts = opts || {};
    var t0 = Date.now(), cfg = Object.assign({ mode: spec.mode || '2p' }, opts.rules || {}, spec.flags || {});
    var game = new RTGame(cfg);
    var set = createBots(game, { seats: spec.seats, seed: spec.seed, policyAll: spec.policyAll });
    var pl = [], lk = [], placed;
    var note = function (reveal) {
      if (opts.onDecisions) opts.onDecisions(game, reveal);
      reveal.forEach(function (r) {
        if (r.who === 'eliminated') return;
        pl.push([game.gt, r.seat, r.names.join('+') || '-', r.cost, r.cells.length]);
        if (r.look) lk.push([game.gt, r.seat, r.look.values, r.look.chosen, r.look.names]);
      });
    };
    note(botDecisions(game, set));
    placed = game.open(null);
    if (opts.onPlaced) opts.onPlaced(game, placed);
    while (game.phase === 'running') {
      game.tick();
      if (opts.onTick) opts.onTick(game);
      if (game.phase !== 'running') break;
      if (game.gt % game.cfg.D === 0) note(botDecisions(game, set));
      placed = game.applyQueue();
      if (opts.onPlaced) opts.onPlaced(game, placed);
    }
    var r = game.result, sim = game.sims[0];
    return {
      id: spec.id, kind: spec.kind || 'rt', ver: VERSION, mode: cfg.mode, seed: spec.seed, seats: spec.seats.map(function (s) { return s.label; }),
      res: r.code, cls: r.cls, win: r.winners.map(function (w) { return [w.seat, w.share]; }), cap: r.capped, gt: r.gt,
      el: game.elims.map(function (e) { return [e.seat, e.gt, e.cause]; }), ct: game.firstContact !== null, fc: game.firstContact,
      mb: sim.mixed, tb: sim.ties, nb: sim.neutralBirths, bn: sim.births, fin: r.finalCounts,
      pl: pl, pc: game.pc, rj: game.rejects, wasted: game.players.map(function (x) { return x.wasted; }), lk: lk,
      h: S.hex8(game.hash), ms: Date.now() - t0,
    };
  }

  return {
    VERSION: VERSION, DEFAULTS: DEFAULTS, RTGame: RTGame, analyzeWindowRT: analyzeWindowRT, makeBot: makeBot,
    createBots: createBots, botDecisions: botDecisions, playMatch: playMatch, pairSpec: pairSpec, quadSpec: quadSpec,
  };
});
