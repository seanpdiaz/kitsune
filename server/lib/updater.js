// ---------------------------------------------------------------------------
// In-app updates — Phase 2 of the Updates feature (Phase 1, the read-only
// "is there something newer" check, is server/lib/update-check.js).
//
// System > Updates lets an admin pick a branch tip (main, development, ...)
// or a GitHub release and install it. This module does everything that can
// be done while the current version keeps running, so a failure at any of
// these steps changes nothing:
//
//   resolve   ask GitHub which commit the branch/tag points at
//   download  fetch that commit's source tarball into data/updates/downloads
//   extract   unpack it into data/updates/staging/<sha>
//   install   npm ci (dev dependencies included, the build needs Vite)
//   build     npm run build, then drop dev dependencies again
//   verify    syntax-check the new server.js and launcher.js, check the
//             frontend bundle exists
//   backup    back up the database (Backup Now's same code, labeled
//             pre-update)
//   restart   write data/updates/pending.json and exit with code 75
//
// launcher.js takes it from there: it swaps the files, starts the new
// version on probation, and rolls everything back (database included) if the
// new version doesn't come up. See launcher.js's header for that half, and
// update-protocol.js for the files the two halves pass between them.
//
// Only offered when it can actually work: a standalone install started
// through the launcher. Docker installs update by pulling a new image (the
// page shows how); `node server.js` started directly has no launcher to
// apply anything.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const db = require('../db');
const { logInfo, logWarn, logError } = require('../logger');
const P = require('./update-protocol');
const { getDeploymentMode } = require('./deployment-mode');
const updateCheck = require('./update-check');
const { createBackup } = require('../routes/backups');
const pkg = require('../../package.json');

const PHASES = [
  { id: 'resolve', label: 'Finding the version on GitHub' },
  { id: 'download', label: 'Downloading' },
  { id: 'extract', label: 'Unpacking' },
  { id: 'install', label: 'Installing dependencies' },
  { id: 'build', label: 'Building the web interface' },
  { id: 'verify', label: 'Checking the new version' },
  { id: 'backup', label: 'Backing up the database' },
  { id: 'restart', label: 'Restarting into the new version' },
];

const STEP_TIMEOUT_MS = Number(process.env.KITSUNE_UPDATE_STEP_TIMEOUT_MS) || 15 * 60 * 1000;
const MAX_LOG_LINES = 400;
const TARGETS_CACHE_MS = 5 * 60 * 1000;
const REF_RE = /^[A-Za-z0-9._/+-]{1,200}$/;

const state = {
  running: false,
  phase: null,
  target: null,
  comparison: null,
  startedAt: null,
  error: null,
  errorPhase: null,
  restarting: false,
  log: [],
};

let shutdownHook = null;
let targetsCache = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function addLog(line) {
  const text = String(line).replace(/\s+$/, '');
  if (!text) return;
  state.log.push(`${new Date().toISOString().slice(11, 19)}  ${text}`);
  if (state.log.length > MAX_LOG_LINES) state.log.splice(0, state.log.length - MAX_LOG_LINES);
}

