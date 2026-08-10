import { useState } from 'react';
import { createPortal } from 'react-dom';

// System > Events — a faithful port of public/js/pages/system-events.js.
// Same "Clear Events" button in the top-row rendered via a portal, same
// shared state, same shape as System > Backup — see that page's
// BackupPage.jsx for the fuller explanation of why a portal here rather
// than two independent React roots.

const INITIAL_EVENTS = [
  { id: 1, time: '14:32:08', level: 'Grab', message: 'Sent "Chainsaw Man - 011 - Rescue [WEBDL-1080p]" to qBittorrent' },
  { id: 2, time: '14:28:51', level: 'Import', message: 'Imported Frieren S02E21 "Report from the Capital"' },
  { id: 3, time: '14:10:03', level: 'Health', message: 'Indexer AniDex test failed: connection timed out' },
  { id: 4, time: '13:55:44', level: 'Import List', message: 'Sync completed for "Anichart — Seasonal"' },
  { id: 5, time: '13:40:12', level: 'Series Added', message: 'Added "Bocchi the Rock" to library' },
  { id: 6, time: '13:12:09', level: 'Health', message: 'Download client SABnzbd unreachable' },
  { id: 7, time: '12:58:37', level: 'Grab', message: 'Sent "Jujutsu Kaisen - S02E22" to qBittorrent' },
];

const EVENT_LEVEL_CLASS = {
  Grab: 'status-info', Import: 'status-on', Health: 'status-warn',
  'Import List': 'status-info', 'Series Added': 'status-on',
};

export default function EventFeed({ buttonContainer }) {
  const [events, setEvents] = useState(INITIAL_EVENTS);

  return (
    <>
      {buttonContainer && createPortal(
        <button className="btn-accent" type="button" onClick={() => setEvents([])}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14" /></svg>
          Clear Events
        </button>,
        buttonContainer,
      )}
      {events.length === 0 ? (
        <p className="settings-empty">No events yet.</p>
      ) : (
        events.map((e) => (
          <div className="event-row" key={e.id}>
            <span className="ep-date">{e.time}</span>
            <span className={`status-pill ${EVENT_LEVEL_CLASS[e.level] || 'status-off'}`}>{e.level}</span>
            <span className="settings-meta">{e.message}</span>
          </div>
        ))
      )}
    </>
  );
}
