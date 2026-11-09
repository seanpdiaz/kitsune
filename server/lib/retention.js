// ---------------------------------------------------------------------------
// Log level + retention for System > Logs and Activity > History.
//
// Three Settings > General options live here:
//   - Log Level (general-17): the lowest level that's kept at all. Applied
//     straight to the logger (see setMinLogLevel in server/logger.js), so
//     lower-level entries are neither stored nor printed.
//   - Log Retention (logRetentionDays): days of System > Logs rows to keep.
//   - History Retention (historyRetentionDays): days of Activity > History
//     rows to keep; 0 keeps history forever.
//
// Both tables used to be capped at their newest 500 rows, pruned on every
// insert. Pruning is now day-based and runs here instead: once at startup,
// every hour after that, and immediately whenever one of these settings is
// saved (routes/app-settings.js calls applyRetentionSettings after a save to
// the 'general' section), so shortening a retention takes effect right away
// instead of up to an hour later.
// ---------------------------------------------------------------------------
const db = require('../db');
const { logInfo, logWarn, setMinLogLevel, pruneLogs } = require('../logger');
const { pruneHistory } = require('../routes/history');

const DEFAULT_LOG_RETENTION_DAYS = 14;
const DEFAULT_HISTORY_RETENTION_DAYS = 90;
const MAX_LOG_RETENTION_DAYS = 365;
const MAX_HISTORY_RETENTION_DAYS = 3650;
const PRUNE_INTERVAL_MS = 60 * 60 * 1000;

let timer = null;
let lastApplied = null;

// Coerces a stored value (number, numeric string, null from a cleared
// NumberField) into a whole number of days within [min, max], falling back
// to `fallback` when it isn't a usable number at all.
function clampDays(value, { min, max, fallback }) {
  const n = Number(value);
  if (value === null || value === '' || !Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function resolveSettings(general = {}) {
  return {
    logLevel: general['general-17'],
    logRetentionDays: clampDays(general.logRetentionDays, {
      min: 1, max: MAX_LOG_RETENTION_DAYS, fallback: DEFAULT_LOG_RETENTION_DAYS,
    }),
    historyRetentionDays: clampDays(general.historyRetentionDays, {
      min: 0, max: MAX_HISTORY_RETENTION_DAYS, fallback: DEFAULT_HISTORY_RETENTION_DAYS,
    }),
  };
}

async function loadGeneralSettings() {
  const row = await db.prepare("SELECT data FROM app_settings WHERE section = 'general'").get();
  if (!row) return {};
  try {
    return JSON.parse(row.data) || {};
  } catch {
    return {};
  }
}

async function runPrune(settings) {
  const logsRemoved = await pruneLogs(settings.logRetentionDays);
  const historyRemoved = await pruneHistory(settings.historyRetentionDays);
  if (logsRemoved || historyRemoved) {
    logInfo('Housekeeping', `Removed ${logsRemoved} log entr${logsRemoved === 1 ? 'y' : 'ies'} and ${historyRemoved} history event${historyRemoved === 1 ? '' : 's'} past retention`);
  }
  return { logsRemoved, historyRemoved };
}

// Applies the given (or freshly loaded) 'general' settings: sets the log
// level and, if either retention changed since the last run (or `force`),
// prunes now. Never throws — a housekeeping failure shouldn't fail a
// settings save or server startup.
async function applyRetentionSettings(general, { force = false } = {}) {
  try {
    const settings = resolveSettings(general || (await loadGeneralSettings()));
    const previousLevel = lastApplied && lastApplied.level;
    const level = setMinLogLevel(settings.logLevel);
    if (previousLevel && previousLevel !== level) {
      logInfo('Housekeeping', `Log level set to ${level.charAt(0).toUpperCase() + level.slice(1)}`);
    }
    const retentionChanged = !lastApplied
      || lastApplied.logRetentionDays !== settings.logRetentionDays
      || lastApplied.historyRetentionDays !== settings.historyRetentionDays;
    lastApplied = { level, logRetentionDays: settings.logRetentionDays, historyRetentionDays: settings.historyRetentionDays };
    if (force || retentionChanged) await runPrune(settings);
    return lastApplied;
  } catch (err) {
    logWarn('Housekeeping', `Applying log/history retention failed: ${err && err.stack ? err.stack : err}`);
    return lastApplied;
  }
}

// Called once from server.js after the database is ready.
async function startRetentionScheduler() {
  await applyRetentionSettings(null, { force: true });
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    applyRetentionSettings(null, { force: true });
  }, PRUNE_INTERVAL_MS);
  if (timer.unref) timer.unref();
}

module.exports = {
  applyRetentionSettings,
  startRetentionScheduler,
  resolveSettings,
  DEFAULT_LOG_RETENTION_DAYS,
  DEFAULT_HISTORY_RETENTION_DAYS,
  MAX_LOG_RETENTION_DAYS,
  MAX_HISTORY_RETENTION_DAYS,
};
