/**
 * S-63: 検出器 G（幾何・単一スナップショット）― 構造だけを見る部分。
 *
 * criteria.json observerDetails の bondG / cohesion / recursionG / rings / psi6 を実装する。
 * ここは「今この瞬間の配置から何が言えるか」だけを扱う純粋関数の集まりで、**時間方向の
 * 追跡（同一性・年齢・資格の判定）は持たない**――それは tracking.js（Node専用）の仕事。
 * viewer.html（ブラウザ）は本ファイルの構造だけで可視化に足りる。
 *
 * 依存ゼロ。core.js の angularWindowGD 等を使うため、core.js を先に読み込むこと
 * （ブラウザでは <script core.js> の後に <script detectors.js>、Node では require で渡す）。
 */
(function (root, factory) {
  var api = factory(typeof module === 'object' && module.exports ? require('./core.js') : root.S63);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S63D = api;
})(typeof self !== 'undefined' ? self : this, function (S63) {
  'use strict';

  // ================================================================ 結合グラフ（G）

  /**
   * bondG: r<rb かつ max_{p,q} g_p(c_i^p)g_q(c_j^q) >= gb の対を結合とする。強さ ε は使わない。
   * isotropic（NC3）では角度の依存が無いので g≡1（r<rb だけで判定）。
   * 戻り値: { edges: [[i,j], ...], adj: [[j,...], ...] }
   */
  function bondEdges(sys, opt) {
    var rb = opt.rb, gb = opt.gb, isotropic = !!opt.isotropic;
    var N = sys.N, edges = [], adj = [];
    for (var i = 0; i < N; i++) adj.push([]);
    S63.forEachPair(sys, rb, function (i, j, dx, dy, r) {
      var ok;
      if (isotropic) {
        ok = true;
      } else {
        var ux = dx / r, uy = dy / r;
        var aix = Math.cos(sys.phi[i]), aiy = Math.sin(sys.phi[i]);
        var ajx = Math.cos(sys.phi[j]), ajy = Math.sin(sys.phi[j]);
        var uDotAi = ux * aix + uy * aiy, uDotAj = ux * ajx + uy * ajy;
        var ciA = uDotAi, ciB = -uDotAi, cjA = -uDotAj, cjB = uDotAj;
        var GiA = S63.angularWindowGD(ciA, S63.A_CHI, S63.A_CLO).g;
        var GiB = S63.angularWindowGD(ciB, S63.B_CHI, S63.B_CLO).g;
        var GjA = S63.angularWindowGD(cjA, S63.A_CHI, S63.A_CLO).g;
        var GjB = S63.angularWindowGD(cjB, S63.B_CHI, S63.B_CLO).g;
        var best = Math.max(GiA * GjA, GiA * GjB, GiB * GjA, GiB * GjB);
        ok = best >= gb;
      }
      if (ok) { edges.push([i, j]); adj[i].push(j); adj[j].push(i); }
    });
    return { edges: edges, adj: adj };
  }

  // ================================================================ 凝集（cohesion）

  /**
   * 辺 (i,j) が「凝集した辺」か: それを除いた残りのグラフで i-j 間の最短路が <= ell-1
   * （元の辺を足すと長さ <= ell の閉路になる）。ell=3（既定）は「共通の隣人がいるか」と同値。
   */
  function cohesiveEdgeSet(N, edges, adj, ell) {
    var cohesive = new Uint8Array(edges.length);
    for (var e = 0; e < edges.length; e++) {
      var i = edges[e][0], j = edges[e][1];
      if (ell === 3) {
        // 共通の隣人（i でも j でもない）があれば凝集
        var setI = {};
        for (var a = 0; a < adj[i].length; a++) { var v = adj[i][a]; if (v !== j) setI[v] = true; }
        var found = false;
        for (var b = 0; b < adj[j].length; b++) { var w = adj[j][b]; if (w !== i && setI[w]) { found = true; break; } }
        cohesive[e] = found ? 1 : 0;
        continue;
      }
      // 一般の ell: BFS（辺(i,j)自身は使わない）で i→j の最短路長を探す
      var dist = {}; dist[i] = 0;
      var q = [i], qi = 0, limit = ell - 1;
      while (qi < q.length) {
        var u = q[qi++];
        if (dist[u] >= limit) continue;
        var neigh = adj[u];
        for (var k = 0; k < neigh.length; k++) {
          var v2 = neigh[k];
          if (u === i && v2 === j) continue; // 直接の辺は禁止
          if (v2 === i && u === j) continue;
          if (dist[v2] === undefined) { dist[v2] = dist[u] + 1; q.push(v2); }
        }
      }
      cohesive[e] = (dist[j] !== undefined && dist[j] <= limit) ? 1 : 0;
    }
    return cohesive;
  }

  // ================================================================ 連結成分

  /** nodeIds の集合上で、edges（[i,j]対、i,j は nodeIds のメンバー）による連結成分を返す。 */
  function connectedComponents(nodeIds, edgeList) {
    var parent = {};
    nodeIds.forEach(function (n) { parent[n] = n; });
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    function union(a, b) { var ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }
    edgeList.forEach(function (e) { if (parent[e[0]] !== undefined && parent[e[1]] !== undefined) union(e[0], e[1]); });
    var groups = {};
    nodeIds.forEach(function (n) { var r = find(n); (groups[r] = groups[r] || []).push(n); });
    return Object.keys(groups).map(function (k) { return groups[k]; });
  }

  // ================================================================ 再帰的な粗視化（recursionG）

  /**
   * G_0（粒子+結合）から候補の段を再帰的に作る（criteria.json observerDetails.recursionG）。
   * **年齢・資格の判定は含まない**（構造だけ）。呼び出し側（tracking.js）が年齢つきで資格を判定する。
   *
   * 戻り値: levels[] （level0 は要素そのもの）。各 level:
   *   { units: [[粒子id,...], ...]（元の粒子番号の集合に展開済み）,
   *     parentUnits: [[前段のunit添字,...], ...]（level>=1のみ。どのunitを合成したか）,
   *     isLast: bool（凝集が空 or 連結成分と同じで再帰を止めた） }
   */
  function recursionLevels(N, edges0, opt) {
    var ell = opt.ell != null ? opt.ell : 3;
    var maxLevels = opt.maxLevels != null ? opt.maxLevels : 4;
    var levels = [{ units: [], isLast: false }];
    for (var i = 0; i < N; i++) levels[0].units.push([i]);

    var curNodeIds = []; for (i = 0; i < N; i++) curNodeIds.push(i);
    var curEdges = edges0; // [[nodeId,nodeId], ...]（level0のnodeIdは元の粒子番号）
    var curUnitsOfNode = null; // level>0で、各nodeId(=前段unit添字)が含む元粒子集合

    for (var L = 1; L <= maxLevels; L++) {
      var adj = {}; curNodeIds.forEach(function (n) { adj[n] = []; });
      curEdges.forEach(function (e) { adj[e[0]].push(e[1]); adj[e[1]].push(e[0]); });
      var edgeObjs = curEdges.map(function (e) { return [e[0], e[1]]; });
      var cohesive = cohesiveEdgeSet(0, edgeObjs, adj, ell); // N引数は未使用（互換のため残す）
      var cohesiveEdges = edgeObjs.filter(function (e, idx) { return cohesive[idx] === 1; });
      var Pcoh = connectedComponents(curNodeIds, cohesiveEdges).filter(function (g) { return g.length >= 2; });
      var Pall = connectedComponents(curNodeIds, edgeObjs);

      var pcohCoversAll = Pcoh.length > 0 && (function () {
        // Pcoh が空でなく Pall と「異なる」か（同じ分割なら false）
        if (Pcoh.length === 0) return false;
        // Pallの各成分がPcohの1つの成分に完全一致し、余りが無い場合のみ「同じ」とみなす
        var coveredByPcoh = {};
        Pcoh.forEach(function (g) { g.forEach(function (n) { coveredByPcoh[n] = true; }); });
        var allCovered = curNodeIds.every(function (n) { return coveredByPcoh[n]; });
        if (!allCovered) return true; // 被覆されない点がある→Pallと違う
        // 全点が被覆されていても、Pcohの分割がPallの分割と一致するかを見る
        var samePartition = Pall.every(function (g) {
          if (g.length === 0) return true;
          var rep = g[0], reps = Pcoh.filter(function (pc) { return pc.indexOf(rep) >= 0; })[0];
          if (!reps) return false;
          return g.length === reps.length && g.every(function (n) { return reps.indexOf(n) >= 0; });
        });
        return !samePartition;
      })();

      var candidateGroups, isLast;
      if (pcohCoversAll) {
        // Pcoh の成分 + 被覆されない点は単独点として残す
        var coveredSet = {};
        Pcoh.forEach(function (g) { g.forEach(function (n) { coveredSet[n] = true; }); });
        candidateGroups = Pcoh.slice();
        curNodeIds.forEach(function (n) { if (!coveredSet[n]) candidateGroups.push([n]); });
        isLast = false;
      } else {
        candidateGroups = Pall;
        isLast = true;
      }

      // candidateGroups（nodeId=前段unit添字の集合）を元の粒子集合へ展開
      var prevUnits = levels[L - 1].units;
      var units = candidateGroups.map(function (g) {
        var members = [];
        g.forEach(function (nodeId) { members = members.concat(prevUnits[nodeId]); });
        return members;
      });
      var parentUnits = candidateGroups;
      levels.push({ units: units, parentUnits: parentUnits, isLast: isLast });

      if (isLast) break;
      if (L >= maxLevels) { levels[levels.length - 1].isLast = true; break; }

      // 次段の入力: candidateGroups を新しいノード（添字=このlevelのunit添字）とし、
      // 元の結合がまたぐものを新しい辺にする（元のグラフの辺を新ノードへ写像）。
      var nodeOfOld = {}; // 前段nodeId -> 新ノード添字
      candidateGroups.forEach(function (g, idx) { g.forEach(function (n) { nodeOfOld[n] = idx; }); });
      var newEdgesSet = {};
      var newEdges = [];
      edgeObjs.forEach(function (e) {
        var a = nodeOfOld[e[0]], b = nodeOfOld[e[1]];
        if (a === b) return;
        var key = a < b ? a + ':' + b : b + ':' + a;
        if (!newEdgesSet[key]) { newEdgesSet[key] = true; newEdges.push(a < b ? [a, b] : [b, a]); }
      });
      curNodeIds = candidateGroups.map(function (g, idx) { return idx; });
      curEdges = newEdges;
    }
    return levels;
  }

  // ================================================================ 環（面）と Ψ6（U2 グラフの平面埋め込み）

  /**
   * U2 の中の U1 を点（重心）、辺を U1 間の結合とし、最近接鏡像で各点の辺を角度順に並べて
   * 面を辿る（半辺トレース）。大きさ 3〜12 の面を環として返す。> 12 は別に数える。
   * nodes: [{id, x, y}], edges: [[idA,idB], ...]（idはnodesのidと一致）, L: 箱の一辺（最小像用）。
   */
  function traceFaces(nodes, edges, L) {
    var pos = {}; nodes.forEach(function (n) { pos[n.id] = [n.x, n.y]; });
    var adjAngles = {}; nodes.forEach(function (n) { adjAngles[n.id] = []; });
    edges.forEach(function (e) {
      var a = e[0], b = e[1];
      var dx = S63.minImageD(pos[b][0] - pos[a][0], L), dy = S63.minImageD(pos[b][1] - pos[a][1], L);
      var angAB = Math.atan2(dy, dx), angBA = Math.atan2(-dy, -dx);
      adjAngles[a].push({ to: b, ang: angAB });
      adjAngles[b].push({ to: a, ang: angBA });
    });
    Object.keys(adjAngles).forEach(function (k) { adjAngles[k].sort(function (p, q) { return p.ang - q.ang; }); });
    // 半辺: (from,to) のペア。次の半辺 = to の隣接リストで from の"次"（角度順で反時計回りの次）
    var visited = {};
    function halfKey(a, b) { return a + '>' + b; }
    var faces = [];
    nodes.forEach(function (n0) {
      adjAngles[n0.id].forEach(function (edge0) {
        var startA = n0.id, startB = edge0.to;
        if (visited[halfKey(startA, startB)]) return;
        var face = [], a = startA, b = startB, guard = 0;
        while (guard++ < 5000) {
          visited[halfKey(a, b)] = true;
          face.push(a);
          // b の隣接リストで a への逆辺を探し、その"前"（時計回りで隣、面トレースの標準規則）を取る
          var list = adjAngles[b];
          var idx = -1;
          for (var k = 0; k < list.length; k++) if (list[k].to === a) { idx = k; break; }
          if (idx < 0 || list.length === 1) break; // 行き止まり（枝・孤立辺）
          var nextIdx = (idx - 1 + list.length) % list.length;
          var c = list[nextIdx].to;
          a = b; b = c;
          if (a === startA && b === startB) break;
        }
        if (face.length >= 3 && a === startA) faces.push(face);
      });
    });
    return faces;
  }

  /** Ψ6: U2内のU1間の辺の向きαについて |<e^{6iα}>|（重み: 出現数=辺の数×2 でも平均化されれば同じ）。 */
  function psi6(nodes, edges, L) {
    var pos = {}; nodes.forEach(function (n) { pos[n.id] = [n.x, n.y]; });
    var reX = 0, reY = 0, cnt = 0;
    edges.forEach(function (e) {
      var dx = S63.minImageD(pos[e[1]][0] - pos[e[0]][0], L), dy = S63.minImageD(pos[e[1]][1] - pos[e[0]][1], L);
      var ang = Math.atan2(dy, dx);
      reX += Math.cos(6 * ang); reY += Math.sin(6 * ang); cnt++;
      // 逆向きも同じ寄与（e^{6i(ang+π)}=e^{6i*ang}e^{6iπ}=e^{6i*ang}なので対称、重複しても平均は不変）
    });
    if (cnt === 0) return null;
    return Math.sqrt(reX * reX + reY * reY) / cnt;
  }

  return {
    bondEdges: bondEdges, cohesiveEdgeSet: cohesiveEdgeSet, connectedComponents: connectedComponents,
    recursionLevels: recursionLevels, traceFaces: traceFaces, psi6: psi6,
  };
});
