// ---------------------------------------------------------------------------
// /api/releases — what backs the "Search" button on Wanted > Missing/Cutoff
// Unmet (and, going forward, any other per-episode search entry point).
// Generates the same deterministic fake release candidates POST /api/queue
// re-derives when grabbing one — see server/lib/queue-sim.js for why this is
// simulated rather than hitting a real indexer.
// ---------------------------------------------------------------------------
const { db } = require('../db');
const { sendJson } = require('../lib/http');
const { generateReleases } = require('../lib/queue-sim');

async function handleReleasesApi(req, res, urlPath) {
  if (req.method !== 'GET' || urlPath !== '/api/releases') return false;

  const url = new URL(req.url, 'http://localhost');
  const episodeId = Number(url.searchParams.get('episodeId'));
  if (!Number.isInteger(episodeId)) {
    sendJson(res, 400, { error: 'episodeId is required' });
    return true;
  }

  const episode = db.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId);
  if (!episode) {
    sendJson(res, 404, { error: 'Episode not found' });
    return true;
  }
  const series = db.prepare('SELECT * FROM series WHERE id = ?').get(episode.series_id);
  if (!series) {
    sendJson(res, 404, { error: 'Series not found' });
    return true;
  }

  const releases = generateReleases(series, { id: episode.id, num: episode.num, seasonNumber: episode.season_number });
  sendJson(res, 200, { releases });
  return true;
}

module.exports = { handleReleasesApi };
