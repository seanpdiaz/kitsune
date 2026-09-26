// ---------------------------------------------------------------------------
// Single sign-on through OpenID Connect — "Sign in with <provider>" on the
// login page, configured in Settings > General. The protocol itself lives in
// server/lib/oidc.js; this file owns the routes, the config, and turning a
// verified provider identity into a Kitsune account + normal session (the
// exact same `sessions` row and cookie a password sign-in gets — see
// routes/auth.js — so nothing downstream needs to know SSO was involved).
//
// Routes:
//   GET  /api/auth/oidc/status    public  — is SSO on, and what to call it
//   GET  /api/auth/oidc/login     public  — starts a sign-in (302 to provider)
//   GET  /api/auth/oidc/callback  public  — provider redirects back here
//   GET  /api/auth/oidc/config    admin   — settings (secret never returned)
//   PUT  /api/auth/oidc/config    admin   — save settings
//   POST /api/auth/oidc/test      admin   — check discovery + JWKS
//
// Accounts: the first SSO sign-in for a provider identity creates a Kitsune
// account (auth_source 'oidc', no password) named from the configured
// username claim, unless "Create accounts automatically" is off. If a local
// account with that username already exists it is only linked when "Link
// existing accounts by username" is on — off by default, since a provider
// that lets people pick their own username could otherwise hand someone an
// existing admin account. After that, the identity is matched by
// issuer + sub, so renaming either side doesn't break the link.
//
// Admin role: when an Admin Group is set, membership in it (read from the
// groups claim) decides admin vs. standard on every sign-in — except that
// the server's last remaining admin is never demoted this way. With no
// Admin Group, SSO accounts start as standard and roles are managed in
// Settings > Users as usual.
//
// Stored in app_settings under the 'oidc' section, which the generic
// /api/app-settings route deliberately refuses to serve (see
// routes/app-settings.js) so the client secret is only ever reachable
// through the admin-only endpoints below — and even those never send it
// back, only whether one is set.
// ---------------------------------------------------------------------------
const db = require('../db');
const { logInfo, logWarn, logError } = require('../logger');
const { sendJson, readJsonBody, parseCookies, setCookie, clearCookie } = require('../lib/http');
const oidc = require('../lib/oidc');
const {
  SESSION_COOKIE,
  SESSION_MAX_AGE_SECONDS,
  createSession,
  requireAdmin,
  adminCount,
} = require('./auth');

const CONFIG_SECTION = 'oidc';
const CALLBACK_PATH = '/api/auth/oidc/callback';
const PENDING_COOKIE = 'kitsune_oidc';
const PENDING_TTL_SECONDS = 10 * 60;
const MAX_PENDING = 500;
const MAX_USERNAME_LENGTH = 100;

const DEFAULT_CONFIG = {
  enabled: false,
  providerName: '',
  issuer: '',
  clientId: '',
  clientSecret: '',
  scopes: 'openid profile email',
  usernameClaim: 'preferred_username',
  groupsClaim: 'groups',
  adminGroup: '',
  autoCreateUsers: true,
  linkExistingByUsername: false,
  publicUrl: '',
};

db.init(async () => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      section TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    )
  `);
});

class UserFacingError extends Error {}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
async function loadConfig() {
  const row = await db.prepare('SELECT data FROM app_settings WHERE section = ?').get(CONFIG_SECTION);
  let stored = {};
  if (row) {
    try { stored = JSON.parse(row.data) || {}; } catch { stored = {}; }
  }
  return { ...DEFAULT_CONFIG, ...stored };
}

async function saveConfig(cfg) {
  await db.prepare(`
    INSERT INTO app_settings (section, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(section) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(CONFIG_SECTION, JSON.stringify(cfg), db.now());
}

function isUsable(cfg) {
  return !!(cfg.enabled && cfg.issuer && cfg.clientId);
}

function displayName(cfg) {
  return cfg.providerName || 'single sign-on';
}

// The origin this browser reached Kitsune at, for building the redirect
// URI. Behind a reverse proxy that's the proxy's forwarded host/proto
// (Caddy sends both by default). Trusting these headers is safe here: the
// provider only ever redirects to a URI registered for the client, so a
// spoofed value just produces a sign-in the provider refuses. Public URL in
// Settings overrides all of this for setups where the headers are wrong.
function requestOrigin(req) {
  const first = (value) => String(value || '').split(',')[0].trim();
  const proto = first(req.headers['x-forwarded-proto']) || (req.socket && req.socket.encrypted ? 'https' : 'http');
  const host = first(req.headers['x-forwarded-host']) || req.headers.host || 'localhost';
  return `${proto}://${host}`;
}

function redirectUriFor(req, cfg) {
  const base = cfg.publicUrl ? cfg.publicUrl.trim().replace(/\/+$/, '') : requestOrigin(req);
  return `${base}${CALLBACK_PATH}`;
}

