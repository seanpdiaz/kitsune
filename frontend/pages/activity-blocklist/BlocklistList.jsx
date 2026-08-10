import { useEffect, useState } from 'react';
import { icons } from '../../lib/icons.jsx';
import { timeAgo } from '../../../public/js/lib/dates.js';

// Activity > Blocklist — a faithful port of public/js/pages/activity-blocklist.js.
// Backed by the real GET /api/blocklist — rows land here when a simulated
// grab "fails" (see server/routes/queue.js's completion tick); Remove is a
// real DELETE /api/blocklist/:id.

export default function BlocklistList() {
  const [items, setItems] = useState(null); // null = loading
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/blocklist')
      .then((res) => res.json())
      .then((body) => { if (!cancelled) setItems(body.blocklist || []); })
      .catch(() => { if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, []);

  async function handleRemove(id) {
    await fetch(`/api/blocklist/${id}`, { method: 'DELETE' });
    setItems((current) => current.filter((i) => i.id !== id));
  }

  if (loadFailed) return <p className="settings-empty">Could not load the blocklist.</p>;
  if (items === null) return <p className="settings-empty">Loading…</p>;
  if (items.length === 0) return <p className="settings-empty">Blocklist is empty.</p>;

  return items.map((b) => (
    <div className="blocklist-row" key={b.id}>
      <span className="settings-title">{b.releaseTitle}</span>
      <span className="settings-meta">{b.seriesTitle || '—'}{b.episodeLabel ? ` ${b.episodeLabel}` : ''}</span>
      <span className="settings-meta">{b.reason || '—'}</span>
      <span className="audio-tag">{b.indexer || '—'}</span>
      <span className="ep-date">{timeAgo(b.createdAt)}</span>
      <button className="ep-action" type="button" aria-label="Remove from blocklist" onClick={() => handleRemove(b.id)}>
        {icons.x}
      </button>
    </div>
  ));
}
