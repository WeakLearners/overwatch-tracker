#!/bin/bash
# Builds the production client and atomically points client/current at it.
#
# Run automatically by .git/hooks/post-commit (see scripts/git-hooks/
# post-commit, installed once via `git config core.hooksPath scripts/git-
# hooks`) after every commit on any branch, and can be run by hand.
#
# WHY BLUE-GREEN, NOT "BUILD INTO client/dist": port 3001 serves whatever
# client/current points at, live, all the time — that's the whole point of
# this setup (2026-09-26, see server/src/index.ts). Building straight into
# the directory Express is reading from means a request landing mid-build
# gets a half-written index.html or a missing asset. Instead this keeps TWO
# build directories, client/dist-a and client/dist-b, and always builds into
# whichever one is NOT currently live, then repoints the client/current
# symlink in one rename() — a single filesystem operation, so there is no
# moment where client/current is missing or points at a partial build.
#
# WHY A LOCK: two commits landing within the same few seconds (e.g. the
# auto-commit checkpoint firing right after a manual commit) would otherwise
# race to build into the SAME "not currently live" directory at once. The
# lock just serializes them; the second one still runs, a few seconds later,
# against whatever HEAD is by the time it gets the lock.
#
# WHY A FAILED BUILD DOESN'T TOUCH client/current: it must not, or a broken
# commit would take the always-on app down for however long it takes to fix
# and re-push. A failed build logs and exits 0 (the post-commit hook that
# calls this backgrounds it anyway, so the commit itself was never at risk).
set -uo pipefail

REPO="$HOME/Code/overwatch"
LOG="$REPO/scripts/build-client.log"
LOCK="$REPO/scripts/.build-client.lock"

cd "$REPO" || { echo "FATAL: cannot cd to $REPO" >> "$LOG" 2>&1; exit 1; }

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

# mkdir is atomic — real mutual exclusion, not a check-then-create race. A
# lock older than 15 minutes is treated as a crashed run and cleared, so a
# killed build can't wedge every future rebuild shut.
if [ -d "$LOCK" ] && [ -z "$(find "$LOCK" -maxdepth 0 -newermt '-15 minutes' 2>/dev/null)" ]; then
  rm -rf "$LOCK"
fi
if ! mkdir "$LOCK" 2>/dev/null; then
  log "SKIP: another build is already running"
  exit 0
fi
trap 'rm -rf "$LOCK"' EXIT INT TERM

SHA=$(git rev-parse --short HEAD 2>/dev/null || echo unknown)
log "build starting for $SHA"

CUR_TARGET=""
if [ -L client/current ]; then
  CUR_TARGET=$(readlink client/current)
fi
if [ "$CUR_TARGET" = "dist-a" ]; then
  NEXT=dist-b
else
  NEXT=dist-a
fi

rm -rf "client/$NEXT"
if (cd client && npx tsc && npx vite build --outDir "$NEXT") >> "$LOG" 2>&1; then
  # Atomic swap: stage the new symlink under a temp name, then rename it over
  # the live one. `mv` of a symlink onto an existing path is one rename()
  # syscall on the same filesystem — client/current is never briefly absent.
  ln -sfn "$NEXT" client/current.new
  mv -f client/current.new client/current
  log "build OK for $SHA -> client/current -> $NEXT"
else
  log "BUILD FAILED for $SHA -- client/current left pointing at the last good build (${CUR_TARGET:-none yet})"
fi
