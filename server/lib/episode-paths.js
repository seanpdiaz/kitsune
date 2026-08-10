const path = require('path');

// ---------------------------------------------------------------------------
// Builds a plausible on-disk file path for an episode that got marked
// downloaded without a real file ever existing behind it — the simulated
// grab pipeline (server/routes/queue.js's completeDownload) and the initial
// "downloaded / total" backfill that runs the first time a series' episodes
// are cached (server/routes/episodes.js's backfillDownloadedState) both fall
// into this category, since neither one ever touches a real filesystem.
// Library Import (server/routes/import-files.js) is the one path in this app
// that DOES have a real file to point at — it uses the real scanned path
// directly instead of calling this at all.
//
// Follows the same "<root>/Series Title/Season N/Series Title - SxxExx -
// Episode Title [Quality].mkv" layout Sonarr itself defaults to, so a
// fabricated path at least looks like a real one would rather than being
// obviously fake. `series.path` (the root folder path set on the series,
// see server/routes/series.js) is used when it exists; a generic fallback
// covers series that were added without ever setting one, since that's a
// perfectly normal state for a mockup library and shouldn't leave the path
// blank.
// ---------------------------------------------------------------------------

// Windows/most filesystems' reserved path characters — stripped from the
// series/episode title before they're used as path segments, same idea as
// every other filename-building spot in this app (see e.g.
// server/lib/queue-sim.js's makeReleaseTitle, though that one's building a
// release title rather than a path and so doesn't need this).
function sanitizeForPath(text) {
  return String(text || '').replace(/[\\/:*?"<>|]/g, '').trim();
}

function buildEpisodeFilePath(series, episode, quality) {
  const seasonNumber = episode.seasonNumber ?? episode.season_number ?? 0;
  const num = episode.num;
  const code = `S${String(seasonNumber).padStart(2, '0')}E${String(num).padStart(2, '0')}`;
  const seasonFolder = seasonNumber === 0 ? 'Specials' : `Season ${seasonNumber}`;
  const seriesTitle = sanitizeForPath(series.title) || 'Unknown Series';
  const episodeTitle = sanitizeForPath(episode.title);
  const fileName = `${seriesTitle} - ${code}${episodeTitle ? ` - ${episodeTitle}` : ''} [${quality || 'Unknown'}].mkv`;
  const root = series.path || `/mnt/anime/${seriesTitle}`;
  return path.join(root, seasonFolder, fileName);
}

module.exports = { buildEpisodeFilePath };
