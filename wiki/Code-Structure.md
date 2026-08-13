# Code Structure

## Code structure

`server.js` and `public/app.js` started as single files and grew past ~1,900 and ~2,600
lines respectively as features were added — this section covers the split into
per-feature files that happened once that got unwieldy. This was a pure reorganization:
no endpoint, route, or page behavior changed, only where the code that implements it
lives.

### `server/` (CommonJS — unchanged `require`/`module.exports`, no `package.json` changes)

- `server/env.js` — `.env` file loading.
- `server/db.js` — the `DatabaseSync` instance and `DB_PATH`, shared by everything else.
- `server/logger.js` — `logDebug`/`logInfo`/`logWarn`/`logError` and the `logs` table
  (see [Persistence and Logging](Persistence-and-Logging)).
- `server/lib/` — code with no HTTP handler of its own, used by multiple routes:
  `http.js` (`sendJson`/`readJsonBody`), `util.js` (`sleep`), `fs-helpers.js`
  (folder-name matching, free-space stats — see
  [Root Folders and Library Import](Root-Folders-and-Library-Import)), `tvdb.js` (TheTVDB
  client), `mal.js` (MyAnimeList client) — see [Metadata Search](Metadata-Search) for both.
- `server/routes/` — one file per REST resource, each exporting its `handle*Api`
  function(s): `tags.js`, `settings-items.js`, `app-settings.js`, `fs-browse.js`,
  `root-folders.js`, `series.js`, `episodes.js`, `calendar.js`, `logs.js`,
  `tvdb-search.js`, `mal-search.js`, `queue.js`, `history.js`, `blocklist.js`,
  `releases.js`, `wanted.js`, `system.js` (the last six are the grab/download pipeline —
  see [Grab / Download Pipeline](Grab-Download-Pipeline)).
- `server.js` (project root) is now a ~110-line entry point: it requires every module
  above, assembles the same request-dispatch chain and static-file fallback the original
  single file had, and calls `server.listen()`. Route modules each create their own table
  (`CREATE TABLE IF NOT EXISTS ...`) at `require()` time; since every module is required
  before `server.listen()` runs, all tables exist before any request can arrive
  regardless of require order.

### `public/js/` (native ES modules — `<script type="module">`, no bundler)

- `public/js/lib/` — shared, page-agnostic code: `icons.js` (inline SVG strings +
  `escapeAttr`), `colors.js` (tag color helpers), `file-browser-modal.js` (the reusable
  modal from [Root Folders and Library Import](Root-Folders-and-Library-Import)/
  [Edit Series Modal](Edit-Series-Modal)), `dates.js` (`formatAirDate`/`timeAgo`),
  `format.js` (`formatBytes`), `release-picker-modal.js` (the Search/Search All release
  picker — see [Grab / Download Pipeline](Grab-Download-Pipeline)).
- `public/js/nav.js` — sidebar collapse + accordion, used on every page.
- `public/js/pages/` — one file per page (or per closely-related pair, like
  `wanted-missing.js`/`wanted-cutoff-unmet.js`), each importing only what it uses from
  `lib/`. `library.js` is the largest, covering both the Library grid and the series
  detail page (episode list, Edit Series modal, delete flow).
