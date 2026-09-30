/**
 * S-71: Swarm Chemistry（Sayama 2009）の再実装。
 *
 * 各粒子は「型」を持たない。個々の粒子が持つのは8つ組ゲノム
 * （知覚半径 R・通常速度 Vn・最大速度 Vm・凝集 c1・整列 c2・分離 c3・乱択操舵確率 c4・速度維持 c5）
 * だけで、近傍の**集約**（重心・平均速度・分離力の和）にしか反応しない。型ペアの相互作用行列
 * （S-46 Particle Life の G[a][b]）はどこにも無い。
 *
 * 出典・借用の詳細は criteria.json の sources / sourceFidelity / borrowedConstants を見よ。
 * 運動規則と境界条件は Sayama, H. (2013) arXiv:1308.3400（原典 2009 の再掲）。
 * 19本のレシピの数値・場のサイズ・分離力の分母クリップ・壁反発項（RP4専用）は、
 * ユーザ自身の Swift 移植 ../SwarmChemistry（読み取りのみ・一切編集していない）から書き写した。
 *
 * ## 実装ノート（Swift 移植を読んで気づいた等価性）
 *
 * 移植の Individual.acceleration は毎ステップ**零に戻さず積み増され**、move() で
 * velocity = acceleration と代入される。すなわち acceleration と velocity は各ステップの
 * 終わりには常に同じ値であり、「加速度」という変数名にもかかわらず実質は**速度そのもの**を
 * 保持している。本実装はこれを見抜き、1粒子につき (vx, vy) という**単一の状態**だけを持つ
 * （accelerate() の2回の呼び出し——力の加算とクランプ、および c5 のペースキープ補正——を
 * 純粋な数式として素直に書き下せる）。
 *
 * また Swift 版の Vector2.fit() は「場の外に出たら剰余で内側へ戻す」という**トーラス的な折返し**
 * であり、A1（原典側の擬似周期境界）・A4（移植の境界条件）のどちらでも**同一**に働く。
 * 両者の違いは「壁反発の加速度項を足すかどうか」だけであり、位置の折返し規則そのものは
 * 変えていない。criteria.json の sourceFidelity ③にある「位置を場の内側へ丸める」という記述は、
 * 実装上は「強い壁反発が折返しに到達する前に押し戻す」という**挙動としての結果**であって、
 * 折返し規則自体が A1 と A4 で違うわけではない（本ノートは raw/notes.md へも転記する）。
 *
 * 依存ゼロ。Node（生ログ生成）とブラウザ（可視化）が同じファイルを読む（UMD 風）。
 *
 * 語彙について: この核には「型」「捕食者」「群れ」という上位概念の語彙を使っていない
 * （変数名は R/Vn/Vm/c1..c5・genome・population だけ）。構造を語る語彙は stats.js の側にある。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S54 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ------------------------------------------------------------- 乱数

  /** mulberry32。シードを固定すれば完全に再現する（S-02/S-13/S-46 と同じ最小実装）。 */
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
   * seed と用途タグ（文字列）から独立した部分シードを作る（FNV-1a 風のハッシュ混合）。
   * criteria.json の whatSeedChanges が挙げる5つの用途——①初期位置 ②c4乱択操舵の判定と
   * ベクトル ③近傍0時のランダム加速度 ④ラベル入替え帰無 ⑤CSR包絡——を独立ストリームにする。
   */
  function deriveSeed(seed, tag) {
    var h = (seed >>> 0) ^ 0x811c9dc5;
    for (var i = 0; i < tag.length; i++) {
      h ^= tag.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
  }

  // ------------------------------------------------------- ゲノム・レシピ

  /** Sayama (2013) arXiv:1308.3400 の parameter table（原典 2009 の再掲）。 */
  var PARAM_MAX = { R: 300, Vn: 20, Vm: 40, c1: 1, c2: 1, c3: 100, c4: 0.5, c5: 1 };
  var FIELD_SIZE = 500;
  var SEPARATION_MIN_D2 = 0.001; // 移植 Population.swift の分離力の分母クリップ
  var WALL_REPULSE_DIST = PARAM_MAX.R * 2; // 600。移植 Population.swift の repulsiveDistance

  function genome(R, Vn, Vm, c1, c2, c3, c4, c5) {
    return { R: R, Vn: Vn, Vm: Vm, c1: c1, c2: c2, c3: c3, c4: c4, c5: c5 };
  }

  /**
   * 19本のレシピ。数値はユーザ自身の Swift 移植 RecipeDefinitions.swift から一字一句書き写した
   * （criteria.json borrowedConstants「19本のレシピの数値」）。読み取りのみ・移植コードは非参照で
   * このファイルへ書いた（移植自体は編集していない）。
   */
  var RECIPES = [
    { name: 'Slicer', rows: [
      { count: 12, genome: genome(86.89, 1.8, 22.26, 0.57, 0.35, 80.8, 0.35, 0.64) },
      { count: 1, genome: genome(140.55, 2.52, 20.39, 0.97, 0.45, 35.51, 0.45, 0.06) },
    ] },
    { name: 'Oscillator', rows: [
      { count: 500, genome: genome(200.0, 20.0, 40.0, 0.64, 0.01, 0.29, 0.08, 0.97) },
      { count: 120, genome: genome(300.0, 7.19, 15.51, 1.0, 0.33, 32.65, 0.34, 0.56) },
    ] },
    { name: 'Insurmountable Wall', rows: [
      { count: 42, genome: genome(52.57, 9.91, 20.42, 0.32, 0.76, 1.8, 0.01, 0.64) },
      { count: 25, genome: genome(84.87, 8.82, 24.98, 0.91, 0.44, 40.97, 0.18, 0.6) },
      { count: 45, genome: genome(220.42, 4.65, 7.53, 0.96, 0.35, 46.18, 0.25, 1.0) },
      { count: 49, genome: genome(279.64, 10.29, 35.95, 0.37, 0.49, 38.09, 0.32, 0.89) },
    ] },
    { name: 'Cell With 2 Nuclei', rows: [
      { count: 41, genome: genome(249.84, 4.85, 28.73, 0.34, 0.45, 14.44, 0.09, 0.82) },
      { count: 26, genome: genome(277.87, 15.02, 35.48, 0.68, 0.05, 82.96, 0.46, 0.9) },
      { count: 30, genome: genome(277.87, 15.02, 24.44, 0.68, 0.05, 82.96, 0.43, 0.9) },
      { count: 28, genome: genome(110.8, 16.12, 38.6, 0.18, 0.34, 14.3, 0.01, 0.01) },
      { count: 48, genome: genome(83.79, 13.29, 7.54, 0.08, 0.79, 1.07, 0.15, 0.45) },
      { count: 74, genome: genome(269.64, 6.62, 34.69, 0.36, 0.5, 30.2, 0.03, 0.23) },
    ] },
    { name: 'Multicellularity', rows: [
      { count: 99, genome: genome(19.8, 15.73, 2.61, 0.85, 0.64, 10.51, 0.17, 0.06) },
      { count: 48, genome: genome(300.0, 14.63, 0.0, 0.48, 0.81, 90.27, 0.25, 0.78) },
      { count: 37, genome: genome(275.18, 16.9, 7.05, 0.48, 0.81, 90.27, 0.17, 0.85) },
      { count: 8, genome: genome(159.59, 2.09, 24.19, 0.96, 0.59, 76.03, 0.01, 0.07) },
      { count: 42, genome: genome(73.07, 1.82, 2.36, 0.27, 0.61, 40.55, 0.22, 0.86) },
    ] },
    { name: 'Jelly Fish', rows: [
      { count: 134, genome: genome(262.65, 12.01, 25.87, 0.97, 1.0, 56.35, 0.26, 0.61) },
      { count: 67, genome: genome(288.17, 6.19, 23.37, 0.95, 1.0, 1.31, 0.1, 0.9) },
      { count: 68, genome: genome(150.5, 12.97, 15.87, 0.46, 0.39, 57.95, 0.17, 0.48) },
    ] },
    { name: 'No, Wait - This Way', rows: [
      { count: 60, genome: genome(262.68, 2.82, 38.32, 0.21, 0.01, 54.93, 0.11, 0.19) },
      { count: 40, genome: genome(78.58, 5.7, 33.23, 0.89, 0.18, 45.44, 0.04, 0.05) },
      { count: 40, genome: genome(257.27, 14.96, 35.66, 0.2, 0.8, 47.81, 0.13, 0.13) },
    ] },
    { name: 'Recombining Blobs', rows: [
      { count: 132, genome: genome(45.91, 10.82, 21.11, 0.86, 0.13, 42.48, 0.32, 0.74) },
      { count: 84, genome: genome(113.26, 3.41, 25.71, 0.4, 0.39, 49.53, 0.13, 0.24) },
    ] },
    { name: 'Playing Catch', rows: [
      { count: 76, genome: genome(84.06, 0.09, 9.89, 0.33, 0.32, 15.66, 0.22, 0.68) },
      { count: 100, genome: genome(158.86, 18.4, 24.98, 0.3, 0.3, 1.72, 0.06, 0.37) },
    ] },
    { name: 'Pulsating Eye', rows: [
      { count: 102, genome: genome(293.86, 17.06, 38.3, 0.81, 0.05, 0.83, 0.2, 0.9) },
      { count: 124, genome: genome(226.18, 19.27, 24.57, 0.95, 0.84, 13.09, 0.07, 0.8) },
      { count: 74, genome: genome(49.98, 8.44, 4.39, 0.92, 0.14, 96.92, 0.13, 0.51) },
    ] },
    { name: 'Chaos Cells', rows: [
      { count: 144, genome: genome(109.03, 6.71, 12.7, 0.47, 0.6, 61.43, 0.02, 0.21) },
      { count: 89, genome: genome(117.15, 16.33, 31.88, 0.39, 0.13, 12.96, 0.48, 0.8) },
      { count: 67, genome: genome(76.3, 8.59, 26.57, 0.7, 0.64, 28.39, 0.3, 0.35) },
    ] },
    { name: 'Aggressive Predator', rows: [
      { count: 18, genome: genome(211.92, 12.59, 19.37, 0.09, 0.21, 57.92, 0.0, 0.95) },
      { count: 41, genome: genome(257.27, 14.96, 35.66, 0.2, 0.8, 47.81, 0.13, 0.13) },
      { count: 35, genome: genome(262.68, 2.82, 38.32, 0.21, 0.01, 54.93, 0.11, 0.19) },
      { count: 31, genome: genome(78.58, 5.7, 33.23, 0.89, 0.18, 45.44, 0.04, 0.05) },
      { count: 7, genome: genome(194.21, 12.88, 21.68, 0.97, 0.19, 99.21, 0.5, 0.13) },
    ] },
    { name: 'Fast Walker and Slow Follower', rows: [
      { count: 67, genome: genome(216.35, 11.75, 7.7, 0.83, 0.97, 97.31, 0.02, 0.38) },
      { count: 29, genome: genome(254.64, 7.28, 7.0, 0.95, 0.11, 22.41, 0.43, 0.31) },
      { count: 13, genome: genome(105.4, 3.55, 5.24, 0.34, 0.18, 23.53, 0.39, 0.24) },
    ] },
    { name: 'Swinger', rows: [
      { count: 48, genome: genome(150.39, 15.89, 23.54, 0.74, 0.45, 62.65, 0.33, 0.13) },
      { count: 152, genome: genome(217.14, 12.13, 12.42, 0.59, 0.98, 14.06, 0.04, 0.65) },
      { count: 14, genome: genome(248.54, 5.85, 22.26, 0.43, 0.11, 17.14, 0.06, 0.68) },
      { count: 31, genome: genome(141.53, 2.91, 4.86, 0.92, 0.03, 21.87, 0.28, 0.2) },
    ] },
    { name: 'Rotary', rows: [
      { count: 29, genome: genome(122.13, 19.19, 17.98, 0.65, 0.44, 19.88, 0.46, 0.2) },
      { count: 51, genome: genome(299.13, 0.79, 38.71, 0.25, 0.18, 86.49, 0.38, 0.43) },
      { count: 10, genome: genome(252.92, 19.99, 10.21, 0.23, 0.17, 1.22, 0.28, 0.92) },
    ] },
    { name: 'Wedding Ring', rows: [
      { count: 24, genome: genome(220.51, 13.88, 3.47, 0.46, 0.38, 6.23, 0.19, 0.68) },
      { count: 13, genome: genome(64.07, 1.4, 19.7, 0.88, 0.27, 0.36, 0.47, 0.72) },
      { count: 35, genome: genome(117.53, 7.31, 21.72, 0.3, 0.5, 98.69, 0.03, 0.29) },
    ] },
    { name: 'Turbulent Runner', rows: [
      { count: 131, genome: genome(177.1, 9.71, 30.06, 0.8, 0.43, 19.65, 0.45, 0.91) },
      { count: 169, genome: genome(277.3, 14.67, 37.71, 0.68, 0.23, 77.01, 0.02, 0.31) },
    ] },
    { name: 'Blobs', rows: [
      { count: 300, genome: genome(20.8, 1.95, 20.75, 0.95, 0.99, 9.31, 0.05, 0.68) },
    ] },
    { name: 'Linear Oscillator', rows: [
      { count: 133, genome: genome(214.41, 17.93, 35.14, 0.64, 0.13, 0.29, 0.08, 0.97) },
      { count: 24, genome: genome(253.6, 7.19, 15.51, 0.82, 0.33, 32.65, 0.34, 0.56) },
    ] },
  ];

  /**
   * 【申し送り】"Blobs" はゲノム行が1本しか無い（原典サイトのレシピそのものが単一ゲノム）。
   * criteria.json の OP4 scale 節は「単一ゲノムのレシピは19本中に無いことを走行前に確認する」と
   * 予測しているが、これは誤りである——A1（登録どおりの系）でも Blobs では OP2・OP3 が
   * ゲノム行1種類のため定義上 NaN になり、OP4 の A(r) も定義できない（無順序ペアが0件）。
   * criteria.json は書き換えず、この事実を raw/notes.md と selftest.js の双方で名指しする。
   */
  var SINGLE_GENOME_RECIPES = RECIPES.filter(function (r) { return r.rows.length < 2; }).map(function (r) { return r.name; });

  // --------------------------------------------------- レシピの変換（不変）
  //
  // ここから先は小さな設定データの変換であり、性能を要さないので副作用を持たない
  // （新しい配列・オブジェクトを都度作る）。シミュレーション本体側の型付き配列は
  // 性能上の理由でその場更新する（本サブプロジェクトの全スケッチに共通の書き方）。

  /** 個体数比を保ったまま合計 targetN へ丸める（最大剰余法）。0個体になった行は落とす。 */
  function rescaleRecipe(recipe, targetN) {
    var total = recipe.rows.reduce(function (s, r) { return s + r.count; }, 0);
    var exact = recipe.rows.map(function (r) { return (r.count / total) * targetN; });
    var floors = exact.map(Math.floor);
    var used = floors.reduce(function (a, b) { return a + b; }, 0);
    var remainder = targetN - used;
    var order = floors.map(function (_, i) { return i; }).sort(function (a, b) {
      var fa = exact[a] - floors[a], fb = exact[b] - floors[b];
      if (fb !== fa) return fb - fa;       // 剰余の大きい順
      return a - b;                        // 同点は行番号の小さいほうへ
    });
    var counts = floors.slice();
    for (var k = 0; k < remainder; k++) counts[order[k]] += 1;

    var rows = [];
    var dropped = [];
    for (var i = 0; i < recipe.rows.length; i++) {
      if (counts[i] > 0) rows.push({ count: counts[i], genome: recipe.rows[i].genome, sourceIndex: i });
      else dropped.push({ sourceIndex: i, originalCount: recipe.rows[i].count, genome: recipe.rows[i].genome });
    }
    return { name: recipe.name, rows: rows, dropped: dropped, originalTotal: total, targetTotal: targetN };
  }

  // --------------------------------------------- 参照点・対照のためのゲノム変換

  function weightedAverage(rows, key) {
    var sum = 0, n = 0;
    rows.forEach(function (r) { sum += r.genome[key] * r.count; n += r.count; });
    return n > 0 ? sum / n : 0;
  }

  /** 参照点1: 知覚半径 R だけを個体数加重平均へ揃える。他7パラメータは行ごとのまま。 */
  function unifyR(rows) {
    var rBar = weightedAverage(rows, 'R');
    return rows.map(function (r) {
      return { count: r.count, sourceIndex: r.sourceIndex, genome: Object.assign({}, r.genome, { R: rBar }) };
    });
  }

  /** 参照点2: 力の強さ c1・c2・c3 だけを個体数加重平均へ揃える。 */
  function unifyForces(rows) {
    var c1 = weightedAverage(rows, 'c1'), c2 = weightedAverage(rows, 'c2'), c3 = weightedAverage(rows, 'c3');
    return rows.map(function (r) {
      return { count: r.count, sourceIndex: r.sourceIndex, genome: Object.assign({}, r.genome, { c1: c1, c2: c2, c3: c3 }) };
    });
  }

  /** 負コントロール1: 近傍への応答を切る（c1=c2=c3=0）。R・Vn・Vm・c4・c5 はそのまま。 */
  function zeroForces(rows) {
    return rows.map(function (r) {
      return { count: r.count, sourceIndex: r.sourceIndex, genome: Object.assign({}, r.genome, { c1: 0, c2: 0, c3: 0 }) };
    });
  }

  /** 負コントロール2: 個体数加重平均ゲノム1種類へ統一する（単一ゲノム）。 */
  function singleGenome(rows) {
    var g = {};
    Object.keys(PARAM_MAX).forEach(function (k) { g[k] = weightedAverage(rows, k); });
    var total = rows.reduce(function (s, r) { return s + r.count; }, 0);
    return [{ count: total, sourceIndex: 0, genome: g }];
  }

  // ------------------------------------------------------------- 世界

  /**
   * 世界を作る。rows は rescaleRecipe（または上の変換）が返す形
   * [{count, genome, sourceIndex}] を渡す。
   * @param {string} placement 'uniform'（場全体に一様）| 'clump'（中心の半径20円内。A8専用）
   */
  function createWorld(rows, opts, seed) {
    var L = (opts && opts.fieldSize) || FIELD_SIZE;
    var placement = (opts && opts.placement) || 'uniform';
    var wallRepulsion = !!(opts && opts.wallRepulsion);

    var n = rows.reduce(function (s, r) { return s + r.count; }, 0);
    var x = new Float64Array(n), y = new Float64Array(n);
    var vx = new Float64Array(n), vy = new Float64Array(n); // 速度 == 積み増された加速度（実装ノート参照）
    var genomeIndex = new Int32Array(n);
    var genomes = rows.map(function (r) { return r.genome; });
    var rowSourceIndex = rows.map(function (r) { return r.sourceIndex; });

    var rngInit = makeRng(deriveSeed(seed, 'init-pos'));
    var idx = 0;
    for (var gi = 0; gi < rows.length; gi++) {
      for (var c = 0; c < rows[gi].count; c++) {
        genomeIndex[idx] = gi;
        if (placement === 'clump') {
          var ang = rngInit() * Math.PI * 2;
          var rad = Math.sqrt(rngInit()) * 20;
          x[idx] = L / 2 + Math.cos(ang) * rad;
          y[idx] = L / 2 + Math.sin(ang) * rad;
        } else {
          x[idx] = rngInit() * L;
          y[idx] = rngInit() * L;
        }
        idx++;
      }
    }

    return {
      L: L, n: n, x: x, y: y, vx: vx, vy: vy, genomeIndex: genomeIndex,
      genomes: genomes, rowSourceIndex: rowSourceIndex, wallRepulsion: wallRepulsion,
      step: 0,
      rngSteer: makeRng(deriveSeed(seed, 'sim-steering')),   // ②c4乱択操舵の判定とベクトル
      rngEmpty: makeRng(deriveSeed(seed, 'sim-empty-accel')), // ③近傍0時のランダム加速度
    };
  }

  /** 折返し（トーラス的な位置の折返し。A1・A4 共通。criteria.json 実装ノート参照）。 */
  function wrapPos(v, L) {
    var r = v % L;
    return r < 0 ? r + L : r;
  }

  /** self.acceleration = self.acceleration + delta のうえで maxVelocity(=Vm^2) でクランプする。 */
  function accelerateClamped(ax, ay, dax, day, maxSpeed) {
    var nax = ax + dax, nay = ay + day;
    var sizeSq = nax * nax + nay * nay;
    var maxVelocity = maxSpeed * maxSpeed;
    if (sizeSq > maxVelocity) {
      var scale = maxSpeed / Math.sqrt(sizeSq);
      nax *= scale; nay *= scale;
    }
    return [nax, nay];
  }

  /** 壁反発（移植 Population.swift。RP4/A4 でのみ使う。criteria.json borrowedConstants）。 */
  function wallRepulsionForce(px, py, L, Vm) {
    var rd = WALL_REPULSE_DIST;
    var dfx = Math.min(px, L - px) / rd;
    var rx = dfx <= 1.0 ? Math.pow(1.0 - dfx, 10.0) * (Vm * Vm) : 0.0;
    var dirx = (px < L - px) ? 1 : -1;
    var dfy = Math.min(py, L - py) / rd;
    var ry = dfy <= 1.0 ? Math.pow(1.0 - dfy, 10.0) * (Vm * Vm) : 0.0;
    var diry = (py < L - py) ? 1 : -1;
    return [rx * dirx, ry * diry];
  }

  /**
   * 1ステップ進める。**同時更新（Jacobi 型）**にしてある——移植の Swift 実装は population.forEach の
   * 中で個体を逐次ミューテートするため、後続の個体は同一フレーム内で既に動いた個体を見てしまう
   * （逐次更新・Gauss-Seidel 型）。本再実装は S-02/S-13 と同じ「新しい配列へ計算してから一括で適用」
   * という書き方をとり、走査順に依存しない決定的な力学にしてある（この違いは raw/notes.md へ記録）。
   */
  function stepWorld(w) {
    var n = w.n, L = w.L;
    var newVx = new Float64Array(n), newVy = new Float64Array(n);
    var newX = new Float64Array(n), newY = new Float64Array(n);

    for (var i = 0; i < n; i++) {
      var g = w.genomes[w.genomeIndex[i]];
      var xi = w.x[i], yi = w.y[i];
      var r2 = g.R * g.R;

      // 近傍を総当たりで探す（N<=200 なので格子は要らない。相互作用は境界をまたがない——
      // すなわちトーラス折返し前の素のユークリッド距離。sourceFidelity 参照）。
      var neighbors = [];
      for (var j = 0; j < n; j++) {
        if (j === i) continue;
        var dx = w.x[j] - xi, dy = w.y[j] - yi;
        var d2 = dx * dx + dy * dy;
        if (d2 < r2) neighbors.push(j);
      }

      var force;
      if (neighbors.length === 0) {
        force = [w.rngEmpty() - 0.5, w.rngEmpty() - 0.5];
      } else {
        var cx = 0, cy = 0, vSumX = 0, vSumY = 0, sepX = 0, sepY = 0;
        for (var k = 0; k < neighbors.length; k++) {
          var jn = neighbors[k];
          cx += w.x[jn]; cy += w.y[jn];
          vSumX += w.vx[jn]; vSumY += w.vy[jn];
          var ddx = xi - w.x[jn], ddy = yi - w.y[jn];
          var dist2 = ddx * ddx + ddy * ddy;
          var denom = Math.max(dist2, SEPARATION_MIN_D2);
          sepX += (ddx / denom) * g.c3;
          sepY += (ddy / denom) * g.c3;
        }
        var cnt = neighbors.length;
        var avgCx = cx / cnt, avgCy = cy / cnt;
        var avgVx = vSumX / cnt, avgVy = vSumY / cnt;

        var steerX = 0, steerY = 0;
        if (w.rngSteer() < g.c4) {
          steerX = Math.floor(w.rngSteer() * 10) - 4.5;
          steerY = Math.floor(w.rngSteer() * 10) - 4.5;
        }

        force = [
          (avgCx - xi) * g.c1 + (avgVx - w.vx[i]) * g.c2 + sepX + steerX,
          (avgCy - yi) * g.c1 + (avgVy - w.vy[i]) * g.c2 + sepY + steerY,
        ];
      }

      if (w.wallRepulsion) {
        var wf = wallRepulsionForce(xi, yi, L, g.Vm);
        force[0] += wf[0]; force[1] += wf[1];
      }

      // 1回目のaccelerate: 力を積み増してVmでクランプ
      var v1 = accelerateClamped(w.vx[i], w.vy[i], force[0], force[1], g.Vm);
      var mag = Math.max(Math.hypot(v1[0], v1[1]), 0.001);
      var factor = ((g.Vn - mag) / mag) * g.c5;
      // 2回目のaccelerate: c5のペースキープ補正を加算してクランプ（Swift実装と同じく2回に分ける）
      var v2 = accelerateClamped(v1[0], v1[1], v1[0] * factor, v1[1] * factor, g.Vm);

      newVx[i] = v2[0]; newVy[i] = v2[1];
      newX[i] = wrapPos(xi + v2[0], L);
      newY[i] = wrapPos(yi + v2[1], L);
    }

    w.x = newX; w.y = newY; w.vx = newVx; w.vy = newVy;
    w.step++;
  }

  function runSteps(w, count) {
    for (var t = 0; t < count; t++) stepWorld(w);
  }

  /** K-36: 決定的な系なら状態ハッシュを1欄入れる。腕どうしの「差が無い」と「同一」を後で区別できる。 */
  function stateHash(w) {
    var s = 0;
    for (var i = 0; i < w.n; i++) {
      var vx = Math.round(w.x[i] * 1000), vy = Math.round(w.y[i] * 1000);
      var vvx = Math.round(w.vx[i] * 1000), vvy = Math.round(w.vy[i] * 1000);
      s = (Math.imul(s, 16777619) ^ vx) >>> 0;
      s = (Math.imul(s, 16777619) ^ vy) >>> 0;
      s = (Math.imul(s, 16777619) ^ vvx) >>> 0;
      s = (Math.imul(s, 16777619) ^ vvy) >>> 0;
    }
    return s.toString(16);
  }

  return {
    PARAM_MAX: PARAM_MAX, FIELD_SIZE: FIELD_SIZE, RECIPES: RECIPES, SINGLE_GENOME_RECIPES: SINGLE_GENOME_RECIPES,
    makeRng: makeRng, deriveSeed: deriveSeed, genome: genome,
    rescaleRecipe: rescaleRecipe, weightedAverage: weightedAverage,
    unifyR: unifyR, unifyForces: unifyForces, zeroForces: zeroForces, singleGenome: singleGenome,
    createWorld: createWorld, stepWorld: stepWorld, runSteps: runSteps,
    wrapPos: wrapPos, accelerateClamped: accelerateClamped, wallRepulsionForce: wallRepulsionForce,
    stateHash: stateHash,
  };
});
