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

// A cheap episode-COUNT-only probe — same page-walking loop fetchTvdbEpisodes
// (below) uses, but skips the per-episode translation requests entirely,
// since this only exists to compare how many real episodes a handful of
// same-named TVDB search candidates have (see pickBestTvdbCandidate) rather
// than to actually persist anything. A shorter between-page delay than the
// real fetch's, too — this is a quick disambiguation check run for multiple
// candidates, not the one real fetch whose own pacing already has to be
// polite about it.
async function countTvdbEpisodes(tvdbId) {
  const MAX_PAGES = 5;
  let count = 0;
  for (let page = 0; page < MAX_PAGES; page++) {
    const tvdbRes = await tvdbFetch(`/series/${tvdbId}/episodes/default?page=${page}`);
    let json;
    try {
      json = await tvdbRes.json();
    } catch {
      break;
    }
    if (!tvdbRes.ok) break;
    const pageEpisodes = (json.data && json.data.episodes) || [];
    count += pageEpisodes.filter((e) => e.number != null).length;
    if (pageEpisodes.length === 0) break;
    await sleep(150);
  }
  return count;
}

// Loose title-equality check used to narrow TVDB search results down to
// "actually the show we searched for" before episode-count disambiguation
// ever runs — see pickBestTvdbCandidate below for why this has to happen
// FIRST. Strips everything but letters/digits and lowercases, so casing,
// punctuation ("King's Raid" vs "Kings Raid"), and spacing differences don't
// cause a false negative; a match is exact equality or one title fully
// containing the other (covers subtitle variants like "Tsugumomo" vs
// "Tsugumomo: Some Subtitle").
function normalizeTitleForMatch(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '');
}
function titlesLooselyMatch(a, b) {
  const na = normalizeTitleForMatch(a);
  const nb = normalizeTitleForMatch(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

// Real TVDB search for an anime title can come back with more than one
// distinct "series" entry — sometimes genuinely same-titled (TVDB models an
// OVA/special as its own separate series record rather than a season of the
// main one, e.g. "Tsugumomo" itself returning both the 13-episode TV series
// and a 1-episode OVA under the identical title), but sometimes TVDB's
// search index is just loose and returns something with no title
// relationship to the query at all — a real, confirmed case: searching
// "Tsugumomo" returned "King's Raid: Successors of the Will" as one of its 3
// results. An earlier version of this function probed EVERY search result's
// episode count and picked the highest, with no title check at all — which
// fixed the OVA case but then confidently mismatched Tsugumomo onto that
// unrelated 26-episode show, since 26 > 13 and nothing was filtering it out
// first. Episode count is only a meaningful tiebreaker among candidates that
// are actually the show being searched for; it says nothing on its own.
//
// So this filters to title-matching candidates FIRST (titlesLooselyMatch),
// and only disambiguates by real episode count (countTvdbEpisodes) among
// those. A single-result search, or a single title match, skips probing
// entirely — no behavior or cost change for the common, unambiguous case.
const CANDIDATE_PROBE_LIMIT = 4;
async function pickBestTvdbCandidate(query) {
  const matches = await tvdbSearchAnimeOnly(query);
  if (matches.length === 0) return null;

  const titleMatched = matches.filter((m) => titlesLooselyMatch(m.title, query));
  if (titleMatched.length === 0) {
    // TVDB returned results, but none resemble the query by title at all —
    // episode-count comparison would be meaningless without a title filter
    // to narrow the field first. Safest fallback: whatever TVDB ranked
    // first, same as the original pre-disambiguation behavior.
    logWarn('TvdbService', `No title-matched TVDB result for "${query}" among ${matches.length} search result(s) (closest titles: ${matches.slice(0, 3).map((m) => `"${m.title}"`).join(', ')}) — using TVDB's top result as-is.`);
    return { id: String(matches[0].id), title: matches[0].title };
  }
  if (titleMatched.length === 1) return { id: String(titleMatched[0].id), title: titleMatched[0].title };

  const candidates = titleMatched.slice(0, CANDIDATE_PROBE_LIMIT);
  let best = null;
  for (const candidate of candidates) {
    let count;
    try {
      count = await countTvdbEpisodes(String(candidate.id));
    } catch (err) {
      logWarn('TvdbService', `Could not probe episode count for TVDB id ${candidate.id} ("${candidate.title}"): ${err.message}`);
      continue;
    }
    if (!best || count > best.count) best = { id: String(candidate.id), title: candidate.title, count };
  }
  // Every probe failing (a real outage mid-resolution) falls back to the old
  // naive behavior — a possibly-wrong match is still strictly better than no
  // match at all, same "degrade, don't break" rule the rest of this
  // integration already follows.
  if (!best) return { id: String(titleMatched[0].id), title: titleMatched[0].title };
  if (candidates.length > 1) {
    logInfo('TvdbService', `Multiple title-matched TVDB results for "${query}" (${candidates.length}) — picked "${best.title}" (id ${best.id}, ${best.count} episode(s)) as the real series rather than trusting search-result order`);
  }
  return best;
}

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
    const primaryBest = await pickBestTvdbCandidate(series.title);
    if (primaryBest) {
      tvdbId = primaryBest.id;
      matchedTitle = series.title;
    } else {
      let altTitles = [];
      try {
        altTitles = series.alt_titles ? JSON.parse(series.alt_titles) : [];
      } catch { /* malformed JSON — treat as no alt titles rather than fail resolution */ }
      for (const altTitle of altTitles) {
        const altBest = await pickBestTvdbCandidate(altTitle);
        if (altBest) {
          tvdbId = altBest.id;
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
// Returns { name, overview } on success, or { name: null, overview: null,
// reason } on any failure — a 404 (no English translation exists for that
// episode, a completely normal and common outcome) gets reason: null so
// fetchTvdbEpisodes below doesn't warn about it; every other failure carries
// a real reason. This used to swallow every failure silently (a bare
// `catch { return null }`, nothing logged) — fine for one occasional 404,
// but it meant a systemic problem (an expired token this call didn't
// trigger a re-login for, a rate limit, a malformed response) affecting
// EVERY episode of one series was completely invisible: the symptom (a
// show's episodes all showing the generic "Episode N" fallback — see
// fetchTvdbEpisodes' title assignment) had no corresponding line in System
// > Logs explaining why, which is exactly what happened investigating a
// real report of this for one real series.
async function fetchTvdbEpisodeTranslation(tvdbEpisodeId, language) {
  try {
    const tvdbRes = await tvdbFetch(`/episodes/${tvdbEpisodeId}/translations/${language}`);
    if (tvdbRes.status === 404) return { name: null, overview: null, reason: null };
    let json;
    try {
      json = await tvdbRes.json();
    } catch {
      return { name: null, overview: null, reason: `non-JSON response (status ${tvdbRes.status})` };
    }
    if (!tvdbRes.ok) {
      return { name: null, overview: null, reason: json.message || `status ${tvdbRes.status}` };
    }
    if (!json.data) {
      return { name: null, overview: null, reason: 'response had no data' };
    }
    return { name: json.data.name || null, overview: json.data.overview || null, reason: null };
  } catch (err) {
    return { name: null, overview: null, reason: err.message };
  }
}

// TVDB's per-episode `seasonName` (used as the segment-tab label for a
// season, unless it's been manually renamed — see handleRenameSeason in
// routes/episodes.js) is whatever language that show's entry defaults to on
// TVDB, same issue base episode titles have — but unlike titles, there's no
// per-episode translation endpoint for it, and no cheap way to fetch an
// English one at all from the /episodes/default response this app already
// uses. A real, confirmed case: Tsugumomo's second season name comes back
// as raw Japanese ("継つぐもも"), which then rendered untranslated as the tab
// label instead of falling back to the plain "Season 2" segmentLabel()
// already produces for a season with no name at all. Rather than leave a
// native-script label users can't read, treat any season name containing
// CJK (Chinese/Japanese) or Hangul (Korean) script as "not usefully
// translated" and drop it to null so the existing "Season N" fallback
// applies — the same outcome as if TVDB had no name for that season at all.
// Latin-script native names (romaji, etc.) are left alone since those are
// at least readable.
const NON_LATIN_SCRIPT_RE = /[぀-ヿ㐀-鿿가-힯]/;
function stripUntranslatedSeasonName(seasonName) {
  if (!seasonName) return null;
  return NON_LATIN_SCRIPT_RE.test(seasonName) ? null : seasonName;
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
        seasonName: stripUntranslatedSeasonName(e.seasonName),
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
  const translationFailures = [];
  await mapWithConcurrency(all, 4, async (ep) => {
    if (!ep.tvdbEpisodeId) return;
    const translation = await fetchTvdbEpisodeTranslation(ep.tvdbEpisodeId, 'eng');
    if (translation.name) ep.title = translation.name;
    if (translation.overview) ep.overview = translation.overview;
    if (translation.reason) translationFailures.push(`episode ${ep.num} (S${ep.seasonNumber}): ${translation.reason}`);
  });
  // One real reason per failed episode, but only one summary line total —
  // not spammed per-episode into the log for a show with a genuinely large
  // episode count. A run where EVERY episode failed the same way (a token
  // problem, a rate limit) is exactly the case worth surfacing loudly;
  // occasional isolated ones still show up, just batched together.
  if (translationFailures.length > 0) {
    logWarn('TvdbService', `Could not fetch English translation for ${translationFailures.length}/${all.length} episode(s): ${translationFailures.slice(0, 5).join('; ')}${translationFailures.length > 5 ? '; …' : ''}`);
  }

  return all.map(({ tvdbEpisodeId, ...ep }) => ep);
}

module.exports = { tvdbFetch, mapTvdbResult, tvdbSearchAnimeOnly, resolveTvdbEpisodeSourceId, fetchTvdbEpisodes };
