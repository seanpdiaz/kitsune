// ---------------------------------------------------------------------------
// Real filesystem access helpers — folder-name matching (for Library Import
// and root folder "unmapped" counts) and free-space/unmapped-folder stats.
// Used by both routes/fs-browse.js and routes/root-folders.js, and
// normalizeFolderName is also used by routes/series.js for duplicate-title
// detection on POST /api/series.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { logWarn } = require('../logger');
// ---------------------------------------------------------------------------
// Real filesystem access — the server-side folder browser behind "Add Root
// Folder" (Settings > Media Management), plus real subfolder scanning for
// Library Import. This is genuinely reading the real disk the server
// process runs on, the same way Sonarr's own root folder browser does —
// there's no sandboxing of the path beyond resolving it to an absolute
// path first.
// ---------------------------------------------------------------------------

// A folder name like "Mob.Psycho.100.S01.1080p.BluRay" and a Library title
// like "Mob Psycho 100" should be recognized as the same show — this strips
// common release-tag noise (resolution, source, season markers, brackets,
// release year) and collapses separators, leaving just the readable title
// text. normalizeFolderName further lowercases/strips punctuation for
// matching; guessTitleFromFolderName keeps it human-readable for the
// pre-filled search box on Library Import.
function stripReleaseNoise(name) {
  return String(name)
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[._]/g, ' ')
    .replace(/\b(19|20)\d{2}\b/g, ' ')
    .replace(/\bS\d{1,2}(E\d{1,3})?\b/gi, ' ')
    .replace(/\b(1080p|720p|2160p|4k|bluray|bdrip|web[- ]?dl|hdtv|x264|x265|hevc|complete)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeFolderName(name) {
  return stripReleaseNoise(name).replace(/[^a-z0-9]+/gi, ' ').trim().toLowerCase();
}

function guessTitleFromFolderName(name) {
  return stripReleaseNoise(name) || name;
}

// Async replacement for the fs.existsSync(path) check several routes used
// to make inline — fs-browse.js/root-folders.js/import-files.js/series.js
// all validate a real, user-supplied filesystem path (a root folder, a
// series folder, a manual Path override) before acting on it, and none of
// those paths are guaranteed to be local/fast (a network share is a normal
// setup — see computeRootFolderStats' own comment below). Centralized here
// rather than each call site repeating its own try/catch around
// fs.promises.access.
async function pathExists(targetPath) {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Root folder identity marker — a small hidden file written into a root
// folder the moment it's added (see routes/root-folders.js), so later code
// can tell "this directory exists and is writable" (true even for an
// unmounted NFS/SMB mount point, which reverts to an empty *local* directory
// at the same path rather than erroring — the actual, confirmed shape of a
// real report: an import "succeeded" by hardlinking/copying a real episode
// file into a directory that merely happened to sit where the real Library
// mount used to be) apart from "this is genuinely the same mounted volume
// verified at add-time." See server/lib/root-folder-guard.js, which uses
// these two functions to gate a real import behind that check.
// ---------------------------------------------------------------------------
const ROOT_FOLDER_MARKER_FILENAME = '.kitsune-root.json';

async function writeRootFolderMarker(dirPath) {
  const id = crypto.randomUUID();
  await fs.promises.writeFile(
    path.join(dirPath, ROOT_FOLDER_MARKER_FILENAME),
    JSON.stringify({ id, createdAt: new Date().toISOString() }, null, 2)
  );
  return id;
}

// Returns the marker's id, or null if it's missing/unreadable/corrupt — any
// of which mean "can't confirm this is the same mounted volume," never
// distinguished further here (the caller only ever needs the yes/no).
async function readRootFolderMarker(dirPath) {
  try {
    const raw = await fs.promises.readFile(path.join(dirPath, ROOT_FOLDER_MARKER_FILENAME), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed.id === 'string' ? parsed.id : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Bounded-concurrency map — runs `fn` over `items` with at most `limit` in
// flight at once, preserving input order in the result array.
//
// Real, confirmed bug this fixes: a raw Promise.all fan-out over every
// subfolder in a root folder (routes/root-folders.js's Library Import scan)
// queues one full recursive filesystem walk per subfolder onto Node's
// libuv threadpool all at once — hundreds of them on a real library. That
// threadpool defaults to just 4 threads, and it's not exclusive to this
// scan: server.js's own static file handler serves every page asset
// (`fs.readFile`) through that identical pool. So while an unbounded scan
// is saturating all 4 slots, every other request that also needs real
// disk I/O — including the browser just trying to load the next page —
// queues up behind it and the whole UI looks frozen, even though the
// actual JS event loop was never blocked by synchronous code. Bounding
// concurrency here keeps one big scan from starving everything else the
// server is doing at the same time; the scan itself takes about the same
// wall-clock time either way; only how much of the threadpool it's allowed
// to occupy at once changes.
// ---------------------------------------------------------------------------
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

// Real free-space + "how much of this folder isn't in the Library yet"
// numbers for a root folder — called at add time, and again on every
// System > Status / Media Management / dashboard load that needs it. Uses
// fs.promises.statfs/readdir (available since the same Node versions as
// their Sync counterparts) rather than statfsSync/readdirSync — a root
// folder is whatever real path the user pointed Kitsune at, which can
// perfectly normally be a network share, so this shouldn't assume the
// underlying I/O is always fast enough to block the event loop for.
async function computeRootFolderStats(dirPath) {
  let free = '—';
  // Raw byte counts, alongside the already-formatted `free` string above —
  // added so callers that need to do math across more than one root folder
  // (the Library dashboard's Disk usage stat card sums `usedBytes` across
  // every configured root folder; see routes/system.js) don't have to
  // re-parse a formatted "1.2 TB" string back into a number. null when
  // statfs isn't available, same fallback case `free` already had.
  let freeBytes = null;
  let totalBytes = null;
  let usedBytes = null;
  try {
    const stats = await fs.promises.statfs(dirPath);
    freeBytes = stats.bavail * stats.bsize;
    totalBytes = stats.blocks * stats.bsize;
    usedBytes = totalBytes - freeBytes;
    free = formatBytes(freeBytes);
  } catch (err) {
    // Some platforms/filesystems don't support statfs, or the path is
    // wrong/unreadable — not fatal (free/usedBytes just stay "—"/null, see
    // callers), but silent before this: nothing distinguished "this folder
    // is fine and just uses 0 bytes" from "statfs failed and we have no
    // idea." Logged once per call (not spammy — this only runs when
    // something actually asks for root folder stats: System > Status'
    // page load, Settings > Media Management, or the dashboard's Disk
    // usage card) so a folder that's silently contributing nothing to the
    // Disk usage total shows up as a specific, explained reason instead of
    // an unexplained gap.
    logWarn('FsHelpers', `statfs failed for root folder "${dirPath}": ${err.code || err.message}`);
  }

  let unmapped = 0;
  try {
    const knownTitles = new Set((await db.prepare('SELECT title FROM series').all()).map((r) => normalizeFolderName(r.title)));
    const subfolders = (await fs.promises.readdir(dirPath, { withFileTypes: true })).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    unmapped = subfolders.filter((f) => !knownTitles.has(normalizeFolderName(f.name))).length;
  } catch {
    // leave unmapped at 0 if the folder can't be read for some reason
  }

  return { free, unmapped, freeBytes, totalBytes, usedBytes };
}

module.exports = { stripReleaseNoise, normalizeFolderName, guessTitleFromFolderName, formatBytes, computeRootFolderStats, pathExists, writeRootFolderMarker, readRootFolderMarker, ROOT_FOLDER_MARKER_FILENAME, mapWithConcurrency };
