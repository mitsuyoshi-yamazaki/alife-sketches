/**
 * S-72 の審判。ラウンド制・予算・自陣・敗退・決着（criteria.json system と filledByS1 F1〜F10）を書く。
 * 格子の時間発展そのものは core.js（札つきの B3/S23）に任せる。ここは「誰がいつ負けたか」を決める側で、
 * 観測器（接触・混ざった誕生・窓での周期）もここに置く。
 *
 * 1 ラウンドの流れ（F4）:
 *   startRound（銀行へ B を足し C で頭打ち）→ place（全員が同時に置く。F2）→ [A6 の摂動] → 全滅の判定 →
 *   R 回の tick（各 tick の後に全滅の判定と接触の判定。最後の tick の後に周期化の判定）→ 最終ラウンドなら上限の決着。
 *   **同じ tick に起きた敗退はすべて同時**（ラウンド最後の tick の全滅と周期化も同時）。
 *
 * 席と札: 席 p（0 始まり）の札は p + 1。2 人戦は左(0)・右(1)、4 人戦は左上(0)・右上(1)・左下(2)・右下(3)。
 * 敗退した席のセルは、4 人戦では敗退の瞬間に NEUTRAL へ変える（F5）。2 人戦では 1 人目の敗退で試合が終わる。
 *
 * 腕のための旗（cfg）:
 *   periodic: false     周期化の敗退を外す（A2。判定器は走らせて記録だけ残す）
 *   oneShot: true       ラウンド 1 の頭だけ置ける（A3）。ラウンド 2 以降の依頼は規則として受け付けない
 *   separate: true      各席が自分のセルだけの盤で戦う（A5）。勝敗だけ同じ規則で合わせる
 *   longWindow: {W, P}  周期の判定を窓 W・周期 P でも並走させて記録する（A3）
 *   perturb: {seat, kind, seed}  ラウンド 1 の配置の直後に課金なしで 1 セルを摂動する（A6）
 *
 * 依存ゼロ・古典スクリプト。Node とブラウザで共用（Node: `require('./game.js')` / ブラウザ: `window.S72Game`）。
 */
