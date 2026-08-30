// ---------------------------------------------------------------------------
// /api/queue — grabbing a release and tracking it to completion. Every row
// here is a real release (see server/routes/releases.js — Nyaa.si and/or
// Prowlarr) submitted to a real, enabled qBittorrent client (see
// server/lib/download-clients/qbittorrent.js); there's no simulated/fake
// tracking path anymore. Progress/state is polled from that real client
// (see realTick() below), and pause/resume/remove act on the real torrent
// too. Grabbing a release with no qBittorrent client configured, or one the
// submit call itself fails against (client unreachable, rejected
// credentials, etc.), is a hard error — see submitRealGrab/insertSingleGrab
// below — rather than silently faking a download that never started.
// ---------------------------------------------------------------------------
const db = require('../db');
const { logInfo, logWarn, logDebug } = require('../logger');
const { sendJson, readJsonBody } = require('../lib/http');
const {
  getCachedRelease, buildReleaseCacheKey, targetEpisodesForScope, searchForEpisode, searchForBatchScope,
} = require('./releases');
const { getQualityProfile, isBelowCutoff } = require('../lib/quality');
const { recomputeSeriesEpisodeStats } = require('../lib/series-stats');
const { buildEpisodeFilePath } = require('../lib/episode-paths');
const { insertHistoryRow } = require('./history');
const { insertBlocklistRow } = require('./blocklist');
const { notifyConnections } = require('../lib/notify');
const qbittorrent = require('../lib/download-clients/qbittorrent');
const { isVideoFile, guessSeasonEpisode, guessQualityTierName, resolutionGroupFromHeight } = require('../lib/media-files');
const { resolveLocalPath, joinRemotePath } = require('../lib/remote-path');
const { importEpisodeFile } = require('../lib/media-import');
const { probeMediaStreams } = require('../lib/ffprobe');
const { computeInfoHash } = require('../lib/bencode');
const { describeFetchError } = require('../lib/prowlarr-search');

db.init(async () => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS queue (
      id ${db.PK},
      series_id INTEGER NOT NULL,
      episode_id INTEGER NOT NULL,
      release_title TEXT NOT NULL,
      quality TEXT,
      size_bytes INTEGER,
      indexer TEXT,
      protocol TEXT,
      status TEXT NOT NULL DEFAULT 'downloading',
      progress_pct INTEGER NOT NULL DEFAULT 0,
      added_at TEXT
    )
  `);

  // Real-grab tracking fields — see this module's header. `source` is always
  // 'real' now (every INSERT below sets it explicitly); the column itself is
  // kept around rather than migrated away so an existing dev database with
  // old simulated rows in its history doesn't need a destructive migration.
  const queueColumns = await db.tableColumns('queue');
  for (const [col, def] of [
    ['source', "TEXT NOT NULL DEFAULT 'real'"],
    ['magnet_url', 'TEXT'],
    ['torrent_hash', 'TEXT'],
    ['download_client_id', 'INTEGER'],
  ]) {
    if (!queueColumns.includes(col)) {
      await db.exec(`ALTER TABLE queue ADD COLUMN ${col} ${def}`);
      logInfo('Database', `Migrated queue table: added ${col} column`);
    }
  }
});

function rowToQueueEntry(row) {
  return {
    id: row.id,
    seriesId: row.series_id,
    seriesTitle: row.series_title,
    episodeId: row.episode_id,
    episodeLabel: `S${String(row.season_number).padStart(2, '0')}E${String(row.num).padStart(2, '0')}`,
    episodeTitle: row.episode_title,
    releaseTitle: row.release_title,
    quality: row.quality,
    sizeBytes: row.size_bytes,
    indexer: row.indexer,
    protocol: row.protocol,
    status: row.status,
    progressPct: row.progress_pct,
    addedAt: row.added_at,
    source: row.source,
  };
}

const QUEUE_SELECT = `
  SELECT q.*, s.title AS series_title, e.season_number, e.num, e.title AS episode_title
  FROM queue q
  JOIN series s ON s.id = q.series_id
  JOIN episodes e ON e.id = q.episode_id
`;

// The enabled qBittorrent client to submit real grabs to — lower
// clientPriority runs first, same "round-robin priority across multiple
// enabled clients" semantics Settings > Download Clients' own field
// description already promises. A client missing a host/port isn't usable
// even if enabled (mirrors download-clients.js's own test-route guard).
async function pickQbittorrentClient() {
  const rows = await db.prepare("SELECT * FROM settings_items WHERE section = 'download-clients'").all();
  const candidates = rows
    .map((r) => ({ id: r.id, ...JSON.parse(r.data) }))
    .filter((c) => c.type === 'qbittorrent' && c.enabled && c.host && c.port)
    .sort((a, b) => (a.clientPriority ?? 999) - (b.clientPriority ?? 999));
  return candidates[0] || null;
}

async function getDownloadClient(id) {
  const row = await db.prepare("SELECT * FROM settings_items WHERE id = ? AND section = 'download-clients'").get(id);
  return row ? { id: row.id, ...JSON.parse(row.data) } : null;
}

// ---------------------------------------------------------------------------
// Submitting a real grab — shared by the single-episode and batch paths
// below (previously two near-identical copies of this logic). Handles both
// shapes a release's magnetUrl can be in:
//   - a real magnet: link → handed straight to qBittorrent as a URL, same as
//     always (a magnet doesn't need fetching — the hash is already known).
//   - an http(s) download URL (Prowlarr's proxy download link for an indexer
//     that doesn't expose a raw magnet — see prowlarr-search.js) → Kitsune
//     fetches the real .torrent bytes itself and uploads the file directly,
//     rather than handing qBittorrent a URL to fetch on its own. This is a
//     real fix, not a stylistic choice: a live report showed qBittorrent
//     accepting such a URL (200 "Ok.") and then never actually producing a
//     torrent — the most likely explanation is qBittorrent's own host not
//     having the same network path to the indexer that Kitsune does (already
//     proven reachable, since the search that found this release came back
//     over that same path). Uploading the bytes directly removes qBittorrent
//     from that reachability question entirely.
// Returns { ok, torrentHash, downloadClientId } on success, or
// { ok: false, error } — the caller treats a failure here as a hard error,
// not something to fall back and fake.
// ---------------------------------------------------------------------------
const TORRENT_FETCH_TIMEOUT_MS = 20000;
const MAX_TORRENT_FETCH_REDIRECTS = 10;

function extractInfoHashFromMagnet(magnetUrl) {
  const m = String(magnetUrl || '').match(/xt=urn:btih:([A-Za-z0-9]+)/);
  return m ? m[1].toLowerCase() : null;
}

// Fetches a real .torrent file's raw bytes from an indexer's download URL.
// Uses `redirect: 'manual'` rather than letting fetch follow redirects
// itself — necessary because of a real, confirmed case: a Prowlarr download
// link for an old Nyaa.si release 302-redirected straight to a magnet: URI
// (some indexers don't keep a static .torrent file around for very old
// releases, only a magnet). fetch() can't follow a redirect to a non-http(s)
// scheme and throws `TypeError: URL scheme must be a HTTP(S) scheme` instead
// of exposing the Location header — confirmed directly against a real local
// server issuing exactly that redirect. Reading the Location header manually
// means a magnet-scheme redirect can be treated as a real, usable magnet
// (returned as `magnetUrl`) instead of a failure; an http(s) redirect is
// still followed (manually, since auto-follow is off), same as fetch's
// default behavior would have done anyway.
async function fetchTorrentFile(url, redirectsLeft = MAX_TORRENT_FETCH_REDIRECTS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TORRENT_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(res.status)) {
      const location = res.headers.get('location');
      if (!location) return { ok: false, error: `Indexer responded with a ${res.status} redirect but no Location header.` };
      if (location.startsWith('magnet:')) {
        return { ok: true, magnetUrl: location, infoHash: extractInfoHashFromMagnet(location) };
      }
      if (!/^https?:\/\//i.test(location)) {
        return { ok: false, error: `Indexer redirected to an unsupported link type: ${location}` };
      }
      if (redirectsLeft <= 0) return { ok: false, error: `Too many redirects (stopped after ${MAX_TORRENT_FETCH_REDIRECTS}).` };
      clearTimeout(timer);
      return fetchTorrentFile(new URL(location, url).toString(), redirectsLeft - 1);
    }
    if (!res.ok) return { ok: false, error: `Indexer returned status ${res.status} fetching the .torrent file.` };
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length === 0) return { ok: false, error: 'Indexer returned an empty response fetching the .torrent file.' };
    let infoHash = null;
    try {
      infoHash = computeInfoHash(buffer);
    } catch (err) {
      // Still usable — qBittorrent can add the file even without Kitsune
      // knowing its hash up front (realTick() just won't be able to poll
      // this row's real progress until torrent_hash is known some other
      // way). Surfaced as a warning, not a hard failure.
      logWarn('Queue', `Fetched a .torrent file but couldn't compute its info hash (${err.message}) — the file itself will still be uploaded to qBittorrent, but this row won't be trackable until it's found some other way.`);
    }
    return { ok: true, buffer, infoHash };
  } catch (err) {
    // Node's global fetch wraps the real reason (DNS failure, connection
    // refused, TLS issue, etc.) inside err.cause, leaving err.message a
    // generic, unhelpful "fetch failed" — the exact same opacity problem
    // already solved for Prowlarr's own search/status calls (see
    // prowlarr-search.js's describeFetchError, reused here rather than
    // duplicated). Confirmed to matter in practice: a live retest of this
    // exact code path surfaced nothing but "fetch failed" for a real
    // connectivity problem reaching a Prowlarr download URL.
    const reason = err.name === 'AbortError' ? `Timed out after ${TORRENT_FETCH_TIMEOUT_MS / 1000}s` : describeFetchError(err);
    return { ok: false, error: `Could not fetch the .torrent file: ${reason}` };
  } finally {
    clearTimeout(timer);
  }
}

