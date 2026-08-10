// ---------------------------------------------------------------------------
// /api/queue — grabbing a release and simulating it downloading to
// completion. This is the core of tonight's build: previously Activity >
// Queue was a five-row hardcoded array that never changed (see README), and
// there was no path anywhere in the app from "here's a missing episode" to
// "it's downloaded" — Wanted's Search buttons were a 700ms fake spinner with
// no results.
//
// No real indexer or download client is involved (see server/lib/queue-sim.js
// for why) — a grab creates a real `queue` row, and a background interval in
// this module ticks its progress the same way a real download client's
// status poll would, until it completes (moves to `history` as 'imported'
// and flips the episode's real `downloaded` flag) or, rarely, fails (moves
// to `history` as 'failed' and lands in `blocklist`) — the same two outcomes
// a real Sonarr grab has, just simulated instead of driven by an actual
// transfer.
// ---------------------------------------------------------------------------
const { db } = require('../db');
const { logInfo, logWarn } = require('../logger');
const { sendJson, readJsonBody } = require('../lib/http');
const { generateReleases } = require('../lib/queue-sim');
const { recomputeSeriesEpisodeStats } = require('../lib/series-stats');
const { buildEpisodeFilePath } = require('../lib/episode-paths');
const { insertHistoryRow } = require('./history');
const { insertBlocklistRow } = require('./blocklist');
const { notifyConnections } = require('../lib/notify');

