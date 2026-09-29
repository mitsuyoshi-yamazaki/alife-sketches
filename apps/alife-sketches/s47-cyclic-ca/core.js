/**
 * S-47 核 — κ 状態の格子と、範囲ρ・閾値θの局所遷移規則だけ。
 *
 * **上位概念の語彙を持たない。** cell / membrane / gene / organism / catalyst / fitness / alive を
 * 識別子にも分岐にも使わない。ここにあるのは「格子」「値」「近傍」「索引」「巻き数」「乱数」だけである。
 * 「渦巻き（spiral）」「相（phase）」といった本題材そのものの語彙は observer.js 側に置く——
 * ただし巻き数（winding number）の計算そのものは近傍の値だけから決まる純粋な格子演算なので、
 * ここに置く（S-33 の核が食い違い追跡を持つのと同じ扱い）。
 *
 * 依存ゼロ・古典スクリプト。Node（module.exports）とブラウザ（window.S47）で共用する。
 */
(function (global) {
  'use strict';

  // ---------------------------------------------------------------- 乱数・ハッシュ

  /** mulberry32。シードを固定すれば完全に再現する。 */
  function rng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** FNV-1a 32bit。格子の状態ハッシュ（K-36）。 */
  function hash(arr) {
    var h = 0x811c9dc5;
    for (var i = 0; i < arr.length; i++) {
      h ^= arr[i];
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    h ^= arr.length;
    h = Math.imul(h, 0x01000193) >>> 0;
    return ('00000000' + h.toString(16)).slice(-8);
  }

  // ---------------------------------------------------------------- 近傍の形（範囲ρ）

  /** 原点を除く、範囲ρの相対座標の一覧。shape: 'moore' | 'vonNeumann' | 'disk'。 */
  function shapeOffsets(shape, rho) {
    var out = [];
    for (var dy = -rho; dy <= rho; dy++) {
      for (var dx = -rho; dx <= rho; dx++) {
        if (dx === 0 && dy === 0) continue;
        if (shape === 'moore') { out.push([dx, dy]); }
        else if (shape === 'vonNeumann') { if (Math.abs(dx) + Math.abs(dy) <= rho) out.push([dx, dy]); }
        else if (shape === 'disk') { if (dx * dx + dy * dy <= rho * rho) out.push([dx, dy]); }
        else throw new Error('unknown neighborhoodShape: ' + shape);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- 境界

  function wrapIndex(v, n) { return ((v % n) + n) % n; }
  /** 鏡映境界（mirror）。端の外側は同じ辺を折り返して読む。 */
  function reflectIndex(v, n) {
    if (n === 1) return 0;
    var period = 2 * n - 2;
    var m = ((v % period) + period) % period;
    return m < n ? m : period - m;
  }
  /** boundary: 'periodic'（トーラス）| 'reflect'（鏡映）。 (x,y) → 1次元index。 */
  function makeIndexer(side, boundary) {
    var f = boundary === 'reflect' ? reflectIndex : wrapIndex;
    return function (x, y) { return f(y, side) * side + f(x, side); };
  }

  // ---------------------------------------------------------------- 近傍索引表（速い経路）

  /** side*side*offsets.length の Int32Array。境界処理込みで近傍位置を先に引いておく。 */
  function neighborIndex(side, boundary, offsets) {
    var idx = makeIndexer(side, boundary);
    var m = offsets.length;
    var table = new Int32Array(side * side * m);
    for (var y = 0; y < side; y++) {
      for (var x = 0; x < side; x++) {
        var b = (y * side + x) * m;
        for (var k = 0; k < m; k++) table[b + k] = idx(x + offsets[k][0], y + offsets[k][1]);
      }
    }
    return table;
  }

  // ---------------------------------------------------------------- 一歩（索引使用・速い経路）

  /**
   * 同期・決定論的な一歩。direction=+1 なら「次の色 (s+1) mod κ」を数える通常規則、
   * direction=-1 なら「前の色 (s-1) mod κ」を数える反転規則（負コントロール NC-2）。
   * κ=1 のとき target は常に 0 になり、mod 1 演算で例外なく退化する（positiveControls の κ=1 検算）。
   */
  function Stepper(side, kappa, theta, nbrIndex, neighCount, direction) {
    this.side = side; this.n = side * side; this.kappa = kappa; this.theta = theta;
    this.nbr = nbrIndex; this.m = neighCount; this.dir = direction || 1;
    this.field = new Uint8Array(this.n);
    this.lastChanged = new Int32Array(this.n);
    this.t = 0;
  }
  Stepper.prototype.reset = function (field) {
    this.field.set(field);
    this.lastChanged.fill(0);
    this.t = 0;
    return this;
  };
  /** 1歩進める。変わった点数を返す。**新しい値を tmp に全部決めてから流し込む**（読み取りが常に旧盤面になるようにする。K-12）。 */
  Stepper.prototype.step = function () {
    var n = this.n, kappa = this.kappa, theta = this.theta;
    var field = this.field, nbr = this.nbr, m = this.m;
    var target = ((this.dir % kappa) + kappa) % kappa;
    var nxt = this._nxt || (this._nxt = new Uint8Array(n));
    var changed = 0, i, k, b, s, want, cnt;
    for (i = 0; i < n; i++) {
      s = field[i];
      want = (s + target) % kappa;
      cnt = 0; b = i * m;
      for (k = 0; k < m; k++) if (field[nbr[b + k]] === want) cnt++;
      nxt[i] = cnt >= theta ? want : s;
    }
    var t1 = this.t + 1;
    for (i = 0; i < n; i++) {
      if (nxt[i] !== field[i]) { changed++; this.lastChanged[i] = t1; }
      field[i] = nxt[i];
    }
    this.t = t1;
    return changed;
  };

  // ---------------------------------------------------------------- 素朴な一歩（近道の検算用）

  /** 近傍索引表を使わず、毎回境界処理を計算し直す総当たり版。小さい格子でだけ Stepper と突き合わせる。 */
  function stepNaive(field, side, kappa, theta, shape, rho, boundary, direction) {
    var idx = makeIndexer(side, boundary);
    var offsets = shapeOffsets(shape, rho);
    var target = (((direction || 1) % kappa) + kappa) % kappa;
    var n = side * side, out = new Uint8Array(n);
    for (var y = 0; y < side; y++) {
      for (var x = 0; x < side; x++) {
        var i = y * side + x, s = field[i];
        var want = (s + target) % kappa, cnt = 0;
        for (var k = 0; k < offsets.length; k++) {
          if (field[idx(x + offsets[k][0], y + offsets[k][1])] === want) cnt++;
        }
        out[i] = cnt >= theta ? want : s;
      }
    }
    return out;
  }

  // ---------------------------------------------------------------- 負コントロール NC-1: 完全独立ランダム再割当

  function stepRandomReassign(field, kappa, rand) {
    var out = new Uint8Array(field.length);
    for (var i = 0; i < field.length; i++) out[i] = (rand() * kappa) | 0;
    return out;
  }

  // ---------------------------------------------------------------- 配置を作る

  function randomField(side, kappa, rand) {
    var n = side * side, f = new Uint8Array(n);
    for (var i = 0; i < n; i++) f[i] = (rand() * kappa) | 0;
    return f;
  }
  function uniformField(side, value) {
    var f = new Uint8Array(side * side);
    f.fill(value | 0);
    return f;
  }

  /** 参照点②: b×b のブロック単位で並べ替える。各ブロック内部のセル配置は保つ（K-33）。 */
  function blockShuffle(field, side, blockSize, rand) {
    var nb = Math.ceil(side / blockSize);
    var order = [];
    for (var i = 0; i < nb * nb; i++) order.push(i);
    for (i = order.length - 1; i > 0; i--) {
      var j = (rand() * (i + 1)) | 0, tmp = order[i]; order[i] = order[j]; order[j] = tmp;
    }
    var out = new Uint8Array(field.length);
    for (var by = 0; by < nb; by++) {
      for (var bx = 0; bx < nb; bx++) {
        var dst = order[by * nb + bx], dby = (dst / nb) | 0, dbx = dst % nb;
        for (var yy = 0; yy < blockSize; yy++) {
          var sy = by * blockSize + yy, dy = dby * blockSize + yy;
          if (sy >= side || dy >= side) continue;
          for (var xx = 0; xx < blockSize; xx++) {
            var sx = bx * blockSize + xx, dx = dbx * blockSize + xx;
            if (sx >= side || dx >= side) continue;
            out[dy * side + dx] = field[sy * side + sx];
          }
        }
      }
    }
    return out;
  }

  /**
   * 参照点①: rotor seed。中心 (cx,cy) 半径 radius の円板内を、角度を κ 段に量子化した色で埋める
   * （Greene–Greenberg–Hastings 1980 の巻き数不変量が非ゼロになる構成の、角度ベースの等価な作り方。
   * 原典が言う『円環上に1,2,...,κ-1を巡回配置』の離散な作り方は一意に定まらないため、
   * 中心のまわりに角度で単調に色が一周する、という不変量そのものが保たれる最小の作り方を採った。
   * raw/notes.md に申し送りあり）。
   */
  function rotorSeed(side, kappa, cx, cy, radius, phase) {
    var f = new Uint8Array(side * side);
    for (var y = 0; y < side; y++) {
      for (var x = 0; x < side; x++) {
        var dx = x - cx, dy = y - cy, r2 = dx * dx + dy * dy;
        if (r2 > 0 && r2 <= radius * radius) {
          var ang = Math.atan2(dy, dx) - phase;
          ang = ((ang % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
          f[y * side + x] = Math.floor(kappa * ang / (2 * Math.PI)) % kappa;
        }
      }
    }
    return f;
  }

  /** rotor の円板内だけ、色の多重集合を保ったまま位置をシャッフルする（参照点①のシャッフル版。巻き数を忘れる）。 */
  function shuffleDisk(field, side, cx, cy, radius, rand) {
    var out = new Uint8Array(field);
    var sites = [];
    for (var y = 0; y < side; y++) {
      for (var x = 0; x < side; x++) {
        var dx = x - cx, dy = y - cy, r2 = dx * dx + dy * dy;
        if (r2 > 0 && r2 <= radius * radius) sites.push(y * side + x);
      }
    }
    var vals = sites.map(function (i) { return field[i]; });
    for (var i = vals.length - 1; i > 0; i--) {
      var j = (rand() * (i + 1)) | 0, t = vals[i]; vals[i] = vals[j]; vals[j] = t;
    }
    sites.forEach(function (i, k) { out[i] = vals[k]; });
    return out;
  }

  // ---------------------------------------------------------------- 巻き数（渦巻きの芯の検出）

  /** κ を法とした差を (-κ/2, κ/2] へ丸める（巻き数計算の標準形）。 */
  function wrapDiff(a, b, kappa) {
    var raw = ((b - a) % kappa + kappa) % kappa;
    return raw > kappa / 2 ? raw - kappa : raw;
  }

  /** 基本ループ (x,y)-(x+1,y)-(x+1,y+1)-(x,y+1) 反時計回りの巻き数（整数）。 */
  function loopWinding(field, idx, x, y, kappa) {
    var a = field[idx(x, y)], b = field[idx(x + 1, y)], c = field[idx(x + 1, y + 1)], d = field[idx(x, y + 1)];
    var sum = wrapDiff(a, b, kappa) + wrapDiff(b, c, kappa) + wrapDiff(c, d, kappa) + wrapDiff(d, a, kappa);
    return Math.round(sum / kappa);
  }

  /** 格子全体の基本ループを数え上げ、非ゼロの巻き数を持つものの個数と密度を返す。 */
  function spiralDefects(field, side, kappa, boundary) {
    var idx = makeIndexer(side, boundary);
    var count = 0, n = side * side;
    for (var y = 0; y < side; y++) {
      for (var x = 0; x < side; x++) {
        if (loopWinding(field, idx, x, y, kappa) !== 0) count++;
      }
    }
    return { count: count, density: count / n };
  }

  // ---------------------------------------------------------------- 生存の検算（K-30）

  /** 各状態値の出現数。合計が side*side と一致するはず（誰も生まれず誰も消えない）。 */
  function histogram(field, kappa) {
    var h = new Array(kappa).fill(0);
    for (var i = 0; i < field.length; i++) h[field[i]]++;
    return h;
  }
  function inRange(field, kappa) {
    for (var i = 0; i < field.length; i++) if (field[i] < 0 || field[i] >= kappa) return false;
    return true;
  }

  /** t - lastChanged[i] >= thresholdSteps を満たす点の割合（『凍結』の第三区分。population.deadCountedAs）。 */
  function frozenFraction(lastChanged, t, thresholdSteps) {
    var n = lastChanged.length, c = 0;
    for (var i = 0; i < n; i++) if (t - lastChanged[i] >= thresholdSteps) c++;
    return c / n;
  }

  // ---------------------------------------------------------------- 周期検出（自己相関）

  function autocorr(series, lag) {
    var n = series.length - lag;
    if (n <= 1) return 0;
    var mean = 0, i;
    for (i = 0; i < series.length; i++) mean += series[i];
    mean /= series.length;
    var num = 0, den = 0;
    for (i = 0; i < series.length; i++) den += (series[i] - mean) * (series[i] - mean);
    for (i = 0; i < n; i++) num += (series[i] - mean) * (series[i + lag] - mean);
    return den === 0 ? 0 : num / den;
  }

  /** 相関係数が corrThreshold を超える最小の正のラグ。見つからなければ 0（criteria: 周期検出の上限 500）。 */
  function dominantPeriod(series, maxLag, corrThreshold) {
    var cap = Math.min(maxLag, series.length - 1);
    for (var lag = 1; lag <= cap; lag++) if (autocorr(series, lag) > corrThreshold) return lag;
    return 0;
  }

  function mode(values) {
    var counts = {}, best = null, bestCount = -1;
    values.forEach(function (v) {
      counts[v] = (counts[v] || 0) + 1;
      if (counts[v] > bestCount) { bestCount = counts[v]; best = v; }
    });
    return best;
  }

  var api = {
    rng: rng, hash: hash,
    shapeOffsets: shapeOffsets, makeIndexer: makeIndexer, neighborIndex: neighborIndex,
    Stepper: Stepper, stepNaive: stepNaive, stepRandomReassign: stepRandomReassign,
    randomField: randomField, uniformField: uniformField, blockShuffle: blockShuffle,
    rotorSeed: rotorSeed, shuffleDisk: shuffleDisk,
    wrapDiff: wrapDiff, loopWinding: loopWinding, spiralDefects: spiralDefects,
    histogram: histogram, inRange: inRange, frozenFraction: frozenFraction,
    autocorr: autocorr, dominantPeriod: dominantPeriod, mode: mode
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.S47 = api;
  if (typeof global !== 'undefined' && global && !global.S47) global.S47 = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
