/**
 * S-25: 共有メモリ上の仮想機械と、その**実行トレース**
 *
 * ── このファイルが出所を借りていること（ユーザ指示により明記する）─────────────
 * 仮想機械の骨格は apps/alife-sketches/s05-tierra-like/core.js の設計をそのまま借りた:
 * 環状メモリ・owner 配列・テンプレート照合（nop0/nop1 の極大列の補完を近い順に探す）・
 * alloc/split の約束事（零詰め・大きさの上下限・書き切るまで独立させない）・
 * reapOne の待ち行列・shift による優先順の上下・runRound の巡回・祖先プログラム・
 * 複写手続きを持たないプログラム（S05.SOURCE_NOCOPY）。
 * **S-05 のファイルは1文字も変更していない**（S-16 が S-05 に対して採ったのと同じ形）。
 *
 * 変えたのは1点だけ:
 *
 *   **S-05 の核は `newProc(vm, start, len, parentPid)` を持ち、独立した領域に
 *   `parent: p.pid` を書き込んでいた。本スケッチはそれを消した。**
 *
 * 「誰が親か」は機械の事実ではなく**規則の選択**である、というのが本スケッチの題材だから
 * である。核は代わりに、独立（detach）1件ごとに**機械が実際に持っている事実の袋**を出す:
 *
 *   allocPid       その領域を確保した命令を実行したプロセス
 *   splitPid       その領域を独立させた命令を実行したプロセス
 *   writeBy{}      その領域へ書き込んだ複写命令を**実行した**プロセスごとの回数
 *   writeCodeAt{}  その複写命令が**置かれていたセルの持ち主**ごとの回数
 *   writeSrcAt{}   複写**元のセルの持ち主**ごとの回数
 *   matchAt{}      領域が開いている間のテンプレート照合が**当たったセルの持ち主**ごとの回数
 *   liveDraw[]     そのとき走っていたプロセスから一様に引いた k 個の識別子
 *
 * この袋のどれを「親」と読むかは **stats.js（観測器）の側にしか無い**。
 *
 * ── 語彙について ───────────────────────────────────────────────
 * 核には「生物」「親」「子」「複製子」「寄生」「宿主」「適応度」「生死」という語も概念も無い。
 * あるのはメモリ・プロセス・確保記録・命令語・待ち行列・独立（detach）・取り除き（reap）だけである。
 *
 * ── 観測が系に触れないこと ─────────────────────────────────────────
 * トレースの記録に使う乱数は独立（detach）1件ごとに `vm.obsSeed` と事象の量から作り直す。
 * 系の進行に使う `vm.rng` を1度も回さないので、**トレースを取っても取らなくても
 * 状態ハッシュは完全に一致する**（selftest の PC7 が検査する）。
 * 事象ごとに引き直すのは、走らせ役と1本の系列を共有すると巡回の走査位置と位相が
 * 噛み合うため（drawLive の註を見よ。本番の前に実測で見つけて直した）。
 *
 * 出典（アイデアのみ。コードは参照していない）:
 *   Thomas S. Ray (1991) "An Approach to the Synthesis of Life",
 *   Artificial Life II, SFI Studies in the Sciences of Complexity, pp. 371-408.
 *   Samuel Butler (1863) "Darwin among the Machines", The Press (Christchurch).
 *
 * 依存ゼロ。Node（生ログ生成）とブラウザ（可視化）が同じファイルを読む。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S25 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------------------------------------------- 命令集合 */

  // 32 語ちょうど。書き写し誤りは 0..31 の一様乱数で置き換えるので、
  // 命令語の空間に穴があると「何もしない値」が混ざって系が甘くなる。
  var OPS = [
    'nop0',   // 0  テンプレートの 0
    'nop1',   // 1  テンプレートの 1
    'zero',   // 2  cx = 0
    'shl',    // 3  cx = cx << 1
    'inc_a',  // 4  ax = ax + 1
    'inc_b',  // 5  bx = bx + 1
    'inc_c',  // 6  cx = cx + 1
    'dec_c',  // 7  cx = cx - 1
    'sub_ab', // 8  cx = ax - bx
    'mov_ab', // 9  bx = ax
    'mov_cd', // 10 dx = cx
    'mov_ii', // 11 mem[bx] = mem[ax]   ← メモリへ書き込む唯一の命令
    'push_a', // 12
    'push_b', // 13
    'push_c', // 14
    'push_d', // 15
    'pop_a',  // 16
    'pop_b',  // 17
    'pop_c',  // 18
    'pop_d',  // 19
    'jmp_f',  // 20 前方へテンプレート探索して飛ぶ
    'jmp_b',  // 21 後方へ
    'call',   // 22 戻り番地を積んで、前後の近いほうへ飛ぶ
    'ret',    // 23 戻り番地を降ろして飛ぶ
    'adr_f',  // 24 前方へ探索し、見つかった位置を ax、距離を cx へ
    'adr_b',  // 25 後方へ
    'adr_n',  // 26 前後の近いほうへ
    'if_z',   // 27 cx == 0 なら次を実行、さもなくば次を飛ばす
    'if_nz',  // 28 cx != 0 なら次を実行、さもなくば次を飛ばす
    'alloc',  // 29 cx 個のセルを確保し、先頭を bx へ
    'split',  // 30 確保した領域を独立したプロセスにする
    'mov_ba'  // 31 ax = bx
  ];
  var OPCODE = {};
  for (var _i = 0; _i < OPS.length; _i++) OPCODE[OPS[_i]] = _i;

  var OP_MOV_II = 11;
  var TEMPLATE_MAX = 10;

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

  /* ------------------------------------------------- 自分を写すプログラム（59 命令） */

  // **テンプレートは「直後に続く nop の極大列」**なので、テンプレートの直後に
  // 別の nop 列が来ると1本に繋がってしまう。境目に実行されない区切り命令を挟んである。
  // （S-05 の SOURCE_SELFCOPY をそのまま借りた）
  var SOURCE_SELFCOPY = [
    'nop1 nop1 nop1 nop1     ; [ 0] 先頭の目印 1111',
    'nop0 nop1 nop0 nop1     ; [ 4] 繰り返しの戻り先 0101',
    'adr_b                   ; [ 8] 後方探索',
    'nop0 nop0 nop0 nop0     ; [ 9]   補完 1111 → 自分の先頭。ax = 先頭番地',
    'push_a                  ; [13] 先頭番地を退避',
    'mov_ab                  ; [14] bx = 先頭番地',
    'adr_f                   ; [15] 前方探索',
    'nop0 nop0 nop0 nop1     ; [16]   補完 1110 → 末尾の目印。ax = その先頭',
    'sub_ab                  ; [20] cx = 末尾の目印の位置 - 自分の先頭',
    'inc_c inc_c inc_c inc_c ; [21] 目印の4命令を足して cx = 全長',
    'alloc                   ; [25] cx 個を確保。bx = 確保先の先頭',
    'pop_a                   ; [26] ax = 自分の先頭（複写元）',
    'call                    ; [27] 複写手続きへ',
    'nop0 nop1 nop1 nop0     ; [28]   補完 1001 → 複写手続きの見出し',
    'split                   ; [32] 確保した領域を独立させる',
    'jmp_b                   ; [33] 先頭へ戻る',
    'nop1 nop0 nop1 nop0     ; [34]   補完 0101 → [4] の戻り先',
    'mov_cd                  ; [38] 区切り（ここは実行されない）',
    'nop1 nop0 nop0 nop1     ; [39] 複写手続きの見出し 1001',
    'mov_ii                  ; [43] mem[bx] = mem[ax]',
    'inc_a                   ; [44]',
    'inc_b                   ; [45]',
    'dec_c                   ; [46]',
    'if_z                    ; [47] 残りが 0 なら次の ret を実行',
    'ret                     ; [48] 呼び出し元へ',
    'jmp_b                   ; [49] さもなくば見出しへ戻る',
    'nop0 nop1 nop1 nop0     ; [50]   補完 1001',
    'mov_cd                  ; [54] 区切り',
    'nop1 nop1 nop1 nop0     ; [55] 末尾の目印 1110'
  ].join('\n');

  // **複写手続きを自分の中に持たない**が、同じテンプレート 0110 で呼び出すプログラム。
  // 自分の中に見出し 1001 が無いので、探索は自分のブロックの外まで伸びる。全長 43。
  // （S-05 の SOURCE_NOCOPY をそのまま借りた。本スケッチでは**正コントロール**に使う——
  //  この形に対して5つの帰属規則が何を返すかは、機構から先に分かっている）
  var SOURCE_NOCOPY = [
    'nop1 nop1 nop1 nop1     ; [ 0] 先頭の目印 1111',
    'nop0 nop1 nop0 nop1     ; [ 4] 繰り返しの戻り先 0101',
    'adr_b',
    'nop0 nop0 nop0 nop0     ; [ 9] 補完 1111',
    'push_a',
    'mov_ab',
    'adr_f',
    'nop0 nop0 nop0 nop1     ; [16] 補完 1110',
    'sub_ab',
    'inc_c inc_c inc_c inc_c',
    'alloc',
    'pop_a',
    'call',
    'nop0 nop1 nop1 nop0     ; [28] 補完 1001（自分の中には無い）',
    'split',
    'jmp_b',
    'nop1 nop0 nop1 nop0     ; [34] 補完 0101',
    'mov_cd                  ; [38] 区切り',
    'nop1 nop1 nop1 nop0     ; [39] 末尾の目印 1110'
  ].join('\n');

  /* ---------------------------------------------------------------- 仮想機械 */

  var DEFAULTS = {
    memSize: 30000,       // 環状メモリのセル数
    copyErrorRate: 0.001, // mov_ii が1命令を書くたびに値が一様乱数に化ける確率（制御変数）
    flipRate: 0,          // 背景の書き換え。既定は切ってある
    sliceFactor: 0.2,     // 1巡で与える命令数 = max(1, floor(len * sliceFactor))
    searchLimit: 1024,    // テンプレート探索の届く距離（片側）
    maxAlloc: 2000,       // 1回の確保の上限（絶対値）
    maxAllocFactor: 3,    // 確保の大きさは自分のブロック長の 1/3 倍〜3 倍に限る
    reapAttempts: 2,      // 空きが無いときに取り除きを試す回数
    liveDrawK: 4          // 独立1件につき、そのとき走っていたプロセスから一様に引く個数
  };

  function createVM(opts, seed) {
    var p = {};
    Object.keys(DEFAULTS).forEach(function (k) { p[k] = DEFAULTS[k]; });
    if (opts) Object.keys(opts).forEach(function (k) { p[k] = opts[k]; });
    var M = p.memSize;
    var vm = {
      params: p,
      memSize: M,
      mem: new Uint8Array(M),        // 命令語。初期値は 0 = nop0
      owner: new Int32Array(M),      // 0 = 空き、それ以外は識別子（1 から）
      procs: [],                     // 走っているプロセス。先頭ほど古い（取り除きの待ち行列を兼ねる）
      nextPid: 1,
      rng: makeRng(seed >>> 0),                     // **系の進行**に使う乱数
      obsSeed: ((seed >>> 0) ^ 0x9e3779b9) >>> 0,   // **記録**だけに使う種（系に触れない）
      allocCursor: 0,
      freeCells: M,
      dirty: false,
      instr: 0, detaches: 0, reaps: 0, copyErrors: 0, faults: 0, allocFail: 0,
      movii: 0, moviiOut: 0, exec: 0, execOut: 0, allocs: 0, searches: 0,
      flips: 0,
      tmp: [],
      // ---- 記録 ----
      traceFrom: -1,      // この命令数以降に起きた独立だけを袋つきで残す（-1 なら残さない）
      traceCap: 400000,   // 記録する独立の上限（超えたら止める。K-26 の張り付き検査に使う）
      events: [],         // 独立の記録
      eventsDropped: 0,
      detachesBeforeTrace: 0
    };
    return vm;
  }

  /** 記録を始める（instr がこの値以上になってからの独立を袋つきで残す）。 */
  function traceFrom(vm, instr, cap) {
    vm.traceFrom = instr;
    if (cap !== undefined) vm.traceCap = cap;
    return vm;
  }

  function newProc(vm, start, len) {
    var p = {
      pid: vm.nextPid++,
      start: start, len: len,
      ip: start,
      ax: 0, bx: 0, cx: 0, dx: 0,
      stack: [],
      dstart: -1, dlen: 0, dwritten: 0,
      bag: null,                     // 開いている領域についての事実の袋
      faults: 0, detaches: 0,
      movii: 0, moviiOut: 0, exec: 0, execOut: 0,
      born: vm.instr,
      qi: vm.procs.length,
      dead: false
    };
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

  /** メモリへプログラムを置き、そこから始まるプロセスを作る。 */
  function inject(vm, code, addr) {
    for (var i = 0; i < code.length; i++) vm.mem[(addr + i) % vm.memSize] = code[i];
    claim(vm, addr, code.length, vm.nextPid);
    return newProc(vm, addr, code.length);
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
      if (a === 0) run = 0;              // ブロックは配列の端をまたがない
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

  /* ------------------------------------------------------------ 事実の袋 */

  function bump(h, key) { h[key] = (h[key] || 0) + 1; }

  /** 開いている領域についての袋を新しく作る。記録が止まっているときは null。 */
  function newBag(vm, pid, start, len) {
    if (vm.traceFrom < 0 || vm.instr < vm.traceFrom) return null;
    if (vm.events.length >= vm.traceCap) return null;
    return {
      allocPid: pid, allocAt: vm.instr, start: start, len: len,
      writeBy: {}, writeCodeAt: {}, writeSrcAt: {}, matchAt: {},
      writes: 0, searches: 0
    };
  }

  /**
   * そのとき走っているプロセスから一様に k 個引く（重複なし）。
   * **観測専用の乱数を使うので、系の進行には1ビットも影響しない。**
   *
   * **乱数は事象ごとに引き直す。** 走らせ役と共有した1本の系列から引くと、
   * 1事象あたりの消費が一定（棄却がほとんど起きないので k 回ちょうど）になり、
   * 巡回の走査位置と乱数の位相が噛み合ってしまう——実測で、引いた4個をまとめると
   * 一様（実効の母数 279.9 / 真の 273.2）なのに、**1番目の枠だけが偏った**
   * （実効の母数 314.9）。参照点が系の走査順と独立でなくなっていた。
   * 事象の量（命令数・識別子・独立の通し番号）から毎回種を作れば位相は消える。
   */
  function drawLive(vm, k, salt) {
    var live = vm.procs, n = live.length, out = [];
    if (n === 0) return out;
    var h = 2166136261;
    [vm.instr, salt | 0, vm.detaches, vm.obsSeed].forEach(function (v) {
      h ^= (v & 0xffff); h = Math.imul(h, 16777619);
      h ^= ((v >>> 16) & 0xffff); h = Math.imul(h, 16777619);
    });
    var rng = makeRng(h >>> 0);
    var used = {};
    for (var t = 0; t < k; t++) {
      for (var tries = 0; tries < 16; tries++) {
        var i = (rng() * n) | 0;
        if (i >= n) i = n - 1;
        var q = live[i];
        if (q.dead || used[q.pid]) continue;
        used[q.pid] = 1; out.push(q.pid); break;
      }
    }
    return out;
  }

  /** ブロックの中身から作る指紋。 */
  function blockHash(vm, start, len) {
    var h = 0x811c9dc5;
    for (var i = 0; i < len; i++) {
      h ^= vm.mem[(start + i) % vm.memSize];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return ('00000000' + h.toString(16)).slice(-8);
  }

  /** ブロックの中にメモリへ書き込む命令語があるか（機械的な事実）。 */
  function blockHasWriteOp(vm, start, len) {
    for (var i = 0; i < len; i++) if (vm.mem[(start + i) % vm.memSize] === OP_MOV_II) return true;
    return false;
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
    var M = vm.memSize, mem = vm.mem, own = vm.owner;
    var ip = p.ip;
    var op = mem[ip];
    var next = ip + 1 === M ? 0 : ip + 1;
    var outside = !inBlock(p, ip);

    p.exec++; vm.exec++;
    if (outside) { p.execOut++; vm.execOut++; }

    switch (op) {
      case 0: case 1: break;
      case 2: p.cx = 0; break;
      case 3: p.cx = (p.cx << 1) | 0; break;
      case 4: p.ax = (p.ax + 1) | 0; break;
      case 5: p.bx = (p.bx + 1) | 0; break;
      case 6: p.cx = (p.cx + 1) | 0; break;
      case 7: p.cx = (p.cx - 1) | 0; break;
      case 8: p.cx = (p.ax - p.bx) | 0; break;
      case 9: p.bx = p.ax; break;
      case 10: p.dx = p.cx; break;
      case 11: {                                      // mov_ii
        var src = wrap(vm, p.ax), dst = wrap(vm, p.bx);
        p.movii++; vm.movii++;
        if (outside) { p.moviiOut++; vm.moviiOut++; }
        var intoRegion = p.dlen > 0 && dst >= p.dstart && dst < p.dstart + p.dlen;
        var writable = inBlock(p, dst) || intoRegion;
        if (!writable) { fault(vm, p); break; }
        var v = mem[src];
        if (vm.params.copyErrorRate > 0 && vm.rng() < vm.params.copyErrorRate) {
          v = (vm.rng() * 32) | 0;
          vm.copyErrors++;
        }
        mem[dst] = v;
        if (intoRegion) {
          p.dwritten++;
          // ---- 記録: この書き込みが持っている事実 ----
          if (p.bag) {
            var b = p.bag;
            b.writes++;
            bump(b.writeBy, p.pid);          // 実行したプロセス
            bump(b.writeCodeAt, own[ip]);    // その命令が置かれていたセルの持ち主
            bump(b.writeSrcAt, own[src]);    // 複写元のセルの持ち主
          }
        }
        break;
      }
      case 12: push(p, p.ax); break;
      case 13: push(p, p.bx); break;
      case 14: push(p, p.cx); break;
      case 15: push(p, p.dx); break;
      case 16: p.ax = pop(vm, p); break;
      case 17: p.bx = pop(vm, p); break;
      case 18: p.cx = pop(vm, p); break;
      case 19: p.dx = pop(vm, p); break;
      case 20: case 21: case 22: case 24: case 25: case 26: {   // 探索を伴う命令
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
          var bk = searchBackward(vm, ip - 1 < 0 ? M - 1 : ip - 1, bits, lim);
          if (f < 0) hit = bk;
          else if (bk < 0) hit = f;
          else {
            var df = (f - ip + M) % M, db = (ip - bk + M) % M;
            hit = df <= db ? f : bk;
          }
        }
        if (hit < 0) { fault(vm, p); next = after; break; }
        vm.searches++;
        // ---- 記録: 照合が当たったセルの持ち主 ----
        if (p.bag) { p.bag.searches++; bump(p.bag.matchAt, own[hit]); }
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
      case 23: {
        if (p.stack.length === 0) { fault(vm, p); break; }
        next = wrap(vm, p.stack.pop());
        break;
      }
      case 27: if (p.cx !== 0) next = (next + 1) % M; break;
      case 28: if (p.cx === 0) next = (next + 1) % M; break;
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
        // 確保した領域は 0 で埋める（calloc と同じ約束事）
        for (var z = 0; z < n; z++) mem[s + z] = 0;
        p.dstart = s; p.dlen = n; p.dwritten = 0;
        p.bx = s;
        vm.allocs++;
        p.bag = newBag(vm, p.pid, s, n);   // 領域が開いた。ここから袋を貯め始める
        break;
      }
      case 30: {                                     // split
        if (p.dlen <= 0 || p.dwritten < p.dlen) { fault(vm, p); break; }
        var child = newProc(vm, p.dstart, p.dlen);   // **親を書き込まない**
        claim(vm, p.dstart, p.dlen, child.pid);
        p.detaches++; vm.detaches++;
        // ---- 記録: 独立が起きた。袋を閉じて事実を確定する ----
        if (p.bag) {
          var bag = p.bag;
          bag.splitPid = p.pid;
          bag.pid = child.pid;
          bag.at = vm.instr;
          bag.hash = blockHash(vm, child.start, child.len);
          bag.liveDraw = drawLive(vm, vm.params.liveDrawK, child.pid);
          bag.liveCount = vm.procs.length;
          // 袋に出てくる識別子それぞれについて、そのブロックの機械的な事実を控える
          var facts = {};
          var keys = {};
          keys[bag.allocPid] = 1; keys[bag.splitPid] = 1;
          [bag.writeBy, bag.writeCodeAt, bag.writeSrcAt, bag.matchAt].forEach(function (h) {
            Object.keys(h).forEach(function (k) { keys[k] = 1; });
          });
          bag.liveDraw.forEach(function (k) { keys[k] = 1; });
          Object.keys(keys).forEach(function (k) {
            var q = findProc(vm, +k);
            facts[k] = q
              ? { len: q.len, w: blockHasWriteOp(vm, q.start, q.len) ? 1 : 0, ex: q.movii > 0 ? 1 : 0 }
              : { len: 0, w: 0, ex: 0 };   // 既に取り除かれた識別子（または無主の 0）
          });
          bag.facts = facts;
          vm.events.push(bag);
        } else if (vm.traceFrom < 0 || vm.instr < vm.traceFrom) {
          vm.detachesBeforeTrace++;
        } else {
          vm.eventsDropped++;
        }
        shift(vm, p, 1);
        p.dstart = -1; p.dlen = 0; p.dwritten = 0; p.bag = null;
        break;
      }
      case 31: p.ax = p.bx; break;
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

  /** 識別子からプロセスを引く（袋を閉じるときにだけ使う。線形探索で足りる頻度）。 */
  function findProc(vm, pid) {
    if (!pid) return null;
    for (var i = 0; i < vm.procs.length; i++) {
      if (vm.procs[i].pid === pid && !vm.procs[i].dead) return vm.procs[i];
    }
    return null;
  }

  /* -------------------------------------------------------------- 実行の巡回 */

  function runRound(vm) {
    var n = vm.procs.length;
    var f = vm.params.sliceFactor;
    var died = false;
    for (var i = 0; i < n; i++) {
      var p = vm.procs[i];
      if (p.dead) { died = true; continue; }
      var slice = (p.len * f) | 0;
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

  /* ---------------------------------------------------------------- 状態ハッシュ */

  /**
   * **K-36 の欄。** メモリ全部・持ち主表・走っているプロセスの一切から作る指紋。
   * 二つの走行が同じトレースかどうかを、統計ではなくこれで決着させる。
   */
  function stateHash(vm) {
    var h = 0x811c9dc5;
    function mix(v) { h ^= (v | 0); h = Math.imul(h, 0x01000193) >>> 0; }
    for (var i = 0; i < vm.memSize; i++) { mix(vm.mem[i]); mix(vm.owner[i]); }
    var live = [];
    for (var j = 0; j < vm.procs.length; j++) if (!vm.procs[j].dead) live.push(vm.procs[j]);
    live.sort(function (a, b) { return a.start - b.start; });
    for (var k = 0; k < live.length; k++) {
      var p = live[k];
      mix(p.start); mix(p.len); mix(p.ip); mix(p.ax); mix(p.bx); mix(p.cx); mix(p.dx);
      mix(p.dstart); mix(p.dlen); mix(p.dwritten); mix(p.stack.length);
      for (var s = 0; s < p.stack.length; s++) mix(p.stack[s]);
    }
    mix(vm.instr); mix(vm.detaches); mix(vm.reaps); mix(vm.copyErrors); mix(vm.faults);
    mix(vm.movii); mix(vm.moviiOut); mix(vm.exec); mix(vm.execOut); mix(vm.allocs);
    return ('00000000' + (h >>> 0).toString(16)).slice(-8);
  }

  /** owner 配列を、プロセス一覧から作り直したもの（近道の検算用）。 */
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

  /** 走っているプロセスの機械的な記述（観測器が読む）。**帰属は含まない。** */
  function census(vm) {
    var out = [];
    for (var i = 0; i < vm.procs.length; i++) {
      var p = vm.procs[i];
      if (p.dead) continue;
      out.push({
        pid: p.pid, start: p.start, len: p.len,
        hash: blockHash(vm, p.start, p.len),
        hasWriteOp: blockHasWriteOp(vm, p.start, p.len),
        movii: p.movii, moviiOut: p.moviiOut, exec: p.exec, execOut: p.execOut,
        detaches: p.detaches, born: p.born
      });
    }
    return out;
  }

  function counters(vm) {
    return {
      instr: vm.instr, detaches: vm.detaches, reaps: vm.reaps, copyErrors: vm.copyErrors,
      faults: vm.faults, movii: vm.movii, moviiOut: vm.moviiOut, exec: vm.exec,
      execOut: vm.execOut, allocs: vm.allocs, allocFail: vm.allocFail, searches: vm.searches,
      population: vm.procs.length, freeCells: vm.freeCells,
      events: vm.events.length, eventsDropped: vm.eventsDropped,
      detachesBeforeTrace: vm.detachesBeforeTrace
    };
  }

  /** 自分を写すプログラムを1体だけ置いた系を作る。 */
  function seedWorld(opts, seed, source) {
    var vm = createVM(opts, seed);
    inject(vm, assemble(source || SOURCE_SELFCOPY), 0);
    return vm;
  }

  return {
    OPS: OPS, OPCODE: OPCODE, OP_MOV_II: OP_MOV_II, DEFAULTS: DEFAULTS,
    TEMPLATE_MAX: TEMPLATE_MAX,
    SOURCE_SELFCOPY: SOURCE_SELFCOPY, SOURCE_NOCOPY: SOURCE_NOCOPY,
    makeRng: makeRng, assemble: assemble, disassemble: disassemble,
    createVM: createVM, traceFrom: traceFrom, inject: inject, newProc: newProc,
    execOne: execOne, runRound: runRound, runInstructions: runInstructions,
    templateAt: templateAt, matchAt: matchAt,
    searchForward: searchForward, searchBackward: searchBackward,
    reapOne: reapOne, shift: shift, findProc: findProc,
    blockHash: blockHash, blockHasWriteOp: blockHasWriteOp,
    stateHash: stateHash, rebuildOwner: rebuildOwner,
    census: census, counters: counters, seedWorld: seedWorld,
    drawLive: drawLive
  };
});
