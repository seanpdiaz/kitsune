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
const db = require('../db');
const { logInfo, logWarn } = require('../logger');
const { sendJson, readJsonBody, parseCookies, setCookie, clearCookie } = require('../lib/http');
const { hashPassword, verifyPassword, generateSessionToken } = require('../lib/auth');

const SESSION_COOKIE = 'kitsune_session';
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30; // 30 days
const MIN_PASSWORD_LENGTH = 8;

db.init(async () => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id ${db.PK},
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'standard',
      created_at TEXT NOT NULL
    )
  `);

  await db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);

  // Own idempotent CREATE TABLE for app_settings, same convention disk-
  // usage.js/permissions.js/refresh-series-task.js already use — this file
  // now reads Settings > General's Authentication Method out of that same
  // table (see isAuthDisabled below) and doesn't want to depend on require()
  // order against routes/app-settings.js (which owns it) to make sure the
  // table exists first.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      section TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    )
  `);
});

// Never spreads the raw row — password_hash must never reach a client, the
// one property this project's usual generic rowToItem() (settings-items.js)
// doesn't give us, which is exactly why Users has its own route file instead
// of just being another settings_items section.
function rowToUser(row) {
  return { id: row.id, username: row.username, role: row.role, createdAt: row.created_at };
}

async function userCount() {
  return (await db.prepare('SELECT COUNT(*) AS n FROM users').get()).n;
}

async function adminCount() {
  return (await db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get()).n;
}

// Settings > General's Authentication Method (frontend/pages/settings-
// general/GeneralPage.jsx's authMethodSelect, persisted through the generic
// /api/app-settings/general section — see server/routes/app-settings.js)
// used to be purely cosmetic: it only toggled whether that settings page
// showed its own Username/Password rows, and nothing server-side ever read
// it — every request still hit the real login gate regardless of what was
// picked. This is the read side of actually honoring it — falls back to
// 'forms' (the same default the settings page itself uses — see
// GeneralPage.jsx's DEFAULTS) for a value that's missing, unparseable, or
// not one of the three real options, so an unrecognized value behaves like
// the safest/strictest choice rather than silently disabling auth.
async function getAuthMethod() {
  const row = await db.prepare("SELECT data FROM app_settings WHERE section = 'general'").get();
  if (!row) return 'forms';
  try {
    const method = JSON.parse(row.data).authMethodSelect;
    return method === 'none' || method === 'basic' ? method : 'forms';
  } catch {
    return 'forms';
  }
}

async function isAuthDisabled() {
  return (await getAuthMethod()) === 'none';
}

// Authorization: Basic <base64("user:pass")> — the one header format real
// HTTP Basic Auth ever sends, same thing curl -u/most HTTP clients and
// every browser's native credential prompt produce. Returns the decoded
// {username, password} pair, or null for anything that isn't a
// well-formed Basic header at all (missing, a different scheme like
// Bearer, malformed base64, no ':' separator) — verifyBasicAuthCredentials
// below is what actually checks whether they're valid.
function parseBasicAuthHeader(req) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Basic ')) return null;
  let decoded;
  try {
    decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
  } catch {
    return null;
  }
  const sep = decoded.indexOf(':');
  if (sep === -1) return null;
  return { username: decoded.slice(0, sep), password: decoded.slice(sep + 1) };
}

// Same credential check handleAuthApi's own POST /api/auth/login uses
// (verifyPassword — constant-time, scrypt-backed, see server/lib/auth.js),
// just fed from a decoded Authorization header instead of a JSON body.
async function verifyBasicAuthCredentials(req) {
  const creds = parseBasicAuthHeader(req);
  if (!creds) return null;
  const row = await db.prepare('SELECT * FROM users WHERE username = ?').get(creds.username);
  if (!row || !(await verifyPassword(creds.password, row.password_hash))) {
    logWarn('Auth', `Failed Basic Auth attempt for "${creds.username}"`);
    return null;
  }
  return row;
}

// Called from server.js right before it serves any *.html page (see that
// file's own call site) — this is what makes "Basic (browser popup)"
// actually mean the browser's own native credential prompt, instead of
// this app's own login.html form. Returns true when this response has
// already been fully handled (a 401 challenge) and the caller must stop —
// serving the page after that would undo the whole point of the
// challenge. Returns false for every case where the caller should just
// carry on serving the page normally: the auth method isn't 'basic'; setup
// hasn't happened yet, so there's no account to challenge against (the
// existing first-run flow handles this instead, same as it always has);
// an existing session cookie already covers this request (getSessionUser
// — note this never takes the 'none' fallback path here, since that path
// only ever triggers when the method actually IS 'none', not 'basic'); or
// a Basic header just got verified, in which case a fresh session cookie
// rides along on the very same response the caller is about to send — see
// getSessionUser/every other route for why minting a real session here,
// instead of re-checking the Authorization header on every single request
// forever after, is enough: every one of them already knows how to work
// off a session cookie, so this is the only place that needs to know
// Basic Auth was ever involved.
async function handleBasicAuthChallenge(req, res) {
  if ((await getAuthMethod()) !== 'basic') return false;
  if ((await userCount()) === 0) return false;
  if (await getSessionUser(req)) return false;

  const verifiedUser = await verifyBasicAuthCredentials(req);
  if (!verifiedUser) {
    res.writeHead(401, {
      'WWW-Authenticate': 'Basic realm="Kitsune"',
      'Content-Type': 'text/plain',
    });
    res.end('Authentication required.');
    return true;
  }

  setCookie(res, SESSION_COOKIE, await createSession(verifiedUser.id), { maxAgeSeconds: SESSION_MAX_AGE_SECONDS });
  logInfo('Auth', `"${verifiedUser.username}" signed in via Basic Auth`);
  return false;
}