async function submitRealGrab(release) {
  if (!release.magnetUrl) {
    return { ok: false, torrentHash: null, downloadClientId: null, error: 'This release has no magnet or download link to submit.' };
  }

  const client = await pickQbittorrentClient();
  if (!client) {
    return { ok: false, torrentHash: null, downloadClientId: null, error: 'No enabled qBittorrent client is configured — add one in Settings > Download Clients before grabbing.' };
  }

  const isMagnet = release.magnetUrl.startsWith('magnet:');
  let torrentHash = release.infoHash || null;
  let addResult;

  if (isMagnet) {
    addResult = await qbittorrent.addTorrent(client, { url: release.magnetUrl, category: client.category });
  } else {
    logDebug('Queue', `"${release.title}" (${release.indexer}) has no magnet link — fetching the .torrent file directly instead of asking qBittorrent to fetch "${release.magnetUrl}" itself.`);
    const fetched = await fetchTorrentFile(release.magnetUrl);
    if (!fetched.ok) {
      addResult = { ok: false, error: `Could not fetch the .torrent file from "${release.indexer}": ${fetched.error}` };
    } else if (fetched.magnetUrl) {
      // The download link redirected straight to a magnet (see
      // fetchTorrentFile) — just as good as if the indexer had handed us a
      // magnet to begin with.
      logDebug('Queue', `"${release.title}" (${release.indexer}) download link redirected to a magnet — using that directly.`);
      torrentHash = torrentHash || fetched.infoHash;
      addResult = await qbittorrent.addTorrent(client, { url: fetched.magnetUrl, category: client.category });
    } else {
      torrentHash = torrentHash || fetched.infoHash;
      addResult = await qbittorrent.addTorrent(client, {
        torrentFileBuffer: fetched.buffer,
        filename: `${release.title}.torrent`,
        category: client.category,
      });
    }
  }

  if (!addResult.ok) {
    return { ok: false, torrentHash: null, downloadClientId: null, error: `Could not submit to "${client.name}": ${addResult.error}` };
  }
  if (!torrentHash) {
    logWarn('Queue', `"${release.title}" was submitted to qBittorrent successfully, but no info hash is known for it (neither the indexer nor the .torrent file supplied one) — this row will show as downloading but its progress can't be polled.`);
  }
  return { ok: true, torrentHash, downloadClientId: client.id };
}

