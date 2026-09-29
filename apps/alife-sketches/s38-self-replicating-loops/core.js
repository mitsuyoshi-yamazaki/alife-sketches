/**
 * S-38 核 — 8 状態・von Neumann 近傍・4 回転対称の格子系。
 *
 * この核が知っているのは **状態・近傍・遷移表・書き込み予定表** だけである。
 * 「ループ」「複製」「親」「子」「遺伝子」といった語彙は 1 つも持たない
 * （それらは observer.js の側の語彙）。ここにあるのは
 *
 *   - 遷移表の文字列を読む            parseTransitions / buildTable
 *   - 8^5 の索引へ 4 回転で展開する    expandRotations
 *   - 場を 1 歩進める                 step
 *   - 場へ矩形を書き込む              writeBlock
 *   - 状態ハッシュ                    hashField
 *
 * 依存ゼロ・古典スクリプト。Node（module.exports）とブラウザ（window.S38）で共用する。
 */
(function (global) {
  'use strict';

  var N_STATES = 8;
  var SIZE = N_STATES * N_STATES * N_STATES * N_STATES * N_STATES; // 32768

  // ---------------------------------------------------------------- 乱数

  /** mulberry32。シード固定・移植可能。 */
  function rng(seed) {
    var a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ---------------------------------------------------------------- 遷移表

  /**
   * 索引 = ((((c*8 + n)*8 + e)*8 + s)*8 + w)。
   * n/e/s/w は上・右・下・左（原典 Table I の CTRBL と同じ並び）。
   */
  function idx(c, n, e, s, w) {
    return ((((c * 8 + n) * 8 + e) * 8 + s) * 8 + w);
  }

  /**
   * 遷移表のテキストを 6 桁の文字列の配列へ。
   * 受け付ける書式は 2 つ:
   *   "CTRBL->C'"  （原典 Table I。`#` 始まりは註釈）
   *   "CNESWC'"    （Golly の rule table。`n_states:` 等の見出し行は読み飛ばす）
   */
  function parseTransitions(text) {
    var out = [];
    var lines = String(text).split(/\r?\n/);
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i].replace(/#.*$/, '').trim();
      if (!line) continue;
      var m = line.match(/^([0-7]{5})\s*->\s*([0-7])$/);
      if (m) { out.push(m[1] + m[2]); continue; }
      if (/^[0-7]{6}$/.test(line)) { out.push(line); continue; }
      // 見出し行（n_states:8 など）は黙って読み飛ばす
    }
    return out;
  }

  /**
   * 4 回転で展開して 8^5 の索引を埋める。
   * 未指定の索引の扱いは undefinedPolicy で決める:
   *   'hold'    … 中央の状態を保つ（既定。Golly の rule table と同じ）
   *   'quiesce' … 0 にする
   * 矛盾（同じ近傍に違う出力）が出たら conflicts に積む。
   */
  function buildTable(transitions, opts) {
    opts = opts || {};
    var policy = opts.undefinedPolicy || 'hold';
    var out = new Uint8Array(SIZE);
    var seen = new Uint8Array(SIZE);
    var conflicts = [];
    var covered = 0;
    var i, r;

    for (i = 0; i < SIZE; i++) {
      var c0 = (i / (8 * 8 * 8 * 8)) | 0;
      out[i] = policy === 'quiesce' ? 0 : c0;
    }

    for (i = 0; i < transitions.length; i++) {
      var t = transitions[i];
      var c = +t[0], n = +t[1], e = +t[2], s = +t[3], w = +t[4], nx = +t[5];
      var q = [n, e, s, w];
      for (r = 0; r < 4; r++) {
        var j = idx(c, q[0], q[1], q[2], q[3]);
        if (seen[j] && out[j] !== nx) {
          conflicts.push({ index: j, had: out[j], got: nx, from: t });
        }
        if (!seen[j]) covered++;
        seen[j] = 1;
        out[j] = nx;
        q = [q[3], q[0], q[1], q[2]];   // 90 度回す
      }
    }
    return { out: out, seen: seen, covered: covered, conflicts: conflicts,
             nTransitions: transitions.length, undefinedPolicy: policy };
  }

  /** 恒等表（何も変わらない）。 */
  function buildHoldTable() {
    var out = new Uint8Array(SIZE);
    for (var i = 0; i < SIZE; i++) out[i] = (i / (8 * 8 * 8 * 8)) | 0;
    return { out: out, seen: null, covered: SIZE, conflicts: [], nTransitions: 0,
             undefinedPolicy: 'hold' };
  }

  /**
   * 加法表: 次の中央 = 上 ^ 右 ^ 下 ^ 左（3 ビットのビット毎の排他的論理和）。
   * GF(2)^3 上で線形なので、場の重ね合わせがそのまま保たれる。
   */
  function buildXorTable() {
    var out = new Uint8Array(SIZE);
    for (var c = 0; c < 8; c++)
      for (var n = 0; n < 8; n++)
        for (var e = 0; e < 8; e++)
          for (var s = 0; s < 8; s++)
            for (var w = 0; w < 8; w++)
              out[idx(c, n, e, s, w)] = (n ^ e ^ s ^ w);
    return { out: out, seen: null, covered: SIZE, conflicts: [], nTransitions: 0,
             undefinedPolicy: 'n/a' };
  }

  /**
   * 遷移表の**出力欄だけ**を割合 frac だけ引き直す。
   * 4 回転対称は保たれる（規則の一覧の段で置き換えてから展開するため）。
   */
  function perturbTransitions(transitions, frac, seed) {
    var rand = rng(seed);
    var out = transitions.slice();
    var changed = [];
    for (var i = 0; i < out.length; i++) {
      if (rand() < frac) {
        var old = +out[i][5];
        var nx = Math.floor(rand() * 8);
        if (nx === old) nx = (nx + 1) % 8;
        out[i] = out[i].slice(0, 5) + String(nx);
        changed.push(i);
      }
    }
    return { transitions: out, changed: changed };
  }

  // ---------------------------------------------------------------- 場

  function makeField(w, h, fill) {
    return { w: w, h: h, s: new Uint8Array(w * h).fill(fill || 0) };
  }

  function cloneField(f) {
    return { w: f.w, h: f.h, s: new Uint8Array(f.s) };
  }

  /**
   * 1 歩進める。**場は書き換えない**（新しい場を返す）。
   * 境界の外は状態 0（静止状態）として読む。
   */
  function step(f, table) {
    var w = f.w, h = f.h, a = f.s, out = new Uint8Array(w * h), T = table.out;
    for (var y = 0; y < h; y++) {
      var row = y * w;
      var up = (y > 0) ? row - w : -1;
      var dn = (y < h - 1) ? row + w : -1;
      for (var x = 0; x < w; x++) {
        var i = row + x;
        var c = a[i];
        var n = up >= 0 ? a[up + x] : 0;
        var s = dn >= 0 ? a[dn + x] : 0;
        var e = (x < w - 1) ? a[i + 1] : 0;
        var wv = (x > 0) ? a[i - 1] : 0;
        out[i] = T[((((c * 8 + n) * 8 + e) * 8 + s) * 8 + wv)];
      }
    }
    return { w: w, h: h, s: out };
  }

  /**
   * 1 歩進めながら、**踏んだ索引に印をつける**（mark は Uint8Array(SIZE)）。
   * どの規則が実際に使われたかを後から数えるために使う。速度が要る場面では使わない。
   */
  function stepMarking(f, table, mark) {
    var w = f.w, h = f.h, a = f.s, out = new Uint8Array(w * h), T = table.out;
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = y * w + x;
        var c = a[i];
        var n = y > 0 ? a[i - w] : 0;
        var s = y < h - 1 ? a[i + w] : 0;
        var e = x < w - 1 ? a[i + 1] : 0;
        var wv = x > 0 ? a[i - 1] : 0;
        var k = ((((c * 8 + n) * 8 + e) * 8 + s) * 8 + wv);
        mark[k] = 1;
        out[i] = T[k];
      }
    }
    return { w: w, h: h, s: out };
  }

  /** 印のついた索引が、一覧のどの規則から来たかを返す（4 回転の展開を逆にたどる）。 */
  function transitionsUsed(transitions, mark) {
    var used = [];
    for (var i = 0; i < transitions.length; i++) {
      var t = transitions[i];
      var c = +t[0], q = [+t[1], +t[2], +t[3], +t[4]];
      var hit = false;
      for (var r = 0; r < 4; r++) {
        if (mark[idx(c, q[0], q[1], q[2], q[3])]) hit = true;
        q = [q[3], q[0], q[1], q[2]];
      }
      if (hit) used.push(i);
    }
    return used;
  }

  /** 素朴な参照実装（近道の検算用。規則の一覧を毎回なめる）。 */
  function stepNaive(f, transitions, policy) {
    var w = f.w, h = f.h, a = f.s, out = new Uint8Array(w * h);
    for (var y = 0; y < h; y++) {
      for (var x = 0; x < w; x++) {
        var i = y * w + x;
        var c = a[i];
        var n = y > 0 ? a[i - w] : 0;
        var s = y < h - 1 ? a[i + w] : 0;
        var e = x < w - 1 ? a[i + 1] : 0;
        var wv = x > 0 ? a[i - 1] : 0;
        var res = policy === 'quiesce' ? 0 : c;
        for (var k = 0; k < transitions.length && res !== -1; k++) {
          var t = transitions[k];
          if (+t[0] !== c) continue;
          var q = [+t[1], +t[2], +t[3], +t[4]];
          for (var r = 0; r < 4; r++) {
            if (q[0] === n && q[1] === e && q[2] === s && q[3] === wv) { res = +t[5]; r = 9; k = transitions.length; }
            q = [q[3], q[0], q[1], q[2]];
          }
        }
        out[i] = res;
      }
    }
    return { w: w, h: h, s: out };
  }

  /** 場を反時計回りに 90 度回す（正方形のみ）。回転同変の検査に使う。 */
  function rotateField(f) {
    var w = f.w, h = f.h;
    var out = new Uint8Array(w * h);
    for (var y = 0; y < h; y++)
      for (var x = 0; x < w; x++)
        out[(w - 1 - x) * w + y] = f.s[y * w + x];
    return { w: h, h: w, s: out };
  }

  // ---------------------------------------------------------------- 矩形

  /** 文字の行の配列を矩形へ。空白は 0。 */
  function parseBlock(lines) {
    var h = lines.length, w = 0, i;
    for (i = 0; i < h; i++) if (lines[i].length > w) w = lines[i].length;
    var s = new Uint8Array(w * h);
    for (var y = 0; y < h; y++)
      for (var x = 0; x < lines[y].length; x++) {
        var ch = lines[y][x];
        s[y * w + x] = (ch === ' ' || ch === '.') ? 0 : (+ch || 0);
      }
    return { w: w, h: h, s: s };
  }

  /** 場へ矩形を書き込む。**場は書き換えない**（新しい場を返す）。 */
  function writeBlock(f, block, ox, oy) {
    var g = cloneField(f);
    for (var y = 0; y < block.h; y++) {
      var fy = oy + y;
      if (fy < 0 || fy >= f.h) continue;
      for (var x = 0; x < block.w; x++) {
        var fx = ox + x;
        if (fx < 0 || fx >= f.w) continue;
        g.s[fy * f.w + fx] = block.s[y * block.w + x];
      }
    }
    return g;
  }

  function rotateBlock(b) {
    var out = new Uint8Array(b.w * b.h);
    for (var y = 0; y < b.h; y++)
      for (var x = 0; x < b.w; x++)
        out[(b.w - 1 - x) * b.h + y] = b.s[y * b.w + x];
    return { w: b.h, h: b.w, s: out };
  }

  function mirrorBlock(b) {
    var out = new Uint8Array(b.w * b.h);
    for (var y = 0; y < b.h; y++)
      for (var x = 0; x < b.w; x++)
        out[y * b.w + (b.w - 1 - x)] = b.s[y * b.w + x];
    return { w: b.w, h: b.h, s: out };
  }

  /** 矩形の中身だけを引き直す（外接矩形と状態の多重集合はそのまま）。 */
  function shuffleBlock(b, seed, mask) {
    var rand = rng(seed);
    var pos = [], vals = [];
    for (var i = 0; i < b.s.length; i++) {
      if (mask && !mask(i % b.w, (i / b.w) | 0, b.s[i])) continue;
      pos.push(i); vals.push(b.s[i]);
    }
    for (var k = vals.length - 1; k > 0; k--) {
      var j = Math.floor(rand() * (k + 1));
      var tmp = vals[k]; vals[k] = vals[j]; vals[j] = tmp;
    }
    var out = new Uint8Array(b.s);
    for (var m = 0; m < pos.length; m++) out[pos[m]] = vals[m];
    return { w: b.w, h: b.h, s: out };
  }

  // ---------------------------------------------------------------- ハッシュ

  /** FNV-1a 32bit。8 桁の 16 進で返す。 */
  function hashField(f) {
    var hv = 0x811c9dc5, a = f.s;
    for (var i = 0; i < a.length; i++) {
      hv ^= a[i];
      hv = Math.imul(hv, 0x01000193) >>> 0;
    }
    return ('0000000' + hv.toString(16)).slice(-8);
  }

  /** 場の「中身だけ」のハッシュ（0 でない格子点の外接矩形を切り出す）。並進で不変。 */
  function hashSupport(f) {
    var x0 = f.w, y0 = f.h, x1 = -1, y1 = -1;
    for (var y = 0; y < f.h; y++)
      for (var x = 0; x < f.w; x++)
        if (f.s[y * f.w + x] !== 0) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
    if (x1 < 0) return '00000000';
    var hv = 0x811c9dc5;
    for (var yy = y0; yy <= y1; yy++)
      for (var xx = x0; xx <= x1; xx++) {
        hv ^= f.s[yy * f.w + xx];
        hv = Math.imul(hv, 0x01000193) >>> 0;
      }
    return ('0000000' + hv.toString(16)).slice(-8);
  }

  // ---------------------------------------------------------------- 走らせる

  /**
   * 走らせる。opts:
   *   field   … 初期の場
   *   table   … 遷移表
   *   steps   … 歩数
   *   writes  … 書き込み予定表 [{t, block, x, y}]。t の**直前**（その歩へ入る前）に書く
   *   onStep  … function(t, field) — 毎歩呼ぶ（観測はこちら側の仕事）
   */
  function run(opts) {
    var f = opts.field, table = opts.table, steps = opts.steps;
    var writes = opts.writes || [];
    var byT = {};
    for (var i = 0; i < writes.length; i++) {
      if (!byT[writes[i].t]) byT[writes[i].t] = [];
      byT[writes[i].t].push(writes[i]);
    }
    function applyWrites(t, g) {
      var ws = byT[t];
      if (!ws) return g;
      for (var k = 0; k < ws.length; k++) g = writeBlock(g, ws[k].block, ws[k].x, ws[k].y);
      return g;
    }
    f = applyWrites(0, f);
    if (opts.onStep) opts.onStep(0, f);
    for (var t = 1; t <= steps; t++) {
      f = step(f, table);
      f = applyWrites(t, f);
      if (opts.onStep) opts.onStep(t, f);
    }
    return f;
  }

  var api = {
    N_STATES: N_STATES, SIZE: SIZE,
    rng: rng, idx: idx,
    parseTransitions: parseTransitions, buildTable: buildTable,
    buildHoldTable: buildHoldTable, buildXorTable: buildXorTable,
    perturbTransitions: perturbTransitions,
    makeField: makeField, cloneField: cloneField, step: step, stepNaive: stepNaive,
    stepMarking: stepMarking, transitionsUsed: transitionsUsed,
    rotateField: rotateField,
    parseBlock: parseBlock, writeBlock: writeBlock, rotateBlock: rotateBlock,
    mirrorBlock: mirrorBlock, shuffleBlock: shuffleBlock,
    hashField: hashField, hashSupport: hashSupport, run: run,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.S38 = api;
})(typeof window !== 'undefined' ? window : this);
