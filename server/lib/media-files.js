// ---------------------------------------------------------------------------
// Real media file scanning — the piece Library Import was missing entirely.
// It could tell you a folder's *name* looked like a series and whether that
// name matched something already in the Library, but nothing about what was
// actually inside the folder: how many video files, how big, what container
// format, or which episode each one probably is. This module is that: a
// real recursive walk of a folder's actual video files, plus best-effort
// filename parsing for quality and season/episode number — the same two
// guesses a real release name already carries, just read back out of it
// instead of assumed.
//
// Used by server/routes/root-folders.js (folder-level summary for every
// Library Import row, and the lazy per-file listing when a row is expanded)
// and server/routes/import-files.js (matching real files to real episodes).
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { logWarn } = require('../logger');
const { formatBytes } = require('./fs-helpers');
const { getQualityTiers } = require('./quality');

// The containers real fansub/scene releases actually ship in. Deliberately
// not exhaustive (no .iso/.vob disc images, no subtitle-only .ass/.srt) —
// this is about finding episode video files, not every file a release
// archive might contain.
const VIDEO_EXTENSIONS = new Set(['.mkv', '.mp4', '.avi', '.mov', '.wmv', '.ts', '.m2ts', '.flv', '.webm']);

// A real release folder often ships a tiny low-quality preview clip
// alongside the actual episode ("Series - 05 [1080p]-sample.mkv") —
// counting that as its own "episode" would both inflate the file count and
// occasionally win an episode-number match ahead of the real file. Real
// Sonarr/Radarr both skip these; so does this.
function isSampleFile(name) {
  return /\bsample\b/i.test(name);
}

function isVideoFile(name) {
  return VIDEO_EXTENSIONS.has(path.extname(name).toLowerCase()) && !isSampleFile(name);
}

// A folder named "Season 2", "S02", etc. one level below wherever the walk
// started — used as a season hint for files inside it that don't carry
// their own SxxExx tag, which covers a very common anime release layout:
// split into per-season folders, with files inside just numbered 01, 02, 03…
function seasonNumberFromFolderName(name) {
  const m = /^(?:season\s*|s)(\d{1,2})$/i.exec(name.trim());
  return m ? Number(m[1]) : null;
}

// Recursively walks `dirPath`, returning every real video file found —
// skipping samples, hidden files/folders, and anything not a recognized
// video container — with its real size and a season hint inherited from
// whichever ancestor folder (relative to the original `dirPath`) looked
// like a season folder, if any.
//
// Async (fs.promises, not the *Sync variants this used to use) on purpose —
// readdirSync/statSync block Node's single-threaded event loop for however
// long the real disk (or network mount — root folders regularly live on
// something like /Volumes/Media) takes to answer, freezing every other
// request the server is handling at the same time, not just this walk.
// Confirmed real case: adding a series with existing local episode files
// froze the whole UI while the add-time auto-scan walked its folder (see
// scanExistingFilesForSeries in routes/episodes.js). Awaiting fs.promises
// calls instead lets the event loop keep serving other requests while the
// real I/O happens off the main thread — the walk itself takes the same
// wall-clock time either way, only how much else the server can do
// meanwhile changes.
async function walkVideoFiles(dirPath, relativeDir = '', seasonHint = null) {
  let entries;
  try {
    entries = await fs.promises.readdir(dirPath, { withFileTypes: true });
  } catch (err) {
    logWarn('MediaFiles', `Could not read "${dirPath}": ${err.code || err.message}`);
    return [];
  }

  let files = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const hint = seasonNumberFromFolderName(entry.name);
      files = files.concat(
        await walkVideoFiles(full, path.join(relativeDir, entry.name), hint != null ? hint : seasonHint)
      );
    } else if (entry.isFile() && isVideoFile(entry.name)) {
      let sizeBytes = null;
      try {
        sizeBytes = (await fs.promises.stat(full)).size;
      } catch (err) {
        logWarn('MediaFiles', `Could not stat "${full}": ${err.code || err.message}`);
        continue;
      }
      files.push({
        name: entry.name,
        relativePath: path.join(relativeDir, entry.name),
        sizeBytes,
        ext: path.extname(entry.name).toLowerCase(),
        seasonHint,
      });
    }
    // Symlinks intentionally neither followed nor counted — same convention
    // as the disk-usage walker (see server/lib/disk-usage.js).
  }
  return files;
}

