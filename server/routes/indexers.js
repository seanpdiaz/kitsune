// ---------------------------------------------------------------------------
// /api/indexers/:id/test — real connectivity test for Settings > Indexers'
// Nyaa.si and Prowlarr rows, the same real-vs-simulated split Download
// Clients' Test button already established for qBittorrent/NZBGet (see
// routes/download-clients.js) and Connect's Pushover type. Every other
// seeded indexer (AnimeBytes, SubsPlease RSS, AniDex, Erai-raws) still
// simulates its Test button client-side (see ConnectionManager.jsx) — this
// route 400s outright for any row whose type isn't one of the real ones
// rather than silently no-op'ing, so a bug that somehow routed an
// unsupported row here fails loudly.
// ---------------------------------------------------------------------------
const db = require('../db');
const { logInfo, logWarn } = require('../logger');
const { sendJson } = require('../lib/http');
const { rowToItem } = require('./settings-items');
const { testNyaaReachable } = require('../lib/nyaa-search');
const { testProwlarrReachable } = require('../lib/prowlarr-search');

async function handleIndexersApi(req, res, urlPath) {
  const testMatch = urlPath.match(/^\/api\/indexers\/(\d+)\/test$/);
  if (!(req.method === 'POST' && testMatch)) return false;

  const id = Number(testMatch[1]);
  const existing = await db.prepare("SELECT * FROM settings_items WHERE id = ? AND section = 'indexers'").get(id);
  if (!existing) {
    sendJson(res, 404, { error: 'Indexer not found' });
    return true;
  }
  const saved = JSON.parse(existing.data);

  if (saved.type !== 'nyaa' && saved.type !== 'prowlarr') {
    sendJson(res, 400, { error: 'Real testing is only available for the Nyaa.si and Prowlarr indexers right now.' });
    return true;
  }

  logInfo('IndexerService', `Testing "${saved.name}"`);
  const result = saved.type === 'nyaa'
    ? await testNyaaReachable()
    : await testProwlarrReachable({ baseUrl: saved.baseUrl, apiKey: saved.apiKey, allowInsecureSsl: saved.allowInsecureSsl });

  const updatedData = { ...saved, status: result.ok ? 'ok' : 'fail' };
  await db.prepare('UPDATE settings_items SET data = ? WHERE id = ?').run(JSON.stringify(updatedData), id);
  const updatedRow = await db.prepare('SELECT * FROM settings_items WHERE id = ?').get(id);

  if (result.ok) {
    logInfo('IndexerService', `Test succeeded for "${saved.name}"${result.version ? ` (Prowlarr v${result.version})` : ''}`);
  } else {
    logWarn('IndexerService', `Test failed for "${saved.name}": ${result.error}`);
  }

  sendJson(res, 200, { ok: result.ok, error: result.ok ? null : result.error, item: rowToItem(updatedRow) });
  return true;
}

module.exports = { handleIndexersApi };
