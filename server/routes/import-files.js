// ---------------------------------------------------------------------------
// POST /api/series/:id/import-files — the actual point of Library Import:
// taking a folder of real video files that's already matched to a Library
// series and marking the real episodes those files represent as downloaded,
// with their real quality (guessed from the filename) and real size (read
// straight off the file) — instead of either leaving them stuck showing as
// "missing" forever, or running them through the simulated grab pipeline
// (server/lib/queue-sim.js) for something that was never actually grabbed.
//
// A real import here is treated as the authoritative answer for this series,
// not just an addition to it: any episode that isn't matched by a real file
// in this scan gets reset back to not-downloaded (see the reset pass at the
// bottom), even if it was previously marked downloaded by the simulated
// backfill (episodes.js's backfillDownloadedState) or the simulated grab
// pipeline (queue.js's completeDownload). Both of those mark episodes
// downloaded without ever checking a real filesystem — running a real
// import against a series' actual folder is exactly the moment this app can
// finally tell the difference, and a stat card (or the Wanted list) still
// showing a fabricated "downloaded" for a file that was never really there
// would be a worse bug than the one this exists to fix. This does assume
// one folder = the complete real picture for that series, matching this
// app's one-root-folder-per-series convention (see server/lib/episode-
// paths.js) — a library that genuinely splits a single series across two
// separately-imported folders (e.g. specials scanned from a different path
// than the main season) isn't a case this reconciliation handles correctly,
// since the second import wouldn't know about files the first one matched.
// ---------------------------------------------------------------------------
const { db } = require('../db');
const { logInfo, logWarn } = require('../logger');
const { sendJson, readJsonBody } = require('../lib/http');
const fs = require('fs');
const path = require('path');
const { walkVideoFiles, guessQualityTierName, guessSeasonEpisode, resolutionGroupFromHeight } = require('../lib/media-files');
const { recomputeSeriesEpisodeStats } = require('../lib/series-stats');
const { probeMediaStreams } = require('../lib/ffprobe');
const { findExistingSeriesFolder } = require('./episodes');

