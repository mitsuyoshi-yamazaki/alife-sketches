/**
 * S-52 核 — d 次元（既定 4）トーラス上の点集合の時間発展だけ。
 *
 * 上位概念（cell / membrane / gene / organism / catalyst / fitness / alive 等）は無い。
 * ここにあるのは「座標」「速度」「近傍」「操舵」という力学の語彙だけである
 * （群れ規則という言葉自体は Reynolds 1987 の用語であり、生物学の語彙ではない）。
 * 写し方（正射影・透視・断面・チャネル）・描画・復号・観測量は observer.js に置く
 * （あちらは「どう測るか」を持つので、この核とは別にする）。
 *
 * 依存ゼロ・古典スクリプト。Node（module.exports）とブラウザ（window.S52）で共用する。
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- 乱数・状態ハッシュ（S-49 と同じ mulberry32）

  /** mulberry32。シードを固定すれば完全に再現する。 */
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

  /** FNV-1a 32bit を、全個体の位置・速度（4軸×2）の生バイト列にかける（K-36）。 */
  function hashState(state) {
    var n = state.count, dims = 4;
    var buf = new Float64Array(n * dims * 2);
    var k = 0;
    for (var i = 0; i < n; i++) {
      for (var a = 0; a < dims; a++) buf[k++] = state.pos[a][i];
      for (var a2 = 0; a2 < dims; a2++) buf[k++] = state.vel[a2][i];
    }
    var bytes = new Uint8Array(buf.buffer);
    var h = 0x811c9dc5;
    for (var j = 0; j < bytes.length; j++) { h ^= bytes[j]; h = Math.imul(h, 0x01000193) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  /** ラスタ（Uint8Array）にも同じハッシュをかける（描画の再現性を独立に見る）。 */
  function hashBytes(bytes) {
    var h = 0x811c9dc5;
    for (var j = 0; j < bytes.length; j++) { h ^= bytes[j]; h = Math.imul(h, 0x01000193) >>> 0; }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  // ---------------------------------------------------------------- トーラス幾何（d 次元、軸配列で表す）

  function wrapL(x, L) { var m = x % L; return m < 0 ? m + L : m; }

  /** b-a の最近接鏡像変位（[-L/2, L/2) に丸めた差）。 */
  function deltaWrap(d, L) { return d - L * Math.round(d / L); }

  /** 周期境界上の円周平均（sliceCenter・回転の中心に使う。systemParameters.box の登録どおり）。 */
  function circularMean(values, L) {
    var sx = 0, sy = 0, n = values.length;
    for (var i = 0; i < n; i++) {
      var th = values[i] / L * 2 * Math.PI;
      sx += Math.cos(th); sy += Math.sin(th);
    }
    var mth = Math.atan2(sy / n, sx / n);
    if (mth < 0) mth += 2 * Math.PI;
    return mth / (2 * Math.PI) * L;
  }

  // ---------------------------------------------------------------- 状態の生成

  /**
   * N 個体を d 次元トーラス [0,L)^d に一様に撒き、速度は等方ランダム方向 × 一様な速さ。
   * dims<4 の軸（例: NC4 の w）は位置 0.5L・速度 0 に固定する（力学から d 次元でないことを表す）。
   */
  function makeState(seed, N, L, dims, speedRange) {
    var rnd = rng(seed);
    var pos = [new Float64Array(N), new Float64Array(N), new Float64Array(N), new Float64Array(N)];
    var vel = [new Float64Array(N), new Float64Array(N), new Float64Array(N), new Float64Array(N)];
    for (var i = 0; i < N; i++) {
      for (var a = 0; a < 4; a++) pos[a][i] = a < dims ? rnd() * L : 0.5 * L;
      // 等方ランダム方向: dims 次元の正規乱数を作って正規化する（Box-Muller）
      var g = [];
      for (var b = 0; b < dims; b++) {
        var u1 = Math.max(rnd(), 1e-12), u2 = rnd();
        g.push(Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
      }
      var norm = Math.sqrt(g.reduce(function (s, v) { return s + v * v; }, 0)) || 1;
      var speed = speedRange[0] + rnd() * (speedRange[1] - speedRange[0]);
      for (var c = 0; c < 4; c++) vel[c][i] = c < dims ? (g[c] / norm) * speed : 0;
    }
    return { pos: pos, vel: vel, count: N, dims: dims, L: L };
  }

  function cloneState(state) {
    return {
      pos: state.pos.map(function (a) { return Float64Array.from(a); }),
      vel: state.vel.map(function (a) { return Float64Array.from(a); }),
      count: state.count, dims: state.dims, L: state.L,
    };
  }

  /**
   * 参照点 RP3（二重回転）: 群れ重心のまわりに xy 面・zw 面の独立な回転速度を重ね合わせる。
   * 角速度比 1:1.618（golden ratio。等傾斜にしないための非対称な選び方——_comment (c) の登録どおり）。
   * omegaXY を基準に omegaZW = omegaXY / 1.618 とする。
   */
  function addDoubleRotation(state, omegaXY) {
    var omegaZW = omegaXY / 1.618033988749895;
    var L = state.L, N = state.count;
    var cx = circularMean(state.pos[0], L), cy = circularMean(state.pos[1], L);
    var cz = circularMean(state.pos[2], L), cw = circularMean(state.pos[3], L);
    for (var i = 0; i < N; i++) {
      var rx = deltaWrap(state.pos[0][i] - cx, L), ry = deltaWrap(state.pos[1][i] - cy, L);
      var rz = deltaWrap(state.pos[2][i] - cz, L), rw = deltaWrap(state.pos[3][i] - cw, L);
      // xy 面の回転: (x,y) -> (x,y) + omega*(-y,x)。zw 面: (z,w) -> (z,w) + omega*(-w,z)
      state.vel[0][i] += omegaXY * (-ry);
      state.vel[1][i] += omegaXY * (rx);
      state.vel[2][i] += omegaZW * (-rw);
      state.vel[3][i] += omegaZW * (rz);
    }
  }

  // ---------------------------------------------------------------- 群れ規則（分離・整列・結合。次元に依らず書く）

  /**
   * 1ステップぶんの操舵加速度を計算する。近傍探索は state.dims 次元の距離だけを使う
   * （NC4 は 3 次元の力学なので、探索も 3 次元にする——4次元のパイプラインへ通すのは描画側だけ）。
   * 分離の斥力は 1/r（Reynolds の元の形。指数を次元で変えない——_comment (d) の登録どおり）。
   * weights が {sep:0,ali:0,coh:0} なら NC1（駆動を切った系）になる。
   */
  function steerAccel(state, params) {
    var N = state.count, dims = state.dims, L = state.L;
    var rSep2 = params.rSep * params.rSep, rAli2 = params.rAli * params.rAli, rCoh2 = params.rCoh * params.rCoh;
    var out = [new Float64Array(N), new Float64Array(N), new Float64Array(N), new Float64Array(N)];
    var d = new Array(4);
    for (var i = 0; i < N; i++) {
      var sep = [0, 0, 0, 0], aliSum = [0, 0, 0, 0], cohSum = [0, 0, 0, 0];
      var nAli = 0, nCoh = 0;
      for (var j = 0; j < N; j++) {
        if (j === i) continue;
        var r2 = 0;
        for (var a = 0; a < dims; a++) { d[a] = deltaWrap(state.pos[a][i] - state.pos[a][j], L); r2 += d[a] * d[a]; }
        if (r2 < rSep2 && params.wSep > 0) {
          var r = Math.sqrt(r2) || 1e-6;
          for (var a2 = 0; a2 < dims; a2++) sep[a2] += d[a2] / (r * r); // 単位ベクトル(d/r) × 1/r
        }
        if (r2 < rAli2 && params.wAli > 0) { for (var a3 = 0; a3 < dims; a3++) aliSum[a3] += state.vel[a3][j]; nAli++; }
        if (r2 < rCoh2 && params.wCoh > 0) { for (var a4 = 0; a4 < dims; a4++) cohSum[a4] += -d[a4]; nCoh++; } // -d = pos_j - pos_i の最近接
      }
      for (var b = 0; b < dims; b++) {
        var ali = nAli > 0 ? (aliSum[b] / nAli - state.vel[b][i]) : 0;
        var coh = nCoh > 0 ? (cohSum[b] / nCoh) : 0;
        out[b][i] = params.wSep * sep[b] + params.wAli * ali + params.wCoh * coh;
      }
    }
    return out;
  }

  /** クリップ [lo,hi] に速さを収める（方向は保つ。速さ0はまれな縮退なので方向をx軸へ既定）。 */
  function clipSpeed(state, lo, hi) {
    var N = state.count, dims = state.dims;
    for (var i = 0; i < N; i++) {
      var s2 = 0;
      for (var a = 0; a < dims; a++) s2 += state.vel[a][i] * state.vel[a][i];
      var s = Math.sqrt(s2);
      if (s < 1e-9) { state.vel[0][i] = lo; continue; }
      var target = s < lo ? lo : (s > hi ? hi : s);
      var k = target / s;
      for (var a2 = 0; a2 < dims; a2++) state.vel[a2][i] *= k;
    }
  }

  /** 1ステップ進める（操舵 → 速さクリップ → 位置更新。dt=1・無次元。破壊的）。 */
  function step(state, params) {
    var accel = steerAccel(state, params);
    var N = state.count, dims = state.dims, L = state.L;
    for (var a = 0; a < dims; a++) {
      for (var i = 0; i < N; i++) state.vel[a][i] += params.gain * accel[a][i];
    }
    clipSpeed(state, params.speedMin, params.speedMax);
    for (var a2 = 0; a2 < dims; a2++) {
      for (var i2 = 0; i2 < N; i2++) state.pos[a2][i2] = wrapL(state.pos[a2][i2] + state.vel[a2][i2], L);
    }
  }

  /** 整列秩序 φ = |⟨v⟩|/⟨|v|⟩（dims 次元）。controlTimescale の定常判定に使う。 */
  function alignmentOrder(state) {
    var N = state.count, dims = state.dims;
    var sum = new Array(dims).fill(0), sumSpeed = 0;
    for (var i = 0; i < N; i++) {
      var s2 = 0;
      for (var a = 0; a < dims; a++) { sum[a] += state.vel[a][i]; s2 += state.vel[a][i] * state.vel[a][i]; }
      sumSpeed += Math.sqrt(s2);
    }
    var m2 = sum.reduce(function (s, v) { return s + v * v; }, 0);
    return sumSpeed > 0 ? Math.sqrt(m2) / sumSpeed : 0;
  }

  // ---------------------------------------------------------------- RP4: 構造の無い一様等方4次元ガス（球内・反射）

  /** 半径 R の d 次元球内に一様に撒く（棄却法）。等方速度・一様な速さ（同じ speedRange）。 */
  function makeGasState(seed, N, R, speedRange) {
    var rnd = rng(seed);
    var pos = [new Float64Array(N), new Float64Array(N), new Float64Array(N), new Float64Array(N)];
    var vel = [new Float64Array(N), new Float64Array(N), new Float64Array(N), new Float64Array(N)];
    var center = 0.5; // 箱の中心と同じ座標系に置く（描画パイプラインを共用するため。中心を [L/2]^4 とする）
    for (var i = 0; i < N; i++) {
      var p;
      for (;;) {
        p = [rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1, rnd() * 2 - 1];
        if (p[0] * p[0] + p[1] * p[1] + p[2] * p[2] + p[3] * p[3] <= 1) break;
      }
      for (var a = 0; a < 4; a++) pos[a][i] = center + p[a] * R;
      var g = [];
      for (var b = 0; b < 4; b++) {
        var u1 = Math.max(rnd(), 1e-12), u2 = rnd();
        g.push(Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2));
      }
      var norm = Math.sqrt(g.reduce(function (s, v) { return s + v * v; }, 0)) || 1;
      var speed = speedRange[0] + rnd() * (speedRange[1] - speedRange[0]);
      for (var c = 0; c < 4; c++) vel[c][i] = (g[c] / norm) * speed;
    }
    return { pos: pos, vel: vel, count: N, dims: 4, L: 1, gas: true, R: R, center: center };
  }

  /** ガスの1ステップ: 直進 + 球面での鏡面反射（周期境界は使わない。RP4 の登録どおり）。 */
  function stepGas(state) {
    var N = state.count, R = state.R, c = state.center;
    for (var i = 0; i < N; i++) {
      for (var a = 0; a < 4; a++) state.pos[a][i] += state.vel[a][i];
      var r2 = 0, d = [0, 0, 0, 0];
      for (var a2 = 0; a2 < 4; a2++) { d[a2] = state.pos[a2][i] - c; r2 += d[a2] * d[a2]; }
      if (r2 > R * R) {
        var r = Math.sqrt(r2);
        // 球面上に戻し、法線方向の速度成分を反転する
        var nrm = d.map(function (v) { return v / r; });
        for (var a3 = 0; a3 < 4; a3++) state.pos[a3][i] = c + nrm[a3] * R;
        var vDotN = 0;
        for (var a4 = 0; a4 < 4; a4++) vDotN += state.vel[a4][i] * nrm[a4];
        for (var a5 = 0; a5 < 4; a5++) state.vel[a5][i] -= 2 * vDotN * nrm[a5];
      }
    }
  }

  /** 生存の検算（K-30）: 個体数が期待どおりで、すべての値が有限か。 */
  function stateHealthy(state, expectedCount) {
    if (state.count !== expectedCount) return false;
    for (var a = 0; a < 4; a++) {
      for (var i = 0; i < state.count; i++) {
        if (!isFinite(state.pos[a][i]) || !isFinite(state.vel[a][i])) return false;
      }
    }
    return true;
  }

  /** 速度共分散の参与次元 D_p = (Σλ)²/Σλ²（O6。記述量、判定には使わない）。 */
  function participationDimension(state) {
    var N = state.count, dims = 4;
    var mean = [0, 0, 0, 0];
    for (var a = 0; a < dims; a++) { for (var i = 0; i < N; i++) mean[a] += state.vel[a][i]; mean[a] /= N; }
    var cov = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    for (var i2 = 0; i2 < N; i2++) {
      var dv = [0, 0, 0, 0];
      for (var a2 = 0; a2 < dims; a2++) dv[a2] = state.vel[a2][i2] - mean[a2];
      for (var r = 0; r < dims; r++) for (var c = 0; c < dims; c++) cov[r][c] += dv[r] * dv[c];
    }
    for (var r2 = 0; r2 < dims; r2++) for (var c2 = 0; c2 < dims; c2++) cov[r2][c2] /= N;
    var lambda = jacobiEigenvaluesSym4(cov);
    var s1 = lambda.reduce(function (s, v) { return s + Math.max(v, 0); }, 0);
    var s2 = lambda.reduce(function (s, v) { return s + Math.max(v, 0) * Math.max(v, 0); }, 0);
    return s2 > 1e-18 ? (s1 * s1) / s2 : 1;
  }

  /** 4x4 実対称行列の固有値（Jacobi 法。依存ゼロで足りる程度の小さい実装）。 */
  function jacobiEigenvaluesSym4(Ain) {
    var n = 4;
    var A = Ain.map(function (row) { return row.slice(); });
    for (var sweep = 0; sweep < 60; sweep++) {
      var off = 0;
      for (var p = 0; p < n; p++) for (var q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
      if (off < 1e-24) break;
      for (var p2 = 0; p2 < n; p2++) {
        for (var q2 = p2 + 1; q2 < n; q2++) {
          if (Math.abs(A[p2][q2]) < 1e-18) continue;
          var theta = (A[q2][q2] - A[p2][p2]) / (2 * A[p2][q2]);
          var t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
          var cph = 1 / Math.sqrt(t * t + 1), sph = t * cph;
          var App = A[p2][p2], Aqq = A[q2][q2], Apq = A[p2][q2];
          A[p2][p2] = cph * cph * App - 2 * sph * cph * Apq + sph * sph * Aqq;
          A[q2][q2] = sph * sph * App + 2 * sph * cph * Apq + cph * cph * Aqq;
          A[p2][q2] = 0; A[q2][p2] = 0;
          for (var k = 0; k < n; k++) {
            if (k === p2 || k === q2) continue;
            var Akp = A[k][p2], Akq = A[k][q2];
            A[k][p2] = cph * Akp - sph * Akq; A[p2][k] = A[k][p2];
            A[k][q2] = sph * Akp + cph * Akq; A[q2][k] = A[k][q2];
          }
        }
      }
    }
    return [A[0][0], A[1][1], A[2][2], A[3][3]];
  }

  var api = {
    rng: rng, hashState: hashState, hashBytes: hashBytes,
    wrapL: wrapL, deltaWrap: deltaWrap, circularMean: circularMean,
    makeState: makeState, cloneState: cloneState, addDoubleRotation: addDoubleRotation,
    steerAccel: steerAccel, clipSpeed: clipSpeed, step: step, alignmentOrder: alignmentOrder,
    makeGasState: makeGasState, stepGas: stepGas,
    stateHealthy: stateHealthy, participationDimension: participationDimension,
    jacobiEigenvaluesSym4: jacobiEigenvaluesSym4,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.S52 = api;
  if (typeof global !== 'undefined' && global && !global.S52) global.S52 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
