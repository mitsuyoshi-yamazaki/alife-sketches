/**
 * S-05: 共有メモリ上で自分を複写する機械語プログラム（Tierra 風）
 *
 * 環状のバイト配列（メモリ）に 32 語の命令集合を持つ仮想機械を置く。各プロセスは
 * 自分のレジスタとスタックと命令ポインタを持ち、ラウンドロビンで少しずつ実行される。
 * プロセスは領域を確保し、そこへ自分自身を1命令ずつ書き写し、分裂して新しいプロセスを作る。
 * 書き写しには確率で誤りが混ざる。メモリが尽きたら待ち行列の先頭から取り除く。
 *
 * **番地指定はテンプレート照合で行う**（絶対番地を持たない）。探索命令の直後に並ぶ
 * nop0/nop1 の列をテンプレートとし、その**補完パターン**（0↔1 を入れ替えた列）が
 * メモリ上のどこにあるかを近い順に探す。書き写しで命令が1つずれても、絶対番地と違って
 * 参照は壊れにくい。これが Tierra の肝にあたる。
 *
 * 語彙について: この核には「生物」「寄生」「宿主」「適応度」「生死」という語も概念も無い。
 * あるのはメモリ・プロセス・確保記録・命令語・待ち行列だけである。
 * 「自分のブロックの外から複写命令を取得した」という機械的な事実だけを数え、
 * それを何と呼ぶかは観測器（run.js / viewer.html）の側にある。
 *
 * 出典（アイデアのみ。コードは参照していない）:
 *   Thomas S. Ray (1991) "An Approach to the Synthesis of Life",
 *   Artificial Life II, Santa Fe Institute Studies in the Sciences of Complexity.
 *
 * 依存ゼロ。Node（生ログ生成）とブラウザ（可視化）が同じファイルを読む。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S05 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------------------------------------------------------- 命令集合 */

  // 32 語ちょうどにしてある。書き写し誤りは 0..31 の一様乱数で置き換えるので、
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
    'alloc',  // 29 cx 個のセルを確保し、先頭を bx へ（確保記録はプロセスが持つ）
    'split',  // 30 確保した領域を独立したプロセスにする
    'mov_ba'  // 31 ax = bx
  ];
  var OPCODE = {};
  for (var _i = 0; _i < OPS.length; _i++) OPCODE[OPS[_i]] = _i;

  var OP_NOP0 = 0, OP_NOP1 = 1, OP_MOV_II = 11;
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

  /* ------------------------------------------------- 祖先プログラム（57 命令） */

  // **テンプレートは「直後に続く nop の極大列」**なので、テンプレートの直後に
  // 別の nop 列（目印や次のテンプレート）が来ると1本に繋がってしまう。
  // そこで境目に、実行されない区切り命令（mov_cd）を1つ挟んである。
  //
  // レイアウト（番地は先頭からの相対。全長 59）:
  //   0  先頭の目印 1111
  //   4  繰り返しの戻り先 0101
  //   8  自分の先頭を後方に探す → ax
  //  15  自分の末尾の目印を前方に探す → ax
  //  20  差を取って全長を作る
  //  25  全長ぶん確保して bx を書き込み先にする
  //  27  複写手続きを呼ぶ（テンプレート 0110 → 見出し 1001）
  //  32  分裂
  //  33  先頭へ戻って繰り返す
  //  39  複写手続きの見出し 1001
  //  55  末尾の目印 1110
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

  // 正コントロール用。**複写手続きを持たない**が、同じテンプレート 0110 で呼び出す。
  // 自分の中に見出し 1001 が無いので、探索は自分のブロックの外まで伸びる。全長 43。
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
    flipRate: 0,          // 背景の書き換え（命令1個の実行あたりの確率）。既定は切ってある
    sliceFactor: 0.2,     // 1巡で与える命令数 = max(1, floor(len * sliceFactor))
    searchLimit: 1024,    // テンプレート探索の届く距離（片側）
    maxAlloc: 2000,       // 1回の確保の上限（絶対値）
    maxAllocFactor: 3,    // 1回の確保の大きさは、自分のブロック長の 1/3 倍〜3 倍に限る
    reapAttempts: 16      // 空きが無いときに取り除きを試す回数
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
      owner: new Int32Array(M),      // 0 = 空き、それ以外は pid+1... ではなく pid（pid は 1 から）
      procs: [],                     // 生存プロセス。先頭ほど古い。**取り除きの待ち行列を兼ねる**
      nextPid: 1,
      rng: makeRng(seed >>> 0),
      allocCursor: 0,
      freeCells: M,
      dirty: false,
      instr: 0, births: 0, reaps: 0, copyErrors: 0, faults: 0, allocFail: 0,
      movii: 0, moviiOut: 0, exec: 0, execOut: 0,
      flips: 0,
      tmp: []
    };
    return vm;
  }

  function newProc(vm, start, len, parentPid) {
    var p = {
      pid: vm.nextPid++,
      start: start, len: len,
      ip: start,
      ax: 0, bx: 0, cx: 0, dx: 0,
      stack: [],
      dstart: -1, dlen: 0, dwritten: 0,
      faults: 0, births: 0,
      movii: 0, moviiOut: 0, exec: 0, execOut: 0,
      born: vm.instr, parent: parentPid || 0,
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
    return newProc(vm, addr, code.length, 0);
  }

  /* ------------------------------------------------------ テンプレート照合 */

  /** addr から続く nop の列を読む。返り値は使い回しの配列。 */
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

  /** a から始まる列が bits の補完パターンと一致するか。 */
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

  /**
   * 待ち行列の先頭（最も古い生存プロセス）を取り除く。返り値は空いた先頭番地。
   * except を渡すとそのプロセスだけは対象から外す——確保の途中で
   * 自分自身を取り除くと、確保した領域が持ち主のいないまま残る。
   */
  function reapOne(vm, except) {
    for (var i = 0; i < vm.procs.length; i++) {
      var p = vm.procs[i];
      if (p.dead || p === except) continue;
      p.dead = true;
      release(vm, p.start, p.len);
      if (p.dlen > 0) release(vm, p.dstart, p.dlen);
      vm.reaps++;
      // 巡回のどの時点で取り除かれても、その巡回の終わりに必ず詰め直す。
      // この印が無いと、既に通り過ぎた添字のプロセスが取り除かれた場合に
      // 生存一覧へ残り続け、観測器がそれを1個体として数えてしまう。
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

  /* ------------------------------------------------------------ 1命令の実行 */

  /**
   * 待ち行列の位置を1つ動かす。dir = -1 で先頭（取り除かれる側）へ、+1 で末尾へ。
   * vm.procs は実行の巡回順と取り除きの待ち行列を兼ねている。
   */
  function shift(vm, p, dir) {
    var i = p.qi, j = i + dir;
    if (j < 0 || j >= vm.procs.length) return;
    var q = vm.procs[j];
    if (vm.procs[i] !== p) return;   // 巡回中の取り除きで添字がずれている場合は何もしない
    vm.procs[i] = q; vm.procs[j] = p;
    p.qi = j; q.qi = i;
  }

  // 命令が成立しなかったプロセスは、取り除かれる側へ1つ寄る。
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
    var outside = !inBlock(p, ip);

    p.exec++; vm.exec++;
    if (outside) { p.execOut++; vm.execOut++; }

    switch (op) {
      case 0: case 1: break;                          // nop0 / nop1
      case 2: p.cx = 0; break;                        // zero
      case 3: p.cx = (p.cx << 1) | 0; break;          // shl
      case 4: p.ax = (p.ax + 1) | 0; break;
      case 5: p.bx = (p.bx + 1) | 0; break;
      case 6: p.cx = (p.cx + 1) | 0; break;
      case 7: p.cx = (p.cx - 1) | 0; break;
      case 8: p.cx = (p.ax - p.bx) | 0; break;        // sub_ab
      case 9: p.bx = p.ax; break;                     // mov_ab
      case 10: p.dx = p.cx; break;                    // mov_cd
      case 11: {                                      // mov_ii
        var src = wrap(vm, p.ax), dst = wrap(vm, p.bx);
        p.movii++; vm.movii++;
        if (outside) { p.moviiOut++; vm.moviiOut++; }
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
          // adr_*: 見つかったテンプレートの**先頭**を ax、距離を cx へ置いて次へ進む
          p.ax = hit;
          p.cx = Math.min((hit - ip + M) % M, (ip - hit + M) % M);
          next = after;
        } else {
          // jmp_*/call: 見つかったテンプレートの**直後**へ飛ぶ
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
        // 確保できる大きさは自分のブロック長の周りに限る。
        // 上限が無いと大きな確保が大量の取り除きを誘発し、下限が無いと
        // 「1セルだけ確保して split する」のが最速の増え方になってしまう。
        var f2 = vm.params.maxAllocFactor;
        var hi = Math.min(vm.params.maxAlloc, f2 * p.len);
        var lo = Math.max(1, (p.len / f2) | 0);
        if (n < lo || n > hi) { fault(vm, p); break; }
        var s = findFree(vm, n, p);
        if (s < 0) { fault(vm, p); vm.allocFail++; break; }
        if (p.dlen > 0) release(vm, p.dstart, p.dlen);
        claim(vm, s, n, p.pid);
        // 確保した領域は 0 で埋める（calloc と同じ約束事）。
        // 埋めないと、以前そこに居たプロセスの命令列がそのまま残り、
        // 「1命令だけ書いて split する」だけで中身のある領域を手に入れられてしまう。
        for (var z = 0; z < n; z++) mem[s + z] = 0;
        p.dstart = s; p.dlen = n; p.dwritten = 0;
        p.bx = s;
        break;
      }
      case 30: {                                     // split
        // 確保した領域は、その長さぶん書き込まれるまで独立させられない。
        // この条件が無いと「1命令だけ書いて split する」のが最速の増え方になる。
        if (p.dlen <= 0 || p.dwritten < p.dlen) { fault(vm, p); break; }
        var child = newProc(vm, p.dstart, p.dlen, p.pid);
        claim(vm, p.dstart, p.dlen, child.pid);
        p.births++; vm.births++;
        shift(vm, p, 1);
        p.dstart = -1; p.dlen = 0; p.dwritten = 0;
        break;
      }
      case 31: p.ax = p.bx; break;                   // mov_ba
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

  /** 1巡: その時点の生存プロセスそれぞれに持ち分の命令数を与える。 */
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

  /** 命令実行数が n 個ぶん進むまで巡回する。 */
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

  function hasCopyInstruction(vm, p) {
    for (var i = 0; i < p.len; i++) if (vm.mem[(p.start + i) % vm.memSize] === OP_MOV_II) return true;
    return false;
  }

  function counters(vm) {
    return { instr: vm.instr, movii: vm.movii, moviiOut: vm.moviiOut, exec: vm.exec, execOut: vm.execOut,
      births: vm.births, reaps: vm.reaps, copyErrors: vm.copyErrors, faults: vm.faults };
  }

  /**
   * 観測する。base に counters() の控えを渡すと、その時点から現在までの窓で
   * 取得アドレスの外部率を測る（渡さなければ走行全体）。
   */
  function measure(vm, base) {
    var b = base || { movii: 0, moviiOut: 0, exec: 0, execOut: 0, births: 0 };
    var lengths = {}, geno = {}, noCopy = 0, borrowers = 0, sumLen = 0, lens = [];
    for (var i = 0; i < vm.procs.length; i++) {
      var p = vm.procs[i];
      lengths[p.len] = (lengths[p.len] || 0) + 1;
      sumLen += p.len; lens.push(p.len);
      if (!hasCopyInstruction(vm, p)) noCopy++;
      if (p.movii > 0 && p.moviiOut / p.movii > 0.5) borrowers++;
      var key = p.len + '-' + blockHash(vm, p.start, p.len);
      geno[key] = (geno[key] || 0) + 1;
    }
    lens.sort(function (x, y) { return x - y; });
    var pop = vm.procs.length;
    var dMovii = vm.movii - b.movii, dOut = vm.moviiOut - b.moviiOut;
    var dExec = vm.exec - b.exec, dExecOut = vm.execOut - b.execOut;
    var top = Object.keys(geno).map(function (k) { return { genotype: k, count: geno[k] }; })
      .sort(function (x, y) { return y.count - x.count; }).slice(0, 8);
    return {
      population: pop,
      instr: vm.instr,
      foreignCopyFraction: dMovii > 0 ? dOut / dMovii : 0,
      foreignExecFraction: dExec > 0 ? dExecOut / dExec : 0,
      copyExec: dMovii,
      copyExecOutside: dOut,
      noCopyFraction: pop > 0 ? noCopy / pop : 0,
      noCopyCount: noCopy,
      borrowerFraction: pop > 0 ? borrowers / pop : 0,
      borrowerCount: borrowers,
      meanLength: pop > 0 ? sumLen / pop : 0,
      medianLength: pop > 0 ? lens[pop >> 1] : 0,
      minLength: pop > 0 ? lens[0] : 0,
      maxLength: pop > 0 ? lens[pop - 1] : 0,
      lengths: lengths,
      genotypeCount: Object.keys(geno).length,
      topGenotypes: top,
      births: vm.births - b.births,
      reaps: vm.reaps,
      copyErrors: vm.copyErrors,
      faults: vm.faults,
      allocFail: vm.allocFail,
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

  /** 祖先を1体だけ置いた系を作る。 */
  function seedWorld(opts, seed, source) {
    var vm = createVM(opts, seed);
    var code = assemble(source || SOURCE_SELFCOPY);
    inject(vm, code, 0);
    return vm;
  }

  return {
    OPS: OPS,
    OPCODE: OPCODE,
    OP_MOV_II: OP_MOV_II,
    DEFAULTS: DEFAULTS,
    TEMPLATE_MAX: TEMPLATE_MAX,
    SOURCE_SELFCOPY: SOURCE_SELFCOPY,
    SOURCE_NOCOPY: SOURCE_NOCOPY,
    makeRng: makeRng,
    assemble: assemble,
    disassemble: disassemble,
    createVM: createVM,
    inject: inject,
    newProc: newProc,
    execOne: execOne,
    runRound: runRound,
    runInstructions: runInstructions,
    templateAt: templateAt,
    matchAt: matchAt,
    searchForward: searchForward,
    searchBackward: searchBackward,
    reapOne: reapOne,
    shift: shift,
    measure: measure,
    counters: counters,
    hasCopyInstruction: hasCopyInstruction,
    blockHash: blockHash,
    rebuildOwner: rebuildOwner,
    seedWorld: seedWorld
  };
});
