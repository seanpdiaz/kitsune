import { useEffect, useRef, useState } from 'react';
import { icons } from '../../lib/icons.jsx';
import { tagChipStyleObj } from '../../lib/tagChipStyleObj.js';
import { formatAirDate } from '../../../public/js/lib/dates.js';
import { initFileBrowserModal } from '../../../public/js/lib/file-browser-modal.js';
import { initReleasePickerModal } from '../../../public/js/lib/release-picker-modal.js';
import { initEpisodeDetailsModal } from '../../../public/js/lib/episode-details-modal.js';

// React port of the Series detail half of public/js/pages/library.js (now
// deleted) — see README's "React migration" section. The release picker and
// episode details modals are reused imperatively as-is (same pattern as
// Quality's range-slider and Media Management's file browser reuse) rather
// than rewritten in JSX — both are self-contained "build once, append to
// <body>, expose open()" widgets with no page-specific markup to fold into
// this component's own tree, so there's nothing to gain from a rewrite.

// ---------------------------------------------------------------------------
// Frieren's hand-built demo data — kept verbatim. Every other series gets a
// flat/segmented list generated from real data instead (buildGenericEpisodes/
// buildRealEpisodeRows below).
// ---------------------------------------------------------------------------
const episodesBySegment = {
  '2': [
    { num: 21, title: 'Report from the capital', date: 'Feb 22', audio: 'Dual', quality: '1080p', state: 'done' },
    { num: 22, title: "A parting gift", date: 'Mar 1', audio: null, quality: null, state: 'pending' },
    { num: 20, title: "The journey's beginning", date: 'Feb 15', audio: null, quality: null, state: 'missing' },
    { num: 19, title: 'Aureole', date: 'Feb 8', audio: 'Dual', quality: '1080p', state: 'downloading', pct: 65 },
  ],
  '1': Array.from({ length: 5 }, (_, i) => ({
    num: i + 1, title: `Episode ${i + 1}`, date: `Sep ${29 + i}`, audio: 'Dual', quality: '1080p', state: 'done',
  })),
  'sp': [
    { num: 1, title: 'Special: memories of the journey', date: 'Dec 2023', audio: 'Sub', quality: '1080p', state: 'done' },
  ],
};

function buildGenericEpisodes(series) {
  const m = /(\d+)\s*\/\s*(\d+)/.exec(series.eps || '');
  const downloaded = m ? parseInt(m[1], 10) : 0;
  const total = m ? parseInt(m[2], 10) : downloaded;
  const eps = [];
  for (let n = 1; n <= total; n++) {
    let state = 'pending';
    if (n <= downloaded) state = 'done';
    else if (n === downloaded + 1 && series.status === 'continuing') state = 'missing';
    eps.push({
      num: n,
      title: `Episode ${n}`,
      date: state === 'pending' ? 'TBA' : '—',
      audio: state === 'done' ? 'Dual' : null,
      quality: state === 'done' ? '1080p' : null,
      state,
    });
  }
  return eps;
}

function buildRealEpisodeRows(series, realEpisodes, queueByEpisodeId) {
  const today = new Date().toISOString().slice(0, 10);
  return realEpisodes.map((e) => {
    const queued = queueByEpisodeId.get(e.id);
    let state = 'pending';
    if (queued) state = 'downloading';
    else if (e.downloaded) state = 'done';
    else if (e.aired && e.aired <= today) state = 'missing';
    return {
      id: e.id,
      num: e.num,
      seasonNumber: e.seasonNumber ?? 0,
      seasonName: e.seasonName || null,
      title: e.title || `Episode ${e.num}`,
      titleJapanese: e.titleJapanese || null,
      titleRomanji: e.titleRomanji || null,
      date: formatAirDate(e.aired),
      audio: e.downloaded ? 'Dual' : null,
      quality: e.quality || null,
      pct: queued ? queued.progressPct : undefined,
      queueId: queued ? queued.queueId : undefined,
      score: typeof e.score === 'number' ? e.score : null,
      filler: !!e.filler,
      recap: !!e.recap,
      state,
      downloaded: !!e.downloaded,
      path: e.path || null,
      sizeBytes: e.sizeBytes ?? null,
      overview: e.overview || null,
    };
  });
}

