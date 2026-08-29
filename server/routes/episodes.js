const fs = require('fs');
const path = require('path');
const db = require('../db');
const { logInfo, logWarn } = require('../logger');
const { sendJson, readJsonBody } = require('../lib/http');
const { getSessionUser } = require('./auth');
const { resolveTvdbEpisodeSourceId, fetchTvdbEpisodes } = require('../lib/tvdb');
const { recomputeSeriesEpisodeStats } = require('../lib/series-stats');
const { normalizeFolderName } = require('../lib/fs-helpers');
const { walkVideoFiles, guessQualityTierName, guessSeasonEpisode, resolutionGroupFromHeight } = require('../lib/media-files');
const { probeMediaStreams } = require('../lib/ffprobe');
const { episodeFileNameFor, getMediaManagementSettings } = require('../lib/episode-paths');
const { applyPermissions } = require('../lib/permissions');

// ---------------------------------------------------------------------------
// Episode persistence — real per-episode titles/air dates
//
// This used to run on Jikan (a free, unofficial MyAnimeList wrapper), the
// only source of the three integrations here that had real per-episode
// data — but its episode endpoint turned out to be just as unreliable as
// its search endpoint was, and unlike search (which has the official API to
// fall back on), episodes had nothing else to fall back to. Jikan has been
// removed from the project entirely as a result.
//
// Episodes now come from TheTVDB instead — a real, documented REST API
// rather than something that scrapes MyAnimeList live, so it doesn't share
// Jikan's failure mode. The catch: TVDB and MyAnimeList are different
// catalogs with different ids, so a MAL-added series has no TVDB id to
// start with. resolveTvdbEpisodeSourceId (below, near the rest of the TVDB
// client) resolves one by searching TVDB for the series' own title —
// reusing the same anime-filtered search the MAL-search fallback already
// uses — and caches whatever it finds in a new tvdb_episode_id column so
// that search only ever runs once per series. This can occasionally resolve
// to the wrong show if TVDB's title match is ambiguous; there's no perfect
// fix for that without the id crossing over some other way.
//
// Because this is resolved by title rather than tied to how the series was
// originally added, it works for any series — not just ones added via MAL
// search. The 21 originally-seeded titles and anything added via the old
// TVDB-fallback path can get real episodes too now, not just MAL-sourced
// adds like before.
//
// Results are cached in the `episodes` table on first fetch, so the series
// detail page doesn't re-hit TVDB on every visit.
// ---------------------------------------------------------------------------

