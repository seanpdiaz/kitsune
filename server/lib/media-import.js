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
//
// Manual Import (server/routes/manual-import.js) is the one caller that can
// ask for `opts.mode = 'move'` instead: files a user points Kitsune at by
// hand are often not seeding anywhere (a folder copied off another machine,
// a download client Kitsune doesn't manage), so the hardlink-keeps-seeding
// argument above doesn't apply and leaving a second copy behind is just
// clutter. The queue's automatic import never passes it, so its behavior is
// unchanged.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { buildEpisodeFilePath } = require('./episode-paths');
const { applyPermissions } = require('./permissions');
const { verifyRootFolderForPath } = require('./root-folder-guard');

async function importEpisodeFile(series, episode, quality, sourcePath, opts = {}) {
  const mode = opts.mode === 'move' ? 'move' : 'copy';
  // sourcePath passed through as opts so buildEpisodeFilePath can preserve
  // the real file's actual extension (instead of always assuming .mkv) and
  // honor the Rename Episodes toggle (keep the original filename verbatim
  // when it's off) — see episode-paths.js.
  const destPath = await buildEpisodeFilePath(series, episode, quality, { sourcePath });

  // Confirm destPath's root folder is actually the mounted volume the user
  // configured before touching the filesystem at all — see
  // root-folder-guard.js's header comment for why this has to happen here,
  // before mkdir, rather than being inferred from whether the mkdir/link/
  // copy calls below throw: they won't, even when the real mount is down,
  // because an unmounted mount point is just an empty, perfectly writable
  // local directory as far as fs calls can tell.
  const mountCheck = await verifyRootFolderForPath(destPath);
  if (mountCheck.verified === false) {
    return {
      ok: false,
      error: `Root folder "${mountCheck.rootFolderPath}" doesn't look mounted right now (its identity marker is missing) — refusing to import into what might be an empty mount point instead of the real Library location`,
    };
  }

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

  // The source already IS the destination — a manual import pointed at the
  // series' own folder, with Rename Episodes off or the file already named
  // exactly what the format produces. Nothing to move, and critically the
  // "clear the stale target" unlink below would otherwise delete the one
  // and only copy of the file before trying to link it onto itself.
  if (path.resolve(sourcePath) === path.resolve(destPath)) {
    return { ok: true, path: destPath, sizeBytes: stat.size, method: 'in-place' };
  }
  // Same check by inode: destPath is already a hardlink of sourcePath (an
  // earlier import of the same file). Same unlink hazard as above, since
  // removing destPath is harmless but the link that follows is a no-op —
  // simpler and safer to recognize it up front. A move still drops the
  // source-side name so the file ends up only in the Library.
  try {
    const destStat = await fs.promises.stat(destPath);
    if (destStat.dev === stat.dev && destStat.ino === stat.ino) {
      if (mode === 'move') await fs.promises.unlink(sourcePath).catch(() => {});
      return { ok: true, path: destPath, sizeBytes: stat.size, method: 'already-linked' };
    }
  } catch { /* nothing at destPath yet — the normal case */ }

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

  if (mode === 'move') return moveIntoPlace(sourcePath, destPath, stat, importDirPaths);

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
      // A hardlink can't land at the wrong size (it's the same inode as the
      // source, by definition) but a real byte-for-byte copy can be cut
      // short by a full disk or a mount dropping mid-write — and unlike the
      // mount check above, that failure mode doesn't throw either; copyFile
      // just stops copying. Confirmed here before this is ever allowed to
      // count as a real import, rather than after the fact if someone
      // notices the episode won't play.
      const destStat = await fs.promises.stat(destPath);
      if (destStat.size !== stat.size) {
        await fs.promises.unlink(destPath).catch(() => {});
        return {
          ok: false,
          error: `Copied file size (${destStat.size} bytes) didn't match the source (${stat.size} bytes) at "${destPath}" — removed the incomplete copy instead of leaving a corrupt file in the Library`,
        };
      }
      await applyPermissions({ filePath: destPath, dirPaths: importDirPaths });
      return { ok: true, path: destPath, sizeBytes: stat.size, method: 'copy' };
    } catch (copyErr) {
      return { ok: false, error: `Could not hardlink or copy into "${destPath}" (${copyErr.code || copyErr.message})` };
    }
  }
}

// Move mode: a plain rename when source and destination share a filesystem
// (instant, atomic), otherwise copy → verify size → remove the source — the
// same truncated-copy check the copy fallback above does, and the source is
// only removed once the Library copy is confirmed whole. Failing to remove
// the source afterwards isn't a failed import (the Library copy is good),
// just reported back as a note so the caller can say so.
async function moveIntoPlace(sourcePath, destPath, stat, importDirPaths) {
  try {
    await fs.promises.rename(sourcePath, destPath);
    await applyPermissions({ filePath: destPath, dirPaths: importDirPaths });
    return { ok: true, path: destPath, sizeBytes: stat.size, method: 'move' };
  } catch (renameErr) {
    if (renameErr.code !== 'EXDEV') {
      return { ok: false, error: `Could not move into "${destPath}" (${renameErr.code || renameErr.message})` };
    }
  }
  try {
    await fs.promises.copyFile(sourcePath, destPath);
    const destStat = await fs.promises.stat(destPath);
    if (destStat.size !== stat.size) {
      await fs.promises.unlink(destPath).catch(() => {});
      return {
        ok: false,
        error: `Copied file size (${destStat.size} bytes) didn't match the source (${stat.size} bytes) at "${destPath}" — removed the incomplete copy and left the source where it was`,
      };
    }
  } catch (copyErr) {
    return { ok: false, error: `Could not copy into "${destPath}" (${copyErr.code || copyErr.message})` };
  }
  await applyPermissions({ filePath: destPath, dirPaths: importDirPaths });
  let note = null;
  try {
    await fs.promises.unlink(sourcePath);
  } catch (err) {
    note = `Imported, but couldn't remove the original at "${sourcePath}" (${err.code || err.message})`;
  }
  return { ok: true, path: destPath, sizeBytes: stat.size, method: 'move', note };
}

module.exports = { importEpisodeFile };
