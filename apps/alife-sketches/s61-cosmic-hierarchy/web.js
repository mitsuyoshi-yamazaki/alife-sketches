'use strict';
/**
 * S-61 検出器: T-web（Hahn ら 2007 の型）。潮汐テンソルの正の固有値の数で
 * 空洞(0)/壁(1)/糸(2)/節(3) を分類する。核（core.js）とは独立の道具。Node/ブラウザ共用（UMD）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./fft.js'), require('./core.js'));
  else root.S61WEB = factory(root.S61FFT, root.S61);
})(typeof self !== 'undefined' ? self : this, function (FFT, S61) {

/**
 * 潮汐テンソル場を計算する。x/mass から Ng^3 格子へCIC密度→ガウス平滑化→
 * ∇²φ_s=δ_s を解いて T_ij=∂_i∂_jφ_s をスペクトル法（-k_i k_j φ_k）で求める。
 * 戻り値: 各セルの固有値配列 [l1,l2,l3]（降順）と、正の固有値の個数（0-3）。
 */
function tidalField(x, Np, mass, Ng, L, Rs) {
  var delta = S61.cicDensity(x, Np, mass, Ng, L);
  var re = new Float64Array(delta), im = new Float64Array(Ng * Ng * Ng);
  FFT.fft3d(re, im, Ng, false);
  var Ng2 = Ng * Ng;
  // ガウス平滑化 exp(-k^2 Rs^2/2) をかけつつ、phi_k = -delta_k/k^2 (標準ポアソン。Hahnらは4piGなしの規格化を使うが
  // ここでは classify に使う固有値の「符号」だけが要るので、正の定数倍は結果を変えない: delta_s=-k^2 phi_s なので
  // phi_k = delta_k/k^2 とし、T_ij=-k_i k_j phi_k を使えば十分（符号は Hessian の符号と一致する）。
  var reT = new Array(6), imT = new Array(6); // xx,yy,zz,xy,xz,yz
  for (var c = 0; c < 6; c++) { reT[c] = new Float64Array(Ng * Ng * Ng); imT[c] = new Float64Array(Ng * Ng * Ng); }
  for (var ix = 0; ix < Ng; ix++) {
    var kx = 2 * Math.PI * FFT.freqIndex(ix, Ng) / L;
    for (var iy = 0; iy < Ng; iy++) {
      var ky = 2 * Math.PI * FFT.freqIndex(iy, Ng) / L;
      for (var iz = 0; iz < Ng; iz++) {
        var idx = ix * Ng2 + iy * Ng + iz;
        if (idx === 0) continue;
        var kz = 2 * Math.PI * FFT.freqIndex(iz, Ng) / L;
        var k2 = kx * kx + ky * ky + kz * kz;
        var smooth = Math.exp(-k2 * Rs * Rs / 2);
        // nabla^2 phi = S*delta (S>0) => phi_k = -S*delta_k/k^2。分類は固有値の符号だけが要るので S=1 とする。
        var phiFactor = -smooth / k2;
        var dr = re[idx] * phiFactor, di = im[idx] * phiFactor;
        // T_ij_k = -k_i*k_j*phi_k （符号は分類に無関係だが Hessian の定義に合わせ Tij=d_i d_j phi = -k_ik_j phi_k）
        reT[0][idx] = -kx * kx * dr; imT[0][idx] = -kx * kx * di; // xx
        reT[1][idx] = -ky * ky * dr; imT[1][idx] = -ky * ky * di; // yy
        reT[2][idx] = -kz * kz * dr; imT[2][idx] = -kz * kz * di; // zz
        reT[3][idx] = -kx * ky * dr; imT[3][idx] = -kx * ky * di; // xy
        reT[4][idx] = -kx * kz * dr; imT[4][idx] = -kx * kz * di; // xz
        reT[5][idx] = -ky * kz * dr; imT[5][idx] = -ky * kz * di; // yz
      }
    }
  }
  for (var c2 = 0; c2 < 6; c2++) FFT.fft3d(reT[c2], imT[c2], Ng, true);
  var n = Ng * Ng * Ng;
  var eig = new Float64Array(3 * n);
  for (var i = 0; i < n; i++) {
    var Txx = reT[0][i], Tyy = reT[1][i], Tzz = reT[2][i], Txy = reT[3][i], Txz = reT[4][i], Tyz = reT[5][i];
    var e = symEig3([[Txx, Txy, Txz], [Txy, Tyy, Tyz], [Txz, Tyz, Tzz]]);
    eig[3 * i] = e[0]; eig[3 * i + 1] = e[1]; eig[3 * i + 2] = e[2]; // 降順
  }
  return { eig: eig, Ng: Ng };
}

