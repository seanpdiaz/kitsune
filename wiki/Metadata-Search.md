# Metadata Search (MyAnimeList + TheTVDB)

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
  Library immediately (see [Persistence and Logging](Persistence-and-Logging)). Everything the search result doesn't
  give us (episode count, genres, airing status) gets a sensible "just added" default
  rather than being guessed at.
- **Duplicate prevention:** `POST /api/series` rejects (409) an add that matches an
  existing series either by exact `(external_id, external_source)` — the same search
  result added twice — or by normalized title (reusing `normalizeFolderName` from the
  [Root Folders and Library Import](Root-Folders-and-Library-Import) section), which also catches the same show showing up again under
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
  instead of only after its detail page has been opened once (see [Calendar](Calendar)).
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

- **Root Folder / Quality Profile toolbar selects — real now, and actually applied.**
  These two selects sat next to the search box since the original static mockup with a
  comment admitting as much: `/* Not wired up in the original either... */`. Their
  `<option>`s were hardcoded strings (`/anime/library`/`/anime/seasonal` for Root Folder;
  `HD-1080p`/`Ultra-HD`/`SD` for Quality Profile) that didn't match this installation's
  real configured data at all, and picking one had zero effect — `addSeries()`'s
  `POST /api/series` never read either value, so every series landed under whichever root
  folder happened to be first configured (`defaultSeriesPathFor`/`firstConfiguredRootFolder`
  in `routes/series.js`) with no quality profile assigned at all.

  Both now load real data on mount — `GET /api/settings-items/root-folders` and
  `GET /api/settings-items/profiles`, the same endpoints Settings > Media Management's
  `RootFolders.jsx` and Settings > Profiles' `ProfilesPage.jsx` already use — defaulting
  to whichever item is first in each real list (position order). Selecting one and adding
  a series now sends `rootFolder`/`qualityProfile` on the `POST /api/series` body, and the
  server actually uses them: `resolveRootFolder()` (`routes/series.js`) only accepts a
  `rootFolder` that exactly matches one of the real configured root folders — never passed
  straight through to a filesystem path unchecked, since any other caller of this same API
  could otherwise point a new series at an arbitrary directory — falling back to the first
  configured one (logging a warning) for a stale/unconfigured value, or silently for a
  request that omits it entirely (every pre-existing caller of this endpoint). A
  `qualityProfile` name is stored as-is on the new `series` row's `quality_profile` column,
  same "trust the UI to only offer real choices" convention `PATCH /api/series/:id`'s own
  handling of the same field already uses — no separate validation against the real
  profiles list a second time. Both selects show a disabled "No … configured" option
  instead of stale placeholder text when Settings has nothing configured yet, or the fetch
  itself failed.

  Verified against the real production database (not a test one): `POST /api/series` with
  no `rootFolder` still falls back to the one real configured root folder
  (`/Volumes/Anime`); with `rootFolder` set to that real path *and* `qualityProfile: 'Sean'`
  (one of the 8 real profile rows already confirmed to exist in this installation), both
  land correctly on the created row; and with a bogus, unconfigured `rootFolder`, the
  request still succeeds by falling back to the real configured folder, with the expected
  warning logged rather than silently accepting a directory this app has no record of. All
  three test rows were deleted immediately after.

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
- **Season names default to whatever language TVDB itself defaults to** — same issue
  base episode titles have, but unlike titles there's no per-episode translation
  endpoint for a season name, and no cheap way to fetch an English one from the
  `/episodes/default` response this already uses. A real, confirmed case: Tsugumomo's
  second season name came back as raw Japanese ("継つぐもも"), rendering untranslated as
  the segment tab's label instead of the plain "Season 2" fallback a nameless season
  already gets. `stripUntranslatedSeasonName` in `tvdb.js` treats any season name
  containing CJK or Hangul script as "not usefully translated" and drops it to `null` so
  that fallback applies — the same outcome as if TVDB had no name for that season at
  all. A Latin-script native name (romaji, etc.) is left alone since that's at least
  readable. This only affects newly-fetched episodes; a season name already cached
  before this fix stays as-is unless its series' episode rows are deleted and re-fetched
  (or the season is manually renamed — see below).
- Because search and episodes are two unrelated catalogs (MyAnimeList ids and TVDB ids
  don't correspond to each other), a MAL-added series has no TVDB id to start with.
  Resolving one means searching TVDB for the series' own title (the same anime-filtered
  search the search fallback uses) — the result is cached on the series row
  (`tvdb_episode_id`) so that search only ever runs once per series. A series originally
  added via the TVDB search fallback already has a usable TVDB id and skips this step
  entirely. Because this is resolved by title rather than tied to how a series was
  added, it works for *any* series — including the 21 originally-seeded titles, which
  can now get real episodes too, not just ones added through Add New.
- **Disambiguating multiple matches:** a title search can come back with more than one
  "series" result for the same anime — TVDB sometimes models a movie, OVA, or special as
  its own separate series record rather than a season of the main show (a real example:
  searching "Tsugumomo" returned 3 series-type results, and naively taking the first one
  resolved to a 1-episode OVA entry instead of the actual 13-episode TV series). Just
  taking the first search result silently locks a series onto whichever one TVDB happened
  to rank first, with no signal that it picked wrong beyond an oddly short episode list.
  `pickBestTvdbCandidate` in `tvdb.js` fixes this in two steps:
  1. **Filter to title matches first.** `titlesLooselyMatch` (normalizes both strings to
     bare lowercase letters/digits, then checks equality or substring containment)
     narrows the raw search results down to only the ones that are actually the show
     being searched for. This step matters more than it sounds: TVDB's search index can
     return a result with no real title relationship to the query at all — the same
     "Tsugumomo" search also came back with "King's Raid: Successors of the Will" as one
     of its 3 results, entirely unrelated by title. An earlier version of this fix probed
     every raw result's episode count with no title filter first, which correctly beat
     the 1-episode OVA but then confidently mismatched Tsugumomo onto that unrelated
     26-episode show, since 26 > 13 and nothing was filtering it out. Episode count is
     only a meaningful signal among candidates that are already confirmed to be the
     right show by title — it says nothing on its own.
  2. **Then disambiguate by episode count.** Among the title-matched candidates (capped
     at the first 4), probe each one's real episode count (`countTvdbEpisodes`, a
     pagination-only call that skips the per-episode translation fetch) and pick
     whichever has the most — the real TV series is virtually always the fuller one next
     to a same-titled OVA/movie/special entry.

  A single search result, or exactly one title match, skips probing entirely and
  resolves directly — no cost or behavior change for the common, unambiguous case. If
  TVDB's search returns results but *none* resemble the query by title, this falls back
  to TVDB's own top-ranked result (logged) rather than guessing off episode count alone.
  This all runs for both the primary title and, if that comes back empty, each alt title
  in turn.
- The tradeoff of resolving by title: it can still occasionally match the wrong show if
  TVDB's title search returns something genuinely ambiguous in a way episode count
  doesn't resolve (a remake with a similarly-sized episode count, a same-named
  live-action series, etc.) — there's no perfect fix for that without an id crossing
  over some other way. If a series ever gets the wrong episode list, use the "Refresh
  episodes" button on its detail page, or delete its cached rows from the `episodes`
  table (and clear `tvdb_episode_id` on the series row so the match itself is retried,
  not just the episode data) and re-fetch, to retry the match.
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


---

[← Back to Home](Home)
