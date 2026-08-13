# React Migration

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
app — see [Disk Usage](Disk-Usage)'s "Green completion flash"), then settled back to normal — the identical
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
`initConnectionManager` for its real qBittorrent/NZBGet integration — see
[Download Clients](Download-Clients) —
and gets its own React port here for the same reason, `settings-download-clients/DownloadClients.jsx`).

Pushover's real-integration behavior — the one genuine integration among these four pages
(see [Connect Notifications](Connect-Notifications)) — ported over completely intact: the
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
the Poster/Table/Overview renderers (`PosterCard`/`TableRow`/`OverviewRow` — see
[Library Views](Library-Views) for how that feature itself works) essentially
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


---

[← Back to Home](Home)
