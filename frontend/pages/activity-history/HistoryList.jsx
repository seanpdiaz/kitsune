import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatBytes } from '../../../public/js/lib/format.js';
import { timeAgo } from '../../../public/js/lib/dates.js';

// Activity > History — a faithful port of public/js/pages/activity-history.js.
// Backed by the real, append-only GET /api/history (server/routes/queue.js
// writes to it on every grab, import, and simulated failure). Same portaled
// filter tabs pattern as System > Logs — one `type` state drives both.

const HISTORY_TYPE_CLASS = { grabbed: 'status-info', imported: 'status-on', failed: 'status-fail', deleted: 'status-off' };
const HISTORY_TYPE_LABEL = { grabbed: 'Grabbed', imported: 'Imported', failed: 'Failed', deleted: 'Deleted' };
const TYPES = [
  { value: 'all', label: 'All' },
  { value: 'grabbed', label: 'Grabbed' },
  { value: 'imported', label: 'Imported' },
  { value: 'failed', label: 'Failed' },
  { value: 'deleted', label: 'Deleted' },
];

function messageFor(h) {
  const parts = [h.seriesTitle, h.episodeLabel].filter(Boolean).join(' ');
  const detail = h.eventType === 'imported' || h.eventType === 'grabbed'
    ? [h.releaseTitle, h.quality, h.sizeBytes ? formatBytes(h.sizeBytes) : null].filter(Boolean).join(' — ')
    : (h.message || h.releaseTitle || '');
  return [parts, detail].filter(Boolean).join(' — ');
}

export default function HistoryList({ tabsContainer }) {
  const [type, setType] = useState('all');
  const [rows, setRows] = useState(null); // null = loading
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setRows(null); // "Loading…" while this filter's request is in flight, matching the old version
    setLoadFailed(false);
    fetch(`/api/history${type !== 'all' ? `?type=${type}` : ''}`)
      .then((res) => res.json())
      .then((body) => { if (!cancelled) setRows(body.history || []); })
      .catch(() => { if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, [type]);

  return (
    <>
      {tabsContainer && createPortal(
        TYPES.map((t) => (
          <button key={t.value} className={t.value === type ? 'active' : ''} onClick={() => setType(t.value)}>
            {t.label}
          </button>
        )),
        tabsContainer,
      )}
      {loadFailed && <p className="settings-empty">Could not load history.</p>}
      {!loadFailed && rows === null && <p className="settings-empty">Loading…</p>}
      {!loadFailed && rows && rows.length === 0 && <p className="settings-empty">No history for this filter.</p>}
      {!loadFailed && rows && rows.map((h) => (
        <div className="event-row" key={h.id}>
          <span className="ep-date">{timeAgo(h.createdAt)}</span>
          <span className={`status-pill ${HISTORY_TYPE_CLASS[h.eventType] || 'status-off'}`}>{HISTORY_TYPE_LABEL[h.eventType] || h.eventType}</span>
          <span className="settings-meta">{messageFor(h)}</span>
        </div>
      ))}
    </>
  );
}
