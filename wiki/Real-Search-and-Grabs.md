# Real Search and Grabs (Nyaa.si + Prowlarr + qBittorrent)

## The boundary this crosses

[Grab / Download Pipeline](Grab-Download-Pipeline) explains why the whole search → grab →
download → import loop was built simulated end-to-end: no real indexer, no real download client,
entirely internal to `server.js`. [Download Clients](Download-Clients) later added one real
exception to half of that (qBittorrent/NZBGet connection Test, then full torrent management —
add/list/pause/resume/delete a real client's real torrents), but explicitly stopped short of
touching the grab pipeline itself, since there was no real indexer to feed it real magnets.

This closes that gap for one real indexer. Settings > Indexers' Nyaa.si row is now a real,
public, unauthenticated torrent search — no API key, nothing to configure beyond enabling it —
and when it's enabled, Wanted Missing / Cutoff Unmet / the series detail page's Search button
shows real Nyaa.si results with real magnet links. Grabbing one now genuinely submits that magnet
to a real, configured, enabled qBittorrent client, and Activity > Queue tracks its real progress
by polling qBittorrent instead of a random ticker — pause, resume, and remove all act on the real
torrent too.

Settings > Indexers' Prowlarr row is a second, independent real integration (see
[`server/lib/prowlarr-search.js`](#server%2Flib%2Fprowlarr-search.js--the-second-real-search) below)
— Prowlarr is an indexer *aggregator*, so one enabled Prowlarr row can search Nyaa.si plus any
other tracker a user has configured there in a single request, rather than Kitsune needing a
direct integration per tracker. Nyaa.si direct and Prowlarr can both be enabled at once — see
[GET /api/releases — merging multiple real indexers](#get-apireleases--merging-multiple-real-indexers)
below for how their results get combined without showing the same torrent twice.

Every other seeded indexer (AnimeBytes, SubsPlease RSS, AniDex, Erai-raws) is exactly as
simulated as before — these are two narrow real exceptions, the same shape as qBittorrent being the
one real download client while NZBGet stayed Test-only.

**What's still simulated, deliberately:** if Nyaa.si is disabled, a live search fails, or no
enabled qBittorrent client is reachable when you grab, everything falls back to the exact same
simulated behavior this app always had — same random-progress ticker, same rare-failure/
blocklist path, same fabricated file path. A grab is never left half-real; it's either fully real
(real search result, real magnet, real client, real tracked progress) or fully simulated, with a
clear reason surfaced either in the release picker (a notice, not an error) or the server log (a
warning) for why.

**What used to stop here, and now doesn't:** real file import. A real qBittorrent download
completing now genuinely hardlinks (or copies) the actual downloaded file into the Library's real
folder structure — see [Real Import](#real-import--from-download-client-to-library) below — rather
than just fabricating a plausible-looking `path` the way every prior real-submission-and-tracking
pass still did. The one thing that still doesn't happen: this app never inspects a file's actual
video content (resolution, codec, duration) to confirm it matches what was expected — `quality` is
still whatever the release title was classified as at search time, not something read back off the
real file. Sonarr/Radarr don't fully do this either without ffprobe-equivalent tooling this
zero-dependency backend doesn't carry.

## `server/lib/nyaa-search.js` — the real search

No official JSON API exists for Nyaa.si — this is built directly against
[nyaadevs/nyaa](https://github.com/nyaadevs/nyaa), the actual open-source codebase nyaa.si runs,
rather than assumed:

- **Pagination:** `searchWithFallback` pages through up to 15 pages (`&p=N`) of a query before
  giving up on it and trying the next title. nyaa.si's default sort with no `s=`/`o=` is upload
  date descending, not relevance — for a show with years of re-uploads (BD batches, raw groups,
  other fansub groups reposting the same episodes over time), the real original weekly episode
  release can be genuinely indexed and still nowhere on page 1. Confirmed directly against the live
  site, twice: an initial manual check placed Tsugumomo's real single-episode releases "around page
  6," so the cap was set to 6 — real production logs then showed that estimate was one page short.
  Pages 1-6 (450 results — nearly Tsugumomo's entire 456-result catalog) genuinely had zero
  episode-1 matches; the real matching releases (`[Ohys-Raws] Tsugumomo - 01 ...`,
  `[Leopard-Raws] Tsugumomo - 01 RAW ...`) sit on page 7, the show's actual last page. Raised to 15
  to leave real headroom past one specific show's exact result count rather than re-hitting the
  same off-by-a-page problem for a slightly longer-tailed one. Stops as soon as a page returns zero
  raw results (nyaa.si has run out) or a page's results satisfy `matchFn` — the empty-page check is
  what keeps the overwhelming majority of searches (a normal currently-airing show, page 1 already
  has everything) to a single request; the 15-page cap only matters for shows with an unusually
  long re-upload history like this one.
- **Query:** `GET https://nyaa.si/?page=rss&q=<title>&c=1_0&f=0&m=1` — `m=1` is an
  undocumented-but-confirmed-in-source flag that makes nyaa.si put a ready-made magnet URI
  straight into each item's `<link>` (using nyaa.si's own default tracker list) instead of a
  `.torrent` download link — simpler and more robust than hand-building magnets, though a fallback
  magnet builder (from the `nyaa:infoHash` field + a copy of nyaa.si's own bundled tracker list)
  exists in case that ever stops working.
  **`c`/`f` used to be narrower** — `c=1_2` ("Anime - English-translated" specifically, not the
  whole Anime category) and `f=1` (excludes uploads nyaa.si flags as remakes) — on the theory that
  narrowing server-side would cut noise before it ever reached this app's own title-matching. A
  real, confirmed case showed the opposite: a well-known HorribleSubs episode release — clearly
  real and English-subbed, immediately visible searching nyaa.si directly with no category filter
  — never came back from this app's own search at all, even though `titleMatchesEpisode` and
  `isBatchRelease` both correctly accepted that exact title in isolation. The most likely
  explanation is upload-time category tagging on nyaa.si itself being inconsistent (common for
  older uploads) — some genuinely English-subbed releases just sit under the general Anime
  category rather than specifically `1_2`. `c` is now `1_0` (every Anime subcategory) and `f` is
  `0` (no remake filter, since "remake" is a self-reported uploader flag, not a reliable "not
  wanted" signal) — trusting content-level filtering (`titleMatchesEpisode`/`isBatchRelease`,
  below) to do the real narrowing instead of nyaa.si's own per-upload category/flag choices, since
  silently missing a wanted release is worse than an occasional irrelevant result the user just
  ignores.
- **Parsing:** a small regex-based RSS extractor, not a library — this backend has none (see
  README) and RSS's flat `<item>...</item>` shape doesn't need one. Reads the `nyaa:` namespace
  fields directly (`nyaa:infoHash`, `nyaa:seeders`, `nyaa:leechers`, `nyaa:size` — a formatted
  string like "1.3 GiB", parsed into real bytes — `nyaa:trusted`).
- **Episode matching:** a real search is by title only (Nyaa has no per-episode API), so results
  get filtered client-side against a handful of regex shapes real release titles actually use
  ("E12", "- 12 (1080p)", "- 12", zero-padded standalone) — best-effort, not a real parser, since
  a release title is free text. If the primary series title's search doesn't turn up a match for
  the episode being searched, every one of `series.alt_titles` gets tried in turn — the exact same
  fallback pattern `server/lib/tvdb.js`'s `resolveTvdbEpisodeSourceId` already uses for the
  identical "the official title isn't what this external source calls it" problem (a MAL-added
  series' English title frequently isn't what a fansub group's release titles use either).
  **Excludes batch releases:** a season/series batch title ("Tsugumomo (01-12) [1080p]") very often
  contains a bare number that also satisfies a single episode's own match pattern — "01-12" matches
  episode 1 exactly as readily as a real single-episode release's "- 01 -" would, so an
  unfiltered per-episode search could surface a whole-season torrent alongside genuine
  single-episode ones. `searchReleasesForEpisode` now also requires `!isBatchRelease(title)` — the
  same batch-detection heuristic `searchBatchReleases` (Search Season / Search All, below) already
  uses in the other direction, just excluding instead of requiring it here.
  **Never sends an empty/near-empty query:** `simplifyTitleForSearch` only keeps `[A-Za-z0-9]`
  characters, so a purely non-Latin alt title (Tsugumomo's own `つぐもも`, for instance) reduces to
  an empty string. A real, confirmed case: `searchWithFallback` tried that attempt anyway, sending
  Nyaa an unscoped `q=`, which came back with whatever's newest across the whole Anime category —
  entirely unrelated to the series being searched — and one of those unrelated titles happened to
  still satisfy the loose episode-number regex above, so it got shown to the user in place of the
  real release. `searchWithFallback` now skips any attempt whose simplified query is under 2
  characters, and skips a query identical to one already tried in the same fallback loop (the
  primary title and an alt title are sometimes literally the same string).
- **Quality classification:** a real title ("[SubsPlease] Frieren - 12 (1080p) [ABCD1234]") has to
  map onto one of this app's own user-managed quality tiers (Settings > Quality). Resolution is
  parsed from an explicit tag (essentially always present in a real release title); source
  (WEB/Bluray/HDTV) is often *not* explicitly stated, and defaults to WEBDL when missing — anime
  simulcast fansub releases are overwhelmingly WEB-sourced, a much safer assumption than guessing
  a specific resolution when even that's missing (which instead reports `Unknown` rather than
  guessing 1080p and possibly being wrong).
- **Logging (System > Logs, logger `IndexerService`):** every real search logs its full trail —
  which title attempts it's trying and why (`INFO`), each individual Nyaa.si request URL (`DEBUG`),
  each page's raw result count vs. how many survived the RSS parser's magnet/infoHash requirement
  (`DEBUG`), each page's match count against the search's filter (`INFO`), and the final outcome
  per attempt and overall (`INFO`, or `WARN` on a genuine network/HTTP failure). Added specifically
  so a "why isn't this release showing up" report can be diagnosed from the logs alone — same level
  of visibility that manually re-running the same query directly against nyaa.si and reading the
  response gives, without needing to do that by hand each time.
- **Etiquette:** a normal browser-shaped `User-Agent` (nyaa.si doesn't document a required one,
  but community reports note bare/bot-shaped clients occasionally getting blocked by its
  Cloudflare-style protection), an 8-second timeout via `AbortController` (same pattern as every
  other real integration in this app), and `/download` (the one path nyaa.si's own `robots.txt`
  disallows) is never touched — this only ever fetches the RSS search page, never a `.torrent`
  file.
- **`testNyaaReachable()`** backs Settings > Indexers' now-real Test button for the Nyaa.si row
  specifically (`POST /api/indexers/:id/test`, `server/routes/indexers.js`) — same real-vs-fake
  split Download Clients and Connect's Pushover type already established
  (`isNyaa`/`isPushover` gates in `ConnectionManager.jsx`). Every other indexer 400s if pointed at
  this route. The seeded Nyaa.si row gets a `type: 'nyaa'` field (a rename-proof signal, same role
  `type` plays on download-clients rows) — new installs get it from the seed directly; a database
  that already seeded its indexers table before this feature gets it backfilled on next startup
  (`settings-items.js`, matched by name once, then never needed again).

## `server/lib/prowlarr-search.js` — the second real search

Added after the Nyaa.si pagination/category work above, once a real Prowlarr instance was
available to design against. Unlike Nyaa.si, Prowlarr ships a real JSON REST API — confirmed
against the official Servarr wiki (`wiki.servarr.com/prowlarr/search`) and Prowlarr's own
OpenAPI-generated client docs (`devopsarr/prowlarr-py`) — so this doesn't need Nyaa.si's own
regex-based RSS/XML parsing; it's a normal `fetch` + `res.json()`.

- **Query:** `GET {baseUrl}/api/v1/search?query=<title>&type=search&indexerIds=-2&limit=100`,
  authenticated with an `X-Api-Key` header (the same header Prowlarr's own web UI and Sonarr/
  Radarr's Prowlarr integration use). `indexerIds=-2` is Prowlarr's own documented shorthand for
  "every configured torrent indexer" — explicitly excluding `-1` (usenet), since Kitsune's grab
  pipeline only knows how to hand a magnet/`.torrent` URL to a torrent client, not an NZB to a
  usenet downloader. No `categories` filter is sent — the exact same lesson already learned the
  hard way with Nyaa.si's own `c=1_2` category bug above: a tracker's category tagging is
  inconsistent enough that narrowing server-side risks silently hiding a real, wanted release, and
  content-level filtering (`titleMatchesEpisode`/`isBatchRelease`, reused directly from
  `nyaa-search.js` rather than duplicated) already does the real work of deciding what's relevant.
- **No deep pagination:** Nyaa.si's own search gained `MAX_PAGES_PER_ATTEMPT` pagination (above)
  specifically because a single tracker's back-catalog releases get buried past page 1 by years of
  re-uploads. Prowlarr has an `offset` param for the same purpose, but it's a confirmed-broken
  feature in real Prowlarr right now (`Prowlarr/Prowlarr#1256` on GitHub — offset doesn't actually
  skip records correctly), so this deliberately doesn't depend on it; a single `limit=100` request
  is sent and that's it. Because Prowlarr aggregates every configured tracker in one request rather
  than one tracker's own single feed, this is far less likely to hit the same burial problem than
  Nyaa.si alone was — but for a show old enough on every one of a user's configured trackers, it
  still could. Worth knowing if a Prowlarr search comes up empty for something genuinely old.
- **`magnetUrl` or `downloadUrl`, whichever a result has:** a magnet is used directly when a
  tracker provides one; otherwise Prowlarr's own `downloadUrl` (a proxied link to the `.torrent`
  file, with whatever auth Prowlarr itself needs already in the URL) works exactly the same way —
  `routes/queue.js` already hands `release.magnetUrl` straight to qBittorrent's `addTorrent()`,
  which accepts either a real magnet or a URL to a `.torrent` file (qBittorrent fetches it itself),
  so no separate code path was needed for the two cases.
- **`testProwlarrReachable()`** backs the same `POST /api/indexers/:id/test` route Nyaa.si's Test
  button uses (`server/routes/indexers.js` now branches on the saved row's `type`), hitting
  Prowlarr's own `/api/v1/system/status` — the same lightweight "is this instance up and does it
  accept this API key" check Sonarr/Radarr's own Prowlarr connection test performs, without running
  an actual search. A Prowlarr row needs real credentials to do anything (unlike Nyaa.si, which
  needs none) — Base URL + API Key fields in the edit modal (`isProwlarr` gate in
  `ConnectionManager.jsx`, same shape as Connect's Pushover type's real fields), both auto-saving on
  every keystroke the same way every other field on this page already does, so the modal's own Test
  button (new — Nyaa.si's row never needed one, since it has nothing to mistype) always tests
  whatever's currently typed without a separate unsaved-overrides path.
- **Self-signed certificates:** a real, reported case — a Prowlarr instance reachable at an
  internal `.lan` address with its own self-signed cert (alongside a public `.cloud` address with a
  real one) failed with an unhelpfully generic `Could not reach Prowlarr: fetch failed`. Confirmed
  directly against a real self-signed HTTPS server: Node's global `fetch` wraps the actual reason in
  `err.cause` (`Error: self-signed certificate`, `code: DEPTH_ZERO_SELF_SIGNED_CERT`) rather than
  `err.message` — every network error follows this same shape, not just TLS ones, so
  `describeFetchError()` now surfaces `err.cause` in general, with a specific hint toward the new
  toggle for the certificate-shaped error codes. That toggle — "Allow self-signed certificate" on a
  Prowlarr row — actually skips verification via a small hand-written `https.request`-based fetch
  replacement (`rawRequest()`), not `fetch` itself: Node's built-in global `fetch` has no documented
  per-request way to disable certificate verification without constructing a custom `undici` Agent,
  and the `undici` package isn't installed in this environment (confirmed — neither
  `require('undici')` nor `require('node:undici')` resolve), nor is it one of this zero-dependency
  backend's own dependencies to begin with. `https.request`'s own `rejectUnauthorized: false` option
  does the same thing with nothing to install. Verified end-to-end against a real self-signed HTTPS
  server (not mocked): fails with the specific cert error and toggle hint when off, succeeds when
  on, and — importantly — still correctly rejects a wrong API key even with the toggle on, so
  "skip cert verification" never silently doubles as "skip auth."
- **Redirects and non-JSON responses:** a second real case, found immediately after the toggle
  above shipped — a Test came back `Prowlarr returned status 302` instead of a clear pass/fail.
  Confirmed directly (a real local redirect test): `fetch` follows redirects transparently by
  default, landing on the *final* response rather than ever exposing the 302 itself, but
  `rawRequest()` (the `allowInsecureSsl` path above) didn't replicate that — it just returned
  whatever status came back, redirect included. `rawRequest()` now follows redirects itself (up to
  10 hops, mirroring a normal HTTP client's sane default), so both paths behave the same way. That
  alone doesn't guarantee success, though: if something between this server and Prowlarr's real API
  (Prowlarr's own Authentication setting requiring a browser login, or a reverse proxy/SSO gate in
  front of a publicly-exposed instance) redirects an API request to a login page, the *final*
  response is a normal `200` — just one holding an HTML login page instead of JSON. `res.ok` alone
  can't tell the difference, so `parseJsonResponse()` now checks the actual body/Content-Type for
  an HTML shape before trying to parse it as JSON, and reports specifically that the response looks
  like a redirected-to login page rather than a generic JSON-parse error. Verified against a real
  local server reproducing this exact case (a 302 to an HTML page) on both the plain-`fetch` and
  `rawRequest` paths.
- **Base URL matters — port and host both:** the 302/HTML case above turned out to have a much
  simpler root cause in the real reported case: the configured Base URL (an internal `https://` address
  with no port) wasn't actually reaching Prowlarr at all — Prowlarr's own default port is `9696`, and
  the real working address (confirmed from that same user's existing, working Sonarr → Prowlarr
  Torznab connection) was `http://<host>:9696`, plain HTTP, on a *different* internal hostname than
  first configured. Hitting the wrong host/port over HTTPS landed on some unrelated service that
  redirected to its own login page — exactly the HTML-response symptom above, but from a
  misconfigured address, not a real bug in this integration. Worth checking directly (open the Base
  URL in a browser and confirm it's genuinely Prowlarr's own dashboard) before assuming a code
  problem when this error shows up.
- **A real (and different) case even once the Base URL was fixed:** once actually reaching
  Prowlarr, a plain `"Tsugumomo"` query returned exactly `SEARCH_LIMIT` (100 at the time) results —
  every one a batch/BD/compilation re-upload, zero individual-episode releases anywhere in that set,
  confirmed directly from real production logs. Same root shape as the Nyaa.si burial problem
  pagination fixed above, but Prowlarr's own broken `offset` param rules out paging past it the same
  way. `searchReleasesForEpisode` now folds the episode number into the query itself instead —
  `"Tsugumomo 01"` via the same `extraQueryTerm` mechanism `searchBatchReleases` already used for a
  season's own name — asking Prowlarr's (and each underlying tracker's) own relevance ranking to do
  the narrowing server-side, tried before the bare title. `SEARCH_LIMIT` was also raised past
  Prowlarr's documented *default* (100, not a confirmed hard maximum) on the chance a single request
  can return more — harmless to try since Prowlarr would just clamp it back down if not.
- **Verification:** the live Prowlarr instance this was built against
  (`https://prowlarr.diaz.cloud`) wasn't reachable from this session's sandbox — `web_fetch`
  returned empty/no content for it with no error (looks like a declined fetch, not a network
  failure — see `<web_content_restrictions>`), and the sandbox shell has no general internet egress
  at all (confirmed separately). Verified instead against Prowlarr's own documented real response
  shapes (field names, auth failure status codes, the `magnetUrl`-vs-`downloadUrl` split) with
  mocked `fetch` responses, including a full `routes/releases.js` pass with both Nyaa.si and
  Prowlarr "enabled" at once returning the *same* torrent (same `infoHash`) from both, confirming
  the dedup below actually collapses it to one result rather than showing it twice. Live
  confirmation against the real instance is still outstanding — check Settings > Indexers' Test
  button after restarting.

## `GET /api/releases` — merging multiple real indexers

Both Nyaa.si direct and Prowlarr can be enabled at once — `enabledRealIndexers()` in
`server/routes/releases.js` reads every enabled real row (`nyaa`, or `prowlarr` with both a Base URL
and API Key actually set), and `searchRealIndexers()` runs all of them in parallel for a given
episode/batch search.

- **Dedup:** the same torrent can genuinely come back from two sources at once — most plausibly a
  Prowlarr instance that itself proxies Nyaa.si, so the direct Nyaa.si integration and Prowlarr both
  return the identical release. Deduped by `infoHash` first (falling back to `magnetUrl` for the
  rare release with no parsed `infoHash`), keeping whichever copy reports the higher seeder count —
  Nyaa.si's own direct RSS and a Prowlarr-proxied fetch of the same tracker can report slightly
  different seeder counts depending on exactly when each was fetched.
- **Partial failure isn't full failure:** if one enabled real indexer errors (unreachable, bad API
  key, timed out) while another succeeds, the results still come back real — from whichever
  indexer(s) actually answered — with a notice naming which one failed and why, rather than the
  whole search silently degrading to simulated results just because one of several real indexers
  had a bad moment. Simulated is still the fallback, but now only when *every* enabled real indexer
  fails, or none are enabled at all.

## `server/routes/releases.js` — why grabbing needed a cache

The old simulated releases were fully deterministic (seeded RNG keyed off episode id + candidate
index) — the same episode always generated the exact same candidate list, so `POST /api/queue`
could cheaply re-run the same generator server-side to safely re-derive whatever the client picked
by index. A real Nyaa.si search isn't repeatable that way — a second live query moments later
could return different results, a different order, or fail outright. `GET /api/releases` now
caches the exact sorted list it just returned for 10 minutes, keyed by scope
(`buildReleaseCacheKey` — `episode:<id>`, `season:<seriesId>:<seasonNumber>`, or
`series:<seriesId>`, see [Batch grabs](#batch-grabs--searching-and-grabbing-a-whole-season-or-series)
below); `POST /api/queue`'s `releaseIndex` reads the grabbed release back out of that same
scope-keyed cache instead of re-searching. Falls back to the same "Unknown release — search again"
error the old index-out-of-bounds case already returned if the cache has expired, the server
restarted, or a grab is attempted against a scope that was never actually searched.

Every simulated fallback release also gets tagged `source: 'simulated'` (the real ones,
`source: 'real'`) — the release picker modal shows "(simulated)" next to the indexer name when
that's what's on screen, and a notice banner explains why (Nyaa.si disabled, or a live search that
just failed) whenever the results aren't real, so what's shown is never silently mistaken for a
real result.

## `server/routes/queue.js` — real vs. simulated, side by side

Every `queue` row now carries a `source` column (`'real'` or `'simulated'`, plus `magnet_url`/
`torrent_hash`/`download_client_id` for real ones — migrated onto the existing table the same
`PRAGMA table_info` + `ALTER TABLE` pattern `series.js` already established for its own
after-the-fact columns).

**Grabbing:** a real release with a real magnet gets one shot at an enabled qBittorrent client
(lowest `clientPriority` first, matching the field's own "lower runs first" description) — if
`addTorrent` succeeds, the row is real and tracked for real from here on. If there's no eligible
client, or the submit call itself fails, the grab still happens (the release's real
title/quality/size are kept) but falls back to the simulated ticker, with the reason logged
server-side and returned as a `warning` on the grab response.

**Real bug found and fixed: a "successful" grab that never reached qBittorrent.** A real report —
Kitsune's own log said `Grabbed "[HorribleSubs] Tsugumomo - 01 [1080p].mkv" ... — submitted to a
real qBittorrent client`, `POST /api/queue` returned `201`, a Pushover grab notification went out —
but the torrent never actually appeared in qBittorrent. The root cause was in
`server/lib/download-clients/qbittorrent.js`'s `addTorrent()`: qBittorrent's own WebUI API docs for
`POST /api/v2/torrents/add` say it "Returns `Ok.` or `Fails.`" — critically, **both** of those come
back as HTTP 200. The previous version of `addTorrent()` only checked `res.status`/`res.ok`, never
the response body, so a `200 "Fails."` response (a magnet qBittorrent rejects as invalid or as a
duplicate of something it already knows about in a conflicting state, an unreachable/invalid
`.torrent` URL, etc.) was indistinguishable from real success — recorded as `{ ok: true }`, which is
exactly what let `routes/queue.js` mark the row `source: 'real'` and log "submitted to a real
qBittorrent client" for a torrent that was never actually added.

Fixed by reading the response body and checking it explicitly: a body of `"Fails."` now returns
`{ ok: false, error: '...' }`, which correctly falls the grab back to the simulated path with the
real reason logged (`logWarn`, logger `DownloadClient`) and returned as the grab's `warning` field —
the same graceful-degradation path a missing/unreachable client already used. Any body that's
neither `"Ok."` nor `"Fails."` (an unexpected proxy response, say) is logged as a warning too rather
than silently treated as success either way. Verified against a real local HTTP server reproducing
qBittorrent's exact documented `200 "Ok."` / `200 "Fails."` response shapes — confirmed the fix
correctly rejects the `"Fails."` case and still accepts the `"Ok."` case.

**Second real bug, same symptom, found from the very next live retest:** with the `"Fails."` fix in
place, qBittorrent genuinely *did* say `"Ok."` — and the torrent still never appeared. The real log
line this time showed the release only had a Prowlarr `downloadUrl` (no magnet at all):
`http://prowlarr.diaz.home:9696/4/download?apikey=...&link=...&file=...`. Some indexers proxied
through Prowlarr only expose this kind of "fetch the .torrent file yourself" download link rather
than a magnet with the hash already embedded (see `prowlarr-search.js`'s
`r.magnetUrl || r.downloadUrl || null` fallback). The old code handed that URL straight to
qBittorrent as the thing *it* should fetch — but that fetch happens asynchronously, on
qBittorrent's own host, which isn't guaranteed to share Kitsune's network path to the indexer. In
this exact case, Kitsune's own search had already proven it could reach `prowlarr.diaz.home:9696`,
but qBittorrent's host apparently couldn't — so qBittorrent accepted the request (`"Ok."` — it did
receive a request it considered well-formed), tried to fetch the link on its own in the background,
and silently got nowhere. No error ever came back to Kitsune to catch, because qBittorrent's HTTP
response to `/torrents/add` doesn't wait for that fetch to finish.

Fixed by no longer delegating that fetch to qBittorrent at all: when a release's link isn't a
`magnet:` URI, Kitsune now fetches the real `.torrent` file bytes itself (over the same network
path its search already proved works) and uploads the actual file to qBittorrent via
`/api/v2/torrents/add`'s `torrents` multipart field, instead of its `urls` field. qBittorrent never
needs to reach the indexer at all in this path. Since the file's real BitTorrent info hash is what
`realTick()` needs to poll qBittorrent for this row's progress, and not every indexer supplies one
through Prowlarr's API, a new `server/lib/bencode.js` computes it directly from the fetched
`.torrent` bytes — SHA-1 of the exact raw bencoded byte range of the top-level `info` value (per the
BitTorrent spec; a re-encoded/reconstructed value could produce the wrong hash even for
equivalent-looking content, so this only ever tracks byte offsets while walking the file, never
rebuilds it). Falls back to whatever info hash the indexer itself supplied when there is one, and
only computes it from the file when there isn't.

`server/lib/download-clients/qbittorrent.js`'s `addTorrent()` now accepts either `{ url }` (a magnet
or a URL to hand qBittorrent, unchanged — still what the Torrents modal's manual add and Nyaa.si's
always-real magnets use) or `{ torrentFileBuffer, filename }` (uploads the file directly as
multipart, used for Prowlarr's download-URL-only releases). `server/routes/queue.js`'s two grab
paths (single-episode and batch, previously two separate near-identical blocks) were consolidated
into one shared `submitRealGrab()`/`fetchTorrentFile()` pair so this logic exists in one place.

Verified in stages against real local servers: `bencode.js`'s `computeInfoHash` against a hand-built
bencoded fixture exercising every value type (string/int/list/nested dict), cross-checking the
extracted byte range and the resulting SHA-1 independently; then the full path — a mock "indexer"
serving real `.torrent` bytes, fetched and re-hashed by Kitsune, then uploaded to a mock qBittorrent
server that inspects the raw multipart body to confirm a `torrents` file field carrying the exact
original bytes was sent (not a `urls` field) — while the existing magnet path was re-verified
alongside it to confirm it still sends `urls` exactly as before. Not verified against the user's own
live Prowlarr/qBittorrent instance directly (unreachable from this environment) — next real grab
attempt is what confirms this end-to-end.

**Third real bug, same investigation, one retest later:** the fetch-and-upload path above engaged
correctly on the very next live retest, but `fetchTorrentFile()` itself failed with nothing more
than `Could not fetch the .torrent file: fetch failed` — the exact same opacity problem this app
already hit and fixed once for Prowlarr's own search/status calls (Node's global `fetch` wraps the
real reason — DNS failure, connection refused, TLS issue — inside `err.cause`, leaving `err.message`
a generic, useless "fetch failed"). Rather than duplicate that fix, `prowlarr-search.js`'s
`describeFetchError` is now exported and reused directly in `queue.js`'s `fetchTorrentFile()`.
Verified against two real local network failures (a real connection-refused port and a real
nonexistent hostname) that each now surface their actual underlying reason instead of the generic
message.

**Fourth real bug: the download link redirected straight to a magnet.** With the error now visible,
the very next retest showed the real reason: `URL scheme must be a HTTP(S) scheme`. Confirmed against
a real local server issuing the exact same kind of response: a Prowlarr download URL for a very old
Nyaa.si release doesn't always have a static `.torrent` file to serve — the underlying tracker
proxied through it can respond with a plain `302` redirect straight to a `magnet:` URI instead. `fetch()`
can't follow a redirect to a non-http(s) scheme and throws instead of exposing the `Location` header,
which is exactly what "URL scheme must be a HTTP(S) scheme" meant here. Fixed by having
`fetchTorrentFile()` request with `redirect: 'manual'` and read `Location` itself: a `magnet:`
redirect is treated as a real, usable magnet (returned as `magnetUrl`, with the info hash pulled
straight out of its `xt=urn:btih:` parameter) rather than a failure, while a normal `http(s)` redirect
is still followed (manually, up to 10 hops) exactly as `fetch()`'s own default would have done.
`submitRealGrab()` now checks for this case and submits the magnet directly to qBittorrent instead of
attempting a file upload. Verified against four real local server behaviors in one pass: a
magnet-redirect, a chained `http → http → file` redirect, a direct file fetch, and a plain 500 error —
the magnet and chained-redirect cases both produced correct results (matching info hashes between the
direct-fetch and redirect-chased versions of the same file), confirming the redirect handling doesn't
corrupt anything along the way.

**Fifth, and a deliberate behavior change, not just a bug fix: no more fake completions for real
releases.** Once the redirect/fetch issues above were all fixed, a screenshot surfaced a separate,
more serious problem: while `submitRealGrab()` was failing (for any of the reasons above, at various
points across this investigation), the row was falling back to Kitsune's original plain simulated
ticker — the same one queue-sim.js's fully-fabricated candidates always used. That ticker doesn't
know or care that a row was ever meant to be real; a minute or two later it marks the episode
"downloaded" with a completely made-up file path and fabricated Media Info (resolution, codec, audio
tracks, file size — all invented). The screenshot showed exactly that: a "Available" episode with
a plausible-looking but entirely fictional 1920x1080/AVC/540MB Media Info panel, for a file that a
manual rescan then correctly reported as not actually present on disk.

This is now treated as a real bug, not an acceptable fallback: `submitRealGrab()` returns a new
`attemptedReal` flag (true whenever the release genuinely came from a real indexer search, regardless
of whether the submission itself succeeded), and both grab handlers now force the queue row's starting
`status` to `'warning'` whenever `attemptedReal` is true but the submission failed — not just the
random ~10% chance a fully-fabricated release still gets (that random "warning" start was only ever
cosmetic demo flavor for a release that was never real to begin with, and stays unchanged for that
case). A `'warning'` row is excluded from `tick()`'s own query entirely, so it can never silently
"complete" — it just sits visibly stuck in Activity > Queue, with the real failure reason recorded on
its grab history entry, until removed and retried. Lying about a completed download is worse than
surfacing a stuck one.

**Progress:** two separate interval loops now exist. `tick()` (every 1.5s, unchanged) only ever
touches `source = 'simulated'` rows — same random-progress-then-resolve behavior as always.
`realTick()` (every 4s, new) polls each real row's actual qBittorrent client for its real
`progress`/`state`, grouped by client so one client with several grabs in flight costs one
`GET /torrents/info` call, not one per row. A row's `status` (`downloading` vs. `paused`) is
derived straight from qBittorrent's own real state every tick rather than tracked separately in
Kitsune — pausing a torrent directly in qBittorrent's own UI shows up in Kitsune's queue too, not
just the reverse. Completion is `progress >= 1` (not a specific state string, since qBittorrent's
post-download state varies — uploading/pausedUP/stalledUP/etc. depending on seeding settings);
`error`/`missingFiles` states resolve to the same failed+blocklisted outcome the simulated
ticker's rare failure path already produces, with a real reason instead of a generic one. A
client that's unreachable for one poll just leaves its rows exactly as they were — the next tick
tries again, same "a transient failure isn't fatal" approach this app already takes with every
other external call.

**Real per-file progress, not one shared percentage.** A real, reported case (a screenshot of a
batch grab's series page next to the actual qBittorrent client downloading it): every episode row
in a 12-episode batch showed the exact same "6%" no matter which file it actually was, while
qBittorrent's own UI showed each file progressing at its own real, different rate (files don't
necessarily download in strict order). Root cause: every row's `progress_pct` came straight from
`torrents/info`'s single torrent-level `progress` field — accurate for a single-episode grab (one
file, so the torrent's progress *is* that file's progress), but meaningless per-episode once
several rows share one multi-file batch torrent. `rowProgressPct()` now looks up each row's own
file via `pickFileForEpisode` (the exact same match `completeRealDownload` already trusts to decide
which file gets imported as which episode — reused, not duplicated) and reads that file's own real
`progress` field from `GET /torrents/files` (already fetched for completion matching, and still
deduped to one call per hash per tick via `filesForHash` — now just also called while a torrent is
still downloading, not only once it completes). Falls back to the torrent's own overall progress —
the previous, only behavior — whenever a specific file can't be confidently matched: a
single-video-file torrent (where `pickFileForEpisode` already just returns that one file directly,
so the number doesn't change) or a batch match ambiguous enough that `pickFileForEpisode` itself
returns `null`. Never shows a wrong episode's progress, only the same honest "can't tell which
file" fallback completion already uses in that case. No frontend changes needed — `SeriesPage.jsx`'s
episode rows already render whatever `progressPct` `GET /api/queue` reports per row; this only
changes what that number actually reflects.

Verified with a mocked qBittorrent client (not the live site): a 3-episode batch torrent reporting
6% overall but three different real per-file progress values (8.5%, 2.6%, 10.4%) — after one real
`realTick()` interval firing, each episode's own queue row landed on its own file's rounded
percentage (9%, 3%, 10%), not the shared 6% every row would have shown before. A single-file
torrent's progress was confirmed unchanged (42% either way). An intentionally ambiguous multi-file
match (two files, neither confidently resolving to the requested episode) was confirmed to fall
back to the torrent's own overall progress (77%) rather than guessing.

**Pause/resume/remove:** for a real row, these now call `qbittorrent.pauseTorrents`/
`resumeTorrents`/`deleteTorrents` (see [Download Clients](Download-Clients)) against the real
torrent, optimistically updating the DB alongside so the UI reflects the click immediately rather
than waiting up to 4s for the next poll to confirm it. Remove never sends `deleteFiles: true` —
same non-destructive-by-default convention as the Download Clients Torrents modal's own Remove
button.

## Real Import — from download client to Library

Sonarr and Radarr split "grab a release" and "the file is now really in your Library" into two
separate jobs, and it's worth being precise about who does which, because it's exactly the seam
this closes. The download client's only job is fetching bytes to its own disk — it has no idea
what a Library folder structure or naming convention even is. **Completed Download Handling** is
the *arr app's own job: poll the download client for what's finished, ask it where that finished
torrent's files actually live, and import — hardlink or copy — from there into the real Library
location itself. Kitsune's `realTick()` already did the first half (polling qBittorrent for real
progress); this closes the second half.

**The remote-machine problem, and Remote Path Mapping.** A download client's API only ever reports
a path meaningful on *its own* filesystem. If qBittorrent and Kitsune run on the same machine (or
share a mount — a common Docker setup), that path is directly usable as-is. If they don't — a
seedbox, a separate container with different mountpoints, a NAS running qBittorrent while Kitsune
runs elsewhere — that path means nothing to Kitsune's own host; the folder simply doesn't exist
from where Kitsune is standing. Remote Path Mapping (two new fields on a qBittorrent client in
Settings > Download Clients — **Remote path** / **Local path**) is the same fix Sonarr/Radarr use:
a plain string-prefix translation the user supplies by hand, since neither side can infer the
other's layout. No mapping configured is read the same way both real apps default it — "assume the
same filesystem," which is exactly correct for the common same-host/same-mount case and requires
zero configuration.

**`server/lib/remote-path.js`** does the translation — `resolveLocalPath(client, remotePath)`,
a straight string-prefix swap, deliberately *not* run through Node's `path` module. The remote side
may not even share Kitsune's own OS path-separator convention (a Windows qBittorrent instance
reporting `C:\Downloads\...` while Kitsune itself runs on Linux, say) — real Sonarr/Radarr don't
attempt automatic separator translation either, and neither does this. `joinRemotePath` (combining
a torrent's `save_path` with a file's relative name from the files listing below) makes the same
choice, picking whichever separator the remote string itself already uses instead of assuming.

**Which real file is which episode.** `GET /api/v2/torrents/files?hash=` (new in
`qbittorrent.js`'s `getTorrentFiles`) is the real per-file listing inside one torrent — needed
because a single torrent can now cover many episodes (see Batch grabs below), and each queue row
needs to land on the *right* file, not just any of them. A single-video-file torrent (the ordinary
shape for a single-episode grab) needs no guessing at all — there's nothing else it could be. A
multi-file batch torrent is matched by parsing each candidate filename for a season/episode number
the exact same way Library Import already does (`guessSeasonEpisode` — see
[Root Folders and Library Import](Root-Folders-and-Library-Import) and
`server/lib/media-files.js`), reusing that existing,
already-proven parser rather than writing a second one. A file list that doesn't reduce to exactly
one confident match — nothing found, or two files that both look like the same episode — resolves
to `null` rather than guessing wrong, so that one row falls back to the old fabricated path instead
of importing the wrong file into the wrong episode's slot; every other row in the same batch still
imports normally.

**Real, confirmed bug: an "Extras" clip stole an episode's own slot, and the fallback size was
wrong too.** A user's own screenshots caught it directly — a series' Media Info for S01E12 showed a
plausible-looking real file path and a 4.68 GB size, but the actual Library folder on disk (`ls
-lah`) only had files through S01E11; that "file" never existed. Root cause: the batch's own
"Extras" folder held a creditless-ending clip literally named `... EP12 NCED.mkv` alongside the real
`... S01E12.mkv` episode file. Both parse as "episode 12" (`guessSeasonEpisode`'s bare `EP12`
fallback pattern has no way to know this filename's "12" refers to which *episode* the clip is
attached to, not that the clip itself is that episode), and since the NCED clip's own guess came
back with no season attached at all, `pickFileForEpisode`'s season-leniency check let it through as
a second candidate — two matches where there should only ever have been one, so the real episode
file lost to an unresolvable "tie" against a 68 KB extras clip, and episode 12 fell back to a
fabricated path exactly like a genuinely-unmatchable file would.

Fixed by breaking a tie in favor of whichever candidate's own filename stated its season explicitly
(`S01E12`-shaped — `guessSeasonEpisode`'s `confident`-producing regex) over one that only matched
via the bare-number fallback with no season attached — a real episode file is far more likely to
name its season explicitly than a same-numbered extras clip is. This only resolves the tie when
exactly one candidate carries that stronger signal; a genuine tie between two equally explicit
season+episode names (a duplicate/`v2` re-release sitting in the same batch, say) still returns
`null` rather than guessing between them.

**The size bug this exposed, separately.** `completeRealDownload`'s starting `sizeBytes` used to
default to `torrent.total_size || row.size_bytes` — both of which are the size of the *entire*
torrent/release, never one specific episode's real share of it (`row.size_bytes` is copied from the
same batch-level release object onto every episode's own queue row at grab time — see
`insertBatchGrab` in the Batch grabs section below — so it's exactly as wrong as `total_size` for
this purpose, not a real fallback). Harmless for a genuinely single-file torrent (the one file's
size and the torrent's total size are the same number), but for any batch episode that couldn't be
matched/imported — this NCED collision, or any other real unresolvable case — the *entire batch's*
size got recorded against that one episode, both in its own Media Info and in the series' Size stat
card (which sums every episode's `sizeBytes`). Fixed to only trust `total_size` as an episode's size
when the torrent's real file listing confirms there's genuinely just one video file in it;
otherwise `sizeBytes` stays `null` until/unless a real per-episode import sets the real number —
same "unknown beats confidently wrong" rule every other best-effort guess in this app already
follows.

Verified end-to-end against real temporary files (not mocked file objects) reproducing the exact
reported batch shape — 12 real Season 1 episode files, a real OVA file, and 3 real "Extras" files
including the actual `EP12 NCED.mkv` collision — run through the real `completeRealDownload` path
via `realTick()`: all 12 episodes, including 12, now match and import their own real file with their
own real size, none inheriting the batch total. Separately verified a genuine, unresolvable tie
(two files both explicitly claiming season 1 episode 5) still correctly falls back to a placeholder
path — but now with `sizeBytes: null` rather than the old bug's whole-batch-total number. The user's
own real, already-affected `Astarotte's Toy` S01E12 row (found via direct query to match their
screenshots — `size_bytes: 5028369311`, ≈4.68 GB, `downloaded: 1`, pointing at a file confirmed not
to exist by their own terminal output) was reset back to not-downloaded (`downloaded = 0`, quality/
size/path/mediaStreams cleared, series stats recomputed: `13/13, 100%` → `12/13, 92%`) so it reads
honestly as missing again rather than falsely "Available" — re-grabbing it (a single-episode grab
this time, which never hits this multi-file matching code at all) will import it for real under the
fixed logic.

**`server/lib/media-import.js`** does the actual write: `fs.statSync` the resolved real source
path (proves it's genuinely reachable before anything else happens), `fs.linkSync` a real hardlink
into `episode-paths.js`'s `buildEpisodeFilePath` destination — same file, two directory entries,
zero extra disk space, and the torrent keeps seeding from its original location afterward — falling
back to a real `fs.copyFileSync` on `EXDEV` (source and destination on different filesystems/
mounts) or any other hardlink failure. This mirrors Sonarr/Radarr's own default Import Mode
exactly. Unlike those apps, Kitsune doesn't expose a plain Move option — Move would break seeding a
torrent its own Torrents modal still shows as active, and hardlink-preferred-with-copy-fallback is
strictly safer while still costing nothing extra in the common case.

**Every failure mode degrades, never breaks.** No real filesystem access at all, a genuinely
unreachable source (Remote Path Mapping missing or wrong), an ambiguous batch match, permission
denied, disk full — every one of these comes back as a specific, logged reason and the episode
still resolves to a completed, imported download using the same fabricated placeholder path this
app always used before real import existed. A setup that isn't ready for real import yet (no
mapping configured across two separate machines, say) behaves *exactly* as it always did rather
than failing a download that genuinely finished.

### Real audio/subtitle tracks — `server/lib/ffprobe.js`

The episode row's Audio column, and the Media Info modal's Audio/Subtitles rows, used to be a flat
guess: every downloaded episode showed "Dual" audio regardless of what the actual file had — fine
when "downloaded" only ever meant a simulated grab with no real file behind it, actively wrong once
real imports started marking episodes downloaded from actual files (this section, plus
[Root Folders and Library Import](Root-Folders-and-Library-Import)'s auto-scan/manual-import/Rescan
paths). A real, confirmed case: a genuinely mono-audio-track file (ffprobe's own output pasted
directly into the report) showing a confident "Dual Audio" badge with nothing distinguishing it from
a real fact.

`server/lib/ffprobe.js` is the one place in this app that shells out to an external binary —
`ffprobe`, part of ffmpeg — instead of doing everything in pure Node/`node:sqlite`. `probeMediaStreams(filePath)`
runs `ffprobe -show_streams` once per file (covers both audio and subtitle streams in the same call,
split by `codec_type` afterward) and returns real `{ audio: [{language, codec, channels}], subtitles:
[{language, codec, forced}] }` — language names mapped from ffprobe's raw 3-letter codes, channel
layout preferring ffprobe's own label (`stereo`, `5.1`, etc.) over a bare channel count. Availability
is checked once per process (`ffprobe -version`, cached) rather than before every single file — a
personal library rescan covering a whole season shouldn't re-spawn a process just to ask the same
yes/no question 12 times. Missing ffprobe, an unreadable file, or a parse failure all return `null`
rather than throwing — logged once clearly (not per file) so "ffprobe isn't installed" is
diagnosable from System > Logs instead of every episode just silently showing "Unknown."

**Called from exactly the three places that have a real file to point it at** — never the simulated
pipeline, since there's nothing real there to probe: `scanExistingFilesForSeries` (the auto-scan on
add, `routes/episodes.js`), `handleImportFilesApi` (manual Library Import and the series page's
Rescan for local files button, `routes/import-files.js`), and `completeRealDownload` (a real grab's
completion, `routes/queue.js` — probed right after `importEpisodeFile` confirms the hardlink/copy
actually landed, not before). Each stores the result as JSON in a new `episodes.media_streams`
column, alongside the same `downloaded`/`quality`/`size_bytes`/`path` update that call site was
already doing — one write, not a second round-trip.

**Frontend (`SeriesPage.jsx`):** `summarizeAudioTracks` collapses a real per-track array to the same
short "Dual"/"Sub" row badge the old fabricated version used — 2+ real tracks is "Dual", exactly 1 is
"Sub", 0 is "None" — genuinely honest now instead of a hardcoded guess. `mediaStreams` being `null`
(nothing's ever probed this episode — simulated, pre-ffprobe real import, or ffprobe not installed on
this machine) shows as "—", a different and equally honest state from "None" (probed, found nothing).
The Media Info modal prefers real per-track detail (`"AAC Stereo (Japanese)"`, straight from
ffprobe) when `mediaStreams` exists, and only falls back to the old deterministic
codec/channel-layout guess when it doesn't — video codec/resolution/bitrate are still guessed from
the quality tier either way, since this app has never stored a real per-episode video codec, only a
quality tier name.

Verified against real ffprobe (present and used directly, not mocked) with two synthesized real
`.mkv` files — one single Japanese-only audio track, one with a second English track — confirming
`probeMediaStreams` correctly reads real language tags, codec, and channel layout off the actual
files, and that a real `POST /api/series/:id/import-files` call correctly distinguishes "Sub" from
"Dual" per file based on what each one actually contains.

## Batch grabs — searching and grabbing a whole season or series

A lot of finished anime is distributed exactly once, as a single "batch" torrent covering an
entire season (or the whole series) rather than one release per episode — the per-episode-only
Search button couldn't reach that at all. Search Season (the icon next to the season-rename pencil
on the series detail page) and Search All (the series header button) cover this: same release
picker, same Grab button, but the result is one torrent shared across every still-missing episode
in that scope, not a single queue row.

**Detecting a batch release** (`nyaa-search.js`'s `isBatchRelease`) isn't a Nyaa category or field
— it's the release title itself, matched against the same shapes real fansub/scene batch releases
actually use: an episode-range tag (`01-24`, `01~12`), the words "Batch" or "Complete", a season
*range* (`Season 1-2`, `S1~2`, `season 01 & 02`), or a bare season tag (`S01`) with no accompanying
episode number. `searchBatchReleases` runs the normal title-search-with-alt-titles-fallback
(identical to the per-episode path) and filters to just the releases that match. `queue-sim.js`'s
`generateBatchReleases` is the deterministic simulated fallback, same role `generateReleases` plays
for a single episode, sized as an episode's own `preferredMBPerMin` estimate × the target episode
count.

**Real bug, caught from a real "Search All" run and a screenshot of the actual Nyaa.si results
page:** a batch search for "Bludgeoning Angel Dokuro-chan" only flagged 1 of 5 real results as a
batch, even though 3 of the 5 clearly were — `[Koten_Gars] ... {Season 1-2} ...` and `... season 01
& 02 ...` both slipped through every rule. Root cause was two separate gaps in `isBatchRelease`:
the season-tag rule only recognized the abbreviated `S01` form, never the spelled-out word
"Season"; and the episode-range rule only matched hyphen/tilde-joined 2-4-digit numbers (built for
zero-padded episode ranges like `01-24`), never an ampersand-joined or single-digit season range
like `1-2` or `01 & 02`. Fixed by adding a dedicated season-range rule — it doesn't need the
`E##`/`S##E##` exclusion guard the bare-season-tag rule needs, since a single-episode release never
spans a range of seasons in the first place. Verified against all 5 real titles from that same
screenshot plus the existing per-episode/range test titles this heuristic already had to keep
correctly classifying (`Frieren - 12`, `... S04E05`, `Tsugumomo - 01~12`, and a "Season 4 Part 2"
title that's a real single-cour release, not a batch, and must stay `false`) — all pass.

**Second real bug, found investigating the same report:** System > Logs' own request-URL line for
that same search showed Prowlarr was queried for `Bludgeoning+Angel+Dokuro` — silently missing
"-chan". `simplifyTitleForSearch` (used to strip a subtitle for a cleaner query — "Frieren: Beyond
Journey's End" searches much better as just "Frieren") used to split a title on *any* hyphen
(`/[:—-]/`), not just one standing in for a subtitle separator, so "Dokuro-chan" — a hyphen that's
part of a compound name, no surrounding whitespace — got cut in half exactly like a real
title/subtitle boundary would. Fixed to only split on a colon, or a dash with whitespace on both
sides (`"Kaguya-sama - Love is War"` still splits into `Kaguya-sama`/`Love is War`; `"Dokuro-chan"`
no longer splits at all). Verified against both the real "Dokuro-chan" case and the existing
colon-subtitle case this cleanup exists for in the first place.

**`GET /api/releases?scope=season&seriesId=N&seasonNumber=N`** (or `?scope=series&seriesId=N` for
the whole show) returns batch candidates plus `episodeCount` and `targetLabel` — the count and
season/series label the response actually targets, computed server-side by
`targetEpisodesForScope()` (aired, not-yet-downloaded episodes only; a batch release's own title
claiming a specific range isn't trusted for this, same "don't trust free text" reasoning the
per-episode quality classifier already applies).

**`POST /api/queue`** takes a second body shape for this — `{ seriesId, seasonNumber?,
releaseIndex }` instead of `{ episodeId, releaseIndex }` (seasonNumber omitted = whole series) —
detected by `seriesId` being present without `episodeId`, routed to `handleBatchGrab()`. Per the
user's own call on how this should model: **one real magnet, N queue rows** — a single
`qbittorrent.addTorrent()` call for the whole batch (never one per episode; it's genuinely one
torrent), then one `queue` row per still-missing target episode, all sharing that same
`torrent_hash`/`download_client_id`/`magnet_url`. Episodes already downloaded or already queued are
silently skipped rather than erroring the whole batch over a partial overlap; a 400 ("Nothing to
grab") only fires if that leaves nothing left to queue. One `History` "grabbed" row is still
written per episode (so History/Calendar keep reading exactly like they always did), but only one
`notifyConnections` call fires for the whole batch. Falls back to simulated for every row together,
same graceful-degradation rule the single-episode path already follows.

This is also why `realTick()` — the poller that already grouped real rows by client and asked
qBittorrent once per client per tick — needed **no changes at all** for batch support: it was
already keyed by `torrent_hash`, so N rows sharing one hash simply all update, complete, or fail
together as qBittorrent reports progress on that one torrent. The one place that did need a fix:
**`DELETE /api/queue/:id`** now checks whether any sibling row still references the same
`torrent_hash`/`download_client_id` before calling `qbittorrent.deleteTorrents` — removing one
episode from a 12-episode batch grab now only ever removes that one `queue` row, never the shared
torrent still needed by the other 11.

`public/js/lib/release-picker-modal.js`'s `open()` takes a `target` object instead of a bare
episode now — `{ type: 'episode', id, label, title }` (the default when `type` is omitted, so
every pre-existing caller needed zero changes), `{ type: 'season', seriesId, seasonNumber,
seriesTitle }`, or `{ type: 'series', seriesId, seriesTitle }` — picking the right fetch URL and
grab body for each, and refining the modal's title with the server's own `targetLabel`/
`episodeCount` once a season/series search returns. Both Search buttons are gated off in
`SeriesPage.jsx` for Frieren's hand-built demo data and until real episode data has actually
loaded (`!isFrieren && !!realGroups`/`!!activeGroup`) — there's no real series/episode id behind
either to search against otherwise.

## Clicking a release opens its real page (`infoUrl`)

Sonarr/Radarr's own manual search results let you click through to a release's real page — its
comments, description, screenshots, upload notes — before committing to a grab. Kitsune's release
picker didn't have anywhere to send that click to: neither `nyaa-search.js` nor
`prowlarr-search.js` captured a detail-page link at all, only a magnet.

**Nyaa.si:** the RSS request's `m=1` flag (see `searchNyaa`'s params) repurposes `<link>` into a
ready-made magnet URI instead of nyaa.si's normal torrent view page — but the RSS `<guid>` element
is nyaa.si's own stable permalink to that page (`https://nyaa.si/view/12345`) regardless of `m`,
since `m` only ever documented itself as changing what `<link>` points to, not `<guid>`. `searchNyaa`
now reads `<guid>` into a new `infoUrl` field alongside the existing `magnetUrl`/`infoHash`.

**Prowlarr:** its `ReleaseResource` schema (`wiki.servarr.com/prowlarr/search` — the same doc this
integration's other fields were already confirmed against) includes `infoUrl`: a link to the
release's detail page on whichever underlying tracker actually indexed it — a Nyaa.si torrent page
when Prowlarr is proxying Nyaa.si, or that tracker's own equivalent otherwise. `searchProwlarr` now
reads it straight off the JSON response.

**Guarded, not trusted blindly:** a new `isHttpUrl()` helper (`nyaa-search.js`, exported and reused
by `prowlarr-search.js`) only accepts a value whose parsed `URL().protocol` is `http:`/`https:` —
verified directly to reject a `javascript:` URL fed through a mocked Prowlarr response (a `infoUrl`
this app doesn't fully control the shape of, unlike Nyaa.si's own RSS which it parses itself) as
well as a missing/malformed value, both correctly degrading to `infoUrl: null` rather than ever
becoming a clickable `javascript:`-or-worse href. `rankReleaseCandidates` and `routes/releases.js`'s
dedup/merge both already spread every field of a release object through unchanged, so `infoUrl`
needed no changes anywhere else in the pipeline to survive ranking, deduping, and the multi-indexer
merge intact — verified directly rather than assumed.

**`release-picker-modal.js`**'s new `titleCell(r)` renders a release's title as a real `<a
target="_blank" rel="noopener noreferrer">` (opening in a new tab, same as Sonarr/Radarr) when
`infoUrl` is set, or the same plain `<span>` as before when it isn't — a simulated release, or a
real one whose source didn't supply a link, stays unclickable rather than pointing nowhere or
somewhere wrong. Both the `href` and `title` attributes go through the existing `escapeAttr()`
helper (`icons.js`, already used by the File Browser and Media Info modals for the same reason) so
a title or URL containing a literal `"` can't break the surrounding markup. A small CSS rule
(`a.release-title` — accent-colored, underline on hover) is the only visual cue distinguishing a
clickable title from a plain one; everything else about the row (grab button, quality flag,
out-of-profile dimming) is unaffected, and the anchor has no click handler of its own to conflict
with the row's existing `[data-grab]` button listener.

Verified end-to-end against two mocked responses shaped exactly like the real thing: a mock Nyaa.si
RSS feed with one item carrying a real `<guid>` and one without, confirming `infoUrl` comes back
correctly set/`null` respectively; and a mock Prowlarr JSON response with one legitimate `infoUrl`
and one `javascript:` one, confirming the legitimate link survives while the malicious one is
rejected. `titleCell`'s own output was checked directly (this project has no DOM-testing library
installed, consistent with the backend's zero-dependency stance) — confirmed the anchor path
carries `target="_blank"`/`rel="noopener noreferrer"` and both known-shape cases (a title containing
a literal `"`, a URL containing `&`) render with correctly escaped attributes.

## Verification

Real, live end-to-end verification against actual nyaa.si wasn't possible from the sandbox this
was built in — outbound network access there is allowlisted to a small set of domains and nyaa.si
isn't one of them (confirmed: direct `curl`/`fetch` to nyaa.si and several other arbitrary
domains all failed to connect, while the research tooling's own web-fetch capability, running on
different infrastructure, could reach nyaa.si fine — a sandbox-specific limitation, not a
statement about nyaa.si's own availability). Every fact this integration relies on (RSS query
params, the `nyaa:` field names, magnet construction, category codes) was verified directly
against nyaa.si's own published docs and its open-source repository rather than assumed, but the
integration itself was proven against a faithful mock rather than the live site — **a real search
on an actual running instance is worth spot-checking once** to confirm nothing about the live
site's behavior has drifted from its own documented/open-source shape.

What was verified end-to-end against a real running server plus two throwaway mocks (a mock
Nyaa.si RSS server matching the researched schema exactly, and a mock qBittorrent extended from
the one built for the Download Clients pass to advance real progress on each poll): a real search
returning correctly episode-filtered, correctly quality-classified, correctly sorted results;
grabbing one submitting the real magnet to the real mock client and appearing in its torrent list
under the right category; real progress advancing across multiple `realTick` polls to completion,
the queue row disappearing, a real `imported` History row landing with the torrent's actual
`total_size` (not the search-time estimate), and the episode flipping to downloaded; pause
producing a real `pausedDL` state on the mock client that the next poll correctly reflected back
into the queue row's own status; resume and remove (confirmed the torrent actually left the mock
client's list) both working the same way; and all three fallback paths — Nyaa.si disabled, Nyaa.si
enabled but genuinely unreachable, and Nyaa.si working but no reachable qBittorrent client to
submit to — each correctly degrading to simulated results/tracking with an accurate, specific
reason surfaced rather than a generic failure. `npm run build` (the same sandbox `emptyOutDir`
workaround used throughout this project) also confirmed the release picker's new "(simulated)"
tag and notice banner compiled in cleanly.

**Batch grabs** were verified the same way, against a disposable copy of the real seeded database
(so the assertions are against real series/episode rows, not hand-built fixtures) with
`searchBatchReleases` and the qBittorrent client module patched to deterministic mocks: a season
scope search correctly returning `episodeCount` matching the real count of missing, aired episodes
in that season plus real-shaped batch candidates; grabbing one issuing exactly **one**
`addTorrent` call and producing one `queue` row per missing episode (12, in the test season) all
sharing a single `torrent_hash`; a second grab attempt against the same, now-fully-queued season
correctly 400ing; deleting queue rows one at a time confirmed `deleteTorrents` is *not* called
while sibling rows remain and *is* called exactly once, on the final row, with the correct shared
hash; the Nyaa-disabled simulated fallback producing the same shared-torrent-free row shape;
whole-series scope (`?scope=series`, no `seasonNumber`) correctly summing missing episodes across
all three seasons of a multi-season test series; and, running the real `realTick()` interval
un-mocked for several ticks after flipping the mock torrent to 100% complete, confirming all 12
sibling rows completed together — queue emptied, all 12 episodes marked downloaded, all 12
`imported` History rows written — proving the existing hash-keyed poller needed zero changes to
support batches, as designed.

**Real import** was verified against real temporary directories standing in for a download folder
and a Library root (real files, real bytes, on the real sandbox filesystem — not stubbed), with
qBittorrent's file-listing API mocked to point at them: a single-episode grab produced a real
hardlink into the Library path (confirmed via matching inode numbers, not just "a file exists") with
the correct real file size; a 12-episode batch torrent correctly matched all 12 real files to their
own episodes by filename (none crossed into a sibling's slot) and hardlinked every one; Remote Path
Mapping correctly translated a `save_path` that only existed on a simulated "remote" prefix into
the real local file underneath it, succeeding where an unmapped attempt at that same path could
not have; and a torrent reporting a genuinely unreachable path with no mapping configured correctly
fell back to the pre-existing fabricated placeholder path, logging a specific reason, still marking
the episode downloaded, and never hanging or crashing the poller.

## Quality-profile-aware ranking and "Grab best match"

Every prior section above answers "does a real search happen and does grabbing work" — this
closes a gap in *what gets grabbed*. Search results were always sorted (tier rank, then seeders),
but that sort had no idea a series' own Quality Profile existed at all — a profile's "Qualities"
field on Settings > Profiles was a static, non-functional display string (`"3 of 12"`) computed at
save time and never read back by anything. A user's actual question that started this: shouldn't
the profile linked to a series — which links to a set of quality tiers, each with its own target
file size — be the thing search results get judged against?

**The decision, and why it isn't a filter.** The obvious version of this hides any release outside
the profile entirely. Deliberately not built that way — a profile is a preference, not a hard
constraint this app can verify with certainty (a release's `quality` is still a best-effort
classification of free text, same caveat every quality-classification section above already
carries), and a user manually searching should still be able to see and grab an out-of-profile
release on purpose (a rare group's raw release, a foreign-language dub, whatever isn't in the
profile's list but is still exactly what they want this one time). So: every release still shows,
always — profile-awareness only changes ordering and adds a visual flag, never a filter.

**`allowedQualities` — making the profile real.** Settings > Profiles' edit modal
(`ProfilesPage.jsx`) now has a real checklist of every quality tier from Settings > Quality, saved
as `allowedQualities: string[]` on the profile row (`settings_items`, `section: 'profiles'` —
the existing generic `PATCH /api/settings-items/:section/:id` JSON-merge route needed no changes
at all to support this; it already merges arbitrary fields into the stored blob). The old
`qualities` display string is gone from both the seed data and the row — `allowedFor(item)` in
the page component computes the "N of M" label live from the real array instead. A profile with no
`allowedQualities` yet (every one of this installation's own pre-existing profile rows, seeded
before this field existed — confirmed directly against the real production `settings_items`
table: 8 real rows, `Any`/`SD`/`HD-720p/1080p`/`HD-1080p`/`Ultra-HD`/`Anime - Dual Audio`/`Blank
profile`/a user-added `Sean`, none carrying the new field) is read as "every known tier is
allowed" by `getQualityProfile()` — the same default a profile with no restriction at all would
produce, so nothing that already worked stops working the moment this shipped; every existing
series' search results are unaffected until someone actually opens a profile and unchecks
something.

**`server/lib/quality.js` — the one place ranking logic lives.** Two new pieces:

- `preferredSizeBytes(tierName, runtimeMinutes)` converts a tier's existing `preferredMBPerMin`
  field (already user-editable on Settings > Quality, previously unused by search at all) into an
  absolute byte target for a given episode's runtime. No real per-episode runtime is tracked
  anywhere in this app, so a `FALLBACK_RUNTIME_MINUTES = 24` (a typical anime episode) stands in —
  deliberately *not* wired to Settings > Quality's separate "reference runtime" display
  preference (`quality-ui-prefs`), since that field only ever controls how numbers are formatted
  on screen; coupling it to real ranking would make search results silently shift any time someone
  changed a display setting, a surprising and fragile connection to build.
- `rankReleaseCandidates(releases, { profile, runtimeMinutes })` is the new single sort every
  search path shares — previously `nyaa-search.js`, `prowlarr-search.js`, and `releases.js`'s own
  merge step each ran their own near-identical "tier rank, then seeders" sort independently; now
  all three call this one function. Order: releases inside the profile's `allowedQualities` sort
  before every release outside it (`inProfile: true`/`false`, a new field added to each release
  object, never removed from it); within that, higher quality tier first; within a tied tier,
  closest absolute file size to that tier's own `preferredSizeBytes` target; then seeders as the
  final tiebreak. An out-of-profile release with 1000 seeders still sorts below an in-profile one
  with none — "flag and sort by fit," not "sort by popularity within a soft preference."

  Verified directly against the real live database's actual tier data (not assumed defaults) after
  an initial test caught a fixture mistake: a first pass assumed a typical `preferredMBPerMin` for
  WEBDL-1080p (160) that didn't match this installation's own customized real value (22),
  producing a result that looked wrong until recomputed against what the real `getQualityTiers()`
  actually returns. Once corrected, confirmed: higher tier always outranks lower regardless of
  size or seeders; within a tier, exact size-match beats a far-off size in the same tier; a
  release with no size data still outranks any out-of-profile release regardless of that release's
  seeder count; out-of-profile always sorts last as a group.

**Search paths now thread a profile through.** `searchReleasesForEpisode`/`searchBatchReleases` in
both `nyaa-search.js` and `prowlarr-search.js`, and `releases.js`'s `sortAndLimitReleases`/
`simulatedReleases`/`simulatedBatchReleases`, all now accept the series' resolved profile
(`getQualityProfile(series.quality_profile)` — the existing plain-string column already linking a
series to a profile by name, unchanged) and pass it straight into `rankReleaseCandidates`. A
series with no profile set, or one that resolves to nothing, ranks exactly as before this feature
existed — pure tier-then-seeders, no `inProfile` distinction to make.

**The release picker shows the flag, never hides anything.** `release-picker-modal.js`'s row
template adds an `out-of-profile` class (`opacity: 0.55`, `0.85` on hover — visually
deprioritized, not removed) and a small "Outside profile" badge (`.quality-flag`, warning-colored)
whenever `inProfile === false`, per the user's own explicit call: **show everything, just flag and
sort by fit.**

**"Grab best match" — the one-click path.** Per the user's second call, a new action sits next to
the existing magnifying-glass Search button on every missing episode row, the series header, and
each season tab (a new lightning-bolt icon, `icons.zap` in `icons.jsx`) — search internally using
the exact same profile-aware ranking as the manual picker, then grab the #1-ranked result directly,
no picker shown. `POST /api/queue` gained a third body shape for this, `{ episodeId, auto: true }`
or `{ seriesId, seasonNumber?, auto: true }`, handled by two new functions in `queue.js`:

- `handleAutoEpisodeGrab` — 404s on a missing episode/series, 409s if already queued, then checks
  the profile's cutoff (see below) before searching via a newly-exported `searchForEpisode` (the
  exact logic `GET /api/releases` already ran for the manual picker, extracted so both call sites
  share one implementation rather than diverging) and grabbing `releases[0]` through the same
  `insertSingleGrab` the manual single-release grab path already used.
- `handleAutoBatchGrab` — the season/series equivalent, reusing `targetEpisodesForScope` (already
  filters to undownloaded, aired episodes only) and `searchForBatchScope`/`insertBatchGrab`, same
  extraction pattern.

Neither path is an error state when there's nothing to do — both respond `200 { skipped: true,
reason }` (not a 4xx/5xx) for "no releases found" or "already meets cutoff," since skipping is a
legitimate, expected outcome of an automatic action, not a failure the user needs to react to.
`SeriesPage.jsx` surfaces that `reason` as an inline message either way.

**Respecting cutoff — the third call.** An episode already at or above its profile's cutoff
quality shouldn't be treated as needing an upgrade just because "Grab best match" was clicked —
this mirrors the Cutoff Unmet page's own existing definition of "met" exactly
(`isBelowCutoff(episode.quality, profile.cutoff)`, an existing function, not new). The single-
episode check: `episode.downloaded && profile && profile.cutoff &&
!isBelowCutoff(episode.quality, profile.cutoff)` skips with a reason naming the profile and cutoff
tier. Batch scope needs no separate check at all — `targetEpisodesForScope()` already excludes
downloaded episodes from its result, so a cutoff-satisfied episode is never a batch grab candidate
in the first place; the single-episode path is the only one where an already-downloaded episode
is ever a valid input.

**Verified against the real production database**, not a test DB, via hand-rolled `fakeReq`/
`makeRes` mocks calling the real exported `handleQueueApi` directly (matching the real
`sendJson`'s actual `res.writeHead`/`res.end` contract), with full row cleanup after each run:
a successful auto-episode-grab (gracefully falling back to simulated when the real Prowlarr
instance was unreachable, exactly the same degradation every earlier real-search section
documents); a 409 against an already-queued episode; a cutoff-skip against a throwaway fixture
episode/profile pair confirmed to satisfy `isBelowCutoff`; and a successful auto-batch-grab
against a real season, producing one shared torrent and one queue row per missing episode exactly
like a manual batch grab does. `npm run build` (the sandbox's `emptyOutDir` workaround, reverted
back to `true` immediately after) compiled `ProfilesPage.jsx`, `SeriesPage.jsx`, and the new
`icons.jsx` entry cleanly — 95 modules, no errors.

---

[← Back to Home](Home)
