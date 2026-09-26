#!/usr/bin/env node
// ---------------------------------------------------------------------------
// One-time data migration: copies every row out of the local SQLite
// database (data/kitsune.db) into a real Postgres database, for moving an
// existing, already-in-use SQLite install over to DB_CLIENT=postgres
// without losing the real library/queue/history already in it.
//
// Prerequisites (see .env.example and wiki/Persistence-and-Logging.md):
//   1. A real, reachable Postgres database — DB_HOST/DB_PORT/DB_NAME/
//      DB_USER/DB_PASSWORD/DB_SSL set in .env.
//   2. DB_CLIENT=postgres also set in .env BEFORE running this — it's what
//      makes require('../server/db') below load the real Postgres adapter
//      instead of SQLite. This script refuses to run otherwise.
//   3. `npm install` already run, so the `pg` dependency is present.
//
// What it does:
//   1. Requires the exact same route/lib modules server.js does — never a
//      hand-duplicated schema — purely for their db.init(...)
//      registrations, then awaits db.ready(). That creates every table in
//      the target Postgres database using the app's own real, already-
//      tested migrations, so the copy below always has somewhere to land.
//   2. Copies every row of every real table, parents before children (see
//      TABLES below — there are no actual FOREIGN KEY constraints in this
//      schema, confirmed in routes/series.js's own comments, so this is
//      just good hygiene rather than a hard requirement).
//   3. Per table: if the Postgres side already has rows, skips it — never
//      overwrites or duplicates, so a partial run is always safe to
//      re-run. Otherwise reads every row straight out of data/kitsune.db
//      via node:sqlite and INSERTs it through the same `db` facade every
//      route already uses (so Postgres placeholder translation/type
//      handling all just work, with zero migration-specific SQL dialect
//      code).
//   4. Resets every table's SERIAL sequence to MAX(id) afterward — copying
//      explicit id values (needed to keep series_id/episode_id references
//      intact across tables) doesn't advance Postgres's own counter on its
//      own, and a real new row from the running app right after migrating
//      would otherwise collide with a copied id.
//
// Safe to re-run: already-populated destination tables are always skipped,
// never overwritten. data/kitsune.db is only ever read, never modified.
//
// Usage:  node scripts/migrate-sqlite-to-postgres.js
// ---------------------------------------------------------------------------
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { loadEnvFile } = require('../server/env');

loadEnvFile(path.join(__dirname, '..', '.env'));

if ((process.env.DB_CLIENT || '').trim().toLowerCase() !== 'postgres') {
  console.error(
    'DB_CLIENT is not set to "postgres" in .env — set it, along with DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD, before running this migration.'
  );
  process.exit(1);
}

// Registers every table's real migration — deliberately the same require
// list server.js itself uses (minus the HTTP server/schedulers themselves,
// which this script never starts), so the schema this creates can never
// drift from what a normal app startup would create.
require('../server/logger');
require('../server/routes/auth');
require('../server/routes/user-prefs');
require('../server/routes/tags');
require('../server/routes/settings-items');
require('../server/routes/download-clients');
require('../server/routes/connect');
require('../server/routes/app-settings');
require('../server/routes/fs-browse');
require('../server/routes/root-folders');
require('../server/routes/series');
require('../server/routes/episodes');
require('../server/routes/calendar');
require('../server/routes/tvdb-search');
require('../server/routes/mal-search');
require('../server/routes/logs');
require('../server/routes/queue');
require('../server/routes/history');
require('../server/routes/blocklist');
require('../server/routes/releases');
require('../server/routes/wanted');
require('../server/routes/system');
require('../server/routes/system-tasks');
require('../server/routes/system-updates');
require('../server/routes/import-files');
require('../server/routes/backups');
require('../server/routes/ssl');
require('../server/routes/indexers');
require('../server/lib/disk-usage');
require('../server/lib/permissions');
require('../server/lib/refresh-series-task');
require('../server/lib/update-check');

const db = require('../server/db');

// Parents before children — not required (no real FOREIGN KEY constraints
// exist in this schema), just tidy. Every real table in the app.
const TABLES = [
  'users', 'sessions',
  'tags', 'series', 'series_tags', 'episodes',
  'settings_items', 'app_settings', 'user_prefs',
  'queue', 'history', 'blocklist', 'logs',
];

async function migrateTable(sqliteDb, table) {
  const cols = sqliteDb.prepare(`PRAGMA table_info("${table}")`).all().map((c) => c.name);
  const rows = sqliteDb.prepare(`SELECT * FROM "${table}"`).all();
  if (rows.length === 0) {
    console.log(`  ${table}: nothing to copy (source is empty)`);
    return;
  }

  const destCount = Number((await db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get()).c);
  if (destCount === rows.length) {
    console.log(`  ${table}: Postgres already has all ${destCount} row(s) — skipping`);
    return;
  }
  if (destCount > 0) {
    // A previous run got partway through this table (e.g. this exact
    // script hit the BIGINT-vs-INTEGER size_bytes bug mid-copy) — rather
    // than trying to figure out which specific rows already made it over,
    // just clear this one table and redo it from scratch. Cheap: every
    // table here is small, and TABLES lists parents before children so
    // there's nothing else that could still be referencing rows this
    // deletes.
    console.log(`  ${table}: Postgres has ${destCount}/${rows.length} row(s) from an earlier partial run — clearing and redoing`);
    await db.exec(`DELETE FROM ${table}`);
  }

  const insertSql = `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  const stmt = db.prepare(insertSql);
  for (const row of rows) {
    await stmt.run(...cols.map((c) => row[c]));
  }
  console.log(`  ${table}: copied ${rows.length} row(s)`);

  if (cols.includes('id')) {
    await db.exec(
      `SELECT setval(pg_get_serial_sequence('${table}', 'id'), COALESCE((SELECT MAX(id) FROM ${table}), 1))`
    );
  }
}

(async () => {
  console.log(`Creating schema on ${db.describe()} (via the app's own real migrations)...`);
  await db.ready();

  const sqlitePath = path.join(__dirname, '..', 'data', 'kitsune.db');
  const sqliteDb = new DatabaseSync(sqlitePath, { readOnly: true });
  console.log(`Copying data from ${sqlitePath}...`);

  for (const table of TABLES) {
    await migrateTable(sqliteDb, table);
  }

  sqliteDb.close();
  await db.close();
  console.log('\nDone. Leave DB_CLIENT=postgres set in .env and start the app normally to verify.');
  process.exit(0);
})().catch((err) => {
  console.error('Migration failed:', err);
  process.exit(1);
});
