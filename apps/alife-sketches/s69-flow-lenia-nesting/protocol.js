/**
 * S-69: 10 の腕の定義・規則の抽出・初期状態の組み立て・計算予算の梯子。
 * criteria.json の protocol / system / computeBudget と1対1で対応させる（数値を変えない）。
 * Node 専用ではない——viewer.html からも読める UMD（本番と同じ経路で spec を組む。K-139）。
 */
(function (global) {
  'use strict';
  var S69 = (typeof module !== 'undefined' && module.exports) ? require('./core.js') : global.S69;
  var Engine = (typeof module !== 'undefined' && module.exports) ? require('./engine.js') : global.S69Engine;

  var N = 128, CELLS = N * N;
  var MAIN_CONN_SINGLE10 = Engine.buildConnectivity([[10]]);
  var MAIN_CONN_SINGLE20 = Engine.buildConnectivity([[20]]);
  var MAIN_CONN_MULTI = Engine.buildConnectivity([[3, 2], [2, 3]]);
  var FOOD_CONN = [[2, 0], [2, 1]]; // c0=2 は食物場 Ψ（フィールド索引 = C）。c1 は物質チャネル 0・1 を更新
  var N_SPECIES = 8;

  var SEEDS_SINGLE_M1 = range(6901, 6964);   // M-rand 64
  var SEEDS_SINGLE_M2 = range(6965, 6988);   // M-rand2 24
  var SEEDS_MULTI = range(6991, 7000);       // 多種 10（腕ごとに部分集合を使う）
  var SEEDS_CALIB = range(7090, 7099);       // 正コントロール・較正

  function range(a, b) { var out = []; for (var i = a; i <= b; i++) out.push(i); return out; }

  function defaultConfig() {
    return {
      mRandCount: 64, mRand2Count: 24,
      multiStepsMain: 3000, singleStepsMain: 1500,
      mMixCount: 10, mFieldCount: 6, rTerrCount: 6, mFoodCount: 6, ncNeutralCount: 4, ncAvgCount: 4,
      iaaftCount: 19, iaaftIterations: 30, iaaftPValue: 0.05,
    };
  }

  /** computeBudget.ladder（criteria.json のまま。順に適用し、結果を見て選ばない。K-147）。 */
  var LADDER = [
    { desc: '段1: M-rand 64→48・M-rand2 24→16', apply: function (c) { return Object.assign({}, c, { mRandCount: 48, mRand2Count: 16 }); } },
    { desc: '段2: 多種の歩数 3000→2000', apply: function (c) { return Object.assign({}, c, { multiStepsMain: 2000 }); } },
    { desc: '段3: M-field・R-terr・M-food 6→4', apply: function (c) { return Object.assign({}, c, { mFieldCount: 4, rTerrCount: 4, mFoodCount: 4 }); } },
    { desc: '段4: 単一種の歩数 1500→1000', apply: function (c) { return Object.assign({}, c, { singleStepsMain: 1000 }); } },
    { desc: '段5: M-mix 10→6・NC-neutral/NC-avg 4→3', apply: function (c) { return Object.assign({}, c, { mMixCount: 6, ncNeutralCount: 3, ncAvgCount: 3 }); } },
    { desc: '段6: IAAFT 19→9（片側p=0.1に緩む）・M-rand2 16→8', apply: function (c) { return Object.assign({}, c, { iaaftCount: 9, iaaftPValue: 0.1, mRand2Count: 8 }); } },
  ];

  function applyLadder(baseConfig, level) {
    var config = baseConfig, used = [];
    for (var i = 0; i < level && i < LADDER.length; i++) { config = LADDER[i].apply(config); used.push(LADDER[i].desc); }
    return { config: config, used: used };
  }

  /* ---------------------------------------------------------- 初期状態の組み立て */

  /** 単一種の族: 中央 40×40 の区画に一様乱数 [0,1]、他は 0。 */
  function initSinglePatch(state, initRng, C) {
    var cx = Math.floor(N / 2), cy = Math.floor(N / 2), half = 20;
    for (var dy = -half; dy < half; dy++) {
      for (var dx = -half; dx < half; dx++) {
        var xi = ((cx + dx) % N + N) % N, yi = ((cy + dy) % N + N) % N, idx = yi * N + xi;
        for (var c = 0; c < C; c++) state.A[c][idx] = initRng();
      }
    }
  }

  /** 多種の族の区画位置: 20×20 の区画 8 個、中心どうしの距離が 30 以上になるよう一様に置く（自前）。 */
  function drawPatchPositions(initRng, count, minDist) {
    var patches = [], tries = 0, maxTries = 200000;
    while (patches.length < count && tries < maxTries) {
      tries++;
      var x = Math.floor(initRng() * N), y = Math.floor(initRng() * N);
      var ok = true;
      for (var i = 0; i < patches.length; i++) {
        var dx = Math.abs(x - patches[i].x); dx = Math.min(dx, N - dx);
        var dy = Math.abs(y - patches[i].y); dy = Math.min(dy, N - dy);
        if (Math.sqrt(dx * dx + dy * dy) < minDist) { ok = false; break; }
      }
      if (ok) patches.push({ x: x, y: y });
    }
    return { patches: patches, tries: tries, satisfied: patches.length === count };
  }

  /** 多種の族の物質: 区画ごとに 20×20・一様乱数 [0,1]。initRng は drawPatchPositions と同じ源で続けて引く。 */
  function initMultiPatches(state, patches, initRng, C) {
    var cellIdx = [];
    for (var pi = 0; pi < patches.length; pi++) {
      var p = patches[pi];
      for (var dy = 0; dy < 20; dy++) {
        for (var dx = 0; dx < 20; dx++) {
          var xi = ((p.x + dx) % N + N) % N, yi = ((p.y + dy) % N + N) % N, idx = yi * N + xi;
          for (var c = 0; c < C; c++) state.A[c][idx] = initRng();
          cellIdx.push({ idx: idx, patch: pi });
        }
      }
    }
    return cellIdx;
  }

  /** M-field: 区画を置かず格子全体に薄い場。ρ̄ = 3200*0.5/16384（区画8個と同じ期待質量）、[0, 2ρ̄]。 */
  function initField(state, initRng, C) {
    var rhoBar = (3200 * 0.5) / CELLS;
    for (var i = 0; i < CELLS; i++) { for (var c = 0; c < C; c++) state.A[c][i] = initRng() * 2 * rhoBar; }
  }

  /** 種の割り当てを P・label へ書く。perCellPatch が与えられれば区画ごと（R-terr）、無ければセルごと（既定）。 */
  function assignSpecies(state, ruleSpec, assignRng, cellList, perPatch) {
    var pDim = state.pDim;
    if (perPatch) {
      var patchCount = 0;
      cellList.forEach(function (c) { if (c.patch + 1 > patchCount) patchCount = c.patch + 1; });
      var speciesOfPatch = [];
      for (var pi = 0; pi < patchCount; pi++) speciesOfPatch.push(Math.floor(assignRng() * N_SPECIES));
      cellList.forEach(function (c) {
        var sp = speciesOfPatch[c.patch];
        state.label[c.idx] = sp;
        for (var d = 0; d < pDim; d++) state.P[c.idx * pDim + d] = ruleSpec.speciesH[sp][d];
      });
      return { speciesOfPatch: speciesOfPatch };
    }
    var list = cellList || allCells();
    list.forEach(function (c) {
      var idx = c.idx !== undefined ? c.idx : c;
      var sp = Math.floor(assignRng() * N_SPECIES);
      state.label[idx] = sp;
      for (var d = 0; d < pDim; d++) state.P[idx * pDim + d] = ruleSpec.speciesH[sp][d];
    });
    return {};
  }
  function allCells() { var out = new Array(CELLS); for (var i = 0; i < CELLS; i++) out[i] = i; return out; }

  /* ---------------------------------------------------------- 腕ごとの spec 組み立て */

  var FAMILY = {
    single: { conn: MAIN_CONN_SINGLE10, multiSpecies: false, C: 1, kCount: 10 },
    single2: { conn: MAIN_CONN_SINGLE20, multiSpecies: false, C: 2, kCount: 20 },
    multi: { conn: MAIN_CONN_MULTI, multiSpecies: true, C: 2, kCount: 10 },
  };

  /** 1本の走行の spec（データだけ。Worker へ渡す）。core/engine/protocol を呼べば同じ状態が復元できる。 */
  function buildSpec(arm, seed, T, extra) {
    return Object.assign({ id: arm + '_' + seed, arm: arm, seed: seed, T: T }, extra || {});
  }

  /** spec から state・ruleSpec・観測に要る補助情報を実際に組み立てる（本番と selftest の共通経路）。 */
  function realize(spec) {
    var arm = spec.arm, seed = spec.seed;
    var ruleRng = S69.subRng(seed, 'rule');
    var initRng = S69.subRng(seed, 'init');
    var assignRng = S69.subRng(seed, 'assign');
    var dynRng = S69.subRng(seed, 'dyn');
    var out = { dynRng: dynRng, patches: null, cellList: null };

    if (arm === 'M-rand' || arm === 'NC-nodrive') {
      var rule1 = Engine.sampleRule(ruleRng, FAMILY.single.conn, false, 0, []);
      var st1 = Engine.createState({ C: 1, hasFood: false, multiSpecies: false, driveOff: arm === 'NC-nodrive', dye: !!spec.dye });
      Engine.attachRule(st1, rule1);
      initSinglePatch(st1, initRng, 1);
      out.state = st1; out.rule = rule1; return out;
    }
    if (arm === 'M-rand2') {
      var rule2 = Engine.sampleRule(ruleRng, FAMILY.single2.conn, false, 0, []);
      var st2 = Engine.createState({ C: 2, hasFood: false, multiSpecies: false, driveOff: false, dye: !!spec.dye });
      Engine.attachRule(st2, rule2);
      initSinglePatch(st2, initRng, 2);
      out.state = st2; out.rule = rule2; return out;
    }

    // 多種の族: M-mix / M-field / R-terr / M-food / NC-neutral / NC-avg
    var foodConn = arm === 'M-food' ? FOOD_CONN : [];
    var pDim = 10 + (arm === 'M-food' ? 2 : 0);
    var ruleM = Engine.sampleRule(ruleRng, FAMILY.multi.conn, true, N_SPECIES, foodConn);
    if (arm === 'NC-neutral') { var h0 = ruleM.speciesH[0]; for (var s = 1; s < N_SPECIES; s++) ruleM.speciesH[s] = h0.slice(); }

    var st = Engine.createState({ C: 2, hasFood: arm === 'M-food', multiSpecies: true, pDim: pDim, mixMode: arm === 'NC-avg' ? 'average' : 'softmax', driveOff: false, dye: !!spec.dye });
    Engine.attachRule(st, ruleM);

    if (arm === 'M-field') {
      initField(st, initRng, 2);
      out.cellList = null;
      assignSpecies(st, ruleM, assignRng, null, false);
    } else {
      var pos = drawPatchPositions(initRng, 8, 30);
      out.patches = pos.patches; out.patchDrawOk = pos.satisfied;
      var cellList = initMultiPatches(st, pos.patches, initRng, 2);
      out.cellList = cellList;
      assignSpecies(st, ruleM, assignRng, cellList, arm === 'R-terr');
    }
    if (arm === 'M-food') {
      var foodRng = S69.subRng(seed, 'food');
      out.dynRng = dynRng; out.foodRng = foodRng;
      var squares = 32;
      for (var q = 0; q < squares; q++) {
        var cx = Math.floor(foodRng() * N), cy = Math.floor(foodRng() * N);
        for (var yy = 0; yy < 5; yy++) for (var xx = 0; xx < 5; xx++) {
          var xi = (cx + xx) % N, yi = (cy + yy) % N;
          st.Psi[yi * N + xi] += 1;
        }
      }
      ruleM.foodParams = { rhoDecay: 0.0014, rhoDigest: 0.1, pFood: 0.2 };
    }
    out.state = st; out.rule = ruleM;
    return out;
  }

  /** 1つの seed からの1歩を、指定した乱数（softmax・食物の再生）で進める。dyn 乱数は M-food で foodRng を優先する。 */
  function stepSpec(realized) {
    var rng = realized.foodRng || realized.dynRng;
    return Engine.stepOnce(realized.state, rng);
  }

  /* ---------------------------------------------------------- 腕の行（run.js が使う） */

  /** 各腕の最初の seed にだけ snapshotTimes を付ける（rawLogPlan の snapshots/: t=0・500・1500・終わり）。 */
  function withSnapshot(spec, isFirst, T) {
    if (!isFirst) return spec;
    var times = [0, 500, 1500, T].filter(function (t, i, arr) { return t <= T && arr.indexOf(t) === i; });
    return Object.assign({}, spec, { snapshotTimes: times });
  }

  function buildArmRows(config) {
    var rows = [];
    var extra = { kind: 'arm', iaaftCount: config.iaaftCount, iaaftIterations: config.iaaftIterations };
    function pushAll(arm, seeds, T) {
      seeds.forEach(function (seed, i) { rows.push(withSnapshot(buildSpec(arm, seed, T, extra), i === 0, T)); });
    }
    pushAll('M-rand', SEEDS_SINGLE_M1.slice(0, config.mRandCount), config.singleStepsMain);
    pushAll('M-rand2', SEEDS_SINGLE_M2.slice(0, config.mRand2Count), config.singleStepsMain);
    pushAll('NC-nodrive', range(6901, 6908), config.singleStepsMain);
    pushAll('M-mix', SEEDS_MULTI.slice(0, config.mMixCount), config.multiStepsMain);
    pushAll('M-field', SEEDS_MULTI.slice(0, config.mFieldCount), config.multiStepsMain);
    pushAll('R-terr', SEEDS_MULTI.slice(0, config.rTerrCount), config.multiStepsMain);
    pushAll('M-food', SEEDS_MULTI.slice(0, config.mFoodCount), config.multiStepsMain);
    pushAll('NC-neutral', SEEDS_MULTI.slice(0, config.ncNeutralCount), config.multiStepsMain);
    pushAll('NC-avg', SEEDS_MULTI.slice(0, config.ncAvgCount), config.multiStepsMain);
    return rows;
  }

  var Protocol = {
    N: N, CELLS: CELLS, N_SPECIES: N_SPECIES,
    FAMILY: FAMILY, MAIN_CONN_MULTI: MAIN_CONN_MULTI, FOOD_CONN: FOOD_CONN,
    SEEDS_SINGLE_M1: SEEDS_SINGLE_M1, SEEDS_SINGLE_M2: SEEDS_SINGLE_M2, SEEDS_MULTI: SEEDS_MULTI, SEEDS_CALIB: SEEDS_CALIB,
    defaultConfig: defaultConfig, LADDER: LADDER, applyLadder: applyLadder,
    initSinglePatch: initSinglePatch, drawPatchPositions: drawPatchPositions, initMultiPatches: initMultiPatches, initField: initField,
    assignSpecies: assignSpecies, buildSpec: buildSpec, realize: realize, stepSpec: stepSpec, buildArmRows: buildArmRows,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Protocol;
  if (typeof window !== 'undefined') window.S69Protocol = Protocol;
})(this);
