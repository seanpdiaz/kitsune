import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { icons } from '../../lib/icons.jsx';
import { tagChipStyleObj as baseTagChipStyleObj } from '../../lib/tagChipStyleObj.js';

// React port of the Library grid half of public/js/pages/library.js (now
// deleted) — see README's "React migration" section. The series detail half
// of that same file is frontend/pages/series/SeriesPage.jsx; both pages
// used to share one module because they shared `seriesData`/loading logic,
// but as two separate React roots there's no such shared module-level state
// to preserve, so each page now just fetches what it needs on its own.

const badgeLabel = { airing: 'Airing', missing: 'Missing', downloading: 'Downloading', unmonitored: 'Unmonitored' };

const VALID_VIEWS = new Set(['poster', 'table', 'overview']);

// The episode-progress bar's color used to be a static `fill` column
// (accent/success/warning) hand-set once at series creation and never
// touched again — so a series could sit at 100% downloaded and still show
// whatever color it happened to be seeded/added with. It's computed here
// instead, live, from the same real `pct` (downloaded/total episodes,
// see server/lib/series-stats.js) that already drives the bar's width, so
// the color always means the same thing the width does: red-ish while
// badly behind, blending through the app's existing warning yellow, solid
// green once every episode is actually on disk. 0% renders neutral gray
// rather than alarming red — a freshly-added series with nothing grabbed
// yet hasn't failed anything, it just hasn't been searched.
const PROGRESS_NEUTRAL = '#6b6c78'; // var(--text-muted)
const PROGRESS_STOPS = [
  [237, 91, 101],  // var(--danger)  #ed5b65 — 0% (once above neutral)
  [242, 183, 5],   // var(--warning) #f2b705 — 50%
  [62, 213, 152],  // var(--success) #3ed598 — 100%
];
function mixRgb(a, b, t) {
  return a.map((v, i) => Math.round(v + (b[i] - v) * t));
}
function progressColor(pct) {
  if (!pct || pct <= 0) return PROGRESS_NEUTRAL;
  const t = Math.min(100, Math.max(0, pct)) / 100;
  const [r, g, b] = t <= 0.5
    ? mixRgb(PROGRESS_STOPS[0], PROGRESS_STOPS[1], t / 0.5)
    : mixRgb(PROGRESS_STOPS[1], PROGRESS_STOPS[2], (t - 0.5) / 0.5);
  return `rgb(${r}, ${g}, ${b})`;
}

// Poster size slider bounds/default — a 140px card (the grid's own unscaled
// base, see .series-grid in styles.css) scaled from 98px to 224px.
const POSTER_SCALE_MIN = 0.7;
const POSTER_SCALE_MAX = 1.6;
const POSTER_SCALE_DEFAULT = 1;

// The Library grid's own tag chips are shown a bit smaller (--tag-scale)
// than Settings > Tags' or the Edit Series modal's — same base color math,
// just an extra property layered on.
function tagChipStyleObj(hex) {
  return { '--tag-scale': 0.85, ...baseTagChipStyleObj(hex) };
}

// s.eps is always a real "N / M" string (server/lib/series-stats.js keeps
// it in sync with real per-episode downloaded flags, respecting each
// series' own Ignore Specials toggle — see routes/series.js). Shared by
// missingCountFor below (the "Missing episodes" stat card) and
// effectivePct further down (the Library progress bars' live-download
// blending) — same regex SeriesPage.jsx's own eps parsing uses.
function parseEpsCounts(s) {
  const m = /(\d+)\s*\/\s*(\d+)/.exec(s.eps || '');
  return m ? { done: parseInt(m[1], 10), total: parseInt(m[2], 10) } : null;
}

// Backs the "Missing episodes" stat card below — "missing" for one series
// is just its own M - N.
function missingCountFor(s) {
  const counts = parseEpsCounts(s);
  return counts ? Math.max(0, counts.total - counts.done) : 0;
}

