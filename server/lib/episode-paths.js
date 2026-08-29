const path = require('path');
const db = require('../db');
const { applyFormat, sanitizeForPath } = require('./naming-format');

// ---------------------------------------------------------------------------
// Builds the real on-disk file path a real, imported episode should live
// at. Used by server/lib/media-import.js (a real hardlink/copy of a just-
// finished real qBittorrent download into the Library) and, as a last-
// resort fallback, by server/routes/queue.js when that real import
// couldn't reach the file at all (e.g. no Remote Path Mapping configured
// across two separate machines) but the download itself genuinely
// completed — never for anything simulated; there's no fake pipeline left
// in this app for it to serve.
//
// The naming FORMAT itself now comes from Settings > Media Management's
// real, saved values (the app_settings table, section 'media-management')
// run through server/lib/naming-format.js's token engine, instead of one
// pattern hardcoded here that ignored whatever was configured — that's also
// what server/routes/episodes.js's manual "Rename Files" preview/execute
// endpoints reuse, so a rename you trigger by hand computes the exact same
// name this automatic path would have used.
// ---------------------------------------------------------------------------

// Mirrors frontend/pages/settings-media-management/MediaManagementPage.jsx's
// own DEFAULTS — used whenever nothing's been saved yet (fresh install), so
// this never breaks on a missing/empty settings row.
//
// setPermissionsToggle/mm-10/mm-11 (Set Permissions, Folder Chmod, File
// Chmod) have been in that form since the original HTML port, but were
// missing from this mirror — nothing on the backend ever actually read
// them, so the toggle sat in Settings > Media Management doing nothing.
// chownUser/chownGroup are new fields added alongside them (see
// server/lib/permissions.js, the module that now actually reads all five of
// these and applies them after a real import or manual Rename Files).
const DEFAULT_SETTINGS = {
  renameEpisodesToggle: true,
  'mm-1': '{Series Title} - S{season:00}E{episode:00} - {Episode Title} [{Quality Full}]',
  'mm-2': '{Series Title} - {absolute:000} - {Episode Title} [{Quality Full}][{MediaInfo VideoBitDepth}bit]',
  'mm-3': '{Series Title} ({Series Year})',
  'mm-4': 'Season {season:00}',
  setPermissionsToggle: false,
  'mm-10': '755',
  'mm-11': '644',
  chownUser: '',
  chownGroup: '',
};

