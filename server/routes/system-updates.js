// ---------------------------------------------------------------------------
// /api/system-updates — backs the real System > Updates page (Phase 1 of
// the Updates feature; see server/lib/update-check.js for the actual
// GitHub-comparison logic and README/wiki for the full phased plan).
// Read-only, same as update-check.js itself: this exposes what's currently
// known, plus a way to trigger a fresh check, but never an "apply" action —
// that's explicitly a later phase, gated on deployment-mode.js telling it
// whether this instance is even the kind that could safely do that.
// ---------------------------------------------------------------------------
const { sendJson } = require('../lib/http');
const { logInfo, logWarn } = require('../logger');
const { getCachedUpdateStatus, runNow } = require('../lib/update-check');
const { getDeploymentMode } = require('../lib/deployment-mode');
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
    });
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
