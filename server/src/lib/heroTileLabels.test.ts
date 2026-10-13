// The derive must not write a standard label into a slot the client gives its own meaning
// (Zenyatta crit = Charged Volley, Baptiste crit = Healing). See CLIENT_SLOT_OVERRIDES.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { HERO_TILE_MAP, CLIENT_SLOT_OVERRIDES, CLIENT_NO_CRIT_HEROES, clientOverrides, slotValues, deriveSlotTiles, type Tile } from './heroTileLabels';

// require, not import: tsc has rootDir ./src, but tsx loads the client file (it has no imports) at run time.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const client = require('../../../client/src/lib/heroStatLabels') as {
  OVERALL_SLOT_LABEL: Record<string, unknown>; CRIT_SLOT_LABEL: Record<string, unknown>;
  EXTRA_ACC_LABEL: Record<string, unknown>; NO_CRIT_HEROES: Set<string>;
};
const sorted = (a: readonly string[]) => [...a].sort();
const ALL_STANDARD: Tile[] = [
  { label: 'WEAPON ACCURACY', value: '40%' }, { label: 'SCOPED ACCURACY', value: '41%' },
  { label: 'CRITICAL HIT ACCURACY', value: '12%' }, { label: 'SCOPED CRITICAL HIT ACCURACY', value: '13%' },
];

describe('client slot overrides', () => {
  test('the server key lists equal the client lists (drift fails here)', () => {
    assert.deepEqual(sorted(CLIENT_SLOT_OVERRIDES.overall), sorted(Object.keys(client.OVERALL_SLOT_LABEL)));
    assert.deepEqual(sorted(CLIENT_SLOT_OVERRIDES.crit), sorted(Object.keys(client.CRIT_SLOT_LABEL)));
    assert.deepEqual(sorted(CLIENT_SLOT_OVERRIDES.extra), sorted(Object.keys(client.EXTRA_ACC_LABEL)));
    assert.deepEqual(sorted(CLIENT_NO_CRIT_HEROES), sorted([...client.NO_CRIT_HEROES]));
  });
  test('every overridden slot of a hero outside the hand map stays null', () => {
    const pairs: [string, 'overall' | 'crit' | 'extra'][] = [];
    for (const slot of ['overall', 'crit', 'extra'] as const) for (const h of CLIENT_SLOT_OVERRIDES[slot]) pairs.push([h, slot]);
    for (const h of CLIENT_NO_CRIT_HEROES) pairs.push([h, 'crit']);
    let outside = 0;
    for (const [hero, slot] of pairs) {
      if (Object.prototype.hasOwnProperty.call(HERO_TILE_MAP, hero)) continue; // the hand map owns these
      outside++;
      assert.equal(clientOverrides(hero, slot), true);
      const v = slotValues(hero, ALL_STANDARD);
      assert.equal(v?.[`${slot}_acc` as const] ?? null, null, `${hero} ${slot}`);
    }
    assert.ok(outside >= 2); // Zenyatta and Baptiste crit
  });
  test('Zenyatta and Baptiste: crit empty, overall still derived', () => {
    for (const hero of ['Zenyatta', 'Baptiste']) {
      assert.deepEqual(slotValues(hero, ALL_STANDARD), { overall_acc: 40, crit_acc: null, extra_acc: null, torpedo_damage: null, torpedo_healing: null });
      assert.equal(deriveSlotTiles(ALL_STANDARD, hero)?.crit, undefined);
    }
  });
  test('a hero with no override still derives crit', () => {
    assert.equal(slotValues('Newhero', ALL_STANDARD)!.crit_acc, 12);
  });
});
