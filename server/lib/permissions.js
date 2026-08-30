// ---------------------------------------------------------------------------
// Applies Settings > Media Management's "Set Permissions" section (chmod
// folder/file + chown user/group) to a just-imported or just-renamed real
// file, and the real folder(s) Kitsune created for it.
//
// setPermissionsToggle, Folder Chmod (mm-10), and File Chmod (mm-11) have
// existed in MediaManagementPage.jsx since the original HTML port — the
// toggle and both text fields have always rendered — but nothing on the
// backend ever read them; every real import (media-import.js) and manual
// Rename Files (routes/episodes.js) has always just left whatever
// permissions fs.linkSync/fs.copyFileSync/fs.renameSync/fs.mkdirSync's own
// umask produced. This module, plus the two call sites that now call
// applyPermissions() after a real write, is what makes the toggle do
// something. chownUser/chownGroup are new fields added alongside the
// pre-existing three (see episode-paths.js's DEFAULT_SETTINGS and
// MediaManagementPage.jsx's DEFAULTS).
//
// Only ever called after a real file already exists on disk (a successful
// hardlink/copy, or a successful rename) — never for routes/queue.js's
// fallback branch, which just computes a fabricated placeholder path when a
// real import couldn't happen at all; there's nothing real to chmod/chown
// in that case.
//
// Every failure here is logged and swallowed, never thrown: fixing
// permissions is best-effort polish on top of a real, already-successful
// import/rename, not something that should undo it or block the response.
// chown in particular almost always requires the OS user Kitsune's Node
// process runs as to be root — a completely normal thing to NOT be on a
// real machine — so an EPERM there gets an explicit "this is expected
// unprivileged" hint instead of reading like a generic, alarming failure.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const db = require('../db');
const { logInfo, logWarn } = require('../logger');
const { getMediaManagementSettings } = require('./episode-paths');

const OCTAL_MODE_RE = /^[0-7]{3,4}$/;

async function getPermissionSettings() {
  const s = await getMediaManagementSettings();
  return {
    enabled: !!s.setPermissionsToggle,
    folderMode: s['mm-10'] || '755',
    fileMode: s['mm-11'] || '644',
    chownUser: String(s.chownUser || '').trim(),
    chownGroup: String(s.chownGroup || '').trim(),
  };
}

// uid/gid lookups shell out (Node has no built-in getpwnam/getgrnam), so
// each unique name is only resolved once per process lifetime rather than
// once per file — meaningful for a batch "Rename Files" run across a whole
// season. Same tradeoff this app already makes elsewhere for anything that
// needs a real restart to pick up a changed account (see server.js's own
// note on route changes): renaming the underlying OS account/group while
// Kitsune is running won't be picked up until the next restart.
const idCache = new Map();

function resolveUid(username) {
  if (!username) return null;
  if (/^\d+$/.test(username)) return Number(username);
  const cacheKey = `uid:${username}`;
  if (idCache.has(cacheKey)) return idCache.get(cacheKey);
  let uid = null;
  try {
    const out = execFileSync('id', ['-u', username], { encoding: 'utf8' }).trim();
    uid = Number(out);
    if (!Number.isFinite(uid)) uid = null;
  } catch (err) {
    logWarn('Permissions', `Could not resolve chown user "${username}" to a uid (${err.code || err.message}) — is that a real local account on this machine? Falling back to leaving the owner unchanged.`);
  }
  idCache.set(cacheKey, uid);
  return uid;
}

function resolveGid(groupname) {
  if (!groupname) return null;
  if (/^\d+$/.test(groupname)) return Number(groupname);
  const cacheKey = `gid:${groupname}`;
  if (idCache.has(cacheKey)) return idCache.get(cacheKey);
  let gid = null;
  try {
    if (os.platform() === 'darwin') {
      // macOS has no `getent` — dscacheutil is the standard lookup (same
      // source `dscl`/Directory Utility.app read from).
      const out = execFileSync('dscacheutil', ['-q', 'group', '-a', 'name', groupname], { encoding: 'utf8' });
      const m = /^gid:\s*(\d+)/m.exec(out);
      gid = m ? Number(m[1]) : null;
    } else {
      // Linux (the more common real Kitsune deployment target — see the
      // wiki's Docker note on this same settings section): getent reads
      // /etc/group plus any configured NSS backend, same source
      // `chgrp`/`id` use.
      const out = execFileSync('getent', ['group', groupname], { encoding: 'utf8' });
      const gidField = out.trim().split(':')[2];
      gid = gidField ? Number(gidField) : null;
    }
    if (!Number.isFinite(gid)) gid = null;
  } catch (err) {
    logWarn('Permissions', `Could not resolve chown group "${groupname}" to a gid (${err.code || err.message}) — is that a real local group on this machine? Falling back to leaving the group unchanged.`);
  }
  idCache.set(cacheKey, gid);
  return gid;
}

