// ---------------------------------------------------------------------------
// Persisted interval settings for System > Tasks' seven still-decorative
// rows (RSS Sync, Check for Finished Downloads, Refresh Series, Update
// Metadata Cache, Backup, Application Update Check, Housekeeping — see
// system-tasks.js's own header comment and TaskList.jsx's TASKS_DATA). None
// of these run a real background job yet — "Run Now" still just fakes a
// "Just now" timestamp client-side, and Last Run/Next Run stay decorative
// text — but the user should still be able to set and keep a real
// preferred interval for each, the same way the two genuinely-scheduled
// rows (Disk Usage Recompute, Apply Permissions — see disk-usage.js and
// permissions.js) already let them. This module is exactly that: the
// persisted half of "editable timing" without pretending there's a real
// recurring job driving any of these seven yet.
// ---------------------------------------------------------------------------
const db = require('../db');

// Own idempotent CREATE TABLE, same convention disk-usage.js's own
// app_settings declaration uses — this doesn't want to depend on require()
// order against another file to make sure the table exists first.
db.init(async () => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      section TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    )
  `);
});

const SETTINGS_SECTION = 'decorative-task-intervals';
const MIN_INTERVAL_MINUTES = 1;
const MAX_INTERVAL_MINUTES = 10080; // 1 week — same outer bound as Disk Usage/Apply Permissions' 168h

// Minutes, not hours — unlike Disk Usage Recompute/Apply Permissions (both
// naturally hour-or-longer jobs), a couple of these rows are realistically
// sub-hourly in any real Sonarr/Radarr-style app (RSS Sync, Check for
// Finished Downloads), so hour granularity alone can't represent their
// real-world default cadence at all. Every id here is the same stable key
// TaskList.jsx's TASKS_DATA uses, not the row's display name, so renaming a
// row's label later doesn't orphan its saved interval.
const DEFAULT_INTERVAL_MINUTES = {
  'rss-sync': 15,
  'check-downloads': 1,
  'refresh-series': 720, // 12h
  'metadata-cache': 720, // 12h
  'backup': 10080, // 7 days
  'update-check': 360, // 6h
  'housekeeping': 1440, // 24h
};

async function loadOverrides() {
  const row = await db.prepare('SELECT data FROM app_settings WHERE section = ?').get(SETTINGS_SECTION);
  if (!row) return {};
  try {
    const parsed = JSON.parse(row.data);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

async function saveOverrides(overrides) {
  await db.prepare(`
    INSERT INTO app_settings (section, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(section) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(SETTINGS_SECTION, JSON.stringify(overrides), db.now());
}

// GET /api/system-tasks/schedule — every decorative row's current interval
// in one map, keyed by id: a persisted override if the user ever changed
// it, that row's real-world default otherwise. Called once by TaskList.jsx
// rather than per-row, same "one request, not seven" shape GET
// /api/system-tasks already uses for the two real rows.
async function getIntervals() {
  const overrides = await loadOverrides();
  const result = {};
  for (const id of Object.keys(DEFAULT_INTERVAL_MINUTES)) {
    const override = Number(overrides[id]);
    result[id] = Number.isFinite(override) && override > 0 ? override : DEFAULT_INTERVAL_MINUTES[id];
  }
  return result;
}

// PATCH /api/system-tasks/schedule/:id — clamps to [MIN_INTERVAL_MINUTES,
// MAX_INTERVAL_MINUTES] and persists (survives a restart), same convention
// as disk-usage.js's setIntervalHours. Returns null for an id this module
// doesn't know about, so the route can answer with a real 404 instead of
// silently inventing a new persisted key from a typo'd/stale id.
async function setIntervalMinutes(id, minutes) {
  if (!(id in DEFAULT_INTERVAL_MINUTES)) return null;
  const clamped = Math.min(MAX_INTERVAL_MINUTES, Math.max(MIN_INTERVAL_MINUTES, Math.round(minutes)));
  const overrides = await loadOverrides();
  overrides[id] = clamped;
  await saveOverrides(overrides);
  return clamped;
}

module.exports = { getIntervals, setIntervalMinutes, DEFAULT_INTERVAL_MINUTES, MIN_INTERVAL_MINUTES, MAX_INTERVAL_MINUTES };
