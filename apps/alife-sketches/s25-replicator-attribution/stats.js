/**
 * S-25 の観測器。**ここから先だけが「親」「複製子」「系統」「他者依存」を語る。**
 * core.js の側には、メモリ・プロセス・確保記録・命令語・独立（detach）と、
 * 独立1件ごとの**事実の袋**しか無い。
 *
 * ---- 帰属規則 ----
 *
 * 同じ袋を、違うチャネルから読む:
 *
 *   R1 実行者      writeBy      複写を**実行した**プロセス
 *   R2 命令の所在   writeCodeAt  実行された命令が**置かれていたセル**の持ち主
 *   R3 確保者      allocPid     **領域を確保した**プロセス
 *   R4 照合起点     matchAt      **テンプレート照合が当たったセル**の持ち主
 *   R5 写し元      writeSrcAt   **複写元のバイト**の持ち主
 *   R0 乱択（参照点） liveDraw    そのとき走っていたプロセスから一様に1つ
 *
 * **どれも同じ1本のトレースを読む。** 系は1度しか走っていない（状態ハッシュで示す）。
 *
 * ---- θ（K-45） ----
 *
 * 「最頻値」という定義は暗黙に「十分な票がある」ことを仮定するが、袋には1票しか
 * 入っていないチャネルもある（allocPid は必ず1票）。最頻の識別子がそのチャネルの
 * 総票数の θ 以上を占めるときだけ親として採り、満たさなければ **−1（不定）** を返す。
 *
 * ---- 識別子 0 ----
 *
 * 持ち主のいないセル（空きメモリ）を指すことがある。これは「不定」ではなく
 * **「無主」という確定した答え**なので 0 のまま返し、割合を記述子として別に出す。
 *
 * 依存ゼロ。core.js と同じく Node とブラウザで共用する（古典スクリプト・UMD 風）。
 */
