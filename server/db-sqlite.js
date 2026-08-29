// ---------------------------------------------------------------------------
// SQLite adapter — the zero-config default.
//
// Built on Node's built-in `node:sqlite` (stable since Node 22.5, no npm
// dependency needed). This is the low-level driver only; server/db.js is
// what every other module actually requires (it picks this adapter or
// db-postgres.js based on DB_CLIENT and exposes the same async-shaped API
// either way).
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'kitsune.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const raw = new DatabaseSync(DB_PATH);

// WAL (write-ahead log) instead of SQLite's default rollback-journal mode —
// added after a real, confirmed corruption incident ("database disk image is
// malformed" on startup, PRAGMA integrity_check reporting freelist damage).
// The default journal mode is materially more fragile to an interrupted or
// overlapping write (a crashed process mid-write, or a filesystem that
// doesn't fully honor the POSIX advisory locks SQLite depends on for safe
// concurrent access — notably true of many virtualized/bridged/networked
// mounts) than WAL is. WAL doesn't make corruption impossible, but it's the
// standard, low-cost hardening step for exactly this failure mode, and there
// was no reason not to have it on already. See wiki/Persistence-and-Logging
// for the full incident writeup.
raw.exec('PRAGMA journal_mode = WAL;');

// All of these are synchronous under the hood (node:sqlite has no async
// API) — that's fine. server/db.js's facade always returns whatever these
// give back, sync value or not, and every call site does `await` on it, so
// the same call sites work unchanged when DB_CLIENT=postgres swaps in the
// real-async adapter below.
function execSql(sql) {
  raw.exec(sql);
}

function getSql(sql, params) {
  return raw.prepare(sql).get(...params);
}

function allSql(sql, params) {
  return raw.prepare(sql).all(...params);
}

function runSql(sql, params) {
  const result = raw.prepare(sql).run(...params);
  return { changes: result.changes };
}

// Mirrors PRAGMA table_info(table) down to just the column names, which is
// all any call site actually used it for. Table names here are always
// hardcoded internal strings, never user input, so string interpolation
// into the PRAGMA (which can't be parameterized) is no worse than it always
// was.
function tableColumns(table) {
  return raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
}

module.exports = {
  client: 'sqlite',
  DB_PATH,
  pkFragment: 'INTEGER PRIMARY KEY AUTOINCREMENT',
  execSql,
  getSql,
  allSql,
  runSql,
  tableColumns,
  close: () => raw.close(),
};
