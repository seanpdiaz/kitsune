import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { icons } from '../../lib/icons.jsx';
import { tagChipStyleObj } from '../../lib/tagChipStyleObj.js';

// React port of initTagManager + initTagSizeSlider in
// public/js/pages/settings-tags.js — see README's "React migration" section,
// Batch 8. Folded into one component (rather than splitting the size slider
// back out into its own file) since both pieces only ever appear on this one
// page and the slider needs a ref to the same cloud element the tag chips
// render into.

const TAG_COLORS = [
  { hex: '#f2703d', name: 'Orange' },
  { hex: '#3ed598', name: 'Green' },
  { hex: '#4d8df6', name: 'Blue' },
  { hex: '#a78bfa', name: 'Purple' },
  { hex: '#f472b6', name: 'Pink' },
  { hex: '#ed5b65', name: 'Red' },
  { hex: '#f2b705', name: 'Yellow' },
  { hex: '#2dd4bf', name: 'Teal' },
  { hex: '#9c9da8', name: 'Gray' },
];

function isPreset(hex) {
  return TAG_COLORS.some((c) => c.hex.toLowerCase() === String(hex).toLowerCase());
}

export default function TagsPage({ addBtnContainer }) {
  const [tags, setTags] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [pageError, setPageError] = useState('');
  const [removingIds, setRemovingIds] = useState(() => new Set());

  const [modalOpen, setModalOpen] = useState(false);
  const [mode, setMode] = useState('create');
  const [editingId, setEditingId] = useState(null);
  const [selectedColor, setSelectedColor] = useState(TAG_COLORS[0].hex);
  const [modalName, setModalName] = useState('');
  const [modalError, setModalError] = useState('');
  const [saving, setSaving] = useState(false);

  const cloudRef = useRef(null);
  const sliderRef = useRef(null);
  const customColorRef = useRef(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/tags');
        if (!res.ok) throw new Error('Request failed: ' + res.status);
        setTags(await res.json());
      } catch {
        setLoadError(true);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  // Tag cloud size slider — a purely local/visual preference persisted per-
  // browser (see original's comment on why: the page felt sparse with only
  // small chips). Ported as an effect writing directly to the cloud's own
  // CSS custom property and the slider's own gradient fill, same as the
  // vanilla version's direct DOM manipulation — neither one needs a React
  // re-render on every drag tick.
  useEffect(() => {
    const slider = sliderRef.current;
    const cloud = cloudRef.current;
    if (!slider || !cloud) return;
    function applyScale(value) {
      cloud.style.setProperty('--tag-scale', value);
      const min = Number(slider.min);
      const max = Number(slider.max);
      const pct = ((value - min) / (max - min)) * 100;
      slider.style.background = `linear-gradient(to right, var(--accent) 0%, var(--accent) ${pct}%, var(--surface-3) ${pct}%, var(--surface-3) 100%)`;
    }
    const saved = Number(localStorage.getItem('kitsune-tag-size'));
    const initial = saved && saved >= Number(slider.min) && saved <= Number(slider.max) ? saved : 1;
    slider.value = initial;
    applyScale(initial);
    function onInput() {
      const value = Number(slider.value);
      applyScale(value);
      localStorage.setItem('kitsune-tag-size', String(value));
    }
    slider.addEventListener('input', onInput);
    return () => slider.removeEventListener('input', onInput);
  }, []);

  useEffect(() => {
    function onKeydown(e) {
      if (e.key === 'Escape' && modalOpen) closeModal();
    }
    document.addEventListener('keydown', onKeydown);
    return () => document.removeEventListener('keydown', onKeydown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalOpen]);

  function pickRandomTagColor() {
    const usage = {};
    TAG_COLORS.forEach((c) => { usage[c.hex] = 0; });
    tags.forEach((t) => {
      const hex = String(t.color || '').toLowerCase();
      const match = TAG_COLORS.find((c) => c.hex.toLowerCase() === hex);
      if (match) usage[match.hex] += 1;
    });
    const minCount = Math.min(...TAG_COLORS.map((c) => usage[c.hex]));
    const leastUsed = TAG_COLORS.filter((c) => usage[c.hex] === minCount);
    return leastUsed[Math.floor(Math.random() * leastUsed.length)].hex;
  }

  function openModal(nextMode, tag) {
    setMode(nextMode);
    setEditingId(tag ? tag.id : null);
    setSelectedColor(tag ? tag.color : pickRandomTagColor());
    setModalName(tag ? tag.name : '');
    setModalError('');
    setModalOpen(true);
  }

  function closeModal() {
    setModalOpen(false);
    setEditingId(null);
  }

  async function handleRemove(tag) {
    setPageError('');
    setRemovingIds((prev) => new Set(prev).add(tag.id));
    try {
      const res = await fetch(`/api/tags/${tag.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed: ' + res.status);
      setTags((prev) => prev.filter((t) => t.id !== tag.id));
      if (editingId === tag.id) closeModal();
    } catch {
      setPageError('Could not remove that tag — try again.');
      setRemovingIds((prev) => { const next = new Set(prev); next.delete(tag.id); return next; });
      return;
    }
    setRemovingIds((prev) => { const next = new Set(prev); next.delete(tag.id); return next; });
  }

  async function handleSave() {
    const name = modalName.trim();
    setModalError('');
    if (!name) { setModalError('Tag name is required.'); return; }
    setSaving(true);
    try {
      const isEdit = mode === 'edit' && editingId != null;
      const res = await fetch(isEdit ? `/api/tags/${editingId}` : '/api/tags', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color: selectedColor }),
      });
      const body = await res.json();
      if (res.status === 409) {
        // Casing is preserved but duplicates are matched case-insensitively,
        // so show the name as it's actually stored, not just what was typed.
        setModalError(`"${body.tag ? body.tag.name : name}" already exists.`);
        setSaving(false);
        return;
      }
      if (!res.ok) throw new Error('Save failed: ' + res.status);
      if (isEdit) setTags((prev) => prev.map((t) => (t.id === editingId ? body : t)));
      else setTags((prev) => [...prev, body]);
      setSaving(false);
      closeModal();
    } catch {
      setModalError('Could not save that tag — try again.');
      setSaving(false);
    }
  }

  return (
    <>
      {addBtnContainer && createPortal(
        <button className="btn-accent" type="button" onClick={() => openModal('create')}>
          {icons.plus}Add Tag
        </button>,
        addBtnContainer,
      )}

      <div className="tags-toolbar">
        <p className="settings-subtitle">Tags can be applied to series, indexers, and other settings to control automation.</p>
        <div className="tag-size-control">
          <span className="tag-size-label">Size</span>
          <input ref={sliderRef} className="size-slider" type="range" min="1" max="2.4" step="0.1" defaultValue="1" aria-label="Tag size" />
        </div>
      </div>

      <p className={`form-error${pageError ? '' : ' is-collapsed'}`}>{pageError}</p>
      <div ref={cloudRef} className="tag-cloud">
        {!loaded ? (
          <p className="settings-empty">Loading tags…</p>
        ) : loadError ? (
          <p className="settings-empty">Couldn't load tags. Is the server running with SQLite support (Node 22.5+)?</p>
        ) : tags.length === 0 ? (
          <p className="settings-empty">No tags yet.</p>
        ) : (
          tags.map((tag) => (
            <span className="tag-chip" data-id={tag.id} key={tag.id} style={tagChipStyleObj(tag.color)}>
              {tag.name}<span className="tag-count">{tag.count}</span>
              <button type="button" aria-label={`Edit ${tag.name}`} onClick={() => openModal('edit', tag)}>{icons.edit}</button>
              <button type="button" aria-label={`Remove ${tag.name}`} disabled={removingIds.has(tag.id)} onClick={() => handleRemove(tag)}>{icons.x}</button>
            </span>
          ))
        )}
      </div>

      {modalOpen && (
        <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
          <div className="modal-box">
            <div className="modal-header">
              <h2>{mode === 'edit' ? 'Edit Tag' : 'Create New Tag'}</h2>
              <button className="modal-close" type="button" aria-label="Close" onClick={closeModal}>{icons.x}</button>
            </div>
            <div className="modal-body">
              <input className="field-input" type="text" placeholder="New tag name" value={modalName} onChange={(e) => setModalName(e.target.value)} autoFocus />
              <p className="modal-label">Tag color:</p>
              <div className="color-swatch-row">
                {TAG_COLORS.map((c) => (
                  <button
                    key={c.hex} type="button" className={`color-swatch${c.hex === selectedColor ? ' selected' : ''}`}
                    style={{ background: c.hex }} aria-label={c.name} onClick={() => setSelectedColor(c.hex)}
                  >
                    {c.hex === selectedColor ? <span className="swatch-check">{icons.check}</span> : null}
                  </button>
                ))}
                <button
                  type="button" className={`color-swatch-add${!isPreset(selectedColor) ? ' has-custom' : ''}`}
                  style={!isPreset(selectedColor) ? { background: selectedColor, borderColor: selectedColor } : undefined}
                  aria-label="Custom color"
                  onClick={() => customColorRef.current && customColorRef.current.click()}
                >
                  {!isPreset(selectedColor)
                    ? <span className="swatch-check">{icons.check}</span>
                    : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M12 5v14M5 12h14" /></svg>}
                </button>
              </div>
              <input
                ref={customColorRef}
                type="color"
                style={{ position: 'absolute', width: 0, height: 0, opacity: 0, pointerEvents: 'none' }}
                onChange={(e) => setSelectedColor(e.target.value)}
              />
              <p className={`form-error${modalError ? '' : ' is-collapsed'}`}>{modalError}</p>
            </div>
            <div className="modal-footer">
              <button type="button" onClick={closeModal}>Cancel</button>
              <button className="btn-accent" type="button" disabled={saving} onClick={handleSave}>Save</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
