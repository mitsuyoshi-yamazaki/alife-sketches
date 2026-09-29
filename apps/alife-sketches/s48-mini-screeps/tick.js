/**
 * S-48 核（続き）— 1ティックの解決フェーズだけを core.js から分離したもの。
 *
 * core.js が800行を超えたため、**同じ「核」の一部として**ここへ分割した（S2の裁量。README参照）。
 * 上位概念の語彙は持たない点・ミューテーションを避けた記述を優先する点は core.js と同じ規約に従う。
 * `require('./core.js')`（Node）/ `<script src="core.js">` の**あとに読み込む**こと
 * （`window.S48` へこのファイルの関数を追加で載せる。UMD風だが「土台+拡張」の2段構成）。
 *
 * 依存ゼロ・古典スクリプト。Node と ブラウザで共用。
 */
(function (global) {
  'use strict';
  var S = (typeof require !== 'undefined') ? require('./core.js') : global.S48;
  var Own = (typeof require !== 'undefined') ? require('./ownership.js') : global.S48Own;
  var C = S.C;

  // ================================================================== フェーズ1: 資源の再生
  /**
   * source の再生と、**spawn のエネルギー自動再生**。
   *
   * 後者は本家の仕様をそのまま入れたものである（2026-09-16 ユーザ指示）。公式文書の原文:
   *   「Spawns auto-regenerate a little amount of energy each tick, so that you can easily
   *     recover even if all your creeps died.」
   *   「Energy auto-regeneration: **1 energy unit per tick while energy available in the room
   *     (in all spawns and extensions) is less than 300**」
   *
   * **これが無いと、働き手の creep が全滅した時点でそのプレイヤーは永久に復旧できない**
   * （採取する creep が居ない → エネルギーが増えない → creep を作れない、の詰み）。
   * 本家がこの規則を持つ理由そのものであり、ユーザの指摘どおりである。
   *
   * 本スケッチでの読み替え: 本家の「room の energyAvailable」は部屋の所有者のものだが、
   * ここは1部屋に2人が同居する（ownership.js）。**pool は元々プレイヤーごと**なので、
   * 「そのプレイヤーの spawn+extension の合計が 300 未満なら +1」と読み替える。
   * 閾値 300 は本家の SPAWN_ENERGY_CAPACITY と同じ値である。
   *
   * 湧いたエネルギーは無から出てくるので、**保存則の左辺に `regenerated` の枠を足してある**
   * （core.js の energyLedgerCheck）。足さないと検算が必ず落ちる。
   */
  function phaseRegen(state) {
    var sources = state.sources.map(function (s) {
      if (state.tick >= s.nextRegen) return Object.assign({}, s, { energy: C.SOURCE_CAPACITY, nextRegen: s.nextRegen + C.SOURCE_REGEN_TIME });
      return s;
    });

    var players = state.players, ledger = state.ledger, gained = 0;
    var patch = null;
    Own.PLAYERS.forEach(function (owner) {
      var pl = players[owner];
      if (!pl || pl.energy >= C.SPAWN_ENERGY_REGEN_THRESHOLD) return;
      var add = Math.min(C.SPAWN_ENERGY_REGEN_PER_TICK, pl.capacity - pl.energy);
      if (add <= 0) return;
      if (!patch) patch = { A: players.A, B: players.B };
      patch[owner] = Object.assign({}, patch[owner], { energy: patch[owner].energy + add });
      gained += add;
    });
    if (patch) {
      players = patch;
      ledger = Object.assign({}, ledger, { regenerated: ledger.regenerated + gained });
    }

    return Object.assign({}, state, { sources: sources, players: players, ledger: ledger });
  }

  // ================================================================== フェーズ2: spawn
  function processSpawn(state, owner, request) {
    var player = state.players[owner];
    var spawn = state.structures.spawns.filter(function (s) { return s.owner === owner; })[0];
    var newPlayers = state.players, newCreeps = state.creeps, seq = state.nextCreepSeq;

    // 進行中の生成の消化
    if (player.spawning) {
      var left = player.spawning.ticksLeft - 1;
      if (left <= 0) {
        var body = player.spawning.body;
        var creep = {
          id: owner + '-' + player.spawning.seq, owner: owner, pos: Object.assign({}, spawn.pos),
          body: body, hp: S.bodyHp(body), maxHp: S.bodyHp(body), carry: 0, carryCap: S.carryCapacity(body),
          fatigue: 0, spawning: false, age: 0, birthTick: state.tick,
        };
        newCreeps = newCreeps.concat([creep]);
        newPlayers = Object.assign({}, newPlayers, mkPlayerPatch(owner, newPlayers[owner], { spawning: null }));
      } else {
        newPlayers = Object.assign({}, newPlayers, mkPlayerPatch(owner, newPlayers[owner], {
          spawning: Object.assign({}, player.spawning, { ticksLeft: left }),
        }));
      }
    } else if (request && request.body && request.body.length > 0 && request.body.length <= C.MAX_PARTS) {
      var cost = S.bodyCost(request.body);
      if (cost <= player.capacity && player.energy >= cost) {
        var spend = Object.assign({}, player.partSpend);
        request.body.forEach(function (p) { spend[p] = (spend[p] || 0) + C.PART_COST[p]; });
        newPlayers = Object.assign({}, newPlayers, mkPlayerPatch(owner, newPlayers[owner], {
          energy: player.energy - cost, partSpend: spend,
          spawning: { body: request.body, ticksLeft: request.body.length * C.SPAWN_TICKS_PER_PART, seq: seq },
        }));
        seq = seq + 1;
        state = Object.assign({}, state, { ledger: Object.assign({}, state.ledger, { bodySpend: state.ledger.bodySpend + cost }) });
      } else {
        newPlayers = Object.assign({}, newPlayers, mkPlayerPatch(owner, newPlayers[owner], { spawnDenied: player.spawnDenied + 1 }));
      }
    }
    return Object.assign({}, state, { players: newPlayers, creeps: newCreeps, nextCreepSeq: seq });
  }
  function mkPlayerPatch(owner, cur, patch) { var o = {}; o[owner] = Object.assign({}, cur, patch); return o; }

  function phaseSpawn(state, ordersA, ordersB) {
    state = processSpawn(state, 'A', ordersA.spawn);
    state = processSpawn(state, 'B', ordersB.spawn);
    return state;
  }

  // ================================================================== フェーズ3: 経済（harvest/build/repair/upgrade/deliver）＋RCL更新・建設スロット解禁
  function applyEconomy(state, orders, owner) {
    // 触る可能性のある入れ子だけ複製してから書き換える（元の state は書き換えない）
    var creeps = state.creeps;
    var sources = state.sources.map(function (s) { return Object.assign({}, s); });
    var players = { A: Object.assign({}, state.players.A), B: Object.assign({}, state.players.B) };
    var ledger = Object.assign({}, state.ledger);
    var structs = {
      spawns: state.structures.spawns,
      extensions: state.structures.extensions.map(function (s) { return Object.assign({}, s); }),
      towers: state.structures.towers.map(function (s) { return Object.assign({}, s); }),
      walls: state.structures.walls.map(function (s) { return Object.assign({}, s); }),
      controllers: state.structures.controllers.map(function (s) { return Object.assign({}, s); }),
    };
    state = Object.assign({}, state, { sources: sources, players: players, ledger: ledger, structures: structs });
    var acts = orders.creepActions || {};

    creeps = creeps.map(function (c) {
      if (c.owner !== owner || c.spawning) return c;
      var order = acts[c.id];
      if (!order || !order.action) return c;
      if (order.action === 'harvest') {
        var src = sources.filter(function (s) { return s.id === order.targetId; })[0];
        if (!src || src.energy <= 0 || S.dist(c.pos, src.pos) > C.HARVEST_RANGE) return c;
        var amt = Math.min(S.partCount(c.body, 'WORK') * C.HARVEST_POWER, src.energy, c.carryCap - c.carry);
        if (amt <= 0) return c;
        src.energy -= amt; ledger.harvested += amt; players[owner].harvested += amt; state.cumHarvestBoth += amt;
        return Object.assign({}, c, { carry: c.carry + amt });
      }
      if (order.action === 'deliver') {
        var spawn = structs.spawns.filter(function (s) { return s.owner === owner; })[0];
        if (S.dist(c.pos, spawn.pos) > 1 || c.carry <= 0) return c;
        var room = players[owner].capacity - players[owner].energy;
        var give = Math.min(c.carry, room);
        if (give <= 0) return c;
        players[owner].energy += give;
        return Object.assign({}, c, { carry: c.carry - give });
      }
      if (order.action === 'upgrade') {
        var ctrl = structs.controllers.filter(function (s) { return s.owner === owner; })[0];
        if (S.dist(c.pos, ctrl.pos) > C.CONTROLLER_UPGRADE_RANGE || c.carry <= 0) return c;
        var uAmt = Math.min(S.partCount(c.body, 'WORK') * C.UPGRADE_POWER, c.carry);
        if (uAmt <= 0) return c;
        ctrl.progress += uAmt; players[owner].controllerProgress += uAmt; ledger.invested += uAmt;
        return Object.assign({}, c, { carry: c.carry - uAmt });
      }
      if (order.action === 'build' || order.action === 'repair') {
        var target = S.findById(state, order.targetId);
        if (!target || target.owner !== owner || c.carry <= 0) return c;
        if (S.dist(c.pos, target.pos) > C.BUILD_RANGE) return c;
        if (order.action === 'build' && target.active) return c;
        var capRemain = target.maxHp - target.hp;
        if (capRemain <= 0) return c;
        var power = order.action === 'build' ? C.BUILD_POWER : C.REPAIR_POWER;
        var maxByWork = S.partCount(c.body, 'WORK') * power;
        var maxByEnergy = c.carry * power;
        var hitsAdded = Math.min(maxByWork, maxByEnergy, capRemain);
        if (hitsAdded <= 0) return c;
        var energySpent = hitsAdded / power;
        target.hp += hitsAdded; ledger.built += energySpent; players[owner].builtCost += energySpent;
        if (!target.active && target.hp >= target.maxHp) { target.hp = target.maxHp; target.active = true; }
        return Object.assign({}, c, { carry: c.carry - energySpent });
      }
      return c;
    });

    // RCL 更新と建設スロットの解禁（system.rcl / structureUnlockOrder）
    var player = players[owner];
    var newRcl = player.rcl;
    while (newRcl < C.RCL_MAX && player.controllerProgress >= C.RCL_THRESHOLD[newRcl]) newRcl++;
    if (newRcl !== player.rcl) {
      players[owner] = Object.assign({}, player, { rcl: newRcl, capacity: C.SPAWN_ENERGY_CAPACITY + C.EXTENSIONS_AT_RCL[newRcl - 1] * C.EXTENSION_ENERGY_CAPACITY });
      var spawnPos = structs.spawns.filter(function (s) { return s.owner === owner; })[0].pos;
      var wantExt = C.EXTENSIONS_AT_RCL[newRcl - 1];
      var haveExt = structs.extensions.filter(function (s) { return s.owner === owner; }).length;
      for (var i = haveExt; i < wantExt; i++) {
        var pos = S.nextFreeSlot(state, spawnPos, state.slotsUsed[owner]);
        if (!pos) break;
        structs.extensions = structs.extensions.concat([{
          id: 'ext-' + owner + '-' + (state.nextStructSeq++), owner: owner, pos: pos,
          hp: 0, maxHp: C.EXTENSION_MAX_HP, active: false,
        }]);
      }
      var wantTower = C.TOWERS_AT_RCL[newRcl - 1];
      var haveTower = structs.towers.filter(function (s) { return s.owner === owner; }).length;
      for (var j = haveTower; j < wantTower; j++) {
        var tpos = S.nextFreeSlot(state, spawnPos, state.slotsUsed[owner]);
        if (!tpos) break;
        structs.towers = structs.towers.concat([{
          id: 'tower-' + owner + '-' + (state.nextStructSeq++), owner: owner, pos: tpos,
          hp: 0, maxHp: C.TOWER_MAX_HP, active: false,
        }]);
      }
    }

    // 壁の新規着工（bot が座標と目標hitsを指定する。system.structures: wallは建設位置をbotが選ぶ）
    (orders.wallBuilds || []).forEach(function (w) {
      if (state.structures.walls.some(function (s) { return s.pos.x === w.pos.x && s.pos.y === w.pos.y; })) return;
      if (state.terrain[S.idx(w.pos.x, w.pos.y)] === 1 || S.structureAt(state, w.pos.x, w.pos.y)) return;
      var hits = Math.max(1, Math.min(C.WALL_MAX_HITS, w.hits | 0));
      structs.walls = structs.walls.concat([{
        id: 'wall-' + owner + '-' + (state.nextStructSeq++), owner: owner, pos: Object.assign({}, w.pos),
        hp: 0, maxHp: hits, active: false,
      }]);
    });

    return Object.assign({}, state, { creeps: creeps, sources: sources, players: players, ledger: ledger, structures: structs });
  }
  function phaseEconomy(state, ordersA, ordersB) {
    state = applyEconomy(state, ordersA, 'A');
    state = applyEconomy(state, ordersB, 'B');
    return state;
  }

  // ================================================================== フェーズ4: 攻撃・治癒（ティック開始時の状態から同時算出。A6）
  function towerFalloff(range) {
    if (range <= C.TOWER_OPTIMAL_RANGE) return 1;
    if (range >= C.TOWER_FALLOFF_RANGE) return C.TOWER_FALLOFF_RETAIN;
    var t = (range - C.TOWER_OPTIMAL_RANGE) / (C.TOWER_FALLOFF_RANGE - C.TOWER_OPTIMAL_RANGE);
    return 1 - t * (1 - C.TOWER_FALLOFF_RETAIN);
  }
  function phaseCombat(state, ordersByOwner) {
    if (state.combatDisabled) return state;
    // 触る可能性のある入れ子だけ複製してから書き換える（元の state は書き換えない）
    var players = { A: Object.assign({}, state.players.A), B: Object.assign({}, state.players.B) };
    var ledger = Object.assign({}, state.ledger);
    var structs = {
      spawns: state.structures.spawns,
      extensions: state.structures.extensions.map(function (s) { return Object.assign({}, s); }),
      towers: state.structures.towers.map(function (s) { return Object.assign({}, s); }),
      walls: state.structures.walls.map(function (s) { return Object.assign({}, s); }),
      controllers: state.structures.controllers.map(function (s) { return Object.assign({}, s); }),
    };
    state = Object.assign({}, state, { players: players, ledger: ledger, structures: structs });
    var deltas = {}; // id -> {damage, heal}
    function addDelta(id, damage, heal) {
      if (!deltas[id]) deltas[id] = { damage: 0, heal: 0 };
      deltas[id].damage += damage; deltas[id].heal += heal;
    }
    var acts = ordersByOwner.__acts;
    state.creeps.forEach(function (c) {
      if (c.spawning) return;
      var order = acts[c.id];
      if (!order || !order.action) return;
      var target = S.findById(state, order.targetId);
      if (!target) return;
      var d = S.dist(c.pos, target.pos);
      if (order.action === 'attack' && d <= C.ATTACK_RANGE) addDelta(target.id, S.partCount(c.body, 'ATTACK') * C.ATTACK_POWER, 0);
      else if (order.action === 'rangedAttack' && d <= C.RANGED_ATTACK_RANGE) addDelta(target.id, S.partCount(c.body, 'RANGED_ATTACK') * C.RANGED_ATTACK_POWER, 0);
      else if (order.action === 'heal') {
        if (d <= C.HEAL_RANGE) addDelta(target.id, 0, S.partCount(c.body, 'HEAL') * C.HEAL_POWER);
        else if (d <= C.RANGED_HEAL_RANGE) addDelta(target.id, 0, S.partCount(c.body, 'HEAL') * C.RANGED_HEAL_POWER);
      }
    });

    var towerLog = [];
    ['A', 'B'].forEach(function (owner) {
      var towers = state.structures.towers.filter(function (t) { return t.owner === owner && t.active; });
      towers.forEach(function (tower) {
        if (state.players[owner].energy < C.TOWER_ACTION_COST) return;
        var enemy = owner === 'A' ? 'B' : 'A';
        var enemyCreeps = state.creeps.filter(function (c) { return c.owner === enemy && !c.spawning; })
          .concat(state.creeps.filter(function (c) { return c.owner === 'invader'; }));
        var target = S.nearest(tower.pos, enemyCreeps);
        var kind = 'attack';
        if (!target) {
          var hurtStruct = S.allStructures(state).filter(function (s) { return s.owner === owner && s.active && s.hp < s.maxHp; });
          target = S.nearest(tower.pos, hurtStruct); kind = 'repair';
        }
        if (!target) {
          var hurtCreep = state.creeps.filter(function (c) { return c.owner === owner && !c.spawning && c.hp < c.maxHp; });
          target = S.nearest(tower.pos, hurtCreep); kind = 'heal';
        }
        if (!target) return;
        state.players[owner].energy -= C.TOWER_ACTION_COST;
        state.ledger.towerSpend += C.TOWER_ACTION_COST;
        var f = towerFalloff(S.dist(tower.pos, target.pos));
        if (kind === 'attack') addDelta(target.id, C.TOWER_ATTACK * f, 0);
        else if (kind === 'heal') addDelta(target.id, 0, C.TOWER_HEAL * f);
        else { target.hp = Math.min(target.maxHp, target.hp + C.TOWER_REPAIR * f); }
        towerLog.push(tower.id + '->' + kind + ':' + target.id);
      });
    });

    var creeps = state.creeps.map(function (c) {
      var d = deltas[c.id];
      if (!d) return c;
      var hp = c.hp - d.damage + d.heal;
      return Object.assign({}, c, { hp: hp });
    });
    var log = towerLog.length ? state.log.concat(['t' + state.tick + ' tower: ' + towerLog.join(' ')]) : state.log;
    return Object.assign({}, state, { creeps: creeps, log: log });
  }

  // ================================================================== フェーズ5: 移動（A5近似の距離場 + tie-break乱数。A6）
  /**
   * BFS距離場が最小（away時は最大）の隣接マスを選ぶ。同点は「目的方向への内積」で解く
   * （鏡映対称の下で不変——(-dx,-dy)・(-tx,-ty) = dx・tx+dy・ty なので、鏡映した局面でも同じ側を選ぶ。
   * 固定走査順の早い者勝ちだと、180度回転対称の局面で片方だけ違う近道を選んでしまう。実装して初めて分かった）。
   */
  function stepToward(state, cache, from, target, away, ownerFlip) {
    var field = S.getDistanceField(state, cache, target);
    var tx = target.x - from.x, ty = target.y - from.y;
    var candidates = [];
    for (var dy = -1; dy <= 1; dy++) for (var dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      var nx = from.x + dx, ny = from.y + dy;
      if (!S.inBounds(nx, ny) || state.terrain[S.idx(nx, ny)] === 1) continue;
      var v = field[S.idx(nx, ny)];
      if (v === -1) continue;
      candidates.push({ x: nx, y: ny, v: v, dx: dx, dy: dy });
    }
    if (candidates.length === 0) return null;
    var bestV = candidates[0].v;
    candidates.forEach(function (c) { if (away ? c.v > bestV : c.v < bestV) bestV = c.v; });
    var tied = candidates.filter(function (c) { return c.v === bestV; });
    if (tied.length === 1) return { x: tied[0].x, y: tied[0].y };
    var sign = away ? -1 : 1;
    var best = tied[0], bestDot = sign * (tied[0].dx * tx + tied[0].dy * ty);
    for (var i = 1; i < tied.length; i++) {
      var dot = sign * (tied[i].dx * tx + tied[i].dy * ty);
      if (dot > bestDot) { bestDot = dot; best = tied[i]; }
    }
    // 方向の内積でも決まらない残り（例: 目標が真横で上下が等価）は、鏡映対称の下で符号が反転する
    // 基準（ownerFlip）で最後に決める。固定の走査順で早い者勝ちにすると、180度回転対称な局面で
    // 片方だけ違う経路を選んでしまう（positiveControls[2]で発見。README参照）
    var stillTied = tied.filter(function (c) { return sign * (c.dx * tx + c.dy * ty) === bestDot; });
    if (stillTied.length > 1) {
      best = stillTied.reduce(function (a, b) {
        var ka = ownerFlip ? -(a.dy * 3 + a.dx) : (a.dy * 3 + a.dx);
        var kb = ownerFlip ? -(b.dy * 3 + b.dx) : (b.dy * 3 + b.dx);
        return kb < ka ? b : a;
      });
    }
    return { x: best.x, y: best.y };
  }
  function phaseMove(state, cache, ordersByOwner, rand, tieBreakMode) {
    var acts = ordersByOwner.__acts;
    var structCells = {};
    S.allStructures(state).forEach(function (s) { structCells[s.pos.x + ',' + s.pos.y] = true; });

    var wants = []; // {creep, dest}
    state.creeps.forEach(function (c) {
      if (c.spawning || c.fatigue > 0) return; // 疲労が残っていれば動けない（今ティックの回復は下で処理）
      var order = acts[c.id];
      if (!order || !order.goalPos) return;
      var inRange = order.action && order.range != null && S.dist(c.pos, order.goalPos) <= order.range;
      var flip = c.owner === 'B';
      var dest;
      if (order.kite && order.action === 'rangedAttack' && S.dist(c.pos, order.goalPos) <= 1) {
        dest = stepToward(state, cache, c.pos, order.goalPos, true, flip);
      } else if (inRange) {
        dest = null;
      } else {
        dest = stepToward(state, cache, c.pos, order.goalPos, false, flip);
      }
      if (dest) wants.push({ creep: c, dest: dest });
    });

    // 目的地ごとにグループ化し、tie-breakで1体だけ候補に残す（同じマスを2体が取り合わない）
    var byDest = {};
    wants.forEach(function (w) { var k = w.dest.x + ',' + w.dest.y; (byDest[k] = byDest[k] || []).push(w); });
    var candidates = {}; // creepId -> dest
    Object.keys(byDest).sort().forEach(function (k) {
      var list = byDest[k].slice();
      if (tieBreakMode === 'fixed') list.sort(function (a, b) { return S.cmpId ? S.cmpId(a.creep, b.creep) : (a.creep.id < b.creep.id ? -1 : 1); });
      else shuffle(list, rand);
      candidates[list[0].creep.id] = list[0].dest;
    });

    // 連鎖解決: 動こうとしている駒が先に退けば、その跡地へ後続が入れる（A6 の「移動」1フェーズの中で反復収束させる）。
    // 構造物のマス・動かない駒のマスは最後まで塞がったまま。真の入れ替わり（相互待ち）は本エンジンでは解けず、
    // 両者とも今ティックは動かない——README「自分で決めた実装上の判断」に記載する簡略化。
    var occupantAt = {};
    state.creeps.forEach(function (c) { occupantAt[c.pos.x + ',' + c.pos.y] = c.id; });
    var confirmed = {}, blocked = {}, destOf = {};
    Object.keys(candidates).forEach(function (id) { destOf[id] = candidates[id]; });

    var progress = true, rounds = 0;
    while (progress && rounds < 12) {
      progress = false; rounds++;
      Object.keys(destOf).forEach(function (id) {
        if (confirmed[id] || blocked[id]) return;
        var dest = destOf[id], key = dest.x + ',' + dest.y;
        if (structCells[key]) { blocked[id] = true; progress = true; return; }
        var occ = occupantAt[key];
        if (occ === undefined) {
          var from = findCreepPos(state, id);
          delete occupantAt[from.x + ',' + from.y];
          occupantAt[key] = id;
          confirmed[id] = true; progress = true;
        } else if (occ === id) {
          confirmed[id] = true; progress = true; // 既に目的地にいる（起こらない想定だが保険）
        } else if (blocked[occ] || !destOf[occ]) {
          blocked[id] = true; progress = true; // 居座る駒に塞がれている
        }
        // occ が confirmed でも destOf でもまだ pending なら次のラウンドへ持ち越す
      });
    }
    // 直接の入れ替わり（A→今Bがいるマス、B→今Aがいるマス）は許可する。これを許さないと
    // すれ違う2駒が毎ティック相互に足止めし続け、経済が恒久的に止まる（実装して初めて分かった。README参照）
    Object.keys(destOf).forEach(function (id) {
      if (confirmed[id] || blocked[id]) return;
      var dest = destOf[id], key = dest.x + ',' + dest.y, occ = occupantAt[key];
      if (!occ || occ === id || confirmed[occ] || blocked[occ] || !destOf[occ]) return;
      var myPos = findCreepPos(state, id), occDest = destOf[occ];
      if (occDest.x === myPos.x && occDest.y === myPos.y) {
        confirmed[id] = true; confirmed[occ] = true;
        occupantAt[key] = id; occupantAt[myPos.x + ',' + myPos.y] = occ;
      }
    });
    Object.keys(destOf).forEach(function (id) { if (!confirmed[id]) blocked[id] = true; }); // 未解決＝相互待ちは動かない

    var creeps = state.creeps.map(function (c) {
      var fatigueLeft = Math.max(0, c.fatigue - S.partCount(c.body, 'MOVE') * 2);
      if (c.fatigue > 0) return Object.assign({}, c, { fatigue: fatigueLeft, age: c.age + 1 });
      if (!confirmed[c.id]) return Object.assign({}, c, { age: c.age + 1 });
      var newFatigue = S.fatigueWeight(c);
      return Object.assign({}, c, { pos: destOf[c.id], fatigue: newFatigue, age: c.age + 1 });
    });
    return Object.assign({}, state, { creeps: creeps });
  }
  function findCreepPos(state, id) {
    for (var i = 0; i < state.creeps.length; i++) if (state.creeps[i].id === id) return state.creeps[i].pos;
    return null;
  }
  function shuffle(arr, rand) {
    for (var i = arr.length - 1; i > 0; i--) { var j = Math.floor(rand() * (i + 1)); var t = arr[i]; arr[i] = arr[j]; arr[j] = t; }
  }

  // ================================================================== フェーズ6: 死亡・減衰
  function phaseDeath(state) {
    var ledger = Object.assign({}, state.ledger);
    var dead = [];
    var creeps = state.creeps.filter(function (c) {
      var diesOfAge = c.age >= C.LIFE_TIME;
      var diesOfHp = c.hp <= 0;
      if (diesOfAge || diesOfHp) { dead.push(c); ledger.ground += c.carry; return false; }
      return true;
    });
    var structs = state.structures;
    ['extensions', 'towers', 'walls'].forEach(function (kind) {
      structs = Object.assign({}, structs, (function () {
        var o = {}; o[kind] = structs[kind].filter(function (s) { return s.hp > 0 || !s.active; }); return o;
      })());
    });
    return Object.assign({}, state, { creeps: creeps, ledger: ledger, structures: structs, deadThisTick: dead });
  }

  // ================================================================== invader（system.invader・A7。戦略ではなく固定規則なのでここに置く）
  function invaderOrders(state) {
    var live = state.creeps.filter(function (c) { return c.owner === 'invader' && !c.spawning; });
    var acts = {};
    live.forEach(function (c) {
      var enemyStructs = S.allStructures(state).filter(function (s) { return s.owner === 'A' || s.owner === 'B'; });
      var target = S.nearest(c.pos, enemyStructs);
      if (!target) return;
      acts[c.id] = { action: 'attack', targetId: target.id, goalPos: target.pos, range: C.ATTACK_RANGE };
    });
    return { spawn: null, creepActions: acts, wallBuilds: [] };
  }
  function maybeSpawnInvaders(state, rand) {
    if (state.invadersDisabled) return state;
    var wavesWanted = Math.floor(state.cumHarvestBoth / C.INVADER_HARVEST_THRESHOLD);
    if (wavesWanted <= state.invaderWavesSpawned) return state;
    var edge = Math.floor(rand() * 4);
    var pos;
    if (edge === 0) pos = { x: 1 + Math.floor(rand() * (C.SIZE - 2)), y: 1 };
    else if (edge === 1) pos = { x: 1 + Math.floor(rand() * (C.SIZE - 2)), y: C.SIZE - 2 };
    else if (edge === 2) pos = { x: 1, y: 1 + Math.floor(rand() * (C.SIZE - 2)) };
    else pos = { x: C.SIZE - 2, y: 1 + Math.floor(rand() * (C.SIZE - 2)) };
    if (state.terrain[S.idx(pos.x, pos.y)] === 1) pos = findNearestPlain(state, pos);
    var seq = state.nextCreepSeq;
    var creeps = state.creeps;
    for (var i = 0; i < C.INVADER_WAVE_SIZE; i++) {
      creeps = creeps.concat([{
        id: 'invader-' + seq, owner: 'invader', pos: Object.assign({}, pos), body: C.INVADER_BODY.slice(),
        hp: S.bodyHp(C.INVADER_BODY), maxHp: S.bodyHp(C.INVADER_BODY), carry: 0, carryCap: 0,
        fatigue: 0, spawning: false, age: 0, birthTick: state.tick,
      }]);
      seq++;
    }
    return Object.assign({}, state, { creeps: creeps, nextCreepSeq: seq, invaderWavesSpawned: wavesWanted });
  }
  function findNearestPlain(state, p) {
    for (var r = 0; r < 5; r++) for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) {
      var x = p.x + dx, y = p.y + dy;
      if (S.inBounds(x, y) && state.terrain[S.idx(x, y)] === 0) return { x: x, y: y };
    }
    return p;
  }

  // ================================================================== 1ティックの解決（A6の順序）
  /**
   * 1ティック。**所有権の関門はここ1箇所**（ownership.js）。
   *
   * 入ってきた命令は、まず所有者ごとに `sanitizeOrders` を通る。通らなかった命令は捨てられ、
   * 理由が `state.rejectedOrders` に残る（本家の ERR_NOT_OWNER に対応。詳細は ownership.js 冒頭）。
   * そのあと `collectActs` が、**各 creep の行動をその creep の所有者のチャンネルからだけ**取り出す。
   * invader も1人の所有者として扱う——以前は B の命令へ相乗りさせていたが、
   * それだと「invader の命令」と「B の命令」が構造上区別できなかった。
   */
  function stepTick(ctx, ordersA, ordersB) {
    var state = ctx.state;
    state = phaseRegen(state);

    var cleanA = Own.sanitizeOrders(state, 'A', ordersA);
    var cleanB = Own.sanitizeOrders(state, 'B', ordersB);
    var rejected = cleanA.rejected.map(tag('A')).concat(cleanB.rejected.map(tag('B')));
    if (rejected.length) state = Object.assign({}, state, { rejectedOrders: state.rejectedOrders.concat(rejected) });

    state = phaseSpawn(state, cleanA.orders, cleanB.orders);
    state = phaseEconomy(state, cleanA.orders, cleanB.orders);

    var byOwner = { A: cleanA.orders, B: cleanB.orders, invader: invaderOrders(state) };
    byOwner.__acts = Own.collectActs(state, byOwner);

    state = phaseCombat(state, byOwner);
    state = phaseMove(state, ctx.pathCache, byOwner, ctx.rand, ctx.tieBreakMode);
    state = phaseDeath(state);
    state = maybeSpawnInvaders(state, ctx.rand);
    state = Object.assign({}, state, { tick: state.tick + 1 });
    return Object.assign({}, ctx, { state: state });
  }
  function tag(owner) { return function (r) { return Object.assign({ owner: owner }, r); }; }

  function createCtx(seed, opts) {
    opts = opts || {};
    return {
      state: S.createMatch(seed, opts),
      rand: S.rng((seed * 2654435761) >>> 0),
      pathCache: S.makePathCache(opts.pathfindInterval || C.DEFAULT_PATHFIND_INTERVAL),
      tieBreakMode: opts.tieBreakMode || 'seeded',
    };
  }

  var api = {
    phaseRegen: phaseRegen, phaseSpawn: phaseSpawn, phaseEconomy: phaseEconomy, phaseCombat: phaseCombat,
    phaseMove: phaseMove, phaseDeath: phaseDeath, stepToward: stepToward, towerFalloff: towerFalloff,
    invaderOrders: invaderOrders, maybeSpawnInvaders: maybeSpawnInvaders,
    stepTick: stepTick, createCtx: createCtx,
  };
  // core.js の primitives と1つの名前空間へ合流させる（循環require: core.js側がこのファイルをrequireし、
  // module.exports へ Object.assign する。ブラウザ側はここで window.S48 を直接拡張する）
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined' && window.S48) Object.assign(window.S48, api);
  if (typeof global !== 'undefined' && global && global.S48) Object.assign(global.S48, api);
})(typeof globalThis !== 'undefined' ? globalThis : this);
