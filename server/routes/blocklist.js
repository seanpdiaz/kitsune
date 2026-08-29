// ---------------------------------------------------------------------------
// /api/blocklist — releases that failed or were manually blocklisted.
// Replaces Activity > Blocklist's old three-row hardcoded array (see README)
// with real rows: the simulated downloader in queue.js writes one whenever a
// simulated grab "fails" (see queue.js's completion tick), and this also
// exposes a manual DELETE (un-blocklist) since that was the one interactive
// piece the old mock page already had.
// ---------------------------------------------------------------------------
const db = require('../db');
const { logInfo } = require('../logger');
const { sendJson } = require('../lib/http');

db.init(async () => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS blocklist (
      id ${db.PK},
      series_id INTEGER,
      episode_id INTEGER,
      release_title TEXT NOT NULL,
      reason TEXT,
      indexer TEXT,
      created_at TEXT NOT NULL
    )
  `);
});

async function insertBlocklistRow({ seriesId, episodeId, releaseTitle, reason, indexer }) {
  await db.prepare(`
    INSERT INTO blocklist (series_id, episode_id, release_title, reason, indexer, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(seriesId ?? null, episodeId ?? null, releaseTitle, reason ?? null, indexer ?? null, db.now());
}

function rowToBlocklistEntry(row) {
  return {
    id: row.id,
    seriesId: row.series_id,
    seriesTitle: row.series_title || null,
    episodeId: row.episode_id,
    episodeLabel: row.season_number != null && row.num != null
      ? `S${String(row.season_number).padStart(2, '0')}E${String(row.num).padStart(2, '0')}`
      : null,
    releaseTitle: row.release_title,
    reason: row.reason,
    indexer: row.indexer,
    createdAt: row.created_at,
  };
}

async function handleBlocklistApi(req, res, urlPath) {
  if (req.method === 'GET' && urlPath === '/api/blocklist') {
    const rows = await db.prepare(`
      SELECT b.*, s.title AS series_title, e.season_number, e.num
      FROM blocklist b
      LEFT JOIN series s ON s.id = b.series_id
      LEFT JOIN episodes e ON e.id = b.episode_id
      ORDER BY b.id DESC
    `).all();
    sendJson(res, 200, { blocklist: rows.map(rowToBlocklistEntry) });
    return true;
  }

  const delMatch = req.method === 'DELETE' && urlPath.match(/^\/api\/blocklist\/(\d+)$/);
  if (delMatch) {
    const id = Number(delMatch[1]);
    const row = await db.prepare('SELECT * FROM blocklist WHERE id = ?').get(id);
    if (!row) {
      sendJson(res, 404, { error: 'Blocklist entry not found' });
      return true;
    }
    await db.prepare('DELETE FROM blocklist WHERE id = ?').run(id);
    logInfo('Blocklist', `Removed from blocklist: ${row.release_title}`);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

module.exports = { handleBlocklistApi, insertBlocklistRow };
