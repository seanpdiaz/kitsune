# August 2026 Fix Batch

Twelve bugs/small features worked through together, spanning nav, the Series page, Library
Import, Download Clients, Settings > General, and the shared modal component. Grouped below by
area rather than in request order.

## Navigation

### System menu hidden from standard users

`NAV_SECTIONS` in `nav.js` gained an `adminOnly: true` flag on the System section (and on any
individual sub-item that needs it, independently). `visibleSections()` now filters both the
top-level list and each section's `subs` against `isAdmin()` (`currentUser?.role === 'admin'`)
before rendering — a standard user's sidebar simply never gets a System entry, rather than having
one that 403s if clicked. Same mechanism used earlier for the admin-only Users link under
Settings, just generalized from "hide one sub-item" to "hide a whole section or any of its subs."

## Series page

### Rename a series, rename a season

`EditSeriesModal` gained a Title field (first row in the modal, autosaves through the existing
`PATCH /api/series/:id` path). The server-side handler validates non-empty, normalizes and checks
for a collision against every *other* series' title (same `normalizeFolderName` helper the
add-series flow already uses for duplicate detection), and 409s on a clash rather than silently
overwriting one series with another's name.

Season rename reuses `episodes.season_name` — a column that already existed from TVDB data and
that `segmentLabel()` already preferred over the "Season N" fallback when set — rather than adding
a new overrides table. A pencil button next to the segment-tabs strip (hidden for Specials, season
0, and for the one hardcoded Frieren-style single-cour series) opens a small `RenameSeasonModal`;
saving `PUT`s the new name to a new route, `PUT /api/series/:id/seasons/:seasonNumber`
(`server/routes/episodes.js`), which updates `season_name` on every cached episode row for that
season. An empty name clears it back to the "Season N" fallback instead of leaving a stray blank
label.

### Ended/complete series can't stay "Monitored"

If a series' status is `ended` and its downloaded count has caught up to its total episode count,
there's nothing left to monitor for — so the header's Monitored toggle and the modal's Monitored
row both go `disabled` (with an explanatory tooltip/desc) rather than letting you flip a toggle
that has no effect. Computed client-side from data the page already loads
(`series.status === 'ended' && totalCount > 0 && downloadedCount >= totalCount`), no new API.

### Media Info on each episode

Already fully wired up from earlier work (`EpisodeActionsMenu` → `buildMediaInfo` →
`MediaInfoModal` in `SeriesPage.jsx`) — this item turned out to be "confirm it's there," not new
code.

## Library Import

Rows used to show a subfolder's full absolute path (`/Volumes/Anime/A Certain Scientific
Railgun`), which is mostly just repeating the root folder you already picked. Now shows just
`/<series folder name>` (e.g. `/A Certain Scientific Railgun`), with the full path still available
as the row's hover tooltip (`title` attribute) for anyone who wants to double check exactly where
it'll land.

## Download Clients

The Edit (pencil) button for an already-configured client lived inline next to the client's name,
inconsistent with every other settings list in the app (Indexers, Import Lists, Connect all put
Edit in its own trailing column). Moved it into a dedicated grid column between Test and Remove,
matching `ConnectionManager.jsx`'s layout; `.dlclient-header`/`.dlclient-row`'s grid-template-
columns picked up one more `32px` track and the header row one more empty `<span>`.

## Modal formatting

Both the Custom Format and Profile edit modals wrap text one word per line — same root cause in
both, since they're the same shared component (`SimpleList.jsx`'s `EditModal`). A `.modal-box`
(360px) leaves ~324px of content after padding; subtract the fixed 280px `.field-control` and the
form-row's 24px gap and a multi-word label or desc paragraph (Profiles' "Upgrades allowed", either
page's longer desc text) only has ~20px to lay out in. Fixed once, for both pages, by adding the
existing `.modal-box.wide` (620px) class — the same fix already applied to the Edit User modal
earlier for the identical bug.

## Consistent "test succeeded" feedback

`ConnectionManager.jsx` (Indexers/Import Lists/Connect/Download Clients' Test buttons) now flashes
the row green on a successful test, using the same `row-flash-success` CSS animation and
1.6s-timeout-clear pattern already established elsewhere in the app, instead of a separate/no
feedback path. Tracks a `flashId` state set on success in both `handleRowTest` (covers the real
Pushover test and the simulated-test branches alike) and `handleModalTest`.

## Backups you can actually download

`system-backup.html` previously rendered from a synthetic, hardcoded local array — "Backup Now"
added a fake row, and there was never a real file to get back off the server. `server/routes/
backups.js` is new: `POST /api/backups` gzips the live SQLite database (every table this app has)
into `data/backups/`, `GET /api/backups` lists what's actually on disk (filesystem is the only
source of truth, no separate table to drift out of sync), `GET /api/backups/:filename/download`
streams the real gzip with a `Content-Disposition` header, `DELETE` removes a file. `BackupPage.jsx`
was rewritten to match — real fetch on mount, a real Download button (a `<button onClick>` that
navigates the window, not an `<a>`, since `.btn-test`'s base look comes from the plain `button`
element selector). "Restore" stays a visual affordance only; actually restoring live data over a
running app is a separate, riskier feature nobody's asked for.

## SSL certificate/key upload

Settings > General's "Enable SSL" toggle previously had no way to actually supply a certificate.
`server/routes/ssl.js` is new: `POST /api/ssl/cert` and `POST /api/ssl/key` take `{ filename,
contentBase64 }` (base64 JSON, not multipart — consistent with this backend's zero-dependency
philosophy) and write real bytes to fixed paths, `data/ssl/cert.pem` / `data/ssl/key.pem`. The
*original* filename and upload time (the on-disk name is always the same regardless of what the
file was called) live in `app_settings`' generic per-section store under a new `'ssl'` section,
same table `settings-items.js`/`user-prefs.js`/`disk-usage.js` already share. `GET /api/ssl/status`
always trusts real file existence over the saved metadata — if `cert.pem` isn't actually on disk,
it reports "not uploaded" rather than stale metadata. Upload does a light sanity check (does the
decoded text contain `-----BEGIN CERTIFICATE-----` / `PRIVATE KEY-----`?) — enough to catch
"picked the wrong file entirely," not real PEM/X.509 validation. `DELETE` removes the file and
clears the metadata fields.

`GeneralPage.jsx` grew two new fields under the Enable SSL toggle (`.is-collapsed` when SSL's off,
same pattern as the Authentication card's username/password rows) — each is a `SslFileField`:
"Choose File" when nothing's uploaded, or the filename/size/a Remove button once something is.
`FileReader.readAsDataURL` does the base64 conversion client-side.

Scope boundary, same shape as Backup's own: this stores real files and lets you replace/remove
them, but nothing in `server.js` reads `cert.pem`/`key.pem` to actually switch the running server
over to HTTPS — every other toggle on this page (bind address, port, proxy) is equally just a
saved preference with no live effect on this mockup's own server.

## Verification

All twelve exercised end-to-end against a running server (a throwaway `/tmp` copy of the project,
outside the sandbox's FUSE-mounted connected folder — direct SQLite writes and `vite build`'s
`emptyOutDir` both need real filesystem semantics that mount doesn't provide): real `curl` calls
through the SSL upload/status/remove endpoints (including a rejected non-PEM upload and a real
self-signed cert/key pair accepted), a full `npm run build` with the same
temporarily-flip-`emptyOutDir`-then-revert workaround used throughout this project, and confirming
the new SSL UI markup made it into the compiled `settings-general.js` bundle.

---

[← Back to Home](Home)
