# Quality Definitions

## Quality Definitions redesign

Settings > Quality used to be a flat table of 12 rows, each three plain number boxes
(Min/Preferred/Max, in MB per minute of runtime) — functional, but exactly the kind of
"do the bitrate math yourself" UI real Sonarr/Radarr are often criticized for. This
section covers the replacement: tiers grouped into collapsible accordions by resolution,
each edited through a single 3-handle slider instead of three boxes, real file-size
readouts instead of a raw rate, and presets — plus a bigger change underneath the UI that
the redesign surfaced was worth doing anyway: quality tiers
themselves are fully user-managed now (add, rename, delete, reorder), not a fixed list of
11 names baked into the server.

### Tiers are data now, not a hardcoded array

`server/lib/quality.js` used to export a literal `QUALITY_ORDER` array — the single
fixed list every other part of the app (Cutoff Unmet, the simulated release generator's
quality weighting) compared against. That's gone. Quality tiers are now rows in the same
`settings_items` table every other list-style Settings page already uses (Indexers,
Profiles, Root Folders, etc. — see [Persistence and Logging](Persistence-and-Logging)), under a new `quality-tiers`
section, seeded on first run with the same 11 tiers the old table had (SDTV through
Bluray-2160p, each carrying its `resolutionGroup` and starting min/preferred/max — the
one pre-existing inconsistency this fixed in passing: the old table also had a "DVD" row
that was never actually part of `QUALITY_ORDER`, so it never affected Cutoff Unmet or
release generation despite looking like it should; dropped from the new seed, and easy to
add back for real through "Add Quality" if it's wanted).

- **Rank is a row's `position`.** The existing `settings_items` table already had a
  `position` column for display order; for `quality-tiers` specifically, that same column
  now doubles as cutoff rank — worst tier first. `quality.js`'s `getQualityOrder()`/
  `qualityRank()`/`isBelowCutoff()` all query the live table (`ORDER BY position ASC`) on
  every call instead of reading a cached constant, so a tier added, renamed, deleted, or
  reordered from the page takes effect everywhere immediately — Cutoff Unmet, and the
  release generator's best-quality-first sort — with nothing to invalidate. It's a small
  table (a dozen-ish rows even heavily customized) read with a plain indexed query, so
  this costs nothing measurable; caching it would just reintroduce the exact "two things
  can disagree" problem this rewrite exists to remove.
- **Reordering needed a small generic addition to `settings-items.js`.** The existing
  `PATCH /api/settings-items/:section/:id` only ever merged fields into a row's JSON
  `data` blob — there was no way to change the `position` column itself. `position` is
  now a reserved key in the PATCH body: if present, it updates the column directly instead
  of being folded into `data` (and `GET`'s `rowToItem` now always includes the real
  `position` value in its response, listed last so it can't be shadowed by a same-named
  data field). This is generic, not Quality-specific — any other list-style Settings page
  could reorder itself the same way later.
- **`server/lib/queue-sim.js` had two hardcoded per-name tables** — `QUALITY_WEIGHTS`
  (how often each tier gets picked for a fake release) and `BASE_SIZE_MB` (roughly
  realistic file size per tier) — that couldn't keep working once tiers stopped being a
  fixed set of names. Both are derived from the live tier list now:
  - **Weight is by resolution group**, not by exact tier name: a small `GROUP_WEIGHT`
    table (`SD`/`720p`/`1080p`/`2160p`, 1080p weighted heaviest, matching anime's real
    skew toward WEBDL-1080p releases) applies per tier within its group, so a group with
    more tiers defined shows up proportionally more without diluting the group as a
    whole, and a custom group a user invents gets a flat default weight — present, not
    dominant, without needing to know its name in advance. This does lose the old table's
    finer per-name distinctions (e.g. WEBDL-720p being weighted higher than HDTV-720p
    specifically) — an accepted simplification, since that distinction can't generalize
    to tiers that don't exist yet.
  - **Size comes straight from the tier's own Preferred value** — `preferredMBPerMin x`
    a fixed 24-minute reference episode length (a typical anime TV episode) — instead of
    a second, separate "realistic size" table that could quietly drift from whatever's
    actually configured on the page. Whatever a tier's target size says on Settings >
    Quality is what a simulated release of that quality weighs in at (+/-15% jitter so
    same-quality releases from different fansub groups don't all report byte-identical
    sizes). One number now, not two — a nice side effect of the redesign, not something
    that was specifically asked for.
  - **Degenerate case (every tier deleted):** `pickRealisticQuality` returns `'Unknown'`
    rather than throwing, `qualityRank`/`isBelowCutoff` treat it as unranked the same way
    they already treated any unrecognized name, and `generateReleases` still returns 5
    candidates (all `'Unknown'`) instead of crashing. Verified directly (see Verification
    below) — an unlikely thing for a real user to do, but it shouldn't be able to break
    the app if they did.

### The 3-handle range slider (`public/js/lib/range-slider.js`)

A native `<input type="range">` only ever supports one handle (two with browser-specific
tricks, never three), so this is hand-built with pointer events: a factory function
(`mountRangeSlider(container, options)`) mounted once per tier row, all sharing one
implementation rather than three near-copies of drag/keyboard/tooltip logic — same
one-component instinct this project already applied to `file-browser-modal.js`/
`release-picker-modal.js`.

- **Three handles**: a circular Min handle and Max handle (color-coded warning/danger —
  see Colors below), and a small rotated-square Preferred handle in between, clamped so
  dragging one can't cross another (`min <= preferred <= max`). All three are draggable —
  Preferred isn't just an informational marker, since the underlying data model already
  had three independent values to begin with.
- **Unlimited** is a checkbox next to the Max label, not a separate control bolted on:
  checking it disables/dims the Max handle and the slider's fill extends to the track's
  end; the handle's last real numeric position is preserved underneath so unchecking it
  restores a sensible value instead of resetting to zero.
- **Keyboard accessible**: each handle is a real `tabindex="0"` element with
  `role="slider"`; arrow keys nudge the focused handle by one step under the same
  clamping rules a drag uses.
- **Per-row bounds, not one shared scale**: an SDTV row and a Bluray-2160p row differ by
  10x or more, so sharing one global slider range would squeeze small tiers into a sliver
  of the track. Each row's bounds are computed from that tier's own current values
  (`max(current max, current preferred) * 1.6`, rounded), so every row's handles use the
  full width of its own track regardless of scale.
- **Colors**: this app's palette (`public/styles.css`'s `:root` variables) has no blue —
  the reference mockup's orange/blue/red handle scheme became `--warning` (Min),
  `--accent` (Preferred — the app's own brand orange, reused here as "the one that
  matters most"), `--danger` (Max), staying inside the existing design system instead of
  introducing a color nothing else in the app uses.

### Display: Reference Runtime, units, and why the canonical unit didn't change

The underlying stored value per tier was always MB per minute of runtime — a
duration-independent rate, not tied to any specific episode length — and stays exactly
that; only how it's *displayed* changed. A **Reference Runtime** selector (12 min short /
24 min standard episode / 45 min extended episode-OVA — deliberately anime-episode-length
options, not a movie runtime, since Movies aren't in scope for this app — see
`QUESTIONS.md`) and a **Display** toggle (Estimated File Size vs. raw Rate) turn that same
stored number into either `formatBytes(mbPerMin x runtimeMinutes x 1024 x 1024)` — reusing
the exact formatter Activity/the release picker already use for downloaded file sizes, see
[Grab / Download Pipeline](Grab-Download-Pipeline) — or the plain rate. Both are page-display preferences, not
tier data, saved separately via a small `/api/app-settings/quality-ui-prefs` blob (the
same field/toggle-style `app_settings` shape every other Settings preference already
uses), so switching units doesn't touch a single tier's actual saved values.

