// ---------------------------------------------------------------------------
// Cross-site anime IDs (MyAnimeList / AniList / AniDB / TheTVDB) for every
// series, plus the extra titles those IDs unlock.
//
// Why: release indexers know nothing about any of these IDs — a Nyaa.si
// release is just a title and a file list — so an ID can't be *searched*
// directly on Nyaa. What an ID gives is certainty about which show this is,
// and that unlocks:
//   - every known name for it (AniList's English/romaji titles + synonyms),
//     so title search gets more than the one or two names the add-time
//     search result happened to carry (see nyaa-search.js's
//     searchWithFallback, which walks series.alt_titles in order);
//   - ID-keyed release sources: AnimeTosho (by AniDB ID — see
//     animetosho-search.js) and SeaDex (by AniList ID — see seadex.js).
//
// The ID mapping itself comes from Fribb/anime-lists' anime-list-full.json
// (an automatic merge of manami-project/anime-offline-database and
// Anime-Lists/anime-lists; ~7.5 MB, ~40k entries, keyed fields `mal_id`,
// `anilist_id`, `anidb_id`, `tvdb_id`, plus `season.tvdb` for which TVDB
// season a MAL/AniList/AniDB entry corresponds to). Downloaded once into
// data/, re-downloaded weekly; a failed refresh keeps using the old copy.
// Override the source with ANIME_LIST_URL in .env (e.g. a local mirror).
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { logInfo, logWarn, logDebug } = require('../logger');

const ANIME_LIST_URL = process.env.ANIME_LIST_URL
  || 'https://raw.githubusercontent.com/Fribb/anime-lists/master/anime-list-full.json';
const CACHE_FILE = path.join(db.DATA_DIR, 'anime-list-full.json');
const REFRESH_AFTER_MS = 7 * 24 * 60 * 60 * 1000;
const DOWNLOAD_TIMEOUT_MS = 60000;
const ANILIST_GRAPHQL = 'https://graphql.anilist.co';
const MAX_ALT_TITLES = 12;

let index = null; // { byMal, byAnilist, byAnidb, byTvdb } once loaded
let loading = null;

function toInt(v) {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function buildIndex(list) {
  const byMal = new Map();
  const byAnilist = new Map();
  const byAnidb = new Map();
  const byTvdb = new Map();
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const mal = toInt(e.mal_id);
    const al = toInt(e.anilist_id);
    const adb = toInt(e.anidb_id);
    const tvdb = toInt(e.tvdb_id);
    if (mal && !byMal.has(mal)) byMal.set(mal, e);
    if (al && !byAnilist.has(al)) byAnilist.set(al, e);
    if (adb && !byAnidb.has(adb)) byAnidb.set(adb, e);
    if (tvdb) {
      if (!byTvdb.has(tvdb)) byTvdb.set(tvdb, []);
      byTvdb.get(tvdb).push(e);
    }
  }
  return { byMal, byAnilist, byAnidb, byTvdb, size: list.length };
}

async function downloadList() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
  try {
    const res = await fetch(ANIME_LIST_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const text = await res.text();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed) || parsed.length < 1000) throw new Error('unexpected format (not a large JSON array)');
    const tmp = `${CACHE_FILE}.tmp`;
    await fs.promises.writeFile(tmp, text);
    await fs.promises.rename(tmp, CACHE_FILE);
    return parsed;
  } finally {
    clearTimeout(timer);
  }
}

async function readCachedList() {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(CACHE_FILE, 'utf8'));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

// Loads the mapping (from data/ if fresh, otherwise downloading a new copy).
// Never throws: returns null when no copy is available at all, and every
// caller treats that as "IDs unknown for now," same as a show the mapping
// simply doesn't cover.
async function ensureIndex({ forceRefresh = false } = {}) {
  if (index && !forceRefresh) return index;
  if (loading) return loading;
  loading = (async () => {
    let stat = null;
    try { stat = await fs.promises.stat(CACHE_FILE); } catch { /* no cached copy yet */ }
    const stale = !stat || forceRefresh || Date.now() - stat.mtimeMs > REFRESH_AFTER_MS;
    let list = null;
    if (stale) {
      try {
        list = await downloadList();
        logInfo('AnimeIds', `Downloaded anime ID mapping (${list.length} entries) from ${ANIME_LIST_URL}`);
      } catch (err) {
        logWarn('AnimeIds', `Couldn't download the anime ID mapping (${err.message})${stat ? ' — using the cached copy' : ''}`);
      }
    }
    if (!list) list = await readCachedList();
    if (list) index = buildIndex(list);
    return index;
  })();
  try {
    return await loading;
  } finally {
    loading = null;
  }
}

