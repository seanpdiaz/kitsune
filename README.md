# Kitsune UI mockup

A click-through mockup of the Kitsune Library dashboard, Series detail, Settings, and
System screens. The backend is pure Node (no Express, no npm dependencies of its own —
the one exception is SQLite, which comes built into Node itself) so it runs anywhere Node
22.5+ runs. The frontend is migrating page by page from plain JS to React (see "React
migration" below) — that part does have a real build step and real npm dependencies now,
though only for the pages that have actually migrated so far; server.js itself is
completely unaffected either way.

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
  search/filter/sort, backed by SQLite — see Persistence below)
- `public/series.html` — Series detail (segment tabs demonstrating the named-arc /
  official-part / sequential-season fallback rule, episode list with status states, and
  an Edit Series modal — see Edit Series modal below)
- `public/library-add-new.html`, `public/library-import.html` — Library sub-pages: search
  (live, via MyAnimeList — see Metadata search below) and add new series, and scan real
  root folders for subdirectories not yet in the Library (see Root folders + Library
  Import below)
- `public/activity-queue.html`, `public/activity-history.html`,
  `public/activity-blocklist.html` — Activity sub-pages: live download queue
  (pause/resume/remove), filterable history feed, blocklisted releases — all backed by a
  real simulated grab/download pipeline now, see Grab/download pipeline below
- `public/wanted-missing.html`, `public/wanted-cutoff-unmet.html` — Wanted sub-pages:
  aired-but-missing episodes and episodes below their quality cutoff, both with working
  Search / Search All (real grabs — see Grab/download pipeline below)
- `public/calendar.html` — a real month-grid calendar of episode air dates, pulled from
  whatever's already cached in the `episodes` table (see Calendar below)
- `public/settings-*.html` — the full Settings section (Media Management, Profiles,
  Quality, Custom Formats, Indexers, Download Clients, Import Lists, Connect, Metadata,
  Tags, General, UI)
- `public/system-*.html` — the System section (Status, Tasks, Backup, Updates, Events,
  Logs — Logs is real, showing live server activity, see Logging below; Status' Info and
  Disk Space cards are also real, see Grab/download pipeline below)
- `public/styles.css` — design tokens (colors, type, spacing) and component styles
- `public/app.js` — a thin entry point that just `import`s every feature module in
  `public/js/` (see Code structure below); all actual page behavior — series grid/episode
  list rendering, the sidebar accordion (now just Settings/System sub-menus, one open at a
  time — Library, Calendar, Activity, and Wanted are real links, see Calendar below for
  why that changed), the reusable connection-manager pattern used by Indexers/Download
  Clients/Import Lists/Connect, the Queue/History/Blocklist/Missing/Cutoff Unmet list
  behaviors, and the Tags section (see Persistence below) — now lives in per-feature files
  under `public/js/pages/`
- `server.js` — a thin entry point that wires together the modules in `server/` (see Code
  structure below) into the same static file server plus
  settings/tags/series/logs/calendar REST endpoints, MyAnimeList/TheTVDB search proxies,
  and per-episode data fetching it always had (see Metadata search below)

Settings, the Library (series data), and Activity/Wanted (queue, history, blocklist,
missing, cutoff unmet) are all backed by SQLite now — Tags was the original proof of
concept for this pattern, Settings was migrated next, Library after that (see Persistence
below), and Activity/Wanted most recently (see Grab/download pipeline below).

## React migration

The frontend is migrating from plain JS (`public/js/`, `innerHTML`-string rendering, one
shared `app.js` every page loads in full) to React, one page at a time. Four real
decisions went into how, worth writing down since they shape everything under
`frontend/`:

**React**, over Vue or Angular — the deciding factor was the stated goal for this project:
evolving into something other people can use and contribute to. React has the largest
pool of developers already familiar with it, which matters more than any technical
difference between the three for a project optimizing for outside contributions.

**Incremental, page by page** — not a full rewrite. Each migrated page keeps its own real
`.html` file and gets a small React root mounted into one container div; unmigrated pages
stay exactly as they are. This means the app is never mid-rewrite in a way that blocks
shipping other changes, and a bad migration is contained to the one page it happened on
rather than risking every page at once. The cost is running two frontend patterns side by
side for a while — considered worth it for the lower risk.

**The backend doesn't change.** `server.js` and everything under `server/` stays
untouched — no Express, no rewrite, nothing. The existing REST-ish JSON endpoints every
page already calls via `fetch()` are exactly what a React component calls too; migrating
the frontend and modernizing the backend are separate, unrelated concerns, and there's no
reason a project this size needs to do both at once. This also means the migration can't
break any of the real functionality already built (quality profiles, download clients,
the grab simulation, TVDB/MAL fetching, etc.) — none of it is anywhere near the code that
changed.

**Plain JavaScript, not TypeScript** — the extra ceremony (type annotations, a stricter
build step) wasn't judged worth it for this project's size, even though TypeScript would
have caught some of the real shape-mismatch bugs this project has hit by hand (camelCase
vs. snake_case field names, wrong assumptions about an API response's shape). A deliberate
trade-off, not an oversight.

### How a migrated page actually works

Each migrated page lives in `frontend/pages/<page-name>/`, built by Vite
(`vite.config.mjs`) into `public/dist/<page-name>.js` — server.js already serves
everything under `public/` as static files by extension, so this needed zero backend
changes to work; the build output is just one more file for the same static-file handler
to serve. The page's `.html` file keeps its normal structure (sidebar, page-tabs, a
container div) and adds one extra `<script type="module" src="dist/<page-name>.js">`
alongside its existing `<script type="module" src="app.js">` — `app.js` still renders the
shared sidebar/page-tabs (`public/js/nav.js`) and every other page's own module exactly as
before; the new script just also mounts a React root into that one page's container div.
The page's old entry in `app.js`'s import list is removed (not left running alongside the
new one — see below for why that matters) once the page migrates.

Vite's own `outDir`/`publicDir` conventions needed two adjustments to fit into this app's
existing layout rather than fighting it: `publicDir: false` (Vite's default assumes a
top-level `public/` holds static assets to copy verbatim into the build output — this
project already has an unrelated, pre-existing `public/` with a totally different meaning,
and leaving Vite's default enabled meant a build nested a confusing full duplicate of the
entire site inside its own output), and non-hashed output filenames (Vite's default
`system-tasks-i16X5hWF.js`-style content-hashed names exist for cache-busting, but this
app already cache-busts a different way — server.js sends `Cache-Control: no-cache` on
every static file, forcing revalidation on every load regardless of filename — so a hashed
name here would just mean keeping each page's `<script src>` in sync with whatever hash
the last build happened to produce, for no benefit this app doesn't already get another
way).

### Pilot page: System > Tasks

The first page migrated, to prove the pattern end to end before committing to it more
broadly. Chosen for being small but not trivial — one real backed-by-a-database row (Disk
Usage Recompute, see `server/lib/disk-usage.js`) with real async behavior (a Run Now that
kicks off a background scan, polling while it runs, a completion flash), plus six purely
decorative rows with their own small local interaction (a fake "Run Now" that fakes a
timestamp update). `frontend/pages/system-tasks/TaskList.jsx` is a faithful port of the
old `public/js/pages/system-tasks.js` (now deleted — superseded, not kept running
alongside the React version, which would have meant two separate render loops fighting
over the same `#taskList` container) — same data, same endpoints, same polling-while-
running behavior, same completion flash, talking to the exact same unchanged backend. The
one real behavior difference: each decorative row now owns its own local state (a
`useState` per `FakeRow` component) instead of the old version's single shared array plus
a full-list re-render on every fake click — free with components, wasn't with
`innerHTML`-based rendering.

