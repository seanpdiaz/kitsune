// ---------------------------------------------------------------------------
// NZBGet JSON-RPC API client — real network calls to a real NZBGet instance,
// mirroring server/lib/download-clients/qbittorrent.js's role for the
// torrent side. Settings > Download Clients' Test button for an NZBGet-type
// client hits this.
//
// NZBGet's JSON-RPC is much simpler than qBittorrent's WebUI: one endpoint
// (/jsonrpc), HTTP Basic auth on every call (no separate login step/session
// cookie), positional params only, no batching. `version` is the lightest
// call that both proves the credentials work and confirms what NZBGet
// actually returned — same "auth + one authenticated call" shape the
// qBittorrent client tests use.
// ---------------------------------------------------------------------------

const CONNECT_TIMEOUT_MS = 8000;

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

async function rpcCall({ host, port, useSsl, username, password }, method, params = []) {
  const base = `${useSsl ? 'https' : 'http'}://${host}:${port}/jsonrpc`;
  const auth = Buffer.from(`${username || ''}:${password || ''}`).toString('base64');
  const res = await fetchWithTimeout(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${auth}` },
    body: JSON.stringify({ method, params, id: 1 }),
  });
  if (res.status === 401) {
    const err = new Error('Login rejected — check username/password.');
    err.code = 'AUTH';
    throw err;
  }
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`NZBGet returned a non-JSON response (status ${res.status}). Is this really an NZBGet server?`);
  }
  if (!res.ok) {
    throw new Error(`NZBGet request failed (status ${res.status}).`);
  }
  if (json.error) {
    throw new Error(json.error.message || 'NZBGet returned an RPC error.');
  }
  return json.result;
}

async function testConnection(config) {
  try {
    const version = await rpcCall(config, 'version');
    return { ok: true, version: version || 'unknown' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = { testConnection };
