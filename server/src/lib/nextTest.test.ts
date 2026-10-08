// Pure-function tests for lib/nextTest.ts — no DB. See
// routes/blind.next.test.ts for the DB-integration layer (gathering
// HeroTestProgress and the role clocks from real tables).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeNextTest, pickQueueRole, annotateHeroes, compareTestHeroes, projectPhaseFinish, projectionBasis, COLD_DAYS, type HeroTestProgress, type BlockInfo } from './nextTest';

function hero(overrides: Partial<HeroTestProgress> & { hero: string; role: string }): HeroTestProgress {
  return { credited: 0, target: 80, daysSinceLastPlayed: null, completed: false, ...overrides };
}

const ROSTER: HeroTestProgress[] = [
  hero({ hero: 'Sojourn', role: 'DPS', playedMinutes: 400, daysSinceLastPlayed: 2 }),
  hero({ hero: 'Tracer', role: 'DPS', playedMinutes: 100, daysSinceLastPlayed: 1 }),
  hero({ hero: 'Pharah', role: 'DPS', playedMinutes: 200, daysSinceLastPlayed: 3 }),
  hero({ hero: 'Ana', role: 'Support', playedMinutes: 150, daysSinceLastPlayed: 5 }),
  hero({ hero: 'Juno', role: 'Support', playedMinutes: 90, daysSinceLastPlayed: 1 }),
  hero({ hero: 'Zenyatta', role: 'Support', playedMinutes: 500, daysSinceLastPlayed: 0 }),
];
const ROLE = (queueRole: 'DPS' | 'Support') => ({ openQueue: false, queueRole });
const OPEN = { openQueue: true, queueRole: 'DPS' as const };

describe('computeNextTest — role queue', () => {
  test('least minutes played wins within the queued role', () => {
    const r = computeNextTest(ROSTER, ROLE('DPS'), null);
    assert.deepEqual(r.picks, [{ hero: 'Tracer', role: 'DPS' }]);
    assert.equal(r.recommendedRole, 'DPS');
    assert.deepEqual(computeNextTest(ROSTER, ROLE('Support'), null).picks, [{ hero: 'Juno', role: 'Support' }]);
  });

  test('the queued role is used even when the other role has the global minimum', () => {
    const r = computeNextTest(ROSTER, ROLE('DPS'), null); // Juno (90) is the global minimum
    assert.equal(r.picks[0].hero, 'Tracer');
  });

  test('missing playedMinutes counts as 0', () => {
    const roster = [hero({ hero: 'Tracer', role: 'DPS', playedMinutes: 50 }), hero({ hero: 'Pharah', role: 'DPS' })];
    assert.equal(computeNextTest(roster, ROLE('DPS'), null).picks[0].hero, 'Pharah');
  });

  test('a completed hero is skipped and reported as finished', () => {
    const roster = ROSTER.map(h => h.hero === 'Tracer' ? { ...h, completed: true } : h);
    const r = computeNextTest(roster, ROLE('DPS'), null);
    assert.equal(r.picks[0].hero, 'Pharah');
    assert.deepEqual(r.finishedHeroes, ['Tracer']);
  });

  test('a queued role with nothing pending falls back to the other role', () => {
    const roster = ROSTER.map(h => h.role === 'DPS' ? { ...h, completed: true } : h);
    const r = computeNextTest(roster, ROLE('DPS'), null);
    assert.deepEqual(r.picks, [{ hero: 'Juno', role: 'Support' }]);
    assert.equal(r.recommendedRole, 'Support');
  });

  test('every hero finished reports allFinished with no picks', () => {
    const r = computeNextTest(ROSTER.map(h => ({ ...h, completed: true })), ROLE('DPS'), null);
    assert.equal(r.allFinished, true);
    assert.deepEqual(r.picks, []);
    assert.equal(r.recommendedRole, null);
  });

});

