#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Tests for in-app updates (server/lib/updater.js + launcher.js).
//
//   node scripts/test-updater.js              # everything
//   node scripts/test-updater.js --launcher   # launcher scenarios only (fast)
//
// Part 1 runs the real launcher.js against tiny fake servers in temp
// directories: a successful swap, every rollback trigger (crash on start,
// never becoming healthy, crashing during the settle window), recovery from
// a launcher killed mid-swap, a bad pending.json, exit-code pass-through and
// signal forwarding.
//
// Part 2 runs the real app end to end: a copy of this working tree started
// through launcher.js, pointed at a local mock of the GitHub API that serves
// tarballs built from this same tree. It installs a good version (real
// download, npm ci, vite build, backup, restart, swap, health check), then a
// version that crashes after touching the database (confirm-required
// downgrade, then a real rollback with the SQLite backup restored), then a
// version too old to have launcher.js (refused, nothing changed). Needs npm
// registry access for the staged `npm ci`.
//
// Everything happens under a temp directory; this checkout is never touched.
// ---------------------------------------------------------------------------
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const zlib = require('zlib');
const { spawn, execFileSync } = require('child_process');

const REPO = path.join(__dirname, '..');
const LAUNCHER_ONLY = process.argv.includes('--launcher');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-updater-test-'));

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failed++;
    console.log(`  ✗ ${name}\n      ${(err && err.stack ? err.stack : String(err)).split('\n').slice(0, 4).join('\n      ')}`);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let v;
    try {
      v = await fn();
    } catch {
      v = null;
    }
    if (v) return v;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(200);
  }
}
const readJson = (f) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
};
const read = (f) => {
  try {
    return fs.readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};

function startLauncher(root, env = {}) {
  const proc = spawn(process.execPath, [path.join(root, 'launcher.js')], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const out = [];
  proc.stdout.on('data', (b) => out.push(b.toString()));
  proc.stderr.on('data', (b) => out.push(b.toString()));
  const exited = new Promise((resolve) => proc.on('exit', (code, signal) => resolve({ code, signal })));
  return { proc, exited, output: () => out.join('') };
}

async function stopLauncher(l) {
  if (l.proc.exitCode === null && l.proc.signalCode === null) l.proc.kill('SIGTERM');
  const res = await Promise.race([l.exited, sleep(20000).then(() => null)]);
  if (!res) {
    l.proc.kill('SIGKILL');
    throw new Error('launcher did not stop on SIGTERM');
  }
  return res;
}

// ===========================================================================
// Part 1 — launcher.js against fake servers
// ===========================================================================
const FAST_HEALTH = { KITSUNE_UPDATE_HEALTH_TIMEOUT_MS: '3000', KITSUNE_UPDATE_HEALTH_SETTLE_MS: '1000' };

function fakeServerSource(version, behavior) {
  return `
const fs = require('fs');
const path = require('path');
const P = require('./server/lib/update-protocol');
const V = ${JSON.stringify(version)};
const B = ${JSON.stringify(behavior || {})};
const startsLog = path.join(P.DATA_DIR, 'starts.log');
fs.appendFileSync(startsLog, V + '\\n');
process.on('SIGTERM', () => { fs.appendFileSync(startsLog, V + '-sigterm\\n'); process.exit(0); });
if (process.env.KITSUNE_UPDATE_PROBATION === '1') {
  if (B.mutateDb) fs.writeFileSync(P.SQLITE_DB_PATH, 'DB-MUTATED-BY-' + V);
  if (B.crash === 'immediately') process.exit(1);
  if (!B.neverHealthy) fs.writeFileSync(P.HEALTHY_PATH, JSON.stringify({ token: process.env.KITSUNE_UPDATE_TOKEN, commit: V }));
  if (B.crash === 'after-healthy') setTimeout(() => process.exit(2), 400);
}
const trigger = path.join(P.DATA_DIR, 'trigger-update.json');
if (fs.existsSync(trigger)) {
  const pending = fs.readFileSync(trigger, 'utf8');
  fs.unlinkSync(trigger);
  fs.mkdirSync(P.UPDATES_DIR, { recursive: true });
  fs.writeFileSync(P.PENDING_PATH, pending);
  process.exit(75);
}
const exitFile = path.join(P.DATA_DIR, 'exit-code');
if (fs.existsSync(exitFile)) process.exit(Number(fs.readFileSync(exitFile, 'utf8')));
setInterval(() => {}, 1000);
`;
}

function writeFakeInstall(dir, version, behavior) {
  fs.mkdirSync(path.join(dir, 'server', 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'node_modules', '.bin'), { recursive: true });
  fs.copyFileSync(path.join(REPO, 'launcher.js'), path.join(dir, 'launcher.js'));
  fs.copyFileSync(path.join(REPO, 'server', 'lib', 'update-protocol.js'), path.join(dir, 'server', 'lib', 'update-protocol.js'));
  fs.copyFileSync(path.join(REPO, 'server', 'env.js'), path.join(dir, 'server', 'env.js'));
  fs.writeFileSync(path.join(dir, 'server.js'), fakeServerSource(version, behavior));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fake', version }));
  fs.writeFileSync(path.join(dir, 'VERSION'), version);
  fs.symlinkSync('../fake-pkg/cli.js', path.join(dir, 'node_modules', '.bin', 'fake-cli'));
}

// A fake install "A" with data/, .env, and a staged fake "B" ready to apply.
function setupScenario(name, bBehavior, pendingOverrides = {}) {
  const root = path.join(TMP, 'launcher', name);
  writeFakeInstall(root, 'A');
  fs.writeFileSync(path.join(root, '.env'), 'SOMETHING=kept\n');
  const data = path.join(root, 'data');
  fs.mkdirSync(path.join(data, 'backups'), { recursive: true });
  fs.writeFileSync(path.join(data, 'kitsune.db'), 'DB-ORIGINAL');
  const backupFile = path.join(data, 'backups', 'kitsune_backup_pre-update_test.db.gz');
  fs.writeFileSync(backupFile, zlib.gzipSync('DB-BACKUP'));
  const staging = path.join(data, 'updates', 'staging', 'bbbbbbb');
  writeFakeInstall(staging, 'B', bBehavior);
  const pending = {
    protocol: 1,
    token: `tok-${name}`,
    stagingDir: staging,
    backupFile,
    dbClient: 'sqlite',
    from: { commit: 'aaaaaaa', branch: 'main' },
    to: { type: 'branch', ref: 'development', commit: 'bbbbbbb', label: 'development @ bbbbbbb' },
    setChannel: 'development',
    createdAt: new Date().toISOString(),
    ...pendingOverrides,
  };
  fs.writeFileSync(path.join(data, 'trigger-update.json'), JSON.stringify(pending));
  return { root, data, staging, backupFile, pending };
}

const starts = (data) => (read(path.join(data, 'starts.log')) || '').trim().split('\n').filter(Boolean);
const lastResult = (data) => readJson(path.join(data, 'updates', 'last-result.json'));

async function launcherTests() {
  console.log('\nLauncher (fake servers)');

  await check('applies a staged update and confirms it once the new version is healthy', async () => {
    const s = setupScenario('success', {});
    const l = startLauncher(s.root, FAST_HEALTH);
    const result = await waitFor(() => lastResult(s.data), 10000, 'last-result.json');
    assert.strictEqual(result.status, 'success', l.output());
    assert.strictEqual(read(path.join(s.root, 'VERSION')), 'B');
    assert.deepStrictEqual(starts(s.data), ['A', 'B']);
    assert.strictEqual(read(path.join(s.root, '.env')), 'SOMETHING=kept\n', '.env kept');
    assert.strictEqual(read(path.join(s.data, 'kitsune.db')), 'DB-ORIGINAL', 'database untouched on success');
    assert.ok(!fs.existsSync(path.join(s.data, 'updates', 'journal.json')), 'journal removed');
    assert.ok(!fs.existsSync(s.staging), 'staging dir removed');
    const rb = fs.readdirSync(path.join(s.data, 'updates', 'rollback'));
    assert.strictEqual(rb.length, 1);
    assert.strictEqual(read(path.join(s.data, 'updates', 'rollback', rb[0], 'VERSION')), 'A', 'previous version kept for rollback');
    assert.ok(fs.existsSync(path.join(s.data, 'updates', 'rollback', rb[0], 'launcher.js')), "previous launcher.js kept for rollback");
    assert.strictEqual(fs.readlinkSync(path.join(s.root, 'node_modules', '.bin', 'fake-cli')), '../fake-pkg/cli.js', 'symlinks moved as symlinks');
    const { code } = await stopLauncher(l);
    assert.strictEqual(code, 0);
    assert.ok(starts(s.data).includes('B-sigterm'), 'SIGTERM forwarded to the server');
  });

  await check('rolls back and restores the database when the new version crashes on start', async () => {
    const s = setupScenario('crash', { crash: 'immediately', mutateDb: true });
    const l = startLauncher(s.root, FAST_HEALTH);
    const result = await waitFor(() => lastResult(s.data), 10000, 'last-result.json');
    await waitFor(() => starts(s.data).length >= 3, 5000, 'A restarted');
    assert.strictEqual(result.status, 'rolled-back', l.output());
    assert.match(result.reason, /exited with code 1 before it finished starting/);
    assert.strictEqual(result.database, 'restored');
    assert.strictEqual(read(path.join(s.root, 'VERSION')), 'A');
    assert.deepStrictEqual(starts(s.data), ['A', 'B', 'A']);
    assert.strictEqual(read(path.join(s.data, 'kitsune.db')), 'DB-BACKUP', 'database restored from the pre-update backup');
    const failedDirs = fs.readdirSync(path.join(s.data, 'updates', 'failed'));
    assert.strictEqual(failedDirs.length, 1);
    const fd = path.join(s.data, 'updates', 'failed', failedDirs[0]);
    assert.strictEqual(read(path.join(fd, 'files', 'VERSION')), 'B', 'failed version kept for inspection');
    assert.strictEqual(read(path.join(fd, 'kitsune.db')), 'DB-MUTATED-BY-B', 'database the failed version left behind kept');
    assert.ok(!fs.existsSync(path.join(s.data, 'updates', 'rollback', fs.readdirSync(path.join(s.data, 'updates', 'rollback'))[0] || 'none')), 'rollback dir emptied');
    assert.strictEqual(read(path.join(s.root, '.env')), 'SOMETHING=kept\n');
    await stopLauncher(l);
  });

  await check('rolls back when the new version never reports healthy', async () => {
    const s = setupScenario('timeout', { neverHealthy: true });
    const l = startLauncher(s.root, FAST_HEALTH);
    const result = await waitFor(() => lastResult(s.data), 15000, 'last-result.json');
    assert.strictEqual(result.status, 'rolled-back', l.output());
    assert.match(result.reason, /didn't finish starting within 3s/);
    await waitFor(() => starts(s.data).join(',') === 'A,B,B-sigterm,A', 5000, 'B stopped and A restarted');
    assert.strictEqual(read(path.join(s.root, 'VERSION')), 'A');
    await stopLauncher(l);
  });

  await check('rolls back when the new version dies during the settle window', async () => {
    const s = setupScenario('settle', { crash: 'after-healthy' });
    const l = startLauncher(s.root, FAST_HEALTH);
    const result = await waitFor(() => lastResult(s.data), 10000, 'last-result.json');
    assert.strictEqual(result.status, 'rolled-back', l.output());
    assert.match(result.reason, /exited with code 2 shortly after starting/);
    assert.strictEqual(read(path.join(s.root, 'VERSION')), 'A');
    await stopLauncher(l);
  });

  await check("refuses a pending.json from an unknown protocol and changes nothing", async () => {
    const s = setupScenario('protocol', {}, { protocol: 99 });
    const l = startLauncher(s.root, FAST_HEALTH);
    const result = await waitFor(() => lastResult(s.data), 10000, 'last-result.json');
    assert.strictEqual(result.status, 'failed');
    assert.match(result.reason, /protocol 99/);
    await waitFor(() => starts(s.data).join(',') === 'A,A', 5000, 'A restarted');
    assert.strictEqual(read(path.join(s.root, 'VERSION')), 'A');
    assert.ok(!fs.existsSync(path.join(s.data, 'updates', 'pending.json')));
    await stopLauncher(l);
  });

  await check('refuses a pending.json that points outside data/updates/staging', async () => {
    const s = setupScenario('escape', {}, { stagingDir: path.join(TMP, 'elsewhere') });
    const l = startLauncher(s.root, FAST_HEALTH);
    const result = await waitFor(() => lastResult(s.data), 10000, 'last-result.json');
    assert.strictEqual(result.status, 'failed');
    assert.match(result.reason, /outside data\/updates\/staging/);
    assert.strictEqual(read(path.join(s.root, 'VERSION')), 'A');
    await stopLauncher(l);
  });

  for (const phase of ['moving-out', 'moving-in', 'probation']) {
    await check(`recovers the previous version after the launcher was killed mid-update (${phase})`, async () => {
      const s = setupScenario(`recover-${phase}`, {});
      fs.unlinkSync(path.join(s.data, 'trigger-update.json'));
      const rollbackDir = path.join(s.data, 'updates', 'rollback', 'x_aaaaaaa');
      fs.mkdirSync(rollbackDir, { recursive: true });
      const originals = fs.readdirSync(s.root).filter((n) => n !== 'data' && !n.startsWith('.env'));
      // Recreate exactly what a launcher dying in this phase leaves behind:
      // launcher.js is copied aside (never moved out), the new one replaces
      // it first when moving in, then the rest follows.
      fs.copyFileSync(path.join(s.root, 'launcher.js'), path.join(rollbackDir, 'launcher.js'));
      const toMoveOut = phase === 'moving-out' ? ['server.js', 'VERSION'] : originals.filter((n) => n !== 'launcher.js');
      for (const n of toMoveOut) fs.renameSync(path.join(s.root, n), path.join(rollbackDir, n));
      if (phase !== 'moving-out') {
        fs.appendFileSync(path.join(s.staging, 'launcher.js'), '\n// staged copy\n');
        fs.renameSync(path.join(s.staging, 'launcher.js'), path.join(s.root, 'launcher.js'));
        const staged = fs.readdirSync(s.staging);
        const toMoveIn = phase === 'moving-in' ? ['server.js', 'VERSION'] : staged;
        for (const n of toMoveIn) fs.renameSync(path.join(s.staging, n), path.join(s.root, n));
      }
      if (phase === 'probation') fs.writeFileSync(path.join(s.data, 'kitsune.db'), 'DB-MUTATED');
      fs.writeFileSync(path.join(s.data, 'updates', 'journal.json'), JSON.stringify({ protocol: 1, phase, pending: s.pending, rollbackDir }));

      const l = startLauncher(s.root, FAST_HEALTH);
      const result = await waitFor(() => lastResult(s.data), 10000, 'last-result.json');
      assert.strictEqual(result.status, 'rolled-back', l.output());
      assert.match(result.reason, /stopped during an update/);
      await waitFor(() => starts(s.data).join(',') === 'A', 5000, 'A started');
      assert.strictEqual(read(path.join(s.root, 'VERSION')), 'A');
      for (const n of originals) assert.ok(fs.existsSync(path.join(s.root, n)), `${n} restored`);
      assert.strictEqual(read(path.join(s.root, 'server.js')), fakeServerSource('A', {}));
      assert.strictEqual(read(path.join(s.root, 'launcher.js')), read(path.join(REPO, 'launcher.js')), "the previous version's launcher.js is back");
      assert.strictEqual(read(path.join(s.data, 'kitsune.db')), phase === 'probation' ? 'DB-BACKUP' : 'DB-ORIGINAL',
        'database restored only if the new version had run');
      assert.ok(!fs.existsSync(path.join(s.data, 'updates', 'journal.json')));
      await stopLauncher(l);
    });
  }

  await check("passes the server's own exit code through", async () => {
    const root = path.join(TMP, 'launcher', 'exit-code');
    writeFakeInstall(root, 'A');
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'exit-code'), '3');
    const l = startLauncher(root, FAST_HEALTH);
    const { code } = await l.exited;
    assert.strictEqual(code, 3);
  });
}

// ===========================================================================
// Part 2 — the real app, end to end, against a mock GitHub
// ===========================================================================
function listWorkingTree() {
  // Tracked files plus new untracked ones, minus anything gitignored.
  return execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: REPO })
    .toString('utf8').split('\0').filter((f) => f && fs.existsSync(path.join(REPO, f)));
}

