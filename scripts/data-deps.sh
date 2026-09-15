#!/usr/bin/env bash
# Write-only column audit.
#
# Finds columns this app WRITES but never READS for analysis — data Sean typed
# in that reaches no surface. That failure is invisible by every normal check:
# the form works, the insert works, the column fills up, tsc is clean, tests
# pass. Nothing is broken; the data just goes nowhere. It went unnoticed here
# for months across 618 readings (extra_acc, hero_stat_label/value,
# torpedo_damage/healing) until someone happened to ask why a stat never
# showed up on the analysis page.
#
# Heuristic, not proof. It classifies each column by WHERE its name appears:
#
#   WRITE sites   - schema.ts (DDL/migrations), INSERT/UPDATE statements,
#                   fixtures.ts
#   FORM sites    - the entry form + the endpoints that read a value back
#                   solely to repopulate that form for editing
#   ANALYSIS site - anything else on the server (rollups, aggregates) or any
#                   client page that isn't the entry form
#
# A column with write sites and form sites but NO analysis site is the exact
# shape of the bug. It gets flagged. Read the flag as "justify this", not as
# "fix this" — some columns are legitimately capture-only.
#
# Usage:  scripts/data-deps.sh [table ...]        (default: the aim tables)
set -euo pipefail
cd "$(dirname "$0")/.."

DB=data/overwatch.db
TABLES=("$@")
if [ ${#TABLES[@]} -eq 0 ]; then
  TABLES=(aim_stats aim_stats_heroes matches match_heroes blind_stage_sets)
fi

# Files that only ever WRITE or round-trip a value back into the entry form.
# A hit in one of these is not evidence the data is analysed.
is_write_or_form() {
  case "$1" in
    */db/schema.ts|*/db/fixtures.ts) return 0 ;;
    */pages/SensLog.tsx|*/pages/LogMatch.tsx) return 0 ;;
    # Entry-form CONFIG (which slot a hero shows, what it's called). Names
    # columns in real code, not comments, but analyses none of them.
    */lib/heroStatLabels.ts) return 0 ;;
    *) return 1 ;;
  esac
}

# Prints the region of a file that counts as ANALYSIS, with comment lines
# stripped. Two refinements, both learned from this audit's own false pass:
#
#   1. Comments are stripped. lib/heroStatLabels.ts names half these columns
#      in its header comment and reads none of them; uncommented, it scored as
#      a reader for six columns it never touches.
#   2. routes/aim.ts is split. It holds BOTH the analysis rollup
#      (computeAnalysis) and the endpoints that read values back purely to
#      repopulate the entry form. Counting the whole file made every column
#      look analysed — which is precisely how extra_acc and hero_stat_value
#      sat unanalysed for months while appearing "read" to a file-level grep.
#      Only computeAnalysis's body counts here.
analysis_region() {
  local f="$1"
  case "$f" in
    */routes/aim.ts)
      awk '/^export function computeAnalysis/{inside=1} inside{print} inside && /^}/{if (seen++) exit}' "$f"
      ;;
    *) cat "$f" ;;
  esac | sed -e 's://.*::' -e '/^[[:space:]]*\*/d' -e '/^[[:space:]]*\/\*/d'
}

red=$'\033[31m'; yellow=$'\033[33m'; green=$'\033[32m'; dim=$'\033[2m'; off=$'\033[0m'
flagged=0

for table in "${TABLES[@]}"; do
  cols=$(sqlite3 "$DB" "SELECT name FROM pragma_table_info('$table');" 2>/dev/null || true)
  [ -z "$cols" ] && { echo "${dim}skip $table (not in $DB)${off}"; continue; }

  echo
  echo "── $table ─────────────────────────────────────────────"
  for col in $cols; do
    # Ambiguous short names (id, hero, date, win) collide with everything and
    # tell us nothing; skip rather than print noise.
    case "$col" in id|hero|role|map|date|time|win|sens|dpi|notes|created_at|match_id|set_id) continue ;; esac

        # -w so a short column name can't match a longer one that contains it
    # (plain 'damage' otherwise scores a hit on every 'torpedo_damage' line).
    hits=$(grep -rlw --include='*.ts' --include='*.tsx' --include='*.py' -- "$col" server/src client/src scripts 2>/dev/null || true)
    [ -z "$hits" ] && { printf "  %-22s ${red}UNREFERENCED${off}  (written by nothing?)\n" "$col"; continue; }

    analysis_sites=""
    for f in $hits; do
      case "$f" in *.test.ts) continue ;; esac
      is_write_or_form "$f" && continue
      # Must survive comment-stripping (and, for aim.ts, must live inside
      # computeAnalysis) to count as a real reader.
      #
      # Via a here-string, NOT a pipe: `analysis_region | grep -q` silently
      # reports failure under `set -o pipefail`, because grep -q exits on the
      # first match and the upstream sed then dies on SIGPIPE, which pipefail
      # promotes to the pipeline's status. That made every match look like a
      # miss and flagged genuinely-analysed columns (final_blows) as write-only
      # — an audit tool lying in the more dangerous direction.
      region=$(analysis_region "$f")
      if grep -qw -- "$col" <<< "$region"; then
        analysis_sites="$analysis_sites $f"
      fi
    done

    if [ -z "$analysis_sites" ]; then
      printf "  %-22s ${red}WRITE-ONLY${off}     (no reader outside schema/fixtures/entry form)\n" "$col"
      flagged=$((flagged + 1))
    else
      n=$(echo $analysis_sites | wc -w | tr -d ' ')
      printf "  %-22s ${green}read${off}  ${dim}%s reader(s):%s${off}\n" "$col" "$n" \
        "$(echo $analysis_sites | sed 's|server/src/||g; s|client/src/||g')"
    fi
  done
done

echo
if [ "$flagged" -gt 0 ]; then
  echo "${yellow}$flagged column(s) flagged write-only.${off} Each is either a real gap or a deliberate capture-only field — decide which, don't leave it ambiguous."
else
  echo "${green}No write-only columns found.${off}"
fi
