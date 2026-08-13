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
    badge: '27',
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

// Filled in by checkAuthAndInit() below before anything renders — every
// function past that point can assume it's already resolved.
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
      <button type="button" class="collapse-toggle" id="collapseToggle" aria-label="Collapse sidebar" title="Collapse sidebar">
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

    const item = `
    <a class="${itemClasses}" href="${href}">
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

// ---------- Sidebar collapse + accordion + user menu ----------
// Wired up once, right after the sidebar's real markup exists — was two
// separate top-level blocks running at import time before the auth gate
// below made rendering itself conditional (see checkAuthAndInit).
function initSidebarInteractions() {
  const sidebar = document.getElementById('sidebar');
  const collapseToggle = document.getElementById('collapseToggle');
  if (collapseToggle) {
    if (localStorage.getItem('kitsune-sidebar-collapsed') === '1') {
      sidebar.classList.add('collapsed');
    }
    collapseToggle.addEventListener('click', () => {
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
    document.addEventListener('click', (e) => {
      if (!userMenu.contains(e.target) && !userChip.contains(e.target)) userMenu.classList.remove('open');
    });
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
    const next = encodeURIComponent(currentFile());
    window.location.href = `login.html?next=${next}`;
    return;
  }

  if (state.user !== 'unknown') currentUser = state.user;
  renderSidebar();
  renderPageTabs();
  initSidebarInteractions();
}

checkAuthAndInit();
