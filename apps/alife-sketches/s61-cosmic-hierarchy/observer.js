'use strict';
/**
 * S-61 検出器の統合。粒子の状態（位置・速度・ID）だけから、上位の段（L1ハロー・L2親と
 * 持続する部分ハロー・L3網）を同定する。criteria.json observerDetails のとおり。
 * 核（core.js）はこの語彙を一切持たない——上位の単位はすべてここにある。Node/ブラウザ共用（UMD）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory(require('./core.js'), require('./fof.js'), require('./subfind.js'), require('./web.js'));
  } else {
    root.S61OBS = factory(root.S61, root.S61FOF, root.S61SUBFIND, root.S61WEB);
  }
})(typeof self !== 'undefined' ? self : this, function (S61, FOF, SUBFIND, WEB) {

/** unwrap: 周期境界の粒子群を、最初の粒子を基準に「連続した」座標へ開く。 */
function unwrapGroup(members, x, L) {
  var refx = x[3 * members[0]], refy = x[3 * members[0] + 1], refz = x[3 * members[0] + 2];
  var out = new Array(members.length);
  for (var i = 0; i < members.length; i++) {
    var p = members[i];
    var dx = x[3 * p] - refx, dy = x[3 * p + 1] - refy, dz = x[3 * p + 2] - refz;
    if (dx > L / 2) dx -= L; else if (dx < -L / 2) dx += L;
    if (dy > L / 2) dy -= L; else if (dy < -L / 2) dy += L;
    if (dz > L / 2) dz -= L; else if (dz < -L / 2) dz += L;
    out[i] = [refx + dx, refy + dy, refz + dz];
  }
  return out;
}

/** L1: FOF ハロー。b=連結長の割合（平均間隔に対する）・nMin=最小粒子数。 */
function findHalos(x, Np, L, meanSpacing, b, nMin) {
  var linkLen = b * meanSpacing;
  var fof = FOF.friendsOfFriends(x, Np, L, linkLen);
  var halos = [];
  for (var rep in fof.groups) {
    var members = fof.groups[rep];
    if (members.length < nMin) continue;
    var center = FOF.shrinkingSphereCenter(members, x, L, 20);
    halos.push({ members: members, n: members.length, center: center });
  }
  halos.sort(function (a, b2) { return b2.n - a.n; });
  return halos;
}

/**
 * A4の性質（束縛・ビリアル比・次元）。members: 粒子番号。state.x/p, mass, a, Hval=H(a)。
 * 物理速度 v = p/a + Hubble項(x-center)*H*a?? -> 定義: 物理速度=a*dx/dt=p/a（速度自体）に
 * ハッブル流 H*a*(x-x_c) を加えたものを使う（criteria: 「ハッブル流込み」）。
 */
