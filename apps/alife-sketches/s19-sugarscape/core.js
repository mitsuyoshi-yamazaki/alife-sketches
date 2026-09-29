/*
 * S-19 core — 格子・資源・行為者・保有量 だけの核。
 *
 * この層が持つ語彙は field（格子）・capacity（容量）・level（現在量）・regrowth（回復）・
 * mover（行為者）・store（保有量）・range（視界）・drain（消費）・uptake（取得量）だけである。
 * 社会科学・生物学の上位概念を指す語は1つも置かない（method の K-5）。
 * 分布の偏りを語るのは measures.js の側だけ。禁止語の一覧は selftest.js の T37 にある。
 *
 * 依存ゼロ。Node と ブラウザで共用する（UMD 風）。
 */
(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module && typeof module.exports === 'object') module.exports = api;
  if (typeof window !== 'undefined') window.S19 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- 乱数
  // mulberry32。シードを与えれば完全に再現する。
  function makeRng(seed) {
    var a = (seed >>> 0) || 0x9e3779b9;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function randInt(rng, lo, hi) { // 両端を含む
    return lo + Math.floor(rng() * (hi - lo + 1));
  }

  // ---------------------------------------------------------------- 地形
  var PEAK_CENTERS = [[15, 35], [35, 15]];
  var PEAK_RINGS = [[5, 4], [10, 3], [15, 2], [20, 1]];

  function peakCapacityAt(x, y, size) {
    var scale = size / 50;
    var best = 0;
    for (var c = 0; c < PEAK_CENTERS.length; c++) {
      var cx = PEAK_CENTERS[c][0] * scale;
      var cy = PEAK_CENTERS[c][1] * scale;
      var d = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy));
      for (var r = 0; r < PEAK_RINGS.length; r++) {
        if (d <= PEAK_RINGS[r][0] * scale) { if (PEAK_RINGS[r][1] > best) best = PEAK_RINGS[r][1]; break; }
      }
    }
    return best;
  }

  // terrain:
  //   'peaks'      2つの山（原典の形）
  //   'flat-total' 一様。**総容量を peaks と同じに固定する**
  //   'flat-peak'  一様。**最大容量を peaks と同じ（4）に固定する**
  function buildCapacity(size, terrain) {
    var n = size * size;
    var cap = new Float64Array(n);
    var i, x, y;
    if (terrain === 'peaks') {
      for (y = 0; y < size; y++) for (x = 0; x < size; x++) cap[y * size + x] = peakCapacityAt(x, y, size);
      return cap;
    }
    if (terrain === 'flat-peak') {
      for (i = 0; i < n; i++) cap[i] = 4;
      return cap;
    }
    if (terrain === 'flat-total') {
      var total = 0;
      for (y = 0; y < size; y++) for (x = 0; x < size; x++) total += peakCapacityAt(x, y, size);
      var v = total / n;
      for (i = 0; i < n; i++) cap[i] = v;
      return cap;
    }
    throw new Error('unknown terrain: ' + terrain);
  }

  // ---------------------------------------------------------------- 既定の設定
  function defaults() {
    return {
      size: 50,
      terrain: 'peaks',
      regrowth: 1,
      count: 250,
      rangeMin: 1,
      rangeMax: 6,
      drainMin: 1,
      drainMax: 4,
      storeMin: 5,
      storeMax: 25,
      identicalMovers: false,   // true なら range・drain を全員同じ（範囲の中央）にする
      identicalStore: false,    // true なら初期保有量を全員同じにする
      motion: 'seek',           // 'seek' | 'blind' | 'still'
      consume: true,            // false なら取得しても格子の量が減らない
      replacement: false,       // true なら取り除かれた行為者の数だけ新しい行為者を投入する
      seed: 1
    };
  }

  function mergeConfig(cfg) {
    var d = defaults(), out = {}, k;
    for (k in d) if (Object.prototype.hasOwnProperty.call(d, k)) out[k] = d[k];
    if (cfg) for (k in cfg) if (Object.prototype.hasOwnProperty.call(cfg, k)) out[k] = cfg[k];
    return out;
  }

  // ---------------------------------------------------------------- 世界

  // 行為者を1体、指定の場所へ投入する。返り値は初期保有量。
  function placeMover(w, idx, bornAt) {
    var c = w.config, rng = w.rng, d = w._draw;
    var rangeV = c.identicalMovers ? d.midRange : randInt(rng, c.rangeMin, c.rangeMax);
    var drainV = c.identicalMovers ? d.midDrain : randInt(rng, c.drainMin, c.drainMax);
    var storeV = c.identicalStore ? d.midStore : randInt(rng, c.storeMin, c.storeMax);
    var id = w.movers.length;
    w.movers.push({
      id: id,
      x: idx % w.size,
      y: Math.floor(idx / w.size),
      range: rangeV,
      drain: drainV,
      store: storeV,
      uptake: 0,
      age: 0,
      born: bornAt,
      removed: false,
      removedAt: -1
    });
    w.occupied[idx] = id;
    return storeV;
  }

  function makeWorld(cfg) {
    var c = mergeConfig(cfg);
    var size = c.size, n = size * size;
    var rng = makeRng(c.seed);

    var capacity = buildCapacity(size, c.terrain);
    var level = new Float64Array(n);
    for (var i = 0; i < n; i++) level[i] = capacity[i]; // 満たされた状態から始める

    var occupied = new Int32Array(n);
    for (i = 0; i < n; i++) occupied[i] = -1;

    var movers = [];
    var free = [];
    for (i = 0; i < n; i++) free.push(i);
    // Fisher-Yates で先頭 count 個を取る
    for (i = 0; i < c.count; i++) {
      var j = i + Math.floor(rng() * (free.length - i));
      var tmp = free[i]; free[i] = free[j]; free[j] = tmp;
    }

    var midRange = Math.floor((c.rangeMin + c.rangeMax) / 2);
    var midDrain = Math.floor((c.drainMin + c.drainMax) / 2);
    var midStore = (c.storeMin + c.storeMax) / 2;

    var draw = { midRange: midRange, midDrain: midDrain, midStore: midStore };
    var seedWorld = { config: c, size: size, occupied: occupied, movers: movers, rng: rng, _draw: draw };
    var initialStoreSum = 0;
    for (i = 0; i < c.count; i++) initialStoreSum += placeMover(seedWorld, free[i], 0);

    var initialLevelSum = 0;
    for (i = 0; i < n; i++) initialLevelSum += level[i];

    return {
      config: c,
      size: size,
      capacity: capacity,
      level: level,
      occupied: occupied,
      movers: movers,
      present: c.count,
      time: 0,
      rng: rng,
      ledger: {
        initialLevelSum: initialLevelSum,
        initialStoreSum: initialStoreSum,
        totalRegrown: 0,
        totalUptake: 0,
        totalTaken: 0,   // 格子から実際に取り除かれた量（consume=false なら 0 のまま）
        totalDrain: 0,
        removedStoreSum: 0
      },
      _draw: draw,
      _pendingReplace: 0,
      _order: new Int32Array(c.count),
      _candIdx: new Int32Array(4 * Math.max(c.rangeMax, 1) + 1),
      _candDist: new Int32Array(4 * Math.max(c.rangeMax, 1) + 1)
    };
  }

  var DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  // 視界内の候補地（空いている場所のみ。占有地は通り抜けて先を見る）。
  // 現在地は常に候補に含む。
  function gatherCandidates(w, m, outIdx, outDist) {
    var size = w.size, occupied = w.occupied;
    var k = 0;
    outIdx[k] = m.y * size + m.x; outDist[k] = 0; k++;
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1];
      for (var s = 1; s <= m.range; s++) {
        var nx = m.x + dx * s, ny = m.y + dy * s;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) break;
        var j = ny * size + nx;
        if (occupied[j] !== -1) continue;
        outIdx[k] = j; outDist[k] = s; k++;
      }
    }
    return k;
  }

  function chooseSite(w, m) {
    if (w.config.motion === 'still') return m.y * w.size + m.x;
    var idxBuf = w._candIdx, distBuf = w._candDist;
    var k = gatherCandidates(w, m, idxBuf, distBuf);
    if (w.config.motion === 'blind') return idxBuf[Math.floor(w.rng() * k)];
    // seek: 量が最大 -> 距離が最小 -> 同点は一様乱択
    var bestLevel = -Infinity, bestDist = Infinity, tied = 0, pick = idxBuf[0];
    var level = w.level;
    for (var t = 0; t < k; t++) {
      var lv = level[idxBuf[t]], ds = distBuf[t];
      if (lv > bestLevel + 1e-12 || (Math.abs(lv - bestLevel) <= 1e-12 && ds < bestDist)) {
        bestLevel = lv; bestDist = ds; tied = 1; pick = idxBuf[t];
      } else if (Math.abs(lv - bestLevel) <= 1e-12 && ds === bestDist) {
        tied++;
        if (w.rng() < 1 / tied) pick = idxBuf[t];
      }
    }
    return pick;
  }

  function step(w) {
    var movers = w.movers, size = w.size, level = w.level, occupied = w.occupied;
    var led = w.ledger;

    // 進行順を毎歩シャッフルする
    var order = w._order;
    var nm = movers.length;
    if (order.length < nm) { order = new Int32Array(nm); w._order = order; }
    for (var i = 0; i < nm; i++) order[i] = i;
    for (i = nm - 1; i > 0; i--) {
      var j = Math.floor(w.rng() * (i + 1));
      var tmp = order[i]; order[i] = order[j]; order[j] = tmp;
    }

    for (var o = 0; o < nm; o++) {
      var m = movers[order[o]];
      if (m.removed) continue;
      var from = m.y * size + m.x;
      var to = chooseSite(w, m);
      if (to !== from) {
        occupied[from] = -1;
        occupied[to] = m.id;
        m.x = to % size;
        m.y = (to - m.x) / size;
      }
      var got = level[to];
      if (w.config.consume) { level[to] = 0; led.totalTaken += got; }
      m.uptake += got;
      led.totalUptake += got;
      var next = m.store + got - m.drain;
      if (next < 0) {
        led.totalDrain += m.store + got; // 払える分だけ払って取り除かれる
        led.removedStoreSum += 0;
        m.store = 0;
        m.removed = true;
        m.removedAt = w.time + 1;
        occupied[m.y * size + m.x] = -1;
        w.present--;
        if (w.config.replacement) w._pendingReplace++;
      } else {
        led.totalDrain += m.drain;
        m.store = next;
        m.age++;
      }
    }

    // 回復
    var cap = w.capacity, alpha = w.config.regrowth, nn = level.length, grown = 0;
    for (i = 0; i < nn; i++) {
      var lv = level[i];
      if (lv < cap[i]) {
        var nv = lv + alpha; if (nv > cap[i]) nv = cap[i];
        grown += nv - lv;
        level[i] = nv;
      }
    }
    led.totalRegrown += grown;

    // 取り除かれた数だけ、空いている場所へ新しい行為者を投入する
    while (w._pendingReplace > 0) {
      var freeCount = 0;
      for (i = 0; i < occupied.length; i++) if (occupied[i] === -1) freeCount++;
      if (freeCount === 0) break;
      var pickNth = Math.floor(w.rng() * freeCount), seen = -1, spot = -1;
      for (i = 0; i < occupied.length; i++) {
        if (occupied[i] === -1) { seen++; if (seen === pickNth) { spot = i; break; } }
      }
      if (spot < 0) break;
      led.initialStoreSum += placeMover(w, spot, w.time + 1);
      w.present++;
      w._pendingReplace--;
    }
    w.time++;
  }

  function run(w, steps) { for (var s = 0; s < steps; s++) step(w); return w; }

  // ---------------------------------------------------------------- 収支の検算
  function ledgerCheck(w) {
    var i, sumLevel = 0, sumStore = 0;
    for (i = 0; i < w.level.length; i++) sumLevel += w.level[i];
    for (i = 0; i < w.movers.length; i++) if (!w.movers[i].removed) sumStore += w.movers[i].store;
    var led = w.ledger;
    return {
      levelResidual: sumLevel - (led.initialLevelSum + led.totalRegrown - led.totalTaken),
      storeResidual: sumStore - (led.initialStoreSum + led.totalUptake - led.totalDrain),
      sumLevel: sumLevel,
      sumStore: sumStore
    };
  }

  // 占有索引が素朴な総当たりと一致するか（K-12 の「近道の検算」）
  function occupancyCheck(w) {
    var size = w.size, brute = new Int32Array(size * size);
    var i;
    for (i = 0; i < brute.length; i++) brute[i] = -1;
    for (i = 0; i < w.movers.length; i++) {
      var m = w.movers[i];
      if (m.removed) continue;
      var idx = m.y * size + m.x;
      if (brute[idx] !== -1) return { ok: false, reason: 'two movers on one site', site: idx };
      brute[idx] = m.id;
    }
    for (i = 0; i < brute.length; i++) if (brute[i] !== w.occupied[i]) return { ok: false, reason: 'index mismatch', site: i, index: w.occupied[i], brute: brute[i] };
    return { ok: true };
  }

  // 観測器が数える対象の数と、系が持っている数（K-12 の「生存の検算」）
  function presentCount(w) {
    var c = 0;
    for (var i = 0; i < w.movers.length; i++) if (!w.movers[i].removed) c++;
    return c;
  }

  // ---------------------------------------------------------------- 取り出し
  // population: 'present' | 'ever' | 'aged'
  // quantity:   'store' | 'storePlusUnderfoot' | 'uptake'
  function extract(w, population, quantity) {
    var out = [], i, m, v;
    var size = w.size;
    for (i = 0; i < w.movers.length; i++) {
      m = w.movers[i];
      if (population === 'present' && m.removed) continue;
      if (population === 'aged' && (m.removed || m.age < 50)) continue;
      if (quantity === 'store') v = m.store;
      else if (quantity === 'uptake') v = m.uptake;
      else v = m.store + (m.removed ? 0 : w.level[m.y * size + m.x]);
      out.push(v);
    }
    return out;
  }

  function snapshotLevels(w) {
    var out = new Float64Array(w.level.length);
    out.set(w.level);
    return out;
  }

  return {
    makeRng: makeRng,
    randInt: randInt,
    defaults: defaults,
    mergeConfig: mergeConfig,
    buildCapacity: buildCapacity,
    peakCapacityAt: peakCapacityAt,
    makeWorld: makeWorld,
    placeMover: placeMover,
    step: step,
    run: run,
    extract: extract,
    ledgerCheck: ledgerCheck,
    occupancyCheck: occupancyCheck,
    presentCount: presentCount,
    snapshotLevels: snapshotLevels,
    gatherCandidates: gatherCandidates,
    chooseSite: chooseSite
  };
});
