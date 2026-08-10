// ---------------------------------------------------------------------------
// Pushover API client — real network calls to api.pushover.net, same spirit
// as server/lib/download-clients/qbittorrent.js (real request, real timeout,
// real error message parsed out of the response) rather than a simulated
// result. The one real integration under Settings > Connect; every other
// Connect type (Slack, Plex, Gotify) still uses ConnectionManager's generic
// simulated Test in frontend/components/ConnectionManager.jsx.
//
// API reference: https://pushover.net/api
// ---------------------------------------------------------------------------

const SEND_URL = 'https://api.pushover.net/1/messages.json';
const CONNECT_TIMEOUT_MS = 10000;

// Same normalization qbittorrent.js uses: fetch's AbortError on timeout
// isn't a useful message on its own, and a network failure vs. a timeout
// should read the same to whatever's showing this to the user either way.
async function fetchWithTimeout(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Timed out after ${CONNECT_TIMEOUT_MS / 1000}s connecting to Pushover`);
    }
    throw new Error(`Could not reach Pushover: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }
}

// priority: Pushover's own -2..2 scale (Lowest/Low/Normal/High/Emergency —
// see https://pushover.net/api#priority). Emergency (2) additionally
// requires `retry`/`expire` params and returns a receipt to poll — a
// second API (Receipts) this app has no use for, so the Connect page's
// Priority field only ever offers -2..1 and this function doesn't attempt
// to special-case 2.
async function sendPushoverNotification({ apiToken, userKey, title, message, priority }) {
  if (!apiToken || !userKey) {
    return { ok: false, error: 'API Token and User Key are both required.' };
  }
  if (!message) {
    return { ok: false, error: 'A message is required.' };
  }

  const params = new URLSearchParams({ token: apiToken, user: userKey, message });
  if (title) params.set('title', title);
  if (typeof priority === 'number' && priority !== 0) params.set('priority', String(priority));

  let res;
  try {
    res = await fetchWithTimeout(SEND_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }

  let json;
  try {
    json = await res.json();
  } catch {
    return { ok: false, error: `Pushover returned a non-JSON response (status ${res.status})` };
  }

  // Per Pushover's own documented contract (see "Being Friendly to our
  // API" on their docs page): status === 1 is the only real success case.
  // A non-1 status arrives with a 4xx and an `errors` array explaining
  // which parameter was rejected (bad token, invalid user key, over quota,
  // etc.) — surfaced as-is rather than a generic "failed" message, the same
  // way qbittorrent.js's testConnection surfaces qBittorrent's own login
  // rejection reason instead of masking it.
  if (json.status === 1) {
    return { ok: true, request: json.request };
  }
  const errorMessage = Array.isArray(json.errors) && json.errors.length > 0
    ? json.errors.join('; ')
    : `Pushover rejected the request (status ${res.status})`;
  return { ok: false, error: errorMessage };
}

module.exports = { sendPushoverNotification };
