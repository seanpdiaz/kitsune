// ---------------------------------------------------------------------------
// SeaDex (releases.moe) — a community-curated list of the best release for
// each anime, keyed by AniList ID. Settings > Indexers type 'seadex'.
//
// Two jobs, both keyed off a series' AniList ID (server/lib/anime-ids.js):
//   1. Ranking signal. Any release from any indexer whose info hash SeaDex
//      lists gets `seadex: 'best'` (SeaDex's pick) or `seadex: 'alt'` (a
//      listed alternative); quality.js's rankReleaseCandidates puts those
//      first among in-profile releases, so "Grab best match" grabs the
//      community's pick when one was found.
//   2. Source. For a whole-series or season-1 batch search, SeaDex's own
//      listed torrents on public trackers are offered directly (a magnet
//      built from the listed info hash), so the pick shows up even if no
//      title search turned it up.
//
// API (PocketBase): GET /api/collections/entries/records?filter=alID=<id>
// &expand=trs — each entry's `trs` are its torrents: tracker, url,
// infoHash ("<redacted>" for private trackers), isBest, dualAudio,
// releaseGroup, tags, files [{name, length}]. Shape confirmed against the
// `seadex` Python client (Ravencentric/seadex, v0.7.3).
// ---------------------------------------------------------------------------
const { logDebug, logInfo } = require('../logger');
const { buildMagnet, classifyQualityFromTitle } = require('./nyaa-search');
const { VIDEO_EXT } = require('./torrent-files');

// releases.moe is the long-standing address; seadex.moe is the one the
// current client library defaults to. Tried in order on a network failure.
const BASE_URLS = (process.env.SEADEX_URL ? [process.env.SEADEX_URL] : ['https://releases.moe', 'https://seadex.moe'])
  .map((u) => u.replace(/\/+$/, ''));
const REQUEST_TIMEOUT_MS = 10000;
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PUBLIC_TRACKERS = { nyaa: 'https://nyaa.si', animetosho: 'https://animetosho.org', anidex: 'https://anidex.info', rutracker: 'https://rutracker.org', other: null };

const cache = new Map(); // anilistId -> { entry, expiresAt }

async function fetchJson(pathAndQuery) {
  let lastErr;
  for (const base of BASE_URLS) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}${pathAndQuery}`, { signal: controller.signal, headers: { Accept: 'application/json' } });
      if (!res.ok) throw new Error(`SeaDex returned status ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err.name === 'AbortError'
        ? new Error(`Timed out after ${REQUEST_TIMEOUT_MS / 1000}s reaching SeaDex`)
        : (/^SeaDex /.test(err.message) ? err : new Error(`Could not reach SeaDex: ${err.message}`));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('SeaDex unreachable');
}

function mapTorrent(tr) {
  const tracker = String(tr.tracker || '');
  const trackerKey = tracker.toLowerCase();
  const isPublic = Object.prototype.hasOwnProperty.call(PUBLIC_TRACKERS, trackerKey);
  const rawHash = String(tr.infoHash || '');
  const infoHash = /^[a-f0-9]{40}$/i.test(rawHash) ? rawHash.toLowerCase() : null;
  let url = typeof tr.url === 'string' ? tr.url : null;
  if (url && url.startsWith('/') && PUBLIC_TRACKERS[trackerKey]) url = PUBLIC_TRACKERS[trackerKey] + url;
  const files = Array.isArray(tr.files) ? tr.files.map((f) => ({ name: String(f.name || ''), length: Number(f.length) || 0 })) : [];
  return {
    tracker,
    isPublic,
    infoHash,
    url: url && /^https?:\/\//i.test(url) ? url : null,
    isBest: !!tr.isBest,
    dualAudio: !!tr.dualAudio,
    releaseGroup: tr.releaseGroup ? String(tr.releaseGroup) : null,
    tags: Array.isArray(tr.tags) ? tr.tags.map(String) : [],
    files,
    sizeBytes: files.reduce((n, f) => n + f.length, 0),
  };
}

