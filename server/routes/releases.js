// ---------------------------------------------------------------------------
// /api/releases — what backs the "Search" button on Wanted > Missing/Cutoff
// Unmet and the series detail page (per-episode), plus Search Season / the
// series detail page's "Search all" button (batch — a whole season or an
// entire series in one torrent, the normal way a finished show gets
// distributed once a fansub group wraps it up). Always real: at least one of
// Settings > Indexers' real indexer types (Nyaa.si direct — server/lib/
// nyaa-search.js — and/or Prowlarr — server/lib/prowlarr-search.js, an
// aggregator that can proxy Nyaa.si plus whatever other trackers a user has
// configured there) has to be enabled, or this returns an empty result with
// a notice saying so — same as real Sonarr with no indexers configured,
// rather than fabricating fake candidates to fall back on.
//
// Both, one, or neither can be enabled at once — see searchRealIndexers
// below, which runs every enabled real indexer in parallel and merges their
// results (deduped by infoHash/magnetUrl, since Prowlarr proxying Nyaa.si
// itself alongside the direct Nyaa.si integration could easily return the
// exact same release twice). One real indexer erroring while another
// succeeds still shows real results, just from whichever indexer(s)
// actually answered; only every enabled indexer failing turns into an empty
// result + notice.
//
// Three scopes, chosen by query params:
//   ?episodeId=N                         — one episode (default scope, the
//                                           only shape that existed before
//                                           batch search)
//   ?scope=season&seriesId=N&seasonNumber=N — one season, batch releases only
//   ?scope=series&seriesId=N             — the whole series, batch releases only
//
// A live search isn't repeatable the way a deterministic fake candidate list
// would be — a second live query moments later could return different
// results/order — so GET here caches the exact sorted list it just
// returned, keyed by scope (buildReleaseCacheKey, also used by
// routes/queue.js to look the same entry back up); POST /api/queue's
// `releaseIndex` reads the grabbed release back out of that cache instead of
// re-searching.
// ---------------------------------------------------------------------------
const db = require('../db');
const { sendJson } = require('../lib/http');
const { logWarn } = require('../logger');
const { getQualityProfile, rankReleaseCandidates } = require('../lib/quality');
const nyaaSearch = require('../lib/nyaa-search');
const prowlarrSearch = require('../lib/prowlarr-search');

// 10 minutes — long enough to open the release picker, read through the
// list, and click Grab without the cache expiring out from under a normal
// browsing pace, short enough that a long-abandoned tab doesn't grab
// something wildly stale. A fresh GET (searching again) simply overwrites
// the previous entry for that same key.
const CACHE_TTL_MS = 10 * 60 * 1000;
const lastSearchCache = new Map(); // cacheKey -> { releases, expiresAt }

function cacheReleases(cacheKey, releases) {
  lastSearchCache.set(cacheKey, { releases, expiresAt: Date.now() + CACHE_TTL_MS });
}

// Exported for routes/queue.js — POST /api/queue's only source of truth for
// "what did releaseIndex actually mean," real or simulated, episode or
// batch alike.
function getCachedRelease(cacheKey, index) {
  const entry = lastSearchCache.get(cacheKey);
  if (!entry || entry.expiresAt < Date.now()) return null;
  return entry.releases[index] || null;
}

// Shared with routes/queue.js so both sides always agree on what a given
// scope's cache key looks like without duplicating the format in two files.
function buildReleaseCacheKey({ scope, episodeId, seriesId, seasonNumber }) {
  if (scope === 'season') return `season:${seriesId}:${seasonNumber}`;
  if (scope === 'series') return `series:${seriesId}`;
  return `episode:${episodeId}`;
}

// Every enabled real indexer row, normalized to { type, config } — 'nyaa'
// needs no config (nyaa-search.js's functions take none), 'prowlarr' needs
// { baseUrl, apiKey }. A Prowlarr row missing either field is treated as not
// really configured yet (same as leaving it disabled) rather than sending a
// request that can only fail.
async function enabledRealIndexers() {
  const rows = await db.prepare("SELECT data FROM settings_items WHERE section = 'indexers'").all();
  const indexers = [];
  for (const row of rows) {
    const data = JSON.parse(row.data);
    if (!data.enabled) continue;
    if (data.type === 'nyaa') indexers.push({ type: 'nyaa' });
    else if (data.type === 'prowlarr' && data.baseUrl && data.apiKey) {
      indexers.push({ type: 'prowlarr', config: { baseUrl: data.baseUrl, apiKey: data.apiKey, allowInsecureSsl: data.allowInsecureSsl } });
    }
  }
  return indexers;
}

