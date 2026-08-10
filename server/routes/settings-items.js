// ---------------------------------------------------------------------------
// /api/settings-items/:section — the list-style Settings pages (Indexers,
// Download Clients, Import Lists, Connect, Profiles, Custom Formats, Root
// Folders). rowToItem is also reused by routes/root-folders.js.
// ---------------------------------------------------------------------------
const { db, DB_PATH } = require('../db');
const { logInfo } = require('../logger');
const { sendJson, readJsonBody } = require('../lib/http');
const { refreshDiskUsage } = require('../lib/disk-usage');

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
  // Unlike every other list-style section, Download Clients makes real
  // network calls (see server/lib/download-clients/*.js and
  // routes/download-clients.js) instead of simulating a Test button, so its
  // rows carry the actual fields Sonarr/Radarr use to reach a real
  // qBittorrent/NZBGet instance rather than the generic name/protocol/meta
  // shape every other connections-style section (Indexers, Import Lists,
  // Connect) still uses. `type` selects which client module handles Test/
  // submit; `version`/`status` are last-known values from the most recent
  // real Test call, not simulated. clientPriority is Sonarr/Radarr's
  // lower-is-first round-robin priority across multiple enabled clients of
  // the same protocol — unrelated to the qBittorrent-only torrent options.
  'download-clients': [
    {
      type: 'qbittorrent', name: 'qBittorrent', protocol: 'Torrent',
      host: '192.168.1.20', port: 8080, useSsl: false, username: 'admin', password: '',
      category: 'kitsune', clientPriority: 1, enabled: true, status: 'pending', version: null,
      initialState: 'start', contentLayout: 'original', sequentialOrder: false, firstLastPiecePriority: true,
    },
    {
      type: 'nzbget', name: 'NZBGet', protocol: 'Usenet',
      host: '192.168.1.20', port: 6789, useSsl: false, username: 'nzbget', password: '',
      category: 'kitsune', clientPriority: 1, enabled: true, status: 'pending', version: null,
      nzbPriority: 0,
    },
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
  // Settings > Quality's tier ladder — worst to best, array order becomes each
  // row's `position`, which is also its cutoff-comparison rank (see
  // server/lib/quality.js). User-managed now (add/rename/delete/reorder from
  // the page itself — see README's Quality Definitions section), this seed is
  // just a sensible starting point, not a fixed list. min/preferred/max are
  // MB per minute of runtime — a duration-independent rate, same unit the
  // page always stored, so a chosen "reference runtime" can turn it into a
  // real GB estimate for any episode length without changing what's saved.
  'quality-tiers': [
    { name: 'SDTV', resolutionGroup: 'SD', minMBPerMin: 2, preferredMBPerMin: 60, maxMBPerMin: 100, maxUnlimited: false },
    { name: 'WEBDL-480p', resolutionGroup: 'SD', minMBPerMin: 2, preferredMBPerMin: 70, maxMBPerMin: 110, maxUnlimited: false },
    { name: 'HDTV-720p', resolutionGroup: '720p', minMBPerMin: 8, preferredMBPerMin: 100, maxMBPerMin: 150, maxUnlimited: false },
    { name: 'WEBDL-720p', resolutionGroup: '720p', minMBPerMin: 8, preferredMBPerMin: 110, maxMBPerMin: 160, maxUnlimited: false },
    { name: 'Bluray-720p', resolutionGroup: '720p', minMBPerMin: 8, preferredMBPerMin: 130, maxMBPerMin: 190, maxUnlimited: false },
    { name: 'HDTV-1080p', resolutionGroup: '1080p', minMBPerMin: 15, preferredMBPerMin: 150, maxMBPerMin: 200, maxUnlimited: false },
    { name: 'WEBDL-1080p', resolutionGroup: '1080p', minMBPerMin: 15, preferredMBPerMin: 160, maxMBPerMin: 220, maxUnlimited: false },
    { name: 'Bluray-1080p', resolutionGroup: '1080p', minMBPerMin: 15, preferredMBPerMin: 200, maxMBPerMin: 280, maxUnlimited: false },
    { name: 'HDTV-2160p', resolutionGroup: '2160p', minMBPerMin: 30, preferredMBPerMin: 300, maxMBPerMin: 400, maxUnlimited: false },
    { name: 'WEBDL-2160p', resolutionGroup: '2160p', minMBPerMin: 30, preferredMBPerMin: 320, maxMBPerMin: 450, maxUnlimited: false },
    { name: 'Bluray-2160p', resolutionGroup: '2160p', minMBPerMin: 30, preferredMBPerMin: 400, maxMBPerMin: 550, maxUnlimited: false },
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
// /api/settings-items/:section — list-style settings sections
// ---------------------------------------------------------------------------

// `position` is always included and always authoritative from the column
// (listed last, so it can't be shadowed by a same-named key that ever ended
// up inside a row's own data blob) — added for Settings > Quality's
// reorder buttons (see README's Quality Definitions section), but exposed
// for every section since any other list-style page could use it the same
// way later.
function rowToItem(row) {
  return { id: row.id, ...JSON.parse(row.data), position: row.position };
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
    // `position` is a reserved key: it lives in its own DB column (used for
    // both display order and, for quality-tiers, cutoff rank — see
    // server/lib/quality.js), not inside the JSON data blob, so it's pulled
    // out here rather than merged in with everything else. Added for
    // Settings > Quality's reorder buttons; any other list-style section
    // could send it too, generically.
    const { position, ...dataFields } = body;
    const merged = { ...JSON.parse(existing.data), ...dataFields };
    if (position !== undefined) {
      db.prepare('UPDATE settings_items SET data = ?, position = ? WHERE id = ?').run(JSON.stringify(merged), position, id);
    } else {
      db.prepare('UPDATE settings_items SET data = ? WHERE id = ?').run(JSON.stringify(merged), id);
    }
    const updated = db.prepare('SELECT * FROM settings_items WHERE id = ?').get(id);
    sendJson(res, 200, rowToItem(updated));
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
    // Root folder removal is the one delete in this generic handler that
    // needs to trigger a Disk usage recompute (see server/lib/disk-usage.js
    // and the matching hook on the add path in routes/root-folders.js) —
    // fire-and-forget, doesn't hold up this response.
    if (section === 'root-folders') refreshDiskUsage();
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

module.exports = { handleSettingsItemsApi, rowToItem };