(function (root, factory) {
  var api = factory(
    typeof require === 'function' ? require('./core.js') : root.S72,
    typeof require === 'function' ? require('./patterns.js') : root.S72Patterns
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S72Game = api;
})(typeof self !== 'undefined' ? self : this, function (S, P) {
  'use strict';

  /** criteria.json system の値（走行の規則はそこが正。これは写し。selftest が突き合わせる）。 */
  var DEFAULTS = Object.freeze({
    mode: '2p', w: 160, h: 96, R: 120, B: 12, C: 60, initialBank: 0, W: 60, Pmax: 30, maxRounds: 30,
    periodic: true, oneShot: false, separate: false, longWindow: null, perturb: null,
  });

  function seatCount(mode) { return mode === '4p' ? 4 : 2; }

  /** 自陣（盤の座標）。2 人戦: 左右の全行・幅 1/4。4 人戦: 四隅の 幅 1/4 × 高さ 1/3。 */
  function zonesFor(mode, w, h) {
    var zw = Math.floor(w / 4);
    if (mode !== '4p') return [{ x0: 0, x1: zw - 1, y0: 0, y1: h - 1 }, { x0: w - zw, x1: w - 1, y0: 0, y1: h - 1 }];
    var zh = Math.floor(h / 3);
    return [
      { x0: 0, x1: zw - 1, y0: 0, y1: zh - 1 }, { x0: w - zw, x1: w - 1, y0: 0, y1: zh - 1 },
      { x0: 0, x1: zw - 1, y0: h - zh, y1: h - 1 }, { x0: w - zw, x1: w - 1, y0: h - zh, y1: h - 1 },
    ];
  }

  /** 席の鏡映。bot は自分の座標系（左／左上の席が基準）で計算し、その座標を盤へ写す。 */
  function seatFlip(mode, seat) {
    return mode === '4p' ? { fx: seat & 1, fy: seat >> 1 } : { fx: seat & 1, fy: 0 };
  }

  /** 札（真の札）→ 席 p から見た札。自分 = 1、左右の隣 = 2、上下の隣 = 3、対角 = 4（4 人戦）。NEUTRAL は不変。 */
  function viewLabel(mode, p, q) {
    if (mode === '4p') return 1 + ((q & 1) ^ (p & 1)) + 2 * ((q >> 1) ^ (p >> 1));
    return 1 + (q ^ p);
  }

  function Game(cfgIn) {
    var cfg = Object.assign({}, DEFAULTS, cfgIn || {});
    this.cfg = cfg;
    this.np = seatCount(cfg.mode);
    this.zones = zonesFor(cfg.mode, cfg.w, cfg.h);
    this.flips = []; for (var s = 0; s < this.np; s++) this.flips.push(seatFlip(cfg.mode, s));
    var ringCap = Math.max(cfg.W, cfg.longWindow ? cfg.longWindow.W : 0);
    var nSims = cfg.separate ? this.np : 1;
    this.sims = []; for (var k = 0; k < nSims; k++) this.sims.push(new S.Sim(cfg.w, cfg.h, ringCap));
    this.players = [];
    for (var p = 0; p < this.np; p++) this.players.push({ bank: cfg.initialBank, active: true, elimGt: null, elimCause: null, cntAtElim: null });
    this.round = 0; this.k = 0; this.gt = 0; this.phase = 'idle';
    this.hash = 0x811c9dc5;
    this.firstContact = null;
    this.result = null;
    this.elims = [];           // [{seat, gt, cause}]
    this.cnt = [];             // ラウンドごと（または終局時）の席ごとのセル数
    this.bk = [];              // ラウンドごとの席ごとの銀行（配置の後）
    this.pc = [];              // ラウンドごとの周期の判定（np / 札を無視した np / owned / 長い窓の np）
    this.rejects = [];         // 配置の却下・一部の無効
    this.overflow = [];        // 銀行が C を超えて捨てた量
    this.placedLast = [];      // 直近のラウンドに実際に置かれたセル（真の座標）の席ごとの配列
    this.placedRound1 = [];
    this.perturbInfo = null;
    this.contactChecks = 0;
  }

  Game.prototype.simOf = function (p) { return this.cfg.separate ? this.sims[p] : this.sims[0]; };
  Game.prototype.countOf = function (p) { return this.simOf(p).cur.counts[p + 1]; };
  Game.prototype.inZone = function (p, x, y) {
    var z = this.zones[p];
    return x >= z.x0 && x <= z.x1 && y >= z.y0 && y <= z.y1;
  };
  Game.prototype.activeSeats = function () {
    var out = [];
    for (var p = 0; p < this.np; p++) if (this.players[p].active) out.push(p);
    return out;
  };

  /** 自分の座標系の点 → 盤の座標。 */
  Game.prototype.toTrue = function (p, cx, cy) {
    var f = this.flips[p];
    return [f.fx ? this.cfg.w - 1 - cx : cx, f.fy ? this.cfg.h - 1 - cy : cy];
  };
  Game.prototype.toCanon = function (p, x, y) { return this.toTrue(p, x, y); }; // 鏡映は自己逆

  /** ラウンドの頭。銀行へ B を足して C で頭打ち（超えた分は捨てる）。 */
  Game.prototype.startRound = function () {
    if (this.phase !== 'idle') throw new Error('startRound: phase=' + this.phase);
    this.round += 1; this.k = 0;
    for (var p = 0; p < this.np; p++) {
      var pl = this.players[p];
      if (!pl.active) continue;
      var before = pl.bank + this.cfg.B;
      var over = Math.max(0, before - this.cfg.C);
      pl.bank = Math.min(before, this.cfg.C);
      if (over > 0) this.overflow.push([this.round, p, over]);
    }
    this.phase = 'placing';
  };

  /**
   * 全員の依頼を同時に適用する（F2）。requests[p] は盤の座標 [x, y] の配列（無ければ null）。
   * 生きたセル（誰のものでも）の上・自陣の外のセルは置かず課金もしない。課金されるセル数が銀行を超える依頼は丸ごと却下。
   * 返り値: 席ごとに実際に置かれたセルの配列。
   */
  Game.prototype.place = function (requests) {
    if (this.phase !== 'placing') throw new Error('place: phase=' + this.phase);
    var self = this, placedBy = [];
    var plans = [];
    for (var p = 0; p < this.np; p++) {
      var pl = this.players[p], req = requests && requests[p];
      plans.push([]);
      if (!pl.active || !req || req.length === 0) continue;
      if (this.cfg.oneShot && this.round > 1) continue; // A3: 置けないことは規則（却下として記録しない）
      var seen = {}, valid = [], outside = 0, live = 0, dup = 0;
      for (var i = 0; i < req.length; i++) {
        var x = req[i][0], y = req[i][1], key = x + ',' + y;
        if (seen[key]) { dup++; continue; }
        seen[key] = true;
        if (!this.inZone(p, x, y)) { outside++; continue; }
        if (this.simOf(p).get(x, y) !== 0) { live++; continue; }
        valid.push([x, y]);
      }
      if (valid.length > pl.bank) {
        this.rejects.push([this.round, p, 'over-bank', req.length, valid.length, pl.bank, outside, live]);
        continue;
      }
      if (outside > 0 || live > 0) this.rejects.push([this.round, p, 'partial', req.length, valid.length, pl.bank, outside, live]);
      plans[p] = valid;
    }
    for (var q = 0; q < this.np; q++) {
      var cells = plans[q];
      cells.forEach(function (c) { self.simOf(q).set(c[0], c[1], q + 1); });
      this.players[q].bank -= cells.length;
      placedBy.push(cells);
    }
    this.placedLast = placedBy;
    if (this.round === 1) this.placedRound1 = placedBy;
    this.bk.push(this.players.map(function (pl) { return pl.bank; }));
    if (this.round === 1 && this.cfg.perturb) this._perturb();
    this.phase = 'running';
    this.hash = S.foldHash(this.hash, this._tickHash());
    this._contact();
    this._judge(false);
    if (this.phase === 'done') this._closeRound();
    return placedBy;
  };

  /** 摂動（A6）。課金せず、bot にも知らせずに、ラウンド 1 の配置の直後へ 1 セルを入れる。 */
  Game.prototype._perturb = function () {
    var pt = this.cfg.perturb, seat = pt.seat, sim = this.simOf(seat), r = S.rng(pt.seed >>> 0);
    var placed = this.placedRound1[seat] || [], info = { kind: pt.kind, seat: seat, applied: false };
    var zone = this.zones[seat];
    var pick = function (arr) { return arr[Math.min(arr.length - 1, Math.floor(r() * arr.length))]; };
    var neighbours = function (c) {
      var out = [];
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        out.push([c[0] + dx, c[1] + dy]);
      }
      return out;
    };
    var isFreeInZone = function (c) { return c[0] >= zone.x0 && c[0] <= zone.x1 && c[1] >= zone.y0 && c[1] <= zone.y1 && sim.get(c[0], c[1]) === 0; };
    var sorted = placed.slice().sort(function (a, b) { return a[1] - b[1] || a[0] - b[0]; });
    if (pt.kind === 'null') {
      var cand = [];
      for (var y = zone.y0; y <= zone.y1; y++) for (var x = zone.x0; x <= zone.x1; x++) {
        if (sim.get(x, y) !== 0) continue;
        var far = true;
        for (var dy = -2; dy <= 2 && far; dy++) for (var dx = -2; dx <= 2; dx++) if (sim.get(x + dx, y + dy) !== 0) { far = false; break; }
        if (far) cand.push([x, y]);
      }
      if (cand.length) { var c0 = pick(cand); sim.set(c0[0], c0[1], seat + 1); info.applied = true; info.cell = c0; }
    } else if (sorted.length === 0) {
      info.applied = false; info.reason = 'empty-first-move';
    } else if (pt.kind === 'remove') {
      var c1 = pick(sorted); sim.set(c1[0], c1[1], 0); info.applied = true; info.cell = c1;
    } else if (pt.kind === 'add') {
      var seen = {}, adj = [];
      sorted.forEach(function (c) { neighbours(c).forEach(function (n) {
        var key = n[0] + ',' + n[1];
        if (!seen[key] && isFreeInZone(n)) { seen[key] = true; adj.push(n); }
      }); });
      adj.sort(function (a, b) { return a[1] - b[1] || a[0] - b[0]; });
      if (adj.length) { var c2 = pick(adj); sim.set(c2[0], c2[1], seat + 1); info.applied = true; info.cell = c2; }
    } else if (pt.kind === 'shift') {
      var order = sorted.slice(), tries = 0;
      while (order.length && tries < 60) {
        tries++;
        var idx = Math.min(order.length - 1, Math.floor(r() * order.length)), src = order[idx];
        var dsts = neighbours(src).filter(isFreeInZone).sort(function (a, b) { return a[1] - b[1] || a[0] - b[0]; });
        if (dsts.length) {
          var dst = pick(dsts); sim.set(src[0], src[1], 0); sim.set(dst[0], dst[1], seat + 1);
          info.applied = true; info.cell = src; info.to = dst; break;
        }
        order.splice(idx, 1);
      }
    }
    this.perturbInfo = info;
  };

  Game.prototype._tickHash = function () {
    var h = 0;
    for (var i = 0; i < this.sims.length; i++) {
      var L = this.sims[i].cur, v = 0;
      // 置いた直後（step を経ていない面）の要約: 札と位置から step と同じ式で
      for (var y = L.yMin; y <= L.yMax; y++) {
        if (L.rowMax[y] < 0) continue;
        var base = (y + 1) * this.sims[i].sw + 1;
        for (var x = L.rowMin[y]; x <= L.rowMax[y]; x++) {
          var t = L.tag[base + x];
          if (t) v = (v + Math.imul(((y * this.cfg.w + x) << 3) + t + 1, 0x9E3779B1)) | 0;
        }
      }
      h = (h + v) | 0;
    }
    return h >>> 0;
  };

  /** 1 tick 進める。 */
  Game.prototype.tick = function () {
    if (this.phase !== 'running') throw new Error('tick: phase=' + this.phase);
    var hv = 0;
    for (var i = 0; i < this.sims.length; i++) { this.sims[i].step(); hv = (hv + this.sims[i].hsum) | 0; }
    this.k += 1; this.gt += 1;
    this.hash = S.foldHash(this.hash, hv >>> 0);
    this._contact();
    var roundEnd = this.k === this.cfg.R;
    this._judge(roundEnd);
    if (this.phase !== 'done' && roundEnd && this.round >= this.cfg.maxRounds) this._resolveCap();
    if (this.phase === 'done' || roundEnd) this._closeRound();
  };

  /** ラウンドを閉じる記録（ラウンド末、または終局の瞬間のセル数）。 */
  Game.prototype._closeRound = function () {
    var cnt = [];
    for (var p = 0; p < this.np; p++) {
      var pl = this.players[p];
      cnt.push(pl.active ? this.countOf(p) : (pl.cntAtElim == null ? 0 : (pl.elimGt === this.gt ? pl.cntAtElim : 0)));
    }
    this.cnt.push(cnt);
    if (this.phase !== 'done') this.phase = 'idle';
  };

  /** 接触の判定。異なる席のセルが Chebyshev 距離 2 以下になったか（NEUTRAL は席ではない）。初接触の tick を残す。 */
  Game.prototype._contact = function () {
    if (this.firstContact !== null) return;
    var act = this.activeSeats();
    for (var a = 0; a < act.length; a++) for (var b = a + 1; b < act.length; b++) {
      this.contactChecks++;
      var sim = this.cfg.separate ? this.sims[act[a]] : this.sims[0];
      if (S.tagsWithin(sim, act[a] + 1, act[b] + 1, 2)) { this.firstContact = this.gt; return; }
    }
  };

  /** 窓の中の周期の判定（敗退の判定とは別に、記録のために毎ラウンド取る）。 */
  Game.prototype._windowJudgement = function () {
    var np = [], na = [], ow = [], nl = [], p;
    var longCfg = this.cfg.longWindow;
    var wins = [], winsL = [];
    for (var s = 0; s < this.sims.length; s++) {
      wins.push(S.analyzeWindow(this.sims[s].lastSnapshots(this.cfg.W), this.cfg.w, this.cfg.Pmax));
      winsL.push(longCfg ? S.analyzeWindow(this.sims[s].lastSnapshots(longCfg.W), this.cfg.w, longCfg.P) : null);
    }
    for (p = 0; p < this.np; p++) {
      var w = wins[this.cfg.separate ? p : 0], wl = winsL[this.cfg.separate ? p : 0];
      np.push(w.np[p + 1]); na.push(w.npAlive[p + 1]); ow.push(w.owned[p + 1]);
      nl.push(wl && wl.n > 0 ? wl.np[p + 1] : -1);
    }
    return { np: np, na: na, ow: ow, nl: longCfg ? nl : null, n: wins[0].n };
  };

  /** 敗退の判定（F4 の順序）。全滅は毎 tick、周期化はラウンド最後の tick のみ。 */
  Game.prototype._judge = function (roundEnd) {
    if (this.phase === 'done') return;
    var elim = [], act = this.activeSeats(), i, p, extinct = {};
    for (i = 0; i < act.length; i++) {
      p = act[i];
      if (this.countOf(p) === 0) { elim.push({ seat: p, cause: 'E' }); extinct[p] = true; }
    }
    if (roundEnd) {
      var wj = this._windowJudgement();
      this.pc.push(wj);
      if (this.cfg.periodic && wj.n >= this.cfg.W) {
        for (i = 0; i < act.length; i++) {
          p = act[i];
          if (!extinct[p] && wj.ow[p] > 0 && wj.np[p] === 0) elim.push({ seat: p, cause: 'P' });
        }
      }
    }
    if (elim.length) this._eliminate(elim);
  };

  Game.prototype._eliminate = function (list) {
    var gt = this.gt, self = this;
    list.forEach(function (e) {
      var pl = self.players[e.seat];
      pl.cntAtElim = self.countOf(e.seat);
      pl.active = false; pl.elimGt = gt; pl.elimCause = e.cause;
      self.elims.push({ seat: e.seat, gt: gt, cause: e.cause });
    });
    var remaining = this.activeSeats();
    if (remaining.length === 1) {
      var anyP = list.some(function (e) { return e.cause === 'P'; });
      this._finish([{ seat: remaining[0], share: 1 }], anyP ? 'P' : 'E');
    } else if (remaining.length === 0) {
      // 同時に全員が敗退（F6）: その瞬間のセル数が最多の者の勝ち。最多が k 人なら引き分け（各自 1/k）
      var best = -1, tops = [];
      list.forEach(function (e) {
        var c = self.players[e.seat].cntAtElim;
        if (c > best) { best = c; tops = [e.seat]; } else if (c === best) tops.push(e.seat);
      });
      this._finish(tops.map(function (s) { return { seat: s, share: 1 / tops.length }; }), tops.length === 1 ? 'S' : 'D');
    } else if (this.cfg.mode === '4p') {
      list.forEach(function (e) { self.simOf(e.seat).relabel(e.seat + 1, S.NEUTRAL); }); // F5
    }
  };

  /** ラウンド上限での決着（F9: ラウンド 30 の最後の tick の値）。 */
  Game.prototype._resolveCap = function () {
    var act = this.activeSeats(), best = -1, tops = [], self = this;
    act.forEach(function (p) {
      var c = self.countOf(p);
      if (c > best) { best = c; tops = [p]; } else if (c === best) tops.push(p);
    });
    this._finish(tops.map(function (s) { return { seat: s, share: 1 / tops.length }; }), tops.length === 1 ? 'C' : 'D', true);
  };

  Game.prototype._finish = function (winners, cls, capped) {
    var self = this, finalCounts = this.players.map(function (pl, p) { return pl.active ? self.countOf(p) : pl.cntAtElim; });
    var code;
    if (winners.length === 1 && this.np === 2) code = winners[0].seat === 0 ? 'L' : 'R';
    else if (winners.length === 1) code = 'W' + winners[0].seat;
    else code = 'D';
    this.result = { code: code, cls: cls, winners: winners, rounds: this.round, gt: this.gt, finalCounts: finalCounts, capped: !!capped };
    this.phase = 'done';
  };

  /** 席 p から見た盤を、写し先の Sim へ作る（自分の座標系・自分 = 札 1）。bot が見るのはこれだけ。 */
  Game.prototype.fillView = function (p, dst) {
    dst.reset();
    var f = this.flips[p], w = this.cfg.w, h = this.cfg.h, np = this.np, mode = this.cfg.mode;
    var map = new Uint8Array(S.NTAG);
    for (var q = 0; q < np; q++) map[q + 1] = viewLabel(mode, p, q);
    map[S.NEUTRAL] = S.NEUTRAL;
    var srcs = this.cfg.separate ? [this.sims[p]] : [this.sims[0]];
    srcs.forEach(function (sim) {
      var L = sim.cur, sw = sim.sw;
      for (var y = L.yMin; y <= L.yMax; y++) {
        if (L.rowMax[y] < 0) continue;
        var base = (y + 1) * sw + 1, yy = f.fy ? h - 1 - y : y;
        for (var x = L.rowMin[y]; x <= L.rowMax[y]; x++) {
          var t = L.tag[base + x];
          if (t) dst.set(f.fx ? w - 1 - x : x, yy, map[t]);
        }
      }
    });
    return {
      mode: mode, w: w, h: h, np: np, seat: p, sim: dst, own: 1,
      zoneW: this.zones[p].x1 - this.zones[p].x0 + 1, zoneH: this.zones[p].y1 - this.zones[p].y0 + 1,
      bank: this.players[p].bank, round: this.round, maxRounds: this.cfg.maxRounds,
      R: this.cfg.R, B: this.cfg.B, C: this.cfg.C, W: this.cfg.W, Pmax: this.cfg.Pmax, separate: this.cfg.separate,
    };
  };

  return { Game: Game, DEFAULTS: DEFAULTS, zonesFor: zonesFor, seatFlip: seatFlip, viewLabel: viewLabel, seatCount: seatCount };
});
