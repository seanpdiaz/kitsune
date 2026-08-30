import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { icons } from '../../lib/icons.jsx';
import { tagChipStyleObj } from '../../lib/tagChipStyleObj.js';
import { formatAirDate } from '../../../public/js/lib/dates.js';
import { initReleasePickerModal } from '../../../public/js/lib/release-picker-modal.js';
import { initEpisodeDetailsModal } from '../../../public/js/lib/episode-details-modal.js';
import { formatBytes } from '../../../public/js/lib/format.js';
import { initFileBrowserModal } from '../../../public/js/lib/file-browser-modal.js';

// React port of the Series detail half of public/js/pages/library.js (now
// deleted) — see README's "React migration" section. The release picker and
// episode details modals are reused imperatively as-is (same pattern as
// Quality's range-slider and Media Management's file browser reuse) rather
// than rewritten in JSX — both are self-contained "build once, append to
// <body>, expose open()" widgets with no page-specific markup to fold into
// this component's own tree, so there's nothing to gain from a rewrite.

// ---------------------------------------------------------------------------
// Every series gets a flat/segmented episode list generated from real data
// (buildGenericEpisodes/buildRealEpisodeRows below) — buildGenericEpisodes is
// a client-side loading placeholder derived from the series' own real,
// persisted `eps` "N / M" count, shown only until real per-episode data
// (buildRealEpisodeRows) has loaded.
// ---------------------------------------------------------------------------
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

// Real per-file audio tracks (server/lib/ffprobe.js, only ever populated by
// a real import — Library Import, the per-series Rescan button, the
// auto-scan-on-add, or a real grab's completion) collapse to a short badge
// the same way the old fabricated 'Dual'/'Sub' strings did, just now backed
// by what the file actually has instead of a hardcoded guess. `mediaStreams`
// being null (nothing's ever probed this episode — a simulated download, or
// a real one from before ffprobe was wired in, or ffprobe just isn't
// installed on this machine) is a genuinely different, honest "don't know"
// — shown as "—", not a guess dressed up as a fact.
function summarizeAudioTracks(mediaStreams) {
  if (!mediaStreams || !Array.isArray(mediaStreams.audio)) return null;
  const count = mediaStreams.audio.length;
  if (count === 0) return 'None';
  if (count === 1) return 'Sub';
  return 'Dual';
}

