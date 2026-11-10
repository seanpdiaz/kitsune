import { useEffect, useRef, useState } from 'react';
import { icons } from '../../lib/icons.jsx';

// Pieces of the series page header (see SeriesPage.jsx): the top-right "…"
// menu over the backdrop, and the two dialogs it opens that aren't shared
// with anything else (Change poster/background, Edit titles and sort name).
// Design notes: wiki/Series-Page.md.

const svg = (children) => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{children}</svg>
);

export const headerIcons = {
  poster: svg(<><rect x="5" y="3" width="14" height="18" rx="2" /><circle cx="10" cy="9" r="1.6" /><path d="M19 15l-4-4-10 9" /></>),
  background: svg(<><rect x="3" y="5" width="18" height="14" rx="2" /><circle cx="9" cy="10" r="1.6" /><path d="M21 16l-5-5-9 8" /></>),
  titles: svg(<path d="M4 7V5h16v2M12 5v14M9 19h6" />),
  rescan: svg(<><path d="M11 19H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h4l3 3h7a2 2 0 0 1 2 2v2" /><circle cx="17" cy="17" r="3" /><path d="M21 21l-1.8-1.8" /></>),
  rename: svg(<><path d="M4 7h11M4 12h7M4 17h6" /><path d="M14 20l6-6a1.4 1.4 0 0 0-2-2l-6 6v2h2z" /></>),
  bookmark: (filled) => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill={filled ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="2" strokeLinejoin="round"><path d="M18 7v14l-6-4-6 4V7a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4z" /></svg>
  ),
  back: svg(<path d="M15 6l-6 6 6 6" />),
};

// Closes on outside click or Escape — same two dismissal paths as the
// episode row menu (EpisodeActionsMenu).
function useDismiss(open, setOpen, wrapRef) {
  useEffect(() => {
    if (!open) return undefined;
    function onDocMouseDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    function onKeydown(e) { if (e.key === 'Escape') setOpen(false); }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeydown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeydown);
    };
  }, [open, setOpen, wrapRef]);
}

