// ---------------------------------------------------------------------------
// Real import — the last real step of the real grab pipeline (see wiki's
// Real-Search-and-Grabs.md): once a real qBittorrent download actually
// finishes, this is what moves the real file off the download client's disk
// and into the real Library location episode-paths.js's buildEpisodeFilePath
// already computes, instead of just fabricating that path the way the
// simulated pipeline (and the pre-this-feature real one) always has.
//
// Mirrors Sonarr/Radarr's own default Import Mode: hardlink first (same
// file, two directory entries — zero extra disk space, and the torrent can
// keep seeding from its original location afterward), falling back to a
// real copy when a hardlink isn't possible (source and destination on
// different filesystems — EXDEV — or hardlinks unsupported entirely).
// Real Sonarr/Radarr also offer a plain Move; Kitsune deliberately doesn't
// expose that choice — Move would break seeding the same torrent Kitsune's
// own Torrents modal still shows as active, and copy-with-hardlink-
// preferred is the strictly safer default that still costs nothing extra
// disk space in the common case.
//
// Every failure mode here is caller-recoverable, not fatal: no real
// filesystem access at all, source file missing (remote path mapping
// misconfigured or genuinely wrong), permission denied, disk full — all
// come back as { ok: false, error }, which server/routes/queue.js treats as
// "fall back to the fabricated path," the same graceful-degradation rule
// every other real integration in this app already follows. A real import
// is never a hard failure for a download that otherwise genuinely finished.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { buildEpisodeFilePath } = require('./episode-paths');
const { applyPermissions } = require('./permissions');

async function importEpisodeFile(series, episode, quality, sourcePath) {
  // sourcePath passed through as opts so buildEpisodeFilePath can preserve
  // the real file's actual extension (instead of always assuming .mkv) and
  // honor the Rename Episodes toggle (keep the original filename verbatim
  // when it's off) — see episode-paths.js.
  const destPath = await buildEpisodeFilePath(series, episode, quality, { sourcePath });
  // episode-paths.js always lays a real import out as root/seasonFolder/
  // fileName (see buildEpisodeFilePath/seriesFolderNameFor/
  // seasonFolderNameFor) — two directory levels above the file, both
  // possibly just created by the mkdir below — so both get Folder
  // Chmod/chown, not just the immediate parent.
  const importDirPaths = [path.dirname(path.dirname(destPath)), path.dirname(destPath)];

  // Every fs call below uses the fs.promises (non-blocking) form rather than
  // the *Sync one, and this matters for more than just style: fs.*Sync calls
  // run on Node's single main thread and block it completely until they
  // finish, meaning the entire app — every other page load, every other API
  // request — freezes for as long as the call takes. statSync/mkdirSync/
  // unlinkSync/linkSync are metadata-only and effectively instant, but
  // copyFileSync (the EXDEV fallback below) is a real byte-for-byte copy of
  // the whole episode file — hundreds of MB to a few GB — and was confirmed
  // to freeze the whole web UI for the entire duration of a real import
  // whenever the hardlink fast path wasn't available (downloads and Library
  // on separate mounts/drives, or a network share — both completely normal
  // real-world setups, see the comment below). The promise forms hand the
  // actual disk I/O off to libuv's threadpool instead of the main thread, so
  // the rest of the app — including this same route serving other
  // requests — stays responsive while a big copy is in flight.
  let stat;
  try {
    stat = await fs.promises.stat(sourcePath);
  } catch (err) {
    return { ok: false, error: `Source file not found at "${sourcePath}" (${err.code || err.message})` };
  }

  try {
    await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  } catch (err) {
    return { ok: false, error: `Could not create "${path.dirname(destPath)}" (${err.code || err.message})` };
  }

  // A re-grab/upgrade landing on the same destination as a previous import —
  // link()/copy-then-rename both fail against an existing target, so clear
  // it first. Best-effort: if this itself fails (permissions, etc.), the
  // link/copy attempt below will surface a clearer, more specific error.
  try {
    await fs.promises.unlink(destPath);
  } catch { /* didn't exist, or couldn't remove — proceed either way */ }

  try {
    await fs.promises.link(sourcePath, destPath);
    await applyPermissions({ filePath: destPath, dirPaths: importDirPaths });
    return { ok: true, path: destPath, sizeBytes: stat.size, method: 'hardlink' };
  } catch (linkErr) {
    // EXDEV (cross-filesystem) is the expected, common reason this falls
    // back — download and Library folders on separate mounts/drives is a
    // completely normal real-world setup. Any other hardlink failure
    // (unsupported filesystem, permissions) falls back the same way; only a
    // genuine copy failure is reported as an actual error.
    try {
      await fs.promises.copyFile(sourcePath, destPath);
      await applyPermissions({ filePath: destPath, dirPaths: importDirPaths });
      return { ok: true, path: destPath, sizeBytes: stat.size, method: 'copy' };
    } catch (copyErr) {
      return { ok: false, error: `Could not hardlink or copy into "${destPath}" (${copyErr.code || copyErr.message})` };
    }
  }
}

module.exports = { importEpisodeFile };
