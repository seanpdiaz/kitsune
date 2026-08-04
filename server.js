const http = require('http');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

// ---------------------------------------------------------------------------
// .env loader
//
// No npm dependency (dotenv etc.) to stay true to the "zero dependencies"
// goal — just a plain KEY=VALUE file read once at startup. Only fills in
// vars that aren't already set, so a real environment variable (e.g. set by
// a process manager) always wins over the file.
// ---------------------------------------------------------------------------

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadEnvFile(path.join(__dirname, '.env'));

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DB_PATH = path.join(DATA_DIR, 'kitsune.db');

const MIME = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.svg': 'image/svg+xml',
};

// ---------------------------------------------------------------------------
// Persistence
//
// This is a first pass at giving Kitsune a real data layer instead of the
// hardcoded arrays in app.js. Tags were picked as the test case because
// they're the simplest CRUD shape in the app (id, name, a count).
//
// It's built on Node's built-in `node:sqlite` (stable since Node 22.5, no
// npm dependency needed) so the app stays true to the "zero dependencies"
// goal in the README while still being backed by real SQL. The API surface
// below (/api/tags) is intentionally plain REST/JSON — when this moves to a
// real Postgres/MySQL container later, only this file's DB calls need to
// change. public/app.js just talks to /api/tags either way.
// ---------------------------------------------------------------------------

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DB_PATH);

// ---------------------------------------------------------------------------
// Logging
//
// A real structured logger backing the System > Logs page, which used to
// show a hardcoded, unchanging array — this is what makes it live. Every
// log call does two things: prints a consistent, leveled line to this
// terminal, and persists a row so the UI (GET /api/logs) can show the same
// history. Kept to the last MAX_LOG_ROWS entries so this can't grow forever
// on a long-running server.
//
// This table is created before anything else in the file logs, since seed
// steps below (tags, settings, series) log through this too.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL DEFAULT (datetime('now')),
    level TEXT NOT NULL,
    logger TEXT NOT NULL,
    message TEXT NOT NULL
  )
`);

const MAX_LOG_ROWS = 500;
const insertLog = db.prepare('INSERT INTO logs (level, logger, message) VALUES (?, ?, ?)');
// SQLite has no built-in "keep only the newest N rows" — delete anything
// outside the newest MAX_LOG_ROWS ids after every insert. Cheap at this
// scale (a personal dev tool, not a high-traffic service), so doing it on
// every write is simpler than batching and still keeps the table bounded.
const pruneLogs = db.prepare(`
  DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY id DESC LIMIT ?)
`);

const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];

function log(level, logger, message) {
  const lvl = LOG_LEVELS.includes(level) ? level : 'info';
  insertLog.run(lvl, logger, message);
  pruneLogs.run(MAX_LOG_ROWS);
  const consoleFn = lvl === 'error' ? console.error : lvl === 'warn' ? console.warn : console.log;
  consoleFn(`[${new Date().toISOString()}] ${lvl.toUpperCase().padEnd(5)} [${logger}] ${message}`);
}

const logDebug = (logger, message) => log('debug', logger, message);
const logInfo = (logger, message) => log('info', logger, message);
const logWarn = (logger, message) => log('warn', logger, message);
const logError = (logger, message) => log('error', logger, message);

const DEFAULT_TAG_COLOR = '#f2703d';
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

// name is COLLATE NOCASE so the UNIQUE constraint itself is case-insensitive
// at the DB level on fresh installs — "Anime" and "anime" collide even
// without the app-level check below. Casing typed by the user is still
// preserved in what's stored/returned; only comparisons ignore case.
db.exec(`
  CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT COLLATE NOCASE NOT NULL UNIQUE,
    color TEXT NOT NULL DEFAULT '${DEFAULT_TAG_COLOR}',
    usage_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Defensive migration for DBs created before "color" existed.
const tagColumns = db.prepare('PRAGMA table_info(tags)').all().map((c) => c.name);
if (!tagColumns.includes('color')) {
  db.exec(`ALTER TABLE tags ADD COLUMN color TEXT NOT NULL DEFAULT '${DEFAULT_TAG_COLOR}'`);
  logInfo('Database', 'Migrated tags table: added color column');
}

const tagCount = db.prepare('SELECT COUNT(*) AS n FROM tags').get().n;
if (tagCount === 0) {
  const seed = db.prepare('INSERT INTO tags (name, color, usage_count) VALUES (?, ?, ?)');
  const defaults = [
    ['anime', '#f2703d', 184], ['seasonal', '#4d8df6', 22], ['dual-audio', '#a78bfa', 31],
    ['uncensored', '#ed5b65', 9], ['4k', '#2dd4bf', 6], ['backlog', '#9c9da8', 47],
    ['sequel-only', '#f472b6', 12], ['low-priority', '#f2b705', 15],
  ];
  for (const [name, color, count] of defaults) seed.run(name, color, count);
  logInfo('Database', `Seeded ${defaults.length} default tags into ${DB_PATH}`);
}

