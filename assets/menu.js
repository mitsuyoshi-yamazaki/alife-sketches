/**
 * どの画面にも出る全体メニュー。
 *
 * ユーザ指定: 「このダッシュボード全体に表示される、普段は隠れているメニューを追加し、そこに
 * 『terminology へこの単語を追加する』メニューを追加する。**どの画面にいても、追加したい単語を
 * すぐ記録できるようにするため**」。説明はユーザが後から書くので、ここでは語だけを送る。
 *
 * 依存ゼロ・古典スクリプト。
 */
(function () {
  'use strict';
  var fab = document.getElementById('fab');
  var menu = document.getElementById('menu');
  if (!fab || !menu) return;

  function open(on) {
    menu.hidden = !on;
    fab.classList.toggle('on', on);
    if (on) { var i = menu.querySelector('input[name=term]'); if (i) i.focus(); }
  }

  fab.addEventListener('click', function () { open(menu.hidden); });
  document.addEventListener('click', function (ev) {
    if (!menu.hidden && !menu.contains(ev.target) && ev.target !== fab) open(false);
  });
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !menu.hidden) open(false);
  });

  var form = document.getElementById('addterm');
  if (!form) return;
  var msg = form.querySelector('.msg');
  form.addEventListener('submit', function (ev) {
    ev.preventDefault();
    var input = form.querySelector('input[name=term]');
    var term = input.value.trim();
    if (!term) return;
    msg.textContent = '送信中…';
    fetch('/api/terminology', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ term: term }),
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
      .then(function (x) {
        if (!x.ok) { msg.textContent = '足せない: ' + (x.j.error || ''); return; }
        msg.textContent = x.j.already ? '既にある' : '「' + term + '」を用語集へ積んだ';
        input.value = '';
      })
      .catch(function (e) { msg.textContent = '足せない: ' + e.message; });
  });
})();
