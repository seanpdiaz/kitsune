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
// belongs to starts open (baked into the HTML via the "open" class); clicking
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

// ---------- Library grid ----------
// Series data now lives in SQLite (the `series` table in server.js) instead
// of a hardcoded array here — see loadSeriesData() below, which fetches it
// once and feeds both this grid and the series detail page. This is what
// makes Add New's "Add Series" button (MyAnimeList search results) actually
// show up in the Library instead of just toggling a local checkmark.
let seriesData = [];

const badgeLabel = { airing: 'Airing', missing: 'Missing', downloading: 'Downloading', unmonitored: 'Unmonitored' };

const grid = document.getElementById('seriesGrid');
const filterTabs = document.getElementById('filterTabs');
const sortSelect = document.getElementById('sortSelect');
const librarySearch = document.getElementById('librarySearch');

const libraryState = { filter: 'all', sort: 'title', query: '' };

function matchesFilter(s, filter) {
  switch (filter) {
    case 'monitored': return s.monitored;
    case 'missing': return s.badge === 'missing';
    case 'continuing': return s.status === 'continuing';
    case 'ended': return s.status === 'ended';
    default: return true;
  }
}

function sortSeries(list, sort) {
  const sorted = list.slice();
  if (sort === 'next-airing') {
    sorted.sort((a, b) => {
      if (a.nextAirDays == null && b.nextAirDays == null) return a.title.localeCompare(b.title);
      if (a.nextAirDays == null) return 1;
      if (b.nextAirDays == null) return -1;
      return a.nextAirDays - b.nextAirDays;
    });
  } else if (sort === 'recently-added') {
    sorted.sort((a, b) => a.addedDaysAgo - b.addedDaysAgo);
  } else {
    sorted.sort((a, b) => a.title.localeCompare(b.title));
  }
  return sorted;
}

let seriesLoaded = false;
let seriesLoadError = false;

function renderGrid() {
  if (!grid) return;

  if (seriesLoadError) {
    grid.innerHTML = `<p style="color: var(--text-muted); grid-column: 1 / -1;">Couldn't load your library. Is the server running?</p>`;
    return;
  }
  if (!seriesLoaded) {
    grid.innerHTML = `<p style="color: var(--text-muted); grid-column: 1 / -1;">Loading…</p>`;
    return;
  }

  const query = libraryState.query.trim().toLowerCase();
  let list = seriesData.filter(s => matchesFilter(s, libraryState.filter));
  if (query) list = list.filter(s => s.title.toLowerCase().includes(query));
  list = sortSeries(list, libraryState.sort);

  if (list.length === 0) {
    grid.innerHTML = `<p style="color: var(--text-muted); grid-column: 1 / -1;">No series match your filters.</p>`;
    return;
  }

  grid.innerHTML = list.map(s => `
    <a class="series-card" href="series.html?id=${s.id}">
      <div class="poster">
        ${s.poster ? `<img src="${s.poster}" alt="${s.title} poster" loading="lazy" />` : ''}
        ${s.badge ? `<span class="badge ${s.badge}">${badgeLabel[s.badge]}</span>` : ''}
      </div>
      <div class="card-body">
        <p class="card-title">${s.title}</p>
        <div class="progress"><div class="fill ${s.fill}" style="width: ${s.pct}%;"></div></div>
      </div>
    </a>
  `).join('');
}

if (filterTabs) {
  filterTabs.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    filterTabs.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    libraryState.filter = btn.dataset.filter;
    renderGrid();
  });
}

if (sortSelect) {
  sortSelect.addEventListener('change', () => {
    libraryState.sort = sortSelect.value;
    renderGrid();
  });
}

if (librarySearch) {
  librarySearch.addEventListener('input', () => {
    libraryState.query = librarySearch.value;
    renderGrid();
  });
}

renderGrid(); // shows the "Loading…" state immediately; loadSeriesData() re-renders once the fetch resolves

// ---------- Series detail: episode list ----------
const icons = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 3v12M7 10l5 5 5-5M4 21h16"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  dots: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M6 4l14 8-14 8V4z"/></svg>',
};

const episodesBySegment = {
  '2': [
    { num: 21, title: 'Report from the capital', date: 'Feb 22', audio: 'Dual', quality: '1080p', state: 'done' },
    { num: 22, title: "A parting gift", date: 'Mar 1', audio: null, quality: null, state: 'pending' },
    { num: 20, title: "The journey's beginning", date: 'Feb 15', audio: null, quality: null, state: 'missing' },
    { num: 19, title: 'Aureole', date: 'Feb 8', audio: 'Dual', quality: '1080p', state: 'downloading', pct: 65 },
  ],
  '1': Array.from({ length: 5 }, (_, i) => ({
    num: i + 1, title: `Episode ${i + 1}`, date: `Sep ${29 + i}`, audio: 'Dual', quality: '1080p', state: 'done',
  })),
  'sp': [
    { num: 1, title: 'Special: memories of the journey', date: 'Dec 2023', audio: 'Sub', quality: '1080p', state: 'done' },
  ],
};

function escapeAttr(str) {
  return String(str).replace(/"/g, '&quot;');
}

// Real episodes (see buildRealEpisodeRows) can carry more than a title —
// MAL's own episode score, filler/recap flags, and Japanese/romanized
// titles, none of which the synthetic placeholder list ever has. Rendered
// as small inline badges/tooltip next to the title so the row layout itself
// doesn't need extra columns; synthetic episodes just don't have these
// fields, so nothing extra renders for them.
function episodeRowHtml(ep) {
  const rowClass = ep.state === 'missing' ? 'missing' : ep.state === 'downloading' ? 'downloading' : '';
  let status, action;
  if (ep.state === 'done') {
    status = `<span class="ep-status status-done">${icons.check}Downloaded</span>`;
    action = `<button class="ep-action" aria-label="Options">${icons.dots}</button>`;
  } else if (ep.state === 'missing') {
    status = `<span class="ep-status status-missing">${icons.alert}Missing</span>`;
    action = `<button class="ep-action" aria-label="Search episode">${icons.search}</button>`;
  } else if (ep.state === 'downloading') {
    status = `<span class="ep-status status-dl">${icons.download}${ep.pct}%</span>`;
    action = `<button class="ep-action" aria-label="Cancel download">${icons.x}</button>`;
  } else {
    status = `<span class="ep-status status-pending">${icons.clock}Not aired</span>`;
    action = `<button class="ep-action" aria-label="Search episode" disabled style="opacity:.4;">${icons.dots}</button>`;
  }

  const extraTags = [];
  if (ep.filler) extraTags.push('<span class="audio-tag" style="margin-left:6px; color:var(--warning);">Filler</span>');
  if (ep.recap) extraTags.push('<span class="audio-tag" style="margin-left:6px; color:var(--text-muted);">Recap</span>');
  if (typeof ep.score === 'number') extraTags.push(`<span class="audio-tag" style="margin-left:6px;">★ ${ep.score.toFixed(1)}</span>`);

  const altTitles = [ep.titleRomanji, ep.titleJapanese].filter((t) => t && t !== ep.title);
  const titleAttr = altTitles.length ? ` title="${escapeAttr(altTitles.join(' / '))}"` : '';

  return `
    <div class="ep-row ${rowClass}">
      <span class="ep-num">${ep.num}</span>
      <span class="ep-title"${titleAttr}>${ep.title}${extraTags.join('')}</span>
      <span class="ep-date">${ep.date || '—'}</span>
      <span>${ep.audio ? `<span class="audio-tag">${ep.audio}</span>` : '<span style="color:var(--text-muted);">—</span>'}</span>
      <span class="ep-date">${ep.quality || '—'}</span>
      ${status}
      ${action}
    </div>
  `;
}

// Frieren uses a hand-built multi-segment list (Season 2 / Season 1 / Specials)
// to demo the named-arc/season segment-tabs pattern. Every other series gets a
// flat list generated from its "downloaded / total" eps count instead — see
// buildGenericEpisodes below.
function renderEpisodes(segment) {
  const list = document.getElementById('episodeList');
  if (!list) return;
  const eps = episodesBySegment[segment] || [];
  list.innerHTML = eps.map(episodeRowHtml).join('');
}

function buildGenericEpisodes(series) {
  const m = /(\d+)\s*\/\s*(\d+)/.exec(series.eps || '');
  const downloaded = m ? parseInt(m[1], 10) : 0;
  const total = m ? parseInt(m[2], 10) : downloaded;
  const eps = [];
  for (let n = 1; n <= total; n++) {
    let state = 'pending';
    if (n <= downloaded) state = 'done';
    else if (n === downloaded + 1 && series.status === 'continuing') state = 'missing';
    eps.push({
      num: n,
      title: `Episode ${n}`,
      date: state === 'pending' ? 'TBA' : '—',
      audio: state === 'done' ? 'Dual' : null,
      quality: state === 'done' ? '1080p' : null,
      state,
    });
  }
  return eps;
}

function renderGenericEpisodes(series) {
  const list = document.getElementById('episodeList');
  if (!list) return;
  list.innerHTML = buildGenericEpisodes(series).map(episodeRowHtml).join('');
}

// Real episode titles/air dates, when available — fetched from
// GET /api/series/:id/episodes (server.js pulls these from TheTVDB, see the
// Episode persistence section there, already ordered season-then-num).
// Download state (done/missing/downloading/pending) still isn't something
// any metadata source knows about — that's still inferred from the series'
// "downloaded / total" eps count, same as buildGenericEpisodes, just paired
// with a real title and air date instead of "Episode N" and a placeholder.
//
// `position` (this episode's index in the full, already-season-ordered
// list) is what gets compared against the downloaded count, not `e.num` —
// episode numbers restart at 1 for every season, so comparing a season 2
// episode's raw num against a whole-series downloaded count would call
// half of season 2 "done" just because its number happens to be small.
function buildRealEpisodeRows(series, realEpisodes) {
  const epMatch = /(\d+)\s*\/\s*(\d+)/.exec(series.eps || '');
  const downloaded = epMatch ? parseInt(epMatch[1], 10) : 0;
  return realEpisodes.map((e, i) => {
    const position = i + 1;
    let state = 'pending';
    if (position <= downloaded) state = 'done';
    else if (e.aired) state = 'missing'; // TheTVDB says it's already aired, and we don't have it
    return {
      num: e.num,
      seasonNumber: e.seasonNumber ?? 0,
      seasonName: e.seasonName || null,
      title: e.title || `Episode ${e.num}`,
      titleJapanese: e.titleJapanese || null,
      titleRomanji: e.titleRomanji || null,
      date: e.aired || 'TBA',
      audio: state === 'done' ? 'Dual' : null,
      quality: state === 'done' ? '1080p' : null,
      score: typeof e.score === 'number' ? e.score : null,
      filler: !!e.filler,
      recap: !!e.recap,
      state,
    };
  });
}

// Groups already-built episode rows (see buildRealEpisodeRows, which
// carries seasonNumber/seasonName through) into per-season buckets, ordered
// Specials first (seasonNumber 0) then ascending — the same convention the
// hand-built Frieren demo above uses.
function groupEpisodesBySeason(rows) {
  const bySeason = new Map();
  for (const row of rows) {
    const key = row.seasonNumber ?? 0;
    if (!bySeason.has(key)) bySeason.set(key, { seasonNumber: key, seasonName: row.seasonName, rows: [] });
    bySeason.get(key).rows.push(row);
  }
  return Array.from(bySeason.values()).sort((a, b) => a.seasonNumber - b.seasonNumber);
}

function segmentLabel(group) {
  if (group.seasonNumber === 0) return 'Specials';
  return group.seasonName || `Season ${group.seasonNumber}`;
}

// Real TVDB-sourced episodes, split into tabs whenever a series actually
// has more than one season (specials + a main season, multiple cours,
// etc) — a flat single list otherwise, same as before season tracking
// existed. This is the generic counterpart to the hand-built Frieren demo
// (episodesBySegment/renderEpisodes above) — same segment-tabs container
// and CSS, just built dynamically from whatever seasons a given series
// actually has instead of 3 fixed keys.
function renderSegmentedRealEpisodes(series, realEpisodes) {
  const list = document.getElementById('episodeList');
  const segmentTabsEl = document.getElementById('segmentTabs');
  if (!list) return;

  const rows = buildRealEpisodeRows(series, realEpisodes);
  const groups = groupEpisodesBySeason(rows);

  if (groups.length <= 1 || !segmentTabsEl) {
    if (segmentTabsEl) segmentTabsEl.style.display = 'none';
    list.innerHTML = rows.map(episodeRowHtml).join('');
    return;
  }

  segmentTabsEl.style.display = '';
  // Default to the latest real season (matches the Frieren demo defaulting
  // to Season 2, its most recent) rather than always starting on Specials.
  const defaultGroup = groups.reduce((best, g) => (g.seasonNumber > best.seasonNumber ? g : best), groups[0]);
  segmentTabsEl.innerHTML = groups.map((g) => `
    <button data-season="${g.seasonNumber}" class="${g.seasonNumber === defaultGroup.seasonNumber ? 'active' : ''}">${segmentLabel(g)}</button>
  `).join('');

  function renderGroup(seasonNumber) {
    const group = groups.find((g) => g.seasonNumber === seasonNumber) || defaultGroup;
    list.innerHTML = group.rows.map(episodeRowHtml).join('');
  }

  segmentTabsEl.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    segmentTabsEl.querySelectorAll('button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    renderGroup(Number(btn.dataset.season));
  });

  renderGroup(defaultGroup.seasonNumber);
}

