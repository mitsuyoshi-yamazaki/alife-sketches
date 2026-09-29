/**
 * S-48 match — 2 bot・1シードの1試合を頭から終わりまで走らせる。
 *
 * 勝敗判定（criteria.knobs.winCriterion 主=征服基準）と tiebreak（criteria.decisionRule）、
 * A10（terminalは出力のみ）のログ生成、whatSeedChanges が要求する「全ティックログのハッシュ」の
 * 収集をここで行う。bot の戦略には触れない（bots.js）。
 *
 * 依存ゼロ・古典スクリプト。Node と ブラウザで共用。
 */
(function (global) {
  'use strict';
  var S = (typeof require !== 'undefined') ? require('./core.js') : global.S48;
  var Bots = (typeof require !== 'undefined') ? require('./bots.js') : global.S48Bots;
  var C = S.C;

  function spawnOf(state, owner) { return state.structures.spawns.filter(function (s) { return s.owner === owner; })[0]; }
  function aliveCount(state, owner) { return state.creeps.filter(function (c) { return c.owner === owner; }).length; }

  /**
   * 征服基準（主）の勝者。capped=true のときは呼ばない（tiebreakへ）。
   * loserOwner はスポーンを失い残存creepも尽きた側。
   */
  function conquestWinner(loserOwner) { return loserOwner === 'A' ? 'B' : 'A'; }

  /** tieHandling: controller累積進捗 → 累積採取量 → bot ID辞書順（criteria.decisionRule）。 */
  function tiebreakWinner(state, botAId, botBId) {
    var pa = state.players.A, pb = state.players.B;
    if (pa.controllerProgress !== pb.controllerProgress) return pa.controllerProgress > pb.controllerProgress ? 'A' : 'B';
    if (pa.harvested !== pb.harvested) return pa.harvested > pb.harvested ? 'A' : 'B';
    return botAId <= botBId ? 'A' : 'B';
  }

  /** knobs.winCriterion の副（累積基準）: 採取量+建設コストの多寡。同じ量の別の測り方（K-48の感度比）。 */
  function cumulativeWinner(state, botAId, botBId) {
    var a = state.players.A.harvested + state.players.A.builtCost;
    var b = state.players.B.harvested + state.players.B.builtCost;
    if (a !== b) return a > b ? 'A' : 'B';
    return botAId <= botBId ? 'A' : 'B';
  }

  function bodyVector(partSpend) {
    var work = partSpend.WORK, carryMove = partSpend.CARRY + partSpend.MOVE, atk = partSpend.ATTACK,
      ranged = partSpend.RANGED_ATTACK, heal = partSpend.HEAL, tough = partSpend.TOUGH;
    var total = work + carryMove + atk + ranged + heal + tough;
    if (total <= 0) return [0, 0, 0, 0, 0, 0];
    return [work, carryMove, atk, ranged, heal, tough].map(function (v) { return v / total; });
  }

  /**
   * 1試合。opts: maxTicks, pathfindInterval, combatDisabled, invadersDisabled, blind, tieBreakMode,
   * winCriterion('conquest'|'cumulative'), collectHashes(bool. デフォルトtrue), statusEvery(既定100)。
   */
  function runMatch(seed, botA, botB, opts) {
    opts = opts || {};
    var maxTicks = opts.maxTicks || C.DEFAULT_MAX_TICKS;
    var ctx = S.createCtx(seed, {
      pathfindInterval: opts.pathfindInterval || C.DEFAULT_PATHFIND_INTERVAL,
      combatDisabled: !!opts.combatDisabled, invadersDisabled: !!opts.invadersDisabled,
      tieBreakMode: opts.tieBreakMode || 'seeded',
    });
    // selftest 専用: 初期状態を作った直後に差し替える（positiveControls[3] 「支配を埋め込んだ対戦」用など）
    if (opts.mapPatch) ctx = Object.assign({}, ctx, { state: opts.mapPatch(ctx.state) });
    var collectHashes = opts.collectHashes !== false;
    var statusEvery = opts.statusEvery || 100;
    var tickHashes = [], statusLog = [], capped = true, loserOwner = null, t;

    for (t = 0; t < maxTicks; t++) {
      var state = ctx.state;
      var viewA = opts.blind ? Bots.blindView(state, 'A') : state;
      var viewB = opts.blind ? Bots.blindView(state, 'B') : state;
      var ordersA = Bots.decide(viewA, 'A', botA);
      var ordersB = Bots.decide(viewB, 'B', botB);
      ctx = S.stepTick(ctx, ordersA, ordersB);
      if (collectHashes) tickHashes.push(S.stateHash(ctx.state));
      if (ctx.state.tick % statusEvery === 0) statusLog.push(statusLine(ctx.state));

      var sA = spawnOf(ctx.state, 'A'), sB = spawnOf(ctx.state, 'B');
      if (sA.hp <= 0 && aliveCount(ctx.state, 'A') === 0) { capped = false; loserOwner = 'A'; break; }
      if (sB.hp <= 0 && aliveCount(ctx.state, 'B') === 0) { capped = false; loserOwner = 'B'; break; }
    }

    var finalState = ctx.state;
    var winner = capped ? tiebreakWinner(finalState, botA.id, botB.id) : conquestWinner(loserOwner);
    var winnerCumulative = capped ? cumulativeWinner(finalState, botA.id, botB.id) : conquestWinner(loserOwner);

    var ledgerCheck = S.energyLedgerCheck(finalState);
    var log = statusLog.concat(finalState.log);

    return {
      seed: seed, botA: botA.id, botB: botB.id, ticks: finalState.tick, capped: capped, loserOwner: loserOwner,
      winner: winner, winnerCumulative: winnerCumulative, winnerAgree: winner === winnerCumulative,
      rclA: finalState.players.A.rcl, rclB: finalState.players.B.rcl,
      harvestedA: finalState.players.A.harvested, harvestedB: finalState.players.B.harvested,
      controllerProgressA: finalState.players.A.controllerProgress, controllerProgressB: finalState.players.B.controllerProgress,
      spawnDeniedA: finalState.players.A.spawnDenied, spawnDeniedB: finalState.players.B.spawnDenied,
      population: S.populationCounts(finalState),
      bodyVectorA: bodyVector(finalState.players.A.partSpend), bodyVectorB: bodyVector(finalState.players.B.partSpend),
      // 所有権に反して捨てられた命令の件数（ownership.js）。既定のbotでは常に0であるべきで、
      // 0でなくなったら bot か規則のどちらかが壊れている
      rejectedOrders: finalState.rejectedOrders.length,
      finalHash: S.stateHash(finalState), tickHashes: tickHashes,
      ledgerOk: ledgerCheck.ok, ledger: ledgerCheck,
      log: log,
    };
  }

  function statusLine(state) {
    return 't=' + state.tick + ' RCL A=' + state.players.A.rcl + ' B=' + state.players.B.rcl +
      ' creeps A=' + aliveCount(state, 'A') + ' B=' + aliveCount(state, 'B') + ' invaders=' + aliveCount(state, 'invader') +
      ' harvested A=' + state.players.A.harvested + ' B=' + state.players.B.harvested;
  }

  var api = { runMatch: runMatch, bodyVector: bodyVector, tiebreakWinner: tiebreakWinner, cumulativeWinner: cumulativeWinner };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.S48Match = api;
  if (typeof global !== 'undefined' && global && !global.S48Match) global.S48Match = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
