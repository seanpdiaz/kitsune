// ---------------------------------------------------------------------------
// /api/backups — System > Backup, made real. Previously purely decorative
// (a local-only React state array — see BackupPage.jsx's old comment):
// "Backup Now" just prepended a fake row with a hardcoded size, and there
// was never a real file behind any entry to download. This backs it with
// real files instead: "Backup Now" gzips the actual live SQLite database
// (server/db.js's DB_PATH — every real table in this app: series, episodes,
// users, tags, every settings section, all of it) into data/backups/, and
// the list/download/remove actions below all operate on those real files —
// the filesystem is the source of truth, no separate DB table tracking
// metadata that could drift from what's actually on disk.
//
// Scope note: "Restore" stays a visual affordance only (see BackupPage.jsx)
// — actually restoring live data is a riskier, separate feature nobody
// asked to have built yet. Same for a real scheduled-backup job: there's no
// scheduler here, so every backup this route creates is a manual one: the
// old seed data's decorative "Scheduled" rows are gone along with the fake
// list they lived in.
//
// DB_CLIENT=postgres note: there's no single database *file* to gzip the way
// there is for SQLite (db.DB_PATH is null under postgres — see db.js). This
// shells out to the real `pg_dump` CLI instead (same tool real Postgres
// backup tooling — including Sonarr/Radarr's own docs — recommends), asking
// for a plain-SQL dump so the .gz this produces is just a real, restorable
// `psql < dump.sql`-shaped text file if it's ever unzipped, not an opaque
// binary. Requires `pg_dump` to actually be installed and on PATH wherever
// this process runs, and to be a version compatible with the target
// Postgres server (a `pg_dump` older than the server it's dumping can fail
// outright) — genuinely required for this one feature, not a general
// backend dependency the way the `pg` npm package now is.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFile } = require('child_process');
const db = require('../db');
const { logInfo, logWarn } = require('../logger');
const { sendJson } = require('../lib/http');

const BACKUPS_DIR = path.join(__dirname, '..', '..', 'data', 'backups');
if (!fs.existsSync(BACKUPS_DIR)) fs.mkdirSync(BACKUPS_DIR, { recursive: true });

// Also doubles as a path-traversal guard on every filename-taking route
// below (download/delete) — a filename that doesn't match this shape is
// rejected outright rather than ever touching the filesystem with it.
const FILENAME_RE = /^kitsune_backup_[A-Za-z0-9_-]+\.db\.gz$/;

function listBackups() {
  return fs.readdirSync(BACKUPS_DIR)
    .filter((f) => FILENAME_RE.test(f))
    .map((f) => {
      const stat = fs.statSync(path.join(BACKUPS_DIR, f));
      return { id: f, name: f, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() };
    })
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

// Real `pg_dump` invocation for DB_CLIENT=postgres — see this file's header
// comment. Credentials/connection info come from the same DB_HOST/DB_PORT/
// DB_NAME/DB_USER/DB_PASSWORD/DB_SSL vars db-postgres.js itself reads (see
// .env.example), so this always dumps whichever server the app is actually
// connected to, not a separately-configured one.
function dumpPostgres() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PGPASSWORD: process.env.DB_PASSWORD || '' };
    if (process.env.DB_SSL === 'true' && !env.PGSSLMODE) env.PGSSLMODE = 'require';
    const args = [
      '-h', process.env.DB_HOST || 'localhost',
      '-p', String(Number(process.env.DB_PORT) || 5432),
      '-U', process.env.DB_USER || 'kitsune',
      '--no-password', // fail fast instead of hanging on an interactive password prompt if PGPASSWORD is somehow wrong/missing
      '--format=plain',
      process.env.DB_NAME || 'kitsune',
    ];
    // maxBuffer well above Node's tiny 1MB default — a real library's worth
    // of series/episodes/history/logs can be several MB of plain SQL text
    // once every row is dumped; 500MB comfortably covers this app's scale
    // without risking silently truncating a genuinely large dump.
    execFile('pg_dump', args, { env, maxBuffer: 1024 * 1024 * 500, encoding: 'buffer' }, (err, stdout, stderr) => {
      if (err) {
        const detail = stderr && stderr.length ? stderr.toString('utf8').trim() : err.message;
        reject(new Error(`pg_dump failed: ${detail}`));
        return;
      }
      resolve(stdout);
    });
  });
}

