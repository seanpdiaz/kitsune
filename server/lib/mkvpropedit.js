// ---------------------------------------------------------------------------
// Real in-place editing of an MKV's default audio/subtitle track flags —
// backs the Series page's "Edit Tracks" action (see server/routes/episodes.js
// and frontend/pages/series/SeriesPage.jsx). ffprobe.js already reads which
// track is currently flagged default; this is the one place that writes a
// new choice back to the real file.
//
// mkvpropedit (part of the MKVToolNix suite — a separate install from
// ffmpeg/ffprobe, which this app already depends on for real per-file audio/
// subtitle detection) rewrites just the file's own header/metadata block in
// place. It does NOT touch the actual video/audio/subtitle data at all, so
// this is instant regardless of file size and never re-encodes anything —
// deliberately chosen over an ffmpeg `-c copy` remux (which would work too,
// using a dependency this app already has) specifically because that
// approach has to write a whole second copy of the file to change one flag,
// meaning real time and real temporary disk space proportional to the
// episode's size. A single mkvpropedit invocation edits every track flag
// this feature needs to change — audio and subtitle together — as one
// atomic operation: MKVToolNix's own behavior (confirmed directly) is that
// if ANY requested edit fails (e.g. a stale track count sent by a client
// that hasn't refreshed since the file changed), NONE of the edits are
// applied — there's no risk of a partially-applied change leaving the file
// in an inconsistent state.
//
// Only ever called against a real, already-downloaded .mkv file — there's
// nothing to edit for a simulated download or a non-Matroska container
// (.mp4, .avi, etc. don't have this concept the same way, and mkvpropedit
// itself only understands Matroska/WebM); the route calling this is what
// enforces that, this module just does the edit once asked.
// ---------------------------------------------------------------------------
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const { logWarn } = require('../logger');

const execFileAsync = promisify(execFile);

// Same one-check-per-process memoization as ffprobe.js's own
// checkFfprobeAvailability, for the same reason: this either exists on
// PATH or it doesn't, and there's no value in re-spawning a process to find
// that out again before every single edit.
let mkvpropeditAvailable = null;

function checkMkvpropeditAvailability() {
  if (mkvpropeditAvailable !== null) return mkvpropeditAvailable;
  try {
    execFileSync('mkvpropedit', ['--version'], { stdio: 'ignore', timeout: 5000 });
    mkvpropeditAvailable = true;
  } catch (err) {
    mkvpropeditAvailable = false;
    logWarn('Mkvpropedit', `mkvpropedit isn't available on this machine's PATH — editing default audio/subtitle tracks is disabled. Install MKVToolNix (mkvtoolnix / mkvtoolnix-cli, depending on your package manager) to enable it. (${err.code || err.message})`);
  }
  return mkvpropeditAvailable;
}

// edits: { audio?: { count, defaultIndex }, subtitle?: { count, defaultIndex } }
// — a type is only touched at all if its key is present. `count` is how
// many tracks of that type the file has (from the most recent real probe —
// see ffprobe.js), `defaultIndex` is the 1-based, per-type track number
// (mkvpropedit's own `track:a<N>`/`track:s<N>` selectors — confirmed
// directly to number tracks in the same per-type order ffprobe's own
// `-show_streams` output does, so the position of a track in
// probeMediaStreams' audio/subtitle arrays is exactly this number) that
// should end up flagged default, or null to end up with no track of that
// type flagged default at all (a legitimate, real Matroska state — most
// useful for subtitles, where "no forced default track" is often exactly
// what someone wants).
//
// Every track of a touched type gets an explicit flag-default=0 or =1 in
// the same command — not just the ones actually changing — so the file's
// end state is always exactly what was asked for regardless of whatever
// its dispositions happened to be before, rather than trusting a
// possibly-stale "this one was already 0" assumption.
async function applyDefaultTrackFlags(filePath, edits) {
  if (!checkMkvpropeditAvailability()) {
    return { ok: false, error: "mkvpropedit isn't installed on this machine — install MKVToolNix to edit default tracks." };
  }

  const args = [filePath];
  for (const type of ['audio', 'subtitle']) {
    const spec = edits[type];
    if (!spec) continue; // this type wasn't touched — leave its tracks exactly as they are
    const prefix = type === 'audio' ? 'a' : 's';
    for (let i = 1; i <= spec.count; i += 1) {
      args.push('--edit', `track:${prefix}${i}`, '--set', `flag-default=${i === spec.defaultIndex ? 1 : 0}`);
    }
  }
  if (args.length === 1) return { ok: true }; // nothing to do — no type was actually touched

  try {
    await execFileAsync('mkvpropedit', args, { timeout: 30000 });
    return { ok: true };
  } catch (err) {
    // mkvpropedit's own stderr ("Error: No track corresponding to the edit
    // specification 'a3' was found...") is far more useful here than
    // err.message (just "Command failed: mkvpropedit ...") — surfaced
    // as-is rather than paraphrased, same "show the real tool's own
    // explanation" call qbittorrent.js's own error surfacing already makes.
    const detail = (err.stderr || err.message || '').toString().trim();
    logWarn('Mkvpropedit', `Could not edit default tracks on "${filePath}": ${detail}`);
    return { ok: false, error: detail || 'mkvpropedit failed for an unknown reason.' };
  }
}

module.exports = { checkMkvpropeditAvailability, applyDefaultTrackFlags };
