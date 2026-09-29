/**
 * S-35 観測器。**上位概念の語彙はここにある**（核には無い）。
 *
 * 観測器が見てよいもの: 各フレームの全物体の位置・各物体の半径と質量・登録した公称速度 v0 と dt。
 * 見てはいけないもの: 駆動子の種類・力・シミュレータ内部の速度・接触フラグ
 * （接触は位置と半径から自分で計算する）。
 *
 * 検出器:
 *   D1 ledgerLinear      線形の収支の破れ（**増分の並べ替えに恒等的に不変**）
 *   D2 ledgerCount       数え上げの収支の破れ（接触なしに速度が変わった事象の割合）
 *   D3 tfCue             Tremoulet & Feldman (2000) の手がかり（速さと向きの同時変化）
 *   D4 headingBias       Gao, Newman & Scholl (2009) の追跡の幾何（進行方向の偏り）
 *   D5 interventionDep   介入への応答（**観測ではない**。run.js が2回走らせて計算する）
 *   D6 fieldConsistency  加速度は位置の関数か（転がる石か、歩く動物か）
 *
 * 参照点 R1..R4 の生成器も持つ（K-33 / K-62: 同じ軌道の、忘れ方だけ違うもの）。
 */
(function (global) {
  'use strict';

  var CORE = (typeof require === 'function') ? require('./core.js') : global.S35;
  var short1 = CORE.short1, wrap1 = CORE.wrap1, wrapAngle = CORE.wrapAngle, makeRng = CORE.makeRng;
  var PI = Math.PI;

  // ------------------------------------------------------------- 下ごしらえ
  // 位置列から速度列を作る（トーラスの最短ベクトルで差を取る）。
  // 観測器は「古い状態」を見ないよう、v(t) を x(t+1)-x(t) と定義する（K-12）。
  function velocities(tr) {
    var F = tr.frames, n = tr.n, L = tr.side, dt = tr.dt;
    var v = new Float64Array((F - 1) * n * 2);
    for (var t = 0; t < F - 1; t++) {
      for (var i = 0; i < n; i++) {
        var a = (t * n + i) * 2, b = ((t + 1) * n + i) * 2, c = (t * n + i) * 2;
        v[c] = short1(tr.pos[b] - tr.pos[a], L) / dt;
        v[c + 1] = short1(tr.pos[b + 1] - tr.pos[a + 1], L) / dt;
      }
    }
    return v;
  }

  // 加速度列（速度の差）。長さ F-2。
  function accelerations(tr, v) {
    var F = tr.frames, n = tr.n, dt = tr.dt;
    var a = new Float64Array((F - 2) * n * 2);
    for (var t = 0; t < F - 2; t++) {
      for (var i = 0; i < n; i++) {
        var p = (t * n + i) * 2, q = ((t + 1) * n + i) * 2;
        a[p] = (v[q] - v[p]) / dt;
        a[p + 1] = (v[q + 1] - v[p + 1]) / dt;
      }
    }
    return a;
  }

  // フレーム f で物体 i が他のどれかと「接触している」か（位置と半径だけから決める）
  function contactAt(tr, f, i, kappa) {
    var n = tr.n, L = tr.side;
    var xi = tr.pos[(f * n + i) * 2], yi = tr.pos[(f * n + i) * 2 + 1];
    for (var j = 0; j < n; j++) {
      if (j === i) continue;
      var dx = short1(tr.pos[(f * n + j) * 2] - xi, L);
      var dy = short1(tr.pos[(f * n + j) * 2 + 1] - yi, L);
      var rr = kappa * (tr.r[i] + tr.r[j]);
      if (dx * dx + dy * dy <= rr * rr) return true;
    }
    return false;
  }

  // ------------------------------------------------------------- D1
  // mean_t |ΔP_t| / (Σ m_i · v0)。正規化はデータから取らない（登録した v0 を使う）ので、
  // 速度増分の多重集合が保たれる操作（参照点 R2）に対して**恒等的に不変**である。
  function D1(tr, v, opts) {
    opts = opts || {};
    var stride = opts.stride || 1;
    var F = tr.frames, n = tr.n;
    var msum = 0;
    for (var i = 0; i < n; i++) msum += tr.m[i];
    var norm = msum * tr.v0;
    var acc = 0, cnt = 0;
    for (var t = 0; t + stride < F - 1; t += stride) {
      var px = 0, py = 0;
      for (var k = 0; k < n; k++) {
        px += tr.m[k] * (v[((t + stride) * n + k) * 2] - v[(t * n + k) * 2]);
        py += tr.m[k] * (v[((t + stride) * n + k) * 2 + 1] - v[(t * n + k) * 2 + 1]);
      }
      acc += Math.sqrt(px * px + py * py); cnt++;
    }
    return cnt ? acc / cnt / norm : 0;
  }

  // ------------------------------------------------------------- D2
  // （接触せずに速度が変わった事象）÷（速度が変わった事象）。
  // 分母が 0 なら **未定義**（観測器が答えない。K-30）。
  function D2(tr, i, v, opts) {
    opts = opts || {};
    var eps = opts.epsilon != null ? opts.epsilon : 0.05;
    var kappa = opts.kappa != null ? opts.kappa : 1.5;
    var W = opts.W != null ? opts.W : 1;
    var pop = opts.population || 'event';
    var F = tr.frames, n = tr.n, v0 = tr.v0, thr = eps * v0;
    var events = 0, free = 0, all = 0, moving = 0;
    for (var t = 0; t < F - 2; t++) {
      var p = (t * n + i) * 2, q = ((t + 1) * n + i) * 2;
      var dvx = v[q] - v[p], dvy = v[q + 1] - v[p + 1];
      var mag = Math.sqrt(dvx * dvx + dvy * dvy);
      var sp = Math.sqrt(v[p] * v[p] + v[p + 1] * v[p + 1]);
      all++;
      if (sp > v0 * 0.5) moving++;
      if (mag <= thr) continue;
      events++;
      var touched = false;
      for (var w = -W; w <= W; w++) {
        var f = t + 1 + w;
        if (f < 0 || f >= F) continue;
        if (contactAt(tr, f, i, kappa)) { touched = true; break; }
      }
      if (!touched) free++;
    }
    var den = pop === 'all' ? all : (pop === 'moving' ? moving : events);
    if (den === 0) return { value: null, events: events, free: free, undefinedReason: 'denominator=0' };
    return { value: free / den, events: events, free: free };
  }

  // ------------------------------------------------------------- D3
  // Tremoulet & Feldman (2000): 速さの変化の大きさと進行方向の変化角。原典は両者を**同時に**振っている。
  function D3(tr, i, v, opts) {
    opts = opts || {};
    var eps = opts.epsilon != null ? opts.epsilon : 0.05;
    var phiStar = (opts.phiStarDeg != null ? opts.phiStarDeg : 45) * PI / 180;
    var lamStar = opts.lambdaStar != null ? opts.lambdaStar : 0.10;
    var F = tr.frames, n = tr.n, v0 = tr.v0, thr = eps * v0, tiny = v0 / 100;
    var magSum = 0, phiSum = 0, lamSum = 0, cnt = 0, conj = 0, popn = 0;
    for (var t = 0; t < F - 2; t++) {
      var p = (t * n + i) * 2, q = ((t + 1) * n + i) * 2;
      var s0 = Math.sqrt(v[p] * v[p] + v[p + 1] * v[p + 1]);
      var s1 = Math.sqrt(v[q] * v[q] + v[q + 1] * v[q + 1]);
      if (s0 <= tiny || s1 <= tiny) continue;
      popn++;
      var dvx = v[q] - v[p], dvy = v[q + 1] - v[p + 1];
      var mag = Math.sqrt(dvx * dvx + dvy * dvy);
      if (mag <= thr) continue;
      var phi = Math.abs(wrapAngle(Math.atan2(v[q + 1], v[q]) - Math.atan2(v[p + 1], v[p])));
      var lam = Math.abs(s1 / s0 - 1);
      magSum += mag / v0; phiSum += phi; lamSum += lam; cnt++;
      if (phi > phiStar && lam > lamStar) conj++;
    }
    if (cnt === 0) return { mag: null, phi: null, lam: null, prod: null, conj: null, events: 0 };
    var phiM = phiSum / cnt, lamM = lamSum / cnt;
    return {
      mag: magSum / cnt, phi: phiM, lam: lamM,
      prod: phiM * lamM,                       // **積**で結ぶ（K-28 の 2026-09-13 限定）
      conj: popn ? conj / popn : 0, events: cnt,
    };
  }

  // ------------------------------------------------------------- D4
  // Gao et al. (2009) の追跡の幾何。順序対 (i,j) について cos∠(v_i, x_j−x_i) の平均を取り、最大を返す。
  function D4(tr, v, opts) {
    opts = opts || {};
    var mode = opts.pairPopulation || 'moving';   // 'moving' | 'near' | 'all'
    var F = tr.frames, n = tr.n, L = tr.side, v0 = tr.v0, tiny = v0 / 100;
    var near = L / 4;
    var best = -2, bestPair = null, second = -2, table = [];
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < n; j++) {
        if (i === j) continue;
        var sum = 0, cnt = 0;
        for (var t = 0; t < F - 1; t++) {
          var p = (t * n + i) * 2;
          var sp = Math.sqrt(v[p] * v[p] + v[p + 1] * v[p + 1]);
          if (mode !== 'all' && sp <= tiny) continue;
          var dx = short1(tr.pos[(t * n + j) * 2] - tr.pos[(t * n + i) * 2], L);
          var dy = short1(tr.pos[(t * n + j) * 2 + 1] - tr.pos[(t * n + i) * 2 + 1], L);
          var d = Math.sqrt(dx * dx + dy * dy);
          if (d === 0) continue;
          if (mode === 'near' && d > near) continue;
          sum += (v[p] * dx + v[p + 1] * dy) / (sp * d); cnt++;
        }
        if (!cnt) continue;
        var m = sum / cnt;
        table.push([i, j, m]);
        if (m > best) { best = m; bestPair = [i, j]; }
      }
    }
    if (!bestPair) return { value: null, gap: null, pair: null };
    for (var k = 0; k < table.length; k++) {
      if (table[k][0] === bestPair[0]) continue;      // 同じ i を持つ対は除く
      if (table[k][2] > second) second = table[k][2];
    }
    return { value: best, gap: second > -2 ? best - second : best, pair: bestPair, second: second > -2 ? second : null };
  }

  // 特定の対 (i,j) だけの値。解析値 sinθ/θ との突き合わせに使う（最大値は 90 対の上側の裾を拾うので使えない）。
  function D4pairValue(tr, v, i, j, opts) {
    opts = opts || {};
    var mode = opts.pairPopulation || 'moving';
    var F = tr.frames, n = tr.n, L = tr.side, v0 = tr.v0, tiny = v0 / 100, near = L / 4;
    var sum = 0, cnt = 0;
    for (var t = 0; t < F - 1; t++) {
      var p = (t * n + i) * 2;
      var sp = Math.sqrt(v[p] * v[p] + v[p + 1] * v[p + 1]);
      if (mode !== 'all' && sp <= tiny) continue;
      var dx = short1(tr.pos[(t * n + j) * 2] - tr.pos[(t * n + i) * 2], L);
      var dy = short1(tr.pos[(t * n + j) * 2 + 1] - tr.pos[(t * n + i) * 2 + 1], L);
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d === 0) continue;
      if (mode === 'near' && d > near) continue;
      sum += (v[p] * dx + v[p + 1] * dy) / (sp * d); cnt++;
    }
    return cnt ? sum / cnt : null;
  }

  // ------------------------------------------------------------- D6
  // 加速度は位置の関数か。同じ場所（距離 ρ 以内）を離れた時刻に通った組で、加速度の向きの食い違いを測る。
  // 位置だけの関数である外力場なら 0 に近づく（解析的な帰無）。
  function D6(tr, i, v, opts) {
    opts = opts || {};
    var rho = opts.rho != null ? opts.rho : 2.0;
    var W6 = opts.W6 != null ? opts.W6 : 20;
    var minPairs = opts.minPairs != null ? opts.minPairs : 20;
    var F = tr.frames, n = tr.n, L = tr.side, dt = tr.dt;
    var aThr = 0.02 * tr.v0 / dt;
    // 加速しているフレームだけを拾う
    var idx = [], px = [], py = [], ang = [];
    for (var t = 0; t < F - 2; t++) {
      var p = (t * n + i) * 2, q = ((t + 1) * n + i) * 2;
      var ax = (v[q] - v[p]) / dt, ay = (v[q + 1] - v[p + 1]) / dt;
      if (Math.sqrt(ax * ax + ay * ay) <= aThr) continue;
      var f = t + 1;
      idx.push(f);
      px.push(tr.pos[(f * n + i) * 2]); py.push(tr.pos[(f * n + i) * 2 + 1]);
      ang.push(Math.atan2(ay, ax));
    }
    var M = idx.length;
    if (M < 2) return { value: null, pairs: 0, undefinedReason: 'no-acceleration-frames' };
    // 格子で近傍を引く（総当たりを避ける）
    var cell = rho, G = Math.max(1, Math.floor(L / cell));
    cell = L / G;
    var buckets = {};
    for (var k = 0; k < M; k++) {
      var cx = Math.floor(px[k] / cell) % G, cy = Math.floor(py[k] / cell) % G;
      var key = cx + ',' + cy;
      (buckets[key] || (buckets[key] = [])).push(k);
    }
    var sum = 0, pairs = 0, r2 = rho * rho;
    for (var k2 = 0; k2 < M; k2++) {
      var bx = Math.floor(px[k2] / cell) % G, by = Math.floor(py[k2] / cell) % G;
      for (var ox = -1; ox <= 1; ox++) {
        for (var oy = -1; oy <= 1; oy++) {
          var b = buckets[(((bx + ox) % G) + G) % G + ',' + ((((by + oy) % G) + G) % G)];
          if (!b) continue;
          for (var z = 0; z < b.length; z++) {
            var k3 = b[z];
            if (k3 <= k2) continue;
            if (Math.abs(idx[k3] - idx[k2]) <= W6) continue;
            var dx = short1(px[k3] - px[k2], L), dy = short1(py[k3] - py[k2], L);
            if (dx * dx + dy * dy > r2) continue;
            sum += Math.abs(wrapAngle(ang[k3] - ang[k2])) / PI;
            pairs++;
          }
        }
      }
    }
    if (pairs < minPairs) return { value: null, pairs: pairs, undefinedReason: 'too-few-pairs' };
    return { value: sum / pairs, pairs: pairs };
  }

  // ------------------------------------------------------------- 参照点
  // R1: 時間の向きを忘れる
  function R1_timeReverse(tr) {
    var F = tr.frames, n = tr.n;
    var pos = new Float64Array(F * n * 2);
    for (var t = 0; t < F; t++) {
      for (var i = 0; i < n; i++) {
        var s = ((F - 1 - t) * n + i) * 2, d = (t * n + i) * 2;
        pos[d] = tr.pos[s]; pos[d + 1] = tr.pos[s + 1];
      }
    }
    return clone(tr, pos);
  }

  // R2: フレームの順序を忘れる（系全体の速度増分に**共通の置換**をかけて積み直す）。
  // 増分の多重集合が保たれるので、D1 は恒等的に不変になる。
  function R2_incrementShuffle(tr, seed) {
    var F = tr.frames, n = tr.n, L = tr.side, dt = tr.dt;
    var v = velocities(tr);                       // 長さ F-1
    var K = F - 2;                                // 増分の本数
    var perm = [];
    for (var a = 0; a < K; a++) perm.push(a);
    var rng = makeRng(seed || 12345);
    for (var b = K - 1; b > 0; b--) {
      var c = rng.int(b + 1), tmp = perm[b]; perm[b] = perm[c]; perm[c] = tmp;
    }
    var nv = new Float64Array((F - 1) * n * 2);
    for (var i = 0; i < n; i++) {
      nv[i * 2] = v[i * 2]; nv[i * 2 + 1] = v[i * 2 + 1];
    }
    for (var t = 0; t < K; t++) {
      var src = perm[t];
      for (var j = 0; j < n; j++) {
        var p = (t * n + j) * 2, q = ((t + 1) * n + j) * 2;
        var sp = (src * n + j) * 2, sq = ((src + 1) * n + j) * 2;
        nv[q] = nv[p] + (v[sq] - v[sp]);
        nv[q + 1] = nv[p + 1] + (v[sq + 1] - v[sp + 1]);
      }
    }
    var pos = new Float64Array(F * n * 2);
    for (var k = 0; k < n; k++) { pos[k * 2] = tr.pos[k * 2]; pos[k * 2 + 1] = tr.pos[k * 2 + 1]; }
    for (var u = 0; u < F - 1; u++) {
      for (var m = 0; m < n; m++) {
        var pp = (u * n + m) * 2, qq = ((u + 1) * n + m) * 2;
        pos[qq] = wrap1(pos[pp] + nv[pp] * dt, L);
        pos[qq + 1] = wrap1(pos[pp + 1] + nv[pp + 1] * dt, L);
      }
    }
    return clone(tr, pos);
  }

  // R3: 物体間の対応を忘れる（物体 0 の軌道を別の走行の残りへ貼る）
  function R3_crossPair(trA, trB) {
    var F = Math.min(trA.frames, trB.frames), n = trA.n;
    var pos = new Float64Array(F * n * 2);
    for (var t = 0; t < F; t++) {
      pos[(t * n) * 2] = trA.pos[(t * n) * 2];
      pos[(t * n) * 2 + 1] = trA.pos[(t * n) * 2 + 1];
      for (var i = 1; i < n; i++) {
        pos[(t * n + i) * 2] = trB.pos[(t * n + i) * 2];
        pos[(t * n + i) * 2 + 1] = trB.pos[(t * n + i) * 2 + 1];
      }
    }
    var out = clone(trA, pos); out.frames = F; return out;
  }

  // R4: 進行方向と変位の結びつきを忘れる（各フレームの変位を無作為に回す）
  function R4_headingRandomize(tr, seed) {
    var F = tr.frames, n = tr.n, L = tr.side;
    var rng = makeRng(seed || 777);
    var pos = new Float64Array(F * n * 2);
    for (var i = 0; i < n; i++) { pos[i * 2] = tr.pos[i * 2]; pos[i * 2 + 1] = tr.pos[i * 2 + 1]; }
    for (var t = 0; t < F - 1; t++) {
      for (var j = 0; j < n; j++) {
        var p = (t * n + j) * 2, q = ((t + 1) * n + j) * 2;
        var dx = short1(tr.pos[q] - tr.pos[p], L), dy = short1(tr.pos[q + 1] - tr.pos[p + 1], L);
        var a = rng() * Math.PI * 2, ca = Math.cos(a), sa = Math.sin(a);
        pos[q] = wrap1(pos[p] + (dx * ca - dy * sa), L);
        pos[q + 1] = wrap1(pos[p + 1] + (dx * sa + dy * ca), L);
      }
    }
    return clone(tr, pos);
  }

  function clone(tr, pos) {
    return {
      pos: pos, n: tr.n, frames: tr.frames, side: tr.side, dt: tr.dt, v0: tr.v0,
      m: tr.m, r: tr.r,
    };
  }

  // ------------------------------------------------------------- まとめ
  // 1本の軌道から、物体 i について検出器を全部当てる。
  function measure(tr, i, opts) {
    opts = opts || {};
    var v = velocities(tr);
    var d2 = D2(tr, i, v, opts);
    var d3 = D3(tr, i, v, opts);
    var d4 = D4(tr, v, opts);
    var d6 = D6(tr, i, v, opts);
    return {
      D1: D1(tr, v, opts),
      D2: d2.value, D2events: d2.events,
      D3mag: d3.mag, D3phi: d3.phi, D3lam: d3.lam, D3prod: d3.prod, D3conj: d3.conj,
      D4: d4.value, D4gap: d4.gap, D4pair: d4.pair,
      D6: d6.value, D6pairs: d6.pairs,
    };
  }

  // 作業定義（**人間の代わりに置いたもの**）。criteria.json の workingDefinitions と対応する。
  var TH = {
    D1: 0.01, D2: 0.50, D3mag: 0.10, D3prod: 0.004,
    D4: 0.50, D4gap: 0.12, D5: 0.05, D6: 0.20,
  };

  function judge(mm, d5) {
    var W1 = (mm.D2 != null && mm.D2 >= TH.D2) && (mm.D3mag != null && mm.D3mag >= TH.D3mag);
    // rev3: W2 から D2 の項を外した。**追跡そのものが接触を生む**ため、最も完全に追う個体ほど
    //       「接触せずに速度が変わった割合」が下がり、正コントロールを取り逃していた（K-15）。
    var W2 = (mm.D4 != null && mm.D4 >= TH.D4) && (mm.D4gap != null && mm.D4gap >= TH.D4gap);
    var W3 = (mm.D6 != null && mm.D6 >= TH.D6);
    var W4 = (d5 != null && d5 >= TH.D5);
    return { W1: W1, W2: W2, W3: W3, W4: W4, WStar: W1 && W3 };
  }

  var api = {
    velocities: velocities, accelerations: accelerations, contactAt: contactAt,
    D1: D1, D2: D2, D3: D3, D4: D4, D4pairValue: D4pairValue, D6: D6,
    R1_timeReverse: R1_timeReverse, R2_incrementShuffle: R2_incrementShuffle,
    R3_crossPair: R3_crossPair, R4_headingRandomize: R4_headingRandomize,
    measure: measure, judge: judge, thresholds: TH,
    analyticHeadingBias: function (halfRad) { return halfRad === 0 ? 1 : Math.sin(halfRad) / halfRad; },
  };

  global.S35obs = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
