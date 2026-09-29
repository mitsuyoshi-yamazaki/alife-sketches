/**
 * スケッチ共通の実行UI（ハーネス）。
 *
 * 2026-09-11 ユーザ指示「実行窓を操作するUIで、複数のスケッチに共通するものは共通化する」に対し、
 * **19本の viewer.html を共通ライブラリへ全面載せ替える**という選択でこれを作った。
 *
 * 提供するもの（スケッチ側は自分で作らない）:
 *
 *   - 📷 **スクリーンショット** — 実行窓の内容を PNG にしてブラウザのダウンロードへ流す
 *   - ⇲ **空間サイズの変更** — 縦横それぞれ ½ / 1 / 1.5 / 2 倍。スケッチが `resize` を出したときだけ現れる
 *   - ⬇⬆ **パラメータの保存と復元** — 今の設定を JSON で落とし、読ませて戻す
 *   - 🔗 **URL での共有** — 今の設定を URL のクエリにしてコピーする。開くと自動で復元される
 *     （公開版 https://mitsuyoshi-yamazaki.github.io/alife-sketches/ でも同じ harness が配られるので、そこで作った URL は誰でも開ける）
 *   - ？ **パラメータ一覧** — 今のスケッチのパラメータをフル名・短縮名・値つきで表の形で見る
 *   - 📷⬇ **画像と設定を対で保存** — 同じ名前（拡張子だけ違う）で PNG と JSON を同時に落とす
 *   - 💬 **コメントへ添付** — 今の設定をダッシュボードのコメント欄へ渡す（本文はあちらで書く）
 *   - 桁が変わってもレイアウトが動かない**数値表示**（等幅数字 + 幅の予約）
 *   - iPhone で横に見切れない**折り返し**
 *
 * ## スケッチ側の取り決め
 *
 * ```js
 * Harness.mount({
 *   id: 'S-01', version: '1.0.0',      // version はパラメータ互換の判定に使う
 *   run: 'explore',                     // 省略可（既定 'main'）。この実装がどの実行ページか
 *   accepts: ['main@1.3'],              // 省略可。**他の実行ページから受け入れるパラメータ**
 *   inputs: ['pick', 'speed'],          // パラメータにあたる DOM 要素の id
 *   canvases: ['chart', 'net'],         // スクリーンショットに写す canvas の id（順に横へ並べる）
 *   resize: function (scale) { ... },   // 省略可。出すと空間サイズの選択肢が現れる
 *   onRestore: function () { ... },     // 省略可。パラメータを流し込んだ後に呼ばれる
 *   pause: function () { ... },         // 省略可。時間発展を止める（下記）
 *   noParams: true,                     // 省略可。export できるパラメータが無いスケッチはこれで⬇⬆を隠す
 * });
 * ```
 *
 * ## `pause`（2026-09-15 ユーザ指定）
 *
 * 「添付されたパラメータを実行環境にロードすることができる。その操作を行った際、
 * （シミュレーションが時間軸のあるものであれば）シミュレーションは自動で停止状態になる」。
 *
 * 何をもって「停止」かはスケッチ側しか知らない（走行フラグの名も、停止ボタンの札も違う）ので、
 * **停止はスケッチが `pause` として提供し、ハーネスはそれを呼ぶだけ**にした。`pause` が
 * 無いスケッチでは、パラメータは入るが止まらない（その旨をメッセージ欄に出す）。
 * 時間軸を持たないスケッチは `pause` を出さなくてよい。
 *
 * `inputs` は `value` / `checked` を読み書きし、変更後に `input` と `change` を発火する——
 * つまり**スケッチ側の既存のハンドラがそのまま動く**。それで足りない場合だけ
 * `getParams` / `setParams` を自分で書く。
 *
 * ## 「パラメータ」の範囲（2026-09-15 ユーザ指定）
 *
 * export→import で**同じパターンを再現できる**ことが目的。「パターン」とは系の振る舞いを決める
 * 構造（例: 相互作用行列・初期場・ルール表）であって、そこから時間発展した**状態**
 * （粒子の現在位置・現在時刻など）ではない。
 *
 * - 乱数で生成される構造がパターンを決める場合、**シードではなく生成された値そのもの**を export する
 *   （シード→値の変換は内部実装に依存し、実装を変えると同じシードでも別の値になりうるため）
 * - 初期配置（例: 粒子の初期位置）は通常「状態」に近く export 不要。ただし**初期配置が結果の質を
 *   左右するほど重要な場合**（例: 存在するかしないかを分ける閾値的な効き方をする場合）は含める
 * - 単なる表示順・ソート順など、系の振る舞いを決めないものは export 不要
 * - 判断に迷ったら、**含める側に倒す**
 * - **export できるものが無いスケッチは `noParams: true` を渡し、ボタンごと出さない**
 *   （下記）
 *
 * ## パラメータ互換とセマンティックバージョン
 *
 * ユーザ指定「パラメータの意味が変わっていないかを検証するために、それぞれのスケッチへ
 * セマンティックバージョンをつける。マイナーバージョン以上が変化するとパラメータの互換がなくなる」。
 * 保存した JSON には `sketch` と `version` が入り、復元時に **major.minor が違えば拒否**する。
 *
 * ### 実行ページが複数あるとき（2026-09-18）
 *
 * スケッチは実行ページ（run）を複数持てる。同じスケッチでもパラメータの形は run ごとに違いうるので、
 * **run が違えば既定で拒否する**（2026-09-17 ユーザ指定「exportするパラメータは、区別がつけば
 * 互いにロードできない形式になっても良い」）。受け入れたい組み合わせだけを、受け側が
 * `accepts: ['<runId>@<major.minor>']` で明示する。**片側だけ宣言すれば片方向だけ通る**——
 * 例えば探索用の run が `accepts: ['main@1.3']` を持てば「本編で見つけたパターンを探索窓へ持ち込む」
 * はできるが、逆（探索窓で抜き出した部分集合を本編へ）はできない。
 *
 * 版は **run が持つ**（台帳 `runs.json` の `runs[].version`）。ここで名乗る `version` は
 * その値と一致していなければならず、照合は `factory/gate.js` の S2 が行う。
 * `run` の無い envelope は `main` のものとして扱う（実行ページが1枚だった頃の保存はすべてそれ）。
 *
 * ## URL パラメータでの共有（2026-09-15 ユーザ指定）
 *
 * `getParams`/`setParams`（または `inputs`）が返すキーごとに、**フル名と短縮名の両方**で
 * URL から設定・認識できるようにする。短縮名は「一目で全パラメータを読み取れる」ことが狙いで、
 * **カテゴリを表す接頭辞 + `.` + コード**の形を取る。**接頭辞は全スケッチで共通**:
 *
 * | 接頭辞 | 意味 |
 * |---|---|
 * | `p` | **物理法則パラメータ**——系の振る舞い・力学を決める値（例: 重力の大きさ、相互作用行列） |
 * | `s` | **ソフトウェアパラメータ**——`p`・`d` に当たらない全て（例: 空間の広さ、個体数、乱数シード、
 * |     | **観測器・測定・表示の仕方を決める値**——どの断面を見るか・何を数えるか・どう当てはめるか
 * |     | 等、系のダイナミクスには触れないもの全般もここに含む。2026-09-15 ユーザ指定で `s` の定義を
 * |     | 「計算の土台」から「`p`・`d` 以外すべて」へ広げた。第4の区分は作らない） |
 * | `d` | **生成された初期データ**——乱数で生成され、かつそれ自体が「パターン」の一部であるデータ
 * |     | （例: soup/iid の初期場）。`p`/`s` のどちらでもない値がここに入る |
 *
 * ```js
 * Harness.mount({
 *   ...
 *   paramNames: {
 *     // <getParams が返すキー>: { category, code, full }
 *     gravityPower: { category: 'p', code: 'g', full: 'gravity_power' },  // → URL では p.g / gravity_power
 *     worldSize:    { category: 's', code: 'l', full: 'world_size' },     // → URL では s.l / world_size
 *   },
 * });
 * ```
 *
 * **短縮名は複数文字でよい**（1文字は衝突しやすいため）。**元のパラメータ名が既に短ければ、
 * `full` も同じ短い名前でよく、`code`（接頭辞を除いた部分）も同じでよい**——過度に凝った命名は不要。
 * `paramNames` に載っていないキーは、生のキー名をフル名・短縮名の両方として扱う（フォールバック）。
 *
 * **`d` カテゴリは URL の長さ制限を受ける。** 値が大きすぎて URL に収まらない場合、共有 URL からは
 * 自動的に除外される（大きい順に落とす）——「URL では初期データまでは復元できない、正確な復元には
 * ⬇設定/⬆復元を使う」という仕様を許容する（ユーザ指定）。除外した場合はメッセージ欄に知らせる。
 *
 * 数値・真偽値・文字列はそのまま URL 値にする。配列・オブジェクトは JSON にしてから base64url に
 * エンコードし、`b64:` を前置する。ページを開いたとき `location.search` にパラメータがあれば、
 * スケッチ自身の初期 `reset()` の**後**（`Harness.mount` 呼び出し時点）に自動で上書き適用される。
 *
 * 依存ゼロ・古典スクリプト（`file://` でも動く）。
 */
