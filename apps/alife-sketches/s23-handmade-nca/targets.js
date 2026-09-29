/**
 * S-23 の目標の形（観測器の側）。core.js はこれを知らない（coord の参照点だけが絵を受け取る）。
 *
 *   disc   … 半径 R の円板（ラベル 1）
 *   ring   … 同じ円板の中の帯 rLo ≤ r ≤ rHi をラベル 2、残りをラベル 1
 *   flag   … 同じ円板を x で 3 分割（Wolpert の French flag）。左 1 / 中 2 / 右 3
 *   bitmap … 非対称な手描きの輪郭（ラベル 1）。手設計の規則族には対応する規則が無い
 *
 * すべて中心 (L>>1, L>>1)。返り値は { labels: Uint8Array(L*L), K, name, count }。
 * 依存ゼロ・古典スクリプト・UMD 風（Node では module.exports、ブラウザでは window.S23T）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S23T = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var R = 12, RING_LO = 7, RING_HI = 11, FLAG_HALF = 4;

  function blank(L, name, K) {
    return { labels: new Uint8Array(L * L), K: K, name: name, L: L, cx: L >> 1, cy: L >> 1, count: 0 };
  }
  function finish(t) {
    var c = 0;
    for (var i = 0; i < t.labels.length; i++) if (t.labels[i] > 0) c++;
    t.count = c;
    return t;
  }

  function disc(L, radius) {
    var r = radius === undefined ? R : radius, t = blank(L, 'disc', 1), r2 = r * r;
    for (var y = 0; y < L; y++) for (var x = 0; x < L; x++) {
      var dx = x - t.cx, dy = y - t.cy;
      if (dx * dx + dy * dy <= r2) t.labels[y * L + x] = 1;
    }
    return finish(t);
  }

  function ring(L) {
    var t = blank(L, 'ring', 2), r2 = R * R, lo2 = RING_LO * RING_LO, hi2 = RING_HI * RING_HI;
    for (var y = 0; y < L; y++) for (var x = 0; x < L; x++) {
      var dx = x - t.cx, dy = y - t.cy, q = dx * dx + dy * dy;
      if (q <= r2) t.labels[y * L + x] = (q >= lo2 && q <= hi2) ? 2 : 1;
    }
    return finish(t);
  }

  function flag(L) {
    var t = blank(L, 'flag', 3), r2 = R * R;
    for (var y = 0; y < L; y++) for (var x = 0; x < L; x++) {
      var dx = x - t.cx, dy = y - t.cy;
      if (dx * dx + dy * dy <= r2) t.labels[y * L + x] = dx < -FLAG_HALF ? 1 : (dx > FLAG_HALF ? 3 : 2);
    }
    return finish(t);
  }

  /** 手描きの輪郭（25×21）。頭が左、尾が右上へ曲がる。左右も上下も非対称。 */
  var BITMAP_ROWS = [
    '.......................##',
    '......................##.',
    '.....................##..',
    '....................##...',
    '...................##....',
    '..........#########......',
    '.......###############...',
    '.....#################...',
    '...##################....',
    '..###################....',
    '.###################.....',
    '.##################......',
    '..#################......',
    '...###############.......',
    '.....####.#####..........',
    '....###....####..........',
    '...##.......###..........',
    '..##.........##..........',
    '.##...........##.........',
    '##.............##........',
    '#...............#........',
  ];

  function bitmap(L) {
    var t = blank(L, 'bitmap', 1), h = BITMAP_ROWS.length, w = BITMAP_ROWS[0].length;
    var x0 = t.cx - (w >> 1), y0 = t.cy - (h >> 1);
    for (var r = 0; r < h; r++) for (var c = 0; c < w; c++) {
      if (BITMAP_ROWS[r][c] === '#') t.labels[(y0 + r) * L + (x0 + c)] = 1;
    }
    return finish(t);
  }

  function byName(name, L) {
    if (name === 'disc') return disc(L);
    if (name === 'ring') return ring(L);
    if (name === 'flag') return flag(L);
    if (name === 'bitmap') return bitmap(L);
    throw new Error('unknown target ' + name);
  }

  /** 面積がちょうど count 以上になる最小の離散半径（等面積円板）。 */
  function equalAreaRadius(L, count) {
    for (var r = 1; r < L; r++) if (disc(L, r).count >= count) return r;
    return L;
  }

  /** 密度 p の目標と独立な密度 q のマスクの IoU の期待値（比の期待値の近似）。 */
  function chanceIoU(p, q) { return p * q / (p + q - p * q); }

  /** 一辺 side の正方形と半径 r の円板の IoU（離散の計数。hop の解析的予測）。 */
  function squareDiscIoU(L, side, r) {
    var t = disc(L, r), half = (side - 1) / 2, inter = 0, union = 0;
    for (var y = 0; y < L; y++) for (var x = 0; x < L; x++) {
      var inSq = Math.abs(x - t.cx) <= half && Math.abs(y - t.cy) <= half;
      var inD = t.labels[y * L + x] > 0;
      if (inSq && inD) inter++;
      if (inSq || inD) union++;
    }
    return { iou: inter / union, square: side * side, disc: t.count, inter: inter, union: union };
  }

  return {
    R: R, RING_LO: RING_LO, RING_HI: RING_HI, FLAG_HALF: FLAG_HALF, BITMAP_ROWS: BITMAP_ROWS,
    disc: disc, ring: ring, flag: flag, bitmap: bitmap, byName: byName,
    equalAreaRadius: equalAreaRadius, chanceIoU: chanceIoU, squareDiscIoU: squareDiscIoU,
    NAMES: ['disc', 'ring', 'flag', 'bitmap'],
  };
});
