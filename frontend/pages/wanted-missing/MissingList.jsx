import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { icons } from '../../lib/icons.jsx';
import { formatAirDate } from '../../../public/js/lib/dates.js';
import { initReleasePickerModal } from '../../../public/js/lib/release-picker-modal.js';

// Wanted > Missing — a faithful port of public/js/pages/wanted-missing.js.
// Backed by the real GET /api/wanted/missing (aired-but-not-downloaded
// episodes across the Library) and the real search -> grab pipeline via the
// release picker modal (POST /api/queue). The picker modal itself is NOT
// ported to React — it's a self-contained "build once, append to <body>"
// module (public/js/lib/release-picker-modal.js) with no dependency on
// whatever page opens it, shared as-is with the still-unmigrated series
// detail page's episode list. Reused directly here the same way
// formatAirDate/formatBytes are reused, rather than duplicated.
//
// "Search All" lives in the page's .top-row, separate from the list below
// it but needs the same `episodes` state (disabled when empty, and a
// grab-all loop that reads the current list) — same portal pattern as
// System > Backup/Events: one component, one piece of state, the button
// portal'd into its placeholder while the list renders normally.

export default function MissingList({ buttonContainer }) {
  const [episodes, setEpisodes] = useState(null); // null = loading
  const [loadFailed, setLoadFailed] = useState(false);
  const [searching, setSearching] = useState(false);
  const pickerRef = useRef(null);

  async function load() {
    try {
      const res = await fetch('/api/wanted/missing');
      const body = await res.json();
      setEpisodes(body.episodes || []);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }

  useEffect(() => {
    pickerRef.current = initReleasePickerModal();
    load();
  }, []);

  function handleSearch(ep) {
    pickerRef.current.open(
      { id: ep.episodeId, label: `S${String(ep.seasonNumber).padStart(2, '0')}E${String(ep.num).padStart(2, '0')}`, title: ep.title },
      () => setEpisodes((current) => current.filter((x) => x.episodeId !== ep.episodeId)),
    );
  }

  async function handleSearchAll() {
    if (searching || !episodes || episodes.length === 0) return;
    setSearching(true);
    // Grabs the top (best-sorted) simulated release for every currently
    // visible row, same as real Sonarr's "Search All" — no picker, just the
    // best match per episode. Sequential rather than Promise.all so the
    // queue doesn't get N simultaneous POSTs racing each other.
    for (const ep of episodes) {
      try {
        await fetch('/api/queue', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ episodeId: ep.episodeId, releaseIndex: 0 }),
        });
      } catch { /* one failed grab shouldn't stop the rest */ }
    }
    setSearching(false);
    load();
  }

  const list = loadFailed
    ? <p className="settings-empty">Could not load missing episodes.</p>
    : episodes === null
      ? <p className="settings-empty">Loading…</p>
      : episodes.length === 0
        ? <p className="settings-empty">No missing episodes.</p>
        : episodes.map((ep) => (
          <div className="missing-row" key={ep.episodeId}>
            <span className="settings-title">{ep.seriesTitle}</span>
            <span className="settings-meta">
              {`S${String(ep.seasonNumber).padStart(2, '0')}E${String(ep.num).padStart(2, '0')} - ${ep.title || `Episode ${ep.num}`}`}
            </span>
            <span className="ep-date">{formatAirDate(ep.aired)}</span>
            <button className="btn-test" type="button" onClick={() => handleSearch(ep)}>Search</button>
          </div>
        ));

  return (
    <>
      {buttonContainer && createPortal(
        <button className="btn-accent" type="button" disabled={searching} onClick={handleSearchAll}>
          {icons.search}
          {searching ? 'Searching…' : 'Search All'}
        </button>,
        buttonContainer,
      )}
      {list}
    </>
  );
}
