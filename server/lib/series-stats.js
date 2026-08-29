const db = require('../db');

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
//
// Respects the Edit Series modal's Ignore Specials toggle (series.
// ignore_specials — see routes/series.js) by looking it up fresh on every
// call rather than taking it as a parameter: every existing caller (a real
// import completing, a file being deleted, episodes first getting cached)
// already just passes a seriesId, and none of them know or care about this
// setting — baking the lookup in here means flipping the toggle only ever
// needs to touch routes/series.js's PATCH handler (which calls this
// immediately after saving it, so the progress bar updates without waiting
// for the next download/delete) rather than threading a new argument through
// every call site. Specials (season_number = 0) are excluded from both the
// total and the done count when it's on, so missing/un-downloaded specials
// can no longer keep an otherwise-complete series' progress bar short of
// 100% — the Specials tab itself is untouched by this; it still renders
// every cached special either way (see SeriesPage.jsx's groupEpisodesBySeason).
async function recomputeSeriesEpisodeStats(seriesId) {
  const series = await db.prepare('SELECT ignore_specials FROM series WHERE id = ?').get(seriesId);
  const ignoreSpecials = series && series.ignore_specials ? 1 : 0;
  const row = await db.prepare(`
    SELECT COUNT(*) AS total, COALESCE(SUM(downloaded), 0) AS done
    FROM episodes WHERE series_id = ? AND (? = 0 OR season_number > 0)
  `).get(seriesId, ignoreSpecials);
  if (!row || Number(row.total) === 0) return; // no cached (non-special, if ignored) episodes yet — leave eps/pct as whatever they were seeded with

  const pct = Math.round((Number(row.done) / Number(row.total)) * 100);
  await db.prepare('UPDATE series SET eps = ?, pct = ? WHERE id = ?')
    .run(`${row.done} / ${row.total}`, pct, seriesId);
}

module.exports = { recomputeSeriesEpisodeStats };