- `public/app.js` is now just a list of `import` statements (one per module above, in the
  original single-file's section order) — the actual page logic runs as a side effect of
  each import, same as it did inline before.
- All 28 `public/*.html` files load it as `<script type="module" src="app.js"></script>`
  instead of a plain `<script src="app.js">`, since native `import`/`export` requires the
  module type.

### Sidebar: one render function instead of 28 copies

Splitting `app.js` into per-feature files (above) didn't touch a different kind
of duplication: every one of the 28 `public/*.html` pages carried its own copy
of the same ~72-line `<aside id="sidebar">...</aside>` block — over half of
this project's total HTML (close to 2,000 of ~4,000 lines) was that one block,
repeated, differing only in which nav-item/nav-sub carried the `active`/`open`
classes for that particular page. It's also why nav changes kept needing a
"sweep across all N pages" (see [Sidebar Navigation](Sidebar-Navigation), and
[Persistence and Logging](Persistence-and-Logging)'s `settings_items` note about the same instinct applied to data) —
each one a chance to update 27 of the 28 correctly and miss the 28th.

- `public/js/nav.js` now owns the sidebar entirely: a `NAV_SECTIONS` config
  array (label, icon, href, and each section's sub-links) is the single source
  of truth for what the sidebar contains, and `renderSidebar()` builds the
  markup from it and injects it into `<aside id="sidebar"></aside>` — every
  page's own HTML now just has that one empty tag instead of the full block.
- **Which item is active is computed, not hardcoded:** `renderSidebar()` reads
  `location.pathname` for the current page's filename and marks whichever
  section (and, for sections with sub-links, whichever specific sub-link)
  matches — a page no longer has to know or declare its own position in the
  nav; adding a new page under an existing section just means adding one entry
  to `NAV_SECTIONS`, not touching any HTML file at all.
- `series.html` isn't itself one of the sidebar's link targets (it's reached by
  clicking into a series from the Library grid), so nothing in `NAV_SECTIONS`
  matches its filename and no nav-item highlights when it's the current page —
  the same behavior the hardcoded markup had before this change, preserved
  deliberately rather than "fixed," since this was a reorganization, not a
  behavior change.
- The existing collapse-toggle and Settings/System accordion behavior in
  `nav.js` is unchanged, just reordered to run after `renderSidebar()` instead
  of assuming the sidebar's DOM already existed from the page's own HTML.
- Verified the same way as the `app.js` split above: each of the 28 pages
  loaded in its own fresh Node process (asserting the sidebar renders with
  exactly the active section/sub-link each page used to hardcode, plus the
  collapse toggle and both accordion toggles are present), and the full
  behavioral suite from the `app.js`-split verification re-run against the new
  nav to confirm nothing downstream of it broke. All 28 passed both.

The horizontal `.page-tabs` strip at the top of Settings (12 pages), System
(6), Activity (3), Wanted (2), and the two Library sub-pages had the exact
same problem one level down — 26 of the 28 pages hardcoded that section's
sub-links a *second* time (~249 lines total), separately from the sidebar's
own copy of the same links. Since it's the identical data, `renderPageTabs()`
in `nav.js` builds it directly from the same `NAV_SECTIONS` config the sidebar
already uses — no second list to keep in sync. Each page keeps an empty
`<div class="page-tabs"></div>` placeholder in the same spot the full block
used to sit (`renderPageTabs()` no-ops if that container isn't on the page at
all, which is why `index.html`/`series.html`/`calendar.html` — the three pages
that never had this strip — stay untouched). Verified the same way: all 28
pages checked in isolated processes for the right tab labels, hrefs, and
active state, plus the full page-behavior suite re-run to confirm nothing else
regressed.

### Verifying the split didn't change behavior

Both halves were checked against the pre-split behavior rather than just "does it start
without errors":

- **Server:** booted the modular version and swept every endpoint (tags, settings-items,
  app-settings, fs-browse, root-folders, series, episodes, calendar, logs, static files,
  404s) plus a full add-a-series flow against local MAL/TVDB mocks (search, synopsis
  cleanup, background episode warming) — all matched the pre-split server.
- **Frontend:** `node --check` (via a temporary `.mjs` copy, since these files keep the
  `.js` extension but use ES module syntax) on every new file confirmed they all parse.
  Runtime behavior needed more than that — jsdom doesn't execute
  `<script type="module">` at all in this sandbox, so the real check loads each of the 28
  pages in its own separate Node process (Node's ES module cache is keyed by resolved
  file path and persists for the life of a process, so testing multiple simulated "page
  loads" in one long-running process was silently reusing already-evaluated modules
  after the first page — a real browser gives every navigation a fresh module graph, so
  one process per page is what actually matches that) and asserts on real rendered
  output: the Library grid, series detail title + Edit Series modal open/prefill/Quality
  Profile populate, the Calendar's 42-cell grid, Tags page chip rendering, Indexers list
  rows, and both Wanted pages' row rendering. All 28 passed.


---

[← Back to Home](Home)
