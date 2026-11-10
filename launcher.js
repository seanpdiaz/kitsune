#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Kitsune launcher — `npm start` runs this, and it runs server.js.
//
// A running Node process can't safely replace its own files and restart
// itself, so in-app updates are split in two:
//
//   1. The server (server/lib/updater.js) does everything that can fail
//      without consequence while the current version keeps running: it
//      downloads the target version, installs its dependencies, builds its
//      frontend into data/updates/staging/<sha>/, and backs up the database.
//      Then it writes data/updates/pending.json and exits with code 75.
//
//   2. This launcher sees exit code 75, moves the current version's files to
//      data/updates/rollback/, moves the staged files into place and starts
//      the new server on probation. The new server has HEALTH_TIMEOUT_MS to
//      open the database and start listening, then must stay up for
//      HEALTH_SETTLE_MS. If it doesn't, the launcher stops it, puts the
//      previous version's files back, restores the SQLite database from the
//      pre-update backup, records why in data/updates/last-result.json, and
//      starts the previous version again.
//
// Every step of the swap is written to data/updates/journal.json first, so if
// the launcher itself dies partway through (power cut, OOM kill, the service
// being stopped mid-update), the next start finds the journal and rolls back
// before running anything.
//
// Anything other than exit code 75 is passed through: the launcher exits with
// the server's own exit code, so a supervisor such as systemd (see
// scripts/kitsune.service) sees a crash exactly as it would without the
// launcher. Signals (SIGTERM, SIGINT, SIGHUP) are forwarded to the server.
//
// Running `node server.js` directly still works; the server just won't offer
// to install updates, because nothing would be there to apply them.
// ---------------------------------------------------------------------------
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------------------------------------------------------------------------
// The update protocol — the contract between this launcher and the server
// that stages updates (server/lib/updater.js, which reads these constants
// through server/lib/update-protocol.js).
//
// It lives here rather than in a server/ module, and this file requires
// nothing from the rest of the install, because the launcher has to keep
// working when the rest of the install is half-swapped: recovering from a
// launcher that died mid-update means starting with whatever is on disk.
// For the same reason the swap never moves launcher.js out of the install
// root — it's copied aside for rollback and replaced by an atomic rename —
// so `node launcher.js` always has something to run.
//
// A running launcher keeps this copy in memory for its whole life, so an
// update that rewrites this file can't change the rules under it. That's
// what PROTOCOL is for: pending.json and journal.json carry it, and a newer
// server staging an update for an older, still-running launcher has to speak
// a format that launcher understands. Bump it only for an incompatible
// change, and teach the launcher to accept both.
// ---------------------------------------------------------------------------
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const UPDATES_DIR = path.join(DATA_DIR, 'updates');

