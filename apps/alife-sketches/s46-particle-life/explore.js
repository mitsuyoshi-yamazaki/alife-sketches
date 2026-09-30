/**
 * S-46 の探索用の実行ページ（run `explore`）の、**DOM を持たない部分**。
 *
 * 出所: 2026-09-17 ユーザ要件（`docs/subprojects/alife-sketches/実装指示.md`「S-46 変更」）。
 * 器の設計は `work/2026-09-17-sketch-multiple-runs.md` §8（画面の実体の第1例）。
 *
 * この run が本編（`main`）と違うのは**粒子の個数が型ごとに違いうる**ことだけである。
 * 本編は「K種 × 各 N/K 個」の等分割で固定されているが、探索では
 * 「画面で囲った領域に、型0が3個・型1が5個だけ入っていた」という**不均等な組**を
 * そのまま取り出して種にする。ここにあるのはそのための数の操作であり、力学は一切持たない
 * （力学は `core.js` のまま。探索用に別の物理を作ってはいない）。
 *
 * ## 守る一線
 *
 * この run は **`origin: "screen"`**（台帳 `runs.json`）である。ここで見たものは判定に使わない——
 * 探索から仮説が出たなら、工場の実体の run を1本足して事前登録し直すことでしか主張にならない。
 *
 * 依存ゼロ。Node（selftest）とブラウザ（viewer-explore.html）が同じファイルを読む。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S46X = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** この実行ページの識別子と版。台帳 `runs.json` の `runs[].version` と一致していること。 */
  var RUN_ID = 'explore';
  var VERSION = '1.0.0';

  /** 「全体の粒子数」の選択肢。`'asis'` はインポートした個数をそのまま使う。**この設定は export されない**。 */
  var TOTAL_MODES = ['asis', 100, 500, 1000];

  /**
   * 実行速度の倍率（2026-09-18 ユーザ指示「実行速度を調整するスライダーを追加せよ」）。
   * **これは系の時間刻み `dt` ではない**——1フレームに何歩進めるかだけを変える。
   * 同じ歩数まで進めれば軌道は1ビットも変わらないので、**パターンを決めるパラメータではなく
   * 見る速さ**であり、export の対象にしない（「全体の粒子数」の設定と同じ扱い）。
   */
  var SPEEDS = [0.125, 0.25, 0.5, 1, 2, 4, 8];
  var SPEED_LABELS = ['×⅛', '×¼', '×½', '×1', '×2', '×4', '×8'];
  var DEFAULT_SPEED_INDEX = 3;
  var MAX_BASE_STEPS = 400;

  function sum(a) {
    var s = 0;
    for (var i = 0; i < a.length; i++) s += a[i];
    return s;
  }

  function indexOfMax(a) {
    var best = 0;
    for (var i = 1; i < a.length; i++) if (a[i] > a[best]) best = i;
    return best;
  }

  // ------------------------------------------------------------- 型ごとの個数

  /** 型ごとの個数から型の割当を作る。`length` を与えると、余りは末尾の型で埋める（`world.N` の外なので使われない）。 */
  function typesFromCounts(counts, length) {
    var total = sum(counts);
    var n = length == null ? total : Math.max(length, total);
    var out = new Int32Array(n);
    var at = 0;
    for (var t = 0; t < counts.length; t++) {
      for (var c = 0; c < counts[t]; c++) out[at++] = t;
    }
    for (; at < n; at++) out[at] = Math.max(0, counts.length - 1);
    return out;
  }

  /** N 個を K 型へ等分する（余りは先頭の型へ1個ずつ）。本編の `buildTypes` と同じ並びになる。 */
  function uniformCounts(N, K) {
    var base = Math.floor(N / K), rest = N - base * K, out = [];
    for (var t = 0; t < K; t++) out.push(base + (t < rest ? 1 : 0));
    return out;
  }

  /**
   * 比として解釈して合計を `total` に合わせる（最大剰余法）。
   * ユーザ指定「小数点の帳尻合わせはどのような方法でもよい」。
   */
  function scaleCounts(counts, total) {
    var cur = sum(counts);
    if (cur <= 0 || total <= 0) return counts.slice();
    var exact = counts.map(function (c) { return (c * total) / cur; });
    var out = exact.map(function (v) { return Math.floor(v); });
    var order = exact.map(function (v, i) { return { i: i, frac: v - Math.floor(v) }; })
      .sort(function (a, b) { return b.frac - a.frac; });
    var rest = total - sum(out);
    for (var k = 0; k < rest; k++) out[order[k % order.length].i] += 1;
    return out;
  }

  /**
   * 元は居た型が 0 個へ潰れるのを防ぐ。最大の型から1個ずつ回す（合計は変えない）。
   * 「選択された粒子は、それぞれの種別がいくつずつ入っていたか」を種にする以上、
   * **種にした型が消えている状態は意図と食い違う**ため。
   */
  function keepNonEmpty(counts, original) {
    var out = counts.slice();
    for (var i = 0; i < out.length; i++) {
      if (out[i] > 0 || original[i] <= 0) continue;
      var big = indexOfMax(out);
      if (out[big] <= 1) break;
      out[big] -= 1;
      out[i] += 1;
    }
    return out;
  }

  /**
   * 「全体の粒子数」の設定を当てる。`mode === 'asis'` ならインポートした個数そのまま、
   * 数値なら比として解釈して合計をその値に合わせる（ユーザ指定）。
   */
  function resolveCounts(counts, mode) {
    if (mode === 'asis' || mode == null) return counts.slice();
    var n = Number(mode);
    if (!isFinite(n) || n <= 0) return counts.slice();
    return keepNonEmpty(scaleCounts(counts, n), counts);
  }

  // ------------------------------------------------------------- 世界の作り替え

  /** 核の `buildTypes` は N が K で割り切れることを要求するので、作るときだけ切り上げる。 */
  function padTotal(total, K) {
    return K * Math.max(1, Math.ceil(Math.max(total, 1) / K));
  }

  /**
   * 型ごとの個数を持つ世界を、既に作られた世界から**新しいオブジェクトとして**作る。
   * 核（`stepWorld`・観測器）は粒子数を `world.N` からしか読まないので、
   * 配列は切り上げた長さのままで、`N` を実際の個数へ下げれば余りは触られない。
   */
  function withCounts(world, counts) {
    var total = sum(counts);
    var out = {};
    Object.keys(world).forEach(function (k) { out[k] = world[k]; });
    out.N = total;
    out.K = counts.length;
    out.types = typesFromCounts(counts, world.x.length);
    out.params = {};
    Object.keys(world.params).forEach(function (k) { out.params[k] = world.params[k]; });
    out.params.N = total;
    out.params.K = counts.length;
    return out;
  }

  /** 今の世界の型ごとの個数。 */
  function countsOfWorld(world) {
    var out = [];
    for (var t = 0; t < world.K; t++) out.push(0);
    for (var i = 0; i < world.N; i++) out[world.types[i]] += 1;
    return out;
  }

  // ------------------------------------------------------------- 矩形選択

  function normalizeRect(r) {
    return {
      x0: Math.min(r.x0, r.x1), y0: Math.min(r.y0, r.y1),
      x1: Math.max(r.x0, r.x1), y1: Math.max(r.y0, r.y1),
    };
  }

  /** 矩形（世界座標）の中に入っている粒子を数える。HUD はこれをドラッグ中に毎回呼ぶ。 */
  function countsInRect(world, rect) {
    var q = normalizeRect(rect), counts = [], indices = [];
    for (var t = 0; t < world.K; t++) counts.push(0);
    for (var i = 0; i < world.N; i++) {
      var x = world.x[i], y = world.y[i];
      if (x < q.x0 || x > q.x1 || y < q.y0 || y > q.y1) continue;
      indices.push(i);
      counts[world.types[i]] += 1;
    }
    return { counts: counts, indices: indices, rect: q, total: indices.length };
  }

  /** 1個以上入っていた型の番号。選ばれなかった型は「無いもの」として扱う（ユーザ指定）。 */
  function presentTypes(counts) {
    var out = [];
    for (var t = 0; t < counts.length; t++) if (counts[t] > 0) out.push(t);
    return out;
  }

  /** 選ばれた型だけの部分行列。行も列も `ids` の順に詰め直す（型番号は 0..ids.length-1 へ振り直る）。 */
  function submatrix(G, ids) {
    return ids.map(function (a) { return ids.map(function (b) { return G[a][b]; }); });
  }

  /**
   * 選択から、この run のパラメータ（＝`getParams` が返すのと同じ形）を作る。
   * **粒子同士の関係とともに、粒子の数が含まれる**のがこの形式の要点である（ユーザ指定）。
   */
  function selectionParams(world, rect) {
    var sel = countsInRect(world, rect);
    var ids = presentTypes(sel.counts);
    var p = world.params;
    return {
      K: ids.length,
      L: p.L,
      G: submatrix(world.G, ids),
      counts: ids.map(function (t) { return sel.counts[t]; }),
      wallStrength: p.wallStrength,
      wallMargin: p.wallMargin,
      excludeOverlap: !!p.excludeOverlap,
      particleRadius: p.particleRadius,
    };
  }

  /**
   * クリップボードへ写す／ファイルへ落とす中身。**ハーネスの封筒と同じ形**にしてあるので、
   * そのまま「⬆ 復元」で読み戻せる。`selection` は出所の控えで、復元には使わない。
   */
  function selectionEnvelope(world, rect, opts) {
    var o = opts || {};
    var sel = countsInRect(world, rect);
    var ids = presentTypes(sel.counts);
    return {
      sketch: o.sketch || 'S-46',
      run: RUN_ID,
      version: o.version || VERSION,
      savedAt: o.savedAt || new Date().toISOString(),
      params: selectionParams(world, rect),
      selection: {
        sourceTypes: ids,
        selectedCount: sel.total,
        rect: sel.rect,
        step: world.step,
      },
    };
  }

  // ------------------------------------------------------------- 実行速度

  /**
   * このフレームで進める歩数。**1未満の倍率は持ち越し（carry）で表す**——
   * 切り捨てるだけだと ×⅛ が「1歩も進まない」に落ちて止まって見えるため。
   */
  function planSteps(baseSteps, speed, carry) {
    var want = Math.max(0, baseSteps) * Math.max(0, speed) + (carry || 0);
    var steps = Math.floor(want);
    return { steps: steps, carry: want - steps };
  }

  /**
   * 「×1 のときの1フレームの歩数」を、1歩の実測時間から決める。
   * 歩の重さは粒子数・体積排除の有無で1桁変わるので、**固定値では機械と設定によって速さが化ける**。
   * 時間予算に収まる歩数へ寄せることで、×1 が「どの設定でも同じ体感」になる。
   */
  function baseStepsFor(msPerStep, budgetMs) {
    if (!(msPerStep > 0) || !(budgetMs > 0)) return 1;
    return Math.max(1, Math.min(MAX_BASE_STEPS, Math.floor(budgetMs / msPerStep)));
  }

  // ------------------------------------------------------------- 自動探索

  /** 行列の1マスだけを差し替えた**新しい行列**を返す。 */
  function replaceCell(G, a, b, value) {
    return G.map(function (row, i) {
      if (i !== a) return row.slice();
      return row.map(function (g, j) { return j === b ? value : g; });
    });
  }

  /**
   * 自動探索の1手: 行列の中の引力ひとつをランダムに引き直す（ユーザ指定）。
   * 変わった場所を返すので、呼び側はそのマスを光らせられる。
   */
  function mutateOneCell(G, rand, lo, hi) {
    var K = G.length;
    var a = Math.min(K - 1, Math.floor(rand() * K));
    var b = Math.min(K - 1, Math.floor(rand() * K));
    var value = lo + rand() * (hi - lo);
    return { G: replaceCell(G, a, b, value), a: a, b: b, from: G[a][b], to: value };
  }

  return {
    RUN_ID: RUN_ID, VERSION: VERSION, TOTAL_MODES: TOTAL_MODES,
    SPEEDS: SPEEDS, SPEED_LABELS: SPEED_LABELS, DEFAULT_SPEED_INDEX: DEFAULT_SPEED_INDEX,
    MAX_BASE_STEPS: MAX_BASE_STEPS, planSteps: planSteps, baseStepsFor: baseStepsFor,
    sum: sum, indexOfMax: indexOfMax,
    typesFromCounts: typesFromCounts, uniformCounts: uniformCounts,
    scaleCounts: scaleCounts, keepNonEmpty: keepNonEmpty, resolveCounts: resolveCounts,
    padTotal: padTotal, withCounts: withCounts, countsOfWorld: countsOfWorld,
    normalizeRect: normalizeRect, countsInRect: countsInRect,
    presentTypes: presentTypes, submatrix: submatrix,
    selectionParams: selectionParams, selectionEnvelope: selectionEnvelope,
    replaceCell: replaceCell, mutateOneCell: mutateOneCell,
  };
});
