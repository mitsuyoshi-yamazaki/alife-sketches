/**
 * S-36 の観測器と探索器。**上位概念の語彙はこちら側にだけある**
 * （目的関数・新奇さ・行動の記述・アーカイブ・到達）。核 `core.js` はこれらを1語も知らない。
 *
 * 提供するもの:
 *   - `DESCRIPTORS` … 行動の記述の族。**「分け方」と「細かさ」を別の軸として並べてある**
 *   - `sparseness` … k 近傍までの平均距離（原典の novelty metric）。素朴な総当たりと近道の2実装
 *   - `SEARCHERS` … 選び方の族。目的関数探索・新奇性探索と、参照点 6 通り
 *   - `runOnce` … 1 レプリケートを走らせて記録を返す
 *
 * Node（`module.exports`）とブラウザ（`window.S36S`）で共用する古典スクリプト。
 */
(function (root, factory) {
  var core = (typeof module === 'object' && module.exports) ? require('./core.js') : root.S36;
  var api = factory(core);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.S36S = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null), function (S36) {
  'use strict';

  /* ================================================================ 距離 */

  /** kind='real' は実数ベクトル、kind='bits' は 0/1 の集合。power=2 は原典の「二乗ユークリッド」。 */
  function distance(a, b, kind, power) {
    var s = 0, i;
    if (kind === 'bits') {
      for (i = 0; i < a.length; i++) {
        var x = (a[i] ^ b[i]) >>> 0;
        x = x - ((x >>> 1) & 0x55555555);
        x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
        x = (x + (x >>> 4)) & 0x0f0f0f0f;
        s += (Math.imul(x, 0x01010101) >>> 24);
      }
      return power === 2 ? s : Math.sqrt(s);
    }
    for (i = 0; i < a.length; i++) { var d = a[i] - b[i]; s += d * d; }
    return power === 2 ? s : Math.sqrt(s);
  }

  /* ================================================== 行動の記述（分け方） */

  /**
   * 記述の族。`group` は **分け方**（何のチャネルを見るか）、`grain` は **細かさ**（何点・何区画）。
   * 原典 Lehman & Stanley 2011 が振ったのは `grain` の2軸（標本数 1→200・格子 2^1→2^24）だけで、
   * `group` は終点座標に固定されている。
   */
  var DESCRIPTORS = {};

  function reg(name, group, grain, dim, kind, build) {
    DESCRIPTORS[name] = { name: name, group: group, grain: grain, dim: dim, kind: kind, build: build };
  }

  function xyOf(idx, w) { return [idx % w, (idx / w) | 0]; }

  /* 分け方 = 終点。原典の標準。細かさ = 無し */
  reg('endpoint', 'endpoint', 0, 2, 'real', function (ctx) {
    return function (tr) { var p = xyOf(tr.last, ctx.w); return Float64Array.from(p); };
  });

  /* 分け方 = 軌道。細かさ = 標本の数 K（K=1 は終点と厳密に同一） */
  [1, 2, 4, 8, 16, 32].forEach(function (K) {
    reg('samples:' + K, 'trajectory', K, 2 * K, 'real', function (ctx) {
      return function (tr) {
        var out = new Float64Array(2 * K), i, t;
        for (i = 0; i < K; i++) {
          t = Math.round((i + 1) * ctx.steps / K);
          var p = xyOf(tr.visits[t], ctx.w);
          out[2 * i] = p[0]; out[2 * i + 1] = p[1];
        }
        return out;
      };
    });
  });

  /* 分け方 = 終点。細かさ = 区画の粗さ G（原典 6.4.2 の「精度を落とす」実験） */
  [2, 4, 8, 16].forEach(function (G) {
    reg('grid:' + G, 'endpoint', G, 2, 'real', function (ctx) {
      return function (tr) {
        var p = xyOf(tr.last, ctx.w);
        var bw = ctx.w / G, bh = ctx.h / G;
        return Float64Array.from([
          (Math.floor(p[0] / bw) + 0.5) * bw,
          (Math.floor(p[1] / bh) + 0.5) * bh
        ]);
      };
    });
  });

  /* 分け方 = 滞在の分布。細かさ = 区画の数 B×B */
  [2, 4, 6].forEach(function (B) {
    reg('occupancy:' + B, 'occupancy', B, B * B, 'real', function (ctx) {
      return function (tr) {
        var out = new Float64Array(B * B), t, p, bx, by;
        var bw = ctx.w / B, bh = ctx.h / B;
        for (t = 0; t <= ctx.steps; t++) {
          p = tr.visits[t];
          bx = Math.min(B - 1, Math.floor((p % ctx.w) / bw));
          by = Math.min(B - 1, Math.floor(((p / ctx.w) | 0) / bh));
          out[by * B + bx] += 1;
        }
        for (t = 0; t < out.length; t++) out[t] = out[t] / (ctx.steps + 1) * ctx.w;
        return out;
      };
    });
  });

  /* 分け方 = 訪れた枡の集合（順序も滞在時間も忘れる）。0/1 の集合 */
  reg('visited', 'visited', 0, 0, 'bits', function (ctx) {
    var words = Math.ceil(ctx.ordinal.size / 32);
    return function (tr) {
      var out = new Uint32Array(words), t, o;
      for (t = 0; t <= ctx.steps; t++) {
        o = ctx.ordinal.map[tr.visits[t]];
        if (o !== undefined) out[o >>> 5] |= (1 << (o & 31));
      }
      return out;
    };
  });

  /* 分け方 = 選択の頻度（位置を一切見ない） */
  reg('picks', 'picks', 0, 6, 'real', function (ctx) {
    return function (tr) {
      var out = new Float64Array(6), t;
      for (t = 0; t < tr.picks.length; t++) out[tr.picks[t]] += 1;
      for (t = 0; t < 6; t++) out[t] = out[t] / tr.picks.length * ctx.w;
      return out;
    };
  });

  /* 分け方 = 重みベクトルそのもの（記述を探索空間に取る。位置も選択も見ない） */
  reg('vector', 'vector', 0, S36.VECTOR_SIZE, 'real', function () {
    return function (tr, vec) { return vec; };
  });

  /* 分け方 = 広がり（異なる枡の数・起点からの最遠） */
  reg('extent', 'extent', 0, 2, 'real', function (ctx) {
    return function (tr) {
      var seen = {}, n = 0, far = 0, t, p, dx, dy, d;
      var ox = ctx.origin % ctx.w, oy = (ctx.origin / ctx.w) | 0;
      for (t = 0; t <= ctx.steps; t++) {
        p = tr.visits[t];
        if (!seen[p]) { seen[p] = 1; n++; }
        dx = (p % ctx.w) - ox; dy = ((p / ctx.w) | 0) - oy;
        d = Math.sqrt(dx * dx + dy * dy);
        if (d > far) far = d;
      }
      return Float64Array.from([n, far]);
    };
  });

  /* 分け方 = 順序つきの粗い軌道（Q 点での象限を one-hot に） */
  [4, 8].forEach(function (Q) {
    reg('quadrants:' + Q, 'quadrants', Q, 4 * Q, 'real', function (ctx) {
      return function (tr) {
        var out = new Float64Array(4 * Q), i, t, p, q;
        for (i = 0; i < Q; i++) {
          t = Math.round((i + 1) * ctx.steps / Q);
          p = tr.visits[t];
          q = (((p % ctx.w) >= ctx.w / 2) ? 1 : 0) + ((((p / ctx.w) | 0) >= ctx.h / 2) ? 2 : 0);
          out[i * 4 + q] = ctx.w / 2;
        }
        return out;
      };
    });
  });

  /* ============================================== k 近傍（総当たり と 近道） */

  /** 素朴: 全部の距離を出して昇順に並べ、先頭 k 個の平均。 */
  function sparsenessNaive(target, pool, skip, k, kind, power) {
    var ds = [], i;
    for (i = 0; i < pool.length; i++) { if (i === skip) continue; ds.push(distance(target, pool[i], kind, power)); }
    ds.sort(function (a, b) { return a - b; });
    var m = Math.min(k, ds.length), s = 0;
    for (i = 0; i < m; i++) s += ds[i];
    return m ? s / m : 0;
  }

  /** 近道: 並べ替えず、k 番目だけを選り分けて（quickselect）平均を取る。 */
  function sparsenessQuick(target, pool, skip, k, kind, power, buf) {
    var n = 0, i;
    for (i = 0; i < pool.length; i++) { if (i === skip) continue; buf[n++] = distance(target, pool[i], kind, power); }
    var m = Math.min(k, n);
    if (!m) return 0;
    if (m < n) {
      var lo = 0, hi = n - 1;
      while (lo < hi) {
        var pivot = buf[(lo + hi) >> 1], a = lo, b = hi, tmp;
        while (a <= b) {
          while (buf[a] < pivot) a++;
          while (buf[b] > pivot) b--;
          if (a <= b) { tmp = buf[a]; buf[a] = buf[b]; buf[b] = tmp; a++; b--; }
        }
        if (m - 1 <= b) hi = b; else if (m - 1 >= a) lo = a; else break;
      }
    }
    var s = 0;
    for (i = 0; i < m; i++) s += buf[i];
    return s / m;
  }

  /* ============================================================ 探索器 */

  /**
   * 忘れられるチャネルの数え上げ（K-62）。新奇性探索が使っているものは5つある:
   *   ①選び方そのもの ②記述と個体の対応 ③アーカイブ ④新奇さの向き ⑤変異の蓄積
   * 参照点はそれぞれを1つずつ忘れたもので、`forgets` にどれを忘れたかを書く。
   */
  var SEARCHERS = {
    objective:          { score: 'objective', forgets: [],            needsDescriptor: false },
    novelty:            { score: 'novelty',   forgets: [],            needsDescriptor: true },
    'uniform':          { score: 'flat',      forgets: ['選び方'],     needsDescriptor: false },
    'shuffled-novelty': { score: 'novelty',   forgets: ['記述と個体の対応'], needsDescriptor: true, shuffle: true },
    'shuffled-objective': { score: 'objective', forgets: ['記述と個体の対応'], needsDescriptor: false, shuffle: true },
    'no-archive':       { score: 'novelty',   forgets: ['アーカイブ'],  needsDescriptor: true, noArchive: true },
    'crowding':         { score: 'novelty',   forgets: ['新奇さの向き'], needsDescriptor: true, flip: true },
    'resample':         { score: 'flat',      forgets: ['変異の蓄積'],  needsDescriptor: false, resample: true },
    'flat':             { score: 'flat',      forgets: ['選び方'],     needsDescriptor: false }
  };

  /* 到達の判定規則（K-63: 上限は「どこを見るかの決定」を通して効くので、規則を固定した腕を並べる）。 */
  var REACH_RULES = {
    G1: '経路のどこかで的の枡に入った（固定）',
    G2: '終点が的の枡（固定）',
    G3: '終点が的から半径 r 以内（固定・借り物 r）',
    G4: '終点の距離が、その掃引の全レプリケートの下位 q% に入る（データが決める）'
  };

  return {
    distance: distance,
    DESCRIPTORS: DESCRIPTORS,
    SEARCHERS: SEARCHERS,
    REACH_RULES: REACH_RULES,
    sparsenessNaive: sparsenessNaive,
    sparsenessQuick: sparsenessQuick,
    xyOf: xyOf
  };
});
