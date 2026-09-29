/**
 * S-07: 被覆率・アルベド・温度・成長率だけからなる惑星表面の模型
 *
 * 核が持つ概念はこれだけである:
 *
 *   - 惑星表面は「空き地」と、K 個の被覆型の占める面積分率 cover[i] に分かれる
 *   - 各被覆型 i は反射率 albedo[i] を持つ。空き地は groundAlbedo
 *   - 惑星全体の反射率      A = Σ cover[i]·albedo[i] + free·groundAlbedo
 *   - 惑星平均温度（放射平衡） σ·T^4 = S·L·(1 − A)
 *   - 被覆型 i の局所温度     T_i^4 = q·(A − albedo[i]) + T^4     （負にはならない）
 *   - 被覆型 i の増加率       g_i = max(0, 1 − ((peak_i − T_i)/half_i)^2)
 *   - 面積分率の時間変化      d cover[i]/dt = cover[i]·(free·g_i − γ)
 *
 * **これ以上の概念は核に無い。** 局所温度が反射率に依り、反射率が面積分率に依り、
 * 面積分率が局所温度に依る——閉じているのは式であって、意図ではない。
 * 表面が何を保とうとしているかを表す語も、その分岐も、核の側には 1 つも無い。
 * 上位の呼び名は下の観測器・viewer・レポートの側にだけ置く。
 * selftest.js が、下の境界行より上に上位概念の語が現れないことを機械的に検査する。
 *
 * 対照系はすべて**パラメータの値の差**として表せるようにしてある（核に分岐を足さない）:
 *   - albedo[i] = groundAlbedo にする   → 面積分率が反射率に影響しない
 *   - q = 0 にする                      → 全ての型が惑星平均温度そのものを感じる
 *   - q を負にする                      → 局所温度の符号が逆になる
 *   - half_i を極大にする               → 成長率が温度に依らず定数 1 になる
 *   - cover を空にする                  → 表面は空き地だけ（解析解を持つ）
 *
 * 依存ゼロ。Node（生ログ生成）とブラウザ（可視化）が同じファイルを読む。
 * 出典・題材の説明は README.md にある（核には書かない）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S07 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var ZERO_C = 273.15;   // 摂氏 0 度の絶対温度

  var DEFAULTS = {
    solarFlux: 917,        // S: 単位面積あたりの入射（W/m^2）
    sigma: 5.67e-8,        // ステファン=ボルツマン定数
    groundAlbedo: 0.5,     // 空き地の反射率
    heatTransfer: 2.06e9,  // q: 局所温度と平均温度を結ぶ係数（K^4）
    deathRate: 0.3,        // γ: 面積分率が失われる率
    fertile: 1.0,          // 占有されうる面積の上限
    coverFloor: 0.01,      // 面積分率の下限
    dt: 0.05               // 時間刻み
  };

  var TYPE_DEFAULTS = { albedo: 0.5, peakTempC: 22.5, halfWidthC: 17.5 };

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

  // ------------------------------------------------------------- 被覆型

  /** 被覆型の指定を正規化する。albedo / peakTempC / halfWidthC の3つだけを持つ。 */
  function makeTypes(list) {
    return (list || []).map(function (t) {
      return {
        albedo: t.albedo != null ? t.albedo : TYPE_DEFAULTS.albedo,
        peakTempC: t.peakTempC != null ? t.peakTempC : TYPE_DEFAULTS.peakTempC,
        halfWidthC: t.halfWidthC != null ? t.halfWidthC : TYPE_DEFAULTS.halfWidthC
      };
    });
  }

  /** 反射率を [0,1] から一様に引いた N 個の型。 */
  function randomTypes(n, rng) {
    var out = [];
    for (var i = 0; i < n; i++) out.push({ albedo: rng() });
    return makeTypes(out);
  }

  // ------------------------------------------------------------- 世界

  /**
   * @param {object} params  DEFAULTS を上書きする値
   * @param {Array}  types   makeTypes が返した配列
   * @param {Array}  init    初期の面積分率（省略時は全型 coverFloor）
   */
  function createWorld(params, types, init) {
    var p = {};
    Object.keys(DEFAULTS).forEach(function (k) { p[k] = DEFAULTS[k]; });
    Object.keys(params || {}).forEach(function (k) { p[k] = params[k]; });
    var n = types.length;
    var cover = new Float64Array(n);
    for (var i = 0; i < n; i++) cover[i] = init ? init[i] : p.coverFloor;
    var w = {
      params: p, types: types, n: n, cover: cover,
      k1: new Float64Array(n), k2: new Float64Array(n),
      k3: new Float64Array(n), k4: new Float64Array(n),
      tmp: new Float64Array(n)
    };
    clampCover(w, w.cover);
    return w;
  }

  /** 面積分率を [0, fertile] と合計 ≤ fertile に収め、下限を掛ける。 */
  function clampCover(w, c) {
    var p = w.params, i, s = 0;
    for (i = 0; i < w.n; i++) {
      if (!(c[i] > p.coverFloor)) c[i] = p.coverFloor;
      s += c[i];
    }
    if (s > p.fertile) {
      var f = p.fertile / s;
      for (i = 0; i < w.n; i++) c[i] *= f;
    }
    return c;
  }

  function freeOf(w, c) {
    var s = 0;
    for (var i = 0; i < w.n; i++) s += c[i];
    var f = w.params.fertile - s;
    return f > 0 ? f : 0;
  }

  /** A = Σ cover·albedo + free·groundAlbedo。**渡された面積分率からその場で計算する。** */
  function albedoOf(w, c) {
    var a = 0;
    for (var i = 0; i < w.n; i++) a += c[i] * w.types[i].albedo;
    return a + freeOf(w, c) * w.params.groundAlbedo;
  }

  /** σT^4 = S·L·(1−A) を解いた惑星平均温度（K）。 */
  function meanTempK(p, luminosity, albedo) {
    var e = p.solarFlux * luminosity * (1 - albedo) / p.sigma;
    return e > 0 ? Math.pow(e, 0.25) : 0;
  }

  /** T_i^4 = q·(A − a_i) + T^4。負になったら 0 に留める。 */
  function localTempK(p, meanK, albedo, typeAlbedo) {
    var e = p.heatTransfer * (albedo - typeAlbedo) + Math.pow(meanK, 4);
    return e > 0 ? Math.pow(e, 0.25) : 0;
  }

  /** g(T) = max(0, 1 − ((peak − T)/half)^2)。half を極大にすると定数 1 になる。 */
  function growthOf(type, tempK) {
    var d = (type.peakTempC + ZERO_C - tempK) / type.halfWidthC;
    var g = 1 - d * d;
    return g > 0 ? g : 0;
  }

  /**
   * d cover/dt を out へ書く。**必ず引数 c からその場で全量を計算する**（K-12。
   * 状態を更新する側と読む側の間に古い値が挟まる余地を作らない）。
   */
  function derivative(w, c, luminosity, out) {
    var p = w.params;
    var A = albedoOf(w, c);
    var free = freeOf(w, c);
    var meanK = meanTempK(p, luminosity, A);
    for (var i = 0; i < w.n; i++) {
      var tK = localTempK(p, meanK, A, w.types[i].albedo);
      out[i] = c[i] * (free * growthOf(w.types[i], tK) - p.deathRate);
    }
    return out;
  }

  /** RK4 で dt だけ進める。 */
  function stepWorld(w, luminosity, dt) {
    var h = dt != null ? dt : w.params.dt;
    var c = w.cover, i;
    derivative(w, c, luminosity, w.k1);
    for (i = 0; i < w.n; i++) w.tmp[i] = c[i] + 0.5 * h * w.k1[i];
    derivative(w, w.tmp, luminosity, w.k2);
    for (i = 0; i < w.n; i++) w.tmp[i] = c[i] + 0.5 * h * w.k2[i];
    derivative(w, w.tmp, luminosity, w.k3);
    for (i = 0; i < w.n; i++) w.tmp[i] = c[i] + h * w.k3[i];
    derivative(w, w.tmp, luminosity, w.k4);
    for (i = 0; i < w.n; i++) {
      c[i] += (h / 6) * (w.k1[i] + 2 * w.k2[i] + 2 * w.k3[i] + w.k4[i]);
    }
    clampCover(w, c);
    return w;
  }

  /** 前進オイラー。RK4 の検算用（近道の検算）。 */
  function stepEuler(w, luminosity, dt) {
    var h = dt != null ? dt : w.params.dt;
    derivative(w, w.cover, luminosity, w.k1);
    for (var i = 0; i < w.n; i++) w.cover[i] += h * w.k1[i];
    clampCover(w, w.cover);
    return w;
  }

  // =====================================================================
  // ここから下は**観測器**である。上位概念の語彙を使ってよいのはこちら側だけ。
  // selftest.js はこの境界行より上だけを語彙検査にかける。
  // BOUNDARY: OBSERVER
  // =====================================================================
  // ------------------------------------------------------------- 観測器

  /**
   * 今の状態を丸ごと読み出す。**world.cover からその場で全量を再計算する**ので、
   * 返り値の内部（cover と albedo と temperature）は必ず整合している。
   */
  function sample(w, luminosity) {
    var p = w.params;
    var c = w.cover;
    var A = albedoOf(w, c);
    var free = freeOf(w, c);
    var meanK = meanTempK(p, luminosity, A);
    var cover = [], local = [], growth = [], maxRate = 0;
    for (var i = 0; i < w.n; i++) {
      var tK = localTempK(p, meanK, A, w.types[i].albedo);
      var g = growthOf(w.types[i], tK);
      cover.push(c[i]);
      local.push(tK - ZERO_C);
      growth.push(g);
      var r = Math.abs(c[i] * (free * g - p.deathRate));
      if (r > maxRate) maxRate = r;
    }
    return {
      luminosity: luminosity,
      cover: cover,
      free: free,
      albedo: A,
      tempC: meanK - ZERO_C,
      localTempC: local,
      growth: growth,
      maxRate: maxRate
    };
  }

  /** 被覆型が 1 つも無い表面の温度（摂氏）。解析解。 */
  function bareTempC(params, luminosity) {
    var p = {};
    Object.keys(DEFAULTS).forEach(function (k) { p[k] = DEFAULTS[k]; });
    Object.keys(params || {}).forEach(function (k) { p[k] = params[k]; });
    return meanTempK(p, luminosity, p.groundAlbedo) - ZERO_C;
  }

  // ------------------------------------------------------------- 掃引

  /**
   * 光度を刻みながら準静的に掃引する。1 点あたり stepsPerL 回進めてから観測し、
   * 状態は次の L へ持ち越す。
   * @returns {Array} 各格子点の sample（luminosity 昇順ではなく**掃引した順**）
   */
  function runSweep(w, opts) {
    var o = opts || {};
    var start = o.lumStart, end = o.lumEnd, step = Math.abs(o.lumStep);
    var dir = end >= start ? 1 : -1;
    var n = Math.round(Math.abs(end - start) / step) + 1;
    var stepsPerL = o.stepsPerL != null ? o.stepsPerL : 400;
    var dt = o.dt != null ? o.dt : w.params.dt;
    var out = [];
    for (var k = 0; k < n; k++) {
      var L = start + dir * step * k;
      for (var t = 0; t < stepsPerL; t++) stepWorld(w, L, dt);
      out.push(sample(w, L));
    }
    return out;
  }

  /** 掃引の結果を光度の昇順に並べ替えた新しい配列を返す。 */
  function ascending(samples) {
    return samples.slice().sort(function (a, b) { return a.luminosity - b.luminosity; });
  }

  /**
   * s(L) = |ΔT_live| / |ΔT_bare|（中心差分）を格子上で計算する。
   * @param {Array} samples  光度の昇順に並んだ観測列
   * @param {object} params  裸の表面の温度を出すためのパラメータ
   */
  function slopeRatios(samples, params) {
    var out = [];
    for (var i = 1; i < samples.length - 1; i++) {
      var lo = samples[i - 1].luminosity, hi = samples[i + 1].luminosity;
      var dLive = Math.abs(samples[i + 1].tempC - samples[i - 1].tempC);
      var dBare = Math.abs(bareTempC(params, hi) - bareTempC(params, lo));
      out.push({ luminosity: samples[i].luminosity, s: dBare > 0 ? dLive / dBare : NaN });
    }
    return out;
  }

  function median(xs) {
    if (!xs.length) return NaN;
    var a = xs.slice().sort(function (p, q) { return p - q; });
    var m = a.length >> 1;
    return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
  }

  /**
   * 事前登録した秩序変数を計算する。
   * @param {Array}  samples         光度の昇順に並んだ観測列
   * @param {object} params          パラメータ
   * @param {number} innerThreshold  s(L) に掛ける閾値
   */
  function measureSweep(samples, params, innerThreshold) {
    var thr = innerThreshold != null ? innerThreshold : 0.5;
    var ratios = slopeRatios(samples, params);
    var svals = ratios.map(function (r) { return r.s; }).filter(function (x) { return isFinite(x); });
    var step = samples.length > 1 ? Math.abs(samples[1].luminosity - samples[0].luminosity) : 0;
    var inBand = ratios.filter(function (r) { return isFinite(r.s) && r.s <= thr; });
    var byL = {};
    samples.forEach(function (s) { byL[s.luminosity.toFixed(6)] = s; });

    var lumLo = Infinity, lumHi = -Infinity, tLo = Infinity, tHi = -Infinity;
    inBand.forEach(function (r) {
      if (r.luminosity < lumLo) lumLo = r.luminosity;
      if (r.luminosity > lumHi) lumHi = r.luminosity;
      var s = byL[r.luminosity.toFixed(6)];
      if (s) { if (s.tempC < tLo) tLo = s.tempC; if (s.tempC > tHi) tHi = s.tempC; }
    });

    var albedos = samples.map(function (s) { return s.albedo; });
    var temps = samples.map(function (s) { return s.tempC; });
    var fertile = params.fertile != null ? params.fertile : DEFAULTS.fertile;
    var covered = samples.map(function (s) { return fertile - s.free; });

    return {
      regulatedWidth: inBand.length * step,
      slopeRatioMin: svals.length ? Math.min.apply(null, svals) : NaN,
      slopeRatioMax: svals.length ? Math.max.apply(null, svals) : NaN,
      slopeRatioMedian: median(svals),
      albedoSpan: Math.max.apply(null, albedos) - Math.min.apply(null, albedos),
      albedoMin: Math.min.apply(null, albedos),
      albedoMax: Math.max.apply(null, albedos),
      tempSpanC: Math.max.apply(null, temps) - Math.min.apply(null, temps),
      maxCovered: Math.max.apply(null, covered),
      bandLumLo: inBand.length ? lumLo : NaN,
      bandLumHi: inBand.length ? lumHi : NaN,
      tempBandC: inBand.length ? tHi - tLo : NaN,
      bareBandC: inBand.length ? bareTempC(params, lumHi) - bareTempC(params, lumLo) : NaN,
      gridPoints: ratios.length,
      innerThreshold: thr
    };
  }

  /** σT^4 = S·L·(1−A) をニュートン法で解く（閉じた式の検算用）。 */
  function meanTempKNewton(p, luminosity, albedo) {
    var target = p.solarFlux * luminosity * (1 - albedo);
    var t = 300;
    for (var i = 0; i < 200; i++) {
      var f = p.sigma * Math.pow(t, 4) - target;
      var df = 4 * p.sigma * Math.pow(t, 3);
      t -= f / df;
    }
    return t;
  }

  return {
    ZERO_C: ZERO_C,
    DEFAULTS: DEFAULTS,
    TYPE_DEFAULTS: TYPE_DEFAULTS,
    makeRng: makeRng,
    makeTypes: makeTypes,
    randomTypes: randomTypes,
    createWorld: createWorld,
    clampCover: clampCover,
    freeOf: freeOf,
    albedoOf: albedoOf,
    meanTempK: meanTempK,
    meanTempKNewton: meanTempKNewton,
    localTempK: localTempK,
    growthOf: growthOf,
    derivative: derivative,
    stepWorld: stepWorld,
    stepEuler: stepEuler,
    sample: sample,
    bareTempC: bareTempC,
    runSweep: runSweep,
    ascending: ascending,
    slopeRatios: slopeRatios,
    median: median,
    measureSweep: measureSweep
  };
});
