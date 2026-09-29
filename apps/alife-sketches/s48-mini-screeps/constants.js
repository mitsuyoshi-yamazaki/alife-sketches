/**
 * S-48 定数 — borrowedConstants（criteria.json）をそのまま数値化したもの、および
 * S2 が自分で決めた値（未登録の箇所。README「自分で決めた実装上の判断」参照）。
 *
 * 依存ゼロ・古典スクリプト。Node と ブラウザで共用。
 */
(function (global) {
  'use strict';

  var C = {
    SIZE: 50,

    // -------- body part（borrowedConstants.bodyPartCost / creepMechanics）
    PART_COST: { MOVE: 50, WORK: 100, CARRY: 50, ATTACK: 80, RANGED_ATTACK: 150, HEAL: 250, TOUGH: 10 },
    HITS_PER_PART: 100,
    LIFE_TIME: 1500,
    SPAWN_TICKS_PER_PART: 3,
    // **本家は MAX_CREEP_SIZE=50。本スケッチは 10 とする**（2026-09-16 ユーザ指示
    // 「本家の仕様である『最大body parts数50』は本スケッチに対しては多いため、最大body parts数は10とせよ」）。
    // これは描画の都合ではなく**ゲーム規則そのものの変更**であり、2つの帰結を持つ:
    //   ①**観測結果が変わる**。v1.0.0 で走らせた 1,350 試合の生ログはこの版では再現しない
    //   ②`criteria.json` は MAX_CREEP_SIZE=50 で事前登録されている（system.creep / ceilings）。
    //     **事前登録は改変しない**（sha256 が summary.json に刻まれている）ので、
    //     この版は登録とずれた状態にある。どう畳むかは Q-61 で扱う
    // 本家の描画規則「弧の長さ = part 数 / 最大 part 数」は render.js がこの定数を割り算に使う——
    // **分母は本家どおり「最大 part 数」であり、creep 自身の part 数ではない**
    MAX_PARTS: 10,
    CARRY_CAPACITY: 50,

    // -------- spawn のエネルギー自動再生（本家の仕様。2026-09-16 ユーザ指示で追加）
    // 公式文書 StructureSpawn:「1 energy unit per tick while energy available in the room
    // (in all spawns and extensions) is less than 300」。無いと働き手が全滅した時点で詰む
    SPAWN_ENERGY_REGEN_THRESHOLD: 300,
    SPAWN_ENERGY_REGEN_PER_TICK: 1,

    // -------- action power（borrowedConstants.actionPowers）
    HARVEST_POWER: 2,
    UPGRADE_POWER: 1,
    BUILD_POWER: 5,
    REPAIR_POWER: 100,
    ATTACK_POWER: 30,
    RANGED_ATTACK_POWER: 10,
    HEAL_POWER: 12,
    RANGED_HEAL_POWER: 4,
    RANGED_ATTACK_RANGE: 3,
    ATTACK_RANGE: 1,
    HEAL_RANGE: 1,
    RANGED_HEAL_RANGE: 3,

    // -------- energySource（borrowedConstants.sourceEnergy）
    SOURCE_CAPACITY: 3000,
    SOURCE_REGEN_TIME: 300,
    HARVEST_RANGE: 1,

    // -------- tower（borrowedConstants.towerSpec）
    TOWER_CAPACITY: 1000,
    TOWER_ACTION_COST: 10,
    TOWER_ATTACK: 600,
    TOWER_HEAL: 400,
    TOWER_REPAIR: 800,
    TOWER_OPTIMAL_RANGE: 5,
    TOWER_FALLOFF_RANGE: 20,
    TOWER_FALLOFF_RETAIN: 0.25, // 「射程20で減衰係数0.75まで線形に低下」= 25%まで減衰

    // -------- spawn / extension（borrowedConstants.spawnAndExtensionCapacity）
    SPAWN_ENERGY_CAPACITY: 300,
    EXTENSION_ENERGY_CAPACITY: 50,

    // -------- RCL（borrowedConstants.rclProgressionRatio / structureUnlockOrder, system.rcl）
    RCL_THRESHOLD: [0, 200, 900, 2700, 8100], // 添字0=RCL1(常に達成), 添字k=RCL(k+1)に必要な累積投入量
    RCL_MAX: 5,
    EXTENSIONS_AT_RCL: [0, 5, 10, 20, 30],    // 添字0=RCL1
    TOWERS_AT_RCL: [0, 0, 1, 1, 2],           // 添字0=RCL1

    // -------- ceilings（criteria.json ceilings）
    MAX_CREEP_ENERGY: 1800,
    WALL_MAX_HITS: 30000,
    DEFAULT_PATHFIND_INTERVAL: 10,
    DEFAULT_MAX_TICKS: 3000,

    // -------- invader（system.invader, _comment A7）
    INVADER_HARVEST_THRESHOLD: 1500,
    INVADER_WAVE_SIZE: 3,
    INVADER_BODY: ['TOUGH', 'ATTACK', 'ATTACK', 'MOVE', 'MOVE'], // S2 が決めた（criteria未登録）

    // -------- S2 が自分で決めた構造物のhpと建設コスト（criteria未登録。README参照）
    SPAWN_MAX_HP: 5000,
    EXTENSION_MAX_HP: 1000,
    EXTENSION_BUILD_COST: 50,
    TOWER_MAX_HP: 3000,
    TOWER_BUILD_COST: 1000,
    CONTROLLER_UPGRADE_RANGE: 3,
    BUILD_RANGE: 3,
    REPAIR_RANGE: 3,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = C;
  if (typeof window !== 'undefined') window.S48C = C;
  if (typeof global !== 'undefined' && global && !global.S48C) global.S48C = C;
})(typeof globalThis !== 'undefined' ? globalThis : this);
