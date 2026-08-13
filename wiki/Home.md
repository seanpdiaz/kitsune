# Kitsune

A click-through mockup of the Kitsune Library dashboard, Series detail, Settings, and
System screens. The backend is pure Node (no Express, no npm dependencies of its own —
the one exception is SQLite, which comes built into Node itself) so it runs anywhere Node
22.5+ runs. The frontend is migrating page by page from plain JS to React (see
[React Migration](React-Migration)) — that part does have a real build step and real npm
dependencies now, though only for the pages that have actually migrated so far;
`server.js` itself is completely unaffected either way.

This wiki is the project's full technical write-up — previously one very long `README.md`,
split here into topic pages so it's actually browsable. Pages are grouped by feature area;
within a page, content still reads roughly in the order it was built, so a page's later
sections sometimes revise or extend its earlier ones.

## Run it

```
npm install
npm run build   # compiles whichever pages have migrated to React so far into public/dist/
node server.js
```

Then open http://localhost:3000

`npm run build` only needs to be re-run when something under `frontend/` changes — plain
JS pages under `public/` still take effect on the next browser reload with no build step,
exactly as before. `npm run dev:frontend` runs the same build in watch mode if you're
actively editing a migrated page's React source.

## What's here

- `public/index.html` — Library dashboard (left nav, stats, series grid with working
  search/filter/sort, backed by SQLite — see [Persistence and Logging](Persistence-and-Logging))
- `public/series.html` — Series detail (segment tabs demonstrating the named-arc /
  official-part / sequential-season fallback rule, episode list with status states, and
  an Edit Series modal — see [Edit Series Modal](Edit-Series-Modal) and
  [Series Detail Page Features](Series-Detail-Features))
- `public/library-add-new.html`, `public/library-import.html` — Library sub-pages: search
  (live, via MyAnimeList — see [Metadata Search](Metadata-Search)) and add new series, and
  scan real root folders for subdirectories not yet in the Library (see
  [Root Folders and Library Import](Root-Folders-and-Library-Import))
- `public/activity-queue.html`, `public/activity-history.html`,
  `public/activity-blocklist.html` — Activity sub-pages: live download queue
  (pause/resume/remove), filterable history feed, blocklisted releases — all backed by a
  real simulated grab/download pipeline now, see [Grab / Download Pipeline](Grab-Download-Pipeline)
- `public/wanted-missing.html`, `public/wanted-cutoff-unmet.html` — Wanted sub-pages:
  aired-but-missing episodes and episodes below their quality cutoff, both with working
  Search / Search All (real grabs — see [Grab / Download Pipeline](Grab-Download-Pipeline))
- `public/calendar.html` — a real month-grid calendar of episode air dates, pulled from
  whatever's already cached in the `episodes` table (see [Calendar](Calendar))
- `public/settings-*.html` — the full Settings section (Media Management, Profiles,
  Quality, Custom Formats, Indexers, Download Clients, Import Lists, Connect, Metadata,
  Tags, General, UI, Users)
- `public/login.html`, `public/account.html` — sign-in/first-run setup and self-service
  account management, see [User Accounts](User-Accounts)
- `public/system-*.html` — the System section (Status, Tasks, Backup, Updates, Events,
  Logs — Logs is real, showing live server activity, see
  [Persistence and Logging](Persistence-and-Logging); Status' Info and Disk Space cards
  are also real, see [Disk Usage](Disk-Usage))
- `public/styles.css` — design tokens (colors, type, spacing) and component styles
- `public/app.js` — a thin entry point that just `import`s every feature module in
  `public/js/` (see [Code Structure](Code-Structure)); all remaining un-migrated page
  behavior lives in per-feature files under `public/js/pages/`
- `server.js` — a thin entry point that wires together the modules in `server/` (see
  [Code Structure](Code-Structure)) into the same static file server plus
  settings/tags/series/logs/calendar REST endpoints, MyAnimeList/TheTVDB search proxies,
  and per-episode data fetching it always had (see [Metadata Search](Metadata-Search))

Settings, the Library (series data), and Activity/Wanted (queue, history, blocklist,
missing, cutoff unmet) are all backed by SQLite — see
[Persistence and Logging](Persistence-and-Logging) and
[Grab / Download Pipeline](Grab-Download-Pipeline).

## Pages in this wiki

**Frontend**
- [React Migration](React-Migration) — why/how the frontend is moving from plain JS to
  React, one page at a time, and a batch-by-batch log of every page migrated so far
  (through Settings > Metadata, the last page)
- [Code Structure](Code-Structure) — how `server/` and `public/js/` are organized, the
  shared sidebar, and how the split was verified
- [Library Views](Library-Views) — Poster / Table / Overview view toggle on the Library
  dashboard

**Core data & persistence**
- [Persistence and Logging](Persistence-and-Logging) — SQLite storage and the real
  System > Logs feed
- [Metadata Search](Metadata-Search) — MyAnimeList search/add and TheTVDB per-episode data
- [Root Folders and Library Import](Root-Folders-and-Library-Import) — real filesystem
  scanning, matching real files to real episodes, and reconciling Downloaded/Size against
  what's actually on disk

**Library & series pages**
- [Sidebar Navigation](Sidebar-Navigation) — why Library/Calendar/Activity/Wanted became
  real links instead of accordion sections
- [Calendar](Calendar) — the real month-grid calendar
- [Edit Series Modal](Edit-Series-Modal)
- [Series Detail Page Features](Series-Detail-Features) — real airing status, the episode
  details modal (incl. real synopsis text), and the squished-poster bug fix

**Downloading**
- [Grab / Download Pipeline](Grab-Download-Pipeline) — the simulated grab pipeline, Queue/
  History/Blocklist, and Wanted Missing/Cutoff Unmet
- [Real Search and Grabs](Real-Search-and-Grabs) — Nyaa.si real search and real qBittorrent
  submission/progress tracking, with a graceful fallback to the simulated pipeline above
- [Quality Definitions](Quality-Definitions) — the quality tiers redesign and the 3-handle
  range slider
- [Download Clients](Download-Clients) — real qBittorrent/NZBGet connections
- [Connect Notifications](Connect-Notifications) — real Pushover notifications

**Dashboard**
- [Disk Usage](Disk-Usage) — real recursive disk usage, the System > Tasks recompute job,
  and persistence across restarts
- [Three Small Settings/Nav Fixes](Three-Small-Fixes)
- [August 2026 Fix Batch](August-2026-Fix-Batch) — nav's admin-only System section, series/season
  rename, disabling Monitored on completed series, shorter Library Import paths, the Download
  Clients edit button position, both modal-wrap fixes, consistent test-success flashing, real
  backup downloads, and SSL cert/key upload

**Accounts**
- [User Accounts](User-Accounts) — real sign-in, password hashing, admin/standard roles,
  first-run setup, and the shared (not per-user) Library
