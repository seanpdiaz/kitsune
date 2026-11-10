import { useEffect, useMemo, useRef, useState } from 'react';
import { icons } from '../../lib/icons.jsx';
import { initFileBrowserModal } from '../../../public/js/lib/file-browser-modal.js';

// ---------------------------------------------------------------------------
// Wanted > Manual Import — backed by server/routes/manual-import.js.
//
// For when automatic import didn't work: point Kitsune at a folder (or come
// here from a stuck row in Activity > Queue), check each video file's
// series/season/episode/quality, fix anything wrong, and import. Files go
// into the Library through the same path a finished download takes
// (lib/media-import.js), so naming, season folders and permissions match.
//
// URL parameters, all optional:
//   ?queueId=N   scan a queue item's torrent files (Activity > Queue)
//   ?path=...    scan this folder straight away
//   ?seriesId=N  treat every file as belonging to this series (Series page)
// ---------------------------------------------------------------------------

const RECENT_KEY = 'kitsune.manualImport.recentFolders';
const MODE_KEY = 'kitsune.manualImport.mode';

// Browser storage can be unavailable or throw (private windows, blocked
// storage) — only ever a convenience here, never required.
function readStored(key, fallback) {
  try {
    const v = window.localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}
function writeStored(key, value) {
  try { window.localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
}

const pad2 = (n) => String(n).padStart(2, '0');

// Segment labels follow the app-wide rule: a named arc/part from metadata
// when there is one, otherwise plain "Season N"; Specials is always
// "Specials".
function seasonLabel(seasonNumber, seasonName) {
  if (seasonNumber === 0) return 'Specials';
  return seasonName ? `Season ${seasonNumber} · ${seasonName}` : `Season ${seasonNumber}`;
}

function episodeShortLabel(ep) {
  return `${ep.seasonNumber === 0 ? 'SP' : 'E'}${pad2(ep.num)}`;
}

// ---------------------------------------------------------------------------
// Episode picker — a button that opens a checklist of the chosen season's
// episodes. More than one can be ticked for a file that covers several
// (a double-length episode, an "01-02" release).
// ---------------------------------------------------------------------------
function EpisodePicker({ episodes, selectedIds, takenBy, disabled, onChange }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selected = episodes.filter((e) => selectedIds.includes(e.id));
  let label = 'Choose episode';
  if (selected.length === 1) label = `${episodeShortLabel(selected[0])}${selected[0].title ? ` · ${selected[0].title}` : ''}`;
  else if (selected.length > 1) label = selected.map(episodeShortLabel).join(' + ');

  function toggle(id) {
    onChange(selectedIds.includes(id) ? selectedIds.filter((x) => x !== id) : [...selectedIds, id]);
  }

  return (
    <div className="mi-picker" ref={wrapRef}>
      <button
        type="button"
        className={`mi-picker-btn${selected.length === 0 ? ' empty' : ''}`}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        title={label}
      >
        <span className="mi-picker-label">{label}</span>
        {icons.chevronDown}
      </button>
      {open && (
        <div className="mi-picker-panel" role="listbox" aria-multiselectable="true">
          {episodes.length === 0 && <p className="settings-empty" style={{ padding: '8px 10px' }}>No episodes in this season.</p>}
          {episodes.map((ep) => {
            const checked = selectedIds.includes(ep.id);
            const taken = takenBy.get(ep.id);
            return (
              <label key={ep.id} className={`mi-picker-item${checked ? ' checked' : ''}`}>
                <input type="checkbox" checked={checked} onChange={() => toggle(ep.id)} />
                <span className="mi-ep-num">{episodeShortLabel(ep)}</span>
                <span className="mi-ep-title">{ep.title || 'TBA'}</span>
                {taken && !checked && <span className="mi-ep-flag warn" title={`Also chosen for ${taken}`}>other file</span>}
                {ep.downloaded && <span className="mi-ep-flag" title={ep.path || ''}>{ep.quality || 'has file'}</span>}
              </label>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Status pill for one row.
// ---------------------------------------------------------------------------
function rowStatus(row, conflictIds, episodesById) {
  if (row.result) {
    return row.result.ok
      ? { cls: 'status-on', text: 'Imported', tip: `${row.result.episodes.join(', ')} → ${row.result.destPath}${row.result.note ? ` — ${row.result.note}` : ''}${row.result.replaced && row.result.replaced.length ? ` — replaced ${row.result.replaced.join(', ')}` : ''}` }
      : { cls: 'status-fail', text: 'Failed', tip: row.result.error };
  }
  if (row.alreadyImported) return { cls: 'status-off', text: 'Already in Library', tip: 'This file is already the Library file for this episode.' };
  if (!row.seriesId) return { cls: 'status-warn', text: 'Needs series', tip: row.reason || undefined };
  if (row.episodeIds.length === 0) return { cls: 'status-warn', text: 'Needs episode', tip: row.reason || undefined };
  if (row.episodeIds.some((id) => conflictIds.has(id))) return { cls: 'status-fail', text: 'Duplicate episode', tip: 'Another selected file is assigned to the same episode.' };
  const existing = row.episodeIds.map((id) => episodesById.get(id)).filter((e) => e && e.downloaded);
  if (existing.length > 0) {
    return { cls: 'status-info', text: 'Replaces file', tip: `Already has ${existing.map((e) => `${episodeShortLabel(e)} (${e.quality || 'unknown quality'})`).join(', ')} — the old file in the series folder will be removed.` };
  }
  return { cls: 'status-on', text: 'Ready', tip: undefined };
}

const isReady = (row) => !row.alreadyImported && !(row.result && row.result.ok) && row.seriesId && row.episodeIds.length > 0;

export default function ManualImportPage() {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const presetSeriesId = Number(params.get('seriesId')) || null;
  const queueId = Number(params.get('queueId')) || null;

  const [folder, setFolder] = useState(params.get('path') || '');
  const [recent, setRecent] = useState(() => readStored(RECENT_KEY, []));
  const [mode, setMode] = useState(() => (readStored(MODE_KEY, 'copy') === 'move' ? 'move' : 'copy'));
  const [scanState, setScanState] = useState('idle'); // idle | loading | ok | error
  const [scanError, setScanError] = useState('');
  const [suggestedPath, setSuggestedPath] = useState(null);
  const [scanInfo, setScanInfo] = useState(null); // { path, truncated, totalFound, queue, missing }
  const [rows, setRows] = useState([]);
  const [seriesList, setSeriesList] = useState([]);
  const [episodesBySeries, setEpisodesBySeries] = useState(() => new Map());
  const [qualityTiers, setQualityTiers] = useState([]);
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const [summary, setSummary] = useState(null);
  const [bulkSeries, setBulkSeries] = useState('');
  const browserRef = useRef(null);
  const loadingSeries = useRef(new Set());

  // ---- one-time loads ----
  useEffect(() => {
    fetch('/api/series').then((r) => r.json()).then((list) => {
      if (Array.isArray(list)) setSeriesList(list.slice().sort((a, b) => a.title.localeCompare(b.title)));
    }).catch(() => {});
    fetch('/api/settings-items/quality-tiers').then((r) => r.json()).then((list) => {
      if (Array.isArray(list)) setQualityTiers(list.map((t) => t.name).filter(Boolean));
    }).catch(() => {});
  }, []);

  useEffect(() => {
    browserRef.current = initFileBrowserModal({
      modalId: 'miBrowserModal', closeId: 'miBrowserModalClose', pathInputId: 'miBrowserPathInput',
      listId: 'miBrowserList', errorId: 'miBrowserError', cancelId: 'miBrowserModalCancel', okId: 'miBrowserModalOk',
      busyLabel: 'Scanning…',
      onConfirm: async (chosen) => {
        setFolder(chosen);
        await scan({ path: chosen });
      },
    });
    if (queueId) scan({ queueId });
    else if (params.get('path')) scan({ path: params.get('path') });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadEpisodes(seriesId, { force = false } = {}) {
    if (!seriesId) return;
    if (!force && (episodesBySeries.has(seriesId) || loadingSeries.current.has(seriesId))) return;
    loadingSeries.current.add(seriesId);
    try {
      const res = await fetch(`/api/series/${seriesId}/episodes`);
      const body = await res.json();
      const eps = Array.isArray(body.episodes) ? body.episodes : [];
      setEpisodesBySeries((prev) => new Map(prev).set(seriesId, eps));
    } catch {
      setEpisodesBySeries((prev) => new Map(prev).set(seriesId, []));
    } finally {
      loadingSeries.current.delete(seriesId);
    }
  }

  // Every series any row points at gets its episode list loaded.
  useEffect(() => {
    for (const id of new Set(rows.map((r) => r.seriesId).filter(Boolean))) loadEpisodes(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);

  async function scan({ path: scanPath, queueId: qid } = {}) {
    setScanState('loading');
    setScanError('');
    setSuggestedPath(null);
    setSummary(null);
    setImportError('');
    const q = new URLSearchParams();
    if (qid) q.set('queueId', qid);
    else q.set('path', scanPath);
    if (presetSeriesId && !qid) q.set('seriesId', presetSeriesId);
    try {
      const res = await fetch(`/api/manual-import/scan?${q}`);
      const body = await res.json();
      if (!res.ok) {
        setScanState('error');
        setScanError(body.error || `HTTP ${res.status}`);
        setSuggestedPath(body.suggestedPath || null);
        setRows([]);
        return;
      }
      setScanInfo({ path: body.path, truncated: body.truncated, totalFound: body.totalFound, queue: body.queue, missing: body.missing || [] });
      setRows(body.files.map((f) => ({
        ...f,
        selected: !f.alreadyImported && !!f.seriesId && f.episodeIds.length > 0,
        qualityLocked: false,
        result: null,
      })));
      setScanState('ok');
      if (!qid) {
        setFolder(body.path);
        const next = [body.path, ...recent.filter((p) => p !== body.path)].slice(0, 6);
        setRecent(next);
        writeStored(RECENT_KEY, next);
      }
    } catch {
      setScanState('error');
      setScanError('Could not reach the server.');
    }
  }

  function updateRow(index, patch) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)));
  }

  function seasonsFor(seriesId) {
    const eps = episodesBySeries.get(seriesId) || [];
    const seen = new Map();
    for (const e of eps) if (!seen.has(e.seasonNumber)) seen.set(e.seasonNumber, e.seasonName || null);
    // Regular seasons first, Specials last — same order as the Series page.
    return [...seen.entries()].sort((a, b) => ((a[0] === 0) - (b[0] === 0)) || (a[0] - b[0]));
  }

  function setRowSeries(index, seriesId) {
    const id = Number(seriesId) || null;
    updateRow(index, { seriesId: id, episodeIds: [], season: rows[index].season, result: null, alreadyImported: false });
    if (id) loadEpisodes(id);
  }

  function applyBulkSeries() {
    const id = Number(bulkSeries) || null;
    if (!id) return;
    setRows((prev) => prev.map((r) => (r.selected && !(r.result && r.result.ok) ? { ...r, seriesId: id, episodeIds: [], alreadyImported: false } : r)));
    loadEpisodes(id);
  }

  // ---- derived state ----
  const episodesById = useMemo(() => {
    const m = new Map();
    for (const eps of episodesBySeries.values()) for (const e of eps) m.set(e.id, e);
    return m;
  }, [episodesBySeries]);

  // Which selected file each episode is assigned to — for the "other file"
  // hint in the picker and the duplicate check.
  const { takenBy, conflictIds } = useMemo(() => {
    const owner = new Map();
    const conflicts = new Set();
    for (const r of rows) {
      if (!r.selected || (r.result && r.result.ok)) continue;
      for (const id of r.episodeIds) {
        if (owner.has(id)) conflicts.add(id);
        else owner.set(id, r.name);
      }
    }
    return { takenBy: owner, conflictIds: conflicts };
  }, [rows]);

  const selectedRows = rows.filter((r) => r.selected && !(r.result && r.result.ok));
  const readySelected = selectedRows.filter(isReady);
  const blockedSelected = selectedRows.length - readySelected.length;
  const hasConflicts = conflictIds.size > 0;
  const selectableRows = rows.filter((r) => !(r.result && r.result.ok) && !r.alreadyImported);
  const allSelected = selectableRows.length > 0 && selectableRows.every((r) => r.selected);

  function toggleAll() {
    const next = !allSelected;
    setRows((prev) => prev.map((r) => ((r.result && r.result.ok) || r.alreadyImported ? r : { ...r, selected: next })));
  }

  async function runImport() {
    setImporting(true);
    setImportError('');
    setSummary(null);
    const items = readySelected.map((r) => ({
      path: r.path, seriesId: r.seriesId, episodeIds: r.episodeIds, quality: r.quality, qualityLocked: r.qualityLocked,
    }));
    writeStored(MODE_KEY, mode);
    try {
      const res = await fetch('/api/manual-import', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode, items, queueHash: scanInfo && scanInfo.queue ? scanInfo.queue.hash : undefined }),
      });
      const body = await res.json();
      if (!res.ok) {
        setImportError(body.error || `HTTP ${res.status}`);
        return;
      }
      const byPath = new Map(body.results.map((r) => [r.path, r]));
      setRows((prev) => prev.map((r) => {
        const result = byPath.get(r.path);
        return result ? { ...r, result, selected: !result.ok } : r;
      }));
      setSummary({ imported: body.imported, failed: body.failed });
      // Refresh the episode lists we touched so "has file" flags are current.
      for (const id of new Set(items.map((i) => i.seriesId))) loadEpisodes(id, { force: true });
    } catch {
      setImportError('Could not reach the server — some files may still have been imported. Rescan to check.');
    } finally {
      setImporting(false);
    }
  }

  // ---- render ----
  const seriesTitleById = useMemo(() => new Map(seriesList.map((s) => [s.id, s.title])), [seriesList]);
  const presetSeriesTitle = presetSeriesId ? seriesTitleById.get(presetSeriesId) : null;

  let table = null;
  if (scanState === 'loading') {
    table = <p className="settings-empty">Scanning…</p>;
  } else if (scanState === 'error') {
    table = (
      <div className="mi-notice error">
        <p>{scanError}</p>
        {suggestedPath && (
          <button type="button" onClick={() => { setFolder(suggestedPath); scan({ path: suggestedPath }); }}>
            Scan the download folder instead ({suggestedPath})
          </button>
        )}
      </div>
    );
  } else if (scanState === 'ok' && rows.length === 0) {
    table = <p className="settings-empty">No video files found in that folder.</p>;
  } else if (scanState === 'ok') {
    table = (
      <>
        <div className="mi-header">
          <span><input type="checkbox" className="row-checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" /></span>
          <span>File</span><span>Series</span><span>Season</span><span>Episode</span><span>Quality</span><span>Status</span>
        </div>
        <div className="mi-list">
          {rows.map((row, i) => {
            const eps = episodesBySeries.get(row.seriesId);
            const seasons = row.seriesId ? seasonsFor(row.seriesId) : [];
            const seasonEps = (eps || []).filter((e) => e.seasonNumber === row.season);
            const status = rowStatus(row, conflictIds, episodesById);
            const done = row.result && row.result.ok;
            const locked = done || row.alreadyImported;
            return (
              <div className={`mi-row${row.selected ? ' selected' : ''}${done ? ' done' : ''}`} key={row.path}>
                <span>
                  <input
                    type="checkbox" className="row-checkbox" checked={row.selected} disabled={locked}
                    onChange={(e) => updateRow(i, { selected: e.target.checked })} aria-label={`Select ${row.name}`}
                  />
                </span>
                <div className="settings-name">
                  <p className="settings-title mi-file" title={row.path}>{row.relativePath}</p>
                  <span className="settings-meta">{row.sizeFormatted}</span>
                </div>
                <select className="field-select" value={row.seriesId || ''} disabled={locked} onChange={(e) => setRowSeries(i, e.target.value)}>
                  <option value="">Choose series…</option>
                  {seriesList.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
                </select>
                <select
                  className="field-select"
                  value={row.season ?? ''}
                  disabled={locked || !row.seriesId || !eps}
                  onChange={(e) => updateRow(i, { season: e.target.value === '' ? null : Number(e.target.value), episodeIds: [] })}
                >
                  <option value="">{row.seriesId && !eps ? 'Loading…' : '—'}</option>
                  {seasons.map(([n, name]) => <option key={n} value={n}>{seasonLabel(n, name)}</option>)}
                  {row.season != null && eps && !seasons.some(([n]) => n === row.season) && <option value={row.season}>Season {row.season}</option>}
                </select>
                <EpisodePicker
                  episodes={seasonEps}
                  selectedIds={row.episodeIds}
                  takenBy={takenBy}
                  disabled={locked || row.season == null || !eps}
                  onChange={(ids) => updateRow(i, { episodeIds: ids, selected: ids.length > 0 ? true : row.selected })}
                />
                <select
                  className="field-select"
                  value={row.quality || ''}
                  disabled={locked}
                  onChange={(e) => updateRow(i, { quality: e.target.value || null, qualityLocked: true })}
                  title={row.qualityLocked ? 'Set by you' : 'Guessed from the filename; checked against the real video when imported'}
                >
                  <option value="">Unknown</option>
                  {qualityTiers.map((q) => <option key={q} value={q}>{q}</option>)}
                  {row.quality && !qualityTiers.includes(row.quality) && <option value={row.quality}>{row.quality}</option>}
                </select>
                <span className={`status-pill ${status.cls}`} data-tooltip={status.tip}>{status.text}</span>
              </div>
            );
          })}
        </div>
      </>
    );
  }

  return (
    <>
      <p className="settings-subtitle">
        Import files Kitsune couldn't import on its own. Choose a folder, check each file's series and episode, then import.
      </p>

      <div className="mi-source">
        {scanInfo && scanInfo.queue && scanState !== 'loading' ? (
          <div className="mi-queue-banner">
            <span>From the queue: <strong>{scanInfo.queue.releaseTitle}</strong></span>
            <span className="settings-meta" title={scanInfo.path}>{scanInfo.path}</span>
            <a href="wanted-manual-import.html">Choose a different folder</a>
          </div>
        ) : (
          <form className="mi-folder-form" onSubmit={(e) => { e.preventDefault(); if (folder.trim()) scan({ path: folder.trim() }); }}>
            <input
              className="field-input" type="text" value={folder} placeholder="/downloads/complete/Some Release"
              onChange={(e) => setFolder(e.target.value)} aria-label="Folder to scan" list="miRecentFolders"
            />
            <datalist id="miRecentFolders">{recent.map((p) => <option key={p} value={p} />)}</datalist>
            <button type="button" onClick={() => browserRef.current && browserRef.current.open(folder.trim() || undefined)}>Browse…</button>
            <button className="btn-accent" type="submit" disabled={!folder.trim() || scanState === 'loading'}>
              {icons.search}{scanState === 'loading' ? 'Scanning…' : 'Scan'}
            </button>
          </form>
        )}
        {presetSeriesTitle && !(scanInfo && scanInfo.queue) && (
          <p className="settings-meta" style={{ marginTop: 8 }}>Every file will be matched against <strong>{presetSeriesTitle}</strong>.</p>
        )}
        {scanState === 'idle' && recent.length > 0 && (
          <div className="mi-recent">
            <span className="settings-meta">Recent:</span>
            {recent.map((p) => (
              <button key={p} type="button" className="mi-chip" onClick={() => { setFolder(p); scan({ path: p }); }} title={p}>{p}</button>
            ))}
          </div>
        )}
      </div>

      {scanState === 'ok' && scanInfo && scanInfo.truncated && (
        <div className="mi-notice">Found {scanInfo.totalFound} video files — showing the first {rows.length}. Pick a narrower folder to see the rest.</div>
      )}
      {scanState === 'ok' && scanInfo && scanInfo.missing.length > 0 && (
        <div className="mi-notice">
          {scanInfo.missing.length} file(s) in this torrent weren't found where Kitsune expected them (first: {scanInfo.missing[0]}).
          If Kitsune and your download client see different paths, check Remote Path Mappings in Settings &gt; Download Clients.
        </div>
      )}

      {scanState === 'ok' && rows.length > 0 && (
        <div className="mi-toolbar">
          <div className="mi-toolbar-group">
            <select className="field-select" value={bulkSeries} onChange={(e) => setBulkSeries(e.target.value)} aria-label="Series for selected files">
              <option value="">Set series for selected…</option>
              {seriesList.map((s) => <option key={s.id} value={s.id}>{s.title}</option>)}
            </select>
            <button type="button" disabled={!bulkSeries || selectedRows.length === 0} onClick={applyBulkSeries}>Apply</button>
          </div>
          <button type="button" onClick={() => scan(scanInfo.queue ? { queueId: scanInfo.queue.id } : { path: scanInfo.path })}>{icons.refresh}Rescan</button>
        </div>
      )}

      {table}

      {scanState === 'ok' && rows.length > 0 && (
        <div className="mi-footer">
          <div className="mi-mode">
            <label htmlFor="miMode" className="settings-meta">Import mode</label>
            <select id="miMode" className="field-select" value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="copy">Hardlink / Copy</option>
              <option value="move">Move</option>
            </select>
            <span className="settings-meta">
              {mode === 'copy'
                ? 'Leaves the original in place (a hardlink when possible, so no extra space). Use this if it\'s still seeding.'
                : 'Moves the file into the Library and removes the original.'}
            </span>
          </div>
          <div className="mi-footer-actions">
            {summary && (
              <span className={`settings-meta ${summary.failed ? 'mi-text-warn' : 'mi-text-ok'}`}>
                {summary.imported} imported{summary.failed ? `, ${summary.failed} failed — hover Failed for details` : ''}
              </span>
            )}
            {!summary && blockedSelected > 0 && (
              <span className="settings-meta mi-text-warn">{blockedSelected} selected file(s) still need a series or episode</span>
            )}
            {!summary && hasConflicts && <span className="settings-meta mi-text-warn">Two files are assigned to the same episode</span>}
            <button
              className="btn-accent" type="button"
              disabled={importing || readySelected.length === 0 || hasConflicts}
              onClick={runImport}
            >
              {icons.download}{importing ? 'Importing…' : `Import ${readySelected.length} file${readySelected.length === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}
      {importError && <p className="form-error">{importError}</p>}

      <div className="modal-overlay" id="miBrowserModal">
        <div className="modal-box wide">
          <div className="modal-header">
            <h2>Choose Folder</h2>
            <button className="modal-close" type="button" id="miBrowserModalClose" aria-label="Close" data-tooltip="Close">{icons.x}</button>
          </div>
          <div className="modal-body">
            <input type="text" className="field-input" id="miBrowserPathInput" placeholder="Start typing or select a path below" style={{ width: '100%', marginBottom: '12px' }} />
            <p className="form-error is-collapsed" id="miBrowserError"></p>
            <div className="file-browser-list-wrap">
              <div className="file-browser-header"><span>Type</span><span>Name</span></div>
              <div className="file-browser-list" id="miBrowserList"></div>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" id="miBrowserModalCancel">Cancel</button>
            <button className="btn-accent" type="button" id="miBrowserModalOk">Scan this folder</button>
          </div>
        </div>
      </div>
    </>
  );
}
