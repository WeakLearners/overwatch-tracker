// Pure-function tests for lib/nextTest.ts's computeNextTest — no DB. See
// routes/blind.next.test.ts for the DB-integration layer (gathering
// HeroTestProgress/StintInfo from real tables).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeNextTest, projectPhaseFinish, STINT_LENGTH, COLD_DAYS, type HeroTestProgress } from './nextTest';

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

describe('computeNextTest — stint', () => {
  test('mid-stint (2 of 5) locks the role and does not recompute the ordered list', () => {
    // Kiriko is not the global least-progressed pick, but the stint
    // overrides the recompute entirely.
    const r = computeNextTest(ROSTER, { hero: 'Kiriko', count: 2 });
    assert.deepEqual(r.stint, { hero: 'Kiriko', role: 'Support', position: 2, length: STINT_LENGTH });
    assert.equal(r.recommendedRole, 'Support');
    assert.deepEqual(r.orderedHeroes, []);
  });

  test('position 1 of a fresh stint still locks (an off-plan hero starts its own stint)', () => {
    const r = computeNextTest(ROSTER, { hero: 'Shion', count: 1 });
    assert.equal(r.stint?.position, 1);
    assert.equal(r.stint?.hero, 'Shion');
  });

  test('at the stint boundary (5 of 5), the card recomputes instead of staying', () => {
    const r = computeNextTest(ROSTER, { hero: 'Kiriko', count: STINT_LENGTH });
    assert.equal(r.stint, null);
    assert.equal(r.recommendedRole, 'DPS'); // back to the true global pick (Tracer)
  });

  test('a stint longer than 5 (Sean ignored the switch prompt) starts a fresh lap at position 1', () => {
    // count = 6 -> position ((6-1) % 5) + 1 = 1: game 6 is the first game of
    // this hero's SECOND lap, not a continuation of the first.
    const r = computeNextTest(ROSTER, { hero: 'Kiriko', count: 6 });
    assert.equal(r.stint?.position, 1);
  });

  test('a stint on a hero whose test has since completed falls through to a full recompute', () => {
    const roster: HeroTestProgress[] = [
      hero({ hero: 'Kiriko', role: 'Support', credited: 80, completed: true }),
      hero({ hero: 'Tracer', role: 'DPS', credited: 5 }),
    ];
    const r = computeNextTest(roster, { hero: 'Kiriko', count: 3 }); // would be mid-stint if still pending
    assert.equal(r.stint, null);
    assert.equal(r.recommendedRole, 'DPS');
  });

  test('a stint on a hero not in the current roster falls through to a full recompute', () => {
    const r = computeNextTest(ROSTER, { hero: 'Widowmaker', count: 2 });
    assert.equal(r.stint, null);
    assert.equal(r.recommendedRole, 'DPS');
  });

  test('no stint at all (null) is a full recompute', () => {
    const r = computeNextTest(ROSTER, null);
    assert.equal(r.stint, null);
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
});
