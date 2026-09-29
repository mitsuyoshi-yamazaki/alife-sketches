/**
 * S-48 ownership — **1部屋に複数プレイヤーが同居することの帰結を1箇所に閉じ込める層**。
 *
 * ═══════════════════════════════════════════════════════════════════════════
 *  この層が存在する理由（2026-09-16 ユーザ指示。**今後の実装で失われてはならない**）
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 本スケッチは「ルームは一つ・ルーム間の移動は無し」という簡略化（A1）を採った。ユーザはこの簡略化を
 * 承認しているが、**その帰結として本家 screeps と食い違う点が2つ生まれる**ことを指摘した:
 *
 *   ①**1つのルームに複数プレイヤーの structure が同居する**
 *     本家では spawn / extension / tower は自分のルームにしか建たない。ここでは A と B の
 *     structure が同じ 50×50 に混在する。
 *   ②**roomController が複数存在する**
 *     本家の `Room.controller` は**1ルームに1つ**であり、その所有者がそのルームの所有者である。
 *     ここでは A と B がそれぞれ controller を持つため、`room.controller` は一意に定まらない。
 *
 * **この2点があるため、「プレイヤーのスクリプトが structure をどう取得するか」を本家のまま放置できない。**
 * 放置すると (a) 相手の structure を自分のものとして拾ってしまう (b) 相手のオブジェクトを操作できてしまう。
 *
 * ── 解決（本家の語彙に合わせた形） ──────────────────────────────────────────
 *
 * 本家 screeps は既にこの区別のための語彙を持っている。`FIND_MY_STRUCTURES` と
 * `FIND_HOSTILE_STRUCTURES`、および各オブジェクトの `my` プロパティである。
 * **したがって本スケッチは新しい概念を発明せず、その語彙をそのまま使う**:
 *
 *   - `viewFor(state, owner)` が**唯一の取得経路**である。bot は `state` を直に読まない
 *   - `view.my.*` は自分のもの、`view.hostile.*` は他プレイヤーのもの
 *   - **`view.my.controller` は単数**（本家の `room.controller` に対応）。
 *     他プレイヤーの controller は `view.hostile.controllers` からしか見えない
 *   - 取得できること（見えること）と、操作できること（命令できること）は別である。
 *     本家でも敵の structure は `FIND_HOSTILE_STRUCTURES` で見えるが操作はできない
 *
 *   - `sanitizeOrders(state, owner, orders)` が**唯一の命令経路**である。
 *     ここを通らない命令は `stepTick` に届かない。所有権に反する命令は**黙って捨てず、
 *     捨てた事実を `rejected` として返す**（本家がエラーコード ERR_NOT_OWNER を返すのに対応する）
 *
 *   - `collectActs` は、**creep の行動をその creep の所有者のチャンネルからしか取らない**。
 *     以前は A と B の命令を1つのオブジェクトへ Object.assign で混ぜていたため、
 *     (a) 相手の creep への命令が原理的に通り (b) id が衝突すれば後勝ちで上書きされた。
 *     **id が衝突しない現在の命名規則に依存した安全性**でしかなかったので、構造で閉じた
 *
 * ── 今後この層を触る人へ ────────────────────────────────────────────────────
 *
 * **ルームを複数にする日が来たら、この層は不要になるのではなく、逆に本家へ近づく形で書き換わる**
 * （`view.my.controller` が「そのルームの controller」になり、hostile 側は別ルームへ移る）。
 * **ルームが1つである限り、上の①②は消えない。** 消えていないことを selftest が毎回確かめる。
 *
 * 依存ゼロ・古典スクリプト。Node と ブラウザで共用。
 */
