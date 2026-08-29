import { useEffect, useRef, useState } from 'react';
import { icons } from '../lib/icons.jsx';
import { initFileBrowserModal } from '../../public/js/lib/file-browser-modal.js';

// React port of initRootFolders in public/js/pages/settings-root-folders.js
// — see README's "React migration" section, Batch 8. The list itself
// (load/render/remove) is fully React; the "Add root folder" flow reuses
// initFileBrowserModal exactly as-is (imperative, DOM-id-driven — see
// file-browser-modal.js) rather than rewriting its server-directory-browse
// UI in JSX, wired up via a ref + useEffect the same way QualityTierRow
// wraps mountRangeSlider. The modal's own markup is rendered here (with the
// same ids the original static HTML used) so initFileBrowserModal's
// getElementById calls still find everything.
export default function RootFolders() {
  const [data, setData] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const browserRef = useRef(null);
  const dataRef = useRef(data);
  dataRef.current = data;

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/settings-items/root-folders');
        setData(await res.json());
      } catch {
        setData([]);
      }
      setLoaded(true);
    })();
  }, []);

  useEffect(() => {
    // POST /api/root-folders (not the generic /api/settings-items/root-
    // folders used for load/remove) — this one actually validates the path
    // on disk and computes real free-space/unmapped-folder numbers
    // server-side (see server.js's handleRootFoldersApi).
    browserRef.current = initFileBrowserModal({
      modalId: 'fileBrowserModal', closeId: 'fileBrowserModalClose', pathInputId: 'fileBrowserPathInput',
      listId: 'fileBrowserList', errorId: 'fileBrowserError', cancelId: 'fileBrowserModalCancel', okId: 'fileBrowserModalOk',
      onConfirm: async (chosenPath) => {
        const res = await fetch('/api/root-folders', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: chosenPath }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
        setData((prev) => [...prev, body]);
      },
    });
  }, []);

  function handleRemove(folder) {
    setData((prev) => prev.filter((f) => f.id !== folder.id));
    fetch(`/api/settings-items/root-folders/${folder.id}`, { method: 'DELETE' }).catch(() => {});
  }

  return (
    <>
      <div className="settings-header" style={{ gridTemplateColumns: '1fr 130px 160px 32px' }}>
        <span>Path</span><span>Free space</span><span>Unmapped folders</span><span></span>
      </div>
      <div id="rootFolderList">
        {!loaded ? (
          <p className="settings-empty">Loading…</p>
        ) : data.length === 0 ? (
          <p className="settings-empty">No root folders configured.</p>
        ) : (
          data.map((f) => (
            <div className="settings-row" style={{ gridTemplateColumns: '1fr 130px 160px 32px' }} data-id={f.id} key={f.id}>
              <span className="settings-title">{f.path}</span>
              <span className="settings-meta">{f.free}</span>
              <span className="settings-meta">{f.unmapped} unmapped</span>
              <button className="ep-action" type="button" aria-label={`Remove ${f.path}`} data-tooltip="Remove" onClick={() => handleRemove(f)}>{icons.x}</button>
            </div>
          ))
        )}
      </div>
      <button
        className="btn-accent" type="button" id="addRootFolderBtn" style={{ margin: '4px 0 16px' }}
        onClick={() => browserRef.current && browserRef.current.open()}
      >
        {icons.plus}Add root folder
      </button>

      <div className="modal-overlay" id="fileBrowserModal">
        <div className="modal-box wide">
          <div className="modal-header">
            <h2>File Browser</h2>
            <button className="modal-close" type="button" id="fileBrowserModalClose" aria-label="Close" data-tooltip="Close">{icons.x}</button>
          </div>
          <div className="modal-body">
            <input type="text" className="field-input" id="fileBrowserPathInput" placeholder="Start typing or select a path below" style={{ width: '100%', marginBottom: '12px' }} />
            <p className="form-error is-collapsed" id="fileBrowserError"></p>
            <div className="file-browser-list-wrap">
              <div className="file-browser-header"><span>Type</span><span>Name</span></div>
              <div className="file-browser-list" id="fileBrowserList"></div>
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" id="fileBrowserModalCancel">Cancel</button>
            <button className="btn-accent" type="button" id="fileBrowserModalOk">Ok</button>
          </div>
        </div>
      </div>
    </>
  );
}