(function (global) {
  'use strict';

  // 実行ページが1枚しか無かった頃に保存された envelope は、すべてこの run のものである
  var DEFAULT_RUN = 'main';

  var CSS = [
    '.hz{display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px 12px;',
    'background:#221f1a;border-bottom:1px solid #3a342b;position:sticky;top:0;z-index:20}',
    '.hz button,.hz select{font:inherit;font-size:13px;padding:5px 10px;border-radius:6px;',
    'border:1px solid #4a4238;background:#2c2823;color:#e8e2d6;cursor:pointer}',
    '.hz button:hover,.hz select:hover{background:#38332c}',
    '.hz .hzgap{flex:1}',
    '.hz label{font-size:12px;color:#a89f8e;display:flex;gap:4px;align-items:center}',
    '.hz .hzmsg{font-size:12px;color:#d08770}',
    // 数値表示で桁が変わってもレイアウトが動かないようにする（ユーザ指定）
    '.num,.stat b,.stat i,.stat output{font-variant-numeric:tabular-nums;',
    'display:inline-block;text-align:right}',
    // iPhone で横に見切れない（ユーザ指定）
    'canvas{max-width:100%;height:auto}',
    '.wrap,.bar,.panel{flex-wrap:wrap}',
    '@media(max-width:820px){body{padding-left:12px;padding-right:12px}',
    '.wrap{display:block}.panel{width:auto;max-width:100%}}',
    // パラメータ一覧パネル（？ボタン）
    '.hzhelp{position:absolute;top:100%;right:12px;z-index:21;max-width:min(92vw,520px);',
    'max-height:70vh;overflow:auto;background:#221f1a;border:1px solid #4a4238;border-radius:8px;',
    'padding:10px 12px;box-shadow:0 6px 18px rgba(0,0,0,.4);font-size:12px}',
    '.hzhelphead{display:flex;align-items:center;justify-content:space-between;',
    'font-weight:600;margin-bottom:6px;color:#e8e2d6}',
    '.hzhelp table{border-collapse:collapse;width:100%}',
    '.hzhelp th,.hzhelp td{padding:3px 6px;text-align:left;border-bottom:1px solid #3a342b;',
    'color:#e8e2d6;white-space:nowrap}',
    '.hzhelp td.mono,.hzhelp .hzhelpmono{font-family:ui-monospace,Menlo,monospace}',
    '.hzhelp td.dim,.hzhelp .hzhelpdim{color:#a89f8e}',
    '.hzhelplegend{margin-top:8px;color:#a89f8e;line-height:1.6}',
  ].join('');

  function injectCss() {
    if (document.getElementById('hz-css')) return;
    var st = document.createElement('style');
    st.id = 'hz-css';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }

  function el(tag, attrs, text) {
    var e = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (text != null) e.textContent = text;
    return e;
  }

  function byId(id) { return document.getElementById(id); }

  /** major.minor が同じなら互換とみなす（ユーザ指定の規則）。 */
  function compatible(a, b) {
    var x = String(a || '').split('.'), y = String(b || '').split('.');
    return x[0] === y[0] && x[1] === y[1];
  }

  /** `accepts` の照合に使う版の刻み。台帳（factory/runs.js の mm）と同じ規則。 */
  function majorMinor(v) {
    var p = String(v || '').split('.');
    return p[0] + '.' + (p[1] || '0');
  }

  // ------------------------------------------------------------ URL パラメータ（短縮名/フル名）

  /** 接頭辞の種類は全スケッチで共通（ユーザ指定）。ここが唯一の定義箇所。 */
  var CATEGORIES = { p: '物理法則パラメータ', s: 'ソフトウェアパラメータ', d: '生成された初期データ' };
  var MAX_URL_QUERY = 1800; // URL 全体（クエリ込み）の目安上限。超えたら d カテゴリを大きい順に落とす

  function paramNameOf(cfg, key) { return (cfg.paramNames || {})[key] || null; }

  function shortNameOf(cfg, key) {
    var pn = paramNameOf(cfg, key);
    if (!pn) return key;
    if (!CATEGORIES[pn.category]) throw new Error('paramNames["' + key + '"] の category が未知: ' + pn.category);
    return pn.category + '.' + pn.code;
  }

  function fullNameOf(cfg, key) {
    var pn = paramNameOf(cfg, key);
    return (pn && pn.full) || key;
  }

  function categoryOf(cfg, key) {
    var pn = paramNameOf(cfg, key);
    return pn && pn.category;
  }

  /** mount 時に一度だけ検査する。短縮名の重複・未知カテゴリは実装ミスなので、ここで止める。 */
  function validateParamNames(cfg) {
    var seen = {};
    Object.keys(cfg.paramNames || {}).forEach(function (key) {
      var short = shortNameOf(cfg, key);
      if (seen[short]) throw new Error('paramNames の短縮名が重複: ' + short + '（' + seen[short] + ' と ' + key + '）');
      seen[short] = key;
    });
  }

  function toBase64Url(str) {
    var b64 = btoa(unescape(encodeURIComponent(str)));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(s) {
    var b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4) b64 += '=';
    return decodeURIComponent(escape(atob(b64)));
  }

  function encodeValue(v) {
    if (v == null) return null;
    if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    if (typeof v === 'string') return v;
    try { return 'b64:' + toBase64Url(JSON.stringify(v)); } catch (e) { return null; }
  }

  function decodeValue(s) {
    if (s.indexOf('b64:') === 0) {
      try { return JSON.parse(fromBase64Url(s.slice(4))); } catch (e) { return undefined; }
    }
    if (/^-?\d+(\.\d+)?(e[-+]?\d+)?$/i.test(s)) return Number(s);
    if (s === 'true') return true;
    if (s === 'false') return false;
    return s;
  }

  /**
   * 今の設定を共有 URL にする。`d` カテゴリは大きい順に落として長さへ収め、
   * 落としたキーの一覧を返す（呼び側がメッセージにする）。
   */
  function buildShareUrl(cfg, params) {
    if (typeof location === 'undefined') throw new Error('location が無い環境（DOM スタブ等）では共有 URL を作れない');
    var base = location.href.split('?')[0].split('#')[0];
    var entries = Object.keys(params || {}).map(function (key) {
      return { key: key, short: shortNameOf(cfg, key), val: encodeValue(params[key]), cat: categoryOf(cfg, key) };
    }).filter(function (e) { return e.val != null; });

    function qs(list) {
      return list.map(function (e) { return encodeURIComponent(e.short) + '=' + encodeURIComponent(e.val); }).join('&');
    }

    var included = entries.slice();
    var dropped = [];
    for (;;) {
      var url = base + (included.length ? '?' + qs(included) : '');
      var hasD = included.some(function (e) { return e.cat === 'd'; });
      if (url.length <= MAX_URL_QUERY || !hasD) return { url: url, dropped: dropped };
      var idx = -1, maxLen = -1;
      included.forEach(function (e, i) { if (e.cat === 'd' && e.val.length > maxLen) { maxLen = e.val.length; idx = i; } });
      dropped.push(included[idx].key);
      included.splice(idx, 1);
    }
  }

  /**
   * location.search を読み、短縮名/フル名のどちらでも元のキーへ解決して返す。無ければ null。
   * `location` が無い環境（selftest.js の DOM スタブ等）では静かに null を返す——
   * ブラウザで開かれたことを前提にする機能なので、無ければ機能しないだけで例外にはしない。
   */
  function paramsFromUrl(cfg) {
    if (typeof location === 'undefined' || !location.search) return null;
    var qs = location.search.slice(1);
    if (!qs) return null;
    var lookup = {};
    Object.keys(cfg.paramNames || {}).forEach(function (key) {
      var pn = cfg.paramNames[key];
      lookup[pn.category + '.' + pn.code] = key;
      if (pn.full) lookup[pn.full] = key;
    });
    var out = {}, found = false;
    new URLSearchParams(qs).forEach(function (v, k) {
      var canon = lookup[k] || k; // 未登録キーは生のまま渡す（フォールバック）
      out[canon] = decodeValue(v);
      found = true;
    });
    return found ? out : null;
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { say('URL をコピーした'); }, function () { fallbackCopy(text); });
      return;
    }
    fallbackCopy(text);
  }

  /** `navigator.clipboard` は http の LAN アクセス（非 localhost）では使えないことがあるための代替経路。 */
  function fallbackCopy(text) {
    var ta = el('textarea', { style: 'position:fixed;opacity:0;left:-9999px' });
    ta.value = text;
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { /* 何もしない */ }
    document.body.removeChild(ta);
    say(ok ? 'URL をコピーした' : 'コピーできなかった。手動でコピーせよ: ' + text, !ok);
  }

  /** ヘルプ表に出す値の短い表示。配列・オブジェクトは中身を全部出さず形だけ見せる（`d` カテゴリで巨大になりうるため）。 */
  function formatValueForHelp(v) {
    if (v == null) return String(v);
    if (Array.isArray(v)) {
      if (v.length && Array.isArray(v[0])) return v.length + '×' + v[0].length + ' の行列';
      return v.length + ' 個の配列';
    }
    if (typeof v === 'object') return 'オブジェクト（' + Object.keys(v).length + ' 項目）';
    var s = String(v);
    return s.length > 48 ? s.slice(0, 48) + '…' : s;
  }

  /** 「？」パネルの中身を今の値で作り直す。開くたびに呼ぶ（値は変わりうるため）。 */
  function renderHelpPanel(panel, cfg) {
    panel.innerHTML = '';
    var head = el('div', { class: 'hzhelphead' }, 'このスケッチの URL パラメータ');
    var close = el('button', { type: 'button', title: '閉じる' }, '✕');
    close.onclick = function () { panel.hidden = true; };
    head.appendChild(close);
    panel.appendChild(head);

    var params = readInputs(cfg);
    var keys = Object.keys(params);
    var table = el('table');
    var thead = el('thead');
    var headRow = el('tr');
    ['フル名', '短縮名', '種別', '値'].forEach(function (h) { headRow.appendChild(el('th', {}, h)); });
    thead.appendChild(headRow);
    table.appendChild(thead);
    var tbody = el('tbody');
    if (!keys.length) {
      var er = el('tr');
      er.appendChild(el('td', { class: 'dim', colspan: '4' }, 'パラメータが無い'));
      tbody.appendChild(er);
    }
    keys.forEach(function (key) {
      var cat = categoryOf(cfg, key);
      var tr = el('tr');
      tr.appendChild(el('td', {}, fullNameOf(cfg, key)));
      tr.appendChild(el('td', { class: 'mono' }, shortNameOf(cfg, key)));
      tr.appendChild(el('td', { class: 'dim' }, cat ? CATEGORIES[cat] : '（未分類）'));
      tr.appendChild(el('td', { class: 'mono' }, formatValueForHelp(params[key])));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    panel.appendChild(table);

    panel.appendChild(el('div', { class: 'hzhelplegend' },
      'p = 物理法則パラメータ ／ s = それ以外（計算の土台・観測器や表示の設定等） ／ d = 生成された初期データ'));
  }

  function download(blobOrUrl, name) {
    var a = document.createElement('a');
    a.href = typeof blobOrUrl === 'string' ? blobOrUrl : URL.createObjectURL(blobOrUrl);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      a.remove();
      if (typeof blobOrUrl !== 'string') URL.revokeObjectURL(a.href);
    }, 1000);
  }

  function stamp() {
    var d = new Date();
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
  }

  // ------------------------------------------------------------ ダッシュボードとの橋渡し
  //
  // スケッチは**ダッシュボードの iframe の中**で動く（`/sketch/<識別子>`）。
  // 2026-09-15 ユーザ指定の2つの流れは、この親子間の postMessage で繋ぐ:
  //
  //   1. 実行画面で「💬 コメントへ添付」→ 親がコメント板を開き、本文の入力を待つ
  //      （「実行画面から『exportしコメント』操作をされた場合は、コメント本文の入力ができる必要がある」）
  //   2. コメントの添付を「▶ 実行環境にロード」→ 親から設定が降ってきて、流し込み、**止まる**
  //
  // 受け取る側は**送り主が親窓であること**と**同一オリジンであること**の両方を見る。
  // ダッシュボードは LAN 限定の同一オリジン配信なので、これで外からは入れない。

  function inDashboard() {
    try { return typeof window !== 'undefined' && window.parent && window.parent !== window; }
    catch (e) { return false; }
  }

  /**
   * 親のコメント欄が閲覧専用か（公開版。2026-09-29）。閲覧専用なら「コメントへ添付」の行き先が無い。
   * 親が別オリジンで覗けないときも、行き先が無いものとして扱う。
   */
  function parentReadonly() {
    try { return !!window.parent.document.querySelector('.comments[data-readonly]'); }
    catch (e) { return true; }
  }

  function tellParent(msg) {
    if (!inDashboard()) return;
    try { window.parent.postMessage(msg, location.origin); } catch (e) { /* 親が居ない・別オリジン */ }
  }

  function listenToParent() {
    if (typeof window === 'undefined' || !window.addEventListener) return;
    window.addEventListener('message', function (ev) {
      if (ev.source !== window.parent) return;
      if (ev.origin !== location.origin) return;
      var m = ev.data;
      if (!m || m.source !== 'dashboard' || m.type !== 'load-params') return;
      var r = applyParams(m.envelope, true); // ← ロード時は自動で停止する（ユーザ指定）
      if (r.ok) {
        say(r.paused ? 'コメントの設定を読み込み、停止した'
          : (r.pausable ? 'コメントの設定を読み込んだ' : 'コメントの設定を読み込んだ（このスケッチは自動停止に対応していない）'));
      } else {
        say(r.error, true);
      }
      tellParent({ source: 'harness', type: 'load-result', token: m.token, ok: r.ok, paused: !!r.paused, error: r.error || '' });
    });
  }

  // ------------------------------------------------------------ 本体

  var state = { cfg: null, bar: null, msgEl: null, sayCount: 0 };

  function readInputs(cfg) {
    if (cfg.getParams) return cfg.getParams();
    var out = {};
    (cfg.inputs || []).forEach(function (id) {
      var e = byId(id);
      if (!e) return;
      out[id] = e.type === 'checkbox' ? e.checked : e.value;
    });
    return out;
  }

  function writeInputs(cfg, values) {
    if (cfg.setParams) { cfg.setParams(values); return; }
    Object.keys(values || {}).forEach(function (id) {
      var e = byId(id);
      if (!e) return;
      if (e.type === 'checkbox') e.checked = !!values[id];
      else e.value = values[id];
      e.dispatchEvent(new Event('input', { bubbles: true }));
      e.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }

  function say(msg, bad) {
    state.sayCount++;
    if (!state.msgEl) return;
    state.msgEl.textContent = msg || '';
    state.msgEl.style.color = bad ? '#d08770' : '#a3be8c';
    if (msg) setTimeout(function () { if (state.msgEl.textContent === msg) state.msgEl.textContent = ''; }, 6000);
  }

  /** 登録された canvas を横に並べて1枚の PNG にする。`name` 省略時は時刻から作る。 */
  function shoot(name, quiet) {
    var cfg = state.cfg;
    var list = (cfg.canvases || []).map(byId).filter(Boolean);
    if (!list.length) { say('写せる canvas が無い', true); return; }

    var pad = 12;
    var w = list.reduce(function (n, c) { return n + c.width + pad; }, pad);
    var h = list.reduce(function (n, c) { return Math.max(n, c.height); }, 0) + pad * 2;
    var out = document.createElement('canvas');
    out.width = w; out.height = h;
    var cx = out.getContext('2d');
    var bg = getComputedStyle(document.body).backgroundColor;
    cx.fillStyle = bg && bg !== 'rgba(0, 0, 0, 0)' ? bg : '#1c1a16';
    cx.fillRect(0, 0, w, h);
    var x = pad;
    list.forEach(function (c) { cx.drawImage(c, x, pad); x += c.width + pad; });

    out.toBlob(function (blob) {
      if (!blob) { say('PNG にできなかった', true); return; }
      download(blob, name || ((cfg.id || 'sketch') + '-' + stamp() + '.png'));
      if (!quiet) say('スクリーンショットを保存した');
    }, 'image/png');
  }

  /** 今の設定を「保存した JSON」の形にする。ファイルへ落とすときもコメントへ添付するときも同じ形。 */
  function paramsEnvelope() {
    var cfg = state.cfg;
    return {
      sketch: cfg.id,
      run: cfg.run || DEFAULT_RUN,
      version: cfg.version,
      savedAt: new Date().toISOString(),
      params: readInputs(cfg),
    };
  }

  function saveParams(name, quiet) {
    var cfg = state.cfg;
    download(new Blob([JSON.stringify(paramsEnvelope(), null, 2) + '\n'], { type: 'application/json' }),
      name || ((cfg.id || 'sketch') + '-params-' + stamp() + '.json'));
    if (!quiet) say('パラメータを保存した');
  }

  /**
   * 画像とパラメータを**同時に**落とす（2026-09-15 ユーザ指定
   * 「ファイル名冒頭が同じ、など、ペアであることがわかるようにする」）。
   * ここでは**拡張子だけが違う同じ名前**にした——冒頭が同じどころか全部同じなので、
   * 並んだファイル一覧で対を取り違えようがない。
   */
  function shootPair() {
    var cfg = state.cfg;
    var base = (cfg.id || 'sketch') + '-' + stamp();
    shoot(base + '.png', true);
    saveParams(base + '.json', true);
    say('画像と設定を対で保存した（' + base + '.png / .json）');
  }

  /**
   * 時間発展を止める（`pause` を出しているスケッチだけ）。
   * 止められたかどうかを返す——呼び側がメッセージを変えるため。
   */
  function pause() {
    var cfg = state.cfg;
    if (!cfg || typeof cfg.pause !== 'function') return false;
    try { cfg.pause(); return true; }
    catch (e) { say('停止できなかった: ' + e.message, true); return false; }
  }

  /**
   * 外から来たパラメータを流し込む。**受け入れは既定で拒否**である。
   *
   * 2026-09-17 ユーザ指定「exportするパラメータは（区別がつけば）互いにロードできない形式になっても良い」。
   * 実行ページが複数になると、同じスケッチでもパラメータの形が run ごとに違いうるので、
   * **run が違えば既定で弾く**。受け入れたい組み合わせだけを、受け側が `accepts` で明示する:
   *
   *   Harness.mount({ id: 'S-46', run: 'explore', version: '1.0.0', accepts: ['main@1.3'] })
   *
   * `run` の無い envelope は `main` として扱う——実行ページが1枚しか無かった頃に保存された
   * ものはすべて、そのスケッチの既定 run のものだからである。
   */
  function applyParams(envelope, pauseAfter) {
    var cfg = state.cfg;
    var d = envelope || {};
    if (d.sketch && cfg.id && d.sketch !== cfg.id) {
      return { ok: false, error: '別のスケッチのパラメータ（' + d.sketch + '）' };
    }
    var from = d.run || DEFAULT_RUN;
    var here = cfg.run || DEFAULT_RUN;
    if (from !== here) {
      if ((cfg.accepts || []).indexOf(from + '@' + majorMinor(d.version)) < 0) {
        return { ok: false, error: '別の実行ページのパラメータ（' + from + ' → ' + here + '）。' +
          'この実行ページは受け入れを宣言していない' };
      }
    } else if (d.version != null && !compatible(d.version, cfg.version)) {
      return { ok: false, error: '版が合わない（添付 ' + d.version + ' / 今 ' + cfg.version + '）。マイナー以上が違うと互換が無い' };
    }
    var params = d.params || {};
    writeInputs(cfg, params);
    if (cfg.onRestore) cfg.onRestore(params);
    return { ok: true, paused: pauseAfter ? pause() : false, pausable: typeof cfg.pause === 'function' };
  }

  function loadParams(file) {
    var fr = new FileReader();
    fr.onload = function () {
      var d;
      try { d = JSON.parse(fr.result); } catch (e) { say('JSON として読めない', true); return; }
      var r = applyParams(d, false); // ファイルからの復元は従来どおり止めない
      say(r.ok ? 'パラメータを復元した' : r.error, !r.ok);
    };
    fr.readAsText(file);
  }

  function buildBar(cfg) {
    var bar = el('div', { class: 'hz' });

    var shot = el('button', { type: 'button', title: '実行窓の内容を PNG で保存する' }, '📷 撮る');
    shot.onclick = function () { shoot(); }; // 引数を取る関数なので click イベントを渡さない
    bar.appendChild(shot);

    if (cfg.resize) {
      var lab = el('label', {}, '広さ');
      var sel = el('select', { title: '空間の縦横をまとめて変える' });
      [['0.5', '½'], ['1', '1倍'], ['1.5', '1.5倍'], ['2', '2倍']].forEach(function (p) {
        var o = el('option', { value: p[0] }, p[1]);
        if (p[0] === '1') o.selected = true;
        sel.appendChild(o);
      });
      sel.onchange = function () {
        // スケッチが自分で `Harness.say` を出したなら、それを上書きしない
        // （実際に何がどう変わったかはスケッチ側しか知らないため。2026-09-11 担当者の指摘で直した）
        var before = state.sayCount;
        try {
          cfg.resize(parseFloat(sel.value));
          if (state.sayCount === before) say('広さを ' + sel.options[sel.selectedIndex].text + ' にした');
        } catch (e) { say('広さを変えられなかった: ' + e.message, true); }
      };
      lab.appendChild(sel);
      bar.appendChild(lab);
    }

    // 復元できるパラメータを持たないスケッチは、ボタンごと出さない
    // （2026-09-15 ユーザ指示「exportするものがないスケッチの場合はexport/importボタンは削除せよ」）
    if (!cfg.noParams) {
      var save = el('button', { type: 'button', title: '今の設定を JSON で保存する' }, '⬇ 設定');
      save.onclick = function () { saveParams(); }; // 同上
      bar.appendChild(save);

      var pick = el('input', { type: 'file', accept: '.json,application/json', style: 'display:none' });
      pick.onchange = function () { if (pick.files[0]) loadParams(pick.files[0]); pick.value = ''; };
      var load = el('button', { type: 'button', title: '保存した JSON を読んで設定を戻す' }, '⬆ 復元');
      load.onclick = function () { pick.click(); };
      bar.appendChild(load);
      bar.appendChild(pick);

      var pair = el('button', { type: 'button', title: '画像と設定を、拡張子だけが違う同じ名前で同時に保存する' }, '📷⬇ 対で保存');
      pair.onclick = shootPair;
      bar.appendChild(pair);

      // ダッシュボードの中で動いているときだけ出す（単独で開いた viewer には行き先が無い）
      if (inDashboard() && !parentReadonly()) {
        var attach = el('button', { type: 'button', title: '今の設定をコメントへ添付する（本文はダッシュボード側で書く）' }, '💬 コメントへ添付');
        attach.onclick = function () {
          tellParent({ source: 'harness', type: 'attach-params', envelope: paramsEnvelope() });
          say('コメント欄へ渡した（本文を書いて投稿せよ）');
        };
        bar.appendChild(attach);
      }

      var share = el('button', { type: 'button', title: '今の設定を URL にして共有する（開くと自動で復元される）' }, '🔗 共有');
      share.onclick = function () {
        var r = buildShareUrl(cfg, readInputs(cfg));
        copyToClipboard(r.url);
        if (r.dropped.length) {
          say('URL をコピーした（大きいデータ ' + r.dropped.length + ' 件は長さの都合で含まれない。厳密な復元には⬇設定を使うこと）');
        }
      };
      bar.appendChild(share);

      var helpPanel = el('div', { class: 'hzhelp' });
      helpPanel.hidden = true;
      var help = el('button', { type: 'button', title: 'このスケッチのURLパラメータ一覧（フル名・短縮名・値）を見る' }, '？');
      help.onclick = function () {
        helpPanel.hidden = !helpPanel.hidden;
        if (!helpPanel.hidden) renderHelpPanel(helpPanel, cfg);
      };
      bar.appendChild(help);
      bar.appendChild(helpPanel);
    }

    bar.appendChild(el('span', { class: 'hzgap' }));
    state.msgEl = el('span', { class: 'hzmsg' });
    bar.appendChild(state.msgEl);
    bar.appendChild(el('span', { class: 'hzver', style: 'font-size:11px;color:#6f685c' },
      (cfg.id || '') + ' v' + (cfg.version || '?')));
    return bar;
  }

  var Harness = {
    /** スケッチから1度だけ呼ぶ。 */
    mount: function (cfg) {
      injectCss();
      state.cfg = cfg || {};
      validateParamNames(state.cfg);
      var go = function () {
        state.bar = buildBar(state.cfg);
        document.body.insertBefore(state.bar, document.body.firstChild);
        if (!cfg.noParams) {
          var fromUrl = paramsFromUrl(state.cfg);
          if (fromUrl) {
            writeInputs(state.cfg, fromUrl);
            if (state.cfg.onRestore) state.cfg.onRestore(fromUrl);
            say('URL からパラメータを復元した');
          }
        }
      };
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', go);
      else go();
      listenToParent();
      return Harness;
    },
    /** 桁でレイアウトが動かない数値表示。`Harness.num(el, 3.25, 6)` で 6 文字ぶん予約する。 */
    num: function (target, value, width) {
      var e = typeof target === 'string' ? byId(target) : target;
      if (!e) return;
      e.classList.add('num');
      if (width) e.style.minWidth = width + 'ch';
      e.textContent = value;
    },
    shoot: shoot,
    shootPair: shootPair,
    pause: pause,
    applyParams: applyParams,
    paramsEnvelope: paramsEnvelope,
    compatible: compatible,
    say: say,
  };

  global.Harness = Harness;
  if (typeof module !== 'undefined' && module.exports) module.exports = Harness;
})(typeof window !== 'undefined' ? window : this);
