// ---------------------------------------------------------------------------
// Minimal bencode reader — just enough to find a raw .torrent file's
// BitTorrent info hash (the same 40-char hex string qBittorrent identifies a
// torrent by in /api/v2/torrents/info) without a bencode parsing library
// (this backend has none — see README). Needed for server/routes/queue.js's
// real-grab path: when a release only has an http(s) download URL rather
// than a ready-made magnet: link (see server/lib/prowlarr-search.js's
// magnetUrl-or-downloadUrl fallback — some indexers proxied through Prowlarr
// only expose a "fetch the .torrent file" link, not a magnet with the hash
// already embedded), Kitsune fetches the raw .torrent bytes itself (see
// queue.js's fetchTorrentFile) and uploads the actual file to qBittorrent
// instead of handing qBittorrent a URL to fetch on its own — which sidesteps
// a real bug this was built to fix: qBittorrent fetching that URL happens
// asynchronously on ITS OWN host, which isn't guaranteed to have network
// access to wherever the indexer lives even when Kitsune does (confirmed:
// Kitsune's search already proved it can reach a user's Prowlarr instance,
// but their qBittorrent client submitting the same download URL back to
// itself never actually produced a torrent — see wiki's Real-Search-and-
// -Grabs page). Uploading the file directly means qBittorrent never needs to
// reach the indexer at all. Once Kitsune holds the raw bytes, it still needs
// to know the resulting torrent's hash to poll qBittorrent for progress —
// this is what computeInfoHash is for.
//
// The info hash is defined by the BitTorrent spec as SHA-1 of the *exact raw
// bencoded bytes* of the top-level dict's "info" value — not a re-encoding of
// a parsed object (dict key order / integer formatting could subtly differ
// from the original bytes even for an equivalent-content re-encode, which
// would silently produce the wrong hash). This only ever tracks byte offsets
// while walking the structure for that reason, never reconstructing values —
// verified directly against a hand-built bencoded fixture exercising every
// value type (string/int/list/nested dict) before being wired in here.
// ---------------------------------------------------------------------------
const crypto = require('crypto');

function readBencodeString(buf, cursor) {
  const colon = buf.indexOf(0x3a, cursor.pos); // ':'
  if (colon === -1) throw new Error('Malformed bencode string (no colon)');
  const len = parseInt(buf.toString('ascii', cursor.pos, colon), 10);
  if (!Number.isFinite(len) || len < 0) throw new Error('Malformed bencode string length');
  const start = colon + 1;
  const end = start + len;
  if (end > buf.length) throw new Error('Malformed bencode string (truncated)');
  cursor.pos = end;
  return buf.slice(start, end);
}

// Advances cursor past one complete bencoded value of any type, without
// building a result — all this ever needs is correct byte-offset skipping.
function skipBencodeValue(buf, cursor) {
  const b = buf[cursor.pos];
  if (b === 0x69) { // 'i' — integer: i<digits>e
    const end = buf.indexOf(0x65, cursor.pos); // 'e'
    if (end === -1) throw new Error('Malformed bencode integer');
    cursor.pos = end + 1;
  } else if (b === 0x6c) { // 'l' — list: l<values>e
    cursor.pos += 1;
    while (buf[cursor.pos] !== 0x65) skipBencodeValue(buf, cursor);
    cursor.pos += 1;
  } else if (b === 0x64) { // 'd' — dict: d<key><value>...e
    cursor.pos += 1;
    while (buf[cursor.pos] !== 0x65) {
      readBencodeString(buf, cursor); // key
      skipBencodeValue(buf, cursor); // value
    }
    cursor.pos += 1;
  } else if (b >= 0x30 && b <= 0x39) { // digit — string: <len>:<bytes>
    readBencodeString(buf, cursor);
  } else {
    throw new Error(`Malformed bencode value at offset ${cursor.pos}`);
  }
}

