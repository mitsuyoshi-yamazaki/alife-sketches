/**
 * S-72 の bot 8 体（criteria.json botGrid の B0〜B7）。
 *
 * 全 bot 共通（botGrid.common）:
 *   (1) 自分の座標系で計算する（左／左上の席が基準。盤への写しは game.js が行う）
 *   (2) 乱数の系列 = hash(シード, bot の id, 同じ bot が同じ試合に 2 体いるときの番号 0/1)。系列は席ではなく bot に付く
 *   (3) 1 ラウンドに 1 回、セルの集合を 1 つ置く（置かないもあり）
 *   (4) 自分でコストを計算して銀行の残高を超えない依頼を出す
 *   (5) 見るのはラウンド頭の盤面だけ。延命のグライダー: 自陣の前線寄りから、自分側の外周へ向かう斜めの向きで放つ 5 セル
 *
 * bot は view（game.js の fillView が作る。自分 = 札 1・自分の座標系・自陣は [0, zoneW) × [0, zoneH)）だけを見る。
 * 返すのは自分の座標系のセルの配列。盤の座標への写しと、置けるかどうかの検査は審判（game.js）の側。
 *
 * 依存ゼロ・古典スクリプト。Node とブラウザで共用（Node: `require('./bots.js')` / ブラウザ: `window.S72Bots`）。
 */
