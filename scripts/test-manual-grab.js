// ---------------------------------------------------------------------------
// End-to-end test for adding a release by hand (server/routes/manual-grab.js).
//
//   node scripts/test-manual-grab.js
//
// Never touches your real data: copies the app (minus node_modules, data/,
// .git and .env) into a temp folder and starts it on port 3996 with a fresh
// SQLite database, next to a fake qBittorrent (port 3998) and a fake
// .torrent host (port 3997). Builds real .torrent files in memory, runs the
// preview and grab API through every case below, then deletes the temp
// folder.
// ---------------------------------------------------------------------------
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const REPO = path.resolve(__dirname, '..');
const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-mg-test-'));
const APP = path.join(WORK, 'app');
fs.cpSync(REPO, APP, {
  recursive: true,
  filter: (src) => !['node_modules', 'data', '.git', '.env'].includes(path.relative(REPO, src).split(path.sep)[0]),
});
fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(APP, 'node_modules'));

// ---- a minimal bencode encoder, for building real .torrent files ----
function benc(v) {
  if (Buffer.isBuffer(v)) return Buffer.concat([Buffer.from(`${v.length}:`), v]);
  if (typeof v === 'number') return Buffer.from(`i${v}e`);
  if (typeof v === 'string') return benc(Buffer.from(v, 'utf8'));
  if (Array.isArray(v)) return Buffer.concat([Buffer.from('l'), ...v.map(benc), Buffer.from('e')]);
  const keys = Object.keys(v).sort();
  return Buffer.concat([Buffer.from('d'), ...keys.flatMap((k) => [benc(k), benc(v[k])]), Buffer.from('e')]);
}
function makeTorrent(name, files) {
  const info = { name, 'piece length': 262144, pieces: Buffer.alloc(20, 1), files: files.map(([p, len]) => ({ path: p.split('/'), length: len })) };
  const buf = benc({ announce: 'http://tracker.invalid/announce', info });
  return { buf, hash: crypto.createHash('sha1').update(benc(info)).digest('hex') };
}
function base32(hex) {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...Buffer.from(hex, 'hex')].map((b) => b.toString(2).padStart(8, '0')).join('');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += A[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

// A Mob Psycho-style pack: Season 1 explicitly numbered, Season 2 numbered
// absolutely (13–14 = S2E01–02), plus a creditless OP, a sample and an .nfo.
const PACK = makeTorrent('[Judas] Mob Psycho 100 (Seasons 1-2) [BD 1080p][Dual-Audio]', [
  ['Season 1/[Judas] Mob Psycho 100 - S01E01.mkv', 1000],
  ['Season 1/[Judas] Mob Psycho 100 - S01E02.mkv', 1000],
  ['Season 1/[Judas] Mob Psycho 100 - S01E03.mkv', 1000],
  ['Season 2/[Judas] Mob Psycho 100 - 13.mkv', 1000],
  ['Season 2/[Judas] Mob Psycho 100 - 14.mkv', 1000],
  ['Extras/[Judas] Mob Psycho 100 - NCOP.mkv', 500],
  ['Season 1/[Judas] Mob Psycho 100 - S01E01 sample.mkv', 10],
  ['info.nfo', 10],
]);
const OTHER_SHOW = makeTorrent('[Group] Totally Different Show (01-02) [1080p]', [
  ['[Group] Totally Different Show - S05E40.mkv', 1000],
]);
const MAGNET_HASH = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';

// ---- fake qBittorrent ----
const qbAdds = [];
const qb = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/v2/auth/login') { res.setHeader('Set-Cookie', 'SID=abc; path=/'); return res.end('Ok.'); }
    if (url.pathname === '/api/v2/torrents/add') { qbAdds.push(Buffer.concat(chunks)); return res.end('Ok.'); }
    if (url.pathname === '/api/v2/torrents/info') {
      const hashes = (url.searchParams.get('hashes') || '').split('|').filter(Boolean);
      res.setHeader('Content-Type', 'application/json');
      return res.end(JSON.stringify(hashes.map((hash) => ({ hash, state: 'downloading', progress: 0, save_path: '/downloads', total_size: 1 }))));
    }
    if (url.pathname === '/api/v2/torrents/files') { res.setHeader('Content-Type', 'application/json'); return res.end('[]'); }
    res.statusCode = 404; res.end();
  });
}).listen(3998);

