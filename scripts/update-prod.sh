#!/bin/bash
# Brings the production checkout (~/Code/overwatch-prod) up to origin/main:
# fast-forward, install deps if the lockfile changed, blue-green client build,
# then restart the prod server (launchd com.overwatch.prod). Run by the
# pre-push hook via prod-after-push.sh; also safe to run by hand.
#
# Modes:
#   (no flag)      follow origin/main (the push path, unchanged).
#   --from local <sha>
#                  deploy exactly <sha>, which must be the tip of the local main
#                  of ~/Code/overwatch, with no push to GitHub. If main has moved
#                  past <sha>, the script refuses and prod stays. The repo is read
#                  by path; no remote is added to the prod checkout.
# A later push of commits that prod already runs is a no-op ("already contains"),
# never an error and never a step back.
#
# Test overrides (env): OVERWATCH_PROD_DIR, OVERWATCH_LOCAL_REPO,
# OVERWATCH_PROD_LOCK, OVERWATCH_RESTART_CMD. The script reads them only when
# OVERWATCH_TEST=1. Otherwise it uses the fixed paths and ignores them (CISO S2).
#
# The prod checkout is a pure mirror of origin/main: nobody edits it. If the
# build fails it is rolled back to the previous commit, so the running server,
# the served client and the checked-out code never disagree.
# Wrapped in { ...; exit; } so bash reads the whole script before git rewrites
# files (this script itself lives in the tree it updates).
{
PROD="$HOME/Code/overwatch-prod"
LOCAL_REPO="$HOME/Code/overwatch"
LOCK="$HOME/Code/.overwatch-prod-update.lock"
RESTART_CMD=""
if [ "${OVERWATCH_TEST:-}" = "1" ]; then
  PROD="${OVERWATCH_PROD_DIR:-$PROD}"
  LOCAL_REPO="${OVERWATCH_LOCAL_REPO:-$LOCAL_REPO}"
  LOCK="${OVERWATCH_PROD_LOCK:-$LOCK}"
  RESTART_CMD="${OVERWATCH_RESTART_CMD:-}"
fi
LOG="$PROD/scripts/prod-update.log"
FROM=origin
WANT=""
USAGE="usage: update-prod.sh [--from local <sha>]"
case "${1:-}" in
  "") ;;
  --from)
    [ "${2:-}" = "local" ] || { echo "$USAGE"; exit 2; }
    WANT="${3:-}"
    case "$WANT" in
      *[!0-9a-f]*|"") echo "$USAGE"; exit 2 ;;
    esac
    [ "${#WANT}" -ge 7 ] || { echo "$USAGE"; exit 2; }
    FROM=local ;;
  *) echo "$USAGE"; exit 2 ;;
esac
log() { printf '%s  %s\n' "$(date '+%F %T')" "$*" | tee -a "$LOG"; }

[ -d "$PROD/.git" ] || { echo "prod checkout missing: $PROD"; exit 1; }
if [ -d "$LOCK" ] && [ -z "$(find "$LOCK" -maxdepth 0 -newermt '-15 minutes' 2>/dev/null)" ]; then rm -rf "$LOCK"; fi
mkdir "$LOCK" 2>/dev/null || { log "SKIP: another prod update is running"; exit 0; }
trap 'rm -rf "$LOCK"' EXIT

export PATH=/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin
cd "$PROD" || exit 1
PREV=$(git rev-parse HEAD)
if [ "$FROM" = local ]; then
  REF=refs/remotes/local/main
  git fetch --quiet "$LOCAL_REPO" "+refs/heads/main:$REF" || { log "ERROR: local fetch failed"; exit 1; }
else
  REF=refs/remotes/origin/main
  git fetch --quiet origin main || { log "ERROR: fetch failed"; exit 1; }
fi
NEW=$(git rev-parse "$REF")
if [ "$FROM" = local ]; then
  # CISO S1: deploy the exact commit that passed the gate, not whatever main is now.
  WANT_FULL=$(git rev-parse --verify --quiet "$WANT^{commit}") || WANT_FULL=""
  if [ -z "$WANT_FULL" ] || [ "$WANT_FULL" != "$NEW" ]; then
    log "ERROR: local main is ${NEW:0:7}, not ${WANT:0:7}; refusing. prod left at ${PREV:0:7}"
    exit 1
  fi
fi
[ "$PREV" = "$NEW" ] && { log "already at ${NEW:0:7}; nothing to do"; exit 0; }
# Prod already runs these commits (a local deploy came first): do not step back.
git merge-base --is-ancestor "$NEW" "$PREV" && { log "already contains ${NEW:0:7} (prod at ${PREV:0:7}); nothing to do"; exit 0; }
git merge --ff-only --quiet "$REF" || { log "ERROR: not a fast-forward; prod left at ${PREV:0:7}"; exit 1; }
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
if [ -n "$RESTART_CMD" ]; then "$RESTART_CMD" >> "$LOG" 2>&1
else launchctl kickstart -k "gui/$(id -u)/com.overwatch.prod" >> "$LOG" 2>&1; fi
log "prod now at ${NEW:0:7}; server restarted"
exit 0
}