const P = {
  PROTOCOL: 1,
  ROOT,
  DATA_DIR,
  UPDATES_DIR,
  STAGING_DIR: path.join(UPDATES_DIR, 'staging'),
  ROLLBACK_DIR: path.join(UPDATES_DIR, 'rollback'),
  FAILED_DIR: path.join(UPDATES_DIR, 'failed'),
  DOWNLOADS_DIR: path.join(UPDATES_DIR, 'downloads'),
  // Written by the server once a staged update is built and the pre-update
  // backup exists; consumed (and deleted) by the launcher.
  PENDING_PATH: path.join(UPDATES_DIR, 'pending.json'),
  // The launcher's record of a swap in progress, from the first file move
  // until the new version is confirmed healthy or rolled back.
  JOURNAL_PATH: path.join(UPDATES_DIR, 'journal.json'),
  // Written by the new server once its database is ready and it's listening.
  HEALTHY_PATH: path.join(UPDATES_DIR, 'healthy.json'),
  // Outcome of the most recent update attempt, for System > Updates.
  LAST_RESULT_PATH: path.join(UPDATES_DIR, 'last-result.json'),
  // Same file server/db-sqlite.js opens; restored from the pre-update backup
  // on rollback, because the new version may already have migrated it.
  SQLITE_DB_PATH: path.join(DATA_DIR, 'kitsune.db'),
  // This file. Copied aside and replaced by rename, never moved away.
  LAUNCHER_NAME: 'launcher.js',
  // Top-level entries an update never touches. Everything else at the top
  // level belongs to the release and is swapped as a unit. `.env*` covers
  // .env, .env.local, .env.deploy, etc.
  isPreserved(name) {
    return name === 'data' || name === '.git' || name.startsWith('.env');
  },
  // Exit code the server uses for "a staged update is ready — stop me and
  // apply it." 75 is EX_TEMPFAIL from sysexits.h; a real crash (1, signals)
  // stays distinct from it.
  UPDATE_EXIT_CODE: 75,
  // How long the new version gets to open its database and start listening,
  // and how long it then has to stay up, before it counts as healthy.
  // Read when the constants are first used (after .env is loaded below).
  get HEALTH_TIMEOUT_MS() { return Number(process.env.KITSUNE_UPDATE_HEALTH_TIMEOUT_MS) || 180000; },
  get HEALTH_SETTLE_MS() { return Number(process.env.KITSUNE_UPDATE_HEALTH_SETTLE_MS) || 10000; },
  // Previous versions kept under rollback/ after a success, and failed
  // attempts kept under failed/.
  KEEP_ROLLBACKS: 1,
  KEEP_FAILED: 2,
};

const SERVER_ENTRY = path.join(ROOT, 'server.js');

function log(msg) {
  console.log(`[launcher] ${new Date().toISOString()} ${msg}`);
}

// ---------------------------------------------------------------------------
// Small filesystem helpers
// ---------------------------------------------------------------------------
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// Write-then-rename so a reader (or a crash) never sees half a file.
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function removeQuietly(target) {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (err) {
    log(`Could not remove ${target}: ${err.message}`);
  }
}

// rename() is atomic and instant on one filesystem. data/ can be a separate
// mount from the install directory, in which case rename fails with EXDEV and
// this falls back to copy-then-delete (symlinks such as node_modules/.bin/*
// are copied as symlinks, not followed).
function moveEntry(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV') throw err;
    fs.cpSync(from, to, { recursive: true, verbatimSymlinks: true, preserveTimestamps: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function isInside(child, parent) {
  const rel = path.relative(parent, child);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function pruneDir(dir, keep) {
  let entries;
  try {
    entries = fs.readdirSync(dir).map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs }));
  } catch {
    return;
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  for (const e of entries.slice(keep)) removeQuietly(path.join(dir, e.name));
}

function writeResult(result) {
  try {
    writeJson(P.LAST_RESULT_PATH, { ...result, finishedAt: new Date().toISOString() });
  } catch (err) {
    log(`Could not record the update result: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// The server process
// ---------------------------------------------------------------------------
let current = null; // { proc, exited: Promise<{code, signal}> }
let shuttingDown = false;

function spawnServer(probation) {
  const env = { ...process.env, KITSUNE_LAUNCHER: '1' };
  delete env.KITSUNE_UPDATE_PROBATION;
  delete env.KITSUNE_UPDATE_TOKEN;
  if (probation) {
    env.KITSUNE_UPDATE_PROBATION = '1';
    env.KITSUNE_UPDATE_TOKEN = probation.token;
  }
  const proc = spawn(process.execPath, [SERVER_ENTRY], { cwd: P.ROOT, env, stdio: 'inherit' });
  const exited = new Promise((resolve) => {
    proc.on('exit', (code, signal) => resolve({ code, signal }));
    proc.on('error', (err) => {
      log(`Could not start the server: ${err.message}`);
      resolve({ code: 1, signal: null });
    });
  });
  current = { proc, exited };
  return current;
}

async function stopServer(run, reason) {
  if (!run || run.proc.exitCode !== null || run.proc.signalCode !== null) return;
  log(`Stopping the server (${reason})`);
  run.proc.kill('SIGTERM');
  const killTimer = setTimeout(() => {
    log('Server did not stop within 15s, killing it');
    run.proc.kill('SIGKILL');
  }, 15000);
  await run.exited;
  clearTimeout(killTimer);
}

// Resolves { ok: true } once the new server has written healthy.json with
// this attempt's token and then stayed up for HEALTH_SETTLE_MS; otherwise
// { ok: false, reason }.
function waitForHealth(run, token) {
  return new Promise((resolve) => {
    const deadline = Date.now() + P.HEALTH_TIMEOUT_MS;
    let settleUntil = null;
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      resolve(result);
    };
    run.exited.then(({ code, signal }) => {
      const how = signal ? `was stopped by ${signal}` : `exited with code ${code}`;
      finish({ ok: false, reason: settleUntil ? `The new version ${how} shortly after starting.` : `The new version ${how} before it finished starting.` });
    });
    const timer = setInterval(() => {
      if (settleUntil === null) {
        const healthy = readJson(P.HEALTHY_PATH);
        if (healthy && healthy.token === token) {
          settleUntil = Date.now() + P.HEALTH_SETTLE_MS;
          log(`New version is up (${(healthy.commit || 'unknown').slice(0, 7)}); watching it for ${Math.round(P.HEALTH_SETTLE_MS / 1000)}s`);
        } else if (Date.now() > deadline) {
          finish({ ok: false, reason: `The new version didn't finish starting within ${Math.round(P.HEALTH_TIMEOUT_MS / 1000)}s.` });
        }
      } else if (Date.now() >= settleUntil) {
        finish({ ok: true });
      }
    }, 250);
  });
}

