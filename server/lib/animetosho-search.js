// ---------------------------------------------------------------------------
// AnimeTosho (animetosho.org) as a real indexer — Settings > Indexers type
// 'animetosho'.
//
// AnimeTosho mirrors Nyaa.si (and TokyoTosho/AniDex) and, unlike Nyaa, links
// most releases to their AniDB anime — so for a series whose AniDB ID is
// known (server/lib/anime-ids.js), this can ask for "every release of this
// show" by ID instead of guessing at titles. That's the case title search
// structurally can't handle: a release named something none of the series'
// known titles match. Falls back to title search (same title/alt-title
// walk as nyaa-search.js) when there's no AniDB ID, or when the ID-scoped
// request doesn't come back actually scoped (see searchByAnidbId).
//
// Uses the public JSON feed (feed.animetosho.org/json). Fields read:
// title, link, info_hash, magnet_uri, torrent_url, total_size, num_files,
// seeders, leechers, anidb_aid — all optional; anything missing degrades
// to the same handling a Nyaa result without that field would get. Override
// the feed URL with ANIMETOSHO_FEED_URL in .env if needed.
// ---------------------------------------------------------------------------
const { logInfo, logWarn, logDebug } = require('../logger');
const { rankReleaseCandidates } = require('./quality');
const {
  classifyQualityFromTitle, titleMatchesEpisode, classifyReleaseShape, releaseCoversSeason,
  simplifyTitleForSearch, isUsableAltQuery, buildMagnet, isHttpUrl,
} = require('./nyaa-search');
const { keepVerifiedPacks } = require('./torrent-files');

const FEED_URL = process.env.ANIMETOSHO_FEED_URL || 'https://feed.animetosho.org/json';
const REQUEST_TIMEOUT_MS = 15000;
const USER_AGENT = 'Mozilla/5.0 (compatible; Kitsune/1.0; self-hosted anime library manager)';
const CANDIDATE_LIMIT = 8;
const MAX_PAGES = 5;

async function fetchFeed(params) {
  const url = `${FEED_URL}?${new URLSearchParams(params).toString()}`;
  logDebug('IndexerService', `AnimeTosho request: ${url}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Timed out after ${REQUEST_TIMEOUT_MS / 1000}s reaching AnimeTosho`);
    throw new Error(`Could not reach AnimeTosho: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`AnimeTosho returned status ${res.status}`);
  const json = await res.json().catch(() => { throw new Error('AnimeTosho returned a non-JSON response'); });
  if (!Array.isArray(json)) throw new Error('AnimeTosho returned an unexpected response (not a list)');
  return json;
}

// Base32 → hex for a magnet's btih, so a release found here dedupes against
// the same torrent found on Nyaa.si (whose hashes are always hex).
function base32ToHex(b32) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const ch of b32.toUpperCase()) {
    const v = alphabet.indexOf(ch);
    if (v === -1) return null;
    bits += v.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let i = 0; i + 4 <= bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex.slice(0, 40);
}

function normalizeInfoHash(item) {
  const raw = String(item.info_hash || '').trim();
  if (/^[a-f0-9]{40}$/i.test(raw)) return raw.toLowerCase();
  const m = /urn:btih:([a-z0-9]+)/i.exec(String(item.magnet_uri || ''));
  if (!m) return null;
  if (/^[a-f0-9]{40}$/i.test(m[1])) return m[1].toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(m[1])) return base32ToHex(m[1]);
  return null;
}

function toInt(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function mapItem(item) {
  const title = String(item.title || '').trim() || 'Unknown';
  const infoHash = normalizeInfoHash(item);
  const magnetUrl = (typeof item.magnet_uri === 'string' && item.magnet_uri.startsWith('magnet:'))
    ? item.magnet_uri
    : (infoHash ? buildMagnet(infoHash, title) : null);
  return {
    title,
    magnetUrl,
    infoHash,
    infoUrl: isHttpUrl(item.link) ? item.link : null,
    torrentUrl: isHttpUrl(item.torrent_url) ? item.torrent_url : null,
    sizeBytes: toInt(item.total_size) || 0,
    seeders: toInt(item.seeders) || 0,
    leechers: toInt(item.leechers) || 0,
    numFiles: toInt(item.num_files),
    anidbAid: toInt(item.anidb_aid),
  };
}

// Pages through one query until a page is empty or brings nothing new
// (an unsupported paging param just repeats page 1 — the repeat check
// ends that after one extra request, same defense nyaa-search.js uses).
async function fetchAllPages(baseParams) {
  const seen = new Set();
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const params = page > 1 ? { ...baseParams, page: String(page) } : baseParams;
    const items = (await fetchFeed(params)).map(mapItem).filter((r) => r.magnetUrl);
    const fresh = items.filter((r) => {
      const key = r.infoHash || r.magnetUrl;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (fresh.length === 0) break;
    out.push(...fresh);
  }
  return out;
}

// ID-scoped search. Returns null (not []) when the feed didn't honor the
// AniDB filter — every item tagged with some *other* anime, or no item
// tagged at all so there's no way to tell — so the caller falls back to
// title search instead of trusting unscoped results.
async function searchByAnidbId(aid) {
  const results = await fetchAllPages({ aid: String(aid) });
  if (results.length === 0) return [];
  const tagged = results.filter((r) => r.anidbAid != null);
  const matching = tagged.filter((r) => r.anidbAid === aid);
  if (tagged.length === 0 || matching.length === 0) {
    logWarn('IndexerService', `AnimeTosho AniDB #${aid} request came back unscoped (${results.length} item(s), ${matching.length} tagged with that ID) — falling back to title search.`);
    return null;
  }
  // Untagged items in an ID-scoped response are AnimeTosho's own grouping;
  // keep only the ones it explicitly ties to this anime.
  return matching;
}

