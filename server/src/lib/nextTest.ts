// "Next test" recommender — sens-study category. Pure decision logic only;
// no DB access lives in this file. routes/blind.ts's GET /api/blind/next
// gathers the inputs below from blind_stage_sets/blind_credits/matches and
// hands them to computeNextTest, which is the part that's actually worth
// unit-testing in isolation (round-robin ordering, the block math, the cold
// guard) without spinning up a database for every case.
//
// The three rules this implements (Sean's decision, 2026-09-23; converted
// from a game-counted "stint" to a minutes-counted "block" 2026-09-27):
//   1. Pick the least-progressed hero first (progress = both stages' credits
//      summed, now in closed blocks rather than games), tie-broken by
//      longest since last played. The #1 hero's role is what the card tells
//      Sean to queue.
//   2. A "block" is 60 minutes of play on one hero (lib/blind.ts's
//      BLOCK_MINUTES/deriveBlockState — that file is the source of truth for
//      the unit and its rationale, since the ABBA schedule needs the exact
//      same clock). The recommendation only recomputes once that block
//      closes — mid-block, the card just says stay put, showing minutes
//      played toward 60 rather than a game count. Unlike the old
//      fixed-5-games stint, an interrupted block (switch away, come back)
//      resumes where it left off instead of resetting — see BlockInfo below.
//   3. A hero unplayed 7+ days is "going cold" and jumps to the top of its
//      OWN role's list (not the cross-role pick above) the next time the
//      card recomputes.

// A chunk (ABBA's alternation unit) is 2 blocks, so a block is exactly half
// a chunk — the sens only ever changes at the START of a block-pair, never
// partway through one, since block boundaries land on chunk midpoints/
// edges, not mid-chunk. This is a play-experience choice, not a statistical
// one: across 905 matches, the first game on a hero each day scored -0.27
// accuracy points versus later same-day games on the same hero (SE 0.46) —
// indistinguishable from zero. Switching heroes carries no measurable
// warm-up cost in this data. Do not shrink BLOCK_MINUTES to "optimize" this
// — there is nothing here to optimize; it exists purely so a session
// doesn't feel like hero roulette. See lib/blind.ts's BLOCK_MINUTES comment
// for the full rationale (shared verbatim with the ABBA schedule, since it's
// the same clock).

// A hero unplayed this many days or more (measured from its last
// test-credited match) is "going cold."
export const COLD_DAYS = 7;

export interface HeroTestProgress {
  hero: string;
  role: string;
  credited: number;       // closed blocks this phase, both stages summed
  target: number;          // STAGE_BLOCKS * n_stages for this hero's set (chunked); legacy sets stay in games
  daysSinceLastPlayed: number | null; // null = never test-played this set
  completed: boolean;
}

// The most recently test-credited match's primary hero (matches.hero, the
// hero actually queued as — a mid-match switch credits a set too, but the
// block belongs to whoever Sean queued as, not whoever he ended up playing),
// plus that hero's OWN currently open (unclosed) block, in minutes — see
// lib/blind.ts's deriveBlockState, which this is built from directly. Unlike
// the old game-counted "stint," this does NOT reset on an interruption: play
// Ana 30 minutes, switch to Kiriko, come back to Ana later, and Ana's block
// resumes at 30/60 rather than restarting at 0 (Sean's decision, 2026-09-27
// — see the task's frozen spec item 3). A caller with no test-credited
// matches at all passes null instead of a BlockInfo.
export interface BlockInfo {
  hero: string;
  openMinutes: number;
}

export interface OrderedHero extends HeroTestProgress {
  cold: boolean;
}

export interface NextTestRecommendation {
  allFinished: boolean;
  finishedHeroes: string[];
  // Set only when the card should show "Stay on X — 34/60 min" without
  // recomputing anything else. null means a full recompute happened —
  // either there was no open block, or the open block just closed.
  block: { hero: string; role: string; openMinutes: number } | null;
  recommendedRole: string | null;
  // Ordered within recommendedRole only, cold heroes first. Empty while
  // `block` is set (mid-block means the card doesn't recompute this list)
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
  block: BlockInfo | null,
): NextTestRecommendation {
  const finishedHeroes = heroes.filter(h => h.completed).map(h => h.hero);
  const pending = heroes.filter(h => !h.completed);

  if (pending.length === 0) {
    return { allFinished: true, finishedHeroes, block: null, recommendedRole: null, orderedHeroes: [] };
  }

  if (block && block.openMinutes > 0) {
    // Looked up in `pending`, not the full roster: an open block on a hero
    // whose test has SINCE completed (its last few credited games finished
    // it mid-block) has nothing left to "stay" on — fall through to a full
    // recompute exactly as if the hero weren't tracked at all.
    const blockHero = pending.find(h => h.hero === block.hero);
    // Mid-block (openMinutes > 0): stay put, don't recompute. At the
    // boundary (openMinutes === 0 — the block just closed, or nothing has
    // been played yet), a completed hero, or an unrecognized one (e.g. a
    // set that's since been deleted): fall through to a full recompute
    // below.
    if (blockHero) {
      return {
        allFinished: false, finishedHeroes,
        block: { hero: blockHero.hero, role: blockHero.role, openMinutes: block.openMinutes },
        recommendedRole: blockHero.role, orderedHeroes: [],
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

  return { allFinished: false, finishedHeroes, block: null, recommendedRole, orderedHeroes };
}
