// Kitsune's HTTP entry point. Loads .env, wires the SQLite-backed data layer
// (server/db.js + server/logger.js), assembles the /api/* dispatch chain
// from server/routes/*.js, and serves public/ for everything else.
//
// Each route module owns its own table(s), migrations, and default seed —
// see server/routes/*.js. They all run at require() time below, before
// server.listen() is ever reached, so table-creation order between modules
// doesn't matter: every table exists before the first request can arrive.
const http = require('http');
const fs = require('fs');
const path = require('path');

const { loadEnvFile } = require('./server/env');
loadEnvFile(path.join(__dirname, '.env'));

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
};

const { DB_PATH } = require('./server/db');
const { logDebug, logInfo, logWarn, logError } = require('./server/logger');
const { sendJson } = require('./server/lib/http');

const { handleTagsApi } = require('./server/routes/tags');
const { handleSettingsItemsApi } = require('./server/routes/settings-items');
const { handleDownloadClientsApi } = require('./server/routes/download-clients');
const { handleConnectApi } = require('./server/routes/connect');
const { handleAppSettingsApi } = require('./server/routes/app-settings');
const { handleFsBrowseApi } = require('./server/routes/fs-browse');
const { handleRootFoldersApi } = require('./server/routes/root-folders');
const { handleSeriesApi } = require('./server/routes/series');
const { handleSeriesEpisodesApi } = require('./server/routes/episodes');
const { handleCalendarApi } = require('./server/routes/calendar');
const { handleTvdbApi } = require('./server/routes/tvdb-search');
const { handleMalApi } = require('./server/routes/mal-search');
const { handleLogsApi } = require('./server/routes/logs');
const { handleQueueApi } = require('./server/routes/queue');
const { handleHistoryApi } = require('./server/routes/history');
const { handleBlocklistApi } = require('./server/routes/blocklist');
const { handleReleasesApi } = require('./server/routes/releases');
const { handleWantedApi } = require('./server/routes/wanted');
const { handleSystemApi } = require('./server/routes/system');
const { handleSystemTasksApi } = require('./server/routes/system-tasks');
const { handleImportFilesApi } = require('./server/routes/import-files');
const { startDiskUsageScheduler } = require('./server/lib/disk-usage');

// Default for how often the Library dashboard's Disk usage stat card
// recomputes (a real recursive directory walk — expensive, so it runs on a
// timer instead of per page load; see server/lib/disk-usage.js), used only
// the very first time the server ever starts. From then on, whatever's set
// from System > Tasks (see server/routes/system-tasks.js) is persisted and
// wins over this on every subsequent startup — this is just the fallback
// before anyone's customized it, not a fixed recommendation.
const DISK_USAGE_REFRESH_HOURS = Number(process.env.DISK_USAGE_REFRESH_HOURS) || 6;

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  let urlPath = req.url.split('?')[0];

  // Request logging: every request, static or API, gets one debug-level
  // line once the response actually finishes — that's what backs the "Http"
  // entries on the System > Logs page. Debug level (rather than info) keeps
  // routine page-load noise out of the default view while still being there
  // if you filter down to it. res.on('finish') (not a call made right here)
  // is what lets this capture the real final status code, however deep in
  // the handler chain it ended up getting set.
  const requestStart = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - requestStart;
    logDebug('Http', `${req.method} ${urlPath} ${res.statusCode} ${duration}ms`);
  });

  if (urlPath.startsWith('/api/')) {
    try {
      const handled =
        (await handleTagsApi(req, res, urlPath)) ||
        (await handleSettingsItemsApi(req, res, urlPath)) ||
        (await handleDownloadClientsApi(req, res, urlPath)) ||
        (await handleConnectApi(req, res, urlPath)) ||
        (await handleAppSettingsApi(req, res, urlPath)) ||
        (await handleFsBrowseApi(req, res, urlPath)) ||
        (await handleRootFoldersApi(req, res, urlPath)) ||
        (await handleSeriesApi(req, res, urlPath)) ||
        (await handleSeriesEpisodesApi(req, res, urlPath)) ||
        (await handleCalendarApi(req, res, urlPath)) ||
        (await handleTvdbApi(req, res, urlPath)) ||
        (await handleMalApi(req, res, urlPath)) ||
        (await handleLogsApi(req, res, urlPath)) ||
        (await handleQueueApi(req, res, urlPath)) ||
        (await handleHistoryApi(req, res, urlPath)) ||
        (await handleBlocklistApi(req, res, urlPath)) ||
        (await handleReleasesApi(req, res, urlPath)) ||
        (await handleWantedApi(req, res, urlPath)) ||
        (await handleSystemApi(req, res, urlPath)) ||
        (await handleSystemTasksApi(req, res, urlPath)) ||
        (await handleImportFilesApi(req, res, urlPath));
      if (!handled) {
        // Distinguishes "no /api/* route recognizes this path at all" from
        // a route-level 404 a handler sends itself (e.g. download-clients.js
        // logging "no download client with id N exists") — both produce an
        // HTTP 404, but only one of them means the request never reached
        // any handler. If a route you just added always ends up here, the
        // most common cause is a server process that hasn't been restarted
        // since — Node doesn't reload route files on their own.
        logWarn('Http', `No API route matched ${req.method} ${urlPath}`);
        sendJson(res, 404, { error: 'Not found' });
      }
    } catch (err) {
      logError('Http', `Unhandled error on ${req.method} ${urlPath}: ${err && err.stack ? err.stack : err}`);
      sendJson(res, 500, { error: 'Internal server error' });
    }
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(PUBLIC_DIR, urlPath);

  // Prevent path traversal outside the public directory
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 not found');
      return;
    }
    const ext = path.extname(filePath);
    // No Cache-Control header at all used to mean the browser's own default
    // heuristics decided how long to hold onto app.js and every page module
    // under public/js/ — which, for ES modules loaded via <script
    // type="module">, tends to be "quite a while," even across a plain
    // reload. That's invisible during a single edit-reload cycle but bites
    // hard on a mockup like this one where the JS changes constantly across
    // a session: a stale cached module can make a brand new feature (a
    // button's click handler, say) look like it was never wired up at all,
    // when the real file on disk is correct and the server is serving it —
    // the browser just never asked for it again. `no-cache` (not `no-store`)
    // still lets the browser keep a copy, but forces a revalidation request
    // on every load, so a change always takes effect on the very next
    // reload rather than however long a heuristic cache decided to hold on.
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(content);
  });
});

server.listen(PORT, () => {
  logInfo('Server', `Kitsune mockup running at http://localhost:${PORT}`);
  logInfo('Server', `Data persisted to ${DB_PATH}`);
  startDiskUsageScheduler(DISK_USAGE_REFRESH_HOURS);
});
