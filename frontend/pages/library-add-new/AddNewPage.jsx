import { useEffect, useRef, useState } from 'react';
import { icons } from '../../lib/icons.jsx';

// React port of initAddNew in public/js/pages/library-add-new.js — see
// README's "React migration" section. Results come live from MyAnimeList's
// official API through /api/mal/search (server.js's handleMalApi), falling
// back to TVDB search if MAL is down (source: 'tvdb' on a result, flagged
// on the card/preview so it's clear where the data came from, not silently
// different).

// The Cmd/Ctrl+K handler below already checks both e.metaKey and e.ctrlKey,
// so the shortcut itself works on every platform — this is only for what
// the hint badge displays, so a Mac user isn't shown "Ctrl" for a key their
// keyboard doesn't have (Mac uses Cmd/⌘, not Ctrl, for this class of
// shortcut). Read once at module load rather than on every render; this
// doesn't change while the page is open.
const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent || navigator.platform || '');

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

// The idle/loading/empty/error states used to be a single bare <p
// className="settings-empty"> sitting in the top-left corner of an otherwise
// completely blank #addNewGrid — accurate information, but with nothing to
// fill the rest of a normally poster-grid-sized page, it read as broken
// rather than "nothing searched yet." This gives each of those states the
// same visual weight as the results grid it's standing in for: a centered
// icon + heading + one line of guidance, spanning the grid's full width (see
// .add-new-empty's grid-column in styles.css) instead of collapsing to one
// grid cell in the corner.
function EmptyState({ icon, title, message, spin }) {
  return (
    <div className="add-new-empty">
      <div className={`add-new-empty-icon${spin ? ' spin' : ''}`}>{icon}</div>
      <h3>{title}</h3>
      <p>{message}</p>
    </div>
  );
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

// The idle (nothing typed yet) landing state — a full welcome screen
// instead of the compact toolbar + a small "nothing searched yet" message.
// Carries the actual live search input (searchInputRef is shared with the
// compact toolbar's own input below, in AddNewPage — see its Cmd/Ctrl+K
// handler). Deliberately minimal: just the heading and the search box, no
// logo mark and no Root Folder/Quality Profile pickers here — those two
// still work exactly as before, they just live solely on the compact
// toolbar now (see AddNewPage's state !== 'idle' branch) rather than being
// duplicated here too. This whole block unmounts the moment a real search
// starts (state leaves 'idle') in favor of that compact toolbar + results
// grid — a full-page landing screen only makes sense before you've
// committed to typing something.
function IdleHero({ query, onSearchInput, searchInputRef }) {
  return (
    <div className="add-new-hero">
      <h1>Explore &amp; Add to Your Library</h1>

      <div className="search-box add-new-hero-search">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
        <input
          ref={searchInputRef}
          type="text"
          value={query}
          onChange={(e) => onSearchInput(e.target.value)}
          placeholder="Type a series title…"
          autoFocus
        />
        {/* Decorative, but not a lie — the Cmd/Ctrl+K handler in AddNewPage
            really does focus searchInputRef, whichever of the two <input>s
            (this one or the compact toolbar's) happens to be mounted. Shows
            the modifier key that's actually on the user's own keyboard (see
            isMac above) rather than always saying "Ctrl", which isn't a key
            a Mac keyboard has. */}
        <span className="search-kbd-hint" aria-hidden="true"><kbd>{isMac ? '⌘' : 'Ctrl'}</kbd><span>+</span><kbd>K</kbd></span>
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

  // Root Folder / Quality Profile toolbar selects — real Settings >
  // {Media Management, Profiles} data now (see loadOptions below), not the
  // two hardcoded "/anime/library"/"/anime/seasonal" <option>s this page
  // shipped with, which were never wired to anything: picking one had zero
  // effect on where a series landed or what profile it got. Both default to
  // whichever item is first in its real list (position order — the same
  // order Settings > Media Management/Profiles themselves display), same
  // "first configured wins" default POST /api/series already falls back to
  // server-side when nothing is explicitly chosen.
  const [rootFolders, setRootFolders] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [selectedRootFolder, setSelectedRootFolder] = useState('');
  const [selectedQualityProfile, setSelectedQualityProfile] = useState('');

  const requestSeqRef = useRef(0);
  const debounceRef = useRef(null);
  // Shared between the idle hero's own <input> and the compact toolbar's —
  // only one is ever mounted at a time (see the state === 'idle' branch
  // below), so this always points at whichever one is currently on screen.
  const searchInputRef = useRef(null);

  // Cmd/Ctrl+K focuses search from anywhere on this page — the hero state's
  // keyboard-shortcut badge (see IdleHero) would be a lie otherwise. Checks
  // both e.metaKey (⌘, Mac) and e.ctrlKey (Ctrl, Windows/Linux) so the
  // shortcut itself works regardless of platform — IdleHero's isMac check
  // only controls what the badge displays, not which key actually works.
  // Refocusing an already-focused input is a harmless no-op, so this
  // doesn't need to check for that first.
  useEffect(() => {
    function onKeydown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchInputRef.current?.focus();
      }
    }
    document.addEventListener('keydown', onKeydown);
    return () => document.removeEventListener('keydown', onKeydown);
  }, []);

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

  // Same two endpoints Settings > Media Management's RootFolders.jsx and
  // Settings > Profiles' ProfilesPage.jsx already fetch from — no new API
  // needed. Failure just leaves the list empty (the select shows nothing to
  // pick, same "worst case, the server's own default kicks in" fallback
  // loadLibraryIndex above already uses) rather than surfacing a hard error
  // on a page whose main job is search, not settings management.
  //
  // Quality Profile's initial selection prefers whichever profile Settings >
  // Profiles has marked as the default for new series (see ProfilesPage.jsx's
  // "Default" column and /api/app-settings/library-defaults) over just
  // "whatever's first in the list" — the same real default POST /api/series
  // itself falls back to server-side (see series.js's resolveQualityProfile)
  // when this select's value is submitted empty, so a page load and a raw
  // API call agree on what "no explicit choice" means. Falls through to the
  // first profile exactly like before if no default is set, or the id it
  // points to doesn't match any currently-configured profile (deleted since).
  async function loadOptions() {
    try {
      const res = await fetch('/api/settings-items/root-folders');
      const data = await res.json();
      setRootFolders(data);
      if (data.length > 0) setSelectedRootFolder(data[0].path);
    } catch { /* leave rootFolders empty */ }
    try {
      const res = await fetch('/api/settings-items/profiles');
      const data = await res.json();
      setProfiles(data);
      if (data.length > 0) {
        let defaultProfile = data[0];
        try {
          const defaultsRes = await fetch('/api/app-settings/library-defaults');
          const defaults = await defaultsRes.json();
          const match = defaults.defaultQualityProfileId != null
            ? data.find((p) => p.id === defaults.defaultQualityProfileId)
            : null;
          if (match) defaultProfile = match;
        } catch { /* fall through to the first-configured profile below */ }
        setSelectedQualityProfile(defaultProfile.name);
      }
    } catch { /* leave profiles empty */ }
  }

  useEffect(() => {
    (async () => {
      await loadLibraryIndex();
      await loadOptions();
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
        // Whatever's currently selected in the toolbar above — server-side
        // (POST /api/series' resolveRootFolder) still falls back to the
        // first configured root folder if this is empty or somehow doesn't
        // match a real one, so an empty rootFolders/profiles list (nothing
        // configured yet, or the fetch in loadOptions failed) doesn't block
        // adding a series, it just means neither select had anything real
        // to offer and this sends the default "let the server decide" value.
        rootFolder: selectedRootFolder || undefined,
        qualityProfile: selectedQualityProfile || undefined,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 409) {
      // Someone/something beat us to it — another tab, or our own pre-check
      // missed it. Either way the series genuinely exists now, so this is
      // the same "go look at it" outcome as a fresh add below, not a
      // failure — same as handlePreviewAddClick's own already-in-library
      // branch just below.
      if (body.existingId) {
        window.location.href = `series.html?id=${body.existingId}`;
      }
      return;
    }
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    // Series added — head straight to its detail page rather than leaving
    // the person on the search results with just a checkmark. Once a series
    // is in the Library, its own page (episodes, monitoring, quality
    // profile, etc.) is the next thing anyone actually wants, not more
    // search results. setAddedIds/setLibraryIndex below are what used to
    // flip the card to "Added"/"In Library" in place; kept as a fallback in
    // case navigation is somehow interrupted (e.g. the response arrives
    // just as this component is unmounting), not because anyone should
    // normally see that state now.
    if (body && body.id) {
      setAddedIds((prev) => new Set(prev).add(String(match.id)));
      setLibraryIndex((prev) => withMatch(prev, match, body));
      window.location.href = `series.html?id=${body.id}`;
    }
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

  // 'idle' no longer has a branch here — it's handled entirely by IdleHero
  // below, which replaces this grid (and the compact toolbar above it)
  // outright rather than rendering a message inside it.
  let gridContent;
  if (state === 'loading') {
    gridContent = (
      <EmptyState
        icon={icons.search}
        spin
        title="Searching…"
        message={`Looking up "${query.trim()}" on MyAnimeList.`}
      />
    );
  } else if (state === 'error') {
    gridContent = (
      <EmptyState
        icon={icons.alert}
        title="Search failed"
        message={`Couldn't load results: ${errorMessage}`}
      />
    );
  } else if (state === 'empty') {
    gridContent = (
      <EmptyState
        icon={icons.search}
        title="No results"
        message={`Nothing matched "${query.trim()}" — try a different title or check the spelling.`}
      />
    );
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
      {state === 'idle' ? (
        <IdleHero query={query} onSearchInput={onSearchInput} searchInputRef={searchInputRef} />
      ) : (
        <>
          <p className="settings-subtitle">Search for a series to add to your library.</p>

          <div className="add-new-toolbar">
            {/* The search box used to share the same cramped 360px width and
                36px height as every other page's compact toolbar search —
                fine for narrowing an already-visible grid, but this page's
                entire job is this one input, so it reads as the whole page's
                hero control now: wider, taller, and set off on its own row
                instead of competing with two selects for space. */}
            <div className="search-box add-new-search">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
              <input
                ref={searchInputRef}
                id="addNewSearch" type="text" value={query} onChange={(e) => onSearchInput(e.target.value)}
                placeholder="Search MyAnimeList for a series to add…" autoFocus
              />
            </div>

            {/* Real Settings > Media Management root folders / Settings >
                Profiles quality profiles now (see loadOptions above) — every
                newly-added series actually lands under whichever root folder
                is selected here and gets this quality profile assigned, both
                sent straight through to POST /api/series (see addSeries).
                Disabled with a specific empty-state option when nothing's
                configured yet (matches Settings > Media Management/Profiles'
                own "nothing configured" empty states) rather than showing a
                picker with nothing real to pick. Demoted to a smaller
                secondary row below the search box — these are defaults for
                whatever gets added, not the thing this page is for. */}
            <div className="add-new-filters">
              <label className="add-new-field">
                <span className="field-label-inline">Root Folder</span>
                <select
                  className="field-select"
                  value={selectedRootFolder}
                  onChange={(e) => setSelectedRootFolder(e.target.value)}
                  disabled={rootFolders.length === 0}
                >
                  {rootFolders.length === 0
                    ? <option value="">No root folders configured</option>
                    : rootFolders.map((f) => <option key={f.id} value={f.path}>{f.path}</option>)}
                </select>
              </label>
              <label className="add-new-field">
                <span className="field-label-inline">Quality Profile</span>
                <select
                  className="field-select"
                  value={selectedQualityProfile}
                  onChange={(e) => setSelectedQualityProfile(e.target.value)}
                  disabled={profiles.length === 0}
                >
                  {profiles.length === 0
                    ? <option value="">No profiles configured</option>
                    : profiles.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
                </select>
              </label>
            </div>
          </div>

          <div className="series-grid" id="addNewGrid">{gridContent}</div>
        </>
      )}

      {previewedResult && (
        <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) closePreview(); }}>
          <div className="modal-box wide">
            <div className="modal-header">
              <h2>Series Details</h2>
              <button className="modal-close" type="button" aria-label="Close" data-tooltip="Close" onClick={closePreview}>{icons.x}</button>
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
