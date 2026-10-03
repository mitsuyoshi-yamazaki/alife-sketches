/**
 * S-72 の核。**格子の上の 2 値の規則 B3/S23 と、点ごとの札（tag）の受け渡しだけ**を書く。
 *
 * 規則（criteria.json system.lifeRule / ownership）:
 *   - 近傍は Moore の 8 点・同期更新・盤の外は常に空。
 *   - ある点が次に 1 になる条件: 今 1 で 1 の近傍がちょうど 2 か 3、または今 0 で 1 の近傍がちょうど 3。
 *     **この条件は札を見ない**（札は受け身のラベル。札を消した盤は素の B3/S23 と一致する。PC1）。
 *   - 札: 1 のまま残る点は札を保つ。0→1 になる点の札は、3 つの隣の札の多数。3 つが全て違えば札 NEUTRAL。
 *
 * **このファイルには「生きている」「死ぬ」「誕生」「プレイヤー」「敗退」などの語は無い。**
 * それらを語るのは game.js（審判・観測器）の仕事である。ここでは点が 1（on）か 0（off）か、札が何か、だけ。
 *
 * 性能のため、格子（Uint8Array）は**その場で書き換える**（ping-pong の 2 面）。これは古典的な CA エンジンの慣習で、
 * 外へ渡す記録（試合の行・要約）は新しいオブジェクトとして返す。
 *
 * 依存ゼロ・古典スクリプト。Node とブラウザで共用（Node: `require('./core.js')` / ブラウザ: `window.S72`）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S72 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** 札の値。0 = 空、1〜4 = 席の札、NEUTRAL = どの席のものでもない札。 */
  var NEUTRAL = 5;
  var NTAG = 8; // counts などの配列長（札 0〜7）

  // ------------------------------------------------------------------ 乱数・ハッシュ
  /** mulberry32。seed（uint32）から [0,1) の一様乱数列を作る。 */
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** 文字列 → uint32（FNV-1a）。系列の種は hash(シード, bot の id, 番号) をこれで作る。 */
  function hash32(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function hex8(n) { return ('00000000' + (n >>> 0).toString(16)).slice(-8); }

  /** 試合のハッシュへ 1 ティックの要約を畳み込む（順序つき）。 */
  function foldHash(h, v) {
    return (Math.imul((h ^ (v | 0)) >>> 0, 0x01000193) + 0x9E3779B9) >>> 0;
  }

  // ------------------------------------------------------------------ 面（1 ティック分の状態）
  var EMPTY_MIN = 32000;

  function Layer(w, h) {
    var sw = w + 2, sh = h + 2;
    this.tag = new Uint8Array(sw * sh);   // 札（0 = 空）
    this.bin = new Uint8Array(sw * sh);   // 0/1（近傍の数え上げ用）
    this.rowMin = new Int16Array(h).fill(EMPTY_MIN); // 行ごとの 1 の点の最小・最大の x（無ければ -1）
    this.rowMax = new Int16Array(h).fill(-1);
    this.yMin = h; this.yMax = -1; this.xMin = w; this.xMax = -1;
    this.counts = new Int32Array(NTAG);   // 札ごとの点の数
    this.lx0 = new Int16Array(NTAG).fill(EMPTY_MIN); // 札ごとの外接矩形
    this.lx1 = new Int16Array(NTAG).fill(-1);
    this.ly0 = new Int16Array(NTAG).fill(EMPTY_MIN);
    this.ly1 = new Int16Array(NTAG).fill(-1);
  }

  /** この面に残っている内容を消す（行の範囲だけ fill するので、盤が疎なら安い）。 */
  function clearLayer(L, w, h) {
    var sw = w + 2;
    if (L.yMax >= 0) {
      for (var y = L.yMin; y <= L.yMax; y++) {
        if (L.rowMax[y] >= 0) {
          var base = (y + 1) * sw + 1;
          L.tag.fill(0, base + L.rowMin[y], base + L.rowMax[y] + 1);
          L.bin.fill(0, base + L.rowMin[y], base + L.rowMax[y] + 1);
          L.rowMin[y] = EMPTY_MIN; L.rowMax[y] = -1;
        }
      }
    }
    L.yMin = h; L.yMax = -1; L.xMin = w; L.xMax = -1;
    L.counts.fill(0);
    L.lx0.fill(EMPTY_MIN); L.lx1.fill(-1); L.ly0.fill(EMPTY_MIN); L.ly1.fill(-1);
  }

  // ------------------------------------------------------------------ Sim
  /**
   * 1 枚の盤の時間発展。
   *   cur = 今の面、alt = 次の面（ping-pong）。step() で cur が進む。
   *   窓の判定のため、毎ティック札の面の写し（snapshot）を長さ ringCap の輪へ取る。
   */
  function Sim(w, h, ringCap) {
    this.w = w; this.h = h; this.sw = w + 2;
    this.cur = new Layer(w, h);
    this.alt = new Layer(w, h);
    this.ringCap = ringCap | 0;
    this.ring = [];
    for (var k = 0; k < this.ringCap; k++) this.ring.push(new Uint8Array((w + 2) * (h + 2)));
    this.ringBox = new Int16Array(Math.max(1, this.ringCap) * 4);
    this.ringN = 0; // これまでに取った写しの数（輪が一周しても増え続ける）
    this.cnt8 = new Int32Array(NTAG);
    this.resetStats();
  }

  Sim.prototype.resetStats = function () {
    this.births = 0;      // 0→1 になった点の総数
    this.mixed = 0;       // うち、3 つの隣に席の札が 2 種類以上あったもの
    this.ties = 0;        // うち、3 つの隣の札が全て違ったもの（札 NEUTRAL になる）
    this.neutralBirths = 0; // うち、札 NEUTRAL で生まれたもの
    this.hsum = 0;        // 直近のティックの盤の要約（順序に依らない和）
  };

  /** 盤を空にして、写しの輪と統計も初期化する。 */
  Sim.prototype.reset = function () {
    clearLayer(this.cur, this.w, this.h);
    clearLayer(this.alt, this.w, this.h);
    this.ringN = 0;
    this.resetStats();
  };

  /** 点 (x, y) の札を値 t にする（0 で空にする）。**盤の内側だけ**。範囲外は無視して false。 */
  Sim.prototype.set = function (x, y, t) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return false;
    var L = this.cur, i = (y + 1) * this.sw + x + 1, old = L.tag[i];
    if (old === t) return true;
    if (old) {
      L.counts[old]--;
      L.tag[i] = 0; L.bin[i] = 0;
    }
    if (t) {
      L.tag[i] = t; L.bin[i] = 1; L.counts[t]++;
      if (x < L.rowMin[y]) L.rowMin[y] = x;
      if (x > L.rowMax[y]) L.rowMax[y] = x;
      if (y < L.yMin) L.yMin = y; if (y > L.yMax) L.yMax = y;
      if (x < L.xMin) L.xMin = x; if (x > L.xMax) L.xMax = x;
      if (x < L.lx0[t]) L.lx0[t] = x; if (x > L.lx1[t]) L.lx1[t] = x;
      if (y < L.ly0[t]) L.ly0[t] = y; if (y > L.ly1[t]) L.ly1[t] = y;
    }
    return true;
  };

  Sim.prototype.get = function (x, y) {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return 0;
    return this.cur.tag[(y + 1) * this.sw + x + 1];
  };

  /** 札 from の点を全て札 to にする（盤の時間発展は変わらない。札は受け身だから）。 */
  Sim.prototype.relabel = function (from, to) {
    var L = this.cur, sw = this.sw;
    if (L.counts[from] === 0 || from === to) return 0;
    var n = 0;
    for (var y = L.yMin; y <= L.yMax; y++) {
      if (L.rowMax[y] < 0) continue;
      var base = (y + 1) * sw + 1;
      for (var x = L.rowMin[y]; x <= L.rowMax[y]; x++) {
        if (L.tag[base + x] === from) {
          L.tag[base + x] = to; n++;
          if (x < L.lx0[to]) L.lx0[to] = x; if (x > L.lx1[to]) L.lx1[to] = x;
          if (y < L.ly0[to]) L.ly0[to] = y; if (y > L.ly1[to]) L.ly1[to] = y;
        }
      }
    }
    L.counts[to] += n; L.counts[from] = 0;
    L.lx0[from] = EMPTY_MIN; L.lx1[from] = -1; L.ly0[from] = EMPTY_MIN; L.ly1[from] = -1;
    return n;
  };

  /** 他の Sim の今の面をそのまま写し取る（B7 の盤の写し・viewer の表示用）。写しの輪は空に戻る。 */
  Sim.prototype.copyFrom = function (o) {
    var a = this.cur, b = o.cur;
    a.tag.set(b.tag); a.bin.set(b.bin);
    a.rowMin.set(b.rowMin); a.rowMax.set(b.rowMax);
    a.yMin = b.yMin; a.yMax = b.yMax; a.xMin = b.xMin; a.xMax = b.xMax;
    a.counts.set(b.counts);
    a.lx0.set(b.lx0); a.lx1.set(b.lx1); a.ly0.set(b.ly0); a.ly1.set(b.ly1);
    this.ringN = 0;
    this.resetStats();
  };

  /** 1 ティック進める。 */
  Sim.prototype.step = function () {
    var src = this.cur, dst = this.alt;
    var w = this.w, h = this.h, sw = this.sw;
    clearLayer(dst, w, h);
    var sTag = src.tag, sBin = src.bin, dTag = dst.tag, dBin = dst.bin;
    var rMin = src.rowMin, rMax = src.rowMax, dMin = dst.rowMin, dMax = dst.rowMax;
    var counts = dst.counts, lx0 = dst.lx0, lx1 = dst.lx1, ly0 = dst.ly0, ly1 = dst.ly1;
    var cnt8 = this.cnt8;
    var births = 0, mixed = 0, ties = 0, neutralBirths = 0, hs = 0;
    var yMinN = h, yMaxN = -1, xMinN = w, xMaxN = -1;
    if (src.yMax >= 0) {
      var ya = src.yMin > 0 ? src.yMin - 1 : 0, yb = src.yMax < h - 1 ? src.yMax + 1 : h - 1;
      for (var y = ya; y <= yb; y++) {
        var xa = EMPTY_MIN, xb = -1;
        for (var r = y - 1; r <= y + 1; r++) {
          if (r < 0 || r >= h) continue;
          if (rMax[r] >= 0) { if (rMin[r] < xa) xa = rMin[r]; if (rMax[r] > xb) xb = rMax[r]; }
        }
        if (xb < 0) continue;
        xa = xa > 0 ? xa - 1 : 0; xb = xb < w - 1 ? xb + 1 : w - 1;
        var i = (y + 1) * sw + xa + 1;
        var first = -1, last = -1;
        for (var x = xa; x <= xb; x++, i++) {
          var n = sBin[i - sw - 1] + sBin[i - sw] + sBin[i - sw + 1] + sBin[i - 1] + sBin[i + 1] +
            sBin[i + sw - 1] + sBin[i + sw] + sBin[i + sw + 1];
          var t;
          if (n === 3) {
            if (sBin[i] === 1) {
              t = sTag[i];
            } else {
              // 0→1。3 つの隣の札の多数で決める
              cnt8.fill(0);
              cnt8[sTag[i - sw - 1]]++; cnt8[sTag[i - sw]]++; cnt8[sTag[i - sw + 1]]++; cnt8[sTag[i - 1]]++;
              cnt8[sTag[i + 1]]++; cnt8[sTag[i + sw - 1]]++; cnt8[sTag[i + sw]]++; cnt8[sTag[i + sw + 1]]++;
              t = 0;
              var kinds = 0;
              for (var L = 1; L <= NEUTRAL; L++) {
                var q = cnt8[L];
                if (q >= 2) t = L;
                if (q > 0 && L < NEUTRAL) kinds++;
              }
              births++;
              if (kinds >= 2) mixed++;
              if (t === 0) { t = NEUTRAL; ties++; }
              if (t === NEUTRAL) neutralBirths++;
            }
          } else if (n === 2 && sBin[i] === 1) {
            t = sTag[i];
          } else continue;
          dTag[i] = t; dBin[i] = 1; counts[t]++;
          if (first < 0) first = x;
          last = x;
          if (x < lx0[t]) lx0[t] = x; if (x > lx1[t]) lx1[t] = x;
          if (y < ly0[t]) ly0[t] = y; if (y > ly1[t]) ly1[t] = y;
          hs = (hs + Math.imul(((y * w + x) << 3) + t + 1, 0x9E3779B1)) | 0;
        }
        if (first >= 0) {
          dMin[y] = first; dMax[y] = last;
          if (y < yMinN) yMinN = y; yMaxN = y;
          if (first < xMinN) xMinN = first; if (last > xMaxN) xMaxN = last;
        }
      }
    }
    dst.yMin = yMinN; dst.yMax = yMaxN; dst.xMin = xMinN; dst.xMax = xMaxN;
    this.cur = dst; this.alt = src;
    this.births += births; this.mixed += mixed; this.ties += ties; this.neutralBirths += neutralBirths;
    this.hsum = hs >>> 0;
    if (this.ringCap > 0) this.snapshot();
  };

  /** 今の札の面を写しの輪へ取る。 */
  Sim.prototype.snapshot = function () {
    var k = this.ringN % this.ringCap, L = this.cur;
    this.ring[k].set(L.tag);
    var o = k * 4;
    if (L.yMax >= 0) { this.ringBox[o] = L.xMin; this.ringBox[o + 1] = L.xMax; this.ringBox[o + 2] = L.yMin; this.ringBox[o + 3] = L.yMax; }
    else { this.ringBox[o] = 0; this.ringBox[o + 1] = -1; this.ringBox[o + 2] = 0; this.ringBox[o + 3] = -1; }
    this.ringN++;
  };

  /** 輪の中の直近 n 枚（古い順）の写しと、その外接矩形の和。n が足りなければ null。 */
  Sim.prototype.lastSnapshots = function (n) {
    if (n > this.ringCap || this.ringN < n) return null;
    var snaps = [], x0 = this.w, x1 = -1, y0 = this.h, y1 = -1;
    for (var j = this.ringN - n; j < this.ringN; j++) {
      var k = j % this.ringCap, o = k * 4;
      snaps.push(this.ring[k]);
      if (this.ringBox[o + 1] >= this.ringBox[o]) {
        if (this.ringBox[o] < x0) x0 = this.ringBox[o]; if (this.ringBox[o + 1] > x1) x1 = this.ringBox[o + 1];
        if (this.ringBox[o + 2] < y0) y0 = this.ringBox[o + 2]; if (this.ringBox[o + 3] > y1) y1 = this.ringBox[o + 3];
      }
    }
    return { snaps: snaps, x0: x0, x1: x1, y0: y0, y1: y1 };
  };

  // ------------------------------------------------------------------ 窓の周期判定
  /**
   * 窓（n 枚の写し）の中で一度でも札 L が載った点 c の全てについて、c の札の列が周期 p ≤ Pmax で繰り返すかを調べる。
   * 点 c が周期 p で繰り返す ⇔ 窓の中の t と t + p がともに窓に入るすべての t で、c の札が等しい。
   * （criteria.json system.elimination.periodic。W = 2·Pmax のとき、窓の中で 1 回だけ 1 になった点はどの p でも繰り返さない）
   *
   * 返り値（札 1〜NEUTRAL ごとの配列。長さ NTAG）:
   *   owned    = 窓の中で一度でも札 L が載った点の数
   *   np       = そのうち、周期 p ≤ Pmax で繰り返さない点の数（所属込みの状態＝札で見る。F3 の主の読み）
   *   npAlive  = 同じ点を、札を無視して 1/0 だけで見たときの、繰り返さない点の数（F3 の副の読み。判定には使わない）
   * 札 L の持ち主が「全てのセルが周期」⇔ owned[L] > 0 かつ np[L] === 0。
   */
  function analyzeWindow(win, w, Pmax) {
    var owned = new Int32Array(NTAG), np = new Int32Array(NTAG), npAlive = new Int32Array(NTAG);
    var out = { owned: owned, np: np, npAlive: npAlive, n: 0, pmax: Pmax };
    if (!win) return out;
    var snaps = win.snaps, n = snaps.length, sw = w + 2;
    out.n = n;
    var pm = Math.min(Pmax, n - 1);
    var s0 = snaps[0];
    for (var y = win.y0; y <= win.y1; y++) {
      for (var x = win.x0; x <= win.x1; x++) {
        var i = (y + 1) * sw + x + 1;
        var mask = 0, constant = true, f = s0[i];
        for (var k = 0; k < n; k++) {
          var v = snaps[k][i];
          if (v) mask |= (1 << v);
          if (v !== f) constant = false;
        }
        if (mask === 0) continue;
        var L;
        for (L = 1; L < NTAG; L++) if (mask & (1 << L)) owned[L]++;
        if (constant) continue;
        var per = false;
        for (var p = 2; p <= pm && !per; p++) {
          var ok = true;
          for (var k2 = 0; k2 + p < n; k2++) if (snaps[k2][i] !== snaps[k2 + p][i]) { ok = false; break; }
          if (ok) per = true;
        }
        if (per) continue;
        for (L = 1; L < NTAG; L++) if (mask & (1 << L)) np[L]++;
        // 札を無視した読み: 1/0 の列が周期か
        var perA = false;
        for (var pa = 1; pa <= pm && !perA; pa++) {
          var okA = true;
          for (var k3 = 0; k3 + pa < n; k3++) if ((snaps[k3][i] !== 0) !== (snaps[k3 + pa][i] !== 0)) { okA = false; break; }
          if (okA) perA = true;
        }
        if (!perA) for (L = 1; L < NTAG; L++) if (mask & (1 << L)) npAlive[L]++;
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ 札の近接
  /**
   * 札 a の点と札 b の点が Chebyshev 距離 d 以下になっているか（a ≠ b）。
   * 距離 2 以下 ⇔ ある 1 つの点の 3×3 近傍に両者の点が入る ⇔ 両者の時間発展が結合しうる。
   * 札ごとの外接矩形で先に絞る（外接矩形が d より離れていれば走査しない）。
   */
  function tagsWithin(sim, a, b, d) {
    var L = sim.cur;
    if (L.counts[a] === 0 || L.counts[b] === 0) return false;
    // b の外接矩形を a の外接矩形（d だけ広げたもの）と交差させた範囲だけを調べる
    var x0 = Math.max(L.lx0[b], L.lx0[a] - d), x1 = Math.min(L.lx1[b], L.lx1[a] + d);
    var y0 = Math.max(L.ly0[b], L.ly0[a] - d), y1 = Math.min(L.ly1[b], L.ly1[a] + d);
    if (x0 > x1 || y0 > y1) return false;
    var sw = sim.sw, tag = L.tag, w = sim.w, h = sim.h;
    for (var y = y0; y <= y1; y++) {
      var base = (y + 1) * sw + 1;
      for (var x = x0; x <= x1; x++) {
        if (tag[base + x] !== b) continue;
        var ya = y - d < 0 ? 0 : y - d, yb = y + d >= h ? h - 1 : y + d;
        var xa = x - d < 0 ? 0 : x - d, xb = x + d >= w ? w - 1 : x + d;
        for (var yy = ya; yy <= yb; yy++) {
          var bb = (yy + 1) * sw + 1;
          for (var xx = xa; xx <= xb; xx++) if (tag[bb + xx] === a) return true;
        }
      }
    }
    return false;
  }

  return {
    NEUTRAL: NEUTRAL, NTAG: NTAG, Sim: Sim, analyzeWindow: analyzeWindow, tagsWithin: tagsWithin,
    rng: rng, hash32: hash32, hex8: hex8, foldHash: foldHash,
  };
});
