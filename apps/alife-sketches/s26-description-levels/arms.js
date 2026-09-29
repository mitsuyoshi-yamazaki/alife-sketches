/**
 * S-26 の腕（何を置くか・どの規則を使うか）。
 *
 * core.js（規則）と levels.js（観測器）のあいだに立つ、**実験の設定**だけを持つファイル。
 * 走らせ役（run.js）・検査（selftest.js）・見せ役（viewer.html）がこれを共用する。
 *
 * **シードが決めるのはトーラス上の置き場所だけ**である（soup・iid・忘れ方を除く）。
 * つまり still・blink・movers・gun・gunOpen・drift は**シードを変えても物理は同じ**で、
 * 変わるのは配置の平行移動だけ——[K-47] が言う「シードは証拠にならない」場合にあたる。
 * この事実は criteria.json の seedCheck に事前に書き、生ログでも確かめる。
 *
 * 吸収体の位置 (58, 44) は、**本番の前に機械で探した**もの（gosper を (2,2) に置いたときの
 * 生成物の進路 y − x ≈ −13.5 の上で、500 ステップ走らせて総質量が 120 を超えない位置を総当たり）。
 * これは配置の決定であって判定基準の決定ではない。
 */
(function (root, factory) {
  var api = factory(typeof module === 'object' && module.exports ? require('./core.js') : root.S26);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S26A = api;
})(typeof self !== 'undefined' ? self : this, function (S26) {
  'use strict';

  var GUN_AT = [2, 2];
  var EATER_AT = [58, 44];

  /** 腕の定義。fit は「その腕が収まる最小の L」。 */
  var ARMS = {
    still:     { rule: 'local', kind: 'scatter', shapes: ['block', 'beehive', 'loaf', 'boat', 'tub', 'ship'], fit: 48 },
    blink:     { rule: 'local', kind: 'scatter', shapes: ['blinker', 'blinker', 'blinker', 'blinker', 'toad', 'toad'], fit: 48 },
    movers:    { rule: 'local', kind: 'gliders', count: 4, fit: 48 },
    gun:       { rule: 'local', kind: 'gun', eater: true, fit: 80 },
    gunOpen:   { rule: 'local', kind: 'gun', eater: false, fit: 80 },
    soup:      { rule: 'local', kind: 'soup', density: 0.35, fit: 32 },
    drift:     { rule: 'drift', kind: 'gliders', count: 4, fit: 48 },
    iidSparse: { rule: 'refill', kind: 'empty', density: 0.00217, fit: 32 },
    iidDense:  { rule: 'refill', kind: 'empty', density: 0.0659, fit: 32 },
  };

  var ORDER = ['still', 'blink', 'movers', 'gun', 'gunOpen', 'soup', 'drift', 'iidSparse', 'iidDense'];
  /** 忘れ方（参照点）を当てる基層。K-33。 */
  var FORGET_BASES = ['movers', 'gun', 'soup'];
  var FORGETTINGS = ['shift', 'scramble'];

  /** 腕の名前の一覧（忘れ方を当てたものも含む）。 */
  function armNames() {
    var out = ORDER.slice();
    FORGET_BASES.forEach(function (b) {
      FORGETTINGS.forEach(function (f) { out.push(b + '+' + f); });
    });
    return out;
  }

  function parseArm(name) {
    var i = name.indexOf('+');
    if (i < 0) return { base: name, forget: 'none' };
    return { base: name.slice(0, i), forget: name.slice(i + 1) };
  }

  /**
   * 腕の初期の場を作る。seed は**置き場所のオフセット**（soup・iid では場の中身）を決める。
   */
  function buildField(base, opts) {
    var spec = ARMS[base];
    if (!spec) throw new Error('unknown arm: ' + base);
    var L = opts.L, seed = opts.seed;
    var F = S26.createField({
      L: L, seed: seed,
      mode: spec.rule === 'local' ? 'local' : spec.rule,
      density: spec.density,
    });
    var rng = S26.makeRng(seed * 7919 + 13);

    if (spec.kind === 'scatter') {
      // 3×2 の区画へ1つずつ置く。区画の中でだけ揺らすので、置いたものどうしは触れない。
      var cw = Math.floor(L / 3), ch = Math.floor(L / 2), m = 6;
      for (var i = 0; i < spec.shapes.length; i++) {
        var gx = i % 3, gy = (i / 3) | 0;
        var ox = gx * cw + m + ((rng() * Math.max(1, cw - 2 * m - 5)) | 0);
        var oy = gy * ch + m + ((rng() * Math.max(1, ch - 2 * m - 5)) | 0);
        S26.place(F, S26.SHAPES[spec.shapes[i]], ox, oy);
      }
    } else if (spec.kind === 'gliders') {
      // すべて同じ向きなので相対位置が変わらない——**窓の間に衝突しない**。
      var q = Math.floor(L / 2), mg = 8;
      for (var g = 0; g < spec.count; g++) {
        var qx = g % 2, qy = (g / 2) | 0;
        var px = qx * q + mg + ((rng() * Math.max(1, q - 2 * mg - 4)) | 0);
        var py = qy * q + mg + ((rng() * Math.max(1, q - 2 * mg - 4)) | 0);
        S26.place(F, S26.SHAPES.glider, px, py);
      }
    } else if (spec.kind === 'gun') {
      // シードは配置全体を平行移動するだけ（相対の幾何は保つ）
      var sx = (rng() * L) | 0, sy = (rng() * L) | 0;
      S26.place(F, S26.SHAPES.gosper, GUN_AT[0] + sx, GUN_AT[1] + sy);
      if (spec.eater) S26.place(F, S26.SHAPES.eater, EATER_AT[0] + sx, EATER_AT[1] + sy);
    } else if (spec.kind === 'soup') {
      S26.fillRandom(F, spec.density, rng);
    } else if (spec.kind === 'empty') {
      S26.fillRandom(F, spec.density, rng);
    }
    return F;
  }

  return {
    ARMS: ARMS, ORDER: ORDER, FORGET_BASES: FORGET_BASES, FORGETTINGS: FORGETTINGS,
    GUN_AT: GUN_AT, EATER_AT: EATER_AT,
    armNames: armNames, parseArm: parseArm, buildField: buildField,
  };
});
