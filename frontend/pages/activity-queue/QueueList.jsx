import { useEffect, useRef, useState } from 'react';
import { icons } from '../../lib/icons.jsx';
// Reused directly from the still-shared public/js/lib/ rather than
// duplicated — a small, framework-agnostic pure function (no DOM
// dependency), the same canonical copy both the still-vanilla pages and
// every migrated React page import from.
import { formatBytes } from '../../../public/js/lib/format.js';

// ---------------------------------------------------------------------------
// Activity > Queue — a faithful port of public/js/pages/activity-queue.js.
// Backed by the real simulated downloader (server/routes/queue.js) — a row
// here really did come from Grab/Search All on Wanted, and really
// disappears once it completes. Polls every 2s so progress ticking in the
// background (regardless of whether this page is open) is visible here
// without a websocket, same as before.
// ---------------------------------------------------------------------------

const QUEUE_STATUS_CLASS = { downloading: 'status-info', paused: 'status-off', queued: 'status-pending', warning: 'status-warn' };
const QUEUE_STATUS_LABEL = { downloading: 'Downloading', paused: 'Paused', queued: 'Queued', warning: 'Warning' };

export default function QueueList() {
  const [items, setItems] = useState(null); // null = loading
  const [loadFailed, setLoadFailed] = useState(false);
  // Actions (pause/resume/remove) are in-flight fetches — this ref just lets
  // load() called from the polling interval and load() called right after
  // an action both share the same function without stale-closure issues.
  const itemsRef = useRef([]);

  async function load() {
    try {
      const res = await fetch('/api/queue');
      const body = await res.json();
      itemsRef.current = body.queue || [];
      setItems(itemsRef.current);
      setLoadFailed(false);
    } catch {
      setLoadFailed(true);
    }
  }

  useEffect(() => {
    load();
    const pollHandle = setInterval(load, 2000);
    return () => clearInterval(pollHandle);
  }, []);

  async function handleRemove(id) {
    await fetch(`/api/queue/${id}`, { method: 'DELETE' });
    load();
  }

  async function handleTogglePause(item) {
    const nextStatus = item.status === 'paused' ? 'downloading' : 'paused';
    await fetch(`/api/queue/${item.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: nextStatus }),
    });
    load();
  }

  if (loadFailed) return <p className="settings-empty">Could not load the queue.</p>;
  if (items === null) return null; // still loading — matches the old version, which left #queueList empty until the first load() resolved
  if (items.length === 0) return <p className="settings-empty">Queue is empty.</p>;

  return items.map((q) => {
    const pauseDisabled = q.status === 'warning';
    return (
      <div className="queue-row" key={q.id}>
        <div>
          <p className="settings-title">{q.seriesTitle}</p>
          <span className="settings-meta">{q.episodeLabel}</span>
        </div>
        <span className="audio-tag">{q.quality || '—'}</span>
        <span className="settings-meta">{formatBytes(q.sizeBytes)}</span>
        <div className="queue-progress">
          <div className="progress"><div className={`fill ${q.status === 'warning' ? 'warning' : 'accent'}`} style={{ width: `${q.progressPct}%` }} /></div>
          <span className="progress-label">{q.progressPct}%</span>
        </div>
        <span className={`status-pill ${QUEUE_STATUS_CLASS[q.status] || 'status-off'}`}>{QUEUE_STATUS_LABEL[q.status] || q.status}</span>
        <button
          className="ep-action"
          type="button"
          disabled={pauseDisabled}
          style={pauseDisabled ? { opacity: 0.35 } : undefined}
          aria-label={`${q.status === 'paused' ? 'Resume' : 'Pause'} ${q.seriesTitle}`}
          onClick={() => handleTogglePause(q)}
        >
          {q.status === 'paused' ? icons.play : icons.pause}
        </button>
        <button className="ep-action" type="button" aria-label={`Remove ${q.seriesTitle} from queue`} onClick={() => handleRemove(q.id)}>
          {icons.x}
        </button>
      </div>
    );
  });
}