// Called after the synthetic list is already showing, so a slow or failed
// fetch just leaves that placeholder list up rather than blocking/blanking
// the page. Swaps in the real (possibly segmented) list only once real data
// actually comes back.
async function loadRealEpisodes(series) {
  const list = document.getElementById('episodeList');
  if (!list) return;
  try {
    const res = await fetch(`/api/series/${series.id}/episodes`);
    if (!res.ok) return;
    const body = await res.json();
    const real = body.episodes || [];
    if (real.length === 0) return; // nothing real for this series — synthetic list stays
    renderSegmentedRealEpisodes(series, real);
  } catch (err) {
    console.error('Failed to load real episode data:', err);
  }
}

// ---------- Series detail: header + routing ----------
// The page reads ?id= from the URL, looks the series up in seriesData, and
// fills in the header/stats/episode list for that specific series — this is
// what makes every card in the library link to its own detail page instead
// of always landing on Frieren. Actually rendering it is deferred to
// renderSeriesDetail(), called by loadSeriesData() below once the fetch
// resolves (seriesData starts empty, so this can't run synchronously here
// the way it used to when seriesData was a hardcoded array).
const detailTitleEl = document.getElementById('detailTitle');

function renderSeriesDetail() {
  if (!detailTitleEl) return;
  const params = new URLSearchParams(window.location.search);
  const requestedId = Number(params.get('id'));
  const series = seriesData.find(s => s.id === requestedId) || seriesData[0];
  if (!series) return; // library is empty — nothing to show

  document.title = `Kitsune — ${series.title}`;
  detailTitleEl.textContent = series.title;

  const metaEl = document.getElementById('detailMeta');
  if (metaEl) metaEl.textContent = series.meta || '';

  const overviewEl = document.getElementById('detailOverview');
  if (overviewEl) overviewEl.textContent = series.overview || 'No overview available yet.';

  const posterEl = document.getElementById('detailPoster');
  if (posterEl) posterEl.innerHTML = series.poster ? `<img src="${series.poster}" alt="${series.title} poster" />` : '';

  const monitorInput = document.querySelector('.monitor-toggle input');
  if (monitorInput) {
    monitorInput.checked = series.monitored;
    monitorInput.addEventListener('change', () => {
      fetch(`/api/series/${series.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ monitored: monitorInput.checked }),
      }).catch(() => {}); // best-effort; mockup, no retry UI
    });
  }

  const statVals = document.querySelectorAll('.detail-stats .value');
  const epMatch = /(\d+)\s*\/\s*(\d+)/.exec(series.eps || '');
  const downloadedCount = epMatch ? parseInt(epMatch[1], 10) : 0;
  if (statVals[0]) statVals[0].textContent = series.eps;
  if (statVals[1]) statVals[1].textContent = 'HD-1080p';
  if (statVals[2]) statVals[2].textContent = downloadedCount > 0 ? `${(downloadedCount * 0.47).toFixed(1)} GB` : '0 GB';
  if (statVals[3]) statVals[3].textContent = series.nextAirDays != null ? `in ${series.nextAirDays}d` : '—';

  const segmentTabsEl = document.getElementById('segmentTabs');
  if (series.title === 'Frieren') {
    if (segmentTabsEl) {
      segmentTabsEl.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (!btn) return;
        segmentTabsEl.querySelectorAll('button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        renderEpisodes(btn.dataset.segment);
      });
      renderEpisodes('2');
    }
  } else {
    if (segmentTabsEl) segmentTabsEl.style.display = 'none';
    renderGenericEpisodes(series);
    loadRealEpisodes(series);
  }

  // Delete: a confirmation modal (reusing the same modal pattern as the Tags
  // page) sits between the button and the actual DELETE request, since this
  // is the one destructive, unrecoverable action on this page.
  const deleteBtn = document.getElementById('deleteSeriesBtn');
  const deleteModal = document.getElementById('deleteSeriesModal');
  const deleteModalText = document.getElementById('deleteSeriesModalText');
  const deleteModalClose = document.getElementById('deleteSeriesModalClose');
  const deleteModalCancel = document.getElementById('deleteSeriesModalCancel');
  const deleteModalConfirm = document.getElementById('deleteSeriesModalConfirm');

  function closeDeleteModal() {
    if (deleteModal) deleteModal.classList.remove('open');
  }

  if (deleteBtn && deleteModal) {
    deleteBtn.addEventListener('click', () => {
      if (deleteModalText) {
        deleteModalText.textContent = `Are you sure you want to delete "${series.title}"? This can't be undone.`;
      }
      deleteModal.classList.add('open');
    });
  }
  if (deleteModalClose) deleteModalClose.addEventListener('click', closeDeleteModal);
  if (deleteModalCancel) deleteModalCancel.addEventListener('click', closeDeleteModal);
  if (deleteModal) {
    deleteModal.addEventListener('click', (e) => {
      if (e.target === deleteModal) closeDeleteModal(); // click on the dim overlay itself
    });
  }
  if (deleteModalConfirm) {
    deleteModalConfirm.addEventListener('click', async () => {
      deleteModalConfirm.disabled = true;
      deleteModalConfirm.textContent = 'Deleting…';
      try {
        const res = await fetch(`/api/series/${series.id}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        window.location.href = 'index.html';
      } catch (err) {
        console.error('Failed to delete series:', err);
        deleteModalConfirm.disabled = false;
        deleteModalConfirm.textContent = 'Delete';
        if (deleteModalText) {
          deleteModalText.textContent = "Couldn't delete this series — try again.";
        }
      }
    });
  }
}

// ---------- Fetch the Library once, then render whichever page needs it ----------
async function loadSeriesData() {
  if (!grid && !detailTitleEl) return; // this page doesn't use series data at all
  try {
    const res = await fetch('/api/series');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    seriesData = await res.json();
    seriesLoaded = true;
  } catch (err) {
    console.error('Failed to load /api/series:', err);
    seriesLoadError = true;
  }
  if (grid) renderGrid();
  if (detailTitleEl) renderSeriesDetail();
}

loadSeriesData();

// ---------- Settings: Indexers & Download clients ----------
// Both pages are lists of "connections" (name, protocol, a meta column, priority,
// enabled toggle, test, remove) plus an add-type panel. Shared logic, separate data.

const indexerTypes = [
  { key: 'tokyotosho', name: 'TokyoTosho', protocol: 'Torrent', meta: 'Anime' },
  { key: 'anirena', name: 'Anirena', protocol: 'Torrent', meta: 'Anime' },
  { key: 'shanaproject', name: 'Shana Project', protocol: 'Torrent', meta: 'Anime (RSS)' },
];

const downloadClientTypes = [
  { key: 'deluge', name: 'Deluge', protocol: 'Torrent', meta: '—' },
  { key: 'nzbget', name: 'NZBGet', protocol: 'Usenet', meta: '—' },
  { key: 'rtorrent', name: 'rTorrent', protocol: 'Torrent', meta: '—' },
];

// Backed by /api/settings-items/:section (see server.js) instead of an
// in-memory array — data starts empty and is loaded from the DB on init, the
// same pattern Tags established. The "types" lists above stay static; they're
// just the template choices offered in the add-from-type panel, not saved state.
function initConnectionManager({ listId, addBtnId, panelId, section, types }) {
  const list = document.getElementById(listId);
  if (!list) return;
  const addBtn = document.getElementById(addBtnId);
  const panel = document.getElementById(panelId);
  let data = [];

  function statusPill(item) {
    if (!item.enabled) return `<span class="status-pill status-off">Disabled</span>`;
    if (item.status === 'ok') return `<span class="status-pill status-on">${icons.check}Connected</span>`;
    if (item.status === 'fail') return `<span class="status-pill status-fail">${icons.alert}Failed</span>`;
    return `<span class="status-pill status-pending">Untested</span>`;
  }

  function render() {
    if (data.length === 0) {
      list.innerHTML = `<p class="settings-empty">None configured yet.</p>`;
      return;
    }
    list.innerHTML = data.map(item => `
      <div class="settings-row" data-id="${item.id}">
        <div class="settings-name">
          <p class="settings-title">${item.name}</p>
          <span class="audio-tag">${item.protocol}</span>
        </div>
        <span class="settings-meta">${item.meta}</span>
        <span class="settings-meta">${item.priority}</span>
        ${statusPill(item)}
        <label class="switch">
          <input type="checkbox" ${item.enabled ? 'checked' : ''} data-action="toggle" />
          <span class="slider"></span>
        </label>
        <button class="btn-test" type="button" data-action="test">Test</button>
        <button class="ep-action" type="button" data-action="remove" aria-label="Remove ${item.name}">${icons.x}</button>
      </div>
    `).join('');
  }

  async function loadData() {
    list.innerHTML = `<p class="settings-empty">Loading…</p>`;
    try {
      const res = await fetch(`/api/settings-items/${section}`);
      data = await res.json();
    } catch {
      data = [];
    }
    render();
  }

  list.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    const row = e.target.closest('.settings-row');
    if (!row) return;
    const item = data.find(d => d.id === Number(row.dataset.id));
    if (!item) return;

    if (actionEl.dataset.action === 'remove') {
      data.splice(data.indexOf(item), 1);
      render();
      fetch(`/api/settings-items/${section}/${item.id}`, { method: 'DELETE' }).catch(() => {});
    } else if (actionEl.dataset.action === 'test') {
      if (actionEl.disabled) return;
      actionEl.disabled = true;
      actionEl.textContent = 'Testing…';
      setTimeout(() => {
        // Demo behavior: entries already flagged as failing stay flagged, everything
        // else that's enabled comes back healthy.
        item.status = item.status === 'fail' ? 'fail' : 'ok';
        render();
        fetch(`/api/settings-items/${section}/${item.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: item.status }),
        }).catch(() => {});
      }, 700);
    }
  });

  list.addEventListener('change', (e) => {
    if (e.target.dataset.action !== 'toggle') return;
    const row = e.target.closest('.settings-row');
    const item = data.find(d => d.id === Number(row.dataset.id));
    if (!item) return;
    item.enabled = e.target.checked;
    render();
    fetch(`/api/settings-items/${section}/${item.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: item.enabled }),
    }).catch(() => {});
  });

  if (addBtn && panel) {
    panel.innerHTML = `<p class="add-panel-label">Choose a type to add</p>` +
      types.map(t => `<button type="button" class="type-chip" data-key="${t.key}">${t.name}</button>`).join('');

    addBtn.addEventListener('click', () => panel.classList.toggle('open'));

    panel.addEventListener('click', async (e) => {
      const chip = e.target.closest('.type-chip');
      if (!chip) return;
      const type = types.find(t => t.key === chip.dataset.key);
      if (!type) return;
      panel.classList.remove('open');
      const newFields = { name: type.name, protocol: type.protocol, meta: type.meta, priority: 25, enabled: false, status: 'pending' };
      try {
        const res = await fetch(`/api/settings-items/${section}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newFields),
        });
        data.push(await res.json());
      } catch {
        data.push({ id: data.length ? Math.max(...data.map(d => d.id)) + 1 : 1, ...newFields });
      }
      render();
    });
  }

  loadData();
}

