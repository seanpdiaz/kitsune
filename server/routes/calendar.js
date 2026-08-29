const db = require('../db');
const { sendJson } = require('../lib/http');

// ---------------------------------------------------------------------------
// /api/calendar — backs the Calendar page. Real air dates, straight from
// whatever's already sitting in the `episodes` table (see the Episode
// persistence section above) — no separate "calendar" data source of its
// own. That means it's only as complete as the episode cache is: a series
// whose detail page has never been opened has no cached episodes yet, so it
// has nothing to contribute here either. That's a deliberate scope decision
// (see README) rather than an oversight — proactively fetching episodes for
// every series in the Library just to populate a calendar would mean a
// TVDB round trip per series on every Calendar visit, which doesn't scale
// to a real library and isn't something this endpoint does silently.
// ---------------------------------------------------------------------------

async function handleCalendarApi(req, res, urlPath) {
  if (req.method !== 'GET' || urlPath !== '/api/calendar') return false;

  const params = new URL(req.url, 'http://localhost').searchParams;
  const isIsoDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
  let start = params.get('start');
  let end = params.get('end');

  // Default to the current calendar month (server's local time) when no
  // range is given, so hitting this with no query params still returns
  // something sensible instead of an error.
  if (!start || !isIsoDate(start) || !end || !isIsoDate(end)) {
    const now = new Date();
    const y = now.getFullYear();
    const m = now.getMonth();
    const pad = (n) => String(n).padStart(2, '0');
    start = `${y}-${pad(m + 1)}-01`;
    const nextMonth = new Date(y, m + 1, 1);
    end = `${nextMonth.getFullYear()}-${pad(nextMonth.getMonth() + 1)}-01`;
  }

  // `aired` is stored as TVDB's own "YYYY-MM-DD" text — comparing it as a
  // string works fine for a range filter since ISO dates sort correctly
  // lexicographically, same trick the Logs page's timestamp column relies on.
  const rows = await db.prepare(`
    SELECT e.series_id, e.season_number, e.season_name, e.num, e.title, e.aired,
           s.title AS series_title, s.poster AS series_poster
    FROM episodes e
    JOIN series s ON s.id = e.series_id
    WHERE e.aired IS NOT NULL AND e.aired >= ? AND e.aired < ?
    ORDER BY e.aired ASC
  `).all(start, end);

  const episodes = rows.map((r) => ({
    seriesId: r.series_id,
    seriesTitle: r.series_title,
    seriesPoster: r.series_poster,
    seasonNumber: r.season_number,
    seasonName: r.season_name,
    num: r.num,
    title: r.title,
    aired: r.aired,
  }));

  // How many series in the Library have *never* had their episodes fetched
  // at all (as opposed to having episodes that just don't fall in this date
  // range) — the frontend uses this to explain an empty-looking calendar
  // rather than leaving it looking broken or complete.
  const uncachedSeriesCount = (await db.prepare(`
    SELECT COUNT(*) AS n FROM series s
    WHERE NOT EXISTS (SELECT 1 FROM episodes e WHERE e.series_id = s.id)
  `).get()).n;

  sendJson(res, 200, { start, end, episodes, uncachedSeriesCount });
  return true;
}

module.exports = { handleCalendarApi };
