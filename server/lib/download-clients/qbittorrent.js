// ---------------------------------------------------------------------------
// qBittorrent WebUI API client — real network calls to a real qBittorrent
// instance, unlike the rest of the app's grab/download pipeline (see
// server/lib/queue-sim.js), which is a deliberate in-app simulation.
//
// Originally just `testConnection` (Settings > Download Clients' Test
// button). Extended to the rest of the torrent-management surface — add,
// list, pause, resume, delete — so a configured qBittorrent client is
// actually usable from Kitsune, not just reachable. This deliberately does
// NOT wire into the simulated grab pipeline (queue-sim.js still fakes
// releases/magnets — see its own header comment and the wiki's Grab/
// Download Pipeline page for why): there's no real magnet to hand qBittorrent
// from a fake release. What's here is a standalone "manage a real
// qBittorrent instance's real torrents from Kitsune" capability instead,
// reachable from a client row's new "Torrents" button in Settings >
// Download Clients — add a real magnet/torrent URL by hand, and see/control
// what's actually running.
//
// qBittorrent's WebUI auth is a classic cookie session, not a bearer token:
//   1. POST /api/v2/auth/login (form-encoded username/password) — on success
//      returns body "Ok." plus a `SID` session cookie.
//   2. Every other endpoint needs that SID cookie sent back on each request.
// There's no session reuse across calls here — each exported function logs
// in fresh and uses the cookie once. qBittorrent only rate-limits *failed*
// logins (a WebUI ban-list setting), so repeatedly logging in successfully
// carries no penalty; this keeps every function self-contained rather than
// threading a shared, potentially-expired session through the route layer.
// ---------------------------------------------------------------------------

const { logDebug, logWarn } = require('../../logger');

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

