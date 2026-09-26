// ---------------------------------------------------------------------------
// System > Tasks' "Application Update Check" row, made real (Phase 1 of the
// Updates feature — see Settings > General's Updates card and System >
// Updates page). Read-only: this only ever answers "is there a newer commit
// on GitHub than what's running", it never downloads or applies anything —
// see the deployment-mode.js header comment for why an apply-update action
// is a separate, later phase.
//
// Deliberately has no live git dependency at runtime. The obvious way to
// answer "what commit is running" would be `git rev-parse HEAD` against a
// local .git checkout, but the actual deployed instance (see
// scripts/deploy.sh) never has one — .git is excluded from what gets
// rsynced over, and a from-scratch Docker image built from a release
// tarball may not have one either. Instead:
//   1. scripts/write-build-info.js runs at build/deploy time, wherever
//      .git *does* exist, and stamps build-info.json with the commit SHA,
//      branch, and build timestamp — an ordinary project file from then on.
//   2. This module reads that file (no git needed) and asks GitHub's own
//      REST API what the latest commit on the configured branch is, plus a
//      real commit-by-commit diff between the two (the "compare" endpoint)
//      for real changelog data instead of a hand-maintained one. Works
//      identically whether this instance is a standalone Node process or a
//      Docker container — neither one needs git installed at all.
//
// Same real-task shape every other System > Tasks row already established
// (see disk-usage.js/permissions.js/refresh-series-task.js): an interval
// persisted in the shared 'scheduled-tasks' app_settings row, last-run/
// next-run persisted separately so both survive a restart instead of
// resetting the countdown or forgetting the last result, and a self-
// rescheduling setTimeout rather than setInterval so a changed interval
// never needs a teardown/recreate dance.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { logInfo, logWarn } = require('../logger');
const pkg = require('../../package.json');

