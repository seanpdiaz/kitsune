import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { icons } from '../lib/icons.jsx';

// Shared by Settings > Profiles and Custom Formats — a faithful port of
// initSimpleList in public/js/pages/settings-profiles-formats.js. Lighter
// weight than ConnectionManager.jsx: no live status/test, no enable toggle
// — these aren't connections, just named records with a couple of metadata
// columns. `renderRow(item)` supplies just the data-column JSX for one row
// (name/cutoff/etc. — the outer row container and Edit/Remove buttons are
// generic and rendered here); `renderEditFields(item, onChange)` supplies
// the edit modal's body the same way.

function fieldRow(label, desc, children) {
  return (
    <div className="form-row">
      <div className="field-label"><p className="name">{label}</p>{desc && <p className="desc">{desc}</p>}</div>
      <div className="field-control">{children}</div>
    </div>
  );
}

function patchItem(section, id, fields) {
  return fetch(`/api/settings-items/${section}/${id}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(fields),
  }).catch(() => {});
}

function EditModal({ item, onChange, onClose, renderEditFields }) {
  return (
    <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box">
        <div className="modal-header">
          <h2>Edit {item.name}</h2>
          <button className="modal-close" type="button" aria-label="Close" onClick={onClose}>{icons.x}</button>
        </div>
        <div className="modal-body">{renderEditFields(item, onChange)}</div>
        <div className="modal-footer">
          <button className="btn-accent" type="button" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}

export default function SimpleList({
  section, types, headerLabels, baseClass, addBtnLabel, addBtnContainer,
  newItemFields, renderRow, renderEditFields,
}) {
  const [data, setData] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [panelOpen, setPanelOpen] = useState(false);
  const [editingId, setEditingId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/settings-items/${section}`)
      .then((res) => res.json())
      .then((items) => { if (!cancelled) { setData(items); setLoaded(true); } })
      .catch(() => { if (!cancelled) { setData([]); setLoaded(true); } });
    return () => { cancelled = true; };
  }, [section]);

  const editingItem = editingId != null ? data.find((d) => d.id === editingId) || null : null;

  function handleRemove(item) {
    setData((prev) => prev.filter((d) => d.id !== item.id));
    fetch(`/api/settings-items/${section}/${item.id}`, { method: 'DELETE' }).catch(() => {});
  }

  function handleFieldChange(key, value) {
    setData((prev) => prev.map((d) => (d.id === editingId ? { ...d, [key]: value } : d)));
    patchItem(section, editingId, { [key]: value });
  }

  async function handleAddType(type) {
    setPanelOpen(false);
    const newFields = newItemFields(type);
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

      <div className={`${baseClass}-header`}>
        {headerLabels.map((label, i) => <span key={i}>{label}</span>)}
      </div>

      {!loaded ? (
        <p className="settings-empty">Loading…</p>
      ) : data.length === 0 ? (
        <p className="settings-empty">None configured yet.</p>
      ) : (
        data.map((item) => (
          <div className={`${baseClass}-row`} data-id={item.id} key={item.id}>
            {renderRow(item)}
            <button className="ep-action" type="button" aria-label={`Edit ${item.name}`} onClick={() => setEditingId(item.id)}>{icons.edit}</button>
            <button className="ep-action" type="button" aria-label={`Remove ${item.name}`} onClick={() => handleRemove(item)}>{icons.x}</button>
          </div>
        ))
      )}

      {editingItem && (
        <EditModal item={editingItem} onChange={handleFieldChange} onClose={() => setEditingId(null)} renderEditFields={renderEditFields} />
      )}
    </>
  );
}

export { fieldRow };