// Blends a series' committed "N of M downloaded" progress with any
// currently-downloading episode's own real qBittorrent progress (see
// server/routes/queue.js's progress_pct, kept current by its background
// poll) so the Library bar visibly creeps forward while a torrent is still
// running, instead of sitting frozen at the same width until the episode
// finishes and the bar jumps a whole episode's worth at once. liveFraction
// is this series' downloading queue rows' progress_pct/100, summed (see
// the liveFractionBySeries memo below — a batch grab can have more than
// one episode downloading at once) — capped at however many episodes are
// actually still missing, so a stale or duplicated queue row can never
// push the bar past parseEpsCounts' own total, let alone past 100%.
function effectivePct(s, liveFraction) {
  const counts = parseEpsCounts(s);
  if (!counts || counts.total === 0 || !liveFraction) return s.pct;
  const remaining = counts.total - counts.done;
  const boosted = ((counts.done + Math.min(liveFraction, remaining)) / counts.total) * 100;
  return Math.min(100, Math.round(boosted));
}

function matchesFilter(s, filter) {
  switch (filter) {
    case 'monitored': return s.monitored;
    case 'missing': return s.badge === 'missing';
    case 'continuing': return s.status === 'continuing';
    case 'ended': return s.status === 'ended';
    default: return true;
  }
}

function sortSeries(list, sort) {
  const sorted = list.slice();
  if (sort === 'next-airing') {
    sorted.sort((a, b) => {
      if (a.nextAirDays == null && b.nextAirDays == null) return a.title.localeCompare(b.title);
      if (a.nextAirDays == null) return 1;
      if (b.nextAirDays == null) return -1;
      return a.nextAirDays - b.nextAirDays;
    });
  } else if (sort === 'recently-added') {
    sorted.sort((a, b) => a.addedDaysAgo - b.addedDaysAgo);
  } else {
    sorted.sort((a, b) => a.title.localeCompare(b.title));
  }
  return sorted;
}

// Shared across Table and Overview (Poster never shows a status word, just
// the small attention badge over the poster itself) — badge takes priority
// when present since it means "something worth noticing," otherwise falls
// back to the plain continuing/ended status every series has.
function statusChipFor(s) {
  if (s.badge) return { label: badgeLabel[s.badge], cls: s.badge };
  return s.status === 'ended' ? { label: 'Ended', cls: 'ended' } : { label: 'Continuing', cls: 'continuing' };
}

// Same shortening SeriesPage.jsx applies to its own "Next airing" stat card
// — MAL's full-sentence status labels ("Finished Airing", etc.) are too long
// for a small table/overview cell. Display-only; the real label is still
// what's stored.
const SHORT_AIR_STATUS = {
  'Finished Airing': 'Ended',
  'Currently Airing': 'Airing',
  'Not Yet Aired': 'Upcoming',
};
function nextAiringText(s) {
  if (s.nextAirDays != null) return `in ${s.nextAirDays}d`;
  if (s.airStatus) return SHORT_AIR_STATUS[s.airStatus] || s.airStatus;
  if (s.status === 'ended') return 'Ended';
  return '—';
}

function TagChips({ s, tags }) {
  if (!s.tagIds || s.tagIds.length === 0) return null;
  const byId = new Map(tags.map((t) => [t.id, t]));
  const resolved = s.tagIds.map((id) => byId.get(id)).filter(Boolean);
  if (resolved.length === 0) return null;
  return (
    <span className="library-tags">
      {resolved.map((t) => <span className="tag-chip" style={tagChipStyleObj(t.color)} key={t.id}>{t.name}</span>)}
    </span>
  );
}

function PosterCard({ s }) {
  return (
    <a className="series-card" href={`series.html?id=${s.id}`}>
      <div className="poster">
        {s.poster && <img src={s.poster} alt={`${s.title} poster`} loading="lazy" />}
        {s.badge && <span className={`badge ${s.badge}`}>{badgeLabel[s.badge]}</span>}
      </div>
      <div className="card-body">
        <p className="card-title">{s.title}</p>
        <div className="progress"><div className="fill" style={{ width: `${s.pct}%`, background: progressColor(s.pct) }} /></div>
      </div>
    </a>
  );
}

