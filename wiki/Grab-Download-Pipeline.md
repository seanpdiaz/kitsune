# Grab / Download Pipeline

## Grab/download pipeline

Everything downstream of "here's a missing episode" used to be inert: Activity's Queue/
History/Blocklist pages were fixed hardcoded arrays that never changed no matter what you
clicked, Wanted's Search/Search All buttons didn't do anything, and an episode's
missing/downloaded state on the series detail page was a guess computed at render time
from the series' "N / M" episode count rather than anything real per episode. This section
covers turning that into an actual, real, working grab-to-completion loop — the biggest
single piece of work in this pass, and (deliberately) the one place in the app that's
simulated rather than hitting a real external service, explained below.

**Update:** this is no longer true for one indexer. Nyaa.si is now a real search — see [Real
Search and Grabs](Real-Search-and-Grabs) — and a grab against a real result now genuinely submits
to a real, configured qBittorrent client when one's available, falling back to everything below
exactly as it always worked when it isn't. Everything in this section still accurately describes
the fallback path, and every other indexer.

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
  cached from TVDB (see [Metadata Search](Metadata-Search)), `backfillDownloadedState()` in
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
  choice, made right after documenting (see [Code Structure](Code-Structure)'s page-tabs
  section) that the existing
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
fresh per request, not the cached value stored on a root folder at add time — see
[Root Folders and Library Import](Root-Folders-and-Library-Import)). The page's Health card stays synthetic — Indexers/Download
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
suite (see [Code Structure](Code-Structure)) was re-run after every change in this section and passed
28/28 each time, including a dedicated check that System > Status renders real fetched
values into the DOM rather than its old placeholders.


---

[← Back to Home](Home)