initConnectionManager({ listId: 'indexerList', addBtnId: 'addIndexerBtn', panelId: 'addIndexerPanel', section: 'indexers', types: indexerTypes });
initConnectionManager({ listId: 'clientList', addBtnId: 'addClientBtn', panelId: 'addClientPanel', section: 'download-clients', types: downloadClientTypes });

// ---------- Settings: Import Lists & Connect ----------
// Same shape as Indexers/Download Clients (enable, test, remove, add-from-type), just
// different data and column meanings (wired up via each page's own header labels).

const importListTypes = [
  { key: 'simkl', name: 'Simkl', protocol: 'Auto add', meta: '/anime/wanted' },
  { key: 'customrss', name: 'Custom RSS List', protocol: 'Auto add', meta: '/anime/wanted' },
  { key: 'imdb', name: 'IMDb List', protocol: 'Auto add', meta: '/anime/wanted' },
];

const connectTypes = [
  { key: 'pushover', name: 'Pushover', protocol: 'API', meta: 'On Import' },
  { key: 'slack', name: 'Slack', protocol: 'Webhook', meta: 'On Import' },
  { key: 'plex', name: 'Plex', protocol: 'API', meta: 'On Import' },
  { key: 'gotify', name: 'Gotify', protocol: 'API', meta: 'On Import' },
];

initConnectionManager({ listId: 'importListList', addBtnId: 'addImportListBtn', panelId: 'addImportListPanel', section: 'import-lists', types: importListTypes });
initConnectionManager({ listId: 'connectList', addBtnId: 'addConnectBtn', panelId: 'addConnectPanel', section: 'connect', types: connectTypes });

// ---------- Settings: Profiles & Custom Formats ----------
// Lighter-weight list manager: name + a couple of metadata columns, edit (visual only)
// and remove, plus an add-from-type panel. No live status/test — these aren't connections.

