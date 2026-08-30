// ---------------------------------------------------------------------------
// Prowlarr real search — a second real indexer path alongside server/lib/
// nyaa-search.js's direct Nyaa.si integration (see Settings > Indexers; the
// user can enable either, both, or neither — routes/releases.js merges
// whichever real indexers are on). Prowlarr is an indexer *aggregator*: one
// Prowlarr instance can proxy Nyaa.si plus any number of other trackers a
// user has configured there, so enabling it searches everything Prowlarr
// knows about in one request instead of Kitsune needing its own integration
// per tracker.
//
// Unlike Nyaa.si, Prowlarr has its own real JSON REST API (not just Torznab
// XML/RSS) — GET /api/v1/search, authenticated with an X-Api-Key header —
// confirmed against the official Servarr wiki (wiki.servarr.com/prowlarr/
// search) and Prowlarr's own OpenAPI-generated client docs (devopsarr/
// prowlarr-py). That's simpler for this zero-dependency backend than
// Torznab's XML would be, and it's the same API Prowlarr's own web UI and
// Sonarr/Radarr's Prowlarr integration both use — nothing unofficial here.
//
// Title/episode/batch matching (titleMatchesEpisode, isBatchRelease,
// classifyQualityFromTitle, simplifyTitleForSearch) is reused directly from
// nyaa-search.js rather than duplicated — a release title from a Prowlarr-
// proxied tracker is exactly as much free text as one straight from Nyaa.si,
// so the same best-effort regex heuristics apply unchanged.
// ---------------------------------------------------------------------------
const https = require('https');
const http = require('http');
const { logDebug, logInfo, logWarn } = require('../logger');
const { rankReleaseCandidates } = require('./quality');
const {
  titleMatchesEpisode, isBatchRelease, releaseCoversSeason, classifyQualityFromTitle, simplifyTitleForSearch, isHttpUrl,
} = require('./nyaa-search');

const REQUEST_TIMEOUT_MS = 15000; // longer than Nyaa.si's 10s — Prowlarr fans a query out to every configured indexer and waits on the slowest one
const CANDIDATE_LIMIT = 8;

// Prowlarr's own documented default page size for /api/v1/search is 100 —
// see wiki.servarr.com/prowlarr/search — but the docs don't state a hard
// maximum, so this asks for more than the default in one request rather
// than assuming 100 is a real ceiling (worth trying since there's no
// downside if Prowlarr just clamps it back down). There's also an `offset`
// param for paging past whatever the true limit turns out to be, but it's a
// confirmed-broken feature in real Prowlarr right now (Prowlarr/Prowlarr#1256
// on GitHub — offset doesn't actually skip records correctly), so unlike
// nyaa-search.js's own MAX_PAGES_PER_ATTEMPT pagination (added specifically
// because a single Nyaa.si tracker's old back-catalog releases get buried
// past page 1 by years of re-uploads), this deliberately does NOT try to
// page deeper via offset — depending on a param Prowlarr's own issue tracker
// says doesn't work would just add a false sense of thoroughness. A real,
// confirmed case still hit this limit even with a public aggregator behind
// it: a plain "Tsugumomo" query returned exactly 100 results, every one a
// batch/BD/compilation re-upload, zero individual episodes anywhere in that
// set — see searchReleasesForEpisode's own comment on folding the episode
// number into the query itself as the real fix for that case, since a
// bigger `limit` alone doesn't help once every close-by candidate any single
// tracker actually has has already been returned.
const SEARCH_LIMIT = 250;

