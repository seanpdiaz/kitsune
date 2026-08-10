const { getQualityTiers, getQualityOrder } = require('./quality');

// ---------------------------------------------------------------------------
// Simulated release search + download — the piece that was entirely missing
// before tonight: every "Search" button in the app (Wanted > Missing/Cutoff
// Unmet) was previously just a 700ms fake spinner with no results and no
// grab, and Activity > Queue/History/Blocklist were static in-file arrays
// with no relationship to the real Library at all (see README).
//
// This does NOT talk to any real indexer or download client — actually
// searching real torrent/usenet trackers is both outside what this sandbox
// can safely reach and a different kind of legal/content surface than the
// rest of this project (real filesystem access, real metadata APIs) has
// touched, so the same "simulate what a real integration would look like"
// approach this project already uses elsewhere (Activity's original mock
// data, the pre-persistence mockup pages) applies here too — just now it's
// simulated server-side and driven by real Library/episode data instead of
// a hardcoded array that never changed.
//
// Everything below is deterministic per (episode id, candidate index): the
// same episode always generates the same set of fake releases, so searching
// twice shows the same options rather than reshuffling randomly, and a grab
// (POST /api/queue) can cheaply re-derive the exact release the client
// picked from just its index instead of trusting a client-supplied title/
// quality/size wholesale.
// ---------------------------------------------------------------------------

const FANSUB_GROUPS = [
  'SubsPlease', 'Erai-raws', 'Judas', 'ASW', 'Anime Time', 'CBM', 'HorribleSubs', 'Kametsu',
];
const INDEXERS = ['Nyaa.si', 'AnimeBytes', 'SubsPlease RSS', 'AniDex'];
const PROTOCOLS = ['torrent', 'torrent', 'torrent', 'usenet']; // mostly torrent, matching real anime-scene norms

// mulberry32 — small, fast, deterministic PRNG. Math.random() can't be
// seeded, and this only ever needs to look "random enough" for fake release
// names/sizes, not be cryptographically sound.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function seedFor(episodeId, salt) {
  // Small mix, not cryptographic — just enough to spread episodeId/salt
  // apart so adjacent episode ids don't produce near-identical sequences.
  return ((episodeId * 2654435761) ^ (salt * 40503)) >>> 0;
}

function pick(rand, arr) {
  return arr[Math.floor(rand() * arr.length)];
}

// Anime releases skew heavily toward 1080p with some 720p and the occasional
// 2160p/SD outlier — weighted by resolution group (not a fixed per-tier
// table) so the common case still dominates results the way real anime
// release groups mostly put out, but it keeps working once tiers stop being
// a fixed list (see Settings > Quality / README's Quality Definitions
// section — quality tiers are user-managed now: added, renamed, deleted,
// reordered from that page). Weight is per tier within a group, so a group
// with more tiers defined shows up proportionally more often rather than
// getting diluted to match a group with only one — a resolution nobody's
// bothered to break into multiple tiers doesn't get penalized for it.
// A resolutionGroup that isn't one of the four common ones (a custom group a
// user made up) gets DEFAULT_GROUP_WEIGHT — present, but not dominant.
const GROUP_WEIGHT = { 'SD': 2, '720p': 6, '1080p': 14, '2160p': 3 };
const DEFAULT_GROUP_WEIGHT = 4;

function pickRealisticQuality(rand) {
  const tiers = getQualityTiers();
  if (tiers.length === 0) return 'Unknown'; // every tier deleted — degenerate config, not a crash
  const weights = tiers.map((t) => GROUP_WEIGHT[t.resolutionGroup] ?? DEFAULT_GROUP_WEIGHT);
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  let r = rand() * totalWeight;
  for (let i = 0; i < tiers.length; i++) {
    r -= weights[i];
    if (r <= 0) return tiers[i].name;
  }
  return tiers[tiers.length - 1].name;
}

// Release/episode sizes are derived straight from each tier's own *preferred*
// MB/min (the same number Settings > Quality's slider shows as "Target
// Size") times a fixed reference episode length, rather than a second,
// separate table of "realistic" sizes that could quietly drift out of sync
// with whatever the user has actually configured on that page. Whatever a
// tier's target size says, that's what a simulated release of that quality
// weighs in at (+/-15% jitter so same-quality releases from different groups
// don't all report byte-identical sizes) — genuinely one number, not two.
const REFERENCE_EPISODE_MINUTES = 24; // a typical anime TV episode, OP/ED included

function pickRealisticSizeBytes(quality, rand) {
  const tier = getQualityTiers().find((t) => t.name === quality);
  const baseMb = tier ? tier.preferredMBPerMin * REFERENCE_EPISODE_MINUTES : 500;
  const jitter = 0.85 + rand() * 0.3; // 0.85x - 1.15x
  return Math.round(baseMb * jitter * 1024 * 1024);
}

function episodeCode(episode) {
  const s = String(episode.seasonNumber ?? episode.season_number ?? 1).padStart(2, '0');
  const e = String(episode.num).padStart(2, '0');
  return `S${s}E${e}`;
}

function makeReleaseTitle(series, episode, quality, group, rand) {
  const cleanTitle = series.title.replace(/[^A-Za-z0-9]+/g, ' ').trim();
  const hash = Math.floor(rand() * 0xffffff).toString(16).toUpperCase().padStart(6, '0');
  if (rand() < 0.5) {
    // Fansub-style: "[Group] Title - 12 (1080p) [ABCDEF12]"
    const short = quality.replace(/^(WEBDL|Bluray|HDTV)-/, '');
    return `[${group}] ${cleanTitle} - ${String(episode.num).padStart(2, '0')} (${short}) [${hash}]`;
  }
  // Scene-style: "Title.S02E12.1080p.WEB.h264-GROUP"
  const dotted = cleanTitle.replace(/\s+/g, '.');
  const src = quality.startsWith('WEBDL') ? 'WEB' : quality.startsWith('Bluray') ? 'BluRay' : 'HDTV';
  const res = quality.replace(/^[A-Za-z]+-/, '');
  return `${dotted}.${episodeCode(episode)}.${res}.${src}.h264-${group}`;
}

const CANDIDATE_COUNT = 5;

// Deterministically generates CANDIDATE_COUNT fake release candidates for a
// given episode, best-quality-first (ties broken by size ascending — a
// smaller file at the same quality reads as a "more efficient" encode,
// mirroring how real indexer result lists commonly sort). Each candidate's
// `index` is what POST /api/queue's { episodeId, releaseIndex } takes to
// grab it without the client needing to round-trip the full release object.
function generateReleases(series, episode) {
  const releases = [];
  for (let i = 0; i < CANDIDATE_COUNT; i++) {
    const rand = mulberry32(seedFor(episode.id, i));
    const quality = pickRealisticQuality(rand);
    const group = pick(rand, FANSUB_GROUPS);
    const sizeBytes = pickRealisticSizeBytes(quality, rand);
    releases.push({
      index: i,
      title: makeReleaseTitle(series, episode, quality, group, rand),
      quality,
      sizeBytes,
      indexer: pick(rand, INDEXERS),
      protocol: pick(rand, PROTOCOLS),
      seeders: Math.floor(rand() * 180) + 3,
    });
  }
  const order = getQualityOrder(); // fetched once per search, not once per comparison
  releases.sort((a, b) => {
    const rankDiff = order.indexOf(b.quality) - order.indexOf(a.quality);
    if (rankDiff !== 0) return rankDiff;
    return a.sizeBytes - b.sizeBytes;
  });
  return releases;
}

module.exports = {
  generateReleases, pickRealisticQuality, pickRealisticSizeBytes, mulberry32, seedFor,
};
