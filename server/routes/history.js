// ---------------------------------------------------------------------------
// /api/history — an append-only log of grab/import/failure/deletion events.
// Replaces Activity > History's old six-row hardcoded array (see README) with
// real rows written by the grab pipeline in queue.js: a grab (POST
// /api/queue) writes a 'grabbed' row immediately, and the simulated
// downloader's completion tick (see queue.js) writes 'imported' on success
// or 'failed' on the rare simulated failure.
// ---------------------------------------------------------------------------
const db = require('../db');
const { sendJson } = require('../lib/http');

// size_bytes is BIGINT, not INTEGER — see episodes.js's episodes table for why.
db.init(async () => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS history (
      id ${db.PK},
      series_id INTEGER,
      episode_id INTEGER,
      event_type TEXT NOT NULL,
      release_title TEXT,
      quality TEXT,
      indexer TEXT,
      size_bytes BIGINT,
      message TEXT,
      created_at TEXT NOT NULL
    )
  `);
});

// How many rows GET /api/history returns at most in one response — a
// display limit, not a storage limit. How long history is KEPT is the
// History Retention setting (Settings > General > History), enforced by
// pruneHistory() below on a timer — see server/lib/retention.js. Pruning
// used to happen on every insert (keep the newest 500 rows).
const MAX_HISTORY_ROWS = 500;

async function insertHistoryRow({ seriesId, episodeId, eventType, releaseTitle, quality, indexer, sizeBytes, message }) {
  await db.prepare(`
    INSERT INTO history (series_id, episode_id, event_type, release_title, quality, indexer, size_bytes, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(seriesId ?? null, episodeId ?? null, eventType, releaseTitle ?? null, quality ?? null, indexer ?? null, sizeBytes ?? null, message ?? null, db.now());
}

// Deletes history rows older than `days` days. 0 means keep forever.
// created_at is db.now()'s fixed-width "YYYY-MM-DD HH:MM:SS" UTC text, so a
// plain string comparison against a cutoff in the same format is a correct
// date comparison on both SQLite and Postgres. Returns rows removed.
async function pruneHistory(days) {
  if (!days) return 0;
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const result = await db.prepare('DELETE FROM history WHERE created_at < ?').run(cutoff);
  return Number(result && result.changes) || 0;
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
  const q = (url.searchParams.get('q') || '').trim();
  const seriesId = parseInt(url.searchParams.get('seriesId'), 10);
  const showFilter = Boolean(q) || Number.isInteger(seriesId);
  // Looking up one show should return every event still retained for it, not
  // just whatever happens to fall inside the newest 100 rows overall.
  const defaultLimit = showFilter ? MAX_HISTORY_ROWS : 100;
  const limit = Math.min(parseInt(url.searchParams.get('limit'), 10) || defaultLimit, MAX_HISTORY_ROWS);

  const where = [];
  const params = [];
  if (type && type !== 'all') {
    where.push('h.event_type = ?');
    params.push(type);
  }
  if (Number.isInteger(seriesId)) {
    where.push('h.series_id = ?');
    params.push(seriesId);
  } else if (q) {
    // Show-name search. Also matches the release title, so events for a
    // series that has since been deleted (its LEFT JOIN title is now null)
    // still turn up by name. LOWER() on both sides because LIKE is
    // case-insensitive on SQLite but case-sensitive on Postgres; % and _ in
    // the user's text are escaped so they match literally.
    const pattern = `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    where.push(`(LOWER(s.title) LIKE ? ESCAPE '\\' OR LOWER(h.release_title) LIKE ? ESCAPE '\\')`);
    params.push(pattern, pattern);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const rows = await db.prepare(`
    SELECT h.*, s.title AS series_title, e.season_number, e.num
    FROM history h
    LEFT JOIN series s ON s.id = h.series_id
    LEFT JOIN episodes e ON e.id = h.episode_id
    ${whereSql}
    ORDER BY h.id DESC
    LIMIT ?
  `).all(...params, limit);

  sendJson(res, 200, { history: rows.map(rowToHistoryEntry) });
  return true;
}

module.exports = { handleHistoryApi, insertHistoryRow, pruneHistory };