(function (root, factory) {
  var api = factory(
    typeof require === 'function' ? require('./core.js') : root.S72,
    typeof require === 'function' ? require('./patterns.js') : root.S72Patterns
  );
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S72Bots = api;
})(typeof self !== 'undefined' ? self : this, function (S, P) {
  'use strict';

  var BOT_IDS = ['B0', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7'];
  var BOT_NAMES = {
    B0: '何もしない（noop）', B1: '乱択セル（soup）', B2: '既知パターンの乱択（randomPattern）', B3: '突撃（rush）',
    B4: '籠城（turtle）', B5: '銃（gun）', B6: 'カオス（chaos）', B7: '先読み（lookahead）',
  };
  /** 先読みが候補を捨てる／拾う大きさ（criteria.json botGrid B7）。 */
  var BIG = 1e9;
  /** 候補の数 M（うち 1 つは「置かない」）と、位置の試行の上限（botGrid B2）。 */
  var M = 6, TRIALS = 50;
  /** イーターが左へ進むグライダーを食える向き（selftest が走らせて確かめる）。 */
  var EATER_ORIENTS = [1, 2, 4, 5];

  var ORI = {};
  P.SHELF.forEach(function (p) { ORI[p.id] = P.allOrientations(p); });

  function ri(r, lo, hi) { return lo + Math.floor(r() * (hi - lo + 1)); }
  function key(x, y) { return x + ',' + y; }

  function cellsAt(ori, x0, y0) { return ori.cells.map(function (c) { return [x0 + c[0], y0 + c[1]]; }); }

  /** 全セルが自陣の中の死んだセルで、avoid に当たらないか。 */
  function fits(view, cells, avoid) {
    for (var i = 0; i < cells.length; i++) {
      var x = cells[i][0], y = cells[i][1];
      if (x < 0 || y < 0 || x >= view.zoneW || y >= view.zoneH) return false;
      if (view.sim.get(x, y) !== 0) return false;
      if (avoid && avoid[key(x, y)]) return false;
    }
    return true;
  }

  function addAvoid(avoid, cells) {
    var out = Object.assign({}, avoid);
    cells.forEach(function (c) { out[key(c[0], c[1])] = true; });
    return out;
  }

  /**
   * 向き ori のパターンを、外接矩形の右端が [xrLo, xrHi]・上端が [yLo, yHi]（省略時は自陣の全域）にあるように、
   * 乱択の位置へ置く（最大 TRIALS 回）。置けなければ null。
   */
  function placeRandom(view, r, ori, xrLo, xrHi, avoid) {
    var b = ori.box;
    var xr0 = Math.max(xrLo, b.w - 1), xr1 = Math.min(xrHi, view.zoneW - 1);
    var y1 = view.zoneH - b.h;
    if (xr0 > xr1 || y1 < 0) return null;
    for (var t = 0; t < TRIALS; t++) {
      var xr = ri(r, xr0, xr1), y0 = ri(r, 0, y1);
      var cells = cellsAt(ori, xr - b.w + 1, y0);
      if (fits(view, cells, avoid)) return cells;
    }
    return null;
  }

  /** 向きを選ぶ: 進む向きが条件を満たす向きから一様乱択。 */
  function pickOrient(r, id, pred) {
    var list = ORI[id].filter(function (o) { return pred(o.vel); });
    return list[Math.floor(r() * list.length)];
  }

  /** 「敵陣へ向かう」: 2 人戦では +x、4 人戦では斜めは対角の自陣（+1,+1）・直交は左右の隣の自陣（+x）。 */
  function towardEnemy(view, id) {
    var ortho = id === 'lwss';
    if (view.mode === '4p' && !ortho) return function (v) { return v.dx > 0 && v.dy > 0; };
    return function (v) { return v.dx > 0; };
  }

  // ------------------------------------------------------------------ 延命のグライダー
  /**
   * 自陣の前線寄り（中立地帯側の端から 8〜14 列目）から、自分側の外周へ向かう 2 つの斜めの向きの一方で放つ 5 セル。
   * 窓の終わり（第 R ティック）まで自陣の中を飛び続けられる位置に置く。そういう位置が無ければ盤の中で飛び続けられる位置、
   * それも無ければ置ける位置（criteria の文言のとおり）。
   */
  function extensionGlider(view, r, avoid) {
    var g = P.BY_ID.glider, oris = ORI.glider.filter(function (o) { return o.vel.dx < 0; });
    var steps = Math.floor(view.R / g.speed.period);
    var cols = { lo: view.zoneW - 14, hi: view.zoneW - 8 };
    var tiers = [{ w: view.zoneW, h: view.zoneH }, { w: view.w, h: view.h }, null];
    for (var ti = 0; ti < tiers.length; ti++) {
      var tier = tiers[ti], cand = [];
      oris.forEach(function (ori) {
        var b = ori.box, dxT = ori.vel.dx * steps, dyT = ori.vel.dy * steps;
        for (var x0 = Math.max(0, cols.lo); x0 + b.w - 1 <= cols.hi; x0++) {
          for (var y0 = 0; y0 + b.h <= view.zoneH; y0++) {
            if (tier && (x0 + dxT < 0 || x0 + b.w - 1 + dxT >= tier.w || y0 + dyT < 0 || y0 + b.h - 1 + dyT >= tier.h)) continue;
            var cells = cellsAt(ori, x0, y0);
            if (fits(view, cells, avoid)) cand.push(cells);
          }
        }
      });
      if (cand.length) return cand[Math.min(cand.length - 1, Math.floor(r() * cand.length))];
    }
    return null;
  }

  // ------------------------------------------------------------------ 候補生成器 G（B2・B7 共通）
  /** 置ける（コスト ≤ 銀行の残高）棚のパターンを一様乱択 → D4 の 8 向きを乱択 → 全セルが死んだセルに載る位置を乱択。 */
  function genOne(view, r) {
    var affordable = P.SHELF.filter(function (p) { return p.cost <= view.bank; });
    if (!affordable.length) return null;
    var pat = affordable[Math.floor(r() * affordable.length)];
    var ori = ORI[pat.id][ri(r, 0, 7)], b = ori.box;
    if (b.w > view.zoneW || b.h > view.zoneH) return null; // 自陣に収まらない向きは置けない（試行しても見つからない）
    for (var t = 0; t < TRIALS; t++) {
      var x0 = ri(r, 0, view.zoneW - b.w), y0 = ri(r, 0, view.zoneH - b.h);
      var cells = cellsAt(ori, x0, y0);
      if (fits(view, cells, null)) return { cells: cells, names: [pat.id], cost: pat.cost };
    }
    return null;
  }

  /** M = 6 の候補（G から 5 つ・最後に「置かない」）。G が失敗した候補は「置かない」に置き換える。 */
  function candidates(view, r) {
    var list = [];
    for (var i = 0; i < M - 1; i++) list.push(genOne(view, r) || { cells: [], names: [], cost: 0 });
    list.push({ cells: [], names: [], cost: 0 });
    return list;
  }

  // ------------------------------------------------------------------ 先読み
  /**
   * 候補を盤の写しに置いて R ティック先まで走らせ、評価を返す（相手は置かないと仮定）。
   * 評価 = ラウンド終了時の（自分の所属セル数 − 相手の所属セル数の最大値）。自分が（途中で）全滅するか窓で周期化すれば −10^9、
   * 開始時にセルのあった相手が全員敗退（全滅か周期化）すれば +10^9 を足す。
   */
  function evaluate(view, sim, cand) {
    sim.copyFrom(view.sim);
    var opp = [], np = view.np, L;
    for (L = 2; L <= np; L++) if (sim.cur.counts[L] > 0) opp.push(L);
    cand.cells.forEach(function (c) { sim.set(c[0], c[1], 1); });
    var ownExtinct = sim.cur.counts[1] === 0, oppExtinct = {};
    opp.forEach(function (l) { if (sim.cur.counts[l] === 0) oppExtinct[l] = true; });
    for (var k = 0; k < view.R; k++) {
      sim.step();
      if (sim.cur.counts[1] === 0) ownExtinct = true;
      opp.forEach(function (l) { if (sim.cur.counts[l] === 0) oppExtinct[l] = true; });
    }
    var win = sim.lastSnapshots(view.W), wj = S.analyzeWindow(win, view.w, view.Pmax);
    var judged = wj.n >= view.W;
    var ownPeriodic = judged && wj.owned[1] > 0 && wj.np[1] === 0;
    var maxOpp = 0;
    for (L = 2; L <= np; L++) if (sim.cur.counts[L] > maxOpp) maxOpp = sim.cur.counts[L];
    var v = sim.cur.counts[1] - maxOpp;
    if (ownExtinct || ownPeriodic) v -= BIG;
    if (opp.length > 0 && opp.every(function (l) { return oppExtinct[l] || (judged && wj.owned[l] > 0 && wj.np[l] === 0); })) v += BIG;
    return v;
  }

  // ------------------------------------------------------------------ bot
  function makeBot(policy, rngSeed, label) {
    var r = S.rng(rngSeed >>> 0);
    var scratch = null;

    function decide(view) {
      var out = { cells: [], names: [], cost: 0, look: null };
      var bank = view.bank, ext;
      var acc = function (cells, name) { out.cells = out.cells.concat(cells); out.names.push(name); out.cost += cells.length; };
      var avoidOf = function () { return addAvoid(null, out.cells); };

      if (policy === 'B0') {
        if (view.round === 1) {
          var affordable = P.SHELF.filter(function (p) { return p.cost <= bank; });
          if (affordable.length) {
            var pat = affordable[Math.floor(r() * affordable.length)], ori = ORI[pat.id][ri(r, 0, 7)];
            var bb = ori.box;
            for (var t = 0; t < TRIALS && bb.w <= view.zoneW && bb.h <= view.zoneH; t++) {
              var cells = cellsAt(ori, ri(r, 0, view.zoneW - bb.w), ri(r, 0, view.zoneH - bb.h));
              if (fits(view, cells, null)) { acc(cells, pat.id); break; }
            }
          }
        }
      } else if (policy === 'B1') {
        if (bank > 0) {
          var fx = ri(r, 0, view.zoneW - 5), fy = ri(r, 0, view.zoneH - 5), free = [];
          for (var yy = 0; yy < 5; yy++) for (var xx = 0; xx < 5; xx++) if (view.sim.get(fx + xx, fy + yy) === 0) free.push([fx + xx, fy + yy]);
          var pick = [], n = Math.min(bank, free.length);
          for (var i = 0; i < n; i++) { var j = i + Math.floor(r() * (free.length - i)); var tmp = free[i]; free[i] = free[j]; free[j] = tmp; pick.push(free[i]); }
          if (pick.length) acc(pick, 'soup');
        }
      } else if (policy === 'B2' || policy === 'B7') {
        var cands = candidates(view, r), chosen;
        if (policy === 'B2') {
          chosen = Math.floor(r() * M);
        } else {
          if (!scratch) scratch = new S.Sim(view.w, view.h, view.W);
          var values = cands.map(function (c) { return evaluate(view, scratch, c); });
          chosen = 0;
          for (var q = 1; q < values.length; q++) if (values[q] > values[chosen]) chosen = q; // 同点は生成順（先のもの）
          out.look = { values: values, chosen: chosen, names: cands.map(function (c) { return c.names[0] || '-'; }) };
        }
        if (cands[chosen].cells.length) acc(cands[chosen].cells, cands[chosen].names[0]);
      } else if (policy === 'B3') {
        var id = bank >= 9 ? 'lwss' : bank >= 5 ? 'glider' : null;
        if (id) {
          var ori3 = pickOrient(r, id, towardEnemy(view, id));
          var c3 = placeRandom(view, r, ori3, view.zoneW - 6, view.zoneW - 1, null);
          if (c3) acc(c3, id);
        }
      } else if (policy === 'B4') {
        if (bank >= 5) { ext = extensionGlider(view, r, null); if (ext) acc(ext, 'glider-ext'); }
        var rest = bank - out.cost;
        if (rest >= 7) {
          var oriE = ORI.eater1[EATER_ORIENTS[Math.floor(r() * EATER_ORIENTS.length)]];
          var ce = placeRandom(view, r, oriE, view.zoneW - 4, view.zoneW - 2, avoidOf());
          if (ce) acc(ce, 'eater1');
        } else if (rest >= 4) {
          var oriB = ORI.block[0];
          for (var tb = 0; tb < TRIALS; tb++) {
            var cb = cellsAt(oriB, ri(r, 15, 24), ri(r, 0, view.zoneH - 2));
            if (fits(view, cb, avoidOf())) { acc(cb, 'block'); break; }
          }
        }
      } else if (policy === 'B5') {
        if (bank >= 5) { ext = extensionGlider(view, r, null); }
        if (ext) acc(ext, 'glider-ext');
        if (bank >= 36 + 5 && ext) {
          var oriG = pickOrient(r, 'gun', towardEnemy(view, 'gun'));
          var cg = placeRandom(view, r, oriG, view.zoneW - 12, view.zoneW - 1, avoidOf());
          if (cg) acc(cg, 'gun');
        }
      } else if (policy === 'B6') {
        var firstBox = null;
        if (bank >= 7) {
          var oriA = ORI.acorn[ri(r, 0, 7)], ca = placeRandom(view, r, oriA, view.zoneW - 12, view.zoneW - 1, null);
          if (ca) { acc(ca, 'acorn'); firstBox = P.bbox(ca); }
        }
        var left = bank - out.cost;
        if (left >= 5) {
          var oriR = ORI.rpent[ri(r, 0, 7)], ok = false;
          for (var tr = 0; tr < TRIALS && !ok; tr++) {
            var cr = placeRandom(view, r, oriR, view.zoneW - 12, view.zoneW - 1, avoidOf());
            if (!cr) break;
            var bx = P.bbox(cr);
            var gapX = firstBox ? Math.max(firstBox.x0 - bx.x1 - 1, bx.x0 - firstBox.x1 - 1) : 99;
            var gapY = firstBox ? Math.max(firstBox.y0 - bx.y1 - 1, bx.y0 - firstBox.y1 - 1) : 99;
            if (Math.max(gapX, gapY) >= 6) { acc(cr, 'rpent'); ok = true; }
          }
        }
      } else {
        throw new Error('unknown bot policy: ' + policy);
      }
      out.label = label;
      return out;
    }
    return { policy: policy, label: label, decide: decide };
  }

  /** 乱数の系列の種 = hash(シード, bot の id, 番号)。A4 では bot の id の代わりにラベルの id を渡す。 */
  function rngSeedFor(seed, id, idx) { return S.hash32(seed + '|' + id + '|' + idx); }

  return {
    BOT_IDS: BOT_IDS, BOT_NAMES: BOT_NAMES, makeBot: makeBot, rngSeedFor: rngSeedFor,
    EATER_ORIENTS: EATER_ORIENTS, M: M, TRIALS: TRIALS, BIG: BIG, ORI: ORI,
    extensionGlider: extensionGlider, genOne: genOne, candidates: candidates, evaluate: evaluate,
  };
});
