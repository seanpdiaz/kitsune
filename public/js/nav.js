// ---------- Sidebar: single source of truth ----------
// The sidebar used to be ~72 lines of byte-identical markup pasted into all 28
// public/*.html pages, differing only in which nav-item/nav-sub carried the
// "active"/"open" classes for that page. That meant every nav change (a new
// page, a relabeled section) was a manual find-and-replace sweep across every
// file — exactly the kind of edit this project's README already flags as
// error-prone (see the "Sidebar navigation" section). This renders the whole
// thing once, here, and derives which item is active from the current page's
// own filename instead of relying on each page to hardcode it correctly.
const NAV_SECTIONS = [
  {
    label: 'Library',
    href: 'index.html',
    icon: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    subs: [
      { href: 'library-add-new.html', label: 'Add New' },
      { href: 'library-import.html', label: 'Library Import' },
    ],
  },
  {
    label: 'Calendar',
    href: 'calendar.html',
    icon: '<rect x="3" y="4" width="18" height="17" rx="2"/><path d="M3 9h18M8 2v4M16 2v4"/>',
    subs: [],
  },
  {
    label: 'Activity',
    href: 'activity-queue.html',
    icon: '<path d="M3 12h4l2 7 4-14 2 7h6"/>',
    subs: [
      { href: 'activity-queue.html', label: 'Queue' },
      { href: 'activity-history.html', label: 'History' },
      { href: 'activity-blocklist.html', label: 'Blocklist' },
    ],
  },
  {
    label: 'Wanted',
    href: 'wanted-missing.html',
    icon: '<circle cx="12" cy="12" r="9"/><path d="M12 8v5l3 2"/>',
    // No static badge here anymore (used to be a hardcoded '27' that never
    // moved regardless of what was actually missing) — see
    // refreshWantedBadge() below, which fetches the real count and applies
    // it to the DOM directly once it's known.
    subs: [
      { href: 'wanted-missing.html', label: 'Missing' },
      { href: 'wanted-cutoff-unmet.html', label: 'Cutoff Unmet' },
    ],
  },
  { divider: true },
  {
    label: 'Settings',
    toggle: true,
    icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.2a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.2a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.2a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.2a1.7 1.7 0 0 0-1.5 1z"/>',
    subs: [
      { href: 'settings-media-management.html', label: 'Media Management' },
      { href: 'settings-profiles.html', label: 'Profiles' },
      { href: 'settings-quality.html', label: 'Quality' },
      { href: 'settings-custom-formats.html', label: 'Custom Formats' },
      { href: 'settings-indexers.html', label: 'Indexers' },
      { href: 'settings-download-clients.html', label: 'Download Clients' },
      { href: 'settings-import-lists.html', label: 'Import Lists' },
      { href: 'settings-connect.html', label: 'Connect' },
      { href: 'settings-metadata.html', label: 'Metadata' },
      { href: 'settings-tags.html', label: 'Tags' },
      { href: 'settings-general.html', label: 'General' },
      { href: 'settings-ui.html', label: 'UI' },
      // Admin-only (see requireAdmin in server/routes/auth.js — the page
      // itself and its /api/users endpoints both enforce this too, this is
      // just keeping a standard user from seeing a link that would 403).
      { href: 'settings-users.html', label: 'Users', adminOnly: true },
    ],
  },
  {
    label: 'System',
    toggle: true,
    // Admin-only, the whole section — Status/Tasks/Backup/Updates/Events/Logs
    // are server-operator concerns (who's allowed to back up or restart the
    // instance, read its logs, etc.), not something a standard user needs to
    // see at all. Unlike Settings > Users (one adminOnly sub-link inside an
    // otherwise-visible section), this hides the entire top-level nav item —
    // see the adminOnly check in visibleSections() below.
    adminOnly: true,
    icon: '<rect x="3" y="4" width="18" height="7" rx="1.5"/><rect x="3" y="13" width="18" height="7" rx="1.5"/><circle cx="7" cy="7.5" r="0.8" fill="currentColor" stroke="none"/><circle cx="7" cy="16.5" r="0.8" fill="currentColor" stroke="none"/>',
    subs: [
      { href: 'system-status.html', label: 'Status' },
      { href: 'system-tasks.html', label: 'Tasks' },
      { href: 'system-backup.html', label: 'Backup' },
      { href: 'system-updates.html', label: 'Updates' },
      { href: 'system-events.html', label: 'Events' },
      { href: 'system-logs.html', label: 'Logs' },
    ],
  },
];

