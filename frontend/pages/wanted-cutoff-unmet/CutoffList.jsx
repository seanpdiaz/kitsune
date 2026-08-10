import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { icons } from '../../lib/icons.jsx';
import { initReleasePickerModal } from '../../../public/js/lib/release-picker-modal.js';

// Wanted > Cutoff Unmet — a faithful port of public/js/pages/wanted-cutoff-unmet.js.
// See MissingList.jsx (Wanted > Missing) for the shared background — same
// story here: backed by the real GET /api/wanted/cutoff-unmet (downloaded
// episodes whose quality ranks below their series' quality profile cutoff)
// and the same real search -> grab pipeline, reusing the same release picker
// modal (not ported to React) and the same portal pattern for Search All.
// A "grab" here is an upgrade search: the new release replaces whatever's
// already downloaded once it completes — server/routes/queue.js doesn't
// treat this any differently from a first-time grab.

export default function CutoffList({ buttonContainer }) {
  const [episodes, setEpisodes] = useState(null); // null = loading
  const [loadFailed, setLoadFailed] = useState(false);
  const [searching, setSearching] = useState(false);
  const pickerRef = useRef(null);

  async function load() {
    try {
      const res = await fetch('/api/wanted/cutoff-unmet');
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
    ? <p className="settings-empty">Could not load cutoff unmet episodes.</p>
    : episodes === null
      ? <p className="settings-empty">Loading…</p>
      : episodes.length === 0
        ? <p className="settings-empty">Nothing below cutoff.</p>
        : episodes.map((ep) => (
          <div className="cutoff-row" key={ep.episodeId}>
            <span className="settings-title">{ep.seriesTitle}</span>
            <span className="settings-meta">
              {`S${String(ep.seasonNumber).padStart(2, '0')}E${String(ep.num).padStart(2, '0')} - ${ep.title || `Episode ${ep.num}`}`}
            </span>
            <span className="audio-tag">{ep.quality}</span>
            <span className="audio-tag" style={{ color: 'var(--accent)', background: 'var(--accent-bg)' }}>{ep.cutoff}</span>
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