describe('computeNextTest — block lock', () => {
  const roster = [
    hero({ hero: 'Pharah', role: 'DPS', playedMinutes: 130, credited: 2 }),
    hero({ hero: 'Tracer', role: 'DPS', playedMinutes: 100, credited: 1 }),
    hero({ hero: 'Ana', role: 'Support', playedMinutes: 20 }),
    hero({ hero: 'Juno', role: 'Support', playedMinutes: 70 }),
  ];
  const mid = (h: string, openMinutes: number): BlockInfo => ({ hero: h, openMinutes });

  test('a mid-block hero is held even when another has fewer minutes', () => {
    const r = computeNextTest(roster, ROLE('DPS'), mid('Pharah', 10));
    assert.deepEqual(r.picks, [{ hero: 'Pharah', role: 'DPS' }]);
    assert.deepEqual(r.block, { hero: 'Pharah', role: 'DPS', openMinutes: 10 });
  });

  test('a block close (0 open minutes) recomputes by least minutes', () => {
    const r = computeNextTest(roster, ROLE('DPS'), mid('Pharah', 0));
    assert.deepEqual(r.picks, [{ hero: 'Tracer', role: 'DPS' }]);
    assert.equal(r.block, null);
  });

  test('a role flip overrides an open block', () => {
    const r = computeNextTest(roster, ROLE('Support'), mid('Pharah', 10));
    assert.deepEqual(r.picks, [{ hero: 'Ana', role: 'Support' }]);
    assert.equal(r.block, null);
  });

  test('a block on a completed hero is not held', () => {
    const r = computeNextTest(roster.map(h => h.hero === 'Pharah' ? { ...h, completed: true } : h), ROLE('DPS'), mid('Pharah', 10));
    assert.equal(r.picks[0].hero, 'Tracer');
    assert.equal(r.block, null);
  });

  test('open queue with one open block: the block hero holds its role, the other role takes least minutes', () => {
    const r = computeNextTest(roster, OPEN, mid('Pharah', 10));
    assert.deepEqual(r.picks, [{ hero: 'Pharah', role: 'DPS' }, { hero: 'Ana', role: 'Support' }]);
    assert.equal(r.block?.hero, 'Pharah');
    const r2 = computeNextTest(roster, OPEN, mid('Juno', 10));
    assert.deepEqual(r2.picks, [{ hero: 'Tracer', role: 'DPS' }, { hero: 'Juno', role: 'Support' }]);
  });
});

describe('computeNextTest — open queue', () => {
  test('returns the least-minutes DPS and the least-minutes Support, no single role', () => {
    const r = computeNextTest(ROSTER, OPEN, null);
    assert.deepEqual(r.picks, [{ hero: 'Tracer', role: 'DPS' }, { hero: 'Juno', role: 'Support' }]);
    assert.equal(r.recommendedRole, null);
  });

  test('a role with every hero done contributes no pick', () => {
    const roster = ROSTER.map(h => h.role === 'Support' ? { ...h, completed: true } : h);
    assert.deepEqual(computeNextTest(roster, OPEN, null).picks, [{ hero: 'Tracer', role: 'DPS' }]);
  });
});

describe('compareTestHeroes — ties', () => {
  const t = (over: Partial<HeroTestProgress> & { hero: string }) => hero({ role: 'DPS', playedMinutes: 60, ...over });
  const order = (hs: HeroTestProgress[]) => [...hs].sort(compareTestHeroes).map(h => h.hero);

  test('equal minutes: cold first', () => {
    assert.deepEqual(order([t({ hero: 'A', daysSinceLastPlayed: 1 }), t({ hero: 'B', daysSinceLastPlayed: COLD_DAYS })]), ['B', 'A']);
  });
  test('equal minutes, equal cold: fewer credited first', () => {
    assert.deepEqual(order([t({ hero: 'A', credited: 3 }), t({ hero: 'B', credited: 1 })]), ['B', 'A']);
  });
  test('then longest since last played, never played counts longest', () => {
    assert.deepEqual(order([t({ hero: 'A', daysSinceLastPlayed: 2 }), t({ hero: 'B', daysSinceLastPlayed: 5 })]), ['B', 'A']);
    assert.deepEqual(order([t({ hero: 'A', daysSinceLastPlayed: 2 }), t({ hero: 'B', daysSinceLastPlayed: null })]), ['B', 'A']);
  });
  test('then name', () => {
    assert.deepEqual(order([t({ hero: 'Zed' }), t({ hero: 'Abe' })]), ['Abe', 'Zed']);
  });
  test('minutes outrank cold', () => {
    assert.deepEqual(order([t({ hero: 'A', playedMinutes: 10, daysSinceLastPlayed: 1 }), t({ hero: 'B', playedMinutes: 20, daysSinceLastPlayed: 30 })]), ['A', 'B']);
  });
});

