// ---------------------------------------------------------------------------
// /api/user-prefs/:section — per-user display preferences. Same shape as
// /api/app-settings/:section (routes/app-settings.js: GET the saved object,
// PUT merges given keys into it rather than replacing), just scoped to
// whoever's signed in instead of one shared row for the whole server.
//
// app_settings stays exactly as it is for Media Management/General/UI/
// Metadata/Quality — those are genuinely server-wide admin configuration,
// one instance of each regardless of who's looking (matching how Sonarr/
// Radarr only ever have one of each too). This table is for the opposite
// case: a preference that's really about how one person likes to look at
// the shared Library, not a setting that changes what the server does.
// Library grid's own view (Poster/Table/Overview) and poster size are the
// first two — both used to live somewhere that wasn't actually per-user
// (view in browser localStorage, poster size as a single shared
// app_settings row) simply because this table didn't exist yet when they
// were built; see frontend/pages/library-grid/LibraryGridPage.jsx.
// ---------------------------------------------------------------------------
const db = require('../db');
const { sendJson, readJsonBody } = require('../lib/http');
const { getSessionUser } = require('./auth');

db.init(async () => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS user_prefs (
      user_id INTEGER NOT NULL,
      section TEXT NOT NULL,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, section)
    )
  `);
});

async function handleUserPrefsApi(req, res, urlPath) {
  const match = urlPath.match(/^\/api\/user-prefs\/([a-z-]+)$/);
  if (!match) return false;
  const [, section] = match;

  const user = await getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { error: 'Not signed in.' });
    return true;
  }

  // GET /api/user-prefs/:section — this user's saved { key: value } object
  // for this section, or {} if they've never saved one (fresh account /
  // first visit — same "missing means unset, not an error" convention
  // app-settings already uses).
  if (req.method === 'GET') {
    const row = await db.prepare('SELECT data FROM user_prefs WHERE user_id = ? AND section = ?').get(user.id, section);
    sendJson(res, 200, row ? JSON.parse(row.data) : {});
    return true;
  }

  // PUT /api/user-prefs/:section — merge the given pairs into whatever this
  // user already has saved, so e.g. changing just the poster size never
  // clobbers their saved view, or vice versa.
  if (req.method === 'PUT') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const row = await db.prepare('SELECT data FROM user_prefs WHERE user_id = ? AND section = ?').get(user.id, section);
    const merged = { ...(row ? JSON.parse(row.data) : {}), ...body };
    await db.prepare(`
      INSERT INTO user_prefs (user_id, section, data, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, section) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).run(user.id, section, JSON.stringify(merged), db.now());
    sendJson(res, 200, merged);
    return true;
  }

  return false;
}

module.exports = { handleUserPrefsApi };
