// ---------------------------------------------------------------------------
// SQLite connection
//
// Built on Node's built-in `node:sqlite` (stable since Node 22.5, no npm
// dependency needed) so the app stays true to the "zero dependencies" goal
// while still being backed by real SQL. Every other module in server/
// requires this one to get the shared `db` handle — there's exactly one
// connection for the whole process, matching how the original single-file
// server.js worked.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'kitsune.db');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

module.exports = { db, DB_PATH };
