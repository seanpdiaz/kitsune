// ---------------------------------------------------------------------------
// Real disk usage for the Library dashboard's "Disk usage" stat card — the
// actual on-disk size of every configured root folder's contents, summed.
//
// This used to be `fs.statfsSync`'s used-bytes number (see fs-helpers.js's
// computeRootFolderStats), which sounds right but measures the wrong thing:
// statfs reports how full the *entire volume* a path lives on is — every
// other file on that disk, not just what's under the root folder — so on
// anything but a dedicated single-purpose drive it reads wildly higher than
// the library's actual footprint (confirmed against a real `du -sh` on a
// real root folder: statfs said 42 TB, `du` said 2.9 TB, on the same path).
// What "Disk usage" should mean here is what `du` measures: the real,
// recursive sum of file sizes under each root folder. That's what this
// module computes.
//
// Unlike statfs (one cheap syscall), a real recursive walk over however
// many episode files a library has is genuinely not free — doing it on
// every dashboard page load would mean every visit pays for a full disk
// scan. So this isn't computed live per-request: it's computed once at
// server startup and then on a timer (see startDiskUsageScheduler), cached
// in memory, and every request just reads the cached number instantly.
// server/routes/system.js exposes the cache via /api/system/status; nothing
// here ever blocks a request waiting on a scan.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { logInfo, logWarn } = require('../logger');
const { formatBytes } = require('./fs-helpers');

// Own idempotent CREATE TABLE for app_settings, same as routes/app-settings.js
// declares — this file persists the user-configurable recompute interval
// through that same table/section (see persistIntervalHours below), and
// doesn't want to depend on require() order against a route module to make
// sure the table exists first. Running the identical CREATE TABLE IF NOT
// EXISTS from two files against the same DB connection is harmless.
db.init(async () => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      section TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    )
  `);
});

const SETTINGS_SECTION = 'scheduled-tasks';
const CACHE_SECTION = 'disk-usage-cache';
const TASK_ID = 'disk-usage';
const TASK_NAME = 'Disk Usage Recompute';
const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 168; // 1 week

async function loadPersistedIntervalHours(fallback) {
  const row = await db.prepare('SELECT data FROM app_settings WHERE section = ?').get(SETTINGS_SECTION);
  if (!row) return fallback;
  try {
    const hours = Number(JSON.parse(row.data).diskUsageIntervalHours);
    return Number.isFinite(hours) && hours > 0 ? hours : fallback;
  } catch {
    return fallback;
  }
}

async function persistIntervalHours(hours) {
  const row = await db.prepare('SELECT data FROM app_settings WHERE section = ?').get(SETTINGS_SECTION);
  const merged = { ...(row ? JSON.parse(row.data) : {}), diskUsageIntervalHours: hours };
  await db.prepare(`
    INSERT INTO app_settings (section, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(section) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(SETTINGS_SECTION, JSON.stringify(merged), db.now());
}

// The scan result itself, persisted separately from the interval above (own
// section rather than folded into SETTINGS_SECTION — unrelated concerns,
// and this one gets written every single scan, the interval only when
// someone changes it, no reason to make every scan rewrite interval data
// too). This is what actually answers the request that prompted this: a
// server restart used to mean `state.bytes` started back at null and every
// page load showed "Calculating…" until a brand new scan — which, on a real
// library, can take a while — finished, even though the previous scan's
// number was still perfectly good to show in the meantime. Loading this at
// startup before the first scan kicks off is what fixes that; see
// startDiskUsageScheduler below.
async function loadPersistedDiskUsage() {
  const row = await db.prepare('SELECT data FROM app_settings WHERE section = ?').get(CACHE_SECTION);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.data);
    // `bytes: null` is a legitimate persisted state — it means the last scan
    // ran against zero configured root folders (see the `rootFolders.length
    // === 0` branch in refreshDiskUsage below), not a corrupt/missing
    // record. Only fall through to `return null` for an actually-unparseable
    // or non-numeric, non-null value.
    const bytes = parsed.bytes === null ? null : Number(parsed.bytes);
    if ((bytes !== null && !Number.isFinite(bytes)) || !parsed.computedAt) return null;
    const computedAt = new Date(parsed.computedAt);
    if (Number.isNaN(computedAt.getTime())) return null;
    return { bytes, computedAt };
  } catch {
    return null;
  }
}