function chmodPath(targetPath, modeStr, kind) {
  if (!OCTAL_MODE_RE.test(modeStr || '')) {
    logWarn('Permissions', `Skipped chmod on "${targetPath}" — configured ${kind} chmod "${modeStr}" isn't a valid octal permission string (expected e.g. "755" or "644").`);
    return;
  }
  try {
    fs.chmodSync(targetPath, parseInt(modeStr, 8));
  } catch (err) {
    logWarn('Permissions', `Could not chmod ${kind} "${targetPath}" to ${modeStr}: ${err.code || err.message}`);
  }
}

function chownPath(targetPath, settings) {
  if (!settings.chownUser && !settings.chownGroup) return;
  const uid = settings.chownUser ? resolveUid(settings.chownUser) : null;
  const gid = settings.chownGroup ? resolveGid(settings.chownGroup) : null;
  // resolveUid/resolveGid already logged the specific reason — bail here
  // rather than falling through to a chown that would silently reset the
  // half that failed to resolve.
  if (settings.chownUser && uid == null) return;
  if (settings.chownGroup && gid == null) return;

  let current;
  try {
    current = fs.statSync(targetPath);
  } catch (err) {
    logWarn('Permissions', `Could not stat "${targetPath}" before chown: ${err.code || err.message}`);
    return;
  }
  // Only the half actually configured on this settings page changes — an
  // owner set with no group configured (or vice versa) leaves the other one
  // exactly as it already was, rather than resetting it to whatever
  // Kitsune's own process happens to be running as. Same "don't clobber
  // what wasn't configured" rule series.path's manual-override handling
  // already follows (see episode-paths.js's buildEpisodeFilePath).
  const finalUid = uid != null ? uid : current.uid;
  const finalGid = gid != null ? gid : current.gid;
  try {
    fs.chownSync(targetPath, finalUid, finalGid);
  } catch (err) {
    const hint = err.code === 'EPERM'
      ? ' — chown almost always requires Kitsune\'s own process to be running as root; this is an expected outcome unprivileged, not a bug in Kitsune'
      : '';
    logWarn('Permissions', `Could not chown "${targetPath}" to ${settings.chownUser || '(unchanged)'}:${settings.chownGroup || '(unchanged)'}: ${err.code || err.message}${hint}`);
  }
}

// dirPaths: every real directory Kitsune just created/touched for this file
// (series folder, season folder — see episode-paths.js's two-level
// root/seasonFolder/fileName layout), outermost first; each gets Folder
// Chmod + chown. filePath: the file itself, gets File Chmod + chown. Both
// are optional so a caller that only has one (e.g. a rename that never
// touches a folder) can omit the other.
async function applyPermissions({ filePath, dirPaths = [] } = {}) {
  const settings = await getPermissionSettings();
  if (!settings.enabled) return;

  for (const dir of dirPaths) {
    if (!dir) continue;
    chmodPath(dir, settings.folderMode, 'folder');
    chownPath(dir, settings);
  }
  if (filePath) {
    chmodPath(filePath, settings.fileMode, 'file');
    chownPath(filePath, settings);
  }

  const chownSummary = settings.chownUser || settings.chownGroup
    ? `, chown ${settings.chownUser || '(unchanged)'}:${settings.chownGroup || '(unchanged)'}`
    : '';
  logInfo('Permissions', `Applied permissions (folders ${settings.folderMode}, files ${settings.fileMode}${chownSummary}) for "${filePath || dirPaths[dirPaths.length - 1] || '(unknown path)'}"`);
}

