// ---------------------------------------------------------------------------
// Quality tier ranking — reads the live 'quality-tiers' settings_items rows
// (Settings > Quality, see server/routes/settings-items.js's seed + README's
// Quality Definitions section) instead of a hardcoded array. Tiers are fully
// user-managed now (add/rename/delete/reorder from the page itself), so
// "worst to best" order can't be a static constant anymore — a row's
// `position` (ORDER BY already used everywhere else settings_items is read)
// *is* its rank, and re-deriving it per call means a reorder takes effect
// everywhere (Cutoff Unmet, release-generation weighting) the moment it's
// saved, with nothing to invalidate or keep in sync.
//
// This is a tiny table (a dozen-ish rows even for a heavily-customized
// install) read with a plain indexed query, so doing this per call instead
// of caching is not a real cost — and caching would just reintroduce the
// "now two things can disagree" problem this rewrite exists to remove.
// ---------------------------------------------------------------------------
const { db } = require('../db');

function getQualityTiers() {
  const rows = db.prepare(
    "SELECT * FROM settings_items WHERE section = 'quality-tiers' ORDER BY position ASC, id ASC"
  ).all();
  return rows.map((row) => ({ id: row.id, ...JSON.parse(row.data) }));
}

function getQualityOrder() {
  return getQualityTiers().map((t) => t.name);
}

// Unranked/unknown qualities sort below everything real — treated as "worse
// than the lowest known tier" rather than throwing, since a hand-entered
// Custom Format name, a typo'd quality string, or a tier that's since been
// deleted from Settings > Quality shouldn't crash a comparison.
function qualityRank(name) {
  return getQualityOrder().indexOf(name);
}

// True when `quality` is strictly below `cutoff` on the tier ladder — the
// same "hasn't met its profile's cutoff yet, eligible for an upgrade search"
// condition real Sonarr uses to populate Cutoff Unmet.
function isBelowCutoff(quality, cutoff) {
  if (!cutoff) return false; // no cutoff defined for this profile — nothing to compare against
  return qualityRank(quality) < qualityRank(cutoff);
}

// Looks up a Quality Profile by name (series.quality_profile stores just the
// profile's name — see server/routes/series.js) for search/grab to consult.
// `allowedQualities` defaults to every currently-known tier name when a
// profile predates this field (any row saved before Settings > Profiles'
// checklist existed) or names a tier that's since been deleted from Settings
// > Quality — the same "don't silently exclude everything because of a
// stale/missing field" reasoning ProfilesPage.jsx's own frontend default
// uses. Returns null only when no profile with this name exists at all
// (deleted, renamed, or the series was never assigned one) — callers treat
// that as "no profile to rank against," not an error.
function getQualityProfile(name) {
  if (!name) return null;
  // Fetched and matched in JS rather than a SQL json_extract() filter — same
  // "small table, parse in JS" convention every other settings_items reader
  // in this app already uses (see e.g. queue.js's pickQbittorrentClient).
  const rows = db.prepare("SELECT * FROM settings_items WHERE section = 'profiles'").all();
  const row = rows.find((r) => JSON.parse(r.data).name === name);
  if (!row) return null;
  const data = JSON.parse(row.data);
  const knownTiers = getQualityOrder();
  const allowedQualities = Array.isArray(data.allowedQualities) && data.allowedQualities.length > 0
    ? data.allowedQualities.filter((n) => knownTiers.includes(n))
    : knownTiers;
  return { id: row.id, name: data.name, cutoff: data.cutoff || null, upgrades: !!data.upgrades, allowedQualities };
}

// A tier's real-world size varies with runtime (a 24-minute episode and a
// 90-minute movie-length special at the same quality tier are very
// different file sizes), which is exactly why Settings > Quality stores
// min/preferred/max as MB *per minute* rather than a flat size — this turns
// that rate into an absolute preferred size in bytes for one specific
// episode's runtime, the number release ranking actually needs to compare
// against a real release's real sizeBytes. Falls back to a typical anime
// episode's runtime (24 minutes) when the episode's own runtime isn't known
// (unset in the library, or this is being computed for a whole-season/series
// batch release that doesn't correspond to one specific episode).
const FALLBACK_RUNTIME_MINUTES = 24;

function preferredSizeBytes(tierName, runtimeMinutes) {
  const tier = getQualityTiers().find((t) => t.name === tierName);
  if (!tier || typeof tier.preferredMBPerMin !== 'number') return null;
  const minutes = typeof runtimeMinutes === 'number' && runtimeMinutes > 0 ? runtimeMinutes : FALLBACK_RUNTIME_MINUTES;
  return Math.round(tier.preferredMBPerMin * minutes * 1024 * 1024);
}

// ---------------------------------------------------------------------------
// Shared release ranking — one real implementation reused by every place a
// list of release candidates gets sorted: nyaa-search.js's and
// prowlarr-search.js's own toReleaseCandidates() (each indexer's own
// pre-merge sort/slice) and routes/releases.js's sortAndLimitReleases() (the
// merged multi-indexer sort). Previously each of those had its own separate
// "tier rank, then seeders" sort; profile-awareness needs to happen at every
// one of those sort points, not just the final merge, since nyaa-search.js/
// prowlarr-search.js each slice down to their own CANDIDATE_LIMIT *before*
// releases.js ever sees the list — a genuinely great in-profile match ranked
// #9 by the old tier-only sort could otherwise get cut before profile
// awareness ever had a chance to promote it.
//
// Deliberately does NOT filter anything out — every release the indexer(s)
// actually found is still returned, just reordered and annotated with
// `inProfile` so the picker modal can flag out-of-profile releases instead
// of hiding them (a user's own explicit choice over "just filter them out,"
// since a release outside the profile might still be the only thing
// available for an obscure/old episode).
//
// Sort order: in-profile releases first as a group, then (within each group)
// better quality tier first, then — the actual "target file size" behavior
// this was built for — closer to that tier's own preferred size first, then
// more seeders as a final tiebreaker. A release with no size data (0 bytes,
// or its tier has no preferred size configured) sorts after same-tier
// releases that do have a usable size comparison, rather than being treated
// as a perfect (distance-0) match by accident.
function rankReleaseCandidates(releases, { profile, runtimeMinutes } = {}) {
  const order = getQualityOrder();
  const allowed = profile ? new Set(profile.allowedQualities) : null;

  function sizeDistance(release) {
    if (!release.sizeBytes) return Infinity;
    const target = preferredSizeBytes(release.quality, runtimeMinutes);
    if (target == null) return Infinity;
    return Math.abs(release.sizeBytes - target);
  }

  const annotated = releases.map((r) => ({ ...r, inProfile: allowed ? allowed.has(r.quality) : true }));
  annotated.sort((a, b) => {
    if (a.inProfile !== b.inProfile) return a.inProfile ? -1 : 1;
    const rankDiff = order.indexOf(b.quality) - order.indexOf(a.quality);
    if (rankDiff !== 0) return rankDiff;
    const sizeDiff = sizeDistance(a) - sizeDistance(b);
    if (sizeDiff !== 0) return sizeDiff;
    return (b.seeders || 0) - (a.seeders || 0);
  });
  return annotated;
}

module.exports = {
  getQualityTiers, getQualityOrder, qualityRank, isBelowCutoff, getQualityProfile, preferredSizeBytes,
  rankReleaseCandidates,
};