async function getMediaManagementSettings() {
  const row = await db.prepare("SELECT data FROM app_settings WHERE section = 'media-management'").get();
  if (!row) return { ...DEFAULT_SETTINGS };
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(row.data) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// series.meta is a free-text display string like "2016 · Drama, Fantasy,
// Suspense · TV · 26 min eps" (see routes/series.js's seed data and the Add
// Series flow) — there's no dedicated year column, so {Series Year} is the
// same best-effort text-parse the rest of this app already does for
// display purposes (see SeriesPage.jsx's SHORT_AIR_STATUS shortening).
function seriesYearFromMeta(meta) {
  const m = /^\s*(\d{4})/.exec(meta || '');
  return m ? Number(m[1]) : null;
}

// Absolute numbering (the Anime format's {absolute} token) counts real
// episodes across every non-special season in order — TVDB doesn't hand
// this app a ready-made absolute number, so it's derived the same
// best-effort way real fansub releases usually number things themselves:
// this episode's 1-based position among every season > 0 episode for the
// series, ordered by season then episode number. Specials are excluded on
// purpose — episodeFileNameFor below always uses the Standard format for
// them regardless of series type, since absolute numbering doesn't apply to
// Specials even for an anime-type series (same convention real Sonarr
// follows).
async function computeAbsoluteEpisodeNumber(seriesId, seasonNumber, num) {
  if (!seasonNumber) return null;
  const rows = await db.prepare(
    'SELECT season_number, num FROM episodes WHERE series_id = ? AND season_number > 0 ORDER BY season_number ASC, num ASC'
  ).all(seriesId);
  const idx = rows.findIndex((r) => r.season_number === seasonNumber && r.num === num);
  return idx === -1 ? null : idx + 1;
}

// Season 0 always renders as "Specials" regardless of the configured Season
// Folder Format — matches every other Specials convention already
// hardcoded elsewhere in this app (routes/episodes.js's segmentLabel,
// routes/releases.js's release-title builder), and the real folder-name
// scanner (media-files.js's seasonNumberFromFolderName) already tolerates
// either "Season 0" or a bare numeric mismatch either way, so this doesn't
// need to match any particular padding style to still be found again later.
function seasonFolderNameFor(seasonNumber, settings) {
  if (seasonNumber === 0) return 'Specials';
  return applyFormat(settings['mm-4'], { season: seasonNumber }) || `Season ${seasonNumber}`;
}

function seriesFolderNameFor(series, settings) {
  return applyFormat(settings['mm-3'], {
    'Series Title': series.title, 'Series Year': seriesYearFromMeta(series.meta),
  }) || sanitizeForPath(series.title) || 'Unknown Series';
}

// Builds the real episode filename (no directory, no extension) for one
// episode, honoring Settings > Media Management's Standard vs. Anime format
// based on the series' own Series Type (see the Edit Series modal) — except
// Specials, which always use the Standard (season/episode) format even for
// an anime-type series, since absolute numbering doesn't apply to them.
// `opts.videoBitDepth` — a real ffprobed value, or omitted when it isn't
// known — only matters for the Anime format's own
// [{MediaInfo VideoBitDepth}bit] segment; omitted drops that whole bracket
// rather than rendering the broken literal "[bit]" (see naming-format.js).
async function episodeFileNameFor(series, episode, quality, settings, opts = {}) {
  const seasonNumber = episode.seasonNumber ?? episode.season_number ?? 0;
  const num = episode.num;
  // Accepts either a raw `series` table row (series_type, snake_case — what
  // every server-side caller actually has on hand) or the frontend's
  // camelCase-mapped shape (seriesType, see routes/series.js's rowToSeries)
  // — a caller passing the raw row previously always fell through to
  // undefined === 'anime' (false), silently forcing Standard format for
  // every series regardless of its real Series Type. Confirmed live: this
  // affected every real import and every manual Rename Files run, not just
  // an edge case — episodeFileNameFor had never actually selected the Anime
  // format for anyone.
  const seriesType = series.seriesType ?? series.series_type;
  const useAnimeFormat = seriesType === 'anime' && seasonNumber !== 0;
  const format = useAnimeFormat ? settings['mm-2'] : settings['mm-1'];
  const ctx = {
    'Series Title': series.title,
    'Series Year': seriesYearFromMeta(series.meta),
    'Episode Title': episode.title,
    'Quality Full': quality || null,
    season: seasonNumber,
    episode: num,
    absolute: await computeAbsoluteEpisodeNumber(series.id, seasonNumber, num),
    'MediaInfo VideoBitDepth': opts.videoBitDepth ?? null,
  };
  const name = applyFormat(format, ctx);
  if (name) return name;
  // Every token failed to resolve at once (e.g. a completely blank format
  // string saved by hand) — same plain "Title - SxxExx" shape this function
  // always produced before the real naming engine existed, so a badly
  // configured format degrades instead of producing an empty filename.
  const code = `S${String(seasonNumber).padStart(2, '0')}E${String(num).padStart(2, '0')}`;
  return `${sanitizeForPath(series.title) || 'Unknown Series'} - ${code}`;
}

// `opts.sourcePath` — the real file this is being imported/renamed from, if
// there is one (a just-finished real download, or an already-downloaded
// episode being manually renamed). Its extension is preserved instead of
// always assuming .mkv, and — when Rename Episodes is turned off in
// Settings — its original basename is kept as-is rather than computed from
// the format at all (matches real Sonarr: turning renaming off still
// organizes files into the right folders, it just stops relabeling the
// filename itself).
async function buildEpisodeFilePath(series, episode, quality, opts = {}) {
  const settings = await getMediaManagementSettings();
  const seasonNumber = episode.seasonNumber ?? episode.season_number ?? 0;
  const seasonFolder = seasonFolderNameFor(seasonNumber, settings);
  const ext = opts.sourcePath ? (path.extname(opts.sourcePath) || '.mkv') : '.mkv';

  const fileName = (!settings.renameEpisodesToggle && opts.sourcePath)
    ? sanitizeForPath(path.basename(opts.sourcePath))
    : `${await episodeFileNameFor(series, episode, quality, settings, opts)}${ext}`;

  // series.path — a real, already-known series folder, either matched
  // automatically by folder name or set by hand in Edit Series' Path field
  // (see routes/series.js) — is always authoritative over a freshly-
  // formatted guess: overriding it here would silently undo the manual-
  // override feature for exactly the series that needed it most (an
  // on-disk folder name that doesn't match the title at all). Only
  // fabricated when no path is known yet at all.
  const root = series.path || path.join('/mnt/anime', seriesFolderNameFor(series, settings));
  return path.join(root, seasonFolder, fileName);
}

module.exports = {
  buildEpisodeFilePath, sanitizeForPath, episodeFileNameFor, getMediaManagementSettings,
  seasonFolderNameFor, seriesFolderNameFor, seriesYearFromMeta, computeAbsoluteEpisodeNumber,
};