function setPhase(id) {
  state.phase = id;
  const phase = PHASES.find((p) => p.id === id);
  addLog(`— ${phase ? phase.label : id}`);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function npmCommand() {
  // A service manager's PATH often doesn't include where node lives, so
  // prefer the npm that ships next to the running node binary.
  const besideNode = path.join(path.dirname(process.execPath), process.platform === 'win32' ? 'npm.cmd' : 'npm');
  return fs.existsSync(besideNode) ? besideNode : 'npm';
}

// Runs a command, streaming its output into the install log. Rejects with
// the tail of its output on a non-zero exit or after STEP_TIMEOUT_MS.
function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    addLog(`$ ${path.basename(cmd)} ${args.join(' ')}`);
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: { ...process.env, ...(opts.env || {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tail = [];
    const onData = (buf) => {
      for (const line of buf.toString('utf8').split(/\r?\n/)) {
        if (!line.trim()) continue;
        addLog(`  ${line}`);
        tail.push(line);
        if (tail.length > 15) tail.shift();
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${path.basename(cmd)} ${args[0] || ''} took longer than ${Math.round(STEP_TIMEOUT_MS / 60000)} minutes and was stopped.`));
    }, STEP_TIMEOUT_MS);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not run ${path.basename(cmd)}: ${err.message}`));
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(cmd)} ${args[0] || ''} failed (exit code ${code})${tail.length ? `: ${tail.slice(-3).join(' | ')}` : ''}`));
    });
  });
}

function requireRepo() {
  const repo = updateCheck.getRepoInfo();
  if (!repo) throw new Error('No GitHub repository configured (package.json "repository" or KITSUNE_GITHUB_REPO).');
  return repo;
}

// ---------------------------------------------------------------------------
// What can be installed, and what installing it would mean
// ---------------------------------------------------------------------------
function getInstallSupport() {
  const mode = getDeploymentMode();
  const isGitCheckout = fs.existsSync(path.join(P.ROOT, '.git'));
  if (mode === 'docker') {
    return {
      supported: false,
      reason: 'docker',
      message: 'This is a Docker install. Update it by pulling the image tag you want and recreating the container.',
      dockerImage: (process.env.KITSUNE_DOCKER_IMAGE || 'ghcr.io/seanpdiaz/kitsune').trim(),
    };
  }
  if (/^(1|true|yes)$/i.test(process.env.KITSUNE_DISABLE_UPDATES || '')) {
    return { supported: false, reason: 'disabled', message: 'In-app updates are turned off by the KITSUNE_DISABLE_UPDATES environment variable.' };
  }
  if (process.env.KITSUNE_LAUNCHER !== '1') {
    return {
      supported: false,
      reason: 'no-launcher',
      message: 'Kitsune was started with "node server.js", so nothing is there to apply an update and restart it. Start it with "npm start" (or "node launcher.js") to install updates from here.',
    };
  }
  return { supported: true, isGitCheckout };
}

async function listTargets({ refresh = false } = {}) {
  if (!refresh && targetsCache && Date.now() - targetsCache.at < TARGETS_CACHE_MS) return targetsCache.value;
  const repo = requireRepo();
  const base = `${updateCheck.GITHUB_API_BASE}/repos/${repo.owner}/${repo.repo}`;
  const [branchesRaw, releasesRaw] = await Promise.all([
    updateCheck.githubGet(`${base}/branches?per_page=100`),
    updateCheck.githubGet(`${base}/releases?per_page=30`),
  ]);
  // main and development first, then everything else alphabetically.
  const rank = (name) => (name === 'main' ? 0 : name === 'development' ? 1 : 2);
  const branches = branchesRaw
    .map((b) => ({ name: b.name, commit: b.commit && b.commit.sha }))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
  const releases = releasesRaw
    .filter((r) => !r.draft)
    .map((r) => ({
      tag: r.tag_name,
      name: r.name || r.tag_name,
      prerelease: !!r.prerelease,
      publishedAt: r.published_at || r.created_at || null,
      htmlUrl: r.html_url || null,
    }));
  const value = { repo, branches, releases };
  targetsCache = { at: Date.now(), value };
  return value;
}

async function resolveTarget(type, ref) {
  if (type !== 'branch' && type !== 'release') throw Object.assign(new Error('type must be "branch" or "release".'), { status: 400 });
  if (typeof ref !== 'string' || !REF_RE.test(ref) || ref.includes('..')) throw Object.assign(new Error('Invalid branch or release name.'), { status: 400 });
  const repo = requireRepo();
  const raw = await updateCheck.githubGet(`${updateCheck.GITHUB_API_BASE}/repos/${repo.owner}/${repo.repo}/commits/${encodeURIComponent(ref)}`);
  const commit = updateCheck.summarizeCommit(raw);
  return {
    type,
    ref,
    commit: commit.sha,
    shortSha: commit.shortSha,
    message: commit.message,
    date: commit.date,
    htmlUrl: commit.htmlUrl,
    label: type === 'branch' ? `${ref} @ ${commit.shortSha}` : ref,
  };
}

// How the target relates to what's running:
//   upgrade    the target contains everything this build has, plus more
//   downgrade  the target is an ancestor of this build (going back)
//   switch     each side has commits the other doesn't (e.g. development
//              -> main before a merge); the ones only this build has go away
//   identical  same commit
//   unknown    this build has no recorded commit to compare against
async function compareTarget(target) {
  const build = updateCheck.loadBuildInfo();
  if (!build.commit) return { relation: 'unknown', aheadBy: null, behindBy: null, commits: [], warn: true };
  if (build.commit === target.commit) return { relation: 'identical', aheadBy: 0, behindBy: 0, commits: [], warn: false };
  const repo = requireRepo();
  try {
    const cmp = await updateCheck.githubGet(`${updateCheck.GITHUB_API_BASE}/repos/${repo.owner}/${repo.repo}/compare/${build.commit}...${target.commit}`);
    const relation = { ahead: 'upgrade', behind: 'downgrade', diverged: 'switch', identical: 'identical' }[cmp.status] || 'unknown';
    return {
      relation,
      aheadBy: cmp.ahead_by,
      behindBy: cmp.behind_by,
      commits: (cmp.commits || []).map(updateCheck.summarizeCommit).reverse().slice(0, 50),
      warn: relation !== 'upgrade',
    };
  } catch (err) {
    logWarn('Updater', `Could not compare this build with ${target.label}: ${err.message}`);
    return { relation: 'unknown', aheadBy: null, behindBy: null, commits: [], warn: true };
  }
}

async function previewTarget(type, ref) {
  const target = await resolveTarget(type, ref);
  const comparison = await compareTarget(target);
  return { target, comparison };
}

// ---------------------------------------------------------------------------
// Installing
// ---------------------------------------------------------------------------
async function downloadTarball(target, dest) {
  const repo = requireRepo();
  const url = `${updateCheck.GITHUB_API_BASE}/repos/${repo.owner}/${repo.repo}/tarball/${target.commit}`;
  const res = await fetch(url, { headers: updateCheck.githubHeaders(), redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`GitHub returned HTTP ${res.status} for the source download.`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  const size = fs.statSync(dest).size;
  addLog(`  ${(size / 1024 / 1024).toFixed(1)} MB`);
}

async function runInstall(target, comparison, user) {
  const build = updateCheck.loadBuildInfo();
  const stagingDir = path.join(P.STAGING_DIR, target.commit);
  const tarball = path.join(P.DOWNLOADS_DIR, `${target.commit}.tar.gz`);
  const npm = npmCommand();
  try {
    // resolve already happened in startInstall; the phase is shown for
    // completeness so the checklist reads top to bottom.
    setPhase('download');
    fs.rmSync(stagingDir, { recursive: true, force: true });
    await downloadTarball(target, tarball);

    setPhase('extract');
    fs.mkdirSync(stagingDir, { recursive: true });
    await run('tar', ['-xzf', tarball, '-C', stagingDir, '--strip-components=1']);
    for (const required of ['package.json', 'server.js']) {
      if (!fs.existsSync(path.join(stagingDir, required))) throw new Error(`The download doesn't look like Kitsune (no ${required}).`);
    }
    if (!fs.existsSync(path.join(stagingDir, 'launcher.js'))) {
      throw new Error(`${target.label} is older than in-app updates (it has no launcher.js), so it can't be installed from here: it would have no way to update or roll back afterwards. Install it by hand instead.`);
    }
    // There's no .git in a tarball, so write-build-info.js (run by
    // `npm run build`) leaves this file alone and the new version knows
    // exactly what it is.
    writeJson(path.join(stagingDir, 'build-info.json'), {
      commit: target.commit,
      branch: target.type === 'branch' ? target.ref : null,
      tag: target.type === 'release' ? target.ref : null,
      builtAt: new Date().toISOString(),
      source: 'in-app-update',
    });

    setPhase('install');
    const npmEnv = { NODE_ENV: 'development', npm_config_update_notifier: 'false' };
    const hasLock = fs.existsSync(path.join(stagingDir, 'package-lock.json'));
    await run(npm, hasLock ? ['ci', '--include=dev', '--no-audit', '--no-fund'] : ['install', '--include=dev', '--no-audit', '--no-fund'], { cwd: stagingDir, env: npmEnv });

    setPhase('build');
    await run(npm, ['run', 'build'], { cwd: stagingDir, env: npmEnv });
    await run(npm, ['prune', '--omit=dev', '--no-audit', '--no-fund'], { cwd: stagingDir, env: { npm_config_update_notifier: 'false' } });

    setPhase('verify');
    await run(process.execPath, ['--check', 'server.js'], { cwd: stagingDir });
    await run(process.execPath, ['--check', 'launcher.js'], { cwd: stagingDir });
    if (!fs.existsSync(path.join(stagingDir, 'public', 'dist'))) throw new Error('The build finished but produced no public/dist.');
    const stagedPkg = readJson(path.join(stagingDir, 'package.json')) || {};

    setPhase('backup');
    const backup = await createBackup('pre-update');
    addLog(`  ${backup.name}`);

    setPhase('restart');
    const pending = {
      protocol: P.PROTOCOL,
      token: crypto.randomBytes(16).toString('hex'),
      stagingDir,
      backupFile: backup.filePath,
      dbClient: db.DB_CLIENT,
      from: { commit: build.commit, branch: build.branch, tag: build.tag, version: pkg.version },
      to: { type: target.type, ref: target.ref, commit: target.commit, label: target.label, version: stagedPkg.version || null },
      relation: comparison.relation,
      // After a healthy start, Settings > General's Branch follows what was
      // installed, so the next update check compares against the right one.
      setChannel: target.type === 'branch' ? target.ref : null,
      requestedBy: user ? user.username : null,
      createdAt: state.startedAt,
    };
    writeJson(P.PENDING_PATH, pending);
    fs.rmSync(tarball, { force: true });
    state.restarting = true;
    logInfo('Updater', `Update to ${target.label} is staged; restarting so the launcher can apply it`);
    addLog('  Kitsune will be back in a moment.');

    // Give the browser's poll a chance to see "restarting" before the
    // server goes away.
    setTimeout(async () => {
      try {
        if (shutdownHook) await shutdownHook();
      } catch (err) {
        logWarn('Updater', `Shutdown before the update didn't finish cleanly: ${err.message}`);
      }
      process.exit(P.UPDATE_EXIT_CODE);
    }, 1500);
  } catch (err) {
    state.error = err.message || String(err);
    state.errorPhase = state.phase;
    state.running = false;
    addLog(`✗ ${state.error}`);
    logError('Updater', `Update to ${target.label} failed while ${(PHASES.find((p) => p.id === state.phase) || {}).label || state.phase}: ${state.error}`);
    fs.rmSync(stagingDir, { recursive: true, force: true });
    fs.rmSync(tarball, { force: true });
    try {
      writeJson(P.LAST_RESULT_PATH, {
        status: 'failed',
        phase: state.errorPhase,
        reason: state.error,
        from: { commit: build.commit, branch: build.branch, tag: build.tag, version: pkg.version },
        to: { type: target.type, ref: target.ref, commit: target.commit, label: target.label },
        requestedBy: user ? user.username : null,
        startedAt: state.startedAt,
        finishedAt: new Date().toISOString(),
      });
    } catch {
      // the in-memory state above still reports the failure
    }
  }
}