// The real bytes to gzip for "Backup Now" — the live SQLite file itself
// under DB_CLIENT=sqlite (unchanged from before dual-database support), or a
// fresh pg_dump under DB_CLIENT=postgres (see dumpPostgres above), since
// there's no single file to read in that case.
async function dumpDatabase() {
  if (db.DB_CLIENT === 'postgres') return dumpPostgres();
  return fs.readFileSync(db.DB_PATH);
}

async function handleBackupsApi(req, res, urlPath) {
  // GET /api/backups — real files currently in data/backups/, newest first.
  if (req.method === 'GET' && urlPath === '/api/backups') {
    sendJson(res, 200, listBackups());
    return true;
  }

  // POST /api/backups — "Backup Now": gzip the live database as it exists
  // at this exact moment — a real SQLite file read synchronously under
  // DB_CLIENT=sqlite (like every other filesystem call in this codebase —
  // root-folders.js, fs-browse.js), or a real `pg_dump` run under
  // DB_CLIENT=postgres (see dumpDatabase/dumpPostgres above). Either way the
  // response only goes out once the backup file genuinely exists on disk.
  if (req.method === 'POST' && urlPath === '/api/backups') {
    try {
      const gz = zlib.gzipSync(await dumpDatabase());
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `kitsune_backup_${stamp}.db.gz`;
      const filePath = path.join(BACKUPS_DIR, filename);
      fs.writeFileSync(filePath, gz);
      const stat = fs.statSync(filePath);
      logInfo('Backup', `Created ${filename} (${stat.size} bytes)`);
      sendJson(res, 201, { id: filename, name: filename, sizeBytes: stat.size, createdAt: stat.mtime.toISOString() });
    } catch (err) {
      logWarn('Backup', `Backup failed: ${err.message}`);
      sendJson(res, 500, { error: `Could not create backup: ${err.message}` });
    }
    return true;
  }

  // GET /api/backups/:filename/download — streams the real gzipped file
  // back with Content-Disposition so the browser saves it instead of
  // trying to render it inline.
  const downloadMatch = req.method === 'GET' && urlPath.match(/^\/api\/backups\/([^/]+)\/download$/);
  if (downloadMatch) {
    const filename = decodeURIComponent(downloadMatch[1]);
    if (!FILENAME_RE.test(filename)) {
      sendJson(res, 400, { error: 'Invalid backup filename' });
      return true;
    }
    const filePath = path.join(BACKUPS_DIR, filename);
    if (!fs.existsSync(filePath)) {
      sendJson(res, 404, { error: 'Backup not found' });
      return true;
    }
    const content = fs.readFileSync(filePath);
    res.writeHead(200, {
      'Content-Type': 'application/gzip',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': content.length,
    });
    res.end(content);
    return true;
  }

  // DELETE /api/backups/:filename
  const deleteMatch = req.method === 'DELETE' && urlPath.match(/^\/api\/backups\/([^/]+)$/);
  if (deleteMatch) {
    const filename = decodeURIComponent(deleteMatch[1]);
    if (!FILENAME_RE.test(filename)) {
      sendJson(res, 400, { error: 'Invalid backup filename' });
      return true;
    }
    const filePath = path.join(BACKUPS_DIR, filename);
    if (!fs.existsSync(filePath)) {
      sendJson(res, 404, { error: 'Backup not found' });
      return true;
    }
    fs.unlinkSync(filePath);
    logInfo('Backup', `Removed ${filename}`);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

module.exports = { handleBackupsApi };