function TableRow({ s, tags }) {
  const chip = statusChipFor(s);
  return (
    <a className="series-table-row" href={`series.html?id=${s.id}`}>
      <span className="series-table-name">
        <span className="series-table-thumb">{s.poster && <img src={s.poster} alt="" loading="lazy" />}</span>
        <span className="card-title" style={{ margin: 0, whiteSpace: 'normal' }}>{s.title}</span>
      </span>
      <span><span className={`status-chip ${chip.cls}`}>{chip.label}</span></span>
      <span className="series-table-eps">
        <span className="ep-date">{s.eps}</span>
        <div className="progress"><div className="fill" style={{ width: `${s.pct}%`, background: progressColor(s.pct) }} /></div>
      </span>
      <span className="settings-meta">{s.qualityProfile || '—'}</span>
      <span className="ep-date">{nextAiringText(s)}</span>
      <span>{s.tagIds && s.tagIds.length > 0 ? <TagChips s={s} tags={tags} /> : <span style={{ color: 'var(--text-muted)' }}>—</span>}</span>
      <span style={{ color: 'var(--text-secondary)' }}>{s.monitored ? icons.check : icons.x}</span>
    </a>
  );
}

function OverviewRow({ s, tags }) {
  const chip = statusChipFor(s);
  return (
    <a className="series-overview-row" href={`series.html?id=${s.id}`}>
      <div className="overview-poster">
        {s.poster && <img src={s.poster} alt={`${s.title} poster`} loading="lazy" />}
        {s.badge && <span className={`badge ${s.badge}`}>{badgeLabel[s.badge]}</span>}
      </div>
      <div className="overview-body">
        <div className="overview-top">
          <p className="overview-title">{s.title}</p>
          <span className={`status-chip ${chip.cls}`}>{chip.label}</span>
        </div>
        <p className="overview-meta">{s.meta || '—'}{s.monitored ? '' : ' · Unmonitored'}</p>
        <p className="overview-desc">{s.overview || 'No overview available yet.'}</p>
        <div className="overview-footer">
          <div className="progress"><div className="fill" style={{ width: `${s.pct}%`, background: progressColor(s.pct) }} /></div>
          <span>{s.eps} episodes</span>
          <span>{s.qualityProfile || 'No quality profile'}</span>
          <span>{nextAiringText(s)}</span>
          <TagChips s={s} tags={tags} />
        </div>
      </div>
    </a>
  );
}

// Disk usage stat card — polls while server/lib/disk-usage.js's background
// scan is still computing, stops the moment it isn't (same "poll while
// true" shape as System > Tasks' own progress bar). Self-contained since
// nothing else on this page depends on it.
function DiskUsageStat() {
  const [text, setText] = useState('—');
  const [title, setTitle] = useState(undefined);

  useEffect(() => {
    let cancelled = false;
    let timer = null;
    function poll() {
      fetch('/api/system/status')
        .then((res) => res.json())
        .then((s) => {
          if (cancelled) return;
          if (s.diskUsageBytes == null) {
            setText(s.diskUsageComputing ? 'Calculating…' : s.diskUsageFormatted);
          } else {
            setText(s.diskUsageFormatted + (s.diskUsageComputing ? ' (updating…)' : ''));
          }
          if (s.diskUsageComputedAt) setTitle(`As of ${new Date(s.diskUsageComputedAt).toLocaleString()}`);
          if (s.diskUsageComputing) timer = setTimeout(poll, 2000);
        })
        .catch(() => { if (!cancelled) setText('—'); });
    }
    poll();
    return () => { cancelled = true; clearTimeout(timer); };
  }, []);

  return <p className="value" id="diskUsageStat" title={title}>{text}</p>;
}

