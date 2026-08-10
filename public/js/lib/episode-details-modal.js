import { icons, escapeAttr } from './icons.js';
import { formatBytes } from './format.js';

// ---------------------------------------------------------------------------
// Episode details modal — clicking an episode's title in the series detail
// page's episode list opens this instead of doing nothing, the way it used
// to. A mockup of "here's everything real about this one episode" rather
// than a real Sonarr-style file-info panel: air date, the quality it was
// actually downloaded at (or the fact that it hasn't been), its on-disk
// path, and its file size — all of which already exist as real per-episode
// data by this point (see server/routes/episodes.js's `episodes` table and
// server/lib/episode-paths.js for how `path` gets filled in for episodes
// that were never really downloaded, i.e. everything except a Library
// Import match).
//
// Same "build once, append to <body>, expose an open()" shape as
// release-picker-modal.js — every page with an episode list gets this by
// calling initEpisodeDetailsModal() once and open(row)-ing it per click,
// no per-page modal markup needed.
// ---------------------------------------------------------------------------
function initEpisodeDetailsModal() {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box wide">
      <div class="modal-header">
        <h2 id="episodeDetailsTitle">Episode</h2>
        <button class="modal-close" type="button" aria-label="Close">${icons.x}</button>
      </div>
      <div class="modal-body">
        <div class="episode-details-list" id="episodeDetailsList"></div>
      </div>
      <div class="modal-footer">
        <button type="button" id="episodeDetailsCloseBtn">Close</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const titleEl = modal.querySelector('#episodeDetailsTitle');
  const listEl = modal.querySelector('#episodeDetailsList');
  const closeBtn = modal.querySelector('.modal-close');
  const footerCloseBtn = modal.querySelector('#episodeDetailsCloseBtn');

  function close() {
    modal.classList.remove('open');
  }
  closeBtn.addEventListener('click', close);
  footerCloseBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) close();
  });

  function detailRow(label, value, opts) {
    const monospace = opts && opts.monospace;
    const wrap = opts && opts.wrap;
    return `
      <div class="episode-detail-row${wrap ? ' episode-detail-row-wrap' : ''}">
        <p class="episode-detail-label">${label}</p>
        <p class="episode-detail-value${monospace ? ' monospace' : ''}">${value}</p>
      </div>
    `;
  }

  return {
    // row: one of the objects buildRealEpisodeRows (frontend/pages/series/SeriesPage.jsx)
    // already builds for the episode list — id, num, seasonNumber, title,
    // date (pre-formatted, see ../lib/dates.js), quality, path, sizeBytes,
    // downloaded, overview, state ('done' | 'missing' | 'downloading' | 'pending').
    open(row) {
      const code = `S${String(row.seasonNumber ?? 0).padStart(2, '0')}E${String(row.num).padStart(2, '0')}`;
      titleEl.textContent = `${code} — ${row.title}`;

      const airLabel = row.state === 'pending' || !row.downloaded ? 'Airs' : 'Aired';
      const qualityValue = row.downloaded
        ? escapeAttr(row.quality || 'Unknown')
        : `<span style="color:var(--text-muted);">Not downloaded yet</span>`;
      const pathValue = row.downloaded && row.path
        ? escapeAttr(row.path)
        : `<span style="color:var(--text-muted);">—</span>`;
      const sizeValue = row.downloaded && row.sizeBytes
        ? formatBytes(row.sizeBytes)
        : `<span style="color:var(--text-muted);">—</span>`;
      // Real TVDB synopsis text when this episode's cache has it (see the
      // episodes.overview column) — a series whose episodes were fetched
      // before that column existed just shows the same muted placeholder
      // every other missing field here already uses, rather than an empty
      // gap. `wrap: true` since unlike everything else in this modal, a
      // synopsis is actual prose, not a short label-sized value.
      const synopsisValue = row.overview
        ? escapeAttr(row.overview)
        : `<span style="color:var(--text-muted);">No synopsis available.</span>`;

      listEl.innerHTML = [
        detailRow(airLabel, escapeAttr(row.date || 'TBA')),
        detailRow('Quality', qualityValue),
        detailRow('File path', pathValue, { monospace: true }),
        detailRow('File size', sizeValue),
        detailRow('Synopsis', synopsisValue, { wrap: true }),
      ].join('');

      modal.classList.add('open');
    },
  };
}

export { initEpisodeDetailsModal };
