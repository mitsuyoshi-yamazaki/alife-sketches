/**
 * S-22 の観測器。**ここから先だけが「閉包」「自己維持」「組織」「回復」を語る。**
 * core.js の側には整数と規則と容器しか無い。
 *
 * ---- 定義（Dittrich & Speroni di Fenizio 2007, Bull. Math. Biol. 69:1199）----
 *
 *   閉包 (Def. 2)         C 内の順序対に適用できる全規則の積が C に入る
 *   used-up / produced    (Def. 4) scheme A では「C 内の反応で置き換えられる側 b に現れる種」が
 *                         used-up、「積 p に現れる種」が produced。scheme B では希釈があるので
 *                         C の全種が used-up
 *   self-maintaining      (Def. 4) used-up な種はすべて produced
 *   半組織 (Def. 5)        閉かつ self-maintaining
 *   mass-maintaining      (Def. 6) 流束 v > 0 を全反応に置いて全種の正味生産 ≥ 0。
 *                         本系の反応は全て「b を 1 減らし p を 1 増やす」単位化学量論なので、
 *                         scheme A では Σ_i f_i = 0 → 全 f_i = 0 → v は循環流 → 正の循環流が
 *                         存在する ⇔ 全ての辺 b→p が有向閉路の上にある（両端が同じ強連結成分）。
 *                         scheme B では希釈流束を自由に小さく取れるので「全種が produced」と同値
 *   組織 (Def. 7)          閉かつ mass-maintaining
 *   inert（本スケッチの語） C 内に反応が 1 つも無い。空虚に半組織。**非自明な組織**は反応を含む組織
 *   activity              C の種のうち used-up なものの割合
 *   生成 (Def. 11 を操作的に) 閉包 → 「used-up だが produced でない種」の反復除去（不動点まで）
 *
 * 依存ゼロ。core.js と同じく Node とブラウザで共用する（古典スクリプト・UMD 風）。
 */
