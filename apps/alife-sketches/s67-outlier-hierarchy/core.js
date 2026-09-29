/**
 * S-67: 核。Outlier 規則（512 ビット参照表・Moore 近傍・周期境界）の力学と、
 * U1（塊）の連結成分・正準形・ハッシュだけをここに置く。上位概念の語彙（formation/complex 等）は
 * 観測器（detectR.js/detectS.js/properties.js）側でだけ使う。
 * Node と ブラウザで共用（UMD）。ES module 不可・依存を足さない（criteria.json 参照）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.S67Core = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ── 規則（borrowedConstants[0]。唯一の出所） ──
  var MAP_STRING = 'MAPERETQB4eHWkQ7xD4eYZosBQZFixOBHmtFeehExrKVhURLRAqGxeIlSO1JYZP6DRi69rop7TQCkvWTIag7kAS8g';
  var HEX_STRING = '111113401e1e1d6910ef10f8798668b01419162c4e0479ad15e7a1131aca5615112d102a1b17889523b525864fe83462ebdae8a7b4d00a4bd64c86a0ee4012f2';
  var EXPECTED_SHA256_PREFIX16 = '937c3e657c22080f';

  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function bytesToTable(bytes) {
    var T = new Uint8Array(512);
    for (var k = 0; k < 512; k++) {
      var byteIdx = k >> 3, bitIdx = 7 - (k & 7);
      T[k] = (bytes[byteIdx] >> bitIdx) & 1;
    }
    return T;
  }

  // 標準 Base64（"MAP" 接頭辞を除く）。LifeViewer/Golly の MAP 文字列の規約。
  function base64ToBytes(b64) {
    if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(b64, 'base64'));
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var clean = b64.replace(/=+$/, '');
    var bits = '';
    for (var i = 0; i < clean.length; i++) {
      var v = chars.indexOf(clean[i]);
      if (v < 0) continue;
      bits += v.toString(2).padStart ? v.toString(2).padStart(6, '0') : ('000000' + v.toString(2)).slice(-6);
    }
    var out = [];
    for (var j = 0; j + 8 <= bits.length; j += 8) out.push(parseInt(bits.substr(j, 8), 2));
    return new Uint8Array(out);
  }

  function decodeHexToTable() { return bytesToTable(hexToBytes(HEX_STRING)); }
  function decodeMapToTable() {
    var b64 = MAP_STRING.slice(3); // "MAP" 接頭辞
    var bytes = base64ToBytes(b64).slice(0, 64);
    return bytesToTable(bytes);
  }

  function sha256Prefix16(table) {
    if (typeof require === 'undefined') return null;
    var crypto = require('crypto');
    var buf = Buffer.from(table);
    return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
  }

  // ── 近傍の重みとビット順（NW,N,NE,W,C,E,SW,S,SE = 256,128,64,32,16,8,4,2,1） ──
  var W9 = [256, 128, 64, 32, 16, 8, 4, 2, 1];
  var OFFSETS9 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [0, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];
  // 反時計回り90°: (dx,dy) -> (dy,-dx)。回転後の位置 i の値 = 回転前の位置 invPerm[i] の値。
  var ROT_INV_PERM = [2, 5, 8, 1, 4, 7, 0, 3, 6];
  // 転置（鏡映。(dx,dy) -> (dy,dx)）。
  var TRANSPOSE_INV_PERM = [0, 3, 6, 1, 4, 7, 2, 5, 8];

  function kToBits9(k) {
    var bits = new Array(9);
    for (var i = 0; i < 9; i++) bits[i] = (k & W9[i]) ? 1 : 0;
    return bits;
  }
  function bits9ToK(bits) {
    var k = 0;
    for (var i = 0; i < 9; i++) if (bits[i]) k += W9[i];
    return k;
  }
  function permuteK(k, invPerm) {
    var bits = kToBits9(k), out = new Array(9);
    for (var i = 0; i < 9; i++) out[i] = bits[invPerm[i]];
    return bits9ToK(out);
  }
  /** k（3×3の近傍番号）を 'o'/'.' の3行へ（中心含む。3×3の種の悉皆・NB-flipの表示に使う）。 */
  function kToPatternRows(k) {
    var bits = kToBits9(k);
    var rows = [];
    for (var r = 0; r < 3; r++) { var row = ''; for (var c = 0; c < 3; c++) row += bits[r * 3 + c] ? 'o' : '.'; rows.push(row); }
    return rows;
  }
  function rotateK(k) { return permuteK(k, ROT_INV_PERM); }
  function transposeK(k) { return permuteK(k, TRANSPOSE_INV_PERM); }

  function isRotationSymmetric(T) {
    for (var k = 0; k < 512; k++) if (T[k] !== T[rotateK(k)]) return false;
    return true;
  }
  function isMirrorSymmetric(T) {
    for (var k = 0; k < 512; k++) if (T[k] !== T[transposeK(k)]) return false;
    return true;
  }
  function transposeTable(T) {
    var Tp = new Uint8Array(512);
    for (var k = 0; k < 512; k++) Tp[k] = T[transposeK(k)];
    return Tp;
  }

  function neighborCountAndCenter(k) {
    var c = (k >> 4) & 1;
    var n = 0;
    for (var i = 0; i < 9; i++) { if (i === 4) continue; if (k & W9[i]) n++; }
    return { c: c, n: n };
  }

  /** 140 の回転の類。代表 = 軌道の中の最小 k。索引順は代表 k の昇順（本実装の内部規約）。 */
  function buildRotationClasses() {
    var seen = new Uint8Array(512);
    var classes = [];
    for (var k = 0; k < 512; k++) {
      if (seen[k]) continue;
      var orbit = [k];
      var cur = rotateK(k);
      while (cur !== k) { orbit.push(cur); seen[cur] = 1; cur = rotateK(cur); }
      seen[k] = 1;
      var rep = Math.min.apply(null, orbit);
      var uniq = Array.from(new Set(orbit)).sort(function (a, b) { return a - b; });
      var cn = neighborCountAndCenter(rep);
      classes.push({ rep: rep, size: uniq.length, members: uniq, c: cn.c, n: cn.n });
    }
    classes.sort(function (a, b) { return a.rep - b.rep; });
    return classes;
  }

  function flipClassTable(T, classIndex, classes) {
    var Tp = Uint8Array.from(T);
    var cls = classes[classIndex];
    for (var i = 0; i < cls.members.length; i++) { var k = cls.members[i]; Tp[k] = 1 - Tp[k]; }
    return Tp;
  }

  function lifeTable() {
    // Conway B3/S23。同じ k の符号化を流用（中心の生死と8近傍の生数だけで決まる外部総和型）。
    var T = new Uint8Array(512);
    for (var k = 0; k < 512; k++) {
      var cn = neighborCountAndCenter(k);
      if (cn.c === 0) T[k] = (cn.n === 3) ? 1 : 0;
      else T[k] = (cn.n === 2 || cn.n === 3) ? 1 : 0;
    }
    return T;
  }
  function identityTable() {
    var T = new Uint8Array(512);
    for (var k = 0; k < 512; k++) T[k] = (k >> 4) & 1;
    return T;
  }

  // ── 乱択の規則（RS-count・RS-λ） ──
  function bucketClassesByCN(classes) {
    var buckets = {};
    for (var i = 0; i < classes.length; i++) {
      var cl = classes[i];
      var key = cl.c + '_' + cl.n;
      (buckets[key] = buckets[key] || []).push({ idx: i, size: cl.size });
    }
    return buckets;
  }
  function targetLiveCounts(T) {
    // (c,n) バケツごとの Outlier の生の数（k の全数え上げ、512通り）。
    var tgt = {};
    for (var k = 0; k < 512; k++) {
      if (!T[k]) continue;
      var cn = neighborCountAndCenter(k);
      var key = cn.c + '_' + cn.n;
      tgt[key] = (tgt[key] || 0) + 1;
    }
    return tgt;
  }
  /** 候補クラス群から、合計サイズが target に一致する無作為な部分集合を最大100回試す。 */
  function randomSubsetSumming(candidates, target, rng) {
    var best = null, bestDiff = Infinity;
    for (var attempt = 0; attempt < 100; attempt++) {
      var order = candidates.slice();
      for (var i = order.length - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)); var t = order[i]; order[i] = order[j]; order[j] = t; }
      var chosen = [], sum = 0;
      for (var oi = 0; oi < order.length; oi++) {
        var cand = order[oi];
        if (sum + cand.size <= target) { chosen.push(cand.idx); sum += cand.size; }
      }
      var diff = Math.abs(sum - target);
      if (diff < bestDiff) { bestDiff = diff; best = { chosen: chosen, sum: sum }; }
      if (diff === 0) return { chosen: chosen, sum: sum, redraws: attempt + 1, matched: true };
    }
    return { chosen: best.chosen, sum: best.sum, redraws: 100, matched: false, deviation: target - best.sum };
  }
  function rsCountTable(outlierTable, classes, rng) {
    var buckets = bucketClassesByCN(classes);
    var targets = targetLiveCounts(outlierTable);
    var T = new Uint8Array(512);
    var report = [];
    Object.keys(buckets).forEach(function (key) {
      var target = targets[key] || 0;
      var res = randomSubsetSumming(buckets[key], target, rng);
      res.chosen.forEach(function (ci) { classes[ci].members.forEach(function (k) { T[k] = 1; }); });
      report.push({ bucket: key, target: target, achieved: res.sum, matched: !!res.matched, redraws: res.redraws });
    });
    return { table: T, report: report };
  }
  function rsLambdaTable(classes, rng) {
    var zeroClassIdx = -1;
    for (var i = 0; i < classes.length; i++) if (classes[i].rep === 0) { zeroClassIdx = i; break; }
    var c0cands = [], c1cands = [];
    for (var j = 0; j < classes.length; j++) {
      if (j === zeroClassIdx) continue;
      var cl = classes[j];
      if (cl.c === 0) c0cands.push({ idx: j, size: cl.size });
      else c1cands.push({ idx: j, size: cl.size });
    }
    var T = new Uint8Array(512);
    var res0 = randomSubsetSumming(c0cands, 118, rng);
    var res1 = randomSubsetSumming(c1cands, 102, rng);
    res0.chosen.forEach(function (ci) { classes[ci].members.forEach(function (k) { T[k] = 1; }); });
    res1.chosen.forEach(function (ci) { classes[ci].members.forEach(function (k) { T[k] = 1; }); });
    T[0] = 0;
    return { table: T, report: [{ bucket: 'c0(B)', target: 118, achieved: res0.sum, matched: !!res0.matched, redraws: res0.redraws }, { bucket: 'c1(S)', target: 102, achieved: res1.sum, matched: !!res1.matched, redraws: res1.redraws }] };
  }

  // ── RNG（mulberry32。シード固定で完全再現） ──
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function fnv1a32(data, seedOffset) {
    var h = (seedOffset >>> 0) || 0x811c9dc5;
    if (typeof data === 'string') {
      for (var i = 0; i < data.length; i++) { h ^= data.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    } else {
      for (var j = 0; j < data.length; j++) { h ^= data[j]; h = Math.imul(h, 0x01000193); }
    }
    return h >>> 0;
  }
  function subSeed(seed, salt) { return fnv1a32(seed + '|' + salt, 0x811c9dc5); }
  function hexPad8(n) { var s = (n >>> 0).toString(16); while (s.length < 8) s = '0' + s; return s; }
  function hash64hex(data) {
    var h1 = fnv1a32(data, 0x811c9dc5);
    var h2 = fnv1a32(data, 0x9747b28c ^ 0xffffffff);
    return hexPad8(h1) + hexPad8(h2);
  }

  // ── 格子 ──
  function createGrid(L) { return new Uint8Array(L * L); }
  function idxOf(x, y, L) { return (((y % L) + L) % L) * L + (((x % L) + L) % L); }

  function placePattern(grid, L, rows, ox, oy) {
    for (var ry = 0; ry < rows.length; ry++) for (var rx = 0; rx < rows[ry].length; rx++) {
      if (rows[ry][rx] === 'o') grid[idxOf(ox + rx, oy + ry, L)] = 1;
    }
  }
  var C0_ROWS = ['.o.', 'ooo', '..o'];
  var C2_ROWS = ['.oo', '..o', 'ooo'];
  function setSeedC0(grid, L) { placePattern(grid, L, C0_ROWS, Math.floor(L / 2) - 1, Math.floor(L / 2) - 1); }

  function randomInit(grid, L, D0, rng) {
    for (var i = 0; i < L * L; i++) grid[i] = rng() < D0 ? 1 : 0;
  }

  /**
   * 素朴な実装（9近傍をそれぞれ独立に読んで毎回 k を組む）。K-146 の代わりの「速い実装と素朴な実装の
   * 一致」検算の基準として残す。本番の既定は下の makeStepper（行ごとにビットをずらして作る速い版）。
   */
  function makeNaiveStepper(L) {
    var ym1 = new Int32Array(L), yp1 = new Int32Array(L);
    for (var y = 0; y < L; y++) { ym1[y] = (((y - 1) % L + L) % L) * L; yp1[y] = (((y + 1) % L + L) % L) * L; }
    var xm1 = new Int32Array(L), xp1 = new Int32Array(L);
    for (var x = 0; x < L; x++) { xm1[x] = ((x - 1) % L + L) % L; xp1[x] = ((x + 1) % L) % L; }
    return {
      step: function (grid, T, outBuf, visits) {
        var out = outBuf || new Uint8Array(L * L);
        for (var yy = 0; yy < L; yy++) {
          var rowC = yy * L, rowU = ym1[yy], rowD = yp1[yy];
          for (var xx = 0; xx < L; xx++) {
            var xl = xm1[xx], xr = xp1[xx];
            var k = 256 * grid[rowU + xl] + 128 * grid[rowU + xx] + 64 * grid[rowU + xr]
              + 32 * grid[rowC + xl] + 16 * grid[rowC + xx] + 8 * grid[rowC + xr]
              + 4 * grid[rowD + xl] + 2 * grid[rowD + xx] + grid[rowD + xr];
            out[rowC + xx] = T[k];
            if (visits) visits[k]++;
          }
        }
        return out;
      }
    };
  }

  /**
   * 速い実装（既定）。3×3の9ビットを、行ごとに「1つ前の窓を1ビット左シフトし、新しい1ビットだけ
   * 東側から取り込む」ことで作る（criteria.jsonのstaticPrecomputation.costが想定する高速化に対応）。
   * 各行につき1セルあたりの生の配列アクセスは1回（3行で3回。素朴実装の9回から削減）で済む。
   * k の組み方（重みの割り当て）は素朴実装と完全に同じにしてあり、出力は常にビット単位で一致する
   * （selftest/controls.jsが毎走行の窓でmakeNaiveStepperと突き合わせて確かめる）。
   */
  function makeStepper(L) {
    var ym1 = new Int32Array(L), yp1 = new Int32Array(L);
    for (var y = 0; y < L; y++) { ym1[y] = (((y - 1) % L + L) % L) * L; yp1[y] = (((y + 1) % L + L) % L) * L; }
    var xLast = L - 1;
    return {
      step: function (grid, T, outBuf, visits) {
        var out = outBuf || new Uint8Array(L * L);
        for (var yy = 0; yy < L; yy++) {
          var rowC = yy * L, rowU = ym1[yy], rowD = yp1[yy];
          // 窓の初期化: x=0 の(西,中,東) = (x=L-1, x=0, x=1)
          var winU = (grid[rowU + xLast] << 2) | (grid[rowU] << 1) | grid[rowU + 1];
          var winC = (grid[rowC + xLast] << 2) | (grid[rowC] << 1) | grid[rowC + 1];
          var winD = (grid[rowD + xLast] << 2) | (grid[rowD] << 1) | grid[rowD + 1];
          for (var xx = 0; xx < L; xx++) {
            var k = (winU << 6) | (winC << 3) | winD;
            out[rowC + xx] = T[k];
            if (visits) visits[k]++;
            // 次の x+1 のために窓を1ビット左シフトし、新しい東隣（x+2）を取り込む
            var xr2 = xx + 2; if (xr2 >= L) xr2 -= L;
            winU = ((winU << 1) | grid[rowU + xr2]) & 7;
            winC = ((winC << 1) | grid[rowC + xr2]) & 7;
            winD = ((winD << 1) | grid[rowD + xr2]) & 7;
          }
        }
        return out;
      }
    };
  }

  function gridHash(grid) { return hash64hex(grid); }
  function liveCount(grid) { var n = 0; for (var i = 0; i < grid.length; i++) n += grid[i]; return n; }

  // 回転（(x,y)->(y,-x mod L)）・転置（(x,y)->(y,x)）した格子（対称の同変性の検査用）。
  function rotateGrid90ccw(grid, L) {
    var out = new Uint8Array(L * L);
    for (var y = 0; y < L; y++) for (var x = 0; x < L; x++) {
      var v = grid[y * L + x];
      var nx = y, ny = ((L - x) % L);
      out[ny * L + nx] = v;
    }
    return out;
  }
  function transposeGrid(grid, L) {
    var out = new Uint8Array(L * L);
    for (var y = 0; y < L; y++) for (var x = 0; x < L; x++) out[x * L + y] = grid[y * L + x];
    return out;
  }

  // ── U1: 連結成分（周期境界をまたぐ） ──
  var NBR8 = OFFSETS9.filter(function (o) { return !(o[0] === 0 && o[1] === 0); });
  var NBR4 = [[0, -1], [-1, 0], [1, 0], [0, 1]];
  function nbrCheb2() {
    var out = [];
    for (var dy = -2; dy <= 2; dy++) for (var dx = -2; dx <= 2; dx++) { if (dx === 0 && dy === 0) continue; out.push([dx, dy]); }
    return out;
  }
  var NBR_CHEB2 = nbrCheb2();
  function neighborsForMode(mode) {
    if (mode === '4') return NBR4;
    if (mode === 'cheb2') return NBR_CHEB2;
    return NBR8;
  }

  function findComponents(grid, L, mode, maxCells) {
    var offs = neighborsForMode(mode || '8');
    var seen = new Uint8Array(L * L);
    var comps = [];
    for (var y0 = 0; y0 < L; y0++) for (var x0 = 0; x0 < L; x0++) {
      var i0 = y0 * L + x0;
      if (!grid[i0] || seen[i0]) continue;
      seen[i0] = 1;
      var stack = [x0, y0];
      var cells = [];
      var cap = maxCells || Infinity;
      var overflow = false;
      while (stack.length) {
        var cy = stack.pop(), cx = stack.pop();
        cells.push(cx, cy);
        if (cells.length / 2 > cap) overflow = true;
        for (var oi = 0; oi < offs.length; oi++) {
          var nx = cx + offs[oi][0], ny = cy + offs[oi][1];
          var ni = idxOf(nx, ny, L);
          if (grid[ni] && !seen[ni]) { seen[ni] = 1; stack.push(((nx % L) + L) % L, ((ny % L) + L) % L); }
        }
      }
      comps.push({ cellsFlat: cells, size: cells.length / 2, overflow: overflow });
    }
    return comps;
  }

  /** findComponents と同じだが、各セルの成分番号（無ければ-1）も返す（光円錐の親子付けに使う）。 */
  function findComponentsLabeled(grid, L, mode) {
    var offs = neighborsForMode(mode || '8');
    var labels = new Int32Array(L * L).fill(-1);
    var comps = [];
    for (var y0 = 0; y0 < L; y0++) for (var x0 = 0; x0 < L; x0++) {
      var i0 = y0 * L + x0;
      if (!grid[i0] || labels[i0] !== -1) continue;
      var compId = comps.length;
      labels[i0] = compId;
      var stack = [x0, y0];
      var cells = [];
      while (stack.length) {
        var cy = stack.pop(), cx = stack.pop();
        cells.push(cx, cy);
        for (var oi = 0; oi < offs.length; oi++) {
          var nx = cx + offs[oi][0], ny = cy + offs[oi][1];
          var ni = idxOf(nx, ny, L);
          if (grid[ni] && labels[ni] === -1) { labels[ni] = compId; stack.push(((nx % L) + L) % L, ((ny % L) + L) % L); }
        }
      }
      comps.push({ cellsFlat: cells, size: cells.length / 2 });
    }
    return { comps: comps, labels: labels };
  }

  /** 座標配列（0..L-1 の値、重複可）を、最大の周回ギャップで切って線形域へ「巻き戻す」。 */
  var IDENTITY_MAP = function (v) { return v; };
  function unwrapAxisMapper(coords, L) {
    // 速い経路: 生の最小・最大が L の半分未満なら、周回の巻き戻しが答えを変えることはあり得ない
    // （巻き戻しが要るのは、成分が周期境界の両端（x=0付近とx=L-1付近）に同時に触れて生の範囲が
    // 半周以上に広がる場合だけ。m_rec〜400セルの登録可能な成分・L≥64の格子では、この経路が
    // 大半を占める。往復の Set/sort を毎回の呼び出しで避けるための最適化——結果は変えない）。
    var rawMin = coords[0], rawMax = coords[0];
    for (var ci = 1; ci < coords.length; ci++) { var v = coords[ci]; if (v < rawMin) rawMin = v; if (v > rawMax) rawMax = v; }
    if (coords.length <= 1 || (rawMax - rawMin) < L / 2) return IDENTITY_MAP;
    var uniq = Array.from(new Set(coords)).sort(function (a, b) { return a - b; });
    if (uniq.length <= 1) return IDENTITY_MAP;
    var n = uniq.length, bestGap = -1, bestI = 0;
    for (var i = 0; i < n; i++) {
      var a = uniq[i], b = uniq[(i + 1) % n];
      var gap = (i === n - 1) ? (uniq[0] + L - a) : (b - a);
      if (gap > bestGap) { bestGap = gap; bestI = i; }
    }
    var seamValue = uniq[bestI];
    return function (v) { return v > seamValue ? v : v + L; };
  }

  /** 成分の正準形（K1 連結・K2 回転の同一視は呼び出し側の判断で rotateInvariant を渡す）。 */
  function canonicalizeComponent(cellsFlat, L, rotateInvariant) {
    var n = cellsFlat.length / 2;
    var xs = new Array(n), ys = new Array(n);
    for (var i = 0; i < n; i++) { xs[i] = cellsFlat[i * 2]; ys[i] = cellsFlat[i * 2 + 1]; }
    var mapX = unwrapAxisMapper(xs, L), mapY = unwrapAxisMapper(ys, L);
    var ux = xs.map(mapX), uy = ys.map(mapY);
    var minx = Math.min.apply(null, ux), miny = Math.min.apply(null, uy);
    var maxx = Math.max.apply(null, ux), maxy = Math.max.apply(null, uy);
    var w = maxx - minx + 1, h = maxy - miny + 1;
    // 重心（巻き戻した座標。mod L で錨にする）
    var sx = 0, sy = 0;
    for (i = 0; i < n; i++) { sx += ux[i]; sy += uy[i]; }
    var anchorX = (((sx / n + minx * 0) % L) + L * 10) % L; // 下で正しく再計算
    anchorX = (((sx / n) % L) + L * 10) % L;
    var anchorY = (((sy / n) % L) + L * 10) % L;

    function toBitGrid(px, py) {
      var g = [];
      for (var yy = 0; yy < h; yy++) { var row = new Uint8Array(w); g.push(row); }
      for (var ii = 0; ii < n; ii++) { g[py[ii] - miny][px[ii] - minx] = 1; }
      return g;
    }
    var base = toBitGrid(ux, uy);
    function bitsString(g, ww, hh) {
      var s = '';
      for (var yy = 0; yy < hh; yy++) { for (var xx = 0; xx < ww; xx++) s += g[yy][xx] ? '1' : '0'; }
      return s;
    }
    function rotateShapeCcw(g, ww, hh) {
      // (x,y)->(y,-x)。正規化して新しい w,h,grid を返す。
      var pts = [];
      for (var yy = 0; yy < hh; yy++) for (var xx = 0; xx < ww; xx++) if (g[yy][xx]) pts.push([xx, yy]);
      var rp = pts.map(function (p) { return [p[1], -p[0]]; });
      var mnx = Math.min.apply(null, rp.map(function (p) { return p[0]; }));
      var mny = Math.min.apply(null, rp.map(function (p) { return p[1]; }));
      var np = rp.map(function (p) { return [p[0] - mnx, p[1] - mny]; });
      var nw = Math.max.apply(null, np.map(function (p) { return p[0]; })) + 1;
      var nh = Math.max.apply(null, np.map(function (p) { return p[1]; })) + 1;
      var ng = []; for (var yy2 = 0; yy2 < nh; yy2++) ng.push(new Uint8Array(nw));
      np.forEach(function (p) { ng[p[1]][p[0]] = 1; });
      return { g: ng, w: nw, h: nh };
    }

    var candidates = [{ w: w, h: h, bits: bitsString(base, w, h), orientK: 0 }];
    if (rotateInvariant) {
      var cur = { g: base, w: w, h: h };
      for (var r = 1; r <= 3; r++) {
        cur = rotateShapeCcw(cur.g, cur.w, cur.h);
        candidates.push({ w: cur.w, h: cur.h, bits: bitsString(cur.g, cur.w, cur.h), orientK: r });
      }
    }
    candidates.sort(function (a, b) {
      if (a.w !== b.w) return a.w - b.w;
      if (a.h !== b.h) return a.h - b.h;
      return a.bits < b.bits ? -1 : (a.bits > b.bits ? 1 : 0);
    });
    var chosen = candidates[0];
    var hash = hash64hex(chosen.w + 'x' + chosen.h + ':' + chosen.bits);
    return { w: chosen.w, h: chosen.h, bits: chosen.bits, hash: hash, orientK: chosen.orientK, size: n, anchorX: anchorX, anchorY: anchorY };
  }

  // 原点まわりの反時計回り rot 回転 (x,y) -> (y,-x) を rot 回適用（mod L）。
  function rotatePointCcw(x, y, rot, L) {
    var cx = x, cy = y;
    for (var i = 0; i < ((rot % 4) + 4) % 4; i++) { var nx = cy, ny = -cx; cx = nx; cy = ny; }
    return [(((cx % L) + L) % L), (((cy % L) + L) % L)];
  }
  function torusDelta(a, b, L) {
    var d = ((b - a) % L + L) % L;
    if (d > L / 2) d -= L;
    return d;
  }
  function chebyshevTorusDist(ax, ay, bx, by, L) {
    return Math.max(Math.abs(torusDelta(ax, bx, L)), Math.abs(torusDelta(ay, by, L)));
  }

  // ── RLE（簡易。snapshots 用） ──
  function rleEncode(grid, L) {
    var lines = [];
    for (var y = 0; y < L; y++) {
      var row = '';
      var runChar = null, runLen = 0;
      for (var x = 0; x < L; x++) {
        var ch = grid[y * L + x] ? 'o' : 'b';
        if (ch === runChar) runLen++;
        else { if (runChar) row += (runLen > 1 ? runLen : '') + runChar; runChar = ch; runLen = 1; }
      }
      if (runChar) row += (runLen > 1 ? runLen : '') + runChar;
      lines.push(row);
    }
    return 'x = ' + L + ', y = ' + L + ', rule = Outlier\n' + lines.join('$') + '!';
  }

  return {
    MAP_STRING: MAP_STRING, HEX_STRING: HEX_STRING, EXPECTED_SHA256_PREFIX16: EXPECTED_SHA256_PREFIX16,
    decodeHexToTable: decodeHexToTable, decodeMapToTable: decodeMapToTable, sha256Prefix16: sha256Prefix16,
    W9: W9, rotateK: rotateK, transposeK: transposeK, kToPatternRows: kToPatternRows, isRotationSymmetric: isRotationSymmetric,
    isMirrorSymmetric: isMirrorSymmetric, transposeTable: transposeTable, neighborCountAndCenter: neighborCountAndCenter,
    buildRotationClasses: buildRotationClasses, flipClassTable: flipClassTable,
    lifeTable: lifeTable, identityTable: identityTable, rsCountTable: rsCountTable, rsLambdaTable: rsLambdaTable,
    makeRng: makeRng, subSeed: subSeed, fnv1a32: fnv1a32, hash64hex: hash64hex,
    createGrid: createGrid, idxOf: idxOf, placePattern: placePattern, C0_ROWS: C0_ROWS, C2_ROWS: C2_ROWS,
    setSeedC0: setSeedC0, randomInit: randomInit, makeStepper: makeStepper, makeNaiveStepper: makeNaiveStepper, gridHash: gridHash, liveCount: liveCount,
    rotateGrid90ccw: rotateGrid90ccw, transposeGrid: transposeGrid,
    findComponents: findComponents, findComponentsLabeled: findComponentsLabeled, canonicalizeComponent: canonicalizeComponent,
    rotatePointCcw: rotatePointCcw, torusDelta: torusDelta, chebyshevTorusDist: chebyshevTorusDist,
    rleEncode: rleEncode,
  };
});
