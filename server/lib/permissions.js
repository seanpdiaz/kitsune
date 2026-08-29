// ---------------------------------------------------------------------------
// Applies Settings > Media Management's "Set Permissions" section (chmod
// folder/file + chown user/group) to a just-imported or just-renamed real
// file, and the real folder(s) Kitsune created for it.
//
// setPermissionsToggle, Folder Chmod (mm-10), and File Chmod (mm-11) have
// existed in MediaManagementPage.jsx since the original HTML port — the
// toggle and both text fields have always rendered — but nothing on the
// backend ever read them; every real import (media-import.js) and manual
// Rename Files (routes/episodes.js) has always just left whatever
// permissions fs.linkSync/fs.copyFileSync/fs.renameSync/fs.mkdirSync's own
// umask produced. This module, plus the two call sites that now call
// applyPermissions() after a real write, is what makes the toggle do
// something. chownUser/chownGroup are new fields added alongside the
// pre-existing three (see episode-paths.js's DEFAULT_SETTINGS and
// MediaManagementPage.jsx's DEFAULTS).
//
// Only ever called after a real file already exists on disk (a successful
// hardlink/copy, or a successful rename) — never for routes/queue.js's
// fallback branch, which just computes a fabricated placeholder path when a
// real import couldn't happen at all; there's nothing real to chmod/chown
// in that case.
//
// Every failure here is logged and swallowed, never thrown: fixing
// permissions is best-effort polish on top of a real, already-successful
// import/rename, not something that should undo it or block the response.
// chown in particular almost always requires the OS user Kitsune's Node
// process runs as to be root — a completely normal thing to NOT be on a
// real machine — so an EPERM there gets an explicit "this is expected
// unprivileged" hint instead of reading like a generic, alarming failure.
// ---------------------------------------------------------------------------
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { logInfo, logWarn } = require('../logger');
const { getMediaManagementSettings } = require('./episode-paths');

const OCTAL_MODE_RE = /^[0-7]{3,4}$/;

async function getPermissionSettings() {
  const s = await getMediaManagementSettings();
  return {
    enabled: !!s.setPermissionsToggle,
    folderMode: s['mm-10'] || '755',
    fileMode: s['mm-11'] || '644',
    chownUser: String(s.chownUser || '').trim(),
    chownGroup: String(s.chownGroup || '').trim(),
  };
}

// uid/gid lookups shell out (Node has no built-in getpwnam/getgrnam), so
// each unique name is only resolved once per process lifetime rather than
// once per file — meaningful for a batch "Rename Files" run across a whole
// season. Same tradeoff this app already makes elsewhere for anything that
// needs a real restart to pick up a changed account (see server.js's own
// note on route changes): renaming the underlying OS account/group while
// Kitsune is running won't be picked up until the next restart.
const idCache = new Map();

function resolveUid(username) {
  if (!username) return null;
  if (/^\d+$/.test(username)) return Number(username);
  const cacheKey = `uid:${username}`;
  if (idCache.has(cacheKey)) return idCache.get(cacheKey);
  let uid = null;
  try {
    const out = execFileSync('id', ['-u', username], { encoding: 'utf8' }).trim();
    uid = Number(out);
    if (!Number.isFinite(uid)) uid = null;
  } catch (err) {
    logWarn('Permissions', `Could not resolve chown user "${username}" to a uid (${err.code || err.message}) — is that a real local account on this machine? Falling back to leaving the owner unchanged.`);
  }
  idCache.set(cacheKey, uid);
  return uid;
}

function resolveGid(groupname) {
  if (!groupname) return null;
  if (/^\d+$/.test(groupname)) return Number(groupname);
  const cacheKey = `gid:${groupname}`;
  if (idCache.has(cacheKey)) return idCache.get(cacheKey);
  let gid = null;
  try {
    if (os.platform() === 'darwin') {
      // macOS has no `getent` — dscacheutil is the standard lookup (same
      // source `dscl`/Directory Utility.app read from).
      const out = execFileSync('dscacheutil', ['-q', 'group', '-a', 'name', groupname], { encoding: 'utf8' });
      const m = /^gid:\s*(\d+)/m.exec(out);
      gid = m ? Number(m[1]) : null;
    } else {
      // Linux (the more common real Kitsune deployment target — see the
      // wiki's Docker note on this same settings section): getent reads
      // /etc/group plus any configured NSS backend, same source
      // `chgrp`/`id` use.
      const out = execFileSync('getent', ['group', groupname], { encoding: 'utf8' });
      const gidField = out.trim().split(':')[2];
      gid = gidField ? Number(gidField) : null;
    }
    if (!Number.isFinite(gid)) gid = null;
  } catch (err) {
    logWarn('Permissions', `Could not resolve chown group "${groupname}" to a gid (${err.code || err.message}) — is that a real local group on this machine? Falling back to leaving the group unchanged.`);
  }
  idCache.set(cacheKey, gid);
  return gid;
}