// Filled in from a cached guess synchronously if one exists (see
// readCachedUser()/checkAuthAndInit() further down), then confirmed or
// corrected by checkAuthAndInit()'s real auth check shortly after — every
// render function assumes one of those two has already happened by the
// time it's called, not specifically checkAuthAndInit().
let currentUser = null;

function currentFile() {
  const file = location.pathname.split('/').pop();
  return file || 'index.html';
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// Two levels of admin-only gating: a whole top-level section (System) can be
// hidden outright, or just one of its sub-links (Settings > Users) filtered
// out while the rest of that section stays visible. Every other section/sub
// passes through unchanged for a standard user.
function isAdmin() {
  return !!(currentUser && currentUser.role === 'admin');
}
function visibleSections() {
  return NAV_SECTIONS
    .filter((section) => !section.adminOnly || isAdmin())
    .map((section) => {
      if (section.divider || !section.subs) return section;
      return { ...section, subs: section.subs.filter((s) => !s.adminOnly || isAdmin()) };
    });
}

function sectionMatches(section, file) {
  // A section's own top-level href always counts as a match, not just its
  // subs — this used to only check subs (fine back when Library's "All
  // Series" sub pointed at index.html too, so the section still matched
  // through that entry), but now that Library's top-level link IS
  // index.html with no sub duplicating it, checking subs alone would leave
  // the sidebar failing to highlight Library — and the page-tabs strip
  // failing to render Add New/Library Import — while sitting on index.html.
  if (section.href === file) return true;
  return section.subs.some((s) => s.href === file);
}

// The sidebar's bottom-most block — avatar initial, username, role, and a
// small dropdown (My Account / Log out). Pinned to the bottom by its own
// margin-top: auto (see .user-chip-wrap in styles.css), not by DOM position
// — it's simply the last thing rendered into the sidebar now that the
// collapse toggle lives up in the brand row instead of below it.
// Returns '' when signed out, but checkAuthAndInit() below never actually
// renders the sidebar in that state (it redirects to login.html first), so
// this is really just a defensive fallback.
function renderUserChip() {
  if (!currentUser) return '';
  const initial = escapeHtml(currentUser.username.slice(0, 1).toUpperCase());
  const name = escapeHtml(currentUser.username);
  const roleLabel = currentUser.role === 'admin' ? 'Admin' : 'Standard';
  return `
    <div class="user-chip-wrap">
      <div class="user-chip" id="userChip">
        <div class="user-avatar">${initial}</div>
        <div class="user-chip-info">
          <span class="user-chip-name">${name}</span>
          <span class="user-chip-role">${roleLabel}</span>
        </div>
        <svg class="user-chip-caret" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 9l6 6 6-6"/></svg>
      </div>
      <div class="user-menu" id="userMenu">
        <a href="account.html">My Account</a>
        <button type="button" id="logoutBtn">Log out</button>
      </div>
    </div>`;
}

// ---------- Mobile chrome: hamburger + top bar + scrim ----------
// Below the 860px breakpoint (see styles.css's own "Mobile / responsive"
// section), .sidebar becomes an off-canvas drawer instead of an
// always-visible column — these three elements are what open/close it.
// None of them exist in any of the 30 sidebar-bearing public/*.html files;
// injecting them here once, the same "single source of truth" reasoning
// NAV_SECTIONS/renderSidebar() above already follow for the sidebar's own
// markup, means adding or restyling this chrome later never needs a sweep
// across every page. Safe to call unconditionally on every page that has a
// #sidebar (login.html has none, and never loads this module at all — see
// its own comment) and safe to call more than once (guarded below), since
// the cached-user render path and checkAuthAndInit() can both end up
// calling into sidebar setup on the same page load.
const MOBILE_BREAKPOINT_QUERY = '(max-width: 860px)';
let mobileChromeReady = false;

function isMobileViewport() {
  return window.matchMedia(MOBILE_BREAKPOINT_QUERY).matches;
}

function setMobileNavOpen(open) {
  const sidebar = document.getElementById('sidebar');
  const scrim = document.getElementById('mobileNavScrim');
  const toggle = document.getElementById('mobileNavToggle');
  if (!sidebar) return;
  sidebar.classList.toggle('mobile-open', open);
  if (scrim) scrim.classList.toggle('visible', open);
  document.body.classList.toggle('mobile-nav-open', open);
  if (toggle) toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function ensureMobileChrome() {
  if (mobileChromeReady) return;
  if (!document.getElementById('sidebar')) return; // login.html etc.
  mobileChromeReady = true;

  const topbar = document.createElement('div');
  topbar.className = 'mobile-topbar';
  topbar.innerHTML = `
    <button type="button" class="mobile-nav-toggle" id="mobileNavToggle" aria-label="Open menu" aria-expanded="false">
      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
    </button>
    <svg class="brand-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c2 2.5 2 5 2 5s2.5-1 4-1 3 1 3 3-1.5 3-3 3c1 1.5 1 3.5-.5 5C16 19.5 14 19 12 21c-2-2-4-1.5-5.5-3-1.5-1.5-1.5-3.5-.5-5-1.5 0-3-1-3-3s1.5-3 3-3 4 1 4 1 0-2.5 2-5z"/></svg>
    <span class="mobile-topbar-title">Kitsune</span>`;

  const scrim = document.createElement('div');
  scrim.className = 'mobile-nav-scrim';
  scrim.id = 'mobileNavScrim';

  // Both inserted before .layout (the outermost, single wrapper every
  // sidebar-bearing page has directly under <body> — see any public/*.html
  // file) rather than appended at the end, so the topbar's position:
  // sticky (see styles.css) has a predictable spot at the very top of
  // normal document flow instead of depending on where in <body> a plain
  // append would happen to land it.
  const layout = document.querySelector('.layout');
  if (layout && layout.parentNode) {
    layout.parentNode.insertBefore(topbar, layout);
    layout.parentNode.insertBefore(scrim, layout);
  } else {
    document.body.prepend(scrim);
    document.body.prepend(topbar);
  }

  topbar.querySelector('#mobileNavToggle').addEventListener('click', () => setMobileNavOpen(true));
  scrim.addEventListener('click', () => setMobileNavOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setMobileNavOpen(false);
  });
  // A resize that crosses back above the breakpoint (rotating a tablet,
  // widening a resizable window) shouldn't leave the drawer's open state
  // and the scrim/body-scroll-lock it drives stuck on once .sidebar isn't
  // an overlay anymore.
  window.addEventListener('resize', () => {
    if (!isMobileViewport()) setMobileNavOpen(false);
  });
}

function renderSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const file = currentFile();
  const sections = visibleSections();

  // The collapse toggle used to be its own full-width bar at the very
  // bottom of the sidebar, right below the user chip. It now lives here
  // instead, as a plain hamburger icon button at the right edge of the
  // brand row — a hamburger rather than the old chevron+"Collapse" label
  // since a ubiquitous, label-free icon reads fine at this smaller size and
  // needs no text to explain what it does, unlike the old full-width bar.
  // Same #collapseToggle id, so initSidebarInteractions() below needs no
  // changes to find/wire it up.
  const brand = `
    <div class="brand">
      <div class="brand-identity">
        <svg class="brand-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c2 2.5 2 5 2 5s2.5-1 4-1 3 1 3 3-1.5 3-3 3c1 1.5 1 3.5-.5 5C16 19.5 14 19 12 21c-2-2-4-1.5-5.5-3-1.5-1.5-1.5-3.5-.5-5-1.5 0-3-1-3-3s1.5-3 3-3 4 1 4 1 0-2.5 2-5z"/></svg>
        <span class="brand-name">Kitsune</span>
      </div>
      <button type="button" class="collapse-toggle" id="collapseToggle" aria-label="Collapse sidebar" data-tooltip="Collapse sidebar" data-tooltip-pos="right">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h16"/></svg>
      </button>
    </div>`;

  const sectionsHtml = sections.map((section) => {
    if (section.divider) return '<div class="nav-divider"></div>';

    const active = sectionMatches(section, file);
    const itemClasses = ['nav-item', section.toggle ? 'nav-toggle' : '', active ? 'active' : '']
      .filter(Boolean)
      .join(' ');
    const href = section.toggle ? '#' : section.href;
    const badge = section.badge ? `<span class="nav-badge">${section.badge}</span>` : '';

    // data-tooltip/data-tooltip-pos here matter most once the sidebar is
    // collapsed (see styles.css's [data-tooltip] rules and
    // applyStoredSidebarCollapse above) — that's when .nav-label is hidden
    // and this becomes an icon-only control with no other way to tell what
    // it links to. Harmless when expanded too: hovering a row that already
    // shows its own label just surfaces the same text a beat later, right
    // where the cursor already is.
    const item = `
    <a class="${itemClasses}" href="${href}" data-tooltip="${section.label}" data-tooltip-pos="right">
      <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${section.icon}</svg>
      <span class="nav-label">${section.label}</span>
      ${badge}
    </a>`;

    if (section.subs.length === 0) return item;

    const subLinks = section.subs
      .map((s) => `<a${s.href === file ? ' class="active"' : ''} href="${s.href}">${s.label}</a>`)
      .join('\n      ');
    const sub = `
    <div class="nav-sub${active ? ' open' : ''}">
      ${subLinks}
    </div>`;

    return item + sub;
  }).join('\n');

  sidebar.innerHTML = brand + sectionsHtml + renderUserChip();
}

