/**
 * S-09: 群れの中を情報がどう伝わるか（Boids）
 *
 * 各粒子は位置と向きだけを持つ。半径 r 内の近傍から3つのベクトルを作り、
 * 重み付きで足した向きへ、1 step あたり maxTurn までの角度で回頭し、前へ進む。
 *
 *   分離 sep   近すぎる近傍（半径 sepRadius 内）から離れる向き
 *   整列 ali   近傍の向きの平均
 *   結合 coh   近傍の重心へ向かう向き
 *
 *   target = arg( wSep·ŝep + wAli·âli + wCoh·ĉoh )
 *
 * このファイルには「群れ」も「情報」も「伝播」も無い。あるのは粒子・向き・近傍だけで、
 * それらの呼び名は下半分の観測器の側にしかない。
 *
 * 依存ゼロ。Node（生ログ生成）とブラウザ（可視化）が同じファイルを読む。
 *
 * 出典（アイデアのみ。コードは参照していない）:
 *   Reynolds, C. W. (1987) "Flocks, herds and schools: A distributed behavioral model"
 *   SIGGRAPH '87, Computer Graphics 21(4), 25-34
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S09 = api;
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
    size: 100,          // 正方トーラスの一辺
    count: 500,         // 粒子数
    radius: 5,          // 知覚半径（長さスケールの1つ）
    sepRadius: 2.5,     // 分離が効く半径
    wSep: 2.0,
    wAli: 1.0,
    wCoh: 1.0,
    speed: 1.0,         // 速さは一定（world/step。時間スケールの1つ）
    maxTurn: 0.35,      // 1 step の最大回頭角（rad）
    mode: 'local',      // 'local' | 'none' | 'drive' | 'shuffled'
    driveRate: 0.004,   // drive: 共通の目標方向が回る速さ（rad/step）
    shuffledDegree: 0,  // shuffled: 1粒子あたりの結線数（0 なら local の平均近傍数から決める）
  };

  function wrapAngle(a) { var v = a % TAU; return v < 0 ? v + TAU : v; }
  function angleDiff(a, b) { var d = (a - b + Math.PI) % TAU; if (d < 0) d += TAU; return d - Math.PI; }

  function createWorld(opts, seed) {
    var p = {};
    Object.keys(DEFAULTS).forEach(function (k) { p[k] = DEFAULTS[k]; });
    Object.keys(opts || {}).forEach(function (k) { if (opts[k] != null) p[k] = opts[k]; });

    var n = Math.max(1, Math.round(p.count));
    var rng = makeRng(seed);
    var x = new Float64Array(n), y = new Float64Array(n), phi = new Float64Array(n);
    for (var i = 0; i < n; i++) { x[i] = rng() * p.size; y[i] = rng() * p.size; phi[i] = rng() * TAU; }

    var cells = Math.max(1, Math.floor(p.size / p.radius));
    var w = {
      params: p, seed: seed, n: n, x: x, y: y, phi: phi, step: 0,
      neighbors: new Int32Array(n),
      grid: { cells: cells, cellSize: p.size / cells, head: new Int32Array(cells * cells), next: new Int32Array(n) },
      link: null, degree: 0,
    };

    if (p.mode === 'shuffled') {
      // 空間構造を持たない対照。次数だけを local の平均近傍数に合わせた固定の無作為グラフ。
      var deg = p.shuffledDegree > 0 ? p.shuffledDegree
        : Math.max(1, Math.round((n / (p.size * p.size)) * Math.PI * p.radius * p.radius));
      deg = Math.min(deg, n - 1);
      var link = new Int32Array(n * deg);
      for (var a = 0; a < n; a++) {
        for (var k = 0; k < deg; k++) {
          var j = a;
          while (j === a) j = Math.floor(rng() * n) % n;
          link[a * deg + k] = j;
        }
      }
      w.link = link; w.degree = deg;
    }
    return w;
  }

  function cloneWorld(w) {
    return {
      params: w.params, seed: w.seed, n: w.n,
      x: Float64Array.from(w.x), y: Float64Array.from(w.y), phi: Float64Array.from(w.phi),
      step: w.step, neighbors: Int32Array.from(w.neighbors),
      grid: {
        cells: w.grid.cells, cellSize: w.grid.cellSize,
        head: Int32Array.from(w.grid.head), next: Int32Array.from(w.grid.next),
      },
      link: w.link, degree: w.degree,
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

  function wrapDelta(d, size) {
    if (d > size * 0.5) return d - size;
    if (d < -size * 0.5) return d + size;
    return d;
  }

  /**
   * i の近傍を走査して cb(j, dx, dy, d2) を呼ぶ。自分自身は含めない。
   * mode によって「近傍」の意味が変わる（local は空間、shuffled は固定の結線）。
   *
   * 注意（method.md K-12）: 格子は rebuildGrid でしか更新されない。stepWorld は
   * 「格子を作る → 向きを決める → 粒子を動かす」の順なので、帰った直後の格子は古い。
   * 外から呼ぶときは必ず先に rebuildGrid すること。
   */
  function forEachNeighbor(w, i, cb) {
    var p = w.params;
    if (p.mode === 'shuffled') {
      for (var k = 0; k < w.degree; k++) {
        var j = w.link[i * w.degree + k];
        if (j === i) continue;
        var ddx = wrapDelta(w.x[j] - w.x[i], p.size);
        var ddy = wrapDelta(w.y[j] - w.y[i], p.size);
        cb(j, ddx, ddy, ddx * ddx + ddy * ddy);
      }
      return;
    }
    var g = w.grid, r2 = p.radius * p.radius;
    var cx = Math.floor(w.x[i] / g.cellSize) % g.cells;
    var cy = Math.floor(w.y[i] / g.cellSize) % g.cells;
    if (cx < 0) cx += g.cells;
    if (cy < 0) cy += g.cells;
    for (var oy = -1; oy <= 1; oy++) {
      var ny = (cy + oy + g.cells) % g.cells;
      for (var ox = -1; ox <= 1; ox++) {
        var nx = (cx + ox + g.cells) % g.cells;
        for (var j2 = g.head[ny * g.cells + nx]; j2 !== -1; j2 = g.next[j2]) {
          if (j2 === i) continue;
          var dx = wrapDelta(w.x[j2] - w.x[i], p.size);
          var dy = wrapDelta(w.y[j2] - w.y[i], p.size);
          var d2 = dx * dx + dy * dy;
          if (d2 <= r2) cb(j2, dx, dy, d2);
        }
      }
    }
  }

  /** 1粒子の次の向きを決める。近傍が無ければ向きを保つ。 */
  function desiredHeading(w, i) {
    var p = w.params;
    if (p.mode === 'none') return w.phi[i];
    if (p.mode === 'drive') {
      // 個体間の結合を一切持たない。全員が共通の外部方向場へ向く。
      return w.step * p.driveRate;
    }
    var sx = 0, sy = 0, ax = 0, ay = 0, cxs = 0, cys = 0, cnt = 0, sepCnt = 0;
    var sr2 = p.sepRadius * p.sepRadius;
    forEachNeighbor(w, i, function (j, dx, dy, d2) {
      cnt++;
      ax += Math.cos(w.phi[j]); ay += Math.sin(w.phi[j]);
      cxs += dx; cys += dy;
      if (d2 > 0 && d2 < sr2) { sx -= dx / d2; sy -= dy / d2; sepCnt++; }
    });
    w.neighbors[i] = cnt;
    if (cnt === 0) return w.phi[i];

    var vx = 0, vy = 0, m;
    if (sepCnt > 0) { m = Math.sqrt(sx * sx + sy * sy); if (m > 0) { vx += p.wSep * sx / m; vy += p.wSep * sy / m; } }
    m = Math.sqrt(ax * ax + ay * ay); if (m > 0) { vx += p.wAli * ax / m; vy += p.wAli * ay / m; }
    m = Math.sqrt(cxs * cxs + cys * cys); if (m > 0) { vx += p.wCoh * cxs / m; vy += p.wCoh * cys / m; }
    if (vx === 0 && vy === 0) return w.phi[i];
    return Math.atan2(vy, vx);
  }

  /** 1 step 進める（同期更新: 全員の新しい向きを古い状態から決めてから動かす）。 */
  function stepWorld(w) {
    var p = w.params;
    if (p.mode !== 'shuffled') rebuildGrid(w);
    var newPhi = new Float64Array(w.n);
    for (var i = 0; i < w.n; i++) {
      var target = desiredHeading(w, i);
      var d = angleDiff(target, w.phi[i]);
      if (d > p.maxTurn) d = p.maxTurn; else if (d < -p.maxTurn) d = -p.maxTurn;
      newPhi[i] = w.phi[i] + d;
    }
    for (var k = 0; k < w.n; k++) {
      var ph = wrapAngle(newPhi[k]);
      w.phi[k] = ph;
      w.x[k] = ((w.x[k] + Math.cos(ph) * p.speed) % p.size + p.size) % p.size;
      w.y[k] = ((w.y[k] + Math.sin(ph) * p.speed) % p.size + p.size) % p.size;
    }
    w.step++;
  }

  // ------------------------------------------------------------- 観測器
  //
  // ここから先だけが「群れ」「情報」「波面」を語る。核の側には無い語彙を使ってよい唯一の場所。

  /** 古典的な群れらしさ: 平均単位向きベクトルの長さ。ばらばらなら ~1/sqrt(N)、揃えば 1。 */
  function alignmentOrder(w) {
    var cx = 0, cy = 0;
    for (var i = 0; i < w.n; i++) { cx += Math.cos(w.phi[i]); cy += Math.sin(w.phi[i]); }
    return Math.sqrt(cx * cx + cy * cy) / w.n;
  }

  /** 相互作用グラフ上で、始点と繋がっている粒子の集合（BFS）。連結半径は知覚半径そのもの。 */
  function componentOf(w, start) {
    if (w.params.mode !== 'shuffled') rebuildGrid(w);
    var seen = new Uint8Array(w.n);
    var queue = [start];
    seen[start] = 1;
    while (queue.length) {
      var i = queue.pop();
      forEachNeighbor(w, i, function (j) { if (!seen[j]) { seen[j] = 1; queue.push(j); } });
    }
    return seen;
  }

  function torusDist(w, i, j) {
    var p = w.params;
    var dx = wrapDelta(w.x[j] - w.x[i], p.size), dy = wrapDelta(w.y[j] - w.y[i], p.size);
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * 分岐した2つの世界の対を作る。
   * 助走のあと複製し、片方だけ index の向きを perturbRad 回す。以降は同じ手続きで進める。
   * eps=0 なら「対照走行とビット単位で違うか」が到達の判定になる（スケールの選択を含まない）。
   */
  function pairFromWorld(w, index, perturbRad, eps) {
    var a = w, b = cloneWorld(w);
    b.phi[index] = wrapAngle(b.phi[index] + perturbRad);
    var comp = componentOf(a, index);
    var dist0 = new Float64Array(a.n);
    for (var i = 0; i < a.n; i++) dist0[i] = torusDist(a, index, i);
    var arrival = new Int32Array(a.n); arrival.fill(-1);
    arrival[index] = 0;
    var p = {
      a: a, b: b, index: index, perturbRad: perturbRad, eps: eps || 0,
      t: 0, arrival: arrival, dist0: dist0, comp: comp,
      compSize: comp.reduce(function (s, v) { return s + v; }, 0),
      div: new Float64Array(a.n), series: [],
    };
    p.div[index] = Math.abs(angleDiff(b.phi[index], a.phi[index]));
    recordSeries(p);
    return p;
  }

  function createPair(opts, seed, warmupSteps, index, perturbRad, eps) {
    var w = createWorld(opts, seed);
    for (var t = 0; t < warmupSteps; t++) stepWorld(w);
    return pairFromWorld(w, index == null ? 0 : index, perturbRad, eps);
  }

  function divergenceNorm(p) {
    var s = 0;
    for (var i = 0; i < p.a.n; i++) s += p.div[i] * p.div[i];
    return Math.sqrt(s);
  }

  /** 擾乱の参加比。擾乱を実効的に何粒子が担っているか。d の大きさに対して不変。 */
  function spreadCount(p) {
    var s2 = 0, s4 = 0;
    for (var i = 0; i < p.a.n; i++) { var d2 = p.div[i] * p.div[i]; s2 += d2; s4 += d2 * d2; }
    return s4 > 0 ? (s2 * s2) / s4 : 0;
  }

  function reachedCount(p) {
    var c = 0;
    for (var i = 0; i < p.a.n; i++) if (p.arrival[i] >= 0) c++;
    return c;
  }

  function recordSeries(p) {
    p.series.push({ t: p.t, reached: reachedCount(p), divNorm: divergenceNorm(p), spread: spreadCount(p) });
  }

  function stepPair(p) {
    stepWorld(p.a);
    stepWorld(p.b);
    p.t++;
    for (var i = 0; i < p.a.n; i++) {
      var d = Math.abs(angleDiff(p.b.phi[i], p.a.phi[i]));
      p.div[i] = d;
      if (p.arrival[i] < 0 && d > p.eps) p.arrival[i] = p.t;
    }
    recordSeries(p);
  }

  /** 到達時刻と初期距離から、波面の相関と速さ（world/step）を出す。 */
  function frontFit(p) {
    var ts = [], ds = [];
    for (var i = 0; i < p.a.n; i++) {
      if (p.arrival[i] >= 1) { ts.push(p.arrival[i]); ds.push(p.dist0[i]); }
    }
    var n = ts.length;
    if (n < 3) return { n: n, correlation: 0, speed: 0, maxHopSpeed: 0 };
    var mt = 0, md = 0, i2;
    for (i2 = 0; i2 < n; i2++) { mt += ts[i2]; md += ds[i2]; }
    mt /= n; md /= n;
    var stt = 0, sdd = 0, std = 0;
    for (i2 = 0; i2 < n; i2++) {
      var dt = ts[i2] - mt, dd = ds[i2] - md;
      stt += dt * dt; sdd += dd * dd; std += dt * dd;
    }
    var maxHop = 0;
    for (i2 = 0; i2 < n; i2++) maxHop = Math.max(maxHop, ds[i2] / ts[i2]);
    return {
      n: n,
      correlation: (stt > 0 && sdd > 0) ? std / Math.sqrt(stt * sdd) : 0,
      speed: stt > 0 ? std / stt : 0,
      maxHopSpeed: maxHop,
    };
  }

  function lyapunov(p, t1, t2) {
    var s = p.series;
    if (s.length <= t2) t2 = s.length - 1;
    if (t2 <= t1) return null;
    var d1 = s[t1].divNorm, d2 = s[t2].divNorm;
    if (d1 <= 0) return null;
    return Math.log(d2 / d1) / (t2 - t1);
  }

  /** 事前登録した秩序変数をまとめて出す。 */
  function pairMetrics(p, lyapWindow) {
    var lw = lyapWindow || [1, 100];
    var f = frontFit(p);
    var rc = reachedCount(p);
    var reachedInComp = 0;
    for (var i = 0; i < p.a.n; i++) if (p.comp[i] && p.arrival[i] >= 0) reachedInComp++;
    var pr = p.a.params;
    return {
      steps: p.t,
      n: p.a.n,
      mode: pr.mode,
      radius: pr.radius,
      wAli: pr.wAli,
      density: p.a.n / (pr.size * pr.size),
      reachedCount: rc,
      reachedFraction: rc / p.a.n,
      componentSize: p.compSize,
      componentFraction: p.compSize / p.a.n,
      reachedWithinComponent: p.compSize > 0 ? reachedInComp / p.compSize : 0,
      spreadCount: spreadCount(p),
      divNorm: divergenceNorm(p),
      frontCorrelation: f.correlation,
      frontSpeed: f.speed,
      frontSpeedInRadii: pr.radius > 0 ? f.speed / pr.radius : 0,
      frontSpeedRelative: pr.speed > 0 ? f.speed / pr.speed : 0,
      maxHopSpeed: f.maxHopSpeed,
      causalityBound: pr.radius + 2 * pr.speed,
      lyapunov: lyapunov(p, lw[0], lw[1]),
      alignmentOrder: alignmentOrder(p.a),
      meanNeighbors: (function () { var s = 0; for (var k = 0; k < p.a.n; k++) s += p.a.neighbors[k]; return s / p.a.n; })(),
    };
  }

  function runPair(opts, seed, warmupSteps, observeSteps, perturbRad, index, eps, onStep) {
    var p = createPair(opts, seed, warmupSteps, index, perturbRad, eps);
    for (var t = 0; t < observeSteps; t++) {
      stepPair(p);
      if (onStep) onStep(p);
    }
    return p;
  }

  return {
    DEFAULTS: DEFAULTS, TAU: TAU,
    makeRng: makeRng, wrapAngle: wrapAngle, angleDiff: angleDiff,
    createWorld: createWorld, cloneWorld: cloneWorld, stepWorld: stepWorld,
    rebuildGrid: rebuildGrid, forEachNeighbor: forEachNeighbor, desiredHeading: desiredHeading,
    alignmentOrder: alignmentOrder, componentOf: componentOf, torusDist: torusDist,
    pairFromWorld: pairFromWorld, createPair: createPair, stepPair: stepPair,
    divergenceNorm: divergenceNorm, spreadCount: spreadCount, reachedCount: reachedCount,
    frontFit: frontFit, lyapunov: lyapunov, pairMetrics: pairMetrics, runPair: runPair,
  };
});
