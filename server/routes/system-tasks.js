// ---------------------------------------------------------------------------
// /api/system-tasks — backs the one real row on System > Tasks: the Disk
// Usage Recompute background job (see server/lib/disk-usage.js and the
// Library dashboard's Disk usage stat card). Every other row that page
// shows (RSS Sync, Check for Finished Downloads, Backup, etc.) is still the
// original decorative placeholder data in
// public/js/pages/system-tasks.js — there's nothing real behind those yet,
// so this route only covers the one job that's actually real.
// ---------------------------------------------------------------------------
const { sendJson, readJsonBody } = require('../lib/http');
const { logInfo, logWarn } = require('../logger');
const { getTaskInfo, setIntervalHours, runNow } = require('../lib/disk-usage');

async function handleSystemTasksApi(req, res, urlPath) {
  // GET /api/system-tasks — an array (of one, today) so the frontend/API
  // shape doesn't need to change if a second real task ever joins this.
  if (req.method === 'GET' && urlPath === '/api/system-tasks') {
    sendJson(res, 200, [getTaskInfo()]);
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
    runNow();
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
    const applied = setIntervalHours(hours);
    if (applied !== hours) {
      logWarn('SystemTasks', `Requested Disk Usage Recompute interval ${hours}h was clamped to ${applied}h`);
    }
    sendJson(res, 200, { ok: true, task: getTaskInfo() });
    return true;
  }

  return false;
}

module.exports = { handleSystemTasksApi };
