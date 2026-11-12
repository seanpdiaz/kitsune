// ---------------------------------------------------------------------------
// GET /api/system/statistics — everything System > Statistics shows, in one
// response (see frontend/pages/system-statistics/ and wiki/System-Statistics.md).
//
// Every number comes from data Kitsune already keeps: the series and
// episodes tables, the history table, ffprobe's media_streams JSON on each
// episode, and statfs on each root folder. Nothing new is stored.
//
// Aggregation happens here in JS rather than in SQL on purpose: the same
// code then works unchanged on SQLite and Postgres (no date functions or
// JSON operators that differ between the two), and even a large library is
// only a few thousand episode rows. The result is cached for a minute so
// reloading the page doesn't redo the work; ?fresh=1 (the page's
// Recalculate button) skips the cache.
// ---------------------------------------------------------------------------

const fs = require('fs');
const path = require('path');
const db = require('../db');
const { sendJson } = require('../lib/http');
const { computeRootFolderStats } = require('../lib/fs-helpers');
const { requireAdmin } = require('./auth');

const CACHE_MS = 60 * 1000;
const DEFAULT_EPISODE_MINUTES = 24;
const HEATMAP_WEEKS = 26;
const DAY_MS = 86400000;

let cache = null; // { at, data }

function todayIso() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// history.created_at is db.now()'s "YYYY-MM-DD HH:MM:SS" in UTC.
function parseDbTime(s) {
  if (!s) return NaN;
  return Date.parse(String(s).replace(' ', 'T') + (String(s).endsWith('Z') ? '' : 'Z'));
}

function utcDayKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

function monthKey(ms) {
  return new Date(ms).toISOString().slice(0, 7);
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// series.meta is "2023 · Adventure, Drama · TV · 24 min eps" (any part can
// be missing; real metadata often only has "2023 · TV").
function parseMeta(meta) {
  const text = String(meta || '');
  const year = (text.match(/^\s*(\d{4})/) || [])[1];
  const minutes = (text.match(/(\d+)\s*min/i) || [])[1];
  return { year: year ? Number(year) : null, minutes: minutes ? Number(minutes) : null };
}

function premiereBin(year, currentYear) {
  if (year <= 1999) return '≤1999';
  if (year < 2020) {
    const start = year - (year % 5);
    return `${String(start).slice(2)}–${String(start + 4).slice(2)}`;
  }
  return year > currentYear ? String(currentYear) : String(year);
}

function premiereBinOrder(currentYear) {
  const bins = ['≤1999', '00–04', '05–09', '10–14', '15–19'];
  for (let y = 2020; y <= currentYear; y++) bins.push(String(y));
  return bins;
}

// "[SubsPlease] Frieren - 01 (1080p) [ABCD1234].mkv" -> "SubsPlease"
// "Frieren.S01E01.1080p.WEB-DL.AAC2.0.H.264-VARYG"   -> "VARYG"
function releaseGroup(title) {
  const t = String(title || '').trim();
  if (!t) return null;
  const bracket = t.match(/^\[([^\]]+)\]/);
  if (bracket) return bracket[1].trim();
  const dash = t.replace(/\.(mkv|mp4|avi)$/i, '').match(/-([A-Za-z0-9]+)$/);
  return dash ? dash[1] : null;
}

function parseStreams(json) {
  if (!json) return null;
  try { return JSON.parse(json); } catch { return null; }
}

function audioBucket(streams) {
  const langs = (streams.audio || []).map((a) => String(a.language || '').toLowerCase());
  if (langs.length === 0) return 'None';
  const jp = langs.some((l) => l.startsWith('jap') || l === 'jpn' || l === 'ja');
  const other = langs.some((l) => !(l.startsWith('jap') || l === 'jpn' || l === 'ja'));
  if (jp && other) return 'Dual audio';
  if (jp) return 'Japanese only';
  return 'Other';
}

function subtitleBucket(streams) {
  const subs = streams.subtitles || [];
  if (subs.length === 0) return 'None';
  const main = subs.find((s) => s.default) || subs[0];
  const codec = String(main.codec || 'Unknown').toUpperCase();
  if (codec === 'SUBRIP') return 'SRT';
  if (codec.includes('PGS') || codec === 'HDMV_PGS_SUBTITLE') return 'PGS';
  return codec;
}

