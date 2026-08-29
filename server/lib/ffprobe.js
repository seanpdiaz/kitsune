// ---------------------------------------------------------------------------
// Real per-file audio/subtitle track detection — the one spot in this app
// that shells out to an external binary (ffprobe, part of ffmpeg) instead of
// doing everything in pure Node/node:sqlite the way the rest of this
// zero-npm-dependency app does. Worth the exception: every other "media
// info" field this app shows (codec, audio track layout, subtitles) used to
// be a deterministic but entirely fabricated guess — fine when "downloaded"
// only ever meant a simulated grab with no real file behind it, actively
// wrong once real imports (Library Import, the per-series Rescan button, the
// auto-scan-on-add, a real grab's completion — see routes/import-files.js,
// routes/episodes.js, routes/queue.js) started marking episodes downloaded
// from actual files on disk. A real, single-audio-track file confidently
// labeled "Dual" is worse than an honest "Unknown" would have been.
//
// Only ever called against a file one of those real-import paths just
// matched to a real path on disk — there's nothing real to probe for a
// fabricated/simulated one, and this module has no opinion on when it's
// appropriate to call; that's each caller's job.
// ---------------------------------------------------------------------------
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');
const { logWarn } = require('../logger');

// Promise-based ffprobe spawn, used by probeMediaStreams below. Deliberately
// NOT used for checkFfprobeAvailability just below — that one-time PATH
// check is cheap and only ever runs once per process (memoized), so it's not
// worth restructuring its own caching into async just to shave a rare,
// single blocking call; probeMediaStreams is the one that runs once per real
// media file and is worth making non-blocking.
const execFileAsync = promisify(execFile);

// Checked once per process (not once per file — ffprobe either exists on
// this machine's PATH or it doesn't, and re-spawning a process just to find
// out again before every single probe would be wasteful for a rescan
// covering a whole season). null = not checked yet.
let ffprobeAvailable = null;

function checkFfprobeAvailability() {
  if (ffprobeAvailable !== null) return ffprobeAvailable;
  try {
    execFileSync('ffprobe', ['-version'], { stdio: 'ignore', timeout: 5000 });
    ffprobeAvailable = true;
  } catch (err) {
    ffprobeAvailable = false;
    // One clear line explaining the gap, not a silent "Unknown" with no way
    // to tell "ffprobe isn't installed" apart from "this file genuinely
    // couldn't be probed" — same "make the gap diagnosable" rule the rest of
    // this app's real-vs-simulated fallbacks already follow.
    logWarn('Ffprobe', `ffprobe isn't available on this machine's PATH — real per-file audio/subtitle detection is disabled (the Audio column will show "Unknown" for real imports instead of a guess). Install ffmpeg (which bundles ffprobe) to enable it. (${err.code || err.message})`);
  }
  return ffprobeAvailable;
}

// ffprobe's tags.language is a 3-letter ISO 639-2 code — covers the
// handful an anime release actually carries; anything else just shows the
// raw code uppercased rather than silently dropping it.
const LANGUAGE_LABELS = {
  jpn: 'Japanese', eng: 'English', und: 'Unknown', spa: 'Spanish', fre: 'French', fra: 'French',
  ger: 'German', deu: 'German', ita: 'Italian', por: 'Portuguese', rus: 'Russian', kor: 'Korean',
  chi: 'Chinese', zho: 'Chinese', ara: 'Arabic', vie: 'Vietnamese', tha: 'Thai', ind: 'Indonesian',
};
function languageLabel(code) {
  if (!code) return 'Unknown';
  const key = String(code).toLowerCase();
  return LANGUAGE_LABELS[key] || key.toUpperCase();
}

function channelsLabel(channels, channelLayout) {
  if (channelLayout) return channelLayout;
  if (channels === 1) return 'Mono';
  if (channels === 2) return 'Stereo';
  if (channels === 6) return '5.1';
  if (channels === 8) return '7.1';
  return channels ? `${channels}ch` : 'Unknown';
}

// Returns { audio: [{language, codec, channels}], subtitles: [{language,
// codec, forced}] } read straight from the real file, or null if ffprobe
// isn't installed, the file can't be read, or the probe fails for any other
// reason. Callers treat null exactly like every other real-vs-simulated gap
// in this app: an honest "don't know," not a guess dressed up as one.
//
// One ffprobe call covers both audio and subtitle streams (`-show_streams`
// with no `-select_streams` filter, then split by `codec_type` here) rather
// than two separate spawns — cheaper, and keeps "what does this real file
// actually have" as one atomic answer instead of two probes that could
// disagree if the file changed between them.
//
// Async (execFile via promisify, not execFileSync) on purpose — this used to
// spawn ffprobe synchronously, which blocks Node's single-threaded event
// loop for the whole process, not just the request that triggered it: every
// other open tab/API call/page load froze for as long as ffprobe took to run
// (confirmed real case: adding a series with existing local episode files
// froze the entire UI while the add-time auto-scan probed each matched file
// in turn — see scanExistingFilesForSeries in routes/episodes.js). An async
// spawn lets the event loop keep serving other requests while ffprobe runs
// in its own OS process; the wait for any one file's probe is the same
// either way, only how much else the server can do at the same time changes.
async function probeMediaStreams(filePath) {
  if (!checkFfprobeAvailability()) return null;
  let out;
  try {
    const result = await execFileAsync('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_streams', filePath,
    ], { timeout: 20000, maxBuffer: 10 * 1024 * 1024 });
    out = result.stdout;
  } catch (err) {
    logWarn('Ffprobe', `Could not probe "${filePath}": ${err.message}`);
    return null;
  }
  let json;
  try {
    json = JSON.parse(out.toString('utf8'));
  } catch (err) {
    logWarn('Ffprobe', `ffprobe returned unparseable output for "${filePath}": ${err.message}`);
    return null;
  }
  const streams = Array.isArray(json.streams) ? json.streams : [];
  const audio = streams
    .filter((s) => s.codec_type === 'audio')
    .map((s) => ({
      language: languageLabel(s.tags && s.tags.language),
      codec: s.codec_name ? s.codec_name.toUpperCase() : 'Unknown',
      channels: channelsLabel(s.channels, s.channel_layout),
    }));
  const subtitles = streams
    .filter((s) => s.codec_type === 'subtitle')
    .map((s) => ({
      language: languageLabel(s.tags && s.tags.language),
      codec: s.codec_name ? s.codec_name.toUpperCase() : 'Unknown',
      forced: !!(s.disposition && s.disposition.forced),
    }));
  // The real video stream's own width/height/codec — `-show_streams` (above)
  // always returned this alongside audio/subtitles, it just wasn't kept
  // until now. This is what lets a real import know an episode's actual
  // resolution instead of only ever guessing it from a filename tag that
  // might be wrong or missing entirely (see server/lib/media-files.js's
  // resolutionGroupFromHeight, and every guessQualityTierName call site that
  // now passes a probed resolution group in before falling back to the
  // filename guess). null when this file genuinely has no video stream, same
  // "don't know" treatment as everything else here.
  const videoStream = streams.find((s) => s.codec_type === 'video');
  const video = videoStream ? {
    width: videoStream.width || null,
    height: videoStream.height || null,
    codec: videoStream.codec_name ? videoStream.codec_name.toUpperCase() : 'Unknown',
  } : null;
  return { audio, subtitles, video };
}

module.exports = { probeMediaStreams, checkFfprobeAvailability };
