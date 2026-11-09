// ---------------------------------------------------------------------------
// End-to-end test for Wanted > Manual Import (server/routes/manual-import.js).
//
//   node scripts/test-manual-import.js
//
// Never touches your real data: copies the app (minus node_modules, data/,
// .git and .env) into a temp folder, starts it on port 3999 with a fresh
// SQLite database, builds a fake downloads/library tree, runs the scan and
// import API through every case below, then deletes the temp folder.
// ffmpeg is optional — without it the "probed resolution" checks are skipped.
// ---------------------------------------------------------------------------
const { spawn, execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.resolve(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-mi-test-'));
const APP = path.join(WORK, 'app');
const T = path.join(WORK, 'fixtures');

function setUp() {
  fs.cpSync(REPO, APP, {
    recursive: true,
    filter: (src) => !['node_modules', 'data', '.git', '.env'].includes(path.relative(REPO, src).split(path.sep)[0]),
  });
  fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(APP, 'node_modules'));
  const dl = path.join(T, 'downloads');
  fs.mkdirSync(path.join(T, 'library'), { recursive: true });
  fs.mkdirSync(path.join(dl, '[Judas] Sousou no Frieren (Batch) [1080p]', 'Season 2'), { recursive: true });
  fs.mkdirSync(path.join(dl, 'misc'), { recursive: true });
  const junk = (p, n = 200000) => fs.writeFileSync(path.join(dl, p), Buffer.alloc(n, 7));
  let haveFfmpeg = true;
  try {
    // A real 1920x1080 video under a "720p" name — the import should probe
    // it and correct the quality.
    execFileSync('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=black:s=1920x1080:d=1', '-c:v', 'libx264', '-t', '1',
      path.join(dl, '[SubsPlease] Sousou no Frieren - 05 (720p) [ABCD1234].mkv')]);
  } catch {
    haveFfmpeg = false;
    junk('[SubsPlease] Sousou no Frieren - 05 (720p) [ABCD1234].mkv');
  }
  junk('[SubsPlease] Sousou no Frieren - 06 (1080p) [EF567890].mkv', 300000);
  junk(path.join('[Judas] Sousou no Frieren (Batch) [1080p]', 'Season 2', '03.mkv'));
  junk(path.join('misc', 'random_thing_no_number.mkv'));
  junk('[Group] Some Unknown Show - 02 [1080p].mkv');
  junk('[Group] Sousou no Frieren - 05 sample.mkv');
  return haveFfmpeg;
}
const HAVE_FFMPEG = setUp();

const BASE = 'http://127.0.0.1:3999';
let cookie = '';
let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) failures++; };

