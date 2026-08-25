// Prevents a flash of the sidebar's default expanded width on every page
// load for anyone who's collapsed it — see js/nav.js's applyStoredSidebarCollapse()
// for the fuller story. That function runs as early as it can inside nav.js,
// but nav.js is loaded as `<script type="module">` (via app.js), which the
// browser always defers until after the whole document has been parsed —
// and browsers are free to paint before a deferred script ever runs. In
// practice they do: styles.css finishes loading, the DOM (including the
// empty <aside id="sidebar"> sitting at its default 216px width) is parsed
// far enough to paint, and the browser shows that frame well before nav.js's
// module code executes and adds the real .collapsed class. The result was a
// visible "starts open, snaps shut" flash on every single page load.
//
// This script is the fix: a plain, parser-blocking <script src="..."> (no
// type="module", no defer/async) placed in <head> before the stylesheet
// link in every page except login.html (which has no sidebar at all — see
// its own comment). A blocking script like this runs synchronously the
// moment the parser reaches it, before the rest of <head> or any of <body>
// — including <aside id="sidebar"> itself — has even been parsed, so
// there's no window where the browser could paint the sidebar at its
// default width at all.
//
// #sidebar doesn't exist in the DOM yet at this point, so there's nothing
// to add a class to directly. Instead this marks <html> (which always
// exists, from the moment the parser opens the <html> tag) with a
// temporary class, and styles.css has one matching rule
// (html.sidebar-collapsed-boot .sidebar) that mirrors just the width from
// .sidebar.collapsed — the only property that actually needs to be correct
// before #sidebar has any content. nav.js's applyStoredSidebarCollapse()
// removes this temporary marker once it applies the real .collapsed class
// to #sidebar itself a moment later.
(function () {
  try {
    if (localStorage.getItem('kitsune-sidebar-collapsed') === '1') {
      document.documentElement.classList.add('sidebar-collapsed-boot');
    }
  } catch {
    // localStorage can throw in some locked-down/private-browsing contexts
    // — fail open to the normal expanded default rather than break the page.
  }
})();