// Everything after "we have a release to grab for this one episode" — shared
// by the manual releaseIndex path (POST /api/queue with { episodeId,
// releaseIndex }) and "Grab best match" (POST /api/queue with { episodeId,
// auto: true } — see handleAutoEpisodeGrab below), since both end up needing
// the exact same submit/insert/history/notify sequence once they've settled
// on which release to grab; only *how* that release was chosen differs.
async function insertSingleGrab(series, episode, release) {
  // No queue row gets created unless this release genuinely made it to a
  // real qBittorrent client — a real, confirmed bug used to come from
  // letting a failed real submission fall through to a fake ticker that
  // completed on its own a minute or two later, silently marking the
  // episode "downloaded" with a fabricated file path and fake Media Info
  // (resolution/codec/audio/size all made up) — confirmed via a live
  // screenshot showing exactly that for a file a manual rescan then
  // correctly found didn't exist on disk. Erroring out here instead means
  // the person sees the real reason (no client configured, submit
  // rejected, etc.) right away, rather than a queue row that lies.
  const submitted = await submitRealGrab(release);
  if (!submitted.ok) {
    return { status: 502, body: { error: submitted.error } };
  }

  const insertedRow = await db.prepare(`
    INSERT INTO queue (series_id, episode_id, release_title, quality, size_bytes, indexer, protocol, status, progress_pct, source, magnet_url, torrent_hash, download_client_id, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'downloading', 0, 'real', ?, ?, ?, ?)
    RETURNING id
  `).get(
    series.id, episode.id, release.title, release.quality, release.sizeBytes, release.indexer, release.protocol,
    release.magnetUrl || null, submitted.torrentHash, submitted.downloadClientId, db.now(),
  );

  await insertHistoryRow({
    seriesId: series.id, episodeId: episode.id, eventType: 'grabbed',
    releaseTitle: release.title, quality: release.quality, indexer: release.indexer, sizeBytes: release.sizeBytes,
  });
  const episodeLabel = `S${String(episode.season_number).padStart(2, '0')}E${String(episode.num).padStart(2, '0')}`;
  logInfo('Queue', `Grabbed "${release.title}" for ${series.title} (${episodeLabel}) — submitted to a real qBittorrent client`);
  notifyConnections('grab', `${series.title} ${episodeLabel} — ${release.title} (${release.quality})`);

  const created = await db.prepare(`${QUEUE_SELECT} WHERE q.id = ?`).get(insertedRow.id);
  return { status: 201, body: rowToQueueEntry(created) };
}

// ---------------------------------------------------------------------------
// "Grab best match" — POST /api/queue with { episodeId, auto: true } instead
// of { episodeId, releaseIndex }. Skips the picker entirely: searches this
// episode's real indexers (or the simulated fallback) itself, applies the
// exact same profile-aware ranking the picker's own list uses (server/lib/
// quality.js's rankReleaseCandidates via releases.js's searchForEpisode), and
// grabs whichever release ranked #1 — which, since that ranking already
// promotes in-profile matches to the top, IS "the best match" for the
// series' Quality Profile without a person needing to eyeball the list
// themselves.
//
// Respects the profile's cutoff the same way Wanted > Cutoff Unmet already
// defines "met" (server/lib/quality.js's isBelowCutoff): an episode that's
// already downloaded at or above its profile's cutoff quality has nothing
// worth grabbing, so this no-ops with a 200 (not an error — nothing went
// wrong, there's just nothing to do) rather than searching and grabbing an
// unwanted "upgrade" the profile itself says isn't needed.
async function handleAutoEpisodeGrab(res, episodeId) {
  const episode = await db.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId);
  if (!episode) {
    sendJson(res, 404, { error: 'Episode not found' });
    return true;
  }
  const series = await db.prepare('SELECT * FROM series WHERE id = ?').get(episode.series_id);
  if (!series) {
    sendJson(res, 404, { error: 'Series not found' });
    return true;
  }
  const alreadyQueued = await db.prepare('SELECT id FROM queue WHERE episode_id = ?').get(episodeId);
  if (alreadyQueued) {
    sendJson(res, 409, { error: 'This episode is already in the queue' });
    return true;
  }

  const profile = await getQualityProfile(series.quality_profile);
  if (episode.downloaded && profile && profile.cutoff && !(await isBelowCutoff(episode.quality, profile.cutoff))) {
    sendJson(res, 200, { skipped: true, reason: `Already meets "${profile.name}"'s cutoff (${profile.cutoff}) — nothing to grab.` });
    return true;
  }

  const episodeArg = { id: episode.id, num: episode.num, seasonNumber: episode.season_number };
  const { releases, notice } = await searchForEpisode(series, episodeArg);
  if (releases.length === 0) {
    sendJson(res, 200, { skipped: true, reason: notice || 'No releases found for this episode.' });
    return true;
  }

  const { status, body: responseBody } = await insertSingleGrab(series, episode, releases[0]);
  sendJson(res, status, responseBody);
  return true;
}