function chmodPath(targetPath, modeStr, kind) {
  if (!OCTAL_MODE_RE.test(modeStr || '')) {
    logWarn('Permissions', `Skipped chmod on "${targetPath}" — configured ${kind} chmod "${modeStr}" isn't a valid octal permission string (expected e.g. "755" or "644").`);
    return;
  }
  try {
    fs.chmodSync(targetPath, parseInt(modeStr, 8));
  } catch (err) {
    logWarn('Permissions', `Could not chmod ${kind} "${targetPath}" to ${modeStr}: ${err.code || err.message}`);
  }
}

function chownPath(targetPath, settings) {
  if (!settings.chownUser && !settings.chownGroup) return;
  const uid = settings.chownUser ? resolveUid(settings.chownUser) : null;
  const gid = settings.chownGroup ? resolveGid(settings.chownGroup) : null;
  // resolveUid/resolveGid already logged the specific reason — bail here
  // rather than falling through to a chown that would silently reset the
  // half that failed to resolve.
  if (settings.chownUser && uid == null) return;
  if (settings.chownGroup && gid == null) return;

  let current;
  try {
    current = fs.statSync(targetPath);
  } catch (err) {
    logWarn('Permissions', `Could not stat "${targetPath}" before chown: ${err.code || err.message}`);
    return;
  }
  // Only the half actually configured on this settings page changes — an
  // owner set with no group configured (or vice versa) leaves the other one
  // exactly as it already was, rather than resetting it to whatever
  // Kitsune's own process happens to be running as. Same "don't clobber
  // what wasn't configured" rule series.path's manual-override handling
  // already follows (see episode-paths.js's buildEpisodeFilePath).
  const finalUid = uid != null ? uid : current.uid;
  const finalGid = gid != null ? gid : current.gid;
  try {
    fs.chownSync(targetPath, finalUid, finalGid);
  } catch (err) {
    const hint = err.code === 'EPERM'
      ? ' — chown almost always requires Kitsune\'s own process to be running as root; this is an expected outcome unprivileged, not a bug in Kitsune'
      : '';
    logWarn('Permissions', `Could not chown "${targetPath}" to ${settings.chownUser || '(unchanged)'}:${settings.chownGroup || '(unchanged)'}: ${err.code || err.message}${hint}`);
  }
}

// dirPaths: every real directory Kitsune just created/touched for this file
// (series folder, season folder — see episode-paths.js's two-level
// root/seasonFolder/fileName layout), outermost first; each gets Folder
// Chmod + chown. filePath: the file itself, gets File Chmod + chown. Both
// are optional so a caller that only has one (e.g. a rename that never
// touches a folder) can omit the other.
async function applyPermissions({ filePath, dirPaths = [] } = {}) {
  const settings = await getPermissionSettings();
  if (!settings.enabled) return;

  for (const dir of dirPaths) {
    if (!dir) continue;
    chmodPath(dir, settings.folderMode, 'folder');
    chownPath(dir, settings);
  }
  if (filePath) {
    chmodPath(filePath, settings.fileMode, 'file');
    chownPath(filePath, settings);
  }

  const chownSummary = settings.chownUser || settings.chownGroup
    ? `, chown ${settings.chownUser || '(unchanged)'}:${settings.chownGroup || '(unchanged)'}`
    : '';
  logInfo('Permissions', `Applied permissions (folders ${settings.folderMode}, files ${settings.fileMode}${chownSummary}) for "${filePath || dirPaths[dirPaths.length - 1] || '(unknown path)'}"`);
}

module.exports = { applyPermissions };
