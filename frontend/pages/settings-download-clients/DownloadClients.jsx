import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { icons } from '../../lib/icons.jsx';
import { formatBytes } from '../../../public/js/lib/format.js';

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
      remotePathMappingRemote: '', remotePathMappingLocal: '',
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

// qBittorrent's own `state` enum (see server/lib/download-clients/
// qbittorrent.js's header comment for the API docs this is drawn from) —
// mapped to a human label plus which existing status-pill/progress-fill
// color reads right for it, reusing the same tones already used everywhere
// else (status-on/off/fail/pending, fill accent/success/warning/danger)
// rather than inventing new ones for this one modal.
const TORRENT_STATE_META = {
  downloading: { label: 'Downloading', pill: 'status-on', fill: 'accent' },
  forcedDL: { label: 'Downloading (forced)', pill: 'status-on', fill: 'accent' },
  metaDL: { label: 'Fetching metadata', pill: 'status-pending', fill: 'accent' },
  allocating: { label: 'Allocating', pill: 'status-pending', fill: 'accent' },
  checkingDL: { label: 'Checking', pill: 'status-pending', fill: 'accent' },
  checkingUP: { label: 'Checking', pill: 'status-pending', fill: 'success' },
  checkingResumeData: { label: 'Checking', pill: 'status-pending', fill: 'accent' },
  queuedDL: { label: 'Queued', pill: 'status-pending', fill: 'accent' },
  queuedUP: { label: 'Queued to seed', pill: 'status-pending', fill: 'success' },
  stalledDL: { label: 'Stalled', pill: 'status-pending', fill: 'warning' },
  stalledUP: { label: 'Seeding (idle)', pill: 'status-on', fill: 'success' },
  uploading: { label: 'Seeding', pill: 'status-on', fill: 'success' },
  forcedUP: { label: 'Seeding (forced)', pill: 'status-on', fill: 'success' },
  pausedDL: { label: 'Paused', pill: 'status-off', fill: 'warning' },
  pausedUP: { label: 'Completed', pill: 'status-off', fill: 'success' },
  moving: { label: 'Moving', pill: 'status-pending', fill: 'accent' },
  error: { label: 'Error', pill: 'status-fail', fill: 'danger' },
  missingFiles: { label: 'Missing Files', pill: 'status-fail', fill: 'danger' },
  unknown: { label: 'Unknown', pill: 'status-pending', fill: 'accent' },
};
function describeTorrentState(state) {
  return TORRENT_STATE_META[state] || { label: state || 'Unknown', pill: 'status-pending', fill: 'accent' };
}
function isPausedState(state) {
  return state === 'pausedDL' || state === 'pausedUP';
}
// qBittorrent reports an ETA of 8640000 (100 days — its own "unknown/
// infinite" sentinel) rather than omitting the field when there's nothing
// meaningful to show, e.g. a stalled or seeding torrent — displayed as "∞"
// instead of a nonsense "100d 0h".
function formatEta(seconds) {
  if (seconds == null || seconds >= 8640000) return '∞';
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  if (mins < 60) return `${mins}m`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ${mins % 60}m`;
  const days = Math.floor(hrs / 24);
  return `${days}d ${hrs % 24}h`;
}

// Settings > Download Clients' "Torrents" button on a qBittorrent-type row
// opens this — the real, live torrent list for that specific client
// (server/lib/download-clients/qbittorrent.js / server/routes/
// download-clients.js's torrents routes), scoped to the client's configured
// category. Polls every 3s while open so progress/speed/ETA move on their
// own without a manual refresh, same "just poll, no websocket" approach
// Activity > Queue already uses for the simulated pipeline's progress.
function TorrentsModal({ client, onClose }) {
  const [torrents, setTorrents] = useState(null); // null = still loading
  const [loadError, setLoadError] = useState('');
  const [addUrl, setAddUrl] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState('');
  const [busyHashes, setBusyHashes] = useState(() => new Set());
  const pollRef = useRef(null);

  async function load() {
    try {
      const res = await fetch(`/api/download-clients/${client.id}/torrents`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setTorrents(body);
      setLoadError('');
    } catch (err) {
      setLoadError(err.message || "Couldn't reach that client.");
    }
  }

  useEffect(() => {
    load();
    pollRef.current = setInterval(load, 3000);
    return () => clearInterval(pollRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client.id]);

  async function handleAdd(e) {
    e.preventDefault();
    const url = addUrl.trim();
    if (!url || adding) return;
    setAdding(true);
    setAddError('');
    try {
      const res = await fetch(`/api/download-clients/${client.id}/torrents`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      setAddUrl('');
      await load();
    } catch (err) {
      setAddError(err.message || 'Could not add that torrent.');
    } finally {
      setAdding(false);
    }
  }

  // Same endpoint pair regardless of what qBittorrent's own installed
  // version calls them internally (pause/resume vs. stop/start — see
  // qbittorrent.js) — the route layer hides that entirely.
  async function handleToggle(t) {
    setBusyHashes((prev) => new Set(prev).add(t.hash));
    const action = isPausedState(t.state) ? 'resume' : 'pause';
    try {
      await fetch(`/api/download-clients/${client.id}/torrents/${encodeURIComponent(t.hash)}/${action}`, { method: 'POST' });
    } catch {
      // load() right below shows whatever state actually stuck either way
    }
    await load();
    setBusyHashes((prev) => { const next = new Set(prev); next.delete(t.hash); return next; });
  }

  // Removes from qBittorrent's list only — deleteFiles is deliberately not
  // exposed here, matching this app's non-destructive-by-default convention
  // elsewhere (Backup's Remove only removes the backup file entry, not
  // anything it backed up).
  async function handleDelete(t) {
    setBusyHashes((prev) => new Set(prev).add(t.hash));
    try {
      await fetch(`/api/download-clients/${client.id}/torrents/${encodeURIComponent(t.hash)}`, { method: 'DELETE' });
    } catch {
      // ignore — load() reflects reality either way
    }
    await load();
    setBusyHashes((prev) => { const next = new Set(prev); next.delete(t.hash); return next; });
  }

  return (
    <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box wide">
        <div className="modal-header">
          <h2>{client.name} — Torrents</h2>
          <button className="modal-close" type="button" aria-label="Close" data-tooltip="Close" onClick={onClose}>{icons.x}</button>
        </div>
        <div className="modal-body">
          <form className="torrent-add-row" onSubmit={handleAdd}>
            <input
              className="field-input" type="text" placeholder="magnet: link or .torrent URL"
              value={addUrl} onChange={(e) => setAddUrl(e.target.value)}
            />
            <button className="btn-accent" type="submit" disabled={adding || !addUrl.trim()}>
              {adding ? 'Adding…' : 'Add'}
            </button>
          </form>
          {addError && <p className="form-error">{addError}</p>}

          {loadError ? (
            <p className="form-error">{loadError}</p>
          ) : torrents === null ? (
            <p className="settings-empty">Loading…</p>
          ) : torrents.length === 0 ? (
            <p className="settings-empty">
              {client.category ? `No torrents in the "${client.category}" category yet.` : 'No torrents yet.'}
            </p>
          ) : (
            <div className="torrent-list">
              {torrents.map((t) => {
                const meta = describeTorrentState(t.state);
                const pct = Math.round((t.progress || 0) * 100);
                const busy = busyHashes.has(t.hash);
                const paused = isPausedState(t.state);
                return (
                  <div className="torrent-row" key={t.hash}>
                    <div className="torrent-row-main">
                      <p className="settings-title" title={t.name}>{t.name}</p>
                      <div className="queue-progress">
                        <div className="progress"><div className={`fill ${meta.fill}`} style={{ width: `${pct}%` }} /></div>
                        <span className="progress-label">
                          {pct}% · {formatBytes(t.total_size)} · {formatBytes(t.dlspeed)}/s · ETA {formatEta(t.eta)}
                        </span>
                      </div>
                    </div>
                    <span className={`status-pill ${meta.pill}`}>{meta.label}</span>
                    <button
                      className="ep-action" type="button" disabled={busy}
                      aria-label={paused ? `Resume ${t.name}` : `Pause ${t.name}`}
                      data-tooltip={paused ? 'Resume torrent' : 'Pause torrent'}
                      onClick={() => handleToggle(t)}
                    >
                      {paused ? icons.play : icons.pause}
                    </button>
                    <button
                      className="ep-action" type="button" disabled={busy}
                      aria-label={`Remove ${t.name}`} data-tooltip="Remove torrent" onClick={() => handleDelete(t)}
                    >
                      {icons.x}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button type="button" className="btn-accent" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
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
        <FieldRow
          label="Remote path"
          desc="Only needed if qBittorrent runs on a different machine than Kitsune. The path qBittorrent itself reports its downloads are saved under — leave both this and Local path blank if qBittorrent and Kitsune share the same filesystem."
        >
          <input
            className="field-input" type="text" placeholder="e.g. /downloads/complete"
            value={item.remotePathMappingRemote || ''} onChange={(e) => onChange('remotePathMappingRemote', e.target.value)}
          />
        </FieldRow>
        <FieldRow
          label="Local path"
          desc="Where that same folder is reachable from Kitsune's own host — e.g. a shared network mount or Docker volume. Kitsune translates one to the other when importing a completed real download."
        >
          <input
            className="field-input" type="text" placeholder="e.g. /mnt/downloads/complete"
            value={item.remotePathMappingLocal || ''} onChange={(e) => onChange('remotePathMappingLocal', e.target.value)}
          />
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
          <button className="modal-close" type="button" aria-label="Close" data-tooltip="Close" onClick={onClose}>{icons.x}</button>
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
  const [torrentsClientId, setTorrentsClientId] = useState(null);
  // { id, ok } for exactly the one render right after a Test (row button or
  // the modal's Test Connection) comes back, success or failure — a green
  // three-pulse flash either way ok is true, red when it's false (see
  // .row-flash-success / .row-flash-fail in styles.css). A test run from
  // inside the edit modal still sets this even though the row is hidden
  // behind the modal at that instant; the flash plays the next time the row
  // actually renders, which is the moment the modal closes.
  const [flash, setFlash] = useState(null);

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
    if (!flash) return;
    const t = setTimeout(() => setFlash(null), 1600);
    return () => clearTimeout(t);
  }, [flash]);

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
    setFlash({ id: item.id, ok: result.ok });
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
    setFlash({ id: editingItem.id, ok: result.ok });
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
        <span>Name</span><span>Host</span><span>Category</span><span>Priority</span><span>Status</span><span>Enabled</span><span></span><span></span><span></span><span></span>
      </div>

      {!loaded ? (
        <p className="settings-empty">Loading…</p>
      ) : data.length === 0 ? (
        <p className="settings-empty">None configured yet.</p>
      ) : (
        data.map((item) => (
          <div className={`dlclient-row${flash && flash.id === item.id ? (flash.ok ? ' row-flash-success' : ' row-flash-fail') : ''}`} data-id={item.id} key={item.id}>
            <div className="settings-name">
              <p className="settings-title">{item.name}</p>
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
            {/* Torrents only exists for qBittorrent — NZBGet's own API
                doesn't have an equivalent per-torrent queue shape (see
                server/routes/download-clients.js's torrents route comment).
                An empty placeholder keeps the grid column count identical
                for both types rather than reflowing the row. */}
            {item.type === 'qbittorrent'
              ? <button className="ep-action" type="button" aria-label={`Manage torrents on ${item.name}`} data-tooltip="View torrents" onClick={() => setTorrentsClientId(item.id)}>{icons.viewTable}</button>
              : <span></span>}
            {/* Its own trailing column now, matching every other list-style
                Settings page (Indexers/Import Lists/Connect via
                ConnectionManager.jsx, Users) — Edit then Remove, both 32px —
                instead of sitting inline next to the name like a second
                label. */}
            <button className="ep-action" type="button" aria-label={`Edit ${item.name}`} data-tooltip="Edit client" onClick={() => setEditingId(item.id)}>{icons.edit}</button>
            <button className="ep-action" type="button" aria-label={`Remove ${item.name}`} data-tooltip="Remove client" onClick={() => handleRemove(item)}>{icons.x}</button>
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

      {torrentsClientId != null && data.find((d) => d.id === torrentsClientId) && (
        <TorrentsModal
          client={data.find((d) => d.id === torrentsClientId)}
          onClose={() => setTorrentsClientId(null)}
        />
      )}
    </>
  );
}
