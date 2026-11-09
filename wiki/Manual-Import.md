# Manual Import

**Wanted > Manual Import** (`wanted-manual-import.html`) is the way to import files that
Kitsune couldn't import on its own. Point it at a folder, check which series, season and
episode each video file is, fix anything wrong, and import.

Typical reasons to use it:

- A finished download whose files couldn't be matched to an episode, or whose import keeps
  failing in Activity > Queue (shown as **Import failed**).
- A release you grabbed outside Kitsune.
- A folder of files copied over from another machine or drive.

## Getting there

| From | What it does |
|---|---|
| Wanted > **Manual Import** tab | Type a folder path, or use **Browse…** to pick one on the server. The last few folders you scanned are kept for quick access. |
| Activity > Queue, the **Manual import** button on any row (amber while its import is failing) | Asks the download client for that torrent's files and scans exactly those, with every file assumed to be that row's series. |
| Series page, **Manual import** button | Opens the page with every file assumed to be that series. |

You can also link straight to it: `?path=/downloads/x` scans a folder on load,
`?seriesId=N` pins every file to a series, and `?queueId=N` scans a queue item.

## The file list

Each video file in the folder and its subfolders (sample files skipped) gets a row with
Kitsune's best guess for:

- **Series**: in this order, the file already sits in a series' own folder; or the filename,
  then its parent folders, match a series title or any of its alternate titles (AniList
  synonyms included). A batch folder named `[Judas] Sousou no Frieren (Batch) [1080p]` is
  enough for the files inside it.
- **Season / episode**: the same rules Library Import uses: `SxxExx` tags, `Show - 05`,
  `05 - Title`, a bare `03.mkv` inside a `Season 2` folder, and absolute numbering
  (`Season 2/031.mkv` for a 28-episode season 1) as a fallback.
- **Quality**: from the filename, or from the parent folder when the filename has no
  resolution tag. At import time the real video is checked with ffprobe and its real
  resolution wins, unless you picked the quality yourself.

Rows Kitsune is confident about start ticked. Anything it couldn't work out says why in the
status column (**Needs series** / **Needs episode**), and you choose it from the dropdowns.
**Set series for selected** applies one series to every ticked row at once.

The episode picker lets you tick more than one episode for a single file (a double-length
episode, or an `01-02` release). The file is named after the first one, and every ticked
episode points at it.

Status meanings:

| Status | Meaning |
|---|---|
| Ready | Will import. |
| Replaces file | The episode already has a file. After importing, the old file is removed from the series folder, as an upgrade would. |
| Duplicate episode | Two ticked files are assigned to the same episode. Import is disabled until you fix it. |
| Already in Library | This file *is* the episode's Library file already. Nothing to do. |
| Imported / Failed | After an import. Hover **Failed** for the reason. |

## Import mode

- **Hardlink / Copy** (default): the original stays where it is. Same filesystem means a
  hardlink (no extra space, the torrent keeps seeding). Otherwise it's a full copy, checked
  for size before it counts.
- **Move**: the file goes into the Library and the original is removed. A plain rename on the
  same filesystem, otherwise copy, verify, then delete the original.

The mode you last used is remembered in your browser.

## What an import does

Every file goes through the same `importEpisodeFile` path as a finished download
(`server/lib/media-import.js`), so the **naming format, season folders, root-folder mount
check and permissions** in Settings > Media Management all apply. For each file, Kitsune
also does the following:

1. Marks the assigned episodes downloaded, with the real path, size, quality and media
   streams.
2. Removes a replaced episode's old file. That only happens when the old file is inside the
   series' folder, no other episode points at it, and it isn't the file being imported.
3. Writes an **Imported** history row per episode ("Manual import (hardlinked) from …") and
   sends the usual import notification.
4. Drops the queue rows for those episodes that are either from the torrent you came from
   (queue button) or stuck retrying a failed import. Otherwise the queue would keep retrying
   and eventually blocklist a release that's actually been imported. The torrent itself is
   left alone in the download client.

The whole request is checked before anything moves. Missing series or episode, the same
file twice, or the same episode on two files: any of these rejects the request, and nothing
is touched. After that, each file succeeds or fails on its own.

### Safety checks

- A series with no folder yet is refused ("set its Path in Edit Series first") rather than
  importing into a made-up `/mnt/anime/...` location.
- Importing a file onto itself, or onto an existing hardlink of itself, is recognized up
  front. Without this, the "clear the stale destination" step would delete the only copy.
- Scanning `/` is refused. A scan shows at most 500 files and says when there are more.
- Both endpoints need a signed-in session, like every other route that touches real files.

## API

```
GET  /api/manual-import/scan?path=/abs/path[&seriesId=N]
GET  /api/manual-import/scan?queueId=N
  → { path, files: [{ path, relativePath, name, sizeBytes, sizeFormatted, seriesId,
       season, episodeIds, quality, confident, alreadyImported, reason }],
     truncated, totalFound, queue, missing }

POST /api/manual-import
  { mode: 'copy' | 'move', queueHash?,
    items: [{ path, seriesId, episodeIds: [..], quality, qualityLocked }] }
  → { results: [{ path, ok, error?, destPath, method, note, episodes, replaced,
       queueCleared }], imported, failed }
```

`method` is `hardlink`, `copy`, `move`, `in-place` or `already-linked`.

## Files

- `server/routes/manual-import.js`: scan and import.
- `server/lib/media-import.js`: added the `move` mode and the import-onto-itself guards.
- `server/lib/media-files.js`: `guessSeasonEpisode` now reads a bare-number filename
  (`03.mkv`). This also helps Library Import and the queue's automatic import.
- `frontend/pages/wanted-manual-import/`: the page.
- `frontend/pages/activity-queue/QueueList.jsx`, `frontend/pages/series/SeriesPage.jsx`:
  the entry-point buttons.
- `scripts/test-manual-import.js`: end-to-end test (`node scripts/test-manual-import.js`).
  It runs against a temporary copy of the app and its own database, never your real data.

## Not covered yet

- Picking files out of a torrent that's still downloading. The scan lists whatever files are
  on disk at the time.
- Large cross-filesystem copies run inside the import request. The page shows
  **Importing…** until they finish, and there's no per-file progress yet.
