// ---------------------------------------------------------------------------
// POST /api/series/:id/import-files — the actual point of Library Import:
// taking a folder of real video files that's already matched to a Library
// series and marking the real episodes those files represent as downloaded,
// with their real quality (guessed from the filename) and real size (read
// straight off the file) — instead of either leaving them stuck showing as
// "missing" forever, or running them through the simulated grab pipeline
// (server/lib/queue-sim.js) for something that was never actually grabbed.
// ---------------------------------------------------------------------------
const { db } = require('../db');
const { logInfo, logWarn } = require('../logger');
const { sendJson, readJsonBody } = require('../lib/http');
const path = require('path');
const { walkVideoFiles, guessQualityTierName, guessSeasonEpisode } = require('../lib/media-files');
const { recomputeSeriesEpisodeStats } = require('../lib/series-stats');

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
  const folderPath = path.join(rootPath, folderName);
  if (!folderPath.startsWith(rootPath)) {
    sendJson(res, 400, { error: 'Invalid folder name' });
    return true;
  }

  const files = walkVideoFiles(folderPath);
  if (files.length === 0) {
    sendJson(res, 200, { matched: [], unmatched: [], seriesEps: series.eps, message: 'No video files found in that folder.' });
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
      seriesEps: series.eps,
    });
    return true;
  }

  // Season 0 is specials/OVAs (TVDB's convention — same one this app's own
  // episode cache uses), not a second real season — a series with a
  // "Season 1" and a handful of specials is still, for numbering purposes,
  // a single-season show. Counting season 0 as if it were a second season
  // here was the bug: a folder with 12 plainly-numbered episodes plus one
  // OVA (specials, season 0) has two *distinct* season_numbers in its
  // episode list, but there's nothing actually ambiguous about which real
  // season "- 05 -" belongs to — there's only one. Excluding specials from
  // this count is what makes that case resolve instead of every plain
  // numbered file getting rejected as ambiguous alongside the OVA (which
  // correctly stays unmatched regardless, since it has no episode number to
  // guess in the first place).
  const distinctRealSeasons = [...new Set(episodeRows.filter((e) => e.season_number !== 0).map((e) => e.season_number))];
  const singleSeasonFallback = distinctRealSeasons.length === 1 ? distinctRealSeasons[0] : null;

  const episodeByKey = new Map(episodeRows.map((e) => [`${e.season_number}:${e.num}`, e]));
  const updateStmt = db.prepare('UPDATE episodes SET downloaded = 1, quality = ?, size_bytes = ?, path = ? WHERE id = ?');

  const matched = [];
  const unmatched = [];

  for (const file of files) {
    const guess = guessSeasonEpisode(file.name, file.seasonHint);
    const season = guess.season ?? singleSeasonFallback;

    if (guess.episode == null) {
      unmatched.push({ fileName: file.name, reason: "Couldn't find an episode number in this filename." });
      continue;
    }
    if (season == null) {
      unmatched.push({ fileName: file.name, reason: 'This series has multiple seasons and the filename/folder gave no way to tell which one this episode belongs to.' });
      continue;
    }

    const episode = episodeByKey.get(`${season}:${guess.episode}`);
    if (!episode) {
      unmatched.push({ fileName: file.name, reason: `No season ${season}, episode ${guess.episode} in this series' episode list.` });
      continue;
    }

    const quality = guessQualityTierName(file.name);
    // The one path in the app where this is a REAL file path, not a
    // fabricated one (see server/lib/episode-paths.js for the fabricated
    // case, used by the simulated grab pipeline and the initial downloaded-
    // state backfill instead) — file.relativePath is relative to folderPath,
    // which was just walked on the real filesystem above.
    const filePath = path.join(folderPath, file.relativePath);
    updateStmt.run(quality, file.sizeBytes, filePath, episode.id);
    matched.push({
      fileName: file.name, episodeId: episode.id, season, episode: guess.episode,
      quality, sizeBytes: file.sizeBytes, path: filePath, alreadyWasDownloaded: !!episode.downloaded,
    });
  }

  recomputeSeriesEpisodeStats(seriesId);
  const updated = db.prepare('SELECT eps, pct FROM series WHERE id = ?').get(seriesId);

  logInfo('LibraryImport', `Imported files for "${series.title}": ${matched.length} matched, ${unmatched.length} unmatched (from "${folderPath}")`);
  if (unmatched.length > 0) {
    logWarn('LibraryImport', `${unmatched.length} file(s) in "${folderPath}" couldn't be matched to an episode of "${series.title}"`);
  }

  sendJson(res, 200, { matched, unmatched, seriesEps: updated.eps, seriesPct: updated.pct });
  return true;
}

module.exports = { handleImportFilesApi };
