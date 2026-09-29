/**
 * ホームの目次（2026-09-15 ユーザ指定の「高速スクロール」）。
 *
 * ユーザが選んだ形:
 *   - カードの並びの**横**に置く
 *   - **それ自体はスクロールされない**（sticky。ヘッダーが見えている間はヘッダーより下に留まる）
 *   - 項目は **番号だけ**（S-12 など）。「そのスケッチへ行きたいのではなく、その辺りへ行きたい」ため
 *   - 並べるのは **5つおき**（S-05・S-10・S-15…）だけ（2026-09-16 ユーザ指定）
 *   - **画面幅が狭くて置けないときは出さない**（CSS 側で消す）
 *
 * 直接スケッチ画面へは飛ばさず、**そのカードの位置までスクロールする**だけ——
 * 「スケッチの概要の書かれたカードを見てからスケッチの画面へ遷移したい」というユーザ指定による。
 *
 * この script が読めなくても、素のアンカー（`#card-…`）として同じ場所へ飛ぶ。
 * ここで足しているのは **なめらかなスクロール** と **今見ている位置の表示** だけである。
 *
 * 依存ゼロ・古典スクリプト。
 */
(function () {
  'use strict';
  var idx = document.querySelector('.idx');
  if (!idx) return;
  var links = [].slice.call(idx.querySelectorAll('a[data-idx]'));
  if (!links.length) return;

  idx.addEventListener('click', function (ev) {
    var a = ev.target.closest ? ev.target.closest('a[data-idx]') : null;
    if (!a) return;
    var target = document.getElementById(a.getAttribute('data-idx'));
    if (!target) return; // 飛び先が無いときは既定の動作（アンカー）に任せる
    ev.preventDefault();
    try { target.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    catch (e) { target.scrollIntoView(true); } // 古い実装は引数オブジェクトを解さない
  });

  // 今どのあたりを見ているかをレール上に出す。無くても目次としては働くので、
  // IntersectionObserver が無い環境では黙って諦める。
  if (!window.IntersectionObserver) return;

  // 目次は5つおきなので、**見ているカードがレールに無いことの方が多い**。
  // そこで全カードを並び順で見張り、見えているカードの**手前にある一番近い目印**を光らせる
  // （S-07 を見ているなら S-05 が光る）。
  var cards = [].slice.call(document.querySelectorAll('.card[id]'));
  var rank = {};
  cards.forEach(function (c, i) { rank[c.id] = i; });
  var markAt = links.map(function (a) { return rank[a.getAttribute('data-idx')]; });

  var visible = {};
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) { visible[e.target.id] = e.isIntersecting; });
    var top = -1;
    for (var i = 0; i < cards.length; i++) {
      if (visible[cards[i].id]) { top = i; break; }
    }
    var active = null;
    if (top >= 0) {
      for (var k = 0; k < links.length; k++) {
        if (markAt[k] != null && markAt[k] <= top) active = links[k]; // 手前にある最後の目印
      }
      if (!active) active = links[0]; // 最初の目印より手前を見ている
    }
    links.forEach(function (a) { a.classList.toggle('on', a === active); });
    // レール自身が内側でスクロールしている場合（画面が低いとき）、光った項目を見える位置へ
    if (active && idx.scrollHeight > idx.clientHeight + 4) {
      var want = active.offsetTop - idx.clientHeight / 2;
      if (Math.abs(idx.scrollTop - want) > idx.clientHeight / 3) idx.scrollTop = want;
    }
  }, { rootMargin: '-8% 0px -72% 0px' });

  cards.forEach(function (c) { io.observe(c); });
})();
