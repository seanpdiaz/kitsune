import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { icons } from '../../lib/icons.jsx';
import { formatBytes } from '../../../public/js/lib/format.js';

// ---------------------------------------------------------------------------
// System > Backup — "Backup Now" and the list below are real now, backed by
// server/routes/backups.js: Backup Now gzips the live SQLite database (every
// real table this app has) into data/backups/, the list is read straight off
// that directory, and each row's new Download link streams the real file —
// previously there was no way to actually get a backup's bytes off the
// server at all, just a decorative "Restore" button and a fake local list
// (see git history / the wiki for the old all-synthetic version).
//
// "Restore" stays a visual affordance only — actually restoring live data
// over the running app is a separate, riskier feature nobody's asked for
// yet (see server/routes/backups.js's own comment). Every backup is manual
// now too: there's no scheduled-backup job anywhere in this app, so the old
// fake "Scheduled" rows are gone rather than kept as more decoration.
//
// The one structural wrinkle carried over from before: "Backup Now" lives in
// the page's top-row, visually separate from the list it acts on
// (#backupList, below the column-header row). Rather than split this into
// two independent React roots with no shared state between them, this is
// one component with its own state, and the button renders via a portal
// into the top-row's placeholder (#backupNowBtnRoot in system-backup.html)
// — same component, same state, just rendered into two different places in
// the DOM.
// ---------------------------------------------------------------------------

export default function BackupPage({ buttonContainer }) {
  const [backups, setBackups] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    let cancelled = false;
    fetch('/api/backups')
      .then((res) => res.json())
      .then((items) => { if (!cancelled) { setBackups(items); setLoaded(true); } })
      .catch(() => { if (!cancelled) { setBackups([]); setLoaded(true); } });
    return () => { cancelled = true; };
  }, []);

  async function handleBackupNow() {
    setCreating(true);
    setError('');
    try {
      const res = await fetch('/api/backups', { method: 'POST' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setBackups((current) => [body, ...current]);
    } catch {
      setError("Couldn't create a backup — try again.");
    } finally {
      setCreating(false);
    }
  }

  async function handleRemove(id) {
    setBackups((current) => current.filter((b) => b.id !== id));
    fetch(`/api/backups/${encodeURIComponent(id)}`, { method: 'DELETE' }).catch(() => {});
  }

  return (
    <>
      {buttonContainer && createPortal(
        <button className="btn-accent" type="button" disabled={creating} onClick={handleBackupNow}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14" /></svg>
          {creating ? 'Backing up…' : 'Backup Now'}
        </button>,
        buttonContainer,
      )}
      {error && <p className="form-error">{error}</p>}
      {!loaded ? (
        <p className="settings-empty">Loading…</p>
      ) : backups.length === 0 ? (
        <p className="settings-empty">No backups yet — click Backup Now to create one.</p>
      ) : (
        backups.map((b) => (
          <div className="backup-row" key={b.id}>
            <span className="audio-tag">Manual</span>
            <span className="settings-title">{b.name}</span>
            <span className="settings-meta">{formatBytes(b.sizeBytes)}</span>
            <span className="settings-meta">{new Date(b.createdAt).toLocaleString()}</span>
            {/* A real <button onClick> that navigates the window, not an
                <a href> — .btn-test's own rules assume a <button> (the base
                display:inline-flex/background/border styling comes from the
                plain `button` element selector in styles.css, not something
                .btn-test provides on its own), and every other .btn-test in
                this app is already a <button>. Navigating still triggers the
                browser's normal save-file behavior off the response's
                Content-Disposition header (see server/routes/backups.js). */}
            <button className="btn-test" type="button" onClick={() => { window.location.href = `/api/backups/${encodeURIComponent(b.id)}/download`; }}>
              {icons.download}Download
            </button>
            <button className="ep-action" type="button" aria-label={`Delete ${b.name}`} data-tooltip="Delete backup" onClick={() => handleRemove(b.id)}>
              {icons.x}
            </button>
          </div>
        ))
      )}
    </>
  );
}
