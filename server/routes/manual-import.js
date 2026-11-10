// ---------------------------------------------------------------------------
// Manual Import — Wanted > Manual Import (frontend/pages/wanted-manual-import/).
//
// The escape hatch for when automatic import didn't work: a completed
// download whose files couldn't be matched to an episode, a torrent stuck
// retrying in the queue, a release grabbed outside Kitsune entirely, or a
// folder of files copied over from somewhere else. The user points Kitsune
// at a folder (or arrives from a stuck queue row), sees every video file in
// it with Kitsune's best guess at series/season/episode/quality, fixes
// whatever's wrong, and imports.
//
//   GET  /api/manual-import/scan?path=...[&seriesId=N]
//   GET  /api/manual-import/scan?queueId=N
//        → { path, files: [...], queue? }
//   POST /api/manual-import
//        { mode: 'copy'|'move', queueHash?, items: [{ path, seriesId,
//          episodeIds: [..], quality, qualityLocked }] }
//        → { results: [...], imported, failed }
//
// This is deliberately a different thing from Library Import /
// POST /api/series/:id/import-files (routes/import-files.js): that one
// adopts files that already live in a series' own folder, in place, and
// treats the folder as the complete truth for the series. This one moves
// files from anywhere INTO the Library through the exact same path a
// finished download takes — lib/media-import.js's importEpisodeFile, so the
// naming format, season folders, root-folder mount check, permissions and
// truncated-copy check all apply — and only ever touches the episodes the
// user assigned.
//
// Both routes need a signed-in session, same as every other route that
// touches real files (see routes/episodes.js's handleDeleteEpisodeFile).
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { logInfo, logWarn } = require('../logger');
const { sendJson, readJsonBody } = require('../lib/http');
const { getSessionUser } = require('./auth');
const { insertHistoryRow } = require('./history');
const { walkVideoFiles, isVideoFile, guessSeasonEpisode, guessQualityTierName, guessResolutionGroup, resolutionGroupFromHeight, seasonNumberFromFolderName } = require('../lib/media-files');
const { normalizeFolderName, formatBytes } = require('../lib/fs-helpers');
const { importEpisodeFile } = require('../lib/media-import');
const { probeMediaStreams } = require('../lib/ffprobe');
const { recomputeSeriesEpisodeStats } = require('../lib/series-stats');
const { notifyConnections } = require('../lib/notify');
const { resolveLocalPath, joinRemotePath } = require('../lib/remote-path');
const qbittorrent = require('../lib/download-clients/qbittorrent');

// A scan of a huge tree (someone pointing this at a whole media drive)
// still walks everything, but the response is capped so the page stays
// usable — the UI says it was truncated and to pick a narrower folder.
const MAX_FILES = 500;

const epLabel = (season, num) => `S${String(season).padStart(2, '0')}E${String(num).padStart(2, '0')}`;

