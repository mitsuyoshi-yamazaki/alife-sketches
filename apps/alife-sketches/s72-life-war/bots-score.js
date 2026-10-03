/**
 * S-72 の 2 本目の run `score` の bot（criteria.score.json botGrid）。新しい 4 体 Z0〜Z3 と、既存の bot（B0〜B11）を得点制の審判から呼ぶための
 * 読み替え（端数の処分 F9）。**bots.js・bots-extra.js・realtime.js の方策は書き換えない**（B0〜B11 は realtime.js の makeBot へ委ねる。B4 の読み替え F8 も
 * そのまま）。
 *
 *   Z0 拒否       — 開始時に孤立した 1 セルだけを置き、以後は置かない（メモ §2.2 F『置かなければ負けない』）。乱数を使わない
 *   Z1 狙撃       — B11 の方策に狙撃（自陣に入った相手のセルを 1 ティック先読みで過密死させて得点する）を優先して重ねる
 *   Z2 得点の先読み — B2 と同じ候補生成器 G（bots.js の candidates）で 6 候補を作り、各候補を 120 ティック先まで走らせ、得点差で選ぶ
 *   Z3 銃         — 開始時にブロックを自陣の奥へ置き、銃（36 セル）を相手の自陣へ届く位置から撃つ。買えなくなったらグライダー
 *
 * 全 bot 共通（botGrid.common）:
 *   - 自分の座標系で計算する（左の席が基準。盤への写しは審判が行う）。乱数の系列 = hash(シード, bot の id, 同じ bot が同じ試合に 2 体いるときの番号 0/1)。
 *     系列は席ではなく bot に付く。Z1 の狙撃の同点だけは別の系列 hash(シード, 'Z1s', 番号)
 *   - D = 30 ティックごとに 1 回判断する。見るのは view（score.js の fillView）だけ。得点を知らない bot（B0〜B11）は得点を読まない
 *   - **端数の処分（F9。S1 が足した bot の外付け）**: 総量が L に届いた後、bot の判断が『置かない』（依頼のセル数 0）だった回が 4 回続いたら、
 *     4 回目の判断の代わりに残高の全額を孤立セルとして置いて使い切る。位置は自陣の死んだセルのうち、両者の全ての生きたセルと処分で置く他のセルから
 *     Chebyshev 距離 3 以上離れたものを、相手から遠い列から順に（列の中は上から）走査して選ぶ（乱数を使わない・bot の系列を進めない）。
 *     置ききれなければ置けた分だけ。孤立セルは次の step で過疎で死に、誕生・得点・接触に関わらない（PC13）
 *
 * 依存ゼロ・古典スクリプト。Node とブラウザで共用（Node: `require('./bots-score.js')` / ブラウザ: `window.S72BotsScore`）。
 */
