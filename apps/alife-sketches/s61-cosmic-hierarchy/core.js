'use strict';
/**
 * S-61 核。膨張する Einstein–de Sitter 宇宙の共動座標で、粒子メッシュ法（PM）により
 * 重力だけで発展する等質量粒子の周期箱。
 *
 * 核が持つ語彙: 粒子の位置・運動量・質量、密度、ポテンシャル、力、スケール因子 a、背景の膨張。
 * **上位の単位（ハロー・部分ハロー・群・糸・壁等）は一度も現れない**——criteria.json の禁則どおり。
 * それらは observer.js / fof.js / subfind.js / web.js（検出器の側）だけが持つ語彙である。
 *
 * Node と ブラウザの両方で使う（UMD）。依存ゼロ（fft.js だけを使う）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./fft.js'));
  } else {
    root.S61 = factory(root.S61FFT);
  }
})(typeof self !== 'undefined' ? self : this, function (FFT) {
  var L_BOX = 64; // 箱の一辺（Delta0単位。tierに依らず固定）
  var G = 3 / (8 * Math.PI); // 4*pi*G*rhobar = 3/2 （EdS・H0=1・rhobar=1 と整合）

  // ------------------------------------------------------------ 乱数（seed固定・再現可能）

  /** mulberry32: 軽量・高品質な決定的PRNG。32bit seed。 */
  function makeRng(seed) {
    var s = seed >>> 0;
    return function () {
      s |= 0; s = (s + 0x6D2B79F5) | 0;
      var t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Box-Muller: rng() から標準正規乱数を1つ。 */
  function makeGaussian(rng) {
    var has = false, spare = 0;
    return function () {
      if (has) { has = false; return spare; }
      var u, v, s;
      do {
        u = rng() * 2 - 1; v = rng() * 2 - 1; s = u * u + v * v;
      } while (s === 0 || s >= 1);
      var mul = Math.sqrt(-2 * Math.log(s) / s);
      spare = v * mul; has = true;
      return u * mul;
    };
  }

  // ------------------------------------------------------------ 背景の膨張（EdS・H0=1）

  function Hoft(a) { return Math.pow(a, -1.5); }
  /** ドリフトの係数 ∫_{a0}^{a1} a^{-3/2} da = 2(a0^{-1/2} - a1^{-1/2})（厳密） */
  function driftCoef(a0, a1) { return 2 * (Math.pow(a0, -0.5) - Math.pow(a1, -0.5)); }
  /** キックの係数 ∫_{a0}^{a1} a^{1/2} da = (2/3)(a1^{3/2} - a0^{3/2})（厳密） */
  function kickCoef(a0, a1) { return (2 / 3) * (Math.pow(a1, 1.5) - Math.pow(a0, 1.5)); }

  // ------------------------------------------------------------ CIC（雲状粒子）割り当て・補間

  function wrapIdx(i, Ng) { i = i % Ng; return i < 0 ? i + Ng : i; }

  /**
   * 粒子の位置(x, 長さ3*Np)を Ng^3 格子へ CIC で割り当て、密度コントラスト delta を返す
   * （delta = 質量/セル体積/rhobar - 1、rhobar=1 なので delta = 質量/セル体積 - 1）。
   */
  function cicDensity(x, Np, m, Ng, L) {
    var h = L / Ng;
    var dens = new Float64Array(Ng * Ng * Ng);
    var Ng2 = Ng * Ng;
    var cellVol = h * h * h;
    for (var p = 0; p < Np; p++) {
      var px = x[3 * p] / h, py = x[3 * p + 1] / h, pz = x[3 * p + 2] / h;
      var ix0 = Math.floor(px), iy0 = Math.floor(py), iz0 = Math.floor(pz);
      var dx = px - ix0, dy = py - iy0, dz = pz - iz0;
      var ix1 = wrapIdx(ix0 + 1, Ng), iy1 = wrapIdx(iy0 + 1, Ng), iz1 = wrapIdx(iz0 + 1, Ng);
      ix0 = wrapIdx(ix0, Ng); iy0 = wrapIdx(iy0, Ng); iz0 = wrapIdx(iz0, Ng);
      var mass = (typeof m === 'number') ? m : m[p];
      var w = mass / cellVol;
      dens[ix0 * Ng2 + iy0 * Ng + iz0] += w * (1 - dx) * (1 - dy) * (1 - dz);
      dens[ix1 * Ng2 + iy0 * Ng + iz0] += w * dx * (1 - dy) * (1 - dz);
      dens[ix0 * Ng2 + iy1 * Ng + iz0] += w * (1 - dx) * dy * (1 - dz);
      dens[ix0 * Ng2 + iy0 * Ng + iz1] += w * (1 - dx) * (1 - dy) * dz;
      dens[ix1 * Ng2 + iy1 * Ng + iz0] += w * dx * dy * (1 - dz);
      dens[ix1 * Ng2 + iy0 * Ng + iz1] += w * dx * (1 - dy) * dz;
      dens[ix0 * Ng2 + iy1 * Ng + iz1] += w * (1 - dx) * dy * dz;
      dens[ix1 * Ng2 + iy1 * Ng + iz1] += w * dx * dy * dz;
    }
    var delta = new Float64Array(Ng * Ng * Ng);
    for (var i = 0; i < delta.length; i++) delta[i] = dens[i] - 1;
    return delta;
  }

  /** grid（Ng^3の実数場・x*Ng^2+y*Ng+zの順）を粒子位置へ CIC で補間して返す（長さNpの配列）。 */
  function cicInterpolate(grid, Ng, L, x, Np) {
    var h = L / Ng;
    var Ng2 = Ng * Ng;
    var out = new Float64Array(Np);
    for (var p = 0; p < Np; p++) {
      var px = x[3 * p] / h, py = x[3 * p + 1] / h, pz = x[3 * p + 2] / h;
      var ix0 = Math.floor(px), iy0 = Math.floor(py), iz0 = Math.floor(pz);
      var dx = px - ix0, dy = py - iy0, dz = pz - iz0;
      var ix1 = wrapIdx(ix0 + 1, Ng), iy1 = wrapIdx(iy0 + 1, Ng), iz1 = wrapIdx(iz0 + 1, Ng);
      ix0 = wrapIdx(ix0, Ng); iy0 = wrapIdx(iy0, Ng); iz0 = wrapIdx(iz0, Ng);
      out[p] =
        grid[ix0 * Ng2 + iy0 * Ng + iz0] * (1 - dx) * (1 - dy) * (1 - dz) +
        grid[ix1 * Ng2 + iy0 * Ng + iz0] * dx * (1 - dy) * (1 - dz) +
        grid[ix0 * Ng2 + iy1 * Ng + iz0] * (1 - dx) * dy * (1 - dz) +
        grid[ix0 * Ng2 + iy0 * Ng + iz1] * (1 - dx) * (1 - dy) * dz +
        grid[ix1 * Ng2 + iy1 * Ng + iz0] * dx * dy * (1 - dz) +
        grid[ix1 * Ng2 + iy0 * Ng + iz1] * dx * (1 - dy) * dz +
        grid[ix0 * Ng2 + iy1 * Ng + iz1] * (1 - dx) * dy * dz +
        grid[ix1 * Ng2 + iy1 * Ng + iz1] * dx * dy * dz;
    }
    return out;
  }

  // ------------------------------------------------------------ ポアソン解法（PM）

  /**
   * delta（実空間の密度コントラスト・Ng^3）から φ（実空間・Ng^3）を返す。
   * ∇²φ = (3/(2a))·δ を、7点差分のラプラシアンの固有値 k_eff² を使った周期グリーン関数で解く。
   */
  function poissonSolve(delta, Ng, L, a) {
    var h = L / Ng;
    var re = new Float64Array(delta), im = new Float64Array(Ng * Ng * Ng);
    FFT.fft3d(re, im, Ng, false);
    var Ng2 = Ng * Ng;
    var src = 3 / (2 * a);
    for (var ix = 0; ix < Ng; ix++) {
      var kx = 2 * Math.PI * FFT.freqIndex(ix, Ng) / L;
      for (var iy = 0; iy < Ng; iy++) {
        var ky = 2 * Math.PI * FFT.freqIndex(iy, Ng) / L;
        for (var iz = 0; iz < Ng; iz++) {
          var idx = ix * Ng2 + iy * Ng + iz;
          if (ix === 0 && iy === 0 && iz === 0) { re[idx] = 0; im[idx] = 0; continue; }
          var kz = 2 * Math.PI * FFT.freqIndex(iz, Ng) / L;
          var keff2 = (4 / (h * h)) * (
            Math.sin(kx * h / 2) * Math.sin(kx * h / 2) +
            Math.sin(ky * h / 2) * Math.sin(ky * h / 2) +
            Math.sin(kz * h / 2) * Math.sin(kz * h / 2));
          var factor = -src / keff2;
          re[idx] *= factor; im[idx] *= factor;
        }
      }
    }
    FFT.fft3d(re, im, Ng, true);
    return re; // 実部のみ使う（虚部は丸め誤差で~0）
  }

  /** 4点中心差分の勾配（周期境界）: [8(f[i+1]-f[i-1]) - (f[i+2]-f[i-2])] / (12h)。 */
  function gradient4pt(grid, Ng, L) {
    var h = L / Ng;
    var Ng2 = Ng * Ng;
    var gx = new Float64Array(Ng * Ng * Ng), gy = new Float64Array(Ng * Ng * Ng), gz = new Float64Array(Ng * Ng * Ng);
    for (var ix = 0; ix < Ng; ix++) {
      var xp1 = wrapIdx(ix + 1, Ng), xm1 = wrapIdx(ix - 1, Ng), xp2 = wrapIdx(ix + 2, Ng), xm2 = wrapIdx(ix - 2, Ng);
      for (var iy = 0; iy < Ng; iy++) {
        var yp1 = wrapIdx(iy + 1, Ng), ym1 = wrapIdx(iy - 1, Ng), yp2 = wrapIdx(iy + 2, Ng), ym2 = wrapIdx(iy - 2, Ng);
        for (var iz = 0; iz < Ng; iz++) {
          var zp1 = wrapIdx(iz + 1, Ng), zm1 = wrapIdx(iz - 1, Ng), zp2 = wrapIdx(iz + 2, Ng), zm2 = wrapIdx(iz - 2, Ng);
          var idx = ix * Ng2 + iy * Ng + iz;
          gx[idx] = (8 * (grid[xp1 * Ng2 + iy * Ng + iz] - grid[xm1 * Ng2 + iy * Ng + iz])
            - (grid[xp2 * Ng2 + iy * Ng + iz] - grid[xm2 * Ng2 + iy * Ng + iz])) / (12 * h);
          gy[idx] = (8 * (grid[ix * Ng2 + yp1 * Ng + iz] - grid[ix * Ng2 + ym1 * Ng + iz])
            - (grid[ix * Ng2 + yp2 * Ng + iz] - grid[ix * Ng2 + ym2 * Ng + iz])) / (12 * h);
          gz[idx] = (8 * (grid[ix * Ng2 + iy * Ng + zp1] - grid[ix * Ng2 + iy * Ng + zm1])
            - (grid[ix * Ng2 + iy * Ng + zp2] - grid[ix * Ng2 + iy * Ng + zm2])) / (12 * h);
        }
      }
    }
    return { gx: gx, gy: gy, gz: gz };
  }

  /**
   * PM の力の計算。x(長さ3*Np)・質量 m（定数）・メッシュ Ng・スケール因子 a から、
   * 各粒子の force = -∇φ（3成分・長さ3*Np）と、粒子位置での φ（W エネルギー用）を返す。
   */
  function pmForce(x, Np, m, Ng, L, a) {
    var delta = cicDensity(x, Np, m, Ng, L);
    var phi = poissonSolve(delta, Ng, L, a);
    var grad = gradient4pt(phi, Ng, L);
    var fxg = grad.gx, fyg = grad.gy, fzg = grad.gz; // まだ勾配（符号反転前）
    for (var i = 0; i < fxg.length; i++) { fxg[i] = -fxg[i]; fyg[i] = -fyg[i]; fzg[i] = -fzg[i]; }
    var fx = cicInterpolate(fxg, Ng, L, x, Np);
    var fy = cicInterpolate(fyg, Ng, L, x, Np);
    var fz = cicInterpolate(fzg, Ng, L, x, Np);
    var phiAtP = cicInterpolate(phi, Ng, L, x, Np);
    return { fx: fx, fy: fy, fz: fz, phiAtParticles: phiAtP, phiGrid: phi, deltaGrid: delta };
  }

  function wrapPos(v, L) { v = v % L; return v < 0 ? v + L : v; }

  /**
   * KDK leapfrog を1刻み進める（aFrom → aTo、ln a で等間隔の刻みを想定）。
   * state = { x: Float64Array(3*Np), p: Float64Array(3*Np) } をその場で更新する。
   * 戻り値: aTo での力の評価結果（φ 等。エネルギー計算に使う）。
   */
  function stepKDK(state, Np, m, Ng, L, aFrom, aTo) {
    var aMid = Math.sqrt(aFrom * aTo);
    var f0 = pmForce(state.x, Np, m, Ng, L, aFrom);
    var k1 = kickCoef(aFrom, aMid);
    var i;
    for (i = 0; i < Np; i++) {
      state.p[3 * i] += f0.fx[i] * k1;
      state.p[3 * i + 1] += f0.fy[i] * k1;
      state.p[3 * i + 2] += f0.fz[i] * k1;
    }
    var D = driftCoef(aFrom, aTo);
    for (i = 0; i < Np; i++) {
      state.x[3 * i] = wrapPos(state.x[3 * i] + state.p[3 * i] * D, L);
      state.x[3 * i + 1] = wrapPos(state.x[3 * i + 1] + state.p[3 * i + 1] * D, L);
      state.x[3 * i + 2] = wrapPos(state.x[3 * i + 2] + state.p[3 * i + 2] * D, L);
    }
    var f1 = pmForce(state.x, Np, m, Ng, L, aTo);
    var k2 = kickCoef(aMid, aTo);
    for (i = 0; i < Np; i++) {
      state.p[3 * i] += f1.fx[i] * k2;
      state.p[3 * i + 1] += f1.fy[i] * k2;
      state.p[3 * i + 2] += f1.fz[i] * k2;
    }
    return f1; // aTo・同期した p での評価（エネルギーはこの後の p を使う）
  }

  // ------------------------------------------------------------ エネルギー（K・W・Layzer–Irvine）

  /** K = Σ ½ m (p/a)²（物理の速度 = p/a）。 */
  function kineticEnergy(state, Np, m, a) {
    var K = 0;
    for (var i = 0; i < Np; i++) {
      var vx = state.p[3 * i] / a, vy = state.p[3 * i + 1] / a, vz = state.p[3 * i + 2] / a;
      var mass = (typeof m === 'number') ? m : m[i];
      K += 0.5 * mass * (vx * vx + vy * vy + vz * vz);
    }
    return K;
  }

  /** W = ½ Σ m φ(x_i)（φ はメッシュから CIC で補間）。phiAtParticles は pmForce の戻り値。 */
  function potentialEnergy(phiAtParticles, Np, m) {
    var W = 0;
    for (var i = 0; i < Np; i++) {
      var mass = (typeof m === 'number') ? m : m[i];
      W += 0.5 * mass * phiAtParticles[i];
    }
    return W;
  }

  /**
   * W = ½∫φδρ̄d³r をメッシュ格子上の和で直接評価する（Parsevalと同値）。
   * **重要な申し送り（raw/notes.md 参照）**: メッシュがtier粒子格子より細かい腕（Ng=2*N1。
   * 登録のS/L系列すべて）では、格子上の粒子が格子ノードのほぼ整数倍の位置に来るため、
   * potentialEnergy（CIC補間で粒子位置のφを直接読む方式）は「格子の自己エネルギー」の
   * アーティファクトで W が物理的な値の10^5〜10^6倍に膨れ上がることを実装中に発見した
   * （Ng=N1の一致格子では正常値。Ng=2*N1でK~20なのにW~-10^7）。
   * criteria.system.energyDefinitions の文言どおりのCIC補間方式は登録に忠実だが、
   * 上記の理由でLayzer-Irvineの台帳（⑤）が事実上使えなくなるため、この関数
   * （格子場を直接積分し、粒子位置への補間を経由しない）を diagnostics 用に用意した。
   * criteria.json 自体は変更していない——W の定義選択はここに明記し、run.js で
   * 両方を記録する。
   */
  function potentialEnergyGrid(deltaGrid, phiGrid, Ng, L) {
    var h = L / Ng;
    var cellVol = h * h * h;
    var W = 0;
    for (var i = 0; i < deltaGrid.length; i++) W += 0.5 * phiGrid[i] * deltaGrid[i] * cellVol;
    return W;
  }

  /** 全運動量 Σp（3成分）と Σ|p|（スカラー和）。P_rel の分子分母。 */
  function totalMomentum(state, Np) {
    var sx = 0, sy = 0, sz = 0, sabs = 0;
    for (var i = 0; i < Np; i++) {
      var px = state.p[3 * i], py = state.p[3 * i + 1], pz = state.p[3 * i + 2];
      sx += px; sy += py; sz += pz;
      sabs += Math.sqrt(px * px + py * py + pz * pz);
    }
    var mag = Math.sqrt(sx * sx + sy * sy + sz * sz);
    return { sum: mag, sumAbs: sabs, Prel: sabs > 0 ? mag / sabs : 0 };
  }

  /**
   * Layzer–Irvine の台帳（Bagla&Padmanabhan式(15) / Winther式(26)の ln a 版）。
   * K+W+∫(2K+W)dlna = 一定。ledger 配列（各要素 {lna,K,W}）から σ・Σ・ε を刻みごとに計算する。
   */
  function layzerIrvineLedger(ledger) {
    var K0 = ledger[0].K, W0 = ledger[0].W;
    var I2KW = 0;
    var out = [];
    for (var j = 0; j < ledger.length; j++) {
      if (j > 0) {
        var a0 = ledger[j - 1], a1 = ledger[j];
        var f0 = 2 * a0.K + a0.W, f1 = 2 * a1.K + a1.W;
        I2KW += 0.5 * (f0 + f1) * (a1.lna - a0.lna); // 台形則
      }
      var sigma = (ledger[j].K + ledger[j].W - K0 - W0) + I2KW;
      var Sigma = (Math.abs(ledger[j].K) - Math.abs(K0)) + (Math.abs(ledger[j].W) - Math.abs(W0)) + Math.abs(I2KW);
      var eps = Sigma !== 0 ? sigma / Sigma : 0;
      out.push({ lna: ledger[j].lna, I2KW: I2KW, sigma: sigma, Sigma: Sigma, eps: eps });
    }
    return out;
  }

  // ------------------------------------------------------------ 初期条件（Zel'dovich）

  /**
   * べき乗則スペクトルの形 Δ²_shape(k) = (k/kf)^{n+3}（振幅1・未規格化）。
   * n1: n=-1 → k^2。n0: n=0 → k^3。
   */
  function powerLawShape(k, kf, n) { return Math.pow(k / kf, n + 3); }

  /** BBKS型の伝達関数（記憶・未確認の係数。borrowedConstants に明記）。q = k'/Gamma。 */
  function bbksT(q) {
    if (q <= 0) return 1;
    var num = Math.log(1 + 2.34 * q);
    var denom = 2.34 * q;
    var poly = 1 + 3.89 * q + Math.pow(16.1 * q, 2) + Math.pow(5.46 * q, 3) + Math.pow(6.71 * q, 4);
    return (num / denom) * Math.pow(poly, -0.25);
  }

  /** cdm 型スペクトルの形（未規格化）。k はボックス単位（criteria: k' = k/3.125 h/Mpc）。 */
  function cdmShape(k, kf, Gamma) {
    var kPrime = k / 3.125;
    var q = kPrime / Gamma;
    return Math.pow(kPrime, 4) * bbksT(q) * bbksT(q);
  }

  /** 指数で切った n=-1（未規格化）。kc = 4*kf。 */
  function cutShape(k, kf, kc) { return Math.pow(k / kf, 2) * Math.exp(-(k * k) / (kc * kc)); }

  /**
   * スペクトルの形を返す関数（k: ボックス単位の波数、L: 箱の一辺）。kind ∈ {n1,n0,cdm,cut}。
   */
  function spectrumShape(kind, k, L) {
    var kf = 2 * Math.PI / L;
    if (kind === 'n1') return powerLawShape(k, kf, -1);
    if (kind === 'n0') return powerLawShape(k, kf, 0);
    if (kind === 'cdm') return cdmShape(k, kf, 0.25);
    if (kind === 'cut') return cutShape(k, kf, 4 * kf);
    throw new Error('unknown spectrum kind: ' + kind);
  }

  /**
   * 規格化定数 A を返す。n1/n0/cdm は Δ²_shape(3kf)*A=1。cut は連続極限の積分
   * σ0² = ∫ shape(k)*A dlnk （kf〜k_Ny）が 9（σ0=3）になるよう解析的に定める。
   */
  function normalizeAmplitude(kind, L, kNy) {
    var kf = 2 * Math.PI / L;
    if (kind === 'cut') {
      // 連続積分を対数刻みの台形則で近似（実装内の静的計算。realizationに依らない）。
      var steps = 4000, lnA = Math.log(kf * 1e-3), lnB = Math.log(kNy);
      var dl = (lnB - lnA) / steps, sum = 0;
      for (var i = 0; i <= steps; i++) {
        var lk = lnA + i * dl, k = Math.exp(lk);
        var val = cutShape(k, kf, 4 * kf);
        var w = (i === 0 || i === steps) ? 0.5 : 1;
        sum += w * val * dl;
      }
      return sum > 0 ? 9 / sum : 1;
    }
    var s3 = spectrumShape(kind, 3 * kf, L);
    return s3 > 0 ? 1 / s3 : 1;
  }

  /**
   * Zel'dovich 近似で初期条件を作る。格子 q（N1^3・spacing h1=L/N1）に、白色雑音場から
   * 得た変位場 Ψ を a_i 倍だけ加える。
   *
   * 実装の簡略化（notes.md に申し送り）: 登録は「128^3 のフーリエ格子で白色雑音を生成し、
   * 64^3 腕はその部分集合を使う」ことで tier 間の大スケールモードを共有する設計だが、
   * 本実装は **各 tier の粒子格子と同じ大きさの白色雑音場を直接生成する**（64^3 腕は 64^3、
   * 128^3 腕は 128^3）。これにより 64^3 と 128^3 の「同じ seed」は大スケールモードを厳密には
   * 共有しない。resolution ladder（R1/S-cdm/R3: いずれも 64^3 粒子・メッシュだけ違う）は
   * 粒子格子が同一なのでこの簡略化の影響を受けない。S-cdm↔L-cdm の比較（質量分解能の軸）は
   * 影響を受ける（実現が独立になる）。
   */
  function generateIC(opts) {
    var N1 = opts.N1, kind = opts.spectrum, seed = opts.seed, L = opts.L || L_BOX;
    var rng = makeRng(seed);
    var gauss = makeGaussian(rng);
    var Ng = N1; // 白色雑音場は粒子格子と同じ大きさ（上の申し送り参照）
    var n = Ng * Ng * Ng;
    var re = new Float64Array(n), im = new Float64Array(n);
    for (var i = 0; i < n; i++) re[i] = gauss();
    FFT.fft3d(re, im, Ng, false); // これで re/im は「白色雑音のFourier係数」(w_k, 複素ガウス)

    var kf = 2 * Math.PI / L;
    var kNy = Math.PI * N1 / L; // 粒子のナイキスト波数
    var Anorm = normalizeAmplitude(kind, L, kNy);
    var V = L * L * L;

    // 修正（S4 の指摘・notes.md 参照）: 登録は delta_k = w_k * sqrt(P(k)/V)、
    // P(k) = 2*pi^2*Delta^2(k)/k^3、|k| <= k_Ny,p で切る。
    // ここで w_k は fft3d(forward, unnormalized) が単位分散の白色雑音場から作る生のFourier係数
    // D_k で、<|D_k|^2> = n（格子点数）。実空間へ戻す fft3d(inverse) は 1/n を内蔵しているので、
    // 求める場は field(x) = (1/n)*sum_k delta_k*e^{ikx} という「code の D_k」規約で組み立てる。
    // 物理の連続極限の係数 delta~_k（<|delta~_k|^2> = V*P(k)）と code の D_k の関係は
    // delta~_k = h^3 * D_k（h^3=V/n はセル体積）なので D_k = delta~_k * n/V、
    // よって <|D_k|^2> = (n/V)^2 * V*P(k) = n^2*P(k)/V = 2*pi^2*n*Delta^2(k)/(k^3*V) が要る分散。
    // D_k = w_k*scale・<|w_k|^2>=n なので scale = sqrt(2*pi^2*n*Delta^2(k)/(k^3*V))。
    // 旧実装は scale=sqrt(Delta^2(k)/n) としており、比(旧/正)^2 = k^3*V/(2*pi^2*n^2) だけ
    // 振幅が小さく、しかもこの比自体が k に依るのでスペクトルの形も k^3 だけ余分に傾いていた。
    var Ng2 = Ng * Ng;
    var deltaRe = new Float64Array(n), deltaIm = new Float64Array(n);
    var psiXre = new Float64Array(n), psiXim = new Float64Array(n);
    var psiYre = new Float64Array(n), psiYim = new Float64Array(n);
    var psiZre = new Float64Array(n), psiZim = new Float64Array(n);
    for (var ix = 0; ix < Ng; ix++) {
      var kx = 2 * Math.PI * FFT.freqIndex(ix, Ng) / L;
      for (var iy = 0; iy < Ng; iy++) {
        var ky = 2 * Math.PI * FFT.freqIndex(iy, Ng) / L;
        for (var iz = 0; iz < Ng; iz++) {
          var idx = ix * Ng2 + iy * Ng + iz;
          var kz = 2 * Math.PI * FFT.freqIndex(iz, Ng) / L;
          var kmag2 = kx * kx + ky * ky + kz * kz;
          if (idx === 0) { continue; } // k=0: delta=0, psi=0
          var kmag = Math.sqrt(kmag2);
          if (kmag > kNy) { continue; } // 登録: |k| <= k_Ny,p の球で切る（立方体の角は使わない）
          var shape = spectrumShape(kind, kmag, L) * Anorm;
          var scale = Math.sqrt(Math.max(shape, 0) * 2 * Math.PI * Math.PI * n / (kmag2 * kmag * V));
          var wr = re[idx] * scale, wi = im[idx] * scale;
          deltaRe[idx] = wr; deltaIm[idx] = wi;
          // psi_k = i*k*delta_k/k^2 = i*k/(k^2) * (wr+i*wi) = (-k*wi)/k^2 + i*(k*wr)/k^2 (component-wise)
          var invk2 = 1 / kmag2;
          psiXre[idx] = -kx * wi * invk2; psiXim[idx] = kx * wr * invk2;
          psiYre[idx] = -ky * wi * invk2; psiYim[idx] = ky * wr * invk2;
          psiZre[idx] = -kz * wi * invk2; psiZim[idx] = kz * wr * invk2;
        }
      }
    }
    FFT.fft3d(psiXre, psiXim, Ng, true);
    FFT.fft3d(psiYre, psiYim, Ng, true);
    FFT.fft3d(psiZre, psiZim, Ng, true);

    var Np = n;
    var h1 = L / N1;
    var x = new Float64Array(3 * Np), p = new Float64Array(3 * Np);
    var mass = Math.pow(L / N1, 3); // rhobar=1 と一致
    var ai = opts.aInitial;
    var sumSq = 0;
    for (var p_ = 0; p_ < Np; p_++) {
      var gx = Math.floor(p_ / Ng2), gy = Math.floor((p_ % Ng2) / Ng), gz = p_ % Ng;
      var qx = gx * h1, qy = gy * h1, qz = gz * h1;
      var Psix = psiXre[p_], Psiy = psiYre[p_], Psiz = psiZre[p_];
      sumSq += Psix * Psix + Psiy * Psiy + Psiz * Psiz;
      x[3 * p_] = wrapPos(qx + ai * Psix, L);
      x[3 * p_ + 1] = wrapPos(qy + ai * Psiy, L);
      x[3 * p_ + 2] = wrapPos(qz + ai * Psiz, L);
      p[3 * p_] = Math.pow(ai, 1.5) * Psix;
      p[3 * p_ + 1] = Math.pow(ai, 1.5) * Psiy;
      p[3 * p_ + 2] = Math.pow(ai, 1.5) * Psiz;
    }
    var psiRms = Math.sqrt(sumSq / Np);
    return { x: x, p: p, Np: Np, mass: mass, psiRmsAtA1: psiRms, deltaRe: deltaRe, deltaIm: deltaIm };
  }

  /**
   * a_i（開始のスケール因子）の静的な決定。criteria.system.start の定義:
   * 「Δ²_lin(k_Ny,p, a_i)=0.04」と「rms 変位 ≤ 0.25 粒子間隔」の早いほう（小さいa_i）。
   * cut は σ0,lin(a_i)=0.05 と変位条件の早いほう。
   * Δ²_lin(k,a) = shape(k)*Anorm*a²（EdSの成長率 D=a）。
   * rms変位(a) = a*psiRmsAtA1（generateICで a=1 相当の場を作ってから決めるので、ここでは
   * 解析的に Psi の分散を対数刻み積分で見積もる：Psi_rms(a=1)² = ∫ shape(k)*Anorm/k² dlnk）。
   */
  function computeStartA(kind, N1, L) {
    var kf = 2 * Math.PI / L;
    var kNy = Math.PI * N1 / L;
    var Anorm = normalizeAmplitude(kind, L, kNy);
    var d2Ny = spectrumShape(kind, kNy, L) * Anorm;
    var aCond1 = Math.sqrt(0.04 / d2Ny);
    // Psi_rms(a=1)^2 = ∫_{kf}^{kNy} shape(k)*Anorm/k^2 dlnk（対数刻み台形則）
    var steps = 4000, lnA = Math.log(kf), lnB = Math.log(kNy), dl = (lnB - lnA) / steps, sum = 0;
    for (var i = 0; i <= steps; i++) {
      var lk = lnA + i * dl, k = Math.exp(lk);
      var val = spectrumShape(kind, k, L) * Anorm / (k * k);
      var w = (i === 0 || i === steps) ? 0.5 : 1;
      sum += w * val * dl;
    }
    var psiRms2 = sum;
    var aCond2 = 0.25 / Math.sqrt(psiRms2); // rms変位(単位: 粒子間隔 h1=L/N1) <= 0.25*h1 → a*sqrt(psiRms2) <= 0.25*h1
    // 上の psiRms2 は「箱単位の変位」の分散。粒子間隔で測るには h1=L/N1 で割る必要がある。
    var h1 = L / N1;
    aCond2 = 0.25 * h1 / Math.sqrt(psiRms2);
    var candidates;
    if (kind === 'cut') {
      // sigma0,lin(a)=0.05 → a^2 * sigma0,lin(a=1)^2 = 0.0025。sigma0,lin(a=1)^2 = 9（規格化そのもの）。
      var aCondSigma = Math.sqrt(0.0025 / 9);
      candidates = [aCondSigma, aCond2];
    } else {
      candidates = [aCond1, aCond2];
    }
    return { aInitial: Math.min.apply(null, candidates), aCond1: candidates[0], aCond2: candidates[1], psiRmsAtA1: Math.sqrt(psiRms2) };
  }

  // ------------------------------------------------------------ 解析的な検算の道具（positiveControls）

  /** 周期箱で軟化なしの点質量が及ぼす力（ニュートン＋周期補正）。r は距離、L は箱、m*G。 */
  function pointMassForceMag(r, L, mG) {
    // f(r) ≈ mG/r^2 - (4*pi/3)*mG/L^3 * r （borrowedConstants の展開）
    return mG / (r * r) - (4 * Math.PI / 3) * mG / (L * L * L) * r;
  }

  // ------------------------------------------------------------ 公開API

  return {
    L_BOX: L_BOX, G: G,
    makeRng: makeRng, makeGaussian: makeGaussian,
    Hoft: Hoft, driftCoef: driftCoef, kickCoef: kickCoef,
    wrapIdx: wrapIdx, wrapPos: wrapPos,
    cicDensity: cicDensity, cicInterpolate: cicInterpolate,
    poissonSolve: poissonSolve, gradient4pt: gradient4pt, pmForce: pmForce,
    stepKDK: stepKDK,
    kineticEnergy: kineticEnergy, potentialEnergy: potentialEnergy, potentialEnergyGrid: potentialEnergyGrid, totalMomentum: totalMomentum,
    layzerIrvineLedger: layzerIrvineLedger,
    spectrumShape: spectrumShape, normalizeAmplitude: normalizeAmplitude, bbksT: bbksT,
    generateIC: generateIC, computeStartA: computeStartA,
    pointMassForceMag: pointMassForceMag,
  };
});
