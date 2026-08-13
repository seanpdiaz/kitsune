# Series Detail Page Features

*This page combines four write-ups about the Series detail page's individual features —
real airing status, a poster-aspect-ratio bug fix, the episode details modal, and that
modal's real synopsis text — kept in the order they happened. For the Size stat card and
Downloaded status specifically, see
[Root Folders and Library Import](Root-Folders-and-Library-Import), since that fix lives
mostly in the Library Import reconciliation logic.*

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


---

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


---

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


---

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


---

[← Back to Home](Home)
