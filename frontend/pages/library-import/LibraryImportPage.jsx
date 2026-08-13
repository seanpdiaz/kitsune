import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { icons } from '../../lib/icons.jsx';

// React port of initLibraryImport in public/js/pages/library-import.js —
// see README's "React migration" section. A real scan across every
// configured root folder (GET /api/root-folders/:id/subfolders), each
// subfolder flagged as already matching a Library series ('existing') or
// not, with a real per-folder file summary; expanding a row lazy-loads its
// actual files (GET .../subfolders/:name/files) and "Import files" (POST
// /api/series/:id/import-files) links those real files to the series' real
// episodes. See README's "Library Import: real file scanning" section for
// the fuller design writeup — none of that changed here, just the rendering.

const folderIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7h4l2-2h6l2 2h4v12H3z" /></svg>;
const chevronRightIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M9 6l6 6-6 6" /></svg>;

const rowKey = (item) => `${item.rootFolderId}:${item.name}`;

function StatusCell({ item, importing, onImportFiles }) {
  if (item.status === 'existing') {
    return (
      <>
        <span className="status-pill status-off">{icons.check}Already in Library</span>
        <button className="btn-test" type="button" disabled={importing} onClick={onImportFiles}>
          {importing ? 'Importing…' : 'Import files'}
        </button>
      </>
    );
  }
  return (
    <a className="status-pill status-warn" href={`library-add-new.html?q=${encodeURIComponent(item.guessedTitle)}`}>
      {icons.search}Search
    </a>
  );
}

function FilesCell({ item, open, onToggle }) {
  const f = item.files;
  if (!f || f.fileCount === 0) {
    return <span className="settings-meta" style={{ color: 'var(--text-muted)' }}>No video files</span>;
  }
  const summary = `${f.fileCount} file${f.fileCount === 1 ? '' : 's'} · ${f.totalFormatted} · ${f.extensions.join(', ')}`;
  return (
    <button className={`import-files-toggle${open ? ' open' : ''}`} type="button" aria-expanded={open} onClick={onToggle}>
      {chevronRightIcon}
      <span>{summary}</span>
    </button>
  );
}

function FileDetailRow({ f }) {
  const epLabel = f.guessedEpisode == null ? 'no episode #' : `S${f.guessedSeason ?? '?'}E${f.guessedEpisode}`;
  return (
    <div className="import-file-row">
      <span className="file-name" title={f.name}>{f.name}</span>
      <span className="file-size">{f.sizeFormatted}</span>
      <span className="file-quality">{f.guessedQuality || 'unknown quality'}</span>
      <span className={`file-episode${f.guessConfident ? '' : ' unconfident'}`}>{epLabel}</span>
    </div>
  );
}

function FilesPanel({ cached }) {
  let body;
  if (cached === 'loading' || cached === undefined) {
    body = <p className="settings-empty">Loading files…</p>;
  } else if (cached === 'error') {
    body = <p className="settings-empty">Couldn't load the file list.</p>;
  } else {
    body = cached.map((f, i) => <FileDetailRow key={i} f={f} />);
  }
  return <div className="import-files-panel">{body}</div>;
}

function ImportResult({ result }) {
  if (!result || result === 'importing') return null;
  if (result.message) {
    return <p className="import-result warn">{result.message}</p>;
  }
  const matchedCount = result.matched.length;
  const unmatchedCount = result.unmatched.length;
  const resetCount = result.reset ? result.reset.length : 0;
  const cls = unmatchedCount === 0 ? 'ok' : 'warn';
  return (
    <p className={`import-result ${cls}`}>
      Linked {matchedCount} file{matchedCount === 1 ? '' : 's'} to episodes
      {unmatchedCount > 0 ? (
        <>
          , {unmatchedCount} couldn't be matched:<br />
          {result.unmatched.map((u, i) => (
            <span key={i}>{u.fileName}: {u.reason}<br /></span>
          ))}
        </>
      ) : '.'}
      {resetCount > 0 ? ` ${resetCount} previously-downloaded episode${resetCount === 1 ? '' : 's'} had no matching file in this scan and ${resetCount === 1 ? 'was' : 'were'} marked not downloaded.` : ''}
      {result.seriesEps ? ` Now showing ${result.seriesEps} downloaded.` : ''}
    </p>
  );
}

