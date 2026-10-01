#!/bin/bash
# Waits for a push to main to land on origin, then updates production.
# Arg 1: origin/main's SHA BEFORE the push (from the pre-push hook).
# Gives up after ~3 minutes (push was rejected/aborted): prod is left alone.
OLD="$1"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for i in $(seq 1 60); do
  NOW=$(git -C "$ROOT" ls-remote origin refs/heads/main 2>/dev/null | cut -f1)
  if [ -n "$NOW" ] && [ "$NOW" != "$OLD" ]; then
    exec "$ROOT/scripts/update-prod.sh"
  fi
  sleep 3
done
echo "$(date '+%F %T')  push to main never landed (origin/main still ${OLD:0:7}); prod not updated"