// Backed by /api/settings-items/:section, same as initConnectionManager above —
// data loads from the DB on init instead of starting from a hardcoded array.
function initSimpleList({ listId, addBtnId, panelId, section, types, rowTemplate, newItem }) {
  const list = document.getElementById(listId);
  if (!list) return;
  const addBtn = document.getElementById(addBtnId);
  const panel = document.getElementById(panelId);
  let data = [];

  function render() {
    if (data.length === 0) {
      list.innerHTML = `<p class="settings-empty">None configured yet.</p>`;
      return;
    }
    list.innerHTML = data.map(rowTemplate).join('');
  }

  async function loadData() {
    list.innerHTML = `<p class="settings-empty">Loading…</p>`;
    try {
      const res = await fetch(`/api/settings-items/${section}`);
      data = await res.json();
    } catch {
      data = [];
    }
    render();
  }

  list.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl || actionEl.dataset.action !== 'remove') return;
    const row = e.target.closest('[data-id]');
    if (!row) return;
    const item = data.find(d => d.id === Number(row.dataset.id));
    if (!item) return;
    data.splice(data.indexOf(item), 1);
    render();
    fetch(`/api/settings-items/${section}/${item.id}`, { method: 'DELETE' }).catch(() => {});
  });

  if (addBtn && panel && types) {
    panel.innerHTML = `<p class="add-panel-label">Choose a type to add</p>` +
      types.map(t => `<button type="button" class="type-chip" data-key="${t.key}">${t.name}</button>`).join('');
    addBtn.addEventListener('click', () => panel.classList.toggle('open'));
    panel.addEventListener('click', async (e) => {
      const chip = e.target.closest('.type-chip');
      if (!chip) return;
      const type = types.find(t => t.key === chip.dataset.key);
      if (!type) return;
      panel.classList.remove('open');
      const newFields = newItem(type);
      try {
        const res = await fetch(`/api/settings-items/${section}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newFields),
        });
        data.push(await res.json());
      } catch {
        data.push({ id: data.length ? Math.max(...data.map(d => d.id)) + 1 : 1, ...newFields });
      }
      render();
    });
  }

  loadData();
}

const profileTypes = [
  { key: 'blank', name: 'Blank profile' },
  { key: 'copy-hd1080p', name: 'Copy: HD-1080p' },
  { key: 'copy-dual', name: 'Copy: Anime - Dual Audio' },
];

function profileRow(item) {
  return `
    <div class="profile-row" data-id="${item.id}">
      <p class="settings-title">${item.name}</p>
      <span class="settings-meta">${item.cutoff}</span>
      <span class="settings-meta">${item.qualities}</span>
      <span class="settings-meta">${item.upgrades ? 'Upgrades allowed' : 'No upgrades'}</span>
      <button class="ep-action" type="button" data-action="edit" aria-label="Edit ${item.name}">${icons.edit}</button>
      <button class="ep-action" type="button" data-action="remove" aria-label="Remove ${item.name}">${icons.x}</button>
    </div>
  `;
}

initSimpleList({
  listId: 'profileList', addBtnId: 'addProfileBtn', panelId: 'addProfilePanel',
  section: 'profiles', types: profileTypes, rowTemplate: profileRow,
  newItem: (type) => ({ name: type.name, cutoff: 'SDTV', qualities: '1 of 12', upgrades: true }),
});

const formatTypes = [
  { key: 'hi10p', name: 'Hi10p' },
  { key: 'bd-menu', name: 'BD Menu/Extras' },
  { key: 'v0-vbr', name: 'V0 (VBR)' },
];

function formatRow(item) {
  return `
    <div class="format-row" data-id="${item.id}">
      <p class="settings-title">${item.name}</p>
      <span class="count-badge">${item.conditions} condition${item.conditions === 1 ? '' : 's'}</span>
      <span class="count-badge">used in ${item.profiles} profile${item.profiles === 1 ? '' : 's'}</span>
      <button class="ep-action" type="button" data-action="edit" aria-label="Edit ${item.name}">${icons.edit}</button>
      <button class="ep-action" type="button" data-action="remove" aria-label="Remove ${item.name}">${icons.x}</button>
    </div>
  `;
}

initSimpleList({
  listId: 'formatList', addBtnId: 'addFormatBtn', panelId: 'addFormatPanel',
  section: 'custom-formats', types: formatTypes, rowTemplate: formatRow,
  newItem: (type) => ({ name: type.name, conditions: 0, profiles: 0 }),
});

// ---------- Settings: Tags ----------
// Backed by a real API (/api/tags) instead of an in-memory array — this is
// the first section wired up to server.js's SQLite-backed persistence. Tags
// also carry a color now (rename + recolor via PATCH /api/tags/:id).

const TAG_COLORS = [
  { hex: '#f2703d', name: 'Orange' },
  { hex: '#3ed598', name: 'Green' },
  { hex: '#4d8df6', name: 'Blue' },
  { hex: '#a78bfa', name: 'Purple' },
  { hex: '#f472b6', name: 'Pink' },
  { hex: '#ed5b65', name: 'Red' },
  { hex: '#f2b705', name: 'Yellow' },
  { hex: '#2dd4bf', name: 'Teal' },
  { hex: '#9c9da8', name: 'Gray' },
];

function hexToRgbParts(hex) {
  const clean = String(hex || '').replace('#', '');
  const n = parseInt(clean.length === 6 ? clean : 'f2703d', 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function tagChipStyle(hex) {
  const { r, g, b } = hexToRgbParts(hex);
  return `background: rgba(${r},${g},${b},0.16); color: ${hex}; border-color: rgba(${r},${g},${b},0.45);`;
}

function initTagManager({
  cloudId, pageErrorId, addBtnId,
  modalId, modalTitleId, modalCloseId, modalNameId, modalColorsId,
  modalCustomColorId, modalErrorId, modalCancelId, modalSaveId,
}) {
  const cloud = document.getElementById(cloudId);
  if (!cloud) return;
  const pageErrorEl = document.getElementById(pageErrorId);
  const addBtn = document.getElementById(addBtnId);
  const modal = document.getElementById(modalId);
  const modalTitle = document.getElementById(modalTitleId);
  const modalClose = document.getElementById(modalCloseId);
  const modalName = document.getElementById(modalNameId);
  const modalColors = document.getElementById(modalColorsId);
  const modalCustomColor = document.getElementById(modalCustomColorId);
  const modalError = document.getElementById(modalErrorId);
  const modalCancel = document.getElementById(modalCancelId);
  const modalSave = document.getElementById(modalSaveId);

  let tags = [];
  let mode = 'create'; // 'create' | 'edit'
  let editingId = null;
  let selectedColor = TAG_COLORS[0].hex;

  function showPageError(message) {
    if (!pageErrorEl) return;
    pageErrorEl.textContent = message || '';
    pageErrorEl.classList.toggle('is-collapsed', !message);
  }

  function showModalError(message) {
    if (!modalError) return;
    modalError.textContent = message || '';
    modalError.classList.toggle('is-collapsed', !message);
  }

  function isPreset(hex) {
    return TAG_COLORS.some(c => c.hex.toLowerCase() === String(hex).toLowerCase());
  }

  // Default color for a brand-new tag: pick randomly among whichever preset
  // colors are currently used least, so new tags don't keep landing on the
  // same color (or clash with colors already in heavy use), but the exact
  // pick still varies rather than always cycling in a fixed order.
  function pickRandomTagColor() {
    const usage = {};
    TAG_COLORS.forEach(c => { usage[c.hex] = 0; });
    tags.forEach(t => {
      const hex = String(t.color || '').toLowerCase();
      const match = TAG_COLORS.find(c => c.hex.toLowerCase() === hex);
      if (match) usage[match.hex] += 1;
    });
    const minCount = Math.min(...TAG_COLORS.map(c => usage[c.hex]));
    const leastUsed = TAG_COLORS.filter(c => usage[c.hex] === minCount);
    const pick = leastUsed[Math.floor(Math.random() * leastUsed.length)];
    return pick.hex;
  }

  function renderModalSwatches() {
    if (!modalColors) return;
    const presetHtml = TAG_COLORS.map(c => `
      <button type="button" class="color-swatch${c.hex === selectedColor ? ' selected' : ''}"
        style="background:${c.hex};" data-color="${c.hex}" aria-label="${c.name}">
        ${c.hex === selectedColor ? `<span class="swatch-check">${icons.check}</span>` : ''}
      </button>
    `).join('');
    const customSelected = !isPreset(selectedColor);
    const addHtml = `
      <button type="button" class="color-swatch-add${customSelected ? ' has-custom' : ''}"
        style="${customSelected ? `background:${selectedColor}; border-color:${selectedColor};` : ''}"
        id="tagCustomColorTrigger" aria-label="Custom color">
        ${customSelected
          ? `<span class="swatch-check">${icons.check}</span>`
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>'}
      </button>
    `;
    modalColors.innerHTML = presetHtml + addHtml;
    modalColors.querySelectorAll('.color-swatch').forEach(btn => {
      btn.addEventListener('click', () => { selectedColor = btn.dataset.color; renderModalSwatches(); });
    });
    const customTrigger = document.getElementById('tagCustomColorTrigger');
    if (customTrigger && modalCustomColor) {
      customTrigger.addEventListener('click', () => modalCustomColor.click());
    }
  }

  if (modalCustomColor) {
    modalCustomColor.addEventListener('input', () => {
      selectedColor = modalCustomColor.value;
      renderModalSwatches();
    });
  }

  function render() {
    if (tags.length === 0) {
      cloud.innerHTML = `<p class="settings-empty">No tags yet.</p>`;
      return;
    }
    cloud.innerHTML = tags.map(tag => `
      <span class="tag-chip" data-id="${tag.id}" style="${tagChipStyle(tag.color)}">
        ${tag.name}<span class="tag-count">${tag.count}</span>
        <button type="button" data-action="edit" aria-label="Edit ${tag.name}">${icons.edit}</button>
        <button type="button" data-action="remove" aria-label="Remove ${tag.name}">${icons.x}</button>
      </span>
    `).join('');
  }

  async function loadTags() {
    cloud.innerHTML = `<p class="settings-empty">Loading tags…</p>`;
    try {
      const res = await fetch('/api/tags');
      if (!res.ok) throw new Error('Request failed: ' + res.status);
      tags = await res.json();
      render();
    } catch (err) {
      cloud.innerHTML = `<p class="settings-empty">Couldn't load tags. Is the server running with SQLite support (Node 22.5+)?</p>`;
    }
  }

  function openModal(nextMode, tag) {
    mode = nextMode;
    editingId = tag ? tag.id : null;
    selectedColor = tag ? tag.color : pickRandomTagColor();
    if (modalTitle) modalTitle.textContent = mode === 'edit' ? 'Edit Tag' : 'Create New Tag';
    if (modalSave) modalSave.textContent = 'Save';
    if (modalName) modalName.value = tag ? tag.name : '';
    showModalError('');
    renderModalSwatches();
    if (modal) modal.classList.add('open');
    if (modalName) modalName.focus();
  }

  function closeModal() {
    if (modal) modal.classList.remove('open');
    editingId = null;
  }

  if (addBtn) addBtn.addEventListener('click', () => openModal('create'));
  if (modalClose) modalClose.addEventListener('click', closeModal);
  if (modalCancel) modalCancel.addEventListener('click', closeModal);
  if (modal) {
    modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal && modal.classList.contains('open')) closeModal();
  });

  cloud.addEventListener('click', async (e) => {
    const editBtn = e.target.closest('[data-action="edit"]');
    if (editBtn) {
      const chip = e.target.closest('.tag-chip');
      const tag = tags.find(t => t.id === Number(chip.dataset.id));
      if (tag) openModal('edit', tag);
      return;
    }

    const removeBtn = e.target.closest('[data-action="remove"]');
    if (!removeBtn) return;
    const chip = e.target.closest('.tag-chip');
    const id = Number(chip.dataset.id);
    showPageError('');
    removeBtn.disabled = true;
    try {
      const res = await fetch(`/api/tags/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed: ' + res.status);
      tags = tags.filter(t => t.id !== id);
      if (editingId === id) closeModal();
      render();
    } catch (err) {
      showPageError('Could not remove that tag — try again.');
      removeBtn.disabled = false;
    }
  });

  if (modalSave) {
    modalSave.addEventListener('click', async () => {
      const name = (modalName && modalName.value.trim()) || '';
      showModalError('');
      if (!name) {
        showModalError('Tag name is required.');
        return;
      }
      modalSave.disabled = true;
      try {
        const isEdit = mode === 'edit' && editingId != null;
        const res = await fetch(isEdit ? `/api/tags/${editingId}` : '/api/tags', {
          method: isEdit ? 'PATCH' : 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, color: selectedColor }),
        });
        const body = await res.json();
        if (res.status === 409) {
          // Casing is preserved but duplicates are matched case-insensitively,
          // so show the name as it's actually stored, not just what was typed.
          showModalError(`"${body.tag ? body.tag.name : name}" already exists.`);
          return;
        }
        if (!res.ok) throw new Error('Save failed: ' + res.status);
        if (isEdit) {
          const idx = tags.findIndex(t => t.id === editingId);
          if (idx > -1) tags[idx] = body;
        } else {
          tags.push(body);
        }
        closeModal();
        render();
      } catch (err) {
        showModalError('Could not save that tag — try again.');
      } finally {
        modalSave.disabled = false;
      }
    });
  }

  loadTags();
}

initTagManager({
  cloudId: 'tagCloud', pageErrorId: 'tagPageError', addBtnId: 'addTagBtn',
  modalId: 'tagModal', modalTitleId: 'tagModalTitle', modalCloseId: 'tagModalClose',
  modalNameId: 'tagModalName', modalColorsId: 'tagModalColors',
  modalCustomColorId: 'tagModalCustomColor', modalErrorId: 'tagModalError',
  modalCancelId: 'tagModalCancel', modalSaveId: 'tagModalSave',
});

// Lets the tag cloud be scaled up via a slider — the page felt sparse with
// only small chips, so this is a purely visual/local preference (remembered
// per-browser via localStorage, same pattern as the sidebar collapse toggle).
function initTagSizeSlider(sliderId, cloudId) {
  const slider = document.getElementById(sliderId);
  const cloud = document.getElementById(cloudId);
  if (!slider || !cloud) return;

  function applyScale(value) {
    cloud.style.setProperty('--tag-scale', value);
    const min = Number(slider.min);
    const max = Number(slider.max);
    const pct = ((value - min) / (max - min)) * 100;
    slider.style.background = `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pct}%, var(--surface-3) ${pct}%, var(--surface-3) 100%)`;
  }

  const saved = Number(localStorage.getItem('kitsune-tag-size'));
  const initial = saved && saved >= Number(slider.min) && saved <= Number(slider.max) ? saved : 1;
  slider.value = initial;
  applyScale(initial);

  slider.addEventListener('input', () => {
    const value = Number(slider.value);
    applyScale(value);
    localStorage.setItem('kitsune-tag-size', String(value));
  });
}

initTagSizeSlider('tagSizeSlider', 'tagCloud');

// ---------- Settings: cascading show/hide for dependent fields ----------
// Used by Media Management (rename toggle, permissions toggle) and General
// (auth method, proxy toggle) to reveal/dim fields that only matter when a
// parent toggle or select has a particular value.

function wireToggleCascade(toggleId, targetSelector) {
  const toggle = document.getElementById(toggleId);
  if (!toggle) return;
  const targets = document.querySelectorAll(targetSelector);
  function apply() { targets.forEach(t => t.classList.toggle('is-disabled', !toggle.checked)); }
  toggle.addEventListener('change', apply);
  apply();
}

function wireSelectCascade(selectId, showMap) {
  const select = document.getElementById(selectId);
  if (!select) return;
  const allTargets = new Set();
  Object.values(showMap).forEach(sel => document.querySelectorAll(sel).forEach(el => allTargets.add(el)));
  function apply() {
    const activeSel = showMap[select.value];
    allTargets.forEach(el => el.classList.add('is-collapsed'));
    if (activeSel) document.querySelectorAll(activeSel).forEach(el => el.classList.remove('is-collapsed'));
  }
  select.addEventListener('change', apply);
  apply();
}

wireToggleCascade('renameEpisodesToggle', '.naming-field');
wireToggleCascade('setPermissionsToggle', '.permissions-field');
wireSelectCascade('authMethodSelect', { basic: '.auth-field', forms: '.auth-field' });
wireToggleCascade('proxyEnabledToggle', '.proxy-field');
wireToggleCascade('metaKodiToggle', '.meta-field-kodi');
wireToggleCascade('metaRoksboxToggle', '.meta-field-roksbox');
wireToggleCascade('metaWdtvToggle', '.meta-field-wdtv');

// ---------- Settings: field/toggle-style pages ----------
// Media Management, General, UI, Metadata, and Quality are all "one settings
// object" pages rather than lists — every persistable control on them carries
// a data-key attribute (added in a one-time pass over the HTML: existing ids
// like renameEpisodesToggle were reused as-is, everything else got a
// positional key like "general-3"). initSettingsForm loads the saved
// { key: value } object from /api/app-settings/:section, applies it to
// matching controls, and PATCHes changes back — batched/debounced so rapid
// edits (typing, several toggles in a row) don't fire a request per keystroke.
// This runs independently of wireToggleCascade/wireSelectCascade above; both
// can listen on the same element without conflict.
function initSettingsForm(section) {
  const fields = [...document.querySelectorAll('input[data-key], select[data-key]')];
  if (fields.length === 0) return;

  function getValue(el) {
    if (el.type === 'checkbox') return el.checked;
    if (el.type === 'number') return el.value === '' ? null : Number(el.value);
    return el.value;
  }

  function setValue(el, value) {
    if (value === undefined || value === null) return;
    if (el.type === 'checkbox') el.checked = Boolean(value);
    else el.value = value;
  }

  let pendingPatch = {};
  let saveTimer = null;
  function queueSave(partial) {
    Object.assign(pendingPatch, partial);
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      const body = pendingPatch;
      pendingPatch = {};
      fetch(`/api/app-settings/${section}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      }).catch(() => {});
    }, 400);
  }

  (async () => {
    let saved = {};
    try {
      const res = await fetch(`/api/app-settings/${section}`);
      saved = await res.json();
    } catch {
      saved = {};
    }

    const firstVisitDefaults = {};
    fields.forEach((el) => {
      const key = el.dataset.key;
      if (Object.prototype.hasOwnProperty.call(saved, key)) {
        setValue(el, saved[key]);
      } else {
        // Nothing saved for this field yet — persist the HTML's own default
        // value so the DB has a starting point, same as Tags seeding itself.
        firstVisitDefaults[key] = getValue(el);
      }
      const eventName = (el.tagName === 'SELECT' || el.type === 'checkbox') ? 'change' : 'input';
      el.addEventListener(eventName, () => queueSave({ [key]: getValue(el) }));
    });
    if (Object.keys(firstVisitDefaults).length > 0) queueSave(firstVisitDefaults);
  })();
}

