/**
 * S-26 の観測器。**ここから先だけが「層」「対象」「持続」を語る。**
 * core.js の側にはマスと近傍と規則しか無い。
 *
 * ---- 3つの記述の層 ----
 *
 *   層0  対象 = マス1つ          同一性 = 座標             記述子 = そのマスの値
 *   層1  対象 = 連結成分          同一性 = 重なりで引き継ぐ  記述子 = 平行移動を除いて正規化した占有集合
 *   層2  対象 = 系全体            同一性 = 常に同じ1つ       記述子 = (成分の個数 n, 1 の総数 m)
 *
 * ---- 3層に当てる、同じ形の検出器 ----
 *
 *   **持続 = ①同一性の鎖が窓全体で切れない かつ ②記述子の列が周期 p ≤ P で厳密に周期的**
 *
 * 周期を見る関数 `minimalPeriod` は1つしか無く、3層とも同じものを呼ぶ。
 * 層が違うのは「何を対象と数えるか」と「何を記述子とするか」だけである。
 *
 * ---- 参照点（K-33: 同じ配置の、忘れ方だけ違う2通り） ----
 *
 *   shift     各フレームを無作為に平行移動する。形も個数も質量も保ち、**位置の履歴だけ**忘れる
 *   scramble  各フレームのマスを無作為に置換する。**質量だけ**保ち、形と位置を忘れる
 *
 * 別の帰無過程を作り直していない。元の走行のフレーム列を、忘れ方だけ変えて読む。
 *
 * 依存ゼロ。core.js と同じく Node とブラウザで共用する（古典スクリプト・UMD 風）。
 */