### Presets

Doesn't exist in real Sonarr — this is the redesign's own invention, per an explicit
"pick reasonable numbers yourself" from the person who asked for this feature, so the
specific multipliers below are a starting point, not a researched target.

**Presets** (Storage Saver / Balanced / High Bitrate-Quality / Uncompressed-Remux Focus)
are flat multipliers (0.6x / 1.0x / 1.6x / 2.4x) applied against each tier's *original
seed* min/preferred/max for the 11 known tier names (a small `KNOWN_TIER_DEFAULTS` table
in `settings-quality.js`, deliberately duplicated from the server-side seed rather than
fetched, just for this) — a custom tier with no matching name scales from its own current
values instead, so presets still do something reasonable for it without recognizing it by
name. Remux Focus additionally forces Max to Unlimited on the 1080p/2160p groups.
Selecting a preset is a one-time jump to a set of values, not a persistent mode — the
dropdown resets to "Custom" right after applying.

An earlier version of this page also had a global "Bitrate Scale" slider that
proportionally resized every tier's min/preferred/max at once — removed after feedback
that it wasn't worth having for something set up once and rarely adjusted again. It also
surfaced a real bug worth noting for the record: each row's slider computes its own track
bounds once, sized to that tier's values at mount time (see Rendering below); scaling
every tier up at once could push values past those original bounds, leaving a handle
visually pinned at the track's edge even though the real stored value kept climbing
underneath it. Fixed at the time by calling the slider's `setBounds()` before every
`setValue()` so the track always had headroom for whatever it was about to show — worth
remembering if per-row bounds-recalculation is ever needed again elsewhere (a preset
applying a very large multiplier, for instance, hits the exact same class of problem, but
since a preset's `renderAll()` remounts every slider fresh with bounds computed from the
already-final values, it never actually hits the bug in practice).