db.init(async () => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS episodes (
      id ${db.PK},
      series_id INTEGER NOT NULL,
      season_number INTEGER NOT NULL DEFAULT 0,
      season_name TEXT,
      num INTEGER NOT NULL,
      title TEXT,
      title_japanese TEXT,
      title_romanji TEXT,
      aired TEXT,
      score REAL,
      filler INTEGER NOT NULL DEFAULT 0,
      recap INTEGER NOT NULL DEFAULT 0,
      url TEXT,
      downloaded INTEGER NOT NULL DEFAULT 0,
      quality TEXT,
      size_bytes INTEGER,
      path TEXT,
      UNIQUE(series_id, season_number, num)
    )
  `);

  // Defensive migration for episodes tables created before the extra fields
  // below existed.
  let episodeColumns = await db.tableColumns('episodes');
  for (const [col, def] of [
  ['title_japanese', 'TEXT'], ['title_romanji', 'TEXT'], ['score', 'REAL'],
  ['filler', 'INTEGER NOT NULL DEFAULT 0'], ['recap', 'INTEGER NOT NULL DEFAULT 0'], ['url', 'TEXT'],
  ['downloaded', 'INTEGER NOT NULL DEFAULT 0'], ['quality', 'TEXT'], ['size_bytes', 'INTEGER'],
  // path: added alongside the episode details modal (see README) — the
  // modal needs somewhere to read a file's on-disk location from. Real for
  // anything that went through Library Import (see import-files.js, which
  // already knows the real path it just scanned); a plausible constructed
  // one (see server/lib/episode-paths.js) for anything that "arrived" via
  // the simulated grab pipeline or the initial backfill below, since there
  // was never a real file for either of those to point at.
  ['path', 'TEXT'],
  // overview: the episode's real synopsis text — TVDB returns this on the
  // same base /episodes/default record as name/aired (native-language) and
  // again per-episode on the English translation endpoint (see
  // fetchTvdbEpisodeTranslation in server/lib/tvdb.js, which already fetched
  // this alongside the translated title but discarded it until now). Shown
  // on the episode details modal (see public/js/lib/episode-details-modal.js).
  // Same caveat as every other field in this migration list: a series whose
  // episodes were already cached before this column existed won't have this
  // backfilled automatically — nothing here re-fetches on its own, matching
  // how title_japanese/title_romanji/score never got backfilled for
  // already-cached rows either. Deleting that series' rows from `episodes`
  // (or removing and re-adding the series) forces a fresh TVDB fetch that
  // will include it.
  ['overview', 'TEXT'],
  // media_streams: real per-file audio/subtitle track data from ffprobe
  // (server/lib/ffprobe.js) — JSON `{ audio: [...], subtitles: [...] }`, or
  // NULL for anything that's never had a real file probed (a simulated
  // grab, the initial downloaded-state backfill, or a real import that ran
  // before ffprobe was wired in / on a machine without ffprobe installed).
  // Only ever set by the three real-import paths that actually have a real
  // file to point ffprobe at: scanExistingFilesForSeries below,
  // import-files.js's real import, and queue.js's real grab completion —
  // never by anything in the simulated pipeline, since there's no real file
  // there to probe. NULL is treated as "unknown," not "no audio" — see
  // SeriesPage.jsx's summarizeAudioTracks, which used to just hardcode
  // "Dual" for every downloaded episode regardless of whether it was ever
  // real.
    ['media_streams', 'TEXT'],
  ]) {
    if (!episodeColumns.includes(col)) {
      await db.exec(`ALTER TABLE episodes ADD COLUMN ${col} ${def}`);
      logInfo('Database', `Migrated episodes table: added ${col} column`);
    }
  }

// season_number/season_name need a real migration, not just an ALTER TABLE
// ADD COLUMN: episode numbers restart at 1 for every season (specials vs.
// season 1 vs. season 2, etc.), so a table with just UNIQUE(series_id, num)
// silently drops any episode whose number collides with one from a
// different season via INSERT OR IGNORE — which is exactly why episode
// lists could come back with two different seasons interleaved together
// with no way to tell them apart, or missing episodes outright. SQLite
// can't alter a UNIQUE constraint in place, so this rebuilds the table with
// the corrected UNIQUE(series_id, season_number, num) and copies existing
// rows over as season_number 0 (unknown) — the season a previously-cached
// episode belonged to can't be recovered after the fact; deleting a
// series' rows and re-fetching is what backfills real season numbers.
  episodeColumns = await db.tableColumns('episodes');
  if (!episodeColumns.includes('season_number')) {
    logInfo('Database', 'Migrating episodes table: adding season tracking (rebuilding for corrected uniqueness constraint)');
    await db.exec(`
      ALTER TABLE episodes RENAME TO episodes_old;
      CREATE TABLE episodes (
        id ${db.PK},
        series_id INTEGER NOT NULL,
        season_number INTEGER NOT NULL DEFAULT 0,
        season_name TEXT,
        num INTEGER NOT NULL,
        title TEXT,
        title_japanese TEXT,
        title_romanji TEXT,
        aired TEXT,
        score REAL,
        filler INTEGER NOT NULL DEFAULT 0,
        recap INTEGER NOT NULL DEFAULT 0,
        url TEXT,
        downloaded INTEGER NOT NULL DEFAULT 0,
        quality TEXT,
        size_bytes INTEGER,
        path TEXT,
        UNIQUE(series_id, season_number, num)
      );
      INSERT INTO episodes (series_id, season_number, num, title, title_japanese, title_romanji, aired, score, filler, recap, url, downloaded, quality, size_bytes, path)
        SELECT series_id, 0, num, title, title_japanese, title_romanji, aired, score, filler, recap, url, downloaded, quality, size_bytes, path FROM episodes_old
        ON CONFLICT (series_id, season_number, num) DO NOTHING;
      DROP TABLE episodes_old;
    `);
  }
});

// Actual fetching happens in resolveTvdbEpisodeSourceId/fetchTvdbEpisodes,
// defined near the rest of the TVDB client below (they need tvdbFetch/
// tvdbSearchAnimeOnly, which live there) — this just wires the endpoint up
// to them plus the episodes cache.
async function handleSeriesEpisodesApi(req, res, urlPath) {
  const seasonMatch = req.method === 'PUT' && urlPath.match(/^\/api\/series\/(\d+)\/seasons\/(\d+)$/);
  if (seasonMatch) return handleRenameSeason(req, res, seasonMatch);

  const refreshMatch = req.method === 'POST' && urlPath.match(/^\/api\/series\/(\d+)\/refresh-episodes$/);
  if (refreshMatch) return handleRefreshEpisodes(req, res, refreshMatch);

  const deleteFileMatch = req.method === 'DELETE' && urlPath.match(/^\/api\/episodes\/(\d+)\/file$/);
  if (deleteFileMatch) return handleDeleteEpisodeFile(req, res, deleteFileMatch);

  const renamePreviewMatch = req.method === 'GET' && urlPath.match(/^\/api\/series\/(\d+)\/rename-preview$/);
  if (renamePreviewMatch) return handleRenamePreview(req, res, renamePreviewMatch);

  const renameMatch = req.method === 'POST' && urlPath.match(/^\/api\/series\/(\d+)\/rename$/);
  if (renameMatch) return handleRenameFiles(req, res, renameMatch);

  const match = req.method === 'GET' && urlPath.match(/^\/api\/series\/(\d+)\/episodes$/);
  if (!match) return false;

  const id = Number(match[1]);
  const series = await db.prepare('SELECT * FROM series WHERE id = ?').get(id);
  if (!series) {
    sendJson(res, 404, { error: 'Series not found' });
    return true;
  }

  // Already fetched and cached — serve that instead of hitting TVDB again.
  // Ordered by season first so a flat consumer still gets specials before
  // season 1 before season 2, etc. — the frontend groups by season_number
  // itself for the actual tabbed view.
  const cachedRows = await loadCachedEpisodes(id);
  if (cachedRows.length > 0) {
    sendJson(res, 200, { episodes: cachedRows, source: 'tvdb', cached: true });
    return true;
  }

  const result = await resolveAndCacheEpisodesDeduped(series);
  // Re-read from the DB rather than returning result.episodes directly: that
  // array is the raw TVDB-shaped response, before scanExistingFilesForSeries
  // ran and before rows had real ids — going through the same DB read as
  // the cached branch above means both ever return the exact same shape
  // (id/downloaded/quality/sizeBytes included) regardless of whether this
  // request was the one that triggered the fetch or just arrived after it.
  const freshRows = await loadCachedEpisodes(id);
  sendJson(res, 200, { episodes: freshRows, source: result.source, cached: false, ...(result.error ? { error: result.error } : {}) });
  return true;
}

// PUT /api/series/:id/seasons/:seasonNumber — rename a season's segment-tab
// label. Reuses the episodes table's existing season_name column (already
// populated from TVDB — see resolveAndCacheEpisodesForSeries below) rather
// than a new overrides table: every episode already cached for that season
// gets its season_name overwritten together, so groupEpisodesBySeason /
// segmentLabel on the frontend (frontend/pages/series/SeriesPage.jsx) just
// keep reading the same field they already did, no extra lookup or
// override-precedence logic needed there. An empty/blank name clears it back
// to null, reverting the tab to whatever it would show without a manual
// rename (a real named arc from TVDB if there is one, else the plain
// "Season N" fallback — see segmentLabel). Season 0 (Specials) can't be
// renamed — segmentLabel hardcodes "Specials" for it regardless of
// season_name, matching the app's own broadcast-segment-labeling rule
// (see wiki's project notes: cour/season+year labels are never shown, and
// Specials is always just "Specials").
async function handleRenameSeason(req, res, match) {
  // Real, confirmed gap: this write path had no session check at all until
  // now — see the incident it was added for (Frieren's season 3 tab ending
  // up labeled with a raw, untranslated TVDB-style season name nobody in
  // the house set on purpose; System > Logs had already rotated past
  // whatever request actually did it, and the app's Library API was never
  // scoped to a signed-in user in the first place — see routes/auth.js's
  // own comment on that). Same 401 shape as every other session-gated route
  // (see routes/user-prefs.js) rather than inventing a new error format.
  const user = await getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { error: 'Not signed in.' });
    return true;
  }
  const seriesId = Number(match[1]);
  const seasonNumber = Number(match[2]);
  const series = await db.prepare('SELECT * FROM series WHERE id = ?').get(seriesId);
  if (!series) {
    sendJson(res, 404, { error: 'Series not found' });
    return true;
  }
  if (seasonNumber === 0) {
    sendJson(res, 400, { error: 'Specials can\'t be renamed.' });
    return true;
  }
  const episodeRows = await db.prepare('SELECT id FROM episodes WHERE series_id = ? AND season_number = ?').all(seriesId, seasonNumber);
  if (episodeRows.length === 0) {
    sendJson(res, 404, { error: 'No cached episodes for that season yet.' });
    return true;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return true;
  }
  const name = String(body.name || '').trim() || null;
  await db.prepare('UPDATE episodes SET season_name = ? WHERE series_id = ? AND season_number = ?').run(name, seriesId, seasonNumber);
  logInfo('EpisodeService', `"${series.title}" season ${seasonNumber} renamed to ${name ? `"${name}"` : '(cleared, back to default)'}`);
  sendJson(res, 200, { seasonNumber, name });
  return true;
}

// POST /api/series/:id/refresh-episodes — re-fetches this series' episode
// metadata from TheTVDB and updates the already-cached rows in place,
// instead of the only previous option (delete the series' episode rows
// entirely, or remove and re-add the whole series) to retry after a fetch
// that resolved successfully but came back with incomplete data — e.g. a
// real case where every episode's title landed on the generic "Episode N"
// fallback because the per-episode English-translation requests all failed
// for a reason fetchTvdbEpisodeTranslation didn't used to log at all (see
// that function's own comment — now it does, so a repeat of this is at
// least diagnosable from System > Logs, but existing cached rows still need
// an actual way to pick up a fix without losing real per-episode state).
async function handleRefreshEpisodes(req, res, match) {
  // Same session gate as the other write paths in this file — see
  // handleRenameSeason's comment for why this was added.
  const user = await getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { error: 'Not signed in.' });
    return true;
  }
  const id = Number(match[1]);
  const series = await db.prepare('SELECT * FROM series WHERE id = ?').get(id);
  if (!series) {
    sendJson(res, 404, { error: 'Series not found' });
    return true;
  }
  const result = await refreshEpisodesForSeries(series);
  if (!result.ok) {
    sendJson(res, 502, { error: result.error });
    return true;
  }
  const freshRows = await loadCachedEpisodes(id);
  sendJson(res, 200, { episodes: freshRows, count: result.count });
  return true;
}

// DELETE /api/episodes/:id/file — removes the real media file backing a
// downloaded episode (from Series' episode-row "..." menu — see
// EpisodeActionsMenu in frontend/pages/series/SeriesPage.jsx) and resets
// that episode back to not-downloaded, same downloaded/quality/size_bytes/
// path/media_streams reset import-files.js's own reconciliation pass runs
// for a file that's vanished out from under Kitsune — the only difference
// here is Kitsune itself is the one removing the file, on purpose, instead
// of just noticing it's already gone.
//
// `path` can point at a fabricated-but-plausible location for an episode
// that was never a real grab/import (a simulated download completing, or
// the add-time backfill — see episode-paths.js's own comment for the full
// reasoning), so ENOENT here is a normal, expected outcome, not a failure:
// there was never a real file to remove, just DB state saying there should
// be one. Any other error (permissions, a path that's actually a directory,
// etc.) means the file is still really sitting on disk, so the DB is left
// untouched rather than reporting a deletion that didn't actually happen.
async function handleDeleteEpisodeFile(req, res, match) {
  // Same session gate as the other write paths in this file — see
  // handleRenameSeason's comment for why this was added. This one deletes a
  // real file off disk, so it's the highest-stakes of the four.
  const user = await getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { error: 'Not signed in.' });
    return true;
  }
  const id = Number(match[1]);
  const episode = await db.prepare('SELECT * FROM episodes WHERE id = ?').get(id);
  if (!episode) {
    sendJson(res, 404, { error: 'Episode not found' });
    return true;
  }
  if (!episode.downloaded || !episode.path) {
    sendJson(res, 400, { error: 'This episode has no file to delete.' });
    return true;
  }

  try {
    fs.unlinkSync(episode.path);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      logWarn('EpisodeService', `Could not delete file "${episode.path}" for episode ${id}: ${err.code || err.message}`);
      sendJson(res, 500, { error: `Could not delete the file: ${err.code || err.message}` });
      return true;
    }
    // Already gone — fall through and reconcile the DB to match reality.
  }

  await db.prepare('UPDATE episodes SET downloaded = 0, quality = NULL, size_bytes = NULL, path = NULL, media_streams = NULL WHERE id = ?').run(id);
  await recomputeSeriesEpisodeStats(episode.series_id);
  const series = await db.prepare('SELECT eps, pct FROM series WHERE id = ?').get(episode.series_id);
  logInfo('EpisodeService', `Deleted media file for episode ${id} (S${episode.season_number}E${episode.num}) from "${episode.path}"`);
  sendJson(res, 200, {
    id,
    seriesId: episode.series_id,
    deleted: true,
    seriesEps: series ? series.eps : undefined,
    seriesPct: series ? series.pct : undefined,
  });
  return true;
}

// GET /api/series/:id/rename-preview — read-only: for every real,
// downloaded episode this series has (a real path on disk), computes what
// its filename would be renamed to under Settings > Media Management's
// current naming format, without touching anything. The manual "Rename
// Files" action below (handleRenameFiles) reuses this exact same
// computation for the file it actually renames, so what's previewed here
// is always exactly what executing would do — there's no separate preview
// codepath that could quietly drift from the real one.
async function handleRenamePreview(req, res, match) {
  const seriesId = Number(match[1]);
  const series = await db.prepare('SELECT * FROM series WHERE id = ?').get(seriesId);
  if (!series) {
    sendJson(res, 404, { error: 'Series not found' });
    return true;
  }
  const settings = await getMediaManagementSettings();
  const rows = await db.prepare(
    'SELECT id, season_number, num, title, quality, path FROM episodes WHERE series_id = ? AND downloaded = 1 AND path IS NOT NULL ORDER BY season_number ASC, num ASC'
  ).all(seriesId);

  const items = await Promise.all(rows.map(async (r) => {
    const episode = { seasonNumber: r.season_number, num: r.num, title: r.title };
    const ext = path.extname(r.path) || '.mkv';
    const newName = `${await episodeFileNameFor(series, episode, r.quality, settings, { sourcePath: r.path })}${ext}`;
    const newPath = path.join(path.dirname(r.path), newName);
    return {
      episodeId: r.id, seasonNumber: r.season_number, num: r.num, title: r.title,
      oldPath: r.path, oldName: path.basename(r.path), newPath, newName,
      changed: newPath !== r.path,
    };
  }));

  sendJson(res, 200, { items, renameEpisodesToggle: settings.renameEpisodesToggle });
  return true;
}

// POST /api/series/:id/rename — body: { episodeIds: [...] }. Actually
// renames the real file for each given episode on disk (fs.renameSync,
// same directory — this relabels the filename only, it never restructures
// season/series folders) using the exact same computation
// handleRenamePreview above already showed the user, then updates that
// episode's own `path` column to match. Anything that fails (permissions, a
// file that moved out from under Kitsune since the preview was fetched) is
// reported per-episode rather than aborting the whole batch, same "one bad
// item shouldn't block the rest" rule this app's other bulk actions
// (Search All, Grab best match for a whole season) already follow.
async function handleRenameFiles(req, res, match) {
  // Same session gate as the other write paths in this file — see
  // handleRenameSeason's comment for why this was added. This one renames
  // real files on disk, same stakes as handleDeleteEpisodeFile.
  const user = await getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { error: 'Not signed in.' });
    return true;
  }
  const seriesId = Number(match[1]);
  const series = await db.prepare('SELECT * FROM series WHERE id = ?').get(seriesId);
  if (!series) {
    sendJson(res, 404, { error: 'Series not found' });
    return true;
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return true;
  }
  const episodeIds = Array.isArray(body.episodeIds) ? body.episodeIds.map(Number) : [];
  if (episodeIds.length === 0) {
    sendJson(res, 400, { error: 'No episodes selected.' });
    return true;
  }

  const settings = await getMediaManagementSettings();
  const results = [];
  for (const episodeId of episodeIds) {
    const r = await db.prepare('SELECT * FROM episodes WHERE id = ? AND series_id = ?').get(episodeId, seriesId);
    if (!r || !r.downloaded || !r.path) {
      results.push({ episodeId, ok: false, error: 'No file on disk for this episode.' });
      continue;
    }
    const episode = { seasonNumber: r.season_number, num: r.num, title: r.title };
    const ext = path.extname(r.path) || '.mkv';
    const newName = `${await episodeFileNameFor(series, episode, r.quality, settings, { sourcePath: r.path })}${ext}`;
    const newPath = path.join(path.dirname(r.path), newName);
    if (newPath === r.path) {
      results.push({ episodeId, ok: true, path: r.path, unchanged: true });
      continue;
    }
    try {
      fs.renameSync(r.path, newPath);
    } catch (err) {
      results.push({ episodeId, ok: false, error: err.code || err.message });
      continue;
    }
    // Same directory only (see this function's header comment — a rename
    // never restructures season/series folders), so just the file itself
    // needs Set Permissions re-applied, not its containing folder.
    await applyPermissions({ filePath: newPath });
    await db.prepare('UPDATE episodes SET path = ? WHERE id = ?').run(newPath, episodeId);
    results.push({ episodeId, ok: true, path: newPath, oldPath: r.path });
  }

  const renamedCount = results.filter((r) => r.ok && !r.unchanged).length;
  logInfo('EpisodeService', `"${series.title}": renamed ${renamedCount} file(s)`);
  sendJson(res, 200, { results });
  return true;
}

async function loadCachedEpisodes(seriesId) {
  const rows = await db.prepare(`
    SELECT id, season_number, season_name, num, title, title_japanese, title_romanji, aired, score, filler, recap, url, downloaded, quality, size_bytes, path, overview, media_streams
    FROM episodes WHERE series_id = ? ORDER BY season_number ASC, num ASC
  `).all(seriesId);
  return rows.map((r) => {
    // NULL (never probed) and "couldn't parse" both fall back to null here
    // — same "unknown, not a guess" treatment either way. See ffprobe.js's
    // own comment for why this can be null even for a real, downloaded
    // episode (ffprobe not installed, or a real import that ran before this
    // feature existed).
    let mediaStreams = null;
    if (r.media_streams) {
      try { mediaStreams = JSON.parse(r.media_streams); } catch { /* leave null */ }
    }
    return {
      id: r.id, seasonNumber: r.season_number, seasonName: r.season_name, num: r.num, title: r.title,
      titleJapanese: r.title_japanese, titleRomanji: r.title_romanji,
      aired: r.aired, score: r.score, filler: !!r.filler, recap: !!r.recap, url: r.url,
      downloaded: !!r.downloaded, quality: r.quality, sizeBytes: r.size_bytes, path: r.path,
      overview: r.overview || null, mediaStreams,
    };
  });
}

// The actual resolve → fetch → cache work, factored out of
// handleSeriesEpisodesApi above so the exact same flow can also run in the
// background right when a series is added (see warmEpisodesInBackground /
// POST /api/series below) instead of only on a visitor's first trip to the
// series detail page. Never throws — a failure here is logged and comes
// back as an empty episode list either way, since both callers treat "no
// episodes yet" as a normal, non-fatal outcome (the detail page just falls
// back to its synthetic "Episode N" list).

// Every configured root folder's real, top-level subfolders, checked for one
// whose name normalizes to the same thing as this series' title — or one of
// its alt_titles, since a folder on disk is just as likely to be named after
// a fansub group's own native/romanized title as the official one (the same
// "the official title isn't what this actually gets called" problem this
// app already solves for Nyaa/TVDB search via alt_titles). Checks every root
// folder in whatever order Settings > Media Management lists them and stops
// at the first real match; returns null (a completely normal, common
// outcome for a series with nothing downloaded anywhere yet) if nothing on
// disk looks like this series at all, or if no root folders are configured.
async function findExistingSeriesFolder(series) {
  const candidateNames = [series.title];
  try {
    const altTitles = series.alt_titles ? JSON.parse(series.alt_titles) : [];
    candidateNames.push(...altTitles);
  } catch { /* malformed JSON — primary title only */ }
  const normalizedCandidates = new Set(candidateNames.map(normalizeFolderName));

  const rootFolderPaths = (await db.prepare("SELECT data FROM settings_items WHERE section = 'root-folders'").all())
    .map((row) => JSON.parse(row.data).path);

  for (const rootPath of rootFolderPaths) {
    let entries;
    try {
      entries = fs.readdirSync(rootPath, { withFileTypes: true });
    } catch (err) {
      logWarn('EpisodeService', `Could not scan root folder "${rootPath}" for "${series.title}": ${err.code || err.message}`);
      continue;
    }
    const hit = entries.find((e) => e.isDirectory() && !e.name.startsWith('.') && normalizedCandidates.has(normalizeFolderName(e.name)));
    if (hit) return path.join(rootPath, hit.name);
  }
  return null;
}

// Matches a real folder's real video files against this series' just-cached
// episode list — same guessSeasonEpisode/guessQualityTierName matching
// server/routes/import-files.js uses for a manual Library Import, just run
// automatically right when a series is added instead of waiting for someone
// to notice the files were already there and run Import by hand. Unlike
// Library Import, this never resets anything: a freshly-added series starts
// with every episode undownloaded, so there's nothing to reconcile — it only
// ever adds matches, silently skipping anything it can't confidently place
// (no episode number, an ambiguous season, no matching episode row) rather
// than guessing wrong.
async function scanExistingFilesForSeries(series, episodeRows) {
  const folderPath = await findExistingSeriesFolder(series);
  if (!folderPath) return { matchedCount: 0, folderPath: null };

  const files = walkVideoFiles(folderPath);
  if (files.length === 0) return { matchedCount: 0, folderPath };

  // A bare "05"-style filename with no SxxExx tag and no "Season N" ancestor
  // folder to inherit a season from (see guessSeasonEpisode/walkVideoFiles
  // in media-files.js) gets treated as season 1 — the common real case for
  // anime that either only has one season to begin with, or has every
  // season's files sitting flat in the root with no per-season
  // subfolders at all. A file that DOES sit under a real "Season 2" folder,
  // or does carry an SxxExx tag, still resolves to whatever season that
  // actually says — this only fills in for files with no season signal
  // whatsoever, it doesn't override a real one. Previously this only
  // resolved unambiguously when the series had exactly one real season and
  // otherwise left the file unmatched entirely (a real, confirmed case:
  // Tsugumomo's flat, season-less files stopped matching once TVDB
  // disambiguation correctly gave it a real second season — see
  // tvdb.js's pickBestTvdbCandidate) — assuming season 1 instead means a
  // file that's actually season 2 audio/video sitting loose in the root
  // (rather than under its own "Season 2" folder) can silently match the
  // wrong episode; the tradeoff favors matching by default over leaving
  // Downloaded stuck at 0 for the very common flat-folder layout.
  const distinctRealSeasons = [...new Set(episodeRows.filter((e) => e.season_number !== 0).map((e) => e.season_number))];
  const episodeByKey = new Map(episodeRows.map((e) => [`${e.season_number}:${e.num}`, e]));
  const update = db.prepare('UPDATE episodes SET downloaded = 1, quality = ?, size_bytes = ?, path = ?, media_streams = ? WHERE id = ?');

  let matchedCount = 0;
  let assumedSeason1Count = 0;
  for (const file of files) {
    const guess = guessSeasonEpisode(file.name, file.seasonHint);
    if (guess.episode == null) continue;
    let season = guess.season;
    if (season == null) {
      season = 1;
      assumedSeason1Count++;
    }
    const episode = episodeByKey.get(`${season}:${guess.episode}`);
    if (!episode) continue;
    const realPath = path.join(folderPath, file.relativePath);
    // Probed BEFORE the quality guess below, not after — real per-file
    // audio/subtitle tracks plus the real video stream's own width/height
    // (see lib/ffprobe.js) — null when ffprobe isn't installed or the probe
    // fails, same "unknown, not a guess" treatment as everything else this
    // function couldn't confirm. A confirmed real resolution overrides
    // whatever (if anything) the filename itself claims — see
    // guessQualityTierName's own comment for why a probe beats a text tag.
    const streams = probeMediaStreams(realPath);
    const probedResolutionGroup = streams && streams.video ? resolutionGroupFromHeight(streams.video.height) : null;
    const quality = await guessQualityTierName(file.name, probedResolutionGroup);
    await update.run(quality, file.sizeBytes, realPath, streams ? JSON.stringify(streams) : null, episode.id);
    matchedCount++;
  }
  // Only worth calling out when the assumption was actually doing something
  // — a single-season series landing everything in season 1 is just the
  // normal case, not a decision worth a log line.
  if (assumedSeason1Count > 0 && distinctRealSeasons.length > 1) {
    logInfo('EpisodeService', `"${series.title}": ${assumedSeason1Count} file(s) in "${folderPath}" had no season subfolder/tag — assumed season 1. This series has ${distinctRealSeasons.length} real seasons; move anything that's actually a later season into its own "Season N" subfolder (or rename with an SxxExx tag) and rescan if any of these matched wrong.`);
  }
  return { matchedCount, folderPath };
}

