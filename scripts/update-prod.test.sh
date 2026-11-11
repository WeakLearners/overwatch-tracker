#!/bin/bash
# Offline test of scripts/update-prod.sh --from local. Builds throwaway repos in
# a temp dir, never touches ~/Code/overwatch-prod. Run: bash scripts/update-prod.test.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d "${TMPDIR:-/tmp}/updprod.XXXXXX")"
trap 'rm -rf "$T"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export OVERWATCH_PROD_DIR="$T/prod" OVERWATCH_LOCAL_REPO="$T/local" OVERWATCH_PROD_LOCK="$T/lock" OVERWATCH_RESTART_CMD=true
FAIL=0
check() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1: want '$3' got '$2'"; FAIL=1; fi; }
commit() { # $1 message, $2 build exit code
  mkdir -p scripts
  printf '#!/bin/bash\nexit %s\n' "$2" > scripts/build-client.sh; chmod +x scripts/build-client.sh
  echo "$1" >> f.txt; git add -A; git commit -q -m "$1"
}
git init -q --bare "$T/origin.git"
git init -q -b main "$T/local"; ( cd "$T/local" && git remote add origin "$T/origin.git" && commit c1 0 && git push -q origin main )
git clone -q "$T/origin.git" "$T/prod"
head_of() { git -C "$1" rev-parse HEAD; }
run() { bash "$HERE/update-prod.sh" "$@" > "$T/out.txt" 2>&1; echo $?; }

( cd "$T/local" && commit c2 0 )
check "local deploy exit" "$(run --from local)" 0
check "prod moved to local HEAD" "$(head_of "$T/prod")" "$(head_of "$T/local")"
C2=$(head_of "$T/local")

check "push-mode run while origin is behind: exit" "$(run)" 0
check "push-mode run does not step back" "$(head_of "$T/prod")" "$C2"
check "push-mode run says already contains" "$(grep -c 'already contains' "$T/out.txt")" 1

( cd "$T/local" && git push -q origin main )
check "run after the push: exit" "$(run)" 0
check "run after the push: prod unchanged" "$(head_of "$T/prod")" "$C2"
check "run after the push says already at" "$(grep -c 'already at' "$T/out.txt")" 1

( cd "$T/local" && commit c3-bad-build 1 )
check "failing client build: exit" "$(run --from local)" 1
check "failing client build rolls back" "$(head_of "$T/prod")" "$C2"
check "rollback logged" "$(grep -c 'rolling back' "$T/out.txt")" 1

check "bad flag refused" "$(run --from nowhere)" 2
check "lock released" "$([ -d "$T/lock" ] && echo held || echo free)" free
exit $FAIL
