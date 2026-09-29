/**
 * S-65: 細胞の系譜（U2の追跡）・分裂/融合/死の候補検出・H-strict。criteria.json observerDetails.tracking/events/hStrict。
 * オンライン（走行中）で候補を検出し、成り行き（成功/戻った/…）はオフラインで後付けする（K-144）。
 */
(function (global) {
  'use strict';

  function overlapCount(setA, membersB) {
    var n = 0;
    for (var i = 0; i < membersB.length; i++) if (setA[membersB[i]]) n++;
    return n;
  }

  /**
   * 1観測ぶんの照合。prev: [{lineageId, members, memberSet, size, wallSize}]（前の観測の資格ある細胞）。
   * curr: 今の観測の資格ある候補（wall/memberSet等つき、まだlineageId無し）。
   * state: {nextId} を書き換えながら使う。
   * 戻り値: {annotated: currにlineageId/parentId/bornThisFrameを付けたもの, candidates: [{type,...}]}
   */
  function matchFrame(prev, curr, state, t) {
    var n = curr.length, m = prev.length;
    var claims = curr.map(function () { return []; }); // curr[i] <- [{prevIdx, frac}]
    var contributes = prev.map(function () { return []; }); // prev[j] -> [{currIdx, count}]
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < m; j++) {
        var ov = overlapCount(prev[j].memberSet, curr[i].members);
        if (ov === 0) continue;
        var fracOfCurr = ov / curr[i].size;
        if (fracOfCurr >= 0.3) claims[i].push({ prevIdx: j, frac: fracOfCurr, count: ov });
        if (ov >= Math.max(3, 0.2 * prev[j].size)) contributes[j].push({ currIdx: i, count: ov });
      }
    }
    var candidates = [];
    var annotated = curr.map(function () { return null; });
    // 分裂: prev[j] が2つ以上のcurrへ資格ある量を渡した
    for (var j = 0; j < m; j++) {
      if (contributes[j].length >= 2) {
        var childIds = contributes[j].map(function (c) {
          var id = 'L' + (state.nextId++);
          annotated[c.currIdx] = { lineageId: id, parentId: prev[j].lineageId, bornThisFrame: true };
          return id;
        });
        candidates.push({ type: 'division', t: t, parent: prev[j].lineageId, children: childIds, parentArea: prev[j].size });
      }
    }
    // 融合: curr[i] が2つ以上のprevから資格ある量を受けた
    for (i = 0; i < n; i++) {
      if (annotated[i]) continue;
      if (claims[i].length >= 2) {
        var parents = claims[i].map(function (c) { return prev[c.prevIdx].lineageId; });
        var best = claims[i].reduce(function (a, b) { return b.frac > a.frac ? b : a; });
        var newId = 'L' + (state.nextId++);
        annotated[i] = { lineageId: newId, parentId: prev[best.prevIdx].lineageId, bornThisFrame: true };
        candidates.push({ type: 'fusion', t: t, parents: parents, child: newId });
      }
    }
    // 通常の継続 or 単独の新規/単独の子
    for (i = 0; i < n; i++) {
      if (annotated[i]) continue;
      if (claims[i].length === 1) {
        var j2 = claims[i][0].prevIdx;
        var alsoOnlyChild = contributes[j2].length === 1 && contributes[j2][0].currIdx === i;
        if (alsoOnlyChild) annotated[i] = { lineageId: prev[j2].lineageId, parentId: prev[j2].parentId, bornThisFrame: false };
        else annotated[i] = { lineageId: 'L' + (state.nextId++), parentId: prev[j2].lineageId, bornThisFrame: true };
      } else {
        annotated[i] = { lineageId: 'L' + (state.nextId++), parentId: null, bornThisFrame: true };
      }
    }
    // 死: prevで、いずれのcurrへも資格ある量(0.2*size or 3)を渡さなかったもの
    var survivedParents = {};
    for (j = 0; j < m; j++) if (contributes[j].length > 0) survivedParents[j] = true;
    for (j = 0; j < m; j++) {
      if (!survivedParents[j]) candidates.push({ type: 'death', t: t, lineageId: prev[j].lineageId, area: prev[j].size });
    }
    for (i = 0; i < n; i++) curr[i].lineageId = annotated[i].lineageId, curr[i].parentId = annotated[i].parentId, curr[i].bornThisFrame = annotated[i].bornThisFrame;
    return { curr: curr, candidates: candidates };
  }

  /** 死因の分類（criteria.json K-144）。nextVoids: 死んだ細胞のあった場所にできた、今の観測の膜でない成分すべて（資格の有無問わず）。 */
  function classifyDeathCause(deadCell, nextMask, nextAField, lat, thetaA) {
    var members = deadCell.members;
    var wrapCount = 0, absorbedCount = 0, aliveButUnqualified = 0, shrunk = 0, total = members.length;
    var seenNonMembrane = 0;
    members.forEach(function (x) {
      if (nextMask[x] === 1) return; // 膜化(破れではなく壁の一部化。破れの一形態として数える)
      seenNonMembrane++;
    });
    // 単純化: 膜サイト化した割合が過半 → 破れ／それ以外で活性が閾値未満 → 飢え／面積相当が小さい → 縮小／それ以外 → 吸収
    var becameMembrane = 0, stillActive = 0;
    members.forEach(function (x) { if (nextMask[x] === 1) becameMembrane++; else if (nextAField[x] >= thetaA) stillActive++; });
    var cause;
    if (becameMembrane / total >= 0.5) cause = 'rupture';
    else if (stillActive / total >= 0.5) cause = 'absorbed';
    else if (total < 7) cause = 'shrunk';
    else cause = 'starved';
    return cause;
  }

  /** 分裂・融合の候補に「成り行き」を後付けする（K-144）。lineageLastSeen: id -> 最後に資格あり観測されたt。 */
  function classifyOutcomes(events, lineageLastSeen, tauP, tEnd) {
    return events.map(function (ev) {
      if (ev.type === 'division') {
        var alive = ev.children.filter(function (id) { return (lineageLastSeen[id] || -1) >= ev.t + tauP; });
        var censored = ev.t + tauP > tEnd;
        var outcome;
        if (censored) outcome = 'censored';
        else if (alive.length >= 2) outcome = 'success';
        else if (alive.length === 1) outcome = 'oneOnly';
        else outcome = 'bothDied';
        return Object.assign({}, ev, { outcome: outcome, censored: censored });
      }
      if (ev.type === 'fusion') {
        var childAlive = (lineageLastSeen[ev.child] || -1) >= ev.t + tauP;
        var censored2 = ev.t + tauP > tEnd;
        return Object.assign({}, ev, { outcome: censored2 ? 'censored' : (childAlive ? 'held' : 'splitBack'), censored: censored2 });
      }
      return ev;
    });
  }

  /**
   * H-strict（⑤）: t0 の資格ある細胞の壁が t0+τp の子孫の壁（膨張1サイト許容）にどれだけ残るか。
   * wallHistories: t0 -> [{lineageId, wallSet, wallSize}], descendantsOf(lineageId, t0, t0+tauP) -> [lineageId,...]
   */
  function eachOf(setOrArray, fn) {
    if (Array.isArray(setOrArray)) setOrArray.forEach(fn);
    else Object.keys(setOrArray).forEach(function (k) { fn(Number(k)); });
  }

  function hStrictAt(wallAtT0, wallAtT0PlusTauP, descendantsOf, allowance, lat) {
    var pooled = { totalW: 0, retained: 0 };
    accumulateHStrict(pooled, wallAtT0, wallAtT0PlusTauP, descendantsOf, allowance, lat);
    return pooled.totalW > 0 ? pooled.retained / pooled.totalW : null;
  }

  function accumulateHStrict(pooled, wallAtT0, wallAtT0PlusTauP, descendantsOf, allowance, lat) {
    wallAtT0.forEach(function (cell) {
      var descIds = descendantsOf(cell.lineageId);
      var descWallUnion = {};
      wallAtT0PlusTauP.forEach(function (c2) { if (descIds.indexOf(c2.lineageId) >= 0) eachOf(c2.wallSet, function (x) { descWallUnion[x] = true; }); });
      var expanded = allowance > 0 ? expandSet(descWallUnion, allowance, lat) : descWallUnion;
      var keep = 0;
      cell.wallMembers.forEach(function (x) { if (expanded[x]) keep++; });
      pooled.totalW += cell.wallMembers.length;
      pooled.retained += keep;
    });
  }

  /**
   * H-strict（⑤本番版）: W2内の複数のt0（groups）をプールして1つのh12を返す（criteria.jsonの
   * 「壁の大きさで重み付けてプールする」）。groups: [{wallAtT0, wallAtT0PlusTauP, descendantsOf}]。
   */
  function hStrictPooled(groups, allowance, lat) {
    var pooled = { totalW: 0, retained: 0 };
    groups.forEach(function (g) { accumulateHStrict(pooled, g.wallAtT0, g.wallAtT0PlusTauP, g.descendantsOf, allowance, lat); });
    return { h: pooled.totalW > 0 ? pooled.retained / pooled.totalW : null, totalW: pooled.totalW, n: groups.length };
  }

  /** 系譜の親子索引からの子孫（自分を含む）。parentOf: {id: parentIdまたはnull}。 */
  function buildChildrenIndex(parentOf) {
    var children = {};
    Object.keys(parentOf).forEach(function (id) {
      var p = parentOf[id];
      if (p) (children[p] = children[p] || []).push(id);
    });
    return children;
  }
  function allDescendants(id, children) {
    var out = [id], stack = [id];
    while (stack.length) {
      var cur = stack.pop();
      (children[cur] || []).forEach(function (c) { out.push(c); stack.push(c); });
    }
    return out;
  }

  /**
   * h23（⑤群れ版）: 群れ(U3)自体には検出器がIDを振らない（criteria.jsonに群れの照合規則は無い）ので、
   * S2は「群れに属する細胞のlineageId集合」の多数決の重なりで群れの継続を判定する
   * （U1のtrackAges・U2のmatchFrameと同じ考え方を1段上へ適用したもの。raw/notes.mdへ申し送り）。
   * colonyAt: [{cellLineageIds:[...]}]（1観測点の群れの一覧）。
   * 戻り値: マッチした場合 {matchedIdx, overlapFrac}、無ければ null。
   */
  function matchColony(colony, candidateColonies) {
    var bestIdx = -1, bestFrac = 0;
    candidateColonies.forEach(function (cand, idx) {
      var ov = 0;
      colony.cellLineageIds.forEach(function (id) { if (cand.cellLineageIds.indexOf(id) >= 0) ov++; });
      var frac = ov / Math.max(colony.cellLineageIds.length, cand.cellLineageIds.length);
      if (frac > bestFrac) { bestFrac = frac; bestIdx = idx; }
    });
    return bestFrac >= 0.5 ? { matchedIdx: bestIdx, overlapFrac: bestFrac } : null;
  }

  /**
   * h23_lineage/h23_ident をt0の1点ぶん集計する。t0Colonies/lookaheadColonies:
   * [{cellLineageIds:[...]}]、lookaheadCellIds: t0+τpに資格ある細胞のlineageId集合（Setとして使う配列）。
   */
  function h23AtOnePoint(t0Colonies, lookaheadColonies, childrenIndex, acc) {
    t0Colonies.forEach(function (col) {
      var matched = matchColony(col, lookaheadColonies);
      var matchedColony = matched ? lookaheadColonies[matched.matchedIdx] : null;
      col.cellLineageIds.forEach(function (cellId) {
        acc.n++;
        if (!matchedColony) return;
        var desc = allDescendants(cellId, childrenIndex);
        var anyDescInColony = desc.some(function (d) { return matchedColony.cellLineageIds.indexOf(d) >= 0; });
        if (anyDescInColony) acc.lineageHits++;
        if (matchedColony.cellLineageIds.indexOf(cellId) >= 0) acc.identHits++;
      });
    });
  }

  function expandSet(set, dist, lat) {
    var cur = Object.keys(set).map(Number), out = Object.assign({}, set);
    for (var d = 0; d < dist; d++) {
      var next = [];
      cur.forEach(function (x) { for (var k = 0; k < 6; k++) { var y = lat.neighbor(x, k); if (!out[y]) { out[y] = true; next.push(y); } } });
      cur = next;
    }
    return out;
  }

  var T = {
    overlapCount: overlapCount, matchFrame: matchFrame, classifyDeathCause: classifyDeathCause, classifyOutcomes: classifyOutcomes,
    hStrictAt: hStrictAt, hStrictPooled: hStrictPooled, expandSet: expandSet,
    buildChildrenIndex: buildChildrenIndex, allDescendants: allDescendants, matchColony: matchColony, h23AtOnePoint: h23AtOnePoint,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = T;
  global.S65Tracking = T;
})(typeof window !== 'undefined' ? window : globalThis);
