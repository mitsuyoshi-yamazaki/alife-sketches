/**
 * S-11: 近傍の「形」を変えると結論は動くか
 *
 * 系: トーラス上の走行・転回粒子。引力も結合も無い。各粒子は半径 R 内の粒子数 n_i に
 *     応じて速さだけが落ちる:
 *
 *       v_i = v0 * exp(-lambda * n_i / n0),   n0 = rho * pi * R^2
 *
 *     混雑した所で遅くなれば、そこに滞在する時間が延び、さらに混む。平均場では
 *     d ln v / d ln rho < -1、すなわち lambda > 1 で自己集積が起きる。
 *
 * ノブ: **観測器が使う近傍グラフの形**。力学は一切変えない。同じ配置に対して、
 *     期待次数を揃えた上で形だけを差し替える（MAUP の aggregation problem）。
 *
 * 依存ゼロ。Node（生ログ生成）とブラウザ（可視化）が同じファイルを読む。
 *
 * 出典（アイデアのみ。コードは参照していない）:
 *   Cates, M. E. & Tailleur, J. (2015) "Motility-Induced Phase Separation",
 *     Annu. Rev. Condens. Matter Phys. 6, 219-244
 *   Tailleur, J. & Cates, M. E. (2008) PRL 100, 218103
 *   Openshaw, S. (1983) "The Modifiable Areal Unit Problem", CATMOG 38
 *   Gabriel, K. R. & Sokal, R. R. (1969) Syst. Zool. 18, 259-278
 *
 * 語彙について: この核には「細胞」「膜」「遺伝子」「個体」「触媒」「適応度」「生きている」
 * という語も概念も無い。あるのは粒子・向き・速さ・近傍・グラフ・次数・辺だけである。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S11 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TAU = Math.PI * 2;

  // ------------------------------------------------------------ 乱数・幾何

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

  /** 標準正規を2つ返す（Box-Muller）。 */
  function gauss2(rng) {
    var u = 1 - rng(), v = rng();
    var m = Math.sqrt(-2 * Math.log(u));
    return [m * Math.cos(TAU * v), m * Math.sin(TAU * v)];
  }

  function wrapPos(v, L) { v = v % L; return v < 0 ? v + L : v; }
  function wrapDelta(d, L) { return d - L * Math.round(d / L); }

  // ------------------------------------------------------------ 空間索引
  // 名前について: 格子の区画は bin と呼ぶ（"cell" は上位概念の語彙に触れるため使わない）。

  function makeIndex(x, y, n, size, binSize) {
    var nb = Math.max(1, Math.floor(size / binSize));
    var bs = size / nb;
    var head = new Int32Array(nb * nb);
    for (var b = 0; b < head.length; b++) head[b] = -1;
    var next = new Int32Array(n);
    for (var i = 0; i < n; i++) {
      var bx = Math.floor(x[i] / bs); if (bx >= nb) bx = nb - 1; if (bx < 0) bx = 0;
      var by = Math.floor(y[i] / bs); if (by >= nb) by = nb - 1; if (by < 0) by = 0;
      var c = by * nb + bx;
      next[i] = head[c]; head[c] = i;
    }
    return { nb: nb, bs: bs, head: head, next: next, size: size, x: x, y: y };
  }

  /**
   * 中心 (xc,yc) から半径 R の箱に入る点を走査する。トーラス。
   * fn(j, dx, dy) が呼ばれる。dx,dy は周期的な差分。R が広すぎて区画が重なる場合は
   * 全区画を1度ずつ見る（二重計上しない）。
   */
  function eachNear(idx, xc, yc, R, fn) {
    var nb = idx.nb, bs = idx.bs, size = idx.size, x = idx.x, y = idx.y;
    var lay = Math.ceil(R / bs);
    var span = Math.min(2 * lay + 1, nb);
    var cx = Math.floor(xc / bs); if (cx >= nb) cx = nb - 1; if (cx < 0) cx = 0;
    var cy = Math.floor(yc / bs); if (cy >= nb) cy = nb - 1; if (cy < 0) cy = 0;
    for (var a = 0; a < span; a++) {
      var gx = (((cx - lay + a) % nb) + nb) % nb;
      for (var b = 0; b < span; b++) {
        var gy = (((cy - lay + b) % nb) + nb) % nb;
        for (var j = idx.head[gy * nb + gx]; j !== -1; j = idx.next[j]) {
          fn(j, wrapDelta(x[j] - xc, size), wrapDelta(y[j] - yc, size));
        }
      }
    }
  }

  // ------------------------------------------------------------ 系

  var DEFAULTS = {
    size: 60,
    density: 1 / 3,
    interactionRadius: 2.4,
    speed0: 0.35,
    tumbleProb: 0.02,
    lambda: 0,
  };

  function createWorld(opts, seed) {
    var p = {};
    Object.keys(DEFAULTS).forEach(function (k) { p[k] = DEFAULTS[k]; });
    if (opts) Object.keys(opts).forEach(function (k) { if (opts[k] !== undefined) p[k] = opts[k]; });
    var n = Math.max(1, Math.round(p.density * p.size * p.size));
    var rng = makeRng(seed);
    var w = {
      params: p, n: n, seed: seed, steps: 0,
      x: new Float64Array(n), y: new Float64Array(n), phi: new Float64Array(n),
      speed: new Float64Array(n), count: new Int32Array(n), rng: rng,
    };
    for (var i = 0; i < n; i++) {
      w.x[i] = rng() * p.size;
      w.y[i] = rng() * p.size;
      w.phi[i] = rng() * TAU;
      w.speed[i] = p.speed0;
    }
    return w;
  }

  /** 半径 R 内の粒子数を全粒子について数える。hot path なので手で展開してある。 */
  function countNeighbours(x, y, n, size, R, out) {
    var idx = makeIndex(x, y, n, size, R);
    var nb = idx.nb, bs = idx.bs, head = idx.head, next = idx.next, R2 = R * R;
    var lay = Math.ceil(R / bs);
    var span = Math.min(2 * lay + 1, nb);
    for (var i = 0; i < n; i++) {
      var xi = x[i], yi = y[i], c = 0;
      var cx = Math.floor(xi / bs); if (cx >= nb) cx = nb - 1; if (cx < 0) cx = 0;
      var cy = Math.floor(yi / bs); if (cy >= nb) cy = nb - 1; if (cy < 0) cy = 0;
      for (var a = 0; a < span; a++) {
        var gx = (((cx - lay + a) % nb) + nb) % nb;
        for (var b = 0; b < span; b++) {
          var gy = (((cy - lay + b) % nb) + nb) % nb;
          for (var j = head[gy * nb + gx]; j !== -1; j = next[j]) {
            if (j === i) continue;
            var dx = x[j] - xi; dx -= size * Math.round(dx / size);
            var dy = y[j] - yi; dy -= size * Math.round(dy / size);
            if (dx * dx + dy * dy <= R2) c++;
          }
        }
      }
      out[i] = c;
    }
    return idx;
  }

  /**
   * 1ステップ。
   * 手順: 近傍数を数える → 速さを決める → 転回判定 → 前へ進む。
   * K-12 対策: 進んだ後の索引は必ず捨てる（観測器は自分で作り直す）。
   */
  function stepWorld(w) {
    var p = w.params, n = w.n, size = p.size;
    var n0 = p.density * Math.PI * p.interactionRadius * p.interactionRadius;
    countNeighbours(w.x, w.y, n, size, p.interactionRadius, w.count);
    for (var i = 0; i < n; i++) {
      var v = p.speed0 * Math.exp(-p.lambda * w.count[i] / n0);
      w.speed[i] = v;
      if (w.rng() < p.tumbleProb) w.phi[i] = w.rng() * TAU;
      w.x[i] = wrapPos(w.x[i] + v * Math.cos(w.phi[i]), size);
      w.y[i] = wrapPos(w.y[i] + v * Math.sin(w.phi[i]), size);
    }
    w.steps++;
  }

  function runReplicate(opts, seed, steps, onProgress) {
    var w = createWorld(opts, seed);
    for (var t = 0; t < steps; t++) {
      stepWorld(w);
      if (onProgress && (t + 1) % 100 === 0) onProgress(w, t + 1);
    }
    return w;
  }

  // ------------------------------------------------------------ 配置の生成器（力学を走らせないもの）

  /** 一様ランダム配置（ポアソン点過程）。帰無過程そのもの。 */
  function poissonPoints(n, size, seed) {
    var rng = makeRng(seed);
    var x = new Float64Array(n), y = new Float64Array(n);
    for (var i = 0; i < n; i++) { x[i] = rng() * size; y[i] = rng() * size; }
    return { x: x, y: y, n: n, size: size };
  }

  /** 三角格子＋揺らぎ。空間構造は強いが集積ではない（負コントロール）。 */
  function latticePoints(cols, rows, size, jitter, seed) {
    var rng = makeRng(seed);
    var n = cols * rows;
    var x = new Float64Array(n), y = new Float64Array(n);
    var dx = size / cols, dy = size / rows, k = 0;
    for (var r = 0; r < rows; r++) {
      for (var c = 0; c < cols; c++) {
        var ox = (r % 2) * dx * 0.5;
        x[k] = wrapPos(c * dx + ox + (rng() - 0.5) * jitter * dx, size);
        y[k] = wrapPos(r * dy + (rng() - 0.5) * jitter * dy, size);
        k++;
      }
    }
    return { x: x, y: y, n: n, size: size };
  }

  /** Thomas 型クラスタ過程。親をポアソンで撒き、子をガウスで散らす（正コントロール）。 */
  function clusteredPoints(n, size, parents, sigma, seed) {
    var rng = makeRng(seed);
    var px = [], py = [];
    for (var q = 0; q < parents; q++) { px.push(rng() * size); py.push(rng() * size); }
    var x = new Float64Array(n), y = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var p = (i % parents);
      var g = gauss2(rng);
      x[i] = wrapPos(px[p] + g[0] * sigma, size);
      y[i] = wrapPos(py[p] + g[1] * sigma, size);
    }
    return { x: x, y: y, n: n, size: size };
  }


  /** 二量体過程。親をポアソンで撒き、各親に距離 sep の対を置く（短距離の構造だけを持つ）。 */
  function pairedPoints(n, size, sep, seed) {
    var rng = makeRng(seed);
    var x = new Float64Array(n), y = new Float64Array(n);
    for (var i = 0; i < n; i += 2) {
      var px = rng() * size, py = rng() * size, a = rng() * TAU;
      x[i] = wrapPos(px, size); y[i] = wrapPos(py, size);
      if (i + 1 < n) {
        x[i + 1] = wrapPos(px + sep * Math.cos(a), size);
        y[i + 1] = wrapPos(py + sep * Math.sin(a), size);
      }
    }
    return { x: x, y: y, n: n, size: size };
  }

  /** 世界を点集合として取り出す（観測器は点集合しか見ない）。 */
  function pointsOf(w) { return { x: w.x, y: w.y, n: w.n, size: w.params.size }; }

  // ------------------------------------------------------------ 近傍の「形」

  /**
   * 面積を円と等しく揃えた領域の定義。
   *   disc     : dx^2+dy^2 <= r^2                 面積 pi r^2
   *   square   : max(|dx|,|dy|) <= a              面積 (2a)^2      → a = r*sqrt(pi)/2
   *   diamond  : |dx|+|dy| <= b                   面積 2 b^2       → b = r*sqrt(pi/2)
   *   stripe   : |dx|<=a かつ |dy|<=b, a=4b       面積 4ab         → b = r*sqrt(pi)/4, a = 4b
   */
  function makeRegion(type, r) {
    var sp = Math.sqrt(Math.PI);
    if (type === 'disc') return { type: type, r: r, reach: r, area: Math.PI * r * r };
    if (type === 'square') { var a = r * sp / 2; return { type: type, a: a, reach: a * Math.SQRT2, area: 4 * a * a }; }
    if (type === 'diamond') { var b = r * Math.sqrt(Math.PI / 2); return { type: type, b: b, reach: b, area: 2 * b * b }; }
    if (type === 'stripe') { var hb = r * sp / 4, ha = 4 * hb; return { type: type, a: ha, b: hb, reach: Math.sqrt(ha * ha + hb * hb), area: 4 * ha * hb }; }
    throw new Error('unknown region type: ' + type);
  }

  function inRegion(reg, dx, dy) {
    if (reg.type === 'disc') return dx * dx + dy * dy <= reg.r * reg.r;
    if (reg.type === 'square') return Math.abs(dx) <= reg.a && Math.abs(dy) <= reg.a;
    if (reg.type === 'diamond') return Math.abs(dx) + Math.abs(dy) <= reg.b;
    return Math.abs(dx) <= reg.a && Math.abs(dy) <= reg.b;
  }

  function emptyGraph(n) { return { n: n, ea: [], eb: [], el: [] }; }

  function addEdge(g, i, j, dx, dy) {
    g.ea.push(i); g.eb.push(j); g.el.push(Math.sqrt(dx * dx + dy * dy));
  }

  /** 領域型の近傍グラフ（disc / square / diamond / stripe）。 */
  function buildRegionGraph(pts, reg) {
    var n = pts.n, size = pts.size;
    var idx = makeIndex(pts.x, pts.y, n, size, Math.max(reg.reach, size / 128));
    var g = emptyGraph(n);
    for (var i = 0; i < n; i++) {
      (function (i) {
        eachNear(idx, pts.x[i], pts.y[i], reg.reach, function (j, dx, dy) {
          if (j <= i) return;
          if (inRegion(reg, dx, dy)) addEdge(g, i, j, dx, dy);
        });
      })(i);
    }
    return g;
  }

  /**
   * i から近い順に k 個を返す（自分を除く）。見つからなければ探索半径を広げる。
   * 返り値は距離の昇順。
   */
  function nearestK(idx, xi, yi, self, k, startR, maxR) {
    var R = startR;
    for (var attempt = 0; attempt < 14; attempt++) {
      var ji = [], jd = [];
      var R2 = R * R;
      eachNear(idx, xi, yi, R, function (j, dx, dy) {
        if (j === self) return;
        var d2 = dx * dx + dy * dy;
        if (d2 > R2) return;
        var pos = ji.length;
        while (pos > 0 && jd[pos - 1] > d2) pos--;
        if (pos >= k) return;
        ji.splice(pos, 0, j); jd.splice(pos, 0, d2);
        if (ji.length > k) { ji.pop(); jd.pop(); }
      });
      if (ji.length >= k || R >= maxR) {
        for (var m = 0; m < jd.length; m++) jd[m] = Math.sqrt(jd[m]);
        return { idx: ji, d: jd };
      }
      R *= 1.7;
    }
    return { idx: [], d: [] };
  }

  /** k 近傍グラフ。無向化は和（一方が他方を選べば辺）。 */
  function buildKnnGraph(pts, k) {
    var n = pts.n, size = pts.size;
    var mean = size / Math.sqrt(n);
    var idx = makeIndex(pts.x, pts.y, n, size, Math.max(mean, size / 128));
    var seen = {};
    var g = emptyGraph(n);
    for (var i = 0; i < n; i++) {
      var got = nearestK(idx, pts.x[i], pts.y[i], i, k, mean * Math.sqrt(k + 1) * 1.6, size / 2);
      for (var m = 0; m < got.idx.length; m++) {
        var j = got.idx[m];
        var a = i < j ? i : j, b = i < j ? j : i;
        var key = a * n + b;
        if (seen[key]) continue;
        seen[key] = 1;
        g.ea.push(a); g.eb.push(b); g.el.push(got.d[m]);
      }
    }
    return g;
  }

  /**
   * 中心 (cx,cy) 半径 rad の開円板に、i・j 以外の点が1つでもあるか。
   * 見つかり次第返す（Gabriel の判定はほとんどの候補で即座に棄却される）。
   */
  function anyInside(idx, cx, cy, rad, i, j) {
    var nb = idx.nb, bs = idx.bs, size = idx.size, x = idx.x, y = idx.y;
    var rad2 = rad * rad;
    var lay = Math.ceil(rad / bs);
    var bx = Math.floor(cx / bs); if (bx >= nb) bx = nb - 1; if (bx < 0) bx = 0;
    var by = Math.floor(cy / bs); if (by >= nb) by = nb - 1; if (by < 0) by = 0;
    if (2 * lay + 1 >= nb) lay = Math.floor((nb - 1) / 2);
    for (var ring = 0; ring <= lay; ring++) {
      for (var a = -ring; a <= ring; a++) {
        for (var b = -ring; b <= ring; b++) {
          if (Math.max(Math.abs(a), Math.abs(b)) !== ring) continue;
          var gx = (((bx + a) % nb) + nb) % nb, gy = (((by + b) % nb) + nb) % nb;
          for (var q = idx.head[gy * nb + gx]; q !== -1; q = idx.next[q]) {
            if (q === i || q === j) continue;
            var dx = wrapDelta(x[q] - cx, size), dy = wrapDelta(y[q] - cy, size);
            if (dx * dx + dy * dy < rad2) return true;
          }
        }
      }
    }
    return false;
  }

  /** 点集合の「最大の空円」の半径の上界。Gabriel の候補半径を厳密に決めるために使う。 */
  function emptyCircleBound(pts) {
    var n = pts.n, size = pts.size;
    var idx = makeIndex(pts.x, pts.y, n, size, Math.max(size / Math.sqrt(n), size / 128));
    var m = Math.max(8, Math.ceil(Math.sqrt(n)));
    var h = size / m, worst = 0;
    for (var a = 0; a < m; a++) {
      for (var b = 0; b < m; b++) {
        var cx = (a + 0.5) * h, cy = (b + 0.5) * h;
        var R = h, best = Infinity;
        for (var tries = 0; tries < 14 && best === Infinity; tries++) {
          (function (R) {
            eachNear(idx, cx, cy, R, function (q, dx, dy) {
              var d2 = dx * dx + dy * dy;
              if (d2 <= R * R && d2 < best) best = d2;
            });
          })(R);
          if (best === Infinity) { R *= 1.8; if (R > size) break; }
        }
        if (best !== Infinity) { var d = Math.sqrt(best); if (d > worst) worst = d; }
      }
    }
    return Math.min(worst + h * Math.SQRT2 / 2, size * Math.SQRT1_2);
  }

  /**
   * Gabriel グラフ。(i,j) が辺 ⟺ ij を直径とする開円板の内部に他の点が無い。
   * パラメータを持たない。2次元ポアソン点過程での期待次数は 4（既知の値。selftest で使う）。
   *
   * 候補の網羅性: Gabriel 辺の長さ d は「その辺の中点を中心とする半径 d/2 の空円」を
   * 要求するので、d <= 2 * (点集合の最大の空円の半径) が厳密に成り立つ。この上界を
   * 候補半径に使うので辺を取りこぼさない。集積した配置では空隙が大きく上界も大きくなるが、
   * 中点の判定は即座に棄却されるので費用は候補の列挙側にしか乗らない。
   */
  function buildGabrielGraph(pts) {
    var n = pts.n, size = pts.size, x = pts.x, y = pts.y;
    var idx = makeIndex(x, y, n, size, Math.max(size / Math.sqrt(n), size / 128));
    var R = Math.min(2 * emptyCircleBound(pts), size * Math.SQRT1_2);
    var R2 = R * R;
    var g = emptyGraph(n);
    g.candidateRadius = R;
    for (var i = 0; i < n; i++) {
      (function (i) {
        eachNear(idx, x[i], y[i], R, function (j, dx, dy) {
          if (j <= i) return;
          var d2 = dx * dx + dy * dy;
          if (d2 > R2 || d2 === 0) return;
          var mx = wrapPos(x[i] + dx / 2, size), my = wrapPos(y[i] + dy / 2, size);
          if (anyInside(idx, mx, my, Math.sqrt(d2) / 2 - 1e-12, i, j)) return;
          addEdge(g, i, j, dx, dy);
        });
      })(i);
    }
    return g;
  }

  /** 形の名前 → グラフ。param は disc 系なら半径、knn なら k、gabriel なら無視。 */
  function buildShapeGraph(pts, shape, param) {
    if (shape === 'knn') return buildKnnGraph(pts, param);
    if (shape === 'gabriel') return buildGabrielGraph(pts);
    return buildRegionGraph(pts, makeRegion(shape, param));
  }

  var SHAPES_MATCHED = ['disc', 'square', 'diamond', 'stripe', 'knn'];
  var SHAPES_ALL = ['disc', 'square', 'diamond', 'stripe', 'knn', 'gabriel'];

  // ------------------------------------------------------------ グラフの統計

  function graphStats(g) {
    var n = g.n;
    var deg = new Int32Array(n);
    var k;
    for (k = 0; k < g.ea.length; k++) { deg[g.ea[k]]++; deg[g.eb[k]]++; }
    var sum = 0;
    for (k = 0; k < n; k++) sum += deg[k];
    var mean = sum / n, varr = 0;
    for (k = 0; k < n; k++) { var d = deg[k] - mean; varr += d * d; }
    varr /= n;
    var elSum = 0;
    for (k = 0; k < g.el.length; k++) elSum += g.el[k];
    var iso = 0;
    for (k = 0; k < n; k++) if (deg[k] === 0) iso++;
    return {
      meanDegree: mean,
      degreeCV: mean > 0 ? Math.sqrt(varr) / mean : 0,
      meanEdgeLength: g.el.length > 0 ? elSum / g.el.length : 0,
      edges: g.el.length,
      isolatedFraction: iso / n,
      degree: deg,
    };
  }


  /**
   * グラフ上の距離 2 以内（自分を除く）の点集合についての次数と幾何距離の平均。
   * どの形にも定義でき、形のパラメータを新たに1つも増やさない「粗い版」になる。
   * 短距離の対（二量体）は 1-hop では効くが 2-hop では薄まる。相分離は薄まらない。
   */
  function twoHopStats(pts, g) {
    var n = g.n, size = pts.size, x = pts.x, y = pts.y;
    var deg = new Int32Array(n), k;
    for (k = 0; k < g.ea.length; k++) { deg[g.ea[k]]++; deg[g.eb[k]]++; }
    var off = new Int32Array(n + 1);
    for (k = 0; k < n; k++) off[k + 1] = off[k] + deg[k];
    var fill = new Int32Array(n), adj = new Int32Array(off[n]);
    for (k = 0; k < g.ea.length; k++) {
      var a = g.ea[k], b = g.eb[k];
      adj[off[a] + fill[a]++] = b; adj[off[b] + fill[b]++] = a;
    }
    var stamp = new Int32Array(n);
    for (k = 0; k < n; k++) stamp[k] = -1;
    var degSum = 0, lenSum = 0, lenCount = 0;
    for (var i = 0; i < n; i++) {
      var cnt = 0;
      stamp[i] = i;
      for (var p1 = off[i]; p1 < off[i + 1]; p1++) {
        var j = adj[p1];
        if (stamp[j] !== i) { stamp[j] = i; cnt++; lenSum += hypotWrap(x, y, size, i, j); lenCount++; }
        for (var p2 = off[j]; p2 < off[j + 1]; p2++) {
          var m = adj[p2];
          if (stamp[m] !== i) { stamp[m] = i; cnt++; lenSum += hypotWrap(x, y, size, i, m); lenCount++; }
        }
      }
      degSum += cnt;
    }
    return {
      meanDegree2: degSum / n,
      meanEdgeLength2: lenCount > 0 ? lenSum / lenCount : 0,
    };
  }

  function hypotWrap(x, y, size, i, j) {
    var dx = wrapDelta(x[j] - x[i], size), dy = wrapDelta(y[j] - y[i], size);
    return Math.sqrt(dx * dx + dy * dy);
  }

  /** 1つの点集合に、指定した形を全部当てて生の統計を返す。 */
  function measureAll(pts, shapeParams, shapes) {
    var out = {};
    (shapes || SHAPES_ALL).forEach(function (s) {
      var g = buildShapeGraph(pts, s, shapeParams[s]);
      var st = graphStats(g);
      var t2 = twoHopStats(pts, g);
      out[s] = {
        meanDegree: st.meanDegree, degreeCV: st.degreeCV, meanEdgeLength: st.meanEdgeLength,
        edges: st.edges, isolatedFraction: st.isolatedFraction,
        meanDegree2: t2.meanDegree2, meanEdgeLength2: t2.meanEdgeLength2,
      };
    });
    return out;
  }

  return {
    TAU: TAU,
    DEFAULTS: DEFAULTS,
    makeRng: makeRng,
    wrapPos: wrapPos,
    wrapDelta: wrapDelta,
    makeIndex: makeIndex,
    eachNear: eachNear,
    countNeighbours: countNeighbours,
    createWorld: createWorld,
    stepWorld: stepWorld,
    runReplicate: runReplicate,
    pointsOf: pointsOf,
    poissonPoints: poissonPoints,
    latticePoints: latticePoints,
    clusteredPoints: clusteredPoints,
    pairedPoints: pairedPoints,
    makeRegion: makeRegion,
    inRegion: inRegion,
    buildRegionGraph: buildRegionGraph,
    buildKnnGraph: buildKnnGraph,
    buildGabrielGraph: buildGabrielGraph,
    emptyCircleBound: emptyCircleBound,
    anyInside: anyInside,
    buildShapeGraph: buildShapeGraph,
    graphStats: graphStats,
    twoHopStats: twoHopStats,
    measureAll: measureAll,
    SHAPES_MATCHED: SHAPES_MATCHED,
    SHAPES_ALL: SHAPES_ALL,
  };
});
