/**
 * S-48 render — ゲームオブジェクトの外観と、選択したオブジェクトのプロパティ表。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  外観の出典（2026-09-16 ユーザ指示「本家のものに近づけよ」「外観から creep の仕様がわかること」）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * **body part の色は本家の公式文書がそのまま持っている。** 公式ドキュメントのソース
 * （github.com/screeps/docs の `source/creeps.md` と `api/source/Creep.md`）は、
 * 各 body part 名を **その part の色でスタイルして**書いている。記憶や推測ではなくそこから採った:
 *
 *     WORK #ffe56d / MOVE #a9b7c6 / CARRY #777 / ATTACK #f93842
 *     RANGED_ATTACK #5d80b2 / HEAL #65fd62 / TOUGH #fff /（CLAIM #b99cfb は本スケッチでは未使用）
 *
 * **creep の描き方**（円周に body part ごとの弧を置く）は本家クライアントの描画そのものが
 * 閉じているため、公式の描画を SVG で再現している既知の実装
 * （github.com/Spedwards/Screeps-SVG の `src/SVGCreep.js`）から規則を読み取った:
 *
 *   - creep は**円**。円周に body part ごとの弧を描き、**弧の長さは part 数 / 最大 part 数に比例**する
 *   - **MOVE の弧だけ下（180度）中心**、他の part は上（0度）中心
 *   - **CARRY は円周に描かない**
 *   - **TOUGH は弧ではなく、外周の半透明のリング**（不透明度 = TOUGH数 / 最大part数）
 *   - 弧は入れ子（累積長）で描く。長いものから描いて短いものを上に重ねる
 *
 * これにより**外観から creep の仕様（body 構成）が読み取れる**——ユーザ指示の眼目である。
 * 本スケッチ独自の追加は1点だけ: **内側の塗りを所有者の色にした**（本家は1部屋1プレイヤーなので
 * 所有者を色で分ける必要が薄いが、ここは1部屋に2人が同居するため所有者が一目で要る。ownership.js 参照）。
 *
 * structure の形は本家の見た目に寄せた近似である（spawn=大きい円、extension=小さい円、
 * tower=砲身つきの箱、controller=多角形とレベル表示、wall=角の丸い塗り、source=黄色の角丸四角）。
 * **形の細部までは本家の描画資産に到達できないので、再現ではなく近似である。**
 *
 * 依存ゼロ・古典スクリプト。ブラウザ専用（Node からは読まれない）。
 */