function copyTree(files, dest) {
  for (const f of files) {
    const to = path.join(dest, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(REPO, f), to);
  }
}

// A GitHub-style source tarball (single top-level directory) of this tree,
// with `mutate(dir)` applied first.
function makeTarball(name, files, mutate) {
  const work = path.join(TMP, 'tarballs', name);
  const top = `seanpdiaz-kitsune-${name}`;
  copyTree(files, path.join(work, top));
  if (mutate) mutate(path.join(work, top));
  const file = path.join(TMP, 'tarballs', `${name}.tar.gz`);
  execFileSync('tar', ['-czf', file, '-C', work, top]);
  return file;
}

function startMockGitHub(versions, compareStatus) {
  // versions: { refName: { sha, message, tarball } }
  const bySha = Object.fromEntries(Object.values(versions).map((v) => [v.sha, v]));
  const commitJson = (v) => ({ sha: v.sha, html_url: `https://example.invalid/${v.sha}`, commit: { message: v.message, author: { name: 'Test', date: '2026-11-09T00:00:00Z' } } });
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    let m;
    if (url.pathname === '/repos/o/r/branches') return send(200, Object.entries(versions).filter(([k]) => !k.startsWith('v')).map(([name, v]) => ({ name, commit: { sha: v.sha } })));
    if (url.pathname === '/repos/o/r/releases') return send(200, [{ tag_name: 'v9.9.9', name: 'v9.9.9', draft: false, prerelease: false, published_at: '2026-11-01T00:00:00Z' }, { tag_name: 'v0-draft', draft: true }]);
    if ((m = url.pathname.match(/^\/repos\/o\/r\/commits\/(.+)$/))) {
      const v = versions[decodeURIComponent(m[1])];
      return v ? send(200, commitJson(v)) : send(404, { message: 'Not Found' });
    }
    if ((m = url.pathname.match(/^\/repos\/o\/r\/compare\/([^.]+)\.\.\.(.+)$/))) {
      const head = bySha[m[2]];
      const status = compareStatus(m[1], m[2]);
      return send(200, { status, ahead_by: status === 'behind' ? 0 : 1, behind_by: status === 'ahead' ? 0 : 2, commits: head ? [commitJson(head)] : [] });
    }
    if ((m = url.pathname.match(/^\/repos\/o\/r\/tarball\/(.+)$/))) {
      // Real GitHub answers with a redirect to codeload; follow the same path.
      res.writeHead(302, { Location: `/codeload/${m[1]}` });
      return res.end();
    }
    if ((m = url.pathname.match(/^\/codeload\/(.+)$/))) {
      const v = bySha[m[1]];
      if (!v) return send(404, { message: 'Not Found' });
      res.writeHead(200, { 'Content-Type': 'application/x-gzip' });
      return fs.createReadStream(v.tarball).pipe(res);
    }
    return send(404, { message: `mock has no ${url.pathname}` });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function e2eTests() {
  console.log('\nEnd to end (real app, mock GitHub)');
  const files = listWorkingTree();
  const SHA_A = 'a'.repeat(40);
  const SHA_GOOD = '1'.repeat(40);
  const SHA_BROKEN = '2'.repeat(40);
  const SHA_OLD = '3'.repeat(40);

  const goodTar = makeTarball('good', files, (dir) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pkg.version = '0.2.0-test';
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  });
  const brokenTar = makeTarball('broken', files, (dir) => {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    pkg.version = '0.3.0-broken';
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
    // Valid syntax (passes the staging check), but touches the database and
    // then dies on startup — exactly what a bad migration looks like.
    const src = fs.readFileSync(path.join(dir, 'server.js'), 'utf8');
    const marker = '  await startRetentionScheduler();';
    assert.ok(src.includes(marker), 'server.js layout changed; update the broken-version mutation');
    fs.writeFileSync(path.join(dir, 'server.js'), src.replace(marker, "  await db.exec('CREATE TABLE broken_version_was_here (x TEXT)');\n  throw new Error('boom: simulated bad migration');"));
  });
  const oldTar = makeTarball('old', files, (dir) => fs.unlinkSync(path.join(dir, 'launcher.js')));

  const versions = {
    'test-good': { sha: SHA_GOOD, message: 'A good version', tarball: goodTar },
    'test-broken': { sha: SHA_BROKEN, message: 'A broken version', tarball: brokenTar },
    'test-old': { sha: SHA_OLD, message: 'Predates in-app updates', tarball: oldTar },
    'v9.9.9': { sha: SHA_GOOD, message: 'A good version', tarball: goodTar },
    main: { sha: SHA_GOOD, message: 'A good version', tarball: goodTar },
  };
  // test-broken counts as a downgrade, to exercise the confirm step.
  const mock = await startMockGitHub(versions, (base, head) => (head === SHA_BROKEN ? 'behind' : base === head ? 'identical' : 'ahead'));
  const apiBase = `http://127.0.0.1:${mock.address().port}`;

  const root = path.join(TMP, 'e2e', 'kitsune');
  copyTree(files, root);
  fs.writeFileSync(path.join(root, 'build-info.json'), JSON.stringify({ commit: SHA_A, branch: 'development', builtAt: new Date().toISOString() }));
  const port = 30000 + Math.floor(Math.random() * 20000);
  const base = `http://127.0.0.1:${port}`;
  const env = {
    PORT: String(port),
    KITSUNE_GITHUB_API_BASE: apiBase,
    KITSUNE_GITHUB_REPO: 'o/r',
    GITHUB_TOKEN: '',
    DB_CLIENT: 'sqlite',
    APP_ENV: 'production',
    KITSUNE_UPDATE_METHOD: 'standalone',
    KITSUNE_UPDATE_HEALTH_SETTLE_MS: '3000',
  };
  let cookie = '';
  const api = async (method, p, body, { auth = true } = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { 'Content-Type': 'application/json', ...(auth && cookie ? { Cookie: cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: res.status, body: json, headers: res.headers };
  };
  const up = async () => (await api('GET', '/api/system-updates')).body;
  const waitForResult = async (startedAt, what) => waitFor(async () => {
    const s = await up();
    const r = s && s.install.lastResult;
    return r && r.finishedAt > startedAt ? s : null;
  }, 8 * 60 * 1000, what);

  const l = startLauncher(root, env);
  try {
    await waitFor(() => up(), 30000, 'server to start');

    await check('reports install support when started through the launcher', async () => {
      const s = await up();
      assert.strictEqual(s.install.support.supported, true, JSON.stringify(s.install.support));
      assert.strictEqual(s.buildInfo.commit, SHA_A);
    });

    const setup = await api('POST', '/api/auth/setup', { username: 'admin', password: 'correct horse battery' });
    cookie = (setup.headers.get('set-cookie') || '').split(';')[0];
    await api('POST', '/api/tags', { name: 'before-update', color: '#ff0000' });

    await check('lists branches and releases (drafts hidden)', async () => {
      const t = await api('GET', '/api/system-updates/targets');
      assert.strictEqual(t.status, 200, JSON.stringify(t.body));
      assert.strictEqual(t.body.branches[0].name, 'main', 'main sorts first');
      assert.deepStrictEqual(t.body.releases.map((r) => r.tag), ['v9.9.9']);
    });

    await check('previews an upgrade and a downgrade', async () => {
      const good = await api('GET', '/api/system-updates/preview?type=branch&ref=test-good');
      assert.strictEqual(good.body.comparison.relation, 'upgrade');
      assert.strictEqual(good.body.target.commit, SHA_GOOD);
      const broken = await api('GET', '/api/system-updates/preview?type=branch&ref=test-broken');
      assert.strictEqual(broken.body.comparison.relation, 'downgrade');
      const bad = await api('GET', '/api/system-updates/preview?type=branch&ref=..%2Fetc');
      assert.strictEqual(bad.status, 400);
    });

    await check('refuses an install from someone not signed in', async () => {
      const r = await api('POST', '/api/system-updates/install', { type: 'branch', ref: 'test-good' }, { auth: false });
      assert.strictEqual(r.status, 401);
    });

    await check('installs a version: download, npm ci, build, backup, restart, swap, health check', async () => {
      const startedAt = new Date().toISOString();
      const r = await api('POST', '/api/system-updates/install', { type: 'branch', ref: 'test-good' });
      assert.strictEqual(r.status, 202, JSON.stringify(r.body));
      const again = await api('POST', '/api/system-updates/install', { type: 'branch', ref: 'test-good' });
      assert.strictEqual(again.status, 409, 'a second install while one runs is refused');
      const s = await waitForResult(startedAt, 'the good update');
      assert.strictEqual(s.install.lastResult.status, 'success', JSON.stringify(s.install.lastResult) + '\n' + l.output().slice(-3000));
      assert.strictEqual(s.currentVersion, '0.2.0-test', 'new version is the one running');
      assert.strictEqual(s.buildInfo.commit, SHA_GOOD);
      assert.strictEqual(s.buildInfo.branch, 'test-good');
      assert.ok(fs.existsSync(path.join(root, 'public', 'dist', 'system-updates.js')), 'frontend was built');
      assert.ok(!fs.existsSync(path.join(root, 'node_modules', 'vite')), 'dev dependencies pruned');
      const backups = fs.readdirSync(path.join(root, 'data', 'backups')).filter((f) => f.includes('pre-update'));
      assert.strictEqual(backups.length, 1, 'pre-update backup written');
      const tags = await api('GET', '/api/tags');
      assert.ok(tags.body.some((t) => t.name === 'before-update'), 'data carried over');
      const settings = await api('GET', '/api/app-settings/general');
      const general = settings.body && (settings.body.data || settings.body);
      assert.strictEqual(general && general['general-12'], 'test-good', 'update branch follows what was installed');
    });

    await check('a downgrade needs confirming', async () => {
      const r = await api('POST', '/api/system-updates/install', { type: 'branch', ref: 'test-broken' });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.body.needsConfirm, true);
      assert.strictEqual(r.body.comparison.relation, 'downgrade');
    });

    await check('rolls back a version that breaks on startup and restores the database', async () => {
      await api('POST', '/api/tags', { name: 'before-broken', color: '#00ff00' });
      const startedAt = new Date().toISOString();
      const r = await api('POST', '/api/system-updates/install', { type: 'branch', ref: 'test-broken', confirm: true });
      assert.strictEqual(r.status, 202, JSON.stringify(r.body));
      const s = await waitForResult(startedAt, 'the broken update to roll back');
      const res = s.install.lastResult;
      assert.strictEqual(res.status, 'rolled-back', JSON.stringify(res) + '\n' + l.output().slice(-3000));
      assert.strictEqual(res.database, 'restored');
      assert.match(res.reason, /before it finished starting/);
      assert.strictEqual(s.currentVersion, '0.2.0-test', 'previous version running again');
      assert.strictEqual(s.buildInfo.commit, SHA_GOOD);
      const tags = await api('GET', '/api/tags');
      assert.ok(tags.body.some((t) => t.name === 'before-broken'), 'data from just before the update is there');
      const { DatabaseSync } = require('node:sqlite');
      const dbFile = new DatabaseSync(path.join(root, 'data', 'kitsune.db'), { readOnly: true });
      const row = dbFile.prepare("SELECT name FROM sqlite_master WHERE name = 'broken_version_was_here'").get();
      dbFile.close();
      assert.ok(!row, "the broken version's database change was undone");
    });

    await check('refuses a version that predates launcher.js and changes nothing', async () => {
      const r = await api('POST', '/api/system-updates/install', { type: 'branch', ref: 'test-old', confirm: true });
      assert.strictEqual(r.status, 202, JSON.stringify(r.body));
      const s = await waitFor(async () => {
        const st = await up();
        return st && !st.install.running && st.install.error ? st : null;
      }, 60000, 'the old-version install to fail');
      assert.match(s.install.error, /older than in-app updates/);
      assert.strictEqual(s.install.errorPhase, 'extract');
      assert.strictEqual(s.install.lastResult.status, 'failed');
      assert.strictEqual(s.buildInfo.commit, SHA_GOOD, 'still on the same version');
      assert.ok(!fs.existsSync(path.join(root, 'data', 'updates', 'staging', SHA_OLD)), 'staging cleaned up');
    });

    await check('stops cleanly on SIGTERM', async () => {
      const { code } = await stopLauncher(l);
      assert.strictEqual(code, 0);
    });
  } finally {
    if (l.proc.exitCode === null) l.proc.kill('SIGKILL');
    mock.close();
  }
}

(async () => {
  console.log(`Working in ${TMP}`);
  await launcherTests();
  if (!LAUNCHER_ONLY) await e2eTests();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (!failed) fs.rmSync(TMP, { recursive: true, force: true });
  else console.log(`Left ${TMP} in place for inspection.`);
  process.exit(failed ? 1 : 0);
})();