// Gate for EpisodeActionsMenu's "Edit Tracks" item — mkvpropedit (see
// server/lib/mkvpropedit.js) only knows how to rewrite an .mkv file's own
// header flags, and there's nothing to default between if ffprobe never
// found an audio or subtitle stream to pick from (not probed yet, or a
// container ffprobe genuinely found nothing in).
function canEditTracks(ep) {
  if (!ep.path || !ep.path.toLowerCase().endsWith('.mkv')) return false;
  const ms = ep.mediaStreams;
  if (!ms) return false;
  const audioCount = Array.isArray(ms.audio) ? ms.audio.length : 0;
  const subtitleCount = Array.isArray(ms.subtitles) ? ms.subtitles.length : 0;
  return audioCount > 0 || subtitleCount > 0;
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
      audio: summarizeAudioTracks(e.mediaStreams),
      mediaStreams: e.mediaStreams || null,
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

// The "Next airing" stat card is a narrow, fixed-width box (see
// .detail-stats in styles.css) — server.js's own MAL_STATUS_LABELS map
// (routes/series.js) produces full-sentence labels like "Finished Airing"
// that wrap onto a second line there, breaking the card grid's alignment.
// Shortened for display only, right where the text is chosen — the real
// label straight from the source is still what's persisted and what the
// Library grid's own status chip / filters key off of, this just trims the
// one place it's rendered small.
const SHORT_AIR_STATUS = {
  'Finished Airing': 'Ended',
  'Currently Airing': 'Airing',
  'Not Yet Aired': 'Upcoming',
};
function shortenAirStatus(label) {
  return SHORT_AIR_STATUS[label] || label;
}

function segmentLabel(group) {
  if (group.seasonNumber === 0) return 'Specials';
  return group.seasonName || `Season ${group.seasonNumber}`;
}

// ---------------------------------------------------------------------------
// Media Info (episode row's "..." menu). Two tiers now instead of one flat
// guess: video codec/resolution/bitrate are still derived (quality tier name
// → its configured resolutionGroup, from Settings > Quality — this app has
// never stored a real per-episode video codec, only ever a quality tier
// name), but audio tracks and subtitles are real whenever ep.mediaStreams
// exists — server/lib/ffprobe.js actually ran on the real file (Library
// Import, the per-series Rescan button, the auto-scan-on-add, or a real
// grab's completion; see routes/import-files.js, routes/episodes.js,
// routes/queue.js) and this is showing exactly what it found. A real,
// single-Japanese-audio-track file used to get labeled "AAC 2.0 (Japanese),
// AAC 2.0 (English)" here regardless of what it actually contained — that's
// what this replaced. ep.mediaStreams is null for anything never probed
// (simulated downloads, or a real one from before this existed, or ffprobe
// not being installed) — that case still falls back to the old
// audio-badge-based guess rather than showing nothing, same as it always
// did.
// ---------------------------------------------------------------------------
const RESOLUTION_DIMENSIONS = { '2160p': '3840x2160', '1080p': '1920x1080', '720p': '1280x720', 'SD': '720x480' };
const CODEC_BY_RESOLUTION_GROUP = { '2160p': 'HEVC (x265)', '1080p': 'AVC (x264)', '720p': 'AVC (x264)', 'SD': 'AVC (x264)' };
// Same reference length server/lib/queue-sim.js's own REFERENCE_EPISODE_MINUTES
// already sizes every simulated release against — reusing it here means a
// derived bitrate is consistent with the sizeBytes that number actually
// produced, not a second, independently-guessed episode length.
const REFERENCE_EPISODE_MINUTES = 24;

function containerFromPath(path) {
  const m = /\.([a-z0-9]+)$/i.exec(path || '');
  return m ? m[1].toUpperCase() : 'MKV';
}

function buildMediaInfo(ep, resolutionGroupByQuality) {
  const resGroup = resolutionGroupByQuality.get(ep.quality) || null;
  const bitrateMbps = ep.sizeBytes
    ? (ep.sizeBytes * 8) / (REFERENCE_EPISODE_MINUTES * 60) / 1_000_000
    : null;

  // Real, ffprobe-read video dimensions/codec (see server/lib/ffprobe.js)
  // beat the quality-tier-derived guess below whenever they're available —
  // same "real data from the actual file beats a guess" rule the audio/
  // subtitles branch right below already follows. Only ever present for a
  // real import (Library Import, Rescan, the auto-scan-on-add, or a real
  // grab's completion); resolutionConfirmed just surfaces that distinction
  // to the caller so the modal can say so instead of showing a confirmed
  // measurement and a tier-based guess identically.
  const realVideo = ep.mediaStreams && ep.mediaStreams.video;
  let resolution;
  let videoCodec;
  let resolutionConfirmed = false;
  if (realVideo && realVideo.width && realVideo.height) {
    resolution = `${realVideo.width}x${realVideo.height}`;
    videoCodec = realVideo.codec && realVideo.codec !== 'Unknown' ? realVideo.codec : (resGroup ? CODEC_BY_RESOLUTION_GROUP[resGroup] : null);
    resolutionConfirmed = true;
  } else {
    resolution = resGroup ? RESOLUTION_DIMENSIONS[resGroup] : null;
    videoCodec = resGroup ? CODEC_BY_RESOLUTION_GROUP[resGroup] : null;
  }

  let audioTracks;
  let subtitles;
  if (ep.mediaStreams) {
    // Real data straight from ffprobe — see this section's header comment.
    const realAudio = Array.isArray(ep.mediaStreams.audio) ? ep.mediaStreams.audio : [];
    const realSubs = Array.isArray(ep.mediaStreams.subtitles) ? ep.mediaStreams.subtitles : [];
    audioTracks = realAudio.map((t) => `${t.codec} ${t.channels} (${t.language})`);
    subtitles = realSubs.length
      ? realSubs.map((s) => `${s.language}${s.forced ? ' (Forced)' : ''}`).join(', ')
      : (realAudio.length ? 'None' : null);
  } else {
    // Never probed (a simulated download, a real import from before ffprobe
    // was wired in, or ffprobe isn't installed on this machine) — the old
    // deterministic guess from the audio badge, same as this always showed.
    audioTracks = ep.audio === 'Dual'
      ? ['AAC 2.0 (Japanese)', 'AAC 2.0 (English)']
      : ep.audio === 'Sub'
        ? ['AAC 2.0 (Japanese)']
        : [];
    subtitles = ep.audio ? 'English (Full)' : null;
  }

  return {
    container: containerFromPath(ep.path),
    resolution,
    videoCodec,
    resolutionConfirmed,
    videoBitrate: bitrateMbps != null ? `${bitrateMbps.toFixed(1)} Mbps` : null,
    audioTracks,
    subtitles,
  };
}

// Nearest ancestor that actually clips/scrolls its content (computed
// overflow-y of auto/scroll), or null if the element scrolls with the page
// itself. Used by EpisodeActionsMenu below to work out how much room a
// dropdown really has below it — the episode list sits inside its own
// fixed-height scroll panel now (see .episode-list-scroll in styles.css),
// so window.innerHeight alone isn't the right boundary to check against
// anymore: it's bigger than the panel, so a check against it would still
// let the last row's menu render past the panel's bottom edge and get
// clipped. Walking up for the real scroll ancestor (rather than hardcoding
// ".episode-list-scroll") keeps this correct even if that container's name
// or nesting ever changes, and still falls back sanely to the old
// whole-page behavior anywhere this menu isn't inside a scroll panel at all.
function findScrollParent(el) {
  let node = el ? el.parentElement : null;
  while (node && node !== document.body) {
    const overflowY = window.getComputedStyle(node).overflowY;
    if (overflowY === 'auto' || overflowY === 'scroll') return node;
    node = node.parentElement;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Episode row's "..." menu — Media Info plus Delete (remove the media file
// backing this episode), a real dropdown (not just a dead button, which is
// all `icons.dots` rendered before) so more actions have somewhere to go
// later. Closes on outside click or Escape, same pair of dismissal paths
// every modal on this page already gets from CSS/its own keydown listener —
// this one isn't a modal, so it wires both itself.
//
// Opens downward by default, but flips to open upward (bottom: 100% instead
// of top: 100%) when there isn't enough room below — without this, opening
// the menu on one of the last rows in the (now independently scrolling —
// see .episode-list-scroll) episode list rendered its bottom item(s), most
// often the new Delete button, past the scroll panel's bottom edge and
// invisible, with no way to scroll further to reach them (that's clipped
// overflow, not unreached scroll content). Measured after the menu actually
// renders — via a layout effect, before the browser paints, so there's no
// visible flash of it opening downward first — rather than guessed up front
// from a hardcoded item count/height.
function EpisodeActionsMenu({ ep, onMediaInfo, onDeleteFile, onEditTracks }) {
  const [open, setOpen] = useState(false);
  const [openUpward, setOpenUpward] = useState(false);
  const wrapRef = useRef(null);
  const menuRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onDocMouseDown(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    function onKeydown(e) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onDocMouseDown);
    document.addEventListener('keydown', onKeydown);
    return () => {
      document.removeEventListener('mousedown', onDocMouseDown);
      document.removeEventListener('keydown', onKeydown);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) { setOpenUpward(false); return; }
    const menuEl = menuRef.current;
    if (!menuEl) return;
    const scrollParent = findScrollParent(wrapRef.current);
    const boundaryBottom = scrollParent ? scrollParent.getBoundingClientRect().bottom : window.innerHeight;
    if (menuEl.getBoundingClientRect().bottom > boundaryBottom) setOpenUpward(true);
  }, [open]);

  return (
    <div className="ep-action-wrap" ref={wrapRef}>
      <button
        type="button" className="ep-action" aria-label="Episode options" data-tooltip="Episode options"
        aria-haspopup="true" aria-expanded={open} onClick={() => setOpen((o) => !o)}
      >
        {icons.dots}
      </button>
      {open && (
        <div className="ep-menu" role="menu" ref={menuRef} style={openUpward ? { top: 'auto', bottom: 'calc(100% + 4px)' } : undefined}>
          <button type="button" role="menuitem" onClick={() => { setOpen(false); onMediaInfo(ep); }}>
            {icons.info}Media Info
          </button>
          {canEditTracks(ep) && (
            <button type="button" role="menuitem" onClick={() => { setOpen(false); onEditTracks(ep); }}>
              {icons.edit}Edit Tracks
            </button>
          )}
          <button type="button" role="menuitem" className="danger" onClick={() => { setOpen(false); onDeleteFile(ep); }}>
            {icons.trash}Delete
          </button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Episode row
// ---------------------------------------------------------------------------
function EpisodeRow({ ep, onSearch, onGrabBest, grabbingBestId, onCancel, onDetails, onMediaInfo, onDeleteFile, onEditTracks }) {
  const rowClass = ep.state === 'missing' ? 'missing' : ep.state === 'downloading' ? 'downloading' : '';
  const canAct = ep.id != null;
  let status, action;
  if (ep.state === 'done') {
    // "Available" rather than "Downloaded" — this status covers a real grab
    // just as much as an episode the automatic on-add root-folder scan (or a
    // manual Library Import) found already sitting on disk, which was never
    // "downloaded" through Kitsune at all (see server/routes/episodes.js's
    // scanExistingFilesForSeries and server/routes/import-files.js).
    // "Downloaded" implied an action Kitsune itself took; "Available" just
    // states the fact that stands either way.
    status = <span className="ep-status status-done">{icons.check}Available</span>;
    // Only real, DB-backed rows (an id to look up — same gating Search/
    // Cancel/title-click already use) get a working menu; the generic
    // synthetic fallback (shown before real episode data has loaded) has no
    // real sizeBytes/path/quality-tier-name behind it for Media Info to show.
    action = canAct
      ? <EpisodeActionsMenu ep={ep} onMediaInfo={onMediaInfo} onDeleteFile={onDeleteFile} onEditTracks={onEditTracks} />
      : <button className="ep-action" aria-label="Options" data-tooltip="Episode options" disabled style={{ opacity: 0.4 }}>{icons.dots}</button>;
  } else if (ep.state === 'missing') {
    status = <span className="ep-status status-missing">{icons.alert}Missing</span>;
    const grabbingThis = grabbingBestId === ep.id;
    action = canAct
      ? (
        <div className="ep-action-group">
          <button className="ep-action" type="button" aria-label="Search episode" data-tooltip="Search episode" onClick={() => onSearch(ep.id)}>{icons.search}</button>
          <button
            className="ep-action"
            type="button"
            aria-label="Grab best match"
            data-tooltip="Grab best match"
            disabled={grabbingBestId != null}
            style={grabbingThis ? { opacity: 0.5 } : undefined}
            onClick={() => onGrabBest(ep.id)}
          >
            {icons.zap}
          </button>
        </div>
      )
      : <button className="ep-action" aria-label="Search episode" data-tooltip="Search episode" disabled style={{ opacity: 0.4 }}>{icons.search}</button>;
  } else if (ep.state === 'downloading') {
    status = <span className="ep-status status-dl">{icons.download}{ep.pct}%</span>;
    action = canAct && ep.queueId != null
      ? <button className="ep-action" type="button" aria-label="Cancel download" data-tooltip="Cancel download" onClick={() => onCancel(ep.queueId)}>{icons.x}</button>
      : <button className="ep-action" aria-label="Cancel download" data-tooltip="Cancel download" disabled style={{ opacity: 0.4 }}>{icons.x}</button>;
  } else {
    status = <span className="ep-status status-not-aired">{icons.clock}Not aired</span>;
    action = <button className="ep-action" aria-label="Search episode" data-tooltip="Search episode" disabled style={{ opacity: 0.4 }}>{icons.dots}</button>;
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
function EditSeriesModal({ series, isComplete, onClose, onSaved, onDeleteInstead }) {
  const [title, setTitle] = useState(series.title || '');
  const [monitored, setMonitored] = useState(!!series.monitored);
  const [monitorNewSeasons, setMonitorNewSeasons] = useState(series.monitorNewSeasons || 'all');
  const [seasonFolder, setSeasonFolder] = useState(series.seasonFolder !== false);
  const [ignoreSpecials, setIgnoreSpecials] = useState(!!series.ignoreSpecials);
  const [seriesType, setSeriesType] = useState(series.seriesType || 'anime');
  const [profiles, setProfiles] = useState([]);
  const [qualityProfile, setQualityProfile] = useState(series.qualityProfile || '');
  const [allTags, setAllTags] = useState([]);
  const [selectedTagIds, setSelectedTagIds] = useState(() => new Set(series.tagIds || []));
  const [seriesPath, setSeriesPath] = useState(series.path || '');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const pathBrowserRef = useRef(null);

  // Reuses the same server-directory-browse widget Settings > Media
  // Management's "Add root folder" uses (see RootFolders.jsx) — imperative,
  // DOM-id-driven, so its markup gets rendered below with the same ids that
  // component uses. Unlike that one, onConfirm here doesn't hit an API: it
  // just fills in the Path field, so a bad pick can still be edited by hand
  // or reset by reopening the browser before Save actually persists it.
  useEffect(() => {
    pathBrowserRef.current = initFileBrowserModal({
      modalId: 'fileBrowserModal', closeId: 'fileBrowserModalClose', pathInputId: 'fileBrowserPathInput',
      listId: 'fileBrowserList', errorId: 'fileBrowserError', cancelId: 'fileBrowserModalCancel', okId: 'fileBrowserModalOk',
      onConfirm: async (chosenPath) => { setSeriesPath(chosenPath); },
      busyLabel: 'Setting…',
    });
  }, []);

  // Always starts the browser at a configured root folder (the first one,
  // same "first configured" convention firstConfiguredRootFolder uses
  // server-side) rather than wherever browsing was last left drilled into —
  // fetched fresh on every click instead of once on mount so it can't open
  // stale if root folders change while this modal's open, and so it's
  // consistent for every series' Edit modal, not just whichever one first
  // triggered the fetch.
  async function openPathBrowser() {
    let startPath = '/';
    try {
      const res = await fetch('/api/settings-items/root-folders');
      const folders = await res.json();
      if (Array.isArray(folders) && folders.length && folders[0].path) startPath = folders[0].path;
    } catch {
      // fall back to '/' — same starting point the browser already used
      // before root-folder-aware starting existed.
    }
    if (pathBrowserRef.current) pathBrowserRef.current.open(startPath);
  }

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
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setError('Title cannot be empty.');
      return;
    }
    setSaving(true);
    try {
      const payload = {
        title: trimmedTitle, monitored, monitorNewSeasons, seasonFolder, ignoreSpecials, qualityProfile, seriesType,
        tagIds: Array.from(selectedTagIds),
      };
      // Only send path when it's actually different — an empty/untouched
      // field shouldn't overwrite whatever series.path already is (the PATCH
      // handler rejects an empty path outright, and there's nothing to
      // change if it matches what's already saved).
      const trimmedPath = seriesPath.trim();
      if (trimmedPath && trimmedPath !== (series.path || '')) payload.path = trimmedPath;
      const res = await fetch(`/api/series/${series.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
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
    <>
    <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box wide">
        <div className="modal-header">
          <h2>Edit - {series.title}</h2>
          <button className="modal-close" type="button" aria-label="Close" data-tooltip="Close" onClick={onClose}>{icons.x}</button>
        </div>
        <div className="modal-body">
          <div className="form-row">
            <div className="field-label"><p className="name">Title</p></div>
            <div className="field-control"><input type="text" className="field-input" value={title} onChange={(e) => setTitle(e.target.value)} /></div>
          </div>
          <div className="form-row">
            <div className="field-label">
              <p className="name">Monitored</p>
              <p className="desc">{isComplete ? "This series is complete — there's nothing left to monitor." : 'Download monitored episodes in this series.'}</p>
            </div>
            <div className="field-control"><label className="switch"><input type="checkbox" checked={monitored} disabled={isComplete} onChange={(e) => setMonitored(e.target.checked)} /><span className="slider"></span></label></div>
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
            <div className="field-label"><p className="name">Ignore Specials</p><p className="desc">Don't count Specials toward this series' episode total — a missing/undownloaded special won't hold the progress bar below 100%. The Specials tab still shows them either way.</p></div>
            <div className="field-control"><label className="switch"><input type="checkbox" checked={ignoreSpecials} onChange={(e) => setIgnoreSpecials(e.target.checked)} /><span className="slider"></span></label></div>
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
          <div className="form-row edit-series-path-field">
            <div className="field-label"><p className="name">Path</p><p className="desc">Where this series' files are stored. Set automatically when the folder name matches — browse to point it at the real folder if the name on disk doesn't match this title.</p></div>
            <div className="field-control full">
              <div className="edit-series-path-row">
                <input
                  type="text" className="field-input" style={{ flex: 1 }} value={seriesPath}
                  onChange={(e) => setSeriesPath(e.target.value)}
                  placeholder="Not set yet — configure a root folder in Settings > Media Management."
                />
                <button type="button" className="btn-test" onClick={openPathBrowser}>Browse…</button>
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
                      <button type="button" aria-label={`Remove ${t.name}`} data-tooltip="Remove tag" onClick={() => removeTag(t.id)}>{icons.x}</button>
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
    </div>

    {/* Sibling to the Edit modal above, not nested inside it — same
        top-level placement RootFolders.jsx uses for this exact widget.
        Nesting one modal-overlay inside another's DOM subtree broke this
        modal's own closed/hidden state, since a fixed-position overlay's
        positioning (and CSS toggling) depends on nothing containing-block-
        forming sitting between it and the viewport; the Edit modal's own
        overlay was exactly that, and the result was this modal's empty
        input/button rendering inline in the Path field's row instead of
        staying hidden until opened. */}
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

// ---------------------------------------------------------------------------
// Rename Season modal — opened from the small pencil next to the segment
// tabs (real, TVDB-backed seasons only; Specials and the generic synthetic
// fallback don't get one, see the render logic below for why).
// PUT /api/series/:id/seasons/:seasonNumber overwrites season_name on every
// cached episode row for that season (see server/routes/episodes.js) —
// segmentLabel() below already prefers that field over the plain "Season N"
// fallback, so a rename here is really just filling in (or clearing) the
// same field a real named arc from TVDB would have populated.
// ---------------------------------------------------------------------------
function RenameSeasonModal({ seriesId, seasonNumber, currentLabel, onClose, onRenamed }) {
  const [name, setName] = useState(currentLabel);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    setError('');
    try {
      const res = await fetch(`/api/series/${seriesId}/seasons/${seasonNumber}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: name.trim() }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || `HTTP ${res.status}`);
      }
      onRenamed();
    } catch {
      setError("Couldn't rename this season — try again.");
      setSaving(false);
    }
  }

  return (
    <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box">
        <div className="modal-header">
          <h2>Rename Season</h2>
          <button className="modal-close" type="button" aria-label="Close" data-tooltip="Close" onClick={onClose}>{icons.x}</button>
        </div>
        <div className="modal-body">
          <div className="form-row" style={{ borderTop: 'none', paddingTop: 0 }}>
            <div className="field-label"><p className="name">Label</p><p className="desc">Shown on the segment tab. Leave blank to reset to the default.</p></div>
          </div>
          <input type="text" className="field-input" style={{ width: '100%' }} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
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
          <button className="modal-close" type="button" aria-label="Close" data-tooltip="Close" onClick={onClose}>{icons.x}</button>
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
// Rename Files modal — opened from the "Rename files" action in the top
// action bar. Fetches a real preview from GET
// /api/series/:id/rename-preview (every currently-downloaded episode's real
// filename vs. what it'd become under Settings > Media Management's naming
// format — see server/lib/episode-paths.js/naming-format.js), lets you pick
// which changed files to actually rename, then POSTs the selected ids to
// /api/series/:id/rename — the preview endpoint and the actual rename share
// the exact same name-computing code server-side, so nothing on disk moves
// until this modal's own Rename button is clicked, and what it moves to is
// always exactly what was just shown. Same preview-then-commit shape real
// Sonarr/Radarr's own Rename dialog uses.
// ---------------------------------------------------------------------------
function RenameFilesModal({ series, onClose, onRenamed }) {
  const [items, setItems] = useState(null); // null = loading; only "changed" entries from the API
  const [loadFailed, setLoadFailed] = useState(false);
  const [selected, setSelected] = useState(() => new Set());
  const [renaming, setRenaming] = useState(false);
  const [error, setError] = useState('');
  const [renameToggleOff, setRenameToggleOff] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`/api/series/${series.id}/rename-preview`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = await res.json();
        // Files that already match the current naming format aren't shown
        // at all — nothing to decide about them, and a long list of
        // already-correct names would just bury the ones that actually
        // changed.
        const changed = (body.items || []).filter((i) => i.changed);
        setItems(changed);
        setSelected(new Set(changed.map((i) => i.episodeId)));
        setRenameToggleOff(!body.renameEpisodesToggle);
      } catch {
        setLoadFailed(true);
      }
    })();
  }, [series.id]);

  function toggleOne(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }
  function toggleAll() {
    if (!items) return;
    setSelected((prev) => (prev.size === items.length ? new Set() : new Set(items.map((i) => i.episodeId))));
  }

  async function handleRename() {
    if (selected.size === 0) return;
    setRenaming(true);
    setError('');
    try {
      const res = await fetch(`/api/series/${series.id}/rename`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ episodeIds: Array.from(selected) }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      const failed = (body.results || []).filter((r) => !r.ok);
      if (failed.length > 0) {
        setError(`${failed.length} file(s) couldn't be renamed: ${failed[0].error}${failed.length > 1 ? ` (+${failed.length - 1} more)` : ''}`);
        setRenaming(false);
        return;
      }
      onRenamed();
    } catch {
      setError("Couldn't rename files — try again.");
      setRenaming(false);
    }
  }

  const allSelected = !!items && items.length > 0 && selected.size === items.length;

  return (
    <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box wide">
        <div className="modal-header">
          <h2>Rename Files — {series.title}</h2>
          <button className="modal-close" type="button" aria-label="Close" data-tooltip="Close" onClick={onClose}>{icons.x}</button>
        </div>
        <div className="modal-body">
          {renameToggleOff && (
            <p className="settings-meta" style={{ marginBottom: 12 }}>
              "Rename Episodes" is off in Settings &gt; Media Management, so new downloads will keep their
              original filenames — this manual rename still works regardless of that setting.
            </p>
          )}
          {loadFailed ? (
            <p className="settings-empty">Couldn't load a rename preview.</p>
          ) : items === null ? (
            <p className="settings-empty">Loading…</p>
          ) : items.length === 0 ? (
            <p className="settings-empty">Every downloaded file already matches the current naming format.</p>
          ) : (
            <>
              <label className="rename-select-all">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} />
                {selected.size} of {items.length} selected
              </label>
              <div className="file-browser-list-wrap">
                <div className="rename-preview-list">
                  {items.map((it) => (
                    <label className="rename-file-row" key={it.episodeId}>
                      <input type="checkbox" checked={selected.has(it.episodeId)} onChange={() => toggleOne(it.episodeId)} />
                      <div className="rename-file-names">
                        <p className="rename-old-name">{it.oldName}</p>
                        <p className="rename-new-name">{it.newName}</p>
                      </div>
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}
          <p className={`form-error${error ? '' : ' is-collapsed'}`}>{error}</p>
        </div>
        <div className="modal-footer">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="btn-accent" type="button" disabled={renaming || !items || selected.size === 0} onClick={handleRename}>
            {renaming ? 'Renaming…' : `Rename ${selected.size || ''} file${selected.size === 1 ? '' : 's'}`}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Media Info modal — opened from EpisodeActionsMenu. Same "build a small
// modal component right here" shape Delete/Edit Series already use (this
// page is fully React, so there's no reason to reach for the vanilla
// build-once-append-to-body pattern release-picker/episode-details/
// file-browser use — those are shared across pages that aren't).
// ---------------------------------------------------------------------------
function DetailRow({ label, value }) {
  return (
    <div className="episode-detail-row">
      <p className="episode-detail-label">{label}</p>
      <p className="episode-detail-value">{value}</p>
    </div>
  );
}

function MediaInfoModal({ ep, resolutionGroupByQuality, onClose }) {
  const info = buildMediaInfo(ep, resolutionGroupByQuality);
  const code = `S${String(ep.seasonNumber ?? 0).padStart(2, '0')}E${String(ep.num).padStart(2, '0')}`;
  const videoValue = info.resolution && info.videoCodec
    ? `${info.resolution} · ${info.videoCodec}${info.resolutionConfirmed ? ' (confirmed)' : ''}`
    : 'Unknown';

  return (
    <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box">
        <div className="modal-header">
          <h2>Media Info — {code}</h2>
          <button className="modal-close" type="button" aria-label="Close" data-tooltip="Close" onClick={onClose}>{icons.x}</button>
        </div>
        <div className="modal-body">
          <div className="episode-details-list">
            <DetailRow label="Container" value={info.container} />
            <DetailRow label="Video" value={videoValue} />
            <DetailRow label="Video bitrate" value={info.videoBitrate || 'Unknown'} />
            <DetailRow label="Audio" value={info.audioTracks.length ? info.audioTracks.join(', ') : 'Unknown'} />
            <DetailRow label="Subtitles" value={info.subtitles || 'None detected'} />
            <DetailRow label="File size" value={ep.sizeBytes ? formatBytes(ep.sizeBytes) : '—'} />
          </div>
        </div>
        <div className="modal-footer">
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete episode file modal — opened from EpisodeActionsMenu's Delete item.
// Removes the real media file on disk (DELETE /api/episodes/:id/file, see
// server/routes/episodes.js) and resets that episode's downloaded/quality/
// size/path state, same "confirm, then a small modal owns the fetch and its
// own error state" shape DeleteSeriesModal above already uses.
// ---------------------------------------------------------------------------
function DeleteEpisodeFileModal({ ep, onClose, onDeleted }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');
  const code = `S${String(ep.seasonNumber ?? 0).padStart(2, '0')}E${String(ep.num).padStart(2, '0')}`;

  async function handleConfirm() {
    setDeleting(true);
    setError('');
    try {
      const res = await fetch(`/api/episodes/${ep.id}/file`, { method: 'DELETE' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      onDeleted(body);
    } catch (err) {
      setDeleting(false);
      setError(err.message || "Couldn't delete this file — try again.");
    }
  }

  return (
    <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box">
        <div className="modal-header">
          <h2>Delete File — {code}</h2>
          <button className="modal-close" type="button" aria-label="Close" data-tooltip="Close" onClick={onClose}>{icons.x}</button>
        </div>
        <div className="modal-body">
          <p>{error || `Are you sure you want to delete the media file for "${ep.title}"? This removes it from disk and can't be undone.`}</p>
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
// Edit Tracks modal — opened from EpisodeActionsMenu's Edit Tracks item
// (gated by canEditTracks above). Lets the user choose which real audio
// track and which real subtitle track (or none at all) an .mkv file's
// player should default to, and writes that choice into the file's own
// header via mkvpropedit (PATCH /api/episodes/:id/tracks — see
// server/lib/mkvpropedit.js and server/routes/episodes.js's
// handleEditEpisodeTracks) rather than recording a preference Kitsune
// itself would have to remember and reapply — any player opening the file
// afterward honors the new default on its own, no Kitsune involved. Radio
// selection is pre-seeded from whichever track ffprobe currently reports as
// `default: true` for each type (server/lib/ffprobe.js); tracks are shown
// in probe order, which is exactly the 1-based track number mkvpropedit's
// own track:a<N>/track:s<N> selectors expect, so the position sent back is
// literally "which radio button" with no extra bookkeeping.
// ---------------------------------------------------------------------------
function EditTracksModal({ ep, onClose, onSaved }) {
  const audioTracks = (ep.mediaStreams && ep.mediaStreams.audio) || [];
  const subtitleTracks = (ep.mediaStreams && ep.mediaStreams.subtitles) || [];
  const initialAudioDefault = audioTracks.findIndex((t) => t.default);
  const initialSubtitleDefault = subtitleTracks.findIndex((t) => t.default);
  // No audio track flagged default on a real file still needs *some* choice
  // pre-selected (falls back to the first track) — a subtitle default of
  // "none selected" is a perfectly normal, common real state, so that one
  // has no such fallback.
  const [audioIndex, setAudioIndex] = useState(
    initialAudioDefault >= 0 ? initialAudioDefault + 1 : (audioTracks.length ? 1 : null)
  );
  const [subtitleIndex, setSubtitleIndex] = useState(initialSubtitleDefault >= 0 ? initialSubtitleDefault + 1 : null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const code = `S${String(ep.seasonNumber ?? 0).padStart(2, '0')}E${String(ep.num).padStart(2, '0')}`;

  async function handleSave() {
    setSaving(true);
    setError('');
    const body = {};
    if (audioTracks.length) body.audioTrackIndex = audioIndex;
    if (subtitleTracks.length) body.subtitleTrackIndex = subtitleIndex;
    try {
      const res = await fetch(`/api/episodes/${ep.id}/tracks`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const responseBody = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(responseBody.error || `HTTP ${res.status}`);
      onSaved(responseBody);
    } catch (err) {
      setSaving(false);
      setError(err.message || "Couldn't update default tracks — try again.");
    }
  }

  return (
    <div className="modal-overlay open" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal-box">
        <div className="modal-header">
          <h2>Edit Tracks — {code}</h2>
          <button className="modal-close" type="button" aria-label="Close" data-tooltip="Close" onClick={onClose}>{icons.x}</button>
        </div>
        <div className="modal-body">
          {audioTracks.length > 0 && (
            <div className="edit-tracks-group">
              <p className="episode-detail-label">Default Audio Track</p>
              {audioTracks.map((t, i) => (
                <label className="edit-tracks-option" key={`audio-${i}`}>
                  <input type="radio" name="edit-tracks-audio" checked={audioIndex === i + 1} onChange={() => setAudioIndex(i + 1)} />
                  {t.language} · {t.codec} · {t.channels}
                </label>
              ))}
            </div>
          )}
          {subtitleTracks.length > 0 && (
            <div className="edit-tracks-group">
              <p className="episode-detail-label">Default Subtitle Track</p>
              <label className="edit-tracks-option">
                <input type="radio" name="edit-tracks-subtitle" checked={subtitleIndex === null} onChange={() => setSubtitleIndex(null)} />
                None
              </label>
              {subtitleTracks.map((t, i) => (
                <label className="edit-tracks-option" key={`subtitle-${i}`}>
                  <input type="radio" name="edit-tracks-subtitle" checked={subtitleIndex === i + 1} onChange={() => setSubtitleIndex(i + 1)} />
                  {t.language} · {t.codec}{t.forced ? ' · Forced' : ''}
                </label>
              ))}
            </div>
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

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function SeriesPage() {
  const [seriesData, setSeriesData] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [series, setSeries] = useState(null);

  const [realGroups, setRealGroups] = useState(null); // null until real episodes actually load
  const [activeSeasonNumber, setActiveSeasonNumber] = useState(null);

  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [renameFilesOpen, setRenameFilesOpen] = useState(false);
  const [renamingSeason, setRenamingSeason] = useState(false);
  const [mediaInfoEp, setMediaInfoEp] = useState(null);
  const [deletingFileEp, setDeletingFileEp] = useState(null);
  const [editTracksEp, setEditTracksEp] = useState(null);
  const [qualityGroupByName, setQualityGroupByName] = useState(() => new Map());
  const [refreshingEpisodes, setRefreshingEpisodes] = useState(false);
  const [refreshError, setRefreshError] = useState('');
  const [rescanningFiles, setRescanningFiles] = useState(false);
  const [rescanMessage, setRescanMessage] = useState(null); // { text, isError }
  const [grabbingBestId, setGrabbingBestId] = useState(null); // episode id currently mid-"Grab best match", or null
  const [grabbingBestScope, setGrabbingBestScope] = useState(null); // 'season' | 'series', while a batch auto-grab is in flight
  const [grabBestMessage, setGrabBestMessage] = useState(null); // { text, isError }

  const releasePickerRef = useRef(null);
  const episodeDetailsModalRef = useRef(null);
  const pollTimerRef = useRef(null);

  useEffect(() => {
    releasePickerRef.current = initReleasePickerModal();
    episodeDetailsModalRef.current = initEpisodeDetailsModal();
    return () => clearTimeout(pollTimerRef.current);
  }, []);

  // Real Settings > Quality tier → resolutionGroup map, fetched once — used
  // by Media Info to turn a downloaded episode's real quality tier name
  // (e.g. "WEBDL-1080p") into a resolution/codec guess. Fetched here rather
  // than per-modal-open since it's the same small, rarely-changing list
  // every episode's Media Info needs, not something worth re-fetching per
  // click (same reasoning EditSeriesModal's own profiles fetch already
  // follows for a different rarely-changing list).
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/settings-items/quality-tiers');
        const tiers = await res.json();
        setQualityGroupByName(new Map(tiers.map((t) => [t.name, t.resolutionGroup])));
      } catch { /* Media Info falls back to "Unknown" video fields */ }
    })();
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
      if (!series) return;
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
  // Search Season / Search All — batch search for a whole season or series
  // at once, since a finished show is commonly distributed as one torrent
  // rather than an episode at a time (see release-picker-modal.js's target
  // shapes). Gated by the caller on realGroups being loaded — the generic
  // synthetic fallback has no real backing series/episode ids to search
  // against.
  async function handleSearchSeason(seasonNumber) {
    if (!releasePickerRef.current || !series) return;
    releasePickerRef.current.open(
      { type: 'season', seriesId: series.id, seasonNumber, seriesTitle: series.title },
      () => loadRealEpisodesRef.current(),
    );
  }
  async function handleSearchAll() {
    if (!releasePickerRef.current || !series) return;
    releasePickerRef.current.open(
      { type: 'series', seriesId: series.id, seriesTitle: series.title },
      () => loadRealEpisodesRef.current(),
    );
  }

  // "Grab best match" — searches and grabs the top-ranked release itself
  // (server/routes/queue.js's handleAutoEpisodeGrab/handleAutoBatchGrab, POST
  // /api/queue with `auto: true` instead of a releaseIndex), skipping the
  // picker entirely. The server does the exact same profile-aware ranking
  // the picker's own list uses (see server/lib/quality.js's
  // rankReleaseCandidates) and just grabs whichever release came out on top
  // — this button is "trust the ranking," the picker is "let me choose."
  // `skipped: true` isn't an error (a 200, not 4xx/5xx) — it means either the
  // episode already meets its profile's cutoff or nothing was found, both
  // genuinely "nothing to do" rather than something going wrong.
  async function handleGrabBest(episodeId) {
    if (grabbingBestId != null) return;
    setGrabbingBestId(episodeId);
    setGrabBestMessage(null);
    try {
      const res = await fetch('/api/queue', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ episodeId, auto: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (body.skipped) {
        setGrabBestMessage({ text: body.reason, isError: false });
      } else {
        setGrabBestMessage({ text: `Grabbed "${body.releaseTitle}" (${body.quality}).`, isError: false });
        loadRealEpisodesRef.current();
      }
    } catch (err) {
      setGrabBestMessage({ text: err.message || 'Could not grab a release.', isError: true });
    } finally {
      setGrabbingBestId(null);
    }
  }

  async function handleGrabBestScope(scope, seasonNumber) {
    if (grabbingBestScope != null || !series) return;
    setGrabbingBestScope(scope);
    setGrabBestMessage(null);
    try {
      const res = await fetch('/api/queue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seriesId: series.id, seasonNumber: scope === 'season' ? seasonNumber : undefined, auto: true }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (body.skipped) {
        setGrabBestMessage({ text: body.reason, isError: false });
      } else {
        setGrabBestMessage({ text: `Grabbed "${body.releaseTitle}" (${body.quality}) — ${body.count} episode${body.count === 1 ? '' : 's'}.`, isError: false });
        loadRealEpisodesRef.current();
      }
    } catch (err) {
      setGrabBestMessage({ text: err.message || 'Could not grab a release.', isError: true });
    } finally {
      setGrabbingBestScope(null);
    }
  }
  // Re-fetches this series' episode metadata from TheTVDB in place (see
  // server/routes/episodes.js's refreshEpisodesForSeries) — the fix for a
  // series whose episodes cached successfully but with incomplete data
  // (e.g. every title stuck on the generic "Episode N" fallback because a
  // batch of translation requests failed — see tvdb.js's now-logged
  // fetchTvdbEpisodeTranslation), without deleting and re-adding the whole
  // series (which would also throw away real per-episode download state).
  async function handleRefreshEpisodes() {
    if (!series || refreshingEpisodes) return;
    setRefreshingEpisodes(true);
    setRefreshError('');
    try {
      const res = await fetch(`/api/series/${series.id}/refresh-episodes`, { method: 'POST' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      loadRealEpisodesRef.current();
    } catch (err) {
      setRefreshError(err.message || 'Could not refresh episodes.');
    } finally {
      setRefreshingEpisodes(false);
    }
  }
  // Real files sitting in this series' folder on disk that Kitsune doesn't
  // know about yet — someone copying a folder straight onto the root folder
  // outside the normal grab/import pipeline, most obviously. The same
  // real-file matching Library Import's own "Import files" button runs
  // (POST /api/series/:id/import-files), just triggered from the series'
  // own page against its own series.path instead of requiring a trip to
  // Library Import to find the matching row — see that route's own comment
  // for why an empty body is enough for it to know which folder to scan.
  // series.path isn't guaranteed to already be set, though (a series whose
  // folder didn't exist yet the one time it would normally get resolved —
  // see episodes.js's resolveAndCacheEpisodesForSeries — stayed permanently
  // unresolved until now): the route falls back to looking for a matching
  // folder itself and reports back whatever it ends up using as
  // `seriesPath`, so the very click that fixes a series stuck showing "No
  // path set" also updates this page's local state to match, without a
  // reload. Reconciling, not just additive: an episode this scan doesn't
  // confirm with a real file gets reset back to not-downloaded, same as
  // Library Import's version.
  async function handleRescanFiles() {
    if (!series || rescanningFiles) return;
    setRescanningFiles(true);
    setRescanMessage(null);
    try {
      const res = await fetch(`/api/series/${series.id}/import-files`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
      if (body.seriesPath) setSeries((prev) => (prev ? { ...prev, path: body.seriesPath } : prev));
      if (body.message) {
        setRescanMessage({ text: body.message, isError: false });
      } else {
        const matchedCount = body.matched.length;
        const unmatchedCount = body.unmatched.length;
        const resetCount = body.reset ? body.reset.length : 0;
        let text = `Linked ${matchedCount} file${matchedCount === 1 ? '' : 's'} to episode${matchedCount === 1 ? '' : 's'}.`;
        if (unmatchedCount > 0) text += ` ${unmatchedCount} couldn't be matched.`;
        if (resetCount > 0) text += ` ${resetCount} previously-downloaded episode${resetCount === 1 ? '' : 's'} had no matching file and ${resetCount === 1 ? 'was' : 'were'} marked not downloaded.`;
        setRescanMessage({ text, isError: unmatchedCount > 0 });
        if (matchedCount > 0 || resetCount > 0) {
          setSeries((prev) => ({ ...prev, eps: body.seriesEps, pct: body.seriesPct }));
          loadRealEpisodesRef.current();
        }
      }
    } catch (err) {
      setRescanMessage({ text: err.message || 'Could not rescan for local files.', isError: true });
    } finally {
      setRescanningFiles(false);
    }
  }
  async function handleCancel(queueId) {
    await fetch(`/api/queue/${queueId}`, { method: 'DELETE' });
    loadRealEpisodesRef.current();
  }
  function handleDetails(episodeId) {
    const row = (realGroups || []).flatMap((g) => g.rows).find((r) => r.id === episodeId);
    if (row && episodeDetailsModalRef.current) episodeDetailsModalRef.current.open(row);
  }
  function handleMediaInfo(ep) {
    setMediaInfoEp(ep);
  }
  function handleDeleteFile(ep) {
    setDeletingFileEp(ep);
  }
  function handleFileDeleted(body) {
    setDeletingFileEp(null);
    if (body && body.seriesEps != null) setSeries((prev) => ({ ...prev, eps: body.seriesEps, pct: body.seriesPct }));
    loadRealEpisodesRef.current();
  }
  function handleEditTracks(ep) {
    setEditTracksEp(ep);
  }
  function handleTracksSaved() {
    setEditTracksEp(null);
    loadRealEpisodesRef.current();
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
  const totalCount = epMatch ? parseInt(epMatch[2], 10) : 0;
  // Ended (finished airing) — Monitored no longer means anything for a
  // series with nothing left to air, regardless of whether every episode
  // that already aired has actually been downloaded yet (that's still a
  // real gap Search/Wanted can fill in, just not one "watch for new
  // episodes" applies to anymore). Doesn't force Monitored off (whatever the
  // last real value was stays saved/shown), just stops presenting the
  // toggle as something that still needs attention. This used to also
  // require every episode to already be downloaded before disabling — which
  // left the toggle wrongly selectable on a finished series that simply
  // hadn't finished downloading yet (e.g. Tsugumomo at 6/13).
  const isComplete = series.status === 'ended';
  // Real per-episode sizeBytes (from server/routes/episodes.js's cache —
  // populated by a real Library Import scan, a real grab's completion, or
  // the automatic on-disk scan that runs when a series is added) once real
  // episode data has loaded for this series — summed across every season,
  // not just whichever tab is active. The generic synthetic fallback (shown
  // before real episode data has loaded) has no real bytes to sum, so it
  // falls back to the same flat "downloaded count × 0.47 GB" estimate this
  // stat always used before.
  const realEpisodesFlat = realGroups ? realGroups.flatMap((g) => g.rows) : null;
  const sizeText = realEpisodesFlat
    ? formatBytes(realEpisodesFlat.reduce((sum, r) => sum + (r.sizeBytes || 0), 0))
    : (downloadedCount > 0 ? `${(downloadedCount * 0.47).toFixed(1)} GB` : '0 GB');
  let nextAiringText = '—';
  if (series.nextAirDays != null) nextAiringText = `in ${series.nextAirDays}d`;
  else if (series.airStatus) nextAiringText = shortenAirStatus(series.airStatus);
  else if (series.status === 'ended') nextAiringText = 'Ended';

  let episodeList;
  let segmentButtons = null;
  let activeGroup = null; // only meaningful in the realGroups branch — used below to gate/label the Rename season button
  if (realGroups) {
    if (realGroups.length > 1) {
      segmentButtons = realGroups.map((g) => (
        <button key={g.seasonNumber} className={activeSeasonNumber === g.seasonNumber ? 'active' : ''} onClick={() => setActiveSeasonNumber(g.seasonNumber)}>
          {segmentLabel(g)}
        </button>
      ));
    }
    activeGroup = realGroups.find((g) => g.seasonNumber === activeSeasonNumber) || realGroups[0];
    episodeList = (activeGroup ? activeGroup.rows : []).map((ep) => <EpisodeRow key={ep.id} ep={ep} onSearch={handleSearch} onGrabBest={handleGrabBest} grabbingBestId={grabbingBestId} onCancel={handleCancel} onDetails={handleDetails} onMediaInfo={handleMediaInfo} onDeleteFile={handleDeleteFile} onEditTracks={handleEditTracks} />);
  } else {
    episodeList = buildGenericEpisodes(series).map((ep, i) => <EpisodeRow key={i} ep={ep} onSearch={handleSearch} onGrabBest={handleGrabBest} grabbingBestId={grabbingBestId} onCancel={handleCancel} onDetails={handleDetails} onMediaInfo={handleMediaInfo} onDeleteFile={handleDeleteFile} onEditTracks={handleEditTracks} />);
  }
  // Only a real, TVDB-backed, non-Specials season can be renamed — the
  // generic synthetic fallback has no real episode rows behind it for PUT
  // /api/series/:id/seasons/:n to update (see server/routes/episodes.js),
  // and Specials (season 0) always reads "Specials" regardless of
  // season_name (segmentLabel hardcodes it).
  const canRenameActiveSeason = !!activeGroup && activeGroup.seasonNumber !== 0;

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
              <label className="monitor-toggle" title={isComplete ? "This series is complete — there's nothing left to monitor." : undefined}>
                <input type="checkbox" checked={!!series.monitored} disabled={isComplete} onChange={handleMonitorToggle} /> Monitored
              </label>
              <button
                type="button"
                disabled={!realGroups}
                title={!realGroups ? 'Search all is unavailable until real episode data has loaded.' : 'Search for the whole series as one batch release'}
                onClick={handleSearchAll}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><path d="M21 21l-4.3-4.3" /></svg>
                Search all
              </button>
              <button
                type="button"
                disabled={!realGroups || grabbingBestScope != null}
                title={!realGroups ? 'Grab best match is unavailable until real episode data has loaded.' : "Search and grab the whole series' best-match batch release for this series' Quality Profile — no picker"}
                onClick={() => handleGrabBestScope('series')}
              >
                {icons.zap}
                {grabbingBestScope === 'series' ? 'Grabbing…' : 'Grab best match'}
              </button>
              <button
                type="button"
                disabled={refreshingEpisodes}
                title="Re-fetch episode titles, air dates, and synopses from TheTVDB."
                onClick={handleRefreshEpisodes}
              >
                {icons.refresh}
                {refreshingEpisodes ? 'Refreshing…' : 'Refresh episodes'}
              </button>
              <button
                type="button"
                disabled={rescanningFiles}
                title="Check this series' folder on disk for files Kitsune doesn't know about yet."
                onClick={handleRescanFiles}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7h4l2-2h6l2 2h4v12H3z" /></svg>
                {rescanningFiles ? 'Scanning…' : 'Rescan for local files'}
              </button>
              <button
                type="button"
                title="Preview and rename this series' downloaded files to match the naming format in Settings > Media Management"
                onClick={() => setRenameFilesOpen(true)}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M4 7h16M4 12h10M4 17h7" /><path d="M17 15l3 3-3 3" /></svg>
                Rename files
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
          {refreshError && <p className="form-error">{refreshError}</p>}
          {rescanMessage && <p className={rescanMessage.isError ? 'form-error' : 'import-result ok'}>{rescanMessage.text}</p>}
          {grabBestMessage && <p className={grabBestMessage.isError ? 'form-error' : 'import-result ok'}>{grabBestMessage.text}</p>}
          <p className="overview" id="detailOverview">{series.overview || 'No overview available yet.'}</p>
          <div className="detail-stats">
            <div className="stat-card"><p className="label">Episodes</p><p className="value">{series.eps}</p></div>
            <div className="stat-card"><p className="label">Quality</p><p className="value">{series.qualityProfile || '—'}</p></div>
            <div className="stat-card"><p className="label">Size</p><p className="value">{sizeText}</p></div>
            <div className="stat-card"><p className="label">Next airing</p><p className="value">{nextAiringText}</p></div>
          </div>
        </div>
      </div>

      <div className="segment-tabs-row" style={{ display: segmentButtons ? 'flex' : 'none' }}>
        <div className="segment-tabs" id="segmentTabs">
          {segmentButtons}
        </div>
        {!!activeGroup && (
          <button
            type="button"
            className="ep-action"
            aria-label="Search season"
            data-tooltip="Search season"
            onClick={() => handleSearchSeason(activeGroup.seasonNumber)}
          >
            {icons.search}
          </button>
        )}
        {!!activeGroup && (
          <button
            type="button"
            className="ep-action"
            aria-label="Grab best match for season"
            data-tooltip="Grab best match"
            disabled={grabbingBestScope != null}
            onClick={() => handleGrabBestScope('season', activeGroup.seasonNumber)}
          >
            {icons.zap}
          </button>
        )}
        {canRenameActiveSeason && (
          <button type="button" className="ep-action" aria-label="Rename season" data-tooltip="Rename season" onClick={() => setRenamingSeason(true)}>
            {icons.edit}
          </button>
        )}
      </div>

      <div className="episode-list-scroll">
        <div className="ep-header">
          <span>Ep</span><span>Title</span><span>Air date</span><span>Audio</span><span>Quality</span><span>Status</span><span></span>
        </div>

        <div id="episodeList">{episodeList}</div>
      </div>

      {deleteOpen && <DeleteSeriesModal series={series} onClose={() => setDeleteOpen(false)} />}
      {renameFilesOpen && (
        <RenameFilesModal
          series={series}
          onClose={() => setRenameFilesOpen(false)}
          onRenamed={() => { setRenameFilesOpen(false); loadRealEpisodesRef.current(); }}
        />
      )}
      {renamingSeason && canRenameActiveSeason && (
        <RenameSeasonModal
          seriesId={series.id}
          seasonNumber={activeGroup.seasonNumber}
          currentLabel={segmentLabel(activeGroup)}
          onClose={() => setRenamingSeason(false)}
          onRenamed={() => { setRenamingSeason(false); loadRealEpisodesRef.current(); }}
        />
      )}
      {mediaInfoEp && (
        <MediaInfoModal ep={mediaInfoEp} resolutionGroupByQuality={qualityGroupByName} onClose={() => setMediaInfoEp(null)} />
      )}
      {deletingFileEp && (
        <DeleteEpisodeFileModal ep={deletingFileEp} onClose={() => setDeletingFileEp(null)} onDeleted={handleFileDeleted} />
      )}
      {editTracksEp && (
        <EditTracksModal ep={editTracksEp} onClose={() => setEditTracksEp(null)} onSaved={handleTracksSaved} />
      )}
      {editOpen && (
        <EditSeriesModal
          series={series}
          isComplete={isComplete}
          onClose={() => setEditOpen(false)}
          onSaved={handleEditSaved}
          onDeleteInstead={() => { setEditOpen(false); setDeleteOpen(true); }}
        />
      )}
    </>
  );
}