// Folder-level totals for Library Import's row summary — real file count,
// real total size, and which container formats are actually present.
function summarizeFiles(files) {
  const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
  const extensions = [...new Set(files.map((f) => f.ext))].sort();
  return {
    fileCount: files.length,
    totalBytes,
    totalFormatted: files.length ? formatBytes(totalBytes) : '—',
    extensions,
  };
}

function guessResolutionGroup(name) {
  if (/\b(2160p|4k|uhd)\b/i.test(name)) return '2160p';
  if (/\b1080p\b/i.test(name)) return '1080p';
  if (/\b720p\b/i.test(name)) return '720p';
  if (/\b480p\b/i.test(name)) return 'SD';
  return null;
}

// Same resolution-group vocabulary as guessResolutionGroup above
// ('2160p'/'1080p'/'720p'/'SD'), derived from a real, ffprobe-read video
// stream height instead of a filename tag — see server/lib/ffprobe.js's
// probeMediaStreams, which is what actually reads this off the file.
// Thresholds sit a little below each standard's nominal height (1080/720/
// 480) since real encodes commonly crop a handful of pixels (1076, 1072,
// etc. are unmistakably "1080p" to a human, just not exactly 1080) — this
// is a real measurement, not a text match, so it needs some tolerance
// instead of an exact-equality check. Below the SD threshold still returns
// 'SD' rather than null: every real video stream has *some* height, so
// "not really any of these" isn't a real case the way "no tag in the
// filename at all" is for the text-based guess above.
function resolutionGroupFromHeight(height) {
  if (!height || height <= 0) return null;
  if (height >= 1800) return '2160p';
  if (height >= 900) return '1080p';
  if (height >= 500) return '720p';
  return 'SD';
}

function guessSourceLabel(name) {
  if (/\b(bluray|bd ?rip|bdmux)\b/i.test(name)) return 'Bluray';
  if (/\bweb[- ]?dl\b/i.test(name)) return 'WEBDL';
  if (/\bhdtv\b/i.test(name)) return 'HDTV';
  return null;
}

// Best-effort resolution + source guess from a real filename, mapped to
// whichever real Settings > Quality tier it matches. Quality tiers are
// fully user-managed (add/rename/delete/reorder — see server/lib/quality.js
// and README's Quality Definitions section), not a fixed list, so this
// looks the guess up against whatever's actually configured right now
// rather than returning a tier name that might not exist anymore.
//
// `probedResolutionGroup` — a real value from resolutionGroupFromHeight
// above, when the caller has one — overrides whatever (if anything) the
// filename itself says about resolution: a real, ffprobe-read pixel height
// is simply more trustworthy than a text tag that might be wrong or absent
// entirely. Every caller that has a real file to probe (Library Import,
// the per-series Rescan button, the auto-scan-on-add, a real grab's
// completion) passes one in now; source (WEBDL/Bluray/HDTV/...) still only
// ever comes from the name — there's no signal for *that* in the video
// bytes themselves, so it stays a best-effort guess either way.
function guessQualityTierName(filename, probedResolutionGroup = null) {
  const tiers = getQualityTiers();
  if (tiers.length === 0) return null;

  const resGroup = probedResolutionGroup || guessResolutionGroup(filename);
  if (!resGroup) {
    // No resolution tag, but a source is still identifiable ("HDTV", no
    // "1080p"/"720p" alongside it) — pick that source's lowest-resolution
    // configured tier rather than throwing the source signal away entirely.
    // Tiers come back ordered worst-to-best (see quality.js), so the first
    // match for a given source name prefix is its lowest resolution.
    const source = guessSourceLabel(filename);
    if (source) {
      const bySource = tiers.filter((t) => t.name.toLowerCase().startsWith(source.toLowerCase()));
      if (bySource.length > 0) return bySource[0].name;
    }
    // No resolution AND no source tag at all — closest real-world default
    // is the lowest configured tier (an untagged file is almost always an
    // old, low-res release), same "worse than everything real" convention
    // isBelowCutoff already uses for genuinely unknown qualities.
    return (tiers.find((t) => t.name === 'SDTV') || tiers[0]).name;
  }
  const inGroup = tiers.filter((t) => t.resolutionGroup === resGroup);
  if (inGroup.length === 0) return tiers[0].name; // that resolution has no configured tier at all

  const source = guessSourceLabel(filename);
  const exact = source ? inGroup.find((t) => t.name.toLowerCase().startsWith(source.toLowerCase())) : null;
  if (exact) return exact.name;
  // Resolution known, source tag not present at all — a fansub release
  // ("[SubsPlease] Show - 05 [1080p]", no "WEB-DL"/"BluRay"/"HDTV" in the
  // name) almost never carries an explicit source tag despite actually
  // being a web rip, since that's the default and only alternate sources
  // bother to call themselves out. WEBDL is the more realistic default here
  // than whatever happens to sort first, specifically because this is an
  // anime-focused app — most real anime releases are exactly this case.
  const webdl = inGroup.find((t) => t.name.toLowerCase().startsWith('webdl'));
  return (webdl || inGroup[0]).name;
}