export default function LibraryGridPage({ searchContainer }) {
  const [seriesData, setSeriesData] = useState([]);
  const [seriesLoaded, setSeriesLoaded] = useState(false);
  const [seriesLoadError, setSeriesLoadError] = useState(false);
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState('title');
  const [query, setQuery] = useState('');
  const [view, setView] = useState('poster');
  const [tags, setTags] = useState([]);
  const tagsLoadedRef = useRef(false);
  // Backs the "Downloading" stat card — a real count of active grabs, not a
  // per-series field: series.badge (what a "Downloading"-labeled stat would
  // naturally reach for) turns out to be dead data, only ever set by the
  // original seed rows and never updated by anything real since (see
  // routes/series.js's SERIES_SEED and POST /api/series, which never even
  // sets it). The queue table is the one place download state is actually
  // live (server/routes/queue.js's background poll keeps status/progress_pct
  // current), so this counts real 'downloading' rows there instead — 'paused'
  // rows are deliberately excluded, since a paused grab isn't currently
  // downloading. Fetched once on mount, same as seriesData below; doesn't
  // poll for live updates, so a grab starting/finishing while this page is
  // open won't move the number until it's reloaded.
  const [downloadingCount, setDownloadingCount] = useState(0);
  // Raw /api/queue rows, kept around (not just the downloadingCount above)
  // so each series' progress bar can blend in its own in-progress episode's
  // live torrent percentage — see liveFractionBySeries/effectivePct below.
  // Same one-time, non-polling fetch as downloadingCount: a grab's progress
  // moving while this page sits open won't animate the bar until reload.
  const [queueRows, setQueueRows] = useState([]);

  // Poster size slider (Poster view only). Written straight to the grid's
  // own CSS custom property via refs, the same imperative pattern Settings
  // > Tags' cloud-size slider already uses (see TagsPage.jsx) — a drag
  // shouldn't cause a React re-render of every card, just a CSS relayout of
  // the existing DOM nodes. Both this and `view` above are real per-user
  // preferences, loaded from and saved to /api/user-prefs/library-ui-prefs
  // (see server/routes/user-prefs.js) — one record per signed-in user, not
  // a single value shared by the whole server or a browser-local
  // localStorage entry, which is what each of these used to be before user
  // accounts existed to hang a real per-user record off of. Size saves are
  // debounced the same 400ms every other settings control in this app uses;
  // view changes save immediately, same as before.
  const gridRef = useRef(null);
  const posterSliderRef = useRef(null);
  const posterScaleRef = useRef(POSTER_SCALE_DEFAULT);
  const posterSaveTimerRef = useRef(null);

  function applyPosterScale(value) {
    if (gridRef.current) gridRef.current.style.setProperty('--poster-scale', value);
    const slider = posterSliderRef.current;
    if (!slider) return;
    slider.value = value;
    const min = Number(slider.min);
    const max = Number(slider.max);
    const pct = ((value - min) / (max - min)) * 100;
    slider.style.background = `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pct}%, var(--surface-3) ${pct}%, var(--surface-3) 100%)`;
  }

  function handlePosterSliderInput() {
    const slider = posterSliderRef.current;
    if (!slider) return;
    const value = Number(slider.value);
    posterScaleRef.current = value;
    applyPosterScale(value);
    clearTimeout(posterSaveTimerRef.current);
    posterSaveTimerRef.current = setTimeout(() => {
      fetch('/api/user-prefs/library-ui-prefs', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posterSize: value }),
      }).catch(() => {});
    }, 400);
  }

  // Load this user's saved view + poster size once on mount, in the one
  // fetch — both fields live in the same /api/user-prefs/library-ui-prefs
  // record. applyPosterScale() is a no-op on whichever ref (grid/slider)
  // isn't around yet, same as before; setView() only fires for a genuinely
  // valid stored value, so an empty/first-visit response (or a request that
  // fails outright — e.g. offline) just leaves the 'poster'/default-scale
  // state this component already started with.
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/user-prefs/library-ui-prefs');
        const saved = await res.json();
        if (VALID_VIEWS.has(saved.view)) setView(saved.view);
        const value = Number(saved.posterSize);
        if (value >= POSTER_SCALE_MIN && value <= POSTER_SCALE_MAX) posterScaleRef.current = value;
      } catch { /* defaults stand */ }
      applyPosterScale(posterScaleRef.current);
    })();
  }, []);

  // The slider only exists in the DOM while view === 'poster' (it's
  // conditionally rendered below), so re-apply the current value and
  // (re)wire its input listener every time it (re)mounts — e.g. switching
  // back to Poster from Table/Overview.
  useEffect(() => {
    if (view !== 'poster') return;
    applyPosterScale(posterScaleRef.current);
    const slider = posterSliderRef.current;
    if (!slider) return;
    slider.addEventListener('input', handlePosterSliderInput);
    return () => slider.removeEventListener('input', handlePosterSliderInput);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/series');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        setSeriesData(await res.json());
        setSeriesLoaded(true);
      } catch {
        setSeriesLoadError(true);
      }
    })();
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/queue');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        const rows = Array.isArray(body.queue) ? body.queue : [];
        setDownloadingCount(rows.filter((q) => q.status === 'downloading').length);
        setQueueRows(rows);
      } catch {
        // Stat card just falls back to 0 rather than blocking the rest of
        // the page — same "a failed secondary fetch shouldn't break Library
        // loading" rule DiskUsageStat's own catch below already follows.
      }
    })();
  }, []);

  // Sums each downloading queue row's progress_pct/100 by series — a
  // series with two episodes grabbing at once (a batch) gets credit for
  // both. Recomputed only when queueRows itself changes, not on every
  // render (filter/sort/search all touch this component far more often
  // than the once-on-mount queue fetch does).
  const liveFractionBySeries = useMemo(() => {
    const map = new Map();
    for (const q of queueRows) {
      if (q.status !== 'downloading') continue;
      const frac = (Number(q.progressPct) || 0) / 100;
      map.set(q.seriesId, (map.get(q.seriesId) || 0) + frac);
    }
    return map;
  }, [queueRows]);

  // Tags aren't part of the Poster view at all, but both Table and Overview
  // show them — fetched once, lazily, the first time either view actually
  // needs them rather than unconditionally on every Library page load.
  useEffect(() => {
    if (view === 'poster' || tagsLoadedRef.current) return;
    tagsLoadedRef.current = true;
    (async () => {
      try {
        const res = await fetch('/api/tags');
        setTags(await res.json());
      } catch {
        setTags([]);
      }
    })();
  }, [view]);

  function handleViewChange(nextView) {
    setView(nextView);
    fetch('/api/user-prefs/library-ui-prefs', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ view: nextView }),
    }).catch(() => {});
  }

  // Backs the "Series"/"Missing episodes" stat cards below. Both used to be
  // hardcoded literal numbers, always showing whatever the original mockup
  // was seeded with regardless of what's actually in the Library. Missing
  // episodes only counts monitored series — an unmonitored series' own
  // missing count doesn't mean anything you'd want surfaced here, since
  // monitored=false means Kitsune isn't trying to get those episodes in the
  // first place; it takes precedence over everything else (Ignore Specials,
  // status, filters), not just one factor among several.
  const seriesCount = seriesData.length;
  const missingEpisodesCount = seriesData
    .filter((s) => s.monitored)
    .reduce((sum, s) => sum + missingCountFor(s), 0);

  let gridContent;
  let gridClassName = 'series-grid';

  if (seriesLoadError) {
    gridContent = <p style={{ color: 'var(--text-muted)', gridColumn: '1 / -1' }}>Couldn't load your library. Is the server running?</p>;
  } else if (!seriesLoaded) {
    gridContent = <p style={{ color: 'var(--text-muted)', gridColumn: '1 / -1' }}>Loading…</p>;
  } else {
    const q = query.trim().toLowerCase();
    let list = seriesData.filter((s) => matchesFilter(s, filter));
    if (q) list = list.filter((s) => s.title.toLowerCase().includes(q));
    list = sortSeries(list, sort);
    // Display-only override: the bar should reflect committed downloads
    // plus whatever's actively grabbing right now, but nothing else here
    // (filtering, sorting, missingCountFor above) should see the boosted
    // number — see effectivePct's own comment for why.
    list = list.map((s) => ({ ...s, pct: effectivePct(s, liveFractionBySeries.get(s.id)) }));

    if (list.length === 0) {
      gridContent = <p style={{ color: 'var(--text-muted)', gridColumn: '1 / -1' }}>No series match your filters.</p>;
    } else if (view === 'table') {
      gridClassName = 'series-table';
      gridContent = (
        <>
          <div className="series-table-header">
            <span>Series</span><span>Status</span><span>Episodes</span><span>Quality Profile</span><span>Next Airing</span><span>Tags</span><span>Monitored</span>
          </div>
          {list.map((s) => <TableRow s={s} tags={tags} key={s.id} />)}
        </>
      );
    } else if (view === 'overview') {
      gridClassName = '';
      gridContent = <div className="series-overview-list">{list.map((s) => <OverviewRow s={s} tags={tags} key={s.id} />)}</div>;
    } else {
      gridContent = list.map((s) => <PosterCard s={s} key={s.id} />);
    }
  }

  return (
    <>
      {searchContainer && createPortal(
        <div className="search-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
          <input type="text" id="librarySearch" placeholder="Search library" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>,
        searchContainer,
      )}

      <div className="stat-grid">
        <div className="stat-card"><p className="label">Series</p><p className="value">{seriesLoaded ? seriesCount : '—'}</p></div>
        <div className="stat-card"><p className="label">Missing episodes</p><p className="value" style={{ color: 'var(--warning)' }}>{seriesLoaded ? missingEpisodesCount : '—'}</p></div>
        <div className="stat-card"><p className="label">Downloading</p><p className="value" style={{ color: 'var(--accent)' }}>{downloadingCount}</p></div>
        <div className="stat-card"><p className="label">Disk usage</p><DiskUsageStat /></div>
      </div>

      <div className="filter-row">
        <div className="tabs">
          {[['all', 'All'], ['monitored', 'Monitored'], ['missing', 'Missing'], ['continuing', 'Continuing'], ['ended', 'Ended']].map(([key, label]) => (
            <button key={key} className={filter === key ? 'active' : ''} onClick={() => setFilter(key)}>{label}</button>
          ))}
        </div>
        <div className="filter-row-right">
          <select value={sort} onChange={(e) => setSort(e.target.value)}>
            <option value="title">Sort: title A–Z</option>
            <option value="next-airing">Sort: next airing</option>
            <option value="recently-added">Sort: recently added</option>
          </select>
          {view === 'poster' && (
            <div className="poster-size-control">
              <span className="poster-size-label">Size</span>
              <input
                ref={posterSliderRef} className="size-slider" type="range"
                min={POSTER_SCALE_MIN} max={POSTER_SCALE_MAX} step="0.1"
                defaultValue={POSTER_SCALE_DEFAULT} aria-label="Poster size"
              />
            </div>
          )}
          <div className="view-toggle">
            <button type="button" className={view === 'poster' ? 'active' : ''} aria-label="Poster view" data-tooltip="Poster view" onClick={() => handleViewChange('poster')}>{icons.viewPoster}</button>
            <button type="button" className={view === 'table' ? 'active' : ''} aria-label="Table view" data-tooltip="Table view" onClick={() => handleViewChange('table')}>{icons.viewTable}</button>
            <button type="button" className={view === 'overview' ? 'active' : ''} aria-label="Overview view" data-tooltip="Overview view" onClick={() => handleViewChange('overview')}>{icons.viewOverview}</button>
          </div>
        </div>
      </div>

      <div className={gridClassName} id="seriesGrid" ref={gridRef}>{gridContent}</div>
    </>
  );
}
