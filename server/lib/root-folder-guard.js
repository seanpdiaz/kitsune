// ---------------------------------------------------------------------------
// Verifies that a real import's destination is actually landing on the
// mounted root folder the user configured, not on an empty local directory
// that happens to sit at the same path because the real mount (NFS/SMB/a
// Docker volume) is currently disconnected — that's a real, confirmed
// failure mode: the mount point doesn't error when it's down, it just
// reverts to a normal, writable, empty directory, so a naive "does this
// path exist and can I write to it" check (which is all mkdir + hardlink/
// copy ever do) can't tell the difference, and a real import can "succeed"
// by writing the episode into what's effectively a black hole.
//
// The fix mirrors real Sonarr's own root-folder health check: a small
// hidden identity marker (see fs-helpers.js's writeRootFolderMarker/
// readRootFolderMarker) written into each root folder the moment it's added
// (routes/root-folders.js), whose id is also stored on that root folder's
// own settings_items row. From then on, an import is only allowed to
// proceed once the marker on disk is read back and confirmed to match —
// proof this is the same mounted volume, not just a directory at the same
// path.
//
// Used from server/lib/media-import.js, right before a real hardlink/copy
// is attempted.
// ---------------------------------------------------------------------------
const path = require('path');
const db = require('../db');
const { logInfo } = require('../logger');
const { pathExists, writeRootFolderMarker, readRootFolderMarker } = require('./fs-helpers');

// Finds the configured root folder that owns `destPath` — the row whose
// `path` is the longest matching prefix, same "most specific wins" rule a
// real filesystem mount table would use. Returns null when no configured
// root folder owns this path at all (e.g. a series.path manual override
// pointing somewhere never added as a root folder, or the hardcoded
// /mnt/anime fallback episode-paths.js uses when literally no root folder
// is configured yet) — there's nothing to verify against in that case, so
// callers treat null the same as "can't check," not "check failed."
async function findOwningRootFolderRow(destPath) {
  const rows = await db.prepare("SELECT * FROM settings_items WHERE section = 'root-folders'").all();
  let best = null;
  let bestPath = null;
  for (const row of rows) {
    let data;
    try {
      data = JSON.parse(row.data);
    } catch {
      continue;
    }
    if (!data.path) continue;
    const withSep = data.path.endsWith(path.sep) ? data.path : data.path + path.sep;
    if (destPath !== data.path && !destPath.startsWith(withSep)) continue;
    if (!best || data.path.length > bestPath.length) {
      best = row;
      bestPath = data.path;
    }
  }
  return best;
}

// A root folder added before this feature existed has no marker yet — never
// having been through this check isn't itself suspicious, so this doesn't
// block anything for that case. Instead, the very first time such a root
// folder is observed in a plausibly-real (currently reachable) state, it
// quietly adopts a marker as its trusted baseline going forward, exactly
// like a fresh "Add Root Folder" would have written one at add-time. If the
// folder isn't reachable the moment this runs, nothing is adopted and this
// import proceeds unverified — same behavior as before this feature
// existed, rather than guessing.
async function ensureRootFolderMarker(row) {
  let data;
  try {
    data = JSON.parse(row.data);
  } catch {
    return null;
  }
  if (data.markerId) return data.markerId;
  if (!(await pathExists(data.path))) return null;

  const markerId = (await readRootFolderMarker(data.path)) || (await writeRootFolderMarker(data.path));
  data.markerId = markerId;
  await db.prepare('UPDATE settings_items SET data = ? WHERE id = ?').run(JSON.stringify(data), row.id);
  logInfo('RootFolderGuard', `Adopted an identity marker for pre-existing root folder "${data.path}" (first time it's been seen reachable since mount verification was added)`);
  return markerId;
}

// { verified: true }  — destPath's root folder is confirmed to be the real
//                        mounted volume; proceed.
// { verified: false, rootFolderPath } — a marker is on record for this root
//                        folder and it doesn't match (or is missing) right
//                        now; refuse the import rather than risk writing
//                        into an empty mount point.
// { verified: null }  — nothing to check against (no owning root folder, or
//                        a legacy one that's never been reachable under
//                        this check yet); proceed unverified, same as
//                        before this feature existed.
async function verifyRootFolderForPath(destPath) {
  const row = await findOwningRootFolderRow(destPath);
  if (!row) return { verified: null };

  let data;
  try {
    data = JSON.parse(row.data);
  } catch {
    return { verified: null };
  }

  if (!data.markerId) {
    const adopted = await ensureRootFolderMarker(row);
    return { verified: adopted ? true : null, rootFolderPath: data.path };
  }

  const onDisk = await readRootFolderMarker(data.path);
  return onDisk === data.markerId
    ? { verified: true, rootFolderPath: data.path }
    : { verified: false, rootFolderPath: data.path };
}

module.exports = { verifyRootFolderForPath, findOwningRootFolderRow, ensureRootFolderMarker };
