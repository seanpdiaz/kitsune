// Shared byte-size formatting for anything showing a real download size —
// the release picker, Activity > Queue, and Activity > History all display
// the same `sizeBytes` values the grab pipeline stores (see
// server/lib/queue-sim.js), so one formatter instead of three near-copies.
//
// Anything under 1 MB used to fall through to the MB branch and round to
// "0 MB" — fine for episode files, wrong for Settings > Security's
// certificate/key uploads (a few KB) and sub-MB/s download speeds. Sizes of
// 1 MB and up format exactly as before.
function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '—';
  const kb = 1024;
  const mb = kb * 1024;
  const gb = mb * 1024;
  if (bytes >= gb) return `${(bytes / gb).toFixed(2)} GB`;
  if (bytes >= mb) return `${(bytes / mb).toFixed(0)} MB`;
  if (bytes >= kb) return `${(bytes / kb).toFixed(1)} KB`;
  return `${bytes} B`;
}

export { formatBytes };
