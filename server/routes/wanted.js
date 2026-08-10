// ---------------------------------------------------------------------------
// /api/wanted/missing and /api/wanted/cutoff-unmet — replaces Wanted >
// Missing/Cutoff Unmet's old hardcoded five/three-row arrays (see README)
// with real queries against the Library + episode cache, now that episodes
// carry a real `downloaded`/`quality` state instead of that being a
// render-time guess (see episodes.js's backfillDownloadedState).
// ---------------------------------------------------------------------------
const { db } = require('../db');
const { sendJson } = require('../lib/http');
const { isBelowCutoff } = require('../lib/quality');

function todayIso() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function episodeRowToWanted(r) {
  return {
    episodeId: r.id,
    seriesId: r.series_id,
    seriesTitle: r.series_title,
    seriesPoster: r.series_poster,
    seasonNumber: r.season_number,
    num: r.num,
    title: r.title,
    aired: r.aired,
  };
}

async function handleWantedApi(req, res, urlPath) {
  // Aired episodes, in a monitored series, that aren't downloaded yet —
  // same "aired but missing" definition real Sonarr's Wanted > Missing uses.
  // Oldest-first, matching real Sonarr's default sort there too (the
  // longest-outstanding gap surfaces first).
  if (req.method === 'GET' && urlPath === '/api/wanted/missing') {
    const rows = db.prepare(`
      SELECT e.id, e.series_id, e.season_number, e.num, e.title, e.aired,
             s.title AS series_title, s.poster AS series_poster
      FROM episodes e
      JOIN series s ON s.id = e.series_id
      WHERE e.downloaded = 0 AND e.aired IS NOT NULL AND e.aired <= ? AND s.monitored = 1
      ORDER BY e.aired ASC
    `).all(todayIso());
    sendJson(res, 200, { episodes: rows.map(episodeRowToWanted) });
    return true;
  }

  // Downloaded episodes whose quality is below their series' quality
  // profile's cutoff — eligible for an automatic upgrade search, same as
  // real Sonarr's Cutoff Unmet. A series with no quality_profile set, or a
  // profile that isn't in Settings > Profiles (deleted after being
  // assigned, a plain string that never matched anything, etc.), has
  // nothing to compare against and is skipped rather than guessed at.
  if (req.method === 'GET' && urlPath === '/api/wanted/cutoff-unmet') {
    const profileRows = db.prepare("SELECT data FROM settings_items WHERE section = 'profiles'").all();
    const cutoffByProfileName = new Map();
    for (const row of profileRows) {
      try {
        const item = JSON.parse(row.data);
        if (item.name) cutoffByProfileName.set(item.name, item.cutoff || null);
      } catch { /* malformed row — skip rather than fail the whole request */ }
    }

    const rows = db.prepare(`
      SELECT e.id, e.series_id, e.season_number, e.num, e.title, e.aired, e.quality,
             s.title AS series_title, s.poster AS series_poster, s.quality_profile
      FROM episodes e
      JOIN series s ON s.id = e.series_id
      WHERE e.downloaded = 1 AND s.monitored = 1
    `).all();

    const unmet = rows
      .map((r) => ({ ...r, cutoff: cutoffByProfileName.get(r.quality_profile) }))
      .filter((r) => r.cutoff && isBelowCutoff(r.quality, r.cutoff))
      .map((r) => ({ ...episodeRowToWanted(r), quality: r.quality, cutoff: r.cutoff }));

    sendJson(res, 200, { episodes: unmet });
    return true;
  }

  return false;
}

module.exports = { handleWantedApi };
