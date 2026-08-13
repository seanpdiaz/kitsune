# Download Clients (qBittorrent / NZBGet)

## Download Clients: real qBittorrent/NZBGet connections

Every other part of the app that could plausibly reach a real external service (TheTVDB,
MyAnimeList, the real filesystem) does — with one deliberate exception explained in
[Grab / Download Pipeline](Grab-Download-Pipeline): the whole search → grab → download → import loop is simulated
end-to-end, entirely inside `server.js`, because a real indexer/download client means
actually reaching a real torrent/usenet tracker, which is out of scope for this project.

Settings > Download Clients carves out one narrower exception to that: it now makes real
network calls to a real qBittorrent or NZBGet instance for connection testing, rather than
simulating a Test button like Indexers/Import Lists/Connect still do. It does *not* change
how a grab actually gets downloaded — `queue-sim.js`'s simulated pipeline is untouched, and
grabbed releases still aren't pushed to a real client. This is specifically about proving
Kitsune can reach a real download client's API, the first real step toward that pipeline
eventually submitting to one for real.

**Update:** for qBittorrent specifically, "reach the API" has since grown into "actually use
the API" — see "Real torrent management" below. You can add a real magnet/torrent URL, see
qBittorrent's real live torrent list, and pause/resume/delete from inside Kitsune. Still not
wired to the simulated grab pipeline, for the same reason as above.

**Second update:** that last sentence is now only true for the *simulated* half of the grab
pipeline. Nyaa.si (see [Real Search and Grabs](Real-Search-and-Grabs)) is a real indexer now, and
a grab against a real Nyaa.si result genuinely submits to whichever real qBittorrent client this
page has configured and enabled — the same `addTorrent`/`getTorrents`/`pauseTorrents`/
`resumeTorrents`/`deleteTorrents` functions the Torrents modal below already uses.

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

### Real torrent management: add, list, pause, resume, delete

Test connection was the whole real surface area for a while — this extends it. A qBittorrent-
type client's row in Settings > Download Clients now has a "Torrents" button (list-icon, its own
32px grid column, only rendered for `type === 'qbittorrent'` — NZBGet rows get an empty
placeholder span there instead, keeping the two types' rows aligned) opening a modal against that
client's *real, live* torrent list.

This still doesn't touch the simulated grab pipeline (`queue-sim.js` — see [Grab / Download
Pipeline](Grab-Download-Pipeline)): a "grabbed" release in Kitsune is still fake, so there's no
real magnet to hand qBittorrent when one completes. What's real now is a standalone capability —
paste a real magnet link or `.torrent` URL into the modal's Add field and it actually goes to your
actual qBittorrent instance; the list below it shows what's actually running there, live.

- **`server/lib/download-clients/qbittorrent.js`** grew `addTorrent`, `getTorrents`,
  `pauseTorrents`, `resumeTorrents`, `deleteTorrents` alongside the existing `testConnection`, all
  sharing a new `login()` helper the old inline login code was factored out into. Every call logs
  in fresh rather than holding a session open — qBittorrent only rate-limits *failed* logins (a
  WebUI ban-list setting), so repeated successful ones cost nothing, and it keeps each function
  self-contained rather than threading a shared, potentially-expired cookie through the route
  layer. Every request now also sets a `Referer` header matching its own origin — qBittorrent's
  WebUI API docs call this out as required CSRF protection that a request missing it can get
  rejected over even with a valid session cookie, which the original Test-only code hadn't needed
  to worry about since a fresh login+version check is a narrower path than the full add/list/
  pause/resume/delete surface.
- **Adding a torrent** (`POST /api/v2/torrents/add`) is a real `multipart/form-data` POST (a
  `FormData` body — Node's own `fetch` computes the correct boundary itself, no manual
  Content-Type needed) carrying the pasted magnet/URL as `urls` plus the client's configured
  category. qBittorrent's own API returns `200 "Ok."` even for a garbage magnet — it's silently
  ignored rather than erroring — so a 200 here only confirms qBittorrent *accepted the request*,
  not that a torrent now exists; the modal's own 3-second polling is what actually shows whether
  it landed.
