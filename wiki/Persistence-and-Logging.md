# Persistence and Logging

## Persistence

- Backing store: pick with `DB_CLIENT` in `.env` (see `.env.example`) — `sqlite`
  (the default when unset) uses Node's built-in `node:sqlite` module, no npm
  package or setup needed, a single file under `data/`; `postgres` points the
  whole app at a real Postgres server instead, using `DB_HOST`/`DB_PORT`/
  `DB_NAME`/`DB_USER`/`DB_PASSWORD`/`DB_SSL`. Every table, route, and query
  works identically either way — switching this one variable is the entire
  migration from a zero-config local install to a real deployed database.
- File lives at `data/kitsune.db` under `DB_CLIENT=sqlite`, created automatically
  on first run. Under `DB_CLIENT=postgres` there's no local file at all — the
  data lives on whatever Postgres server the `DB_*` vars point to.
- Four tables cover all of it:
  - `series` — the Library. One row per series (title, poster, episode count, monitored,
    status, etc), plus the fields the Edit Series modal manages — `monitor_new_seasons`,
    `season_folder`, `quality_profile`, `series_type`, `path` — see
    [Edit Series Modal](Edit-Series-Modal). API: `GET /api/series`, `POST /api/series`
    (used by Add New — see [Metadata Search](Metadata-Search)), `PATCH /api/series/:id`
    (the header's own Monitored toggle and the
    full Edit Series modal both go through this), `DELETE /api/series/:id` (the Delete
    button on the series detail page, or inside the Edit modal, behind a shared
    confirmation modal). `public/index.html`'s grid and `public/series.html`'s detail
    view both fetch from this instead of holding the data themselves, which is what makes
    a series added via search actually show up in the Library and survive a page reload —
    and what makes deleting one actually stick.
  - `series_tags` — a many-to-many join table (`series_id`, `tag_id`) linking Library
    series to the existing `tags` table, added for the [Edit Series Modal](Edit-Series-Modal)'s
    Tags field. No separate REST surface of its own — it's read/written entirely through
    `series`'s own `PATCH`/`DELETE` (a `tagIds` array in the PATCH body replaces a
    series' full tag set) and through `DELETE /api/tags/:id`, which also cleans up any
    rows referencing the deleted tag.
  - `tags` — bespoke table (name, color); see `GET/POST /api/tags`, `PATCH/DELETE
    /api/tags/:id`. The `count` each tag reports is computed live from `series_tags`
    (`COUNT(*) WHERE tag_id = ?`) rather than trusted from a stored column — before the
    Edit Series modal gave tags an actual relationship to series, `count` was a static
    column that always read 0, since nothing had ever incremented it.
  - `settings_items` — one row per list entry for the list-style Settings pages
    (Indexers, Download Clients, Import Lists, Connect, Profiles, Custom Formats, Root
    Folders, and — as of the [Quality Definitions](Quality-Definitions) redesign — Quality itself)
    Each row stores its fields as a JSON blob tagged with a `section`, so
    differently-shaped sections (a connection has a protocol/priority/status, a root
    folder just has a path) share one table instead of needing one each. API:
    `GET/POST /api/settings-items/:section`, `PATCH/DELETE /api/settings-items/:section/:id`.
    A row's `position` column (display order) is also writable through `PATCH` now — see
    [Quality Definitions](Quality-Definitions) for why.
  - `app_settings` — one JSON blob per page for the field/toggle-style Settings pages
    (Media Management, General, UI, Metadata). Every persistable input/select
    on those pages carries a `data-key` attribute (existing ids like
    `renameEpisodesToggle` were reused as keys; everything else got a positional key
    like `general-3`); `initSettingsForm()` in `app.js` loads the saved object, fills in
    the matching controls, and PATCHes changes back (debounced) as you edit. API:
    `GET/PUT /api/app-settings/:section`.
