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
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { DB_PATH } = require('../db');
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

async function handleBackupsApi(req, res, urlPath) {
  // GET /api/backups — real files currently in data/backups/, newest first.
  if (req.method === 'GET' && urlPath === '/api/backups') {
    sendJson(res, 200, listBackups());
    return true;
  }

  // POST /api/backups — "Backup Now": gzip the live database as it exists
  // at this exact moment. Synchronous (readFileSync/gzipSync/writeFileSync)
  // like every other filesystem call in this codebase (root-folders.js,
  // fs-browse.js) — fine at this app's scale, and means the response only
  // goes out once the backup file genuinely exists on disk.
  if (req.method === 'POST' && urlPath === '/api/backups') {
    try {
      const gz = zlib.gzipSync(fs.readFileSync(DB_PATH));
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