### Add Quality modal

The button used to add a tier by itself, with no chance to say anything about it first —
"New Quality N", hardcoded into the 1080p group, with the same flat 10/100/150 starting
min/preferred/max regardless of what it actually was, since the button had no idea what
you were about to add. Clicking it now opens a small modal asking for a name and a
resolution group before anything gets created.

- **JS-generated, not a static page shell**: same approach `release-picker-modal.js`
  uses (built once, appended to `<body>`, nothing pasted into
  `public/settings-quality.html`) rather than `file-browser-modal.js`'s older pattern of
  every page providing its own copy of the modal markup — this one is only ever used from
  this one page, so it's built directly inside `settings-quality.js` rather than as a
  separate `lib/` file the way the multi-page release picker needed to be.
- **Resolution group** is the same free-text-plus-`<datalist>` input every tier row
  already uses (see Grouping below) — typing an existing group's name (or picking it from
  the autocomplete) adds the tier there; typing anything else starts a brand-new group,
  same as renaming a tier's group already did.
- **Starting values scale with the chosen group** instead of always being the same flat
  numbers: a small `GROUP_STARTING_DEFAULTS` table gives SD/720p/1080p/2160p each a
  sensible starting min/preferred/max (a brand-new 2160p tier doesn't start out looking
  absurdly small next to its siblings the way a flat 10/100/150 would), and a custom group
  name falls back to the original flat default. These are still just a starting point —
  the point of the redesign is that the slider on the row itself is where these actually
  get tuned, not that the modal needs to get them exactly right.
- **Validation**: an empty name is rejected, and a name that already exists (checked
  case-insensitively against the current tier list) is rejected too, both with an inline
  message in the modal rather than silently doing nothing or creating a confusing
  duplicate.

### Repositioning a single tier's whole window

Each tier's min/preferred/max is edited with its own 3-handle slider (see the Slider
component section above) — dragging the min or max handle resizes that edge independently,
same as it always has. But there was no way to move a tier's *entire* range without
touching every handle: dragging the target (preferred) handle used to just slide it around
inside a fixed min/max span, so nudging, say, HDTV-1080p's whole window 20 MB/min higher
meant dragging min, then preferred, then max, one at a time, and preferred could never even
pass max since it was clamped inside it.

Dragging (or keyboard-nudging) the target handle now translates the whole window instead:
min and max shift by the same amount as preferred, keeping their original distance from it,
so the tier's range moves as one unit and its width never changes. `range-slider.js`'s new
`moveWindow(newPreferred)` helper computes the delta, applies it to all three values, and
clamps the whole translate to the track's own outer bounds (so a window can't be dragged
past the edge and lose its width) rather than letting min/max clamp independently the way
they still do on their own handles. Confirmed via a jsdom-simulated drag directly against
the component (with `getBoundingClientRect` stubbed for a fixed track width, since jsdom
does no real layout): dragging the target handle moves min and max by the exact same delta
and preserves the window's width; dragging min or max alone still only moves that one edge
and leaves preferred and the other edge untouched; and dragging the target handle toward
either edge of the track clamps the whole window there without exceeding the track's bounds
or losing its width. The full page-load regression check for `settings-quality.html` was
also re-run against the real project files afterward with no errors.

Separately, committing a slider change (a drag release, a keyboard nudge release, or the
typed edit below) now re-renders the whole page instead of just patching the server:
`commitSliderChange` in `settings-quality.js` calls `renderAll()` after saving, which
remounts every slider with its track bounds (`boundsForTier`) recomputed from the tier's
now-current values. Bounds were previously only ever set once, at initial page load — so
dragging a tier's whole window down to something much smaller than it started (SDTV's
default max is 100 MB/min, giving it an ~160 MB/min track) left the handles visually
bunched on one side of a track still sized for the old, larger numbers instead of the track
shrinking to fit. Confirmed by dragging a tier's window down via its target handle against
the real server and checking the remounted handle positions land where the new,
recomputed bounds put them, not where the stale pre-drag bounds would have.