async function api(method, url, body, { auth = true } = {}) {
  const res = await fetch(BASE + url, {
    method, headers: { 'Content-Type': 'application/json', ...(auth && cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const sc = res.headers.get('set-cookie');
  if (sc) cookie = sc.split(';')[0];
  let json = null;
  try { json = await res.json(); } catch { /* */ }
  return { status: res.status, body: json };
}

(async () => {
  const server = spawn('node', ['server.js'], { cwd: APP, env: { ...process.env, PORT: '3999', DB_CLIENT: 'sqlite' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/auth/state`); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }

  try {
    // ---- setup ----
    let r = await api('POST', '/api/auth/setup', { username: 'sean', password: 'testpass123' });
    ok(r.status < 300, `first-run setup (${r.status})`);
    r = await api('POST', '/api/root-folders', { path: `${T}/library` });
    ok(r.status < 300, `add root folder (${r.status} ${JSON.stringify(r.body).slice(0, 120)})`);

    const db = new DatabaseSync(path.join(APP, 'data/kitsune.db'));
    // The running server holds the same file open — wait for its locks
    // instead of failing on the first contended write.
    db.exec('PRAGMA busy_timeout = 10000');
    const seriesPath = `${T}/library/Frieren - Beyond Journey's End`;
    fs.mkdirSync(`${seriesPath}/Season 01`, { recursive: true });
    const oldE6 = `${seriesPath}/Season 01/old-e06-file.mkv`;
    fs.writeFileSync(oldE6, 'old');
    const sid = Number(db.prepare(`INSERT INTO series (title, series_type, path, alt_titles, monitored, season_folder) VALUES (?, 'anime', ?, ?, 1, 1)`)
      .run("Frieren: Beyond Journey's End", seriesPath, JSON.stringify(['Sousou no Frieren'])).lastInsertRowid);
    const other = Number(db.prepare(`INSERT INTO series (title, series_type, path) VALUES ('Another Show', 'anime', ?)`).run(`${T}/library/Another Show`).lastInsertRowid);
    const ins = db.prepare('INSERT INTO episodes (series_id, season_number, num, title, downloaded, quality, path) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (let n = 1; n <= 28; n++) ins.run(sid, 1, n, `Episode ${n}`, n === 6 ? 1 : 0, n === 6 ? 'WEBDL-720p' : null, n === 6 ? oldE6 : null);
    for (let n = 1; n <= 10; n++) ins.run(sid, 2, n, `S2 Episode ${n}`, 0, null, null);
    ins.run(other, 1, 1, 'Other 1', 0, null, null);
    const ep = (s, n, series = sid) => db.prepare('SELECT * FROM episodes WHERE series_id = ? AND season_number = ? AND num = ?').get(series, s, n);

    // ---- auth ----
    const saved = cookie; cookie = '';
    r = await api('GET', `/api/manual-import/scan?path=${encodeURIComponent(`${T}/downloads`)}`, null, { auth: false });
    ok(r.status === 401, `scan without a session is refused (${r.status})`);
    r = await api('POST', '/api/manual-import', { items: [] }, { auth: false });
    ok(r.status === 401, `import without a session is refused (${r.status})`);
    cookie = saved;

    // ---- scan validation ----
    r = await api('GET', '/api/manual-import/scan?path=relative/dir');
    ok(r.status === 400, `relative path rejected: ${r.body && r.body.error}`);
    r = await api('GET', '/api/manual-import/scan?path=/');
    ok(r.status === 400, `filesystem root rejected: ${r.body && r.body.error}`);
    r = await api('GET', `/api/manual-import/scan?path=${encodeURIComponent(`${T}/nope`)}`);
    ok(r.status === 400, `missing folder rejected: ${r.body && r.body.error}`);

    // ---- scan ----
    r = await api('GET', `/api/manual-import/scan?path=${encodeURIComponent(`${T}/downloads`)}`);
    ok(r.status === 200, `scan downloads (${r.status})`);
    const files = r.body.files;
    console.log('      scanned:');
    for (const f of files) console.log(`        ${f.relativePath} → series ${f.seriesId} S${f.season} eps ${JSON.stringify(f.episodeIds)} ${f.quality || '-'}${f.reason ? ` (${f.reason})` : ''}`);
    const byName = (frag) => files.find((f) => f.relativePath.includes(frag));
    ok(!files.some((f) => /sample/i.test(f.name)), 'sample file skipped');
    const f5 = byName('Frieren - 05'); const f6 = byName('Frieren - 06'); const f203 = byName('Season 2/03.mkv');
    ok(f5 && f5.seriesId === sid && f5.season === 1 && f5.episodeIds[0] === ep(1, 5).id, 'E05 matched via alt title "Sousou no Frieren"');
    ok(f6 && f6.episodeIds[0] === ep(1, 6).id && /1080p/.test(f6.quality || ''), `E06 matched, quality ${f6 && f6.quality}`);
    ok(f203 && f203.seriesId === sid && f203.season === 2 && f203.episodeIds[0] === ep(2, 3).id, 'Season 2/03.mkv matched via folder name + season folder');
    const unknown = byName('Some Unknown Show');
    ok(unknown && unknown.seriesId === null && unknown.reason, `unknown show left unassigned: "${unknown && unknown.reason}"`);
    const nonum = byName('random_thing');
    ok(nonum && nonum.episodeIds.length === 0, 'file with no episode number left unassigned');

    // forced series
    r = await api('GET', `/api/manual-import/scan?path=${encodeURIComponent(`${T}/downloads`)}&seriesId=${other}`);
    ok(r.body.files.every((f) => f.seriesId === other), 'seriesId parameter pins every file to that series');

    // single file path
    r = await api('GET', `/api/manual-import/scan?path=${encodeURIComponent(f6.path)}`);
    ok(r.status === 200 && r.body.files.length === 1, 'scanning a single file works');

    // ---- import validation ----
    r = await api('POST', '/api/manual-import', { items: [
      { path: f5.path, seriesId: sid, episodeIds: [ep(1, 5).id] },
      { path: f6.path, seriesId: sid, episodeIds: [ep(1, 5).id] },
    ] });
    ok(r.status === 400 && /same episode/.test(r.body.error), `same episode twice rejected: ${r.body.error}`);
    ok(fs.existsSync(f5.path) && fs.existsSync(f6.path), 'nothing moved after a rejected request');
    r = await api('POST', '/api/manual-import', { items: [{ path: f5.path, seriesId: sid, episodeIds: [ep(1, 1, other).id] }] });
    ok(r.status === 200 && r.body.failed === 1 && /doesn't belong/.test(r.body.results[0].error), `episode from another series rejected: ${r.body.results[0].error}`);

    // queue row stuck retrying for E05 — should be cleared by the import
    db.prepare(`INSERT INTO queue (series_id, episode_id, release_title, status, import_attempts, last_import_error, source) VALUES (?, ?, 'stuck release', 'downloading', 3, 'boom', 'real')`).run(sid, ep(1, 5).id);
    // and an unrelated healthy queue row for E07 that must be left alone
    db.prepare(`INSERT INTO queue (series_id, episode_id, release_title, status, import_attempts, source) VALUES (?, ?, 'healthy', 'downloading', 0, 'real')`).run(sid, ep(1, 7).id);

    // ---- import (copy = hardlink on the same filesystem) ----
    r = await api('POST', '/api/manual-import', { mode: 'copy', items: [{ path: f5.path, seriesId: sid, episodeIds: [ep(1, 5).id], quality: f5.quality, qualityLocked: false }] });
    const res5 = r.body.results[0];
    ok(res5.ok, `E05 imported (${res5.method}) → ${res5.destPath}`);
    ok(fs.existsSync(f5.path), 'copy mode leaves the original in place');
    ok(res5.destPath && fs.existsSync(res5.destPath) && res5.destPath.startsWith(`${seriesPath}/Season 01/`), 'E05 landed in the series Season 01 folder');
    ok(fs.statSync(res5.destPath).ino === fs.statSync(f5.path).ino, 'same filesystem → hardlink');
    const row5 = ep(1, 5);
    ok(row5.downloaded === 1 && row5.path === res5.destPath, 'E05 marked downloaded with the real path');
    if (HAVE_FFMPEG) {
      ok(/1080p/.test(row5.quality || ''), `probed 1920x1080 video corrected the 720p filename guess → ${row5.quality}`);
      ok(row5.media_streams && JSON.parse(row5.media_streams).video.height === 1080, 'media streams recorded from ffprobe');
    } else {
      console.log('SKIP  probe checks (no ffmpeg)');
    }
    ok(res5.queueCleared === 1, `stuck queue row cleared (${res5.queueCleared})`);
    ok(db.prepare('SELECT COUNT(*) AS n FROM queue WHERE episode_id = ?').get(ep(1, 7).id).n === 1, 'unrelated queue row untouched');
    const hist = db.prepare("SELECT * FROM history WHERE episode_id = ? AND event_type = 'imported'").get(row5.id);
    ok(hist && /Manual import \(hardlinked\)/.test(hist.message), `history row written: "${hist && hist.message}"`);

    // ---- import (move), incl. replacing E06's existing file and a quality the user locked ----
    r = await api('POST', '/api/manual-import', { mode: 'move', items: [
      { path: f6.path, seriesId: sid, episodeIds: [ep(1, 6).id], quality: 'Bluray-1080p', qualityLocked: true },
      { path: f203.path, seriesId: sid, episodeIds: [ep(2, 3).id, ep(2, 4).id], quality: null, qualityLocked: false },
    ] });
    const [res6, res203] = r.body.results;
    ok(res6.ok && res6.method === 'move', `E06 moved → ${res6.destPath}`);
    ok(!fs.existsSync(f6.path), 'move mode removes the original');
    ok(!fs.existsSync(oldE6) && res6.replaced.includes(oldE6), 'old E06 file in the series folder replaced');
    ok(ep(1, 6).quality === 'Bluray-1080p', 'quality picked by hand is kept');
    ok(res203.ok && res203.destPath.includes('/Season 02/'), `two-episode file → ${res203.destPath}`);
    ok(ep(2, 3).path === res203.destPath && ep(2, 4).path === res203.destPath, 'both episodes point at the one file');

    // ---- rescan the library: already-imported files are flagged ----
    r = await api('GET', `/api/manual-import/scan?path=${encodeURIComponent(seriesPath)}`);
    const lib5 = r.body.files.find((f) => f.path === res5.destPath);
    ok(lib5 && lib5.alreadyImported && lib5.episodeIds[0] === row5.id, 'Library file shows as already imported');

    // ---- importing a file onto itself must not delete it ----
    r = await api('POST', '/api/manual-import', { mode: 'move', items: [{ path: res5.destPath, seriesId: sid, episodeIds: [row5.id], quality: row5.quality, qualityLocked: true }] });
    ok(r.body.results[0].ok && r.body.results[0].method === 'in-place' && fs.existsSync(res5.destPath), `import onto itself is a no-op (${r.body.results[0].method})`);

    // ---- re-importing the original E05 again (dest already a hardlink of it) ----
    r = await api('POST', '/api/manual-import', { mode: 'copy', items: [{ path: f5.path, seriesId: sid, episodeIds: [row5.id], quality: row5.quality, qualityLocked: true }] });
    ok(r.body.results[0].ok && r.body.results[0].method === 'already-linked' && fs.existsSync(res5.destPath), `re-import of an already-linked file is safe (${r.body.results[0].method})`);

    // ---- series with no folder ----
    const nofolder = Number(db.prepare(`INSERT INTO series (title, series_type, path) VALUES ('No Folder Show', 'anime', NULL)`).run().lastInsertRowid);
    ins.run(nofolder, 1, 1, 'NF 1', 0, null, null);
    const nfEp = ep(1, 1, nofolder);
    r = await api('POST', '/api/manual-import', { items: [{ path: unknown.path, seriesId: nofolder, episodeIds: [nfEp.id] }] });
    ok(r.body.results[0].ok === false && /no folder yet/.test(r.body.results[0].error), `series without a folder refused: ${r.body.results[0].error}`);

    // ---- stats recomputed ----
    const s = db.prepare('SELECT eps, pct FROM series WHERE id = ?').get(sid);
    ok(s.eps != null, `series stats recomputed (eps ${s.eps}, pct ${s.pct})`);

    // ---- queue scan with no download client ----
    const qid = Number(db.prepare(`INSERT INTO queue (series_id, episode_id, release_title, status, source) VALUES (?, ?, 'no client', 'downloading', 'real')`).run(sid, ep(1, 9).id).lastInsertRowid);
    r = await api('GET', `/api/manual-import/scan?queueId=${qid}`);
    ok(r.status === 400 && /download client/.test(r.body.error), `queue item without a client explains itself: ${r.body.error}`);

    // ---- pages are served ----
    const page = await fetch(`${BASE}/wanted-manual-import.html`, { headers: { Cookie: cookie } });
    ok(page.status === 200, `page served (${page.status})`);
  } catch (err) {
    failures++;
    console.log('ERROR', err.stack);
  } finally {
    server.kill();
    fs.rmSync(WORK, { recursive: true, force: true });
    const errs = log.split('\n').filter((l) => / ERROR /.test(l));
    if (errs.length) { console.log('server errors:'); errs.forEach((l) => console.log('  ', l)); }
    console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
    process.exit(failures ? 1 : 0);
  }
})();