(function (root, factory) {
  var api = factory(
    typeof require === 'function' ? require('./core.js') : root.S72,
    typeof require === 'function' ? require('./bots.js') : root.S72Bots,
    typeof require === 'function' ? require('./bots-extra.js') : root.S72BotsExtra,
    typeof require === 'function' ? require('./realtime.js') : root.S72RT,
    typeof require === 'function' ? require('./score.js') : root.S72Score
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S72BotsScore = api;
})(typeof self !== 'undefined' ? self : this, function (S, Bots, Extra, RT, Score) {
  'use strict';

  /** botGrid.common の order（表の並び。番号の小さい方を左）。 */
  var GRID_IDS = ['Z0', 'B0', 'B2', 'B3', 'B4', 'B6', 'B10', 'B11', 'Z1', 'Z2', 'Z3'];
  var NEW_IDS = ['Z0', 'Z1', 'Z2', 'Z3'];
  var NEW_NAMES = {
    Z0: '拒否（refuse）', Z1: '狙撃（sniper）', Z2: '得点の先読み（scoreLookahead）', Z3: '銃（gunner）',
  };

  var BIG = 1e9;                 // 先読みが (a) の終局で返す値（±）
  var TRIALS = Bots.TRIALS;      // 位置の試行の上限（bots.js と同じ 50）
  var ORI = Bots.ORI;            // 棚の形ごとの D4 の 8 通りの向き
  var SNIPE_HORIZON = 8;         // Z1: 狙撃の先読みの地平
  var SNIPE_MAX = 24;            // Z1: 判断ごとの狙撃の候補の上限
  var GUN_COST = 36;             // Z3: 銃のコスト（棚の gun）
  var GUN_FRONT = 12;            // Z3: 銃の外接矩形が収まる前線の列の数
  var GUN_ROWS = 9;              // Z3: 銃の外接矩形の上端（下端）の範囲の行数（0〜8）
  var GLIDER_FRONT = 6;          // Z3: グライダーを置く前線の列の数（B3 と同じ）
  var DISPOSE_AFTER = 4;         // F9: 総量が L に届いた後、『置かない』が続いたらこの回目に処分する
  var DISPOSE_GAP = 3;           // F9: 処分のセルと、他の生きたセル・処分の他のセルとの Chebyshev 距離の下限
  /** 近傍の決まった順（上・右上・右・右下・下・左下・左・左上）。Z1 の狙撃の選び方。 */
  var NBR = [[0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1]];

  function ri(r, lo, hi) { return lo + Math.floor(r() * (hi - lo + 1)); }
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

  /** bots.js の placeRandom と同じ（外接矩形の右端が [xrLo, xrHi]・上端は乱択。最大 TRIALS 回）。 */
  function placeRandom(view, r, ori, xrLo, xrHi) {
    var b = ori.box;
    var xr0 = Math.max(xrLo, b.w - 1), xr1 = Math.min(xrHi, view.zoneW - 1);
    var y1 = view.zoneH - b.h;
    if (xr0 > xr1 || y1 < 0) return null;
    for (var t = 0; t < TRIALS; t++) {
      var xr = ri(r, xr0, xr1), y0 = ri(r, 0, y1);
      var cells = cellsAt(ori, xr - b.w + 1, y0);
      if (fits(view, cells)) return cells;
    }
    return null;
  }

  // ------------------------------------------------------------------ 乱数の系列
  /**
   * 系列の種。main = hash(シード, bot の id, 番号)（B0〜B11 と同じ規則）、snipe = hash(シード, id + 's', 番号)（Z1 の狙撃の同点だけ。Z1 以外は使わない）。
   * C3 では id にラベルを渡す（ラベルごとに別の系列）。
   */
  function seedsFor(seed, id, idx) {
    return { main: Bots.rngSeedFor(seed, id, idx), snipe: Bots.rngSeedFor(seed, id + 's', idx) };
  }

  // ------------------------------------------------------------------ 得点の先読み（Z1・Z2 が使う）
  /**
   * 候補 cells（自分の座標系・札 1）を盤の写しに置いて steps ティック先まで走らせた評価（相手は置かないと仮定）。
   * 得点は各ティックの step の前の盤で数える（score.js の scoreGains）。include = true なら評価に現在の得点差を含める（Z2）、false なら増分だけ（Z1）。
   * 途中で、置いた直後にセルのあった側の所属セル数が 0 になれば (a) の終局として、その時点の得点（現在の得点＋増分）の比較で +BIG／−BIG／0 を返す。
   */
  function runAhead(view, scratch, buf, cells, steps, include) {
    scratch.copyFrom(view.sim);
    for (var i = 0; i < cells.length; i++) scratch.set(cells[i][0], cells[i][1], 1);
    var trackOwn = scratch.cur.counts[1] > 0, trackOpp = scratch.cur.counts[2] > 0, gMe = 0, gOpp = 0;
    for (var k = 0; k < steps; k++) {
      buf.fill(0);
      Score.scoreGains(scratch, buf, null);
      gMe += buf[1]; gOpp += buf[2];
      scratch.step();
      if ((trackOwn && scratch.cur.counts[1] === 0) || (trackOpp && scratch.cur.counts[2] === 0)) {
        var a = view.score[0] + gMe, b = view.score[1] + gOpp;
        return a > b ? BIG : a < b ? -BIG : 0;
      }
    }
    return include ? view.score[0] + gMe - (view.score[1] + gOpp) : gMe - gOpp;
  }

  // ------------------------------------------------------------------ Z0 拒否
  function makeRefuse(label) {
    return {
      policy: 'Z0', label: label,
      decide: function (view) {
        if (view.gt !== 0) return { cells: [], names: [], cost: 0, look: null, label: label };
        return { cells: [[2, Math.floor(view.zoneH / 2)]], names: ['refuse'], cost: 1, look: null, label: label };
      },
    };
  }

  // ------------------------------------------------------------------ Z1 狙撃
  /**
   * 判断ごとに (i) 相手のセル e のうち、近傍に自陣の死んだセルを 1 つ以上持つものを集める (ii) 各 e について生きた近傍の数を k とし、k ≥ 4 なら候補にしない
   * （放っておいても過密で死ぬ）。m = 4 − k 個を e の近傍の自陣の死んだセルから選ぶ（足りない・残高を超えるなら候補にしない）。選び方は近傍の決まった順を
   * 開始位置を 1 つずつずらして巡回した 8 通り（同じ組は 1 つにまとめる）(iii) 候補は最大 24 個（e を盤の走査順に並べ、各 e の巡回順に先頭から）
   * (iv) 各候補と『置かない』を 8 ティック先まで走らせ（評価 = 自分の得点の増分 − 相手の得点の増分）(v) 最良が『置かない』を上回れば、その候補を置く
   * （最良が複数なら狙撃用の系列で 1 回だけ引いて一様に選ぶ）。上回らなければ B11 の方策を呼ぶ（狙撃した判断では B11 を呼ばず、その系列は進まない）。
   */
  function snipeCandidates(view) {
    var sim = view.sim, W = view.zoneW, H = view.zoneH, L = sim.cur, bank = view.bank, cands = [], targets = 0, truncated = 0, free = new Array(8);
    for (var y = L.yMin; y <= L.yMax; y++) {
      if (L.rowMax[y] < 0) continue;
      for (var x = L.rowMin[y]; x <= L.rowMax[y]; x++) {
        if (sim.get(x, y) !== 2) continue;                       // 相手のセルだけ（2 人戦では札 2）
        var nfree = 0, live = 0, q;
        for (q = 0; q < 8; q++) {
          var nx = x + NBR[q][0], ny = y + NBR[q][1];
          free[q] = nx >= 0 && ny >= 0 && nx < W && ny < H && sim.get(nx, ny) === 0;
          if (free[q]) nfree++;
          if (sim.get(nx, ny) !== 0) live++;
        }
        if (nfree === 0) continue;                               // (i)
        targets += 1;
        if (live >= 4) continue;                                 // (ii) 放っておいても過密で死ぬ
        var m = 4 - live;
        if (m > nfree || m > bank) continue;
        var seen = {};
        for (var s0 = 0; s0 < 8; s0++) {                         // 開始位置を 1 つずつずらした 8 通り
          var pick = [];
          for (var i = 0; i < 8 && pick.length < m; i++) {
            var d = (s0 + i) % 8;
            if (free[d]) pick.push([x + NBR[d][0], y + NBR[d][1]]);
          }
          var key = pick.map(function (c) { return c[0] + ',' + c[1]; }).sort().join(';');
          if (seen[key]) continue;
          seen[key] = true;
          if (cands.length < SNIPE_MAX) cands.push(pick); else truncated += 1;
        }
      }
    }
    return { cands: cands, targets: targets, truncated: truncated };
  }

  function makeSniper(seeds, label) {
    var inner = RT.makeBot('B11', seeds.main, label), rs = S.rng(seeds.snipe >>> 0), scratch = null, buf = new Int32Array(S.NTAG);
    function decide(view) {
      var sc = snipeCandidates(view), cands = sc.cands;
      var info = { targets: sc.targets, candidates: cands.length, truncated: sc.truncated, values: null, nullValue: null, sniped: false };
      if (cands.length) {
        if (!scratch) scratch = new S.Sim(view.w, view.h, 0);
        var nullVal = runAhead(view, scratch, buf, [], SNIPE_HORIZON, false);
        var vals = cands.map(function (c) { return runAhead(view, scratch, buf, c, SNIPE_HORIZON, false); });
        var best = -Infinity;
        vals.forEach(function (v) { if (v > best) best = v; });
        info.values = vals; info.nullValue = nullVal;
        if (best > nullVal) {
          var ties = [];
          vals.forEach(function (v, i) { if (v === best) ties.push(i); });
          var chosen = ties[Math.floor(rs() * ties.length)];
          info.sniped = true;
          return { cells: cands[chosen], names: ['snipe'], cost: cands[chosen].length, look: null, label: label, snipe: info };
        }
      }
      var dec = inner.decide(view);
      if (info.targets > 0) dec.snipe = info;
      return dec;
    }
    return { policy: 'Z1', label: label, state: inner.state, decide: decide };
  }

  // ------------------------------------------------------------------ Z2 得点の先読み
  /**
   * B2 と同じ候補生成器 G（bots.js の candidates。M = 6、うち 1 つは『置かない』）で候補を作り、各候補を H ティック先（view.R = 120）まで走らせる
   * （相手は置かないと仮定）。評価 = H ティック後の（自分の得点 − 相手の得点）（現在の得点を含む）。評価が最大の候補の集合から、乱数を 1 回だけ引いて
   * 一様に選ぶ（ties[floor(r() × ties の数)]。全候補が同点なら B2 の floor(r() × 6) と同じ分布・同じ消費）。
   * **盤（自分の view）に相手のセルが 1 つも無いときは、全候補の評価が厳密に 0 なので走らせずに 0 とする**（PC12。候補の生成は同じく行い、系列の消費は変わらない）。
   * 全候補が『置かない』（何も買えない）なら走らせない。opts.noOmit = true なら省略を切る（検査用）。
   */
  function makeLookahead(rngSeed, label, opts) {
    var r = S.rng(rngSeed >>> 0), scratch = null, buf = new Int32Array(S.NTAG), omit = !(opts && opts.noOmit);
    function decide(view) {
      var cands = Bots.candidates(view, r), M = cands.length, values, skipped = null;
      var allEmpty = cands.every(function (c) { return c.cells.length === 0; });
      if (allEmpty) { values = cands.map(function () { return 0; }); skipped = 'all-empty'; }
      else if (omit && view.sim.cur.counts[2] === 0) { values = cands.map(function () { return 0; }); skipped = 'no-opp'; }
      else {
        if (!scratch) scratch = new S.Sim(view.w, view.h, 0);
        values = cands.map(function (c) { return runAhead(view, scratch, buf, c.cells, view.R, true); });
      }
      var best = -Infinity;
      values.forEach(function (v) { if (v > best) best = v; });
      var ties = [];
      values.forEach(function (v, i) { if (v === best) ties.push(i); });
      var chosen = ties[Math.floor(r() * ties.length)];
      var out = { cells: [], names: [], cost: 0, look: { values: values, chosen: chosen, ties: ties.length, skipped: skipped, names: cands.map(function (c) { return c.names[0] || '-'; }) }, label: label };
      if (cands[chosen].cells.length) { out.cells = cands[chosen].cells; out.names = [cands[chosen].names[0]]; out.cost = out.cells.length; }
      return out;
    }
    return { policy: 'Z2', label: label, decide: decide };
  }

  // ------------------------------------------------------------------ Z3 銃
  /**
   * 開始時は block（4）を自陣の奥（外接矩形が列 1〜5）の乱択の行に置く。以後の判断で、残高 ≥ 36 なら Gosper グライダー銃を置く: 向きは流れが敵陣へ向かう
   * 斜めの向きのうち外接矩形が前線の 12 列に収まるもの（縦長の 2 向き）から乱択し、位置は外接矩形が列 zoneW − 12 〜 zoneW − 1 に収まり、流れが下向きなら
   * 上端が行 0〜8、上向きなら下端が行 zoneH − 9 〜 zoneH − 1 の乱択（全セルが死んだセルに載る位置。最大 50 回試行。見つからなければ次の判断で再試行）。
   * 『総量の残り（L − 総量）＋ 残高 < 36』（以後は銃を買えない）になったら、残高 ≥ 5 の判断ごとにグライダーを敵陣へ向けて前線 6 列以内に置き、
   * 5 未満の端数は共通の処分（F9）に任せる。
   */
  function makeGunner(rngSeed, label) {
    var r = S.rng(rngSeed >>> 0), state = { target: null };
    function placeGun(view) {
      var oris = ORI.gun.filter(function (o) { return o.vel.dx > 0 && o.box.w <= GUN_FRONT; });
      if (!oris.length) return null;
      var ori = oris[Math.floor(r() * oris.length)], b = ori.box;
      if (b.w > view.zoneW || b.h > view.zoneH) return null;
      for (var t = 0; t < TRIALS; t++) {
        var x0 = ri(r, view.zoneW - GUN_FRONT, view.zoneW - b.w), y0;
        if (ori.vel.dy > 0) y0 = ri(r, 0, GUN_ROWS - 1);
        else y0 = ri(r, view.zoneH - GUN_ROWS - b.h + 1, view.zoneH - b.h);
        if (y0 < 0 || y0 + b.h > view.zoneH) continue;
        var cells = cellsAt(ori, x0, y0);
        if (fits(view, cells)) return cells;
      }
      return null;
    }
    function decide(view) {
      var out = { cells: [], names: [], cost: 0, look: null, label: label };
      var acc = function (cells, name) { out.cells = cells; out.names = [name]; out.cost = cells.length; };
      if (view.gt === 0) {                                          // 開始時: block を自陣の奥へ
        if (view.bank >= 4) {
          var bo = ORI.block[0], cells = cellsAt(bo, ri(r, 1, 4), ri(r, 0, view.zoneH - bo.box.h));
          if (fits(view, cells)) acc(cells, 'block');
        }
        state.target = 'gun';
        return out;
      }
      var remaining = view.L - view.total;
      if (remaining + view.bank >= GUN_COST) {                      // まだ銃を買える
        state.target = 'gun';
        if (view.bank >= GUN_COST) { var g = placeGun(view); if (g) acc(g, 'gun'); }
        return out;
      }
      state.target = 'glider';                                      // 以後は銃を買えない: グライダーを敵陣へ
      if (view.bank >= 5) {
        var gl = ORI.glider.filter(function (o) { return o.vel.dx > 0; });
        var ori = gl[Math.floor(r() * gl.length)];
        var cg = placeRandom(view, r, ori, view.zoneW - GLIDER_FRONT, view.zoneW - 1);
        if (cg) acc(cg, 'glider');
      }
      return out;
    }
    return { policy: 'Z3', label: label, state: state, decide: decide };
  }

  // ------------------------------------------------------------------ 端数の処分（F9）
  /**
   * 残高の全額を孤立セルとして置く位置（自分の座標系）。自陣の死んだセルのうち、両者の全ての生きたセルと、ここで置く他のセルから
   * Chebyshev 距離 DISPOSE_GAP（3）以上離れたものを、相手から遠い列（小さい x）から順に・列の中は上から走査して n 個まで選ぶ。乱数を使わない。
   */
  function disposalCells(view, n) {
    var out = [], sim = view.sim, W = view.zoneW, H = view.zoneH, g = DISPOSE_GAP - 1;
    for (var x = 0; x < W && out.length < n; x++) {
      for (var y = 0; y < H && out.length < n; y++) {
        if (sim.get(x, y) !== 0) continue;
        var near = false, dx, dy;
        for (dx = -g; dx <= g && !near; dx++) for (dy = -g; dy <= g; dy++) if (sim.get(x + dx, y + dy) !== 0) { near = true; break; }
        if (near) continue;
        for (var i = 0; i < out.length; i++) if (Math.abs(out[i][0] - x) <= g && Math.abs(out[i][1] - y) <= g) { near = true; break; }
        if (!near) out.push([x, y]);
      }
    }
    return out;
  }

  /** 全 bot 共通の外付け。bot の方策のコードは変えず、判断の結果だけを見て、条件が揃った回に結果を差し替える。 */
  function withDisposal(inner, label) {
    var quiet = 0;
    return {
      policy: inner.policy, label: label, state: inner.state, inner: inner,
      decide: function (view) {
        var dec = inner.decide(view);
        if (view.total < view.L) { quiet = 0; return dec; }          // 総量が L に届いた後だけ数える
        if (dec.cells.length > 0) { quiet = 0; return dec; }
        if (quiet < DISPOSE_AFTER) quiet += 1;
        if (quiet < DISPOSE_AFTER || view.bank <= 0) return dec;
        quiet = 0;
        var cells = disposalCells(view, view.bank);
        var target = inner.state && inner.state.target !== undefined ? inner.state.target : null;
        var out = { cells: cells, names: ['dispose'], cost: cells.length, look: null, label: label, disposal: { notPlaced: view.bank - cells.length, bankBefore: view.bank, target: target } };
        if (dec.snipe) out.snipe = dec.snipe;
        return out;
      },
    };
  }

  // ------------------------------------------------------------------ bot の生成
  /**
   * policy の bot を作る（端数の処分つき）。rngSeed = 系列の種（数）。opts = { snipeSeed（Z1 の狙撃の同点の系列）, noDisposal（検査用）, noOmit（Z2 の省略を切る。検査用）, label }。
   * B0〜B11 は realtime.js の makeBot（B4・B5 の読み替えを含む）。Z0〜Z3 はここの方策。
   */
  function makeBot(policy, rngSeed, label, opts) {
    opts = opts || {};
    var lab = label || policy, inner;
    if (policy === 'Z0') inner = makeRefuse(lab);
    else if (policy === 'Z1') inner = makeSniper({ main: rngSeed, snipe: opts.snipeSeed !== undefined ? opts.snipeSeed : S.hash32(rngSeed + '|s') }, lab);
    else if (policy === 'Z2') inner = makeLookahead(rngSeed, lab, opts);
    else if (policy === 'Z3') inner = makeGunner(rngSeed, lab);
    else inner = RT.makeBot(policy, rngSeed, lab);
    return opts.noDisposal ? inner : withDisposal(inner, lab);
  }

  /**
   * 試合の bot を作る。o = { seats: [{label, idx}], seed, policyAll?, skip?, rngSeeds?: [{main, snipe}, …], makeBot? }。
   * skip = 人間の席（bot を置かない）。rngSeeds は席ごとの系列の種の上書き（鏡像の検査で同じ系列を両席へ与える）。
   * makeBot は作り方の差し替え（検査用の台本）。乱数の系列は seedsFor（C3 では policyAll が B2 でも、系列はラベルごと）。
   */
  function createBots(game, o) {
    var mk = o.makeBot || makeBot;
    var bots = o.seats.map(function (st, p) {
      if (p === o.skip) return null;
      var sd = (o.rngSeeds && o.rngSeeds[p]) || seedsFor(o.seed, st.label, st.idx);
      return mk(o.policyAll || st.label, sd.main, st.label, { snipeSeed: sd.snipe });
    });
    var views = o.seats.map(function () { return new S.Sim(game.cfg.w, game.cfg.h, 0); });
    return { bots: bots, views: views, seats: o.seats };
  }

  /** 画面・ログに出す名前（'Z1 狙撃'・'B9 小さく頻繁'）。 */
  function displayName(id) {
    var names = Object.assign({}, Extra.ALL_NAMES, NEW_NAMES);
    return id + ' ' + String(names[id] || '').replace(/（.*$/, '');
  }

  return {
    GRID_IDS: GRID_IDS, NEW_IDS: NEW_IDS, NEW_NAMES: NEW_NAMES, BIG: BIG, SNIPE_HORIZON: SNIPE_HORIZON, SNIPE_MAX: SNIPE_MAX,
    GUN_COST: GUN_COST, GUN_FRONT: GUN_FRONT, DISPOSE_AFTER: DISPOSE_AFTER, DISPOSE_GAP: DISPOSE_GAP,
    seedsFor: seedsFor, snipeCandidates: snipeCandidates, makeBot: makeBot, createBots: createBots, disposalCells: disposalCells, withDisposal: withDisposal,
    runAhead: runAhead, displayName: displayName,
  };
});
