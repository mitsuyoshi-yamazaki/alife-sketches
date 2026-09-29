/**
 * S-41 の核。依存ゼロ・古典スクリプト・Node とブラウザ共用。
 *
 * 本スケッチは「文献・考察」だが、**原理で成り立っているかを自分で動かして確かめる**ために、
 * 調べた3系統の最小の再実装を核に置く。式はすべて原典の本文から取り、出典を各関数の直上に書く。
 *
 *   L   Lenia                原典 Chan (2019) arXiv:1812.05433  式 (2.1)-(2.5)
 *   AL  Asymptotic Lenia     Kawaguchi ほか (2021)。式は Kojima & Ikegami (2023) arXiv:2305.13784 式 (4)(5) から
 *   FL  Flow Lenia           Plantec ほか (2022) arXiv:2212.07906 式 (1)-(7)
 *   PL  Particle Lenia       Mordvintsev, Niklasson, Randazzo (2022) energy-based formulation
 *
 * 語彙の規約（briefing）: 核は上位概念の語彙を持たない。格子点は site、まとまりは patch と呼ぶ。
 */
(function (global) {
  'use strict';

  /* ---------------------------------------------------------------- 道具 */

  function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /** 64bit に丸めた状態ハッシュ（K-36）。決定的な系の同一性判定に使う。 */
  function hashArray(arr) {
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < arr.length; i++) {
      var v = Math.round(arr[i] * 1e9) | 0;
      h1 = Math.imul(h1 ^ (v & 0xffff), 16777619) >>> 0;
      h2 = Math.imul(h2 ^ ((v >>> 16) & 0xffff), 2246822519) >>> 0;
    }
    return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
  }

  /* ------------------------------------------------------------ 核（kernel） */

  /**
   * 同心 Gauss 山の和としての核。Flow Lenia 論文 式(1):
   *   K_i(x) = Σ_j b_{i,j} exp( −( |x−r_i|/R − a_{i,j} )² / (2 w_{i,j}²) )
   * を Σ K = 1 に正規化する。Lenia と Flow Lenia で**同じ核を使う**（原典が同じ
   * パラメータ組を両系へ当てて比べているため）。
   */
  function makeKernel(R, rings) {
    var off = [], sum = 0, dx, dy, j, r, w;
    for (dy = -R; dy <= R; dy++) {
      for (dx = -R; dx <= R; dx++) {
        r = Math.sqrt(dx * dx + dy * dy) / R;
        if (r > 1) continue;
        w = 0;
        for (j = 0; j < rings.length; j++) {
          var d = (r - rings[j].a) / rings[j].w;
          w += rings[j].b * Math.exp(-0.5 * d * d);
        }
        if (w <= 1e-12) continue;
        off.push(dx, dy, w); sum += w;
      }
    }
    for (j = 2; j < off.length; j += 3) off[j] /= sum;
    return { R: R, off: off, n: off.length / 3, rings: rings };
  }

  /** トーラス上の畳み込み。U ← K * A */
  function convolve(A, W, H, ker, out) {
    var off = ker.off, n = off.length, x, y, i, k, sx, sy, s;
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        s = 0;
        for (k = 0; k < n; k += 3) {
          sx = x + off[k]; sy = y + off[k + 1];
          if (sx < 0) sx += W; else if (sx >= W) sx -= W;
          if (sy < 0) sy += H; else if (sy >= H) sy -= H;
          s += A[sy * W + sx] * off[k + 2];
        }
        out[y * W + x] = s;
      }
    }
    return out;
  }

  /**
   * 成長写像。Chan (2019) と Flow Lenia 式(2) の共通形:
   *   G(u) = 2 exp( −(u−μ)² / (2σ²) ) − 1   ∈ [−1, 1]
   */
  function growth(u, mu, sigma) {
    var d = (u - mu) / sigma;
    return 2 * Math.exp(-0.5 * d * d) - 1;
  }

  /* -------------------------------------------------------------- 観測器 */

  function totalMass(A) { var s = 0; for (var i = 0; i < A.length; i++) s += A[i]; return s; }

  /**
   * 占有比（participation ratio）。(Σa)² / (N·Σa²)。
   * **一様な場でちょうど 1.0** を返し、k 個の site に等しく載った場では k/N を返す——
   * 閾値も連結半径も選ばずに「どれだけ狭い範囲に集まっているか」を測れる（K-10: 粒度を系から借りる）。
   */
  function participation(A) {
    var s1 = 0, s2 = 0, i;
    for (i = 0; i < A.length; i++) { s1 += A[i]; s2 += A[i] * A[i]; }
    if (s2 <= 0) return NaN;           // 場が全て 0 のとき占有比は定義されない（K-30 の「観測器が答えない」）
    return (s1 * s1) / (A.length * s2);
  }

  /* ------------------------------------------------------------ L: Lenia */

  /**
   * Chan (2019) の更新:  A^{t+dt} = [ A^t + dt · G(K*A^t) ]_0^1
   * clip があるため総質量は保たれない（本スケッチの事前登録 P1）。
   */
  function makeLenia(cfg) {
    var W = cfg.W, H = cfg.H, N = W * H;
    var A = new Float64Array(N), U = new Float64Array(N);
    return {
      kind: 'lenia', W: W, H: H, A: A, U: U,
      params: cfg,
      step: function () {
        convolve(A, W, H, cfg.kernel, U);
        for (var i = 0; i < N; i++) {
          A[i] = clamp(A[i] + cfg.dt * growth(U[i], cfg.mu, cfg.sigma), 0, 1);
        }
      }
    };
  }

  /* ------------------------------------------ AL: Asymptotic Lenia */

  /**
   * Kawaguchi ほか (2021)。Kojima & Ikegami (2023) 式(4):
   *   u(x, t+dt) = u(x,t) + dt · ( T(K*u) − u ),   T = (G+1)/2
   * **clip を含まない**ので微分方程式 ∂u/∂t = T(K*u) − u として書ける（同 式(5)）。
   * 増分を足すのではなく**目標値 T へ緩和する**のが元の Lenia との差分。
   */
  function makeAsymptotic(cfg) {
    var W = cfg.W, H = cfg.H, N = W * H;
    var A = new Float64Array(N), U = new Float64Array(N);
    return {
      kind: 'asymptotic', W: W, H: H, A: A, U: U,
      params: cfg,
      step: function () {
        convolve(A, W, H, cfg.kernel, U);
        for (var i = 0; i < N; i++) {
          var T = (growth(U[i], cfg.mu, cfg.sigma) + 1) / 2;
          A[i] = A[i] + cfg.dt * (T - A[i]);
        }
      }
    };
  }

  /* ------------------------------------------------ FL: Flow Lenia */

  /** Sobel による勾配。原典「in practice, gradients are estimated through Sobel filtering」。 */
  function sobel(A, W, H, gx, gy) {
    var kx = [-1, 0, 1, -2, 0, 2, -1, 0, 1];
    var ky = [-1, -2, -1, 0, 0, 0, 1, 2, 1];
    for (var y = 0; y < H; y++) {
      for (var x = 0; x < W; x++) {
        var sx = 0, sy = 0, t = 0;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++, t++) {
            var px = (x + dx + W) % W, py = (y + dy + H) % H;
            var v = A[py * W + px];
            sx += v * kx[t]; sy += v * ky[t];
          }
        }
        gx[y * W + x] = sx / 8; gy[y * W + x] = sy / 8;
      }
    }
  }

  /**
   * Plantec ほか (2022)。
   *   親和度  U^t = Σ_k h_k G_k(K_k * A^t) / Σh        （Lenia の「成長」をそう読み替える）
   *   流れ    F^t = (1−α)∇U^t − α∇A^t,  α = [ (A^t/A_c)^n ]_0^1      式(5)
   *   輸送    A^{t+dt}(p) = Σ_{p'} A^t(p') · I(p', p)                  式(6)
   *           I(p',p) = ∫_{Ω_p} D( p'+dt·F^t(p'), s )                  式(7)
   *   D は一辺 2s の一様分布。∫D = 1 なので**総質量は厳密に保たれる**（事前登録 P2）。
   */
  function makeFlow(cfg) {
    var W = cfg.W, H = cfg.H, N = W * H;
    var A = new Float64Array(N), U = new Float64Array(N), B = new Float64Array(N);
    var gux = new Float64Array(N), guy = new Float64Array(N);
    var gax = new Float64Array(N), gay = new Float64Array(N);
    var s = cfg.s, dt = cfg.dt, Ac = cfg.Ac, nExp = cfg.n;

    function overlap(c, lo, hi) {         // site c（一辺 1・中心 c）と区間 [lo,hi] の重なり長
      var a = Math.max(lo, c - 0.5), b = Math.min(hi, c + 0.5);
      return b > a ? b - a : 0;
    }

    return {
      kind: 'flow', W: W, H: H, A: A, U: U,
      params: cfg,
      step: function () {
        convolve(A, W, H, cfg.kernel, U);
        var i, x, y;
        for (i = 0; i < N; i++) U[i] = growth(U[i], cfg.mu, cfg.sigma);
        sobel(U, W, H, gux, guy);
        sobel(A, W, H, gax, gay);
        for (i = 0; i < N; i++) B[i] = 0;
        var area = (2 * s) * (2 * s);
        for (y = 0; y < H; y++) {
          for (x = 0; x < W; x++) {
            i = y * W + x;
            var m = A[i];
            if (m === 0) continue;
            var al = clamp(Math.pow(A[i] / Ac, nExp), 0, 1);
            var fx = (1 - al) * gux[i] - al * gax[i];
            var fy = (1 - al) * guy[i] - al * gay[i];
            var tx = x + dt * fx, ty = y + dt * fy;
            var lox = tx - s, hix = tx + s, loy = ty - s, hiy = ty + s;
            var c0 = Math.floor(lox + 0.5), c1 = Math.ceil(hix - 0.5);
            var r0 = Math.floor(loy + 0.5), r1 = Math.ceil(hiy - 0.5);
            for (var cy = r0; cy <= r1; cy++) {
              var oy = overlap(cy, loy, hiy);
              if (oy <= 0) continue;
              var wy = ((cy % H) + H) % H;
              for (var cx = c0; cx <= c1; cx++) {
                var ox = overlap(cx, lox, hix);
                if (ox <= 0) continue;
                var wx = ((cx % W) + W) % W;
                B[wy * W + wx] += m * (ox * oy) / area;
              }
            }
          }
        }
        A.set(B);
      }
    };
  }

  /* -------------------------------------------- PL: Particle Lenia */

  /**
   * Mordvintsev ほか (2022)。**Lenia の峰関数は σ の分母に 2 を持たない**ことに注意:
   *   peak(x; μ, σ) = exp( −((x−μ)/σ)² )
   *   U(x) = w_K Σ_i peak(|x−p_i|; μ_K, σ_K)
   *   G(x) = peak(U(x); μ_G, σ_G)
   *   R(x) = (c_rep/2) Σ_i max(1−|x−p_i|, 0)²
   *   E    = R − G,      dp_i/dt = −∇E(p_i)
   * ここで ∇ は**他の粒子を固定したまま場 E(x) を x で微分したもの**であり、
   * 全エネルギー Σ_j E(p_j) の勾配ではない（原典が明示的に区別している）。
   * mode:'field' が原典の規則、mode:'total' が全エネルギーの勾配降下（対照）。
   */
  function particleFields(p, pts, x, y) {
    var U = 0, R = 0, i, dx, dy, r, d;
    for (i = 0; i < pts.length; i += 2) {
      dx = x - pts[i]; dy = y - pts[i + 1];
      r = Math.sqrt(dx * dx + dy * dy);
      if (r < 1e-10) r = 1e-10;
      d = (r - p.mu_k) / p.sigma_k;
      U += Math.exp(-d * d);
      if (r < 1) R += (1 - r) * (1 - r);
    }
    U *= p.w_k;
    R *= p.c_rep / 2;
    var g = (U - p.mu_g) / p.sigma_g;
    var G = Math.exp(-g * g);
    return { U: U, G: G, R: R, E: R - G };
  }

  /** 場 E(x) の解析的な勾配（自分自身の項は 0 になるので寄与しない）。 */
  function fieldGrad(p, pts, x, y, self) {
    var U = 0, ux = 0, uy = 0, rx = 0, ry = 0, i, dx, dy, r, d, k;
    for (i = 0; i < pts.length; i += 2) {
      dx = x - pts[i]; dy = y - pts[i + 1];
      r = Math.sqrt(dx * dx + dy * dy);
      if (r < 1e-10) { U += Math.exp(-Math.pow(p.mu_k / p.sigma_k, 2)); continue; }
      d = (r - p.mu_k) / p.sigma_k;
      k = Math.exp(-d * d);
      U += k;
      var dk = k * (-2 * d / p.sigma_k);            // dK/dr
      ux += dk * dx / r; uy += dk * dy / r;
      if (r < 1) { rx += -(1 - r) * dx / r; ry += -(1 - r) * dy / r; }
    }
    U *= p.w_k; ux *= p.w_k; uy *= p.w_k;
    rx *= p.c_rep; ry *= p.c_rep;
    var g = (U - p.mu_g) / p.sigma_g;
    var G = Math.exp(-g * g);
    var dG = G * (-2 * g / p.sigma_g);              // dG/dU
    void self;
    return [rx - dG * ux, ry - dG * uy];
  }

  /**
   * 全エネルギー E_total = Σ_j E(p_j) の p_i についての解析的な勾配。
   *   ∇_i E_total = 2·∇R(p_i) − Σ_{k≠i} ( G'(U(p_i)) + G'(U(p_k)) ) · w_K K'(r_ik) (p_i−p_k)/r_ik
   * **斥力の項に 2 が掛かる**のが場の勾配（原典の規則）との違いのひとつ。
   * 数値微分と一致することは run.js の C-b2 で検査する。
   */
  function totalGrad(p, pts) {
    var n = pts.length / 2, i, k, dx, dy, r, d, kk;
    var dG = new Float64Array(n), out = new Float64Array(pts.length);
    for (i = 0; i < n; i++) {
      var U = 0;
      for (k = 0; k < n; k++) {
        dx = pts[2 * i] - pts[2 * k]; dy = pts[2 * i + 1] - pts[2 * k + 1];
        r = Math.sqrt(dx * dx + dy * dy); if (r < 1e-10) r = 1e-10;
        d = (r - p.mu_k) / p.sigma_k;
        U += Math.exp(-d * d);
      }
      U *= p.w_k;
      var g = (U - p.mu_g) / p.sigma_g;
      dG[i] = Math.exp(-g * g) * (-2 * g / p.sigma_g);
    }
    for (i = 0; i < n; i++) {
      var gx = 0, gy = 0;
      for (k = 0; k < n; k++) {
        if (k === i) continue;
        dx = pts[2 * i] - pts[2 * k]; dy = pts[2 * i + 1] - pts[2 * k + 1];
        r = Math.sqrt(dx * dx + dy * dy); if (r < 1e-12) continue;
        d = (r - p.mu_k) / p.sigma_k;
        kk = Math.exp(-d * d) * (-2 * d / p.sigma_k) * p.w_k;       // w_K K'(r)
        var c = (dG[i] + dG[k]) * kk / r;
        gx -= c * dx; gy -= c * dy;
        if (r < 1) { gx += -2 * p.c_rep * (1 - r) * dx / r; gy += -2 * p.c_rep * (1 - r) * dy / r; }
      }
      out[2 * i] = gx; out[2 * i + 1] = gy;
    }
    return out;
  }

  function totalEnergy(p, pts) {
    var e = 0;
    for (var i = 0; i < pts.length; i += 2) e += particleFields(p, pts, pts[i], pts[i + 1]).E;
    return e;
  }

  function makeParticle(cfg) {
    var p = cfg.params, pts = Float64Array.from(cfg.points), dt = cfg.dt;
    var mode = cfg.mode || 'field';
    return {
      kind: 'particle', mode: mode, points: pts, params: cfg, speed: 0,
      step: function () {
        var i, g, v = new Float64Array(pts.length);
        if (mode === 'field') {
          for (i = 0; i < pts.length; i += 2) {
            g = fieldGrad(p, pts, pts[i], pts[i + 1], i);
            v[i] = -g[0]; v[i + 1] = -g[1];
          }
        } else {                                    // 全エネルギーの勾配（真の勾配流）
          var tg = totalGrad(p, pts);
          for (i = 0; i < pts.length; i++) v[i] = -tg[i];
        }
        this.speed = 0;
        for (i = 0; i < pts.length; i += 2) this.speed += Math.sqrt(v[i] * v[i] + v[i + 1] * v[i + 1]);
        this.speed /= (pts.length / 2);
        for (i = 0; i < pts.length; i++) pts[i] += dt * v[i];
      }
    };
  }

  /* ------------------------------------------------------------ 代理（対照） */

  /**
   * 場の site を並べ替えるだけの代理。**総質量を厳密に保つ**が機構を1つも持たない。
   * K-28（保存量を検出器へ昇格）に対する K-58（線形な収支は並べ替えに通される）の実地確認に使う。
   */
  function shuffleField(A, rng) {
    var B = Float64Array.from(A), i, j, t;
    for (i = B.length - 1; i > 0; i--) {
      j = Math.floor(rng() * (i + 1));
      t = B[i]; B[i] = B[j]; B[j] = t;
    }
    return B;
  }

  /** 粒子を箱の中へ撒き直す代理。粒子数（＝質量）は保つが配置の機構を持たない。 */
  function teleportPoints(pts, rng, half) {
    var B = Float64Array.from(pts);
    for (var i = 0; i < B.length; i++) B[i] = (rng() * 2 - 1) * half;
    return B;
  }

  /* ------------------------------------------------ 分岐の符号化（K-39） */

  /**
   * **判断を含む分類は、根拠つきの定数表として核に置く**（K-39）。
   * change の5欄は criteria.json の C1〜C5 に対応する。anchor は raw/quotes.json の引用 id、
   * または本文の所在。表を書き換えて数え直せるように、集計器と同じファイルに置く。
   */
  var BRANCHES = [
    {
      id: 'lenia', title: 'Lenia（参照点）', year: 2019,
      cite: 'Chan (2019) Lenia — Biology of Artificial Life, Complex Systems 28(3). arXiv:1812.05433',
      change: { C1: 0, C2: 0, C3: 0, C4: 0, C5: 0 },
      claim: 'taxonomy',     // 「生きている」ことをどう主張するか
      anchor: 'q-lenia-update',
      reach: { E1: 1, E2: 1, E3: null, E4: 1, E5: 1, E6: 1 },
      reachNote: '参照点なので E3 は無い。E4 は S-03 が使った Orbium の公称値（同著者の模様集）',
      note: '参照点。以後の差分はすべてこれとの比較で数える'
    },
    {
      id: 'expanded', title: 'Lenia and Expanded Universe（高次元・多核・多チャンネル）', year: 2020,
      cite: 'Chan (2020) Lenia and Expanded Universe, ALIFE 2020. arXiv:2005.03742',
      change: { C1: 0, C2: 0, C3: 0, C4: 0, C5: 0 },
      claim: 'taxonomy',
      anchor: 'q-expanded-formula',
      reach: { E1: 1, E2: 1, E3: 1, E4: 0, E5: 1, E6: 0 },
      reachNote: '式(2) は本文から取れた。個々の模様のパラメータ値は取れていない',
      note: '同じ加算更新に添字を増やした形。式(2) は元の式と同型で、状態空間も更新の代数も変わらない'
    },
    {
      id: 'asymptotic', title: 'Asymptotic Lenia', year: 2021,
      cite: 'Kawaguchi, Suzuki, Arita, Chan (2021) ALIFE 2021。定式化は Kojima & Ikegami (2023) arXiv:2305.13784 式(4)(5) から取った',
      change: { C1: 0, C2: 1, C3: 0, C4: 0, C5: 0 },
      claim: 'dynamical',
      anchor: 'q-asymptotic-update',
      reach: { E1: 1, E2: 1, E3: 1, E4: 0, E5: 0.5, E6: 1 },
      reachNote: '**式は原典（Kawaguchi ほか 2021）ではなく Kojima & Ikegami 2023 の式(4)(5) 経由で取った。** 原典そのものには到達していない',
      note: '増分の加算を目標値への緩和に替え、clip を外した。結果として微分方程式として書ける'
    },
    {
      id: 'glaberish', title: 'Glaberish（条件付き更新）', year: 2022,
      cite: 'Davis & Bongard (2022) Glaberish: Generalizing the Continuously-Valued Lenia Framework. arXiv:2205.10463',
      change: { C1: 0, C2: 1, C3: 0, C4: 0, C5: 0 },
      claim: 'complexity-class',
      anchor: 'q-glaberish-update',
      reach: { E1: 1, E2: 1, E3: 1, E4: 1, E5: 0.5, E6: 0 },
      reachNote: '式(3) と Hydrogeminium / s613 のパラメータ値が本文にある',
      note: '成長写像を genesis と persistence へ分け、更新が site の状態に依存するようにした'
    },
    {
      id: 'particle', title: 'Particle Lenia', year: 2022,
      cite: 'Mordvintsev, Niklasson, Randazzo (2022) Particle Lenia and the energy-based formulation, Google Research Self-Organising Systems',
      change: { C1: 1, C2: 1, C3: 1, C4: 1, C5: 0 },
      claim: 'none-stated',
      anchor: 'q-particle-energy',
      reach: { E1: 1, E2: 1, E3: 1, E4: 1, E5: 1, E6: 1 },
      reachNote: '**式は記事本文・付属ノートブックのコード・二次資料の3経路が一致した。ただし記事本文の逐語引用は検査に掛かっていない**（quotes.json の grade = refetch-only）',
      note: '場を粒子へ移し、更新をエネルギー場の勾配降下として定式化した。質量保存は粒子数が一定であることから従う'
    },
    {
      id: 'flow', title: 'Flow Lenia（mass conservative Lenia）', year: 2022,
      cite: 'Plantec, Hamon, Etcheverry, Oudeyer, Moulin-Frier, Chan (2022/2025) arXiv:2212.07906 / Artificial Life 31(2) 228 / arXiv:2506.08569',
      change: { C1: 1, C2: 1, C3: 1, C4: 0, C5: 1 },
      claim: 'evolutionary',
      anchor: 'q-flow-conservation',
      reach: { E1: 1, E2: 1, E3: 1, E4: 1, E5: 1, E6: 1 },
      reachNote: '式(1)〜(7) と Table 1 のパラメータ範囲を本文から取れた',
      note: '加算を輸送に替えて質量を保存し、状態空間を R≥0 へ広げ、更新則のパラメータを場として埋め込んだ'
    },
    {
      id: 'rdlenia', title: 'RD Lenia（反応拡散系としての実装）', year: 2023,
      cite: 'Kojima & Ikegami (2023) Implementation of Lenia as a Reaction-Diffusion System. arXiv:2305.13784',
      change: { C1: 0, C2: 1, C3: 0, C4: 0, C5: 0 },
      claim: 'physical-realizability',
      anchor: 'q-rd-equivalence',
      reach: { E1: 1, E2: 1, E3: 1, E4: 0, E5: 0, E6: 0 },
      reachNote: '式は取れたが、反応拡散系としての実装のパラメータと公開コードは確かめていない',
      note: 'Asymptotic Lenia が一般化 KT モデルと数学的に等価であることを示し、反応拡散系として組み直した'
    },
    {
      id: 'sensorimotor', title: 'Sensorimotor Lenia（多様性探索で感覚運動性を見つける）', year: 2024,
      cite: 'Hamon, Etcheverry, Chan, Moulin-Frier, Oudeyer (2024) Discovering Sensorimotor Agency in Cellular Automata using Diversity Search. arXiv:2402.10236',
      change: { C1: 0, C2: 0, C3: 0, C4: 0, C5: 0 },
      claim: 'agency',
      anchor: 'q-sensorimotor-goal',
      reach: { E1: 1, E2: 1, E3: 1, E4: 0, E5: 1, E6: 0 },
      reachNote: '系は Lenia のままなので E1〜E3 は自明。公開リポジトリの存在は確認した',
      note: '更新則は Lenia のまま。変えたのは**探索の側**（多様性探索とカリキュラム）であって系ではない'
    },
    {
      id: 'leniabreeder', title: 'Leniabreeder（品質多様性による探索）', year: 2024,
      cite: 'Faldor & Cully (2024) Toward Artificial Open-Ended Evolution within Lenia using Quality-Diversity. arXiv:2406.04235',
      change: { C1: 0, C2: 0, C3: 0, C4: 0, C5: 0 },
      claim: 'open-endedness',
      anchor: 'q-leniabreeder-method',
      reach: { E1: 1, E2: 1, E3: 1, E4: 0, E5: 0.5, E6: 0 },
      reachNote: '同上。探索手法（MAP-Elites / AURORA）は本文から取れた',
      note: '同上。系は Lenia のまま、探索を品質多様性へ替えた'
    },
    {
      id: 'paramspace', title: 'Lenia Explorer（パラメータ空間の可視化）', year: 2026,
      cite: 'Hudcová, Dušek, Tuccio, Hongler (2026) Visualizing the Structure of Lenia Parameter Space. arXiv:2601.01932',
      change: { C1: 0, C2: 0, C3: 0, C4: 0, C5: 0 },
      claim: 'none-stated',
      anchor: 'q-paramspace-tool',
      reach: { E1: 1, E2: 1, E3: 1, E4: 0, E5: 1, E6: 0 },
      reachNote: '要旨だけの短報。分類法の記述は取れた',
      note: '系は変えず、パラメータ空間の地図を道具として配った'
    }
  ];

  /**
   * 事前登録した閾値で「大きな拡張」を判定して数える。
   * 閾値は criteria.json に固定してあり、ここでは受け取るだけにする（表と閾値を分けておく）。
   */
  /** 原典への到達を**項目ごと**に数える（K-65: 0/1 で書かない）。 */
  function tallyReach(rows) {
    rows = rows || BRANCHES;
    var keys = ['E1', 'E2', 'E3', 'E4', 'E5', 'E6'], per = {}, out = [];
    keys.forEach(function (k) { per[k] = { got: 0, partial: 0, none: 0, na: 0 }; });
    rows.forEach(function (b) {
      var r = { id: b.id, title: b.title, note: b.reachNote };
      keys.forEach(function (k) {
        var v = b.reach[k];
        r[k] = v;
        if (v === null) per[k].na++;
        else if (v === 1) per[k].got++;
        else if (v === 0) per[k].none++;
        else per[k].partial++;
      });
      out.push(r);
    });
    return { rows: out, perItem: per };
  }

  function tallyBranches(rule, rows) {
    rows = rows || BRANCHES;
    var out = [];
    for (var i = 0; i < rows.length; i++) {
      var b = rows[i], c = b.change;
      var k = c.C1 + c.C2 + c.C3 + c.C4 + c.C5;
      var big = (k >= rule.minChanges) || (rule.algebraCounts && c.C2 === 1);
      if (b.id === rule.referenceId) big = false;
      out.push({ id: b.id, title: b.title, year: b.year, changes: k, C: c, big: big, claim: b.claim, anchor: b.anchor });
    }
    return out;
  }

  /* ------------------------------------------------------------- 公開 */

  var S41 = {
    mulberry32: mulberry32, clamp: clamp, hashArray: hashArray,
    makeKernel: makeKernel, convolve: convolve, growth: growth,
    totalMass: totalMass, participation: participation,
    makeLenia: makeLenia, makeAsymptotic: makeAsymptotic, makeFlow: makeFlow,
    makeParticle: makeParticle, particleFields: particleFields, fieldGrad: fieldGrad,
    totalEnergy: totalEnergy, totalGrad: totalGrad,
    shuffleField: shuffleField, teleportPoints: teleportPoints,
    BRANCHES: BRANCHES, tallyBranches: tallyBranches, tallyReach: tallyReach
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = S41;
  if (typeof window !== 'undefined') window.S41 = S41;
})(this);
