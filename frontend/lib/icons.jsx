// React port of public/js/lib/icons.js's `icons` map. Kept as the exact
// same SVG markup (via dangerouslySetInnerHTML on a `display: contents`
// wrapper, so the wrapper itself never affects layout — every existing CSS
// rule targeting these icons, e.g. `.ep-action svg { width: ... }`, is a
// descendant selector and matches straight through it) rather than
// hand-transcribing each `<path>` into JSX — less error-prone, and it's
// trusted, static, hardcoded markup, not user input, so dangerouslySetInnerHTML
// carries none of the risk the name implies here.
const svgSource = {
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg>',
  alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 9v4M12 17h.01M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 3v12M7 10l5 5 5-5M4 21h16"/></svg>',
  search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>',
  x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  dots: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.4" fill="currentColor" stroke="none"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="6" y="4" width="4" height="16" rx="1"/><rect x="14" y="4" width="4" height="16" rx="1"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"><path d="M6 4l14 8-14 8V4z"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M12 5v14M5 12h14"/></svg>',
  chevronDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M6 9l6 6 6-6"/></svg>',
  arrowUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 19V5M5 12l7-7 7 7"/></svg>',
  arrowDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M12 5v14M5 12l7 7 7-7"/></svg>',
  viewPoster: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>',
  viewTable: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="1.5"/><path d="M3 9h18M3 14h18M9 4v16"/></svg>',
  viewOverview: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="6" height="16" rx="1"/><path d="M12 8h9M12 12h9M12 16h9"/></svg>',
  // Episode row's "..." menu (SeriesPage.jsx) — its one item so far, Media
  // Info. Only needed here: the vanilla public/js/lib/icons.js copy stays
  // as-is, same "only carry what a still-vanilla page actually uses"
  // convention that already dropped the view-toggle icons from that file
  // once Library went fully React (see that file's own comment).
  info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  // Series page header's "Refresh episodes" button (re-fetch episode
  // metadata from TheTVDB in place — see server/routes/episodes.js's
  // refreshEpisodesForSeries) — only needed here, same "only carry what a
  // still-vanilla page actually uses" convention as `info` above.
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 12a9 9 0 0 1-15.3 6.4M3 12a9 9 0 0 1 15.3-6.4M21 4v5h-5M8.5 20v-5h-5"/></svg>',
  // "Grab best match" (SeriesPage.jsx) — a one-click grab that searches and
  // submits the top-ranked release itself rather than opening the picker;
  // a lightning bolt reads as "instant/automatic" next to the plain
  // magnifying-glass Search icon, the same visual shorthand real Sonarr/
  // Radarr use for their own one-click "search and grab" actions.
  zap: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M13 2L4 14h6l-1 8 9-12h-6l1-8z"/></svg>',
  // "Delete file" (EpisodeActionsMenu, SeriesPage.jsx) — removes the media
  // file backing a downloaded episode; only needed here, same "only carry
  // what a still-vanilla page actually uses" convention as `info`/`refresh`
  // above.
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M4 7h16M9 7V4h6v3M6 7l1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13M10 11v6M14 11v6"/></svg>',
  tracks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="4" y1="6" x2="20" y2="6"/><circle cx="9" cy="6" r="2" fill="currentColor" stroke="none"/><line x1="4" y1="12" x2="20" y2="12"/><circle cx="15" cy="12" r="2" fill="currentColor" stroke="none"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="7" cy="18" r="2" fill="currentColor" stroke="none"/></svg>',
};

function Icon({ name }) {
  return <span style={{ display: 'contents' }} dangerouslySetInnerHTML={{ __html: svgSource[name] }} />;
}

// `icons.x`, `icons.check`, etc. — same call shape every existing page
// module already uses (`icons.x` etc.), just yielding a JSX element instead
// of a string, so a page migrating from `${icons.x}` inside a template
// string to `{icons.x}` inside JSX is close to a find-and-replace.
const icons = Object.fromEntries(Object.keys(svgSource).map((name) => [name, <Icon key={name} name={name} />]));

export { icons };
