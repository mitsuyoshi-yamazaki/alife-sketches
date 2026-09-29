/**
 * S-39 核 — λ 項・β 簡約・容器。
 *
 * ここには上位概念の語彙を置かない。核が知っているのは
 *   「項」「簡約」「正規形」「容器」「2 つ引いて作用させて戻す」
 * だけである。organization / alive / gene / catalyst / fitness / self-maintaining /
 * autocatalytic は識別子にも分岐にも出てこない（それらは observe.js の語彙）。
 *
 * 依存ゼロ・古典スクリプト。Node（module.exports）とブラウザ（window.S39）で共用する。
 */
(function (global) {
  'use strict';

  // ------------------------------------------------------------------ 乱数

  /** mulberry32。同じ種で完全に再現する。 */
  function rng(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randInt(r, n) { return Math.floor(r() * n) % n; }

  // ------------------------------------------------------------------ 項

  // 項は 3 種の不変オブジェクト。作った後は書き換えない。
  //   変数      { t:'v', n:<名前> }
  //   抽象      { t:'l', p:<束縛名>, b:<本体> }
  //   適用      { t:'a', f:<左>, g:<右> }

  function V(n) { return { t: 'v', n: n }; }
  function L(p, b) { return { t: 'l', p: p, b: b }; }
  function A(f, g) { return { t: 'a', f: f, g: g }; }

  function size(x) {
    if (x.t === 'v') return 1;
    if (x.t === 'l') return 1 + size(x.b);
    return 1 + size(x.f) + size(x.g);
  }

  function depth(x) {
    if (x.t === 'v') return 1;
    if (x.t === 'l') return 1 + depth(x.b);
    return 1 + Math.max(depth(x.f), depth(x.g));
  }

  /** 表示用。λx.x / (f g) の形。 */
  function show(x) {
    if (x.t === 'v') return x.n;
    if (x.t === 'l') return '\\' + x.p + '.' + show(x.b);
    var fs = x.f.t === 'l' ? '(' + show(x.f) + ')' : show(x.f);
    var gs = x.g.t === 'v' ? show(x.g) : '(' + show(x.g) + ')';
    return fs + ' ' + gs;
  }

  /**
   * de Bruijn 表記の文字列。**項の同一性はこれで決める**（＝α 変換で移り合う項は同じ鍵）。
   * 束縛の対応は系がもともと持っている区別なので、粒度を系から借りていることになる。
   */
  function key(x, env) {
    env = env || [];
    if (x.t === 'v') {
      for (var i = env.length - 1, d = 0; i >= 0; i--, d++) if (env[i] === x.n) return String(d);
      return '#' + x.n;              // 自由変数（標準化後は出ない）
    }
    if (x.t === 'l') return 'L' + key(x.b, env.concat([x.p]));
    return '(' + key(x.f, env) + ' ' + key(x.g, env) + ')';
  }

  function alphaEq(a, b) { return key(a) === key(b); }

  function freeVars(x, bound, out) {
    bound = bound || [];
    out = out || [];
    if (x.t === 'v') {
      if (bound.indexOf(x.n) < 0 && out.indexOf(x.n) < 0) out.push(x.n);
      return out;
    }
    if (x.t === 'l') return freeVars(x.b, bound.concat([x.p]), out);
    freeVars(x.f, bound, out);
    return freeVars(x.g, bound, out);
  }

  function isClosed(x) { return freeVars(x).length === 0; }

  /** 変数 n の自由な出現回数（β 基を縮める前に積の大きさを正確に見積もるために使う）。 */
  function occurrences(x, n) {
    var stack = [x], c = 0;
    while (stack.length) {
      var t = stack.pop();
      if (t.t === 'v') { if (t.n === n) c++; continue; }
      if (t.t === 'l') { if (t.p !== n) stack.push(t.b); continue; }
      stack.push(t.f); stack.push(t.g);
    }
    return c;
  }

  /**
   * (λp.b) g を縮めた結果の大きさ。α 変換は大きさを変えないので、これは厳密値である。
   * **縮める前に見積もる**ので、上限を超える項を一度も作らずに済む
   * （作ってから測ると、深い項で再帰が尽きる）。
   */
  function betaSize(f, g) {
    return size(f.b) + occurrences(f.b, f.p) * (size(g) - 1);
  }

  /** β 基 (λp.b) g を縮めたときに**項全体の大きさ**が増える分。 */
  function betaDelta(f, g) {
    var sg = size(g);
    return occurrences(f.b, f.p) * (sg - 1) - sg - 2;
  }

  // ------------------------------------------------------- 代入（変数捕獲を避ける）

  var freshCounter = 0;
  function fresh(base, avoid) {
    var n;
    do { n = base + '%' + (freshCounter++); } while (avoid.indexOf(n) >= 0);
    return n;
  }

  /** x[n := s]。s の自由変数が新たに束縛されないよう、必要なら束縛名を付け替える。 */
  function subst(x, n, s, sFree) {
    sFree = sFree || freeVars(s);
    if (x.t === 'v') return x.n === n ? s : x;
    if (x.t === 'a') {
      var f = subst(x.f, n, s, sFree), g = subst(x.g, n, s, sFree);
      return (f === x.f && g === x.g) ? x : A(f, g);
    }
    if (x.p === n) return x;                       // n はここで隠れる
    if (sFree.indexOf(x.p) < 0) {
      var b = subst(x.b, n, s, sFree);
      return b === x.b ? x : L(x.p, b);
    }
    // 捕獲が起きるので束縛名を付け替える（α 変換）
    var avoid = sFree.concat(freeVars(x.b));
    var p2 = fresh(x.p, avoid);
    var renamed = subst(x.b, x.p, V(p2), [p2]);
    return L(p2, subst(renamed, n, s, sFree));
  }

  // ------------------------------------------------------- 簡約

  /**
   * 正規順（最左最外）で正規形へ落とす。
   * 上限は 2 つ: 簡約ステップ数 maxSteps と 途中の項の大きさ maxSize。
   * どちらかに当たったら止めて、当たった側を st.hit に残す（'steps' / 'size'）。
   */
  function normal(x, maxSteps, maxSize) {
    var st = { steps: 0, hit: null, maxSeen: size(x), total: size(x) };
    var out = nf(x, st, maxSteps, maxSize);
    return { term: out, steps: st.steps, hit: st.hit, maxSeen: st.maxSeen };
  }

  function beta(f, g) { return subst(f.b, f.p, g); }

  /** 弱頭正規形まで。 */
  function whnf(x, st, maxSteps, maxSize) {
    var cur = x;
    for (;;) {
      if (st.hit) return cur;
      if (cur.t !== 'a') return cur;
      var f = whnf(cur.f, st, maxSteps, maxSize);
      if (st.hit) return A(f, cur.g);
      if (f.t !== 'l') return f === cur.f ? cur : A(f, cur.g);
      if (st.steps >= maxSteps) { st.hit = 'steps'; return A(f, cur.g); }
      // **項全体**の大きさで見る。部分項ごとに見ると、部分項の数だけ膨らむ余地が残る
      var est = st.total + betaDelta(f, cur.g);
      if (est > st.maxSeen) st.maxSeen = est;
      if (est > maxSize) { st.hit = 'size'; return A(f, cur.g); }
      st.total = est;
      st.steps++;
      cur = beta(f, cur.g);
    }
  }

  /** 正規形まで（抽象の中・適用の脊柱も降りる）。 */
  function nf(x, st, maxSteps, maxSize) {
    if (st.hit) return x;
    var h = whnf(x, st, maxSteps, maxSize);
    if (st.hit) return h;
    if (h.t === 'v') return h;
    if (h.t === 'l') {
      var b = nf(h.b, st, maxSteps, maxSize);
      return b === h.b ? h : L(h.p, b);
    }
    var f = nf(h.f, st, maxSteps, maxSize);
    var g = nf(h.g, st, maxSteps, maxSize);
    return (f === h.f && g === h.g) ? h : A(f, g);
  }

  /**
   * 第二の簡約戦略（最内左）。Church–Rosser の定理により、どちらも停止するなら
   * 正規形は α 同値でなければならない——**実装の外から来る検査**になる。
   */
  function normalInner(x, maxSteps, maxSize) {
    var st = { steps: 0, hit: null, maxSeen: size(x), total: size(x) };
    var cur = x;
    for (;;) {
      if (st.hit) break;
      if (st.steps >= maxSteps) { st.hit = 'steps'; break; }
      var r = stepInner(cur, st, maxSize);
      if (st.hit) break;
      if (!r) break;
      st.steps++;
      cur = r;
    }
    return { term: cur, steps: st.steps, hit: st.hit, maxSeen: st.maxSeen };
  }

  /** 最内左の β 基を 1 つ縮める。無ければ null。上限を超えるなら st.hit を立てる。 */
  function stepInner(x, st, maxSize) {
    if (x.t === 'v') return null;
    if (x.t === 'l') { var b = stepInner(x.b, st, maxSize); return b ? L(x.p, b) : null; }
    var f = stepInner(x.f, st, maxSize);
    if (st && st.hit) return null;
    if (f) return A(f, x.g);
    var g = stepInner(x.g, st, maxSize);
    if (st && st.hit) return null;
    if (g) return A(x.f, g);
    if (x.f.t === 'l') {
      if (st && maxSize !== undefined) {
        var est = st.total + betaDelta(x.f, x.g);
        if (est > st.maxSeen) st.maxSeen = est;
        if (est > maxSize) { st.hit = 'size'; return null; }
        st.total = est;
      }
      return beta(x.f, x.g);
    }
    return null;
  }

  // ------------------------------------------------------- 既知の項（検査と種に使う）

  function church(n) {
    var body = V('x');
    for (var i = 0; i < n; i++) body = A(V('f'), body);
    return L('f', L('x', body));
  }
  var I = L('x', V('x'));
  var K = L('x', L('y', V('x')));
  var PLUS = L('m', L('n', L('f', L('x', A(A(V('m'), V('f')), A(A(V('n'), V('f')), V('x')))))));
  var MULT = L('m', L('n', L('f', A(V('m'), A(V('n'), V('f'))))));

  // ------------------------------------------------------- 乱択の項を作る

  /**
   * 生成器 A（文法）。原典の系統: 変数／抽象／適用を確率で選び、深さとともに
   * 変数の確率を上げ、dmax で変数に固定する。
   */
  function genGrammar(r, opt) {
    var dmax = opt.dmax, nv = opt.nvars;
    function go(d) {
      var pv = d >= dmax ? 1 : opt.pVar + (1 - opt.pVar) * (d / dmax);
      var u = r();
      if (u < pv) return V('v' + randInt(r, nv));
      if (u < pv + (1 - pv) * opt.pLam) return L('v' + randInt(r, nv), go(d + 1));
      return A(go(d + 1), go(d + 1));
    }
    return go(0);
  }

  /**
   * 生成器 B（一様な二分木）。構文木を先に一様に選び、節へ抽象／適用を割り当てる。
   * 原典の生成器とは別物（2024 年の再解析が別案を試したのに倣った本スケッチの再構成）。
   */
  function genTree(r, opt) {
    var leaves = 1 + randInt(r, opt.maxLeaves);
    function build(k) {
      if (k === 1) return V('v' + randInt(r, opt.nvars));
      var left = 1 + randInt(r, k - 1);
      var node = A(build(left), build(k - left));
      return r() < opt.pLam ? L('v' + randInt(r, opt.nvars), node) : node;
    }
    var t = build(leaves);
    for (var i = 0; i < opt.wrap; i++) if (r() < opt.pLam) t = L('v' + randInt(r, opt.nvars), t);
    return t;
  }

  /**
   * 標準化。自由変数を束縛して閉じた項にする。
   *   'head'  … 自由変数 x ごとに λx を先頭へ付ける（原典の手続き）
   *   'inner' … 本体の直前に付ける（本スケッチの再構成。付ける位置だけが違う）
   */
  function standardize(x, mode) {
    var fv = freeVars(x);
    var out = x;
    if (mode === 'inner') {
      // 抽象の内側（最初の非抽象の直前）へ差し込む
      var prefix = [];
      var cur = out;
      while (cur.t === 'l') { prefix.push(cur.p); cur = cur.b; }
      var inner = cur;
      for (var j = fv.length - 1; j >= 0; j--) if (prefix.indexOf(fv[j]) < 0) inner = L(fv[j], inner);
      for (var k = prefix.length - 1; k >= 0; k--) inner = L(prefix[k], inner);
      return inner;
    }
    for (var i = fv.length - 1; i >= 0; i--) out = L(fv[i], out);
    return out;
  }

  /** 閉じた正規形を 1 つ作る。作れなければ null（呼ぶ側が引き直す）。 */
  function drawTerm(r, opt) {
    var raw = opt.gen === 'tree' ? genTree(r, opt) : genGrammar(r, opt);
    var closed = standardize(raw, opt.std || 'head');
    var n = normal(closed, opt.maxSteps, opt.maxSize);
    if (n.hit) return null;
    if (!isClosed(n.term)) return null;
    if (size(n.term) > opt.maxSize) return null;
    return n.term;
  }

  function drawMany(r, count, opt) {
    var out = [];
    var guard = 0;
    while (out.length < count && guard < count * 400) {
      guard++;
      var t = drawTerm(r, opt);
      if (t) out.push(t);
    }
    return out;
  }

  // ------------------------------------------------------- 容器

  /**
   * 容器。相異なる 2 枠を引き、mode に従って積を決め、一様な 1 枠へ入れる。
   *
   * mode:
   *   'apply'   … 積 = 正規形(左 右)。上限に当たったら弾性（何も入れない）
   *   'inert'   … 常に弾性（作用を切る）。容器は凍る
   *   'drift'   … 積 = 引いた左そのもの（作用を計算しない）。流れだけが残る
   *   'random'  … 積 = 引き直した乱択の項（作用の結果を使わない）
   *   'forgetF' … 左だけ別の枠から引き直して作用させる（誰が作用するかを忘れる）
   *   'forgetG' … 右だけ別の枠から引き直して作用させる（誰が作用されるかを忘れる）
   *   'deal'    … 積 = あらかじめ決めた札束 opt.deck から一様に 1 枚（作用の結果を一切見ない）
   *
   * copyFilter: 'off' | 'arg' | 'either'
   *   積が引いた項と一致する衝突を弾性にする（原典の syntactic filter に対応する）。
   */
  function makeContainer(opt) {
    var r = rng(opt.seed);
    var slots = opt.init.slice();
    var cache = new Map();       // 鍵 -> { k:積の鍵, hit:上限, steps }
    var ks = slots.map(function (t) { return key(t); });
    var bank = new Map();        // 鍵 -> 項
    for (var i = 0; i < slots.length; i++) if (!bank.has(ks[i])) bank.set(ks[i], slots[i]);

    var deckKeys = null;
    if (opt.deck) {
      deckKeys = opt.deck.map(function (t) { return key(t); });
      for (var d = 0; d < opt.deck.length; d++) if (!bank.has(deckKeys[d])) bank.set(deckKeys[d], opt.deck[d]);
    }

    var stats = {
      collisions: 0, elasticSteps: 0, elasticSize: 0, elasticFilter: 0,
      inserted: 0, altered: 0, alteredProduct: 0, cacheHits: 0, reductions: 0,
      maxSeen: 0, stepsTotal: 0,
    };
    var elasticLog = [];         // 上限で落とした側（K-63）
    var lastEvent = null;

    function product(fk, gk) {
      var ck = fk + '|' + gk;
      var c = cache.get(ck);
      if (c) { stats.cacheHits++; return c; }
      var res = normal(A(bank.get(fk), bank.get(gk)), opt.maxSteps, opt.maxSize);
      stats.reductions++;
      stats.stepsTotal += res.steps;
      if (res.maxSeen > stats.maxSeen) stats.maxSeen = res.maxSeen;
      var out;
      if (res.hit) {
        out = { k: null, hit: res.hit, steps: res.steps, maxSeen: res.maxSeen };
      } else {
        var pk = key(res.term);
        if (!bank.has(pk)) bank.set(pk, res.term);
        out = { k: pk, hit: null, steps: res.steps, maxSeen: res.maxSeen };
      }
      cache.set(ck, out);
      return out;
    }

    function step() {
      var n = ks.length;
      var i = randInt(r, n);
      var j = randInt(r, n - 1);
      if (j >= i) j++;
      stats.collisions++;
      var fk = ks[i], gk = ks[j];
      var trueF = fk, trueG = gk;

      if (opt.mode === 'inert') { lastEvent = { f: fk, g: gk, p: null, why: 'inert' }; return lastEvent; }

      if (opt.mode === 'drift') {
        var realD = product(fk, gk);
        stats.altered++;
        if (realD.k !== fk) stats.alteredProduct++;
        var slotF = randInt(r, n);
        ks[slotF] = fk;
        stats.inserted++;
        lastEvent = { f: fk, g: gk, p: fk, why: 'drift' };
        return lastEvent;
      }

      if (opt.mode === 'deal') {
        var pick = deckKeys[randInt(r, deckKeys.length)];
        var slotD = randInt(r, n);
        ks[slotD] = pick;
        stats.inserted++;
        stats.altered++;                        // 作用の結果を毎回捨てている
        // K-66: 「実際に何を変えたか」——本来の積と配った札が違った回数を数える
        var realDeal = product(fk, gk);
        if (realDeal.k !== pick) stats.alteredProduct++;
        lastEvent = { f: fk, g: gk, p: pick, why: 'deal' };
        return lastEvent;
      }

      if (opt.mode === 'random') {
        var t = drawTerm(r, opt);
        if (!t) { lastEvent = { f: fk, g: gk, p: null, why: 'nodraw' }; return lastEvent; }
        var rk = key(t);
        if (!bank.has(rk)) bank.set(rk, t);
        // 「実際に何を変えたか」を数える（K-66）: 本物の積と違ったか
        var real = product(fk, gk);
        stats.altered++;
        if (real.k !== rk) stats.alteredProduct++;
        var slotR = randInt(r, n);
        ks[slotR] = rk;
        stats.inserted++;
        lastEvent = { f: fk, g: gk, p: rk, why: 'random' };
        return lastEvent;
      }

      if (opt.mode === 'forgetF') { fk = ks[randInt(r, n)]; if (fk !== trueF) stats.altered++; }
      if (opt.mode === 'forgetG') { gk = ks[randInt(r, n)]; if (gk !== trueG) stats.altered++; }

      var res = product(fk, gk);
      if (opt.mode === 'forgetF' || opt.mode === 'forgetG') {
        var realP = product(trueF, trueG);
        if (realP.k !== res.k) stats.alteredProduct++;
      }

      if (res.hit) {
        if (res.hit === 'steps') stats.elasticSteps++; else stats.elasticSize++;
        if (elasticLog.length < opt.elasticLogCap) {
          elasticLog.push({ at: stats.collisions, hit: res.hit, steps: res.steps, maxSeen: res.maxSeen, f: fk, g: gk });
        }
        lastEvent = { f: fk, g: gk, p: null, why: 'cap:' + res.hit };
        return lastEvent;
      }
      if (opt.copyFilter === 'arg' && res.k === gk) {
        stats.elasticFilter++;
        lastEvent = { f: fk, g: gk, p: res.k, why: 'filter' };
        return lastEvent;
      }
      if (opt.copyFilter === 'either' && (res.k === gk || res.k === fk)) {
        stats.elasticFilter++;
        lastEvent = { f: fk, g: gk, p: res.k, why: 'filter' };
        return lastEvent;
      }
      var slot = randInt(r, n);
      ks[slot] = res.k;
      stats.inserted++;
      lastEvent = { f: fk, g: gk, p: res.k, why: 'insert' };
      return lastEvent;
    }

    function run(t) { for (var s = 0; s < t; s++) step(); }

    /** 鍵 -> 個数。 */
    function counts() {
      var m = new Map();
      for (var i2 = 0; i2 < ks.length; i2++) m.set(ks[i2], (m.get(ks[i2]) || 0) + 1);
      return m;
    }

    /** 容器の状態のハッシュ（FNV-1a・K-36）。 */
    function hash() {
      var arr = [];
      counts().forEach(function (v, k2) { arr.push(k2 + ':' + v); });
      arr.sort();
      var s2 = arr.join(',') + '#' + stats.collisions;
      var h = 0x811c9dc5;
      for (var i3 = 0; i3 < s2.length; i3++) {
        h ^= s2.charCodeAt(i3);
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      return ('00000000' + h.toString(16)).slice(-8);
    }

    /** 指定した鍵の実体を全部、乱択の別の項へ置き換える（介入で使う）。 */
    function removeKey(k2, replacements) {
      var removed = 0;
      for (var i4 = 0; i4 < ks.length; i4++) {
        if (ks[i4] === k2) {
          var rep = replacements[randInt(r, replacements.length)];
          var rk2 = key(rep);
          if (!bank.has(rk2)) bank.set(rk2, rep);
          ks[i4] = rk2;
          removed++;
        }
      }
      return removed;
    }

    /** 指定した項を m 個、一様な枠へ入れる（介入で使う）。 */
    function inject(term, m) {
      var k3 = key(term);
      if (!bank.has(k3)) bank.set(k3, term);
      for (var i5 = 0; i5 < m; i5++) ks[randInt(r, ks.length)] = k3;
      return k3;
    }

    return {
      step: step, run: run, counts: counts, hash: hash,
      keys: function () { return ks.slice(); },
      termOf: function (k4) { return bank.get(k4); },
      stats: function () { return JSON.parse(JSON.stringify(stats)); },
      elasticLog: function () { return elasticLog.slice(); },
      lastEvent: function () { return lastEvent; },
      product: product,
      removeKey: removeKey, inject: inject,
      /** 作ったときの設定（init だけ差し替えて同じ腕の容器をもう 1 つ作るのに使う）。 */
      options: function () { return Object.assign({}, opt); },
      deckTerms: function () { return opt.deck ? opt.deck.slice() : null; },
      rand: r,
      size: function () { return ks.length; },
      /** 容量を変える（ハーネスの「広さ」）。増やす分は今の中身から一様に複製する。 */
      resize: function (n2) {
        if (n2 === ks.length) return;
        if (n2 < ks.length) { ks.length = n2; return; }
        while (ks.length < n2) ks.push(ks[randInt(r, ks.length)]);
      },
    };
  }

  var api = {
    rng: rng, randInt: randInt,
    V: V, L: L, A: A, size: size, depth: depth, show: show, key: key, alphaEq: alphaEq,
    freeVars: freeVars, isClosed: isClosed, subst: subst, occurrences: occurrences, betaSize: betaSize, betaDelta: betaDelta,
    normal: normal, normalInner: normalInner, stepInner: stepInner,
    church: church, I: I, K: K, PLUS: PLUS, MULT: MULT,
    genGrammar: genGrammar, genTree: genTree, standardize: standardize,
    drawTerm: drawTerm, drawMany: drawMany,
    makeContainer: makeContainer,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.S39 = api;
}(typeof window !== 'undefined' ? window : globalThis));
