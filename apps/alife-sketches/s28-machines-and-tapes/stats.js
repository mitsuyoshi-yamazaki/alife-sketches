/**
 * S-28 の観測器。**生物・組織の語彙はここにだけ置く**（核 core.js には無い）。
 *
 * 問い: 容器に残った列の集合は、**読みによって閉じている**か。
 * 判定は 4 項の連言（K-14/K-27）と、規模（K-6）の併記で行う。
 *
 * 母集団（K-30）がこの題材では**役割の次元**を持つ。読む側として使われた列だけを
 * 数えるのか、読まれた側も数えるのか——これは「同じ資源が両方の役をやる」系でしか
 * 立たない自由度で、どの指標の定義にも書かれていない。
 */
(function (global) {
  'use strict';

  var S28 = (typeof require === 'function' && typeof module !== 'undefined') ? require('./core.js') : global.S28;

  /** 現存する型（count >= theta）。theta は母集団のノブ。 */
  function presentTypes(st, theta) {
    var th = theta == null ? 1 : theta, out = [];
    for (var v = 0; v < st.size; v++) if (st.counts[v] >= th) out.push(v);
    return out;
  }

  /** 直近の衝突で、読み手として使われた型 / 読まれた型。 */
  function roleSets(st, window) {
    var seenM = {}, seenT = {}, r = st.recent;
    if (!r) return { machine: seenM, tape: seenT, n: 0 };
    var n = Math.min(r.n, window == null ? r.n : window);
    for (var k = 1; k <= n; k++) {
      var idx = (r.idx - k + r.cap * 2) % r.cap;
      seenM[r.m[idx]] = 1; seenT[r.t[idx]] = 1;
    }
    return { machine: seenM, tape: seenT, n: n };
  }

  /**
   * 集合 S の上で、規則が閉じているか・自分を作っているか・読みが効いているか。
   * selfPair: 'countGe2'（容器と同じ。同じ型どうしは 2 個以上あるときだけ組める）/ 'always'
   *           ——K-45 の θ。閉包の定義は種が無限にある前提だが、容器には 1 個しかない。
   */
  function potential(st, types, product, selfPair, counts, weighted) {
    var cnt = counts || st.counts;
    var k = types.length, inSet = {};
    for (var a = 0; a < k; a++) inSet[types[a]] = 1;
    var pairs = 0, inside = 0, tried = 0, produced = {}, machines = {}, tapes = {};
    var depSum = 0, depW = 0, mass = 0, selfMass = 0;
    for (a = 0; a < k; a++) mass += weighted ? cnt[types[a]] : 1;
    for (a = 0; a < k; a++) {
      var m = types[a], img = {}, nimg = 0, wm = weighted ? cnt[m] : 1;
      for (var b = 0; b < k; b++) {
        var t = types[b], wt = weighted ? cnt[t] : 1, wp = wm * wt;
        if (m === t) {
          if (selfPair === 'countGe2' && cnt[m] < 2) continue;
          if (weighted) wp = cnt[m] * (cnt[m] - 1);
        }
        tried += wp;
        var p = product(m, t);
        if (p < 0) continue;            // 反応しない組（frame 腕）は組に数えない
        pairs += wp;
        if (img[p] !== 1) { img[p] = 1; nimg++; }
        produced[p] = 1;
        if (inSet[p] === 1) { inside += wp; machines[m] = 1; tapes[t] = 1; }
      }
      if (nimg > 0) { depSum += wm * (k > 1 ? (nimg - 1) / (k - 1) : 0); depW += wm; }
    }
    // 二重性のもう一方の面: **読まれる列を固定したとき、誰が読むかで積が変わるか**（rev2）
    var mdepSum = 0, mdepW = 0;
    for (b = 0; b < k; b++) {
      var tt = types[b], mimg = {}, nm = 0, wt2 = weighted ? cnt[tt] : 1;
      for (a = 0; a < k; a++) {
        var mm = types[a];
        if (mm === tt && selfPair === 'countGe2' && cnt[mm] < 2) continue;
        var pp = product(mm, tt);
        if (pp < 0) continue;
        if (mimg[pp] !== 1) { mimg[pp] = 1; nm++; }
      }
      if (nm > 0) { mdepSum += wt2 * (k > 1 ? (nm - 1) / (k - 1) : 0); mdepW += wt2; }
    }
    var selfProduced = 0, both = 0;
    for (a = 0; a < k; a++) {
      var wv = weighted ? cnt[types[a]] : 1;
      if (produced[types[a]] === 1) { selfProduced += wv; selfMass += wv; }
      if (machines[types[a]] === 1 && tapes[types[a]] === 1) both += wv;
    }
    var closedFrac = pairs > 0 ? inside / pairs : 0;
    var selfProducedFrac = mass > 0 ? selfProduced / mass : 0;
    var readDependence = depW > 0 ? depSum / depW : 0;
    // 帰無値: 積が Ω 上の一様乱択だとしたときの理論値（K-10）
    var omega = st.size;
    var closedNull = k / omega;
    var producedNull = 1 - Math.pow(1 - 1 / omega, weighted ? Math.min(pairs, k * k) : pairs);
    return {
      k: k, pairs: pairs,
      closedFrac: closedFrac,
      selfProducedFrac: selfProducedFrac,
      readDependence: readDependence,
      machineDependence: mdepW > 0 ? mdepSum / mdepW : 0,
      bothRolesFrac: mass > 0 ? both / mass : 0,
      reactionDensity: tried > 0 ? pairs / tried : 0,
      closureExcess: closedNull > 0 ? closedFrac / closedNull : 0,
      productionExcess: producedNull > 0 ? selfProducedFrac / producedNull : 0,
      producedSize: Object.keys(produced).length,
    };
  }

  /** 直近 window 衝突のあいだに書き直された枠の割合（収支のチャネル・K-28）。 */
  function renewalFrac(st, window) {
    var lo = st.collisions - window, n = 0;
    for (var i = 0; i < st.N; i++) if (st.writtenAt[i] > lo) n++;
    return n / st.N;
  }

  /** 現存集合を、容器の型ごとの内訳とともに出す（K-6 の「規模」）。 */
  function composition(st, types) {
    var out = [];
    for (var a = 0; a < types.length; a++) {
      out.push({ s: types[a], n: st.counts[types[a]], fam: S28.familyOf(types[a], st.L) });
    }
    out.sort(function (x, y) { return y.n - x.n; });
    return out;
  }

  /** 事前登録した判定規則。**本番でもこれを使い、selftest でも正コントロールにこれを当てる**（K-15）。 */
  function decide(metrics, thr) {
    var closed = metrics.closedFrac >= thr.closedFrac;
    var selfp = metrics.selfProducedFrac >= thr.selfProducedFrac;
    var dep = metrics.readDependence >= thr.readDependence;
    var ren = metrics.renewalFrac >= thr.renewalFrac;
    var mdep = metrics.machineDependence >= thr.machineDependence;
    var exc = metrics.closureExcess >= thr.closureExcess;
    return {
      closed: closed, selfProduced: selfp, readDependent: dep, renewed: ren,
      machineDependent: mdep, nontrivial: exc,
      D1: closed && selfp && dep && ren,
      D2: metrics.k >= thr.minSize,
      D4: dep && mdep,
      D5: exc,
      MAIN: closed && selfp && dep && ren && mdep && exc,
    };
  }

  /** 集合 S の閉包（S から到達できる型を全部足したもの）。 */
  function closureOf(types, product, limit) {
    var have = {}, list = [];
    for (var a = 0; a < types.length; a++) if (have[types[a]] !== 1) { have[types[a]] = 1; list.push(types[a]); }
    var start = 0;
    while (start < list.length) {
      var n = list.length;
      for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) {
        if (i < start && j < start) continue;
        var p = product(list[i], list[j]);
        if (have[p] !== 1) { have[p] = 1; list.push(p); if (list.length > limit) return null; }
      }
      start = n;
    }
    list.sort(function (x, y) { return x - y; });
    return list;
  }

  /** |Ω| が小さいとき、大きさ maxK 以下の閉じた集合を総当たりで数える（解析的な参照点）。 */
  function enumerateClosedSets(omega, product, maxK) {
    var res = { 1: [], 2: [], 3: [] }, a, b, c;
    function closedUnder(set) {
      for (var x = 0; x < set.length; x++) for (var y = 0; y < set.length; y++) {
        var p = product(set[x], set[y]);
        if (set.indexOf(p) < 0) return false;
      }
      return true;
    }
    for (a = 0; a < omega; a++) if (closedUnder([a])) res[1].push([a]);
    if (maxK >= 2) for (a = 0; a < omega; a++) for (b = a + 1; b < omega; b++) if (closedUnder([a, b])) res[2].push([a, b]);
    if (maxK >= 3) for (a = 0; a < omega; a++) for (b = a + 1; b < omega; b++) for (c = b + 1; c < omega; c++) if (closedUnder([a, b, c])) res[3].push([a, b, c]);
    return res;
  }

  var api = {
    presentTypes: presentTypes, roleSets: roleSets, potential: potential,
    renewalFrac: renewalFrac, composition: composition, decide: decide,
    closureOf: closureOf, enumerateClosedSets: enumerateClosedSets,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.S28Stats = api;
})(typeof window !== 'undefined' ? window : this);
