// ---------------------------------------------------------------------------
// Reads a torrent's real file list, for the one question a release title
// can't always answer: "is this a season pack or a single episode?"
//
// Real, confirmed miss that motivated this: "[neoHEVC] Special A Class S.A.
// [DVD 480p x265 HEVC AC3] [Dual Audio]" is a 24-episode, 6.5 GiB complete
// series pack on Nyaa.si, but its title has no episode range, no "Batch"/
// "Complete", and no season tag — so nyaa-search.js's isBatchRelease
// (title-only) said "not a batch," and Search All silently dropped it even
// though the search itself found it. Plenty of encoders (neoHEVC, and
// others) name full-series packs exactly like this; the episode count only
// lives in the torrent's file list.
//
// classifyReleaseShape (nyaa-search.js) sorts titles into batch / single /
// unknown; only "unknown" ones come here, and only a capped number per
// search (see MAX_VERIFICATIONS_PER_SEARCH), so this costs a handful of
// small .torrent downloads (a few KB each), not one per search result.
// Results are cached by URL for the life of the process — a torrent's file
// list never changes.
// ---------------------------------------------------------------------------
const { listTorrentFiles } = require('./bencode');
const { logDebug } = require('../logger');

const REQUEST_TIMEOUT_MS = 10000;
const MAX_TORRENT_BYTES = 8 * 1024 * 1024; // a .torrent past this is not a file list we need to read
const USER_AGENT = 'Mozilla/5.0 (compatible; Kitsune/1.0; self-hosted anime library manager)';
const VIDEO_EXT = /\.(mkv|mp4|avi|m2ts|ts|webm|wmv|mov|m4v|ogm|flv)$/i;
// Creditless OP/ED, trailers, menus etc. ship inside plenty of single-
// episode-plus-extras torrents too — they're videos, but they're not
// episodes, so they don't count toward "this holds several episodes."
const EXTRA_VIDEO = /\b(NCOP|NCED|NC\s?OP|NC\s?ED|creditless|opening|ending|trailer|teaser|preview|PV|CM|menu|extras?|bonus|specials?\/)\b/i;
const MAX_VERIFICATIONS_PER_SEARCH = 10;

const cache = new Map(); // url -> { files } | { error }

async function fetchTorrentFiles(url) {
  if (cache.has(url)) return cache.get(url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let result;
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'User-Agent': USER_AGENT } });
    if (!res.ok) throw new Error(`status ${res.status}`);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_TORRENT_BYTES) throw new Error('torrent file too large');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_TORRENT_BYTES) throw new Error('torrent file too large');
    result = { files: listTorrentFiles(buf) };
  } catch (err) {
    result = { error: err.name === 'AbortError' ? `timed out after ${REQUEST_TIMEOUT_MS / 1000}s` : err.message };
  } finally {
    clearTimeout(timer);
  }
  // Only cache real answers — a timeout or a 5xx should get another try
  // on the next search rather than being remembered forever.
  if (result.files) cache.set(url, result);
  return result;
}

// How many real episode files a torrent's file list holds.
function countEpisodeFiles(files) {
  return files.filter((f) => VIDEO_EXT.test(f.path) && !EXTRA_VIDEO.test(f.path)).length;
}

// Takes releases whose title couldn't be classified, each carrying a
// `torrentUrl`, and returns only the ones whose real file list holds 2+
// episode files — annotated with `fileCount`. Biggest first (a real pack is
// almost always the largest thing a title search turns up), capped at
// MAX_VERIFICATIONS_PER_SEARCH so one search never fans out into dozens of
// requests. A torrent that can't be fetched is dropped, same as before this
// existed (it was never kept before either).
async function keepVerifiedPacks(candidates, { label = 'search' } = {}) {
  const ordered = [...candidates].filter((r) => r.torrentUrl).sort((a, b) => (b.sizeBytes || 0) - (a.sizeBytes || 0));
  const toCheck = ordered.slice(0, MAX_VERIFICATIONS_PER_SEARCH);
  const kept = [];
  // Three at a time — polite to the indexer, still quick for 10.
  for (let i = 0; i < toCheck.length; i += 3) {
    const chunk = toCheck.slice(i, i + 3);
    const outcomes = await Promise.all(chunk.map(async (r) => ({ r, out: await fetchTorrentFiles(r.torrentUrl) })));
    for (const { r, out } of outcomes) {
      if (out.error) {
        logDebug('IndexerService', `${label}: couldn't read file list for "${r.title}" (${out.error}) — skipped.`);
        continue;
      }
      const episodes = countEpisodeFiles(out.files);
      logDebug('IndexerService', `${label}: "${r.title}" holds ${episodes} episode file(s) of ${out.files.length} file(s) — ${episodes >= 2 ? 'kept as a pack' : 'not a pack'}.`);
      if (episodes >= 2) kept.push({ ...r, fileCount: episodes });
    }
  }
  if (ordered.length > toCheck.length) {
    logDebug('IndexerService', `${label}: ${ordered.length - toCheck.length} more unlabeled release(s) not checked (cap ${MAX_VERIFICATIONS_PER_SEARCH}).`);
  }
  return kept;
}

module.exports = { fetchTorrentFiles, countEpisodeFiles, keepVerifiedPacks, VIDEO_EXT };
