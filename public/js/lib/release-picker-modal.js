import { icons } from './icons.js';
import { formatBytes } from './format.js';

// The "Search" button on Wanted > Missing/Cutoff Unmet used to just flash
// "Searching…" for 700ms and do nothing (see README) — this is what it
// actually opens now: a picker over GET /api/releases' deterministic fake
// candidates, and a per-row grab that POSTs to /api/queue.
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
    <div class="modal-box wide">
      <div class="modal-header">
        <h2 id="releasePickerTitle">Search Results</h2>
        <button class="modal-close" type="button" aria-label="Close">${icons.x}</button>
      </div>
      <div class="modal-body">
        <p class="form-error is-collapsed" id="releasePickerError"></p>
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

  function renderReleases(episodeId, releases) {
    if (releases.length === 0) {
      listEl.innerHTML = `<div class="release-row" style="grid-template-columns:1fr;"><span style="color:var(--text-muted);">No results.</span></div>`;
      return;
    }
    // The grab index sent to POST /api/queue is this release's POSITION in
    // this already-best-first-sorted list (0 = the top result), not its
    // `index` field (that's the pre-sort generation seed, unrelated to
    // where it landed after sorting) — POST /api/queue re-derives the same
    // sorted list server-side and looks the grab up by that same position.
    listEl.innerHTML = releases.map((r, position) => `
      <div class="release-row" data-position="${position}">
        <span class="release-title" title="${r.title}">${r.title}</span>
        <span>${r.indexer}</span>
        <span class="audio-tag">${r.quality}</span>
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
            body: JSON.stringify({ episodeId, releaseIndex: Number(btn.dataset.grab) }),
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
    // episode: { id, label, title }. onGrab(queueEntry) fires after a
    // successful grab so the calling page can refresh its own list (the
    // grabbed episode should disappear from Missing, etc.).
    async open(episode, onGrab) {
      onGrabbed = onGrab || null;
      titleEl.textContent = `Search Results — ${episode.label}${episode.title ? ' - ' + episode.title : ''}`;
      showError('');
      listEl.innerHTML = `<div class="release-row" style="grid-template-columns:1fr;"><span style="color:var(--text-muted);">Searching…</span></div>`;
      modal.classList.add('open');
      try {
        const res = await fetch(`/api/releases?episodeId=${episode.id}`);
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || 'Search failed.');
        renderReleases(episode.id, body.releases);
      } catch (err) {
        showError(err.message);
        listEl.innerHTML = '';
      }
    },
  };
}

export { initReleasePickerModal };
