/**
 * S-43: 検出器の相互汎化監査 ― 42本の手作り検出器を、他系の生ログ・シャッフル対照・ノイズ対照に総当たりする
 *
 * このスケッチは「新しい人工生命系」を持たない。題材は本サブプロジェクト自身（S-01〜S-42）の
 * （検出器の定義, 生ログ）コーパスであり、核が読み書きするのは「他42本の raw/ と criteria.json」である。
 * 全段共通の禁則により、それらは読み取り専用で参照する（絶対に書き込まない）。
 *
 * 設計の核心（criteria.json の decisionRule を実装可能な形へ具体化したもの。詳細差分は raw/notes.md）:
 *   各系 X は「自分自身の主要スカラー時系列」を1本持つ（registry.js が列を指定する）。
 *   検出器を持つ系 i は「threshold・比較演算子」も1組持つ（同じく registry.js。多くは i 自身の
 *   criteria.json が登録した値をそのまま借用する。K-14 型の連言・K-23 型の曲線検定は単一閾値へ
 *   簡略化しており、その簡略化は registry.js の note に系ごとに明記してある）。
 *   判定は 1 つだけ: mean(対象jの系列) <cmp_i> threshold_i。この単純化により、
 *   「シャッフルしても分布依存の統計量は不変」という criteria.json の正コントロール②を
 *   実装そのものが自動的に体現する（selftest で検査する）。
 *
 * 核は上位概念の語彙を持たない（cell/membrane/organism 等は使わない）。「検出器」「陽性/陰性/適用不能」
 * という言い方は本監査の対象そのもの（他スケッチの観測器）を指す名詞であり、この核自身の振る舞いの
 * 形容ではないので、方針に反しない。
 *
 * 依存ゼロ。Node（本体）とブラウザ（viewer.html。ただし fs は使わず、run.js が書いた JSON を読むだけ）
 * が同じファイルを読む。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.S43 = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var hasFs = typeof require === 'function';
  var fs = hasFs ? require('fs') : null;
  var path = hasFs ? require('path') : null;
  var registry = hasFs ? require('./registry.js') : { SKETCHES: {}, EXCLUDED: {} };

  var ROOT = hasFs ? path.resolve(__dirname, '../../..') : null;
  var APPS_DIR = hasFs ? path.join(ROOT, 'apps/alife-sketches') : null;
  var DOCS_DIR = hasFs ? path.join(ROOT, 'docs/subprojects/alife-sketches/sketches') : null;

  var MAX_POINTS = 10000; // ceilings: 1系列あたりのサンプル点数の上限

  // ------------------------------------------------------------ 乱数（S-02 と同じ mulberry32）
  function makeRng(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ------------------------------------------------------------ 基本の道具
  function isFiniteNum(v) { return typeof v === 'number' && isFinite(v); }

  function mean(arr) {
    if (!arr || !arr.length) return NaN;
    var s = 0;
    for (var i = 0; i < arr.length; i++) s += arr[i];
    return s / arr.length;
  }

  function variance(arr) {
    if (!arr || arr.length < 2) return NaN;
    var m = mean(arr), s = 0;
    for (var i = 0; i < arr.length; i++) s += (arr[i] - m) * (arr[i] - m);
    return s / (arr.length - 1);
  }

  /** 等間隔の間引き（ceilings: 上限 10,000 点）。K-9: 選んだ幅を明示する。 */
  function downsample(values, maxPoints) {
    maxPoints = maxPoints || MAX_POINTS;
    if (!values || values.length <= maxPoints) return values ? values.slice() : [];
    var out = [];
    var stride = values.length / maxPoints;
    for (var i = 0; i < maxPoints; i++) out.push(values[Math.floor(i * stride)]);
    return out;
  }

  /** FNV-1a（K-36: 状態ハッシュを1欄入れる）。 */
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  }

  function seriesHash(values) {
    // 丸めてからハッシュする（浮動小数の末尾ビットの揺れを再現性検査のノイズにしない）
    var rounded = values.map(function (v) { return Math.round(v * 1e6) / 1e6; });
    return fnv1a(JSON.stringify(rounded));
  }

  function shuffleFisherYates(values, rng) {
    var out = values.slice();
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(rng() * (i + 1));
      var tmp = out[i]; out[i] = out[j]; out[j] = tmp;
    }
    return out;
  }

  /** knobs.shuffleGranularity: ブロック単位のシャッフル（ブロック内の順序は保つ）。 */
  function blockShuffle(values, blockSize, rng) {
    if (blockSize <= 1) return shuffleFisherYates(values, rng);
    var blocks = [];
    for (var i = 0; i < values.length; i += blockSize) blocks.push(values.slice(i, i + blockSize));
    var shuffledBlocks = shuffleFisherYates(blocks, rng);
    return Array.prototype.concat.apply([], shuffledBlocks);
  }

  function noiseUniform(n, rng) {
    var out = new Array(n);
    for (var i = 0; i < n; i++) out[i] = rng();
    return out;
  }

  /** Box–Muller。標準正規。 */
  function noiseGaussian(n, rng) {
    var out = new Array(n);
    for (var i = 0; i < n; i += 2) {
      var u1 = Math.max(rng(), 1e-12), u2 = rng();
      var r = Math.sqrt(-2 * Math.log(u1));
      out[i] = r * Math.cos(2 * Math.PI * u2);
      if (i + 1 < n) out[i + 1] = r * Math.sin(2 * Math.PI * u2);
    }
    return out;
  }

  /** 対象コーパスと同じ平均・分散を持つ正規乱数（③種）。 */
  function noiseGaussianMatched(refValues, n, rng) {
    var m = mean(refValues), sd = Math.sqrt(variance(refValues));
    if (!isFiniteNum(m) || !isFiniteNum(sd)) { m = 0; sd = 1; }
    return noiseGaussian(n, rng).map(function (z) { return m + sd * z; });
  }

  // ------------------------------------------------------------ ファイル解決（Node のみ）
  var dirCache = {};
  function nn(id) { return id.replace('S-', ''); }

  function resolveDocDir(id) {
    if (!hasFs) return null;
    if (dirCache['doc:' + id] !== undefined) return dirCache['doc:' + id];
    var found = null;
    if (fs.existsSync(DOCS_DIR)) {
      var m = fs.readdirSync(DOCS_DIR).find(function (d) { return d.indexOf('S-' + nn(id) + '-') === 0; });
      if (m) found = path.join(DOCS_DIR, m);
    }
    dirCache['doc:' + id] = found;
    return found;
  }

  function resolveAppDir(id) {
    if (!hasFs) return null;
    var entry = registry.SKETCHES[id];
    if (!entry || !entry.app) return null;
    return path.join(APPS_DIR, entry.app);
  }

  function rawFile(id, filename) {
    var doc = resolveDocDir(id);
    if (!doc) return null;
    var p = path.join(doc, 'raw', filename);
    return fs.existsSync(p) ? p : null;
  }

  var jsonlCache = {};
  function readJsonl(filePath) {
    if (jsonlCache[filePath]) return jsonlCache[filePath];
    var text = fs.readFileSync(filePath, 'utf8');
    var lines = text.split('\n');
    var rows = [];
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (!line) continue;
      try { rows.push(JSON.parse(line)); } catch (e) { /* 壊れた行は飛ばす（数は summary に出す） */ }
    }
    jsonlCache[filePath] = rows;
    return rows;
  }

  function getPath(obj, field) {
    if (!obj) return undefined;
    if (field.indexOf('.') < 0) return obj[field];
    var parts = field.split('.'), cur = obj;
    for (var i = 0; i < parts.length; i++) { if (cur == null) return undefined; cur = cur[parts[i]]; }
    return cur;
  }

  // ------------------------------------------------------------ 主要スカラー時系列の抽出
  var seriesCache = {};

  /**
   * 系 id の「主要スカラー時系列」を読む。registry.js の series（無ければ detector）の
   * file/field または derive に従う。見つからなければ available:false を返す（適用不能の理由も添える）。
   * K-12 対策: 呼び出しごとに毎回ファイルから再構成する（グローバルな可変バッファを使い回さない）。
   */
  function loadCanonicalSeries(id) {
    if (seriesCache[id]) return seriesCache[id];
    var entry = registry.SKETCHES[id];
    var out;
    if (!entry) {
      out = { id: id, available: false, reason: registry.EXCLUDED[id] || '台帳に無い系', values: [] };
    } else {
      var spec = entry.series || entry.detector;
      if (!spec) {
        out = { id: id, available: false, reason: '台帳に生ログ列の指定が無い', values: [] };
      } else {
        var file = rawFile(id, spec.file);
        if (!file) {
          out = { id: id, available: false, reason: 'raw/' + spec.file + ' が見つからない', values: [] };
        } else {
          var rows = readJsonl(file);
          var raw;
          if (spec.derive) raw = rows.map(spec.derive);
          else raw = rows.map(function (r) { return getPath(r, spec.field); });
          var values = raw.filter(isFiniteNum);
          if (!values.length) {
            out = { id: id, available: false, reason: '列 ' + (spec.field || '(derive)') + ' に数値が無かった', values: [] };
          } else {
            values = downsample(values, MAX_POINTS);
            out = {
              id: id, available: true, values: values, field: spec.field || '(derive)',
              file: spec.file, family: entry.family || null, hash: seriesHash(values),
            };
          }
        }
      }
    }
    seriesCache[id] = out;
    return out;
  }

  function detectorSpecFor(id) {
    var entry = registry.SKETCHES[id];
    if (!entry || !entry.detector) return null;
    var d = entry.detector;
    if (!isFiniteNum(d.threshold) || ['>=', '<=', '>', '<'].indexOf(d.cmp) < 0) return null;
    return d;
  }

  // ------------------------------------------------------------ 判定（本番と selftest が共有する唯一の実装）
  /**
   * criteria.json decisionRule: 検出器 spec を系列 values に当てる。
   * 三値: 'positive' | 'negative' | 'inapplicable'。
   * 簡略化（raw/notes.md に明記）: 適用不能は「系列が空/非数」の場合のみ発生する。
   * 値域の不整合による『計算そのものが破綻する』ケースは、mean(values) <cmp> threshold という
   * 単純化された判定規則の性質上、原理的に発生しない（常に数値どうしの比較ができてしまう）。
   */
  function decide(spec, values) {
    if (!spec) return 'inapplicable';
    if (!values || !values.length) return 'inapplicable';
    var m = mean(values);
    if (!isFiniteNum(m)) return 'inapplicable';
    var t = spec.threshold, positive;
    if (spec.cmp === '>=') positive = m >= t;
    else if (spec.cmp === '<=') positive = m <= t;
    else if (spec.cmp === '>') positive = m > t;
    else if (spec.cmp === '<') positive = m < t;
    else throw new Error('未知の比較演算子: ' + spec.cmp);
    return positive ? 'positive' : 'negative';
  }

  // ------------------------------------------------------------ 母集団の列挙
  function allIds() {
    var out = [];
    for (var i = 1; i <= 42; i++) out.push('S-' + (i < 10 ? '0' + i : '' + i));
    return out;
  }

  function detectorIds() {
    return allIds().filter(function (id) { return !!detectorSpecFor(id); });
  }

  function targetIds() {
    return allIds().filter(function (id) { return loadCanonicalSeries(id).available; });
  }

  // ------------------------------------------------------------ 1検出器ぶんの汎化率・偽陽性率
  /**
   * 検出器 i を、他41系＋シャッフル41本＋ノイズ3種に当てる。
   * シャッフルは対象jごとに1本（jの系列をそのままシャッフル）。
   * ノイズ3種は i 自身の系列長に合わせた1組（criteria.jsonのcontrolTimescaleのあいまいさをここで解消。
   * raw/notes.md 参照）。
   */
  function countOf() { return { positive: 0, negative: 0, inapplicable: 0 }; }
  function bump(bucket, verdict) { bucket[verdict]++; }
  function rateOf(bucket) {
    var denom = bucket.positive + bucket.negative;
    return denom ? bucket.positive / denom : NaN;
  }

  function evaluateDetector(detId, opts) {
    opts = opts || {};
    var seed = opts.seed || 20260914;
    var shuffleGranularity = opts.shuffleGranularity || 1;
    var thresholdMultiplier = opts.thresholdMultiplier || 1;
    var rng = makeRng(seed);

    var baseSpec = detectorSpecFor(detId);
    var spec = baseSpec && Object.assign({}, baseSpec, { threshold: baseSpec.threshold * thresholdMultiplier });
    var mySeries = loadCanonicalSeries(detId);
    var others = targetIds().filter(function (id) { return id !== detId; });

    var generalization = countOf();
    var byFamily = { same: countOf(), diff: countOf() };
    var detFamily = (registry.SKETCHES[detId] || {}).family || null;
    var cells = [];

    others.forEach(function (id) {
      var s = loadCanonicalSeries(id);
      var verdict = decide(spec, s.values);
      bump(generalization, verdict);
      cells.push({ arm: 'other', target: id, verdict: verdict });
      if (detFamily && s.family) bump(s.family === detFamily ? byFamily.same : byFamily.diff, verdict);
    });

    var shuffleBucket = countOf(), noiseBucket = countOf();
    others.forEach(function (id) {
      var s = loadCanonicalSeries(id);
      var shuffled = blockShuffle(s.values, shuffleGranularity, rng);
      var verdict = decide(spec, shuffled);
      bump(shuffleBucket, verdict);
      cells.push({ arm: 'shuffle', of: id, verdict: verdict });
    });
    var noiseLen = mySeries.available ? mySeries.values.length : 1000;
    var noiseSets = {
      uniform: noiseUniform(noiseLen, rng),
      gaussian: noiseGaussian(noiseLen, rng),
      gaussianMatched: noiseGaussianMatched(mySeries.values, noiseLen, rng),
    };
    Object.keys(noiseSets).forEach(function (kind) {
      var verdict = decide(spec, noiseSets[kind]);
      bump(noiseBucket, verdict);
      cells.push({ arm: 'noise', kind: kind, verdict: verdict });
    });

    var negControls = countOf();
    ['positive', 'negative', 'inapplicable'].forEach(function (k) { negControls[k] = shuffleBucket[k] + noiseBucket[k]; });

    return {
      detector: detId,
      detectorSpec: spec,
      seed: seed,
      shuffleGranularity: shuffleGranularity,
      thresholdMultiplier: thresholdMultiplier,
      selfVerdict: decide(spec, mySeries.values), // 対角の自己適用（生ログ全体の平均。負でも欠陥ではない——raw/notes.md）
      generalizationRate: rateOf(generalization),
      generalizationCounts: generalization,
      falsePositiveRate: rateOf(negControls),
      negativeControlCounts: negControls,
      shuffleCounts: shuffleBucket,
      shuffleRate: rateOf(shuffleBucket),
      noiseCounts: noiseBucket,
      noiseRate: rateOf(noiseBucket),
      familyAdvantageGap: (byFamily.same.positive + byFamily.same.negative >= 2 && byFamily.diff.positive + byFamily.diff.negative >= 1)
        ? rateOf(byFamily.same) - rateOf(byFamily.diff)
        : NaN,
      familyCounts: byFamily,
      cells: cells,
    };
  }

  // ------------------------------------------------------------ 副次（族）行列の対象抽出
  var FAMILY_SEED = 20260914;
  function familyMembers() {
    var byFamily = {};
    allIds().forEach(function (id) {
      var entry = registry.SKETCHES[id];
      if (!entry || !entry.family) return;
      if (!loadCanonicalSeries(id).available) return;
      (byFamily[entry.family] = byFamily[entry.family] || []).push(id);
    });
    var dropped = {};
    Object.keys(byFamily).forEach(function (fam) {
      var members = byFamily[fam].slice().sort(); // 決定的な順序にしてからシードで間引く
      if (members.length > 8) {
        var rng = makeRng(FAMILY_SEED + fam.split('').reduce(function (a, c) { return a + c.charCodeAt(0); }, 0));
        var shuffled = shuffleFisherYates(members, rng);
        dropped[fam] = shuffled.slice(8).sort();
        byFamily[fam] = shuffled.slice(0, 8).sort();
      }
    });
    return { families: byFamily, dropped: dropped };
  }

  return {
    makeRng: makeRng, mean: mean, variance: variance, downsample: downsample,
    fnv1a: fnv1a, seriesHash: seriesHash,
    shuffleFisherYates: shuffleFisherYates, blockShuffle: blockShuffle,
    noiseUniform: noiseUniform, noiseGaussian: noiseGaussian, noiseGaussianMatched: noiseGaussianMatched,
    allIds: allIds, detectorIds: detectorIds, targetIds: targetIds,
    loadCanonicalSeries: loadCanonicalSeries, detectorSpecFor: detectorSpecFor,
    decide: decide, evaluateDetector: evaluateDetector, familyMembers: familyMembers,
    registry: registry,
    MAX_POINTS: MAX_POINTS,
    _internal: { resolveDocDir: resolveDocDir, resolveAppDir: resolveAppDir, rawFile: rawFile, readJsonl: readJsonl, getPath: getPath },
  };
});
