# Edit Series Modal

## Edit Series modal

The series detail page's "Edit" button used to do nothing. It now opens a modal matching
real Sonarr's own "Edit Series" dialog: Monitored, Monitor New Seasons, Use Season
Folder, Quality Profile, Series Type, Path, and Tags, plus a Delete button.

- **New `series` columns** (all added via the same `ALTER TABLE`-if-missing migration
  pattern the rest of the schema uses): `monitor_new_seasons` (`all` / `future` / `none`,
  default `all`), `season_folder` (boolean, default true), `quality_profile` (a name
  string, not a foreign key — see below), `series_type` (`anime` / `standard` / `daily`,
  default `anime`), `path` (nullable text).
- **Quality Profile** is populated from the real `GET /api/settings-items/profiles` list
  (the same data the Settings > Profiles page manages) rather than a hardcoded option
  set — the field stores the profile's `name` directly, the same simple string-not-id
  approach `path` already uses elsewhere in this schema, rather than introducing this
  project's first real foreign key.
- **Path is read-only** — a plain, full-width display of the real `series.path`, not an
  input. This used to be an editable text field plus a folder-browse button (reusing the
  same File Browser modal Settings > Media Management's "Add Root Folder" flow uses), but
  `series.path` itself was never actually set anywhere until someone opened this modal and
  typed/saved one by hand — a freshly-added series just showed a client-side-only
  `/mnt/anime/<title>` guess that looked real but wasn't persisted, and had no
  relationship to where a series' files might already be sitting on a real root folder.
  Two things set it now, both server-side: `defaultSeriesPathFor()` in `routes/series.js`
  assigns a real path immediately at add time, built from whichever root folder is first
  in Settings > Media Management's list plus the sanitized title (`null` if no root
  folder is configured yet — shown as "Not set yet…" rather than a fabricated guess); and
  `scanExistingFilesForSeries()` in `routes/episodes.js` (see
  [Root Folders and Library Import](Root-Folders-and-Library-Import)) overwrites it with
  whatever real folder it actually finds on disk, since that's authoritative over the
  add-time guess. `PATCH /api/series/:id` no longer accepts a `path` field at all — with
  nothing left to submit by hand, there's nothing for the client to send.
- **Tags** are managed through the new `series_tags` join table (see
  [Persistence and Logging](Persistence-and-Logging)):
  selected tags render as removable chips (reusing the `.tag-chip` styling and color
  handling from the Tags settings page), and a "+ Add tag…" dropdown offers whatever
  tags aren't already selected. Nothing is written until Save — chip add/remove only
  touches an in-memory selection, which then goes out as a single `tagIds` array in the
  PATCH body.
- **Save** sends every editable field (`monitored`, `monitorNewSeasons`, `seasonFolder`,
  `qualityProfile`, `seriesType`, `tagIds` — not `path`, see above) in one
  `PATCH /api/series/:id` call
  and updates the in-memory series object from the response on success — including
  syncing the page header's own separate Monitored toggle, since both controls read and
  write the same field (matching real Sonarr's own UI, which also exposes Monitored in
  two places).
- **Delete**, whether clicked from the page header or from inside the Edit modal, opens
  the same confirmation modal and goes through the same `DELETE /api/series/:id` call —
  there was already a delete flow on this page, so the modal's Delete button just closes
  itself and hands off to it rather than duplicating the confirmation/request logic.
- Verified end-to-end against a real running server (not mocks, since every endpoint
  involved — profiles, tags, series PATCH — already exists for real): pre-filled values
  match a seeded series including its real profile name and tag chips, every editable
  field change including a tag removed/added persists correctly through a fresh
  `GET /api/series`, tag usage counts update after save, Path reflects the real
  `series.path` from the server rather than anything typed in the modal, and both Delete
  entry points land on the same confirmation modal.


---

[← Back to Home](Home)
