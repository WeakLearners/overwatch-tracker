// Pure-function tests for lib/nextTest.ts's computeNextTest — no DB. See
// routes/blind.next.test.ts for the DB-integration layer (gathering
// HeroTestProgress/BlockInfo from real tables).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeNextTest, projectPhaseFinish, projectionBasis, COLD_DAYS, type HeroTestProgress } from './nextTest';

function hero(overrides: Partial<HeroTestProgress> & { hero: string; role: string }): HeroTestProgress {
  return { credited: 0, target: 80, daysSinceLastPlayed: null, completed: false, ...overrides };
}

const ROSTER: HeroTestProgress[] = [
  hero({ hero: 'Sojourn', role: 'DPS', credited: 40, daysSinceLastPlayed: 2 }),
  hero({ hero: 'Tracer', role: 'DPS', credited: 10, daysSinceLastPlayed: 1 }),
  hero({ hero: 'Pharah', role: 'DPS', credited: 20, daysSinceLastPlayed: 3 }),
  hero({ hero: 'Shion', role: 'DPS', credited: 30, daysSinceLastPlayed: 0 }),
  hero({ hero: 'Ana', role: 'Support', credited: 15, daysSinceLastPlayed: 5 }),
  hero({ hero: 'Juno', role: 'Support', credited: 15, daysSinceLastPlayed: 1 }),
  hero({ hero: 'Zenyatta', role: 'Support', credited: 50, daysSinceLastPlayed: 0 }),
  hero({ hero: 'Kiriko', role: 'Support', credited: 25, daysSinceLastPlayed: 0 }),
];

describe('computeNextTest — ordering', () => {
  test('picks the least-progressed hero overall and its role', () => {
    const r = computeNextTest(ROSTER, null);
    assert.equal(r.recommendedRole, 'DPS'); // Tracer at 10 is the global minimum
    assert.equal(r.orderedHeroes[0].hero, 'Tracer');
  });

  test('lists every pending hero in the recommended role, ordered by progress', () => {
    const r = computeNextTest(ROSTER, null);
    assert.deepEqual(r.orderedHeroes.map(h => h.hero), ['Tracer', 'Pharah', 'Shion', 'Sojourn']);
  });

  test('tie-breaks equal progress by longest since last played', () => {
    const roster: HeroTestProgress[] = [
      hero({ hero: 'Ana', role: 'Support', credited: 15, daysSinceLastPlayed: 1 }),
      hero({ hero: 'Juno', role: 'Support', credited: 15, daysSinceLastPlayed: 9 }),
      hero({ hero: 'Sojourn', role: 'DPS', credited: 40, daysSinceLastPlayed: 0 }),
    ];
    const r = computeNextTest(roster, null);
    assert.equal(r.recommendedRole, 'Support');
    // Juno has been sitting longer (9 days) than Ana (1 day) at the same
    // progress, so it wins the tie.
    assert.equal(r.orderedHeroes[0].hero, 'Juno');
  });

  test('never-played (null days) outranks any hero with a real last-played date on a tie', () => {
    // Both stay under COLD_DAYS so this is testing the plain tie-break, not
    // the going-cold jump-to-top rule (a separate, later test).
    const roster: HeroTestProgress[] = [
      hero({ hero: 'Ana', role: 'Support', credited: 0, daysSinceLastPlayed: 3 }),
      hero({ hero: 'Juno', role: 'Support', credited: 0, daysSinceLastPlayed: null }),
    ];
    const r = computeNextTest(roster, null);
    assert.equal(r.orderedHeroes[0].hero, 'Juno');
  });
});

