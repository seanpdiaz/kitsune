// ---------------------------------------------------------------------------
// TheTVDB v4 client — auth, search, and episode fetching. The one external
// integration used both as a search fallback (routes/mal-search.js) and as
// the sole source of real per-episode data (routes/episodes.js).
// ---------------------------------------------------------------------------
const { logInfo, logWarn, logError } = require('../logger');
const { db } = require('../db');
const { sleep } = require('./util');

// ---------------------------------------------------------------------------
// /api/tvdb/search — live metadata search backed by TheTVDB v4 API
//
// This is the one external integration in the app. The API key lives only
// in server.js / .env and is never sent to the browser — the frontend just
// calls our own /api/tvdb/search endpoint, and this file does the real
// TheTVDB login + search on its behalf.
//
// TheTVDB v4 auth is a two-step dance: POST /login with the API key to get
// a bearer token (valid roughly a month), then send that token on every
// other request. We cache the token in memory and only re-login when it's
// missing, close to expiry, or a request comes back 401.
// ---------------------------------------------------------------------------

const TVDB_API_BASE = process.env.TVDB_API_BASE || 'https://api4.thetvdb.com/v4';
const TVDB_API_KEY = process.env.TVDB_API_KEY || '';

let tvdbToken = null;
let tvdbTokenExpiresAt = 0;