// Returns { started: true } or { needsConfirm: true, target, comparison }.
// Throws errors with a .status for the route to send.
async function startInstall({ type, ref, confirm }, user) {
  const support = getInstallSupport();
  if (!support.supported) throw Object.assign(new Error(support.message), { status: 409 });
  if (state.running) throw Object.assign(new Error('An update is already in progress.'), { status: 409 });
  if (fs.existsSync(P.PENDING_PATH) || fs.existsSync(P.JOURNAL_PATH)) {
    throw Object.assign(new Error('An earlier update is still waiting to be applied. Restart Kitsune and try again.'), { status: 409 });
  }

  const target = await resolveTarget(type, ref);
  const comparison = await compareTarget(target);
  if (comparison.relation === 'identical') {
    throw Object.assign(new Error(`Kitsune is already running ${target.label}.`), { status: 400 });
  }
  if (comparison.warn && !confirm) return { needsConfirm: true, target, comparison };

  Object.assign(state, {
    running: true,
    phase: 'resolve',
    target,
    comparison,
    startedAt: new Date().toISOString(),
    error: null,
    errorPhase: null,
    restarting: false,
    log: [],
  });
  addLog(`— ${PHASES[0].label}`);
  addLog(`  ${target.label}: ${target.message}`);
  logInfo('Updater', `${user ? user.username : 'Someone'} started an update to ${target.label} (${comparison.relation})`);
  runInstall(target, comparison, user).catch((err) => logError('Updater', `Unexpected updater error: ${err.stack || err}`));
  return { started: true };
}