// ---------- Page tabs: the horizontal sub-nav at the top of most pages ----------
// This was the same duplication problem as the sidebar, one level down: the
// tab strip on every Settings/System/Activity/Wanted/Library-sub page (26 of
// 28 pages, ~249 lines total) is just that page's section's own sub-links
// again, hardcoded a second time. It's the exact same data already in
// NAV_SECTIONS above, so this renders from that one config instead of
// keeping a second hand-maintained copy in sync with the sidebar's.
function renderPageTabs() {
  const container = document.querySelector('.page-tabs');
  if (!container) return; // index.html, series.html, calendar.html, account.html have none
  const file = currentFile();
  const section = visibleSections().find((s) => !s.divider && sectionMatches(s, file));
  if (!section) return;

  container.innerHTML = section.subs
    .map((s) => `<a${s.href === file ? ' class="active"' : ''} href="${s.href}">${s.label}</a>`)
    .join('\n      ');
}

// ---------- Wanted sidebar badge: real live count ----------
// The Wanted nav item's badge used to be a hardcoded '27' baked into
// NAV_SECTIONS, so it never changed no matter what was actually missing.
// The real count isn't known until this GET resolves (and can change under
// the user — a grab completing, an air date passing — without a full
// reload), so it's applied straight to the DOM after the initial render
// instead of being part of NAV_SECTIONS' synchronous render. Uses the exact
// same "aired, monitored series only, not downloaded" query as GET
// /api/wanted/missing (server/routes/wanted.js) — the same one Wanted >
// Missing itself renders from — so the badge always agrees with the page it
// links to. A zero count hides the badge entirely rather than showing "0".
async function refreshWantedBadge() {
  const link = document.querySelector('a.nav-item[href="wanted-missing.html"]');
  if (!link) return; // Wanted section not present for this render (shouldn't happen, but don't throw)
  try {
    const res = await fetch('/api/wanted/missing');
    const body = await res.json();
    const count = Array.isArray(body.episodes) ? body.episodes.length : 0;
    let badge = link.querySelector('.nav-badge');
    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'nav-badge';
        link.appendChild(badge);
      }
      badge.textContent = String(count);
    } else if (badge) {
      badge.remove();
    }
  } catch {
    // Sidebar still works without it — just no badge until the next page load.
  }
}