function groupEpisodesBySeason(rows) {
  const bySeason = new Map();
  for (const row of rows) {
    const key = row.seasonNumber ?? 0;
    if (!bySeason.has(key)) bySeason.set(key, { seasonNumber: key, seasonName: row.seasonName, rows: [] });
    bySeason.get(key).rows.push(row);
  }
  return Array.from(bySeason.values()).sort((a, b) => a.seasonNumber - b.seasonNumber);
}

function segmentLabel(group) {
  if (group.seasonNumber === 0) return 'Specials';
  return group.seasonName || `Season ${group.seasonNumber}`;
}

// ---------------------------------------------------------------------------
// Episode row
// ---------------------------------------------------------------------------
function EpisodeRow({ ep, onSearch, onCancel, onDetails }) {
  const rowClass = ep.state === 'missing' ? 'missing' : ep.state === 'downloading' ? 'downloading' : '';
  const canAct = ep.id != null;
  let status, action;
  if (ep.state === 'done') {
    status = <span className="ep-status status-done">{icons.check}Downloaded</span>;
    action = <button className="ep-action" aria-label="Options">{icons.dots}</button>;
  } else if (ep.state === 'missing') {
    status = <span className="ep-status status-missing">{icons.alert}Missing</span>;
    action = canAct
      ? <button className="ep-action" type="button" aria-label="Search episode" onClick={() => onSearch(ep.id)}>{icons.search}</button>
      : <button className="ep-action" aria-label="Search episode" disabled style={{ opacity: 0.4 }}>{icons.search}</button>;
  } else if (ep.state === 'downloading') {
    status = <span className="ep-status status-dl">{icons.download}{ep.pct}%</span>;
    action = canAct && ep.queueId != null
      ? <button className="ep-action" type="button" aria-label="Cancel download" onClick={() => onCancel(ep.queueId)}>{icons.x}</button>
      : <button className="ep-action" aria-label="Cancel download" disabled style={{ opacity: 0.4 }}>{icons.x}</button>;
  } else {
    status = <span className="ep-status status-pending">{icons.clock}Not aired</span>;
    action = <button className="ep-action" aria-label="Search episode" disabled style={{ opacity: 0.4 }}>{icons.dots}</button>;
  }

  const extraTags = [];
  if (ep.filler) extraTags.push(<span key="filler" className="audio-tag" style={{ marginLeft: 6, color: 'var(--warning)' }}>Filler</span>);
  if (ep.recap) extraTags.push(<span key="recap" className="audio-tag" style={{ marginLeft: 6, color: 'var(--text-muted)' }}>Recap</span>);
  if (typeof ep.score === 'number') extraTags.push(<span key="score" className="audio-tag" style={{ marginLeft: 6 }}>★ {ep.score.toFixed(1)}</span>);

  const altTitles = [ep.titleRomanji, ep.titleJapanese].filter((t) => t && t !== ep.title);
  const titleAttr = altTitles.length ? altTitles.join(' / ') : undefined;

  return (
    <div className={`ep-row ${rowClass}`}>
      <span className="ep-num">{ep.num}</span>
      {canAct ? (
        <span className="ep-title ep-title-clickable" title={titleAttr} onClick={() => onDetails(ep.id)}>{ep.title}{extraTags}</span>
      ) : (
        <span className="ep-title" title={titleAttr}>{ep.title}{extraTags}</span>
      )}
      <span className="ep-date">{ep.date || '—'}</span>
      <span>{ep.audio ? <span className="audio-tag">{ep.audio}</span> : <span style={{ color: 'var(--text-muted)' }}>—</span>}</span>
      <span className="ep-date">{ep.quality || '—'}</span>
      {status}
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit Series modal
// ---------------------------------------------------------------------------
function EditSeriesModal({ series, onClose, onSaved, onDeleteInstead, pathBrowserRef }) {
  const [monitored, setMonitored] = useState(!!series.monitored);
  const [monitorNewSeasons, setMonitorNewSeasons] = useState(series.monitorNewSeasons || 'all');
  const [seasonFolder, setSeasonFolder] = useState(series.seasonFolder !== false);
  const [seriesType, setSeriesType] = useState(series.seriesType || 'anime');
  const [path, setPath] = useState(series.path || '');
  const [profiles, setProfiles] = useState([]);
  const [qualityProfile, setQualityProfile] = useState(series.qualityProfile || '');
  const [allTags, setAllTags] = useState([]);
  const [selectedTagIds, setSelectedTagIds] = useState(() => new Set(series.tagIds || []));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      let loadedProfiles = [];
      try {
        const res = await fetch('/api/settings-items/profiles');
        loadedProfiles = await res.json();
      } catch {
        loadedProfiles = [{ id: 'any', name: 'Any' }];
      }
      setProfiles(loadedProfiles);
      const names = loadedProfiles.map((p) => p.name);
      setQualityProfile(series.qualityProfile && names.includes(series.qualityProfile) ? series.qualityProfile : (names[0] || ''));
      try {
        const res = await fetch('/api/tags');
        setAllTags(await res.json());
      } catch {
        setAllTags([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    pathBrowserRef.current = initFileBrowserModal({
      modalId: 'fileBrowserModal', closeId: 'fileBrowserModalClose', pathInputId: 'fileBrowserPathInput',
      listId: 'fileBrowserList', errorId: 'fileBrowserError', cancelId: 'fileBrowserModalCancel', okId: 'fileBrowserModalOk',
      onConfirm: async (chosenPath) => { setPath(chosenPath); },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const selectedTags = allTags.filter((t) => selectedTagIds.has(t.id));
  const remainingTags = allTags.filter((t) => !selectedTagIds.has(t.id));

  function removeTag(id) {
    setSelectedTagIds((prev) => { const next = new Set(prev); next.delete(id); return next; });
  }
  function addTag(id) {
    if (!id) return;
    setSelectedTagIds((prev) => new Set(prev).add(id));
  }

  async function handleSave() {
    setError('');
    setSaving(true);
    try {
      const res = await fetch(`/api/series/${series.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          monitored, monitorNewSeasons, seasonFolder, qualityProfile, seriesType,
          path: path.trim(), tagIds: Array.from(selectedTagIds),
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onSaved(body);
    } catch {
      setError("Couldn't save changes — try again.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box wide">
        <div className="modal-header">
          <h2>Edit - {series.title}</h2>
          <button className="modal-close" type="button" aria-label="Close" onClick={onClose}>{icons.x}</button>
        </div>
        <div className="modal-body">
          <div className="form-row">
            <div className="field-label"><p className="name">Monitored</p><p className="desc">Download monitored episodes in this series.</p></div>
            <div className="field-control"><label className="switch"><input type="checkbox" checked={monitored} onChange={(e) => setMonitored(e.target.checked)} /><span className="slider"></span></label></div>
          </div>
          <div className="form-row">
            <div className="field-label"><p className="name">Monitor New Seasons</p><p className="desc">Which new seasons should be monitored automatically.</p></div>
            <div className="field-control">
              <select className="field-select" value={monitorNewSeasons} onChange={(e) => setMonitorNewSeasons(e.target.value)}>
                <option value="all">All Seasons</option>
                <option value="future">Future Seasons</option>
                <option value="none">None</option>
              </select>
            </div>
          </div>
          <div className="form-row">
            <div className="field-label"><p className="name">Use Season Folder</p><p className="desc">Sort episodes into season folders.</p></div>
            <div className="field-control"><label className="switch"><input type="checkbox" checked={seasonFolder} onChange={(e) => setSeasonFolder(e.target.checked)} /><span className="slider"></span></label></div>
          </div>
          <div className="form-row">
            <div className="field-label"><p className="name">Quality Profile</p></div>
            <div className="field-control">
              <select className="field-select" value={qualityProfile} onChange={(e) => setQualityProfile(e.target.value)}>
                {profiles.map((p) => <option key={p.id} value={p.name}>{p.name}</option>)}
              </select>
            </div>
          </div>
          <div className="form-row">
            <div className="field-label"><p className="name">Series Type</p><p className="desc">Used for renaming, parsing, and searching.</p></div>
            <div className="field-control">
              <select className="field-select" value={seriesType} onChange={(e) => setSeriesType(e.target.value)}>
                <option value="anime">Anime</option>
                <option value="standard">Standard</option>
                <option value="daily">Daily</option>
              </select>
            </div>
          </div>
          <div className="form-row">
            <div className="field-label"><p className="name">Path</p></div>
            <div className="field-control wide">
              <div className="path-field-row">
                <input type="text" className="field-input" placeholder="/anime/library/Series Name" value={path} onChange={(e) => setPath(e.target.value)} />
                <button type="button" className="path-browse-btn" aria-label="Browse for a folder" onClick={() => pathBrowserRef.current && pathBrowserRef.current.open()}>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7h4l2-2h6l2 2h4v12H3z" /></svg>
                </button>
              </div>
            </div>
          </div>
          <div className="form-row">
            <div className="field-label"><p className="name">Tags</p></div>
            <div className="field-control wide">
              <div>
                <div className="edit-series-tags">
                  {selectedTags.map((t) => (
                    <span className="tag-chip" style={tagChipStyleObj(t.color)} key={t.id}>
                      {t.name}
                      <button type="button" aria-label={`Remove ${t.name}`} onClick={() => removeTag(t.id)}>{icons.x}</button>
                    </span>
                  ))}
                </div>
                <select className="field-select" style={{ marginTop: 8 }} value="" onChange={(e) => addTag(Number(e.target.value))}>
                  <option value="">+ Add tag…</option>
                  {remainingTags.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
            </div>
          </div>
          <p className={`form-error${error ? '' : ' is-collapsed'}`}>{error}</p>
        </div>
        <div className="modal-footer split">
          <button className="btn-danger" type="button" onClick={onDeleteInstead}>Delete</button>
          <div className="modal-footer-actions">
            <button type="button" onClick={onClose}>Cancel</button>
            <button className="btn-accent" type="button" disabled={saving} onClick={handleSave}>{saving ? 'Saving…' : 'Save'}</button>
          </div>
        </div>
      </div>

      <div className="modal-overlay" id="fileBrowserModal">
        <div className="modal-box wide">
          <div className="modal-header">
            <h2>File Browser</h2>
            <button className="modal-close" type="button" id="fileBrowserModalClose" aria-label="Close">{icons.x}</button>
          </div>
          <div className="modal-body">
            <input type="text" className="field-input" id="fileBrowserPathInput" placeholder="Start typing or select a path below" style={{ width: '100%', marginBottom: 12 }} />
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete Series modal
// ---------------------------------------------------------------------------
function DeleteSeriesModal({ series, onClose }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  async function handleConfirm() {
    setDeleting(true);
    setError('');
    try {
      const res = await fetch(`/api/series/${series.id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      window.location.href = 'index.html';
    } catch {
      setDeleting(false);
      setError("Couldn't delete this series — try again.");
    }
  }

  return (
    <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box">
        <div className="modal-header">
          <h2>Delete Series</h2>
          <button className="modal-close" type="button" aria-label="Close" onClick={onClose}>{icons.x}</button>
        </div>
        <div className="modal-body">
          <p>{error || `Are you sure you want to delete "${series.title}"? This can't be undone.`}</p>
        </div>
        <div className="modal-footer">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="btn-danger" type="button" disabled={deleting} onClick={handleConfirm}>{deleting ? 'Deleting…' : 'Delete'}</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function SeriesPage() {
  const [seriesData, setSeriesData] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [series, setSeries] = useState(null);

  const [frierenSegment, setFrierenSegment] = useState('1');
  const [realGroups, setRealGroups] = useState(null); // null until real episodes actually load
  const [activeSeasonNumber, setActiveSeasonNumber] = useState(null);

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const releasePickerRef = useRef(null);
  const episodeDetailsModalRef = useRef(null);
  const pathBrowserRef = useRef(null);
  const pollTimerRef = useRef(null);

  useEffect(() => {
    releasePickerRef.current = initReleasePickerModal();
    episodeDetailsModalRef.current = initEpisodeDetailsModal();
    return () => clearTimeout(pollTimerRef.current);
  }, []);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/series');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const rows = await res.json();
        setSeriesData(rows);
        const params = new URLSearchParams(window.location.search);
        const requestedId = Number(params.get('id'));
        const found = rows.find((s) => s.id === requestedId) || rows[0];
        setSeries(found || null);
        if (found) document.title = `Kitsune — ${found.title}`;
      } catch {
        setSeries(null);
      }
      setLoaded(true);
    })();
  }, []);

  // Real episode + live-queue fetch, same "synthetic shows immediately, real
  // data swaps in once it lands" behavior as the original — polls every 2s
  // for as long as something for this series is actually downloading,
  // stopping on its own once nothing's left to watch. One shared loader
  // (rather than a separate copy for the initial load vs. a post-grab/
  // -cancel reload) called both on series change and on demand via
  // loadRealEpisodesRef, so there's exactly one place this logic lives.
  const loadRealEpisodesRef = useRef(() => {});
  useEffect(() => {
    loadRealEpisodesRef.current = async () => {
      if (!series || series.title === 'Frieren') return;
      try {
        const [epRes, queueRes] = await Promise.all([
          fetch(`/api/series/${series.id}/episodes`),
          fetch('/api/queue'),
        ]);
        if (!epRes.ok) return;
        const epBody = await epRes.json();
        const real = epBody.episodes || [];
        if (real.length === 0) return; // nothing real for this series — synthetic list stays

        const queueByEpisodeId = new Map();
        if (queueRes.ok) {
          const queueBody = await queueRes.json();
          for (const q of queueBody.queue || []) {
            if (q.seriesId === series.id && q.status === 'downloading') {
              queueByEpisodeId.set(q.episodeId, { queueId: q.id, progressPct: q.progressPct });
            }
          }
        }

        const rows = buildRealEpisodeRows(series, real, queueByEpisodeId);
        const groups = groupEpisodesBySeason(rows);
        setRealGroups(groups);
        // Default to Season 1 on first load; keep whatever tab is already
        // active on a poll-triggered refresh instead of silently jumping
        // back to it out from under someone who already switched tabs.
        setActiveSeasonNumber((prev) => {
          if (prev != null && groups.some((g) => g.seasonNumber === prev)) return prev;
          return (groups.find((g) => g.seasonNumber === 1) || groups.find((g) => g.seasonNumber > 0) || groups[0]).seasonNumber;
        });

        clearTimeout(pollTimerRef.current);
        if (queueByEpisodeId.size > 0) {
          pollTimerRef.current = setTimeout(() => loadRealEpisodesRef.current(), 2000);
        }
      } catch (err) {
        console.error('Failed to load real episode data:', err);
      }
    };
  }, [series]);

  useEffect(() => {
    setRealGroups(null);
    setActiveSeasonNumber(null);
    clearTimeout(pollTimerRef.current);
    loadRealEpisodesRef.current();
    return () => clearTimeout(pollTimerRef.current);
    // Deliberately keyed on the series id, not the whole `series` object —
    // handleEditSaved() creates a new `series` object reference on every
    // save (even one that didn't touch anything episode-related), and
    // resetting/re-fetching the whole episode list after every metadata
    // edit would be a visible flicker regression the original didn't have
    // (it mutated the series object in place via Object.assign instead of
    // replacing it, so nothing re-ran).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series && series.id]);

  async function handleSearch(episodeId) {
    if (!releasePickerRef.current) return;
    const row = (realGroups || []).flatMap((g) => g.rows).find((r) => r.id === episodeId);
    if (!row) return;
    releasePickerRef.current.open(
      { id: episodeId, label: `S${String(row.seasonNumber).padStart(2, '0')}E${String(row.num).padStart(2, '0')}`, title: row.title },
      () => loadRealEpisodesRef.current(),
    );
  }
  async function handleCancel(queueId) {
    await fetch(`/api/queue/${queueId}`, { method: 'DELETE' });
    loadRealEpisodesRef.current();
  }
  function handleDetails(episodeId) {
    const row = (realGroups || []).flatMap((g) => g.rows).find((r) => r.id === episodeId);
    if (row && episodeDetailsModalRef.current) episodeDetailsModalRef.current.open(row);
  }

  function handleMonitorToggle(e) {
    const checked = e.target.checked;
    setSeries((prev) => ({ ...prev, monitored: checked }));
    fetch(`/api/series/${series.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ monitored: checked }),
    }).catch(() => {});
  }

  function handleEditSaved(body) {
    setSeries((prev) => ({ ...prev, ...body }));
    setEditOpen(false);
  }

  if (!loaded) return null;
  if (!series) return <p style={{ color: 'var(--text-muted)' }}>No series found.</p>;

  const epMatch = /(\d+)\s*\/\s*(\d+)/.exec(series.eps || '');
  const downloadedCount = epMatch ? parseInt(epMatch[1], 10) : 0;
  const sizeText = downloadedCount > 0 ? `${(downloadedCount * 0.47).toFixed(1)} GB` : '0 GB';
  let nextAiringText = '—';
  if (series.nextAirDays != null) nextAiringText = `in ${series.nextAirDays}d`;
  else if (series.airStatus) nextAiringText = series.airStatus;
  else if (series.status === 'ended') nextAiringText = 'Ended';

  const isFrieren = series.title === 'Frieren';
  let episodeList;
  let segmentButtons = null;
  if (isFrieren) {
    segmentButtons = ['sp', '1', '2'].map((seg) => (
      <button key={seg} className={frierenSegment === seg ? 'active' : ''} onClick={() => setFrierenSegment(seg)}>
        {seg === 'sp' ? 'Specials' : `Season ${seg}`}
      </button>
    ));
    episodeList = (episodesBySegment[frierenSegment] || []).map((ep, i) => <EpisodeRow key={i} ep={ep} onSearch={handleSearch} onCancel={handleCancel} onDetails={handleDetails} />);
  } else if (realGroups) {
    if (realGroups.length > 1) {
      segmentButtons = realGroups.map((g) => (
        <button key={g.seasonNumber} className={activeSeasonNumber === g.seasonNumber ? 'active' : ''} onClick={() => setActiveSeasonNumber(g.seasonNumber)}>
          {segmentLabel(g)}
        </button>
      ));
    }
    const activeGroup = realGroups.find((g) => g.seasonNumber === activeSeasonNumber) || realGroups[0];
    episodeList = (activeGroup ? activeGroup.rows : []).map((ep) => <EpisodeRow key={ep.id} ep={ep} onSearch={handleSearch} onCancel={handleCancel} onDetails={handleDetails} />);
  } else {
    episodeList = buildGenericEpisodes(series).map((ep, i) => <EpisodeRow key={i} ep={ep} onSearch={handleSearch} onCancel={handleCancel} onDetails={handleDetails} />);
  }

  return (
    <>
      <div className="detail-header">
        <div className="detail-poster" id="detailPoster">{series.poster && <img src={series.poster} alt={`${series.title} poster`} />}</div>
        <div className="detail-info">
          <div className="title-row">
            <div>
              <h1 id="detailTitle">{series.title}</h1>
              <p className="title-meta" id="detailMeta">{series.meta || ''}</p>
            </div>
            <div className="detail-actions">
              <label className="monitor-toggle"><input type="checkbox" checked={!!series.monitored} onChange={handleMonitorToggle} /> Monitored</label>
              <button>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
                Search all
              </button>
              <button type="button" onClick={() => setEditOpen(true)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z" /></svg>
                Edit
              </button>
              <button className="btn-danger" type="button" onClick={() => setDeleteOpen(true)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0-1 14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2L4 6" /></svg>
                Delete
              </button>
            </div>
          </div>
          <p className="overview" id="detailOverview">{series.overview || 'No overview available yet.'}</p>
          <div className="detail-stats">
            <div className="stat-card"><p className="label">Episodes</p><p className="value">{series.eps}</p></div>
            <div className="stat-card"><p className="label">Quality</p><p className="value">HD-1080p</p></div>
            <div className="stat-card"><p className="label">Size</p><p className="value">{sizeText}</p></div>
            <div className="stat-card"><p className="label">Next airing</p><p className="value">{nextAiringText}</p></div>
          </div>
        </div>
      </div>

      <div className="segment-tabs" id="segmentTabs" style={{ display: segmentButtons ? '' : 'none' }}>
        {segmentButtons}
      </div>

      <div className="ep-header">
        <span>Ep</span><span>Title</span><span>Air date</span><span>Audio</span><span>Quality</span><span>Status</span><span></span>
      </div>

      <div id="episodeList">{episodeList}</div>

      {deleteOpen && <DeleteSeriesModal series={series} onClose={() => setDeleteOpen(false)} />}
      {editOpen && (
        <EditSeriesModal
          series={series}
          onClose={() => setEditOpen(false)}
          onSaved={handleEditSaved}
          onDeleteInstead={() => { setEditOpen(false); setDeleteOpen(true); }}
          pathBrowserRef={pathBrowserRef}
        />
      )}
    </>
  );
}