db.init(async () => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      section TEXT PRIMARY KEY,
      data TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL
    )
  `);
});

const TASK_SETTINGS_SECTION = 'scheduled-tasks'; // shared with disk-usage.js/permissions.js/refresh-series-task.js
const TASK_CACHE_SECTION = 'update-check-cache';
const TASK_ID = 'update-check';
const TASK_NAME = 'Application Update Check';
const MIN_INTERVAL_HOURS = 1;
const MAX_INTERVAL_HOURS = 168; // 1 week
const BUILD_INFO_PATH = path.join(__dirname, '..', '..', 'build-info.json');
const GITHUB_API_BASE = 'https://api.github.com';
const DEFAULT_BRANCH = 'main';

// ---------------------------------------------------------------------------
// Repository identity — derived from package.json's "repository" field
// (e.g. "git+https://github.com/seanpdiaz/kitsune.git" or the shorthand
// "seanpdiaz/kitsune") so there's exactly one place this is configured,
// rather than a second hardcoded owner/repo living here too. A
// KITSUNE_GITHUB_REPO env var ("owner/repo") overrides it, for anyone
// running a fork who hasn't touched package.json.
// ---------------------------------------------------------------------------
function getRepoInfo() {
  const override = (process.env.KITSUNE_GITHUB_REPO || '').trim();
  if (/^[^/\s]+\/[^/\s]+$/.test(override)) {
    const [owner, repo] = override.split('/');
    return { owner, repo };
  }

  const repoField = pkg.repository;
  const url = typeof repoField === 'string' ? repoField : (repoField && repoField.url) || '';
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s.]+?)(?:\.git)?$/i.exec(url.trim());
  if (m) return { owner: m[1], repo: m[2] };

  return null;
}

// ---------------------------------------------------------------------------
// build-info.json — read fresh on every check rather than cached at module
// load, so a redeploy that replaces this file (without necessarily
// restarting the whole process, e.g. a supervisor-managed reload) is picked
// up on the next scheduled or manual check rather than requiring a full
// restart just to notice its own new build. Missing/corrupt/placeholder
// (see write-build-info.js's "unknown build" fallback) all collapse to the
// same { commit: null, branch: null, builtAt: null } shape — every caller
// already treats a null commit as "can't compare, just show the latest" —
// rather than three different failure shapes to handle.
// ---------------------------------------------------------------------------
function loadBuildInfo() {
  try {
    const raw = fs.readFileSync(BUILD_INFO_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      commit: parsed.commit || null,
      branch: parsed.branch || null,
      builtAt: parsed.builtAt || null,
    };
  } catch {
    return { commit: null, branch: null, builtAt: null };
  }
}

// The Branch setting lives on Settings > General (general-12) — a channel
// to check against, independent of whatever branch this specific build
// happened to be built from (see GeneralPage.jsx's Updates card). Falls
// back to the build's own recorded branch, then DEFAULT_BRANCH, so a fresh
// install with nothing saved yet still checks something sensible instead of
// an empty string.
async function getConfiguredBranch(buildInfo) {
  const row = await db.prepare("SELECT data FROM app_settings WHERE section = 'general'").get();
  if (row) {
    try {
      const branch = JSON.parse(row.data)['general-12'];
      if (typeof branch === 'string' && branch.trim()) return branch.trim();
    } catch {
      // fall through
    }
  }
  return buildInfo.branch || DEFAULT_BRANCH;
}

function githubHeaders() {
  const headers = {
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'Kitsune-UpdateCheck',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  // Optional — required only for a private repository (unauthenticated
  // requests to a private repo's API 404, same as "doesn't exist," which is
  // deliberate on GitHub's part). A fine-grained PAT with read-only
  // Contents access is all this ever needs; never logged or echoed back in
  // any API response this module produces.
  const token = (process.env.GITHUB_TOKEN || '').trim();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  return headers;
}

async function githubGet(url) {
  const res = await fetch(url, { headers: githubHeaders() });
  if (!res.ok) {
    if (res.status === 404) {
      throw new Error(
        `GitHub API 404 — the repository may be private (set the GITHUB_TOKEN env var to a token with read access) ` +
        `or the branch/commit doesn't exist there anymore.`
      );
    }
    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
      const resetAt = Number(res.headers.get('x-ratelimit-reset')) * 1000;
      const resetLabel = Number.isFinite(resetAt) ? new Date(resetAt).toLocaleTimeString() : 'later';
      throw new Error(`GitHub API rate limit exceeded — resets around ${resetLabel}. Set GITHUB_TOKEN for a much higher limit.`);
    }
    const body = await res.text().catch(() => '');
    throw new Error(`GitHub API returned HTTP ${res.status}${body ? `: ${body.slice(0, 200)}` : ''}`);
  }
  return res.json();
}

function summarizeCommit(raw) {
  const sha = raw.sha || '';
  return {
    sha,
    shortSha: sha.slice(0, 7),
    message: ((raw.commit && raw.commit.message) || '').split('\n')[0],
    author: (raw.commit && raw.commit.author && raw.commit.author.name) || (raw.author && raw.author.login) || 'Unknown',
    date: (raw.commit && raw.commit.author && raw.commit.author.date) || null,
    htmlUrl: raw.html_url || null,
  };
}

// ---------------------------------------------------------------------------
// Persistence — same merge-into-one-row-per-section convention every other
// task module here uses (see disk-usage.js's own persistDiskUsage/
// persistNextRunAt for the full reasoning). TASK_CACHE_SECTION holds both
// the last completed check's full result (so a restart has something real
// to show immediately instead of blanking to "Checking…" until the next
// scheduled run) and nextRunAt (so the schedule itself survives a restart).
// ---------------------------------------------------------------------------
async function loadPersistedIntervalHours(fallback) {
  const row = await db.prepare('SELECT data FROM app_settings WHERE section = ?').get(TASK_SETTINGS_SECTION);
  if (row) {
    try {
      const hours = Number(JSON.parse(row.data).updateCheckIntervalHours);
      if (Number.isFinite(hours) && hours > 0) return hours;
    } catch {
      // fall through to the migration/fallback below
    }
  }

  // This task has never had its own real interval saved yet. Before
  // falling back to `fallback` (the UPDATE_CHECK_INTERVAL_HOURS env var),
  // check whether the user already set a preferred cadence for this exact
  // row back when it was still decorative (server/lib/decorative-task-
  // intervals.js persists that under its own section, keyed by the same
  // 'update-check' id, in minutes) — same carry-over refresh-series-task.js
  // already does for its own migration.
  const legacyMinutes = await loadLegacyDecorativeIntervalMinutes();
  if (legacyMinutes != null) {
    const migratedHours = Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, Math.round(legacyMinutes / 60)));
    logInfo('UpdateCheck', `Migrated interval from the old decorative Application Update Check setting: every ${legacyMinutes}m -> every ${migratedHours}h`);
    return migratedHours;
  }

  return fallback;
}

