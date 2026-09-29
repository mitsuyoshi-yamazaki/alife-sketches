/**
 * S-32 核 — ランダムブール網の機構だけを持つ。
 *
 * 本ファイルが知っている語彙は **ノード・入力・真理値表・同期更新** だけである。
 * 遺伝子・細胞・個体・生存・適応・アトラクタ（＝観測側の名前）といった上位概念の語は
 * 識別子にも分岐にも現れない。周期の探索は「写像の閉じた軌道」としてだけ書かれている。
 *
 * Node とブラウザで共用する（古典スクリプト・UMD 風）。依存ゼロ。
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- 乱数

  /** mulberry32。同じ種で完全に再現する。 */
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), 1 | t);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** FNV-1a 32bit を 2 レーンで回し、8 桁 16 進 2 本を連結して返す。 */
  function hashBytes(arr) {
    var h1 = 0x811c9dc5, h2 = 0x01000193;
    for (var i = 0; i < arr.length; i++) {
      h1 ^= arr[i]; h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 = (h2 + arr[i]) >>> 0; h2 = Math.imul(h2 ^ (h2 >>> 13), 0x85ebca6b) >>> 0;
    }
    var s1 = (h1 >>> 0).toString(16), s2 = (h2 >>> 0).toString(16);
    while (s1.length < 8) s1 = '0' + s1;
    while (s2.length < 8) s2 = '0' + s2;
    return s1 + s2;
  }

  /** 配列（0/1）を 8 個ずつ 1 バイトへ詰めてから混ぜる。 */
  function stateHash(state) {
    var n = state.length, nb = (n + 7) >> 3, bytes = new Uint8Array(nb + 2);
    for (var i = 0; i < n; i++) if (state[i]) bytes[i >> 3] |= (1 << (i & 7));
    bytes[nb] = n & 255; bytes[nb + 1] = (n >> 8) & 255;
    return hashBytes(bytes);
  }

  // ---------------------------------------------------------------- 網

  /**
   * 網を作る。
   *   N        ノード数
   *   K        各ノードの入力数
   *   p        真理値表の各マスが 1 になる確率
   *   seed     乱数種
   *   wiring   'replace'（重複と自己を許す・既定）/ 'distinct'（相異なる・自己を含まない）
   *   effK     真理値表が実際に依存する入力の数（既定 = K）。effK < K の表は先頭 effK 本だけを見る
   *   fixed    'none'（既定）/ 'shift'（入力 0 をそのまま返す）/ 'const0' / 'const1'
   */
  function makeNetwork(opt) {
    var N = opt.N, K = opt.K, p = opt.p == null ? 0.5 : opt.p;
    var rng = makeRng(opt.seed >>> 0);
    var wiring = opt.wiring || 'replace';
    var effK = opt.effK == null ? K : opt.effK;
    var fixed = opt.fixed || 'none';
    var rows = 1 << K;
    var inputs = new Int32Array(N * K);
    var table = new Uint8Array(N * rows);
    var i, j, k, r, pick, ok;

    for (i = 0; i < N; i++) {
      if (wiring === 'distinct') {
        for (j = 0; j < K; j++) {
          do {
            pick = (rng() * N) | 0; if (pick >= N) pick = N - 1;
            ok = pick !== i;
            for (k = 0; k < j && ok; k++) if (inputs[i * K + k] === pick) ok = false;
          } while (!ok);
          inputs[i * K + j] = pick;
        }
      } else {
        for (j = 0; j < K; j++) {
          pick = (rng() * N) | 0; if (pick >= N) pick = N - 1;
          inputs[i * K + j] = pick;
        }
      }
      for (r = 0; r < rows; r++) {
        var v;
        if (fixed === 'shift') v = (r & 1);
        else if (fixed === 'const0') v = 0;
        else if (fixed === 'const1') v = 1;
        else if (effK < K) v = 0;                  // 後で effK 本だけで埋め直す
        else v = rng() < p ? 1 : 0;
        table[i * rows + r] = v;
      }
      if (fixed === 'none' && effK < K) {
        // 先頭 effK 本の入力にだけ依存する表にする（残りの入力は配線されているが無視される）
        var sub = new Uint8Array(1 << effK);
        for (r = 0; r < sub.length; r++) sub[r] = rng() < p ? 1 : 0;
        for (r = 0; r < rows; r++) table[i * rows + r] = sub[r & ((1 << effK) - 1)];
      }
    }
    return { N: N, K: K, p: p, rows: rows, inputs: inputs, table: table,
             wiring: wiring, effK: effK, fixed: fixed, seed: opt.seed >>> 0 };
  }

  /** ノード i が src のもとで取る行番号。 */
  function rowIndex(net, src, i) {
    var K = net.K, base = i * K, idx = 0;
    for (var j = 0; j < K; j++) if (src[net.inputs[base + j]]) idx |= (1 << j);
    return idx;
  }

  /** 同期更新 1 回。src から dst へ。dst と src は別の配列であること。 */
  function stepState(net, src, dst) {
    var N = net.N, K = net.K, rows = net.rows, inputs = net.inputs, table = net.table;
    for (var i = 0; i < N; i++) {
      var base = i * K, idx = 0;
      for (var j = 0; j < K; j++) if (src[inputs[base + j]]) idx |= (1 << j);
      dst[i] = table[i * rows + idx];
    }
  }

  /** 一様乱択の状態。 */
  function randomState(N, rng) {
    var s = new Uint8Array(N);
    for (var i = 0; i < N; i++) s[i] = rng() < 0.5 ? 1 : 0;
    return s;
  }

  function equalState(a, b) {
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  }

  function hamming(a, b) {
    var c = 0;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) c++;
    return c;
  }

  // ------------------------------------------------- 忘れ方（参照点の作り方）
  //
  // 'none'    何も忘れない（実際の網）
  // 'table'   毎ステップ真理値表を引き直す。2 本の軌道で行番号が同じなら同じ値、
  //           違うなら独立に引く（＝焼きなまし表）
  // 'wiring'  毎ステップ配線を引き直す（表は据え置き）
  // 'both'    表も配線も毎ステップ引き直す

  /**
   * 2 本の状態を同時に 1 ステップ進める。forget に応じて網の一部を引き直す。
   * dstA / dstB は src と別の配列。
   */
  function stepPair(net, srcA, srcB, dstA, dstB, forget, rng) {
    var N = net.N, K = net.K, rows = net.rows, inputs = net.inputs, table = net.table, p = net.p;
    var i, j, idxA, idxB, base, w;
    for (i = 0; i < N; i++) {
      base = i * K; idxA = 0; idxB = 0;
      for (j = 0; j < K; j++) {
        if (forget === 'wiring' || forget === 'both') {
          w = (rng() * N) | 0; if (w >= N) w = N - 1;
        } else w = inputs[base + j];
        if (srcA[w]) idxA |= (1 << j);
        if (srcB[w]) idxB |= (1 << j);
      }
      if (forget === 'table' || forget === 'both') {
        var vA = rng() < p ? 1 : 0;
        dstA[i] = vA;
        dstB[i] = idxA === idxB ? vA : (rng() < p ? 1 : 0);
      } else {
        dstA[i] = table[i * rows + idxA];
        dstB[i] = table[i * rows + idxB];
      }
    }
  }

  /**
   * 2 本の軌道の食い違い数の時系列を返す。
   *   m[0] = 初期の食い違い数, m[t] = t ステップ後の食い違い数
   * 戻り値 { m: Int32Array(T+1), hashA, hashB }
   */
  function separationSeries(net, stateA, stateB, T, forget, rng) {
    var N = net.N;
    var a = Uint8Array.from(stateA), b = Uint8Array.from(stateB);
    var a2 = new Uint8Array(N), b2 = new Uint8Array(N), tmp;
    var m = new Int32Array(T + 1);
    m[0] = hamming(a, b);
    for (var t = 1; t <= T; t++) {
      stepPair(net, a, b, a2, b2, forget || 'none', rng);
      tmp = a; a = a2; a2 = tmp;
      tmp = b; b = b2; b2 = tmp;
      m[t] = hamming(a, b);
    }
    return { m: m, hashA: stateHash(a), hashB: stateHash(b) };
  }

  // ------------------------------------------- 閉じた軌道の探索（Brent 法）
  //
  // 有限集合上の決定的な写像は必ず閉じた軌道へ落ちる（K-55）。
  // Brent 法は記憶 O(N) で「閉じた軌道の長さ」と「そこへ入るまでの長さ」を出す。

  /**
   * 閉じた軌道を探す。
   * 戻り値 { period, entry, steps, truncated, orbitKey, endHash }
   *   period    閉じた軌道の長さ（truncated のとき null）
   *   entry     初期状態から閉じた軌道へ入るまでのステップ数
   *   steps     消費した写像適用回数（打ち切りの上限に数える）
   *   orbitKey  閉じた軌道の正準な識別子（軌道上の全状態のハッシュの最小値）
   */
  function findClosedOrbit(net, state0, maxSteps) {
    var N = net.N;
    var tort = Uint8Array.from(state0);
    var hare = new Uint8Array(N), tmp = new Uint8Array(N), sw;
    stepState(net, tort, hare);
    var steps = 1, power = 1, lam = 1;

    while (!equalState(tort, hare)) {
      if (power === lam) { tort.set(hare); power *= 2; lam = 0; }
      stepState(net, hare, tmp); sw = hare; hare = tmp; tmp = sw;
      steps++; lam++;
      if (steps >= maxSteps) {
        return { period: null, entry: null, steps: steps, truncated: true,
                 orbitKey: null, endHash: stateHash(hare) };
      }
    }

    // 入るまでの長さ
    var x = Uint8Array.from(state0), y = Uint8Array.from(state0);
    for (var i = 0; i < lam; i++) {
      stepState(net, y, tmp); sw = y; y = tmp; tmp = sw; steps++;
      if (steps >= maxSteps) {
        return { period: lam, entry: null, steps: steps, truncated: true,
                 orbitKey: null, endHash: stateHash(y) };
      }
    }
    var mu = 0;
    while (!equalState(x, y)) {
      stepState(net, x, tmp); sw = x; x = tmp; tmp = sw;
      stepState(net, y, tmp); sw = y; y = tmp; tmp = sw;
      mu++; steps += 2;
      if (steps >= maxSteps) {
        return { period: lam, entry: null, steps: steps, truncated: true,
                 orbitKey: null, endHash: stateHash(x) };
      }
    }

    // 軌道上を 1 周して正準な識別子と記述子を作る
    var key = null, ones = 0, cur = Uint8Array.from(x);
    for (var t = 0; t < lam; t++) {
      var h = stateHash(cur);
      if (key === null || h < key) key = h;
      for (var q = 0; q < N; q++) ones += cur[q];
      stepState(net, cur, tmp); sw = cur; cur = tmp; tmp = sw;
      steps++;
      if (steps >= maxSteps) {
        return { period: lam, entry: mu, steps: steps, truncated: true,
                 orbitKey: null, endHash: stateHash(cur) };
      }
    }
    return { period: lam, entry: mu, steps: steps, truncated: false,
             orbitKey: key, orbitOnes: ones, endHash: stateHash(x) };
  }

  /**
   * 小さい N でだけ使う総当たり。全 2^N 状態の後続を作り、閉じた軌道を厳密に数える。
   * 戻り値 { orbits: [{period, states:[...], id}], periodOf: Int32Array(2^N), entryOf: Int32Array }
   */
  function enumerateAll(net) {
    var N = net.N;
    if (N > 20) throw new Error('enumerateAll: N が大きすぎる');
    var M = 1 << N;
    var next = new Int32Array(M);
    var src = new Uint8Array(N), dst = new Uint8Array(N);
    var s, i, v;
    for (s = 0; s < M; s++) {
      for (i = 0; i < N; i++) src[i] = (s >> i) & 1;
      stepState(net, src, dst);
      v = 0;
      for (i = 0; i < N; i++) if (dst[i]) v |= (1 << i);
      next[s] = v;
    }
    // 0=未訪問, 1=処理中, 2=確定
    var mark = new Uint8Array(M);
    var periodOf = new Int32Array(M), entryOf = new Int32Array(M), orbitOf = new Int32Array(M);
    var orbits = [];
    var stack = new Int32Array(M);
    for (s = 0; s < M; s++) {
      if (mark[s]) continue;
      var top = 0, cur = s;
      while (mark[cur] === 0) { mark[cur] = 1; stack[top++] = cur; cur = next[cur]; }
      if (mark[cur] === 1) {
        // 新しい閉じた軌道。cur から一周する
        var cyc = [], z = cur;
        do { cyc.push(z); z = next[z]; } while (z !== cur);
        var oid = orbits.length;
        orbits.push({ period: cyc.length, states: cyc, id: oid });
        for (i = 0; i < cyc.length; i++) {
          periodOf[cyc[i]] = cyc.length; entryOf[cyc[i]] = 0;
          orbitOf[cyc[i]] = oid; mark[cyc[i]] = 2;
        }
      }
      // 尻尾を戻しながら確定させる
      for (i = top - 1; i >= 0; i--) {
        var u = stack[i];
        if (mark[u] === 2) continue;
        var w = next[u];
        periodOf[u] = periodOf[w]; entryOf[u] = entryOf[w] + 1;
        orbitOf[u] = orbitOf[w]; mark[u] = 2;
      }
    }
    return { orbits: orbits, periodOf: periodOf, entryOf: entryOf, orbitOf: orbitOf, next: next };
  }

  /** ノードごとに「表が定数か」を返す（配線を見ない、表だけの性質）。 */
  function constantTableMask(net) {
    var out = new Uint8Array(net.N);
    for (var i = 0; i < net.N; i++) {
      var v = net.table[i * net.rows], same = 1;
      for (var r = 1; r < net.rows; r++) if (net.table[i * net.rows + r] !== v) { same = 0; break; }
      out[i] = same;
    }
    return out;
  }

  var api = {
    makeRng: makeRng, hashBytes: hashBytes, stateHash: stateHash,
    makeNetwork: makeNetwork, stepState: stepState, rowIndex: rowIndex,
    randomState: randomState, equalState: equalState, hamming: hamming,
    stepPair: stepPair, separationSeries: separationSeries,
    findClosedOrbit: findClosedOrbit, enumerateAll: enumerateAll,
    constantTableMask: constantTableMask,
  };

  global.S32 = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : this);