// ---------------------------------------------------------------------------
// System > Tasks' "Apply Permissions" row — applyPermissions() above only
// ever touches a file/folder Kitsune itself just created (a fresh import or
// rename). It has no way to reach anything that was already sitting in a
// root folder before Set Permissions was ever turned on, or that landed
// there some other way (a manual copy, a restore from backup, an external
// tool). This is that: a real, on-demand-or-scheduled walk of every
// configured root folder's entire existing tree, applying the exact same
// Folder Chmod/File Chmod (+ chown) settings to everything already on disk.
//
// Same real-task shape System > Tasks already established for Disk Usage
// Recompute (see disk-usage.js — getTaskInfo/setIntervalHours/runNow, an
// interval persisted in the same 'scheduled-tasks' app_settings row under
// its own key, last-run state persisted separately so it survives a
// restart) — server/routes/system-tasks.js and TaskList.jsx's RealRow
// were both generalized to drive either task through the same endpoints
// and UI rather than duplicating either.
//
// One deliberate difference from Disk Usage: that task kicks off a fresh
// scan immediately at every server startup (see startDiskUsageScheduler),
// since a stat-only walk is cheap and the dashboard needs a real number
// right away. This one does NOT run at startup — chmod/chown is a real
// filesystem write across a potentially huge tree, and doing that
// unprompted on every restart (including a quick dev-server bounce) would
// be surprising. It only ever runs from an explicit Run Now or its own
// scheduled interval, both starting the clock from whenever the server
// actually came up.
// ---------------------------------------------------------------------------
db.init(async () => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      section TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    )
  `);
});

const TASK_SETTINGS_SECTION = 'scheduled-tasks'; // shared with disk-usage.js — see that file's own persistIntervalHours
const TASK_CACHE_SECTION = 'apply-permissions-cache';
const TASK_ID = 'apply-permissions';
const TASK_NAME = 'Apply Permissions';
const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 168; // 1 week

async function loadPersistedIntervalHours(fallback) {
  const row = await db.prepare('SELECT data FROM app_settings WHERE section = ?').get(TASK_SETTINGS_SECTION);
  if (!row) return fallback;
  try {
    const hours = Number(JSON.parse(row.data).applyPermissionsIntervalHours);
    return Number.isFinite(hours) && hours > 0 ? hours : fallback;
  } catch {
    return fallback;
  }
}

async function persistIntervalHours(hours) {
  const row = await db.prepare('SELECT data FROM app_settings WHERE section = ?').get(TASK_SETTINGS_SECTION);
  const merged = { ...(row ? JSON.parse(row.data) : {}), applyPermissionsIntervalHours: hours };
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
  await db.prepare(`
    INSERT INTO app_settings (section, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(section) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(TASK_CACHE_SECTION, JSON.stringify({ lastRunAt: lastRunAt.toISOString() }), db.now());
}

const taskState = { running: false, lastRunAt: null };
let intervalHours = 24; // overwritten by startPermissionsScheduler before anything else runs
let nextRunAt = null;
let timer = null;

// One directory (chmod/chown'd itself, then every entry inside it) at a
// time, depth-first — same shape as disk-usage.js's own folderSizeBytes,
// including the "skip symlinks, log and move on past an unreadable
// subfolder rather than aborting the whole walk" conventions, since this
// walk has the exact same "one bad folder shouldn't sink a scan of a
// hundred good ones" reasoning behind it.
async function walkAndApply(dirPath, settings, counts) {
  chmodPath(dirPath, settings.folderMode, 'folder');
  chownPath(dirPath, settings);
  counts.folders += 1;

  let entries;
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    logWarn('Permissions', `Could not read "${dirPath}" while applying permissions: ${err.code || err.message}`);
    counts.errors += 1;
    return;
  }

  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      await walkAndApply(full, settings, counts);
    } else if (entry.isFile()) {
      chmodPath(full, settings.fileMode, 'file');
      chownPath(full, settings);
      counts.files += 1;
    }
    // Symlinks are intentionally neither followed nor chmod/chown'd — same
    // "don't risk a cyclic link or reach outside the root folder" call
    // disk-usage.js's folderSizeBytes already makes.
  }
}

// The actual work, callable directly (used by both the scheduler and a
// manual Run Now, and independently testable without the task-state
// wrapper around it). Every real root folder gets its own full walk;
// `enabled: false` is a deliberate no-op (not an error) — Set Permissions
// is the master switch for whether Kitsune manages permissions at all, and
// this task shouldn't start doing so on a whole library just because
// someone clicked Run Now while it happens to be off.
async function applyPermissionsToRootFolders() {
  const settings = await getPermissionSettings();
  if (!settings.enabled) {
    logInfo('Permissions', 'Apply Permissions skipped — Set Permissions is turned off in Settings > Media Management.');
    return { enabled: false, rootFolderCount: 0, folders: 0, files: 0, errors: 0 };
  }

  const rootFolders = (await db.prepare("SELECT data FROM settings_items WHERE section = 'root-folders'").all())
    .map((row) => { try { return JSON.parse(row.data); } catch { return null; } })
    .filter(Boolean);

  const counts = { folders: 0, files: 0, errors: 0 };
  for (const rf of rootFolders) {
    if (!rf.path) continue;
    try {
      await fs.promises.stat(rf.path);
    } catch (err) {
      logWarn('Permissions', `Skipped root folder "${rf.path}" — not readable (${err.code || err.message})`);
      counts.errors += 1;
      continue;
    }
    await walkAndApply(rf.path, settings, counts);
  }

  const chownSummary = settings.chownUser || settings.chownGroup
    ? `, chown ${settings.chownUser || '(unchanged)'}:${settings.chownGroup || '(unchanged)'}`
    : '';
  logInfo('Permissions', `Apply Permissions: folders ${settings.folderMode}, files ${settings.fileMode}${chownSummary} — ` +
    `${counts.folders} folder(s) and ${counts.files} file(s) across ${rootFolders.length} root folder(s)` +
    `${counts.errors ? `, ${counts.errors} error(s) (see warnings above)` : ''}`);
  return { enabled: true, rootFolderCount: rootFolders.length, ...counts };
}

