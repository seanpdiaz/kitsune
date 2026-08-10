import { useEffect, useState } from 'react';

// ---------------------------------------------------------------------------
// System > Status — a faithful port of public/js/pages/system-status.js's
// Info + Disk Space cards. The Health card on this page stays plain static
// HTML (system-status.html) — nothing in the old JS ever touched it, it's
// decorative sample data with no real backend behind it, so there's nothing
// to migrate there.
//
// Unlike the Tasks pilot (which had one container div, #taskList, that the
// old code fully owned), the old version of this page filled in individual
// pre-existing <span id="..."> text nodes scattered across otherwise-static
// HTML. Rather than port that same "React pokes at scattered ids" shape,
// this component owns the whole Info + Disk Space markup itself (the labels
// too, not just the values) — the more idiomatic React shape, and the same
// "component owns its subtree" shape the Tasks pilot already established.
// system-status.html's markup for these two cards was replaced with one
// container div for this to mount into.
// ---------------------------------------------------------------------------

function formatStartTime(iso) {
  return new Date(iso).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit',
  });
}

export default function StatusInfo() {
  const [status, setStatus] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/system/status')
      .then((res) => res.json())
      .then((s) => { if (!cancelled) setStatus(s); })
      .catch(() => { if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, []);

  return (
    <>
      <div className="settings-card">
        <h2>Info</h2>
        <div className="stat-grid" style={{ gridTemplateColumns: 'repeat(4, minmax(0,1fr))', marginBottom: '16px' }}>
          <div className="stat-card"><p className="label">Version</p><p className="value" style={{ fontSize: '15px' }}>{loadFailed ? 'Could not load status.' : (status ? status.version : '—')}</p></div>
          <div className="stat-card"><p className="label">Uptime</p><p className="value" style={{ fontSize: '15px' }}>{status ? status.uptime : '—'}</p></div>
          <div className="stat-card"><p className="label">Start Time</p><p className="value" style={{ fontSize: '15px' }}>{status ? formatStartTime(status.startTime) : '—'}</p></div>
          <div className="stat-card"><p className="label">OS</p><p className="value" style={{ fontSize: '15px' }}>{status ? status.os : '—'}</p></div>
          <div className="stat-card"><p className="label">Runtime</p><p className="value" style={{ fontSize: '15px' }}>{status ? status.nodeVersion : '—'}</p></div>
          <div className="stat-card"><p className="label">App Data</p><p className="value" style={{ fontSize: '13px' }}>{status ? status.appDataPath : '—'}</p></div>
          <div className="stat-card"><p className="label">Series</p><p className="value" style={{ fontSize: '15px' }}>{status ? `${status.seriesCount} (${status.monitoredCount} monitored)` : '—'}</p></div>
          <div className="stat-card"><p className="label">Episodes</p><p className="value" style={{ fontSize: '15px' }}>{status ? `${status.downloadedEpisodeCount} / ${status.episodeCount}` : '—'}</p></div>
        </div>
      </div>

      <div className="settings-card">
        <h2>Disk Space</h2>
        <p className="card-desc">Live free space for every configured root folder.</p>
        <div>
          {status && status.diskSpace.length === 0 && (
            <p className="settings-empty">No root folders configured yet.</p>
          )}
          {status && status.diskSpace.map((d) => (
            <div key={d.path} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '9px 0', borderBottom: '1px solid var(--border)', fontSize: '13px' }}>
              <span className="settings-meta" style={{ fontFamily: 'var(--font-mono)' }}>{d.path}</span>
              <span>{d.free} free</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
