/**
 * S-06: 結合した複製子の輪と、輪へ何も返さない一状態（空間があると何が変わるか）
 *
 * 核が持つ概念はこれだけである:
 *
 *   - 格子の各点は「空」か、K 個の状態のいずれか
 *   - 占有された点は確率 vacateProb で空になる
 *   - 空の点は、近傍に居る状態 s の密度 f_s と、s の「相手」partnerOf[s] の密度 f_p の
 *     積に比例する確率で s になる:   a_s = f_s · (base + coupling · strength_s · f_p)
 *   - partnerOf[s] = 0 は「相手を要さない」の意味（f_p を 1 と見なす）
 *
 * **ハイパーサイクルも寄生体も、核の中には無い。** どちらも結合表 partnerOf / strength の
 * 形の違いにすぎない。輪は partnerOf が巡回置換になっている表であり、寄生体は
 * 「誰かを相手に指定するが、誰からも相手に指定されない」1行が足された表である。
 * その呼び名は観測器とレポートの側にある。
 *
 * **よく混ぜた系と空間のある系の違いは、近傍をどこから引くかの1点だけ**にした:
 *   mixed=false → 自分の周り（チェビシェフ距離 radius 以内・周期境界。既定では 8 点）
 *   mixed=true  → 格子全体から一様に引いた、同じ数の点
 * 規則・パラメータ・引く点の数・初期条件・投入手続きはすべて共通である。
 * したがって両者の差は、近傍の位置関係だけから来る。
 *
 * 依存ゼロ。Node（生ログ生成）とブラウザ（可視化）が同じファイルを読む。
 *
 * 出典（アイデアのみ。コードは参照していない）:
 *   Eigen, M. & Schuster, P. (1977-1978) "The Hypercycle: A Principle of Natural
 *     Self-Organization" Naturwissenschaften 64, 541 / 65, 7 / 65, 341
 *   Boerlijst, M. C. & Hogeweg, P. (1991) "Spiral wave structure in pre-biotic
 *     evolution: Hypercycles stable against parasites" Physica D 48, 17-28
 *
 * 実装上の注記: 数値核なので型付き配列をその場で書き換える（S-01・S-02 と同じ流儀）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S06 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** mulberry32。シードを固定すれば完全に再現する。 */
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  var DEFAULTS = {
    size: 100,          // 正方トーラスの一辺
    coupling: 1.0,      // 相手の密度に比例する項の係数
    base: 0.0,          // 相手に依らない項（0 なら相手が居なければ何も生じない）
    vacateProb: 0.02,   // 占有された点が空になる確率（1 回の更新あたり）
    mixed: false,       // true なら近傍を格子全体から引く（よく混ぜた系）
    radius: 1,          // 近傍の広さ（チェビシェフ距離）。(2r+1)^2 - 1 点を見る
    diffusion: 0.0,     // 1 世代あたり、点あたりの隣接交換の回数
  };

  // ------------------------------------------------------------- 結合表

  /**
   * 結合表を作る。
   * @param {number} ring      巡回に参加する状態の数。状態 1..ring が輪をなす
   * @param {Array}  extra     追加の行 [{partner, strength}]。輪の外側の状態になる
   * @param {object} opts      { detach: true } で全行の相手を外す（結合を切った対照系）
   */
  function makeTable(ring, extra, opts) {
    var o = opts || {};
    var partnerOf = [0], strength = [0];
    for (var i = 1; i <= ring; i++) {
      partnerOf.push(o.detach ? 0 : (i === 1 ? ring : i - 1));
      strength.push(1);
    }
    (extra || []).forEach(function (e) {
      partnerOf.push(o.detach ? 0 : e.partner);
      strength.push(e.strength);
    });
    return { states: partnerOf.length - 1, ring: ring, partnerOf: partnerOf, strength: strength };
  }

  // ------------------------------------------------------------- 世界

  function createWorld(opts, seed) {
    var p = {};
    Object.keys(DEFAULTS).forEach(function (k) { p[k] = DEFAULTS[k]; });
    Object.keys(opts || {}).forEach(function (k) { if (opts[k] != null) p[k] = opts[k]; });
    if (!p.table) throw new Error('table（結合表）が要る');

    var L = p.size, N = L * L, K = p.table.states;
    var w = {
      params: p,
      table: p.table,
      size: L,
      n: N,
      states: K,
      ring: p.table.ring,
      partnerOf: p.table.partnerOf,
      strength: p.table.strength,
      grid: new Uint8Array(N),
      count: new Int32Array(K + 1),
      rng: makeRng(seed),
      seed: seed,
      step: 0,
      clamped: 0,       // 生成確率の合計が 1 を超えて頭打ちになった回数（本来 0 のはず）
      scratchF: new Float64Array(K + 1),
      scratchA: new Float64Array(K + 1),
      offsets: makeOffsets(p.radius),
      // 直前にその点を占めていた状態（空になったときに記録する）
      last: new Uint8Array(N),
      // transitions[u*(K+1)+v] = 直前に u が居た点が v で埋まった回数。観測器が読む
      transitions: new Float64Array((K + 1) * (K + 1)),
    };
    w.neighborCount = w.offsets.length / 2;
    w.count[0] = N;
    return w;
  }

  /** 状態 s を fraction の割合の点へ撒く（空の点にも占有された点にも置く）。 */
  function scatter(w, stateList, fraction) {
    var target = Math.round(fraction * w.n);
    for (var t = 0; t < target; t++) {
      var idx = (w.rng() * w.n) | 0;
      var s = stateList[(w.rng() * stateList.length) | 0];
      w.count[w.grid[idx]]--;
      w.grid[idx] = s;
      w.count[s]++;
    }
  }

  /**
   * fraction の割合の点を状態 s へ置き換える。
   *
   * mode='patch'（既定）は正方形の塊としてまとめて置く。**よく混ぜた系では点の位置が
   * 規則に一切入らないので、塊で置くのとばら撒くのは同じ手続きである**——したがって
   * この 1 つの手続きで両者に公平な投入になる。
   * mode='scatter' は一様にばら撒く（比較用）。
   *
   * @returns {number} 実際に置き換えた点の数
   */
  function injectState(w, s, fraction, mode) {
    var target = Math.round(fraction * w.n), placed = 0, t, idx, cur;

    if (mode === 'scatter') {
      for (t = 0; t < target; t++) {
        idx = (w.rng() * w.n) | 0;
        cur = w.grid[idx];
        if (cur === s) continue;
        w.count[cur]--; w.grid[idx] = s; w.count[s]++; placed++;
      }
      return placed;
    }

    var side = Math.max(1, Math.round(Math.sqrt(target)));
    var L = w.size;
    var ox = (w.rng() * L) | 0, oy = (w.rng() * L) | 0;
    for (var dy = 0; dy < side; dy++) {
      for (var dx = 0; dx < side; dx++) {
        idx = ((oy + dy) % L) * L + ((ox + dx) % L);
        cur = w.grid[idx];
        if (cur === s) continue;
        w.count[cur]--; w.grid[idx] = s; w.count[s]++; placed++;
      }
    }
    return placed;
  }

  /** 隣接する 2 点を入れ替える（拡散）。1 世代あたり diffusion·N 回。 */
  function diffuse(w) {
    var reps = Math.round(w.params.diffusion * w.n);
    if (reps <= 0) return;
    var g = w.grid, rng = w.rng, L = w.size, N = w.n;
    for (var t = 0; t < reps; t++) {
      var idx = (rng() * N) | 0;
      var x = idx % L, y = (idx - x) / L;
      var d = (rng() * 4) | 0;
      var nx = x + (d === 0 ? 1 : d === 1 ? -1 : 0);
      var ny = y + (d === 2 ? 1 : d === 3 ? -1 : 0);
      if (nx < 0) nx = L - 1; else if (nx >= L) nx = 0;
      if (ny < 0) ny = L - 1; else if (ny >= L) ny = 0;
      var jdx = ny * L + nx;
      var tmp = g[idx]; g[idx] = g[jdx]; g[jdx] = tmp;
    }
  }

  // ------------------------------------------------------------- 近傍

  /**
   * 近傍の状態別の個数を out へ書き、引いた点の数を返す。
   *
   * **ここだけが mixed / 空間の分岐点である。** 他の規則は完全に共通で、
   * 引く点の数もどちらも (2r+1)^2 - 1 個に揃えてある。違うのは引く場所だけ:
   *   mixed=false → 自分の周り（チェビシェフ距離 r 以内・周期境界）
   *   mixed=true  → 格子全体から一様に
   */
  function neighborCounts(w, idx, out) {
    var K = w.states, g = w.grid, s, t;
    for (s = 0; s <= K; s++) out[s] = 0;
    var m = w.neighborCount;

    if (w.params.mixed) {
      var rng = w.rng, N = w.n;
      for (t = 0; t < m; t++) out[g[(rng() * N) | 0]]++;
      return m;
    }

    var L = w.size, off = w.offsets;
    var x = idx % L, y = (idx - x) / L;
    for (t = 0; t < m; t++) {
      var nx = x + off[t * 2], ny = y + off[t * 2 + 1];
      if (nx < 0) nx += L; else if (nx >= L) nx -= L;
      if (ny < 0) ny += L; else if (ny >= L) ny -= L;
      out[g[ny * L + nx]]++;
    }
    return m;
  }

  /** チェビシェフ距離 r 以内（自分を除く）の相対座標を並べる。 */
  function makeOffsets(r) {
    var off = [];
    for (var dy = -r; dy <= r; dy++) {
      for (var dx = -r; dx <= r; dx++) {
        if (dx === 0 && dy === 0) continue;
        off.push(dx, dy);
      }
    }
    return new Int32Array(off);
  }

  // ------------------------------------------------------------- 時間発展

  /**
   * 1 世代 = N 回の非同期な点の更新（毎回一様に点を選ぶ）＋ 拡散。
   * 拡散は mixed でも同じ回数だけ行う（手続きを両者で完全に揃えるため。
   * mixed では近傍を格子全体から引くので、入れ替えても規則には効かない）。
   */
  function stepWorld(w) {
    var N = w.n, g = w.grid, rng = w.rng, p = w.params, K = w.states;
    var f = w.scratchF, a = w.scratchA;
    var cnt = w.count, partner = w.partnerOf, str = w.strength;
    var base = p.base, coup = p.coupling, vac = p.vacateProb;

    for (var u = 0; u < N; u++) {
      var idx = (rng() * N) | 0;
      var cur = g[idx];

      if (cur !== 0) {
        if (rng() < vac) { g[idx] = 0; cnt[cur]--; cnt[0]++; w.last[idx] = cur; }
        continue;
      }

      var m = neighborCounts(w, idx, f);
      var total = 0, k;
      for (k = 1; k <= K; k++) {
        var fk = f[k];
        if (fk === 0) { a[k] = 0; continue; }
        var pr = partner[k];
        var sup = pr === 0 ? 1 : f[pr] / m;
        var v = (fk / m) * (base + coup * str[k] * sup);
        a[k] = v;
        total += v;
      }
      if (total <= 0) continue;

      // 合計が 1 を超えることは既定のパラメータでは起きない（起きたら数える）。
      if (total > 1) {
        w.clamped++;
        for (k = 1; k <= K; k++) a[k] /= total;
        total = 1;
      }

      var r = rng();
      if (r >= total) continue;
      var acc = 0;
      for (k = 1; k <= K; k++) {
        acc += a[k];
        if (r < acc) {
          g[idx] = k; cnt[k]++; cnt[0]--;
          w.transitions[w.last[idx] * (K + 1) + k]++;
          break;
        }
      }
    }
    diffuse(w);
    w.step++;
  }

  /** count が格子と一致しているかを数え直して確かめる（増分更新の検算用）。 */
  function recount(w) {
    var c = new Int32Array(w.states + 1);
    for (var i = 0; i < w.n; i++) c[w.grid[i]]++;
    return c;
  }

  // ------------------------------------------------------------- 平均場（常微分方程式）

  /**
   * 同じ規則の平均場極限。x[0] は空の割合、x[k] は状態 k の割合。
   *   dx_k/dt = x_0 · x_k · (base + coupling · strength_k · x_partner) − vacate · x_k
   * よく混ぜた確率過程が正しく実装されているかの検算に使う。
   */
  function odeDerivative(x, table, p, out) {
    var K = table.states, x0 = x[0], k;
    out[0] = 0;
    for (k = 1; k <= K; k++) {
      var pr = table.partnerOf[k];
      var sup = pr === 0 ? 1 : x[pr];
      var growth = x0 * x[k] * (p.base + p.coupling * table.strength[k] * sup);
      out[k] = growth - p.vacateProb * x[k];
      out[0] -= out[k];
    }
    return out;
  }

  /** RK4 で 1 世代ぶん進める（dt は世代単位）。 */
  function odeStep(x, table, p, dt) {
    var K = table.states, n = K + 1;
    var k1 = new Float64Array(n), k2 = new Float64Array(n), k3 = new Float64Array(n), k4 = new Float64Array(n);
    var tmp = new Float64Array(n), out = new Float64Array(n), i;
    odeDerivative(x, table, p, k1);
    for (i = 0; i < n; i++) tmp[i] = x[i] + (dt / 2) * k1[i];
    odeDerivative(tmp, table, p, k2);
    for (i = 0; i < n; i++) tmp[i] = x[i] + (dt / 2) * k2[i];
    odeDerivative(tmp, table, p, k3);
    for (i = 0; i < n; i++) tmp[i] = x[i] + dt * k3[i];
    odeDerivative(tmp, table, p, k4);
    for (i = 0; i < n; i++) out[i] = x[i] + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
    return out;
  }

  // =============================================================== 観測器
  //
  // ここから先だけが「輪が存続したか」「寄生しているか」「螺旋が居るか」を語る。
  // 核の側にはこれらの語も概念も無い。

  /**
   * 2x2 の枠の巻き数を数える。
   *
   * 輪の状態 1..ring に位相 θ_s = 2π s / ring を割り当て、枠の四隅を反時計回りに一周して
   * 位相差の和を取る。和は必ず −ring, 0, +ring のいずれかになり、0 でない枠が**渦の芯**にあたる。
   *
   * **ring が偶数のとき、差がちょうど ring/2 の隣接対は向きが決まらない**（+ring/2 と
   * −ring/2 が同じ位相差になる）。恣意的な向き付けをせず、その対を含む枠は観測からも
   * 帰無値の数え上げからも**同じ条件で除く**。ring が奇数ならこの除外は一度も起きない。
   *
   * **ここには長さのスケールの選択が無い。** 使うのは格子の最小単位（隣接する 4 点）で、
   * これは相互作用が働くスケールそのものである（method.md K-10）。
   *
   * @param {Uint8Array} grid 状態の格子
   * @param {number} L        一辺
   * @param {number} ring     輪に参加する状態の数（1..ring だけを見る）
   */
  function windingStats(grid, L, ring, opts) {
    var o = opts || {};
    var half = (ring - 1) / 2;
    var full = 0, defects = 0, ambiguous = 0;
    var spots = o.collect ? [] : null;
    var freq = new Float64Array(ring + 1);
    var last = o.noWrap ? L - 1 : L;
    for (var y = 0; y < last; y++) {
      var yp = y === L - 1 ? 0 : y + 1;
      var r0 = y * L, r1 = yp * L;
      for (var x = 0; x < last; x++) {
        var xp = x === L - 1 ? 0 : x + 1;
        var a = grid[r0 + x], b = grid[r0 + xp], c = grid[r1 + xp], d = grid[r1 + x];
        if (a < 1 || a > ring || b < 1 || b > ring || c < 1 || c > ring || d < 1 || d > ring) continue;
        var sum = signedGap(a, b, ring, half) + signedGap(b, c, ring, half) +
                  signedGap(c, d, ring, half) + signedGap(d, a, ring, half);
        if (sum !== sum) { ambiguous++; continue; }  // 向きが決まらない対を含む枠は除く
        full++;
        if (sum !== 0) { defects++; if (spots) spots.push([x, y, sum > 0 ? 1 : -1]); }
      }
    }
    // 枠に現れた状態の頻度（帰無値の計算に使う。枠と同じ条件付けで数える）
    for (var i = 0; i < L * L; i++) { var s = grid[i]; if (s >= 1 && s <= ring) freq[s]++; }
    var tot = 0;
    for (var q = 1; q <= ring; q++) tot += freq[q];
    for (var q2 = 1; q2 <= ring; q2++) freq[q2] = tot > 0 ? freq[q2] / tot : 0;

    return {
      plaquettes: full,
      ambiguous: ambiguous,
      defects: defects,
      defectDensity: full > 0 ? defects / full : 0,
      freq: Array.prototype.slice.call(freq),
      spots: spots,
    };
  }

  /**
   * **継承の巡回比**——この核が「波」を測る主の観測量。
   *
   * 点が空いたあと別の状態で埋まったとき、直前に居た状態 u と新しい状態 v の組を数える
   * （u = v は除く）。輪に沿って回る波が通っていれば、v は u の次（u+1）に偏る。
   *
   *   cyclicRatio = P(v = u+1 | u != v) / (1 / (ring − 1))
   *
   * 分母は**理論的な帰無値**である: u と無関係に v が決まるなら、ring−1 通りのどれかが
   * 等しく起きるので P = 1/(ring−1)。したがって **帰無値は厳密に 1.0** で、
   * 長さのスケールも時間のスケールも選ばない（事象そのものを数えるため）。
   *
   * 巻き数（windingStats）との違いは**特異性**にある。巻き数は「空間的に相関しているか」
   * しか見ないので、輪を持たない系が塊に分かれただけでも下がる。こちらは
   * **輪の向きに沿って入れ替わっているか**を見るので、塊が育つだけでは 1.0 のまま動かない。
   *
   * @param {object} w      世界（transitions を持つ）
   * @param {Array}  [prev] 前に取った transitions の写し。渡すと差分だけを見る
   */
  function successionStats(w, prev) {
    var K = w.states, ring = w.ring, u, v, forward = 0, other = 0;
    for (u = 1; u <= ring; u++) {
      for (v = 1; v <= ring; v++) {
        if (u === v) continue;
        var c = w.transitions[u * (K + 1) + v] - (prev ? prev[u * (K + 1) + v] : 0);
        if (v === (u % ring) + 1) forward += c; else other += c;
      }
    }
    var total = forward + other;
    var nullP = 1 / (ring - 1);
    return {
      events: total,
      forwardShare: total > 0 ? forward / total : 0,
      nullForwardShare: nullP,
      cyclicRatio: total > 0 ? (forward / total) / nullP : 0,
    };
  }

  /** transitions の写しを取る（窓ごとに測るため）。 */
  function snapshotTransitions(w) { return Float64Array.from(w.transitions); }

  /**
   * 状態 u から v への巡回上の差を (−ring/2, ring/2) に収めて返す。
   * ちょうど ring/2（ring が偶数のときだけ起きる）は向きが決まらないので NaN を返す。
   */
  function signedGap(u, v, ring, half) {
    var d = (v - u) % ring;
    if (d < 0) d += ring;
    if (d * 2 === ring) return NaN;
    if (d > half) d -= ring;
    return d;
  }

  /**
   * 帰無値: 四隅が独立で、与えられた頻度 freq に従うときの「巻き数 != 0」の割合。
   *
   * **ring^4 通りを厳密に数え上げる**（ring=5 なら 625 通り）。モンテカルロではないので
   * 誤差が無い。向きが決まらない枠は観測側と同じ条件で除き、残りで規格化する。
   * 観測値をこれで割った比は、空間的な配置が無相関なら **理論的に 1.0**。
   */
  function nullDefectDensity(freq, ring) {
    var half = (ring - 1) / 2;
    var acc = 0, kept = 0;
    for (var a = 1; a <= ring; a++) {
      if (freq[a] === 0) continue;
      for (var b = 1; b <= ring; b++) {
        if (freq[b] === 0) continue;
        var ab = signedGap(a, b, ring, half);
        for (var c = 1; c <= ring; c++) {
          if (freq[c] === 0) continue;
          var abc = ab + signedGap(b, c, ring, half);
          for (var d = 1; d <= ring; d++) {
            if (freq[d] === 0) continue;
            var sum = abc + signedGap(c, d, ring, half) + signedGap(d, a, ring, half);
            if (sum !== sum) continue;
            var w = freq[a] * freq[b] * freq[c] * freq[d];
            kept += w;
            if (sum !== 0) acc += w;
          }
        }
      }
    }
    return kept > 0 ? acc / kept : 0;
  }

  /**
   * 観測をまとめる。
   *
   *   ringSurvival    輪の状態 1..ring が**すべて 1 点以上**残っているか（閾値を持たない。
   *                   絶滅は吸収状態なので、0 になった状態は二度と戻らない）
   *   parasiteShare   輪の外の状態が占める割合（占有された点に対する比）
   *   cyclicRatio     継承が輪の向きへ偏っている度合い。**理論的な帰無値は 1.0**。
   *                   波が回っていれば 1 より大きい（上限は ring-1）
   *   defectRatio     巻き数 != 0 の枠の割合 / 同じ頻度で無相関に並べたときの値。
   *                   **理論的な帰無値は 1.0**。小さいほど空間的に相関している
   *
   * @param {object} [prevTransitions] 渡すとその時点からの窓で cyclicRatio を測る
   */
  function measure(w, prevTransitions) {
    var ring = w.ring, K = w.states, k;
    var occupied = 0;
    for (k = 1; k <= K; k++) occupied += w.count[k];

    var ringCount = 0, minRing = Infinity, alive = 0;
    for (k = 1; k <= ring; k++) {
      ringCount += w.count[k];
      if (w.count[k] < minRing) minRing = w.count[k];
      if (w.count[k] > 0) alive++;
    }
    var outside = occupied - ringCount;

    var ws = windingStats(w.grid, w.size, ring);
    var nullD = nullDefectDensity(ws.freq, ring);
    var su = successionStats(w, prevTransitions);

    return {
      step: w.step,
      sites: w.n,
      occupancy: occupied / w.n,
      ringStatesPresent: alive,
      ringSurvival: alive === ring ? 1 : 0,
      smallestRingState: minRing === Infinity ? 0 : minRing,
      ringShare: occupied > 0 ? ringCount / occupied : 0,
      parasiteShare: occupied > 0 ? outside / occupied : 0,
      parasiteFraction: outside / w.n,
      plaquettes: ws.plaquettes,
      ambiguousPlaquettes: ws.ambiguous,
      defects: ws.defects,
      defectDensity: ws.defectDensity,
      nullDefectDensity: nullD,
      defectRatio: nullD > 0 ? ws.defectDensity / nullD : 0,
      successionEvents: su.events,
      forwardShare: su.forwardShare,
      nullForwardShare: su.nullForwardShare,
      cyclicRatio: su.cyclicRatio,
      clamped: w.clamped,
      counts: Array.prototype.slice.call(w.count),
    };
  }

  /**
   * 同じ頻度を保ったまま格子を並べ替える（帰無モデルの実体）。
   * nullDefectDensity の数え上げが正しいかを、実際に混ぜて確かめるために使う。
   */
  function shuffled(grid, rng) {
    var out = new Uint8Array(grid);
    for (var i = out.length - 1; i > 0; i--) {
      var j = (rng() * (i + 1)) | 0;
      var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out;
  }

  /**
   * 手で組んだ渦。位相が偏角に沿って一周するようにして輪の状態へ量子化する。
   * 検出器の正コントロール（芯がちょうど期待した数だけ出るか）に使う。
   * @param {number} arms 渦の芯の数（1 なら中央に 1 個）
   */
  function makeSpiralGrid(L, ring, arms) {
    var g = new Uint8Array(L * L);
    var cx = L / 2, cy = L / 2;
    for (var y = 0; y < L; y++) {
      for (var x = 0; x < L; x++) {
        var dx = x - cx + 0.5, dy = y - cy + 0.5;
        var ang = Math.atan2(dy, dx);
        var rad = Math.sqrt(dx * dx + dy * dy);
        var phase = (arms * ang) / (Math.PI * 2) + rad / 12;
        var s = Math.floor(((phase % 1) + 1) % 1 * ring) + 1;
        g[y * L + x] = s;
      }
    }
    return g;
  }

  return {
    DEFAULTS: DEFAULTS,
    makeRng: makeRng,
    makeTable: makeTable,
    createWorld: createWorld,
    scatter: scatter,
    diffuse: diffuse,
    injectState: injectState,
    neighborCounts: neighborCounts,
    makeOffsets: makeOffsets,
    stepWorld: stepWorld,
    recount: recount,
    odeDerivative: odeDerivative,
    odeStep: odeStep,
    windingStats: windingStats,
    successionStats: successionStats,
    snapshotTransitions: snapshotTransitions,
    signedGap: signedGap,
    nullDefectDensity: nullDefectDensity,
    measure: measure,
    shuffled: shuffled,
    makeSpiralGrid: makeSpiralGrid,
  };
});
