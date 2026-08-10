// ---------------------------------------------------------------------------
// GET /api/mal/search — official MyAnimeList search, retried on transient
// failures, falling back to TheTVDB (anime-filtered) if it keeps failing.
// ---------------------------------------------------------------------------
const { logWarn, logError } = require('../logger');
const { sendJson } = require('../lib/http');
const { sleep } = require('../lib/util');
const { fetchMalSearchOnce, MAL_MAX_ATTEMPTS, MAL_RETRY_DELAYS_MS } = require('../lib/mal');
const { tvdbSearchAnimeOnly } = require('../lib/tvdb');

async function handleMalApi(req, res, urlPath) {
  if (req.method !== 'GET' || urlPath !== '/api/mal/search') return false;

  const q = new URL(req.url, 'http://localhost').searchParams.get('q') || '';
  if (!q.trim()) {
    sendJson(res, 200, []);
    return true;
  }
  const query = q.trim();

  // Tier 1: the official API, retried on transient failures.
  let officialErr = null;
  let attemptsMade = 0;
  for (let attempt = 1; attempt <= MAL_MAX_ATTEMPTS; attempt++) {
    attemptsMade = attempt;
    try {
      const results = await fetchMalSearchOnce(query);
      sendJson(res, 200, results); // an empty array here is a genuine "no matches", not an error
      return true;
    } catch (err) {
      officialErr = err;
      // Retrying into a rate limit only makes it worse, and retrying with
      // no client id configured is pointless — go straight to TVDB either way.
      if (err.code === 'MAL_RATE_LIMIT' || err.code === 'MAL_NO_CLIENT_ID') break;
      if (attempt < MAL_MAX_ATTEMPTS) {
        const delay = MAL_RETRY_DELAYS_MS[attempt - 1] || 1500;
        logWarn('MalService', `Search attempt ${attempt}/${MAL_MAX_ATTEMPTS} failed (${err.message}) — retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  const officialReason = officialErr.code === 'MAL_NO_CLIENT_ID' ? 'was skipped (no MAL_CLIENT_ID)'
    : officialErr.code === 'MAL_RATE_LIMIT' ? 'is rate-limiting us'
    : `failed after ${attemptsMade} attempt(s) (${officialErr.message})`;

  // Tier 2: TVDB, filtered to anime — used only when the official API
  // actually fails or is unreachable, not when it succeeds with zero
  // results (that's returned above as a normal empty list).
  logWarn('MalService', `Official API search ${officialReason} — falling back to TVDB.`);
  try {
    const results = await tvdbSearchAnimeOnly(query);
    sendJson(res, 200, results);
  } catch (fallbackErr) {
    logError('MalService', `TVDB fallback also failed: ${fallbackErr.message}`);
    sendJson(res, 502, {
      error: `MyAnimeList's official API ${officialReason}, and the TheTVDB fallback also failed (${fallbackErr.message}).`,
    });
  }
  return true;
}

module.exports = { handleMalApi };
