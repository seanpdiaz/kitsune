# Disk Usage

*This page combines three write-ups from different points in the project — the initial
real-disk-usage feature, the System > Tasks recompute job built for it, and the persistence
fix that came after — kept in the order they happened.*

## Library dashboard: real Disk usage

The Library dashboard's four stat cards (Series, Missing episodes, Downloading, Disk usage)
were, until now, plain static HTML — `184`, `27`, `4`, and `2.1 TB` hardcoded directly into
`index.html`, never wired to anything. Disk usage specifically is now real, computed two
different ways across two rounds of this fix — the first attempt measured the wrong thing
entirely, caught by the person using this against a real library. Both the bug and the fix
are worth documenting since the wrong version *looked* plausible.

### Round 1's bug: volume usage isn't folder content size

The first version summed `usedBytes` (`totalBytes - freeBytes`) from `fs.statfsSync` across
every root folder — the same syscall `computeRootFolderStats()` already used for free-space
numbers on Settings > Media Management and System > Status. That was wrong: `statfs` reports
how full the *entire volume* a path lives on is — every other file on that disk, not just
what's under the root folder. Confirmed against a real library: the dashboard read **42 TB**
while `du -sh` on the same root folder reported **2.9 TB** — the statfs number was measuring
the whole drive, most of which had nothing to do with the anime library sitting on it.

### Round 2: real recursive content size, cached and scheduled

What "Disk usage" should mean here is what `du` measures — the real, recursive sum of file
sizes under each root folder. `server/lib/disk-usage.js` is a from-scratch recursive walker
(`fs.promises.readdir`/`stat`, async so it doesn't block the event loop mid-scan) that sums
real file sizes under every configured root folder. Symlinks are deliberately skipped
(neither followed nor counted) to avoid double-counting or an infinite loop on a cyclic link.
A root folder that can't be read at all contributes `null` (excluded from the sum, not
counted as 0 bytes); a subfolder deeper in the tree that fails just gets logged and skipped
without invalidating the rest of that root folder's total.

This also answers the question of whether it should be computed live per page load or on a
schedule: a real directory walk over however many episode files a library has is genuinely
not free the way a single `statfs` syscall is, so computing it on every dashboard visit would
mean every visit pays for a full disk scan. Instead:

- **A module-level cache** (`{ bytes, computedAt, computing }`) holds the last completed
  scan's result. `GET /api/system/status` (`server/routes/system.js`) just reads this cache —
  instant, no disk I/O on the request path at all.
- **`startDiskUsageScheduler(intervalHours)`**, called once from `server.js` at startup, kicks
  off an initial scan immediately (without blocking `server.listen()` — the server starts
  serving requests right away) and then re-scans on a timer. The interval defaults to 6 hours,
  configurable via the `DISK_USAGE_REFRESH_HOURS` env var — genuinely a per-install judgment
  call (a library that barely changes vs. one grabbing constantly), not a real recommendation.
  A `state.computing` guard means an overlapping scheduled tick while a scan is still running
  is skipped (logged), not run twice in parallel.
- **Root folder add/remove triggers an extra fire-and-forget rescan** (`routes/root-folders.js`'s
  POST handler, and the generic DELETE handler in `routes/settings-items.js` when
  `section === 'root-folders'`) — without this, a freshly-added root folder's content
  wouldn't show up in Disk usage until the next scheduled tick, up to `DISK_USAGE_REFRESH_HOURS`
  later. Caught by my own test: added a root folder, immediately checked the dashboard, and
  got `"—"` instead of the folder's real size, before this hook existed.
- **The dashboard shows "Calculating…"** instead of `"—"` while the very first scan (or a
  just-triggered add/remove rescan) is still in flight — `diskUsageComputing` in the
  `/api/system/status` response, checked in `library.js` — so "no data yet" and "genuinely
  zero/unreadable root folders" don't look identical. The stat card's `title` attribute also
  shows when the number was last computed.
- Every `statfs` failure that used to be silently swallowed in `computeRootFolderStats` now
  logs a `WARN [FsHelpers]` line with the real reason (`ENOENT`, permissions, etc.) — added
  alongside this fix so a root folder silently contributing nothing to Disk usage shows up as
  an explained log line instead of an unexplained gap, visible on System > Logs.

One deliberate simplification carried over from round 1: no attempt is made to detect two
root folders that happen to be nested inside each other or share overlapping content — each
configured root folder's size is summed independently. For the common case (root folders are
separate, non-overlapping directories) that's correct; for two root folders where one is a
subdirectory of the other, the total will double-count that overlap.