// Guards against a second run overlapping the first (a scheduled fire
// landing mid-way through a still-running manual Run Now on a big
// library), same convention as disk-usage.js's refreshDiskUsage.
async function refreshPermissionsTask() {
  if (taskState.running) {
    logWarn('Permissions', 'Skipped a scheduled Apply Permissions run — the previous run is still in progress');
    return;
  }
  taskState.running = true;
  let result = null;
  try {
    result = await applyPermissionsToRootFolders();
  } catch (err) {
    logWarn('Permissions', `Apply Permissions run failed: ${err.stack || err}`);
  } finally {
    taskState.running = false;
    // A skip because Set Permissions is off didn't actually touch anything
    // on disk — only stamp lastRunAt for a real walk (or a real error), so
    // "Last Run" on System > Tasks doesn't claim a successful run just
    // happened when nothing did.
    if (!result || result.enabled !== false) {
      taskState.lastRunAt = new Date();
      await persistLastRun(taskState.lastRunAt);
    }
  }
}

function scheduleNext() {
  if (timer) clearTimeout(timer);
  const ms = intervalHours * 60 * 60 * 1000;
  nextRunAt = new Date(Date.now() + ms);
  timer = setTimeout(async () => {
    await refreshPermissionsTask();
    scheduleNext();
  }, ms);
}

// System > Tasks' Run Now button for this row.
async function runNow() {
  await refreshPermissionsTask();
  scheduleNext();
}

async function setIntervalHours(hours) {
  const clamped = Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, Math.round(hours)));
  intervalHours = clamped;
  await persistIntervalHours(clamped);
  scheduleNext();
  logInfo('Permissions', `Apply Permissions interval changed to every ${clamped}h`);
  return clamped;
}

// Backs GET /api/system-tasks alongside disk-usage.js's own getTaskInfo —
// server/routes/system-tasks.js returns both in the same array. Async
// (disk-usage.js's counterpart isn't) because it now needs to read Settings
// > Media Management's Set Permissions toggle: `enabled`/`disabledReason`
// tell TaskList.jsx's RealRow to grey the row out and disable Run Now
// instead of letting someone click a button that — per
// applyPermissionsToRootFolders' own enabled check above — would silently
// no-op and only say so in the server log.
async function getTaskInfo() {
  const settings = await getPermissionSettings();
  return {
    id: TASK_ID,
    name: TASK_NAME,
    intervalHours,
    minIntervalHours: MIN_INTERVAL_HOURS,
    maxIntervalHours: MAX_INTERVAL_HOURS,
    lastRunAt: taskState.lastRunAt ? taskState.lastRunAt.toISOString() : null,
    nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
    running: taskState.running,
    enabled: settings.enabled,
    disabledReason: settings.enabled
      ? null
      : 'Set Permissions is turned off in Settings > Media Management — Run Now has no effect until it\'s turned back on.',
  };
}

// Called once from server.js at startup. Loads the persisted interval and
// last-run timestamp (so "last run" survives a restart instead of showing
// "Never" right after one) and arms the recurring timer — but, unlike
// startDiskUsageScheduler, does NOT run a scan immediately; see this
// section's own header comment for why.
async function startPermissionsScheduler(defaultIntervalHours) {
  intervalHours = await loadPersistedIntervalHours(defaultIntervalHours);
  taskState.lastRunAt = await loadPersistedLastRun();
  logInfo('Permissions', `Apply Permissions will run every ${intervalHours}h (next run scheduled from server startup, not run immediately)`);
  scheduleNext();
}

module.exports = {
  applyPermissions,
  applyPermissionsToRootFolders,
  getTaskInfo,
  setIntervalHours,
  runNow,
  startPermissionsScheduler,
};
