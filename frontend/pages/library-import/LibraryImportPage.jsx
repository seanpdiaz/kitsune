import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { icons } from '../../lib/icons.jsx';

// React port of initLibraryImport in public/js/pages/library-import.js —
// see README's "React migration" section. A real scan across every
// configured root folder (GET /api/root-folders/:id/subfolders), each
// subfolder flagged as already matching a Library series ('existing') or
// not, with a real per-folder file summary; expanding a row lazy-loads its
// actual files (GET .../subfolders/:name/files) for a look, read-only. An
// 'existing' row used to also carry its own "Import files" button (POST
// /api/series/:id/import-files) — dropped as a duplicate of Series >
// "Rescan for local files" (see SeriesPage.jsx, the one remaining place
// that endpoint is called from), so an already-matched row here is now
// purely informational: "Already in Library", nothing to click. See
// README's "Library Import: real file scanning" section for the fuller
// design writeup on the scan itself, which didn't change.

const folderIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7h4l2-2h6l2 2h4v12H3z" /></svg>;
const chevronRightIcon = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M9 6l6 6-6 6" /></svg>;

const rowKey = (item) => `${item.rootFolderId}:${item.name}`;

// item.files.fileCount === 0/undefined means there's nothing to expand — a
// row for a folder with no video files at all shouldn't toggle open into an
// empty panel just because the row itself got clicked (see rowIsExpandable
// below, shared by both the row-level click handler and this cell).
function rowIsExpandable(item) {
  return !!(item.files && item.files.fileCount > 0);
}

function StatusCell({ item }) {
  // A folder that already matches a Library series is just a status here,
  // not an action — re-importing/re-linking its files is what Series >
  // "Rescan for local files" is for (see SeriesPage.jsx), so this used to
  // duplicate that same Import files button on every already-matched row,
  // whether or not there was anything new in the folder to actually import.
  if (item.status === 'existing') {
    return <span className="status-pill status-off">{icons.check}Already in Library</span>;
  }
  // "Search" stops the click from bubbling to the row's own onClick — it's
  // its own action (a navigation), not an expand/collapse toggle.
  return (
    <a
      className="status-pill status-warn"
      href={`library-add-new.html?q=${encodeURIComponent(item.guessedTitle)}`}
      onClick={(e) => e.stopPropagation()}
    >
      {icons.search}Search
    </a>
  );
}

function FilesCell({ item, open, onToggle }) {
  const f = item.files;
  if (!rowIsExpandable(item)) {
    return <span className="settings-meta" style={{ color: 'var(--text-muted)' }}>No video files</span>;
  }
  const summary = `${f.fileCount} file${f.fileCount === 1 ? '' : 's'} · ${f.totalFormatted} · ${f.extensions.join(', ')}`;
  // stopPropagation here too — this button already toggles the row itself;
  // without it, the click would bubble up to the row's own onClick and fire
  // a second toggle, immediately undoing the first.
  return (
    <button
      className={`import-files-toggle${open ? ' open' : ''}`}
      type="button"
      aria-expanded={open}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
    >
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

export default function LibraryImportPage({ addBtnContainer }) {
  const [items, setItems] = useState([]);
  const [state, setState] = useState('loading'); // 'loading' | 'ok' | 'no-root-folders' | 'error'
  const [errorMessage, setErrorMessage] = useState('');
  const [rescanning, setRescanning] = useState(false);
  const [openRows, setOpenRows] = useState(() => new Set());
  const [fileListCache, setFileListCache] = useState(() => new Map());

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
      const expandable = rowIsExpandable(item);
      return (
        <div key={key}>
          {/* Clicking anywhere on the row (outside the Import files/Search
              controls, which stop propagation) expands or contracts its
              file list — same toggle the Files column's own chevron button
              already drove, just no longer requiring a click on that one
              small button specifically. Rows with no video files at all
              have nothing to expand, so they don't get the pointer cursor
              or a click handler. */}
          <div
            className={`import-row${expandable ? ' expandable' : ''}`}
            data-key={key}
            onClick={expandable ? () => toggleRow(item) : undefined}
          >
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
            <span><StatusCell item={item} /></span>
          </div>
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