// Same release object shape from every real indexer (see nyaa-search.js's
// and prowlarr-search.js's own toReleaseCandidates), so a release that
// happens to come back from two sources at once — most plausibly Prowlarr
// proxying the very same Nyaa.si tracker the direct integration also
// queries — is genuinely the same torrent, not a coincidence. Deduped by
// infoHash first (the real, stable identity of a torrent), falling back to
// magnetUrl for the rare release with no parsed infoHash; the higher-seeder
// copy wins, since Prowlarr and Nyaa.si's own direct RSS can report slightly
// different seeder counts for the same torrent depending on when each was
// fetched.
function dedupeReleases(releases) {
  const seen = new Map();
  for (const r of releases) {
    const key = r.infoHash || r.magnetUrl;
    if (!key) continue;
    const existing = seen.get(key);
    if (!existing || r.seeders > existing.seeders) seen.set(key, r);
  }
  return [...seen.values()];
}

const MERGED_CANDIDATE_LIMIT = 8;

// `profile` — the series' Quality Profile (server/lib/quality.js's
// getQualityProfile, or null) — ranks the merged multi-indexer list the same
// way each individual indexer's own toReleaseCandidates already ranked its
// own results before this merge (see nyaa-search.js's comment on why this
// has to happen at every sort/slice point, not just here). Nothing is ever
// excluded for being outside the profile — see quality.js's
// rankReleaseCandidates for the full reasoning.
async function sortAndLimitReleases(releases, profile) {
  return (await rankReleaseCandidates(releases, { profile })).slice(0, MERGED_CANDIDATE_LIMIT);
}

// Runs every enabled real indexer's search (in parallel) for either a single
// episode or a batch scope, merges + dedupes + re-sorts the results, and
// reports which indexers actually failed. Only `ok: false` (which triggers
// the simulated fallback at the call site) when EVERY enabled indexer
// errored — one indexer failing while another succeeds still returns real
// results from whichever one(s) came back, same principle as a single
// flaky indexer not being allowed to take down the whole Search button.
async function searchRealIndexers(indexers, { series, episode, extraQueryTerm, profile, seasonNumber }) {
  const isBatch = !episode;
  const outcomes = await Promise.all(indexers.map(async (idx) => {
    try {
      const result = idx.type === 'nyaa'
        ? (isBatch ? await nyaaSearch.searchBatchReleases(series, { extraQueryTerm, profile, seasonNumber }) : await nyaaSearch.searchReleasesForEpisode(series, episode, profile))
        : (isBatch ? await prowlarrSearch.searchBatchReleases(idx.config, series, { extraQueryTerm, profile, seasonNumber }) : await prowlarrSearch.searchReleasesForEpisode(idx.config, series, episode, profile));
      return { type: idx.type, ...result };
    } catch (err) {
      return { type: idx.type, ok: false, error: err.message };
    }
  }));

  const succeeded = outcomes.filter((o) => o.ok);
  const failed = outcomes.filter((o) => !o.ok);
  if (succeeded.length === 0) {
    // Every enabled real indexer failed — report the first error verbatim
    // (same single-error shape callers already expect) rather than a
    // muddled combined message.
    return { ok: false, error: failed[0]?.error || 'All enabled real indexers failed.' };
  }
  const merged = await sortAndLimitReleases(dedupeReleases(succeeded.flatMap((o) => o.releases)), profile);
  return {
    ok: true,
    releases: merged,
    // Surfaced to the user only when at least one indexer worked but
    // another didn't, so a fully-working setup stays silent about it.
    partialError: failed.length > 0 ? failed.map((f) => `${f.type === 'nyaa' ? 'Nyaa.si' : 'Prowlarr'}: ${f.error}`).join('; ') : null,
  };
}

// Season 0 is always "Specials" regardless of season_name, same convention
// SeriesPage.jsx's own segmentLabel() already hardcodes — kept in sync here
// rather than trusting the client to send a display label.
function seasonLabel(seasonNumber, seasonName) {
  if (seasonNumber === 0) return 'Specials';
  return seasonName || `Season ${seasonNumber}`;
}

