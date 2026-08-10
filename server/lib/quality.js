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

module.exports = { getQualityTiers, getQualityOrder, qualityRank, isBelowCutoff };
