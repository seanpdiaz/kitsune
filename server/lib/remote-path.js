// ---------------------------------------------------------------------------
// Remote Path Mapping — the same concept Sonarr/Radarr expose under
// Settings > Download Clients (see their own wiki: "Completed Download
// Handling only works properly if the download client and Sonarr are on the
// same machine since it gets the path to be imported directly from the
// download client, otherwise a remote map is needed"). A download client
// only ever reports where IT thinks a file lives — that path is meaningless
// to Kitsune unless Kitsune's own host can reach the same bytes at that
// exact location, which is only guaranteed when they're literally the same
// machine. Everywhere else (a seedbox, a separate Docker container, a NAS
// running qBittorrent while Kitsune runs elsewhere), the two sides see
// different filesystems entirely, and the only way to reconcile that is a
// translation the user supplies by hand — neither side can infer the
// other's layout.
//
// Kitsune keeps this to a single {remote, local} pair per download client
// (`remotePathMappingRemote/Local` on that client's settings_items row) —
// real Sonarr/Radarr support a full list of mappings (useful when one
// client's downloads are genuinely split across multiple distinct mount
// points), which is more than this app's one-real-client-at-a-time scope
// needs. No mapping configured means "assume the same filesystem" — exactly
// the default both real apps use when a user's setup genuinely doesn't need
// one (Kitsune and the download client on the same host or sharing a mount).
// ---------------------------------------------------------------------------

// Deliberately a plain string-prefix swap, not anything path-module-based —
// the remote side's path came from the download client's own OS and may not
// share Kitsune host's separator convention at all (a Windows qBittorrent
// instance reporting `C:\Downloads\...` while Kitsune itself runs on Linux,
// for instance). Real Sonarr/Radarr don't attempt automatic separator
// translation either: the user is expected to type the Local Path in their
// own host's syntax and the Remote Path in the client's, and mapping is
// nothing more than "does this string start with the Remote Path I was
// given — if so, swap that prefix for the Local Path I was given."
function resolveLocalPath(client, remotePath) {
  if (!remotePath) return remotePath;
  const from = (client && client.remotePathMappingRemote || '').trim();
  const to = (client && client.remotePathMappingLocal || '').trim();
  if (!from || !to) return remotePath; // no mapping configured — same-filesystem assumption
  if (!remotePath.startsWith(from)) return remotePath; // this mapping doesn't apply to this path — best effort, leave as-is
  return to.replace(/[/\\]+$/, '') + remotePath.slice(from.length);
}

// Joins a torrent's own save_path (as reported by the download client, in
// ITS host's separator convention — not necessarily Kitsune's own) with a
// file's relative name from GET /torrents/files, without assuming which
// separator that remote side actually uses. Node's own `path.join` isn't
// safe here for the same reason resolveLocalPath doesn't use it: it always
// applies the LOCAL host's separator rules to both arguments, which silently
// mangles a remote Windows-style path when Kitsune itself runs on Linux (or
// vice versa).
function joinRemotePath(dir, name) {
  if (!dir) return name;
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return dir.replace(/[/\\]+$/, '') + sep + name;
}

module.exports = { resolveLocalPath, joinRemotePath };
