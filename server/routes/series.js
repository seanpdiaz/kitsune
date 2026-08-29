const fs = require('fs');
const path = require('path');
const db = require('../db');
const { logInfo, logWarn } = require('../logger');
const { sendJson, readJsonBody } = require('../lib/http');
const { normalizeFolderName } = require('../lib/fs-helpers');
const { sanitizeForPath } = require('../lib/episode-paths');
const { recomputeSeriesEpisodeStats } = require('../lib/series-stats');
const { warmEpisodesInBackground } = require('./episodes');

// ---------------------------------------------------------------------------
// Library persistence (the `series` table)
//
// This used to be a hardcoded array in app.js (`seriesData`) with no way for
// anything to actually land in it — the Add New page's "Add Series" button
// just toggled a local checkmark that vanished the moment you navigated
// away, since app.js (and its array) reloads from scratch on every page.
// Same pattern as Tags/Settings: a real table, a small REST surface, and
// app.js now fetches from here instead of holding the data itself.
// ---------------------------------------------------------------------------

// Allowed values for the two enum-style dropdowns in the Edit Series modal —
// validated in the PATCH handler below, and the same lists app.js uses to
// populate the <select> options (kept in sync by hand, same as the rest of
// this file's option lists).
const MONITOR_NEW_SEASONS_OPTIONS = ['all', 'future', 'none'];
const SERIES_TYPE_OPTIONS = ['anime', 'standard', 'daily'];

// A search result's raw `status` field (see mapMalOfficialResult in
// server/lib/mal.js and mapTvdbResult in server/lib/tvdb.js — both already
// fetch this for the Add New preview modal's tag, but it stopped there:
// nothing persisted it once a series was actually added, and POST
// /api/series always hardcoded status: 'continuing' regardless of what the
// real show's status was). MAL's official API returns snake_case machine
// values; TVDB's are already display-ready English words. Mapped here into
// one consistent, source-specific display label for air_status (what the
// Next airing stat shows when there's no next episode date — see
// frontend/pages/series/SeriesPage.jsx and LibraryGridPage.jsx), plus this
// app's own plain continuing/ended
// binary for the existing `status` column, which filter tabs and badges
// elsewhere already depend on and shouldn't have to learn six new values.
const MAL_STATUS_LABELS = {
  finished_airing: 'Finished Airing',
  currently_airing: 'Currently Airing',
  not_yet_aired: 'Not Yet Aired',
};
const ENDED_STATUS_KEYS = new Set(['finished_airing', 'ended']);

function deriveAirStatus(rawStatus, source) {
  if (!rawStatus) return { airStatus: null, status: 'continuing' };
  const key = String(rawStatus).trim().toLowerCase();
  const airStatus = source === 'mal'
    ? (MAL_STATUS_LABELS[key] || String(rawStatus))
    : String(rawStatus); // TVDB (or anything else): already a readable label
  return { airStatus, status: ENDED_STATUS_KEYS.has(key) ? 'ended' : 'continuing' };
}

// series.path (shown read-only in the Edit Series modal — see
// SeriesPage.jsx) used to only ever get set if someone opened that modal
// and typed/saved one by hand; a freshly-added series had no real path at
// all until then, and the modal papered over that by prefilling a
// client-side-only "/mnt/anime/<title>" guess that was never actually
// persisted — indistinguishable from a real value in the UI, but gone the
// moment you looked at the raw series row.
//
// Real Sonarr/Radarr assign a path immediately when a series is added,
// picked from a chosen root folder — this does the same using whichever
// root folder is first in Settings > Media Management's list (the same
// "no per-add picker yet" simplification findExistingSeriesFolder in
// routes/episodes.js already makes when scanning). If no root folder is
// configured at all, path stays null — there's no real location to claim
// yet, and leaving it null (rather than a fabricated guess) is what lets
// the Edit modal show an honest "no root folder configured" state instead
// of a path that doesn't exist anywhere.
async function firstConfiguredRootFolder() {
  const row = await db.prepare("SELECT data FROM settings_items WHERE section = 'root-folders' ORDER BY position ASC LIMIT 1").get();
  if (!row) return null;
  try {
    return JSON.parse(row.data).path || null;
  } catch {
    return null;
  }
}
// Add New's Root Folder dropdown (frontend/pages/library-add-new/
// AddNewPage.jsx) used to be two hardcoded, never-wired-up <option>s left
// over from the original static mockup — picking one had zero effect;
// every series landed under whichever root folder happened to be first
// configured, regardless of what was selected on screen. This is what
// actually honors a real choice now: `requestedPath` (POST /api/series'
// `body.rootFolder`) is only trusted if it exactly matches one of the real
// configured root folders (the same list GET /api/settings-items/
// root-folders returns, which is all the dropdown ever offers) — never
// passed straight through to a filesystem path unchecked, since that would
// let any other caller of this same API point a new series at an arbitrary
// directory. A request with no rootFolder, or one that doesn't match a real
// configured folder (stale client state, a folder removed after the page
// loaded), falls back to the first configured one exactly like this always
// did before, with a warning logged only for the "didn't match" case — a
// plain omission is the normal, expected shape for every other existing
// caller of this endpoint.
async function resolveRootFolder(requestedPath) {
  const configured = (await db.prepare("SELECT data FROM settings_items WHERE section = 'root-folders' ORDER BY position ASC").all())
    .map((row) => { try { return JSON.parse(row.data).path; } catch { return null; } })
    .filter(Boolean);
  if (requestedPath) {
    if (configured.includes(requestedPath)) return requestedPath;
    logWarn('SeriesService', `Requested root folder "${requestedPath}" isn't a configured root folder — falling back to the first configured one.`);
  }
  return configured[0] || null;
}
async function defaultSeriesPathFor(title, requestedRootFolder) {
  const rootFolder = await resolveRootFolder(requestedRootFolder);
  if (!rootFolder) return null;
  return path.join(rootFolder, sanitizeForPath(title) || 'Unknown Series');
}