// ---------------------------------------------------------------------------
// Applying and rolling back
// ---------------------------------------------------------------------------
function validatePending(pending) {
  if (!pending || typeof pending !== 'object') throw new Error('pending.json is missing or unreadable.');
  if (pending.protocol !== P.PROTOCOL) throw new Error(`pending.json uses update protocol ${pending.protocol}; this launcher understands ${P.PROTOCOL}. Restart Kitsune and try again.`);
  const staging = path.resolve(String(pending.stagingDir || ''));
  if (!isInside(staging, P.STAGING_DIR)) throw new Error('pending.json points outside data/updates/staging.');
  for (const required of ['server.js', 'launcher.js', 'package.json', 'node_modules']) {
    if (!fs.existsSync(path.join(staging, required))) throw new Error(`The staged version is missing ${required}.`);
  }
  if (!pending.token) throw new Error('pending.json has no token.');
  return staging;
}

function applyUpdate(pending) {
  const staging = validatePending(pending);
  const rollbackDir = path.join(P.ROLLBACK_DIR, `${stamp()}_${String(pending.from && pending.from.commit || 'unknown').slice(0, 7)}`);
  const journal = { protocol: P.PROTOCOL, phase: 'moving-out', pending, rollbackDir, startedAt: new Date().toISOString() };
  writeJson(P.JOURNAL_PATH, journal);
  removeQuietly(P.PENDING_PATH);

  log(`Applying update ${String(pending.from && pending.from.commit || '?').slice(0, 7)} -> ${String(pending.to.commit).slice(0, 7)} (${pending.to.label})`);
  fs.mkdirSync(rollbackDir, { recursive: true });
  fs.copyFileSync(path.join(P.ROOT, P.LAUNCHER_NAME), path.join(rollbackDir, P.LAUNCHER_NAME));
  for (const name of fs.readdirSync(P.ROOT)) {
    if (P.isPreserved(name) || name === P.LAUNCHER_NAME) continue;
    moveEntry(path.join(P.ROOT, name), path.join(rollbackDir, name));
  }

  journal.phase = 'moving-in';
  writeJson(P.JOURNAL_PATH, journal);
  // The new launcher.js first, replacing the old one in a single rename.
  moveEntry(path.join(staging, P.LAUNCHER_NAME), path.join(P.ROOT, P.LAUNCHER_NAME));
  for (const name of fs.readdirSync(staging)) {
    if (P.isPreserved(name)) continue;
    moveEntry(path.join(staging, name), path.join(P.ROOT, name));
  }
  removeQuietly(staging);

  journal.phase = 'probation';
  writeJson(P.JOURNAL_PATH, journal);
  return journal;
}