async function handleQueueApi(req, res, urlPath) {
  if (req.method === 'GET' && urlPath === '/api/queue') {
    const rows = await db.prepare(`${QUEUE_SELECT} ORDER BY q.id ASC`).all();
    sendJson(res, 200, { queue: rows.map(rowToQueueEntry) });
    return true;
  }

  // POST /api/queue — grab a release. Three body shapes:
  //   { episodeId, releaseIndex }              — single episode (unchanged)
  //   { seriesId, seasonNumber?, releaseIndex } — batch: a season (with
  //     seasonNumber) or a whole series (without) — see handleBatchGrab
  //     below. Distinguished by presence of seriesId with no episodeId.
  //   { episodeId, auto: true } or { seriesId, seasonNumber?, auto: true } —
  //     "Grab best match": no releaseIndex, no picker — see
  //     handleAutoEpisodeGrab/handleAutoBatchGrab, which search and rank
  //     internally and grab whichever release comes out on top.
  // releaseIndex is that release's position in the exact list GET
  // /api/releases most recently returned for that same scope — read back
  // out of that route's own short-lived cache (see routes/releases.js,
  // buildReleaseCacheKey) rather than re-derived here, since a real Nyaa.si
  // search isn't repeatable the way the old fully-deterministic fake
  // candidates were.
  if (req.method === 'POST' && urlPath === '/api/queue') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }

    if (body.seriesId !== undefined && body.episodeId === undefined) {
      if (body.auto === true) {
        const seriesId = Number(body.seriesId);
        const hasSeasonNumber = body.seasonNumber !== undefined && body.seasonNumber !== null;
        const seasonNumber = hasSeasonNumber ? Number(body.seasonNumber) : null;
        if (!Number.isInteger(seriesId) || (hasSeasonNumber && !Number.isInteger(seasonNumber))) {
          sendJson(res, 400, { error: 'seriesId is required (seasonNumber for a season grab)' });
          return true;
        }
        return handleAutoBatchGrab(res, { seriesId, seasonNumber, hasSeasonNumber });
      }
      return handleBatchGrab(res, body);
    }

    const episodeId = Number(body.episodeId);
    if (!Number.isInteger(episodeId)) {
      sendJson(res, 400, { error: 'episodeId is required' });
      return true;
    }
    if (body.auto === true) {
      return handleAutoEpisodeGrab(res, episodeId);
    }

    const releaseIndex = Number(body.releaseIndex);
    if (!Number.isInteger(releaseIndex)) {
      sendJson(res, 400, { error: 'releaseIndex is required' });
      return true;
    }

    const episode = await db.prepare('SELECT * FROM episodes WHERE id = ?').get(episodeId);
    if (!episode) {
      sendJson(res, 404, { error: 'Episode not found' });
      return true;
    }
    const series = await db.prepare('SELECT * FROM series WHERE id = ?').get(episode.series_id);
    if (!series) {
      sendJson(res, 404, { error: 'Series not found' });
      return true;
    }

    const alreadyQueued = await db.prepare('SELECT id FROM queue WHERE episode_id = ?').get(episodeId);
    if (alreadyQueued) {
      sendJson(res, 409, { error: 'This episode is already in the queue' });
      return true;
    }

    const release = getCachedRelease(buildReleaseCacheKey({ scope: 'episode', episodeId }), releaseIndex);
    if (!release) {
      sendJson(res, 400, { error: 'Unknown release — search again and grab from the current results' });
      return true;
    }

    const { status, body: responseBody } = await insertSingleGrab(series, episode, release);
    sendJson(res, status, responseBody);
    return true;
  }

  // PATCH /api/queue/:id — pause or resume. Only meaningful between
  // 'downloading' and 'paused'; a 'warning' row needs removing/retrying
  // instead (matching real Sonarr, which doesn't let you "pause" a queue
  // item that isn't actually transferring).
  const patchMatch = req.method === 'PATCH' && urlPath.match(/^\/api\/queue\/(\d+)$/);
  if (patchMatch) {
    const id = Number(patchMatch[1]);
    const row = await db.prepare('SELECT * FROM queue WHERE id = ?').get(id);
    if (!row) {
      sendJson(res, 404, { error: 'Queue item not found' });
      return true;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const nextStatus = body.status === 'paused' ? 'paused' : body.status === 'downloading' ? 'downloading' : null;
    if (!nextStatus || (row.status !== 'downloading' && row.status !== 'paused')) {
      sendJson(res, 400, { error: 'Can only pause/resume a downloading or paused item' });
      return true;
    }

    // A real row's pause/resume is a real qBittorrent call, not just a
    // label change — best-effort: if the client can't be reached right
    // now, the DB still updates optimistically (matching what the person
    // clicked) and the next realTick() reconciles it against whatever
    // qBittorrent's actual state turns out to be.
    if (row.source === 'real' && row.torrent_hash && row.download_client_id) {
      const client = await getDownloadClient(row.download_client_id);
      if (client) {
        const result = nextStatus === 'paused'
          ? await qbittorrent.pauseTorrents(client, row.torrent_hash)
          : await qbittorrent.resumeTorrents(client, row.torrent_hash);
        if (!result.ok) logWarn('Queue', `Could not ${nextStatus === 'paused' ? 'pause' : 'resume'} "${row.release_title}" on qBittorrent: ${result.error}`);
      }
    }

    await db.prepare('UPDATE queue SET status = ? WHERE id = ?').run(nextStatus, id);
    const updated = await db.prepare(`${QUEUE_SELECT} WHERE q.id = ?`).get(id);
    sendJson(res, 200, rowToQueueEntry(updated));
    return true;
  }

  // DELETE /api/queue/:id — cancel/remove. No history entry: removing a
  // still-in-progress grab isn't a completed or failed download, it's just
  // "never mind" — same as real Sonarr's plain "Remove" (as opposed to
  // "Remove and blocklist", which this doesn't distinguish for simplicity).
  // A real row also removes the real torrent from qBittorrent — deleteFiles
  // is never sent true, matching the same non-destructive-by-default
  // convention as the Download Clients Torrents modal's own Remove button.
  // A batch grab (see handleBatchGrab) can leave several queue rows sharing
  // one torrent_hash/download_client_id — the torrent itself only actually
  // comes out of qBittorrent once the LAST row referencing it is removed;
  // until then this just drops Kitsune's own row and leaves the shared
  // torrent (and its sibling rows) alone.
  const delMatch = req.method === 'DELETE' && urlPath.match(/^\/api\/queue\/(\d+)$/);
  if (delMatch) {
    const id = Number(delMatch[1]);
    const row = await db.prepare('SELECT * FROM queue WHERE id = ?').get(id);
    if (!row) {
      sendJson(res, 404, { error: 'Queue item not found' });
      return true;
    }
    if (row.source === 'real' && row.torrent_hash && row.download_client_id) {
      const siblingCount = (await db.prepare(
        'SELECT COUNT(*) AS c FROM queue WHERE torrent_hash = ? AND download_client_id = ? AND id != ?'
      ).get(row.torrent_hash, row.download_client_id, id)).c;
      if (siblingCount === 0) {
        const client = await getDownloadClient(row.download_client_id);
        if (client) {
          const result = await qbittorrent.deleteTorrents(client, row.torrent_hash, false);
          if (!result.ok) logWarn('Queue', `Could not remove "${row.release_title}" from qBittorrent: ${result.error}`);
        }
      } else {
        logInfo('Queue', `"${row.release_title}" torrent still referenced by ${siblingCount} other queue row(s) — leaving it in qBittorrent, just removing this row`);
      }
    }
    await db.prepare('DELETE FROM queue WHERE id = ?').run(id);
    logInfo('Queue', `Removed from queue: ${row.release_title}`);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Batch grab — POST /api/queue with { seriesId, seasonNumber?, releaseIndex }
// instead of { episodeId, releaseIndex }. Search Season / Search All (see
// SeriesPage.jsx) return one batch release standing in for a whole season or
// series, distributed as a single torrent the way a finished show commonly
// is — so unlike a single-episode grab, this submits ONE addTorrent call and
// then fans that same magnet/hash out across one `queue` row per still-
// missing episode in the target scope, all tracked and completed together by
// the existing per-row, hash-keyed realTick() with no changes needed there.
// Episodes already downloaded or already queued are silently skipped rather
// than erroring the whole batch over a partial overlap.
// ---------------------------------------------------------------------------
// Shared by the manual releaseIndex batch path and "Grab best match" for a
// season/series (handleAutoBatchGrab, below) — same "we have a release,
// everything after that is identical" split as insertSingleGrab.
async function insertBatchGrab(series, release, targetEpisodes, { seasonNumber, hasSeasonNumber }) {
  // One real submit for the whole batch — not one per episode, since it's
  // genuinely a single torrent (see module header). See insertSingleGrab's
  // own comment for why a submit that doesn't actually succeed errors out
  // instead of creating queue rows for a download that never started.
  const submitted = await submitRealGrab(release);
  if (!submitted.ok) {
    return { status: 502, body: { error: submitted.error } };
  }

  const insertStmt = db.prepare(`
    INSERT INTO queue (series_id, episode_id, release_title, quality, size_bytes, indexer, protocol, status, progress_pct, source, magnet_url, torrent_hash, download_client_id, added_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'downloading', 0, 'real', ?, ?, ?, ?)
    RETURNING id
  `);
  const insertedIds = [];
  for (const ep of targetEpisodes) {
    const insertedRow = await insertStmt.get(
      series.id, ep.id, release.title, release.quality, release.sizeBytes, release.indexer, release.protocol,
      release.magnetUrl || null, submitted.torrentHash, submitted.downloadClientId, db.now(),
    );
    insertedIds.push(insertedRow.id);
    await insertHistoryRow({
      seriesId: series.id, episodeId: ep.id, eventType: 'grabbed',
      releaseTitle: release.title, quality: release.quality, indexer: release.indexer, sizeBytes: release.sizeBytes,
    });
  }

  const scopeLabel = hasSeasonNumber ? `Season ${seasonNumber}` : 'all seasons';
  logInfo('Queue', `Batch-grabbed "${release.title}" for ${series.title} (${scopeLabel}, ${targetEpisodes.length} episode${targetEpisodes.length === 1 ? '' : 's'}) — submitted to a real qBittorrent client`);
  notifyConnections('grab', `${series.title} — ${release.title} (${release.quality}, ${targetEpisodes.length} episode${targetEpisodes.length === 1 ? '' : 's'})`);

  const createdRows = await Promise.all(insertedIds.map((id) => db.prepare(`${QUEUE_SELECT} WHERE q.id = ?`).get(id)));
  return {
    status: 201,
    body: {
      batch: true,
      count: targetEpisodes.length,
      seriesId: series.id,
      seasonNumber,
      releaseTitle: release.title,
      quality: release.quality,
      entries: createdRows.map(rowToQueueEntry),
    },
  };
}

async function handleBatchGrab(res, body) {
  const seriesId = Number(body.seriesId);
  const hasSeasonNumber = body.seasonNumber !== undefined && body.seasonNumber !== null;
  const seasonNumber = hasSeasonNumber ? Number(body.seasonNumber) : null;
  const releaseIndex = Number(body.releaseIndex);
  if (!Number.isInteger(seriesId) || !Number.isInteger(releaseIndex) || (hasSeasonNumber && !Number.isInteger(seasonNumber))) {
    sendJson(res, 400, { error: 'seriesId and releaseIndex are required (seasonNumber for a season grab)' });
    return true;
  }

  const series = await db.prepare('SELECT * FROM series WHERE id = ?').get(seriesId);
  if (!series) {
    sendJson(res, 404, { error: 'Series not found' });
    return true;
  }

  const cacheKey = buildReleaseCacheKey({ scope: hasSeasonNumber ? 'season' : 'series', seriesId, seasonNumber });
  const release = getCachedRelease(cacheKey, releaseIndex);
  if (!release) {
    sendJson(res, 400, { error: 'Unknown release — search again and grab from the current results' });
    return true;
  }

  const alreadyQueuedStmt = db.prepare('SELECT id FROM queue WHERE episode_id = ?');
  const candidateEpisodes = await targetEpisodesForScope(seriesId, seasonNumber);
  const alreadyQueuedFlags = await Promise.all(candidateEpisodes.map((ep) => alreadyQueuedStmt.get(ep.id)));
  const targetEpisodes = candidateEpisodes.filter((ep, i) => !alreadyQueuedFlags[i]);
  if (targetEpisodes.length === 0) {
    sendJson(res, 400, { error: 'Nothing to grab — every episode in this range is already downloaded or already in the queue.' });
    return true;
  }

  const { status, body: responseBody } = await insertBatchGrab(series, release, targetEpisodes, { seasonNumber, hasSeasonNumber });
  sendJson(res, status, responseBody);
  return true;
}

// ---------------------------------------------------------------------------
// "Grab best match" for a season/series — POST /api/queue with { seriesId,
// seasonNumber?, auto: true }. Same idea as handleAutoEpisodeGrab: search
// internally (releases.js's searchForBatchScope, same profile-aware ranking
// as the picker's own list) and grab whichever batch release ranked #1,
// skipping the picker.
//
// No separate cutoff check here the way the single-episode version has one —
// targetEpisodesForScope (below) already only ever returns episodes that
// aren't downloaded yet, so "nothing to grab" already means exactly what it
// would mean for cutoff too: there's no undownloaded episode in this scope
// for a batch release to usefully cover. A batch grab was also never able to
// selectively "upgrade" an already-downloaded episode in isolation (it always
// targets the whole missing range as one torrent) even on the manual path,
// so there's no existing cutoff-driven upgrade behavior to preserve here.
// ---------------------------------------------------------------------------
async function handleAutoBatchGrab(res, { seriesId, seasonNumber, hasSeasonNumber }) {
  const series = await db.prepare('SELECT * FROM series WHERE id = ?').get(seriesId);
  if (!series) {
    sendJson(res, 404, { error: 'Series not found' });
    return true;
  }
  if (hasSeasonNumber) {
    const seasonExists = await db.prepare('SELECT 1 FROM episodes WHERE series_id = ? AND season_number = ? LIMIT 1').get(seriesId, seasonNumber);
    if (!seasonExists) {
      sendJson(res, 404, { error: 'Season not found' });
      return true;
    }
  }

  const alreadyQueuedStmt = db.prepare('SELECT id FROM queue WHERE episode_id = ?');
  const candidateEpisodes = await targetEpisodesForScope(seriesId, seasonNumber);
  const alreadyQueuedFlags = await Promise.all(candidateEpisodes.map((ep) => alreadyQueuedStmt.get(ep.id)));
  const targetEpisodes = candidateEpisodes.filter((ep, i) => !alreadyQueuedFlags[i]);
  if (targetEpisodes.length === 0) {
    sendJson(res, 200, { skipped: true, reason: 'Nothing to grab — every episode in this range is already downloaded or already in the queue.' });
    return true;
  }

  const seasonNameRow = hasSeasonNumber
    ? await db.prepare('SELECT season_name FROM episodes WHERE series_id = ? AND season_number = ? AND season_name IS NOT NULL LIMIT 1').get(seriesId, seasonNumber)
    : null;
  const extraQueryTerm = seasonNameRow && seasonNameRow.season_name ? seasonNameRow.season_name : null;

  const { releases, notice } = await searchForBatchScope(series, seasonNumber, { extraQueryTerm, episodeCount: targetEpisodes.length });
  if (releases.length === 0) {
    sendJson(res, 200, { skipped: true, reason: notice || 'No batch releases found.' });
    return true;
  }

  const { status, body: responseBody } = await insertBatchGrab(series, releases[0], targetEpisodes, { seasonNumber, hasSeasonNumber });
  sendJson(res, status, responseBody);
  return true;
}

// ---------------------------------------------------------------------------
// The real poller — every `source = 'real'` row's progress/state comes from
// actually asking qBittorrent, not a random ticker. Grouped by which client
// each row was submitted to so a client with several real grabs in flight
// gets one GET /torrents/info per tick, not one per row. A client that's
// unreachable this tick (network hiccup, restarted, whatever) just leaves
// those rows exactly as they were — the next tick tries again, same
// "transient failure isn't fatal" approach the rest of this app already
// takes with external calls.
// ---------------------------------------------------------------------------
const REAL_TICK_MS = 4000;

async function realTick() {
  const realRows = await db.prepare("SELECT * FROM queue WHERE source = 'real' AND status IN ('downloading', 'paused')").all();
  if (realRows.length === 0) return;

  const byClient = new Map();
  for (const row of realRows) {
    if (!byClient.has(row.download_client_id)) byClient.set(row.download_client_id, []);
    byClient.get(row.download_client_id).push(row);
  }

  for (const [clientId, rows] of byClient) {
    const client = await getDownloadClient(clientId);
    if (!client) continue; // the client row was deleted from Settings mid-download — leave as last-known state

    const result = await qbittorrent.getTorrents(client, { category: client.category });
    if (!result.ok) {
      logWarn('Queue', `Could not poll "${client.name}" for real queue progress: ${result.error}`);
      continue;
    }
    const byHash = new Map(result.torrents.map((t) => [t.hash, t]));

    // A torrent's real file list (GET /torrents/files) is fetched at most
    // once per hash per tick, not once per row — several rows can share one
    // torrent (a batch grab, see handleBatchGrab), and they'd otherwise each
    // cost their own identical API call for the same torrent. Used both for
    // completion (matching which file is which episode, below) and now for
    // per-row progress while still downloading — see rowProgressPct.
    const filesByHash = new Map();
    async function filesForHash(hash) {
      if (!filesByHash.has(hash)) {
        const filesResult = await qbittorrent.getTorrentFiles(client, hash);
        filesByHash.set(hash, filesResult.ok ? filesResult.files : null);
      }
      return filesByHash.get(hash);
    }

    // Real per-file progress instead of every row in a batch grab showing
    // the exact same whole-torrent percentage. A real, reported case: a
    // 12-episode batch's every episode row read "6%" no matter which file it
    // actually was, because progress came straight from torrents/info's one
    // torrent-level `progress` field — real qBittorrent (and its own WebUI)
    // shows each file advancing at its own rate, not in strict lockstep,
    // since qBittorrent doesn't necessarily download a torrent's files in
    // strict order. GET /torrents/files' own per-file `progress` field (0-1)
    // is exactly that real number — reuses pickFileForEpisode (below, the
    // same match completion already trusts to decide which file gets
    // imported as which episode) rather than a second, separate matching
    // heuristic. Falls back to the torrent's own overall progress — the
    // previous behavior — whenever a specific file can't be confidently
    // matched: a single-video-file torrent (the common single-episode grab
    // shape, where pickFileForEpisode already just returns that one file
    // directly) or a batch match ambiguous enough that pickFileForEpisode
    // itself returns null. Never shows a wrong episode's progress, only ever
    // the same honest "can't tell which file" fallback completion already
    // uses in that case.
    async function rowProgressPct(row, torrent) {
      const episode = await db.prepare('SELECT season_number, num FROM episodes WHERE id = ?').get(row.episode_id);
      if (episode) {
        const files = await filesForHash(row.torrent_hash);
        const file = pickFileForEpisode(files, episode);
        if (file && typeof file.progress === 'number') return Math.round(file.progress * 100);
      }
      return Math.round((torrent.progress || 0) * 100);
    }

    // Real, confirmed miss: completion used to be gated on the whole
    // torrent's own `progress` reaching 1, same field the "still
    // downloading" branch below already knew wasn't good enough for a
    // batch grab's per-row PERCENTAGE (see rowProgressPct's own comment,
    // and pickFileForEpisode/GET torrents/files above it) — but the
    // completion check itself never got the same fix, so a batch's
    // individual episodes kept reporting 100% and "Downloading" at once,
    // stayed in the queue, and kept counting toward the sidebar's active-
    // download badge, until literally every other file in that same
    // torrent also finished — qBittorrent doesn't necessarily download a
    // multi-file torrent's files in lockstep, so one 4.3 GB episode can
    // legitimately sit fully downloaded and importable for many minutes
    // before the batch's last file catches up. This checks THIS row's own
    // file's exact progress (not rounded — rowProgressPct's rounding is
    // fine for a display percentage, but importing a file before it's
    // 100.000% written to disk risks copying a truncated one) and falls
    // back to the torrent-level check only when a specific file can't be
    // confidently matched — the same safety net every other per-file guess
    // in this section already falls back to.
    async function rowIsComplete(row, torrent) {
      const episode = await db.prepare('SELECT season_number, num FROM episodes WHERE id = ?').get(row.episode_id);
      if (episode) {
        const files = await filesForHash(row.torrent_hash);
        const file = pickFileForEpisode(files, episode);
        if (file && typeof file.progress === 'number') return file.progress >= 1;
      }
      return (torrent.progress || 0) >= 1;
    }

    for (const row of rows) {
      const t = row.torrent_hash ? byHash.get(row.torrent_hash) : null;
      if (!t) continue; // still fetching metadata, or removed directly in qBittorrent — leave as-is, don't guess

      if (await rowIsComplete(row, t)) {
        const files = await filesForHash(row.torrent_hash);
        await completeRealDownload(row, t, client, files);
      } else if (t.state === 'error' || t.state === 'missingFiles') {
        await failRealDownload(row, t);
      } else {
        const nextStatus = (t.state === 'pausedDL' || t.state === 'pausedUP') ? 'paused' : 'downloading';
        const nextPct = await rowProgressPct(row, t);
        if (nextPct !== row.progress_pct || nextStatus !== row.status) {
          await db.prepare('UPDATE queue SET progress_pct = ?, status = ? WHERE id = ?').run(nextPct, nextStatus, row.id);
        }
      }
    }
  }
}

// Picks which real file inside a completed torrent's file list is THIS row's
// episode. A single-video-file torrent (the overwhelmingly common shape for
// a single-episode grab) needs no guessing — there's nothing else it could
// be. A multi-file torrent (a batch grab) is matched by parsing each
// candidate filename for a season/episode number the exact same way Library
// Import already does (guessSeasonEpisode — see server/lib/media-files.js);
// a file list that can't be reduced to exactly one confident match (nothing
// found, or two files that both look like this episode) returns null rather
// than guessing wrong — the caller falls back to a placeholder path instead
// of importing the wrong file into the wrong episode's slot.
//
// Real, confirmed case: a "Season 1 + OVA + Extras" batch had its Extras
// folder holding a creditless-ending clip literally named "... EP12
// NCED.mkv" alongside the real "... S01E12.mkv" episode file. Both parse as
// "episode 12" (guessSeasonEpisode's bare `EP12` fallback pattern has no way
// to know this filename's "12" refers to which *episode* the clip is
// attached to, not itself being that episode), and since the NCED clip's own
// guess came back with no season at all, the season-leniency check below let
// it through as a second candidate — two matches where there should only
// ever have been one, so this returned null and episode 12 fell all the way
// back to a placeholder path, while the other 11 real episodes in the same
// batch imported correctly. Fixed by breaking a tie in favor of whichever
// candidate's own filename stated its season explicitly (`S01E12`-shaped,
// `guessSeasonEpisode`'s `confident`-producing regex) over one that only
// matched via the bare-number fallback with no season attached at all — an
// episode's own real file is far more likely to name its season explicitly
// than a same-numbered extras clip is. Only resolves the tie when exactly
// one candidate has this stronger signal; a genuine tie between two equally
// explicit season+episode names still returns null rather than guessing.
function pickFileForEpisode(files, episode) {
  if (!files || files.length === 0) return null;
  const videoFiles = files.filter((f) => isVideoFile(f.name));
  if (videoFiles.length === 0) return null;
  if (videoFiles.length === 1) return videoFiles[0];

  const matches = videoFiles.filter((f) => {
    const guess = guessSeasonEpisode(f.name, null);
    if (guess.episode !== episode.num) return false;
    return guess.season == null || guess.season === episode.season_number;
  });
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    const explicit = matches.filter((f) => guessSeasonEpisode(f.name, null).season != null);
    if (explicit.length === 1) return explicit[0];
  }
  return null;
}

async function completeRealDownload(row, torrent, client, files) {
  await db.prepare('DELETE FROM queue WHERE id = ?').run(row.id);

  // Full row (not just title/path) — episodeFileNameFor/seriesFolderNameFor
  // (see episode-paths.js, called below via importEpisodeFile) need
  // series_type (to choose Standard vs. Anime format) and meta (for the
  // {Series Year} token); a narrower SELECT here silently meant every real
  // import always fell back to the Standard format regardless of what
  // Series Type was actually set, since series.seriesType (camelCase, what
  // that code checks) was never even in the row to begin with.
  const series = await db.prepare('SELECT * FROM series WHERE id = ?').get(row.series_id);
  const episode = await db.prepare('SELECT season_number, num, title FROM episodes WHERE id = ?').get(row.episode_id);
  const episodeLabel = episode ? `S${String(episode.season_number).padStart(2, '0')}E${String(episode.num).padStart(2, '0')}` : '';
  const seriesTitle = series ? series.title : 'Unknown series';

  // Real, confirmed bug: this used to default to `torrent.total_size || row.size_bytes`
  // — both of which are the WHOLE torrent/release's size, never this one
  // episode's real share of it (`row.size_bytes` is copied from the same
  // batch-level release object onto every episode's queue row at grab time —
  // see insertBatchGrab — so it's just as wrong as total_size for this
  // purpose, not a real per-episode fallback). Harmless for a genuinely
  // single-video-file torrent (a single-episode grab, where the torrent's
  // total size and that one file's size are the same number anyway), but a
  // real, reported case showed exactly the failure mode: a batch episode
  // that couldn't be matched/imported (see pickFileForEpisode) recorded the
  // *entire* "Season 1 + OVA + Extras" batch's 4.68 GB against that one
  // episode, both in its own Media Info and in the series' total Size stat
  // card, which sums every episode's sizeBytes. Only trusts total_size as
  // this episode's size when `files` (the torrent's real listing) confirms
  // there's genuinely just one video file in the whole torrent; otherwise
  // this stays null until/unless a real per-file import below sets the real
  // number — same "unknown beats confidently wrong" rule every other
  // best-effort guess in this app already follows, rather than falling back
  // to a number that's off by an order of magnitude.
  const singleFileTorrent = files && files.filter((f) => isVideoFile(f.name)).length === 1;
  let sizeBytes = singleFileTorrent ? torrent.total_size : null;
  let filePath = null;
  let importNote = null;
  let mediaStreams = null;
  // Starts as the release's own grab-time guess (a real indexer's parsed
  // title, or this app's simulated pick when no real indexer was involved
  // either way) — corrected below, before importEpisodeFile runs, whenever
  // a real probe of the actual downloaded file disagrees. Kept as its own
  // variable rather than overwriting row.quality: row.quality is also what
  // got recorded on the earlier "grabbed" history entry, and that one
  // genuinely did reflect the grab-time guess — only what actually gets
  // imported/persisted should reflect the correction.
  let quality = row.quality;

  if (series && episode && client) {
    const file = pickFileForEpisode(files, episode);
    if (!file) {
      importNote = files
        ? `Could not tell which file in "${row.release_title}" is ${episodeLabel} — recorded a placeholder path instead of importing.`
        : `Could not list files for "${row.release_title}" on "${client.name}" — recorded a placeholder path instead of importing.`;
    } else {
      // save_path/file.name are both in the DOWNLOAD CLIENT's own path
      // convention, not necessarily Kitsune's — resolveLocalPath translates
      // through Settings > Download Clients' Remote Path Mapping when one's
      // configured, or assumes the same filesystem when it isn't (see
      // server/lib/remote-path.js).
      const remoteSourcePath = joinRemotePath(torrent.save_path, file.name);
      const localSourcePath = resolveLocalPath(client, remoteSourcePath);
      // Probed at the SOURCE path, before importEpisodeFile runs — not
      // after, at the destination. Real per-file audio/subtitle tracks plus
      // the real video stream's own width/height (see lib/ffprobe.js); null
      // when ffprobe isn't installed or the probe fails, same "unknown, not
      // a guess" treatment as everything else a real import couldn't
      // confirm. Probing first means a confirmed real resolution can
      // correct `quality` (the release's own grab-time guess) before
      // importEpisodeFile uses it to build the renamed destination
      // filename — same "a real file beats a text guess" rule
      // guessQualityTierName's own comment describes, just reusing the
      // release title as the "filename" text to still pull a source
      // (WEBDL/Bluray/HDTV/...) guess from, since there's no signal for
      // that in the video bytes either way. Falls back to the original
      // row.quality untouched whenever nothing was confirmed, rather than
      // re-deriving a full guess that might disagree with what a real
      // indexer's own parsing already decided at grab time.
      mediaStreams = await probeMediaStreams(localSourcePath);
      const probedResolutionGroup = mediaStreams && mediaStreams.video ? resolutionGroupFromHeight(mediaStreams.video.height) : null;
      if (probedResolutionGroup) {
        quality = (await guessQualityTierName(row.release_title, probedResolutionGroup)) || row.quality;
      }
      const imported = await importEpisodeFile(series, episode, quality, localSourcePath);
      if (imported.ok) {
        filePath = imported.path;
        sizeBytes = imported.sizeBytes;
      } else {
        importNote = `Could not import the real file for "${row.release_title}" (${episodeLabel}) — ${imported.error}. Recorded a placeholder path instead.`;
      }
    }
  }
  if (importNote) logWarn('Queue', importNote);
  // Real import never fully blocks this from resolving as a completed,
  // imported download — the same graceful-degradation rule every other real
  // integration in this app already follows (see this module's header
  // comment). A placeholder path is exactly what this field always held
  // before real import existed, so a setup that can't reach real files yet
  // (no Remote Path Mapping configured across two separate machines, say)
  // behaves exactly as it always did rather than breaking.
  if (!filePath) {
    filePath = series && episode ? await buildEpisodeFilePath(series, episode, quality) : null;
  }

  await db.prepare('UPDATE episodes SET downloaded = 1, quality = ?, size_bytes = ?, path = ?, media_streams = ? WHERE id = ?')
    .run(quality, sizeBytes, filePath, mediaStreams ? JSON.stringify(mediaStreams) : null, row.episode_id);
  await recomputeSeriesEpisodeStats(row.series_id);
  await insertHistoryRow({
    seriesId: row.series_id, episodeId: row.episode_id, eventType: 'imported',
    releaseTitle: row.release_title, quality, indexer: row.indexer, sizeBytes,
    message: importNote,
  });
  logInfo('Queue', `Imported "${row.release_title}" — real qBittorrent download complete${importNote ? '' : ', file hardlinked/copied into the Library'}`);
  notifyConnections('import', `${seriesTitle} ${episodeLabel} — ${row.release_title} (${quality})`);
}

async function failRealDownload(row, torrent) {
  await db.prepare('DELETE FROM queue WHERE id = ?').run(row.id);

  const series = await db.prepare('SELECT title FROM series WHERE id = ?').get(row.series_id);
  const episode = await db.prepare('SELECT season_number, num FROM episodes WHERE id = ?').get(row.episode_id);
  const episodeLabel = episode ? `S${String(episode.season_number).padStart(2, '0')}E${String(episode.num).padStart(2, '0')}` : '';
  const seriesTitle = series ? series.title : 'Unknown series';
  const reason = torrent.state === 'missingFiles' ? 'qBittorrent reported missing files' : 'qBittorrent reported an error';

  await insertHistoryRow({
    seriesId: row.series_id, episodeId: row.episode_id, eventType: 'failed',
    releaseTitle: row.release_title, quality: row.quality, indexer: row.indexer, sizeBytes: row.size_bytes,
    message: `Download failed — ${reason}`,
  });
  await insertBlocklistRow({
    seriesId: row.series_id, episodeId: row.episode_id, releaseTitle: row.release_title,
    reason: 'Failed download', indexer: row.indexer,
  });
  logWarn('Queue', `Real download failed: "${row.release_title}" (${reason}) — blocklisted`);
  notifyConnections('fail', `${seriesTitle} ${episodeLabel} — ${row.release_title} failed (${reason})`);
}

setInterval(() => { realTick().catch((err) => logWarn('Queue', `realTick failed: ${err.message}`)); }, REAL_TICK_MS);

module.exports = { handleQueueApi };
