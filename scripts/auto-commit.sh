#!/bin/bash
# Idle-triggered working-tree checkpoint for the overwatch repo.
#
# Fires shortly after Sean STOPS working, not on the hour. launchd polls this
# every 5 minutes; the quiescence check below is what actually decides. The old
# hourly schedule looked fine and quietly did nothing: on 2026-09-15 it ran at
# 14:45, 15:45 and 16:45 and skipped all three, because a session was in
# progress the whole time. Two days of work sat uncommitted and the loop had no
# way to say so.
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
# How long the tree must sit untouched before this counts as "he stepped away".
# 15 rather than 20 on Sean's request — with a 5-minute poll that means a
# checkpoint lands within ~20 minutes of the last keystroke.
QUIET_MINUTES=15
LOG="$HOME/Library/Logs/overwatch-auto-commit.log"
STATE="$HOME/Library/Logs/.overwatch-auto-commit-state"
# Read by the Claude Code statusline (~/.claude/statusline.sh) so the terminal
# can show when a checkpoint is mid-flight. Purely informational: the LOCK
# below is what actually makes concurrency safe, not this.
RUNSTATE="$HOME/Library/Logs/.overwatch-auto-commit-running"
LOCK="$HOME/Library/Logs/.overwatch-auto-commit.lock"
# Webhook for #hq-briefing, kept in the vault's automation env rather than
# copied here — one file owns that URL.
HQ_ENV="/Users/Sean/second-brain/.claude/automation/.env"

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

# ── Lock ────────────────────────────────────────────────────────────────────
# mkdir is atomic, so this is a real mutual exclusion rather than a
# check-then-create race. It matters for one specific collision: Sean running
# /cpul by hand at the same moment this fires. Git would not corrupt anything —
# it would just fail on .git/index.lock — but a half-staged commit racing a
# manual one is confusing in a way that is trivially avoidable. A lock older
# than 30 minutes is treated as a crashed run and cleared, so a killed process
# can't wedge the loop shut forever.
if [ -d "$LOCK" ] && [ -z "$(find "$LOCK" -maxdepth 0 -newermt '-30 minutes' 2>/dev/null)" ]; then
  rm -rf "$LOCK"
fi
if ! mkdir "$LOCK" 2>/dev/null; then
  exit 0   # another run (or a manual commit) holds it; silence is correct here
fi
cleanup() { rm -rf "$LOCK"; rm -f "$RUNSTATE"; }
trap cleanup EXIT INT TERM

# Posts a one-line summary to #hq-briefing. Separate from notify_once above:
# that one is a state-change alarm for the overwatch channel, this is the
# "so you're not in the dark" feed Sean asked for. Only ever called when
# something actually HAPPENED — a commit, a gate failure, a blocked push —
# plus one end-of-day wrap. Skips stay silent, or with a 5-minute poll the
# channel would fill with "still editing" all day.
hq() {
  local url
  url=$(grep -m1 '^SLACK_WEBHOOK_URL=' "$HQ_ENV" 2>/dev/null | cut -d= -f2-)
  [ -z "$url" ] && return 0
  curl -s -m 15 -X POST -H 'Content-Type: application/json' \
    --data "$(python3 -c 'import json,sys; print(json.dumps({"text": sys.argv[1]}))' "$1")" \
    "$url" > /dev/null 2>&1
}

cd "$REPO" || { log "FATAL: cannot cd to $REPO"; exit 1; }

# ── End-of-day wrap ─────────────────────────────────────────────────────────
# Runs before any early exit below, so it lands whether or not there is work to
# do. Without it, silence in #hq-briefing has two meanings — "nothing needed
# committing" and "this loop has been dead for three days" — and Sean cannot
# tell them apart. That ambiguity is the actual complaint this whole change
# exists to fix, so the wrap is not optional garnish.
TODAY=$(date '+%Y-%m-%d')
WRAP_MARK="$HOME/Library/Logs/.overwatch-auto-commit-wrap"
HOUR=$(date '+%H')
if [ "$HOUR" -ge 20 ] && [ "$(cat "$WRAP_MARK" 2>/dev/null)" != "$TODAY" ]; then
  printf '%s' "$TODAY" > "$WRAP_MARK"
  COMMITS_TODAY=$(git log --since="$TODAY 00:00" --oneline 2>/dev/null | wc -l | tr -d ' ')
  AUTO_TODAY=$(grep -c "^$TODAY.*committed " "$LOG" 2>/dev/null || echo 0)
  SKIPS_TODAY=$(grep -c "^$TODAY.*SKIP: files modified" "$LOG" 2>/dev/null || echo 0)
  LAST=$(grep "^$TODAY.*committed " "$LOG" 2>/dev/null | tail -1 | cut -c12-16)
  DIRTY=$(git status --porcelain | wc -l | tr -d ' ')
  hq ":clipboard: *overwatch checkpoint loop — $TODAY wrap*
