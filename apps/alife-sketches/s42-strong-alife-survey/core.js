/**
 * S-42 の核（集計器）。強い人工生命の主張を、本サブプロジェクトの登録項目へ写像する。
 *
 * 文献・考察のスケッチなので「走らせる系」は無い。代わりに **判断を含む分類を
 * 根拠つきの定数表として中に置く**（K-39）。各行に:
 *   - `why`   なぜその符号になるのか（読み手が表を書き換えて数え直せるように）
 *   - `anchor` その根拠が出典の本文に実在することを引用検証器が確かめられる引用 id
 * を添える。表を書き換えれば集計は追随する。
 *
 * 依存ゼロ。Node（CommonJS）とブラウザ（window.S42）で共用する古典スクリプト。
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.S42 = api;
}(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /* ------------------------------------------------------------------ *
   * 1. 出典（引用検証器の登録簿 raw/quotes.json と id を揃える）
   * ------------------------------------------------------------------ */
  var SOURCES = [
    { id: 'rennard2005', year: 2005, cite: 'Rennard, J.-Ph. (2005) Perspectives for Strong Artificial Life. arXiv:cs/0502060', reached: true },
    { id: 'bedau2003', year: 2003, cite: 'Bedau, M.A. (2003) Artificial life: organization, adaptation and complexity from the bottom up. TICS 7(11):505-512', reached: true },
    { id: 'giaveri2025', year: 2025, cite: 'Giaveri, S. et al. (2025) Building a Synthetic Cell Together. Nature Communications 16', reached: true },
    { id: 'kriegman2021', year: 2021, cite: 'Kriegman, S. et al. (2021) Kinematic self-replication in reconfigurable organisms. PNAS 118(49)', reached: true },
    { id: 'gumuskaya2024', year: 2024, cite: 'Gumuskaya, G. et al. (2024) Motile Living Biobots Self-Construct from Adult Human Somatic Progenitor Seed Cells. Advanced Science 11(4)', reached: true },
    { id: 'sharma2023', year: 2023, cite: 'Sharma, A. et al. (2023) Assembly theory explains and quantifies selection and evolution. Nature 622:321-328', reached: true },
    { id: 'ozelim2024', year: 2024, cite: 'Ozelim, L. et al. (2024) Assembly Theory Reduced to Shannon Entropy and Rendered Redundant by Naive Statistical Algorithms. arXiv:2408.15108', reached: true },
    { id: 'aguera2024', year: 2024, cite: 'Aguera y Arcas, B. et al. (2024) Computational Life: How Well-formed, Self-replicating Programs Emerge from Simple Interaction. arXiv:2406.19108', reached: true },
    { id: 'hughes2024', year: 2024, cite: 'Hughes, E. et al. (2024) Open-Endedness is Essential for Artificial Superhuman Intelligence. arXiv:2406.04268', reached: true },
    { id: 'hutchison2016', year: 2016, cite: 'Hutchison, C.A. et al. (2016) Design and synthesis of a minimal bacterial genome. Science 351(6280):aad6253', reached: false, why: 'Science の購読壁。PMC 版が無い（Europe PMC 照会で PMCID なし）' },
    { id: 'mogerreischer2023', year: 2023, cite: 'Moger-Reischer, R.Z. et al. (2023) Evolution of a minimal cell. Nature 620:122-127', reached: true },
    { id: 'ameta2021', year: 2021, cite: 'Ameta, S. et al. (2021) Darwinian properties and their trade-offs in autocatalytic RNA reaction networks. Nature Communications 12:842', reached: true },
    { id: 'kumar2024', year: 2024, cite: 'Kumar, A. et al. (2024) Automating the Search for Artificial Life with Foundation Models. arXiv:2412.17799', reached: false, why: 'PDF が取得上限（10MB）を超えた' },
    { id: 'isal2025', year: 2025, cite: 'International Society for Artificial Life, ALIFE 2023 / 2024 / 2025 conference sites', reached: false, why: '会議サイトは本文抽出の対象にしていない（引用を取らない）' }
  ];

  /* ------------------------------------------------------------------ *
   * 2. 系統（lineage）
   * ------------------------------------------------------------------ */
  var LINEAGES = [
    { id: 'def', label: '定義・枠組み', note: '強い／弱いの区別そのものと、分野が自分で立てた到達目標' },
    { id: 'wet', label: '湿った側', note: '合成最小細胞・ボトムアップ人工細胞・自己触媒する分子系' },
    { id: 'bio', label: '生物材料の組み替え', note: '既存の細胞から可動体を作る系統' },
    { id: 'comp', label: '計算の側', note: '計算系の中で「生きている」を主張する／しない系統' },
    { id: 'theory', label: '理論・指標', note: '生命性・選択を測る枠組みとその検討' },
    { id: 'tool', label: '道具立て', note: '研究の進め方を変えた道具（大規模計算・基盤モデル）' },
    { id: 'oee', label: 'オープンエンド', note: 'S-27・S-30 の後に何が変わったか（差分だけ）' },
    { id: 'comm', label: '会議・共同体', note: '人の集まり方の変化' }
  ];

  /* ------------------------------------------------------------------ *
   * 3. 主張の表（判断を含む。K-39 に従い根拠と錨を各行に置く）
   *
   *    S: 主張の強さ 0..3      I: 介入の有無 0/1
   *    items.strict / items.lenient: 5つ組のどれを充足とみなすか
   *      ['order','scale','thresh','ref','pop']
   * ------------------------------------------------------------------ */
  var CLAIMS = [
    {
      id: 'C-DEF', lineage: 'def', year: 1986, source: 'rennard2005',
      title: '「モデルであることをやめて生命の実例になる」——強い人工生命の定義',
      S: 3, I: 0,
      why: 'Langton 1986 の一文を Rennard が引き、それが「強い人工生命」と呼ばれるようになったと本文が明言する。対象を名指して生きていると言う立場の宣言なので S=3。介入の手続きは伴わない',
      anchor: 'q-strong-def',
      strict: ['order'], lenient: ['order'],
      note: '秩序変数は「生命の実例であること」。スケール・閾値・参照点・母集団は書かれていない'
    },
    {
      id: 'C-OPEN', lineage: 'def', year: 2003, source: 'bedau2003',
      title: '分野が自分で立てた到達目標のうち2つが強い人工生命',
      S: 1, I: 0,
      why: '14 の未解決問題のうち (2)「in silico の人工化学で生命への移行を達成する」と (3)「根本的に新しい生きた組織が無生物から生じうるかを決める」が強い側の目標にあたる。ただし個別の対象へ主張はしないので S=1',
      anchor: 'q-open-problems',
      strict: ['order'], lenient: ['order', 'pop'],
      note: '「移行」の秩序変数は名指されているが、どこで測るか（スケール）も閾値も書かれていない'
    },
    {
      id: 'C-TIERRA', lineage: 'comp', year: 1992, source: 'rennard2005',
      title: 'Tierra の生き物——強い主張の古典と、その後の評価',
      S: 2, I: 0,
      why: '本文は「Ray の生き物が完全に生きていると言うことではない」と検討の形を取り、さらに「それらを生きていると考えるのは非常に難しい」と否定側の評価を与える。主張の検討なので S=2',
      anchor: 'q-tierra',
      strict: ['order', 'thresh'], lenient: ['order', 'thresh', 'ref'],
      note: '秩序変数は「生命の直観的性質を8つ満たすか」。閾値は「8つのうちいくつ」。参照点は暗黙（生物）'
    },
    {
      id: 'C-BFF', lineage: 'comp', year: 2024, source: 'aguera2024',
      title: '相互作用だけから自己複製プログラムが自然発生する',
      S: 0, I: 1,
      why: '本文に "alive" の語が一度も出ない（引用検証器が同じ本文で確認した）。生命の語は分野名と動機にしか使わない。一方、相互作用の局所性・言語（BFF/Forth）・変異率を切り替えて出現を比べており、系を能動的に変える手続きを持つので I=1',
      anchor: 'q-bff-abstract',
      strict: ['order', 'scale', 'thresh', 'pop'], lenient: ['order', 'scale', 'thresh', 'ref', 'pop'],
      note: '秩序変数は圧縮長で近似した複雑度、スケールはエポック、閾値は状態転移の検出、母集団は run の集合。参照点（変異のみの対照）は図には在るが定義として書かれていない'
    },
    {
      id: 'C-XENO', lineage: 'bio', year: 2021, source: 'kriegman2021',
      title: '運動学的自己複製——生きているとは言わずに複製だけを主張する',
      S: 0, I: 1,
      why: '本文は対象を "synthetic multicellular assemblies" と呼び、生死を主張しない。主張は「どの生物にも見られなかった形の永続がある」という機構の主張にとどまる。設計を人工知能で変えて複製能を比べる手続きを持つので I=1',
      anchor: 'q-xenobot',
      strict: ['order', 'scale', 'thresh', 'ref', 'pop'], lenient: ['order', 'scale', 'thresh', 'ref', 'pop'],
      note: '秩序変数は子の数と世代、スケールは日、閾値は次世代を作るか、参照点は野生型、母集団は作った集合体。5つ組が全部立つ唯一の主張'
    },
    {
      id: 'C-ANTH', lineage: 'bio', year: 2024, source: 'gumuskaya2024',
      title: '成体ヒト細胞が自分で組み上がる可動体',
      S: 0, I: 1,
      why: '"biological robot (biobot)" と呼び、生死を主張しない。表題の "Living" は素材が生きた細胞であることを指す。微小環境の手がかりを操作して形態と行動を変えるので I=1',
      anchor: 'q-anthrobot',
      strict: ['order', 'scale', 'pop'], lenient: ['order', 'scale', 'thresh', 'ref', 'pop'],
      note: '秩序変数は運動の型と形態、スケールはミクロン・秒、母集団は培養した個体。閾値と参照点は本文に明示が無い'
    },
    {
      id: 'C-SYNCELL', lineage: 'wet', year: 2025, source: 'giaveri2025',
      title: 'ボトムアップ合成細胞——「生きた系を作りうること」を動機に置く共同体',
      S: 2, I: 1,
      why: '本文が「合成細胞の共同体は生きた系を作りうるという可能性に触発されている」と書く。ただし何をもって生きているとするかは本文が「合意されていない」と明言する。分子部品を足し引きして組み立てること自体が介入なので I=1',
      anchor: 'q-syncell-living',
      strict: ['order'], lenient: ['order', 'pop'],
      note: '「究極の目標さえ全員一致していない」と本文が書く。閾値が無いことを分野が自認している'
    },
    {
      id: 'C-SYN3', lineage: 'wet', year: 2016, source: 'hutchison2016',
      title: '最小細菌ゲノム syn3.0',
      S: 1, I: 1,
      why: '原典未到達。二次資料（Europe PMC の書誌）で存在と位置だけを確定した。遺伝子を削って生存を見る設計自体が介入にあたるが、本文を読んでいないので符号は暫定',
      anchor: null,
      strict: [], lenient: [],
      note: '未到達。P1 母集団には入れない'
    },
    {
            id: 'C-MINEVO', lineage: 'wet', year: 2023, source: 'mogerreischer2023',
            title: '最小細胞の進化——「生存と繁殖に要る遺伝子の最小数」を測る側から',
            S: 1, I: 1,
            why: '本文は最小細胞を「与えられた環境で生存と繁殖に必要な遺伝子の最小数を持つもの」と定義し、その上で適応度の進化を測る。対象が生きているかは論じず（既に生きたものとして扱う）、生命の最小条件を量として扱うので S=1。緩和選択下の変異蓄積と 2,000 世代の自然選択という2つの操作を設計しているので I=1',
            anchor: 'q-mincell-def',
            strict: ['order', 'scale', 'ref', 'pop'], lenient: ['order', 'scale', 'thresh', 'ref', 'pop'],
            note: '秩序変数は適応度（最大増殖速度）、スケールは世代、参照点は非最小化の親株、母集団は反復集団。閾値だけが本文に無い。参照点が明示されている数少ない例'
          },
    {
            id: 'C-RNA', lineage: 'wet', year: 2021, source: 'ameta2021',
            title: '自己触媒 RNA 反応網——ダーウィン的性質を化学の量として名指す',
            S: 1, I: 1,
            why: '本文は変異・差次的増殖・遺伝という3つを名指し、それらが配列の複写ではなく化学組成によって担われねばならないと書く。個別の系へ「生きている」とは言わないので S=1。網の位相（どの分子がどれを触媒するか）を実験で組み替えて性質を比べるので I=1',
            anchor: 'q-rna-darwinian',
            strict: ['order', 'pop'], lenient: ['order', 'scale', 'ref', 'pop'],
            note: '秩序変数は3つ組（変異・差次的増殖・遺伝）、母集団は反応網の集合。閾値は書かれておらず、参照点は交換関係（trade-off）の形で暗黙に置かれている'
          },
    {
      id: 'C-AT', lineage: 'theory', year: 2023, source: 'sharma2023',
      title: '組み立て理論——観測だけで「選択があった」と言おうとする枠組み',
      S: 1, I: 0,
      why: '個別の対象へ「生きている」とは言わず、選択と進化を量る指標を出す立場なので S=1。根拠は質量分析などの観測であり、系を突く手続きは持たないので I=0',
      anchor: 'q-assembly-index',
      strict: ['order', 'scale', 'thresh', 'ref', 'pop'], lenient: ['order', 'scale', 'thresh', 'ref', 'pop'],
      note: '秩序変数は組み立て指数 × 複製数、スケールは結合1回、閾値は図2が名指す Threshold、参照点は「選択なし」の分布、母集団は組み立て空間の対象。文献側で5つ組が全部立つもう1つの例'
    },
    {
      id: 'C-ATC', lineage: 'theory', year: 2024, source: 'ozelim2024',
      title: '組み立て指数は Shannon エントロピーに還元できるという批判',
      S: 1, I: 0,
      why: '同じ量を別の道具で再現できるかを問う批判。生死の主張はしないので S=1。計算機上の再計算であり系への介入ではない',
      anchor: 'q-at-critique',
      strict: ['order', 'ref'], lenient: ['order', 'scale', 'ref', 'pop'],
      note: '参照点が明示的（LZ 圧縮・素朴な統計アルゴリズム）。批判の側が参照点を持ち込んでいる'
    },
    {
      id: 'C-OEE', lineage: 'oee', year: 2024, source: 'hughes2024',
      title: 'オープンエンドの定義が「観測者から見て新規かつ学習可能」へ移った',
      S: 0, I: 0,
      why: '生命の主張をしない（機械学習側の定義）。S-27・S-30 が扱った活性指標との差分はここにある——参照点が集団の中立影から**観測者の予測モデル**へ移った',
      anchor: 'q-oee-def',
      strict: ['order', 'scale', 'ref', 'pop'], lenient: ['order', 'scale', 'thresh', 'ref', 'pop'],
      note: '秩序変数は予測損失、スケールは時刻、参照点は観測者のモデル、母集団は産物の列。閾値は不等式で書かれるが数値ではない'
    },
    {
      id: 'C-ASAL', lineage: 'tool', year: 2024, source: 'kumar2024',
      title: '基盤モデルで人工生命の探索を自動化する',
      S: 0, I: 0,
      why: '原典未到達（PDF が取得上限超過）。書誌のみ確定',
      anchor: null,
      strict: [], lenient: [],
      note: '未到達'
    },
    {
      id: 'C-SUMMIT', lineage: 'comm', year: 2024, source: 'giaveri2025',
      title: '合成細胞の共同体が世界規模で1つの会に集まった',
      S: 0, I: 0,
      why: '本文が「36名の上級研究者と12名の若手が2024年10月に深圳へ集まり、初の SynCell Global Summit を開いた」と書く。人の集まり方の事実であり生死の主張ではない',
      anchor: 'q-summit',
      strict: ['pop'], lenient: ['pop'],
      note: '母集団（誰が集まったか）だけが数で書かれている'
    },
    {
      id: 'C-CONF', lineage: 'comm', year: 2025, source: 'isal2025',
      title: 'ALIFE 会議の主題',
      S: 0, I: 0,
      why: '会議サイトから題名だけを取った。本文抽出の対象にしていないので引用は取らない',
      anchor: null,
      strict: [], lenient: [],
      note: '未到達扱い'
    }
  ];

  var ITEMS = ['order', 'scale', 'thresh', 'ref', 'pop'];
  var ITEM_LABEL = { order: '秩序変数', scale: 'スケール', thresh: '閾値', ref: '参照点', pop: '母集団' };

  /* ------------------------------------------------------------------ *
   * 4. 集計（純関数）
   * ------------------------------------------------------------------ */
  function sourceById(id) {
    for (var i = 0; i < SOURCES.length; i++) if (SOURCES[i].id === id) return SOURCES[i];
    return null;
  }

  /** 主張が母集団 pop（'P1' | 'P2'）に入るか。 */
  function inPopulation(claim, pop) {
    if (pop === 'P2') return true;
    var s = sourceById(claim.source);
    return !!(s && s.reached);
  }

  /** 符号化1件（arm は 'strict' | 'lenient'）。 */
  function code(claim, arm) {
    var s = sourceById(claim.source);
    var reached = !!(s && s.reached);
    var items = reached ? (claim[arm] || []) : [];
    var flags = {};
    ITEMS.forEach(function (k) { flags[k] = items.indexOf(k) >= 0 ? 1 : 0; });
    return {
      id: claim.id, lineage: claim.lineage, year: claim.year, source: claim.source,
      reached: reached, arm: arm,
      S: reached ? claim.S : claim.S, I: reached ? claim.I : claim.I,
      F: items.length, flags: flags, anchor: claim.anchor || null
    };
  }

  /** 母集団 × 符号化腕の集計。 */
  function tally(pop, arm, claims) {
    var rows = (claims || CLAIMS).filter(function (c) { return inPopulation(c, pop); })
      .map(function (c) { return code(c, arm); });
    var n = rows.length;
    var byItem = {};
    ITEMS.forEach(function (k) {
      byItem[k] = rows.reduce(function (a, r) { return a + r.flags[k]; }, 0);
    });
    var Fs = rows.map(function (r) { return r.F; }).sort(function (a, b) { return a - b; });
    var sHist = { 0: 0, 1: 0, 2: 0, 3: 0 };
    rows.forEach(function (r) { sHist[r.S]++; });
    return {
      pop: pop, arm: arm, n: n,
      strongClaims: sHist[3], examined: sHist[2], metric: sHist[1], none: sHist[0],
      sHist: sHist,
      intervention: rows.reduce(function (a, r) { return a + r.I; }, 0),
      Fsum: Fs.reduce(function (a, b) { return a + b; }, 0),
      Fmedian: n ? median(Fs) : 0,
      Fmean: n ? Fs.reduce(function (a, b) { return a + b; }, 0) / n : 0,
      byItem: byItem,
      itemRate: ITEMS.reduce(function (o, k) { o[k] = n ? byItem[k] / n : 0; return o; }, {}),
      rows: rows
    };
  }

  function median(sorted) {
    var n = sorted.length;
    if (!n) return 0;
    return n % 2 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  }

  /** 系統ごとの集計と、事前登録した閾値による個別レポートの切り出し判定。 */
  function lineageTable(claims) {
    var cs = claims || CLAIMS;
    return LINEAGES.map(function (L) {
      var mine = cs.filter(function (c) { return c.lineage === L.id; });
      var reached = mine.filter(function (c) { var s = sourceById(c.source); return s && s.reached; });
      return {
        id: L.id, label: L.label, note: L.note,
        n: mine.length, reached: reached.length,
        bigTopic: mine.length >= 2 && reached.length >= 1,
        claims: mine.map(function (c) { return c.id; })
      };
    });
  }

  /** strict と lenient の差（= 本文に書かれていない分）。 */
  function gap(pop) {
    var s = tally(pop, 'strict'), l = tally(pop, 'lenient');
    var per = {};
    ITEMS.forEach(function (k) { per[k] = l.byItem[k] - s.byItem[k]; });
    return { pop: pop, strictFsum: s.Fsum, lenientFsum: l.Fsum, delta: l.Fsum - s.Fsum, perItem: per };
  }

  /** 事前登録した予測の照合。 */
  function scorePredictions() {
    var p1s = tally('P1', 'strict'), p1l = tally('P1', 'lenient');
    var p2s = tally('P2', 'strict');
    var g = gap('P1');
    var bio = CLAIMS.filter(function (c) { return c.lineage === 'bio'; });
    var bioI = bio.filter(function (c) { return c.I === 1; }).length;
    var nonBioI = CLAIMS.filter(function (c) {
      var s = sourceById(c.source); return s && s.reached && c.lineage !== 'bio' && c.I === 1;
    }).length;
    var refThreshGap = g.perItem.ref + g.perItem.thresh;
    var otherGap = g.delta - refThreshGap;
    return [
      { id: 'P1', text: 'S=3 は P1 母集団の半数に満たない',
        value: p1s.strongClaims + '/' + p1s.n, hit: p1s.strongClaims * 2 < p1s.n },
      { id: 'P2', text: 'F の中央値は 2 以下（strict・P1）',
        value: String(p1s.Fmedian), hit: p1s.Fmedian <= 2 },
      { id: 'P3', text: 'strict と lenient の差は閾値と参照点に集中する',
        value: refThreshGap + ' 対 ' + otherGap, hit: refThreshGap > otherGap },
      { id: 'P4', text: 'I=1 は生物材料の系統に偏る',
        value: bioI + '/' + bio.length + ' 対 ' + nonBioI, hit: bioI === bio.length && nonBioI < bioI },
      { id: 'P5', text: 'S=3 の件数は母集団を P1→P2 に広げても変わらない',
        value: 'S3 ' + p1s.strongClaims + '→' + p2s.strongClaims + ' / I ' + p1s.intervention + '→' + p2s.intervention,
        hit: p1s.strongClaims === p2s.strongClaims },
      { id: 'S-lenient', text: '（参考）lenient 腕の F 合計', value: String(p1l.Fsum), hit: null }
    ];
  }

  /** 正・負コントロール。表と集計そのものを検査する。 */
  function checks() {
    var out = [];
    function add(kind, name, ok, detail) { out.push({ kind: kind, name: name, pass: !!ok, detail: detail }); }

    // 正: 表の形
    add('正', '全ての主張が既知の系統に属する',
      CLAIMS.every(function (c) { return LINEAGES.some(function (L) { return L.id === c.lineage; }); }));
    add('正', '全ての主張が既知の出典を指す',
      CLAIMS.every(function (c) { return !!sourceById(c.source); }));
    add('正', '全ての主張に根拠の文がある',
      CLAIMS.every(function (c) { return typeof c.why === 'string' && c.why.length > 10; }));
    add('正', '原典に到達した主張は必ず錨（引用 id）を持つ',
      CLAIMS.every(function (c) { var s = sourceById(c.source); return !(s && s.reached) || !!c.anchor; }));
    add('正', '未到達の主張は錨を持たない',
      CLAIMS.every(function (c) { var s = sourceById(c.source); return (s && s.reached) || !c.anchor; }));
    add('正', 'strict の充足は lenient の部分集合',
      CLAIMS.every(function (c) {
        return (c.strict || []).every(function (k) { return (c.lenient || []).indexOf(k) >= 0; });
      }));
    add('正', '充足項目は5つ組の語彙だけを使う',
      CLAIMS.every(function (c) {
        return (c.lenient || []).every(function (k) { return ITEMS.indexOf(k) >= 0; });
      }));
    add('正', 'S は 0..3・I は 0/1',
      CLAIMS.every(function (c) { return c.S >= 0 && c.S <= 3 && (c.I === 0 || c.I === 1); }));

    // 正: 集計の恒等式（K-18。実装の外から来る関係）
    var t = tally('P1', 'strict');
    add('正', 'F の合計は項目別の合計に一致する',
      t.Fsum === ITEMS.reduce(function (a, k) { return a + t.byItem[k]; }, 0),
      t.Fsum + ' = ' + ITEMS.map(function (k) { return t.byItem[k]; }).join('+'));
    add('正', 'S の度数分布の総和が母集団の大きさに一致する',
      t.sHist[0] + t.sHist[1] + t.sHist[2] + t.sHist[3] === t.n, t.n + ' 件');

    // 負: 未到達を混ぜても P1 は変わらない
    var p1 = tally('P1', 'strict'), p2 = tally('P2', 'strict');
    add('負', 'P2 は P1 より大きく、F 合計は増えない（未到達は F=0）',
      p2.n > p1.n && p2.Fsum === p1.Fsum, 'n ' + p1.n + '→' + p2.n + ' / Fsum ' + p1.Fsum + '→' + p2.Fsum);

    // 負: 存在しない系統・出典は 0 件を返す
    add('負', '存在しない系統を引くと 0 件',
      lineageTable().every(function (r) { return r.id !== 'zzz'; }) &&
      CLAIMS.filter(function (c) { return c.lineage === 'zzz'; }).length === 0);
    add('負', '存在しない出典は null を返す', sourceById('nosuch') === null);

    // 負: 符号器が符号を無視していないか（全部同じ値を返していない）
    var sVals = {}, iVals = {};
    CLAIMS.forEach(function (c) { sVals[c.S] = 1; iVals[c.I] = 1; });
    add('負', 'S が定数列になっていない', Object.keys(sVals).length >= 3, Object.keys(sVals).join(','));
    add('負', 'I が定数列になっていない', Object.keys(iVals).length === 2, Object.keys(iVals).join(','));

    // 負: 偽の錨は登録簿に無い（run.js が quotes.json と突き合わせる）
    add('負', '偽の錨 q-nonexistent は表に無い',
      !CLAIMS.some(function (c) { return c.anchor === 'q-nonexistent'; }));

    return out;
  }

  return {
    SOURCES: SOURCES, LINEAGES: LINEAGES, CLAIMS: CLAIMS, ITEMS: ITEMS, ITEM_LABEL: ITEM_LABEL,
    sourceById: sourceById, inPopulation: inPopulation, code: code,
    tally: tally, lineageTable: lineageTable, gap: gap,
    scorePredictions: scorePredictions, checks: checks, median: median
  };
}));
