/**
 * S-16: 環境からの報酬を足すと何が変わるか（Avida 風）
 *
 * S-05（Tierra 風）と同じ形の仮想機械——環状の共有メモリ・テンプレート照合による番地指定・
 * 確保記録・ラウンドロビンの待ち行列——の上に、**環境との2本の線**を足したものである:
 *
 *   ① 入力と出力   `io` 命令が ax の値を外へ出し、代わりに次の入力値を ax へ入れる。
 *                  入力は各プロセスが誕生時に受け取る 3 個の 32 ビット値を巡回して読む。
 *   ② 報酬         出された値が、受け取った入力に対する或る論理関数と一致していれば、
 *                  そのプロセスの merit（＝次の生成周期に貰える CPU 時間の取り分の倍率）が上がる。
 *
 * **報酬倍率を全て 1 にすれば S-05 と同じ条件になる**（増えれば増えるだけ）。
 * 報酬の有無はこの1点だけで切り替わり、入出力も判定も両方の条件でそのまま動く。
 *
 * 論理演算の命令は `nand` **1つだけ**である。他の関数は nand の組み合わせでしか作れない。
 *
 * ── S-05 から引き継いだもの（ユーザ指示により明記する）───────────────────────
 * 仮想機械の骨格は apps/alife-sketches/s05-tierra-like/core.js の設計をそのまま借りた:
 * 環状メモリ・owner 配列・テンプレート照合（nop0/nop1 の極大列の補完を近い順に探す）・
 * alloc/split の約束事（零詰め・大きさの上下限・書き切るまで独立させない）・
 * reapOne の待ち行列・shift による優先順の上下・runRound の巡回。
 * **S-05 のファイルは1文字も変更していない。**
 * 変えたのは: 命令集合（zero/shl/mov_cd/push_d/pop_d を外し nand/io/mov_ad/mov_da/swap_ab を入れた）・
 * slice に merit を掛けること・プロセスが入力と出力の記録を持つこと・祖先プログラムに計算区画があること。
 *
 * ── 語彙について ───────────────────────────────────────────────
 * この核には「生物」「適応度」「複雑さ」「進化した」という語も概念も無い。
 * あるのはメモリ・プロセス・確保記録・命令語・待ち行列・入力・出力・報酬倍率(merit)だけである。
 * 「EQU が進化した」は観測器（run.js / viewer.html）の側の言い方にあたる。
 *
 * 出典（アイデアのみ。コードは参照していない）:
 *   C. Ofria & C. O. Wilke (2004) "Avida: A Software Platform for Research in
 *     Computational Evolutionary Biology", Artificial Life 10(2):191-229.
 *   R. E. Lenski, C. Ofria, R. T. Pennock & C. Adami (2003)
 *     "The evolutionary origin of complex features", Nature 423:139-144.
 *
 * 依存ゼロ。Node（生ログ生成）とブラウザ（可視化）が同じファイルを読む。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S16 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------------------------------------------- 命令集合 */

  // 32 語ちょうど。書き写し誤りは 0..31 の一様乱数で置き換えるので、
  // 命令語の空間に穴があると「何もしない値」が混ざって系が甘くなる。
  var OPS = [
    'nop0',    // 0  テンプレートの 0
    'nop1',    // 1  テンプレートの 1
    'inc_a',   // 2
    'inc_b',   // 3
    'inc_c',   // 4
    'dec_c',   // 5
    'sub_ab',  // 6  cx = ax - bx
    'mov_ab',  // 7  bx = ax
    'mov_ba',  // 8  ax = bx
    'mov_ad',  // 9  dx = ax        ← 祖先の計算区画の詰め物でもある
    'mov_da',  // 10 ax = dx
    'mov_ii',  // 11 mem[bx] = mem[ax]   ← メモリへ書き込む唯一の命令
    'push_a',  // 12
    'push_b',  // 13
    'push_c',  // 14
    'pop_a',   // 15
    'pop_b',   // 16
    'pop_c',   // 17
    'nand',    // 18 ax = ~(ax & bx)     ← **唯一の論理演算命令**
    'io',      // 19 ax を出力し、次の入力値を ax へ
    'jmp_f',   // 20 前方へテンプレート探索して飛ぶ
    'jmp_b',   // 21 後方へ
    'call',    // 22 戻り番地を積んで、前後の近いほうへ飛ぶ
    'ret',     // 23 戻り番地を降ろして飛ぶ
    'adr_f',   // 24 前方へ探索し、見つかった位置を ax、距離を cx へ
    'adr_b',   // 25 後方へ
    'adr_n',   // 26 前後の近いほうへ
    'if_z',    // 27 cx == 0 なら次を実行、さもなくば次を飛ばす
    'if_nz',   // 28 cx != 0 なら次を実行、さもなくば次を飛ばす
    'alloc',   // 29 cx 個のセルを確保し、先頭を bx へ
    'split',   // 30 確保した領域を独立したプロセスにする
    'swap_ab'  // 31 ax ↔ bx
  ];
  var OPCODE = {};
  for (var _i = 0; _i < OPS.length; _i++) OPCODE[OPS[_i]] = _i;

  var OP_MOV_II = 11, OP_NAND = 18, OP_IO = 19;
  var TEMPLATE_MAX = 10;

  // 事前登録した minCredit の値（criteria.json の creditRule.registeredKnobValues と同じ）。
  var CREDIT_MARKS = [1, 2, 3, 5, 10];

  /* ------------------------------------------------------- 演算の表（観測器用） */

  // rank と bonus は criteria.json と同じ値をここにも持つ。核は「どれが複雑か」を
  // 判断しない——rank は観測器が結果を並べるための添字であり、bonus は外から渡される
  // 報酬倍率の既定値である。
  var TASKS = [
    { name: 'NOT',  arity: 1, rank: 1, bonus: 2,  sym: true,  f: function (a) { return (~a) >>> 0; } },
    { name: 'NAND', arity: 2, rank: 1, bonus: 2,  sym: true,  f: function (a, b) { return (~(a & b)) >>> 0; } },
    { name: 'AND',  arity: 2, rank: 2, bonus: 4,  sym: true,  f: function (a, b) { return (a & b) >>> 0; } },
    { name: 'ORN',  arity: 2, rank: 2, bonus: 4,  sym: false, f: function (a, b) { return (a | (~b)) >>> 0; } },
    { name: 'OR',   arity: 2, rank: 3, bonus: 8,  sym: true,  f: function (a, b) { return (a | b) >>> 0; } },
    { name: 'ANDN', arity: 2, rank: 3, bonus: 8,  sym: false, f: function (a, b) { return (a & (~b)) >>> 0; } },
    { name: 'NOR',  arity: 2, rank: 4, bonus: 16, sym: true,  f: function (a, b) { return (~(a | b)) >>> 0; } },
    { name: 'XOR',  arity: 2, rank: 4, bonus: 16, sym: true,  f: function (a, b) { return (a ^ b) >>> 0; } },
    { name: 'EQU',  arity: 2, rank: 5, bonus: 32, sym: true,  f: function (a, b) { return (~(a ^ b)) >>> 0; } }
  ];
  var NTASK = TASKS.length;
  var TASK_INDEX = {};
  for (var _t = 0; _t < NTASK; _t++) TASK_INDEX[TASKS[_t].name] = _t;

  var REWARD_SETS = {
    none:       [],
    all:        ['NOT', 'NAND', 'AND', 'ORN', 'OR', 'ANDN', 'NOR', 'XOR', 'EQU'],
    equOnly:    ['EQU'],
    simpleOnly: ['NOT', 'NAND', 'AND', 'ORN', 'OR', 'ANDN']
  };

  /** 引数の添字の組。相異なる添字しか使わない——NOT(A) と NAND(A,A) を混同させないため。 */
  var ARGSETS = (function () {
    var out = [];
    for (var t = 0; t < NTASK; t++) {
      var T = TASKS[t], list = [];
      if (T.arity === 1) { list.push([0]); list.push([1]); list.push([2]); }
      else if (T.sym) { list.push([0, 1]); list.push([0, 2]); list.push([1, 2]); }
      else {
        list.push([0, 1]); list.push([1, 0]); list.push([0, 2]);
        list.push([2, 0]); list.push([1, 2]); list.push([2, 1]);
      }
      out.push(list);
    }
    return out;
  })();

  /* ------------------------------------------------------------ 乱数・道具 */

  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function popcount(x) {
    x = x - ((x >>> 1) & 0x55555555);
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    x = (x + (x >>> 4)) & 0x0f0f0f0f;
    return (Math.imul(x, 0x01010101) >>> 24);
  }

  /** 命令名の並んだテキストを命令語の配列にする。`;` 以降は註釈。 */
  function assemble(src) {
    var out = [];
    var lines = String(src).split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var semi = line.indexOf(';');
      if (semi >= 0) line = line.slice(0, semi);
      var toks = line.split(/\s+/);
      for (var j = 0; j < toks.length; j++) {
        var t = toks[j];
        if (!t) continue;
        if (!(t in OPCODE)) throw new Error('未知の命令: ' + t + '（' + (i + 1) + '行目）');
        out.push(OPCODE[t]);
      }
    }
    return out;
  }

  function disassemble(code) {
    var s = [];
    for (var i = 0; i < code.length; i++) s.push(OPS[code[i]]);
    return s;
  }

  /* ------------------------------------------------------------- 入力の生成 */

  var WEIGHT_LO = 6, WEIGHT_HI = 26;

  /**
   * 3 個の入力値を引く。**36 個の候補値（3 入力そのもの ＋ 9 種の演算を全ての引数組へ
   * 当てた値）が互いに相異なり、かつどれも 1 のビット数が [6,26] に入る**まで引き直す。
   *
   * なぜこの条件が要るか:
   *  ・相異なることを要求しないと、たとえば OR(A,B) が A と一致する（確率 (3/4)^32 ≈ 1.0e-4）ため、
   *    **入力を素通しするだけのプログラムが OR を実行したと判定されてしまう**。
   *  ・1 のビット数を [6,26] に限らないと、たとえば AND(A,B)=0 が確率 1.0e-4 で起き、
   *    **ax を初期値 0 のまま出力するプログラムが AND を実行したと判定されてしまう**。
   *
   * この2条件のもとでは「出力が候補値のどれかと一致したら、それがどの演算かは一意に決まる」ことが
   * 構成から保証され、定数を吐くプログラムが偶然当たる確率も 1 プロセスあたり 1.4e-7 以下に抑えられる。
   */
  function drawInputs(rng, limit) {
    var lim = limit || 200;
    var tries = 0;
    for (;;) {
      tries++;
      var inp = [
        (rng() * 4294967296) >>> 0,
        (rng() * 4294967296) >>> 0,
        (rng() * 4294967296) >>> 0
      ];
      var map = new Map();
      var ok = true;
      // ECHO（入力そのもの）も候補に入れる。相異なることを要求するのはこのため。
      for (var e = 0; e < 3 && ok; e++) {
        var w = popcount(inp[e]);
        if (w < WEIGHT_LO || w > WEIGHT_HI) { ok = false; break; }
        if (map.has(inp[e])) { ok = false; break; }
        map.set(inp[e], { task: -1, args: [e] });
      }
      for (var t = 0; t < NTASK && ok; t++) {
        var sets = ARGSETS[t];
        for (var s = 0; s < sets.length; s++) {
          var ar = sets[s];
          var v = ar.length === 1 ? TASKS[t].f(inp[ar[0]]) : TASKS[t].f(inp[ar[0]], inp[ar[1]]);
          var wv = popcount(v);
          if (wv < WEIGHT_LO || wv > WEIGHT_HI) { ok = false; break; }
          if (map.has(v)) { ok = false; break; }
          map.set(v, { task: t, args: ar });
        }
      }
      if (ok) return { inputs: inp, table: map, tries: tries, failed: false };
      if (tries >= lim) return { inputs: inp, table: map, tries: tries, failed: true };
    }
  }

  /* ---------------------------------------------------- 祖先プログラムの組み立て */

  // 計算区画の詰め物。dx へ書くだけで複製の手続きに影響しない。
  var FILLER = 'mov_ad';

  function repeat(tok, n) {
    var a = [];
    for (var i = 0; i < n; i++) a.push(tok);
    return a.join(' ');
  }

  /**
   * 自己複製プログラムを作る。`work` に渡した命令列が計算区画（17 枠）へ入る。
   * 足りない枠は詰め物で埋める。**枠の数と区画の位置は全ての系統で共通**なので、
   * 報酬の有無だけを変えた比較ができる。
   *
   * レイアウト:
   *   [ 0] 先頭の目印 1111
   *   [ 4] 繰り返しの戻り先 0101
   *   [ 8] io          ← 出力し I1 を読む
   *   [ 9] mov_ab      ← bx = I1
   *   [10] 枠 W0       ← ここが nand になれば ax = ~(I1&I1) = NOT(I1)
   *   [11] io          ← 出力し I2 を読む
   *   [12] 枠 W1..W17  ← 17 枠の作業場。W1 が nand なら ax = ~(I2&I1) = NAND
   *   [29] io          ← 作業場の結果を出力し I3 を読む
   *   [30] 枠 W18
   *   [31] 以降は S-05 と同じ複製の手続き
   */
  function buildSource(work, slots) {
    var n = (slots === undefined) ? 17 : slots;
    var w = (work || '').split(/\s+/).filter(function (x) { return x; });
    if (w.length > n) throw new Error('計算区画に入りきらない: ' + w.length + ' > ' + n);
    var pre = w.length > 0 ? w[0] : FILLER;      // W0（1 命令だけの前置き枠）
    var body = w.slice(1);
    while (body.length < n) body.push(FILLER);
    return [
      'nop1 nop1 nop1 nop1     ; 先頭の目印 1111',
      'nop0 nop1 nop0 nop1     ; 繰り返しの戻り先 0101',
      '; ---- 計算区画 ----',
      'io                      ; 出力して I1 を読む',
      'mov_ab                  ; bx = I1',
      pre + '                  ; 枠 W0',
      'io                      ; 出力して I2 を読む',
      body.join(' ') + '       ; 枠 W1..W' + n,
      'io                      ; 作業場の結果を出力して I3 を読む',
      FILLER + '               ; 枠 W' + (n + 1),
      '; ---- 複製の手続き（S-05 と同じ）----',
      'adr_b',
      'nop0 nop0 nop0 nop0     ;   補完 1111 → 自分の先頭。ax = 先頭番地',
      'push_a',
      'mov_ab',
      'adr_f',
      'nop0 nop0 nop0 nop1     ;   補完 1110 → 末尾の目印',
      'sub_ab',
      'inc_c inc_c inc_c inc_c ; 目印の4命令を足して cx = 全長',
      'alloc',
      'pop_a',
      'call',
      'nop0 nop1 nop1 nop0     ;   補完 1001 → 複写手続きの見出し',
      'split',
      'jmp_b',
      'nop1 nop0 nop1 nop0     ;   補完 0101 → 戻り先',
      'mov_ad                  ; 区切り（実行されない）',
      'nop1 nop0 nop0 nop1     ; 複写手続きの見出し 1001',
      'mov_ii',
      'inc_a',
      'inc_b',
      'dec_c',
      'if_z',
      'ret',
      'jmp_b',
      'nop0 nop1 nop1 nop0     ;   補完 1001',
      'mov_ad                  ; 区切り',
      'nop1 nop1 nop1 nop0     ; 末尾の目印 1110'
    ].join('\n');
  }

  // 計算区画に nand を1つも置かない祖先。入力を素通しして出すだけ（ECHO）。
  var SOURCE_ANCESTOR = buildSource('');

  // 手で書いた計算列。いずれも入口は ax = I2(=A), bx = I1(=B)。
  // W0 の枠は1命令しか無いので、2命令以上の列は W1 から始まる。
  var WORK = {
    NOT:  'nand',                                   // W0 に nand。ax=~(I1&I1)=NOT(I1) を次の io が出す
    NAND: FILLER + ' nand',                         // W1 に nand。ax=~(I2&I1)
    AND:  FILLER + ' nand mov_ab nand',
    ORN:  FILLER + ' push_b mov_ab nand pop_b nand',
    OR:   FILLER + ' push_b mov_ab nand mov_ad pop_a mov_ab nand mov_ab mov_da nand',
    NOR:  FILLER + ' push_b mov_ab nand mov_ad pop_a mov_ab nand mov_ab mov_da nand mov_ab nand',
    ANDN: FILLER + ' push_a mov_ba mov_ab nand mov_ab pop_a nand mov_ab nand',
    XOR:  FILLER + ' push_b push_a nand mov_ad mov_ab pop_a nand mov_ad mov_ba pop_b nand mov_ab mov_da nand',
    EQU:  FILLER + ' push_b push_a nand mov_ad mov_ab pop_a nand mov_ad mov_ba pop_b nand mov_ab mov_da nand mov_ab nand'
  };

  var SOURCE = {};
  Object.keys(WORK).forEach(function (k) { SOURCE[k] = buildSource(WORK[k]); });

  /* ---------------------------------------------------------------- 仮想機械 */

  var DEFAULTS = {
    memSize: 30000,
    copyErrorRate: 0.005,
    flipRate: 0,
    sliceFactor: 0.2,
    searchLimit: 1024,
    maxAlloc: 2000,
    maxAllocFactor: 3,
    reapAttempts: 2,
    rewardSet: 'none',      // 'none' | 'all' | 'equOnly' | 'simpleOnly' | 演算名の配列
    rewardScale: 1,         // 倍率は bonus^rewardScale
    maxMerit: 1e12,   // 数値の安全弁のみ。取り分は平均で割った比で決まるので実質的な上限ではない
    outputMode: 'normal',   // 'normal' | 'random' | 'rotate' | 'zero'
    nandEnabled: true,
    inputResampleLimit: 200
  };

  function resolveRewards(p) {
    var names = p.rewardSet;
    if (typeof names === 'string') names = REWARD_SETS[names];
    if (!names) throw new Error('未知の報酬集合: ' + p.rewardSet);
    var mult = new Float64Array(NTASK);
    for (var i = 0; i < NTASK; i++) mult[i] = 1;
    for (var j = 0; j < names.length; j++) {
      var k = TASK_INDEX[names[j]];
      if (k === undefined) throw new Error('未知の演算: ' + names[j]);
      mult[k] = Math.pow(TASKS[k].bonus, p.rewardScale);
    }
    return mult;
  }

  function createVM(opts, seed) {
    var p = {};
    Object.keys(DEFAULTS).forEach(function (k) { p[k] = DEFAULTS[k]; });
    if (opts) Object.keys(opts).forEach(function (k) { p[k] = opts[k]; });
    var M = p.memSize;
    var vm = {
      params: p,
      rewardMult: resolveRewards(p),
      memSize: M,
      mem: new Uint8Array(M),
      owner: new Int32Array(M),
      procs: [],
      nextPid: 1,
      rng: makeRng(seed >>> 0),
      allocCursor: 0,
      freeCells: M,
      dirty: false,
      instr: 0, births: 0, reaps: 0, copyErrors: 0, faults: 0, allocFail: 0,
      movii: 0, exec: 0, ioCount: 0, outputs: 0, flips: 0,
      echoEvents: 0,
      inputDraws: 0, inputTries: 0, inputFailures: 0,
      maxMeritSeen: 1,
      meritCapHits: 0,
      // 観測: 演算ごとに「記録した相異なるプロセス数」と、その数が k に達した時点の命令数
      taskProcs: new Int32Array(NTASK),
      taskEvents: new Int32Array(NTASK),
      // 「相異なる n 体が記録した時点の命令数」は、**事前登録した minCredit の値でだけ**残す。
      // 全ての n について残すと 1 レプリケートあたり 30MB を超える（実測）。
      creditMarks: CREDIT_MARKS,
      taskFirstAt: (function () {
        var a = [];
        for (var i = 0; i < NTASK; i++) a.push({});
        return a;
      })(),
      tmp: []
    };
    return vm;
  }

  function assignInputs(vm, p) {
    var d = drawInputs(vm.rng, vm.params.inputResampleLimit);
    vm.inputDraws++; vm.inputTries += d.tries;
    if (d.failed) vm.inputFailures++;
    p.inputs = d.inputs;
    p.table = d.table;
    p.inCursor = 0;
    p.recvMask = 0;
  }

  function newProc(vm, start, len, parent) {
    var p = {
      pid: vm.nextPid++,
      start: start, len: len,
      ip: start,
      ax: 0, bx: 0, cx: 0, dx: 0,
      stack: [],
      dstart: -1, dlen: 0, dwritten: 0,
      faults: 0, births: 0,
      movii: 0, exec: 0, ios: 0,
      merit: parent ? parent.merit : 1,
      gestMult: 1,       // この生成周期で積み上がった倍率
      gestMask: 0,       // この生成周期で記録した演算
      recentMask: 0,     // 直前の生成周期で記録した演算
      everMask: 0,       // 走行を通じてこのプロセスが記録した演算
      lastOut: 0,
      inputs: null, table: null, inCursor: 0, recvMask: 0,
      born: vm.instr, parentPid: parent ? parent.pid : 0,
      depth: parent ? parent.depth + 1 : 0,
      qi: vm.procs.length,
      dead: false
    };
    assignInputs(vm, p);
    vm.procs.push(p);
    return p;
  }

  function claim(vm, start, n, pid) {
    var own = vm.owner;
    for (var i = 0; i < n; i++) {
      if (own[start + i] === 0) vm.freeCells--;
      own[start + i] = pid;
    }
  }

  function release(vm, start, n) {
    var own = vm.owner;
    for (var i = 0; i < n; i++) {
      if (own[start + i] !== 0) vm.freeCells++;
      own[start + i] = 0;
    }
  }

  function inject(vm, code, addr) {
    for (var i = 0; i < code.length; i++) vm.mem[(addr + i) % vm.memSize] = code[i];
    claim(vm, addr, code.length, vm.nextPid);
    return newProc(vm, addr, code.length, null);
  }

  /* ------------------------------------------------------ テンプレート照合 */

  function templateAt(vm, addr) {
    var bits = vm.tmp; bits.length = 0;
    var M = vm.memSize, a = addr;
    while (bits.length < TEMPLATE_MAX) {
      var v = vm.mem[a];
      if (v > 1) break;
      bits.push(v);
      a = a + 1 === M ? 0 : a + 1;
    }
    return bits;
  }

  function matchAt(vm, a, bits) {
    var M = vm.memSize, mem = vm.mem, n = bits.length;
    for (var i = 0; i < n; i++) {
      var k = a + i; if (k >= M) k -= M;
      if (mem[k] !== 1 - bits[i]) return false;
    }
    return true;
  }

  function searchForward(vm, from, bits, limit) {
    var M = vm.memSize;
    for (var d = 0; d < limit; d++) {
      var a = from + d; if (a >= M) a -= M;
      if (matchAt(vm, a, bits)) return a;
    }
    return -1;
  }

  function searchBackward(vm, from, bits, limit) {
    var M = vm.memSize;
    for (var d = 0; d < limit; d++) {
      var a = from - d; if (a < 0) a += M;
      if (matchAt(vm, a, bits)) return a;
    }
    return -1;
  }

  /* ------------------------------------------------------------ 領域の確保 */

  function scanFree(vm, n) {
    var M = vm.memSize, own = vm.owner, start = vm.allocCursor, run = 0, first = -1;
    for (var k = 0; k < M; k++) {
      var a = start + k; if (a >= M) a -= M;
      if (a === 0) run = 0;
      if (own[a] === 0) {
        if (run === 0) first = a;
        run++;
        if (run >= n) { vm.allocCursor = (first + n) % M; return first; }
      } else run = 0;
    }
    return -1;
  }

  function reapOne(vm, except) {
    for (var i = 0; i < vm.procs.length; i++) {
      var p = vm.procs[i];
      if (p.dead || p === except) continue;
      p.dead = true;
      release(vm, p.start, p.len);
      if (p.dlen > 0) release(vm, p.dstart, p.dlen);
      vm.reaps++;
      vm.dirty = true;
      return p.start;
    }
    return -1;
  }

  function findFree(vm, n, except) {
    for (var attempt = 0; attempt < vm.params.reapAttempts; attempt++) {
      if (vm.freeCells >= n) {
        var s = scanFree(vm, n);
        if (s >= 0) return s;
      }
      var freed = reapOne(vm, except);
      if (freed < 0) return -1;
      vm.allocCursor = freed;
    }
    return -1;
  }

  /* --------------------------------------------------------- 入出力と報酬 */

  /**
   * プロセス p が値 v を出した。候補表に一致すれば記録し、報酬倍率を積む。
   * **報酬の有無に関わらず記録は行う**——観測器は両方の条件で同じものを見る。
   */
  function emit(vm, p, v) {
    vm.outputs++;
    p.lastOut = v;
    var hit = p.table.get(v >>> 0);
    if (hit === undefined) return;
    // 引数に使う入力を全て受け取っているか
    var ar = hit.args;
    for (var i = 0; i < ar.length; i++) if ((p.recvMask & (1 << ar[i])) === 0) return;
    if (hit.task < 0) { vm.echoEvents++; return; }   // ECHO は演算に数えない
    var t = hit.task;
    vm.taskEvents[t]++;
    if ((p.everMask & (1 << t)) === 0) {
      p.everMask |= (1 << t);
      vm.taskProcs[t]++;
      var n = vm.taskProcs[t];
      if (vm.creditMarks.indexOf(n) >= 0 && vm.taskFirstAt[t][n] === undefined) {
        vm.taskFirstAt[t][n] = vm.instr;
      }
    }
    if ((p.gestMask & (1 << t)) === 0) {
      p.gestMask |= (1 << t);
      p.gestMult *= vm.rewardMult[t];
      if (p.gestMult > vm.params.maxMerit) { p.gestMult = vm.params.maxMerit; vm.meritCapHits++; }
    }
  }

  function doIo(vm, p) {
    var mode = vm.params.outputMode;
    var v;
    if (mode === 'random') v = (vm.rng() * 4294967296) >>> 0;
    else if (mode === 'zero') v = 0;
    else if (mode === 'rotate') {
      var last = p.inCursor === 0 ? 0 : p.inputs[(p.inCursor - 1) % 3];
      v = (((last << 1) | (last >>> 31)) >>> 0);
    } else v = p.ax >>> 0;
    emit(vm, p, v);
    var idx = p.inCursor % 3;
    p.ax = p.inputs[idx] | 0;
    p.recvMask |= (1 << idx);
    p.inCursor++;
    p.ios++; vm.ioCount++;
  }

  /* ------------------------------------------------------------ 1命令の実行 */

  function shift(vm, p, dir) {
    var i = p.qi, j = i + dir;
    if (j < 0 || j >= vm.procs.length) return;
    var q = vm.procs[j];
    if (vm.procs[i] !== p) return;
    vm.procs[i] = q; vm.procs[j] = p;
    p.qi = j; q.qi = i;
  }

  function fault(vm, p) { p.faults++; vm.faults++; shift(vm, p, -1); }

  function wrap(vm, v) {
    var M = vm.memSize;
    var r = v % M;
    return r < 0 ? r + M : r;
  }

  function inBlock(p, a) { return a >= p.start && a < p.start + p.len; }

  function push(p, v) {
    p.stack.push(v);
    if (p.stack.length > 10) p.stack.shift();
  }
  function pop(vm, p) {
    if (p.stack.length === 0) { fault(vm, p); return 0; }
    return p.stack.pop();
  }

  function execOne(vm, p) {
    var M = vm.memSize, mem = vm.mem;
    var ip = p.ip;
    var op = mem[ip];
    var next = ip + 1 === M ? 0 : ip + 1;

    p.exec++; vm.exec++;

    switch (op) {
      case 0: case 1: break;                          // nop0 / nop1
      case 2: p.ax = (p.ax + 1) | 0; break;
      case 3: p.bx = (p.bx + 1) | 0; break;
      case 4: p.cx = (p.cx + 1) | 0; break;
      case 5: p.cx = (p.cx - 1) | 0; break;
      case 6: p.cx = (p.ax - p.bx) | 0; break;        // sub_ab
      case 7: p.bx = p.ax; break;                     // mov_ab
      case 8: p.ax = p.bx; break;                     // mov_ba
      case 9: p.dx = p.ax; break;                     // mov_ad
      case 10: p.ax = p.dx; break;                    // mov_da
      case 11: {                                      // mov_ii
        var src = wrap(vm, p.ax), dst = wrap(vm, p.bx);
        p.movii++; vm.movii++;
        var writable = inBlock(p, dst) || (p.dlen > 0 && dst >= p.dstart && dst < p.dstart + p.dlen);
        if (!writable) { fault(vm, p); break; }
        var v = mem[src];
        if (vm.params.copyErrorRate > 0 && vm.rng() < vm.params.copyErrorRate) {
          v = (vm.rng() * 32) | 0;
          vm.copyErrors++;
        }
        mem[dst] = v;
        if (p.dlen > 0 && dst >= p.dstart && dst < p.dstart + p.dlen) p.dwritten++;
        break;
      }
      case 12: push(p, p.ax); break;
      case 13: push(p, p.bx); break;
      case 14: push(p, p.cx); break;
      case 15: p.ax = pop(vm, p); break;
      case 16: p.bx = pop(vm, p); break;
      case 17: p.cx = pop(vm, p); break;
      case 18:                                        // nand
        if (vm.params.nandEnabled) p.ax = (~(p.ax & p.bx)) | 0;
        break;
      case 19: doIo(vm, p); break;                    // io
      case 20: case 21: case 22: case 24: case 25: case 26: {
        var bits = templateAt(vm, next);
        var tlen = bits.length;
        var after = (next + tlen) % M;
        if (tlen === 0) { fault(vm, p); next = after; break; }
        var lim = vm.params.searchLimit;
        var hit = -1;
        if (op === 20 || op === 24) hit = searchForward(vm, after, bits, lim);
        else if (op === 21 || op === 25) hit = searchBackward(vm, ip - 1 < 0 ? M - 1 : ip - 1, bits, lim);
        else {
          var f = searchForward(vm, after, bits, lim);
          var b = searchBackward(vm, ip - 1 < 0 ? M - 1 : ip - 1, bits, lim);
          if (f < 0) hit = b;
          else if (b < 0) hit = f;
          else {
            var df = (f - ip + M) % M, db = (ip - b + M) % M;
            hit = df <= db ? f : b;
          }
        }
        if (hit < 0) { fault(vm, p); next = after; break; }
        if (op === 24 || op === 25 || op === 26) {
          p.ax = hit;
          p.cx = Math.min((hit - ip + M) % M, (ip - hit + M) % M);
          next = after;
        } else {
          if (op === 22) push(p, after);
          next = (hit + tlen) % M;
        }
        break;
      }
      case 23: {                                     // ret
        if (p.stack.length === 0) { fault(vm, p); break; }
        next = wrap(vm, p.stack.pop());
        break;
      }
      case 27: if (p.cx !== 0) next = (next + 1) % M; break;   // if_z
      case 28: if (p.cx === 0) next = (next + 1) % M; break;   // if_nz
      case 29: {                                     // alloc
        var n = p.cx | 0;
        var f2 = vm.params.maxAllocFactor;
        var hi = Math.min(vm.params.maxAlloc, f2 * p.len);
        var lo = Math.max(1, (p.len / f2) | 0);
        if (n < lo || n > hi) { fault(vm, p); break; }
        var s = findFree(vm, n, p);
        if (s < 0) { fault(vm, p); vm.allocFail++; break; }
        if (p.dlen > 0) release(vm, p.dstart, p.dlen);
        claim(vm, s, n, p.pid);
        for (var z = 0; z < n; z++) mem[s + z] = 0;
        p.dstart = s; p.dlen = n; p.dwritten = 0;
        p.bx = s;
        break;
      }
      case 30: {                                     // split
        if (p.dlen <= 0 || p.dwritten < p.dlen) { fault(vm, p); break; }
        // **生成周期の締め**: この周期で積み上がった倍率が、次の周期の取り分になる。
        // 親も子も同じ値を受け取り、記録は両方とも消える（累乗させない）。
        var m = p.gestMult;
        if (m > vm.params.maxMerit) m = vm.params.maxMerit;
        p.merit = m;
        p.recentMask = p.gestMask;
        p.gestMult = 1; p.gestMask = 0;
        if (m > vm.maxMeritSeen) vm.maxMeritSeen = m;
        var child = newProc(vm, p.dstart, p.dlen, p);
        child.recentMask = 0;
        claim(vm, p.dstart, p.dlen, child.pid);
        p.births++; vm.births++;
        shift(vm, p, 1);
        p.dstart = -1; p.dlen = 0; p.dwritten = 0;
        break;
      }
      case 31: { var tq = p.ax; p.ax = p.bx; p.bx = tq; break; }  // swap_ab
      default: fault(vm, p); break;
    }

    p.ip = next;
    vm.instr++;

    if (vm.params.flipRate > 0 && vm.rng() < vm.params.flipRate) {
      var a2 = (vm.rng() * M) | 0;
      vm.mem[a2] = (vm.rng() * 32) | 0;
      vm.flips++;
    }
  }

  /* -------------------------------------------------------------- 実行の巡回 */

  /**
   * 1巡: その時点の生存プロセスそれぞれに持ち分の命令数を与える。
   *
   * 取り分は **merit を個体群の平均で割った比** で決まる。絶対値ではなく比にしているのは
   * 2つの理由による: ①CPU 時間の総量が一定に保たれ、1体が系を占有しない
   * ②**報酬倍率を全て 1 にすると取り分が len*sliceFactor に戻り、S-05 と厳密に同じ配分になる**——
   * 「報酬を足すと何が変わるか」を1点だけの違いで比べられる。
   */
  function runRound(vm) {
    var n = vm.procs.length;
    var f = vm.params.sliceFactor;
    var died = false;
    var meritSum = 0;
    for (var mi = 0; mi < n; mi++) if (!vm.procs[mi].dead) meritSum += vm.procs[mi].merit;
    var meanMerit = n > 0 && meritSum > 0 ? meritSum / n : 1;
    for (var i = 0; i < n; i++) {
      var p = vm.procs[i];
      if (p.dead) { died = true; continue; }
      var slice = (p.len * f * (p.merit / meanMerit)) | 0;
      if (slice < 1) slice = 1;
      for (var k = 0; k < slice; k++) {
        execOne(vm, p);
        if (p.dead) { died = true; break; }
      }
    }
    if (died || vm.dirty || vm.procs.length > n) {
      var live = [];
      for (var j = 0; j < vm.procs.length; j++) if (!vm.procs[j].dead) live.push(vm.procs[j]);
      for (var q = 0; q < live.length; q++) live[q].qi = q;
      vm.procs = live;
      vm.dirty = false;
    }
    return vm.procs.length;
  }

  function runInstructions(vm, n) {
    var target = vm.instr + n;
    while (vm.instr < target && vm.procs.length > 0) runRound(vm);
    return vm.instr;
  }

  /* ---------------------------------------------------------------- 観測器 */

  function blockHash(vm, start, len) {
    var h = 0x811c9dc5;
    for (var i = 0; i < len; i++) {
      h ^= vm.mem[(start + i) % vm.memSize];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  function countBits(m) { var c = 0; while (m) { c += m & 1; m >>>= 1; } return c; }

  /**
   * 観測する。minCredit は「或る演算が系に現れたと数えるために必要な、
   * それを記録した相異なるプロセスの数」。登録した 5 通りをまとめて返す。
   */
  function measure(vm, knobs) {
    var ks = knobs || CREDIT_MARKS;
    var pop = vm.procs.length;
    var lens = [], sumLen = 0, geno = {}, complex = 0, withNand = 0, maxDepth = 0, sumDepth = 0;
    var anyTask = 0;
    for (var i = 0; i < pop; i++) {
      var p = vm.procs[i];
      lens.push(p.len); sumLen += p.len;
      var key = p.len + '-' + blockHash(vm, p.start, p.len);
      geno[key] = (geno[key] || 0) + 1;
      var rm = p.recentMask | p.gestMask;
      if (rm & (1 << TASK_INDEX.NOR | 1 << TASK_INDEX.XOR | 1 << TASK_INDEX.EQU)) complex++;
      if (rm) anyTask++;
      for (var z = 0; z < p.len; z++) {
        if (vm.mem[(p.start + z) % vm.memSize] === OP_NAND) { withNand++; break; }
      }
      if (p.depth > maxDepth) maxDepth = p.depth;
      sumDepth += p.depth;
    }
    lens.sort(function (a, b) { return a - b; });

    var byKnob = {};
    for (var kk = 0; kk < ks.length; kk++) {
      var k = ks[kk];
      var names = [], maxRank = 0, equAt = null;
      for (var t = 0; t < NTASK; t++) {
        if (vm.taskProcs[t] >= k) {
          names.push(TASKS[t].name);
          if (TASKS[t].rank > maxRank) maxRank = TASKS[t].rank;
          if (TASKS[t].name === 'EQU') equAt = vm.taskFirstAt[t][k];
        }
      }
      byKnob[k] = {
        taskTypesCredited: names.length,
        tasks: names,
        maxRankCredited: maxRank,
        equFirstInstr: equAt === undefined ? null : equAt
      };
    }

    var perTask = {};
    for (var u = 0; u < NTASK; u++) {
      perTask[TASKS[u].name] = { procs: vm.taskProcs[u], events: vm.taskEvents[u], firstAt: vm.taskFirstAt[u] };
    }

    return {
      population: pop,
      instr: vm.instr,
      byKnob: byKnob,
      perTask: perTask,
      complexFraction: pop > 0 ? complex / pop : 0,
      complexCount: complex,
      anyTaskFraction: pop > 0 ? anyTask / pop : 0,
      nandCarrierFraction: pop > 0 ? withNand / pop : 0,
      meanLength: pop > 0 ? sumLen / pop : 0,
      medianLength: pop > 0 ? lens[pop >> 1] : 0,
      minLength: pop > 0 ? lens[0] : 0,
      maxLength: pop > 0 ? lens[pop - 1] : 0,
      lengths: (function () { var h = {}; for (var i2 = 0; i2 < lens.length; i2++) h[lens[i2]] = (h[lens[i2]] || 0) + 1; return h; })(),
      genotypeCount: Object.keys(geno).length,
      maxDepth: maxDepth,
      meanDepth: pop > 0 ? sumDepth / pop : 0,
      births: vm.births, reaps: vm.reaps, faults: vm.faults,
      copyErrors: vm.copyErrors, allocFail: vm.allocFail,
      ioCount: vm.ioCount, outputs: vm.outputs, echoEvents: vm.echoEvents,
      maxMeritSeen: vm.maxMeritSeen, meritCapHits: vm.meritCapHits,
      inputDraws: vm.inputDraws, inputTries: vm.inputTries, inputFailures: vm.inputFailures,
      freeCells: vm.freeCells
    };
  }

  /** owner 配列を、プロセス一覧から作り直したものと突き合わせる（近道の検算用）。 */
  function rebuildOwner(vm) {
    var o = new Int32Array(vm.memSize);
    for (var i = 0; i < vm.procs.length; i++) {
      var p = vm.procs[i];
      if (p.dead) continue;
      for (var k = 0; k < p.len; k++) o[(p.start + k) % vm.memSize] = p.pid;
      if (p.dlen > 0) for (var j = 0; j < p.dlen; j++) o[(p.dstart + j) % vm.memSize] = p.pid;
    }
    return o;
  }

  function seedWorld(opts, seed, source) {
    var vm = createVM(opts, seed);
    var code = assemble(source === undefined ? SOURCE_ANCESTOR : source);
    inject(vm, code, 0);
    return vm;
  }

  /**
   * 計算列だけを実行して ax を返す（恒等式による検査用・K-18）。
   * 実行するのは work に渡した命令列だけで、複製の手続きも io も通さない。
   */
  function evalWork(work, A, B, opts) {
    var vm = createVM(Object.assign({ memSize: 512, copyErrorRate: 0 }, opts || {}), 1);
    var code = assemble(work);
    var p = inject(vm, code, 0);
    p.ax = A | 0; p.bx = B | 0;
    for (var i = 0; i < code.length; i++) execOne(vm, p);
    return p.ax >>> 0;
  }

  return {
    OPS: OPS, OPCODE: OPCODE, OP_MOV_II: OP_MOV_II, OP_NAND: OP_NAND, OP_IO: OP_IO,
    TASKS: TASKS, TASK_INDEX: TASK_INDEX, ARGSETS: ARGSETS, REWARD_SETS: REWARD_SETS,
    DEFAULTS: DEFAULTS, TEMPLATE_MAX: TEMPLATE_MAX, CREDIT_MARKS: CREDIT_MARKS,
    WEIGHT_LO: WEIGHT_LO, WEIGHT_HI: WEIGHT_HI,
    WORK: WORK, SOURCE: SOURCE, SOURCE_ANCESTOR: SOURCE_ANCESTOR, FILLER: FILLER,
    buildSource: buildSource,
    makeRng: makeRng, popcount: popcount,
    assemble: assemble, disassemble: disassemble,
    drawInputs: drawInputs,
    createVM: createVM, inject: inject, newProc: newProc,
    execOne: execOne, runRound: runRound, runInstructions: runInstructions,
    templateAt: templateAt, matchAt: matchAt,
    searchForward: searchForward, searchBackward: searchBackward,
    reapOne: reapOne, shift: shift,
    measure: measure, blockHash: blockHash, countBits: countBits,
    rebuildOwner: rebuildOwner, seedWorld: seedWorld, evalWork: evalWork,
    resolveRewards: resolveRewards
  };
});