// The SeaDex entry for an AniList ID, or null if SeaDex has none. Cached
// (including "none") for a few hours — picks change rarely. Throws on a
// real network/HTTP failure so the caller can report it.
async function getSeaDexEntry(anilistId) {
  const id = Number(anilistId);
  if (!Number.isInteger(id) || id <= 0) return null;
  const hit = cache.get(id);
  if (hit && hit.expiresAt > Date.now()) return hit.entry;
  const json = await fetchJson(`/api/collections/entries/records?${new URLSearchParams({
    filter: `alID=${id}`, expand: 'trs', perPage: '1', skipTotal: 'true',
  }).toString()}`);
  const item = json && Array.isArray(json.items) ? json.items[0] : null;
  const entry = item ? {
    anilistId: id,
    notes: item.notes ? String(item.notes) : '',
    incomplete: !!item.incomplete,
    torrents: (item.expand && Array.isArray(item.expand.trs) ? item.expand.trs : []).map(mapTorrent),
  } : null;
  cache.set(id, { entry, expiresAt: Date.now() + CACHE_TTL_MS });
  logDebug('IndexerService', `SeaDex AniList #${id}: ${entry ? `${entry.torrents.length} listed torrent(s)` : 'no entry'}`);
  return entry;
}

// infoHash -> 'best' | 'alt' for every hash-bearing torrent in the entry.
function flagsFromEntry(entry) {
  const flags = new Map();
  if (!entry) return flags;
  for (const t of entry.torrents) {
    if (!t.infoHash) continue;
    if (t.isBest || !flags.has(t.infoHash)) flags.set(t.infoHash, t.isBest ? 'best' : 'alt');
  }
  return flags;
}

// SeaDex's own public-tracker torrents as release candidates. SeaDex has no
// release title, so one is built from the group and the series title; the
// quality tier is read from the first episode file's name, which is where
// fansub/encode groups put the resolution.
async function releasesFromEntry(entry, series) {
  if (!entry) return [];
  const out = [];
  for (const t of entry.torrents) {
    if (!t.isPublic || !t.infoHash) continue;
    const videos = t.files.filter((f) => VIDEO_EXT.test(f.name));
    const sample = (videos[0] || t.files[0] || { name: '' }).name;
    const title = `${t.releaseGroup ? `[${t.releaseGroup}] ` : ''}${series.title}${t.dualAudio ? ' [Dual Audio]' : ''} — SeaDex ${t.isBest ? 'best' : 'alternative'}`;
    out.push({
      title,
      quality: await classifyQualityFromTitle(`${sample} ${title}`),
      sizeBytes: t.sizeBytes,
      indexer: `SeaDex (${t.tracker})`,
      protocol: 'torrent',
      seeders: 0, // SeaDex doesn't track swarm health; the same torrent from a real indexer (with seeders) wins the dedupe
      magnetUrl: buildMagnet(t.infoHash, title),
      infoHash: t.infoHash,
      infoUrl: t.url,
      fileCount: videos.length || null,
      isBatch: true,
      source: 'real',
      seadex: t.isBest ? 'best' : 'alt',
    });
  }
  return out;
}

// The releases.js entry point. `wantReleases` only for batch searches whose
// scope matches the AniList entry (whole series, or season 1 — AniList,
// like AniDB, has one entry per season and a series stores its first).
async function lookupForSearch(series, { wantReleases }) {
  if (!series.anilist_id) return { ok: true, releases: [], flags: new Map(), note: 'no AniList ID yet' };
  const entry = await getSeaDexEntry(series.anilist_id);
  const releases = wantReleases ? await releasesFromEntry(entry, series) : [];
  if (entry) logInfo('IndexerService', `SeaDex for "${series.title}" (AniList #${series.anilist_id}): ${entry.torrents.length} listed torrent(s), ${releases.length} offered directly.`);
  return { ok: true, releases, flags: flagsFromEntry(entry), entry };
}

async function testSeaDexReachable() {
  try {
    const json = await fetchJson('/api/collections/entries/records?perPage=1&skipTotal=true');
    if (!json || !Array.isArray(json.items)) return { ok: false, error: 'SeaDex responded, but not with the expected records list.' };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { getSeaDexEntry, flagsFromEntry, releasesFromEntry, lookupForSearch, testSeaDexReachable, mapTorrent };
