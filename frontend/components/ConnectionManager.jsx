import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { icons } from '../lib/icons.jsx';

// Shared by Settings > Indexers / Import Lists / Connect — a faithful port
// of initConnectionManager in public/js/pages/settings-connections.js
// (Download Clients split off from that same controller before this
// migration and gets its own component — see DownloadClients.jsx). One
// component, parameterized the same way the original function was: `section`
// picks the API route, `types` are the add-panel's template choices,
// `metaLabel`/`priorityLabel` name whatever columns 2 and 3 mean on each
// page (Indexers: "Categories"/"Priority", Import Lists: "Root
// folder"/"Profile", Connect: "Triggers"/"Events" — purely header text,
// doesn't affect storage).
//
// Only Connect's Pushover type is a real integration (see README's "Connect:
// real Pushover notifications") — everything else here still simulates its
// Test button with a timeout, exactly as before.

const PUSHOVER_TRIGGER_LABELS = [['notifyOnGrab', 'Grab'], ['notifyOnImport', 'Import'], ['notifyOnFail', 'Failure']];
const PUSHOVER_PRIORITY_OPTIONS = [
  { value: -2, label: 'Lowest (no notification)' },
  { value: -1, label: 'Low (no sound/vibration)' },
  { value: 0, label: 'Normal' },
  { value: 1, label: 'High (bypasses quiet hours)' },
];

function isPushover(section, item) {
  return section === 'connect' && item.type === 'pushover';
}

function pushoverMetaLabel(item) {
  const on = PUSHOVER_TRIGGER_LABELS.filter(([key]) => item[key]).map(([, label]) => label);
  return on.length > 0 ? `On ${on.join(', ')}` : 'No triggers';
}