// app.js is shared by every page, and initSettingsForm's [data-key] selector
// isn't scoped to a section — so each call is guarded behind a marker element
// that only exists on that one page. Without the guard, e.g. calling
// initSettingsForm('general') on the Media Management page would find the
// same mm-* fields and start saving them to the wrong section.
if (document.getElementById('renameEpisodesToggle')) initSettingsForm('media-management');
if (document.getElementById('authMethodSelect')) initSettingsForm('general');
if (document.querySelector('[data-key^="ui-"]')) initSettingsForm('ui');
if (document.getElementById('metaKodiToggle')) initSettingsForm('metadata');
if (document.querySelector('.quality-row')) initSettingsForm('quality');

// ---------- Settings: Root Folders (Media Management) ----------
// Backed by /api/settings-items/root-folders, same pattern as the lists above.

// Server-side directory browser behind "Add Root Folder" — matches the
// modal a real Sonarr install shows: type a path or click through real
// folders on the machine running the server, Cancel/Ok. Backed by
// GET /api/fs/browse (see server.js), which does the actual fs.readdirSync
// on whatever path it's given.
function initFileBrowserModal({ modalId, closeId, pathInputId, listId, errorId, cancelId, okId, onConfirm }) {
  const modal = document.getElementById(modalId);
  if (!modal) return null;
  const pathInput = document.getElementById(pathInputId);
  const list = document.getElementById(listId);
  const errorEl = document.getElementById(errorId);
  const closeBtn = document.getElementById(closeId);
  const cancelBtn = document.getElementById(cancelId);
  const okBtn = document.getElementById(okId);

  const folderIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h4l2-2h6l2 2h4v12H3z"/></svg>';
  let currentPath = '/';

  function showError(message) {
    if (!errorEl) return;
    errorEl.textContent = message || '';
    errorEl.classList.toggle('is-collapsed', !message);
  }

  async function browse(targetPath) {
    showError('');
    list.innerHTML = `<div class="file-browser-row" style="cursor:default;"><span></span><span>Loading…</span></div>`;
    try {
      const res = await fetch(`/api/fs/browse?path=${encodeURIComponent(targetPath)}`);
      const body = await res.json();
      if (!res.ok) {
        showError(body.error || `Couldn't open "${targetPath}"`);
        list.innerHTML = '';
        return;
      }
      currentPath = body.path;
      if (pathInput) pathInput.value = currentPath;
      const rows = [];
      if (body.parent) {
        rows.push(`
          <div class="file-browser-row parent-row" data-path="${escapeAttr(body.parent)}">
            ${folderIcon}<span>..</span>
          </div>
        `);
      }
      for (const name of body.folders) {
        const childPath = currentPath.endsWith('/') ? `${currentPath}${name}` : `${currentPath}/${name}`;
        rows.push(`
          <div class="file-browser-row" data-path="${escapeAttr(childPath)}">
            ${folderIcon}<span>${name}</span>
          </div>
        `);
      }
      list.innerHTML = rows.length
        ? rows.join('')
        : `<div class="file-browser-row" style="cursor:default;"><span></span><span style="color:var(--text-muted);">No subfolders</span></div>`;
    } catch {
      showError('Could not reach the server.');
      list.innerHTML = '';
    }
  }

  list.addEventListener('click', (e) => {
    const row = e.target.closest('.file-browser-row[data-path]');
    if (!row) return;
    browse(row.dataset.path);
  });

  if (pathInput) {
    pathInput.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      browse(pathInput.value.trim() || '/');
    });
  }

  function close() {
    modal.classList.remove('open');
  }

  if (closeBtn) closeBtn.addEventListener('click', close);
  if (cancelBtn) cancelBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) close();
  });

  if (okBtn) {
    okBtn.addEventListener('click', async () => {
      const chosen = (pathInput && pathInput.value.trim()) || currentPath;
      if (!chosen) {
        showError('Enter a path.');
        return;
      }
      okBtn.disabled = true;
      okBtn.textContent = 'Adding…';
      try {
        await onConfirm(chosen);
        close();
      } catch (err) {
        showError(err.message || 'Could not add that folder.');
      } finally {
        okBtn.disabled = false;
        okBtn.textContent = 'Ok';
      }
    });
  }

  return {
    open() {
      showError('');
      modal.classList.add('open');
      browse(currentPath);
    },
  };
}

function initRootFolders(listId, addBtnId, section) {
  const list = document.getElementById(listId);
  if (!list) return;
  const addBtn = document.getElementById(addBtnId);
  let data = [];

  function render() {
    if (data.length === 0) {
      list.innerHTML = `<p class="settings-empty">No root folders configured.</p>`;
      return;
    }
    list.innerHTML = data.map(f => `
      <div class="settings-row" style="grid-template-columns: 1fr 130px 160px 32px;" data-id="${f.id}">
        <span class="settings-title">${f.path}</span>
        <span class="settings-meta">${f.free}</span>
        <span class="settings-meta">${f.unmapped} unmapped</span>
        <button class="ep-action" type="button" data-action="remove" aria-label="Remove ${f.path}">${icons.x}</button>
      </div>
    `).join('');
  }

  async function loadData() {
    list.innerHTML = `<p class="settings-empty">Loading…</p>`;
    try {
      const res = await fetch(`/api/settings-items/${section}`);
      data = await res.json();
    } catch {
      data = [];
    }
    render();
  }

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="remove"]');
    if (!btn) return;
    const row = e.target.closest('[data-id]');
    const id = Number(row.dataset.id);
    const idx = data.findIndex(f => f.id === id);
    if (idx > -1) data.splice(idx, 1);
    render();
    fetch(`/api/settings-items/${section}/${id}`, { method: 'DELETE' }).catch(() => {});
  });

  // POST /api/root-folders (not the generic /api/settings-items/root-folders
  // used above for load/remove) — this one actually validates the path on
  // disk and computes real free-space/unmapped-folder numbers server-side,
  // see handleRootFoldersApi in server.js.
  const browser = initFileBrowserModal({
    modalId: 'fileBrowserModal', closeId: 'fileBrowserModalClose', pathInputId: 'fileBrowserPathInput',
    listId: 'fileBrowserList', errorId: 'fileBrowserError', cancelId: 'fileBrowserModalCancel', okId: 'fileBrowserModalOk',
    onConfirm: async (chosenPath) => {
      const res = await fetch('/api/root-folders', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: chosenPath }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      data.push(body);
      render();
    },
  });

  if (addBtn && browser) {
    addBtn.addEventListener('click', () => browser.open());
  }

  loadData();
}

initRootFolders('rootFolderList', 'addRootFolderBtn', 'root-folders');

// ---------- System: Tasks ----------

const tasksData = [
  { id: 1, name: 'RSS Sync', interval: 'Every 15 minutes', lastRun: '4 minutes ago', nextRun: 'in 11 minutes' },
  { id: 2, name: 'Check for Finished Downloads', interval: 'Every 1 minute', lastRun: '38 seconds ago', nextRun: 'in 22 seconds' },
  { id: 3, name: 'Refresh Series', interval: 'Every 12 hours', lastRun: '3 hours ago', nextRun: 'in 9 hours' },
  { id: 4, name: 'Update Metadata Cache', interval: 'Every 12 hours', lastRun: '5 hours ago', nextRun: 'in 7 hours' },
  { id: 5, name: 'Backup', interval: 'Every 7 days', lastRun: '2 days ago', nextRun: 'in 5 days' },
  { id: 6, name: 'Application Update Check', interval: 'Every 6 hours', lastRun: '1 hour ago', nextRun: 'in 5 hours' },
  { id: 7, name: 'Housekeeping', interval: 'Every 24 hours', lastRun: '14 hours ago', nextRun: 'in 10 hours' },
];

function initTaskList(listId) {
  const list = document.getElementById(listId);
  if (!list) return;

  function render() {
    list.innerHTML = tasksData.map(t => `
      <div class="task-row" data-id="${t.id}">
        <p class="settings-title">${t.name}</p>
        <span class="settings-meta">${t.interval}</span>
        <span class="settings-meta">${t.lastRun}</span>
        <span class="settings-meta">${t.nextRun}</span>
        <button class="btn-test" type="button" data-action="run">Run Now</button>
      </div>
    `).join('');
  }

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="run"]');
    if (!btn || btn.disabled) return;
    const row = e.target.closest('[data-id]');
    const task = tasksData.find(t => t.id === Number(row.dataset.id));
    if (!task) return;
    btn.disabled = true;
    btn.textContent = 'Running…';
    setTimeout(() => {
      task.lastRun = 'Just now';
      render();
    }, 700);
  });

  render();
}

initTaskList('taskList');

// ---------- System: Backup ----------

