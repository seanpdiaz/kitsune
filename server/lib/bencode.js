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

module.exports = { computeInfoHash };