function normalizeBaseUrl(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

// Parses a JSON body from either fetchWithTimeout path (real `fetch`'s
// Response or rawRequest's lookalike), with a specific diagnosis when the
// body is actually an HTML page rather than JSON — a real, reported case:
// something between this server and Prowlarr's own /api/v1 (Prowlarr's own
// authentication requiring a browser login session, or a reverse
// proxy/SSO gate in front of a publicly-exposed instance) redirected an API
// request to a login page instead of answering it, and `res.ok` alone
// doesn't catch that (a login page is itself a normal 200 response) — only
// actually trying to parse it as JSON, or checking its Content-Type/shape
// first, reveals it wasn't a real API response at all. Checking the body
// itself (not just relying on Content-Type) matters because rawRequest's
// redirect-following (see MAX_REDIRECTS above) can land on a login page that
// a misconfigured server still serves with an `application/json`-labeled or
// missing Content-Type.
async function parseJsonResponse(res) {
  const text = await res.text();
  const contentType = res.contentType || (res.headers && typeof res.headers.get === 'function' ? res.headers.get('content-type') : '') || '';
  const looksLikeHtml = contentType.includes('text/html') || /^\s*<(!doctype|html)/i.test(text);
  if (looksLikeHtml) {
    throw new Error(
      'Prowlarr responded with an HTML page instead of JSON — this usually means the request got redirected to '
      + "a login page rather than reaching Prowlarr's API. Check whether Prowlarr's own Authentication setting "
      + '(Settings > General > Security) requires a browser login for API requests, or whether a reverse proxy/SSO '
      + 'gate in front of this address is blocking direct API access.',
    );
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Prowlarr returned unparseable JSON: ${err.message}`);
  }
}

// Node's global `fetch` wraps the real underlying failure reason (TLS,
// DNS, connection refused, etc.) inside `err.cause` rather than
// `err.message` — a self-signed certificate failure otherwise surfaces as
// just "fetch failed", which hides exactly the information someone needs to
// fix it. Confirmed directly against a real self-signed HTTPS server:
// `err.cause` is `Error: self-signed certificate` with
// `.code = 'DEPTH_ZERO_SELF_SIGNED_CERT'` for that specific case — every
// other Node network error follows the same cause-wrapping shape, so this
// helps across the board, not just for certificates.
function describeFetchError(err) {
  if (err.cause && err.cause.message) {
    const code = err.cause.code ? ` (${err.cause.code})` : '';
    let hint = '';
    if (err.cause.code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || err.cause.code === 'SELF_SIGNED_CERT_IN_CHAIN' || err.cause.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
      hint = ' — if this is a self-signed certificate you trust (e.g. an internal .lan address), enable "Allow self-signed certificate" on this indexer.';
    }
    return `${err.cause.message}${code}${hint}`;
  }
  return err.message;
}

// Builds a fetch-Response-shaped object ({ ok, status, json(), text() })
// from a raw http/https request — used only when a Prowlarr row has "Allow
// self-signed certificate" enabled. Node's built-in global `fetch` (undici
// under the hood) has no documented per-request "skip TLS verification"
// option without constructing a custom undici Agent, and the `undici`
// package isn't installed here (this backend has no runtime npm
// dependencies at all — see README) — confirmed neither `require('undici')`
// nor `require('node:undici')` resolve in this environment. `https.request`'s
// own `rejectUnauthorized: false` does the same thing with nothing to
// install, at the cost of writing this small wrapper instead of using
// `fetch` directly — including, importantly, redirect-following: `fetch`
// follows redirects by default (confirmed directly — a real local redirect
// test showed `fetch` transparently landing on the final page rather than
// returning the 302 itself), but a raw `http(s).request` does not, so a real
// case (a Prowlarr instance whose own auth/reverse-proxy redirects an
// unrecognized API request to a login page) surfaced as a confusing bare
// "Prowlarr returned status 302" instead of actually reaching the final
// response. `maxRedirects` mirrors a sane bound, not Prowlarr-specific — any
// HTTP client needs one to avoid an infinite loop on a redirect cycle.
const MAX_REDIRECTS = 10;

function rawRequest(url, { headers, timeoutMs, allowInsecureSsl, redirectsLeft = MAX_REDIRECTS }) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(url);
    } catch (err) {
      reject(err);
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const options = { method: 'GET', headers };
    if (u.protocol === 'https:' && allowInsecureSsl) options.rejectUnauthorized = false;
    const req = mod.request(u, options, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume(); // drain so the socket can be reused/closed cleanly
        if (redirectsLeft <= 0) {
          reject(new Error(`Too many redirects (stopped after ${MAX_REDIRECTS})`));
          return;
        }
        const nextUrl = new URL(res.headers.location, u).toString();
        resolve(rawRequest(nextUrl, { headers, timeoutMs, allowInsecureSsl, redirectsLeft: redirectsLeft - 1 }));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          ok: res.statusCode >= 200 && res.statusCode < 300,
          status: res.statusCode,
          contentType: res.headers['content-type'] || '',
          text: async () => body.toString('utf8'),
          json: async () => JSON.parse(body.toString('utf8')),
        });
      });
    });
    req.on('error', (err) => reject(err));
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`Timed out after ${timeoutMs / 1000}s reaching Prowlarr`)));
    req.end();
  });
}

async function fetchWithTimeout(url, apiKey, allowInsecureSsl) {
  const headers = { 'X-Api-Key': apiKey };
  if (allowInsecureSsl) {
    // The raw-request path handles its own timeout via req.setTimeout above
    // rather than AbortController, since it isn't going through fetch.
    try {
      return await rawRequest(url, { headers, timeoutMs: REQUEST_TIMEOUT_MS, allowInsecureSsl: true });
    } catch (err) {
      throw new Error(`Could not reach Prowlarr: ${err.message}`);
    }
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal, headers });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Timed out after ${REQUEST_TIMEOUT_MS / 1000}s reaching Prowlarr`);
    }
    throw new Error(`Could not reach Prowlarr: ${describeFetchError(err)}`);
  } finally {
    clearTimeout(timer);
  }
}

