/**
 * S-65: 核（core）。Ono–Ikegami 型の格子原始細胞の力学だけを持つ。
 * criteria.json system/protocol を参照。**上位概念の語彙を持たない**——膜・細胞・群れのIDは無い。
 * 状態はサイトごとの種の数（非負整数）だけ。Node と ブラウザで共用（UMD）。
 *
 * 三角格子: 斜交座標 (i,j)、6近傍 e_0..e_5（criteria.json system.space のとおり）。
 * 種: W(0) A(1) X(2) Y(3) M0(4) M1(5) M2(6)。選択の腕だけ P(7) を足す。
 *
 * 力学: 1刻み=全サイトを無作為順に1回ずつ訪れる掃引。サイトごとに種を無作為順に処理し、
 * その種の全経路（速度定数の和 P_s(x)）を求め、n_s(x) 粒子それぞれについて独立に
 * 「確率 P_s(x) で何かの経路を試す（経路は速度定数に比例して選ぶ）、確率 1-P_s(x) で何もしない」
 * を1回引く。これは K~Binomial(n,P_s(x)) 個の試行を引いてから経路を選ぶのと同じ分布になる
 * （粒子は匿名なので「どの粒子が試行したか」は意味を持たない）。受理は現在の φ で厳密に
 * Metropolis（min(1, exp(-ΔE·q))）。太陽（Y→X）だけは別枠: ΔE=G_X-G_Y（一定）に対し
 * 太陽が代金 e_ph=ΔE を払えば受理=1、払えなければ発火しない。
 */
