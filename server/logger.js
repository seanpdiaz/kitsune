// ---------------------------------------------------------------------------
// Logging
//
// A real structured logger backing the System > Logs page, which used to
// show a hardcoded, unchanging array — this is what makes it live. Every
// log call does two things: prints a consistent, leveled line to this
// terminal, and persists a row so the UI (GET /api/logs) can show the same
// history. Kept to the last MAX_LOG_ROWS entries so this can't grow forever
// on a long-running server.
//
// This table is created before anything else in the file logs, since seed
// steps below (tags, settings, series) log through this too.
// ---------------------------------------------------------------------------
const { db } = require("./db");

db.exec(`
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    level TEXT NOT NULL,
    logger TEXT NOT NULL,
    message TEXT NOT NULL
  )
`);

const MAX_LOG_ROWS = 500;
const insertLog = db.prepare('INSERT INTO logs (level, logger, message) VALUES (?, ?, ?)');
// SQLite has no built-in "keep only the newest N rows" — delete anything
// outside the newest MAX_LOG_ROWS ids after every insert. Cheap at this
// scale (a personal dev tool, not a high-traffic service), so doing it on
// every write is simpler than batching and still keeps the table bounded.
const pruneLogs = db.prepare(`
  DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)
`);

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

function log(level, logger, message) {
  const lvl = LOG_LEVELS.includes(level) ? level : 'info';
  insertLog.run(lvl, logger, message);
  pruneLogs.run(MAX_LOG_ROWS);
  const consoleFn = lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log;
  consoleFn(`[${new Date().toISOString()}] ${lvl.toUpperCase().padEnd(5)} [${logger}] ${message}`);
}

const logDebug = (logger, message) => log('debug', logger, message);
const logInfo = (logger, message) => log('info', logger, message);
const logWarn = (logger, message) => log('warn', logger, message);
const logError = (logger, message) => log('error', logger, message);


module.exports = { logDebug, logInfo, logWarn, logError, LOG_LEVELS, MAX_LOG_ROWS };
