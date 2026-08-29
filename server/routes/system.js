// ---------------------------------------------------------------------------
// /api/system/status — backs System > Status' Info and Disk Space cards,
// and the Library dashboard's Disk usage stat card.
// Everything here is real: process uptime/start time, the actual Node/OS the
// server is running on, real Library/episode counts, and live free-space
// numbers for whatever root folders are actually configured (recomputed
// fresh on every request — unlike the free-space number stored on a root
// folder at add time, see server/lib/fs-helpers.js, this is meant to be
// looked at, so it isn't cached). Disk usage (the real recursive content
// size of every root folder, not free space) is the one exception — it's
// too expensive to compute per-request, so it's read from a background-
// refreshed cache instead; see server/lib/disk-usage.js.
//
// The Health card on that same page (indexer/download-client/import-list
// warnings) stays synthetic — Settings > Indexers/Download Clients/Import
// Lists are just saved field values, not real connections (see README), so
// there's nothing real to health-check against yet. Out of scope for
// tonight; see the questions doc for whether real connection checks are
// something to build toward.
// ---------------------------------------------------------------------------
const os = require('os');
const path = require('path');
const db = require('../db');
const { sendJson } = require('../lib/http');
const { computeRootFolderStats } = require('../lib/fs-helpers');
const { getCachedDiskUsage } = require('../lib/disk-usage');

const { version } = require('../../package.json');
const PROCESS_START = Date.now();

function formatUptime(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const days = Math.floor(totalSeconds / 86400);
  const hours = Math.floor((totalSeconds % 86400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

async function handleSystemApi(req, res, urlPath) {
  if (req.method !== 'GET' || urlPath !== '/api/system/status') return false;

  const uptimeMs = Date.now() - PROCESS_START;
  const seriesCount = (await db.prepare('SELECT COUNT(*) AS n FROM series').get()).n;
  const monitoredCount = (await db.prepare('SELECT COUNT(*) AS n FROM series WHERE monitored = 1').get()).n;
  const episodeCount = (await db.prepare('SELECT COUNT(*) AS n FROM episodes').get()).n;
  const downloadedEpisodeCount = (await db.prepare('SELECT COUNT(*) AS n FROM episodes WHERE downloaded = 1').get()).n;

  const rootFolders = (await db.prepare("SELECT data FROM settings_items WHERE section = 'root-folders'").all())
    .map((row) => {
      try { return JSON.parse(row.data); } catch { return null; }
    })
    .filter(Boolean);

  // Free space per root folder — a single statfs syscall per folder, cheap
  // enough to compute live on every request (unlike Disk usage below).
  const diskSpace = await Promise.all(rootFolders.map(async (rf) => {
    const { free } = await computeRootFolderStats(rf.path);
    return { path: rf.path, free };
  }));

  // Library dashboard's Disk usage stat card (see public/index.html and
  // frontend/pages/library-grid/LibraryGridPage.jsx) — the real recursive
  // content size of every configured root
  // folder, summed. This is NOT computed here: a full directory walk is too
  // expensive to redo on every request, so it's computed on a timer in the
  // background and this just reads whatever the cache currently has — see
  // server/lib/disk-usage.js for why (and for the statfs-vs-du bug this
  // replaced: statfs measures the whole volume's usage, not the folder's
  // actual content, and was reading 42 TB against a real 2.9 TB `du -sh`).
  const { diskUsageBytes, diskUsageFormatted, diskUsageComputedAt, diskUsageComputing } = getCachedDiskUsage();

  sendJson(res, 200, {
    version,
    uptime: formatUptime(uptimeMs),
    startTime: new Date(PROCESS_START).toISOString(),
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    nodeVersion: process.version,
    // Only meaningful when there's a local SQLite file to point at — under
    // Postgres the data lives on whatever host DB_HOST names, not on this
    // filesystem, so this falls back to the app's own data/ dir (still used
    // for SSL certs and backups either way — see server/db.js's DATA_DIR).
    appDataPath: db.DB_PATH ? path.dirname(db.DB_PATH) : db.DATA_DIR,
    startupPath: path.resolve(__dirname, '..', '..'),
    seriesCount,
    monitoredCount,
    episodeCount,
    downloadedEpisodeCount,
    diskSpace,
    diskUsageBytes,
    diskUsageFormatted,
    diskUsageComputedAt,
    diskUsageComputing,
  });
  return true;
}

module.exports = { handleSystemApi };
