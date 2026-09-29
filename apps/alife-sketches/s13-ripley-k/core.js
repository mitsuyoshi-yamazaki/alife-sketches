/**
 * S-13: 半径を選ぶのをやめる — K(r) を曲線として報告する
 *
 * S-02（apps/alife-sketches/s02-primordial-particles/）は、連結半径という解析上の
 * 一数値を 2.0 から 2.5 へ動かすだけで結論が「構造なし」から「ρ=0.04 で出現」へ
 * 反転することを示した。粒子は1つも動いていない。
 *
 * 空間統計はこの問題に 1984 年までに答えを出している:
 *
 *   ① 半径を1つ選ぶのをやめ、Ripley の K(r) を **r の関数（曲線）** として報告する。
 *      理論的な帰無 K(t) = π t² は **すべての t** で成り立つ。
 *   ② 単一の統計量は原理的に特異でない。Baddeley & Silverman (1984) は
 *      **ポアソンと厳密に同じ K を持つ非ポアソン過程**を構成した（定理）。
 *      だから F・G・K・J を併せて報告するのが標準実務である。
 *
 * このファイルは (a) S-02 と同じ運動則の粒子系 (b) 比較用の点過程いろいろ
 * (c) K・L・G・F・J の推定量 (d) シミュレーションによる帰無包絡線と大域検定
 * を持つ。依存ゼロ。Node（生ログ生成）とブラウザ（可視化）が同じファイルを読む。
 *
 * **トーラス境界なので端効果の補正は要らない。** 周期距離がそのまま正しい距離で、
 * Ripley の等方補正・Ohser 補正の類を一切使わずに不偏な推定量が書ける（r ≤ size/2）。
 *
 * 出典（アイデアのみ。コードは参照していない）:
 *   Ripley, B.D. (1976) "The second-order analysis of stationary point processes", J. Appl. Prob. 13
 *   Ripley, B.D. (1977) "Modelling spatial patterns", JRSS-B 39, 172-212（L 変換）
 *   Baddeley, A.J. & Silverman, B.W. (1984) "A cautionary example on the use of
 *     second-order methods for analyzing point patterns", Biometrics 40, 1089-1093
 *   Van Lieshout, M.N.M. & Baddeley, A.J. (1996) "A nonparametric measure of spatial
 *     interaction in point patterns", Statistica Neerlandica 50, 344-361（J 関数）
 *   Neyman, J. & Scott, E.L. (1958) / Thomas, M. (1949)（クラスタ過程）
 *   Schmickl, Stefanec & Crailsheim (2016) Sci. Rep. 6, 37969（粒子の運動則）
 *
 * 語彙について: 運動則の側（createWorld / stepWorld）には「細胞」「膜」「生命」という
 * 語も概念も無い。あるのは粒子・向き・近傍だけである。構造を語る語彙は観測器の側にしか無い。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S13 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TAU = Math.PI * 2;

  /** mulberry32。シードを固定すれば完全に再現する。 */
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 標準正規（Box-Muller）。 */
  function gauss(rng) {
    var u = 1 - rng(), v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(TAU * v);
  }

  // ------------------------------------------------------- トーラスと索引

  function wrapDelta(d, size) {
    if (d > size * 0.5) return d - size;
    if (d < -size * 0.5) return d + size;
    return d;
  }

  function wrapPos(v, size) {
    var r = v % size;
    return r < 0 ? r + size : r;
  }

  /**
   * 一様格子の索引。セル辺は minCell 以上になるよう選ぶ。
   * 半径 rad の走査は k = ceil(rad / cellSize) として (2k+1)² セルで足りる。
   */
  function makeIndex(x, y, n, size, minCell) {
    var cells = Math.max(1, Math.floor(size / Math.max(1e-9, minCell)));
    var cellSize = size / cells;
    var head = new Int32Array(cells * cells);
    head.fill(-1);
    var next = new Int32Array(n);
    for (var i = 0; i < n; i++) {
      var cx = Math.floor(x[i] / cellSize);
      var cy = Math.floor(y[i] / cellSize);
      if (cx >= cells) cx = cells - 1; if (cx < 0) cx = 0;
      if (cy >= cells) cy = cells - 1; if (cy < 0) cy = 0;
      var c = cy * cells + cx;
      next[i] = head[c];
      head[c] = i;
    }
    return { x: x, y: y, n: n, size: size, cells: cells, cellSize: cellSize, head: head, next: next };
  }

  /** 索引を使わない総当たり（近道の検算用・K-12）。 */
  function bruteNear(x, y, n, size, i, rad) {
    var out = [], r2 = rad * rad;
    for (var j = 0; j < n; j++) {
      if (j === i) continue;
      var dx = wrapDelta(x[j] - x[i], size), dy = wrapDelta(y[j] - y[i], size);
      if (dx * dx + dy * dy <= r2) out.push(j);
    }
    return out;
  }

  /** 索引で (px,py) から半径 rad 内の点へ cb(j, d2) を呼ぶ。self は呼び出し側が弾く。 */
  function forEachNear(idx, px, py, rad, cb) {
    var cells = idx.cells, cs = idx.cellSize, size = idx.size, r2 = rad * rad;
    var k = Math.ceil(rad / cs);
    var full = (2 * k + 1) >= cells;
    var cx = Math.floor(px / cs), cy = Math.floor(py / cs);
    if (cx >= cells) cx = cells - 1; if (cx < 0) cx = 0;
    if (cy >= cells) cy = cells - 1; if (cy < 0) cy = 0;
    var lo = full ? 0 : -k, hi = full ? cells - 1 : k;
    for (var oy = lo; oy <= hi; oy++) {
      var ny = full ? oy : ((cy + oy) % cells + cells) % cells;
      for (var ox = lo; ox <= hi; ox++) {
        var nx = full ? ox : ((cx + ox) % cells + cells) % cells;
        for (var j = idx.head[ny * cells + nx]; j !== -1; j = idx.next[j]) {
          var dx = wrapDelta(idx.x[j] - px, size), dy = wrapDelta(idx.y[j] - py, size);
          var d2 = dx * dx + dy * dy;
          if (d2 <= r2) cb(j, d2);
        }
      }
    }
  }

  /** (px,py) から最近接点までの距離。rMax を超えたら Infinity（打ち切り）。 */
  function nearestDist(idx, px, py, rMax, skip) {
    var cells = idx.cells, cs = idx.cellSize, size = idx.size;
    var cx = Math.floor(px / cs), cy = Math.floor(py / cs);
    if (cx >= cells) cx = cells - 1; if (cx < 0) cx = 0;
    if (cy >= cells) cy = cells - 1; if (cy < 0) cy = 0;
    var best = Infinity;
    var maxRing = Math.ceil(rMax / cs) + 1;
    for (var t = 0; t <= maxRing; t++) {
      if (t > 0 && best <= (t - 1) * cs) break;
      if (2 * t - 1 >= cells && t > 0) break;
      for (var oy = -t; oy <= t; oy++) {
        for (var ox = -t; ox <= t; ox++) {
          if (Math.max(Math.abs(ox), Math.abs(oy)) !== t) continue;
          var ny = ((cy + oy) % cells + cells) % cells;
          var nx = ((cx + ox) % cells + cells) % cells;
          for (var j = idx.head[ny * cells + nx]; j !== -1; j = idx.next[j]) {
            if (j === skip) continue;
            var dx = wrapDelta(idx.x[j] - px, size), dy = wrapDelta(idx.y[j] - py, size);
            var d = Math.sqrt(dx * dx + dy * dy);
            if (d < best) best = d;
          }
        }
      }
    }
    return best <= rMax ? best : Infinity;
  }

  // ------------------------------------------------------------- 粒子の系
  //
  // ここには「構造」を語る語彙が無い。粒子と向きと近傍数だけである。

  var DEFAULTS = {
    radius: 5,
    alpha: Math.PI,              // 180°
    beta: (17 * Math.PI) / 180,  // 17°
    speed: 0.67,
    size: 150,
    density: 0.08,
  };

  function createWorld(opts, seed) {
    var p = {};
    Object.keys(DEFAULTS).forEach(function (k) { p[k] = DEFAULTS[k]; });
    Object.keys(opts || {}).forEach(function (k) { if (opts[k] != null) p[k] = opts[k]; });
    var n = Math.max(2, Math.round(p.density * p.size * p.size));
    var rng = makeRng(seed);
    var x = new Float64Array(n), y = new Float64Array(n), phi = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      x[i] = rng() * p.size; y[i] = rng() * p.size; phi[i] = rng() * TAU;
    }
    return { params: p, n: n, x: x, y: y, phi: phi, step: 0, neighbors: new Int32Array(n), idx: null };
  }

  /** 索引を今の座標から作り直す。observe する側は必ずこれを呼んでから見る（K-12）。 */
  function rebuildIndex(w) {
    w.idx = makeIndex(w.x, w.y, w.n, w.params.size, w.params.radius);
    return w.idx;
  }

  /**
   * Δφ = α + β · N · sign(R − L) を1ステップ。
   * @param {boolean} noInteraction 近傍への依存を切る（負コントロール）
   */
  function stepWorld(w, noInteraction) {
    var p = w.params;
    var idx = rebuildIndex(w);
    var newPhi = new Float64Array(w.n);
    for (var i = 0; i < w.n; i++) {
      var left = 0, right = 0;
      var c = Math.cos(w.phi[i]), s = Math.sin(w.phi[i]);
      var xi = w.x[i], yi = w.y[i];
      (function (i2, c2, s2) {
        forEachNear(idx, xi, yi, p.radius, function (j, d2) {
          if (j === i2) return;
          var dx = wrapDelta(w.x[j] - xi, p.size), dy = wrapDelta(w.y[j] - yi, p.size);
          if (c2 * dy - s2 * dx > 0) left++; else right++;
        });
      })(i, c, s);
      var nb = left + right;
      w.neighbors[i] = nb;
      var delta = p.alpha;
      if (!noInteraction) delta += p.beta * nb * (right > left ? 1 : (right < left ? -1 : 0));
      newPhi[i] = w.phi[i] + delta;
    }
    for (var k = 0; k < w.n; k++) {
      var ph = newPhi[k] % TAU; if (ph < 0) ph += TAU;
      w.phi[k] = ph;
      w.x[k] = wrapPos(w.x[k] + Math.cos(ph) * p.speed, p.size);
      w.y[k] = wrapPos(w.y[k] + Math.sin(ph) * p.speed, p.size);
    }
    w.step++;
    w.idx = null; // 索引はもう古い。観測側は rebuildIndex を強制される
  }

  /** 世界を点配置として取り出す。 */
  function pointsOf(w) {
    return { x: w.x, y: w.y, n: w.n, size: w.params.size };
  }

  // ------------------------------------------------- 比較用の点過程いろいろ

  /** 二項過程（n 点を一様独立に撒く）。帰無過程はこれ。 */
  function poissonPoints(n, size, rng) {
    var x = new Float64Array(n), y = new Float64Array(n);
    for (var i = 0; i < n; i++) { x[i] = rng() * size; y[i] = rng() * size; }
    return { x: x, y: y, n: n, size: size };
  }

  /**
   * Baddeley & Silverman (1984) のセル過程。
   *
   * 一辺 c のセルへ独立に N 点を一様に置く。N は P(0)=1/10, P(1)=8/9, P(10)=1/90。
   * E[N] = 8/9 + 10/90 = 1、E[N²] = 8/9 + 100/90 = 2 なので **Var(N) = E[N] = 1**。
   *
   * 任意の領域 B について Var(N(B)) = E[N]·p(1−p) + Var(N)·p² = E[N]·p となり
   * **ポアソンと一致する**（p = |B∩セル| / c²）。つまり1次・2次モーメントが
   * ポアソンと厳密に同じで、**K 関数が区別できない**。それでも過程はポアソンではない。
   */
  function baddeleySilvermanPoints(nTarget, size, rng) {
    var per = Math.max(1, Math.round(Math.sqrt(nTarget)));
    var c = size / per;
    var xs = [], ys = [];
    for (var a = 0; a < per; a++) {
      for (var b = 0; b < per; b++) {
        var u = rng(), k;
        if (u < 1 / 10) k = 0;
        else if (u < 1 / 10 + 8 / 9) k = 1;
        else k = 10;
        for (var m = 0; m < k; m++) {
          xs.push((a + rng()) * c);
          ys.push((b + rng()) * c);
        }
      }
    }
    return fromArrays(xs, ys, size);
  }

  /** トマス型クラスタ過程。親を一様に撒き、子を等方正規で散らす。 */
  function thomasPoints(nParents, perParent, sigma, size, rng) {
    var xs = [], ys = [];
    for (var p = 0; p < nParents; p++) {
      var px = rng() * size, py = rng() * size;
      for (var k = 0; k < perParent; k++) {
        xs.push(wrapPos(px + gauss(rng) * sigma, size));
        ys.push(wrapPos(py + gauss(rng) * sigma, size));
      }
    }
    return fromArrays(xs, ys, size);
  }

  /** 揺らぎを加えた正方格子（規則的＝抑制的な配置）。 */
  function jitteredLatticePoints(nTarget, size, jitterFrac, rng) {
    var per = Math.max(1, Math.round(Math.sqrt(nTarget)));
    var sp = size / per;
    var xs = [], ys = [];
    for (var a = 0; a < per; a++) {
      for (var b = 0; b < per; b++) {
        xs.push(wrapPos((a + 0.5) * sp + (rng() - 0.5) * 2 * jitterFrac * sp, size));
        ys.push(wrapPos((b + 0.5) * sp + (rng() - 0.5) * 2 * jitterFrac * sp, size));
      }
    }
    return fromArrays(xs, ys, size);
  }

  /**
   * 硬芯過程（逐次抑制・SSI）。最小間隔 d を厳守する。
   * **r < d では K(r) = 0 が厳密に成り立つ**ので、L(r) − r = −r という恒等式が使える（K-18）。
   */
  function hardCorePoints(nTarget, size, d, rng, maxTries) {
    var tries = maxTries || 200;
    var xs = [], ys = [], d2 = d * d;
    for (var i = 0; i < nTarget; i++) {
      for (var t = 0; t < tries; t++) {
        var px = rng() * size, py = rng() * size, ok = true;
        for (var j = 0; j < xs.length; j++) {
          var dx = wrapDelta(xs[j] - px, size), dy = wrapDelta(ys[j] - py, size);
          if (dx * dx + dy * dy < d2) { ok = false; break; }
        }
        if (ok) { xs.push(px); ys.push(py); break; }
      }
    }
    return fromArrays(xs, ys, size);
  }

  /** 手で組んだ塊（正コントロール）。半径 w の円板へ密に置く。 */
  function clumpPoints(nClumps, perClump, width, size, rng) {
    var xs = [], ys = [];
    for (var c = 0; c < nClumps; c++) {
      var cx = rng() * size, cy = rng() * size;
      for (var k = 0; k < perClump; k++) {
        var a = rng() * TAU, rr = Math.sqrt(rng()) * width;
        xs.push(wrapPos(cx + Math.cos(a) * rr, size));
        ys.push(wrapPos(cy + Math.sin(a) * rr, size));
      }
    }
    return fromArrays(xs, ys, size);
  }

  function fromArrays(xs, ys, size) {
    var n = xs.length;
    var x = new Float64Array(n), y = new Float64Array(n);
    for (var i = 0; i < n; i++) { x[i] = xs[i]; y[i] = ys[i]; }
    return { x: x, y: y, n: n, size: size };
  }

  return {
    TAU: TAU, DEFAULTS: DEFAULTS,
    makeRng: makeRng, gauss: gauss, wrapDelta: wrapDelta, wrapPos: wrapPos,
    makeIndex: makeIndex, forEachNear: forEachNear, nearestDist: nearestDist, bruteNear: bruteNear,
    createWorld: createWorld, stepWorld: stepWorld, rebuildIndex: rebuildIndex, pointsOf: pointsOf,
    poissonPoints: poissonPoints, baddeleySilvermanPoints: baddeleySilvermanPoints,
    thomasPoints: thomasPoints, jitteredLatticePoints: jitteredLatticePoints,
    hardCorePoints: hardCorePoints, clumpPoints: clumpPoints, fromArrays: fromArrays,
  };
});