// Every request below sets Referer to the exact same origin it's calling —
// qBittorrent's WebUI API docs call this out explicitly as required (CSRF
// protection): a request missing it, or with a mismatched one, can get
// rejected even with a valid session cookie.
async function login({ host, port, useSsl, username, password }) {
  const base = baseUrl({ host, port, useSsl });

  let loginRes;
  try {
    loginRes = await fetchWithTimeout(`${base}/api/v2/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: base },
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

  return { ok: true, base, sid };
}

// Logs in and confirms the session actually works by asking for the
// server's version — a plain "login returned Ok." isn't quite proof the
// cookie is usable, so this exercises both steps the same way a real grab
// would (auth, then an authenticated call).
async function testConnection(config) {
  const auth = await login(config);
  if (!auth.ok) return auth;
  const { base, sid } = auth;

  let versionRes;
  try {
    versionRes = await fetchWithTimeout(`${base}/api/v2/app/version`, {
      headers: { Cookie: sid, Referer: base },
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

// Adds a torrent — either by handing qBittorrent a magnet link / URL to fetch
// itself (`url`), or by uploading a real .torrent file's raw bytes directly
// (`torrentFileBuffer`). The upload path exists for a real reason: a release
// whose only real, real-world lead is an http(s) download URL (see
// server/lib/prowlarr-search.js's magnetUrl-or-downloadUrl fallback, and
// server/routes/queue.js's fetchTorrentFile) would otherwise need qBittorrent
// ITSELF to reach that URL — asynchronously, on qBittorrent's own host, which
// isn't guaranteed to have network access to wherever the indexer lives even
// when Kitsune does. Confirmed as a real bug from a live report: Kitsune's
// own search already proved it could reach the user's Prowlarr instance, but
// handing qBittorrent that same download URL to fetch on its own silently
// produced no torrent at all — no error, just nothing. Uploading the actual
// file bytes (fetched by Kitsune, which already has the working network
// path) means qBittorrent never needs to reach the indexer itself.
//
// qBittorrent's own WebUI API docs document this endpoint's response as
// "Returns Ok. or Fails." — critically, BOTH of those come back as HTTP 200.
// A malformed magnet, a URL qBittorrent couldn't parse, an unknown category,
// or (per real-world reports) a magnet for a torrent qBittorrent already
// knows about in a conflicting state can all come back 200 with a body of
// "Fails." — indistinguishable from success by status code alone. This was
// confirmed to be a real gap here: an earlier version of this function only
// checked res.ok/res.status and treated any 200 as success, meaning a
// "Fails." response was silently recorded as a successful real grab —
// exactly the shape of bug that would produce a Kitsune log line saying
// "submitted to a real qBittorrent client" for a torrent that was never
// actually added. The body is always logged at debug level (Settings >
// System > Logs, logger "DownloadClient") so a future case that's neither
// "Ok." nor "Fails." (an unexpected proxy response, say) is still visible
// instead of silently falling through either branch.
async function addTorrent(config, {
  url, torrentFileBuffer, filename, category, sequentialDownload, firstLastPiecePrio,
} = {}) {
  const auth = await login(config);
  if (!auth.ok) return auth;
  const { base, sid } = auth;

  const form = new FormData();
  let submittedDescription;
  if (torrentFileBuffer) {
    // A real Blob (not just a Buffer) — FormData needs something with a
    // `.stream()`/size a multipart encoder can read; Node's FormData accepts
    // a Blob directly, appended with a filename so qBittorrent's own log/UI
    // shows something meaningful rather than a generic "blob".
    form.append('torrents', new Blob([torrentFileBuffer]), filename || 'release.torrent');
    submittedDescription = `a real .torrent file (${torrentFileBuffer.length} bytes, uploaded directly — not a URL for qBittorrent to fetch itself)${filename ? `: ${filename}` : ''}`;
  } else {
    const submittedUrl = String(url || '').trim();
    const urlKind = submittedUrl.startsWith('magnet:') ? 'magnet' : /^https?:\/\//i.test(submittedUrl) ? 'http(s) URL (qBittorrent fetches this itself — it must be reachable from wherever qBittorrent runs, not just from Kitsune)' : 'unknown';
    submittedDescription = `a ${urlKind} — ${submittedUrl}`;
    form.append('urls', submittedUrl);
  }
  logDebug('DownloadClient', `qBittorrent addTorrent: submitting ${submittedDescription} to "${base}"${category ? ` (category "${category}")` : ''}`);

  if (category) form.append('category', category);
  if (sequentialDownload != null) form.append('sequentialDownload', sequentialDownload ? 'true' : 'false');
  if (firstLastPiecePrio != null) form.append('firstLastPiecePrio', firstLastPiecePrio ? 'true' : 'false');

  let res;
  try {
    // No Content-Type header set manually — fetch computes the correct
    // `multipart/form-data; boundary=...` for a FormData body itself; a
    // hand-set Content-Type here would be missing that boundary and qBittorrent
    // wouldn't be able to parse the parts at all.
    res = await fetchWithTimeout(`${base}/api/v2/torrents/add`, {
      method: 'POST',
      headers: { Cookie: sid, Referer: base },
      body: form,
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (res.status === 415) {
    return { ok: false, error: 'qBittorrent rejected that as an invalid torrent.' };
  }
  if (!res.ok) {
    return { ok: false, error: `qBittorrent rejected the request (status ${res.status}).` };
  }
  const bodyText = (await res.text().catch(() => '')).trim();
  logDebug('DownloadClient', `qBittorrent addTorrent response body: "${bodyText}"`);
  if (bodyText === 'Fails.') {
    logWarn('DownloadClient', `qBittorrent accepted the HTTP request (200) but its own response body was "Fails." for: ${submittedDescription}`);
    return { ok: false, error: 'qBittorrent returned "Fails." — it received the request but rejected the torrent itself (invalid/duplicate magnet, unreadable .torrent file, or an unreachable/invalid download URL). Nothing was actually added.' };
  }
  if (bodyText && bodyText !== 'Ok.') {
    // Not documented, but don't silently treat an unrecognized body as
    // success either — surface it exactly like the "Fails." case above so
    // it shows up in logs and gets investigated rather than assumed fine.
    logWarn('DownloadClient', `qBittorrent addTorrent returned an unexpected body (expected "Ok." or "Fails."): "${bodyText}"`);
  }
  return { ok: true };
}

// GET /api/v2/torrents/info — the real, live torrent list. `category` scopes
// it to just this client's configured Kitsune category when provided;
// omitted entirely means "any category" (qBittorrent's own semantics — an
// empty string would instead mean "no category," which isn't what an
// omitted filter should do here).
async function getTorrents(config, { category } = {}) {
  const auth = await login(config);
  if (!auth.ok) return auth;
  const { base, sid } = auth;

  const params = new URLSearchParams();
  if (category) params.set('category', category);
  const query = params.toString();

  let res;
  try {
    res = await fetchWithTimeout(`${base}/api/v2/torrents/info${query ? `?${query}` : ''}`, {
      headers: { Cookie: sid, Referer: base },
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!res.ok) {
    return { ok: false, error: `Could not list torrents (status ${res.status}).` };
  }
  let torrents;
  try {
    torrents = await res.json();
  } catch {
    return { ok: false, error: 'qBittorrent returned an unexpected response.' };
  }
  return { ok: true, torrents };
}

// GET /api/v2/torrents/files?hash= — the real per-file listing inside a
// single torrent: `name` (relative to that torrent's own save_path — a
// subfolder-qualified path for a multi-file torrent, just the bare filename
// for a single-file one) and `size`. Needed once real import has to figure
// out exactly which real file on disk a completed torrent's episode(s) are
// (see server/routes/queue.js's completeRealDownload) — /torrents/info alone
// only ever gave a torrent-level save_path, never what's actually inside it.
async function getTorrentFiles(config, hash) {
  const auth = await login(config);
  if (!auth.ok) return auth;
  const { base, sid } = auth;

  const params = new URLSearchParams({ hash: String(hash || '') });
  let res;
  try {
    res = await fetchWithTimeout(`${base}/api/v2/torrents/files?${params.toString()}`, {
      headers: { Cookie: sid, Referer: base },
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!res.ok) {
    return { ok: false, error: `Could not list files for that torrent (status ${res.status}).` };
  }
  let files;
  try {
    files = await res.json();
  } catch {
    return { ok: false, error: 'qBittorrent returned an unexpected response.' };
  }
  return { ok: true, files };
}

// qBittorrent renamed pause/resume to stop/start as of WebAPI v2.11 (bundled
// with qBittorrent 5.0) — the old endpoints 404 on a 5.0+ server, and (per
// its own docs) the new ones don't exist on anything older. Rather than
// parsing a version string to decide, this just tries the newer name first
// and falls back to the older one on a 404, caching whichever one actually
// worked per-host so later calls skip straight to it instead of re-probing
// every time.
const actionEndpointCache = new Map(); // base URL -> 'new' | 'old'

async function callPauseResumeAction(base, sid, kind, hashParam) {
  const names = kind === 'pause' ? { new: 'stop', old: 'pause' } : { new: 'start', old: 'resume' };
  const cached = actionEndpointCache.get(base);
  const order = cached === 'old' ? [names.old] : cached === 'new' ? [names.new] : [names.new, names.old];

  let lastError = 'Request failed.';
  for (const endpointName of order) {
    let res;
    try {
      res = await fetchWithTimeout(`${base}/api/v2/torrents/${endpointName}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: sid, Referer: base },
        body: new URLSearchParams({ hashes: hashParam }).toString(),
      });
    } catch (err) {
      lastError = err.message;
      continue;
    }
    if (res.status === 404) {
      lastError = `qBittorrent has no /${endpointName} endpoint (status 404).`;
      continue;
    }
    if (!res.ok) {
      lastError = `Request failed (status ${res.status}).`;
      continue;
    }
    actionEndpointCache.set(base, endpointName === names.new ? 'new' : 'old');
    return { ok: true };
  }
  return { ok: false, error: lastError };
}