function publicConfig(cfg, req) {
  const { clientSecret, ...rest } = cfg;
  return { ...rest, hasClientSecret: !!clientSecret, redirectUri: redirectUriFor(req, cfg) };
}

function cleanString(value, max = 500) {
  return String(value == null ? '' : value).trim().slice(0, max);
}

// Merges a PUT body onto the stored config. The secret is write-only: a
// non-empty clientSecret replaces it, clearClientSecret removes it, and
// anything else leaves it alone (so saving the form without retyping the
// secret doesn't wipe it).
function applyConfigUpdate(current, body) {
  const next = { ...current };
  if (body.enabled !== undefined) next.enabled = !!body.enabled;
  if (body.providerName !== undefined) next.providerName = cleanString(body.providerName, 40);
  if (body.issuer !== undefined) next.issuer = cleanString(body.issuer);
  if (body.clientId !== undefined) next.clientId = cleanString(body.clientId);
  if (typeof body.clientSecret === 'string' && body.clientSecret !== '') next.clientSecret = body.clientSecret;
  if (body.clearClientSecret === true) next.clientSecret = '';
  if (body.scopes !== undefined) {
    const scopes = cleanString(body.scopes).split(/\s+/).filter(Boolean);
    if (!scopes.includes('openid')) scopes.unshift('openid');
    next.scopes = [...new Set(scopes)].join(' ');
  }
  if (body.usernameClaim !== undefined) next.usernameClaim = cleanString(body.usernameClaim, 100) || DEFAULT_CONFIG.usernameClaim;
  if (body.groupsClaim !== undefined) next.groupsClaim = cleanString(body.groupsClaim, 100) || DEFAULT_CONFIG.groupsClaim;
  if (body.adminGroup !== undefined) next.adminGroup = cleanString(body.adminGroup, 200);
  if (body.autoCreateUsers !== undefined) next.autoCreateUsers = !!body.autoCreateUsers;
  if (body.linkExistingByUsername !== undefined) next.linkExistingByUsername = !!body.linkExistingByUsername;
  if (body.publicUrl !== undefined) next.publicUrl = cleanString(body.publicUrl);

  if (next.issuer && !/^https?:\/\/[^/]/i.test(next.issuer)) throw new UserFacingError('Issuer URL must start with https:// (or http://).');
  if (next.publicUrl && !/^https?:\/\/[^/]/i.test(next.publicUrl)) throw new UserFacingError('Public URL must start with https:// (or http://), e.g. https://kitsune.example.com');
  if (next.enabled && (!next.issuer || !next.clientId)) throw new UserFacingError('Issuer URL and Client ID are required to turn on single sign-on.');
  return next;
}

// ---------------------------------------------------------------------------
// In-flight sign-ins — state/nonce/PKCE verifier for each browser that has
// been sent to the provider and not come back yet. In memory on purpose: it
// lives for minutes, and a restart mid-sign-in just means clicking the
// button again. Keyed by a random id in a short-lived cookie, so a callback
// only completes in the same browser that started it.
// ---------------------------------------------------------------------------
const pending = new Map();