// Raw search against Prowlarr's own /api/v1/search — returns every usable
// result (has a real magnetUrl or downloadUrl to grab), unfiltered by
// episode number. Throws on a genuine network/HTTP/auth failure; a query
// with no results is not an error, it's just an empty array.
//
// `indexerIds=-2` is Prowlarr's own documented shorthand for "every
// configured torrent indexer" (as opposed to `-1` for usenet, which Kitsune
// can't act on anyway — its grab pipeline only knows how to hand a
// magnet/.torrent URL to a torrent client, not an NZB to a usenet
// downloader). No `categories` filter is sent at all — the exact same
// lesson already learned the hard way with Nyaa.si's own category param
// (see nyaa-search.js's ANIME_CATEGORY comment): a tracker's own category
// tagging is inconsistent enough that narrowing server-side risks silently
// hiding a real, wanted release, and content-level filtering
// (titleMatchesEpisode/isBatchRelease, below) already does the real work of
// deciding what's relevant.
async function searchProwlarr(config, query) {
  const base = normalizeBaseUrl(config.baseUrl);
  const params = new URLSearchParams({
    query, type: 'search', indexerIds: '-2', limit: String(SEARCH_LIMIT),
  });
  const url = `${base}/api/v1/search?${params.toString()}`;
  logDebug('IndexerService', `Prowlarr request: ${url}`);
  const res = await fetchWithTimeout(url, config.apiKey, config.allowInsecureSsl);
  if (res.status === 401 || res.status === 403) {
    throw new Error('Prowlarr rejected the API key (401/403) — check Settings > Indexers.');
  }
  if (!res.ok) throw new Error(`Prowlarr returned status ${res.status}`);

  const json = await parseJsonResponse(res);
  const items = Array.isArray(json) ? json : [];

  const results = items.map((r) => ({
    title: r.title || 'Unknown',
    // A magnet is preferred when a tracker provides one directly; otherwise
    // Prowlarr's own downloadUrl (a proxied link to the .torrent file, with
    // whatever auth Prowlarr itself needs already baked into the URL) works
    // exactly the same way here — server/routes/queue.js already hands
    // release.magnetUrl straight to qBittorrent's addTorrent(), which
    // accepts either a real magnet link or a URL to a .torrent file
    // (qBittorrent fetches it itself), so no separate code path is needed
    // for the two cases.
    magnetUrl: r.magnetUrl || r.downloadUrl || null,
    infoHash: r.infoHash ? String(r.infoHash).toLowerCase() : null,
    // Prowlarr's ReleaseResource schema (wiki.servarr.com/prowlarr/search —
    // the same doc this integration's other fields were confirmed against)
    // includes infoUrl: a link to the release's detail page on whichever
    // underlying tracker actually indexed it, e.g. a Nyaa.si torrent page
    // when Prowlarr is proxying Nyaa.si. isHttpUrl guards against a missing
    // or malformed value the same way nyaa-search.js's own <guid> extraction
    // does — no valid link means this release just isn't clickable, same
    // graceful-degradation rule as everywhere else in this file.
    infoUrl: isHttpUrl(r.infoUrl) ? r.infoUrl : null,
    sizeBytes: typeof r.size === 'number' ? r.size : 0,
    seeders: typeof r.seeders === 'number' ? r.seeders : 0,
    leechers: typeof r.leechers === 'number' ? r.leechers : 0,
    indexerName: r.indexer || 'Prowlarr',
  })).filter((r) => !!r.magnetUrl);

  logDebug(
    'IndexerService',
    `Prowlarr query "${query}": ${items.length} item(s) back, ${results.length} usable (had a magnetUrl/downloadUrl).`
    + (items.length > 0 && results.length === 0 ? ' All items were dropped — no magnetUrl/downloadUrl on any of them.' : ''),
  );
  return results;
}