// ---------- Activity sidebar badge: how many torrents are downloading now ----------
// Same "real count, applied to the DOM after the fact" shape as
// refreshWantedBadge() above — GET /api/queue (server/routes/queue.js) is
// the same list Activity > Queue itself renders from, so this always
// agrees with what clicking through actually shows. Counts only status ===
// 'downloading', not 'paused' — a paused torrent isn't actively downloading
// anything right now, so it shouldn't make this badge claim it is. Unlike
// the Wanted badge, this one also gets re-checked on an interval (see
// ACTIVITY_BADGE_POLL_MS below): a download can start or finish while
// you're sitting on some other page entirely (Settings, a series page,
// ...), not just between page loads the way the Wanted count realistically
// changes.
async function refreshActivityBadge() {
  const link = document.querySelector('a.nav-item[href="activity-queue.html"]');
  if (!link) return; // Activity section not present for this render (shouldn't happen, but don't throw)
  try {
    const res = await fetch('/api/queue');
    const body = await res.json();
    const count = Array.isArray(body.queue) ? body.queue.filter((q) => q.status === 'downloading').length : 0;
    let badge = link.querySelector('.nav-badge');
    if (count > 0) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'nav-badge';
        link.appendChild(badge);
      }
      badge.textContent = String(count);
    } else if (badge) {
      badge.remove();
    }
  } catch {
    // Sidebar still works without it — just no badge until the next successful poll.
  }
}
// 15s: frequent enough that starting or finishing a download shows up on
// the sidebar without a page reload, infrequent enough that every single
// page in the app (not just Activity > Queue, which already polls every
// 2s in its own right — see QueueList.jsx) isn't hammering the same
// endpoint on a tight loop just to keep one badge current.
const ACTIVITY_BADGE_POLL_MS = 15000;