function videoBucket(streams) {
  const codec = streams.video && streams.video.codec ? String(streams.video.codec).toUpperCase() : null;
  if (!codec) return 'Unknown';
  if (codec === 'H264') return 'AVC';
  if (codec === 'H265') return 'HEVC';
  return codec;
}

function toParts(counter, total, limit = 4) {
  const sorted = [...counter.entries()].sort((a, b) => b[1] - a[1]);
  const head = sorted.slice(0, limit);
  const rest = sorted.slice(limit).reduce((n, [, c]) => n + c, 0);
  if (rest > 0) head.push(['Other', rest]);
  return head.map(([name, count]) => ({ name, count, pct: total ? (count / total) * 100 : 0 }));
}

async function dirSize(dir) {
  let total = 0;
  let entries;
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) {
      try { total += (await fs.promises.stat(p)).size; } catch { /* vanished mid-walk */ }
    }
  }
  return total;
}

async function fileSize(p) {
  if (!p) return 0;
  try { return (await fs.promises.stat(p)).size; } catch { return 0; }
}

async function computeStatistics() {
  const now = Date.now();
  const today = todayIso();
  const currentYear = new Date().getFullYear();

  const series = await db.prepare(`
    SELECT id, title, status, air_status, monitored, meta, ignore_specials, created_at
    FROM series
  `).all();
  const episodes = await db.prepare(`
    SELECT id, series_id, season_number, downloaded, quality, size_bytes, aired, media_streams, path
    FROM episodes
  `).all();
  const history = await db.prepare(`
    SELECT episode_id, event_type, created_at, size_bytes, release_title, indexer
    FROM history
  `).all();

  const seriesById = new Map(series.map((s) => [s.id, { ...s, ...parseMeta(s.meta) }]));

  // ---- Series ----
  let airing = 0, finished = 0, upcoming = 0;
  for (const s of series) {
    if (/not yet/i.test(s.air_status || '')) upcoming++;
    else if (s.status === 'continuing') airing++;
    else finished++;
  }

  // ---- Episodes ----
  let onDisk = 0, monitoredAired = 0, monitoredAiredHave = 0, missingRecent = 0;
  let libraryBytes = 0, sizedFiles = 0, runtimeMinutes = 0, probed = 0;
  const recentCutoff = utcDayKey(now - 30 * DAY_MS);
  const quality = new Map();
  const video = new Map(), audio = new Map(), subs = new Map();
  const bySeries = new Map();
  const downloadedIds = new Set();
  const episodeSize = new Map();

  for (const e of episodes) {
    const s = seriesById.get(e.series_id);
    if (!s) continue;
    const countsForWanted = s.monitored && e.aired && e.aired <= today && (!s.ignore_specials || e.season_number > 0);
    if (countsForWanted) {
      monitoredAired++;
      if (e.downloaded) monitoredAiredHave++;
      else if (e.aired >= recentCutoff) missingRecent++;
    }
    if (!e.downloaded) continue;

    onDisk++;
    downloadedIds.add(e.id);
    const size = Number(e.size_bytes) || 0;
    if (size > 0) { libraryBytes += size; sizedFiles++; episodeSize.set(e.id, size); }
    runtimeMinutes += s.minutes || DEFAULT_EPISODE_MINUTES;
    const q = e.quality || 'Unknown';
    quality.set(q, (quality.get(q) || 0) + 1);

    const agg = bySeries.get(e.series_id) || { bytes: 0, episodes: 0 };
    agg.bytes += size; agg.episodes++;
    bySeries.set(e.series_id, agg);

    const streams = parseStreams(e.media_streams);
    if (streams) {
      probed++;
      const v = videoBucket(streams); video.set(v, (video.get(v) || 0) + 1);
      const a = audioBucket(streams); audio.set(a, (audio.get(a) || 0) + 1);
      const t = subtitleBucket(streams); subs.set(t, (subs.get(t) || 0) + 1);
    }
  }

  // ---- History: activity, growth, release groups, indexers ----
  const heatStart = (() => {
    const d = new Date(now);
    const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
    const monday = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - dow * DAY_MS;
    return monday - (HEATMAP_WEEKS - 1) * 7 * DAY_MS;
  })();
  const dailyImports = new Map();
  const monthlyImports = new Map();
  const yearlyImports = new Map();
  const totals = { grabbed: 0, imported: 0, failed: 0, importedBytes: 0 };
  const indexers = new Map();
  const latestImportByEpisode = new Map(); // episode_id -> { at, title }
  let firstEventAt = Infinity;

  for (const h of history) {
    const at = parseDbTime(h.created_at);
    if (!Number.isFinite(at)) continue;
    firstEventAt = Math.min(firstEventAt, at);
    const inWindow = at >= heatStart;
    if (h.event_type === 'imported') {
      const bytes = Number(h.size_bytes) || 0;
      const mk = monthKey(at), yk = mk.slice(0, 4);
      monthlyImports.set(mk, (monthlyImports.get(mk) || 0) + 1);
      yearlyImports.set(yk, (yearlyImports.get(yk) || 0) + 1);
      if (inWindow) {
        const dk = utcDayKey(at);
        dailyImports.set(dk, (dailyImports.get(dk) || 0) + 1);
        totals.imported++;
        totals.importedBytes += bytes;
        const ix = h.indexer || 'Unknown';
        indexers.set(ix, (indexers.get(ix) || 0) + 1);
      }
      if (h.episode_id != null) {
        const prev = latestImportByEpisode.get(h.episode_id);
        if (!prev || at >= prev.at) latestImportByEpisode.set(h.episode_id, { at, title: h.release_title });
      }
    } else if (inWindow && h.event_type === 'grabbed') totals.grabbed++;
    else if (inWindow && h.event_type === 'failed') totals.failed++;
  }

  const heatmap = [];
  for (let t = heatStart; t <= now; t += DAY_MS) {
    const dk = utcDayKey(t);
    heatmap.push({ date: dk, count: dailyImports.get(dk) || 0 });
  }

  // Library size over time, built from what's on disk TODAY: each on-disk
  // episode counts from the month its current file was imported (its
  // latest import in history). Files with no import record (Library Import
  // of existing files, or history since pruned by History Retention) count
  // as already there at the start. Using today's files rather than summing
  // import events keeps re-imports, upgrades and since-deleted episodes from
  // inflating the line past the real library size.
  const arrivedBytesByMonth = new Map();
  for (const id of downloadedIds) {
    const imp = latestImportByEpisode.get(id);
    const size = episodeSize.get(id) || 0;
    if (!imp || !size) continue;
    const mk = monthKey(imp.at);
    arrivedBytesByMonth.set(mk, (arrivedBytesByMonth.get(mk) || 0) + size);
  }
  function monthKeysBetween(fromMs, count) {
    const keys = [];
    const d = new Date(fromMs);
    for (let i = 0; i < count; i++) {
      keys.push(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, 1)).toISOString().slice(0, 7));
    }
    return keys;
  }
  // Library size at the end of `key` = today's size minus what arrived after it.
  function sizeAtEndOf(key) {
    let after = 0;
    for (const [mk, bytes] of arrivedBytesByMonth) if (mk.slice(0, key.length) > key) after += bytes;
    return Math.max(0, libraryBytes - after);
  }
  const nowD = new Date(now);
  const monthKeys = monthKeysBetween(Date.UTC(nowD.getUTCFullYear(), nowD.getUTCMonth() - 11, 1), 12);
  const monthLabel = (k) => MONTH_NAMES[Number(k.slice(5, 7)) - 1];
  const monthly = monthKeys.map((k) => ({ key: k, label: monthLabel(k), imports: monthlyImports.get(k) || 0, sizeBytes: sizeAtEndOf(k) }));

  // All time: by month when there's two years or less of history to show
  // (a single yearly bar says nothing), by year beyond that.
  const firstAt = Math.min(
    Number.isFinite(firstEventAt) ? firstEventAt : now,
    ...series.map((s) => parseDbTime(s.created_at)).filter(Number.isFinite),
  );
  const firstD = new Date(firstAt);
  const spanMonths = (nowD.getUTCFullYear() - firstD.getUTCFullYear()) * 12 + (nowD.getUTCMonth() - firstD.getUTCMonth()) + 1;
  let allTime;
  let allTimeUnit;
  if (spanMonths <= 24) {
    allTimeUnit = 'month';
    allTime = monthKeysBetween(Date.UTC(firstD.getUTCFullYear(), firstD.getUTCMonth(), 1), Math.max(spanMonths, 1)).map((k) => ({
      key: k,
      label: k.slice(5, 7) === '01' || k === monthKeysBetween(firstAt, 1)[0] ? `${monthLabel(k)} '${k.slice(2, 4)}` : monthLabel(k),
      imports: monthlyImports.get(k) || 0,
      sizeBytes: sizeAtEndOf(k),
    }));
  } else {
    allTimeUnit = 'year';
    allTime = [];
    for (let y = Math.max(firstD.getUTCFullYear(), nowD.getUTCFullYear() - 14); y <= nowD.getUTCFullYear(); y++) {
      const k = String(y);
      allTime.push({ key: k, label: k, imports: yearlyImports.get(k) || 0, sizeBytes: sizeAtEndOf(k) });
    }
  }
  const last12Bytes = monthKeys.reduce((n, k) => n + (arrivedBytesByMonth.get(k) || 0), 0);

  // Release groups: what's on disk now, attributed by the release title it
  // was last imported from (renamed files no longer carry the group).
  const groups = new Map();
  let groupedFiles = 0;
  const episodePathById = new Map(episodes.map((e) => [e.id, e.path]));
  for (const id of downloadedIds) {
    const imp = latestImportByEpisode.get(id);
    // Fallback to the file name, for naming formats that keep the group.
    const fromPath = episodePathById.get(id) ? releaseGroup(path.basename(episodePathById.get(id))) : null;
    const g = (imp && releaseGroup(imp.title)) || (fromPath && /^[A-Za-z][\w.&-]{1,24}$/.test(fromPath) ? fromPath : null) || 'Unknown';
    const agg = groups.get(g) || { episodes: 0, bytes: 0, sized: 0 };
    agg.episodes++;
    const sz = episodeSize.get(id) || 0;
    if (sz) { agg.bytes += sz; agg.sized++; }
    groups.set(g, agg);
    groupedFiles++;
  }
  const groupRows = [...groups.entries()]
    .filter(([name]) => name !== 'Unknown')
    .sort((a, b) => b[1].episodes - a[1].episodes);
  const topGroups = groupRows.slice(0, 5).map(([name, g]) => ({
    name, episodes: g.episodes, avgBytes: g.sized ? g.bytes / g.sized : null, share: groupedFiles ? (g.episodes / groupedFiles) * 100 : 0,
  }));
  const otherGroups = groupRows.slice(5);
  const unknownGroup = groups.get('Unknown');
  if (otherGroups.length || unknownGroup) {
    const rest = [...otherGroups.map(([, g]) => g), ...(unknownGroup ? [unknownGroup] : [])]
      .reduce((acc, g) => ({ episodes: acc.episodes + g.episodes, bytes: acc.bytes + g.bytes, sized: acc.sized + g.sized }), { episodes: 0, bytes: 0, sized: 0 });
    const label = otherGroups.length
      ? `Other (${otherGroups.length} group${otherGroups.length === 1 ? '' : 's'}${unknownGroup ? ' + unknown' : ''})`
      : 'Group unknown';
    topGroups.push({ name: label, episodes: rest.episodes, avgBytes: rest.sized ? rest.bytes / rest.sized : null, share: groupedFiles ? (rest.episodes / groupedFiles) * 100 : 0, isOther: true });
  }

  // ---- Premiere years ----
  const yearCounts = new Map();
  let unknownYear = 0;
  for (const s of seriesById.values()) {
    if (!s.year) { unknownYear++; continue; }
    const bin = premiereBin(s.year, currentYear);
    yearCounts.set(bin, (yearCounts.get(bin) || 0) + 1);
  }
  const premiereYears = premiereBinOrder(currentYear).map((label) => ({ label, count: yearCounts.get(label) || 0 }));

  // ---- Largest series ----
  const largest = [...bySeries.entries()]
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 6)
    .map(([id, agg]) => ({ id, title: (seriesById.get(id) || {}).title || 'Unknown', episodes: agg.episodes, bytes: agg.bytes }));

  // ---- Disk ----
  const rootFolders = (await db.prepare("SELECT data FROM settings_items WHERE section = 'root-folders'").all())
    .map((row) => { try { return JSON.parse(row.data); } catch { return null; } })
    .filter((rf) => rf && rf.path);
  const last90Cutoff = now - 90 * DAY_MS;
  const recentBytesByEpisode = new Map();
  for (const h of history) {
    if (h.event_type !== 'imported' || h.episode_id == null) continue;
    if (parseDbTime(h.created_at) >= last90Cutoff) recentBytesByEpisode.set(h.episode_id, Number(h.size_bytes) || 0);
  }
  const disk = await Promise.all(rootFolders.map(async (rf) => {
    const stats = await computeRootFolderStats(rf.path);
    const prefix = rf.path.endsWith('/') ? rf.path : rf.path + '/';
    let libBytes = 0, recent = 0;
    for (const e of episodes) {
      if (!e.downloaded || !e.path || !e.path.startsWith(prefix)) continue;
      libBytes += Number(e.size_bytes) || 0;
      recent += recentBytesByEpisode.get(e.id) || 0;
    }
    const perMonth = recent / 3;
    return {
      path: rf.path,
      totalBytes: stats.totalBytes,
      freeBytes: stats.freeBytes,
      usedBytes: stats.usedBytes,
      libraryBytes: libBytes,
      monthsUntilFull: stats.freeBytes != null && perMonth > 0 ? stats.freeBytes / perMonth : null,
    };
  }));

  const dbFile = db.DB_PATH || null;
  const dbBytes = dbFile ? (await fileSize(dbFile)) + (await fileSize(dbFile + '-wal')) : null;
  const backupsBytes = await dirSize(path.join(db.DATA_DIR, 'backups'));

  return {
    generatedAt: new Date(now).toISOString(),
    summary: {
      series: series.length,
      airing, finished, upcoming,
      episodesOnDisk: onDisk,
      monitoredAired,
      monitoredAiredHave,
      missing: monitoredAired - monitoredAiredHave,
      missingRecent,
      libraryBytes,
      last12MonthsBytes: last12Bytes,
      runtimeMinutes,
      avgEpisodeBytes: sizedFiles ? libraryBytes / sizedFiles : null,
      probedFiles: probed,
    },
    growth: { monthly, allTime, allTimeUnit },
    quality: [...quality.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    formats: probed ? {
      video: toParts(video, probed),
      audio: toParts(audio, probed),
      subtitles: toParts(subs, probed),
    } : null,
    premiereYears,
    unknownPremiereYear: unknownYear,
    activity: {
      weeks: HEATMAP_WEEKS,
      startDate: utcDayKey(heatStart),
      days: heatmap,
      ...totals,
      indexers: [...indexers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name, count]) => ({ name, count })),
    },
    largest,
    releaseGroups: topGroups,
    disk,
    config: { dbBytes, backupsBytes, isPostgres: !dbFile },
  };
}

async function handleSystemStatisticsApi(req, res, urlPath) {
  if (req.method !== 'GET' || urlPath !== '/api/system/statistics') return false;
  if (!(await requireAdmin(req, res))) return true;

  const fresh = /[?&]fresh=1\b/.test(req.url);
  if (!fresh && cache && Date.now() - cache.at < CACHE_MS) {
    sendJson(res, 200, cache.data);
    return true;
  }
  const data = await computeStatistics();
  cache = { at: Date.now(), data };
  sendJson(res, 200, data);
  return true;
}

module.exports = { handleSystemStatisticsApi, computeStatistics };