(function (global) {
  'use strict';

  var Q_UNIT = 0.0005; // kT / q（熱浴の温度 kT=1）

  // ---- 種 ----
  var S_W = 0, S_A = 1, S_X = 2, S_Y = 3, S_M0 = 4, S_M1 = 5, S_M2 = 6, S_P = 7;
  var SPECIES_NAMES = ['W', 'A', 'X', 'Y', 'M0', 'M1', 'M2', 'P'];

  function isMembrane(s) { return s >= S_M0 && s <= S_M2; }
  function orientOf(s) { return s - S_M0; }
  function isHydro(s) { return s === S_W || s === S_A || s === S_P; }
  function isNeutral(s) { return s === S_X || s === S_Y; }

  // ---- 三角格子の6近傍（criteria.json system.space のとおり） ----
  var DI = [1, 0, -1, -1, 0, 1];
  var DJ = [0, 1, 1, 0, -1, -1];
  function opposite(k) { return (k + 3) % 6; }

  function wrap(v, L) { var r = v % L; return r < 0 ? r + L : r; }

  function makeLattice(L) {
    var nSites = L * L;
    function idx(i, j) { return wrap(i, L) * L + wrap(j, L); }
    function ijOf(x) { return { i: Math.floor(x / L), j: x % L }; }
    function neighbor(x, k) {
      var p = ijOf(x);
      return idx(p.i + DI[k], p.j + DJ[k]);
    }
    var neighTab = new Int32Array(nSites * 6);
    for (var x = 0; x < nSites; x++) for (var k = 0; k < 6; k++) neighTab[x * 6 + k] = neighbor(x, k);
    return { L: L, nSites: nSites, idx: idx, ijOf: ijOf, neighTab: neighTab, neighbor: function (x, k) { return neighTab[x * 6 + k]; } };
  }

  // ---- 決定論的 PRNG（mulberry32）。.state で内部状態を読める（較正の枝分かれの複製に使う）。 ----
  function makeRng(seed) {
    var a = seed >>> 0;
    var fn = function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      fn.state = a >>> 0;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    fn.state = a >>> 0;
    return fn;
  }
  function makeRngFromState(a) { return makeRng(a); }

  /**
   * ψ(s,s',d) 対のエネルギー表（q単位）。d: 0=同じサイト、1..6=e_0..e_5。
   * criteria.json system.pairEnergy のとおり: 全ての対の基底 34/16、
   * 親水–M_h 100/66(軸)/18(横)、中性–M_h 10/8(軸)/2(横)、M_h–M_h'（h≠hを含む）は基底のみ。
   * norep: 親水–M・中性–M の追加を全部0（基底だけ）。iso: 親水–M/中性–M の非等方を平均に均す。
   * （M_h–M_h' に「向きの違いによる追加の斥力」の数値が登録に無い件は raw/notes.md へ申し送り済み。
   *   本実装は登録の pairEnergy 表を文字どおり適用し、M–M は常に基底のみとする）
   */
  function buildPsi(NS, opts) {
    // 2026-09-26（S4のpsi-check.jsの検算で発覚。台帳K-2026-09-26-01）: 「全ての対の基底: 34/16。
    // これに加えて…」の「加えて」は文字どおり加算——親水–M・中性–M・M_h–M_h'（向きの違うMどうし）
    // の数値は基底の上に加える追加分であって、基底の置き換えではない。加算の読みだけが
    // staticPrecomputationのΔφ(X→M)=+6.364・Δφ(M→Y)=−6.374・等方Δφ(X→M)=+5.974・
    // S_hi固定点(9.68,1.67,9.99,8.66)を厳密に再現する（selftestで検算）。
    // 向きの違うMどうしの追加（+34/+16）は非等方だけに乗る（等方は「向きの違うMの追加の斥力は0」
    // と登録が明記する）。同じ向きのMどうし（s===s2）は基底のまま加算なし。
    opts = opts || {};
    var BASE0 = 34, BASE1 = 16;
    var psi = new Float64Array(NS * NS * 7);
    function set(s, s2, d, v) { psi[(s * NS + s2) * 7 + d] = v; }
    for (var s = 0; s < NS; s++) {
      for (var s2 = 0; s2 < NS; s2++) {
        for (var d = 0; d < 7; d++) {
          var val = d === 0 ? BASE0 : BASE1; // 全ての対の基底
          if (!opts.norep) {
            if (isMembrane(s) !== isMembrane(s2)) {
              var mSp = isMembrane(s) ? s : s2;
              var other = isMembrane(s) ? s2 : s;
              var h = orientOf(mSp);
              var axisMatch = d > 0 && ((d - 1) === h || (d - 1) === ((h + 3) % 6));
              if (isHydro(other)) val += opts.iso ? (d === 0 ? 100 : 34) : (d === 0 ? 100 : (axisMatch ? 66 : 18));
              else val += opts.iso ? (d === 0 ? 10 : 4) : (d === 0 ? 10 : (axisMatch ? 8 : 2));
            } else if (isMembrane(s) && isMembrane(s2) && s !== s2 && !opts.iso) {
              val += d === 0 ? BASE0 : BASE1; // 向きの違うMどうしの追加（非等方だけ）
            }
          }
          set(s, s2, d, val);
        }
      }
    }
    return psi;
  }

  function psiGet(psi, NS, s, s2, d) { return psi[(s * NS + s2) * 7 + d]; }

  function buildG(NS) {
    var G = new Float64Array(NS);
    G[S_W] = 0; G[S_A] = 10000; G[S_X] = 23800; G[S_Y] = 0;
    G[S_M0] = 8000; G[S_M1] = 8000; G[S_M2] = 8000;
    if (NS > S_P) G[S_P] = 10000;
    return G;
  }

  /**
   * 状態を作る。opts: {L, hasP, iso, norep, chemMode('normal'|'selM'|'sel0'), SX, seed,
   *   composition: [n_W,n_A,n_X,n_Y,n_M0,n_M1,n_M2,(n_P)] または関数(i,j)->composition,
   *   params: {kDif,kRot,k0,CA,CM,k3,s}（省略時は既定値）, sunStore（既定 1e14）}
   */
  function initState(opts) {
    var L = opts.L;
    var lat = makeLattice(L);
    var NS = opts.hasP ? 8 : 7;
    var psi = buildPsi(NS, { iso: !!opts.iso, norep: !!opts.norep });
    var G = buildG(NS);
    var params = Object.assign({
      kDif: 0.02, kRot: 0.02, k0: 1e-5, CA: 1.4e-4, CM: opts.noM ? 0 : 7e-5, k3: 0.002, s: 0.2,
    }, opts.params || {});
    var count = new Int32Array(NS * lat.nSites);
    var phi = new Float64Array(NS * lat.nSites);
    var state = {
      L: L, nSites: lat.nSites, NS: NS, lat: lat, psi: psi, G: G, params: params,
      hasP: !!opts.hasP, iso: !!opts.iso, norep: !!opts.norep, chemMode: opts.chemMode || 'normal',
      SX: opts.SX || 0, count: count, phi: phi, t: 0,
      rng: makeRng(opts.seed >>> 0),
      ledger: {
        Sun: opts.sunStore != null ? opts.sunStore : 1e14,
        Qc: { diffHydro: 0, diffNeutral: 0, diffM: 0, rotation: 0, catXA: 0, catXM: 0, decay: 0 },
        Qsunbath: 0,
        rateCapHits: 0, rateCapMax: 0, mDecayEvents: 0,
      },
    };
    // 初期組成
    for (var x = 0; x < lat.nSites; x++) {
      var comp = typeof opts.composition === 'function' ? opts.composition(lat.ijOf(x).i, lat.ijOf(x).j, state.rng) : opts.composition;
      for (var s = 0; s < NS; s++) {
        var n = comp[s] || 0;
        if (n > 0) setCount(state, s, x, n);
      }
    }
    return state;
  }

  function countAt(state, s, x) { return state.count[s * state.nSites + x]; }

  /** 種 s0 の粒子1個をサイト y に加える/取り除く（delta=+1/-1）。φ を増分で更新する。 */
  function applyDelta(state, y, s0, delta) {
    var NS = state.NS, psi = state.psi, phi = state.phi, nSites = state.nSites, lat = state.lat;
    for (var s = 0; s < NS; s++) phi[s * nSites + y] += psiGet(psi, NS, s, s0, 0) * delta;
    for (var k = 0; k < 6; k++) {
      var z = lat.neighbor(y, k);
      var d = opposite(k) + 1;
      for (var s2 = 0; s2 < NS; s2++) phi[s2 * nSites + z] += psiGet(psi, NS, s2, s0, d) * delta;
    }
    state.count[s0 * nSites + y] += delta;
  }

  function setCount(state, s, x, n) {
    var cur = countAt(state, s, x);
    if (n === cur) return;
    applyDelta(state, x, s, n - cur);
  }

  /** 全エネルギー H を数から数え直す（増分の φ の検算を兼ねる。criteria.json system.update）。 */
  function computeH(state) {
    var NS = state.NS, nSites = state.nSites, count = state.count, phi = state.phi, psi = state.psi, G = state.G;
    var U = 0, N = new Float64Array(NS);
    for (var s = 0; s < NS; s++) {
      var acc = 0;
      for (var x = 0; x < nSites; x++) {
        var n = count[s * nSites + x];
        if (n === 0) continue;
        acc += n;
        U += n * (phi[s * nSites + x] - psiGet(psi, NS, s, s, 0));
      }
      N[s] = acc;
    }
    U *= 0.5;
    var Hchem = 0;
    for (s = 0; s < NS; s++) Hchem += G[s] * N[s];
    return { U: U, H: U + Hchem, N: N };
  }

  function recomputePhiFromScratch(state) {
    var NS = state.NS, nSites = state.nSites, count = state.count;
    var phi2 = new Float64Array(NS * nSites);
    for (var x = 0; x < nSites; x++) {
      for (var s = 0; s < NS; s++) {
        var n = count[s * nSites + x];
        if (n === 0) continue;
        var save = phi2;
        for (var s2 = 0; s2 < NS; s2++) save[s2 * nSites + x] += psiGet(state.psi, NS, s2, s, 0) * n;
        for (var k = 0; k < 6; k++) {
          var z = state.lat.neighbor(x, k);
          var d = opposite(k) + 1;
          for (s2 = 0; s2 < NS; s2++) save[s2 * nSites + z] += psiGet(state.psi, NS, s2, s, d) * n;
        }
      }
    }
    return phi2;
  }

  var BUCKET = ['diffHydro', 'diffNeutral', 'diffM', 'rotation', 'catXA', 'catXM', 'decay'];

  /** 種 s がサイト x で今持つ経路の一覧（速度定数つき）を作る。criteria.json system.channels/selectionChemistry。 */
  function buildChannels(state, s, x) {
    var p = state.params, ch = [];
    for (var k = 0; k < 6; k++) {
      var bucket = isMembrane(s) ? 'diffM' : (isHydro(s) ? 'diffHydro' : 'diffNeutral');
      ch.push({ rate: p.kDif, bucket: bucket, kind: 'move', dir: k });
    }
    var a = countAt(state, S_A, x);
    var pP = state.hasP ? countAt(state, S_P, x) : 0;
    var c = a + pP;
    if (isMembrane(s)) {
      var h = orientOf(s);
      for (var h2 = 0; h2 < 3; h2++) if (h2 !== h) ch.push({ rate: p.kRot, bucket: 'rotation', kind: 'change', to: S_M0 + h2 });
      // 2026-09-26（S4のmf-check.js/meanfield.jsとの食い違いで発覚。台帳K-2026-09-26-02）:
      // criteria.json system.channels「X↔M_hの両向き」・selectionChemistryにM_h→Xの逆向きがあるが、
      // 核のbuildChannelsに無かった（往きだけの片道になっていた）。X→M_hと同じκ_M（両方向で同じ値）を足す。
      var kMX = state.chemMode === 'sel0' ? (p.k0 + p.CM * c * (c - 1)) : (p.k0 + p.CM * a * (a - 1));
      ch.push({ rate: kMX, bucket: 'catXM', kind: 'change', to: S_X });
      ch.push({ rate: p.k3, bucket: 'decay', kind: 'change', to: S_Y });
      return ch;
    }
    if (s === S_W) return ch; // 変化しない
    if (s === S_X) {
      var kXA, kXM;
      if (state.chemMode === 'sel0') { kXA = p.k0 + p.CA * a * (c - 1); }
      else { kXA = p.k0 + p.CA * a * (a - 1); }
      ch.push({ rate: kXA, bucket: 'catXA', kind: 'change', to: S_A });
      for (h = 0; h < 3; h++) {
        kXM = state.chemMode === 'sel0' ? (p.k0 + p.CM * c * (c - 1)) : (p.k0 + p.CM * a * (a - 1));
        ch.push({ rate: kXM, bucket: 'catXM', kind: 'change', to: S_M0 + h });
      }
      ch.push({ rate: p.k3, bucket: 'decay', kind: 'change', to: S_Y });
      if (state.hasP) {
        var kXP;
        if (state.chemMode === 'sel0') kXP = p.k0 + p.CA * pP * (c - 1);
        else kXP = p.k0 + p.CA * (1 + p.s) * pP * a;
        ch.push({ rate: kXP, bucket: 'catXA', kind: 'change', to: S_P });
      }
      return ch;
    }
    if (s === S_A) {
      var kAX = state.chemMode === 'sel0' ? (p.k0 + p.CA * (a - 1) * (c - 2)) : (p.k0 + p.CA * (a - 1) * (a - 2));
      ch.push({ rate: kAX, bucket: 'catXA', kind: 'change', to: S_X });
      ch.push({ rate: p.k3, bucket: 'decay', kind: 'change', to: S_Y });
      return ch;
    }
    if (s === S_P) {
      var kPX;
      if (state.chemMode === 'sel0') kPX = p.k0 + p.CA * (pP - 1) * (c - 2);
      else kPX = p.k0 + p.CA * (1 + p.s) * (pP - 1) * a;
      ch.push({ rate: kPX, bucket: 'catXA', kind: 'change', to: S_X });
      ch.push({ rate: p.k3, bucket: 'decay', kind: 'change', to: S_Y });
      return ch;
    }
    if (s === S_Y) {
      ch.push({ rate: p.k3, bucket: 'decay', kind: 'change', to: S_A });
      for (h = 0; h < 3; h++) ch.push({ rate: p.k3, bucket: 'decay', kind: 'change', to: S_M0 + h });
      ch.push({ rate: p.k3, bucket: 'decay', kind: 'change', to: S_X });
      if (state.hasP) ch.push({ rate: p.k3, bucket: 'decay', kind: 'change', to: S_P });
      ch.push({ rate: state.SX, bucket: 'sun', kind: 'sun', to: S_X });
      return ch;
    }
    return ch;
  }

  function eventDeltaE(state, x, s, ch) {
    var NS = state.NS, phi = state.phi, nSites = state.nSites, psi = state.psi, G = state.G, lat = state.lat;
    if (ch.kind === 'move') {
      var y = lat.neighbor(x, ch.dir);
      var d = ch.dir + 1;
      return (phi[s * nSites + y] - phi[s * nSites + x]) + psiGet(psi, NS, s, s, 0) - psiGet(psi, NS, s, s, d);
    }
    var s2 = ch.to;
    return (G[s2] - G[s]) + (phi[s2 * nSites + x] - psiGet(psi, NS, s2, s, 0)) - (phi[s * nSites + x] - psiGet(psi, NS, s, s, 0));
  }

  /** M_h→Y の化学的な消失を数える（τ_M＝壁のMの滞在時間の実測に使う。selfMaint の算出）。 */
  function isMembraneDecay(s, ch) { return isMembrane(s) && ch.kind === 'change' && ch.to === S_Y; }

  function applyEvent(state, x, s, ch, dE) {
    if (isMembraneDecay(s, ch)) state.ledger.mDecayEvents++;
    if (ch.kind === 'move') {
      var y = state.lat.neighbor(x, ch.dir);
      applyDelta(state, x, s, -1);
      applyDelta(state, y, s, +1);
    } else {
      applyDelta(state, x, s, -1);
      applyDelta(state, x, ch.to, +1);
    }
    if (ch.kind === 'sun') {
      var ePh = state.G[S_X] - state.G[S_Y];
      if (!state.payless) state.ledger.Sun -= ePh;
      state.ledger.Qsunbath += (ePh - dE);
    } else {
      state.ledger.Qc[ch.bucket] += (-dE);
    }
  }

  var EPH = 23800; // = G_X - G_Y（criteria.json system.chemicalPotential）

  /** 1刻み（全サイトを無作為順に訪れる掃引）。 */
  function sweep(state) {
    var lat = state.lat, rng = state.rng, nSites = state.nSites, NS = state.NS;
    var order = new Int32Array(nSites);
    for (var i = 0; i < nSites; i++) order[i] = i;
    for (i = nSites - 1; i > 0; i--) { var j = Math.floor(rng() * (i + 1)); var t = order[i]; order[i] = order[j]; order[j] = t; }
    var speciesOrder = new Int32Array(NS);
    for (i = 0; i < NS; i++) speciesOrder[i] = i;
    for (var xi = 0; xi < nSites; xi++) {
      var x = order[xi];
      for (i = NS - 1; i > 0; i--) { j = Math.floor(rng() * (i + 1)); t = speciesOrder[i]; speciesOrder[i] = speciesOrder[j]; speciesOrder[j] = t; }
      for (var si = 0; si < NS; si++) {
        var s = speciesOrder[si];
        var n = countAt(state, s, x);
        if (n <= 0) continue;
        var chs = buildChannels(state, s, x);
        var Ptot = 0; for (var ci = 0; ci < chs.length; ci++) Ptot += chs[ci].rate;
        var scale = 1;
        if (Ptot > 0.9) { scale = 0.9 / Ptot; state.ledger.rateCapHits++; state.ledger.rateCapMax = Math.max(state.ledger.rateCapMax, Ptot); Ptot = 0.9; }
        for (var slot = 0; slot < n; slot++) {
          var u = rng();
          if (u >= Ptot) continue;
          var acc = 0, chosen = null;
          for (ci = 0; ci < chs.length; ci++) { acc += chs[ci].rate * scale; if (u < acc) { chosen = chs[ci]; break; } }
          if (!chosen) continue;
          var dE = eventDeltaE(state, x, s, chosen);
          var accept;
          if (chosen.kind === 'sun') accept = state.payless || state.ledger.Sun >= EPH;
          else {
            var qEff = (state.hotRot && chosen.bucket === 'rotation') ? Q_UNIT / 5 : Q_UNIT; // E-hotrot: 回転だけ kT=5
            accept = dE <= 0 || rng() < Math.exp(-dE * qEff);
          }
          if (accept) applyEvent(state, x, s, chosen, dE);
        }
      }
    }
    state.t++;
  }

  /** 状態の複製（較正腕 E-base/E-hotrot/E-nopay が E-prep から枝分かれするために使う）。 */
  function cloneState(state, overrides) {
    var ns = {
      L: state.L, nSites: state.nSites, NS: state.NS, lat: state.lat, psi: state.psi, G: state.G,
      params: Object.assign({}, state.params, (overrides && overrides.params) || {}),
      hasP: state.hasP, iso: state.iso, norep: state.norep, chemMode: state.chemMode,
      SX: overrides && overrides.SX != null ? overrides.SX : state.SX,
      count: state.count.slice(), phi: state.phi.slice(), t: state.t,
      rng: makeRngFromState(state.rng.state),
      ledger: {
        Sun: state.ledger.Sun, Qc: Object.assign({}, state.ledger.Qc), Qsunbath: state.ledger.Qsunbath,
        rateCapHits: state.ledger.rateCapHits, rateCapMax: state.ledger.rateCapMax,
      },
      hotRot: (overrides && overrides.hotRot) || false,
      payless: (overrides && overrides.payless) || false,
    };
    return ns;
  }

  function stateHash(state) {
    var h = 2166136261 >>> 0;
    for (var i = 0; i < state.count.length; i++) {
      h ^= state.count[i]; h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  }

  function snapshotCounts(state) {
    // 種ごとの数を Uint16 配列にして base64 化（rawLogPlan snapshots/）
    var out = {};
    for (var s = 0; s < state.NS; s++) {
      var arr = new Uint16Array(state.nSites);
      for (var x = 0; x < state.nSites; x++) arr[x] = state.count[s * state.nSites + x];
      out[SPECIES_NAMES[s]] = Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64');
    }
    return out;
  }

  function muField(state) {
    var L = state.L, nSites = state.nSites, mu = new Float64Array(nSites);
    for (var x = 0; x < nSites; x++) {
      var tot = 0, m = 0;
      for (var s = 0; s < state.NS; s++) { var n = countAt(state, s, x); tot += n; if (isMembrane(s)) m += n; }
      mu[x] = tot > 0 ? m / tot : 0;
    }
    return mu;
  }

  function aField(state) {
    var a = new Float64Array(state.nSites);
    for (var x = 0; x < state.nSites; x++) a[x] = countAt(state, S_A, x);
    return a;
  }

  function speciesField(state, s) {
    var f = new Float64Array(state.nSites);
    for (var x = 0; x < state.nSites; x++) f[x] = countAt(state, s, x);
    return f;
  }

  var CORE = {
    Q_UNIT: Q_UNIT, EPH: EPH,
    S_W: S_W, S_A: S_A, S_X: S_X, S_Y: S_Y, S_M0: S_M0, S_M1: S_M1, S_M2: S_M2, S_P: S_P,
    SPECIES_NAMES: SPECIES_NAMES, BUCKET: BUCKET,
    isMembrane: isMembrane, orientOf: orientOf, isHydro: isHydro, isNeutral: isNeutral,
    DI: DI, DJ: DJ, opposite: opposite, wrap: wrap,
    makeLattice: makeLattice, makeRng: makeRng, makeRngFromState: makeRngFromState, buildPsi: buildPsi, psiGet: psiGet, buildG: buildG,
    initState: initState, countAt: countAt, applyDelta: applyDelta, setCount: setCount,
    computeH: computeH, recomputePhiFromScratch: recomputePhiFromScratch,
    buildChannels: buildChannels, eventDeltaE: eventDeltaE, applyEvent: applyEvent,
    sweep: sweep, stateHash: stateHash, snapshotCounts: snapshotCounts, cloneState: cloneState,
    muField: muField, aField: aField, speciesField: speciesField,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = CORE;
  global.S65Core = CORE;
})(typeof window !== 'undefined' ? window : globalThis);