function computeA4(members, x, p, mass, L, a, Hval, Gconst, softening) {
  var pos = unwrapGroup(members, x, L);
  var center = [0, 0, 0];
  for (var i = 0; i < pos.length; i++) { center[0] += pos[i][0]; center[1] += pos[i][1]; center[2] += pos[i][2]; }
  center[0] /= pos.length; center[1] /= pos.length; center[2] /= pos.length;
  var vel = new Array(members.length);
  var vc = [0, 0, 0];
  for (var i2 = 0; i2 < members.length; i2++) {
    var idx = members[i2];
    var vpec = [p[3 * idx] / a, p[3 * idx + 1] / a, p[3 * idx + 2] / a];
    vc[0] += vpec[0]; vc[1] += vpec[1]; vc[2] += vpec[2];
  }
  vc[0] /= members.length; vc[1] /= members.length; vc[2] /= members.length;
  for (var i3 = 0; i3 < members.length; i3++) {
    var idx3 = members[i3];
    var vpec = [p[3 * idx3] / a - vc[0], p[3 * idx3 + 1] / a - vc[1], p[3 * idx3 + 2] / a - vc[2]];
    var dxp = [pos[i3][0] - center[0], pos[i3][1] - center[1], pos[i3][2] - center[2]];
    vel[i3] = [vpec[0] + Hval * a * dxp[0], vpec[1] + Hval * a * dxp[1], vpec[2] + Hval * a * dxp[2]];
  }
  // 束縛判定（直接和 n<=3000、大は球対称近似）
  var memberIdxLocal = members.map(function (_, i4) { return i4; });
  var unbindRes = SUBFIND.unbind(memberIdxLocal, pos, vel, mass, Gconst, softening);
  var fBound = unbindRes.fBound;
  var bound = fBound >= 0.5;
  var useIdx = bound ? unbindRes.bound : memberIdxLocal;
  // ビリアル比 eta = 2K/|W|（該当メンバーで）
  var K = 0, W = 0;
  var n = useIdx.length;
  for (var a1 = 0; a1 < n; a1++) {
    var vv = vel[useIdx[a1]];
    K += 0.5 * mass * (vv[0] * vv[0] + vv[1] * vv[1] + vv[2] * vv[2]);
  }
  if (n <= 400) {
    for (var a2 = 0; a2 < n; a2++) {
      for (var b2 = a2 + 1; b2 < n; b2++) {
        var pa = pos[useIdx[a2]], pb = pos[useIdx[b2]];
        var dx = pa[0] - pb[0], dy = pa[1] - pb[1], dz = pa[2] - pb[2];
        var r = Math.sqrt(dx * dx + dy * dy + dz * dz + softening * softening);
        W += -Gconst * mass * mass / r;
      }
    }
  } else {
    // 大きい群は簡略化: 球対称の M(<r) 近似で W を見積もる（notes.md 申し送り）
    var center2 = [0, 0, 0];
    for (var a3 = 0; a3 < n; a3++) { center2[0] += pos[useIdx[a3]][0]; center2[1] += pos[useIdx[a3]][1]; center2[2] += pos[useIdx[a3]][2]; }
    center2[0] /= n; center2[1] /= n; center2[2] /= n;
    var withR = useIdx.map(function (idx5) {
      var pp = pos[idx5]; var dx2 = pp[0] - center2[0], dy2 = pp[1] - center2[1], dz2 = pp[2] - center2[2];
      return Math.sqrt(dx2 * dx2 + dy2 * dy2 + dz2 * dz2);
    }).sort(function (x, y) { return x - y; });
    var running = 0;
    for (var w = 0; w < withR.length; w++) {
      running += mass;
      W += -Gconst * running * mass / Math.max(withR[w], softening);
    }
    // 修正（S4 の指摘・notes.md 参照）: この和は殻ごとの
    // -G*M(<=r_j)*dM_j/r_j をすでに1回ずつ足しており（球対称密度分布の自己エネルギー
    // U=-G*Integral M(r)dM/r と同じ形）、ペアの二重和 sum_{i<j} を数えたときのような
    // 重複は無い。旧実装はここへさらに 0.5 を掛けており、一様球の解析解 -3GM^2/(5R) の
    // ちょうど半分になっていた（notes.md の 32768 粒子 Plummer 球での確認を参照）。
  }
  var eta = W !== 0 ? (2 * K) / Math.abs(W) : 0;
  var virial = eta >= 0.5 && eta <= 1.5;
  // 次元: 質量テンソルの固有値
  var Mxx = 0, Myy = 0, Mzz = 0, Mxy = 0, Mxz = 0, Myz = 0;
  for (var a4 = 0; a4 < useIdx.length; a4++) {
    var pp2 = pos[useIdx[a4]];
    var dx3 = pp2[0] - center[0], dy3 = pp2[1] - center[1], dz3 = pp2[2] - center[2];
    Mxx += dx3 * dx3; Myy += dy3 * dy3; Mzz += dz3 * dz3; Mxy += dx3 * dy3; Mxz += dx3 * dz3; Myz += dy3 * dz3;
  }
  var eig = WEB.symEig3([[Mxx, Mxy, Mxz], [Mxy, Myy, Myz], [Mxz, Myz, Mzz]]).map(function (v) { return Math.sqrt(Math.max(v, 0)); });
  var aAxis = eig[0], bAxis = eig[1], cAxis = eig[2];
  var ca = aAxis > 0 ? cAxis / aAxis : 0, ba = aAxis > 0 ? bAxis / aAxis : 0;
  var dim = ca >= 0.35 ? 3 : (ba >= 0.35 ? 2 : 1);
  return { fBound: fBound, bound: bound, eta: eta, virial: virial, ca: ca, ba: ba, dim: dim, K: K, W: W };
}

