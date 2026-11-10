// ---------------------------------------------------------------------------
// /api/system-updates — backs the real System > Updates page (Phase 1 of
// the Updates feature; see server/lib/update-check.js for the actual
// GitHub-comparison logic and README/wiki for the full phased plan).
// Read-only, same as update-check.js itself: this exposes what's currently
// known, plus a way to trigger a fresh check, but never an "apply" action —
// that's explicitly a later phase, gated on deployment-mode.js telling it
// whether this instance is even the kind that could safely do that.
// ---------------------------------------------------------------------------
const { sendJson, readJsonBody } = require('../lib/http');
const { logInfo, logWarn } = require('../logger');
const { getCachedUpdateStatus, runNow, loadBuildInfo } = require('../lib/update-check');
const { getDeploymentMode } = require('../lib/deployment-mode');
const updater = require('../lib/updater');
const { requireAuth, requireAdmin } = require('./auth');
const { version: currentVersion } = require('../../package.json');

async function handleSystemUpdatesApi(req, res, urlPath) {
  // GET /api/system-updates — everything System > Updates needs in one
  // response: this build's own version/commit/branch, the deployment mode
  // (standalone vs. docker), and the latest cached GitHub comparison
  // (populated by update-check.js's scheduler — see its own header comment
  // for why this never blocks a page load on a live network call itself).
  if (req.method === 'GET' && urlPath === '/api/system-updates') {
    sendJson(res, 200, {
      currentVersion,
      deploymentMode: getDeploymentMode(),
      ...getCachedUpdateStatus(),
      // Read fresh, not from the cached check: right after an update the
      // cache still describes the previous build until the next check ends.
      buildInfo: loadBuildInfo(),
      install: updater.getInstallStatus(),
    });
    return true;
  }

  // ---- Phase 2: installing a chosen version (see server/lib/updater.js) ----

  // GET /api/system-updates/targets[?refresh=1] — branches and releases on
  // GitHub that can be installed. Cached for a few minutes, since
  // unauthenticated GitHub API calls are limited to 60 an hour.
  if (req.method === 'GET' && urlPath === '/api/system-updates/targets') {
    if (!(await requireAuth(req, res))) return true;
    const refresh = /[?&]refresh=1\b/.test(req.url);
    try {
      sendJson(res, 200, await updater.listTargets({ refresh }));
    } catch (err) {
      sendJson(res, 502, { error: err.message });
    }
    return true;
  }

  // GET /api/system-updates/preview?type=branch|release&ref=<name> — which
  // commit that is, and whether installing it is an upgrade, a downgrade or
  // a branch switch, with the commits involved.
  if (req.method === 'GET' && urlPath === '/api/system-updates/preview') {
    if (!(await requireAuth(req, res))) return true;
    const params = new URL(req.url, 'http://localhost').searchParams;
    try {
      sendJson(res, 200, await updater.previewTarget(params.get('type'), params.get('ref')));
    } catch (err) {
      sendJson(res, err.status || 502, { error: err.message });
    }
    return true;
  }

  // POST /api/system-updates/install { type, ref, confirm } — admins only.
  // Anything other than a plain upgrade answers { needsConfirm: true, ... }
  // until it's sent again with confirm: true. Otherwise starts in the
  // background; GET /api/system-updates reports progress under `install`.
  if (req.method === 'POST' && urlPath === '/api/system-updates/install') {
    const user = await requireAdmin(req, res);
    if (!user) return true;
    let body = {};
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body.' });
      return true;
    }
    try {
      const result = await updater.startInstall({ type: body.type, ref: body.ref, confirm: body.confirm === true }, user);
      sendJson(res, result.needsConfirm ? 409 : 202, result);
    } catch (err) {
      logWarn('SystemUpdates', `Install request refused: ${err.message}`);
      sendJson(res, err.status || 500, { error: err.message });
    }
    return true;
  }

  // POST /api/system-updates/check — System > Updates' own "Check Now"
  // button, distinct from System > Tasks' identical Run Now for the same
  // underlying task (both just call update-check.js's runNow — this is a
  // second, page-local entry point so a user checking for updates doesn't
  // need to go find System > Tasks to do it). Fire-and-forget, same
  // "respond with in-flight state, let the frontend poll GET for the real
  // result" shape every other real task's Run Now already uses — a GitHub
  // round trip is fast, but not always instant (a compare against a very
  // active repo, a cold DNS lookup, etc.).
  if (req.method === 'POST' && urlPath === '/api/system-updates/check') {
    logInfo('SystemUpdates', 'Update check triggered manually from System > Updates');
    runNow().catch((err) => logWarn('SystemUpdates', `Manual update check failed: ${err.stack || err}`));
    sendJson(res, 200, { ok: true, checking: true });
    return true;
  }

  return false;
}

module.exports = { handleSystemUpdatesApi };
