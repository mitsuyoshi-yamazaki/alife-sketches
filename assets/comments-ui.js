/**
 * スケッチ画面のコメント欄。
 *
 * サーバの `/api/comments/<slug>` と話す。Markdown は**表示のときだけ**最小限に整える
 * （本文は API から素のまま来る。編集はいつでも素の Markdown を触る）。
 *
 * ## 添付されたパラメータ（2026-09-15 ユーザ指定）
 *
 * 「ある興味深いパターンが現れたとき、それをダッシュボード上にそのまま記録するため」、
 * コメントへスケッチの設定を添付できる。指定された性質をそのまま実装している:
 *
 *   - 実体は **JSON 文字列**（export された JSON *ファイル* を持つのではない）
 *   - **JSON ファイルとして落とせる**
 *   - 添付付きのコメントも**通常のコメントと同等**——本文を書け、返信も編集も削除もできる
 *   - 普段は `<details>` で**格納**され、展開すればその場で中身を読める（**色分けする**）
 *   - **実行環境へロードできる**。ロードすると（時間軸があるスケッチなら）**自動で停止する**
 *
 * 添付の入口は2つ。①実行窓の「💬 コメントへ添付」（harness.js が親へ postMessage する。
 * このとき**本文はまだ空**で、ここで書いてから投稿する）②手元の JSON ファイルを選ぶ。
 *
 * ## 投稿できなかったとき（2026-09-15 ユーザ指定）
 *
 * 「リロードされてもコメントの内容 + 投稿先が消えないようにせよ」。書いたものは
 * **投稿先ごとに** `localStorage` へ退避し、次にこの画面を開いたとき同じ欄へ戻す。
 * 断り書きには**投稿できなかった理由**と**ブラウザ側に残っていること**の両方を出す。
 * さらに、**投稿できるようになったら自分で投げ直す**（一定間隔と、回線が戻った瞬間）。
 *
 * ## 閲覧専用（公開版。2026-09-29）
 *
 * `.comments` に `data-readonly` があれば、ページに埋め込まれたコメント（`#cdata`）を表示するだけにする。
 * 投稿・返信・編集・削除・AI 化・下書きの退避と投げ直しは**一切出さず、API も呼ばない**。
 * 添付の「JSON で保存」「実行環境にロード」は手元で完結し何も変えないので残す。
 *
 * 依存ゼロ・古典スクリプト。
 */
