// ---------------------------------------------------------------------------
// System > Tasks' "Refresh Series" row — walks every series in the library
// and re-fetches its episode metadata from TheTVDB, same per-series work as
// the Series detail page's own manual "Refresh" button (see
// refreshEpisodesForSeries in server/routes/episodes.js, reused as-is here).
//
// Why this exists: for a currently-airing show, TheTVDB fills in an
// episode's title/synopsis/air date only once it's actually known — often
// not until shortly before that episode airs. A series whose episode list
// was cached before that happened keeps showing "TBA" for those rows
// forever, because nothing ever asked TheTVDB again after the initial
// fetch — the only way to pick up the real data used to be opening that
// specific series and clicking Refresh by hand, one show at a time. This
// task is that same refresh, run automatically across the whole library on
// a user-configurable interval, so an airing show's episode info fills in
// on its own instead of staying stale until someone notices and refreshes
// it manually.
//
// Same real-task shape System > Tasks already established for Disk Usage
// Recompute and Apply Permissions (see disk-usage.js and permissions.js —
// getTaskInfo/setIntervalHours/runNow, an interval persisted in the shared
// 'scheduled-tasks' app_settings row under its own key, last-run state
// persisted separately so it survives a restart); server/routes/system-
// tasks.js and TaskList.jsx's RealRow drive this task through the same
// endpoints and component as those two rather than duplicating either.
//
// One thing this task does NOT share with either of those: "Refresh
// Series" used to be one of System > Tasks' seven still-decorative rows
// (see decorative-task-intervals.js) — nothing ran on its schedule, but the
// interval dropdown itself was already real and persisted, in minutes. See
// loadPersistedIntervalHours below for how a value someone already set
// there is carried over instead of silently discarded the first time this
// task's own, real interval setting is read.
// ---------------------------------------------------------------------------
const db = require('../db');
const { logInfo, logWarn } = require('../logger');
const { sleep } = require('./util');
const { refreshEpisodesForSeries } = require('../routes/episodes');

db.init(async () => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      section TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    )
  `);
});

const TASK_SETTINGS_SECTION = 'scheduled-tasks'; // shared with disk-usage.js/permissions.js — see either file's own persistIntervalHours
const TASK_CACHE_SECTION = 'refresh-series-cache';
const TASK_ID = 'refresh-series'; // same id decorative-task-intervals.js used for this row — TaskList.jsx's RealRow keys off it unchanged
const TASK_NAME = 'Refresh Series';
const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 168; // 1 week — same outer bound as Disk Usage/Apply Permissions

// Between each series' own TVDB fetch — same "be polite between requests"
// pacing tvdb.js's own page-walking loop already uses (see its
// fetchTvdbEpisodes), just applied here across series instead of across
// pages of one series' episodes.
const BETWEEN_SERIES_DELAY_MS = 300;

async function loadPersistedIntervalHours(fallback) {
  const row = await db.prepare('SELECT data FROM app_settings WHERE section = ?').get(TASK_SETTINGS_SECTION);
  if (row) {
    try {
      const hours = Number(JSON.parse(row.data).refreshSeriesIntervalHours);
      if (Number.isFinite(hours) && hours > 0) return hours;
    } catch {
      // fall through to the migration/fallback below
    }
  }

  // This task has never had its own real interval saved yet. Before
  // falling back to `fallback` (the REFRESH_SERIES_INTERVAL_HOURS env var),
  // check whether the user already set a preferred cadence for this exact
  // row back when it was still decorative (server/lib/decorative-task-
  // intervals.js persists that under its own section, keyed by the same
  // 'refresh-series' id, in minutes) — if so, that's a real choice they
  // already made and it should carry over as this task's first real
  // interval, not get silently discarded the moment the row starts doing
  // real work. Converted to hours (rounded, then clamped to this task's own
  // range) since this task's dropdown is hours-granular like Disk Usage/
  // Apply Permissions', not minutes-granular like the still-decorative rows.
  const legacyMinutes = await loadLegacyDecorativeIntervalMinutes();
  if (legacyMinutes != null) {
    const migratedHours = Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, Math.round(legacyMinutes / 60)));
    logInfo('RefreshSeries', `Migrated interval from the old decorative Refresh Series setting: every ${legacyMinutes}m -> every ${migratedHours}h`);
    return migratedHours;
  }
  return fallback;
}

async function loadLegacyDecorativeIntervalMinutes() {
  const row = await db.prepare("SELECT data FROM app_settings WHERE section = 'decorative-task-intervals'").get();
  if (!row) return null;
  try {
    const overrides = JSON.parse(row.data);
    const minutes = Number(overrides && overrides['refresh-series']);
    return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
  } catch {
    return null;
  }
}

async function persistIntervalHours(hours) {
  const row = await db.prepare('SELECT data FROM app_settings WHERE section = ?').get(TASK_SETTINGS_SECTION);
  const merged = { ...(row ? JSON.parse(row.data) : {}), refreshSeriesIntervalHours: hours };
  await db.prepare(`
    INSERT INTO app_settings (section, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(section) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(TASK_SETTINGS_SECTION, JSON.stringify(merged), db.now());
}

