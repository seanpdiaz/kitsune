// ---------------------------------------------------------------------------
// Logging
//
// A real structured logger backing the System > Logs page, which used to
// show a hardcoded, unchanging array — this is what makes it live. Every
// log call does two things: prints a consistent, leveled line to this
// terminal, and persists a row so the UI (GET /api/logs) can show the same
// history. How long rows are kept and which levels are kept at all are
// both Settings > General > Logging options (see server/lib/retention.js).
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

// How many rows GET /api/logs will hand back in one response — a display
// limit, not a storage limit. How long rows are actually KEPT is now the
// Log Retention setting (Settings > General > Logging), enforced by
// pruneLogs() below on a timer — see server/lib/retention.js.
const MAX_LOG_ROWS = 500;

// Hard ceiling on stored rows, applied on top of the day-based retention.
// Retention is in days, but Debug level writes one row per HTTP request
// (the Logs page alone polls every 4s), so a long retention plus Debug could
// otherwise grow the table without bound. 100k rows is weeks of Info-level
// logging and still a few tens of MB at most.
const LOG_SAFETY_CAP_ROWS = 100000;

// Ordered lowest to highest. The Log Level setting is a minimum: Info keeps
// info/warn/error and drops debug, Warn keeps warn/error, and so on.
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

// Info until server/lib/retention.js reads the saved setting at startup
// (Settings > General's Log Level has always defaulted to Info). Anything
// logged during database init — before settings can be read — uses this.
let minLevelIndex = LOG_LEVELS.indexOf('info');

// Accepts the stored Settings > General value ('Debug', 'Info', 'Warn',
// 'Error', or the old decorative 'Trace', which Kitsune never had and maps
// to Debug, its most verbose level). Returns the level actually applied.
function normalizeLogLevel(value) {
  const v = String(value || '').toLowerCase();
  if (v === 'trace') return 'debug';
  return LOG_LEVELS.includes(v) ? v : 'info';
}

function setMinLogLevel(value) {
  const level = normalizeLogLevel(value);
  minLevelIndex = LOG_LEVELS.indexOf(level);
  return level;
}

function getMinLogLevel() {
  return LOG_LEVELS[minLevelIndex];
}

// log() stays a plain, non-async-looking function on purpose:
// logDebug/logInfo/logWarn/logError are called all over the codebase
// (100+ call sites) without ever being awaited, and that shouldn't have to
// change just because persisting the row is now genuinely asynchronous
// under Postgres. So the write happens fire-and-forget below — a dropped
// or delayed log row on error isn't worth forcing every caller to become
// async for. The console line still prints immediately either way.
//
// Entries below the Log Level setting are dropped entirely — neither stored
// nor printed to the console — matching how Sonarr/Radarr's Log Level works.
function log(level, logger, message) {
  const lvl = LOG_LEVELS.includes(level) ? level : 'info';
  if (LOG_LEVELS.indexOf(lvl) < minLevelIndex) return;
  const consoleFn = lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log;
  consoleFn(`[${new Date().toISOString()}] ${lvl.toUpperCase().padEnd(5)} [${logger}] ${message}`);

  // Pruning used to happen here on every insert (keep newest 500). It's
  // now day-based and runs on a timer instead — see pruneLogs().
  // Wrapped in an async IIFE because runSql is synchronous under SQLite
  // (returns a plain object, so it has no .catch) and async under Postgres.
  (async () => {
    await db.prepare('INSERT INTO logs (timestamp, level, logger, message) VALUES (?, ?, ?, ?)')
      .run(db.now(), lvl, logger, message);
  })().catch((err) => {
    console.error(`[${new Date().toISOString()}] ERROR [Logger] Failed to persist log row: ${err.message}`);
  });
}

// Deletes log rows older than `days` days, then anything beyond
// LOG_SAFETY_CAP_ROWS. Timestamps are stored as db.now()'s fixed-width
// "YYYY-MM-DD HH:MM:SS" UTC text, so a plain string comparison against a
// cutoff in the same format is a correct date comparison on both SQLite
// and Postgres. Returns how many rows were removed.
async function pruneLogs(days) {
  const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  const byAge = await db.prepare('DELETE FROM logs WHERE timestamp < ?').run(cutoff);
  const byCap = await db.prepare('DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)')
    .run(LOG_SAFETY_CAP_ROWS);
  return (Number(byAge && byAge.changes) || 0) + (Number(byCap && byCap.changes) || 0);
}

const logDebug = (logger, message) => log('debug', logger, message);
const logInfo = (logger, message) => log('info', logger, message);
const logWarn = (logger, message) => log('warn', logger, message);
const logError = (logger, message) => log('error', logger, message);


module.exports = {
  logDebug, logInfo, logWarn, logError,
  LOG_LEVELS, MAX_LOG_ROWS,
  normalizeLogLevel, setMinLogLevel, getMinLogLevel, pruneLogs,
};