- `series`, `tags`, and `settings_items` (per-section, so adding a new list section
  later doesn't require reseeding everything already in use) each seed the mockup's
  original placeholder data into themselves the first time they're found completely
  empty — but only when `APP_ENV=demo` (see `.env.example`). `APP_ENV` defaults to
  `production`, under which an empty table just stays empty instead of silently
  repopulating with demo anime/indexers/tags nobody added — the difference matters
  because "the table happens to be empty" isn't only true on a genuinely fresh
  install; it's also true after restoring a backup, recovering from corruption (see
  the incident below), or a deliberate reset, and none of those should come back
  with fake data standing in for whatever was really there. Set `APP_ENV=demo` to get
  the old zero-config "there's already something to click through" behavior back —
  that's for trying the app out or local dev, not a real deployment.
  - Two `settings_items` sections are the deliberate exception: Quality Profiles
    and Quality Tiers seed their defaults regardless of `APP_ENV` (see
    `ALWAYS_SEED_SECTIONS` in `settings-items.js`). They aren't demo library
    content — real features (`guessQualityTierName` in `lib/media-files.js`,
    `resolveQualityProfile`/cutoff-unmet checking) need at least one of each
    configured to do anything at all, so a real production install still gets
    a usable starting point instead of an empty Quality Profile dropdown and
    every downloaded episode's Quality column reading blank.
- Change anything in Settings or the Library, restart the server, and it's still there.

That's the same shape Activity/Wanted (queue, history, blocklist, missing, cutoff unmet)
now use too: a table, a small REST surface, `fetch()` calls instead of an in-file array —
see [Grab / Download Pipeline](Grab-Download-Pipeline). None of this reaches the
frontend either way — `app.js` only ever knows about the `/api/*` endpoints, never how
they're stored, which is what made the dual-database work below a backend-only change.

### Dual-database support: SQLite + Postgres

The original plan here was "ship SQLite as the default so the app works out of the box
with zero setup, then swap the storage layer for a real Postgres container later." That
swap is now built — as a runtime choice (`DB_CLIENT=sqlite|postgres`), not a one-way
migration, so a zero-config local install and a real deployed Postgres install are both
first-class, from the same codebase, with every route behaving identically either way.

- **`server/db.js`** is the only module any route or lib file imports (`require('../db')`
  or `require('./db')`) — it's a thin facade that reads `DB_CLIENT` once at startup and
  dispatches every call to either `server/db-sqlite.js` or `server/db-postgres.js`. No
  route file, anywhere in the codebase, imports `node:sqlite` or `pg` directly.