// Settings > Profiles' "Default for new series" toggle (see
// frontend/pages/settings-profiles/ProfilesPage.jsx) — stored by profile id,
// not name, under the generic app_settings 'library-defaults' section
// (server/routes/app-settings.js's PUT /api/app-settings/:section), so
// renaming a profile that's currently the default doesn't silently detach it
// the way storing the name itself would. Looked up fresh here rather than
// cached: nothing in this file already tracks live view of app_settings, and
// this only runs once per series-add, not on any hot path.
async function getDefaultQualityProfileName() {
  const row = await db.prepare("SELECT data FROM app_settings WHERE section = 'library-defaults'").get();
  if (!row) return null;
  let defaultId;
  try {
    defaultId = JSON.parse(row.data).defaultQualityProfileId;
  } catch {
    return null;
  }
  if (defaultId == null) return null;
  const profileRow = await db.prepare("SELECT data FROM settings_items WHERE section = 'profiles' AND id = ?").get(defaultId);
  // The profile marked default has since been deleted (or the id is stale) —
  // no real default to fall back to; resolveQualityProfile below falls
  // through to the first configured profile instead, same as a never-set
  // default.
  if (!profileRow) return null;
  try {
    return JSON.parse(profileRow.data).name || null;
  } catch {
    return null;
  }
}

// Same shape as resolveRootFolder above, one level simpler: an explicit
// `requestedName` (Add New's dropdown, or any other caller) is always
// trusted as-is — same "the UI only ever offers real Settings > Profiles
// names" convention this already used before defaults existed — and only a
// missing/empty one falls back, first to the configured default, then to
// whichever profile is first in Settings > Profiles' own list (position
// order), the same "no default set yet" behavior this had before this
// feature existed.
async function resolveQualityProfile(requestedName) {
  if (requestedName) return requestedName;
  const defaultName = await getDefaultQualityProfileName();
  if (defaultName) return defaultName;
  const firstRow = await db.prepare("SELECT data FROM settings_items WHERE section = 'profiles' ORDER BY position ASC, id ASC LIMIT 1").get();
  if (!firstRow) return null;
  try {
    return JSON.parse(firstRow.data).name || null;
  } catch {
    return null;
  }
}

// Same 'library-defaults' section as the quality-profile default above, own
// key (see Settings > Media Management's "New Series Defaults" card) — a
// plain boolean rather than an id, since there's nothing here that can be
// renamed/deleted out from under it the way a quality profile can. Missing
// row, missing key, or malformed JSON all mean "no default configured yet",
// same as a fresh install — new series keep their existing ignore_specials=0
// schema default until someone turns this on.
async function getDefaultIgnoreSpecials() {
  const row = await db.prepare("SELECT data FROM app_settings WHERE section = 'library-defaults'").get();
  if (!row) return false;
  try {
    return !!JSON.parse(row.data).defaultIgnoreSpecials;
  } catch {
    return false;
  }
}

// POST /api/series has no UI-exposed way to set ignoreSpecials per-add today
// (unlike qualityProfile/rootFolder) — `requested` only matters for a
// non-UI caller (a future per-add checkbox, direct API use) that passes it
// explicitly; every real add today falls straight through to the configured
// default.
async function resolveIgnoreSpecials(requested) {
  if (requested !== undefined && requested !== null) return requested ? 1 : 0;
  return (await getDefaultIgnoreSpecials()) ? 1 : 0;
}

