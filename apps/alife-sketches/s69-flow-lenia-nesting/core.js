/**
 * S-69: Flow-Lenia の核（物理エンジン）。依存ゼロ・古典スクリプト・Node とブラウザ共用（UMD）。
 * 上位概念の語彙を持たない（cell/membrane/gene/organism/catalyst/fitness/alive を識別子に使わない）。
 *
 * 出典・式の対応は apps/alife-sketches/s69-flow-lenia-nesting/criteria.json の "system" を見よ。
 * 式番号は 2023 版（arXiv:2212.07906）のもの:
 *   (1) 核 K_i  (2) 成長 G_i  (3)(8) 親和性 U  (5) 流れ F  (6)(7) 再積分の輸送
 *   (9)(10) 混ぜ方（平均・softmax）  (11) 食物
 *
 * 単位: 長さはセル、時間は歩（1歩 = dt = 0.2）。格子は 128×128 の周期境界（トーラス）。
 */
(function (global) {
  'use strict';

  /* ============================================================ 乱数・ハッシュ */

  /** mulberry32（S-41 と同型）。決定的・シード固定。 */
  function mulberry32(a) {
    a = a >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** FNV-1a 文字列ハッシュ。seed と用途タグから独立な部分列を作る（K-145）。 */
  function subSeed(seed, tag) {
    var s = String(seed) + ':' + tag, h = 0x811c9dc5;
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  function makeRng(seed) { return mulberry32(seed); }
  function subRng(seed, tag) { return mulberry32(subSeed(seed, tag)); }

  /** Box-Muller。標準正規乱数を1個返す（多種の種の h ~ N(0,1) 用）。 */
  function gaussian(rng) {
    var u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** 64bit 相当に丸めた状態ハッシュ（K-36）。決定的な系の同一性判定に使う。 */
  function hashArray(arr) {
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < arr.length; i++) {
      var v = Math.round(arr[i] * 1e9) | 0;
      h1 = Math.imul(h1 ^ (v & 0xffff), 16777619) >>> 0;
      h2 = Math.imul(h2 ^ ((v >>> 16) & 0xffff), 2246822519) >>> 0;
    }
    return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
  }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* ============================================================ FFT（複素・反復・基数2） */

  var _fftTables = {};
  function fftTables(N) {
    var t = _fftTables[N];
    if (t) return t;
    var bits = Math.round(Math.log2(N));
    var rev = new Int32Array(N);
    for (var i = 0; i < N; i++) {
      var r = 0, x = i;
      for (var b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      rev[i] = r;
    }
    var cos = new Float64Array(N / 2), sin = new Float64Array(N / 2);
    for (i = 0; i < N / 2; i++) { var ang = -2 * Math.PI * i / N; cos[i] = Math.cos(ang); sin[i] = Math.sin(ang); }
    t = { rev: rev, cos: cos, sin: sin, bits: bits };
    _fftTables[N] = t;
    return t;
  }

  /** 1次元 FFT（in place）。re/im は長さ N（2冪）の Float64Array。invert=true で逆変換（1/N はここで掛ける）。 */
  function fft1d(re, im, N, invert) {
    var tb = fftTables(N), rev = tb.rev, cos = tb.cos, sin = tb.sin;
    var i, j;
    for (i = 0; i < N; i++) {
      j = rev[i];
      if (j > i) { var tr = re[i]; re[i] = re[j]; re[j] = tr; var ti = im[i]; im[i] = im[j]; im[j] = ti; }
    }
    for (var len = 2; len <= N; len <<= 1) {
      var half = len >> 1, step = N / len;
      for (i = 0; i < N; i += len) {
        for (j = 0; j < half; j++) {
          var idx = j * step;
          var wr = cos[idx], wi = invert ? sin[idx] : -sin[idx];
          var a = i + j, b = i + j + half;
          var ur = re[a], ui = im[a];
          var vr = re[b] * wr - im[b] * wi;
          var vi = re[b] * wi + im[b] * wr;
          re[a] = ur + vr; im[a] = ui + vi;
          re[b] = ur - vr; im[b] = ui - vi;
        }
      }
    }
    if (invert) { for (i = 0; i < N; i++) { re[i] /= N; im[i] /= N; } }
  }

  /** 2次元 FFT（正方 N×N、row-major）。行パス→転置→行パス→転置で戻す。 */
  function fft2d(re, im, N, invert) {
    var i, j, rr = new Float64Array(N), ri = new Float64Array(N);
    for (i = 0; i < N; i++) {
      var off = i * N;
      for (j = 0; j < N; j++) { rr[j] = re[off + j]; ri[j] = im[off + j]; }
      fft1d(rr, ri, N, invert);
      for (j = 0; j < N; j++) { re[off + j] = rr[j]; im[off + j] = ri[j]; }
    }
    transposeSquareInPlace(re, N); transposeSquareInPlace(im, N);
    for (i = 0; i < N; i++) {
      var off2 = i * N;
      for (j = 0; j < N; j++) { rr[j] = re[off2 + j]; ri[j] = im[off2 + j]; }
      fft1d(rr, ri, N, invert);
      for (j = 0; j < N; j++) { re[off2 + j] = rr[j]; im[off2 + j] = ri[j]; }
    }
    transposeSquareInPlace(re, N); transposeSquareInPlace(im, N);
  }

  function transposeSquareInPlace(a, N) {
    for (var i = 0; i < N; i++) {
      for (var j = i + 1; j < N; j++) {
        var t = a[i * N + j]; a[i * N + j] = a[j * N + i]; a[j * N + i] = t;
      }
    }
  }

  /* ============================================================ 核（式1）と成長（式2） */

  /**
   * 式1の核をトーラス上の実空間配列 N×N へ焼き込み、Σ=1 に正規化し、FFT のスペクトル（複素）を返す。
   * 中心 (0,0) を原点に、|dx|,|dy| <= N/2 のオフセットへ、周期的に (dy+N)%N, (dx+N)%N の位置へ置く
   * （これが FFT の巡回畳み込みと一致する配置）。b の全項が小さければ（Σ|b| < 1e-12）核を 0 とみなす。
   */
  function buildKernelSpectrum(kdef, R, N) {
    var real = new Float64Array(N * N);
    var bAbsSum = Math.abs(kdef.b[0]) + Math.abs(kdef.b[1]) + Math.abs(kdef.b[2]);
    var zeroed = bAbsSum < 1e-12;
    var sum = 0;
    var rad = Math.min(Math.floor(kdef.r * R) + 1, Math.floor(N / 2) - 1);
    if (!zeroed) {
      for (var dy = -rad; dy <= rad; dy++) {
        for (var dx = -rad; dx <= rad; dx++) {
          var d = Math.sqrt(dx * dx + dy * dy) / (kdef.r * R);
          if (d > 1) continue;
          var w = 0;
          for (var j = 0; j < 3; j++) {
            var z = (d - kdef.a[j]) / kdef.w[j];
            w += kdef.b[j] * Math.exp(-0.5 * z * z);
          }
          if (w === 0) continue;
          var xi = ((dx % N) + N) % N, yi = ((dy % N) + N) % N;
          real[yi * N + xi] += w;
          sum += w;
        }
      }
    }
    var normFactor = (!zeroed && sum > 1e-12) ? (1 / sum) : 0;
    var re = new Float64Array(N * N), im = new Float64Array(N * N);
    for (var i = 0; i < N * N; i++) re[i] = real[i] * normFactor;
    fft2d(re, im, N, false);
    return { re: re, im: im, zeroed: zeroed || normFactor === 0, sumBeforeNorm: sum, discreteSum: normFactor ? 1 : 0 };
  }

  /** 成長写像（式2）: G(u) = 2 exp(-(mu-u)^2/(2 sigma^2)) - 1 ∈ [-1,1]。G(mu) = 1。 */
  function growth(u, mu, sigma) {
    var d = (mu - u) / sigma;
    return 2 * Math.exp(-0.5 * d * d) - 1;
  }

  /** 周期境界の Sobel（8で割って一次の傾きの推定にする。原典「in practice gradients are estimated through Sobel filtering」）。 */
  function sobel(A, N, gx, gy) {
    for (var y = 0; y < N; y++) {
      var yu = (y - 1 + N) % N, yd = (y + 1) % N, yo = y * N;
      var yuo = yu * N, ydo = yd * N;
      for (var x = 0; x < N; x++) {
        var xl = (x - 1 + N) % N, xr = (x + 1) % N;
        var v_ul = A[yuo + xl], v_u = A[yuo + x], v_ur = A[yuo + xr];
        var v_l = A[yo + xl], v_r = A[yo + xr];
        var v_dl = A[ydo + xl], v_d = A[ydo + x], v_dr = A[ydo + xr];
        gx[yo + x] = (-v_ul + v_ur - 2 * v_l + 2 * v_r - v_dl + v_dr) / 8;
        gy[yo + x] = (-v_ul - 2 * v_u - v_ur + v_dl + 2 * v_d + v_dr) / 8;
      }
    }
  }

  /** 複素の点ごとの積（畳み込み定理）。out に書く。 */
  function complexMulInto(are, aim, bre, bim, outre, outim) {
    for (var i = 0; i < are.length; i++) {
      var r = are[i] * bre[i] - aim[i] * bim[i];
      var im2 = are[i] * bim[i] + aim[i] * bre[i];
      outre[i] = r; outim[i] = im2;
    }
  }

  /* ============================================================ 再積分の追跡（式6・式7） */

  /** site c（一辺1・中心 c）と区間 [lo,hi] の重なりの長さ。 */
  function overlap1d(c, lo, hi) {
    var a = Math.max(lo, c - 0.5), b = Math.min(hi, c + 0.5);
    return b > a ? b - a : 0;
  }

  /**
   * 1チャネルの輸送。Asrc の各セルの物質を、変位 (dt*Fx, dt*Fy)（±clipMax に切り詰め）だけ動かした
   * 中心・一辺 2s の一様な正方へ、重なり面積 ÷ (2s)^2 の比で配る。総質量は厳密に保たれる。
   * onDistribute(srcIdx, dstIdx, weight, massAtSrc) が渡されれば、配った先ごとに呼ぶ
   * （多種のパラメータ混合の「送ってくる量」の集計に使う。単独では null を渡してよい）。
   */
  function transportChannel(Asrc, Fx, Fy, N, dt, s, clipMax, Adst, onDistribute) {
    Adst.fill(0);
    var area = (2 * s) * (2 * s);
    var clippedCount = 0, maxAbsDispBeforeClip = 0;
    for (var y = 0; y < N; y++) {
      for (var x = 0; x < N; x++) {
        var i = y * N + x;
        var m = Asrc[i];
        if (m <= 0) continue;
        var dxRaw = dt * Fx[i], dyRaw = dt * Fy[i];
        var absx = Math.abs(dxRaw), absy = Math.abs(dyRaw);
        if (absx > maxAbsDispBeforeClip) maxAbsDispBeforeClip = absx;
        if (absy > maxAbsDispBeforeClip) maxAbsDispBeforeClip = absy;
        var dxc = clamp(dxRaw, -clipMax, clipMax), dyc = clamp(dyRaw, -clipMax, clipMax);
        if (dxc !== dxRaw || dyc !== dyRaw) clippedCount++;
        var tx = x + dxc, ty = y + dyc;
        var lox = tx - s, hix = tx + s, loy = ty - s, hiy = ty + s;
        var c0 = Math.floor(lox + 0.5), c1 = Math.ceil(hix - 0.5);
        var r0 = Math.floor(loy + 0.5), r1 = Math.ceil(hiy - 0.5);
        for (var cy = r0; cy <= r1; cy++) {
          var oy = overlap1d(cy, loy, hiy);
          if (oy <= 0) continue;
          var wy = ((cy % N) + N) % N, wyo = wy * N;
          for (var cx = c0; cx <= c1; cx++) {
            var ox = overlap1d(cx, lox, hix);
            if (ox <= 0) continue;
            var wx = ((cx % N) + N) % N;
            var w = m * (ox * oy) / area;
            var dst = wyo + wx;
            Adst[dst] += w;
            if (onDistribute) onDistribute(i, dst, w, m);
          }
        }
      }
    }
    return { clippedCount: clippedCount, maxAbsDispBeforeClip: maxAbsDispBeforeClip };
  }

  /* ============================================================ パラメータの混合（式9・式10） */
  /**
   * 「送ってくる元」の記録は Object ではなく固定容量の平たい型付き配列で持つ（V8 の辞書化を避ける。
   * 実測で Object ベースは 1歩 約78ms、これは 1歩 約13ms——K-147 の速くする側の対応）。
   * incomingKeys/incomingVals は長さ N*CAP、incomingCount は長さ N。CAP を超えた分は最後の枠へ合算する
   * （まれ。超えた回数を返す）。
   */
  function makeIncomingBuffers(N, CAP) {
    return { keys: new Int32Array(N * CAP).fill(-1), vals: new Float64Array(N * CAP), count: new Int32Array(N), cap: CAP, overflow: 0 };
  }
  function resetIncoming(buf) { buf.count.fill(0); buf.overflow = 0; }
  function accumulateIncoming(buf, srcIdx, dstIdx, weight) {
    var cap = buf.cap, base = dstIdx * cap, cnt = buf.count[dstIdx];
    for (var s = 0; s < cnt; s++) { if (buf.keys[base + s] === srcIdx) { buf.vals[base + s] += weight; return; } }
    if (cnt < cap) { buf.keys[base + cnt] = srcIdx; buf.vals[base + cnt] = weight; buf.count[dstIdx] = cnt + 1; }
    else { buf.vals[base + cap - 1] += weight; buf.overflow++; }
  }

  /**
   * softmax の標本（式10）。P（フラットな Float64Array、成分数 pDim）とラベル ℓ（Int32Array）を書き換える。
   * rng は決定的な乱数源。流入が無いセル（count=0）は据え置く。
   */
  function mixSoftmax(P, label, incomingBuf, N, pDim, rng, newP, newLabel) {
    newP.set(P); newLabel.set(label);
    var cap = incomingBuf.cap;
    for (var p = 0; p < N; p++) {
      var cnt = incomingBuf.count[p];
      if (cnt === 0) continue;
      var base = p * cap, sum = 0;
      for (var k = 0; k < cnt; k++) sum += Math.exp(incomingBuf.vals[base + k]);
      var r = rng() * sum, acc = 0, chosenSrc = incomingBuf.keys[base + cnt - 1];
      for (k = 0; k < cnt; k++) { acc += Math.exp(incomingBuf.vals[base + k]); if (r <= acc) { chosenSrc = incomingBuf.keys[base + k]; break; } }
      for (var d = 0; d < pDim; d++) newP[p * pDim + d] = P[chosenSrc * pDim + d];
      newLabel[p] = label[chosenSrc];
    }
    P.set(newP); label.set(newLabel);
  }

  /** 平均の混ぜ方（式9）。ℓ は追跡用に「最大流入元」の名札をそのまま流用する（力学に効かない）。 */
  function mixAverage(P, label, incomingBuf, N, pDim, newP, newLabel, vecScratch) {
    newP.set(P); newLabel.set(label);
    var cap = incomingBuf.cap;
    for (var p = 0; p < N; p++) {
      var cnt = incomingBuf.count[p];
      if (cnt === 0) continue;
      var base = p * cap, sum = 0, best = -Infinity, bestSrc = incomingBuf.keys[base];
      for (var d = 0; d < pDim; d++) vecScratch[d] = 0;
      for (var k = 0; k < cnt; k++) {
        var srcIdx = incomingBuf.keys[base + k], w = incomingBuf.vals[base + k];
        sum += w;
        if (w > best) { best = w; bestSrc = srcIdx; }
        for (d = 0; d < pDim; d++) vecScratch[d] += w * P[srcIdx * pDim + d];
      }
      if (sum > 0) { for (d = 0; d < pDim; d++) newP[p * pDim + d] = vecScratch[d] / sum; }
      newLabel[p] = label[bestSrc];
    }
    P.set(newP); label.set(newLabel);
  }

  /* ============================================================ 公開 */

  var S69 = {
    mulberry32: mulberry32, subSeed: subSeed, makeRng: makeRng, subRng: subRng, gaussian: gaussian,
    hashArray: hashArray, clamp: clamp,
    fft1d: fft1d, fft2d: fft2d,
    buildKernelSpectrum: buildKernelSpectrum, growth: growth, sobel: sobel, complexMulInto: complexMulInto,
    overlap1d: overlap1d, transportChannel: transportChannel,
    makeIncomingBuffers: makeIncomingBuffers, resetIncoming: resetIncoming, accumulateIncoming: accumulateIncoming,
    mixSoftmax: mixSoftmax, mixAverage: mixAverage,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = S69;
  if (typeof window !== 'undefined') window.S69 = S69;
})(this);
