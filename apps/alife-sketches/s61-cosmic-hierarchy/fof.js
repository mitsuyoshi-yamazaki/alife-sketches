'use strict';
/**
 * S-61 検出器: Friends-of-Friends（周期境界）。粒子の位置だけから連結成分を取る。
 * 上位の単位の語彙（ハロー等）はここから先（observer.js が呼ぶ側）で使ってよい——
 * fof.js 自身は「連結成分」という中立の語彙にとどめる。Node とブラウザの両方で使う（UMD）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.S61FOF = factory();
})(typeof self !== 'undefined' ? self : this, function () {

function unionFind(n) {
  var parent = new Int32Array(n);
  for (var i = 0; i < n; i++) parent[i] = i;
  function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
  function union(a, b) { var ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
  return { find: find, union: union };
}

/**
 * 周期境界つき FOF。x: 長さ3*Np の位置配列、L: 箱、linkLen: 連結長（物理距離）。
 * セル表（セル辺 = linkLen）で近傍だけを走査する。
 * 戻り値: { labels: Int32Array(Np)（連結成分の代表粒子番号）, groups: Map<rep, [粒子番号...]> }
 */
function friendsOfFriends(x, Np, L, linkLen) {
  var nCells = Math.max(1, Math.floor(L / linkLen));
  var cellSize = L / nCells;
  var uf = unionFind(Np);
  var cellOf = new Int32Array(Np);
  var buckets = {};
  function cellIndex(cx, cy, cz) { return ((cx * nCells + cy) * nCells + cz); }
  for (var p = 0; p < Np; p++) {
    var cx = Math.min(nCells - 1, Math.floor(x[3 * p] / cellSize));
    var cy = Math.min(nCells - 1, Math.floor(x[3 * p + 1] / cellSize));
    var cz = Math.min(nCells - 1, Math.floor(x[3 * p + 2] / cellSize));
    var ci = cellIndex(cx, cy, cz);
    cellOf[p] = ci;
    (buckets[ci] || (buckets[ci] = [])).push(p);
  }
  var link2 = linkLen * linkLen;
  function dist2(a, b) {
    var dx = x[3 * a] - x[3 * b], dy = x[3 * a + 1] - x[3 * b + 1], dz = x[3 * a + 2] - x[3 * b + 2];
    if (dx > L / 2) dx -= L; else if (dx < -L / 2) dx += L;
    if (dy > L / 2) dy -= L; else if (dy < -L / 2) dy += L;
    if (dz > L / 2) dz -= L; else if (dz < -L / 2) dz += L;
    return dx * dx + dy * dy + dz * dz;
  }
  for (var p2 = 0; p2 < Np; p2++) {
    var cx2 = Math.min(nCells - 1, Math.floor(x[3 * p2] / cellSize));
    var cy2 = Math.min(nCells - 1, Math.floor(x[3 * p2 + 1] / cellSize));
    var cz2 = Math.min(nCells - 1, Math.floor(x[3 * p2 + 2] / cellSize));
    for (var dcx = -1; dcx <= 1; dcx++) {
      for (var dcy = -1; dcy <= 1; dcy++) {
        for (var dcz = -1; dcz <= 1; dcz++) {
          var ncx = ((cx2 + dcx) % nCells + nCells) % nCells;
          var ncy = ((cy2 + dcy) % nCells + nCells) % nCells;
          var ncz = ((cz2 + dcz) % nCells + nCells) % nCells;
          var nci = cellIndex(ncx, ncy, ncz);
          var arr = buckets[nci];
          if (!arr) continue;
          for (var k = 0; k < arr.length; k++) {
            var q = arr[k];
            if (q <= p2) continue; // 各ペアを1回だけ
            if (dist2(p2, q) <= link2) uf.union(p2, q);
          }
        }
      }
    }
  }
  var groups = {};
  for (var i = 0; i < Np; i++) {
    var r = uf.find(i);
    (groups[r] || (groups[r] = [])).push(i);
  }
  return { find: uf.find, groups: groups };
}

/** 縮む球の重心（半径0.8倍ずつ、粒子20個まで）。members: 粒子番号の配列。 */
function shrinkingSphereCenter(members, x, L, minCount) {
  minCount = minCount || 20;
  var cur = members.slice();
  var center = centroidPeriodic(cur, x, L);
  var radius = maxRadius(cur, x, L, center);
  while (cur.length > minCount && cur.length > 1) {
    radius *= 0.8;
    var next = cur.filter(function (p) { return distPeriodic(x, p, center, L) <= radius; });
    if (next.length < Math.min(minCount, cur.length)) break;
    cur = next;
    center = centroidPeriodic(cur, x, L);
  }
  return center;
}

function distPeriodic(x, p, center, L) {
  var dx = x[3 * p] - center[0], dy = x[3 * p + 1] - center[1], dz = x[3 * p + 2] - center[2];
  if (dx > L / 2) dx -= L; else if (dx < -L / 2) dx += L;
  if (dy > L / 2) dy -= L; else if (dy < -L / 2) dy += L;
  if (dz > L / 2) dz -= L; else if (dz < -L / 2) dz += L;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** 周期境界での重心（最初の粒子を基準に unwrap してから平均）。 */
function centroidPeriodic(members, x, L) {
  var refx = x[3 * members[0]], refy = x[3 * members[0] + 1], refz = x[3 * members[0] + 2];
  var sx = 0, sy = 0, sz = 0;
  for (var i = 0; i < members.length; i++) {
    var p = members[i];
    var dx = x[3 * p] - refx, dy = x[3 * p + 1] - refy, dz = x[3 * p + 2] - refz;
    if (dx > L / 2) dx -= L; else if (dx < -L / 2) dx += L;
    if (dy > L / 2) dy -= L; else if (dy < -L / 2) dy += L;
    if (dz > L / 2) dz -= L; else if (dz < -L / 2) dz += L;
    sx += dx; sy += dy; sz += dz;
  }
  var n = members.length;
  var cx = refx + sx / n, cy = refy + sy / n, cz = refz + sz / n;
  return [((cx % L) + L) % L, ((cy % L) + L) % L, ((cz % L) + L) % L];
}

function maxRadius(members, x, L, center) {
  var m = 0;
  for (var i = 0; i < members.length; i++) m = Math.max(m, distPeriodic(x, members[i], center, L));
  return m || 1e-6;
}

return {
  unionFind: unionFind,
  friendsOfFriends: friendsOfFriends,
  shrinkingSphereCenter: shrinkingSphereCenter,
  centroidPeriodic: centroidPeriodic,
  distPeriodic: distPeriodic,
};
});
