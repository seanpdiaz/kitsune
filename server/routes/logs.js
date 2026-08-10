const { db } = require('../db');
const { LOG_LEVELS, MAX_LOG_ROWS } = require('../logger');
const { sendJson } = require('../lib/http');

// ---------------------------------------------------------------------------
// /api/logs — backs the System > Logs page (see the Logging section above,
// near the top of the file, for how entries get written).
// ---------------------------------------------------------------------------

function rowToLog(row) {
  // "Time" only (no date) to match the existing Logs page column, which is
  // labeled just "Time" — this is a single-machine dev tool, not something
  // expected to run continuously across days where the date would matter.
  // The stored value is a full SQLite datetime('now') UTC string like
  // "2026-08-04 01:19:05"; splitting on the space and taking the time part
  // avoids pulling in any date-parsing/timezone-conversion machinery for it.
  const time = (row.timestamp.split(' ')[1] || row.timestamp).slice(0, 8);
  return {
    id: row.id,
    time,
    level: row.level.charAt(0).toUpperCase() + row.level.slice(1), // debug -> Debug, matching the UI's labels
    logger: row.logger,
    message: row.message,
  };
}

async function handleLogsApi(req, res, urlPath) {
  if (req.method !== 'GET' || urlPath !== '/api/logs') return false;

  const params = new URL(req.url, 'http://localhost').searchParams;
  const level = (params.get('level') || 'all').toLowerCase();
  const limit = Math.min(Number(params.get('limit')) || 200, MAX_LOG_ROWS);

  let rows;
  if (level !== 'all' && LOG_LEVELS.includes(level)) {
    rows = db.prepare('SELECT * FROM logs WHERE level = ? ORDER BY id DESC LIMIT ?').all(level, limit);
  } else {
    rows = db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit);
  }
  sendJson(res, 200, rows.map(rowToLog));
  return true;
}

module.exports = { handleLogsApi };
