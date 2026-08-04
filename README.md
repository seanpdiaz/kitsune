# Kitsune UI mockup

A click-through mockup of the Kitsune Library dashboard, Series detail, Settings, and
System screens. Pure Node (no Express, no build step, no npm dependencies — the one
exception is SQLite, which comes built into Node itself) so it runs anywhere Node 22.5+
runs.

## Run it

```
node server.js
```

Then open http://localhost:3000

## What's here

- `public/index.html` — Library dashboard (left nav, stats, series grid with working
  search/filter/sort, backed by SQLite — see Persistence below)
- `public/series.html` — Series detail (segment tabs demonstrating the named-arc /
  official-part / sequential-season fallback rule, episode list with status states)
- `public/library-add-new.html`, `public/library-import.html` — Library sub-pages: search
  (live, via MyAnimeList — see Metadata search below) and add new series, and scan real
  root folders for subdirectories not yet in the Library (see Root folders + Library
  Import below)
- `public/activity-queue.html`, `public/activity-history.html`,
  `public/activity-blocklist.html` — Activity sub-pages: live download queue
  (pause/resume/remove), filterable history feed, blocklisted releases
- `public/wanted-missing.html`, `public/wanted-cutoff-unmet.html` — Wanted sub-pages:
  aired-but-missing episodes and episodes below their quality cutoff, both with working
  Search / Search All
- `public/settings-*.html` — the full Settings section (Media Management, Profiles,
  Quality, Custom Formats, Indexers, Download Clients, Import Lists, Connect, Metadata,
  Tags, General, UI)
- `public/system-*.html` — the System section (Status, Tasks, Backup, Updates, Events,
  Logs — Logs is real, showing live server activity; see Logging below)
- `public/styles.css` — design tokens (colors, type, spacing) and component styles
- `public/app.js` — all page behavior: series grid/episode list rendering, sidebar
  accordion (Library/Activity/Wanted/Settings/System sub-menus, one open at a time), the
  reusable connection-manager pattern used by Indexers/Download Clients/Import
  Lists/Connect, the Queue/History/Blocklist/Missing/Cutoff Unmet list behaviors, and the
  Tags section (see Persistence below)
- `server.js` — static file server, the settings/tags/series/logs REST endpoints, the
  MyAnimeList/TheTVDB search proxies, and per-episode data fetching (see Metadata search
  below)

Settings and the Library (series data) are now backed by SQLite. Activity/Wanted pages
(queue, history, blocklist, missing, cutoff unmet) are still in-file arrays in `app.js`,
the same mockup-only state as before — Tags was the original proof of concept for this
pattern, Settings was migrated next, and Library most recently (see Persistence below).

## Persistence

- Backing store: SQLite via Node's built-in `node:sqlite` module (stable since Node
  22.5 — no npm package needed, so the project stays dependency-free).
- File lives at `data/kitsune.db`, created automatically on first run.
- Four tables cover all of it:
  - `series` — the Library. One row per series (title, poster, episode count, monitored,
    status, etc). API: `GET /api/series`, `POST /api/series` (used by Add New — see
    Metadata search below), `PATCH /api/series/:id` (currently just the Monitored
    toggle on the series detail page), `DELETE /api/series/:id` (the Delete button on
    the series detail page, behind a confirmation modal). `public/index.html`'s grid and
    `public/series.html`'s detail view both fetch from this instead of holding the data
    themselves, which is what makes a series added via search actually show up in the
    Library and survive a page reload — and what makes deleting one actually stick.
  - `tags` — bespoke table (name, color, usage count); see `GET/POST /api/tags`,
    `PATCH/DELETE /api/tags/:id`.
  - `settings_items` — one row per list entry for the list-style Settings pages
    (Indexers, Download Clients, Import Lists, Connect, Profiles, Custom Formats, Root
    Folders). Each row stores its fields as a JSON blob tagged with a `section`, so
    differently-shaped sections (a connection has a protocol/priority/status, a root
    folder just has a path) share one table instead of needing one each. API:
    `GET/POST /api/settings-items/:section`, `PATCH/DELETE /api/settings-items/:section/:id`.
  - `app_settings` — one JSON blob per page for the field/toggle-style Settings pages
    (Media Management, General, UI, Metadata, Quality). Every persistable input/select
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

To carry this pattern to Activity/Wanted next, the shape to repeat is the same one
`series`/`settings_items` already use: a table, a small REST surface, and swap that
section's in-file array in `app.js` for `fetch()` calls.

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

## Metadata search (MyAnimeList) + real episode data (TheTVDB)

`public/library-add-new.html` ("Add New") searches MyAnimeList live instead of a
hardcoded list of candidates — type a title, get back real posters, years, and
overviews. Once a series is added, the series detail page's episode list shows real
episode titles and air dates instead of generic "Episode N" placeholders.

