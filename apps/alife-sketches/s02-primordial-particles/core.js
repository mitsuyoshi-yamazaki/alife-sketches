/**
 * S-02: 単純な運動則だけから構造が出るか（Primordial Particle System）
 *
 * 粒子は位置と向きだけを持ち、化学も結合も持たない。各ステップで半径 r 内の
 * 近傍を数え、左右の偏りに応じて向きを変え、前へ進む。それだけの規則である。
 *
 *   Δφ = α + β · N · sign(R − L)
 *
 *   N = 半径 r 内の近傍数 / L,R = そのうち進行方向の左側・右側にいる数
 *
 * 制御変数は**密度**にした。Schmickl らが使った密度（DPE）は原典が閲覧できず
 * 確認できなかったため、確認できない量をそのまま掃引の軸に据えている。
 *
 * 依存ゼロ。Node（生ログ生成）とブラウザ（可視化）が同じファイルを読む。
 *
 * 出典（アイデアと定数のみ。コードは参照していない）:
 *   Schmickl, Stefanec & Crailsheim (2016)
 *   "How a life-like system emerges from a simplistic particle motion law"
 *   Scientific Reports 6, 37969
 *   既定の組 <r=5, α=180°, β=17°, v=0.67>
 *
 * 語彙について: この核には「細胞」「膜」「生命」という語も概念も無い。
 * あるのは粒子・向き・近傍・連結成分だけで、構造の呼び名は観測器の側にある。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S02 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TAU = Math.PI * 2;

  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var DEFAULTS = {
    radius: 5,
    alpha: Math.PI,              // 180°
    beta: (17 * Math.PI) / 180,  // 17°
    speed: 0.67,
    size: 150,                   // 正方トーラスの一辺
    density: 0.08,               // 単位面積あたりの粒子数（制御変数）
  };

  /**
   * 世界を作る。粒子は一様乱数で撒き、向きも一様乱数。
   * @param {object} opts DEFAULTS を上書きする設定
   * @param {number} seed 乱数シード（固定すれば完全再現する）
   */
  function createWorld(opts, seed) {
    var p = {};
    Object.keys(DEFAULTS).forEach(function (k) { p[k] = DEFAULTS[k]; });
    Object.keys(opts || {}).forEach(function (k) { if (opts[k] != null) p[k] = opts[k]; });

    var n = Math.max(1, Math.round(p.density * p.size * p.size));
    var rng = makeRng(seed);
    var x = new Float64Array(n), y = new Float64Array(n), phi = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      x[i] = rng() * p.size;
      y[i] = rng() * p.size;
      phi[i] = rng() * TAU;
    }

    // 近傍探索用の一様格子。セル辺は radius なので、探索は 3x3 セルで足りる
    var cells = Math.max(1, Math.floor(p.size / p.radius));
    return {
      params: p, n: n, x: x, y: y, phi: phi, step: 0,
      neighbors: new Int32Array(n),
      grid: { cells: cells, cellSize: p.size / cells, head: new Int32Array(cells * cells), next: new Int32Array(n) },
    };
  }

  function rebuildGrid(w) {
    var g = w.grid;
    g.head.fill(-1);
    for (var i = 0; i < w.n; i++) {
      var cx = Math.floor(w.x[i] / g.cellSize) % g.cells;
      var cy = Math.floor(w.y[i] / g.cellSize) % g.cells;
      if (cx < 0) cx += g.cells;
      if (cy < 0) cy += g.cells;
      var c = cy * g.cells + cx;
      g.next[i] = g.head[c];
      g.head[c] = i;
    }
  }

  /** トーラス上の最短差分。 */
  function wrapDelta(d, size) {
    if (d > size * 0.5) return d - size;
    if (d < -size * 0.5) return d + size;
    return d;
  }

  /**
   * 近傍を走査して cb(j, dx, dy) を呼ぶ。self は含めない。
   * 3x3 セルだけ見れば半径 r 内は覆える（セル辺 >= r のため）。
   *
   * **注意**: 格子は rebuildGrid でしか更新されない。stepWorld は「格子を作る →
   * 向きを決める → 粒子を動かす」の順で進むので、**stepWorld から帰った直後の
   * 格子は古い**。外から呼ぶときは先に rebuildGrid すること
   * （2026-09-11、総当たりとの突き合わせ検査がこの取り違えを検出した）。
   *
   * @param {number} [radius] 既定は相互作用半径。観測側はより小さい半径を使う
   */
  function forEachNeighbor(w, i, cb, radius) {
    var g = w.grid, p = w.params;
    var rad = radius == null ? p.radius : radius;
    var r2 = rad * rad;
    var cx = Math.floor(w.x[i] / g.cellSize) % g.cells;
    var cy = Math.floor(w.y[i] / g.cellSize) % g.cells;
    if (cx < 0) cx += g.cells;
    if (cy < 0) cy += g.cells;
    for (var oy = -1; oy <= 1; oy++) {
      var ny = (cy + oy + g.cells) % g.cells;
      for (var ox = -1; ox <= 1; ox++) {
        var nx = (cx + ox + g.cells) % g.cells;
        for (var j = g.head[ny * g.cells + nx]; j !== -1; j = g.next[j]) {
          if (j === i) continue;
          var dx = wrapDelta(w.x[j] - w.x[i], p.size);
          var dy = wrapDelta(w.y[j] - w.y[i], p.size);
          if (dx * dx + dy * dy <= r2) cb(j, dx, dy);
        }
      }
    }
  }

  /**
   * 1 ステップ進める。
   * @param {boolean} noInteraction 近傍への依存を切る（負コントロール用。β=0 と同じ）
   */
  function stepWorld(w, noInteraction) {
    var p = w.params;
    rebuildGrid(w);

    var newPhi = new Float64Array(w.n);
    for (var i = 0; i < w.n; i++) {
      var left = 0, right = 0;
      var c = Math.cos(w.phi[i]), s = Math.sin(w.phi[i]);
      forEachNeighbor(w, i, function (j, dx, dy) {
        // 進行方向ベクトルとの外積の符号で左右を決める
        if (c * dy - s * dx > 0) left++; else right++;
      });
      var n = left + right;
      w.neighbors[i] = n;
      var delta = p.alpha;
      if (!noInteraction) delta += p.beta * n * (right > left ? 1 : (right < left ? -1 : 0));
      newPhi[i] = w.phi[i] + delta;
    }

    for (var k = 0; k < w.n; k++) {
      var ph = newPhi[k] % TAU;
      if (ph < 0) ph += TAU;
      w.phi[k] = ph;
      var nx2 = w.x[k] + Math.cos(ph) * p.speed;
      var ny2 = w.y[k] + Math.sin(ph) * p.speed;
      w.x[k] = ((nx2 % p.size) + p.size) % p.size;
      w.y[k] = ((ny2 % p.size) + p.size) % p.size;
    }
    w.step++;
  }

  // ------------------------------------------------------------- 観測器
  //
  // ここから先だけが「構造」を語る。核の側には無い語彙を使ってよい唯一の場所。

  /**
   * 半径 clusterRadius で繋がる連結成分を求める（union-find）。
   *
   * **相互作用半径をそのまま使ってはいけない**。密度 0.08・半径 5 では平均近傍数が
   * 約 6.3 あり、構造の有無にかかわらず系全体が連結する（＝パーコレーション相の中）。
   * それでは構造を測らず接続性の飽和を測ることになる。既定は 1.5 で、一様な場での
   * 平均近傍数を 1 未満に保ち、局所的な密集だけを拾う。
   * （2026-09-11、負コントロールが 0.996 を返したことでこの取り違えが露見した）
   */
  function clusters(w, clusterRadius) {
    var rad = clusterRadius == null ? 1.5 : clusterRadius;
    var parent = new Int32Array(w.n);
    for (var i = 0; i < w.n; i++) parent[i] = i;
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    function union(a, b) { var ra = find(a), rb = find(b); if (ra !== rb) parent[ra] = rb; }

    rebuildGrid(w);
    for (var k = 0; k < w.n; k++) {
      forEachNeighbor(w, k, function (j) { if (j > k) union(k, j); }, rad);
    }
    var sizes = Object.create(null);
    for (var m = 0; m < w.n; m++) {
      var rt = find(m);
      sizes[rt] = (sizes[rt] || 0) + 1;
    }
    var list = Object.keys(sizes).map(function (key) { return sizes[key]; });
    list.sort(function (a, b) { return b - a; });
    return { sizes: list, labelOf: function (i) { return find(i); } };
  }

  /**
   * 観測量をまとめて出す。
   *   clusterFraction  規模 minSize 以上の連結成分に属する粒子の割合
   *   largestFraction  最大の連結成分に属する粒子の割合
   *   neighborSpread   近傍数の標準偏差 / 平均（構造があると散らばる）
   */
  function measure(w, minSize, clusterRadius) {
    minSize = minSize || 10;
    var rad = clusterRadius == null ? 1.5 : clusterRadius;
    var cl = clusters(w, rad);
    var inBig = 0;
    for (var i = 0; i < cl.sizes.length; i++) if (cl.sizes[i] >= minSize) inBig += cl.sizes[i];

    var sum = 0, sum2 = 0;
    for (var k = 0; k < w.n; k++) { sum += w.neighbors[k]; sum2 += w.neighbors[k] * w.neighbors[k]; }
    var mean = sum / w.n;
    var varr = Math.max(0, sum2 / w.n - mean * mean);

    // 一様（ポアソン）な場での近傍数の変動係数は 1/sqrt(平均) になる。
    // 負コントロールの期待値がこれで、構造があるとここから上へ外れる。
    var nullSpread = mean > 0 ? 1 / Math.sqrt(mean) : 0;

    return {
      step: w.step,
      particles: w.n,
      clusterRadius: rad,
      clusterCount: cl.sizes.filter(function (s) { return s >= minSize; }).length,
      largestCluster: cl.sizes[0] || 0,
      clusterFraction: inBig / w.n,
      largestFraction: (cl.sizes[0] || 0) / w.n,
      meanNeighbors: mean,
      neighborSpread: mean > 0 ? Math.sqrt(varr) / mean : 0,
      nullSpread: nullSpread,
      spreadRatio: nullSpread > 0 ? (mean > 0 ? Math.sqrt(varr) / mean : 0) / nullSpread : 0,
    };
  }

  /** 1 レプリケートを steps ステップ回して、最後に観測する。 */
  function runReplicate(opts, seed, steps, noInteraction, onProgress) {
    var w = createWorld(opts, seed);
    for (var t = 0; t < steps; t++) {
      stepWorld(w, noInteraction);
      if (onProgress && t % 100 === 0) onProgress(w, t);
    }
    var m = measure(w);
    m.density = w.params.density;
    m.seed = seed;
    m.steps = steps;
    return m;
  }

  return {
    DEFAULTS: DEFAULTS,
    makeRng: makeRng,
    createWorld: createWorld,
    stepWorld: stepWorld,
    rebuildGrid: rebuildGrid,
    forEachNeighbor: forEachNeighbor,
    clusters: clusters,
    measure: measure,
    runReplicate: runReplicate,
  };
});
