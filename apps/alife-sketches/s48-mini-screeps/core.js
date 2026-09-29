/**
 * S-48 核 — 簡易 Screeps エンジン。単一の部屋・単一ティックの解決規則だけを知る。
 *
 * **戦略の語彙を持たない。** 「rush」「turtle」「aggression」「buildPriority」といった bot の
 * 意思決定語彙は使わない（bots.js 側）。ここにあるのは creep / structure / source / room という
 * screeps 自身の一次語彙だけであり、これは「借用した上位概念」ではなく本題材そのものである
 * （s47 の core.js が lattice/winding を核に置くのと同じ扱い）。
 *
 * ミューテーションを避けた記述を優先する: 1ティックの解決は `stepTick(ctx, ordersA, ordersB)` が
 * **新しい state を返す**（creep・structure は差分を spread で作り直す）。ただし乱数発生器と
 * 経路キャッシュ（pathCache）は性能上の理由で内部状態を持つ古典的な PRNG/キャッシュの慣習に従う
 * （s47 の `rng()` と同じ例外）。
 *
 * 依存ゼロ・古典スクリプト。Node と ブラウザで共用。
 */
(function (global) {
  'use strict';
  var C = (typeof require !== 'undefined') ? require('./constants.js') : global.S48C;

  // ================================================================== 乱数・ハッシュ
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
  function fnvHash(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }
  /** 全ティックログのハッシュ（K-47 対策）。creep・structure・source を id 昇順で正規化して文字列化する。 */
  function stateHash(state) {
    var parts = [];
    parts.push('t' + state.tick);
    parts.push('pA' + state.players.A.energy + ',' + state.players.A.rcl + ',' + state.players.A.controllerProgress);
    parts.push('pB' + state.players.B.energy + ',' + state.players.B.rcl + ',' + state.players.B.controllerProgress);
    state.creeps.slice().sort(cmpId).forEach(function (c) {
      parts.push('c' + c.id + ':' + c.pos.x + ',' + c.pos.y + ',' + c.hp + ',' + c.carry + ',' + c.fatigue + ',' + (c.spawning ? 1 : 0));
    });
    allStructures(state).sort(cmpId).forEach(function (s) {
      parts.push('s' + s.id + ':' + s.hp + ',' + (s.progress || 0) + ',' + (s.active ? 1 : 0));
    });
    state.sources.forEach(function (s) { parts.push('e' + s.id + ':' + s.energy); });
    return fnvHash(parts.join('|'));
  }
  function cmpId(a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; }

  // ================================================================== 地形・配置（180度回転対称）
  function inBounds(x, y) { return x >= 0 && x < C.SIZE && y >= 0 && y < C.SIZE; }
  function idx(x, y) { return y * C.SIZE + x; }
  function mirror(p) { return { x: C.SIZE - 1 - p.x, y: C.SIZE - 1 - p.y }; }
  function dist(a, b) { return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)); } // Chebyshev（8方向移動と整合）

  function stampRect(terrain, x0, y0, w, h, val) {
    for (var y = y0; y < y0 + h; y++) for (var x = x0; x < x0 + w; x++) {
      if (inBounds(x, y)) terrain[idx(x, y)] = val;
    }
  }

  function bfsReachable(terrain, from) {
    var n = C.SIZE * C.SIZE, seen = new Uint8Array(n), q = [idx(from.x, from.y)], qi = 0;
    seen[q[0]] = 1;
    while (qi < q.length) {
      var i = q[qi++], x = i % C.SIZE, y = (i / C.SIZE) | 0;
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        var nx = x + dx, ny = y + dy;
        if (!inBounds(nx, ny)) continue;
        var ni = idx(nx, ny);
        if (seen[ni] || terrain[ni] === 1) continue;
        seen[ni] = 1; q.push(ni);
      }
    }
    return seen;
  }

  /**
   * 地図を生成する。180度回転対称（system.symmetry）。シードは (a) 壁地形の配置と
   * (b) energySource・spawn の座標を動かす（whatSeedChanges）。到達性を検査し、
   * 満たさない生成は破棄して作り直す（最大20回。それでも失敗すれば壁ブロックなしで確定する）。
   */
  function generateMap(seed) {
    var rand = rng(seed);
    for (var attempt = 0; attempt < 20; attempt++) {
      var terrain = new Uint8Array(C.SIZE * C.SIZE);
      stampRect(terrain, 0, 0, C.SIZE, 1, 1); stampRect(terrain, 0, C.SIZE - 1, C.SIZE, 1, 1);
      stampRect(terrain, 0, 0, 1, C.SIZE, 1); stampRect(terrain, C.SIZE - 1, 0, 1, C.SIZE, 1);

      var nBlocks = 4 + Math.floor(rand() * 4);
      for (var b = 0; b < nBlocks; b++) {
        var bx = 15 + Math.floor(rand() * 12), by = 15 + Math.floor(rand() * 12);
        var w = 2 + Math.floor(rand() * 3), h = 2 + Math.floor(rand() * 3);
        stampRect(terrain, bx, by, w, h, 1);
        var m = mirror({ x: bx + w - 1, y: by + h - 1 });
        stampRect(terrain, m.x, m.y, w, h, 1);
      }

      var spawnA = { x: 7 + Math.floor(rand() * 6), y: 7 + Math.floor(rand() * 6) };
      var controllerA = { x: spawnA.x + 4 + Math.floor(rand() * 3), y: spawnA.y + 4 + Math.floor(rand() * 3) };
      var sourceA1 = { x: 4 + Math.floor(rand() * 8), y: 24 + Math.floor(rand() * 18) };
      var sourceA2 = { x: 24 + Math.floor(rand() * 18), y: 4 + Math.floor(rand() * 8) };
      var special = [spawnA, controllerA, sourceA1, sourceA2];
      var ok = special.every(function (p) { return inBounds(p.x, p.y); });
      if (!ok) continue;
      special.concat(special.map(mirror)).forEach(function (p) { terrain[idx(p.x, p.y)] = 0; });

      var reach = bfsReachable(terrain, spawnA);
      var allReachable = [controllerA, sourceA1, sourceA2, mirror(spawnA)].every(function (p) { return reach[idx(p.x, p.y)] === 1; });
      var openFrac = reach.reduce(function (a, v) { return a + v; }, 0) / (C.SIZE * C.SIZE);
      if (allReachable && openFrac > 0.5) {
        return {
          terrain: terrain,
          spawnA: spawnA, spawnB: mirror(spawnA),
          controllerA: controllerA, controllerB: mirror(controllerA),
          sourcesA: [sourceA1, sourceA2], sourcesB: [mirror(sourceA1), mirror(sourceA2)],
          rand: rand,
        };
      }
    }
    throw new Error('generateMap: 到達可能な配置を20回試行しても作れなかった');
  }

  // ================================================================== body
  function zeroPartSpend() { return { WORK: 0, CARRY: 0, MOVE: 0, ATTACK: 0, RANGED_ATTACK: 0, HEAL: 0, TOUGH: 0 }; }
  function bodyCost(body) { return body.reduce(function (s, p) { return s + C.PART_COST[p]; }, 0); }
  function bodyHp(body) { return body.length * C.HITS_PER_PART; }
  function partCount(body, part) { return body.reduce(function (s, p) { return s + (p === part ? 1 : 0); }, 0); }
  function carryCapacity(body) { return partCount(body, 'CARRY') * C.CARRY_CAPACITY; }
  /** 移動の重み（MOVE以外の部品。CARRYはエネルギーを運んでいるときだけ数える。system簡略化。README参照）。 */
  function fatigueWeight(creep) {
    var w = 0;
    creep.body.forEach(function (p) {
      if (p === 'MOVE') return;
      if (p === 'CARRY' && creep.carry <= 0) return;
      w += 1;
    });
    return w * 2;
  }

  // ================================================================== 経路キャッシュ（A5: 10ティックごとのBFS距離場近似）
  function makePathCache(interval) { return { interval: interval, lastRefresh: -Infinity, fields: {} }; }
  function blockedMask(state) {
    var n = C.SIZE * C.SIZE, m = new Uint8Array(state.terrain);
    allStructures(state).forEach(function (s) { m[idx(s.pos.x, s.pos.y)] = 1; });
    state.sources.forEach(function (s) { m[idx(s.pos.x, s.pos.y)] = 1; });
    return m;
  }
  function buildDistanceField(mask, target) {
    var n = C.SIZE * C.SIZE, field = new Int32Array(n).fill(-1);
    var ti = idx(target.x, target.y);
    field[ti] = 0;
    var q = [ti], qi = 0;
    while (qi < q.length) {
      var i = q[qi++], x = i % C.SIZE, y = (i / C.SIZE) | 0, d = field[i];
      for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        var nx = x + dx, ny = y + dy;
        if (!inBounds(nx, ny)) continue;
        var ni = idx(nx, ny);
        if (field[ni] !== -1 || mask[ni] === 1) continue;
        field[ni] = d + 1; q.push(ni);
      }
    }
    return field;
  }
  /** target ごとの距離場を返す。interval ティックごとに全キャッシュを破棄する（criteria A5）。 */
  function getDistanceField(state, cache, target) {
    if (state.tick - cache.lastRefresh >= cache.interval) { cache.fields = {}; cache.lastRefresh = state.tick; cache.mask = blockedMask(state); }
    var key = target.x + ',' + target.y;
    if (!cache.fields[key]) cache.fields[key] = buildDistanceField(cache.mask, target);
    return cache.fields[key];
  }
  /** 総当たり（キャッシュ無し・毎ティック再計算）版。近道の検算（selftest）専用。 */
  function distanceFieldNaive(state, target) { return buildDistanceField(blockedMask(state), target); }

  // ================================================================== structure 一覧
  function allStructures(state) {
    return [].concat(state.structures.spawns, state.structures.extensions, state.structures.towers,
      state.structures.walls, state.structures.controllers);
  }
  function structureAt(state, x, y) {
    return allStructures(state).filter(function (s) { return s.pos.x === x && s.pos.y === y; })[0] || null;
  }
  function findById(state, id) {
    if (!id) return null;
    var c = state.creeps.filter(function (c2) { return c2.id === id; })[0];
    if (c) return c;
    return allStructures(state).concat(state.sources).filter(function (s) { return s.id === id; })[0] || null;
  }

  // ================================================================== 建設スロット位置（螺旋探索）
  function spiralOffsets(maxR) {
    var out = [];
    for (var r = 1; r <= maxR; r++) {
      for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        out.push([dx, dy]);
      }
    }
    return out;
  }
  var SPIRAL = spiralOffsets(12);
  function nextFreeSlot(state, center, used) {
    for (var i = 0; i < SPIRAL.length; i++) {
      var x = center.x + SPIRAL[i][0], y = center.y + SPIRAL[i][1];
      if (!inBounds(x, y)) continue;
      var key = x + ',' + y;
      if (used[key]) continue;
      if (state.terrain[idx(x, y)] === 1) continue;
      if (structureAt(state, x, y)) continue;
      if (state.sources.some(function (s) { return s.pos.x === x && s.pos.y === y; })) continue;
      used[key] = true;
      return { x: x, y: y };
    }
    return null;
  }

  // ================================================================== 生成
  function createMatch(seed, opts) {
    opts = opts || {};
    var map = generateMap(seed);
    var mkController = function (owner, pos) {
      return { id: 'controller-' + owner, owner: owner, pos: pos, progress: 0, rcl: 1, hp: Infinity, maxHp: Infinity };
    };
    var mkSpawn = function (owner, pos) {
      return { id: 'spawn-' + owner, owner: owner, pos: pos, hp: C.SPAWN_MAX_HP, maxHp: C.SPAWN_MAX_HP, active: true, progress: C.SPAWN_MAX_HP };
    };
    var state = {
      tick: 0,
      terrain: map.terrain,
      players: {
        A: { energy: C.SPAWN_ENERGY_CAPACITY, rcl: 1, controllerProgress: 0, capacity: C.SPAWN_ENERGY_CAPACITY, spawning: null, spawnDenied: 0, harvested: 0, builtCost: 0, partSpend: zeroPartSpend() },
        B: { energy: C.SPAWN_ENERGY_CAPACITY, rcl: 1, controllerProgress: 0, capacity: C.SPAWN_ENERGY_CAPACITY, spawning: null, spawnDenied: 0, harvested: 0, builtCost: 0, partSpend: zeroPartSpend() },
      },
      creeps: [],
      structures: {
        spawns: [mkSpawn('A', map.spawnA), mkSpawn('B', map.spawnB)],
        extensions: [], towers: [], walls: [],
        controllers: [mkController('A', map.controllerA), mkController('B', map.controllerB)],
      },
      sources: [
        { id: 'source-0', pos: map.sourcesA[0], energy: C.SOURCE_CAPACITY, nextRegen: C.SOURCE_REGEN_TIME },
        { id: 'source-1', pos: map.sourcesA[1], energy: C.SOURCE_CAPACITY, nextRegen: C.SOURCE_REGEN_TIME },
        { id: 'source-2', pos: map.sourcesB[0], energy: C.SOURCE_CAPACITY, nextRegen: C.SOURCE_REGEN_TIME },
        { id: 'source-3', pos: map.sourcesB[1], energy: C.SOURCE_CAPACITY, nextRegen: C.SOURCE_REGEN_TIME },
      ],
      // initial: 両spawnの初期エネルギー（本家どおり）。harvest由来ではないので保存則の左辺に別枠で足す
      ledger: { harvested: 0, invested: 0, built: 0, bodySpend: 0, towerSpend: 0, ground: 0, regenerated: 0, initial: C.SPAWN_ENERGY_CAPACITY * 2 },
      log: [],
      // 所有権に反して捨てられた命令（ownership.js）。本家の ERR_NOT_OWNER に対応する記録であり、
      // **stateHash には入れない**——入れると既存の生ログ（S3 の 1,350 試合）が再現しなくなる
      rejectedOrders: [],
      slotsUsed: { A: {}, B: {} },
      nextCreepSeq: 0,
      nextStructSeq: 0,
      cumHarvestBoth: 0,
      invaderWavesSpawned: 0,
      gameOver: null,
      combatDisabled: !!opts.combatDisabled,   // negativeControls[1]（戦闘無効）
      invadersDisabled: !!opts.invadersDisabled,
      blindPlayers: opts.blindPlayers || null, // negativeControls[2]（相手が見えないbot）。observer/bots が参照する印
    };
    return state;
  }

  // ================================================================== 1ティックの解決フェーズ（フェーズ1〜6・invader・stepTick・createCtx）
  // core.js が800行を超えたため tick.js へ分離した（同じ「核」の一部。README参照）。
  // require('./tick.js') が Object.assign で下の api へ合流させる（このファイル末尾）。

  // ================================================================== 検算用ユーティリティ
  function energyLedgerCheck(state) {
    var carried = state.creeps.reduce(function (s, c) { return s + c.carry; }, 0);
    var pooled = state.players.A.energy + state.players.B.energy;
    var l = state.ledger;
    var rhs = carried + pooled + l.invested + l.built + l.bodySpend + l.towerSpend + l.ground;
    // regenerated: spawn の自動再生で無から湧いた分（本家の仕様。tick.js の phaseRegen）。
    // 湧く以上、左辺（供給）に数えないと検算が必ず落ちる
    var lhs = l.harvested + l.initial + l.regenerated;
    return { harvested: l.harvested, initial: l.initial, regenerated: l.regenerated, lhs: lhs, rhs: rhs, ok: Math.abs(lhs - rhs) < 1e-6 };
  }
  function occupancyIndexNaive(state) {
    var m = {};
    state.creeps.forEach(function (c) { m[c.pos.x + ',' + c.pos.y] = (m[c.pos.x + ',' + c.pos.y] || 0) + 1; });
    return m;
  }
  /** 鏡像対称の恒等式（positiveControls[2]）。A の各creep/structureに、Bの鏡映位置に対応物があるか。 */
  function mirrorSymmetryCheck(state) {
    var problems = [];
    function pairUp(listA, listB, label) {
      if (listA.length !== listB.length) { problems.push(label + ': 数が非対称 ' + listA.length + ' vs ' + listB.length); return; }
      listA.forEach(function (a) {
        var mp = mirror(a.pos);
        var match = listB.filter(function (b) { return b.pos.x === mp.x && b.pos.y === mp.y; })[0];
        if (!match) { problems.push(label + ' ' + a.id + ' @' + a.pos.x + ',' + a.pos.y + ': 鏡映位置に対応物なし'); return; }
        if (a.hp !== match.hp) problems.push(label + ' ' + a.id + ': hp非対称 ' + a.hp + ' vs ' + match.hp);
        if ((a.carry || 0) !== (match.carry || 0)) problems.push(label + ' ' + a.id + ': carry非対称');
      });
    }
    pairUp(state.creeps.filter(function (c) { return c.owner === 'A'; }), state.creeps.filter(function (c) { return c.owner === 'B'; }), 'creep');
    pairUp(state.structures.extensions.filter(function (s) { return s.owner === 'A'; }), state.structures.extensions.filter(function (s) { return s.owner === 'B'; }), 'extension');
    pairUp(state.structures.towers.filter(function (s) { return s.owner === 'A'; }), state.structures.towers.filter(function (s) { return s.owner === 'B'; }), 'tower');
    pairUp(state.structures.walls.filter(function (s) { return s.owner === 'A'; }), state.structures.walls.filter(function (s) { return s.owner === 'B'; }), 'wall');
    if (state.players.A.rcl !== state.players.B.rcl) problems.push('RCL非対称 ' + state.players.A.rcl + ' vs ' + state.players.B.rcl);
    return { ok: problems.length === 0, problems: problems };
  }

  function populationCounts(state) {
    return {
      creepsAlive: state.creeps.length,
      byOwner: { A: state.creeps.filter(function (c) { return c.owner === 'A'; }).length,
        B: state.creeps.filter(function (c) { return c.owner === 'B'; }).length,
        invader: state.creeps.filter(function (c) { return c.owner === 'invader'; }).length },
    };
  }

  function nearest(pos, list) {
    var best = null, bestD = Infinity;
    list.forEach(function (o) { var d = dist(pos, o.pos); if (d < bestD) { bestD = d; best = o; } });
    return best;
  }

  var api = {
    C: C, rng: rng, fnvHash: fnvHash, stateHash: stateHash, cmpId: cmpId,
    inBounds: inBounds, idx: idx, mirror: mirror, dist: dist,
    generateMap: generateMap, bfsReachable: bfsReachable,
    bodyCost: bodyCost, bodyHp: bodyHp, partCount: partCount, carryCapacity: carryCapacity, fatigueWeight: fatigueWeight, zeroPartSpend: zeroPartSpend,
    makePathCache: makePathCache, blockedMask: blockedMask, buildDistanceField: buildDistanceField,
    getDistanceField: getDistanceField, distanceFieldNaive: distanceFieldNaive,
    allStructures: allStructures, structureAt: structureAt, findById: findById, nearest: nearest,
    createMatch: createMatch,
    energyLedgerCheck: energyLedgerCheck, occupancyIndexNaive: occupancyIndexNaive,
    populationCounts: populationCounts, nextFreeSlot: nextFreeSlot, spiralOffsets: spiralOffsets, mirrorSymmetryCheck: mirrorSymmetryCheck,
  };

  // tick.js（1ティックの解決フェーズ・stepTick・createCtx）をここへ合流させ、1つの名前空間にする。
  // core.js が800行を超えたため分割した（S2の裁量。README参照）。tick.js からの require('./core.js') は
  // 循環参照になるが、Nodeの仕様どおりこの時点の module.exports（=このapi）がそのまま渡る。
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
    Object.assign(module.exports, require('./tick.js'));
  }
  if (typeof window !== 'undefined') window.S48 = api; // tick.js が後続の<script>でこれを拡張する
  if (typeof global !== 'undefined' && global && !global.S48) global.S48 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