async function persistDiskUsage(bytes, computedAt) {
  // Merged with whatever's already in this section (rather than a blind
  // overwrite) so this doesn't wipe out a nextRunAt persistNextRunAt wrote
  // (see below) — both functions write into the same CACHE_SECTION row for
  // unrelated reasons (a completed scan vs. a rescheduled timer) and can
  // fire in either order around a scan.
  const row = await db.prepare('SELECT data FROM app_settings WHERE section = ?').get(CACHE_SECTION);
  const merged = { ...(row ? JSON.parse(row.data) : {}), bytes, computedAt: computedAt.toISOString() };
  await db.prepare(`
    INSERT INTO app_settings (section, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(section) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(CACHE_SECTION, JSON.stringify(merged), db.now());
}

// The other half of "resume the schedule instead of resetting it on every
// restart" (see startDiskUsageScheduler and scheduleNext below) — persisted
// separately from persistDiskUsage's write (merged into the same row, same
// reasoning as that function's own comment) since this gets written on
// every reschedule (a completed run, a changed interval), not only on a
// completed scan.
async function persistNextRunAt(nextRunAtDate) {
  const row = await db.prepare('SELECT data FROM app_settings WHERE section = ?').get(CACHE_SECTION);
  const merged = { ...(row ? JSON.parse(row.data) : {}), nextRunAt: nextRunAtDate.toISOString() };
  await db.prepare(`
    INSERT INTO app_settings (section, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(section) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(CACHE_SECTION, JSON.stringify(merged), db.now());
}

// Independent of loadPersistedDiskUsage below on purpose — that function
// returns null for the whole record if bytes/computedAt aren't both valid
// yet (e.g. the very first scan hasn't finished), but a persisted nextRunAt
// should still be honored even then, so this reads it on its own rather
// than being bundled into that stricter check.
async function loadPersistedNextRunAt() {
  const row = await db.prepare('SELECT data FROM app_settings WHERE section = ?').get(CACHE_SECTION);
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

const state = { bytes: null, computedAt: null, computing: false };
let intervalHours = 6; // overwritten by startDiskUsageScheduler before anything else runs
let nextRunAt = null;
let timer = null;

// Recursively sums real file sizes under `dirPath`. Symlinks are skipped
// (neither followed nor counted) to avoid double-counting or infinite loops
// on a cyclic symlink — matches a conservative `du` more than an exhaustive
// one, which is the safer default for a number shown on a dashboard.
//
// `isRoot` distinguishes "the root folder itself couldn't be read at all"
// (returns null — this root folder is excluded from the sum entirely, same
// "don't silently count it as 0" convention the free-space fix used) from
// "some subfolder deeper in the tree couldn't be read" (logged and skipped,
// but doesn't invalidate everything else that *was* readable under that
// root folder).
async function folderSizeBytes(dirPath, isRoot) {
  let entries;
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    logWarn('DiskUsage', `Could not read "${dirPath}" while computing disk usage: ${err.code || err.message}`);
    return isRoot ? null : 0;
  }

  let total = 0;
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += (await folderSizeBytes(full, false)) || 0;
    } else if (entry.isFile()) {
      try {
        const st = await fs.promises.stat(full);
        total += st.size;
      } catch (err) {
        logWarn('DiskUsage', `Could not stat "${full}" while computing disk usage: ${err.code || err.message}`);
      }
    }
    // Symlinks (entry.isSymbolicLink()) are intentionally neither followed
    // nor counted — see comment above.
  }
  return total;
}

