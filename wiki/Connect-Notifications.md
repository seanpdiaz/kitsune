# Connect Notifications (Pushover)

## Connect: real Pushover notifications

Settings > Connect had the same problem [Download Clients](Download-Clients) did before its own fix:
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


---

[← Back to Home](Home)
