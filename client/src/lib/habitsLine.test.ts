import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { holdingHabitLine } from './habitsLine';

describe('holdingHabitLine', () => {
  test('a row holds: its action text shows', () => {
    const rows = [{ status: 'none' as const, action: null }, { status: 'holds' as const, action: 'Stop at 8.' }];
    assert.equal(holdingHabitLine({ rows }), 'Stop at 8.');
  });
  test('no row holds: nothing shows', () => {
    const rows = [{ status: 'none' as const, action: null }, { status: 'thin' as const, action: null }];
    assert.equal(holdingHabitLine({ rows }), null);
  });
  test('no data yet: nothing shows', () => {
    assert.equal(holdingHabitLine(undefined), null);
  });
});
