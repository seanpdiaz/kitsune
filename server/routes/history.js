// ---------------------------------------------------------------------------
// /api/history — an append-only log of grab/import/failure/deletion events.
// Replaces Activity > History's old six-row hardcoded array (see README) with
// real rows written by the grab pipeline in queue.js: a grab (POST
// /api/queue) writes a 'grabbed' row immediately, and the simulated
// downloader's completion tick (see queue.js) writes 'imported' on success
// or 'failed' on the rare simulated failure.
// ---------------------------------------------------------------------------
const { db } = require('../db');
const { sendJson } = require('../lib/http');

db.exec(`
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER,
    episode_id INTEGER,
    event_type TEXT NOT NULL,
    release_title TEXT,
    quality TEXT,
    indexer TEXT,
    size_bytes INTEGER,
    message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

const MAX_HISTORY_ROWS = 500;

// Same "keep the newest N, prune on every write" approach the logs table
// already uses (see logger.js) — a long-running server shouldn't grow this
// forever, and nobody's paging back through history further than that in a
// mockup with no real long-term archival need.
function insertHistoryRow({ seriesId, episodeId, eventType, releaseTitle, quality, indexer, sizeBytes, message }) {
  db.prepare(`
    INSERT INTO history (series_id, episode_id, event_type, release_title, quality, indexer, size_bytes, message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(seriesId ?? null, episodeId ?? null, eventType, releaseTitle ?? null, quality ?? null, indexer ?? null, sizeBytes ?? null, message ?? null);
  db.exec(`
    DELETE FROM history WHERE id NOT IN (
      SELECT id FROM history ORDER BY id DESC LIMIT ${MAX_HISTORY_ROWS}
    )
  `);
}

function rowToHistoryEntry(row) {
  return {
    id: row.id,
    seriesId: row.series_id,
    seriesTitle: row.series_title || null,
    episodeId: row.episode_id,
    episodeLabel: row.season_number != null && row.num != null
      ? `S${String(row.season_number).padStart(2, '0')}E${String(row.num).padStart(2, '0')}`
      : null,
    eventType: row.event_type,
    releaseTitle: row.release_title,
    quality: row.quality,
    indexer: row.indexer,
    sizeBytes: row.size_bytes,
    message: row.message,
    createdAt: row.created_at,
  };
}

async function handleHistoryApi(req, res, urlPath) {
  if (req.method !== 'GET' || urlPath !== '/api/history') return false;

  const url = new URL(req.url, 'http://localhost');
  const type = url.searchParams.get('type');
  const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || 100, MAX_HISTORY_ROWS);

  const whereType = type && type !== 'all' ? 'WHERE h.event_type = ?' : '';
  const rows = db.prepare(`
    SELECT h.*, s.title AS series_title, e.season_number, e.num
    FROM history h
    LEFT JOIN series s ON s.id = h.series_id
    LEFT JOIN episodes e ON e.id = h.episode_id
    ${whereType}
    ORDER BY h.id DESC
    LIMIT ?
  `).all(...(whereType ? [type, limit] : [limit]));

  sendJson(res, 200, { history: rows.map(rowToHistoryEntry) });
  return true;
}

module.exports = { handleHistoryApi, insertHistoryRow };