// A TVDB ID covers a whole show, while MAL/AniList/AniDB split it into one
// entry per season/part — so a TVDB lookup can match several entries. The
// one that maps to TVDB season 1 (or, failing that, the earliest TV entry)
// is what a TVDB-added series most plausibly means.
function pickTvdbEntry(entries) {
  if (!entries || entries.length === 0) return null;
  const s1 = entries.find((e) => e.season && Number(e.season.tvdb) === 1 && String(e.type || '').toUpperCase() === 'TV')
    || entries.find((e) => e.season && Number(e.season.tvdb) === 1);
  if (s1) return s1;
  return entries.find((e) => String(e.type || '').toUpperCase() === 'TV') || entries[0];
}

// Given whatever IDs are already known, fills in the rest. Returns
// { malId, anilistId, anidbId, tvdbId, tvdbSeason } (nulls where unknown).
async function resolveIds({ malId, anilistId, anidbId, tvdbId } = {}) {
  const idx = await ensureIndex();
  const known = { malId: toInt(malId), anilistId: toInt(anilistId), anidbId: toInt(anidbId), tvdbId: toInt(tvdbId) };
  if (!idx) return { ...known, tvdbSeason: null, mappingAvailable: false };
  const entry = (known.malId && idx.byMal.get(known.malId))
    || (known.anilistId && idx.byAnilist.get(known.anilistId))
    || (known.anidbId && idx.byAnidb.get(known.anidbId))
    || (known.tvdbId && pickTvdbEntry(idx.byTvdb.get(known.tvdbId)))
    || null;
  if (!entry) return { ...known, tvdbSeason: null, mappingAvailable: true };
  return {
    mappingAvailable: true,
    malId: known.malId || toInt(entry.mal_id),
    anilistId: known.anilistId || toInt(entry.anilist_id),
    anidbId: known.anidbId || toInt(entry.anidb_id),
    tvdbId: known.tvdbId || toInt(entry.tvdb_id),
    tvdbSeason: entry.season && Number.isInteger(Number(entry.season.tvdb)) ? Number(entry.season.tvdb) : null,
  };
}

// AniList's public GraphQL API (no key needed). Returns every title AniList
// knows the show by — English, romaji, native, and its synonyms list (which
// is where fansub-style short names like "S·A" or "SA" tend to live).
async function fetchAniListTitles(anilistId) {
  const query = 'query ($id: Int) { Media(id: $id, type: ANIME) { id idMal title { romaji english native } synonyms } }';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(ANILIST_GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ query, variables: { id: Number(anilistId) } }),
      signal: controller.signal,
    });
    if (res.status === 429) throw new Error('AniList is rate-limiting us');
    const json = await res.json().catch(() => null);
    const media = json && json.data && json.data.Media;
    if (!res.ok || !media) throw new Error((json && json.errors && json.errors[0] && json.errors[0].message) || `status ${res.status}`);
    const t = media.title || {};
    return {
      english: t.english || null,
      romaji: t.romaji || null,
      native: t.native || null,
      synonyms: Array.isArray(media.synonyms) ? media.synonyms.filter(Boolean) : [],
    };
  } finally {
    clearTimeout(timer);
  }
}

// Merges new titles onto a series' existing alt_titles: existing ones keep
// their position (search tries them in order), new ones are appended,
// case-insensitive duplicates and the series' own title are dropped.
function mergeAltTitles(seriesTitle, existingJson, additions) {
  let existing = [];
  try { existing = existingJson ? JSON.parse(existingJson) : []; } catch { existing = []; }
  const seen = new Set([String(seriesTitle || '').trim().toLowerCase()]);
  const out = [];
  for (const t of [...existing, ...additions]) {
    const clean = String(t || '').trim();
    const key = clean.toLowerCase();
    if (!clean || clean.length > 200 || seen.has(key)) continue;
    seen.add(key);
    out.push(clean);
    if (out.length >= MAX_ALT_TITLES) break;
  }
  return out;
}

