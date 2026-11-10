// ---------------------------------------------------------------------------
// The update protocol constants (paths of pending.json, journal.json, the
// staging/rollback directories, exit code 75, health-check timeouts, ...)
// shared by server/lib/updater.js and launcher.js.
//
// They're defined in launcher.js itself, which deliberately requires nothing
// from the rest of the install so it still runs when a crash mid-update left
// that install half-swapped. See the protocol comment there.
// ---------------------------------------------------------------------------
module.exports = require('../../launcher.js').protocol;
