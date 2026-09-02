"""One-off backfill for match_heroes.sens on switch-hero (slot 2/3) rows that
predate the per-hero sens column (see schema.ts's comment on that column).

Those rows never had their own recorded sens — the app only ever wrote one
sens value per match, keyed to the primary/slot-1 hero's active stage-test.
Since Overwatch's in-game sensitivity is a genuinely independent per-hero
setting, that value is wrong for whichever hero was actually switched to.

This reconstructs the missing value from the timeline instead of guessing:
for each switch-hero appearance, it looks at that same hero's OTHER matches
where it credited toward an active stage-test (blind_credits — a real,
recorded sens), and finds the nearest such credit before and after in time.
If both sides agree on the same (set, stage), the sens is unambiguous and
gets backfilled. If they disagree (the appearance straddles a stage
transition) or one side is missing (no bracket), the row is left NULL —
never fabricated.

Run once: `python3 scripts/backfill-hero-sens.py`. Idempotent (only touches
rows where sens IS NULL), but not expected to find new work after the first
run since match_heroes.sens is written directly by the app from here on.
"""
import sqlite3
import os

DB_PATH = os.path.join(os.path.dirname(__file__), '..', 'data', 'overwatch.db')

con = sqlite3.connect(DB_PATH)
con.row_factory = sqlite3.Row
cur = con.cursor()

targets = cur.execute("""
    SELECT mh.match_id, mh.hero, mh.slot, m.time
    FROM match_heroes mh
    JOIN matches m ON m.id = mh.match_id
    WHERE mh.slot > 1 AND mh.sens IS NULL
    ORDER BY m.time
""").fetchall()

credits = cur.execute("""
    SELECT bc.hero, m.time, bc.blind_set_id, bc.stage_index, bs.sens
    FROM blind_credits bc
    JOIN matches m ON m.id = bc.match_id
    JOIN blind_stages bs ON bs.set_id = bc.blind_set_id AND bs.stage_index = bc.stage_index
    ORDER BY m.time
""").fetchall()

from collections import defaultdict
by_hero = defaultdict(list)
for c in credits:
    by_hero[c['hero']].append((c['time'], c['blind_set_id'], c['stage_index'], c['sens']))

backfilled, ambiguous, no_bracket, no_sens_value = 0, 0, 0, 0
for r in targets:
    lst = by_hero.get(r['hero'], [])
    before = [x for x in lst if x[0] <= r['time']]
    after = [x for x in lst if x[0] >= r['time']]
    b = before[-1] if before else None
    a = after[0] if after else None
    if not (b and a):
        no_bracket += 1
        continue
    if (b[1], b[2]) != (a[1], a[2]):
        ambiguous += 1
        continue
    sens = b[3]
    if sens is None:
        no_sens_value += 1
        continue
    cur.execute(
        'UPDATE match_heroes SET sens = ? WHERE match_id = ? AND slot = ?',
        (sens, r['match_id'], r['slot']),
    )
    backfilled += 1

con.commit()
print(f"backfilled: {backfilled}")
print(f"ambiguous (straddles a stage transition, left NULL): {ambiguous}")
print(f"no bracket (no credited appearance on one/both sides, left NULL): {no_bracket}")
print(f"bracketed but stage had no explicit sens value, left NULL: {no_sens_value}")
con.close()