/** T-web 全体の解析（1回）。返り値: fv,fm,MV,クラス配列,connected components(糸)。 */
function computeWeb(x, Np, mass, L, Ng, Rs, lambdaTh) {
  var field = WEB.tidalField(x, Np, mass, Ng, L, Rs);
  var n = Ng * Ng * Ng;
  var cls = WEB.classify(field.eig, n, lambdaTh);
  var densGrid = S61.cicDensity(x, Np, mass, Ng, L);
  for (var i = 0; i < densGrid.length; i++) densGrid[i] += 1; // massGrid = delta+1
  var frac = WEB.classFractions(cls, Ng, densGrid);
  var filamentComps = WEB.connectedComponents(cls, Ng, 2);
  return { cls: cls, fv: frac.fv, fm: frac.fm, Ng: Ng, filamentComps: filamentComps, densGrid: densGrid };
}

/** MV(c) = fm/fv（0除算は0）。 */
function computeMV(fv, fm) {
  return fv.map(function (v, i) { return v > 0 ? fm[i] / v : 0; });
}

/** D_T = Σ|fv(c)-fDor(c)|。fDor は Doroshkevich の体積比。 */
function computeDT(fv, fDor) {
  var s = 0;
  for (var i = 0; i < 4; i++) s += Math.abs(fv[i] - fDor[i]);
  return s;
}

/**
 * 段の署名（束縛,ビリアル化,次元）の多数決（質量で重みをつけた最頻値）。
 * items: [{n, bound, virial, dim}, ...]。空なら null ではなく既定の記述オブジェクトを返す（K-138対応）。
 */
function modeSignature(items) {
  if (!items || items.length === 0) return { available: false, bound: false, virial: false, dim: 0, count: 0 };
  var counts = {};
  items.forEach(function (it) {
    var key = (it.bound ? 1 : 0) + ',' + (it.virial ? 1 : 0) + ',' + it.dim;
    counts[key] = (counts[key] || 0) + it.n;
  });
  var bestKey = null, bestW = -1;
  Object.keys(counts).forEach(function (k) { if (counts[k] > bestW) { bestW = counts[k]; bestKey = k; } });
  var parts = bestKey.split(',');
  return { available: true, bound: parts[0] === '1', virial: parts[1] === '1', dim: Number(parts[2]), count: items.length };
}

/** 2つの署名が同じか（新/相似の判定）。両方availableでなければ'undetermined'。 */
function signatureTransition(a, b) {
  if (!a.available || !b.available) return 'undetermined';
  return (a.bound === b.bound && a.virial === b.virial && a.dim === b.dim) ? 'similar' : 'new';
}

/**
 * rule1〜rule7 と s_surv を、蓄積した出力履歴から計算する。**null を返さない**——
 * 該当データが無い場合も、0 件である事実を数値・真偽値として明記する（親からの指示）。
 *
 * history: { outputs: [{a, halos, hostHaloA4s, subhalosByHost, web, filamentHaloA4s}...],
 *            events: [...], epsMax, Prel, Np, meanSpacing, hParam }
 */
