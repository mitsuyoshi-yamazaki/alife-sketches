/**
 * S-31 観測器 — **上位概念の語彙はここにある**。
 *
 * 核（core.js）は「種・近傍・つなぎ・遷移規則」しか知らない。
 * 「囲い（enclosure）」「壁（wall）」「開き（opening）」「作り直し（turnover）」は
 * すべて観測器の側の語彙である。**核を書き換えずに、ここだけ差し替えれば別の読み方になる。**
 *
 * 主な量:
 *   E2 enclosedByReach  … 種B から「つながった種C を通らずに」到達できる範囲が有界か（主）
 *   E1 enclosedByWinding… つなぎの閉路が種B を巻いているか（副。E2 との一致を検査に使う）
 *   siteNullFrac        … 参照点 RP-a。同じ配置で「種B がどこに居たか」だけを忘れた場合の期待値
 *                         （＝有界な成分に属する非壁マスの割合）。**帰無値 0 の超過量を作る**
 *   rewireNullFrac      … 参照点 RP-b。種C の位置はそのままに、つなぎだけ引き直す
 *   wallTurnover        … 囲いの壁にいる種C のうち、直近の窓のあいだに生まれた粒子の割合
 *   pickIdentity        … Pick の定理による恒等式。実装の外から来る正コントロール（K-18）
 *
 * 依存ゼロ・古典スクリプト。
 */