(function () {
  'use strict';
  var root = document.querySelector('.comments');
  if (!root) return;
  var slug = root.getAttribute('data-slug');
  // いま見ている実行ページ（2026-09-18）。実行ページを持たないスケッチでは空。
  // 投稿に添えて「どの窓を見ながら書いたか」を残す——一覧は run で分割しない
  var run = root.getAttribute('data-run') || null;
  var list = document.getElementById('clist');
  var form = document.getElementById('cnew');
  var stage = document.querySelector('iframe.stage');
  var readonly = root.hasAttribute('data-readonly');

  // 投稿先 → 添付中の JSON 文字列。'new' は最上位のコメント欄、それ以外はコメントIDの返信欄
  var attachOf = {};
  // 表示中のコメントが持つ添付。鍵は「コメントID」または「コメントID/返信ID」
  var shownParams = {};
  var retryTimer = null;

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /** 表示用の最小 Markdown。見出し・コード・強調・リンク・箇条書き・改行だけ。 */
  function md(src) {
    var lines = String(src || '').split('\n');
    var out = [], buf = [], code = false, codeBuf = [];
    function flush() { if (buf.length) { out.push('<p>' + buf.join('<br>') + '</p>'); buf = []; } }
    var il = function (t) {
      return esc(t)
        .replace(/`([^`]+)`/g, '<code>$1</code>')
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g, '<a href="$2">$1</a>');
    };
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i];
      if (/^```/.test(l)) {
        if (code) { out.push('<pre><code>' + esc(codeBuf.join('\n')) + '</code></pre>'); codeBuf = []; code = false; }
        else { flush(); code = true; }
        continue;
      }
      if (code) { codeBuf.push(l); continue; }
      if (/^#{1,6} /.test(l)) { flush(); out.push('<b class="ch">' + il(l.replace(/^#+ /, '')) + '</b>'); continue; }
      if (/^\s*[-*] /.test(l)) {
        flush();
        var items = [];
        while (i < lines.length && /^\s*[-*] /.test(lines[i])) items.push('<li>' + il(lines[i++].replace(/^\s*[-*] /, '')) + '</li>');
        i--;
        out.push('<ul>' + items.join('') + '</ul>');
        continue;
      }
      if (/^\s*$/.test(l)) { flush(); continue; }
      buf.push(il(l));
    }
    if (code && codeBuf.length) out.push('<pre><code>' + esc(codeBuf.join('\n')) + '</code></pre>');
    flush();
    return out.join('');
  }

  function when(iso) {
    try { return new Date(iso).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
    catch (e) { return iso; }
  }

  function api(method, suffix, body) {
    return fetch('/api/comments/' + slug + (suffix || ''), {
      method: method,
      headers: { 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
  }

  // ------------------------------------------------------------ 添付パラメータ

  /**
   * JSON の色分け。**表示のためだけ**の整形なので、読めない文字列が来たらそのまま出す
   * （添付は投稿時にサーバが JSON として検査しているが、ここで落ちて画面ごと死ぬ方が悪い）。
   */
  function highlightJson(text) {
    var pretty;
    try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch (e) { pretty = String(text); }
    return esc(pretty).replace(
      // 鍵の判定に使う空白は**同じ行のものだけ**（\s だと改行を跨いで次の行の字下げまで飲む）
      /("(?:\\.|[^"\\])*"[ \t]*:?|\b(?:true|false)\b|\bnull\b|-?\d+(?:\.\d*)?(?:[eE][-+]?\d+)?)/g,
      function (m) {
        var cls = 'jn';
        if (m.charAt(0) === '"') cls = /:$/.test(m) ? 'jk' : 'js';
        else if (m === 'true' || m === 'false') cls = 'jb';
        else if (m === 'null') cls = 'ju';
        return '<span class="' + cls + '">' + m + '</span>';
      });
  }

  /** 添付の見出しに出す短い素性（スケッチ名と版）。読めないときは何も足さない。 */
  function attachLabel(text) {
    try {
      var d = JSON.parse(text);
      var who = [d.sketch, d.run && d.run !== 'main' ? d.run : '', d.version ? 'v' + d.version : '']
        .filter(Boolean).join(' ');
      return who ? '（' + who + '）' : '';
    } catch (e) { return ''; }
  }

  function download(text, name) {
    var blob = new Blob([text], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(a.href); }, 1000);
  }

  /** 添付を実行窓へ流し込む。停止まで面倒を見るのは harness.js の側（ユーザ指定）。 */
  function loadIntoStage(text, btn) {
    if (!stage || !stage.contentWindow) { alert('このスケッチには実行窓が無いので、ロードできない。'); return; }
    var envelope;
    try { envelope = JSON.parse(text); } catch (e) { alert('添付が JSON として読めない: ' + e.message); return; }
    btn.disabled = true;
    var label = btn.textContent;
    btn.textContent = 'ロード中…';
    var token = 'l' + Date.now();
    var done = false;
    function finish(msg, bad) {
      if (done) return;
      done = true;
      btn.disabled = false;
      btn.textContent = label;
      if (msg) (bad ? alert : function (m) { btn.textContent = m; setTimeout(function () { btn.textContent = label; }, 3000); })(msg);
    }
    function onResult(ev) {
      if (ev.source !== stage.contentWindow || ev.origin !== location.origin) return;
      var m = ev.data;
      if (!m || m.source !== 'harness' || m.type !== 'load-result' || m.token !== token) return;
      window.removeEventListener('message', onResult);
      finish(m.ok ? (m.paused ? '読み込んで停止した' : '読み込んだ') : ('ロードできない: ' + m.error), !m.ok);
    }
    window.addEventListener('message', onResult);
    stage.contentWindow.postMessage({ source: 'dashboard', type: 'load-params', envelope: envelope, token: token }, location.origin);
    // 実行窓が古い harness を読んでいる等で返事が来ない場合に、ボタンを押せないまま残さない
    setTimeout(function () { window.removeEventListener('message', onResult); finish('実行窓から返事が無い', true); }, 8000);
  }

  function attachmentHtml(key, text) {
    if (!text) return '';
    shownParams[key] = text;
    return '<details class="att"><summary>📎 添付された設定' + esc(attachLabel(text)) + '</summary>' +
      '<div class="attbody"><div class="attacts">' +
      '<button type="button" data-att="dl" data-key="' + esc(key) + '">⬇ JSON で保存</button>' +
      (stage ? '<button type="button" data-att="load" data-key="' + esc(key) + '">▶ 実行環境にロード</button>' : '') +
      '</div><pre class="attjson">' + highlightJson(text) + '</pre>' +
      (stage ? '<p class="attnote">ロードすると、時間軸を持つスケッチは自動で停止状態になる。</p>' : '') +
      '</div></details>';
  }

  // ------------------------------------------------------------ 下書きの退避（投稿できなかったとき）

  var DRAFT_PREFIX = 'alife-comment-draft:';

  function draftKey(target) { return DRAFT_PREFIX + slug + ':' + target; }

  /** localStorage は私用窓・容量超過で投げる。下書きが保てないだけで画面を壊さない。 */
  function writeDraft(target, d) {
    try { localStorage.setItem(draftKey(target), JSON.stringify(d)); return true; } catch (e) { return false; }
  }
  function dropDraft(target) {
    try { localStorage.removeItem(draftKey(target)); } catch (e) { /* 消せなくても先へ進む */ }
  }
  function allDrafts() {
    var out = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(DRAFT_PREFIX + slug + ':') === 0) {
          var d = JSON.parse(localStorage.getItem(k) || 'null');
          if (d && d.body) out.push({ target: k.slice((DRAFT_PREFIX + slug + ':').length), draft: d });
        }
      }
    } catch (e) { /* 読めないなら下書きは無かったことにする */ }
    return out;
  }

  function formFor(target) {
    return target === 'new' ? form : list.querySelector('.reply-form[data-c="' + target + '"]');
  }

  function noteFor(f, msg) {
    var note = f.querySelector('.draftnote');
    if (!msg) { if (note) note.remove(); return; }
    if (!note) { note = document.createElement('div'); note.className = 'draftnote'; f.appendChild(note); }
    note.innerHTML = msg;
  }

  function draftNoteHtml(target, d, stored) {
    return '<b>投稿できなかった</b>: ' + esc(d.error || '理由は不明') + '<br>' +
      (stored
        ? '書いた内容' + (d.params ? 'と添付' : '') + 'は<b>このブラウザに保存してある</b>ので、' +
          'ページを閉じても消えない。投稿できるようになり次第、自動で投げ直す。' +
          // 何度投げても通らない失敗（大きすぎる等）のために、投げ直しを止める口を必ず置く
          ' <button type="button" data-draftdrop="' + esc(target) + '">この下書きを捨てる</button>'
        : 'このブラウザは保存領域を使えない設定のため、<b>内容を保存できなかった</b>。閉じる前に手元へ控えること。');
  }

  /** 保存してある下書きを、対応する欄へ戻す。render() のたびに呼ぶ。 */
  function restoreDrafts() {
    allDrafts().forEach(function (x) {
      var f = formFor(x.target);
      if (!f) return; // 返信先のコメントが消えている等。下書きは残しておく（人が見つけて拾える）
      var ta = f.querySelector('textarea');
      if (ta && !ta.value) ta.value = x.draft.body;
      if (x.draft.params) attachOf[x.target] = x.draft.params;
      noteFor(f, draftNoteHtml(x.target, x.draft, true));
    });
    decorateForms();
    scheduleRetry();
  }

  function scheduleRetry() {
    var has = allDrafts().length > 0;
    if (has && !retryTimer) retryTimer = setInterval(retryDrafts, 20000);
    if (!has && retryTimer) { clearInterval(retryTimer); retryTimer = null; }
  }

  /** 投稿できるようになったら自分で投げ直す（ユーザ指定「できれば自動で投稿されることが望ましい」）。 */
  function retryDrafts() {
    var drafts = allDrafts();
    if (!drafts.length) { scheduleRetry(); return; }
    var next = function (i) {
      if (i >= drafts.length) { reload().then(scheduleRetry); return; }
      var x = drafts[i];
      postTo(x.target, x.draft.body, x.draft.params).then(function () {
        dropDraft(x.target);
        delete attachOf[x.target];
        var f = formFor(x.target);
        if (f) { var ta = f.querySelector('textarea'); if (ta) ta.value = ''; noteFor(f, ''); }
        next(i + 1);
      }, function () { next(i + 1); }); // まだ駄目なら次の機会に
    };
    next(0);
  }

  if (!readonly) window.addEventListener('online', retryDrafts);

  // ------------------------------------------------------------ 投稿

  function postTo(target, body, params) {
    var suffix = target === 'new' ? '' : '/' + target;
    var payload = { body: body };
    if (params) payload.params = params;
    if (run) payload.run = run;
    return api('POST', suffix, payload);
  }

  /** 投稿に失敗したときの共通の後始末: 退避して、理由と保存先を断る。 */
  function keepDraft(target, body, params, err) {
    var d = { body: body, params: params || null, error: err.message, at: new Date().toISOString() };
    var stored = writeDraft(target, d);
    var f = formFor(target);
    if (f) noteFor(f, draftNoteHtml(target, d, stored));
    scheduleRetry();
  }

  // ------------------------------------------------------------ 描画

  function who(a) { return a === 'claude' ? '<span class="au ai">Claude</span>' : '<span class="au">ユーザ</span>'; }

  function bodyHtml(x) {
    if (x.deleted || x.body == null) return '<div class="cbody gone">（本文は削除された。スレッドがあるため存在だけ残っている）</div>';
    return '<div class="cbody">' + md(x.body) + '</div>';
  }

  function actions(cid, rid, x) {
    if (readonly || x.deleted || x.body == null) return '';
    return '<div class="ca">' +
      '<button data-act="edit" data-c="' + cid + '"' + (rid ? ' data-r="' + rid + '"' : '') + '>編集</button>' +
      '<button data-act="del" data-c="' + cid + '"' + (rid ? ' data-r="' + rid + '"' : '') + '>削除</button>' +
      '</div>';
  }

  function render(data) {
    shownParams = {};
    if (!data.comments.length) { list.innerHTML = '<p class="dim">まだコメントはありません。</p>'; decorateForms(); return; }
    list.innerHTML = data.comments.map(function (c) {
      var replies = c.replies.map(function (r) {
        return '<div class="reply">' +
          '<div class="chead">' + who(r.author) + '<span class="cwhen">' + when(r.createdAt) + '</span>' + actions(c.id, r.id, r) + '</div>' +
          bodyHtml(r) + attachmentHtml(c.id + '/' + r.id, r.params) + '</div>';
      }).join('');
      return '<article class="comment' + (c.aiThread ? ' aithread' : '') + '">' +
        '<div class="chead">' + who(c.author) + '<span class="cwhen">' + when(c.createdAt) + '</span>' +
        (c.aiThread ? '<span class="aitag">🤖 AI が返答するスレッド</span>' : '') +
        actions(c.id, null, c) + '</div>' +
        bodyHtml(c) + attachmentHtml(c.id, c.params) +
        '<div class="replies">' + replies + '</div>' +
        (readonly ? '' : replyForm(c)) +
        '</article>';
    }).join('');
    decorateForms();
  }

  function replyForm(c) {
    return '<form class="cform reply-form" data-c="' + c.id + '">' +
      '<textarea rows="2" placeholder="' + (c.aiThread ? 'Claude へ返信（投稿すると返答が生成されます）' : 'このスレッドへ返信') + '"></textarea>' +
      '<div class="crow"><button type="submit" class="btn">返信</button>' +
        (c.aiThread ? '' : '<button type="button" class="btn ghost mkai" data-c="' + c.id + '">🤖 AI が返答するスレッドにする</button>') +
      '</div></form>';
  }

  /** どの投稿欄にも「設定を添付」の口と、添付中の札を出す。 */
  function decorateForms() {
    if (readonly) return;
    var forms = [form].concat([].slice.call(list.querySelectorAll('.reply-form')));
    forms.forEach(function (f) {
      if (!f) return;
      var target = f === form ? 'new' : f.getAttribute('data-c');
      var row = f.querySelector('.crow');
      if (!row) return;
      var slot = row.querySelector('.attslot');
      if (!slot) {
        slot = document.createElement('span');
        slot.className = 'attslot';
        slot.style.display = 'contents';
        row.appendChild(slot);
      }
      var text = attachOf[target];
      slot.innerHTML = text
        ? '<span class="attchip">📎 設定を添付' + esc(attachLabel(text)) +
          '<button type="button" data-attclear="' + esc(target) + '" title="添付を外す">✕</button></span>'
        : '<button type="button" class="btn ghost attpick" data-atttarget="' + esc(target) + '">📎 設定を添付</button>';
    });
  }

  function reload() {
    if (readonly) {
      var el = document.getElementById('cdata');
      try { render(JSON.parse(el ? el.textContent : '{"comments":[]}')); }
      catch (e) { list.innerHTML = '<p class="err">読み込めない: ' + esc(e.message) + '</p>'; }
      return Promise.resolve();
    }
    return api('GET').then(function (d) { render(d); restoreDrafts(); })
      .catch(function (e) { list.innerHTML = '<p class="err">読み込めない: ' + esc(e.message) + '</p>'; });
  }

  // ------------------------------------------------------------ 操作

  var filePick = document.createElement('input');
  filePick.type = 'file';
  filePick.accept = '.json,application/json';
  filePick.style.display = 'none';
  document.body.appendChild(filePick);
  var pickTarget = 'new';
  filePick.onchange = function () {
    var file = filePick.files[0];
    filePick.value = '';
    if (!file) return;
    var fr = new FileReader();
    fr.onload = function () {
      try { JSON.parse(fr.result); } catch (e) { alert('JSON として読めない: ' + e.message); return; }
      attachOf[pickTarget] = String(fr.result);
      decorateForms();
    };
    fr.readAsText(file);
  };

  function submitForm(f, target, btn, aiPoll) {
    var ta = f.querySelector('textarea');
    if (!ta.value.trim()) return;
    var body = ta.value, params = attachOf[target] || null;
    btn.disabled = true;
    var label = btn.textContent;
    btn.textContent = '送信中…';
    postTo(target, body, params).then(function (r) {
      ta.value = '';
      delete attachOf[target];
      dropDraft(target);
      noteFor(f, '');
      if (aiPoll && r.aiPending) { aiPoll(btn, label, target); return; }
      btn.disabled = false; btn.textContent = label;
      reload();
    }).catch(function (e) {
      btn.disabled = false; btn.textContent = label;
      keepDraft(target, body, params, e);
      decorateForms();
    });
  }

  if (form) form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    submitForm(form, 'new', form.querySelector('button[type=submit]'));
  });

  /**
   * claude の返答が届くまで、その場で待つ。
   * 生成は数十秒かかることがあるので、**出来上がるまで静かに見に行く**。
   * 呼び手は2つ——返信の投稿と、スレッドの AI 化（2026-09-17 ユーザ指定で後者も返答を起こす）。
   */
  function awaitClaude(cid, btn, label) {
    btn.disabled = true;
    btn.textContent = 'Claude が考えています…';
    // 待ち始める時点で**末尾が claude であることは無い**（AI 化の直後か、人間が今返信した直後）。
    // だから「末尾が claude になったら終わり」で足りる——控えを取る必要が無い
    var tries = 0;
    (function poll() {
      if (++tries > 60) { btn.disabled = false; btn.textContent = label; reload(); return; }
      setTimeout(function () {
        api('GET').then(function (d) {
          var c = d.comments.filter(function (x) { return x.id === cid; })[0];
          if (c && c.replies.length && c.replies[c.replies.length - 1].author === 'claude') {
            btn.disabled = false; btn.textContent = label; render(d); restoreDrafts();
          } else poll();
        }).catch(poll);
      }, 3000);
    })();
  }

  list.addEventListener('submit', function (ev) {
    var f = ev.target.closest('.reply-form');
    if (!f) return;
    ev.preventDefault();
    var cid = f.getAttribute('data-c');
    submitForm(f, cid, f.querySelector('button[type=submit]'), function (btn, label) {
      awaitClaude(cid, btn, label);
    });
  });

  document.addEventListener('click', function (ev) {
    var b = ev.target.closest ? ev.target.closest('button') : null;
    if (!b || !root.contains(b)) return;

    if (b.hasAttribute('data-draftdrop')) {
      var dt = b.getAttribute('data-draftdrop');
      if (!confirm('この下書きを捨てますか？（書いた内容と添付は失われ、投げ直しも止まります）')) return;
      dropDraft(dt);
      var df = formFor(dt);
      if (df) { var dta = df.querySelector('textarea'); if (dta) dta.value = ''; noteFor(df, ''); }
      delete attachOf[dt];
      decorateForms();
      scheduleRetry();
      return;
    }
    if (b.hasAttribute('data-atttarget')) { pickTarget = b.getAttribute('data-atttarget'); filePick.click(); return; }
    if (b.hasAttribute('data-attclear')) { delete attachOf[b.getAttribute('data-attclear')]; decorateForms(); return; }

    var att = b.getAttribute('data-att');
    if (att) {
      var text = shownParams[b.getAttribute('data-key')];
      if (!text) return;
      if (att === 'dl') {
        var d = null;
        try { d = JSON.parse(text); } catch (e) { /* 名前は既定へ落ちる */ }
        download(text, ((d && d.sketch) || slug) + '-params-' + (b.getAttribute('data-key').replace(/\//g, '-')) + '.json');
      } else if (att === 'load') {
        loadIntoStage(text, b);
      }
      return;
    }

    var cid = b.getAttribute('data-c'), rid = b.getAttribute('data-r'), act = b.getAttribute('data-act');
    if (!cid) return;
    var suffix = '/' + cid + (rid ? '/' + rid : '');

    if (b.classList.contains('mkai')) {
      if (!confirm('このスレッドを「AI が返答するスレッド」にします。\n\nこの変更は元に戻せません。**すぐにこのスレッドが読まれ、返答が生成されます。**\n以後もこのスレッドへ投稿するたびに Claude が返答します。\n\n続けますか？')) return;
      var mkLabel = b.textContent;
      api('POST', '/' + cid, { action: 'make-ai-thread' }).then(function (r) {
        if (r && r.aiPending) awaitClaude(cid, b, mkLabel);
        else reload();
      }).catch(function (e) { alert(e.message); });
      return;
    }
    if (act === 'del') {
      if (!confirm('削除しますか？（スレッド返信がある場合は本文だけ消え、存在は残ります）')) return;
      api('DELETE', suffix).then(reload).catch(function (e) { alert(e.message); });
      return;
    }
    if (act === 'edit') {
      api('GET').then(function (d) {
        var c = d.comments.filter(function (x) { return x.id === cid; })[0];
        var target = rid ? c.replies.filter(function (x) { return x.id === rid; })[0] : c;
        var v = prompt('本文を編集（Markdown）', target.body || '');
        if (v == null || !v.trim()) return;
        return api('PUT', suffix, { body: v }).then(reload);
      }).catch(function (e) { alert(e.message); });
    }
  });

  // ---- 実行窓からの「💬 コメントへ添付」を受ける（ユーザ指定の「exportしコメント」） ----
  if (stage && !readonly) {
    window.addEventListener('message', function (ev) {
      if (!stage.contentWindow || ev.source !== stage.contentWindow) return;
      if (ev.origin !== location.origin) return;
      var m = ev.data;
      if (!m || m.source !== 'harness' || m.type !== 'attach-params') return;
      attachOf['new'] = JSON.stringify(m.envelope, null, 2);
      // コメントの板を開いて本文の入力を待つ。板の開閉は overlay.js の仕事なので、札を押して頼む
      var tab = document.querySelector('.ovtab[data-go="comments"]');
      if (tab) tab.click();
      decorateForms();
      var ta = form.querySelector('textarea');
      if (ta) { ta.placeholder = '添付した設定に添えるコメント（このパターンの何が面白いか）'; ta.focus(); }
    });
  }

  reload();
})();
