// ---------------------------------------------------------------------------
// /api/manual-grab — add a release by hand: a magnet link, a .torrent file,
// or a link to one (a Nyaa view page works too). For when search can't find
// the release someone wants, or ranks it below something worse: they paste
// it, Kitsune shows which episode each file is, and from there it's handled
// exactly like a grab from search — sent to qBittorrent, tracked in the
// queue, imported, renamed, recorded in history.
//
// Two steps:
//   POST /api/manual-grab/preview  { seriesId, seasonNumber?, magnet | url | torrentBase64 }
//     Reads the release and matches its files to this series' episodes
//     (same rules as Manual Import — routes/manual-import.js's
//     assignEpisodes, absolute numbering included). Returns the match plus
//     a short-lived token; nothing is sent anywhere yet.
//   POST /api/manual-grab          { token, episodeIds }
//     Sends it to qBittorrent and creates one queue row per chosen episode,
//     through the same insertBatchGrab path a batch grab from search uses.
//     Each row remembers its confirmed file (queue.file_hint), so import
//     uses what the person saw in the preview rather than re-guessing.
//
// A magnet has no file list until qBittorrent fetches its metadata, so its
// preview can't match files: it preselects the scope's missing, aired
// episodes (the same assumption a batch grab from search makes) and says so.
// History rows record the indexer as "Manual", so manual adds are easy to
// tell apart from search grabs later.
// ---------------------------------------------------------------------------
const crypto = require('crypto');
const db = require('../db');
const { logInfo } = require('../logger');
const { sendJson, readJsonBody } = require('../lib/http');
const { getSessionUser } = require('./auth');
const { listTorrentFiles, computeInfoHash } = require('../lib/bencode');
const { isVideoFile, guessSeasonEpisode, seasonNumberFromFolderName } = require('../lib/media-files');
const { classifyQualityFromTitle } = require('../lib/nyaa-search');
const { assignEpisodes } = require('./manual-import');
const { insertBatchGrab, fetchTorrentFile, extractInfoHashFromMagnet } = require('./queue');

const TOKEN_TTL_MS = 15 * 60 * 1000;
const MAX_TORRENT_BYTES = 8 * 1024 * 1024;
// base64 grows a file by a third; leave room for the rest of the JSON.
const MAX_BODY_BYTES = Math.ceil(MAX_TORRENT_BYTES * 1.4) + 64 * 1024;
// Same idea as lib/torrent-files.js's EXTRA_VIDEO: videos that aren't
// episodes. Listed in the preview, never matched to an episode.
const EXTRA_VIDEO = /\b(NCOP|NCED|NC\s?OP|NC\s?ED|creditless|trailer|teaser|preview|PV|CM|menu|extras?|bonus)\b/i;
const MANUAL_INDEXER = 'Manual';

const previews = new Map(); // token -> { seriesId, seasonNumber, release, fileHints, expiresAt }

function prunePreviews() {
  const now = Date.now();
  for (const [token, p] of previews) if (p.expiresAt < now) previews.delete(token);
}

async function requireSignedIn(req, res) {
  const user = await getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { error: 'Not signed in.' });
    return null;
  }
  return user;
}

// ---------------------------------------------------------------------------
// Reading the release
// ---------------------------------------------------------------------------

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

// Magnets carry the info hash as 40 hex chars or, in older clients, 32
// base32 chars. The queue tracks torrents by hex hash (what qBittorrent
// reports), so base32 is converted.
function normalizeInfoHash(hash) {
  if (!hash) return null;
  if (/^[0-9a-f]{40}$/i.test(hash)) return hash.toLowerCase();
  if (/^[A-Z2-7]{32}$/i.test(hash)) {
    let bits = '';
    for (const ch of hash.toUpperCase()) bits += BASE32.indexOf(ch).toString(2).padStart(5, '0');
    let hex = '';
    for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex;
  }
  return null;
}