function patchItem(section, id, fields) {
  return fetch(`/api/settings-items/${section}/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
  }).catch(() => {});
}

function StatusPill({ item }) {
  if (!item.enabled) return <span className="status-pill status-off">Disabled</span>;
  if (item.status === 'ok') return <span className="status-pill status-on">{icons.check}Connected</span>;
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

// Pushover's real fields (User Key/API Token/Priority/Triggers) vs. every
// other type's generic Protocol/metaLabel/Priority fields — same branch
// renderModal() made in the original, just as JSX instead of two template
// string arms.
function EditModal({ item, section, metaLabel, onChange, onClose, onTest, testing, testResult }) {
  const pushover = isPushover(section, item);

  return (
    <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box wide">
        <div className="modal-header">
          <h2>Edit {item.name}</h2>
          <button className="modal-close" type="button" aria-label="Close" onClick={onClose}>{icons.x}</button>
        </div>
        <div className="modal-body">
          <FieldRow label="Name">
            <input className="field-input" type="text" value={item.name} onChange={(e) => onChange('name', e.target.value)} />
          </FieldRow>

          {pushover ? (
            <>
              <FieldRow label="User Key">
                <input
                  className="field-input" type="text" autoComplete="off"
                  placeholder="30-character key from your Pushover dashboard"
                  value={item.userKey || ''} onChange={(e) => onChange('userKey', e.target.value)}
                />
              </FieldRow>
              <FieldRow label="API Token" desc="From an application registered at pushover.net/apps/build.">
                <input
                  className="field-input" type="password" autoComplete="new-password"
                  placeholder="Your application's API token"
                  value={item.apiToken || ''} onChange={(e) => onChange('apiToken', e.target.value)}
                />
              </FieldRow>
              <FieldRow label="Priority">
                <select className="field-select" value={item.priority} onChange={(e) => onChange('priority', Number(e.target.value))}>
                  {PUSHOVER_PRIORITY_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              </FieldRow>
              <FieldRow label="Triggers">
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', alignItems: 'flex-start' }}>
                  {PUSHOVER_TRIGGER_LABELS.map(([key, label]) => (
                    <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '7px', fontSize: '13px', fontWeight: 500 }}>
                      <input type="checkbox" checked={!!item[key]} onChange={(e) => onChange(key, e.target.checked)} />
                      On {label}
                    </label>
                  ))}
                </div>
              </FieldRow>
              <p className={`form-error${testResult ? '' : ' is-collapsed'}`} style={{ color: testResult && testResult.ok ? 'var(--success)' : 'var(--danger)' }}>
                {testResult ? testResult.message : ''}
              </p>
            </>
          ) : (
            <>
              <FieldRow label="Protocol">
                <input className="field-input" type="text" value={item.protocol || ''} onChange={(e) => onChange('protocol', e.target.value)} />
              </FieldRow>
              <FieldRow label={metaLabel || 'Details'}>
                <input className="field-input" type="text" value={item.meta || ''} onChange={(e) => onChange('meta', e.target.value)} />
              </FieldRow>
              <FieldRow label="Priority">
                <input className="field-input" type="number" value={item.priority} onChange={(e) => onChange('priority', Number(e.target.value))} />
              </FieldRow>
            </>
          )}
        </div>
        <div className="modal-footer">
          {pushover && (
            <button type="button" className="btn-test" disabled={testing} onClick={onTest}>
              {testing ? 'Sending…' : 'Send Test Notification'}
            </button>
          )}
          <button className="btn-accent" type="button" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

export default function ConnectionManager({ section, types, metaLabel, priorityLabel, addBtnLabel, addBtnContainer }) {
  const [data, setData] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [testingIds, setTestingIds] = useState(() => new Set());
  const [modalTesting, setModalTesting] = useState(false);
  const [modalTestResult, setModalTestResult] = useState(null);

  const editingItem = editingId != null ? data.find((d) => d.id === editingId) || null : null;

  // Load once on mount. Includes the one-time backfill for a "Pushover"
  // Connect row created before real Pushover support existed (see README's
  // "Connect: real Pushover notifications" — a row like that has no `type`
  // field, so it'd otherwise fall back to the generic edit form forever).
  // Detected by name rather than type (since type is exactly the thing
  // missing) and patched in place, same as the vanilla-JS version.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let items = [];
      try {
        const res = await fetch(`/api/settings-items/${section}`);
        items = await res.json();
      } catch {
        items = [];
      }
      if (section === 'connect') {
        items = items.map((item) => {
          if (item.name !== 'Pushover' || item.type === 'pushover') return item;
          const patch = {
            type: 'pushover',
            userKey: item.userKey || '',
            apiToken: item.apiToken || '',
            // The pre-migration generic Priority field was an arbitrary
            // 1-100 weight (25 by default) — meaningless on Pushover's own
            // -2..1 scale, so it's reset to Normal (0) rather than carried
            // over.
            priority: 0,
            notifyOnGrab: item.notifyOnGrab ?? false,
            notifyOnImport: item.notifyOnImport ?? true,
            notifyOnFail: item.notifyOnFail ?? false,
          };
          const updated = { ...item, ...patch };
          updated.meta = pushoverMetaLabel(updated);
          patchItem(section, item.id, { ...patch, meta: updated.meta });
          return updated;
        });
      }
      if (!cancelled) { setData(items); setLoaded(true); }
    })();
    return () => { cancelled = true; };
  }, [section]);

  // Reset the modal's own transient Test UI every time a different item's
  // modal opens (or the modal closes) — a stale "Sent — check your device"
  // message from the last item shouldn't linger for the next one.
  useEffect(() => {
    setModalTesting(false);
    setModalTestResult(null);
  }, [editingId]);

  function handleToggleEnabled(item, enabled) {
    setData((prev) => prev.map((d) => (d.id === item.id ? { ...d, enabled } : d)));
    patchItem(section, item.id, { enabled });
  }

  function handleRemove(item) {
    setData((prev) => prev.filter((d) => d.id !== item.id));
    fetch(`/api/settings-items/${section}/${item.id}`, { method: 'DELETE' }).catch(() => {});
  }

  async function handleRowTest(item) {
    if (testingIds.has(item.id)) return;
    setTestingIds((prev) => new Set(prev).add(item.id));
    if (isPushover(section, item)) {
      // A real test against whatever's already saved — no unsaved-field
      // overrides here, those only apply from inside the edit modal's own
      // Test button (see handleModalTest below), which has actual input
      // fields to read live values from.
      try {
        const res = await fetch(`/api/connect/${item.id}/test`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
        });
        const result = await res.json();
        setData((prev) => prev.map((d) => (d.id === item.id ? (result.item ? { ...d, ...result.item } : { ...d, status: 'fail' }) : d)));
      } catch {
        setData((prev) => prev.map((d) => (d.id === item.id ? { ...d, status: 'fail' } : d)));
      }
    } else {
      // Every other type is still simulated — entries already flagged as
      // failing stay flagged, everything else that's enabled comes back
      // healthy, same as the original's fake 700ms Test.
      await new Promise((r) => setTimeout(r, 700));
      const status = item.status === 'fail' ? 'fail' : 'ok';
      setData((prev) => prev.map((d) => (d.id === item.id ? { ...d, status } : d)));
      patchItem(section, item.id, { status });
    }
    setTestingIds((prev) => { const next = new Set(prev); next.delete(item.id); return next; });
  }

  function handleFieldChange(key, value) {
    const current = data.find((d) => d.id === editingId);
    if (!current) return;
    const updated = { ...current, [key]: value };
    const patchFields = { [key]: value };
    // A trigger checkbox changing also updates the derived Triggers summary
    // shown in the list row.
    if (isPushover(section, updated) && PUSHOVER_TRIGGER_LABELS.some(([k]) => k === key)) {
      updated.meta = pushoverMetaLabel(updated);
      patchFields.meta = updated.meta;
    }
    setData((prev) => prev.map((d) => (d.id === editingId ? updated : d)));
    patchItem(section, editingId, patchFields);
  }

  async function handleModalTest() {
    if (modalTesting || !editingItem) return;
    setModalTesting(true);
    setModalTestResult(null);
    // Every field currently shown in the modal — controlled inputs mean
    // `editingItem` already holds whatever's currently typed (see
    // handleFieldChange, which writes into `data` on every change), so
    // there's no separate "read straight off the DOM" step needed the way
    // the vanilla-JS version had to do it.
    const overrides = {
      name: editingItem.name, userKey: editingItem.userKey, apiToken: editingItem.apiToken,
      priority: editingItem.priority, notifyOnGrab: editingItem.notifyOnGrab,
      notifyOnImport: editingItem.notifyOnImport, notifyOnFail: editingItem.notifyOnFail,
    };
    try {
      const res = await fetch(`/api/connect/${editingItem.id}/test`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(overrides),
      });
      const result = await res.json();
      if (result.item) setData((prev) => prev.map((d) => (d.id === editingItem.id ? { ...d, ...result.item } : d)));
      setModalTestResult({
        message: result.ok ? 'Sent — check your device.' : (result.error || 'Could not send the test notification.'),
        ok: result.ok,
      });
    } catch {
      setModalTestResult({ message: 'Request failed — is the Kitsune server reachable?', ok: false });
    } finally {
      setModalTesting(false);
    }
  }

  async function handleAddType(type) {
    setPanelOpen(false);
    // `type.extra` (only Pushover has one) is spread last so it can override
    // the generic priority: 25 default with whatever's actually meaningful
    // for that type's own scale.
    const newFields = { name: type.name, protocol: type.protocol, meta: type.meta, priority: 25, enabled: false, status: 'pending', ...(type.extra || {}) };
    let created;
    try {
      const res = await fetch(`/api/settings-items/${section}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newFields),
      });
      created = await res.json();
    } catch {
      created = { id: data.length ? Math.max(...data.map((d) => d.id)) + 1 : 1, ...newFields };
    }
    setData((prev) => [...prev, created]);
    // Straight into the edit form for a real-integration type (currently
    // just Pushover) — an empty User Key/API Token isn't useful sitting in
    // the list.
    if (type.extra) setEditingId(created.id);
  }

  return (
    <>
      {addBtnContainer && createPortal(
        <button className="btn-accent" type="button" onClick={() => setPanelOpen((o) => !o)}>
          {icons.plus}{addBtnLabel}
        </button>,
        addBtnContainer,
      )}

      <div className={`add-panel${panelOpen ? ' open' : ''}`}>
        <p className="add-panel-label">Choose a type to add</p>
        {types.map((t) => (
          <button key={t.key} type="button" className="type-chip" onClick={() => handleAddType(t)}>{t.name}</button>
        ))}
      </div>

      <div className="settings-header">
        <span>Name</span><span>{metaLabel}</span><span>{priorityLabel}</span><span>Status</span><span>Enabled</span><span></span><span></span><span></span>
      </div>

      {!loaded ? (
        <p className="settings-empty">Loading…</p>
      ) : data.length === 0 ? (
        <p className="settings-empty">None configured yet.</p>
      ) : (
        data.map((item) => (
          <div className="settings-row" data-id={item.id} key={item.id}>
            <div className="settings-name">
              <p className="settings-title">{item.name}</p>
              <span className="audio-tag">{item.protocol}</span>
            </div>
            <span className="settings-meta">{item.meta}</span>
            <span className="settings-meta">{item.priority}</span>
            <StatusPill item={item} />
            <label className="switch">
              <input type="checkbox" checked={!!item.enabled} onChange={(e) => handleToggleEnabled(item, e.target.checked)} />
              <span className="slider"></span>
            </label>
            <button className="btn-test" type="button" disabled={testingIds.has(item.id)} onClick={() => handleRowTest(item)}>
              {testingIds.has(item.id) ? 'Testing…' : 'Test'}
            </button>
            <button className="ep-action" type="button" aria-label={`Edit ${item.name}`} onClick={() => setEditingId(item.id)}>{icons.edit}</button>
            <button className="ep-action" type="button" aria-label={`Remove ${item.name}`} onClick={() => handleRemove(item)}>{icons.x}</button>
          </div>
        ))
      )}

      {editingItem && (
        <EditModal
          item={editingItem}
          section={section}
          metaLabel={metaLabel}
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
