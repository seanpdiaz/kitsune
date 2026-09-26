// ---------------------------------------------------------------------------
// /api/system-tasks — backs the real rows on System > Tasks: the Disk Usage
// Recompute background job (see server/lib/disk-usage.js and the Library
// dashboard's Disk usage stat card), the Apply Permissions job (see
// server/lib/permissions.js), and the Refresh Series job (see
// server/lib/refresh-series-task.js — re-fetches every series' episode
// metadata from TheTVDB, which is what fills in "TBA" rows on a currently
// airing show once TheTVDB actually has the real data), and the
// Application Update Check job (see server/lib/update-check.js — compares
// this build against GitHub, no apply-update action yet). Every other row
// that page shows (RSS Sync, Check for Finished Downloads, Backup, etc.)
// still doesn't run a real background job — "Run Now" still just fakes a
// "Just now" timestamp client-side, and Last Run/Next Run stay decorative
// text — but its interval IS real now too: see the /api/system-tasks/
// schedule routes below and server/lib/decorative-task-intervals.js, which
// persist whatever the user picks for each of those remaining rows even
// though nothing yet actually runs on that schedule.
// ---------------------------------------------------------------------------
const { sendJson, readJsonBody } = require('../lib/http');
const { logInfo, logWarn } = require('../logger');
const { getTaskInfo, setIntervalHours, runNow } = require('../lib/disk-usage');
const {
  getTaskInfo: getPermissionsTaskInfo,
  setIntervalHours: setPermissionsIntervalHours,
  runNow: runPermissionsNow,
} = require('../lib/permissions');
const {
  getTaskInfo: getRefreshSeriesTaskInfo,
  setIntervalHours: setRefreshSeriesIntervalHours,
  runNow: runRefreshSeriesNow,
} = require('../lib/refresh-series-task');
const {
  getTaskInfo: getUpdateCheckTaskInfo,
  setIntervalHours: setUpdateCheckIntervalHours,
  runNow: runUpdateCheckNow,
} = require('../lib/update-check');
const { getIntervals: getDecorativeIntervals, setIntervalMinutes: setDecorativeIntervalMinutes } = require('../lib/decorative-task-intervals');

