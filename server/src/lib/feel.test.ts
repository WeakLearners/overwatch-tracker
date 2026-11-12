// Pure tests for lib/feel.ts: the band helper that reads both the new
// three-button values (0, 50, 100) and old 0-100 slider rows.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { feelBand, feelCounts, FEEL_VALUE } from './feel';

describe('feelBand', () => {
  test('the three button values band to their own category', () => {
    assert.equal(feelBand(FEEL_VALUE.floaty), 'floaty');
    assert.equal(feelBand(FEEL_VALUE.snappy), 'snappy');
    assert.equal(feelBand(FEEL_VALUE.jittery), 'jittery');
  });
  test('old slider values band at the edges: <40 Floaty, 40-60 Snappy, >60 Jittery', () => {
    assert.equal(feelBand(39), 'floaty');
    assert.equal(feelBand(39.9), 'floaty');
    assert.equal(feelBand(40), 'snappy');
    assert.equal(feelBand(60), 'snappy');
    assert.equal(feelBand(60.1), 'jittery');
    assert.equal(feelBand(61), 'jittery');
  });
  test('unset stays unset: null, undefined and NaN give null, never a default', () => {
    assert.equal(feelBand(null), null);
    assert.equal(feelBand(undefined), null);
    assert.equal(feelBand(NaN), null);
  });
});

describe('feelCounts', () => {
  test('counts each category and skips unanswered rows', () => {
    const c = feelCounts([0, 50, 50, 100, 12, 55, 80, null, undefined]);
    assert.deepEqual(c, { floaty: 2, snappy: 3, jittery: 2, n: 7 });
  });
  test('empty input gives zero counts', () => {
    assert.deepEqual(feelCounts([]), { floaty: 0, snappy: 0, jittery: 0, n: 0 });
  });
});