function prunePending() {
  const now = Date.now();
  for (const [id, entry] of pending) {
    if (entry.expiresAt <= now) pending.delete(id);
  }
  while (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
}

// Only ever redirect back to one of this app's own pages — `next` comes from
// the query string, so anything else (another site, javascript:, //host)
// falls back to the Library.
function safeNext(next) {
  const value = String(next || '');
  return /^[A-Za-z0-9_-]+\.html(\?[A-Za-z0-9_.~%&=+-]*)?$/.test(value) ? value : 'index.html';
}

function redirect(res, location) {
  res.writeHead(302, { Location: location, 'Cache-Control': 'no-store' });
  res.end();
}

function failToLogin(res, message) {
  redirect(res, `/login.html?sso_error=${encodeURIComponent(message)}`);
}

// ---------------------------------------------------------------------------
// Claims → Kitsune account
// ---------------------------------------------------------------------------
function claimAt(claims, path) {
  if (!path) return undefined;
  if (Object.prototype.hasOwnProperty.call(claims, path)) return claims[path];
  return path.split('.').reduce((obj, key) => (obj && typeof obj === 'object' ? obj[key] : undefined), claims);
}

function groupsFrom(claims, claimName) {
  const value = claimAt(claims, claimName);
  if (Array.isArray(value)) return value.map((g) => String(g));
  if (typeof value === 'string' && value) return [value];
  return [];
}

function usernameFrom(claims, claimName) {
  for (const candidate of [claimAt(claims, claimName), claims.preferred_username, claims.email]) {
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim().slice(0, MAX_USERNAME_LENGTH);
  }
  return '';
}

async function provisionUser(cfg, claims) {
  const provider = displayName(cfg);
  const subject = `${oidc.normalizeIssuer(claims.iss)}|${claims.sub}`;
  const adminGroup = cfg.adminGroup.trim();
  const wantsAdmin = adminGroup ? groupsFrom(claims, cfg.groupsClaim).includes(adminGroup) : null;

  let row = await db.prepare('SELECT * FROM users WHERE oidc_subject = ?').get(subject);

  if (!row) {
    const username = usernameFrom(claims, cfg.usernameClaim);
    if (!username) {
      throw new UserFacingError(`${provider} didn't send a username (no "${cfg.usernameClaim}", "preferred_username" or "email" claim). Check the scopes in Settings > General.`);
    }
    const existing = await db.prepare('SELECT * FROM users WHERE username = ?').get(username);
    if (existing) {
      if (!cfg.linkExistingByUsername || existing.oidc_subject) {
        throw new UserFacingError(`A Kitsune account named "${username}" already exists and isn't linked to ${provider}. An admin can turn on "Link existing accounts by username" in Settings > General.`);
      }
      await db.prepare('UPDATE users SET oidc_subject = ? WHERE id = ?').run(subject, existing.id);
      logInfo('Auth', `Linked existing account "${username}" to its ${provider} identity`);
      row = { ...existing, oidc_subject: subject };
    } else {
      if (!cfg.autoCreateUsers) {
        throw new UserFacingError(`There's no Kitsune account for "${username}". Ask an admin to add one.`);
      }
      row = await db.prepare(
        'INSERT INTO users (username, password_hash, role, created_at, auth_source, oidc_subject) VALUES (?, ?, ?, ?, ?, ?) RETURNING *'
      ).get(username, '', wantsAdmin ? 'admin' : 'standard', db.now(), 'oidc', subject);
      logInfo('Auth', `Created account "${username}" (${row.role}) on first ${provider} sign-in`);
    }
  }

  if (wantsAdmin !== null) {
    const desired = wantsAdmin ? 'admin' : 'standard';
    if (row.role !== desired) {
      if (row.role === 'admin' && (await adminCount()) <= 1) {
        logWarn('Auth', `"${row.username}" isn't in the "${adminGroup}" group, but is the last admin — leaving them as admin`);
      } else {
        await db.prepare('UPDATE users SET role = ? WHERE id = ?').run(desired, row.id);
        logInfo('Auth', `"${row.username}" is now ${desired} (from "${adminGroup}" group membership)`);
        row = { ...row, role: desired };
      }
    }
  }
  return row;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------
async function handleLogin(req, res) {
  const cfg = await loadConfig();
  if (!isUsable(cfg)) {
    failToLogin(res, 'Single sign-on is not turned on.');
    return;
  }
  let doc;
  try {
    doc = await oidc.discover(cfg.issuer);
  } catch (err) {
    logError('Auth', `SSO sign-in could not start: ${err.message}`);
    failToLogin(res, `Couldn't reach ${displayName(cfg)}: ${err.message}`);
    return;
  }

  prunePending();
  const id = oidc.randomToken();
  const codeVerifier = oidc.randomToken(48);
  const entry = {
    state: oidc.randomToken(),
    nonce: oidc.randomToken(),
    codeVerifier,
    redirectUri: redirectUriFor(req, cfg),
    issuer: cfg.issuer,
    clientId: cfg.clientId,
    next: safeNext(new URL(req.url, 'http://kitsune.invalid').searchParams.get('next')),
    expiresAt: Date.now() + PENDING_TTL_SECONDS * 1000,
  };
  pending.set(id, entry);

  setCookie(res, PENDING_COOKIE, id, { maxAgeSeconds: PENDING_TTL_SECONDS });
  redirect(res, oidc.buildAuthorizationUrl(doc, {
    clientId: cfg.clientId,
    redirectUri: entry.redirectUri,
    scope: cfg.scopes,
    state: entry.state,
    nonce: entry.nonce,
    codeChallenge: oidc.pkceChallenge(codeVerifier),
  }));
}

async function handleCallback(req, res) {
  const params = new URL(req.url, 'http://kitsune.invalid').searchParams;
  const id = parseCookies(req)[PENDING_COOKIE];
  clearCookie(res, PENDING_COOKIE);
  const entry = id ? pending.get(id) : null;
  if (id) pending.delete(id);

  if (!entry || entry.expiresAt <= Date.now()) {
    failToLogin(res, 'That sign-in attempt expired or was started in a different browser. Please try again.');
    return;
  }
  const state = params.get('state');
  if (!state || !oidc.safeEqual(state, entry.state)) {
    logWarn('Auth', 'SSO callback rejected: state mismatch');
    failToLogin(res, "The sign-in response didn't match this sign-in attempt. Please try again.");
    return;
  }

  const cfg = await loadConfig();
  const provider = displayName(cfg);
  if (params.get('error')) {
    const detail = params.get('error_description') || params.get('error');
    logWarn('Auth', `${provider} returned an error: ${detail}`);
    failToLogin(res, `${provider} didn't complete the sign-in: ${detail}`);
    return;
  }
  const code = params.get('code');
  if (!code) {
    failToLogin(res, `${provider} didn't return an authorization code.`);
    return;
  }
  if (!isUsable(cfg) || cfg.issuer !== entry.issuer || cfg.clientId !== entry.clientId) {
    failToLogin(res, 'Single sign-on settings changed during sign-in. Please try again.');
    return;
  }

  try {
    const doc = await oidc.discover(cfg.issuer);
    const tokens = await oidc.exchangeCode(doc, {
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      code,
      redirectUri: entry.redirectUri,
      codeVerifier: entry.codeVerifier,
    });
    const idClaims = await oidc.verifyIdToken(doc, tokens.id_token, {
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      nonce: entry.nonce,
    });

    let userinfo = {};
    try {
      userinfo = await oidc.fetchUserinfo(doc, tokens.access_token, idClaims.sub);
    } catch (err) {
      if (err.code === 'SUB_MISMATCH') throw err;
      logWarn('Auth', `Couldn't load UserInfo from ${provider}, using ID token claims only: ${err.message}`);
    }
    // ID token claims win — they're the signed, verified ones.
    const claims = { ...userinfo, ...idClaims };

    const user = await provisionUser(cfg, claims);
    setCookie(res, SESSION_COOKIE, await createSession(user.id), { maxAgeSeconds: SESSION_MAX_AGE_SECONDS });
    logInfo('Auth', `"${user.username}" signed in via ${provider}`);
    redirect(res, `/${entry.next}`);
  } catch (err) {
    if (err instanceof UserFacingError) {
      logWarn('Auth', `SSO sign-in refused: ${err.message}`);
      failToLogin(res, err.message);
    } else {
      logError('Auth', `SSO sign-in failed: ${err.stack || err}`);
      failToLogin(res, `Sign-in with ${provider} failed: ${err.message}`);
    }
  }
}

async function handleOidcApi(req, res, urlPath) {
  if (!urlPath.startsWith('/api/auth/oidc/')) return false;

  if (req.method === 'GET' && urlPath === '/api/auth/oidc/status') {
    const cfg = await loadConfig();
    sendJson(res, 200, { enabled: isUsable(cfg), providerName: cfg.providerName || 'SSO' });
    return true;
  }

  if (req.method === 'GET' && urlPath === '/api/auth/oidc/login') {
    await handleLogin(req, res);
    return true;
  }

  if (req.method === 'GET' && urlPath === CALLBACK_PATH) {
    await handleCallback(req, res);
    return true;
  }

  if (urlPath === '/api/auth/oidc/config' && (req.method === 'GET' || req.method === 'PUT')) {
    if (!(await requireAdmin(req, res))) return true;
    const current = await loadConfig();
    if (req.method === 'GET') {
      sendJson(res, 200, publicConfig(current, req));
      return true;
    }
    let body;
    try { body = await readJsonBody(req); } catch { sendJson(res, 400, { error: 'Invalid JSON body' }); return true; }
    let next;
    try {
      next = applyConfigUpdate(current, body || {});
    } catch (err) {
      if (err instanceof UserFacingError) { sendJson(res, 400, { error: err.message }); return true; }
      throw err;
    }
    await saveConfig(next);
    logInfo('Auth', `Single sign-on settings saved (${next.enabled ? 'on' : 'off'})`);
    sendJson(res, 200, publicConfig(next, req));
    return true;
  }

  if (req.method === 'POST' && urlPath === '/api/auth/oidc/test') {
    if (!(await requireAdmin(req, res))) return true;
    let body;
    try { body = await readJsonBody(req); } catch { body = {}; }
    const issuer = cleanString((body && body.issuer) || (await loadConfig()).issuer);
    if (!issuer) { sendJson(res, 400, { ok: false, error: 'Enter an Issuer URL first.' }); return true; }
    try {
      const doc = await oidc.discover(issuer, { force: true });
      const jwks = await oidc.loadJwks(doc.jwks_uri, true);
      sendJson(res, 200, {
        ok: true,
        issuer: doc.issuer,
        authorizationEndpoint: doc.authorization_endpoint,
        tokenEndpoint: doc.token_endpoint,
        userinfoEndpoint: doc.userinfo_endpoint || null,
        signingAlgs: doc.id_token_signing_alg_values_supported || [],
        keyCount: jwks.keys.length,
      });
    } catch (err) {
      sendJson(res, 200, { ok: false, error: err.message });
    }
    return true;
  }

  return false;
}

module.exports = { handleOidcApi };