### Typing an exact value

Dragging is fine for a rough position but can't land on an exact number, especially on a
track sized very differently per tier. Double-clicking any handle now opens a small text
box, pre-filled with that handle's current value formatted exactly like its tooltip (in
whichever of Rate or Estimated File Size the page's Display toggle is currently set to), so
what's shown is what you can just retype over. Enter or clicking away commits it; Escape
cancels without changing anything.

- **Min/max**: typing a value that stays on the correct side of the target is a plain
  resize of just that edge — same as dragging it. But typing a value that would cross the
  target (a new min above the current target, or a new max below it) doesn't get silently
  clamped back down to the old target the way a drag would; it carries the target (and the
  far edge) along instead, translating the whole window and preserving whatever
  min-to-target and target-to-max gaps it already had. `range-slider.js`'s `moveWindow`
  helper from the previous section got generalized into `translateWindowTo(anchor,
  anchorValue, clampToTrack)` for this — anchor is whichever handle was edited, not always
  preferred.
- **Target**: typing a value always translates the whole window, same as dragging it —
  `commitTypedValue` just calls `translateWindowTo('preferred', v, false)` directly, no new
  logic needed.
- **The one real difference from a drag**: typed edits pass `clampToTrack: false`. A drag
  is capped at the edge of its own rendered track because that's a real physical limit —
  you can't drag a handle past a pixel that isn't there. A typed number has no such limit;
  the track's current bounds are just `boundsForTier()`'s guess based on the *previous*
  values, not a constraint on the data. Clamping a typed value to the old track bounds
  produced exactly the bug from the section above: typing an intentionally large number got
  silently capped to whatever the stale track happened to allow. Typed commits skip that
  clamp (keeping only a floor at zero) and rely on the `renderAll()` bounds-recompute above
  to resize the track to fit afterward.
- **Unit-aware parsing**: `settings-quality.js`'s `parseValue()` is the reverse of
  `formatValue()` — a bare number in Rate mode is taken as raw MB/min directly; in Size
  mode it's parsed for an optional `MB`/`GB`/`KB` suffix (defaulting to MB if you type a
  bare number, since that's the common case for episode sizes) and converted back through
  the Reference Runtime to raw MB/min, so it round-trips through whatever unit is currently
  on screen.
- Double-clicking the max handle while its tier is set to Unlimited does nothing — there's
  no numeric value to type over in that state, same as dragging is already disabled for it.

Verified with a jsdom test running against a real server (not just the isolated component):
double-click opens the box pre-filled with a unit-suffixed value; typing a min that stays
below target only changes min; typing a min that crosses target moves min to the typed
number and preserves both gaps exactly, confirmed against the persisted server record;
typing a target value shifts min and max by the identical delta; Escape leaves the
persisted value untouched; and double-clicking an Unlimited tier's max handle doesn't open
an editor. The full 28-page regression sweep was re-run afterward and passed clean.