// Recomputes the cached total across every currently-configured root
// folder. Safe to call concurrently with itself (e.g. the scheduler firing
// again before a very slow scan finished) — `state.computing` makes a
// second call a no-op rather than two overlapping walks both hammering the
// disk and racing to write `state`.
async function refreshDiskUsage() {
  if (state.computing) {
    logWarn('DiskUsage', 'Skipped a scheduled refresh — the previous scan is still running');
    return;
  }
  state.computing = true;
  const startedAt = Date.now();
  try {
    const rootFolders = (await db.prepare("SELECT data FROM settings_items WHERE section = 'root-folders'").all())
      .map((row) => { try { return JSON.parse(row.data); } catch { return null; } })
      .filter(Boolean);

    let total = 0;
    let anyReadable = false;
    for (const rf of rootFolders) {
      const size = await folderSizeBytes(rf.path, true);
      if (size != null) {
        total += size;
        anyReadable = true;
      }
    }

    // Three distinct outcomes here, not two — conflating the last two used
    // to leave a stale number in the database forever after every root
    // folder was deleted:
    //   1. At least one root folder was readable: a normal successful scan.
    //   2. Zero root folders are configured at all: there's nothing to
    //      measure, and that's a real, current, permanent fact — not a
    //      failure — so it's cleared to null (renders as "—", not "0 B";
    //      see getCachedDiskUsage) and, critically, that cleared state is
    //      actually persisted. This used to fall into the same bucket as
    //      #3 below, so deleting your last root folder left whatever total
    //      was persisted from before sitting in the database — and
    //      reappearing on every restart — even though there was nothing
    //      left to measure.
    //   3. One or more root folders are configured but every single one is
    //      unreadable right now (e.g. a drive temporarily unmounted): a
    //      genuinely failed scan. This is the only case that deliberately
    //      keeps whatever was persisted from the last *good* scan rather
    //      than overwriting it — a stale-but-real number is more useful
    //      than erasing it over what's hopefully a transient hiccup, and
    //      the next successful scan corrects it either way.
    if (rootFolders.length === 0) {
      state.bytes = null;
      state.computedAt = new Date();
      await persistDiskUsage(null, state.computedAt);
    } else if (anyReadable) {
      state.bytes = total;
      state.computedAt = new Date();
      await persistDiskUsage(state.bytes, state.computedAt);
    } else {
      state.bytes = null;
      state.computedAt = new Date();
    }
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
    logInfo('DiskUsage', `Recomputed disk usage: ${state.bytes == null ? '—' : formatBytes(state.bytes)} ` +
      `across ${rootFolders.length} root folder(s) in ${seconds}s`);
  } catch (err) {
    logWarn('DiskUsage', `Disk usage refresh failed: ${err.stack || err}`);
  } finally {
    state.computing = false;
  }
}

// Instant, non-blocking read of whatever the last completed scan found —
// what /api/system/status actually returns on every request. Stays a plain
// synchronous function (reads only in-memory state, no db access) — every
// caller keeps calling it without await.
function getCachedDiskUsage() {
  return {
    diskUsageBytes: state.bytes,
    diskUsageFormatted: state.bytes == null ? '—' : formatBytes(state.bytes),
    diskUsageComputedAt: state.computedAt ? state.computedAt.toISOString() : null,
    diskUsageComputing: state.computing,
  };
}

// (Re)arms the background timer, either for `intervalHours` from right now
// (the normal case: called after every completed run, after the interval is
// changed, and any time no explicit target applies) or for a specific
// already-decided moment (`explicitNextRunAt` — only startDiskUsageScheduler
// passes this, to resume a schedule that survived a restart rather than
// resetting it). A self-rescheduling setTimeout rather than one long-lived
// setInterval, since a setInterval created with the old interval has no
// clean way to pick up a new one without being torn down and recreated
// anyway; doing that recreation here in one place, every time, is simpler
// than tracking "did the interval change since the last setInterval call."
async function scheduleNext(explicitNextRunAt) {
  if (timer) clearTimeout(timer);
  const target = explicitNextRunAt instanceof Date
    ? explicitNextRunAt
    : new Date(Date.now() + intervalHours * 60 * 60 * 1000);
  nextRunAt = target;
  const ms = Math.max(0, target.getTime() - Date.now());
  timer = setTimeout(async () => {
    await refreshDiskUsage();
    await scheduleNext();
  }, ms);
  // Persisted so a restart can resume waiting for this exact moment instead
  // of resetting the countdown to a fresh full interval — see
  // startDiskUsageScheduler below.
  await persistNextRunAt(target);
}

