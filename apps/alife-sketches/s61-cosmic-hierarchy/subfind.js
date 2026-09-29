'use strict';
/**
 * S-61 検出器: 部分ハローの検出器（SUBFIND の簡略版。Springel ら 2001 の型）。
 * criteria.json observerDetails.subhalo のとおり: SPH密度→密度降順に足す→鞍点で分岐→
 * 鞍点ごとに小さい側の候補を密度の低い順に解き放しで判定。
 *
 * 入力は「群（FOF群）の中の粒子」に閉じる（近傍探索は群の中だけ。criteria の簡略化②）。
 * 上位の単位の語彙（部分ハロー等）はここと observer.js だけが持つ。Node/ブラウザ共用（UMD）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.S61SUBFIND = factory();
})(typeof self !== 'undefined' ? self : this, function () {

/** 単純な kNN（総当たり。群サイズが数千までを想定。大きな群は observer.js 側で承知の上で使う）。 */
function buildNeighborLists(pos, n, k) {
  // pos: [[x,y,z], ...]（群だけの unwrap 済み座標）
  var lists = new Array(n);
  for (var i = 0; i < n; i++) {
    var dists = new Array(n);
    for (var j = 0; j < n; j++) {
      if (j === i) { dists[j] = Infinity; continue; }
      var dx = pos[i][0] - pos[j][0], dy = pos[i][1] - pos[j][1], dz = pos[i][2] - pos[j][2];
      dists[j] = dx * dx + dy * dy + dz * dz;
    }
    var idx = Array.from({ length: n }, function (_, x) { return x; });
    idx.sort(function (a, b) { return dists[a] - dists[b]; });
    lists[i] = idx.slice(0, Math.min(k, n - 1)).map(function (jj) { return { j: jj, r2: dists[jj] }; });
  }
  return lists;
}

/** 3次スプラインSPHカーネル（標準化・3次元）。W(r,h)。 */
function splineKernel(r, h) {
  if (h <= 0) return 0;
  var q = r / h;
  var norm = 1 / (Math.PI * h * h * h);
  if (q < 0) return 0;
  if (q <= 1) return norm * (1 - 1.5 * q * q + 0.75 * q * q * q);
  if (q <= 2) return norm * 0.25 * Math.pow(2 - q, 3);
  return 0;
}

/** SPH密度（各粒子のNdens近傍から）。neighborLists は buildNeighborLists の出力。 */
function sphDensities(neighborLists, mass, Ndens) {
  var n = neighborLists.length;
  var dens = new Float64Array(n);
  for (var i = 0; i < n; i++) {
    var nb = neighborLists[i].slice(0, Ndens);
    if (nb.length === 0) { dens[i] = 0; continue; }
    var h = Math.sqrt(nb[nb.length - 1].r2) || 1e-6;
    var rho = mass * splineKernel(0, h); // 自分自身の寄与
    for (var k = 0; k < nb.length; k++) rho += mass * splineKernel(Math.sqrt(nb[k].r2), h);
    dens[i] = rho;
  }
  return dens;
}

/**
 * 部分ハロー候補の探索（密度降順に足し、鞍点で分岐）。
 * pos: unwrap済み座標配列。mass: スカラー（等質量前提）。Nngb: 分岐に使う近傍数。
 * 戻り値: { saddleEvents: [{densityAtSaddle, groupsAtSaddle: [{id,members}], mergedInto}], finalGroups: [[members...]] }
 */
