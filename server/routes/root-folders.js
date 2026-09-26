// ---------------------------------------------------------------------------
// /api/root-folders — adding a real root folder (with real free-space/
// unmapped-folder stats) and scanning one for Library Import.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { logInfo } = require('../logger');
const { sendJson, readJsonBody } = require('../lib/http');
const { normalizeFolderName, guessTitleFromFolderName, computeRootFolderStats, formatBytes, pathExists, writeRootFolderMarker, mapWithConcurrency } = require('../lib/fs-helpers');
const { refreshDiskUsage } = require('../lib/disk-usage');
const { walkVideoFiles, summarizeFiles, guessQualityTierName, guessSeasonEpisode } = require('../lib/media-files');
const { rowToItem } = require('./settings-items');

// How many subfolders Library Import's scan walks at once — see
// mapWithConcurrency's own comment in fs-helpers.js for why this needs a
// cap at all. Kept well under libuv's default 4-thread pool (not right at
// it) so a scan never fully starves the rest of the app's real disk I/O —
// most of all server.js's own static file serving, which is what made the
// UI itself look unresponsive during a big scan.
const ROOT_FOLDER_SCAN_CONCURRENCY = 3;

async function handleRootFoldersApi(req, res, urlPath) {
  // POST /api/root-folders — add a real root folder. Distinct from the
  // generic POST /api/settings-items/root-folders (still used underneath
  // for the actual list storage) because this one touches the filesystem:
  // validates the path is a real, readable directory, and computes real
  // free-space/unmapped-folder numbers instead of trusting whatever a
  // client sends.
  if (req.method === 'POST' && urlPath === '/api/root-folders') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const folderPath = String(body.path || '').trim();
    if (!folderPath) {
      sendJson(res, 400, { error: 'Path is required' });
      return true;
    }
    const resolved = path.resolve(folderPath);
    let stat;
    try {
      stat = await fs.promises.stat(resolved);
    } catch (err) {
      sendJson(res, 400, { error: `"${resolved}" doesn't exist or isn't readable (${err.code || err.message})` });
      return true;
    }
    if (!stat.isDirectory()) {
      sendJson(res, 400, { error: `"${resolved}" isn't a directory` });
      return true;
    }

    const alreadyAdded = (await db.prepare("SELECT data FROM settings_items WHERE section = 'root-folders'").all())
      .some((row) => JSON.parse(row.data).path === resolved);
    if (alreadyAdded) {
      sendJson(res, 409, { error: 'That folder is already a root folder' });
      return true;
    }

    const { free, unmapped } = await computeRootFolderStats(resolved);
    // Written now, at add-time, while the user is looking straight at this
    // exact path and clearly means it — the one moment this marker can be
    // trusted without any ambiguity. See lib/root-folder-guard.js: every
    // real import destined for this root folder checks this marker is
    // still readable and matches before writing anything, so a mount that
    // silently reverts to an empty local directory (NFS/SMB/a Docker
    // volume dropping) gets caught instead of quietly "succeeding" into it.
    const markerId = await writeRootFolderMarker(resolved);
    const maxPos = (await db.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM settings_items WHERE section = 'root-folders'").get()).m;
    const created = await db.prepare('INSERT INTO settings_items (section, data, position, created_at) VALUES (?, ?, ?, ?) RETURNING *')
      .get('root-folders', JSON.stringify({ path: resolved, free, unmapped, markerId }), Number(maxPos) + 1, db.now());
    logInfo('SettingsService', `Root folder added: ${resolved} (${free} free, ${unmapped} unmapped, marker ${markerId})`);
    sendJson(res, 201, rowToItem(created));
    // Fire-and-forget: the Disk usage dashboard stat card is otherwise only
    // recomputed on the scheduler's interval (see server/lib/disk-usage.js
    // and server.js's DISK_USAGE_REFRESH_HOURS), which could leave a
    // freshly-added root folder's content missing from that number for
    // hours. Not awaited — the response above already went out, and a
    // rescan can take a while on a big folder; the dashboard just shows
    // "Calculating…" again until this one lands, same as the startup scan.
    refreshDiskUsage().catch(() => {});
    return true;
  }

  // GET /api/root-folders/:id/subfolders — real subdirectories of a
  // configured root folder, each flagged as already matching a Library
  // series or not, a cleaned-up guessed title, and — the piece Library
  // Import used to have nothing for at all — a real summary of the video
  // files actually inside (count, total size, container formats), from a
  // real recursive walk (see server/lib/media-files.js). This is real,
  // uncached work done on every scan/rescan, same as the directory listing
  // itself already was; a big library's first scan can take a moment for
  // exactly that reason.
  const subMatch = req.method === 'GET' && urlPath.match(/^\/api\/root-folders\/(\d+)\/subfolders$/);
  if (subMatch) {
    const id = Number(subMatch[1]);
    const row = await db.prepare("SELECT * FROM settings_items WHERE id = ? AND section = 'root-folders'").get(id);
    if (!row) {
      sendJson(res, 404, { error: 'Root folder not found' });
      return true;
    }
    const folderPath = JSON.parse(row.data).path;

    let entries;
    try {
      entries = await fs.promises.readdir(folderPath, { withFileTypes: true });
    } catch (err) {
      sendJson(res, 502, { error: `Can't read "${folderPath}": ${err.message}` });
      return true;
    }

    // Keyed by normalized title -> {id, title} (not just the title string)
    // so the frontend has a real series id to call POST
    // /api/series/:id/import-files with for an already-matched folder,
    // without a second round-trip just to look it up.
    const seriesByNormalized = new Map(
      (await db.prepare('SELECT id, title FROM series').all()).map((r) => [normalizeFolderName(r.title), r])
    );

    // walkVideoFiles is async (see its own comment in lib/media-files.js for
    // why), but a raw Promise.all across every subfolder at once was a
    // real, confirmed bug of its own: it fans an unbounded number of real
    // recursive filesystem walks out onto Node's libuv threadpool, which
    // defaults to just 4 threads — on a big library (hundreds of unmapped
    // folders is normal) that starves every other request needing real
    // disk I/O for as long as the scan runs, including server.js's own
    // static file serving, which is what made the whole UI look frozen
    // during a scan even though nothing here blocks the JS event loop
    // itself. mapWithConcurrency (see fs-helpers.js) walks a bounded
    // number of subfolders at a time instead — same total wall-clock time
    // for the scan, but it never occupies the whole threadpool, so the
    // rest of the app stays responsive while it runs.
    const dirEntries = entries.filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    const subfolders = (await mapWithConcurrency(dirEntries, ROOT_FOLDER_SCAN_CONCURRENCY, async (e) => {
      const matched = seriesByNormalized.get(normalizeFolderName(e.name)) || null;
      const files = summarizeFiles(await walkVideoFiles(path.join(folderPath, e.name)));
      return {
        name: e.name,
        path: path.join(folderPath, e.name),
        guessedTitle: guessTitleFromFolderName(e.name),
        matchedTitle: matched ? matched.title : null,
        matchedSeriesId: matched ? matched.id : null,
        status: matched ? 'existing' : 'unmatched',
        files,
      };
    })).sort((a, b) => a.name.localeCompare(b.name));

    sendJson(res, 200, { path: folderPath, subfolders });
    return true;
  }

  // GET /api/root-folders/:id/subfolders/:folderName/files — the real
  // per-file listing for one subfolder (name, size, extension, guessed
  // quality tier, guessed season/episode), only computed when Library
  // Import's per-row expand is actually opened — the folder-level summary
  // above already does its own full walk for every folder on every
  // scan/rescan, so this is deliberately lazy rather than also returning
  // full file lists for every folder up front.
  const filesMatch = req.method === 'GET' && urlPath.match(/^\/api\/root-folders\/(\d+)\/subfolders\/([^/]+)\/files$/);
  if (filesMatch) {
    const id = Number(filesMatch[1]);
    const folderName = decodeURIComponent(filesMatch[2]);
    const row = await db.prepare("SELECT * FROM settings_items WHERE id = ? AND section = 'root-folders'").get(id);
    if (!row) {
      sendJson(res, 404, { error: 'Root folder not found' });
      return true;
    }
    const rootPath = JSON.parse(row.data).path;
    const subfolderPath = path.join(rootPath, folderName);
    // Guard against a folder name that escapes the root folder (e.g. "..")
    // — same path-traversal check server.js's static file handler uses.
    if (!subfolderPath.startsWith(rootPath)) {
      sendJson(res, 400, { error: 'Invalid folder name' });
      return true;
    }
    if (!(await pathExists(subfolderPath))) {
      sendJson(res, 404, { error: `"${folderName}" doesn't exist under this root folder` });
      return true;
    }

    const files = (await Promise.all((await walkVideoFiles(subfolderPath))
      .map(async (f) => {
        const guess = guessSeasonEpisode(f.name, f.seasonHint);
        return {
          name: f.name,
          relativePath: f.relativePath,
          sizeBytes: f.sizeBytes,
          sizeFormatted: formatBytes(f.sizeBytes),
          ext: f.ext,
          guessedQuality: await guessQualityTierName(f.name),
          // No "Season N" folder/SxxExx tag means this preview should show
          // whatever the actual import (handleImportFilesApi in
          // import-files.js) will really use — season 1, same default —
          // rather than a "S?" that doesn't match what clicking "Import
          // files" is actually about to do. Still flagged unconfident
          // (guessConfident stays exactly what guessSeasonEpisode said) so
          // the UI can still visually distinguish an assumed season 1 from a
          // real one — see FileDetailRow in LibraryImportPage.jsx.
          guessedSeason: guess.season ?? 1,
          guessedEpisode: guess.episode,
          guessConfident: guess.confident,
        };
      })))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    sendJson(res, 200, { path: subfolderPath, files });
    return true;
  }

  return false;
}

module.exports = { handleRootFoldersApi };
