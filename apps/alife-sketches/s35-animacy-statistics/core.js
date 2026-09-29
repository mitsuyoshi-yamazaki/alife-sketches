/**
 * S-35 核。**上位概念の語彙を持たない。**
 *
 * この核が知っているのは「位置」「速度」「質量」「半径」「力」だけである。
 * alive / animal / chase / intention / agent / wolf / sheep は識別子にも分岐にも出てこない。
 * 「追跡」にあたる駆動子は `cone`（別の物体への方向を中心とする円錐の中に進行方向を保つ）という
 * **幾何の名前**で置いてある。上位概念の語彙は observer.js と viewer.html の側にある。
 *
 * 系: 2次元トーラス上の円板。半陰的 Euler ＋ 弾性衝突（運動量・エネルギーを厳密に保存する）。
 *
 * 駆動子（力を返すもの。核はこれ以上の意味を知らない）:
 *   none   : 力 0
 *   phase  : 自分の歩数だけを読む。向きが一定の速さで回る力
 *   wander : 自分の進行方向だけを読む。確率 p で向きを ±window/2 の範囲で振り直す（速さは一定）
 *   cone   : **他の物体 j の位置を読む**。進行方向を「j への方向 ± half」の円錐に保つ（速さは一定）
 *   field  : **位置だけの関数**である外力場から力を受ける（内部に駆動を持たない）
 *   tape   : 表から力を読む。世界の状態を一切読まない
 *
 * 依存ゼロ・古典スクリプト。Node（module.exports）とブラウザ（window.S35）で共用する。
 */
