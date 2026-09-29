/**
 * S-27 の**符号の定数表**と、その根拠の引用（K-39）。
 *
 * ここが本スケッチの判断の全部である。各マスは
 *   verdict : 'filled'（明示して埋めた）/ 'open'（読み手に委ねた）/ 'absent'（触れない）
 *   quotes  : 判定の根拠にした一次資料の文の id（filled と open は必須・absent は持たない）
 *   why     : なぜその符号なのか
 * からできている。**表を書き換えれば集計も変わる**——読み手が数え直せる形にしてある。
 *
 * 引用の text は取得した本文から切り出したもので、`run.js` がこれを `raw/quotes.json` へ
 * 書き出し、`raw/verify.py` が出典を再取得して実在を機械検査する。
 * 出典の PDF は語間の空白と合字（ﬁ ﬂ ﬀ）を落とし、二段組は行末で語を折るので、
 * 検証器はその3つだけを吸収して照合する。それ以外は一字も緩めない。
 * 引用に "dif-culties" のような綴りが残っているのは、**原文の合字が抽出で落ちた跡**である
 * （難しさ＝difficulties）。直すと照合が通らなくなるので、抽出されたままにしてある。
 *
 * Node とブラウザで共用する古典スクリプト。
 */
(function (root, factory) {
  var data = factory();
  if (typeof module === 'object' && module.exports) module.exports = data;
  if (typeof window !== 'undefined' && window.S27) {
    window.S27.REGISTER_QUOTES(data.quotes);
    window.S27.REGISTER_CODING(data.coding);
  }
}(this, function () {
  'use strict';

  function q(id, source, text) { return { id: id, source: source, text: text, readable: text }; }

  var Q = {};
  [
    // ---------------------------------------------------------------- M01 Bedau & Packard 1992
    q('q-M01-V-1', 'M01', 'We define evolutionary activity as the rate at which useful genetic innovations are absorbed into the population.'),
    q('q-M01-V-2', 'M01', 'evolutionary activity A(t) of a system as the rate at which net persistence is dropping at u0'),
    q('q-M01-S-1', 'M01', 'the micro-entities can be any functional units, any units with adaptive significance. Our measure applies to any level at which natural selection operates.'),
    q('q-M01-S-2', 'M01', 'To prevent such false positives, one must count usage only at levels on which units have adaptive significance.'),
    q('q-M01-Th-1', 'M01', 'In practice, it is easy enough to identify a plausible reference point u0 by glancing at N(t;u) and picking a usage value above the initial large fall-off in usage'),
    q('q-M01-Th-2', 'M01', 'The exact value of u0 is not crucial.'),
    q('q-M01-P-1', 'M01', 'This sum is then normalized by dividing by the number of genes in the population, Ng. Thus, N(t;u) is the total fraction of genes in the entire population having usage u at time t.'),
    q('q-M01-P-2', 'M01', 'since these waves would terminate above the reference point u0, extinctions would not be registered in evolutionary activity A(t)'),
    q('q-M01-T-1', 'M01', 'since activity waves occur on much longer time scales than generations'),

    // ---------------------------------------------------------------- M02 Bedau, Snyder & Packard 1998
    q('q-M02-V-1', 'M02', 'A measure of the continual adaptive success of the components in the system at a given time is provided by the total cumulative evolutionary activity'),
    q('q-M02-S-1', 'M02', "the choice of what to count as a system's components affects a system's diversity as measured by D(t)"),
    q('q-M02-S-2', 'M02', "The classification of a system's evolutionary dynamics depends on certain decisions made when defining the"),
    q('q-M02-Th-1', 'M02', "to determine that activity level, a0, at which we can begin to have confidence that a component's activity reflects its positive adaptive value, and we let a0 and a1 define a small window surrounding a0"),
    q('q-M02-R-1', 'M02', "we normalize Echo's activity data by subtracting the neutral shadow's new or cumulative activity from that of Echo"),
    q('q-M02-R-2', 'M02', 'Each Echo run has its own corresponding neutral shadow run.'),
    q('q-M02-P-1', 'M02', "the system's diversity, D(t), which is simply the number of components present at time t"),
    q('q-M02-U-1', 'M02', 'In the first instance, our classification applies to the evolutionary dynamics in a given run of a given system. But if different runs of the same system at the same spot in parameter space all exhibit the same class of evolutionary dynamics, then the classification is a generic property of that system at that place in parameter space.'),
    q('q-M02-T-1', 'M02', 'A system must be observed long enough for long-term trends to reveal themselves'),

    // ---------------------------------------------------------------- M04 Standish 2000
    q('q-M04-V-1', 'M04', 'Activity of a species is defined as the population count of that species, the vector n in Ecolab terms.'),
    q('q-M04-V-2', 'M04', 'This corresponds the the number of new species crossing a threshold, divided by the diversity.'),
    q('q-M04-S-1', 'M04', 'was chosen empirically to make new species phenotypically distinct from its parent species.'),
    q('q-M04-S-2', 'M04', 'so one timestep corresponds to about a 14th of the dou-bling time of the fastest reproducing organism'),
    q('q-M04-Th-1', 'M04', 'In (Bedau et al., 1998), this threshold is determined by plotting the activity distributions for both the original and the shadow model, and taking the cross-over point as the threshold.'),
    q('q-M04-Th-2', 'M04', 'This turned out to be 50 individuals, rather than the arbitrary 10 individuals used in other Ecolab studies.'),
    q('q-M04-R-1', 'M04', 'An important feature for improving the accuracy of the evolutionary statistics is the use of a neutral shadow model. This model should be as similar as possible to the original model, but with all selection turned off.'),
    q('q-M04-P-1', 'M04', 'Finally, this activity is accumulated over the life-time of the species, and then averaged over all species.'),
    q('q-M04-U-1', 'M04', 'Figure 1 shows the Bedau statistics for typical Ecolab runs (panmictic, or spatially independent case), as a function of mutation rate.'),
    q('q-M04-T-1', 'M04', 'however due to some implementation dif-culties, run lengths exceeding 1'),

    // ---------------------------------------------------------------- M05 Standish 2003
    q('q-M05-V-1', 'M05', 'In algorithmic complexity, the complexity of a description is defined to be the length of the shortest program that can generate the description, when run on a particular universal Turing machine (UTM).'),
    q('q-M05-S-1', 'M05', 'The precise definition of the phenotype has a big in'),
    q('q-M05-S-2', 'M05', 'classify sites as hot if every possible mutation leaves the organism neutrally equivalent, and cold if any mutation changes the phenotype.'),
    q('q-M05-Th-1', 'M05', 'out to a certain cutoff value (usually 2 hops in this experiment'),
    q('q-M05-R-1', 'M05', 'There are two key problems with algorithmic complexity. The first is the arbi-trariness of the reference Turing machine U.'),
    q('q-M05-R-2', 'M05', 'The first problem is really a non-problem. All information is context dependent, with the context being defined by the receiver or interpreter of a message.'),
    q('q-M05-P-1', 'M05', 'the organisms are sorted into phenotypically equivalent classes, resulting in a small list of 26 archety-pal organisms. These are labeled by the genotype with the earliest creation date.'),
    q('q-M05-U-1', 'M05', 'show the results for a size-neutral run of Tierra. In this run, no increase in organismal complexity was observed'),
    q('q-M05-T-1', 'M05', 'This is not an especially lengthy Tierra run, however, and perhaps real complexity takes much longer'),

    // ---------------------------------------------------------------- M06 Channon 2001
    q('q-M06-V-1', 'M06', 'So it is median activity, not mean activity, that should be measured, and required to be unbounded for a system to be classi'),
    q('q-M06-V-2', 'M06', 'When diversity is bounded, the retention forever of a single component results in unbounded mean activity.'),
    q('q-M06-S-1', 'M06', 'This can be thought of as a disjoint grouping of alleles, with each group being a component.'),
    q('q-M06-S-2', 'M06', 'In the results reported here, snapshots were taken ev-ery one thousand timesteps.'),
    q('q-M06-Th-1', 'M06', 'so a0 should be high enough to screen out most non-adaptive activity and not amongst the highest activities so a1 should be low enough that a good proportion of activities lie above it.'),
    q('q-M06-Th-2', 'M06', 'So the results that follow were calculated using a new-activity range of'),
    q('q-M06-R-1', 'M06', 'should be run, mirroring the real run in every detail except that whenever selection operates in the real system, random selection should be employed in the shadow.'),
    q('q-M06-R-2', 'M06', 'The main concern that I have at this time is that the test relies on normal-isation or validation from a shadow that can drift away from core aspects of the real run that it is intended to shadow.'),
    q('q-M06-P-1', 'M06', 'I screen out in each of the real and shadow populations isolated occurrences: when a component occurs in the current snapshot but not the previous one.'),
    q('q-M06-P-2', 'M06', 'So for the set of runs from which the example reported here is taken, I set a minimum number of organisms to twenty.'),
    q('q-M06-U-1', 'M06', 'This section contains the results from a typical run, drawn from the full set of twenty runs. Atypical variations are discussed at the end of this section.'),
    q('q-M06-T-1', 'M06', 'the run reported lasted six million timesteps, during which time there were over five hundred and eighty million organism reproductions.'),

    // ---------------------------------------------------------------- M07 Taylor et al. 2016
    q('q-M07-V-1', 'M07', 'Both hallmarks of OEE and mechanisms for OEE are important, but they are important for different reasons. The hallmarks identify the important distinctive observable signs of different kinds of OEE.'),
    q('q-M07-V-2', 'M07', 'The York workshop constructed an initial list of behavioral hallmarks of OEE.'),
    q('q-M07-S-1', 'M07', 'He argued that conventional component-based evolutionary activity measures of OEE are problematic because they require us to identify the components of interest beforehand'),
    q('q-M07-Th-1', 'M07', 'we can define boundedness of a metric within a system in a rigorous way by fitting mathematical functions to the data and using statistics to ascertain which function is the best fit'),
    q('q-M07-Th-2', 'M07', 'However, it is not possible in finite system time to establish that a metric is truly unbounded.'),
    q('q-M07-R-1', 'M07', 'Bedau et al. reasoned that it was not necessary to include a shadow mechanism in this analysis'),
    q('q-M07-R-2', 'M07', 'felt that a sensible null hypothesis might be to assume that ALife systems were unbounded by default, i.e. they might just need more time and larger environments to display OEE'),
    q('q-M07-P-1', 'M07', 'it is based solely on population data like other evolutionary measures'),
    q('q-M07-U-1', 'M07', "where it was necessary to increase these to establish increases in the metric's maximum observed value over successive runs."),

    // ---------------------------------------------------------------- M08 Lehman & Stanley 2011
    q('q-M08-V-1', 'M08', 'A simple measure of sparseness at a point is the average distance to the k-nearest neighbors of that point, where k is a fixed parameter that is determined experimentally.'),
    q('q-M08-Th-1', 'M08', 'above some minimal threshold'),
    q('q-M08-P-1', 'M08', 'The nearest neighbors calculation must take into consideration individuals from the current population and from the permanent archive of novel individuals.'),
    q('q-M08-P-2', 'M08', 'The current generation plus the archive give a comprehensive sample of where the search has been and'),
    q('q-M08-U-1', 'M08', 'both averaged over 40 runs of each approach.'),
    q('q-M08-T-1', 'M08', 'Only the first 75,000 evaluations out of 250,000 are shown because the dynamics remain stable after that point.'),

    // ---------------------------------------------------------------- M10 Dolson et al. 2019（MODES）
    q('q-M10-V-1', 'M10', 'Our first metric focuses on whether the genetic makeup of the population is changing in a non-trivial way.'),
    q('q-M10-V-2', 'M10', 'The novelty metric measures how many components have evolved in the population that have never been seen previously in the experiment.'),
    q('q-M10-S-1', 'M10', 'In general, using a value of $t$ equal to population size seems to be an adequate filter.'),
    q('q-M10-S-2', 'M10', 'alleles or genotypes are typically used as components, while in the fossil record, whole species were used as components'),
    q('q-M10-Th-1', 'M10', 'where $t$ is a pre-determined number of generations indicating the length of our filtering process'),
    q('q-M10-Th-2', 'M10', 'we tried $t$ values of 500, 1000, and 2000.'),
    q('q-M10-R-1', 'M10', "there should be a corresponding ``shadow'' run in which any outcome of selection is replaced with a random choice."),
    q('q-M10-R-2', 'M10', 'Whereas shadow runs filter out the effect of neutral processes, the persistence filter does not entirely.'),
    q('q-M10-P-1', 'M10', 'is the set of all components that have ever passed the filter, $F$ is the set of components from the current time point that passed the filter'),
    q('q-M10-U-1', 'M10', 'In each condition, we ran 30 replicate runs of Avida.'),

    // ---------------------------------------------------------------- M11 Packard et al. 2019
    q('q-M11-V-1', 'M11', 'Rather than merely gathering statistics, they compute quantities like change potential, novelty potential, and complexity potential'),
    q('q-M11-S-1', 'M11', 'One problem for the statistical detection of open-endedness in evolving systems is that statistics can be gathered only for the kinds of entities that are specified in advance.'),
    q('q-M11-Th-1', 'M11', 'Indefinitely scalable complexity has become a hallmark of OEE systems, essentially considered a necessary condition.'),
    q('q-M11-P-1', 'M11', 'But once the kinds of entities are prespecified, how can the production of new and different kinds of entities be recognized?'),

    // ---------------------------------------------------------------- M12 Hintze 2019
    q('q-M12-V-1', 'M12', 'A convenient way to approximate the theoretical lower bound of Kolmogorov complexity is the compressibility of a sequence'),
    q('q-M12-V-2', 'M12', 'The Levenshtein distance [16] is used to measure the diversity between the evolving populations.'),
    q('q-M12-S-1', 'M12', 'The system presented here consists of 100 organisms, each defined by a genome.'),
    q('q-M12-Th-1', 'M12', 'when the measure of diversity over evolutionary time is fitted against the hyperbolic (Equation 2) or the exponential (Equation 3) model, the error is smaller with the exponential model.'),
    q('q-M12-R-1', 'M12', 'This supports the notion that diversity will also increase indefinitely and not plateau'),
    q('q-M12-P-1', 'M12', 'When measuring diversity, one random sequence from each experiment is chosen, and the mean Levenshtein distance between all pairwise comparisons across all 100 replicate experiments is computed.'),
    q('q-M12-T-1', 'M12', 'The experiment was run for 5 million generations in 100 replicate instances using different random number seeds.'),

    // ---------------------------------------------------------------- M14 Bullock & Bedau 2006
    q('q-M14-V-1', 'M14', 'so an appropriate measure of its activity would be its cumulative frequency over a period of evolutionary time.'),
    q('q-M14-S-1', 'M14', 'class of elements to be tracked (genotypes, alleles, equivalence classes of alleles, etc.)'),
    q('q-M14-Th-1', 'M14', 'how long must an activity wave persist before we can be confident that it represents a response to selective pressure, rather than merely the transient effects of evolutionary drift?'),
    q('q-M14-R-1', 'M14', 'One method of constructing a neutral model N of an adaptive system S is to record the time at which every birth and death event in S occurred during a period of evolution'),
    q('q-M14-P-1', 'M14', 'To track evolutionary activity in the entire population, one would simply make these measurements for each unique genotype generated during the course of evolution.'),
    q('q-M14-T-1', 'M14', 'at or around iteration 600 the ancestral genotype is driven extinct by a small group of more efficient replicators')
  ].forEach(function (o) { Q[o.id] = o; });

  function cell(verdict, quotes, why) { return { verdict: verdict, quotes: quotes, why: why }; }

  var CODING = {

    // ================================================================ M01（1992）
    M01: {
      V: cell('filled', ['q-M01-V-1', 'q-M01-V-2'],
        '活性 A(t) を「u0 における net persistence の傾き」として式で与えている'),
      S: cell('open', ['q-M01-S-1', 'q-M01-S-2'],
        '使用カウンタを付ける micro-level entity は「適応的な意味を持つ単位なら何でもよい」とされ、値も手続きも固定されない。同じ節で、この選択次第で偽陽性・偽陰性が出ると自ら書いている'),
      Th: cell('filled', ['q-M01-Th-1', 'q-M01-Th-2'],
        '切り位置 u0 の導出手続き（N(t,u) を見て初期の急な落ち込みの上を取る）が明示されている。値そのものは「重要ではない」と書かれているが、本稿の規則では**導出手続きがあれば filled** とする'),
      R: cell('absent', [],
        '帰無モデル・影・基準線にあたるものが本文に無い。"shadow" は全文で1回だけで、しかも "overshadowing" という非技術的な用法。**"reference point" という語はあるが、それは u0 ＝ 使用量の切り位置**であって、対比の相手ではない'),
      P: cell('filled', ['q-M01-P-1', 'q-M01-P-2'],
        'N(t,u) の分母を「その時点の個体群にある遺伝子の数 Ng」と限定し、さらに絶滅した波は A(t) に登録されないと明記している'),
      U: cell('absent', [],
        '1本の走行を単位にするのか複数本を束ねるのかについての文が無い'),
      T: cell('open', ['q-M01-T-1'],
        '活性の波が世代よりずっと長い時間尺度で起きるとは書くが、どこまで走らせた記録を読むかは固定しない')
    },

    // ================================================================ M02（1998）
    M02: {
      V: cell('filled', ['q-M02-V-1'],
        '多様性 D(t)・新規活性 A_new・累積活性 A_cum・平均活性を式で定義している'),
      S: cell('open', ['q-M02-S-1', 'q-M02-S-2'],
        '「何を構成要素と数えるかが D(t) を動かす」と自ら書いたうえで、対立遺伝子から分類群までの幅を認めたまま固定しない。**分野が自分で診断しているのに、選択は読み手に残っている**'),
      Th: cell('filled', ['q-M02-Th-1'],
        '切り位置 a0 を**中立影から決める**手続きが書かれている。閾値を参照点から導く形で、5列のうち2つを1つの手続きで結んでいる'),
      R: cell('filled', ['q-M02-R-1', 'q-M02-R-2'],
        '中立影（neutral shadow）の構成手続きが書かれている——適応的価値を持てない写しの個体群を走行ごとに1本ずつ作り、その活性を引く。**事前登録した正コントロールはここにある**'),
      P: cell('filled', ['q-M02-P-1'],
        'D(t) を「時刻 t に存在する構成要素の数」＝活性カウンタが正の要素の数として定義している'),
      U: cell('filled', ['q-M02-U-1'],
        '「まず1本の走行に当てる。同じ設定の別の走行が全部同じクラスを示すなら、そのクラスはその系の性質である」と束ね方を明示している'),
      T: cell('open', ['q-M02-T-1'],
        '「長期の傾向が現れるまで十分長く観察しなければならない」とは書くが、長さも判定法も与えない')
    },

    // ================================================================ M04（2000・Ecolab から見た批判）
    M04: {
      V: cell('filled', ['q-M04-V-1', 'q-M04-V-2'],
        '活性を「その種の個体数」と定め、A_new を「閾値を越えた新種の数 ÷ 多様性」と定義している'),
      S: cell('filled', ['q-M04-S-1', 'q-M04-S-2'],
        '種の半径 σ=0.1 を値で固定し、さらに**時間の刻みを系から借りている**——1ステップが最速の生物の倍加時間の約 1/4 になるように取る（[K-10](粒度を系から借りる)の実例）'),
      Th: cell('filled', ['q-M04-Th-1', 'q-M04-Th-2'],
        '閾値を「実系と影の活性分布を重ねて交点を取る」手続きで導き、**その結果 50 個体になった——他の Ecolab 研究が使っていた任意の 10 個体の 5 倍**だと書いている。導出を入れると値が 5 倍動いた実例'),
      R: cell('filled', ['q-M04-R-1'],
        '中立影の構成が明示されている（「元のモデルにできるだけ似せ、ただし選択を全部切る」）'),
      P: cell('open', ['q-M04-P-1'],
        '「種の生涯にわたって活性を積み、全種で平均する」と書くが、**その「全種」が現存種か既に消えた種を含むかは書かれていない**'),
      U: cell('open', ['q-M04-U-1'],
        '「典型的な Ecolab の走行」の統計を報告するとあるが、何本をどう束ねるかの規則は無い'),
      T: cell('filled', ['q-M04-T-1'],
        '走行長が 10⁶ ステップを超えられなかったと明記している（本稿の抽出では乗算記号が制御文字になるため、引用はその手前で切ってある）')
    },

    // ================================================================ M05（2003・複雑さの側から）
    M05: {
      V: cell('filled', ['q-M05-V-1'],
        'アルゴリズム的複雑さ（記述を生成する最短プログラムの長さ）を秩序変数に取っている'),
      S: cell('open', ['q-M05-S-1', 'q-M05-S-2'],
        '「表現型をどう定義するかが複雑さの値を大きく左右し、それは文脈に強く依存する」と明記したうえで固定しない。hot/cold の判定という具体的な操作化は示すが、表現型の定義そのものは開いたまま'),
      Th: cell('filled', ['q-M05-Th-1'],
        '中立ネットワークを辿る打ち切りを「通常 2 ホップ」と値で書いている'),
      R: cell('open', ['q-M05-R-1', 'q-M05-R-2'],
        '**参照点（基準万能機械 U）の恣意性を自分で二大問題の第一に挙げ、そのうえで「本当は問題ではない」と退けている**。構成手続きは与えない。参照点を名指しして棄却した唯一の例'),
      P: cell('filled', ['q-M05-P-1'],
        '生物を表現型で同値類にまとめ、26 個の原型に絞ったと明記している——数える対象の外延が限定されている'),
      U: cell('open', ['q-M05-U-1'],
        '1本の走行の結果を示すが、なぜ1本でよいかの規則は無い'),
      T: cell('filled', ['q-M05-T-1'],
        '走行長（6×10⁹ 命令）を明記し、そのうえで「特に長い走行ではない」と自ら限定している。**観測窓を申告し、かつ足りないかもしれないと書いた唯一の例**')
    },

    // ================================================================ M06（2001・Geb・中央値への切り替え）
    M06: {
      V: cell('filled', ['q-M06-V-1', 'q-M06-V-2'],
        '統計の一覧を式で与えたうえで、**平均活性では「1つの構成要素を永久に保持するだけ」で非有界になると気付き、中央値へ替えている**'),
      S: cell('filled', ['q-M06-S-1', 'q-M06-S-2'],
        '構成要素を「先行者＋リンクの詳細」という対立遺伝子の互いに素な分割として固定し、記録の刻みも千ステップに固定している'),
      Th: cell('filled', ['q-M06-Th-1', 'q-M06-Th-2'],
        '新規活性の帯 [a0,a1] の選び方を規則として書き、実際に使った値も本文に置いている'),
      R: cell('filled', ['q-M06-R-1', 'q-M06-R-2'],
        '影の構成（選択の代わりに乱択を使い、他は全部同じ）を明示し、**そのうえで「影が実走行から離れていってしまう」という参照点そのものへの批判を自分で書いている**'),
      P: cell('filled', ['q-M06-P-1', 'q-M06-P-2'],
        '孤立した出現（前の記録に無く今回だけ出たもの）を実系・影の両方から落とすと明記し、個体数の下限も 20 に固定している'),
      U: cell('filled', ['q-M06-U-1'],
        '「20 本のうちの典型的な1本の結果を示し、外れた3本は別に論じる」と単位を明示している'),
      T: cell('filled', ['q-M06-T-1'],
        '走行長を 600 万ステップ（5.8 億回の複製）と明記している')
    },

    // ================================================================ M07（2016・ワークショップ報告）
    M07: {
      V: cell('open', ['q-M07-V-1', 'q-M07-V-2'],
        '**hallmark（観測される徴候）の一覧**を作ることを目的にしていて、計算手続きは与えない。「量の名前」であって「量の手続き」ではない'),
      S: cell('open', ['q-M07-S-1'],
        'Ackley の批判——「構成要素を先に決めなければならない measure は、構成要素を観測量ではなく事前分布として扱うことになり、大転移を検出できない」——を記録するが、代わりの粒度は決めない'),
      Th: cell('filled', ['q-M07-Th-1', 'q-M07-Th-2'],
        '**判定の手続きを与えている**——データに関数を当てはめ、統計で最良の関数形を選び、それが非有界なら非有界と読む。同時に「有限の系時間では真に非有界だとは確立できない」とも書く'),
      R: cell('open', ['q-M07-R-1', 'q-M07-R-2'],
        '影を使わなかった判断（化石記録では不要）と「ALife の系は既定で非有界だと仮定するのが妥当な帰無仮説かもしれない」という意見を記録するが、参照点の構成は与えない'),
      P: cell('open', ['q-M07-P-1'],
        '「個体群のデータだけに基づく」とは書くが、誰を数えるかの外延は限定しない'),
      U: cell('open', ['q-M07-U-1'],
        '「連続する走行にわたって最大値の増加を確かめる」に触れるが、束ね方の規則にはしていない'),
      T: cell('open', ['q-M07-Th-2'],
        '**有限時間では非有界性を確立できない**と原理的な限界を述べるが、どこまで走らせるかは決めない')
    },

    // ================================================================ M08（2011・新奇性探索）
    M08: {
      V: cell('filled', ['q-M08-V-1'],
        '新奇性を「行動空間での k 近傍までの平均距離」と式で定義している'),
      S: cell('open', ['q-M08-V-1'],
        '**粒度にあたる k は「実験的に決める固定パラメータ」とだけ書かれ、値も決め方の手続きも無い**。定義の一文が、そのまま秩序変数の根拠でありスケールが開いている証拠でもある'),
      Th: cell('open', ['q-M08-Th-1'],
        '保管庫へ入れる切り位置 ρ_min の存在は書かれるが、値も導出も無い（k と同じ扱い）。動的に調整するという記述も見つからない'),
      R: cell('absent', [],
        '帰無過程・影・対照が指標の定義に無い。新奇性は現個体群と保管庫との相対で定義されるが、それは秩序変数そのものの定義であって、答えを読むための対比の相手ではない'),
      P: cell('filled', ['q-M08-P-1', 'q-M08-P-2'],
        '**近傍の計算に入れるのは「現在の個体群 ＋ 新奇な個体の永続的な保管庫」**と明記している。消えた個体を数えるかを正面から決めている数少ない例'),
      U: cell('filled', ['q-M08-U-1'],
        '各手法 40 本の走行の平均で比べると明示している'),
      T: cell('filled', ['q-M08-T-1'],
        '25 万回の評価のうち最初の 7.5 万回を示す、と窓を明示している')
    },

    // ================================================================ M10（2019・MODES）
    M10: {
      V: cell('filled', ['q-M10-V-1', 'q-M10-V-2'],
        'change / novelty / complexity / ecology の4つを、それぞれ計算手続きつきで定義している'),
      S: cell('filled', ['q-M10-S-1', 'q-M10-S-2'],
        '**濾過の長さ t を「個体群の大きさに等しく取る」と、粒度を系から借りている**（[K-10](粒度を系から借りる)が探していた形。本系譜で唯一の例）。構成要素の選択が分野ごとに違うことも明記する'),
      Th: cell('filled', ['q-M10-Th-1', 'q-M10-Th-2'],
        '濾過の長さを事前に決める量として定義し、実際に振った値（500・1000・2000）も書いている'),
      R: cell('filled', ['q-M10-R-1', 'q-M10-R-2'],
        '影走行（選択の結果を乱択に置き換えた双子）を参照点として定義し、**自分の持続濾過が影走行ほど中立過程を落としきれないことまで書いている**'),
      P: cell('filled', ['q-M10-P-1'],
        '**「一度でも濾過を通った構成要素の集合 S」と「現時点で濾過を通った集合 F」を別の記号で分けている**——K-30 が言う「消えたものを数えるか」を式の中で区別した唯一の例'),
      U: cell('filled', ['q-M10-U-1'],
        '各条件で 30 本のレプリケートを走らせたと明示している'),
      T: cell('absent', [],
        '走行の長さを述べた文が見つからない。濾過の長さ t（500/1000/2000）は書かれているが、それは粒度であって観測窓ではない')
    },

    // ================================================================ M11（2019・編集序文）
    M11: {
      V: cell('open', ['q-M11-V-1'],
        '他の論文の量（change / novelty / complexity / ecological potential）を紹介するが、自分では定義しない'),
      S: cell('open', ['q-M11-S-1'],
        '**「統計は、あらかじめ指定された種類の実体についてしか集められない」**という分野の中心問題（統計の難問）を述べるが、粒度は決めない'),
      Th: cell('open', ['q-M11-Th-1'],
        '「無限に拡張できる複雑さは事実上の必要条件と見なされるようになった」と基準に触れるが、切り位置も手続きも無い'),
      R: cell('absent', [],
        '帰無モデル・影・基準線に当たる記述が見つからない（"neutral"・"null model"・"baseline"・"shadow"・"control" のいずれも当たらない）'),
      P: cell('open', ['q-M11-P-1'],
        '**「実体の種類を事前に指定してしまったら、新しい種類の産出をどう認識できるのか」**——誰を数えるかの問題を最も鋭く述べた1文だが、答えは与えない'),
      U: cell('absent', [], '判定の単位に触れない'),
      T: cell('absent', [], '観測窓に触れない')
    },

    // ================================================================ M12（2019・批判）
    M12: {
      V: cell('filled', ['q-M12-V-1', 'q-M12-V-2'],
        '複雑さを zlib の圧縮率、多様性を Levenshtein 距離として、計算手続きまで書いている'),
      S: cell('filled', ['q-M12-S-1'],
        '測る対象を「100 個体、各個体は記号列のゲノム」と固定している'),
      Th: cell('filled', ['q-M12-Th-1'],
        '**双曲線（飽和する形）と指数（飽和しない形）を当てはめ、誤差の小さいほうを取る**という判定規則を書いている'),
      R: cell('open', ['q-M12-R-1'],
        '有界な関数形との当てはめ比較はあるが、これは同じデータへの別の関数形であって、選択や適応を切った帰無過程ではない。**読み方が分かれるマス**——帰無過程の構成と読めば absent、当てはめ比較を参照点と読めば filled になる。本稿は中間の open を取る'),
      P: cell('filled', ['q-M12-P-1'],
        '各実験から1本の配列を取り、100 本のレプリケート全部の対比較の平均を取ると明記している'),
      U: cell('filled', ['q-M12-P-1'],
        '判定は 100 本のレプリケートをまたいで作ると明示している（母集団の定義と同じ1文が単位も決めている）'),
      T: cell('filled', ['q-M12-T-1'],
        '500 万世代 × 100 本と明記している。**本系譜でいちばん長い走行を申告しながら、結論は「その程度の系でも既存の定義は通ってしまう」である**')
    },

    // ================================================================ M14（2006・活性図）
    M14: {
      V: cell('filled', ['q-M14-V-1'],
        '活性を「進化時間にわたる累積頻度」として定義している'),
      S: cell('open', ['q-M14-S-1'],
        '追跡する要素の類（遺伝子型・対立遺伝子・対立遺伝子の同値類など）を選べと言うだけで、どれかに決めない'),
      Th: cell('open', ['q-M14-Th-1'],
        '**「選択への応答だと確信できるまで、活性の波はどれだけ続けばよいのか」と問いの形で残している**。答えは値ではなく「中立モデルを作って引く」ことに置き換えられている'),
      R: cell('filled', ['q-M14-R-1'],
        '中立モデルの構成手続き（実系の出生と死亡の時刻を記録して再生する）を書いている'),
      P: cell('filled', ['q-M14-P-1'],
        '**「進化の過程で生成された一意な遺伝子型のそれぞれについて」測ると書いている——消えたものも含む側の外延を明示している**'),
      U: cell('absent', [],
        '複数本の走行・レプリケート・統計的な束ね方に触れる文が無い'),
      T: cell('open', ['q-M14-T-1'],
        '例示した図の中で時刻に言及するが、どこまで走らせた記録を読むかは決めない')
    }

    // M03・M09・M13 は原典へ到達できなかったので符号を付けない（core.js の reached: false）
  };

  return { quotes: Q, coding: CODING };
}));