function findCandidates(pos, mass, Ndens, Nngb) {
  var n = pos.length;
  if (n === 0) return { saddleEvents: [], finalGroups: [] };
  var kNeighbors = buildNeighborLists(pos, n, Math.max(Ndens, Nngb));
  var dens = sphDensities(kNeighbors, mass, Ndens);
  var order = Array.from({ length: n }, function (_, i) { return i; });
  order.sort(function (a, b) { return dens[b] - dens[a]; }); // 降順

  var subgroupOf = new Int32Array(n).fill(-1);
  var subgroups = []; // {members: [idx...]}
  var saddleEvents = [];

  for (var oi = 0; oi < order.length; oi++) {
    var i = order[oi];
    var nb = kNeighbors[i].slice(0, Nngb);
    var seen = {};
    var distinctIds = [];
    for (var k = 0; k < nb.length; k++) {
      var sg = subgroupOf[nb[k].j];
      if (sg >= 0 && !seen[sg]) { seen[sg] = true; distinctIds.push(sg); }
    }
    if (distinctIds.length === 0) {
      var newId = subgroups.length;
      subgroups.push({ members: [i] });
      subgroupOf[i] = newId;
    } else if (distinctIds.length === 1) {
      subgroupOf[i] = distinctIds[0];
      subgroups[distinctIds[0]].members.push(i);
    } else {
      // 鞍点: 関わる部分群のスナップショットを記録。最大のものへ暫定で合流させる。
      distinctIds.sort(function (a, b) { return subgroups[b].members.length - subgroups[a].members.length; });
      var biggest = distinctIds[0];
      var snapshot = distinctIds.map(function (id) {
        return { id: id, members: subgroups[id].members.slice() };
      });
      saddleEvents.push({ densityAtSaddle: dens[i], groupsAtSaddle: snapshot, mergedInto: biggest });
      // 全員を biggest へ合流し、i も加える
      for (var d = 0; d < distinctIds.length; d++) {
        if (distinctIds[d] === biggest) continue;
        var members = subgroups[distinctIds[d]].members;
        for (var m = 0; m < members.length; m++) { subgroupOf[members[m]] = biggest; subgroups[biggest].members.push(members[m]); }
        subgroups[distinctIds[d]].members = [];
      }
      subgroupOf[i] = biggest;
      subgroups[biggest].members.push(i);
    }
  }
  var finalGroups = subgroups.filter(function (g) { return g.members.length > 0; }).map(function (g) { return g.members; });
  return { saddleEvents: saddleEvents, finalGroups: finalGroups, order: order, densities: dens, neighborLists: kNeighbors };
}

/**
 * 解き放し（unbinding）。pos/vel は群の unwrap済み座標・物理速度。members: 添字配列。
 * n<=3000 は直接和のポテンシャル、n>3000 は最も束縛された粒子まわりの球対称近似。
 * 最も束縛された粒子を中心とし、正の全エネルギーの粒子を繰り返し除く。
 * 戻り値: { bound: [members...], fBound, potentialApprox: bool }
 */