async function createSession(userId) {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  await db.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, userId, db.now(), expiresAt);
  return token;
}

// Reads the session cookie straight off the request — expired sessions are
// deleted lazily here (on the next request that presents one) rather than a
// separate cleanup job, simplest thing that works at this scale.
//
// A real, valid session always wins when one's present — someone who's
// actually signed in (as a specific standard or admin account) stays
// exactly who they signed in as, even while Authentication Method is set
// to "None" below. Only when there's no valid session at all does that
// setting come into play: with it set to "None," every such request is
// treated as the server's first admin account instead of being turned away
// — the same account the first-run "create the admin account" flow already
// created (there's always at least one, or `needsSetup` would still be
// true and the frontend's own auth gate — see nav.js's checkAuthAndInit —
// sends it to first-run setup before this ever matters), just without
// needing to actually prove it with a login every time. This is what makes
// "None" really mean "no login screen, full access" — every requireAuth/
// requireAdmin check downstream goes through this same function, so
// nothing else needed to change to honor it.
async function getSessionUser(req) {
  const token = parseCookies(req)[SESSION_COOKIE];
  if (token) {
    const session = await db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
    if (session) {
      if (new Date(session.expires_at).getTime() < Date.now()) {
        await db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
      } else {
        const user = await db.prepare('SELECT * FROM users WHERE id = ?').get(session.user_id);
        if (user) return rowToUser(user);
      }
    }
  }
  if (await isAuthDisabled()) {
    const admin = await db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY id ASC LIMIT 1").get();
    if (admin) return rowToUser(admin);
  }
  return null;
}

async function requireAuth(req, res) {
  const user = await getSessionUser(req);
  if (!user) {
    sendJson(res, 401, { error: 'Not signed in.' });
    return null;
  }
  return user;
}