// The episodes a batch grab of this scope would actually target — aired,
// not already downloaded. Whether a real batch release's own title claims a
// specific range isn't trusted (see nyaa-search.js's isBatchRelease
// comment); this is what actually decides which episodes a grab covers —
// which is exactly why the whole-series scope excludes Specials (see
// below): with no per-release episode-range parsing, insertBatchGrab (see
// routes/queue.js) blindly attaches EVERY episode this returns to the ONE
// torrent a batch search found, trusting that torrent to actually contain
// all of them.
//
// Real, confirmed bug: a whole-series "Grab best match" found a release
// plainly titled "[Season 1] ... (Batch)" — 12 files — but the whole-series
// scope's own target list included this series' 12 Specials too (season 0
// episodes are aired and not-downloaded same as any other), so all 24
// target episodes got queued against that one 12-file torrent. The 12
// Season 1 rows matched real files and imported fine; the 12 Specials rows
// had no real file to match (pickFileForEpisode correctly found nothing —
// see its own comment) but completeRealDownload still marks an episode
// downloaded, with a placeholder path, even when nothing was actually
// matched — so those 12 Specials would have silently ended up "Available"
// in the Library with no real file behind them at all, the exact kind of
// fabricated state this app's real-vs-simulated data rule exists to
// prevent. A real complete-series batch release essentially never bundles
// OVA/Special episodes in with the main numbered seasons the way a
// same-season batch does, so the whole-series scope no longer assumes it —
// Specials still grab normally through their own explicit season-0 scope
// (SeriesPage's Specials tab has the exact same Search Season/Grab best
// match/Edit tracks controls every other season tab does), just never as
// part of "the whole series" implicitly.
async function targetEpisodesForScope(seriesId, seasonNumber) {
  // date('now') was SQLite-specific; today's date as a plain "YYYY-MM-DD"
  // parameter compares the same way against the TEXT `aired` column on
  // both dialects.
  const today = db.now().slice(0, 10);
  if (seasonNumber != null) {
    return db.prepare(`
      SELECT * FROM episodes WHERE series_id = ? AND season_number = ? AND downloaded = 0 AND aired IS NOT NULL AND aired <= ?
      ORDER BY num ASC
    `).all(seriesId, seasonNumber, today);
  }
  return db.prepare(`
    SELECT * FROM episodes WHERE series_id = ? AND season_number > 0 AND downloaded = 0 AND aired IS NOT NULL AND aired <= ?
    ORDER BY season_number ASC, num ASC
  `).all(seriesId, today);
}

// The real search work behind both scopes, factored out of the route
// handler so routes/queue.js's "Grab best match" (see its own module header)
// can run the exact same real-indexer-then-simulated-fallback-then-profile-
// ranking logic GET /api/releases already does, without either duplicating
// it or routing an internal server action through an HTTP self-call. Both
// return { releases, notice, profile } — `releases` already ranked
// best-match-first by rankReleaseCandidates, so `releases[0]` (when
// non-empty) *is* "the best match" for a caller that wants one pick instead
// of the whole list.
async function searchForEpisode(series, episodeArg) {
  const profile = await getQualityProfile(series.quality_profile);
  const indexers = await enabledRealIndexers();
  let releases = [];
  let notice = null;
  if (indexers.length === 0) {
    notice = 'No indexers enabled — enable one in Settings > Indexers to search.';
  } else {
    const result = await searchRealIndexers(indexers, { series, episode: episodeArg, profile });
    if (result.ok) {
      releases = result.releases;
      if (result.partialError) notice = `Some indexers failed (${result.partialError}) — showing results from the rest.`;
    } else {
      logWarn('IndexerService', `Search failed for episode ${episodeArg.id}: ${result.error}`);
      notice = `Search failed: ${result.error}`;
    }
  }
  return { releases, notice, profile };
}

