// ---------------------------------------------------------------------------
// User accounts — owns the `users` and `sessions` tables (same "each route
// module owns its own table(s)" convention as every other server/routes/*.js
// — see routes/settings-items.js's own comment on this). Everyone on a
// Kitsune server shares the same Library (series/episodes are not scoped to
// a user anywhere) — accounts exist for sign-in and, later, per-person
// metadata-provider linking (MyAnimeList/AniList/etc., not built yet), not
// for splitting the Library itself up.
//
// Two roles: 'admin' (can manage server-wide settings, including this page's
// own /api/users endpoints) and 'standard' (signs in, manages their own
// account via PATCH /api/auth/me — nothing else gated on role yet, but the
// role column exists now so pages that DO need it, like Settings > Users
// itself, have something to check). No seed data: an empty `users` table is
// exactly what triggers the first-run "create the admin account" flow below,
// same as it would on a real fresh install — nothing to backfill.
// ---------------------------------------------------------------------------
const { db } = require('../db');
const { logInfo, logWarn } = require('../logger');
const { sendJson, readJsonBody, parseCookies, setCookie, clearCookie } = require('../lib/http');
const { hashPassword, verifyPassword, generateSessionToken } = require('../lib/auth');

const SESSION_COOKIE = 'kitsune_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
const MIN_PASSWORD_LENGTH = 8;

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'standard',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  )
`);

// Never spreads the raw row — password_hash must never reach a client, the
// one property this project's usual generic rowToItem() (settings-items.js)
// doesn't give us, which is exactly why Users has its own route file instead
// of just being another settings_items section.
function rowToUser(row) {
  return { id: row.id, username: row.username, role: row.role, createdAt: row.created_at };
}

function userCount() {
  return db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

function adminCount() {
  return db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
}

function createSession(userId) {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, userId, expiresAt);
  return token;
}

// Reads the session cookie straight off the request — expired sessions are
// deleted lazily here (on the next request that presents one) rather than a
// separate cleanup job, simplest thing that works at this scale.
function getSessionUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (!token) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  if (new Date(session.expires_at).getTime() < Date.now()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
  return user ? rowToUser(user) : null;
}

function requireAuth(req, res) {
  const user = getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { error: 'Not signed in.' });
    return null;
  }
  return user;
}

function requireAdmin(req, res) {
  const user = requireAuth(req, res);
  if (!user) return null;
  if (user.role !== 'admin') {
    sendJson(res, 403, { error: 'Admins only.' });
    return null;
  }
  return user;
}

async function handleAuthApi(req, res, urlPath) {
  // GET /api/auth/state — the one call every page's nav.js makes on load:
  // "does anyone need to run first-run setup, and if not, who (if anyone)
  // is signed in." Combined into one endpoint rather than two so the shared
  // sidebar only needs one round trip before it can decide whether to
  // redirect to login.html at all.
  if (req.method === 'GET' && urlPath === '/api/auth/state') {
    const needsSetup = userCount() === 0;
    sendJson(res, 200, { needsSetup, user: needsSetup ? null : getSessionUser(req) });
    return true;
  }

  // POST /api/auth/setup — only reachable while the users table is still
  // empty; creates the first account as 'admin' and signs it straight in.
  // Same idea as Sonarr/Radarr's own first-launch prompt, just persisted as
  // a real account instead of a one-time username/password pair in config.
  if (req.method === 'POST' && urlPath === '/api/auth/setup') {
    if (userCount() > 0) {
      sendJson(res, 409, { error: 'Setup has already been completed.' });
      return true;
    }
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return true; }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    if (!username || password.length < MIN_PASSWORD_LENGTH) {
      sendJson(res, 400, { error: `Username is required and password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
      return true;
    }
    const { lastInsertRowid } = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, hashPassword(password), 'admin');
    setCookie(res, SESSION_COOKIE, createSession(lastInsertRowid), { maxAgeSeconds: SESSION_MAX_AGE_SECONDS });
    logInfo('Auth', `First-run setup: created admin account "${username}"`);
    sendJson(res, 201, { user: rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid)) });
    return true;
  }

  // POST /api/auth/login
  if (req.method === 'POST' && urlPath === '/api/auth/login') {
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return true; }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const row = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    // Same error either way (unknown username vs. wrong password) — doesn't
    // confirm or deny whether a given username exists on this server.
    if (!row || !verifyPassword(password, row.password_hash)) {
      logWarn('Auth', `Failed sign-in attempt for "${username}"`);
      sendJson(res, 401, { error: 'Invalid username or password.' });
      return true;
    }
    setCookie(res, SESSION_COOKIE, createSession(row.id), { maxAgeSeconds: SESSION_MAX_AGE_SECONDS });
    logInfo('Auth', `"${username}" signed in`);
    sendJson(res, 200, { user: rowToUser(row) });
    return true;
  }

  // POST /api/auth/logout
  if (req.method === 'POST' && urlPath === '/api/auth/logout') {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    clearCookie(res, SESSION_COOKIE);
    sendJson(res, 200, { ok: true });
    return true;
  }

  // PATCH /api/auth/me — self-service username/password change for whoever
  // is currently signed in. Always requires the current password, even to
  // just change the username, as a lightweight "prove it's really you"
  // check — this is the one endpoint a standard (non-admin) user can use to
  // change their own credentials at all, since /api/users/:id below is
  // admin-only.
  if (req.method === 'PATCH' && urlPath === '/api/auth/me') {
    const user = requireAuth(req, res);
    if (!user) return true;
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return true; }
    const row = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    if (!verifyPassword(String(body.currentPassword || ''), row.password_hash)) {
      sendJson(res, 400, { error: 'Current password is incorrect.' });
      return true;
    }
    const updates = {};
    if (body.username !== undefined) {
      const username = String(body.username).trim();
      if (!username) { sendJson(res, 400, { error: 'Username cannot be empty.' }); return true; }
      const clash = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, user.id);
      if (clash) { sendJson(res, 409, { error: 'That username is already taken.' }); return true; }
      updates.username = username;
    }
    if (body.newPassword) {
      if (String(body.newPassword).length < MIN_PASSWORD_LENGTH) {
        sendJson(res, 400, { error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
        return true;
      }
      updates.password_hash = hashPassword(String(body.newPassword));
    }
    if (Object.keys(updates).length > 0) {
      const setClause = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE users SET ${setClause} WHERE id = ?`).run(...Object.values(updates), user.id);
      logInfo('Auth', `"${row.username}" updated their own account`);
    }
    sendJson(res, 200, { user: rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
    return true;
  }

  // GET /api/users — admin-only list for Settings > Users.
  if (req.method === 'GET' && urlPath === '/api/users') {
    if (!requireAdmin(req, res)) return true;
    sendJson(res, 200, db.prepare('SELECT * FROM users ORDER BY id ASC').all().map(rowToUser));
    return true;
  }

  // POST /api/users — admin-only create.
  if (req.method === 'POST' && urlPath === '/api/users') {
    if (!requireAdmin(req, res)) return true;
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return true; }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const role = body.role === 'admin' ? 'admin' : 'standard';
    if (!username || password.length < MIN_PASSWORD_LENGTH) {
      sendJson(res, 400, { error: `Username is required and password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
      return true;
    }
    if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
      sendJson(res, 409, { error: 'That username is already taken.' });
      return true;
    }
    const { lastInsertRowid } = db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, hashPassword(password), role);
    logInfo('Auth', `Admin created user "${username}" (${role})`);
    sendJson(res, 201, rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(lastInsertRowid)));
    return true;
  }

  const userItemMatch = urlPath.match(/^\/api\/users\/(\d+)$/);

  // PATCH /api/users/:id — admin-only edit (username/role/password, all
  // optional). Blocks demoting the server's last remaining admin — without
  // this, an admin could lock every admin (including themselves) out of
  // Settings > Users with no way back in short of editing the database by
  // hand.
  if (req.method === 'PATCH' && userItemMatch) {
    const admin = requireAdmin(req, res);
    if (!admin) return true;
    const id = Number(userItemMatch[1]);
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!existing) { sendJson(res, 404, { error: 'User not found' }); return true; }
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return true; }
    const updates = {};
    if (body.username !== undefined) {
      const username = String(body.username).trim();
      if (!username) { sendJson(res, 400, { error: 'Username cannot be empty.' }); return true; }
      const clash = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, id);
      if (clash) { sendJson(res, 409, { error: 'That username is already taken.' }); return true; }
      updates.username = username;
    }
    if (body.role !== undefined) {
      const role = body.role === 'admin' ? 'admin' : 'standard';
      if (existing.role === 'admin' && role !== 'admin' && adminCount() <= 1) {
        sendJson(res, 400, { error: 'At least one admin must remain.' });
        return true;
      }
      updates.role = role;
    }
    if (body.password) {
      if (String(body.password).length < MIN_PASSWORD_LENGTH) {
        sendJson(res, 400, { error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
        return true;
      }
      updates.password_hash = hashPassword(String(body.password));
    }
    if (Object.keys(updates).length > 0) {
      const setClause = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
      db.prepare(`UPDATE users SET ${setClause} WHERE id = ?`).run(...Object.values(updates), id);
    }
    logInfo('Auth', `Admin updated user "${existing.username}"`);
    sendJson(res, 200, rowToUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
    return true;
  }

  // DELETE /api/users/:id — admin-only remove. Blocks removing your own
  // account (use another admin, or edit your own account from My Account
  // instead) and removing the last remaining admin, same rationale as the
  // demotion guard above. Also clears any of that user's active sessions so
  // a removed account can't keep using a still-valid cookie.
  if (req.method === 'DELETE' && userItemMatch) {
    const admin = requireAdmin(req, res);
    if (!admin) return true;
    const id = Number(userItemMatch[1]);
    const existing = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!existing) { sendJson(res, 404, { error: 'User not found' }); return true; }
    if (id === admin.id) { sendJson(res, 400, { error: 'You cannot remove your own account.' }); return true; }
    if (existing.role === 'admin' && adminCount() <= 1) {
      sendJson(res, 400, { error: 'At least one admin must remain.' });
      return true;
    }
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM users WHERE id = ?').run(id);
    logInfo('Auth', `Admin removed user "${existing.username}"`);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

module.exports = { handleAuthApi, getSessionUser };
