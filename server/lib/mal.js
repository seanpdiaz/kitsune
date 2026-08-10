// ---------------------------------------------------------------------------
// MyAnimeList official API v2 client — search only (see routes/mal-search.js
// for the retry/fallback orchestration that calls fetchMalSearchOnce below).
// ---------------------------------------------------------------------------
const { logError } = require('../logger');

// ---------------------------------------------------------------------------
// /api/mal/search — live metadata search backed by the official MyAnimeList
// API v2 (https://api.myanimelist.net/v2). Needs a free Client ID from
// myanimelist.net/apiconfig, sent as an X-MAL-CLIENT-ID header — that's the
// "client_auth" scheme, good enough for read-only search/details with no
// OAuth login flow needed. Set MAL_CLIENT_ID in .env.
//
// This used to run on Jikan (a free, unofficial MAL wrapper) for search too,
// and for fetching episodes (see the Episode persistence section above) —
// but Jikan's endpoints have to live-scrape MyAnimeList's own site rather
// than serving from cache, and that hop fails intermittently on both, badly
// enough that it's been removed from the project entirely. Search now runs
// on the official API alone, with TheTVDB as the only fallback; episodes
// come from TheTVDB directly (see resolveTvdbEpisodeSourceId/
// fetchTvdbEpisodes above).
//
// One gotcha along the way: the official API silently excludes NSFW/
// ecchi-flagged titles (e.g. "Yosuga no Sora") from search results instead
// of erroring — a clean 200 with zero matches, nothing to retry or catch.
// Fixed by adding `nsfw=true` to the search request (see fetchMalSearchOnce
// below), which is what makes the official API return everything in the
// catalog.
//
// TheTVDB's /search endpoint returns any kind of TV series, not just anime,
// so it's the fallback (filtered to anime, see tvdbSearchAnimeOnly above),
// used when the official API fails or comes back empty after retries. See
// handleMalApi's two-tier order below: official API → TVDB.
// ---------------------------------------------------------------------------

const MAL_API_BASE = process.env.MAL_API_BASE || 'https://api.myanimelist.net/v2';
const MAL_CLIENT_ID = process.env.MAL_CLIENT_ID || '';
const MAL_MAX_ATTEMPTS = 3;
const MAL_RETRY_DELAYS_MS = [500, 1500]; // between attempt 1→2 and 2→3


// A lot of official-API synopses end with an editorial credit line MAL
// itself appends — "[Written by MAL Rewrite]", sometimes parenthesized,
// sometimes with a different editor name — which reads like a stray UI
// artifact rather than part of the actual synopsis once it's sitting under
// a card title. Strips it (plus whatever trailing blank line separated it
// from the real text) if present; leaves the synopsis alone otherwise.
function cleanMalSynopsis(text) {
  if (!text) return '';
  return text
    .replace(/\s*[\[(]\s*written\s+by\s+mal\s+rewrite\s*[\])]\s*$/i, '')
    .trim();
}

