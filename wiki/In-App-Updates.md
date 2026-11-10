# In-App Updates

System > Updates can install any branch tip (main, development, ...) or any GitHub release,
back up the database first, and roll the whole thing back on its own if the new version
doesn't start. This is Phase 2 of the Updates feature; Phase 1 (the scheduled "is there
something newer" check and the What's Changed list) is unchanged.

## Using it

**System > Updates > Install a Version.** Choose **Branch** or **Release**, pick one, and
Kitsune shows how it relates to what's running:

| Label | Meaning |
|---|---|
| Upgrade | The target has everything this build has, plus newer commits. Installs after one confirmation. |
| Downgrade | The target is older (an ancestor of this build). |
| Branch switch | Each side has commits the other lacks, e.g. development → main before a merge. |
| Unknown | This install has no `build-info.json`, so there's nothing to compare against. |

Anything other than an upgrade needs an extra "I understand" tick: older code may not
understand changes a newer version made to the database.

After a successful branch install, Settings > General > Updates > Branch switches to that
branch, so the scheduled check keeps comparing against what you're actually running.

Only admins can install. Draft releases are hidden; pre-releases are labeled.

## What happens when you click Install

The running version does all the slow, failure-prone work first, while it keeps serving
requests. A failure at any of these steps changes nothing.

1. **Find the version.** Ask GitHub which commit the branch/tag points at.
2. **Download.** Fetch that commit's source tarball into `data/updates/downloads/`.
3. **Unpack** into `data/updates/staging/<sha>/`. A version without `launcher.js` (anything
   from before this feature) is refused here: it would have no way to update or roll back
   afterwards.
4. **Install dependencies.** `npm ci` (dev dependencies included, since the build needs Vite).
5. **Build** the frontend (`npm run build`), then `npm prune --omit=dev`.
6. **Check** the new `server.js` and `launcher.js` with `node --check`, and that
   `public/dist/` exists.
7. **Back up the database.** Same code as Backup Now, saved as
   `kitsune_backup_pre-update_<time>.db.gz` in System > Backup.
8. **Restart.** Write `data/updates/pending.json`, close the HTTP server and the database,
   and exit with code 75.

`launcher.js` takes over:

- Moves the current version's files to `data/updates/rollback/<time>_<sha>/` and the staged
  files into place. `data/`, `.env*` and `.git` are never touched.
- Starts the new version **on probation**. It has 3 minutes to open its database and start
  listening (it then writes `data/updates/healthy.json`), and must then stay up for
  another 10 seconds.
- **Healthy:** records success, keeps the previous version under `rollback/` (one is kept),
  and carries on.
- **Not healthy** (crashed, never finished starting, or died during the 10 seconds): stops
  it, moves the previous version's files back, **restores the SQLite database from the
  pre-update backup**, keeps the failed files and the database it left behind under
  `data/updates/failed/` (two kept), and starts the previous version again.

The page follows the whole thing, including the restart. It reloads once the new version is
up, or shows what was rolled back and why.

### Postgres

With `DB_CLIENT=postgres` the pre-update backup is still taken (a `pg_dump`), but a rollback
does **not** restore it automatically. Restoring means dropping and recreating a schema on a
server Kitsune doesn't own, which shouldn't happen unattended. Migrations only ever add
tables and columns, so the previous version normally runs fine against the newer schema.
The rollback message says the database was left as it was.

## Crash safety

Every step of the swap is recorded in `data/updates/journal.json` before it happens. If the
launcher itself dies partway through (power cut, OOM kill, the service stopped
mid-update), the next start finds the journal and puts the previous version back before
running anything. It restores the database too if the new version had already run.

`launcher.js` makes that possible because it never depends on the rest of the install:

- It requires nothing from `server/`; the protocol constants live in it, and
  `server/lib/update-protocol.js` re-exports them.
- It never leaves the install directory. The swap copies it aside for rollback and replaces
  it with a single atomic rename, so `node launcher.js` always has something to run.

A running launcher keeps its own code in memory, so an update that rewrites `launcher.js`
can't change the rules under it. `pending.json` and `journal.json` carry a `protocol`
number for that reason.

## Running it

In-app updates need the launcher: `npm start` (or `node launcher.js`). Started with
`node server.js`, Kitsune runs normally but the Install button explains it can't apply
updates.

As a service, use [`scripts/kitsune.service`](../scripts/kitsune.service) (systemd). It
runs `launcher.js` with `Restart=on-failure`. During an update the launcher restarts the
server itself, so systemd only steps in if the whole thing crashes. The service user must
own the install directory.

