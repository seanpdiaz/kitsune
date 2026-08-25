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

// WAL (write-ahead log) instead of SQLite's default rollback-journal mode —
// added after a real, confirmed corruption incident ("database disk image is
// malformed" on startup, PRAGMA integrity_check reporting freelist damage).
// The default journal mode is materially more fragile to an interrupted or
// overlapping write (a crashed process mid-write, or a filesystem that
// doesn't fully honor the POSIX advisory locks SQLite depends on for safe
// concurrent access — notably true of many virtualized/bridged/networked
// mounts) than WAL is. WAL doesn't make corruption impossible, but it's the
// standard, low-cost hardening step for exactly this failure mode, and there
// was no reason not to have it on already. Recovered data that time by
// reading every table straight out of the damaged file (the corruption was
// confined to freelist bookkeeping, not the live table data — every row was
// still readable) and rewriting it into a fresh database; the original
// corrupted file was preserved alongside it, not deleted, as
// data/kitsune.db.corrupted-<timestamp>.
db.exec('PRAGMA journal_mode = WAL;');

// ---------------------------------------------------------------------------
// Demo data seeding toggle
//
// series.js/tags.js/settings-items.js each seed a small set of fake default
// rows (demo anime, demo tags, demo indexers/connections/quality profiles)
// into their own table the first time it's empty — see each file's own
// "Seeded ..." log line. That's the right default for this repo's actual
// purpose (README/package.json both call it a "click-through visual
// mockup") and for a fresh local dev copy: there's something to click
// through immediately instead of a blank Library. It's the wrong default
// the moment this gets deployed somewhere as a real instance, though —
// SEED_DEMO_DATA=false in .env (or the real environment) skips all three,
// so a freshly deployed, freshly emptied database starts genuinely empty
// instead of with 18 anime nobody added. Defaults to seeding (true) so
// every existing local/demo setup that's never heard of this var keeps
// behaving exactly as it always has; only an explicit "false"/"0"/"no"
// opts out, so a typo like SEED_DEMO_DATA=flase fails safe (still seeds)
// rather than silently doing the opposite of what someone typed.
const SEED_DEMO_DATA = !['false', '0', 'no'].includes(
  String(process.env.SEED_DEMO_DATA ?? 'true').trim().toLowerCase()
);

module.exports = { db, DB_PATH, SEED_DEMO_DATA };
