// ---------------------------------------------------------------------------
// GET /api/fs/browse — the server-side directory browser behind the File
// Browser modal (Add Root Folder, and the Edit Series modal's Path field).
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { sendJson } = require('../lib/http');

// GET /api/fs/browse?path=... — powers the File Browser modal. Folders
// only (matching the reference UI), dotfiles/dot-directories hidden, sorted
// alphabetically. Defaults to the real filesystem root when no path is
// given, same starting point as Sonarr's own browser.
async function handleFsBrowseApi(req, res, urlPath) {
  if (req.method !== 'GET' || urlPath !== '/api/fs/browse') return false;

  const params = new URL(req.url, 'http://localhost').searchParams;
  const requested = params.get('path') || (process.platform === 'win32' ? 'C:\\' : '/');
  const target = path.resolve(requested);

  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (err) {
    sendJson(res, 400, { error: `Can't read "${target}": ${err.message}` });
    return true;
  }

  const folders = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  const parent = path.dirname(target);
  sendJson(res, 200, {
    path: target,
    parent: parent === target ? null : parent, // null once we're at the real filesystem root
    folders,
  });
  return true;
}

module.exports = { handleFsBrowseApi };
