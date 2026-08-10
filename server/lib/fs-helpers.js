// ---------------------------------------------------------------------------
// Real filesystem access helpers — folder-name matching (for Library Import
// and root folder "unmapped" counts) and free-space/unmapped-folder stats.
// Used by both routes/fs-browse.js and routes/root-folders.js, and
// normalizeFolderName is also used by routes/series.js for duplicate-title
// detection on POST /api/series.
// ---------------------------------------------------------------------------
const fs = require('fs');
const { db } = require('../db');
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
// numbers for a root folder, computed once at add time (not live on every
// page load). fs.statfsSync has been available since Node 18.15 — already
// below the Node 22.5+ floor node:sqlite requires, so no extra version
// dependency.
function computeRootFolderStats(dirPath) {
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
    const stats = fs.statfsSync(dirPath);
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
    const knownTitles = new Set(db.prepare('SELECT title FROM series').all().map((r) => normalizeFolderName(r.title)));
    const subfolders = fs.readdirSync(dirPath, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    unmapped = subfolders.filter((f) => !knownTitles.has(normalizeFolderName(f.name))).length;
  } catch {
    // leave unmapped at 0 if the folder can't be read for some reason
  }

  return { free, unmapped, freeBytes, totalBytes, usedBytes };
}

module.exports = { stripReleaseNoise, normalizeFolderName, guessTitleFromFolderName, formatBytes, computeRootFolderStats };
