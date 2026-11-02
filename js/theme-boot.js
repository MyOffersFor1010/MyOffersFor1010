// Classic (non-module) script loaded in <head> so the saved theme is applied before first paint.
(function () {
  // Anti-clickjacking for hosts that cannot send frame-ancestors headers (GitHub Pages);
  // Firebase Hosting also sends them (firebase.json). Refuse to render inside a frame.
  if (window.top !== window.self) {
    document.documentElement.style.display = 'none';
    try { window.top.location = window.self.location; } catch (e) { /* cross-origin: stay hidden */ }
    return;
  }

  var theme = 'system';
  try {
    // 'privatechat.prefs' is the name used up to v2.2 (settings.js moves it on next save).
    var prefs = JSON.parse(localStorage.getItem('mo.prefs') || localStorage.getItem('privatechat.prefs') || '{}');
    if (prefs && typeof prefs.theme === 'string') theme = prefs.theme;
  } catch (e) { /* storage unavailable: fall back to system theme */ }
  var dark = theme === 'dark' ||
    (theme === 'system' && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : 'light');
})();
