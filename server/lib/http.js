// ---------------------------------------------------------------------------
// Small shared HTTP helpers used by every route module.
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) req.destroy(); // basic guard against runaway bodies
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Cookies — added for server/routes/auth.js's session cookie (see that
// file). No cookie-parsing dependency in this "zero backend dependencies"
// project, so this is a small hand-rolled parser/serializer rather than
// reaching for one. HttpOnly + SameSite=Lax on every cookie this app sets
// (just the one session cookie, currently) — no Secure flag, since a
// self-hosted app like this one is commonly reached over plain HTTP on a
// LAN (same assumption Sonarr/Radarr's own default auth makes).
// ---------------------------------------------------------------------------
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    if (key) out[key] = decodeURIComponent(val);
  });
  return out;
}

function setCookie(res, name, value, { maxAgeSeconds } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (maxAgeSeconds != null) parts.push(`Max-Age=${maxAgeSeconds}`);
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearCookie(res, name) {
  res.setHeader('Set-Cookie', `${name}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

module.exports = { sendJson, readJsonBody, parseCookies, setCookie, clearCookie };