- **Listing** (`GET /api/v2/torrents/info`) is scoped to the client's configured category and
  returns qBittorrent's real fields as-is — `hash`, `name`, `total_size`, `progress` (a 0–1
  fraction, not 0–100), `dlspeed`, `eta`, `state`, etc.
- **Pause/resume** is the trickiest part: qBittorrent renamed these from `/torrents/pause` +
  `/torrents/resume` to `/torrents/stop` + `/torrents/start` as of WebAPI v2.11 (bundled with
  qBittorrent 5.0) — the old names 404 on a 5.0+ server, the new ones don't exist on anything
  older. Rather than parsing a version string, `qbittorrent.js` just tries the newer name first and
  falls back to the older one on a 404, caching per-host which one actually worked
  (`actionEndpointCache`) so later calls skip straight to it instead of re-probing every request.
- **Delete** (`POST /api/v2/torrents/delete`) removes from qBittorrent's list only —
  `deleteFiles` is deliberately never sent as `true` from the UI, matching this app's
  non-destructive-by-default convention elsewhere (Backup's Remove only removes the backup file
  entry, not anything it backed up).
- **`server/routes/download-clients.js`** gained the route layer: `GET`/`POST
  /api/download-clients/:id/torrents`, `POST .../torrents/:hash/pause|resume`, `DELETE
  .../torrents/:hash`. All 400 immediately for a non-qBittorrent client (NZBGet's JSON-RPC API has
  no per-torrent-hash queue shape to extend this route onto — left for later, not silently faked)
  or a client with no host/port set, and 404 for an unknown client id. A real qBittorrent-side
  failure (bad credentials, unreachable host, a 403/404/500 from qBittorrent itself) surfaces as a
  502 with qBittorrent's own rejection reason, rather than a generic 500.
- **`DownloadClients.jsx`**'s new `TorrentsModal` polls the list every 3 seconds while open (the
  same plain-polling approach Activity > Queue already uses for its simulated progress, no
  websocket), reuses the existing `.progress`/`.fill`/`.progress-label` bar and `.status-pill`
  tone classes (one new `.fill.danger` variant added for qBittorrent's `error`/`missingFiles`
  states) rather than inventing new ones, and maps qBittorrent's full `state` enum
  (`downloading`, `metaDL`, `stalledUP`, `pausedDL`, etc.) to a human label per state.

### Verified against a real mock qBittorrent, including the pause/resume fallback specifically

A second throwaway mock (`mock-qbittorrent-verify.mjs`, test-only, not part of the shipped app —
same pattern as `mock-qbittorrent.mjs`/`mock-nzbget.mjs` above) deliberately implements *only* the
old-style `/torrents/pause` and `/torrents/resume` endpoints, 404ing `/stop` and `/start`, so the
fallback-and-cache logic actually gets exercised end to end rather than just succeeding on the
new-endpoint-first try. Confirmed against a running server plus this mock: Test still works
unchanged after the `login()` refactor; adding a magnet returns success and the torrent shows up
on the next list call with the right category; pausing a torrent hits `/stop` first (404, logged),
then falls back to `/pause` (succeeds) — confirmed via the mock's own request log — and the
torrent's `state` flips to `pausedDL`; resuming immediately afterward calls `/resume` directly with
no wasted `/start` probe first, confirming the per-host cache actually took effect; deleting
removes it from the list. Error paths: an unknown client id 404s, an NZBGet-type client 400s with
a clear message, a client with no host/port 400s, and wrong credentials come back as a 502 with
"Login rejected — check username/password." — the same message the existing Test button already
used, unchanged by the refactor. A full `npm run build` (same sandbox `emptyOutDir` workaround as
every other pass in this project) also confirmed the new modal's markup compiled cleanly into
`settings-download-clients.js`.

---

[← Back to Home](Home)
