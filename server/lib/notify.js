// ---------------------------------------------------------------------------
// Real notification dispatch for Settings > Connect — the other half of
// server/lib/pushover.js (the actual API client) and routes/connect.js (the
// Test button). This is what fires on the app's own real events: a grab, an
// import, or a failed download (see server/routes/queue.js's POST /api/queue
// and completeDownload — the exact three points real Sonarr's own Connect
// notifications fire on too).
//
// Only Pushover-type Connect items are dispatched to — every other type
// (Slack, Plex, Gotify) is still decorative (see
// frontend/components/ConnectionManager.jsx), so this intentionally has
// nothing to send them. Silently skips anything
// disabled, any non-Pushover item, and any Pushover item whose Triggers
// don't include the event that just happened — same "opt in per event
// type" shape Sonarr's own Connect page has.
// ---------------------------------------------------------------------------
const db = require('../db');
const { logInfo, logWarn } = require('../logger');
const { sendPushoverNotification } = require('./pushover');

// event: 'grab' | 'import' | 'fail' — matches the notifyOnGrab/
// notifyOnImport/notifyOnFail keys the Connect edit modal actually saves
// (see PUSHOVER_TRIGGER_LABELS in frontend/components/ConnectionManager.jsx).
const TRIGGER_KEY_BY_EVENT = { grab: 'notifyOnGrab', import: 'notifyOnImport', fail: 'notifyOnFail' };
const TITLE_BY_EVENT = { grab: 'Kitsune — Grabbed', import: 'Kitsune — Imported', fail: 'Kitsune — Download Failed' };

// Fire-and-forget: called from queue.js right after a grab/import/failure
// is already persisted and its own response has gone out — a slow or
// unreachable Pushover shouldn't hold up the grab/tick that triggered it,
// the same reasoning warmEpisodesInBackground (server/routes/episodes.js)
// already uses for its own background TVDB fetch.
async function notifyConnections(event, message) {
  const triggerKey = TRIGGER_KEY_BY_EVENT[event];
  if (!triggerKey) return; // programmer error (unknown event) — nothing to send, nothing to crash

  let rows;
  try {
    rows = await db.prepare("SELECT * FROM settings_items WHERE section = 'connect'").all();
  } catch (err) {
    logWarn('ConnectService', `Could not read Connect items to notify: ${err.message}`);
    return;
  }

  for (const row of rows) {
    let item;
    try {
      item = JSON.parse(row.data);
    } catch {
      continue; // malformed row — skip rather than fail every other item too
    }
    if (item.type !== 'pushover' || !item.enabled || !item[triggerKey]) continue;
    if (!item.userKey || !item.apiToken) continue; // nothing to send to yet — not an error, just unconfigured

    sendPushoverNotification({
      apiToken: item.apiToken,
      userKey: item.userKey,
      title: TITLE_BY_EVENT[event],
      message,
      priority: item.priority,
    }).then((result) => {
      if (result.ok) {
        logInfo('ConnectService', `Sent "${event}" notification to "${item.name}" (pushover): ${message}`);
      } else {
        logWarn('ConnectService', `Failed to send "${event}" notification to "${item.name}" (pushover): ${result.error}`);
      }
    }).catch((err) => {
      // sendPushoverNotification already catches its own errors and
      // resolves with { ok: false }, so this is just a safety net for
      // anything unexpected slipping through, same as
      // warmEpisodesInBackground's own catch.
      logWarn('ConnectService', `Unexpected error sending "${event}" notification to "${item.name}": ${err.message}`);
    });
  }
}

module.exports = { notifyConnections };