(function (global) {
  'use strict';
  var S = (typeof require !== 'undefined') ? require('./core.js') : global.S48;

  var PLAYERS = ['A', 'B'];

  /** 中立（誰のものでもない）オブジェクトの owner 値。source は誰のものでもない。 */
  function isNeutral(obj) { return !obj || obj.owner === undefined || obj.owner === null; }

  /**
   * 本家の `my` プロパティに対応する。invader は「プレイヤーでない敵」なので、
   * どのプレイヤーから見ても my ではない。
   */
  function isMine(obj, owner) { return !!obj && obj.owner === owner; }

  /**
   * 所有者つきの視界。**bot はこれ以外から state を読まない。**
   *
   * 配列の順序は `state` の配列順をそのまま保つ（filter は順序を保存する）。
   * **順序は観測結果に効く**——`S.nearest` の同点は先頭勝ちなので、ここで並べ替えると
   * 既存の生ログが再現しなくなる。並べ替えたくなったら selftest のハッシュ回帰が止める。
   */
  function viewFor(state, owner) {
    var st = state.structures;
    var view;
    function mine(arr) { return arr.filter(function (s) { return s.owner === owner; }); }
    function hostile(arr) { return arr.filter(function (s) { return s.owner !== owner && !isNeutral(s); }); }
    var myCreeps = state.creeps.filter(function (c) { return c.owner === owner; });
    var hostileCreeps = state.creeps.filter(function (c) { return c.owner !== owner && !isNeutral(c); });
    var player = state.players[owner];
    view = {
      owner: owner,
      tick: state.tick,
      terrain: state.terrain,
      sources: state.sources,          // 中立。誰でも採取できる（本家どおり）
      my: {
        creeps: myCreeps,
        spawns: mine(st.spawns),
        extensions: mine(st.extensions),
        towers: mine(st.towers),
        walls: mine(st.walls),
        // **単数**。本家の room.controller に対応する（この部屋には複数あるが、自分のものは1つ）
        controller: mine(st.controllers)[0] || null,
        energy: player ? player.energy : 0,
        energyCapacity: player ? player.capacity : 0,
        rcl: player ? player.rcl : 0,
      },
      hostile: {
        creeps: hostileCreeps,         // 他プレイヤー + invader
        spawns: hostile(st.spawns),
        extensions: hostile(st.extensions),
        towers: hostile(st.towers),
        walls: hostile(st.walls),
        controllers: hostile(st.controllers),   // **複数形**。本家には無い概念なので単数にしない
      },
    };
    // 種別を混ぜた一覧は `S.allStructures` の順序で作る。**種別ごとの配列を concat した順序とは違う**——
    // `S.nearest` の同点は先頭勝ちなので、順序を変えると既存の生ログが再現しなくなる（selftest が止める）
    var all = S.allStructures(state);
    view.my.structures = all.filter(function (s) { return s.owner === owner; });
    view.hostile.structures = all.filter(function (s) { return s.owner !== owner && !isNeutral(s); });
    return view;
  }

  /**
   * negativeControls[2]（相手が見えない bot）のための、**世界そのものを検閲した state**。
   *
   * `viewFor` とは別物である——`viewFor` は「誰のものか」で仕分けるだけで世界は丸ごと見えているが、
   * こちらは **相手プレイヤーを世界から消した state** を作る（invader は残す）。
   * bot へ渡る前段で state を作り替えるので、所有権の層に置く（bots.js は state を直読みしない）。
   */
  function censorHostile(state, owner) {
    var enemy = owner === 'A' ? 'B' : 'A';
    function drop(arr) { return arr.filter(function (s) { return s.owner !== enemy; }); }
    var st = state.structures;
    return Object.assign({}, state, {
      creeps: state.creeps.filter(function (c) { return c.owner !== enemy; }),
      structures: {
        spawns: drop(st.spawns), extensions: drop(st.extensions), towers: drop(st.towers),
        walls: drop(st.walls), controllers: drop(st.controllers),
      },
    });
  }

  /**
   * 命令1つが所有権の規則に反していないかを見る。反していれば理由の文字列、問題なければ null。
   *
   * 規則は本家の「何を誰に対してできるか」をそのまま写したものである:
   *   harvest              → source（中立）にのみ
   *   deliver / upgrade / build → **自分の** structure にのみ
   *   attack / rangedAttack     → **自分以外の**オブジェクトにのみ（本家も自分の物は殴れない）
   *   heal                 → **自分の** creep にのみ（本家では creep 以外は治せない）
   */
  function checkAction(state, owner, order) {
    if (!order || !order.action) return null;
    var a = order.action;
    if (a === 'attack' && !order.targetId) return null;   // 「敵spawnの方向へ進軍」だけの命令（目標なし）
    var target = S.findById(state, order.targetId);
    if (!target) return null;   // 対象が既に消えている。所有権の違反ではない（tick 側が無視する）

    if (a === 'harvest') {
      return isNeutral(target) ? null : '中立でない対象を harvest しようとした';
    }
    if (a === 'deliver' || a === 'upgrade' || a === 'build') {
      return isMine(target, owner) ? null : '自分のものでない structure へ ' + a + ' しようとした';
    }
    if (a === 'attack' || a === 'rangedAttack') {
      return isMine(target, owner) ? '自分のオブジェクトを ' + a + ' しようとした' : null;
    }
    if (a === 'heal') {
      var isCreep = state.creeps.some(function (c) { return c.id === target.id; });
      if (!isCreep) return 'creep でない対象を heal しようとした';
      return isMine(target, owner) ? null : '自分のものでない creep を heal しようとした';
    }
    return null;
  }

  /**
   * **唯一の命令経路。** 所有権に反する命令を取り除き、取り除いた理由を `rejected` に残す。
   *
   * 本家の API がエラーコード（ERR_NOT_OWNER など）を返すのに対応する。黙って捨てないのは、
   * 「捨てられていること」自体が観測できないと、bot の欠陥と規則の欠陥を区別できないためである。
   */
  function sanitizeOrders(state, owner, orders) {
    orders = orders || {};
    var rejected = [];
    var acts = orders.creepActions || {};
    var clean = {};

    Object.keys(acts).forEach(function (id) {
      var creep = state.creeps.filter(function (c) { return c.id === id; })[0];
      if (!creep) { rejected.push({ id: id, why: '存在しない creep への命令' }); return; }
      if (creep.owner !== owner) { rejected.push({ id: id, why: '他プレイヤーの creep への命令' }); return; }
      var why = checkAction(state, owner, acts[id]);
      if (why) { rejected.push({ id: id, why: why }); return; }
      clean[id] = acts[id];
    });

    // 壁の着工は自分の領分にしか無い（tick 側が owner を付けて建てる）。spawn 要求も同様に
    // 「自分の spawn へ」しか出せない——processSpawn が owner から自分の spawn を引くので、
    // ここでは要求の形だけを確かめる
    var spawn = orders.spawn || null;
    if (spawn && spawn.owner && spawn.owner !== owner) {
      rejected.push({ id: 'spawn', why: '他プレイヤーの spawn への生成要求' });
      spawn = null;
    }

    return {
      orders: { spawn: spawn, creepActions: clean, wallBuilds: orders.wallBuilds || [] },
      rejected: rejected,
    };
  }

  /**
   * creep ごとの行動を、**その creep の所有者のチャンネルからだけ**取り出す。
   *
   * `ordersByOwner` は { A: orders, B: orders, invader: orders } の形。
   * ここが構造上の要である——以前の `Object.assign(ordersA, ordersB)` は
   * 「id が衝突しないから安全」でしかなく、規則としては相手の creep を動かせた。
   */
  function collectActs(state, ordersByOwner) {
    var acts = {};
    state.creeps.forEach(function (c) {
      var channel = ordersByOwner[c.owner];
      if (!channel) return;
      var o = (channel.creepActions || {})[c.id];
      if (o) acts[c.id] = o;
    });
    return acts;
  }

  var api = {
    PLAYERS: PLAYERS,
    isMine: isMine, isNeutral: isNeutral,
    viewFor: viewFor, censorHostile: censorHostile, checkAction: checkAction,
    sanitizeOrders: sanitizeOrders, collectActs: collectActs,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.S48Own = api;
  if (typeof global !== 'undefined' && global && !global.S48Own) global.S48Own = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