// ---------- Sidebar collapse: applied synchronously, before the auth gate ----------
// This used to happen inside initSidebarInteractions() below, which only
// runs once checkAuthAndInit()'s GET /api/auth/state round trip resolves —
// a real network request, however fast. Calling it here instead — a plain
// top-level call below, executed the moment this module runs — closes most
// of that gap, but NOT all of it: this file (nav.js) is loaded via
// `<script type="module">` in app.js, and browsers always defer a module
// script's execution until after the whole document has finished parsing —
// and they're free to paint before that happens. In practice they do: as
// soon as styles.css finishes loading and the DOM has been parsed far
// enough (which includes the empty <aside id="sidebar"> sitting at its
// default 216px width), the browser can and does paint that frame, well
// before this module's code — including this very function — ever runs.
// So the real fix for the *first* paint lives in public/js/sidebar-boot.js,
// a plain parser-blocking <script> placed in <head> before the stylesheet
// link on every page, which marks <html> early enough that the browser
// never gets a chance to paint the expanded width at all (see that file's
// own comment, and the matching html.sidebar-collapsed-boot rule in
// styles.css). This function still matters for everything sidebar-boot.js
// can't do from <head>, before #sidebar exists — applying the real
// .collapsed class to the actual element (so the toggle button and every
// other .sidebar.collapsed rule, like hiding nav-item labels, work once
// renderSidebar() fills the sidebar with content) and cleaning up
// sidebar-boot.js's temporary marker once that's done.
function applyStoredSidebarCollapse() {
  const sidebar = document.getElementById('sidebar');
  if (sidebar && localStorage.getItem('kitsune-sidebar-collapsed') === '1') {
    sidebar.classList.add('collapsed');
  }
  // Cleanup for sidebar-boot.js's earlier <head>-script marker — a harmless
  // no-op if the sidebar was never collapsed to begin with, since it was
  // never added in that case.
  document.documentElement.classList.remove('sidebar-collapsed-boot');
}
applyStoredSidebarCollapse();