export default function LibraryImportPage({ addBtnContainer }) {
  const [items, setItems] = useState([]);
  const [state, setState] = useState('loading'); // 'loading' | 'ok' | 'no-root-folders' | 'error'
  const [errorMessage, setErrorMessage] = useState('');
  const [rescanning, setRescanning] = useState(false);
  const [openRows, setOpenRows] = useState(() => new Set());
  const [fileListCache, setFileListCache] = useState(() => new Map());
  const [importResults, setImportResults] = useState(() => new Map());

  async function scan() {
    setState('loading');
    setRescanning(true);
    try {
      const rootFoldersRes = await fetch('/api/settings-items/root-folders');
      const rootFolders = await rootFoldersRes.json();
      if (!Array.isArray(rootFolders) || rootFolders.length === 0) {
        setItems([]);
        setState('no-root-folders');
        return;
      }
      const perFolder = await Promise.all(rootFolders.map(async (rf) => {
        try {
          const res = await fetch(`/api/root-folders/${rf.id}/subfolders`);
          if (!res.ok) return [];
          const body = await res.json();
          const subfolders = Array.isArray(body.subfolders) ? body.subfolders : [];
          return subfolders.map((s) => ({ ...s, rootFolderId: rf.id }));
        } catch {
          return [];
        }
      }));
      setItems(perFolder.flat());
      setState('ok');
    } catch {
      setState('error');
      setErrorMessage('network error');
    } finally {
      setRescanning(false);
    }
  }

  useEffect(() => { scan(); }, []);

  async function loadFileList(item) {
    const key = rowKey(item);
    setFileListCache((prev) => new Map(prev).set(key, 'loading'));
    try {
      const res = await fetch(`/api/root-folders/${item.rootFolderId}/subfolders/${encodeURIComponent(item.name)}/files`);
      if (!res.ok) throw new Error('request failed');
      const body = await res.json();
      setFileListCache((prev) => new Map(prev).set(key, Array.isArray(body.files) ? body.files : []));
    } catch {
      setFileListCache((prev) => new Map(prev).set(key, 'error'));
    }
  }

  function toggleRow(item) {
    const key = rowKey(item);
    setOpenRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
    if (!openRows.has(key) && !fileListCache.has(key)) loadFileList(item);
  }

  async function importFiles(item) {
    const key = rowKey(item);
    if (!item.matchedSeriesId) return;
    setImportResults((prev) => new Map(prev).set(key, 'importing'));
    try {
      const res = await fetch(`/api/series/${item.matchedSeriesId}/import-files`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rootFolderId: item.rootFolderId, folderName: item.name }),
      });
      const body = await res.json();
      setImportResults((prev) => new Map(prev).set(key, body));
    } catch {
      setImportResults((prev) => new Map(prev).set(key, { message: "Couldn't import files — network error." }));
    }
  }

  let content;
  if (state === 'loading') {
    content = <p className="settings-empty">Scanning root folders…</p>;
  } else if (state === 'no-root-folders') {
    content = <p className="settings-empty">No root folders configured yet — add one under Settings &gt; Media Management.</p>;
  } else if (state === 'error') {
    content = <p className="settings-empty">Couldn't scan root folders: {errorMessage}</p>;
  } else if (items.length === 0) {
    content = <p className="settings-empty">Nothing found — every folder in your root folders is already in the Library.</p>;
  } else {
    content = items.map((item) => {
      const key = rowKey(item);
      const open = openRows.has(key);
      const result = importResults.get(key);
      return (
        <div key={key}>
          <div className="import-row" data-key={key}>
            {/* item.path is the real absolute path (root folder + this
                subfolder — see GET /api/root-folders/:id/subfolders in
                server/routes/root-folders.js), useful server-side but not
                worth showing here: every row already sits under whichever
                root folder you configured, so repeating that root's own
                absolute prefix (e.g. "/Volumes/Anime/") on every single row
                is just noise. item.name is already the bare series-folder
                name on its own, so this shows the path relative to its root
                folder instead — the only part that actually varies row to
                row. */}
            <span style={{ color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }}>{folderIcon}</span>
            <span className="settings-title" title={item.path}>/{item.name}</span>
            <span className="settings-meta">{item.matchedTitle || item.guessedTitle}</span>
            <FilesCell item={item} open={open} onToggle={() => toggleRow(item)} />
            <span><StatusCell item={item} importing={result === 'importing'} onImportFiles={() => importFiles(item)} /></span>
          </div>
          {result && result !== 'importing' && (
            <div style={{ margin: '-6px 0 8px 54px' }}><ImportResult result={result} /></div>
          )}
          {open && <FilesPanel cached={fileListCache.get(key)} />}
        </div>
      );
    });
  }

  return (
    <>
      {addBtnContainer && createPortal(
        <button className="btn-accent" type="button" disabled={rescanning} onClick={scan}>
          {rescanning ? 'Scanning…' : 'Rescan'}
        </button>,
        addBtnContainer,
      )}

      <p className="settings-subtitle">Series found in your root folders that aren't in the library yet.</p>

      <div className="import-header">
        <span></span><span>Folder</span><span>Match</span><span>Files</span><span>Status</span>
      </div>
      <div id="importList">{content}</div>
    </>
  );
}