- Both drivers implement the same shape: `db.prepare(sql).get(...)/.all(...)/.run(...)`
  (all `async`, unlike `node:sqlite`'s originally-synchronous API — see below),
  `db.exec(sql)`, `db.now()` (an explicit current-timestamp value, since the two
  databases don't share a `datetime('now')`/`NOW()` syntax), `db.PK` (the
  dialect-specific auto-increment column fragment for `CREATE TABLE`), and
  `db.tableColumns(table)` (replaces raw `PRAGMA table_info` calls, which Postgres has
  no equivalent for). `db.DB_CLIENT`, `db.DB_PATH` (`null` under Postgres — there's no
  single file), and `db.describe()` (a human-readable "what am I persisting to" string,
  used in the startup log line) let call sites branch on which backend is live when they
  genuinely need to (`server/routes/backups.js` is the one real example — see below).
- `server/db.js` also does the one piece of real SQL translation the two drivers can't
  share: `?`-style placeholders (SQLite's syntax, used everywhere in every route file)
  get rewritten to Postgres's `$1, $2, ...` before a query reaches `pg`, so route code
  never needs two versions of a query string.
- **Table setup and migrations run through a `db.init(fn)` registry** instead of at
  module `require()` time — `server.js` awaits `db.ready()` (which runs every registered
  `fn`, then resolves) before `server.listen()`, so every table exists before the first
  request can arrive, same guarantee as before, just async now. A handful of SQL
  differences meant genuine portable rewrites rather than a find-replace: `COLLATE
  NOCASE` → `LOWER(...)` comparisons, `INSERT OR IGNORE` → `INSERT ... ON CONFLICT (...)
  DO NOTHING`, `lastInsertRowid` → `INSERT ... RETURNING *` followed by `.get()`, and
  `datetime('now')` as a SQL-level column default → removed from every `CREATE TABLE`,
  with `db.now()` passed as an explicit parameter at insert time instead (a `DEFAULT`
  clause needs different syntax per dialect; passing the value explicitly sidesteps that
  entirely).
- **`node:sqlite` is synchronous; `pg` is async-only** — so making Postgres a real option
  meant converting essentially every database call site across the whole `server/`
  directory (~240 of them, every route file and several lib files) to `async`/`await`,
  while keeping every endpoint's request/response contract byte-for-byte identical — the
  frontend was explicitly out of scope for this change and never needed to. The one
  recurring wrinkle: a few places built a result by `.filter()`ing or `.sort()`ing rows
  against an async lookup (e.g. cutoff-unmet filtering in `wanted.js`, batch-grab
  candidate filtering in `queue.js`, release ranking in `quality.js`) — `Array.prototype`
  callbacks can't be `async` themselves, so those precompute the async values first with
  `Promise.all(...)`, then run the synchronous `.filter()`/`.sort()` against the
  precomputed array.
- **Postgres returns `BIGINT`/`NUMERIC` columns as JavaScript strings by default** (`pg`'s
  own documented behavior, to avoid silently losing precision on huge numbers) — which
  would otherwise silently break every `COUNT(*) AS n`-style query compared with `=== 0`
  or used arithmetically (seed-data gating in `series.js`/`tags.js`, user/admin counts in
  `auth.js`, dashboard counts in `system.js`, and others). Fixed once, at the driver
  level, in `server/db-postgres.js` via `pg.types.setTypeParser(20, ...)` (int8/bigint →
  `parseInt`) and `setTypeParser(1700, ...)` (numeric/decimal → `parseFloat`), rather than
  patching every call site individually.
- **Backups** (`server/routes/backups.js`, "Backup Now" on System > Backup) branch on
  `DB_CLIENT`: under SQLite it still just gzips the live `db.DB_PATH` file directly; under
  Postgres there's no single file to gzip, so it shells out to the real `pg_dump` CLI
  (`--format=plain`, using the same `DB_HOST`/`DB_PORT`/`DB_USER`/`DB_PASSWORD`/`DB_SSL`
  vars the app itself connects with) and gzips its output instead — a genuinely
  restorable `psql < dump.sql`-shaped file either way, not an opaque binary. This is the
  one feature with an extra real prerequisite: `pg_dump` has to actually be installed and
  on `PATH` (a version compatible with the target server) wherever the app runs under
  `DB_CLIENT=postgres`.
- Both paths were verified end-to-end in this pass: a fresh `DB_CLIENT=sqlite` run
  (table creation, migrations, all default seeding, full CRUD across series/tags/queue,
  auth setup) and a fresh `DB_CLIENT=postgres` run against a real local Postgres 16
  server (same migrations and seeding, the same CRUD sweep, and a real `pg_dump`-backed
  backup downloaded and confirmed to be a valid, restorable SQL dump) — both came back
  with zero errors across the whole session.

### Real incident: database corruption, and WAL mode

`npm start` failed on a real machine with `Error: database disk image is malformed`
(`ERR_SQLITE_ERROR`, `errcode: 11`) thrown from `logger.js`'s very first startup log line —
the database wouldn't even open cleanly enough to log that the server had started.
`PRAGMA integrity_check` against the real `data/kitsune.db` confirmed genuine corruption:
freelist bookkeeping damage (`Freelist: freelist leaf count too big`, an invalid page
number, a page referenced twice) — not a hypothetical, a real corrupted file.

**Root cause, plainly:** this database had no journal-mode hardening at all (SQLite's
default rollback-journal mode), and this same file had just been through an unusually
heavy volume of direct write access during development — many short-lived Node processes
each opening their own `DatabaseSync` connection straight against the live file to insert
and clean up test rows while verifying features throughout this session, over a mounted
filesystem bridging a sandbox to the real machine. Rollback-journal mode depends on the
underlying filesystem correctly honoring POSIX advisory locks to stay safe under
concurrent/overlapping access; a bridged/virtualized mount is a common way for that
guarantee to quietly not hold, and an interrupted or overlapping write is exactly the
kind of event that corrupts a rollback-journal-mode SQLite file. This is the likely
trigger, stated directly rather than glossed over — not a mystery hardware fault.

**Recovery:** the corruption was confined to the freelist (SQLite's own unused-page
bookkeeping) — every table's actual data was still fully readable directly (`SELECT *`
against all 14 real tables succeeded, row counts intact: 1150 episodes, 19 series, 504
logs, etc.). Recovered by reading the full schema and every row straight out of the
damaged file and rewriting them into a brand-new SQLite file (a fresh file has its own
clean freelist, so this discards the corruption rather than trying to repair it in place)
— confirmed identical row counts per table before and after, then `PRAGMA
integrity_check` on the rebuilt file came back `ok`. The original corrupted file was kept,
not deleted, as `data/kitsune.db.corrupted-<timestamp>`, in case anything needed
double-checking against it later. One stray table, `series_test_marker` (`x INTEGER`, 0
rows) — confirmed via a full-codebase search to not be referenced anywhere, a leftover
from an earlier ad-hoc test against this same live database that never got cleaned up —
was dropped during the rebuild rather than carried forward.

**Hardening:** `server/db.js` now sets `PRAGMA journal_mode = WAL;` right after opening
the connection. WAL handles concurrent/overlapping access far more gracefully than the
default rollback-journal mode, and is the standard low-cost mitigation for this exact
failure mode — it doesn't make corruption impossible (nothing does, on a filesystem that
truly doesn't honor locks), but there was no good reason to be running without it.
Verified the app starts clean against the rebuilt+WAL-enabled database (a real
`node server.js` run, not just a syntax check) and that `journal_mode` actually reads
back as `wal`, not just requested.

## Logging

`public/system-logs.html` used to show nine hardcoded log rows that never changed.
There's now a real logger in `server.js`, and that page shows what it's actually
recorded.

- Every log call (`logDebug`/`logInfo`/`logWarn`/`logError` in `server.js`, all thin
  wrappers around one `log(level, logger, message)` function) does two things: prints a
  consistent `[timestamp] LEVEL [logger] message` line to this terminal, and writes a
  row to a `logs` table in the same SQLite database as everything else — that table is
  created before any other table, since the seed steps for Tags/Settings/Library log
  through it too.
- Kept to the newest 500 rows (pruned on every write) so a long-running server doesn't
  grow this file forever.
- What actually gets logged: server startup, database seeding/migrations, every HTTP
  request (method, path, status, duration — at `debug` level, so routine page-load
  traffic doesn't clutter the default view but is there if you filter down to it), tag
  and settings-item create/delete, series added/deleted/monitored-toggled, and the full
  MyAnimeList retry → TheTVDB fallback sequence from a search (attempt failures at
  `warn`, final failures at `error`) — the same events that were being manually
  `console.error`'d one-off during earlier debugging are now going through this
  consistently instead.
- API: `GET /api/logs?level=all|debug|info|warn|error&limit=N` (default limit 200, capped
  at 500), newest first. Filtering by level happens in the SQL query, not client-side.
- `public/system-logs.html`'s level tabs (All/Info/Warn/Error/Debug) call this with the
  matching `level`, and the page polls every 4 seconds so it reads like a live tail
  without needing a websocket for what's ultimately a personal dev tool.
- The "Log Files" card further down that same page (rotated `.txt` files with download
  buttons) is still a static mockup — this pass covers structured logging into the
  database and the log table itself, not writing to and rotating actual files on disk.


---

[← Back to Home](Home)