// ---- fake .torrent host ----
const host = http.createServer((req, res) => {
  if (req.url === '/files/pack.torrent') return res.end(PACK.buf);
  if (req.url === '/files/to-magnet') { res.statusCode = 302; res.setHeader('Location', `magnet:?xt=urn:btih:${MAGNET_HASH}&dn=Redirected`); return res.end(); }
  if (req.url === '/files/not-a-torrent') return res.end('<html>nope</html>');
  res.statusCode = 404; res.end();
}).listen(3997);

const BASE = 'http://127.0.0.1:3996';
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
  // ---- pure helpers (no server needed) ----
  // Loaded from a second copy: requiring a route opens that copy's own
  // database, which must not be the one the test server uses.
  const HELPERS = path.join(WORK, 'helpers');
  fs.cpSync(APP, HELPERS, { recursive: true, filter: (src) => path.basename(src) !== 'data' });
  const { pickFileForEpisode } = require(path.join(HELPERS, 'server/routes/queue.js'));
  const { torrentUrlFor, normalizeInfoHash, parseMagnet } = require(path.join(HELPERS, 'server/routes/manual-grab.js'));
  ok(torrentUrlFor('https://nyaa.si/view/1298990') === 'https://nyaa.si/download/1298990.torrent', 'Nyaa view link → its .torrent');
  ok(torrentUrlFor('https://nyaa.land/view/42/') === 'https://nyaa.land/download/42.torrent', 'mirror view link → same host');
  ok(torrentUrlFor('https://example.com/view/42') === 'https://example.com/view/42', 'non-Nyaa link fetched as-is');
  ok(torrentUrlFor('ftp://x/y') === null && torrentUrlFor('not a url') === null, 'non-http links refused');
  ok(normalizeInfoHash(base32(MAGNET_HASH)) === MAGNET_HASH, 'base32 info hash → hex');
  ok(parseMagnet(`magnet:?xt=urn:btih:${MAGNET_HASH.toUpperCase()}&dn=Show%20Pack&xl=1234`).title === 'Show Pack', 'magnet name read from dn');
  ok(parseMagnet('magnet:?dn=x').error && parseMagnet('http://x').error, 'magnet without a hash, or not a magnet, refused');
  const files = [{ name: 'Pack/Season 2/Show - 13.mkv', progress: 0.5 }, { name: 'Pack/Season 1/Show - S01E01.mkv', progress: 1 }];
  ok(pickFileForEpisode(files, { season_number: 2, num: 1 }, 'Pack/Season 2/Show - 13.mkv') === files[0], 'file hint wins over the filename guess');
  ok(pickFileForEpisode([{ name: 'Season 2/Show - 13.mkv' }], { season_number: 2, num: 1 }, 'Pack/Season 2/Show - 13.mkv')
    && pickFileForEpisode([{ name: 'a/Show - 13.mkv' }, { name: 'b/Show - 13.mkv' }, { name: 'c.mkv' }], { season_number: 9, num: 9 }, 'Pack/Show - 13.mkv') === null,
  'hint matches by filename when the top folder was dropped, but only when unambiguous');
  ok(pickFileForEpisode(files, { season_number: 1, num: 1 }, 'gone.mkv') === files[1], 'a stale hint falls back to the normal guess');

  const server = spawn('node', ['server.js'], { cwd: APP, env: { ...process.env, PORT: '3996', DB_CLIENT: 'sqlite' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`${BASE}/api/auth/state`); break; } catch { await new Promise((r) => setTimeout(r, 200)); }
  }

  try {
    let r = await api('POST', '/api/auth/setup', { username: 'sean', password: 'testpass123' });
    ok(r.status < 300, `first-run setup (${r.status})`);

    const db = new DatabaseSync(path.join(APP, 'data/kitsune.db'));
    db.exec('PRAGMA busy_timeout = 10000');
    db.prepare("INSERT INTO settings_items (section, data, position, created_at) VALUES ('download-clients', ?, 0, '2026-01-01')")
      .run(JSON.stringify({ type: 'qbittorrent', name: 'Fake qB', enabled: true, host: '127.0.0.1', port: 3998, category: 'kitsune' }));
    const sid = Number(db.prepare("INSERT INTO series (title, series_type, path) VALUES ('Mob Psycho 100', 'anime', ?)").run(path.join(WORK, 'lib/Mob')).lastInsertRowid);
    const other = Number(db.prepare("INSERT INTO series (title, series_type, path) VALUES ('Another', 'anime', ?)").run(path.join(WORK, 'lib/Another')).lastInsertRowid);
    const ins = db.prepare('INSERT INTO episodes (series_id, season_number, num, title, aired, downloaded) VALUES (?, ?, ?, ?, ?, ?)');
    for (let n = 1; n <= 12; n++) ins.run(sid, 1, n, `S1 Ep ${n}`, '2016-07-01', n === 3 ? 1 : 0);
    for (let n = 1; n <= 13; n++) ins.run(sid, 2, n, `S2 Ep ${n}`, n === 13 ? '2099-01-01' : '2019-01-01', 0);
    ins.run(other, 1, 1, 'Other 1', '2020-01-01', 0);
    const ep = (s, n, series = sid) => db.prepare('SELECT * FROM episodes WHERE series_id = ? AND season_number = ? AND num = ?').get(series, s, n);
    const b64 = (t) => t.buf.toString('base64');

    // ---- auth + validation ----
    const saved = cookie; cookie = '';
    r = await api('POST', '/api/manual-grab/preview', { seriesId: sid, magnet: 'x' }, { auth: false });
    ok(r.status === 401, `preview without a session is refused (${r.status})`);
    r = await api('POST', '/api/manual-grab', { token: 'x', episodeIds: [1] }, { auth: false });
    ok(r.status === 401, `grab without a session is refused (${r.status})`);
    cookie = saved;
    r = await api('POST', '/api/manual-grab/preview', { magnet: `magnet:?xt=urn:btih:${MAGNET_HASH}` });
    ok(r.status === 400, `seriesId required: ${r.body.error}`);
    r = await api('POST', '/api/manual-grab/preview', { seriesId: 99999, magnet: `magnet:?xt=urn:btih:${MAGNET_HASH}` });
    ok(r.status === 404, 'unknown series → 404');
    r = await api('POST', '/api/manual-grab/preview', { seriesId: sid, magnet: 'magnet:?dn=nohash' });
    ok(r.status === 400 && /info hash/.test(r.body.error), `magnet without a hash: ${r.body.error}`);
    r = await api('POST', '/api/manual-grab/preview', { seriesId: sid, torrentBase64: Buffer.from('garbage').toString('base64') });
    ok(r.status === 400 && /valid \.torrent/.test(r.body.error), `junk file: ${r.body.error}`);
    r = await api('POST', '/api/manual-grab/preview', { seriesId: sid });
    ok(r.status === 400, `no source: ${r.body.error}`);

    // ---- magnet preview (no file list) ----
    r = await api('POST', '/api/manual-grab/preview', { seriesId: sid, seasonNumber: 2, magnet: `magnet:?xt=urn:btih:${base32(MAGNET_HASH)}&dn=%5BGrp%5D%20Mob%20Psycho%20100%20II%20(1080p)` });
    ok(r.status === 200 && r.body.hasFileList === false && r.body.infoHash === MAGNET_HASH, 'magnet read (base32 hash converted)');
    ok(r.body.episodes.length === 13 && r.body.episodes.every((e) => e.seasonNumber === 2), 'season scope lists that season');
    ok(r.body.episodes.filter((e) => e.selected).length === 12, 'missing aired episodes preselected');
    ok(r.body.episodes.find((e) => e.label === 'S02E13').state === 'unaired', 'unaired episode not preselected');
    ok(r.body.warnings.some((w) => /file list/.test(w)), 'magnet warning shown');
    ok(r.body.quality && r.body.quality !== 'Unknown', `quality from the name: ${r.body.quality}`);

    // ---- uploaded .torrent preview from the Season 1 tab ----
    r = await api('POST', '/api/manual-grab/preview', { seriesId: sid, seasonNumber: 1, torrentBase64: b64(PACK) });
    ok(r.status === 200 && r.body.hasFileList && r.body.infoHash === PACK.hash, `pack read, hash ${r.body.infoHash}`);
    ok(r.body.title === '[Judas] Mob Psycho 100 (Seasons 1-2) [BD 1080p][Dual-Audio]', 'title is the torrent name');
    const f = (frag) => r.body.files.find((x) => x.path.includes(frag));
    ok(f('S01E02.mkv').episodeLabel === 'S01E02', 'explicit S01E02 matched');
    ok(f('- 13.mkv').episodeLabel === 'S02E01' && f('- 14.mkv').episodeLabel === 'S02E02', 'absolute 13/14 → S02E01/S02E02');
    ok(f('NCOP').episodeId == null && /Extra/.test(f('NCOP').reason), 'creditless OP left out');
    ok(f('sample').episodeId == null && f('info.nfo').episodeId == null, 'sample and .nfo left out');
    const e = (label) => r.body.episodes.find((x) => x.label === label);
    ok(e('S01E01').selected && e('S01E02').selected, 'matched missing episodes preselected');
    ok(e('S01E03').state === 'downloaded' && !e('S01E03').selected, 'already-downloaded episode shown but unchecked');
    ok(e('S01E05') && !e('S01E05').selected, "scope episodes with no file are listed, unchecked");
    ok(e('S02E01') && e('S02E01').selected && !e('S02E01').inScope, 'next-season files come along as a bonus');
    ok(!e('S02E05'), 'unmatched other-season episodes not listed');
    const token = r.body.token;

    // ---- grab ----
    r = await api('POST', '/api/manual-grab', { token, episodeIds: [ep(1, 1, other).id] });
    ok(r.status === 400 && /not part of this series/.test(r.body.error), 'episode from another series refused');
    r = await api('POST', '/api/manual-grab', { token, episodeIds: [] });
    ok(r.status === 400, 'no episodes refused');
    const chosen = [ep(1, 1).id, ep(1, 2).id, ep(2, 1).id, ep(2, 2).id];
    r = await api('POST', '/api/manual-grab', { token, episodeIds: chosen });
    ok(r.status === 201 && r.body.count === 4, `grabbed (${r.status} ${JSON.stringify(r.body).slice(0, 100)})`);
    ok(qbAdds.length === 1 && qbAdds[0].indexOf(PACK.buf) !== -1, 'the exact .torrent bytes were uploaded to qBittorrent');
    ok(qbAdds[0].includes(Buffer.from('kitsune')), 'sent with the client category');
    const rows = db.prepare('SELECT * FROM queue WHERE series_id = ? ORDER BY episode_id').all(sid);
    ok(rows.length === 4 && rows.every((q) => q.torrent_hash === PACK.hash && q.indexer === 'Manual'), 'queue rows tracked by the real hash, indexer "Manual"');
    const hintFor = (s, n) => rows.find((q) => q.episode_id === ep(s, n).id).file_hint;
    ok(hintFor(2, 1) === '[Judas] Mob Psycho 100 (Seasons 1-2) [BD 1080p][Dual-Audio]/Season 2/[Judas] Mob Psycho 100 - 13.mkv', 'S02E01 remembers its confirmed file');
    const hist = db.prepare("SELECT COUNT(*) AS n FROM history WHERE series_id = ? AND event_type = 'grabbed' AND indexer = 'Manual'").get(sid);
    ok(hist.n === 4, `history rows written (${hist.n})`);
    r = await api('POST', '/api/manual-grab', { token, episodeIds: chosen });
    ok(r.status === 400 && /expired/.test(r.body.error), 'a used preview cannot be grabbed twice');

    // ---- the same torrent again ----
    r = await api('POST', '/api/manual-grab/preview', { seriesId: sid, seasonNumber: 1, torrentBase64: b64(PACK) });
    ok(r.body.warnings.some((w) => /already in the queue/.test(w)), 'warns the torrent is already queued');
    ok(r.body.episodes.find((x) => x.label === 'S01E01').state === 'queued' && !r.body.episodes.find((x) => x.label === 'S01E01').selected, 'queued episodes unchecked');
    const t2 = r.body.token;
    r = await api('POST', '/api/manual-grab', { token: t2, episodeIds: [ep(1, 1).id] });
    ok(r.status === 409 && /S01E01/.test(r.body.error), `already-queued episode refused: ${r.body.error}`);

    // ---- links ----
    r = await api('POST', '/api/manual-grab/preview', { seriesId: sid, url: 'http://127.0.0.1:3997/files/pack.torrent' });
    ok(r.status === 200 && r.body.hasFileList && r.body.infoHash === PACK.hash, '.torrent link fetched and read');
    ok(r.body.episodes.some((x) => x.label === 'S01E04'), 'whole-series scope lists every season');
    r = await api('POST', '/api/manual-grab/preview', { seriesId: sid, url: 'http://127.0.0.1:3997/files/to-magnet' });
    ok(r.status === 200 && r.body.hasFileList === false && r.body.title === 'Redirected', 'link that redirects to a magnet works');
    r = await api('POST', '/api/manual-grab/preview', { seriesId: sid, url: 'http://127.0.0.1:3997/files/not-a-torrent' });
    ok(r.status === 400 && /didn't return a \.torrent/.test(r.body.error), `HTML page refused: ${r.body.error}`);
    r = await api('POST', '/api/manual-grab/preview', { seriesId: sid, url: `magnet:?xt=urn:btih:${MAGNET_HASH}` });
    ok(r.status === 200 && r.body.hasFileList === false, 'a magnet pasted in the link box works too');

    // ---- wrong show, blocklist ----
    r = await api('POST', '/api/manual-grab/preview', { seriesId: sid, seasonNumber: 1, torrentBase64: b64(OTHER_SHOW) });
    ok(r.body.warnings.some((w) => /matched an episode/.test(w)) && !r.body.episodes.some((x) => x.selected), 'nothing matched → warning, nothing checked');
    db.prepare("INSERT INTO blocklist (series_id, release_title, reason, created_at) VALUES (?, ?, 'failed', '2026-01-01')").run(sid, '[Group] Totally Different Show (01-02) [1080p]');
    r = await api('POST', '/api/manual-grab/preview', { seriesId: sid, seasonNumber: 1, torrentBase64: b64(OTHER_SHOW) });
    ok(r.body.warnings.some((w) => /blocklist/.test(w)), 'blocklisted release warned about');

    // ---- grab with a magnet ----
    r = await api('POST', '/api/manual-grab/preview', { seriesId: sid, seasonNumber: 2, magnet: `magnet:?xt=urn:btih:${MAGNET_HASH}&dn=Mob%20II` });
    r = await api('POST', '/api/manual-grab', { token: r.body.token, episodeIds: [ep(2, 3).id] });
    ok(r.status === 201 && qbAdds.length === 2 && qbAdds[1].includes(Buffer.from(`magnet:?xt=urn:btih:${MAGNET_HASH}`)), 'magnet sent to qBittorrent as a URL');
    const mrow = db.prepare('SELECT * FROM queue WHERE episode_id = ?').get(ep(2, 3).id);
    ok(mrow.torrent_hash === MAGNET_HASH && mrow.file_hint == null, 'magnet row tracked by hash, no file hint');

    // ---- the page still builds and is served ----
    const page = await fetch(`${BASE}/series.html`, { headers: { Cookie: cookie } });
    ok(page.status === 200, `series page served (${page.status})`);
  } catch (err) {
    failures++;
    console.log('ERROR', err.stack);
  } finally {
    server.kill();
    qb.close();
    host.close();
    fs.rmSync(WORK, { recursive: true, force: true });
    const errs = log.split('\n').filter((l) => / ERROR /.test(l));
    if (errs.length) { console.log('server errors:'); errs.forEach((l) => console.log('  ', l)); }
    console.log(failures ? `\n${failures} FAILURE(S)` : '\nALL PASSED');
    process.exit(failures ? 1 : 0);
  }
})();
