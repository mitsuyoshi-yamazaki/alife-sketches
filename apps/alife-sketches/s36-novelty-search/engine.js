/**
 * S-36 の走らせ役。1 レプリケート＝1 本の探索を最後まで回して記録を返す。
 * 世界の作り方（迷路・的・欺瞞の強さ）と、探索器の配線がここにある。
 * 核 `core.js` はここから呼ばれるだけで、ここの語彙を知らない。
 */
(function (root, factory) {
  var isNode = (typeof module === 'object' && module.exports);
  var core = isNode ? require('./core.js') : root.S36;
  var search = isNode ? require('./search.js') : root.S36S;
  var api = factory(core, search);
  if (isNode) module.exports = api;
  if (root) root.S36E = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function (S36, S36S) {
  'use strict';

  function euclid(a, b, w) {
    var dx = (a % w) - (b % w), dy = ((a / w) | 0) - ((b / w) | 0);
    return Math.sqrt(dx * dx + dy * dy);
  }

  /* ------------------------------------------------------------- 世界作り */

  /**
   * 迷路・起点・的を組み立て、**欺瞞の強さ**を測る（題材側の登録項目・K-65）。
   *   deception = 「的への直線距離が下位 10% の枡のうち、歩数が全体の中央値を超えるものの割合」
   *   straight  = 直線距離と歩数の Pearson 相関
   * 一本道では直線距離 = 歩数なので deception = 0・straight = 1 になる（実装の外から来る恒等式）。
   */
  function makeWorld(spec) {
    var lat, origin, target, i;
    if (spec.kind === 'corridor') {
      lat = S36.corridorLattice(spec.len);
      origin = 1 * lat.w + 1;
      target = 1 * lat.w + spec.len;
    } else if (spec.kind === 'stair') {
      lat = S36.stairLattice(spec.n);
      origin = 1 * lat.w + 1;
      target = (spec.n + 1) * lat.w + (spec.n + 1);
    } else if (spec.kind === 'hollow') {
      lat = S36.hollowLattice(spec.w, spec.h);
      origin = 1 * lat.w + 1;
      target = (spec.h - 2) * lat.w + (spec.w - 2);
    } else {
      lat = S36.carveLattice(spec.cells, S36.makeRng(spec.seed >>> 0));
      origin = 1 * lat.w + 1;
      var far = S36.stepCounts(lat, origin);
      var order = S36.openCells(lat).slice().sort(function (a, b) { return far[b] - far[a]; });
      var at = Math.max(0, Math.min(order.length - 1, Math.round((spec.depth == null ? 0 : spec.depth) * (order.length - 1))));
      target = order[at];
      if (spec.kind === 'sealed') {
        /* 的の四近傍を塞ぐ。どこからも届かなくなる（負コントロール） */
        var blocked = Uint8Array.from(lat.blocked);
        for (i = 0; i < 4; i++) blocked[target + S36.DY[i] * lat.w + S36.DX[i]] = 1;
        lat = { w: lat.w, h: lat.h, blocked: blocked, marks: lat.marks };
      }
    }

    var toTarget = S36.stepCounts(lat, target);
    var cells = S36.openCells(lat);
    var straightTo = new Float64Array(lat.w * lat.h);
    for (i = 0; i < straightTo.length; i++) straightTo[i] = euclid(i, target, lat.w);
    var ord = {}, n = 0;
    for (i = 0; i < cells.length; i++) ord[cells[i]] = n++;

    /* 欺瞞の強さ（到達できる枡だけで測る） */
    var pairs = [];
    for (i = 0; i < cells.length; i++) {
      if (toTarget[cells[i]] < 0) continue;
      pairs.push([euclid(cells[i], target, lat.w), toTarget[cells[i]]]);
    }
    var deception = 0, straight = 0;
    if (pairs.length > 3) {
      var byE = pairs.slice().sort(function (a, b) { return a[0] - b[0]; });
      var bySteps = pairs.map(function (p) { return p[1]; }).sort(function (a, b) { return a - b; });
      var medSteps = bySteps[bySteps.length >> 1];
      var take = Math.max(1, Math.round(byE.length * 0.10)), over = 0;
      for (i = 0; i < take; i++) if (byE[i][1] > medSteps) over++;
      deception = over / take;
      var me = 0, ms = 0;
      for (i = 0; i < pairs.length; i++) { me += pairs[i][0]; ms += pairs[i][1]; }
      me /= pairs.length; ms /= pairs.length;
      var sxy = 0, sxx = 0, syy = 0;
      for (i = 0; i < pairs.length; i++) {
        var de = pairs[i][0] - me, ds = pairs[i][1] - ms;
        sxy += de * ds; sxx += de * de; syy += ds * ds;
      }
      straight = (sxx > 0 && syy > 0) ? sxy / Math.sqrt(sxx * syy) : 1;
    }

    /* 「先に遠ざからなければ着けない量」（原典の cul-de-sac の言い方の数量化）。
       最短経路を辿りながら、それまでの最小の直線距離からどれだけ戻されるかの最大値。
       一本道では厳密に 0 になる。 */
    var backtrack = 0;
    if (toTarget[origin] > 0) {
      var p = origin, best = straightTo[origin], d2;
      while (p !== target) {
        var nxt = -1;
        for (i = 0; i < 4; i++) {
          var q = p + S36.DY[i] * lat.w + S36.DX[i];
          if (q < 0 || q >= toTarget.length) continue;
          if (toTarget[q] === toTarget[p] - 1) { nxt = q; break; }
        }
        if (nxt < 0) break;
        p = nxt;
        d2 = straightTo[p] - best;
        if (d2 > backtrack) backtrack = d2;
        if (straightTo[p] < best) best = straightTo[p];
      }
      backtrack = backtrack / straightTo[origin];
    }

    return {
      lattice: lat, origin: origin, heading: 1, target: target,
      toTarget: toTarget, straightTo: straightTo, cells: cells, ordinal: { map: ord, size: n },
      reachable: toTarget[origin] >= 0, stepsToTarget: toTarget[origin],
      deception: Math.round(deception * 1e4) / 1e4,
      straight: Math.round(straight * 1e4) / 1e4,
      backtrack: Math.round(backtrack * 1e4) / 1e4,
      spec: spec
    };
  }

  /* ------------------------------------------------------- 1 レプリケート */

  var DEFAULTS = {
    pop: 40, gens: 300, steps: 400, rate: 0.10, scale: 1.0,
    searcher: 'novelty', descriptor: 'endpoint',
    k: 15, rho0: 6.0, rho0Rel: 1.0, rhoMode: 'borrowed', archiveCap: 0, power: 2,
    reachRadius: 2, tournament: 2, keepCurve: false
  };

  function conf(o) {
    var c = {}, key;
    for (key in DEFAULTS) c[key] = DEFAULTS[key];
    for (key in o) if (o[key] !== undefined) c[key] = o[key];
    return c;
  }

  function mean(a) { var s = 0, i; for (i = 0; i < a.length; i++) s += a[i]; return a.length ? s / a.length : 0; }
  function sd(a) {
    var m = mean(a), s = 0, i;
    for (i = 0; i < a.length; i++) s += (a[i] - m) * (a[i] - m);
    return a.length > 1 ? Math.sqrt(s / (a.length - 1)) : 0;
  }
  function median(a) {
    if (!a.length) return null;
    var b = a.slice().sort(function (x, y) { return x - y; });
    var h = b.length >> 1;
    return (b.length % 2) ? b[h] : (b[h - 1] + b[h]) / 2;
  }

  /**
   * 1 本の探索を **1 世代ずつ** 進められる形で作る。`runOnce` も見せ役もこれを回すので、
   * 両者が食い違うことが原理的に起きない（K-5）。
   */
  function makeRun(world, opt) {
    var c = conf(opt);
    var S = S36S.SEARCHERS[c.searcher];
    if (!S) throw new Error('知らない探索器: ' + c.searcher);
    var desc = S36S.DESCRIPTORS[c.descriptor];
    if (!desc) throw new Error('知らない記述: ' + c.descriptor);

    var lat = world.lattice, w = lat.w;
    var ctx = { w: lat.w, h: lat.h, steps: c.steps, origin: world.origin, ordinal: world.ordinal };
    var build = desc.build(ctx);
    var endBuild = S36S.DESCRIPTORS.endpoint.build(ctx);

    var rng = S36.makeRng(c.seed >>> 0);
    var vectors = [], i;
    for (i = 0; i < c.pop; i++) vectors.push(S36.makeVector(rng));

    var st = {
      gen: 0, done: false,
      archive: [], rho: c.rho0, quiet: 0, archiveAdds: 0, evals: 0,
      firstG1: -1, firstG2: -1, firstG3: -1,
      minEnd: Infinity, minPath: Infinity,
      ownDiffs: [], objDiffs: [], novDiffs: [],
      endSeen: {}, endCount: 0, curve: c.keepCurve ? [] : null,
      last: null
    };
    var buf = new Float64Array(4096);

    function step() {
      if (st.done) return st;
      var g = st.gen;
      var traces = new Array(c.pop), descs = new Array(c.pop), ends = new Array(c.pop);
      var objScore = new Float64Array(c.pop);
      var bestEnd = Infinity, bestPath = Infinity, tab = world.straightTo;

      for (i = 0; i < c.pop; i++) {
        var tr = S36.traceLattice({ lattice: lat, vector: vectors[i], origin: world.origin, heading: world.heading, steps: c.steps });
        traces[i] = tr; st.evals++;
        var de = tab[tr.last];
        objScore[i] = -de;
        if (de < bestEnd) bestEnd = de;
        if (!st.endSeen[tr.last]) { st.endSeen[tr.last] = 1; st.endCount++; }
        var t, near2 = Infinity, hitPath = false;
        for (t = 0; t <= c.steps; t++) {
          var dd = tab[tr.visits[t]];
          if (dd === 0) { hitPath = true; near2 = 0; break; }
          if (dd < near2) near2 = dd;
        }
        if (near2 < bestPath) bestPath = near2;
        if (hitPath && st.firstG1 < 0) st.firstG1 = g;
        if (tr.last === world.target && st.firstG2 < 0) st.firstG2 = g;
        if (de <= c.reachRadius && st.firstG3 < 0) st.firstG3 = g;
        descs[i] = build(tr, vectors[i]);
        ends[i] = endBuild(tr, vectors[i]);
      }
      if (bestEnd < st.minEnd) st.minEnd = bestEnd;
      if (bestPath < st.minPath) st.minPath = bestPath;
      if (st.curve) st.curve.push(Math.round(bestEnd * 1000) / 1000);

      var pool = S.noArchive ? descs : descs.concat(st.archive);
      var need = Math.max(pool.length, c.pop) + 8;
      if (buf.length < need) buf = new Float64Array(need);
      var novOwn = new Float64Array(c.pop), novRef = new Float64Array(c.pop);
      if (S.needsDescriptor) {
        for (i = 0; i < c.pop; i++) novOwn[i] = S36S.sparsenessQuick(descs[i], pool, i, c.k, desc.kind, c.power, buf);
      }
      for (i = 0; i < c.pop; i++) novRef[i] = S36S.sparsenessQuick(ends[i], ends, i, c.k, 'real', c.power, buf);

      /* アーカイブの閾値: 'fixed' は原典の 6.0 をそのまま、'borrowed' は第0世代の中央値を系から借りる */
      if (g === 0 && S.needsDescriptor && c.rhoMode === 'borrowed') {
        st.rho = (median(Array.from(novOwn)) || 1) * c.rho0Rel;
      }
      if (S.needsDescriptor && !S.noArchive) {
        var added = 0;
        for (i = 0; i < c.pop; i++) {
          if (novOwn[i] > st.rho) {
            st.archive.push(descs[i]); added++; st.archiveAdds++;
            if (c.archiveCap > 0 && st.archive.length > c.archiveCap) st.archive.shift();
          }
        }
        if (c.rhoMode !== 'off' && c.rhoMode !== 'static') {
          if (added > 4) { st.rho *= 1.2; st.quiet = 0; }
          else if (added === 0) { st.quiet++; if (st.quiet >= 5) { st.rho *= 0.95; st.quiet = 0; } }
          else st.quiet = 0;
        }
      }

      var score;
      if (S.score === 'objective') score = objScore;
      else if (S.score === 'novelty') { score = Float64Array.from(novOwn); if (S.flip) for (i = 0; i < c.pop; i++) score[i] = -score[i]; }
      else score = new Float64Array(c.pop);
      if (S.shuffle) {
        var perm = [], j, tmp;
        for (i = 0; i < c.pop; i++) perm.push(score[i]);
        for (i = c.pop - 1; i > 0; i--) { j = rng.below(i + 1); tmp = perm[i]; perm[i] = perm[j]; perm[j] = tmp; }
        score = Float64Array.from(perm);
      }

      st.last = { traces: traces, ends: ends, score: score, objScore: objScore,
        novOwn: novOwn, bestEnd: bestEnd, vectors: vectors };
      st.gen = g + 1;
      if (st.gen >= c.gens) { st.done = true; st.vectors = vectors; return st; }

      if (S.resample) {
        var fresh = [];
        for (i = 0; i < c.pop; i++) fresh.push(S36.makeVector(rng));
        vectors = fresh; st.vectors = vectors;
        return st;
      }

      var chooser = (c.searcher === 'uniform')
        ? function (count, r) {
            var out = new Int32Array(count), a;
            for (a = 0; a < count; a++) { var p = r.below(count); r.below(count); out[a] = p; }
            return out;
          }
        : function (count, r) {
            var out = new Int32Array(count), a, x, y2;
            for (a = 0; a < count; a++) {
              x = r.below(count); y2 = r.below(count);
              out[a] = (score[x] >= score[y2]) ? x : y2;
            }
            return out;
          };

      var stepped = S36.advance({ vectors: vectors, chooser: chooser, rng: rng, rate: c.rate, scale: c.scale });
      var parents = stepped.parents;
      var sdOwn = sd(Array.from(score)), sdObj = sd(Array.from(objScore)), sdNov = sd(Array.from(novRef));
      var pickedOwn = [], pickedObj = [], pickedNov = [];
      for (i = 0; i < parents.length; i++) {
        pickedOwn.push(score[parents[i]]); pickedObj.push(objScore[parents[i]]); pickedNov.push(novRef[parents[i]]);
      }
      if (sdOwn > 0) st.ownDiffs.push((mean(pickedOwn) - mean(Array.from(score))) / sdOwn);
      if (sdObj > 0) st.objDiffs.push((mean(pickedObj) - mean(Array.from(objScore))) / sdObj);
      if (sdNov > 0) st.novDiffs.push((mean(pickedNov) - mean(Array.from(novRef))) / sdNov);
      vectors = stepped.vectors;
      st.vectors = vectors;
      return st;
    }

    st.vectors = vectors;
    return { conf: c, state: st, step: step, world: world, descriptor: desc };
  }

  /** 1 レプリケートを最後まで回して記録を返す。中身は `makeRun` を回しているだけ。 */
  function runOnce(world, opt) {
    var run = makeRun(world, opt), c = run.conf, st = run.state;
    while (!st.done) run.step();
    return {
      searcher: c.searcher, descriptor: c.descriptor, seed: c.seed,
      pop: c.pop, gens: c.gens, steps: c.steps, rate: c.rate, scale: c.scale,
      k: c.k, rho0: c.rho0, rho0Rel: c.rho0Rel, rhoMode: c.rhoMode,
      archiveCap: c.archiveCap, power: c.power, reachRadius: c.reachRadius,
      firstG1: st.firstG1, firstG2: st.firstG2, firstG3: st.firstG3,
      minEnd: Math.round(st.minEnd * 1000) / 1000,
      minPath: Math.round(st.minPath * 1000) / 1000,
      archive: st.archive.length, archiveAdds: st.archiveAdds,
      rho: Math.round(st.rho * 1000) / 1000,
      distinctEnds: st.endCount, evals: st.evals,
      ownDiff: Math.round(mean(st.ownDiffs) * 1e4) / 1e4,
      objDiff: Math.round(mean(st.objDiffs) * 1e4) / 1e4,
      novDiff: Math.round(mean(st.novDiffs) * 1e4) / 1e4,
      digest: S36.digestVectors(st.vectors),
      curve: st.curve
    };
  }

  return {
    makeWorld: makeWorld, makeRun: makeRun, runOnce: runOnce, euclid: euclid,
    mean: mean, sd: sd, median: median, DEFAULTS: DEFAULTS
  };
});