const backupsData = [
  { id: 1, type: 'Scheduled', name: 'kitsune_backup_2026.08.03_030000.zip', size: '8.4 MB', date: 'Aug 3, 2026 03:00' },
  { id: 2, type: 'Scheduled', name: 'kitsune_backup_2026.07.27_030000.zip', size: '8.2 MB', date: 'Jul 27, 2026 03:00' },
  { id: 3, type: 'Manual', name: 'kitsune_backup_manual_2026.07.20.zip', size: '8.1 MB', date: 'Jul 20, 2026 14:32' },
  { id: 4, type: 'Scheduled', name: 'kitsune_backup_2026.07.20_030000.zip', size: '8.1 MB', date: 'Jul 20, 2026 03:00' },
];

function initBackupList(listId, addBtnId) {
  const list = document.getElementById(listId);
  if (!list) return;
  const addBtn = document.getElementById(addBtnId);

  function render() {
    if (backupsData.length === 0) {
      list.innerHTML = `<p class="settings-empty">No backups yet.</p>`;
      return;
    }
    list.innerHTML = backupsData.map(b => `
      <div class="backup-row" data-id="${b.id}">
        <span class="audio-tag">${b.type}</span>
        <span class="settings-title">${b.name}</span>
        <span class="settings-meta">${b.size}</span>
        <span class="settings-meta">${b.date}</span>
        <button class="btn-test" type="button" data-action="restore">Restore</button>
        <button class="ep-action" type="button" data-action="remove" aria-label="Delete ${b.name}">${icons.x}</button>
      </div>
    `).join('');
  }

  list.addEventListener('click', (e) => {
    const actionEl = e.target.closest('[data-action]');
    if (!actionEl) return;
    const row = e.target.closest('[data-id]');
    const item = backupsData.find(b => b.id === Number(row.dataset.id));
    if (!item) return;
    if (actionEl.dataset.action === 'remove') {
      backupsData.splice(backupsData.indexOf(item), 1);
      render();
    }
    // 'restore' is a visual affordance only in this mockup
  });

  if (addBtn) {
    addBtn.addEventListener('click', () => {
      const nextId = backupsData.length ? Math.max(...backupsData.map(b => b.id)) + 1 : 1;
      backupsData.unshift({
        id: nextId,
        type: 'Manual',
        name: `kitsune_backup_manual_${nextId}.zip`,
        size: '8.4 MB',
        date: 'Just now',
      });
      render();
    });
  }

  render();
}

initBackupList('backupList', 'backupNowBtn');

// ---------- System: Events ----------

const eventsData = [
  { id: 1, time: '14:32:08', level: 'Grab', message: 'Sent "Chainsaw Man - 011 - Rescue [WEBDL-1080p]" to qBittorrent' },
  { id: 2, time: '14:28:51', level: 'Import', message: 'Imported Frieren S02E21 "Report from the Capital"' },
  { id: 3, time: '14:10:03', level: 'Health', message: 'Indexer AniDex test failed: connection timed out' },
  { id: 4, time: '13:55:44', level: 'Import List', message: 'Sync completed for "Anichart — Seasonal"' },
  { id: 5, time: '13:40:12', level: 'Series Added', message: 'Added "Bocchi the Rock" to library' },
  { id: 6, time: '13:12:09', level: 'Health', message: 'Download client SABnzbd unreachable' },
  { id: 7, time: '12:58:37', level: 'Grab', message: 'Sent "Jujutsu Kaisen - S02E22" to qBittorrent' },
];

const eventLevelClass = {
  Grab: 'status-info', Import: 'status-on', Health: 'status-warn',
  'Import List': 'status-info', 'Series Added': 'status-on',
};

function initEventFeed(listId, clearBtnId) {
  const list = document.getElementById(listId);
  if (!list) return;
  const clearBtn = document.getElementById(clearBtnId);

  function render() {
    if (eventsData.length === 0) {
      list.innerHTML = `<p class="settings-empty">No events yet.</p>`;
      return;
    }
    list.innerHTML = eventsData.map(e => `
      <div class="event-row">
        <span class="ep-date">${e.time}</span>
        <span class="status-pill ${eventLevelClass[e.level] || 'status-off'}">${e.level}</span>
        <span class="settings-meta">${e.message}</span>
      </div>
    `).join('');
  }

  if (clearBtn) {
    clearBtn.addEventListener('click', () => {
      eventsData.length = 0;
      render();
    });
  }

  render();
}

initEventFeed('eventList', 'clearEventsBtn');

// ---------- System: Logs ----------
// Backed by /api/logs (see the Logging section in server.js) instead of a
// static array — every log call the server makes (HTTP requests, MAL/TVDB
// search attempts, series added/deleted, tag/settings changes, etc.) shows
// up here. Polls every 4s so it feels like a live tail without needing a
// websocket for a personal-use mockup.

const logLevelClass = { Info: 'status-info', Warn: 'status-warn', Error: 'status-fail', Debug: 'status-off' };

function initLogTable(listId, filterId) {
  const list = document.getElementById(listId);
  if (!list) return;
  const filterTabs = document.getElementById(filterId);
  let level = 'all';
  let pollTimer = null;

  async function load() {
    try {
      const res = await fetch(`/api/logs?level=${encodeURIComponent(level)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const rows = await res.json();
      render(rows);
    } catch (err) {
      console.error('Failed to load logs:', err);
      list.innerHTML = `<p class="settings-empty">Couldn't load logs. Is the server running?</p>`;
    }
  }

  function render(rows) {
    if (rows.length === 0) {
      list.innerHTML = `<p class="settings-empty">No log entries at this level.</p>`;
      return;
    }
    list.innerHTML = rows.map(l => `
      <div class="log-row">
        <span class="ep-date">${l.time}</span>
        <span class="status-pill ${logLevelClass[l.level] || 'status-off'}">${l.level}</span>
        <span class="settings-meta">${l.logger}</span>
        <span class="settings-meta">${l.message}</span>
      </div>
    `).join('');
  }

  if (filterTabs) {
    filterTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      filterTabs.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      level = btn.dataset.level;
      load();
    });
  }

  load();
  pollTimer = setInterval(load, 4000);
  window.addEventListener('beforeunload', () => clearInterval(pollTimer));
}

initLogTable('logList', 'logFilterTabs');

// ---------- Library: Add New ----------
// Results come live from MyAnimeList's official API through our own
// /api/mal/search proxy — see handleMalApi in server.js. Anime-only by
// nature, unlike the TVDB search this replaced, which surfaced any kind of
// TV series. Debounced so we're not firing a request on every keystroke.

