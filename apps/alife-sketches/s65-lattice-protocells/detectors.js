/**
 * S-65: 検出器 T（障壁）と C（中身）。criteria.json observerDetails のとおり、上位の単位を書かず、
 * 場（μ・a）から連結成分を数えるだけ。生物学の語彙（膜・細胞・群れ）はここでだけ使ってよい。
 */
(function (global) {
  'use strict';
  var S = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : global.S65Core;
  var DI = S.DI, DJ = S.DJ;

  /** 6連結成分。included(x)=true のサイトだけを辿る。箱を回り込むか（wraps）を展開座標で判定する。 */
  function connectedComponents(lat, included) {
    var n = lat.nSites, visited = new Uint8Array(n), comps = [];
    for (var start = 0; start < n; start++) {
      if (visited[start] || !included(start)) continue;
      var members = [], wraps = false;
      var offX = {}, offY = {};
      visited[start] = 1; offX[start] = 0; offY[start] = 0;
      var stack = [start];
      while (stack.length) {
        var x = stack.pop();
        members.push(x);
        var ox = offX[x], oy = offY[x];
        for (var k = 0; k < 6; k++) {
          var y = lat.neighbor(x, k);
          if (!included(y)) continue;
          var nx = ox + DI[k], ny = oy + DJ[k];
          if (!visited[y]) { visited[y] = 1; offX[y] = nx; offY[y] = ny; stack.push(y); }
          else if (offX[y] !== nx || offY[y] !== ny) wraps = true;
        }
      }
      comps.push({ members: members, size: members.length, wraps: wraps });
    }
    return comps;
  }

  /** サイト start から純粋な格子距離 maxDist 以内にあるサイト（種を問わない）。 */
  function ballAround(lat, start, maxDist) {
    var visited = {}; visited[start] = 0;
    var frontier = [start], out = [start];
    for (var d = 1; d <= maxDist; d++) {
      var next = [];
      frontier.forEach(function (x) {
        for (var k = 0; k < 6; k++) {
          var y = lat.neighbor(x, k);
          if (visited[y] === undefined) { visited[y] = d; next.push(y); out.push(y); }
        }
      });
      frontier = next;
    }
    return out;
  }

  function otsuThreshold(values) {
    var nb = 256, min = Infinity, max = -Infinity;
    values.forEach(function (v) { if (v < min) min = v; if (v > max) max = v; });
    if (max <= min) return min;
    var hist = new Float64Array(nb);
    values.forEach(function (v) { var b = Math.min(nb - 1, Math.floor((v - min) / (max - min) * nb)); hist[b]++; });
    var total = values.length, sum = 0;
    for (var i = 0; i < nb; i++) sum += i * hist[i];
    var sumB = 0, wB = 0, bestVar = -1, bestFirst = -1, bestLast = -1;
    for (i = 0; i < nb; i++) {
      wB += hist[i]; if (wB === 0) continue;
      var wF = total - wB; if (wF === 0) break;
      sumB += i * hist[i];
      var mB = sumB / wB, mF = (sum - sumB) / wF;
      var varBetween = wB * wF * (mB - mF) * (mB - mF);
      if (varBetween > bestVar + 1e-9) { bestVar = varBetween; bestFirst = i; bestLast = i; }
      else if (Math.abs(varBetween - bestVar) <= 1e-9) { bestLast = i; }
    }
    // 同じ最大値が続く平坦域（度数0の谷）は中点を取る——端に寄らないようにする
    var best = (bestFirst + bestLast) / 2;
    return min + (best / nb) * (max - min);
  }

  /** membrane site の判定: mu(x)>=thetaMu。thetaMu='otsu' なら自動。 */
  function membraneMask(lat, mu, thetaMu) {
    var theta = thetaMu === 'otsu' ? otsuThreshold(Array.from(mu)) : thetaMu;
    var mask = new Uint8Array(lat.nSites);
    for (var x = 0; x < lat.nSites; x++) mask[x] = mu[x] >= theta ? 1 : 0;
    return { mask: mask, theta: theta };
  }

  function activeMask(lat, a, thetaA) {
    var mask = new Uint8Array(lat.nSites);
    for (var x = 0; x < lat.nSites; x++) mask[x] = a[x] >= thetaA ? 1 : 0;
    return mask;
  }

  /**
   * U1（膜の断片）。sizeMin=6。記述子: size, iota_int, shape, wraps, totalM。
   * S_align は orientVec（M の向きベクトル、[x,y]配列 per site。無ければ null）が要る。
   */
  function computeU1(lat, mask, countM, orientVec) {
    var comps = connectedComponents(lat, function (x) { return mask[x] === 1; }).filter(function (c) { return c.size >= 6; });
    return comps.map(function (c) {
      var memberSet = {}; c.members.forEach(function (x) { memberSet[x] = true; });
      var interiorCount = 0, totalM = 0;
      c.members.forEach(function (x) {
        totalM += countM[x];
        var allIn = true;
        for (var k = 0; k < 6; k++) if (!mask[lat.neighbor(x, k)]) { allIn = false; break; }
        if (allIn) interiorCount++;
      });
      var iotaInt = interiorCount / c.size;
      var sAlign = null;
      if (orientVec) sAlign = computeSAlign(lat, c.members, memberSet, orientVec, countM);
      return { members: c.members, size: c.size, iotaInt: iotaInt, totalM: totalM, wraps: c.wraps, sAlign: sAlign, memberSet: memberSet };
    });
  }

  /**
   * S_align: 向きQ（M重み付き2θ平均）と膜の接線の一致度（criteria.json observerDetails.filmProperties）。
   *
   * 2026-09-26（S4のsalign-check.jsの検算で発覚。台帳K-2026-09-26-05）: 接線を隣接する膜サイトへの
   * 相対位置ベクトルの**単純平均**で取っていた。直線の内側のサイトでは向かい合う2方向が打ち消し合って
   * 常に0ベクトル（角度0）になり、斑点の縁では**内向きの法線**になっていた——「近傍の差のベクトルの
   * 主軸」（登録の文言）ではない。**2倍角（軸）の平均**（向きを問わない主軸）に直す:
   * 各隣接する膜サイト方向kについて2αを足し合わせ、atan2(Σsin2α,Σcos2α)/2 を接線の向きとする。
   * 主軸が定まらない（打ち消し合う）サイトはスキップする（登録の較正どおり）。
   */
  function computeSAlign(lat, members, memberSet, orientVec, countM) {
    var wsum = 0, num = 0;
    members.forEach(function (x) {
      var m = countM[x]; if (m <= 0) return;
      var qx = orientVec.qx[x], qy = orientVec.qy[x];
      var qmag = Math.sqrt(qx * qx + qy * qy);
      if (qmag < 1e-9) return;
      var thetaDir = Math.atan2(qy, qx) / 2;
      var tx = 0, ty = 0, cnt = 0;
      for (var k = 0; k < 6; k++) {
        var y = lat.neighbor(x, k);
        if (!memberSet[y]) continue;
        var dp = axialDelta(lat, x, y, k);
        var alpha = Math.atan2(dp.dy, dp.dx);
        tx += Math.cos(2 * alpha); ty += Math.sin(2 * alpha); cnt++;
      }
      if (cnt === 0) return;
      if (Math.sqrt(tx * tx + ty * ty) < 1e-6) return; // 主軸が定まらない（打ち消し合う）
      var thetaTan = Math.atan2(ty, tx) / 2;
      var cosDiff = Math.cos(2 * (thetaDir - thetaTan));
      num += qmag * m * cosDiff;
      wsum += qmag * m;
    });
    return wsum > 1e-9 ? num / wsum : null;
  }

  function axialPos(lat, x) { var p = lat.ijOf(x); return { x: p.i + 0.5 * p.j, y: p.j * 0.8660254 }; }
  function axialDelta(lat, x, y, k) {
    // ei方向の実座標差（正三角格子への埋め込み）
    var EX = [1, 0.5, -0.5, -1, -0.5, 0.5], EY = [0, 0.8660254, 0.8660254, 0, -0.8660254, -0.8660254];
    return { dx: EX[k], dy: EY[k] };
  }

  /** M の向きベクトル場 Q（criteria.json observerDetails.filmProperties）。 */
  function orientField(state) {
    var lat = state.lat, nSites = state.nSites, qx = new Float64Array(nSites), qy = new Float64Array(nSites);
    var TH = [0, Math.PI / 3, 2 * Math.PI / 3];
    for (var x = 0; x < nSites; x++) {
      var sx = 0, sy = 0, tot = 0;
      for (var h = 0; h < 3; h++) {
        var n = S.countAt(state, S.S_M0 + h, x);
        tot += n;
        sx += n * Math.cos(2 * TH[h]); sy += n * Math.sin(2 * TH[h]);
      }
      if (tot > 0) { qx[x] = sx / tot; qy[x] = sy / tot; } else { qx[x] = 0; qy[x] = 0; }
    }
    return { qx: qx, qy: qy };
  }

  /**
   * U2 候補（膜でない連結成分・箱を回り込まない）と、資格ある「細胞」。
   * 資格: 面積>=aMin、薄い壁、生きている（内腔 a 平均 >= thetaA）。年齢は tracking.js が付す。
   */
  function computeU2Candidates(lat, mask, aField, thetaA, opts) {
    opts = opts || {};
    var aMin = opts.aMin != null ? opts.aMin : 7;
    var voids = connectedComponents(lat, function (x) { return mask[x] === 0; });
    return voids.map(function (c) {
      var memberSet = {}; c.members.forEach(function (x) { memberSet[x] = true; });
      if (c.wraps) return { members: c.members, size: c.size, wraps: true, qualifies: false, reason: 'wrapping' };
      if (c.size < aMin) return { members: c.members, size: c.size, wraps: false, qualifies: false, reason: 'small' };
      var wall = wallOf(lat, memberSet, mask);
      var thin = wallThinFraction(lat, wall, memberSet, mask) >= 0.5;
      var meanA = c.members.reduce(function (s, x) { return s + aField[x]; }, 0) / c.size;
      var alive = meanA >= thetaA;
      var qualifies = thin && alive;
      var reason = !thin ? 'thickWall' : (!alive ? 'notAlive' : null);
      return { members: c.members, size: c.size, wraps: false, wall: wall, thin: thin, meanA: meanA, alive: alive, qualifies: qualifies, reason: reason, memberSet: memberSet };
    });
  }

  function wallOf(lat, lumenSet, mask) {
    var wallSet = {};
    Object.keys(lumenSet).forEach(function (k) {
      var x = Number(k);
      for (var kk = 0; kk < 6; kk++) { var y = lat.neighbor(x, kk); if (mask[y] === 1) wallSet[y] = true; }
    });
    return Object.keys(wallSet).map(Number);
  }

  function wallThinFraction(lat, wall, lumenSet, mask) {
    if (wall.length === 0) return 1;
    var thinCount = 0;
    wall.forEach(function (w) {
      var ball = ballAround(lat, w, 2);
      var found = ball.some(function (z) { return mask[z] === 0 && !lumenSet[z]; });
      if (found) thinCount++;
    });
    return thinCount / wall.length;
  }

  /** U3: 資格ある細胞（cells, qualifies済のU2候補）のグラフの連結成分（g3以内なら辺）。n3以上で群れ。 */
  function computeU3(lat, cells, g3, n3) {
    var n = cells.length;
    var adj = cells.map(function () { return []; });
    for (var i = 0; i < n; i++) {
      var reach = multiSourceBall(lat, cells[i].members, g3);
      for (var j = 0; j < n; j++) {
        if (i === j) continue;
        if (cells[j].members.some(function (x) { return reach[x]; })) adj[i].push(j);
      }
    }
    var visited = new Uint8Array(n), comps = [];
    for (i = 0; i < n; i++) {
      if (visited[i]) continue;
      var stack = [i], members = []; visited[i] = 1;
      while (stack.length) { var u = stack.pop(); members.push(u); adj[u].forEach(function (v) { if (!visited[v]) { visited[v] = 1; stack.push(v); } }); }
      comps.push(members);
    }
    return comps.filter(function (m) { return m.length >= n3; }).map(function (m) { return { cellIdx: m, size: m.length }; });
  }

  function multiSourceBall(lat, sources, maxDist) {
    var visited = {};
    sources.forEach(function (s) { visited[s] = 0; });
    var frontier = sources.slice();
    for (var d = 1; d <= maxDist; d++) {
      var next = [];
      frontier.forEach(function (x) {
        for (var k = 0; k < 6; k++) { var y = lat.neighbor(x, k); if (visited[y] === undefined) { visited[y] = d; next.push(y); } }
      });
      frontier = next;
    }
    return visited;
  }

  /**
   * Π = K_A/K_X（選択的な障壁）。K_s = U1サイトのn_sの平均 / U1に隣接する膜でないサイトのn_sの平均。
   * u1Mask: 1ならU1（膜資格の成分に属する）サイト。全U1をまとめて1つの帯として評価する（簡略化）。
   */
  function computePi(lat, u1MemberSet, mask, countA, countX) {
    var u1Sites = Object.keys(u1MemberSet).map(Number);
    if (u1Sites.length === 0) return null;
    var adjSet = {};
    u1Sites.forEach(function (x) { for (var k = 0; k < 6; k++) { var y = lat.neighbor(x, k); if (mask[y] === 0 && !u1MemberSet[y]) adjSet[y] = true; } });
    var adjSites = Object.keys(adjSet).map(Number);
    if (adjSites.length === 0) return null;
    function meanOf(arr, field) { var s = 0; arr.forEach(function (x) { s += field[x]; }); return s / arr.length; }
    var kA = meanOf(u1Sites, countA) / Math.max(1e-9, meanOf(adjSites, countA));
    var kX = meanOf(u1Sites, countX) / Math.max(1e-9, meanOf(adjSites, countX));
    return kX > 1e-9 ? kA / kX : null;
  }

  /** 検出器 C: 活性サイトの成分（C1: 箱を回り込まず面積>=aMin）と、その群れ（C2）。M を一切見ない。 */
  function computeC(lat, aMask, opts) {
    opts = opts || {};
    var aMin = opts.aMin != null ? opts.aMin : 7;
    var g3 = opts.g3 != null ? opts.g3 : 3, n3 = opts.n3 != null ? opts.n3 : 3;
    var comps = connectedComponents(lat, function (x) { return aMask[x] === 1; });
    var c1 = comps.filter(function (c) { return !c.wraps && c.size >= aMin; });
    var c1All = comps; // 回り込みの記録用
    var groups = computeU3(lat, c1.map(function (c) { return { members: c.members }; }), g3, n3);
    return { c1: c1, c1All: c1All, c2: groups };
  }

  var D = {
    connectedComponents: connectedComponents, ballAround: ballAround, otsuThreshold: otsuThreshold,
    membraneMask: membraneMask, activeMask: activeMask, computeU1: computeU1, orientField: orientField,
    computeU2Candidates: computeU2Candidates, wallOf: wallOf, wallThinFraction: wallThinFraction,
    computeU3: computeU3, multiSourceBall: multiSourceBall, computeC: computeC, computePi: computePi,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = D;
  global.S65Detectors = D;
})(typeof window !== 'undefined' ? window : globalThis);
