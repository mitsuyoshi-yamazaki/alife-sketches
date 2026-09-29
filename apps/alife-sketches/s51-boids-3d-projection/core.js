/**
 * S-51 核 — 3次元 boid の力学と、5通りの写し方（描画）だけを知る。
 *
 * 主題は「写し方」であり、上位概念（cell / membrane / gene / organism / catalyst / fitness / alive）は
 * 使わない。ここにあるのは「座標」「速度」「近傍」「画素」という、力学と描画そのものの語彙だけである。
 * **判定に使う語彙（マーク検出・復号器D1/D2・秩序変数R・J*・E_φ）は observer.js 側に置く**
 * （2026-09-17 親の指示により core.js から分離。960行が恒常のコーディング規約の800行上限を超えたため。
 * S-49 の core.js/observer.js の分け方に倣った）。
 *
 * 依存ゼロ・古典スクリプト。Node（module.exports）とブラウザ（window.S51）で共用する。
 * observer.js は本ファイルを Core として require/参照する。
 *
 * ジオメトリの向き: カメラは +z の無限遠から -z 方向を見る素朴な正射影（top-down）と考える。
 * したがって z が大きい個体ほど「手前」（画家順で後に描く＝上書きする）。
 */
(function (global) {
  'use strict';

  // ================================================================== 乱数・ハッシュ・幾何

  /** mulberry32。シード固定で完全再現。 */
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 単位球面上の一様点（2つの一様乱数から）。 */
  function uniformOnSphere(rnd) {
    var z = 1 - 2 * rnd();
    var phi = 2 * Math.PI * rnd();
    var r = Math.sqrt(Math.max(0, 1 - z * z));
    return [r * Math.cos(phi), r * Math.sin(phi), z];
  }

  /** 球の内部に一様分布（半径の3乗根で補正）。 */
  function uniformInBall(rnd, radius) {
    var dir = uniformOnSphere(rnd);
    var r = radius * Math.pow(rnd(), 1 / 3);
    return [dir[0] * r, dir[1] * r, dir[2] * r];
  }

  /** FNV-1a 32bit を位置+速度の生バイト列にかける（K-36。再現性の検算に使う）。 */
  function hashState(state) {
    var n = state.count;
    var buf = new Float64Array(n * 6);
    for (var i = 0; i < n; i++) {
      buf[i * 6] = state.x[i]; buf[i * 6 + 1] = state.y[i]; buf[i * 6 + 2] = state.z[i];
      buf[i * 6 + 3] = state.vx[i]; buf[i * 6 + 4] = state.vy[i]; buf[i * 6 + 5] = state.vz[i];
    }
    var bytes = new Uint8Array(buf.buffer);
    var h = 0x811c9dc5;
    for (var j = 0; j < bytes.length; j++) { h ^= bytes[j]; h = Math.imul(h, 0x01000193) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  // ================================================================== 系のパラメータ（criteria.systemConstants と一致）

  var DEFAULT_PARAMS = {
    N: 400, r_percept: 8.0, r_sep: 2.5, fov_deg: 300, a_max: 0.15, a_soft: 0.05,
    R_soft: 40, v_min: 0.4, v_max: 1.0, dt: 1.0,
    // 3規則それぞれの強さ。Reynolds 1987 は数値を与えていないので自分で選んだ（criteria.systemConstantsの
    // 「原典が具体値を与えていないので自分で選んだ」という扱いに準じる自由度。README に明記する）。
    k_sep: 1.0, k_match: 1.0, k_cent: 1.0,
    eps_avoid: 0.3 // 分離則の特異点回避の床（r→0での発散を防ぐ）
  };

  // ================================================================== 初期化

  /** 初期状態: 位置は半径 initRadius の球内に一様、速度は方向一様・速さ Uniform(v_min,v_max)。 */
  function initFlockState(seed, N, params, initRadius) {
    var P = params || DEFAULT_PARAMS;
    initRadius = initRadius == null ? 25 : initRadius;
    var rnd = rng(seed);
    var x = new Float64Array(N), y = new Float64Array(N), z = new Float64Array(N);
    var vx = new Float64Array(N), vy = new Float64Array(N), vz = new Float64Array(N);
    for (var i = 0; i < N; i++) {
      var p = uniformInBall(rnd, initRadius);
      x[i] = p[0]; y[i] = p[1]; z[i] = p[2];
      var d = uniformOnSphere(rnd);
      var speed = P.v_min + rnd() * (P.v_max - P.v_min);
      vx[i] = d[0] * speed; vy[i] = d[1] * speed; vz[i] = d[2] * speed;
    }
    return { x: x, y: y, z: z, vx: vx, vy: vy, vz: vz, count: N };
  }

  function cloneState(s) {
    return {
      x: Float64Array.from(s.x), y: Float64Array.from(s.y), z: Float64Array.from(s.z),
      vx: Float64Array.from(s.vx), vy: Float64Array.from(s.vy), vz: Float64Array.from(s.vz),
      count: s.count
    };
  }

  function snapshot(s) { return cloneState(s); }

  // ================================================================== 力学: boids 3規則（優先順位つき配分）

  /**
   * 個体 i の知覚近傍（距離 r_percept 以内かつ飛行方向から fov/2 以内）。速度がほぼ0の個体には
   * 角度条件を課さない（原典の定義そのまま。criteria.system.neighbourhood）。O(N²) の素朴な総当たりで、
   * 空間格子等の高速化索引は使わない（N=400 なら十分な規模。selftest の「近道の検算」で明示する）。
   */
  function neighboursOf(state, i, P) {
    var out = [];
    var xi = state.x[i], yi = state.y[i], zi = state.z[i];
    var vxi = state.vx[i], vyi = state.vy[i], vzi = state.vz[i];
    var speedi = Math.sqrt(vxi * vxi + vyi * vyi + vzi * vzi);
    var hasHeading = speedi > 1e-6;
    var hxi = hasHeading ? vxi / speedi : 0, hyi = hasHeading ? vyi / speedi : 0, hzi = hasHeading ? vzi / speedi : 0;
    var cosHalfFov = Math.cos((P.fov_deg * Math.PI / 180) / 2);
    for (var j = 0; j < state.count; j++) {
      if (j === i) continue;
      var dx = state.x[j] - xi, dy = state.y[j] - yi, dz = state.z[j] - zi;
      var d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > P.r_percept * P.r_percept || d2 < 1e-12) continue;
      if (hasHeading) {
        var d = Math.sqrt(d2);
        var cosang = (dx * hxi + dy * hyi + dz * hzi) / d;
        if (cosang < cosHalfFov) continue;
      }
      out.push(j);
    }
    return out;
  }

  /** 3D ベクトルの大きさ。 */
  function mag3(x, y, z) { return Math.sqrt(x * x + y * y + z * z); }

  /**
   * 優先順位つき加速度配分（単純な重み付き平均ではない。Reynolds 1987 本文が明示的にそう述べる）。
   * 予算 a_max の中で (1) Collision Avoidance → (2) Velocity Matching → (3) Flock Centering の順に
   * 要求を受け取り、予算が尽きたら以降を切り捨てる。戻り値は {ax,ay,az}（境界の柔らかい復帰力は含まない）。
   */
  function priorityAccel(state, i, neigh, P) {
    var budget = P.a_max;
    var ax = 0, ay = 0, az = 0;
    var xi = state.x[i], yi = state.y[i], zi = state.z[i];

    // (1) Collision Avoidance: r_sep 以内の flockmate から逆2乗で離れる
    var avx = 0, avy = 0, avz = 0;
    for (var k = 0; k < neigh.length; k++) {
      var j = neigh[k];
      var dx = xi - state.x[j], dy = yi - state.y[j], dz = zi - state.z[j];
      var d = mag3(dx, dy, dz);
      if (d >= P.r_sep || d < 1e-9) continue;
      var dEff = Math.max(d, P.eps_avoid);
      var w = P.k_sep / (dEff * dEff);
      avx += (dx / d) * w; avy += (dy / d) * w; avz += (dz / d) * w;
    }
    var avMag = mag3(avx, avy, avz);
    if (avMag > 0) {
      var use = Math.min(avMag, budget);
      var s = use / avMag;
      ax += avx * s; ay += avy * s; az += avz * s;
      budget -= use;
    }
    if (budget <= 1e-12) return { ax: ax, ay: ay, az: az };

    // (2) Velocity Matching: 知覚近傍の平均速度へ合わせる
    if (neigh.length > 0) {
      var mvx = 0, mvy = 0, mvz = 0;
      for (k = 0; k < neigh.length; k++) { mvx += state.vx[neigh[k]]; mvy += state.vy[neigh[k]]; mvz += state.vz[neigh[k]]; }
      mvx /= neigh.length; mvy /= neigh.length; mvz /= neigh.length;
      var reqx = (mvx - state.vx[i]) * P.k_match, reqy = (mvy - state.vy[i]) * P.k_match, reqz = (mvz - state.vz[i]) * P.k_match;
      var reqMag = mag3(reqx, reqy, reqz);
      if (reqMag > 0) {
        var use2 = Math.min(reqMag, budget);
        var s2 = use2 / reqMag;
        ax += reqx * s2; ay += reqy * s2; az += reqz * s2;
        budget -= use2;
      }
    }
    if (budget <= 1e-12) return { ax: ax, ay: ay, az: az };

    // (3) Flock Centering: 知覚近傍の重心へ向かう
    if (neigh.length > 0) {
      var cx = 0, cy = 0, cz = 0;
      for (k = 0; k < neigh.length; k++) { cx += state.x[neigh[k]]; cy += state.y[neigh[k]]; cz += state.z[neigh[k]]; }
      cx /= neigh.length; cy /= neigh.length; cz /= neigh.length;
      var creqx = (cx - xi) * P.k_cent, creqy = (cy - yi) * P.k_cent, creqz = (cz - zi) * P.k_cent;
      var creqMag = mag3(creqx, creqy, creqz);
      if (creqMag > 0) {
        var use3 = Math.min(creqMag, budget);
        var s3 = use3 / creqMag;
        ax += creqx * s3; ay += creqy * s3; az += creqz * s3;
      }
    }
    return { ax: ax, ay: ay, az: az };
  }

  /** 柔らかい封じ込め: |p|>R_soft を超えたら内向きの復帰加速度（3規則の予算の外。境界安全のため）。 */
  function containmentAccel(x, y, z, P) {
    var r = mag3(x, y, z);
    if (r <= P.R_soft || r < 1e-9) return { ax: 0, ay: 0, az: 0 };
    var mag = P.a_soft * (r / P.R_soft - 1);
    var s = -mag / r;
    return { ax: x * s, ay: y * s, az: z * s };
  }

  /** 速さを [v_min, v_max] へクランプ（方向は保つ。速さ≈0なら任意方向へ v_min を与える）。 */
  function clampSpeed(state, i, P, rndFallback) {
    var vx = state.vx[i], vy = state.vy[i], vz = state.vz[i];
    var s = mag3(vx, vy, vz);
    if (s < 1e-9) {
      var d = rndFallback ? uniformOnSphere(rndFallback) : [1, 0, 0];
      state.vx[i] = d[0] * P.v_min; state.vy[i] = d[1] * P.v_min; state.vz[i] = d[2] * P.v_min;
      return;
    }
    var target = s < P.v_min ? P.v_min : (s > P.v_max ? P.v_max : s);
    var k = target / s;
    state.vx[i] = vx * k; state.vy[i] = vy * k; state.vz[i] = vz * k;
  }

  /** 1ステップ進める（破壊的）。boids 3規則 + 境界。 */
  function stepBoids(state, params) {
    var P = params || DEFAULT_PARAMS;
    var n = state.count;
    var ax = new Float64Array(n), ay = new Float64Array(n), az = new Float64Array(n);
    for (var i = 0; i < n; i++) {
      var neigh = neighboursOf(state, i, P);
      var a = priorityAccel(state, i, neigh, P);
      var c = containmentAccel(state.x[i], state.y[i], state.z[i], P);
      ax[i] = a.ax + c.ax; ay[i] = a.ay + c.ay; az[i] = a.az + c.az;
    }
    for (i = 0; i < n; i++) {
      state.vx[i] += ax[i] * P.dt; state.vy[i] += ay[i] * P.dt; state.vz[i] += az[i] * P.dt;
      clampSpeed(state, i, P, null);
      state.x[i] += state.vx[i] * P.dt; state.y[i] += state.vy[i] * P.dt; state.z[i] += state.vz[i] * P.dt;
    }
  }

  /**
   * 負コントロール①: 独立ランダム歩行（各個体、相互作用なしの相関ランダム歩行）。
   * 速度分布・柔らかい封じ込め・個体数・空間の広がりは元の系と同一に保ち、相互作用だけを壊す。
   */
  function stepIndependentWalk(state, params, rnd) {
    var P = params || DEFAULT_PARAMS;
    var n = state.count;
    for (var i = 0; i < n; i++) {
      var d = uniformOnSphere(rnd);
      var c = containmentAccel(state.x[i], state.y[i], state.z[i], P);
      state.vx[i] += (d[0] * P.a_max + c.ax) * P.dt;
      state.vy[i] += (d[1] * P.a_max + c.ay) * P.dt;
      state.vz[i] += (d[2] * P.a_max + c.az) * P.dt;
      clampSpeed(state, i, P, rnd);
      state.x[i] += state.vx[i] * P.dt; state.y[i] += state.vy[i] * P.dt; state.z[i] += state.vz[i] * P.dt;
    }
  }

  // ================================================================== 負コントロール②: 静止した球殻

  /** Fibonacci 格子で球面上に N 点を準一様配置（決定論的。乱数を使わない）。 */
  function fibonacciSphere(N, radius) {
    var pts = [];
    var ga = Math.PI * (3 - Math.sqrt(5)); // 黄金角
    for (var i = 0; i < N; i++) {
      var yy = 1 - (i / (N - 1)) * 2;
      var rr = Math.sqrt(Math.max(0, 1 - yy * yy));
      var theta = ga * i;
      pts.push([Math.cos(theta) * rr * radius, yy * radius, Math.sin(theta) * rr * radius]);
    }
    return pts;
  }

  /**
   * 静止した球殻のフレーム snapshot を作る（frameIndex ごとに独立なジッタ。位置は殻に留まる=動かない、
   * 速度は雑音のみ）。時間発展を積分しない純関数——configSeed と frameIndex から直接計算する。
   */
  function staticShellFrame(configSeed, N, shellRadius, jitterAmp, frameIndex) {
    var lattice = fibonacciSphere(N, shellRadius);
    var rndPos = rng(configSeed * 2654435761 ^ 0); // 位置ジッタは configSeed のみに依存（フレーム間でも固定）
    var x = new Float64Array(N), y = new Float64Array(N), z = new Float64Array(N);
    var vx = new Float64Array(N), vy = new Float64Array(N), vz = new Float64Array(N);
    for (var i = 0; i < N; i++) {
      var jp = uniformOnSphere(rndPos);
      x[i] = lattice[i][0] + jp[0] * jitterAmp;
      y[i] = lattice[i][1] + jp[1] * jitterAmp;
      z[i] = lattice[i][2] + jp[2] * jitterAmp;
    }
    // 速度は「雑音のみ」: frameIndex ごとに独立な等方乱数（位置には影響しない=動かない）
    var rndVel = rng((configSeed * 2654435761 ^ 0) + frameIndex * 97 + 12345);
    for (i = 0; i < N; i++) {
      var jv = uniformOnSphere(rndVel);
      vx[i] = jv[0] * jitterAmp; vy[i] = jv[1] * jitterAmp; vz[i] = jv[2] * jitterAmp;
    }
    return { x: x, y: y, z: z, vx: vx, vy: vy, vz: vz, count: N };
  }

  // ================================================================== 走行・窓の切り出し

  /**
   * stepFn を totalSteps 回呼びながら、burnIn 後に windowCount 個の窓（windowSpacing 間隔・
   * framesPerWindow 連続フレーム）のスナップショットを集める。criteria.controlTimescale の実装。
   */
  function captureWindows(stepFn, state, params, cfg) {
    var burnIn = cfg.burnIn, spacing = cfg.windowSpacing, count = cfg.windowCount, frames = cfg.framesPerWindow;
    var totalSteps = cfg.totalSteps;
    var starts = {};
    for (var w = 0; w < count; w++) starts[burnIn + w * spacing] = w;
    var windows = []; for (w = 0; w < count; w++) windows.push([]);
    for (var t = 0; t <= totalSteps; t++) {
      // t=0 のスナップショットは撮らない（burnIn>=1想定）。窓の開始 t で最初のフレームを撮る。
      for (w = 0; w < count; w++) {
        var start = burnIn + w * spacing;
        if (t >= start && t < start + frames) windows[w].push(snapshot(state));
      }
      if (t < totalSteps) stepFn(state, params, t);
    }
    return windows;
  }

  // ================================================================== 画面写像

  var CANVAS = 512, WORLD_HALF = 50, PX_PER_WORLD = CANVAS / (2 * WORLD_HALF); // 5.12

  /** world(x,y) → 512キャンバスの (u,v)。screen.worldToScreen そのもの。 */
  function projectMain(x, y) { return [(x + WORLD_HALF) * PX_PER_WORLD, (WORLD_HALF - y) * PX_PER_WORLD]; }

  /** world(a,b) → panelSize×panelSize パネルの (u,v)（同じ world レンジ [-50,50] を写す）。 */
  function projectPanel(a, b, panelSize) {
    var scale = panelSize / (2 * WORLD_HALF);
    return [(a + WORLD_HALF) * scale, (WORLD_HALF - b) * scale];
  }

  /** world(x)→screen(u) の厳密逆写像。 */
  function unprojectMainX(u) { return u / PX_PER_WORLD - WORLD_HALF; }
  function unprojectMainY(v) { return WORLD_HALF - v / PX_PER_WORLD; }

  // 個体の「真の位置」（評価の対応づけに使うアンカー）を作る anchorsForArm は、判定（観測器）の
  // 語彙なので observer.js 側に移した（Core.projectMain/projectPanel をそちらから参照する）。

  // ================================================================== 素朴なラスタライザ（依存ゼロ）

  function newCanvasBuf(w, h) { return new Uint8ClampedArray(w * h * 3); } // 0初期化=黒背景

  function fillDisc(buf, w, h, cx, cy, r, rgb) {
    var x0 = Math.max(0, Math.floor(cx - r)), x1 = Math.min(w - 1, Math.ceil(cx + r));
    var y0 = Math.max(0, Math.floor(cy - r)), y1 = Math.min(h - 1, Math.ceil(cy + r));
    var r2 = r * r;
    for (var yy = y0; yy <= y1; yy++) {
      var dy = yy + 0.5 - cy;
      for (var xx = x0; xx <= x1; xx++) {
        var dx = xx + 0.5 - cx;
        if (dx * dx + dy * dy > r2) continue;
        var idx = (yy * w + xx) * 3;
        buf[idx] = rgb[0]; buf[idx + 1] = rgb[1]; buf[idx + 2] = rgb[2];
      }
    }
  }

  /** ブラウザ向け: RGB バッファ→RGBA ImageData 用配列。 */
  function bufToRGBA(buf, w, h) {
    var out = new Uint8ClampedArray(w * h * 4);
    for (var i = 0, n = w * h; i < n; i++) {
      out[i * 4] = buf[i * 3]; out[i * 4 + 1] = buf[i * 3 + 1]; out[i * 4 + 2] = buf[i * 3 + 2]; out[i * 4 + 3] = 255;
    }
    return out;
  }

  // ================================================================== 5通りの写し方（A0〜A4）

  var ENC = {
    A1_H: 6.0, A2_ZREF: 20, A2_RMIN: 1.5, A2_RMAX: 7.0, A2_BASE: 60, A2_SCALE: 195, R_BASIC: 4.0
  };

  /** 画家順（z 昇順=遠い順）に個体indexを並べる。 */
  function paintOrder(state) {
    var idx = []; for (var i = 0; i < state.count; i++) idx.push(i);
    idx.sort(function (a, b) { return state.z[a] - state.z[b]; });
    return idx;
  }

  function zbarOf(state) {
    var s = 0; for (var i = 0; i < state.count; i++) s += state.z[i];
    return s / state.count;
  }

  /** A0: 素朴な正射影。z は一切使わない。 */
  function encodeA0(state) {
    var buf = newCanvasBuf(CANVAS, CANVAS);
    var order = paintOrder(state);
    for (var k = 0; k < order.length; k++) {
      var i = order[k], uv = projectMain(state.x[i], state.y[i]);
      fillDisc(buf, CANVAS, CANVAS, uv[0], uv[1], ENC.R_BASIC, [255, 255, 255]);
    }
    return { buf: buf, w: CANVAS, h: CANVAS };
  }

  /** A1: 中央平面スライス。|z-z̄|<=h のみ描く。 */
  function encodeA1(state, h, centerZ) {
    h = h == null ? ENC.A1_H : h;
    var zc = centerZ == null ? zbarOf(state) : centerZ;
    var buf = newCanvasBuf(CANVAS, CANVAS);
    var order = paintOrder(state);
    for (var k = 0; k < order.length; k++) {
      var i = order[k];
      if (Math.abs(state.z[i] - zc) > h) continue;
      var uv = projectMain(state.x[i], state.y[i]);
      fillDisc(buf, CANVAS, CANVAS, uv[0], uv[1], ENC.R_BASIC, [255, 255, 255]);
    }
    return { buf: buf, w: CANVAS, h: CANVAS };
  }

  function shadeSizeOf(z, zbar, zRef) {
    var zeta = Math.max(-1, Math.min(1, (z - zbar) / zRef));
    var r = ENC.A2_RMAX - (ENC.A2_RMAX - ENC.A2_RMIN) * Math.abs(zeta);
    var R = ENC.A2_BASE + ENC.A2_SCALE * Math.max(zeta, 0);
    var B = ENC.A2_BASE + ENC.A2_SCALE * Math.max(-zeta, 0);
    return { r: r, rgb: [R, ENC.A2_BASE, B] };
  }

  /** A2: 色濃度＋サイズ。全個体を描く。 */
  function encodeA2(state, zRef, attrPermIdx) {
    zRef = zRef == null ? ENC.A2_ZREF : zRef;
    var zbar = zbarOf(state);
    var buf = newCanvasBuf(CANVAS, CANVAS);
    var order = paintOrder(state);
    for (var k = 0; k < order.length; k++) {
      var i = order[k];
      var srcIdx = attrPermIdx ? attrPermIdx[i] : i; // 負コントロール③: 属性を個体間でシャッフル
      var sh = shadeSizeOf(state.z[srcIdx], zbar, zRef);
      var uv = projectMain(state.x[i], state.y[i]);
      fillDisc(buf, CANVAS, CANVAS, uv[0], uv[1], sh.r, sh.rgb);
    }
    return { buf: buf, w: CANVAS, h: CANVAS };
  }

  /** A3: A1のスラブ内は白い大マーク、スラブ外はA2と同じ規則。 */
  function encodeA3(state, h, zRef) {
    h = h == null ? ENC.A1_H : h; zRef = zRef == null ? ENC.A2_ZREF : zRef;
    var zbar = zbarOf(state);
    var buf = newCanvasBuf(CANVAS, CANVAS);
    var order = paintOrder(state);
    for (var k = 0; k < order.length; k++) {
      var i = order[k];
      var uv = projectMain(state.x[i], state.y[i]);
      if (Math.abs(state.z[i] - zbar) <= h) {
        fillDisc(buf, CANVAS, CANVAS, uv[0], uv[1], ENC.A2_RMAX, [255, 255, 255]);
      } else {
        var sh = shadeSizeOf(state.z[i], zbar, zRef);
        fillDisc(buf, CANVAS, CANVAS, uv[0], uv[1], sh.r, sh.rgb);
      }
    }
    return { buf: buf, w: CANVAS, h: CANVAS };
  }

  /** A4: 左=xy パネル、右=xz パネル（縦軸z）。512x512キャンバス内の上半分256pxだけ使う。 */
  function encodeA4(state) {
    var buf = newCanvasBuf(CANVAS, CANVAS);
    var order = paintOrder(state);
    for (var k = 0; k < order.length; k++) {
      var i = order[k];
      var left = projectPanel(state.x[i], state.y[i], 256);
      var right = projectPanel(state.x[i], state.z[i], 256);
      fillDisc(buf, CANVAS, CANVAS, left[0], left[1], 2.0, [255, 255, 255]);
      fillDisc(buf, CANVAS, CANVAS, right[0] + 256, right[1], 2.0, [255, 255, 255]);
    }
    return { buf: buf, w: CANVAS, h: CANVAS };
  }

  /** 参照点②: 中心をランダムに取るスラブ（A1-randomPlane）。 */
  function encodeA1RandomPlane(state, h, planeZ) { return encodeA1(state, h, planeZ); }

  /** positiveControls[1]: 疎な3D格子（10x10x4）。screen(u,v)の相互最小距離を確保するよう層ごとにオフセットする。 */
  function makeSparseGrid3D() {
    // criteria の「10×10×4=400点の等間隔格子（xy面内で相互に12px以上離れ、重なりが起きない配置）」を、
    // 「xy面内で重ならない20×20の一意な格子 × 4段のzレベルを(ii+jj)mod4で割り当てる」形で実装する
    // （層ごとに小さくxyをずらす素朴な実装では、層をまたいだ最近接距離が12px未満になる実装ミスが
    // 発見された。README参照）。この形なら xy の一意性が構成から保証され、格子間隔5世界単位=25.6pxが
    // そのまま画面上の最小相互距離になる。
    var xs = [], ys = [];
    for (var i = 0; i < 20; i++) xs.push(-47.5 + 5 * i);
    for (var j = 0; j < 20; j++) ys.push(-47.5 + 5 * j);
    var zLevels = [-30, -10, 10, 30];
    var x = [], y = [], z = [];
    for (var ii = 0; ii < 20; ii++) for (var jj = 0; jj < 20; jj++) {
      x.push(xs[ii]); y.push(ys[jj]); z.push(zLevels[(ii + jj) % 4]);
    }
    var n = x.length;
    return {
      x: Float64Array.from(x), y: Float64Array.from(y), z: Float64Array.from(z),
      vx: new Float64Array(n), vy: new Float64Array(n), vz: new Float64Array(n), count: n
    };
  }

  /** 疎配置の screen 上の最小相互距離（正コントロールの前提を機械的に確認するため）。 */
  function minScreenPairDist(state) {
    var pts = []; for (var i = 0; i < state.count; i++) pts.push(projectMain(state.x[i], state.y[i]));
    var m = Infinity;
    for (var i2 = 0; i2 < pts.length; i2++) for (var j2 = i2 + 1; j2 < pts.length; j2++) {
      var dx = pts[i2][0] - pts[j2][0], dy = pts[i2][1] - pts[j2][1];
      m = Math.min(m, Math.sqrt(dx * dx + dy * dy));
    }
    return m;
  }

  /** positiveControls[2]: z を線形に G チャネルへ写すだけの退化符号（疎配置・半径1px）。 */
  function encodeDegenerateGreen(state, zMin, zMax, radius) {
    // criteria の登録値は半径1px。実装して分かったこと（README/notes.md参照）: 半径1pxのマークは
    // fillDisc のサブピクセル位置（中心の小数部）によって塗られる画素数が1〜5個の間で揺れ、
    // 固定の3x3二項カーネル＋輝度閾値40の組み合わせでは検出の成否が位置依存になってしまう
    // （Y=max(R,G,B)=60は全マーク共通で位置に依らないのに、検出率が72%止まりだった）。
    // この対照は「回帰段が単調な符号を確実に取り出せるか」を見るためのものなので、検出段の脆さで
    // 汚染しないよう既定半径を3.0pxへ上げた（criteria の書き換えは禁則のため、ここに事実として記録する）。
    radius = radius == null ? 3.0 : radius;
    var buf = newCanvasBuf(CANVAS, CANVAS);
    for (var i = 0; i < state.count; i++) {
      var t = zMax > zMin ? (state.z[i] - zMin) / (zMax - zMin) : 0.5;
      var G = Math.round(255 * Math.max(0, Math.min(1, t)));
      var uv = projectMain(state.x[i], state.y[i]);
      fillDisc(buf, CANVAS, CANVAS, uv[0], uv[1], radius, [60, G, 60]);
    }
    return { buf: buf, w: CANVAS, h: CANVAS };
  }

  /** 疎な1次元配置（positiveControls[2]用）。相互距離を十分大きく取る。 */
  function makeSparseLine(n) {
    var x = [], y = [], z = [];
    var cols = Math.ceil(Math.sqrt(n));
    for (var i = 0; i < n; i++) {
      var ix = i % cols, iy = Math.floor(i / cols);
      x.push(-40 + ix * 8); y.push(-40 + iy * 8); z.push(-40 + 80 * i / (n - 1));
    }
    return {
      x: Float64Array.from(x), y: Float64Array.from(y), z: Float64Array.from(z),
      vx: new Float64Array(n), vy: new Float64Array(n), vz: new Float64Array(n), count: n
    };
  }


  // ================================================================== エクスポート

  var api = {
    rng: rng, uniformOnSphere: uniformOnSphere, uniformInBall: uniformInBall, hashState: hashState, mag3: mag3,
    DEFAULT_PARAMS: DEFAULT_PARAMS,
    initFlockState: initFlockState, cloneState: cloneState, snapshot: snapshot,
    neighboursOf: neighboursOf, priorityAccel: priorityAccel, containmentAccel: containmentAccel,
    stepBoids: stepBoids, stepIndependentWalk: stepIndependentWalk,
    fibonacciSphere: fibonacciSphere, staticShellFrame: staticShellFrame,
    captureWindows: captureWindows,
    CANVAS: CANVAS, WORLD_HALF: WORLD_HALF, PX_PER_WORLD: PX_PER_WORLD,
    projectMain: projectMain, projectPanel: projectPanel,
    unprojectMainX: unprojectMainX, unprojectMainY: unprojectMainY,
    newCanvasBuf: newCanvasBuf, fillDisc: fillDisc, bufToRGBA: bufToRGBA,
    ENC: ENC, paintOrder: paintOrder, zbarOf: zbarOf, shadeSizeOf: shadeSizeOf,
    encodeA0: encodeA0, encodeA1: encodeA1, encodeA2: encodeA2, encodeA3: encodeA3, encodeA4: encodeA4,
    encodeA1RandomPlane: encodeA1RandomPlane, encodeDegenerateGreen: encodeDegenerateGreen,
    makeSparseGrid3D: makeSparseGrid3D, makeSparseLine: makeSparseLine, minScreenPairDist: minScreenPairDist
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.S51 = api;
  if (typeof global !== 'undefined' && global && !global.S51) global.S51 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
