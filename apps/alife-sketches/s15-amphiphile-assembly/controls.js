/**
 * S-15 の対照群。**観測器の側のファイル**なので「二重層」「環」という語を使ってよい。
 * 核（core.js）はこれらの語を知らない——ここで作った配置も、核から見れば
 * ただの「重心と角度の並び」である。
 *
 * 正コントロール: 手で組んだ二重層（PC1）と放射状の環（PC2）
 * 負コントロール: 引力なし（NC1）・一様な引力かさ無し（NC2）・一様な引力かさ有り（NC3）
 */
(function (root, factory) {
  var api = factory(typeof require === 'function' ? require('./core.js') : root.S15);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S15CTL = api;
})(typeof self !== 'undefined' ? self : this, function (S15) {
  'use strict';

  /**
   * PC1: 手組みの二重層。2 列の鎖が尾端を内側に向けて向かい合う。
   * 上の列は下向き（-y）、下の列は上向き（+y）で、横に半歩ずらして詰める。
   */
  function bilayer(opts) {
    var o = opts || {};
    var size = o.size == null ? 30 : o.size;
    var ym = o.midline == null ? size / 2 : o.midline;
    var x0 = o.x0 == null ? 5 : o.x0, x1 = o.x1 == null ? 25 : o.x1;
    var pitch = o.pitch == null ? 1.0 : o.pitch;
    var chains = [];
    for (var x = x0; x < x1 - 1e-9; x += pitch) {
      chains.push([x, ym + 1.5, -Math.PI / 2]);
      chains.push([x + pitch / 2, ym - 1.5, Math.PI / 2]);
    }
    return S15.fromChains(chains, { size: size });
  }

  /**
   * PC2: 手組みの放射状の環を 9 個。各環は 8 鎖が尾端を中心へ向けて並ぶ。
   * 2 次元では 3 粒子鎖が中心を向いて作れる最小の環がこの大きさになる。
   */
  function radialRings(opts) {
    var o = opts || {};
    var size = o.size == null ? 44 : o.size;
    var R = o.ringRadius == null ? 2.3 : o.ringRadius;
    var m = o.perRing == null ? 8 : o.perRing;
    var centers = o.centers || [[8, 8], [22, 8], [36, 8], [8, 22], [22, 22], [36, 22], [8, 36], [22, 36], [36, 36]];
    var chains = [];
    for (var c = 0; c < centers.length; c++) {
      for (var k = 0; k < m; k++) {
        var a = 2 * Math.PI * k / m;
        chains.push([centers[c][0] + R * Math.cos(a), centers[c][1] + R * Math.sin(a), a + Math.PI]);
      }
    }
    return S15.fromChains(chains, { size: size });
  }

  /** 負コントロールの設定。simulate() で本系と同じ手続きに掛ける。 */
  var NEGATIVE = {
    NC1_noAffinity: { couple: 'none', headRadius: 0.45, label: '引力なし（排除体積だけ）' },
    NC2_uniformAffinity_slim: { couple: 'all', headRadius: 0.45, label: '一様な引力・かさ無し' },
    NC3_uniformAffinity_bulky: { couple: 'all', headRadius: 0.75, label: '一様な引力・かさ有り' },
  };

  /** 本系・負コントロールを同じ手続きで走らせる。 */
  function simulate(spec, seed, sweeps, onProgress, progressEvery) {
    var opts = {
      size: spec.size == null ? 50 : spec.size,
      density: spec.density == null ? 0.10 : spec.density,
      radius: [spec.headRadius == null ? 0.45 : spec.headRadius, 0.45],
      eps: S15.makeEps(spec.w == null ? 2.0 : spec.w, spec.couple || 'B'),
    };
    return S15.runReplicate(opts, seed, sweeps, onProgress, progressEvery);
  }

  return { bilayer: bilayer, radialRings: radialRings, NEGATIVE: NEGATIVE, simulate: simulate };
});
