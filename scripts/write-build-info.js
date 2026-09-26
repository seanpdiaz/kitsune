// ---------------------------------------------------------------------------
// Stamps build-info.json at the project root with exactly what "what commit
// is this" needs to answer later, at runtime, with zero git dependency (see
// server/lib/update-check.js) — the commit SHA, branch name, and when this
// stamp was written.
//
// Why this exists at all: Settings > General's Updates card needs to tell
// the user whether a newer commit exists on GitHub than what's actually
// running. The obvious way to answer "what commit is running" would be a
// live `git rev-parse HEAD` call at request time — except the actual
// deployed instance (see scripts/deploy.sh) has no .git directory at all;
// it's deliberately excluded from what gets rsynced over (see
// scripts/deploy-exclude.txt's own comment on why). A Docker image built
// from a release tarball may not have .git either. So instead, this script
// runs once, wherever .git *does* exist — a local dev machine, a CI runner,
// or (see scripts/deploy.sh) right before a deploy's rsync step — and
// writes a small JSON file that ships as an ordinary project file from then
// on, exactly like any other source file. Nothing at runtime ever needs to
// know what git is.
//
// Called from two places:
//   1. `npm run build` (see package.json) — covers local dev and any CI/
//      Docker build stage that has .git in its build context.
//   2. scripts/deploy.sh, directly, BEFORE its rsync step runs — the
//      standalone deploy target's own `npm run build` (run on the remote,
//      as part of the existing deploy instructions) will call this again,
//      but by then .git is long gone; see the no-op path below for why
//      that's fine rather than a problem.
//
// Safe to run in either situation:
//   - .git present and `git` on PATH: writes a fresh, accurate stamp.
//   - Neither: leaves whatever build-info.json is already on disk alone
//     (already correct, synced over from wherever it *was* generated) —
//     except on a completely fresh checkout with no build-info.json at all
//     (e.g. someone clones the repo and runs `npm run build` without ever
//     having deployed), where there's nothing to leave alone, so it writes
//     an "unknown build" placeholder instead of leaving update-check.js to
//     find a missing file. Either way, this never fails the build it's
//     part of — a build-time stamping problem shouldn't block `npm run
//     build`/`npm start` from working.
// ---------------------------------------------------------------------------
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJECT_ROOT = path.join(__dirname, '..');
const OUTPUT_PATH = path.join(PROJECT_ROOT, 'build-info.json');

function tryGit(args) {
  try {
    return execFileSync('git', args, { cwd: PROJECT_ROOT, stdio: ['ignore', 'pipe', 'ignore'] })
      .toString('utf8')
      .trim();
  } catch {
    return null;
  }
}

function writeUnknownStampIfMissing() {
  if (fs.existsSync(OUTPUT_PATH)) {
    console.log('[write-build-info] No git repo here — leaving the existing build-info.json in place.');
    return;
  }
  const placeholder = { commit: null, branch: null, builtAt: new Date().toISOString() };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(placeholder, null, 2) + '\n');
  console.log('[write-build-info] No git repo here and no existing build-info.json — wrote an "unknown build" placeholder.');
}

function main() {
  const commit = tryGit(['rev-parse', 'HEAD']);
  const branch = tryGit(['rev-parse', '--abbrev-ref', 'HEAD']);

  if (!commit || !branch || branch === 'HEAD') {
    // `branch === 'HEAD'` covers a detached HEAD checkout (e.g. CI checking
    // out a specific SHA rather than a branch tip) — not a real branch name
    // to compare against on GitHub, so this is treated the same as "no git"
    // for stamping purposes rather than writing a misleading "HEAD" value.
    writeUnknownStampIfMissing();
    return;
  }

  const stamp = { commit, branch, builtAt: new Date().toISOString() };
  fs.writeFileSync(OUTPUT_PATH, JSON.stringify(stamp, null, 2) + '\n');
  console.log(`[write-build-info] Stamped build-info.json — ${branch}@${commit.slice(0, 7)}`);
}

main();
