import { useState } from 'react';
import { createPortal } from 'react-dom';
import { icons } from '../../lib/icons.jsx';

// ---------------------------------------------------------------------------
// System > Backup — a faithful port of public/js/pages/system-backup.js.
// Purely synthetic, same as before: no real backend behind any of this,
// "Restore" is a visual affordance only, "Backup Now"/remove just mutate a
// local list.
//
// The one structural wrinkle: "Backup Now" lives in the page's top-row,
// visually separate from the list it acts on (#backupList, below the
// column-header row). Rather than split this into two independent React
// roots with no shared state between them, this is one component with one
// `useState`, and the button renders via a portal into the top-row's
// placeholder (#backupNowBtnRoot in system-backup.html) — same component,
// same state, just rendered into two different places in the DOM.
// ---------------------------------------------------------------------------

const INITIAL_BACKUPS = [
  { id: 1, type: 'Scheduled', name: 'kitsune_backup_2026.08.03_030000.zip', size: '8.4 MB', date: 'Aug 3, 2026 03:00' },
  { id: 2, type: 'Scheduled', name: 'kitsune_backup_2026.07.27_030000.zip', size: '8.2 MB', date: 'Jul 27, 2026 03:00' },
  { id: 3, type: 'Manual', name: 'kitsune_backup_manual_2026.07.20.zip', size: '8.1 MB', date: 'Jul 20, 2026 14:32' },
  { id: 4, type: 'Scheduled', name: 'kitsune_backup_2026.07.20_030000.zip', size: '8.1 MB', date: 'Jul 20, 2026 03:00' },
];

export default function BackupPage({ buttonContainer }) {
  const [backups, setBackups] = useState(INITIAL_BACKUPS);

  function handleBackupNow() {
    setBackups((current) => {
      const nextId = current.length ? Math.max(...current.map((b) => b.id)) + 1 : 1;
      return [{ id: nextId, type: 'Manual', name: `kitsune_backup_manual_${nextId}.zip`, size: '8.4 MB', date: 'Just now' }, ...current];
    });
  }

  function handleRemove(id) {
    setBackups((current) => current.filter((b) => b.id !== id));
  }

  return (
    <>
      {buttonContainer && createPortal(
        <button className="btn-accent" type="button" onClick={handleBackupNow}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14" /></svg>
          Backup Now
        </button>,
        buttonContainer,
      )}
      {backups.length === 0 ? (
        <p className="settings-empty">No backups yet.</p>
      ) : (
        backups.map((b) => (
          <div className="backup-row" key={b.id}>
            <span className="audio-tag">{b.type}</span>
            <span className="settings-title">{b.name}</span>
            <span className="settings-meta">{b.size}</span>
            <span className="settings-meta">{b.date}</span>
            {/* 'restore' is a visual affordance only in this mockup, matching the old version */}
            <button className="btn-test" type="button">Restore</button>
            <button className="ep-action" type="button" aria-label={`Delete ${b.name}`} onClick={() => handleRemove(b.id)}>
              {icons.x}
            </button>
          </div>
        ))
      )}
    </>
  );
}
