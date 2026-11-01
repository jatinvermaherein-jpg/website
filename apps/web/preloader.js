/* JATIN preloader. Include in <head>:  <script src="preloader.js"></script>
   - No script  -> no curtain, content simply visible.
   - Watchdog   -> the curtain is force-removed after 4.5s no matter what.
   - Plays once per browser session (add ?preload to the URL to replay).
   - prefers-reduced-motion -> skipped entirely. */
(function () {
  'use strict';
  var root = document.documentElement;
  var done = false;
  var el = null;

  function finish() {
    if (done) return;
    done = true;
    root.classList.remove('pre-on');
    if (el && el.parentNode) el.parentNode.removeChild(el);
    el = null;
  }

  try {
    var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var forced = /[?&]preload\b/.test(location.search);
    var seen = false;
    try { seen = sessionStorage.getItem('jatin-pre') === '1'; } catch (e) {}
    if (reduce || (seen && !forced)) return;
    try { sessionStorage.setItem('jatin-pre', '1'); } catch (e) {}

    root.classList.add('pre-on');

    // Watchdog: never strand the user under the curtain.
    setTimeout(finish, 4500);
    window.addEventListener('pageshow', function (e) { if (e.persisted) finish(); });

    el = document.createElement('div');
    el.className = 'pre';
    el.setAttribute('aria-hidden', 'true');
    var bar = document.createElement('i');
    bar.className = 'pre-bar';
    var word = document.createElement('span');
    word.className = 'pre-word';
    'JATIN'.split('').forEach(function (c, i) {
      var s = document.createElement('span');
      s.className = 'ch' + (c === 'I' ? ' dot-i' : '');
      s.textContent = c;
      s.style.transitionDelay = (i * 70) + 'ms';
      s.style.setProperty('--sx', ((i - 2) * 46 + (i % 2 ? 14 : -14)) + 'px');
      s.style.setProperty('--sy', (-60 - (i % 3) * 40) + 'px');
      s.style.setProperty('--sr', ((i - 2) * 9) + 'deg');
      word.appendChild(s);
    });
    el.appendChild(bar);
    el.appendChild(word);
    root.appendChild(el);

    var t = function (fn, ms) { setTimeout(function () { if (!done && el) fn(); }, ms); };
    // force layout, then run the sequence
    void el.offsetWidth;
    t(function () { el.classList.add('s-bar'); }, 40);        // bar drops (700ms)
    t(function () { el.classList.add('s-in'); }, 640);        // letters slam in (stagger)
    t(function () {                                           // scatter
      Array.prototype.forEach.call(el.querySelectorAll('.ch'), function (c, i) {
        c.style.transitionDelay = (i * 35) + 'ms';
      });
      el.classList.add('s-out');
    }, 2000);
    t(function () { el.classList.add('s-lift'); }, 2550);     // curtain lifts (900ms)
    t(finish, 3500);
  } catch (err) {
    finish();
  }
})();