Two separate integrations cover this — search and episodes deliberately use
*different* sources:

- **Search** goes through the **official MyAnimeList API v2**
  (`https://api.myanimelist.net/v2`), authenticated with a free Client ID from
  [myanimelist.net/apiconfig](https://myanimelist.net/apiconfig) sent as an
  `X-MAL-CLIENT-ID` header (the simple `client_auth` scheme — no OAuth login flow
  needed for read-only search). Set `MAL_CLIENT_ID` in `.env`.
- **Episodes** come from **TheTVDB** (the same client used for the search fallback
  below), because the official MAL API has no episodes endpoint at all — only a
  `num_episodes` count, never per-episode titles or air dates.

This used to run on [Jikan](https://jikan.moe), a free, unofficial MyAnimeList wrapper,
for both a search fallback and all episode fetching — it's been removed from the
project entirely. Its endpoints have to live-scrape MyAnimeList's own site rather than
serving from cache, and that hop failed intermittently on both search and episodes badly
enough to be worth dropping rather than working around again. TheTVDB is a real,
documented REST API rather than something scraping another site live, so it doesn't
share that failure mode.

### Search

- The frontend calls our own `GET /api/mal/search?q=...`; `server.js`'s `handleMalApi`
  proxies to the official API's `/anime?q=...` and maps the response down to
  `{ id, title, year, overview, poster, source }[]` — preferring
  `alternative_titles.en` over the (often romanized) default title.
- Search is debounced (400ms) and race-safe — if you keep typing, only the latest
  query's results ever render.
- **NSFW titles:** the official API silently excludes NSFW/ecchi-flagged titles (e.g.
  "Yosuga no Sora") from search results by default — a clean 200 with zero matches,
  not an error, so there's nothing to retry or catch. `fetchMalSearchOnce` sends
  `nsfw=true` on every search to get the whole catalog back.
- **Retry + fallback (two tiers):** `handleMalApi` retries a failed official-API search
  up to 3 times with backoff (500ms, then 1.5s) — skipped on a 429 (retrying into a rate
  limit only makes it worse) or when `MAL_CLIENT_ID` isn't configured at all (nothing to
  retry). If it's still unreachable after that, search falls back to TheTVDB, filtered
  to results whose `genres` array contains `"Anime"` (TVDB has no genre filter on
  `/search` itself — see below — so the filtering happens here, after the fact).
  Fallback results carry `source: 'tvdb'`, and the Add New card shows a small "via
  TheTVDB (MAL unavailable)" note so it's clear when you're seeing fallback data instead
  of silently different results. A genuinely-empty result from the official API (a real
  "nothing matches this query") is returned as a normal empty list, not an error — only
  an actual failure triggers the TVDB fallback.
- Clicking "Add Series" does a real `POST /api/series` with the result's title, year,
  overview, poster, id, and source — the series is created in the `series` table
  (`id`/`source` land in `external_id`/`external_source` columns) and shows up in the
  Library immediately (see Persistence above). Everything the search result doesn't
  give us (episode count, genres, airing status) gets a sensible "just added" default
  rather than being guessed at.
- **Duplicate prevention:** `POST /api/series` rejects (409) an add that matches an
  existing series either by exact `(external_id, external_source)` — the same search
  result added twice — or by normalized title (reusing `normalizeFolderName` from the
  Root folders section below), which also catches the same show showing up again under
  a *different* id, e.g. added once via the official MAL API and later found again
  through the TVDB fallback. This is the real enforcement; the UI layer described next
  is just what keeps you from hitting it in the first place. Before this, nothing
  stopped a title from being added to the Library twice, including via a folder in
  Library Import that already had a matching series — since Library Import's own
  matching is comparing folder names against Library titles, and had no reason to know
  the exact search result you'd click next was the same show under a different id.
- Add New itself now knows what's already in the Library: it loads the current Library
  once per page visit and cross-checks every search result against it (again, both by
  exact id and by title), so a result that's already been added renders "In Library"
  instead of a clickable "Add Series" button — no click, no request, no chance to
  duplicate it from that page. If two tabs (or a stale page + a fresh add elsewhere)
  race and the pre-check misses it anyway, the 409 from the server above is caught and
  the card flips to "In Library" instead of showing a raw error.
- **Preview modal:** each result card has a "Preview" button alongside "Add Series"
  that opens a details modal — larger poster, full (non-truncated) overview, and
  whatever of episode count, score, genres, media type, airing status, studio, and
  Japanese/synonym alternative titles the result actually has. This was the direct
  answer to "there are quite a few results for one search and no way to see more about
  any of them before adding" — MAL's search `fields` request was expanded
  (`mean,genres,media_type,status,studios`, plus already-fetched
  `alternative_titles`/`num_episodes`) to carry this without a second request per card.
  The modal has its own Add Series button wired through the same `addSeries()` path the
  card button uses, and reflects the same "already in Library" / "Added" state.
  TVDB-fallback results only carry a poster/title/year/overview/genres (TVDB's search
  index doesn't have episode counts, scores, or studios) — the modal just omits
  whatever a given result doesn't have rather than showing empty fields.

### Episodes

- `GET /api/series/:id/episodes` resolves a TVDB series id for the given series
  (`resolveTvdbEpisodeSourceId`), fetches its full episode list from
  `/series/:id/episodes/default` (paginated, walked until a page comes back empty),
  caches it in an `episodes` table, and returns it. Repeat requests are served straight
  from that cache — no re-fetch on every page load.
- **Seasons/specials:** TVDB's "default" season type response mixes every season
  together in one flat array — specials as season 0, then season 1, season 2, etc. —
  and each season's episode `number` restarts at 1, so a special and a season-1 episode
  can both be "episode 1". `fetchTvdbEpisodes` captures each episode's `seasonNumber`/
  `seasonName` (both stored in `episodes`, whose uniqueness is `(series_id,
  season_number, num)`, not just `num`), and the series detail page groups them into
  dynamic segment tabs (Specials first, then ascending seasons, defaulting to the
  latest season) instead of one flat, interleaved list — the same segment-tabs UI the
  hand-built Frieren demo uses, just built from whatever seasons a given series
  actually has (`groupEpisodesBySeason`/`renderSegmentedRealEpisodes` in `app.js`). A
  series with only one season just renders flat, tabs hidden, same as before.
- Because search and episodes are two unrelated catalogs (MyAnimeList ids and TVDB ids
  don't correspond to each other), a MAL-added series has no TVDB id to start with.
  Resolving one means searching TVDB for the series' own title (the same anime-filtered
  search the search fallback uses) and taking the first match — the result is cached on
  the series row (`tvdb_episode_id`) so that search only ever runs once per series. A
  series originally added via the TVDB search fallback already has a usable TVDB id and
  skips this step entirely. Because this is resolved by title rather than tied to how a
  series was added, it works for *any* series — including the 21 originally-seeded
  titles, which can now get real episodes too, not just ones added through Add New.
- The tradeoff of resolving by title: it can occasionally match the wrong show if
  TVDB's title search is ambiguous (a remake, a same-named live-action series, etc.) —
  there's no perfect fix for that without an id crossing over some other way. If a
  series ever gets the wrong episode list, deleting its cached rows from the `episodes`
  table and re-fetching is the way to retry the match.
- **English titles:** TVDB's base episode record (`name`) is whatever language that
  series' entry defaults to on TVDB — for anime that's frequently Japanese, same issue
  the search results had before English was preferred there (see TheTVDB section
  below). Unlike search results, episode records don't carry translated text inline —
  getting it means a separate `GET /episodes/:id/translations/eng` request per episode.
  `fetchTvdbEpisodes` does this for every episode it fetches (`mapWithConcurrency`, 4 at
  a time, so a 25-episode season doesn't serialize into 25 sequential round trips), and
  only overwrites the base title when TVDB actually has an English translation for that
  specific episode — if it doesn't (a 404, or any other failure), that one episode just
  keeps its native-language title rather than the whole batch failing. This only runs
  once per series thanks to the episode cache, so the extra requests are a one-time cost
  at first fetch, not something that happens on every page load.
- TVDB's episode records have no equivalent of MAL's per-episode score or filler/recap
  flags — those fields are just left blank for TVDB-sourced episodes, and the UI's
  score/filler/recap badges simply don't render for them.
- A series with no resolvable TVDB match, or a TVDB episode fetch that itself fails,
  gets back an empty episode list rather than an error — the series detail page just
  falls back to its synthetic "Episode N" list, same as before this feature existed.
- Download state (done / missing / downloading / not-aired-yet) still isn't something
  any metadata source knows about — the episode list's *state* per row is still worked
  out locally from the series' "downloaded / total" eps count. What's different is that
  the *title* and *air date* on each row are the real ones when available, instead of
  "Episode N" and a placeholder date.
- This was built and tested against local mocks of the official MAL API and TheTVDB
  (this sandbox can't reliably reach either live), so give the real thing — search, add,
  and opening a series' detail page — a try once you're running the app on your own
  machine with a real `MAL_CLIENT_ID` and `TVDB_API_KEY` in `.env`.

### TheTVDB (search fallback + the episode source)

Add New used to search TheTVDB directly, but its `/search` endpoint returns any kind of
TV series, not just anime, which polluted results with non-anime noise — that's why MAL
is primary for search. TVDB is still fully wired up (`handleTvdbApi`, `tvdbLogin`,
`tvdbFetch`, plus its own standalone `GET /api/tvdb/search?q=...` endpoint, unfiltered),
doubles as the automatic search fallback when MAL is down via `tvdbSearchAnimeOnly` (a
genre filter applied before results are returned), and — as of this pass — is also the
only source of real episode data, for every series regardless of how it was added.

That filter is deliberately permissive: it only *excludes* a result when TVDB's
`/search` response includes a populated `genres` array that doesn't contain `"Anime"` —
a confirmed non-match. Missing or empty `genres` is treated as "unknown" and kept in,
rather than excluded. This matters because TVDB's lightweight `/search` index often
doesn't carry genre data at all for a given title (that tends to live on the full series
record instead), even when the title genuinely is tagged Anime on its own page — an
earlier, stricter "must explicitly include Anime" version of this filter was silently
dropping real matches whenever `genres` came back empty, which made the fallback look
like it wasn't firing at all. `tvdbSearchAnimeOnly` logs the raw genre data it saw for
every fallback search (`TVDB fallback: N raw result(s), M after genre filter | genres
seen: [...]`), so a similar issue is diagnosable from the terminal without guessing.

TVDB's API has no server-side genre filter to ask for this directly in the first place
(confirmed against their OpenAPI spec — `/search` only supports `query`, `type`, `year`,
`company`, `country`, `director`, `language`, `primaryType`, `network`, `remote_id`), so
this filtering depends on TheTVDB's community genre tagging being complete for a given
title — usually is, but not guaranteed.

## Root folders + Library Import (real filesystem)

Root Folders (Settings > Media Management) and Library Import used to both be fake:
root folders were arbitrary `/anime/new-folder-N` strings created by clicking a button,
and Library Import showed five hardcoded candidate rows that never changed no matter
what was actually on disk. Both now read the real filesystem of the machine running
`server.js`.

- **Adding a root folder** opens a File Browser modal (matching real Sonarr's own "Add
  Root Folder" UI) instead of a text field: it starts at the real filesystem root
  (`/` on Linux/macOS, `C:\` on Windows) and lets you click into real subdirectories or
  type a path directly, backed by `GET /api/fs/browse?path=...` in `server.js` — plain
  `fs.readdirSync`, directories only, dotfiles/dot-directories hidden. Clicking "Ok"
  calls `POST /api/root-folders`, which validates the path is a real, readable directory
  (`fs.statSync`) before adding it, rejects a path that's already a root folder (409),
  and computes real numbers instead of placeholders: free space via `fs.statfsSync`
  (available since Node 18.15, already below this project's Node 22.5+ floor) and an
  "unmapped" count — how many of that folder's real subdirectories don't already match a
  Library series title.
- **Library Import** scans every configured root folder for real subdirectories
  (`GET /api/root-folders/:id/subfolders`) and shows exactly two states per folder:
  already matching a Library series title ("Already in Library"), or not ("Search" —
  see below). There's deliberately no third "auto-matched, ready to one-click import"
  state — Kitsune doesn't try to guess a MAL match from a folder name and silently
  import against that guess, only flag whether the name already lines up with something
  already in the Library. A "Rescan" button re-runs the scan on demand rather than
  polling.
- **Folder-name matching** (`stripReleaseNoise`/`normalizeFolderName` in `server.js`)
  strips the release-tag noise real folder names carry — bracketed/parenthesized tags,
  dots/underscores, release years, `S01E01`-style markers, common quality/source tags
  (1080p, BluRay, x264, etc.) — then compares what's left, case- and
  punctuation-insensitive, against Library titles. This is an exact match on the cleaned
  name, not fuzzy matching, so `Vinland.Saga.S02.1080p` matches a Library series titled
  "Vinland Saga" but `Frieren.Beyond.Journeys.End.S01` won't match one titled just
  "Frieren" — the cleaned names aren't equal. `guessTitleFromFolderName` keeps the same
  cleaned text in human-readable form (not lowercased) for the next bullet.
- Clicking "Search" next to an unmatched folder goes to Add New with that guessed title
  pre-filled and searched automatically (`library-add-new.html?q=...` — `initAddNew`
  reads `?q=` on load, fills the search box, and runs the search immediately), so adding
  a folder that's genuinely on disk but not yet in the Library is a two-click path
  (Search → Add Series) instead of retyping the title by hand.
- Verified against a synthetic directory tree in the sandbox (a real server, a real
  root folder add, browsing/navigating including hidden-file and non-directory
  exclusion, duplicate-path rejection, a scan matching one folder and leaving two
  unmatched, and the Search-link pre-fill actually landing a query on Add New) — all
  passing. Not yet tried against a real multi-thousand-folder media library, so a very
  large root folder's first `unmapped` computation (one `readdirSync` plus a title
  comparison per entry) hasn't been checked for how it performs at that scale.