function parseMagnet(magnet) {
  const text = String(magnet || '').trim();
  if (!text.startsWith('magnet:?')) return { error: "That isn't a magnet link — it should start with magnet:?" };
  const params = new URLSearchParams(text.slice('magnet:?'.length));
  const infoHash = normalizeInfoHash(extractInfoHashFromMagnet(text));
  if (!infoHash) return { error: 'That magnet link has no info hash (xt=urn:btih:…).' };
  const xl = Number(params.get('xl'));
  return {
    title: (params.get('dn') || '').trim() || infoHash,
    infoHash,
    magnetUrl: text,
    sizeBytes: Number.isFinite(xl) && xl > 0 ? xl : null,
  };
}

// A Nyaa view page (nyaa.si/view/123, or a mirror on the same layout) is
// what people copy most; its .torrent lives at /download/123.torrent on the
// same host. Anything else is fetched as-is.
function torrentUrlFor(link) {
  let url;
  try {
    url = new URL(String(link || '').trim());
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(url.protocol)) return null;
  const view = /^\/view\/(\d+)\/?$/.exec(url.pathname);
  if (view && /nyaa/i.test(url.hostname)) return `${url.origin}/download/${view[1]}.torrent`;
  return url.toString();
}

function fromTorrentBuffer(buffer) {
  if (!buffer || buffer.length === 0) return { error: 'The .torrent file is empty.' };
  if (buffer.length > MAX_TORRENT_BYTES) return { error: 'That .torrent file is too large to read.' };
  let files;
  let infoHash;
  try {
    files = listTorrentFiles(buffer);
    infoHash = computeInfoHash(buffer);
  } catch {
    return { error: "That isn't a valid .torrent file." };
  }
  // listTorrentFiles prefixes every path with the torrent's own name, so a
  // multi-file torrent's name is the first path segment (even when it
  // holds just one file); a single-file torrent's name is the file itself.
  const first = files[0] ? files[0].path : '';
  const title = first.includes('/') ? first.split('/')[0] : first.replace(/\.[^./]+$/, '');
  return {
    title: title || infoHash,
    infoHash,
    torrentBuffer: buffer,
    files,
    sizeBytes: files.reduce((sum, f) => sum + (f.length || 0), 0),
  };
}

async function readSource(body) {
  if (body.magnet) return parseMagnet(body.magnet);
  if (body.torrentBase64) {
    let buffer;
    try {
      buffer = Buffer.from(String(body.torrentBase64), 'base64');
    } catch {
      return { error: "Couldn't read that file." };
    }
    return fromTorrentBuffer(buffer);
  }
  if (body.url) {
    const text = String(body.url).trim();
    if (text.startsWith('magnet:')) return parseMagnet(text);
    const torrentUrl = torrentUrlFor(text);
    if (!torrentUrl) return { error: 'Paste a magnet link, a .torrent link, or a Nyaa view page link.' };
    const fetched = await fetchTorrentFile(torrentUrl);
    if (!fetched.ok) return { error: fetched.error };
    if (fetched.magnetUrl) return parseMagnet(fetched.magnetUrl);
    const parsed = fromTorrentBuffer(fetched.buffer);
    if (parsed.error) return { error: "That link didn't return a .torrent file — paste the magnet link or the torrent's download link instead." };
    return parsed;
  }
  return { error: 'Paste a magnet link or a link, or choose a .torrent file.' };
}

// ---------------------------------------------------------------------------
// Matching files to episodes
// ---------------------------------------------------------------------------

function seasonHintFromPath(relPath) {
  const dirs = relPath.split('/').slice(0, -1).reverse();
  for (const d of dirs) {
    const n = seasonNumberFromFolderName(d);
    if (n != null) return n;
  }
  return null;
}

function episodeLabel(ep) {
  return `S${String(ep.season_number).padStart(2, '0')}E${String(ep.num).padStart(2, '0')}`;
}

