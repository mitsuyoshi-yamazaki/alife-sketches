/**
 * S-23 の核。L×L の格子の各点が 9 個の実数を持ち、**自分と 3×3 の近傍だけ**を読んで更新する。
 *
 * このファイルが知っているのは次だけである:
 *
 *   チャネル  a 占有 / u 場A / v 場B / p 印A（u の放出点）/ q 印B（v の放出点）
 *             m 記憶（最後に更新したときの信号）/ d 記憶（正規化した u−v の遅い写し）
 *             c 種別（読み出した色 1..K）/ z 縁で境界値を与えられた調和場
 *
 *   1 ステップ: 全点が同期に、確率 fireRate で更新される（更新されない点は状態を保つ）。
 *   更新後、3×3 に a > hi（既定 0.1）の点が無い点は全チャネルを 0 にする（masking）。
 *
 *   規則（rule）は手で書いた式で、学習は無い:
 *     grad     … 印が場を放出し、場は 9 点ラプラシアンで拡散し減衰する。占有は場の合計で決まる
 *     gradW    … grad ＋ 信号が下がった局所極大が新しい印になる／信号が下がりつつ片方の場しか無くなった縁が反対の印になる
 *     gradRim  … grad ＋ 縁が自分の正規化座標を調和場 z の境界値として置き、内部が z を補間する
 *     hop      … 印からの到達回数（Moore 近傍なのでチェビシェフ距離）で占有と種別を決める
 *     hopW     … hop ＋ 到達回数が増えた弱い局所極小が新しい印になる
 *     coord    … **参照点**。各点が自分の座標を読み、与えられた絵をそのまま塗る（局所性を持たない）
 *     random   … **参照点**。占有も種別も乱択
 *     edenClock… **対照**。隣接点が確率 g で占有され、時刻を近傍から写し取って t_stop で止まる
 *
 *   読み出し（readout）は種別 c の決め方: mask / band / dipole / harmonic。
 *
 * このファイルには「細胞」「生存」「再生」「形態形成」という語も概念も無い。あるのは格子点・場・印・
 * 占有・種別だけで、目標の形と比べる仕事は stats.js と targets.js の側にある。
 *
 * 依存ゼロ。Node（生ログ生成）とブラウザ（可視化）が同じファイルを読む。
 *
 * 出典（アイデアのみ。コードは参照していない）:
 *   Mordvintsev, Randazzo, Niklasson & Levin (2020) "Growing Neural Cellular Automata", Distill.
 *   借りたのは ①少数の実数チャネル ②α > 0.1 と 3×3 の masking ③確率 0.5 の更新 ④損傷は領域を 0 にする、の 4 点。
 *   更新則そのものは原典では学習で得るが、ここでは手で書く。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S23 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 乱数（mulberry32。状態を明示的に持つので複製できる）
   * ------------------------------------------------------------------ */

  function rngNext(st) {
    st.a = (st.a + 0x6D2B79F5) | 0;
    var t = Math.imul(st.a ^ (st.a >>> 15), 1 | st.a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  function makeRngState(seed) { return { a: (seed >>> 0) || 1 }; }
  /** 閉じた乱数（他のファイルの検査用）。 */
  function makeRng(seed) { var st = makeRngState(seed); return function () { return rngNext(st); }; }

  /* ------------------------------------------------------------------ *
   * チャネルと既定値
   * ------------------------------------------------------------------ */

  var CH = { a: 0, u: 1, v: 2, p: 3, q: 4, m: 5, d: 6, c: 7, z: 8 };
  var NCH = 9;

  var DEFAULTS = {
    L: 64,
    rule: 'grad',        // grad | gradW | gradRim | hop | hopW | coord | random | edenClock
    readout: 'mask',     // mask | band | dipole | harmonic
    fireRate: 0.5,       // 各点が 1 ステップに更新される確率
    rngSeed: 1,
    mask: true,          // 3×3 に a > hi が無い点を 0 にする
    wrap: false,         // 周期境界（恒等式の検査用。既定はゼロ詰め）
    hi: 0.1,             // 「占有」と見なす a の閾値（原典の 0.1）
    // grad 系
    D: 0.25,             // 場の拡散（9 点ラプラシアン。D ≤ 0.3 で安定）
    k: 0.015625,         // 場の減衰（λ = √(D/k) = 4）
    E: 0.05,             // 放出の総量。印が 2 つなら各 E/2（u += (E/印の数)·p）
    thetaG: 0.0006,      // 場の合計がこれを超えたら占有が増える（試走で半径 11・437 点に合わせた）
    thetaD: 0.00036,     // これを下回ったら占有が減る（ヒステリシス。θg の 0.6 倍）
    ga: 0.5, gd: 0.5,    // 占有の増減幅
    bandLo: 0.0009, bandHi: 0.005, // band 読み出し: bandLo < s < bandHi を種別 2（試走で径 7〜11 に合わせた）
    delta: 0.08,         // dipole 読み出し: |dn| ≤ delta を種別 2（試走の掃引で最良。上限は 0.61 だった）
    tauM: 0.2,           // 記憶 m は信号 s の指数平均（極大の判定を更新の揺らぎから守る）
    dropRel: 0.005,      // W: 信号が記憶より この割合 以上 下がったら「下がった」
    poleD: 0.8,          // W: 正規化座標 |dn| がこれを超え（片方の場しか無い）
    poleGap: 0.5,        // W: かつ記憶 d との差がこれを超える縁は、反対の印を立てる（二原点のみ）
    tau: 0.01,           // d の遅い追随（失った側を覚えておくため、場の減衰より遅くする）
    Dz: 0.25,            // gradRim: 調和場の拡散
    deltaZ: 0.06,        // harmonic 読み出し: |z| ≤ deltaZ を種別 2（縁の z の振幅 0.15 × 4.5/11 の幾何から）
    // hop 系
    Rh: 12,              // 到達回数がこれ以下なら占有
    hLo: 7, hHi: 11,     // band 読み出し
    // edenClock
    g: 0.1, tStop: 40,   // 試走で面積の中央値が 463（目標 441）になる組
    // coord
    speed: 1,            // 中心から広がる速さ（見た目のため）
    paint: null,         // Uint8Array(L*L) の絵（0 は空、1..K）
    K: 1,                // 種別の数
    origins: null,       // [[x, y, 'p'|'q'], ...]。null なら中央（二原点の読み出しなら中央と右隣）
  };

  function twoOrigins(readout) { return readout === 'dipole' || readout === 'harmonic'; }

  /* ------------------------------------------------------------------ *
   * 世界
   * ------------------------------------------------------------------ */

  /** 3×3 の近傍表。j = 0..8（行優先、4 が自分）。外側は −1（wrap なら巻く）。 */
  function neighbourTable(L, wrap) {
    var n = L * L, nb = new Int32Array(n * 9);
    for (var y = 0; y < L; y++) {
      for (var x = 0; x < L; x++) {
        var i = y * L + x, j = 0;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++, j++) {
            var xx = x + dx, yy = y + dy;
            if (wrap) { xx = (xx + L) % L; yy = (yy + L) % L; nb[i * 9 + j] = yy * L + xx; }
            else nb[i * 9 + j] = (xx < 0 || yy < 0 || xx >= L || yy >= L) ? -1 : yy * L + xx;
          }
        }
      }
    }
    return nb;
  }

  /** 9 点ラプラシアンの重み（/6 は後で掛ける）。角 1・辺 4・中心 −20。 */
  var LAPW = [1, 4, 1, 4, -20, 4, 1, 4, 1];

  function createWorld(opts) {
    var o = {};
    for (var k in DEFAULTS) o[k] = DEFAULTS[k];
    if (opts) for (var k2 in opts) if (opts[k2] !== undefined) o[k2] = opts[k2];
    var L = o.L, n = L * L;
    var W = {
      par: o, L: L, n: n, t: 0,
      rule: o.rule, readout: o.readout,
      cur: new Float64Array(NCH * n), nxt: new Float64Array(NCH * n),
      nb: neighbourTable(L, o.wrap),
      rng: makeRngState(o.rngSeed),
      fire: new Uint8Array(n), r1: new Float64Array(n), r2: new Float64Array(n),
      cx: L >> 1, cy: L >> 1,
      origins: null,
    };
    var org = o.origins;
    if (!org) {
      org = [[W.cx, W.cy, 'p']];
      if (twoOrigins(o.readout)) org.push([W.cx + 1, W.cy, 'q']);
    }
    W.origins = org;
    W.Eper = o.E / org.length;
    for (var r = 0; r < org.length; r++) {
      var i = org[r][1] * L + org[r][0];
      W.cur[CH.a * n + i] = 1;
      W.cur[(org[r][2] === 'q' ? CH.q : CH.p) * n + i] = 1;
      W.cur[CH.c * n + i] = 1;
    }
    return W;
  }

  /** 世界の複製（乱数の状態も含む）。損傷の腕を同じ成長から分岐させるために使う。 */
  function cloneWorld(W) {
    var C = {};
    for (var k in W) C[k] = W[k];
    C.par = W.par;
    C.cur = Float64Array.from(W.cur); C.nxt = new Float64Array(W.nxt.length);
    C.rng = { a: W.rng.a };
    C.fire = new Uint8Array(W.n); C.r1 = new Float64Array(W.n); C.r2 = new Float64Array(W.n);
    return C;
  }

  function channel(W, name) { return W.cur.subarray(CH[name] * W.n, (CH[name] + 1) * W.n); }

  /* ------------------------------------------------------------------ *
   * 1 ステップ
   * ------------------------------------------------------------------ */

  /**
   * 乱数は状態に依らず毎ステップ同じ数だけ引く（点ごとに fire・r1・r2）。
   * こうしておくと、損傷した世界と損傷しない世界が同じ乱数列を消費し、K-36 の盤面比較ができる。
   */
  function drawRandoms(W) {
    var n = W.n, f = W.par.fireRate, rng = W.rng;
    if (f >= 1) { for (var i = 0; i < n; i++) W.fire[i] = 1; }
    else { for (var i2 = 0; i2 < n; i2++) W.fire[i2] = rngNext(rng) < f ? 1 : 0; }
    if (W.rule === 'random' || W.rule === 'edenClock') {
      for (var i3 = 0; i3 < n; i3++) { W.r1[i3] = rngNext(rng); W.r2[i3] = rngNext(rng); }
    }
  }

  /** 更新後の masking: 3×3 に a > hi が無い点は全チャネルを 0 にする。 */
  function applyMask(W, arr) {
    var n = W.n, nb = W.nb, hi = W.par.hi, aOff = CH.a * n;
    var keep = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var mx = 0;
      for (var j = 0; j < 9; j++) { var idx = nb[i * 9 + j]; if (idx >= 0 && arr[aOff + idx] > mx) mx = arr[aOff + idx]; }
      keep[i] = mx > hi ? 1 : 0;
    }
    for (var c = 0; c < NCH; c++) {
      var off = c * n;
      for (var i2 = 0; i2 < n; i2++) if (!keep[i2]) arr[off + i2] = 0;
    }
  }

  function copySite(cur, nxt, n, i) {
    for (var c = 0; c < NCH; c++) nxt[c * n + i] = cur[c * n + i];
  }

  /** 1 点の更新。cur を読み nxt[*, i] を書く。近傍は nb から引く（外側は 0）。 */
  function updateSite(W, cur, nxt, i) {
    var n = W.n, nb = W.nb, P = W.par, hi = P.hi, base = i * 9;
    var aOff = 0, uOff = n, vOff = 2 * n, pOff = 3 * n, qOff = 4 * n, mOff = 5 * n, dOff = 6 * n, cOff = 7 * n, zOff = 8 * n;
    var rule = W.rule, readout = W.readout;
    var a0 = cur[aOff + i], u0 = cur[uOff + i], v0 = cur[vOff + i];
    var p0 = cur[pOff + i], q0 = cur[qOff + i], m0 = cur[mOff + i], d0 = cur[dOff + i], z0 = cur[zOff + i];
    var occupied = a0 > hi;
    var a2 = a0, u2 = u0, v2 = v0, p2 = p0, q2 = q0, m2 = m0, d2 = d0, c2 = cur[cOff + i], z2 = z0;

    // 近傍の集計（自分を含む/含まない を分けて持つ）
    var aMax = 0, emptyNb = false, lapU = 0, lapV = 0, lapZ = 0, sMaxNb = -1;
    var minHA = Infinity, minHB = Infinity, minHOldNb = Infinity, maxAge = -1, maxAgeOcc = false, emitterNb = false, mMaxNb = -1;
    for (var j = 0; j < 9; j++) {
      var idx = nb[base + j];
      if (idx < 0) { emptyNb = true; continue; }
      var aj = cur[aOff + idx], uj = cur[uOff + idx], vj = cur[vOff + idx];
      if (aj > aMax) aMax = aj;
      if (aj <= hi) emptyNb = true;
      lapU += LAPW[j] * uj; lapV += LAPW[j] * vj; lapZ += LAPW[j] * cur[zOff + idx];
      if (j !== 4) {
        if (cur[pOff + idx] > 0 || cur[qOff + idx] > 0) emitterNb = true;
        if (uj + vj > sMaxNb) sMaxNb = uj + vj;
        if (cur[mOff + idx] > mMaxNb) mMaxNb = cur[mOff + idx];
        if (aj > hi) {
          if (uj < minHA) minHA = uj;
          if (vj < minHB) minHB = vj;
          var mj = cur[mOff + idx];
          if (mj < minHOldNb) minHOldNb = mj;
          if (uj > maxAge) { maxAge = uj; maxAgeOcc = true; }
        }
      }
    }
    var gate = aMax > hi;

    if (rule === 'grad' || rule === 'gradW' || rule === 'gradRim') {
      var wound = rule !== 'grad';
      u2 = u0 + P.D * lapU / 6 - P.k * u0 + W.Eper * p0; if (u2 < 0) u2 = 0;
      v2 = v0 + P.D * lapV / 6 - P.k * v0 + W.Eper * q0; if (v2 < 0) v2 = 0;
      var s = u2 + v2, s0 = u0 + v0;
      if (gate) {
        if (s > P.thetaG) { a2 = a0 + P.ga; if (a2 > 1) a2 = 1; }
        else if (s < P.thetaD) { a2 = a0 - P.gd; if (a2 < 0) a2 = 0; }
      }
      var dn = s > 1e-12 ? (u2 - v2) / s : 0;
      var two = twoOrigins(readout);
      if (wound && occupied && p0 === 0 && q0 === 0 && !emitterNb) {
        // 信号が記憶（指数平均）より割合で下がり、かつ自分の記憶が近傍の記憶の厳密な極大 → 新しい印
        // （二原点なら記憶した側の印）。瞬時値でなく記憶で極大を判定するのは、確率的な更新で
        // 縁の瞬時値が荒れ、隣どうしが交互に極大になるのを避けるため。3×3 に印があれば立てない
        if (s < m0 * (1 - P.dropRel) && s > P.thetaD && m0 > mMaxNb) {
          if (two) { if (d0 >= 0) p2 = 1; else q2 = 1; } else p2 = 1;
        }
        // 二原点: 信号が下がっている縁で、正規化座標が記憶から大きく離れて片方の場しか無くなった
        // → 反対の印を立てる。「下がっている」の条件が、成長の初期に片方の場だけが先に届く過渡を除く
        if (two && emptyNb && s < m0 && Math.abs(dn - d0) > P.poleGap && Math.abs(dn) > P.poleD) {
          if (dn > 0) q2 = 1; else p2 = 1;
        }
      }
      m2 = m0 + P.tauM * (s - m0);
      d2 = d0 + P.tau * (dn - d0);
      if (rule === 'gradRim') {
        var rim = occupied && emptyNb;
        z2 = rim ? dn : z0 + P.Dz * lapZ / 6;
      }
      if (readout === 'mask') c2 = 1;
      else if (readout === 'band') c2 = (s > P.bandLo && s < P.bandHi) ? 2 : 1;
      else if (readout === 'dipole') c2 = dn > P.delta ? 1 : (dn < -P.delta ? 3 : 2);
      else if (readout === 'harmonic') c2 = z2 > P.deltaZ ? 1 : (z2 < -P.deltaZ ? 3 : 2);
    } else if (rule === 'hop' || rule === 'hopW') {
      var twoH = twoOrigins(readout);
      var hA = p0 > 0 ? 0 : (minHA < Infinity ? minHA + 1 : u0);
      var hB = q0 > 0 ? 0 : (minHB < Infinity ? minHB + 1 : v0);
      if (!twoH) hB = hA;
      var h = hA < hB ? hA : hB;
      u2 = hA; v2 = hB;
      if (gate) {
        if (h <= P.Rh) { a2 = a0 + P.ga; if (a2 > 1) a2 = 1; }
        else { a2 = a0 - P.gd; if (a2 < 0) a2 = 0; }
      }
      if (rule === 'hopW' && occupied && p0 === 0 && q0 === 0 && !emitterNb) {
        var hOld = twoH ? (u0 < v0 ? u0 : v0) : u0;
        // 到達回数が増え（支えを失い）、かつ前回の値が近傍の占有点の中で最小以下（弱い極小）→ 新しい印
        if (h > m0 + 0.5 && hOld <= minHOldNb) { p2 = 1; u2 = 0; if (!twoH) { v2 = 0; } h = 0; }
      }
      m2 = h;
      if (readout === 'mask') c2 = 1;
      else if (readout === 'band') c2 = (h >= P.hLo && h <= P.hHi) ? 2 : 1;
      else if (readout === 'dipole') { var dd = hA - hB; c2 = dd <= -1 ? 1 : (dd >= 1 ? 3 : 2); }
    } else if (rule === 'coord') {
      var L = W.L, x = i % L, y = (i / L) | 0;
      var dx = x - W.cx, dy = y - W.cy, R = W.t * P.speed;
      var lab = P.paint ? P.paint[i] : 0;
      if (lab > 0 && dx * dx + dy * dy <= R * R) { a2 = 1; c2 = lab; } else { a2 = 0; c2 = 0; }
    } else if (rule === 'random') {
      if (gate) { a2 = W.r1[i] < 0.5 ? 1 : 0; c2 = 1 + Math.floor(W.r2[i] * P.K); }
    } else if (rule === 'edenClock') {
      c2 = 1;
      if (occupied) { u2 = u0 + 1; }
      else if (gate && maxAgeOcc && maxAge < P.tStop && W.r1[i] < P.g) { a2 = 1; u2 = maxAge; }
    }

    nxt[aOff + i] = a2; nxt[uOff + i] = u2; nxt[vOff + i] = v2; nxt[pOff + i] = p2; nxt[qOff + i] = q2;
    nxt[mOff + i] = m2; nxt[dOff + i] = d2; nxt[cOff + i] = c2; nxt[zOff + i] = z2;
  }

  function stepWorld(W) {
    drawRandoms(W);
    var cur = W.cur, nxt = W.nxt, n = W.n, fire = W.fire;
    for (var i = 0; i < n; i++) {
      if (fire[i]) updateSite(W, cur, nxt, i); else copySite(cur, nxt, n, i);
    }
    if (W.par.mask) applyMask(W, nxt);
    W.cur = nxt; W.nxt = cur;
    W.t++;
    return W;
  }

  /**
   * 素朴版（近道の検算用・K-12）。近傍表を使わず (x, y) の境界を毎回調べ、
   * 状態をまるごと複製してから書く。乱数は同じ列を同じ順に引く。
   */
  function stepWorldNaive(W) {
    drawRandoms(W);
    var L = W.L, n = W.n, wrap = W.par.wrap;
    var nbSaved = W.nb;
    // 近傍表を毎回作り直す（表の誤りを検出するため、別経路で作る）
    var nb = new Int32Array(n * 9);
    for (var i = 0; i < n; i++) {
      var x = i % L, y = (i / L) | 0, j = 0;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++, j++) {
        var xx = x + dx, yy = y + dy;
        if (wrap) { xx = ((xx % L) + L) % L; yy = ((yy % L) + L) % L; nb[i * 9 + j] = yy * L + xx; }
        else nb[i * 9 + j] = (xx >= 0 && yy >= 0 && xx < L && yy < L) ? yy * L + xx : -1;
      }
    }
    W.nb = nb;
    var cur = Float64Array.from(W.cur), nxt = new Float64Array(NCH * n);
    for (var i2 = 0; i2 < n; i2++) {
      if (W.fire[i2]) updateSite(W, cur, nxt, i2); else copySite(cur, nxt, n, i2);
    }
    if (W.par.mask) applyMask(W, nxt);
    W.nb = nbSaved;
    W.cur = nxt; W.nxt = new Float64Array(NCH * n);
    W.t++;
    return W;
  }

  /* ------------------------------------------------------------------ *
   * 損傷（領域の全チャネルを 0 にする。原典の damage と同じ形）
   * ------------------------------------------------------------------ */

  function eraseColumns(W, x0, x1) {
    var L = W.L, n = W.n;
    for (var y = 0; y < L; y++) for (var x = Math.max(0, x0); x <= Math.min(L - 1, x1); x++) {
      var i = y * L + x;
      for (var c = 0; c < NCH; c++) W.cur[c * n + i] = 0;
    }
    return W;
  }

  function eraseCircle(W, cx, cy, r) {
    var L = W.L, n = W.n, r2 = r * r;
    for (var y = 0; y < L; y++) for (var x = 0; x < L; x++) {
      var dx = x - cx, dy = y - cy;
      if (dx * dx + dy * dy <= r2) { var i = y * L + x; for (var c = 0; c < NCH; c++) W.cur[c * n + i] = 0; }
    }
    return W;
  }

  /* ------------------------------------------------------------------ *
   * 集計・ハッシュ・恒等式
   * ------------------------------------------------------------------ */

  /** FNV-1a を 2 本（種を変えて）並べた 16 桁の 16 進。 */
  function hashBytes(bytes) {
    var h1 = 2166136261, h2 = 0x9747b28c;
    for (var i = 0; i < bytes.length; i++) {
      h1 ^= bytes[i]; h1 = Math.imul(h1, 16777619);
      h2 ^= bytes[i]; h2 = Math.imul(h2, 0x01000193) ^ (h2 >>> 13);
    }
    return ((h1 >>> 0).toString(16).padStart(8, '0')) + ((h2 >>> 0).toString(16).padStart(8, '0'));
  }

  /** 全チャネルの生のビット列のハッシュ（再現性の検査用）。 */
  function stateHash(W) {
    return hashBytes(new Uint8Array(W.cur.buffer, W.cur.byteOffset, W.cur.byteLength));
  }

  /** a > thr の点の数（観測器の鮮度の検算用）。 */
  function countAbove(W, thr) {
    var n = W.n, a = W.cur, c = 0;
    for (var i = 0; i < n; i++) if (a[i] > thr) c++;
    return c;
  }

  /** 場 u の総和（保存の恒等式用）と印の数。 */
  function fieldTotals(W) {
    var n = W.n, u = W.cur.subarray(n, 2 * n), p = W.cur.subarray(3 * n, 4 * n), su = 0, np = 0;
    for (var i = 0; i < n; i++) { su += u[i]; np += p[i] > 0 ? 1 : 0; }
    return { sumU: su, emitters: np };
  }

  /**
   * **恒等式**（K-18）。周期境界・masking なしの格子で、1 列（x = x0 の全行）を印にすると
   * 場は行に依らず、9 点ラプラシアンは厳密に 1 次元の (u_{i−1} + u_{i+1} − 2u_i) に落ちる。
   * 定常状態は D(u_{i−1} + u_{i+1} − 2u_i) = k u_i を満たし、
   *   ρ = (c − √(c² − 4))/2,  c = 2 + k/D
   * を使って u_d ∝ ρ^d + ρ^{L−d}（d は印の列からの距離）になる。実装の外から来る閉じた式。
   */
  function geometricRatio(D, k) {
    var c = 2 + k / D;
    return (c - Math.sqrt(c * c - 4)) / 2;
  }
  /** 周期格子で印の列から距離 d の場の、距離 1 に対する比の理論値。 */
  function ringProfileRatio(D, k, L, d) {
    var r = geometricRatio(D, k);
    return (Math.pow(r, d) + Math.pow(r, L - d)) / (r + Math.pow(r, L - 1));
  }

  /** 世界を N ステップ進める。 */
  function run(W, steps) { for (var s = 0; s < steps; s++) stepWorld(W); return W; }

  return {
    CH: CH, NCH: NCH, DEFAULTS: DEFAULTS, LAPW: LAPW,
    makeRng: makeRng, makeRngState: makeRngState, rngNext: rngNext,
    createWorld: createWorld, cloneWorld: cloneWorld, channel: channel,
    stepWorld: stepWorld, stepWorldNaive: stepWorldNaive, run: run,
    eraseColumns: eraseColumns, eraseCircle: eraseCircle,
    hashBytes: hashBytes, stateHash: stateHash, countAbove: countAbove, fieldTotals: fieldTotals,
    geometricRatio: geometricRatio, ringProfileRatio: ringProfileRatio,
    neighbourTable: neighbourTable, twoOrigins: twoOrigins,
  };
});
