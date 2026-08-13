import { icons, escapeAttr } from './icons.js';
import { formatBytes } from './format.js';

// The "Search" button on Wanted > Missing/Cutoff Unmet used to just flash
// "Searching…" for 700ms and do nothing (see README) — this is what it
// actually opens now: a picker over GET /api/releases' real indexer results
// (see server/routes/releases.js), and a per-row grab that POSTs to
// /api/queue.
//
// Unlike the File Browser modal (public/js/lib/file-browser-modal.js), which
// expects each page that uses it to paste in its own static modal shell —
// the exact kind of duplication just cleaned up elsewhere in this project —
// this one builds its own DOM once and appends it to <body>, so no page
// needs any modal markup of its own at all. initReleasePickerModal() is
// called once per page; open(episode) does the rest.
function initReleasePickerModal() {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-box release-picker-box">
      <div class="modal-header">
        <h2 id="releasePickerTitle">Search Results</h2>
        <button class="modal-close" type="button" aria-label="Close">${icons.x}</button>
      </div>
      <div class="modal-body">
        <p class="form-error is-collapsed" id="releasePickerError"></p>
        <p class="release-picker-notice is-collapsed" id="releasePickerNotice"></p>
        <div class="release-list-wrap">
          <div class="release-header">
            <span>Release</span><span>Indexer</span><span>Quality</span><span>Size</span><span>Seeders</span><span></span>
          </div>
          <div id="releasePickerList"></div>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" id="releasePickerCancel">Cancel</button>
      </div>
    </div>
  `;
  document.body.appendChild(modal);

  const titleEl = modal.querySelector('#releasePickerTitle');
  const errorEl = modal.querySelector('#releasePickerError');
  const noticeEl = modal.querySelector('#releasePickerNotice');
  const listEl = modal.querySelector('#releasePickerList');
  const closeBtn = modal.querySelector('.modal-close');
  const cancelBtn = modal.querySelector('#releasePickerCancel');

  let onGrabbed = null;

  function close() {
    modal.classList.remove('open');
  }
  closeBtn.addEventListener('click', close);
  cancelBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('open')) close();
  });

  function showError(message) {
    errorEl.textContent = message || '';
    errorEl.classList.toggle('is-collapsed', !message);
  }

  // Surfaces non-fatal search conditions from server/routes/releases.js —
  // no indexers enabled, or some (but not all) enabled indexers failed —
  // that aren't errors but are still worth calling out above the results.
  function showNotice(message) {
    noticeEl.textContent = message || '';
    noticeEl.classList.toggle('is-collapsed', !message);
  }

  // A target is one of:
  //   { type: 'episode', id, label, title }              — one episode
  //   { type: 'season', seriesId, seasonNumber, seriesTitle } — a season,
  //     released as a single batch torrent (see Search Season)
  //   { type: 'series', seriesId, seriesTitle }           — a whole series,
  //     same idea (see Search All)
  // `type` defaults to 'episode' when omitted, since that's the shape every
  // pre-existing caller (SeriesPage, MissingList, CutoffList) already sends.
  function targetType(target) {
    return target.type || 'episode';
  }

  function grabBody(target, position) {
    const type = targetType(target);
    if (type === 'season') return { seriesId: target.seriesId, seasonNumber: target.seasonNumber, releaseIndex: position };
    if (type === 'series') return { seriesId: target.seriesId, releaseIndex: position };
    return { episodeId: target.id, releaseIndex: position };
  }

  // `infoUrl` — a real link to this release's detail page on whichever
  // indexer/tracker actually found it (nyaa.si's own torrent view page, or,
  // via Prowlarr, whatever the underlying tracker's own equivalent page is —
  // see nyaa-search.js's and prowlarr-search.js's own comments on where each
  // gets it) — makes the title clickable, opening that page in a new tab
  // the same way Sonarr/Radarr's own manual search results let you inspect
  // a release (comments, description, screenshots) before grabbing it. Only
  // ever set when the indexer actually supplied one; a release whose source
  // didn't include a page link stays plain unclickable text rather than a
  // dead or misleading link.
  function titleCell(r) {
    if (r.infoUrl) {
      return `<a class="release-title" href="${escapeAttr(r.infoUrl)}" target="_blank" rel="noopener noreferrer" title="${escapeAttr(r.title)}">${r.title}</a>`;
    }
    return `<span class="release-title" title="${escapeAttr(r.title)}">${r.title}</span>`;
  }

  function renderReleases(target, releases) {
    if (releases.length === 0) {
      listEl.innerHTML = `<div class="release-row" style="grid-template-columns:1fr;"><span style="color:var(--text-muted);">No results.</span></div>`;
      return;
    }
    // The grab index sent to POST /api/queue is this release's POSITION in
    // this already-best-first-sorted list (0 = the top result), not its
    // `index` field (that's the pre-sort generation seed, unrelated to
    // where it landed after sorting) — POST /api/queue re-derives the same
    // sorted list server-side and looks the grab up by that same position.
    // `inProfile` comes from server/lib/quality.js's rankReleaseCandidates —
    // false only when the series has a Quality Profile assigned AND this
    // release's tier isn't in that profile's allowed list (never true/false
    // ambiguously; a series with no profile at all gets `inProfile: true`
    // for everything, since there's nothing to flag against). Never hidden,
    // just visually deprioritized — see that function's own comment for why
    // filtering outright would be the wrong call for e.g. an obscure old
    // episode where an out-of-profile release might be the only real option.
    listEl.innerHTML = releases.map((r, position) => `
      <div class="release-row${r.inProfile === false ? ' out-of-profile' : ''}" data-position="${position}">
        ${titleCell(r)}
        <span>${r.indexer}${r.isBatch ? ' · batch' : ''}</span>
        <span class="audio-tag">${r.quality}${r.inProfile === false ? ' <span class="quality-flag out-of-profile-flag" title="Not in this series\' Quality Profile">Outside profile</span>' : ''}</span>
        <span>${formatBytes(r.sizeBytes)}</span>
        <span>${r.seeders}</span>
        <button class="btn-accent" type="button" data-grab="${position}" style="padding:4px 10px; font-size:12px;">Grab</button>
      </div>
    `).join('');

    listEl.querySelectorAll('[data-grab]').forEach((btn) => {
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        btn.textContent = 'Grabbing…';
        try {
          const res = await fetch('/api/queue', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(grabBody(target, Number(btn.dataset.grab))),
          });
          const body = await res.json();
          if (!res.ok) throw new Error(body.error || 'Could not grab that release.');
          close();
          if (onGrabbed) onGrabbed(body);
        } catch (err) {
          showError(err.message);
          btn.disabled = false;
          btn.textContent = 'Grab';
        }
      });
    });
  }

  return {
    // target: see targetType() above. onGrab(responseBody) fires after a
    // successful grab so the calling page can refresh its own list (grabbed
    // episode(s) should disappear from Missing, etc.) — responseBody is
    // either a single queue entry (episode target) or a { batch: true,
    // entries: [...] } summary (season/series target); most callers only
    // use it as a "something changed, refresh" signal either way.
    async open(target, onGrab) {
      onGrabbed = onGrab || null;
      const type = targetType(target);
      showError('');
      showNotice('');
      listEl.innerHTML = `<div class="release-row" style="grid-template-columns:1fr;"><span style="color:var(--text-muted);">Searching…</span></div>`;

      let fetchUrl;
      if (type === 'season') {
        titleEl.textContent = `Search Results — ${target.seriesTitle || ''}`;
        fetchUrl = `/api/releases?scope=season&seriesId=${target.seriesId}&seasonNumber=${target.seasonNumber}`;
      } else if (type === 'series') {
        titleEl.textContent = `Search Results — ${target.seriesTitle || ''} (all seasons)`;
        fetchUrl = `/api/releases?scope=series&seriesId=${target.seriesId}`;
      } else {
        titleEl.textContent = `Search Results — ${target.label}${target.title ? ' - ' + target.title : ''}`;
        fetchUrl = `/api/releases?episodeId=${target.id}`;
      }

      modal.classList.add('open');
      try {
        const res = await fetch(fetchUrl);
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'Search failed.');
        showNotice(body.notice);
        if (type !== 'episode' && body.targetLabel) {
          const countLabel = typeof body.episodeCount === 'number' ? ` — ${body.episodeCount} episode${body.episodeCount === 1 ? '' : 's'}` : '';
          titleEl.textContent = `Search Results — ${target.seriesTitle || ''} — ${body.targetLabel}${countLabel}`;
        }
        renderReleases(target, body.releases);
      } catch (err) {
        showError(err.message);
        listEl.innerHTML = '';
      }
    },
  };
}

export { initReleasePickerModal };