async function matchFiles(seriesId, files) {
  const out = [];
  const entries = [];
  for (const f of files) {
    const name = f.path.split('/').pop();
    const row = { path: f.path, name, sizeBytes: f.length || 0, episodeId: null, reason: null };
    out.push(row);
    if (!isVideoFile(name)) { row.reason = 'Not a video file'; continue; }
    if (EXTRA_VIDEO.test(name)) { row.reason = 'Extra, not an episode'; continue; }
    // assignEpisodes writes its answer onto `out` — the same entry shape
    // Manual Import's scan builds.
    const entry = { out: { path: `torrent:${f.path}`, season: null, episodeIds: [] }, guess: guessSeasonEpisode(name, seasonHintFromPath(f.path)), reason: null, row };
    entries.push(entry);
  }
  if (entries.length > 0) await assignEpisodes(seriesId, entries);
  const claimed = new Map(); // episodeId -> file path
  for (const e of entries) {
    const epId = e.out.episodeIds[0];
    if (!epId) { e.row.reason = e.reason || "Couldn't tell which episode this is"; continue; }
    if (claimed.has(epId)) { e.row.reason = 'Another file is already this episode'; continue; }
    claimed.set(epId, e.row.path);
    e.row.episodeId = epId;
  }
  return { files: out, claimed };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handlePreview(req, res) {
  if (!(await requireSignedIn(req, res))) return;
  let body;
  try {
    body = await readJsonBody(req, { maxBytes: MAX_BODY_BYTES });
  } catch {
    return sendJson(res, 400, { error: 'Invalid request body.' });
  }
  const seriesId = Number(body.seriesId);
  const hasSeason = body.seasonNumber !== undefined && body.seasonNumber !== null && body.seasonNumber !== '';
  const seasonNumber = hasSeason ? Number(body.seasonNumber) : null;
  if (!Number.isInteger(seriesId) || (hasSeason && !Number.isInteger(seasonNumber))) {
    return sendJson(res, 400, { error: 'seriesId is required (and a whole-number seasonNumber, if given).' });
  }
  const series = await db.prepare('SELECT id, title FROM series WHERE id = ?').get(seriesId);
  if (!series) return sendJson(res, 404, { error: 'Series not found.' });

  const source = await readSource(body);
  if (source.error) return sendJson(res, 400, { error: source.error });

  const episodes = await db.prepare('SELECT id, season_number, num, title, aired, downloaded FROM episodes WHERE series_id = ? ORDER BY season_number ASC, num ASC').all(seriesId);
  const queuedRows = await db.prepare('SELECT episode_id, torrent_hash FROM queue WHERE series_id = ?').all(seriesId);
  const queuedIds = new Set(queuedRows.map((q) => q.episode_id));
  const today = db.now().slice(0, 10);

  const hasFileList = Array.isArray(source.files);
  const matched = hasFileList ? await matchFiles(seriesId, source.files) : { files: [], claimed: new Map() };

  const inScope = (ep) => (hasSeason ? ep.season_number === seasonNumber : ep.season_number > 0);
  const episodeList = [];
  for (const ep of episodes) {
    const filePath = matched.claimed.get(ep.id) || null;
    // The scope's own episodes always show; others only when a file in this
    // release is one of them (a season pack that also holds the next season
    // — those come along as a bonus, unchecked only if already handled).
    if (!inScope(ep) && !filePath) continue;
    const aired = !!(ep.aired && ep.aired <= today);
    const state = queuedIds.has(ep.id) ? 'queued' : ep.downloaded ? 'downloaded' : aired ? 'missing' : 'unaired';
    const selected = state === 'missing' && (hasFileList ? !!filePath : inScope(ep));
    episodeList.push({
      id: ep.id, label: episodeLabel(ep), title: ep.title || '', seasonNumber: ep.season_number,
      state, filePath, inScope: inScope(ep), selected,
    });
  }

  const warnings = [];
  if (!hasFileList) warnings.push("A magnet link doesn't include its file list, so files can't be matched yet. The missing episodes in this scope are checked; uncheck any this release doesn't have.");
  if (hasFileList && matched.claimed.size === 0) warnings.push("None of this release's files matched an episode of this series. Check it's the right show, or pick the episodes by hand.");
  if (source.infoHash && queuedRows.some((q) => q.torrent_hash && q.torrent_hash.toLowerCase() === source.infoHash)) {
    warnings.push('This exact torrent is already in the queue.');
  }
  const blocked = await db.prepare('SELECT 1 FROM blocklist WHERE series_id = ? AND release_title = ? LIMIT 1').get(seriesId, source.title);
  if (blocked) warnings.push("This release is on the blocklist for this series — an earlier download of it failed. Adding it by hand won't remove it from the blocklist.");

  const quality = await classifyQualityFromTitle(source.title);
  prunePreviews();
  const token = crypto.randomBytes(16).toString('hex');
  const fileHints = new Map(matched.claimed);
  previews.set(token, {
    seriesId,
    seasonNumber,
    release: {
      title: source.title,
      quality,
      sizeBytes: source.sizeBytes,
      indexer: MANUAL_INDEXER,
      protocol: 'torrent',
      infoHash: source.infoHash,
      magnetUrl: source.magnetUrl || null,
      torrentBuffer: source.torrentBuffer || null,
    },
    fileHints,
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });

  sendJson(res, 200, {
    token,
    title: source.title,
    infoHash: source.infoHash,
    sizeBytes: source.sizeBytes,
    quality,
    hasFileList,
    files: matched.files.map((f) => ({
      ...f,
      episodeLabel: f.episodeId ? episodeLabel(episodes.find((e) => e.id === f.episodeId)) : null,
    })),
    episodes: episodeList,
    warnings,
  });
}

async function handleGrab(req, res) {
  if (!(await requireSignedIn(req, res))) return;
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: 'Invalid request body.' });
  }
  prunePreviews();
  const preview = previews.get(String(body.token || ''));
  if (!preview) return sendJson(res, 400, { error: 'This preview has expired — read the release again.' });
  const ids = Array.isArray(body.episodeIds) ? [...new Set(body.episodeIds.map(Number))] : [];
  if (ids.length === 0 || ids.some((id) => !Number.isInteger(id))) {
    return sendJson(res, 400, { error: 'Choose at least one episode.' });
  }

  const series = await db.prepare('SELECT * FROM series WHERE id = ?').get(preview.seriesId);
  if (!series) return sendJson(res, 404, { error: 'Series not found.' });
  const episodes = [];
  for (const id of ids) {
    const ep = await db.prepare('SELECT * FROM episodes WHERE id = ? AND series_id = ?').get(id, series.id);
    if (!ep) return sendJson(res, 400, { error: 'One of those episodes is not part of this series.' });
    episodes.push(ep);
  }
  const queued = [];
  for (const ep of episodes) {
    if (await db.prepare('SELECT 1 FROM queue WHERE episode_id = ?').get(ep.id)) queued.push(episodeLabel(ep));
  }
  if (queued.length > 0) {
    return sendJson(res, 409, { error: `Already in the queue: ${queued.join(', ')}. Uncheck ${queued.length === 1 ? 'it' : 'them'} or remove the queue item first.` });
  }
  episodes.sort((a, b) => (a.season_number - b.season_number) || (a.num - b.num));

  const hasSeasonNumber = preview.seasonNumber != null;
  const { status, body: result } = await insertBatchGrab(series, preview.release, episodes, {
    seasonNumber: preview.seasonNumber, hasSeasonNumber, fileHints: preview.fileHints,
  });
  if (status < 300) {
    previews.delete(String(body.token));
    logInfo('ManualGrab', `Added "${preview.release.title}" by hand for ${series.title} (${episodes.length} episode${episodes.length === 1 ? '' : 's'})`);
  }
  sendJson(res, status, result);
}

async function handleManualGrabApi(req, res, urlPath) {
  if (req.method === 'POST' && urlPath === '/api/manual-grab/preview') {
    await handlePreview(req, res);
    return true;
  }
  if (req.method === 'POST' && urlPath === '/api/manual-grab') {
    await handleGrab(req, res);
    return true;
  }
  return false;
}

module.exports = { handleManualGrabApi, parseMagnet, torrentUrlFor, normalizeInfoHash };
