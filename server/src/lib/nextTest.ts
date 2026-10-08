// "Next test" recommender — sens-study category. Pure decision logic only;
// no DB access lives in this file. routes/blind.ts's GET /api/blind/next
// gathers the inputs below from blind_stage_sets/blind_credits/matches and
// the role clocks, and hands them to computeNextTest.
//
// The rule (Sean, 2026-10-08):
//   1. Hero pick = the pending (not completed) test hero of a role with the
//      least playedMinutes (missing counts as 0). Ties: cold first, then
//      fewer credited, then longest since last played, then name. That is
//      compareTestHeroes, the one comparator. The Next Test list on the
//      Prematch page shows the same order (each hero carries its `rank`), so
//      the list's top row and the glow always agree.
//   2. Keep the block lock (Sean, 2026-10-08). If the last test hero has an
//      open 60-minute block (openMinutes > 0, lib/blind.ts deriveBlockState)
//      and is still pending, it stays the pick until the block closes. The
//      least-minutes pick of item 1 applies only when no block is open. The
//      role flip (item 3) wins over an open block: if the queued role is not
//      the block hero's role, the block is not held and the least-minutes
//      hero of the queued role is picked (the block resumes later, because
//      blocks resume).
//   3. Role queue (comp_role): one pick, from `queueRole`. The route works
//      out queueRole from the role clocks (lib/roleTimer.ts): the role of the
//      newest comp role-queue match, flipped to the other of DPS/Support when
//      that match crossed 240 minutes; with no comp match yet, the role with
//      the lower clock. Open queue (comp_open): no single role, so one pick
//      per role (DPS and Support), both glow. An open block holds its
//      hero's slot; the other role takes its least-minutes hero. Quick Play: no pick (the route
//      never calls this function for it).

// A hero unplayed this many days or more (measured from its last
// test-credited match) is "going cold."
export const COLD_DAYS = 7;

export interface HeroTestProgress {
  hero: string;
  role: string;
  credited: number;       // closed blocks this phase, both stages summed
  target: number;          // STAGE_BLOCKS * n_stages for this hero's set (chunked); legacy sets stay in games
  // Minutes played / minutes planned for a chunked set; absent for a legacy set.
  playedMinutes?: number;
  targetMinutes?: number;
  daysSinceLastPlayed: number | null; // null = never test-played this set
  completed: boolean;
}

// The most recently test-credited match's primary hero (matches.hero) and
// that hero's own open (unclosed) block in minutes (lib/blind.ts
// deriveBlockState). null when no test-credited match exists.
export interface BlockInfo {
  hero: string;
  openMinutes: number;
}

export type QueueRole = 'DPS' | 'Support';

export interface TestPick { hero: string; role: string }

export interface NextTestRecommendation {
  allFinished: boolean;
  finishedHeroes: string[];
  // Set only when an open block holds its hero as the pick ("stay put").
  block: { hero: string; role: string; openMinutes: number } | null;
  // Role queue: the role to queue. Open queue: null (no single role).
  recommendedRole: string | null;
  // Role queue: 1 pick. Open queue: up to 2 (least-minutes DPS, least-minutes
  // Support). Empty when every hero is finished.
  picks: TestPick[];
}

const isCold = (h: HeroTestProgress) => h.daysSinceLastPlayed != null && h.daysSinceLastPlayed >= COLD_DAYS;

// The one comparator: least minutes played first. Ties: cold, fewer credited,
// longest since last played (never played = longest), then name.
export function compareTestHeroes(a: HeroTestProgress, b: HeroTestProgress): number {
  return (a.playedMinutes ?? 0) - (b.playedMinutes ?? 0)
    || Number(isCold(b)) - Number(isCold(a))
    || a.credited - b.credited
    || (b.daysSinceLastPlayed ?? Infinity) - (a.daysSinceLastPlayed ?? Infinity)
    || a.hero.localeCompare(b.hero);
}

// Tags every hero with `cold` and, for pending heroes, its `rank` (0 = best
// pick, over all roles). The Next Test list sorts by this rank.
export function annotateHeroes(heroes: HeroTestProgress[]): (HeroTestProgress & { cold: boolean; rank: number | null })[] {
  const order = heroes.filter(h => !h.completed).sort(compareTestHeroes).map(h => h.hero);
  return heroes.map(h => ({ ...h, cold: isCold(h), rank: h.completed ? null : order.indexOf(h.hero) }));
}

export interface PhaseProjection {
  // 'min' for a phase whose sets all run on the 60-minute block clock, else 'games'.
  unit: 'min' | 'games';
  ratePerDay: number;
  projectedDays: number | null; // null when the trailing rate is 0 — no basis to project from
}