// The official API's search result wraps each hit in a "node" object, and
// only returns the default (often romanized) title at top level — the
// English name, if MAL has one, lives at alternative_titles.en. start_date
// is a partial-ISO string ("2017-10-23", "2017-10", or just "2017"), so the
// year is just its leading 4 digits.
function mapMalOfficialResult(node) {
  const altEn = node.alternative_titles && node.alternative_titles.en;
  const title = (altEn && altEn.trim()) || node.title || 'Untitled';
  const yearMatch = node.start_date && String(node.start_date).match(/^(\d{4})/);
  return {
    id: node.id,
    title,
    year: yearMatch ? Number(yearMatch[1]) : null,
    overview: cleanMalSynopsis(node.synopsis),
    poster: (node.main_picture && (node.main_picture.large || node.main_picture.medium)) || null,
    // Everything below here is extra detail for the Add New page's preview
    // modal — none of it is required for search/add to work, so each field
    // is left null/empty rather than thrown out when MAL doesn't have it,
    // and the modal just hides whatever's missing.
    numEpisodes: typeof node.num_episodes === 'number' && node.num_episodes > 0 ? node.num_episodes : null,
    score: typeof node.mean === 'number' ? node.mean : null,
    genres: Array.isArray(node.genres) ? node.genres.map((g) => g.name).filter(Boolean) : [],
    mediaType: node.media_type || null,
    status: node.status || null,
    studios: Array.isArray(node.studios) ? node.studios.map((s) => s.name).filter(Boolean) : [],
    altTitleJapanese: (node.alternative_titles && node.alternative_titles.ja) || null,
    altTitleSynonyms: (node.alternative_titles && Array.isArray(node.alternative_titles.synonyms))
      ? node.alternative_titles.synonyms
      : [],
    // The raw, un-overridden title MAL's node itself carries — usually the
    // romanized native title (e.g. "Yuragi-sou no Yuuna-san"), distinct from
    // `title` above once an English alt exists and takes its place. Kept
    // separate (not just dropped) because TVDB frequently indexes an anime
    // under this romanized title rather than its English one — see
    // resolveTvdbEpisodeSourceId in server/lib/tvdb.js, which tries this as
    // a fallback search when the English title comes back with no matches.
    titleNative: node.title || null,
  };
}

// One attempt at a MAL search via the official API. Throws on any failure
// (timeout, network error, non-2xx, non-JSON, missing client id) —
// handleMalApi below decides whether to retry, fall back to TVDB, or give
// up, based on what kind of error this throws.
async function fetchMalSearchOnce(query) {
  if (!MAL_CLIENT_ID) {
    const err = new Error('MAL_CLIENT_ID is not configured. Add it to .env and restart the server.');
    err.code = 'MAL_NO_CLIENT_ID';
    throw err;
  }

  // A plain fetch() with no timeout can hang indefinitely if the host
  // accepts the connection but never responds — cap it so a bad attempt
  // fails fast instead of eating the whole retry budget on one hang.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let malRes;
  try {
    const fields = 'alternative_titles,main_picture,synopsis,start_date,num_episodes,mean,genres,media_type,status,studios';
    // nsfw=true is required to get NSFW/ecchi-flagged titles back at all —
    // without it the API silently omits them from results instead of
    // erroring (confirmed: e.g. "Yosuga no Sora" came back as zero results
    // until this was added). Kitsune has no age-gating of its own, so this
    // is just "search the whole catalog" rather than "show explicit content
    // by default" — nothing about the response is unfiltered beyond that.
    malRes = await fetch(`${MAL_API_BASE}/anime?q=${encodeURIComponent(query)}&limit=10&nsfw=true&fields=${fields}`, {
      headers: { 'X-MAL-CLIENT-ID': MAL_CLIENT_ID },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (malRes.status === 429) {
    const err = new Error('MyAnimeList is rate-limiting us.');
    err.code = 'MAL_RATE_LIMIT';
    throw err;
  }

  const rawText = await malRes.text();
  let json;
  try {
    json = JSON.parse(rawText);
  } catch {
    logError('MalService', `Non-JSON response, status ${malRes.status} | body (first 500 chars): ${rawText.slice(0, 500)}`);
    throw new Error('MyAnimeList returned a non-JSON response');
  }
  if (!malRes.ok) {
    const message = json.message || json.error || `MyAnimeList search failed (status ${malRes.status})`;
    logError('MalService', `Non-OK response from ${MAL_API_BASE}/anime | status: ${malRes.status} | body: ${JSON.stringify(json)}`);
    throw new Error(message);
  }
  return (json.data || []).map((entry) => ({ ...mapMalOfficialResult(entry.node || {}), source: 'mal' }));
}

module.exports = { fetchMalSearchOnce, MAL_MAX_ATTEMPTS, MAL_RETRY_DELAYS_MS };
