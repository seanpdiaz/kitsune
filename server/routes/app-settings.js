// ---------------------------------------------------------------------------
// /api/app-settings/:section — the field/toggle-style Settings pages (Media
// Management, General, UI, Metadata, Quality).
// ---------------------------------------------------------------------------
const { db } = require('../db');
const { sendJson, readJsonBody } = require('../lib/http');

db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    section TEXT PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);


// ---------------------------------------------------------------------------
// /api/app-settings/:section — field/toggle-style settings sections
// ---------------------------------------------------------------------------

async function handleAppSettingsApi(req, res, urlPath) {
  const match = urlPath.match(/^\/api\/app-settings\/([a-z-]+)$/);
  if (!match) return false;
  const [, section] = match;

  // GET /api/app-settings/:section — the saved { key: value } object for this
  // page, or {} if nothing's been saved yet (fresh install / first visit).
  if (req.method === 'GET') {
    const row = db.prepare('SELECT data FROM app_settings WHERE section = ?').get(section);
    sendJson(res, 200, row ? JSON.parse(row.data) : {});
    return true;
  }

  // PUT /api/app-settings/:section — merge the given { key: value } pairs
  // into whatever's already stored (not a full replace), so saving one field
  // never clobbers the others.
  if (req.method === 'PUT') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const row = db.prepare('SELECT data FROM app_settings WHERE section = ?').get(section);
    const merged = { ...(row ? JSON.parse(row.data) : {}), ...body };
    db.prepare(`
      INSERT INTO app_settings (section, data, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(section) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).run(section, JSON.stringify(merged));
    sendJson(res, 200, merged);
    return true;
  }

  return false;
}

module.exports = { handleAppSettingsApi };
