// ---------------------------------------------------------------------------
// "Is this instance running in Docker or as a standalone Node process?" —
// the one piece of information the Updates feature needs in order to never
// offer an action that wouldn't make sense for how this instance is
// actually running. A Docker container can't meaningfully replace its own
// files and restart itself from inside app code the way a standalone
// install eventually will (see the README/plan discussion this came out
// of) — the correct "update" action for a container is always "pull the
// new image tag and recreate the container" from *outside* it, something
// this app has no way to do to itself regardless of deployment mode. Phase
// 1 is read-only (no apply-update action exists yet either way), but this
// signal is what a later phase will gate that action on, so it's worth
// getting right now rather than retrofitting later.
//
// Detection, in priority order:
//   1. KITSUNE_UPDATE_METHOD env var, if set — an explicit override,
//      mirroring the real convention linuxserver.io images already use
//      (their UPDATE_METHOD) for exactly this purpose. Sean's own future
//      Docker packaging can set this in the image itself so there's never
//      any ambiguity for that path; not on PATH/set for the plain
//      `npm start` case is fine — falls through to #2.
//   2. /.dockerenv existence — Docker has created this empty file inside
//      every container since Docker 0.9; not a formal guarantee (an
//      unusual container setup could remove it, and Podman/other runtimes
//      vary), but a well-established, zero-config heuristic that needs no
//      cooperation from whatever base image gets used later.
//   3. Falls back to 'standalone' — the safe default: if this can't
//      positively confirm it's in a container, the read-only Phase 1
//      behavior here is identical either way, and a later phase should
//      never assume it's safe to act like a container without real
//      evidence.
// ---------------------------------------------------------------------------
const fs = require('fs');

const KNOWN_MODES = ['docker', 'standalone'];

function getDeploymentMode() {
  const envValue = (process.env.KITSUNE_UPDATE_METHOD || '').trim().toLowerCase();
  if (KNOWN_MODES.includes(envValue)) return envValue;

  try {
    if (fs.existsSync('/.dockerenv')) return 'docker';
  } catch {
    // ignore — falls through to the standalone default below
  }

  return 'standalone';
}

module.exports = { getDeploymentMode };
