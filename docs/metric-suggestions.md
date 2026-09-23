# Metric suggestions — overwatch-analysis

Written 2026-09-23, suggestions only, nothing built. Ranked derived-first
(free to compute from data already in `data/overwatch.db`), then typed,
then imported. Every "how long before it says anything real" estimate
below uses the app's own real numbers, pulled read-only from the live DB
this session:

- 3,622 matches total, 2024-11-28 → 2026-09-23 (665 days, ~5.4 matches/day
  average pace — a real day varies a lot around that).
- `aim_stats.damage` populated on 901 matches (~25%).
- `aim_stats.healing` on 206, `aim_stats.assists` on 193 (~5–6%).
- `match_deaths` has rows on 124 distinct matches (~3.4%).
- `matches.team_rating` on 554 (~15%), `match_quality` on 136,
  `result_driver` on 133 (~3.7% each).
- `matches.account` on 31 rows, only 2 distinct accounts.

Existing minimum-n guards in the code run 8–30 games *per side* of a split
(`PERF_MIN_GAMES=8`, `HOT_HAND_MIN_GAMES=10`, sens study's `MIN_N=30`). The
estimates below borrow that scale rather than inventing a new one.

## Derived — already in the data, costs Sean nothing to capture

**1. Healing & assist rate into the existing performance-outcome check**
What it measures: whether playing above your own healing/10min or
assists/10min average tracks winning, the same way damage/10min and
elims/10min already do in `computePerformanceOutcome`.
Captured: fully derived — `aim_stats.healing`, `aim_stats.assists`,
`aim_stats.duration_min` all already exist and are written by the Aim
Stats form; today only `damage`/`elims`/`final_blows` feed that function.
Sample size: 206 (healing) / 193 (assists) rows already logged clears the
8-per-side bar today on most splits — this is close to usable now, not a
future promise.
Useful because: damage and healing are exactly as legitimate a sensitivity
or skill signal as accuracy, and right now the app silently treats them as
support-only scoreboard trivia. Misleading if: healing/assists are heavily
role-skewed (a DPS match logs near-zero healing) — the split needs to
either condition on role or exclude off-role zeros, or "below-average
healing loses more" will just be re-discovering "DPS games aren't tank
games."

**2. Death-cause breakdown from `match_deaths`**
What it measures: which enemy hero and role kill you most, and what share
of your deaths are to an enemy ultimate — a pure frequency table, no
per-event judgment involved (the table already stores only killer hero,
killer role, ult yes/no as fact).
Captured: fully derived, zero new capture — `match_deaths` exists and is
written inline in the Log Match Deaths card; it is currently written and
never read by anything.
Sample size: 494 death rows across 124 matches today. A per-killer-hero
breakdown needs its own min-n (suggest 10+ deaths to that hero before
showing a rate) — with 32 heroes splitting 494 rows, most cells aren't
there yet. The roster-wide "% of deaths to an ult" number is usable now.
Useful because: this is data Sean is already typing in that reaches no
analysis surface at all — the exact failure mode that shipped undetected
on 2026-09-15. Misleading if: shown as a raw count instead of a rate — a
hero you fight often will top the list by exposure, not lethality, unless
normalized by something like matches-on-that-map/that-enemy-comp, which
this table doesn't capture. Ship the ult-death share and the raw
frequency table with an explicit "exposure, not lethality" caption; hold
off on ranking heroes by "how much they kill you" until there's an
exposure denominator.

**3. Teammate-rating vs. outcome**
What it measures: does `team_rating` (the 0–5 star teammate-quality field
already on every match, when filled) actually predict the win, the same
correlational check `computeCritAccuracy` already runs on crit accuracy.
Captured: fully derived — `matches.team_rating` exists, is written by
LogMatch, and is currently read only for the match-history list, never
crossed against `win`.
Sample size: 554 matches already logged. Clears every existing min-n bar
today.
Useful because: it's a direct check on a belief Sean is already forming
every game he rates a teammate — either the rating tracks the outcome or
it's just retroactive blame/credit, and right now nobody has looked.
Misleading if: rated only for losses (rating a bad teammate is more salient
after a loss than a win) — check the split isn't itself confounded by
`win` before trusting the correlation's direction.

**4. Surface `match_quality` and `result_driver` as trend factoids**
What it measures: nothing new — these are two existing categorical fields
(how the match felt, what drove the result) captured by LogMatch since
before this session and read by nothing, per this app's own known
write-only-field pattern (flagged the same way `team_rating` was on
2026-07). Putting them on screen — a win-rate-by-category card, or added
to the `/insights` factoid pool — is the suggestion.
Captured: fully derived, already written.
Sample size: 136 / 133 matches. Thin per category value, but the category
count is small (a handful of `result_driver` values), so some cells likely
already clear 10+.
Useful because: this is literally the 2026-09-15 failure mode ("618
hand-entered ability readings written to SQLite and read by nothing")
recurring at smaller scale unless it's fixed now.
Misleading if: shown without each category's own n — a 3-match category
at 100% win rate is noise dressed as a finding.

**5. Rank-band win rate / promotion velocity**
What it measures: win rate by `player_rank_start` band, and how many
games it takes to move one rank band up or down — using `player_ranks`
(current rank per account+role) and `matches.player_rank_start` together.
Captured: fully derived — both already exist; `derank unlogged` has been
sitting on the blocker list since at least 2026-09-22.
Sample size: not queried this session (would need a join across
`player_ranks` history, which isn't itself versioned — only current rank
is stored, so "velocity" needs `player_rank_start` trends over time
instead of a rank-history table that doesn't exist). Flag: velocity in
the strict sense may not be answerable from today's schema without adding
a rank-change log; win-rate-by-band is answerable today from
`player_rank_start` alone.
Useful because: it directly answers "am I actually climbing" instead of
leaving Sean to eyeball a rank number. Misleading if: `player_rank_start`
is missing on older rows (it's a nullable, added-later column) — state
the coverage rate before reading anything into the band splits.

**6. Map-normalized combat rate (not win rate) by map**
What it measures: damage/10min and elims/10min by map — a mechanical
performance question, deliberately not a win-rate-by-map question, since
win-rate-by-map was tested across 32 maps and retired as noise.
Captured: fully derived — `aim_stats` joined to `matches.map`.
Sample size: bounded by the 901 damage-logged matches split across ~30+
maps — most individual maps won't clear a 10-per-map minimum yet. Roster
map count (Circuit Royale/King's Row/Gibraltar are the highest-volume
maps per `stats-snapshot.md`) will clear it soonest.
Useful because: "do I output less on this map" is a different, legitimate
question from "do I win less on this map," and the retirement of the
latter doesn't retire the former — conflating them would be the mistake.
Misleading if: reported as a map ranking rather than flagged only where
n clears the bar — same discipline that retired win-rate-by-map applies
here from day one, not after the fact.

**7. Queue-mode combat-rate cross (not just win rate)**
What it measures: extends the existing `computeQueueSwitchTax` (which
only looks at win rate around a queue-mode switch) to also check
damage/elims/accuracy rates by queue mode itself (comp vs. qp vs. open),
not just around a switch.
Captured: fully derived — `matches.queue_mode` × `aim_stats` rates.
Sample size: bounded by the same 901-row aim_stats pool split three ways;
likely usable for the two most-played modes, thin for the third.
Useful because: if accuracy or output differs by queue mode independent
of the switch-tax effect, that's a distinct and currently invisible
signal — comp nerves vs. qp looseness, stated numerically instead of
assumed.
Misleading if: pooled without the switch-tax control already in place —
a queue-mode difference could just be restating "first game after a
switch is worse," not a mode effect. Report it alongside the existing
switch-tax number, not standalone.

**8. Hero-switch cost within a match**
What it measures: using `match_heroes` (already capturing every hero
played within a match via slot 1/2/3), whether matches with a mid-match
hero switch win at a different rate than single-hero matches, and whether
switching correlates with a worse per-hero accuracy on the second hero
than that hero's own baseline.
Captured: fully derived — `match_heroes` exists and is written already
for the sens study's per-hero rows; this reuses it for a question the
sens study isn't asking.
Sample size: not queried this session — needs a count of matches with
`COUNT(DISTINCT hero) > 1` in `match_heroes`. Recommend checking this
count before committing to build; if switches are rare the split won't
clear any min-n bar for a long time.
Useful because: "does switching hurt" is a real, answerable question this
app already has the rows for and has never asked.
Misleading if: switch matches are systematically the close/losing games
(you only switch when a match is going badly) — that's reverse causation,
not switching causing the loss. State this confound explicitly if built.

## Typed — one new field, single per match, skippable

**9. Ultimates used (integer, per match, nullable, no default)**
What it measures: a single count typed once at match end — how many times
you used your ultimate — enabling an ult-economy-vs-outcome check
(ults/10min vs. win, the same rate-normalization already used for
damage/elims) without touching the retired per-event judgment pattern.
Captured: new column, one number, one typed field — same shape as
`leaver`: nullable, no default, so the silent archive stays honestly
unanswered rather than defaulting to zero.
Sample size: starts at zero like `leaver` did today; at ~5.4 matches/day
it clears an 8-per-side min-n bar (16 logged matches) in roughly 3 days of
consistent logging, and a sturdier 30-per-side bar in about 11 days — fast,
because it's one keystroke, not a form section.
Useful because: ultimate economy is a real, distinct combat concept from
accuracy or damage, and nothing today captures it at all.
Misleading if: not normalized by match duration before comparing across
matches of different lengths — same trap `computePerformanceOutcome`
already avoids for damage/elims/final blows; do the same /10min treatment
here from the start.

## Imported — real signal, longest lead time

**10. Full scoreboard replay-code import (all 10 players, not just self)**
What it measures: everything the self-reported Aim Stats form captures
today, but for both teams — opens up relative performance ("did I actually
out-damage my lane" rather than "was my damage above my own average") and
enemy-comp-conditioned splits that self-only data can never answer.
Captured: imported — Overwatch's in-game replay-code/spectator tooling or
a third-party stats-tracking API would need to be wired up; this is new
infrastructure, not a schema addition.
Sample size: N/A until the import pipeline exists — this is a
build-a-pipeline-first suggestion, not a query-first one.
Useful because: it's the only item on this list that removes the
self-report ceiling every other metric here is built under.
Misleading if: treated as a quick win — flagging it last and lowest-
ranked on purpose; it's the correct long-term answer to "what's the enemy
team doing" but the most expensive thing on this list by a wide margin,
and nothing about it is mechanical.