db.exec(`
  CREATE TABLE IF NOT EXISTS queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER NOT NULL,
    episode_id INTEGER NOT NULL,
    release_title TEXT NOT NULL,
    quality TEXT,
    size_bytes INTEGER,
    indexer TEXT,
    protocol TEXT,
    status TEXT NOT NULL DEFAULT 'downloading',
    progress_pct INTEGER NOT NULL DEFAULT 0,
    added_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

function rowToQueueEntry(row) {
  return {
    id: row.id,
    seriesId: row.series_id,
    seriesTitle: row.series_title,
    episodeId: row.episode_id,
    episodeLabel: `S${String(row.season_number).padStart(2, '0')}E${String(row.num).padStart(2, '0')}`,
    episodeTitle: row.episode_title,
    releaseTitle: row.release_title,
    quality: row.quality,
    sizeBytes: row.size_bytes,
    indexer: row.indexer,
    protocol: row.protocol,
    status: row.status,
    progressPct: row.progress_pct,
    addedAt: row.added_at,
  };
}

const QUEUE_SELECT = `
  SELECT q.*, s.title AS series_title, e.season_number, e.num, e.title AS episode_title
  FROM queue q
  JOIN series s ON s.id = q.series_id
  JOIN episodes e ON e.id = q.episode_id
`;

async function handleQueueApi(req, res, urlPath) {
  if (req.method === 'GET' && urlPath === '/api/queue') {
    const rows = db.prepare(`${QUEUE_SELECT} ORDER BY q.id ASC`).all();
    sendJson(res, 200, { queue: rows.map(rowToQueueEntry) });
    return true;
  }

  // POST /api/queue — grab a release. Body: { episodeId, releaseIndex }.
  // releaseIndex is an index into the same deterministic candidate list
  // GET /api/releases?episodeId=N returns (see queue-sim.js) — regenerated
  // here rather than trusting a client-supplied title/quality/size, so the
  // grabbed release always matches something the search actually offered.
  if (req.method === 'POST' && urlPath === '/api/queue') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const episodeId = Number(body.episodeId);
    const releaseIndex = Number(body.releaseIndex);
    if (!Number.isInteger(episodeId) || !Number.isInteger(releaseIndex)) {
      sendJson(res, 400, { error: 'episodeId and releaseIndex are required' });
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

    const alreadyQueued = db.prepare('SELECT id FROM queue WHERE episode_id = ?').get(episodeId);
    if (alreadyQueued) {
      sendJson(res, 409, { error: 'This episode is already in the queue' });
      return true;
    }

    const releases = generateReleases(series, { id: episode.id, num: episode.num, seasonNumber: episode.season_number });
    const release = releases[releaseIndex];
    if (!release) {
      sendJson(res, 400, { error: 'Unknown release — search again and grab from the current results' });
      return true;
    }

    // ~10% of grabs start with a client-side warning instead of downloading
    // right away — mirrors real Sonarr queue rows that sit in "Warning"
    // (release no longer available, download client unreachable, etc.)
    // until someone intervenes, rather than every grab sailing through.
    const startsWithWarning = Math.random() < 0.10;
    const status = startsWithWarning ? 'warning' : 'downloading';

    const { lastInsertRowid } = db.prepare(`
      INSERT INTO queue (series_id, episode_id, release_title, quality, size_bytes, indexer, protocol, status, progress_pct)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(series.id, episode.id, release.title, release.quality, release.sizeBytes, release.indexer, release.protocol, status);

    insertHistoryRow({
      seriesId: series.id, episodeId: episode.id, eventType: 'grabbed',
      releaseTitle: release.title, quality: release.quality, indexer: release.indexer, sizeBytes: release.sizeBytes,
      message: startsWithWarning ? 'Grabbed, but the download client reported a problem' : null,
    });
    const episodeLabel = `S${String(episode.season_number).padStart(2, '0')}E${String(episode.num).padStart(2, '0')}`;
    logInfo('Queue', `Grabbed "${release.title}" for ${series.title} (${episodeLabel})`);
    notifyConnections('grab', `${series.title} ${episodeLabel} — ${release.title} (${release.quality})`);

    const created = db.prepare(`${QUEUE_SELECT} WHERE q.id = ?`).get(lastInsertRowid);
    sendJson(res, 201, rowToQueueEntry(created));
    return true;
  }

  // PATCH /api/queue/:id — pause or resume. Only meaningful between
  // 'downloading' and 'paused'; a 'warning' row needs removing/retrying
  // instead (matching real Sonarr, which doesn't let you "pause" a queue
  // item that isn't actually transferring).
  const patchMatch = req.method === 'PATCH' && urlPath.match(/^\/api\/queue\/(\d+)$/);
  if (patchMatch) {
    const id = Number(patchMatch[1]);
    const row = db.prepare('SELECT * FROM queue WHERE id = ?').get(id);
    if (!row) {
      sendJson(res, 404, { error: 'Queue item not found' });
      return true;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const nextStatus = body.status === 'paused' ? 'paused' : body.status === 'downloading' ? 'downloading' : null;
    if (!nextStatus || (row.status !== 'downloading' && row.status !== 'paused')) {
      sendJson(res, 400, { error: 'Can only pause/resume a downloading or paused item' });
      return true;
    }
    db.prepare('UPDATE queue SET status = ? WHERE id = ?').run(nextStatus, id);
    const updated = db.prepare(`${QUEUE_SELECT} WHERE q.id = ?`).get(id);
    sendJson(res, 200, rowToQueueEntry(updated));
    return true;
  }

  // DELETE /api/queue/:id — cancel/remove. No history entry: removing a
  // still-in-progress grab isn't a completed or failed download, it's just
  // "never mind" — same as real Sonarr's plain "Remove" (as opposed to
  // "Remove and blocklist", which this doesn't distinguish for simplicity).
  const delMatch = req.method === 'DELETE' && urlPath.match(/^\/api\/queue\/(\d+)$/);
  if (delMatch) {
    const id = Number(delMatch[1]);
    const row = db.prepare('SELECT * FROM queue WHERE id = ?').get(id);
    if (!row) {
      sendJson(res, 404, { error: 'Queue item not found' });
      return true;
    }
    db.prepare('DELETE FROM queue WHERE id = ?').run(id);
    logInfo('Queue', `Removed from queue: ${row.release_title}`);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// The simulated downloader. Ticks every downloading row's progress forward;
// on reaching 100% it resolves to either a success (the common case) or a
// simulated failure (rare), exactly like a real download client's status
// would eventually resolve one way or the other. Runs on an interval rather
// than per-request so progress moves even if nobody's looking at the Queue
// page — matching how a real download runs in the background regardless of
// whether Sonarr's UI happens to be open.
// ---------------------------------------------------------------------------
const TICK_MS = 1500;
const FAILURE_RATE = 0.08;

function tick() {
  const downloading = db.prepare('SELECT * FROM queue WHERE status = ?').all('downloading');
  for (const row of downloading) {
    const nextPct = Math.min(100, row.progress_pct + 8 + Math.floor(Math.random() * 15));
    if (nextPct < 100) {
      db.prepare('UPDATE queue SET progress_pct = ? WHERE id = ?').run(nextPct, row.id);
      continue;
    }
    completeDownload(row);
  }
}

function completeDownload(row) {
  db.prepare('DELETE FROM queue WHERE id = ?').run(row.id);

  // Fetched once up front (used by both the failure and success branches
  // below, and by notifyConnections' message either way) rather than
  // duplicated in each.
  const series = db.prepare('SELECT title, path FROM series WHERE id = ?').get(row.series_id);
  const episode = db.prepare('SELECT season_number, num, title FROM episodes WHERE id = ?').get(row.episode_id);
  const episodeLabel = episode ? `S${String(episode.season_number).padStart(2, '0')}E${String(episode.num).padStart(2, '0')}` : '';
  const seriesTitle = series ? series.title : 'Unknown series';

  if (Math.random() < FAILURE_RATE) {
    insertHistoryRow({
      seriesId: row.series_id, episodeId: row.episode_id, eventType: 'failed',
      releaseTitle: row.release_title, quality: row.quality, indexer: row.indexer, sizeBytes: row.size_bytes,
      message: 'Download failed — file was incomplete or corrupt',
    });
    insertBlocklistRow({
      seriesId: row.series_id, episodeId: row.episode_id, releaseTitle: row.release_title,
      reason: 'Failed download', indexer: row.indexer,
    });
    logWarn('Queue', `Simulated failure: "${row.release_title}" — blocklisted`);
    notifyConnections('fail', `${seriesTitle} ${episodeLabel} — ${row.release_title} failed (incomplete or corrupt)`);
    return;
  }

  // Nothing real was ever downloaded here (see the module comment above) —
  // buildEpisodeFilePath fabricates a plausible on-disk path so the episode
  // details modal (see public/js/lib/episode-details-modal.js) has
  // *something* to show instead of a blank field, the same way `quality`/
  // `size_bytes` were already fabricated by generateReleases before this.
  const filePath = series && episode ? buildEpisodeFilePath(series, episode, row.quality) : null;

  db.prepare('UPDATE episodes SET downloaded = 1, quality = ?, size_bytes = ?, path = ? WHERE id = ?')
    .run(row.quality, row.size_bytes, filePath, row.episode_id);
  recomputeSeriesEpisodeStats(row.series_id);
  insertHistoryRow({
    seriesId: row.series_id, episodeId: row.episode_id, eventType: 'imported',
    releaseTitle: row.release_title, quality: row.quality, indexer: row.indexer, sizeBytes: row.size_bytes,
  });
  logInfo('Queue', `Imported "${row.release_title}"`);
  notifyConnections('import', `${seriesTitle} ${episodeLabel} — ${row.release_title} (${row.quality})`);
}

setInterval(tick, TICK_MS);

module.exports = { handleQueueApi };