db.init(async () => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS series (
      id ${db.PK},
      title TEXT NOT NULL,
      badge TEXT,
      fill TEXT NOT NULL DEFAULT 'accent',
      pct INTEGER NOT NULL DEFAULT 0,
      eps TEXT NOT NULL DEFAULT '0 / 0',
      monitored INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'continuing',
      air_status TEXT,
      next_air_days INTEGER,
      added_days_ago INTEGER NOT NULL DEFAULT 0,
      poster TEXT,
      meta TEXT,
      overview TEXT,
      monitor_new_seasons TEXT NOT NULL DEFAULT 'all',
      season_folder INTEGER NOT NULL DEFAULT 1,
      quality_profile TEXT,
      series_type TEXT NOT NULL DEFAULT 'anime',
      path TEXT,
      ignore_specials INTEGER NOT NULL DEFAULT 0,
      created_at TEXT
    )
  `);

  // Many-to-many series <-> tags, backing the Edit Series modal's Tags field.
  // No foreign keys (consistent with the rest of this schema — nothing else
  // here enforces them either), but series/tag deletion below both clean up
  // their side of this table so it can't accumulate orphaned rows pointing at
  // an id that no longer exists.
  await db.exec(`
    CREATE TABLE IF NOT EXISTS series_tags (
      series_id INTEGER NOT NULL,
      tag_id INTEGER NOT NULL,
      PRIMARY KEY (series_id, tag_id)
    )
  `);

// One-time seed of the mockup's original 21 series (the same data that used
// to live in app.js's seriesData array) so the Library isn't empty on a
// fresh install. Inserted in the same order as the old array so ids land on
// the same 1-21 values as before.
const SERIES_SEED = [
  { title: 'Frieren', badge: 'airing', fill: 'accent', pct: 78, eps: '21 / 28', monitored: true, status: 'continuing', nextAirDays: 2, addedDaysAgo: 40, poster: 'https://cdn.myanimelist.net/images/anime/1015/138006.jpg', meta: "2023 · Adventure, Drama, Fantasy · TV · 24 min eps", overview: "A veteran elf mage reflects on mortality and connection after outliving the human companions who once saved the world alongside her." },
  { title: 'Chainsaw Man', badge: 'missing', fill: 'warning', pct: 92, eps: '11 / 12', monitored: true, status: 'continuing', nextAirDays: 5, addedDaysAgo: 25, meta: "2022 · Action, Fantasy, Horror · TV · 24 min eps", overview: "A destitute young man merges with his pet devil to become Chainsaw Man, hunting devils for a shadowy government agency." },
  { title: 'Mushoku Tensei', badge: null, fill: 'success', pct: 100, eps: '24 / 24', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 120, meta: "2021 · Adventure, Drama, Fantasy · TV · 24 min eps", overview: "A shut-in gets a second chance at life reincarnated as a mage in a magical world, determined not to waste it this time." },
  { title: 'Solo Leveling', badge: 'downloading', fill: 'accent', pct: 55, eps: '6 / 13', monitored: true, status: 'continuing', nextAirDays: 1, addedDaysAgo: 2, meta: "2024 · Action, Adventure, Fantasy · TV · 24 min eps", overview: "The weakest hunter alive gains a mysterious system that lets him grow stronger with every dungeon he clears." },
  { title: 'Vinland Saga', badge: null, fill: 'success', pct: 100, eps: '24 / 24', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 200, meta: "2019 · Action, Adventure, Drama · TV · 24 min eps", overview: "A young Viking driven by vengeance sails toward a reckoning with the man who killed his father." },
  { title: 'Steins;Gate', badge: 'unmonitored', fill: 'success', pct: 100, eps: '24 / 24', monitored: false, status: 'ended', nextAirDays: null, addedDaysAgo: 300, meta: "2011 · Drama, Sci-Fi, Suspense · TV · 24 min eps", overview: "A self-proclaimed mad scientist stumbles into real time travel, and every fix he makes only tightens the trap." },
  { title: 'Made in Abyss', badge: null, fill: 'success', pct: 100, eps: '13 / 13', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 90, meta: "2017 · Adventure, Drama, Fantasy, Mystery · TV · 24 min eps", overview: "An orphan and the robot boy she rescues descend into a bottomless chasm that punishes anyone who tries to leave it." },
  { title: 'Jujutsu Kaisen', badge: 'missing', fill: 'warning', pct: 88, eps: '22 / 25', monitored: true, status: 'continuing', nextAirDays: 4, addedDaysAgo: 60, meta: "2020 · Action, Fantasy · TV · 24 min eps", overview: "A boy swallows a cursed talisman to save his friends and is drafted into a secret war against man-eating curses." },
  { title: 'Spy x Family', badge: null, fill: 'success', pct: 100, eps: '25 / 25', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 150, meta: "2022 · Action, Comedy · TV · 24 min eps", overview: "A spy, an assassin, and a telepath fake a family to keep the peace, each hiding their true identity from the others." },
  { title: 'Demon Slayer', badge: 'airing', fill: 'accent', pct: 63, eps: '5 / 8', monitored: true, status: 'continuing', nextAirDays: 6, addedDaysAgo: 10, meta: "2019 · Action, Fantasy · TV · 24 min eps", overview: "A boy becomes a demon slayer to avenge his family and find a cure for the sister who survived as a demon." },
  { title: 'Kaguya-sama', badge: null, fill: 'success', pct: 100, eps: '13 / 13', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 180, meta: "2019 · Comedy, Psychological, Romance · TV · 24 min eps", overview: "Two elite student council members would rather scheme and sabotage than admit they're both in love." },
  { title: 'Bocchi the Rock', badge: null, fill: 'success', pct: 100, eps: '12 / 12', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 5, meta: "2022 · Comedy, Music, Slice of Life · TV · 24 min eps", overview: "A crippling introvert joins a band hoping it'll fix her social life; it mostly just gives her a guitar to hide behind." },
  { title: 'Re:ZERO -Starting Life in Another World-', badge: null, fill: 'success', pct: 100, eps: '25 / 25', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 1, poster: 'https://cdn.myanimelist.net/images/anime/1522/128039.jpg', meta: "2016 · Drama, Fantasy, Suspense · TV · 26 min eps", overview: "Wrenched into a fantasy world and killed almost immediately, Subaru discovers he resets to a checkpoint every time he dies." },
  { title: 'Fullmetal Alchemist: Brotherhood', badge: null, fill: 'success', pct: 100, eps: '64 / 64', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 1, poster: 'https://cdn.myanimelist.net/images/anime/1208/94745.jpg', meta: "2009 · Action, Adventure, Drama, Fantasy · TV · 24 min eps", overview: "Two brothers who broke a forbidden alchemical law search for a way to restore what it cost them, and get pulled into a national conspiracy." },
  { title: 'Yani Neko', badge: 'airing', fill: 'accent', pct: 33, eps: '4 / 12', monitored: true, status: 'continuing', nextAirDays: 4, addedDaysAgo: 3, poster: 'https://cdn.myanimelist.net/images/anime/1281/156496.jpg', meta: "2026 · Comedy · TV · 23 min eps", overview: "A catgirl with a serious smoking habit and an even worse rent problem tries, and fails, to get her life together." },
  { title: "Makina-san's a Love Bot?!", badge: null, fill: 'success', pct: 100, eps: '12 / 12', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 2, poster: 'https://cdn.myanimelist.net/images/anime/1843/146935.jpg', meta: "2025 · Comedy, Romance, Sci-Fi, Ecchi · TV · 12 min eps", overview: "A shy robotics enthusiast discovers his crush is an android built to seduce men, except her programming keeps glitching." },
  { title: 'Trinity Seven', badge: null, fill: 'success', pct: 100, eps: '12 / 12', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 2, poster: 'https://cdn.myanimelist.net/images/anime/12/67795.jpg', meta: "2014 · Action, Comedy, Fantasy, Romance, Ecchi · TV · 24 min eps", overview: "After his hometown is erased by a mysterious phenomenon, a boy enrolls in a magic academy alongside seven powerful mages to get it back." },
  { title: 'Strike Witches', badge: null, fill: 'success', pct: 100, eps: '12 / 12', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 2, poster: 'https://cdn.myanimelist.net/images/anime/13/75524.jpg', meta: "2008 · Action, Sci-Fi, Ecchi · TV · 24 min eps", overview: "Girls equipped with magical Striker Units form humanity's last line of defense against an alien invasion in an alternate 1944." },
  { title: 'Angel Beats!', badge: null, fill: 'success', pct: 100, eps: '13 / 13', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 1, poster: 'https://cdn.myanimelist.net/images/anime/1244/111115.jpg', meta: "2010 · Drama, Fantasy · TV · 26 min eps", overview: "A boy wakes with no memories in the afterlife and joins a rebel faction fighting the god-like student council president." },
  { title: 'Higashi no Eden', badge: null, fill: 'success', pct: 100, eps: '11 / 11', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 3, poster: 'https://cdn.myanimelist.net/images/anime/9/15033.jpg', meta: "2009 · Mystery, Psychological, Sci-Fi · TV · 23 min eps", overview: "A naked amnesiac carrying a phone loaded with 8.2 billion yen may be behind a terrorist attack, or the only one who can stop the next one." },
  { title: 'Kiss x Sis', badge: null, fill: 'success', pct: 100, eps: '12 / 12', monitored: true, status: 'ended', nextAirDays: null, addedDaysAgo: 3, poster: 'https://cdn.myanimelist.net/images/anime/1660/121553.jpg', meta: "2010 · Comedy, Romance, Ecchi · TV · 24 min eps", overview: "A boy tries to focus on high school entrance exams while his two step-sisters compete, loudly, for his affection." },
];

  // Defensive migration for DBs created before external_id/external_source
  // existed (added alongside real per-episode data — see the Episode
  // persistence section below). Lets us know which series came from a search
  // result, and what id to look episodes up by, without touching anything
  // already in the table.
  const seriesColumns = await db.tableColumns('series');
  if (!seriesColumns.includes('external_id')) {
    await db.exec(`ALTER TABLE series ADD COLUMN external_id TEXT`);
    logInfo('Database', 'Migrated series table: added external_id column');
  }
  if (!seriesColumns.includes('external_source')) {
    await db.exec(`ALTER TABLE series ADD COLUMN external_source TEXT`);
    logInfo('Database', 'Migrated series table: added external_source column');
  }
  if (!seriesColumns.includes('air_status')) {
    // The real, source-specific airing status text (TVDB's "Ended"/
    // "Continuing"/"Upcoming", MAL's "Finished Airing"/"Currently Airing"/
    // "Not Yet Aired") — separate from the `status` column above, which stays
    // a plain continuing/ended binary the rest of the app (filter tabs,
    // badges) already depends on. See deriveAirStatus below for where this
    // gets populated and the Next airing stat card on series.html for where
    // it's shown for a series with no next episode date.
    await db.exec(`ALTER TABLE series ADD COLUMN air_status TEXT`);
    logInfo('Database', 'Migrated series table: added air_status column');
  }
  if (!seriesColumns.includes('tvdb_episode_id')) {
    // The TVDB series id used for episode lookups (see Episode persistence
    // below) — separate from external_id/external_source, which record where
    // the series itself was originally added from. A MAL-added series has no
    // TVDB id at all until it's resolved once by title search; this caches
    // that result so it's only ever looked up once.
    await db.exec(`ALTER TABLE series ADD COLUMN tvdb_episode_id TEXT`);
    logInfo('Database', 'Migrated series table: added tvdb_episode_id column');
  }

  // Fields the Edit Series modal reads/writes — added together since they
  // all landed with that one feature.
  for (const [col, def] of [
    ['monitor_new_seasons', "TEXT NOT NULL DEFAULT 'all'"],
    ['season_folder', 'INTEGER NOT NULL DEFAULT 1'],
    ['quality_profile', 'TEXT'],
    ['series_type', "TEXT NOT NULL DEFAULT 'anime'"],
    ['path', 'TEXT'],
    // JSON array of alternate titles from the search result that added this
    // series (native/romanized title, Japanese title, MAL's own synonyms
    // list) — see resolveTvdbEpisodeSourceId in server/lib/tvdb.js for why:
    // a MAL-added series' official English title (what's stored in `title`)
    // frequently isn't what TVDB itself indexes the show under, so the very
    // first title-only TVDB search this app tried could come back with zero
    // results even for a real, well-known show. These give that resolution a
    // second (and third, etc.) attempt instead of just giving up after one.
    ['alt_titles', 'TEXT'],
    // Ignore Specials — excludes season 0 from the eps/pct progress stats
    // recomputeSeriesEpisodeStats (server/lib/series-stats.js) maintains, so a
    // series with every real season complete but a special that was never
    // released/grabbed doesn't sit at, say, "24 / 25" forever. Doesn't affect
    // what's cached or shown anywhere else — the Specials tab on the series
    // detail page still lists every special exactly as before; this only
    // changes whether they're counted.
    ['ignore_specials', 'INTEGER NOT NULL DEFAULT 0'],
  ]) {
    if (!seriesColumns.includes(col)) {
      await db.exec(`ALTER TABLE series ADD COLUMN ${col} ${def}`);
      logInfo('Database', `Migrated series table: added ${col} column`);
    }
  }

  const seriesCount = (await db.prepare('SELECT COUNT(*) AS n FROM series').get()).n;
  if (Number(seriesCount) === 0) {
    if (db.SEED_DEMO_DATA) {
      const insertSeries = db.prepare(`
        INSERT INTO series (title, badge, fill, pct, eps, monitored, status, next_air_days, added_days_ago, poster, meta, overview, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const s of SERIES_SEED) {
        await insertSeries.run(
          s.title, s.badge ?? null, s.fill, s.pct, s.eps, s.monitored ? 1 : 0, s.status,
          s.nextAirDays ?? null, s.addedDaysAgo, s.poster ?? null, s.meta ?? null, s.overview ?? null, db.now()
        );
      }
      logInfo('Database', `Seeded ${SERIES_SEED.length} default series into ${db.describe()}`);
    } else {
      logInfo('Database', `series table is empty — skipping demo seed (APP_ENV=${db.APP_ENV})`);
    }
  }
});

