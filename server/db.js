// ---------------------------------------------------------------------------
// Database facade
//
// Every other module in server/ requires this file, never db-sqlite.js or
// db-postgres.js directly. Which one actually backs it is picked once, at
// process start, from DB_CLIENT in .env (see .env.example) — "sqlite"
// (the default, zero-config) or "postgres". Everything downstream of this
// file — every db.prepare(sql).get/all/run() and db.exec() call across
// server/routes and server/lib — is written once and works against either.
//
// How that works, mechanically:
//   - SQL is written with `?` positional placeholders everywhere (SQLite's
//     native style). When postgres is active, translatePlaceholders() below
//     rewrites them to $1, $2, ... before the query ever reaches `pg`.
//   - db.prepare(sql).get/all/run() always return a value you `await` —
//     for SQLite that's a plain value (node:sqlite has no async API, so
//     `await` on it just resolves immediately), for Postgres a real
//     Promise. Every call site does `await`, so it doesn't matter which.
//   - Schema DDL that differs between dialects (just two things in this
//     whole codebase: the auto-increment primary key, and PRAGMA
//     table_info-style column introspection) goes through db.PK and
//     db.tableColumns() instead of being hand-written per file.
//   - db.now() replaces SQLite's `datetime('now')` — both dialects get the
//     same JS-computed UTC string ("2026-08-29 01:23:45") instead of a
//     database-side function, so stored timestamps are byte-identical
//     regardless of which database wrote them.
//   - Schema setup and migrations, which used to run synchronously at
//     require() time (before server.listen() was ever reached — see
//     wiki/Persistence-and-Logging), now register themselves with
//     db.init(fn) instead of running inline. server.js awaits db.ready()
//     (which runs every registered fn) before it starts listening, which
//     preserves the exact same guarantee — every table exists before the
//     first request can arrive — for an adapter where "create the tables"
//     is genuinely asynchronous.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');

const DB_CLIENT = (process.env.DB_CLIENT || 'sqlite').trim().toLowerCase();
if (DB_CLIENT !== 'sqlite' && DB_CLIENT !== 'postgres') {
  throw new Error(`Unknown DB_CLIENT "${process.env.DB_CLIENT}" — expected "sqlite" or "postgres". See .env.example.`);
}

// APP_ENV gates whether an empty database gets the mockup's original
// placeholder data (demo series, demo tags, demo indexers/connections/
// quality profiles — see the db.init() blocks in series.js/tags.js/
// settings-items.js) seeded into it automatically. Defaults to "production"
// — a genuinely empty database on first run stays empty — so a real install
// never has demo anime silently repopulate its library just because the
// table happened to be empty (which is exactly what used to happen: this
// var was documented in .env.example for a while but nothing ever actually
// read it). Set APP_ENV=demo to get the old zero-config "there's already
// something to click through" behavior back — that's still what a from-
// scratch clone of this repo wants by default when trying it out.
const APP_ENV = (process.env.APP_ENV || 'production').trim().toLowerCase();
if (APP_ENV !== 'production' && APP_ENV !== 'demo') {
  throw new Error(`Unknown APP_ENV "${process.env.APP_ENV}" — expected "production" or "demo". See .env.example.`);
}
const SEED_DEMO_DATA = APP_ENV === 'demo';

const impl = DB_CLIENT === 'postgres' ? require('./db-postgres') : require('./db-sqlite');

// Local data directory — used for SQL certs (data/ssl) and backup output
// (data/backups) regardless of which DB_CLIENT is active, and for the
// SQLite file itself when DB_CLIENT=sqlite. Kept here (not inside
// db-sqlite.js) since it isn't actually SQLite-specific.
const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// Only meaningful for SQLite (null under postgres) — server/routes/system.js
// and server/routes/backups.js both branch on this being null to know
// whether there's a local database file to report/back up at all.
const DB_PATH = impl.DB_PATH;

// Human-readable string for log lines that used to interpolate DB_PATH
// directly (e.g. "Seeded 21 default series into <path>") — meaningful for
// both dialects instead of printing `null` under postgres.
function describe() {
  if (DB_CLIENT === 'postgres') {
    return `postgres://${process.env.DB_HOST || 'localhost'}:${Number(process.env.DB_PORT) || 5432}/${process.env.DB_NAME || 'kitsune'}`;
  }
  return DB_PATH;
}

// SQLite datetime('now') replacement — see file header. UTC, no
// milliseconds, space instead of "T": "2026-08-29 01:23:45". Matches the
// exact format SQLite's datetime('now') already produced, since existing
// consumers (e.g. server/routes/logs.js's rowToLog) parse that format with
// plain string slicing, not a real date parser.
function now() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

// Translates `?` positional placeholders to Postgres's `$1, $2, ...`,
// skipping anything inside a single- or double-quoted string literal so a
// literal "?" in data never gets mistaken for a placeholder. No-op for
// SQLite, which takes `?` natively.
function translatePlaceholders(sql) {
  if (DB_CLIENT !== 'postgres') return sql;
  let out = '';
  let quote = null;
  let n = 0;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quote) {
      out += ch;
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '?') {
      n += 1;
      out += `$${n}`;
      continue;
    }
    out += ch;
  }
  return out;
}

function prepare(sql) {
  const translated = translatePlaceholders(sql);
  return {
    get: (...params) => impl.getSql(translated, params),
    all: (...params) => impl.allSql(translated, params),
    run: (...params) => impl.runSql(translated, params),
  };
}

function exec(sql) {
  // Not placeholder-translated — every db.exec() call site is DDL/migration
  // text with no `?` in it (schema definitions and ALTER TABLE statements),
  // so there's nothing to translate.
  return impl.execSql(sql);
}

function tableColumns(table) {
  return impl.tableColumns(table);
}

// ---------------------------------------------------------------------------
// Init registry
//
// Route/lib modules that used to create their tables as a side effect of
// require() (synchronously, order-independent — see wiki/Persistence-and-
// Logging) now wrap that same code in db.init(async () => { ... }) instead
// of running it inline. server.js calls db.ready() once, before
// server.listen(), which runs every registered fn (order still doesn't
// matter — nothing here depends on another module's table already
// existing) and resolves once they're all done.
// ---------------------------------------------------------------------------
const pending = [];
function init(fn) {
  pending.push(fn);
}

let readyPromise = null;
function ready() {
  if (!readyPromise) {
    readyPromise = (async () => {
      for (const fn of pending) {
        await fn();
      }
    })();
  }
  return readyPromise;
}

module.exports = {
  DB_CLIENT,
  APP_ENV,
  SEED_DEMO_DATA,
  DB_PATH,
  DATA_DIR,
  describe,
  now,
  PK: impl.pkFragment,
  prepare,
  exec,
  tableColumns,
  init,
  ready,
  close: () => impl.close(),
};
