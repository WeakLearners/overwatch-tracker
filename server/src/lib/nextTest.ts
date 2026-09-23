// "Next test" recommender — sens-study category. Pure decision logic only;
// no DB access lives in this file. routes/blind.ts's GET /api/blind/next
// gathers the inputs below from blind_stage_sets/blind_credits/matches and
// hands them to computeNextTest, which is the part that's actually worth
// unit-testing in isolation (round-robin ordering, the stint math, the cold
// guard) without spinning up a database for every case.
//
// The three rules this implements (Sean's decision, 2026-09-23):
//   1. Pick the least-progressed hero first (progress = both stages' credits
//      summed), tie-broken by longest since last played. The #1 hero's role
//      is what the card tells Sean to queue.
//   2. A "stint" is 5 consecutive test-credited matches on one hero. The
//      recommendation only recomputes at a stint boundary — mid-stint, the
//      card just says stay put. See STINT_LENGTH below for why 5 specifically.
//   3. A hero unplayed 7+ days is "going cold" and jumps to the top of its
//      OWN role's list (not the cross-role pick above) the next time the
//      card recomputes.

// Stint length: 5 consecutive test-credited matches on one hero before the
// recommender is willing to suggest switching. A chunk (ABBA's alternation
// unit, lib/blind.ts) is 10 matches, so 5 is exactly half a chunk — the sens
// only ever changes at the START of a stint, never partway through it, since
// stint boundaries land on chunk midpoints/edges, not mid-chunk.
//
// This is a play-experience choice, not a statistical one. Across 905
// matches, the first game on a hero each day scores -0.27 accuracy points
// versus later same-day games on the same hero (SE 0.46) — indistinguishable
// from zero. Switching heroes carries no measurable warm-up cost in this
// data. At Sean's observed pace (~7.5 test matches/day), all 8 live heroes
// getting 5 games each cycles back to any one hero in ~5.3 days (8 heroes x
// 5 games / 7.5 games/day) — comfortably inside the 7-day cold guard below,
// so round-robin switching this often doesn't even risk anyone going cold
// under normal play. Do not shorten the stint to "optimize" it — there is
// nothing here to optimize; it exists purely so a session doesn't feel like
// hero roulette.
export const STINT_LENGTH = 5;

// A hero unplayed this many days or more (measured from its last
// test-credited match) is "going cold."
export const COLD_DAYS = 7;

export interface HeroTestProgress {
  hero: string;
  role: string;
  credited: number;       // test credits this phase, both stages summed
  target: number;          // batch_size * n_stages for this hero's set
  daysSinceLastPlayed: number | null; // null = never test-played this set
  completed: boolean;
}

// The tail of the match log, restricted to test-credited matches on their
// primary hero (matches.hero, the hero actually queued as — a mid-match
// switch credits a set too, but the stint belongs to whoever Sean queued
// as, not whoever he ended up playing). count is how many of the most
// recent test-credited matches in a row share `hero`. A caller with no
// test-credited matches at all, or whose most recent one doesn't belong to
// any currently-tracked hero, passes null instead of a StintInfo.
export interface StintInfo {
  hero: string;
  count: number;
}

export interface OrderedHero extends HeroTestProgress {
  cold: boolean;
}

export interface NextTestRecommendation {
  allFinished: boolean;
  finishedHeroes: string[];
  // Set only when the card should show "Stay on X — n of 5" without
  // recomputing anything else. null means a full recompute happened —
  // either there was no active stint, or the stint just hit its boundary.
  stint: { hero: string; role: string; position: number; length: number } | null;
  recommendedRole: string | null;
  // Ordered within recommendedRole only, cold heroes first. Empty while
  // `stint` is set (mid-stint means the card doesn't recompute this list)
  // or once every hero is finished.
  orderedHeroes: OrderedHero[];
}

export interface PhaseProjection {
  ratePerDay: number;
  projectedDays: number | null; // null when the trailing rate is 0 — no basis to project from
}

// Trailing-14-day rate is deliberately not calendar-precise (it counts
// credited games "in the last N days," not "so far this week") — it's a
// projection, not a scoreboard, and this endpoint's caller labels it as one
// explicitly rather than presenting it as a promise.
export function projectPhaseFinish(remaining: number, gamesInWindow: number, windowDays: number): PhaseProjection {
  const ratePerDay = windowDays > 0 ? gamesInWindow / windowDays : 0;
  return { ratePerDay, projectedDays: ratePerDay > 0 ? remaining / ratePerDay : null };
}

export function computeNextTest(
  heroes: HeroTestProgress[],
  stint: StintInfo | null,
): NextTestRecommendation {
  const finishedHeroes = heroes.filter(h => h.completed).map(h => h.hero);
  const pending = heroes.filter(h => !h.completed);

  if (pending.length === 0) {
    return { allFinished: true, finishedHeroes, stint: null, recommendedRole: null, orderedHeroes: [] };
  }

  if (stint) {
    const position = ((stint.count - 1) % STINT_LENGTH) + 1;
    // Looked up in `pending`, not the full roster: a stint on a hero whose
    // test has SINCE completed (its last few credited games finished it
    // mid-stint) has nothing left to "stay" on — fall through to a full
    // recompute exactly as if the hero weren't tracked at all.
    const stintHero = pending.find(h => h.hero === stint.hero);
    // Mid-stint (position 1..STINT_LENGTH-1): stay put, don't recompute.
    // At the boundary (position === STINT_LENGTH), a completed hero, or an
    // unrecognized one (e.g. a set that's since been deleted): fall through
    // to a full recompute below.
    if (stintHero && position < STINT_LENGTH) {
      return {
        allFinished: false, finishedHeroes,
        stint: { hero: stintHero.hero, role: stintHero.role, position, length: STINT_LENGTH },
        recommendedRole: stintHero.role, orderedHeroes: [],
      };
    }
  }

  // Rule 1: least-progressed first, tie broken by longest since last played.
  // Never-played (null) sorts as "longest since" — it's more overdue than
  // any hero with an actual last-played date, not less.
  const dayKey = (h: HeroTestProgress) => h.daysSinceLastPlayed ?? Infinity;
  const ranked = [...pending].sort((a, b) => a.credited - b.credited || dayKey(b) - dayKey(a));
  const recommendedRole = ranked[0].role;

  // Rule 3: within that role only, a cold hero (unplayed COLD_DAYS+) jumps
  // to the top, ahead of the round-robin order. Ties within "cold" and
  // within "not cold" both fall back to the same progress/last-played sort
  // as the cross-role pick above.
  const isCold = (h: HeroTestProgress) => h.daysSinceLastPlayed != null && h.daysSinceLastPlayed >= COLD_DAYS;
  const orderedHeroes: OrderedHero[] = pending
    .filter(h => h.role === recommendedRole)
    .sort((a, b) => {
      const coldDiff = Number(isCold(b)) - Number(isCold(a));
      if (coldDiff !== 0) return coldDiff;
      return a.credited - b.credited || dayKey(b) - dayKey(a);
    })
    .map(h => ({ ...h, cold: isCold(h) }));

  return { allFinished: false, finishedHeroes, stint: null, recommendedRole, orderedHeroes };
}
