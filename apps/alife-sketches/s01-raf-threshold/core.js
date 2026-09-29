/**
 * S-01: 自己触媒集合（RAF）の出現閾値
 *
 * Kauffman の二値ポリマーモデルの上で、触媒率を制御変数として掃引し、
 * RAF（Reflexively Autocatalytic and Food-generated set）が現れる閾値を測る。
 *
 * 依存ゼロ。Node（生ログ生成）とブラウザ（可視化）の両方から同じファイルを読む。
 * file:// で開く都合上、ES module ではなく古典スクリプト + UMD 風の露出にしてある。
 *
 * 出典（アイデアのみ。コードは参照していない）:
 *   Kauffman (1986) "Autocatalytic sets of proteins"
 *   Hordijk & Steel (2004) "Detecting autocatalytic, self-sustaining sets in chemical reaction systems"
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S01 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 決定論的な擬似乱数（mulberry32）。シードを固定すれば完全に再現する。 */
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * 分子と反応の集合を作る。ここには「触媒」「生命」などの上位概念は無く、
   * 文字列の連結という操作しか無い。
   *
   * @param {number} maxLen   分子（二値文字列）の最大長
   * @param {number} foodLen  食物集合に含める最大長
   */
  function buildChemistry(maxLen, foodLen) {
    var molecules = [];
    var index = Object.create(null);
    for (var len = 1; len <= maxLen; len++) {
      var count = 1 << len;
      for (var v = 0; v < count; v++) {
        var s = v.toString(2);
        while (s.length < len) s = '0' + s;
        index[s] = molecules.length;
        molecules.push(s);
      }
    }

    // 連結反応 a + b -> ab（|a|+|b| <= maxLen のもの全て）
    var reactions = [];
    for (var i = 0; i < molecules.length; i++) {
      for (var j = 0; j < molecules.length; j++) {
        if (molecules[i].length + molecules[j].length > maxLen) continue;
        reactions.push({ a: i, b: j, p: index[molecules[i] + molecules[j]] });
      }
    }

    var food = [];
    for (var k = 0; k < molecules.length; k++) {
      if (molecules[k].length <= foodLen) food.push(k);
    }

    return { molecules: molecules, index: index, reactions: reactions, food: food };
  }

  /**
   * 各反応へ触媒を割り当てる。各分子は各反応を独立に確率 p で触媒する。
   * p が小さいので、全組を回さず幾何分布のスキップで成功だけを拾う。
   */
  function assignCatalysts(chem, p, rng) {
    var nMol = chem.molecules.length;
    var nRxn = chem.reactions.length;
    var catalystsOf = new Array(nRxn);
    if (p <= 0) {
      for (var z = 0; z < nRxn; z++) catalystsOf[z] = [];
      return catalystsOf;
    }
    var logQ = Math.log(1 - p);
    for (var r = 0; r < nRxn; r++) {
      var list = [];
      var idx = -1;
      for (;;) {
        idx += 1 + Math.floor(Math.log(1 - rng()) / logQ);
        if (idx >= nMol) break;
        list.push(idx);
      }
      catalystsOf[r] = list;
    }
    return catalystsOf;
  }

  /** 食物集合から反応集合 active をたどって到達できる分子（前向き閉包）。 */
  function closure(chem, activeFlags, nMol) {
    var present = new Uint8Array(nMol);
    for (var f = 0; f < chem.food.length; f++) present[chem.food[f]] = 1;
    var rxns = chem.reactions;
    var changed = true;
    while (changed) {
      changed = false;
      for (var r = 0; r < rxns.length; r++) {
        if (!activeFlags[r]) continue;
        var rx = rxns[r];
        if (present[rx.a] && present[rx.b] && !present[rx.p]) {
          present[rx.p] = 1;
          changed = true;
        }
      }
    }
    return present;
  }

  /**
   * maxRAF を求める（Hordijk-Steel の反復除去）。
   *
   * 「自己触媒集合」を探しているが、系の規則そのものには自己触媒という語も概念も無い。
   * これは観測器の側の語彙であって、化学の側の語彙ではない。
   */
  function computeMaxRAF(chem, catalystsOf) {
    var nMol = chem.molecules.length;
    var nRxn = chem.reactions.length;
    var active = new Uint8Array(nRxn);
    active.fill(1);
    var rounds = 0;

    for (;;) {
      rounds++;
      var present = closure(chem, active, nMol);
      var removed = 0;
      for (var r = 0; r < nRxn; r++) {
        if (!active[r]) continue;
        var rx = chem.reactions[r];
        var ok = present[rx.a] === 1 && present[rx.b] === 1;
        if (ok) {
          ok = false;
          var cats = catalystsOf[r];
          for (var c = 0; c < cats.length; c++) {
            if (present[cats[c]]) { ok = true; break; }
          }
        }
        if (!ok) { active[r] = 0; removed++; }
      }
      if (removed === 0) break;
    }

    var size = 0;
    for (var q = 0; q < nRxn; q++) if (active[q]) size++;
    var finalPresent = closure(chem, active, nMol);
    var molCount = 0;
    for (var m = 0; m < nMol; m++) if (finalPresent[m]) molCount++;

    return {
      active: active,
      present: finalPresent,
      rafReactions: size,
      rafMolecules: size > 0 ? molCount : chem.food.length,
      rounds: rounds,
    };
  }

  /**
   * 1 レプリケート（触媒率 f・シード seed）を走らせる。
   * f = 1分子あたりが触媒する反応の平均本数（標準的な制御変数）。
   */
  function runReplicate(chem, f, seed) {
    var p = f / chem.reactions.length;
    var rng = makeRng(seed);
    var catalystsOf = assignCatalysts(chem, p, rng);
    var raf = computeMaxRAF(chem, catalystsOf);
    return {
      f: f,
      seed: seed,
      p: p,
      rafReactions: raf.rafReactions,
      rafMolecules: raf.rafMolecules,
      rafFraction: raf.rafReactions / chem.reactions.length,
      hasRaf: raf.rafReactions > 0,
      rounds: raf.rounds,
      active: raf.active,
      present: raf.present,
    };
  }

  /** 掃引の1点（同じ f を seeds 本走らせて集約する）。 */
  function runPoint(chem, f, seeds, seedBase) {
    var hits = 0;
    var sizes = [];
    for (var s = 0; s < seeds; s++) {
      var rep = runReplicate(chem, f, seedBase + s * 7919);
      if (rep.hasRaf) hits++;
      sizes.push(rep.rafReactions);
    }
    sizes.sort(function (x, y) { return x - y; });
    var mean = 0;
    for (var i = 0; i < sizes.length; i++) mean += sizes[i];
    mean /= sizes.length;
    return {
      f: f,
      seeds: seeds,
      pRaf: hits / seeds,
      meanRafReactions: mean,
      medianRafReactions: sizes[Math.floor(sizes.length / 2)],
      maxRafReactions: sizes[sizes.length - 1],
      sizes: sizes,
    };
  }

  /**
   * 事前登録した判定基準（D1 / D2）で閾値を決める。
   * 実験の後に閾値を選ばないため、しきい値は引数として外から与える。
   */
  function detectThreshold(points, criterion) {
    for (var i = 0; i < points.length; i++) {
      if (points[i].pRaf >= criterion.pRafThreshold) {
        return { crossed: true, f: points[i].f, index: i };
      }
    }
    return { crossed: false, f: null, index: -1 };
  }

  return {
    makeRng: makeRng,
    buildChemistry: buildChemistry,
    assignCatalysts: assignCatalysts,
    computeMaxRAF: computeMaxRAF,
    runReplicate: runReplicate,
    runPoint: runPoint,
    detectThreshold: detectThreshold,
  };
});
