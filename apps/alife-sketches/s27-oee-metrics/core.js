/**
 * S-27 核 — オープンエンド進化（OEE）の評価指標の系譜を、
 * 本サブプロジェクトの登録項目（秩序変数・スケール・閾値・参照点・母集団）へ写す。
 *
 * ここには「データ」と「数え方」しか無い。判定を含む符号は **CODING の定数表**に置き、
 * 各マスに根拠の引用（QUOTES の id）を添えてある（K-39）。表を書き換えれば数も変わる。
 *
 * Node とブラウザで共用する古典スクリプト（ESM にしない）。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.S27 = api;
}(this, function () {
  'use strict';

  // ------------------------------------------------------------------ 列（登録項目）

  var FIELDS = [
    { key: 'V', name: '秩序変数', primary: true, gloss: '系から計算され、答えとして読まれる量' },
    { key: 'S', name: 'スケール', primary: true, gloss: '何を1つの構成要素と数えるか・時間窓・正規化の尺度' },
    { key: 'Th', name: '閾値', primary: true, gloss: '量を判定へ変える切り位置または決定規則' },
    { key: 'R', name: '参照点', primary: true, gloss: '何と対比して読むか（帰無モデル・影・基準線）' },
    { key: 'P', name: '母集団', primary: true, gloss: '誰を数えるか（統計に入る要素の外延）' },
    { key: 'U', name: '判定の単位', primary: false, gloss: '何本ぶんを束ねて1つの判定にするか（S-20 の提案）' },
    { key: 'T', name: '観測窓の上限', primary: false, gloss: 'どこまで走らせた記録を読むか（S-20 の申告項目）' }
  ];

  var LEVELS = ['filled', 'open', 'absent'];

  var LEVEL_LABEL = { filled: '埋めた', open: '読み手に委ねた', absent: '触れない' };

  // ------------------------------------------------------------------ 系譜の entry

  var ENTRIES = [
    { id: 'M01', year: 1992, who: 'Bedau & Packard',
      title: 'Measurement of Evolutionary Activity, Teleology, and Life',
      venue: 'Artificial Life II', role: '指標', reached: true },
    { id: 'M02', year: 1998, who: 'Bedau, Snyder & Packard',
      title: 'A Classification of Long-Term Evolutionary Dynamics',
      venue: 'Artificial Life VI', role: '指標', reached: true },
    { id: 'M03', year: 2003, who: 'Raven & Bedau',
      title: 'General Framework for Evolutionary Activity',
      venue: 'ECAL 2003', role: '指標', reached: false,
      unreachedWhy: 'reed.edu の PDF は ToUnicode を持たない Type3 部分集合フォントで、符号と文字の対応が字形の中にしか無い。Springer 版は購読が要る' },
    { id: 'M04', year: 2000, who: 'Standish',
      title: 'An Ecolab Perspective on the Bedau Evolutionary Statistics',
      venue: 'arXiv nlin/0004026', role: '批判', reached: true },
    { id: 'M05', year: 2003, who: 'Standish',
      title: 'Open-Ended Artificial Evolution',
      venue: 'arXiv nlin/0210027', role: '批判', reached: true },
    { id: 'M06', year: 2001, who: 'Channon',
      title: 'Passing the ALife Test: Activity Statistics Classify Evolution in Geb as Unbounded',
      venue: 'ECAL 2001', role: '適用と改訂', reached: true },
    { id: 'M07', year: 2016, who: 'Taylor et al.',
      title: 'Open-Ended Evolution: Perspectives from the OEE Workshop in York',
      venue: 'Artificial Life 22(3)', role: '会議報告', reached: true },
    { id: 'M08', year: 2011, who: 'Lehman & Stanley',
      title: 'Abandoning Objectives: Evolution through the Search for Novelty Alone',
      venue: 'Evolutionary Computation 19(2)', role: '指標（探索側）', reached: true },
    { id: 'M09', year: 2014, who: 'Soros & Stanley',
      title: 'Identifying Necessary Conditions for Open-Ended Evolution through the Artificial Life World of Chromaria',
      venue: 'ALIFE 14', role: '条件の提案', reached: false,
      unreachedWhy: '公開されている全文が見つからない（MIT Press の議事録は 403）' },
    { id: 'M10', year: 2019, who: 'Dolson, Vostinar, Wiser & Ofria',
      title: 'The MODES Toolbox: Measurements of Open-Ended Dynamics in Evolving Systems',
      venue: 'Artificial Life 25(1)', role: '指標', reached: true },
    { id: 'M11', year: 2019, who: 'Packard et al.',
      title: 'An Overview of Open-Ended Evolution: Editorial Introduction',
      venue: 'Artificial Life 25(2) / arXiv 1909.04430', role: '編集序文', reached: true },
    { id: 'M12', year: 2019, who: 'Hintze',
      title: 'Open-Endedness for the Sake of Open-Endedness',
      venue: 'Artificial Life 25(2)', role: '批判', reached: true },
    { id: 'M13', year: 2019, who: 'Pattee & Sayama',
      title: 'Evolved Open-Endedness, Not Open-Ended Evolution',
      venue: 'Artificial Life 25(1)', role: '立場表明', reached: false,
      unreachedWhy: 'Semantic Scholar の openAccessPdf が status: CLOSED を返す。出版社版は 403' },
    { id: 'M14', year: 2006, who: 'Bullock & Bedau',
      title: 'Exploring the Dynamics of Adaptation with Evolutionary Activity Plots',
      venue: 'Artificial Life 12(2)', role: '指標の可視化', reached: true }
  ];

  // ------------------------------------------------------------------ 引用（raw/quotes.json と同じ内容）
  // text は取得した本文から機械的に切り出したもの。出典の PDF は語間の空白と合字
  // （ﬁ・ﬂ・ﬀ）を落とすので、原文の綴りへ人が戻した readable を併記する。
  // 実在の検査は raw/verify.py が text 側で行う（空白は潰し、合字は省略可として照合する）。

  var QUOTES = {};   // 下の REGISTER_QUOTES で埋める

  // ------------------------------------------------------------------ 符号の定数表（K-39）

  var CODING = {};   // 下の REGISTER_CODING で埋める

  // ------------------------------------------------------------------ 既作26本の重ね合わせに使う鍵の綴り

  var KEY_PATTERNS = {
    V: [/^orderParameters?$/, /^primary(Curve)?$/, /^orderParameterIsACurve$/,
        /^statistic$/, /^measureFamily$/, /^descriptors?$/, /^descriptor$/],
    S: [/^scales?$/, /^radius$/, /^grid$/, /^bins?$/, /^levels?$/,
        /Radius$/, /Grid$/, /Scale$/],
    Th: [/^thresholds?$/, /Threshold$/, /^thresholdMeaning$/, /^decision(Rule)?$/,
         /^acceptance$/, /^verdict$/, /Floor$/],
    R: [/^referencePoints?$/, /^nullProcess$/, /^nullValue$/, /^theoreticalNull$/,
        /^nullRealizations$/, /Null/],
    P: [/^population$/, /^theta$/],
    U: [/^unitOfJudgement$/],
    T: [/^T$/, /^run$/, /^runScale$/, /^steps$/, /^generations$/,
        /^maxPeriod$/, /^totalTime$/, /^time$/,
        /Steps$/, /Time$/, /Window$/]
  };

  // 同じ意味で使われそうだが、既作23本では**一度も当たらなかった**綴り。
  // 照合には使う（将来のスケッチが使えば拾う）が、当たらないことを selftest が検査する——
  // 表に飾りの行が溜まると、道具が何を見ているのか読めなくなるため。
  var KEY_SYNONYMS_NOT_SEEN = {
    V: [],
    S: [/^granularity$/],
    Th: [],
    R: [/^shadow$/, /^nullModel$/],
    P: [/^cohort$/, /^whoIsCounted$/, /^membership$/],
    U: [/^judgementUnit$/],
    T: [/^runLength$/, /^horizon$/, /^duration$/]
  };

  function patternsFor(key) {
    return (KEY_PATTERNS[key] || []).concat(KEY_SYNONYMS_NOT_SEEN[key] || []);
  }

  // 語の一致は誤る（[S-20] が実例を残している）。誤りを消すのではなく、
  // **根拠つきの訂正表**として置き、集計はここを通す。
  var OVERLAY_CORRECTIONS = [
    { sketch: 's05-tierra-like', field: 'P', to: 'absent',
      matched: 'orderParameters.population',
      why: 'この population は「終端時点で生存するプロセス数」という**秩序変数の名前**であって、誰を数えるかの宣言ではない。S-20 が同じ誤りを警告している' },
    { sketch: 's16-avida-like', field: 'P', to: 'absent',
      matched: 'orderParameters.population',
      why: '同上。「終端時点の生存プロセス数」という秩序変数の名前' }
  ];

  // ------------------------------------------------------------------ 数え方（純関数）

  function primaryFields() {
    return FIELDS.filter(function (f) { return f.primary; });
  }

  function entryById(id) {
    for (var i = 0; i < ENTRIES.length; i++) if (ENTRIES[i].id === id) return ENTRIES[i];
    return null;
  }

  /** 母集団 P1（到達できたものだけ）／P2（全 entry・未到達は absent）で表を作る。 */
  function table(population) {
    var rows = [];
    ENTRIES.forEach(function (e) {
      if (population === 'P1' && !e.reached) return;
      var cells = {};
      FIELDS.forEach(function (f) {
        var c = (CODING[e.id] || {})[f.key];
        if (!e.reached) cells[f.key] = { verdict: 'absent', quotes: [], why: '未到達', unreached: true };
        else cells[f.key] = c || { verdict: 'absent', quotes: [], why: '該当する文が見つからない' };
      });
      rows.push({ entry: e, cells: cells });
    });
    return rows;
  }

  /** 列ごとの filled / open / absent の数。 */
  function tally(population) {
    var rows = table(population);
    var out = {};
    FIELDS.forEach(function (f) {
      var t = { filled: 0, open: 0, absent: 0, n: rows.length };
      rows.forEach(function (r) { t[r.cells[f.key].verdict]++; });
      t.filledRatio = rows.length ? t.filled / rows.length : 0;
      out[f.key] = t;
    });
    return out;
  }

  /** 判定の単位 U2: entry 単位で「5列すべて filled か」。 */
  function entriesFullyFilled(population) {
    return table(population).filter(function (r) {
      return primaryFields().every(function (f) { return r.cells[f.key].verdict === 'filled'; });
    }).map(function (r) { return r.entry.id; });
  }

  /** 事前登録した予測表との突き合わせ。到達できた entry の主表だけを数える。 */
  function scorePrediction(prediction) {
    var hits = [], misses = [];
    ENTRIES.forEach(function (e) {
      if (!e.reached) return;
      var pred = prediction[e.id];
      if (!pred) return;
      primaryFields().forEach(function (f) {
        var got = ((CODING[e.id] || {})[f.key] || { verdict: 'absent' }).verdict;
        var rec = { entry: e.id, field: f.key, predicted: pred[f.key], observed: got };
        (pred[f.key] === got ? hits : misses).push(rec);
      });
    });
    return { hits: hits, misses: misses, n: hits.length + misses.length,
             rate: (hits.length + misses.length) ? hits.length / (hits.length + misses.length) : 0 };
  }

  /** 既作スケッチの criteria.json の鍵の並びから、どの列を登録しているかを読む。 */
  function codeSketch(slug, keyPaths) {
    var out = {};
    FIELDS.forEach(function (f) {
      var matched = null;
      for (var i = 0; i < keyPaths.length && !matched; i++) {
        var leaf = keyPaths[i].split('.').pop();
        if (/^\d+$/.test(leaf)) continue;
        var pats = patternsFor(f.key);
        for (var j = 0; j < pats.length; j++) {
          if (pats[j].test(leaf)) { matched = keyPaths[i]; break; }
        }
      }
      out[f.key] = { registered: !!matched, matched: matched, corrected: false, why: null };
    });
    OVERLAY_CORRECTIONS.forEach(function (c) {
      if (c.sketch !== slug) return;
      var cell = out[c.field];
      if (cell && cell.matched === c.matched) {
        cell.registered = (c.to !== 'absent');
        cell.corrected = true;
        cell.why = c.why;
      }
    });
    return out;
  }

  /** 重ね合わせの集計。rows は codeSketch の結果の配列。 */
  function overlayTally(rows) {
    var out = {};
    FIELDS.forEach(function (f) {
      var n = 0, list = [];
      rows.forEach(function (r) { if (r.fields[f.key].registered) { n++; list.push(r.slug); } });
      out[f.key] = { n: n, of: rows.length, sketches: list };
    });
    return out;
  }

  // ------------------------------------------------------------------ 登録（データ本体）

  function REGISTER_QUOTES(obj) { Object.keys(obj).forEach(function (k) { QUOTES[k] = obj[k]; }); }
  function REGISTER_CODING(obj) { Object.keys(obj).forEach(function (k) { CODING[k] = obj[k]; }); }

  var api = {
    FIELDS: FIELDS, LEVELS: LEVELS, LEVEL_LABEL: LEVEL_LABEL, ENTRIES: ENTRIES,
    QUOTES: QUOTES, CODING: CODING, KEY_PATTERNS: KEY_PATTERNS,
    KEY_SYNONYMS_NOT_SEEN: KEY_SYNONYMS_NOT_SEEN, patternsFor: patternsFor,
    OVERLAY_CORRECTIONS: OVERLAY_CORRECTIONS,
    primaryFields: primaryFields, entryById: entryById,
    table: table, tally: tally, entriesFullyFilled: entriesFullyFilled,
    scorePrediction: scorePrediction, codeSketch: codeSketch, overlayTally: overlayTally,
    REGISTER_QUOTES: REGISTER_QUOTES, REGISTER_CODING: REGISTER_CODING
  };
  return api;
}));
