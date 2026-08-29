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
const db = require('../db');
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
  const existing = await db.prepare("SELECT * FROM settings_items WHERE id = ? AND section = 'download-clients'").get(id);
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
  await db.prepare('UPDATE settings_items SET data = ? WHERE id = ?').run(JSON.stringify(updatedData), id);
  const updatedRow = await db.prepare('SELECT * FROM settings_items WHERE id = ?').get(id);

  if (result.ok) {
    logInfo('DownloadClientService', `Test succeeded for "${saved.name}" (${config.type} v${result.version})`);
  } else {
    logWarn('DownloadClientService', `Test failed for "${saved.name}" (${config.type}): ${result.error}`);
  }

  sendJson(res, 200, { ok: result.ok, error: result.ok ? null : result.error, item: rowToItem(updatedRow) });
  return true;
}

// ---------------------------------------------------------------------------
// /api/download-clients/:id/torrents[...] — real torrent management against
// a real qBittorrent instance (add by magnet/URL, list, pause, resume,
// delete), backing the "Torrents" button on a qBittorrent-type client's row
// in Settings > Download Clients. See server/lib/download-clients/
// qbittorrent.js's header comment for why this deliberately doesn't touch
// the simulated grab pipeline — this is a standalone "manage what's really
// running on your real client" surface, not a replacement for it.
//
// NZBGet-type clients 400 on all of these: nzbget.js only ever grew a
// testConnection, and NZBGet's own JSON-RPC queue/history API is a
// different enough shape (no per-torrent hash, category/priority instead of
// pause-by-hash) that it isn't a drop-in extension of this same route —
// left for later if it's ever wanted, not silently faked here.
// ---------------------------------------------------------------------------
async function loadClient(id) {
  const row = await db.prepare("SELECT * FROM settings_items WHERE id = ? AND section = 'download-clients'").get(id);
  return row ? JSON.parse(row.data) : null;
}

async function handleTorrentsApi(req, res, urlPath) {
  const listOrAddMatch = urlPath.match(/^\/api\/download-clients\/(\d+)\/torrents$/);
  const actionMatch = urlPath.match(/^\/api\/download-clients\/(\d+)\/torrents\/([^/]+)\/(pause|resume)$/);
  const deleteMatch = req.method === 'DELETE' && urlPath.match(/^\/api\/download-clients\/(\d+)\/torrents\/([^/]+)$/);

  if (!listOrAddMatch && !actionMatch && !deleteMatch) return false;

  const id = Number((listOrAddMatch || actionMatch || deleteMatch)[1]);
  const saved = await loadClient(id);
  if (!saved) {
    sendJson(res, 404, { error: 'Download client not found' });
    return true;
  }
  if (saved.type !== 'qbittorrent') {
    sendJson(res, 400, { error: 'Torrent management is only available for qBittorrent clients right now.' });
    return true;
  }
  if (!saved.host || !saved.port) {
    sendJson(res, 400, { error: 'Set a host and port for this client before managing torrents.' });
    return true;
  }

  // GET /api/download-clients/:id/torrents — the real, live list, scoped to
  // this client's configured category (if any).
  if (req.method === 'GET' && listOrAddMatch) {
    const result = await qbittorrent.getTorrents(saved, { category: saved.category });
    if (!result.ok) {
      logWarn('DownloadClientService', `Listing torrents failed for "${saved.name}": ${result.error}`);
      sendJson(res, 502, { error: result.error });
      return true;
    }
    sendJson(res, 200, result.torrents);
    return true;
  }

  // POST /api/download-clients/:id/torrents — body: { url } (magnet link or
  // a URL to a .torrent file).
  if (req.method === 'POST' && listOrAddMatch) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const url = String(body.url || '').trim();
    if (!url) {
      sendJson(res, 400, { error: 'A magnet link or torrent URL is required.' });
      return true;
    }
    const result = await qbittorrent.addTorrent(saved, { url, category: saved.category });
    if (!result.ok) {
      logWarn('DownloadClientService', `Adding a torrent failed for "${saved.name}": ${result.error}`);
      sendJson(res, 502, { error: result.error });
      return true;
    }
    logInfo('DownloadClientService', `Submitted a torrent to "${saved.name}"`);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // POST /api/download-clients/:id/torrents/:hash/pause|resume
  if (req.method === 'POST' && actionMatch) {
    const hash = decodeURIComponent(actionMatch[2]);
    const action = actionMatch[3];
    const result = action === 'pause'
      ? await qbittorrent.pauseTorrents(saved, hash)
      : await qbittorrent.resumeTorrents(saved, hash);
    if (!result.ok) {
      logWarn('DownloadClientService', `${action === 'pause' ? 'Pausing' : 'Resuming'} a torrent failed on "${saved.name}": ${result.error}`);
      sendJson(res, 502, { error: result.error });
      return true;
    }
    sendJson(res, 200, { ok: true });
    return true;
  }

  // DELETE /api/download-clients/:id/torrents/:hash?deleteFiles=true|false
  if (deleteMatch) {
    const hash = decodeURIComponent(deleteMatch[2]);
    const deleteFiles = (req.url.split('?')[1] || '').includes('deleteFiles=true');
    const result = await qbittorrent.deleteTorrents(saved, hash, deleteFiles);
    if (!result.ok) {
      logWarn('DownloadClientService', `Removing a torrent failed on "${saved.name}": ${result.error}`);
      sendJson(res, 502, { error: result.error });
      return true;
    }
    logInfo('DownloadClientService', `Removed a torrent from "${saved.name}"${deleteFiles ? ' (with files)' : ''}`);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

async function handleDownloadClientsRoutes(req, res, urlPath) {
  return (await handleDownloadClientsApi(req, res, urlPath)) || (await handleTorrentsApi(req, res, urlPath));
}

module.exports = { handleDownloadClientsApi: handleDownloadClientsRoutes };