(function (root, factory) {
  var api = factory(typeof module === 'object' && module.exports ? require('./core.js') : root.S26);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S26L = api;
})(typeof self !== 'undefined' ? self : this, function (S26) {
  'use strict';

  /* ================================================================== *
   * 共通の検出器 — 記述子の列が周期 p <= Pmax で厳密に周期的か
   * ================================================================== */

  /**
   * seq の最小周期を返す（見つからなければ 0）。
   * 周期 p を認めるのは **窓が2周期を含むとき**（p <= floor(len/2)）に限る。
   * 3つの層がこの1つの関数を共有する。
   */
  function minimalPeriod(seq, Pmax) {
    var len = seq.length;
    if (len < 2) return 0;
    var cap = Math.min(Pmax, Math.floor(len / 2));
    for (var p = 1; p <= cap; p++) {
      var ok = true;
      for (var i = 0; i + p < len; i++) {
        if (seq[i] !== seq[i + p]) { ok = false; break; }
      }
      if (ok) return p;
    }
    return 0;
  }

  /* ================================================================== *
   * 層1 の対象を作る粗視化 — 連結成分
   * ================================================================== */

  /**
   * Chebyshev 距離 <= r で繋がるマスの連結成分。
   * トーラスを辿りながら**相対座標**を積むので、巻き込みを跨いだ成分も正しい形になる。
   * 一周してしまう成分（同じマスに違う相対座標で戻る）は wrapped=true にし、
   * 記述子に専用のキーを与える（**非周期として扱われる**）。
   *
   * 返り値: { list: [{cells:Int32Array, size, key, wrapped, cx, cy}], labels: Int32Array(-1 で空) }
   * size < sMin の成分は list にも labels にも入れない（K-30: 母集団の外延を1つの旋回で決める）。
   */
  function components(cells, L, r, sMin) {
    var n = L * L;
    var labels = new Int32Array(n).fill(-1);
    var seen = new Uint8Array(n);
    var list = [];
    // 近傍の相対座標（r 以内・自分を除く）
    var offs = [];
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        if (dx === 0 && dy === 0) continue;
        offs.push([dx, dy]);
      }
    }
    var stack = new Int32Array(n);
    var relX = new Int32Array(n), relY = new Int32Array(n);
    var min = sMin === undefined ? 1 : sMin;

    for (var s0 = 0; s0 < n; s0++) {
      if (!cells[s0] || seen[s0]) continue;
      var top = 0, members = [];
      stack[top++] = s0; seen[s0] = 1; relX[s0] = 0; relY[s0] = 0;
      var wrapped = false;
      var minRX = 0, minRY = 0, maxRX = 0, maxRY = 0;
      while (top > 0) {
        var idx = stack[--top];
        members.push(idx);
        var x = idx % L, y = (idx - x) / L;
        var rx = relX[idx], ry = relY[idx];
        for (var k = 0; k < offs.length; k++) {
          var nx = x + offs[k][0], ny = y + offs[k][1];
          var wx = ((nx % L) + L) % L, wy = ((ny % L) + L) % L;
          var j = wy * L + wx;
          if (!cells[j]) continue;
          var nrx = rx + offs[k][0], nry = ry + offs[k][1];
          if (seen[j]) {
            // 既に見たマスへ別の相対座標で戻ったら、成分がトーラスを一周している
            if (relX[j] !== nrx || relY[j] !== nry) wrapped = true;
            continue;
          }
          seen[j] = 1; relX[j] = nrx; relY[j] = nry;
          if (nrx < minRX) minRX = nrx; if (nrx > maxRX) maxRX = nrx;
          if (nry < minRY) minRY = nry; if (nry > maxRY) maxRY = nry;
          stack[top++] = j;
        }
      }
      if (members.length < min) continue;
      var id = list.length;
      var arr = new Int32Array(members.length);
      for (var m = 0; m < members.length; m++) { arr[m] = members[m]; labels[members[m]] = id; }
      var key;
      if (wrapped) {
        // 一周した成分は形を平行移動で正規化できない。サイズだけを持つ専用のキー。
        key = 'W' + members.length + ':' + id;
      } else {
        var pts = [];
        for (var q = 0; q < members.length; q++) {
          pts.push(((relX[members[q]] - minRX) << 12) | (relY[members[q]] - minRY));
        }
        pts.sort(function (a, b) { return a - b; });
        key = pts.join(',');
      }
      var cx = 0, cy = 0;
      for (var c = 0; c < members.length; c++) { cx += members[c] % L; cy += (members[c] - members[c] % L) / L; }
      list.push({
        cells: arr, size: members.length, key: key, wrapped: wrapped,
        cx: cx / members.length, cy: cy / members.length,
      });
    }
    return { list: list, labels: labels };
  }

  /** 素朴な連結成分（近道の検算用。全ペアの距離を見て推移閉包を取る）。 */
  function componentsNaive(cells, L, r, sMin) {
    var pts = [];
    for (var i = 0; i < cells.length; i++) if (cells[i]) pts.push(i);
    var N = pts.length;
    var par = new Int32Array(N);
    for (var a = 0; a < N; a++) par[a] = a;
    function find(u) { while (par[u] !== u) { par[u] = par[par[u]]; u = par[u]; } return u; }
    function uni(u, v) { u = find(u); v = find(v); if (u !== v) par[u] = v; }
    function torusD(p, q) {
      var px = p % L, py = (p - px) / L, qx = q % L, qy = (q - qx) / L;
      var dx = Math.abs(px - qx), dy = Math.abs(py - qy);
      return Math.max(Math.min(dx, L - dx), Math.min(dy, L - dy));
    }
    for (var u2 = 0; u2 < N; u2++) {
      for (var v2 = u2 + 1; v2 < N; v2++) if (torusD(pts[u2], pts[v2]) <= r) uni(u2, v2);
    }
    var groups = {};
    for (var w = 0; w < N; w++) {
      var g = find(w);
      if (!groups[g]) groups[g] = [];
      groups[g].push(pts[w]);
    }
    var out = [];
    for (var key in groups) {
      if (groups[key].length < (sMin === undefined ? 1 : sMin)) continue;
      out.push(groups[key].sort(function (p, q) { return p - q; }));
    }
    out.sort(function (p, q) { return p[0] - q[0]; });
    return out;
  }

  /* ================================================================== *
   * 層0 — マスを対象とする
   * ================================================================== */

  /**
   * frames: 窓の各時刻の配置（Uint8Array の配列。frames[0] が t0）。
   * 対象 = frames[0] で 1 のマス。記述子 = そのマスの値。鎖は決して切れない。
   */
  function level0(frames, L, P) {
    var f0 = frames[0], T = frames.length;
    var total = 0, persist = 0, periods = [], atCap = 0;
    var mark = new Uint8Array(f0.length);
    for (var i = 0; i < f0.length; i++) {
      if (!f0[i]) continue;
      total++;
      var seq = new Array(T);
      for (var t = 0; t < T; t++) seq[t] = frames[t][i];
      var p = minimalPeriod(seq, P);
      if (p > 0) { persist++; periods.push(p); mark[i] = 1; if (p === P) atCap++; }
    }
    return {
      level: 0, population: total, persisted: persist,
      // **母集団が空なら層は答えない**（K-30・S-19 の「観測器が答えないことがある」）。
      // 発火とも非発火とも数えない。criteria.json rev2 の decision.undefinedWhen。
      defined: total > 0,
      fraction: total ? persist / total : 0,
      periods: periods, atCap: atCap, mark: mark,
    };
  }

  /* ================================================================== *
   * 層1 — 連結成分を対象とする
   * ================================================================== */

  /**
   * comps: 窓の各時刻の components(...) の返り値の配列。
   * 対象 = comps[0].list（サイズ s_min 以上）。
   * 同一性 = 現在のセル集合と最も多く重なる次の成分へ引き継ぐ。
   *   ・重なり 0 なら鎖が切れる
   *   ・同じ次の成分を複数の対象が主張したら、重なりが最大の対象だけが引き継ぎ、他は切れる
   * 記述子 = 正規化した形のキー。
   */
  function level1(comps, L, P) {
    var T = comps.length;
    var objs = comps[0].list.map(function (c, i) {
      return { id: i, cur: c.cells, seq: [c.key], alive: true, brokeAt: -1, size0: c.size };
    });
    for (var t = 1; t < T; t++) {
      var labels = comps[t].labels, list = comps[t].list;
      // 各対象について、次のフレームのどの成分と最も重なるかを数える
      var claims = {};       // 成分 id -> [{obj, overlap}]
      for (var o = 0; o < objs.length; o++) {
        var ob = objs[o];
        if (!ob.alive) continue;
        var tally = {};
        for (var c = 0; c < ob.cur.length; c++) {
          var lb = labels[ob.cur[c]];
          if (lb >= 0) tally[lb] = (tally[lb] || 0) + 1;
        }
        var best = -1, bestN = 0;
        for (var k in tally) {
          var kn = tally[k] | 0;
          if (kn > bestN || (kn === bestN && best >= 0 && (k | 0) < best)) { best = k | 0; bestN = kn; }
        }
        if (best < 0) { ob.alive = false; ob.brokeAt = t; continue; }
        if (!claims[best]) claims[best] = [];
        claims[best].push({ obj: ob, overlap: bestN });
      }
      // 1つの成分を複数の対象が主張したら、重なり最大の1つだけが引き継ぐ（合体では同一性が保てない）
      for (var cid in claims) {
        var arr = claims[cid];
        var win = arr[0];
        for (var a = 1; a < arr.length; a++) {
          if (arr[a].overlap > win.overlap) win = arr[a];
        }
        for (var b = 0; b < arr.length; b++) {
          if (arr[b] === win) {
            var comp = list[cid | 0];
            win.obj.cur = comp.cells;
            win.obj.seq.push(comp.key);
          } else {
            arr[b].obj.alive = false;
            arr[b].obj.brokeAt = t;
          }
        }
      }
    }
    var total = objs.length, persist = 0, periods = [], atCap = 0, chainKept = 0;
    var persistedIds = {};
    for (var q = 0; q < objs.length; q++) {
      var ob2 = objs[q];
      if (!ob2.alive || ob2.seq.length !== T) continue;
      chainKept++;
      var p = minimalPeriod(ob2.seq, P);
      if (p > 0) {
        persist++; periods.push(p); persistedIds[ob2.id] = p;
        if (p === P) atCap++;
      }
    }
    return {
      level: 1, population: total, persisted: persist,
      defined: total > 0,
      fraction: total ? persist / total : 0,
      chainKept: chainKept, chainKeptFraction: total ? chainKept / total : 0,
      periods: periods, atCap: atCap, persistedIds: persistedIds, objects: objs,
    };
  }

  /* ================================================================== *
   * 層2 — 系全体を対象とする
   * ================================================================== */

  /**
   * 記述子 = (成分の個数 n, 1 の総数 m)。対象は1つだけなので、
   * 1レプリケートにつき真偽が1つ出る。**腕としての割合はシードにわたって数える**（K-30）。
   */
  function level2(frames, comps, L, P) {
    var T = frames.length, seq = new Array(T), ns = new Array(T), ms = new Array(T);
    var empty = false;
    for (var t = 0; t < T; t++) {
      var m = S26.countOnes(frames[t]);
      var n = comps[t].list.length;
      ns[t] = n; ms[t] = m;
      if (m === 0) empty = true;
      seq[t] = n + '/' + m;
    }
    var p = empty ? 0 : minimalPeriod(seq, P);
    return {
      level: 2, population: 1, persisted: p > 0 ? 1 : 0,
      // 層2の対象は系そのものなので母集団が空になることは無い。
      // 場が一度でも空になったら対象が消えたとみなし、持続しないと判定する（defined のまま）。
      defined: true, wasEmpty: empty,
      fraction: p > 0 ? 1 : 0, period: p, atCap: p === P ? 1 : 0,
      nSeries: ns, mSeries: ms, nMin: Math.min.apply(null, ns), nMax: Math.max.apply(null, ns),
      mMin: Math.min.apply(null, ms), mMax: Math.max.apply(null, ms),
    };
  }

  /* ================================================================== *
   * 参照点 — 同じフレーム列の「忘れ方だけ違う2通り」（K-33）
   * ================================================================== */

  /**
   * mode='none'     そのまま
   * mode='shift'    各フレームを無作為に平行移動する（形・個数・質量を保ち、位置の履歴を忘れる）
   * mode='scramble' 各フレームのマスを無作為に置換する（質量を保ち、形と位置を忘れる）
   */
  function forget(frames, L, mode, rng) {
    if (mode === 'none' || !mode) return frames;
    var out = new Array(frames.length);
    for (var t = 0; t < frames.length; t++) {
      if (mode === 'shift') {
        var dx = (rng() * L) | 0, dy = (rng() * L) | 0;
        out[t] = S26.translated(frames[t], L, dx, dy);
      } else if (mode === 'scramble') {
        var src = frames[t], n = src.length;
        var idx = new Int32Array(n);
        for (var i = 0; i < n; i++) idx[i] = i;
        for (var j = n - 1; j > 0; j--) {
          var k = (rng() * (j + 1)) | 0, tmp = idx[j]; idx[j] = idx[k]; idx[k] = tmp;
        }
        var dst = new Uint8Array(n), w = 0;
        for (var q = 0; q < n; q++) if (src[q]) dst[idx[w++]] = 1;
        out[t] = dst;
      } else {
        throw new Error('unknown forgetting: ' + mode);
      }
    }
    return out;
  }

  /* ================================================================== *
   * 3層をまとめて当てる（本番の観測器はこの1本だけを呼ぶ）
   * ================================================================== */

  /**
   * opts = { L, r, P, sMin }
   * comps を渡すと使い回す（同じ走行に別の P・T を当てるとき、成分の計算を繰り返さないため）。
   */
  function observeAll(frames, opts, compsCache) {
    var L = opts.L, r = opts.r, P = opts.P, sMin = opts.sMin;
    var comps = compsCache;
    if (!comps) {
      comps = new Array(frames.length);
      for (var t = 0; t < frames.length; t++) comps[t] = components(frames[t], L, r, sMin);
    }
    var l0 = level0(frames, L, P);
    var l1 = level1(comps, L, P);
    var l2 = level2(frames, comps, L, P);
    return { l0: l0, l1: l1, l2: l2, comps: comps };
  }

  /** 事前登録した判定規則（1レプリケート）。criteria.json の thresholds.theta を渡す。 */
  function decide(obs, theta) {
    return {
      // 母集団が空の層は「答えない」。発火とも非発火とも数えない。
      defined0: obs.l0.defined, defined1: obs.l1.defined, defined2: obs.l2.defined,
      level0: obs.l0.defined && obs.l0.fraction >= theta,
      level1: obs.l1.defined && obs.l1.fraction >= theta,
      level2: obs.l2.defined && obs.l2.fraction >= theta,
      f0: obs.l0.fraction, f1: obs.l1.fraction, f2: obs.l2.fraction,
      pop0: obs.l0.population, pop1: obs.l1.population,
    };
  }

  /** 腕（同じ設定のシード束）の判定。K-35: 判定の単位は腕。 */
  function decideArm(reps, theta) {
    function medOf(vals) {
      var v = vals.slice().sort(function (a, b) { return a - b; }), n = v.length;
      if (!n) return 0;
      return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
    }
    function rate(f, pool) { var p = pool || reps; return p.length ? p.filter(f).length / p.length : 0; }
    function spread(vals) {
      if (!vals.length) return 0;
      return Math.max.apply(null, vals) - Math.min.apply(null, vals);
    }
    // **定義された本だけで腕の値を作る。** 1本も定義されていなければ腕も未定義（K-30）。
    var d0 = reps.filter(function (r) { return r.defined0; });
    var d1 = reps.filter(function (r) { return r.defined1; });
    var d2 = reps.filter(function (r) { return r.defined2; });
    var v0 = d0.map(function (r) { return r.f0; });
    var v1 = d1.map(function (r) { return r.f1; });
    var m0 = medOf(v0), m1 = medOf(v1);
    // 層2は1本につき真偽1つなので、腕の値は「真になった本の割合」（母集団の外延が層で違う）
    var m2 = rate(function (r) { return r.level2; }, d2);
    return {
      n: reps.length, nDefined0: d0.length, nDefined1: d1.length, nDefined2: d2.length,
      defined0: d0.length > 0, defined1: d1.length > 0, defined2: d2.length > 0,
      f0: m0, f1: m1, f2: m2,
      level0: d0.length > 0 && m0 >= theta,
      level1: d1.length > 0 && m1 >= theta,
      level2: d2.length > 0 && m2 >= theta,
      perRep0: rate(function (r) { return r.level0; }, d0),
      perRep1: rate(function (r) { return r.level1; }, d1),
      perRep2: rate(function (r) { return r.level2; }, d2),
      pop0: medOf(reps.map(function (r) { return r.pop0 || 0; })),
      pop1: medOf(reps.map(function (r) { return r.pop1 || 0; })),
      spread0: spread(v0), spread1: spread(v1),
    };
  }

  return {
    minimalPeriod: minimalPeriod,
    components: components, componentsNaive: componentsNaive,
    level0: level0, level1: level1, level2: level2,
    forget: forget, observeAll: observeAll, decide: decide, decideArm: decideArm,
  };
});
