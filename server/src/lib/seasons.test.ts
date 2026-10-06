import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEASONS, seasonOf, seasonProgress, seasonDay, seasonRange } from './seasons';

test('each season ends exactly where the next starts, so no date falls in a gap', () => {
  for (let i = 0; i < SEASONS.length - 1; i++) {
    assert.equal(SEASONS[i].end, SEASONS[i + 1].start, `${SEASONS[i].label} -> ${SEASONS[i + 1].label}`);
  }
});

test('only the last season is open-ended', () => {
  assert.equal(SEASONS[SEASONS.length - 1].end, null);
  assert.equal(SEASONS.filter(s => s.end === null).length, 1);
});

test('the changeover day belongs to the new season', () => {
  assert.equal(seasonOf('2026-10-05')?.label, '2026 S4');
  assert.equal(seasonOf('2026-10-06')?.label, '2026 S5');
  assert.equal(seasonOf('2027-03-01')?.label, '2026 S5'); // open season has no end
  assert.equal(seasonOf('2020-01-01'), null);
});

test('seasonProgress is a fraction for a closed season and null for the open one', () => {
  assert.equal(seasonProgress('2026-08-11'), 0);
  assert.ok(seasonProgress('2026-09-08')! > 0.4 && seasonProgress('2026-09-08')! < 0.6);
  assert.equal(seasonProgress('2026-10-06'), null);
});

test('seasonDay counts from 1 on the first day', () => {
  assert.equal(seasonDay('2026-10-06'), 1);
  assert.equal(seasonDay('2026-10-16'), 11);
  assert.equal(seasonDay('2020-01-01'), null);
});

test('seasonRange gives an open end for the current season', () => {
  assert.deepEqual(seasonRange('2026 S5'), { from: '2026-10-06', to: null });
  assert.deepEqual(seasonRange('2026 S4'), { from: '2026-08-11', to: '2026-10-06' });
  assert.equal(seasonRange('nope'), null);
});
