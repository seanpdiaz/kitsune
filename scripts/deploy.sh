#!/usr/bin/env bash
# Syncs this project to a remote server with rsync. Run via `npm run deploy`
# (see package.json) rather than calling this directly, so it always runs
# from the project root regardless of your current directory.
#
# ---- One-time setup ----
# Create a file named `.env.deploy` in the project root (already gitignored
# — see .gitignore) with one line:
#
#   DEPLOY_TARGET=user@host:/path/to/kitsune
   DEPLOY_TARGET=sdiaz@10.1.24.5:/opt/kitsune
#
# (SSH key auth to that host needs to already work on its own — this script
# doesn't handle passwords/keys, it just calls rsync over ssh.) You can
# instead export DEPLOY_TARGET in your shell if you'd rather not use a file;
# .env.deploy just wins if both are set.
#
# ---- What gets synced ----
# Everything except what's listed in scripts/deploy-exclude.txt — by default
# that's node_modules/, .git/, the local SQLite DB + WAL files under data/,
# .env (real API keys), the built public/dist/ bundle, and a couple of OS/
# junk files. That means after a deploy you still need to, on the remote
# host: `npm install`, put a real .env there, and run `npm run build`
# (or `npm start` after a build) — this script only gets the source there,
# deliberately not your local secrets/live data/platform-specific
# node_modules. Edit scripts/deploy-exclude.txt if you want different
# behavior (e.g. remove the "data/" line to also sync the live DB).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$PROJECT_ROOT"

if [ -f .env.deploy ]; then
  # Only pulls DEPLOY_TARGET out of .env.deploy rather than sourcing the
  # whole file, so a stray line in there can't execute arbitrary shell.
  DEPLOY_TARGET="$(grep -m1 '^DEPLOY_TARGET=' .env.deploy | cut -d= -f2-)"
fi

if [ -z "${DEPLOY_TARGET:-}" ]; then
  echo "Error: DEPLOY_TARGET is not set." >&2
  echo "Create .env.deploy in the project root with a line like:" >&2
  echo "  DEPLOY_TARGET=user@host:/path/to/kitsune" >&2
  echo "or export DEPLOY_TARGET=user@host:/path/to/kitsune in your shell." >&2
  exit 1
fi

# Stamps build-info.json with this exact commit/branch before syncing —
# see scripts/write-build-info.js's own header comment for the full
# reasoning. This has to happen here, locally, rather than relying on the
# remote's own `npm install && npm run build` (see the instructions this
# script's header comment already gives for that) to do it: the remote
# target has no .git directory at all (deliberately excluded — see
# deploy-exclude.txt), so write-build-info.js can't generate a real stamp
# there. Running it here, where .git actually exists, means build-info.json
# ships as an ordinary synced file (deploy-exclude.txt does NOT list it —
# unlike public/dist/, this one file needs to actually reach the remote)
# and the remote's later `npm run build` finds it already correct and
# leaves it alone (see write-build-info.js's own no-op-without-.git path).
echo "Stamping build-info.json..."
node "$SCRIPT_DIR/write-build-info.js"

echo "Deploying to $DEPLOY_TARGET ..."
rsync -avz --delete \
  --exclude-from="$SCRIPT_DIR/deploy-exclude.txt" \
  "$PROJECT_ROOT"/ "$DEPLOY_TARGET"/

echo "Done."