async function tvdbLogin() {
  const res = await fetch(`${TVDB_API_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey: TVDB_API_KEY }),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`TVDB login returned a non-JSON response (status ${res.status})`);
  }
  if (!res.ok || json.status !== 'success' || !json.data || !json.data.token) {
    throw new Error(json.message || `TVDB login failed (status ${res.status})`);
  }
  tvdbToken = json.data.token;
  // Real tokens last ~1 month; refresh a little early to be safe.
  tvdbTokenExpiresAt = Date.now() + 1000 * 60 * 60 * 24 * 25;
}

async function tvdbFetch(pathAndQuery) {
  if (!TVDB_API_KEY) {
    const err = new Error('TVDB_API_KEY is not configured. Add it to .env and restart the server.');
    err.code = 'TVDB_NO_KEY';
    throw err;
  }
  if (!tvdbToken || Date.now() > tvdbTokenExpiresAt) {
    await tvdbLogin();
  }
  let res = await fetch(`${TVDB_API_BASE}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${tvdbToken}` },
  });
  if (res.status === 401) {
    // Token expired/invalid earlier than expected — log in once more and retry.
    await tvdbLogin();
    res = await fetch(`${TVDB_API_BASE}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${tvdbToken}` },
    });
  }
  return res;
}

// Maps a TVDB /search result into the shape the Add New page's card template
// already expects (id, title, year, overview, poster) — see initAddNew in
// app.js. TVDB's fields vary a bit by content type, hence the fallbacks.
//
// `name`/`overview` are TVDB's bare default fields — for anime these are
// frequently the native-language (Japanese) title/synopsis, not English.
// `translations`/`overviews` are keyed by 3-letter language code (per TVDB's
// TranslationSimple schema), so `translations.eng`/`overviews.eng` are the
// actual English text when TVDB has it. Checking those FIRST (not last, as
// this originally did) is what keeps results in English instead of Japanese.
function mapTvdbResult(r) {
  const title = (r.translations && r.translations.eng) || r.name || r.title || 'Untitled';
  const overview = (r.overviews && r.overviews.eng) || r.overview || '';
  const yearNum = r.year ? parseInt(r.year, 10) : null;
  return {
    id: r.tvdb_id || r.id,
    title,
    year: Number.isFinite(yearNum) ? yearNum : null,
    overview,
    poster: r.image_url || r.image || null,
    // TVDB's /search index doesn't carry episode counts, scores, or studios
    // (that's on the full series record, not the search index) — genres is
    // the one preview-modal field it actually has here, everything else the
    // modal shows just stays hidden for a TVDB-fallback result.
    numEpisodes: null,
    score: null,
    genres: Array.isArray(r.genres) ? r.genres : [],
    mediaType: null,
    status: r.status || null,
    studios: [],
    altTitleJapanese: null,
    altTitleSynonyms: [],
  };
}


// TVDB's /search has no genre query param to restrict results server-side
// (confirmed against their OpenAPI spec — only query/type/year/company/
// country/director/language/primaryType/network/remote_id exist), and the
// SearchResult schema does define a `genres` array, and TheTVDB does tag
// anime as "Anime" — but in practice, TVDB's lightweight /search index often
// doesn't carry populated genre data at all (that tends to live on the full
// series record, not the search index), even for titles that are genuinely
// tagged Anime on their own series page. A strict "must include Anime"
// filter was silently dropping real matches whenever genres came back empty,
// making the fallback look like it wasn't firing at all. So this only
// excludes a result when TVDB gives us genre data AND it doesn't include
// Anime (a confirmed non-match) — missing/empty genres is treated as
// "unknown," not "excluded."
function isExcludedByGenre(genres) {
  if (!Array.isArray(genres) || genres.length === 0) return false; // unknown — don't exclude
  return !genres.some((g) => String(g).toLowerCase() === 'anime');
}

async function tvdbSearchAnimeOnly(query) {
  const tvdbRes = await tvdbFetch(`/search?query=${encodeURIComponent(query)}&type=series`);
  let json;
  try {
    json = await tvdbRes.json();
  } catch {
    throw new Error(`TVDB returned a non-JSON response (status ${tvdbRes.status})`);
  }
  if (!tvdbRes.ok) {
    throw new Error(json.message || `TVDB search failed (status ${tvdbRes.status})`);
  }
  const raw = json.data || [];
  // Temporary extra diagnostics for a real case (a legitimately-listed show
  // still coming back with 0 raw results even for its exact TVDB title — see
  // resolveTvdbEpisodeSourceId's comment) that the plain raw-count log below
  // couldn't explain on its own. Two things worth seeing when that happens:
  // TVDB's own response body in full (a 200 with an empty `data` array can
  // still carry a `status`/`message` explaining why, e.g. an access-tier
  // restriction), and whether dropping the `type=series` filter changes
  // anything (rules out/in this app's own query being the problem rather
  // than TVDB's index). Safe to remove once the real cause is confirmed.
  if (raw.length === 0) {
    logWarn('TvdbService', `Empty search response for query "${query}" (type=series): ${JSON.stringify(json).slice(0, 500)}`);
    try {
      const noTypeRes = await tvdbFetch(`/search?query=${encodeURIComponent(query)}`);
      const noTypeJson = await noTypeRes.json().catch(() => null);
      const noTypeRaw = (noTypeJson && noTypeJson.data) || [];
      logWarn('TvdbService', `Same query without &type=series: ${noTypeRaw.length} raw result(s)` +
        (noTypeRaw.length > 0 ? ` | first result: ${JSON.stringify(noTypeRaw[0]).slice(0, 300)}` : ''));
    } catch (err) {
      logWarn('TvdbService', `Diagnostic no-type-filter retry itself failed: ${err.message}`);
    }
  }
  const results = raw.filter((r) => !isExcludedByGenre(r.genres)).map((r) => ({ ...mapTvdbResult(r), source: 'tvdb' }));
  logWarn('TvdbService', `Fallback search: ${raw.length} raw result(s), ${results.length} after genre filter` +
    (raw.length > 0 ? ` | genres seen: ${JSON.stringify(raw.map((r) => r.genres))}` : ''));
  return results;
}

// ---------------------------------------------------------------------------
// Episode fetching — TheTVDB (see the Episode persistence section, above
// handleSeriesEpisodesApi, for why this replaced Jikan)
// ---------------------------------------------------------------------------

// Figures out which TVDB series id to fetch episodes for, and caches it on
// the series row (tvdb_episode_id) so this only ever runs once per series.
// A series originally added via the TVDB-search fallback already has a TVDB
// id (external_id/external_source) — use it directly. Everything else (a
// MAL-added series, or one of the originally-seeded titles with no external
// id at all) gets resolved by searching TVDB for the series' own title,
// reusing the same anime-filtered search the MAL fallback uses.
//
// A MAL result's official English title is frequently NOT what TVDB itself
// indexes a show under — TVDB's own entry is often the romanized native
// title instead (e.g. this app's own "Yuuna and the Haunted Hot Springs" is
// "Yuragi-sou no Yuuna-san" on TVDB), which made the title-only search above
// come back with zero results even for a real, well-known show, silently
// leaving the series with no episodes and nothing in the logs explaining
// why (a plain "no match" isn't an error — see the try/catch one level up
// in resolveAndCacheEpisodesForSeries, which only logs on a thrown
// exception). If the primary title has no luck, every candidate in
// series.alt_titles (the JSON array POST /api/series stored — see that
// migration's comment for where these come from) gets tried in turn,
// stopping at the first real match.
//
// Returns null if nothing could be resolved (TVDB unreachable, no key
// configured, or genuinely no match under any known title).
async function resolveTvdbEpisodeSourceId(series) {
  if (series.tvdb_episode_id) return series.tvdb_episode_id;

  let tvdbId = null;
  let matchedTitle = null;
  if (series.external_source === 'tvdb' && series.external_id) {
    tvdbId = series.external_id;
  } else {
    const primaryMatches = await tvdbSearchAnimeOnly(series.title);
    if (primaryMatches.length > 0) {
      tvdbId = String(primaryMatches[0].id);
      matchedTitle = series.title;
    } else {
      let altTitles = [];
      try {
        altTitles = series.alt_titles ? JSON.parse(series.alt_titles) : [];
      } catch { /* malformed JSON — treat as no alt titles rather than fail resolution */ }
      for (const altTitle of altTitles) {
        const altMatches = await tvdbSearchAnimeOnly(altTitle);
        if (altMatches.length > 0) {
          tvdbId = String(altMatches[0].id);
          matchedTitle = altTitle;
          break;
        }
      }
    }
  }

  if (tvdbId) {
    db.prepare('UPDATE series SET tvdb_episode_id = ? WHERE id = ?').run(tvdbId, series.id);
    if (matchedTitle && matchedTitle !== series.title) {
      logInfo('EpisodeService', `Resolved "${series.title}" on TheTVDB via alternate title "${matchedTitle}"`);
    }
  } else if (series.external_source !== 'tvdb') {
    logWarn('EpisodeService', `No TheTVDB match for "${series.title}"` +
      (series.alt_titles ? ` or any of its alternate titles` : '') + ' — episodes will stay empty until this resolves.');
  }
  return tvdbId;
}

// Fetches every episode TVDB has for a series, from its "default" season
// type (whichever numbering TVDB's own curators picked as the primary one
// for that title — for most anime this lines up with simple aired order).
// Paginated; walks pages until one comes back with no episodes, capped at
// MAX_PAGES as a safety net against an unexpected response shape looping
// forever.
//
// Unlike Jikan, TVDB's episode records have no score/filler/recap
// equivalent, and getting an actually-English name would mean one extra
// request per episode (TVDB's translation data isn't inlined the way
// series-level search results are) — not worth it for what's meant to be
// the *reliable* path. So title/overview here are just whatever TVDB's own
// default-language record has; score/filler/recap/titleJapanese/
// titleRomanji are left null, and the UI already skips those badges
// whenever they're not present.
// Runs async fn over items with at most `limit` running concurrently,
// returning results in the same order as items — a small hand-rolled
// concurrency pool so fetching one translation per episode (below) doesn't
// either serialize into a very slow one-at-a-time loop or fire 20+ requests
// at once.
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

// TVDB's base episode record (`name`/`overview`, used below) is whatever
// language that series' entry defaults to on TVDB — for anime that's
// frequently Japanese, same issue the search results had before English was
// preferred there. Unlike search results, though, episode records don't
// carry the translated text inline — getting it means a separate
// /episodes/{id}/translations/{language} request per episode. Returns null
// (rather than throwing) on a 404 (no English translation exists for that
// episode) or any other failure, so a gap in TVDB's translation coverage
// just means that one episode keeps its native-language title instead of
// failing the whole batch.
async function fetchTvdbEpisodeTranslation(tvdbEpisodeId, language) {
  try {
    const tvdbRes = await tvdbFetch(`/episodes/${tvdbEpisodeId}/translations/${language}`);
    if (tvdbRes.status === 404) return null;
    const json = await tvdbRes.json();
    if (!tvdbRes.ok || !json.data) return null;
    return { name: json.data.name || null, overview: json.data.overview || null };
  } catch {
    return null;
  }
}

async function fetchTvdbEpisodes(tvdbId) {
  const MAX_PAGES = 5;
  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const tvdbRes = await tvdbFetch(`/series/${tvdbId}/episodes/default?page=${page}`);
    let json;
    try {
      json = await tvdbRes.json();
    } catch {
      throw new Error(`TVDB returned a non-JSON response fetching episodes (status ${tvdbRes.status})`);
    }
    if (!tvdbRes.ok) {
      throw new Error(json.message || `TVDB episode fetch failed (status ${tvdbRes.status})`);
    }
    const pageEpisodes = (json.data && json.data.episodes) || [];
    if (pageEpisodes.length === 0) break;
    for (const e of pageEpisodes) {
      if (e.number == null) continue; // specials/extras with no regular episode number
      all.push({
        tvdbEpisodeId: e.id, // only needed to fetch the translation below; not stored past that
        // TVDB's "default" season type response mixes every season together
        // in one flat array (specials as seasonNumber 0, season 1, season 2,
        // ...), and `number` restarts at 1 for each of them — so num alone
        // isn't unique per series, only (seasonNumber, num) is. Dropping
        // seasonNumber here is what caused specials and season 1 to
        // silently collide/interleave before this was tracked.
        seasonNumber: typeof e.seasonNumber === 'number' ? e.seasonNumber : 0,
        seasonName: e.seasonName || null,
        num: e.number,
        title: e.name || `Episode ${e.number}`,
        titleJapanese: null,
        titleRomanji: null,
        aired: e.aired || null,
        score: null,
        filler: false,
        recap: false,
        url: null,
        // Base (native-language) synopsis — TVDB's /episodes/default record
        // carries this alongside name/aired, same as the base title above.
        // Overwritten with the English translation below when one exists,
        // same "prefer English, fall back to whatever TVDB defaulted to
        // rather than nothing" rule the title already follows.
        overview: e.overview || null,
      });
    }
    await sleep(300); // be polite between pages
  }

  // English titles + synopses: fetched per episode (see
  // fetchTvdbEpisodeTranslation), a few at a time. Only overwrites a field
  // when TVDB actually has an English translation for that specific episode
  // — otherwise the base (native-language) value from above stays as-is
  // rather than being replaced with nothing. This was already fetching
  // `overview` for the title lookup and simply discarding it until now.
  await mapWithConcurrency(all, 4, async (ep) => {
    if (!ep.tvdbEpisodeId) return;
    const translation = await fetchTvdbEpisodeTranslation(ep.tvdbEpisodeId, 'eng');
    if (translation && translation.name) ep.title = translation.name;
    if (translation && translation.overview) ep.overview = translation.overview;
  });

  return all.map(({ tvdbEpisodeId, ...ep }) => ep);
}

module.exports = { tvdbFetch, mapTvdbResult, tvdbSearchAnimeOnly, resolveTvdbEpisodeSourceId, fetchTvdbEpisodes };