The launcher forwards SIGTERM/SIGINT/SIGHUP to the server and exits with the server's exit
code, so a supervisor sees crashes exactly as before. One edge case: stopping the service
during the new version's probation leaves the journal in place, so the next start rolls
back. That's deliberate; an unconfirmed update is treated as failed.

### Git checkouts

Installing from the page replaces the files of a git checkout too (`.git` is left alone),
so `git status` shows changes afterwards. The page notes this. If you manage an install
with `git pull`, keep doing that.

### Docker

Docker installs can't update themselves from inside the container: the next container
recreate would bring the old image back. The card shows which image tag to pull instead
(`KITSUNE_DOCKER_IMAGE`, default `ghcr.io/seanpdiaz/kitsune`). Detection comes from
`server/lib/deployment-mode.js` (`KITSUNE_UPDATE_METHOD`, then `/.dockerenv`).

## Settings

All optional, in `.env` (see `.env.example`):

| Variable | Default | |
|---|---|---|
| `GITHUB_TOKEN` | — | Read-only token; needed for a private repo, raises the 60/hour API limit |
| `KITSUNE_GITHUB_REPO` | from `package.json` | Install from a fork (`owner/repo`) |
| `KITSUNE_GITHUB_API_BASE` | `https://api.github.com` | GitHub Enterprise; also what the tests point at a mock |
| `KITSUNE_DISABLE_UPDATES` | off | Hide installing; checks keep working |
| `KITSUNE_UPDATE_HEALTH_TIMEOUT_MS` | 180000 | Time the new version gets to start |
| `KITSUNE_UPDATE_HEALTH_SETTLE_MS` | 10000 | Time it must then stay up |
| `KITSUNE_UPDATE_STEP_TIMEOUT_MS` | 900000 | Per-command limit for `npm ci`, the build, etc. |
| `KITSUNE_DOCKER_IMAGE` | `ghcr.io/seanpdiaz/kitsune` | Image named in the Docker instructions |

## API

| | |
|---|---|
| `GET /api/system-updates` | Now also returns `install`: support, phases, progress, log, `lastResult` |
| `GET /api/system-updates/targets[?refresh=1]` | Branches and releases (cached 5 min) |
| `GET /api/system-updates/preview?type=branch\|release&ref=` | Target commit + upgrade/downgrade/switch, with commits |
| `POST /api/system-updates/install` `{type, ref, confirm}` | Admin only. 202 started, or 409 `{needsConfirm}` for a non-upgrade without `confirm: true` |

## Backups got more reliable along the way

Backup Now used to read `kitsune.db` directly. In WAL mode that misses recent writes still
sitting in `kitsune.db-wal`. It now uses `VACUUM INTO`, which writes a complete,
consistent copy. That matters most for the pre-update backup a rollback restores.

## Files

`launcher.js` (new), `server/lib/updater.js` (new), `server/lib/update-protocol.js` (new),
`server/routes/system-updates.js`, `server/lib/update-check.js` (helpers exported, `tag` in
build info, API base override), `server/routes/backups.js` (`createBackup`, VACUUM INTO),
`server/routes/auth.js` (exports `requireAuth`), `server.js` (shutdown hook, healthy report),
`frontend/pages/system-updates/InstallVersion.jsx` (new), `UpdatesInfo.jsx`,
`public/styles.css`, `package.json` (`start` → launcher), `scripts/kitsune.service` (new),
`scripts/test-updater.js` (new).

## Verified

`node scripts/test-updater.js` (19 checks, all passing):

- **Launcher, against fake servers:** a successful swap (`.env`/`data/` kept, symlinks kept,
  previous version kept); rollback on crash-at-start (database restored, failed files kept),
  on never becoming healthy, and on dying during the settle window; refusal of a
  wrong-protocol or path-escaping `pending.json`; recovery after the launcher was killed in
  each swap phase; exit-code pass-through; SIGTERM forwarding.
- **End to end, the real app** started through the launcher against a local mock of the
  GitHub API serving tarballs of this tree:
  - Installs a good version for real: download through a redirect, `npm ci`, Vite build,
    prune, pre-update backup, exit 75, swap, health check. Data carries over and the update
    branch follows.
  - A downgrade is refused until confirmed.
  - A version that alters the database and then crashes on startup is rolled back, and the
    database is restored: the version's table is gone and data written just before the
    update is there.
  - A version without `launcher.js` is refused with nothing changed.
  - Unauthenticated installs get 401; a second concurrent install gets 409.

The page was checked in headless Chrome: upgrade, downgrade with confirm, release picker,
failed download, rolled-back banner, and Docker instructions.

**Not verified:** against the real GitHub API (no branch has `launcher.js` until this is
merged, and this sandbox's GitHub token was rejected), under a real systemd unit, or with
`DB_CLIENT=postgres`.
