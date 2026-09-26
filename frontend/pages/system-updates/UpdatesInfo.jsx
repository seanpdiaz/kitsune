import { useEffect, useRef, useState } from 'react';
import { icons } from '../../lib/icons.jsx';

// ---------------------------------------------------------------------------
// System > Updates — Phase 1 of the real Updates feature (see Settings >
// General's Updates card and server/lib/update-check.js for the actual
// GitHub-comparison logic). Replaces what used to be four hardcoded
// <div class="settings-card"> blocks of made-up version history right in
// system-updates.html with this component, mounted the same
// "component owns its whole subtree" way system-status.html's StatusInfo
// already established (see that file's own header comment) rather than the
// Tasks pilot's "poke at scattered pre-existing ids" shape.
//
// Read-only, same as the API backing it: there is no "Install Update"
// button here. What action would even be safe depends on how this instance
// is deployed (see server/lib/deployment-mode.js) and, for a standalone
// install, on a real process-supervisor decision this app hasn't made yet —
// see the wiki's Updates planning page for the full phased plan. This page
// only ever answers "is there something newer, and what changed."
// ---------------------------------------------------------------------------

function relativeTime(iso) {
  if (!iso) return null;
  const diffMs = Date.now() - new Date(iso).getTime();
  const absMs = Math.abs(diffMs);
  let label;
  if (absMs < 60000) label = 'just now';
  else if (absMs < 3600000) label = `${Math.round(absMs / 60000)}m`;
  else if (absMs < 86400000) label = `${Math.round(absMs / 3600000)}h`;
  else label = `${Math.round(absMs / 86400000)}d`;
  if (label === 'just now') return label;
  return diffMs >= 0 ? `${label} ago` : `in ${label}`;
}

function formatDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

function CommitLink({ commit, children }) {
  if (!commit || !commit.htmlUrl) return <>{children}</>;
  return <a href={commit.htmlUrl} target="_blank" rel="noreferrer noopener">{children}</a>;
}

// Status pill shown at the top of the Update Status card — one of five
// states, told apart by what the last check actually returned rather than
// guessed from partial data: a real failure (network/GitHub error) always
// wins over any stale cached result, since showing "Up to Date" next to an
// error message would read as a contradiction.
function StatusPill({ data }) {
  if (data.lastError) {
    return <span className="status-pill status-fail">{icons.alert} Check Failed</span>;
  }
  if (data.checking && !data.checkedAt) {
    return <span className="status-pill status-pending">Checking…</span>;
  }
  if (data.updateAvailable === true) {
    return <span className="status-pill status-info">{icons.info} Update Available</span>;
  }
  if (data.updateAvailable === false) {
    return <span className="status-pill status-on">{icons.check} Up to Date</span>;
  }
  return <span className="status-pill status-pending">Unknown</span>;
}