async function loadPersistedLastRun() {
  const row = await db.prepare('SELECT data FROM app_settings WHERE section = ?').get(TASK_CACHE_SECTION);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.data);
    if (!parsed.lastRunAt) return null;
    const lastRunAt = new Date(parsed.lastRunAt);
    return Number.isNaN(lastRunAt.getTime()) ? null : lastRunAt;
  } catch {
    return null;
  }
}

async function persistLastRun(lastRunAt) {
  // Merged (not overwritten) so this doesn't clobber a nextRunAt
  // persistNextRunAt wrote into the same row — see that function's own
  // comment for why both live in TASK_CACHE_SECTION.
  const row = await db.prepare('SELECT data FROM app_settings WHERE section = ?').get(TASK_CACHE_SECTION);
  const merged = { ...(row ? JSON.parse(row.data) : {}), lastRunAt: lastRunAt.toISOString() };
  await db.prepare(`
    INSERT INTO app_settings (section, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(section) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(TASK_CACHE_SECTION, JSON.stringify(merged), db.now());
}

// The other half of "resume the schedule instead of resetting it on every
// restart" (see startRefreshSeriesScheduler and scheduleNext below) —
// persisted separately from persistLastRun's write (merged into the same
// row) since this gets written on every reschedule (a completed run, a
// changed interval), not only when a run actually completes.
async function persistNextRunAt(nextRunAtDate) {
  const row = await db.prepare('SELECT data FROM app_settings WHERE section = ?').get(TASK_CACHE_SECTION);
  const merged = { ...(row ? JSON.parse(row.data) : {}), nextRunAt: nextRunAtDate.toISOString() };
  await db.prepare(`
    INSERT INTO app_settings (section, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(section) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(TASK_CACHE_SECTION, JSON.stringify(merged), db.now());
}

// Independent of loadPersistedLastRun on purpose, same reasoning as that
// function existing separately from persistLastRun — a persisted nextRunAt
// should be readable regardless of whether a run has ever actually
// completed yet.
async function loadPersistedNextRunAt() {
  const row = await db.prepare('SELECT data FROM app_settings WHERE section = ?').get(TASK_CACHE_SECTION);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.data);
    if (!parsed.nextRunAt) return null;
    const d = new Date(parsed.nextRunAt);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

const taskState = { running: false, lastRunAt: null };
let intervalHours = 12; // overwritten by startRefreshSeriesScheduler before anything else runs
let nextRunAt = null;
let timer = null;

// The actual work, callable directly (used by both the scheduler and a
// manual Run Now). Every series gets the exact same re-fetch-and-upsert
// refreshEpisodesForSeries already does for a single series from its own
// detail page — this just calls that once per series, paced with a short
// delay between each (see BETWEEN_SERIES_DELAY_MS) rather than firing every
// request at TheTVDB at once. One series failing to resolve/fetch (a
// title TheTVDB can't match, a transient network error) is logged and
// skipped, not fatal to the rest of the run — same "one bad one shouldn't
// sink the whole batch" convention disk-usage.js's folder walk and
// permissions.js's directory walk already follow.
async function refreshAllSeries() {
  const seriesRows = await db.prepare('SELECT * FROM series ORDER BY id ASC').all();
  const counts = { total: seriesRows.length, refreshed: 0, failed: 0, episodesUpdated: 0 };

  for (const series of seriesRows) {
    try {
      const result = await refreshEpisodesForSeries(series);
      if (result.ok) {
        counts.refreshed += 1;
        counts.episodesUpdated += result.count;
      } else {
        counts.failed += 1;
        logWarn('RefreshSeries', `Skipped "${series.title}" — ${result.error}`);
      }
    } catch (err) {
      counts.failed += 1;
      logWarn('RefreshSeries', `Skipped "${series.title}" — ${err.stack || err}`);
    }
    // No point pausing after the very last series — nothing follows it.
    if (series !== seriesRows[seriesRows.length - 1]) await sleep(BETWEEN_SERIES_DELAY_MS);
  }

  logInfo('RefreshSeries', `Refresh Series: ${counts.refreshed}/${counts.total} series refreshed ` +
    `(${counts.episodesUpdated} episode row(s) updated)${counts.failed ? `, ${counts.failed} skipped (see warnings above)` : ''}`);
  return counts;
}

// Guards against a second run overlapping the first (a scheduled fire
// landing mid-way through a still-running manual Run Now on a big
// library), same convention as disk-usage.js/permissions.js's own tasks.
async function refreshSeriesTask() {
  if (taskState.running) {
    logWarn('RefreshSeries', 'Skipped a scheduled Refresh Series run — the previous run is still in progress');
    return;
  }
  taskState.running = true;
  try {
    await refreshAllSeries();
  } catch (err) {
    logWarn('RefreshSeries', `Refresh Series run failed: ${err.stack || err}`);
  } finally {
    taskState.running = false;
    taskState.lastRunAt = new Date();
    await persistLastRun(taskState.lastRunAt);
  }
}

// (Re)arms the background timer, either for `intervalHours` from right now
// (the normal case) or for a specific already-decided moment
// (`explicitNextRunAt` — only startRefreshSeriesScheduler passes this, to
// resume a schedule that survived a restart rather than resetting it) — a
// self-rescheduling setTimeout rather than one long-lived setInterval, same
// reasoning as disk-usage.js's own scheduleNext.
async function scheduleNext(explicitNextRunAt) {
  if (timer) clearTimeout(timer);
  const target = explicitNextRunAt instanceof Date
    ? explicitNextRunAt
    : new Date(Date.now() + intervalHours * 60 * 60 * 1000);
  nextRunAt = target;
  const ms = Math.max(0, target.getTime() - Date.now());
  timer = setTimeout(async () => {
    await refreshSeriesTask();
    await scheduleNext();
  }, ms);
  // Persisted so a restart can resume waiting for this exact moment instead
  // of resetting the countdown to a fresh full interval — see
  // startRefreshSeriesScheduler below.
  await persistNextRunAt(target);
}

// System > Tasks' Run Now button for this row.
async function runNow() {
  await refreshSeriesTask();
  await scheduleNext();
}

// Validates and applies a new interval: clamps to [MIN_INTERVAL_HOURS,
// MAX_INTERVAL_HOURS], persists it, and reschedules immediately so a
// shortened interval doesn't wait out however much of the old, longer one
// was already left.
async function setIntervalHours(hours) {
  const clamped = Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, Math.round(hours)));
  intervalHours = clamped;
  await persistIntervalHours(clamped);
  await scheduleNext();
  logInfo('RefreshSeries', `Refresh Series interval changed to every ${clamped}h`);
  return clamped;
}

