// Shared by every page that renders a TVDB-sourced air date (series.html's
// episode list, and now Wanted > Missing/Cutoff Unmet, which show the same
// bare ISO dates for the exact same reason). TVDB gives back dates as plain
// "YYYY-MM-DD" strings; parsed as a local calendar date rather than through
// `new Date(iso)` directly, since the latter treats a date-only ISO string as
// UTC midnight and can print as the previous day in timezones west of UTC.
function formatAirDate(iso) {
  if (!iso) return 'TBA';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return iso; // not the shape we expect — show it as-is rather than guess
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// Shared by Activity > History and Activity > Blocklist, both of which show
// "N minutes/hours/days ago" for a SQLite `datetime('now')` timestamp.
// SQLite's format is UTC with a space instead of "T" ("2026-08-04 09:02:37")
// — normalized to a real ISO string before handing it to Date so this
// doesn't misparse depending on the browser.
function timeAgo(sqliteTimestamp) {
  const d = new Date(sqliteTimestamp.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return sqliteTimestamp;
  const diffMs = Date.now() - d.getTime();
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export { formatAirDate, timeAgo };
