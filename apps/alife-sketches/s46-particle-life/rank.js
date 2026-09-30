/**
 * S-46 の階数を落とす実行ページ（run `rank`）の、**DOM を持たない部分**。
 *
 * 出所: 2026-09-19 ユーザ指示（S-46 の力学の分析。`work/2026-09-19-s46-particle-properties.md` §7）。
 * 器の設計は `work/2026-09-17-sketch-multiple-runs.md`（実行ページの台帳 `runs.json`）。
 *
 * ## この run が答えようとしている一問
 *
 * S-46 の力は型ペアごとの独立な定数 `G[a][b]` で決まる。これを
 *
 *     Φ(q_a, q_b) = q_aᵀ M q_b
 *
 * ——粒子は連続な性質ベクトル `q ∈ R^m` を持ち、世界は固定の法則 `M` を1枚だけ持つ——
 * という形へ書き換えると、粒子の追加は「`q` を1つ選ぶ」だけになり、既存の全型との関係を
 * 決め直す必要が無くなる。しかしこの形は必然的に **rank(G) ≤ m** を課す。
 *
 * **だから測るべきは「面白いと思った G が、どの m まで階数を落としても壊れないか」である。**
 * 壊れないなら K×K の自由度の大半は働いておらず、書き換えは何も失わない。
 *
 * ## ここにあるもの / 無いもの
 *
 * あるのは行列の分解（特異値分解）と、そこから出る階数 m の近似・性質ベクトルだけである。
 * **力学は `core.js` のまま**で、階数を落とした行列を核へそのまま渡す。
 * 分解のための行列は `rank.js` の側にしかなく、`core.js` は階数を知らない。
 *
 * ## 守る一線
 *
 * この run は **`origin: "screen"`**（台帳 `runs.json`）である。ここで見たものは判定に使わない——
 * 仮説が出たなら、工場の実体の run を1本足して事前登録し直すことでしか主張にならない。
 *
 * 依存ゼロ。Node（selftest）とブラウザ（viewer-rank.html）が同じファイルを読む。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S46R = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** この実行ページの識別子と版。台帳 `runs.json` の `runs[].version` と一致していること。 */
  var RUN_ID = 'rank';
  var VERSION = '1.1.0';

  /** 特異値分解の収束の閾値と、掃き出しの上限（K は高々 12 なので実測でここまで要らない）。 */
  var JACOBI_TOL = 1e-12;
  var JACOBI_MAX_SWEEPS = 60;

  /** 「この特異値は 0 とみなす」比（最大特異値に対する比）。実効的な階数を数えるのに使う。 */
  var DEFAULT_RANK_TOL = 1e-9;

  // ------------------------------------------------------------- 行列の小道具

  function cloneMatrix(A) {
    return A.map(function (row) { return row.slice(); });
  }

  function zeros(rows, cols) {
    var out = [];
    for (var i = 0; i < rows; i++) {
      var row = [];
      for (var j = 0; j < cols; j++) row.push(0);
      out.push(row);
    }
    return out;
  }

  function identity(n) {
    var out = zeros(n, n);
    for (var i = 0; i < n; i++) out[i][i] = 1;
    return out;
  }

  /** Frobenius ノルム。 */
  function frobenius(A) {
    var s = 0;
    for (var i = 0; i < A.length; i++) {
      for (var j = 0; j < A[i].length; j++) s += A[i][j] * A[i][j];
    }
    return Math.sqrt(s);
  }

  /** 成分ごとの差。`A` と `B` は同じ形であること。 */
  function subtract(A, B) {
    return A.map(function (row, i) {
      return row.map(function (v, j) { return v - B[i][j]; });
    });
  }

  /** 対称部 (A+Aᵀ)/2 と反対称部 (A−Aᵀ)/2。**反対称部が非相反性そのもの**である。 */
  function symmetricPart(A) {
    var n = A.length, out = zeros(n, n);
    for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) out[i][j] = (A[i][j] + A[j][i]) / 2;
    return out;
  }

  function antisymmetricPart(A) {
    var n = A.length, out = zeros(n, n);
    for (var i = 0; i < n; i++) for (var j = 0; j < n; j++) out[i][j] = (A[i][j] - A[j][i]) / 2;
    return out;
  }

  /**
   * 全体に対する反対称部の割合 ‖A_asym‖_F / ‖A‖_F（0 なら完全に相反、大きいほど非相反）。
   * 行列が丸ごと 0 のときは 0 を返す。
   */
  function asymmetryRatio(A) {
    var n = frobenius(A);
    return n > 0 ? frobenius(antisymmetricPart(A)) / n : 0;
  }

  // ------------------------------------------------------------- 特異値分解

  /**
   * 正方行列の特異値分解 A = U · diag(S) · Vᵀ を片側 Jacobi 法で求める。
   *
   * 片側 Jacobi は **A の列の対を直交化していく**方法である。列の対 (p,q) を回転で直交にする操作を
   * 全ての対について繰り返すと、A の列が互いに直交になる——そのときの列の長さが特異値、
   * 正規化した列が U、掛けてきた回転の積が V になる。
   *
   * K は高々 12 なので速度は問題にならない。**依存を増やさないこと**を優先してここに置く。
   * 特異値 0 に対応する U の列は一意に決まらないので **0 ベクトル**にしてある——
   * `reconstruct` も `truncate` もその列に 0 を掛けるので、結果には影響しない。
   */
  function svd(A) {
    var n = A.length;
    var W = cloneMatrix(A);     // 掃き出していく作業用（最後に U·diag(S) になる）
    var V = identity(n);
    var sweep, p, q, i;

    for (sweep = 0; sweep < JACOBI_MAX_SWEEPS; sweep++) {
      var off = 0;
      for (p = 0; p < n - 1; p++) {
        for (q = p + 1; q < n; q++) {
          var alpha = 0, beta = 0, gamma = 0;
          for (i = 0; i < n; i++) {
            alpha += W[i][p] * W[i][p];
            beta += W[i][q] * W[i][q];
            gamma += W[i][p] * W[i][q];
          }
          if (Math.abs(gamma) <= JACOBI_TOL * Math.sqrt(alpha * beta) || gamma === 0) continue;
          off += gamma * gamma;

          // 列 p と列 q を直交にする回転角（ζ は Jacobi の標準形）
          var zeta = (beta - alpha) / (2 * gamma);
          var t = (zeta >= 0 ? 1 : -1) / (Math.abs(zeta) + Math.sqrt(1 + zeta * zeta));
          var c = 1 / Math.sqrt(1 + t * t);
          var s = c * t;

          for (i = 0; i < n; i++) {
            var wp = W[i][p], wq = W[i][q];
            W[i][p] = c * wp - s * wq;
            W[i][q] = s * wp + c * wq;
            var vp = V[i][p], vq = V[i][q];
            V[i][p] = c * vp - s * vq;
            V[i][q] = s * vp + c * vq;
          }
        }
      }
      if (off === 0) break;
    }

    // 列の長さが特異値。降順に並べ替える（階数を落とすときに「上から m 本」で済むように）
    var order = [];
    for (q = 0; q < n; q++) {
      var norm = 0;
      for (i = 0; i < n; i++) norm += W[i][q] * W[i][q];
      order.push({ col: q, s: Math.sqrt(norm) });
    }
    order.sort(function (a, b) { return b.s - a.s; });

    var U = zeros(n, n), Vo = zeros(n, n), S = [];
    order.forEach(function (o, k) {
      S.push(o.s);
      for (i = 0; i < n; i++) {
        U[i][k] = o.s > 0 ? W[i][o.col] / o.s : 0;
        Vo[i][k] = V[i][o.col];
      }
    });
    return { U: U, S: S, V: Vo };
  }

  /** U·diag(S)·Vᵀ を、上から `m` 本の特異値だけで組み直す。`m` が K 以上なら元の行列に戻る。 */
  function reconstruct(d, m) {
    var n = d.S.length;
    var take = Math.max(0, Math.min(n, m == null ? n : m));
    var out = zeros(n, n);
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < n; j++) {
        var v = 0;
        for (var k = 0; k < take; k++) v += d.U[i][k] * d.S[k] * d.V[j][k];
        out[i][j] = v;
      }
    }
    return out;
  }

  /** 行列 `G` の階数 `m` の最良近似（Eckart–Young）。分解を持っていないときの入口。 */
  function truncate(G, m) {
    return reconstruct(svd(G), m);
  }

  /**
   * 行列を目標の Frobenius ノルムへ揃えた**新しい行列**を返す（2026-09-19 追加）。
   *
   * **なぜ要るか**: 階数を落とすと必ず ‖G_m‖ ≤ ‖G‖ になるので、
   * 「階数を落としたから壊れた」のか「力が弱くなったから壊れた」のかが**交絡する**。
   * 元のノルムへ戻した腕を並べれば、この2つを分けられる。
   *
   * ノルムが 0 の行列（m=0 相当・零行列）はそのまま返す——伸ばす方向が無い。
   */
  function rescaleTo(A, targetNorm) {
    var n = frobenius(A);
    if (!(n > 0) || !(targetNorm > 0)) return cloneMatrix(A);
    var k = targetNorm / n;
    return A.map(function (row) { return row.map(function (v) { return v * k; }); });
  }

  /**
   * 階数 `m` の近似を作る。`renorm` が真なら元の行列と同じ Frobenius ノルムへ揃える。
   * **画面が使う唯一の入口**にしてある（交絡の扱いを1か所に閉じ込めるため）。
   */
  function approximate(d, m, renorm, originalNorm) {
    var Gm = reconstruct(d, m);
    return renorm ? rescaleTo(Gm, originalNorm) : Gm;
  }

  /**
   * 階数 `m` の近似が元の行列の「強さ」をどれだけ残しているか Σ_{k<m} σ_k² / Σ_k σ_k²。
   * **1 に近いほど、K×K の自由度が実は m 本で足りていたということ**である。
   * 行列が丸ごと 0 なら 1（残すべきものが無いので何も失っていない）を返す。
   */
  function energyRatio(d, m) {
    var total = 0, kept = 0;
    for (var k = 0; k < d.S.length; k++) {
      var e = d.S[k] * d.S[k];
      total += e;
      if (k < m) kept += e;
    }
    return total > 0 ? kept / total : 1;
  }

  /** ‖G − G_m‖_F / ‖G‖_F。`energyRatio` と `err² + energy = 1` の関係にある。 */
  function relativeError(d, m) {
    return Math.sqrt(Math.max(0, 1 - energyRatio(d, m)));
  }

  /** 最大特異値に対する比が `tol` を超える特異値の本数＝実効的な階数。 */
  function effectiveRank(d, tol) {
    var t = tol == null ? DEFAULT_RANK_TOL : tol;
    if (!d.S.length || !(d.S[0] > 0)) return 0;
    var n = 0;
    for (var k = 0; k < d.S.length; k++) if (d.S[k] / d.S[0] > t) n++;
    return n;
  }

  // ------------------------------------------------------------- 性質ベクトル

  /**
   * 階数 `m` の近似から、型ごとの**性質ベクトル**を取り出す。
   *
   *     a_t = (U·diag(S)) の第 t 行   （その型が**発信する**もの）
   *     b_t = V の第 t 行             （その型が**受信する**もの）
   *
   * そして定義から **G_m[a][b] = a_a · b_b** が厳密に成り立つ。つまり階数 m の行列とは
   * 「m 次元の性質ベクトルを持つ粒子たちの世界」そのものであり、逆も言える。
   *
   * ここで `a ≠ b` であることが非相反性にあたる（`a = b` なら G は対称になる）。
   */
  function properties(d, m) {
    var n = d.S.length;
    var take = Math.max(0, Math.min(n, m == null ? n : m));
    var a = [], b = [];
    for (var t = 0; t < n; t++) {
      var ra = [], rb = [];
      for (var k = 0; k < take; k++) {
        ra.push(d.U[t][k] * d.S[k]);
        rb.push(d.V[t][k]);
      }
      a.push(ra);
      b.push(rb);
    }
    return { a: a, b: b, m: take };
  }

  /** 性質ベクトルから行列を組み直す（`properties` の逆。G_m と一致することの検査に使う）。 */
  function matrixFromProperties(props) {
    var n = props.a.length, out = zeros(n, n);
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < n; j++) {
        var v = 0;
        for (var k = 0; k < props.m; k++) v += props.a[i][k] * props.b[j][k];
        out[i][j] = v;
      }
    }
    return out;
  }

  // ------------------------------------------------------------- まとめ

  /**
   * 1つの行列について、この画面が出す数値をひととおり作る。
   * `m = 1..K` の各段での保存率・相対誤差を並べた表が主役である。
   */
  function analyze(G) {
    var d = svd(G);
    var K = d.S.length;
    var steps = [];
    for (var m = 1; m <= K; m++) {
      steps.push({
        m: m,
        energy: energyRatio(d, m),
        error: relativeError(d, m),
        asymmetry: asymmetryRatio(reconstruct(d, m)),
      });
    }
    return {
      K: K,
      singular: d.S.slice(),
      effectiveRank: effectiveRank(d, DEFAULT_RANK_TOL),
      asymmetry: asymmetryRatio(G),
      norm: frobenius(G),
      steps: steps,
      decomposition: d,
    };
  }

  // ------------------------------------------------------------- 封筒

  /**
   * クリップボードへ写す中身。**ハーネスの封筒と同じ形**なので「⬆ 復元」で読み戻せる。
   * `m` を含むのは、階数こそがこの run で動かしている当のものだからである。
   */
  function rankEnvelope(params, opts) {
    var o = opts || {};
    return {
      sketch: o.sketch || 'S-46',
      run: RUN_ID,
      version: o.version || VERSION,
      savedAt: o.savedAt || new Date().toISOString(),
      params: params,
    };
  }

  return {
    RUN_ID: RUN_ID, VERSION: VERSION,
    JACOBI_TOL: JACOBI_TOL, JACOBI_MAX_SWEEPS: JACOBI_MAX_SWEEPS, DEFAULT_RANK_TOL: DEFAULT_RANK_TOL,
    cloneMatrix: cloneMatrix, zeros: zeros, identity: identity,
    frobenius: frobenius, subtract: subtract,
    symmetricPart: symmetricPart, antisymmetricPart: antisymmetricPart, asymmetryRatio: asymmetryRatio,
    svd: svd, reconstruct: reconstruct, truncate: truncate,
    rescaleTo: rescaleTo, approximate: approximate,
    energyRatio: energyRatio, relativeError: relativeError, effectiveRank: effectiveRank,
    properties: properties, matrixFromProperties: matrixFromProperties,
    analyze: analyze, rankEnvelope: rankEnvelope,
  };
});