describe('computeNextTest — going cold', () => {
  test('a cold hero jumps to the top of its role even though it is not least-progressed', () => {
    const roster: HeroTestProgress[] = [
      hero({ hero: 'Tracer', role: 'DPS', credited: 5, daysSinceLastPlayed: 1 }),
      hero({ hero: 'Sojourn', role: 'DPS', credited: 40, daysSinceLastPlayed: COLD_DAYS }),
    ];
    const r = computeNextTest(roster, null);
    assert.equal(r.recommendedRole, 'DPS'); // Tracer is still the global pick (least progressed)
    assert.equal(r.orderedHeroes[0].hero, 'Sojourn', 'cold hero leads its own role list');
    assert.equal(r.orderedHeroes[0].cold, true);
    assert.equal(r.orderedHeroes[1].cold, false);
  });

  test('going cold does NOT change which role is recommended', () => {
    // Zenyatta (Support) is most progressed overall AND cold — cold only
    // reorders within a role, it never promotes a role over the true
    // least-progressed pick.
    const roster: HeroTestProgress[] = [
      ...ROSTER.filter(h => h.hero !== 'Zenyatta'),
      hero({ hero: 'Zenyatta', role: 'Support', credited: 79, daysSinceLastPlayed: 30 }),
    ];
    const r = computeNextTest(roster, null);
    assert.equal(r.recommendedRole, 'DPS');
  });

  test('below the cold threshold, a hero does not jump the line', () => {
    const roster: HeroTestProgress[] = [
      hero({ hero: 'Tracer', role: 'DPS', credited: 5, daysSinceLastPlayed: 1 }),
      hero({ hero: 'Sojourn', role: 'DPS', credited: 40, daysSinceLastPlayed: COLD_DAYS - 1 }),
    ];
    const r = computeNextTest(roster, null);
    assert.equal(r.orderedHeroes[0].hero, 'Tracer');
  });
});

describe('computeNextTest — finished heroes', () => {
  test('a completed hero is reported as finished and excluded from the pick', () => {
    const roster: HeroTestProgress[] = [
      hero({ hero: 'Tracer', role: 'DPS', credited: 80, completed: true }),
      hero({ hero: 'Pharah', role: 'DPS', credited: 10 }),
    ];
    const r = computeNextTest(roster, null);
    assert.deepEqual(r.finishedHeroes, ['Tracer']);
    assert.equal(r.orderedHeroes.some(h => h.hero === 'Tracer'), false);
    assert.equal(r.recommendedRole, 'DPS');
  });

  test('every hero finished reports allFinished with no recommendation', () => {
    const roster: HeroTestProgress[] = [
      hero({ hero: 'Tracer', role: 'DPS', credited: 80, completed: true }),
      hero({ hero: 'Ana', role: 'Support', credited: 80, completed: true }),
    ];
    const r = computeNextTest(roster, null);
    assert.equal(r.allFinished, true);
    assert.equal(r.recommendedRole, null);
    assert.deepEqual(r.orderedHeroes, []);
    assert.deepEqual(r.finishedHeroes.sort(), ['Ana', 'Tracer']);
  });
});

describe('computeNextTest — block', () => {
  test('mid-block (34 of 60 min) locks the role and does not recompute the ordered list', () => {
    // Kiriko is not the global least-progressed pick, but the open block
    // overrides the recompute entirely.
    const r = computeNextTest(ROSTER, { hero: 'Kiriko', openMinutes: 34 });
    assert.deepEqual(r.block, { hero: 'Kiriko', role: 'Support', openMinutes: 34 });
    assert.equal(r.recommendedRole, 'Support');
    assert.deepEqual(r.orderedHeroes, []);
  });

  test('a freshly started block (1 minute in) still locks (an off-plan hero starts its own block)', () => {
    const r = computeNextTest(ROSTER, { hero: 'Shion', openMinutes: 1 });
    assert.equal(r.block?.openMinutes, 1);
    assert.equal(r.block?.hero, 'Shion');
  });

  test('at the block boundary (0 open minutes — it just closed), the card recomputes instead of staying', () => {
    const r = computeNextTest(ROSTER, { hero: 'Kiriko', openMinutes: 0 });
    assert.equal(r.block, null);
    assert.equal(r.recommendedRole, 'DPS'); // back to the true global pick (Tracer)
  });

  test('a block on a hero whose test has since completed falls through to a full recompute', () => {
    const roster: HeroTestProgress[] = [
      hero({ hero: 'Kiriko', role: 'Support', credited: 80, completed: true }),
      hero({ hero: 'Tracer', role: 'DPS', credited: 5 }),
    ];
    const r = computeNextTest(roster, { hero: 'Kiriko', openMinutes: 25 }); // would be mid-block if still pending
    assert.equal(r.block, null);
    assert.equal(r.recommendedRole, 'DPS');
  });

  test('a block on a hero not in the current roster falls through to a full recompute', () => {
    const r = computeNextTest(ROSTER, { hero: 'Widowmaker', openMinutes: 12 });
    assert.equal(r.block, null);
    assert.equal(r.recommendedRole, 'DPS');
  });

  test('no block at all (null) is a full recompute', () => {
    const r = computeNextTest(ROSTER, null);
    assert.equal(r.block, null);
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