Verified against a real, known directory tree (not a mock — files with exact known sizes: 1
MB + 2 MB + 3 MB, plus a symlink deliberately excluded from the total) rather than trusting a
formatted `du -sh` comparison alone: the computed total matched the real byte sum exactly
(6,000,000 bytes → "5.7 MB"), and the symlink's target size wasn't double-counted. Confirmed
the scheduler logs its startup message and initial scan; confirmed an unreadable root folder
(the three seeded `/anime/...` paths, which don't exist in a fresh checkout) logs a specific
`WARN [DiskUsage]` line and is excluded rather than treated as 0; confirmed adding a root
folder without restarting the server updates the dashboard total within about half a second
(the fire-and-forget rescan), and removing it drops the total back down the same way;
confirmed zero root folders (or all of them unreadable) falls back to `diskUsageBytes: null` /
`"—"`, not `0` or a crash. `public/index.html`'s Disk usage card has `id="diskUsageStat"` (the
other three stat cards are untouched — still the original hardcoded placeholders, out of
scope for this fix); a jsdom test loading `index.html` against a running server with the real
test directory as a root folder confirmed `#diskUsageStat` renders the exact expected total,
not just that the API returns one. Full 28-page regression suite passed 28/28 after every
step of this fix, including the round-1-to-round-2 rewrite.


---

## System > Tasks: Disk Usage Recompute is real, its interval is user-editable

