# Modularization plan — overwatch client/server

> **Superseded 2026-09-23, same day this was written.** Sean clarified
> that "modularize the app" meant the field registry in
> `projects/overwatch-analysis/modular-tracking-roadmap.md` (Branch A
> shaped for Branch B, decided 2026-09-22), not a hand-split of the big
> page files. **Slice 1 (below) stands** — the server-only stats.ts
> extraction is real and unaffected. **Slices 2–6 (Dashboard/LogMatch
> hand-splitting) are superseded**: the registry rebuilds those two files
> around one field/category list, and hand-splitting them first would
> mean cutting them twice. **`schema.ts` stays whole, permanently, not
> just deferred** — its ~40 migrations are order-dependent and a split's
> only payoff would have been line count, not any real seam. See the
> roadmap doc for what's actually being built instead.

Written 2026-09-23. Survey of `client/src` and `server/src`, ranked by line
count, with proposed seams and an execution order. Phase 2 of this task
executes only the first slice below; everything else is plan, not code.

## Ranked offenders

| Rank | File | Lines | Why it's a problem |
|---|---|---|---|
| 1 | `client/src/pages/SensAnalysis.tsx` | 2102 | One component: curve fitting, mini-chart grids, per-hero tables, tie detection, coverage panels. |
| 2 | `client/src/pages/SensLog.tsx` | 1979 | One component: hero-stat form, aim entry, blind-trial UI, curve params UI. |
| 3 | `client/src/pages/Prematch.tsx` | 1594 | One component: advisor call, hero/map picks, tilt nudge, rank drum. |
| 4 | `client/src/pages/LogMatch.tsx` | 1374 | One component: match form, death logger wiring, hero/map pickers, quality/driver/leaver judgment fields. |
| 5 | `client/src/pages/Dashboard.tsx` | 1289 | One component: career strip (done, `5d52b3e`), Mode/Match/Trends/Killer-Frequency section wrappers. |
| 6 | `server/src/routes/aim.ts` | 977 | One router file: per-hero aim upsert, validation, blind-trial credit wiring. |
| 7 | `server/src/routes/stats.ts` | 1087 | One router file: 19 route handlers + 6 pure compute functions used only by `/insights`. |
| 8 | `server/src/db/schema.ts` | 877 | Every migration ever written, linearly, never split by era. |
| 9 | `client/src/contexts/MatchContext.tsx` | 458 | Match CRUD context — large but single-purpose; lower priority. |
| 10 | `client/src/types/index.ts` | 445 | Type definitions only — size isn't a modularity problem here. |
| 11 | `server/src/routes/matches.ts` | 587 | INSERT/UPDATE/DELETE for matches + child tables; large but coherent. |
| 12 | `server/src/routes/advisor.ts` | 485 | LLM call + cache; coherent single concern. |

Files below ~450 lines aren't offenders — they're left alone.

## Per-file seams

**`server/src/routes/stats.ts` (1087 → target ~600 route + ~280 compute)**
Six pure functions (`computeHotHand`, `computePerformanceOutcome`,
`computeQueueSwitchTax`, `computeCritAccuracy`, `computeKillSecure`,
`computeDayHourWindow`) plus the `formatHour` helper and their `PERF_*`
types/constants take no `Request`/`Response` — they take a `db` handle and
return data. They're called only from the `/insights` route and are the
subject of `stats.test.ts`'s entire "Tier 2" suite. Destination:
`server/src/lib/statsInsights.ts`. **This is slice 1 (executed below).**

**`server/src/routes/aim.ts` (977 lines)**
Seam: the blind-trial credit-resolution logic (stage advance, scramble
check, reveal) is a distinct concern from the per-match/per-hero aim CRUD.
Split into `aim.routes.ts` (CRUD) and `lib/blindCredit.ts` (pure resolution
logic) — mirrors the stats.ts split. Needs its own survey before slicing;
not touched this session.

**`server/src/db/schema.ts` (877 lines)**
Seam: this is one big `migrate()` function applying ~40 sequential
`ALTER TABLE`/`CREATE TABLE` statements keyed by version checks. Splitting
by table (`schema/matches.ts`, `schema/aimStats.ts`, `schema/blind.ts`, …)
is possible but each migration is order-dependent and touches shared
version-tracking state — this one has real behavior-change risk if a split
reorders anything. Escalate before touching: this is the "broad blast
radius" case from the brief, not a pure move.

