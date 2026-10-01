#!/bin/bash
# Brings the production checkout (~/Code/overwatch-prod) up to origin/main:
# fast-forward, install deps if the lockfile changed, blue-green client build,
# then restart the prod server (launchd com.overwatch.prod). Run by the
# pre-push hook via prod-after-push.sh; also safe to run by hand.
#
# The prod checkout is a pure mirror of origin/main: nobody edits it. If the
# build fails it is rolled back to the previous commit, so the running server,
# the served client and the checked-out code never disagree.
# Wrapped in { ...; exit; } so bash reads the whole script before git rewrites
# files (this script itself lives in the tree it updates).
{
PROD="$HOME/Code/overwatch-prod"
LOG="$PROD/scripts/prod-update.log"
LOCK="$HOME/Code/.overwatch-prod-update.lock"
log() { printf '%s  %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }

[ -d "$PROD/.git" ] || { echo "prod checkout missing: $PROD"; exit 1; }
if [ -d "$LOCK" ] && [ -z "$(find "$LOCK" -maxdepth 0 -newermt '-15 minutes' 2>/dev/null)" ]; then rm -rf "$LOCK"; fi
mkdir "$LOCK" 2>/dev/null || { log "SKIP: another prod update is running"; exit 0; }
trap 'rm -rf "$LOCK"' EXIT

export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
cd "$PROD" || exit 1
PREV=$(git rev-parse HEAD)
git fetch --quiet origin main || { log "ERROR: fetch failed"; exit 1; }
NEW=$(git rev-parse origin/main)
[ "$PREV" = "$NEW" ] && { log "already at ${NEW:0:7}; nothing to do"; exit 0; }
git merge --ff-only --quiet origin/main || { log "ERROR: not a fast-forward; prod left at ${PREV:0:7}"; exit 1; }
log "prod ${PREV:0:7} -> ${NEW:0:7}"

if ! git diff --quiet "$PREV" "$NEW" -- package-lock.json; then
  log "lockfile changed: npm ci"
  npm ci --silent >> "$LOG" 2>&1 || { log "ERROR: npm ci failed; rolling back"; git reset --hard --quiet "$PREV"; exit 1; }
fi

if ! "$PROD/scripts/build-client.sh"; then
  log "ERROR: client build failed; rolling back to ${PREV:0:7}, server not restarted"
  git reset --hard --quiet "$PREV"
  exit 1
fi
launchctl kickstart -k "gui/$(id -u)/com.overwatch.prod" >> "$LOG" 2>&1
log "prod now at ${NEW:0:7}; server restarted"
exit 0
}