(function (global) {
  'use strict';

  var TAU = Math.PI * 2;

  // ---------------------------------------------------------------- 乱数
  // xorshift32。シードを固定すれば完全に再現する。
  function makeRng(seed) {
    var s = (seed >>> 0) || 0x9e3779b9;
    function next() {
      s ^= s << 13; s >>>= 0;
      s ^= s >>> 17;
      s ^= s << 5; s >>>= 0;
      return s / 4294967296;
    }
    next.int = function (n) { return Math.floor(next() * n); };
    next.state = function () { return s >>> 0; };
    return next;
  }

  // ---------------------------------------------------------------- ハッシュ
  // FNV-1a を 2 本流して 64bit 相当にする。倍精度は 1e-9 に丸めてから詰める
  // （同じ計算列なら同じ値になるが、無関係な下位ビットの揺れを拾わないため）。
  function hashNumbers(arr, decimals) {
    var d = decimals == null ? 9 : decimals;
    var mul = Math.pow(10, d);
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < arr.length; i++) {
      var q = Math.round(arr[i] * mul);
      // 32bit ずつ 2 語に割る
      var lo = q % 4294967296, hi = Math.floor(q / 4294967296);
      h1 ^= lo >>> 0; h1 = Math.imul(h1, 16777619) >>> 0;
      h2 ^= hi | 0; h2 = Math.imul(h2 ^ (h1 >>> 7), 2246822519) >>> 0;
    }
    return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
  }

  // ---------------------------------------------------------------- トーラス
  function wrap1(v, L) { v = v % L; return v < 0 ? v + L : v; }
  function short1(d, L) {
    var h = L * 0.5;
    if (d > h) return d - L;
    if (d < -h) return d + L;
    return d;
  }

  // ---------------------------------------------------------------- 世界
  /**
   * spec = {
   *   n, side, dt, v0, radius, mass, seed,
   *   drivers: [ {kind:...}, ... ]   // 長さ n
   *   collide: true/false
   * }
   */
  function makeWorld(spec) {
    var n = spec.n, L = spec.side;
    var w = {
      n: n, side: L, dt: spec.dt, v0: spec.v0,
      collide: spec.collide !== false,
      x: new Float64Array(n), y: new Float64Array(n),
      vx: new Float64Array(n), vy: new Float64Array(n),
      m: new Float64Array(n), r: new Float64Array(n),
      drivers: spec.drivers,
      rng: [], t: 0,
      fx: new Float64Array(n), fy: new Float64Array(n),
      contact: new Uint8Array(n),          // そのフレームで他の物体と接触したか
      field: spec.field || { amp: 0.06, k: 2 },
    };
    // 物体ごとに独立な乱数列を持たせる（腕どうしの比較で列がずれないようにするため）
    var base = (spec.seed >>> 0) || 1;
    for (var i = 0; i < n; i++) {
      w.m[i] = (spec.mass != null ? spec.mass : 1);
      w.r[i] = (spec.radius != null ? spec.radius : 2.5);
      w.rng.push(makeRng(Math.imul(base + i * 7919, 2654435761) ^ (i + 1)));
    }
    // 初期配置: 重ならないように格子上へ置いてから揺らす
    var place = makeRng(Math.imul(base, 40503) ^ 0x5bf03635);
    var cols = Math.ceil(Math.sqrt(n)), cell = L / cols;
    for (var j = 0; j < n; j++) {
      var cx = (j % cols) + 0.5, cy = Math.floor(j / cols) + 0.5;
      w.x[j] = wrap1(cx * cell + (place() - 0.5) * (cell - 2 * w.r[j]) * 0.8, L);
      w.y[j] = wrap1(cy * cell + (place() - 0.5) * (cell - 2 * w.r[j]) * 0.8, L);
      var a = place() * TAU;
      w.vx[j] = Math.cos(a) * spec.v0;
      w.vy[j] = Math.sin(a) * spec.v0;
    }
    return w;
  }

  // 駆動子が返す力を w.fx / w.fy へ書く。
  // 「速さを保って向きだけ変える」駆動子は、そのために要る力 (v_new - v_old)/dt を返す。
  function applyDrivers(w) {
    var dt = w.dt, L = w.side;
    for (var i = 0; i < w.n; i++) {
      var d = w.drivers[i], fx = 0, fy = 0;
      var k = d ? d.kind : 'none';
      if (k === 'phase') {
        var ph = (d.phi0 || 0) + (d.omega || 0.05) * w.t;
        fx = (d.amp || 0.08) * Math.cos(ph);
        fy = (d.amp || 0.08) * Math.sin(ph);
      } else if (k === 'wander') {
        var sp = Math.sqrt(w.vx[i] * w.vx[i] + w.vy[i] * w.vy[i]) || w.v0;
        var th = Math.atan2(w.vy[i], w.vx[i]);
        if (w.rng[i]() < (d.prob != null ? d.prob : 0.098)) {
          th += (w.rng[i]() - 0.5) * (d.window != null ? d.window : Math.PI * 2 / 3);
        }
        fx = (Math.cos(th) * sp - w.vx[i]) / dt;
        fy = (Math.sin(th) * sp - w.vy[i]) / dt;
      } else if (k === 'cone') {
        var j = d.j, half = d.half;
        var sp2 = Math.sqrt(w.vx[i] * w.vx[i] + w.vy[i] * w.vy[i]) || w.v0;
        var bx = short1(w.x[j] - w.x[i], L), by = short1(w.y[j] - w.y[i], L);
        var base = Math.atan2(by, bx);
        var th2;
        if (d.mode === 'clamp') {
          // Gao et al. (2009) の原典どおり: haphazard に振ってから円錐へ切り詰める
          th2 = Math.atan2(w.vy[i], w.vx[i]);
          if (w.rng[i]() < (d.prob != null ? d.prob : 0.098)) {
            th2 += (w.rng[i]() - 0.5) * (d.window != null ? d.window : Math.PI * 2 / 3);
          }
          var dev = short1a(th2 - base);
          if (dev > half) th2 = base + half;
          else if (dev < -half) th2 = base - half;
        } else {
          // 解析値 sin(half)/half を持たせるため、円錐内に一様に引く
          th2 = base + (w.rng[i]() * 2 - 1) * half;
        }
        fx = (Math.cos(th2) * sp2 - w.vx[i]) / dt;
        fy = (Math.sin(th2) * sp2 - w.vy[i]) / dt;
      } else if (k === 'field') {
        // 位置だけの関数である外力場（渦。内部に駆動を持たない）
        var kk = TAU * (w.field.k || 2) / L, A = w.field.amp || 0.06;
        fx = A * Math.sin(kk * w.x[i]) * Math.cos(kk * w.y[i]);
        fy = -A * Math.cos(kk * w.x[i]) * Math.sin(kk * w.y[i]);
      } else if (k === 'tape') {
        var p = w.t * 2;
        if (d.force && p + 1 < d.force.length) { fx = d.force[p]; fy = d.force[p + 1]; }
      }
      w.fx[i] = fx; w.fy[i] = fy;
    }
  }

  // 角度を (-π, π] へ畳む
  function short1a(a) {
    a = a % TAU;
    if (a > Math.PI) a -= TAU;
    if (a <= -Math.PI) a += TAU;
    return a;
  }

  function step(w) {
    var i, dt = w.dt, L = w.side;
    applyDrivers(w);
    for (i = 0; i < w.n; i++) {
      w.vx[i] += w.fx[i] / w.m[i] * dt;
      w.vy[i] += w.fy[i] / w.m[i] * dt;
    }
    for (i = 0; i < w.n; i++) {
      w.x[i] = wrap1(w.x[i] + w.vx[i] * dt, L);
      w.y[i] = wrap1(w.y[i] + w.vy[i] * dt, L);
      w.contact[i] = 0;
    }
    if (w.collide) resolveContacts(w);
    w.t++;
    return w;
  }

  // 弾性衝突。等・不等質量のどちらでも全運動量と全運動エネルギーを厳密に保つ形で書く。
  function resolveContacts(w) {
    var L = w.side;
    for (var i = 0; i < w.n; i++) {
      for (var j = i + 1; j < w.n; j++) {
        var dx = short1(w.x[j] - w.x[i], L), dy = short1(w.y[j] - w.y[i], L);
        var rr = w.r[i] + w.r[j];
        var d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr || d2 === 0) continue;
        var d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
        var rvx = w.vx[j] - w.vx[i], rvy = w.vy[j] - w.vy[i];
        var vn = rvx * nx + rvy * ny;
        w.contact[i] = 1; w.contact[j] = 1;
        // 重なりをほどく（速度は変えないので収支に影響しない）
        var push = (rr - d) * 0.5;
        w.x[i] = wrap1(w.x[i] - nx * push, L); w.y[i] = wrap1(w.y[i] - ny * push, L);
        w.x[j] = wrap1(w.x[j] + nx * push, L); w.y[j] = wrap1(w.y[j] + ny * push, L);
        if (vn >= 0) continue;   // 離れつつあるなら力積は要らない
        var J = 2 * w.m[i] * w.m[j] / (w.m[i] + w.m[j]) * vn;
        w.vx[i] += J / w.m[i] * nx; w.vy[i] += J / w.m[i] * ny;
        w.vx[j] -= J / w.m[j] * nx; w.vy[j] -= J / w.m[j] * ny;
      }
    }
  }

  // 系の総量。観測器ではなく核の検算に使う（保存則の検査）。
  function totals(w) {
    var px = 0, py = 0, e = 0;
    for (var i = 0; i < w.n; i++) {
      px += w.m[i] * w.vx[i]; py += w.m[i] * w.vy[i];
      e += 0.5 * w.m[i] * (w.vx[i] * w.vx[i] + w.vy[i] * w.vy[i]);
    }
    return { px: px, py: py, energy: e };
  }

  /**
   * frames 歩ぶん走らせ、**各フレームの位置**（観測器が見てよい唯一のもの）と、
   * 物体ごとの力の記録（テープを作るため）・接触の有無を返す。
   */
  function record(w, frames, opts) {
    opts = opts || {};
    var n = w.n;
    var pos = new Float64Array(frames * n * 2);
    var contact = new Uint8Array(frames * n);
    var tapeOf = opts.tapeOf != null ? opts.tapeOf : -1;
    var force = tapeOf >= 0 ? new Float64Array(frames * 2) : null;
    var cons = { p0: null, dpMax: 0, deMax: 0 };
    for (var t = 0; t < frames; t++) {
      // 位置を先に記録してから 1 歩進める（観測器が「古い状態」を見ないように = K-12）
      for (var i = 0; i < n; i++) { pos[(t * n + i) * 2] = w.x[i]; pos[(t * n + i) * 2 + 1] = w.y[i]; }
      var before = totals(w);
      if (cons.p0 === null) cons.p0 = before;
      step(w);
      if (force) { force[t * 2] = w.fx[tapeOf]; force[t * 2 + 1] = w.fy[tapeOf]; }
      for (var q = 0; q < n; q++) contact[t * n + q] = w.contact[q];
      var after = totals(w);
      var dp = Math.hypot(after.px - before.px, after.py - before.py);
      var de = Math.abs(after.energy - before.energy);
      if (dp > cons.dpMax) cons.dpMax = dp;
      if (de > cons.deMax) cons.deMax = de;
    }
    return {
      pos: pos, n: n, frames: frames, side: w.side, dt: w.dt, v0: w.v0,
      m: Array.prototype.slice.call(w.m), r: Array.prototype.slice.call(w.r),
      contact: contact, force: force,
      conservation: { maxFrameMomentumDrift: cons.dpMax, maxFrameEnergyDrift: cons.deMax },
      hash: hashNumbers(pos, 6),
    };
  }

  // ---------------------------------------------------------------- 腕
  // 腕は「どの物体にどの駆動子を付けるか」でしかない。核はここまでしか知らない。
  var DEFAULTS = {
    n: 10, side: 100, dt: 1, v0: 1, radius: 2.5, mass: 1, frames: 2400,
    phaseAmp: 0.15, phaseOmega: 0.5,
    fieldAmp: 0.15, fieldK: 2,
    wanderProb: 0.098, wanderWindow: TAU / 3,     // Gao et al. (2009): 120° 窓・毎フレーム 9.8%
    tapeArm: 'cone:clamp:30', collide: true,
  };

  function cfgOf(over) {
    var c = {}, k;
    for (k in DEFAULTS) if (Object.prototype.hasOwnProperty.call(DEFAULTS, k)) c[k] = DEFAULTS[k];
    if (over) for (k in over) if (Object.prototype.hasOwnProperty.call(over, k)) c[k] = over[k];
    return c;
  }

  function wanderDriver(c) {
    return { kind: 'wander', prob: c.wanderProb, window: c.wanderWindow };
  }

  // armId: 'inert' | 'selfdrive' | 'walk' | 'field' | 'cone:<uniform|clamp>:<deg>' | 'tapeSame' | 'tapeAlt'
  function armDrivers(armId, c, tapeForce) {
    var i, ds = [];
    if (armId === 'inert') {
      for (i = 0; i < c.n; i++) ds.push({ kind: 'none' });
    } else if (armId === 'selfdrive') {
      ds.push({ kind: 'phase', amp: c.phaseAmp, omega: c.phaseOmega, phi0: 0 });
      for (i = 1; i < c.n; i++) ds.push({ kind: 'none' });
    } else if (armId === 'walk') {
      for (i = 0; i < c.n; i++) ds.push(wanderDriver(c));
    } else if (armId === 'field') {
      ds.push({ kind: 'field' });
      for (i = 1; i < c.n; i++) ds.push({ kind: 'none' });
    } else if (armId === 'tapeSame' || armId === 'tapeAlt') {
      ds.push({ kind: 'tape', force: tapeForce });
      for (i = 1; i < c.n; i++) ds.push(wanderDriver(c));
    } else if (armId.indexOf('cone:') === 0) {
      var parts = armId.split(':');
      ds.push({
        kind: 'cone', j: 1, mode: parts[1], half: parseFloat(parts[2]) * Math.PI / 180,
        prob: c.wanderProb, window: c.wanderWindow,
      });
      for (i = 1; i < c.n; i++) ds.push(wanderDriver(c));
    } else {
      throw new Error('unknown arm: ' + armId);
    }
    return ds;
  }

  /**
   * 腕を1本走らせて軌道を返す。
   * opts.intervene = {t0, i, dx, dy} を渡すと、フレーム t0 で物体 i の位置をずらす（**介入**）。
   * opts.tapeOf >= 0 でその物体が受けた力を記録する（テープを作るため）。
   */
  function simulate(armId, seed, over, opts) {
    opts = opts || {};
    var c = cfgOf(over);
    var tape = null;
    if (armId === 'tapeSame' || armId === 'tapeAlt') {
      var src = simulate(c.tapeArm, seed, over, { tapeOf: 0 });
      tape = src.force;
    }
    var w = makeWorld({
      n: c.n, side: c.side, dt: c.dt, v0: c.v0, radius: c.radius, mass: c.mass,
      seed: seed, drivers: armDrivers(armId, c, tape), collide: c.collide !== false,
      field: { amp: c.fieldAmp, k: c.fieldK },
    });
    if (armId === 'tapeAlt') {
      // 物体0の初期状態はそのままに、**他の物体の乱数列だけ**入れ替える（世界を差し替える）
      for (var i = 1; i < w.n; i++) w.rng[i] = makeRng(Math.imul(seed + 100000 + i * 7919, 2654435761) ^ (i + 1));
    }
    return recordWithIntervention(w, c.frames, opts);
  }

  function recordWithIntervention(w, frames, opts) {
    if (!opts.intervene) return record(w, frames, opts);
    var iv = opts.intervene;
    var L = w.side;
    var n = w.n;
    var pos = new Float64Array(frames * n * 2);
    for (var t = 0; t < frames; t++) {
      if (t === iv.t0) {
        w.x[iv.i] = wrap1(w.x[iv.i] + (iv.dx || 0), L);
        w.y[iv.i] = wrap1(w.y[iv.i] + (iv.dy || 0), L);
      }
      for (var i = 0; i < n; i++) { pos[(t * n + i) * 2] = w.x[i]; pos[(t * n + i) * 2 + 1] = w.y[i]; }
      step(w);
    }
    return {
      pos: pos, n: n, frames: frames, side: w.side, dt: w.dt, v0: w.v0,
      m: Array.prototype.slice.call(w.m), r: Array.prototype.slice.call(w.r),
      contact: null, force: null,
      conservation: null, hash: hashNumbers(pos, 6),
    };
  }

  var api = {
    TAU: TAU, DEFAULTS: DEFAULTS, cfgOf: cfgOf,
    makeRng: makeRng, hashNumbers: hashNumbers,
    wrap1: wrap1, short1: short1, wrapAngle: short1a,
    makeWorld: makeWorld, step: step, totals: totals, record: record,
    applyDrivers: applyDrivers, resolveContacts: resolveContacts,
    armDrivers: armDrivers, simulate: simulate, wanderDriver: wanderDriver,
  };

  global.S35 = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