System > Tasks has always been entirely decorative — `tasksData` in `system-tasks.js` is a
static array (RSS Sync, Backup, Housekeeping, etc.), and "Run Now" just faked a timestamp
update after a `setTimeout`. Disk Usage Recompute (the background job behind the Library
dashboard's Disk usage stat card — see the section above) is a real scheduled job now, so it
belongs on that page for real: listed there, with a genuinely working Run Now, and — since the
right refresh cadence is a per-install judgment call, not something to hardcode — an interval
you can actually change from the UI instead of only via the `DISK_USAGE_REFRESH_HOURS` env var
and a restart.

### `server/lib/disk-usage.js`: from a fixed `setInterval` to a configurable, persisted schedule

The previous version armed one `setInterval` at startup with whatever `DISK_USAGE_REFRESH_HOURS`
said and never touched it again. Making the interval editable meant switching to a
self-rescheduling `setTimeout` chain (`scheduleNext()`) instead: every completed run — scheduled
or manual — rearms the timer for whatever the *current* interval is, so changing it takes effect
immediately rather than needing the old `setInterval` torn down and recreated by hand. New
exports: `getTaskInfo()` (id, name, current interval, min/max bounds, last/next run timestamps,
whether a scan is running right now — what `GET /api/system-tasks` returns), `setIntervalHours()`
(validates, clamps to `[1, 168]` hours, persists, reschedules), and `runNow()` (System > Tasks'
Run Now — runs a scan immediately and resets the countdown to a fresh full interval from that
moment, rather than leaving the old timer to fire again almost immediately after).

The interval itself is persisted through the existing `app_settings` table (see Persistence) —
section `scheduled-tasks`, key `diskUsageIntervalHours` — the same generic per-section JSON blob
mechanism Media Management/General/UI/Metadata/Quality already use, just written to directly
from `disk-usage.js` rather than through the `/api/app-settings/:section` route those pages use
(this needed live *runtime* state — last run, next run, currently running — alongside the saved
config, which doesn't fit that route's plain "saved settings blob" shape). `DISK_USAGE_REFRESH_HOURS`
still exists, but only matters the very first time the server ever starts, before anyone's
touched the System > Tasks control — from then on, whatever's persisted always wins on startup.

### `server/routes/system-tasks.js` (new) and the frontend

Three endpoints: `GET /api/system-tasks` (an array — of one real task today — so the shape
doesn't need to change if a second real task ever joins Disk Usage Recompute),
`POST /api/system-tasks/disk-usage/run`, and `PATCH /api/system-tasks/disk-usage`
(`{ intervalHours }`). Run Now is fire-and-forget on the server side, same reasoning as the
Download Clients Test button and the root-folder-add rescan hook before it: a real directory
walk can take a while, so the response doesn't wait for it.

`system-tasks.js` keeps the seven decorative rows exactly as they were (nothing real exists
behind them yet, out of scope here) and adds an eighth, real one once `/api/system-tasks`
answers. That row is visibly different from the other seven in one deliberate way: its Interval
cell is a `<select>` (a fixed set of sensible choices — 1h up to 1 week — rather than a free-text
number field, since the server clamps regardless and a dropdown sidesteps validating "0",
negative numbers, decimals, etc. on the frontend for no real benefit) that `PATCH`es on change;
its Last Run/Next Run are computed from real ISO timestamps instead of the other rows' canned
"4 minutes ago" strings; and its Run Now button hits the real endpoint, then does one follow-up
check about two seconds later to catch the scan actually finishing (the initial `POST` response
doesn't wait for that, so an immediate re-render would just show "Running…" with nothing to
update it — a single delayed re-check is what actually shows the real completion, not an
indefinite poll loop).

Verified over real HTTP against a running server: confirmed the default interval is 6h;
`PATCH`ed it to 3h and confirmed the response reflected it; sent an absurdly large value
(999999) and confirmed it clamped to the real max (168h) rather than being accepted outright or
rejected outright; sent a non-numeric value and confirmed a real 400; called Run Now and
confirmed the response showed `running: true` immediately, with a follow-up `GET` showing
`running: false` and a fresh `lastRunAt` once the scan actually finished; **restarted the server
and confirmed the interval set via `PATCH` was still there** — the actual point of persisting it.
On the frontend, a jsdom test loaded the real System > Tasks page and confirmed all 8 rows
render (7 decorative + 1 real); changed the interval through the real `<select>` control (not
just the API directly) and confirmed the server-side value actually changed; clicked the real
Run Now button through the real DOM and waited past the follow-up poll, confirming the button
re-enabled, `lastRunAt` genuinely changed, and the row stopped showing "Never." Full 28-page
regression suite passed 28/28.

### Indeterminate progress bar while a scan is running

The real row's Run Now flips to a disabled "Running…" state, but with nothing else moving, a
scan that takes more than a second or two can look stuck. A real recursive directory walk has no
cheap way to know "how much is left" up front, so rather than fake a percentage against a
root-folder count (chunky, and can't move at all with just one root folder), the row grows a
thin bar across its bottom edge with a continuously sliding fill — the same pattern as a browser
tab's loading indicator: always visibly active, never claims a specific amount of progress.
CSS-only (`.task-progress-track` plus a `slide` keyframe in `styles.css`), scoped to `.task-row`
only so the seven decorative rows are untouched; `system-tasks.js`'s `realRowHtml()` renders the
bar only while `task.running` is true. Verified via jsdom: absent while idle, present
immediately after a real Run Now click.

**Bug fixed shortly after shipping this:** the bar didn't stop once the scan actually finished.
The Run Now click handler only ever checked back in once, at a fixed 2 seconds — fine for a scan
that happens to finish inside that window, but on anything slower the frontend simply stopped
looking, so "Running…" and the sliding bar stayed on screen indefinitely even though the server
had long since finished and moved on. There was never a way to know a real scan's duration up
front, so a fixed delay was always going to be wrong for *some* library size. Replaced the
one-shot `setTimeout` with `pollUntilDone()`: re-checks `/api/system-tasks` every 2s for as long
as the task reports `running: true`, and stops the moment it doesn't — tracking a scan of unknown
length instead of guessing it. Verified with a jsdom test using a scripted fetch mock that reports
still-running for three 2s poll cycles (6s — well past the old fixed cutoff) before reporting
done on the fourth: confirmed the row kept polling past the point the old code would have given
up, and that the bar/button/Last Run all caught up to the real completion once it landed.

### Green completion flash

The bar disappearing was correct but easy to miss — nothing drew the eye to the exact moment a
scan finished. `pollUntilDone()` is the one place that can actually observe a running->done
transition happen live (it compares `running` before and after each poll), so it's what sets a
one-shot `flashOnNextRender` flag right when that transition is detected. `render()` reads and
immediately clears that flag on every call, passing it into `realRowHtml()` as whether to include
a `row-flash-success` class on that render only. The CSS side needs no JS timer to "turn the
flash off": `.row-flash-success`'s `animation` (a `background`/`border-color` sweep from
`--success`/`--success-bg` back to normal over 1.6s, in `styles.css`) is non-infinite, so it just
stops on its own once it finishes playing — and because it's only ever present in the HTML string
for the one render call right after completion, it can't replay on some later, unrelated
re-render (changing the interval a minute afterward, say) the way a persistent class would.
Verified via a jsdom test with a scripted fetch mock simulating a 4s scan: confirmed the class was
absent through both `running: true` poll cycles, present on exactly the render that first saw
`running: false`, and absent again after a follow-up interval change re-rendered the row.

### Reused on Download Clients' Test Connection

The class was renamed from `task-row-complete` to the more generic `row-flash-success` specifically
so it could be reused here: a real qBittorrent/NZBGet connection test succeeding is the same "this
just worked" moment as a scan finishing, on a row (`.dlclient-row`) that shares the same
`.settings-row`-family background/border styling. `settings-download-clients.js` carries its own
one-shot `flashOnNextRender` (holding the client's `id` rather than a boolean, since the list can
have more than one client), set by either the row's own Test button or the edit modal's Test
Connection button whenever the server reports `ok: true`, and consumed by `render()` exactly like
the Tasks page. The modal case is the interesting one: the row itself is hidden behind the modal at
the instant the test succeeds, so the flag just waits — `closeEditModal()` already called `render()`
before this (to clear a stale status pill left over from a modal test), and that's the render that
now also picks up the flag, so the flash plays the moment you return to the list. Verified against a
real mock qBittorrent instance: the row-level Test button flashes the correct row (matched by id, not
just "the first `.dlclient-row`" — the list can have other, unrelated clients in it) on success, and
testing from inside the edit modal and clicking Done shows the same flash on modal close.


---

## Disk usage now persists across restarts

The Library dashboard's "Disk usage" stat card (`server/lib/disk-usage.js`) was already a real,
recursive `du`-style scan on a background timer rather than something computed per page load — but
the cached result only ever lived in memory (`state.bytes`/`state.computedAt`). A server restart
meant starting from nothing: `state.bytes` reset to `null`, and every page load showed
"Calculating…" until a brand new scan finished, even though the previous scan's number was still
perfectly good — a real library's full walk isn't instant, so this could mean an empty-looking stat
card for a while after every restart, for no real reason.

Added a small persistence layer using the same `app_settings` table `server/routes/system-tasks.js`
already uses for the recompute interval, in its own `disk-usage-cache` section (kept separate from
the interval's own section — unrelated concerns, and this one gets written on every single
successful scan rather than only when someone changes a setting). `startDiskUsageScheduler` now
loads whatever was last persisted into `state` *before* kicking off a fresh scan, so
`getCachedDiskUsage()` — what `/api/system/status` actually reads — has a real number to hand back
immediately on the very first request after a restart, not just once the new scan eventually lands.
`refreshDiskUsage` persists the new total after every scan that actually managed to read at least
one root folder; a scan that fails to read anything at all (every root folder unreadable — a drive
temporarily unmounted, say) leaves the persisted value alone rather than overwriting a real number
with nothing, on the theory that a stale-but-real number is more useful than erasing it over what's
hopefully a transient problem.

This only helps if the frontend actually shows the cached number while a fresh scan runs in the
background, so `library.js`'s dashboard stat card changed too: it used to show "Calculating…"
any time `diskUsageComputing` was true, full stop — which used to be the only sensible behavior,
since there was never anything else to show in that state anyway. Now that there usually *is* a
real persisted number available even while a fresh scan is in flight, it shows that number instead
(suffixed with "(updating…)" so it's clear a rescan is in progress rather than looking like a
finished, final value), and only falls back to "Calculating…" for the genuine case of nothing
having been computed or persisted yet at all — a brand new install with no prior scan to fall back
on.

Verified against a real root folder with a real file on disk: ran a real scan, confirmed the result
landed in `app_settings` correctly; restarted the server and confirmed `/api/system/status`
returned the previous scan's exact number immediately, before the new startup scan could plausibly
have finished (and the new scan then updated it moments later, right on schedule); separately
confirmed via a scripted fetch mock that the dashboard stat card renders "19 MB (updating…)" rather
than blanking to "Calculating…" when a cached value exists alongside `diskUsageComputing: true`.
Full 28-page regression suite passed clean.

### Bug fixed shortly after shipping this: "(updating…)" never went away

Reported with a screenshot from a real deployment: the stat card sat on "2.9 TB (updating…)"
indefinitely, well after the server's own log confirmed the scan had actually finished
("Recomputed disk usage: 2.9 TB across 1 root folder(s) in 11.0s"). The disk usage fetch in
`library.js` was a single one-shot `fetch('/api/system/status')` — fine if the page happened to load
after a scan had already landed, but loading the page *while* one was still running (right after a
restart, or right after System > Tasks' Run Now — the same background job either way) meant it
fired once, saw `diskUsageComputing: true`, printed "(updating…)", and never checked again — a real,
finished, up-to-date number sat there still labeled as if it were mid-scan until the next full page
load. The exact same class of bug System > Tasks' own progress bar had earlier (see "Indeterminate
progress bar while a scan is running" above) and the same fix: turned the one-shot fetch into
`applyDiskUsageStatus()`, which re-checks every 2s for as long as `diskUsageComputing` is true and
stops the moment it isn't, rather than checking once and giving up. Verified with a scripted fetch
mock returning `diskUsageComputing: true` for the first two calls and `false` from the third
onward: confirmed the card showed "19 MB (updating…)" through both still-computing polls, dropped
to a bare "19 MB" on the render that first saw `diskUsageComputing: false`, and made no further
requests after that. Full 28-page regression suite passed clean.


---

[← Back to Home](Home)
