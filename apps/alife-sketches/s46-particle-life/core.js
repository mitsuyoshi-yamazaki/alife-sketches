/**
 * S-46: Particle Life ― 型ペアの引力/斥力行列だけから膜・自走塊・分裂集合・追跡関係が創発するか
 *
 * 各粒子は型（K種のうち1つ）・位置・速度だけを持つ。規則は型ペア(a,b)ごとに固定された
 * 係数 G[a][b] と、全ペア共通の距離カーブだけである。
 *
 *   距離カーブ（独自設計。criteria.json の sourceFidelity 参照）:
 *     d <  rCore         近接反発。型によらず一定 (-(1 - d/rCore))
 *     rCore <= d < rMax   中間域。三角形カーブ（rCore と rMax の中点でピーク）× G[a][b]
 *     d >= rMax           ゼロ
 *
 *   体積排除（2026-09-16 追加。既定は無効。有効にすると上のカーブへ加算される）:
 *     d < 2·particleRadius  型によらない反発 excludeStrength·(σ/d − 1)（σ=直径。上限あり）
 *
 * このファイルには「膜」も「クラスタ」も「追跡」も無い。あるのは粒子・型・距離・力だけで、
 * それらの呼び名は下半分の観測器の側にしかない。
 *
 * 依存ゼロ。Node（生ログ生成）とブラウザ（可視化）が同じファイルを読む。
 *
 * 出典（アイデアのみ。コードは参照していない。詳細は criteria.json の sources/sourceFidelity）:
 *   hunar4321/particle-life (GitHub)
 *   Jeffrey Ventrella, Clusters (http://www.ventrella.com/Clusters/)
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S46 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------- 乱数

  /** mulberry32。速い・十分にばらける・決定的。 */
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /**
   * 1つのシードから、タグで区別された独立な部分ストリームを作る（FNV-1a風混合）。
   * 「行列を決めるシード」と「初期条件だけを決めるシード」を同じシード値からでも
   * 別々の乱数列として引き出せるようにする（criteria.json whatSeedChanges 参照・K-47）。
   */
  function subSeed(seed, tag) {
    var h = (seed >>> 0) ^ 0x811c9dc5;
    for (var i = 0; i < tag.length; i++) {
      h = Math.imul(h ^ tag.charCodeAt(i), 0x01000193);
    }
    return h >>> 0;
  }

  // ------------------------------------------------------------- 既定値

  var DEFAULTS = {
    N: 240,            // 粒子総数
    K: 6,               // 型の数
    L: 100,              // 正方形領域の一辺（壁で弾性反射。トーラスではない）
    rCore: 3,            // 近接反発の半径
    rMax: 20,            // 相互作用が届く上限
    friction: 0.15,      // 速度の摩擦係数（保持率 1-friction）
    dt: 0.5,             // 1 step の時間刻み。近接反発の硬さに対して dt=1 だと陽的オイラー法が発散する
                          // （最大速度が数十/stepまで暴れるのを確認した。criteria.json はこの内部刻みを
                          // 規定していないためS2の裁量で選定。dt=0.5で正コントロール（全引力）が
                          // 静的な単一塊へ収束し、登録どおりの系でも速度が発散しないことを確認済み）
    matrixLo: -1,
    matrixHi: 1,
    initialSpeedStd: 0.5, // 初速度（ガウス分布）の標準偏差
    // 外枠の反発（2026-09-15 ユーザ指定「フィールドの外枠に反発力を追加せよ」）。
    // **既定は 0（無効）**——事前登録した本番（run.js）と既存の生ログは壁の反発が無い系で
    // 測っており、既定を変えると登録済みの解析と生ログの再現性が静かに壊れるため。
    // 可視化（viewer.html）は既定で有効にし、パラメータとして export/import される。
    wallMargin: 10,       // 壁からこの距離以内で内向きの加速度が働く（ユーザ例の n=10）
    wallStrength: 0,      // 壁面での内向き加速度の大きさ。0 で無効
    // 体積排除（2026-09-16 ユーザ指定「すべての粒子が、同一空間を占められない（占めにくい）
    // ようにする：中心距離が直径以下になると反発力が生まれる」）。
    // **既定は false（無効）**——外枠の反発と同じ理由で、事前登録した本番（run.js）と既存の
    // 生ログは体積排除の無い系で測っており、既定を変えると登録済みの解析の再現性が静かに壊れる。
    // 有効/無効で**系の規則そのものが変わる**ため、export/import の対象に含める。
    excludeOverlap: false, // 体積排除の有効/無効
    particleRadius: 0.5,   // 粒子の半径。排除が働き始める中心間距離（＝直径）は 2*particleRadius
    // 以下の4つは dt・rCore と同じ「数値計算の土台」であり、実測で選んだ（README.md「体積排除の設計」）。
    // export の対象にはしない——UI で動かせるのは有効/無効と粒子の半径だけである
    excludeStrength: 16,   // 排除の強さ。中心間距離が直径の半分のときの加速度がこの値
    excludeMaxAccel: 128,  // 排除加速度の上限。1/d の発散を陽的オイラー法が踏み抜かないための頭打ち
    excludeDamping: 20,    // 接触の減衰。重なっている対の「近づく/離れる速さ」に比例して押し返しを増減する
    excludeSubSteps: 16,   // 体積排除が有効なときだけ使う内部分割数（硬い反発に dt=0.5 は粗すぎる）
  };

  function mergeParams(opts) {
    var p = {};
    Object.keys(DEFAULTS).forEach(function (k) { p[k] = DEFAULTS[k]; });
    Object.keys(opts || {}).forEach(function (k) { if (opts[k] != null) p[k] = opts[k]; });
    return p;
  }

  // ------------------------------------------------------------- 行列・型・初期条件

  /** K×K行列。各成分 Uniform(lo,hi) 独立同分布（対角成分も含む）。matrixSeed の 'matrix' 部分ストリームから。 */
  function buildUniformMatrix(matrixSeed, K, lo, hi) {
    var rng = makeRng(subSeed(matrixSeed, 'matrix'));
    var G = [];
    for (var a = 0; a < K; a++) {
      var row = [];
      for (var b = 0; b < K; b++) row.push(lo + rng() * (hi - lo));
      G.push(row);
    }
    return G;
  }

  /** 対角成分 diagValue・非対角成分 offValue の定数行列（正/負コントロール用）。 */
  function buildConstantMatrix(K, diagValue, offValue) {
    var G = [];
    for (var a = 0; a < K; a++) {
      var row = [];
      for (var b = 0; b < K; b++) row.push(a === b ? diagValue : offValue);
      G.push(row);
    }
    return G;
  }

  /** 非対称成分を落とした対称行列 G_sym[a][b] = (G[a][b]+G[b][a])/2。新しい行列を作る（元は変えない）。 */
  function symmetrizeMatrix(G) {
    var K = G.length, out = [];
    for (var a = 0; a < K; a++) {
      var row = [];
      for (var b = 0; b < K; b++) row.push((G[a][b] + G[b][a]) / 2);
      out.push(row);
    }
    return out;
  }

  /**
   * 「ほとんど対称化・いくつかだけ乱数」の行列（2026-09-15 ユーザ指定のプリセット①）。
   *
   * 対称化した行列（G[a][b] = G[b][a]）を土台に、**非対角の数マスだけ**を引き直す。
   * 対称化は「非対称性が創発に要るのか」を見るための参照点だが、完全な対称化は
   * 追跡関係の対象ペアを構造的に 0 件にしてしまう（S-46 本番で実際に起きた）——
   * ここはその中間、「ほぼ対称だが少しだけ非対称」を作る。
   */
  function buildSymmetrizedWithRandom(matrixSeed, K, lo, hi, randomCount) {
    var G = symmetrizeMatrix(buildUniformMatrix(matrixSeed, K, lo, hi));
    var rng = makeRng(subSeed(matrixSeed, 'symrand'));
    var cells = [];
    for (var a = 0; a < K; a++) for (var b = 0; b < K; b++) if (a !== b) cells.push([a, b]);
    var n = Math.max(0, Math.min(randomCount == null ? K : randomCount, cells.length));
    for (var i = 0; i < n; i++) { // 部分 Fisher-Yates。先頭 n 個だけ確定させれば足りる
      var j = i + Math.floor(rng() * (cells.length - i));
      var t = cells[i]; cells[i] = cells[j]; cells[j] = t;
      G[cells[i][0]][cells[i][1]] = lo + rng() * (hi - lo);
    }
    return G;
  }

  /**
   * 「乱数だが 0 付近の値が多い」行列（2026-09-15 ユーザ指定のプリセット②）。
   *
   * Uniform(-1,1) の u を `sign(u)·|u|^sharpness` へ写してから区間へ載せ直す。
   * sharpness>1 で分布が中央（=無相互作用）へ寄り、**強い引力/斥力は一部のペアにだけ残る**。
   * 一様乱数のままだと全ペアが何かしら強く効くので、疎な行列が作る構造が見えない。
   */
  function buildSparseMatrix(matrixSeed, K, lo, hi, sharpness) {
    var rng = makeRng(subSeed(matrixSeed, 'sparse'));
    var s = sharpness == null ? 3 : sharpness;
    var mid = (lo + hi) / 2, half = (hi - lo) / 2;
    var G = [];
    for (var a = 0; a < K; a++) {
      var row = [];
      for (var b = 0; b < K; b++) {
        var u = rng() * 2 - 1;
        row.push(mid + (u < 0 ? -1 : 1) * Math.pow(Math.abs(u), s) * half);
      }
      G.push(row);
    }
    return G;
  }

  /**
   * 「相互作用を全くしない型が一定数いる」行列（2026-09-15 ユーザ指定のプリセット③）。
   *
   * 選ばれた型は**行も列も 0**——他へ力を及ぼさず、他から力も受けない（近接反発だけは
   * 型によらず働くので、完全な透明ではなく「ぶつかるだけの粒子」になる）。
   */
  function buildInertTypesMatrix(matrixSeed, K, lo, hi, inertCount) {
    var G = buildUniformMatrix(matrixSeed, K, lo, hi);
    var rng = makeRng(subSeed(matrixSeed, 'inert'));
    var idx = [];
    for (var a = 0; a < K; a++) idx.push(a);
    var n = Math.max(0, Math.min(inertCount == null ? Math.max(1, Math.floor(K / 3)) : inertCount, K));
    for (var i = 0; i < n; i++) {
      var j = i + Math.floor(rng() * (K - i));
      var t = idx[i]; idx[i] = idx[j]; idx[j] = t;
      var z = idx[i];
      for (var b = 0; b < K; b++) { G[z][b] = 0; G[b][z] = 0; }
    }
    return G;
  }

  /** 粒子 i の型 = 連続ブロック割当（K種 × 各 N/K 個）。 */
  function buildTypes(N, K) {
    if (N % K !== 0) throw new Error('N (' + N + ') は K (' + K + ') で割り切れる必要がある');
    var perType = N / K;
    var types = new Int32Array(N);
    for (var i = 0; i < N; i++) types[i] = Math.floor(i / perType);
    return types;
  }

  /** 初期位置は Uniform(0,L)、初速度は平均0・標準偏差 speedStd のガウス分布（Box-Muller）。icSeed の 'ic' 部分ストリームから。 */
  function buildInitialConditions(icSeed, N, L, speedStd) {
    var rng = makeRng(subSeed(icSeed, 'ic'));
    var x = new Float64Array(N), y = new Float64Array(N);
    var vx = new Float64Array(N), vy = new Float64Array(N);
    for (var i = 0; i < N; i++) {
      x[i] = rng() * L;
      y[i] = rng() * L;
      var u1 = Math.max(rng(), 1e-12), u2 = rng();
      var r = Math.sqrt(-2 * Math.log(u1));
      vx[i] = r * Math.cos(2 * Math.PI * u2) * speedStd;
      vy[i] = r * Math.sin(2 * Math.PI * u2) * speedStd;
    }
    return { x: x, y: y, vx: vx, vy: vy };
  }

  /** 行列・型数・初期条件から世界を組み立てる共通の内部処理。 */
  function assembleWorld(opts, G, K, icSeed, matrixSeed) {
    var p = mergeParams(opts);
    p.K = K;
    var N = p.N;
    var types = buildTypes(N, K);
    var ic = buildInitialConditions(icSeed, N, p.L, p.initialSpeedStd);
    return {
      params: p, matrixSeed: matrixSeed, icSeed: icSeed, K: K, G: G, N: N, types: types,
      x: ic.x, y: ic.y, vx: ic.vx, vy: ic.vy,
      fx: new Float64Array(N), fy: new Float64Array(N),
      // 体積排除のための作業領域（多重時間刻み法。stepWorld の説明を参照）
      flx: new Float64Array(N), fly: new Float64Array(N),
      exx: new Float64Array(N), exy: new Float64Array(N),
      nearPairs: [],
      step: 0,
    };
  }

  /**
   * 標準の世界の作り方: matrixSeed から行列 G を、icSeed（省略時は matrixSeed と同じ）から
   * 初期条件を、それぞれ独立な部分ストリームで導出する。
   */
  function createWorld(opts, matrixSeed, icSeed) {
    var p = mergeParams(opts);
    var K = p.K;
    var G = buildUniformMatrix(matrixSeed, K, p.matrixLo, p.matrixHi);
    return assembleWorld(opts, G, K, icSeed == null ? matrixSeed : icSeed, matrixSeed);
  }

  /** 行列を外から与えて世界を作る（対照・対称化版など）。行列自体は乱数から作らない。 */
  function createWorldFromMatrix(opts, G, icSeed) {
    return assembleWorld(opts, G, G.length, icSeed, null);
  }

  // ------------------------------------------------------------- 力学（核。ここだけ上位概念語彙を持たない）

  /** 距離カーブの生の値（型は考慮しない部分）。近接: 負（反発）。中間: 三角形カーブ 0..1。遠方: 0。 */
  function curveShape(d, rCore, rMax) {
    if (d < rCore) return { zone: 'core', repulsion: -(1 - d / rCore), tri: 0 };
    if (d < rMax) {
      var rMid = (rCore + rMax) / 2;
      var tri = d < rMid ? (d - rCore) / (rMid - rCore) : (rMax - d) / (rMax - rMid);
      return { zone: 'mid', repulsion: 0, tri: tri };
    }
    return { zone: 'far', repulsion: 0, tri: 0 };
  }

  /**
   * 外枠から受ける内向きの加速度（2026-09-15 ユーザ指定「フィールドの外枠に反発力を追加せよ」）。
   *
   * `wallPush(p, d)` は壁までの距離 d に対する押し返しの大きさ。ユーザの例
   * 「フィールド外側 n px では内向きの加速度を与える。n が小さくなるに従い加速度は大きくなる
   * （例: (10 - n)^2）」の形——**2次で増える**——をそのまま採り、`wallMargin` で正規化して
   * `wallStrength` が「壁面ちょうどでの加速度」になるようにしてある。
   *
   * 壁の外（弾性反射が追いつかなかった場合）は `wallStrength` で頭打ちにする——
   * 正規化しないと遠くへ出た粒子に発散的な力がかかり、陽的オイラー法が壊れる。
   * 壁での弾性反射は**残してある**（反発は柔らかい減速であって、閉じ込めの保証ではない）。
   */
  function wallPush(p, d) {
    var wm = p.wallMargin, ws = p.wallStrength;
    if (!(ws > 0) || !(wm > 0)) return 0;
    var t = (wm - d) / wm;
    if (t <= 0) return 0;
    return t > 1 ? ws : ws * t * t;
  }

  /** x 方向の外枠加速度（左の壁は +x へ、右の壁は -x へ押す）。 */
  function wallAccelX(p, x) { return wallPush(p, x) - wallPush(p, p.L - x); }

  /** y 方向の外枠加速度。 */
  function wallAccelY(p, y) { return wallPush(p, y) - wallPush(p, p.L - y); }

  /**
   * 体積排除の押し返しの大きさ（2026-09-16 ユーザ指定「すべての粒子が、同一空間を占められない
   * （占めにくい）ようにする：中心距離が直径以下になると反発力が生まれる、など」）。
   *
   * 中心間距離 d が直径 σ = 2·particleRadius を下回ったとき、**型によらず**働く反発。
   *
   *     excludePush(d) = excludeStrength · (σ/d − 1)     （0 < d < σ、excludeMaxAccel で頭打ち）
   *
   * `1/d` で**発散する**形を選んだ。既にある近接反発（rCore の三角形の足、大きさの上限 1）は
   * 有限であり、**引力が上回れば粒子は重なれる**——実際「自身と引き合う型は1点へ潰れる」という
   * 現象が観察されている（2026-09-15 ユーザのコメント）。有限の反発をいくら強くしても
   * 「潰れにくい」にしかならず、「占められない」にはならないので、d→0 で無限大になる形が要る。
   * 比較した代替案と選定根拠は README.md「体積排除の設計」を参照。
   *
   * 発散は陽的オイラー法と両立しないため `excludeMaxAccel` で頭打ちにする（外枠の反発で
   * 壁の外側を頭打ちにしたのと同じ理由）。頭打ちに達するのは d < σ/(1+Cap/k) の深い重なりだけで、
   * そこでは 1 step の変位が σ を超えて押し出すので、重なりは次の step で解消へ向かう。
   *
   * 無効（excludeOverlap=false）のときは常に 0 を返す——**この関数の戻り値が 0 かどうかが、
   * 系の規則が変わったかどうかそのもの**である。
   */
  function excludePush(p, d) {
    if (!p.excludeOverlap) return 0;
    var sigma = 2 * p.particleRadius, k = p.excludeStrength, cap = p.excludeMaxAccel;
    if (!(sigma > 0) || !(k > 0) || d >= sigma) return 0;
    if (!(d > 0)) return cap;
    var mag = k * (sigma / d - 1);
    return mag > cap ? cap : mag;
  }

  /** i が j から受ける力の大きさ（正 = j へ向かう引力、負 = j から遠ざかる斥力）。 */
  function forceMagnitude(d, gab, rCore, rMax) {
    var c = curveShape(d, rCore, rMax);
    if (c.zone === 'core') return c.repulsion;
    if (c.zone === 'mid') return gab * c.tri;
    return 0;
  }

  /**
   * 1 step 進める。位置・速度の配列をその場で更新する（N・step 数が大きい数値シミュレーションのため。他の全スケッチと同じ規約）。
   *
   * **体積排除が有効なときは時間刻みを2段に分ける**（分子動力学の多重時間刻み法と同じ考え方）:
   *
   *   - なめらかで遠くまで届く力（型ペアの引力/斥力・外枠の反発）は **1 step に 1 度だけ** O(N²) で計算して固定する
   *   - 硬い排除の力と積分だけを `excludeSubSteps` 回に分けて進める。排除は直径 σ 以内の対にしか
   *     働かないので、あらかじめ集めた近傍対だけを見ればよく、**分割を増やしても費用はほとんど増えない**
   *
   * 分けないと成立しない: dt=0.5 のまま硬い反発を入れると陽的オイラー法が毎 step 行き過ぎ、
   * 静止していた塊が速度 20 超で跳ね回るのを実測した（比較は README.md「体積排除の設計」）。
   * 逆に全体を 16 分割すると O(N²) ループが 16 倍になり、可視化が実用にならない。
   *
   * 近傍対の集め方: σ だけでなく **この step で動きうる距離（最大速度×dt の2倍）** を足した半径で集める。
   * σ だけで集めると、速い粒子が 1 step で候補圏外から σ 内へ飛び込んだとき排除をすり抜ける。
   *
   * 体積排除が無効なときは分割数 1・排除力ゼロとなり、**この関数は従来と1ビットも違わない**
   * （選定の経緯とこの性質の検査は selftest.js の 24 節）。
   */
  function stepWorld(w) {
    var p = w.params, N = w.N, G = w.G, types = w.types;
    var x = w.x, y = w.y, vx = w.vx, vy = w.vy, fx = w.fx, fy = w.fy;
    // 手組みの世界（検査で使う最小構成など）にも作業領域を後から用意する
    if (!w.flx) {
      w.flx = new Float64Array(N); w.fly = new Float64Array(N);
      w.exx = new Float64Array(N); w.exy = new Float64Array(N);
      w.nearPairs = [];
    }
    var flx = w.flx, fly = w.fly, exx = w.exx, exy = w.exy;
    var rCore = p.rCore, rMax = p.rMax, rMax2 = rMax * rMax;
    var exOn = !!p.excludeOverlap && p.particleRadius > 0 && p.excludeStrength > 0;
    var sigma = 2 * p.particleRadius, sigma2 = sigma * sigma;
    var pairs = w.nearPairs;
    pairs.length = 0;
    var near2 = 0;
    if (exOn) {
      var maxSpeed = 0;
      for (var m = 0; m < N; m++) {
        var sp = Math.abs(vx[m]) + Math.abs(vy[m]); // L1 で見積もる（L2 の上界。平方根を避ける）
        if (sp > maxSpeed) maxSpeed = sp;
      }
      var nearR = Math.min(rMax, sigma + 2 * maxSpeed * p.dt);
      near2 = nearR * nearR;
    }
    for (var i = 0; i < N; i++) {
      var ti = types[i], gi = G[ti];
      var xi = x[i], yi = y[i];
      var sfx = 0, sfy = 0;
      for (var j = 0; j < N; j++) {
        if (j === i) continue;
        var dx = x[j] - xi, dy = y[j] - yi;
        var d2 = dx * dx + dy * dy;
        if (d2 >= rMax2) continue;
        var d = Math.sqrt(d2);
        if (d < 1e-9) continue; // 完全一致（ほぼ起こらない）は寄与ゼロとして飛ばす
        if (exOn && j > i && d2 < near2) { pairs.push(i); pairs.push(j); }
        var mag = forceMagnitude(d, gi[types[j]], rCore, rMax);
        sfx += (dx / d) * mag;
        sfy += (dy / d) * mag;
      }
      // 粒子どうしの力の**後**に外枠の反発を足す。粒子ごとに1度だけ働く場の力である
      flx[i] = sfx + wallAccelX(p, xi);
      fly[i] = sfy + wallAccelY(p, yi);
    }
    var L = p.L, keep = 1 - p.friction, dt = p.dt;
    var ns = exOn ? Math.max(1, p.excludeSubSteps | 0) : 1;
    if (ns > 1) { dt = dt / ns; keep = Math.pow(keep, 1 / ns); } // 分割しても1 step 当たりの減衰は変わらない
    for (var sub = 0; sub < ns; sub++) {
      if (exOn) {
        exx.fill(0); exy.fill(0);
        for (var q = 0; q < pairs.length; q += 2) {
          var a = pairs[q], b = pairs[q + 1];
          var ex = x[b] - x[a], ey = y[b] - y[a];
          var e2 = ex * ex + ey * ey;
          if (e2 >= sigma2 || e2 < 1e-18) continue;
          var ed = Math.sqrt(e2);
          var nx0 = ex / ed, ny0 = ey / ed;
          // 接触の減衰（粉体シミュレーションの標準形）。法線方向の相対速度 vrel（正 = 離れつつある）に
          // 比例する分を押し返しから引く。潰し合う対からエネルギーを抜き、跳ね回りを止める。
          // 引力にはしない（0 で床を張る）——接触が粘って離れなくなるのを防ぐため
          var vrel = (vx[b] - vx[a]) * nx0 + (vy[b] - vy[a]) * ny0;
          var push = excludePush(p, ed) - p.excludeDamping * vrel;
          if (push < 0) push = 0;
          else if (push > p.excludeMaxAccel) push = p.excludeMaxAccel;
          var ux = nx0 * push, uy = ny0 * push;
          exx[a] -= ux; exy[a] -= uy; // a は b から遠ざかる向きへ
          exx[b] += ux; exy[b] += uy;
        }
      }
      for (var k = 0; k < N; k++) {
        var tfx = exOn ? flx[k] + exx[k] : flx[k];
        var tfy = exOn ? fly[k] + exy[k] : fly[k];
        // 最初の分割での合力＝step 開始時の位置で評価した全力。bruteForceField との突き合わせ断面（K-12）
        if (sub === 0) { fx[k] = tfx; fy[k] = tfy; }
        var nvx = (vx[k] + tfx * dt) * keep;
        var nvy = (vy[k] + tfy * dt) * keep;
        var nx = x[k] + nvx * dt;
        var ny = y[k] + nvy * dt;
        var guard = 0;
        while ((nx < 0 || nx > L) && guard++ < 8) {
          if (nx < 0) { nx = -nx; nvx = -nvx; }
          if (nx > L) { nx = 2 * L - nx; nvx = -nvx; }
        }
        guard = 0;
        while ((ny < 0 || ny > L) && guard++ < 8) {
          if (ny < 0) { ny = -ny; nvy = -nvy; }
          if (ny > L) { ny = 2 * L - ny; nvy = -nvy; }
        }
        vx[k] = nvx; vy[k] = nvy; x[k] = nx; y[k] = ny;
      }
    }
    w.step++;
  }

  function runSteps(w, n) { for (var t = 0; t < n; t++) stepWorld(w); }

  /**
   * 力学だけの O(N^2) 総当たり計算（近道の索引を使わない基準実装）。stepWorld と同じ式で、検算用に力の場を返す。
   * 体積排除の接触の減衰も含める（stepWorld の最初の分割での合力と一致させるため）。速度を持たない
   * 世界（検査で使う位置だけのスナップショット）では相対速度 0 として扱う。
   */
  function bruteForceField(w) {
    var p = w.params, N = w.N, G = w.G, types = w.types;
    var x = w.x, y = w.y, vx = w.vx, vy = w.vy, rCore = p.rCore, rMax = p.rMax, rMax2 = rMax * rMax;
    var exOn = !!p.excludeOverlap && p.particleRadius > 0 && p.excludeStrength > 0;
    var sigma = 2 * p.particleRadius; // 接触の減衰は「重なっている対」にしか働かない（直径の外では 0）
    var ffx = new Float64Array(N), ffy = new Float64Array(N);
    for (var i = 0; i < N; i++) {
      var gi = G[types[i]], xi = x[i], yi = y[i];
      for (var j = 0; j < N; j++) {
        if (j === i) continue;
        var dx = x[j] - xi, dy = y[j] - yi;
        var d2 = dx * dx + dy * dy;
        if (d2 >= rMax2) continue;
        var d = Math.sqrt(d2);
        if (d < 1e-9) continue;
        var mag = forceMagnitude(d, gi[types[j]], rCore, rMax);
        if (exOn && d < sigma) {
          var vrel = vx && vy ? ((vx[j] - vx[i]) * (dx / d) + (vy[j] - vy[i]) * (dy / d)) : 0;
          var push = excludePush(p, d) - p.excludeDamping * vrel;
          if (push < 0) push = 0;
          else if (push > p.excludeMaxAccel) push = p.excludeMaxAccel;
          mag -= push;
        }
        ffx[i] += (dx / d) * mag;
        ffy[i] += (dy / d) * mag;
      }
      ffx[i] += wallAccelX(p, xi);
      ffy[i] += wallAccelY(p, yi);
    }
    return { fx: ffx, fy: ffy };
  }

  /** 状態の決定的なハッシュ（K-36）。同一シードでの再現性・腕どうしの同一性判定に使う。 */
  function stateHash(w) {
    var h = 2166136261 >>> 0;
    var buf = new Float64Array(1), view = new Uint32Array(buf.buffer);
    function mix(v) {
      buf[0] = v;
      h = Math.imul(h ^ view[0], 16777619) >>> 0;
      h = Math.imul(h ^ view[1], 16777619) >>> 0;
    }
    for (var i = 0; i < w.N; i++) { mix(w.x[i]); mix(w.y[i]); mix(w.vx[i]); mix(w.vy[i]); }
    return (h >>> 0).toString(16);
  }

  // ------------------------------------------------------------- 観測器
  //
  // ここから先だけが「クラスタ」「膜」「追跡」を語る。核の側には無い語彙を使ってよい唯一の場所。

  /** Union-Find。半径 radius で繋がる連結成分を求める（総当たり O(N^2)。N=240 では索引を要らない）。 */
  function connectedComponents(w, radius) {
    var N = w.N, r2 = radius * radius;
    var parent = new Int32Array(N);
    for (var i = 0; i < N; i++) parent[i] = i;
    function find(x) { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; }
    for (i = 0; i < N; i++) {
      for (var j = i + 1; j < N; j++) {
        var dx = w.x[i] - w.x[j], dy = w.y[i] - w.y[j];
        if (dx * dx + dy * dy <= r2) {
          var ra = find(i), rb = find(j);
          if (ra !== rb) parent[ra] = rb;
        }
      }
    }
    var labels = new Int32Array(N), sizeMap = {};
    for (i = 0; i < N; i++) { var r = find(i); labels[i] = r; sizeMap[r] = (sizeMap[r] || 0) + 1; }
    return {
      labels: labels,
      sizeOf: function (root) { return sizeMap[root] || 0; },
      roots: Object.keys(sizeMap).map(Number),
    };
  }

  /** connectedComponents と同じ答えを、格子を使わない素朴な総当たりでもう一度出す（近道の検算）。実装は同じ総当たりなので恒等的に一致するが、独立した経路として API を分けておく。 */
  function connectedComponentsBrute(w, radius) { return connectedComponents(w, radius); }

  function clusterCohesionFromCC(w, cc, minSize) {
    var count = 0;
    for (var i = 0; i < w.N; i++) if (cc.sizeOf(cc.labels[i]) >= minSize) count++;
    return count / w.N;
  }

  function clusterCohesion(w, radius, minSize) {
    return clusterCohesionFromCC(w, connectedComponents(w, radius), minSize);
  }

  function largestComponentMembers(w, cc) {
    var bestRoot = -1, bestSize = 0;
    cc.roots.forEach(function (r) { var s = cc.sizeOf(r); if (s > bestSize) { bestSize = s; bestRoot = r; } });
    var members = [];
    if (bestRoot >= 0) for (var i = 0; i < w.N; i++) if (cc.labels[i] === bestRoot) members.push(i);
    return members;
  }

  /** 核-殻（膜）構造の検出器。最大クラスタの重心から放射ビンへ分け、密度比と型純度を返す。 */
  function membraneShellFromCC(w, cc, minSize, rBin, maxBins) {
    var members = largestComponentMembers(w, cc);
    if (members.length < minSize) return { densityRatio: 0, typePurity: 0, clusterSize: members.length, peakBin: -1 };
    var cx = 0, cy = 0;
    members.forEach(function (i) { cx += w.x[i]; cy += w.y[i]; });
    cx /= members.length; cy /= members.length;
    var bins = [];
    for (var b = 0; b < maxBins; b++) bins.push({ count: 0, types: {} });
    var maxBinIdx = 0;
    members.forEach(function (i) {
      var dx = w.x[i] - cx, dy = w.y[i] - cy;
      var d = Math.sqrt(dx * dx + dy * dy);
      var bi = Math.min(maxBins - 1, Math.floor(d / rBin));
      bins[bi].count++;
      var t = w.types[i];
      bins[bi].types[t] = (bins[bi].types[t] || 0) + 1;
      if (bi > maxBinIdx) maxBinIdx = bi;
    });
    function area(bi) { var rIn = bi * rBin, rOut = (bi + 1) * rBin; return Math.PI * (rOut * rOut - rIn * rIn); }
    var innerDensity = bins[0].count / area(0);
    var peakBin = -1, peakDensity = -1;
    for (var bi2 = 1; bi2 <= maxBinIdx; bi2++) {
      var dens = bins[bi2].count / area(bi2);
      if (dens > peakDensity) { peakDensity = dens; peakBin = bi2; }
    }
    var densityRatio = 0, purity = 0;
    if (peakBin >= 0) {
      densityRatio = innerDensity > 0 ? peakDensity / innerDensity : (peakDensity > 0 ? Infinity : 0);
      var counts = bins[peakBin].types, total = bins[peakBin].count, best = 0;
      Object.keys(counts).forEach(function (k) { if (counts[k] > best) best = counts[k]; });
      purity = total > 0 ? best / total : 0;
    }
    return { densityRatio: densityRatio, typePurity: purity, clusterSize: members.length, peakBin: peakBin };
  }

  function membraneShellIndex(w, radius, minSize, rBin, maxBins) {
    return membraneShellFromCC(w, connectedComponents(w, radius), minSize, rBin, maxBins);
  }

  /** log(msd) を log(tau) に最小二乗フィットした傾き（局所拡散指数）。 */
  function fitLogLogSlope(points) {
    var xs = [], ys = [];
    points.forEach(function (p) { if (p.msd > 0) { xs.push(Math.log(p.tau)); ys.push(Math.log(p.msd)); } });
    var n = xs.length;
    if (n < 2) return NaN;
    var mx = 0, my = 0;
    for (var i = 0; i < n; i++) { mx += xs[i]; my += ys[i]; }
    mx /= n; my /= n;
    var sxx = 0, sxy = 0;
    for (i = 0; i < n; i++) { var dx = xs[i] - mx, dy = ys[i] - my; sxx += dx * dx; sxy += dx * dy; }
    return sxx > 0 ? sxy / sxx : NaN;
  }

  /** {t,x,y,valid} の時系列から、ラグ tau ごとの MSD を作り log-log 傾きを返す。両端が有効な対だけを使う。 */
  function selfPropulsionFromSeries(series, tauMin, tauMax, tauStep) {
    var n = series.length, msdSeries = [];
    for (var tau = tauMin; tau <= tauMax; tau += tauStep) {
      var sum = 0, cnt = 0;
      for (var t0 = 0; t0 + tau < n; t0++) {
        var a = series[t0], b = series[t0 + tau];
        if (!a.valid || !b.valid) continue;
        var dx = b.x - a.x, dy = b.y - a.y;
        sum += dx * dx + dy * dy; cnt++;
      }
      if (cnt > 0) msdSeries.push({ tau: tau, msd: sum / cnt });
    }
    if (msdSeries.length < 2) return NaN;
    return fitLogLogSlope(msdSeries);
  }

  /** G[a][b]>posThr かつ G[b][a]<negThr を満たす型ペア (a,b) の一覧。 */
  function qualifyingPursuitPairs(G, K, posThr, negThr) {
    var pairs = [];
    for (var a = 0; a < K; a++) {
      for (var b = 0; b < K; b++) {
        if (a === b) continue;
        if (G[a][b] > posThr && G[b][a] < negThr) pairs.push([a, b]);
      }
    }
    return pairs;
  }

  /** その瞬間の cos(theta) の総和と件数（b型粒子ごとに、最寄りのa型粒子への方向と速度方向のなす角）。 */
  function pursuitAsymmetryStep(w, pairs) {
    var sum = 0, cnt = 0;
    pairs.forEach(function (pair) {
      var a = pair[0], b = pair[1];
      for (var i = 0; i < w.N; i++) {
        if (w.types[i] !== b) continue;
        var bestD2 = Infinity, bestJ = -1;
        for (var j = 0; j < w.N; j++) {
          if (w.types[j] !== a) continue;
          var dx = w.x[j] - w.x[i], dy = w.y[j] - w.y[i];
          var d2 = dx * dx + dy * dy;
          if (d2 < bestD2) { bestD2 = d2; bestJ = j; }
        }
        if (bestJ < 0) continue;
        var dx2 = w.x[bestJ] - w.x[i], dy2 = w.y[bestJ] - w.y[i];
        var dist = Math.sqrt(bestD2);
        var vmag = Math.sqrt(w.vx[i] * w.vx[i] + w.vy[i] * w.vy[i]);
        if (dist <= 0 || vmag <= 0) continue;
        sum += (w.vx[i] * dx2 + w.vy[i] * dy2) / (vmag * dist);
        cnt++;
      }
    });
    return { sum: sum, cnt: cnt };
  }

  var MEASURE_DEFAULTS = {
    connectivityRadius: 6, minClusterSize: 10,
    burnIn: 1000, observe: 4000,
    msdTail: 3000, tauMin: 50, tauMax: 500, tauStep: 10,
    rBin: 3, maxBins: 15,
    pursuitPosThreshold: 0.2, pursuitNegThreshold: -0.2,
  };

  /**
   * 事前登録した5つの秩序変数をまとめて測る。バーンイン→測定窓の順に世界を実際に進める
   * （w はその場で進む。呼び出し後の w は測定窓の最終状態）。
   */
  function measure(w, opts) {
    var mp = {};
    Object.keys(MEASURE_DEFAULTS).forEach(function (k) { mp[k] = MEASURE_DEFAULTS[k]; });
    Object.keys(opts || {}).forEach(function (k) { if (opts[k] != null) mp[k] = opts[k]; });

    for (var t = 0; t < mp.burnIn; t++) stepWorld(w);

    var pairs = qualifyingPursuitPairs(w.G, w.K, mp.pursuitPosThreshold, mp.pursuitNegThreshold);
    var pursuitSum = 0, pursuitCnt = 0;
    var splitTracked = [], splitBirths = 0, splitDeaths = 0, splitSizeSum = 0;
    var centroidSeries = [];
    var tailStart = mp.observe - mp.msdTail;

    for (var s = 0; s < mp.observe; s++) {
      stepWorld(w);
      var cc = connectedComponents(w, mp.connectivityRadius);
      var byRoot = {};
      for (var i = 0; i < w.N; i++) { var r = cc.labels[i]; (byRoot[r] = byRoot[r] || []).push(i); }
      var clustersNow = [];
      Object.keys(byRoot).forEach(function (k) { if (byRoot[k].length >= mp.minClusterSize) clustersNow.push(byRoot[k]); });

      var matched = clustersNow.map(function () { return false; });
      var trackedMatched = splitTracked.map(function () { return false; });
      var newTracked = [];
      clustersNow.forEach(function (members) {
        var memberSet = {};
        members.forEach(function (m) { memberSet[m] = true; });
        var bestIdx = -1, bestFrac = 0;
        splitTracked.forEach(function (tc, idx) {
          if (trackedMatched[idx]) return;
          var overlap = 0;
          tc.members.forEach(function (m) { if (memberSet[m]) overlap++; });
          var frac = overlap / Math.max(tc.members.length, members.length);
          if (frac > 0.5 && frac > bestFrac) { bestFrac = frac; bestIdx = idx; }
        });
        if (bestIdx >= 0) { trackedMatched[bestIdx] = true; newTracked.push({ members: members }); }
        else { splitBirths++; newTracked.push({ members: members }); }
      });
      splitTracked.forEach(function (tc, idx) { if (!trackedMatched[idx]) splitDeaths++; });
      splitTracked = newTracked;
      splitSizeSum += splitTracked.length;

      if (s >= tailStart) {
        var bestRoot = -1, bestSize = 0;
        Object.keys(byRoot).forEach(function (k) { if (byRoot[k].length > bestSize) { bestSize = byRoot[k].length; bestRoot = k; } });
        if (bestSize >= mp.minClusterSize) {
          var mem = byRoot[bestRoot], sx = 0, sy = 0;
          mem.forEach(function (i2) { sx += w.x[i2]; sy += w.y[i2]; });
          centroidSeries.push({ t: s - tailStart, x: sx / mem.length, y: sy / mem.length, valid: true });
        } else {
          centroidSeries.push({ t: s - tailStart, valid: false });
        }
      }

      if (pairs.length > 0) {
        var pr = pursuitAsymmetryStep(w, pairs);
        pursuitSum += pr.sum; pursuitCnt += pr.cnt;
      }
    }

    var finalCC = connectedComponents(w, mp.connectivityRadius);
    var membrane = membraneShellFromCC(w, finalCC, mp.minClusterSize, mp.rBin, mp.maxBins);
    var meanSurviving = splitSizeSum / mp.observe;
    var splitReformRate = meanSurviving > 0 ? ((splitBirths + splitDeaths) / meanSurviving) * (1000 / mp.observe) : 0;

    return {
      clusterCohesion: clusterCohesionFromCC(w, finalCC, mp.minClusterSize),
      selfPropulsionIndex: selfPropulsionFromSeries(centroidSeries, mp.tauMin, mp.tauMax, mp.tauStep),
      membraneShellIndex: membrane.densityRatio,
      membraneTypePurity: membrane.typePurity,
      splitReformRate: splitReformRate,
      pursuitAsymmetryIndex: pursuitCnt > 0 ? pursuitSum / pursuitCnt : NaN,
      diagnostics: {
        finalLargestClusterSize: membrane.clusterSize,
        pursuitPairs: pairs, pursuitCount: pursuitCnt,
        splitBirths: splitBirths, splitDeaths: splitDeaths, meanSurviving: meanSurviving,
        centroidValidSteps: centroidSeries.filter(function (c) { return c.valid; }).length,
        stateHash: stateHash(w),
      },
    };
  }

  return {
    DEFAULTS: DEFAULTS, MEASURE_DEFAULTS: MEASURE_DEFAULTS,
    makeRng: makeRng, subSeed: subSeed,
    buildUniformMatrix: buildUniformMatrix, buildConstantMatrix: buildConstantMatrix, symmetrizeMatrix: symmetrizeMatrix,
    buildSymmetrizedWithRandom: buildSymmetrizedWithRandom, buildSparseMatrix: buildSparseMatrix,
    buildInertTypesMatrix: buildInertTypesMatrix,
    wallPush: wallPush, wallAccelX: wallAccelX, wallAccelY: wallAccelY,
    excludePush: excludePush,
    buildTypes: buildTypes, buildInitialConditions: buildInitialConditions,
    createWorld: createWorld, createWorldFromMatrix: createWorldFromMatrix,
    curveShape: curveShape, forceMagnitude: forceMagnitude,
    stepWorld: stepWorld, runSteps: runSteps, bruteForceField: bruteForceField, stateHash: stateHash,
    connectedComponents: connectedComponents, connectedComponentsBrute: connectedComponentsBrute,
    clusterCohesion: clusterCohesion, clusterCohesionFromCC: clusterCohesionFromCC,
    largestComponentMembers: largestComponentMembers,
    membraneShellIndex: membraneShellIndex, membraneShellFromCC: membraneShellFromCC,
    fitLogLogSlope: fitLogLogSlope, selfPropulsionFromSeries: selfPropulsionFromSeries,
    qualifyingPursuitPairs: qualifyingPursuitPairs, pursuitAsymmetryStep: pursuitAsymmetryStep,
    measure: measure,
  };
});
