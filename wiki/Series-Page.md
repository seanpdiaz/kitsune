# Series page

The series detail page (`series.html`, `frontend/pages/series/SeriesPage.jsx`) was redesigned in November 2026. The old header card had a long row of same-weight buttons and felt scattered. The new one has a single primary action, and everything else is grouped or tucked into menus.

## Header

- **Backdrop.** A 340 px band behind the top of the page shows the series' `fanart` image. When there is no fanart, the poster is scaled up, blurred and darkened to fill the band, so the layout never changes. A scrim fades the band into the page background.
- **Back link** ("‹ Library") sits top-left on the backdrop. It replaces the static link that `series.html` still contains, which is now hidden by CSS on this page.
- **Poster** overlaps the bottom of the backdrop on the left.
- To the right of the poster, top to bottom:
  1. Title, then up to two alternate titles with "+N more". The full list is the line's tooltip.
  2. Synopsis, clamped to 3 lines, with More/Less when it is long.
  3. Chips: status, each part of `meta` (year, genres, format, runtime), quality profile, size on disk, next airing.
  4. Progress bar and the "21 / 28 episodes" count.
  5. Actions: **Search all** (the only accent button), Grab best match, Manual import, Edit, and a bookmark toggle for Monitored (disabled when the series has ended).
  6. Footer: series path, then MAL / AniList / AniDB / TVDB / SeaDex links.

## Series "…" menu (top-right of the backdrop)

`SeriesMenu` in `frontend/pages/series/SeriesHeaderParts.jsx`.

- **Artwork and titles:** Change poster…, Change background…, Edit titles and sort name…
- **Library:** Refresh episodes, Rescan for local files, Rename files…, Edit tracks… (whole series)
- **Delete series…**

Refresh, Rescan and Rename are the least-used actions. Imports already rename files to the naming format, so Rename files is only for files that predate it (Library Import) or after the format changes.

### Change poster / Change background

`ArtworkModal`. The top of the dialog shows TheTVDB's posters or backgrounds for the series (`GET /api/series/:id/artwork?kind=poster|background`): English first, then images with no text, then other languages, each sorted by TheTVDB score. Click one to choose it, or paste any image URL instead; there's a live preview either way. For the background, **Remove background** clears it, and the page goes back to the blurred poster. Saving sends `PATCH /api/series/:id` with `{ poster }` or `{ fanart }`. The server accepts only http(s) URLs, or an empty value to clear.

### Automatic background from TheTVDB

`server/lib/series-artwork.js`. When a series has no background and nobody has set one, Kitsune saves TheTVDB's best background (same order as above). This happens:

- when a series' episodes are first fetched, which covers both adding a series and the first time its page opens;
- on every episode refresh, both Refresh episodes and the scheduled Refresh Series task, so series added before this existed fill in too.

`series.fanart_source` records who set the background. NULL means nobody yet, so it's eligible to be filled and is retried on each refresh until TheTVDB has one. `tvdb` means it was filled automatically. `user` means it was set or removed in Change background, and it's never touched automatically again. The series page checks back once, shortly after load, so a newly filled background shows up without a reload.

### Edit titles and sort name

`TitlesModal`. It has fields for the display title (the same field as Edit Series) and an optional sort title, and shows the alternate titles read-only. Saving sends `PATCH /api/series/:id` with `{ title?, sortTitle }`. The Library's Title sort (and its tie-break in the Next airing sort) uses `sortTitle` when it is set.

## Data

New `series` columns, added by the startup migration in `server/routes/series.js`:

| Column | API field | Meaning |
|---|---|---|
| `fanart` | `fanart` | Backdrop image URL. NULL means use the blurred poster. |
| `sort_title` | `sortTitle` | Library sort key. NULL means sort by `title`. |
| `fanart_source` | `fanartSource` | Who set `fanart`: NULL (nobody yet, so auto-fill), `tvdb`, or `user`. |

`GET /api/series` also returns `altTitles`, which is the parsed `alt_titles` JSON array.

## Layout and scrolling

The hero is tall, so the page no longer pins the header and scrolls only the episode list. `#seriesRoot` is now the single scroll container, and the season tabs row sticks to its top once the hero scrolls away. The episode menu's flip-upward check (`findScrollParent`) finds `#seriesRoot` automatically. At 860 px and below, the page scrolls normally and the hero stacks vertically.

## Episode rows

Every real episode row ends with **Search episode** (the interactive release list), **Grab best match** (an automatic pick), and a **"…"** menu. On an Available episode, the two search buttons look for an upgrade, and the server skips the grab, with a reason, when nothing better fits the profile. A downloading row shows **Cancel download** and the menu.

Row menu:

- With a file: Edit tracks… (probed .mkv only), Rename file…, Media info, Manual import…, Delete file…
- Without a file: Manual import…

**Rename file…** opens the Rename Files dialog filtered to that one episode (`onlyEpisodeId`). **Manual import…** opens Wanted > Manual Import pinned to the series.

## Mockup

The design was agreed on a design canvas. It's linked from the Claude Project doc "Series page redesign".
