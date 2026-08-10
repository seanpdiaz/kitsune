// Shared byte-size formatting for anything showing a real download size —
// the release picker, Activity > Queue, and Activity > History all display
// the same `sizeBytes` values the grab pipeline stores (see
// server/lib/queue-sim.js), so one formatter instead of three near-copies.
function formatBytes(bytes) {
  if (!bytes && bytes !== 0) return '—';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(0)} MB`;
}

export { formatBytes };
