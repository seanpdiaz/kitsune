const { db } = require('../db');
const { logInfo, logWarn } = require('../logger');
const { sendJson } = require('../lib/http');
const { resolveTvdbEpisodeSourceId, fetchTvdbEpisodes } = require('../lib/tvdb');
const { pickRealisticQuality, pickRealisticSizeBytes, mulberry32 } = require('../lib/queue-sim');
const { recomputeSeriesEpisodeStats } = require('../lib/series-stats');
const { buildEpisodeFilePath } = require('../lib/episode-paths');

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

db.exec(`
  CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
let episodeColumns = db.prepare('PRAGMA table_info(episodes)').all().map((c) => c.name);
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
]) {
  if (!episodeColumns.includes(col)) {
    db.exec(`ALTER TABLE episodes ADD COLUMN ${col} ${def}`);
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
episodeColumns = db.prepare('PRAGMA table_info(episodes)').all().map((c) => c.name);
if (!episodeColumns.includes('season_number')) {
  logInfo('Database', 'Migrating episodes table: adding season tracking (rebuilding for corrected uniqueness constraint)');
  db.exec(`
    ALTER TABLE episodes RENAME TO episodes_old;
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    INSERT OR IGNORE INTO episodes (series_id, season_number, num, title, title_japanese, title_romanji, aired, score, filler, recap, url, downloaded, quality, size_bytes, path)
      SELECT series_id, 0, num, title, title_japanese, title_romanji, aired, score, filler, recap, url, downloaded, quality, size_bytes, path FROM episodes_old;
    DROP TABLE episodes_old;
  `);
}

// Actual fetching happens in resolveTvdbEpisodeSourceId/fetchTvdbEpisodes,
// defined near the rest of the TVDB client below (they need tvdbFetch/
// tvdbSearchAnimeOnly, which live there) — this just wires the endpoint up
// to them plus the episodes cache.
async function handleSeriesEpisodesApi(req, res, urlPath) {
  const match = req.method === 'GET' && urlPath.match(/^\/api\/series\/(\d+)\/episodes$/);
  if (!match) return false;

  const id = Number(match[1]);
  const series = db.prepare('SELECT * FROM series WHERE id = ?').get(id);
  if (!series) {
    sendJson(res, 404, { error: 'Series not found' });
    return true;
  }

  // Already fetched and cached — serve that instead of hitting TVDB again.
  // Ordered by season first so a flat consumer still gets specials before
  // season 1 before season 2, etc. — the frontend groups by season_number
  // itself for the actual tabbed view.
  const cachedRows = loadCachedEpisodes(id);
  if (cachedRows.length > 0) {
    sendJson(res, 200, { episodes: cachedRows, source: 'tvdb', cached: true });
    return true;
  }

  const result = await resolveAndCacheEpisodesDeduped(series);
  // Re-read from the DB rather than returning result.episodes directly: that
  // array is the raw TVDB-shaped response, before backfillDownloadedState
  // ran and before rows had real ids — going through the same DB read as
  // the cached branch above means both ever return the exact same shape
  // (id/downloaded/quality/sizeBytes included) regardless of whether this
  // request was the one that triggered the fetch or just arrived after it.
  const freshRows = loadCachedEpisodes(id);
  sendJson(res, 200, { episodes: freshRows, source: result.source, cached: false, ...(result.error ? { error: result.error } : {}) });
  return true;
}

function loadCachedEpisodes(seriesId) {
  const rows = db.prepare(`
    SELECT id, season_number, season_name, num, title, title_japanese, title_romanji, aired, score, filler, recap, url, downloaded, quality, size_bytes, path, overview
    FROM episodes WHERE series_id = ? ORDER BY season_number ASC, num ASC
  `).all(seriesId);
  return rows.map((r) => ({
    id: r.id, seasonNumber: r.season_number, seasonName: r.season_name, num: r.num, title: r.title,
    titleJapanese: r.title_japanese, titleRomanji: r.title_romanji,
    aired: r.aired, score: r.score, filler: !!r.filler, recap: !!r.recap, url: r.url,
    downloaded: !!r.downloaded, quality: r.quality, sizeBytes: r.size_bytes, path: r.path,
    overview: r.overview || null,
  }));
}

// The actual resolve → fetch → cache work, factored out of
// handleSeriesEpisodesApi above so the exact same flow can also run in the
// background right when a series is added (see warmEpisodesInBackground /
// POST /api/series below) instead of only on a visitor's first trip to the
// series detail page. Never throws — a failure here is logged and comes
// back as an empty episode list either way, since both callers treat "no
// episodes yet" as a normal, non-fatal outcome (the detail page just falls
// back to its synthetic "Episode N" list).
// The series detail page used to work out "downloaded / missing / not aired"
// per episode at render time — just this episode's position in the
// already-season-ordered list compared against the series' `eps` "N / M"
// summary string, recomputed fresh on every page load. That was fine as a
// display trick, but it meant there was no real, queryable per-episode
// "is this actually downloaded" fact anywhere — Wanted > Missing and the new
// grab pipeline both need one. This runs once, right after a series'
// episodes are first cached, and materializes that same position-based
// guess into real `episodes.downloaded`/`quality`/`size_bytes` rows instead
// of just a display-time calculation: the first N episodes (by season, then
// episode number — same order the frontend already sorted them in) become
// "downloaded" with a plausible quality/size, matching whatever `eps`
// already said before any real per-episode data existed. Everything after
// that point is real going forward — a simulated grab completing (see
// server/routes/queue.js) flips a specific episode's flag directly, it's
// never recomputed from position again.
function backfillDownloadedState(series) {
  const epMatch = /(\d+)\s*\/\s*(\d+)/.exec(series.eps || '');
  const downloadedCount = epMatch ? parseInt(epMatch[1], 10) : 0;
  if (downloadedCount <= 0) {
    recomputeSeriesEpisodeStats(series.id);
    return;
  }
  const rows = db.prepare(`
    SELECT id, season_number, num, title FROM episodes WHERE series_id = ? AND downloaded = 0 ORDER BY season_number ASC, num ASC LIMIT ?
  `).all(series.id, downloadedCount);
  const update = db.prepare('UPDATE episodes SET downloaded = 1, quality = ?, size_bytes = ?, path = ? WHERE id = ?');
  rows.forEach((row, i) => {
    const rand = mulberry32((series.id * 100003) ^ (i + 1));
    const quality = pickRealisticQuality(rand);
    const sizeBytes = pickRealisticSizeBytes(quality, rand);
    // No real file backed this "always was downloaded" backfill either —
    // same fabricated-but-plausible path as a simulated grab completing
    // (see server/lib/episode-paths.js's own comment for the full reasoning).
    const filePath = buildEpisodeFilePath(series, row, quality);
    update.run(quality, sizeBytes, filePath, row.id);
  });
  recomputeSeriesEpisodeStats(series.id);
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
        INSERT OR IGNORE INTO episodes (series_id, season_number, season_name, num, title, title_japanese, title_romanji, aired, score, filler, recap, url, overview)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const e of episodes) {
        insertEp.run(series.id, e.seasonNumber, e.seasonName, e.num, e.title, e.titleJapanese, e.titleRomanji, e.aired, e.score, e.filler ? 1 : 0, e.recap ? 1 : 0, e.url, e.overview || null);
      }
      logInfo('EpisodeService', `Fetched and cached ${episodes.length} episode(s) for "${series.title}" from TheTVDB`);
      backfillDownloadedState(series);
    }
    return { episodes, source: 'tvdb' };
  } catch (err) {
    logWarn('EpisodeService', `Episode fetch failed for "${series.title}": ${err.message}`);
    return { episodes: [], source: 'tvdb', error: err.message };
  }
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

module.exports = { handleSeriesEpisodesApi, warmEpisodesInBackground };