function unbind(members, pos, vel, mass, Gconst, softening) {
  var cur = members.slice();
  var approx = cur.length > 3000;
  var iterLimit = 60;
  for (var iter = 0; iter < iterLimit; iter++) {
    if (cur.length === 0) break;
    var n = cur.length;
    var phi = new Float64Array(n);
    if (!approx) {
      for (var a = 0; a < n; a++) {
        var pa = pos[cur[a]];
        var s = 0;
        for (var b = 0; b < n; b++) {
          if (a === b) continue;
          var pb = pos[cur[b]];
          var dx = pa[0] - pb[0], dy = pa[1] - pb[1], dz = pa[2] - pb[2];
          var r = Math.sqrt(dx * dx + dy * dy + dz * dz + softening * softening);
          s += -Gconst * mass / r;
        }
        phi[a] = s;
      }
    } else {
      // 球対称近似: 中心からの距離でソートし、M(<r)/r の累積で近似。
      // 簡略化（notes.md）: 中心は「最も束縛された粒子」の代わりに現在のメンバーの重心を使う。
      var cx = 0, cy = 0, cz = 0;
      for (var ci = 0; ci < n; ci++) { var pc = pos[cur[ci]]; cx += pc[0]; cy += pc[1]; cz += pc[2]; }
      var center = [cx / n, cy / n, cz / n];
      var withR = cur.map(function (idx) {
        var p = pos[idx];
        var dx = p[0] - center[0], dy = p[1] - center[1], dz = p[2] - center[2];
        return { idx: idx, r: Math.sqrt(dx * dx + dy * dy + dz * dz) };
      });
      withR.sort(function (x, y) { return x.r - y.r; });
      var phiAtR = new Array(withR.length);
      // 球殻の重ね合わせ: phi(r) = -G*M(<=r)/r - G*sum_{r'>r} dM/r'。
      // 前半（内側の囲まれた質量）は Newton の殻定理の外側成分、後半（外殻の寄与）は
      // 各外殻が観測点より外側にあっても、殻の自分の半径 r' で -G*dM/r' の一定値を足す
      // （殻の内側では力はゼロだがポテンシャルはゼロではない）。旧実装は後半を欠いており
      // 外殻の質量を無視していた（ビリアル平衡の系を過大評価された束縛エネルギーで
      // 非束縛と誤判定する原因。notes.md 参照）。
      var running = 0;
      var encPhi = new Array(withR.length);
      for (var w2 = 0; w2 < withR.length; w2++) {
        running += mass;
        var r2v = Math.max(withR[w2].r, softening);
        encPhi[w2] = -Gconst * running / r2v;
      }
      var outerAccum = 0;
      for (var w4 = withR.length - 1; w4 >= 0; w4--) {
        var r4v = Math.max(withR[w4].r, softening);
        phiAtR[w4] = encPhi[w4] - Gconst * outerAccum;
        outerAccum += mass / r4v;
      }
      var map2 = {};
      for (var w3 = 0; w3 < withR.length; w3++) map2[withR[w3].idx] = phiAtR[w3];
      for (var a2 = 0; a2 < n; a2++) phi[a2] = map2[cur[a2]];
    }
    var toRemove = [];
    var worst = -1, worstE = -Infinity;
    for (var a3 = 0; a3 < n; a3++) {
      var v = vel[cur[a3]];
      var KE = 0.5 * (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
      var E = KE + phi[a3];
      if (E > 0) { toRemove.push(cur[a3]); if (E > worstE) { worstE = E; worst = cur[a3]; } }
    }
    if (toRemove.length === 0) break;
    var removeSet = {};
    toRemove.forEach(function (idx) { removeSet[idx] = true; });
    cur = cur.filter(function (idx) { return !removeSet[idx]; });
  }
  return { bound: cur, fBound: members.length > 0 ? cur.length / members.length : 0, approx: approx };
}

/**
 * 鞍点ごとに小さい側の候補を、鞍点の密度の低い順に解き放しで判定する（observerDetails.subhalo）。
 * 群の最大の部分ハロー（背景・mergedInto側）は数えない。
 * 戻り値: [{members, fBound, approx, densityAtSaddle}, ...]（部分ハローとして残ったものだけ）
 */
function resolveSubhalos(built, pos, vel, mass, Gconst, softening, Nngb) {
  var events = built.saddleEvents.slice().sort(function (a, b) { return a.densityAtSaddle - b.densityAtSaddle; });
  var subhalos = [];
  for (var e = 0; e < events.length; e++) {
    var ev = events[e];
    for (var c = 0; c < ev.groupsAtSaddle.length; c++) {
      var cand = ev.groupsAtSaddle[c];
      if (cand.id === ev.mergedInto) continue;
      if (cand.members.length < Nngb) continue;
      var result = unbind(cand.members, pos, vel, mass, Gconst, softening);
      if (result.bound.length >= Nngb) {
        subhalos.push({ members: result.bound, fBound: result.fBound, approx: result.approx, densityAtSaddle: ev.densityAtSaddle, candidateSize: cand.members.length });
      }
    }
  }
  return subhalos;
}

return {
  buildNeighborLists: buildNeighborLists, splineKernel: splineKernel, sphDensities: sphDensities,
  findCandidates: findCandidates, unbind: unbind, resolveSubhalos: resolveSubhalos,
};
});