function restoreSqliteBackup(backupFile, failedDir) {
  if (!backupFile || !fs.existsSync(backupFile)) {
    log('No pre-update database backup to restore');
    return 'missing';
  }
  if (fs.existsSync(P.SQLITE_DB_PATH)) {
    fs.mkdirSync(failedDir, { recursive: true });
    fs.copyFileSync(P.SQLITE_DB_PATH, path.join(failedDir, 'kitsune.db'));
  }
  const tmp = `${P.SQLITE_DB_PATH}.restore-${process.pid}`;
  fs.writeFileSync(tmp, zlib.gunzipSync(fs.readFileSync(backupFile)));
  for (const suffix of ['-wal', '-shm']) removeQuietly(P.SQLITE_DB_PATH + suffix);
  fs.renameSync(tmp, P.SQLITE_DB_PATH);
  log(`Restored the database from ${path.basename(backupFile)}`);
  return 'restored';
}

// Puts the previous version back. Safe to call for a journal in any phase,
// including one left behind by a launcher that died mid-swap.
function rollback(journal, reason) {
  const failedDir = path.join(P.FAILED_DIR, `${stamp()}_${String(journal.pending.to.commit).slice(0, 7)}`);
  log(`Rolling back: ${reason}`);

  // In 'moving-out', everything still at the top level is the old version
  // (not yet moved), so only the entries already in rollbackDir come back.
  // In 'moving-in' and 'probation', every old entry is in rollbackDir, so
  // whatever is at the top level now came from the new version.
  // launcher.js is the exception throughout: it never leaves the root, and
  // the old copy in rollbackDir replaces whatever is there with one rename.
  if (journal.phase !== 'moving-out') {
    for (const name of fs.readdirSync(P.ROOT)) {
      if (P.isPreserved(name)) continue;
      if (name === P.LAUNCHER_NAME) {
        fs.mkdirSync(path.join(failedDir, 'files'), { recursive: true });
        fs.copyFileSync(path.join(P.ROOT, name), path.join(failedDir, 'files', name));
        continue;
      }
      moveEntry(path.join(P.ROOT, name), path.join(failedDir, 'files', name));
    }
  }
  if (fs.existsSync(journal.rollbackDir)) {
    for (const name of fs.readdirSync(journal.rollbackDir)) {
      moveEntry(path.join(journal.rollbackDir, name), path.join(P.ROOT, name));
    }
    removeQuietly(journal.rollbackDir);
  }

  // Only the probation phase ran new code against the database.
  let database = 'untouched';
  if (journal.phase === 'probation') {
    if (journal.pending.dbClient === 'sqlite') {
      try {
        database = restoreSqliteBackup(journal.pending.backupFile, failedDir);
      } catch (err) {
        database = 'restore-failed';
        log(`Could not restore the database backup: ${err.message}`);
      }
    } else {
      // Postgres: restoring a pg_dump means dropping and recreating a schema
      // on a server this app doesn't own, which is not something to do
      // unattended. Migrations only ever add tables/columns, so the previous
      // version normally runs fine against the newer schema anyway.
      database = 'not-restored-postgres';
    }
  }

  removeQuietly(P.HEALTHY_PATH);
  removeQuietly(P.JOURNAL_PATH);
  pruneDir(P.FAILED_DIR, P.KEEP_FAILED);
  writeResult({
    status: 'rolled-back',
    reason,
    database,
    backupFile: journal.pending.backupFile || null,
    from: journal.pending.from,
    to: journal.pending.to,
    requestedBy: journal.pending.requestedBy || null,
    startedAt: journal.pending.createdAt || journal.startedAt,
  });
}