async function pauseTorrents(config, hashes) {
  const auth = await login(config);
  if (!auth.ok) return auth;
  const hashParam = Array.isArray(hashes) ? hashes.join('|') : hashes;
  return callPauseResumeAction(auth.base, auth.sid, 'pause', hashParam);
}

async function resumeTorrents(config, hashes) {
  const auth = await login(config);
  if (!auth.ok) return auth;
  const hashParam = Array.isArray(hashes) ? hashes.join('|') : hashes;
  return callPauseResumeAction(auth.base, auth.sid, 'resume', hashParam);
}

async function deleteTorrents(config, hashes, deleteFiles) {
  const auth = await login(config);
  if (!auth.ok) return auth;
  const { base, sid } = auth;
  const hashParam = Array.isArray(hashes) ? hashes.join('|') : hashes;

  let res;
  try {
    res = await fetchWithTimeout(`${base}/api/v2/torrents/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: sid, Referer: base },
      body: new URLSearchParams({ hashes: hashParam, deleteFiles: deleteFiles ? 'true' : 'false' }).toString(),
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
  if (!res.ok) {
    return { ok: false, error: `Delete failed (status ${res.status}).` };
  }
  return { ok: true };
}

module.exports = { testConnection, addTorrent, getTorrents, getTorrentFiles, pauseTorrents, resumeTorrents, deleteTorrents };
