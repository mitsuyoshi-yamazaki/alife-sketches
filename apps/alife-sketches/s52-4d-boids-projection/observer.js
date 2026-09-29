/**
 * S-52 観測器 — 「4次元状態 → 2次元ラスタ画像」の16腕の写し方と、
 * 「ラスタ画像だけ → 復元4次元状態」の固定復号器、および O1〜O6 の算出。
 *
 * ここには生物学の語彙は無い（写し方・画素・復号は観測の語彙であり、群れの語彙ではない）。
 * 力学は core.js。乱数は core.js の rng だけを使う（NC2/NC3 の置換に使うシードは呼び出し側が渡す）。
 *
 * **復号器はここに凍結する**（走行前に固定。データを見てから変えない。S2 の禁則）。
 *
 * 依存ゼロ・古典スクリプト。Node と ブラウザ（window.S52O）で共用する。
 */
(function (global) {
  'use strict';
  var S = (typeof module !== 'undefined' && module.exports) ? require('./core.js')
    : (typeof window !== 'undefined' ? window.S52 : global.S52);

  // ---------------------------------------------------------------- 腕の定義（criteria.predictionTable.arms と同じ順）

  var CHOICES = ['orth', 'persp', 'slice', 'chan']; // A1..A4 / B1..B4
  var ARMS = [];
  for (var ai = 0; ai < 4; ai++) {
    for (var bi = 0; bi < 4; bi++) {
      ARMS.push({ key: 'A' + (ai + 1) + '×B' + (bi + 1), A: CHOICES[ai], B: CHOICES[bi] });
    }
  }

  function chanSlots(A, B) {
    var reqs = [];
    if (A === 'chan') reqs.push('w');
    if (B === 'chan') reqs.push('z');
    return { lightnessAxis: reqs[0] || null, sizeAxis: reqs[1] || null };
  }

  // ---------------------------------------------------------------- 既定の描画パラメータ

  var DEFAULTS = {
    L: 1.0, D: 2.5, canvas: 256, r0: 4, rClip: [2, 12],
    lightnessLevels: 64, lightnessRange: [4, 255], sizeLevels: 11, sizeRange: [2, 12],
    sliceEps: 0.05, defaultLightness: 200, binarizeThreshold: 16, claimPx: 12,
  };

  function quantize(value, L, levels, range) {
    var t = Math.max(0, Math.min(1, value / L));
    var idx = Math.min(levels - 1, Math.floor(t * levels));
    return { idx: idx, value: range[0] + (idx + 0.5) / levels * (range[1] - range[0]) };
  }
  function dequantizeToWorld(idx, levels, range, L) {
    // 量子化段の中央値から軸の値へ逆写像（range→[0,L]の逆）
    var frac = (idx + 0.5) / levels;
    return frac * L;
  }

  /**
   * 1個体の4次元位置を1腕で写す。位置は箱の中心 (0.5L,0.5L) を基準にした拡大として扱う
   * （視点は各段の捨てた軸の方向にあり、D はその軸に沿った距離。透視の倍率は中心について作用する）。
   * NC2 用に chanOverride（{w,z}の代わりに使う値）を渡せる（描画順・位置・検出率は変えない）。
   */
  function projectPoint(pos4, cfg, chanOverride) {
    var A = cfg.A, B = cfg.B, D = cfg.D, L = cfg.L;
    var x = pos4[0], y = pos4[1], z = pos4[2], w = pos4[3];
    var wForChan = chanOverride && chanOverride.w != null ? chanOverride.w : w;
    var zForChan = chanOverride && chanOverride.z != null ? chanOverride.z : z;

    var sA = A === 'persp' ? D / (D - w) : 1;
    var sB = B === 'persp' ? D / (D - z) : 1;
    var scale = sA * sB;

    var visible = true;
    if (A === 'slice' && Math.abs(S.deltaWrap(w - cfg.cw, L)) > cfg.sliceEps) visible = false;
    if (B === 'slice' && Math.abs(S.deltaWrap(z - cfg.cz, L)) > cfg.sliceEps) visible = false;

    var cx = 0.5 * L, cy = 0.5 * L;
    var dx = S.deltaWrap(x - cx, L), dy = S.deltaWrap(y - cy, L);
    var u = cx + dx * scale, v = cy + dy * scale;

    var slots = chanSlots(A, B);
    var lightness = cfg.defaultLightness, size = cfg.r0 * scale, sizeIsChan = false;
    var bothChan = slots.lightnessAxis && slots.sizeAxis;
    if (slots.lightnessAxis) {
      var axisVal = slots.lightnessAxis === 'w' ? wForChan : zForChan;
      lightness = quantize(S.wrapL(axisVal, L), L, cfg.lightnessLevels, cfg.lightnessRange).value;
    }
    if (slots.sizeAxis) {
      var axisVal2 = slots.sizeAxis === 'w' ? wForChan : zForChan;
      size = quantize(S.wrapL(axisVal2, L), L, cfg.sizeLevels, cfg.sizeRange).value;
      sizeIsChan = true;
    }
    if (!sizeIsChan) size = Math.max(cfg.rClip[0], Math.min(cfg.rClip[1], size));

    return {
      visible: visible, u: u, v: v, radius: size, lightness: Math.round(lightness),
      depthKey: w + z, // drawOrder: この和が大きい(=奥)ものを先に描く（README に登録した実装上の規約）
      sA: sA, sB: sB, scale: scale,
    };
  }

  // ---------------------------------------------------------------- 描画（画家のアルゴリズム）

  function render(trueState4, idx, cfg, chanOverrideByIndividual) {
    var canvas = cfg.canvas;
    var buf = new Uint8Array(canvas * canvas);
    var N = idx.length;
    var projected = new Array(N);
    for (var k = 0; k < N; k++) {
      var i = idx[k];
      var pos4 = [trueState4[0][i], trueState4[1][i], trueState4[2][i], trueState4[3][i]];
      var ov = chanOverrideByIndividual ? chanOverrideByIndividual[i] : null;
      projected[i] = projectPoint(pos4, cfg, ov);
    }
    var order = idx.slice().sort(function (a, b) { return projected[b].depthKey - projected[a].depthKey; });
    order.forEach(function (i) {
      var p = projected[i];
      if (!p.visible) return;
      var px = Math.round(p.u / cfg.L * canvas), py = Math.round(p.v / cfg.L * canvas);
      var r = Math.round(p.radius);
      if (px < -r || px >= canvas + r || py < -r || py >= canvas + r) { p.offCanvas = true; return; }
      var r2 = r * r;
      for (var dy = -r; dy <= r; dy++) {
        var yy = py + dy; if (yy < 0 || yy >= canvas) continue;
        for (var dx = -r; dx <= r; dx++) {
          var xx = px + dx; if (xx < 0 || xx >= canvas) continue;
          if (dx * dx + dy * dy > r2) continue;
          buf[yy * canvas + xx] = p.lightness || 1;
        }
      }
    });
    return { buf: buf, projected: projected };
  }

  // ---------------------------------------------------------------- 復号（連結成分 → 対応付け → 4次元推定）

  function connectedComponents(buf, canvas, threshold) {
    var visited = new Uint8Array(canvas * canvas);
    var comps = [];
    for (var s = 0; s < buf.length; s++) {
      if (visited[s] || buf[s] <= threshold) continue;
      var stack = [s], pix = [], sum = 0, count = 0;
      visited[s] = 1;
      while (stack.length) {
        var p = stack.pop();
        var py = (p / canvas) | 0, px = p % canvas;
        pix.push(p); sum += buf[p]; count++;
        var neigh = [p - 1, p + 1, p - canvas, p + canvas];
        for (var n = 0; n < 4; n++) {
          var np = neigh[n];
          if (n === 0 && px === 0) continue;
          if (n === 1 && px === canvas - 1) continue;
          if (np < 0 || np >= buf.length) continue;
          if (visited[np] || buf[np] <= threshold) continue;
          visited[np] = 1; stack.push(np);
        }
      }
      var sx = 0, sy = 0, hist = {};
      pix.forEach(function (p) {
        sy += (p / canvas) | 0; sx += p % canvas;
        hist[buf[p]] = (hist[buf[p]] || 0) + 1;
      });
      var modeVal = 0, modeCount = -1;
      Object.keys(hist).forEach(function (v) { if (hist[v] > modeCount) { modeCount = hist[v]; modeVal = Number(v); } });
      comps.push({ px: sx / count, py: sy / count, area: count, value: modeVal });
    }
    return comps;
  }

  /**
   * 貪欲最近傍（真の点をID順に見て最も近い未使用の復号点を取る）。knobs の登録どおり既定にする。
   * 戻り値: 個体ごとの {detected, comp, fused}（fused=そのcompの面積が単一円板の上限を超える）。
   */
  function matchGreedy(projected, comps, idx, cfg) {
    // 融合判定の基準面積は「この腕が実際に描く最大半径」で取る（登録は r_max と書くが、
    // 常に画布全体の上限[2,12]を使うと固定半径r0=4の腕(正射影・断面・明度チャネルのみ等)では
    // ほぼ絶対に融合を検出できなくなる。透視・大きさチャネルが関与する腕だけ [2,12] の上限を使う）。
    var usesVariableSize = cfg.A === 'persp' || cfg.B === 'persp' || chanSlots(cfg.A, cfg.B).sizeAxis;
    var rMaxForFusion = usesVariableSize ? cfg.rClip[1] : cfg.r0;
    var fusedThreshold = 1.5 * Math.PI * rMaxForFusion * rMaxForFusion;
    var claimed = new Array(comps.length).fill(false);
    var out = {};
    idx.forEach(function (i) {
      var p = projected[i];
      if (!p.visible || p.offCanvas) { out[i] = { detected: false }; return; }
      var px = p.u / cfg.L * cfg.canvas, py = p.v / cfg.L * cfg.canvas;
      var best = -1, bestD = cfg.claimPx * cfg.claimPx;
      for (var c = 0; c < comps.length; c++) {
        if (claimed[c]) continue;
        var dx = comps[c].px - px, dy = comps[c].py - py, d2 = dx * dx + dy * dy;
        if (d2 < bestD) { bestD = d2; best = c; }
      }
      if (best < 0) { out[i] = { detected: false }; return; }
      claimed[best] = true;
      out[i] = { detected: true, comp: comps[best], fused: comps[best].area > fusedThreshold };
    });
    return out;
  }

  /** 復号された画素の位置・チャネル値から4次元推定 p̂ を作る（未復元の軸は箱の中心 0.5L）。 */
  function decodeState(match, projected, idx, cfg) {
    var L = cfg.L, cx = 0.5 * L, cy = 0.5 * L;
    var out = {};
    idx.forEach(function (i) {
      var m = match[i];
      if (!m.detected) { out[i] = { detected: false, p: [cx, cy, 0.5 * L, 0.5 * L] }; return; }
      var p = projected[i]; // sA,sB は真値から作った（復号器は自分の測定[半径]から逆算する。以下）
      var rMeasured = Math.sqrt(m.comp.area / Math.PI);
      var scaleHat = 1, sAHat = 1, sBHat = 1;
      var bothPersp = cfg.A === 'persp' && cfg.B === 'persp';
      var slots = chanSlots(cfg.A, cfg.B);
      var sizeIsChan = !!slots.sizeAxis;
      if (!sizeIsChan) {
        scaleHat = rMeasured / cfg.r0;
        if (cfg.A === 'persp' && cfg.B === 'persp') { sAHat = Math.sqrt(scaleHat); sBHat = Math.sqrt(scaleHat); } // 等分規約（登録どおり）
        else if (cfg.A === 'persp') { sAHat = scaleHat; }
        else if (cfg.B === 'persp') { sBHat = scaleHat; }
      }
      var xHat = cx + S.deltaWrap(m.comp.px / cfg.canvas * L - cx, L) / (sAHat * sBHat);
      var yHat = cy + S.deltaWrap(m.comp.py / cfg.canvas * L - cy, L) / (sAHat * sBHat);
      var wHat = 0.5 * L, zHat = 0.5 * L;
      if (cfg.A === 'persp') wHat = cfg.D - cfg.D / sAHat;
      else if (cfg.A === 'slice') wHat = cfg.cw;
      else if (cfg.A === 'chan' && slots.lightnessAxis === 'w') wHat = dequantizeFromChannel(m.comp.value, cfg.lightnessLevels, cfg.lightnessRange, L);
      else if (cfg.A === 'chan' && slots.sizeAxis === 'w') wHat = dequantizeFromChannel(rMeasured * 2, cfg.sizeLevels, [cfg.sizeRange[0] * 1, cfg.sizeRange[1] * 1], L, true, rMeasured);
      if (cfg.B === 'persp') zHat = cfg.D - cfg.D / sBHat;
      else if (cfg.B === 'slice') zHat = cfg.cz;
      else if (cfg.B === 'chan' && slots.lightnessAxis === 'z') zHat = dequantizeFromChannel(m.comp.value, cfg.lightnessLevels, cfg.lightnessRange, L);
      else if (cfg.B === 'chan' && slots.sizeAxis === 'z') zHat = dequantizeFromChannel(rMeasured * 2, cfg.sizeLevels, cfg.sizeRange, L, true, rMeasured);
      out[i] = { detected: true, p: [xHat, yHat, zHat, wHat], fused: m.fused };
    });
    return out;
  }

  /** 明度/大きさの量子化段から軸の値へ逆写像。大きさチャネルは測定半径(rMeasured)から直接段を逆算する。 */
  function dequantizeFromChannel(valueOrRadius, levels, range, L, isSize, rMeasured) {
    if (isSize) {
      var t = (rMeasured - range[0]) / (range[1] - range[0]);
      t = Math.max(0, Math.min(1, t));
      var idx = Math.round(t * (levels - 1));
      return (idx + 0.5) / levels * L;
    }
    var t2 = (valueOrRadius - range[0]) / (range[1] - range[0]);
    t2 = Math.max(0, Math.min(1, t2));
    var idx2 = Math.floor(t2 * levels);
    return (idx2 + 0.5) / levels * L;
  }

  // ---------------------------------------------------------------- 1フレーム・1腕の完全な処理

  /**
   * 1フレーム・1腕を描画→復号→対応付けまで行う。cfg は projectPoint の cfg に claimPx 等を加えたもの。
   * NC2 用に chanOverrideByIndividual、NC3 用に shuffleCorrespondence(seededRng) を渡せる。
   */
  function runArmFrame(trueState4, N, cfg, opts) {
    opts = opts || {};
    var idx = []; for (var i = 0; i < N; i++) idx.push(i);
    var rendered = render(trueState4, idx, cfg, opts.chanOverride);
    var comps = connectedComponents(rendered.buf, cfg.canvas, cfg.binarizeThreshold);
    var match = matchGreedy(rendered.projected, comps, idx, cfg);
    if (opts.shuffleCorrespondence) {
      // NC3: 対応付けの段だけをランダム置換する（復号自体は正しく行う）
      var detectedIds = idx.filter(function (i) { return match[i].detected; });
      var comps2 = detectedIds.map(function (i) { return match[i]; });
      var shuffled = opts.shuffleCorrespondence(comps2.slice());
      var newMatch = {};
      idx.forEach(function (i) { newMatch[i] = { detected: false }; });
      detectedIds.forEach(function (i, k) { newMatch[i] = shuffled[k]; });
      match = newMatch;
    }
    var decoded = decodeState(match, rendered.projected, idx, cfg);
    return { buf: rendered.buf, projected: rendered.projected, comps: comps, match: match, decoded: decoded, idx: idx };
  }

  // ---------------------------------------------------------------- O1〜O6

  function median(arr) {
    if (!arr.length) return null;
    var s = arr.slice().sort(function (a, b) { return a - b; }); var m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /** O1: 正規化4次元距離 ≤ τ で対応した割合。分母は idx.length（呼び側が全個体か描画個体かを選ぶ）。 */
  function o1Recovery(trueState4, decoded, idx, L, taus) {
    var out = {};
    taus.forEach(function (tau) {
      var hit = 0;
      idx.forEach(function (i) {
        var p = decoded[i].p;
        var d2 = 0;
        for (var a = 0; a < 4; a++) { var dd = S.deltaWrap(trueState4[a][i] - p[a], L); d2 += dd * dd; }
        if (Math.sqrt(d2) / L <= tau) hit++;
      });
      out[tau] = idx.length ? hit / idx.length : 0;
    });
    return out;
  }

  /** 真の4次元 k 近傍集合（トーラス距離）。 */
  function trueKNN(trueState4, N, L, k) {
    var out = [];
    for (var i = 0; i < N; i++) {
      var ds = [];
      for (var j = 0; j < N; j++) {
        if (j === i) continue;
        var d2 = 0;
        for (var a = 0; a < 4; a++) { var dd = S.deltaWrap(trueState4[a][i] - trueState4[a][j], L); d2 += dd * dd; }
        ds.push([j, d2]);
      }
      ds.sort(function (a, b) { return a[1] - b[1]; });
      out.push(ds.slice(0, k).map(function (e) { return e[0]; }));
    }
    return out;
  }

  /** 復号点どうしの k 近傍（検出された個体だけが候補になる。K-30/O2の登録どおり）。 */
  function decodedKNN(decoded, idx, L, k) {
    var detected = idx.filter(function (i) { return decoded[i].detected; });
    var out = {};
    detected.forEach(function (i) {
      var ds = [];
      detected.forEach(function (j) {
        if (j === i) return;
        var d2 = 0;
        for (var a = 0; a < 4; a++) { var dd = S.deltaWrap(decoded[i].p[a] - decoded[j].p[a], L); d2 += dd * dd; }
        ds.push([j, d2]);
      });
      ds.sort(function (a, b) { return a[1] - b[1]; });
      out[i] = ds.slice(0, k).map(function (e) { return e[0]; });
    });
    return out;
  }

  function jaccard(a, b) {
    var sa = {}; a.forEach(function (x) { sa[x] = 1; });
    var sb = {}; b.forEach(function (x) { sb[x] = 1; });
    var uni = {}; a.concat(b).forEach(function (x) { uni[x] = 1; });
    var inter = 0; Object.keys(sa).forEach(function (x) { if (sb[x]) inter++; });
    var uniN = Object.keys(uni).length;
    return uniN > 0 ? inter / uniN : 0;
  }

  /** O2: 個体ごとの Jaccard（未検出は0。K-30の登録どおり、全個体を分母に含める）。 */
  function o2NeighborJaccard(trueState4, decoded, idx, N, L, k) {
    var trueNN = trueKNN(trueState4, N, L, k);
    var decNN = decodedKNN(decoded, idx, L, k);
    return idx.map(function (i) {
      if (!decoded[i].detected) return 0;
      return jaccard(trueNN[i], decNN[i] || []);
    });
  }

  /** O3: 描いた個体のうち単一マークとして検出できた割合（分母=描いた個体。融合成分は1個体のみ検出）。 */
  function o3DetectionRate(projected, match, idx) {
    var drawn = idx.filter(function (i) { return projected[i].visible && !projected[i].offCanvas; });
    if (!drawn.length) return null;
    var okCount = drawn.filter(function (i) { return match[i].detected; }).length;
    return okCount / drawn.length;
  }

  function rankArray(arr) {
    var idxSorted = arr.map(function (v, i) { return i; }).sort(function (a, b) { return arr[a] - arr[b]; });
    var ranks = new Array(arr.length);
    var i = 0;
    while (i < idxSorted.length) {
      var j = i;
      while (j + 1 < idxSorted.length && arr[idxSorted[j + 1]] === arr[idxSorted[i]]) j++;
      var avgRank = (i + j) / 2 + 1;
      for (var k = i; k <= j; k++) ranks[idxSorted[k]] = avgRank;
      i = j + 1;
    }
    return ranks;
  }
  function spearman(a, b) {
    var ra = rankArray(a), rb = rankArray(b), n = a.length;
    var mra = ra.reduce(function (s, v) { return s + v; }, 0) / n;
    var mrb = rb.reduce(function (s, v) { return s + v; }, 0) / n;
    var num = 0, da = 0, db = 0;
    for (var i = 0; i < n; i++) { num += (ra[i] - mra) * (rb[i] - mrb); da += (ra[i] - mra) * (ra[i] - mra); db += (rb[i] - mrb) * (rb[i] - mrb); }
    return (da > 0 && db > 0) ? num / Math.sqrt(da * db) : 0;
  }
  function pearson(a, b) {
    var n = a.length, ma = a.reduce(function (s, v) { return s + v; }, 0) / n, mb = b.reduce(function (s, v) { return s + v; }, 0) / n;
    var num = 0, da = 0, db = 0;
    for (var i = 0; i < n; i++) { num += (a[i] - ma) * (b[i] - mb); da += (a[i] - ma) * (a[i] - ma); db += (b[i] - mb) * (b[i] - mb); }
    return (da > 0 && db > 0) ? num / Math.sqrt(da * db) : 0;
  }

  /** O4: 未検出・未描画の個体には既定値0.5Lが入っているので、そのまま全個体で順位相関する。 */
  function o4AxisSpearman(trueState4, decoded, idx, axisIndex) {
    var trueVals = idx.map(function (i) { return trueState4[axisIndex][i]; });
    var decVals = idx.map(function (i) { return decoded[i].p[axisIndex]; });
    return spearman(trueVals, decVals);
  }

  /** O5: 2フレームの復号差分から作った速度どうしの、個体対 cos∠ の一致（Pearson）。 */
  function o5VelocityAgreement(trueVelPairs, decodedPosA, decodedPosB, idx) {
    var trueCos = [], decCos = [];
    var vTrue = {}, vDec = {};
    idx.forEach(function (i) {
      vTrue[i] = trueVelPairs.true[i];
      if (decodedPosA[i].detected && decodedPosB[i].detected) {
        vDec[i] = [0, 1, 2, 3].map(function (a) { return decodedPosB[i].p[a] - decodedPosA[i].p[a]; });
      }
    });
    var ids = idx.filter(function (i) { return vDec[i]; });
    for (var a = 0; a < ids.length; a++) {
      for (var b = a + 1; b < ids.length; b++) {
        var i = ids[a], j = ids[b];
        trueCos.push(cosAngle(vTrue[i], vTrue[j]));
        decCos.push(cosAngle(vDec[i], vDec[j]));
      }
    }
    return trueCos.length ? pearson(trueCos, decCos) : null;
  }
  function cosAngle(v1, v2) {
    var dot = 0, n1 = 0, n2 = 0;
    for (var a = 0; a < v1.length; a++) { dot += v1[a] * v2[a]; n1 += v1[a] * v1[a]; n2 += v2[a] * v2[a]; }
    var d = Math.sqrt(n1) * Math.sqrt(n2);
    return d > 1e-12 ? dot / d : 0;
  }

  // ---------------------------------------------------------------- 加法モデル（decisionRule の一次判定）

  function fitAdditive(M) {
    var mu = 0, n = 0;
    for (var a = 0; a < 4; a++) for (var b = 0; b < 4; b++) { mu += M[a][b]; n++; }
    mu /= n;
    var alpha = [0, 0, 0, 0], beta = [0, 0, 0, 0];
    for (a = 0; a < 4; a++) { var rowMean = M[a].reduce(function (s, v) { return s + v; }, 0) / 4; alpha[a] = rowMean - mu; }
    for (b = 0; b < 4; b++) { var colSum = 0; for (a = 0; a < 4; a++) colSum += M[a][b]; beta[b] = colSum / 4 - mu; }
    var resid = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], ss = 0;
    for (a = 0; a < 4; a++) for (b = 0; b < 4; b++) { var fit = mu + alpha[a] + beta[b]; resid[a][b] = M[a][b] - fit; ss += resid[a][b] * resid[a][b]; }
    return { mu: mu, alpha: alpha, beta: beta, resid: resid, rms: Math.sqrt(ss / 16) };
  }

  // ---------------------------------------------------------------- 解析的恒等式（PC1・PC2）

  /** d 次元球(半径R)を2次元へ正射影した動径密度 p(ρ)∝ρ(R²-ρ²)^((d-2)/2) の累積分布(数値積分)。 */
  function radialCDF(d, R, nBins) {
    nBins = nBins || 2000;
    var dens = new Array(nBins), cum = new Array(nBins + 1); cum[0] = 0;
    for (var i = 0; i < nBins; i++) {
      var rho = (i + 0.5) / nBins * R;
      var base = R * R - rho * rho;
      dens[i] = rho * Math.pow(Math.max(base, 0), (d - 2) / 2);
    }
    var total = dens.reduce(function (s, v) { return s + v; }, 0);
    for (i = 0; i < nBins; i++) cum[i + 1] = cum[i] + dens[i] / total;
    return function (rho) {
      var t = Math.max(0, Math.min(R, rho)) / R * nBins;
      var lo = Math.floor(t); if (lo >= nBins) return 1;
      var frac = t - lo;
      return cum[lo] * (1 - frac) + cum[lo + 1] * frac;
    };
  }

  /** 経験分布と解析CDFのKolmogorov-Smirnov統計量。 */
  function ksStatistic(samples, cdf) {
    var s = samples.slice().sort(function (a, b) { return a - b; });
    var n = s.length, maxD = 0;
    for (var i = 0; i < n; i++) {
      var Fn = (i + 1) / n, Fe = cdf(s[i]);
      maxD = Math.max(maxD, Math.abs(Fn - Fe));
      var FnPrev = i / n;
      maxD = Math.max(maxD, Math.abs(FnPrev - Fe));
    }
    return maxD;
  }

  /** 断面が残す割合 f_d(eps/R)（数値積分。criteria の式そのもの）。 */
  function sliceRetentionFraction(d, epsOverR, nBins) {
    nBins = nBins || 4000;
    function integrand(hOverR) { return Math.pow(Math.max(1 - hOverR * hOverR, 0), (d - 1) / 2); }
    function integrate(a, b) {
      var sum = 0;
      for (var i = 0; i < nBins; i++) {
        var t0 = a + (b - a) * i / nBins, t1 = a + (b - a) * (i + 1) / nBins;
        sum += (integrand(t0) + integrand(t1)) / 2 * (t1 - t0);
      }
      return sum;
    }
    return integrate(-epsOverR, epsOverR) / integrate(-1, 1);
  }

  var api = {
    ARMS: ARMS, DEFAULTS: DEFAULTS, chanSlots: chanSlots,
    projectPoint: projectPoint, render: render, connectedComponents: connectedComponents,
    matchGreedy: matchGreedy, decodeState: decodeState, runArmFrame: runArmFrame,
    median: median, o1Recovery: o1Recovery, trueKNN: trueKNN, decodedKNN: decodedKNN, jaccard: jaccard,
    o2NeighborJaccard: o2NeighborJaccard, o3DetectionRate: o3DetectionRate,
    o4AxisSpearman: o4AxisSpearman, o5VelocityAgreement: o5VelocityAgreement, cosAngle: cosAngle,
    spearman: spearman, pearson: pearson, rankArray: rankArray,
    fitAdditive: fitAdditive, radialCDF: radialCDF, ksStatistic: ksStatistic, sliceRetentionFraction: sliceRetentionFraction,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.S52O = api;
  if (typeof global !== 'undefined' && global && !global.S52O) global.S52O = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