// groups: [{ label?, items: [{ key, label, icon, onClick, disabled?, danger?, title? }] }]
export function SeriesMenu({ groups }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  useDismiss(open, setOpen, wrapRef);
  return (
    <div className="series-hero-menu" ref={wrapRef}>
      <button
        type="button" className="series-hero-menu-btn" aria-label="More series actions" data-tooltip="More"
        aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}
      >
        {icons.dots}
      </button>
      {open && (
        <div className="ep-menu series-hero-dropdown" role="menu">
          {groups.map((g, gi) => (
            <div key={gi} className="series-hero-menu-group">
              {g.label && <p className="series-hero-menu-label">{g.label}</p>}
              {g.items.map((it) => (
                <button
                  key={it.key} type="button" role="menuitem" className={it.danger ? 'danger' : ''}
                  disabled={it.disabled} title={it.title}
                  onClick={() => { setOpen(false); it.onClick(); }}
                >
                  {it.icon}{it.label}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Change poster / Change background. For now a URL field with a live
// preview; picking from the metadata sources' own artwork (Plex-style
// gallery) is the planned next step. Saving an empty background clears it,
// so the header goes back to the blurred-poster backdrop.
export function ArtworkModal({ series, kind, onClose, onSaved }) {
  const isPoster = kind === 'poster';
  const field = isPoster ? 'poster' : 'fanart';
  const [url, setUrl] = useState(series[field] || '');
  const [previewOk, setPreviewOk] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [choices, setChoices] = useState(null); // null = loading; TheTVDB images, best first
  const [choicesNote, setChoicesNote] = useState('');
  const trimmed = url.trim();

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/series/${series.id}/artwork?kind=${isPoster ? 'poster' : 'background'}`)
      .then((r) => r.json())
      .then((body) => {
        if (cancelled) return;
        setChoices(body.images || []);
        setChoicesNote(body.message || '');
      })
      .catch(() => { if (!cancelled) { setChoices([]); setChoicesNote("Couldn't load images from TheTVDB."); } });
    return () => { cancelled = true; };
  }, [series.id, isPoster]);

  async function save(value) {
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/series/${series.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ [field]: value }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onSaved(body);
    } catch (err) {
      setError(err.message || "Couldn't save — try again.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box wide">
        <div className="modal-header">
          <h2>{isPoster ? 'Change poster' : 'Change background'}</h2>
          <button className="modal-close" type="button" aria-label="Close" data-tooltip="Close" onClick={onClose}>{icons.x}</button>
        </div>
        <div className="modal-body">
          <p className="hero-field-label">From TheTVDB</p>
          {choices === null ? (
            <p className="settings-meta">Loading images…</p>
          ) : choices.length === 0 ? (
            <p className="settings-meta">{choicesNote || `TheTVDB has no ${isPoster ? 'posters' : 'backgrounds'} for this series.`}</p>
          ) : (
            <div className={`artwork-choices ${isPoster ? 'is-poster' : 'is-fanart'}`}>
              {choices.map((c) => (
                <button
                  type="button" key={c.url} className={`artwork-choice${trimmed === c.url ? ' is-selected' : ''}`}
                  title={[c.language ? c.language.toUpperCase() : 'No text', c.width && c.height ? `${c.width}×${c.height}` : null].filter(Boolean).join(' · ')}
                  aria-pressed={trimmed === c.url}
                  onClick={() => { setUrl(c.url); setPreviewOk(true); }}
                >
                  <img src={c.thumbnail} alt="" loading="lazy" />
                </button>
              ))}
            </div>
          )}
          <label className="hero-field-label" htmlFor="artworkUrl" style={{ marginTop: 16 }}>Or an image URL</label>
          <input
            id="artworkUrl" type="url" className="field-input" value={url} autoFocus
            placeholder={isPoster ? 'https://…/poster.jpg' : 'https://…/fanart.jpg'}
            onChange={(e) => { setUrl(e.target.value); setPreviewOk(true); }}
            style={{ width: '100%' }}
          />
          <p className="settings-meta" style={{ marginTop: 8 }}>
            {isPoster
              ? 'Portrait image, ideally 2:3.'
              : 'Wide image, ideally 16:9. Leave empty to use a blurred copy of the poster.'}
          </p>
          <div className={`artwork-preview ${isPoster ? 'is-poster' : 'is-fanart'}`}>
            {trimmed && previewOk
              ? <img src={trimmed} alt="Preview" onError={() => setPreviewOk(false)} />
              : <span>{trimmed ? "That image couldn't be loaded." : 'No image'}</span>}
          </div>
          <p className={`form-error${error ? '' : ' is-collapsed'}`}>{error}</p>
        </div>
        <div className="modal-footer">
          {!isPoster && series.fanart && (
            <button type="button" className="btn-danger" disabled={saving} onClick={() => save('')} style={{ marginRight: 'auto' }}>Remove background</button>
          )}
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="btn-accent" type="button" disabled={saving || (isPoster && !trimmed)} onClick={() => save(trimmed)}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

// Edit titles and sort name: display title (same field Edit Series has) plus
// an optional sort title for the Library's Title sort. Alternate titles are
// shown read-only; they come from the metadata sources and drive search.
export function TitlesModal({ series, onClose, onSaved }) {
  const [title, setTitle] = useState(series.title || '');
  const [sortTitle, setSortTitle] = useState(series.sortTitle || '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const alts = series.altTitles || [];

  async function handleSave() {
    if (!title.trim()) { setError('Enter a title.'); return; }
    setSaving(true);
    setError('');
    try {
      const payload = { sortTitle: sortTitle.trim() };
      if (title.trim() !== series.title) payload.title = title.trim();
      const res = await fetch(`/api/series/${series.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onSaved(body);
    } catch (err) {
      setError(err.message || "Couldn't save — try again.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box">
        <div className="modal-header">
          <h2>Edit titles and sort name</h2>
          <button className="modal-close" type="button" aria-label="Close" data-tooltip="Close" onClick={onClose}>{icons.x}</button>
        </div>
        <div className="modal-body">
          <label className="hero-field-label" htmlFor="titlesDisplay">Title</label>
          <input id="titlesDisplay" type="text" className="field-input" value={title} onChange={(e) => setTitle(e.target.value)} style={{ width: '100%' }} />
          <label className="hero-field-label" htmlFor="titlesSort" style={{ marginTop: 14, display: 'block' }}>Sort title</label>
          <input id="titlesSort" type="text" className="field-input" value={sortTitle} placeholder={title} onChange={(e) => setSortTitle(e.target.value)} style={{ width: '100%' }} />
          <p className="settings-meta" style={{ marginTop: 8 }}>Used when the Library is sorted by title. Leave empty to sort by the title above.</p>
          {alts.length > 0 && (
            <>
              <p className="hero-field-label" style={{ marginTop: 14 }}>Alternate titles</p>
              <ul className="titles-alt-list">
                {alts.map((t) => <li key={t}>{t}</li>)}
              </ul>
              <p className="settings-meta">From the metadata sources. Used to match releases when searching.</p>
            </>
          )}
          <p className={`form-error${error ? '' : ' is-collapsed'}`}>{error}</p>
        </div>
        <div className="modal-footer">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="btn-accent" type="button" disabled={saving} onClick={handleSave}>{saving ? 'Saving…' : 'Save'}</button>
        </div>
      </div>
    </div>
  );
}