// ---------------------------------------------------------------------------
// Settings persistence (everything in the Settings section besides Tags)
//
// Two generic tables cover the rest of the Settings pages instead of one
// bespoke table per page:
//
// - settings_items: list-style sections (Indexers, Download Clients, Import
//   Lists, Connect, Profiles, Custom Formats, Root Folders) — each row is one
//   list entry, stored as a JSON blob so differently-shaped sections (a
//   connection has a protocol/priority/status, a root folder just has a path)
//   don't need their own table.
// - app_settings: field/toggle-style sections (Media Management, General, UI,
//   Metadata, Quality) — one JSON blob per section holding every field's
//   current value, keyed by the data-key each form control carries in the
//   HTML.
//
// Same rationale as Tags: plain REST/JSON now, swappable for a real SQL
// container later without the frontend knowing the difference.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS settings_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section TEXT NOT NULL,
    data TEXT NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS app_settings (
    section TEXT PRIMARY KEY,
    data TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Seed settings_items per-section (only if that section is empty) so the
// mockup's original placeholder data survives the move from in-memory arrays
// to the database, instead of every list appearing empty on first run.
const LIST_SECTION_SEEDS = {
  indexers: [
    { name: 'Nyaa.si', protocol: 'Torrent', meta: 'Anime', priority: 25, enabled: true, status: 'ok' },
    { name: 'AnimeBytes', protocol: 'Torrent', meta: 'Anime (Private)', priority: 25, enabled: true, status: 'ok' },
    { name: 'SubsPlease RSS', protocol: 'Torrent', meta: 'Anime (RSS)', priority: 40, enabled: true, status: 'ok' },
    { name: 'AniDex', protocol: 'Torrent', meta: 'Anime', priority: 30, enabled: true, status: 'fail' },
    { name: 'Erai-raws', protocol: 'Torrent', meta: 'Anime (RSS)', priority: 40, enabled: false, status: 'pending' },
  ],
  'download-clients': [
    { name: 'qBittorrent', protocol: 'Torrent', meta: '192.168.1.20:8080', priority: 1, enabled: true, status: 'ok' },
    { name: 'SABnzbd', protocol: 'Usenet', meta: '192.168.1.20:8081', priority: 1, enabled: true, status: 'fail' },
    { name: 'Transmission', protocol: 'Torrent', meta: '192.168.1.20:9091', priority: 2, enabled: false, status: 'pending' },
  ],
  'import-lists': [
    { name: 'AniList — Watching', protocol: 'Auto add', meta: '/anime/ongoing', priority: 'Anime - Dual Audio', enabled: true, status: 'ok' },
    { name: 'MyAnimeList — Plan to Watch', protocol: 'Auto add', meta: '/anime/wanted', priority: 'SD', enabled: false, status: 'pending' },
    { name: 'Anichart — Seasonal', protocol: 'Auto add', meta: '/anime/ongoing', priority: 'HD-1080p', enabled: true, status: 'ok' },
    { name: 'Trakt — Anime Watchlist', protocol: 'Auto add', meta: '/anime/ongoing', priority: 'Anime - Dual Audio', enabled: true, status: 'fail' },
  ],
  connect: [
    { name: 'Discord', protocol: 'Webhook', meta: 'On Grab, Import', priority: '4 events', enabled: true, status: 'ok' },
    { name: 'Telegram', protocol: 'Bot', meta: 'On Import, Health', priority: '2 events', enabled: true, status: 'ok' },
    { name: 'Notifiarr', protocol: 'API', meta: 'On Grab, Import, Upgrade', priority: '3 events', enabled: false, status: 'pending' },
    { name: 'Custom Webhook', protocol: 'Webhook', meta: 'On Import', priority: '1 event', enabled: true, status: 'fail' },
  ],
  profiles: [
    { name: 'Any', cutoff: 'Bluray-2160p', qualities: '12 of 12', upgrades: true },
    { name: 'SD', cutoff: 'SDTV', qualities: '3 of 12', upgrades: true },
    { name: 'HD-720p/1080p', cutoff: 'WEBDL-1080p', qualities: '8 of 12', upgrades: true },
    { name: 'HD-1080p', cutoff: 'WEBDL-1080p', qualities: '6 of 12', upgrades: true },
    { name: 'Ultra-HD', cutoff: 'Bluray-2160p', qualities: '4 of 12', upgrades: false },
    { name: 'Anime - Dual Audio', cutoff: 'Bluray-1080p', qualities: '7 of 12', upgrades: true },
  ],
  'custom-formats': [
    { name: 'Dual Audio', conditions: 2, profiles: 3 },
    { name: 'Uncensored', conditions: 1, profiles: 2 },
    { name: 'Freeleech', conditions: 1, profiles: 1 },
    { name: 'x265 HEVC', conditions: 2, profiles: 4 },
    { name: 'Multi-Sub', conditions: 1, profiles: 2 },
  ],
  'root-folders': [
    { path: '/anime/ongoing', free: '1.2 TB free', unmapped: 3 },
    { path: '/anime/library', free: '640 GB free', unmapped: 0 },
    { path: '/anime/movies', free: '2.1 TB free', unmapped: 1 },
  ],
};

const countBySection = db.prepare('SELECT COUNT(*) AS n FROM settings_items WHERE section = ?');
const insertItem = db.prepare('INSERT INTO settings_items (section, data, position) VALUES (?, ?, ?)');
for (const [section, items] of Object.entries(LIST_SECTION_SEEDS)) {
  if (countBySection.get(section).n === 0) {
    items.forEach((item, i) => insertItem.run(section, JSON.stringify(item), i));
    logInfo('Database', `Seeded ${items.length} default "${section}" items into ${DB_PATH}`);
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(payload);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1e6) req.destroy(); // basic guard against runaway bodies
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

function rowToTag(row) {
  return { id: row.id, name: row.name, color: row.color, count: row.usage_count };
}

// ---------------------------------------------------------------------------
// /api/tags
// ---------------------------------------------------------------------------

async function handleTagsApi(req, res, urlPath) {
  // GET /api/tags — list all tags, alphabetical (case-insensitive so "Anime"
  // and "backlog" sort together sensibly instead of all-caps floating to the top)
  if (req.method === 'GET' && urlPath === '/api/tags') {
    const rows = db.prepare('SELECT * FROM tags ORDER BY name COLLATE NOCASE ASC').all();
    sendJson(res, 200, rows.map(rowToTag));
    return true;
  }

  // POST /api/tags — create a tag { name, color? }
  // Name casing is preserved as typed ("Anime" stays "Anime"), but duplicate
  // detection is case-insensitive so "Anime" and "anime" can't both exist.
  if (req.method === 'POST' && urlPath === '/api/tags') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const name = String(body.name || '').trim();
    if (!name) {
      sendJson(res, 400, { error: 'Tag name is required' });
      return true;
    }
    let color = DEFAULT_TAG_COLOR;
    if (body.color !== undefined) {
      if (!HEX_COLOR_RE.test(String(body.color))) {
        sendJson(res, 400, { error: 'Color must be a hex value like #f2703d' });
        return true;
      }
      color = body.color;
    }
    const existing = db.prepare('SELECT * FROM tags WHERE name = ? COLLATE NOCASE').get(name);
    if (existing) {
      sendJson(res, 409, { error: 'Tag already exists', tag: rowToTag(existing) });
      return true;
    }
    const { lastInsertRowid } = db.prepare('INSERT INTO tags (name, color, usage_count) VALUES (?, ?, 0)').run(name, color);
    const created = db.prepare('SELECT * FROM tags WHERE id = ?').get(lastInsertRowid);
    logInfo('TagService', `Tag created: ${name}`);
    sendJson(res, 201, rowToTag(created));
    return true;
  }

  // PATCH /api/tags/:id — update name and/or color
  const patchMatch = req.method === 'PATCH' && urlPath.match(/^\/api\/tags\/(\d+)$/);
  if (patchMatch) {
    const id = Number(patchMatch[1]);
    const existing = db.prepare('SELECT * FROM tags WHERE id = ?').get(id);
    if (!existing) {
      sendJson(res, 404, { error: 'Tag not found' });
      return true;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }

    let name = existing.name;
    if (body.name !== undefined) {
      name = String(body.name).trim();
      if (!name) {
        sendJson(res, 400, { error: 'Tag name is required' });
        return true;
      }
      const nameTaken = db.prepare('SELECT * FROM tags WHERE name = ? COLLATE NOCASE AND id != ?').get(name, id);
      if (nameTaken) {
        sendJson(res, 409, { error: 'Tag already exists', tag: rowToTag(nameTaken) });
        return true;
      }
    }

    let color = existing.color;
    if (body.color !== undefined) {
      if (!HEX_COLOR_RE.test(String(body.color))) {
        sendJson(res, 400, { error: 'Color must be a hex value like #f2703d' });
        return true;
      }
      color = body.color;
    }

    db.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?').run(name, color, id);
    const updated = db.prepare('SELECT * FROM tags WHERE id = ?').get(id);
    sendJson(res, 200, rowToTag(updated));
    return true;
  }

  // DELETE /api/tags/:id
  const deleteMatch = req.method === 'DELETE' && urlPath.match(/^\/api\/tags\/(\d+)$/);
  if (deleteMatch) {
    const id = Number(deleteMatch[1]);
    const existing = db.prepare('SELECT * FROM tags WHERE id = ?').get(id);
    if (!existing) {
      sendJson(res, 404, { error: 'Tag not found' });
      return true;
    }
    db.prepare('DELETE FROM tags WHERE id = ?').run(id);
    logInfo('TagService', `Tag deleted: ${existing.name}`);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// /api/settings-items/:section — list-style settings sections
// ---------------------------------------------------------------------------

function rowToItem(row) {
  return { id: row.id, ...JSON.parse(row.data) };
}

async function handleSettingsItemsApi(req, res, urlPath) {
  const listMatch = urlPath.match(/^\/api\/settings-items\/([a-z-]+)$/);
  const itemMatch = urlPath.match(/^\/api\/settings-items\/([a-z-]+)\/(\d+)$/);

  // GET /api/settings-items/:section — list all items for a section, in
  // display order (position, then insertion order as a tiebreaker).
  if (req.method === 'GET' && listMatch) {
    const [, section] = listMatch;
    const rows = db.prepare('SELECT * FROM settings_items WHERE section = ? ORDER BY position ASC, id ASC').all(section);
    sendJson(res, 200, rows.map(rowToItem));
    return true;
  }

  // POST /api/settings-items/:section — create an item { ...fields }
  if (req.method === 'POST' && listMatch) {
    const [, section] = listMatch;
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const maxPos = db.prepare('SELECT COALESCE(MAX(position), -1) AS m FROM settings_items WHERE section = ?').get(section).m;
    const { lastInsertRowid } = db.prepare('INSERT INTO settings_items (section, data, position) VALUES (?, ?, ?)')
      .run(section, JSON.stringify(body), maxPos + 1);
    const created = db.prepare('SELECT * FROM settings_items WHERE id = ?').get(lastInsertRowid);
    logInfo('SettingsService', `Added "${section}" item: ${body.name || body.path || `#${lastInsertRowid}`}`);
    sendJson(res, 201, rowToItem(created));
    return true;
  }

  // PATCH /api/settings-items/:section/:id — merge fields into an existing item
  if (req.method === 'PATCH' && itemMatch) {
    const [, section, idStr] = itemMatch;
    const id = Number(idStr);
    const existing = db.prepare('SELECT * FROM settings_items WHERE id = ? AND section = ?').get(id, section);
    if (!existing) {
      sendJson(res, 404, { error: 'Item not found' });
      return true;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const merged = { ...JSON.parse(existing.data), ...body };
    db.prepare('UPDATE settings_items SET data = ? WHERE id = ?').run(JSON.stringify(merged), id);
    sendJson(res, 200, { id, ...merged });
    return true;
  }

  // DELETE /api/settings-items/:section/:id
  if (req.method === 'DELETE' && itemMatch) {
    const [, section, idStr] = itemMatch;
    const id = Number(idStr);
    const existing = db.prepare('SELECT * FROM settings_items WHERE id = ? AND section = ?').get(id, section);
    if (!existing) {
      sendJson(res, 404, { error: 'Item not found' });
      return true;
    }
    db.prepare('DELETE FROM settings_items WHERE id = ?').run(id);
    const existingData = JSON.parse(existing.data);
    logInfo('SettingsService', `Removed "${section}" item: ${existingData.name || existingData.path || `#${id}`}`);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// /api/app-settings/:section — field/toggle-style settings sections
// ---------------------------------------------------------------------------

async function handleAppSettingsApi(req, res, urlPath) {
  const match = urlPath.match(/^\/api\/app-settings\/([a-z-]+)$/);
  if (!match) return false;
  const [, section] = match;

  // GET /api/app-settings/:section — the saved { key: value } object for this
  // page, or {} if nothing's been saved yet (fresh install / first visit).
  if (req.method === 'GET') {
    const row = db.prepare('SELECT data FROM app_settings WHERE section = ?').get(section);
    sendJson(res, 200, row ? JSON.parse(row.data) : {});
    return true;
  }

  // PUT /api/app-settings/:section — merge the given { key: value } pairs
  // into whatever's already stored (not a full replace), so saving one field
  // never clobbers the others.
  if (req.method === 'PUT') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const row = db.prepare('SELECT data FROM app_settings WHERE section = ?').get(section);
    const merged = { ...(row ? JSON.parse(row.data) : {}), ...body };
    db.prepare(`
      INSERT INTO app_settings (section, data, updated_at) VALUES (?, ?, datetime('now'))
      ON CONFLICT(section) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
    `).run(section, JSON.stringify(merged));
    sendJson(res, 200, merged);
    return true;
  }

  return false;
}

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
  try {
    const stats = fs.statfsSync(dirPath);
    free = formatBytes(stats.bavail * stats.bsize);
  } catch {
    // Some platforms/filesystems don't support statfs — not fatal, just leave it as "—".
  }

  let unmapped = 0;
  try {
    const knownTitles = new Set(db.prepare('SELECT title FROM series').all().map((r) => normalizeFolderName(r.title)));
    const subfolders = fs.readdirSync(dirPath, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.'));
    unmapped = subfolders.filter((f) => !knownTitles.has(normalizeFolderName(f.name))).length;
  } catch {
    // leave unmapped at 0 if the folder can't be read for some reason
  }

  return { free, unmapped };
}

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
      stat = fs.statSync(resolved);
    } catch (err) {
      sendJson(res, 400, { error: `"${resolved}" doesn't exist or isn't readable (${err.code || err.message})` });
      return true;
    }
    if (!stat.isDirectory()) {
      sendJson(res, 400, { error: `"${resolved}" isn't a directory` });
      return true;
    }

    const alreadyAdded = db.prepare("SELECT data FROM settings_items WHERE section = 'root-folders'").all()
      .some((row) => JSON.parse(row.data).path === resolved);
    if (alreadyAdded) {
      sendJson(res, 409, { error: 'That folder is already a root folder' });
      return true;
    }

    const { free, unmapped } = computeRootFolderStats(resolved);
    const maxPos = db.prepare("SELECT COALESCE(MAX(position), -1) AS m FROM settings_items WHERE section = 'root-folders'").get().m;
    const { lastInsertRowid } = db.prepare('INSERT INTO settings_items (section, data, position) VALUES (?, ?, ?)')
      .run('root-folders', JSON.stringify({ path: resolved, free, unmapped }), maxPos + 1);
    const created = db.prepare('SELECT * FROM settings_items WHERE id = ?').get(lastInsertRowid);
    logInfo('SettingsService', `Root folder added: ${resolved} (${free} free, ${unmapped} unmapped)`);
    sendJson(res, 201, rowToItem(created));
    return true;
  }

  // GET /api/root-folders/:id/subfolders — real subdirectories of a
  // configured root folder, each flagged as already matching a Library
  // series or not, plus a cleaned-up guessed title — what Library Import
  // actually shows.
  const subMatch = req.method === 'GET' && urlPath.match(/^\/api\/root-folders\/(\d+)\/subfolders$/);
  if (subMatch) {
    const id = Number(subMatch[1]);
    const row = db.prepare("SELECT * FROM settings_items WHERE id = ? AND section = 'root-folders'").get(id);
    if (!row) {
      sendJson(res, 404, { error: 'Root folder not found' });
      return true;
    }
    const folderPath = JSON.parse(row.data).path;

    let entries;
    try {
      entries = fs.readdirSync(folderPath, { withFileTypes: true });
    } catch (err) {
      sendJson(res, 502, { error: `Can't read "${folderPath}": ${err.message}` });
      return true;
    }

    const seriesByNormalized = new Map(
      db.prepare('SELECT title FROM series').all().map((r) => [normalizeFolderName(r.title), r.title])
    );

    const subfolders = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => {
        const matchedTitle = seriesByNormalized.get(normalizeFolderName(e.name)) || null;
        return {
          name: e.name,
          path: path.join(folderPath, e.name),
          guessedTitle: guessTitleFromFolderName(e.name),
          matchedTitle,
          status: matchedTitle ? 'existing' : 'unmatched',
        };
      })
      .sort((a, b) => a.name.localeCompare(b.name));

    sendJson(res, 200, { path: folderPath, subfolders });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Library persistence (the `series` table)
//
// This used to be a hardcoded array in app.js (`seriesData`) with no way for
// anything to actually land in it — the Add New page's "Add Series" button
// just toggled a local checkmark that vanished the moment you navigated
// away, since app.js (and its array) reloads from scratch on every page.
// Same pattern as Tags/Settings: a real table, a small REST surface, and
// app.js now fetches from here instead of holding the data itself.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    badge TEXT,
    fill TEXT NOT NULL DEFAULT 'accent',
    pct INTEGER NOT NULL DEFAULT 0,
    eps TEXT NOT NULL DEFAULT '0 / 0',
    monitored INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'continuing',
    next_air_days INTEGER,
    added_days_ago INTEGER NOT NULL DEFAULT 0,
    poster TEXT,
    meta TEXT,
    overview TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// One-time seed of the mockup's original 21 series (the same data that used
// to live in app.js's seriesData array) so the Library isn't empty on a
// fresh install. Inserted in the same order as the old array so ids land on
// the same 1-21 values as before.
const SERIES_SEED = [
  { title: 'Frieren', badge: 'airing', fill: 'accent', pct: 78, eps: '21 / 28', monitored: true, status: 'continuing', nextAirDays: 2, addedDaysAgo: 40, poster: 'https://cdn.myanimelist.net/images/anime/1015/138006.jpg', meta: "2023 · Adventure, Drama, Fantasy · TV · 24 min eps", overview: "A veteran elf mage reflects on mortality and connection after outliving the human companions who once saved the world alongside her." },
  { title: 'Chainsaw Man', badge: 'missing', fill: 'warning', pct: 92, eps: '11 / 12', monitored: true, status: 'continuing', nextAirDays: 5, addedDaysAgo: 25, meta: "2022 · Action, Fantasy, Horror · TV · 24 min eps", overview: "A destitute young man merges with his pet devil to become Chainsaw Man, hunting devils for a shadowy government agency." },
  { title: 'Mushoku Tensei', badge: null, fill: 'success', pct: 100, eps: '24 / 24', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 120, meta: "2021 · Adventure, Drama, Fantasy · TV · 24 min eps", overview: "A shut-in gets a second chance at life reincarnated as a mage in a magical world, determined not to waste it this time." },
  { title: 'Solo Leveling', badge: 'downloading', fill: 'accent', pct: 55, eps: '6 / 13', monitored: true, status: 'continuing', nextAirDays: 1, addedDaysAgo: 2, meta: "2024 · Action, Adventure, Fantasy · TV · 24 min eps", overview: "The weakest hunter alive gains a mysterious system that lets him grow stronger with every dungeon he clears." },
  { title: 'Vinland Saga', badge: null, fill: 'success', pct: 100, eps: '24 / 24', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 200, meta: "2019 · Action, Adventure, Drama · TV · 24 min eps", overview: "A young Viking driven by vengeance sails toward a reckoning with the man who killed his father." },
  { title: 'Steins;Gate', badge: 'unmonitored', fill: 'success', pct: 100, eps: '24 / 24', monitored: false, status: 'ended', nextAirDays: null, addedDaysAgo: 300, meta: "2011 · Drama, Sci-Fi, Suspense · TV · 24 min eps", overview: "A self-proclaimed mad scientist stumbles into real time travel, and every fix he makes only tightens the trap." },
  { title: 'Made in Abyss', badge: null, fill: 'success', pct: 100, eps: '13 / 13', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 90, meta: "2017 · Adventure, Drama, Fantasy, Mystery · TV · 24 min eps", overview: "An orphan and the robot boy she rescues descend into a bottomless chasm that punishes anyone who tries to leave it." },
  { title: 'Jujutsu Kaisen', badge: 'missing', fill: 'warning', pct: 88, eps: '22 / 25', monitored: true, status: 'continuing', nextAirDays: 4, addedDaysAgo: 60, meta: "2020 · Action, Fantasy · TV · 24 min eps", overview: "A boy swallows a cursed talisman to save his friends and is drafted into a secret war against man-eating curses." },
  { title: 'Spy x Family', badge: null, fill: 'success', pct: 100, eps: '25 / 25', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 150, meta: "2022 · Action, Comedy · TV · 24 min eps", overview: "A spy, an assassin, and a telepath fake a family to keep the peace, each hiding their true identity from the others." },
  { title: 'Demon Slayer', badge: 'airing', fill: 'accent', pct: 63, eps: '5 / 8', monitored: true, status: 'continuing', nextAirDays: 6, addedDaysAgo: 10, meta: "2019 · Action, Fantasy · TV · 24 min eps", overview: "A boy becomes a demon slayer to avenge his family and find a cure for the sister who survived as a demon." },
  { title: 'Kaguya-sama', badge: null, fill: 'success', pct: 100, eps: '13 / 13', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 180, meta: "2019 · Comedy, Psychological, Romance · TV · 24 min eps", overview: "Two elite student council members would rather scheme and sabotage than admit they're both in love." },
  { title: 'Bocchi the Rock', badge: null, fill: 'success', pct: 100, eps: '12 / 12', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 5, meta: "2022 · Comedy, Music, Slice of Life · TV · 24 min eps", overview: "A crippling introvert joins a band hoping it'll fix her social life; it mostly just gives her a guitar to hide behind." },
  { title: 'Re:ZERO -Starting Life in Another World-', badge: null, fill: 'success', pct: 100, eps: '25 / 25', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 1, poster: 'https://cdn.myanimelist.net/images/anime/1522/128039.jpg', meta: "2016 · Drama, Fantasy, Suspense · TV · 26 min eps", overview: "Wrenched into a fantasy world and killed almost immediately, Subaru discovers he resets to a checkpoint every time he dies." },
  { title: 'Fullmetal Alchemist: Brotherhood', badge: null, fill: 'success', pct: 100, eps: '64 / 64', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 1, poster: 'https://cdn.myanimelist.net/images/anime/1208/94745.jpg', meta: "2009 · Action, Adventure, Drama, Fantasy · TV · 24 min eps", overview: "Two brothers who broke a forbidden alchemical law search for a way to restore what it cost them, and get pulled into a national conspiracy." },
  { title: 'Yani Neko', badge: 'airing', fill: 'accent', pct: 33, eps: '4 / 12', monitored: true, status: 'continuing', nextAirDays: 4, addedDaysAgo: 3, poster: 'https://cdn.myanimelist.net/images/anime/1281/156496.jpg', meta: "2026 · Comedy · TV · 23 min eps", overview: "A catgirl with a serious smoking habit and an even worse rent problem tries, and fails, to get her life together." },
  { title: "Makina-san's a Love Bot?!", badge: null, fill: 'success', pct: 100, eps: '12 / 12', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 2, poster: 'https://cdn.myanimelist.net/images/anime/1843/146935.jpg', meta: "2025 · Comedy, Romance, Sci-Fi, Ecchi · TV · 12 min eps", overview: "A shy robotics enthusiast discovers his crush is an android built to seduce men, except her programming keeps glitching." },
  { title: 'Trinity Seven', badge: null, fill: 'success', pct: 100, eps: '12 / 12', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 2, poster: 'https://cdn.myanimelist.net/images/anime/12/67795.jpg', meta: "2014 · Action, Comedy, Fantasy, Romance, Ecchi · TV · 24 min eps", overview: "After his hometown is erased by a mysterious phenomenon, a boy enrolls in a magic academy alongside seven powerful mages to get it back." },
  { title: 'Strike Witches', badge: null, fill: 'success', pct: 100, eps: '12 / 12', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 2, poster: 'https://cdn.myanimelist.net/images/anime/13/75524.jpg', meta: "2008 · Action, Sci-Fi, Ecchi · TV · 24 min eps", overview: "Girls equipped with magical Striker Units form humanity's last line of defense against an alien invasion in an alternate 1944." },
  { title: 'Angel Beats!', badge: null, fill: 'success', pct: 100, eps: '13 / 13', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 1, poster: 'https://cdn.myanimelist.net/images/anime/1244/111115.jpg', meta: "2010 · Drama, Fantasy · TV · 26 min eps", overview: "A boy wakes with no memories in the afterlife and joins a rebel faction fighting the god-like student council president." },
  { title: 'Higashi no Eden', badge: null, fill: 'success', pct: 100, eps: '11 / 11', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 3, poster: 'https://cdn.myanimelist.net/images/anime/9/15033.jpg', meta: "2009 · Mystery, Psychological, Sci-Fi · TV · 23 min eps", overview: "A naked amnesiac carrying a phone loaded with 8.2 billion yen may be behind a terrorist attack, or the only one who can stop the next one." },
  { title: 'Kiss x Sis', badge: null, fill: 'success', pct: 100, eps: '12 / 12', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 3, poster: 'https://cdn.myanimelist.net/images/anime/1660/121553.jpg', meta: "2010 · Comedy, Romance, Ecchi · TV · 24 min eps", overview: "A boy tries to focus on high school entrance exams while his two step-sisters compete, loudly, for his affection." },
];

// Defensive migration for DBs created before external_id/external_source
// existed (added alongside real per-episode data — see the Episode
// persistence section below). Lets us know which series came from a search
// result, and what id to look episodes up by, without touching anything
// already in the table.
const seriesColumns = db.prepare('PRAGMA table_info(series)').all().map((c) => c.name);
if (!seriesColumns.includes('external_id')) {
  db.exec(`ALTER TABLE series ADD COLUMN external_id TEXT`);
  logInfo('Database', 'Migrated series table: added external_id column');
}
if (!seriesColumns.includes('external_source')) {
  db.exec(`ALTER TABLE series ADD COLUMN external_source TEXT`);
  logInfo('Database', 'Migrated series table: added external_source column');
}
if (!seriesColumns.includes('tvdb_episode_id')) {
  // The TVDB series id used for episode lookups (see Episode persistence
  // below) — separate from external_id/external_source, which record where
  // the series itself was originally added from. A MAL-added series has no
  // TVDB id at all until it's resolved once by title search; this caches
  // that result so it's only ever looked up once.
  db.exec(`ALTER TABLE series ADD COLUMN tvdb_episode_id TEXT`);
  logInfo('Database', 'Migrated series table: added tvdb_episode_id column');
}

const seriesCount = db.prepare('SELECT COUNT(*) AS n FROM series').get().n;
if (seriesCount === 0) {
  const insertSeries = db.prepare(`
    INSERT INTO series (title, badge, fill, pct, eps, monitored, status, next_air_days, added_days_ago, poster, meta, overview)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const s of SERIES_SEED) {
    insertSeries.run(
      s.title, s.badge ?? null, s.fill, s.pct, s.eps, s.monitored ? 1 : 0, s.status,
      s.nextAirDays ?? null, s.addedDaysAgo, s.poster ?? null, s.meta ?? null, s.overview ?? null
    );
  }
  logInfo('Database', `Seeded ${SERIES_SEED.length} default series into ${DB_PATH}`);
}

function rowToSeries(row) {
  return {
    id: row.id,
    title: row.title,
    badge: row.badge,
    fill: row.fill,
    pct: row.pct,
    eps: row.eps,
    monitored: !!row.monitored,
    status: row.status,
    nextAirDays: row.next_air_days,
    addedDaysAgo: row.added_days_ago,
    poster: row.poster,
    meta: row.meta,
    overview: row.overview,
    externalId: row.external_id,
    externalSource: row.external_source,
  };
}

async function handleSeriesApi(req, res, urlPath) {
  // GET /api/series — everything the Library grid / series detail page need.
  if (req.method === 'GET' && urlPath === '/api/series') {
    const rows = db.prepare('SELECT * FROM series ORDER BY id ASC').all();
    sendJson(res, 200, rows.map(rowToSeries));
    return true;
  }

  // POST /api/series — add a series found via search (see Add New). Only
  // title is required; everything else gets a sensible "just added, nothing
  // known yet" default, since a search result doesn't include episode
  // counts, genres, or airing status. `id`/`source` (the search result's
  // MAL or TVDB id, and which one it came from) are stored as
  // external_id/external_source so a MAL-sourced add can later have its real
  // episode list fetched — see GET /api/series/:id/episodes below.
  if (req.method === 'POST' && urlPath === '/api/series') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const title = String(body.title || '').trim();
    if (!title) {
      sendJson(res, 400, { error: 'Title is required' });
      return true;
    }
    const meta = body.year ? `${body.year} · TV` : (body.meta || null);
    const externalId = body.id !== undefined && body.id !== null && body.id !== '' ? String(body.id) : null;
    const externalSource = body.source ? String(body.source) : null;

    // Duplicate check. This is the thing that actually stops a title from
    // being added twice — the Add New page tries to pre-empt this in the UI
    // (see loadLibraryIndex/libraryMatchFor in app.js), but that's just a
    // convenience; without a real check here, re-clicking "Add Series" on
    // the same search result (or two different search results that resolve
    // to the same show, e.g. MAL vs a TVDB fallback result) would silently
    // create a second row in the Library. Two ways a duplicate shows up:
    // the exact same (source, id) pair as an existing series, or a title
    // that normalizes to the same thing — reusing normalizeFolderName (see
    // the Real filesystem access section above), since "same show, different
    // casing/punctuation" is the same comparison problem folder matching
    // already solves.
    if (externalId && externalSource) {
      const byExternal = db.prepare('SELECT id, title FROM series WHERE external_id = ? AND external_source = ?')
        .get(externalId, externalSource);
      if (byExternal) {
        sendJson(res, 409, { error: `"${byExternal.title}" is already in the Library`, existingId: byExternal.id });
        return true;
      }
    }
    const normalizedTitle = normalizeFolderName(title);
    const byTitle = db.prepare('SELECT id, title FROM series').all()
      .find((r) => normalizeFolderName(r.title) === normalizedTitle);
    if (byTitle) {
      sendJson(res, 409, { error: `"${byTitle.title}" is already in the Library`, existingId: byTitle.id });
      return true;
    }

    const { lastInsertRowid } = db.prepare(`
      INSERT INTO series (title, badge, fill, pct, eps, monitored, status, next_air_days, added_days_ago, poster, meta, overview, external_id, external_source)
      VALUES (?, NULL, 'accent', 0, '0 / 0', 1, 'continuing', NULL, 0, ?, ?, ?, ?, ?)
    `).run(title, body.poster || null, meta, body.overview || null, externalId, externalSource);
    const created = db.prepare('SELECT * FROM series WHERE id = ?').get(lastInsertRowid);
    logInfo('SeriesService', `Series added: ${title}${externalSource ? ` (${externalSource}#${externalId})` : ''}`);
    sendJson(res, 201, rowToSeries(created));
    return true;
  }

  // PATCH /api/series/:id — currently just used for the Monitored toggle on
  // the series detail page.
  const patchMatch = req.method === 'PATCH' && urlPath.match(/^\/api\/series\/(\d+)$/);
  if (patchMatch) {
    const id = Number(patchMatch[1]);
    const existing = db.prepare('SELECT * FROM series WHERE id = ?').get(id);
    if (!existing) {
      sendJson(res, 404, { error: 'Series not found' });
      return true;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    if (body.monitored !== undefined) {
      db.prepare('UPDATE series SET monitored = ? WHERE id = ?').run(body.monitored ? 1 : 0, id);
      logInfo('SeriesService', `${existing.title}: monitored set to ${!!body.monitored}`);
    }
    const updated = db.prepare('SELECT * FROM series WHERE id = ?').get(id);
    sendJson(res, 200, rowToSeries(updated));
    return true;
  }

  // DELETE /api/series/:id — removes a series from the library entirely.
  const deleteMatch = req.method === 'DELETE' && urlPath.match(/^\/api\/series\/(\d+)$/);
  if (deleteMatch) {
    const id = Number(deleteMatch[1]);
    const existing = db.prepare('SELECT * FROM series WHERE id = ?').get(id);
    if (!existing) {
      sendJson(res, 404, { error: 'Series not found' });
      return true;
    }
    db.prepare('DELETE FROM series WHERE id = ?').run(id);
    logInfo('SeriesService', `Series deleted: ${existing.title}`);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Episode persistence — real per-episode titles/air dates
//
// This used to run on Jikan (a free, unofficial MyAnimeList wrapper), the
// only source of the three integrations here that had real per-episode
// data — but its episode endpoint turned out to be just as unreliable as
// its search endpoint was, and unlike search (which has the official API to
// fall back on), episodes had nothing else to fall back to. Jikan has been
// removed from the project entirely as a result.
//
// Episodes now come from TheTVDB instead — a real, documented REST API
// rather than something that scrapes MyAnimeList live, so it doesn't share
// Jikan's failure mode. The catch: TVDB and MyAnimeList are different
// catalogs with different ids, so a MAL-added series has no TVDB id to
// start with. resolveTvdbEpisodeSourceId (below, near the rest of the TVDB
// client) resolves one by searching TVDB for the series' own title —
// reusing the same anime-filtered search the MAL-search fallback already
// uses — and caches whatever it finds in a new tvdb_episode_id column so
// that search only ever runs once per series. This can occasionally resolve
// to the wrong show if TVDB's title match is ambiguous; there's no perfect
// fix for that without the id crossing over some other way.
//
// Because this is resolved by title rather than tied to how the series was
// originally added, it works for any series — not just ones added via MAL
// search. The 21 originally-seeded titles and anything added via the old
// TVDB-fallback path can get real episodes too now, not just MAL-sourced
// adds like before.
//
// Results are cached in the `episodes` table on first fetch, so the series
// detail page doesn't re-hit TVDB on every visit.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS episodes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    series_id INTEGER NOT NULL,
    season_number INTEGER NOT NULL DEFAULT 0,
    season_name TEXT,
    num INTEGER NOT NULL,
    title TEXT,
    title_japanese TEXT,
    title_romanji TEXT,
    aired TEXT,
    score REAL,
    filler INTEGER NOT NULL DEFAULT 0,
    recap INTEGER NOT NULL DEFAULT 0,
    url TEXT,
    UNIQUE(series_id, season_number, num)
  )
`);

// Defensive migration for episodes tables created before the extra fields
// below existed.
let episodeColumns = db.prepare('PRAGMA table_info(episodes)').all().map((c) => c.name);
for (const [col, def] of [
  ['title_japanese', 'TEXT'], ['title_romanji', 'TEXT'], ['score', 'REAL'],
  ['filler', 'INTEGER NOT NULL DEFAULT 0'], ['recap', 'INTEGER NOT NULL DEFAULT 0'], ['url', 'TEXT'],
]) {
  if (!episodeColumns.includes(col)) {
    db.exec(`ALTER TABLE episodes ADD COLUMN ${col} ${def}`);
    logInfo('Database', `Migrated episodes table: added ${col} column`);
  }
}

// season_number/season_name need a real migration, not just an ALTER TABLE
// ADD COLUMN: episode numbers restart at 1 for every season (specials vs.
// season 1 vs. season 2, etc.), so a table with just UNIQUE(series_id, num)
// silently drops any episode whose number collides with one from a
// different season via INSERT OR IGNORE — which is exactly why episode
// lists could come back with two different seasons interleaved together
// with no way to tell them apart, or missing episodes outright. SQLite
// can't alter a UNIQUE constraint in place, so this rebuilds the table with
// the corrected UNIQUE(series_id, season_number, num) and copies existing
// rows over as season_number 0 (unknown) — the season a previously-cached
// episode belonged to can't be recovered after the fact; deleting a
// series' rows and re-fetching is what backfills real season numbers.
episodeColumns = db.prepare('PRAGMA table_info(episodes)').all().map((c) => c.name);
if (!episodeColumns.includes('season_number')) {
  logInfo('Database', 'Migrating episodes table: adding season tracking (rebuilding for corrected uniqueness constraint)');
  db.exec(`
    ALTER TABLE episodes RENAME TO episodes_old;
    CREATE TABLE episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      series_id INTEGER NOT NULL,
      season_number INTEGER NOT NULL DEFAULT 0,
      season_name TEXT,
      num INTEGER NOT NULL,
      title TEXT,
      title_japanese TEXT,
      title_romanji TEXT,
      aired TEXT,
      score REAL,
      filler INTEGER NOT NULL DEFAULT 0,
      recap INTEGER NOT NULL DEFAULT 0,
      url TEXT,
      UNIQUE(series_id, season_number, num)
    );
    INSERT OR IGNORE INTO episodes (series_id, season_number, num, title, title_japanese, title_romanji, aired, score, filler, recap, url)
      SELECT series_id, 0, num, title, title_japanese, title_romanji, aired, score, filler, recap, url FROM episodes_old;
    DROP TABLE episodes_old;
  `);
}

// Actual fetching happens in resolveTvdbEpisodeSourceId/fetchTvdbEpisodes,
// defined near the rest of the TVDB client below (they need tvdbFetch/
// tvdbSearchAnimeOnly, which live there) — this just wires the endpoint up
// to them plus the episodes cache.
async function handleSeriesEpisodesApi(req, res, urlPath) {
  const match = req.method === 'GET' && urlPath.match(/^\/api\/series\/(\d+)\/episodes$/);
  if (!match) return false;

  const id = Number(match[1]);
  const series = db.prepare('SELECT * FROM series WHERE id = ?').get(id);
  if (!series) {
    sendJson(res, 404, { error: 'Series not found' });
    return true;
  }

  // Already fetched and cached — serve that instead of hitting TVDB again.
  // Ordered by season first so a flat consumer still gets specials before
  // season 1 before season 2, etc. — the frontend groups by season_number
  // itself for the actual tabbed view.
  const cachedRows = db.prepare(`
    SELECT season_number, season_name, num, title, title_japanese, title_romanji, aired, score, filler, recap, url
    FROM episodes WHERE series_id = ? ORDER BY season_number ASC, num ASC
  `).all(id);
  if (cachedRows.length > 0) {
    const cached = cachedRows.map((r) => ({
      seasonNumber: r.season_number, seasonName: r.season_name, num: r.num, title: r.title,
      titleJapanese: r.title_japanese, titleRomanji: r.title_romanji,
      aired: r.aired, score: r.score, filler: !!r.filler, recap: !!r.recap, url: r.url,
    }));
    sendJson(res, 200, { episodes: cached, source: 'tvdb', cached: true });
    return true;
  }

  try {
    const tvdbId = await resolveTvdbEpisodeSourceId(series);
    if (!tvdbId) {
      // Couldn't resolve any TVDB series for this title — the series detail
      // page falls back to its synthetic "Episode N" list.
      sendJson(res, 200, { episodes: [], source: null, cached: false });
      return true;
    }
    const episodes = await fetchTvdbEpisodes(tvdbId);
    if (episodes.length > 0) {
      const insertEp = db.prepare(`
        INSERT OR IGNORE INTO episodes (series_id, season_number, season_name, num, title, title_japanese, title_romanji, aired, score, filler, recap, url)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const e of episodes) {
        insertEp.run(id, e.seasonNumber, e.seasonName, e.num, e.title, e.titleJapanese, e.titleRomanji, e.aired, e.score, e.filler ? 1 : 0, e.recap ? 1 : 0, e.url);
      }
      logInfo('EpisodeService', `Fetched and cached ${episodes.length} episode(s) for "${series.title}" from TheTVDB`);
    }
    sendJson(res, 200, { episodes, source: 'tvdb', cached: false });
  } catch (err) {
    logWarn('EpisodeService', `Episode fetch failed for "${series.title}": ${err.message}`);
    // Not fatal — respond 200 with an empty list so the frontend just falls
    // back to the synthetic list rather than treating this as an error.
    sendJson(res, 200, { episodes: [], source: 'tvdb', error: err.message, cached: false });
  }
  return true;
}

// ---------------------------------------------------------------------------
// /api/logs — backs the System > Logs page (see the Logging section above,
// near the top of the file, for how entries get written).
// ---------------------------------------------------------------------------

function rowToLog(row) {
  // "Time" only (no date) to match the existing Logs page column, which is
  // labeled just "Time" — this is a single-machine dev tool, not something
  // expected to run continuously across days where the date would matter.
  // The stored value is a full SQLite datetime('now') UTC string like
  // "2026-08-04 01:19:05"; splitting on the space and taking the time part
  // avoids pulling in any date-parsing/timezone-conversion machinery for it.
  const time = (row.timestamp.split(' ')[1] || row.timestamp).slice(0, 8);
  return {
    id: row.id,
    time,
    level: row.level.charAt(0).toUpperCase() + row.level.slice(1), // debug -> Debug, matching the UI's labels
    logger: row.logger,
    message: row.message,
  };
}

async function handleLogsApi(req, res, urlPath) {
  if (req.method !== 'GET' || urlPath !== '/api/logs') return false;

  const params = new URL(req.url, 'http://localhost').searchParams;
  const level = (params.get('level') || 'all').toLowerCase();
  const limit = Math.min(Number(params.get('limit')) || 200, MAX_LOG_ROWS);

  let rows;
  if (level !== 'all' && LOG_LEVELS.includes(level)) {
    rows = db.prepare('SELECT * FROM logs WHERE level = ? ORDER BY id DESC LIMIT ?').all(level, limit);
  } else {
    rows = db.prepare('SELECT * FROM logs ORDER BY id DESC LIMIT ?').all(limit);
  }
  sendJson(res, 200, rows.map(rowToLog));
  return true;
}

// ---------------------------------------------------------------------------
// /api/tvdb/search — live metadata search backed by TheTVDB v4 API
//
// This is the one external integration in the app. The API key lives only
// in server.js / .env and is never sent to the browser — the frontend just
// calls our own /api/tvdb/search endpoint, and this file does the real
// TheTVDB login + search on its behalf.
//
// TheTVDB v4 auth is a two-step dance: POST /login with the API key to get
// a bearer token (valid roughly a month), then send that token on every
// other request. We cache the token in memory and only re-login when it's
// missing, close to expiry, or a request comes back 401.
// ---------------------------------------------------------------------------

const TVDB_API_BASE = process.env.TVDB_API_BASE || 'https://api4.thetvdb.com/v4';
const TVDB_API_KEY = process.env.TVDB_API_KEY || '';

let tvdbToken = null;
let tvdbTokenExpiresAt = 0;

async function tvdbLogin() {
  const res = await fetch(`${TVDB_API_BASE}/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ apikey: TVDB_API_KEY }),
  });
  let json;
  try {
    json = await res.json();
  } catch {
    throw new Error(`TVDB login returned a non-JSON response (status ${res.status})`);
  }
  if (!res.ok || json.status !== 'success' || !json.data || !json.data.token) {
    throw new Error(json.message || `TVDB login failed (status ${res.status})`);
  }
  tvdbToken = json.data.token;
  // Real tokens last ~1 month; refresh a little early to be safe.
  tvdbTokenExpiresAt = Date.now() + 1000 * 60 * 60 * 24 * 25;
}

async function tvdbFetch(pathAndQuery) {
  if (!TVDB_API_KEY) {
    const err = new Error('TVDB_API_KEY is not configured. Add it to .env and restart the server.');
    err.code = 'TVDB_NO_KEY';
    throw err;
  }
  if (!tvdbToken || Date.now() > tvdbTokenExpiresAt) {
    await tvdbLogin();
  }
  let res = await fetch(`${TVDB_API_BASE}${pathAndQuery}`, {
    headers: { Authorization: `Bearer ${tvdbToken}` },
  });
  if (res.status === 401) {
    // Token expired/invalid earlier than expected — log in once more and retry.
    await tvdbLogin();
    res = await fetch(`${TVDB_API_BASE}${pathAndQuery}`, {
      headers: { Authorization: `Bearer ${tvdbToken}` },
    });
  }
  return res;
}

// Maps a TVDB /search result into the shape the Add New page's card template
// already expects (id, title, year, overview, poster) — see initAddNew in
// app.js. TVDB's fields vary a bit by content type, hence the fallbacks.
//
// `name`/`overview` are TVDB's bare default fields — for anime these are
// frequently the native-language (Japanese) title/synopsis, not English.
// `translations`/`overviews` are keyed by 3-letter language code (per TVDB's
// TranslationSimple schema), so `translations.eng`/`overviews.eng` are the
// actual English text when TVDB has it. Checking those FIRST (not last, as
// this originally did) is what keeps results in English instead of Japanese.
function mapTvdbResult(r) {
  const title = (r.translations && r.translations.eng) || r.name || r.title || 'Untitled';
  const overview = (r.overviews && r.overviews.eng) || r.overview || '';
  const yearNum = r.year ? parseInt(r.year, 10) : null;
  return {
    id: r.tvdb_id || r.id,
    title,
    year: Number.isFinite(yearNum) ? yearNum : null,
    overview,
    poster: r.image_url || r.image || null,
    // TVDB's /search index doesn't carry episode counts, scores, or studios
    // (that's on the full series record, not the search index) — genres is
    // the one preview-modal field it actually has here, everything else the
    // modal shows just stays hidden for a TVDB-fallback result.
    numEpisodes: null,
    score: null,
    genres: Array.isArray(r.genres) ? r.genres : [],
    mediaType: null,
    status: r.status || null,
    studios: [],
    altTitleJapanese: null,
    altTitleSynonyms: [],
  };
}

async function handleTvdbApi(req, res, urlPath) {
  if (req.method !== 'GET' || urlPath !== '/api/tvdb/search') return false;

  const q = new URL(req.url, 'http://localhost').searchParams.get('q') || '';
  if (!q.trim()) {
    sendJson(res, 200, []);
    return true;
  }

  try {
    const tvdbRes = await tvdbFetch(`/search?query=${encodeURIComponent(q.trim())}&type=series`);
    let json;
    try {
      json = await tvdbRes.json();
    } catch {
      sendJson(res, 502, { error: 'TVDB returned a non-JSON response' });
      return true;
    }
    if (!tvdbRes.ok) {
      sendJson(res, tvdbRes.status, { error: json.message || 'TVDB search failed' });
      return true;
    }
    const results = (json.data || []).map(mapTvdbResult);
    sendJson(res, 200, results);
  } catch (err) {
    if (err.code === 'TVDB_NO_KEY') {
      sendJson(res, 500, { error: err.message });
    } else {
      logError('TvdbService', `Search failed: ${err.message || err}`);
      sendJson(res, 502, { error: 'Could not reach TheTVDB. ' + (err.message || '') });
    }
  }
  return true;
}

// TVDB's /search has no genre query param to restrict results server-side
// (confirmed against their OpenAPI spec — only query/type/year/company/
// country/director/language/primaryType/network/remote_id exist), and the
// SearchResult schema does define a `genres` array, and TheTVDB does tag
// anime as "Anime" — but in practice, TVDB's lightweight /search index often
// doesn't carry populated genre data at all (that tends to live on the full
// series record, not the search index), even for titles that are genuinely
// tagged Anime on their own series page. A strict "must include Anime"
// filter was silently dropping real matches whenever genres came back empty,
// making the fallback look like it wasn't firing at all. So this only
// excludes a result when TVDB gives us genre data AND it doesn't include
// Anime (a confirmed non-match) — missing/empty genres is treated as
// "unknown," not "excluded."
function isExcludedByGenre(genres) {
  if (!Array.isArray(genres) || genres.length === 0) return false; // unknown — don't exclude
  return !genres.some((g) => String(g).toLowerCase() === 'anime');
}

async function tvdbSearchAnimeOnly(query) {
  const tvdbRes = await tvdbFetch(`/search?query=${encodeURIComponent(query)}&type=series`);
  let json;
  try {
    json = await tvdbRes.json();
  } catch {
    throw new Error(`TVDB returned a non-JSON response (status ${tvdbRes.status})`);
  }
  if (!tvdbRes.ok) {
    throw new Error(json.message || `TVDB search failed (status ${tvdbRes.status})`);
  }
  const raw = json.data || [];
  const results = raw.filter((r) => !isExcludedByGenre(r.genres)).map((r) => ({ ...mapTvdbResult(r), source: 'tvdb' }));
  logWarn('TvdbService', `Fallback search: ${raw.length} raw result(s), ${results.length} after genre filter` +
    (raw.length > 0 ? ` | genres seen: ${JSON.stringify(raw.map((r) => r.genres))}` : ''));
  return results;
}

// ---------------------------------------------------------------------------
// Episode fetching — TheTVDB (see the Episode persistence section, above
// handleSeriesEpisodesApi, for why this replaced Jikan)
// ---------------------------------------------------------------------------

// Figures out which TVDB series id to fetch episodes for, and caches it on
// the series row (tvdb_episode_id) so this only ever runs once per series.
// A series originally added via the TVDB-search fallback already has a TVDB
// id (external_id/external_source) — use it directly. Everything else (a
// MAL-added series, or one of the originally-seeded titles with no external
// id at all) gets resolved by searching TVDB for the series' own title,
// reusing the same anime-filtered search the MAL fallback uses. Returns
// null if nothing could be resolved (TVDB unreachable, no key configured,
// or genuinely no match).
async function resolveTvdbEpisodeSourceId(series) {
  if (series.tvdb_episode_id) return series.tvdb_episode_id;

  let tvdbId = null;
  if (series.external_source === 'tvdb' && series.external_id) {
    tvdbId = series.external_id;
  } else {
    const matches = await tvdbSearchAnimeOnly(series.title);
    if (matches.length > 0) tvdbId = String(matches[0].id);
  }

  if (tvdbId) {
    db.prepare('UPDATE series SET tvdb_episode_id = ? WHERE id = ?').run(tvdbId, series.id);
  }
  return tvdbId;
}

// Fetches every episode TVDB has for a series, from its "default" season
// type (whichever numbering TVDB's own curators picked as the primary one
// for that title — for most anime this lines up with simple aired order).
// Paginated; walks pages until one comes back with no episodes, capped at
// MAX_PAGES as a safety net against an unexpected response shape looping
// forever.
//
// Unlike Jikan, TVDB's episode records have no score/filler/recap
// equivalent, and getting an actually-English name would mean one extra
// request per episode (TVDB's translation data isn't inlined the way
// series-level search results are) — not worth it for what's meant to be
// the *reliable* path. So title/overview here are just whatever TVDB's own
// default-language record has; score/filler/recap/titleJapanese/
// titleRomanji are left null, and the UI already skips those badges
// whenever they're not present.
// Runs async fn over items with at most `limit` running concurrently,
// returning results in the same order as items — a small hand-rolled
// concurrency pool so fetching one translation per episode (below) doesn't
// either serialize into a very slow one-at-a-time loop or fire 20+ requests
// at once.
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

// TVDB's base episode record (`name`/`overview`, used below) is whatever
// language that series' entry defaults to on TVDB — for anime that's
// frequently Japanese, same issue the search results had before English was
// preferred there. Unlike search results, though, episode records don't
// carry the translated text inline — getting it means a separate
// /episodes/{id}/translations/{language} request per episode. Returns null
// (rather than throwing) on a 404 (no English translation exists for that
// episode) or any other failure, so a gap in TVDB's translation coverage
// just means that one episode keeps its native-language title instead of
// failing the whole batch.
async function fetchTvdbEpisodeTranslation(tvdbEpisodeId, language) {
  try {
    const tvdbRes = await tvdbFetch(`/episodes/${tvdbEpisodeId}/translations/${language}`);
    if (tvdbRes.status === 404) return null;
    const json = await tvdbRes.json();
    if (!tvdbRes.ok || !json.data) return null;
    return { name: json.data.name || null, overview: json.data.overview || null };
  } catch {
    return null;
  }
}

async function fetchTvdbEpisodes(tvdbId) {
  const MAX_PAGES = 5;
  const all = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const tvdbRes = await tvdbFetch(`/series/${tvdbId}/episodes/default?page=${page}`);
    let json;
    try {
      json = await tvdbRes.json();
    } catch {
      throw new Error(`TVDB returned a non-JSON response fetching episodes (status ${tvdbRes.status})`);
    }
    if (!tvdbRes.ok) {
      throw new Error(json.message || `TVDB episode fetch failed (status ${tvdbRes.status})`);
    }
    const pageEpisodes = (json.data && json.data.episodes) || [];
    if (pageEpisodes.length === 0) break;
    for (const e of pageEpisodes) {
      if (e.number == null) continue; // specials/extras with no regular episode number
      all.push({
        tvdbEpisodeId: e.id, // only needed to fetch the translation below; not stored past that
        // TVDB's "default" season type response mixes every season together
        // in one flat array (specials as seasonNumber 0, season 1, season 2,
        // ...), and `number` restarts at 1 for each of them — so num alone
        // isn't unique per series, only (seasonNumber, num) is. Dropping
        // seasonNumber here is what caused specials and season 1 to
        // silently collide/interleave before this was tracked.
        seasonNumber: typeof e.seasonNumber === 'number' ? e.seasonNumber : 0,
        seasonName: e.seasonName || null,
        num: e.number,
        title: e.name || `Episode ${e.number}`,
        titleJapanese: null,
        titleRomanji: null,
        aired: e.aired || null,
        score: null,
        filler: false,
        recap: false,
        url: null,
      });
    }
    await sleep(300); // be polite between pages
  }

  // English titles: fetched per episode (see fetchTvdbEpisodeTranslation),
  // a few at a time. Only overwrites the title when TVDB actually has an
  // English translation for that specific episode — otherwise the base
  // (native-language) title from above stays as-is rather than being
  // replaced with nothing.
  await mapWithConcurrency(all, 4, async (ep) => {
    if (!ep.tvdbEpisodeId) return;
    const translation = await fetchTvdbEpisodeTranslation(ep.tvdbEpisodeId, 'eng');
    if (translation && translation.name) ep.title = translation.name;
  });

  return all.map(({ tvdbEpisodeId, ...ep }) => ep);
}

// ---------------------------------------------------------------------------
// /api/mal/search — live metadata search backed by the official MyAnimeList
// API v2 (https://api.myanimelist.net/v2). Needs a free Client ID from
// myanimelist.net/apiconfig, sent as an X-MAL-CLIENT-ID header — that's the
// "client_auth" scheme, good enough for read-only search/details with no
// OAuth login flow needed. Set MAL_CLIENT_ID in .env.
//
// This used to run on Jikan (a free, unofficial MAL wrapper) for search too,
// and for fetching episodes (see the Episode persistence section above) —
// but Jikan's endpoints have to live-scrape MyAnimeList's own site rather
// than serving from cache, and that hop fails intermittently on both, badly
// enough that it's been removed from the project entirely. Search now runs
// on the official API alone, with TheTVDB as the only fallback; episodes
// come from TheTVDB directly (see resolveTvdbEpisodeSourceId/
// fetchTvdbEpisodes above).
//
// One gotcha along the way: the official API silently excludes NSFW/
// ecchi-flagged titles (e.g. "Yosuga no Sora") from search results instead
// of erroring — a clean 200 with zero matches, nothing to retry or catch.
// Fixed by adding `nsfw=true` to the search request (see fetchMalSearchOnce
// below), which is what makes the official API return everything in the
// catalog.
//
// TheTVDB's /search endpoint returns any kind of TV series, not just anime,
// so it's the fallback (filtered to anime, see tvdbSearchAnimeOnly above),
// used when the official API fails or comes back empty after retries. See
// handleMalApi's two-tier order below: official API → TVDB.
// ---------------------------------------------------------------------------

const MAL_API_BASE = process.env.MAL_API_BASE || 'https://api.myanimelist.net/v2';
const MAL_CLIENT_ID = process.env.MAL_CLIENT_ID || '';
const MAL_MAX_ATTEMPTS = 3;
const MAL_RETRY_DELAYS_MS = [500, 1500]; // between attempt 1→2 and 2→3

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// The official API's search result wraps each hit in a "node" object, and
// only returns the default (often romanized) title at top level — the
// English name, if MAL has one, lives at alternative_titles.en. start_date
// is a partial-ISO string ("2017-10-23", "2017-10", or just "2017"), so the
// year is just its leading 4 digits.
function mapMalOfficialResult(node) {
  const altEn = node.alternative_titles && node.alternative_titles.en;
  const title = (altEn && altEn.trim()) || node.title || 'Untitled';
  const yearMatch = node.start_date && String(node.start_date).match(/^(\d{4})/);
  return {
    id: node.id,
    title,
    year: yearMatch ? Number(yearMatch[1]) : null,
    overview: node.synopsis || '',
    poster: (node.main_picture && (node.main_picture.large || node.main_picture.medium)) || null,
    // Everything below here is extra detail for the Add New page's preview
    // modal — none of it is required for search/add to work, so each field
    // is left null/empty rather than thrown out when MAL doesn't have it,
    // and the modal just hides whatever's missing.
    numEpisodes: typeof node.num_episodes === 'number' && node.num_episodes > 0 ? node.num_episodes : null,
    score: typeof node.mean === 'number' ? node.mean : null,
    genres: Array.isArray(node.genres) ? node.genres.map((g) => g.name).filter(Boolean) : [],
    mediaType: node.media_type || null,
    status: node.status || null,
    studios: Array.isArray(node.studios) ? node.studios.map((s) => s.name).filter(Boolean) : [],
    altTitleJapanese: (node.alternative_titles && node.alternative_titles.ja) || null,
    altTitleSynonyms: (node.alternative_titles && Array.isArray(node.alternative_titles.synonyms))
      ? node.alternative_titles.synonyms
      : [],
  };
}

// One attempt at a MAL search via the official API. Throws on any failure
// (timeout, network error, non-2xx, non-JSON, missing client id) —
// handleMalApi below decides whether to retry, fall back to TVDB, or give
// up, based on what kind of error this throws.
async function fetchMalSearchOnce(query) {
  if (!MAL_CLIENT_ID) {
    const err = new Error('MAL_CLIENT_ID is not configured. Add it to .env and restart the server.');
    err.code = 'MAL_NO_CLIENT_ID';
    throw err;
  }

  // A plain fetch() with no timeout can hang indefinitely if the host
  // accepts the connection but never responds — cap it so a bad attempt
  // fails fast instead of eating the whole retry budget on one hang.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  let malRes;
  try {
    const fields = 'alternative_titles,main_picture,synopsis,start_date,num_episodes,mean,genres,media_type,status,studios';
    // nsfw=true is required to get NSFW/ecchi-flagged titles back at all —
    // without it the API silently omits them from results instead of
    // erroring (confirmed: e.g. "Yosuga no Sora" came back as zero results
    // until this was added). Kitsune has no age-gating of its own, so this
    // is just "search the whole catalog" rather than "show explicit content
    // by default" — nothing about the response is unfiltered beyond that.
    malRes = await fetch(`${MAL_API_BASE}/anime?q=${encodeURIComponent(query)}&limit=10&nsfw=true&fields=${fields}`, {
      headers: { 'X-MAL-CLIENT-ID': MAL_CLIENT_ID },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }

  if (malRes.status === 429) {
    const err = new Error('MyAnimeList is rate-limiting us.');
    err.code = 'MAL_RATE_LIMIT';
    throw err;
  }

  const rawText = await malRes.text();
  let json;
  try {
    json = JSON.parse(rawText);
  } catch {
    logError('MalService', `Non-JSON response, status ${malRes.status} | body (first 500 chars): ${rawText.slice(0, 500)}`);
    throw new Error('MyAnimeList returned a non-JSON response');
  }
  if (!malRes.ok) {
    const message = json.message || json.error || `MyAnimeList search failed (status ${malRes.status})`;
    logError('MalService', `Non-OK response from ${MAL_API_BASE}/anime | status: ${malRes.status} | body: ${JSON.stringify(json)}`);
    throw new Error(message);
  }
  return (json.data || []).map((entry) => ({ ...mapMalOfficialResult(entry.node || {}), source: 'mal' }));
}

async function handleMalApi(req, res, urlPath) {
  if (req.method !== 'GET' || urlPath !== '/api/mal/search') return false;

  const q = new URL(req.url, 'http://localhost').searchParams.get('q') || '';
  if (!q.trim()) {
    sendJson(res, 200, []);
    return true;
  }
  const query = q.trim();

  // Tier 1: the official API, retried on transient failures.
  let officialErr = null;
  let attemptsMade = 0;
  for (let attempt = 1; attempt <= MAL_MAX_ATTEMPTS; attempt++) {
    attemptsMade = attempt;
    try {
      const results = await fetchMalSearchOnce(query);
      sendJson(res, 200, results); // an empty array here is a genuine "no matches", not an error
      return true;
    } catch (err) {
      officialErr = err;
      // Retrying into a rate limit only makes it worse, and retrying with
      // no client id configured is pointless — go straight to TVDB either way.
      if (err.code === 'MAL_RATE_LIMIT' || err.code === 'MAL_NO_CLIENT_ID') break;
      if (attempt < MAL_MAX_ATTEMPTS) {
        const delay = MAL_RETRY_DELAYS_MS[attempt - 1] || 1500;
        logWarn('MalService', `Search attempt ${attempt}/${MAL_MAX_ATTEMPTS} failed (${err.message}) — retrying in ${delay}ms...`);
        await sleep(delay);
      }
    }
  }

  const officialReason = officialErr.code === 'MAL_NO_CLIENT_ID' ? 'was skipped (no MAL_CLIENT_ID)'
    : officialErr.code === 'MAL_RATE_LIMIT' ? 'is rate-limiting us'
    : `failed after ${attemptsMade} attempt(s) (${officialErr.message})`;

  // Tier 2: TVDB, filtered to anime — used only when the official API
  // actually fails or is unreachable, not when it succeeds with zero
  // results (that's returned above as a normal empty list).
  logWarn('MalService', `Official API search ${officialReason} — falling back to TVDB.`);
  try {
    const results = await tvdbSearchAnimeOnly(query);
    sendJson(res, 200, results);
  } catch (fallbackErr) {
    logError('MalService', `TVDB fallback also failed: ${fallbackErr.message}`);
    sendJson(res, 502, {
      error: `MyAnimeList's official API ${officialReason}, and the TheTVDB fallback also failed (${fallbackErr.message}).`,
    });
  }
  return true;
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  let urlPath = req.url.split('?')[0];

  // Request logging: every request, static or API, gets one debug-level
  // line once the response actually finishes — that's what backs the "Http"
  // entries on the System > Logs page. Debug level (rather than info) keeps
  // routine page-load noise out of the default view while still being there
  // if you filter down to it. res.on('finish') (not a call made right here)
  // is what lets this capture the real final status code, however deep in
  // the handler chain it ended up getting set.
  const requestStart = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - requestStart;
    logDebug('Http', `${req.method} ${urlPath} ${res.statusCode} ${duration}ms`);
  });

  if (urlPath.startsWith('/api/')) {
    try {
      const handled =
        (await handleTagsApi(req, res, urlPath)) ||
        (await handleSettingsItemsApi(req, res, urlPath)) ||
        (await handleAppSettingsApi(req, res, urlPath)) ||
        (await handleFsBrowseApi(req, res, urlPath)) ||
        (await handleRootFoldersApi(req, res, urlPath)) ||
        (await handleSeriesApi(req, res, urlPath)) ||
        (await handleSeriesEpisodesApi(req, res, urlPath)) ||
        (await handleTvdbApi(req, res, urlPath)) ||
        (await handleMalApi(req, res, urlPath)) ||
        (await handleLogsApi(req, res, urlPath));
      if (!handled) sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      logError('Http', `Unhandled error on ${req.method} ${urlPath}: ${err && err.stack ? err.stack : err}`);
      sendJson(res, 500, { error: 'Internal server error' });
    }
    return;
  }

  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(PUBLIC_DIR, urlPath);

  // Prevent path traversal outside the public directory
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 not found');
      return;
    }
    const ext = path.extname(filePath);
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(content);
  });
});

server.listen(PORT, () => {
  logInfo('Server', `Kitsune mockup running at http://localhost:${PORT}`);
  logInfo('Server', `Data persisted to ${DB_PATH}`);
});