Verified against the real, running backend rather than just reading the code: loaded
`system-tasks.html` in a real DOM (jsdom) with both its scripts executing exactly as a
browser would run them, confirmed all 8 rows render (7 decorative + the real one) with the
real row's interval `<select>` populated from the real `/api/system-tasks` response,
clicked Run Now and confirmed instant "Running…" feedback, then polled a real disk usage
scan through to completion and confirmed the row correctly showed "Running…", then the
completion flash (`.row-flash-success`, same shared CSS animation used elsewhere in this
app — see "Green completion flash" above), then settled back to normal — the identical
lifecycle the old vanilla version had, now running through React state instead of manual
`render()` calls. Also confirmed the shared sidebar (still plain JS, `nav.js`, loaded via
the page's existing `app.js` script) renders correctly alongside the new React content, and
ran the full 28-page regression suite to confirm nothing on any other, still-unmigrated
page broke.

Migrating another page means: add a `frontend/pages/<page-name>/` directory (a `main.jsx`
that mounts into that page's container div, plus whatever components), add its entry to
`vite.config.mjs`'s `rollupOptions.input`, add the extra `<script>` tag to that page's
`.html`, remove its old module's import from `app.js`, and delete the old module.

### Batch 2: System > Status, Backup, Events, Logs

Four more System pages, migrated together since each is a single independent list/detail
view with no cross-page shared state — the same shape as the pilot, just four of them.
`system-status/StatusInfo.jsx` fetches `/api/system/status` once on mount and renders the
Info stat-grid and Disk Space list. `system-backup/BackupPage.jsx` and
`system-events/EventFeed.jsx` introduced the **portal pattern**: each page's "Backup Now" /
"Clear Events" button lives in the page's `.top-row`, visually separate from the list it
acts on below — rather than two unrelated React roots with no shared state between them,
one component with one `useState` renders the button via `createPortal()` into a
placeholder (`#backupNowBtnRoot`, `#clearEventsBtnRoot`) while the list renders normally
into its own container, so a click updates both in the same render. `system-logs/LogTable.jsx`
uses the same portal pattern for its filter tabs (`#logFilterTabsRoot`) and polls
`/api/logs?level=...` every 4 seconds, re-subscribing whenever the selected level changes.

Verified the same way as the pilot — jsdom against the real backend, all four pages'
data and interactions confirmed, full 28-page regression suite re-run. One real bug
surfaced and fixed during this batch, unrelated to React itself: the Backup/Events click
tests initially looked broken (no DOM change after simulating a click), traced to React 18
batching state updates asynchronously — the test asserted immediately after
`.click()` in the same synchronous tick and saw stale state. Fixed the test (not the
component) by awaiting a short delay after the click before asserting.

### Batch 3: Activity — Queue, History, Blocklist

The three Activity pages, all backed by the real grab-simulation pipeline
(`server/routes/queue.js`) rather than static data. `activity-queue/QueueList.jsx` polls
`/api/queue` every 2 seconds and provides pause/resume (`PATCH`) and remove (`DELETE`)
actions. `activity-history/HistoryList.jsx` uses the portal pattern for its filter tabs
(`#historyFilterTabsRoot`) and re-fetches `/api/history?type=...` whenever the selected
type changes. `activity-blocklist/BlocklistList.jsx` fetches `/api/blocklist` once and
provides a remove action. All three import `formatBytes`/`timeAgo` directly from
`public/js/lib/format.js`/`dates.js` rather than duplicating them — both are pure,
DOM-free functions safe to share as-is between the plain-JS and React frontends.

Verified against the real backend with rows seeded directly into `queue`/`history`/
`blocklist` (both tables require a real `episodes` row via their `JOIN`, so a couple of
fake episodes were seeded too) to exercise non-empty states: queue rows render with
working pause and remove, history's filter tabs correctly re-fetch and re-render, and
blocklist's remove action correctly removes a row. Full 28-page regression suite re-run
and passed.

### Batch 4: Wanted — Missing, Cutoff Unmet

`wanted-missing/MissingList.jsx` and `wanted-cutoff-unmet/CutoffList.jsx`, backed by the
real `GET /api/wanted/missing` and `GET /api/wanted/cutoff-unmet` (see `server/routes/wanted.js`)
and the same real search → grab pipeline as Activity > Queue. Same portal pattern as
System > Backup/Events/Logs for each page's "Search All" button. The one new wrinkle: both
pages' per-row Search button opens `public/js/lib/release-picker-modal.js` — a self-contained
"build once, append to `<body>`" vanilla-JS modal shared with the still-unmigrated series
detail page's episode list. It was **not** ported to React; `initReleasePickerModal()` is
imported directly into each component the same way `formatAirDate`/`formatBytes` are
reused, and `picker.open(episode, onGrab)` is called from a React click handler. It works
unmodified because it was already decoupled from whatever page opens it — a good sign the
vanilla modal patterns from before the migration were already component-shaped, so it's
one less thing that needs porting before the series detail page's turn comes.

Verified against the real backend with rows seeded directly into `episodes` (aired,
undownloaded rows for Missing; downloaded rows with a below-cutoff `quality` plus a
matching `quality_profile` on their series for Cutoff Unmet): both pages render real rows,
the "Search All" portal button renders, and clicking a row's Search button opens the real
picker modal populated with real simulated releases. Full 28-page regression suite re-run
and passed.

### Batch 5: Calendar

`calendar/CalendarPage.jsx`, a faithful port of `public/js/pages/calendar.js` — real air
dates from `GET /api/calendar`, which reads straight from the `episodes` table (the same
cache the still-unmigrated series detail page fills in on first visit). One state object
now drives three previously-separate pieces of rendered output: the prev/next/today
toolbar (in the page's `.top-row`, portal'd into `#calendarToolbarRoot` — the same portal
pattern as every prior batch's page-specific button, just with a `<>...</>` fragment of
three buttons instead of one), the "N series haven't loaded their episodes yet" note, and
the weekday header + 6-week grid — the latter two now just plain sibling JSX under one
`#calendarRoot` container instead of needing their own portals, since (unlike the toolbar)
they were never in a separate part of the page to begin with. Manual `escapeAttr()` calls
the old version needed for its `innerHTML`-string day chips (`title="${escapeAttr(...)}"`)
are gone entirely — JSX escapes text content and attribute values automatically, one of
the small correctness wins that come for free with the migration rather than needing to be
carried over.

Verified against the real backend with an aired-today episode seeded directly into
`episodes` (a calendar with zero cached episodes only proves the empty state, not real
rendering): the day grid correctly shows an episode chip on the right cell, the toolbar's
Next/Today buttons correctly change the month label and re-fetch that month's data, and Today
correctly returns to the original month. Full 28-page regression suite re-run and passed.

### Batch 6: Settings — Indexers, Import Lists, Connect, Download Clients

The first batch where one React component serves more than one page. `components/ConnectionManager.jsx`
is a faithful port of `initConnectionManager` (`public/js/pages/settings-connections.js`,
now deleted) — the shared controller Indexers, Import Lists, and Connect all used —
parameterized the exact same way the original function was: `section` picks the API route,
`types` are the add-panel's template choices, `metaLabel`/`priorityLabel` name whatever
columns 2 and 3 mean on that page (Indexers: "Categories"/"Priority", Import Lists: "Root
folder"/"Profile", Connect: "Triggers"/"Events" — this is now an explicit prop; the original
hardcoded column 3's header text directly into each page's static HTML with nothing in JS
naming it). Each of `settings-indexers/`, `settings-import-lists/`, `settings-connect/` is
just a `main.jsx` passing its own section/types/labels into the shared component — same
"one shared component, three thin entry points" shape `DownloadClients.jsx` itself
established as a *separate* component before this migration even started (it split off from
`initConnectionManager` for its real qBittorrent/NZBGet integration — see the section above —
and gets its own React port here for the same reason, `settings-download-clients/DownloadClients.jsx`).

Pushover's real-integration behavior — the one genuine integration among these four pages
(see "Connect: real Pushover notifications" above) — ported over completely intact: the
`extra`-field mechanism that gives a new Pushover connection real (empty) credential fields
instead of the generic shape, the edit modal's branch between Pushover's real fields (User
Key/API Token/Priority select/three trigger checkboxes/Send Test Notification) and every
other type's generic Protocol/metaLabel/Priority fields, the derived Triggers summary
recomputed on every checkbox change, and — important since it's easy to silently lose during
a rewrite — the one-time backfill for a "Pushover" Connect row created *before* real Pushover
support existed (a row with no `type` field, added back when Pushover was still just a
decorative chip like Slack/Plex/Gotify — it'd otherwise fall back to the generic form
forever). That fix originally lived inline in `settings-connections.js`'s `loadData()`; it
now lives in one `useEffect` at the top of `ConnectionManager.jsx` instead, same detection
(by name, since `type` is exactly the field that's missing) and same patched fields.

Every add/edit/remove/enable-toggle/Test action across all four pages autosaves the same way
it always did — a field's `onChange` both updates local state and fires the matching
`PATCH /api/settings-items/:section/:id` (or the real `/api/connect/:id/test` /
`/api/download-clients/:id/test` for Test), no separate Save button anywhere, consistent with
every other Settings page whether migrated or not. Download Clients' one-shot
`row-flash-success` animation on a successful Test (see styles.css) is reimplemented with a
`flashId` state cleared by its own `setTimeout` rather than the original's "consumed by the
next render" flag — React doesn't have an equivalent of directly reading and clearing a
closure variable mid-render, so this needed an actual timer instead, but plays for the exact
same duration on the exact same trigger.

One real jsdom/React testing gotcha surfaced while verifying this batch, worth documenting
since it looks exactly like a real bug at first: React tracks a controlled `<input>`'s value
through a shadowed property setter on the DOM node, so directly assigning `element.value = 'x'`
in a test script and then dispatching a plain `Event('change')` — which is exactly how the
*previous* vanilla-JS pages' own DOM-`addEventListener('change', ...)` code worked, and how
every prior batch's verification scripts simulated typing — goes completely unnoticed by
React, since React listens for the native `input` event for text fields, not `change` (which
in a real browser only fires on blur). The first pass of this batch's own verification
scripts hit exactly this: an edited field visibly stayed unchanged in the row and never
reached the server, looking identical to a real autosave bug. It wasn't one — real typing in
an actual browser always goes through the input's native value setter and fires `input` on
every keystroke, which React handles correctly; only *scripted* value assignment needs the
workaround (grabbing `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,
'value').set` and calling it explicitly before dispatching `input`, the same technique React
Testing Library's own `fireEvent` uses internally). Once the verification scripts were fixed
to simulate typing that way, every field across all four pages — including Connect's
Pushover User Key/API Token — confirmed persisting correctly both in the row display and
server-side.

Verified against a real running server: all four pages render their real seeded rows
(Indexers' 5, Import Lists' 4, Connect's 4 decorative + a deliberately-seeded stale
pre-migration "Pushover" row, Download Clients' qBittorrent + NZBGet); the stale Pushover row
is confirmed migrated in place (real fields appear in its edit modal, `type`/`priority`
backfilled correctly server-side); a brand-new Pushover connection's modal auto-opens with
real fields and a real Test button that hits the actual `/api/connect/:id/test` endpoint
(confirmed by the real "Could not reach Pushover" network-failure message this sandbox
produces, not a canned success); Download Clients' real Test Connection likewise hits
`/api/download-clients/:id/test` and surfaces a real "Could not reach ..." failure; every
page's Add/Edit/Remove/enable-toggle round-trips through the real API and persists across a
fresh page load. Full 28-page regression suite (with all four new pages added to the suite's
own migrated-page list, so it actually exercises their React bundles rather than skipping
straight to the still-shared `app.js`) passed 28/28 afterward.

### Batch 7: Settings — Profiles, Custom Formats

`components/SimpleList.jsx`, a faithful port of `initSimpleList` (`public/js/pages/settings-profiles-formats.js`,
now deleted) — the lighter-weight sibling of `ConnectionManager.jsx`: no live status/test,
no enable toggle, just named records with a couple of metadata columns and an edit modal.
Unlike `ConnectionManager`, the two pages' row shapes and edit fields are different enough
(Profiles: Name/Cutoff/Qualities/Upgrades; Custom Formats: Name/Conditions/Used in) that
`SimpleList` takes `renderRow(item)` and `renderEditFields(item, onChange)` as render props
instead of branching internally — `ProfilesPage.jsx` and `CustomFormatsPage.jsx` each supply
their own, matching the original's `rowTemplate`/`editFieldsHtml` function-prop shape closely.
`baseClass` ("profile" or "format") derives both the header and row class names
(`.profile-header`/`.profile-row`, `.format-header`/`.format-row`) from one prop rather than
passing both separately, since every page here follows that exact naming convention already.

Profiles' Cutoff dropdown is still sourced from the real Quality Definitions tier list
(`GET /api/settings-items/quality-tiers`) rather than a hardcoded copy — `ProfilesPage.jsx`
fetches it once into its own state and threads it into `renderEditFields` via closure, since
this is a concern specific to Profiles' own edit fields, not something `SimpleList` itself
needs to know about.

The same jsdom/React input-simulation gotcha from Batch 6 (React tracks a controlled input's
value through a shadowed property setter, so a scripted `element.value = 'x'` needs the
native prototype setter — see that batch's writeup above) applies here too; this batch's own
verification scripts used it from the start rather than rediscovering the same false alarm.

Verified against a real running server: both pages render their real seeded rows (Profiles'
6, Custom Formats' 5); Profiles' Cutoff select is confirmed populated with real tier names
(including `Bluray-1080p`); editing a profile's Name and toggling Upgrades allowed both
persist correctly in the row display and server-side; Custom Formats' singular/plural
"condition(s)" label is confirmed correct at both 9 and 1; Add/Remove round-trip through the
real API on both pages. Full 28-page regression suite passed 28/28 afterward.

### Batch 8: Settings — Tags, Quality, Media Management, General, UI

The last five Settings pages, and the last batch before Library itself (grid + series detail,
the biggest page in the app) is all that's left. Four different shapes on one batch:

**Tags** (`frontend/pages/settings-tags/TagsPage.jsx`) is a faithful port of `initTagManager` +
`initTagSizeSlider` (`public/js/pages/settings-tags.js`, now deleted) folded into one
component, since both pieces only ever appear on this one page and the size slider needs a
ref to the same cloud element the chips render into. The color-picker modal (9 presets + a
custom-color trigger wired to a hidden native `<input type="color">`) is plain JSX state
instead of the original's own manual DOM rendering; `pickRandomTagColor()`'s
least-used-preset logic carried over unchanged. `tagChipStyle()` in `public/js/lib/colors.js`
returns a CSS text string meant for a raw `style="..."` attribute — not usable as React's
style prop, which needs an object — so the component reuses that file's `hexToRgbParts()`
math directly and just shapes the result differently, rather than duplicating the hex-parsing
logic. The size slider is still an effect writing straight to `--tag-scale` and the slider's
own gradient fill, same as the original's direct DOM manipulation, since neither one needs a
React re-render on every drag tick.

**Quality** (`frontend/pages/settings-quality/QualityPage.jsx`) is the one page in this batch
that reuses old code wholesale rather than rewriting it: `public/js/lib/range-slider.js`'s
`mountRangeSlider()` — the hand-built 3-handle drag/keyboard/dblclick-to-edit widget behind
each tier's Min/Preferred/Max — is imported as-is and mounted imperatively via a ref inside a
small `QualityTierRow` component, the same pattern `RootFolders.jsx` (below) uses for the file
browser modal. That file's own comments document real bugs it already fixed once (the min-gap
trap that could hide a handle underneath another, the GB/MB edit-box unit bug) — a from-scratch
JSX rewrite of that drag math would risk reintroducing exactly those, for no real benefit over
reuse. `commitSliderChange`/`applyPreset`/`moveTier`/etc. all still call through to a `tick`
counter bumped on every commit-worthy change, used as part of each row's React `key` — forcing
a full remount, which is what re-mounts `mountRangeSlider` with fresh bounds/values. That's a
deliberate, close analog of the original `renderAll()` rebuilding every row's `innerHTML` on
every change, not an accidental side effect. Everything else (groups, presets, Add Quality
modal, Reference Runtime/unit prefs, reorder) is regular React state managed the same way as
every other list-style Settings page this migration has already covered.

**Media Management** (`frontend/pages/settings-media-management/`) combines two different
things the original page glued together: the Episode Naming/File Management/Importing cards
are "one settings object" fields (see below), while Root Folders is its own list backed by
`/api/settings-items/root-folders` — `components/RootFolders.jsx` owns that list's state and
also renders the File Browser modal's markup inline (same DOM ids the original static HTML
used), wiring up `public/js/lib/file-browser-modal.js`'s `initFileBrowserModal()` imperatively
via a ref + effect rather than rewriting its server-directory-browse UI in JSX — same reasoning
as Quality's range-slider reuse above.

**General** and **UI** (`frontend/pages/settings-general/`, `frontend/pages/settings-ui/`) are
both, along with Media Management's non-Root-Folders cards, "one settings object" pages: every
persistable control used to carry a `data-key` attribute, loaded/saved as a flat
`{ key: value }` object via `/api/app-settings/:section` (`initSettingsForm` in
`public/js/pages/settings-forms.js`). `frontend/lib/useSettingsForm.js` is the React
equivalent — loads the saved object, merges it over the page's own defaults (a key missing
from the saved object means a first-ever visit to that field, queued for a one-time save,
same as the original's `firstVisitDefaults`), and debounces saves the same 400ms the original
did so rapid typing/toggling doesn't fire a request per keystroke. `components/SettingsFormFields.jsx`
(`SettingsCard`/`FormRow`/`ToggleField`/`TextField`/`NumberField`/`SelectField`) are small shared
building blocks so each page's JSX reads close to the HTML it replaced. The original's
`wireToggleCascade`/`wireSelectCascade` (show/hide dependent fields — Media Management's rename
toggle and permissions toggle, General's auth method and proxy toggle) are now just a boolean
computed straight off the loaded state in each page's own JSX, rather than a separate DOM
class-toggle listener; `settings-forms.js` had those calls (plus the `media-management`/
`general`/`ui` `initSettingsForm` calls) removed rather than left as dead no-ops, since all
three pages are fully React now — it still backs the not-yet-migrated Metadata page's own
Kodi/Roksbox/WDTV toggle cascades. UI's Theme radio pair carried over as visually inert: Light
was already `disabled` in the original markup (dark-only for now), so Dark's radio has nothing
to actually toggle between and isn't wired to `setField`, matching what the original already
behaved like in practice.

A jsdom testing gotcha specific to this batch: verifying Quality's tier-rename (which commits
on blur, not on every keystroke, unlike every other text field this migration has ported)
initially showed a false failure — a scripted `element.dispatchEvent(new Event('blur'))` never
reached React's handler. React implements `onBlur` via the native `focusout` event (which
bubbles) listened for at the root, not `blur` itself (which doesn't bubble) — the same class of
issue as the Batch 6 input/`change` gotcha, just one event later in the form-interaction
lifecycle. Fixed by dispatching `focusout` instead, same as that batch's fix swapped `change`
for `input`.

Verified against a real running server, each page against its own seeded/real data: Tags —
create/rename/remove round-trip through the real API, duplicate-name 409 conflict shows the
server's canonical-cased name, custom color picker and the least-used-preset default both
behave correctly, size slider persists to `localStorage` and updates the CSS variable live.
Quality — all 11 seeded tiers render across the correct SD/720p/1080p/2160p groups, the
mounted slider widget's Target Size readout is correctly populated from real seed values,
group collapse, tier rename (server-persisted), move-up rank swap, Add Quality, a preset
application, a Reference Runtime change (with the resulting readout actually changing and the
UI pref persisting server-side), and remove all confirmed. Media Management — first-visit
defaults persist, naming fields correctly start enabled/permissions fields correctly start
disabled based on their respective toggles' defaults, both cascades flip correctly when their
toggle changes, a naming-format text edit persists server-side, root folder rows render from
real seed data. General — first-visit defaults persist, auth fields visible/proxy fields
disabled by default, Authentication Method switching to None correctly collapses the
Username/Password rows, turning Proxy on correctly enables its detail rows, a port-number edit
persists server-side as a number (not a string). UI — first-visit defaults persist, the Theme
radio's Dark-checked/Light-disabled state renders correctly, a Default Library View select
change and a toggle both persist server-side. Full 28-page regression suite (with all five new
pages added to the suite's migrated-page list) passed 28/28 afterward.

### Batch 9: Library — Add New, Library Import

Two pages left before the biggest one (Library grid + Series detail). Both are ported from
`public/js/pages/library-add-new.js` and `library-import.js` (now deleted) with their real
backends untouched — MyAnimeList search via `/api/mal/search` (falling back to TVDB if MAL's
official API is down), and a real root-folder filesystem scan via
`/api/root-folders/:id/subfolders`.

**Add New** (`frontend/pages/library-add-new/AddNewPage.jsx`) keeps the original's debounced
search (400ms, with a `requestSeq` counter to drop a stale response if a newer keystroke
superseded it — ported as a `useRef` counter instead of a closure variable, same guard),
`libraryIndex` (a `{ byExternal, byTitle }` pair of Maps used to show "In Library"/"Added" on a
result that's already been added, keyed both by exact source+id and by a loose title match so
re-finding the same show from a different source still resolves), and the shared `addSeries()`
used by both a card's own button and the preview modal's, including the 409-conflict handling
that folds a race'd-in duplicate into `libraryIndex` immediately rather than leaving a dead
"Add Series" button that would just 409 again. The one structural difference from the original:
each `SeriesCard` now owns its own local `adding`/`error` state (a `useState` per card) instead
of directly mutating one passed-in button element's `disabled`/`textContent` — the natural React
shape for "this one button is busy," and it's what let the preview modal's Add button reuse the
exact same `addSeries()` promise without needing its own DOM-poking copy.

**Library Import** (`frontend/pages/library-import/LibraryImportPage.jsx`) ports
`initLibraryImport` closely: the real per-root-folder scan, per-row expand-to-see-real-files
(lazy-loaded and cached in a `Map` keyed by `` `${rootFolderId}:${name}` ``, same key shape as
the original, so re-opening a row doesn't re-fetch), and "Import files" linking real files to a
matched series' real episodes. `openRows`/`fileListCache`/`importResults` are all just React
state now instead of closure-captured `Set`/`Map` instances mutated in place — functionally the
same, just re-rendered through `setState` instead of a manual `render()` call after each mutation.
The Rescan button is a portal into the top row, same pattern every list-style Settings page
this migration has already used for its "Add X" button.

This sandbox has no outbound network access and its seeded root-folder paths
(`/anime/ongoing` etc.) don't exist as real directories on disk here, so both pages' "real
data" paths (an actual MAL search result, an actual scanned subfolder) can't be exercised
end-to-end in this environment the way, say, Settings > Tags' real `/api/tags` calls could be.
Verified what's actually testable here instead: Add New correctly shows its idle state by
default, debounces (a rapid burst of keystrokes settles on exactly one outcome, not one per
keystroke), and correctly renders the *real* error state once the real MAL-then-TVDB fallback
attempt genuinely fails (confirmed against the real ~2s multi-attempt failure this sandbox
produces, not a mocked instant one) — the result-rendering/Add Series/preview paths themselves
are a straightforward, unchanged port of the same data shapes `server/lib/mal.js` already
returned before this migration, exercised the same way every other Add/Edit round-trip in this
migration was until this batch hit an environment wall. Library Import correctly falls through
to its "Nothing found" empty state (not a crash) when every root folder's scan fails, and its
Rescan button's busy/settled states were confirmed correctly. Full 28-page regression suite
(with both new pages added to the suite's migrated-page list) passed 28/28 afterward.

A jsdom timing note specific to this batch, not a bug: checking a button's label/disabled state
immediately after `dispatchEvent(new MouseEvent('click'))` — with no `await` in between — saw
the *pre*-click state, even though the click handler's `setState` calls happen synchronously
before any `await` in the handler. React 18's root here flushes that update on a microtask
rather than fully synchronously inside the event dispatch the way a real browser's discrete-event
path would; an `await wait(0)` (or any microtask tick) between the click and the assertion was
enough to see the update. Distinct from the Batch 6 input/`change` and Batch 8 blur/`focusout`
gotchas — those were about which native event React listens for; this one is about when React
actually commits the resulting DOM update in a scripted, non-`act()` jsdom test.

### Batch 10: Library grid, Series detail — the last batch

The final two pages, and the biggest: `public/js/pages/library.js` (now deleted, ~1,050 lines)
covered both the Library grid (`index.html`) and Series detail (`series.html`) in one file,
since they used to share a module-level `seriesData` array and a single `loadSeriesData()`
fetch. As two separate React roots there's no shared module state to preserve — each page
(`frontend/pages/library-grid/LibraryGridPage.jsx`, `frontend/pages/series/SeriesPage.jsx`)
just fetches `/api/series` on its own now. Every other page in this app is React now except
Settings > Metadata, which was never part of this migration's scope (see the task list) and
stays exactly as it was.

**Library grid** carries over `matchesFilter`/`sortSeries`/`statusChipFor`/`nextAiringText`/
the Poster/Table/Overview renderers (`PosterCard`/`TableRow`/`OverviewRow` — see Batch
"Library: Poster/Table/Overview views" above for how that feature itself works) essentially
unchanged, plus the Table/Overview-only lazy tag fetch (`tagsLoadedRef`, mirroring the
original's `libraryTagsLoaded` guard) and the Disk usage stat card's "poll while computing,
stop once it isn't" behavior (`DiskUsageStat`, a small self-contained component). The search
box moves into the top row via the same portal pattern every earlier batch's "Add X" button
used — it's the one interactive control living outside the page's main content area.

One build wrinkle specific to this batch: `index.html`'s entry couldn't be named `'index'` in
`vite.config.mjs` the way every other page's entry matches its `.html` filename — Rollup was
already producing a shared vendor chunk named `index.js` for this project (visible in every
build's output list well before this batch touched anything), and an entry sharing that exact
name would collide with it. Named `'library-grid'` instead; `index.html`'s
`<script src="dist/library-grid.js">` just points at that entry key, nothing else needed to
match. `series.html`'s entry is named `'series'` as normal — no such collision there.

**Series detail** is the more involved of the two: header/stats/Monitored toggle, the
hand-built Frieren demo (`episodesBySegment`, kept verbatim — still the one series that shows
off the named-arc/season segment-tabs pattern by hand rather than from real season data), the
generic synthetic episode list every other series falls back to before real TVDB data loads
(`buildGenericEpisodes`), and the real, possibly-segmented episode list once it does
(`buildRealEpisodeRows`/`groupEpisodesBySeason`, with live-queue polling that stops on its own
once nothing's downloading — same shape as the Disk usage stat's own polling). The Delete and
Edit Series modals are both fully React now (`DeleteSeriesModal`/`EditSeriesModal`), the latter
including its own tag picker (add/remove chips against the real `/api/tags` list, same chip
styling `frontend/lib/tagChipStyleObj.js` now shares with Settings > Tags and the Library
grid's Table/Overview views — extracted into that one shared helper this batch, rather than a
third copy of the same `hexToRgbParts()`-to-style-object conversion).

Two library widgets are reused imperatively here exactly the way Batch 8 reused
`mountRangeSlider` and `initFileBrowserModal`: `initReleasePickerModal()` (the Search button's
release picker, shared with Wanted > Missing/Cutoff Unmet) and `initEpisodeDetailsModal()`
(opened by clicking a real episode's title) are both self-contained "build once, append to
`<body>`, expose `open()`" widgets with no page-specific markup of their own to fold into JSX —
reusing them as-is is both less code and less risk than a rewrite. `EditSeriesModal` reuses
`initFileBrowserModal()` the same way `RootFolders.jsx` did in Batch 8, rendering the same
static file-browser modal markup (matching DOM ids) inline in its own JSX.

A structural difference worth calling out: the original's single `loadRealEpisodes(series)`
function got called from three places (initial render, after a grab, after a cancel) by
literally re-invoking the same closure. The React port consolidates that into one function
assigned to a ref (`loadRealEpisodesRef.current`, kept fresh via its own effect whenever
`series` changes) that both the mount effect and the grab/cancel handlers call through — so
there's exactly one copy of the fetch-episodes-and-queue-then-render logic, not two near-
identical ones. That effect is deliberately keyed on `series && series.id`, not the whole
`series` object — `EditSeriesModal`'s save creates a new `series` object reference on every
edit (even one that touched nothing episode-related), and resetting/re-fetching the whole
episode list after every metadata save would be a flicker regression the original didn't have
(it mutated the series object in place via `Object.assign`, so nothing about the episode list
ever re-ran just because the header got edited).

This sandbox's lack of outbound network access limits what's actually exercisable on Series
detail the same way it did for Add New/Library Import in Batch 9: real TVDB episode data never
loads here (no network to fetch it from), so every non-Frieren series's episode list falls back
to the generic synthetic one — which, like the Frieren demo's own hand-built rows, has no real
per-episode id behind it, so the Search/Cancel/details-modal actions stay inert for both (same
gating the original already had: `canAct = ep.id != null`). Verified what's actually
exercisable instead: Frieren's segment tabs (Specials/Season 1/Season 2, each showing the right
row count and per-state styling — missing/downloading-with-percent included), the generic
fallback's done/missing split computed correctly from a real "11 / 12" eps count, the Monitored
toggle persisting server-side, the Edit modal's Quality Profile select populated from real
`/api/settings-items/profiles` data, a season-folder toggle + series type change + tag add all
persisting correctly together in one save, and the Delete modal actually removing a (disposable,
test-created) series from the server. Library grid: all 21 seeded series render in Poster view,
filter tabs and the search box both narrow the grid correctly, all three views (Poster/Table/
Overview) render with the right row/card counts and the active view persists to `localStorage`,
and the Disk usage stat's fetch completes (confirmed via the `title` attribute a real
`diskUsageComputedAt` sets — the formatted text itself is legitimately the same em dash both
before and after the fetch in this sandbox, since the seeded root-folder paths don't exist on
disk here either). Full 28-page regression suite (with `index`/`series` added to the suite's
migrated-page list, and a small override table for `index.html`'s non-matching bundle name)
passed 28/28 afterward.

With this batch, every page in the app is React except Settings > Metadata, which was
deliberately out of scope from the start (see the task list this migration worked through) —
not an oversight, just the one page nobody asked to have migrated. (It got asked for shortly
after — see Batch 11 below, the actual last page.)

### Batch 11: Settings — Metadata, the actual last page

Settings > Metadata wasn't on the original task list — it came up after Batch 10 finished and
every other page had already gone React, as an explicit follow-up ask. `frontend/pages/
settings-metadata/MetadataPage.jsx` ports the page's three metadata-writer sections (Kodi/Emby,
Roksbox, WDTV), each a master toggle plus four per-item checkboxes (Series Metadata/Episode
Metadata/Series Images/Episode Images) that dim when their section's toggle is off — the same
`wireToggleCascade('metaXToggle', '.meta-field-x')` cascade `public/js/pages/settings-forms.js`
used to wire up by hand, now just a `!values[toggleId]` class computed straight off state.
Backed by `useSettingsForm('metadata', ...)`, the same hook Media Management/General/UI already
use (Batch 8).

Unlike those three pages, Metadata doesn't reuse `SettingsCard`/`FormRow` from
`frontend/components/SettingsFormFields.jsx`. Both assume a card-level `<h2>` title with the
field's name/desc living inside a `.form-row` beneath it — but the original
`settings-metadata.html` markup has no `<h2>` in any of its three `.settings-card` divs at all;
the section name and description sit directly in the first (and only) row's own `.field-label`,
with that row given `border-top:none; padding-top:0` inline (nothing above it to separate from).
Forcing this page's shape through `SettingsCard`/`FormRow` would've meant either an empty
`<h2></h2>` nobody wants or extending both shared components with options only one page needs —
a plain `.settings-card`/`.form-row` pair written directly in `MetadataSection`, matching the
original markup node-for-node, was the more faithful port.

Since Metadata was the last page still going through `public/js/pages/settings-forms.js`
(`initSettingsForm`/`wireToggleCascade`/`wireSelectCascade` — Media Management, General, and UI
each stopped using it back in Batch 8, once they went React), the whole file is now dead code and
was deleted outright, along with its `import` in `public/app.js`. `app.js` is down to a single
line now: `import './js/nav.js';` — the shared sidebar/page-tabs, still plain JS, still loaded by
every page.

Verified via a fresh jsdom script: all three sections render with the right defaults (Kodi on,
Roksbox off, WDTV on; each section's own four checkboxes matching the original's seeded
true/false pattern), no `<h2>` anywhere inside a `.settings-card` (confirming the faithful-port
markup match), each section's `is-disabled` cascade responds correctly to its own toggle
(including flipping Roksbox on and WDTV off mid-test and confirming both fields' dim state
flipped with them), and edits — both a manually-checked box and the two toggles — persisted
server-side via `/api/app-settings/metadata` alongside the usual first-visit-defaults save every
`useSettingsForm` page does. Full 28-page regression suite (`settings-metadata` added to the
migrated-page list) passed 28/28.

This was the actual last page. Every page in the app is React now, no exceptions.

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
  (see Logging above).
- `server/lib/` — code with no HTTP handler of its own, used by multiple routes:
  `http.js` (`sendJson`/`readJsonBody`), `util.js` (`sleep`), `fs-helpers.js`
  (folder-name matching, free-space stats — see Root folders above), `tvdb.js` (TheTVDB
  client), `mal.js` (MyAnimeList client) — see Metadata search above for both.
- `server/routes/` — one file per REST resource, each exporting its `handle*Api`
  function(s): `tags.js`, `settings-items.js`, `app-settings.js`, `fs-browse.js`,
  `root-folders.js`, `series.js`, `episodes.js`, `calendar.js`, `logs.js`,
  `tvdb-search.js`, `mal-search.js`, `queue.js`, `history.js`, `blocklist.js`,
  `releases.js`, `wanted.js`, `system.js` (the last six are the grab/download pipeline —
  see Grab/download pipeline below).
- `server.js` (project root) is now a ~110-line entry point: it requires every module
  above, assembles the same request-dispatch chain and static-file fallback the original
  single file had, and calls `server.listen()`. Route modules each create their own table
  (`CREATE TABLE IF NOT EXISTS ...`) at `require()` time; since every module is required
  before `server.listen()` runs, all tables exist before any request can arrive
  regardless of require order.

### `public/js/` (native ES modules — `<script type="module">`, no bundler)

- `public/js/lib/` — shared, page-agnostic code: `icons.js` (inline SVG strings +
  `escapeAttr`), `colors.js` (tag color helpers), `file-browser-modal.js` (the reusable
  modal from Root folders/Edit Series Path above), `dates.js` (`formatAirDate`/`timeAgo`),
  `format.js` (`formatBytes`), `release-picker-modal.js` (the Search/Search All release
  picker — see Grab/download pipeline below).
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
"sweep across all N pages" (see the Sidebar navigation section above, and
Persistence's `settings_items` note about the same instinct applied to data) —
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

## Persistence

- Backing store: SQLite via Node's built-in `node:sqlite` module (stable since Node
  22.5 — no npm package needed, so the project stays dependency-free).
- File lives at `data/kitsune.db`, created automatically on first run.
- Four tables cover all of it:
  - `series` — the Library. One row per series (title, poster, episode count, monitored,
    status, etc), plus the fields the Edit Series modal manages — `monitor_new_seasons`,
    `season_folder`, `quality_profile`, `series_type`, `path` — see Edit Series modal
    below. API: `GET /api/series`, `POST /api/series` (used by Add New — see Metadata
    search below), `PATCH /api/series/:id` (the header's own Monitored toggle and the
    full Edit Series modal both go through this), `DELETE /api/series/:id` (the Delete
    button on the series detail page, or inside the Edit modal, behind a shared
    confirmation modal). `public/index.html`'s grid and `public/series.html`'s detail
    view both fetch from this instead of holding the data themselves, which is what makes
    a series added via search actually show up in the Library and survive a page reload —
    and what makes deleting one actually stick.
  - `series_tags` — a many-to-many join table (`series_id`, `tag_id`) linking Library
    series to the existing `tags` table, added for the Edit Series modal's Tags field
    (see below). No separate REST surface of its own — it's read/written entirely through
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
    Folders, and — as of the Quality Definitions redesign, see below — Quality itself)
    Each row stores its fields as a JSON blob tagged with a `section`, so
    differently-shaped sections (a connection has a protocol/priority/status, a root
    folder just has a path) share one table instead of needing one each. API:
    `GET/POST /api/settings-items/:section`, `PATCH/DELETE /api/settings-items/:section/:id`.
    A row's `position` column (display order) is also writable through `PATCH` now — see
    Quality Definitions below for why.
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
see Grab/download pipeline below.

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
- **"In Library"/"Added" link through to the series:** both states used to be an inert
  label — now they're a real link to `series.html?id=<library id>` (the preview modal's
  own Add Series button does the same, staying enabled instead of greying out, and just
  navigates instead of re-POSTing). A fresh add is folded into the same in-memory
  `libraryIndex` the pre-check above uses (not just a separate `addedIds` set) the moment
  the `POST /api/series` response comes back, so the card knows the real Library id to
  link to immediately — not just that the add succeeded.
- **Episode cache warms in the background on add:** adding a series used to leave its
  episode list empty until someone actually opened its detail page — the first visit is
  what triggered `GET /api/series/:id/episodes`'s TVDB resolve+fetch. `POST /api/series`
  now kicks off that same resolve+fetch+cache flow itself, right after responding to the
  add request (fire-and-forget — a slow or failed TVDB lookup doesn't hold up or fail the
  add). `resolveAndCacheEpisodesForSeries` in `server.js` is the shared logic both the
  endpoint and this background trigger call; `resolveAndCacheEpisodesDeduped` wraps it so
  the common case of adding a series and immediately clicking into it doesn't fire two
  concurrent TVDB fetches for the same series — both just await the same in-flight
  promise. This also means a freshly-added series can show up on the Calendar right away
  instead of only after its detail page has been opened once (see Calendar above).
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
- Adding "Preview" turned "Add Series" from the only button on a card into one of two,
  and giving both equal width (`flex: 1` each) left Add Series looking cramped and lost
  its visual weight as the primary action. Fixed by letting Preview size to its own
  label (`flex: 0 0 auto`) and Add Series fill the rest of the row, plus a plus-icon on
  its idle label (and a check icon on the modal button's "Added"/"In Library" states) so
  it reads as a clear call-to-action again instead of a plain text button. The
  add-in-progress/error-retry logic swaps the button's `innerHTML` (not just
  `textContent`) so the icon survives a failed add and retry instead of disappearing.

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
  dynamic segment tabs (Specials first, then ascending seasons, defaulting to Season 1
  rather than whichever season most recently aired — selecting a series should always
  land you at the beginning) instead of one flat, interleaved list — the same
  segment-tabs UI the hand-built Frieren demo uses (also defaulting to Season 1, not
  Season 2, for the same reason), just built from whatever seasons a given series
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
- **Air date formatting:** TVDB gives back bare ISO dates (`2010-10-02`); `formatAirDate`
  in `app.js` renders those as `Oct 2, 2010` instead of showing the raw string. Parsed as
  a local calendar date rather than through `new Date(iso)` directly, since the latter
  treats a date-only ISO string as UTC midnight and can print as the previous day in
  timezones west of UTC.
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

## Sidebar navigation: Library, Calendar, Activity, and Wanted are real links

The top-level sidebar items used to split into two inconsistent behaviors: Library
(`index.html`) was already a real link — clicking it navigates there, and whichever
sub-page you're actually on gets `active`/`open` baked into that page's own HTML.
Calendar, Activity, and Wanted, on the other hand, had `href="#"` and only existed as
JS-driven accordion toggles (`.nav-item.nav-toggle` in `app.js`) — clicking them
`preventDefault()`'d the click and just expanded/collapsed their sub-menu, never
actually taking you anywhere. Calendar didn't even have a sub-menu to expand, so it was
just inert.

- **Activity** now links to `activity-queue.html` and **Wanted** now links to
  `wanted-missing.html` — the same pattern Library already used, dropped straight in:
  `class="nav-item nav-toggle"` became `class="nav-item"`, `href="#"` became the real
  target page, on all 27 pages. Settings and System keep the old JS-toggle behavior
  unchanged (`nav-toggle` still on their `<a>` tags) since neither has an obvious single
  "default" page the way Activity has Queue and Wanted has Missing.
- **Calendar** got the same treatment — `href="#"` became `href="calendar.html"` on all
  27 existing pages, and the new page itself (see below) is what those links actually
  point to now.
- Since Activity/Wanted no longer carry the `nav-toggle` class, `app.js`'s accordion
  click handler (`document.querySelectorAll('.nav-item.nav-toggle')`) no longer touches
  them at all — no code changes needed there beyond the class/href edits themselves.
  Their sub-menus (Queue/History/Blocklist, Missing/Cutoff Unmet) still show as
  expanded/highlighted on their own pages purely from each page's own hardcoded
  `nav-sub open` / `class="active"` markup, exactly like Library's always has.
- This was a same-string-everywhere sweep across all 27 `public/*.html` files (done via
  a small Node script doing literal multi-line string replacement, not sed/regex, since
  the inactive-state markup for Activity/Wanted/Settings/System's `<a>` tags is
  byte-identical apart from the icon path that follows it — a plain single-line match
  would've hit the wrong nav item). Verified by grep counts across all 27 files (54
  `nav-item nav-toggle` occurrences left, all Settings/System; 0 leftover `href="#"` on
  any Activity/Wanted block) plus a jsdom pass confirming the accordion selector no
  longer matches Activity/Wanted on a loaded page.

## Calendar

A real month-grid calendar (`public/calendar.html`) of episode air dates — previously
just an inert sidebar link with no page behind it at all.

- Backed by `GET /api/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD` in `server.js`, which
  reads straight from the `episodes` table (the same cache the series detail page fills
  in on first visit — see the Episode persistence / Metadata search sections above) —
  there's no separate calendar data source. Omitting `start`/`end` defaults to the
  current calendar month. Returns `{ start, end, episodes, uncachedSeriesCount }`, where
  each episode carries its series id/title/poster plus season/episode number and title,
  and `uncachedSeriesCount` is how many series in the Library have no cached episodes at
  all (as opposed to just none falling in the requested range).
- **This means the calendar is only as complete as the episode cache is.** A series
  whose detail page has never been opened has no cached episodes yet, so it contributes
  nothing to the calendar either — a deliberate scope decision (you picked "real data"
  over "real data + auto-warm the whole Library on every Calendar visit" when this was
  built), not a bug. `calendar.html` shows a note naming how many Library series haven't
  loaded their episodes yet whenever that count is above zero, so an emptier-than-
  expected calendar explains itself instead of just looking broken.
- The page itself (`initCalendar()` in `app.js`) renders a fixed 6-week (42-cell) grid
  so the layout doesn't reflow month to month, highlights today's date, and caps each
  day at 3 episode chips with a "+N more" overflow indicator for busy days. Each chip
  links to `series.html?id=...` for that episode's series. Season 0 (TVDB's convention
  for specials) renders as "Special N" instead of "S00E0N". Prev/Next/Today buttons
  re-fetch `/api/calendar` for the newly-selected month; nothing is fetched or cached
  client-side beyond the currently-visible month.
- Verified against seeded episode rows with known air dates spanning three months (a
  day with 5 stacked episodes to check the 3-chip cap and "+2 more", a specials episode
  for the Special-N label, one in the next month, one in a month with nothing at all) —
  correct day-cell placement, today-highlighting, month navigation in both directions,
  the uncached-series count/note, and episode-chip links all checked out.

## Edit Series modal

The series detail page's "Edit" button used to do nothing. It now opens a modal matching
real Sonarr's own "Edit Series" dialog: Monitored, Monitor New Seasons, Use Season
Folder, Quality Profile, Series Type, Path, and Tags, plus a Delete button.

- **New `series` columns** (all added via the same `ALTER TABLE`-if-missing migration
  pattern the rest of the schema uses): `monitor_new_seasons` (`all` / `future` / `none`,
  default `all`), `season_folder` (boolean, default true), `quality_profile` (a name
  string, not a foreign key — see below), `series_type` (`anime` / `standard` / `daily`,
  default `anime`), `path` (nullable text).
- **Quality Profile** is populated from the real `GET /api/settings-items/profiles` list
  (the same data the Settings > Profiles page manages) rather than a hardcoded option
  set — the field stores the profile's `name` directly, the same simple string-not-id
  approach `path` already uses elsewhere in this schema, rather than introducing this
  project's first real foreign key.
- **Path** reuses the exact same File Browser modal component built for Settings > Media
  Management's "Add Root Folder" flow (`initFileBrowserModal()` in `app.js`, a generic
  factory, not root-folder-specific code) — clicking the folder icon opens it, and
  choosing a path just fills the Path input instead of POSTing a new root folder the way
  Add Root Folder's own instance of the same modal does.
- **Tags** are managed through the new `series_tags` join table (see Persistence above):
  selected tags render as removable chips (reusing the `.tag-chip` styling and color
  handling from the Tags settings page), and a "+ Add tag…" dropdown offers whatever
  tags aren't already selected. Nothing is written until Save — chip add/remove only
  touches an in-memory selection, which then goes out as a single `tagIds` array in the
  PATCH body.
- **Save** sends every field (`monitored`, `monitorNewSeasons`, `seasonFolder`,
  `qualityProfile`, `seriesType`, `path`, `tagIds`) in one `PATCH /api/series/:id` call
  and updates the in-memory series object from the response on success — including
  syncing the page header's own separate Monitored toggle, since both controls read and
  write the same field (matching real Sonarr's own UI, which also exposes Monitored in
  two places).
- **Delete**, whether clicked from the page header or from inside the Edit modal, opens
  the same confirmation modal and goes through the same `DELETE /api/series/:id` call —
  there was already a delete flow on this page, so the modal's Delete button just closes
  itself and hands off to it rather than duplicating the confirmation/request logic.
- Verified end-to-end against a real running server (not mocks, since every endpoint
  involved — profiles, tags, series PATCH — already exists for real): pre-filled values
  match a seeded series including its real profile name and tag chips, every field
  change including a path chosen through the file browser and a tag removed/added
  persists correctly through a fresh `GET /api/series`, tag usage counts update after
  save, and both Delete entry points land on the same confirmation modal.

## Grab/download pipeline

Everything downstream of "here's a missing episode" used to be inert: Activity's Queue/
History/Blocklist pages were fixed hardcoded arrays that never changed no matter what you
clicked, Wanted's Search/Search All buttons didn't do anything, and an episode's
missing/downloaded state on the series detail page was a guess computed at render time
from the series' "N / M" episode count rather than anything real per episode. This section
covers turning that into an actual, real, working grab-to-completion loop — the biggest
single piece of work in this pass, and (deliberately) the one place in the app that's
simulated rather than hitting a real external service, explained below.

### Why simulated, not a real indexer/download client

Every other integration in this project (TheTVDB, MyAnimeList, the real filesystem) talks
to something a real Sonarr/Radarr install would also talk to. Indexers and download
clients are different: a real indexer means a real torrent/usenet tracker, and a real
download client means actually pulling files down. Reaching either of those from this
sandbox isn't something to do even if it were possible — it's a different kind of
integration than "call a documented metadata API," and out of scope for a mockup. So the
whole search → grab → download → import loop is simulated end-to-end, entirely inside
`server.js`, with no outbound network calls at all for this part. Whether real
indexer/download-client integration is ever wanted for this project is one of the open
questions in `QUESTIONS.md`.

### Episodes carry real download state now

`episodes` gained three columns: `downloaded` (boolean), `quality`, `size_bytes`. Before
this, "is this episode downloaded" was never stored anywhere — the series detail page
guessed it from comparing an episode's position in the list against the series' `eps`
("N / M") count, which is why a real per-episode state (what quality, what file size) never
existed at all.

- **Backfill, once, at cache time:** the first time a series' episodes are fetched and
  cached from TVDB (see Metadata search above), `backfillDownloadedState()` in
  `episodes.js` runs the same kind of "N / M" heuristic exactly once to mark that many of
  the earliest episodes downloaded, picking each a realistic quality/size via a seeded RNG
  (see Release generation below) so a freshly-added series doesn't look emptier than the
  Library card claims. After that one-time backfill, it never runs again for that series —
  every subsequent state change is a real grab completing (see below), not a re-guess.
- `GET /api/series/:id/episodes` returns each episode's real `downloaded`/`quality`/
  `sizeBytes` now, whether it's serving from cache or triggering a fresh fetch (both paths
  re-query the DB through the same `loadCachedEpisodes()` helper, so they can't drift into
  returning different shapes).
- `library.js`'s episode rows on the series detail page now render from these real fields
  (`e.downloaded`, `e.quality`) instead of the old position-vs-count guess, and missing
  rows get a working Search button (see Release picker below) instead of a purely
  cosmetic pill.

### Queue, History, Blocklist — three new tables, `server/routes/queue.js` /
`history.js` / `blocklist.js`

- **`queue`** — one row per in-flight grab (series/episode, release title, quality, size,
  indexer, protocol, `status` — `downloading` / `paused` / `warning` — and
  `progress_pct`). `POST /api/queue` (body: `episodeId`, `releaseIndex`) creates a row,
  rejects a duplicate grab of the same episode with 409, and writes a `grabbed` History
  row immediately. `PATCH /api/queue/:id` toggles `downloading`/`paused` (Activity >
  Queue's pause/resume). `DELETE /api/queue/:id` removes it outright (Queue's "Remove" —
  no History entry, same as real Sonarr's plain remove vs. "remove and blocklist").
- **The simulated downloader** is a `setInterval` ticker in `queue.js` (every 1.5s) that
  advances every `downloading` row's `progress_pct` by a random 8–22 per tick. On reaching
  100%, each row resolves one of two ways:
  - **Success (92% of the time):** the episode's `downloaded`/`quality`/`size_bytes`
    columns get set for real, the series' `eps`/`pct` get recomputed
    (`recomputeSeriesEpisodeStats`), and an `imported` History row is written. This is what
    makes a completed grab actually disappear from Wanted Missing and show as downloaded
    everywhere else.
  - **Failure (8% of the time):** a `failed` History row and a **Blocklist** row are
    written instead (release title, reason, indexer — what Activity > Blocklist shows),
    and the episode stays not-downloaded, so it's still on Wanted Missing afterward, ready
    to be searched and grabbed again.
  - **The 8% number is a guess**, not something read off real Sonarr — it exists so the
    failure path (and Blocklist) has something to actually show, not because 8% reflects
    any real download-failure rate.
  - **~10% of fresh grabs start in `warning` status** instead of `downloading` (mirroring
    a real Sonarr queue row stuck on a client-side issue — wrong category, disk full, etc.)
    and never auto-progress. **Known gap:** an episode stuck behind a `warning`-status
    queue row still shows as "Missing" with an active Search button on the series detail
    page (only `downloading` rows are treated as "in progress" there) — clicking Search
    again just hits the same 409 duplicate-grab check, surfaced as an error in the release
    picker rather than crashing anything, but the row itself doesn't visibly reflect that
    it's stuck. Left as-is under the overnight time constraint; noted in `QUESTIONS.md`.
- **`history`** — append-only, pruned to the newest 500 rows (same pattern the `logs`
  table already used). `GET /api/history?type=grabbed|imported|failed|deleted&limit=N`
  backs Activity > History's filter tabs.
- **`blocklist`** — `GET /api/blocklist`, `DELETE /api/blocklist/:id` (Activity >
  Blocklist's own "Remove" button).

### Release generation (`server/lib/queue-sim.js`) and the release picker

`GET /api/releases?episodeId=N` returns 5 fake candidate releases for that episode —
title, quality, size, indexer, protocol, seeders — generated by a `mulberry32`-seeded RNG
keyed off the series/episode, so **searching the same episode twice returns the same
candidates** rather than reshuffling randomly every time (the same "seeded, not random"
approach the backfill above reuses). Release titles alternate fansub-style
(`[Group] Title - 12 (1080p) [HASH]`) and scene-style (`Title.S02E12.1080p.WEB.h264-GROUP`)
roughly 50/50, and quality is picked from a weighted distribution skewed toward
`WEBDL-1080p` — anime fansub/streaming releases are disproportionately 1080p WEBDL in
practice, more than a generic TV-release quality mix would be. Results are sorted
best-quality-first (ties broken by smaller file size).

- **`public/js/lib/release-picker-modal.js`** is the new UI for this — a "Search" click on
  a missing episode (series detail page, or either Wanted page) opens a modal listing the
  5 candidates with a Grab button on each; grabbing calls `POST /api/queue` and closes the
  modal. It's built entirely via `document.createElement`/`innerHTML` in JS, appended to
  `<body>` once, with **zero static HTML** needed on any page that uses it — a deliberate
  choice, made right after documenting (see the page-tabs section above) that the existing
  `file-browser-modal.js` still requires every page to paste in its own static
  `.modal-overlay` shell. Same problem, not fixed there yet, avoided here from the start
  instead of repeated a third time.
- **A subtle indexing bug caught before it shipped:** `generateReleases()` gives each
  release an `index` reflecting its *pre-sort* generation order, but `POST /api/queue`
  looks up `releases[releaseIndex]` — a plain position lookup into the *already-sorted*
  array it regenerates server-side. The modal originally sent back a release's `index`
  field instead of its position in the sorted list it was rendering, which would grab the
  wrong release whenever those two didn't match. Fixed to send the rendered position
  instead, and re-verified (grab index 0, confirm the exact release that landed in History
  matches the one shown first in the modal).
- **Search All** (both Wanted pages) grabs every currently-listed episode's best (index 0)
  release, sequentially, then reloads.

### Wanted Missing / Cutoff Unmet — real queries (`server/routes/wanted.js`)

Both pages used to be five/three hardcoded rows apiece. Now:

- **Missing:** aired-but-not-downloaded episodes of monitored series
  (`downloaded = 0 AND aired <= today`), oldest-first — the same definition real Sonarr's
  Wanted > Missing uses.
- **Cutoff Unmet:** downloaded episodes of monitored series whose quality ranks below
  their series' quality profile's cutoff. Quality comparison goes through a new
  `server/lib/quality.js` (`QUALITY_ORDER`, matching the exact tier order already shown on
  Settings > Quality, `isBelowCutoff()`), shared with the backfill/release-generation code
  above so every part of the app ranks quality the same way. A series with no quality
  profile assigned, or one that no longer matches anything under Settings > Profiles, is
  skipped rather than guessed at.

### System > Status — real process/library info

The Info card used to be eight hardcoded values (a version that never changed, a made-up
uptime, etc.). `GET /api/system/status` (`server/routes/system.js`) now returns the real
package version, real process uptime/start time (tracked from when `server.js` itself
started), the real Node version and OS (`os.type()`/`os.release()`/`os.arch()`), real
Library/episode counts, and live free-space for every configured root folder (recomputed
fresh per request, not the cached value stored on a root folder at add time — see Root
folders above). The page's Health card stays synthetic — Indexers/Download
Clients/Import Lists are saved field values, not real connections (same as everywhere
else in Settings), so there's nothing real to health-check against yet.

### Verification

Checked end-to-end against a real running server (no mocks needed for this part — it's
all internal) plus a local TVDB mock for seeding episodes: added several series, fetched
their episodes (triggering backfill), grabbed every episode Wanted Missing listed (72
across 6 series in the largest run), and let the real 1.5s ticker run to completion. Result
across that run: 56 succeeded (episode flipped to downloaded with real quality/size,
`imported` History row, dropped off Wanted Missing), 7 hit the simulated failure path
(`failed` History row + a matching Blocklist row, episode stayed on Wanted Missing), and 9
landed in the known `warning`-status gap above (never auto-progress, stayed in the queue
and on Wanted Missing) — 56 + 7 + 9 accounts for all 72, and Wanted Missing's count after
the run dropped by exactly 56, matching the success count precisely. Also spot-checked a
single grab in isolation: the episode's `downloaded`/`quality`/`sizeBytes` fields after
completion matched the release that was actually grabbed. Pause/resume and remove were
checked separately against the queue endpoints directly. The full 28-page jsdom regression
suite (see Code structure above) was re-run after every change in this section and passed
28/28 each time, including a dedicated check that System > Status renders real fetched
values into the DOM rather than its old placeholders.

## Quality Definitions redesign

Settings > Quality used to be a flat table of 12 rows, each three plain number boxes
(Min/Preferred/Max, in MB per minute of runtime) — functional, but exactly the kind of
"do the bitrate math yourself" UI real Sonarr/Radarr are often criticized for. This
section covers the replacement: tiers grouped into collapsible accordions by resolution,
each edited through a single 3-handle slider instead of three boxes, real file-size
readouts instead of a raw rate, and presets — plus a bigger change underneath the UI that
the redesign surfaced was worth doing anyway: quality tiers
themselves are fully user-managed now (add, rename, delete, reorder), not a fixed list of
11 names baked into the server.

### Tiers are data now, not a hardcoded array

`server/lib/quality.js` used to export a literal `QUALITY_ORDER` array — the single
fixed list every other part of the app (Cutoff Unmet, the simulated release generator's
quality weighting) compared against. That's gone. Quality tiers are now rows in the same
`settings_items` table every other list-style Settings page already uses (Indexers,
Profiles, Root Folders, etc. — see Persistence above), under a new `quality-tiers`
section, seeded on first run with the same 11 tiers the old table had (SDTV through
Bluray-2160p, each carrying its `resolutionGroup` and starting min/preferred/max — the
one pre-existing inconsistency this fixed in passing: the old table also had a "DVD" row
that was never actually part of `QUALITY_ORDER`, so it never affected Cutoff Unmet or
release generation despite looking like it should; dropped from the new seed, and easy to
add back for real through "Add Quality" if it's wanted).

- **Rank is a row's `position`.** The existing `settings_items` table already had a
  `position` column for display order; for `quality-tiers` specifically, that same column
  now doubles as cutoff rank — worst tier first. `quality.js`'s `getQualityOrder()`/
  `qualityRank()`/`isBelowCutoff()` all query the live table (`ORDER BY position ASC`) on
  every call instead of reading a cached constant, so a tier added, renamed, deleted, or
  reordered from the page takes effect everywhere immediately — Cutoff Unmet, and the
  release generator's best-quality-first sort — with nothing to invalidate. It's a small
  table (a dozen-ish rows even heavily customized) read with a plain indexed query, so
  this costs nothing measurable; caching it would just reintroduce the exact "two things
  can disagree" problem this rewrite exists to remove.
- **Reordering needed a small generic addition to `settings-items.js`.** The existing
  `PATCH /api/settings-items/:section/:id` only ever merged fields into a row's JSON
  `data` blob — there was no way to change the `position` column itself. `position` is
  now a reserved key in the PATCH body: if present, it updates the column directly instead
  of being folded into `data` (and `GET`'s `rowToItem` now always includes the real
  `position` value in its response, listed last so it can't be shadowed by a same-named
  data field). This is generic, not Quality-specific — any other list-style Settings page
  could reorder itself the same way later.
- **`server/lib/queue-sim.js` had two hardcoded per-name tables** — `QUALITY_WEIGHTS`
  (how often each tier gets picked for a fake release) and `BASE_SIZE_MB` (roughly
  realistic file size per tier) — that couldn't keep working once tiers stopped being a
  fixed set of names. Both are derived from the live tier list now:
  - **Weight is by resolution group**, not by exact tier name: a small `GROUP_WEIGHT`
    table (`SD`/`720p`/`1080p`/`2160p`, 1080p weighted heaviest, matching anime's real
    skew toward WEBDL-1080p releases) applies per tier within its group, so a group with
    more tiers defined shows up proportionally more without diluting the group as a
    whole, and a custom group a user invents gets a flat default weight — present, not
    dominant, without needing to know its name in advance. This does lose the old table's
    finer per-name distinctions (e.g. WEBDL-720p being weighted higher than HDTV-720p
    specifically) — an accepted simplification, since that distinction can't generalize
    to tiers that don't exist yet.
  - **Size comes straight from the tier's own Preferred value** — `preferredMBPerMin x`
    a fixed 24-minute reference episode length (a typical anime TV episode) — instead of
    a second, separate "realistic size" table that could quietly drift from whatever's
    actually configured on the page. Whatever a tier's target size says on Settings >
    Quality is what a simulated release of that quality weighs in at (+/-15% jitter so
    same-quality releases from different fansub groups don't all report byte-identical
    sizes). One number now, not two — a nice side effect of the redesign, not something
    that was specifically asked for.
  - **Degenerate case (every tier deleted):** `pickRealisticQuality` returns `'Unknown'`
    rather than throwing, `qualityRank`/`isBelowCutoff` treat it as unranked the same way
    they already treated any unrecognized name, and `generateReleases` still returns 5
    candidates (all `'Unknown'`) instead of crashing. Verified directly (see Verification
    below) — an unlikely thing for a real user to do, but it shouldn't be able to break
    the app if they did.

### The 3-handle range slider (`public/js/lib/range-slider.js`)

A native `<input type="range">` only ever supports one handle (two with browser-specific
tricks, never three), so this is hand-built with pointer events: a factory function
(`mountRangeSlider(container, options)`) mounted once per tier row, all sharing one
implementation rather than three near-copies of drag/keyboard/tooltip logic — same
one-component instinct this project already applied to `file-browser-modal.js`/
`release-picker-modal.js`.

- **Three handles**: a circular Min handle and Max handle (color-coded warning/danger —
  see Colors below), and a small rotated-square Preferred handle in between, clamped so
  dragging one can't cross another (`min <= preferred <= max`). All three are draggable —
  Preferred isn't just an informational marker, since the underlying data model already
  had three independent values to begin with.
- **Unlimited** is a checkbox next to the Max label, not a separate control bolted on:
  checking it disables/dims the Max handle and the slider's fill extends to the track's
  end; the handle's last real numeric position is preserved underneath so unchecking it
  restores a sensible value instead of resetting to zero.
- **Keyboard accessible**: each handle is a real `tabindex="0"` element with
  `role="slider"`; arrow keys nudge the focused handle by one step under the same
  clamping rules a drag uses.
- **Per-row bounds, not one shared scale**: an SDTV row and a Bluray-2160p row differ by
  10x or more, so sharing one global slider range would squeeze small tiers into a sliver
  of the track. Each row's bounds are computed from that tier's own current values
  (`max(current max, current preferred) * 1.6`, rounded), so every row's handles use the
  full width of its own track regardless of scale.
- **Colors**: this app's palette (`public/styles.css`'s `:root` variables) has no blue —
  the reference mockup's orange/blue/red handle scheme became `--warning` (Min),
  `--accent` (Preferred — the app's own brand orange, reused here as "the one that
  matters most"), `--danger` (Max), staying inside the existing design system instead of
  introducing a color nothing else in the app uses.

### Display: Reference Runtime, units, and why the canonical unit didn't change

The underlying stored value per tier was always MB per minute of runtime — a
duration-independent rate, not tied to any specific episode length — and stays exactly
that; only how it's *displayed* changed. A **Reference Runtime** selector (12 min short /
24 min standard episode / 45 min extended episode-OVA — deliberately anime-episode-length
options, not a movie runtime, since Movies aren't in scope for this app — see
`QUESTIONS.md`) and a **Display** toggle (Estimated File Size vs. raw Rate) turn that same
stored number into either `formatBytes(mbPerMin x runtimeMinutes x 1024 x 1024)` — reusing
the exact formatter Activity/the release picker already use for downloaded file sizes, see
Grab/download pipeline above — or the plain rate. Both are page-display preferences, not
tier data, saved separately via a small `/api/app-settings/quality-ui-prefs` blob (the
same field/toggle-style `app_settings` shape every other Settings preference already
uses), so switching units doesn't touch a single tier's actual saved values.

### Presets

Doesn't exist in real Sonarr — this is the redesign's own invention, per an explicit
"pick reasonable numbers yourself" from the person who asked for this feature, so the
specific multipliers below are a starting point, not a researched target.

**Presets** (Storage Saver / Balanced / High Bitrate-Quality / Uncompressed-Remux Focus)
are flat multipliers (0.6x / 1.0x / 1.6x / 2.4x) applied against each tier's *original
seed* min/preferred/max for the 11 known tier names (a small `KNOWN_TIER_DEFAULTS` table
in `settings-quality.js`, deliberately duplicated from the server-side seed rather than
fetched, just for this) — a custom tier with no matching name scales from its own current
values instead, so presets still do something reasonable for it without recognizing it by
name. Remux Focus additionally forces Max to Unlimited on the 1080p/2160p groups.
Selecting a preset is a one-time jump to a set of values, not a persistent mode — the
dropdown resets to "Custom" right after applying.

An earlier version of this page also had a global "Bitrate Scale" slider that
proportionally resized every tier's min/preferred/max at once — removed after feedback
that it wasn't worth having for something set up once and rarely adjusted again. It also
surfaced a real bug worth noting for the record: each row's slider computes its own track
bounds once, sized to that tier's values at mount time (see Rendering below); scaling
every tier up at once could push values past those original bounds, leaving a handle
visually pinned at the track's edge even though the real stored value kept climbing
underneath it. Fixed at the time by calling the slider's `setBounds()` before every
`setValue()` so the track always had headroom for whatever it was about to show — worth
remembering if per-row bounds-recalculation is ever needed again elsewhere (a preset
applying a very large multiplier, for instance, hits the exact same class of problem, but
since a preset's `renderAll()` remounts every slider fresh with bounds computed from the
already-final values, it never actually hits the bug in practice).

### Add Quality modal

The button used to add a tier by itself, with no chance to say anything about it first —
"New Quality N", hardcoded into the 1080p group, with the same flat 10/100/150 starting
min/preferred/max regardless of what it actually was, since the button had no idea what
you were about to add. Clicking it now opens a small modal asking for a name and a
resolution group before anything gets created.

- **JS-generated, not a static page shell**: same approach `release-picker-modal.js`
  uses (built once, appended to `<body>`, nothing pasted into
  `public/settings-quality.html`) rather than `file-browser-modal.js`'s older pattern of
  every page providing its own copy of the modal markup — this one is only ever used from
  this one page, so it's built directly inside `settings-quality.js` rather than as a
  separate `lib/` file the way the multi-page release picker needed to be.
- **Resolution group** is the same free-text-plus-`<datalist>` input every tier row
  already uses (see Grouping below) — typing an existing group's name (or picking it from
  the autocomplete) adds the tier there; typing anything else starts a brand-new group,
  same as renaming a tier's group already did.
- **Starting values scale with the chosen group** instead of always being the same flat
  numbers: a small `GROUP_STARTING_DEFAULTS` table gives SD/720p/1080p/2160p each a
  sensible starting min/preferred/max (a brand-new 2160p tier doesn't start out looking
  absurdly small next to its siblings the way a flat 10/100/150 would), and a custom group
  name falls back to the original flat default. These are still just a starting point —
  the point of the redesign is that the slider on the row itself is where these actually
  get tuned, not that the modal needs to get them exactly right.
- **Validation**: an empty name is rejected, and a name that already exists (checked
  case-insensitively against the current tier list) is rejected too, both with an inline
  message in the modal rather than silently doing nothing or creating a confusing
  duplicate.

### Repositioning a single tier's whole window

Each tier's min/preferred/max is edited with its own 3-handle slider (see the Slider
component section above) — dragging the min or max handle resizes that edge independently,
same as it always has. But there was no way to move a tier's *entire* range without
touching every handle: dragging the target (preferred) handle used to just slide it around
inside a fixed min/max span, so nudging, say, HDTV-1080p's whole window 20 MB/min higher
meant dragging min, then preferred, then max, one at a time, and preferred could never even
pass max since it was clamped inside it.

Dragging (or keyboard-nudging) the target handle now translates the whole window instead:
min and max shift by the same amount as preferred, keeping their original distance from it,
so the tier's range moves as one unit and its width never changes. `range-slider.js`'s new
`moveWindow(newPreferred)` helper computes the delta, applies it to all three values, and
clamps the whole translate to the track's own outer bounds (so a window can't be dragged
past the edge and lose its width) rather than letting min/max clamp independently the way
they still do on their own handles. Confirmed via a jsdom-simulated drag directly against
the component (with `getBoundingClientRect` stubbed for a fixed track width, since jsdom
does no real layout): dragging the target handle moves min and max by the exact same delta
and preserves the window's width; dragging min or max alone still only moves that one edge
and leaves preferred and the other edge untouched; and dragging the target handle toward
either edge of the track clamps the whole window there without exceeding the track's bounds
or losing its width. The full page-load regression check for `settings-quality.html` was
also re-run against the real project files afterward with no errors.

Separately, committing a slider change (a drag release, a keyboard nudge release, or the
typed edit below) now re-renders the whole page instead of just patching the server:
`commitSliderChange` in `settings-quality.js` calls `renderAll()` after saving, which
remounts every slider with its track bounds (`boundsForTier`) recomputed from the tier's
now-current values. Bounds were previously only ever set once, at initial page load — so
dragging a tier's whole window down to something much smaller than it started (SDTV's
default max is 100 MB/min, giving it an ~160 MB/min track) left the handles visually
bunched on one side of a track still sized for the old, larger numbers instead of the track
shrinking to fit. Confirmed by dragging a tier's window down via its target handle against
the real server and checking the remounted handle positions land where the new,
recomputed bounds put them, not where the stale pre-drag bounds would have.

### Typing an exact value

Dragging is fine for a rough position but can't land on an exact number, especially on a
track sized very differently per tier. Double-clicking any handle now opens a small text
box, pre-filled with that handle's current value formatted exactly like its tooltip (in
whichever of Rate or Estimated File Size the page's Display toggle is currently set to), so
what's shown is what you can just retype over. Enter or clicking away commits it; Escape
cancels without changing anything.

- **Min/max**: typing a value that stays on the correct side of the target is a plain
  resize of just that edge — same as dragging it. But typing a value that would cross the
  target (a new min above the current target, or a new max below it) doesn't get silently
  clamped back down to the old target the way a drag would; it carries the target (and the
  far edge) along instead, translating the whole window and preserving whatever
  min-to-target and target-to-max gaps it already had. `range-slider.js`'s `moveWindow`
  helper from the previous section got generalized into `translateWindowTo(anchor,
  anchorValue, clampToTrack)` for this — anchor is whichever handle was edited, not always
  preferred.
- **Target**: typing a value always translates the whole window, same as dragging it —
  `commitTypedValue` just calls `translateWindowTo('preferred', v, false)` directly, no new
  logic needed.
- **The one real difference from a drag**: typed edits pass `clampToTrack: false`. A drag
  is capped at the edge of its own rendered track because that's a real physical limit —
  you can't drag a handle past a pixel that isn't there. A typed number has no such limit;
  the track's current bounds are just `boundsForTier()`'s guess based on the *previous*
  values, not a constraint on the data. Clamping a typed value to the old track bounds
  produced exactly the bug from the section above: typing an intentionally large number got
  silently capped to whatever the stale track happened to allow. Typed commits skip that
  clamp (keeping only a floor at zero) and rely on the `renderAll()` bounds-recompute above
  to resize the track to fit afterward.
- **Unit-aware parsing**: `settings-quality.js`'s `parseValue()` is the reverse of
  `formatValue()` — a bare number in Rate mode is taken as raw MB/min directly; in Size
  mode it's parsed for an optional `MB`/`GB`/`KB` suffix (defaulting to MB if you type a
  bare number, since that's the common case for episode sizes) and converted back through
  the Reference Runtime to raw MB/min, so it round-trips through whatever unit is currently
  on screen.
- Double-clicking the max handle while its tier is set to Unlimited does nothing — there's
  no numeric value to type over in that state, same as dragging is already disabled for it.

Verified with a jsdom test running against a real server (not just the isolated component):
double-click opens the box pre-filled with a unit-suffixed value; typing a min that stays
below target only changes min; typing a min that crosses target moves min to the typed
number and preserves both gaps exactly, confirmed against the persisted server record;
typing a target value shifts min and max by the identical delta; Escape leaves the
persisted value untouched; and double-clicking an Unlimited tier's max handle doesn't open
an editor. The full 28-page regression sweep was re-run afterward and passed clean.

**Real-browser bugs found after that (jsdom couldn't have caught either one):**
double-click didn't actually work in an actual browser at first, despite every jsdom test
above passing, because jsdom's `dblclick` tests dispatched that event directly rather than
simulating two real clicks in sequence — so neither of the following was ever exercised:

1. First guess: `startDrag()`'s pointerdown handler called `e.preventDefault()`
   unconditionally (to stop text selection while dragging), and per the Pointer Events
   spec, canceling a `pointerdown` for a touch/pen pointer suppresses the browser's
   *synthesized* compatibility mouse events that would otherwise follow — including
   `click`/`dblclick`. Dropped it and added `user-select: none` to `.rs-handle` in
   `styles.css` instead (touch scrolling was already separately handled by
   `touch-action: none` on the same rule). Reasonable cleanup, but it turned out this
   suppression only applies to touch/pen input, not a real mouse — so on its own this
   wasn't actually why a mouse double-click was failing.
2. **The actual cause**: `startDrag()`'s `up()` handler fires `onCommit` on *every*
   pointerup, including a plain click with zero movement — previously harmless, since
   `onCommit` only did an idempotent PATCH. But `commitSliderChange` in
   `settings-quality.js` now also calls `renderAll()` on every commit (see the
   bounds-recompute fix above), which tears down and rebuilds every tier row's DOM,
   including the handle you just clicked. So the *first* click of a double-click was
   destroying and replacing the handle element before the *second* click could land on it
   — the second click hit a brand-new DOM node the browser had never seen a first click on,
   so it never registered as a double-click at all, on every attempt, consistently. Fixed
   by snapshotting the slider's value at pointerdown and only firing `onCommit` if it
   actually changed by pointerup, so a no-op click no longer triggers a re-render. Verified
   directly: dispatching a real pointerdown/pointerup with no movement now leaves the exact
   same DOM node in place afterward (previously failed this check); two full
   pointerdown/pointerup cycles followed by `dblclick` on that same surviving node opens
   the editor; and an actual drag with real movement still commits and persists like
   before. The full 28-page regression sweep passed clean afterward too.

**A third bug, found from an actual screenshot of it happening:** editing the target
handle on a GB-scale tier could make its minimum collapse to 0 MB. The box pre-fills with
something like "1.48 GB" and `input.select()` selects the whole thing, so the obvious way
to edit it is to just type a replacement number over the selection — "3", meaning 3 GB.
But `parseValue()` in `settings-quality.js` defaulted *any* bare number with no unit
suffix to MB, so that "3" was silently read back as 3 MB instead — a value far below the
tier's actual minimum (e.g. 840 MB). That's exactly the "crosses the far edge" case
`commitTypedValue` handles by translating the whole window (see "Typing an exact value"
above), and the translate's zero-floor (a window can't push min below 0) landed min at
precisely 0 to accommodate it — which is mathematically the correct response to a target
of 3 MB, just not to what the person actually meant. Fixed by having `openEditor` in
`range-slider.js` remember the unit suffix the box was *pre-filled* with (stashed as
`input.dataset.defaultUnit`) and passing it through to `options.parse(text, defaultUnit)`
as the fallback when the typed text has none of its own — so a bare number retyped over a
GB-scale value stays in GB instead of silently dropping three orders of magnitude to MB.
Verified by reproducing the exact reported scenario end-to-end: PATCHing a tier to
min≈840 MB/preferred≈1.48 GB directly (matching the screenshots), confirming the
pre-filled box reads "1.48 GB" with a remembered default unit of "GB", then typing a bare
"3" and confirming the persisted result lands at ≈3 GB (not ≈3 MB) with min translated up
alongside it rather than collapsing to 0. The full 28-page regression sweep passed clean
afterward too.

### Minimum gap between min/max and the target

A fourth bug, found by just directly dragging a handle: nothing stopped min from being
dragged (or typed) all the way up to *exactly* equal preferred, or max all the way down to
it. When that happened the two handles landed on the exact same pixel — and since
preferred renders on top (higher `z-index`, so it always reads as the "front" handle), the
other one ended up invisibly stuck underneath it, with no way to grab it again: clicking or
double-clicking that spot only ever hit preferred.

Fixed with a minimum enforced distance, `minGap()`, between min-and-preferred and
preferred-and-max — 3% of the *track's own value range*, or `step`, whichever is bigger.
A fraction of the range rather than a fixed raw number matters here for the same reason
`boundsForTier()` gives every tier its own track scale: a fixed gap of, say, 5 MB/min would
be generous on an SDTV-scale track and practically invisible on a 2160p-scale one, whereas
3% of the range maps onto the same 3% of on-screen pixel width regardless of which tier's
numbers it is. Every path that can move min or max now routes through it: dragging and the
keyboard nudge (`clampForHandle`), a typed edit (`commitTypedValue`'s crossing threshold
moved from "past preferred" to "within minGap() of preferred"), and un-toggling Unlimited
(max used to snap back to exactly `preferred` as its floor, now snaps to `preferred +
minGap()` instead). A defensive `enforceGaps()` also runs on mount, on `setValue()`, and
on `setBounds()`, in case a tier's stored data already violates it — a `setBounds()` call
in particular can shrink the *absolute* size of a 3%-of-range gap without any handle having
moved at all, so it has to re-check too. Verified directly: dragging min or max as far as
possible toward preferred now always leaves a measurable gap instead of landing on it
exactly, typing a value at (or past) preferred is treated as a crossing rather than an
exact-overlap resize, and toggling Unlimited off snaps max back above preferred with room
to spare rather than flush against it. The full 28-page regression sweep passed clean
afterward too.

### Target handle getting stuck once min hits 0

A fifth bug: once a tier's minimum was dragged (or typed) down to exactly 0, the target
handle would get completely stuck — dragging it left did nothing, typing a lower number
did nothing, not even the keyboard nudge worked. `translateWindowTo`'s floor for how far
preferred could move was computed as `bounds.min + minOffset`, where `minOffset` is
min's *current* distance from preferred. That's the right idea in general — it's meant to
stop a translate from pushing min negative — but once min was already sitting at exactly
0, `minOffset` **equals preferred's own current value**, which silently turned the floor
into "preferred can never decrease," for as long as min stayed at 0. Every path that moves
preferred (drag, keyboard, typed edit) shares this one function, so all three were stuck
the same way.

Fixed by no longer deriving preferred's own floor/ceiling from min and max's *current*
distance at all. `translateWindowTo` now moves preferred first — capped only by the
track's real pixel bounds for a drag, or left essentially uncapped for a typed value, same
as before — and *then* places min and max by trying to preserve their old distance from
it, each clamped independently against its own real limit (0 for min; the track's top, or
nothing at all for a typed edit, for max) and `minGap()` from wherever preferred ended up.
If preserving the old gap isn't possible without going negative, that edge just sticks at
its own limit and the gap between it and preferred shrinks — the translate still happens,
instead of refusing to move at all. Verified directly against the reported scenario: with
min pinned at 0, both dragging the target left and double-click-typing a lower target
value now actually move it, with min staying at (not below) 0 either way. Re-checked the
three behaviors this rewrite touches most directly — a normal (non-boundary) drag still
preserves the window's width exactly as before, a typed value still isn't capped by a
stale track's old bounds, and the minGap buffer from the section above is still enforced —
plus the full 28-page regression sweep, all still clean.

### Grouping and reordering

Tiers are grouped into accordions by `resolutionGroup` — a free-text field per tier (with
a `<datalist>` autocompleting the four common values plus whatever custom groups already
exist) rather than a separately-managed list of groups: a group is just whatever distinct
`resolutionGroup` values happen to be present across the current tiers, so creating a
"first tier in a brand-new group" just works without a separate "create group" step
anywhere. SD/720p/1080p/2160p always sort first in that fixed order when present; any
custom group name sorts after, alphabetically.

The Up/Down buttons on each row move a tier's *global* rank by one — swapping `position`
with whichever tier is immediately better/worse in the full flat list, regardless of
which resolution group that neighbor happens to display under. Rank has to be global
(it's what Cutoff Unmet compares against across every tier, not just within one
resolution), even though the page presents tiers grouped visually — a tier can visibly
jump from one accordion group into another when moved past a boundary, which is correct
given what rank actually means, if not the very first thing a "move up" button suggests.

### Verification

Checked directly against `server/lib/quality.js` and `queue-sim.js` (requiring them
against a real scratch database, no HTTP layer needed for this part): seeded state
matches the 11-tier default; reordering a tier via a raw `position` update immediately
changes `getQualityOrder()`'s result and flips `isBelowCutoff()` comparisons that depend
on it; deleting every tier degrades to the "Unknown"/unranked fallback everywhere instead
of throwing (see Degenerate case above). Also checked the full CRUD surface end-to-end
over real HTTP (add, patch values, patch position, delete) against a running server, and
confirmed `generateReleases()` picks up a freshly-added custom tier without error.

On the frontend: loaded `settings-quality.html` in the same per-page-subprocess jsdom
harness the rest of this project uses (see Code structure above), confirmed the 11 seeded
tiers render into the correct 4 accordion groups with 11 mounted sliders and populated
target-size readouts, then exercised Remove and a rank reorder through real simulated
clicks — each one a real network round trip, with the reorder specifically confirmed to
have actually persisted via a fresh `GET` afterward rather than just updating the DOM.

The Add Quality modal was checked separately: clicking the button opens the modal without
adding anything; confirming with an empty name is rejected inline and adds nothing;
confirming with a name that already exists is rejected inline and a follow-up `GET`
confirms only the one original tier is still present; and a real add ("WEBRip-1080p" in
group "1080p") closes the modal and a follow-up `GET` confirms the new row exists with the
1080p group's starting defaults (`minMBPerMin: 15, preferredMBPerMin: 170,
maxMBPerMin: 230`), not the old flat 10/100/150. The full 28-page regression suite was
re-run against both a scratch copy and the real project files directly and passed 28/28
both times.

## Download Clients: real qBittorrent/NZBGet connections

Every other part of the app that could plausibly reach a real external service (TheTVDB,
MyAnimeList, the real filesystem) does — with one deliberate exception explained in Grab/
download pipeline above: the whole search → grab → download → import loop is simulated
end-to-end, entirely inside `server.js`, because a real indexer/download client means
actually reaching a real torrent/usenet tracker, which is out of scope for this project.

Settings > Download Clients carves out one narrower exception to that: it now makes real
network calls to a real qBittorrent or NZBGet instance for connection testing, rather than
simulating a Test button like Indexers/Import Lists/Connect still do. It does *not* change
how a grab actually gets downloaded — `queue-sim.js`'s simulated pipeline is untouched, and
grabbed releases still aren't pushed to a real client. This is specifically about proving
Kitsune can reach a real download client's API, the first real step toward that pipeline
eventually submitting to one for real.

### Why this one integration is real and the grab pipeline still isn't

A Test button is a single, bounded, read-only-ish call (log in, ask for a version) against
a client the person configuring it already has running for their own reasons — much closer
to "call a documented API" (TheTVDB, MyAnimeList) than "search a real indexer," which would
mean this sandbox reaching real torrent/usenet trackers. Real indexer search and real
release submission remain out of scope for the same reasons Grab/download pipeline gives;
this section is narrower than that by design.

### `server/lib/download-clients/qbittorrent.js` and `nzbget.js`

Two small clients, one per protocol, each exporting a single `testConnection(config)`:

- **qBittorrent** — WebUI auth is a cookie session, not a bearer token: `POST
  /api/v2/auth/login` (form-encoded username/password) returns the plain-text body `Ok.`
  plus a `SID` cookie on success, or `Ok.`'s failure counterpart `Fails.` on bad
  credentials. The cookie is then sent back on `GET /api/v2/app/version` to confirm the
  session actually works, not just that login returned success — qBittorrent's own version
  string already comes back prefixed (`v4.5.2`), which mattered later (see the double-`v`
  bug below).
- **NZBGet** — its JSON-RPC API is simpler: one endpoint (`/jsonrpc`), HTTP Basic auth on
  every call (no session), positional params, no batching. `testConnection` calls the
  `version` method, the lightest call that both proves the credentials work and returns
  something to show — NZBGet's version string comes back bare (`21.1`), no `v` prefix.
- Both wrap every `fetch` in an 8-second timeout (`AbortController`), normalized to a plain
  `Error` either way (timeout or connection failure) so a client that's just unreachable
  fails fast and clearly instead of hanging the Test button or throwing an
  `AbortError`-shaped message the UI wouldn't format sensibly.
- Neither one submits a torrent/NZB, polls a queue, or imports anything — `testConnection`
  is the entire surface area right now, matching the narrower scope above.

### Schema: real per-client fields, not the generic connections shape

Every other list-style Settings section (Indexers, Import Lists, Connect) still stores
`name`/`protocol`/`meta`/`priority`/`status` in the shared `settings_items` table (see
Persistence) — a deliberately generic shape since a Test button there is just a timeout, not
a real call needing real fields. Download Clients' seed rows in
`server/routes/settings-items.js` were replaced with the actual fields Sonarr/Radarr's own
settings screens use: `type` (`qbittorrent` | `nzbget`, selects which client module handles
Test), `host`, `port`, `useSsl`, `username`, `password`, `category` (must already exist on
the client — Kitsune doesn't create categories), `clientPriority` (lower runs first across
multiple enabled clients), plus qBittorrent-only `initialState`/`contentLayout`/
`sequentialOrder`/`firstLastPiecePriority` and NZBGet-only `nzbPriority`. `status`/`version`
now hold the *last real Test result*, not a simulated placeholder. Storing each client's
data as one JSON blob (the same `settings_items` mechanism, just a richer shape for this one
section) meant no new table or migration was needed — `rowToItem`/PATCH/DELETE all still
work unchanged.

### `POST /api/download-clients/:id/test` (`server/routes/download-clients.js`)

The one new route. Looks up the saved row, merges in an optional request body (so the edit
modal can test host/port/credentials the person just typed without saving first — see
below), dispatches to `qbittorrent.js` or `nzbget.js` by the row's `type`, and persists the
real result: `status` becomes `ok`/`fail`, `version` is updated on success and left alone on
failure (so a client that was working stays showing its last known version rather than
getting wiped by one bad test). Returns 400 for an unknown `type` or a missing host/port,
404 for a nonexistent id — all confirmed with curl against a running server plus real mock
qBittorrent/NZBGet instances (below), not just read off the code.

### Settings page: split off from the shared connections controller

Indexers/Import Lists/Connect still share `initConnectionManager` in
`settings-connections.js` — a generic list with a fake Test timeout. Download Clients now
has its own `settings-download-clients.js`, because it needed things that controller doesn't
have: a real per-type field set behind an edit modal (same `.modal-overlay`/`.modal-box`
pattern the Add Quality modal established — see Quality Definitions redesign), and a Test
button that calls the real endpoint above instead of faking a result. Picking a type from
the add-panel creates the row (POST, with that type's real defaults — a qBittorrent client
defaults to port 8080, initial state Start, content layout Original; an NZBGet client
defaults to port 6789, priority Normal) and immediately opens its edit modal, since an empty
host/username/password sitting in the list isn't useful — the natural next step after
picking a type is filling those in, same as Sonarr/Radarr's own add-client flow. Every field
autosaves on change via the existing generic `PATCH /api/settings-items/download-clients/:id`
(no separate Save button, consistent with every other Settings page). The list itself needed
its own `.dlclient-row`/`.dlclient-header` CSS grid (an extra Category column the generic
`.settings-row` shape doesn't have) rather than reusing `.settings-row`, since that class is
shared by Indexers/Import Lists/Connect and changing its column count there would have
broken all three.

### Bug caught during verification: qBittorrent's version already has a "v"

The modal's "Connected" message and the row's status-pill tooltip both originally built
`` `v${item.version}` ``, assuming a bare version number. qBittorrent's real `/api/v2/app/version`
already returns `v4.5.2` (with the `v`), so a successful test showed "Connected — vv4.5.2" —
caught by a jsdom test asserting the exact success message against a mock qBittorrent
server, not by inspection. Fixed by displaying `item.version` as-is with no prefix added,
correct for both clients (qBittorrent's own `v4.5.2` and NZBGet's bare `21.1`).

### Verified against real mock servers, not just code review

Two small mock HTTP servers (`mock-qbittorrent.mjs`, `mock-nzbget.mjs` — test-only, not part
of the shipped app) stand in for a real qBittorrent/NZBGet instance, since this sandbox can't
reach the user's actual local network. Confirmed over real HTTP against a running server plus
both mocks: wrong credentials on either client type return `ok: false` with a clear
"Login rejected" error and flip `status` to `fail`; correct credentials return `ok: true`
with the real version string and flip `status` to `ok`; an unreachable host/port fails fast
with a clear "Could not reach..." error rather than hanging, and leaves the *previous*
`version` in place rather than wiping it; testing an unknown `type` returns 400; a missing
host/port returns 400; a nonexistent client id returns 404; and the saved row's `status`/
`version` persist across a server restart (re-`GET` after each test confirmed the DB write,
not just the in-memory response). On the frontend, a jsdom test drove the actual UI: clicked
Add, picked qBittorrent, confirmed the modal opened automatically, typed in the mock
server's host/port/credentials, ran Test with a wrong password (confirmed the real rejection
message rendered), fixed the password and ran Test again (confirmed "Connected — v4.5.2"
with no double-`v`), closed the modal, and confirmed the row list itself showed the
Connected pill afterward. The full 28-page regression suite (including Indexers/Import
Lists/Connect, to confirm splitting Download Clients off `initConnectionManager` didn't
disturb the controller they still share) passed 28/28 in the same per-page-subprocess jsdom
harness the rest of this project uses.

## Connect: real Pushover notifications

Settings > Connect had the same problem Download Clients did before its own fix (above):
every item — Discord, Telegram, Slack, Plex, Gotify — was decorative. The row's Test button
was a 700ms `setTimeout` that always resolved to "Connected," there were no real credential
fields behind Edit, and nothing in the app ever actually notified anywhere when a grab,
import, or failure happened. Pushover is now real: real User Key/API Token fields, a Test
button that sends an actual push notification through Pushover's API, and real dispatch from
the three points in the app that generate the events Sonarr's own Connect page notifies on.

### Why Pushover specifically, and why Slack/Plex/Gotify still aren't

Same scope reasoning as Download Clients only getting qBittorrent/NZBGet instead of every
possible client: Pushover has the simplest real API of the four Connect types on offer here —
one POST, two credentials, a JSON response — with no OAuth flow, no self-hosted server to
stand up, and no webhook URL format to reverse-engineer. It's a single, self-contained
integration that proves the "real Connect item" pattern end-to-end without taking on the
scope of the other three at once. Slack/Plex/Gotify keep using `initConnectionManager`'s
generic simulated Test until/unless one of them gets the same treatment.

### `server/lib/pushover.js`

The API client, same shape as `download-clients/qbittorrent.js`: a `fetchWithTimeout` wrapper
(`AbortController`, 10s timeout, normalizes `AbortError` into a plain "Timed out..." message)
around a single `sendPushoverNotification({ apiToken, userKey, title, message, priority })`
call to `POST https://api.pushover.net/1/messages.json`. Per Pushover's documented contract,
`status === 1` in the JSON response is the only real success case; anything else surfaces
Pushover's own `errors` array as the error message rather than a generic failure string, the
same way qBittorrent's actual login-rejection reason gets surfaced instead of masked.
Priority maps straight onto Pushover's own -2..1 scale (Lowest/Low/Normal/High); Emergency (2)
is deliberately left out since it requires `retry`/`expire` params plus a separate Receipts
API this app has no use for.

### `POST /api/connect/:id/test` (`server/routes/connect.js`)

Mirrors `/api/download-clients/:id/test`: looks up the saved row, merges in an optional
request-body override (so the edit modal can test a User Key/API Token that was just typed
without saving first), and — only for a `type: 'pushover'` item — calls
`sendPushoverNotification` with a fixed "This is a test notification from Kitsune..."
message, then persists `status: 'ok' | 'fail'` back onto the row. Every other Connect type
still returns 400 ("Real testing isn't implemented for \<type\> yet") rather than silently
faking success, since this route only exists for Pushover so far. A missing User Key/API
Token returns 400 before a network call is even attempted; a nonexistent id returns 404.

### `server/lib/notify.js` and its three real trigger points

`notifyConnections(event, message)` is the dispatch half — called with `event` one of
`'grab' | 'import' | 'fail'` from the exact three places `server/routes/queue.js` already
generates those events for History: right after a grab is inserted, and inside
`completeDownload()`'s success and failure branches. It reads every `connect`-section row,
skips anything that isn't an enabled Pushover item, skips a Pushover item whose matching
`notifyOnGrab`/`notifyOnImport`/`notifyOnFail` flag is off, skips one still missing
credentials, and fire-and-forgets a real send to the rest — deliberately not awaited from
`queue.js`, so a slow or unreachable Pushover can't hold up the grab/tick that triggered it,
the same reasoning `warmEpisodesInBackground` already uses for its own background TVDB call.

### Schema: an `extra` field for the one type that needs real defaults

Every other Connect/Indexer/Import List type is created with the same generic
`{ name, protocol, meta, priority, enabled, status }` shape. Pushover's entry in
`connectTypes` (`settings-connections.js`) adds an `extra` object —
`{ type: 'pushover', userKey: '', apiToken: '', priority: 0, notifyOnGrab: false,
notifyOnImport: true, notifyOnFail: false }` — spread in last when a new item is created, so
it gets real (empty) credential fields and real trigger defaults instead of nothing. Adding a
type with an `extra` field also auto-opens its edit modal immediately after creation, same as
Download Clients landing straight on its own edit form — an empty User Key/API Token sitting
in the list isn't useful on its own. `renderModal()` branches on `isPushover(item)` to swap in
User Key / API Token (password-masked) / a Priority select / three trigger checkboxes in
place of the generic Protocol/Details/Priority fields every other type still gets, and a
`Send Test Notification` footer button replaces the row-level-only Test action other Connect
types rely on. The three trigger checkboxes double-write a derived `meta` string
(`pushoverMetaLabel()` — "On Grab, Import", "No triggers", etc.) on every change, so the list
row's Triggers column always reflects what's actually enabled rather than a stale hand-typed
label.

### Verified as far as this sandbox allows

`/api/connect/:id/test` was exercised directly with curl against a running server: a
non-Pushover type returns 400 with the right message, missing credentials return 400,
a nonexistent id returns 404. A full grab-to-completion run confirmed `notifyConnections`
fires from all three real call sites in `queue.js` (checked via server logs — "Sent 'grab'
notification..." / "Sent 'import' notification..." — since a real send attempt to
`api.pushover.net` from this sandbox is blocked by the environment's own network allowlist,
the same restriction documented earlier in this README for TheTVDB access). A dedicated jsdom
UI test drove the real DOM: clicked Add, picked Pushover, confirmed the edit modal opened
automatically with User Key/API Token/Priority/three checkboxes/Test button all present,
filled in User Key and API Token via real change events, toggled "On Grab" from its default
unchecked state, closed the modal, and confirmed the list row updated to show "On Grab,
Import" — proving the derived-summary logic works end-to-end through the real DOM, not just
in isolation. The full 28-page regression suite passed 28/28 afterward. The one thing that
cannot be verified from here is an actual successful round-trip to Pushover's servers, since
that requires real Pushover account credentials and a network path this sandbox doesn't have
— testing that final step is the one thing left for whoever runs this on their own machine.

## Library dashboard: real Disk usage

The Library dashboard's four stat cards (Series, Missing episodes, Downloading, Disk usage)
were, until now, plain static HTML — `184`, `27`, `4`, and `2.1 TB` hardcoded directly into
`index.html`, never wired to anything. Disk usage specifically is now real, computed two
different ways across two rounds of this fix — the first attempt measured the wrong thing
entirely, caught by the person using this against a real library. Both the bug and the fix
are worth documenting since the wrong version *looked* plausible.

### Round 1's bug: volume usage isn't folder content size

The first version summed `usedBytes` (`totalBytes - freeBytes`) from `fs.statfsSync` across
every root folder — the same syscall `computeRootFolderStats()` already used for free-space
numbers on Settings > Media Management and System > Status. That was wrong: `statfs` reports
how full the *entire volume* a path lives on is — every other file on that disk, not just
what's under the root folder. Confirmed against a real library: the dashboard read **42 TB**
while `du -sh` on the same root folder reported **2.9 TB** — the statfs number was measuring
the whole drive, most of which had nothing to do with the anime library sitting on it.

### Round 2: real recursive content size, cached and scheduled

What "Disk usage" should mean here is what `du` measures — the real, recursive sum of file
sizes under each root folder. `server/lib/disk-usage.js` is a from-scratch recursive walker
(`fs.promises.readdir`/`stat`, async so it doesn't block the event loop mid-scan) that sums
real file sizes under every configured root folder. Symlinks are deliberately skipped
(neither followed nor counted) to avoid double-counting or an infinite loop on a cyclic link.
A root folder that can't be read at all contributes `null` (excluded from the sum, not
counted as 0 bytes); a subfolder deeper in the tree that fails just gets logged and skipped
without invalidating the rest of that root folder's total.

This also answers the question of whether it should be computed live per page load or on a
schedule: a real directory walk over however many episode files a library has is genuinely
not free the way a single `statfs` syscall is, so computing it on every dashboard visit would
mean every visit pays for a full disk scan. Instead:

- **A module-level cache** (`{ bytes, computedAt, computing }`) holds the last completed
  scan's result. `GET /api/system/status` (`server/routes/system.js`) just reads this cache —
  instant, no disk I/O on the request path at all.
- **`startDiskUsageScheduler(intervalHours)`**, called once from `server.js` at startup, kicks
  off an initial scan immediately (without blocking `server.listen()` — the server starts
  serving requests right away) and then re-scans on a timer. The interval defaults to 6 hours,
  configurable via the `DISK_USAGE_REFRESH_HOURS` env var — genuinely a per-install judgment
  call (a library that barely changes vs. one grabbing constantly), not a real recommendation.
  A `state.computing` guard means an overlapping scheduled tick while a scan is still running
  is skipped (logged), not run twice in parallel.
- **Root folder add/remove triggers an extra fire-and-forget rescan** (`routes/root-folders.js`'s
  POST handler, and the generic DELETE handler in `routes/settings-items.js` when
  `section === 'root-folders'`) — without this, a freshly-added root folder's content
  wouldn't show up in Disk usage until the next scheduled tick, up to `DISK_USAGE_REFRESH_HOURS`
  later. Caught by my own test: added a root folder, immediately checked the dashboard, and
  got `"—"` instead of the folder's real size, before this hook existed.
- **The dashboard shows "Calculating…"** instead of `"—"` while the very first scan (or a
  just-triggered add/remove rescan) is still in flight — `diskUsageComputing` in the
  `/api/system/status` response, checked in `library.js` — so "no data yet" and "genuinely
  zero/unreadable root folders" don't look identical. The stat card's `title` attribute also
  shows when the number was last computed.
- Every `statfs` failure that used to be silently swallowed in `computeRootFolderStats` now
  logs a `WARN [FsHelpers]` line with the real reason (`ENOENT`, permissions, etc.) — added
  alongside this fix so a root folder silently contributing nothing to Disk usage shows up as
  an explained log line instead of an unexplained gap, visible on System > Logs.

One deliberate simplification carried over from round 1: no attempt is made to detect two
root folders that happen to be nested inside each other or share overlapping content — each
configured root folder's size is summed independently. For the common case (root folders are
separate, non-overlapping directories) that's correct; for two root folders where one is a
subdirectory of the other, the total will double-count that overlap.

Verified against a real, known directory tree (not a mock — files with exact known sizes: 1
MB + 2 MB + 3 MB, plus a symlink deliberately excluded from the total) rather than trusting a
formatted `du -sh` comparison alone: the computed total matched the real byte sum exactly
(6,000,000 bytes → "5.7 MB"), and the symlink's target size wasn't double-counted. Confirmed
the scheduler logs its startup message and initial scan; confirmed an unreadable root folder
(the three seeded `/anime/...` paths, which don't exist in a fresh checkout) logs a specific
`WARN [DiskUsage]` line and is excluded rather than treated as 0; confirmed adding a root
folder without restarting the server updates the dashboard total within about half a second
(the fire-and-forget rescan), and removing it drops the total back down the same way;
confirmed zero root folders (or all of them unreadable) falls back to `diskUsageBytes: null` /
`"—"`, not `0` or a crash. `public/index.html`'s Disk usage card has `id="diskUsageStat"` (the
other three stat cards are untouched — still the original hardcoded placeholders, out of
scope for this fix); a jsdom test loading `index.html` against a running server with the real
test directory as a root folder confirmed `#diskUsageStat` renders the exact expected total,
not just that the API returns one. Full 28-page regression suite passed 28/28 after every
step of this fix, including the round-1-to-round-2 rewrite.

## Series detail: real airing status in "Next airing"

The series detail page's "Next airing" stat card just showed a bare `—` for any series with
no `nextAirDays` — including finished shows, which read as missing/broken data rather than
"there's nothing next because this show is over." TVDB and MAL both already report a real
airing status (TVDB: `Ended`/`Continuing`/`Upcoming`; MAL's official API:
`finished_airing`/`currently_airing`/`not_yet_aired`), and that data was already being
fetched — `mapTvdbResult`/`mapMalOfficialResult` (`server/lib/tvdb.js`/`server/lib/mal.js`)
both included a `status` field, used for a tag in the Add New page's preview modal — but
nothing carried it any further. `POST /api/series` discarded it entirely and hardcoded every
new series to `status: 'continuing'` regardless of what the real show's status actually was,
so even a freshly-added already-finished series would've shown `—` forever, not just old
seeded ones.

`series` gained an `air_status` column (migrated in for existing DBs, same pattern as
`external_id`/`tvdb_episode_id` before it) — the real, source-specific display label, kept
deliberately separate from the existing `status` column, which stays the plain
continuing/ended binary the filter tabs and Library badges already depend on and shouldn't
have to learn six new values. `deriveAirStatus(rawStatus, source)` in
`server/routes/series.js` maps a search result's raw status into both: MAL's snake_case
machine values get title-cased (`finished_airing` → "Finished Airing"); TVDB's are already
readable English and used close to as-is; either way, `finished_airing`/`ended` map to this
app's `status: 'ended'`, everything else to `'continuing'`. `POST /api/series` now calls this
instead of hardcoding `'continuing'` — the one other change this required was actually
sending `status` in the request body at all, which `library-add-new.js`'s `addSeries()`
simply never had (only title/year/overview/poster/id/source went over the wire before).

The stat card itself (`library.js`, series detail rendering) now falls through three levels:
a real `nextAirDays` countdown first ("in Xd", unchanged); the source's own `airStatus` label
next ("Ended", "Finished Airing", "Currently Airing", etc.); and only for a series with
neither — the 21 originally-seeded mock series, which predate `air_status` and were never
added through a real search — a generic "Ended" derived from the existing `status` column
being `'ended'`, so *something* real always shows for a finished show instead of a bare dash
regardless of when it was added.

Verified over real HTTP against a running server, not just read off the code: added a
MAL-sourced series with `status: "finished_airing"` and confirmed it came back with
`status: "ended"`/`airStatus: "Finished Airing"`; added a TVDB-sourced series with
`status: "Ended"` and confirmed `airStatus: "Ended"`; added a MAL series with
`status: "currently_airing"` and confirmed it stayed `status: "continuing"` with
`airStatus: "Currently Airing"` (not miscategorized as ended); added a series with no status
field at all (a manual/no-source add) and confirmed it defaults to `status: "continuing"`,
`airStatus: null`, not a crash. On the frontend, a jsdom test loaded the real series detail
page for each of these: the new MAL-sourced series' Next airing card showed "Finished
Airing"; a legacy seeded ended series (Mushoku Tensei, `air_status` still `null`) fell back to
"Ended"; a still-airing seeded series (Frieren, `nextAirDays: 2`) was unaffected and still
showed "in 2d". Full 28-page regression suite passed 28/28.

## System > Tasks: Disk Usage Recompute is real, its interval is user-editable

System > Tasks has always been entirely decorative — `tasksData` in `system-tasks.js` is a
static array (RSS Sync, Backup, Housekeeping, etc.), and "Run Now" just faked a timestamp
update after a `setTimeout`. Disk Usage Recompute (the background job behind the Library
dashboard's Disk usage stat card — see the section above) is a real scheduled job now, so it
belongs on that page for real: listed there, with a genuinely working Run Now, and — since the
right refresh cadence is a per-install judgment call, not something to hardcode — an interval
you can actually change from the UI instead of only via the `DISK_USAGE_REFRESH_HOURS` env var
and a restart.

### `server/lib/disk-usage.js`: from a fixed `setInterval` to a configurable, persisted schedule

The previous version armed one `setInterval` at startup with whatever `DISK_USAGE_REFRESH_HOURS`
said and never touched it again. Making the interval editable meant switching to a
self-rescheduling `setTimeout` chain (`scheduleNext()`) instead: every completed run — scheduled
or manual — rearms the timer for whatever the *current* interval is, so changing it takes effect
immediately rather than needing the old `setInterval` torn down and recreated by hand. New
exports: `getTaskInfo()` (id, name, current interval, min/max bounds, last/next run timestamps,
whether a scan is running right now — what `GET /api/system-tasks` returns), `setIntervalHours()`
(validates, clamps to `[1, 168]` hours, persists, reschedules), and `runNow()` (System > Tasks'
Run Now — runs a scan immediately and resets the countdown to a fresh full interval from that
moment, rather than leaving the old timer to fire again almost immediately after).

The interval itself is persisted through the existing `app_settings` table (see Persistence) —
section `scheduled-tasks`, key `diskUsageIntervalHours` — the same generic per-section JSON blob
mechanism Media Management/General/UI/Metadata/Quality already use, just written to directly
from `disk-usage.js` rather than through the `/api/app-settings/:section` route those pages use
(this needed live *runtime* state — last run, next run, currently running — alongside the saved
config, which doesn't fit that route's plain "saved settings blob" shape). `DISK_USAGE_REFRESH_HOURS`
still exists, but only matters the very first time the server ever starts, before anyone's
touched the System > Tasks control — from then on, whatever's persisted always wins on startup.

### `server/routes/system-tasks.js` (new) and the frontend

Three endpoints: `GET /api/system-tasks` (an array — of one real task today — so the shape
doesn't need to change if a second real task ever joins Disk Usage Recompute),
`POST /api/system-tasks/disk-usage/run`, and `PATCH /api/system-tasks/disk-usage`
(`{ intervalHours }`). Run Now is fire-and-forget on the server side, same reasoning as the
Download Clients Test button and the root-folder-add rescan hook before it: a real directory
walk can take a while, so the response doesn't wait for it.

`system-tasks.js` keeps the seven decorative rows exactly as they were (nothing real exists
behind them yet, out of scope here) and adds an eighth, real one once `/api/system-tasks`
answers. That row is visibly different from the other seven in one deliberate way: its Interval
cell is a `<select>` (a fixed set of sensible choices — 1h up to 1 week — rather than a free-text
number field, since the server clamps regardless and a dropdown sidesteps validating "0",
negative numbers, decimals, etc. on the frontend for no real benefit) that `PATCH`es on change;
its Last Run/Next Run are computed from real ISO timestamps instead of the other rows' canned
"4 minutes ago" strings; and its Run Now button hits the real endpoint, then does one follow-up
check about two seconds later to catch the scan actually finishing (the initial `POST` response
doesn't wait for that, so an immediate re-render would just show "Running…" with nothing to
update it — a single delayed re-check is what actually shows the real completion, not an
indefinite poll loop).

Verified over real HTTP against a running server: confirmed the default interval is 6h;
`PATCH`ed it to 3h and confirmed the response reflected it; sent an absurdly large value
(999999) and confirmed it clamped to the real max (168h) rather than being accepted outright or
rejected outright; sent a non-numeric value and confirmed a real 400; called Run Now and
confirmed the response showed `running: true` immediately, with a follow-up `GET` showing
`running: false` and a fresh `lastRunAt` once the scan actually finished; **restarted the server
and confirmed the interval set via `PATCH` was still there** — the actual point of persisting it.
On the frontend, a jsdom test loaded the real System > Tasks page and confirmed all 8 rows
render (7 decorative + 1 real); changed the interval through the real `<select>` control (not
just the API directly) and confirmed the server-side value actually changed; clicked the real
Run Now button through the real DOM and waited past the follow-up poll, confirming the button
re-enabled, `lastRunAt` genuinely changed, and the row stopped showing "Never." Full 28-page
regression suite passed 28/28.

### Indeterminate progress bar while a scan is running

The real row's Run Now flips to a disabled "Running…" state, but with nothing else moving, a
scan that takes more than a second or two can look stuck. A real recursive directory walk has no
cheap way to know "how much is left" up front, so rather than fake a percentage against a
root-folder count (chunky, and can't move at all with just one root folder), the row grows a
thin bar across its bottom edge with a continuously sliding fill — the same pattern as a browser
tab's loading indicator: always visibly active, never claims a specific amount of progress.
CSS-only (`.task-progress-track` plus a `slide` keyframe in `styles.css`), scoped to `.task-row`
only so the seven decorative rows are untouched; `system-tasks.js`'s `realRowHtml()` renders the
bar only while `task.running` is true. Verified via jsdom: absent while idle, present
immediately after a real Run Now click.

**Bug fixed shortly after shipping this:** the bar didn't stop once the scan actually finished.
The Run Now click handler only ever checked back in once, at a fixed 2 seconds — fine for a scan
that happens to finish inside that window, but on anything slower the frontend simply stopped
looking, so "Running…" and the sliding bar stayed on screen indefinitely even though the server
had long since finished and moved on. There was never a way to know a real scan's duration up
front, so a fixed delay was always going to be wrong for *some* library size. Replaced the
one-shot `setTimeout` with `pollUntilDone()`: re-checks `/api/system-tasks` every 2s for as long
as the task reports `running: true`, and stops the moment it doesn't — tracking a scan of unknown
length instead of guessing it. Verified with a jsdom test using a scripted fetch mock that reports
still-running for three 2s poll cycles (6s — well past the old fixed cutoff) before reporting
done on the fourth: confirmed the row kept polling past the point the old code would have given
up, and that the bar/button/Last Run all caught up to the real completion once it landed.

### Green completion flash

The bar disappearing was correct but easy to miss — nothing drew the eye to the exact moment a
scan finished. `pollUntilDone()` is the one place that can actually observe a running->done
transition happen live (it compares `running` before and after each poll), so it's what sets a
one-shot `flashOnNextRender` flag right when that transition is detected. `render()` reads and
immediately clears that flag on every call, passing it into `realRowHtml()` as whether to include
a `row-flash-success` class on that render only. The CSS side needs no JS timer to "turn the
flash off": `.row-flash-success`'s `animation` (a `background`/`border-color` sweep from
`--success`/`--success-bg` back to normal over 1.6s, in `styles.css`) is non-infinite, so it just
stops on its own once it finishes playing — and because it's only ever present in the HTML string
for the one render call right after completion, it can't replay on some later, unrelated
re-render (changing the interval a minute afterward, say) the way a persistent class would.
Verified via a jsdom test with a scripted fetch mock simulating a 4s scan: confirmed the class was
absent through both `running: true` poll cycles, present on exactly the render that first saw
`running: false`, and absent again after a follow-up interval change re-rendered the row.

### Reused on Download Clients' Test Connection

The class was renamed from `task-row-complete` to the more generic `row-flash-success` specifically
so it could be reused here: a real qBittorrent/NZBGet connection test succeeding is the same "this
just worked" moment as a scan finishing, on a row (`.dlclient-row`) that shares the same
`.settings-row`-family background/border styling. `settings-download-clients.js` carries its own
one-shot `flashOnNextRender` (holding the client's `id` rather than a boolean, since the list can
have more than one client), set by either the row's own Test button or the edit modal's Test
Connection button whenever the server reports `ok: true`, and consumed by `render()` exactly like
the Tasks page. The modal case is the interesting one: the row itself is hidden behind the modal at
the instant the test succeeds, so the flag just waits — `closeEditModal()` already called `render()`
before this (to clear a stale status pill left over from a modal test), and that's the render that
now also picks up the flag, so the flash plays the moment you return to the list. Verified against a
real mock qBittorrent instance: the row-level Test button flashes the correct row (matched by id, not
just "the first `.dlclient-row`" — the list can have other, unrelated clients in it) on success, and
testing from inside the edit modal and clicking Done shows the same flash on modal close.

## Three small Settings/nav fixes

### Library's "All Series" sub-nav item removed

`NAV_SECTIONS` in `nav.js` had Library's top-level link (`index.html`) and its first sub-item
("All Series") both pointing at the exact same page — a redundant middle step between clicking
"Library" and landing on the page you're already looking at. Removed the sub-item; Library's own
top-level link is index.html already, so nothing else about navigating there changes.

The one real consequence: `sectionMatches()` used to only check a section's *subs* for a file
match (fine before, since "All Series" duplicated `index.html` in that list too) — with that
entry gone, sitting on `index.html` would no longer have matched anything, leaving the sidebar
failing to highlight Library and the page-tabs strip failing to render "Add New"/"Library Import"
on the one page most likely to need them. Fixed by having `sectionMatches()` check the section's
own `href` first, falling back to its subs — which also just generally describes what "this
section is active" should mean, sub-item duplication or not. Verified via jsdom on `index.html`:
Library's nav-item carries `active`, its sub-menu is open showing exactly "Add New" and "Library
Import," and "All Series" no longer appears anywhere in the sidebar.

### Edit Profile (and Custom Formats) actually does something now

`settings-profiles-formats.js`'s shared `initSimpleList()` — backing both Profiles and Custom
Formats — rendered an Edit (pencil) button on every row, but its click handler only ever checked
for `data-action === 'remove'`. Nothing listened for `'edit'` at all; the button was inert. Added
a real edit modal (autosaving each field on change via `PATCH`, same pattern as every other
Settings page's modal): Profiles edits Name, Cutoff, and Upgrades allowed; Custom Formats edits
Name, Conditions, and Used in profiles. Cutoff's dropdown is sourced from the real Quality
Definitions tier list (`GET /api/settings-items/quality-tiers`, fetched once at page load) instead
of a second hardcoded copy of the tier names, falling back to just the profile's own already-saved
value if that fetch hasn't landed yet. ("Qualities" — the "N of 12" summary column — is shown for
context but isn't itself an editable field here; it's a derived count that belongs to the Quality
page's own per-tier selection UI, not a plain value this modal should let drift out of sync.)
Verified via jsdom against a running server: added a profile, edited its cutoff and upgrades
toggle through the real modal, and confirmed both landed correctly server-side; same for a custom
format's conditions count.

### Indexers (and Import Lists, Connect) can be edited after creation

The identical gap existed one level up: `settings-connections.js`'s shared
`initConnectionManager()` — backing Indexers, Import Lists, *and* Connect — only ever wired up
Test, the Enabled toggle, and Remove. There was never an Edit button at all, so a typo'd name or
wrong priority set at creation time was stuck that way short of deleting and re-adding the entire
entry. Added an Edit (pencil) button and a modal (Name, Protocol, and whichever field each page's
own second column actually means — Categories for Indexers, Root folder for Import Lists,
Triggers for Connect — plus Priority), autosaving on change via `PATCH`, same as the rest of
Settings. Required an extra 32px column in `.settings-header`/`.settings-row`'s grid for the new
button, and a matching extra empty `<span>` in all three pages' header rows. Verified via jsdom
against a running server: added an indexer, edited its name through the real modal, and confirmed
it persisted server-side; smoke-tested the same modal opening correctly on Import Lists and
Connect.

## Library Import: real file scanning, and real episode linking

Library Import could always tell you a folder's *name* looked like a series and whether that name
matched something already in the Library — but nothing about what was actually inside the folder.
No file count, no size, no format, no way to check any of it without opening a terminal on the
server. And even once a folder matched an existing series, there was no way to actually connect
its real files to that series' episodes — they'd just sit on disk, with Kitsune having no idea
they existed, while Wanted > Missing kept listing those same episodes as missing forever.

### `server/lib/media-files.js` (new): real recursive file scanning + best-effort guessing

A real recursive walk (same shape as `server/lib/disk-usage.js`'s) that finds actual video files
under a folder — `.mkv`/`.mp4`/`.avi`/`.mov`/`.wmv`/`.ts`/`.m2ts`/`.flv`/`.webm`, skipping sample
files (`*sample*`, same convention real Sonarr/Radarr use) and anything hidden. Two best-effort
guesses come out of a filename alone, same as a real release name already encodes both:

- **Quality** (`guessQualityTierName`): resolution (`1080p`/`720p`/`2160p`/`480p`) plus source
  (`BluRay`/`WEB-DL`/`HDTV`) parsed out of the name, matched against whichever Settings > Quality
  tiers are *actually configured* right now (tiers are fully user-managed — see the Quality
  Definitions section above — so this never returns a tier name that might not exist). An
  anime-specific default: a release with a resolution tag but no explicit source tag (the
  overwhelmingly common case for real fansub releases — `[SubsPlease] Show - 05 [1080p]` never
  says "WEB-DL" even though that's exactly what it is) assumes WEB-DL rather than whatever tier
  happened to sort first, since defaulting to broadcast HDTV would be wrong far more often than
  right for this app's actual content.
- **Season/episode number** (`guessSeasonEpisode`): tries `SxxExx` first, then an `Exx`/`EPxx` tag,
  then the anime-convention lone number set off by " - " (`Show - 05 [1080p]`). A "Season N"
  ancestor folder (or `SxxExx` itself) supplies the season when the filename alone doesn't carry
  one; a bare episode number with no such hint comes back explicitly *not confident* rather than
  silently guessing season 1, so the caller can decide whether that's actually safe (see below).

### Folder-level file summary on every Library Import row

`GET /api/root-folders/:id/subfolders` (`server/routes/root-folders.js`) now does a real walk of
every subfolder's contents on every scan/rescan, same real-but-not-free cost tradeoff Library
Import's directory listing itself already had — and returns a `matchedSeriesId` alongside the
already-existing `matchedTitle`, so the frontend has a real id to act on without a second
round-trip. Library Import's rows show the result directly: "12 files · 4.1 GB · .mkv" instead of
nothing. A new `GET /api/root-folders/:id/subfolders/:name/files` returns the full per-file list
(name, size, extension, guessed quality, guessed season/episode) — deliberately lazy, only called
when a row's Files cell is actually expanded, rather than every folder's full file list coming
back on every scan whether anyone looks at it or not.

### `POST /api/series/:id/import-files` (new): the actual point of all this

Given a root folder + folder name, walks its real video files and, for each one, tries to match it
to that series' real, already-cached episode list by the season/episode number guessed from its
filename. A confident guess (real `SxxExx` tag, or a folder-hinted season) matches directly; an
*unconfident* one (bare episode number, no season signal anywhere) only resolves if the series has
exactly one season total — otherwise it's reported back as unmatched with a specific reason
("multiple seasons and the filename gave no way to tell which one") rather than silently guessing
wrong. Same honesty for a file whose guessed episode number just doesn't exist in the series
("No season 1, episode 99 in this series' episode list") and for a series whose episode list
hasn't been fetched yet at all (points the caller at opening the series page once first, which is
what actually triggers that fetch — see episodes.js). Every match updates the real episode row —
`downloaded = 1`, `quality` = the real filename guess, `size_bytes` = the file's real size read off
disk, not simulated placeholder data from `queue-sim.js` — then calls the same
`recomputeSeriesEpisodeStats` the simulated grab pipeline already uses, so the series' "N / M"
card and progress ring update immediately, and Wanted > Missing/Cutoff Unmet (which both read
`episodes.downloaded`/`quality` directly) drop those episodes on their very next load with no
separate wiring needed.

### Library Import's UI: expandable file detail + Import files

Rows gained a Files column (real summary, click to expand into the real per-file list — name,
size, extension, guessed quality, guessed `SxxExx`, with an unconfident guess visually flagged) and
an "Import files" button next to already-matched folders' "Already in Library" pill. Clicking it
calls the new endpoint and shows the real result inline: how many files matched, how many didn't
and why, and the series' new real downloaded count. The file list is fetched once and cached
client-side per folder (keyed by `rootFolderId:name`, since a folder name alone isn't unique
across more than one root folder) — collapsing and re-expanding a row doesn't re-fetch.

Verified against a real throwaway folder of real files (not fixtures — actual `.mkv`-named files
with real, distinct sizes written to a real temp directory), matched against a series with a real
28-episode cache seeded directly into the DB: the scan correctly reported 4 real video files
(excluding a real `-sample.mkv` file and a non-video `.txt` file sitting in the same folder) and
their true combined size; the per-file list correctly guessed `WEBDL-1080p` for all four
(confirming the anime source-tag default) and the right episode numbers; Import Files correctly
linked episodes 1–3 (matching real files) and correctly reported episode "99" as unmatched with a
specific reason, since this series' episode list only goes up to 28; the series' `eps`/`pct`
updated to "3 / 28" / 11% immediately; and `GET /api/series/:id/episodes` confirmed episode 1 now
carries the file's real 300MB size and guessed quality directly in the `episodes` table, not a
simulated value. Full 28-page regression suite passed (27/28 — the one failure is the
Download Clients page's pre-existing, unrelated checker-selector mismatch noted earlier in this
document).

### Bug fixed shortly after shipping this: season 0 (specials) counted as a second season

Reported against a real folder of real files — a 12-episode series with one OVA sitting alongside
it (specials, TVDB's `season 0`). Every one of the 12 plainly-numbered files (`Show - 05
[1080p].mkv`, no `SxxExx` tag) came back "unmatched: this series has multiple seasons and the
filename/folder gave no way to tell which one this episode belongs to" — even though there was
nothing actually ambiguous about it: the only real season is season 1. The single-season fallback
in `server/routes/import-files.js` counted *every* distinct `season_number` in the episode list,
including 0, so a show with one real season plus any specials always looked like a two-season show
to that check and lost the fallback that would've resolved it. Fixed by excluding season 0 from
that count — a series with season 0 and exactly one other season is still, for numbering purposes,
a single-season show; a bare episode number now correctly resolves to that one real season instead
of getting rejected alongside files that are genuinely ambiguous (an actual two-season, e.g. Season
1 + Season 2, show still correctly requires a real season signal). The OVA itself — no episode
number in its filename at all — still correctly comes back unmatched regardless, since there's
nothing to guess there. Verified against the exact filenames from the report: all 12 numbered
episodes now link to season 1 correctly, the OVA still reports its own, different, correct reason.
Full 28-page regression suite passed (confirmed 28/28 once two flaky failures from parallel
checker resource contention were re-run in isolation and passed clean).

## Bug fixed: series page poster looked squished

Reported with a screenshot from a real deployment: the poster on a series' detail page (`.detail-
poster`) looked oddly zoomed/distorted compared to the same series' poster everywhere else in the
app. `.detail-header` (the row containing the poster and the info column next to it) is a flex
container, and flex items default to `align-items: stretch` — which resolves an item's cross-axis
size (height, here) to a *definite* value the moment nothing else in that axis is `auto`.
`.detail-poster` already had a definite `width: 150px`, so once flex stretch made its height
definite too, both dimensions were resolved through other means and `aspect-ratio: 2 / 3` had
nothing left to derive — it was silently ignored. In practice this meant the poster box quietly
grew as tall as its sibling info column (title, overview, badges, stat boxes), which on a series
with a long description could be well over the intended 225px. The `<img>` inside still used
`object-fit: cover`, which can't distort pixels — cover only crops — but cropping to fill a
too-tall box means more of the image's width gets cropped away than intended, reading as an overly
zoomed-in, "squished" poster. First fixed by adding `align-self: start` to `.detail-poster`,
opting it out of the stretch so `aspect-ratio` actually took effect and the box stayed a fixed
150x225 regardless of how tall the text next to it was. Found and fixed the same latent bug in
`.preview-poster` (Add New's series preview modal) at the same time — it sits in a CSS grid rather
than flex, but grid items default to stretch too, and it had the same definite-width/auto-height
shape, so it was one long overview away from the identical symptom; `.preview-poster` still carries
that `align-self: start` fix today; it's an unrelated, still-correct component this bug did not
otherwise revisit.

`.detail-poster` didn't stay at that fixed 150x225 for long, though. A follow-up request to make
the poster bigger bumped its width to `220px` (still with `align-self: start`, still 2:3 via
`aspect-ratio`) and widened `.detail-header`'s `gap` from `22px` to `28px` to give the larger
poster room to breathe. Then came a further request: rather than a fixed height, the poster should
grow tall enough that its bottom edge lines up with the bottom of the stat-boxes row in the info
column beside it — i.e. go back to relying on stretch instead of opting out of it. The obvious-
looking way to get there was to drop the fixed `width: 150px`/`220px`, drop `align-self: start`,
and keep `aspect-ratio: 2 / 3`, on the theory that stretch would resolve the height to match
`.detail-info` and `aspect-ratio` would then derive the matching width. This broke outright — the
poster vanished completely instead of resizing. The dependency is circular: the browser has to lay
out `.detail-header`'s row (and therefore know each item's width) before cross-axis stretch can
resolve heights, so a width that itself depends on the stretched height has nothing to resolve
against and collapses to zero. Fixed for real by going back to a fixed `width: 220px` on
`.detail-poster` and removing `aspect-ratio` entirely (there is no aspect-ratio on the element at
all now), while also removing `align-self: start` so the default `align-items: stretch` is left to
do its job unopposed: with a definite width already in hand, stretch can freely resolve the
poster's height to match `.detail-info`'s height, bottom edges included, whatever that height
happens to be for a given series' overview length. `object-fit: cover` on the `<img>` inside still
only crops, never distorts, so a taller box just shows a slightly more zoomed-in crop of the same
poster rather than a stretched one — the same property that caused the original bug is now doing
exactly the job it's meant for, once the width/height resolution order isn't fighting it. Full
28-page regression suite passed clean.

Widened `.detail-header`'s `gap` again after this, from `28px` to `40px`, on a follow-up "too
squished together" note about the space between the poster and the info column next to it — no
other change alongside it.

That still left one open edge case, also reported with a screenshot (Black Bullet's synopsis, ten
lines and counting): since `.detail-poster` now stretches to match `.detail-info`'s full height,
an outlier series with a genuinely long synopsis grew both the text block *and* the poster next to
it, so one series in the library could end up with a noticeably bigger poster than every other one
just because its description happened to run long. Fixed by capping `.overview` itself at
`max-height: 160px` (eight lines at this font-size/line-height) with `overflow-y: auto`, same thin-
scrollbar treatment `.preview-overview` (Add New's preview modal) already had — copied over as-is
rather than reinvented, since a scrollable overview box is a scrollable overview box either way. A
typical synopsis (Cat Planet Cuties' original, roughly eight lines) still fits with no scrollbar and
no visible change; anything longer now scrolls in place instead of growing the header, which keeps
`.detail-poster`'s stretched height — and therefore its size — consistent across every series
regardless of how long any individual one's description is. Full 28-page regression suite passed
clean.

Also worth a note for future debugging: while chasing an unrelated intermittent "server died mid-
verification-script" issue during this fix, traced it to `pkill -f "server.js"` being used to clean
up a stale background server before starting a fresh one for testing — `pkill -f` matches against a
process's *entire* command line, and the shell command doing the killing necessarily has the literal
string `"server.js"` in it too, so it was matching (and killing) its own invoking shell, not just the
intended stale server. This was very likely the same root cause behind several previously-unexplained
"server died within a single combined bash call" incidents earlier in development. Not a bug in the
app itself — just a note in case a future verification script reaches for `pkill -f` again: prefer
something that only matches by port (e.g. `fuser -k PORT/tcp`) or just use a fresh, previously-unused
port per test run instead of trying to kill anything.

That `max-height: 160px` on `.overview` turned out to be an incomplete fix, caught with a
side-by-side screenshot comparison: Cat Planet Cuties (long synopsis, so its overview box was
scrolling and sitting at the full 160px) rendered with a noticeably bigger poster than Re:ZERO
(a two-line synopsis, so its overview box was only as tall as two lines actually need). A
`max-height` only bounds the *tall* case — it does nothing to stop a short synopsis from producing
a shorter `.detail-info`, and since `.detail-poster` stretches to match that height, the poster was
still varying series to series, just over a smaller range than before this fix rather than not at
all. Changed `max-height: 160px` to a fixed `height: 160px` instead: every series' overview box now
occupies exactly the same space regardless of how much text is actually in it — short synopses just
leave empty room at the bottom of the box, long ones scroll exactly as before. That fixed height is
what finally makes `.detail-info`'s total height, and therefore `.detail-poster`'s stretched size,
genuinely constant across every series in the library rather than merely bounded. Full 28-page
regression suite passed clean.

## Episode details modal

A first mockup of what a real Sonarr-style "click an episode for its file info" panel would look
like. Clicking an episode's title in the series detail page's episode list now opens a modal
showing when it aired (or is going to), the quality it was actually downloaded at, its on-disk
path, and its file size — instead of the title being inert, the way it was before.

The interesting part wasn't the modal itself (`public/js/lib/episode-details-modal.js`, built the
same "construct once, append to `<body>`, expose an `open(row)`" way `release-picker-modal.js`
already does — no per-page modal markup needed) so much as that `episodes` had no file path
anywhere to show. `quality`/`size_bytes` already existed as real per-episode columns (see
server/routes/episodes.js), but nothing had ever needed a `path` before now — added as a new
column, backfilled in the three places an episode can become "downloaded":

Library Import (`server/routes/import-files.js`) has a real file to point at — it already knows
the exact path it just scanned (`folderPath` + the matched file's `relativePath`), so that's stored
verbatim. The simulated grab pipeline (`server/routes/queue.js`'s `completeDownload`) and the
one-time "downloaded / total" backfill that runs the first time a series' episodes are cached
(`server/routes/episodes.js`'s `backfillDownloadedState`) never touch a real filesystem, so neither
had a real path to store — both now call a new shared helper, `buildEpisodeFilePath()` in
`server/lib/episode-paths.js`, which fabricates a plausible one following Sonarr's own default
naming (`<series root>/Season N/Series Title - SxxExx - Episode Title [Quality].mkv`), using the
series' real root folder path when it's set and a generic `/mnt/anime/<title>` fallback when it
isn't. A missing/not-yet-aired episode has no path at all — the modal shows "Not downloaded yet"
for quality and an em dash for path/size instead, rather than a blank field or a fabricated one
that would misleadingly imply a file exists.

Only real, DB-backed episode rows (an actual `episodes.id` to look up) are clickable — the
hand-built Frieren demo list and the generic "Episode N" placeholder list used for a series with no
real per-episode data cached yet have nothing behind them to show, so their titles stay plain,
unstyled text, same gating the row's existing Search/Cancel buttons already use.

Verified end to end against real requests rather than just reading the code: inserted real
`episodes` rows directly (bypassing the TVDB fetch, since this sandbox has no outbound network
access to hit it) to confirm `GET /api/series/:id/episodes` round-trips `path` correctly, then a
jsdom click on a downloaded episode's title confirmed the modal renders "Aired Jan 1, 2024 / Quality
HD-1080p / File path /Volumes/Anime/.../S01E01... / File size 700 MB" and Escape closes it; a second
click on a not-yet-aired episode confirmed "Airs Jan 1, 2099 / Quality Not downloaded yet / File
path — / File size —" instead. Separately grabbed a real release through the simulated queue and
polled it to completion — the episode's `path` came back
`/Volumes/Anime/Chainsaw Man/Season 1/Chainsaw Man - S01E99 - ... [Bluray-1080p].mkv`, using the
series' real configured root folder. Separately ran a real Library Import against a real file on
disk and confirmed the stored path matched the real scanned location exactly, not a fabricated one.
Full 28-page regression suite passed clean.

## Disk usage now persists across restarts

The Library dashboard's "Disk usage" stat card (`server/lib/disk-usage.js`) was already a real,
recursive `du`-style scan on a background timer rather than something computed per page load — but
the cached result only ever lived in memory (`state.bytes`/`state.computedAt`). A server restart
meant starting from nothing: `state.bytes` reset to `null`, and every page load showed
"Calculating…" until a brand new scan finished, even though the previous scan's number was still
perfectly good — a real library's full walk isn't instant, so this could mean an empty-looking stat
card for a while after every restart, for no real reason.

Added a small persistence layer using the same `app_settings` table `server/routes/system-tasks.js`
already uses for the recompute interval, in its own `disk-usage-cache` section (kept separate from
the interval's own section — unrelated concerns, and this one gets written on every single
successful scan rather than only when someone changes a setting). `startDiskUsageScheduler` now
loads whatever was last persisted into `state` *before* kicking off a fresh scan, so
`getCachedDiskUsage()` — what `/api/system/status` actually reads — has a real number to hand back
immediately on the very first request after a restart, not just once the new scan eventually lands.
`refreshDiskUsage` persists the new total after every scan that actually managed to read at least
one root folder; a scan that fails to read anything at all (every root folder unreadable — a drive
temporarily unmounted, say) leaves the persisted value alone rather than overwriting a real number
with nothing, on the theory that a stale-but-real number is more useful than erasing it over what's
hopefully a transient problem.

This only helps if the frontend actually shows the cached number while a fresh scan runs in the
background, so `library.js`'s dashboard stat card changed too: it used to show "Calculating…"
any time `diskUsageComputing` was true, full stop — which used to be the only sensible behavior,
since there was never anything else to show in that state anyway. Now that there usually *is* a
real persisted number available even while a fresh scan is in flight, it shows that number instead
(suffixed with "(updating…)" so it's clear a rescan is in progress rather than looking like a
finished, final value), and only falls back to "Calculating…" for the genuine case of nothing
having been computed or persisted yet at all — a brand new install with no prior scan to fall back
on.

Verified against a real root folder with a real file on disk: ran a real scan, confirmed the result
landed in `app_settings` correctly; restarted the server and confirmed `/api/system/status`
returned the previous scan's exact number immediately, before the new startup scan could plausibly
have finished (and the new scan then updated it moments later, right on schedule); separately
confirmed via a scripted fetch mock that the dashboard stat card renders "19 MB (updating…)" rather
than blanking to "Calculating…" when a cached value exists alongside `diskUsageComputing: true`.
Full 28-page regression suite passed clean.

### Bug fixed shortly after shipping this: "(updating…)" never went away

Reported with a screenshot from a real deployment: the stat card sat on "2.9 TB (updating…)"
indefinitely, well after the server's own log confirmed the scan had actually finished
("Recomputed disk usage: 2.9 TB across 1 root folder(s) in 11.0s"). The disk usage fetch in
`library.js` was a single one-shot `fetch('/api/system/status')` — fine if the page happened to load
after a scan had already landed, but loading the page *while* one was still running (right after a
restart, or right after System > Tasks' Run Now — the same background job either way) meant it
fired once, saw `diskUsageComputing: true`, printed "(updating…)", and never checked again — a real,
finished, up-to-date number sat there still labeled as if it were mid-scan until the next full page
load. The exact same class of bug System > Tasks' own progress bar had earlier (see "Indeterminate
progress bar while a scan is running" above) and the same fix: turned the one-shot fetch into
`applyDiskUsageStatus()`, which re-checks every 2s for as long as `diskUsageComputing` is true and
stops the moment it isn't, rather than checking once and giving up. Verified with a scripted fetch
mock returning `diskUsageComputing: true` for the first two calls and `false` from the third
onward: confirmed the card showed "19 MB (updating…)" through both still-computing polls, dropped
to a bare "19 MB" on the render that first saw `diskUsageComputing: false`, and made no further
requests after that. Full 28-page regression suite passed clean.

## Library: Poster / Table / Overview views

The Library grid only ever rendered one way — a poster wall, no alternative. Real Sonarr's own
series list offers three: Poster (what this app already had), Table (compact rows), and Overview
(wide rows with the synopsis). All three now exist here, switched with a small icon toggle next to
the sort dropdown, and the choice is remembered in `localStorage` (`kitsune-library-view`) across
visits — a display preference, not data, so it deliberately isn't a column on the `series` table
the way everything else in this README treats "real" data.

### `library.js`: one dataset, three renderers

`renderGrid()` is now a small dispatcher: it filters/sorts `seriesData` exactly as before, then
hands the resulting list to whichever of `renderPosterGrid`/`renderTableView`/`renderOverviewView`
matches `libraryState.view`, and swaps `#seriesGrid`'s own class so each view gets its own CSS
layout (`series-grid`'s poster grid, `series-table`'s bordered rows, or a plain wrapper for the
Overview list). Every column in Table and Overview is pulled straight from what `GET /api/series`
already returns (`rowToSeries` in `server/routes/series.js`) — title, `eps`, `pct`/`fill`,
`qualityProfile`, `nextAirDays`/`airStatus`/`status`, `tagIds` — rather than inventing fields this
app has never tracked, like a Network column or an aggregate on-disk Size (that only exists
per-episode, and summing it across every series just to populate a list view wasn't worth the
N+1 fetches). `statusChipFor()` and `nextAiringText()` are shared by both new views so the same
series always reads the same way in either one; `nextAiringText()` is the exact four-way fallback
the series detail page's own "Next airing" stat already used, factored out rather than copied.

Tags are the one piece neither Poster nor the existing `/api/series` response carries ready to
render (`tagIds` are just ids) — fetched once from `/api/tags` the first time either Table or
Overview actually needs them (`ensureLibraryTagsLoaded()`), not unconditionally on every Library
load, since Poster is the default and most-used view and shouldn't pay for a request it never
shows.

### View toggle: three icon buttons, active state driven by state not markup

`index.html` ships with Poster pre-marked `.active` in its static markup (matching the pre-toggle
default), but `library.js` re-syncs that on load against whatever `loadStoredView()` actually
returns — otherwise a returning visitor whose last choice was Table would see the Poster button
lit up while Table silently rendered underneath it. Clicking a button updates `libraryState.view`,
writes it to `localStorage` (wrapped in a `try`/`catch` — some locked-down browser contexts throw
on storage access, and a saved preference failing to persist shouldn't break the view switch
itself), and re-renders.

### Verified against a real running server, not just read off the code

A dedicated jsdom suite drove the actual DOM: confirmed the default (no stored preference) load
still renders Poster exactly as before; clicked Table and confirmed the header row, all 21 seeded
series' rows, and a status chip on the first row all appeared; clicked Overview and confirmed each
row's real overview text rendered; clicked back to Poster and confirmed the table rows were gone;
confirmed the filter/search/sort controls still work correctly while Table is the active view
(searching "frieren" while in Table returned exactly one row). A separate process (real ESM module
re-execution requires a fresh process — see that test file's own comment on why a second
`import()` of `app.js` within one process silently reuses the first run's already-executed
`library.js` instance instead of re-running it) confirmed a stored `view: 'table'` preference is
respected immediately on load: the Table button shows active, Table rows render, and no poster
cards are created at all. Full 28-page regression suite passed 28/28 afterward.

## Episode details modal: real synopsis text

The episode details modal (Aired/Quality/File path/File size — see `episode-details-modal.js`) was
missing the one thing a real Sonarr/TVDB-backed episode page always has: a synopsis. TVDB was
already returning this — `fetchTvdbEpisodeTranslation` in `server/lib/tvdb.js` fetched an
`overview` field alongside the translated episode title on every single episode, every time, and
just threw it away. Now it's kept: a new `episodes.overview` column, populated the same
native-language-with-English-override way the title already was, returned by `GET
/api/series/:id/episodes`, threaded through `buildRealEpisodeRows` in `library.js`, and rendered as
a new "Synopsis" row in the modal — the one row here that's real prose instead of a short value, so
it gets its own `episode-detail-row-wrap` CSS variant (normal word-break/line-height, instead of the
`break-all` every other row uses to keep long file paths from overflowing).

Same caveat as every other field added to this table over the course of the project
(title_japanese/title_romanji/score never got backfilled for already-cached rows either): a series
whose episodes were fetched and cached *before* this column existed won't have a synopsis until its
episode cache is cleared and re-fetched — nothing here retroactively re-hits TVDB for existing rows.
The modal handles that gracefully either way, showing "No synopsis available." instead of a blank
row rather than assuming every episode has one.

Verified against a real running server: seeded two fake episode rows directly (one with a real
overview string, one with `overview: NULL`, matching what an already-cached pre-this-change row
looks like) since this sandbox's network block on TVDB rules out an actual live fetch here — the
same limitation documented earlier in this README. Confirmed `GET /api/series/:id/episodes` returns
`overview` correctly for both, then drove the real DOM: clicked the episode with a synopsis and
confirmed the modal's row order (Aired/Quality/File path/File size/Synopsis) and the exact synopsis
text rendered with the wrap class applied; clicked the one with no synopsis and confirmed the "No
synopsis available." fallback rendered instead of a gap. Full 28-page regression suite passed 28/28
afterward.