// Fills in mal_id/anilist_id/anidb_id/tvdb_id for one series and merges
// AniList's titles into alt_titles. Safe to call repeatedly; never throws.
// Returns the updated row (or null if the series is gone).
async function enrichSeriesIds(seriesId) {
  try {
    const row = await db.prepare('SELECT * FROM series WHERE id = ?').get(seriesId);
    if (!row) return null;
    const ids = await resolveIds({
      malId: row.mal_id || (row.external_source === 'mal' ? row.external_id : null),
      anilistId: row.anilist_id,
      anidbId: row.anidb_id,
      tvdbId: row.tvdb_id || (row.external_source === 'tvdb' ? row.external_id : null),
    });

    let altTitles = null;
    if (ids.anilistId) {
      try {
        const t = await fetchAniListTitles(ids.anilistId);
        const merged = mergeAltTitles(row.title, row.alt_titles, [t.english, t.romaji, ...t.synonyms, t.native]);
        altTitles = merged.length > 0 ? JSON.stringify(merged) : null;
      } catch (err) {
        logDebug('AnimeIds', `AniList titles for "${row.title}" (AniList #${ids.anilistId}) unavailable: ${err.message}`);
      }
    }

    // ids_checked_at only when the mapping was actually consulted — if it
    // couldn't be downloaded at all, leave the row unchecked so the next
    // start (or the next manual refresh) tries again, rather than waiting
    // out backfillSeriesIds' 30-day re-check window for a lookup that never
    // really happened.
    await db.prepare(`
      UPDATE series SET mal_id = ?, anilist_id = ?, anidb_id = ?, tvdb_id = ?, alt_titles = COALESCE(?, alt_titles),
        ids_checked_at = CASE WHEN ? = 1 THEN ? ELSE ids_checked_at END
      WHERE id = ?
    `).run(ids.malId, ids.anilistId, ids.anidbId, ids.tvdbId, altTitles, ids.mappingAvailable ? 1 : 0, db.now(), seriesId);

    const found = ['malId', 'anilistId', 'anidbId', 'tvdbId'].filter((k) => ids[k]).map((k) => `${k.replace('Id', '')} #${ids[k]}`);
    logInfo('AnimeIds', `"${row.title}": ${found.length > 0 ? found.join(', ') : 'no cross-site IDs found'}${altTitles ? ` — ${JSON.parse(altTitles).length} alternate title(s) for search` : ''}`);
    return db.prepare('SELECT * FROM series WHERE id = ?').get(seriesId);
  } catch (err) {
    logWarn('AnimeIds', `ID lookup failed for series ${seriesId}: ${err.message}`);
    return null;
  }
}

// One-time-ish catch-up for series added before IDs existed (or whose last
// check found nothing and is over a month old — the mapping grows weekly).
// Runs in the background, gently paced: AniList's public API allows only a
// few dozen requests a minute.
async function backfillSeriesIds() {
  const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ');
  const pending = await db.prepare(`
    SELECT id FROM series WHERE ids_checked_at IS NULL OR (anilist_id IS NULL AND ids_checked_at < ?) ORDER BY id ASC
  `).all(cutoff);
  if (pending.length === 0) return;
  (async () => {
    const idx = await ensureIndex();
    if (!idx) return; // no mapping available at all — try again next start
    logInfo('AnimeIds', `Looking up cross-site IDs for ${pending.length} series in the background`);
    for (const { id } of pending) {
      await enrichSeriesIds(id);
      await new Promise((r) => setTimeout(r, 2500));
    }
  })().catch((err) => logWarn('AnimeIds', `Background ID backfill stopped: ${err.message}`));
}

module.exports = { ensureIndex, resolveIds, fetchAniListTitles, mergeAltTitles, enrichSeriesIds, backfillSeriesIds, pickTvdbEntry };
