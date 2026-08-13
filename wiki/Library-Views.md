# Library Views (Poster / Table / Overview)

## Library: Poster / Table / Overview views

The Library grid only ever rendered one way — a poster wall, no alternative. Real Sonarr's own
series list offers three: Poster (what this app already had), Table (compact rows), and Overview
(wide rows with the synopsis). All three now exist here, switched with a small icon toggle next to
the sort dropdown, and the choice is remembered across visits — a display preference, not data, so
it deliberately isn't a column on the `series` table the way everything else in this README treats
"real" data.

**Update, now that user accounts exist:** the view choice and the poster-size slider (below) both
moved to `/api/user-prefs/library-ui-prefs` (`server/routes/user-prefs.js`), one record per signed
-in user. Originally the view lived in the browser's own `localStorage` and poster size in a single
shared `app_settings` row — see [User Accounts](User-Accounts) — genuinely per-user versions of
both were the plan from early on (the poster-size code even said so in a comment), just blocked on
there being no real user to scope a record to yet. Both fields share the one record now: `GET`/`PUT
/api/user-prefs/library-ui-prefs` returns/merges `{ view, posterSize }` together, same merge-on-PUT
semantics `/api/app-settings/:section` already used elsewhere, just keyed by the session's user id
instead of a fixed section name alone. No migration of the old shared value — a fresh per-user
record just starts at the same defaults ('poster' view, unscaled size) every first-ever Library
visit already fell back to.

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


---

[← Back to Home](Home)
