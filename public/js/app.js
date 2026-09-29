/* Chew Network — small progressive enhancements. Every feature works without JS. */
(function () {
  'use strict';
  document.documentElement.classList.add('js');
  var meta = document.querySelector('meta[name="csrf-token"]');
  var csrf = meta ? meta.getAttribute('content') : '';

  // ---- Toast ----------------------------------------------------------------
  var toastEl;
  var toastTimer;
  function toast(msg) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'toast';
      toastEl.setAttribute('role', 'status');
      toastEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = msg;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('show');
    }, 2600);
  }

  function flashButton(btn, label) {
    if (!btn) return;
    var label0 = btn.getAttribute('data-label') || btn.innerHTML;
    btn.setAttribute('data-label', label0);
    btn.textContent = label;
    setTimeout(function () {
      btn.innerHTML = label0;
    }, 1800);
  }

  function legacyCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try {
      ok = document.execCommand('copy');
    } catch (e) {}
    document.body.removeChild(ta);
    return ok;
  }

  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return legacyCopy(text); }
      );
    }
    return Promise.resolve(legacyCopy(text));
  }

  // ---- Clicks ------------------------------------------------------------------
  document.addEventListener('click', function (e) {
    var copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) {
      e.preventDefault();
      var sel = copyBtn.getAttribute('data-copy-target');
      var target = sel ? document.querySelector(sel) : null;
      var text = target ? (target.value != null ? target.value : target.textContent) : copyBtn.getAttribute('data-copy');
      copyText(text).then(function (ok) {
        if (ok) {
          flashButton(copyBtn, 'Copied!');
          toast('Copied to clipboard');
        } else if (target && target.select) {
          target.select();
          toast('Press Ctrl/⌘+C to copy');
        }
      });
      return;
    }

    var shareBtn = e.target.closest('[data-share]');
    if (shareBtn) {
      e.preventDefault();
      var url = shareBtn.getAttribute('data-share');
      if (navigator.share) {
        navigator.share({ title: shareBtn.getAttribute('data-share-title') || 'Chew Network', url: url }).catch(function () {});
      } else {
        copyText(url).then(function () { toast('Link copied — paste it anywhere to share'); });
      }
      return;
    }

    var pw = e.target.closest('.pw-toggle');
    if (pw) {
      var input = pw.parentNode.querySelector('input');
      var show = input.type === 'password';
      input.type = show ? 'text' : 'password';
      pw.textContent = show ? 'Hide' : 'Show';
      pw.setAttribute('aria-pressed', show ? 'true' : 'false');
      return;
    }

    var toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      var el = document.getElementById(toggle.getAttribute('data-toggle'));
      if (el) {
        var open = el.classList.toggle('open');
        toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      }
      return;
    }

    var confirmEl = e.target.closest('a[data-confirm], button[data-confirm]');
    if (confirmEl && !window.confirm(confirmEl.getAttribute('data-confirm'))) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }

    // Close an open mobile menu when tapping elsewhere.
    document.querySelectorAll('details.mobile-menu[open]').forEach(function (d) {
      if (!d.contains(e.target)) d.open = false;
    });
  });

  // ---- Forms ----------------------------------------------------------------------
  document.addEventListener('submit', function (e) {
    var form = e.target;
    if (form.hasAttribute('data-confirm') && !window.confirm(form.getAttribute('data-confirm'))) {
      e.preventDefault();
      return;
    }
    var kind = form.getAttribute('data-ajax');
    if (!kind || !window.fetch || !window.URLSearchParams) return;
    e.preventDefault();
    var btn = form.querySelector('button[type="submit"], button:not([type])');
    var body = new URLSearchParams(new FormData(form));
    var request = fetch(form.action, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', 'X-CSRF-Token': csrf },
      body: body,
    }).then(function (r) {
      if (!r.ok) throw new Error('Request failed');
      return r.json();
    });
    var pick = function (d) { return kind === 'caption' ? d.caption : d.url; };

    // Safari only allows clipboard writes inside the tap, so hand it a promise.
    var done;
    if (window.ClipboardItem && navigator.clipboard && navigator.clipboard.write && window.isSecureContext) {
      try {
        done = navigator.clipboard
          .write([new ClipboardItem({ 'text/plain': request.then(function (d) { return new Blob([pick(d)], { type: 'text/plain' }); }) })])
          .then(function () { return request; });
      } catch (err) {
        done = Promise.reject(err);
      }
    } else {
      done = request.then(function (d) {
        return copyText(pick(d)).then(function (ok) {
          if (!ok) throw new Error('copy failed');
          return d;
        });
      });
    }
    done
      .then(function (d) {
        flashButton(btn, 'Copied!');
        toast(kind === 'caption' ? 'Caption copied with your tracked link' : 'Link copied: ' + d.url);
        var card = form.closest('[data-asset]');
        var badge = card && card.querySelector('[data-usage]');
        if (badge) {
          badge.className = 'badge badge-used';
          badge.textContent = 'Used';
        }
      })
      .catch(function () {
        request
          .then(function (d) { window.prompt('Copy this:', pick(d)); })
          .catch(function () { form.submit(); });
      });
  });

  document.addEventListener('change', function (e) {
    var t = e.target;
    if (t.matches('[data-autosubmit]') && t.form) t.form.submit();
    if (t.matches('[data-check-all]')) {
      document.querySelectorAll(t.getAttribute('data-check-all')).forEach(function (cb) { cb.checked = t.checked; });
    }
  });

  // Verification code: digits only; submit once all six are entered.
  var code = document.querySelector('input[data-otp]');
  if (code) {
    code.addEventListener('input', function () {
      code.value = code.value.replace(/\D/g, '').slice(0, 6);
      if (code.value.length === 6 && code.form && !code.form.getAttribute('data-sent')) {
        code.form.setAttribute('data-sent', '1');
        code.form.submit();
      }
    });
  }

  // Chart tooltips: every column carries data-tip (hover or keyboard focus).
  var tip;
  function showTip(el, x, y) {
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'chart-tip';
      tip.setAttribute('role', 'tooltip');
      document.body.appendChild(tip);
    }
    tip.textContent = el.getAttribute('data-tip');
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
    tip.hidden = false;
  }
  function hideTip() { if (tip) tip.hidden = true; }
  document.addEventListener('pointermove', function (e) {
    var el = e.target.closest && e.target.closest('[data-tip]');
    if (el) showTip(el, e.clientX, e.clientY);
    else hideTip();
  });
  document.addEventListener('focusin', function (e) {
    var el = e.target.closest && e.target.closest('[data-tip]');
    if (!el) return hideTip();
    var r = el.getBoundingClientRect();
    showTip(el, r.left + r.width / 2, r.top + r.height / 3);
  });
  document.addEventListener('scroll', hideTip, { passive: true });

  // Read-only link fields select themselves for easy manual copying.
  document.querySelectorAll('input[data-select]').forEach(function (i) {
    i.addEventListener('focus', function () { i.select(); });
  });
})();
