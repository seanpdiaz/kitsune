import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatBytes } from '../../../public/js/lib/format.js';
import { timeAgo } from '../../../public/js/lib/dates.js';

// Activity > History — a faithful port of public/js/pages/activity-history.js.
// Backed by the real, append-only GET /api/history (server/routes/queue.js
// writes to it on every grab, import, and simulated failure). Same portaled
// filter tabs pattern as System > Logs — one `type` state drives both.
//
// Show search: the search box (portaled next to the tabs) narrows the list
// to one show by name (?q=, matched server-side against the series title and
// release title), and clicking a show's name in any row pins the list to
// exactly that series (?seriesId=). Both combine with the type tabs and are
// mirrored into the page URL, so a filtered view survives a reload and can be
// linked to directly (e.g. activity-history.html?seriesId=12).

const HISTORY_TYPE_CLASS = { grabbed: 'status-info', imported: 'status-on', failed: 'status-fail', deleted: 'status-off' };
const HISTORY_TYPE_LABEL = { grabbed: 'Grabbed', imported: 'Imported', failed: 'Failed', deleted: 'Deleted' };
const TYPES = [
  { value: 'all', label: 'All' },
  { value: 'grabbed', label: 'Grabbed' },
  { value: 'imported', label: 'Imported' },
  { value: 'failed', label: 'Failed' },
  { value: 'deleted', label: 'Deleted' },
];
const SEARCH_DEBOUNCE_MS = 250;

function detailFor(h) {
  return h.eventType === 'imported' || h.eventType === 'grabbed'
    ? [h.releaseTitle, h.quality, h.sizeBytes ? formatBytes(h.sizeBytes) : null].filter(Boolean).join(' — ')
    : (h.message || h.releaseTitle || '');
}

function readInitialFilters() {
  const params = new URLSearchParams(window.location.search);
  const seriesId = parseInt(params.get('seriesId'), 10);
  return {
    type: TYPES.some((t) => t.value === params.get('type')) ? params.get('type') : 'all',
    query: params.get('q') || '',
    series: Number.isInteger(seriesId) ? { id: seriesId, title: null } : null,
  };
}

export default function HistoryList({ tabsContainer, searchContainer }) {
  const [initial] = useState(readInitialFilters);
  const [type, setType] = useState(initial.type);
  const [query, setQuery] = useState(initial.query); // what's typed in the box
  const [debouncedQuery, setDebouncedQuery] = useState(initial.query.trim()); // what's been searched
  const [series, setSeries] = useState(initial.series); // { id, title } when pinned to one show
  const [rows, setRows] = useState(null); // null = loading
  const [loadFailed, setLoadFailed] = useState(false);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQuery(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  // Keep the address bar in step with the filters (replaceState, so typing
  // doesn't flood the back button with one entry per keystroke).
  useEffect(() => {
    const params = new URLSearchParams();
    if (type !== 'all') params.set('type', type);
    if (series) params.set('seriesId', String(series.id));
    else if (debouncedQuery) params.set('q', debouncedQuery);
    const search = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${search ? `?${search}` : ''}`);
  }, [type, series, debouncedQuery]);

  useEffect(() => {
    let cancelled = false;
    setRows(null); // "Loading…" while this filter's request is in flight, matching the old version
    setLoadFailed(false);
    const params = new URLSearchParams();
    if (type !== 'all') params.set('type', type);
    if (series) params.set('seriesId', String(series.id));
    else if (debouncedQuery) params.set('q', debouncedQuery);
    const search = params.toString();
    fetch(`/api/history${search ? `?${search}` : ''}`)
      .then((res) => res.json())
      .then((body) => { if (!cancelled) setRows(body.history || []); })
      .catch(() => { if (!cancelled) setLoadFailed(true); });
    return () => { cancelled = true; };
  }, [type, series?.id, debouncedQuery]);

  // A seriesId that came in from the URL has no title yet — borrow it from
  // the first row that has one so the "Showing…" bar can name the show.
  useEffect(() => {
    if (series && !series.title && rows) {
      const title = rows.find((r) => r.seriesTitle)?.seriesTitle;
      if (title) setSeries((s) => (s && s.id === series.id ? { ...s, title } : s));
    }
  }, [rows, series]);

  function pinSeries(h) {
    setSeries({ id: h.seriesId, title: h.seriesTitle });
    setQuery(h.seriesTitle || '');
    setDebouncedQuery((h.seriesTitle || '').trim());
  }

  function clearShowFilter() {
    setSeries(null);
    setQuery('');
    setDebouncedQuery('');
  }

  function onQueryChange(value) {
    setQuery(value);
    if (series) setSeries(null); // typing something new un-pins the exact-series filter
  }

  const showFilterActive = Boolean(series || debouncedQuery);
  const showLabel = series ? (series.title || 'this series') : `“${debouncedQuery}”`;

  return (
    <>
      {tabsContainer && createPortal(
        TYPES.map((t) => (
          <button key={t.value} className={t.value === type ? 'active' : ''} onClick={() => setType(t.value)}>
            {t.label}
          </button>
        )),
        tabsContainer,
      )}
      {searchContainer && createPortal(
        <div className="search-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
          <input
            type="text"
            id="historySearch"
            placeholder="Search by show"
            aria-label="Search history by show"
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Escape') clearShowFilter(); }}
          />
        </div>,
        searchContainer,
      )}

      {showFilterActive && (
        <div className="history-filter-bar">
          <span>
            Showing {type === 'all' ? 'all events' : `${HISTORY_TYPE_LABEL[type].toLowerCase()} events`} for <strong>{showLabel}</strong>
            {rows && ` · ${rows.length} ${rows.length === 1 ? 'event' : 'events'}`}
          </span>
          {series && <a className="history-filter-link" href={`series.html?id=${series.id}`}>Open series</a>}
          <button type="button" className="history-filter-clear" onClick={clearShowFilter}>Clear</button>
        </div>
      )}

      {loadFailed && <p className="settings-empty">Could not load history.</p>}
      {!loadFailed && rows === null && <p className="settings-empty">Loading…</p>}
      {!loadFailed && rows && rows.length === 0 && (
        <p className="settings-empty">{showFilterActive ? `No history for ${showLabel}${type === 'all' ? '' : ' with this filter'}.` : 'No history for this filter.'}</p>
      )}
      {!loadFailed && rows && rows.map((h) => {
        const detail = detailFor(h);
        const canPin = h.seriesId != null && h.seriesTitle && !(series && series.id === h.seriesId);
        return (
          <div className="event-row" key={h.id}>
            <span className="ep-date">{timeAgo(h.createdAt)}</span>
            <span className={`status-pill ${HISTORY_TYPE_CLASS[h.eventType] || 'status-off'}`}>{HISTORY_TYPE_LABEL[h.eventType] || h.eventType}</span>
            <span className="settings-meta">
              {canPin
                ? <button type="button" className="history-series-link" title={`Show all events for ${h.seriesTitle}`} onClick={() => pinSeries(h)}>{h.seriesTitle}</button>
                : h.seriesTitle}
              {h.episodeLabel && `${h.seriesTitle ? ' ' : ''}${h.episodeLabel}`}
              {detail && `${h.seriesTitle || h.episodeLabel ? ' — ' : ''}${detail}`}
            </span>
          </div>
        );
      })}
    </>
  );
}
