import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// ---------------------------------------------------------------------------
// System > Logs — a faithful port of public/js/pages/system-logs.js. Backed
// by the real /api/logs endpoint (see server.js's Logging section) — every
// log call the server makes shows up here, same as before. Polls every 4s
// for a live-tail feel without a websocket, same as before too.
//
// The filter tabs are portaled into the top of the page (see
// system-logs.html) from this same component/state, same pattern as System
// > Backup/Events' portaled buttons — one `level` state drives both what's
// visually marked active in the tab strip and which rows get fetched.
// The "Log Files" card below the list stays static HTML — decorative
// sample data, nothing real or JS-driven behind it, same as before.
// ---------------------------------------------------------------------------

const LOG_LEVEL_CLASS = { Info: 'status-info', Warn: 'status-warn', Error: 'status-fail', Debug: 'status-off' };
const LEVELS = [
  { value: 'all', label: 'All' },
  { value: 'info', label: 'Info' },
  { value: 'warn', label: 'Warn' },
  { value: 'error', label: 'Error' },
  { value: 'debug', label: 'Debug' },
];

export default function LogTable({ tabsContainer }) {
  const [level, setLevel] = useState('all');
  const [rows, setRows] = useState(null); // null = still loading; [] = loaded, empty
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const res = await fetch(`/api/logs?level=${encodeURIComponent(level)}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (!cancelled) {
          setRows(data);
          setLoadFailed(false);
        }
      } catch (err) {
        console.error('Failed to load logs:', err);
        if (!cancelled) setLoadFailed(true);
      }
    }

    load();
    const pollTimer = setInterval(load, 4000);
    return () => {
      cancelled = true;
      clearInterval(pollTimer);
    };
  }, [level]);

  return (
    <>
      {tabsContainer && createPortal(
        LEVELS.map((l) => (
          <button key={l.value} className={l.value === level ? 'active' : ''} onClick={() => setLevel(l.value)}>
            {l.label}
          </button>
        )),
        tabsContainer,
      )}
      {loadFailed && <p className="settings-empty">Couldn't load logs. Is the server running?</p>}
      {!loadFailed && rows && rows.length === 0 && <p className="settings-empty">No log entries at this level.</p>}
      {!loadFailed && rows && rows.map((l) => (
        <div className="log-row" key={l.id}>
          <span className="ep-date">{l.time}</span>
          <span className={`status-pill ${LOG_LEVEL_CLASS[l.level] || 'status-off'}`}>{l.level}</span>
          <span className="settings-meta">{l.logger}</span>
          <span className="settings-meta">{l.message}</span>
        </div>
      ))}
    </>
  );
}
