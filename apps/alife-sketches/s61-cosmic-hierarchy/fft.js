'use strict';
/**
 * S-61 補助: 3次元の複素FFT（依存ゼロ・2べきのみ）。
 * core.js の重力ソルバ（ポアソン方程式）と web.js の潮汐テンソルが使う純粋な数値の道具。
 * 上位概念の語彙は持たない。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.S61FFT = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  function isPow2(n) { return n > 0 && (n & (n - 1)) === 0; }

  /** 1次元・その場（in-place）の複素FFT（反復・基数2）。invert=true で逆変換（1/nで正規化）。 */
  function fft1d(re, im, invert) {
    var n = re.length;
    if (!isPow2(n)) throw new Error('fft1d: 長さは2のべきであること (got ' + n + ')');
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
      var ang = (invert ? 1 : -1) * 2 * Math.PI / len;
      var wr = Math.cos(ang), wi = Math.sin(ang);
      for (var i2 = 0; i2 < n; i2 += len) {
        var cwr = 1, cwi = 0;
        var half = len >> 1;
        for (var k = 0; k < half; k++) {
          var ai = i2 + k, bi = i2 + k + half;
          var ur = re[ai], ui = im[ai];
          var vr = re[bi] * cwr - im[bi] * cwi;
          var vi = re[bi] * cwi + im[bi] * cwr;
          re[ai] = ur + vr; im[ai] = ui + vi;
          re[bi] = ur - vr; im[bi] = ui - vi;
          var nwr = cwr * wr - cwi * wi;
          var nwi = cwr * wi + cwi * wr;
          cwr = nwr; cwi = nwi;
        }
      }
    }
    if (invert) {
      for (var i3 = 0; i3 < n; i3++) { re[i3] /= n; im[i3] /= n; }
    }
  }

  /**
   * 3次元・その場のFFT。re/im は長さ Ng^3 の平坦配列（x*Ng^2 + y*Ng + z の順）。
   * 各軸ごとに一時バッファへコピー→1次元FFT→書き戻し、を3軸分行う（分離可能なDFT）。
   */
  function fft3d(re, im, Ng, invert) {
    if (!isPow2(Ng)) throw new Error('fft3d: Ng は2のべきであること (got ' + Ng + ')');
    var tr = new Float64Array(Ng), ti = new Float64Array(Ng);
    var Ng2 = Ng * Ng;
    var x, y, z, base;
    for (x = 0; x < Ng; x++) {
      for (y = 0; y < Ng; y++) {
        base = x * Ng2 + y * Ng;
        for (z = 0; z < Ng; z++) { tr[z] = re[base + z]; ti[z] = im[base + z]; }
        fft1d(tr, ti, invert);
        for (z = 0; z < Ng; z++) { re[base + z] = tr[z]; im[base + z] = ti[z]; }
      }
    }
    for (x = 0; x < Ng; x++) {
      for (z = 0; z < Ng; z++) {
        base = x * Ng2 + z;
        for (y = 0; y < Ng; y++) { tr[y] = re[base + y * Ng]; ti[y] = im[base + y * Ng]; }
        fft1d(tr, ti, invert);
        for (y = 0; y < Ng; y++) { re[base + y * Ng] = tr[y]; im[base + y * Ng] = ti[y]; }
      }
    }
    for (y = 0; y < Ng; y++) {
      for (z = 0; z < Ng; z++) {
        base = y * Ng + z;
        for (x = 0; x < Ng; x++) { tr[x] = re[base + x * Ng2]; ti[x] = im[base + x * Ng2]; }
        fft1d(tr, ti, invert);
        for (x = 0; x < Ng; x++) { re[base + x * Ng2] = tr[x]; im[base + x * Ng2] = ti[x]; }
      }
    }
  }

  /** 周波数の整数指数（-Ng/2..Ng/2-1）を、配列添字 0..Ng-1 から得る（FFTの標準順序）。 */
  function freqIndex(idx, Ng) { return idx <= Ng / 2 ? idx : idx - Ng; }

  return { fft1d: fft1d, fft3d: fft3d, freqIndex: freqIndex, isPow2: isPow2 };
});
