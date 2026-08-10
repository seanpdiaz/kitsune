import { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// System > Tasks — the pilot page for Kitsune's React migration (see
// README's "React migration" section and vite.config.mjs). A faithful port
// of public/js/pages/system-tasks.js's logic — same seven decorative rows,
// same one real row (Disk Usage Recompute, backed by /api/system-tasks —
// see server/lib/disk-usage.js), same polling-while-running behavior, same
// completion flash — talking to the exact same unchanged backend endpoints.
// Nothing server-side changed for this migration at all.
//
// The old public/js/pages/system-tasks.js is gone (superseded by this, not
// left running alongside it) and app.js no longer imports it — see the
// README entry for why loading both would have meant two separate render
// loops fighting over the same #taskList container.
// ---------------------------------------------------------------------------

const TASKS_DATA = [
  { id: 1, name: 'RSS Sync', interval: 'Every 15 minutes', lastRun: '4 minutes ago', nextRun: 'in 11 minutes' },
  { id: 2, name: 'Check for Finished Downloads', interval: 'Every 1 minute', lastRun: '38 seconds ago', nextRun: 'in 22 seconds' },
  { id: 3, name: 'Refresh Series', interval: 'Every 12 hours', lastRun: '3 hours ago', nextRun: 'in 9 hours' },
  { id: 4, name: 'Update Metadata Cache', interval: 'Every 12 hours', lastRun: '5 hours ago', nextRun: 'in 7 hours' },
  { id: 5, name: 'Backup', interval: 'Every 7 days', lastRun: '2 days ago', nextRun: 'in 5 days' },
  { id: 6, name: 'Application Update Check', interval: 'Every 6 hours', lastRun: '1 hour ago', nextRun: 'in 5 hours' },
  { id: 7, name: 'Housekeeping', interval: 'Every 24 hours', lastRun: '14 hours ago', nextRun: 'in 10 hours' },
];

// A fixed set of sensible choices rather than a free-text number field —
// avoids validating "0", negative numbers, decimals, etc. on the frontend
// (the server still clamps to [minIntervalHours, maxIntervalHours] itself
// regardless, see server/lib/disk-usage.js, in case that ever changes).
const INTERVAL_OPTIONS_HOURS = [1, 2, 3, 6, 12, 24, 48, 72, 168];

function formatIntervalLabel(hours) {
  if (hours >= 168 && hours % 168 === 0) return `Every ${hours / 168} week${hours === 168 ? '' : 's'}`;
  if (hours >= 24 && hours % 24 === 0) return `Every ${hours / 24} day${hours === 24 ? '' : 's'}`;
  return `Every ${hours} hour${hours === 1 ? '' : 's'}`;
}

// Real timestamps (ISO strings from the server) rather than the fake rows'
// canned "4 minutes ago" text — computed relative to right now on every
// render.
function relativeTime(iso) {
  if (!iso) return null;
  const diffMs = new Date(iso).getTime() - Date.now();
  const absMs = Math.abs(diffMs);
  const label = absMs < 3600000 ? `${Math.max(1, Math.round(absMs / 60000))}m` : `${Math.round(absMs / 3600000)}h`;
  return diffMs >= 0 ? `in ${label}` : `${label} ago`;
}

// One of the six decorative rows. There's nothing real behind these —
// "Run Now" just fakes a "Just now" timestamp after a delay, same as
// before. Each row owns its own state now instead of the old version's
// single shared array + a full-list re-render on every fake click — the
// kind of thing that's basically free with components, whereas the old
// innerHTML-based version had no cheaper way to update just one row.
function FakeRow({ task }) {
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState(task.lastRun);

  function handleRun() {
    setRunning(true);
    setTimeout(() => {
      setLastRun('Just now');
      setRunning(false);
    }, 700);
  }

  return (
    <div className="task-row">
      <p className="settings-title">{task.name}</p>
      <span className="settings-meta">{task.interval}</span>
      <span className="settings-meta">{lastRun}</span>
      <span className="settings-meta">{task.nextRun}</span>
      <button className="btn-test" type="button" disabled={running} onClick={handleRun}>
        {running ? 'Running…' : 'Run Now'}
      </button>
    </div>
  );
}

// The one real row: Disk Usage Recompute. Renders nothing until
// /api/system-tasks has answered once (matching the old version, which
// only ever appended this row to the list once `realTask` was non-null).
function RealRow() {
  const [task, setTask] = useState(null);
  const [flashing, setFlashing] = useState(false);
  const [changingInterval, setChangingInterval] = useState(false);
  // Tracks running/not across polls without forcing a re-render itself —
  // only used to detect the running -> done transition that triggers the
  // completion flash, same role the old version's local `wasRunning`
  // (recomputed each poll from the previous `realTask`) played.
  const wasRunningRef = useRef(false);
  const pollTimeoutRef = useRef(null);

  async function refreshTask() {
    try {
      const res = await fetch('/api/system-tasks');
      const tasks = await res.json();
      return tasks.find((t) => t.id === 'disk-usage') || null;
    } catch {
      return null; // keep whatever's currently shown rather than blanking it
    }
  }

  // The CSS side (.row-flash-success, see styles.css) needs no cleanup —
  // its animation is non-infinite and just stops on its own. What DOES
  // need cleanup on this side is the class itself: unlike the old
  // one-shot-per-render vanilla version (where the class was only ever in
  // the HTML string for a single render() call and therefore couldn't
  // replay on a later one), a React class held in state stays applied
  // across every re-render until something removes it — so this clears it
  // back off 1.6s later, exactly matching the animation's own duration,
  // rather than leaving a class the animation has already finished playing
  // permanently sitting in the DOM.
  function scheduleFlash() {
    setFlashing(true);
    setTimeout(() => setFlashing(false), 1600);
  }

  // Re-checks /api/system-tasks every 2s for as long as the task reports
  // itself still running, then stops the moment it isn't — tracks a scan of
  // unknown duration instead of guessing it. Also the one place that can
  // actually observe a running -> done transition happen live, so it's what
  // triggers the completion flash too.
  function pollUntilDone() {
    pollTimeoutRef.current = setTimeout(async () => {
      const fresh = await refreshTask();
      if (fresh) {
        const justFinished = wasRunningRef.current && !fresh.running;
        if (justFinished) scheduleFlash();
        wasRunningRef.current = fresh.running;
        setTask(fresh);
      }
      if (fresh && fresh.running) pollUntilDone();
    }, 2000);
  }

  useEffect(() => {
    let cancelled = false;
    refreshTask().then((fresh) => {
      if (cancelled || !fresh) return;
      wasRunningRef.current = fresh.running;
      setTask(fresh);
    });
    return () => {
      cancelled = true;
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    };
  }, []);

  async function handleRunNow() {
    // Instant feedback (disabled button, "Running…") before the POST even
    // resolves — same as the old version disabling the button synchronously
    // ahead of the fetch.
    setTask((t) => (t ? { ...t, running: true } : t));
    try {
      const res = await fetch('/api/system-tasks/disk-usage/run', { method: 'POST' });
      const body = await res.json();
      if (body.task) {
        wasRunningRef.current = body.task.running;
        setTask(body.task);
      }
    } catch {
      // ignore — the poll loop below reconciles with the server's real
      // state regardless of whether this particular request succeeded
    }
    pollUntilDone();
  }

  async function handleIntervalChange(e) {
    const hours = Number(e.target.value);
    setChangingInterval(true);
    try {
      const res = await fetch('/api/system-tasks/disk-usage', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervalHours: hours }),
      });
      const body = await res.json();
      if (body.task) setTask(body.task);
    } catch {
      // ignore
    } finally {
      setChangingInterval(false);
    }
  }

  if (!task) return null;

  const lastRun = task.lastRunAt ? relativeTime(task.lastRunAt) : 'Never';
  const nextRun = task.running ? 'Running…' : (task.nextRunAt ? relativeTime(task.nextRunAt) : '—');

  return (
    <div className={`task-row${flashing ? ' row-flash-success' : ''}`}>
      <p className="settings-title">{task.name}</p>
      <span className="settings-meta">
        <select
          className="field-select"
          disabled={task.running || changingInterval}
          value={task.intervalHours}
          onChange={handleIntervalChange}
        >
          {INTERVAL_OPTIONS_HOURS.map((h) => (
            <option key={h} value={h}>{formatIntervalLabel(h)}</option>
          ))}
        </select>
      </span>
      <span className="settings-meta">{lastRun}</span>
      <span className="settings-meta">{nextRun}</span>
      <button className="btn-test" type="button" disabled={task.running} onClick={handleRunNow}>
        {task.running ? 'Running…' : 'Run Now'}
      </button>
      {task.running ? <div className="task-progress-track" /> : null}
    </div>
  );
}

export default function TaskList() {
  return (
    <>
      {TASKS_DATA.map((task) => (
        <FakeRow key={task.id} task={task} />
      ))}
      <RealRow />
    </>
  );
}
