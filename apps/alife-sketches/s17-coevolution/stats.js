/**
 * S-17 の観測器。**ここから先だけが「進歩」「赤の女王」を語る。**
 * core.js の側には形質・対戦・取り分・複製しか無い。
 *
 * ---- CIAO 行列 ----
 *
 * 控えた並びの列 A_0..A_{G-1}（side 0）と B_0..B_{G-1}（side 1）に対して
 *
 *     M[i][j] = mean over all pairs  S(A_i の個体, B_j の個体)
 *
 * を作る。**全ペアの平均なので標本誤差はゼロ**（推定ではなく定義どおりの値）。
 * Cliff & Miller (1995) の CIAO（Current Individual vs Ancestral Opponent）プロットにあたる。
 *
 * ---- 同じ観測量を、三つの参照点で読む ----
 *
 * 遅れ k = i − j（正なら side 0 のほうが新しい）ごとに平均した
 *
 *     W(k) = mean_{i−j=k} M[i][j],      D(k) = W(+k) − W(−k)
 *
 * を「遅れ断面」と呼ぶ。**同じ1枚の M から、参照点の取り方だけで三つの答えが出る**:
 *
 *   C     = W(0) − 1/2       参照点 = 同時代の相手
 *   H_near= mean_{k∈近} D(k) 参照点 = ごく近い過去の相手
 *   H_far = mean_{k∈遠} D(k) 参照点 = 遠い過去の相手
 *
 * **D(k) は時間反転に対して厳密に符号が反転する**（M[i][j] → M[G-1-i][G-1-j] で W(k) ↔ W(−k)）。
 * したがって D の帰無値は全ての k で 0 で、これは実装の外から来る恒等式である（method K-18）。
 *
 * ---- 参照点（method K-9 の4つ目の自由度・K-24） ----
 *
 * 帰無は「控えた並びの時間の順序だけを壊したもの」に取る。行と列に**同じ置換**を当てると、
 * 同時代の組（対角）は同時代のまま保たれ、**時間の矢だけが消える**。
 * 「一様なものと違う」型の弱い帰無ではなく、系そのものを参照点にしている。
 *
 * ---- 遅れを走査しない（method K-23） ----
 *
 * 「どこかの遅れで閾値を越えた」という読み方は偽陽性を膨らませる。登録した窓の D(k) を
 * **曲線ごと1回の大域検定**にかける（studentized MAD のモンテカルロ検定）。
 * 各点包絡線を「どこかで外れた」割合も同時に出して、走査の代価を数で見せる。
 *
 * 依存ゼロ。core.js と同じく Node とブラウザで共用する（古典スクリプト・UMD 風）。
 */
