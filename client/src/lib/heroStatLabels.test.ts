import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { picksToLabels, critSlot, critSlotShort, overallSlot, extraSlot, extraSlotShort } from './heroStatLabels';

// Rows as GET /api/scoreboards/tile-picks sends them (server: heroTilePicks.ts listPicks).
const picks = picksToLabels([
  { hero: 'Reaper', slot: 'extra', label: 'Mystery Ability Accuracy %' },
  { hero: 'Zenyatta', slot: 'crit', label: 'Orb Accuracy %' },
  { hero: 'Hanzo', slot: 'extra', label: null }, // None for this hero
]);

describe('tile pick labels', () => {
  test('a new hero gets an extra label from its pick, the static maps stay the default', () => {
    assert.equal(extraSlot('Reaper'), null);
    assert.equal(extraSlot('Reaper', picks), 'Mystery Ability Accuracy %');
    assert.equal(extraSlotShort('Reaper', picks), 'Mystery Ability');
    assert.equal(extraSlot('Tracer', picks), 'Pulse Bomb %');
  });
  test('a pick beats the static crit label; short form drops the unit and Accuracy', () => {
    assert.equal(critSlot('Zenyatta').label, 'Charged Volley %');
    assert.equal(critSlot('Zenyatta', picks).label, 'Orb Accuracy %');
    assert.equal(critSlotShort('Zenyatta', picks), 'Orb');
    assert.equal(critSlotShort('Ana', picks), 'Sleep Dart');
  });
  test('a None pick changes nothing; with no picks every label is the old one', () => {
    assert.equal(extraSlot('Hanzo', picks), null);
    assert.equal(critSlot('Hanzo', picks).label, 'Crit %');
    assert.equal(overallSlot('Ashe').label, 'Scoped Accuracy %');
    assert.equal(overallSlot('Ashe', picks).label, 'Scoped Accuracy %');
  });
});