function getInstallStatus() {
  return {
    support: getInstallSupport(),
    phases: PHASES,
    running: state.running,
    phase: state.phase,
    target: state.target,
    comparison: state.comparison ? { relation: state.comparison.relation, aheadBy: state.comparison.aheadBy, behindBy: state.comparison.behindBy } : null,
    startedAt: state.startedAt,
    error: state.error,
    errorPhase: state.errorPhase,
    restarting: state.restarting,
    log: state.log,
    lastResult: readJson(P.LAST_RESULT_PATH),
  };
}

// server.js registers this so the HTTP server and database close cleanly
// before the exit that hands over to the launcher.
function setShutdownHook(fn) {
  shutdownHook = fn;
}

// Called once from server.js after it starts listening. When the launcher
// started this process on probation, tells it this version is up, and
// applies the post-update settings change the old version asked for.
async function reportStartup() {
  if (process.env.KITSUNE_UPDATE_PROBATION !== '1') return;
  const journal = readJson(P.JOURNAL_PATH);
  const channel = journal && journal.pending && journal.pending.setChannel;
  if (channel) {
    try {
      const row = await db.prepare("SELECT data FROM app_settings WHERE section = 'general'").get();
      const merged = { ...(row ? JSON.parse(row.data) : {}), 'general-12': channel };
      await db.prepare(`
        INSERT INTO app_settings (section, data, updated_at) VALUES ('general', ?, ?)
        ON CONFLICT(section) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at
      `).run(JSON.stringify(merged), db.now());
    } catch (err) {
      logWarn('Updater', `Could not switch the update branch to ${channel}: ${err.message}`);
    }
  }
  const build = updateCheck.loadBuildInfo();
  writeJson(P.HEALTHY_PATH, { token: process.env.KITSUNE_UPDATE_TOKEN || null, commit: build.commit, pid: process.pid, at: new Date().toISOString() });
  logInfo('Updater', `Started after an update (${(build.commit || 'unknown').slice(0, 7)}); reported healthy to the launcher`);
}

function isPostUpdateStart() {
  return process.env.KITSUNE_UPDATE_PROBATION === '1';
}

module.exports = {
  getInstallSupport,
  listTargets,
  previewTarget,
  startInstall,
  getInstallStatus,
  setShutdownHook,
  reportStartup,
  isPostUpdateStart,
};