**Real-browser bugs found after that (jsdom couldn't have caught either one):**
double-click didn't actually work in an actual browser at first, despite every jsdom test
above passing, because jsdom's `dblclick` tests dispatched that event directly rather than
simulating two real clicks in sequence — so neither of the following was ever exercised:

1. First guess: `startDrag()`'s pointerdown handler called `e.preventDefault()`
   unconditionally (to stop text selection while dragging), and per the Pointer Events
   spec, canceling a `pointerdown` for a touch/pen pointer suppresses the browser's
   *synthesized* compatibility mouse events that would otherwise follow — including
   `click`/`dblclick`. Dropped it and added `user-select: none` to `.rs-handle` in
   `styles.css` instead (touch scrolling was already separately handled by
   `touch-action: none` on the same rule). Reasonable cleanup, but it turned out this
   suppression only applies to touch/pen input, not a real mouse — so on its own this
   wasn't actually why a mouse double-click was failing.
2. **The actual cause**: `startDrag()`'s `up()` handler fires `onCommit` on *every*
   pointerup, including a plain click with zero movement — previously harmless, since
   `onCommit` only did an idempotent PATCH. But `commitSliderChange` in
   `settings-quality.js` now also calls `renderAll()` on every commit (see the
   bounds-recompute fix above), which tears down and rebuilds every tier row's DOM,
   including the handle you just clicked. So the *first* click of a double-click was
   destroying and replacing the handle element before the *second* click could land on it
   — the second click hit a brand-new DOM node the browser had never seen a first click on,
   so it never registered as a double-click at all, on every attempt, consistently. Fixed
   by snapshotting the slider's value at pointerdown and only firing `onCommit` if it
   actually changed by pointerup, so a no-op click no longer triggers a re-render. Verified
   directly: dispatching a real pointerdown/pointerup with no movement now leaves the exact
   same DOM node in place afterward (previously failed this check); two full
   pointerdown/pointerup cycles followed by `dblclick` on that same surviving node opens
   the editor; and an actual drag with real movement still commits and persists like
   before. The full 28-page regression sweep passed clean afterward too.

**A third bug, found from an actual screenshot of it happening:** editing the target
handle on a GB-scale tier could make its minimum collapse to 0 MB. The box pre-fills with
something like "1.48 GB" and `input.select()` selects the whole thing, so the obvious way
to edit it is to just type a replacement number over the selection — "3", meaning 3 GB.
But `parseValue()` in `settings-quality.js` defaulted *any* bare number with no unit
suffix to MB, so that "3" was silently read back as 3 MB instead — a value far below the
tier's actual minimum (e.g. 840 MB). That's exactly the "crosses the far edge" case
`commitTypedValue` handles by translating the whole window (see "Typing an exact value"
above), and the translate's zero-floor (a window can't push min below 0) landed min at
precisely 0 to accommodate it — which is mathematically the correct response to a target
of 3 MB, just not to what the person actually meant. Fixed by having `openEditor` in
`range-slider.js` remember the unit suffix the box was *pre-filled* with (stashed as
`input.dataset.defaultUnit`) and passing it through to `options.parse(text, defaultUnit)`
as the fallback when the typed text has none of its own — so a bare number retyped over a
GB-scale value stays in GB instead of silently dropping three orders of magnitude to MB.
Verified by reproducing the exact reported scenario end-to-end: PATCHing a tier to
min≈840 MB/preferred≈1.48 GB directly (matching the screenshots), confirming the
pre-filled box reads "1.48 GB" with a remembered default unit of "GB", then typing a bare
"3" and confirming the persisted result lands at ≈3 GB (not ≈3 MB) with min translated up
alongside it rather than collapsing to 0. The full 28-page regression sweep passed clean
afterward too.

### Minimum gap between min/max and the target

A fourth bug, found by just directly dragging a handle: nothing stopped min from being
dragged (or typed) all the way up to *exactly* equal preferred, or max all the way down to
it. When that happened the two handles landed on the exact same pixel — and since
preferred renders on top (higher `z-index`, so it always reads as the "front" handle), the
other one ended up invisibly stuck underneath it, with no way to grab it again: clicking or
double-clicking that spot only ever hit preferred.

Fixed with a minimum enforced distance, `minGap()`, between min-and-preferred and
preferred-and-max — 3% of the *track's own value range*, or `step`, whichever is bigger.
A fraction of the range rather than a fixed raw number matters here for the same reason
`boundsForTier()` gives every tier its own track scale: a fixed gap of, say, 5 MB/min would
be generous on an SDTV-scale track and practically invisible on a 2160p-scale one, whereas
3% of the range maps onto the same 3% of on-screen pixel width regardless of which tier's
numbers it is. Every path that can move min or max now routes through it: dragging and the
keyboard nudge (`clampForHandle`), a typed edit (`commitTypedValue`'s crossing threshold
moved from "past preferred" to "within minGap() of preferred"), and un-toggling Unlimited
(max used to snap back to exactly `preferred` as its floor, now snaps to `preferred +
minGap()` instead). A defensive `enforceGaps()` also runs on mount, on `setValue()`, and
on `setBounds()`, in case a tier's stored data already violates it — a `setBounds()` call
in particular can shrink the *absolute* size of a 3%-of-range gap without any handle having
moved at all, so it has to re-check too. Verified directly: dragging min or max as far as
possible toward preferred now always leaves a measurable gap instead of landing on it
exactly, typing a value at (or past) preferred is treated as a crossing rather than an
exact-overlap resize, and toggling Unlimited off snaps max back above preferred with room
to spare rather than flush against it. The full 28-page regression sweep passed clean
afterward too.

### Target handle getting stuck once min hits 0

