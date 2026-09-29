/**
 * S-48 bot — criteria.botGrid の10体を具体化する固定プログラム。学習しない・乱数を持たない
 * （whatSeedChanges「botのプログラムは乱数を一切持たない」）。
 *
 * 「rush」「turtle」「aggression」「buildPriority」という戦略の語彙はここに置く（core.js は持たない）。
 * decide() は state から orders を作る**純粋関数**（メモリを持たない。role は body 構成から毎回推定する）。
 *
 * 依存ゼロ・古典スクリプト。Node と ブラウザで共用。
 */
(function (global) {
  'use strict';
  var S = (typeof require !== 'undefined') ? require('./core.js') : global.S48;
  var Own = (typeof require !== 'undefined') ? require('./ownership.js') : global.S48Own;
  var C = S.C;

  var MILITARY_PATTERNS = {
    melee: ['TOUGH', 'ATTACK', 'ATTACK', 'MOVE', 'MOVE'],
    ranged: ['RANGED_ATTACK', 'MOVE', 'MOVE'],
    meleeHeal: ['ATTACK', 'ATTACK', 'MOVE', 'MOVE', 'HEAL', 'MOVE'],
    // **MOVE を1つ削って 11 → 10 部品にした**（2026-09-16）。C.MAX_PARTS を 50 → 10 にした結果、
    // 11 部品の単位パターンは `buildBody` の `body.length + unit.length <= MAX_PARTS` を一度も満たせず、
    // **このパターンを持つ bot が軍事 creep を1体も作れなくなる**（空の body が返る）ため。
    // criteria.botGrid の登録は [TOUGH x5, ATTACK x2, MOVE x4] のままなので、ここは登録とずれている（Q-61）
    toughBrawl: ['TOUGH', 'TOUGH', 'TOUGH', 'TOUGH', 'TOUGH', 'ATTACK', 'ATTACK', 'MOVE', 'MOVE', 'MOVE'],
  };
  var ECON_UNIT = ['WORK', 'CARRY', 'MOVE'];
  var WALL_TARGET_HITS = 10000; // S2 が自分で決めた（criteria未登録。README参照）
  // creep数の上限（S2が決めた。README参照）。上限が無いと pool に余裕ができるたび即座に econ か
  // military を補充してしまい、controller へ回る余剰が永久に生まれず RCL が実質進まなくなる
  // （経済creepだけ上限を設けても、余った予算が今度は military の際限ない生産へ流れるだけだった。
  // 実装して初めて分かった。README参照）
  var ECON_CAP = 8;
  var MIL_CAP = 10;
  var TERRITORY_MARGIN = 1.15;  // 「自陣」判定の余裕（境界ちょうどでの往復を防ぐ）

  function isMilitary(body) {
    return body.indexOf('ATTACK') >= 0 || body.indexOf('RANGED_ATTACK') >= 0 || body.indexOf('HEAL') >= 0;
  }
  function isEcon(body) { return !isMilitary(body); }

  function buildBody(unit, budget) {
    var body = [];
    var unitCost = S.bodyCost(unit);
    if (unitCost > budget || unitCost <= 0) return [];
    while (body.length + unit.length <= C.MAX_PARTS && S.bodyCost(body.concat(unit)) <= budget) {
      body = body.concat(unit);
    }
    return body;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // **state を直に読まない。** 取得は全て ownership.js の視界（viewFor）を経由する。
  // 理由と規則は ownership.js の冒頭にある（1部屋に複数プレイヤーが同居することの帰結）。
  // ここを `state.structures` の直読みに戻すと、相手の structure を自分のものとして
  // 拾う道が再び開く。**戻さないこと。** selftest の「所有権」項目が見張っている。
  // ─────────────────────────────────────────────────────────────────────────
  function ownCreeps(state, owner) { return Own.viewFor(state, owner).my.creeps; }
  function enemyOwner(owner) { return owner === 'A' ? 'B' : 'A'; }
  function ownStructs(state, owner, kind) { return Own.viewFor(state, owner).my[kind]; }
  /** 他**プレイヤー**のもの（invader は含まない。invader は invadersVisible で別に取る）。 */
  function enemyVisible(state, owner) {
    var v = Own.viewFor(state, owner), e = enemyOwner(owner);
    return v.hostile.creeps.filter(function (c) { return c.owner === e && !c.spawning; })
      .concat(v.hostile.structures.filter(function (s) { return s.owner === e; }));
  }
  function invadersVisible(state) { return state.creeps.filter(function (c) { return c.owner === 'invader' && !c.spawning; }); }

  /** 自陣かどうか（own spawn までの距離 < enemy spawn までの距離 × 余裕）。180度対称の地図をVoronoiで割る。 */
  function inOwnTerritory(pos, ownSpawnPos, enemySpawnPos) {
    return S.dist(pos, ownSpawnPos) * TERRITORY_MARGIN < S.dist(pos, enemySpawnPos);
  }

  function pickBuildTarget(state, owner, buildPriority) {
    var order = buildPriority === 'extension' ? ['extensions', 'towers', 'walls']
      : buildPriority === 'tower' ? ['towers', 'extensions', 'walls']
      : ['walls', 'extensions', 'towers'];
    for (var i = 0; i < order.length; i++) {
      var incomplete = ownStructs(state, owner, order[i]).filter(function (s) { return !s.active; });
      if (incomplete.length) return incomplete[0];
    }
    return null;
  }

  function combatActionFor(creep) {
    if (creep.body.indexOf('RANGED_ATTACK') >= 0) return 'rangedAttack';
    if (creep.body.indexOf('ATTACK') >= 0) return 'attack';
    if (creep.body.indexOf('HEAL') >= 0) return 'heal';
    return null;
  }

  function decideMilitary(state, owner, creep, botDef, ownSpawnPos, enemySpawnPos, rcl) {
    var enemies = enemyVisible(state, owner).filter(function (o) { return o.hp === undefined || o.hp > 0; });
    var invaders = invadersVisible(state);
    var threats = enemies.concat(invaders);

    var defend = botDef.aggression === 'turtle' || (botDef.aggression === 'tech' && rcl < 3);
    if (defend) {
      var intruder = S.nearest(creep.pos, threats.filter(function (t) { return inOwnTerritory(t.pos, ownSpawnPos, enemySpawnPos); }));
      if (intruder) return attackOrHeal(creep, intruder);
      // 巡回: 自陣にとどまる（own spawn へ寄る）
      return { action: null, goalPos: ownSpawnPos, range: 3 };
    }

    // rush、あるいは tech で RCL3 以上: 進軍する
    var nearThreat = S.nearest(creep.pos, threats);
    if (nearThreat && S.dist(creep.pos, nearThreat.pos) <= 8) return attackOrHeal(creep, nearThreat);
    return { action: 'attack', goalPos: enemySpawnPos, range: 1, targetId: null };
  }
  function attackOrHeal(creep, target) {
    var act = combatActionFor(creep);
    if (!act) return { action: null, goalPos: creep.pos, range: 0 };
    if (act === 'heal') return { action: 'heal', targetId: target.id, goalPos: target.pos, range: C.RANGED_HEAL_RANGE };
    var range = act === 'rangedAttack' ? C.RANGED_ATTACK_RANGE : C.ATTACK_RANGE;
    return { action: act, targetId: target.id, goalPos: target.pos, range: range, kite: act === 'rangedAttack' };
  }

  /**
   * econ creep のうち後回しの3体に1体を専属アップグレーダーにする（最初の3体は必ずhauler。
   * README参照）。先頭からいきなり1/3をアップグレーダーにすると、経済が立ち上がる前の1体目が
   * それに当たった場合 pool が永久に補充されず spawn が止まる（実装して初めて分かった）。
   */
  function isUpgrader(econIndex) { return econIndex >= 3 && econIndex % 3 === 0; }

  function decideEcon(state, owner, creep, botDef, ownSpawnPos, econIndex) {
    var sources = state.sources.filter(function (s) { return s.energy > 0; });
    if (creep.carry < creep.carryCap) {
      var src = S.nearest(creep.pos, sources);
      if (src) return { action: 'harvest', targetId: src.id, goalPos: src.pos, range: C.HARVEST_RANGE };
    }
    if (creep.carry > 0) {
      var ctrl = Own.viewFor(state, owner).my.controller;   // 本家の room.controller に対応（単数）
      if (isUpgrader(econIndex)) return { action: 'upgrade', targetId: ctrl.id, goalPos: ctrl.pos, range: C.CONTROLLER_UPGRADE_RANGE };
      var player = state.players[owner];
      if (player.energy < player.capacity) {
        var spawn = ownStructs(state, owner, 'spawns')[0];
        return { action: 'deliver', targetId: spawn.id, goalPos: spawn.pos, range: 1 };
      }
      var site = pickBuildTarget(state, owner, botDef.buildPriority);
      if (site) return { action: 'build', targetId: site.id, goalPos: site.pos, range: C.BUILD_RANGE };
      return { action: 'upgrade', targetId: ctrl.id, goalPos: ctrl.pos, range: C.CONTROLLER_UPGRADE_RANGE };
    }
    // 空で、枯れた source しかない: spawn 付近で待つ
    return { action: null, goalPos: ownSpawnPos, range: 5 };
  }

  /** buildPriority==='wall' の bot が自陣の壁位置を選ぶ（固定パターン。S2が決めた。README参照）。 */
  function wallPlan(ownSpawnPos, enemySpawnPos) {
    var dx = enemySpawnPos.x > ownSpawnPos.x ? 1 : -1, dy = enemySpawnPos.y > ownSpawnPos.y ? 1 : -1;
    var offsets = [[6 * dx, 0], [0, 6 * dy], [6 * dx, 2 * dy], [2 * dx, 6 * dy]];
    return offsets.map(function (o) {
      var x = ownSpawnPos.x + o[0], y = ownSpawnPos.y + o[1];
      return { pos: { x: Math.max(1, Math.min(C.SIZE - 2, x)), y: Math.max(1, Math.min(C.SIZE - 2, y)) }, hits: WALL_TARGET_HITS };
    });
  }

  /**
   * 1プレイヤー・1ティックぶんの orders を作る。state は match.js が視界制限（negativeControls[2]）を
   * 済ませたうえで渡す。bot 自身は state のほかに乱数・メモリを一切使わない。
   */
  function decide(state, owner, botDef) {
    // negativeControls[0]（駆動を切った系）: 一切の命令を出さない
    if (botDef.noop) return { spawn: null, creepActions: {}, wallBuilds: [] };
    var ownSpawn = ownStructs(state, owner, 'spawns')[0];
    var ownSpawnPos = ownSpawn.pos, enemySpawnPos = S.mirror(ownSpawnPos); // 対称性は既知の規則（観測ではない）
    var player = state.players[owner];
    var creeps = ownCreeps(state, owner);
    // econFraction は「spawn予算のうち経済creepへ回す割合」(criteria.botGrid) ＝ エネルギー配分。
    // creep数の比だと1体目で比が飛び跳ねて壊れるため、累積spend（core.jsのpartSpend）で判定する。
    // ECON_UNIT=[WORK,CARRY,MOVE]のWORKは常にunitの半分(100/200)なので econSpend = partSpend.WORK*2 で厳密に取り出せる
    // （militaryのbodyパターンはどれもWORK/CARRYを含まないため、これは近似ではなく厳密な内訳である）。
    var sp = player.partSpend;
    var econSpend = sp.WORK * 2;
    var totalSpend = sp.WORK + sp.CARRY + sp.MOVE + sp.ATTACK + sp.RANGED_ATTACK + sp.HEAL + sp.TOUGH;
    var wantEcon = totalSpend === 0 ? true : (econSpend / totalSpend) < botDef.econFraction;

    var econSorted = creeps.filter(function (c) { return isEcon(c.body); }).map(function (c) { return c.id; }).sort();
    var creepActions = {};
    creeps.forEach(function (c) {
      if (c.spawning) return;
      var order = isEcon(c.body)
        ? decideEcon(state, owner, c, botDef, ownSpawnPos, econSorted.indexOf(c.id))
        : decideMilitary(state, owner, c, botDef, ownSpawnPos, enemySpawnPos, player.rcl);
      creepActions[c.id] = order;
    });

    var spawnReq = null;
    if (!player.spawning) {
      var econAlive = creeps.filter(function (c) { return isEcon(c.body); }).length;
      var milAlive = creeps.length - econAlive;
      var econOk = econAlive < ECON_CAP, milOk = milAlive < MIL_CAP;
      var wantEconCapped = wantEcon ? econOk : !milOk && econOk;
      var budget = Math.min(player.energy, C.MAX_CREEP_ENERGY);
      var milUnit = MILITARY_PATTERNS[botDef.militaryBody];
      var preferred = wantEconCapped ? ECON_UNIT : (milOk ? milUnit : null);
      var fallback = wantEconCapped ? (milOk ? milUnit : null) : (econOk ? ECON_UNIT : null);
      var body = preferred ? buildBody(preferred, budget) : [];
      // 望ましい方の最小unitすら買えない（か上限に達している）なら、買える方へ倒す。
      // 両方が上限に達していれば何も spawn せず、余剰は controller への投資に回る（ECON_CAP/MIL_CAP参照）
      if (body.length === 0 && fallback) body = buildBody(fallback, budget);
      if (body.length > 0) spawnReq = { body: body };
    }

    var wallBuilds = botDef.buildPriority === 'wall' ? wallPlan(ownSpawnPos, enemySpawnPos) : [];

    return { spawn: spawnReq, creepActions: creepActions, wallBuilds: wallBuilds };
  }

  /** negativeControls[2]: 相手の creep と structure を state から完全に除く。 */
  /** negativeControls[2]。世界の検閲は所有権の層に置いてある（ownership.js の censorHostile）。 */
  function blindView(state, owner) { return Own.censorHostile(state, owner); }


  var api = {
    MILITARY_PATTERNS: MILITARY_PATTERNS, ECON_UNIT: ECON_UNIT,
    isMilitary: isMilitary, isEcon: isEcon, buildBody: buildBody,
    decide: decide, blindView: blindView, inOwnTerritory: inOwnTerritory, combatActionFor: combatActionFor,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.S48Bots = api;
  if (typeof global !== 'undefined' && global && !global.S48Bots) global.S48Bots = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