// Same title-attempt fallback shape as nyaa-search.js's searchWithFallback
// (primary title, then extraQueryTerm variant, then each of series.alt_titles
// in turn) — kept as a near-duplicate rather than sharing code directly with
// Nyaa's version since the two now differ in one real way: this one does not
// page (see SEARCH_LIMIT's comment on why), so folding them into one shared
// function would mean threading a "should this indexer paginate" flag through
// nyaa-search.js for no real benefit.
async function searchWithFallback(config, series, matchFn, { extraQueryTerm } = {}) {
  const attempts = [];
  if (extraQueryTerm) attempts.push(`${series.title} ${extraQueryTerm}`);
  attempts.push(series.title);
  let altTitles = [];
  try {
    altTitles = series.alt_titles ? JSON.parse(series.alt_titles) : [];
  } catch { /* malformed JSON — treat as no alt titles */ }
  attempts.push(...altTitles);

  logInfo(
    'IndexerService',
    `Prowlarr search for "${series.title}" (id ${series.id}): trying ${attempts.length} title attempt(s) — ${JSON.stringify(attempts)}`,
  );

  let matches = [];
  const seenQueries = new Set();
  for (const attempt of attempts) {
    // Same empty-query guard as nyaa-search.js's own fix — a non-Latin-only
    // alt title (e.g. a Japanese title) simplifies to "", which is an
    // unscoped query, not a real search for this show.
    const query = simplifyTitleForSearch(attempt);
    if (query.length < 2 || seenQueries.has(query)) {
      logDebug('IndexerService', `Skipping Prowlarr attempt "${attempt}" — simplifies to "${query}" (${query.length < 2 ? 'too short/empty' : 'already tried'}).`);
      continue;
    }
    seenQueries.add(query);

    const results = await searchProwlarr(config, query);
    matches = results.filter(matchFn);
    logInfo('IndexerService', `Prowlarr query "${query}": ${results.length} result(s) back, ${matches.length} matched the filter for this search.`);
    if (matches.length > 0) {
      logInfo('IndexerService', `Prowlarr search for "${series.title}" matched on query "${query}" — ${matches.length} release(s).`);
      break;
    }
  }
  if (matches.length === 0) {
    logInfo('IndexerService', `Prowlarr search for "${series.title}" (id ${series.id}) found no matching releases after trying every title attempt.`);
  }
  return matches;
}

// `profile` — same role as nyaa-search.js's own toReleaseCandidates: ranks
// but never filters (see that file's comment for the full reasoning; both
// now share the one real ranking implementation, server/lib/quality.js's
// rankReleaseCandidates, rather than keeping two separate copies of the same
// sort in sync by hand).
async function toReleaseCandidates(matches, extra, profile) {
  const releases = await Promise.all(matches.map(async (r) => ({
    title: r.title,
    quality: await classifyQualityFromTitle(r.title),
    sizeBytes: r.sizeBytes,
    indexer: r.indexerName, // the underlying tracker Prowlarr actually pulled this from (e.g. "Nyaa"), not just "Prowlarr" — same spirit as Nyaa.si's own real indexer name, more useful than a single generic label when Prowlarr has several trackers configured
    protocol: 'torrent',
    seeders: r.seeders,
    magnetUrl: r.magnetUrl,
    infoHash: r.infoHash,
    infoUrl: r.infoUrl,
    source: 'real',
    ...extra,
  })));
  return (await rankReleaseCandidates(releases, { profile })).slice(0, CANDIDATE_LIMIT);
}

