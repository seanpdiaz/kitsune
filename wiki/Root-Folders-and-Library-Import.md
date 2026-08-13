# Root Folders and Library Import

*This page combines three write-ups from different points in the project — real root-folder
browsing/scanning, real file-to-episode matching, and the later fix that made a real import
the authoritative source for a series' Downloaded/Size state — kept in the order they
happened.*

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


---

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
  tiers are *actually configured* right now (tiers are fully user-managed — see
  [Quality Definitions](Quality-Definitions) — so this never returns a tier name that might not
  exist). An
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


---

## Series detail: real per-episode Size, and Library Import as the source of truth

The series detail page's Size stat card (`SeriesPage.jsx`) was never real data — `downloaded count
× 0.47 GB`, a flat per-episode guess with no connection to anything on disk, left over from before
the React migration. Caught by a user comparing it against a real `du -h` on their own library: a
16-episode series reading "7.5 GB" (16 × 0.47) against a real folder that was actually 4.2 GB.

Digging into why the episode count itself was off by more than the Size formula turned up the
deeper issue: **`downloaded` was never real either.** TheTVDB's episode catalog for a series (see
[Metadata Search](Metadata-Search)) is real — titles, air dates, specials included — but the very
first time a series' episodes get cached, `backfillDownloadedState` (`server/routes/episodes.js`)
just marks the first N of them "downloaded" by position, N taken from the series' seeded `eps`
string, with a fabricated plausible quality/size/path (`server/lib/queue-sim.js`,
`server/lib/episode-paths.js`) — nothing here has ever touched a real file. The simulated grab
pipeline (`completeDownload` in `server/routes/queue.js`) does the same thing when a queued
"download" finishes. Meanwhile Library Import (`server/routes/import-files.js`) *does* scan real
files and already wrote their real size/path/quality to matched episodes — but it only ever added
to the downloaded set, never subtracted from it. A series that started out with N fabricated
"downloaded" episodes (including, as in the reported case, real TVDB specials the user never
actually had) stayed looking that way forever, even after running a real import against the user's
actual folder — the fabricated ones just sat there uncorrected alongside whatever the import
matched for real.

Two changes:

- **`import-files.js` now reconciles, not just adds.** After matching real files to real episodes
  the normal way, any episode of that series still marked `downloaded` that this scan *didn't* just
  (re)confirm gets reset — `downloaded = 0`, `quality`/`size_bytes`/`path` all cleared back to
  `NULL`. A real import is treated as the authoritative answer for that series' folder, not an
  addition to whatever fabricated state came before it. This does assume one folder is the complete
  real picture for a series, matching the app's existing one-root-folder-per-series convention
  (`episode-paths.js`'s own fabricated-path layout already assumes the same thing) — a library that
  genuinely splits one series across two separately-imported folders (specials scanned from a
  different path than the main season, say) isn't handled correctly by this, since the second
  import has no way to know about files the first one already matched. Documented as a known
  limitation directly in `import-files.js` rather than left implicit. The response now also
  includes a `reset` array (episode ids reset and why), and Library Import's per-row result text
  (`LibraryImportPage.jsx`'s `ImportResult`) says so explicitly — "N previously-downloaded episodes
  had no matching file in this scan and were marked not downloaded" — rather than silently changing
  a count.
- **The Size stat now sums real bytes.** `SeriesPage.jsx` sums `sizeBytes` across every real cached
  episode (all seasons, not just whichever tab is active) and formats it with the same
  `formatBytes` helper Queue/History/Quality already share, instead of the flat estimate. The flat
  `downloaded-count × 0.47 GB` guess is still there as a fallback for the two cases with no real
  per-episode bytes to sum: Frieren's hand-built demo data, and the generic synthetic episode list
  shown before a series' real TVDB data has loaded at all.

Verified against real files, not simulated ones, since that's specifically what was wrong: created
a disposable test series, seeded 5 fake episode rows directly (4 pre-marked "downloaded" with
fabricated data — the exact shape `backfillDownloadedState` leaves behind — 1 genuinely never
downloaded), then wrote 3 real video files with known real sizes to a real temp directory and
pointed a real root folder at it. Running the real import matched exactly those 3 files with their
exact real byte counts and real paths; the 1 fabricated-downloaded episode with no real file
(episode 4) was correctly reset to not-downloaded, while the episode that was never downloaded to
begin with (episode 5) correctly had nothing to reset. `series.eps` read the real "3 / 5" afterward.
Loaded the real `series.html` page and confirmed the Size stat showed the real byte sum formatted
via `formatBytes` (not the old flat-estimate value that same fixture would have produced). Ran the
same import a second time against the same unchanged folder and confirmed it's idempotent — same 3
matches, nothing left to reset the second time. Full 28-page regression suite passed 28/28
afterward.

## Auto-scan on add, and series.path

Adding a series (via Add New or the originally-seeded titles getting real episodes for the first
time) now also checks whether it already exists on disk, instead of only ever finding out through a
manual Library Import later. `findExistingSeriesFolder`/`scanExistingFilesForSeries` in
`routes/episodes.js` run right after a series' real episode list is first cached
(`resolveAndCacheEpisodesForSeries`) — same real-file matching `import-files.js` uses
(`walkVideoFiles`/`guessSeasonEpisode`/`guessQualityTierName`), just triggered automatically instead
of waiting for someone to notice the files were already there. Unlike a manual import, this never
resets anything: a freshly-added series starts with nothing downloaded, so there's nothing to
reconcile — it only ever adds matches.

That covers files that were already there at add time, but not files that show up *afterward* —
someone copying a folder straight onto a root folder for a series that's already being tracked
(bypassing the grab/import pipeline entirely). The series detail page's **"Rescan for local files"**
button (next to Refresh episodes) covers that case: it calls the exact same
`POST /api/series/:id/import-files` route Library Import's own per-row "Import files" button uses
(matching, real quality/size, and reconciliation — see below — all identical), just without having
to go find the matching row on a different page first. `import-files.js` now accepts two shapes of
request: Library Import's original `{ rootFolderId, folderName }` (scanning a folder before it's
necessarily "this series' folder" yet), or an empty body, which falls back to scanning `series.path`
directly — the real, server-set value described above. A series with no `path` set yet (no root
folder configured when it was added) gets a clear 400 telling you to add one in Settings > Media
Management instead of silently doing nothing; a `path` that doesn't actually exist on disk yet gets
a plain "doesn't exist" result instead of being indistinguishable from "exists but empty."

- **`series.path` is now a real, server-set value everywhere it used to be a guess.** It used to only
  ever get set if someone opened the Edit Series modal and typed/saved one by hand — see
  [Edit Series Modal](Edit-Series-Modal)'s Path section for the fix on that side. Two things set it
  now: `defaultSeriesPathFor()` in `routes/series.js` assigns a real path immediately at add time
  (first configured root folder + sanitized title, `null` if no root folder exists yet), and this
  scan overwrites it with whatever real folder it actually finds — authoritative over the add-time
  guess, since that's genuinely where the files are.
- **No season subfolder or tag → assume season 1.** A bare, season-less filename
  ("Series - 05 [1080p].mkv") used to only resolve unambiguously when a series had exactly one real
  season (`singleSeasonFallback`) — a genuinely multi-season folder left those files unmatched
  entirely rather than guessing which season a same-numbered episode belonged to. A real, confirmed
  case exposed how costly that was: Tsugumomo used to resolve to a single TVDB season (see
  [Metadata Search](Metadata-Search)'s TVDB disambiguation section for why), so its flat filenames
  matched fine via the old fallback — once the disambiguation fix correctly found its real second
  season too, those same files stopped matching at all, with the series just showing 0 downloaded and
  no explanation anywhere. Rather than require every multi-season show to be reorganized into
  `Season N` subfolders before its existing flat files would match at all, a file with no season
  signal whatsoever (no ancestor `Season N` folder per `walkVideoFiles`' `seasonHint`, no `SxxExx` tag
  in its own name — see `guessSeasonEpisode` in `lib/media-files.js`) is now assumed to be season 1,
  in both `scanExistingFilesForSeries` (the auto-scan) and `import-files.js`'s real import. A file
  that DOES carry a real season signal — sitting under its own `Season 2` folder, or an explicit
  `S02E05` tag — still resolves to whatever season that actually says; this only fills in when
  there's nothing to go on at all, so a folder that mixes flat season-1 files with a proper `Season 2`
  subfolder (a common real layout — the newest season gets its own folder, everything older stays
  loose in the root) still resolves both correctly. The real tradeoff: a file that's actually a later
  season but was left loose in the root (instead of its own `Season N` folder) can now match the
  wrong episode instead of being left safely unmatched — favors matching by default for the common
  flat layout over leaving Downloaded stuck at 0. When this assumption is doing real work (the series
  actually has more than one real season), it's logged (`INFO`, not `WARN` — this is now the expected
  default behavior, not a problem) naming the folder and how many files it applied to, so a wrong
  guess is still traceable back to its cause. Library Import's own per-file preview
  (`GET .../subfolders/:name/files`, `root-folders.js`) shows the same assumed season 1 rather than a
  "S?" that wouldn't match what actually happens on import, while still flagging it as an unconfident
  guess.

---

[← Back to Home](Home)
