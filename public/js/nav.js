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
    ],
  },
  {
    label: 'System',
    toggle: true,
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

function currentFile() {
  const file = location.pathname.split('/').pop();
  return file || 'index.html';
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

function renderSidebar() {
  const sidebar = document.getElementById('sidebar');
  if (!sidebar) return;
  const file = currentFile();

  const brand = `
    <div class="brand">
      <svg class="brand-mark" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3c2 2.5 2 5 2 5s2.5-1 4-1 3 1 3 3-1.5 3-3 3c1 1.5 1 3.5-.5 5C16 19.5 14 19 12 21c-2-2-4-1.5-5.5-3-1.5-1.5-1.5-3.5-.5-5-1.5 0-3-1-3-3s1.5-3 3-3 4 1 4 1 0-2.5 2-5z"/></svg>
      <span class="brand-name">Kitsune</span>
    </div>`;

  const sections = NAV_SECTIONS.map((section) => {
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

  const collapse = `
    <div class="collapse-toggle" id="collapseToggle">
      <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2"><path d="M15 18l-6-6 6-6"/></svg>
      <span class="collapse-label">Collapse</span>
    </div>`;

  sidebar.innerHTML = brand + sections + collapse;
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
  if (!container) return; // index.html, series.html, calendar.html have none
  const file = currentFile();
  const section = NAV_SECTIONS.find((s) => !s.divider && sectionMatches(s, file));
  if (!section) return;

  container.innerHTML = section.subs
    .map((s) => `<a${s.href === file ? ' class="active"' : ''} href="${s.href}">${s.label}</a>`)
    .join('\n      ');
}

renderSidebar();
renderPageTabs();

// ---------- Sidebar collapse ----------
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

// ---------- Sidebar accordion (Settings / System sub-menus) ----------
// Only one sub-menu is open at a time. Whichever section the current page
// belongs to starts open (computed above by renderSidebar()); clicking
// either top-level item toggles its own sub-menu and closes the other.
document.querySelectorAll('.nav-item.nav-toggle').forEach(item => {
  item.addEventListener('click', (e) => {
    e.preventDefault();
    const sub = item.nextElementSibling;
    if (!sub || !sub.classList.contains('nav-sub')) return;
    const wasOpen = sub.classList.contains('open');
    document.querySelectorAll('.nav-sub.open').forEach(s => s.classList.remove('open'));
    if (!wasOpen) sub.classList.add('open');
  });
});
