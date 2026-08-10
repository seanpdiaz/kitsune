// ---------------------------------------------------------------------------
// GET /api/tvdb/search — standalone TVDB search endpoint (also doubles as
// the anime-filtered fallback used by routes/mal-search.js, via lib/tvdb.js).
// ---------------------------------------------------------------------------
const { logError } = require('../logger');
const { sendJson } = require('../lib/http');
const { tvdbFetch, mapTvdbResult } = require('../lib/tvdb');

async function handleTvdbApi(req, res, urlPath) {
  if (req.method !== 'GET' || urlPath !== '/api/tvdb/search') return false;

  const q = new URL(req.url, 'http://localhost').searchParams.get('q') || '';
  if (!q.trim()) {
    sendJson(res, 200, []);
    return true;
  }

  try {
    const tvdbRes = await tvdbFetch(`/search?query=${encodeURIComponent(q.trim())}&type=series`);
    let json;
    try {
      json = await tvdbRes.json();
    } catch {
      sendJson(res, 502, { error: 'TVDB returned a non-JSON response' });
      return true;
    }
    if (!tvdbRes.ok) {
      sendJson(res, tvdbRes.status, { error: json.message || 'TVDB search failed' });
      return true;
    }
    const results = (json.data || []).map(mapTvdbResult);
    sendJson(res, 200, results);
  } catch (err) {
    if (err.code === 'TVDB_NO_KEY') {
      sendJson(res, 500, { error: err.message });
    } else {
      logError('TvdbService', `Search failed: ${err.message || err}`);
      sendJson(res, 502, { error: 'Could not reach TheTVDB. ' + (err.message || '') });
    }
  }
  return true;
}

module.exports = { handleTvdbApi };
