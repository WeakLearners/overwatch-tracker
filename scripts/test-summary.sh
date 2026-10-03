#!/bin/bash
# Run the whole suite and print only the totals lines (tests, pass, fail) per package.
# Exit code is non-zero if any package fails. Usage: npm run test:summary  (root or server)
cd "$(dirname "$0")/.."
rc=0
for ws in server client; do
  echo "== $ws"
  out=$(npm test --silent --workspace=$ws 2>&1); code=$?
  echo "$out" | grep -E '^(ℹ (tests|pass|fail)|✖)'
  [ $code -eq 0 ] || { rc=1; echo "FAILED: $ws"; }
done
echo "== scripts/roleTimer.test.ts"
out=$(npx tsx scripts/roleTimer.test.ts 2>&1); code=$?
echo "$out" | grep -cE '^PASS' | sed 's/$/ pass/'
echo "$out" | grep -E '^FAIL'
[ $code -eq 0 ] || { rc=1; echo "FAILED: roleTimer"; }
exit $rc