// Trailing-14-day rate is deliberately not calendar-precise (it counts
// credited games "in the last N days," not "so far this week") — it's a
// projection, not a scoreboard, and this endpoint's caller labels it as one
// explicitly rather than presenting it as a promise.
export function projectPhaseFinish(remaining: number, inWindow: number, windowDays: number, unit: 'min' | 'games' = 'games'): PhaseProjection {
  const ratePerDay = windowDays > 0 ? inWindow / windowDays : 0;
  return { unit, ratePerDay, projectedDays: ratePerDay > 0 ? remaining / ratePerDay : null };
}

// What the projection counts. A phase is in minutes only when every hero's set is
// chunked (has targetMinutes); a legacy or mixed phase keeps counting games, so the
// remaining figure and the trailing-rate figure always share one unit.
export function projectionBasis(heroes: HeroTestProgress[]): { unit: 'min' | 'games'; remaining: number } {
  const minutes = heroes.length > 0 && heroes.every(h => h.targetMinutes != null);
  const remaining = heroes.reduce((sum, h) => sum + (minutes
    ? Math.max(0, (h.targetMinutes ?? 0) - (h.playedMinutes ?? 0))
    : Math.max(0, h.target - h.credited)), 0);
  return { unit: minutes ? 'min' : 'games', remaining };
}

const bestOfRole = (pending: HeroTestProgress[], role: string): TestPick | null => {
  const top = pending.filter(h => h.role === role).sort(compareTestHeroes)[0];
  return top ? { hero: top.hero, role: top.role } : null;
};

export function computeNextTest(
  heroes: HeroTestProgress[],
  mode: { openQueue: boolean; queueRole: QueueRole },
  block: BlockInfo | null,
): NextTestRecommendation {
  const finishedHeroes = heroes.filter(h => h.completed).map(h => h.hero);
  const pending = heroes.filter(h => !h.completed);

  if (pending.length === 0) {
    return { allFinished: true, finishedHeroes, block: null, recommendedRole: null, picks: [] };
  }

  // A block holds its hero only while the hero is still pending (a hero whose
  // test finished mid-block has nothing to stay on) and is a DPS/Support hero.
  const held = block && block.openMinutes > 0
    ? pending.find(h => h.hero === block.hero && (h.role === 'DPS' || h.role === 'Support')) ?? null
    : null;
  const heldInfo = (h: HeroTestProgress) => ({ hero: h.hero, role: h.role, openMinutes: block!.openMinutes });

  if (mode.openQueue) {
    const picks = (['DPS', 'Support'] as const)
      .map(r => (held && held.role === r) ? { hero: held.hero, role: held.role } : bestOfRole(pending, r))
      .filter((p): p is TestPick => p !== null);
    if (picks.length === 0) picks.push(...[[...pending].sort(compareTestHeroes)[0]].map(h => ({ hero: h.hero, role: h.role })));
    return { allFinished: false, finishedHeroes, block: held ? heldInfo(held) : null, recommendedRole: null, picks };
  }

  // Role queue. The role flip wins over an open block: the block holds only
  // when its hero is in the queued role.
  if (held && held.role === mode.queueRole) {
    return { allFinished: false, finishedHeroes, block: heldInfo(held), recommendedRole: held.role, picks: [{ hero: held.hero, role: held.role }] };
  }
  // If the wanted role has nothing pending, use the other role rather than
  // recommend a hero that is already done.
  const other: QueueRole = mode.queueRole === 'DPS' ? 'Support' : 'DPS';
  const pick = bestOfRole(pending, mode.queueRole) ?? bestOfRole(pending, other)
    ?? (() => { const h = [...pending].sort(compareTestHeroes)[0]; return { hero: h.hero, role: h.role }; })();
  return { allFinished: false, finishedHeroes, block: null, recommendedRole: pick.role, picks: [pick] };
}

// Which of DPS/Support to queue, from the role clocks. `lastRoleQueue` is the
// newest comp role-queue match (replayRoleTimers); `clocks` the DPS/Support
// clock totals. Pure, so the route only gathers inputs.
export function pickQueueRole(
  lastRoleQueue: { role: string; resetRoles: string[] } | null,
  clocks: { DPS: number; Support: number },
): QueueRole {
  if (lastRoleQueue && (lastRoleQueue.role === 'DPS' || lastRoleQueue.role === 'Support')) {
    const r = lastRoleQueue.role as QueueRole;
    return lastRoleQueue.resetRoles.includes(r) ? (r === 'DPS' ? 'Support' : 'DPS') : r;
  }
  return clocks.Support < clocks.DPS ? 'Support' : 'DPS';
}