async function resolveAndCacheEpisodesForSeries(series) {
  try {
    const tvdbId = await resolveTvdbEpisodeSourceId(series);
    if (!tvdbId) {
      // Couldn't resolve any TVDB series for this title.
      return { episodes: [], source: null };
    }
    const episodes = await fetchTvdbEpisodes(tvdbId);
    if (episodes.length > 0) {
      const insertEp = db.prepare(`
        INSERT INTO episodes (series_id, season_number, season_name, num, title, title_japanese, title_romanji, aired, score, filler, recap, url, overview)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (series_id, season_number, num) DO NOTHING
      `);
      for (const e of episodes) {
        await insertEp.run(series.id, e.seasonNumber, e.seasonName, e.num, e.title, e.titleJapanese, e.titleRomanji, e.aired, e.score, e.filler ? 1 : 0, e.recap ? 1 : 0, e.url, e.overview || null);
      }
      logInfo('EpisodeService', `Fetched and cached ${episodes.length} episode(s) for "${series.title}" from TheTVDB`);

      // Checked right here, right after the real episode list this needs to
      // match against becomes available, whether that's the moment a series
      // is first added (see warmEpisodesInBackground) or the first time
      // anyone opens its detail page.
      const episodeRows = await db.prepare('SELECT id, season_number, num FROM episodes WHERE series_id = ?').all(series.id);
      const scanResult = await scanExistingFilesForSeries(series, episodeRows);
      if (scanResult.matchedCount > 0) {
        logInfo('EpisodeService', `Found ${scanResult.matchedCount} already-downloaded episode(s) for "${series.title}" already on disk at "${scanResult.folderPath}"`);
      }
      // A real, on-disk folder is authoritative over whatever series.path
      // already held (the add-time default guess from a configured root
      // folder, or nothing at all) — this is where the files actually live,
      // whether or not every one of them matched a known episode this pass.
      // Read-only in the Edit Series modal (see SeriesPage.jsx), so this
      // scan plus the add-time default in routes/series.js are the only two
      // things that ever set it.
      if (scanResult.folderPath && scanResult.folderPath !== series.path) {
        await db.prepare('UPDATE series SET path = ? WHERE id = ?').run(scanResult.folderPath, series.id);
      }

      // Recomputes eps/pct from whatever scanExistingFilesForSeries actually
      // found on disk (zero real files is a completely normal outcome for a
      // freshly-added series — this just means the stats stay at "0 / N"
      // rather than fabricating any progress).
      await recomputeSeriesEpisodeStats(series.id);
    }
    return { episodes, source: 'tvdb' };
  } catch (err) {
    logWarn('EpisodeService', `Episode fetch failed for "${series.title}": ${err.message}`);
    return { episodes: [], source: 'tvdb', error: err.message };
  }
}