**`client/src/pages/Dashboard.tsx` (1289 lines as surveyed 2026-09-23; 1501
after the Career slice landed)**
**Correction, 2026-09-27:** the original version of this entry named a
by-hero card, a by-map card, a by-hour card, and a separate streaks block.
None of those ever existed in Dashboard.tsx — `git log -S byHour --
Dashboard.tsx` returns nothing. The streaks tiles were always part of the
Career strip, which is why they moved with it in the Career slice. The real
sections, by `id="sec-*"`, are: **Mode** (`sec-mode` — `ModeTile`,
`ModeComparisonCard`, `computeTrendsDerived`, and `RecentMatchesCard`, all
still defined inline in Dashboard.tsx; ~1314 of the file's current ~1501
lines, by far the biggest remaining seam), **Match** (`sec-match` — a thin
~17-line wrapper mounting the already-separate `Prematch`/`LogMatch`
pages), **Trends** (`sec-trends` — a thin ~4-line wrapper around the
already-separate `TrendsSummary` component), and **Killer Frequency**
(`sec-killer-frequency` — a thin ~5-line wrapper around the already-separate
`KillerFrequencyCard`, gated on the `deaths` field). **Career** (`sec-career`)
is done — extracted to `components/dashboard/CareerStrip.tsx` in `5d52b3e`.
Each remaining section becomes its own component under
`client/src/components/dashboard/`, taking its slice of already-fetched data
as props (no new fetches, no behavior change). Every one of these blocks
likely carries `data-inspect-id`s, so each slice needs the map sweep.
Sequence as separate slices, one section per slice, not one big move.

**`client/src/pages/LogMatch.tsx` (1374 lines)**
Seam candidates: the hero/map picker JSX, the death-logger wiring (already
mostly delegated to `DeathLogger.tsx`), and the three judgment fields
(`match_quality`, `result_driver`, `leaver`) as one `MatchJudgmentFields`
component. Same map-sweep cost as Dashboard, per slice.

**`client/src/pages/Prematch.tsx` (1594 lines) / `SensLog.tsx` (1979) /
`SensAnalysis.tsx` (2102)**
Not surveyed in seam-level detail this session — each is larger than
Dashboard or LogMatch and each carries `data-inspect-id`s throughout, so
each split multiplies the map-sweep cost. Recommend surveying these only
after the Dashboard/LogMatch sequence proves the per-slice pattern (size of
diff, map-sweep time, review burden) so the cost estimate for these three
is based on real numbers instead of a guess.

## Ordered slice sequence

1. **`stats.ts` → extract 6 pure compute functions + `formatHour` into
   `server/src/lib/statsInsights.ts`.** Server-only, zero `data-inspect-id`s
   touched (confirmed: the frontend map's 343 UI elements live entirely in
   `client/src/{App,components,contexts,hooks,lib,pages}` — no server file
   is in it). Fully covered by `stats.test.ts`. **Executed this session.**
2. Dashboard: extract the Career strip into its own component.
   **Executed** (`5d52b3e`, `components/dashboard/CareerStrip.tsx`).
3. Dashboard: extract the Trends section wrapper (`sec-trends`) into its
   own component. Thin — ~4 lines; `TrendsSummary` itself is already its
   own file.
4. Dashboard: extract the Mode section (`ModeTile`, `ModeComparisonCard`,
   `computeTrendsDerived`, `RecentMatchesCard`) into its own component(s).
   ~1314 lines — the real payoff of this plan; everything else left in
   Dashboard.tsx is thin wrapper markup around components already
   extracted elsewhere.
5. Dashboard: extract the Match section wrapper (`sec-match`) into its own
   component. ~17 lines.
6. Dashboard: extract the Killer Frequency section wrapper
   (`sec-killer-frequency`) into its own component. ~5 lines.
7. LogMatch: extract `MatchJudgmentFields` (quality/driver/leaver).
8. LogMatch: extract the hero/map picker JSX.
9. `aim.ts`: split CRUD from blind-credit resolution logic (needs its own
   design pass first — flagged above, not detailed here).
10. Re-survey Prematch/SensLog/SensAnalysis with real per-slice cost data
    from steps 2–6 in hand, then plan their splits.
11. `schema.ts` split — escalate to Sean before scoping; broad blast radius.

**Correction, 2026-09-27:** the by-hero/by-map/by-hour cards and separate
streaks block named in the original steps 3–4 never existed in
Dashboard.tsx — confirmed via `git log -S byHour -- Dashboard.tsx` (no
hits). Steps above reflect the file's real sections.

Each slice from 2 onward should land as its own commit, its own map sweep
(where client-side), and its own test-count check — never batched.

## Risks

- **The frontend map anchors on file + grep, not a stable id.** Moving JSX
  from a page file into a new component file changes the `path` field on
  every `uiElements[].locate` entry that JSX contains, not just the line
  number the existing drift-sweep already handles. The session-end map
  sweep (step 5 of that skill) re-greps and re-points line numbers, but a
  changed *file* is a bigger edit per entry — budget roughly one map commit
  per client-side slice, same as any other UI-touching commit, but expect
  more entries to touch per slice than a same-file change would produce.
- **Server-side slices (stats.ts, aim.ts) carry no map risk at all** — the
  map only covers client UI. This is why slice 1 was chosen first: it is
  the only offender in the top ranks with zero map exposure.
- **schema.ts's migrations are order-dependent** on `PRAGMA user_version`
  checks threaded through the file. A split that looks like a pure move
  could silently change apply order on a fresh DB. Do not attempt without
  Sean's sign-off on the approach.
- **Prematch/SensLog/SensAnalysis are unsurveyed at seam level.** Don't
  assume they split as cleanly as Dashboard/LogMatch until someone reads
  them closely — they're bigger and this session didn't open them.
