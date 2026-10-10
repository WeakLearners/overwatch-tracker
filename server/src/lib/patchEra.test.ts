import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { patchEra, eraCounts, spannedPatchNotes, eraCountsText, PATCH_BOUNDARIES, PATCH_LABELS } from './patchEra';

describe('patchEra', () => {
  test('boundary is 2026-10-06', () => assert.deepEqual([...PATCH_BOUNDARIES], ['2026-10-06']));
  test('every boundary has a label', () => assert.equal(PATCH_LABELS.length, PATCH_BOUNDARIES.length));
  test('10-05 is era 0', () => assert.equal(patchEra('2026-10-05'), 0));
  test('10-06 is era 1 (on the patch date counts as after)', () => assert.equal(patchEra('2026-10-06'), 1));
  test('10-07 is era 1', () => assert.equal(patchEra('2026-10-07'), 1));
  test('eraCounts splits dates', () => assert.deepEqual(eraCounts(['2026-10-05', '2026-10-06', '2026-10-09']), [1, 2]));
});

describe('spannedPatchNotes', () => {
  test('matches on both sides give the patch note with its label', () => {
    assert.deepEqual(spannedPatchNotes([103, 7]), ['Spans the 10-06 patch (hitbox and projectile size change)']);
  });
  test('one side only gives no note', () => {
    assert.deepEqual(spannedPatchNotes([5, 0]), []);
    assert.deepEqual(spannedPatchNotes([0, 3]), []);
  });
  test('eraCountsText names the boundary date', () => {
    assert.equal(eraCountsText([5, 2]), 'before/after 10-06: 5/2');
  });
});