async function searchForBatchScope(series, seasonNumber, { extraQueryTerm, episodeCount } = {}) {
  const profile = await getQualityProfile(series.quality_profile);
  const indexers = await enabledRealIndexers();
  let releases = [];
  let notice = null;
  if (indexers.length === 0) {
    notice = 'No indexers enabled — enable one in Settings > Indexers to search.';
  } else {
    // seasonNumber is null for a whole-series "Search All" (scopeParam ===
    // 'series' below never sets it) and a real season number for a single
    // season's own Search Season/Grab best match — passed through so a
    // same-show batch for a *different* season (a real, confirmed miss —
    // see nyaa-search.js's releaseCoversSeason) doesn't get treated as a
    // match here just because it's some kind of batch for this show.
    const result = await searchRealIndexers(indexers, { series, extraQueryTerm, profile, seasonNumber });
    if (result.ok) {
      releases = result.releases;
      if (result.partialError) notice = `Some indexers failed (${result.partialError}) — showing results from the rest.`;
    } else {
      logWarn('IndexerService', `Batch search failed for series ${series.id}: ${result.error}`);
      notice = `Search failed: ${result.error}`;
    }
  }
  return { releases, notice, profile };
}

async function handleReleasesApi(req, res, urlPath) {
  if (req.method !== 'GET' || urlPath !== '/api/releases') return false;

  const url = new URL(req.url, 'http://localhost');
  const scopeParam = url.searchParams.get('scope');

  // --- Season / series batch scope ---------------------------------------
  if (scopeParam === 'season' || scopeParam === 'series') {
    const seriesId = Number(url.searchParams.get('seriesId'));
    const seasonNumber = scopeParam === 'season' ? Number(url.searchParams.get('seasonNumber')) : null;
    if (!Number.isInteger(seriesId) || (scopeParam === 'season' && !Number.isInteger(seasonNumber))) {
      sendJson(res, 400, { error: 'seriesId (and seasonNumber, for a season search) are required' });
      return true;
    }
    const series = await db.prepare('SELECT * FROM series WHERE id = ?').get(seriesId);
    if (!series) {
      sendJson(res, 404, { error: 'Series not found' });
      return true;
    }
    if (scopeParam === 'season') {
      const seasonExists = await db.prepare('SELECT 1 FROM episodes WHERE series_id = ? AND season_number = ? LIMIT 1').get(seriesId, seasonNumber);
      if (!seasonExists) {
        sendJson(res, 404, { error: 'Season not found' });
        return true;
      }
    }

    const targetEpisodes = await targetEpisodesForScope(seriesId, seasonNumber);
    const episodeCount = targetEpisodes.length;
    const seasonNameRow = scopeParam === 'season'
      ? await db.prepare('SELECT season_name FROM episodes WHERE series_id = ? AND season_number = ? AND season_name IS NOT NULL LIMIT 1').get(seriesId, seasonNumber)
      : null;
    const targetLabel = scopeParam === 'season' ? seasonLabel(seasonNumber, seasonNameRow && seasonNameRow.season_name) : series.title;
    const extraQueryTerm = seasonNameRow && seasonNameRow.season_name ? seasonNameRow.season_name : null;

    const { releases, notice } = await searchForBatchScope(series, seasonNumber, { extraQueryTerm, episodeCount });

    const cacheKey = buildReleaseCacheKey({ scope: scopeParam, seriesId, seasonNumber });
    cacheReleases(cacheKey, releases);
    sendJson(res, 200, { releases, notice, episodeCount, targetLabel });
    return true;
  }

  // --- Single episode scope (default, unchanged) --------------------------
  const episodeId = Number(url.searchParams.get('episodeId'));
  if (!Number.isInteger(episodeId)) {
    sendJson(res, 400, { error: 'episodeId is required' });
    return true;
  }

  const episode = await db.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId);
  if (!episode) {
    sendJson(res, 404, { error: 'Episode not found' });
    return true;
  }
  const series = await db.prepare('SELECT * FROM series WHERE id = ?').get(episode.series_id);
  if (!series) {
    sendJson(res, 404, { error: 'Series not found' });
    return true;
  }
  const episodeArg = { id: episode.id, num: episode.num, seasonNumber: episode.season_number };

  const { releases, notice } = await searchForEpisode(series, episodeArg);

  cacheReleases(buildReleaseCacheKey({ scope: 'episode', episodeId }), releases);
  sendJson(res, 200, { releases, notice });
  return true;
}

module.exports = {
  handleReleasesApi, getCachedRelease, buildReleaseCacheKey, targetEpisodesForScope,
  searchForEpisode, searchForBatchScope, seasonLabel,
};
