import { useEffect, useRef, useState } from 'react';

// ---------------------------------------------------------------------------
// System > Tasks — the pilot page for Kitsune's React migration (see
// README's "React migration" section and vite.config.mjs). Originally a
// faithful port of public/js/pages/system-tasks.js's logic (now gone,
// superseded by this) with one real row (Disk Usage Recompute) alongside
// the same seven decorative placeholder rows that page always had.
//
// RealRow now takes its task's id/endpoints as props instead of having
// Disk Usage Recompute's hardcoded in, so Apply Permissions (see
// server/lib/permissions.js and server/routes/system-tasks.js) could join
// it as a second genuinely real row without copy-pasting the whole
// polling/flash/interval-dropdown component a second time — both rows
// share identical behavior (interval dropdown, Run Now, poll-while-running,
// completion flash) because both back onto the exact same GET/POST/PATCH
// shape on the server side.
//
// The other seven rows (FakeRow) are still decorative in every other way —
// Run Now still just fakes a "Just now" timestamp, Last Run/Next Run stay
// canned text — but their interval is a real, persisted setting now too
// (see server/lib/decorative-task-intervals.js), so the user can actually
// set and keep a preferred schedule for each even though nothing runs on
// it yet.
// ---------------------------------------------------------------------------

const TASKS_DATA = [
  // `taskId` is the stable key server/lib/decorative-task-intervals.js
  // persists each row's interval under — matches that module's
  // DEFAULT_INTERVAL_MINUTES exactly, so `defaultIntervalMinutes` here is
  // just what to show before GET /api/system-tasks/schedule answers once
  // on mount, not a second source of truth.
  { id: 1, taskId: 'rss-sync', name: 'RSS Sync', defaultIntervalMinutes: 15, lastRun: '4 minutes ago', nextRun: 'in 11 minutes' },
  { id: 2, taskId: 'check-downloads', name: 'Check for Finished Downloads', defaultIntervalMinutes: 1, lastRun: '38 seconds ago', nextRun: 'in 22 seconds' },
  { id: 3, taskId: 'refresh-series', name: 'Refresh Series', defaultIntervalMinutes: 720, lastRun: '3 hours ago', nextRun: 'in 9 hours' },
  { id: 4, taskId: 'metadata-cache', name: 'Update Metadata Cache', defaultIntervalMinutes: 720, lastRun: '5 hours ago', nextRun: 'in 7 hours' },
  { id: 5, taskId: 'backup', name: 'Backup', defaultIntervalMinutes: 10080, lastRun: '2 days ago', nextRun: 'in 5 days' },
  { id: 6, taskId: 'update-check', name: 'Application Update Check', defaultIntervalMinutes: 360, lastRun: '1 hour ago', nextRun: 'in 5 hours' },
  { id: 7, taskId: 'housekeeping', name: 'Housekeeping', defaultIntervalMinutes: 1440, lastRun: '14 hours ago', nextRun: 'in 10 hours' },
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

// Same "fixed practical choices, not free text" idea as INTERVAL_OPTIONS_HOURS
// above, but in minutes — the seven still-decorative rows below now have a
// real, persisted interval too (see server/lib/decorative-task-intervals.js),
// and two of them (RSS Sync, Check for Finished Downloads) are realistically
// sub-hourly, so an hours-only picker couldn't represent their actual
// real-world default cadence at all.
const DECORATIVE_INTERVAL_OPTIONS_MINUTES = [1, 5, 10, 15, 20, 30, 45, 60, 120, 180, 360, 720, 1440, 2880, 4320, 10080];

function formatMinutesLabel(minutes) {
  if (minutes >= 10080 && minutes % 10080 === 0) return `Every ${minutes / 10080} week${minutes === 10080 ? '' : 's'}`;
  if (minutes >= 1440 && minutes % 1440 === 0) return `Every ${minutes / 1440} day${minutes === 1440 ? '' : 's'}`;
  if (minutes >= 60 && minutes % 60 === 0) return `Every ${minutes / 60} hour${minutes === 60 ? '' : 's'}`;
  return `Every ${minutes} minute${minutes === 1 ? '' : 's'}`;
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

// One of the seven still-decorative rows — "Run Now" still just fakes a
// "Just now" timestamp after a delay, and Last Run/Next Run stay canned
// text, same as before. What's no longer fake is the interval: it's a real
// persisted setting now (see server/lib/decorative-task-intervals.js),
// passed down from TaskList (which owns the one shared fetch/PATCH for all
// seven rows) as `intervalMinutes` + `onIntervalChange` rather than each
// row managing its own — matches RealRow's own interval dropdown below,
// just backed by a settings value instead of a real scheduler. Each row
// still owns its own Run Now state independently, same reasoning as
// before: basically free with components, versus the old version's single
// shared array forcing a full-list re-render on every fake click.
function FakeRow({ task, intervalMinutes, onIntervalChange }) {
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState(task.lastRun);
  const [changingInterval, setChangingInterval] = useState(false);

  function handleRun() {
    setRunning(true);
    setTimeout(() => {
      setLastRun('Just now');
      setRunning(false);
    }, 700);
  }

  async function handleIntervalChange(e) {
    const minutes = Number(e.target.value);
    setChangingInterval(true);
    try {
      await onIntervalChange(minutes);
    } finally {
      setChangingInterval(false);
    }
  }

  return (
    <div className="task-row">
      <p className="settings-title">{task.name}</p>
      <span className="settings-meta">
        <select
          className="field-select"
          disabled={changingInterval}
          value={intervalMinutes}
          onChange={handleIntervalChange}
        >
          {DECORATIVE_INTERVAL_OPTIONS_MINUTES.map((m) => (
            <option key={m} value={m}>{formatMinutesLabel(m)}</option>
          ))}
        </select>
      </span>
      <span className="settings-meta">{lastRun}</span>
      <span className="settings-meta">{task.nextRun}</span>
      <button className="btn-test" type="button" disabled={running} onClick={handleRun}>
        {running ? 'Running…' : 'Run Now'}
      </button>
    </div>
  );
}

// A real row backed by GET/POST/PATCH /api/system-tasks — Disk Usage
// Recompute and Apply Permissions both render through this same component
// (see TaskList below), told apart only by `taskId` (which row to pick out
// of GET /api/system-tasks' array) and the two endpoints to call for this
// task's Run Now / interval change. Renders nothing until /api/system-tasks
// has answered once and included this taskId (matching the old
// single-task version, which only ever appended its row once `realTask`
// was non-null).
function RealRow({ taskId, runPath, patchPath }) {
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
      return tasks.find((t) => t.id === taskId) || null;
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
      const res = await fetch(runPath, { method: 'POST' });
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
      const res = await fetch(patchPath, {
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

  // Only Apply Permissions sets this (see permissions.js's getTaskInfo) —
  // Disk Usage Recompute's task object simply has no `enabled` field, so
  // this is false for it and the row renders exactly as it always has.
  const isDisabled = task.enabled === false;
  const lastRun = task.lastRunAt ? relativeTime(task.lastRunAt) : 'Never';
  const nextRun = task.running ? 'Running…' : (task.nextRunAt ? relativeTime(task.nextRunAt) : '—');

  return (
    <div className={`task-row${flashing ? ' row-flash-success' : ''}`}>
      <div className="settings-name">
        <p className="settings-title">{task.name}</p>
        {/* Surfaces the exact reason Run Now would no-op (per the server
            log line this same string comes from) right on the row, instead
            of only in the log — so nobody's left clicking a button that
            silently does nothing. */}
        {task.disabledReason ? <span className="settings-meta">{task.disabledReason}</span> : null}
      </div>
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
      <button
        className="btn-test"
        type="button"
        disabled={task.running || isDisabled}
        title={isDisabled ? task.disabledReason : undefined}
        onClick={handleRunNow}
      >
        {task.running ? 'Running…' : 'Run Now'}
      </button>
      {task.running ? <div className="task-progress-track" /> : null}
    </div>
  );
}

export default function TaskList() {
  // One shared fetch for all seven decorative rows' intervals, same "one
  // request, not N" shape GET /api/system-tasks already uses for the two
  // real rows — each FakeRow reads its own slice out of this map by
  // task.taskId rather than fetching for itself.
  const [intervals, setIntervals] = useState({});

  useEffect(() => {
    let cancelled = false;
    fetch('/api/system-tasks/schedule')
      .then((res) => res.json())
      .then((data) => { if (!cancelled) setIntervals(data); })
      .catch(() => {}); // keep showing each row's defaultIntervalMinutes fallback
    return () => { cancelled = true; };
  }, []);

  async function handleIntervalChange(taskId, minutes) {
    // Optimistic update — the dropdown reflects the choice immediately
    // rather than waiting on the round trip, same tradeoff RealRow's own
    // interval PATCH makes (state is set from the response there too, but
    // nothing in the UI blocks on it first).
    setIntervals((prev) => ({ ...prev, [taskId]: minutes }));
    try {
      const res = await fetch(`/api/system-tasks/schedule/${taskId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ intervalMinutes: minutes }),
      });
      const body = await res.json();
      if (body.intervalMinutes) setIntervals((prev) => ({ ...prev, [taskId]: body.intervalMinutes }));
    } catch {
      // ignore — keeps the optimistic value rather than reverting; a
      // refresh will reconcile with whatever the server actually has
    }
  }

  return (
    <>
      {TASKS_DATA.map((task) => (
        <FakeRow
          key={task.id}
          task={task}
          intervalMinutes={intervals[task.taskId] ?? task.defaultIntervalMinutes}
          onIntervalChange={(minutes) => handleIntervalChange(task.taskId, minutes)}
        />
      ))}
      <RealRow taskId="disk-usage" runPath="/api/system-tasks/disk-usage/run" patchPath="/api/system-tasks/disk-usage" />
      <RealRow taskId="apply-permissions" runPath="/api/system-tasks/apply-permissions/run" patchPath="/api/system-tasks/apply-permissions" />
    </>
  );
}
