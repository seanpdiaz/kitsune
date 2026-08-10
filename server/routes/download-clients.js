// ---------------------------------------------------------------------------
// /api/download-clients/:id/test — the one real network call in Settings >
// Download Clients. Every other list-style settings section (Indexers,
// Import Lists, Connect) fakes its Test button with a timeout (see
// ConnectionManager in frontend/components/ConnectionManager.jsx — React,
// see README's "React migration" section); Download Clients actually logs
// into a real qBittorrent or NZBGet instance
// via server/lib/download-clients/*.js, same as Sonarr/Radarr do.
//
// Rows still live in the shared settings_items table/section (see
// routes/settings-items.js) — this route only adds the Test action on top,
// reusing rowToItem so the response shape matches what GET/PATCH already
// return.
// ---------------------------------------------------------------------------
const { db } = require('../db');
const { logInfo, logWarn } = require('../logger');
const { sendJson, readJsonBody } = require('../lib/http');
const { rowToItem } = require('./settings-items');
const qbittorrent = require('../lib/download-clients/qbittorrent');
const nzbget = require('../lib/download-clients/nzbget');

const CLIENTS = { qbittorrent, nzbget };

async function handleDownloadClientsApi(req, res, urlPath) {
  const testMatch = urlPath.match(/^\/api\/download-clients\/(\d+)\/test$/);
  if (!(req.method === 'POST' && testMatch)) return false;

  const id = Number(testMatch[1]);
  logInfo('DownloadClientService', `Test requested for download client id ${id}`);
  const existing = db.prepare("SELECT * FROM settings_items WHERE id = ? AND section = 'download-clients'").get(id);
  if (!existing) {
    // Same HTTP status (404) as "no /api route matched at all" (see
    // server.js's final `if (!handled)` fallback) — logged explicitly here
    // so the two aren't indistinguishable in the log. If you're seeing a
    // 404 on this route and DON'T see this specific line above it, the
    // request never reached this handler at all — the most common cause is
    // the server process running code from before this route existed
    // (Node doesn't hot-reload; a `PATCH .../download-clients/:id` request
    // succeeding right before an immediate 404 on `.../test` for that same
    // id is the telltale sign, since PATCH is handled by a different, much
    // older route). Restarting `node server.js` picks up the current code.
    logWarn('DownloadClientService', `Test failed: no download client with id ${id} exists`);
    sendJson(res, 404, { error: 'Download client not found' });
    return true;
  }
  const saved = JSON.parse(existing.data);

  // Optional body lets the page test fields the user has typed but not
  // saved yet (host/port/credentials mid-edit) — anything omitted falls
  // back to the last-saved value, so testing right after adding a client
  // (before touching any field) still works off the seed/defaults.
  let overrides = {};
  try {
    overrides = await readJsonBody(req);
  } catch {
    logWarn('DownloadClientService', `Test failed for "${saved.name}": request body was not valid JSON`);
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return true;
  }
  const config = { ...saved, ...overrides };

  const client = CLIENTS[config.type];
  if (!client) {
    logWarn('DownloadClientService', `Test failed for "${saved.name}": unknown client type "${config.type}"`);
    sendJson(res, 400, { error: `Unknown download client type "${config.type}"` });
    return true;
  }
  if (!config.host || !config.port) {
    logWarn('DownloadClientService', `Test failed for "${saved.name}": host/port missing (host=${JSON.stringify(config.host)}, port=${JSON.stringify(config.port)})`);
    sendJson(res, 400, { error: 'Host and port are required to test a connection.' });
    return true;
  }

  logInfo('DownloadClientService', `Testing "${saved.name}" (${config.type}) at ${config.useSsl ? 'https' : 'http'}://${config.host}:${config.port}`);
  const result = await client.testConnection(config);

  const updatedData = {
    ...saved,
    status: result.ok ? 'ok' : 'fail',
    version: result.ok ? result.version : saved.version,
  };
  db.prepare('UPDATE settings_items SET data = ? WHERE id = ?').run(JSON.stringify(updatedData), id);
  const updatedRow = db.prepare('SELECT * FROM settings_items WHERE id = ?').get(id);

  if (result.ok) {
    logInfo('DownloadClientService', `Test succeeded for "${saved.name}" (${config.type} v${result.version})`);
  } else {
    logWarn('DownloadClientService', `Test failed for "${saved.name}" (${config.type}): ${result.error}`);
  }

  sendJson(res, 200, { ok: result.ok, error: result.ok ? null : result.error, item: rowToItem(updatedRow) });
  return true;
}

module.exports = { handleDownloadClientsApi };
