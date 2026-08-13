# Calendar

## Calendar

A real month-grid calendar (`public/calendar.html`) of episode air dates — previously
just an inert sidebar link with no page behind it at all.

- Backed by `GET /api/calendar?start=YYYY-MM-DD&end=YYYY-MM-DD` in `server.js`, which
  reads straight from the `episodes` table (the same cache the series detail page fills
  in on first visit — see [Persistence and Logging](Persistence-and-Logging) /
  [Metadata Search](Metadata-Search)) —
  there's no separate calendar data source. Omitting `start`/`end` defaults to the
  current calendar month. Returns `{ start, end, episodes, uncachedSeriesCount }`, where
  each episode carries its series id/title/poster plus season/episode number and title,
  and `uncachedSeriesCount` is how many series in the Library have no cached episodes at
  all (as opposed to just none falling in the requested range).
- **This means the calendar is only as complete as the episode cache is.** A series
  whose detail page has never been opened has no cached episodes yet, so it contributes
  nothing to the calendar either — a deliberate scope decision (you picked "real data"
  over "real data + auto-warm the whole Library on every Calendar visit" when this was
  built), not a bug. `calendar.html` shows a note naming how many Library series haven't
  loaded their episodes yet whenever that count is above zero, so an emptier-than-
  expected calendar explains itself instead of just looking broken.
- The page itself (`initCalendar()` in `app.js`) renders a fixed 6-week (42-cell) grid
  so the layout doesn't reflow month to month, highlights today's date, and caps each
  day at 3 episode chips with a "+N more" overflow indicator for busy days. Each chip
  links to `series.html?id=...` for that episode's series. Season 0 (TVDB's convention
  for specials) renders as "Special N" instead of "S00E0N". Prev/Next/Today buttons
  re-fetch `/api/calendar` for the newly-selected month; nothing is fetched or cached
  client-side beyond the currently-visible month.
- Verified against seeded episode rows with known air dates spanning three months (a
  day with 5 stacked episodes to check the 3-chip cap and "+2 more", a specials episode
  for the Special-N label, one in the next month, one in a month with nothing at all) —
  correct day-cell placement, today-highlighting, month navigation in both directions,
  the uncached-series count/note, and episode-chip links all checked out.


---

[← Back to Home](Home)