(function (global) {
  'use strict';

  var S31 = (typeof require === 'function' && typeof module !== 'undefined')
    ? require('./core.js') : global.S31;

  var D4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  // ------------------------------------------------------------------ 壁と成分

  /** 「壁」= 次数 1 以上の種C がいるマス。次数 0 の種C は通れるので壁ではない。 */
  function wallMask(f) {
    var w = new Uint8Array(f.n);
    for (var s = 0; s < f.n; s++) w[s] = (f.sp[s] === S31.C && S31.deg(f, s) > 0) ? 1 : 0;
    return w;
  }

  /**
   * 非壁マスを 4 連結で成分に分ける。トーラスなので「外側」は無い——
   * 代わりに**成分がトーラスを一周するか**を、展開座標の食い違いで判定する。
   * 壁は Moore-8 でつながるので、4 連結の塗りは斜めのつなぎを漏れない（デジタル位相の定石）。
   */
  function components(f, wall) {
    var n = f.n, label = new Int32Array(n), ux = new Int32Array(n), uy = new Int32Array(n);
    label.fill(-1);
    var wraps = [], size = [], comp = 0, queue = new Int32Array(n);
    for (var s0 = 0; s0 < n; s0++) {
      if (wall[s0] || label[s0] >= 0) continue;
      var head = 0, tail = 0, cnt = 0, wr = 0;
      label[s0] = comp; ux[s0] = s0 % f.w; uy[s0] = (s0 / f.w) | 0;
      queue[tail++] = s0;
      while (head < tail) {
        var s = queue[head++]; cnt++;
        for (var k = 0; k < 4; k++) {
          var t = f.nb4[s * 4 + k];
          if (wall[t]) continue;
          var nx = ux[s] + D4[k][0], ny = uy[s] + D4[k][1];
          if (label[t] < 0) { label[t] = comp; ux[t] = nx; uy[t] = ny; queue[tail++] = t; }
          else if (label[t] === comp && (ux[t] !== nx || uy[t] !== ny)) wr = 1;
        }
      }
      wraps.push(wr); size.push(cnt); comp++;
    }
    return { label: label, wraps: wraps, size: size, nComp: comp };
  }

  /** ある成分を囲っている壁マスの集合（成分に Moore-8 で接する壁）。 */
  function enclosingWall(f, wall, label, comp) {
    var seen = {}, out = [];
    for (var s = 0; s < f.n; s++) {
      if (label[s] !== comp) continue;
      for (var k = 0; k < 8; k++) {
        var t = f.nb8[s * 8 + k];
        if (wall[t] && !seen[t]) { seen[t] = 1; out.push(t); }
      }
    }
    return out;
  }

  // ------------------------------------------------------------------ 閉路（E1）

  /**
   * つなぎのグラフから「すべての頂点が次数 2」の連結成分＝単純閉路を取り出す。
   * 展開座標で歩き、一周したときの変位が (0,0) なら可縮（トーラスを巻いていない）。
   */
  function cycles(f) {
    var seen = new Uint8Array(f.n), out = [];
    for (var s0 = 0; s0 < f.n; s0++) {
      if (f.sp[s0] !== S31.C || seen[s0] || S31.deg(f, s0) !== 2) continue;
      var pts = [], sites = [], ok = true;
      var x = s0 % f.w, y = (s0 / f.w) | 0;
      var prev = -1, cur = s0;
      while (true) {
        seen[cur] = 1; sites.push(cur); pts.push([x, y]);
        var a = f.j0[cur], b = f.j1[cur];
        if (a < 0 || b < 0) { ok = false; break; }
        var nxt = (a === prev) ? b : a;
        x += S31.dx(f, cur, nxt); y += S31.dy(f, cur, nxt);
        prev = cur; cur = nxt;
        if (cur === s0) break;
        if (S31.deg(f, cur) !== 2 || seen[cur]) { ok = false; break; }
        if (sites.length > f.n) { ok = false; break; }
      }
      if (!ok || sites.length < 4) continue;
      var closed = (x === (s0 % f.w)) && (y === ((s0 / f.w) | 0));
      out.push({ sites: sites, pts: pts, len: sites.length, contractible: closed,
                 area: closed ? shoelace(pts) : null });
    }
    return out;
  }

  function shoelace(pts) {
    var a = 0, m = pts.length;
    for (var i = 0, j = m - 1; i < m; j = i++) a += pts[j][0] * pts[i][1] - pts[i][0] * pts[j][1];
    return Math.abs(a) / 2;
  }

  /** 単純多角形の内外判定（交差数）。頂点そのものは外から呼ばない約束。 */
  function inPolygon(pts, px, py) {
    var inside = false, m = pts.length;
    for (var i = 0, j = m - 1; i < m; j = i++) {
      var yi = pts[i][1], yj = pts[j][1];
      if ((yi > py) !== (yj > py)) {
        var xint = pts[i][0] + (py - yi) * (pts[j][0] - pts[i][0]) / (yj - yi);
        if (px < xint) inside = !inside;
      }
    }
    return inside;
  }

  /**
   * Pick の定理 A = I + B/2 - 1。本系のつなぎは全て原始ベクトル（|dx|,|dy| <= 1）なので
   * 境界上の格子点の数 B は閉路の長さに等しい。したがって I = A - len/2 + 1。
   * **これは実装の外から来る恒等式**（K-18）で、面積の求め方（外積の和）と
   * 内外判定（交差数）という**別々の経路**を突き合わせる。
   */
  function pickIdentity(cyc) {
    if (!cyc.contractible) return null;
    var predicted = cyc.area - cyc.len / 2 + 1;
    var minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity, i;
    for (i = 0; i < cyc.pts.length; i++) {
      if (cyc.pts[i][0] < minx) minx = cyc.pts[i][0];
      if (cyc.pts[i][0] > maxx) maxx = cyc.pts[i][0];
      if (cyc.pts[i][1] < miny) miny = cyc.pts[i][1];
      if (cyc.pts[i][1] > maxy) maxy = cyc.pts[i][1];
    }
    var onEdge = {};
    for (i = 0; i < cyc.pts.length; i++) onEdge[cyc.pts[i][0] + ',' + cyc.pts[i][1]] = 1;
    var counted = 0;
    for (var y = miny; y <= maxy; y++) {
      for (var x = minx; x <= maxx; x++) {
        if (onEdge[x + ',' + y]) continue;
        if (inPolygon(cyc.pts, x, y)) counted++;
      }
    }
    return { predicted: predicted, counted: counted, ok: Math.abs(predicted - counted) < 1e-9 };
  }

  // ------------------------------------------------------------------ 測る

  /**
   * ある時刻の観測。
   * pop1 = 非壁マス全部（種B が居られるマス）／pop2 = 空きと種A のマスだけ
   */
  function observe(f, opt) {
    opt = opt || {};
    var wall = wallMask(f);
    var cc = components(f, wall);
    var loc = S31.locate(f, f.bPids);

    var nonWall = 0, boundedNonWall = 0, pop2 = 0, boundedPop2 = 0;
    for (var s = 0; s < f.n; s++) {
      if (wall[s]) continue;
      nonWall++;
      var bounded = !cc.wraps[cc.label[s]];
      if (bounded) boundedNonWall++;
      if (f.sp[s] === S31.EMPTY || f.sp[s] === S31.A) {
        pop2++;
        if (bounded) boundedPop2++;
      }
    }

    var cycs = null;
    if (opt.winding) cycs = cycles(f);

    var marks = [];
    for (var i = 0; i < f.bPids.length; i++) {
      var pid = f.bPids[i], site = loc[pid];
      if (site === undefined) { marks.push({ pid: pid, site: -1, enclosed: 0 }); continue; }
      var comp = cc.label[site];
      var enclosed = comp >= 0 && !cc.wraps[comp] ? 1 : 0;
      var m = { pid: pid, site: site, comp: comp, enclosed: enclosed,
                compSize: comp >= 0 ? cc.size[comp] : -1 };
      if (opt.winding) m.wound = windingEncloses(f, cycs, site) ? 1 : 0;
      if (enclosed && opt.wall) {
        var ew = enclosingWall(f, wall, cc.label, comp);
        m.wallLen = ew.length;
        m.wallSites = ew;
        // McMullin (1997/2004) が名指しした機構を直接見るための記述子:
        // 「内側が、つながって動けなくなった種C で詰まり、作り直しの材料が尽きる」
        var fi = 0, si = 0, ei = 0;
        for (var q = 0; q < f.n; q++) {
          if (cc.label[q] !== comp) continue;
          if (f.sp[q] === S31.C) fi++;            // 成分に居る種C は定義上すべて次数 0
          else if (f.sp[q] === S31.A) si++;
          else if (f.sp[q] === S31.EMPTY) ei++;
        }
        m.freeInside = fi; m.substrateInside = si; m.emptyInside = ei;
        m.roomInside = si + ei;
        if (opt.since !== undefined) {
          var fresh = 0;
          for (var k = 0; k < ew.length; k++) {
            var p = f.pid[ew[k]];
            if (p >= 0 && f.birth[p] > opt.since) fresh++;
          }
          m.turnover = ew.length ? fresh / ew.length : 0;
        }
        m.budgetRatio = ew.length
          ? (f.opt.pCombine) / (f.opt.pSplit * ew.length) : null;
      }
      marks.push(m);
    }

    return {
      t: f.t, wall: wall, cc: cc, marks: marks, cycles: cycs,
      nonWall: nonWall,
      siteNullFrac: nonWall ? boundedNonWall / nonWall : 0,
      siteNullFrac2: pop2 ? boundedPop2 / pop2 : 0,
      enclosedFrac: marks.length
        ? marks.reduce(function (a, m) { return a + m.enclosed; }, 0) / marks.length : 0,
    };
  }

  function windingEncloses(f, cycs, bSite) {
    for (var i = 0; i < cycs.length; i++) {
      var c = cycs[i];
      if (!c.contractible) continue;
      var s0 = c.sites[0];
      var bx = c.pts[0][0] + S31.dx(f, s0, bSite);
      var by = c.pts[0][1] + S31.dy(f, s0, bSite);
      if (inPolygon(c.pts, bx, by)) return true;
    }
    return false;
  }

  // ------------------------------------------------------------------ 参照点 RP-b

  /**
   * RP-b: 種C の**位置はそのまま**に、つなぎだけを引き直す。
   * 同じ本数・同じ規則（Moore-8・次数 2 まで・交差禁止・角度制限）で結び直す。
   * **「つながっている粒子の集まり」の在庫は保たれ、どこがどう結ばれていたかだけが失われる。**
   */
  function rewireNull(f, seed) {
    var g = { opt: f.opt, w: f.w, h: f.h, n: f.n, sp: f.sp,
              pid: f.pid, birth: f.birth, bPids: f.bPids, t: f.t,
              nb4: f.nb4, nb8: f.nb8,
              j0: new Int32Array(f.n), j1: new Int32Array(f.n),
              ev: { cross: 0 } };
    g.j0.fill(-1); g.j1.fill(-1);

    var target = 0, cs = [], s;
    for (s = 0; s < f.n; s++) {
      if (f.sp[s] !== S31.C) continue;
      cs.push(s);
      target += S31.deg(f, s);
    }
    target = target / 2;

    var rng = new S31.Rng(seed >>> 0);
    var made = 0, guard = 0, limit = Math.max(200, target * 200);
    while (made < target && guard++ < limit) {
      var a = cs[rng.int(cs.length)];
      if (S31.deg(g, a) >= 2) continue;
      var b = g.nb8[a * 8 + rng.int(8)];
      if (S31.canJoin(g, a, b)) { S31.linkRaw(g, a, b); made++; }
    }
    return { field: g, joinsMade: made, joinsWanted: target };
  }

  // ------------------------------------------------------------------ 外からの穴あけ

  /**
   * 囲いの壁から種C を 1 個だけ取り除く（split と同じ形: 種C + 隣の空き -> 種A 2 個）。
   * **保存量を壊さない**ので、本番中に何度当てても収支の検査はそのまま通る。
   */
  function puncture(f, wallSites, rng) {
    var order = wallSites.slice();
    for (var i = order.length - 1; i > 0; i--) {
      var j = rng.int(i + 1), tmp = order[i]; order[i] = order[j]; order[j] = tmp;
    }
    for (var k = 0; k < order.length; k++) {
      var s = order[k];
      if (f.sp[s] !== S31.C) continue;
      var holes = [], m, t;
      for (m = 0; m < 4; m++) { t = f.nb4[s * 4 + m]; if (f.sp[t] === S31.EMPTY) holes.push(t); }
      if (!holes.length) continue;
      S31.dropAllJoins(f, s);
      f.sp[s] = S31.A; f.pid[s] = -1;
      var h = holes[rng.int(holes.length)];
      f.sp[h] = S31.A; f.pid[h] = -1;
      return s;
    }
    return -1;
  }

  // ------------------------------------------------------------------ 鎖の記述子

  function chainStats(f) {
    var st = { nC: 0, free: 0, ends: 0, mid: 0, nJoins: 0, cycleCount: 0, cycleLenMax: 0,
               contractible: 0, wrapping: 0, inCycle: 0, wallSites: 0 };
    for (var s = 0; s < f.n; s++) {
      if (f.sp[s] !== S31.C) continue;
      st.nC++;
      var d = S31.deg(f, s);
      st.nJoins += d;
      if (d === 0) st.free++; else if (d === 1) st.ends++; else st.mid++;
      if (d > 0) st.wallSites++;
    }
    st.nJoins /= 2;
    var cs = cycles(f);
    st.cycleCount = cs.length;
    for (var i = 0; i < cs.length; i++) {
      st.inCycle += cs[i].len;
      if (cs[i].len > st.cycleLenMax) st.cycleLenMax = cs[i].len;
      if (cs[i].contractible) st.contractible++; else st.wrapping++;
    }
    return st;
  }

  var api = {
    wallMask: wallMask, components: components, enclosingWall: enclosingWall,
    cycles: cycles, shoelace: shoelace, inPolygon: inPolygon, pickIdentity: pickIdentity,
    observe: observe, windingEncloses: windingEncloses,
    rewireNull: rewireNull, puncture: puncture, chainStats: chainStats,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  global.S31obs = api;
})(typeof window !== 'undefined' ? window : this);
