// ---------------------------------------------------------------------------
// /api/connect/:id/test — the one real network call in Settings > Connect,
// same idea as /api/download-clients/:id/test (see routes/download-clients.js
// and server/lib/download-clients/*.js): every other Connect type (Slack,
// Plex, Gotify) still fakes its Test button with a timeout, via
// ConnectionManager's generic simulated Test in
// frontend/components/ConnectionManager.jsx (React — see README's "React
// migration" section). A Pushover-type item actually sends a real test push
// notification through server/lib/pushover.js.
//
// Rows still live in the shared settings_items table under the 'connect'
// section (see routes/settings-items.js) — this route only adds the real
// Test action on top, reusing rowToItem so the response shape matches
// what GET/PATCH already return.
// ---------------------------------------------------------------------------
const db = require('../db');
const { logInfo, logWarn } = require('../logger');
const { sendJson, readJsonBody } = require('../lib/http');
const { rowToItem } = require('./settings-items');
const { sendPushoverNotification } = require('../lib/pushover');

async function handleConnectApi(req, res, urlPath) {
  const testMatch = urlPath.match(/^\/api\/connect\/(\d+)\/test$/);
  if (!(req.method === 'POST' && testMatch)) return false;

  const id = Number(testMatch[1]);
  logInfo('ConnectService', `Test requested for connect id ${id}`);
  const existing = await db.prepare("SELECT * FROM settings_items WHERE id = ? AND section = 'connect'").get(id);
  if (!existing) {
    logWarn('ConnectService', `Test failed: no connect item with id ${id} exists`);
    sendJson(res, 404, { error: 'Connection not found' });
    return true;
  }
  const saved = JSON.parse(existing.data);

  // Same "test whatever's currently typed, not just what's saved" pattern
  // as Download Clients — lets Test work right after typing a User Key/API
  // Token without needing to blur the field first.
  let overrides = {};
  try {
    overrides = await readJsonBody(req);
  } catch {
    logWarn('ConnectService', `Test failed for "${saved.name}": request body was not valid JSON`);
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return true;
  }
  const config = { ...saved, ...overrides };

  if (config.type !== 'pushover') {
    // Every other Connect type is still simulated client-side (see
    // initConnectionManager) — this route only exists for Pushover so far,
    // matching what was actually asked for. A real request for any other
    // type shouldn't silently no-op or fake success. Older/decorative
    // Connect items (Discord, Telegram, etc. — see LIST_SECTION_SEEDS in
    // routes/settings-items.js) predate the `type` field entirely, hence
    // the fallback label below rather than printing "undefined".
    const typeLabel = config.type || saved.name || 'this connection';
    logWarn('ConnectService', `Test failed for "${saved.name}": real testing isn't implemented for type "${config.type}" yet`);
    sendJson(res, 400, { error: `Real testing isn't implemented for ${typeLabel} yet.` });
    return true;
  }

  if (!config.userKey || !config.apiToken) {
    logWarn('ConnectService', `Test failed for "${saved.name}": User Key/API Token missing`);
    sendJson(res, 400, { error: 'User Key and API Token are both required to test Pushover.' });
    return true;
  }

  logInfo('ConnectService', `Testing "${saved.name}" (pushover)`);
  const result = await sendPushoverNotification({
    apiToken: config.apiToken,
    userKey: config.userKey,
    title: 'Kitsune',
    message: 'This is a test notification from Kitsune — if you got this, Pushover is set up correctly.',
    priority: config.priority,
  });

  const updatedData = { ...saved, status: result.ok ? 'ok' : 'fail' };
  await db.prepare('UPDATE settings_items SET data = ? WHERE id = ?').run(JSON.stringify(updatedData), id);
  const updatedRow = await db.prepare('SELECT * FROM settings_items WHERE id = ?').get(id);

  if (result.ok) {
    logInfo('ConnectService', `Test succeeded for "${saved.name}" (pushover)`);
  } else {
    logWarn('ConnectService', `Test failed for "${saved.name}" (pushover): ${result.error}`);
  }

  sendJson(res, 200, { ok: result.ok, error: result.ok ? null : result.error, item: rowToItem(updatedRow) });
  return true;
}

module.exports = { handleConnectApi };
