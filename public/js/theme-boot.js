// Applies the chosen theme and accent color before the page's first paint.
//
// Same reasoning as sidebar-boot.js: this is a plain, parser-blocking
// <script src> in <head>, placed before the stylesheet link in EVERY page
// (login.html included), so <html data-theme="..."> is already set when
// styles.css is applied — no "flash of the dark theme, then snap to light"
// on each page load. Module scripts (app.js, the React bundles) are always
// deferred, so they'd be too late for this.
//
// The choice lives in localStorage so it's available synchronously here.
// The server copy (Settings > UI, /api/app-settings/ui keys `theme` and
// `accent`) is what follows you to other browsers: nav.js reads it once
// each page loads and calls KitsuneTheme.apply() if it differs, which also
// refreshes this cache for next time.
//
// Theme ids must match the :root[data-theme="<id>"] blocks in styles.css
// and the registry in frontend/lib/themes.js. "dark" has no block of its
// own — it's the plain :root defaults.
(function () {
  var THEME_KEY = 'kitsune-theme';
  var ACCENT_KEY = 'kitsune-accent';
  var IDS = ['dark', 'light', 'oled', 'dusk', 'paper', 'high-contrast'];

  function parseHex(hex) {
    var m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '').trim());
    if (!m) return null;
    var n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function luminance(rgb) {
    var c = rgb.map(function (v) {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }

  function contrast(a, b) {
    var la = luminance(a), lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  // Text color for buttons filled with this accent: whichever of Kitsune's
  // near-black or plain white reads better on it.
  function onAccentFor(hex) {
    var rgb = parseHex(hex);
    if (!rgb) return null;
    return contrast(rgb, [26, 13, 6]) >= contrast(rgb, [255, 255, 255]) ? '#1a0d06' : '#ffffff';
  }

  function apply(theme, accent) {
    var root = document.documentElement;
    var id = IDS.indexOf(theme) >= 0 ? theme : 'dark';
    root.setAttribute('data-theme', id);

    var hex = parseHex(accent) ? '#' + String(accent).replace('#', '').toLowerCase() : '';
    if (hex) {
      root.style.setProperty('--accent', hex);
      root.style.setProperty('--on-accent', onAccentFor(hex));
    } else {
      root.style.removeProperty('--accent');
      root.style.removeProperty('--on-accent');
    }

    try {
      localStorage.setItem(THEME_KEY, id);
      if (hex) localStorage.setItem(ACCENT_KEY, hex);
      else localStorage.removeItem(ACCENT_KEY);
    } catch (e) {
      // Private browsing / locked-down storage: the theme still applies for
      // this page, it just won't be remembered for the next one.
    }
    return { theme: id, accent: hex };
  }

  function stored() {
    try {
      return { theme: localStorage.getItem(THEME_KEY) || 'dark', accent: localStorage.getItem(ACCENT_KEY) || '' };
    } catch (e) {
      return { theme: 'dark', accent: '' };
    }
  }

  window.KitsuneTheme = {
    ids: IDS,
    apply: apply,
    stored: stored,
    parseHex: parseHex,
    contrast: contrast,
    onAccentFor: onAccentFor,
  };

  var s = stored();
  apply(s.theme, s.accent);
})();