async function requireAdmin(req, res) {
  const user = await requireAuth(req, res);
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
    const needsSetup = (await userCount()) === 0;
    sendJson(res, 200, { needsSetup, user: needsSetup ? null : await getSessionUser(req) });
    return true;
  }

  // POST /api/auth/setup — only reachable while the users table is still
  // empty; creates the first account as 'admin' and signs it straight in.
  // Same idea as Sonarr/Radarr's own first-launch prompt, just persisted as
  // a real account instead of a one-time username/password pair in config.
  if (req.method === 'POST' && urlPath === '/api/auth/setup') {
    if ((await userCount()) > 0) {
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
    const created = await db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?) RETURNING *')
      .get(username, await hashPassword(password), 'admin', db.now());
    setCookie(res, SESSION_COOKIE, await createSession(created.id), { maxAgeSeconds: SESSION_MAX_AGE_SECONDS });
    logInfo('Auth', `First-run setup: created admin account "${username}"`);
    sendJson(res, 201, { user: rowToUser(created) });
    return true;
  }

  // POST /api/auth/login
  if (req.method === 'POST' && urlPath === '/api/auth/login') {
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return true; }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const row = await db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    // Same error either way (unknown username vs. wrong password) — doesn't
    // confirm or deny whether a given username exists on this server.
    if (!row || !(await verifyPassword(password, row.password_hash))) {
      logWarn('Auth', `Failed sign-in attempt for "${username}"`);
      sendJson(res, 401, { error: 'Invalid username or password.' });
      return true;
    }
    setCookie(res, SESSION_COOKIE, await createSession(row.id), { maxAgeSeconds: SESSION_MAX_AGE_SECONDS });
    logInfo('Auth', `"${username}" signed in`);
    sendJson(res, 200, { user: rowToUser(row) });
    return true;
  }

  // POST /api/auth/logout
  if (req.method === 'POST' && urlPath === '/api/auth/logout') {
    const token = parseCookies(req)[SESSION_COOKIE];
    if (token) await db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
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
    const user = await requireAuth(req, res);
    if (!user) return true;
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return true; }
    const row = await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    if (!(await verifyPassword(String(body.currentPassword || ''), row.password_hash))) {
      sendJson(res, 400, { error: 'Current password is incorrect.' });
      return true;
    }
    const updates = {};
    if (body.username !== undefined) {
      const username = String(body.username).trim();
      if (!username) { sendJson(res, 400, { error: 'Username cannot be empty.' }); return true; }
      const clash = await db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, user.id);
      if (clash) { sendJson(res, 409, { error: 'That username is already taken.' }); return true; }
      updates.username = username;
    }
    if (body.newPassword) {
      if (String(body.newPassword).length < MIN_PASSWORD_LENGTH) {
        sendJson(res, 400, { error: `New password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
        return true;
      }
      updates.password_hash = await hashPassword(String(body.newPassword));
    }
    if (Object.keys(updates).length > 0) {
      const setClause = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
      await db.prepare(`UPDATE users SET ${setClause} WHERE id = ?`).run(...Object.values(updates), user.id);
      logInfo('Auth', `"${row.username}" updated their own account`);
    }
    sendJson(res, 200, { user: rowToUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(user.id)) });
    return true;
  }

  // GET /api/users — admin-only list for Settings > Users.
  if (req.method === 'GET' && urlPath === '/api/users') {
    if (!(await requireAdmin(req, res))) return true;
    sendJson(res, 200, (await db.prepare('SELECT * FROM users ORDER BY id ASC').all()).map(rowToUser));
    return true;
  }

  // POST /api/users — admin-only create.
  if (req.method === 'POST' && urlPath === '/api/users') {
    if (!(await requireAdmin(req, res))) return true;
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return true; }
    const username = String(body.username || '').trim();
    const password = String(body.password || '');
    const role = body.role === 'admin' ? 'admin' : 'standard';
    if (!username || password.length < MIN_PASSWORD_LENGTH) {
      sendJson(res, 400, { error: `Username is required and password must be at least ${MIN_PASSWORD_LENGTH} characters.` });
      return true;
    }
    if (await db.prepare('SELECT id FROM users WHERE username = ?').get(username)) {
      sendJson(res, 409, { error: 'That username is already taken.' });
      return true;
    }
    const created = await db.prepare('INSERT INTO users (username, password_hash, role, created_at) VALUES (?, ?, ?, ?) RETURNING *')
      .get(username, await hashPassword(password), role, db.now());
    logInfo('Auth', `Admin created user "${username}" (${role})`);
    sendJson(res, 201, rowToUser(created));
    return true;
  }

  const userItemMatch = urlPath.match(/^\/api\/users\/(\d+)$/);

  // PATCH /api/users/:id — admin-only edit (username/role/password, all
  // optional). Blocks demoting the server's last remaining admin — without
  // this, an admin could lock every admin (including themselves) out of
  // Settings > Users with no way back in short of editing the database by
  // hand.
  if (req.method === 'PATCH' && userItemMatch) {
    const admin = await requireAdmin(req, res);
    if (!admin) return true;
    const id = Number(userItemMatch[1]);
    const existing = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!existing) { sendJson(res, 404, { error: 'User not found' }); return true; }
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return true; }
    const updates = {};
    if (body.username !== undefined) {
      const username = String(body.username).trim();
      if (!username) { sendJson(res, 400, { error: 'Username cannot be empty.' }); return true; }
      const clash = await db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, id);
      if (clash) { sendJson(res, 409, { error: 'That username is already taken.' }); return true; }
      updates.username = username;
    }
    if (body.role !== undefined) {
      const role = body.role === 'admin' ? 'admin' : 'standard';
      if (existing.role === 'admin' && role !== 'admin' && (await adminCount()) <= 1) {
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
      updates.password_hash = await hashPassword(String(body.password));
    }
    if (Object.keys(updates).length > 0) {
      const setClause = Object.keys(updates).map((k) => `${k} = ?`).join(', ');
      await db.prepare(`UPDATE users SET ${setClause} WHERE id = ?`).run(...Object.values(updates), id);
    }
    logInfo('Auth', `Admin updated user "${existing.username}"`);
    sendJson(res, 200, rowToUser(await db.prepare('SELECT * FROM users WHERE id = ?').get(id)));
    return true;
  }

  // DELETE /api/users/:id — admin-only remove. Blocks removing your own
  // account (use another admin, or edit your own account from My Account
  // instead) and removing the last remaining admin, same rationale as the
  // demotion guard above. Also clears any of that user's active sessions so
  // a removed account can't keep using a still-valid cookie.
  if (req.method === 'DELETE' && userItemMatch) {
    const admin = await requireAdmin(req, res);
    if (!admin) return true;
    const id = Number(userItemMatch[1]);
    const existing = await db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!existing) { sendJson(res, 404, { error: 'User not found' }); return true; }
    if (id === admin.id) { sendJson(res, 400, { error: 'You cannot remove your own account.' }); return true; }
    if (existing.role === 'admin' && (await adminCount()) <= 1) {
      sendJson(res, 400, { error: 'At least one admin must remain.' });
      return true;
    }
    await db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    await db.prepare('DELETE FROM users WHERE id = ?').run(id);
    logInfo('Auth', `Admin removed user "${existing.username}"`);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

module.exports = { handleAuthApi, getSessionUser, handleBasicAuthChallenge };