async function initAddNew(gridId, searchId) {
  const grid = document.getElementById(gridId);
  if (!grid) return;
  const search = document.getElementById(searchId);
  const addedIds = new Set();

  let results = [];
  let state = 'idle'; // 'idle' | 'loading' | 'ok' | 'empty' | 'error'
  let errorMessage = '';
  let requestSeq = 0;
  let debounceTimer = null;

  // A real Library check for search results, so a title that's already been
  // added shows that *before* you click Add Series instead of only failing
  // after (see the 409 handling in addSeries below, which is the real
  // enforcement — this index is just what makes the UI honest about it up
  // front). Keyed two ways: exact (source, id) match — the same MAL/TVDB
  // result added twice — and a loose title match, since re-searching after
  // adding via one source can turn up the same show from the other source
  // with a different id.
  let libraryIndex = { byExternal: new Map(), byTitle: new Map() };
  async function loadLibraryIndex() {
    try {
      const res = await fetch('/api/series');
      const rows = await res.json();
      const byExternal = new Map();
      const byTitle = new Map();
      for (const row of rows) {
        if (row.externalSource && row.externalId) byExternal.set(`${row.externalSource}:${row.externalId}`, row);
        if (row.title) byTitle.set(row.title.trim().toLowerCase(), row);
      }
      libraryIndex = { byExternal, byTitle };
    } catch {
      // Leave libraryIndex empty — worst case, someone clicks "Add Series"
      // on something already in the Library and the server's own 409 check
      // catches it instead of the UI pre-empting it.
    }
  }
  function libraryMatchFor(s) {
    const byExternal = s.source && s.id !== undefined ? libraryIndex.byExternal.get(`${s.source}:${s.id}`) : null;
    if (byExternal) return byExternal;
    const title = String(s.title || '').trim().toLowerCase();
    return (title && libraryIndex.byTitle.get(title)) || null;
  }

  function previewTag(label) {
    return `<span class="preview-tag">${label}</span>`;
  }

  // The detail modal's content — everything here is optional per-result
  // (see mapMalOfficialResult/mapTvdbResult in server.js), so each piece
  // only renders when the result actually has it instead of showing empty
  // labels.
  function previewBodyHtml(s) {
    const tags = [];
    if (s.mediaType) tags.push(previewTag(s.mediaType.toUpperCase()));
    if (s.status) tags.push(previewTag(s.status.replace(/_/g, ' ')));
    if (typeof s.numEpisodes === 'number') tags.push(previewTag(`${s.numEpisodes} episodes`));
    if (typeof s.score === 'number') tags.push(previewTag(`★ ${s.score.toFixed(2)}`));
    (s.genres || []).forEach((g) => tags.push(previewTag(g)));

    const altBits = [];
    if (s.altTitleJapanese) altBits.push(`<p><strong>Japanese:</strong> ${s.altTitleJapanese}</p>`);
    if (s.altTitleSynonyms && s.altTitleSynonyms.length) altBits.push(`<p><strong>Also known as:</strong> ${s.altTitleSynonyms.join(', ')}</p>`);
    if (s.studios && s.studios.length) altBits.push(`<p><strong>Studio:</strong> ${s.studios.join(', ')}</p>`);

    const sourceNote = s.source === 'tvdb'
      ? `<p class="preview-source-note">via TheTVDB (MyAnimeList unavailable)</p>`
      : '';

    return `
      <div class="preview-poster">${s.poster ? `<img src="${s.poster}" alt="${s.title} poster" />` : ''}</div>
      <div class="preview-details">
        <h3>${s.title}${s.year ? ` <span style="color:var(--text-muted); font-weight:500;">(${s.year})</span>` : ''}</h3>
        ${tags.length ? `<div class="preview-meta-row">${tags.join('')}</div>` : ''}
        <p class="preview-overview">${s.overview || 'No overview available.'}</p>
        ${altBits.length ? `<div class="preview-alt-titles">${altBits.join('')}</div>` : ''}
        ${sourceNote}
      </div>
    `;
  }

  function cardHtml(s) {
    // Normally every result is source: 'mal'. If the official API was down
    // and the server fell back to TVDB (see handleMalApi in server.js),
    // results come back tagged source: 'tvdb' instead — flag that on the
    // card so it's clear where the data came from during a MAL outage, not
    // just silently different.
    const sourceBadge = s.source === 'tvdb'
      ? `<span style="color:var(--text-muted); font-weight:500;"> · via TheTVDB (MAL unavailable)</span>`
      : '';
    const id = String(s.id);
    let actionHtml;
    if (addedIds.has(id)) {
      actionHtml = `<div class="card-added">${icons.check}Added</div>`;
    } else {
      const already = libraryMatchFor(s);
      actionHtml = already
        ? `<div class="card-added" title="Already in your Library as &quot;${escapeAttr(already.title)}&quot;">${icons.check}In Library</div>`
        : `<button class="btn-accent" type="button" data-action="add">Add Series</button>`;
    }
    return `
      <div class="series-card" data-id="${s.id}">
        <div class="poster">${s.poster ? `<img src="${s.poster}" alt="${s.title} poster" loading="lazy" />` : ''}</div>
        <div class="card-body">
          <p class="card-title">${s.title} ${s.year ? `<span style="color:var(--text-muted); font-weight:500;">(${s.year})</span>` : ''}${sourceBadge}</p>
          <p class="card-overview">${s.overview || 'No overview available.'}</p>
          <div class="card-actions">
            <button type="button" data-action="preview">Preview</button>
            ${actionHtml}
          </div>
        </div>
      </div>
    `;
  }

  function render() {
    if (state === 'idle') {
      grid.innerHTML = `<p class="settings-empty">Search for a series above to see results from MyAnimeList.</p>`;
    } else if (state === 'loading') {
      grid.innerHTML = `<p class="settings-empty">Searching MyAnimeList…</p>`;
    } else if (state === 'error') {
      grid.innerHTML = `<p class="settings-empty">Couldn't load results: ${errorMessage}</p>`;
    } else if (state === 'empty') {
      grid.innerHTML = `<p class="settings-empty">No results.</p>`;
    } else {
      grid.innerHTML = results.map(cardHtml).join('');
    }
  }

  async function runSearch(q) {
    const seq = ++requestSeq;
    state = 'loading';
    render();
    try {
      const res = await fetch(`/api/mal/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (seq !== requestSeq) return; // a newer keystroke superseded this request
      if (!res.ok) {
        state = 'error';
        errorMessage = (data && data.error) || `HTTP ${res.status}`;
        render();
        return;
      }
      results = data;
      state = results.length === 0 ? 'empty' : 'ok';
      render();
    } catch (err) {
      if (seq !== requestSeq) return;
      state = 'error';
      errorMessage = 'network error';
      render();
    }
  }

  function onSearchInput() {
    clearTimeout(debounceTimer);
    const q = (search.value || '').trim();
    if (!q) {
      requestSeq++; // invalidate any in-flight request
      state = 'idle';
      render();
      return;
    }
    debounceTimer = setTimeout(() => runSearch(q), 400);
  }

  // Shared by the card's own "Add Series" button and the preview modal's —
  // same request, same duplicate handling, so the two entry points can't
  // drift apart.
  async function addSeries(match, btn) {
    const id = String(match.id);
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Adding…';
    try {
      const res = await fetch('/api/series', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: match.title,
          year: match.year,
          overview: match.overview,
          poster: match.poster,
          id: match.id,
          source: match.source,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.status === 409) {
        // Someone/something beat us to it — another tab, or our own
        // pre-check above missed it. Fold it into libraryIndex so this
        // result (and any other card for the same show) immediately shows
        // "In Library" instead of a live "Add Series" button that would
        // just 409 again.
        if (body.existingId) {
          libraryIndex.byExternal.set(`${match.source}:${match.id}`, { id: body.existingId, title: match.title });
          libraryIndex.byTitle.set(match.title.trim().toLowerCase(), { id: body.existingId, title: match.title });
        }
        render();
        updatePreviewAddBtn();
        return;
      }
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      // This is the part that actually lands the series in the Library —
      // without this POST, clicking Add Series only ever changed local
      // button state on this page and nothing else.
      addedIds.add(id);
      render();
      updatePreviewAddBtn();
    } catch (err) {
      console.error('Failed to add series:', err);
      btn.disabled = false;
      btn.textContent = originalText;
      btn.title = "Couldn't add this series — try again.";
    }
  }

  grid.addEventListener('click', async (e) => {
    const previewBtn = e.target.closest('[data-action="preview"]');
    if (previewBtn) {
      const card = e.target.closest('[data-id]');
      const match = results.find(r => String(r.id) === String(card.dataset.id));
      if (match) openPreview(match);
      return;
    }
    const btn = e.target.closest('[data-action="add"]');
    if (!btn) return;
    const card = e.target.closest('[data-id]');
    // Always compare as strings, regardless of whether the source API's id
    // came back as a number or a string — HTML data-* attributes are always
    // strings, and a past mismatch here (Number() on one side, raw id on the
    // other) meant "Added" could never match and the button looked dead.
    const match = results.find(r => String(r.id) === String(card.dataset.id));
    if (!match) return;
    await addSeries(match, btn);
  });

  // ---------- Preview modal ----------

  const previewModal = document.getElementById('seriesPreviewModal');
  const previewBody = document.getElementById('seriesPreviewBody');
  const previewAddBtn = document.getElementById('seriesPreviewAddBtn');
  let previewedResult = null;

  function updatePreviewAddBtn() {
    if (!previewAddBtn || !previewedResult) return;
    if (addedIds.has(String(previewedResult.id))) {
      previewAddBtn.textContent = 'Added';
      previewAddBtn.disabled = true;
    } else if (libraryMatchFor(previewedResult)) {
      previewAddBtn.textContent = 'In Library';
      previewAddBtn.disabled = true;
    } else {
      previewAddBtn.textContent = 'Add Series';
      previewAddBtn.disabled = false;
    }
  }

  function openPreview(s) {
    if (!previewModal || !previewBody) return;
    previewedResult = s;
    previewBody.innerHTML = previewBodyHtml(s);
    updatePreviewAddBtn();
    previewModal.classList.add('open');
  }
  function closePreview() {
    if (!previewModal) return;
    previewModal.classList.remove('open');
    previewedResult = null;
  }

  if (previewModal) {
    const closeBtn = document.getElementById('seriesPreviewClose');
    const cancelBtn = document.getElementById('seriesPreviewCancel');
    if (closeBtn) closeBtn.addEventListener('click', closePreview);
    if (cancelBtn) cancelBtn.addEventListener('click', closePreview);
    previewModal.addEventListener('click', (e) => { if (e.target === previewModal) closePreview(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && previewModal.classList.contains('open')) closePreview();
    });
  }
  if (previewAddBtn) {
    previewAddBtn.addEventListener('click', () => {
      if (!previewedResult || previewAddBtn.disabled) return;
      addSeries(previewedResult, previewAddBtn);
    });
  }

  if (search) search.addEventListener('input', onSearchInput);

  await loadLibraryIndex();

  // Arriving here with ?q=<title> (e.g. from Library Import's "Search on Add
  // New" link for an unmatched root-folder subfolder) pre-fills the search
  // box and runs it immediately, instead of making the user retype the
  // title it already guessed from the folder name.
  const prefillQuery = new URLSearchParams(window.location.search).get('q');
  if (search && prefillQuery) {
    search.value = prefillQuery;
    runSearch(prefillQuery.trim());
    return;
  }

  render();
}

initAddNew('addNewGrid', 'addNewSearch');

// ---------- Library: Library Import ----------

// Real scan across every configured root folder (Settings > Media
// Management > Root Folders), via GET /api/root-folders/:id/subfolders —
// each root folder's real subdirectories, flagged as already matching a
// Library series ('existing') or not ('unmatched'). There's no third
// "auto-matched, ready to one-click import" state: Kitsune doesn't
// auto-suggest MAL matches for folder names (by design — see README), so an
// unmatched folder always routes to Add New's real search instead of being
// silently imported against a guess.
function initLibraryImport(listId, rescanBtnId) {
  const list = document.getElementById(listId);
  if (!list) return;
  const rescanBtn = document.getElementById(rescanBtnId);

  const folderIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 7h4l2-2h6l2 2h4v12H3z"/></svg>';
  let items = [];
  let state = 'loading'; // 'loading' | 'ok' | 'no-root-folders' | 'error'
  let errorMessage = '';

  function statusCell(item) {
    if (item.status === 'existing') {
      return `<span class="status-pill status-off">${icons.check}Already in Library</span>`;
    }
    return `<a class="status-pill status-warn" href="library-add-new.html?q=${encodeURIComponent(item.guessedTitle)}">${icons.search}Search</a>`;
  }

  function render() {
    if (state === 'loading') {
      list.innerHTML = `<p class="settings-empty">Scanning root folders…</p>`;
    } else if (state === 'no-root-folders') {
      list.innerHTML = `<p class="settings-empty">No root folders configured yet — add one under Settings &gt; Media Management.</p>`;
    } else if (state === 'error') {
      list.innerHTML = `<p class="settings-empty">Couldn't scan root folders: ${errorMessage}</p>`;
    } else if (items.length === 0) {
      list.innerHTML = `<p class="settings-empty">Nothing found — every folder in your root folders is already in the Library.</p>`;
    } else {
      list.innerHTML = items.map(item => `
        <div class="import-row">
          <span style="color:var(--text-muted); display:flex; align-items:center;">${folderIcon}</span>
          <span class="settings-title">${item.path}</span>
          <span class="settings-meta">${item.matchedTitle || item.guessedTitle}</span>
          ${statusCell(item)}
        </div>
      `).join('');
    }
  }

  async function scan() {
    state = 'loading';
    render();
    if (rescanBtn) {
      rescanBtn.disabled = true;
      rescanBtn.textContent = 'Scanning…';
    }
    try {
      const rootFoldersRes = await fetch('/api/settings-items/root-folders');
      const rootFolders = await rootFoldersRes.json();
      if (!Array.isArray(rootFolders) || rootFolders.length === 0) {
        items = [];
        state = 'no-root-folders';
        render();
        return;
      }
      const perFolder = await Promise.all(rootFolders.map(async (rf) => {
        try {
          const res = await fetch(`/api/root-folders/${rf.id}/subfolders`);
          if (!res.ok) return [];
          const body = await res.json();
          return Array.isArray(body.subfolders) ? body.subfolders : [];
        } catch {
          return [];
        }
      }));
      items = perFolder.flat();
      state = 'ok';
      render();
    } catch {
      state = 'error';
      errorMessage = 'network error';
      render();
    } finally {
      if (rescanBtn) {
        rescanBtn.disabled = false;
        rescanBtn.textContent = 'Rescan';
      }
    }
  }

  if (rescanBtn) rescanBtn.addEventListener('click', scan);

  scan();
}

initLibraryImport('importList', 'rescanFoldersBtn');

// ---------- Activity: Queue ----------

const queueData = [
  { id: 1, series: 'Chainsaw Man', ep: 'S01E12', quality: 'WEBDL-1080p', size: '1.2 GB', pct: 72, status: 'downloading' },
  { id: 2, series: 'Jujutsu Kaisen', ep: 'S02E23', quality: 'WEBDL-1080p', size: '1.1 GB', pct: 34, status: 'downloading' },
  { id: 3, series: 'Solo Leveling', ep: 'S01E07', quality: 'WEBDL-1080p', size: '980 MB', pct: 12, status: 'paused' },
  { id: 4, series: 'Frieren', ep: 'S02E22', quality: 'WEBDL-1080p', size: '1.0 GB', pct: 0, status: 'queued' },
  { id: 5, series: 'Demon Slayer', ep: 'S01E06', quality: 'WEBDL-1080p', size: '890 MB', pct: 0, status: 'warning' },
];

const queueStatusClass = { downloading: 'status-info', paused: 'status-off', queued: 'status-pending', warning: 'status-warn' };
const queueStatusLabel = { downloading: 'Downloading', paused: 'Paused', queued: 'Queued', warning: 'Warning' };

function initQueue(listId) {
  const list = document.getElementById(listId);
  if (!list) return;
  let items = queueData.map(q => ({ ...q }));

  function render() {
    if (items.length === 0) {
      list.innerHTML = `<p class="settings-empty">Queue is empty.</p>`;
      return;
    }
    list.innerHTML = items.map(q => {
      const pauseDisabled = q.status === 'queued' || q.status === 'warning';
      return `
      <div class="queue-row" data-id="${q.id}">
        <div>
          <p class="settings-title">${q.series}</p>
          <span class="settings-meta">${q.ep}</span>
        </div>
        <span class="audio-tag">${q.quality}</span>
        <span class="settings-meta">${q.size}</span>
        <div class="queue-progress">
          <div class="progress"><div class="fill ${q.status === 'warning' ? 'warning' : 'accent'}" style="width:${q.pct}%;"></div></div>
          <span class="progress-label">${q.pct}%</span>
        </div>
        <span class="status-pill ${queueStatusClass[q.status]}">${queueStatusLabel[q.status]}</span>
        <button class="ep-action" type="button" data-action="toggle-pause" ${pauseDisabled ? 'disabled style="opacity:.35;"' : ''} aria-label="${q.status === 'paused' ? 'Resume' : 'Pause'} ${q.series}">${q.status === 'paused' ? icons.play : icons.pause}</button>
        <button class="ep-action" type="button" data-action="remove" aria-label="Remove ${q.series} from queue">${icons.x}</button>
      </div>
    `;
    }).join('');
  }

  list.addEventListener('click', (e) => {
    const row = e.target.closest('[data-id]');
    if (!row) return;
    const item = items.find(i => i.id === Number(row.dataset.id));
    if (!item) return;
    if (e.target.closest('[data-action="remove"]')) {
      items = items.filter(i => i.id !== item.id);
      render();
    } else if (e.target.closest('[data-action="toggle-pause"]')) {
      const btn = e.target.closest('[data-action="toggle-pause"]');
      if (btn.disabled) return;
      if (item.status === 'downloading') item.status = 'paused';
      else if (item.status === 'paused') item.status = 'downloading';
      render();
    }
  });

  render();
}

initQueue('queueList');

// ---------- Activity: History ----------

const historyData = [
  { id: 1, time: '2 hours ago', type: 'Imported', message: 'Frieren S02E21 "Report from the Capital" — WEBDL-1080p' },
  { id: 2, time: '3 hours ago', type: 'Grabbed', message: 'Chainsaw Man S01E12 — SubsPlease RSS' },
  { id: 3, time: '5 hours ago', type: 'Failed', message: 'Demon Slayer S01E06 — sample file detected' },
  { id: 4, time: '1 day ago', type: 'Imported', message: 'Jujutsu Kaisen S02E22 — Bluray-1080p' },
  { id: 5, time: '2 days ago', type: 'Deleted', message: 'Vinland Saga S01E01 — removed manually' },
  { id: 6, time: '3 days ago', type: 'Grabbed', message: 'Bocchi the Rock S01E01 — Nyaa.si' },
];

const historyTypeClass = { Grabbed: 'status-info', Imported: 'status-on', Failed: 'status-fail', Deleted: 'status-off' };

function initHistory(listId, filterId) {
  const list = document.getElementById(listId);
  if (!list) return;
  const filterTabs = document.getElementById(filterId);
  let type = 'all';

  function render() {
    const rows = type === 'all' ? historyData : historyData.filter(h => h.type.toLowerCase() === type);
    if (rows.length === 0) {
      list.innerHTML = `<p class="settings-empty">No history for this filter.</p>`;
      return;
    }
    list.innerHTML = rows.map(h => `
      <div class="event-row">
        <span class="ep-date">${h.time}</span>
        <span class="status-pill ${historyTypeClass[h.type] || 'status-off'}">${h.type}</span>
        <span class="settings-meta">${h.message}</span>
      </div>
    `).join('');
  }

  if (filterTabs) {
    filterTabs.addEventListener('click', (e) => {
      const btn = e.target.closest('button');
      if (!btn) return;
      filterTabs.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      type = btn.dataset.type;
      render();
    });
  }

  render();
}

initHistory('historyList', 'historyFilterTabs');

// ---------- Activity: Blocklist ----------

const blocklistData = [
  { id: 1, release: '[SubsGroup] Demon Slayer - 06 [1080p][Bad-Sample].mkv', series: 'Demon Slayer', reason: 'Failed download', indexer: 'SubsPlease RSS', date: '5 hours ago' },
  { id: 2, release: 'Jujutsu.Kaisen.S02E24.INTERNAL.1080p.WEB.H264-BADENC', series: 'Jujutsu Kaisen', reason: 'Failed download', indexer: 'AnimeBytes', date: '2 days ago' },
  { id: 3, release: 'Chainsaw.Man.S01.BATCH.Fake.Repack', series: 'Chainsaw Man', reason: 'Manually blocklisted', indexer: 'Nyaa.si', date: '4 days ago' },
];

function initBlocklist(listId) {
  const list = document.getElementById(listId);
  if (!list) return;
  let items = blocklistData.map(b => ({ ...b }));

  function render() {
    if (items.length === 0) {
      list.innerHTML = `<p class="settings-empty">Blocklist is empty.</p>`;
      return;
    }
    list.innerHTML = items.map(b => `
      <div class="blocklist-row" data-id="${b.id}">
        <span class="settings-title">${b.release}</span>
        <span class="settings-meta">${b.series}</span>
        <span class="settings-meta">${b.reason}</span>
        <span class="audio-tag">${b.indexer}</span>
        <span class="ep-date">${b.date}</span>
        <button class="ep-action" type="button" data-action="remove" aria-label="Remove from blocklist">${icons.x}</button>
      </div>
    `).join('');
  }

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="remove"]');
    if (!btn) return;
    const row = e.target.closest('[data-id]');
    items = items.filter(i => i.id !== Number(row.dataset.id));
    render();
  });

  render();
}