(function (root, factory) {
  var api = factory(typeof module === 'object' && module.exports ? require('./core.js') : root.S22);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S22S = api;
})(typeof self !== 'undefined' ? self : this, function (S22) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 集合の表し方: 長さ M+1 の Uint8Array（所属表）。添字 2..M だけ使う
   * ------------------------------------------------------------------ */

  function maskOf(list, M) {
    var m = new Uint8Array(M + 1);
    for (var i = 0; i < list.length; i++) m[list[i]] = 1;
    return m;
  }

  function listOf(mask) {
    var out = [];
    for (var x = 2; x < mask.length; x++) if (mask[x]) out.push(x);
    return out;
  }

  function sizeOf(mask) {
    var n = 0;
    for (var x = 2; x < mask.length; x++) if (mask[x]) n++;
    return n;
  }

  function sameMask(a, b) {
    if (a.length !== b.length) return false;
    for (var x = 2; x < a.length; x++) if (a[x] !== b[x]) return false;
    return true;
  }

  function maskKey(mask) {
    var words = [], w = 0, bit = 0;
    for (var x = 0; x < mask.length; x++) {
      if (mask[x]) w |= (1 << bit);
      if (++bit === 30) { words.push(w); w = 0; bit = 0; }
    }
    words.push(w);
    return words.join(',');
  }

  /* ------------------------------------------------------------------ *
   * 閉包
   * ------------------------------------------------------------------ */

  /** 作業列で閉包を作る。O(|C|^2 · 規則数)。 */
  function closure(mask, rules, M) {
    var C = new Uint8Array(M + 1), list = [], buf = new Int32Array(8);
    for (var x = 2; x <= M; x++) if (mask[x]) { C[x] = 1; list.push(x); }
    var head = 0;
    while (head < list.length) {
      var y = list[head++];
      for (var i = 0; i < list.length; i++) {
        var z = list[i];
        var k = S22.products(rules, y, z, M, buf);
        for (var q = 0; q < k; q++) if (!C[buf[q]]) { C[buf[q]] = 1; list.push(buf[q]); }
        if (z !== y) {
          k = S22.products(rules, z, y, M, buf);
          for (var q2 = 0; q2 < k; q2++) if (!C[buf[q2]]) { C[buf[q2]] = 1; list.push(buf[q2]); }
        }
      }
    }
    return C;
  }

  /** 素朴版（検算用）。全順序対を毎回総当たりして、増えなくなるまで繰り返す。 */
  function closureNaive(mask, rules, M) {
    var C = Uint8Array.from(mask), buf = new Int32Array(8), grew = true;
    while (grew) {
      grew = false;
      for (var a = 2; a <= M; a++) {
        if (!C[a]) continue;
        for (var b = 2; b <= M; b++) {
          if (!C[b]) continue;
          var k = S22.products(rules, a, b, M, buf);
          for (var q = 0; q < k; q++) if (!C[buf[q]]) { C[buf[q]] = 1; grew = true; }
        }
      }
    }
    return C;
  }

  function isClosed(mask, rules, M) {
    var buf = new Int32Array(8);
    for (var a = 2; a <= M; a++) {
      if (!mask[a]) continue;
      for (var b = 2; b <= M; b++) {
        if (!mask[b]) continue;
        var k = S22.products(rules, a, b, M, buf);
        for (var q = 0; q < k; q++) if (!mask[buf[q]]) return false;
      }
    }
    return true;
  }

  /* ------------------------------------------------------------------ *
   * used-up / produced / 反応辺
   * ------------------------------------------------------------------ */

  /**
   * C 内の反応をすべて列挙する。返り値: { usedUp, produced, nReactions, edges }
   * edges は [b, p] の平坦な Int32Array（2 要素ずつ）。scheme B では usedUp は C の全種。
   */
  function reactionsWithin(mask, rules, M, scheme) {
    var usedUp = new Uint8Array(M + 1), produced = new Uint8Array(M + 1);
    var edges = [], n = 0, buf = new Int32Array(8);
    for (var a = 2; a <= M; a++) {
      if (!mask[a]) continue;
      for (var b = 2; b <= M; b++) {
        if (!mask[b]) continue;
        var k = S22.products(rules, a, b, M, buf);
        for (var q = 0; q < k; q++) {
          var p = buf[q];
          if (!mask[p]) continue; // 閉じていない集合でも「内側の反応」だけ数える
          usedUp[b] = 1; produced[p] = 1; edges.push(b, p); n++;
        }
      }
    }
    if (scheme === 'B') for (var x = 2; x <= M; x++) if (mask[x]) usedUp[x] = 1;
    return { usedUp: usedUp, produced: produced, nReactions: n, edges: edges };
  }

  function isSelfMaintaining(mask, rules, M, scheme) {
    var w = reactionsWithin(mask, rules, M, scheme);
    for (var x = 2; x <= M; x++) if (mask[x] && w.usedUp[x] && !w.produced[x]) return false;
    return true;
  }

  /** 強連結成分（Tarjan の反復版）。nodes は種の配列、adj は種 → 積の配列。 */
  function sccOf(nodes, adj, M) {
    var index = new Int32Array(M + 1).fill(-1), low = new Int32Array(M + 1), onStack = new Uint8Array(M + 1);
    var comp = new Int32Array(M + 1).fill(-1), stack = [], counter = 0, ncomp = 0;
    for (var s = 0; s < nodes.length; s++) {
      var root = nodes[s];
      if (index[root] !== -1) continue;
      var work = [[root, 0]];
      index[root] = low[root] = counter++; stack.push(root); onStack[root] = 1;
      while (work.length) {
        var top = work[work.length - 1], v = top[0], i = top[1], nb = adj[v] || [];
        if (i < nb.length) {
          top[1] = i + 1;
          var wv = nb[i];
          if (index[wv] === -1) {
            index[wv] = low[wv] = counter++; stack.push(wv); onStack[wv] = 1;
            work.push([wv, 0]);
          } else if (onStack[wv]) {
            if (index[wv] < low[v]) low[v] = index[wv];
          }
        } else {
          work.pop();
          if (work.length) { var u = work[work.length - 1][0]; if (low[v] < low[u]) low[u] = low[v]; }
          if (low[v] === index[v]) {
            var z;
            do { z = stack.pop(); onStack[z] = 0; comp[z] = ncomp; } while (z !== v);
            ncomp++;
          }
        }
      }
    }
    return comp;
  }

  /**
   * mass-maintaining（Def. 6）。scheme A: 全ての辺 b→p が同じ強連結成分の中にある。
   * scheme B: 全種が produced。閉じていることは前提にしない（内側の反応だけ見る）。
   */
  function isMassMaintaining(mask, rules, M, scheme) {
    var w = reactionsWithin(mask, rules, M, scheme);
    if (scheme === 'B') {
      for (var x = 2; x <= M; x++) if (mask[x] && !w.produced[x]) return false;
      return true;
    }
    if (w.nReactions === 0) return true;
    var adj = {}, nodes = listOf(mask);
    for (var e = 0; e < w.edges.length; e += 2) {
      var b = w.edges[e], p = w.edges[e + 1];
      (adj[b] || (adj[b] = [])).push(p);
    }
    var comp = sccOf(nodes, adj, M);
    for (var e2 = 0; e2 < w.edges.length; e2 += 2) {
      if (comp[w.edges[e2]] !== comp[w.edges[e2 + 1]]) return false;
    }
    return true;
  }

  /** 素朴な mass-maintaining（検算用）: 各辺について「p から b へ戻る道があるか」を BFS で確かめる。 */
  function isMassMaintainingNaive(mask, rules, M, scheme) {
    var w = reactionsWithin(mask, rules, M, scheme);
    if (scheme === 'B') {
      for (var x = 2; x <= M; x++) if (mask[x] && !w.produced[x]) return false;
      return true;
    }
    var adj = {};
    for (var e = 0; e < w.edges.length; e += 2) (adj[w.edges[e]] || (adj[w.edges[e]] = [])).push(w.edges[e + 1]);
    function reaches(from, to) {
      var seen = new Uint8Array(M + 1), q = [from]; seen[from] = 1;
      while (q.length) {
        var v = q.shift();
        if (v === to) return true;
        var nb = adj[v] || [];
        for (var i = 0; i < nb.length; i++) if (!seen[nb[i]]) { seen[nb[i]] = 1; q.push(nb[i]); }
      }
      return false;
    }
    for (var e2 = 0; e2 < w.edges.length; e2 += 2) if (!reaches(w.edges[e2 + 1], w.edges[e2])) return false;
    return true;
  }

  function isInert(mask, rules, M) {
    return reactionsWithin(mask, rules, M, 'A').nReactions === 0;
  }

  function activity(mask, rules, M, scheme) {
    var w = reactionsWithin(mask, rules, M, scheme), n = 0, u = 0;
    for (var x = 2; x <= M; x++) if (mask[x]) { n++; if (w.usedUp[x] && w.produced[x]) u++; }
    return n ? u / n : 0;
  }

  /* ------------------------------------------------------------------ *
   * 生成（Def. 11 の操作的な形）
   * ------------------------------------------------------------------ */

  /**
   * 閉包 → 「used-up だが produced でない種」を反復除去。返り値:
   * { G, size, activity, massMaintaining, inert, closureSize, nReactions }
   */
  function generate(mask, rules, M, scheme) {
    var C = closure(mask, rules, M), closureSize = sizeOf(C);
    var w;
    for (;;) {
      w = reactionsWithin(C, rules, M, scheme);
      var removed = 0;
      for (var x = 2; x <= M; x++) if (C[x] && w.usedUp[x] && !w.produced[x]) { C[x] = 0; removed++; }
      if (!removed) break;
    }
    var n = 0, u = 0;
    for (var y = 2; y <= M; y++) if (C[y]) { n++; if (w.usedUp[y] && w.produced[y]) u++; }
    return {
      G: C, size: n, activity: n ? u / n : 0,
      massMaintaining: isMassMaintaining(C, rules, M, scheme),
      inert: w.nReactions === 0, closureSize: closureSize, nReactions: w.nReactions,
      active: u,
    };
  }

  /* ------------------------------------------------------------------ *
   * 再生の静的判定
   * ------------------------------------------------------------------ */

  /** x が現存集合の残り（x を除く）の閉包に入るか。 */
  function staticRecoverable(x, presentMask, rules, M) {
    var m = Uint8Array.from(presentMask); m[x] = 0;
    return closure(m, rules, M)[x] === 1;
  }

  /**
   * x が現存の種の 1 反応で直接作れるか（O(|S|)。絶滅時の安い前段）。
   * 算術の 4 規則は逆像を直接引く。表の規則は総当たり。
   */
  function directlyProducible(x, present, rules, M) {
    for (var r = 0; r < rules.length; r++) {
      var id = rules[r].id, a;
      if (id === 'add') {
        for (a = 2; a <= M; a++) if (present[a] && x - a >= 2 && present[x - a]) return true;
      } else if (id === 'sub') {
        for (a = 2; a <= M; a++) if (present[a] && x + a <= M && present[x + a]) return true;
      } else if (id === 'mul') {
        for (a = 2; a * a <= x; a++) if (x % a === 0 && present[a] && present[x / a]) return true;
      } else if (id === 'div') {
        for (a = 2; a * x <= M; a++) if (present[a] && present[a * x]) return true;
      } else {
        for (a = 2; a <= M; a++) {
          if (!present[a]) continue;
          for (var b = 2; b <= M; b++) if (present[b] && rules[r].apply(a, b, M) === x) return true;
        }
      }
    }
    return false;
  }

  /* ------------------------------------------------------------------ *
   * 格子の総当たり（M ≤ 20）と閉包の BFS
   * ------------------------------------------------------------------ */

  /**
   * 2..M の全部分集合を総当たり。返り値:
   * { subsets, closed, semi, org, nontrivialSemi, nontrivialOrg, nontrivial: [ [種...], ... ], semiNotOrg }
   * list には非自明な組織を（上限 listCap まで）残す。
   */
  function enumerateSubsets(M, rules, scheme, listCap) {
    var n = M - 1, total = Math.pow(2, n), cap = listCap === undefined ? 4000 : listCap;
    var res = { subsets: total, closed: 0, semi: 0, org: 0, nontrivialSemi: 0, nontrivialOrg: 0, semiNotOrg: 0, nontrivial: [], activeCores: 0 };
    var cores = {};
    var mask = new Uint8Array(M + 1), buf = new Int32Array(8);
    for (var bits = 0; bits < total; bits++) {
      var list = [];
      for (var i = 0; i < n; i++) { var on = (bits >>> i) & 1; mask[i + 2] = on; if (on) list.push(i + 2); }
      // 閉じているか
      var closed = true, nReact = 0;
      var usedUp = null, produced = null, edges = null;
      for (var p1 = 0; p1 < list.length && closed; p1++) {
        for (var p2 = 0; p2 < list.length; p2++) {
          var k = S22.products(rules, list[p1], list[p2], M, buf);
          for (var q = 0; q < k; q++) if (!mask[buf[q]]) { closed = false; break; }
          if (!closed) break;
        }
      }
      if (!closed) continue;
      res.closed++;
      var w = reactionsWithin(mask, rules, M, scheme);
      nReact = w.nReactions;
      var semi = true;
      for (var x = 2; x <= M; x++) if (mask[x] && w.usedUp[x] && !w.produced[x]) { semi = false; break; }
      if (!semi) continue;
      res.semi++;
      if (nReact) res.nontrivialSemi++;
      var org = isMassMaintaining(mask, rules, M, scheme);
      if (!org) { res.semiNotOrg++; continue; }
      res.org++;
      if (nReact) {
        res.nontrivialOrg++;
        if (res.nontrivial.length < cap) res.nontrivial.push(list.slice());
        // 記述子（総当たりを見てから足した）: inert な種を足し引きしただけの組織を同一視する
        var core = [];
        for (var c = 2; c <= M; c++) if (mask[c] && w.usedUp[c]) core.push(c);
        var ck = core.join(',');
        if (!cores[ck]) { cores[ck] = 1; res.activeCores++; }
      }
    }
    return res;
  }

  /**
   * 閉じた集合を「生成元を 1 つずつ足す」BFS で全部集める（上限つき）。
   * 返り値: { closed, semi, org, nontrivialOrg, capped, sizes: 非自明な組織の大きさの並び }
   */
  function closureBFS(M, rules, scheme, cap) {
    var seen = {}, queue = [], res = { closed: 0, semi: 0, org: 0, nontrivialOrg: 0, capped: false, sizes: [] };
    function visit(C) {
      var key = maskKey(C);
      if (seen[key]) return;
      seen[key] = 1; queue.push(C); res.closed++;
      var w = reactionsWithin(C, rules, M, scheme), semi = true;
      for (var x = 2; x <= M; x++) if (C[x] && w.usedUp[x] && !w.produced[x]) { semi = false; break; }
      if (semi) {
        res.semi++;
        if (isMassMaintaining(C, rules, M, scheme)) {
          res.org++;
          if (w.nReactions) { res.nontrivialOrg++; res.sizes.push(sizeOf(C)); }
        }
      }
    }
    visit(closure(new Uint8Array(M + 1), rules, M));
    var head = 0;
    while (head < queue.length) {
      var C = queue[head++];
      for (var x = 2; x <= M; x++) {
        if (C[x]) continue;
        var m = Uint8Array.from(C); m[x] = 1;
        visit(closure(m, rules, M));
        if (res.closed >= cap) { res.capped = true; return res; }
      }
    }
    return res;
  }

  /* ------------------------------------------------------------------ *
   * 判定（本番で使うのはここだけ）
   * ------------------------------------------------------------------ */

  function median(xs) {
    var v = Array.prototype.slice.call(xs).sort(function (p, q) { return p - q; });
    var n = v.length;
    if (!n) return 0;
    return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  }

  /** 1 本ごとの札（生ログに残す。腕の判定には使わない）。 */
  function decide(rep, TH) {
    return {
      D1: rep.activity >= TH.activityMin && rep.gSize >= TH.gSizeMin,
      D2: rep.lastDescentFrac <= TH.settledFracMax,
      D3: rep.recoveryDynamic >= TH.recoveryMin,
    };
  }

  /**
   * 腕（同じ設定の複数シード）の判定。各量のシード間中央値で判定する（K-35）。
   * 1 本ごとの発火率も返す。
   */
  function decideArm(reps, TH) {
    function med(f) { return median(reps.map(f)); }
    function frac(f) { return reps.filter(f).length / reps.length; }
    var mAct = med(function (r) { return r.activity; });
    var mG = med(function (r) { return r.gSize; });
    var mLast = med(function (r) { return r.lastDescentFrac; });
    var mRec = med(function (r) { return r.recoveryDynamic; });
    return {
      n: reps.length,
      activity: mAct, gSize: mG, lastDescentFrac: mLast, recoveryDynamic: mRec,
      recoveryStatic: med(function (r) { return r.recoveryStatic; }),
      agreement: med(function (r) { return r.agreement; }),
      descents: med(function (r) { return r.descents; }),
      closureSize: med(function (r) { return r.closureSize; }),
      presentSize: med(function (r) { return r.presentSize; }),
      massMaintainingRate: frac(function (r) { return r.massMaintaining; }),
      D1: mAct >= TH.activityMin && mG >= TH.gSizeMin,
      D2: mLast <= TH.settledFracMax,
      D3: mRec >= TH.recoveryMin,
      perReplicateD1: frac(function (r) { return r.activity >= TH.activityMin && r.gSize >= TH.gSizeMin; }),
      perReplicateD2: frac(function (r) { return r.lastDescentFrac <= TH.settledFracMax; }),
      perReplicateD3: frac(function (r) { return r.recoveryDynamic >= TH.recoveryMin; }),
      activityMin: Math.min.apply(null, reps.map(function (r) { return r.activity; })),
      activityMax: Math.max.apply(null, reps.map(function (r) { return r.activity; })),
      recoveryMin: Math.min.apply(null, reps.map(function (r) { return r.recoveryDynamic; })),
      recoveryMax: Math.max.apply(null, reps.map(function (r) { return r.recoveryDynamic; })),
    };
  }

  /* ------------------------------------------------------------------ *
   * 1 レプリケート（本番と妥当性検査が同じ手順を使う）
   * ------------------------------------------------------------------ */

  /**
   * cfg: { arm, M, kappa, seed, scheme:'A'|'B', Tfactor, Tper(400), TrecPer(50), checkpoints(200),
   *        rules?（腕の代わりに直接与える）, init?, wantSeries, wantKnockouts, knockoutSeeds? }
   * 返り値は生ログの 1 行（row）。wantSeries なら row.series、wantKnockouts なら row.knockoutRows も付く。
   */
  function runReplicate(cfg) {
    var M = cfg.M, N = Math.round(cfg.kappa * (M - 1));
    var rules = cfg.rules || S22.rulesForArm(cfg.arm, M);
    var scheme = cfg.scheme || 'A', Tper = cfg.Tper || 400, TrecPer = cfg.TrecPer || 50;
    var T = Math.round(Tper * (cfg.Tfactor || 1) * N), nCheck = cfg.checkpoints || 200;
    var t0 = Date.now();
    var R = S22.createReactor({ M: M, N: N, rules: rules, scheme: scheme, seed: cfg.seed, init: cfg.init });
    var lnMass0 = S22.lnMass(R), gcd0 = S22.gcdAll(R), ps0 = S22.primeSupport(R).length;
    var descents = 0, lastDescent = 0;
    R.onExtinct = function (x, RR) {
      var pm = S22.presentMask(RR, 1);
      if (!directlyProducible(x, pm, rules, M) && !closure(pm, rules, M)[x]) { descents++; lastDescent = RR.step; }
    };
    var series = [], every = Math.max(1, Math.floor(T / nCheck));
    var primeMonotone = true, lastPrime = S22.primeCounts(R).prime;
    var gcdInvariant = true, psMonotone = true, lastPs = ps0;
    function checkpoint() {
      var pm = S22.presentMask(R, 1), g = generate(pm, rules, M, scheme);
      var pc = S22.primeCounts(R), gc = S22.gcdAll(R), ps = S22.primeSupport(R).length;
      if (pc.prime < lastPrime) primeMonotone = false;
      lastPrime = pc.prime;
      if (gc !== gcd0) gcdInvariant = false;
      if (ps > lastPs) psMonotone = false;
      lastPs = ps;
      if (cfg.wantSeries) series.push({
        step: R.step, reactions: R.reactions, present: R.nSpecies, closure: g.closureSize, G: g.size,
        activity: +g.activity.toFixed(4), gcd: gc, primes: ps, lnMass: +S22.lnMass(R).toFixed(3),
        primeMol: pc.prime, descents: descents,
      });
    }
    checkpoint();
    for (var t = 0; t < T; t += every) { S22.runSteps(R, Math.min(every, T - t)); checkpoint(); }
    var pm = S22.presentMask(R, 1), g = generate(pm, rules, M, scheme);
    var w = reactionsWithin(g.G, rules, M, scheme), sinks = 0, inertInG = 0;
    for (var x = 2; x <= M; x++) if (g.G[x]) { if (w.produced[x] && !w.usedUp[x]) sinks++; if (!w.produced[x] && !w.usedUp[x]) inertInG++; }
    var g2 = generate(S22.presentMask(R, 2), rules, M, scheme);
    var gp = generate(S22.presentMask(R, Math.max(2, Math.ceil(0.02 * N))), rules, M, scheme);
    var ledgerErr = Math.abs(S22.lnMass(R) - (lnMass0 - R.ledger));
    var tMain = Date.now() - t0;

    // ノックアウト
    var present = S22.presentSpecies(R, 1), ko = {
      n: present.length, static: 0, dyn25: 0, dyn50: 0, dyn100: 0, seenAny: 0, agree50: 0, violations: 0,
      dynGivenStatic50: 0, staticN: 0, inG: { n: 0, dyn50: 0 }, ge2: { n: 0, dyn50: 0 }, reactionsRec: 0,
    }, koRows = [];
    if (cfg.wantKnockouts !== false) {
      var Trec = TrecPer * N, marks = [Trec * 0.5, Trec, Trec * 2];
      for (var idx = 0; idx < present.length; idx++) {
        var sp = present[idx], K = S22.cloneReactor(R, (cfg.seed * 7919 + sp * 104729 + 17) >>> 0);
        var before = K.count[sp], inG = g.G[sp] === 1, st = staticRecoverable(sp, pm, rules, M);
        S22.removeSpecies(K, sp, S22.makeRng((cfg.seed * 31 + sp * 977 + 3) >>> 0));
        var firstSeen = -1, at = [false, false, false], done = 0, r0 = K.reactions;
        for (var s = 1; s <= marks[2]; s++) {
          S22.stepReactor(K);
          if (firstSeen < 0 && K.count[sp] > 0) firstSeen = s;
          if (s === marks[done]) { at[done] = K.count[sp] > 0; done++; }
        }
        ko.reactionsRec += (K.reactions - r0);
        if (st) { ko.static++; ko.staticN++; if (at[1]) ko.dynGivenStatic50++; }
        if (at[0]) ko.dyn25++;
        if (at[1]) ko.dyn50++;
        if (at[2]) ko.dyn100++;
        if (firstSeen >= 0) ko.seenAny++;
        if (st === at[1]) ko.agree50++;
        if (!st && (at[0] || at[1] || at[2] || firstSeen >= 0)) ko.violations++;
        if (inG) { ko.inG.n++; if (at[1]) ko.inG.dyn50++; }
        if (before >= 2) { ko.ge2.n++; if (at[1]) ko.ge2.dyn50++; }
        if (cfg.wantKnockouts === true) koRows.push({
          x: sp, count: before, inG: inG, prime: S22.isPrime(sp), usedUp: w.usedUp[sp] === 1, produced: w.produced[sp] === 1,
          static: st, dyn25: at[0], dyn50: at[1], dyn100: at[2], firstSeen: firstSeen,
        });
      }
    }
    function frac(a, b) { return b ? a / b : 0; }
    var row = {
      arm: cfg.arm, M: M, kappa: cfg.kappa, N: N, scheme: scheme, Tfactor: cfg.Tfactor || 1, T: T, seed: cfg.seed,
      reactions: R.reactions, reactionFrac: +(R.reactions / T).toFixed(5),
      presentCount: R.nSpecies, presentSize: +(R.nSpecies / (M - 1)).toFixed(4),
      closureCount: g.closureSize, closureSize: +(g.closureSize / (M - 1)).toFixed(4),
      gSize: g.size, gFrac: +(g.size / (M - 1)).toFixed(4), activity: +g.activity.toFixed(4), active: g.active,
      massMaintaining: g.massMaintaining, inert: g.inert, sinks: sinks, inertInG: inertInG, gReactions: g.nReactions,
      descents: descents, lastDescentStep: lastDescent, lastDescentFrac: +(lastDescent / T).toFixed(4),
      frozen: S22.isFrozen(R), gcd: S22.gcdAll(R), primeSupport: S22.primeSupport(R).length,
      lnMass: +S22.lnMass(R).toFixed(4), ledgerErr: +ledgerErr.toExponential(2),
      primeMonotone: primeMonotone, gcdInvariant: gcdInvariant, psMonotone: psMonotone,
      theta2: { gSize: g2.size, activity: +g2.activity.toFixed(4) },
      thetaPct: { gSize: gp.size, activity: +gp.activity.toFixed(4) },
      knockouts: ko.n, recoveryStatic: +frac(ko.static, ko.n).toFixed(4),
      recoveryDynamic: +frac(ko.dyn50, ko.n).toFixed(4),
      recovery25: +frac(ko.dyn25, ko.n).toFixed(4), recovery100: +frac(ko.dyn100, ko.n).toFixed(4),
      recoverySeenAny: +frac(ko.seenAny, ko.n).toFixed(4),
      agreement: +frac(ko.agree50, ko.n).toFixed(4), dynGivenStatic: +frac(ko.dynGivenStatic50, ko.staticN).toFixed(4),
      violations: ko.violations,
      recoveryInG: +frac(ko.inG.dyn50, ko.inG.n).toFixed(4), knockoutsInG: ko.inG.n,
      recoveryGe2: +frac(ko.ge2.dyn50, ko.ge2.n).toFixed(4), knockoutsGe2: ko.ge2.n,
      reactionsPerKnockout: +frac(ko.reactionsRec, ko.n).toFixed(1),
      stateHash: S22.stateHash(R), msMain: tMain, ms: Date.now() - t0,
    };
    if (cfg.wantSeries) { row.series = series; row.gList = listOf(g.G); row.presentList = present; }
    if (cfg.wantKnockouts === true) row.knockoutRows = koRows;
    return row;
  }

  return {
    runReplicate: runReplicate,
    maskOf: maskOf, listOf: listOf, sizeOf: sizeOf, sameMask: sameMask, maskKey: maskKey,
    closure: closure, closureNaive: closureNaive, isClosed: isClosed,
    reactionsWithin: reactionsWithin, isSelfMaintaining: isSelfMaintaining,
    isMassMaintaining: isMassMaintaining, isMassMaintainingNaive: isMassMaintainingNaive,
    isInert: isInert, activity: activity, generate: generate,
    staticRecoverable: staticRecoverable, directlyProducible: directlyProducible,
    enumerateSubsets: enumerateSubsets, closureBFS: closureBFS,
    median: median, decide: decide, decideArm: decideArm,
  };
});
