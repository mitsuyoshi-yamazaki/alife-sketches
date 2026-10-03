/**
 * S-72 パターンの棚（criteria.json の ceilings「パターンの棚」の 10 種）と、向きの変換（D4 の 8 通り）。
 *
 * 数字（セル数）= コスト。配置は Life Lexicon Release 29 の各項の図から取った（criteria.json borrowedConstants の
 * patternShelf）。**ここに書いた形と、その既知の振る舞い（周期・速度・消滅の世代）が一致することは selftest.js が
 * 素の B3/S23 の参照実装で機械的に確かめる**——記憶から書いた図は、走らせて確かめるまで信用しない。
 *
 * 座標は (x, y) で x が右、y が下。原点は各パターンの外接矩形の左上。
 *
 * 依存ゼロ・古典スクリプト。Node とブラウザで共用（Node: `require('./patterns.js')` / ブラウザ: `window.S72Patterns`）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S72Patterns = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 図（'O' が 1 セル）→ 座標の配列。 */
  function parse(rows) {
    var out = [];
    rows.forEach(function (row, y) {
      for (var x = 0; x < row.length; x++) if (row.charAt(x) === 'O') out.push([x, y]);
    });
    return out;
  }

  /**
   * 棚。順序は固定（B0・B2・B7 の一様乱択が棚の順序に依るため）。
   * lexicon = Life Lexicon R29 での項目名（criteria.json ceilings の shelf.json に残す出典）。
   * speed = 移動する形の速度（dx, dy は period ティックで進む量。**基準の向きでの値**）。
   */
  var SHELF = [
    { id: 'block', name: 'block', lexicon: 'block', cost: 4, period: 1, rows: ['OO', 'OO'] },
    { id: 'beehive', name: 'beehive', lexicon: 'beehive', cost: 6, period: 1, rows: ['.OO.', 'O..O', '.OO.'] },
    { id: 'blinker', name: 'blinker', lexicon: 'blinker', cost: 3, period: 2, rows: ['OOO'] },
    { id: 'glider', name: 'glider', lexicon: 'glider', cost: 5, period: 4, rows: ['.O.', '..O', 'OOO'], speed: { dx: 1, dy: 1, period: 4 } },
    { id: 'lwss', name: 'LWSS', lexicon: 'lightweight spaceship', cost: 9, period: 4, rows: ['.O..O', 'O....', 'O...O', 'OOOO.'], speed: { dx: -2, dy: 0, period: 4 } },
    { id: 'eater1', name: 'eater1', lexicon: 'eater', cost: 7, period: 1, rows: ['OO..', 'O.O.', '..O.', '..OO'] },
    { id: 'rpent', name: 'R-pentomino', lexicon: 'R-pentomino', cost: 5, period: 0, rows: ['.OO', 'OO.', '.O.'] },
    { id: 'acorn', name: 'acorn', lexicon: 'acorn', cost: 7, period: 0, rows: ['.O.....', '...O...', 'OO..OOO'] },
    { id: 'diehard', name: 'diehard', lexicon: 'diehard', cost: 7, period: 0, rows: ['......O.', 'OO......', '.O...OOO'] },
    {
      id: 'gun', name: 'Gosper glider gun', lexicon: 'Gosper glider gun', cost: 36, period: 30,
      rows: [
        '........................O...........',
        '......................O.O...........',
        '............OO......OO............OO',
        '...........O...O....OO............OO',
        'OO........O.....O...OO..............',
        'OO........O...O.OO....O.O...........',
        '..........O.....O.......O...........',
        '...........O...O....................',
        '............OO......................',
      ],
      speed: { dx: 1, dy: 1, period: 4 }, // 流れ（グライダー）の進む向き
    },
  ].map(function (p) {
    var cells = parse(p.rows);
    return Object.freeze(Object.assign({}, p, { cells: cells, rows: undefined, art: p.rows }));
  });

  var BY_ID = {};
  SHELF.forEach(function (p) { BY_ID[p.id] = p; });

  /**
   * D4 の 8 通りの向き。o = rot + 4 * flip（rot = 90 度回転の回数 0〜3、flip = 先に左右反転するか）。
   * 変換後は外接矩形の左上が (0, 0) になるよう平行移動する。
   */
  function orient(cells, o) {
    var rot = o & 3, flip = o >> 2;
    var pts = cells.map(function (c) {
      var x = flip ? -c[0] : c[0], y = c[1];
      for (var r = 0; r < rot; r++) { var t = x; x = -y; y = t; }
      return [x, y];
    });
    var mx = Infinity, my = Infinity;
    pts.forEach(function (p) { if (p[0] < mx) mx = p[0]; if (p[1] < my) my = p[1]; });
    return pts.map(function (p) { return [p[0] - mx, p[1] - my]; })
      .sort(function (a, b) { return a[1] - b[1] || a[0] - b[0]; });
  }

  /** ベクトルへ同じ変換を施す（速度の向きを求める。平行移動は無関係）。 */
  function orientVec(dx, dy, o) {
    var rot = o & 3, flip = o >> 2;
    var x = flip ? -dx : dx, y = dy;
    for (var r = 0; r < rot; r++) { var t = x; x = -y; y = t; }
    return { dx: x, dy: y };
  }

  function bbox(cells) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    cells.forEach(function (c) {
      if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0];
      if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1];
    });
    return { x0: x0, y0: y0, x1: x1, y1: y1, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  }

  /** 8 通りの向きの一覧（同じ形になる向きも含めて 8 つ。一様乱択が向きの数え方に依らないように）。 */
  function allOrientations(p) {
    var out = [];
    for (var o = 0; o < 8; o++) {
      var cells = orient(p.cells, o);
      var v = p.speed ? orientVec(p.speed.dx, p.speed.dy, o) : null;
      out.push({ o: o, cells: cells, box: bbox(cells), vel: v });
    }
    return out;
  }

  /** shelf.json に残す形（セル配置・コスト・出典の項目名）。 */
  function shelfRecord() {
    return SHELF.map(function (p) {
      return { id: p.id, name: p.name, lexiconItem: p.lexicon, cost: p.cost, period: p.period, cells: p.cells, art: p.art, speed: p.speed || null };
    });
  }

  return { SHELF: SHELF, BY_ID: BY_ID, orient: orient, orientVec: orientVec, bbox: bbox, allOrientations: allOrientations, shelfRecord: shelfRecord, parse: parse };
});