/** 実対称3x3行列の固有値（降順・解析解。Hessianの符号だけが要る用途）。 */
function symEig3(A) {
  var a = A[0][0], b = A[1][1], c = A[2][2];
  var d = A[0][1], e = A[1][2], f = A[0][2];
  var p1 = d * d + e * e + f * f;
  if (p1 < 1e-300) {
    var v = [a, b, c]; v.sort(function (x, y) { return y - x; }); return v;
  }
  var q = (a + b + c) / 3;
  var p2 = (a - q) * (a - q) + (b - q) * (b - q) + (c - q) * (c - q) + 2 * p1;
  var p = Math.sqrt(p2 / 6);
  var Bxx = (a - q) / p, Byy = (b - q) / p, Bzz = (c - q) / p, Bxy = d / p, Byz = e / p, Bxz = f / p;
  var detB = Bxx * (Byy * Bzz - Byz * Byz) - Bxy * (Bxy * Bzz - Byz * Bxz) + Bxz * (Bxy * Byz - Byy * Bxz);
  var r = detB / 2;
  r = Math.max(-1, Math.min(1, r));
  var phi = Math.acos(r) / 3;
  var eig1 = q + 2 * p * Math.cos(phi);
  var eig3 = q + 2 * p * Math.cos(phi + 2 * Math.PI / 3);
  var eig2 = 3 * q - eig1 - eig3;
  var out = [eig1, eig2, eig3]; out.sort(function (x, y) { return y - x; });
  return out;
}

/** 固有値配列(3*n)から、閾値 lambdaTh で各セルの正の固有値数(0-3)を返す。 */
function classify(eig, n, lambdaTh) {
  var cls = new Int8Array(n);
  for (var i = 0; i < n; i++) {
    var cnt = 0;
    if (eig[3 * i] > lambdaTh) cnt++;
    if (eig[3 * i + 1] > lambdaTh) cnt++;
    if (eig[3 * i + 2] > lambdaTh) cnt++;
    cls[i] = cnt;
  }
  return cls;
}

/** クラス別の体積比 fv[4] と質量比 fm[4]（0=空洞,1=壁,2=糸,3=節）。massGrid は cicDensity+1（質量比重み・平滑化なし）。 */
function classFractions(cls, Ng, massGridUnsmoothed) {
  var n = Ng * Ng * Ng;
  var vcount = [0, 0, 0, 0], mcount = [0, 0, 0, 0];
  var totalMass = 0;
  for (var i = 0; i < n; i++) { totalMass += massGridUnsmoothed[i]; }
  for (var i2 = 0; i2 < n; i2++) {
    vcount[cls[i2]]++;
    mcount[cls[i2]] += massGridUnsmoothed[i2];
  }
  var fv = vcount.map(function (v) { return v / n; });
  var fm = mcount.map(function (m) { return totalMass > 0 ? m / totalMass : 0; });
  return { fv: fv, fm: fm };
}

/** 6連結成分（周期境界）で cls===targetClass のセルを単位化する。戻り値: [[cellIdx,...], ...]。 */
function connectedComponents(cls, Ng, targetClass) {
  var n = Ng * Ng * Ng, Ng2 = Ng * Ng;
  var visited = new Uint8Array(n);
  var comps = [];
  function idxOf(x, y, z) { return ((x % Ng + Ng) % Ng) * Ng2 + ((y % Ng + Ng) % Ng) * Ng + ((z % Ng + Ng) % Ng); }
  for (var i = 0; i < n; i++) {
    if (cls[i] !== targetClass || visited[i]) continue;
    var stack = [i]; visited[i] = 1;
    var comp = [];
    var x0 = Math.floor(i / Ng2), y0 = Math.floor((i % Ng2) / Ng), z0 = i % Ng;
    while (stack.length) {
      var cur = stack.pop();
      comp.push(cur);
      var cx = Math.floor(cur / Ng2), cy = Math.floor((cur % Ng2) / Ng), cz = cur % Ng;
      var neigh = [idxOf(cx + 1, cy, cz), idxOf(cx - 1, cy, cz), idxOf(cx, cy + 1, cz), idxOf(cx, cy - 1, cz), idxOf(cx, cy, cz + 1), idxOf(cx, cy, cz - 1)];
      for (var k = 0; k < 6; k++) {
        var nb = neigh[k];
        if (cls[nb] === targetClass && !visited[nb]) { visited[nb] = 1; stack.push(nb); }
      }
    }
    comps.push(comp);
  }
  return comps;
}

return { tidalField: tidalField, symEig3: symEig3, classify: classify, classFractions: classFractions, connectedComponents: connectedComponents };
});