export default function UpdatesInfo() {
  const [data, setData] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // "Is a check currently in flight" and "just finished, flash green" —
  // ported straight from TaskList.jsx's RealRow (same poll-while-running,
  // detect-the-transition, one-shot-flash-class shape; see that file's own
  // comments for the full reasoning), just against /api/system-updates
  // instead of /api/system-tasks. wasCheckingRef tracks running/not across
  // polls without forcing a re-render itself; pollTimeoutRef lets an
  // in-flight poll loop be cancelled on unmount.
  const [flashing, setFlashing] = useState(false);
  const wasCheckingRef = useRef(false);
  const pollTimeoutRef = useRef(null);

  async function load() {
    try {
      const res = await fetch('/api/system-updates');
      const body = await res.json();
      setData(body);
      setLoadFailed(false);
      return body;
    } catch {
      setLoadFailed(true);
      return null;
    }
  }

  // Same 2.4s duration as .task-row.row-flash-success's own override (see
  // styles.css's .update-status-card.row-flash-success) — TaskList.jsx's
  // scheduleFlash clears its class after the same 2.4s to match that CSS
  // exactly; this does the same against this card's own override.
  function scheduleFlash() {
    setFlashing(true);
    setTimeout(() => setFlashing(false), 2400);
  }

  // Re-checks every 2s for as long as the server reports a check still
  // running, then stops — same cadence RealRow's own pollUntilDone uses.
  // Also the one place that can observe a running -> done transition
  // happen live, so it's what triggers the completion flash too.
  function pollUntilDone() {
    pollTimeoutRef.current = setTimeout(async () => {
      const fresh = await load();
      if (fresh) {
        const justFinished = wasCheckingRef.current && !fresh.checking;
        if (justFinished) scheduleFlash();
        wasCheckingRef.current = fresh.checking;
      }
      if (fresh && fresh.checking) pollUntilDone();
    }, 2000);
  }

  useEffect(() => {
    let cancelled = false;
    load().then((fresh) => {
      if (cancelled || !fresh) return;
      wasCheckingRef.current = fresh.checking;
      // The page can mount while a check is already in flight — e.g. it
      // just started from System > Tasks' own Run Now, or the scheduler's
      // startup check hasn't finished yet. Without this, the card would
      // show "Checking…" (and its progress bar) forever once the real
      // check finishes, since nothing would poll again to notice — the
      // exact bug TaskList.jsx's RealRow already had to fix once before.
      if (fresh.checking) pollUntilDone();
    });
    return () => {
      cancelled = true;
      if (pollTimeoutRef.current) clearTimeout(pollTimeoutRef.current);
    };
  }, []);

  async function handleCheckNow() {
    // Instant feedback before the POST even resolves, same as RealRow's
    // own handleRunNow.
    setData((d) => (d ? { ...d, checking: true } : d));
    try {
      const res = await fetch('/api/system-updates/check', { method: 'POST' });
      const body = await res.json();
      if (body && typeof body.checking === 'boolean') {
        wasCheckingRef.current = body.checking;
        setData((d) => (d ? { ...d, checking: body.checking } : d));
      }
    } catch {
      // ignore — the poll loop below reconciles with the server's real
      // state regardless of whether this particular request succeeded
    }
    pollUntilDone();
  }

  if (loadFailed) {
    return (
      <div className="settings-card">
        <p className="settings-empty">Could not load update status.</p>
      </div>
    );
  }
  if (!data) return null;

  const build = data.buildInfo || {};
  const latest = data.latestCommit;
  const commits = data.commits || [];

  return (
    <>
      <div className="settings-card">
        <h2>This Installation</h2>
        <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))', marginBottom: '4px' }}>
          <div className="stat-card"><p className="label">Version</p><p className="value" style={{ fontSize: '15px' }}>{data.currentVersion || '—'}</p></div>
          <div className="stat-card">
            <p className="label">Commit</p>
            <p className="value" style={{ fontSize: '15px', fontFamily: 'var(--font-mono)' }}>
              {build.commit ? <CommitLink commit={{ htmlUrl: data.repo ? `https://github.com/${data.repo.owner}/${data.repo.repo}/commit/${build.commit}` : null }}>{build.commit.slice(0, 7)}</CommitLink> : 'unknown'}
            </p>
          </div>
          <div className="stat-card"><p className="label">Branch</p><p className="value" style={{ fontSize: '15px' }}>{data.branch || build.branch || '—'}</p></div>
          <div className="stat-card"><p className="label">Deployment</p><p className="value" style={{ fontSize: '15px', textTransform: 'capitalize' }}>{data.deploymentMode || '—'}</p></div>
        </div>
        <p className="settings-meta">Built {build.builtAt ? formatDateTime(build.builtAt) : 'unknown — no build-info.json was generated for this install'}.</p>
      </div>

      <div className={`settings-card update-status-card${flashing ? ' row-flash-success' : ''}`}>
        <h2>Update Status</h2>
        <p className="card-desc">Compares this build against the Branch selected in Settings &gt; General &gt; Updates.</p>
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', margin: '10px 0 6px' }}>
          <StatusPill data={data} />
          <span className="settings-meta">
            {data.checkedAt ? `Last checked ${relativeTime(data.checkedAt)}` : 'Never checked'}
          </span>
          <button type="button" className="btn-test" disabled={data.checking} onClick={handleCheckNow} style={{ marginLeft: 'auto' }}>
            {data.checking ? 'Checking…' : 'Check Now'}
          </button>
        </div>

        {data.lastError && (
          <p className="form-error">{data.lastError}</p>
        )}

        {!data.lastError && build.commit === null && (
          <p className="settings-meta">
            This install has no build-info.json, so there's nothing to compare against — the latest commit on {data.branch || 'the selected branch'} is shown below, but "update available" can't be determined.
          </p>
        )}

        {!data.lastError && latest && (
          <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--border)' }}>
            <p className="settings-meta">
              Latest on <strong style={{ color: 'var(--text-primary)' }}>{data.branch}</strong>:{' '}
              <CommitLink commit={latest}><span style={{ fontFamily: 'var(--font-mono)' }}>{latest.shortSha}</span></CommitLink>
              {' — '}{latest.message}{latest.author ? ` (${latest.author})` : ''}
            </p>
          </div>
        )}
        {data.checking ? <div className="task-progress-track" /> : null}
      </div>

      {commits.length > 0 && (
        <div className="settings-card">
          <h2>What's Changed</h2>
          <p className="card-desc">
            {data.aheadBy != null
              ? `${data.aheadBy} commit${data.aheadBy === 1 ? '' : 's'} on ${data.branch} since this build.`
              : `Commits on ${data.branch} since this build.`}
          </p>
          {commits.map((c) => (
            <p className="changelog-item" key={c.sha}>
              <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--text-muted)', marginRight: '8px' }}>
                <CommitLink commit={c}>{c.shortSha}</CommitLink>
              </span>
              <span>{c.message}{c.author ? ` — ${c.author}` : ''}{c.date ? ` (${relativeTime(c.date)})` : ''}</span>
            </p>
          ))}
        </div>
      )}
    </>
  );
}
