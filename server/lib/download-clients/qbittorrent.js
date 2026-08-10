// ---------------------------------------------------------------------------
// qBittorrent WebUI API client — real network calls to a real qBittorrent
// instance, unlike the rest of the app's grab/download pipeline (see
// server/lib/queue-sim.js), which is a deliberate in-app simulation. Settings
// > Download Clients' Test button for a qBittorrent-type client hits this.
//
// qBittorrent's WebUI auth is a classic cookie session, not a bearer token:
//   1. POST /api/v2/auth/login (form-encoded username/password) — on success
//      returns body "Ok." plus a `SID` session cookie.
//   2. Every other endpoint needs that SID cookie sent back on each request.
// There's no logout call here — this is a one-shot connectivity test, not a
// held-open session, so the cookie is used once and dropped.
// ---------------------------------------------------------------------------

const CONNECT_TIMEOUT_MS = 8000;

function baseUrl({ host, port, useSsl }) {
  return `${useSsl ? 'https' : 'http'}://${host}:${port}`;
}

// Node's fetch throws an AbortError (not a clean timeout error) when the
// signal fires — normalized here so callers get one consistent "couldn't
// reach it" message regardless of *why* (DNS failure, connection refused,
// or just took too long) fetch failed.
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Timed out after ${CONNECT_TIMEOUT_MS / 1000}s connecting to ${url}`);
    }
    throw new Error(`Could not reach ${url}: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// Pulls just the `SID=...` piece out of a Set-Cookie header — qBittorrent
// sends other cookie attributes (Path, HttpOnly, SameSite) alongside it that
// a manual Cookie header shouldn't try to replay.
function extractSid(setCookieHeader) {
  if (!setCookieHeader) return null;
  const match = setCookieHeader.match(/SID=([^;]+)/);
  return match ? `SID=${match[1]}` : null;
}

// Logs in and confirms the session actually works by asking for the
// server's version — a plain "login returned Ok." isn't quite proof the
// cookie is usable, so this exercises both steps the same way a real grab
// would (auth, then an authenticated call).
async function testConnection({ host, port, useSsl, username, password }) {
  const base = baseUrl({ host, port, useSsl });

  let loginRes;
  try {
    loginRes = await fetchWithTimeout(`${base}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: username || '', password: password || '' }).toString(),
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }

  if (loginRes.status === 403) {
    return { ok: false, error: 'Blocked by qBittorrent (too many failed login attempts — check the WebUI\'s ban list).' };
  }
  const loginBody = await loginRes.text().catch(() => '');
  if (!loginRes.ok || loginBody.trim() !== 'Ok.') {
    return { ok: false, error: 'Login rejected — check username/password.' };
  }

  const sid = extractSid(loginRes.headers.get('set-cookie'));
  if (!sid) {
    return { ok: false, error: 'Login succeeded but no session cookie was returned.' };
  }

  let versionRes;
  try {
    versionRes = await fetchWithTimeout(`${base}/api/v2/app/version`, {
      headers: { Cookie: sid },
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!versionRes.ok) {
    return { ok: false, error: `Connected and logged in, but the version check failed (status ${versionRes.status}).` };
  }
  const version = (await versionRes.text().catch(() => '')).trim();
  return { ok: true, version: version || 'unknown' };
}

module.exports = { testConnection };