async function tagIdsForSeries(seriesId) {
  return (await db.prepare('SELECT tag_id FROM series_tags WHERE series_id = ? ORDER BY tag_id ASC').all(seriesId)).map((r) => r.tag_id);
}

async function rowToSeries(row) {
  return {
    id: row.id,
    title: row.title,
    badge: row.badge,
    fill: row.fill,
    pct: row.pct,
    eps: row.eps,
    monitored: !!row.monitored,
    status: row.status,
    airStatus: row.air_status,
    nextAirDays: row.next_air_days,
    addedDaysAgo: row.added_days_ago,
    poster: row.poster,
    meta: row.meta,
    overview: row.overview,
    externalId: row.external_id,
    externalSource: row.external_source,
    // Everything below here backs the Edit Series modal (see series.html).
    monitorNewSeasons: row.monitor_new_seasons,
    seasonFolder: !!row.season_folder,
    qualityProfile: row.quality_profile,
    seriesType: row.series_type,
    path: row.path,
    ignoreSpecials: !!row.ignore_specials,
    tagIds: await tagIdsForSeries(row.id),
  };
}


async function handleSeriesApi(req, res, urlPath) {
  // GET /api/series — everything the Library grid / series detail page need.
  if (req.method === 'GET' && urlPath === '/api/series') {
    const rows = await db.prepare('SELECT * FROM series ORDER BY id ASC').all();
    sendJson(res, 200, await Promise.all(rows.map(rowToSeries)));
    return true;
  }

  // POST /api/series — add a series found via search (see Add New). Only
  // title is required; everything else gets a sensible "just added, nothing
  // known yet" default, since a search result doesn't include episode
  // counts, genres, or airing status. `id`/`source` (the search result's
  // MAL or TVDB id, and which one it came from) are stored as
  // external_id/external_source so a MAL-sourced add can later have its real
  // episode list fetched — see GET /api/series/:id/episodes below.
  if (req.method === 'POST' && urlPath === '/api/series') {
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    const title = String(body.title || '').trim();
    if (!title) {
      sendJson(res, 400, { error: 'Title is required' });
      return true;
    }
    const meta = body.year ? `${body.year} · TV` : (body.meta || null);
    const externalId = body.id !== undefined && body.id !== null && body.id !== '' ? String(body.id) : null;
    const externalSource = body.source ? String(body.source) : null;
    // See the alt_titles migration comment above for why these matter — kept
    // to a handful of short, deduplicated, non-empty strings so a malformed
    // or huge client payload here can't bloat the row or the searches that
    // read it back.
    const altTitles = Array.isArray(body.altTitles)
      ? [...new Set(body.altTitles.map((t) => String(t || '').trim()).filter((t) => t && t.length <= 200))].slice(0, 5)
      : [];
    const altTitlesJson = altTitles.length > 0 ? JSON.stringify(altTitles) : null;

    // Duplicate check. This is the thing that actually stops a title from
    // being added twice — the Add New page tries to pre-empt this in the UI
    // (see loadLibraryIndex/libraryMatchFor in app.js), but that's just a
    // convenience; without a real check here, re-clicking "Add Series" on
    // the same search result (or two different search results that resolve
    // to the same show, e.g. MAL vs a TVDB fallback result) would silently
    // create a second row in the Library. Two ways a duplicate shows up:
    // the exact same (source, id) pair as an existing series, or a title
    // that normalizes to the same thing — reusing normalizeFolderName (see
    // the Real filesystem access section above), since "same show, different
    // casing/punctuation" is the same comparison problem folder matching
    // already solves.
    if (externalId && externalSource) {
      const byExternal = await db.prepare('SELECT id, title FROM series WHERE external_id = ? AND external_source = ?')
        .get(externalId, externalSource);
      if (byExternal) {
        sendJson(res, 409, { error: `"${byExternal.title}" is already in the Library`, existingId: byExternal.id });
        return true;
      }
    }
    const normalizedTitle = normalizeFolderName(title);
    const byTitle = (await db.prepare('SELECT id, title FROM series').all())
      .find((r) => normalizeFolderName(r.title) === normalizedTitle);
    if (byTitle) {
      sendJson(res, 409, { error: `"${byTitle.title}" is already in the Library`, existingId: byTitle.id });
      return true;
    }

    // Real airing status from the search result (see deriveAirStatus above)
    // instead of always hardcoding 'continuing' — a show that's already
    // finished when it's added should read that way immediately, not just
    // once something else happens to update it later (nothing currently
    // does; status/air_status are set once, here, and never revisited).
    const { airStatus, status } = deriveAirStatus(body.status, externalSource);
    const defaultPath = await defaultSeriesPathFor(title, body.rootFolder ? String(body.rootFolder) : null);
    // Same "trust the UI already only offers real choices" convention
    // PATCH /api/series/:id's own qualityProfile handling already uses
    // (getQualityProfile gracefully defaults to "every tier allowed" for a
    // name it doesn't recognize) — Add New's dropdown only ever lists real
    // Settings > Profiles names, so an explicit choice here isn't
    // re-validated against that list a second time, unlike rootFolder above
    // (which controls a real filesystem path, not just a lookup key). An
    // omitted/empty one now falls back through resolveQualityProfile to
    // whichever profile Settings > Profiles has marked as the default for
    // new series, rather than silently landing on null — see that function's
    // own comment.
    const qualityProfile = await resolveQualityProfile(body.qualityProfile ? String(body.qualityProfile) : null);
    // Same "Settings has a configurable default, an explicit per-add value
    // (once one exists in the UI) always wins" shape as qualityProfile just
    // above — see Settings > Media Management's "New Series Defaults" card.
    const ignoreSpecials = await resolveIgnoreSpecials(body.ignoreSpecials);

    const created = await db.prepare(`
      INSERT INTO series (title, badge, fill, pct, eps, monitored, status, air_status, next_air_days, added_days_ago, poster, meta, overview, external_id, external_source, alt_titles, path, quality_profile, ignore_specials, created_at)
      VALUES (?, NULL, 'accent', 0, '0 / 0', 1, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `).get(title, status, airStatus, body.poster || null, meta, body.overview || null, externalId, externalSource, altTitlesJson, defaultPath, qualityProfile, ignoreSpecials, db.now());
    logInfo('SeriesService', `Series added: ${title}${externalSource ? ` (${externalSource}#${externalId})` : ''}`);
    sendJson(res, 201, await rowToSeries(created));
    // Start warming the episode cache immediately instead of waiting for
    // someone to open the series detail page — see warmEpisodesInBackground
    // below (defined near the rest of the episode-fetching code, since it
    // needs resolveTvdbEpisodeSourceId/fetchTvdbEpisodes). Deliberately not
    // awaited: the response above has already gone out, and a slow or
    // failed TVDB fetch shouldn't hold up "series added" or surface as an
    // error on this request.
    warmEpisodesInBackground(created);
    return true;
  }

  // PATCH /api/series/:id — the Monitored toggle on the series detail page,
  // plus everything the Edit Series modal (see series.html) can change:
  // Monitor New Seasons, Use Season Folder, Quality Profile, Series Type,
  // Path, and Tags. Every field is optional/independent — only the ones
  // actually present in the request body get touched, same pattern as the
  // settings PATCH endpoints elsewhere in this file.
  const patchMatch = req.method === 'PATCH' && urlPath.match(/^\/api\/series\/(\d+)$/);
  if (patchMatch) {
    const id = Number(patchMatch[1]);
    const existing = await db.prepare('SELECT * FROM series WHERE id = ?').get(id);
    if (!existing) {
      sendJson(res, 404, { error: 'Series not found' });
      return true;
    }
    let body;
    try {
      body = await readJsonBody(req);
    } catch {
      sendJson(res, 400, { error: 'Invalid JSON body' });
      return true;
    }
    if (body.title !== undefined) {
      const title = String(body.title).trim();
      if (!title) {
        sendJson(res, 400, { error: 'Title cannot be empty' });
        return true;
      }
      // Same normalized-title duplicate check POST /api/series uses when
      // adding a series, just excluding this row itself — renaming "Frieren"
      // to something that already normalizes to an existing series' title
      // (a different casing/punctuation of the same name, or an actual
      // different series entirely) would otherwise silently produce two
      // Library rows that read as the same show.
      const normalizedTitle = normalizeFolderName(title);
      const clash = (await db.prepare('SELECT id, title FROM series WHERE id != ?').all(id))
        .find((r) => normalizeFolderName(r.title) === normalizedTitle);
      if (clash) {
        sendJson(res, 409, { error: `"${clash.title}" already exists in the Library` });
        return true;
      }
      await db.prepare('UPDATE series SET title = ? WHERE id = ?').run(title, id);
      if (title !== existing.title) logInfo('SeriesService', `Renamed "${existing.title}" to "${title}"`);
    }
    if (body.monitored !== undefined) {
      await db.prepare('UPDATE series SET monitored = ? WHERE id = ?').run(body.monitored ? 1 : 0, id);
      logInfo('SeriesService', `${existing.title}: monitored set to ${!!body.monitored}`);
    }
    if (body.monitorNewSeasons !== undefined) {
      const value = String(body.monitorNewSeasons);
      if (!MONITOR_NEW_SEASONS_OPTIONS.includes(value)) {
        sendJson(res, 400, { error: `monitorNewSeasons must be one of: ${MONITOR_NEW_SEASONS_OPTIONS.join(', ')}` });
        return true;
      }
      await db.prepare('UPDATE series SET monitor_new_seasons = ? WHERE id = ?').run(value, id);
    }
    if (body.seasonFolder !== undefined) {
      await db.prepare('UPDATE series SET season_folder = ? WHERE id = ?').run(body.seasonFolder ? 1 : 0, id);
    }
    if (body.qualityProfile !== undefined) {
      await db.prepare('UPDATE series SET quality_profile = ? WHERE id = ?').run(body.qualityProfile || null, id);
    }
    if (body.seriesType !== undefined) {
      const value = String(body.seriesType);
      if (!SERIES_TYPE_OPTIONS.includes(value)) {
        sendJson(res, 400, { error: `seriesType must be one of: ${SERIES_TYPE_OPTIONS.join(', ')}` });
        return true;
      }
      await db.prepare('UPDATE series SET series_type = ? WHERE id = ?').run(value, id);
    }
    if (body.ignoreSpecials !== undefined) {
      await db.prepare('UPDATE series SET ignore_specials = ? WHERE id = ?').run(body.ignoreSpecials ? 1 : 0, id);
      // Recomputed right here rather than waiting for the next real
      // import/delete to happen to touch eps/pct — flipping this toggle
      // should visibly change the progress bar the moment you hit Save
      // (handleEditSaved in SeriesPage.jsx merges this response straight
      // into the page's series state), not just the next time something
      // else recomputes stats.
      await recomputeSeriesEpisodeStats(id);
      logInfo('SeriesService', `${existing.title}: ignore specials set to ${!!body.ignoreSpecials}`);
    }
    // path CAN be set here, as a manual override — added after a real gap
    // surfaced: defaultSeriesPathFor/firstConfiguredRootFolder (above) and
    // scanExistingFilesForSeries/findExistingSeriesFolder (routes/
    // episodes.js) all derive a folder from the series' title/alt_titles,
    // which only works when the real on-disk folder name actually
    // resembles one of those. A folder named for an informal/regional name
    // that isn't in TVDB/MAL at all (e.g. app shows "Yani Neko", the real
    // folder is "Chainsmoker Cat") can never be found by any of that
    // matching, no matter how good — the only way out is letting someone
    // just point Kitsune at the real folder. Validated against the real
    // filesystem (existsSync) so this can't silently set another fabricated,
    // never-checked path the way defaultSeriesPathFor's guess does.
    if (body.path !== undefined) {
      const newPath = String(body.path).trim();
      if (!newPath) {
        sendJson(res, 400, { error: 'Path cannot be empty' });
        return true;
      }
      if (!fs.existsSync(newPath)) {
        sendJson(res, 400, { error: `"${newPath}" doesn't exist on disk.` });
        return true;
      }
      await db.prepare('UPDATE series SET path = ? WHERE id = ?').run(newPath, id);
      if (newPath !== existing.path) logInfo('SeriesService', `${existing.title}: path manually set to "${newPath}"`);
    }
    if (body.tagIds !== undefined) {
      if (!Array.isArray(body.tagIds)) {
        sendJson(res, 400, { error: 'tagIds must be an array of tag ids' });
        return true;
      }
      // Replace the whole set rather than diffing — simplest correct way to
      // handle "here's the new list of tags" from the modal's tag picker,
      // and this table only ever has a handful of rows per series. (No
      // db.transaction() here — node:sqlite's DatabaseSync doesn't have
      // better-sqlite3's transaction() helper; these statements run
      // sequentially, which is enough for a single-process app like this one.)
      await db.prepare('DELETE FROM series_tags WHERE series_id = ?').run(id);
      const insertTag = db.prepare('INSERT INTO series_tags (series_id, tag_id) VALUES (?, ?) ON CONFLICT (series_id, tag_id) DO NOTHING');
      for (const tagId of body.tagIds) await insertTag.run(id, Number(tagId));
    }
    const updated = await db.prepare('SELECT * FROM series WHERE id = ?').get(id);
    sendJson(res, 200, await rowToSeries(updated));
    return true;
  }

  // DELETE /api/series/:id — removes a series from the library entirely.
  // Database-only: this never touches real files on disk (no "delete files
  // too" option exists yet, unlike real Sonarr's own delete dialog), so any
  // real video files a series had stay exactly where they are.
  const deleteMatch = req.method === 'DELETE' && urlPath.match(/^\/api\/series\/(\d+)$/);
  if (deleteMatch) {
    const id = Number(deleteMatch[1]);
    const existing = await db.prepare('SELECT * FROM series WHERE id = ?').get(id);
    if (!existing) {
      sendJson(res, 404, { error: 'Series not found' });
      return true;
    }
    // Episodes rows have no FOREIGN KEY/ON DELETE CASCADE tying them to
    // series (SQLite doesn't enforce one here), so this delete was leaving
    // every one of a deleted series' episode rows behind permanently —
    // real, confirmed dead data with no series left to join back to and no
    // way to ever clean it up short of hand-editing the database. Deleted
    // explicitly here, before the series row itself, for the same reason
    // series_tags already was.
    await db.prepare('DELETE FROM episodes WHERE series_id = ?').run(id);
    await db.prepare('DELETE FROM series_tags WHERE series_id = ?').run(id);
    await db.prepare('DELETE FROM series WHERE id = ?').run(id);
    logInfo('SeriesService', `Series deleted: ${existing.title}`);
    sendJson(res, 200, { ok: true });
    return true;
  }

  return false;
}

module.exports = { handleSeriesApi };