• $COMMITS_TODAY commit(s) today, $AUTO_TODAY of them automatic${LAST:+ (last at $LAST)}
• $SKIPS_TODAY poll(s) skipped because you were still editing
• working tree right now: $([ "$DIRTY" -eq 0 ] && echo 'clean' || echo "$DIRTY uncommitted file(s)")"
fi

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
printf 'checkpointing since %s' "$(date '+%H:%M')" > "$RUNSTATE"
GATE_OUT=$(mktemp)
gate_fail() {
  log "GATE FAILED ($1) — NOT committing. Tail:"
  tail -15 "$GATE_OUT" >> "$LOG"
  hq ":warning: *overwatch checkpoint held back* — uncommitted work is failing \`$1\`. Nothing was committed and the working tree is untouched."
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

# --- Secret scan: fail closed, never auto-fix --------------------------------
# The remote can go public under Phase 1 with no human in this loop, so a
# staged secret must abort the commit rather than ship it.
SECRET_PATTERNS='sk-|xox[bap]-|hooks\.slack\.com/services/|Bearer [A-Za-z0-9]{20,}|-----BEGIN .* PRIVATE KEY-----'
SECRET_HIT=""
if git diff --cached | grep -qE "$SECRET_PATTERNS"; then
  SECRET_HIT="credential pattern in staged diff"
fi
# A staged .env (or *.env) file that isn't .env.example is also a hard stop,
# even if its contents didn't match a pattern above.
ENV_FILE=$(git diff --cached --name-only | grep -E '(^|/)\.env$|(^|/)[^/]*\.env$' | grep -v '\.env\.example$' | head -1)
if [ -n "$ENV_FILE" ]; then
  SECRET_HIT="staged env file: $ENV_FILE"
fi
if [ -n "$SECRET_HIT" ]; then
  git reset --quiet
  log "GATE FAILED (secret scan) — NOT committing. Reason: $SECRET_HIT"
  notify_once "fail:secret-scan" ":rotating_light: *overwatch auto-commit held back* — staged changes matched a credential pattern ($SECRET_HIT). Nothing was committed; changes were unstaged, working tree untouched. Check \`$LOG\`."
  exit 0
fi

MSG=$(printf 'chore(auto): checkpoint working tree (%s files)\n\nAutomated hourly checkpoint. The full gate passed before this was written:\nserver typecheck, client typecheck, and the test suite (%s passing).\n\nFiles:\n%s\n\nThis is a safety checkpoint, not a curated commit — squash or reword it\nfreely when you next tidy history.\n' "$FILES" "${TESTS:-?}" "$SUMMARY")

if git commit --quiet -m "$MSG" 2>>"$LOG"; then
  log "committed $FILES file(s) on $BRANCH"
else
  log "ERROR: commit failed"; exit 1
fi

# --- Push: fast-forward only, never force -----------------------------------
if git push --quiet 2>>"$LOG"; then
  log "pushed to origin/$BRANCH"
  hq ":white_check_mark: *overwatch checkpoint saved* — $FILES file(s) committed and pushed on \`$BRANCH\` after a clean gate (${TESTS:-?} tests passing)."
  notify_once "ok" ":white_check_mark: *overwatch auto-commit resumed* — working tree is healthy again and checkpointed."
else
  log "ERROR: push rejected (remote likely ahead). Commit is safe locally; NOT force-pushing."
  hq ":warning: *overwatch checkpoint committed but not pushed* — $FILES file(s) are saved locally; the remote has diverged and this loop will not force-push. Needs a hand."
  notify_once "fail:push" ":warning: *overwatch auto-commit could not push* — the commit is saved locally but the remote has diverged. Resolve by hand; the loop will not force-push."
fi