// Mirrors nyaa-search.js's searchReleasesForEpisode exactly (same signature,
// same return shape) so routes/releases.js can call whichever real indexers
// are enabled and merge their results the same way.
async function searchReleasesForEpisode(config, series, episode, profile) {
  const epCode = `S${String(episode.seasonNumber ?? 1).padStart(2, '0')}E${String(episode.num).padStart(2, '0')}`;
  logInfo('IndexerService', `Searching Prowlarr for "${series.title}" ${epCode} (episode #${episode.num}, single-episode search — batch releases excluded).`);
  let matches;
  try {
    // A real, confirmed case: a plain "Tsugumomo" query against Prowlarr
    // returned 75 results (a real, live query, not simulated) — every one a
    // batch/BD/compilation re-upload of the show, zero individual-episode
    // releases anywhere in that set. Since Prowlarr's own `offset`
    // pagination is confirmed broken (see MAX_REDIRECTS... er, SEARCH_LIMIT's
    // comment above) and there's no reliable way to page past that 75 the
    // way Nyaa.si's own direct integration pages past its burial problem,
    // the episode number is folded into the query itself instead — passed
    // as `extraQueryTerm`, the exact same mechanism searchBatchReleases
    // already uses for a season's own name, tried before the bare title.
    // "Tsugumomo 01" asks Prowlarr's (and each underlying tracker's) own
    // relevance ranking to do the narrowing server-side, the same way a
    // person typing that same, more specific query directly into a
    // tracker's search box would get far fewer, far more relevant results
    // than searching the bare show name alone.
    matches = await searchWithFallback(config, series, (r) => titleMatchesEpisode(r.title, episode.num) && !isBatchRelease(r.title), { extraQueryTerm: String(episode.num).padStart(2, '0') });
  } catch (err) {
    logWarn('IndexerService', `Prowlarr search failed for "${series.title}" ${epCode}: ${err.message}`);
    return { ok: false, error: err.message };
  }
  const releases = await toReleaseCandidates(matches, undefined, profile);
  logInfo('IndexerService', `Prowlarr search for "${series.title}" ${epCode} finished: ${matches.length} raw match(es), ${releases.length} shown after quality sort/limit.`);
  return { ok: true, releases };
}

async function searchBatchReleases(config, series, { extraQueryTerm, profile, seasonNumber } = {}) {
  logInfo('IndexerService', `Searching Prowlarr for "${series.title}" batch releases${extraQueryTerm ? ` (narrowed with "${extraQueryTerm}")` : ''}${seasonNumber != null ? ` (season ${seasonNumber} only)` : ''}.`);
  let matches;
  try {
    // See nyaa-search.js's releaseCoversSeason comment — same real miss
    // (a different season's batch slipping into a season-scoped search)
    // applies here too, since Prowlarr aggregates the same trackers.
    matches = await searchWithFallback(config, series, (r) => isBatchRelease(r.title) && releaseCoversSeason(r.title, seasonNumber), { extraQueryTerm });
  } catch (err) {
    logWarn('IndexerService', `Prowlarr batch search failed for "${series.title}": ${err.message}`);
    return { ok: false, error: err.message };
  }
  const releases = await toReleaseCandidates(matches, { isBatch: true }, profile);
  logInfo('IndexerService', `Prowlarr batch search for "${series.title}" finished: ${matches.length} raw match(es), ${releases.length} shown after quality sort/limit.`);
  return { ok: true, releases };
}

// Backs Settings > Indexers' real Test button for a Prowlarr row — hits
// Prowlarr's own /api/v1/system/status, the same lightweight "prove this
// instance is reachable and the API key is accepted" check Sonarr/Radarr's
// own Prowlarr connection test performs, without running an actual search.
async function testProwlarrReachable(config) {
  const base = normalizeBaseUrl(config.baseUrl);
  if (!base) return { ok: false, error: 'No base URL configured.' };
  if (!config.apiKey) return { ok: false, error: 'No API key configured.' };
  let res;
  try {
    res = await fetchWithTimeout(`${base}/api/v1/system/status`, config.apiKey, config.allowInsecureSsl);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, error: 'Prowlarr rejected the API key (401/403).' };
  }
  if (!res.ok) {
    return { ok: false, error: `Prowlarr returned status ${res.status}.` };
  }
  let json;
  try {
    json = await parseJsonResponse(res);
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!json || typeof json !== 'object') {
    return { ok: false, error: 'Prowlarr responded, but not with the status payload expected.' };
  }
  return { ok: true, version: json.version || 'unknown' };
}

module.exports = {
  searchProwlarr, searchReleasesForEpisode, searchBatchReleases, testProwlarrReachable, describeFetchError,
};
