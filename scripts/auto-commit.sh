#!/bin/bash
# Hourly working-tree checkpoint for the overwatch repo.
#
# WHY THIS EXISTS: the standing rule is to commit at the end of a session, but
# sessions don't always end cleanly — the failure mode already in the project's
# own session log is "a session happened and vanished". This closes that gap by
# committing work that is *demonstrably healthy* and leaving everything else
# alone.
#
# WHAT MAKES IT SAFE TO RUN UNATTENDED:
#   1. It never commits code that doesn't pass the full gate (typecheck both
#      sides + the whole test suite). A red tree is reported, never committed.
#   2. It never commits while you're actively editing — the tree must be quiet
#      for QUIET_MINUTES first, so it checkpoints work you've stepped away from
#      rather than half-finished keystrokes.
#   3. It only ever does the two reversible git operations: commit, and
#      fast-forward push. No force-push, no rebase, no history rewrite, no
#      branch deletion, no tag/remote changes. If the push isn't a
#      fast-forward it stops and reports rather than resolving anything.
#   4. Secrets can't leak: .env, *.db and .claude/ are gitignored, and this
#      script adds nothing that git itself would not.
#
# Deliberately NOT here: any LLM review step that auto-applies edits. An agent
# approving its own refactor is not a review, and unattended auto-edits are how
# an hourly loop quietly rewrites a codebase overnight. Findings belong in a
# report a human reads; this script's only job is "is it healthy, and is it
# saved".
set -uo pipefail

REPO="/Users/Sean/Code/overwatch"
QUIET_MINUTES=20
LOG="$HOME/Library/Logs/overwatch-auto-commit.log"
STATE="$HOME/Library/Logs/.overwatch-auto-commit-state"

log() { printf '%s  %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"; }

# Slack notification, reusing the nightly report's webhook. Only fires on a
# CHANGE of state (healthy <-> failing) so a tree left red overnight produces
# one message, not sixteen.
notify_once() {
  local key="$1" msg="$2"
  local prev=""; [ -f "$STATE" ] && prev=$(cat "$STATE")
  [ "$prev" = "$key" ] && return 0
  # "recovered" is only meaningful if we were actually failing before. On a
  # first-ever run, or after a normal run, staying quiet is correct.
  case "$key" in ok) case "$prev" in fail:*) ;; *) printf '%s' "$key" > "$STATE"; return 0 ;; esac ;; esac
  printf '%s' "$key" > "$STATE"
  local url
  url=$(grep -m1 '^SLACK_WEBHOOK_URL=' "$REPO/server/.env" 2>/dev/null | cut -d= -f2-)
  [ -z "$url" ] && return 0
  curl -s -m 15 -X POST -H 'Content-Type: application/json' \
    --data "$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$msg")" \
    "$url" > /dev/null 2>&1
}

cd "$REPO" || { log "FATAL: cannot cd to $REPO"; exit 1; }

# --- Refuse to act on a repo that is mid-operation or in a detached state ----
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ] || [ -f .git/MERGE_HEAD ] || [ -f .git/CHERRY_PICK_HEAD ]; then
  log "SKIP: repo is mid-rebase/merge/cherry-pick — not touching it"; exit 0
fi
BRANCH=$(git symbolic-ref --quiet --short HEAD 2>/dev/null)
if [ -z "$BRANCH" ]; then log "SKIP: detached HEAD — not committing"; exit 0; fi

# --- Anything to do? --------------------------------------------------------
if [ -z "$(git status --porcelain)" ]; then
  # Clean tree, but there may still be local commits that never got pushed.
  if [ -n "$(git log --branches --not --remotes --oneline 2>/dev/null)" ]; then
    log "clean tree, unpushed commits present — pushing"
    if git push --quiet 2>>"$LOG"; then log "pushed unpushed commits on $BRANCH"; else log "ERROR: push failed"; fi
  fi
  exit 0
fi

# --- Quiescence: don't checkpoint work that's actively being typed ----------
RECENT=$(find client/src server/src docs scripts -type f -newermt "-${QUIET_MINUTES} minutes" 2>/dev/null | head -1)
if [ -n "$RECENT" ]; then
  log "SKIP: files modified within ${QUIET_MINUTES}m (still working) — e.g. $RECENT"; exit 0
fi

# --- The gate: nothing gets committed unless all of this passes -------------
GATE_OUT=$(mktemp)
gate_fail() {
  log "GATE FAILED ($1) — NOT committing. Tail:"
  tail -15 "$GATE_OUT" >> "$LOG"
  notify_once "fail:$1" ":warning: *overwatch auto-commit held back* — uncommitted work is failing \`$1\`. Nothing was committed; the working tree is untouched. Check \`$LOG\`."
  rm -f "$GATE_OUT"; exit 0
}
( cd server && npx tsc --noEmit ) > "$GATE_OUT" 2>&1 || gate_fail "server typecheck"
( cd client && npx tsc --noEmit ) > "$GATE_OUT" 2>&1 || gate_fail "client typecheck"
( cd server && npm test --silent ) > "$GATE_OUT" 2>&1 || gate_fail "test suite"
# Reuse the gate's own test output rather than running the suite a second time.
TESTS=$(grep -oE 'pass [0-9]+' "$GATE_OUT" | head -1 | awk '{print $2}')
rm -f "$GATE_OUT"

# --- Commit -----------------------------------------------------------------
FILES=$(git status --porcelain | wc -l | tr -d ' ')
SUMMARY=$(git status --porcelain | awk '{print $NF}' | head -8 | sed 's/^/  /')
git add -A
# Nothing staged after add means every change was gitignored — not a commit.
if git diff --cached --quiet; then log "SKIP: all changes are gitignored"; exit 0; fi

MSG=$(printf 'chore(auto): checkpoint working tree (%s files)\n\nAutomated hourly checkpoint. The full gate passed before this was written:\nserver typecheck, client typecheck, and the test suite (%s passing).\n\nFiles:\n%s\n\nThis is a safety checkpoint, not a curated commit — squash or reword it\nfreely when you next tidy history.\n' "$FILES" "${TESTS:-?}" "$SUMMARY")

if git commit --quiet -m "$MSG" 2>>"$LOG"; then
  log "committed $FILES file(s) on $BRANCH"
else
  log "ERROR: commit failed"; exit 1
fi

# --- Push: fast-forward only, never force -----------------------------------
if git push --quiet 2>>"$LOG"; then
  log "pushed to origin/$BRANCH"
  notify_once "ok" ":white_check_mark: *overwatch auto-commit resumed* — working tree is healthy again and checkpointed."
else
  log "ERROR: push rejected (remote likely ahead). Commit is safe locally; NOT force-pushing."
  notify_once "fail:push" ":warning: *overwatch auto-commit could not push* — the commit is saved locally but the remote has diverged. Resolve by hand; the loop will not force-push."
fi
