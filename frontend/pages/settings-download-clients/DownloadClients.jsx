import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { icons } from '../../lib/icons.jsx';

// Settings > Download Clients — a faithful port of
// public/js/pages/settings-download-clients.js. Split off from the shared
// ConnectionManager (Indexers/Import Lists/Connect) because this is the one
// settings section that talks to something real: adding a client saves real
// host/port/credentials, and Test actually logs into a real qBittorrent or
// NZBGet instance via server/routes/download-clients.js instead of faking a
// result after a timeout. See README's "Download Clients: real
// qBittorrent/NZBGet connections" section.

const SECTION = 'download-clients';

const CLIENT_TYPES = {
  qbittorrent: {
    label: 'qBittorrent',
    protocol: 'Torrent',
    defaults: {
      type: 'qbittorrent', name: 'qBittorrent', protocol: 'Torrent',
      host: '', port: 8080, useSsl: false, username: '', password: '',
      category: 'kitsune', clientPriority: 1, enabled: true, status: 'pending', version: null,
      initialState: 'start', contentLayout: 'original', sequentialOrder: false, firstLastPiecePriority: true,
    },
  },
  nzbget: {
    label: 'NZBGet',
    protocol: 'Usenet',
    defaults: {
      type: 'nzbget', name: 'NZBGet', protocol: 'Usenet',
      host: '', port: 6789, useSsl: false, username: '', password: '',
      category: 'kitsune', clientPriority: 1, enabled: true, status: 'pending', version: null,
      nzbPriority: 0,
    },
  },
};

const NZB_PRIORITY_OPTIONS = [
  { value: -100, label: 'Very Low' },
  { value: -50, label: 'Low' },
  { value: 0, label: 'Normal' },
  { value: 50, label: 'High' },
  { value: 100, label: 'Very High' },
  { value: 900, label: 'Force' },
];

