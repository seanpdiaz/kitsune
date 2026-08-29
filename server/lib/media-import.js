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
  // possibly just created by the mkdirSync below — so both get Folder
  // Chmod/chown, not just the immediate parent.
  const importDirPaths = [path.dirname(path.dirname(destPath)), path.dirname(destPath)];

  let stat;
  try {
    stat = fs.statSync(sourcePath);
  } catch (err) {
    return { ok: false, error: `Source file not found at "${sourcePath}" (${err.code || err.message})` };
  }

  try {
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
  } catch (err) {
    return { ok: false, error: `Could not create "${path.dirname(destPath)}" (${err.code || err.message})` };
  }

  // A re-grab/upgrade landing on the same destination as a previous import —
  // link()/copy-then-rename both fail against an existing target, so clear
  // it first. Best-effort: if this itself fails (permissions, etc.), the
  // link/copy attempt below will surface a clearer, more specific error.
  try {
    fs.unlinkSync(destPath);
  } catch { /* didn't exist, or couldn't remove — proceed either way */ }

  try {
    fs.linkSync(sourcePath, destPath);
    await applyPermissions({ filePath: destPath, dirPaths: importDirPaths });
    return { ok: true, path: destPath, sizeBytes: stat.size, method: 'hardlink' };
  } catch (linkErr) {
    // EXDEV (cross-filesystem) is the expected, common reason this falls
    // back — download and Library folders on separate mounts/drives is a
    // completely normal real-world setup. Any other hardlink failure
    // (unsupported filesystem, permissions) falls back the same way; only a
    // genuine copy failure is reported as an actual error.
    try {
      fs.copyFileSync(sourcePath, destPath);
      await applyPermissions({ filePath: destPath, dirPaths: importDirPaths });
      return { ok: true, path: destPath, sizeBytes: stat.size, method: 'copy' };
    } catch (copyErr) {
      return { ok: false, error: `Could not hardlink or copy into "${destPath}" (${copyErr.code || copyErr.message})` };
    }
  }
}

module.exports = { importEpisodeFile };