// ---------- Sidebar content: rendered synchronously from a cached user ----------
// One layer deeper than the width fix just above, and the actual reason a
// clear flash was still visible on every navigation even after that
// shipped: renderSidebar() (further down) builds the sidebar's ENTIRE
// content — every nav item, the brand mark, the user chip — and it has
// always run only after checkAuthAndInit()'s real GET /api/auth/state
// resolves, because visibleSections()/renderUserChip() need currentUser for
// admin-only filtering and the user chip itself. That meant #sidebar sat
// completely empty (correctly narrow if collapsed, thanks to
// applyStoredSidebarCollapse() above, but with zero nav items inside it) on
// every single full-page navigation until that fetch came back — then
// everything popped in at once. Even a fast local request is enough time
// for that to read as "the whole sidebar flashed and reloaded."
//
// The fix: cache the last real, successful auth result in sessionStorage
// (tab-scoped, cleared when the browser closes — right for "last known
// auth state," unlike localStorage, which would keep it around
// indefinitely across completely separate sessions) every time
// checkAuthAndInit() below resolves one for real, and on the NEXT
// navigation, read that cache synchronously — before any network round
// trip — and render the sidebar from it immediately. checkAuthAndInit()'s
// own real fetch still runs every time and is still what actually decides
// whether to redirect to login.html; it only re-renders the sidebar if the
// real result disagrees with this cached guess (a role change, a session
// that expired between page loads) — an uncommon case. The common one, the
// same signed-in user clicking between pages in one sitting, needs no
// re-render at all, so there's nothing left to visibly pop in.
//
// This only ever affects what the sidebar shows, never what's actually
// allowed: every admin-only page/action still checks the real session
// server-side (requireAdmin() etc. in server/routes/*.js) on every request,
// regardless of what a stale cached role briefly rendered here — so the
// worst case of a wrong guess is a nav item that 403s if clicked, corrected
// within one real round trip, not an actual permission gap.
const CACHED_USER_KEY = 'kitsune-cached-user';

function readCachedUser() {
  try {
    const raw = sessionStorage.getItem(CACHED_USER_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // sessionStorage can throw in some locked-down contexts
  }
}

function writeCachedUser(user) {
  try {
    sessionStorage.setItem(CACHED_USER_KEY, JSON.stringify(user));
  } catch {
    // Falls back to always waiting on the real fetch, same as before this
    // cache existed — nothing else depends on the write having succeeded.
  }
}

const cachedUser = readCachedUser();
if (cachedUser) {
  currentUser = cachedUser;
  ensureMobileChrome();
  renderSidebar();
  renderPageTabs();
  initSidebarInteractions();
}

// ---------- Sidebar collapse toggle + accordion + user menu ----------
// Wired up once, right after the sidebar's real markup exists — was two
// separate top-level blocks running at import time before the auth gate
// below made rendering itself conditional (see checkAuthAndInit).
let userMenuOutsideClickBound = false;
function bindUserMenuOutsideClick() {
  if (userMenuOutsideClickBound) return;
  userMenuOutsideClickBound = true;
  document.addEventListener('click', (e) => {
    const userChip = document.getElementById('userChip');
    const userMenu = document.getElementById('userMenu');
    if (userMenu && userChip && !userMenu.contains(e.target) && !userChip.contains(e.target)) {
      userMenu.classList.remove('open');
    }
  });
}

function initSidebarInteractions() {
  const sidebar = document.getElementById('sidebar');
  const collapseToggle = document.getElementById('collapseToggle');
  if (collapseToggle) {
    // The collapsed/expanded class itself is already applied by
    // applyStoredSidebarCollapse() above — this only wires up the click
    // handler, since the toggle button doesn't exist until renderSidebar()
    // has run. Below the mobile breakpoint .sidebar is an off-canvas
    // drawer, not a collapsible column (see styles.css's "Mobile /
    // responsive" section) — .collapsed there is neutralized back to a
    // full-width look, so toggling it would do nothing visible anyway.
    // This button is still the one hamburger inside the sidebar itself, so
    // rather than hide it on mobile and make the drawer only closable via
    // the scrim/topbar toggle/Escape, it does the more useful thing at
    // that width: close the drawer, same as tapping the scrim.
    collapseToggle.addEventListener('click', () => {
      if (isMobileViewport()) {
        setMobileNavOpen(false);
        return;
      }
      sidebar.classList.toggle('collapsed');
      localStorage.setItem('kitsune-sidebar-collapsed', sidebar.classList.contains('collapsed') ? '1' : '0');
    });
  }

  // Only one Settings/System sub-menu is open at a time. Whichever section
  // the current page belongs to starts open (computed in renderSidebar()
  // above); clicking either top-level item toggles its own sub-menu and
  // closes the other.
  document.querySelectorAll('.nav-item.nav-toggle').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const sub = item.nextElementSibling;
      if (!sub || !sub.classList.contains('nav-sub')) return;
      const wasOpen = sub.classList.contains('open');
      document.querySelectorAll('.nav-sub.open').forEach((s) => s.classList.remove('open'));
      if (!wasOpen) sub.classList.add('open');
    });
  });

  // User chip dropdown (My Account / Log out) — closes on an outside click,
  // same interaction shape as every modal-overlay in this app, just a small
  // inline menu instead of a centered modal.
  const userChip = document.getElementById('userChip');
  const userMenu = document.getElementById('userMenu');
  if (userChip && userMenu) {
    userChip.addEventListener('click', (e) => {
      e.stopPropagation();
      userMenu.classList.toggle('open');
    });
    // A plain document.addEventListener('click', ...) here, closing over
    // this specific userChip/userMenu pair, used to be safe on the
    // assumption initSidebarInteractions() only ever ran once per page. Now
    // that a cached-user render can call it once immediately and
    // checkAuthAndInit() can call it again afterward (see below) if the
    // real check disagrees with that cache, binding a fresh document-level
    // listener every call would stack — each old one left closing over a
    // now-detached userMenu/userChip from the previous render, doing
    // nothing useful but never going away either. bindUserMenuOutsideClick
    // guards against binding more than once, ever, and its handler looks up
    // the current #userChip/#userMenu at click time instead of closing over
    // whichever pair existed when it was bound, so one listener stays
    // correct across any number of re-renders.
    bindUserMenuOutsideClick();
  }
  const logoutBtn = document.getElementById('logoutBtn');
  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      logoutBtn.disabled = true;
      try {
        await fetch('/api/auth/logout', { method: 'POST' });
      } catch {
        // Falls through to the redirect either way — worst case the cookie
        // outlives the session server-side and just expires on its own.
      }
      window.location.href = 'login.html';
    });
  }
}