// The text to guess quality from: the filename, or — when the filename
// carries no resolution tag of its own ("03.mkv" inside a batch) — the
// filename plus its parent folders, where batch releases put "[1080p]".
function qualityText(relativeOrAbsPath) {
  const name = path.basename(relativeOrAbsPath);
  if (guessResolutionGroup(name)) return name;
  const parents = path.dirname(relativeOrAbsPath).split(path.sep).filter((d) => d && d !== '.').slice(-2);
  return [...parents, name].join(' ');
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
// Series guessing
// ---------------------------------------------------------------------------

// Every Library series, keyed by each of its normalized names (title plus
// alt_titles — AniList synonyms included, see lib/anime-ids.js). Built once
// per scan.
async function loadSeriesIndex() {
  const rows = await db.prepare('SELECT id, title, alt_titles, path FROM series').all();
  const keys = [];
  for (const row of rows) {
    let alts = [];
    try { alts = row.alt_titles ? JSON.parse(row.alt_titles) : []; } catch { /* ignore a malformed column */ }
    for (const name of [row.title, ...(Array.isArray(alts) ? alts : [])]) {
      const key = normalizeFolderName(name || '');
      if (key) keys.push({ key, series: row });
    }
  }
  return { rows, keys };
}

// Text candidates for which show a file belongs to, most specific first:
// the filename with its episode number removed, then each folder between
// the file and the scan root (closest first, skipping "Season N" folders),
// then the scan root's own name.
function seriesNameCandidates(file, scanRootName) {
  const out = [];
  const base = file.name.replace(/\.[^.]+$/, '');
  out.push(base);
  const dirs = path.dirname(file.relativePath).split(path.sep).filter((d) => d && d !== '.');
  for (const d of dirs.reverse()) {
    if (seasonNumberFromFolderName(d) == null) out.push(d);
  }
  if (scanRootName) out.push(scanRootName);
  return out;
}

function guessSeriesForFile(file, absPath, scanRootName, index) {
  // Strongest signal: the file already sits inside a series' own folder.
  for (const s of index.rows) {
    if (!s.path) continue;
    const withSep = s.path.endsWith(path.sep) ? s.path : s.path + path.sep;
    if (absPath.startsWith(withSep)) return s;
  }
  for (const text of seriesNameCandidates(file, scanRootName)) {
    // normalizeFolderName drops brackets, years, SxxExx and quality tags;
    // also drop a trailing bare episode number ("frieren 05") and anything
    // after a " - NN" so "Show - 05 - Title" reduces to "show".
    const cleaned = normalizeFolderName(text.replace(/\s-\s*\d{1,4}(?:v\d)?\b.*$/, ''))
      .replace(/\s\d{1,4}(?:v\d)?$/, '');
    if (!cleaned) continue;
    const exact = index.keys.find((k) => k.key === cleaned);
    if (exact) return exact.series;
    // Prefix match (the file's name starts with a series name), longest
    // series name wins. Very short names ("sa", "k") are too ambiguous to
    // match on a prefix alone.
    let best = null;
    for (const k of index.keys) {
      if (k.key.length < 4) continue;
      if (cleaned.startsWith(`${k.key} `) && (!best || k.key.length > best.key.length)) best = k;
    }
    if (best) return best.series;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Episode guessing — same rules as routes/import-files.js (direct
// season:number first, absolute/cumulative numbering as a fallback, and a
// season whose numbers run past its own episode count treated as absolute
// throughout — see that file's comments for the real cases behind each),
// applied per series across every file in this scan assigned to it.
// ---------------------------------------------------------------------------
async function assignEpisodes(seriesId, entries) {
  const episodeRows = await db.prepare('SELECT id, season_number, num, path FROM episodes WHERE series_id = ?').all(seriesId);
  if (episodeRows.length === 0) {
    for (const e of entries) {
      e.reason = "This series' episode list hasn't loaded yet — pick the episode by hand, or open the series page once and rescan.";
    }
    return;
  }
  const byKey = new Map(episodeRows.map((e) => [`${e.season_number}:${e.num}`, e]));
  const byAbsolute = new Map();
  episodeRows
    .filter((e) => e.season_number > 0)
    .sort((a, b) => (a.season_number - b.season_number) || (a.num - b.num))
    .forEach((e, i) => byAbsolute.set(i + 1, e));
  const byPath = new Map(episodeRows.filter((e) => e.path).map((e) => [e.path, e]));

  const seasonMax = new Map();
  for (const e of episodeRows) seasonMax.set(e.season_number, Math.max(seasonMax.get(e.season_number) || 0, e.num));
  const guessedMax = new Map();
  for (const e of entries) {
    if (e.guess.episode == null) continue;
    const s = e.guess.season ?? 1;
    guessedMax.set(s, Math.max(guessedMax.get(s) || 0, e.guess.episode));
  }
  const absoluteSeasons = new Set([...guessedMax].filter(([s, max]) => max > (seasonMax.get(s) || 0)).map(([s]) => s));

  for (const e of entries) {
    // Already the Library file for an episode — say so instead of guessing.
    const existing = byPath.get(e.out.path);
    if (existing) {
      e.out.season = existing.season_number;
      e.out.episodeIds = [existing.id];
      e.out.alreadyImported = true;
      continue;
    }
    const { guess } = e;
    if (guess.episode == null) {
      e.reason = "Couldn't find an episode number in the filename.";
      if (guess.season != null) e.out.season = guess.season;
      continue;
    }
    const season = guess.season ?? 1;
    const absolute = byAbsolute.get(guess.episode);
    const absoluteOk = absolute && (guess.season == null || absolute.season_number === guess.season);
    let ep;
    if (absoluteSeasons.has(season)) ep = absoluteOk ? absolute : byKey.get(`${season}:${guess.episode}`);
    else ep = byKey.get(`${season}:${guess.episode}`) || (absoluteOk ? absolute : null);
    if (!ep) {
      e.out.season = season;
      e.reason = `No season ${season}, episode ${guess.episode} in this series' episode list.`;
      continue;
    }
    e.out.season = ep.season_number;
    e.out.episodeIds = [ep.id];
    e.out.confident = guess.confident || guess.season != null;
  }
}

// ---------------------------------------------------------------------------
// Where the files come from: a folder (or single file) the user picked, or
// a queue row's torrent on its download client.
// ---------------------------------------------------------------------------
async function filesFromPath(target) {
  let stat;
  try {
    stat = await fs.promises.stat(target);
  } catch (err) {
    return { error: `Can't read "${target}" (${err.code || err.message}).` };
  }
  if (stat.isFile()) {
    if (!isVideoFile(target)) return { error: `"${path.basename(target)}" isn't a video file Kitsune recognizes.` };
    return {
      root: path.dirname(target),
      files: [{ name: path.basename(target), relativePath: path.basename(target), sizeBytes: stat.size, seasonHint: null }],
    };
  }
  if (!stat.isDirectory()) return { error: `"${target}" isn't a file or folder.` };
  return { root: target, files: await walkVideoFiles(target) };
}

async function filesFromQueue(queueId) {
  const row = await db.prepare('SELECT * FROM queue WHERE id = ?').get(queueId);
  if (!row) return { error: 'That queue item no longer exists — it may have finished or been removed.' };
  const clientRow = row.download_client_id
    ? await db.prepare("SELECT * FROM settings_items WHERE id = ? AND section = 'download-clients'").get(row.download_client_id)
    : null;
  if (!clientRow || !row.torrent_hash) return { error: "This queue item isn't linked to a download client Kitsune can ask for its files. Pick the folder by hand instead." };
  const client = { id: clientRow.id, ...JSON.parse(clientRow.data) };

  const list = await qbittorrent.getTorrents(client, { category: client.category });
  if (!list.ok) return { error: `Couldn't reach "${client.name}": ${list.error}` };
  const torrent = list.torrents.find((t) => t.hash === row.torrent_hash);
  if (!torrent) return { error: `"${client.name}" no longer has this torrent. Pick the folder by hand instead.` };
  const filesResult = await qbittorrent.getTorrentFiles(client, row.torrent_hash);
  const queue = { id: row.id, releaseTitle: row.release_title, hash: row.torrent_hash, seriesId: row.series_id };
  const localSavePath = resolveLocalPath(client, torrent.save_path);
  if (!filesResult.ok) return { error: `Couldn't list the torrent's files: ${filesResult.error}`, suggestedPath: localSavePath };

  const files = [];
  const missing = [];
  for (const f of filesResult.files) {
    if (!isVideoFile(f.name)) continue;
    const local = resolveLocalPath(client, joinRemotePath(torrent.save_path, f.name));
    try {
      const st = await fs.promises.stat(local);
      files.push({ name: path.basename(f.name), relativePath: path.relative(localSavePath, local), sizeBytes: st.size, seasonHint: seasonHintFromRelative(f.name), absPath: local });
    } catch {
      missing.push(local);
    }
  }
  return { root: localSavePath, files, queue, missing };
}

function seasonHintFromRelative(rel) {
  for (const part of path.dirname(rel).split(/[\\/]/).reverse()) {
    const n = seasonNumberFromFolderName(part);
    if (n != null) return n;
  }
  return null;
}

async function handleScan(req, res) {
  if (!(await requireSignedIn(req, res))) return;
  const params = new URL(req.url, 'http://localhost').searchParams;
  const queueId = Number(params.get('queueId')) || null;
  let forcedSeriesId = Number(params.get('seriesId')) || null;

  let source;
  if (queueId) {
    source = await filesFromQueue(queueId);
    if (source.queue) forcedSeriesId = source.queue.seriesId;
  } else {
    const raw = String(params.get('path') || '').trim();
    if (!raw) return sendJson(res, 400, { error: 'Choose a folder to scan.' });
    if (!path.isAbsolute(raw)) return sendJson(res, 400, { error: 'Use a full path, e.g. /downloads/complete.' });
    const target = path.resolve(raw);
    if (target === path.parse(target).root) return sendJson(res, 400, { error: "Scanning the whole filesystem isn't supported — pick the folder the files are in." });
    source = await filesFromPath(target);
  }
  if (source.error) return sendJson(res, 400, { error: source.error, suggestedPath: source.suggestedPath || null });

  const index = await loadSeriesIndex();
  const forcedSeries = forcedSeriesId ? index.rows.find((s) => s.id === forcedSeriesId) : null;
  if (forcedSeriesId && !forcedSeries) return sendJson(res, 404, { error: 'Series not found.' });

  const totalFound = source.files.length;
  const files = source.files
    .slice()
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath, undefined, { numeric: true }))
    .slice(0, MAX_FILES);
  const scanRootName = path.basename(source.root);

  const entries = [];
  for (const file of files) {
    const absPath = file.absPath || path.join(source.root, file.relativePath);
    const series = forcedSeries || guessSeriesForFile(file, absPath, scanRootName, index);
    const out = {
      path: absPath,
      relativePath: file.relativePath,
      name: file.name,
      sizeBytes: file.sizeBytes,
      sizeFormatted: formatBytes(file.sizeBytes),
      seriesId: series ? series.id : null,
      season: null,
      episodeIds: [],
      quality: await guessQualityTierName(qualityText(file.relativePath)),
      confident: false,
      alreadyImported: false,
      reason: null,
    };
    entries.push({ out, series, guess: guessSeasonEpisode(file.name, file.seasonHint), reason: null });
  }

  const bySeries = new Map();
  for (const e of entries) {
    if (!e.series) { e.reason = "Couldn't tell which series this is — pick one."; continue; }
    if (!bySeries.has(e.series.id)) bySeries.set(e.series.id, []);
    bySeries.get(e.series.id).push(e);
  }
  for (const [seriesId, group] of bySeries) await assignEpisodes(seriesId, group);
  for (const e of entries) e.out.reason = e.reason;

  logInfo('ManualImport', `Scanned "${source.root}": ${totalFound} video file(s)${totalFound > MAX_FILES ? ` (showing first ${MAX_FILES})` : ''}`);
  sendJson(res, 200, {
    path: source.root,
    files: entries.map((e) => e.out),
    truncated: totalFound > MAX_FILES,
    totalFound,
    queue: source.queue || null,
    missing: source.missing || [],
  });
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------
async function handleImport(req, res) {
  if (!(await requireSignedIn(req, res))) return;
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    return sendJson(res, 400, { error: 'Invalid JSON body' });
  }
  const mode = body.mode === 'move' ? 'move' : 'copy';
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length === 0) return sendJson(res, 400, { error: 'Nothing selected to import.' });

  // Validate the whole request before touching anything, so a bad
  // assignment (the same episode given two files) is caught up front
  // rather than after half the files have already moved.
  const seenPaths = new Set();
  const seenEpisodes = new Map();
  for (const it of items) {
    const p = typeof it.path === 'string' ? path.resolve(it.path) : '';
    if (!p || !path.isAbsolute(it.path)) return sendJson(res, 400, { error: 'Every file needs a full path.' });
    if (seenPaths.has(p)) return sendJson(res, 400, { error: `"${path.basename(p)}" is listed twice.` });
    seenPaths.add(p);
    if (!Number(it.seriesId)) return sendJson(res, 400, { error: `Choose a series for "${path.basename(p)}".` });
    const ids = Array.isArray(it.episodeIds) ? it.episodeIds.map(Number).filter(Boolean) : [];
    if (ids.length === 0) return sendJson(res, 400, { error: `Choose an episode for "${path.basename(p)}".` });
    for (const id of ids) {
      if (seenEpisodes.has(id)) {
        return sendJson(res, 400, { error: `"${path.basename(p)}" and "${seenEpisodes.get(id)}" are both assigned to the same episode.` });
      }
      seenEpisodes.set(id, path.basename(p));
    }
  }

  const results = [];
  const touchedSeries = new Set();
  for (const it of items) {
    const result = await importOne(it, mode, body.queueHash || null);
    results.push(result);
    if (result.ok) touchedSeries.add(Number(it.seriesId));
  }
  for (const id of touchedSeries) await recomputeSeriesEpisodeStats(id);

  const imported = results.filter((r) => r.ok).length;
  const failed = results.length - imported;
  logInfo('ManualImport', `Manual import finished: ${imported} imported, ${failed} failed (mode: ${mode})`);
  sendJson(res, 200, { results, imported, failed });
}

async function importOne(it, mode, queueHash) {
  const sourcePath = path.resolve(it.path);
  const fail = (error) => {
    logWarn('ManualImport', `"${sourcePath}": ${error}`);
    return { path: it.path, ok: false, error };
  };

  const series = await db.prepare('SELECT * FROM series WHERE id = ?').get(Number(it.seriesId));
  if (!series) return fail('That series is no longer in the Library.');
  // Without a real series folder, episode-paths.js falls back to a made-up
  // /mnt/anime/... location — fine as a placeholder for the simulated
  // pipeline, wrong as a place to actually put someone's files.
  if (!series.path) return fail(`"${series.title}" has no folder yet — set its Path in Edit Series first.`);

  const ids = it.episodeIds.map(Number);
  const placeholders = ids.map(() => '?').join(', ');
  const episodes = await db.prepare(`SELECT * FROM episodes WHERE id IN (${placeholders})`).all(...ids);
  if (episodes.length !== ids.length || episodes.some((e) => e.series_id !== series.id)) {
    return fail(`One of the chosen episodes doesn't belong to "${series.title}" — rescan and try again.`);
  }
  episodes.sort((a, b) => (a.season_number - b.season_number) || (a.num - b.num));
  const labels = episodes.map((e) => epLabel(e.season_number, e.num));

  let stat;
  try {
    stat = await fs.promises.stat(sourcePath);
  } catch (err) {
    return fail(`File not found (${err.code || err.message}) — it may have been moved since the scan.`);
  }
  if (!stat.isFile() || !isVideoFile(sourcePath)) return fail("Not a video file Kitsune recognizes.");

  // Probe the source first so a confirmed real resolution can correct the
  // filename-based quality guess before it's baked into the new filename —
  // same order as the queue's automatic import. A quality the user picked
  // by hand (qualityLocked) is never second-guessed.
  const mediaStreams = await probeMediaStreams(sourcePath);
  let quality = it.quality || null;
  if (!it.qualityLocked) {
    const probed = mediaStreams && mediaStreams.video ? resolutionGroupFromHeight(mediaStreams.video.height) : null;
    quality = (await guessQualityTierName(qualityText(sourcePath), probed)) || quality;
  }

  const previousPaths = [...new Set(episodes.filter((e) => e.downloaded && e.path).map((e) => e.path))];

  // A file covering several episodes (a double-length episode, an "01-02"
  // release) is named after the first one; every assigned episode then
  // points at that same file, as Sonarr does.
  const imported = await importEpisodeFile(series, episodes[0], quality, sourcePath, { mode });
  if (!imported.ok) return fail(imported.error);

  const update = db.prepare('UPDATE episodes SET downloaded = 1, quality = ?, size_bytes = ?, path = ?, media_streams = ? WHERE id = ?');
  for (const e of episodes) {
    await update.run(quality, imported.sizeBytes, imported.path, mediaStreams ? JSON.stringify(mediaStreams) : null, e.id);
  }

  // Replacing an episode that already had a file: remove the old one, the
  // way an upgrade does in Sonarr — otherwise the series folder ends up
  // with two copies and media servers show the episode twice. Only ever a
  // file inside this series' own folder, that no other episode still
  // points at, and never the file that was just imported.
  const replaced = [];
  const seriesDir = series.path.endsWith(path.sep) ? series.path : series.path + path.sep;
  for (const old of previousPaths) {
    if (old === imported.path || old === sourcePath || !old.startsWith(seriesDir)) continue;
    const stillUsed = await db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE path = ?').get(old);
    if (Number(stillUsed.n) > 0) continue;
    try {
      await fs.promises.unlink(old);
      replaced.push(old);
    } catch (err) {
      if (err.code !== 'ENOENT') logWarn('ManualImport', `Couldn't remove the replaced file "${old}": ${err.code || err.message}`);
    }
  }

  const methodLabel = { hardlink: 'hardlinked', copy: 'copied', move: 'moved', 'in-place': 'already in place', 'already-linked': 'already linked' }[imported.method] || imported.method;
  for (const e of episodes) {
    await insertHistoryRow({
      seriesId: series.id, episodeId: e.id, eventType: 'imported',
      releaseTitle: path.basename(sourcePath), quality, sizeBytes: imported.sizeBytes,
      message: `Manual import (${methodLabel}) from "${sourcePath}"${replaced.length ? ` — replaced ${replaced.length} previous file(s)` : ''}`,
    });
  }

  // The import that just happened is the one the queue was waiting on. Drop
  // the queue rows for these episodes from the same torrent (arrived via a
  // queue row's "Manual import" button) or that were stuck retrying an
  // automatic import — otherwise the queue would keep retrying and
  // eventually blocklist a release that's in fact been imported. The torrent
  // itself is left alone in the download client.
  const qPlaceholders = ids.map(() => '?').join(', ');
  const cleared = await db.prepare(
    `DELETE FROM queue WHERE episode_id IN (${qPlaceholders}) AND (import_attempts > 0${queueHash ? ' OR torrent_hash = ?' : ''})`,
  ).run(...ids, ...(queueHash ? [queueHash] : []));

  logInfo('ManualImport', `Imported "${sourcePath}" as ${series.title} ${labels.join(', ')} → "${imported.path}" (${imported.method})`);
  notifyConnections('import', `${series.title} ${labels.join(', ')} — ${path.basename(sourcePath)} (${quality || 'unknown quality'}, manual import)`);

  return {
    path: it.path, ok: true, destPath: imported.path, method: imported.method, note: imported.note || null,
    episodes: labels, replaced, queueCleared: (cleared && cleared.changes) || 0,
  };
}

async function handleManualImportApi(req, res, urlPath) {
  if (req.method === 'GET' && urlPath === '/api/manual-import/scan') {
    await handleScan(req, res);
    return true;
  }
  if (req.method === 'POST' && urlPath === '/api/manual-import') {
    await handleImport(req, res);
    return true;
  }
  return false;
}

module.exports = { handleManualImportApi, guessSeriesForFile, loadSeriesIndex, assignEpisodes };