// Best-effort season/episode number guess, most-specific pattern first so a
// resolution tag ("1080p"), release year, or hash doesn't get misread as an
// episode number. `seasonHint` (from a "Season N" ancestor folder, see
// walkVideoFiles) fills in the season when the filename itself doesn't
// carry one — `confident` is false whenever that had to happen, since a
// bare episode number with no folder hint on a multi-season series is a
// real guess, not a fact, and the caller (import-files.js) should say so
// rather than silently picking season 1.
function guessSeasonEpisode(filename, seasonHint) {
  const noExt = filename.replace(/\.[^.]+$/, '');
  // Every pattern below finds the episode number by looking for a real
  // whitespace character next to it — but some release groups (Chihiro is a
  // real, confirmed example: "[Chihiro]_Jitsu_wa_Watashi_wa_-_01_[Blu-ray_
  // 1080p_Hi10P_FLAC][8E8EC91B].mkv") use underscores as the word separator
  // throughout the entire filename instead of spaces, including around the
  // episode number itself. None of the patterns' `\s` ever matched an
  // underscore, so a perfectly parseable "- 01 [" shape hidden behind
  // "-_01_[" came back completely unmatched. `normalized` is a local search
  // copy only — the real `filename`/`noExt` strings this function was given
  // are never touched, so nothing downstream (an unmatched file's reason
  // string, the real path used to update the episode row) ever sees an
  // underscore silently turned into a space — this makes every existing
  // pattern see the same shape it already handles for a space-separated
  // release, with no separate underscore-aware copy of each pattern to keep
  // in sync.
  const normalized = noExt.replace(/_/g, ' ');

  let m = /S(\d{1,2})E(\d{1,3})/i.exec(normalized);
  if (m) return { season: Number(m[1]), episode: Number(m[2]), confident: true };

  m = /\bE(?:P)?\.?\s?(\d{1,3})\b/i.exec(normalized);
  if (m) return { season: seasonHint ?? null, episode: Number(m[1]), confident: seasonHint != null };

  // Common anime convention: "Series Name - 05 [1080p][hash]" — a lone
  // 1-3 digit number set off by " - " and followed by a bracket/paren or
  // the end of the name, so a bare number anywhere else in a longer title
  // (a year, a resolution digit) doesn't match.
  m = /-\s*(\d{1,3})(?:v\d)?\s*(?=\[|\(|$)/.exec(normalized);
  if (m) return { season: seasonHint ?? null, episode: Number(m[1]), confident: seasonHint != null };

  // Same idea without the hyphen — "Series Name 01.mkv" or "Series Name 01
  // [1080p].mkv", a plain space before the number instead of " - ". Common
  // on older fansub releases (confirmed against a real one: Kiss X Sis's
  // Season 0/Specials folder, named exactly "Kiss X Sis 01.mkv" through
  // "12.mkv", none of which matched anything until this was added). Same
  // whitespace-before/bracket-or-end-after boundary as the hyphen pattern
  // above keeps a resolution tag or a year elsewhere in the title from
  // being misread as the episode number — tried last, only once every more
  // specific pattern above has already failed to match.
  m = /\s(\d{1,3})(?:v\d)?\s*(?=\[|\(|$)/.exec(normalized);
  if (m) return { season: seasonHint ?? null, episode: Number(m[1]), confident: seasonHint != null };

  // Kitsune's OWN Anime naming format ({Series Title} - {absolute:000} -
  // {Episode Title} [{Quality Full}]..., see episode-paths.js's mm-2) puts
  // the number between two " - " separators instead of directly before the
  // bracket the two patterns above expect — confirmed real bug: a file
  // Kitsune itself just renamed to that format (e.g. "Chainsmoker Cat - 001
  // - I'm Yani Neko, Nya [WEBDL-1080p].mkv") came back completely
  // unparseable (episode: null) on the very next Rescan, silently flipping
  // an already-matched, already-downloaded episode back to "missing" for no
  // reason other than Kitsune having renamed its own file. Tried last,
  // after every bracket-adjacent pattern above has already failed to match
  // — a plain "Series - 05 [1080p]" release with no episode title still
  // matches one of those first and never reaches this one. The lookahead
  // requires a real title-looking word (not another number/bracket) right
  // after the second " - ", which is what actually distinguishes this from
  // a coincidental "-NNN-" inside a title that itself contains a hyphen
  // (e.g. "Re:ZERO -Starting Life in Another World-" — that hyphen isn't
  // immediately followed by a digit, so it can't match this pattern at all).
  m = /-\s*(\d{1,4})(?:v\d)?\s+-\s+\S/.exec(normalized);
  if (m) return { season: seasonHint ?? null, episode: Number(m[1]), confident: seasonHint != null };

  // A lone episode number followed by " - " and a real episode title, with
  // no bracket/paren ever closing it out and no show name in the filename
  // at all — confirmed real case: a "Nobunaga-sensei no Osanazuma" release
  // with files named exactly "01 - It Is Good That My Wife Came.mkv"
  // through "12 - My Wife Is Not Going Home.mkv" inside a "Season 01"
  // folder. Every pattern above requires the number to sit right before a
  // bracket/paren/end (guessResolutionGroup-tagged releases) or between two
  // separate " - " runs (Kitsune's own naming format) — neither shape
  // exists here, so all five came back unmatched despite the folder-level
  // series match (findExistingSeriesFolder, episodes.js) working fine and
  // the season hint being available. Tried last, since anchoring on "number
  // right at the start of the name, or right after whitespace, followed by
  // ' - ' and more text" is the least specific shape here — a number that
  // only incidentally precedes " - " elsewhere in a longer title (a part
  // number, an in-title year) could false-positive, so every more
  // specific/anchored pattern above already had first shot at it.
  m = /(?:^|\s)(\d{1,3})(?:v\d)?\s*-\s*\S/.exec(normalized);
  if (m) return { season: seasonHint ?? null, episode: Number(m[1]), confident: seasonHint != null };

  return { season: seasonHint ?? null, episode: null, confident: false };
}

// isVideoFile is also used by server/routes/queue.js's real-import
// completion step, to filter a completed torrent's raw GET /torrents/files
// listing (which includes every file the torrent contains — .nfo, .srt,
// sample clips, etc.) down to the actual episode video file(s) before
// trying to match any of them to an episode.
module.exports = {
  isVideoFile, isSampleFile, walkVideoFiles, summarizeFiles, guessQualityTierName, guessSeasonEpisode,
  resolutionGroupFromHeight,
};