(function (global) {
  'use strict';
  var S = global.S48;
  var C = S.C;

  /** 本家の公式ドキュメントが body part 名に当てている色（出典は冒頭）。 */
  var PART_COLORS = {
    WORK: '#ffe56d', MOVE: '#a9b7c6', CARRY: '#777', ATTACK: '#f93842',
    RANGED_ATTACK: '#5d80b2', HEAL: '#65fd62', TOUGH: '#ffffff', CLAIM: '#b99cfb',
  };
  /** 円周に弧を描く part と、その描画順（本家と同じく CARRY は描かない・MOVE は別扱い・TOUGH は外周リング）。 */
  var RING_PARTS = ['WORK', 'ATTACK', 'RANGED_ATTACK', 'HEAL'];
  var MAX_PARTS = (C && C.MAX_PARTS) || 50;

  function ownerColor(owner) { return owner === 'A' ? '#5b9bff' : owner === 'B' ? '#ff6b6b' : '#9aa4b8'; }
  function countPart(body, p) { var n = 0; for (var i = 0; i < body.length; i++) if (body[i] === p) n++; return n; }

  /** screeps の角度（0度=上・時計回り）を canvas の角度へ。 */
  function rad(deg) { return (deg - 90) * Math.PI / 180; }

  /**
   * creep を描く。**外観から body 構成が読み取れること**が目的（ユーザ指示）。
   * r は円の半径。r が小さいときは弧が潰れるので、塗りつぶしの点に落とす（本家クライアントの
   * 遠景と同じ考え方——拡大すると仕様が読めるようになる）。
   */
  function drawCreep(g, c, cx, cy, r) {
    var body = c.body || [];
    var fill = c.spawning ? '#3a4152' : ownerColor(c.owner);

    if (r < 3.2) {   // 遠景: 所有者の色の点だけ
      g.fillStyle = fill;
      g.beginPath(); g.arc(cx, cy, Math.max(1.2, r), 0, 6.2832); g.fill();
      return;
    }

    // **分母は本家どおり「最大 part 数」**（2026-09-16 ユーザ指示で本家の仕様へ戻した）。
    // creep 自身の part 数で割ると円周が常に埋まってしまい、**大きい creep と小さい creep が
    // 同じ見た目になる**——本家が最大値で割るのは、弧の長さが「絶対量」を表すためである。
    // 本スケッチは C.MAX_PARTS を 10 にしてあるので（constants.js）、
    // 10 部品の creep でちょうど円周が埋まり、3 部品の creep はその 10 分の3 しか埋めない。
    // CARRY は弧を描かないので、その分だけ円周に隙間が空く（本家で CARRY を描かないのと同じ）。
    var denom = MAX_PARTS;

    // TOUGH: 外周の半透明リング（弧ではない）
    var tough = countPart(body, 'TOUGH');
    if (tough > 0) {
      g.globalAlpha = Math.max(0.18, Math.min(0.8, tough / MAX_PARTS));
      g.fillStyle = PART_COLORS.TOUGH;
      g.beginPath(); g.arc(cx, cy, r * 1.45, 0, 6.2832); g.fill();
      g.globalAlpha = 1;
    }

    // 本体
    g.fillStyle = fill;
    g.beginPath(); g.arc(cx, cy, r, 0, 6.2832); g.fill();
    g.strokeStyle = '#0a0d13'; g.lineWidth = Math.max(0.6, r * 0.14);
    g.beginPath(); g.arc(cx, cy, r, 0, 6.2832); g.stroke();

    // 円周の弧。長いものから描いて短いものを上に重ねる（入れ子）
    var lw = Math.max(1.1, r * 0.42);
    g.lineWidth = lw;
    var arcs = [], prev = 0, i;
    for (i = 0; i < RING_PARTS.length; i++) {
      var n = countPart(body, RING_PARTS[i]);
      if (n <= 0) continue;
      prev += n;
      arcs.push({ color: PART_COLORS[RING_PARTS[i]], span: prev / denom * 360, center: 0 });
    }
    var mv = countPart(body, 'MOVE');
    if (mv > 0) arcs.push({ color: PART_COLORS.MOVE, span: mv / denom * 360, center: 180 });
    arcs.sort(function (a, b) { return b.span - a.span; });
    for (i = 0; i < arcs.length; i++) {
      var a = arcs[i];
      var span = Math.min(360, a.span);   // 本家どおり下限を置かない（MAX_PARTS=10 なので 1 部品でも 36 度ある）
      g.strokeStyle = a.color;
      g.beginPath();
      g.arc(cx, cy, r, rad(a.center - span / 2), rad(a.center + span / 2));
      g.stroke();
    }

    // CARRY は円周に描かない（本家どおり）。代わりに積載があれば中心に小さな点を置く
    if (c.carry > 0) {
      g.fillStyle = '#ffe56d';
      g.beginPath(); g.arc(cx, cy, Math.max(1, r * 0.3), 0, 6.2832); g.fill();
    }
  }

  function energyRatio(obj, cap) { return cap > 0 ? Math.max(0, Math.min(1, (obj || 0) / cap)) : 0; }

  function drawSpawn(g, s, x, y, cell, fillRatio) {
    var cx = x + cell / 2, cy = y + cell / 2, r = cell * 0.48;
    g.fillStyle = '#15191f';
    g.beginPath(); g.arc(cx, cy, r, 0, 6.2832); g.fill();
    if (fillRatio > 0) {   // 中身のエネルギー（本家の spawn も黄色で満ち欠けする）
      g.fillStyle = '#ffe56d';
      g.beginPath(); g.arc(cx, cy, r * 0.72 * fillRatio, 0, 6.2832); g.fill();
    }
    g.strokeStyle = ownerColor(s.owner); g.lineWidth = Math.max(1.2, cell * 0.16);
    g.beginPath(); g.arc(cx, cy, r, 0, 6.2832); g.stroke();
  }

  function drawExtension(g, e, x, y, cell, fillRatio) {
    var cx = x + cell / 2, cy = y + cell / 2, r = cell * 0.3;
    g.fillStyle = e.active ? '#15191f' : '#20252e';
    g.beginPath(); g.arc(cx, cy, r, 0, 6.2832); g.fill();
    if (e.active && fillRatio > 0) {
      g.fillStyle = '#ffe56d';
      g.beginPath(); g.arc(cx, cy, r * 0.66 * fillRatio, 0, 6.2832); g.fill();
    }
    g.strokeStyle = e.active ? ownerColor(e.owner) : '#3a4152'; g.lineWidth = Math.max(0.9, cell * 0.11);
    g.beginPath(); g.arc(cx, cy, r, 0, 6.2832); g.stroke();
  }

  function drawTower(g, t, x, y, cell, fillRatio) {
    var cx = x + cell / 2, cy = y + cell / 2, r = cell * 0.44;
    g.fillStyle = t.active ? '#222831' : '#20252e';
    g.beginPath(); g.arc(cx, cy, r, 0, 6.2832); g.fill();
    if (t.active && fillRatio > 0) {   // タンク（本家の tower も下部が黄色く満ちる）
      g.fillStyle = '#ffe56d';
      g.fillRect(cx - r * 0.62, cy + r * 0.1, r * 1.24, r * 0.5 * fillRatio + 1);
    }
    g.fillStyle = t.active ? '#aab2c0' : '#454c5a';   // 砲身
    g.fillRect(cx - r * 0.24, cy - r * 0.95, r * 0.48, r * 0.85);
    g.strokeStyle = t.active ? ownerColor(t.owner) : '#3a4152'; g.lineWidth = Math.max(1, cell * 0.13);
    g.beginPath(); g.arc(cx, cy, r, 0, 6.2832); g.stroke();
  }

  /** controller: 本家と同じく多角形＋レベルの目盛り。 */
  function drawController(g, c, x, y, cell, level) {
    var cx = x + cell / 2, cy = y + cell / 2, r = cell * 0.46, i;
    g.fillStyle = '#1b2029';
    g.beginPath();
    for (i = 0; i < 8; i++) {
      var a = rad(i * 45 + 22.5);
      var px = cx + r * Math.cos(a), py = cy + r * Math.sin(a);
      if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.closePath(); g.fill();
    g.strokeStyle = ownerColor(c.owner); g.lineWidth = Math.max(1.2, cell * 0.15); g.stroke();
    if (cell >= 9) {   // レベルの目盛り（本家は外周のセグメントで RCL を示す）
      g.fillStyle = '#e8edf5';
      g.font = 'bold ' + Math.round(cell * 0.5) + 'px ui-monospace,Menlo,monospace';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(level || 1), cx, cy + cell * 0.02);
      g.textAlign = 'start'; g.textBaseline = 'alphabetic';
    }
  }

  function drawWall(g, w, x, y, cell) {
    var ratio = w.maxHp > 0 ? Math.max(0.12, Math.min(1, w.hp / w.maxHp)) : 1;
    g.fillStyle = w.active ? '#5a6272' : '#33394a';
    g.globalAlpha = w.active ? 0.35 + 0.65 * ratio : 0.5;
    g.fillRect(x + cell * 0.08, y + cell * 0.08, cell * 0.84, cell * 0.84);
    g.globalAlpha = 1;
  }

  function drawSource(g, s, x, y, cell) {
    var ratio = energyRatio(s.energy, C.SOURCE_CAPACITY);
    g.fillStyle = '#4a4222';
    g.fillRect(x + cell * 0.1, y + cell * 0.1, cell * 0.8, cell * 0.8);
    g.fillStyle = '#e8c744';
    var h = cell * 0.8 * ratio;
    g.fillRect(x + cell * 0.1, y + cell * 0.9 - h, cell * 0.8, h);
  }

  // ─────────────────────────────────────────────────────── 選択とプロパティ表
  /**
   * 盤面の座標にあるオブジェクトを1つ返す。creep を最優先（本家のクリックも creep が優先される）。
   * 返すのは { kind, obj }。
   */
  function pick(state, x, y) {
    var i, c;
    for (i = 0; i < state.creeps.length; i++) {
      c = state.creeps[i];
      if (c.pos.x === x && c.pos.y === y) return { kind: 'creep', obj: c };
    }
    var kinds = [['spawns', 'spawn'], ['towers', 'tower'], ['extensions', 'extension'],
      ['controllers', 'controller'], ['walls', 'wall']];
    for (i = 0; i < kinds.length; i++) {
      var arr = state.structures[kinds[i][0]];
      for (var j = 0; j < arr.length; j++) {
        if (arr[j].pos.x === x && arr[j].pos.y === y) return { kind: kinds[i][1], obj: arr[j] };
      }
    }
    for (i = 0; i < state.sources.length; i++) {
      if (state.sources[i].pos.x === x && state.sources[i].pos.y === y) return { kind: 'source', obj: state.sources[i] };
    }
    if (state.terrain[S.idx(x, y)] === 1) return { kind: 'terrain', obj: { pos: { x: x, y: y }, type: 'wall' } };
    return { kind: 'terrain', obj: { pos: { x: x, y: y }, type: 'plain' } };
  }

  function bodyBreakdown(body) {
    var order = ['TOUGH', 'WORK', 'CARRY', 'MOVE', 'ATTACK', 'RANGED_ATTACK', 'HEAL'], out = [];
    for (var i = 0; i < order.length; i++) {
      var n = countPart(body, order[i]);
      if (n > 0) out.push({ part: order[i], n: n, color: PART_COLORS[order[i]] });
    }
    return out;
  }

  /**
   * 選択したオブジェクトのプロパティ。**欄の名前は本家の API ドキュメントに合わせる**
   * （docs.screeps.com の Creep / StructureSpawn / StructureExtension / StructureTower /
   *  StructureController / StructureWall / Source の各プロパティ）。
   * 本スケッチに無いプロパティは並べない——**無いものを「0」と書くと、有るが空なのか無いのかが混ざる**。
   */
  function describe(sel, state, viewerOwner) {
    var o = sel.obj, rows = [], p = state.players;
    function row(k, v) { rows.push({ k: k, v: String(v) }); }
    function ownerRow(obj) {
      row('owner', obj.owner === undefined || obj.owner === null ? '(なし・中立)' : obj.owner);
      if (viewerOwner) row('my', obj.owner === viewerOwner ? 'true' : 'false');
    }
    if (sel.kind === 'creep') {
      row('id', o.id); ownerRow(o);
      row('pos', '[' + o.pos.x + ',' + o.pos.y + ']');
      row('hits / hitsMax', o.hp + ' / ' + o.maxHp);
      row('store[energy] / capacity', o.carry + ' / ' + o.carryCap);
      row('fatigue', o.fatigue);
      row('spawning', o.spawning ? 'true' : 'false');
      row('age（生成からのティック）', o.age);
      return { title: 'Creep', rows: rows, body: bodyBreakdown(o.body), note: 'body の構成は左の外観そのものである（円周の弧＝part、下の弧＝MOVE、外周の白いリング＝TOUGH）' };
    }
    if (sel.kind === 'spawn') {
      row('id', o.id); ownerRow(o);
      row('pos', '[' + o.pos.x + ',' + o.pos.y + ']');
      row('hits / hitsMax', o.hp + ' / ' + o.maxHp);
      var pl = p[o.owner];
      row('store[energy] / capacity', (pl ? pl.energy : 0) + ' / ' + (pl ? pl.capacity : 0));
      row('spawning', pl && pl.spawning ? ('残り ' + pl.spawning.ticksLeft + 'ティック') : 'null');
      return { title: 'StructureSpawn', rows: rows,
        note: '**store はこの spawn 単体ではなく、所有者の spawn+extension を合算した pool である**（S2 が決めた簡略化。個々の extension への配達動線を持たない）' };
    }
    if (sel.kind === 'extension') {
      row('id', o.id); ownerRow(o);
      row('pos', '[' + o.pos.x + ',' + o.pos.y + ']');
      row('hits / hitsMax', o.hp + ' / ' + o.maxHp);
      row('active（RCLで解禁済みか）', o.active ? 'true' : 'false');
      return { title: 'StructureExtension', rows: rows, note: 'エネルギーは所有者の pool に合算されるため、この個体には store が無い' };
    }
    if (sel.kind === 'tower') {
      row('id', o.id); ownerRow(o);
      row('pos', '[' + o.pos.x + ',' + o.pos.y + ']');
      row('hits / hitsMax', o.hp + ' / ' + o.maxHp);
      row('active（RCLで解禁済みか）', o.active ? 'true' : 'false');
      return { title: 'StructureTower', rows: rows,
        note: '射程に上限は無く、距離で威力が落ちる（本家どおり。TOWER_OPTIMAL_RANGE ' + C.TOWER_OPTIMAL_RANGE + ' 以内で等倍、' + C.TOWER_FALLOFF_RANGE + ' 以遠で ' + C.TOWER_FALLOFF_RETAIN + ' 倍）' };
    }
    if (sel.kind === 'controller') {
      row('id', o.id); ownerRow(o);
      row('pos', '[' + o.pos.x + ',' + o.pos.y + ']');
      var pc = p[o.owner];
      row('level（RCL）', pc ? pc.rcl : o.rcl);
      // RCL_THRESHOLD[k] = RCL(k+1) に必要な累積投入量。いま RCL r なら次に要るのは添字 r
      var lvl = pc ? pc.rcl : (o.rcl || 1);
      var need = C.RCL_THRESHOLD[lvl];
      row('progress / progressTotal', (o.progress || 0) + ' / ' + (need === undefined ? '—（RCL上限）' : need));
      return { title: 'StructureController', rows: rows,
        note: '**本家の Room.controller は1ルームに1つだが、この部屋には2つある**（ルームを1つに畳んだ帰結）。スクリプトから見えるのは自分のものだけで、相手の controller は操作できない（ownership.js）' };
    }
    if (sel.kind === 'wall') {
      row('id', o.id); ownerRow(o);
      row('pos', '[' + o.pos.x + ',' + o.pos.y + ']');
      row('hits / hitsMax', o.hp + ' / ' + o.maxHp);
      row('active（建設完了）', o.active ? 'true' : 'false');
      return { title: 'StructureWall', rows: rows, note: '最大 hits は ' + C.WALL_MAX_HITS + '（本家の 300,000,000 では 3,000 ティックで実質無敵になるため縮めた）' };
    }
    if (sel.kind === 'source') {
      row('id', o.id);
      row('owner', '(なし・中立)');
      row('pos', '[' + o.pos.x + ',' + o.pos.y + ']');
      row('energy / energyCapacity', o.energy + ' / ' + C.SOURCE_CAPACITY);
      row('ticksToRegeneration', Math.max(0, o.nextRegen - state.tick));
      return { title: 'Source', rows: rows, note: '中立。どちらのプレイヤーも採取できる（本家どおり）' };
    }
    row('pos', '[' + o.pos.x + ',' + o.pos.y + ']');
    row('terrain', o.type);
    return { title: 'Terrain', rows: rows, note: '地形は plain と wall の2種のみ（swamp は落とした）' };
  }

  var api = {
    PART_COLORS: PART_COLORS, ownerColor: ownerColor, energyRatio: energyRatio,
    drawCreep: drawCreep, drawSpawn: drawSpawn, drawExtension: drawExtension,
    drawTower: drawTower, drawController: drawController, drawWall: drawWall, drawSource: drawSource,
    pick: pick, describe: describe, bodyBreakdown: bodyBreakdown,
  };
  if (typeof window !== 'undefined') window.S48Render = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
