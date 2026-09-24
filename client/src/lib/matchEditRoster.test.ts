// Pins the payload-shape rule TodayMatchEditForm's save() depends on
// (LogMatch.tsx): a pure sens correction must never send `heroes` (which
// would re-run the server's stage-credit recompute and can silently
// overwrite the very value being corrected), and a real roster change must
// never smuggle a sens correction through `heroSens` instead of `heroes`.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildRosterEditPayload } from './matchEditRoster';

const roleOf = (h: string) => (h === 'Ashe' ? 'DPS' : h === 'Cassidy' ? 'DPS' : 'Support');

describe('buildRosterEditPayload', () => {
  test('roster unchanged, one slot sens edited: heroSens only, no heroes key', () => {
    const payload = buildRosterEditPayload({
      slotHeroes: ['Cassidy', ''],
      slotSens: ['6.5', ''],
      originalHeroNames: ['Cassidy'],
      roleOf,
    });
    assert.deepEqual(payload, { heroSens: { Cassidy: 6.5 } });
    assert.equal('heroes' in payload, false, 'must not send heroes for a pure sens correction');
  });

  test('roster unchanged, sens field left blank: neither key sent (blank means "don\'t touch")', () => {
    const payload = buildRosterEditPayload({
      slotHeroes: ['Cassidy', ''],
      slotSens: ['', ''],
      originalHeroNames: ['Cassidy'],
      roleOf,
    });
    assert.deepEqual(payload, {});
  });

  test('roster unchanged, both slots filled and edited: heroSens covers both', () => {
    const payload = buildRosterEditPayload({
      slotHeroes: ['Cassidy', 'Ashe'],
      slotSens: ['6.5', '2.75'],
      originalHeroNames: ['Cassidy', 'Ashe'],
      roleOf,
    });
    assert.deepEqual(payload, { heroSens: { Cassidy: 6.5, Ashe: 2.75 } });
  });

  test('a hero added to an empty slot: roster changed, sends heroes with sens carried', () => {
    const payload = buildRosterEditPayload({
      slotHeroes: ['Cassidy', ''],
      slotSens: ['6.5', ''],
      originalHeroNames: [],
      roleOf,
    });
    assert.deepEqual(payload, { heroes: [{ hero: 'Cassidy', role: 'DPS', sens: 6.5 }] });
    assert.equal('heroSens' in payload, false, 'must not send heroSens for a roster change');
  });

  test('a hero removed: roster changed, heroes reflects the shorter roster', () => {
    const payload = buildRosterEditPayload({
      slotHeroes: ['', ''],
      slotSens: ['', ''],
      originalHeroNames: ['Cassidy'],
      roleOf,
    });
    assert.deepEqual(payload, { heroes: [] });
  });

  test('two slots swapped: order matters, counts as a roster change even though the set is identical', () => {
    const payload = buildRosterEditPayload({
      slotHeroes: ['Ashe', 'Cassidy'],
      slotSens: ['2.0', '6.0'],
      originalHeroNames: ['Cassidy', 'Ashe'],
      roleOf,
    });
    assert.deepEqual(payload, {
      heroes: [
        { hero: 'Ashe', role: 'DPS', sens: 2.0 },
        { hero: 'Cassidy', role: 'DPS', sens: 6.0 },
      ],
    });
  });

  test('roster changed with a blank sens on the new hero: entry omits sens rather than sending null', () => {
    const payload = buildRosterEditPayload({
      slotHeroes: ['Cassidy', ''],
      slotSens: ['', ''],
      originalHeroNames: [],
      roleOf,
    });
    assert.deepEqual(payload, { heroes: [{ hero: 'Cassidy', role: 'DPS' }] });
  });

  test('no extra heroes at all, none before either: empty payload', () => {
    const payload = buildRosterEditPayload({
      slotHeroes: ['', ''],
      slotSens: ['', ''],
      originalHeroNames: [],
      roleOf,
    });
    assert.deepEqual(payload, {});
  });
});