async function handleSystemTasksApi(req, res, urlPath) {
  // GET /api/system-tasks — every real task, one array. Started as "an
  // array of one so the shape doesn't need to change when a second joins
  // it" (Apply Permissions is that second one) — TaskList.jsx's RealRow
  // finds its own row by `id`, so the order here doesn't matter and a
  // third task is just another entry.
  if (req.method === 'GET' && urlPath === '/api/system-tasks') {
    sendJson(res, 200, [getTaskInfo(), await getPermissionsTaskInfo(), getRefreshSeriesTaskInfo(), getUpdateCheckTaskInfo()]);
    return true;
  }

  // POST /api/system-tasks/disk-usage/run — System > Tasks' "Run Now".
  // Fire-and-forget: a real recursive directory scan can take a while on a
  // big library, so this doesn't hold the response open waiting for it —
  // responds immediately with the task's state (`running: true` by the
  // time this reads it back, since refreshDiskUsage sets that synchronously
  // before its first await), and the frontend does a short follow-up poll
  // to pick up the real result once the scan actually finishes.
  if (req.method === 'POST' && urlPath === '/api/system-tasks/disk-usage/run') {
    logInfo('SystemTasks', 'Disk Usage Recompute triggered manually (Run Now)');
    runNow().catch((err) => logWarn('SystemTasks', `Run Now failed: ${err.stack || err}`));
    sendJson(res, 200, { ok: true, task: getTaskInfo() });
    return true;
  }

  // PATCH /api/system-tasks/disk-usage — System > Tasks' interval dropdown.
  // Persisted (survives a restart) and reschedules the background timer
  // immediately — see setIntervalHours in disk-usage.js.
  if (req.method === 'PATCH' && urlPath === '/api/system-tasks/disk-usage') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const hours = Number(body.intervalHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      sendJson(res, 400, { error: 'intervalHours must be a positive number' });
      return true;
    }
    const applied = await setIntervalHours(hours);
    if (applied !== hours) {
      logWarn('SystemTasks', `Requested Disk Usage Recompute interval ${hours}h was clamped to ${applied}h`);
    }
    sendJson(res, 200, { ok: true, task: getTaskInfo() });
    return true;
  }

  // POST /api/system-tasks/apply-permissions/run — same "fire-and-forget,
  // respond with the running state, let the frontend poll" shape as disk
  // usage's Run Now above; a real recursive chmod/chown walk can take a
  // while on a big library for the same reason a real disk scan can.
  if (req.method === 'POST' && urlPath === '/api/system-tasks/apply-permissions/run') {
    // Checked up front so a disabled toggle gets a real "this did nothing"
    // response instead of the generic { ok: true } every other Run Now
    // gets — see permissions.js's own getTaskInfo/disabledReason. Avoids
    // even starting refreshPermissionsTask, so a click while disabled
    // doesn't touch lastRunAt or flip `running` for the brief no-op.
    const infoBeforeRun = await getPermissionsTaskInfo();
    if (!infoBeforeRun.enabled) {
      logInfo('SystemTasks', 'Apply Permissions Run Now ignored — Set Permissions is turned off in Settings > Media Management.');
      sendJson(res, 200, { ok: false, error: infoBeforeRun.disabledReason, task: infoBeforeRun });
      return true;
    }
    logInfo('SystemTasks', 'Apply Permissions triggered manually (Run Now)');
    runPermissionsNow().catch((err) => logWarn('SystemTasks', `Apply Permissions Run Now failed: ${err.stack || err}`));
    sendJson(res, 200, { ok: true, task: await getPermissionsTaskInfo() });
    return true;
  }

  // PATCH /api/system-tasks/apply-permissions — System > Tasks' interval
  // dropdown for this row.
  if (req.method === 'PATCH' && urlPath === '/api/system-tasks/apply-permissions') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const hours = Number(body.intervalHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      sendJson(res, 400, { error: 'intervalHours must be a positive number' });
      return true;
    }
    const applied = await setPermissionsIntervalHours(hours);
    if (applied !== hours) {
      logWarn('SystemTasks', `Requested Apply Permissions interval ${hours}h was clamped to ${applied}h`);
    }
    sendJson(res, 200, { ok: true, task: await getPermissionsTaskInfo() });
    return true;
  }

  // POST /api/system-tasks/refresh-series/run — same "fire-and-forget,
  // respond with the running state, let the frontend poll" shape as the
  // other two Run Now handlers above; walking every series' TVDB fetch can
  // take a while on a real-sized library.
  if (req.method === 'POST' && urlPath === '/api/system-tasks/refresh-series/run') {
    logInfo('SystemTasks', 'Refresh Series triggered manually (Run Now)');
    runRefreshSeriesNow().catch((err) => logWarn('SystemTasks', `Run Now failed: ${err.stack || err}`));
    sendJson(res, 200, { ok: true, task: getRefreshSeriesTaskInfo() });
    return true;
  }

  // PATCH /api/system-tasks/refresh-series — System > Tasks' interval
  // dropdown for this row.
  if (req.method === 'PATCH' && urlPath === '/api/system-tasks/refresh-series') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const hours = Number(body.intervalHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      sendJson(res, 400, { error: 'intervalHours must be a positive number' });
      return true;
    }
    const applied = await setRefreshSeriesIntervalHours(hours);
    if (applied !== hours) {
      logWarn('SystemTasks', `Requested Refresh Series interval ${hours}h was clamped to ${applied}h`);
    }
    sendJson(res, 200, { ok: true, task: getRefreshSeriesTaskInfo() });
    return true;
  }

  // POST /api/system-tasks/update-check/run — same "fire-and-forget,
  // respond with the running state, let the frontend poll" shape as the
  // other three Run Now handlers above; a GitHub API round trip is
  // normally fast, but this still doesn't hold the response open on it.
  if (req.method === 'POST' && urlPath === '/api/system-tasks/update-check/run') {
    logInfo('SystemTasks', 'Application Update Check triggered manually (Run Now)');
    runUpdateCheckNow().catch((err) => logWarn('SystemTasks', `Run Now failed: ${err.stack || err}`));
    sendJson(res, 200, { ok: true, task: getUpdateCheckTaskInfo() });
    return true;
  }

  // PATCH /api/system-tasks/update-check — System > Tasks' interval
  // dropdown for this row.
  if (req.method === 'PATCH' && urlPath === '/api/system-tasks/update-check') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const hours = Number(body.intervalHours);
    if (!Number.isFinite(hours) || hours <= 0) {
      sendJson(res, 400, { error: 'intervalHours must be a positive number' });
      return true;
    }
    const applied = await setUpdateCheckIntervalHours(hours);
    if (applied !== hours) {
      logWarn('SystemTasks', `Requested Application Update Check interval ${hours}h was clamped to ${applied}h`);
    }
    sendJson(res, 200, { ok: true, task: getUpdateCheckTaskInfo() });
    return true;
  }

  // GET /api/system-tasks/schedule — the five still-decorative rows'
  // current intervals, one map keyed by id (see TaskList.jsx's TASKS_DATA
  // for what each id means). Fetched once by TaskList, not per-row.
  if (req.method === 'GET' && urlPath === '/api/system-tasks/schedule') {
    sendJson(res, 200, await getDecorativeIntervals());
    return true;
  }

  // PATCH /api/system-tasks/schedule/:id — a decorative row's interval
  // dropdown. Persisted (survives a restart) even though nothing actually
  // runs on it yet — see decorative-task-intervals.js's own header comment
  // for why that's still worth doing.
  const scheduleMatch = req.method === 'PATCH' && urlPath.match(/^\/api\/system-tasks\/schedule\/([a-z-]+)$/);
  if (scheduleMatch) {
    const id = scheduleMatch[1];
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const minutes = Number(body.intervalMinutes);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      sendJson(res, 400, { error: 'intervalMinutes must be a positive number' });
      return true;
    }
    const applied = await setDecorativeIntervalMinutes(id, minutes);
    if (applied == null) {
      sendJson(res, 404, { error: `Unknown task id "${id}"` });
      return true;
    }
    if (applied !== Math.round(minutes)) {
      logWarn('SystemTasks', `Requested ${id} interval ${minutes}m was clamped to ${applied}m`);
    }
    sendJson(res, 200, { ok: true, id, intervalMinutes: applied });
    return true;
  }

  return false;
}

module.exports = { handleSystemTasksApi };
