/**
 * S-08: 拡散が均すのをやめて模様を作る条件（Turing の反応拡散不安定性）
 *
 * 核が持つ概念はこれだけである:
 *
 *   - 周期境界の正方格子の各点に、実数の場が 2 枚（u, v）のっている
 *   - それぞれが自分の拡散係数で拡散する            Du * lap(u),  Dv * lap(v)
 *   - 各点で、その点の値だけから決まる多項式が足される  A - (B+1)u + u^2 v  /  B u - u^2 v
 *   - 時間は陽的 Euler で進める（Jacobi 更新。読む配列と書く配列を分ける）
 *
 * **「模様」も「不安定性」も「活性化因子」も核の中には無い。** どれも観測器とレポートの
 * 側の語である。負コントロールも係数の差し替えだけで作れる——反応を切る（reaction:'none'）、
 * 拡散を等しくする（Dv = Du）。
 *
 * 逆説はここにある: 拡散は単独では必ず均す（あらゆる波数が exp(-D k^2 t) で減る）。
 * 反応だけでも一様状態は安定である（tr J = B-1-A^2 < 0）。**均す働き 2 つと安定な反応を
 * 足すと、特定の波長だけが育つ。** 成立条件は Dv/Du > A^2/(sqrt(B)-1)^2。
 *
 * 依存ゼロ。Node（生ログ生成）とブラウザ（可視化）が同じファイルを読む。
 *
 * 出典（アイデアのみ。コードは参照していない）:
 *   Turing, A. M. (1952) "The Chemical Basis of Morphogenesis",
 *     Phil. Trans. R. Soc. Lond. B 237, 37-72
 *   Prigogine, I. & Lefever, R. (1968) "Symmetry Breaking Instabilities in
 *     Dissipative Systems II", J. Chem. Phys. 48, 1695（Brusselator）
 *
 * 実装上の注記: 数値核なので型付き配列をその場で書き換える（S-01・S-02・S-06 と同じ流儀）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S08 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

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

  var DEFAULTS = {
    size: 256,        // 正方トーラスの一辺（格子点数）。FFT のため 2 の冪であること
    dx: 0.5,          // 格子間隔（物理長）
    A: 4,             // 反応の係数
    B: 9,             // 反応の係数
    Du: 1.0,          // u の拡散係数
    Dv: 8.0,          // v の拡散係数
    dt: null,         // null なら stableDt() で決める
    reaction: 'brusselator', // 'brusselator' | 'none'（'none' は拡散だけの対照系）
    guardEvery: 32,   // 発散検査の間隔（ステップ）
    guardBound: 1e6,
  };

  // ------------------------------------------------------- 時間刻みと安定条件

  /**
   * 陽解法で安全な時間刻み。
   * 2 次元 5 点ラプラシアンの拡散安定条件は dt <= dx^2/(4D)。安全率 2.5 を取る。
   * 反応側は Jacobi 行列の成分が O(A^2 + B) なので、その時間尺度にも上限をかける。
   */
  function stableDt(p) {
    var dmax = Math.max(p.Du, p.Dv);
    var byDiffusion = 0.1 * p.dx * p.dx / Math.max(dmax, 1e-12);
    var byReaction = 0.004;
    return Math.min(byDiffusion, byReaction);
  }

  /** 拡散の安定条件に対する余裕。1 未満なら安全（= dt / (dx^2/(4D))）。 */
  function cflNumber(p) {
    var dt = p.dt != null ? p.dt : stableDt(p);
    return dt * Math.max(p.Du, p.Dv) * 4 / (p.dx * p.dx);
  }

  // --------------------------------------------------------------- 線形解析

  /** 一様不動点。u0 = A, v0 = B/A（厳密）。 */
  function fixedPoint(p) { return { u0: p.A, v0: p.B / p.A }; }

  /** Jacobi 行列 [[fu, fv],[gu, gv]] = [[B-1, A^2],[-B, -A^2]]（不動点上で厳密）。 */
  function jacobian(p) {
    return { fu: p.B - 1, fv: p.A * p.A, gu: -p.B, gv: -p.A * p.A };
  }

  /** 拡散が無いときに一様状態が安定か（tr J < 0 ⇔ B < 1 + A^2）。det J = A^2 > 0 は常に成り立つ。 */
  function homogeneousStable(p) { return p.B < 1 + p.A * p.A; }

  /**
   * 分散関係。q = k^2 に対する最大の成長率を返す。
   *   tr(q) = (B-1-A^2) - (Du+Dv) q
   *   h(q)  = Du Dv q^2 + (A^2 Du - Dv (B-1)) q + A^2
   *   sigma = [tr + sqrt(tr^2 - 4h)] / 2   （判別式が負なら実部 tr/2）
   */
  function growthRate(q, p) {
    var tr = (p.B - 1 - p.A * p.A) - (p.Du + p.Dv) * q;
    var h = p.Du * p.Dv * q * q + (p.A * p.A * p.Du - p.Dv * (p.B - 1)) * q + p.A * p.A;
    var disc = tr * tr - 4 * h;
    return disc >= 0 ? (tr + Math.sqrt(disc)) / 2 : tr / 2;
  }

  /**
   * 離散ラプラシアンで置き換えた場合の成長率。
   * 5 点ラプラシアンは正弦波に対して -k^2 ではなく
   *   -(2/dx^2)[(1-cos(kx dx)) + (1-cos(ky dx))]
   * を返す。格子が粗いときの理論との食い違いはここから来る。
   */
  function latticeGrowthRate(kx, ky, p) {
    var s = (2 / (p.dx * p.dx)) * ((1 - Math.cos(kx * p.dx)) + (1 - Math.cos(ky * p.dx)));
    return growthRate(s, p); // s は「有効な k^2」にあたる
  }

  /** sigma(k) を最大にする k を走査で求める（当てはめの自由度を持たない）。 */
  function fastestMode(p, opts) {
    var o = opts || {};
    var kHi = o.kMax || 40, steps = o.steps || 200000;
    var best = -Infinity, kb = 0;
    for (var i = 1; i <= steps; i++) {
      var k = kHi * i / steps;
      var s = growthRate(k * k, p);
      if (s > best) { best = s; kb = k; }
    }
    return { k: kb, sigma: best, lambda: 2 * Math.PI / kb };
  }

  /** 格子の分散を使った最速モード（軸方向 ky=0 上で走査する）。 */
  function fastestModeLattice(p, opts) {
    var o = opts || {};
    var kHi = Math.PI / p.dx, steps = o.steps || 200000;
    var best = -Infinity, kb = 0;
    for (var i = 1; i <= steps; i++) {
      var k = kHi * i / steps;
      var s = latticeGrowthRate(k, 0, p);
      if (s > best) { best = s; kb = k; }
    }
    return { k: kb, sigma: best, lambda: 2 * Math.PI / kb };
  }

  /** 閾値の閉じた式。Dv/Du がこれを超えると不安定になる。 */
  function criticalRatio(p) {
    return (p.A * p.A) / Math.pow(Math.sqrt(p.B) - 1, 2);
  }

  /** 臨界での波長（閾値ちょうどで選ばれる波長）。 */
  function criticalWavelength(p) {
    return 2 * Math.PI * Math.pow(p.Du * p.Dv / (p.A * p.A), 0.25);
  }

  /** 拡散比を固定したとき不安定になる B の閾値（同じ条件の別の解き方）。 */
  function criticalB(p) {
    return Math.pow(1 + p.A * Math.sqrt(p.Du / p.Dv), 2);
  }

  // ------------------------------------------------------------------- 場

  function createState(params, seed) {
    var p = {};
    Object.keys(DEFAULTS).forEach(function (k) { p[k] = DEFAULTS[k]; });
    Object.keys(params || {}).forEach(function (k) { p[k] = params[k]; });
    if ((p.size & (p.size - 1)) !== 0) throw new Error('size must be a power of two: ' + p.size);
    if (p.dt == null) p.dt = stableDt(p);
    var n = p.size * p.size;
    var fp = fixedPoint(p);
    var st = {
      p: p, n: n, t: 0, stepCount: 0, seed: seed >>> 0,
      rng: makeRng(seed >>> 0),
      u: new Float64Array(n), v: new Float64Array(n),
      ub: new Float64Array(n), vb: new Float64Array(n),
      u0: fp.u0, v0: fp.v0,
      diverged: false,
    };
    st.u.fill(fp.u0);
    st.v.fill(fp.v0);
    return st;
  }

  /** u に相対振幅 eps の一様乱数を乗せる（v は一様のまま）。 */
  function seedNoise(st, eps) {
    for (var i = 0; i < st.n; i++) st.u[i] = st.u0 * (1 + eps * (2 * st.rng() - 1));
    return st;
  }

  /** 大振幅の白色雑音（粗大化の対照系の初期条件）。 */
  function seedWhiteNoise(st, amp) {
    for (var i = 0; i < st.n; i++) {
      st.u[i] = st.u0 * (1 + amp * (2 * st.rng() - 1));
      st.v[i] = st.v0;
    }
    return st;
  }

  /**
   * 単一波数の擾乱を線形固有ベクトルの向きに乗せる（成長率の検証用）。
   * J - q D の最大固有値に属する固有ベクトルを使えば、混合なしに指数成長する。
   */
  function seedMode(st, nx, ny, amp) {
    var p = st.p, L = p.size;
    var kx = 2 * Math.PI * nx / (L * p.dx), ky = 2 * Math.PI * ny / (L * p.dx);
    var q = kx * kx + ky * ky;
    var J = jacobian(p);
    var a11 = J.fu - p.Du * q, a12 = J.fv, a21 = J.gu, a22 = J.gv - p.Dv * q;
    var tr = a11 + a22, det = a11 * a22 - a12 * a21;
    var disc = tr * tr - 4 * det;
    var lam = disc >= 0 ? (tr + Math.sqrt(disc)) / 2 : tr / 2;
    // (a11 - lam) x + a12 y = 0  →  固有ベクトル (a12, lam - a11)
    var ex = a12, ey = lam - a11;
    var norm = Math.sqrt(ex * ex + ey * ey) || 1;
    ex /= norm; ey /= norm;
    for (var y = 0; y < L; y++) {
      for (var x = 0; x < L; x++) {
        var c = Math.cos(kx * x * p.dx + ky * y * p.dx);
        st.u[y * L + x] = st.u0 + amp * ex * c;
        st.v[y * L + x] = st.v0 + amp * ey * c;
      }
    }
    return { kx: kx, ky: ky, k: Math.sqrt(q), sigmaPredicted: lam, ex: ex, ey: ey };
  }

  // --------------------------------------------------------------- 時間発展

  /**
   * 1 ステップ（Jacobi。読む配列と書く配列を分けて、最後に入れ替える）。
   * **同じ配列を読み書きすると Gauss-Seidel になり、しかもそれらしい絵が出てしまう**
   * （method.md K-12 の形）。selftest で素朴実装との一致を検査している。
   */
  function step(st) {
    var p = st.p, L = p.size, dt = p.dt, dx2 = p.dx * p.dx;
    var cu = p.Du * dt / dx2, cv = p.Dv * dt / dx2;
    var A = p.A, B1 = p.B + 1, B = p.B;
    var react = p.reaction !== 'none';
    var u = st.u, v = st.v, ub = st.ub, vb = st.vb;
    for (var y = 0; y < L; y++) {
      var y0 = y * L, yn = ((y - 1 + L) % L) * L, yp = ((y + 1) % L) * L;
      for (var x = 0; x < L; x++) {
        var i = y0 + x;
        var xn = y0 + ((x - 1 + L) % L), xp = y0 + ((x + 1) % L);
        var U = u[i], V = v[i];
        var lu = u[xn] + u[xp] + u[yn + x] + u[yp + x] - 4 * U;
        var lv = v[xn] + v[xp] + v[yn + x] + v[yp + x] - 4 * V;
        if (react) {
          var uuv = U * U * V;
          ub[i] = U + cu * lu + dt * (A - B1 * U + uuv);
          vb[i] = V + cv * lv + dt * (B * U - uuv);
        } else {
          ub[i] = U + cu * lu;
          vb[i] = V + cv * lv;
        }
      }
    }
    st.u = ub; st.ub = u; st.v = vb; st.vb = v;
    st.t += dt; st.stepCount++;
    return st;
  }

  /**
   * 素朴な参照実装。毎回まるごと複製してから読む。速い実装の検算用（method.md K-12）。
   */
  function stepNaive(st) {
    var p = st.p, L = p.size, dt = p.dt, dx2 = p.dx * p.dx;
    var cu = p.Du * dt / dx2, cv = p.Dv * dt / dx2;
    var react = p.reaction !== 'none';
    var U = Float64Array.from(st.u), V = Float64Array.from(st.v);
    for (var y = 0; y < L; y++) {
      for (var x = 0; x < L; x++) {
        var i = y * L + x;
        var lu = U[y * L + ((x + L - 1) % L)] + U[y * L + ((x + 1) % L)]
               + U[((y + L - 1) % L) * L + x] + U[((y + 1) % L) * L + x] - 4 * U[i];
        var lv = V[y * L + ((x + L - 1) % L)] + V[y * L + ((x + 1) % L)]
               + V[((y + L - 1) % L) * L + x] + V[((y + 1) % L) * L + x] - 4 * V[i];
        var r1 = react ? (p.A - (p.B + 1) * U[i] + U[i] * U[i] * V[i]) : 0;
        var r2 = react ? (p.B * U[i] - U[i] * U[i] * V[i]) : 0;
        st.u[i] = U[i] + cu * lu + dt * r1;
        st.v[i] = V[i] + cv * lv + dt * r2;
      }
    }
    st.t += dt; st.stepCount++;
    return st;
  }

  /** 発散していないか（有限で、範囲に収まっているか）。 */
  function checkFinite(st) {
    var b = st.p.guardBound, u = st.u, v = st.v;
    for (var i = 0; i < st.n; i++) {
      var a = u[i], c = v[i];
      if (!(a > -b && a < b) || !(c > -b && c < b)) { st.diverged = true; return false; }
    }
    return true;
  }

  /** n ステップ進める。発散したら直ちに止める（戻り値 false）。 */
  function advance(st, nSteps, onProgress) {
    var g = st.p.guardEvery;
    for (var s = 0; s < nSteps; s++) {
      step(st);
      if ((st.stepCount % g) === 0 && !checkFinite(st)) return false;
      if (onProgress && (st.stepCount % g) === 0) onProgress(st);
    }
    return !st.diverged;
  }

  /** 物理時間 T まで進める。 */
  function advanceTo(st, T, onProgress) {
    var need = Math.max(0, Math.round((T - st.t) / st.p.dt));
    return advance(st, need, onProgress);
  }

  /** 拡散項だけを 1 ステップ適用する（保存則の検査用）。 */
  function diffuseOnly(st) {
    var saved = st.p.reaction;
    st.p.reaction = 'none';
    step(st);
    st.p.reaction = saved;
    return st;
  }

  /** 格子点を無作為に並べ替える（1 点統計を保ったまま空間相関を壊す対照系）。 */
  function scramble(field, rng) {
    var out = Float64Array.from(field);
    for (var i = out.length - 1; i > 0; i--) {
      var j = (rng() * (i + 1)) | 0;
      var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  }

  // ------------------------------------------------------------------- FFT

  /** 基数 2 の反復 FFT（その場で書き換える）。長さは 2 の冪。 */
  function fft(re, im) {
    var n = re.length;
    for (var i = 1, j = 0; i < n; i++) {
      var bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr;
        var ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var ang = -2 * Math.PI / len;
      var wr = Math.cos(ang), wi = Math.sin(ang);
      for (var k = 0; k < n; k += len) {
        var cr = 1, ci = 0;
        for (var m = 0; m < len / 2; m++) {
          var ar = re[k + m], ai = im[k + m];
          var br = re[k + m + len / 2], bi = im[k + m + len / 2];
          var xr = br * cr - bi * ci, xi = br * ci + bi * cr;
          re[k + m] = ar + xr; im[k + m] = ai + xi;
          re[k + m + len / 2] = ar - xr; im[k + m + len / 2] = ai - xi;
          var ncr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr; cr = ncr;
        }
      }
    }
  }

  /** 2 次元パワースペクトル |F(kx,ky)|^2 を返す（長さ L*L）。 */
  function power2d(field, L) {
    var re = new Float64Array(L * L), im = new Float64Array(L * L);
    re.set(field);
    var rr = new Float64Array(L), ri = new Float64Array(L);
    var y, x;
    for (y = 0; y < L; y++) {
      for (x = 0; x < L; x++) { rr[x] = re[y * L + x]; ri[x] = im[y * L + x]; }
      fft(rr, ri);
      for (x = 0; x < L; x++) { re[y * L + x] = rr[x]; im[y * L + x] = ri[x]; }
    }
    var cr = new Float64Array(L), ci = new Float64Array(L);
    for (x = 0; x < L; x++) {
      for (y = 0; y < L; y++) { cr[y] = re[y * L + x]; ci[y] = im[y * L + x]; }
      fft(cr, ci);
      for (y = 0; y < L; y++) { re[y * L + x] = cr[y]; im[y * L + x] = ci[y]; }
    }
    var pw = new Float64Array(L * L);
    for (var i = 0; i < L * L; i++) pw[i] = re[i] * re[i] + im[i] * im[i];
    return pw;
  }

  /**
   * |k| の環ごとに足し上げたスペクトル S(n)（n = 0..L/2）。
   * 環の「幅」は格子の分解能そのもの（四捨五入で 1 単位）であり、選べる自由度は無い。
   */
  function radialSpectrum(field, L) {
    var pw = power2d(field, L);
    var nmax = L / 2;
    var S = new Float64Array(nmax + 1);
    var total = 0, binned = 0;
    for (var y = 0; y < L; y++) {
      var fy = y <= L / 2 ? y : y - L;
      for (var x = 0; x < L; x++) {
        var fx = x <= L / 2 ? x : x - L;
        var r = Math.round(Math.sqrt(fx * fx + fy * fy));
        var w = pw[y * L + x];
        if (fx !== 0 || fy !== 0) {
          total += w;
          if (r <= nmax) { S[r] += w; binned += w; }
        }
      }
    }
    // totalPower: 直流を除く全パワー（Parseval の検算に使う）。
    // binnedPower: そのうち環（r <= nmax）に入ったぶん。差は正方ブリルアン域の四隅にあたる。
    return { S: S, nmax: nmax, totalPower: total, binnedPower: binned };
  }

  /**
   * 環状スペクトルの最大点を、対数パワーの放物線補間で小数まで求める。
   * n=0（平均）は除く。頂点が端（n=1 または nmax）なら interior=false。
   */
  function peakWavelength(spec, L, dx) {
    var S = spec.S, nmax = spec.nmax;
    var best = 1, i;
    for (i = 1; i <= nmax; i++) if (S[i] > S[best]) best = i;
    var nHat = best;
    if (best > 1 && best < nmax) {
      var a = Math.log(S[best - 1] + 1e-300), b = Math.log(S[best] + 1e-300), c = Math.log(S[best + 1] + 1e-300);
      var den = a - 2 * b + c;
      if (den < -1e-12) nHat = best + 0.5 * (a - c) / den;
      if (!(nHat > 0.5 && nHat < nmax)) nHat = best;
    }
    return {
      n: best, nHat: nHat,
      interior: best >= 2 && best <= nmax - 2,
      lambda: (L * dx) / nHat,
    };
  }

  /** 1 次モーメント <n> から出した波長（測り方の依存を見るための副次の量）。 */
  function momentWavelength(spec, L, dx) {
    var S = spec.S, nmax = spec.nmax, num = 0, den = 0;
    for (var i = 1; i <= nmax; i++) { num += i * S[i]; den += S[i]; }
    var nBar = den > 0 ? num / den : 0;
    return { nBar: nBar, lambda: nBar > 0 ? (L * dx) / nBar : Infinity };
  }

  // --------------------------------------------------------------- 観測器

  function fieldStats(field) {
    var n = field.length, sum = 0, mn = Infinity, mx = -Infinity, ok = true;
    for (var i = 0; i < n; i++) {
      var a = field[i];
      if (!isFinite(a)) { ok = false; break; }
      sum += a; if (a < mn) mn = a; if (a > mx) mx = a;
    }
    if (!ok) return { finite: false, mean: NaN, sd: NaN, min: NaN, max: NaN, cv: NaN };
    var mean = sum / n, s2 = 0;
    for (var j = 0; j < n; j++) { var d = field[j] - mean; s2 += d * d; }
    var sd = Math.sqrt(s2 / n);
    return { finite: true, mean: mean, sd: sd, min: mn, max: mx, cv: mean !== 0 ? sd / Math.abs(mean) : Infinity };
  }

  /**
   * 観測器。**呼ばれるたびに現在の場から測り直す**（キャッシュを持たない。K-12）。
   * 理論側（lambdaTheory）は state のパラメータだけから決まり、当てはめの自由度を持たない。
   *
   * 波長の主の測り方は**環状スペクトルの 1 次モーメント**にしてある。頂点（argmax）は
   * 単一の実現では環ごとの揺らぎに支配され、スペクトルが広い場では argmax が飛ぶ
   * （criteria.json rev2 の理由を参照）。モーメントは全ての環を重みつきで使うので揺らぎに強い。
   * 頂点のほうが鋭いスペクトルには正確なので、副次として併記する（K-9）。
   */
  function measure(st) {
    var p = st.p, L = p.size;
    var us = fieldStats(st.u), vs = fieldStats(st.v);
    if (!us.finite || !vs.finite || st.diverged) {
      return { finite: false, t: st.t, amplitude: null, lambdaObs: null, lambdaPeak: null,
               lambdaTheory: null, lambdaRatio: null, interior: null, nPeak: null };
    }
    var spec = radialSpectrum(st.u, L);
    var pk = peakWavelength(spec, L, p.dx);
    var mo = momentWavelength(spec, L, p.dx);
    var th = fastestMode(p);
    var thLat = fastestModeLattice(p);
    return {
      finite: true,
      t: st.t,
      amplitude: us.cv,
      uMean: us.mean, uSd: us.sd, uMin: us.min, uMax: us.max,
      vMean: vs.mean, vSd: vs.sd,
      nPeak: pk.n, nHat: pk.nHat, nBar: mo.nBar, interior: pk.interior,
      lambdaObs: mo.lambda,          // 主: 1 次モーメント
      lambdaPeak: pk.lambda,         // 副次: 頂点
      lambdaTheory: th.lambda,
      lambdaTheoryLattice: thLat.lambda,
      sigmaTheory: th.sigma,
      lambdaRatio: mo.lambda / th.lambda,
      lambdaPeakRatio: pk.lambda / th.lambda,
      lambdaRatioLattice: mo.lambda / thLat.lambda,
      spectrum: spec,
    };
  }

  /**
   * 事前登録した連言（criteria.json の primaryDefinition と同じ）。
   * opts.lambdaTheory を渡すと、その理論波長に対して判定する
   * （対照系を「目当ての系の理論値」に照らして落とせるかを見るために要る）。
   */
  function verdict(mEnd, mMid, opts) {
    var o = opts || {};
    var t = { amplitude: o.amplitude != null ? o.amplitude : 0.05,
              lambdaRatio: o.lambdaRatio != null ? o.lambdaRatio : 0.35,
              lambdaDrift: o.lambdaDrift != null ? o.lambdaDrift : 0.15 };
    if (!mEnd || !mEnd.finite) {
      return { turingDetected: false, finite: false, ampOk: null, interiorOk: null,
               lambdaOk: null, driftOk: null, lambdaDrift: null, lambdaRatio: null };
    }
    var lamTh = o.lambdaTheory != null ? o.lambdaTheory : mEnd.lambdaTheory;
    var ratio = mEnd.lambdaObs / lamTh;
    var peakRatio = mEnd.lambdaPeak / lamTh;
    var drift = (mMid && mMid.finite && mMid.lambdaObs) ? mEnd.lambdaObs / mMid.lambdaObs : null;
    var peakDrift = (mMid && mMid.finite && mMid.lambdaPeak) ? mEnd.lambdaPeak / mMid.lambdaPeak : null;
    var ampOk = mEnd.amplitude >= t.amplitude;
    var interiorOk = !!mEnd.interior;
    var lambdaOk = Math.abs(ratio - 1) <= t.lambdaRatio;
    var driftOk = drift != null ? Math.abs(drift - 1) <= t.lambdaDrift : false;
    return {
      turingDetected: ampOk && interiorOk && lambdaOk && driftOk,
      finite: true, ampOk: ampOk, interiorOk: interiorOk, lambdaOk: lambdaOk, driftOk: driftOk,
      lambdaRatio: ratio, lambdaPeakRatio: peakRatio,
      lambdaDrift: drift, lambdaPeakDrift: peakDrift,
      lambdaTheoryUsed: lamTh,
    };
  }

  // ------------------------------------------------- 手で組んだ場（検出器の検査用）

  /** 既知の波長 lambda0・角度 theta の縞。検出器の正コントロール。 */
  function makeStripes(L, dx, lambda0, theta, amp, mean) {
    var f = new Float64Array(L * L);
    var k = 2 * Math.PI / lambda0;
    var kx = k * Math.cos(theta), ky = k * Math.sin(theta);
    for (var y = 0; y < L; y++) {
      for (var x = 0; x < L; x++) f[y * L + x] = mean + amp * Math.cos(kx * x * dx + ky * y * dx);
    }
    return f;
  }

  /** 素朴な離散ラプラシアン（周期境界）。単位の確認用。 */
  function laplacian(field, L, dx) {
    var out = new Float64Array(L * L), dx2 = dx * dx;
    for (var y = 0; y < L; y++) {
      for (var x = 0; x < L; x++) {
        var i = y * L + x;
        out[i] = (field[y * L + ((x + L - 1) % L)] + field[y * L + ((x + 1) % L)]
                + field[((y + L - 1) % L) * L + x] + field[((y + 1) % L) * L + x]
                - 4 * field[i]) / dx2;
      }
    }
    return out;
  }

  /** 場の総量（拡散のみのとき保存される）。 */
  function totalMass(field, dx) {
    var s = 0;
    for (var i = 0; i < field.length; i++) s += field[i];
    return s * dx * dx;
  }

  /** 単一モードの振幅（成長率の検証用）。cos(k.x) 成分に射影する。 */
  function modeAmplitude(field, L, dx, nx, ny) {
    var kx = 2 * Math.PI * nx / (L * dx), ky = 2 * Math.PI * ny / (L * dx);
    var cr = 0, ci = 0;
    for (var y = 0; y < L; y++) {
      for (var x = 0; x < L; x++) {
        var ph = kx * x * dx + ky * y * dx;
        var f = field[y * L + x];
        cr += f * Math.cos(ph); ci += f * Math.sin(ph);
      }
    }
    return 2 * Math.sqrt(cr * cr + ci * ci) / (L * L);
  }

  return {
    DEFAULTS: DEFAULTS,
    makeRng: makeRng,
    stableDt: stableDt,
    cflNumber: cflNumber,
    fixedPoint: fixedPoint,
    jacobian: jacobian,
    homogeneousStable: homogeneousStable,
    growthRate: growthRate,
    latticeGrowthRate: latticeGrowthRate,
    fastestMode: fastestMode,
    fastestModeLattice: fastestModeLattice,
    criticalRatio: criticalRatio,
    criticalWavelength: criticalWavelength,
    criticalB: criticalB,
    createState: createState,
    seedNoise: seedNoise,
    seedWhiteNoise: seedWhiteNoise,
    seedMode: seedMode,
    step: step,
    stepNaive: stepNaive,
    advance: advance,
    advanceTo: advanceTo,
    diffuseOnly: diffuseOnly,
    checkFinite: checkFinite,
    scramble: scramble,
    fft: fft,
    power2d: power2d,
    radialSpectrum: radialSpectrum,
    peakWavelength: peakWavelength,
    momentWavelength: momentWavelength,
    fieldStats: fieldStats,
    measure: measure,
    verdict: verdict,
    makeStripes: makeStripes,
    laplacian: laplacian,
    totalMass: totalMass,
    modeAmplitude: modeAmplitude,
  };
});
