// Light / dark mode for the whole site. Loaded in <head> of index.html, book.html and terms.html.
// Dark is the default. The visitor's choice is remembered in their own browser.
(function () {
  var KEY = 'pa-theme', root = document.documentElement;
  var SUN = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';

  function saved() { try { var v = localStorage.getItem(KEY); return v === 'light' || v === 'dark' ? v : null; } catch (e) { return null; } }
  function save(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* private mode: the choice just will not be remembered */ } }

  function paint(t) {
    var light = t === 'light';
    [].forEach.call(document.querySelectorAll('[data-theme-toggle]'), function (b) {
      b.innerHTML = light ? MOON : SUN; // shows the mode you would switch TO
      var label = light ? 'Switch to dark mode' : 'Switch to light mode';
      b.setAttribute('aria-label', label); b.setAttribute('title', label);
    });
    var m = document.querySelector('meta[name=theme-color]');
    if (m) { if (!m.getAttribute('data-dark')) m.setAttribute('data-dark', m.getAttribute('content')); m.setAttribute('content', light ? '#f6f0e2' : m.getAttribute('data-dark')); }
  }
  function apply(t) { root.setAttribute('data-theme', t); paint(t); }

  apply(saved() || 'dark'); // runs before the page is drawn, so there is no flash

  document.addEventListener('DOMContentLoaded', function () {
    paint(root.getAttribute('data-theme'));
    [].forEach.call(document.querySelectorAll('[data-theme-toggle]'), function (b) {
      b.addEventListener('click', function () {
        var next = root.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
        save(next); apply(next);
      });
    });
  });
  window.addEventListener('storage', function (e) { if (e.key === KEY && (e.newValue === 'light' || e.newValue === 'dark')) apply(e.newValue); });
})();
