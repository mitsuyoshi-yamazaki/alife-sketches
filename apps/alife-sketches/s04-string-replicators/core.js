/**
 * S-04: 文字列分子の衝突と複製（Stringmol 風）
 *
 * 文字列は**データであると同時に実行可能なプログラムでもある**。2つの文字列が
 * 出会うと、相補的な部分列の整列（Smith-Waterman）で束縛の可否と束縛部位が決まり、
 * 一方が能動側になって自分の続きを命令として実行し、他方を読みながら新しい文字列を書く。
 *
 * 反応槽はランダムに2つ選んで反応させ、生成物を戻す。容量を超えたら一様乱数で捨てる。
 *
 * 出典（**アイデアのみ。コードは参照していない**）:
 *   Hickinbotham, Clark, Stepney, Clarke, Nellis, Pay, Young (2010)
 *   "Specification of the stringmol chemical programming language version 0.1"
 *   Technical Report YCS-2010-457, University of York
 *   https://www-users.york.ac.uk/~ss44/bib/ss/nonstd/tr457.pdf
 *
 * 原典から採った考え方: ①記号列が唯一の実体で、遺伝子型と表現型を区別しない
 * ②束縛は相補的な Smith-Waterman 整列で決める（完全一致を要求しない「柔らかい」束縛）
 * ③束縛部位が「どちらが能動側か」と「プログラムのどこから始まるか」を決める
 * ④命令記号とテンプレート記号が同じアルファベットに混在し、相補は環状の半周ずらしで与える
 * ⑤命令は4種のポインタ（命令・読み・書き・切替）を動かす小さな集合
 *
 * **原典と違う点はレポートの「限界」節に列挙してある**（命令の意味づけ・束縛の確率化・
 * アルファベットの大きさ・崩壊過程の有無）。本実装は原典の再現ではなく、
 * 同じ問いを自分の設計で見たものにあたる。
 *
 * 依存ゼロ。Node（生ログ生成）とブラウザ（可視化）が同じファイルを読む。
 *
 * 語彙について: この核には「細胞」「遺伝子」「生物」「触媒」「適応度」「生きている」という
 * 語も概念も無い。あるのは記号・文字列・整列・束縛・ポインタ・生成物・槽・希釈だけで、
 * 「種」「多様度」「系統」といった呼び名は下半分の観測器にしか出てこない。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S04 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // --------------------------------------------------------------- アルファベット
  //
  // 16 記号の環。相補は半周ずらし comp(i) = (i + 8) mod 16 で、これは対合になる
  // （comp(comp(x)) === x）。原典と同じく**命令記号とテンプレート記号を環の上で混ぜて**
  // あるので、テンプレート記号の相補が命令記号になることがある（D <-> $ など）。
  //
  //   添字:  0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15
  //   記号:  A B C = D E ? F G H  I  >  $  ^  %  }
  //   相補:  G H I > $ ^ % } A B  C  =  D  E  F  ?
  var RING = 'ABC=DE?FGHI>$^%}';
  var N_SYM = RING.length;
  var OPCODES = '=?>$^%}';

  var COMP = Object.create(null);
  var IS_OP = Object.create(null);
  var IDX = Object.create(null);
  (function () {
    for (var i = 0; i < N_SYM; i++) {
      COMP[RING.charAt(i)] = RING.charAt((i + N_SYM / 2) % N_SYM);
      IDX[RING.charAt(i)] = i;
    }
    for (var k = 0; k < OPCODES.length; k++) IS_OP[OPCODES.charAt(k)] = true;
  })();

  function isOpcode(c) { return IS_OP[c] === true; }
  function complementOf(s) {
    var o = '';
    for (var i = 0; i < s.length; i++) o += COMP[s.charAt(i)];
    return o;
  }

  /**
   * 命令（7種）。テンプレート記号 A-I が命令の位置に来たときは何もせず命令ポインタを進める
   * ——これが「データがそのままプログラムでもある」ことの実体にあたる。
   *
   *   =  copy   読みポインタの記号を書き出し用の緩衝へ写し、読みポインタを進める
   *   ?  if     読みポインタが文字列の末尾を越えていれば分岐（テンプレート付き）
   *   >  jump   後続テンプレートの相補を能動側の文字列から探し、命令ポインタをその直後へ
   *   $  search 後続テンプレートの相補を**読み対象**から探し、読みポインタをその直後へ
   *             （テンプレートが空なら読みポインタを 0 へ戻す）
   *   ^  toggle 読み対象を能動側 / 受動側で切り替える
   *   %  cleave 緩衝をそのとき点で1つの生成物として切り出し、緩衝を空にする
   *   }  end    実行を終了する（緩衝が残っていれば生成物になる）
   */
  var OP_NAMES = { '=': 'copy', '?': 'if', '>': 'jump', '$': 'search', '^': 'toggle', '%': 'cleave', '}': 'end' };

  /**
   * 手で組んだ複製子。**自分と同じ配列の相手に束縛し、相手を端から端まで写す。**
   * 相手が自分と同じ配列であれば、生成物は自分自身の複製になる。
   *
   *   [ 0..8 ] AAABBBCCC  束縛部位 α
   *   [ 9..17] GGGHHHIII  束縛部位 β = comp(α)。ここが繰り返しの戻り先でもある
   *   [18]     ?          読み終えたか
   *   [19..22] CCCC       ? のテンプレート。相補 IIII を能動側から探して飛ぶ
   *   [23]     =          1記号写す
   *   [24]     >          繰り返しへ戻る
   *   [25..33] AAABBBCCC  > のテンプレート（先頭6記号 AAABBB を使う）。相補 GGGHHH は [9..14]
   *   [34..37] IIII       ? の飛び先の標識
   *   [38]     }          終了
   *
   * 同一配列どうしの整列は score 11（[9..22] と [25..37] が1つの間隙を挟んで対応する）で、
   * 束縛部位の直後がちょうど [23] の = になる。**束縛部位が命令の開始位置を決める**という
   * 原典の性質を、この配列は設計として使っている。
   */
  var COPIER = 'AAABBBCCCGGGHHHIII?CCCC=>AAABBBCCCIIII}';

  var DEFAULTS = {
    capacity: 300,          // 槽に保てる文字列の本数。超えたら一様乱数で捨てる（希釈）
    mu: 0.0,                // 制御変数: copy 1回あたりの誤り確率（別の記号へ置換）
    bindThreshold: 6,       // 束縛が成立する整列得点の下限（criteria.json で較正・事前登録）
    matchScore: 1,
    mismatchScore: -1,
    gapScore: -2,
    maxTemplate: 6,         // 命令の後ろでテンプレートとして読む記号数の上限
    maxSteps: 2000,         // 1反応で実行する命令数の上限
    minProduct: 4,          // これより短い生成物は槽へ入れない
    maxProduct: 200,        // これより長くなった時点で書き出しを打ち切る
    initLength: 39,         // 初期の乱数文字列の長さ（COPIER と同じ）
    seedFraction: 0.2,      // 初期に手組み複製子を占める割合
    mode: 'normal',         // 'normal' | 'noExecution'（負コントロール: 実行を切る）
  };

  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function withDefaults(opts) {
    var p = {};
    Object.keys(DEFAULTS).forEach(function (k) { p[k] = DEFAULTS[k]; });
    Object.keys(opts || {}).forEach(function (k) { if (opts[k] != null) p[k] = opts[k]; });
    return p;
  }

  function randomString(rng, len) {
    var s = '';
    for (var i = 0; i < len; i++) s += RING.charAt((rng() * N_SYM) | 0);
    return s;
  }

  // --------------------------------------------------------------- 束縛（整列）

  var SEP = String.fromCharCode(1);   // アルファベットに現れない区切り（鍵の衝突を防ぐ）

  var rowA = null, rowB = null;

  /**
   * 相補的な局所整列（Smith-Waterman、間隙罰は線形）。
   *
   * **最大点そのものではなく「最大点の終端」だけを返す**。束縛部位の終端が分かれば
   * 命令ポインタの初期値が決まるので、逆追跡は要らない。同点のときは行優先で最初に
   * 現れた位置を採る（決定的）。
   *
   * @returns {{score:number, e1:number, e2:number}} e1/e2 は各文字列で整列の直後にあたる添字
   */
  function align(s1, s2, p) {
    p = p || DEFAULTS;
    var m = s1.length, n = s2.length;
    if (m === 0 || n === 0) return { score: 0, e1: 0, e2: 0 };
    if (rowA === null || rowA.length < n + 1) {
      var cap = Math.max(n + 1, 256);
      rowA = new Int32Array(cap);
      rowB = new Int32Array(cap);
    }
    var prev = rowA, cur = rowB;
    for (var z = 0; z <= n; z++) prev[z] = 0;
    var best = 0, bi = 0, bj = 0;
    for (var i = 1; i <= m; i++) {
      cur[0] = 0;
      var c1 = COMP[s1.charAt(i - 1)];
      for (var j = 1; j <= n; j++) {
        var d = prev[j - 1] + (c1 === s2.charAt(j - 1) ? p.matchScore : p.mismatchScore);
        var u = prev[j] + p.gapScore;
        var l = cur[j - 1] + p.gapScore;
        var v = d > u ? d : u;
        if (l > v) v = l;
        if (v < 0) v = 0;
        cur[j] = v;
        if (v > best) { best = v; bi = i; bj = j; }
      }
      var tmp = prev; prev = cur; cur = tmp;
    }
    return { score: best, e1: bi, e2: bj };
  }

  function opcodesFrom(s, from) {
    var c = 0;
    for (var i = from; i < s.length; i++) if (isOpcode(s.charAt(i))) c++;
    return c;
  }

  /**
   * どちらが能動側かを決める。**乱数を使わず決定的に**決める:
   *   ① 束縛部位より後ろに命令記号を多く持つほう（＝実行できる続きが多いほう）
   *   ② 同数なら長いほう ③ それも同じなら辞書順で小さいほう
   * @returns {boolean} true なら s1 が能動側
   */
  function firstIsActive(s1, s2, e1, e2) {
    var a1 = opcodesFrom(s1, e1), a2 = opcodesFrom(s2, e2);
    if (a1 !== a2) return a1 > a2;
    if (s1.length !== s2.length) return s1.length > s2.length;
    return s1 <= s2;
  }

  // --------------------------------------------------------------- 機械

  /** 命令の直後にあるテンプレート（テンプレート記号の連なり。上限 maxTemplate）。 */
  function templateAt(s, from, maxTemplate) {
    var t = '';
    for (var i = from; i < s.length && t.length < maxTemplate; i++) {
      var c = s.charAt(i);
      if (isOpcode(c)) break;
      t += c;
    }
    return t;
  }

  /**
   * pat と最もよく一致する窓を target から探し、その直後の添字を返す。
   * 一致が1記号も無ければ -1。同点は先に現れたほうを採る。
   */
  function findMatch(target, pat) {
    if (pat.length === 0 || pat.length > target.length) return -1;
    var best = 0, at = -1;
    for (var i = 0; i + pat.length <= target.length; i++) {
      var sc = 0;
      for (var k = 0; k < pat.length; k++) if (target.charAt(i + k) === pat.charAt(k)) sc++;
      if (sc > best) { best = sc; at = i; }
    }
    return at < 0 ? -1 : at + pat.length;
  }

  function mutate(c, rng) {
    var i = IDX[c];
    var j = (rng() * (N_SYM - 1)) | 0;
    if (j >= i) j++;
    return RING.charAt(j);
  }

  /**
   * 能動側の文字列を ip0 から実行する。
   *
   * @param {string} active   命令を提供する文字列
   * @param {string} passive  もう一方（既定の読み対象）
   * @param {number} ip0      命令ポインタの初期値（＝能動側の束縛部位の終端）
   * @param {object} p        設定
   * @param {function} rng    乱数
   * @param {object} [tally]  copies / copyErrors を積む先（省略可）
   * @returns {{products:string[], steps:number, halted:boolean}}
   */
  function execute(active, passive, ip0, p, rng, tally) {
    var strings = [active, passive];
    var rp = [0, 0];
    var target = 1;            // 既定の読み対象は受動側
    var buf = [];
    var products = [];
    var ip = ip0;
    var steps = 0;
    var halted = false;

    function flush() {
      if (buf.length >= p.minProduct) products.push(buf.join(''));
      buf = [];
    }

    while (steps < p.maxSteps) {
      if (ip < 0 || ip >= active.length) break;
      steps++;
      var c = active.charAt(ip);

      if (!isOpcode(c)) { ip++; continue; }           // テンプレート記号は無操作

      if (c === '=') {
        var src = strings[target];
        if (rp[target] < src.length) {
          var ch = src.charAt(rp[target]);
          rp[target]++;
          if (tally) tally.copies++;
          if (p.mu > 0 && rng() < p.mu) { ch = mutate(ch, rng); if (tally) tally.copyErrors++; }
          buf.push(ch);
          if (buf.length >= p.maxProduct) { ip++; break; }
        }
        ip++;
      } else if (c === '^') {
        target = 1 - target;
        ip++;
      } else if (c === '%') {
        flush();
        ip++;
      } else if (c === '}') {
        halted = true;
        break;
      } else if (c === '$') {
        var t$ = templateAt(active, ip + 1, p.maxTemplate);
        if (t$.length === 0) { rp[target] = 0; ip++; }
        else {
          var hit$ = findMatch(strings[target], complementOf(t$));
          rp[target] = hit$ < 0 ? 0 : hit$;
          ip = ip + 1 + t$.length;
        }
      } else if (c === '>') {
        var t1 = templateAt(active, ip + 1, p.maxTemplate);
        if (t1.length === 0) { ip++; }
        else {
          var hit1 = findMatch(active, complementOf(t1));
          ip = hit1 < 0 ? ip + 1 + t1.length : hit1;
        }
      } else if (c === '?') {
        var atEnd = rp[target] >= strings[target].length;
        var t2 = templateAt(active, ip + 1, p.maxTemplate);
        if (t2.length === 0) {
          ip += atEnd ? 2 : 1;                        // 原典の「1つ進めるか2つ進めるか」
        } else if (atEnd) {
          var hit2 = findMatch(active, complementOf(t2));
          ip = hit2 < 0 ? ip + 1 + t2.length : hit2;
        } else {
          ip = ip + 1 + t2.length;
        }
      } else {
        ip++;
      }
    }

    flush();
    return { products: products, steps: steps, halted: halted };
  }

  /**
   * 2つの文字列を衝突させる。束縛しなければ products は空。
   * @returns {{bound:boolean, score:number, activeIsFirst:boolean, ip0:number, products:string[], steps:number}}
   */
  function react(s1, s2, p, rng, tally) {
    p = withDefaults(p);
    var a = align(s1, s2, p);
    if (a.score < p.bindThreshold) {
      return { bound: false, score: a.score, activeIsFirst: true, ip0: 0, products: [], steps: 0 };
    }
    var f = firstIsActive(s1, s2, a.e1, a.e2);
    var act = f ? s1 : s2, pas = f ? s2 : s1;
    var ip0 = f ? a.e1 : a.e2;
    var r = execute(act, pas, ip0, p, rng, tally);
    return { bound: true, score: a.score, activeIsFirst: f, ip0: ip0, products: r.products, steps: r.steps };
  }

  // --------------------------------------------------------------- 反応槽

  function createVessel(opts, seed) {
    var p = withDefaults(opts);
    var rng = makeRng(seed);
    var soup = [];
    var nSeed = Math.round(p.capacity * p.seedFraction);
    for (var i = 0; i < p.capacity; i++) {
      soup.push({ s: i < nSeed ? COPIER : randomString(rng, p.initLength), depth: 0 });
    }
    for (var k = soup.length - 1; k > 0; k--) {      // 初期の並び順が効かないように混ぜる
      var j = (rng() * (k + 1)) | 0;
      var t = soup[k]; soup[k] = soup[j]; soup[j] = t;
    }
    return {
      params: p, rng: rng, soup: soup, seed: seed, gen: 0,
      attempts: 0, binds: 0, products: 0, dropped: 0, copies: 0, copyErrors: 0, steps: 0,
      cache: new Map(),
    };
  }

  function cachedAlign(v, s1, s2) {
    var key = s1 + SEP + s2;
    var hit = v.cache.get(key);
    if (hit !== undefined) return hit;
    var a = align(s1, s2, v.params);
    if (v.cache.size > 200000) v.cache.clear();
    v.cache.set(key, a);
    return a;
  }

  function addProduct(v, s, depth) {
    var p = v.params;
    if (s.length < p.minProduct || s.length > p.maxProduct) { v.dropped++; return; }
    v.soup.push({ s: s, depth: depth });
    v.products++;
    while (v.soup.length > p.capacity) {            // 希釈: 一様乱数で1本捨てる
      var idx = (v.rng() * v.soup.length) | 0;
      v.soup[idx] = v.soup[v.soup.length - 1];
      v.soup.pop();
    }
  }

  /** 1回の衝突。ランダムに2本選んで反応させ、生成物を槽へ戻す。 */
  function attempt(v) {
    var p = v.params, soup = v.soup, n = soup.length;
    if (n < 2) return;
    var a = (v.rng() * n) | 0;
    var b = (v.rng() * n) | 0;
    while (b === a) b = (v.rng() * n) | 0;
    if (a > b) { var t = a; a = b; b = t; }
    v.attempts++;
    var m1 = soup[a], m2 = soup[b];

    if (p.mode === 'noExecution') {
      // 負コントロール: 束縛も機械も使わず、毎回一様乱数の文字列を産み続ける。
      // この系の定常状態は「全て相異なる一様乱数列」で、多様度比も記号エントロピー比も
      // 理論値 1.0 になる。検出器がそこから外れたら検出器が壊れている。
      addProduct(v, randomString(v.rng, m2.s.length), 0);
      return;
    }

    var al = cachedAlign(v, m1.s, m2.s);
    if (al.score < p.bindThreshold) return;
    v.binds++;
    var f = firstIsActive(m1.s, m2.s, al.e1, al.e2);
    var act = f ? m1 : m2, pas = f ? m2 : m1;
    var ip0 = f ? al.e1 : al.e2;
    var r = execute(act.s, pas.s, ip0, p, v.rng, v);
    v.steps += r.steps;
    for (var q = 0; q < r.products.length; q++) addProduct(v, r.products[q], pas.depth + 1);
  }

  /** capacity 回の衝突をまとめて1世代とする（1本あたり平均2回ぶつかる）。 */
  function runGeneration(v) {
    var c = v.params.capacity;
    for (var i = 0; i < c; i++) attempt(v);
    v.gen++;
  }

  // --------------------------------------------------------------- 観測器
  //
  // ここから下だけが「種」「多様度」「系統」を語る。核の側にはこれらの語彙は無い。
  //
  // 主の秩序変数 speciesEntropyRatio は**理論的な帰無値を持つ**:
  //   槽の N 本がすべて相異なる配列なら種のシャノンエントロピーは log2(N) に等しく、
  //   比は厳密に 1.0 になる。単一配列に占有されれば 0。**解析側で選ぶスケールを含まない**
  //   （「支配的」の占有率閾値も、連結半径のような自由度も要らない）。
  //   副の symbolEntropyRatio も同様で、一様乱数の槽では log2(16) = 4 bit/記号 になる。

  function measure(v) {
    var soup = v.soup, n = soup.length;
    var counts = new Map();
    var symCounts = new Int32Array(N_SYM);
    var totalSym = 0, lenSum = 0, depthSum = 0, maxDepth = 0, master = 0;

    for (var i = 0; i < n; i++) {
      var s = soup[i].s;
      counts.set(s, (counts.get(s) || 0) + 1);
      lenSum += s.length;
      depthSum += soup[i].depth;
      if (soup[i].depth > maxDepth) maxDepth = soup[i].depth;
      if (s === COPIER) master++;
      for (var k = 0; k < s.length; k++) { symCounts[IDX[s.charAt(k)]]++; totalSym++; }
    }

    var H = 0, top = 0, topSeq = '';
    counts.forEach(function (c, s) {
      var pr = c / n;
      H -= pr * Math.log2(pr);
      if (c > top) { top = c; topSeq = s; }
    });

    var Hs = 0;
    for (var z = 0; z < N_SYM; z++) {
      if (symCounts[z] === 0) continue;
      var q = symCounts[z] / totalSym;
      Hs -= q * Math.log2(q);
    }

    return {
      gen: v.gen,
      molecules: n,
      speciesCount: counts.size,
      speciesEntropy: H,
      speciesEntropyNull: Math.log2(n),          // 全て相異なるときの理論値
      speciesEntropyRatio: n > 1 ? H / Math.log2(n) : 0,
      dominantFraction: top / n,
      dominantSequence: topSeq,
      masterFraction: master / n,
      symbolEntropy: Hs,
      symbolEntropyNull: Math.log2(N_SYM),       // 一様乱数のときの理論値 = 4 bit
      symbolEntropyRatio: Hs / Math.log2(N_SYM),
      meanLength: lenSum / n,
      meanDepth: depthSum / n,
      maxDepth: maxDepth,
      bindRate: v.attempts > 0 ? v.binds / v.attempts : 0,
      productRate: v.attempts > 0 ? v.products / v.attempts : 0,
      copyErrorObserved: v.copies > 0 ? v.copyErrors / v.copies : 0,
    };
  }

  /**
   * 1レプリケートを generations 世代回す。
   * @param {number} tailFraction 末尾何割の平均を返すか（観測の時間窓。事前登録する）
   */
  function runReplicate(opts, seed, generations, tailFraction, onSample) {
    var v = createVessel(opts, seed);
    var tail = [];
    var from = Math.floor(generations * (1 - tailFraction));
    for (var g = 0; g < generations; g++) {
      runGeneration(v);
      var m = measure(v);
      if (g >= from) tail.push(m);
      if (onSample) onSample(m, v);
    }
    var avg = function (f) { return tail.reduce(function (a, x) { return a + f(x); }, 0) / tail.length; };
    var last = tail[tail.length - 1];
    return {
      seed: seed,
      mu: v.params.mu,
      generations: generations,
      tailFrom: from,
      speciesEntropyRatio: avg(function (x) { return x.speciesEntropyRatio; }),
      dominantFraction: avg(function (x) { return x.dominantFraction; }),
      masterFraction: avg(function (x) { return x.masterFraction; }),
      symbolEntropyRatio: avg(function (x) { return x.symbolEntropyRatio; }),
      speciesCount: avg(function (x) { return x.speciesCount; }),
      meanLength: avg(function (x) { return x.meanLength; }),
      maxDepth: last.maxDepth,
      meanDepth: avg(function (x) { return x.meanDepth; }),
      bindRate: last.bindRate,
      productRate: last.productRate,
      copyErrorObserved: last.copyErrorObserved,
      dominantSequence: last.dominantSequence,
      dominantIsCopier: last.dominantSequence === COPIER,
    };
  }

  return {
    RING: RING, N_SYM: N_SYM, OPCODES: OPCODES, OP_NAMES: OP_NAMES, COMP: COMP,
    COPIER: COPIER, DEFAULTS: DEFAULTS,
    isOpcode: isOpcode, complementOf: complementOf, indexOfSymbol: function (c) { return IDX[c]; },
    makeRng: makeRng, randomString: randomString,
    align: align, firstIsActive: firstIsActive,
    templateAt: templateAt, findMatch: findMatch, execute: execute, react: react,
    createVessel: createVessel, attempt: attempt, runGeneration: runGeneration,
    measure: measure, runReplicate: runReplicate,
  };
});
