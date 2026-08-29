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
const db = require("./db");

db.init(async () => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id ${db.PK},
      timestamp TEXT NOT NULL,
      level TEXT NOT NULL,
      logger TEXT NOT NULL,
      message TEXT NOT NULL
    )
  `);
});

const MAX_LOG_ROWS = 500;
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

// log() stays a plain, non-async-looking function on purpose:
// logDebug/logInfo/logWarn/logError are called all over the codebase
// (100+ call sites) without ever being awaited, and that shouldn't have to
// change just because persisting the row is now genuinely asynchronous
// under Postgres. So the write happens fire-and-forget below — a dropped
// or delayed log row on error isn't worth forcing every caller to become
// async for. The console line still prints immediately either way.
function log(level, logger, message) {
  const lvl = LOG_LEVELS.includes(level) ? level : 'info';
  const consoleFn = lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log;
  consoleFn(`[${new Date().toISOString()}] ${lvl.toUpperCase().padEnd(5)} [${logger}] ${message}`);

  (async () => {
    await db.prepare('INSERT INTO logs (timestamp, level, logger, message) VALUES (?, ?, ?, ?)')
      .run(db.now(), lvl, logger, message);
    // SQLite/Postgres both lack a built-in "keep only the newest N rows" —
    // delete anything outside the newest MAX_LOG_ROWS ids after every
    // insert. Cheap at this scale (a personal dev tool, not a high-traffic
    // service), so doing it on every write is simpler than batching and
    // still keeps the table bounded.
    await db.prepare('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)')
      .run(MAX_LOG_ROWS);
  })().catch((err) => {
    console.error(`[${new Date().toISOString()}] ERROR [Logger] Failed to persist log row: ${err.message}`);
  });
}

const logDebug = (logger, message) => log('debug', logger, message);
const logInfo = (logger, message) => log('info', logger, message);
const logWarn = (logger, message) => log('warn', logger, message);
const logError = (logger, message) => log('error', logger, message);


module.exports = { logDebug, logInfo, logWarn, logError, LOG_LEVELS, MAX_LOG_ROWS };
