import { useEffect, useRef, useState } from 'react';
import { icons } from '../../lib/icons.jsx';
// Reused directly from the still-shared public/js/lib/ rather than
// duplicated — a small, framework-agnostic pure function (no DOM
// dependency), the same canonical copy both the still-vanilla pages and
// every migrated React page import from.
import { formatBytes } from '../../../public/js/lib/format.js';

// ---------------------------------------------------------------------------
// Activity > Queue — a faithful port of public/js/pages/activity-queue.js.
// Backed by real downloads (server/routes/queue.js) — a row here really did
// come from Grab/Search All on Wanted, is really submitted to a real
// qBittorrent client, and really disappears once it completes. Polls every
// 2s so progress ticking in the background (regardless of whether this page
// is open) is visible here without a websocket, same as before.
// ---------------------------------------------------------------------------

const QUEUE_STATUS_CLASS = { downloading: 'status-info', paused: 'status-off', queued: 'status-pending', warning: 'status-warn' };
const QUEUE_STATUS_LABEL = { downloading: 'Downloading', paused: 'Paused', queued: 'Queued', warning: 'Warning' };

// Same small "build a modal right here" shape SeriesPage.jsx's own
// DeleteSeriesModal already established for a destructive action — removing
// an in-progress grab isn't reversible (the real torrent is gone from
// qBittorrent too, unless a batch grab's sibling rows still need it — see
// server/routes/queue.js's DELETE handler) and deserves the same "are you
// sure" a season/series delete already gets, which this previously skipped
// entirely.
function RemoveQueueItemModal({ item, onCancel, onConfirm, removing }) {
  return (
    <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="modal-box">
        <div className="modal-header">
          <h2>Remove from Queue</h2>
          <button className="modal-close" type="button" aria-label="Close" data-tooltip="Close" onClick={onCancel}>{icons.x}</button>
        </div>
        <div className="modal-body">
          <p>
            Are you sure you want to remove "{item.seriesTitle} {item.episodeLabel}" from the queue?
            {' '}This will stop the real download and remove the torrent from its download client.
          </p>
        </div>
        <div className="modal-footer">
          <button type="button" onClick={onCancel}>Cancel</button>
          <button className="btn-danger" type="button" disabled={removing} onClick={onConfirm}>{removing ? 'Removing…' : 'Remove'}</button>
        </div>
      </div>
    </div>
  );
}

export default function QueueList() {
  const [items, setItems] = useState(null); // null = loading
  const [loadFailed, setLoadFailed] = useState(false);
  const [removeTarget, setRemoveTarget] = useState(null); // the queue item pending confirmation, or null
  const [removing, setRemoving] = useState(false);
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
      // A row pending removal-confirmation can finish (or fail) on its own
      // between polls — the confirm dialog would otherwise be left open for
      // a queue entry that no longer exists.
      setRemoveTarget((prev) => (prev && !itemsRef.current.some((q) => q.id === prev.id) ? null : prev));
    } catch {
      setLoadFailed(true);
    }
  }

  useEffect(() => {
    load();
    const pollHandle = setInterval(load, 2000);
    return () => clearInterval(pollHandle);
  }, []);

  async function handleConfirmRemove() {
    if (!removeTarget || removing) return;
    setRemoving(true);
    try {
      await fetch(`/api/queue/${removeTarget.id}`, { method: 'DELETE' });
    } finally {
      setRemoving(false);
      setRemoveTarget(null);
      load();
    }
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

  return <>{items.map((q) => {
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
          data-tooltip={q.status === 'paused' ? 'Resume download' : 'Pause download'}
          onClick={() => handleTogglePause(q)}
        >
          {q.status === 'paused' ? icons.play : icons.pause}
        </button>
        <button className="ep-action" type="button" aria-label={`Remove ${q.seriesTitle} from queue`} data-tooltip="Remove from queue" onClick={() => setRemoveTarget(q)}>
          {icons.x}
        </button>
      </div>
    );
  })}
    {removeTarget && (
      <RemoveQueueItemModal
        item={removeTarget}
        removing={removing}
        onCancel={() => setRemoveTarget(null)}
        onConfirm={handleConfirmRemove}
      />
    )}
  </>;
}