describe('annotateHeroes', () => {
  test('rank 0 is the global best pick, completed heroes have no rank, cold is flagged', () => {
    const roster = [
      hero({ hero: 'A', role: 'DPS', playedMinutes: 50, daysSinceLastPlayed: COLD_DAYS }),
      hero({ hero: 'B', role: 'Support', playedMinutes: 10 }),
      hero({ hero: 'C', role: 'DPS', playedMinutes: 5, completed: true }),
    ];
    const a = annotateHeroes(roster);
    assert.deepEqual(a.map(h => [h.hero, h.rank, h.cold]), [['A', 1, true], ['B', 0, false], ['C', null, false]]);
  });
});

describe('pickQueueRole', () => {
  test('stays on the role of the newest comp role-queue match', () => {
    assert.equal(pickQueueRole({ role: 'Support', resetRoles: [] }, { DPS: 10, Support: 200 }), 'Support');
    assert.equal(pickQueueRole({ role: 'DPS', resetRoles: [] }, { DPS: 200, Support: 10 }), 'DPS');
  });
  test('flips to the other role when that match crossed 240', () => {
    assert.equal(pickQueueRole({ role: 'DPS', resetRoles: ['DPS'] }, { DPS: 0, Support: 100 }), 'Support');
    assert.equal(pickQueueRole({ role: 'Support', resetRoles: ['Support'] }, { DPS: 100, Support: 0 }), 'DPS');
  });
  test('a reset of a different role does not flip', () => {
    assert.equal(pickQueueRole({ role: 'DPS', resetRoles: ['Support'] }, { DPS: 50, Support: 0 }), 'DPS');
  });
  test('no comp match yet: the lower clock, DPS on a tie', () => {
    assert.equal(pickQueueRole(null, { DPS: 30, Support: 10 }), 'Support');
    assert.equal(pickQueueRole(null, { DPS: 10, Support: 30 }), 'DPS');
    assert.equal(pickQueueRole(null, { DPS: 0, Support: 0 }), 'DPS');
  });
  test('a Tank role-queue match falls back to the lower DPS/Support clock', () => {
    assert.equal(pickQueueRole({ role: 'Tank', resetRoles: [] }, { DPS: 30, Support: 10 }), 'Support');
  });
});

describe('projectPhaseFinish', () => {
  test('projects days remaining from a trailing rate', () => {
    const p = projectPhaseFinish(105, 21, 14); // 1.5 games/day, 105 left -> 70 days
    assert.equal(p.ratePerDay, 1.5);
    assert.equal(p.projectedDays, 70);
  });

  test('a zero trailing rate has no basis to project from', () => {
    const p = projectPhaseFinish(80, 0, 14);
    assert.equal(p.ratePerDay, 0);
    assert.equal(p.projectedDays, null);
  });

  test('nothing remaining projects to 0 days at a positive rate', () => {
    const p = projectPhaseFinish(0, 10, 14);
    assert.equal(p.projectedDays, 0);
  });

  test('defaults to games and carries a minutes unit through', () => {
    assert.equal(projectPhaseFinish(10, 5, 5).unit, 'games');
    const p = projectPhaseFinish(1800, 630, 14, 'min'); // 45 min/day, 1800 left -> 40 days
    assert.equal(p.unit, 'min');
    assert.equal(p.ratePerDay, 45);
    assert.equal(p.projectedDays, 40);
  });
});

describe('projectionBasis', () => {
  test('an all-chunked phase counts remaining minutes', () => {
    const b = projectionBasis([
      hero({ hero: 'A', role: 'DPS', credited: 1, target: 16, playedMinutes: 100, targetMinutes: 960 }),
      hero({ hero: 'B', role: 'DPS', credited: 0, target: 16, playedMinutes: 0, targetMinutes: 960 }),
    ]);
    assert.deepEqual(b, { unit: 'min', remaining: 860 + 960 });
  });

  test('a played overshoot never makes remaining negative', () => {
    const b = projectionBasis([hero({ hero: 'A', role: 'DPS', target: 16, playedMinutes: 1000, targetMinutes: 960 })]);
    assert.equal(b.remaining, 0);
  });

  test('a legacy or mixed phase keeps counting games', () => {
    const b = projectionBasis([
      hero({ hero: 'A', role: 'DPS', credited: 30, target: 80 }),
      hero({ hero: 'B', role: 'DPS', credited: 1, target: 16, playedMinutes: 100, targetMinutes: 960 }),
    ]);
    assert.deepEqual(b, { unit: 'games', remaining: 50 + 15 });
  });
});
