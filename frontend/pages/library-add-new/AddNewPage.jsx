import { useEffect, useRef, useState } from 'react';
import { icons } from '../../lib/icons.jsx';

// React port of initAddNew in public/js/pages/library-add-new.js — see
// README's "React migration" section. Results come live from MyAnimeList's
// official API through /api/mal/search (server.js's handleMalApi), falling
// back to TVDB search if MAL is down (source: 'tvdb' on a result, flagged
// on the card/preview so it's clear where the data came from, not silently
// different).

function libraryMatchFor(libraryIndex, s) {
  const byExternal = s.source && s.id !== undefined ? libraryIndex.byExternal.get(`${s.source}:${s.id}`) : null;
  if (byExternal) return byExternal;
  const title = String(s.title || '').trim().toLowerCase();
  return (title && libraryIndex.byTitle.get(title)) || null;
}

function withMatch(libraryIndex, match, entry) {
  const byExternal = new Map(libraryIndex.byExternal);
  const byTitle = new Map(libraryIndex.byTitle);
  byExternal.set(`${match.source}:${match.id}`, entry);
  byTitle.set(String(match.title).trim().toLowerCase(), entry);
  return { byExternal, byTitle };
}

function PreviewTag({ children }) {
  return <span className="preview-tag">{children}</span>;
}

function PreviewBody({ s }) {
  const tags = [];
  if (s.mediaType) tags.push(<PreviewTag key="type">{s.mediaType.toUpperCase()}</PreviewTag>);
  if (s.status) tags.push(<PreviewTag key="status">{s.status.replace(/_/g, ' ')}</PreviewTag>);
  if (typeof s.numEpisodes === 'number') tags.push(<PreviewTag key="eps">{s.numEpisodes} episodes</PreviewTag>);
  if (typeof s.score === 'number') tags.push(<PreviewTag key="score">★ {s.score.toFixed(2)}</PreviewTag>);
  (s.genres || []).forEach((g) => tags.push(<PreviewTag key={`genre-${g}`}>{g}</PreviewTag>));

  return (
    <>
      <div className="preview-poster">{s.poster && <img src={s.poster} alt={`${s.title} poster`} />}</div>
      <div className="preview-details">
        <h3>{s.title}{s.year && <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}> ({s.year})</span>}</h3>
        {tags.length > 0 && <div className="preview-meta-row">{tags}</div>}
        <p className="preview-overview">{s.overview || 'No overview available.'}</p>
        {(s.altTitleJapanese || (s.altTitleSynonyms && s.altTitleSynonyms.length) || (s.studios && s.studios.length)) && (
          <div className="preview-alt-titles">
            {s.altTitleJapanese && <p><strong>Japanese:</strong> {s.altTitleJapanese}</p>}
            {s.altTitleSynonyms && s.altTitleSynonyms.length > 0 && <p><strong>Also known as:</strong> {s.altTitleSynonyms.join(', ')}</p>}
            {s.studios && s.studios.length > 0 && <p><strong>Studio:</strong> {s.studios.join(', ')}</p>}
          </div>
        )}
        {s.source === 'tvdb' && <p className="preview-source-note">via TheTVDB (MyAnimeList unavailable)</p>}
      </div>
    </>
  );
}

function SeriesCard({ s, already, justAdded, onPreview, onAdd }) {
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');

  async function handleAdd(e) {
    e.stopPropagation();
    setAdding(true);
    setError('');
    try {
      await onAdd(s);
    } catch {
      setError("Couldn't add this series — try again.");
    }
    setAdding(false);
  }

  const sourceBadge = s.source === 'tvdb'
    ? <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}> · via TheTVDB (MAL unavailable)</span>
    : null;

  let actionEl;
  if (already) {
    actionEl = (
      <a
        className="card-added" href={`series.html?id=${already.id}`}
        title={justAdded ? undefined : `Already in your Library as "${already.title}"`}
      >
        {icons.check}{justAdded ? 'Added' : 'In Library'}
      </a>
    );
  } else {
    actionEl = (
      <button className="btn-accent" type="button" disabled={adding} title={error || undefined} onClick={handleAdd}>
        {icons.plus}{adding ? 'Adding…' : 'Add Series'}
      </button>
    );
  }

  return (
    <div className="series-card" data-id={s.id}>
      <div className="poster" onClick={() => onPreview(s)}>{s.poster && <img src={s.poster} alt={`${s.title} poster`} loading="lazy" />}</div>
      <div className="card-body">
        <p className="card-title" onClick={() => onPreview(s)}>
          {s.title} {s.year && <span style={{ color: 'var(--text-muted)', fontWeight: 500 }}>({s.year})</span>}{sourceBadge}
        </p>
        <p className="card-overview" onClick={() => onPreview(s)}>{s.overview || 'No overview available.'}</p>
        <div className="card-actions">
          <button type="button" onClick={() => onPreview(s)}>Preview</button>
          {actionEl}
        </div>
      </div>
    </div>
  );
}

