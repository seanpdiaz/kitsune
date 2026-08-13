# Sidebar Navigation

## Sidebar navigation: Library, Calendar, Activity, and Wanted are real links

The top-level sidebar items used to split into two inconsistent behaviors: Library
(`index.html`) was already a real link — clicking it navigates there, and whichever
sub-page you're actually on gets `active`/`open` baked into that page's own HTML.
Calendar, Activity, and Wanted, on the other hand, had `href="#"` and only existed as
JS-driven accordion toggles (`.nav-item.nav-toggle` in `app.js`) — clicking them
`preventDefault()`'d the click and just expanded/collapsed their sub-menu, never
actually taking you anywhere. Calendar didn't even have a sub-menu to expand, so it was
just inert.

- **Activity** now links to `activity-queue.html` and **Wanted** now links to
  `wanted-missing.html` — the same pattern Library already used, dropped straight in:
  `class="nav-item nav-toggle"` became `class="nav-item"`, `href="#"` became the real
  target page, on all 27 pages. Settings and System keep the old JS-toggle behavior
  unchanged (`nav-toggle` still on their `<a>` tags) since neither has an obvious single
  "default" page the way Activity has Queue and Wanted has Missing.
- **Calendar** got the same treatment — `href="#"` became `href="calendar.html"` on all
  27 existing pages, and the new page itself (see [Calendar](Calendar)) is what those links
  actually point to now.
- Since Activity/Wanted no longer carry the `nav-toggle` class, `app.js`'s accordion
  click handler (`document.querySelectorAll('.nav-item.nav-toggle')`) no longer touches
  them at all — no code changes needed there beyond the class/href edits themselves.
  Their sub-menus (Queue/History/Blocklist, Missing/Cutoff Unmet) still show as
  expanded/highlighted on their own pages purely from each page's own hardcoded
  `nav-sub open` / `class="active"` markup, exactly like Library's always has.
- This was a same-string-everywhere sweep across all 27 `public/*.html` files (done via
  a small Node script doing literal multi-line string replacement, not sed/regex, since
  the inactive-state markup for Activity/Wanted/Settings/System's `<a>` tags is
  byte-identical apart from the icon path that follows it — a plain single-line match
  would've hit the wrong nav item). Verified by grep counts across all 27 files (54
  `nav-item nav-toggle` occurrences left, all Settings/System; 0 leftover `href="#"` on
  any Activity/Wanted block) plus a jsdom pass confirming the accordion selector no
  longer matches Activity/Wanted on a loaded page.


---

[← Back to Home](Home)