function finalizeSuccess(journal) {
  removeQuietly(P.HEALTHY_PATH);
  removeQuietly(P.JOURNAL_PATH);
  pruneDir(P.ROLLBACK_DIR, P.KEEP_ROLLBACKS);
  removeQuietly(P.DOWNLOADS_DIR);
  writeResult({
    status: 'success',
    from: journal.pending.from,
    to: journal.pending.to,
    backupFile: journal.pending.backupFile || null,
    requestedBy: journal.pending.requestedBy || null,
    startedAt: journal.pending.createdAt || journal.startedAt,
  });
  log(`Update to ${String(journal.pending.to.commit).slice(0, 7)} (${journal.pending.to.label}) is healthy`);
}

// A journal at startup means the last update never got confirmed healthy.
function recoverInterruptedUpdate() {
  const journal = readJson(P.JOURNAL_PATH);
  if (!journal) return;
  if (!journal.pending || !journal.rollbackDir) {
    log('Found an unreadable update journal; leaving the install as it is');
    removeQuietly(P.JOURNAL_PATH);
    return;
  }
  rollback(journal, `Kitsune was stopped during an update (while ${journal.phase === 'probation' ? 'the new version was starting' : 'files were being swapped'}), so the previous version was put back.`);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
async function main() {
  try {
    recoverInterruptedUpdate();
  } catch (err) {
    log(`Recovery from an interrupted update failed: ${err.stack || err}`);
    process.exit(1);
  }

  let probation = null; // journal of an update whose new version is starting

  for (;;) {
    removeQuietly(P.HEALTHY_PATH);
    const run = spawnServer(probation && { token: probation.pending.token });

    if (probation) {
      const outcome = await waitForHealth(run, probation.pending.token);
      if (outcome.ok) {
        finalizeSuccess(probation);
        probation = null;
      } else {
        await stopServer(run, 'failed its health check');
        if (shuttingDown) {
          // Leave the journal: the next start rolls back before running.
          process.exit(0);
        }
        try {
          rollback(probation, outcome.reason);
        } catch (err) {
          log(`Rollback failed: ${err.stack || err}`);
          process.exit(1);
        }
        probation = null;
        continue;
      }
    }

    const { code, signal } = await run.exited;
    if (shuttingDown) process.exit(code === null ? 0 : code);

    if (code === P.UPDATE_EXIT_CODE) {
      const pending = readJson(P.PENDING_PATH);
      try {
        probation = applyUpdate(pending);
      } catch (err) {
        log(`Could not apply the update: ${err.message}`);
        const journal = readJson(P.JOURNAL_PATH);
        if (journal && journal.pending) {
          try {
            rollback(journal, `Swapping files failed: ${err.message}`);
          } catch (rbErr) {
            log(`Rollback failed: ${rbErr.stack || rbErr}`);
            process.exit(1);
          }
        } else {
          removeQuietly(P.PENDING_PATH);
          writeResult({
            status: 'failed',
            reason: err.message,
            from: pending && pending.from,
            to: pending && pending.to,
            requestedBy: pending && pending.requestedBy,
          });
        }
        probation = null;
      }
      continue;
    }

    log(signal ? `Server was stopped by ${signal}` : `Server exited with code ${code}`);
    process.exit(code === null ? 1 : code);
  }
}

// server/lib/update-protocol.js requires this file for the constants above;
// only `node launcher.js` actually runs it.
if (require.main === module) {
  // Same .env the server reads, so e.g. the health-check timeouts apply here
  // too. Optional: mid-recovery, server/env.js may not be on disk.
  try {
    require('./server/env').loadEnvFile(path.join(ROOT, '.env'));
  } catch {
    // run with the process environment as it is
  }
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => {
      shuttingDown = true;
      if (current && current.proc.exitCode === null) {
        current.proc.kill(sig);
      } else {
        process.exit(0);
      }
    });
  }
  main();
}

module.exports = { protocol: P };
