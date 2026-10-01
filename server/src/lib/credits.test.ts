// The 2026-10-01 credit rules in isolation: minutes at >= 1, the game at
// >= 1/3 of the match. Boundaries are the point — each one is an integer
// compare that a float threshold would get wrong.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { creditFlagsFor } from './credits';

const flags = (rows: { hero: string; duration_min: number }[], slot1 = 'A') =>
  creditFlagsFor(rows, slot1).map(f => `${f.hero}:${f.countsResult}${f.countsMinutes}`);

describe('creditFlagsFor', () => {
  test('no minutes on file: the slot-1 hero holds the credit, both flags', () => {
    assert.deepEqual(flags([], 'Shion'), ['Shion:11']);
    assert.deepEqual(flags([{ hero: 'Shion', duration_min: 0 }], 'Shion'), ['Shion:11']);
  });

  test('two heroes both over a third each take the game and their minutes (match 3753)', () => {
    assert.deepEqual(flags([{ hero: 'Shion', duration_min: 8.17 }, { hero: 'Sojourn', duration_min: 7.37 }]), ['Shion:11', 'Sojourn:11']);
  });

  test('a hero under a third but over a minute counts minutes only (match 3756: 1.07 of 4.52)', () => {
    assert.deepEqual(flags([{ hero: 'Shion', duration_min: 3.45 }, { hero: 'Soldier: 76', duration_min: 1.07 }]), ['Shion:11', 'Soldier: 76:01']);
  });

  test('a hero under a minute AND under a third gets nothing (match 3742: 0.63 of 7.48)', () => {
    assert.deepEqual(flags([{ hero: 'Zenyatta', duration_min: 0.63 }, { hero: 'Kiriko', duration_min: 6.85 }]), ['Kiriko:11']);
  });

  test('exactly one third passes the game line (5 of 15), a hair under does not', () => {
    assert.deepEqual(flags([{ hero: 'A', duration_min: 10 }, { hero: 'B', duration_min: 5 }]), ['A:11', 'B:11']);
    assert.deepEqual(flags([{ hero: 'A', duration_min: 10 }, { hero: 'B', duration_min: 4.9 }]), ['A:11', 'B:01']);
  });

  test('exactly one minute counts minutes; under it does not', () => {
    assert.deepEqual(flags([{ hero: 'A', duration_min: 30 }, { hero: 'B', duration_min: 1 }]), ['A:11', 'B:01']);
    assert.deepEqual(flags([{ hero: 'A', duration_min: 30 }, { hero: 'B', duration_min: 0.99 }]), ['A:11']);
  });

  test('a short match can give a hero the game without a full minute (0.9 of 2.0)', () => {
    assert.deepEqual(flags([{ hero: 'A', duration_min: 1.1 }, { hero: 'B', duration_min: 0.9 }]), ['A:11', 'B:10']);
  });

  test('three heroes can all take the game (4/4/4 of 12)', () => {
    assert.deepEqual(flags([{ hero: 'A', duration_min: 4 }, { hero: 'B', duration_min: 4 }, { hero: 'C', duration_min: 4 }]), ['A:11', 'B:11', 'C:11']);
  });
});
