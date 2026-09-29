/**
 * S-40 の核。**判断を含む分類を、根拠つきの定数表としてここに置く**（[K-39]）。
 *
 * 本スケッチが数える対象は、既作 39 本（S-01〜S-39）と知見 K-1〜K-68 である。
 * 「どの自由度が結論を縛ったか」「その知見はどの層のものか」は機械には決められない判断なので、
 * 表にして根拠の文（why）と、レポート本文に実在することを機械で確かめられる錨（evidence）を添える。
 * **表を書き換えれば数も変わる**——判断と再計算を同じ場所に置くための形である（S-20 の recount.js の形を引き継ぐ）。
 *
 * 依存ゼロ・古典スクリプト。Node（`require`）とブラウザ（`window.S40`）で共用する。
 */
'use strict';

(function (global) {

  // ───────────────────────────────────────────────────────────── 記号と層

  /**
   * 自由度の記号。stratum は「誰の自由度か」で分けた層群:
   *   0 = 観測器の自由度（S-10 の選択 A / 検査 B、S-20 が足した外延 P・U・T）
   *   1 = 観測器の外にある自由度（題材・借り物・対照の実現・帰無の形）
   *   2 = 自由度ではないもの（観測の天井と、知見自身についての知見）
   */
  var SYMBOLS = {
    A1: { stratum: 0, group: '選択', name: 'どの量を測るか', k: [9, 10] },
    A2: { stratum: 0, group: '選択', name: 'どう作り直すか（粒度・形・記述の層・分け方）', k: [9, 21, 22] },
    A3: { stratum: 0, group: '選択', name: 'どこで切るか（閾値・集約・二値化）', k: [9, 23] },
    A4: { stratum: 0, group: '選択', name: '何と対比して読むか（参照点）', k: [24, 33, 54, 62] },
    B1: { stratum: 0, group: '検査', name: '偽陽性を出さないか（特異性）', k: [14, 17, 27] },
    B2: { stratum: 0, group: '検査', name: '偽陰性を出さないか（感度）', k: [15, 18, 49] },
    P: { stratum: 0, group: '外延', name: '母集団（誰を数えるか）', k: [30, 43, 45] },
    U: { stratum: 0, group: '外延', name: '判定の単位（何本を束ねて1判定か）', k: [35, 47] },
    T: { stratum: 0, group: '外延', name: '観測窓・登録上限（どこまで走らせ、どこまで探すか）', k: [26, 31, 63] },

    M: { stratum: 1, group: '題材', name: '題材の記述（原典の式・規則そのものの再構成）', k: [61, 65] },
    X: { stratum: 1, group: '借り物', name: '判定に外から借りた定数（臨界指数・公表値・合格線）', k: [51] },
    C: { stratum: 1, group: '対照', name: '対照の実現（乱択の対照が実際に何を変えたか）', k: [66] },
    H: { stratum: 1, group: '帰無', name: '帰無の形（偽陽性率を測る帰無の族）', k: [68] },

    L: { stratum: 2, group: '天井', name: '観測の天井（どの観測量でも区別できない）', k: [64] },
    K: { stratum: 2, group: '知見', name: '知見の層（どの主張が他の本へ移せるか）', k: [40, 59, 60, 67] },

    N: { stratum: -1, group: '—', name: '縛られなかった', k: [] },
  };

  /**
   * 層群の説明。S-20 が「A1〜A4 は『何を・どう・どこで・何と比べて測るか』で、
   * 測る対象の外延（誰を・何本を・いつまで）は問うていなかった」と書いたのと同じ形で、
   * 第1層・第2層が何を問うていなかったかを書く。
   */
  var STRATA = [
    {
      id: 0, name: '観測器の自由度',
      by: 'S-10（A・B）と S-20（P・U・T）',
      what: '観測器そのものを選ぶ自由。事前登録で固定できる（検査 B を除く）',
      blind: '観測器を全部固定しても、題材の記述・借り物の定数・対照の実現・帰無の形が動けば答えは動く',
    },
    {
      id: 1, name: '観測器の外にある自由度',
      by: 'S-24・S-33（X）／S-34（M）／S-37（H）／S-38（C）',
      what: 'やはり選択だが、選ぶのは観測器ではない。題材の記述・外から借りた定数・対照の実現・帰無の形',
      blind: 'これらを全部固定しても、そもそも観測で区別できない対があり、測った大きさは次の本へ移らない',
    },
    {
      id: 2, name: '自由度ではないもの',
      by: 'S-35・S-38・S-39（L）／S-36（K）',
      what: '選択肢が無いもの。①どの観測量を選んでも区別できないという天井 ②知見のうち何が移せるかという、知見自身についての知見',
      blind: '（本スケッチが数えられる範囲の外。次の締めが答える）',
    },
  ];

  // ───────────────────────────────────────────── 結論を縛った自由度（判断の表）

  /**
   * 35 本の実装スケッチの分類。文献・考察の 4 本（S-10・S-18・S-20・S-27）は
   * 枠組みを作った側なので分類しない（S-20 が S-10・S-18 を外したのと同じ規則）。
   *
   * inherit: 'S-20' の行は S-20 の分類表をそのまま引き継ぐ。機械は S-20 のレポート本文に
   *   `| S-NN | **記号**` の行が実在することを確かめる（再分類はしない）。
   * それ以外の行は本スケッチの判断で、evidence がその本のレポート本文に実在することを機械が確かめる。
   */
  var BINDING = [
    { id: 'S-01', primary: 'A3', secondary: ['A1'], inherit: 'S-20', why: '集約規則で閾値 f が 2.5〜3.25 に割れ、中央値が実在しない転移を作った' },
    { id: 'S-02', primary: 'A2', secondary: [], inherit: 'S-20', why: '連結半径 1.5→2.5 で「到達せず」→「ρ=0.04」。感度比 3.82（S-13 が後に A3 へ再分類）' },
    { id: 'S-03', primary: 'A4', secondary: ['B2'], inherit: 'S-20', why: '「自己維持」の二定義が互いに素な集合を返し、差は参照点だけだった' },
    { id: 'S-04', primary: 'N', secondary: ['A2'], inherit: 'S-20', why: '31 通りで閾値は 3 値。記述の層は R_control で事前に篩える' },
    { id: 'S-05', primary: 'N', secondary: ['B1'], inherit: 'S-20', why: '帰無値が定義から厳密に 0。負コントロールは1種のみで主張を字義まで狭めた' },
    { id: 'S-06', primary: 'B1', secondary: [], inherit: 'S-20', why: '帰無値 1.0 の2量が単独では非特異。連言だけが特異' },
    { id: 'S-07', primary: 'B1', secondary: ['A3'], inherit: 'S-20', why: '負コントロールが連言を通り、負コントロールではなかった' },
    { id: 'S-08', primary: 'B1', secondary: ['A2'], inherit: 'S-20', why: '4つの秩序変数それぞれに単独で通す偽物が実在' },
    { id: 'S-09', primary: 'B1', secondary: [], inherit: 'S-20', why: '整列度 1.000 で伝達ゼロ。連言だけが特異' },
    { id: 'S-11', primary: 'A2', secondary: ['B2'], inherit: 'S-20', why: '近傍の形（面積固定か個数固定か）で転移点が割れる' },
    { id: 'S-12', primary: 'T', secondary: [], inherit: 'S-20', why: '走行長だけで「有界」の札が動く。感度比 0.12' },
    { id: 'S-13', primary: 'A3', secondary: ['A4'], inherit: 'S-20', why: '半径の走査は偽陽性 0.53、曲線 1 回の検定は 0.06' },
    { id: 'S-14', primary: 'B1', secondary: ['T'], inherit: 'S-20', why: 'A∧B は帰無過程を通し、第三項 C で 0 に。周期上限 512 の外に現象' },
    { id: 'S-15', primary: 'A4', secondary: ['B1'], inherit: 'S-20', why: '参照点の取り替えで負コントロールの超過が符号ごと反転' },
    { id: 'S-16', primary: 'N', secondary: ['T'], inherit: 'S-20', why: 'none と equOnly が状態ハッシュまで同一で、強い分離' },
    { id: 'S-17', primary: 'A4', secondary: ['U', 'T'], inherit: 'S-20', why: '同じ行列を 3 参照点で読むと順位が 3 通り' },
    { id: 'S-19', primary: 'P', secondary: ['A3'], inherit: 'S-20', why: '指標 10 族は無情報、母集団で向きが反転' },

    {
      id: 'S-21', primary: 'P', secondary: ['A4', 'A3'],
      why: '閾値の位置は「誰を数えるか」で ×1.24〜×1.63 動き、合意配列の定義では参照点そのものが無限個体群に存在しない（K-43）。' +
        'ノブは位置を制御変数の 15.4 倍動かしたが、同じノブを理論の参照点にも当てた比は 0.002 しか動かない——ノブ依存は参照点（A4）が引き受けた',
      evidence: '「誰を数えるか」で閾値は ×1.24',
    },
    {
      id: 'S-22', primary: 'P', secondary: ['A1'],
      why: '閉包が仮定する「種の無限複製」と容器の有限個数の食い違いで、材料に数える最小個数 θ を 1 から 2 にするだけで activity が 0.98 → 0 に消えた（K-45。感度比 ≈ 8）。' +
        '副は秩序変数の選択——静的な「組織がある」と動的な「組織が回復する」が 0.97 対 0.03 に割れた（K-46）',
      evidence: 'activity は **0.98 → 0**',
    },
    {
      id: 'S-23', primary: 'T', secondary: ['A1', 'U'],
      why: '同じ再生の機構が T=256 では regenerates、T=512・1024 では partial になった——基準そのものが settled でない T で測ると札が甘くなる（K-26 の追記）。' +
        '副は、ラベルを無視する読み出しを感度比のノブに混ぜると 0 → 0.863 に跳ねること（K-48）と、決定論的な固定点ではシードが証拠にならないこと（K-47）',
      evidence: 'T=256 では同じ機構が「regenerates」になる',
    },
    {
      id: 'S-24', primary: 'X', secondary: ['T', 'B2'],
      why: '窓・点密度・下限・集約という観測器の選択を 108 通り振っても転移点は合計 0.0021 しか動かず、' +
        '検出器が外から借りている臨界指数 δ_ref だけで 0.0101 動いた（K-51）。借り物は観測器の内側の自由度ではなく判定の定義そのものである',
      evidence: '「どう測るか」より「何を臨界と呼ぶか」のほうが 5 倍効いた',
    },
    {
      id: 'S-25', primary: 'U', secondary: ['A4', 'A1'],
      why: '同じ機械・同じ誤り率で、数える単位（命令／個体／独立）を替えるだけで値が 0.215 / 0.089 / 0.031 と 7 倍に散った（K-35）。' +
        '副は参照点——何も見ない乱択帰属が原理的な規則のどれよりも 4 倍大きな値を返した（K-54）',
      evidence: '7 倍に散る',
    },
    {
      id: 'S-26', primary: 'A2', secondary: ['A4', 'A1'],
      why: '記述の層（作り直し）が制御変数で、45 マスの予測表は 42 マス的中。破れ 2 件のうち未宣言のほうは連結半径を 1→2 にするだけで消え、作り直しのノブに帰属できた（K-52）。' +
        '副は、同じ量の別の測り方か別の問いかの線引きが引けないノブ P（入れると感度比 1.186、外すと 0.474。K-48 の限界）',
      evidence: '連結半径を 1 から 2 へ変えるだけで消える',
    },
    {
      id: 'S-28', primary: 'B1', secondary: ['A4', 'P'],
      why: '事前登録した連言が本番前に負コントロールを 8 本中 2 本通し、診断すると壊れていたのは検出器ではなく対照の設計だった——' +
        '有限集合上の決定的な写像は必ず閉じた軌道へ落ちるので、「一方向で決して閉じない連鎖」は原理的に作れない（K-55）',
      evidence: '負コントロールを 8 本中 2 本通した',
    },
    {
      id: 'S-29', primary: 'B1', secondary: ['A4', 'A1'],
      why: '機構を持たない代理が主の秩序変数を 0.539、その源自身の 2 項連言を 0.528 通した——連言を 2 項にしても偽陽性は 2% しか落ちない（K-14 の追記）。' +
        '効いたのは第三項が非線形に結びついているかどうかで、線形な収支は並べ替えの代理に通される（K-28 の限定）',
      evidence: '0.539、その源自身の 2 項連言を 0.528',
    },
    {
      id: 'S-30', primary: 'A4', secondary: ['A2', 'P'],
      why: '同じ1本の走行が、中立影の作り方 7 通りだけで「影の 6.46 倍」とも「0.42 倍」とも読め、判定が above / flat / below の 3 通りに割れた（K-62）。' +
        '副は成分の分け方（43 倍に散り、成分数が同じ 2 通りが逆の判定）と、持続フィルタが影の母集団を空にしたこと',
      evidence: 'above / flat / below の 3 通りに割れた',
    },
    {
      id: 'S-31', primary: 'A1', secondary: ['A3', 'M'],
      why: '「閉じた膜がある」の 2 通りの定義が 0.591 対 0.061 と 10 倍違った——最大の発見は系ではなく秩序変数の選択の側にある。' +
        '副は囲いの最小の大きさ（1→16 で全腕が 0）と、待ち行列の前提が原典と食い違っていたこと（K-61。欠けていたのは規則を足すことではなく禁じること）',
      evidence: '0.591 対 0.061 と 10 倍違い',
    },
    {
      id: 'S-32', primary: 'A2', secondary: ['P', 'T'],
      why: '「同じアトラクタをどう同定するか」という分け方で β̂ が 0.232 ↔ 0.622 に割れた（比 28.1 倍。K-21 の記録を更新）。' +
        '副は母集団（滅んだ試行を除くと 32 通り中 16 通りが転移を返さない）と、上限 512 が全走行の 4.9% を落としながら判定を 22 マス中 1 マスしか変えなかったこと（K-63）',
      evidence: '28.1 倍',
    },
    {
      id: 'S-33', primary: 'X', secondary: ['T'],
      why: '借り物 4 つのうち標本数の下限 n_tail だけで powerlaw の割合が 1.4% → 15.8%（11.3 倍）動き、観測器のノブは 6 マス中 0 マスしか動かさなかった——' +
        '比が定義できない極端な形（K-51 の追記）。副は打ち切りだが、その効き方は「どこを見るかの決定」（x_min の選択規則）を通していた（K-63 の機構）',
      evidence: 'KS に x_min を選ばせると 1.28 → 3.80 へ動いた',
    },
    {
      id: 'S-34', primary: 'M', secondary: ['A2'],
      why: '速度式の増強因子が「入りと出の両方」に掛かるか「入りだけ」かで選択 4 腕が 4 対 4 に完全に分かれ、答えは観測器を決める前に決まっていた（K-65）。' +
        '到達できた二次資料 2 本がそこで食い違っており、どちらかを選ばずに制御変数の軸にした。副は組成の距離（euclid → KL・感度比 175.56）',
      evidence: '4 腕すべてが判定を落ち',
    },
    {
      id: 'S-35', primary: 'L', secondary: ['B1', 'A1'],
      why: '「自走に見えるが実は決定論的な再生」が観測だけの検出器 6 種すべてを 30/30 シードで通り、元の腕と状態ハッシュまで一致した——' +
        '出力が同一なら出力のどんな関数も区別できないので、観測量を足す方向に解が無い（K-64）。落としたのは介入だけ',
      evidence: '30/30 シードで通り',
    },
    {
      id: 'S-36', primary: 'A2', secondary: ['K', 'A4'],
      why: '行動の記述の「分け方」を替えるだけで「新奇性探索は 3.25 倍」とも「0.75 倍」とも読め、散らばりは原典が振った「細かさ」の 2.40 倍だった。' +
        '副は知見の層——他スケッチで測った比の向きをそのまま移した予測が 5 件あり 5 件とも外れた（K-67）',
      evidence: '散らばりは細かさの 2.40 倍',
    },
    {
      id: 'S-37', primary: 'H', secondary: ['A4', 'P'],
      why: '同じ判定規則の偽陽性率が、帰無の形だけで 0/200 と 95% に分かれた（K-68）。' +
        '副は参照点——選択はあるが遺伝が無い R2 が 12 マス中 7 マスで packard を返し、2 つの山は進化を必要としないと分かった',
      evidence: '7 通りが packard',
    },
    {
      id: 'S-38', primary: 'L', secondary: ['C', 'M'],
      why: '観測器の設定 81 通りを総当たりしても 81/81 が「原典のループ」「加法規則」「予定表で描くだけの系」を区別せず、' +
        '厳しくすると本物のほうが先に痩せた（79 → 7 に対し偽物 121 → 121。K-64 の 2 例目）。' +
        '副は対照の実現——乱択で壊した表の 8 シードのうち 1 つは規則を 1 本も変えていなかった（K-66）',
      evidence: '81 通りの観測器設定のすべてで',
    },
    {
      id: 'S-39', primary: 'L', secondary: ['A4', 'T'],
      why: '本物の最終支持集合を配るだけの機械が観測だけの判定 3 つすべてで本物と同じか本物より高い値を返し、8/8 で札を得た（K-64 の 3 例目）。' +
        '3 シードでは本物・偽物・正コントロールの状態ハッシュが完全に一致した。落としたのは介入 2 つだけ',
      evidence: '8/8 で level の札を得た',
    },
  ];

  // ────────────────────────────────────────── 知見の層（K-67 の 2 層を 68 件へ当てる）

  /**
   * K-67 は「知見には ①どのノブを登録すべきか（移せる）②どのノブがどれだけ効くか（移せない）の 2 層がある」と言う。
   * 68 件に当てるには 2 つでは足りなかったので 5 つにした（増やした 3 つの理由は各行の why にある）:
   *   R = 登録すべきノブ・踏むべき手続き（K-67 の「移せる」層）
   *   V = どのノブがどれだけ効くか・順位・向き（K-67 の「移せない」層）
   *   I = 原理的な不可能性（移せるが、R とは強さが違う。証明・定理・存在しない対象）
   *   G = 道具・基盤・実装の欠陥（ノブの話ではない）
   *   Z = 知見についての知見（K-40・K-59・K-60・K-67 自身）
   * mag = その知見が「比・倍率・順位」という、他の本では測り直すしかない数を看板に持つか。
   */
  var K_LAYER = {
    1: { layer: 'G', mag: false, why: '基準をファイルに固定しハッシュを刻む手続き' },
    2: { layer: 'R', mag: false, why: '正/負コントロールで本番前に較正する手続き' },
    3: { layer: 'G', mag: false, why: '生ログの残し方' },
    4: { layer: 'G', mag: false, why: '核の形（依存ゼロ・両用）' },
    5: { layer: 'G', mag: false, why: '可視化と核の突き合わせ道具' },
    6: { layer: 'R', mag: false, why: '報告に規模を併記する規律' },
    7: { layer: 'G', mag: false, why: 'サーバの許可リストの順序' },
    8: { layer: 'G', mag: false, why: 'ダッシュボードの生成方式' },
    9: { layer: 'R', mag: true, why: '登録項目の指定（移せる）だが、看板に感度比 3.82 という値を持つ' },
    10: { layer: 'R', mag: false, why: '粒度を系から借りるという探し方' },
    11: { layer: 'R', mag: false, why: '事後解析を別枠にする規律' },
    12: { layer: 'G', mag: false, why: '観測器が古い状態を見る実装欠陥と、その検査' },
    13: { layer: 'G', mag: false, why: '仮想機械を先に直し切る作業の位置づけ' },
    14: { layer: 'R', mag: false, why: '負コントロールを複数種類そろえる手続き' },
    15: { layer: 'R', mag: false, why: '本番の判定規則が正コントロールを拾うかを確かめる手続き' },
    16: { layer: 'R', mag: false, why: '媒体の想定を切った対照で確かめる手続き' },
    17: { layer: 'R', mag: false, why: '対照そのものを疑う手続き' },
    18: { layer: 'R', mag: false, why: '正コントロールを恒等式に取る手続き' },
    19: { layer: 'R', mag: true, why: '帰無過程へ同じノブを振る手続きだが、帯（<0.5 / 0.5〜1 / >1・中央値 0.31）という値を持つ' },
    20: { layer: 'I', mag: false, why: '特異性は原理的に証明できない（Campbell & Fiske）・K-14 は 1984 年の定理' },
    21: { layer: 'V', mag: true, why: '「分け方 > 細かさ」は、どのノブがどれだけ効くかの主張そのもの' },
    22: { layer: 'V', mag: true, why: '効いていたのは幾何ではなく「何を固定するか」という、効き方の帰属' },
    23: { layer: 'V', mag: true, why: '走査は偽陽性を約 9 倍に膨らませる、という倍率' },
    24: { layer: 'I', mag: false, why: '連言をいくつ足しても足りないことがある（S-13 が 4 項で実証）' },
    25: { layer: 'G', mag: false, why: '親の統合手続きの欠陥' },
    26: { layer: 'R', mag: false, why: '上限への張り付きを見る手続き' },
    27: { layer: 'V', mag: true, why: 'B1 を直したら A の感度も消えた（1.359 → 0.005）という、自由度どうしの効き方の関係' },
    28: { layer: 'R', mag: false, why: '偽装しにくい量を検出器へ昇格させる手続き' },
    29: { layer: 'G', mag: false, why: '引用の検証器という道具' },
    30: { layer: 'R', mag: true, why: '母集団を登録項目にする（移せる）が、看板に「何で測るかより効く」という順位を持つ' },
    31: { layer: 'V', mag: true, why: '走行長が観測器のノブより 10 倍効く、という倍率' },
    32: { layer: 'R', mag: false, why: '値ではなく比の向きを見る手続き' },
    33: { layer: 'R', mag: false, why: '参照点を忘れ方だけ違う 2 通りで取る手続き' },
    34: { layer: 'R', mag: false, why: '帰無値の散らばりは実走して測る手続き' },
    35: { layer: 'R', mag: false, why: '判定の単位を登録項目にする' },
    36: { layer: 'G', mag: false, why: '状態ハッシュという道具' },
    37: { layer: 'G', mag: false, why: '撮影器という道具' },
    38: { layer: 'G', mag: false, why: '道具自身を較正する手続き（道具の側の話）' },
    39: { layer: 'G', mag: false, why: '横断考察の作り方（定数表と錨）' },
    40: { layer: 'Z', mag: false, why: '知見についての知見（訂正されていない ≠ 検証された）' },
    41: { layer: 'R', mag: false, why: '登録時に時間尺度と雑音床を見積もる手続き' },
    42: { layer: 'R', mag: false, why: 'スケール横断の AND を取る前提を確かめる手続き' },
    43: { layer: 'R', mag: false, why: '母集団ごとに参照点の存在を確かめる手続き' },
    44: { layer: 'G', mag: false, why: '出力ファイルの空検査という道具の話' },
    45: { layer: 'R', mag: true, why: 'θ を母集団の一部として登録する（移せる）が、看板に感度比 ≈ 8 を持つ' },
    46: { layer: 'R', mag: true, why: '静的と動的を別々に登録する（移せる）が、看板に 0.97 対 0.03 を持つ' },
    47: { layer: 'R', mag: false, why: 'シードが何を動かすかを登録前に確かめる手続き' },
    48: { layer: 'R', mag: true, why: '感度比のノブに入れてよいものの線引き。看板に 0.863 ↔ 0 を持つ' },
    49: { layer: 'R', mag: false, why: '公表値を持つ別系を較正台として同梱する手続き' },
    50: { layer: 'R', mag: false, why: '向きと符号を較正する手続き' },
    51: { layer: 'R', mag: true, why: '借り物を別の欄に登録する（移せる）が、看板に「5 倍」という順位を持つ' },
    52: { layer: 'R', mag: true, why: '予測表を作る手続き。看板に 42/45（93.3%）を持つ' },
    53: { layer: 'R', mag: false, why: '秩序変数 × 腕のマスを 1 つずつ確かめる手続き' },
    54: { layer: 'R', mag: true, why: '参照点が本物と同じ量を測っているか確かめる（移せる）が、看板に「4 倍」を持つ' },
    55: { layer: 'I', mag: false, why: '有限集合上の決定的な写像は必ず閉じる——対照が原理的に存在しない' },
    56: { layer: 'R', mag: true, why: '在庫と到達を別々に登録する（移せる）が、看板に 8/8 対 0/8 を持つ' },
    57: { layer: 'R', mag: false, why: '忘れる側の選択を登録項目にする手続き' },
    58: { layer: 'R', mag: false, why: '代理データで対照を生成し、生成器自身を検査する手続き' },
    59: { layer: 'Z', mag: false, why: '知見についての知見（予測の外れ方が自分の写像になる）' },
    60: { layer: 'Z', mag: false, why: '知見についての知見（登録項目は名指しされた後に埋まる）' },
    61: { layer: 'R', mag: false, why: '着手時に待ち行列の前提と原典を突き合わせる手続き' },
    62: { layer: 'R', mag: true, why: '参照点を族として登録する（移せる）が、看板に 6.46 ↔ 0.42・43 倍を持つ' },
    63: { layer: 'R', mag: true, why: '上限で落とした集合を生ログに残す（移せる）が、看板に 4.9%・中央値 186 を持つ' },
    64: { layer: 'I', mag: false, why: '出力が同一なら出力のどんな関数も区別しない——観測の天井' },
    65: { layer: 'R', mag: true, why: '題材側の再構成を制御変数の軸にする（移せる）が、看板に感度比 175.56 を持つ' },
    66: { layer: 'R', mag: false, why: '対照の生ログに「実際に何を変えたか」の欄を置く手続き' },
    67: { layer: 'Z', mag: false, why: '知見についての知見（2 層のうち片方しか移せない）' },
    68: { layer: 'R', mag: true, why: '帰無の形ごとに偽陽性率を測る（移せる）が、看板に 0/200 ↔ 95% を持つ' },
  };

  var LAYER_LABEL = {
    R: '登録すべきノブ・手続き（移せる）',
    V: 'どのノブがどれだけ効くか（移せない）',
    I: '原理的な不可能性',
    G: '道具・基盤・実装',
    Z: '知見についての知見',
  };

  // ───────────────────────────────────── V 層の量が本をまたいでどう動いたか（判断の表）

  /**
   * K-67 が「移せない」と言った層の量を、実際に測り直した本と値で並べる。
   * 値は各本のレポート・method.md から取ったもので、単位も定義も本ごとに違う（比較の限界は報告に書く）。
   */
  var MAGNITUDES = [
    {
      id: 'M1', name: '分け方 ÷ 細かさ（K-21）', k: 21,
      points: [
        { sketch: 'S-11', value: 9.3, note: '近傍の形 52.8% 対 期待次数 5.7%' },
        { sketch: 'S-32', value: 28.1, note: 'アトラクタの識別規則 0.232 ↔ 0.622' },
        { sketch: 'S-36', value: 2.40, note: '行動の記述の分け方 対 細かさ' },
        { sketch: 'S-30', value: 1.21, note: '成分の分け方 対 成分数' },
      ],
      direction: '4/4 で同じ向き（分け方 > 細かさ）',
      spread: '最大 ÷ 最小 = 23.2 倍',
    },
    {
      id: 'M2', name: '借り物 ÷ 観測器のノブ（K-51）', k: 51,
      points: [
        { sketch: 'S-24', value: 5.0, note: 'δ_ref 0.0101 対 観測器 0.0021' },
        { sketch: 'S-32', value: 4.2, note: '借り物の定数の振れ 対 観測器' },
        { sketch: 'S-33', value: null, note: '観測器が 0/6 マスなので比が定義できない（11.3 倍 対 0）' },
        { sketch: 'S-36', value: 0.48, note: '**向きが逆転**。観測器のノブが借り物を上回った' },
      ],
      direction: '3/4 で借り物が上、S-36 で逆転',
      spread: '比が定義できない本が 1 本ある',
    },
    {
      id: 'M3', name: '題材側 ÷ 観測器のノブ（K-65）', k: 65,
      points: [
        { sketch: 'S-34', value: null, note: '題材側（速度式の括弧）が 1 位。観測器の最大は 175.56 だが答えは括弧で決まっていた' },
        { sketch: 'S-36', value: 0.52, note: '**向きが逆転**。観測器のノブが題材側を上回った' },
        { sketch: 'S-37', value: null, note: '題材側（λ の定義）は 3 位。母集団 > 区間幅 > λ の定義' },
      ],
      direction: '1/3 でしか再現しない',
      spread: '順位は 1 位・3 位・下位と散る',
    },
    {
      id: 'M4', name: '感度比 R_knob / R_control（S-10 の篩）', k: 19,
      points: [
        { sketch: 'S-20 の 20 件', value: 0.31, note: '中央値。>1 が 4 件・0.5〜1 が 4 件・<0.5 が 12 件' },
        { sketch: 'S-22', value: 8.0, note: 'θ=1→2（母集団）' },
        { sketch: 'S-26', value: 1.186, note: 'ノブ P を入れると 1.186、外すと 0.474（線引きが引けない）' },
        { sketch: 'S-35', value: 15.27, note: 'D2。同じ本の D4 は 0.005' },
        { sketch: 'S-36', value: 1.92, note: '観測器のノブが借り物も題材側も上回った初の本' },
        { sketch: 'S-34', value: 175.56, note: '組成の距離 euclid → KL。本サブプロジェクト最大' },
      ],
      direction: '篩の閾値 1 は動いていないが、上限の記録は 3.82 → 175.56 と 46 倍更新された',
      spread: '本ごとに R_knob・R_control の定義が違うので、大小は本をまたいで比べられない',
    },
    {
      id: 'M5', name: '観測を強めたときに何が起きるか（K-64）', k: 64,
      points: [
        { sketch: 'S-35', value: null, note: '原理的に不可能（出力が同一）' },
        { sketch: 'S-38', value: null, note: '本物のほうが先に痩せる（79 → 7 に対し偽物 121 → 121）' },
        { sketch: 'S-39', value: null, note: '本物と偽物が同じだけ下がる（本番規模で差が消えた）' },
      ],
      direction: '3 本で 3 通り。「厳しくすれば落とせる」は 0/3',
      spread: '値ではなく結果の型が 3 通りに分かれた',
    },
  ];

  // ────────────────────────────── 書式から外れた系譜（判断の表・K-39 が心配したこと）

  /**
   * method.md の系譜は、S-20 が K-39 で「見出しの括弧（『K-m を限定する』）と本文の注記（『追記（S-xx による限定）』）の
   * 書式を保てば機械で描ける」と書いた。**S-20 以後に足された知見は、その書式から外れて地の文で系譜を書いている。**
   * ここは、地の文にだけ書かれていて機械の正規表現が拾えない辺を、根拠の引用つきで拾い直す表である。
   * quote は method.md 本文に実在することを run.js が機械検査する。
   */
  var DECLARED_EDGES = [
    { from: 'K-62', to: 'K-33', kind: 'その先', quote: 'は「参照点は忘れ方だけ違う2通りで安く取れる」と言い' },
    { from: 'K-62', to: 'K-54', kind: '限定の先', quote: 'は「参照点は下限とは限らない」と限定した' },
    { from: 'K-67', to: 'K-40', kind: '機構', quote: '（訂正されていない ≠ 検証された）の具体的な機構がこれである' },
    { from: 'K-67', to: 'K-59', kind: '第三の形', quote: '（自分の弱点を相手へ投影する）の**第三の形**にもあたる' },
    { from: 'K-60', to: 'K-40', kind: '別の面', quote: '（訂正されていない≠検証された）の別の面' },
    { from: 'K-58', to: 'K-17', kind: '生成器へ当てる', quote: 'を生成器へ当てる' },
    { from: 'K-55', to: 'K-17', kind: '一段足す', quote: 'の「対照を疑う」に、**対照が原理的に存在しうるかを先に確かめる**という一段を足す' },
    { from: 'K-66', to: 'K-17', kind: '下位の原因', quote: '（負コントロールが通ったら対照の設計を疑う）の**下位の原因**にあたる' },
    { from: 'K-57', to: 'K-33', kind: '限定', quote: 'は「同じ配置の、忘れ方だけ違う2通り」で参照点を安く取れると言う。S-28 は**忘れる側が2つある**' },
    { from: 'K-56', to: 'K-46', kind: '同型', quote: ' で「組織がある」と「回復する」が 0.97 対 0.03 に割れた）と同型で' },
    { from: 'K-53', to: 'K-43', kind: '一歩手前', quote: '同じ段で確かめること（[K-43]' },
    { from: 'K-68', to: 'K-15', kind: '裏側', quote: 'はその**裏側**が別の検査だと示した' },
    { from: 'K-31', to: 'K-9', kind: '普遍でない', quote: '以降の知見群が**普遍ではない**ことの実測' },
    { from: 'K-30', to: 'K-22', kind: '再現', quote: '（効いているのは形の名前ではなく何を固定するか）の再現であり' },
    { from: 'K-28', to: 'K-27', kind: '同型', quote: '（第三の項を足したら特異になった）と同型で、より一般的な形をしている' },
    { from: 'K-48', to: 'K-19', kind: '前提条件', quote: 'の感度比を使うときの前提条件にあたる' },
  ];

  // ─────────────────────────────────────────────── 原典への到達（判断の表・K-65）

  /**
   * status: 到達 / 部分 / 未到達 / 記述なし。
   * granular: 原典到達を 0/1 ではなく項目ごとに記録した本（K-65 の S-38 追記）。
   * S-01〜S-19 は S-20 の判定を引き継ぐ。
   */
  var PRIMARY_SOURCE = {
    'S-01': { status: '記述なし', inherit: 'S-20' }, 'S-02': { status: '未到達', inherit: 'S-20' },
    'S-03': { status: '到達', inherit: 'S-20' }, 'S-04': { status: '到達', inherit: 'S-20' },
    'S-05': { status: '部分', inherit: 'S-20' }, 'S-06': { status: '到達', inherit: 'S-20' },
    'S-07': { status: '到達', inherit: 'S-20' }, 'S-08': { status: '到達', inherit: 'S-20' },
    'S-09': { status: '到達', inherit: 'S-20' }, 'S-10': { status: '部分', inherit: 'S-20' },
    'S-11': { status: '未到達', inherit: 'S-20' }, 'S-12': { status: '未到達', inherit: 'S-20' },
    'S-13': { status: '未到達', inherit: 'S-20' }, 'S-14': { status: '未到達', inherit: 'S-20' },
    'S-15': { status: '未到達', inherit: 'S-20' }, 'S-16': { status: '到達', inherit: 'S-20' },
    'S-17': { status: '未到達', inherit: 'S-20' }, 'S-18': { status: '部分', inherit: 'S-20' },
    'S-19': { status: '未到達', inherit: 'S-20' },
    'S-20': { status: '該当なし', evidence: '外部文献を1つも引いていない' },
    'S-21': { status: '未到達', evidence: '原典には到達していない' },
    'S-22': { status: '未到達', evidence: '原典（Banzhaf, Dittrich & Rauhe 1996）には到達できなかった' },
    'S-23': { status: '部分', evidence: '原典から借りたのは 4 点だけである', granular: true },
    'S-24': { status: '未到達', evidence: '原典（Blok & Bergersen 1999）に到達できなかった' },
    'S-25': { status: '未到達', evidence: '原典に到達していない' },
    'S-26': { status: '部分', evidence: '原典に到達できたのは書誌情報までである' },
    'S-27': { status: '到達', evidence: '原典を取得して確かめたところ' },
    'S-28': { status: '到達', evidence: '著者版 preprint で到達' },
    'S-29': { status: '未到達', evidence: '原典に到達できなかった' },
    'S-30': { status: '到達', evidence: '原典から取り出した中立影の構成手続き' },
    'S-31': { status: '到達', evidence: '原典（McMullin 1997/2004）に到達した' },
    'S-32': { status: '未到達', evidence: '原典には到達していない' },
    'S-33': { status: '未到達', evidence: '原典には到達していない' },
    'S-34': { status: '部分', evidence: '原典の式そのものが、到達できた二次資料 2 本で食い違っていた', granular: true },
    'S-35': { status: '到達', evidence: '原典の PDF を取得して確認した' },
    'S-36': { status: '到達', evidence: '原典に到達した' },
    'S-37': { status: '未到達', evidence: '原典には到達していない' },
    'S-38': { status: '到達', evidence: '本スケッチの原典到達率は規則・図形・数値で 100% だが', granular: true },
    'S-39': { status: '到達', evidence: '原典への到達は機構 100%・判定 60%・分割の手続き 0%', granular: true },
  };

  // ────────────────────────────────────────────────────────── 純関数（集計）

  function stratumOf(sym) {
    var s = SYMBOLS[sym];
    return s ? s.stratum : -9;
  }

  /** 主・副それぞれについて、記号ごと・層群ごとの数を返す。 */
  function tallyBinding(rows) {
    var t = {
      n: rows.length, primaryBySymbol: {}, primaryByStratum: { '-1': 0, 0: 0, 1: 0, 2: 0 },
      anyBySymbol: {}, anyByStratum: { '-1': 0, 0: 0, 1: 0, 2: 0 },
      outsideS20Primary: [], outsideS20Any: [], insideS20Primary: [], notBound: [],
    };
    rows.forEach(function (r) {
      t.primaryBySymbol[r.primary] = (t.primaryBySymbol[r.primary] || 0) + 1;
      t.primaryByStratum[stratumOf(r.primary)]++;
      var all = [r.primary].concat(r.secondary || []);
      var strata = {};
      all.forEach(function (s) {
        t.anyBySymbol[s] = (t.anyBySymbol[s] || 0) + 1;
        strata[stratumOf(s)] = true;
      });
      Object.keys(strata).forEach(function (k) { t.anyByStratum[k]++; });
      if (r.primary === 'N') t.notBound.push(r.id);
      else if (stratumOf(r.primary) === 0) t.insideS20Primary.push(r.id);
      else t.outsideS20Primary.push(r.id);
      if (strata[1] || strata[2]) t.outsideS20Any.push(r.id);
    });
    return t;
  }

  /** 知見を層ごとに集計する。rows は run.js が method.md から作った K の行。 */
  function tallyKnowledge(rows) {
    var t = { n: rows.length, byLayer: {}, };
    rows.forEach(function (r) {
      var L = r.layer;
      if (!t.byLayer[L]) t.byLayer[L] = { n: 0, rewritten: 0, addedTo: 0, intact: 0, singleOrigin: 0, neverCited: 0, testedCounts: [], citedCounts: [], mag: 0 };
      var b = t.byLayer[L];
      b.n++;
      if (r.rewritten) b.rewritten++; else if (r.addedTo) b.addedTo++; else b.intact++;
      if (r.testedBy.length <= 1) b.singleOrigin++;
      if (r.citedByReports === 0) b.neverCited++;
      if (r.mag) b.mag++;
      b.testedCounts.push(r.testedBy.length);
      b.citedCounts.push(r.citedByReports);
    });
    Object.keys(t.byLayer).forEach(function (L) {
      var b = t.byLayer[L];
      b.testedMedian = median(b.testedCounts);
      b.citedMedian = median(b.citedCounts);
    });
    return t;
  }

  function median(arr) {
    var v = arr.slice().sort(function (a, b) { return a - b; });
    var n = v.length;
    if (!n) return null;
    return n % 2 ? v[(n - 1) / 2] : (v[n / 2 - 1] + v[n / 2]) / 2;
  }

  /** 文字列を照合用に正規化する（空白と強調記号を落とす）。 */
  function norm(s) {
    return String(s == null ? '' : s).normalize('NFKC').replace(/\s+/g, '').replace(/\*/g, '');
  }

  var API = {
    SYMBOLS: SYMBOLS, STRATA: STRATA, BINDING: BINDING,
    K_LAYER: K_LAYER, LAYER_LABEL: LAYER_LABEL,
    MAGNITUDES: MAGNITUDES, PRIMARY_SOURCE: PRIMARY_SOURCE, DECLARED_EDGES: DECLARED_EDGES,
    stratumOf: stratumOf, tallyBinding: tallyBinding, tallyKnowledge: tallyKnowledge,
    median: median, norm: norm,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (global) global.S40 = API;

})(typeof window !== 'undefined' ? window : null);
