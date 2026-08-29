const db = require('../db');

// Same "today, as an ISO date string" helper routes/wanted.js's own
// /api/wanted/missing already uses for the identical purpose (that
// endpoint's `aired <= today` cutoff, and this file's own) — kept as its
// own small copy here rather than a shared import, since it's a single
// three-line function neither file has any other reason to depend on the
// other for.
function todayIso() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

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
//
// Also excludes episodes with no `aired` date (TheTVDB's own placeholder for
// "we know this episode number exists in a future/unannounced season but
// don't have an air date for it yet" — see tvdb.js's `aired: e.aired ||
// null`) from the total, unless one's somehow already downloaded (a leaked
// release ahead of an official air date being set — still counts, since we
// obviously do have it). Otherwise a newly-revealed Season 2 with a single
// placeholder episode row and no air date yet permanently held an otherwise
// fully-downloaded series' progress bar below 100%, for a season that, per
// TVDB, doesn't really exist yet.
//
// Same reasoning extends to an episode with a real, known-future air date:
// it's not a missing/placeholder row, but it also hasn't aired yet, so
// there's nothing to have downloaded and it shouldn't read as "missing"
// either. Without this cutoff, a currently-airing series with next week's
// episode already confirmed on TVDB would count that episode against
// itself the moment the date is known, days before it actually airs —
// inflating both this series' own progress bar and the Library page's
// aggregate "Missing episodes" stat card (see LibraryGridPage.jsx's
// missingEpisodesCount, which sums this same eps field across series)
// ahead of what routes/wanted.js's /api/wanted/missing would actually list,
// since that endpoint already applies this identical `aired <= today` cutoff.
async function recomputeSeriesEpisodeStats(seriesId) {
  const series = await db.prepare('SELECT ignore_specials FROM series WHERE id = ?').get(seriesId);
  const ignoreSpecials = series && series.ignore_specials ? 1 : 0;
  const row = await db.prepare(`
    SELECT COUNT(*) AS total, COALESCE(SUM(downloaded), 0) AS done
    FROM episodes
    WHERE series_id = ?
      AND (? = 0 OR season_number > 0)
      AND (downloaded = 1 OR (aired IS NOT NULL AND aired <= ?))
  `).get(seriesId, ignoreSpecials, todayIso());
  if (!row || Number(row.total) === 0) return; // no cached (non-special, if ignored; aired-and-not-in-the-future, or downloaded) episodes yet — leave eps/pct as whatever they were seeded with

  const pct = Math.round((Number(row.done) / Number(row.total)) * 100);
  await db.prepare('UPDATE series SET eps = ?, pct = ? WHERE id = ?')
    .run(`${row.done} / ${row.total}`, pct, seriesId);
}

module.exports = { recomputeSeriesEpisodeStats };
