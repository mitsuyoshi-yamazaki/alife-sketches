/**
 * S-58 の核。2型の粒子（A・B）が物質 α・β を撒き、格子場が拡散・減衰し、粒子は自分の燃料で
 * 場の勾配へ推進力を払う。太陽→餌→燃料→運動→場→熱の6区画・11本の流れをその場で厳密に積む。
 *
 * criteria.json の system 節をそのままコードにしたもの。上位概念の語彙（cell / gene / fitness /
 * alive 等）は使わない——観測器（tracking.js）の側だけがそれを使ってよい。
 *
 * Node と ブラウザの両方で使う（UMD 風）。ESM にしない（file:// で開けるように）。
 */
'use strict';
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.S58 = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  // ── 単位: σ(円板の直径)=1, m=1, γ=1(τ=1/γ) ──────────────────────────────
  const SIGMA = 1;
  const MASS = 1;

  // ── 乱数（mulberry32 + Box-Muller）。同じ seed で完全に再現する ─────────
  function makeRng(seed) {
    let s = (seed >>> 0) || 0x9e3779b9;
    return function rng() {
      s |= 0; s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function gaussianFactory(rng) {
    let spare = null;
    return function gaussian() {
      if (spare !== null) { const v = spare; spare = null; return v; }
      let u, v, s2;
      do { u = 2 * rng() - 1; v = 2 * rng() - 1; s2 = u * u + v * v; } while (s2 >= 1 || s2 === 0);
      const mul = Math.sqrt(-2 * Math.log(s2) / s2);
      spare = v * mul;
      return u * mul;
    };
  }
  /** seed から複数の独立な部分列を作る（位置・速度・探索方向で乱数を混ぜないため）。 */
  function subSeed(seed, idx) { return ((seed >>> 0) * 2654435761 + idx * 40503) >>> 0; }

  // ── パラメータ（criteria.json system節）。δ・I・seed 等だけ呼び出し側が変える ──
  function defaultParams(overrides) {
    const p = {
      L: 64, M: 64, dt: 0.02,
      D: 5, kField: 0.2, kFood: 0.02,
      fmax: 100, gamma: 1,
      motorFmax: 1, g0: 0.01, chiF: 0.5, F0: 1, gF: 0.2, Fe: 0.2, Dr: 0.5,
      bMetab: 0.2, qSecrete: 1, ec: 0.2, etam: 0.25, rEat: 0.2,
      s: 1, delta: 0.5,
      I: 0.5,
      sunMode: 'main', // 'main' | 'dusk' | 'none'
      duskAt: 1000,
      freeArm: false,
      blind: false, // NC-blind: χ(化学応答)を0に(食への応答は残す)
      initialFuel: 50,
      leakMode: 'none', // 'none' | 'eatleak' | 'heatloss' (PC-Eの較正専用)
      integrator: 'default',
    };
    return Object.assign(p, overrides || {});
  }
  function buildChi(p) {
    if (p.blind) return { A: { alpha: 0, beta: 0 }, B: { alpha: 0, beta: 0 } };
    return { A: { alpha: p.s, beta: p.delta }, B: { alpha: -p.delta, beta: p.s } };
  }
  /** 太陽の初期蓄え S_0。sunMode='none'(NC-dark) は 0。 */
  function initialSunStock(p) {
    if (p.sunMode === 'none') return 0;
    const cells = p.M * p.M;
    if (p.sunMode === 'dusk') return p.I * cells * 1000;
    return p.I * cells * 2500;
  }

  // ── 場の格子（周期境界、node中心） ──────────────────────────────────────
  function fieldIndex(i, j, M) { const ii = ((i % M) + M) % M, jj = ((j % M) + M) % M; return jj * M + ii; }
  function sumArr(a) { let s = 0; for (let k = 0; k < a.length; k++) s += a[k]; return s; }

  /** CIC(双一次)の重み。x,y は [0,L) の連続座標。 */
  function cicWeights(x, y, h, M) {
    const gx = x / h, gy = y / h;
    let i0 = Math.floor(gx), j0 = Math.floor(gy);
    const fx = gx - i0, fy = gy - j0;
    i0 = ((i0 % M) + M) % M; j0 = ((j0 % M) + M) % M;
    const i1 = (i0 + 1) % M, j1 = (j0 + 1) % M;
    return {
      idx: [fieldIndex(i0, j0, M), fieldIndex(i1, j0, M), fieldIndex(i0, j1, M), fieldIndex(i1, j1, M)],
      w: [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy],
      i0, j0,
    };
  }
  /** 質量 amount を密度として4節点へCICで撒く（Σ field*h^2 の増分が amount に一致）。 */
  function depositCIC(field, cw, amount, h) {
    const inv = amount / (h * h);
    for (let k = 0; k < 4; k++) field[cw.idx[k]] += inv * cw.w[k];
  }
  /** 4節点から重みに比例して amount を引く（depositCICの逆）。呼び出し側が上限を守る前提。 */
  function withdrawCIC(field, cw, amount, h) {
    const inv = amount / (h * h);
    for (let k = 0; k < 4; k++) field[cw.idx[k]] -= inv * cw.w[k];
  }
  /**
   * want を上限に、4節点のどれも負にしない範囲で実際に引ける量を求めて引く。
   * K-12型の欠陥（見た目の値と実際に取れる量がずれる）を避けるため、gatherScalar(補間値)で
   * 「欲しい量」を決めた後は、必ずこの関数で「本当に取れる量」に絞ってから使う――
   * そうしないと粒子が密集した節点で補間値は正でも実際の蓄えが足りず、摂食量と場の減少量が
   * 食い違って台帳が破れる（1粒子では起きず、密集で顕在化する。selftestに較正あり）。
   */
  function withdrawCICLimited(field, cw, want, h) {
    if (want <= 0) return 0;
    let capByNodes = Infinity;
    for (let k = 0; k < 4; k++) {
      if (cw.w[k] <= 0) continue;
      const nodeCap = (field[cw.idx[k]] * h * h) / cw.w[k];
      capByNodes = Math.min(capByNodes, nodeCap);
    }
    const actual = Math.max(0, Math.min(want, capByNodes));
    if (actual > 0) withdrawCIC(field, cw, actual, h);
    return actual;
  }
  /** CIC重みでの補間値（密度そのもの、h^2倍しない）。 */
  function gatherScalar(field, cw) {
    let v = 0; for (let k = 0; k < 4; k++) v += cw.w[k] * field[cw.idx[k]]; return v;
  }
  /**
   * 勾配を「節点で中心差分→撒くときと同じCICの重みで集める」。この組み合わせが
   * 静止粒子の自己力を厳密に0にする（positiveControls[1]）。
   */
  function gatherGradient(field, cw, h, M) {
    let gx = 0, gy = 0;
    const i0 = cw.i0, j0 = cw.j0;
    for (let k = 0; k < 4; k++) {
      const di = k === 1 || k === 3 ? 1 : 0, dj = k === 2 || k === 3 ? 1 : 0;
      const i = i0 + di, j = j0 + dj;
      const cxNode = (field[fieldIndex(i + 1, j, M)] - field[fieldIndex(i - 1, j, M)]) / (2 * h);
      const cyNode = (field[fieldIndex(i, j + 1, M)] - field[fieldIndex(i, j - 1, M)]) / (2 * h);
      gx += cw.w[k] * cxNode; gy += cw.w[k] * cyNode;
    }
    return { gx, gy };
  }

  /** 5点ラプラシアンの陽的Euler + 厳密減衰因子。質量の変化量(=減衰で失った量)を返す。 */
  /**
   * 5点ラプラシアンの陽的Eulerはh(格子の刻み)が小さくなるほどCFL条件(2D: D dt/h^2 <= 1/4)に
   * 近づき、破ると数値的に発散してNaNへ至る(ceilings[3]の格子の検査 h=0.5・M=128 で実際に踏んだ:
   * 登録どおりのD=5・dt=0.02では D dt/h^2 = 0.1(h=1)から 0.4(h=0.5)へ上がり不安定域に入る)。
   * dt・hそのものは登録どおりに保ち、**拡散の内部だけ**を安全な回数に割って繰り返すことで
   * 同じ1刻みを表す(1ステップが表す物理時間・粒子側のdtは一切変えない)。h=1(主格子)では
   * D dt/h^2=0.1<=0.2なのでnSub=1のまま――既存の走行(main/A-dusk/NC-dark/NC-blind)の結果は
   * 数式・ビットレベルで変わらない。減衰は正確な指数なので割らずに1回で適用する。
   */
  function diffuseAndDecayField(field, D, kField, dt, h, M) {
    const before = sumArr(field);
    const coefFull = D * dt / (h * h);
    const nSub = coefFull > 0.2 ? Math.max(1, Math.ceil(coefFull / 0.2)) : 1;
    const subDt = dt / nSub;
    const coef = D * subDt / (h * h);
    const tmp = new Float64Array(field.length);
    for (let s = 0; s < nSub; s++) {
      for (let j = 0; j < M; j++) {
        for (let i = 0; i < M; i++) {
          const idx = fieldIndex(i, j, M);
          const lap = field[fieldIndex(i + 1, j, M)] + field[fieldIndex(i - 1, j, M)]
            + field[fieldIndex(i, j + 1, M)] + field[fieldIndex(i, j - 1, M)] - 4 * field[idx];
          tmp[idx] = field[idx] + coef * lap;
        }
      }
      field.set(tmp);
    }
    const decay = Math.exp(-kField * dt);
    const afterDiffusionMass = sumArr(field);
    for (let k = 0; k < field.length; k++) field[k] *= decay;
    const lost = afterDiffusionMass - sumArr(field);
    return { before, afterDiffusion: afterDiffusionMass, lost };
  }

  // ── 系の生成と初期化 ─────────────────────────────────────────────────
  function createSystem(N, L, M) {
    M = M || L;
    const sys = {
      N, L, M, h: L / M,
      type: new Uint8Array(N),
      x: new Float64Array(N), y: new Float64Array(N),
      vx: new Float64Array(N), vy: new Float64Array(N),
      fuel: new Float64Array(N), theta: new Float64Array(N),
      cA: new Float64Array(M * M), cB: new Float64Array(M * M), F: new Float64Array(M * M),
      S: 0, H: 0, unpaidWork: 0, leakCounter: 0,
      flow: { sun: 0, foodDecay: 0, eat: 0, metab: 0, secrete: 0, chemDecay: 0, work: 0, propLoss: 0, friction: 0, braking: 0, contact: 0 },
      t: 0,
    };
    return sys;
  }

  function wrap(v, L) { let r = v % L; if (r < 0) r += L; return r; }
  /** 最小像の変位（周期境界）。 */
  function minImageDelta(a, b, L) { let d = a - b; d -= L * Math.round(d / L); return d; }

  /** 最小間隔 minGap での逐次付加による初期配置（周期境界、セル表で近傍探索）。 */
  function randomSequentialFill(N, L, minGap, rng) {
    const x = new Float64Array(N), y = new Float64Array(N);
    const cellSize = Math.max(minGap, 0.5);
    const nc = Math.max(1, Math.floor(L / cellSize));
    const cellOf = (v) => Math.min(nc - 1, Math.floor(wrap(v, L) / (L / nc)));
    const buckets = new Map();
    const key = (ci, cj) => ci * nc + cj;
    function tryPlace(px, py) {
      const ci = cellOf(px), cj = cellOf(py);
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          const k = key(((ci + di) % nc + nc) % nc, ((cj + dj) % nc + nc) % nc);
          const list = buckets.get(k);
          if (!list) continue;
          for (const idx of list) {
            const dx = minImageDelta(px, x[idx], L), dy = minImageDelta(py, y[idx], L);
            if (Math.hypot(dx, dy) < minGap) return false;
          }
        }
      }
      return true;
    }
    for (let n = 0; n < N; n++) {
      let placed = false;
      for (let attempt = 0; attempt < 3000 && !placed; attempt++) {
        const px = rng() * L, py = rng() * L;
        if (tryPlace(px, py)) {
          x[n] = px; y[n] = py;
          const k = key(cellOf(px), cellOf(py));
          if (!buckets.has(k)) buckets.set(k, []);
          buckets.get(k).push(n);
          placed = true;
        }
      }
      if (!placed) { x[n] = rng() * L; y[n] = rng() * L; } // 埋まらなければ諦めて置く(密度が高い較正用途のみ)
    }
    return { x, y };
  }

  /**
   * 1本の走行を初期化する。protocol（arm）→ params → system の変換。
   * A を前半・B を後半に割り当てる（seed に依らない。criteria.json whatSeedChanges）。
   */
  function initReplicate(p) {
    const N = p.N != null ? p.N : 512;
    const sys = createSystem(N, p.L, p.M);
    const posRng = makeRng(subSeed(p.seed, 1));
    const dirRng = makeRng(subSeed(p.seed, 2));
    const nA = Math.floor(N / 2);
    for (let i = 0; i < N; i++) sys.type[i] = i < nA ? 0 : 1;
    const fill = randomSequentialFill(N, p.L, 1.0, posRng);
    sys.x.set(fill.x); sys.y.set(fill.y);
    for (let i = 0; i < N; i++) { sys.theta[i] = dirRng() * 2 * Math.PI; sys.fuel[i] = p.initialFuel; }
    const Fstar = p.sunMode === 'none' ? 0 : p.I / p.kFood;
    for (let k = 0; k < sys.F.length; k++) sys.F[k] = Fstar;
    sys.S = initialSunStock(p);
    return sys;
  }

  // ── 接触（セル表・法線方向の速度を対称に除去・位置を対称に分離） ─────────
  function buildCellList(sys, cellSize) {
    const nc = Math.max(1, Math.floor(sys.L / cellSize));
    const w = sys.L / nc;
    const cellOf = (v) => Math.min(nc - 1, Math.floor(wrap(v, sys.L) / w));
    const buckets = new Array(nc * nc);
    for (let k = 0; k < buckets.length; k++) buckets[k] = [];
    for (let i = 0; i < sys.N; i++) buckets[cellOf(sys.x[i]) * nc + cellOf(sys.y[i])].push(i);
    return { nc, buckets, cellOf };
  }
  function forEachNearbyPair(sys, cellSize, cb) {
    const cl = buildCellList(sys, Math.max(cellSize, 1));
    const nc = cl.nc;
    for (let ci = 0; ci < nc; ci++) {
      for (let cj = 0; cj < nc; cj++) {
        const here = cl.buckets[ci * nc + cj];
        for (let di = 0; di <= 1; di++) {
          for (let dj = (di === 0 ? 0 : -1); dj <= 1; dj++) {
            const oci = ((ci + di) % nc + nc) % nc, ocj = ((cj + dj) % nc + nc) % nc;
            if (di === 0 && dj === 0 && !(oci === ci && ocj === cj)) continue;
            const other = cl.buckets[oci * nc + ocj];
            for (let a = 0; a < here.length; a++) {
              const startB = (oci === ci && ocj === cj) ? a + 1 : 0;
              for (let b = startB; b < other.length; b++) {
                const i = here[a], j = other[b];
                if (i === j) continue;
                cb(i, j);
              }
            }
          }
        }
      }
    }
  }
  function findOverlappingPairs(sys, rb) {
    const pairs = [];
    const seen = new Set();
    forEachNearbyPair(sys, rb, (i, j) => {
      const key = i < j ? i * sys.N + j : j * sys.N + i;
      if (seen.has(key)) return; seen.add(key);
      const dx = minImageDelta(sys.x[i], sys.x[j], sys.L), dy = minImageDelta(sys.y[i], sys.y[j], sys.L);
      const r = Math.hypot(dx, dy);
      if (r < rb) pairs.push([i, j, r, dx, dy]);
    });
    return pairs;
  }
  /** 重なった対の法線接近速度を対称に除去(運動量保存・運動→熱)。戻り値: 除去したKE。 */
  function resolveContactVelocities(sys) {
    let heat = 0;
    const pairs = findOverlappingPairs(sys, SIGMA);
    for (const [i, j, r] of pairs) {
      if (r < 1e-9) continue;
      const dx = minImageDelta(sys.x[i], sys.x[j], sys.L), dy = minImageDelta(sys.y[i], sys.y[j], sys.L);
      const nx = dx / r, ny = dy / r;
      const vrelN = (sys.vx[i] - sys.vx[j]) * nx + (sys.vy[i] - sys.vy[j]) * ny;
      if (vrelN >= 0) continue; // 離れつつある対は触らない
      const kBefore = 0.5 * MASS * (sys.vx[i] * sys.vx[i] + sys.vy[i] * sys.vy[i] + sys.vx[j] * sys.vx[j] + sys.vy[j] * sys.vy[j]);
      const imp = -0.5 * vrelN;
      sys.vx[i] += imp * nx; sys.vy[i] += imp * ny;
      sys.vx[j] -= imp * nx; sys.vy[j] -= imp * ny;
      const kAfter = 0.5 * MASS * (sys.vx[i] * sys.vx[i] + sys.vy[i] * sys.vy[i] + sys.vx[j] * sys.vx[j] + sys.vy[j] * sys.vy[j]);
      heat += Math.max(0, kBefore - kAfter);
    }
    return heat;
  }
  /** 重なりを位置で対称に解消する(4回掃く)。エネルギーには触れない。 */
  function resolveContactPositions(sys, sweeps) {
    for (let s = 0; s < (sweeps || 4); s++) {
      const pairs = findOverlappingPairs(sys, SIGMA);
      for (const [i, j, r] of pairs) {
        if (r < 1e-9) continue;
        const dx = minImageDelta(sys.x[i], sys.x[j], sys.L), dy = minImageDelta(sys.y[i], sys.y[j], sys.L);
        const nx = dx / r, ny = dy / r, overlap = SIGMA - r;
        sys.x[i] = wrap(sys.x[i] + 0.5 * overlap * nx, sys.L); sys.y[i] = wrap(sys.y[i] + 0.5 * overlap * ny, sys.L);
        sys.x[j] = wrap(sys.x[j] - 0.5 * overlap * nx, sys.L); sys.y[j] = wrap(sys.y[j] - 0.5 * overlap * ny, sys.L);
      }
    }
  }

  // ── 台帳の読み出し ──────────────────────────────────────────────────
  function kineticEnergy(sys) {
    let K = 0; for (let i = 0; i < sys.N; i++) K += 0.5 * MASS * (sys.vx[i] * sys.vx[i] + sys.vy[i] * sys.vy[i]);
    return K;
  }
  function totalMomentum(sys) {
    let px = 0, py = 0; for (let i = 0; i < sys.N; i++) { px += MASS * sys.vx[i]; py += MASS * sys.vy[i]; } return { px, py };
  }
  function foodTotal(sys) { return sumArr(sys.F) * sys.h * sys.h; }
  function fuelTotal(sys) { let s = 0; for (let i = 0; i < sys.N; i++) s += sys.fuel[i]; return s; }
  function chemTotal(sys, ec) { return ec * (sumArr(sys.cA) + sumArr(sys.cB)) * sys.h * sys.h; }
  /** sys.Sは登録どおりの生の単位(節点あたり)で持つ。台帳としてはFood/Chemと同じh^2倍した真の量で読む。 */
  function ledgerSnapshot(sys, p) {
    return { S: sys.S * sys.h * sys.h, Food: foodTotal(sys), Fuel: fuelTotal(sys), K: kineticEnergy(sys), Chem: chemTotal(sys, p.ec), H: sys.H };
  }
  function eTot(led) { return led.S + led.Food + led.Fuel + led.K + led.Chem + led.H; }

  // ── 1粒子ぶんの摂食・代謝・撒く・推進の会計（step本体から呼ぶ） ────────
  function particleMotorForce(sys, i, p, chi) {
    const cwA = cicWeights(sys.x[i], sys.y[i], sys.h, sys.M);
    const t = sys.type[i] === 0 ? 'A' : 'B';
    const gA = gatherGradient(sys.cA, cwA, sys.h, sys.M);
    const gB = gatherGradient(sys.cB, cwA, sys.h, sys.M);
    const gF = gatherGradient(sys.F, cwA, sys.h, sys.M);
    const Fhere = gatherScalar(sys.F, cwA);
    const foodScale = p.chiF / p.gF * (p.F0 / ((Fhere + p.F0) * (Fhere + p.F0)));
    let Gx = (chi[t].alpha * gA.gx + chi[t].beta * gB.gx) / p.g0 + foodScale * gF.gx;
    let Gy = (chi[t].alpha * gA.gy + chi[t].beta * gB.gy) / p.g0 + foodScale * gF.gy;
    const magG = Math.hypot(Gx, Gy);
    let dirx = 0, diry = 0;
    if (magG > 1e-12) { dirx = Gx / magG; diry = Gy / magG; }
    const chemMag = p.motorFmax * Math.tanh(magG);
    const ax = chemMag * dirx + p.Fe * Math.cos(sys.theta[i]);
    const ay = chemMag * diry + p.Fe * Math.sin(sys.theta[i]);
    return { ax, ay, cwA };
  }

  function stepParticle(sys, i, p, chi, rng, gaussian) {
    const h = sys.h;
    const cw = cicWeights(sys.x[i], sys.y[i], h, sys.M);
    // 摂食(欲しい量→燃料の余地で絞る→場から実際に取れる量でさらに絞る。K-12型の欠陥を避ける)
    const Fhere = gatherScalar(sys.F, cw);
    const want = Math.max(0, p.rEat * Fhere * p.dt);
    const wantCapped = Math.min(want, p.fmax - sys.fuel[i]);
    const actualEat = p.leakMode === 'eatleak' ? wantCapped : withdrawCICLimited(sys.F, cw, wantCapped, h);
    if (actualEat > 0) { sys.fuel[i] += actualEat; sys.flow.eat += actualEat; }
    // 基礎代謝
    const metabCost = Math.min(p.bMetab * p.dt, sys.fuel[i]);
    sys.fuel[i] -= metabCost; sys.flow.metab += metabCost; sys.H += metabCost;
    // 撒く
    const substance = sys.type[i] === 0 ? sys.cA : sys.cB;
    const massFull = p.qSecrete * p.dt, costFull = p.ec * massFull;
    let massDep, costPaid;
    if (p.freeArm) {
      massDep = massFull; costPaid = 0; sys.unpaidWork += costFull;
    } else {
      const avail = sys.fuel[i];
      const scale = avail >= costFull ? 1 : (costFull > 0 ? avail / costFull : 0);
      massDep = massFull * scale; costPaid = p.ec * massDep;
      sys.fuel[i] -= costPaid;
    }
    depositCIC(substance, cw, massDep, h);
    sys.flow.secrete += p.ec * massDep;
    sys.flow.chemDecay += 0; // (減衰はfield段でまとめて計上)
    // 摩擦
    const kBeforeF = 0.5 * MASS * (sys.vx[i] * sys.vx[i] + sys.vy[i] * sys.vy[i]);
    const factor = Math.exp(-p.gamma * p.dt);
    sys.vx[i] *= factor; sys.vy[i] *= factor;
    const kAfterF = 0.5 * MASS * (sys.vx[i] * sys.vx[i] + sys.vy[i] * sys.vy[i]);
    const frictionHeat = p.leakMode === 'heatloss' ? 0 : Math.max(0, kBeforeF - kAfterF);
    sys.flow.friction += Math.max(0, kBeforeF - kAfterF); sys.H += frictionHeat;
    // 推進
    const motor = particleMotorForce(sys, i, p, chi);
    const ax = motor.ax, ay = motor.ay;
    const vxOld = sys.vx[i], vyOld = sys.vy[i];
    const B = p.dt * (vxOld * ax + vyOld * ay);
    const A = 0.5 * p.dt * p.dt * (ax * ax + ay * ay);
    const dKfull = A + B;
    let sScale = 1, dKApplied = dKfull;
    if (dKfull > 0) {
      const costFullProp = dKfull / p.etam;
      if (p.freeArm) {
        // 燃料からは一切引かないが、推進のK増分と非効率の熱は物理として実際に起こる
        // (運動は本物・η_m=0.25の非効率も本物)。払われない分は丸ごと unpaidWork の影として計上し、
        // H には非効率ぶん(costFullProp-dKfull)を足す――そうしないとE_tot(K)だけが増え、
        // unpaidWork(=costFullProp)と食い違う。
        sys.unpaidWork += costFullProp;
        sys.flow.work += dKfull; sys.flow.propLoss += costFullProp - dKfull; sys.H += costFullProp - dKfull;
      } else {
        const avail = sys.fuel[i];
        if (avail >= costFullProp) {
          sys.fuel[i] -= costFullProp; sys.flow.work += dKfull; sys.flow.propLoss += costFullProp - dKfull; sys.H += costFullProp - dKfull;
        } else {
          const target = avail * p.etam;
          let s;
          if (A < 1e-15) s = B > 0 ? target / B : 0;
          else { const disc = B * B + 4 * A * target; s = (-B + Math.sqrt(Math.max(0, disc))) / (2 * A); }
          s = Math.max(0, Math.min(1, s));
          dKApplied = A * s * s + B * s;
          sScale = s;
          const paid = dKApplied / p.etam;
          sys.fuel[i] = Math.max(0, sys.fuel[i] - paid);
          sys.flow.work += dKApplied; sys.flow.propLoss += paid - dKApplied; sys.H += paid - dKApplied;
        }
      }
    }
    sys.vx[i] = vxOld + sScale * ax * p.dt;
    sys.vy[i] = vyOld + sScale * ay * p.dt;
    if (dKApplied < 0) { sys.flow.braking += -dKApplied; sys.H += -dKApplied; }
    // 移動
    sys.x[i] = wrap(sys.x[i] + sys.vx[i] * p.dt, sys.L);
    sys.y[i] = wrap(sys.y[i] + sys.vy[i] * p.dt, sys.L);
    // 探索方向(回転拡散)
    sys.theta[i] += Math.sqrt(2 * p.Dr * p.dt) * gaussian();
  }

  /** 1刻み進める。太陽→餌の腐敗→場の拡散減衰→粒子(摂食/代謝/撒く/摩擦/推進/移動)→接触→θ。 */
  function stepSystem(sys, p, chi, rng, gaussian) {
    // ① 太陽→餌、餌の腐敗
    //
    // criteria.jsonは太陽の蓄え・注入を「節点あたり」(S_0=I*M^2*..., 全体I*M^2/τ)で書いている。
    // これはM=L(h=1、主格子)では格子の刻みに依らず正しいが、格子の検査(M=128,h=0.5)のように
    // M!=Lだと「節点の個数」で決まる注入・蓄えと、「Σ*h^2」で定義された Food/Chem 区画(criteria.json
    // system.ledger)の単位がずれる――節点への加算そのもの(perNode)はhに依らずI*dtのままでよい
    // (節点数M^2×h^2=L^2で、箱の広さに対する総流入はhに依らず一定になる)が、**台帳(flow.sun・
    // flow.foodDecay・flow.chemDecay)とS区画の読み出しは、Food/Chem区画と同じh^2倍した真の量で
    // 記録しないと、h=1でしか帳尻が合わない**(格子の検査でclosureが1e-1桁で破れて発覚。h=1では
    // h^2=1なので無変化――main/A-dusk/NC-dark/NC-blind等28本の物理・観測は一切変わらない)。
    // sys.S自身(内部の残量・枯渇判定)は登録どおりの生の単位のまま持ち、台帳向けの読み出しだけ
    // h^2を掛ける(ledgerSnapshotのS、flow.sunの記録)。
    let sunInjectedRaw = 0;
    if (sys.S > 0 && p.sunMode !== 'none') {
      const wantTotal = p.I * p.dt * sys.M * sys.M;
      const actualTotal = Math.min(wantTotal, sys.S);
      const perNode = actualTotal / (sys.M * sys.M);
      for (let k = 0; k < sys.F.length; k++) sys.F[k] += perNode;
      sys.S -= actualTotal; sunInjectedRaw = actualTotal;
    }
    const h2 = sys.h * sys.h;
    sys.flow.sun += sunInjectedRaw * h2;
    const foodBefore = sumArr(sys.F);
    const decayFactor = Math.exp(-p.kFood * p.dt);
    for (let k = 0; k < sys.F.length; k++) sys.F[k] *= decayFactor;
    const foodDecay = (foodBefore - sumArr(sys.F)) * h2;
    sys.flow.foodDecay += foodDecay; sys.H += foodDecay;

    // ② 場の拡散と減衰(dA.lost/dB.lostも同じ理由でh^2倍が要る。生の格子和の差だから)
    const dA = diffuseAndDecayField(sys.cA, p.D, p.kField, p.dt, sys.h, sys.M);
    const dB = diffuseAndDecayField(sys.cB, p.D, p.kField, p.dt, sys.h, sys.M);
    const chemDecay = p.ec * (dA.lost + dB.lost) * h2;
    sys.flow.chemDecay += chemDecay; sys.H += chemDecay;

    // ③ 粒子ごと
    for (let i = 0; i < sys.N; i++) stepParticle(sys, i, p, chi, rng, gaussian);

    // ④ 接触
    const contactHeat = resolveContactVelocities(sys);
    sys.flow.contact += contactHeat; sys.H += contactHeat;
    resolveContactPositions(sys, 4);

    sys.t += p.dt;
  }

  return {
    SIGMA, MASS,
    makeRng, gaussianFactory, subSeed,
    defaultParams, buildChi, initialSunStock,
    fieldIndex, cicWeights, depositCIC, withdrawCIC, withdrawCICLimited, gatherScalar, gatherGradient, diffuseAndDecayField, sumArr,
    createSystem, initReplicate, randomSequentialFill, wrap, minImageDelta,
    buildCellList, forEachNearbyPair, findOverlappingPairs, resolveContactVelocities, resolveContactPositions,
    kineticEnergy, totalMomentum, foodTotal, fuelTotal, chemTotal, ledgerSnapshot, eTot,
    particleMotorForce, stepParticle, stepSystem,
  };
});
