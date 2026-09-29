/**
 * S-34 の核。**上位概念の語彙を持たない。**
 *
 * ここが知っているのは次の3つだけ:
 *   1. 「種ごとの個数」（整数のベクトル。空間も配列も無い）
 *   2. 「取り込み／離脱の速さの行列」（boost。いま入っている組成に依存して速さが変わる）
 *   3. 「総数が閾値を超えたら2つに割る」
 *
 * gene / organism / alive / fitness / catalyst / composome / heredity / selection の語は
 * 識別子にも分岐にも使わない。それらは observe.js と run.js の側の語彙である。
 *
 * 速度式（実装しているもの）:
 *   dn_i/dt = ( influx_i * N  -  outflow * n_i ) * Phi_i
 *   Phi_i   = 1 + (1/N) * sum_j boost[i][j] * n_j
 * source=self の旗を立てると influx_i * N を influxTotal * n_i へ差し替える。
 *
 * Node とブラウザで共用する（module.exports と window.S34 の両方へ出す）。依存ゼロ・古典スクリプト。
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- 乱数

  /** mulberry32。整数シード1つで完全に決まる。 */
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Box-Muller。標準正規を1つ返す。 */
  function normal(rng) {
    var u = 1 - rng(), v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // ---------------------------------------------------------------- 速さの行列

  /**
   * boost[i*kinds+j] = 種 j が 1 個入っているときに種 i の出入りへ乗る上乗せ。
   * ln boost ~ Normal(., sigma^2) を引いたあと、**標本平均がちょうど bmean になるよう一律に割る**。
   * こうすると sigma は「上乗せの不揃いさ」だけを動かし、時間尺度（平均の上乗せ）は動かない。
   * sigma=0 なら全要素がちょうど bmean で等しい。
   */
  function makeBoost(kinds, bmean, sigma, rng) {
    var K = kinds * kinds, b = new Float64Array(K), s = 0, i;
    for (i = 0; i < K; i++) { b[i] = Math.exp(sigma > 0 ? sigma * normal(rng) : 0); s += b[i]; }
    var scale = bmean * K / s;
    for (i = 0; i < K; i++) b[i] *= scale;
    return b;
  }

  /** 非対角を 0 にする（種どうしの相互の上乗せを切る）。 */
  function offDiagonalToZero(boost, kinds) {
    var b = new Float64Array(boost);
    for (var i = 0; i < kinds; i++) {
      for (var j = 0; j < kinds; j++) if (i !== j) b[i * kinds + j] = 0;
    }
    return b;
  }

  // ---------------------------------------------------------------- 設定

  /**
   * o: {kinds, influxTotal, outflow, boost, splitAt, sourceFromSelf}
   * influx_i は既定で influxTotal / kinds（全種等しい）。o.influx を渡せば上書きできる。
   */
  function makeParams(o) {
    var kinds = o.kinds;
    var influx = new Float64Array(kinds);
    if (o.influx) { for (var i = 0; i < kinds; i++) influx[i] = o.influx[i]; }
    else { for (var j = 0; j < kinds; j++) influx[j] = o.influxTotal / kinds; }
    var tot = 0;
    for (var m = 0; m < kinds; m++) tot += influx[m];
    return {
      kinds: kinds,
      influx: influx,
      influxTotal: tot,
      outflow: o.outflow,
      boost: o.boost,
      splitAt: o.splitAt,
      sourceFromSelf: !!o.sourceFromSelf,
      // 上乗せ Phi_i が「入りと出の両方」に掛かるか「入りだけ」か。
      // 二次資料2本がこの括弧の掛かり方を違えて書いている（criteria.json の sourceFidelity を見よ）。
      enhanceMode: o.enhanceMode || 'both',
    };
  }

  /** 取り込み元の組成（＝外の環境の組成）。ODE の組成の不動方向でもある。 */
  function sourceShare(P) {
    var f = new Float64Array(P.kinds);
    for (var i = 0; i < P.kinds; i++) f[i] = P.influx[i] / P.influxTotal;
    return f;
  }

  // ---------------------------------------------------------------- 容器

  /** counts から容器を作る。S[i] = sum_j boost[i][j]*n[j] を持ち回る（近道）。 */
  function makeBag(P, counts, id, parent, gen) {
    var k = P.kinds;
    var n = new Int32Array(k), N = 0;
    for (var i = 0; i < k; i++) { n[i] = counts[i] | 0; N += n[i]; }
    var S = new Float64Array(k);
    for (var r = 0; r < k; r++) {
      var s = 0, base = r * k;
      for (var c = 0; c < k; c++) s += P.boost[base + c] * n[c];
      S[r] = s;
    }
    return { id: id, parent: parent, gen: gen, n: n, N: N, S: S, t: 0, events: 0 };
  }

  /** 種 i を d 個（±1）動かす。S を増分で保つ。 */
  function bump(P, bag, i, d) {
    var k = P.kinds;
    bag.n[i] += d;
    bag.N += d;
    for (var r = 0; r < k; r++) bag.S[r] += d * P.boost[r * k + i];
  }

  /** 素朴な総当たりで S を計算し直す（近道の検算用）。 */
  function recomputeS(P, bag) {
    var k = P.kinds, S = new Float64Array(k);
    for (var r = 0; r < k; r++) {
      var s = 0, base = r * k;
      for (var c = 0; c < k; c++) s += P.boost[base + c] * bag.n[c];
      S[r] = s;
    }
    return S;
  }

  /** buf[2i] = 入る速さ、buf[2i+1] = 出る速さ。合計を返す。 */
  function fillRates(P, bag, buf) {
    var k = P.kinds, N = bag.N, tot = 0, self = P.sourceFromSelf, both = P.enhanceMode !== 'inOnly';
    for (var i = 0; i < k; i++) {
      var phi = 1 + bag.S[i] / N;
      var rin = (self ? P.influxTotal * bag.n[i] : P.influx[i] * N) * phi;
      var rout = P.outflow * bag.n[i] * (both ? phi : 1);
      buf[2 * i] = rin;
      buf[2 * i + 1] = rout;
      tot += rin + rout;
    }
    return tot;
  }

  /** 確率的に1事象だけ進める（Gillespie）。何も起きなければ false。 */
  function stepOnce(P, bag, rng, buf) {
    var tot = fillRates(P, bag, buf);
    if (!(tot > 0)) return false;
    bag.t += -Math.log(1 - rng()) / tot;
    var x = rng() * tot, acc = 0, j = 0, last = 2 * P.kinds - 1;
    for (; j < last; j++) { acc += buf[j]; if (x < acc) break; }
    bump(P, bag, j >> 1, (j & 1) ? -1 : 1);
    bag.events++;
    return true;
  }

  /** splitAt に届くまで確率的に進める。上限に当たったら hitLimit を立てる（K-63）。 */
  function growToSplit(P, bag, rng, maxEvents) {
    var buf = new Float64Array(2 * P.kinds), ev = 0, hit = false;
    while (bag.N < P.splitAt) {
      if (ev >= maxEvents) { hit = true; break; }
      if (bag.N <= 0) break;
      if (!stepOnce(P, bag, rng, buf)) break;
      ev++;
    }
    return { events: ev, hitLimit: hit, N: bag.N };
  }

  // ---------------------------------------------------------------- 分裂

  /**
   * mode 'binomial': 各分子を独立に確率 1/2 で左右へ振る（＝多変量超幾何の標本）。
   * mode 'copy'   : 端数を最大剰余法で配る（組成を保ったまま揺れを入れない）。
   */
  function splitCounts(P, n, rng, mode) {
    var k = P.kinds, a = new Int32Array(k), b = new Int32Array(k), i, c;
    if (mode === 'copy') {
      var rem = [], half = 0;
      for (i = 0; i < k; i++) { a[i] = Math.floor(n[i] / 2); half += a[i]; rem.push([n[i] - 2 * a[i], i]); }
      var N = 0;
      for (i = 0; i < k; i++) N += n[i];
      var want = Math.floor(N / 2);
      rem.sort(function (p, q) { return q[0] - p[0] || p[1] - q[1]; });
      for (i = 0; i < rem.length && half < want; i++) { if (rem[i][0] > 0) { a[rem[i][1]]++; half++; } }
      for (i = 0; i < k; i++) b[i] = n[i] - a[i];
      return [a, b];
    }
    for (i = 0; i < k; i++) {
      for (c = 0; c < n[i]; c++) { if (rng() < 0.5) a[i]++; else b[i]++; }
    }
    return [a, b];
  }

  /** 総数 M 個を、与えられた割合 share から引き直す（多項標本）。 */
  function drawFromShare(P, M, share, rng) {
    var k = P.kinds, out = new Int32Array(k), cdf = new Float64Array(k), acc = 0, i;
    for (i = 0; i < k; i++) { acc += share[i]; cdf[i] = acc; }
    for (var m = 0; m < M; m++) {
      var x = rng() * acc, j = 0;
      while (j < k - 1 && x >= cdf[j]) j++;
      out[j]++;
    }
    return out;
  }

  // ---------------------------------------------------------------- 池

  /**
   * 与えられた重みで count 個を重複なく残す（Efraimidis-Spirakis）。
   * 重みが全部等しければ一様な部分集合になる。core はこれ以上のことを知らない。
   */
  function keepSome(count, weights, rng) {
    // Efraimidis-Spirakis の鍵 u^(1/w) を **対数で**持つ（w が極端に小さいと u^(1/w) が
    // 全部 0 に潰れて、並び順だけで決まってしまうため）。ln(u) < 0 なので大きいほうが上位。
    var keys = [], mx = 0, i;
    for (i = 0; i < weights.length; i++) if (weights[i] > mx) mx = weights[i];
    for (i = 0; i < weights.length; i++) {
      var w = mx > 0 ? weights[i] / mx : 0;   // 目盛りは順位に影響しない
      var u = 1 - rng();
      keys.push([w > 0 ? Math.log(u) / w : -Infinity, i]);
    }
    keys.sort(function (a, b) { return b[0] - a[0] || a[1] - b[1]; });
    var out = [];
    for (var j = 0; j < count && j < keys.length; j++) out.push(keys[j][1]);
    out.sort(function (a, b) { return a - b; });
    return out;
  }

  /**
   * 池を1世代進める。
   * opts: { maxEvents, splitMode, weightOf(counts, index) -> number,
   *         birthShare: Float64Array|null（渡すと娘の個数をその割合から引き直す）,
   *         nextId: {v}, keepOrder: Array|null（残す番号を外から指定する。双子の作成に使う） }
   * 戻り: { bags（次世代）, kids, records, weights, keep }
   */
  function stepGeneration(P, bags, rng, opts) {
    var maxEvents = opts.maxEvents || 200000;
    var splitMode = opts.splitMode || 'binomial';
    var kids = [], records = [], i;
    for (i = 0; i < bags.length; i++) {
      var bag = bags[i];
      var g = growToSplit(P, bag, rng, maxEvents);
      var atSplit = Int32Array.from(bag.n);
      var pair = splitCounts(P, bag.n, rng, splitMode);
      records.push({ slot: i, id: bag.id, parent: bag.parent, gen: bag.gen,
                     atSplit: atSplit, events: g.events, hitLimit: g.hitLimit, N: g.N, t: bag.t });
      for (var s = 0; s < 2; s++) {
        var c = pair[s];
        if (opts.birthShare) {
          var M = 0;
          for (var q = 0; q < P.kinds; q++) M += c[q];
          c = drawFromShare(P, M, opts.birthShare, rng);
        }
        var kid = makeBag(P, c, opts.nextId.v++, bag.id, bag.gen + 1);
        kid.parentSplit = atSplit;
        kid.parentSlot = i;
        kids.push(kid);
      }
    }
    var weights = new Float64Array(kids.length);
    for (i = 0; i < kids.length; i++) weights[i] = opts.weightOf ? opts.weightOf(kids[i], i) : 1;
    var keep = opts.keepOrder ? opts.keepOrder.slice() : keepSome(bags.length, weights, rng);
    var next = [];
    for (i = 0; i < keep.length; i++) next.push(kids[keep[i]]);
    return { bags: next, kids: kids, records: records, weights: weights, keep: keep };
  }

  // ---------------------------------------------------------------- 決定論版（RK4）

  /** dn/dt を out へ。n は Float64Array。 */
  function derivative(P, n, out) {
    var k = P.kinds, N = 0, i, j, both = P.enhanceMode !== 'inOnly';
    for (i = 0; i < k; i++) N += n[i];
    if (!(N > 0)) { for (i = 0; i < k; i++) out[i] = 0; return 0; }
    for (i = 0; i < k; i++) {
      var s = 0, base = i * k;
      for (j = 0; j < k; j++) s += P.boost[base + j] * n[j];
      var phi = 1 + s / N;
      var rin = P.sourceFromSelf ? P.influxTotal * n[i] : P.influx[i] * N;
      out[i] = both ? (rin - P.outflow * n[i]) * phi : (rin * phi - P.outflow * n[i]);
    }
    return N;
  }

  function rk4(P, n, dt, work) {
    var k = P.kinds, a = work.a, b = work.b, c = work.c, d = work.d, tmp = work.tmp, i;
    derivative(P, n, a);
    for (i = 0; i < k; i++) tmp[i] = n[i] + 0.5 * dt * a[i];
    derivative(P, tmp, b);
    for (i = 0; i < k; i++) tmp[i] = n[i] + 0.5 * dt * b[i];
    derivative(P, tmp, c);
    for (i = 0; i < k; i++) tmp[i] = n[i] + dt * c[i];
    derivative(P, tmp, d);
    for (i = 0; i < k; i++) n[i] += (dt / 6) * (a[i] + 2 * b[i] + 2 * c[i] + d[i]);
  }

  function makeWork(kinds) {
    return { a: new Float64Array(kinds), b: new Float64Array(kinds), c: new Float64Array(kinds),
             d: new Float64Array(kinds), tmp: new Float64Array(kinds) };
  }

  function sum(v) { var s = 0; for (var i = 0; i < v.length; i++) s += v[i]; return s; }

  /**
   * 決定論版で「splitAt まで育てて半分にする」を1回。
   * 刻みは**総数が 1 歩で rel だけ増える大きさ**に毎歩取り直す（上乗せが大きいと系が硬くなるため）。
   * splitAt への着地は刻みを詰めて合わせる。戻り: { n（総和 splitAt/2）, t, steps }。
   */
  function growHalveDeterministic(P, n0, rel, work, maxSteps) {
    var k = P.kinds, n = Float64Array.from(n0), t = 0, steps = 0;
    var guard = maxSteps || 400000, r = rel > 0 ? rel : 0.005;
    var der = new Float64Array(k);
    while (steps < guard) {
      var N = sum(n);
      if (N >= P.splitAt - 1e-12 || !(N > 0)) break;
      derivative(P, n, der);
      var dN = sum(der);
      if (!(dN > 0)) break;
      var dt = r * N / dN;
      if (N + dN * dt > P.splitAt) dt = (P.splitAt - N) / dN;  // 着地の見積もり
      if (!(dt > 0)) break;
      var save = Float64Array.from(n);
      rk4(P, n, dt, work);
      if (sum(n) > P.splitAt + 1e-9) { n.set(save); r *= 0.5; steps++; continue; }
      t += dt;
      steps++;
    }
    var half = new Float64Array(k);
    for (var i = 0; i < k; i++) half[i] = n[i] / 2;
    return { n: half, t: t, steps: steps, atSplit: n };
  }

  /** σ=0（全 boost が等しく c）のときの閉形式。検査用（実装の外から来る）。 */
  function closedFormShare(P, f0, c, t) {
    var k = P.kinds, A = P.influxTotal, phi = 1 + c, fs = sourceShare(P);
    var e = Math.exp(-A * phi * t), out = new Float64Array(k);
    for (var i = 0; i < k; i++) out[i] = f0[i] * e + fs[i] * (1 - e);
    return out;
  }

  // ---------------------------------------------------------------- 状態ハッシュ（K-36）

  function hashBags(bags) {
    var h1 = 0x811c9dc5 >>> 0, h2 = 0x01000193 >>> 0;
    for (var b = 0; b < bags.length; b++) {
      var n = bags[b].n;
      h1 = (h1 ^ (bags[b].gen + 1)) >>> 0; h1 = Math.imul(h1, 16777619) >>> 0;
      for (var i = 0; i < n.length; i++) {
        h1 = (h1 ^ (n[i] + 1)) >>> 0; h1 = Math.imul(h1, 16777619) >>> 0;
        h2 = (h2 + Math.imul(n[i] + 1, i * 2654435761 + 1)) >>> 0;
      }
    }
    return ('00000000' + h1.toString(16)).slice(-8) + ('00000000' + h2.toString(16)).slice(-8);
  }

  var API = {
    makeRng: makeRng, normal: normal,
    makeBoost: makeBoost, offDiagonalToZero: offDiagonalToZero,
    makeParams: makeParams, sourceShare: sourceShare,
    makeBag: makeBag, bump: bump, recomputeS: recomputeS,
    fillRates: fillRates, stepOnce: stepOnce, growToSplit: growToSplit,
    splitCounts: splitCounts, drawFromShare: drawFromShare,
    keepSome: keepSome, stepGeneration: stepGeneration,
    derivative: derivative, rk4: rk4, makeWork: makeWork,
    growHalveDeterministic: growHalveDeterministic, closedFormShare: closedFormShare,
    hashBags: hashBags, sum: sum,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.S34 = API;
})(typeof window !== 'undefined' ? window : globalThis);