// ---------- Auth gate ----------
// Every page that loads app.js (i.e. every page except login.html — see
// that page's own comment) runs this before rendering anything. One round
// trip to GET /api/auth/state (see server/routes/auth.js) decides: nobody's
// ever completed first-run setup, or nobody's currently signed in → bounce
// to login.html (carrying `next` so it can send you back here after); else
// render the real sidebar/page-tabs with the signed-in user available to
// them (renderUserChip, the Settings > Users filter in visibleSections).
// This is still the ONLY thing that actually decides whether to redirect —
// the cached-user render above is purely a display optimization to avoid a
// visible flash, never a substitute for this real check.
async function checkAuthAndInit() {
  let state;
  try {
    const res = await fetch('/api/auth/state');
    state = await res.json();
  } catch {
    // Server unreachable — nothing renders correctly either way, but don't
    // bounce to login.html on a transient network hiccup and risk a loop.
    state = { needsSetup: false, user: 'unknown' };
  }

  if (state.needsSetup || !state.user) {
    // A stale cached user would just re-show a sidebar for someone who
    // isn't actually signed in before immediately redirecting away from it
    // — clear it so the next page doesn't repeat that.
    try { sessionStorage.removeItem(CACHED_USER_KEY); } catch { /* nothing to clean up if this itself throws */ }
    const next = encodeURIComponent(currentFile());
    window.location.href = `login.html?next=${next}`;
    return;
  }

  if (state.user !== 'unknown') {
    // Only re-render if the cached guess above (see readCachedUser) was
    // missing or turned out wrong — the common case already has a correct
    // sidebar on screen from that synchronous render, and unconditionally
    // re-rendering here every time would just reintroduce the exact flash
    // this cache exists to avoid.
    const sameAsCache = cachedUser
      && cachedUser.id === state.user.id
      && cachedUser.role === state.user.role
      && cachedUser.username === state.user.username;
    currentUser = state.user;
    writeCachedUser(state.user);
    if (!sameAsCache) {
      ensureMobileChrome();
      renderSidebar();
      renderPageTabs();
      initSidebarInteractions();
    }
  } else if (!cachedUser) {
    // 'unknown' (network error) and nothing cached to fall back on — still
    // attempt a render rather than leave the sidebar permanently blank.
    ensureMobileChrome();
    renderSidebar();
    renderPageTabs();
    initSidebarInteractions();
  }
  refreshWantedBadge(); // fire-and-forget — doesn't block the rest of the sidebar rendering
  refreshActivityBadge(); // ditto
}

checkAuthAndInit();
setInterval(refreshActivityBadge, ACTIVITY_BADGE_POLL_MS);
