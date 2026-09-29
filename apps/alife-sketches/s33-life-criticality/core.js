/**
 * S-33 核 — 0/1 の格子と、外部トータリスティック規則と、1点だけ違う2枚の追跡。
 *
 * **上位概念の語彙を持たない。** cell / alive / dead / organism / birth / death / population を
 * 識別子にも分岐にも使わない。ここにあるのは「格子」「値」「近傍の和」「遷移表」「食い違い」だけである。
 * 生物学の語彙を使ってよいのは観測器（stats.js / run.js / viewer.html）の側だけ。
 *
 * 依存ゼロ・古典スクリプト。Node（module.exports）とブラウザ（window.S33）で共用する。
 */
(function (global) {
  'use strict';

  var EMPTY = new Int32Array(0);

  // ---------------------------------------------------------------- 乱数・ハッシュ

  /** mulberry32。シードを固定すれば完全に再現する。 */
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

  /** FNV-1a 32bit。格子の状態ハッシュ（K-36）。 */
  function hash(arr) {
    var h = 0x811c9dc5;
    for (var i = 0; i < arr.length; i++) {
      h ^= arr[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= arr.length;
    h = Math.imul(h, 0x01000193) >>> 0;
    return ('00000000' + h.toString(16)).slice(-8);
  }

  // ---------------------------------------------------------------- 遷移表

  /**
   * 遷移表を作る。index = value*9 + sum（sum は 8 近傍の和 0..8）。
   * keepSums: 値が 1 のとき 1 のままになる和の一覧。
   * makeSums: 値が 0 のとき 1 になる和の一覧。
   */
  function makeTable(keepSums, makeSums) {
    var t = new Uint8Array(18);
    for (var i = 0; i < keepSums.length; i++) t[9 + keepSums[i]] = 1;
    for (var j = 0; j < makeSums.length; j++) t[makeSums[j]] = 1;
    return t;
  }

  /** 表の 18 ビットを 16 進で表す（登録・照合用）。 */
  function tableCode(table) {
    var v = 0;
    for (var i = 0; i < 18; i++) if (table[i]) v += Math.pow(2, i);
    return v.toString(16);
  }

  // ---------------------------------------------------------------- 近傍表

  /**
   * 8 近傍の索引表。wrap=true は輪状（周期境界）、false は外側を 0 として扱う（-1 を入れる）。
   * side*side*8 の Int32Array。
   */
  function neighbours(side, wrap) {
    var n = side * side;
    var out = new Int32Array(n * 8);
    var k = 0;
    for (var y = 0; y < side; y++) {
      for (var x = 0; x < side; x++) {
        var b = (y * side + x) * 8;
        k = 0;
        for (var dy = -1; dy <= 1; dy++) {
          for (var dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0) continue;
            var yy = y + dy, xx = x + dx;
            if (wrap) {
              yy = (yy + side) % side;
              xx = (xx + side) % side;
              out[b + k] = yy * side + xx;
            } else {
              out[b + k] = (yy < 0 || yy >= side || xx < 0 || xx >= side) ? -1 : (yy * side + xx);
            }
            k++;
          }
        }
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- 素朴な一歩

  /** 総当たりで1歩。近道（Stepper / Damage）の検算に使う。 */
  function stepNaive(field, side, table, nbr) {
    var n = side * side, out = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var s = 0, b = i * 8;
      for (var k = 0; k < 8; k++) { var j = nbr[b + k]; if (j >= 0) s += field[j]; }
      out[i] = table[field[i] * 9 + s];
    }
    return out;
  }

  // ---------------------------------------------------------------- 活性リストの一歩

  /**
   * 「前の歩で値が変わった点とその近傍」だけを見る一歩。
   * 外部トータリスティックな規則では、値が変わりうるのはこの集合に限られる（厳密な近道）。
   */
  function Stepper(side, table, nbr) {
    var n = side * side;
    this.side = side; this.n = n; this.table = table; this.nbr = nbr;
    this.field = new Uint8Array(n);
    this.stamp = new Int32Array(n);
    this.gen = 0;
    this.cand = new Int32Array(n);
    this.changed = new Int32Array(n);
    this.changedLen = 0;
    this.t = 0;
  }

  Stepper.prototype.reset = function (field) {
    this.field.set(field);
    this.changedLen = this.n;
    for (var i = 0; i < this.n; i++) this.changed[i] = i;
    this.t = 0;
    return this;
  };

  /** 1歩進める。変わった点の数を返す。this.changed[0..changedLen) に変わった点が入る。 */
  Stepper.prototype.step = function () {
    var nbr = this.nbr, field = this.field, table = this.table;
    var stamp = this.stamp, cand = this.cand;
    var g = ++this.gen, cl = 0;
    var prev = this.changed, pl = this.changedLen;
    var i, k, j, b;
    for (i = 0; i < pl; i++) {
      var c = prev[i];
      if (stamp[c] !== g) { stamp[c] = g; cand[cl++] = c; }
      b = c * 8;
      for (k = 0; k < 8; k++) {
        j = nbr[b + k];
        if (j >= 0 && stamp[j] !== g) { stamp[j] = g; cand[cl++] = j; }
      }
    }
    // 新しい値を先に全部決めてから流し込む（同期更新）
    var tmp = this._tmp;
    if (!tmp || tmp.length < cl) { tmp = this._tmp = new Uint8Array(this.n); }
    var nl = 0, nxt = this._alt || (this._alt = new Int32Array(this.n));
    for (i = 0; i < cl; i++) {
      var c2 = cand[i], s = 0; b = c2 * 8;
      for (k = 0; k < 8; k++) { j = nbr[b + k]; if (j >= 0) s += field[j]; }
      var nv = table[field[c2] * 9 + s];
      tmp[i] = nv;
      if (nv !== field[c2]) nxt[nl++] = c2;
    }
    for (i = 0; i < cl; i++) field[cand[i]] = tmp[i];
    this.changed = nxt;
    this._alt = prev;
    this.changedLen = nl;
    this.t++;
    return nl;
  };

  // ---------------------------------------------------------------- 基準の軌跡

  /**
   * 基準の軌跡を「各歩で値が変わった点の一覧」として溜める。
   * 同じ配置から何度も摂動するとき、基準側を毎回計算し直さずに済む（近道）。
   */
  function Trace(side, table, nbr, field0, maxSteps) {
    this.side = side; this.table = table; this.nbr = nbr;
    this.start = new Uint8Array(field0);
    this.maxSteps = maxSteps;
    this.deltas = [];
    this.stepper = new Stepper(side, table, nbr).reset(field0);
    this.built = 0;
  }

  Trace.prototype.ensure = function (t) {
    var cap = Math.min(t, this.maxSteps);
    while (this.built < cap) {
      var nl = this.stepper.step();
      var d;
      if (nl === 0) { d = EMPTY; }
      else {
        d = new Int32Array(nl);
        for (var i = 0; i < nl; i++) d[i] = this.stepper.changed[i];
      }
      this.deltas.push(d);
      this.built++;
    }
    return this.built;
  };

  /** 溜めた差分の総量（生ログに残す観測器の目方）。 */
  Trace.prototype.weight = function () {
    var w = 0;
    for (var i = 0; i < this.deltas.length; i++) w += this.deltas[i].length;
    return w;
  };

  // ---------------------------------------------------------------- 食い違いの追跡

  /**
   * 基準の軌跡に対し、1点だけ値を反転した枚を並走させ、食い違いの集合を追う。
   * 食い違いが空になったら終わり。上限（歩数）に当たったら切られたと記録する。
   *
   * 近道: 食い違いが新しく生じうるのは「今の食い違いの点とその近傍」に限られるので、
   * そこだけ両枚の値を比べれば足りる。素朴な2枚並走との一致は selftest で検算する。
   */
  function Workspace(side) {
    var n = side * side;
    this.side = side;
    this.ref = new Uint8Array(n);
    this.mark = new Uint8Array(n);
    this.seen = new Uint8Array(n);
    this.stamp = new Int32Array(n);
    this.cand = new Int32Array(n);
    this.newMark = new Uint8Array(n);
    this.listA = new Int32Array(n);
    this.listB = new Int32Array(n);
    this.gen = 0;
  }

  function runDiff(trace, site, capSteps, opts) {
    opts = opts || {};
    var side = trace.side, n = side * side, table = trace.table, nbr = trace.nbr;
    var wrap = !!opts.wrap;
    var ws = opts.ws || new Workspace(side);
    var ref = ws.ref; ref.set(trace.start);
    var mark = ws.mark; mark.fill(0);
    var seen = ws.seen; seen.fill(0);
    var stamp = ws.stamp, gen = ws.gen;
    var cand = ws.cand, newMark = ws.newMark;
    var list = ws.listA, nxt = ws.listB, listLen = 0;

    mark[site] = 1; seen[site] = 1;
    list[0] = site; listLen = 1;

    var sx = site % side, sy = (site / side) | 0;
    var volume = 0, peak = 0, extent = 1, maxRadius = 0;
    var t = 0, cut = 0;
    // K-63: 厳しい上限の腕を、同じ走行から導く（腕の違いが上限だけであることを保証する）
    var tight = opts.tightCap || 0;
    var volumeTight = 0, lifeTight = 0, cutTight = 0;
    var track = opts.track || null;   // 各歩の食い違い数を残すなら配列

    while (listLen > 0) {
      volume += listLen;
      if (listLen > peak) peak = listLen;
      if (tight) {
        if (t < tight) { volumeTight += listLen; lifeTight = t + 1; }
        else if (!cutTight) cutTight = 1;
      }
      if (track) track.push(listLen);
      if (t + 1 >= capSteps) { cut = 1; break; }

      // 候補 = 食い違い ∪ その近傍
      var g = ++gen, cl = 0, i, k, j, b;
      for (i = 0; i < listLen; i++) {
        var c = list[i];
        if (stamp[c] !== g) { stamp[c] = g; cand[cl++] = c; }
        b = c * 8;
        for (k = 0; k < 8; k++) {
          j = nbr[b + k];
          if (j >= 0 && stamp[j] !== g) { stamp[j] = g; cand[cl++] = j; }
        }
      }
      for (i = 0; i < cl; i++) {
        var c2 = cand[i], sRef = 0, dSum = 0;
        b = c2 * 8;
        for (k = 0; k < 8; k++) {
          j = nbr[b + k];
          if (j >= 0) {
            var rv = ref[j];
            sRef += rv;
            if (mark[j]) dSum += (1 - 2 * rv);
          }
        }
        var rv2 = ref[c2];
        var pv2 = mark[c2] ? (1 - rv2) : rv2;
        var a = table[rv2 * 9 + sRef];
        var bb = table[pv2 * 9 + (sRef + dSum)];
        newMark[c2] = (a === bb) ? 0 : 1;
      }

      // 基準を1歩進める（溜めてある差分を流す）
      trace.ensure(t + 1);
      if (t < trace.deltas.length) {
        var d = trace.deltas[t];
        for (i = 0; i < d.length; i++) ref[d[i]] ^= 1;
      }

      // 食い違いを入れ替える
      var nl = 0;
      for (i = 0; i < cl; i++) {
        var c3 = cand[i];
        if (newMark[c3]) {
          mark[c3] = 1; nxt[nl++] = c3;
          if (!seen[c3]) {
            seen[c3] = 1; extent++;
            var dx = Math.abs((c3 % side) - sx), dy = Math.abs(((c3 / side) | 0) - sy);
            if (wrap) { if (dx > side - dx) dx = side - dx; if (dy > side - dy) dy = side - dy; }
            var r = dx > dy ? dx : dy;
            if (r > maxRadius) maxRadius = r;
          }
        } else {
          mark[c3] = 0;
        }
      }
      var tmpL = list; list = nxt; nxt = tmpL;
      listLen = nl;
      t++;
    }

    ws.gen = gen;
    var lifetime = cut ? (t + 1) : t;   // 食い違いが在った歩数

    return {
      site: site,
      startValue: trace.start[site],
      volume: volume,          // Σ_t |食い違い|（時空の体積）
      lifetime: lifetime,      // 食い違いが消えるまでの歩数
      extent: extent,          // 一度でも食い違った点の数
      peak: peak,              // 同時に食い違った最大数
      maxRadius: maxRadius,    // 摂動点からの最大チェビシェフ距離
      cutTime: cut,            // 歩数の上限で切られたか（K-63）
      volumeTight: tight ? volumeTight : null,
      lifeTight: tight ? lifeTight : null,
      cutTight: tight ? cutTight : null
    };
  }

  /** 素朴な2枚並走（近道の検算用。遅い）。 */
  function runDiffNaive(side, table, nbr, field0, site, capSteps, wrap) {
    var n = side * side;
    var a = new Uint8Array(field0), b = new Uint8Array(field0);
    b[site] ^= 1;
    var seen = new Uint8Array(n); seen[site] = 1;
    var sx = site % side, sy = (site / side) | 0;
    var volume = 0, peak = 0, extent = 1, maxRadius = 0, t = 0, cut = 0;
    var track = [];
    for (;;) {
      var cnt = 0, i;
      for (i = 0; i < n; i++) if (a[i] !== b[i]) cnt++;
      if (cnt === 0) break;
      volume += cnt; if (cnt > peak) peak = cnt;
      track.push(cnt);
      if (t + 1 >= capSteps) { cut = 1; break; }
      a = stepNaive(a, side, table, nbr);
      b = stepNaive(b, side, table, nbr);
      for (i = 0; i < n; i++) {
        if (a[i] !== b[i] && !seen[i]) {
          seen[i] = 1; extent++;
          var dx = Math.abs((i % side) - sx), dy = Math.abs(((i / side) | 0) - sy);
          if (wrap) { if (dx > side - dx) dx = side - dx; if (dy > side - dy) dy = side - dy; }
          var r = dx > dy ? dx : dy; if (r > maxRadius) maxRadius = r;
        }
      }
      t++;
    }
    return { volume: volume, lifetime: cut ? (t + 1) : t, extent: extent, peak: peak,
             maxRadius: maxRadius, cutTime: cut, track: track };
  }


  // ---------------------------------------------------------------- 反復の検出（Zobrist）

  /** 各点に 2 語の鍵を割り当てる。値 1 の点の鍵の XOR が配置の指紋になる（差分で更新できる）。 */
  function zobrist(n, rand) {
    var a = new Int32Array(n), b = new Int32Array(n);
    for (var i = 0; i < n; i++) {
      a[i] = (rand() * 4294967296) | 0;
      b[i] = (rand() * 4294967296) | 0;
    }
    return { a: a, b: b };
  }

  function fingerprint(field, keys) {
    var x = 0, y = 0;
    for (var i = 0; i < field.length; i++) if (field[i]) { x ^= keys.a[i]; y ^= keys.b[i]; }
    return [x, y];
  }

  /**
   * 反復の検出器。直近 window 歩の指紋を環状に保ち、今の指紋が過去に出ていれば周期を返す。
   * 有限・決定的な系なので必ずいつか閉じるが、window を超える周期は「検出せず」になる——
   * **この window は登録項目である**（K-26）。
   */
  function Recurrence(window) {
    this.window = window;
    this.ax = new Int32Array(window); this.ay = new Int32Array(window);
    this.time = new Int32Array(window);
    this.len = 0; this.pos = 0;
  }
  Recurrence.prototype.reset = function () { this.len = 0; this.pos = 0; return this; };
  /** 今の指紋を入れる。過去に一致があれば周期（正の整数）、無ければ 0 を返す。 */
  Recurrence.prototype.push = function (x, y, t) {
    var w = this.window, found = 0;
    for (var k = 0; k < this.len; k++) {
      if (this.ax[k] === x && this.ay[k] === y) { found = t - this.time[k]; break; }
    }
    this.ax[this.pos] = x; this.ay[this.pos] = y; this.time[this.pos] = t;
    this.pos = (this.pos + 1) % w;
    if (this.len < w) this.len++;
    return found;
  };

  /**
   * 配置を静止させ、周期を測る。
   * steps 歩進めてから、window 歩ぶんの指紋を見て周期を返す（見つからなければ period=0）。
   */
  function settle(side, table, nbr, field0, steps, keys, window) {
    var st = new Stepper(side, table, nbr).reset(field0);
    var i;
    for (i = 0; i < steps; i++) st.step();
    var fp = fingerprint(st.field, keys);
    var rec = new Recurrence(window);
    var x = fp[0], y = fp[1];
    var period = 0, activity = 0;
    rec.push(x, y, 0);
    for (i = 1; i <= window; i++) {
      var nl = st.step();
      activity += nl;
      for (var k = 0; k < nl; k++) { var c = st.changed[k]; x ^= keys.a[c]; y ^= keys.b[c]; }
      var p = rec.push(x, y, i);
      if (p) { period = p; break; }
    }
    return { field: new Uint8Array(st.field), period: period, baseline: activity / i, checked: i };
  }

  /**
   * 静止した配置の「輪」を取り出す。周期 p と、各位相で値が変わる点の一覧を持つ。
   * これがあれば、基準側を毎回計算し直さずに食い違いも活動の超過も数えられる。
   */
  function cycleOf(side, table, nbr, field0, keys, window) {
    var q = settle(side, table, nbr, field0, 0, keys, window);
    if (!q.period) return { period: 0, start: new Uint8Array(field0) };
    // 周期が判った位置から、位相ごとの変化点を取り直す
    var st = new Stepper(side, table, nbr).reset(q.field);
    var p = q.period, phases = [], acts = [], i, k;
    for (i = 0; i < p; i++) {
      var nl = st.step();
      var d = new Int32Array(nl);
      for (k = 0; k < nl; k++) d[k] = st.changed[k];
      phases.push(d); acts.push(nl);
    }
    var base = 0;
    for (i = 0; i < p; i++) base += acts[i];
    return { period: p, start: new Uint8Array(q.field), phases: phases,
             baseline: base / p, ones: countOnes(q.field) };
  }

  /**
   * 雪崩を1本測る。**2つの量を同時に出す**——
   *   ① 活動（Bak–Chen–Creutz 風）: 値が変わった回数の、基準の輪に対する超過
   *   ② 食い違い（damage）: 基準の輪との違いの時空体積
   * 終わりは「摂動された側が周期 ≤ window の輪へ入ったとき」。上限（capSteps）で切られたら記録する。
   *
   * windows は昇順の窓の一覧（登録した観測器のノブ）。窓ごとに最初の検出時刻を返す。
   */
  function runAvalanche(cyc, side, table, nbr, site, capSteps, keys, windows, tightCap) {
    var n = side * side, p = cyc.period;
    var st = new Stepper(side, table, nbr);
    var f = new Uint8Array(cyc.start);
    f[site] ^= 1;
    st.reset(f);
    var mark = new Uint8Array(n); mark[site] = 1;
    var seenD = new Uint8Array(n); seenD[site] = 1;
    var touch = new Int32Array(2 * n);
    var seenA = new Uint8Array(n); seenA[site] = 1;
    var dmg = 1, extD = 1, extA = 1, peakD = 1, peakA = 0;
    var actTotal = 0, refTotal = 0, sDmg = 1;
    var x = 0, y = 0, i, k, c;
    for (i = 0; i < n; i++) if (f[i]) { x ^= keys.a[i]; y ^= keys.b[i]; }
    var recs = [], hit = [], snapS = [], snapT = [];
    for (i = 0; i < windows.length; i++) {
      recs.push(new Recurrence(windows[i])); hit.push(0); snapS.push(null); snapT.push(null);
      recs[i].push(x, y, 0);
    }
    var dmgLife = null, t = 0, cut = 0, period = 0, tDetect = 0;
    var sActTight = null, tActTight = null, cutTight = 0;
    var wmax = windows.length - 1;
    for (;;) {
      if (t + 1 >= capSteps) { cut = 1; break; }
      var nl = st.step();
      actTotal += nl;
      if (nl > peakA) peakA = nl;
      var tl = 0;
      for (k = 0; k < nl; k++) {
        c = st.changed[k];
        x ^= keys.a[c]; y ^= keys.b[c];
        if (!seenA[c]) { seenA[c] = 1; extA++; }
        if (mark[c]) { mark[c] = 0; dmg--; } else { mark[c] = 1; dmg++; }
        touch[tl++] = c;
      }
      var ph = p ? cyc.phases[t % p] : null;
      if (ph) {
        refTotal += ph.length;
        for (k = 0; k < ph.length; k++) {
          c = ph[k];
          if (mark[c]) { mark[c] = 0; dmg--; } else { mark[c] = 1; dmg++; }
          touch[tl++] = c;
        }
      }
      // **食い違いの広がりは、その歩の両側の変化を入れ終えてから数える。**
      // 摂動側と基準側が同じ点を同じ歩で変えると印が二度ひっくり返るので、
      // 途中で数えると「食い違っていない点」を広がりに入れてしまう（本番前に実測で捕まえた）。
      for (k = 0; k < tl; k++) { c = touch[k]; if (mark[c] && !seenD[c]) { seenD[c] = 1; extD++; } }
      t++;
      sDmg += dmg;
      if (dmg > peakD) peakD = dmg;
      if (dmg === 0 && dmgLife === null) dmgLife = t;
      if (tightCap) {
        if (t <= tightCap) { sActTight = actTotal - refTotal; tActTight = t; }
        else if (!cutTight) cutTight = 1;
      }
      var done = 0;
      for (i = 0; i < recs.length; i++) {
        if (!hit[i]) {
          var pr = recs[i].push(x, y, t);
          if (pr) {
            hit[i] = t - pr;
            snapS[i] = actTotal - refTotal; snapT[i] = t - pr;
            if (i === wmax) { period = pr; tDetect = t; done = 1; }
          }
        }
      }
      if (done) break;
    }
    if (!tDetect) tDetect = t;
    if (tightCap && !cutTight) { sActTight = actTotal - refTotal; tActTight = tDetect - period; }
    return {
      site: site, startValue: cyc.start[site],
      sAct: actTotal - refTotal,        // 活動の超過（帰無値 0）
      tAct: tDetect - period,           // 輪へ落ちるまでの歩数（帰無値 1）
      tDetect: tDetect, period: period,
      sDmg: sDmg, dmgLife: dmgLife, dmgEnd: dmg,
      extAct: extA, extDmg: extD, peakAct: peakA, peakDmg: peakD,
      actTotal: actTotal, refTotal: refTotal,
      cutTime: cut,
      windowHits: hit.slice(), windowS: snapS.slice(), windowT: snapT.slice(),
      sActTight: sActTight, tActTight: tActTight === null ? null : (tActTight), cutTight: cutTight,
      endHash: ('00000000' + (x >>> 0).toString(16)).slice(-8) + ('00000000' + (y >>> 0).toString(16)).slice(-8),
      field: st.field
    };
  }

  // ---------------------------------------------------------------- 配置を作る

  function randomField(side, density, rand) {
    var n = side * side, f = new Uint8Array(n);
    for (var i = 0; i < n; i++) f[i] = rand() < density ? 1 : 0;
    return f;
  }

  /** 値の多重集合を保ったまま並べ替える（参照点 R2: 配置だけ忘れる）。 */
  function shuffleField(field, rand) {
    var f = new Uint8Array(field);
    for (var i = f.length - 1; i > 0; i--) {
      var j = (rand() * (i + 1)) | 0;
      var tmp = f[i]; f[i] = f[j]; f[j] = tmp;
    }
    return f;
  }

  function countOnes(field) {
    var c = 0;
    for (var i = 0; i < field.length; i++) c += field[i];
    return c;
  }

  /** 静止させる: ランダムな配置から steps 歩進める。残った動きの量も返す。 */
  function relax(side, table, nbr, field0, steps) {
    var st = new Stepper(side, table, nbr).reset(field0);
    var tail = 0, i;
    for (i = 0; i < steps; i++) {
      var nl = st.step();
      if (i >= steps - 16) tail += nl;   // 最後の16歩で動いた点の数（残留活動）
      if (nl === 0 && i > 8) { tail = 0; break; }
    }
    return { field: new Uint8Array(st.field), residual: tail / 16, steps: i + 1 };
  }

  var api = {
    rng: rng, hash: hash,
    makeTable: makeTable, tableCode: tableCode, neighbours: neighbours,
    stepNaive: stepNaive, Stepper: Stepper, Trace: Trace, Workspace: Workspace,
    runDiff: runDiff, runDiffNaive: runDiffNaive,
    randomField: randomField, shuffleField: shuffleField,
    countOnes: countOnes, relax: relax,
    zobrist: zobrist, fingerprint: fingerprint, Recurrence: Recurrence,
    settle: settle, cycleOf: cycleOf, runAvalanche: runAvalanche
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.S33 = api;
  if (typeof global !== 'undefined' && global && !global.S33) global.S33 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