A fifth bug: once a tier's minimum was dragged (or typed) down to exactly 0, the target
handle would get completely stuck — dragging it left did nothing, typing a lower number
did nothing, not even the keyboard nudge worked. `translateWindowTo`'s floor for how far
preferred could move was computed as `bounds.min + minOffset`, where `minOffset` is
min's *current* distance from preferred. That's the right idea in general — it's meant to
stop a translate from pushing min negative — but once min was already sitting at exactly
0, `minOffset` **equals preferred's own current value**, which silently turned the floor
into "preferred can never decrease," for as long as min stayed at 0. Every path that moves
preferred (drag, keyboard, typed edit) shares this one function, so all three were stuck
the same way.

Fixed by no longer deriving preferred's own floor/ceiling from min and max's *current*
distance at all. `translateWindowTo` now moves preferred first — capped only by the
track's real pixel bounds for a drag, or left essentially uncapped for a typed value, same
as before — and *then* places min and max by trying to preserve their old distance from
it, each clamped independently against its own real limit (0 for min; the track's top, or
nothing at all for a typed edit, for max) and `minGap()` from wherever preferred ended up.
If preserving the old gap isn't possible without going negative, that edge just sticks at
its own limit and the gap between it and preferred shrinks — the translate still happens,
instead of refusing to move at all. Verified directly against the reported scenario: with
min pinned at 0, both dragging the target left and double-click-typing a lower target
value now actually move it, with min staying at (not below) 0 either way. Re-checked the
three behaviors this rewrite touches most directly — a normal (non-boundary) drag still
preserves the window's width exactly as before, a typed value still isn't capped by a
stale track's old bounds, and the minGap buffer from the section above is still enforced —
plus the full 28-page regression sweep, all still clean.

### Grouping and reordering

Tiers are grouped into accordions by `resolutionGroup` — a free-text field per tier (with
a `<datalist>` autocompleting the four common values plus whatever custom groups already
exist) rather than a separately-managed list of groups: a group is just whatever distinct
`resolutionGroup` values happen to be present across the current tiers, so creating a
"first tier in a brand-new group" just works without a separate "create group" step
anywhere. SD/720p/1080p/2160p always sort first in that fixed order when present; any
custom group name sorts after, alphabetically.

The Up/Down buttons on each row move a tier's *global* rank by one — swapping `position`
with whichever tier is immediately better/worse in the full flat list, regardless of
which resolution group that neighbor happens to display under. Rank has to be global
(it's what Cutoff Unmet compares against across every tier, not just within one
resolution), even though the page presents tiers grouped visually — a tier can visibly
jump from one accordion group into another when moved past a boundary, which is correct
given what rank actually means, if not the very first thing a "move up" button suggests.

### Verification

Checked directly against `server/lib/quality.js` and `queue-sim.js` (requiring them
against a real scratch database, no HTTP layer needed for this part): seeded state
matches the 11-tier default; reordering a tier via a raw `position` update immediately
changes `getQualityOrder()`'s result and flips `isBelowCutoff()` comparisons that depend
on it; deleting every tier degrades to the "Unknown"/unranked fallback everywhere instead
of throwing (see Degenerate case above). Also checked the full CRUD surface end-to-end
over real HTTP (add, patch values, patch position, delete) against a running server, and
confirmed `generateReleases()` picks up a freshly-added custom tier without error.

On the frontend: loaded `settings-quality.html` in the same per-page-subprocess jsdom
harness the rest of this project uses (see [Code Structure](Code-Structure)), confirmed the 11 seeded
tiers render into the correct 4 accordion groups with 11 mounted sliders and populated
target-size readouts, then exercised Remove and a rank reorder through real simulated
clicks — each one a real network round trip, with the reorder specifically confirmed to
have actually persisted via a fresh `GET` afterward rather than just updating the DOM.

The Add Quality modal was checked separately: clicking the button opens the modal without
adding anything; confirming with an empty name is rejected inline and adds nothing;
confirming with a name that already exists is rejected inline and a follow-up `GET`
confirms only the one original tier is still present; and a real add ("WEBRip-1080p" in
group "1080p") closes the modal and a follow-up `GET` confirms the new row exists with the
1080p group's starting defaults (`minMBPerMin: 15, preferredMBPerMin: 170,
maxMBPerMin: 230`), not the old flat 10/100/150. The full 28-page regression suite was
re-run against both a scratch copy and the real project files directly and passed 28/28
both times.


---

[← Back to Home](Home)
