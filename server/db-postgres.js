// ---------------------------------------------------------------------------
// PostgreSQL adapter — opt-in via DB_CLIENT=postgres in .env.
//
// The one real npm dependency this project takes on ("pg"), since Node has
// no built-in Postgres driver the way it does for SQLite. Only loaded when
// DB_CLIENT actually selects postgres (see server/db.js), so a default
// SQLite install never even requires this module.
// ---------------------------------------------------------------------------
const { Pool, types } = require('pg');

// pg returns BIGINT/NUMERIC columns as strings by default, to avoid silently
// losing precision on values bigger than Number.MAX_SAFE_INTEGER. Nothing in
// this app's schema deals in numbers anywhere near that size — COUNT(*)/SUM()
// results (OID 20 = int8) just need to compare equal to plain JS numbers the
// way node:sqlite's driver already returns them (e.g. `seriesCount === 0`
// gating the seed-data insert in routes/series.js) — so these are parsed back
// into regular numbers here, once, for every query, rather than wrapping
// every COUNT(*)/SUM() call site in Number(...) by hand.
types.setTypeParser(20, (val) => parseInt(val, 10)); // int8/bigint
types.setTypeParser(1700, (val) => parseFloat(val)); // numeric/decimal

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME || 'kitsune',
  user: process.env.DB_USER || 'kitsune',
  password: process.env.DB_PASSWORD || '',
  // DB_SSL=true is meant for a managed/remote Postgres (RDS, etc.) reached
  // over a connection whose certificate chain this process doesn't have —
  // rejectUnauthorized: false trusts the connection without verifying that
  // chain, the common pragmatic default for that case. Leave DB_SSL unset
  // for a local/LAN Postgres container, which is the expected common case
  // for a self-hosted app like this one.
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  // A background/idle client dying (dropped connection, DB restart) throws
  // here asynchronously, outside any request — without this handler that's
  // an unhandled 'error' event, which crashes the whole process in Node.
  // eslint-disable-next-line no-console
  console.error('[Postgres] idle client error:', err.message);
});

async function execSql(sql) {
  // Deliberately NOT passing a params array here (not even an empty one) —
  // pg only allows multiple semicolon-separated statements in one call
  // under the simple query protocol, which is what not passing `values`
  // selects. Every db.exec() call site is either schema DDL or a
  // hand-written multi-statement migration, never anything with
  // placeholders, so this is safe.
  await pool.query(sql);
}

async function getSql(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows[0];
}

async function allSql(sql, params) {
  const { rows } = await pool.query(sql, params);
  return rows;
}

async function runSql(sql, params) {
  const result = await pool.query(sql, params);
  return { changes: result.rowCount };
}

// Mirrors db-sqlite.js's tableColumns() — same shape (array of column name
// strings) so call sites don't need to know which adapter is active.
async function tableColumns(table) {
  const { rows } = await pool.query(
    'SELECT column_name FROM information_schema.columns WHERE table_name = $1',
    [table]
  );
  return rows.map((r) => r.column_name);
}

module.exports = {
  client: 'postgres',
  DB_PATH: null,
  pkFragment: 'SERIAL PRIMARY KEY',
  execSql,
  getSql,
  allSql,
  runSql,
  tableColumns,
  close: () => pool.end(),
};
