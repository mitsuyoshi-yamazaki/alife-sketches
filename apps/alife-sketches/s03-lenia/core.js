/**
 * S-03: Lenia（連続セルオートマトン）
 *
 * ライフゲームを空間・時間・状態のすべてについて連続化した系。場 A は [0,1] の
 * 連続値を取り、同心環状の核 K との畳み込みで近傍の総和 U を作り、成長写像 G を
 * 通して dt = 1/T ずつ更新する:
 *
 *   U   = K * A                       （トーラス上の畳み込み。sum K = 1）
 *   G(u) = 2 exp(-(u-mu)^2 / (2 s^2)) - 1      （範囲 [-1, 1]）
 *   A  <- clip(A + (1/T) G(U), 0, 1)
 *
 * 核は半径 R の円盤上で定義し、r = d/R として
 *   K(r) = b[floor(B r)] * Kc(frac(B r)),  Kc(q) = exp(alpha - alpha/(4 q (1-q)))
 * 総和が 1 になるよう正規化する。B = b.length。
 *
 * 依存ゼロ。Node（生ログ生成）とブラウザ（可視化）が同じファイルを読む。
 *
 * 出典（アイデアと定数のみ。コードは参照していない）:
 *   Bert Wang-Chak Chan (2019) "Lenia - Biology of Artificial Life",
 *   Complex Systems 28(3), 251-286. arXiv:1812.05433
 *
 * 語彙について: この核の側には「細胞」「生命」「生存」という語も概念も無い。
 * あるのは場・核・ポテンシャル・成長写像だけで、生物学の語は観測器の側にしか出ない。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S03 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var TAU = Math.PI * 2;

  var DEFAULTS = {
    size: 64,          // 正方トーラスの一辺
    R: 13,             // 核の半径
    T: 10,             // 1 時間単位あたりのステップ数（dt = 1/T）
    mu: 0.15,          // 成長写像の中心（制御変数）
    sigma: 0.015,      // 成長写像の幅
    rings: [1],        // 環の重み b
    alpha: 4,          // 核コアの鋭さ
    constantGrowth: null, // 数値を入れると G(U) を定数に置き換える（負コントロール）
  };

  // --------------------------------------------------------------- 乱数
  /** シードを固定すれば完全に再現する 32bit 混合乱数。 */
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // --------------------------------------------------------------- 核
  /** 環の断面形。q は環の内側 0 から外側 1 への位置。両端で 0、中央で 1。 */
  function kernelCore(q, alpha) {
    if (q <= 0 || q >= 1) return 0;
    return Math.exp(alpha - alpha / (4 * q * (1 - q)));
  }

  /**
   * 半径 R の核を組む。offsets は周期パディング済み配列に対する線形オフセット。
   * @returns {{R,rings,alpha,dx,dy,weights,offsets,sumSq,count,pad}}
   */
  function buildKernel(R, rings, alpha, size) {
    var B = rings.length;
    var dxs = [], dys = [], ws = [], total = 0;
    for (var dy = -R; dy <= R; dy++) {
      for (var dx = -R; dx <= R; dx++) {
        var r = Math.sqrt(dx * dx + dy * dy) / R;
        if (r >= 1) continue;
        var t = r * B;
        var i = Math.floor(t);
        if (i >= B) i = B - 1;
        var w = rings[i] * kernelCore(t - i, alpha);
        if (!(w > 0)) continue;
        dxs.push(dx); dys.push(dy); ws.push(w); total += w;
      }
    }
    var n = ws.length;
    var weights = new Float64Array(n);
    var sumSq = 0;
    for (var k = 0; k < n; k++) { weights[k] = ws[k] / total; sumSq += weights[k] * weights[k]; }

    var M = size + 2 * R;
    var offsets = new Int32Array(n);
    for (var j = 0; j < n; j++) offsets[j] = dys[j] * M + dxs[j];

    return {
      R: R, rings: rings, alpha: alpha, size: size, padSide: M,
      dx: Int32Array.from(dxs), dy: Int32Array.from(dys),
      weights: weights, offsets: offsets, sumSq: sumSq, count: n,
    };
  }

  /** 核を (2R+1)^2 の正方画像として取り出す（可視化用）。 */
  function kernelImage(kernel) {
    var R = kernel.R, side = 2 * R + 1;
    var img = new Float64Array(side * side);
    var max = 0;
    for (var k = 0; k < kernel.count; k++) {
      var v = kernel.weights[k];
      img[(kernel.dy[k] + R) * side + (kernel.dx[k] + R)] = v;
      if (v > max) max = v;
    }
    return { side: side, data: img, max: max };
  }

  // --------------------------------------------------------------- 状態
  function createState(opts) {
    var p = {};
    Object.keys(DEFAULTS).forEach(function (k) { p[k] = DEFAULTS[k]; });
    Object.keys(opts || {}).forEach(function (k) { if (opts[k] !== undefined) p[k] = opts[k]; });
    if (p.R * 2 >= p.size) throw new Error('核の直径が世界より大きい: R=' + p.R + ' size=' + p.size);

    var n = p.size * p.size;
    var M = p.size + 2 * p.R;
    return {
      params: p,
      size: p.size,
      n: n,
      A: new Float64Array(n),
      U: new Float64Array(n),
      pad: new Float64Array(M * M),
      padSide: M,
      kernel: buildKernel(p.R, p.rings, p.alpha, p.size),
      step: 0,
    };
  }

  /** params を差し替えて核を組み直す（mu / sigma の変更は核に影響しない）。 */
  function setParams(state, patch) {
    var p = state.params;
    var rebuild = false;
    Object.keys(patch || {}).forEach(function (k) {
      if (patch[k] === undefined) return;
      if ((k === 'R' || k === 'rings' || k === 'alpha') && patch[k] !== p[k]) rebuild = true;
      p[k] = patch[k];
    });
    if (rebuild) state.kernel = buildKernel(p.R, p.rings, p.alpha, p.size);
    return state;
  }

  // --------------------------------------------------------- 畳み込み
  /** 場を周期パディング済み配列へ写す。以降のオフセット加算は剰余演算を要しない。 */
  function fillPad(state) {
    var size = state.size, R = state.params.R, M = state.padSide;
    var A = state.A, pad = state.pad;
    for (var py = 0; py < M; py++) {
      var sy = (py - R) % size; if (sy < 0) sy += size;
      var srcRow = sy * size, dstRow = py * M;
      for (var px = 0; px < M; px++) {
        var sx = (px - R) % size; if (sx < 0) sx += size;
        pad[dstRow + px] = A[srcRow + sx];
      }
    }
  }

  /** U = K * A。周期パディング + オフセット表による経路（本番はこちら）。 */
  function convolve(state) {
    fillPad(state);
    var size = state.size, R = state.params.R, M = state.padSide;
    var pad = state.pad, U = state.U;
    var w = state.kernel.weights, off = state.kernel.offsets, cnt = state.kernel.count;
    for (var y = 0; y < size; y++) {
      var rowBase = (y + R) * M + R;
      var outRow = y * size;
      for (var x = 0; x < size; x++) {
        var base = rowBase + x;
        var s = 0;
        for (var k = 0; k < cnt; k++) s += w[k] * pad[base + off[k]];
        U[outRow + x] = s;
      }
    }
    return U;
  }

  /**
   * U = K * A を剰余演算による素朴な二重ループで求める（検算用の遅い経路）。
   * 高速経路と一致しなければ、パディングか巻き込みのどちらかが壊れている。
   */
  function convolveNaive(state) {
    var size = state.size, A = state.A, kn = state.kernel;
    var out = new Float64Array(size * size);
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        var s = 0;
        for (var k = 0; k < kn.count; k++) {
          var sx = (x + kn.dx[k]) % size; if (sx < 0) sx += size;
          var sy = (y + kn.dy[k]) % size; if (sy < 0) sy += size;
          s += kn.weights[k] * A[sy * size + sx];
        }
        out[y * size + x] = s;
      }
    }
    return out;
  }

  // --------------------------------------------------------- 成長と更新
  function growth(u, mu, sigma) {
    var d = (u - mu) / sigma;
    return 2 * Math.exp(-0.5 * d * d) - 1;
  }

  /** 1 ステップ進める。A <- clip(A + G(U)/T, 0, 1)。 */
  function stepState(state) {
    var p = state.params;
    convolve(state);
    var A = state.A, U = state.U, dt = 1 / p.T;
    var cg = p.constantGrowth;
    for (var i = 0; i < state.n; i++) {
      var g = (cg === null || cg === undefined) ? growth(U[i], p.mu, p.sigma) : cg;
      var v = A[i] + dt * g;
      A[i] = v < 0 ? 0 : (v > 1 ? 1 : v);
    }
    state.step++;
    return state;
  }

  /** 全ゼロは厳密な吸収状態（G(0) < 0 かつ下端で切り詰められる）。 */
  function isFlatZero(state) {
    for (var i = 0; i < state.n; i++) if (state.A[i] !== 0) return false;
    return true;
  }

  // --------------------------------------------------------- 初期条件
  /**
   * 模様 cells（行 x 列 の [0,1] 配列）を場の中央に置く。
   * @param {number} eps 乗法ノイズの強さ。0 なら決定論的
   */
  function placePattern(state, cells, eps, seed, cx, cy) {
    var size = state.size;
    var h = cells.length, w = cells[0].length;
    var ox = (cx === undefined ? Math.round((size - w) / 2) : cx);
    var oy = (cy === undefined ? Math.round((size - h) / 2) : cy);
    var rng = makeRng(seed === undefined ? 1 : seed);
    state.A.fill(0);
    for (var j = 0; j < h; j++) {
      for (var i = 0; i < w; i++) {
        var v = cells[j][i];
        if (eps) v = v * (1 + eps * (2 * rng() - 1));
        if (v < 0) v = 0; if (v > 1) v = 1;
        var y = (oy + j) % size; if (y < 0) y += size;
        var x = (ox + i) % size; if (x < 0) x += size;
        state.A[y * size + x] = v;
      }
    }
    state.step = 0;
    return state;
  }

  /**
   * 中央の一辺 2*half の正方領域を、一辺 block の粗い格子の一様乱数で埋める。
   * 格子点ごとの独立乱数では核のスケールに何も乗らないので、核の半分の幅で
   * 粗くする。初期パターンの出所であり、掃引の「スープの腕」でもある。
   */
  function patchSoup(state, seed, half, block) {
    var size = state.size;
    var b = block || Math.max(2, Math.round(state.params.R / 2));
    var rng = makeRng(seed);
    var c = size / 2, lo = Math.round(c - half), hi = Math.round(c + half);
    var coarse = Object.create(null);
    state.A.fill(0);
    for (var y = lo; y < hi; y++) {
      for (var x = lo; x < hi; x++) {
        var k = Math.floor(y / b) + '_' + Math.floor(x / b);
        if (coarse[k] === undefined) coarse[k] = rng();
        var yy = ((y % size) + size) % size, xx = ((x % size) + size) % size;
        state.A[yy * size + xx] = coarse[k];
      }
    }
    state.step = 0;
    return state;
  }

  /**
   * 場のうち閾値を超える部分の外接矩形を切り出して、行 x 列 の配列にする。
   * 落ち着いた模様を初期パターンとして固定するために使う。
   */
  function cropPattern(state, threshold, digits) {
    var size = state.size, A = state.A;
    var th = threshold === undefined ? 1e-3 : threshold;
    var d = digits === undefined ? 4 : digits;
    var minX = size, maxX = -1, minY = size, maxY = -1;
    for (var y = 0; y < size; y++) {
      for (var x = 0; x < size; x++) {
        if (A[y * size + x] > th) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return [];
    var pow = Math.pow(10, d);
    var rows = [];
    for (var j = minY; j <= maxY; j++) {
      var row = [];
      for (var i = minX; i <= maxX; i++) row.push(Math.round(A[j * size + i] * pow) / pow);
      rows.push(row);
    }
    return rows;
  }

  /** 各格子点を独立な一様乱数で埋める（負コントロール・スープの腕）。 */
  function fillUniformRandom(state, seed, lo, hi) {
    var rng = makeRng(seed);
    var a = lo === undefined ? 0 : lo, b = hi === undefined ? 1 : hi;
    for (var i = 0; i < state.n; i++) state.A[i] = a + (b - a) * rng();
    state.step = 0;
    return state;
  }

  /** 場の格子点を空間的にシャッフルする。質量と値の分布は不変、配置だけ壊れる。 */
  function shuffleField(state, seed) {
    var rng = makeRng(seed);
    var A = state.A;
    for (var i = state.n - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var t = A[i]; A[i] = A[j]; A[j] = t;
    }
    state.step = 0;
    return state;
  }

  // ------------------------------------------------------------- 観測器
  //
  // ここから先だけが「維持されている」「生きている」を語ってよい。
  // 上の核はそれらの語を一つも持たない。

  function mass(state) {
    var s = 0;
    for (var i = 0; i < state.n; i++) s += state.A[i];
    return s;
  }

  /** トーラス上の質量重心（円周平均）。 */
  function centroid(state) {
    var size = state.size, A = state.A;
    var sx = 0, cxs = 0, sy = 0, cys = 0, m = 0;
    for (var y = 0; y < size; y++) {
      var ay = (TAU * y) / size, sinY = Math.sin(ay), cosY = Math.cos(ay);
      for (var x = 0; x < size; x++) {
        var v = A[y * size + x];
        if (v === 0) continue;
        var ax = (TAU * x) / size;
        sx += v * Math.sin(ax); cxs += v * Math.cos(ax);
        sy += v * sinY; cys += v * cosY;
        m += v;
      }
    }
    if (m === 0) return { x: 0, y: 0, mass: 0 };
    var px = (Math.atan2(sx, cxs) / TAU) * size; if (px < 0) px += size;
    var py = (Math.atan2(sy, cys) / TAU) * size; if (py < 0) py += size;
    return { x: px, y: py, mass: m };
  }

  function wrapDelta(d, size) {
    d = d % size;
    if (d > size / 2) d -= size;
    if (d < -size / 2) d += size;
    return d;
  }

  /**
   * 主の秩序変数 kernelExcess とその材料。
   *
   *   kernelExcess = Var(K*A) / (Var(A) * sum K^2)
   *
   * 空間相関を持たない場（各格子点が独立同分布）では分子と分母が厳密に等しく、
   * **理論的な帰無値はちょうど 1.0** になる。測る幅は核そのもの——モデルの定義に
   * 含まれているので、解析側が選ぶ自由なスケールを持たない（method.md K-10）。
   *
   * 場が一様（絶滅 A≡0 または飽和 A≡1）だと Var(A) = 0 で定義できない。
   * その場合は fieldFlat を立て、構造なしと扱う。
   */
  function kernelExcess(state) {
    convolve(state);
    var n = state.n, A = state.A, U = state.U;
    var sa = 0, sa2 = 0, su = 0, su2 = 0;
    for (var i = 0; i < n; i++) {
      sa += A[i]; sa2 += A[i] * A[i];
      su += U[i]; su2 += U[i] * U[i];
    }
    var ma = sa / n, mu2 = su / n;
    var va = Math.max(0, sa2 / n - ma * ma);
    var vu = Math.max(0, su2 / n - mu2 * mu2);
    var flat = va < 1e-12;
    return {
      fieldFlat: flat,
      varField: va,
      varPotential: vu,
      sumKernelSq: state.kernel.sumSq,
      predictedVarPotential: va * state.kernel.sumSq,
      kernelExcess: flat ? null : vu / (va * state.kernel.sumSq),
    };
  }

  /**
   * |sum dA| / sum |dA|。dA は**切り詰めた後の実効的な変化量**
   * clip(A + G(U)/T) - A である。
   *
   * 場全体で dA の符号が一定なら（純粋な減衰／純粋な増大）厳密に 1.0 になり、
   * 生成と消滅が釣り合うほど 0 に近づく。分母は総取引量、分子は正味の増減。
   *
   * **生の G(U) を使ってはいけない**。局在した模様のまわりの空の領域では U=0 で
   * G(0) ≈ -1 だが A は既に 0 に張り付いていて何も起きない。生の G で測ると
   * この「何も起きていない背景」が総和を支配し、どんな模様でも 0.96 付近を返す
   * （2026-09-11、本番を走らせる前の予備観測でこの欠陥が出た）。
   */
  function growthBalance(state) {
    var p = state.params, dt = 1 / p.T;
    var A = state.A, U = state.U;
    var signed = 0, abs = 0;
    for (var i = 0; i < state.n; i++) {
      var g = (p.constantGrowth === null || p.constantGrowth === undefined)
        ? growth(U[i], p.mu, p.sigma) : p.constantGrowth;
      var v = A[i] + dt * g;
      var d = (v < 0 ? 0 : (v > 1 ? 1 : v)) - A[i];
      signed += d; abs += Math.abs(d);
    }
    return abs === 0 ? 0 : Math.abs(signed) / abs;
  }

  /** ある瞬間の観測をまとめる。 */
  function measure(state) {
    var ke = kernelExcess(state);      // 内部で convolve 済み
    var m = 0, support = 0, maxV = 0;
    for (var i = 0; i < state.n; i++) {
      var v = state.A[i];
      m += v;
      if (v > 0.01) support++;
      if (v > maxV) maxV = v;
    }
    var c = centroid(state);
    return {
      step: state.step,
      mass: m,
      meanField: m / state.n,
      maxField: maxV,
      support: support,
      supportFraction: support / state.n,
      varField: ke.varField,
      varPotential: ke.varPotential,
      predictedVarPotential: ke.predictedVarPotential,
      kernelExcess: ke.kernelExcess,
      fieldFlat: ke.fieldFlat,
      growthBalance: growthBalance(state),
      centroidX: c.x,
      centroidY: c.y,
    };
  }

  // ------------------------------------------------------------- 走らせる
  /**
   * 1 レプリケートを回し、事前登録した時間窓ごとの観測を返す。
   *
   * @param {object} opts     createState への設定
   * @param {function} init   init(state) が初期条件を作る
   * @param {object} plan     {steps, windows:[..], balanceWindow, traceEvery, centroidEvery}
   *
   * **重心の道のりは固定の間隔で測る**（既定 10 ステップごと）。観測の都合で
   * 間隔が変わると道のりの値も変わってしまうため、trace を残すかどうかや
   * balance の窓に入ったかどうかとは切り離してある
   * （2026-09-11、1 回目の本番でシードごとに間隔が違い、道のりの平均が
   * 腕ごとに 200 対 283 と食い違ったことでこの取り違えが露見した）。
   */
  function runReplicate(opts, init, plan) {
    var state = createState(opts);
    init(state);
    var m0 = mass(state);
    var c0 = centroid(state);

    var steps = plan.steps;
    var windows = plan.windows || [steps];
    var balanceWindow = plan.balanceWindow || 50;
    var centroidEvery = plan.centroidEvery || 10;
    var atWindow = {};
    var trace = [];
    var balances = [];
    var pathLength = 0;
    var pathSamples = 0;
    var prev = c0;
    var stopped = null;

    for (var t = 1; t <= steps; t++) {
      stepState(state);
      var needMeasure = windows.indexOf(t) >= 0;
      var needTrace = plan.traceEvery && t % plan.traceEvery === 0;
      var needBalance = t > steps - balanceWindow;

      if (t % centroidEvery === 0) {
        var c = centroid(state);
        var dx = wrapDelta(c.x - prev.x, state.size);
        var dy = wrapDelta(c.y - prev.y, state.size);
        if (c.mass > 0 && prev.mass > 0) { pathLength += Math.sqrt(dx * dx + dy * dy); pathSamples++; }
        prev = c;
      }

      if (needMeasure || needTrace || needBalance) {
        var mm = measure(state);
        if (needBalance) balances.push(mm.growthBalance);
        if (needMeasure) atWindow[t] = mm;
        if (needTrace) {
          trace.push({ step: t, mass: mm.mass, kernelExcess: mm.kernelExcess,
            support: mm.support, growthBalance: mm.growthBalance, maxField: mm.maxField,
            centroidX: mm.centroidX, centroidY: mm.centroidY });
        }
      }

      if (t % 10 === 0 && isFlatZero(state)) { stopped = t; break; }
    }

    // 打ち切った場合、残りの窓は「全ゼロの場」の観測で埋める（吸収状態なので厳密）
    var final = measure(state);
    for (var wI = 0; wI < windows.length; wI++) {
      if (!atWindow[windows[wI]]) atWindow[windows[wI]] = final;
    }

    var netX = wrapDelta(final.centroidX - c0.x, state.size);
    var netY = wrapDelta(final.centroidY - c0.y, state.size);

    return {
      state: state,
      initialMass: m0,
      stoppedAt: stopped,
      stepsRun: state.step,
      atWindow: atWindow,
      final: final,
      trace: trace,
      meanGrowthBalance: balances.length ? balances.reduce(function (a, b) { return a + b; }, 0) / balances.length : final.growthBalance,
      pathLength: pathLength,
      pathSamples: pathSamples,
      // 単位時間あたりの重心の進み（格子／時間単位）。間隔に依存しない量にしてある
      speed: pathSamples > 0 ? pathLength / (pathSamples * centroidEvery / state.params.T) : 0,
      netDisplacement: Math.sqrt(netX * netX + netY * netY),
    };
  }

  /** 事前登録した判定。criteria.json の verdict.rule をそのまま実装する。 */
  function verdict(rep, window, band, excessThreshold) {
    var mm = rep.atWindow[window] || rep.final;
    var ratio = rep.initialMass > 0 ? mm.mass / rep.initialMass : 0;
    var inBand = ratio >= band[0] && ratio <= band[1];
    var structured = !mm.fieldFlat && mm.kernelExcess !== null && mm.kernelExcess >= excessThreshold;
    return { massRatio: ratio, inBand: inBand, structured: structured, selfMaintaining: inBand && structured };
  }

  return {
    DEFAULTS: DEFAULTS,
    makeRng: makeRng,
    kernelCore: kernelCore,
    buildKernel: buildKernel,
    kernelImage: kernelImage,
    createState: createState,
    setParams: setParams,
    convolve: convolve,
    convolveNaive: convolveNaive,
    growth: growth,
    stepState: stepState,
    isFlatZero: isFlatZero,
    placePattern: placePattern,
    patchSoup: patchSoup,
    cropPattern: cropPattern,
    fillUniformRandom: fillUniformRandom,
    shuffleField: shuffleField,
    mass: mass,
    centroid: centroid,
    kernelExcess: kernelExcess,
    growthBalance: growthBalance,
    measure: measure,
    runReplicate: runReplicate,
    verdict: verdict,
  };
});
