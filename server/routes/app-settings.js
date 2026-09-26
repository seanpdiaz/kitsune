// ---------------------------------------------------------------------------
// /api/app-settings/:section — the field/toggle-style Settings pages (Media
// Management, General, UI, Metadata, Quality).
// ---------------------------------------------------------------------------
const db = require('../db');
const { sendJson, readJsonBody } = require('../lib/http');

db.init(async () => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      section TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    )
  `);
});


// ---------------------------------------------------------------------------
// /api/app-settings/:section — field/toggle-style settings sections
// ---------------------------------------------------------------------------

const PRIVATE_SECTIONS = new Set(['oidc']);

async function handleAppSettingsApi(req, res, urlPath) {
  const match = urlPath.match(/^\/api\/app-settings\/([a-z-]+)$/);
  if (!match) return false;
  const [, section] = match;

  // Sections that hold secrets and have their own admin-only routes — never
  // served or overwritten through this generic endpoint. 'oidc' is Single
  // Sign-On's config, client secret included (see routes/oidc.js).
  if (PRIVATE_SECTIONS.has(section)) {
    sendJson(res, 404, { error: 'Not found' });
    return true;
  }

  // GET /api/app-settings/:section — the saved { key: value } object for this
  // page, or {} if nothing's been saved yet (fresh install / first visit).
  if (req.method === 'GET') {
    const row = await db.prepare('SELECT data FROM app_settings WHERE section = ?').get(section);
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
    const row = await db.prepare('SELECT data FROM app_settings WHERE section = ?').get(section);
    const merged = { ...(row ? JSON.parse(row.data) : {}), ...body };
    await db.prepare(`
      INSERT INTO app_settings (section, data, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(section) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).run(section, JSON.stringify(merged), db.now());
    sendJson(res, 200, merged);
    return true;
  }

  return false;
}

module.exports = { handleAppSettingsApi };