// Backs GET /api/system-tasks alongside disk-usage.js's/permissions.js's own
// getTaskInfo — server/routes/system-tasks.js returns all three in the same
// array. No `enabled`/`disabledReason` fields (unlike Apply Permissions) —
// there's no separate toggle gating this one; if the library's empty,
// refreshAllSeries just walks zero series and reports that in its own log
// line.
function getTaskInfo() {
  return {
    id: TASK_ID,
    name: TASK_NAME,
    intervalHours,
    minIntervalHours: MIN_INTERVAL_HOURS,
    maxIntervalHours: MAX_INTERVAL_HOURS,
    lastRunAt: taskState.lastRunAt ? taskState.lastRunAt.toISOString() : null,
    nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
    running: taskState.running,
  };
}

// Called once from server.js at startup. Loads whatever interval was last
// saved via System > Tasks (falling back to a persisted-but-decorative
// choice from before this task was real, then to `defaultIntervalHours` —
// the REFRESH_SERIES_INTERVAL_HOURS env var — see loadPersistedIntervalHours
// above) and loads the last-run timestamp so it survives a restart.
//
// Whether a refresh also runs right now depends on the persisted nextRunAt
// (see loadPersistedNextRunAt/persistNextRunAt above): if it's still in the
// future, that schedule survives the restart as-is — every series was
// already refreshed recently enough that another full pass isn't due yet,
// so this resumes waiting for that same moment instead of resetting the
// countdown and hitting TheTVDB for the whole library again. Without this,
// restarting the server (routine during dev, or any deploy) kept
// re-triggering a full refresh every single time no matter how recently
// the last one actually finished. Only when nothing's due yet (first ever
// startup) or the persisted time has already passed does this fall back to
// the original behavior: refresh now, without awaiting it (same as
// startDiskUsageScheduler) — this is exactly the fix for the stale-"TBA"
// problem this task exists for, so a library that's actually overdue
// shouldn't have to wait out a full interval before it happens.
async function startRefreshSeriesScheduler(defaultIntervalHours) {
  intervalHours = await loadPersistedIntervalHours(defaultIntervalHours);
  taskState.lastRunAt = await loadPersistedLastRun();

  const persistedNextRunAt = await loadPersistedNextRunAt();
  if (persistedNextRunAt && persistedNextRunAt.getTime() > Date.now()) {
    logInfo('RefreshSeries', `Next refresh stays scheduled for ${persistedNextRunAt.toISOString()} (every ${intervalHours}h) — not due yet, so not refreshing the whole library again just because the server restarted.`);
    await scheduleNext(persistedNextRunAt);
  } else {
    logInfo('RefreshSeries', `Series will be refreshed every ${intervalHours}h (plus once now at startup)`);
    refreshSeriesTask().catch((err) => logWarn('RefreshSeries', `Startup refresh failed: ${err.stack || err}`));
    await scheduleNext();
  }
}

module.exports = {
  refreshAllSeries,
  getTaskInfo,
  setIntervalHours,
  runNow,
  startRefreshSeriesScheduler,
};