// System > Tasks' Run Now button (see server/routes/system-tasks.js) — runs
// a scan immediately (refreshDiskUsage's own `state.computing` guard makes
// this a safe no-op if one's already in flight) and resets the countdown to
// a fresh full interval from now, rather than leaving the old timer to fire
// again almost immediately afterward.
async function runNow() {
  await refreshDiskUsage();
  await scheduleNext();
}

// Validates and applies a new interval: clamps to [MIN_INTERVAL_HOURS,
// MAX_INTERVAL_HOURS], persists it (survives a restart — see
// loadPersistedIntervalHours below), and reschedules immediately so a
// shortened interval doesn't wait out however much of the old, longer one
// was already left.
async function setIntervalHours(hours) {
  const clamped = Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, Math.round(hours)));
  intervalHours = clamped;
  await persistIntervalHours(clamped);
  await scheduleNext();
  logInfo('DiskUsage', `Recompute interval changed to every ${clamped}h`);
  return clamped;
}

// Backs GET /api/system-tasks — the one real row on System > Tasks (see
// README and public/js/pages/system-tasks.js); everything else on that page
// is still decorative placeholder data. Stays synchronous, same reason as
// getCachedDiskUsage above.
function getTaskInfo() {
  return {
    id: TASK_ID,
    name: TASK_NAME,
    intervalHours,
    minIntervalHours: MIN_INTERVAL_HOURS,
    maxIntervalHours: MAX_INTERVAL_HOURS,
    lastRunAt: state.computedAt ? state.computedAt.toISOString() : null,
    nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
    running: state.computing,
  };
}

// Called once from server.js at startup. Loads whatever interval was last
// saved via System > Tasks (falling back to `defaultIntervalHours` — the
// DISK_USAGE_REFRESH_HOURS env var — the very first time, before anyone's
// ever changed it), loads whatever the last completed scan found (see
// loadPersistedDiskUsage/persistDiskUsage above) so the dashboard has a real
// number to show immediately instead of "Calculating…" on every restart,
// and arms the recurring timer.
//
// Whether a scan also runs right now depends on the persisted nextRunAt
// (see loadPersistedNextRunAt/persistNextRunAt above): if it's still in the
// future, that schedule survives the restart as-is — a real scan already
// ran recently enough that another one isn't due yet, so this just resumes
// waiting for that same moment instead of resetting the countdown. Without
// this, restarting the server (routine during dev, or any deploy) kept
// re-triggering a full disk scan every single time no matter how recently
// the last one actually finished. Only when nothing's due yet (first ever
// startup) or the persisted time has already passed (the server was down
// through when it should have run) does this fall back to the original
// behavior: scan now, without awaiting it — the server starts accepting
// requests right away, and the Library grid page already knows to keep
// showing the previous number, marked as refreshing, while
// `diskUsageComputing` is true rather than blanking it out — see
// DiskUsageStat in frontend/pages/library-grid/LibraryGridPage.jsx.
async function startDiskUsageScheduler(defaultIntervalHours) {
  intervalHours = await loadPersistedIntervalHours(defaultIntervalHours);
  const persisted = await loadPersistedDiskUsage();
  if (persisted) {
    state.bytes = persisted.bytes;
    state.computedAt = persisted.computedAt;
    logInfo('DiskUsage', `Loaded persisted disk usage from last run: ${formatBytes(state.bytes)} as of ${state.computedAt.toISOString()}`);
  }

  const persistedNextRunAt = await loadPersistedNextRunAt();
  if (persistedNextRunAt && persistedNextRunAt.getTime() > Date.now()) {
    logInfo('DiskUsage', `Next scan stays scheduled for ${persistedNextRunAt.toISOString()} (every ${intervalHours}h) — not due yet, so not scanning again just because the server restarted.`);
    await scheduleNext(persistedNextRunAt);
  } else {
    logInfo('DiskUsage', `Disk usage will be recomputed every ${intervalHours}h (plus once now at startup)`);
    refreshDiskUsage().catch((err) => logWarn('DiskUsage', `Startup scan failed: ${err.stack || err}`));
    await scheduleNext();
  }
}

module.exports = { refreshDiskUsage, getCachedDiskUsage, startDiskUsageScheduler, getTaskInfo, setIntervalHours, runNow };