export default function AddNewPage() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [state, setState] = useState('idle'); // 'idle' | 'loading' | 'ok' | 'empty' | 'error'
  const [errorMessage, setErrorMessage] = useState('');
  const [addedIds, setAddedIds] = useState(() => new Set());
  const [libraryIndex, setLibraryIndex] = useState({ byExternal: new Map(), byTitle: new Map() });
  const [previewedResult, setPreviewedResult] = useState(null);
  const [previewAdding, setPreviewAdding] = useState(false);

  const requestSeqRef = useRef(0);
  const debounceRef = useRef(null);

  async function loadLibraryIndex() {
    try {
      const res = await fetch('/api/series');
      const rows = await res.json();
      const byExternal = new Map();
      const byTitle = new Map();
      for (const row of rows) {
        if (row.externalSource && row.externalId) byExternal.set(`${row.externalSource}:${row.externalId}`, row);
        if (row.title) byTitle.set(row.title.trim().toLowerCase(), row);
      }
      setLibraryIndex({ byExternal, byTitle });
    } catch {
      // Leave libraryIndex empty — worst case, someone clicks "Add Series"
      // on something already in the Library and the server's own 409 check
      // catches it instead of the UI pre-empting it.
    }
  }

  async function runSearch(q) {
    const seq = ++requestSeqRef.current;
    setState('loading');
    try {
      const res = await fetch(`/api/mal/search?q=${encodeURIComponent(q)}`);
      const data = await res.json();
      if (seq !== requestSeqRef.current) return; // a newer keystroke superseded this request
      if (!res.ok) {
        setState('error');
        setErrorMessage((data && data.error) || `HTTP ${res.status}`);
        return;
      }
      setResults(data);
      setState(data.length === 0 ? 'empty' : 'ok');
    } catch {
      if (seq !== requestSeqRef.current) return;
      setState('error');
      setErrorMessage('network error');
    }
  }

  useEffect(() => {
    (async () => {
      await loadLibraryIndex();
      // Arriving here with ?q=<title> (e.g. from Library Import's "Search on
      // Add New" link for an unmatched root-folder subfolder) pre-fills the
      // search box and runs it immediately, instead of making the user
      // retype the title it already guessed from the folder name.
      const prefillQuery = new URLSearchParams(window.location.search).get('q');
      if (prefillQuery) {
        setQuery(prefillQuery);
        runSearch(prefillQuery.trim());
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSearchInput(value) {
    setQuery(value);
    clearTimeout(debounceRef.current);
    const q = value.trim();
    if (!q) {
      requestSeqRef.current++; // invalidate any in-flight request
      setState('idle');
      return;
    }
    debounceRef.current = setTimeout(() => runSearch(q), 400);
  }

  // Shared by the card's own "Add Series" button and the preview modal's —
  // same request, same duplicate handling, so the two entry points can't
  // drift apart.
  async function addSeries(match) {
    const res = await fetch('/api/series', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: match.title,
        year: match.year,
        overview: match.overview,
        poster: match.poster,
        id: match.id,
        source: match.source,
        status: match.status,
        altTitles: [match.titleNative, match.altTitleJapanese, ...(match.altTitleSynonyms || [])].filter(Boolean),
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 409) {
      // Someone/something beat us to it — another tab, or our own pre-check
      // missed it. Fold it into libraryIndex so this result (and any other
      // card for the same show) immediately shows "In Library" instead of a
      // live "Add Series" button that would just 409 again.
      if (body.existingId) {
        setLibraryIndex((prev) => withMatch(prev, match, { id: body.existingId, title: match.title }));
      }
      return;
    }
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    // This is the part that actually lands the series in the Library —
    // without this POST, clicking Add Series only ever changed local button
    // state on this page and nothing else.
    setAddedIds((prev) => new Set(prev).add(String(match.id)));
    if (body && body.id) setLibraryIndex((prev) => withMatch(prev, match, body));
  }

  function openPreview(s) {
    setPreviewedResult(s);
  }
  function closePreview() {
    setPreviewedResult(null);
  }

  useEffect(() => {
    function onKeydown(e) {
      if (e.key === 'Escape' && previewedResult) closePreview();
    }
    document.addEventListener('keydown', onKeydown);
    return () => document.removeEventListener('keydown', onKeydown);
  }, [previewedResult]);

  async function handlePreviewAddClick() {
    if (!previewedResult) return;
    const already = libraryMatchFor(libraryIndex, previewedResult);
    if (addedIds.has(String(previewedResult.id)) || already) {
      if (already) window.location.href = `series.html?id=${already.id}`;
      return;
    }
    setPreviewAdding(true);
    try {
      await addSeries(previewedResult);
    } catch {
      // The card's own retry affordance covers the failure case well enough
      // that the original didn't add a separate error message here either.
    }
    setPreviewAdding(false);
  }

  let gridContent;
  if (state === 'idle') {
    gridContent = <p className="settings-empty">Search for a series above to see results from MyAnimeList.</p>;
  } else if (state === 'loading') {
    gridContent = <p className="settings-empty">Searching MyAnimeList…</p>;
  } else if (state === 'error') {
    gridContent = <p className="settings-empty">Couldn't load results: {errorMessage}</p>;
  } else if (state === 'empty') {
    gridContent = <p className="settings-empty">No results.</p>;
  } else {
    gridContent = results.map((s) => {
      const already = libraryMatchFor(libraryIndex, s);
      const justAdded = addedIds.has(String(s.id));
      return <SeriesCard key={s.id} s={s} already={already} justAdded={justAdded} onPreview={openPreview} onAdd={addSeries} />;
    });
  }

  const previewAlready = previewedResult && libraryMatchFor(libraryIndex, previewedResult);
  const previewJustAdded = previewedResult && addedIds.has(String(previewedResult.id));
  const previewSettled = previewJustAdded || previewAlready;

  return (
    <>
      <p className="settings-subtitle">Search for a series to add to your library.</p>

      <div className="add-new-toolbar">
        <div className="search-box">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
          <input id="addNewSearch" type="text" value={query} onChange={(e) => onSearchInput(e.target.value)} placeholder="Search for a series..." />
        </div>
        {/* Not wired up in the original either — a static preview of what a
            real per-search Root Folder/Quality Profile override might look
            like, carried over unchanged. */}
        <span className="field-label-inline">Root Folder</span>
        <select className="field-select" defaultValue="/anime/library">
          <option>/anime/library</option>
          <option>/anime/seasonal</option>
        </select>
        <span className="field-label-inline">Quality Profile</span>
        <select className="field-select" defaultValue="HD-1080p">
          <option>HD-1080p</option>
          <option>Ultra-HD</option>
          <option>SD</option>
        </select>
      </div>

      <div className="series-grid" id="addNewGrid">{gridContent}</div>

      {previewedResult && (
        <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) closePreview(); }}>
          <div className="modal-box wide">
            <div className="modal-header">
              <h2>Series Details</h2>
              <button className="modal-close" type="button" aria-label="Close" onClick={closePreview}>{icons.x}</button>
            </div>
            <div className="modal-body">
              <div className="preview-layout"><PreviewBody s={previewedResult} /></div>
            </div>
            <div className="modal-footer">
              <button type="button" onClick={closePreview}>Close</button>
              <button
                className={previewSettled ? 'btn-success-state' : 'btn-accent'} type="button"
                disabled={previewAdding} onClick={handlePreviewAddClick}
              >
                {previewSettled ? <>{icons.check}{previewJustAdded ? 'Added' : 'In Library'}</> : <>{icons.plus}{previewAdding ? 'Adding…' : 'Add Series'}</>}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
