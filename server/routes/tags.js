// ---------------------------------------------------------------------------
// /api/tags — tag CRUD, plus the tags table itself and its default seed.
// ---------------------------------------------------------------------------
const db = require('../db');
const { logInfo } = require('../logger');
const { sendJson, readJsonBody } = require('../lib/http');

const DEFAULT_TAG_COLOR = '#f2703d';
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

db.init(async () => {
  // Case-insensitive name comparisons used to be done in SQL with `COLLATE
  // NOCASE` (a SQLite-only named collation, so the UNIQUE constraint itself
  // enforced it at the DB level on fresh installs). Postgres has no
  // equivalent named collation for this, so uniqueness is enforced the same
  // way case-insensitive lookups below are: LOWER(name). Casing typed by
  // the user is still preserved in what's stored/returned; only comparisons
  // ignore case.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS tags (
      id ${db.PK},
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT '${DEFAULT_TAG_COLOR}',
      usage_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `);

  // Defensive migration for DBs created before "color" existed.
  const tagColumns = await db.tableColumns('tags');
  if (!tagColumns.includes('color')) {
    await db.exec(`ALTER TABLE tags ADD COLUMN color TEXT NOT NULL DEFAULT '${DEFAULT_TAG_COLOR}'`);
    logInfo('Database', 'Migrated tags table: added color column');
  }

  const tagCount = (await db.prepare('SELECT COUNT(*) AS n FROM tags').get()).n;
  if (Number(tagCount) === 0) {
    if (db.SEED_DEMO_DATA) {
      const seed = db.prepare('INSERT INTO tags (name, color, usage_count, created_at) VALUES (?, ?, ?, ?)');
      const defaults = [
        ['anime', '#f2703d', 184], ['seasonal', '#4d8df6', 22], ['dual-audio', '#a78bfa', 31],
        ['uncensored', '#ed5b65', 9], ['4k', '#2dd4bf', 6], ['backlog', '#9c9da8', 47],
        ['sequel-only', '#f472b6', 12], ['low-priority', '#f2b705', 15],
      ];
      for (const [name, color, count] of defaults) await seed.run(name, color, count, db.now());
      logInfo('Database', `Seeded ${defaults.length} default tags into ${db.describe()}`);
    } else {
      logInfo('Database', `tags table is empty — skipping demo seed (APP_ENV=${db.APP_ENV})`);
    }
  }
});

// The `usage_count` column on the tags table itself was always a static 0 —
// nothing ever incremented it. Now that series_tags (see the series section
// below) actually records which series carry which tags, the real count is
// just that join, computed fresh rather than trusted from a column that
// could otherwise drift out of sync with reality.
async function tagUsageCount(tagId) {
  return (await db.prepare('SELECT COUNT(*) AS n FROM series_tags WHERE tag_id = ?').get(tagId)).n;
}

async function rowToTag(row) {
  return { id: row.id, name: row.name, color: row.color, count: await tagUsageCount(row.id) };
}

// ---------------------------------------------------------------------------
// /api/tags
// ---------------------------------------------------------------------------

async function handleTagsApi(req, res, urlPath) {
  // GET /api/tags — list all tags, alphabetical (case-insensitive so "Anime"
  // and "backlog" sort together sensibly instead of all-caps floating to the top)
  if (req.method === 'GET' && urlPath === '/api/tags') {
    const rows = await db.prepare('SELECT * FROM tags ORDER BY LOWER(name) ASC').all();
    sendJson(res, 200, await Promise.all(rows.map(rowToTag)));
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
    const existing = await db.prepare('SELECT * FROM tags WHERE LOWER(name) = LOWER(?)').get(name);
    if (existing) {
      sendJson(res, 409, { error: 'Tag already exists', tag: await rowToTag(existing) });
      return true;
    }
    const created = await db.prepare('INSERT INTO tags (name, color, usage_count, created_at) VALUES (?, ?, 0, ?) RETURNING *')
      .get(name, color, db.now());
    logInfo('TagService', `Tag created: ${name}`);
    sendJson(res, 201, await rowToTag(created));
    return true;
  }

  // PATCH /api/tags/:id — update name and/or color
  const patchMatch = req.method === 'PATCH' && urlPath.match(/^\/api\/tags\/(\d+)$/);
  if (patchMatch) {
    const id = Number(patchMatch[1]);
    const existing = await db.prepare('SELECT * FROM tags WHERE id = ?').get(id);
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
      const nameTaken = await db.prepare('SELECT * FROM tags WHERE LOWER(name) = LOWER(?) AND id != ?').get(name, id);
      if (nameTaken) {
        sendJson(res, 409, { error: 'Tag already exists', tag: await rowToTag(nameTaken) });
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

    await db.prepare('UPDATE tags SET name = ?, color = ? WHERE id = ?').run(name, color, id);
    const updated = await db.prepare('SELECT * FROM tags WHERE id = ?').get(id);
    sendJson(res, 200, await rowToTag(updated));
    return true;
  }

  // DELETE /api/tags/:id
  const deleteMatch = req.method === 'DELETE' && urlPath.match(/^\/api\/tags\/(\d+)$/);
  if (deleteMatch) {
    const id = Number(deleteMatch[1]);
    const existing = await db.prepare('SELECT * FROM tags WHERE id = ?').get(id);
    if (!existing) {
      sendJson(res, 404, { error: 'Tag not found' });
      return true;
    }
    await db.prepare('DELETE FROM tags WHERE id = ?').run(id);
    await db.prepare('DELETE FROM series_tags WHERE tag_id = ?').run(id);
    logInfo('TagService', `Tag deleted: ${existing.name}`);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

module.exports = { handleTagsApi };
