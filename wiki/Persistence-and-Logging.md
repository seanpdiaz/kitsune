# Persistence and Logging

## Persistence

- Backing store: SQLite via Node's built-in `node:sqlite` module (stable since Node
  22.5 — no npm package needed, so the project stays dependency-free).
- File lives at `data/kitsune.db`, created automatically on first run.
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
- All four tables seed themselves with the mockup's original placeholder data on first
  run (per-section for `settings_items`, so adding a new list section later doesn't
  require reseeding everything; `series` seeds the original 21-title library), so
  nothing looks empty on a fresh install.
- Change anything in Settings or the Library, restart the server, and it's still there.

The plan discussed alongside this: ship SQLite as the default so the app works out of
the box with zero setup, then swap the storage layer for a real Postgres/MySQL
container later without touching the frontend — `app.js` only knows about the
`/api/*` endpoints, not how they're stored. When that migration happens, only the DB
calls inside `server.js` need to change.

That's the same shape Activity/Wanted (queue, history, blocklist, missing, cutoff unmet)
now use too: a table, a small REST surface, `fetch()` calls instead of an in-file array —
see [Grab / Download Pipeline](Grab-Download-Pipeline).

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
