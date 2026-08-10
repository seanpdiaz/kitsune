const { db } = require('../db');

// Keeps a series' summary fields (`eps` — the "N / M downloaded" string the
// Library grid card and the generic episode-list fallback both parse — and
// `pct`, its progress ring) in sync with the real per-episode `downloaded`
// flags in the `episodes` table. Called any time those flags change: once
// when a series' episodes are first cached (see resolveAndCacheEpisodesForSeries
// in episodes.js, which backfills `downloaded` from whatever `eps` already
// said before any real per-episode data existed), and again every time a
// simulated download completes (see server/routes/queue.js).
//
// Lives in its own file rather than inside episodes.js or series.js: both of
// those already require each other (series.js needs episodes.js's
// warmEpisodesInBackground; episodes.js needs this), so a third file with no
// route-module dependencies of its own avoids turning that into a cycle.
function recomputeSeriesEpisodeStats(seriesId) {
  const row = db.prepare(`
    SELECT COUNT(*) AS total, COALESCE(SUM(downloaded), 0) AS done
    FROM episodes WHERE series_id = ?
  `).get(seriesId);
  if (!row || row.total === 0) return; // no cached episodes yet — leave eps/pct as whatever they were seeded with

  const pct = Math.round((row.done / row.total) * 100);
  db.prepare('UPDATE series SET eps = ?, pct = ? WHERE id = ?')
    .run(`${row.done} / ${row.total}`, pct, seriesId);
}

module.exports = { recomputeSeriesEpisodeStats };