async function handleImportFilesApi(req, res, urlPath) {
  const match = req.method === 'POST' && urlPath.match(/^\/api\/series\/(\d+)\/import-files$/);
  if (!match) return false;

  const seriesId = Number(match[1]);
  const series = db.prepare('SELECT * FROM series WHERE id = ?').get(seriesId);
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

  // Two ways to reach this route: Library Import's per-row "Import files"
  // button, which is scanning a folder that isn't necessarily "this series'
  // folder" yet (rootFolderId + folderName identify exactly which real
  // subfolder it just showed you, before that relationship is assumed) —
  // and the series detail page's "Rescan for local files" button
  // (SeriesPage.jsx), which already knows exactly where this series' files
  // live via its own real, server-set series.path (see routes/series.js's
  // defaultSeriesPathFor/routes/episodes.js's scanExistingFilesForSeries —
  // both the only things that ever set it now) and has no reason to make
  // the caller re-derive a rootFolderId/folderName pair from it. When the
  // body omits both, fall back to series.path directly instead of requiring
  // every caller to know the root-folder-relative decomposition.
  let folderPath;
  if (body.rootFolderId !== undefined || body.folderName !== undefined) {
    const rootFolderId = Number(body.rootFolderId);
    const folderName = String(body.folderName || '');
    if (!rootFolderId || !folderName) {
      sendJson(res, 400, { error: 'rootFolderId and folderName are required' });
      return true;
    }
    const rootRow = db.prepare("SELECT * FROM settings_items WHERE id = ? AND section = 'root-folders'").get(rootFolderId);
    if (!rootRow) {
      sendJson(res, 404, { error: 'Root folder not found' });
      return true;
    }
    const rootPath = JSON.parse(rootRow.data).path;
    folderPath = path.join(rootPath, folderName);
    if (!folderPath.startsWith(rootPath)) {
      sendJson(res, 400, { error: 'Invalid folder name' });
      return true;
    }
  } else {
    folderPath = series.path;
    // A set series.path isn't necessarily a *real* one — defaultSeriesPathFor
    // (routes/series.js) fabricates one from the title the moment a series
    // is added, without ever checking the real filesystem, so most series
    // reach here with a non-null path that may never have pointed at
    // anything. Treat an existing-but-missing path the same as no path at
    // all: worth a fresh real-folder lookup rather than reporting "doesn't
    // exist on disk yet" for what might just be a bad guess from add time.
    if (folderPath && !fs.existsSync(folderPath)) folderPath = null;
    if (!folderPath) {
      // Reaching here with no real path yet is a real, common gap, not
      // just "no root folder configured" (the message this used to always
      // show, even when one genuinely was). Try the same real-folder lookup
      // scanExistingFilesForSeries uses before giving up, and remember it
      // here the same way that scan would have — so this only ever needs
      // resolving once per series, not every time Rescan is clicked.
      folderPath = findExistingSeriesFolder(series);
      if (folderPath) {
        db.prepare('UPDATE series SET path = ? WHERE id = ?').run(folderPath, seriesId);
        logInfo('LibraryImport', `Rescan found and set a path for "${series.title}": "${folderPath}" (none was set)`);
      }
    }
    if (!folderPath) {
      const hasRootFolders = db.prepare("SELECT COUNT(*) AS n FROM settings_items WHERE section = 'root-folders'").get().n > 0;
      sendJson(res, 400, {
        error: hasRootFolders
          // Title/alt-title matching can only ever find a folder whose name
          // resembles a name Kitsune actually knows — a folder using a
          // purely informal/regional name with no relation to any of them
          // (e.g. "Chainsmoker Cat" on disk for a series Kitsune shows as
          // "Yani Neko") can never be found this way, no matter how good the
          // matching gets. Point at the real fix instead of just asking to
          // "try again": add it as an alternate title (if it's a real
          // alternate name) or set the folder manually.
          ? `Couldn't find a folder matching "${series.title}" (or its alternate titles) in any configured root folder. If the real folder uses a different name, open Edit Series and set its Path manually.`
          : 'No path set for this series yet — add a root folder in Settings > Media Management first.',
      });
      return true;
    }
  }

  // A stale/never-real series.path (no root folder configured when the
  // series was added, or the folder genuinely hasn't been created on disk
  // yet) is a meaningfully different outcome from "real folder, just empty
  // right now" — worth telling apart now that this route can be reached
  // from a real path instead of only ever a folder Library Import's own
  // scan had just confirmed exists.
  if (!fs.existsSync(folderPath)) {
    sendJson(res, 200, { matched: [], unmatched: [], seriesEps: series.eps, seriesPath: folderPath, message: `"${folderPath}" doesn't exist on disk yet.` });
    return true;
  }

  const files = walkVideoFiles(folderPath);
  if (files.length === 0) {
    sendJson(res, 200, { matched: [], unmatched: [], seriesEps: series.eps, seriesPath: folderPath, message: 'No video files found in that folder.' });
    return true;
  }

  const episodeRows = db.prepare('SELECT id, season_number, num, downloaded FROM episodes WHERE series_id = ?').all(seriesId);
  if (episodeRows.length === 0) {
    // Nothing to match against yet — this series' episode list hasn't been
    // fetched/cached (see episodes.js). Rather than silently matching
    // nothing, tell the caller why: the frontend can point the user at the
    // series page (which triggers that fetch) instead of just showing an
    // empty result.
    sendJson(res, 200, {
      matched: [], unmatched: files.map((f) => ({ fileName: f.name, reason: "This series' episode list hasn't loaded yet — open its series page once, then try importing again." })),
      seriesEps: series.eps, seriesPath: folderPath,
    });
    return true;
  }

  const episodeByKey = new Map(episodeRows.map((e) => [`${e.season_number}:${e.num}`, e]));
  const updateStmt = db.prepare('UPDATE episodes SET downloaded = 1, quality = ?, size_bytes = ?, path = ?, media_streams = ? WHERE id = ?');

  const matched = [];
  const unmatched = [];
  const matchedEpisodeIds = new Set();

  for (const file of files) {
    const guess = guessSeasonEpisode(file.name, file.seasonHint);

    if (guess.episode == null) {
      unmatched.push({ fileName: file.name, reason: "Couldn't find an episode number in this filename." });
      continue;
    }

    // No "Season N" ancestor folder and no SxxExx tag in the filename itself
    // — assume season 1 rather than leaving it unmatched. Covers both a
    // genuinely single-season series and the very common case of a
    // multi-season series whose files just all sit flat in the root with no
    // per-season subfolders at all. A file that DOES carry a real season
    // signal (folder or tag) still uses that instead — this only fills in
    // when there's no signal whatsoever. Tradeoff: a file that's actually a
    // later season sitting loose in the root (instead of its own "Season N"
    // folder) can match the wrong episode here — favors matching by default
    // for the common flat-folder layout over leaving Downloaded stuck at 0.
    const season = guess.season ?? 1;
    const assumedSeason = guess.season == null;

    const episode = episodeByKey.get(`${season}:${guess.episode}`);
    if (!episode) {
      unmatched.push({ fileName: file.name, reason: `No season ${season}, episode ${guess.episode} in this series' episode list.` });
      continue;
    }

    // The one path in the app where this is a REAL file path, not a
    // fabricated one (see server/lib/episode-paths.js for the fabricated
    // case, used by the simulated grab pipeline and the initial downloaded-
    // state backfill instead) — file.relativePath is relative to folderPath,
    // which was just walked on the real filesystem above.
    const filePath = path.join(folderPath, file.relativePath);
    // Probed BEFORE the quality guess below, not after — real per-file
    // audio/subtitle tracks plus the real video stream's own width/height
    // (see lib/ffprobe.js) — null when ffprobe isn't installed or the probe
    // fails, same "unknown, not a guess" treatment as everything else this
    // route couldn't confirm. A confirmed real resolution overrides
    // whatever (if anything) the filename itself claims — see
    // guessQualityTierName's own comment for why a probe beats a text tag.
    const streams = probeMediaStreams(filePath);
    const probedResolutionGroup = streams && streams.video ? resolutionGroupFromHeight(streams.video.height) : null;
    const quality = guessQualityTierName(file.name, probedResolutionGroup);
    updateStmt.run(quality, file.sizeBytes, filePath, streams ? JSON.stringify(streams) : null, episode.id);
    matchedEpisodeIds.add(episode.id);
    matched.push({
      fileName: file.name, episodeId: episode.id, season, episode: guess.episode,
      quality, resolutionConfirmed: !!probedResolutionGroup, sizeBytes: file.sizeBytes, path: filePath,
      alreadyWasDownloaded: !!episode.downloaded, assumedSeason, mediaStreams: streams,
    });
  }

  // Reconcile: anything this series' episode list still says is downloaded
  // but that this scan didn't just (re)confirm with a real file gets reset —
  // see the comment at the top of this file for why. Only rows that were
  // actually `downloaded` need touching; nothing to reset for one that was
  // already 0.
  const resetStmt = db.prepare('UPDATE episodes SET downloaded = 0, quality = NULL, size_bytes = NULL, path = NULL WHERE id = ?');
  const reset = [];
  for (const ep of episodeRows) {
    if (ep.downloaded && !matchedEpisodeIds.has(ep.id)) {
      resetStmt.run(ep.id);
      reset.push({ episodeId: ep.id, season: ep.season_number, episode: ep.num });
    }
  }

  recomputeSeriesEpisodeStats(seriesId);
  const updated = db.prepare('SELECT eps, pct FROM series WHERE id = ?').get(seriesId);

  logInfo('LibraryImport', `Imported files for "${series.title}": ${matched.length} matched, ${unmatched.length} unmatched, ${reset.length} reset to not-downloaded (from "${folderPath}")`);
  if (unmatched.length > 0) {
    logWarn('LibraryImport', `${unmatched.length} file(s) in "${folderPath}" couldn't be matched to an episode of "${series.title}"`);
  }
  // Only worth calling out when the assumption was actually doing something
  // — a single-season series matching everything into season 1 is just the
  // normal case, not a decision worth a log line.
  const assumedCount = matched.filter((m) => m.assumedSeason).length;
  const distinctRealSeasons = [...new Set(episodeRows.filter((e) => e.season_number !== 0).map((e) => e.season_number))];
  if (assumedCount > 0 && distinctRealSeasons.length > 1) {
    logInfo('LibraryImport', `"${series.title}": ${assumedCount} file(s) in "${folderPath}" had no season subfolder/tag — assumed season 1. This series has ${distinctRealSeasons.length} real seasons; move anything that's actually a later season into its own "Season N" subfolder (or rename with an SxxExx tag) and re-import if any of these matched wrong.`);
  }

  sendJson(res, 200, { matched, unmatched, reset, seriesEps: updated.eps, seriesPct: updated.pct, seriesPath: folderPath });
  return true;
}

module.exports = { handleImportFilesApi };