// The actual re-fetch-and-update work behind POST .../refresh-episodes
// (handleRefreshEpisodes, above). Reuses whatever tvdb_episode_id is already
// cached on the series (resolveTvdbEpisodeSourceId short-circuits to it
// rather than re-searching) — a refresh is about picking up better/changed
// metadata for the SAME already-matched show, not re-resolving which show
// this is. Upserts by (series_id, season_number, num) rather than deleting
// and re-inserting, and deliberately leaves season_name (a manual Rename
// Season — see handleRenameSeason) and downloaded/quality/size_bytes/path
// (real per-episode download/import state — see server/routes/queue.js and
// server/lib/media-import.js) completely untouched: a refresh updates
// title/synopsis/air-date-type metadata only, never anything Kitsune itself
// tracks independently of TVDB. Also naturally picks up any newly-aired
// episode TVDB has added since the last fetch, as a side effect of the same
// upsert.
async function refreshEpisodesForSeries(series) {
  let tvdbId;
  try {
    tvdbId = await resolveTvdbEpisodeSourceId(series);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!tvdbId) {
    return { ok: false, error: 'Could not resolve a TheTVDB match for this series — check its title/alternate titles.' };
  }
  let episodes;
  try {
    episodes = await fetchTvdbEpisodes(tvdbId);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (episodes.length === 0) {
    return { ok: false, error: 'TheTVDB returned no episodes for this series.' };
  }
  const upsert = db.prepare(`
    INSERT INTO episodes (series_id, season_number, season_name, num, title, title_japanese, title_romanji, aired, score, filler, recap, url, overview)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(series_id, season_number, num) DO UPDATE SET
      title = excluded.title,
      title_japanese = excluded.title_japanese,
      title_romanji = excluded.title_romanji,
      aired = excluded.aired,
      score = excluded.score,
      filler = excluded.filler,
      recap = excluded.recap,
      url = excluded.url,
      overview = excluded.overview
  `);
  for (const e of episodes) {
    await upsert.run(series.id, e.seasonNumber, e.seasonName, e.num, e.title, e.titleJapanese, e.titleRomanji, e.aired, e.score, e.filler ? 1 : 0, e.recap ? 1 : 0, e.url, e.overview || null);
  }
  await recomputeSeriesEpisodeStats(series.id);
  logInfo('EpisodeService', `Refreshed episode metadata for "${series.title}" from TheTVDB (${episodes.length} episode(s))`);
  return { ok: true, count: episodes.length };
}

// A background warm (see below) and someone opening the series detail page
// can land on the same series at nearly the same instant — most obviously,
// clicking straight from Add New's "Added" link into the series it was just
// added from. Without this, both would see an empty cache and kick off
// their own TVDB resolve+fetch, wasting a request and logging the fetch
// twice. Concurrent callers for the same series id instead share one
// in-flight fetch; whichever caller triggered it, the others just await the
// same promise and get the same result once it settles.
const episodeWarmInFlight = new Map(); // series id -> Promise<{episodes, source, error?}>
function resolveAndCacheEpisodesDeduped(series) {
  if (episodeWarmInFlight.has(series.id)) return episodeWarmInFlight.get(series.id);
  const promise = resolveAndCacheEpisodesForSeries(series).finally(() => episodeWarmInFlight.delete(series.id));
  episodeWarmInFlight.set(series.id, promise);
  return promise;
}

// Fire-and-forget: kicks off the same resolve+fetch+cache flow as visiting
// the series detail page, right when a series is added instead of waiting
// for someone to open it (see POST /api/series above). Not awaited by the
// POST handler — the response to the client goes out immediately either
// way; this just means the episode cache (and, transitively, the Calendar)
// is warm, or has already failed and logged why, by the time anyone gets
// around to looking.
function warmEpisodesInBackground(series) {
  resolveAndCacheEpisodesDeduped(series).catch((err) => {
    // resolveAndCacheEpisodesForSeries already catches its own errors and
    // returns instead of throwing, so this is just a safety net for
    // anything unexpected slipping through (e.g. a bug in the dedup
    // wrapper itself) rather than an expected path.
    logWarn('EpisodeService', `Background episode warm failed for "${series.title}": ${err.message}`);
  });
}

module.exports = { handleSeriesEpisodesApi, warmEpisodesInBackground, findExistingSeriesFolder };
