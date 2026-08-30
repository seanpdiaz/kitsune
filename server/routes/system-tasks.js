// ---------------------------------------------------------------------------
// /api/system-tasks — backs the real rows on System > Tasks: the Disk Usage
// Recompute background job (see server/lib/disk-usage.js and the Library
// dashboard's Disk usage stat card) and the Apply Permissions job (see
// server/lib/permissions.js). Every other row that page shows (RSS Sync,
// Check for Finished Downloads, Backup, etc.) is still decorative
// placeholder data in frontend/pages/system-tasks/TaskList.jsx — there's
// nothing real behind those yet, so this route only covers the jobs that
// actually are.
// ---------------------------------------------------------------------------
const { sendJson, readJsonBody } = require('../lib/http');
const { logInfo, logWarn } = require('../logger');
const { getTaskInfo, setIntervalHours, runNow } = require('../lib/disk-usage');
const {
  getTaskInfo: getPermissionsTaskInfo,
  setIntervalHours: setPermissionsIntervalHours,
  runNow: runPermissionsNow,
} = require('../lib/permissions');

async function handleSystemTasksApi(req, res, urlPath) {
  // GET /api/system-tasks — every real task, one array. Started as "an
  // array of one so the shape doesn't need to change when a second joins
  // it" (Apply Permissions is that second one) — TaskList.jsx's RealRow
  // finds its own row by `id`, so the order here doesn't matter and a
  // third task is just another entry.
  if (req.method === 'GET' && urlPath === '/api/system-tasks') {
    sendJson(res, 200, [getTaskInfo(), getPermissionsTaskInfo()]);
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
    logInfo('SystemTasks', 'Apply Permissions triggered manually (Run Now)');
    runPermissionsNow().catch((err) => logWarn('SystemTasks', `Apply Permissions Run Now failed: ${err.stack || err}`));
    sendJson(res, 200, { ok: true, task: getPermissionsTaskInfo() });
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
    sendJson(res, 200, { ok: true, task: getPermissionsTaskInfo() });
    return true;
  }

  return false;
}

module.exports = { handleSystemTasksApi };
