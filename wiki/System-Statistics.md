# System Statistics

**System › Statistics** (`system-statistics.html`) shows numbers and charts about
the library and what Kitsune has been doing. It's admin-only, like the rest of System.

## What's on the page

| Section | Source |
|---|---|
| Summary tiles: series, episodes on disk, missing, library size, total runtime, average episode size | `series` + `episodes` tables |
| Library growth: episodes imported per month (12 months) or per year (All time), with library size as a line | `history` (`imported` rows) |
| Disk usage per root folder, split into library media vs. other files on the volume, plus a months-until-full estimate | `statfs` on each root folder, episode `size_bytes` by path prefix, imports from the last 90 days |
| App data: database file (+ WAL) and backups folder | file sizes under `data/` |
| Quality: episodes on disk by quality | `episodes.quality` |
| Series status ring: airing / finished / upcoming | `series.status`, `series.air_status` |
| Media formats: video codec, audio (Japanese only / dual audio), default subtitle format | ffprobe's `episodes.media_streams` |
| Series by premiere year | the year at the start of `series.meta` |
| Imports by indexer (last 26 weeks) | `history.indexer` |
| Download activity heatmap and grabbed / imported / failed totals (last 26 weeks) | `history` |
| Largest series by size on disk | `episodes.size_bytes` |
| Top release groups | the release title each on-disk episode was last imported from |

## How it's computed

`GET /api/system/statistics` (`server/routes/system-statistics.js`) pulls the
series, episodes and history rows and aggregates them in JS, so the same code
works on SQLite and Postgres. The result is cached for 60 seconds; the page's
**Recalculate** button sends `?fresh=1` to skip the cache.

Some details worth knowing:

- **Missing** uses the same definition as Wanted › Missing: aired, monitored,
  not downloaded, with specials excluded when a series has Ignore Specials on.
- **Total runtime** uses the episode length from a series' metadata
  (`24 min eps`), and falls back to 24 minutes when it isn't known.
- **Library size over time** is worked backwards from today's size, minus what
  was imported after each point. It only goes back as far as History Retention
  keeps history; older points flatten toward today's value once history is pruned.
- **Release groups** come from history, not file names, because files are
  renamed on import. Episodes with no import history fall back to the file name, then count as "Group unknown".
- **Genres** aren't shown because most real metadata only stores the year and
  format (`2023 · TV`), so the chart would be mostly empty. Imports by indexer
  takes that spot.
- Times are bucketed in UTC, matching how `history.created_at` is stored.

## Charts and theming

The charts are plain divs, CSS `conic-gradient` (the status ring) and one SVG
path (the size line), with no chart library. Colors come from theme tokens:
the accent is always the first series, then `--chart-2`, `--chart-3`,
`--chart-4`, with `--chart-muted` for Other/Unknown. Those tokens are defined in
`styles.css`, with darker values for the Light and Paper themes, so every theme
and custom accent color applies automatically.

---

[← Back to Home](Home)