(function (root, factory) {
  var api = factory(typeof module === 'object' && module.exports ? require('./core.js') : root.S17);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S17S = api;
})(typeof self !== 'undefined' ? self : this, function (S17) {
  'use strict';

  /* ------------------------------------------------------------------ *
   * CIAO 行列
   * ------------------------------------------------------------------ */

  /**
   * archA[i], archB[j] は Int32Array（控えた並び）。
   * 返り値 M は長さ G*G の Float64Array で M[i*G+j] が side 0 の取り分の平均。
   * sample を正の整数にすると全ペアではなく sample 組だけを引く（ノブの一つ）。
   */
  function ciaoMatrix(archA, archB, L, w, sample, rng) {
    var G = archA.length, mask = S17.maskOf(L);
    var M = new Float64Array(G * G);
    for (var i = 0; i < G; i++) {
      var A = archA[i], na = A.length;
      for (var j = 0; j < G; j++) {
        var B = archB[j], nb = B.length, acc = 0, cnt = 0;
        if (sample) {
          for (var s = 0; s < sample; s++) {
            acc += S17.scorePair(A[(rng() * na) | 0], B[(rng() * nb) | 0], L, w, mask);
          }
          cnt = sample;
        } else {
          for (var x = 0; x < na; x++) {
            var a = A[x];
            for (var y = 0; y < nb; y++) acc += S17.scorePair(a, B[y], L, w, mask);
          }
          cnt = na * nb;
        }
        M[i * G + j] = acc / cnt;
      }
    }
    return M;
  }

  /** 素朴版（近道の検算用）。1マスだけを三重ループで出す。 */
  function ciaoCellNaive(A, B, L, w) {
    var acc = 0;
    for (var x = 0; x < A.length; x++) {
      for (var y = 0; y < B.length; y++) acc += S17.scorePairNaive(A[x], B[y], L, w);
    }
    return acc / (A.length * B.length);
  }

  /* ------------------------------------------------------------------ *
   * 遅れ断面
   * ------------------------------------------------------------------ */

  /** W(k)、k = −(G−1)..(G−1)。返り値は {k, mean, count} の配列（k 昇順）。 */
  function lagProfile(M, G) {
    var sum = new Float64Array(2 * G - 1), cnt = new Float64Array(2 * G - 1);
    for (var i = 0; i < G; i++) {
      for (var j = 0; j < G; j++) {
        var k = i - j + (G - 1);
        sum[k] += M[i * G + j]; cnt[k]++;
      }
    }
    var out = [];
    for (var t = 0; t < 2 * G - 1; t++) out.push({ k: t - (G - 1), mean: sum[t] / cnt[t], count: cnt[t] });
    return out;
  }

  /** D(k) = W(+k) − W(−k)、k = 1..kmax。 */
  function asymmetry(M, G, kmax) {
    var prof = lagProfile(M, G), mid = G - 1, K = Math.min(kmax, G - 1);
    var D = new Float64Array(K + 1), Wp = new Float64Array(K + 1), Wm = new Float64Array(K + 1);
    D[0] = 0; Wp[0] = Wm[0] = prof[mid].mean;
    for (var k = 1; k <= K; k++) {
      Wp[k] = prof[mid + k].mean; Wm[k] = prof[mid - k].mean; D[k] = Wp[k] - Wm[k];
    }
    return { D: D, Wplus: Wp, Wminus: Wm, W0: prof[mid].mean, K: K };
  }

  function median(xs) {
    var v = Array.prototype.slice.call(xs).sort(function (p, q) { return p - q; });
    var n = v.length;
    if (!n) return 0;
    return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  }

  /** D(k) と k の Pearson 相関（k = 1..kmax）。遅れが伸びると差が広がるか縮むかの「形」。 */
  function slopeR(D, kmax) {
    var n = kmax, sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0;
    for (var k = 1; k <= kmax; k++) {
      var x = k, y = D[k];
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y;
    }
    var cov = sxy / n - (sx / n) * (sy / n);
    var vx = sxx / n - (sx / n) * (sx / n), vy = syy / n - (sy / n) * (sy / n);
    if (vx <= 0 || vy <= 0) return 0;
    return cov / Math.sqrt(vx * vy);
  }

  function aggregate(D, lo, hi, agg) {
    var xs = [];
    for (var k = lo; k <= hi; k++) xs.push(D[k]);
    if (!xs.length) return 0;
    return agg === 'median' ? median(xs) : xs.reduce(function (a, b) { return a + b; }, 0) / xs.length;
  }

  /**
   * 秩序変数。opts = {near:[lo,hi], far:[lo,hi], kmaxAll, agg:'mean'|'median'}
   * すべて同じ1枚の M から、**参照点（遅れ）の取り方だけを変えて**読む。
   */
  function orderParams(M, G, opts) {
    var near = opts.near, far = opts.far;
    var kmaxAll = Math.min(opts.kmaxAll === undefined ? G - 1 : opts.kmaxAll, G - 1);
    var agg = opts.agg || 'mean';
    var a = asymmetry(M, G, kmaxAll);
    var farHi = Math.min(far[1], kmaxAll), farLo = Math.min(far[0], farHi);
    var nearHi = Math.min(near[1], kmaxAll), nearLo = Math.min(near[0], nearHi);
    var Hnear = aggregate(a.D, nearLo, nearHi, agg);
    var Hfar = aggregate(a.D, farLo, farHi, agg);
    // K-26: 登録した窓の外側で D がまだ伸びていないか
    var maxAbs = 0, kAtMax = 0;
    for (var k = 1; k <= kmaxAll; k++) if (Math.abs(a.D[k]) > maxAbs) { maxAbs = Math.abs(a.D[k]); kAtMax = k; }
    return {
      G: G, near: [nearLo, nearHi], far: [farLo, farHi], kmaxAll: kmaxAll, agg: agg,
      contemporary: a.W0 - 0.5, diagonalMean: a.W0,
      Hnear: Hnear, Hfar: Hfar,
      persistence: Math.abs(Hnear) > 1e-12 ? Hfar / Hnear : 0,
      farLower: aggregate(a.Wplus, farLo, farHi, agg),
      farUpper: aggregate(a.Wminus, farLo, farHi, agg),
      nearLower: aggregate(a.Wplus, nearLo, nearHi, agg),
      nearUpper: aggregate(a.Wminus, nearLo, nearHi, agg),
      D: a.D, Wplus: a.Wplus, Wminus: a.Wminus,
      slopeR: slopeR(a.D, kmaxAll),
      kAtMaxAbsD: kAtMax, maxAbsD: maxAbs,
      edgeRise: a.D[farHi] - a.D[farLo],
      edgeAtCap: maxAbs > 0 ? Math.abs(a.D[kmaxAll]) / maxAbs : 0,
    };
  }

  /** 時間を反転した行列。恒等式 D_rev(k) = −D(k) の検査に使う。 */
  function reverseTime(M, G) {
    var R = new Float64Array(G * G);
    for (var i = 0; i < G; i++) for (var j = 0; j < G; j++) R[i * G + j] = M[(G - 1 - i) * G + (G - 1 - j)];
    return R;
  }

  /** 行と列に同じ置換を当てる（同時代の組は保ち、時間の矢だけを壊す帰無）。 */
  function permuteTime(M, G, perm) {
    var P = new Float64Array(G * G);
    for (var i = 0; i < G; i++) for (var j = 0; j < G; j++) P[i * G + j] = M[perm[i] * G + perm[j]];
    return P;
  }

  function randomPerm(G, rng) {
    var p = new Int32Array(G);
    for (var i = 0; i < G; i++) p[i] = i;
    for (var j = G - 1; j > 0; j--) {
      var r = (rng() * (j + 1)) | 0;
      var t = p[j]; p[j] = p[r]; p[r] = t;
    }
    return p;
  }

  /* ------------------------------------------------------------------ *
   * 大域検定（K-23）
   * ------------------------------------------------------------------ */

  /**
   * 登録した窓 [lo,hi] の D(k) を曲線ごと1回の検定にかける。
   * 帰無は「同じ置換を行と列に当てたもの」nNull 本。
   * 統計量は studentized MAD = max_k |D(k) − mean_null(k)| / sd_null(k)。
   * 平均と標準偏差は データ1本 + 帰無 nNull 本 の計 (nNull+1) 本から出す（厳密なモンテカルロ検定）。
   */
  function windowTest(Dobs, nullDs, lo, hi, agg) {
    var K = hi - lo + 1, nNull = nullDs.length, nn = nNull + 1;
    var mean = new Float64Array(K), sd = new Float64Array(K);
    for (var t = 0; t < K; t++) {
      var k = lo + t, s = Dobs[k], s2 = Dobs[k] * Dobs[k];
      for (var m = 0; m < nNull; m++) { s += nullDs[m][k]; s2 += nullDs[m][k] * nullDs[m][k]; }
      mean[t] = s / nn;
      var v = s2 / nn - mean[t] * mean[t];
      sd[t] = Math.sqrt(Math.max(v, 0));
    }
    // sd がほぼ 0 の成分は studentize しない（0/0 を「有意」に化けさせない）
    var floor = 0;
    for (var f = 0; f < K; f++) floor = Math.max(floor, sd[f]);
    floor = Math.max(floor * 1e-6, 1e-12);
    for (var g = 0; g < K; g++) if (sd[g] < floor) sd[g] = floor;

    function mad(D) {
      var mx = 0;
      for (var q = 0; q < K; q++) {
        var z = Math.abs(D[lo + q] - mean[q]) / sd[q];
        if (z > mx) mx = z;
      }
      return mx;
    }
    var madObs = mad(Dobs), ge = 1;
    for (var n2 = 0; n2 < nNull; n2++) if (mad(nullDs[n2]) >= madObs) ge++;

    var envLo = [], envHi = [], outCount = 0;
    for (var e = 0; e < K; e++) {
      var col = [];
      for (var m2 = 0; m2 < nNull; m2++) col.push(nullDs[m2][lo + e]);
      col.sort(function (a, b) { return a - b; });
      var l = col[1], h = col[col.length - 2];
      envLo.push(l); envHi.push(h);
      if (Dobs[lo + e] < l || Dobs[lo + e] > h) outCount++;
    }
    // 窓の集約値そのものの帰無分布
    var Hobs = aggregate(Dobs, lo, hi, agg), geH = 1, Hn = [];
    for (var n3 = 0; n3 < nNull; n3++) {
      var hv = aggregate(nullDs[n3], lo, hi, agg);
      Hn.push(hv);
      if (Math.abs(hv) >= Math.abs(Hobs)) geH++;
    }
    Hn.sort(function (a, b) { return a - b; });
    return {
      lo: lo, hi: hi, K: K, H: Hobs,
      globalP: ge / nn, mad: madObs,
      envelopeLo: envLo, envelopeHi: envHi,
      pointwiseOutCount: outCount, anyPointwiseOut: outCount > 0,
      hP: geH / nn, hEnvLo: Hn[1], hEnvHi: Hn[Hn.length - 2],
      nullMean: Array.prototype.slice.call(mean), nullSd: Array.prototype.slice.call(sd),
    };
  }

  /** 観測と帰無を作り、近窓・遠窓の両方を検定する。 */
  function analyse(M, G, opts, nNull, rng) {
    var obs = orderParams(M, G, opts);
    var nullDs = [];
    for (var n = 0; n < nNull; n++) {
      var P = permuteTime(M, G, randomPerm(G, rng));
      nullDs.push(orderParams(P, G, opts).D);
    }
    // **形の統計量は帰無の広がりで割ってから測る。**
    // 遅れが大きいほど組の数が減り D(k) の散らばりが増える——素の D(k) に傾きを当てると
    // 帰無の置換ですら |r| がほぼ 1 になり、何も区別できない。各 k を帰無の sd で割ってから
    // k との相関を取る（studentized shape）。
    var K = obs.kmaxAll, nn = nNull + 1;
    var mu = new Float64Array(K + 1), sd = new Float64Array(K + 1);
    for (var k = 1; k <= K; k++) {
      var s1 = obs.D[k], s2 = obs.D[k] * obs.D[k];
      for (var m = 0; m < nNull; m++) { s1 += nullDs[m][k]; s2 += nullDs[m][k] * nullDs[m][k]; }
      mu[k] = s1 / nn;
      sd[k] = Math.sqrt(Math.max(s2 / nn - mu[k] * mu[k], 0)) || 1e-12;
    }
    function zslope(D) {
      var z = new Float64Array(K + 1);
      for (var q = 1; q <= K; q++) z[q] = (D[q] - mu[q]) / sd[q];
      return slopeR(z, K);
    }
    var sObs = zslope(obs.D), geS = 1, ns = [];
    for (var n2 = 0; n2 < nNull; n2++) {
      var v = zslope(nullDs[n2]); ns.push(v);
      if (Math.abs(v) >= Math.abs(sObs)) geS++;
    }
    ns.sort(function (a, b) { return a - b; });
    return {
      obs: obs,
      far: windowTest(obs.D, nullDs, obs.far[0], obs.far[1], obs.agg),
      near: windowTest(obs.D, nullDs, obs.near[0], obs.near[1], obs.agg),
      slope: { r: sObs, rawR: obs.slopeR, p: geS / nn, envLo: ns[1], envHi: ns[ns.length - 2] },
      nNull: nNull,
    };
  }

  /* ------------------------------------------------------------------ *
   * 形質の動き（連言のもう一方）
   * ------------------------------------------------------------------ */

  /**
   * 控えた並びの間で、位置ごとの 1 の割合がどれだけ動いたか。
   * freq[role][k] は Float64Array(L)。隣り合う控えの間の L1 距離 / L を **stride 世代で割って
   * 1世代あたりに直し**、側ごとに平均して**小さい方**を返す（両側とも動いていることを要求するため）。
   * stride で割らないと、控える間隔（ノブ）を変えるだけで判定が動いてしまう。
   */
  function turnover(freq, L, stride) {
    var st = stride || 1;
    var per = [0, 0];
    for (var r = 0; r < 2; r++) {
      var f = freq[r], acc = 0;
      for (var k = 1; k < f.length; k++) {
        var d = 0;
        for (var p = 0; p < L; p++) d += Math.abs(f[k][p] - f[k - 1][p]);
        acc += d / L;
      }
      per[r] = f.length > 1 ? acc / ((f.length - 1) * st) : 0;
    }
    return { side0: per[0], side1: per[1], min: Math.min(per[0], per[1]) };
  }

  /* ------------------------------------------------------------------ *
   * 事前登録した判定規則（本番で使うのはこの関数だけ）
   * ------------------------------------------------------------------ */

  /**
   * crit は criteria.json の decision 節。
   * **三つの札は排他でない。** 同時に立つことも一つも立たないこともあり、そこも含めて報告する。
   */
  function decide(an, turn, crit) {
    var o = an.obs;
    var moving = turn.min >= crit.turnoverFloor;
    var gain = (an.far.globalP <= crit.globalP) && (o.Hfar >= crit.hMin) && (o.Hfar > an.far.hEnvHi);
    var track = (an.near.globalP <= crit.globalP) && (o.Hnear >= crit.hMin) && (o.Hnear > an.near.hEnvHi);
    return {
      // 遠い過去の相手に勝ち越している
      lastingGain: gain,
      // 近い過去にだけ勝ち越し、遠い過去には勝ち越さず、形質は動いている
      trackingOnly: track && !gain && moving,
      // 形質が動いていない（どちらの札も意味を持たない）
      notMoving: !moving,
      gain: gain, track: track, moving: moving,
      Hnear: o.Hnear, Hfar: o.Hfar, contemporary: o.contemporary,
      // 以下は報告するだけで判定には使わない（記述子）
      slopeZ: an.slope.r, slopeR: o.slopeR, persistence: o.persistence,
      kAtMaxAbsD: o.kAtMaxAbsD, maxAbsD: o.maxAbsD,
      pFar: an.far.globalP, pNear: an.near.globalP, turnover: turn.min,
      farEnvHi: an.far.hEnvHi, nearEnvHi: an.near.hEnvHi,
    };
  }

  /**
   * **腕（同じ設定の複数シード）の判定。rev2 で判定の単位をここへ移した。**
   *
   * 1本ごとの Hfar は裾が重い——相手を見ない対照でも 28 本に1本は 0.055〜0.068 を返し、
   * そのとき slopeR も |D| の最大位置も正コントロールと見分けが付かなかった。
   * 中央値を取ると分布は分離する（対照の中央値 ≲ 0.015、順序のある系 ≳ 0.057）。
   * **1本ごとの値は生ログに全部残す**（K-3）。ここで畳むのは判定だけである。
   */
  function decideArm(reps, crit) {
    function med(f) { return median(reps.map(f)); }
    var mHfar = med(function (r) { return r.Hfar; });
    var mHnear = med(function (r) { return r.Hnear; });
    var mTurn = med(function (r) { return r.turnover; });
    var gain = (mHfar >= crit.hMin) &&
               (mHfar > med(function (r) { return r.farEnvHi; })) &&
               (med(function (r) { return r.pFar; }) <= crit.globalP);
    var track = (mHnear >= crit.hMin) &&
                (mHnear > med(function (r) { return r.nearEnvHi; })) &&
                (med(function (r) { return r.pNear; }) <= crit.globalP);
    var moving = mTurn >= crit.turnoverFloor;
    function frac(f) { return reps.filter(f).length / reps.length; }
    return {
      n: reps.length,
      lastingGain: gain,
      trackingOnly: track && !gain && moving,
      notMoving: !moving,
      gain: gain, track: track, moving: moving,
      Hfar: mHfar, Hnear: mHnear, turnover: mTurn,
      contemporary: med(function (r) { return r.contemporary; }),
      slopeR: med(function (r) { return r.slopeR; }),
      HfarMin: Math.min.apply(null, reps.map(function (r) { return r.Hfar; })),
      HfarMax: Math.max.apply(null, reps.map(function (r) { return r.Hfar; })),
      // 1本ごとに見たときの発火率。腕の判定には使わないが必ず報告する
      perReplicateGainRate: frac(function (r) { return r.gain; }),
      perReplicateTrackRate: frac(function (r) { return r.track; }),
    };
  }

  return {
    decideArm: decideArm,
    ciaoMatrix: ciaoMatrix, ciaoCellNaive: ciaoCellNaive,
    lagProfile: lagProfile, asymmetry: asymmetry, orderParams: orderParams,
    reverseTime: reverseTime, permuteTime: permuteTime, randomPerm: randomPerm,
    windowTest: windowTest, analyse: analyse, turnover: turnover, decide: decide,
    median: median, aggregate: aggregate, slopeR: slopeR,
  };
});