async function loadLegacyDecorativeIntervalMinutes() {
  const row = await db.prepare("SELECT data FROM app_settings WHERE section = 'decorative-task-intervals'").get();
  if (!row) return null;
  try {
    const overrides = JSON.parse(row.data);
    const minutes = Number(overrides && overrides['update-check']);
    return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
  } catch {
    return null;
  }
}

async function persistIntervalHours(hours) {
  const row = await db.prepare('SELECT data FROM app_settings WHERE section = ?').get(TASK_SETTINGS_SECTION);
  const merged = { ...(row ? JSON.parse(row.data) : {}), updateCheckIntervalHours: hours };
  await db.prepare(`
    INSERT INTO app_settings (section, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(section) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(TASK_SETTINGS_SECTION, JSON.stringify(merged), db.now());
}

async function loadPersistedResult() {
  const row = await db.prepare('SELECT data FROM app_settings WHERE section = ?').get(TASK_CACHE_SECTION);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.data);
    if (!parsed.checkedAt) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function persistResult(payload) {
  const row = await db.prepare('SELECT data FROM app_settings WHERE section = ?').get(TASK_CACHE_SECTION);
  const merged = { ...(row ? JSON.parse(row.data) : {}), ...payload };
  await db.prepare(`
    INSERT INTO app_settings (section, data, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(section) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
  `).run(TASK_CACHE_SECTION, JSON.stringify(merged), db.now());
}

async function persistNextRunAt(nextRunAtDate) {
  await persistResult({ nextRunAt: nextRunAtDate.toISOString() });
}

async function loadPersistedNextRunAt() {
  const row = await db.prepare('SELECT data FROM app_settings WHERE section = ?').get(TASK_CACHE_SECTION);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.data);
    if (!parsed.nextRunAt) return null;
    const d = new Date(parsed.nextRunAt);
    return Number.isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

const state = {
  checking: false,
  checkedAt: null,
  repo: null,
  branch: null,
  buildInfo: { commit: null, branch: null, builtAt: null },
  latestCommit: null,
  commits: [],
  compareStatus: null, // 'identical' | 'ahead' | 'behind' | 'diverged' | null (unknown)
  aheadBy: null,
  behindBy: null,
  updateAvailable: null, // true | false | null (unknown — no build commit recorded yet)
  lastError: null,
};
let intervalHours = 6; // overwritten by startUpdateCheckScheduler before anything else runs
let nextRunAt = null;
let timer = null;

// The actual work — fetches the latest commit on the configured branch and,
// when this build's own commit is known, a real commit-by-commit diff
// against it. Network errors (GitHub unreachable, rate-limited, repo
// private with no token) are caught and recorded as `lastError` rather than
// thrown — same "keep whatever the last good result was rather than
// blanking it over a transient failure" convention disk-usage.js's
// refreshDiskUsage already follows for an unreadable root folder.
async function refreshUpdateStatus() {
  if (state.checking) {
    logWarn('UpdateCheck', 'Skipped a scheduled update check — the previous check is still running');
    return;
  }
  state.checking = true;
  const startedAt = Date.now();
  try {
    const repo = getRepoInfo();
    if (!repo) {
      throw new Error('No GitHub repository configured — add a "repository" field to package.json (e.g. "seanpdiaz/kitsune") or set the KITSUNE_GITHUB_REPO env var.');
    }
    const buildInfo = loadBuildInfo();
    const branch = await getConfiguredBranch(buildInfo);

    const latestRaw = await githubGet(`${GITHUB_API_BASE}/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(branch)}`);
    const latestCommit = summarizeCommit(latestRaw);

    let commits = [];
    let compareStatus = null;
    let aheadBy = null;
    let behindBy = null;
    let updateAvailable = null;

    if (buildInfo.commit) {
      try {
        const compare = await githubGet(`${GITHUB_API_BASE}/repos/${repo.owner}/${repo.repo}/compare/${buildInfo.commit}...${encodeURIComponent(branch)}`);
        compareStatus = compare.status;
        aheadBy = compare.ahead_by;
        behindBy = compare.behind_by;
        // GitHub returns compare commits oldest-first; reversed so "what's
        // new" reads newest-first, matching every other list in this app.
        commits = (compare.commits || []).map(summarizeCommit).reverse();
        // 'ahead': the branch has commits this build doesn't -> a real
        // update. 'diverged': both sides have unique commits (e.g. this
        // build's exact commit was rebased away upstream) -> can't say for
        // certain there's nothing new, so still flagged rather than
        // silently reported as up to date. 'identical'/'behind' (this build
        // is the branch tip, or even ahead of it — a local dev build) both
        // mean nothing to install.
        updateAvailable = compareStatus === 'ahead' || compareStatus === 'diverged';
      } catch (err) {
        logWarn('UpdateCheck', `Could not compare the current build to ${branch}: ${err.message} — falling back to a plain commit-sha comparison.`);
        updateAvailable = latestCommit.sha !== buildInfo.commit;
      }
    }
    // buildInfo.commit === null (no build-info.json / unknown build): stays
    // `updateAvailable: null` — there is genuinely nothing to compare
    // against, and reporting "up to date" would be a guess dressed up as a
    // fact.

    state.repo = repo;
    state.branch = branch;
    state.buildInfo = buildInfo;
    state.latestCommit = latestCommit;
    state.commits = commits;
    state.compareStatus = compareStatus;
    state.aheadBy = aheadBy;
    state.behindBy = behindBy;
    state.updateAvailable = updateAvailable;
    state.lastError = null;
    state.checkedAt = new Date();

    await persistResult({
      checkedAt: state.checkedAt.toISOString(),
      repo, branch, buildInfo, latestCommit, commits,
      compareStatus, aheadBy, behindBy, updateAvailable,
      lastError: null,
    });

    const summary = updateAvailable === true ? 'update available' : updateAvailable === false ? 'up to date' : 'unknown (no build commit recorded)';
    logInfo('UpdateCheck', `Checked ${repo.owner}/${repo.repo}@${branch} — ${summary} (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
  } catch (err) {
    state.lastError = err.message || String(err);
    state.checkedAt = new Date();
    await persistResult({ checkedAt: state.checkedAt.toISOString(), lastError: state.lastError });
    logWarn('UpdateCheck', `Update check failed: ${state.lastError}`);
  } finally {
    state.checking = false;
  }
}

async function scheduleNext(explicitNextRunAt) {
  if (timer) clearTimeout(timer);
  const target = explicitNextRunAt instanceof Date
    ? explicitNextRunAt
    : new Date(Date.now() + intervalHours * 60 * 60 * 1000);
  nextRunAt = target;
  const ms = Math.max(0, target.getTime() - Date.now());
  timer = setTimeout(async () => {
    await refreshUpdateStatus();
    await scheduleNext();
  }, ms);
  await persistNextRunAt(target);
}

// System > Tasks' Run Now button, and System > Updates' own "Check Now".
async function runNow() {
  await refreshUpdateStatus();
  await scheduleNext();
}

async function setIntervalHours(hours) {
  const clamped = Math.min(MAX_INTERVAL_HOURS, Math.max(MIN_INTERVAL_HOURS, Math.round(hours)));
  intervalHours = clamped;
  await persistIntervalHours(clamped);
  await scheduleNext();
  logInfo('UpdateCheck', `Update check interval changed to every ${clamped}h`);
  return clamped;
}

// Backs GET /api/system-tasks alongside the other three real rows.
function getTaskInfo() {
  return {
    id: TASK_ID,
    name: TASK_NAME,
    intervalHours,
    minIntervalHours: MIN_INTERVAL_HOURS,
    maxIntervalHours: MAX_INTERVAL_HOURS,
    lastRunAt: state.checkedAt ? state.checkedAt.toISOString() : null,
    nextRunAt: nextRunAt ? nextRunAt.toISOString() : null,
    running: state.checking,
  };
}

// Backs GET /api/system-updates (see server/routes/system-updates.js) — the
// full result, for System > Updates' real changelog/status display, not
// just the System > Tasks row summary getTaskInfo returns.
function getCachedUpdateStatus() {
  return {
    checking: state.checking,
    checkedAt: state.checkedAt ? state.checkedAt.toISOString() : null,
    repo: state.repo,
    branch: state.branch,
    buildInfo: state.buildInfo,
    latestCommit: state.latestCommit,
    commits: state.commits,
    compareStatus: state.compareStatus,
    aheadBy: state.aheadBy,
    behindBy: state.behindBy,
    updateAvailable: state.updateAvailable,
    lastError: state.lastError,
  };
}

// Called once from server.js at startup. Loads the persisted interval and
// last result (so a restart has real data to show immediately rather than
// blanking to "Checking…"), then either resumes a still-future persisted
// schedule or checks once right away — same "cheap and non-destructive, so
// do it at startup" reasoning disk-usage.js's own scheduler follows (unlike
// permissions.js's Apply Permissions, which deliberately never runs
// unprompted at startup because it's a real filesystem write).
async function startUpdateCheckScheduler(defaultIntervalHours) {
  intervalHours = await loadPersistedIntervalHours(defaultIntervalHours);

  const persisted = await loadPersistedResult();
  if (persisted) {
    state.checkedAt = persisted.checkedAt ? new Date(persisted.checkedAt) : null;
    state.repo = persisted.repo || null;
    state.branch = persisted.branch || null;
    state.buildInfo = persisted.buildInfo || { commit: null, branch: null, builtAt: null };
    state.latestCommit = persisted.latestCommit || null;
    state.commits = persisted.commits || [];
    state.compareStatus = persisted.compareStatus || null;
    state.aheadBy = persisted.aheadBy != null ? persisted.aheadBy : null;
    state.behindBy = persisted.behindBy != null ? persisted.behindBy : null;
    state.updateAvailable = persisted.updateAvailable != null ? persisted.updateAvailable : null;
    state.lastError = persisted.lastError || null;
    logInfo('UpdateCheck', `Loaded persisted update-check result from last run${state.checkedAt ? ` (${state.checkedAt.toISOString()})` : ''}`);
  }

  const persistedNextRunAt = await loadPersistedNextRunAt();
  if (persistedNextRunAt && persistedNextRunAt.getTime() > Date.now()) {
    logInfo('UpdateCheck', `Next check stays scheduled for ${persistedNextRunAt.toISOString()} (every ${intervalHours}h) — not due yet, so not checking again just because the server restarted.`);
    await scheduleNext(persistedNextRunAt);
  } else {
    logInfo('UpdateCheck', `GitHub will be checked for updates every ${intervalHours}h (plus once now at startup)`);
    refreshUpdateStatus().catch((err) => logWarn('UpdateCheck', `Startup check failed: ${err.stack || err}`));
    await scheduleNext();
  }
}

module.exports = {
  getTaskInfo,
  setIntervalHours,
  runNow,
  startUpdateCheckScheduler,
  getCachedUpdateStatus,
};
