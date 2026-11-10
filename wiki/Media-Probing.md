# Media probing (audio/video/subtitle info)

Kitsune reads each episode file's streams with **ffprobe** (part of ffmpeg, see `server/lib/ffprobe.js`) and stores the result in `episodes.media_streams`. That data backs Media info, the Audio column, and Edit tracks.

## When files are probed

1. **At import.** Every import path probes the file it imports: the automatic import of a finished download (`routes/queue.js`), Manual Import, Library Import / Rescan for local files, and the scan when a series is added.
2. **Backfill** (`server/lib/media-probe-backfill.js`). A probe at import can come back empty: ffprobe wasn't installed yet, the file was still being written, a mount was briefly unreachable, or the episode was marked downloaded before probing existed. Nothing used to retry those, and Edit tracks said "No probed .mkv files found in this series yet." Now any downloaded episode with a path and no `media_streams` gets probed again:
   - about 20 seconds after startup, then every 6 hours, across the whole library;
   - when a series page loads and finds such files (`POST /api/series/:id/probe-files`, once per visit), after which the page reloads its episode data;
   - when Edit tracks runs, for the series or for one episode, before it decides there is nothing to edit.

   Files are probed one at a time. A file that's missing or still fails is left alone and tried again next time.

## Diagnosing

- **System > Status** shows whether **ffprobe** and **mkvpropedit** are installed, and how many files are still missing media info. If ffprobe is missing, a warning explains what stops working.
- **Rescan for local files** now says when it linked files but couldn't read their audio/video info, either because ffprobe is missing or because some files failed.
- **Edit tracks** explains why there's nothing to edit: no downloaded files, no .mkv files, ffprobe not installed, or files that couldn't be read (with how many weren't found on disk).
- Each failed probe logs an `Ffprobe` warning with the path and the error. See System > Logs.

ffprobe's availability is checked once per process, so after installing ffmpeg, restart Kitsune.