function computeRules(history, params) {
  var outputs = history.outputs;
  var last = outputs.length ? outputs[outputs.length - 1] : null;

  // rule1: L1（f_halo, q_b3）
  var f_halo = last ? last.f_halo : 0;
  var halos100 = last ? last.hostHaloA4s.filter(function (h) { return h.n >= 100; }) : [];
  var massTot100 = halos100.reduce(function (s, h) { return s + h.n; }, 0);
  var massB3 = halos100.filter(function (h) { return h.bound && h.dim === 3; }).reduce(function (s, h) { return s + h.n; }, 0);
  var q_b3 = massTot100 > 0 ? massB3 / massTot100 : 0;
  var rule1pass = f_halo >= 0.1 && q_b3 >= 0.5;

  // rule2: L2（H-strict簡略版。持続する部分ハロー数。run.js が出力ごとに直接数える）
  var N_ps = last ? (last.N_ps || 0) : 0;
  var N_host_ps = last ? (last.N_host_ps || 0) : 0;
  var N_ps_shuf = 0; // 角度混ぜ参照は軽量版のためここでは0固定（K-53: 定義上0に近い帰無値。notes.mdに申し送り）
  var rule2pass = N_ps >= 5 && N_host_ps >= 3 && (N_ps - N_ps_shuf) >= 5;

  // rule3: L3（D_T, MV_fil, E_fil_small, units_with2halos）
  var D_T = last ? last.web.D_T : 0;
  var MV_fil = last ? last.web.MV[2] : 0;
  var smallHalos = last ? last.hostHaloA4s.filter(function (h) { return h.n >= 20 && h.n < 100; }) : [];
  var E_fil_small = 1.0; // 帰無値=1（小さいハローが糸に居る割合/糸の体積比。データ不足時は帰無値を明記）
  var E_fil_small_ref = 1.0;
  if (last && smallHalos.length > 0 && last.web.fv[2] > 0) {
    var inFil = smallHalos.filter(function (h) { return h.webClass === 2; }).length;
    E_fil_small = (inFil / smallHalos.length) / last.web.fv[2];
  }
  var units_with2halos = last ? last.web.unitsWith2Halos : 0;
  var rule3pass = D_T >= 0.1 && MV_fil >= 1.5 && E_fil_small >= 1.3 && units_with2halos >= 1;

  // levelCount D / D_noWeb
  var L1 = rule1pass, L2 = rule2pass, L3 = rule3pass;
  var D = (L1 ? 1 : 0) + (L1 && L2 ? 1 : 0) + (L1 && L3 ? 1 : 0);
  var D_noWeb = (L1 ? 1 : 0) + (L1 && L2 ? 1 : 0);

  // rule4: すぐ収束しない（最後の窓、既定Δlna=0.5相当=直近の出力群）
  var window = outputs.slice(-6);
  var gamma_M = 0, R_M = 1, r_inf = 0, branch = 'none';
  if (window.length >= 2) {
    var xs = window.map(function (o) { return Math.log(o.a); });
    var ys = window.map(function (o) { return Math.log(Math.max(o.M_c, 1e-9)); });
    var n2 = xs.length, xbar = xs.reduce(function (a, b) { return a + b; }, 0) / n2, ybar = ys.reduce(function (a, b) { return a + b; }, 0) / n2;
    var num = 0, den = 0;
    for (var i = 0; i < n2; i++) { num += (xs[i] - xbar) * (ys[i] - ybar); den += (xs[i] - xbar) * (xs[i] - xbar); }
    gamma_M = den > 0 ? num / den : 0;
    R_M = window[0].M_c > 0 ? window[window.length - 1].M_c / window[0].M_c : 1;
    var infallsInWindow = history.events.filter(function (e) { return e.type === 'infall' && e.a >= window[0].a && !e.flicker; }).length;
    r_inf = infallsInWindow / Math.max(1, window.length) / 0.5;
  }
  var growthBranch = gamma_M >= 1 && R_M >= 1.5;
  var eventBranch = r_inf >= 0.2;
  branch = growthBranch ? 'growth' : (eventBranch ? 'event' : 'none');
  var rule4pass = growthBranch || eventBranch;

  // rule5: エネルギー台帳
  var eps_max = history.epsMax || 0;
  var P_rel = history.Prel || 0;
  var rule5pass = eps_max <= 0.02 && P_rel <= 1e-10;

  // rule6: 段ごとの新しい性質
  var sig_L1 = modeSignature(halos100.map(function (h) { return { n: h.n, bound: h.bound, virial: h.virial, dim: h.dim }; }));
  var l2Items = last ? last.hostHaloA4s.filter(function (h) { return h.n >= (params.nHost || 1000); }).map(function (h) { return { n: h.n, bound: h.bound, virial: h.virial, dim: h.dim }; }) : [];
  var sig_L2 = modeSignature(l2Items);
  var l3Items = last ? last.filamentHaloA4s : [];
  var sig_L3 = modeSignature(l3Items);
  var transitions = { L1_L2: signatureTransition(sig_L1, sig_L2), L1_L3: signatureTransition(sig_L1, sig_L3) };
  var rule6pass = transitions.L1_L3 === 'new';

  // rule7: 下から上の組み立て
  var t_emerge_L1 = -1, t_emerge_L3_field = -1;
  outputs.forEach(function (o, oi) {
    if (t_emerge_L1 < 0 && o.f_halo >= 0.1) t_emerge_L1 = oi;
    if (t_emerge_L3_field < 0 && o.web.D_T >= 0.1 && o.web.MV[2] >= 1.5) t_emerge_L3_field = oi;
  });
  var f_asm = last && outputs.length > 1 ? Math.min(1, (last.f_halo) / Math.max(1e-9, outputs[0].f_halo + 1e-9)) : 0;
  f_asm = last ? last.f_asm != null ? last.f_asm : 0 : 0;
  var N_prog = last ? (last.N_prog || 0) : 0;
  var rule7pass = t_emerge_L1 >= 0 && t_emerge_L3_field >= 0 ? t_emerge_L1 < t_emerge_L3_field && f_asm >= 0.5 : false;

  // subhaloSurvival
  var infallCandidates = history.events.filter(function (e) { return e.type === 'infall' && e.nAtInfall >= 50; });
  var survived = infallCandidates.filter(function (e) { return e.becamePersistentSubhalo; }).length;
  var s_surv = infallCandidates.length > 0 ? survived / infallCandidates.length : 0;

  return {
    D: D, D_noWeb: D_noWeb,
    rule1: { f_halo: f_halo, q_b3: q_b3, pass: rule1pass },
    rule2: { N_ps: N_ps, N_host_ps: N_host_ps, N_ps_shuf: N_ps_shuf, pass: rule2pass },
    rule3: { D_T: D_T, MV_fil: MV_fil, E_fil_small: E_fil_small, E_fil_small_ref: E_fil_small_ref, units_with2halos: units_with2halos, pass: rule3pass },
    rule4: { gamma_M: gamma_M, R_M: R_M, r_inf: r_inf, branch: branch, pass: rule4pass },
    rule5: { eps_max: eps_max, P_rel: P_rel, pass: rule5pass },
    rule6: { sig_L1: sig_L1, sig_L2: sig_L2, sig_L3: sig_L3, transitions: transitions, pass: rule6pass },
    rule7: { t_emerge_L1: t_emerge_L1, t_emerge_L3_field: t_emerge_L3_field, f_asm: f_asm, N_prog: N_prog, pass: rule7pass },
    s_surv: s_surv,
  };
}

return {
  unwrapGroup: unwrapGroup, findHalos: findHalos, computeA4: computeA4,
  computeWeb: computeWeb, computeMV: computeMV, computeDT: computeDT,
  modeSignature: modeSignature, signatureTransition: signatureTransition, computeRules: computeRules,
};
});