// Returns the lowercase hex SHA-1 info hash of a raw .torrent file's bytes —
// the same identifier qBittorrent's own /api/v2/torrents/info reports as
// `hash` for a torrent added from this exact file.
function computeInfoHash(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('computeInfoHash expects a Buffer');
  const cursor = { pos: 0 };
  if (buf[cursor.pos] !== 0x64) throw new Error('Not a valid .torrent file (expected a top-level bencoded dict)');
  cursor.pos += 1;
  while (buf[cursor.pos] !== 0x65) {
    const key = readBencodeString(buf, cursor).toString('latin1');
    const valueStart = cursor.pos;
    skipBencodeValue(buf, cursor);
    if (key === 'info') {
      const infoBytes = buf.slice(valueStart, cursor.pos);
      return crypto.createHash('sha1').update(infoBytes).digest('hex');
    }
  }
  throw new Error('No "info" key found in .torrent file — cannot compute info hash');
}

// Full decoder — builds real values (strings stay Buffers, since torrent
// paths aren't guaranteed to be valid UTF-8; callers decode what they need).
// Added for torrent-files.js, which needs a .torrent's file list to tell an
// unlabeled season pack ("[neoHEVC] Special A Class S.A. [DVD 480p ...]" —
// no range, no "Batch", no season tag, but 24 episodes inside) apart from a
// single-episode release whose title happens to look the same.
function decodeBencodeValue(buf, cursor) {
  const b = buf[cursor.pos];
  if (b === 0x69) { // 'i'
    const end = buf.indexOf(0x65, cursor.pos);
    if (end === -1) throw new Error('Malformed bencode integer');
    const n = Number(buf.toString('ascii', cursor.pos + 1, end));
    cursor.pos = end + 1;
    return n;
  }
  if (b === 0x6c) { // 'l'
    cursor.pos += 1;
    const list = [];
    while (buf[cursor.pos] !== 0x65) {
      if (cursor.pos >= buf.length) throw new Error('Malformed bencode list (truncated)');
      list.push(decodeBencodeValue(buf, cursor));
    }
    cursor.pos += 1;
    return list;
  }
  if (b === 0x64) { // 'd'
    cursor.pos += 1;
    const dict = {};
    while (buf[cursor.pos] !== 0x65) {
      if (cursor.pos >= buf.length) throw new Error('Malformed bencode dict (truncated)');
      const key = readBencodeString(buf, cursor).toString('latin1');
      dict[key] = decodeBencodeValue(buf, cursor);
    }
    cursor.pos += 1;
    return dict;
  }
  if (b >= 0x30 && b <= 0x39) return readBencodeString(buf, cursor);
  throw new Error(`Malformed bencode value at offset ${cursor.pos}`);
}

// Every file a .torrent contains, as { path, length } — a single-file
// torrent (no info.files) reports its one file under info.name. Paths are
// decoded as UTF-8 (path.utf-8 preferred when the torrent supplies it).
function listTorrentFiles(buf) {
  if (!Buffer.isBuffer(buf)) throw new Error('listTorrentFiles expects a Buffer');
  const root = decodeBencodeValue(buf, { pos: 0 });
  const info = root && root.info;
  if (!info || typeof info !== 'object') throw new Error('No "info" dict in .torrent file');
  const name = Buffer.isBuffer(info['name.utf-8']) ? info['name.utf-8'] : info.name;
  const nameStr = Buffer.isBuffer(name) ? name.toString('utf8') : '';
  if (!Array.isArray(info.files)) {
    return [{ path: nameStr, length: typeof info.length === 'number' ? info.length : 0 }];
  }
  return info.files.map((f) => {
    const parts = Array.isArray(f['path.utf-8']) ? f['path.utf-8'] : (Array.isArray(f.path) ? f.path : []);
    return {
      path: [nameStr, ...parts.map((p) => (Buffer.isBuffer(p) ? p.toString('utf8') : String(p)))].filter(Boolean).join('/'),
      length: typeof f.length === 'number' ? f.length : 0,
    };
  });
}

module.exports = { computeInfoHash, listTorrentFiles };
