/**
 * S-14: 2行の規則で動く格子上の歩行者と、その軌道の反復を機械的に見つける観測器。
 *
 * 核（上半分）が知っているのは次だけである:
 *
 *   格子の各マスは色 0..k-1 を持つ。歩行者は位置と向きを持つ。
 *   1歩 = 現在マスの色 c を読む → rule[c] だけ向きを変える → そのマスを (c+1) mod k に書く → 前へ1歩。
 *
 *   rule の文字: R = 右90°, L = 左90°, N = そのまま, U = 180°
 *
 * 観測器（下半分）が見るのは、位置・向き・歩行者の向きを基準にした近傍の色だけである。
 * 「ハイウェイ」「秩序」「混沌」という語はこのファイルに無い。あるのは
 * 「周期 P で状態記述が一致し、位置差が一定である」という述語と、
 * 「窓 W にわたる正味の変位の割合」という量だけで、その2つの連言に名前を付けるのは呼び出す側の仕事である。
 *
 * 依存ゼロ。Node（生ログ生成）とブラウザ（可視化）が同じファイルを読む。
 *
 * 出典（アイデアのみ。コードは参照していない）:
 *   Langton, C. G. (1986) "Studying artificial life with cellular automata",
 *   Physica D 22(1-3), 120-149.
 *   Turk & Propp による多状態への一般化（L/R 文字列）も題材に含む。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S14 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 向き 0=北 1=東 2=南 3=西（画面座標。y は下へ増える）。+1 が右回り。
  var DX = [0, 1, 0, -1];
  var DY = [-1, 0, 1, 0];

  var TURN = { R: 1, L: 3, N: 0, U: 2 };

  /** 決定論的な擬似乱数（mulberry32）。同じシードで完全に再現する。 */
  function makeRng(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function parseRule(rule) {
    var turns = new Int8Array(rule.length);
    for (var i = 0; i < rule.length; i++) {
      var c = rule.charAt(i).toUpperCase();
      if (!(c in TURN)) throw new Error('unknown rule letter: ' + c);
      turns[i] = TURN[c];
    }
    return turns;
  }

  // ---------------------------------------------------------------- 核

  var DEFAULTS = {
    rule: 'RL',
    span: 2048,       // 格子の一辺（2の冪）。中心が原点
    density: 0,       // 初期領域で色 0 以外にするマスの割合
    seedSize: 101,    // 初期領域の一辺（原点中心の正方形）
    seed: 1,
    mode: 'rule',     // 'rule' | 'randomTurn' | 'randomWalk' | 'jitterStraight'
    jitter: 0.01,     // mode='jitterStraight' のときの乱択回頭の確率
  };

  /**
   * 世界を作る。data は Uint8Array（span*span）で、外周 8 マスは触らせない。
   * 初期配置は原点中心の一辺 seedSize の正方領域だけに置く（有限の初期配置）。
   */
  function createWorld(opts) {
    var o = {}, key;
    for (key in DEFAULTS) o[key] = DEFAULTS[key];
    for (key in (opts || {})) o[key] = opts[key];

    var span = o.span, half = span >> 1;
    var w = {
      opts: o,
      rule: o.rule,
      turns: parseRule(o.rule),
      k: o.rule.length,
      span: span,
      half: half,
      data: new Uint8Array(span * span),
      x: 0, y: 0, h: 0,
      steps: 0,
      out: false,
      minX: 0, maxX: 0, minY: 0, maxY: 0,
      nonZero: 0,
      rng: makeRng(o.seed),
      margin: 8,
    };
    seedLattice(w, o.density, o.seedSize, o.seed);
    return w;
  }

  /** 初期領域へ色を撒く。density=0 なら何も置かない（完全に空の格子）。 */
  function seedLattice(w, density, seedSize, seed) {
    if (!(density > 0) || !(seedSize > 0)) return;
    var rng = makeRng((seed >>> 0) ^ 0x9E3779B9);
    var r = seedSize >> 1;
    var lo = -r, hi = seedSize % 2 === 1 ? r : r - 1;
    var k = w.k;
    for (var y = lo; y <= hi; y++) {
      for (var x = lo; x <= hi; x++) {
        if (rng() < density) {
          var c = k > 2 ? 1 + ((rng() * (k - 1)) | 0) : 1;
          if (c > k - 1) c = k - 1;
          w.data[(y + w.half) * w.span + (x + w.half)] = c;
          w.nonZero++;
          if (x < w.minX) w.minX = x;
          if (x > w.maxX) w.maxX = x;
          if (y < w.minY) w.minY = y;
          if (y > w.maxY) w.maxY = y;
        }
      }
    }
  }

  function indexOf(w, x, y) { return (y + w.half) * w.span + (x + w.half); }

  /** 1歩進める。境界へ近づいたら out を立てて止まる。 */
  function stepWorld(w) {
    if (w.out) return false;
    var lim = w.half - w.margin;
    if (w.x <= -lim || w.x >= lim || w.y <= -lim || w.y >= lim) { w.out = true; return false; }

    var idx = (w.y + w.half) * w.span + (w.x + w.half);
    var c = w.data[idx];

    if (w.opts.mode === 'randomWalk') {
      w.h = (w.rng() * 4) | 0;
    } else if (w.opts.mode === 'randomTurn') {
      w.h = (w.h + (w.rng() < 0.5 ? 1 : 3)) & 3;
      var nc0 = c + 1; if (nc0 >= w.k) nc0 = 0;
      if (nc0 !== 0 && c === 0) w.nonZero++; else if (nc0 === 0 && c !== 0) w.nonZero--;
      w.data[idx] = nc0;
    } else if (w.opts.mode === 'jitterStraight') {
      if (w.rng() < w.opts.jitter) w.h = (w.h + (w.rng() < 0.5 ? 1 : 3)) & 3;
      var nc1 = c + 1; if (nc1 >= w.k) nc1 = 0;
      if (nc1 !== 0 && c === 0) w.nonZero++; else if (nc1 === 0 && c !== 0) w.nonZero--;
      w.data[idx] = nc1;
    } else {
      w.h = (w.h + w.turns[c]) & 3;
      var nc = c + 1; if (nc >= w.k) nc = 0;
      if (nc !== 0 && c === 0) w.nonZero++; else if (nc === 0 && c !== 0) w.nonZero--;
      w.data[idx] = nc;
    }

    w.x += DX[w.h];
    w.y += DY[w.h];
    w.steps++;
    if (w.x < w.minX) w.minX = w.x;
    if (w.x > w.maxX) w.maxX = w.x;
    if (w.y < w.minY) w.minY = w.y;
    if (w.y > w.maxY) w.maxY = w.y;
    return true;
  }

  /**
   * 1歩戻す（mode='rule' のときだけ定義される）。規則が可逆であることを使う:
   *   1歩戻る → そのマスの色 c' を c'-1 mod k に戻す → 向きを turn(c'-1) だけ逆に回す
   */
  function unstepWorld(w) {
    if (w.steps <= 0) return false;
    w.x -= DX[w.h];
    w.y -= DY[w.h];
    var idx = (w.y + w.half) * w.span + (w.x + w.half);
    var cPost = w.data[idx];
    var cPre = cPost - 1; if (cPre < 0) cPre = w.k - 1;
    if (cPre !== 0 && cPost === 0) w.nonZero++; else if (cPre === 0 && cPost !== 0) w.nonZero--;
    w.data[idx] = cPre;
    w.h = (w.h - w.turns[cPre] + 4) & 3;
    w.steps--;
    return true;
  }

  /** 格子の内容・位置・向きの指紋。可逆性の検査に使う。 */
  function fingerprint(w) {
    var h = 2166136261 ^ w.x ^ (w.y << 8) ^ (w.h << 16);
    var d = w.data;
    for (var i = 0; i < d.length; i++) {
      if (d[i] !== 0) h = Math.imul(h ^ (i + d[i] * 7919), 16777619);
    }
    return (h >>> 0).toString(16);
  }

  /** 色0以外のマスを素朴に数え直す（近道の検算用）。 */
  function countNonZero(w) {
    var n = 0, d = w.data;
    for (var i = 0; i < d.length; i++) if (d[i] !== 0) n++;
    return n;
  }

  // ------------------------------------------------------------ 観測器

  var RING = 16384;              // 履歴の環の既定の大きさ（(mMax+1)*maxPeriod を収められれば足りる）
  var BUCKETS = 1 << 18, BMASK = BUCKETS - 1;

  /** (mMax+1)*maxPeriod を収める 2 の冪。 */
  function ringSizeFor(mMax, maxPeriod) {
    var need = (mMax + 1) * maxPeriod + 8, n = RING;
    while (n < need) n *= 2;
    return n;
  }

  // 近傍の読み出し順。Chebyshev 半径の昇順に並べるので、先頭 9 個が r=1、
  // 先頭 25 個が r=2、先頭 49 個が r=3 に対応する（前置ハッシュがそのまま使える）。
  function localOffsets(maxR) {
    var out = [];
    for (var ring = 0; ring <= maxR; ring++) {
      for (var v = -ring; v <= ring; v++) {
        for (var u = -ring; u <= ring; u++) {
          if (Math.max(Math.abs(u), Math.abs(v)) !== ring) continue;
          out.push([u, v]); // u = 右方向, v = 前方向
        }
      }
    }
    return out;
  }

  /**
   * 反復の検出器。
   *
   *   A: 周期 P が存在して、標本時刻 t-iP (i=0..m) で「向き＋相対枠の近傍の色」が一致し、
   *      連続する標本間の位置差が i によらず同じベクトル d であること。
   *   B: その反復が始まった時刻 onset から W 歩の間の正味の変位の割合が driftFloor 以上であること。
   *
   * A は非周期的な期間でも短く成立してしまう（それが本スケッチの見どころのひとつ）。
   * したがって A の成立は「事象」として連続する成立を1つにまとめて列挙し、
   * (r, m, W, floor) ごとに「A かつ B を最初に満たした事象」を答えとする。
   *
   * 半径 r・反復数 m・窓 W・床 driftFloor を全部振って全部記録する。
   */
  function createDetector(world, opts) {
    var o = opts || {};
    var radii = o.radii || [1, 2, 3];
    var repeats = (o.repeats || [2, 4, 8, 16]).slice().sort(function (a, b) { return a - b; });
    var maxPeriod = o.maxPeriod || 512;
    var windows = o.driftWindows || [500, 2000, 10000];
    var floors = o.driftFloors || [0.001, 0.005, 0.01, 0.02];
    var maxEvents = o.maxEvents || 512;
    var mMax = repeats[repeats.length - 1];
    var ring = ringSizeFor(mMax, maxPeriod), rmask = ring - 1;

    var maxR = 0, i, j;
    for (i = 0; i < radii.length; i++) if (radii[i] > maxR) maxR = radii[i];
    var offs = localOffsets(maxR);
    var cut = [];                       // 半径 r までに読む個数
    for (i = 0; i <= maxR; i++) cut.push((2 * i + 1) * (2 * i + 1));

    // 向きごとの索引差分表。相対枠 (u=右, v=前) を世界の座標へ回す。
    var deltas = [];
    for (var hh = 0; hh < 4; hh++) {
      var fwdX = DX[hh], fwdY = DY[hh];
      var rgtX = DX[(hh + 1) & 3], rgtY = DY[(hh + 1) & 3];
      var arr = new Int32Array(offs.length);
      for (i = 0; i < offs.length; i++) {
        var u = offs[i][0], v = offs[i][1];
        arr[i] = (u * rgtY + v * fwdY) * world.span + (u * rgtX + v * fwdX);
      }
      deltas.push(arr);
    }

    var D = {
      world: world, radii: radii, repeats: repeats, maxPeriod: maxPeriod,
      windows: windows, floors: floors, mMax: mMax, maxEvents: maxEvents,
      deltas: deltas, cut: cut, nOff: offs.length,
      ring: ring, rmask: rmask,
      hx: new Int32Array(ring), hy: new Int32Array(ring), hh: new Uint8Array(ring),
      sig: [], head: [], prev: [],
      events: [],        // events[ri][mi] = 成立事象の配列
      curRun: [],        // curRun[ri][mi] = 進行中の事象 or null
      lastFire: [],      // lastFire[ri][mi] = 最後に発火した時刻
      overflow: [],
      firstA: {},        // "r:m" -> 最初の A 成立（B・C を問わない）
      pendingAt: new Map(),  // 時刻 -> 測定の予約（並進 B と持続 C）
      drift: {},         // onset -> {W -> rate}
      confirmed: {},     // "r:m:W:f" -> 事象（A∧B∧C）
      confirmedAB: {},   // 同じ鍵。C を課さない版（A∧B）
      cursor: {},        // "r:m:W:f" -> 走査を再開する事象の添字
      nCombos: radii.length * repeats.length * windows.length * floors.length,
      nConfirmed: 0, dirty: false,
      sigBuf: new Int32Array(radii.length),
      sigReads: 0,
    };
    for (i = 0; i < radii.length; i++) {
      D.sig.push(new Int32Array(ring));
      var hd = new Int32Array(BUCKETS); hd.fill(-1);
      D.head.push(hd);
      D.prev.push(new Int32Array(ring));
      var ev = [], cr = [], lf = [], ov = [];
      for (j = 0; j < repeats.length; j++) { ev.push([]); cr.push(null); lf.push(-2); ov.push(false); }
      D.events.push(ev); D.curRun.push(cr); D.lastFire.push(lf); D.overflow.push(ov);
    }
    record(D, world);   // t=0 の状態も履歴へ入れておく
    return D;
  }

  /** いまの状態を履歴へ書き、候補周期を検証する。stepWorld のあとに毎歩呼ぶ。 */
  function record(D, w) {
    var t = w.steps, RMASK = D.rmask, slot = t & RMASK;
    D.hx[slot] = w.x; D.hy[slot] = w.y; D.hh[slot] = w.h;

    var base = (w.y + w.half) * w.span + (w.x + w.half);
    var off = D.deltas[w.h], data = w.data;
    var nOff = D.nOff, nR = D.radii.length, sigBuf = D.sigBuf;
    var acc = (2166136261 ^ w.h) | 0;
    var ri = 0, nextCut = D.cut[D.radii[0]];
    for (var i = 0; i < nOff; i++) {
      acc = Math.imul(acc ^ data[base + off[i]], 16777619);
      if (i + 1 === nextCut) {
        sigBuf[ri] = acc | 0;
        ri++;
        nextCut = ri < nR ? D.cut[D.radii[ri]] : -1;
      }
    }
    D.sigReads += nOff;

    for (ri = 0; ri < nR; ri++) {
      var s = sigBuf[ri];
      D.sig[ri][slot] = s;
      // 進行中の事象があれば、その周期を先に検証する。同じ周期が続く限りそれを優先し、
      // たまたま成立した小さい周期で反復の連続が切れないようにする（持続 C の測り方が
      // 「連続して成立し続けた長さ」なので、この優先順位は判定の一部である）。
      for (var mi0 = 0; mi0 < D.repeats.length; mi0++) {
        var cr = D.curRun[ri][mi0];
        if (cr && D.lastFire[ri][mi0] === t - 1) verify(D, ri, t, cr.period);
      }
      var head = D.head[ri], prev = D.prev[ri];
      var b = s & BMASK;
      var tau = head[b];
      while (tau >= 0 && t - tau <= D.maxPeriod) {
        if (D.sig[ri][tau & RMASK] === s) verify(D, ri, t, t - tau);
        tau = prev[tau & RMASK];
      }
      prev[slot] = head[b];
      head[b] = t;
    }

    // 進行中でなくなった事象を閉じる
    for (ri = 0; ri < nR; ri++) {
      for (var mi = 0; mi < D.repeats.length; mi++) {
        if (D.curRun[ri][mi] && D.lastFire[ri][mi] < t) D.curRun[ri][mi] = null;
      }
    }

    // 予約してあった測定（並進 B と持続 C）
    var due = D.pendingAt.get(t);
    if (due) {
      for (var p = 0; p < due.length; p++) {
        var q = due[p];
        if (q.kind === 'drift') {
          var dxx = w.x - q.x0, dyy = w.y - q.y0;
          setDrift(D, q.t0, q.W, Math.sqrt(dxx * dxx + dyy * dyy) / q.W);
        } else {
          q.run.persist[String(q.W)] = q.run.lastT >= t;
          D.dirty = true;
        }
      }
      D.pendingAt.delete(t);
    }
    if (D.dirty) { updateConfirmed(D); D.dirty = false; }
  }

  /** 事象を開始する。開始した時点で列へ入れ、並進 B と持続 C の測定を予約する。 */
  function openRun(D, ri, mi, run) {
    D.curRun[ri][mi] = run;
    if (D.events[ri][mi].length >= D.maxEvents) { D.overflow[ri][mi] = true; return; }
    run.persist = {};
    D.events[ri][mi].push(run);
    scheduleDrift(D, run.onset);
    schedulePersist(D, run);
  }

  function addPending(D, target, entry) {
    var arr = D.pendingAt.get(target);
    if (!arr) { arr = []; D.pendingAt.set(target, arr); }
    arr.push(entry);
  }

  /**
   * C（持続）: 反復 A が、確定した時刻から W 歩にわたって連続して成立し続けるか。
   *
   * m 回の反復（A）が見ているのは m+1 個の標本時刻だけで、間が周期的である保証は無い。
   * m*P を窓の長さの代わりに使うと m=2・P=351 のような偶然が通ってしまうので、
   * 「連続して成立し続けた長さ」= lastT - detect で測る。事象は連続成立をひとつに束ねてある。
   */
  function schedulePersist(D, run) {
    for (var i = 0; i < D.windows.length; i++) {
      addPending(D, run.detect + D.windows[i], { kind: 'persist', run: run, W: D.windows[i] });
    }
  }

  function setDrift(D, t0, W, rate) {
    var key = String(t0);
    if (!D.drift[key]) D.drift[key] = {};
    D.drift[key][String(W)] = rate;
    D.dirty = true;
  }

  /** 候補周期 P を検証し、成立した反復数に応じて事象を開始/延長する。 */
  function verify(D, ri, t, P) {
    if (P < 1 || P > D.maxPeriod) return;
    var M = D.rmask, hx = D.hx, hy = D.hy, hh = D.hh, sg = D.sig[ri];
    var s0 = sg[t & M], h0 = hh[t & M];
    var a = t & M, b = (t - P) & M;
    if (hh[b] !== h0 || sg[b] !== s0) return;
    var dx = hx[a] - hx[b], dy = hy[a] - hy[b];
    var lim = Math.min(D.mMax, Math.floor(t / P));
    var matched = 1;
    for (var i = 2; i <= lim; i++) {
      var aa = (t - (i - 1) * P) & M, bb = (t - i * P) & M;
      if (sg[bb] !== s0 || hh[bb] !== h0) break;
      if (hx[aa] - hx[bb] !== dx || hy[aa] - hy[bb] !== dy) break;
      matched = i;
    }
    if (matched < D.repeats[0]) return;

    for (var mi = 0; mi < D.repeats.length; mi++) {
      var m = D.repeats[mi];
      if (matched < m) break;
      if (D.lastFire[ri][mi] === t) continue;   // 同じ歩では最小の P だけ採る
      var onset = t - m * P;
      var key = D.radii[ri] + ':' + m;
      if (!D.firstA[key]) D.firstA[key] = { onset: onset, detect: t, period: P, dx: dx, dy: dy };
      var run = D.curRun[ri][mi];
      if (run && D.lastFire[ri][mi] === t - 1 && run.period === P && run.dx === dx && run.dy === dy) {
        run.lastT = t;
      } else {
        openRun(D, ri, mi, { onset: onset, detect: t, period: P, dx: dx, dy: dy, lastT: t });
      }
      D.lastFire[ri][mi] = t;
    }
  }

  /** onset から窓 W 先の位置を測る予約を入れる（既に過去なら履歴から読む）。 */
  function scheduleDrift(D, onset) {
    var key = String(onset);
    if (D.drift[key]) return;
    var M = D.rmask, t = D.world.steps;
    var x0 = D.hx[onset & M], y0 = D.hy[onset & M];
    for (var i = 0; i < D.windows.length; i++) {
      var W = D.windows[i], target = onset + W;
      if (target <= t && t - target < D.ring - 4) {
        var dxx = D.hx[target & M] - x0, dyy = D.hy[target & M] - y0;
        setDrift(D, onset, W, Math.sqrt(dxx * dxx + dyy * dyy) / W);
      } else if (target > t) {
        addPending(D, target, { kind: 'drift', t0: onset, W: W, x0: x0, y0: y0 });
      }
    }
  }

  /**
   * (r,m,W,floor) ごとに「A かつ B かつ C を最初に満たした事象」を確定させる。
   * あわせて C を課さない版（A かつ B だけ）も別に確定させる。両方を報告する。
   */
  function updateConfirmed(D) {
    for (var ri = 0; ri < D.radii.length; ri++) {
      for (var mi = 0; mi < D.repeats.length; mi++) {
        var evs = D.events[ri][mi];
        for (var wi = 0; wi < D.windows.length; wi++) {
          var W = D.windows[wi], ws = String(W);
          for (var fi = 0; fi < D.floors.length; fi++) {
            var f = D.floors[fi];
            var key = D.radii[ri] + ':' + D.repeats[mi] + ':' + W + ':' + f;
            var full = !!D.confirmed[key], ab = !!D.confirmedAB[key];
            if (full && ab) continue;
            var e = D.cursor[key] || 0;
            for (; e < evs.length; e++) {
              var ev = evs[e];
              var dd = D.drift[String(ev.onset)];
              var rate = dd ? dd[ws] : undefined;
              var per = ev.persist[ws];
              if (rate === undefined || per === undefined) break;  // まだ測れていない事象より先は見ない
              var passB = rate >= f;
              if (passB && !ab) {
                D.confirmedAB[key] = pack(ev, rate, e); ab = true;
              }
              if (passB && per && !full) {
                D.confirmed[key] = pack(ev, rate, e); full = true; D.nConfirmed++;
              }
              if (full && ab) break;
            }
            if (!full) D.cursor[key] = e;
          }
        }
      }
    }
  }

  function pack(ev, rate, rank) {
    return { onset: ev.onset, detect: ev.detect, period: ev.period, dx: ev.dx, dy: ev.dy,
             lastT: ev.lastT, driftRate: rate, rank: rank };
  }

  /** 全ての (r,m,W,floor) が決まったか。 */
  function detectorDone(D) { return D.nConfirmed >= D.nCombos; }

  /** 事前登録した 144 通りについて、A・B・連言を並べる。未確定は onset=null。 */
  function detectorTable(D) {
    updateConfirmed(D);
    var out = [];
    for (var ri = 0; ri < D.radii.length; ri++) {
      for (var mi = 0; mi < D.repeats.length; mi++) {
        var aKey = D.radii[ri] + ':' + D.repeats[mi];
        var firstA = D.firstA[aKey] || null;
        for (var wi = 0; wi < D.windows.length; wi++) {
          for (var fi = 0; fi < D.floors.length; fi++) {
            var key = aKey + ':' + D.windows[wi] + ':' + D.floors[fi];
            var c = D.confirmed[key] || null;
            var cab = D.confirmedAB[key] || null;
            out.push({
              radius: D.radii[ri], repeats: D.repeats[mi],
              window: D.windows[wi], floor: D.floors[fi],
              A: !!firstA, onsetA: firstA ? firstA.onset : null,
              periodA: firstA ? firstA.period : null,
              conjunction: !!c,
              onset: c ? c.onset : null, detect: c ? c.detect : null,
              lastT: c ? c.lastT : null, period: c ? c.period : null,
              dx: c ? c.dx : null, dy: c ? c.dy : null,
              driftRate: c ? c.driftRate : null,
              eventRank: c ? c.rank : null,
              conjunctionAB: !!cab,
              onsetAB: cab ? cab.onset : null, periodAB: cab ? cab.period : null,
              driftRateAB: cab ? cab.driftRate : null,
              nEvents: D.events[ri][mi].length,
              overflow: D.overflow[ri][mi],
            });
          }
        }
      }
    }
    return out;
  }

  // ------------------------------------------- 素朴な総当たりの検出器（検算用）

  /**
   * sigma を文字列として全部保存し、P=1..maxPeriod を総当たりする素朴な実装。
   * 速い検出器と一致することを selftest で確かめる（K-12: 近道の検算）。
   */
  function bruteForceDetect(opts) {
    var radius = opts.radius, m = opts.repeats, maxPeriod = opts.maxPeriod || 512;
    var steps = opts.steps;
    var w = createWorld(opts.world);
    var offs = localOffsets(radius);
    var hist = [];
    function snap() {
      var base = (w.y + w.half) * w.span + (w.x + w.half);
      var fwdX = DX[w.h], fwdY = DY[w.h];
      var rgtX = DX[(w.h + 1) & 3], rgtY = DY[(w.h + 1) & 3];
      var s = String(w.h);
      for (var i = 0; i < offs.length; i++) {
        var u = offs[i][0], v = offs[i][1];
        s += ',' + w.data[base + (u * rgtY + v * fwdY) * w.span + (u * rgtX + v * fwdX)];
      }
      hist.push({ x: w.x, y: w.y, h: w.h, s: s });
    }
    snap();
    for (var t = 1; t <= steps; t++) {
      if (!stepWorld(w)) break;
      snap();
      for (var P = 1; P <= maxPeriod; P++) {
        if (t - m * P < 0) break;
        var ok = true;
        var a0 = hist[t], b0 = hist[t - P];
        if (b0.s !== a0.s || b0.h !== a0.h) continue;
        var dx = a0.x - b0.x, dy = a0.y - b0.y;
        for (var i2 = 2; i2 <= m; i2++) {
          var aa = hist[t - (i2 - 1) * P], bb = hist[t - i2 * P];
          if (bb.s !== a0.s || bb.h !== a0.h || aa.x - bb.x !== dx || aa.y - bb.y !== dy) { ok = false; break; }
        }
        if (ok) return { onset: t - m * P, detect: t, period: P, dx: dx, dy: dy };
      }
    }
    return null;
  }

  // ------------------------------------------------------------- 走らせ役

  /**
   * ノブを1つも含まない副次的な秩序変数。
   * 周期 P・変位 d が与えられたとき、「位置と向きが周期 P・変位 d で一致する状態が
   * 最後まで途切れない最小の時刻 T」を素朴に遡って求める。
   * P と d は系が自分で供給した粒度であり、こちらが選ぶ余地は無い（K-10）。
   */
  function findTrueOnset(tr, n, P, dx, dy) {
    for (var t = n - P; t >= 0; t--) {
      if (tr.x[t + P] - tr.x[t] !== dx || tr.y[t + P] - tr.y[t] !== dy || tr.h[t + P] !== tr.h[t]) return t + 1;
    }
    return 0;
  }

  function makeTrace(cap) {
    return { x: new Int32Array(cap + 1), y: new Int32Array(cap + 1), h: new Uint8Array(cap + 1), cap: cap, n: 0 };
  }

  /**
   * 1レプリケートを走らせる。全ての (r,m,W,floor) が決まったら止める。
   * trace を渡すと位置と向きの全履歴を書き込む（findTrueOnset 用）。
   */
  function runReplicate(worldOpts, detOpts, maxSteps, trace, onStep) {
    var w = createWorld(worldOpts);
    var D = createDetector(w, detOpts);
    if (trace) { trace.n = 0; trace.x[0] = w.x; trace.y[0] = w.y; trace.h[0] = w.h; }
    var t = 0;
    while (t < maxSteps) {
      if (!stepWorld(w)) break;
      record(D, w);
      t++;
      if (trace && t <= trace.cap) { trace.x[t] = w.x; trace.y[t] = w.y; trace.h[t] = w.h; trace.n = t; }
      if (onStep) onStep(w, D);
      if (detectorDone(D)) break;
    }
    return { world: w, detector: D, steps: w.steps, truncated: !detectorDone(D) && !w.out };
  }

  return {
    DX: DX, DY: DY, TURN: TURN, DEFAULTS: DEFAULTS, RING: RING, ringSizeFor: ringSizeFor,
    makeRng: makeRng, parseRule: parseRule,
    createWorld: createWorld, seedLattice: seedLattice, indexOf: indexOf,
    stepWorld: stepWorld, unstepWorld: unstepWorld,
    fingerprint: fingerprint, countNonZero: countNonZero,
    localOffsets: localOffsets,
    createDetector: createDetector, record: record, verify: verify,
    detectorDone: detectorDone, detectorTable: detectorTable, updateConfirmed: updateConfirmed,
    bruteForceDetect: bruteForceDetect, runReplicate: runReplicate,
    findTrueOnset: findTrueOnset, makeTrace: makeTrace,
  };
});
