/**
 * スケッチ画面の重ね表示。
 *
 * ユーザ指定: 「スケッチ詳細ページ = 実行ページとする。そこへ詳細ページを重ねて表示することができる
 * ようにする。**重なっているだけなので、実行ページでは実行を続けられる**」。
 *
 * したがって実行窓（iframe）は**触らない**——隠しも再読み込みもしない。上に板を重ねるだけ。
 *
 * 依存ゼロ・古典スクリプト。
 */
(function () {
  'use strict';
  var ov = document.getElementById('overlay');
  if (!ov) return;
  var body = ov.querySelector('.ovbody');

  function show(name) {
    var found = false;
    ov.querySelectorAll('.pane').forEach(function (p) {
      var on = p.getAttribute('data-pane') === name;
      p.hidden = !on;
      if (on) found = true;
    });
    if (!found) return false;
    ov.querySelectorAll('.ovtab').forEach(function (t) {
      t.classList.toggle('on', t.getAttribute('data-go') === name);
    });
    ov.hidden = false;
    document.body.classList.add('ovopen');
    if (body) body.scrollTop = 0;
    return true;
  }

  function hide() {
    ov.hidden = true;
    document.body.classList.remove('ovopen');
  }

  document.addEventListener('click', function (ev) {
    var b = ev.target.closest('[data-go]');
    if (b) { ev.preventDefault(); show(b.getAttribute('data-go')); return; }
    if (ev.target.closest('#ovclose')) { ev.preventDefault(); hide(); }
  });

  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape' && !ov.hidden) hide();
  });

  // 直リンク（/sketch/xx/report/yy）で開いた場合はその板を最初から出す
  var open = ov.getAttribute('data-open');
  if (open) show(open); else hide();
})();
