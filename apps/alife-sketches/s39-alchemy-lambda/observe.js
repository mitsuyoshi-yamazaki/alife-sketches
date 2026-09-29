/**
 * S-39 観測器 — ここだけが「組織」を語る。
 *
 * 核（core.js）は項・簡約・容器しか知らない。level 0 / level 1 / level 2、
 * 自己維持、閉包、回復、介入という語彙はすべてこちら側にある。
 *
 * 秩序変数は 2 系統に分けてある（K-46・K-56）:
 *   在庫（静的） … 反応表の上で「各要素が他の要素から作られるか」
 *   到達（動的） … 容器を突いたときに実際に戻るか・新しい産物が出るか
 */
(function (global) {
  'use strict';

  var C = (typeof require === 'function') ? require('./core.js') : global.S39;

  // ------------------------------------------------------------- 母集団

  /**
   * 時刻 T の容器から「数える対象」を作る（K-30）。
   *   pop='type'  … 相異なる項（型）を 1 つと数える
   *   pop='token' … 容器の中の実体（個体）を重みに使う
   *   theta       … 材料に数える最小個数（K-45。同種 2 個が要る反応を許すか）
   *   topK        … 反応表に載せる種の上限。**外れた側は dropped に残す**（K-63）
   */
  function support(container, opt) {
    var counts = container.counts();
    var rows = [];
    counts.forEach(function (n, k) { if (n >= opt.theta) rows.push({ k: k, n: n }); });
    rows.sort(function (a, b) { return b.n - a.n || (a.k < b.k ? -1 : 1); });
    var kept = rows.slice(0, opt.topK);
    var dropped = rows.slice(opt.topK);
    return {
      keys: kept.map(function (x) { return x.k; }),
      counts: kept.map(function (x) { return x.n; }),
      total: rows.reduce(function (s, x) { return s + x.n; }, 0),
      nAll: rows.length,
      dropped: dropped.map(function (x) { return { k: x.k, n: x.n }; }),
    };
  }

  // ------------------------------------------------------------- 反応表

  /**
   * S × S の反応表。積は容器と同じ上限で作る。
   * 返すのは { prod[i][j] = 積の鍵 or null（上限で落ちた）, capHit }。
   */
  function reactionTable(container, keys, opt) {
    var n = keys.length;
    var prod = [];
    var capSteps = 0, capSize = 0;
    for (var i = 0; i < n; i++) {
      var row = [];
      for (var j = 0; j < n; j++) {
        var r = container.product(keys[i], keys[j]);
        if (r.hit) { row.push(null); if (r.hit === 'steps') capSteps++; else capSize++; }
        else row.push(r.k);
      }
      prod.push(row);
    }
    return { keys: keys, prod: prod, capSteps: capSteps, capSize: capSize, cells: n * n };
  }

  /** 積 p が引いた 2 項のどちらかと一致する反応（＝複写反応）か。 */
  function isCopy(tab, i, j, filter) {
    var p = tab.prod[i][j];
    if (p === null) return false;
    if (filter === 'arg') return p === tab.keys[j];
    if (filter === 'either') return p === tab.keys[i] || p === tab.keys[j];
    return false;
  }

  /**
   * 在庫（静的）。
   *   producedFrac       … S の要素のうち、S×S の何らかの積になっているものの割合
   *   producedFracNoCopy … 複写反応を除いて数えた同じ割合（原典の L1 の条件に対応）
   *   closedFrac         … 積が S に入る割合（原典は L1 に閉包を要求していない）
   *   selfCopy           … s s → s となる s の数
   */
  function inventory(tab, filter) {
    var n = tab.keys.length;
    var idx = {};
    for (var i = 0; i < n; i++) idx[tab.keys[i]] = i;
    var produced = new Array(n).fill(false);
    var producedNoCopy = new Array(n).fill(false);
    var inSet = 0, defined = 0, selfCopy = 0;
    for (var a = 0; a < n; a++) {
      for (var b = 0; b < n; b++) {
        var p = tab.prod[a][b];
        if (p === null) continue;
        defined++;
        if (idx[p] !== undefined) {
          inSet++;
          produced[idx[p]] = true;
          if (!isCopy(tab, a, b, filter === 'off' ? 'either' : filter)) producedNoCopy[idx[p]] = true;
        }
      }
      if (tab.prod[a][a] === tab.keys[a]) selfCopy++;
    }
    var pf = produced.filter(Boolean).length / Math.max(1, n);
    var pn = producedNoCopy.filter(Boolean).length / Math.max(1, n);
    return {
      n: n,
      producedFrac: pf,
      producedFracNoCopy: pn,
      closedFrac: defined ? inSet / defined : 0,
      definedFrac: tab.cells ? defined / tab.cells : 0,
      selfCopy: selfCopy,
      produced: produced,
      producedNoCopy: producedNoCopy,
      idx: idx,
    };
  }

  /**
   * 最大の自己維持部分集合（S-22 と同じ「反復除去」）。
   * 与えた添字集合から、集合の中の反応で作られない要素を無くなるまで落とす。
   */
  function maximalSelfMaintaining(tab, subsetIdx, filter) {
    var cur = subsetIdx.slice();
    for (;;) {
      var inCur = {};
      cur.forEach(function (i) { inCur[tab.keys[i]] = true; });
      var made = {};
      for (var a = 0; a < cur.length; a++) {
        for (var b = 0; b < cur.length; b++) {
          var p = tab.prod[cur[a]][cur[b]];
          if (p === null || !inCur[p]) continue;
          if (isCopy(tab, cur[a], cur[b], filter === 'off' ? 'either' : filter)) continue;
          made[p] = true;
        }
      }
      var next = cur.filter(function (i) { return made[tab.keys[i]]; });
      if (next.length === cur.length) return next;
      if (next.length === 0) return [];
      cur = next;
    }
  }

  /**
   * level 2 の判定（**本スケッチの再構成**。原典は分割の手続きを書いていない）。
   * 核 core の中から要素を 1 つ抜いた最大自己維持部分集合を集め、
   * 互いに素で各 2 要素以上のものが 2 つあれば「2 つの組織 ＋ 糊」とみなす。
   */
  function splitTwo(tab, core, filter) {
    if (core.length < 4) return null;
    var cands = [];
    for (var i = 0; i < core.length; i++) {
      var sub = core.filter(function (_, j) { return j !== i; });
      var m = maximalSelfMaintaining(tab, sub, filter);
      if (m.length >= 2 && m.length < core.length) {
        var sig = m.slice().sort(function (a, b) { return a - b; }).join(',');
        if (!cands.some(function (c) { return c.sig === sig; })) cands.push({ sig: sig, set: m });
      }
    }
    for (var a = 0; a < cands.length; a++) {
      for (var b = a + 1; b < cands.length; b++) {
        var A = cands[a].set, B = cands[b].set;
        if (A.some(function (x) { return B.indexOf(x) >= 0; })) continue;
        var glue = core.filter(function (x) { return A.indexOf(x) < 0 && B.indexOf(x) < 0; });
        return { a: A.length, b: B.length, glue: glue.length };
      }
    }
    return null;
  }

  // ------------------------------------------------------------- 到達（動的）

  /**
   * ノックアウト: S の各種を 1 つずつ消して T_rec 衝突走らせ、戻るかを見る。
   * 戻った割合（動的）と、静的に「残りから作られ得る」割合を並べて返す。
   */
  function knockouts(makeFresh, keys, opt, staticProduced) {
    var back = 0, tried = 0, rows = [];
    for (var i = 0; i < keys.length && i < opt.koMax; i++) {
      var c = makeFresh();
      var removed = c.removeKey(keys[i], opt.filler);
      if (removed === 0) continue;
      c.run(opt.trec);
      var cs = c.counts();
      var ok = (cs.get(keys[i]) || 0) >= 1;
      tried++;
      if (ok) back++;
      rows.push({ k: keys[i], removed: removed, back: ok ? 1 : 0, stat: staticProduced[i] ? 1 : 0 });
    }
    return { tried: tried, recoverFrac: tried ? back / tried : 0, rows: rows };
  }

  /** Jaccard 類似度（型の集合として）。 */
  function jaccard(a, b) {
    var sa = {}, inter = 0;
    a.forEach(function (x) { sa[x] = true; });
    var sb = {};
    b.forEach(function (x) { sb[x] = true; if (sa[x]) inter++; });
    var uni = Object.keys(sa).length + Object.keys(sb).length - inter;
    return uni ? inter / uni : 1;
  }

  /**
   * 原典の同定手続き: 乱択の項を注ぎ込み、走らせて、顔ぶれが戻るかを見る。
   * "repeatedly perturbing the system through the addition of random expressions"
   */
  function perturbReturn(makeFresh, before, opt) {
    var sims = [], recalls = [];
    for (var rep = 0; rep < opt.perturbReps; rep++) {
      var c = makeFresh();
      for (var i = 0; i < opt.perturbCount; i++) c.inject(opt.filler[(rep * 7 + i) % opt.filler.length], 1);
      c.run(opt.tperturb);
      var after = [];
      c.counts().forEach(function (n, k) { if (n >= opt.theta) after.push(k); });
      sims.push(jaccard(before, after));
      var keep = 0;
      before.forEach(function (k) { if (after.indexOf(k) >= 0) keep++; });
      recalls.push(before.length ? keep / before.length : 1);
    }
    sims.sort(function (a, b) { return a - b; });
    recalls.sort(function (a, b) { return a - b; });
    return { jaccard: sims[Math.floor(sims.length / 2)], recall: recalls[Math.floor(recalls.length / 2)] };
  }

  // ------------------------------------------------------------- 介入

  /**
   * 介入 I3: S に無い新しい項 z を注ぎ、**z の産物が容器に現れるか**を見る。
   * 観測だけでは区別できない腕を分けるために登録した（K-64）。
   */
  function novelInjection(makeFresh, z, opt) {
    var c = makeFresh();
    // 「注ぐ前に出ていた型」を知っているものとする。瞬間の顔ぶれだけでは
    // たまたま不在だった種が「新しい」に化けるので、先に burn 窓ぶん走らせて
    // そのあいだに一度でも現れた型を全部 known に入れる。
    var known = {};
    c.counts().forEach(function (n, k) { known[k] = true; });
    for (var w = 0; w < opt.burn; w++) {
      var e0 = c.step();
      if (e0 && e0.p) known[e0.p] = true;
      if (w % 50 === 0) c.counts().forEach(function (n, k) { known[k] = true; });
    }
    c.counts().forEach(function (n, k) { known[k] = true; });
    var zk = c.inject(z, opt.injectCount);
    known[zk] = true;
    // 窓のあいだに**一度でも入った**新しい型を数える（窓の終わりに残っているかは別に数える）
    var ever = {}, everN = 0;
    for (var t = 0; t < opt.tinject; t++) {
      var e = c.step();
      if (e && e.why === 'insert' && e.p && !known[e.p] && !ever[e.p]) { ever[e.p] = true; everN++; }
      if (e && (e.why === 'random' || e.why === 'deal' || e.why === 'drift') && e.p && !known[e.p] && !ever[e.p]) {
        ever[e.p] = true; everN++;
      }
    }
    var endN = 0, endMass = 0, total = 0;
    c.counts().forEach(function (n, k) {
      total += n;
      if (!known[k]) { endN++; endMass += n; }
    });
    return { novelEver: everN, novelSpecies: endN, novelShare: total ? endMass / total : 0 };
  }

  /**
   * 介入 I4: 反応表で「x を含む組でしか作られない種」を数え、x を窓のあいだ抑え込んで
   * それらが減るかを見る。x に依存する種が無ければ null（この腕では介入が定義されない）。
   */
  function blockout(makeFresh, tab, inv, opt) {
    var n = tab.keys.length;
    if (n < 2) return null;
    // 使われた回数が最多の種を x にする
    var use = new Array(n).fill(0);
    for (var a = 0; a < n; a++) {
      for (var b = 0; b < n; b++) {
        var p = tab.prod[a][b];
        if (p === null || inv.idx[p] === undefined) continue;
        use[a]++; use[b]++;
      }
    }
    var x = 0;
    for (var i = 1; i < n; i++) if (use[i] > use[x]) x = i;
    // x を含む組でしか作られない種
    var dep = [];
    for (var s = 0; s < n; s++) {
      if (s === x) continue;
      var routes = 0, viaX = 0;
      for (var c1 = 0; c1 < n; c1++) {
        for (var c2 = 0; c2 < n; c2++) {
          if (tab.prod[c1][c2] !== tab.keys[s]) continue;
          routes++;
          if (c1 === x || c2 === x) viaX++;
        }
      }
      if (routes > 0 && routes === viaX) dep.push(tab.keys[s]);
    }
    if (dep.length === 0) return null;
    var cBase = makeFresh();
    var before = shareOf(cBase.counts(), dep);
    var c = makeFresh();
    for (var t = 0; t < opt.tblock; t++) {
      c.step();
      if (t % opt.blockEvery === 0) c.removeKey(tab.keys[x], opt.filler);
    }
    var after = shareOf(c.counts(), dep);
    return { x: tab.keys[x], nDep: dep.length, before: before, after: after,
      drop: before > 0 ? (before - after) / before : 0 };
  }

  function shareOf(counts, keys) {
    var tot = 0, hit = 0;
    counts.forEach(function (n, k) { tot += n; if (keys.indexOf(k) >= 0) hit += n; });
    return tot ? hit / tot : 0;
  }

  // ------------------------------------------------------------- 判定規則

  /**
   * 事前登録した判定規則。criteria.json の thresholds を渡して使う。
   * D1〜D3 は観測だけ、D4・D5 は介入。level は原典の 3 段。
   */
  function verdict(m, th) {
    var d1 = m.nSpecies >= th.minSpecies && m.producedFracNoCopy >= th.produced;   // 在庫
    var d2 = m.recoverFrac >= th.recover;                                          // 到達（ノックアウト）
    var d3 = m.perturbRecall >= th.perturb;                                        // 原典の同定手続き
    var d4 = m.novelEver >= th.novelSpecies;                                       // 介入（新規の産物）
    var d5 = (m.blockDrop === null || m.blockDrop === undefined) ? null : (m.blockDrop >= th.blockDrop);
    var level = 'none';
    if (m.nSpecies === 1) level = 'L0';
    else if (d1 && d3) level = (m.splitA >= 2 && m.splitB >= 2) ? 'L2' : 'L1';
    return { D1: d1, D2: d2, D3: d3, D4: d4, D5: d5, level: level };
  }

  var api = {
    support: support, reactionTable: reactionTable, inventory: inventory,
    maximalSelfMaintaining: maximalSelfMaintaining, splitTwo: splitTwo,
    knockouts: knockouts, perturbReturn: perturbReturn, jaccard: jaccard,
    novelInjection: novelInjection, blockout: blockout, verdict: verdict, isCopy: isCopy,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.S39obs = api;
}(typeof window !== 'undefined' ? window : globalThis));