(function (root, factory) {
  var api = factory(typeof module === 'object' && module.exports ? require('./core.js') : root.S25);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S25S = api;
})(typeof self !== 'undefined' ? self : this, function (S25) {
  'use strict';

  var UNDET = -1;

  /** 登録した5規則（R0 は参照点なので別）。順序は報告の順序でもある。 */
  var RULES = ['R1-executor', 'R2-codeSite', 'R3-allocator', 'R4-matchOrigin', 'R5-copySource'];
  var RULES_ALL = RULES.concat(['R0-random']);

  var LABEL = {
    'R1-executor': '実行者',
    'R2-codeSite': '命令の所在',
    'R3-allocator': '確保者',
    'R4-matchOrigin': '照合起点',
    'R5-copySource': '写し元',
    'R0-random': '乱択（参照点）'
  };

  /* ------------------------------------------------------------------ *
   * 1つの袋から親を決める
   * ------------------------------------------------------------------ */

  /**
   * 票の入った表から最頻の識別子を返す。占有率が theta 未満なら UNDET。
   * tieBreak: 'low'（識別子の小さい方・登録） / 'rand'（ノブ）
   */
  function plurality(hist, theta, tieBreak, rng) {
    var keys = Object.keys(hist);
    if (keys.length === 0) return UNDET;
    var total = 0, best = [], bestN = -1;
    for (var i = 0; i < keys.length; i++) {
      var n = hist[keys[i]];
      total += n;
      if (n > bestN) { bestN = n; best = [keys[i]]; }
      else if (n === bestN) best.push(keys[i]);
    }
    if (total <= 0) return UNDET;
    if (bestN / total < theta) return UNDET;
    if (best.length === 1) return +best[0];
    if (tieBreak === 'rand' && rng) return +best[(rng() * best.length) | 0];
    var lo = +best[0];
    for (var j = 1; j < best.length; j++) if (+best[j] < lo) lo = +best[j];
    return lo;
  }

  /** 規則 rule が事象 ev に対して返す識別子。 */
  function attributeOne(ev, rule, opts) {
    var theta = opts.theta, tb = opts.tieBreak, rng = opts.rng;
    switch (rule) {
      case 'R1-executor': return plurality(ev.writeBy, theta, tb, rng);
      case 'R2-codeSite': return plurality(ev.writeCodeAt, theta, tb, rng);
      case 'R3-allocator': return ev.allocPid === undefined ? UNDET : ev.allocPid;
      case 'R4-matchOrigin': return plurality(ev.matchAt, theta, tb, rng);
      case 'R5-copySource': return plurality(ev.writeSrcAt, theta, tb, rng);
      case 'R0-random': {
        var k = opts.drawIndex || 0;
        var d = ev.liveDraw || [];
        return d.length > k ? d[k] : (d.length ? d[0] : UNDET);
      }
      default: throw new Error('未知の帰属規則: ' + rule);
    }
  }

  /** 事象の並びに全規則を当てる。返り値 assign[rule] は識別子の配列。 */
  function attributeAll(events, opts) {
    var o = { theta: opts && opts.theta !== undefined ? opts.theta : 0.5,
              tieBreak: (opts && opts.tieBreak) || 'low',
              drawIndex: (opts && opts.drawIndex) || 0,
              rng: opts && opts.rng };
    var assign = {};
    RULES_ALL.forEach(function (r) {
      var a = new Int32Array(events.length);
      for (var i = 0; i < events.length; i++) a[i] = attributeOne(events[i], r, o);
      assign[r] = a;
    });
    return assign;
  }

  /* ------------------------------------------------------------------ *
   * 規則どうしの一致
   * ------------------------------------------------------------------ */

  /**
   * 2つの規則の一致率。**どちらも確定した答えを返した事象**だけを分母にする
   * （どちらも不定だったことを「一致」と数えると一致率が膨らむため）。
   */
  function agreementOf(a, b) {
    var n = 0, same = 0;
    for (var i = 0; i < a.length; i++) {
      if (a[i] === UNDET || b[i] === UNDET) continue;
      n++;
      if (a[i] === b[i]) same++;
    }
    return { n: n, same: same, rate: n > 0 ? same / n : 1 };
  }

  /** 5規則の全ペア（10組）の一致率。R0 は別に返す。 */
  function pairAgreements(assign) {
    var pairs = [], min = 1, minPair = null;
    for (var i = 0; i < RULES.length; i++) {
      for (var j = i + 1; j < RULES.length; j++) {
        var g = agreementOf(assign[RULES[i]], assign[RULES[j]]);
        pairs.push({ a: RULES[i], b: RULES[j], rate: g.rate, n: g.n, same: g.same,
                     identical: g.n > 0 && g.same === g.n });
        if (g.rate < min) { min = g.rate; minPair = RULES[i] + ' vs ' + RULES[j]; }
      }
    }
    var vsRandom = RULES.map(function (r) {
      var g = agreementOf(assign[r], assign['R0-random']);
      return { rule: r, rate: g.rate, n: g.n };
    });
    return { pairs: pairs, minPairAgreement: min, minPair: minPair, vsRandom: vsRandom };
  }

  /**
   * **実装の外から来る恒等式**（K-18）。乱択帰属と、任意の決定的な規則の一致率の期待値は
   * そのとき走っていたプロセス数の逆数の平均に等しい。
   */
  function expectedRandomAgreement(events) {
    var s = 0, n = 0;
    for (var i = 0; i < events.length; i++) {
      var c = events[i].liveCount;
      if (c > 0) { s += 1 / c; n++; }
    }
    return n > 0 ? s / n : 0;
  }

  /**
   * 同じ恒等式を、**規則 R の指す先がその時点で走っていた場合にだけ**当たりうることまで
   * 含めて書いたもの（rev2 で精密にした）。既に取り除かれた識別子を指した事象では、
   * 乱択は決してそれを引けないので当たる確率は 0 になる。
   */
  function expectedRandomAgreementFor(events, assigned) {
    var s = 0, n = 0;
    for (var i = 0; i < events.length; i++) {
      var pid = assigned[i];
      if (pid === UNDET) continue;
      var c = events[i].liveCount;
      if (c <= 0) continue;
      n++;
      var f = pid === 0 ? null : events[i].facts[String(pid)];
      if (f && f.len > 0) s += 1 / c;   // 走っていなければ乱択は引けない（確率 0）
    }
    return n > 0 ? s / n : 0;
  }

  /* ------------------------------------------------------------------ *
   * 他者依存（本題の秩序変数）
   * ------------------------------------------------------------------ */

  /**
   * 規則が親と呼んだ識別子のブロックが、メモリへ書き込む命令語を持たない事象の割合。
   * mode 'static' … ブロックの中に命令語があるか（構造）
   * mode 'dynamic' … これまでに書き込み命令を1度でも実行したか（機能）
   * **K-46 により両方を測り、両方を報告する。**
   * 「不定」は分母に含め、分子には含めない（登録どおり）。
   */
  function dependenceOf(events, assigned, mode) {
    var n = 0, dep = 0, undet = 0, unowned = 0;
    var key = mode === 'dynamic' ? 'ex' : 'w';
    for (var i = 0; i < events.length; i++) {
      n++;
      var pid = assigned[i];
      if (pid === UNDET) { undet++; continue; }
      if (pid === 0) { unowned++; dep++; continue; }   // 無主のセル: 複写機構を持たない
      var f = events[i].facts[String(pid)];
      if (!f || !f[key]) dep++;
    }
    return { n: n, dependence: n > 0 ? dep / n : 0, depCount: dep,
             undeterminedFraction: n > 0 ? undet / n : 0,
             unownedFraction: n > 0 ? unowned / n : 0 };
  }

  /* ------------------------------------------------------------------ *
   * 系統樹の形（記述子）
   * ------------------------------------------------------------------ */

  /**
   * 規則の帰属から森を作る。窓の中に独立の記録が無い識別子はその系統の根になる。
   * 循環（規則が作りうる）は打ち切って、その事象を根として扱う。
   */
  function lineageShape(events, assigned) {
    var parentOf = {};       // 事象で生まれた識別子 → その規則が呼ぶ親
    for (var i = 0; i < events.length; i++) parentOf[events[i].pid] = assigned[i];
    // 根も途中の節を全部覚える（覚えないと鎖の長さぶん毎回たどり直すことになる）。
    var rootCache = {};
    function rootOf(pid) {
      if (rootCache[pid] !== undefined) return rootCache[pid];
      var path = [], seen = {}, cur = pid, steps = 0;
      while (steps++ < 100000) {
        if (rootCache[cur] !== undefined) { cur = rootCache[cur]; break; }
        if (seen[cur]) break;                       // 循環
        seen[cur] = 1;
        var par = parentOf[cur];
        if (par === undefined || par === UNDET || par === cur) break;
        path.push(cur);
        cur = par;
      }
      for (var i = 0; i < path.length; i++) rootCache[path[i]] = cur;
      rootCache[pid] = cur;
      return cur;
    }
    // 深さは覚えておく。覚えないと事象数 × 鎖の長さ で二乗の手間になる。
    var depthCache = {};
    function depthOf(pid) {
      var path = [], cur = pid, seen = {}, base = 0, steps = 0;
      while (steps++ < 100000) {
        if (depthCache[cur] !== undefined) { base = depthCache[cur]; break; }
        if (seen[cur]) { base = 0; break; }          // 循環は打ち切る
        seen[cur] = 1;
        var p = parentOf[cur];
        if (p === undefined || p === UNDET || p === cur) { depthCache[cur] = 0; base = 0; break; }
        path.push(cur);
        cur = p;
      }
      for (var i = path.length - 1; i >= 0; i--) { base++; depthCache[path[i]] = base; }
      return depthCache[pid] !== undefined ? depthCache[pid] : base;
    }

    var roots = {}, depthSum = [], offspring = {};
    for (var j = 0; j < events.length; j++) {
      var pid = events[j].pid;
      var r = rootOf(pid);
      roots[r] = (roots[r] || 0) + 1;
      depthSum.push(depthOf(pid));
      var a = assigned[j];
      if (a !== UNDET) offspring[a] = (offspring[a] || 0) + 1;
    }
    depthSum.sort(function (x, y) { return x - y; });
    var rootKeys = Object.keys(roots);
    var top = 0;
    rootKeys.forEach(function (k) { if (roots[k] > top) top = roots[k]; });
    var counts = Object.keys(offspring).map(function (k) { return offspring[k]; })
      .sort(function (x, y) { return y - x; });
    var total = counts.reduce(function (s, v) { return s + v; }, 0);
    var take = Math.max(1, Math.ceil(counts.length * 0.1)), acc = 0;
    for (var t = 0; t < take; t++) acc += counts[t] || 0;
    return {
      lineageCount: rootKeys.length,
      topLineageShare: events.length > 0 ? top / events.length : 0,
      medianDepth: depthSum.length ? depthSum[depthSum.length >> 1] : 0,
      maxDepth: depthSum.length ? depthSum[depthSum.length - 1] : 0,
      distinctParents: counts.length,
      offspringTop10Share: total > 0 ? acc / total : 0
    };
  }

  /* ------------------------------------------------------------------ *
   * 負コントロールの作り役
   * ------------------------------------------------------------------ */

  /**
   * NC3: **チャネルごとの入れ替え**（K-33 の最も安い形）。
   * 事象の集まりはそのままに、チャネルごとに別の事象から袋を引いてくる。
   * 「規則どうしが同じ下部の過程を読んでいる」ことだけが壊れる。
   */
  function channelShuffle(events, rng) {
    var n = events.length;
    function perm() {
      var p = new Int32Array(n);
      for (var i = 0; i < n; i++) p[i] = i;
      for (var j = n - 1; j > 0; j--) { var r = (rng() * (j + 1)) | 0; var t = p[j]; p[j] = p[r]; p[r] = t; }
      return p;
    }
    var pA = perm(), pB = perm(), pC = perm(), pD = perm();
    var out = [];
    for (var k = 0; k < n; k++) {
      var e = events[k];
      var merged = {};
      // 事実表は、袋を引いてきた事象のものを全部併せて持たせる
      [e, events[pA[k]], events[pB[k]], events[pC[k]], events[pD[k]]].forEach(function (src) {
        Object.keys(src.facts).forEach(function (kk) { if (!merged[kk]) merged[kk] = src.facts[kk]; });
      });
      out.push({
        pid: e.pid, at: e.at, len: e.len, hash: e.hash, liveCount: e.liveCount,
        liveDraw: e.liveDraw, writes: e.writes,
        allocPid: events[pA[k]].allocPid,
        splitPid: events[pA[k]].splitPid,
        writeBy: events[pB[k]].writeBy,
        writeCodeAt: events[pC[k]].writeCodeAt,
        writeSrcAt: events[pD[k]].writeSrcAt,
        matchAt: events[pC[k]].matchAt,
        facts: merged
      });
    }
    return out;
  }

  /** NC4: 識別子を一様置換する。一致率と依存率は**厳密に不変**でなければならない。 */
  function relabelPids(events, rng) {
    var ids = {};
    events.forEach(function (e) {
      ids[e.pid] = 1; ids[e.allocPid] = 1; ids[e.splitPid] = 1;
      [e.writeBy, e.writeCodeAt, e.writeSrcAt, e.matchAt].forEach(function (h) {
        Object.keys(h).forEach(function (k) { ids[k] = 1; });
      });
      (e.liveDraw || []).forEach(function (k) { ids[k] = 1; });
      Object.keys(e.facts).forEach(function (k) { ids[k] = 1; });
    });
    var keys = Object.keys(ids).map(Number).filter(function (v) { return v !== 0; });
    var shuffled = keys.slice();
    for (var j = shuffled.length - 1; j > 0; j--) { var r = (rng() * (j + 1)) | 0; var t = shuffled[j]; shuffled[j] = shuffled[r]; shuffled[r] = t; }
    var map = { 0: 0 };
    for (var i = 0; i < keys.length; i++) map[keys[i]] = shuffled[i];
    function mh(h) { var o = {}; Object.keys(h).forEach(function (k) { o[map[+k]] = h[k]; }); return o; }
    return events.map(function (e) {
      var f = {};
      Object.keys(e.facts).forEach(function (k) { f[map[+k]] = e.facts[k]; });
      return {
        pid: map[e.pid], at: e.at, len: e.len, hash: e.hash, liveCount: e.liveCount,
        liveDraw: (e.liveDraw || []).map(function (k) { return map[k]; }),
        writes: e.writes,
        allocPid: map[e.allocPid], splitPid: map[e.splitPid],
        writeBy: mh(e.writeBy), writeCodeAt: mh(e.writeCodeAt),
        writeSrcAt: mh(e.writeSrcAt), matchAt: mh(e.matchAt), facts: f
      };
    });
  }

  /* ------------------------------------------------------------------ *
   * 事象の選び方（母集団・K-30）
   * ------------------------------------------------------------------ */

  /**
   * 母集団を切る。
   *   P1-events        窓の中で独立した事象すべて（登録した主の母集団）
   *   P2-liveAtEnd     終端で走っているプロセスに対応する事象だけ（個体を数える）
   *   P3-eventsStillLive  P1 かつ P2
   * window は [from, to] の命令数。
   */
  function selectEvents(events, win, population, livePids) {
    var out = [];
    for (var i = 0; i < events.length; i++) {
      var e = events[i];
      if (e.at < win[0] || e.at > win[1]) continue;
      if (population === 'P2-liveAtEnd' || population === 'P3-eventsStillLive') {
        if (!livePids[e.pid]) continue;
      }
      out.push(e);
    }
    return out;
  }

  /* ------------------------------------------------------------------ *
   * 1レプリケートの観測
   * ------------------------------------------------------------------ */

  /**
   * events に対して、全規則 × 登録した母集団で観測する。
   * opts = { window, theta, tieBreak, population, livePids, rng, drawIndex }
   */
  function observe(events, opts) {
    var sel = selectEvents(events, opts.window, opts.population || 'P1-events', opts.livePids || {});
    var assign = attributeAll(sel, opts);
    var agr = pairAgreements(assign);
    agr.vsRandom.forEach(function (v) {
      v.expected = expectedRandomAgreementFor(sel, assign[v.rule]);
    });
    var per = {};
    RULES_ALL.forEach(function (r) {
      var st = dependenceOf(sel, assign[r], 'static');
      var dy = dependenceOf(sel, assign[r], 'dynamic');
      var sh = lineageShape(sel, assign[r]);
      per[r] = {
        dependence: st.dependence, dependenceDynamic: dy.dependence,
        undeterminedFraction: st.undeterminedFraction, unownedFraction: st.unownedFraction,
        lineageCount: sh.lineageCount, topLineageShare: sh.topLineageShare,
        medianDepth: sh.medianDepth, maxDepth: sh.maxDepth,
        distinctParents: sh.distinctParents, offspringTop10Share: sh.offspringTop10Share
      };
    });
    return {
      events: sel.length,
      minPairAgreement: agr.minPairAgreement, minPair: agr.minPair,
      pairs: agr.pairs, vsRandom: agr.vsRandom,
      expectedRandomAgreement: expectedRandomAgreement(sel),
      perRule: per
    };
  }

  /* ------------------------------------------------------------------ *
   * 事前登録した判定（本番で使うのはこれだけ）
   * ------------------------------------------------------------------ */

  function median(xs) {
    var v = xs.slice().sort(function (a, b) { return a - b; });
    var n = v.length;
    if (!n) return 0;
    return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  }

  /**
   * **腕（同じ μ の複数シード）の判定。** K-35 により判定の単位はここ。
   * 1本ごとの値は生ログに全部残す（K-3）。畳むのは判定だけ。
   */
  function decideArm(obs, crit) {
    var flags = {}, depMed = {}, depDynMed = {}, fireRate = {};
    RULES_ALL.forEach(function (r) {
      var xs = obs.map(function (o) { return o.perRule[r].dependence; });
      var ys = obs.map(function (o) { return o.perRule[r].dependenceDynamic; });
      depMed[r] = median(xs);
      depDynMed[r] = median(ys);
      flags[r] = depMed[r] >= crit.dependenceThreshold;
      fireRate[r] = xs.filter(function (v) { return v >= crit.dependenceThreshold; }).length / xs.length;
    });
    var minAgr = median(obs.map(function (o) { return o.minPairAgreement; }));
    var fired = RULES.filter(function (r) { return flags[r]; });
    var notFired = RULES.filter(function (r) { return !flags[r]; });
    return {
      n: obs.length,
      minPairAgreement: minAgr,
      rulesMatter: minAgr < crit.agreementThreshold,
      dependence: depMed, dependenceDynamic: depDynMed,
      borrowingDetected: flags, perReplicateFireRate: fireRate,
      // **本題**: 同一のトレースから結論が割れたか
      conclusionSplit: fired.length > 0 && notFired.length > 0,
      firedRules: fired, notFiredRules: notFired
    };
  }

  /** 全事象で一致した規則の組（K-36: 「差が無い」ではなく「同一である」）。 */
  function identicalPairs(obs) {
    if (!obs.length) return [];
    var out = [];
    obs[0].pairs.forEach(function (p, i) {
      var all = obs.every(function (o) { return o.pairs[i].identical; });
      if (all) out.push({ a: p.a, b: p.b, events: obs.reduce(function (s, o) { return s + o.pairs[i].n; }, 0) });
    });
    return out;
  }

  return {
    UNDET: UNDET, RULES: RULES, RULES_ALL: RULES_ALL, LABEL: LABEL,
    plurality: plurality, attributeOne: attributeOne, attributeAll: attributeAll,
    agreementOf: agreementOf, pairAgreements: pairAgreements,
    expectedRandomAgreement: expectedRandomAgreement,
    expectedRandomAgreementFor: expectedRandomAgreementFor,
    dependenceOf: dependenceOf, lineageShape: lineageShape,
    channelShuffle: channelShuffle, relabelPids: relabelPids,
    selectEvents: selectEvents, observe: observe,
    decideArm: decideArm, identicalPairs: identicalPairs, median: median
  };
});
