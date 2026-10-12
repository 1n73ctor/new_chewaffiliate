/* "Opening…" page for shared affiliate links: tells the server a real browser
   made this click (so it can be paid), then forwards the visitor. */
(function () {
  'use strict';
  var el = document.getElementById('go');
  if (!el) return;
  var dest = el.getAttribute('data-dest') || '/';
  var token = el.getAttribute('data-token') || '';
  var meta = document.querySelector('meta[name="csrf-token"]');
  var done = false;
  function go() {
    if (done) return;
    done = true;
    window.location.replace(dest);
  }
  setTimeout(function () {
    setTimeout(go, 1500); // never leave anyone waiting
    try {
      fetch('/r/confirm', {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': meta ? meta.getAttribute('content') : '' },
        body: JSON.stringify({ t: token, wd: navigator.webdriver === true }),
      }).then(go, go);
    } catch (e) {
      go();
    }
  }, 300);
})();
