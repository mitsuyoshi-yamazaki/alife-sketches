/**
 * S-51 観測器 — criteria.json の decoders（D1 pixelLocal / D2 preRasterGrouped）と
 * orderParameters（R・J*・E_φ）をそのままコードにしたもの。判定に使う語彙（マーク検出・
 * ridge回帰・秩序変数）はここにだけ置く（core.js は3次元boidの力学と描画だけを知る）。
 *
 * 2026-09-17 新設（親の指示。core.jsが960行になり恒常のコーディング規約の800行上限を超えたため、
 * S-49のcore.js/observer.jsの分け方に倣って分離した。挙動は分割前と一致することを
 * selftest.js通過とrun.jsの数値一致で確認済み——分割は構造の変更であって、判定の定義は変えていない）。
 *
 * 依存ゼロ・古典スクリプト。Node（module.exports、core.js を require）と
 * ブラウザ（window.S51Observer、window.S51 を参照）で共用する。
 */
(function (global, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory(require('./core.js'));
  } else {
    global.S51Observer = factory(global.S51);
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, function (Core) {
  'use strict';

  // ================================================================== 評価アンカー（真の個体位置）

  /**
   * 個体の「真の位置」（評価の対応づけに使う唯一のアンカー）。全アームで共通に xy 正射影を使う
   * （A4 は左パネルの座標系）——これにより「右パネルのマークは真の個体位置と対応しない」という
   * criteria の予測どおり、D1 は A4 の右パネル情報を使えなくなる（別マークとして相関しない）。
   */
  function anchorsForArm(state, armId) {
    var out = [];
    for (var i = 0; i < state.count; i++) {
      var uv = armId === 'A4' ? Core.projectPanel(state.x[i], state.y[i], 256) : Core.projectMain(state.x[i], state.y[i]);
      out.push({ i: i, u: uv[0], v: uv[1], z: state.z[i] });
    }
    return out;
  }

  // ================================================================== D1: pixelLocal（マーク検出→特徴→ridge）

  var KERNEL3 = [1, 2, 1, 2, 4, 2, 1, 2, 1]; // 二項カーネル（合計16）

  function luma(buf, idx) { return Math.max(buf[idx], buf[idx + 1], buf[idx + 2]); }

  /** 3x3二項平滑化した Y（輝度）配列を返す（境界はクランプ）。 */
  function smoothY(buf, w, h) {
    var out = new Float64Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var acc = 0, ki = 0;
        for (var dy = -1; dy <= 1; dy++) {
          var yy = Math.max(0, Math.min(h - 1, y + dy));
          for (var dx = -1; dx <= 1; dx++) {
            var xx = Math.max(0, Math.min(w - 1, x + dx));
            acc += luma(buf, (yy * w + xx) * 3) * KERNEL3[ki++];
          }
        }
        out[y * w + x] = acc / 16;
      }
    }
    return out;
  }

  /**
   * マーク検出（D1の入口。個体数・個体リストを与えない）。8近傍で厳密な極大・閾値以上・
   * 3px未満の極大は明るいほうを残す。 apparent radius ρ̂ は Y が Y_peak/2 未満になる最小半径（1..10px梯子）。
   */
  function detectMarks(buf, w, h, brightnessThreshold) {
    var sm = smoothY(buf, w, h);
    // マークは同色の塗り円（内部は平坦）なので、厳密な「8近傍のいずれよりも大きい」だけでは
    // 平坦な内部の全画素が極大候補になってしまう（実装して初めて分かった落とし穴。README参照）。
    // 「同値の連結成分（プラトー）につき1点、走査順で先頭のものを代表点とする」を極大の定義に加える
    // ——criteria の「同値は走査順で先勝ち」を、単一画素の同着だけでなく面のプラトーへ拡張した形。
    var visited = new Uint8Array(w * h);
    var cand = [];
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var p0 = y * w + x;
        if (visited[p0]) continue;
        var v = sm[p0];
        if (v < brightnessThreshold) { visited[p0] = 1; continue; }
        var isMax = true;
        for (var dy = -1; dy <= 1 && isMax; dy++) for (var dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          var ny = y + dy, nx = x + dx;
          if (ny < 0 || ny >= h || nx < 0 || nx >= w) continue;
          if (sm[ny * w + nx] > v) { isMax = false; break; }
        }
        if (!isMax) { visited[p0] = 1; continue; }
        // プラトー（厳密に同じ値の4連結領域）を洪水塗りする。代表点は塗り円の中心付近に来る
        // よう重心を使う（走査順で最初の画素=円の上端付近を使うと、半径ぶん系統的にずれた
        // 位置がマーク中心として報告され、screen→world逆算がピクセル量子化を大きく超えて
        // ずれるバグになった。実装して初めて分かった落とし穴。README/notes.md参照）。
        var stack = [p0]; visited[p0] = 1;
        var sumX = x, sumY = y, cnt = 1;
        while (stack.length) {
          var cur = stack.pop();
          var cy = Math.floor(cur / w), cx = cur % w;
          var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
          for (var di = 0; di < 4; di++) {
            var qx = cx + dirs[di][0], qy = cy + dirs[di][1];
            if (qx < 0 || qx >= w || qy < 0 || qy >= h) continue;
            var q = qy * w + qx;
            if (visited[q]) continue;
            if (sm[q] === v) { visited[q] = 1; stack.push(q); sumX += qx; sumY += qy; cnt++; }
          }
        }
        cand.push({ x: Math.round(sumX / cnt), y: Math.round(sumY / cnt), v: v });
      }
    }
    cand.sort(function (a, b) { return b.v - a.v; });
    var kept = [];
    for (var c = 0; c < cand.length; c++) {
      var ok = true;
      for (var kk = 0; kk < kept.length; kk++) {
        var dxk = cand[c].x - kept[kk].x, dyk = cand[c].y - kept[kk].y;
        if (dxk * dxk + dyk * dyk < 9) { ok = false; break; } // 3px未満
      }
      if (ok) kept.push(cand[c]);
    }
    var marks = [];
    for (var m = 0; m < kept.length; m++) {
      var cx = kept[m].x, cy = kept[m].y;
      var idx = (cy * w + cx) * 3;
      var R = buf[idx], G = buf[idx + 1], B = buf[idx + 2], Y = Math.max(R, G, B);
      var peak = sm[cy * w + cx];
      var rho = 10;
      for (var rr = 1; rr <= 10; rr++) {
        var px = Math.max(0, Math.min(w - 1, cx + rr));
        var val = sm[cy * w + px];
        if (val < peak / 2) { rho = rr; break; }
      }
      marks.push({ u: cx, v: cy, Y: Y, R: R, G: G, B: B, rho: rho });
    }
    return marks;
  }

  /** 近傍マーク数（同フレーム内、20px以内）。 */
  function neighbourMarkCount(marks, m, radius) {
    var cnt = 0;
    for (var i = 0; i < marks.length; i++) {
      if (marks[i] === m) continue;
      var dx = marks[i].u - m.u, dy = marks[i].v - m.v;
      if (dx * dx + dy * dy <= radius * radius) cnt++;
    }
    return cnt;
  }

  /** 次フレームの最近傍マーク（12px以内）までの画面変位。無ければ0。 */
  function frameDisplacement(m, nextMarks, maxDist) {
    if (!nextMarks) return 0;
    var best = Infinity;
    for (var i = 0; i < nextMarks.length; i++) {
      var dx = nextMarks[i].u - m.u, dy = nextMarks[i].v - m.v;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d < best) best = d;
    }
    return (best <= maxDist) ? best : 0;
  }

  /** 6つの生特徴を2次展開(線形6+自乗6+交差15=27) + u_norm,v_norm(線形2) = 29特徴。 */
  function expandFeatures(raw6, uNorm, vNorm) {
    var out = raw6.slice();
    for (var i = 0; i < 6; i++) out.push(raw6[i] * raw6[i]);
    for (var i2 = 0; i2 < 6; i2++) for (var j2 = i2 + 1; j2 < 6; j2++) out.push(raw6[i2] * raw6[j2]);
    out.push(uNorm, vNorm);
    return out; // 長さ29
  }

  /**
   * D1: 1つの評価窓（連続 framesPerWindow フレームの buf 配列）から、各マークの特徴ベクトルと、
   * 真のアンカーへの対応づけ（貪欲最近傍・上限6px）を作る。戻り値: [{feat29, i, zTrue, frameIdx}...]
   */
  function d1ExamplesForWindow(frameBufs, armId, states, brightnessThreshold, matchMaxDist) {
    var w = frameBufs[0].w, h = frameBufs[0].h;
    var marksPerFrame = frameBufs.map(function (fb) { return detectMarks(fb.buf, w, h, brightnessThreshold); });
    var out = [];
    for (var f = 0; f < frameBufs.length; f++) {
      var marks = marksPerFrame[f];
      var next = f + 1 < frameBufs.length ? marksPerFrame[f + 1] : null;
      var anchors = anchorsForArm(states[f], armId);
      var pairs = [];
      for (var a = 0; a < anchors.length; a++) for (var mi = 0; mi < marks.length; mi++) {
        var dx = anchors[a].u - marks[mi].u, dy = anchors[a].v - marks[mi].v;
        var d = Math.sqrt(dx * dx + dy * dy);
        if (d <= matchMaxDist) pairs.push({ a: a, m: mi, d: d });
      }
      pairs.sort(function (p, q) { return p.d - q.d; });
      var usedA = {}, usedM = {};
      for (var p = 0; p < pairs.length; p++) {
        var pr = pairs[p];
        if (usedA[pr.a] || usedM[pr.m]) continue;
        usedA[pr.a] = true; usedM[pr.m] = true;
        var mk = marks[pr.m];
        var raw6 = [mk.Y, mk.R, mk.B, mk.rho, neighbourMarkCount(marks, mk, 20), frameDisplacement(mk, next, 12)];
        var feat = expandFeatures(raw6, mk.u / w, mk.v / h);
        out.push({ feat: feat, i: anchors[pr.a].i, zTrue: anchors[pr.a].z, frameIdx: f });
      }
    }
    return out;
  }

  // ================================================================== D2: preRasterGrouped（描画レコード直接）

  /** アームごとの描画レコード（個体ごとにグループ化・座標厳密）。A1は枠外を出さない。A4は2マーク。 */
  function drawRecordsForArm(state, armId, opts) {
    opts = opts || {};
    var zbar = Core.zbarOf(state);
    var h = opts.h == null ? Core.ENC.A1_H : opts.h, zRef = opts.zRef == null ? Core.ENC.A2_ZREF : opts.zRef;
    var recs = [];
    for (var i = 0; i < state.count; i++) {
      var rec = { i: i };
      if (armId === 'A0') {
        var uv0 = Core.projectMain(state.x[i], state.y[i]);
        rec.u = uv0[0]; rec.v = uv0[1]; rec.Y = 255; rec.R = 255; rec.B = 255; rec.radius = Core.ENC.R_BASIC;
      } else if (armId === 'A1' || armId === 'A1rp') {
        var zc = armId === 'A1rp' ? opts.planeZ : zbar;
        if (Math.abs(state.z[i] - zc) > h) continue;
        var uv1 = Core.projectMain(state.x[i], state.y[i]);
        rec.u = uv1[0]; rec.v = uv1[1]; rec.Y = 255; rec.R = 255; rec.B = 255; rec.radius = Core.ENC.R_BASIC;
      } else if (armId === 'A2' || armId === 'NEG3') {
        var srcIdx = (armId === 'NEG3' && opts.permIdx) ? opts.permIdx[i] : i;
        var sh = Core.shadeSizeOf(state.z[srcIdx], zbar, zRef);
        var uv2 = Core.projectMain(state.x[i], state.y[i]);
        rec.u = uv2[0]; rec.v = uv2[1]; rec.Y = Math.max.apply(null, sh.rgb); rec.R = sh.rgb[0]; rec.B = sh.rgb[2]; rec.radius = sh.r;
      } else if (armId === 'A3') {
        var uv3 = Core.projectMain(state.x[i], state.y[i]);
        if (Math.abs(state.z[i] - zbar) <= h) { rec.u = uv3[0]; rec.v = uv3[1]; rec.Y = 255; rec.R = 255; rec.B = 255; rec.radius = Core.ENC.A2_RMAX; }
        else { var sh3 = Core.shadeSizeOf(state.z[i], zbar, zRef); rec.u = uv3[0]; rec.v = uv3[1]; rec.Y = Math.max.apply(null, sh3.rgb); rec.R = sh3.rgb[0]; rec.B = sh3.rgb[2]; rec.radius = sh3.r; }
      } else if (armId === 'A4') {
        var left = Core.projectPanel(state.x[i], state.y[i], 256), right = Core.projectPanel(state.x[i], state.z[i], 256);
        rec.u = left[0]; rec.v = left[1]; rec.Y = 255; rec.R = 255; rec.B = 255; rec.radius = 2.0;
        rec.u2 = right[0] + 256; rec.v2 = right[1]; rec.hasSecond = 1;
      }
      recs.push(rec);
    }
    return recs;
  }

  /** D2用: 6生特徴(D1と同種) + u_norm,v_norm + 2次展開 → 29特徴、+ 2マーク目(u2,v2,flag) → 32特徴。 */
  function d2ExamplesForWindow(states, armId, opts, w, h) {
    var recsPerFrame = states.map(function (st) { return drawRecordsForArm(st, armId, opts); });
    var out = [];
    for (var f = 0; f < states.length; f++) {
      var recs = recsPerFrame[f];
      var next = f + 1 < states.length ? recsPerFrame[f + 1] : null;
      var nextByI = {}; if (next) next.forEach(function (r) { nextByI[r.i] = r; });
      for (var r = 0; r < recs.length; r++) {
        var rec = recs[r];
        var nb = 0;
        for (var r2 = 0; r2 < recs.length; r2++) {
          if (r2 === r) continue;
          var dx = recs[r2].u - rec.u, dy = recs[r2].v - rec.v;
          if (dx * dx + dy * dy <= 400) nb++;
        }
        var disp = 0;
        var nrec = nextByI[rec.i];
        if (nrec) { var ddx = nrec.u - rec.u, ddy = nrec.v - rec.v; disp = Math.sqrt(ddx * ddx + ddy * ddy); }
        var raw6 = [rec.Y, rec.R, rec.B, rec.radius, nb, disp];
        var feat = expandFeatures(raw6, rec.u / w, rec.v / h);
        feat.push(rec.hasSecond ? rec.u2 / w : 0, rec.hasSecond ? rec.v2 / h : 0, rec.hasSecond ? 1 : 0);
        out.push({ feat: feat, i: rec.i, zTrue: states[f].z[rec.i], frameIdx: f });
      }
    }
    return out;
  }

  // ================================================================== ridge 回帰（閉形式・依存ゼロ）

  function standardizeFit(X) {
    var n = X.length, p = X[0].length;
    var mean = new Array(p).fill(0), std = new Array(p).fill(0);
    for (var i = 0; i < n; i++) for (var j = 0; j < p; j++) mean[j] += X[i][j];
    for (j = 0; j < p; j++) mean[j] /= n;
    for (i = 0; i < n; i++) for (j = 0; j < p; j++) { var d = X[i][j] - mean[j]; std[j] += d * d; }
    for (j = 0; j < p; j++) { std[j] = Math.sqrt(std[j] / n); if (std[j] < 1e-9) std[j] = 1; }
    return { mean: mean, std: std };
  }

  function standardizeApply(X, s) {
    return X.map(function (row) { return row.map(function (v, j) { return (v - s.mean[j]) / s.std[j]; }); });
  }

  /** n×n 連立方程式 A w = b を Gauss-Jordan で解く（p<=32程度の小規模用）。 */
  function solveLinear(A, b) {
    var n = A.length;
    var M = A.map(function (row, i) { return row.concat([b[i]]); });
    for (var col = 0; col < n; col++) {
      var piv = col;
      for (var r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      var tmp = M[col]; M[col] = M[piv]; M[piv] = tmp;
      var pv = M[col][col]; if (Math.abs(pv) < 1e-12) pv = 1e-12;
      for (col2 = col; col2 <= n; col2++) M[col][col2] /= pv;
      for (r = 0; r < n; r++) {
        if (r === col) continue;
        var f = M[r][col];
        if (f === 0) continue;
        for (var col2 = col; col2 <= n; col2++) M[r][col2] -= f * M[col][col2];
      }
    }
    return M.map(function (row) { return row[n]; });
  }

  /**
   * ridge 回帰（閉形式）。特徴は較正集合で標準化。λ = lambdaScale × trace(XᵀX)/p。
   * 戻り値: {w, mean, std, zBarCal} — X(標準化後)に対する重み。
   */
  function fitRidge(examples, lambdaScale) {
    var zBarCal = examples.reduce(function (s, e) { return s + e.zTrue; }, 0) / examples.length;
    if (examples.length < 3) return { w: null, mean: null, std: null, zBarCal: zBarCal, p: 0, n: examples.length };
    var Xraw = examples.map(function (e) { return e.feat; });
    var y = examples.map(function (e) { return e.zTrue; });
    var p = Xraw[0].length;
    var stat = standardizeFit(Xraw);
    var X = standardizeApply(Xraw, stat);
    // 切片項として全1列を先頭に追加
    var Xi = X.map(function (row) { return [1].concat(row); });
    var pp = p + 1;
    var XtX = new Array(pp); for (var i = 0; i < pp; i++) XtX[i] = new Array(pp).fill(0);
    var Xty = new Array(pp).fill(0);
    for (i = 0; i < Xi.length; i++) {
      for (var a = 0; a < pp; a++) {
        Xty[a] += Xi[i][a] * y[i];
        for (var b = 0; b < pp; b++) XtX[a][b] += Xi[i][a] * Xi[i][b];
      }
    }
    var trace = 0; for (i = 0; i < pp; i++) trace += XtX[i][i];
    var lambda = lambdaScale * trace / p;
    for (i = 1; i < pp; i++) XtX[i][i] += lambda; // 切片には罰則をかけない
    var w = solveLinear(XtX, Xty);
    return { w: w, mean: stat.mean, std: stat.std, zBarCal: zBarCal, p: p, n: examples.length, lambda: lambda };
  }

  function predictRidge(model, feat) {
    if (!model.w) return model.zBarCal;
    var xs = feat.map(function (v, j) { return (v - model.mean[j]) / model.std[j]; });
    var yhat = model.w[0];
    for (var j = 0; j < xs.length; j++) yhat += model.w[j + 1] * xs[j];
    return yhat;
  }

  // ================================================================== 秩序変数

  /**
   * 母集団全個体について R を計算する（population欄の規約: 未検出は ẑ=z̄_cal で満額の誤差）。
   * examples は {i, zTrue, zPred, frameIdx} の配列（1個体×1フレームごとの予測。複数あれば平均する）。
   */
  function computeR(examples, N, framesEvaluated, zBarCal) {
    var byIndivFrame = {}; // key: i|frameIdx → [zPred...]
    examples.forEach(function (e) {
      var key = e.i + '|' + e.frameIdx;
      (byIndivFrame[key] = byIndivFrame[key] || []).push(e.zPred);
    });
    var sse = 0, sst = 0, nTerms = 0, detected = 0;
    framesEvaluated.forEach(function (fr) {
      for (var i = 0; i < N; i++) {
        var key = i + '|' + fr.frameIdx;
        var zTrue = fr.zTrue[i];
        var preds = byIndivFrame[key];
        var zPred = preds && preds.length ? preds.reduce(function (s, v) { return s + v; }, 0) / preds.length : zBarCal;
        if (preds && preds.length) detected++;
        sse += (zPred - zTrue) * (zPred - zTrue);
        sst += (zTrue - zBarCal) * (zTrue - zBarCal);
        nTerms++;
      }
    });
    var R = sst > 1e-9 ? 1 - sse / sst : 0;
    return { R: R, detectedFrac: nTerms ? detected / nTerms : 0, nTerms: nTerms };
  }

  /** k近傍集合（d次元ユークリッド距離）。points: [{i,x,y,z}]。戻り値: i → Set(隣接i)。 */
  function kNearestSets(points, k) {
    var out = {};
    for (var a = 0; a < points.length; a++) {
      var dists = [];
      for (var b = 0; b < points.length; b++) {
        if (a === b) continue;
        var dx = points[a].x - points[b].x, dy = points[a].y - points[b].y, dz = (points[a].z || 0) - (points[b].z || 0);
        dists.push({ i: points[b].i, d: dx * dx + dy * dy + dz * dz });
      }
      dists.sort(function (p, q) { return p.d - q.d; });
      var set = {};
      for (var c = 0; c < Math.min(k, dists.length); c++) set[dists[c].i] = true;
      out[points[a].i] = set;
    }
    return out;
  }

  /** J*（近傍保存度）。zByI が無い個体（未検出）は S_rec の候補にも入らない。 */
  function computeJStar(state, zPredByI, k, N) {
    var truePts = []; for (var i = 0; i < N; i++) truePts.push({ i: i, x: state.x[i], y: state.y[i], z: state.z[i] });
    var trueSets = kNearestSets(truePts, k);
    var recPts = [];
    for (i = 0; i < N; i++) {
      if (zPredByI[i] == null) continue;
      recPts.push({ i: i, x: state.x[i], y: state.y[i], z: zPredByI[i] }); // x,yは厳密逆算できるので真値を使う
    }
    var recSets = recPts.length >= 2 ? kNearestSets(recPts, k) : {};
    var sumJ = 0;
    for (i = 0; i < N; i++) {
      var ts = trueSets[i], rs = recSets[i];
      if (!rs) { continue; } // 未検出個体自身は0（下でカウント済み扱い）
      var overlap = 0;
      Object.keys(ts).forEach(function (key) { if (rs[key]) overlap++; });
      sumJ += overlap / k;
    }
    var J = sumJ / N; // 未検出個体は overlap=0 として平均に入る（rsがない=加算されないがNで割るので0扱い）
    var chance = k / (N - 1);
    var Jstar = (J - chance) / (1 - chance);
    return Jstar;
  }

  /** 分極度 φ = |mean(単位速度)|。 */
  function polarization(vx, vy, vz, n) {
    var sx = 0, sy = 0, sz = 0;
    for (var i = 0; i < n; i++) {
      var s = Core.mag3(vx[i], vy[i], vz[i]);
      if (s < 1e-9) continue;
      sx += vx[i] / s; sy += vy[i] / s; sz += vz[i] / s;
    }
    return Core.mag3(sx, sy, sz) / n;
  }

  // ================================================================== エクスポート

  return {
    anchorsForArm: anchorsForArm,
    smoothY: smoothY, detectMarks: detectMarks, neighbourMarkCount: neighbourMarkCount, frameDisplacement: frameDisplacement,
    expandFeatures: expandFeatures, d1ExamplesForWindow: d1ExamplesForWindow,
    drawRecordsForArm: drawRecordsForArm, d2ExamplesForWindow: d2ExamplesForWindow,
    fitRidge: fitRidge, predictRidge: predictRidge, standardizeFit: standardizeFit, standardizeApply: standardizeApply, solveLinear: solveLinear,
    computeR: computeR, kNearestSets: kNearestSets, computeJStar: computeJStar, polarization: polarization
  };
});