async function searchByTitles(series, matchFn, { extraQueryTerm } = {}) {
  const attempts = [];
  if (extraQueryTerm) attempts.push(`${series.title} ${extraQueryTerm}`);
  attempts.push(series.title);
  const primaryCount = attempts.length;
  try { attempts.push(...(series.alt_titles ? JSON.parse(series.alt_titles) : [])); } catch { /* malformed — ignore */ }
  const seen = new Set();
  for (const [i, attempt] of attempts.entries()) {
    const q = simplifyTitleForSearch(attempt);
    if (q.length < 2 || seen.has(q) || (i >= primaryCount && !isUsableAltQuery(q))) continue;
    seen.add(q);
    const results = await fetchAllPages({ q });
    const matches = await matchFn(results);
    logInfo('IndexerService', `AnimeTosho query "${q}": ${results.length} result(s), ${matches.length} matched.`);
    if (matches.length > 0) return matches;
  }
  return [];
}

async function toReleaseCandidates(matches, extra, profile) {
  const releases = await Promise.all(matches.map(async (r) => ({
    title: r.title,
    quality: await classifyQualityFromTitle(r.title),
    sizeBytes: r.sizeBytes,
    indexer: 'AnimeTosho',
    protocol: 'torrent',
    seeders: r.seeders,
    magnetUrl: r.magnetUrl,
    infoHash: r.infoHash,
    infoUrl: r.infoUrl,
    fileCount: r.fileCount || null,
    source: 'real',
    ...extra,
  })));
  return (await rankReleaseCandidates(releases, { profile })).slice(0, CANDIDATE_LIMIT);
}

// AniDB splits a show into one anime entry per season/part, and the ID
// stored on a series is its first one — so an ID-scoped search is only
// right for season 1 (or a whole-series search). Later seasons use titles.
function canUseAnidbId(series, seasonNumber) {
  return !!series.anidb_id && (seasonNumber == null || Number(seasonNumber) === 1);
}

async function searchReleasesForEpisode(series, episode, profile) {
  const label = `"${series.title}" S${String(episode.seasonNumber ?? 1).padStart(2, '0')}E${String(episode.num).padStart(2, '0')}`;
  const filter = async (results) => results.filter((r) => (
    titleMatchesEpisode(r.title, episode.num)
    && classifyReleaseShape(r.title) !== 'batch'
    && !(r.numFiles != null && r.numFiles > 3) // an episode plus a subtitle/font file or two, not a pack
  ));
  try {
    let matches = null;
    if (canUseAnidbId(series, episode.seasonNumber)) {
      const scoped = await searchByAnidbId(series.anidb_id);
      if (scoped) matches = await filter(scoped);
      if (matches) logInfo('IndexerService', `AnimeTosho AniDB #${series.anidb_id} for ${label}: ${scoped.length} release(s) for this anime, ${matches.length} for this episode.`);
    }
    if (!matches || matches.length === 0) matches = await searchByTitles(series, filter);
    return { ok: true, releases: await toReleaseCandidates(matches, undefined, profile) };
  } catch (err) {
    logWarn('IndexerService', `AnimeTosho search failed for ${label}: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function searchBatchReleases(series, { extraQueryTerm, profile, seasonNumber } = {}) {
  const label = `AnimeTosho batch search for "${series.title}"`;
  // Pack-titled → keep. Unlabeled → keep only once its real file list shows
  // 2+ episodes (torrent-files.js), unless AnimeTosho already says it's a
  // single file. Single-episode-titled → never.
  const filter = async (results) => {
    const inSeason = results.filter((r) => releaseCoversSeason(r.title, seasonNumber));
    const labeled = inSeason.filter((r) => classifyReleaseShape(r.title) === 'batch');
    const unlabeled = inSeason.filter((r) => classifyReleaseShape(r.title) === 'unknown' && r.numFiles !== 1);
    const verified = unlabeled.length > 0 ? await keepVerifiedPacks(unlabeled, { label }) : [];
    return [...labeled, ...verified];
  };
  try {
    let matches = null;
    if (canUseAnidbId(series, seasonNumber)) {
      const scoped = await searchByAnidbId(series.anidb_id);
      if (scoped) {
        matches = await filter(scoped);
        logInfo('IndexerService', `${label}: AniDB #${series.anidb_id} has ${scoped.length} release(s), ${matches.length} of them packs.`);
      }
    }
    if (!matches || matches.length === 0) matches = await searchByTitles(series, filter, { extraQueryTerm });
    return { ok: true, releases: await toReleaseCandidates(matches, { isBatch: true }, profile) };
  } catch (err) {
    logWarn('IndexerService', `${label} failed: ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function testAnimeToshoReachable() {
  try {
    await fetchFeed({ q: 'kitsune-connectivity-check' });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { searchReleasesForEpisode, searchBatchReleases, testAnimeToshoReachable, mapItem, base32ToHex };
