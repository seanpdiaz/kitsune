// ---------------------------------------------------------------------------
// Probe backfill: fills in media_streams (real audio/video/subtitle info from
// ffprobe, see ffprobe.js) for downloaded episodes that don't have it yet.
//
// Every import path already probes the file it imports (automatic import of
// a finished download in routes/queue.js, Manual Import, Library Import /
// Rescan for local files, and the scan when a series is added). But a probe
// can come back empty: ffprobe wasn't installed when the file arrived, the
// file was still being written or on a mount that was briefly unreachable,
// or the episode was marked downloaded before probing existed. Nothing used
// to retry those, so Media Info, the Audio column and Edit tracks stayed
// blank for that file forever ("No probed .mkv files found in this series
// yet."). This module is the retry:
//
//   - probeUnprobedEpisodes({ seriesId }) — probe every downloaded episode
//     with a real path and no media_streams (optionally one series). Called
//     on demand by Rescan for local files and by Edit tracks before they give
//     up on a missing probe.
//   - startProbeBackfillScheduler() — the same across the whole library a
//     short while after startup and then every few hours, so files probe on
//     their own without anyone having to click anything.
//
// Files run one at a time (ffprobe is a separate process per file, and a big
// library on a NAS shouldn't get hit with hundreds at once). An episode
// whose file is missing or still fails to probe is just left unprobed and
// tried again next run; it isn't marked as failed anywhere.
// ---------------------------------------------------------------------------
const fs = require('fs');
const db = require('../db');
const { logInfo, logWarn } = require('../logger');
const { probeMediaStreams, checkFfprobeAvailability } = require('./ffprobe');

const STARTUP_DELAY_MS = 20 * 1000;
const INTERVAL_MS = 6 * 60 * 60 * 1000;

let libraryRunInFlight = null;

async function fileExists(p) {
  try {
    const st = await fs.promises.stat(p);
    return st.isFile();
  } catch {
    return false;
  }
}

// Returns { ffprobeMissing, candidates, probed, missingFiles, failed }.
async function probeUnprobedEpisodes({ seriesId = null } = {}) {
  const result = { ffprobeMissing: false, candidates: 0, probed: 0, missingFiles: 0, failed: 0 };
  if (!checkFfprobeAvailability()) {
    result.ffprobeMissing = true;
    return result;
  }
  const rows = seriesId != null
    ? await db.prepare("SELECT id, path FROM episodes WHERE series_id = ? AND downloaded = 1 AND path IS NOT NULL AND path != '' AND media_streams IS NULL").all(seriesId)
    : await db.prepare("SELECT id, path FROM episodes WHERE downloaded = 1 AND path IS NOT NULL AND path != '' AND media_streams IS NULL").all();
  result.candidates = rows.length;
  const update = db.prepare('UPDATE episodes SET media_streams = ? WHERE id = ? AND media_streams IS NULL');
  for (const row of rows) {
    if (!(await fileExists(row.path))) {
      result.missingFiles++;
      continue;
    }
    const streams = await probeMediaStreams(row.path);
    if (!streams) {
      result.failed++;
      continue;
    }
    await update.run(JSON.stringify(streams), row.id);
    result.probed++;
  }
  return result;
}

async function runLibraryBackfill(reason) {
  if (libraryRunInFlight) return libraryRunInFlight;
  libraryRunInFlight = (async () => {
    try {
      const r = await probeUnprobedEpisodes();
      if (r.ffprobeMissing) return r; // ffprobe.js already logged why, once
      if (r.probed > 0 || r.failed > 0) {
        logInfo('MediaProbe', `Probe backfill (${reason}): probed ${r.probed} of ${r.candidates} file(s) missing media info` +
          (r.failed ? `, ${r.failed} still failed (see Ffprobe warnings)` : '') +
          (r.missingFiles ? `, ${r.missingFiles} not found on disk` : ''));
      }
      return r;
    } catch (err) {
      logWarn('MediaProbe', `Probe backfill (${reason}) failed: ${err.message}`);
      return null;
    } finally {
      libraryRunInFlight = null;
    }
  })();
  return libraryRunInFlight;
}

function startProbeBackfillScheduler() {
  const startTimer = setTimeout(() => {
    runLibraryBackfill('startup');
    const interval = setInterval(() => runLibraryBackfill('scheduled'), INTERVAL_MS);
    if (interval.unref) interval.unref();
  }, STARTUP_DELAY_MS);
  if (startTimer.unref) startTimer.unref();
}

module.exports = { probeUnprobedEpisodes, runLibraryBackfill, startProbeBackfillScheduler };