initBlocklist('blocklistList');

// ---------- Wanted: Missing & Cutoff Unmet ----------
// Both are lists of episodes with a "Search" action; Cutoff Unmet adds current
// vs. target quality columns. Shared search-flash behavior, separate rendering.

// Episodes here deliberately exclude anything already sitting in the Activity
// queue (queueData) — an episode that's actively downloading/paused/queued
// isn't "missing", it's "in progress". See Chainsaw Man/Demon Slayer/JJK S02E23
// in queueData for the counterparts to what's NOT listed here.
const missingData = [
  { id: 1, series: 'Solo Leveling', ep: 'S01E08', title: 'If I Had One More Chance', date: 'Feb 3' },
  { id: 2, series: 'Solo Leveling', ep: 'S01E09', title: 'This Should Be Enough', date: 'Feb 10' },
  { id: 3, series: 'Solo Leveling', ep: 'S01E10', title: "I'll Get Stronger", date: 'Feb 17' },
  { id: 4, series: 'Jujutsu Kaisen', ep: 'S02E24', title: 'Right and Wrong', date: 'Feb 20' },
  { id: 5, series: 'Jujutsu Kaisen', ep: 'S02E25', title: 'Whatever Comes Next', date: 'Feb 27' },
];

const cutoffData = [
  { id: 1, series: 'Mushoku Tensei', ep: 'S01E10', title: 'Reunion, and Then...', current: 'WEBDL-720p', cutoff: 'WEBDL-1080p' },
  { id: 2, series: 'Vinland Saga', ep: 'S01E15', title: 'Warrior of Iron and Wood', current: 'HDTV-1080p', cutoff: 'Bluray-1080p' },
  { id: 3, series: 'Spy x Family', ep: 'S01E08', title: 'The Item Smuggler', current: 'WEBDL-720p', cutoff: 'WEBDL-1080p' },
];

function missingRow(ep) {
  return `
    <div class="missing-row" data-id="${ep.id}">
      <span class="settings-title">${ep.series}</span>
      <span class="settings-meta">${ep.ep} - ${ep.title}</span>
      <span class="ep-date">${ep.date}</span>
      <button class="btn-test" type="button" data-action="search">Search</button>
    </div>
  `;
}

function cutoffRow(ep) {
  return `
    <div class="cutoff-row" data-id="${ep.id}">
      <span class="settings-title">${ep.series}</span>
      <span class="settings-meta">${ep.ep} - ${ep.title}</span>
      <span class="audio-tag">${ep.current}</span>
      <span class="audio-tag" style="color:var(--accent); background:var(--accent-bg);">${ep.cutoff}</span>
      <button class="btn-test" type="button" data-action="search">Search</button>
    </div>
  `;
}

function initEpisodeSearchList({ listId, searchAllId, emptyText, data, rowTemplate }) {
  const list = document.getElementById(listId);
  if (!list) return;
  const searchAllBtn = document.getElementById(searchAllId);

  function render() {
    if (data.length === 0) {
      list.innerHTML = `<p class="settings-empty">${emptyText}</p>`;
      return;
    }
    list.innerHTML = data.map(rowTemplate).join('');
  }

  list.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action="search"]');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Searching…';
    setTimeout(() => {
      btn.disabled = false;
      btn.textContent = original;
    }, 700);
  });

  if (searchAllBtn) {
    searchAllBtn.addEventListener('click', () => {
      if (searchAllBtn.disabled) return;
      const buttons = list.querySelectorAll('[data-action="search"]');
      buttons.forEach(b => { b.disabled = true; });
      searchAllBtn.disabled = true;
      const original = searchAllBtn.textContent;
      searchAllBtn.textContent = 'Searching…';
      setTimeout(() => {
        buttons.forEach(b => { b.disabled = false; });
        searchAllBtn.disabled = false;
        searchAllBtn.textContent = original;
      }, 900);
    });
  }

  render();
}

initEpisodeSearchList({
  listId: 'missingList', searchAllId: 'missingSearchAllBtn',
  emptyText: 'No missing episodes.', data: missingData, rowTemplate: missingRow,
});
initEpisodeSearchList({
  listId: 'cutoffList', searchAllId: 'cutoffSearchAllBtn',
  emptyText: 'Nothing below cutoff.', data: cutoffData, rowTemplate: cutoffRow,
});
