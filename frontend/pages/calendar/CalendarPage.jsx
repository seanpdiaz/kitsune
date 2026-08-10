import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

// Calendar — a faithful port of public/js/pages/calendar.js. Real air dates
// from GET /api/calendar (server.js reads straight from the `episodes`
// table — the same cache the series detail page fills in on first visit).
// A series that's never had its detail page opened has no cached episodes,
// so it has nothing to show up here either — the "N series haven't loaded
// their episodes yet" note explains a calendar that looks emptier than the
// Library actually is.
//
// The month toolbar (prev/next/today) lives in the page's .top-row,
// separate from the weekday header + grid below it — same portal pattern as
// System > Backup/Events/Logs and Wanted > Missing/Cutoff Unmet's "Search
// All", just with three pieces of rendered output (note, weekdays, grid)
// sharing the one piece of state instead of one button.

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const today = new Date();
const todayIso = isoDate(today);

// seasonNumber 0 is TVDB's convention for specials (see the Episode
// persistence section in server.js) — "Special 3" reads better than "S00E03".
function episodeLabel(ep) {
  return ep.seasonNumber === 0 ? `Special ${ep.num}` : `S${pad(ep.seasonNumber)}E${pad(ep.num)}`;
}

export default function CalendarPage({ toolbarContainer }) {
  const [viewYear, setViewYear] = useState(today.getFullYear());
  const [viewMonth, setViewMonth] = useState(today.getMonth()); // 0-based, matches Date's own convention
  const [episodesByDate, setEpisodesByDate] = useState(null); // null = loading
  const [loadFailed, setLoadFailed] = useState(false);
  const [uncachedCount, setUncachedCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const start = new Date(viewYear, viewMonth, 1);
    const end = new Date(viewYear, viewMonth + 1, 1);
    setEpisodesByDate(null);
    setLoadFailed(false);
    fetch(`/api/calendar?start=${isoDate(start)}&end=${isoDate(end)}`)
      .then((res) => res.json())
      .then((data) => {
        if (cancelled) return;
        const byDate = new Map();
        for (const ep of (data.episodes || [])) {
          if (!ep.aired) continue;
          if (!byDate.has(ep.aired)) byDate.set(ep.aired, []);
          byDate.get(ep.aired).push(ep);
        }
        setEpisodesByDate(byDate);
        setUncachedCount(data.uncachedSeriesCount || 0);
      })
      .catch(() => { if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, [viewYear, viewMonth]);

  function goPrev() {
    if (viewMonth === 0) { setViewMonth(11); setViewYear((y) => y - 1); } else { setViewMonth((m) => m - 1); }
  }
  function goNext() {
    if (viewMonth === 11) { setViewMonth(0); setViewYear((y) => y + 1); } else { setViewMonth((m) => m + 1); }
  }
  function goToday() {
    setViewYear(today.getFullYear());
    setViewMonth(today.getMonth());
  }

  const monthLabel = new Date(viewYear, viewMonth, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  const cells = [];
  if (episodesByDate) {
    const firstOfMonth = new Date(viewYear, viewMonth, 1);
    const startOffset = firstOfMonth.getDay(); // days to back up to the preceding Sunday
    const gridStart = new Date(viewYear, viewMonth, 1 - startOffset);
    const totalCells = 42; // a fixed 6-week grid keeps the layout the same height every month
    for (let i = 0; i < totalCells; i++) {
      const cellDate = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
      const iso = isoDate(cellDate);
      const isOutside = cellDate.getMonth() !== viewMonth;
      const isToday = iso === todayIso;
      const dayEpisodes = episodesByDate.get(iso) || [];
      const shown = dayEpisodes.slice(0, 3);
      const extra = dayEpisodes.length - shown.length;
      cells.push(
        <div key={iso} className={`calendar-day${isOutside ? ' is-outside-month' : ''}${isToday ? ' is-today' : ''}`}>
          <span className="calendar-day-num">{cellDate.getDate()}</span>
          {shown.map((ep) => (
            <a
              key={ep.episodeId ?? `${ep.seriesId}-${episodeLabel(ep)}`}
              className="calendar-episode"
              href={`series.html?id=${ep.seriesId}`}
              title={`${ep.seriesTitle} — ${episodeLabel(ep)}${ep.title ? ` — ${ep.title}` : ''}`}
            >
              {ep.seriesTitle} <span className="ep-num">{episodeLabel(ep)}</span>
            </a>
          ))}
          {extra > 0 && <span className="calendar-day-more">{`+${extra} more`}</span>}
        </div>,
      );
    }
  }

  return (
    <>
      {toolbarContainer && createPortal(
        <>
          <button type="button" className="calendar-nav-btn" aria-label="Previous month" onClick={goPrev}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M15 18l-6-6 6-6" /></svg>
          </button>
          <span className="calendar-month-label">{episodesByDate === null && !loadFailed ? 'Loading…' : monthLabel}</span>
          <button type="button" className="calendar-nav-btn" aria-label="Next month" onClick={goNext}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M9 18l6-6-6-6" /></svg>
          </button>
          <button type="button" onClick={goToday}>Today</button>
        </>,
        toolbarContainer,
      )}

      {loadFailed ? (
        <p className="settings-empty">Couldn't load the calendar — network error.</p>
      ) : episodesByDate === null ? (
        <p className="settings-empty">Loading…</p>
      ) : (
        <>
          <p className={`calendar-uncached-note${uncachedCount > 0 ? '' : ' is-collapsed'}`}>
            {uncachedCount > 0 && `${uncachedCount} series in your Library ${uncachedCount === 1 ? "hasn't" : "haven't"} had its episodes loaded yet — open a series' detail page once to have it show up here.`}
          </p>
          <div className="calendar-weekdays">
            {WEEKDAYS.map((d) => <span key={d}>{d}</span>)}
          </div>
          <div className="calendar-grid">{cells}</div>
        </>
      )}
    </>
  );
}
