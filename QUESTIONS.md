# Questions from the overnight build

Everything in this pass was built under one instruction: get as close to a finished
product as possible, use Sonarr/Radarr's real behavior as the reference when unsure, and
write down anything that's a genuine product decision rather than something I could
reason my way to. This is that list, roughly in order of how much they'd change if
answered differently.

## 1. Is Movies (the Radarr half) ever in scope? — **Answered: no**

Confirmed: Kitsune is series-only, no movie/Radarr equivalent planned. Everything built so
far — schema, nav, episodes, seasons, the whole grab pipeline — is shaped entirely around
Sonarr's TV/series model, and that's the intended shape going forward, not a gap to fill
later. No further action needed here.

## 2. Is the simulated grab/download pipeline the intended final shape, or a placeholder for real integration?

Search, grab, download progress, and import are all simulated tonight (see the
Grab/download pipeline section of `README.md` for the full reasoning on why — briefly,
reaching a real torrent/usenet tracker or download client isn't something to do from this
sandbox even if it were possible, and felt like a different kind of integration than the
metadata APIs already wired up). Two different futures are both plausible from here:

- Keep it simulated permanently — this is a mockup/demo app, and a realistic-feeling fake
  pipeline (which is what tonight built) is the actual deliverable, the same way the
  Settings pages don't really configure a real indexer today.
- Build toward real indexer (Torznab/Newznab-style) and download client (qBittorrent/
  SABnzbd-style) integration eventually, with the simulated pipeline as scaffolding for
  what the UI/data flow should look like once real ones exist.

If the answer is "real eventually," the queue/history/blocklist schema and REST surface
built tonight should mostly still hold up (a real backend would fill the same tables), but
`server/lib/queue-sim.js` specifically is the piece that would get replaced.

## 3. How deep should quality-profile editing actually go?

Settings > Profiles and Settings > Quality persist real data (name, cutoff, allowed
qualities) today, and the cutoff is what Cutoff Unmet and the release-generation weighting
both read from — but neither page validates that a profile's allowed-quality list forms a
coherent Sonarr-style profile (upgrade order, minimum/maximum size per quality tier, etc.
that real Sonarr's profile editor enforces). Worth knowing whether that level of
validation/UI is something to build out, or whether the current "freeform list + cutoff"
shape is enough for what this app needs to demonstrate.

## 4. The `warning`-status queue gap

Noted in `README.md`'s Grab/download pipeline section: about 10% of simulated grabs start
in a `warning` state (mirroring a real Sonarr queue row stuck on a client-side issue) and
never auto-progress. The episode itself still shows as "Missing" with an active Search
button on the series detail page, and clicking it again just hits the existing
duplicate-grab 409 rather than doing anything useful. Small, low-probability, and doesn't
crash anything — but worth a real decision on whether that queue row should surface some
kind of "stuck" indicator on the episode itself, whether warning rows should be
resolvable (a "Remove" action, at minimum), or whether this status is worth simulating at
all if nothing in the UI can act on it yet.

## 5. Should Settings > Indexers/Download Clients/Import Lists/Connect ever "really" connect?

Health card on System > Status stays synthetic (see `README.md`) specifically because
these settings pages store field values without ever testing or using them for anything
real. Same underlying question as #2 — if the grab pipeline stays simulated forever, this
probably should too; if real indexer/client integration is ever wanted, a "Test" button
that actually attempts a real connection (the way real Sonarr's Settings pages work)
would be the natural next step, and Health would then have something real to report.

## Smaller things, not worth their own numbered question

- Release generation's 8% simulated-failure rate and 10% simulated-`warning` rate are
  both guesses picked so those code paths have something to show, not numbers pulled from
  anything real. Easy to change if either feels off in practice.
- The weighted quality distribution in `queue-sim.js` (skewed toward WEBDL-1080p) is a
  guess at what's realistic for anime fansub/streaming releases specifically, not sourced
  from anywhere — flag if it should look different.
- `file-browser-modal.js` still requires every page using it to paste in its own static
  modal shell in HTML, unlike the new `release-picker-modal.js` (JS-generated, no HTML
  needed). Same kind of duplication the page-tabs fix addressed elsewhere, deliberately
  not touched this pass — flagged once already and the answer was "not yet," repeating it
  here since it's still true.