function patchItem(id, fields) {
  return fetch(`/api/settings-items/${SECTION}/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
  }).then((res) => res.json()).catch(() => null);
}

function StatusPill({ item }) {
  if (!item.enabled) return <span className="status-pill status-off">Disabled</span>;
  if (item.status === 'ok') return <span className="status-pill status-on" title={item.version || ''}>{icons.check}Connected</span>;
  if (item.status === 'fail') return <span className="status-pill status-fail">{icons.alert}Failed</span>;
  return <span className="status-pill status-pending">Untested</span>;
}

function FieldRow({ label, desc, children }) {
  return (
    <div className="form-row">
      <div className="field-label"><p className="name">{label}</p>{desc && <p className="desc">{desc}</p>}</div>
      <div className="field-control">{children}</div>
    </div>
  );
}

function SwitchField({ checked, onChange }) {
  return (
    <label className="switch">
      <input type="checkbox" checked={!!checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="slider"></span>
    </label>
  );
}

function TypeSpecificFields({ item, onChange }) {
  if (item.type === 'qbittorrent') {
    return (
      <>
        <FieldRow label="Initial state">
          <select className="field-select" value={item.initialState} onChange={(e) => onChange('initialState', e.target.value)}>
            <option value="start">Start</option>
            <option value="forceStart">Force start</option>
            <option value="addPaused">Add paused</option>
          </select>
        </FieldRow>
        <FieldRow label="Content layout">
          <select className="field-select" value={item.contentLayout} onChange={(e) => onChange('contentLayout', e.target.value)}>
            <option value="original">Original</option>
            <option value="subfolder">Create subfolder</option>
            <option value="nosubfolder">Don't create subfolder</option>
          </select>
        </FieldRow>
        <FieldRow label="Sequential order">
          <SwitchField checked={item.sequentialOrder} onChange={(v) => onChange('sequentialOrder', v)} />
        </FieldRow>
        <FieldRow label="First and last piece priority">
          <SwitchField checked={item.firstLastPiecePriority} onChange={(v) => onChange('firstLastPiecePriority', v)} />
        </FieldRow>
      </>
    );
  }
  if (item.type === 'nzbget') {
    return (
      <FieldRow label="NZBGet priority">
        <select className="field-select" value={item.nzbPriority} onChange={(e) => onChange('nzbPriority', Number(e.target.value))}>
          {NZB_PRIORITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </FieldRow>
    );
  }
  return null;
}

function EditModal({ item, onChange, onClose, onTest, testing, testResult }) {
  const typeLabel = (CLIENT_TYPES[item.type] || {}).label || item.type;
  return (
    <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box wide">
        <div className="modal-header">
          <h2>{typeLabel}</h2>
          <button className="modal-close" type="button" aria-label="Close" onClick={onClose}>{icons.x}</button>
        </div>
        <div className="modal-body">
          <FieldRow label="Name">
            <input className="field-input" type="text" value={item.name} onChange={(e) => onChange('name', e.target.value)} />
          </FieldRow>
          <FieldRow label="Host">
            <input className="field-input" type="text" placeholder="e.g. 192.168.1.20" value={item.host} onChange={(e) => onChange('host', e.target.value)} />
          </FieldRow>
          <FieldRow label="Port">
            <input className="field-input" type="number" value={item.port} onChange={(e) => onChange('port', Number(e.target.value))} />
          </FieldRow>
          <FieldRow label="Use SSL">
            <SwitchField checked={item.useSsl} onChange={(v) => onChange('useSsl', v)} />
          </FieldRow>
          <FieldRow label="Username">
            <input className="field-input" type="text" autoComplete="off" value={item.username || ''} onChange={(e) => onChange('username', e.target.value)} />
          </FieldRow>
          <FieldRow label="Password">
            <input className="field-input" type="password" autoComplete="new-password" value={item.password || ''} onChange={(e) => onChange('password', e.target.value)} />
          </FieldRow>
          <FieldRow label="Category" desc="Must already exist on the client — Kitsune doesn't create categories for you.">
            <input className="field-input" type="text" placeholder="e.g. kitsune" value={item.category || ''} onChange={(e) => onChange('category', e.target.value)} />
          </FieldRow>
          <FieldRow label="Client priority" desc="Lower runs first when more than one client is enabled.">
            <input className="field-input" type="number" value={item.clientPriority} onChange={(e) => onChange('clientPriority', Number(e.target.value))} />
          </FieldRow>
          <TypeSpecificFields item={item} onChange={onChange} />
          <p className={`form-error${testResult ? '' : ' is-collapsed'}`} style={{ color: testResult && testResult.ok ? 'var(--success)' : 'var(--danger)' }}>
            {testResult ? testResult.message : ''}
          </p>
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-test" disabled={testing} onClick={onTest}>{testing ? 'Testing…' : 'Test Connection'}</button>
          <button type="button" className="btn-accent" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

export default function DownloadClients({ addBtnContainer }) {
  const [data, setData] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [testingIds, setTestingIds] = useState(() => new Set());
  const [modalTesting, setModalTesting] = useState(false);
  const [modalTestResult, setModalTestResult] = useState(null);
  // Set to a client's id for exactly the one render right after its Test
  // (row button or the modal's Test Connection) comes back successful — same
  // one-shot flash as System > Tasks' completion animation (see
  // .row-flash-success in styles.css). A test run from inside the edit
  // modal still sets this even though the row is hidden behind the modal at
  // that instant; the flash plays the next time the row actually renders,
  // which is the moment the modal closes.
  const [flashId, setFlashId] = useState(null);

  const editingItem = editingId != null ? data.find((d) => d.id === editingId) || null : null;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/settings-items/${SECTION}`)
      .then((res) => res.json())
      .then((items) => { if (!cancelled) { setData(items); setLoaded(true); } })
      .catch(() => { if (!cancelled) { setData([]); setLoaded(true); } });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    setModalTesting(false);
    setModalTestResult(null);
  }, [editingId]);

  // The flash is meant for exactly one render — clear it right after so it
  // doesn't replay on a later, unrelated re-render of the same row.
  useEffect(() => {
    if (flashId == null) return;
    const t = setTimeout(() => setFlashId(null), 1600);
    return () => clearTimeout(t);
  }, [flashId]);

  function handleToggleEnabled(item, enabled) {
    setData((prev) => prev.map((d) => (d.id === item.id ? { ...d, enabled } : d)));
    patchItem(item.id, { enabled });
  }

  function handleRemove(item) {
    setData((prev) => prev.filter((d) => d.id !== item.id));
    fetch(`/api/settings-items/${SECTION}/${item.id}`, { method: 'DELETE' }).catch(() => {});
  }

  // Runs a real Test against the client's currently-saved fields, merged
  // with any `overrides` (used by the edit modal to test values just typed
  // but not necessarily saved yet).
  async function testItem(item, overrides) {
    try {
      const res = await fetch(`/api/download-clients/${item.id}/test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(overrides || {}),
      });
      const result = await res.json();
      if (result.item) setData((prev) => prev.map((d) => (d.id === item.id ? { ...d, ...result.item } : d)));
      return result;
    } catch {
      return { ok: false, error: 'Request failed — is the Kitsune server reachable?' };
    }
  }

  async function handleRowTest(item) {
    if (testingIds.has(item.id)) return;
    setTestingIds((prev) => new Set(prev).add(item.id));
    const result = await testItem(item, {});
    setTestingIds((prev) => { const next = new Set(prev); next.delete(item.id); return next; });
    setFlashId(result.ok ? item.id : null);
  }

  function handleFieldChange(key, value) {
    const current = data.find((d) => d.id === editingId);
    if (!current) return;
    setData((prev) => prev.map((d) => (d.id === editingId ? { ...d, [key]: value } : d)));
    patchItem(editingId, { [key]: value });
  }

  async function handleModalTest() {
    if (modalTesting || !editingItem) return;
    setModalTesting(true);
    setModalTestResult(null);
    // Every field in the modal, not just what's already saved — controlled
    // inputs mean `editingItem` already holds whatever's currently typed.
    const overrides = {
      name: editingItem.name, host: editingItem.host, port: editingItem.port, useSsl: editingItem.useSsl,
      username: editingItem.username, password: editingItem.password, category: editingItem.category,
      clientPriority: editingItem.clientPriority,
      ...(editingItem.type === 'qbittorrent'
        ? { initialState: editingItem.initialState, contentLayout: editingItem.contentLayout, sequentialOrder: editingItem.sequentialOrder, firstLastPiecePriority: editingItem.firstLastPiecePriority }
        : editingItem.type === 'nzbget' ? { nzbPriority: editingItem.nzbPriority } : {}),
    };
    const result = await testItem(editingItem, overrides);
    setModalTesting(false);
    setFlashId(result.ok ? editingItem.id : null);
    // No "v" prefix added here — qBittorrent's own version string already
    // comes back as "v4.5.2", NZBGet's as bare "21.1"; adding one
    // unconditionally doubled up qBittorrent's ("vv4.5.2"). Showing
    // whatever the client actually returned, as-is, is correct for both.
    const latest = result.item || editingItem;
    setModalTestResult(result.ok
      ? { message: `Connected — ${latest.version || 'OK'}`, ok: true }
      : { message: result.error || 'Connection failed.', ok: false });
  }

  async function handleAddType(key) {
    const type = CLIENT_TYPES[key];
    if (!type) return;
    setPanelOpen(false);
    const newFields = { ...type.defaults };
    let created;
    try {
      const res = await fetch(`/api/settings-items/${SECTION}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newFields),
      });
      created = await res.json();
    } catch {
      created = { id: data.length ? Math.max(...data.map((d) => d.id)) + 1 : 1, ...newFields };
    }
    setData((prev) => [...prev, created]);
    // Straight into the edit form — an empty host/username/password isn't
    // useful sitting in the list, so the natural next step after picking a
    // type is filling those in, same as Sonarr/Radarr's own "add client"
    // flow landing you on its settings form.
    setEditingId(created.id);
  }

  return (
    <>
      {addBtnContainer && createPortal(
        <button className="btn-accent" type="button" onClick={() => setPanelOpen((o) => !o)}>
          {icons.plus}Add download client
        </button>,
        addBtnContainer,
      )}

      <div className={`add-panel${panelOpen ? ' open' : ''}`}>
        <p className="add-panel-label">Choose a type to add</p>
        {Object.entries(CLIENT_TYPES).map(([key, t]) => (
          <button key={key} type="button" className="type-chip" onClick={() => handleAddType(key)}>{t.label}</button>
        ))}
      </div>

      <div className="dlclient-header">
        <span>Name</span><span>Host</span><span>Category</span><span>Priority</span><span>Status</span><span>Enabled</span><span></span><span></span>
      </div>

      {!loaded ? (
        <p className="settings-empty">Loading…</p>
      ) : data.length === 0 ? (
        <p className="settings-empty">None configured yet.</p>
      ) : (
        data.map((item) => (
          <div className={`dlclient-row${item.id === flashId ? ' row-flash-success' : ''}`} data-id={item.id} key={item.id}>
            <div className="settings-name">
              <p className="settings-title">
                {item.name}
                <button className="ep-action" type="button" aria-label={`Edit ${item.name}`} onClick={() => setEditingId(item.id)}>{icons.edit}</button>
              </p>
              <span className="audio-tag">{(CLIENT_TYPES[item.type] || {}).label || item.type}</span>
            </div>
            <span className="settings-meta">{item.host ? `${item.host}:${item.port}` : '—'}</span>
            <span className="settings-meta">{item.category || '—'}</span>
            <span className="settings-meta">{item.clientPriority}</span>
            <StatusPill item={item} />
            <label className="switch">
              <input type="checkbox" checked={!!item.enabled} onChange={(e) => handleToggleEnabled(item, e.target.checked)} />
              <span className="slider"></span>
            </label>
            <button className="btn-test" type="button" disabled={testingIds.has(item.id)} onClick={() => handleRowTest(item)}>
              {testingIds.has(item.id) ? 'Testing…' : 'Test'}
            </button>
            <button className="ep-action" type="button" aria-label={`Remove ${item.name}`} onClick={() => handleRemove(item)}>{icons.x}</button>
          </div>
        ))
      )}

      {editingItem && (
        <EditModal
          item={editingItem}
          onChange={handleFieldChange}
          onClose={() => setEditingId(null)}
          onTest={handleModalTest}
          testing={modalTesting}
          testResult={modalTestResult}
        />
      )}
    </>
  );
}
