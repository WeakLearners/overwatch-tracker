// Which Personal-page tile fills which accuracy slot, per hero.
//
// The aim tables hold three generic accuracy slots (overall_acc, crit_acc,
// extra_acc), and what a slot MEANS depends on the hero (see
// client/src/lib/heroStatLabels.ts: Ana's overall slot is Scoped Accuracy, her
// crit slot is Sleep Dart). A tile read into the wrong slot corrupts the sens
// study without any warning, so a hero is in this map ONLY after a real
// Personal page confirmed its tile labels (Addendum 2, 2026-10-09).
//
// Confirmed 2026-10-09, each hero checked against the values Sean typed for a
// real match (spec section "Confirmed tile map"). Baptiste is removed. Every other hero gets play time, final blows and the raw tile JSON,
// and its accuracy slots stay empty for Sean. To add a hero: read a real
// Personal page for it first. Labels are compared case-insensitively and exactly,
// so "LONG RANGE FINAL BLOWS" never counts as final blows.
export interface SlotTiles { overall: string; crit?: string; extra?: string; torpedo_damage?: string; torpedo_healing?: string }

export const HERO_TILE_MAP: Record<string, SlotTiles> = {
  Tracer: { overall: 'weapon accuracy', crit: 'critical hit accuracy', extra: 'pulse bomb attach rate' },
  Pharah: { overall: 'weapon accuracy', crit: 'direct hit accuracy' },
  Sojourn: { overall: 'weapon accuracy', crit: 'charged shot accuracy', extra: 'charged shot critical accuracy' },
  Ashe: { overall: 'scoped accuracy', crit: 'scoped critical hit accuracy' }, // no WEAPON ACCURACY tile
  Mizuki: { overall: 'weapon accuracy', crit: 'binding chain accuracy' },
  Ana: { overall: 'scoped accuracy', crit: 'sleep dart accuracy' },
  Doctrine: { overall: 'weapon accuracy' }, // no crit value
  Sombra: { overall: 'weapon accuracy', crit: 'critical hit accuracy' },
  Shion: { overall: 'weapon accuracy', crit: 'critical hit accuracy' }, // no extra value; checked against match 3828: 34 / 10
  Juno: { overall: 'weapon accuracy', torpedo_damage: 'pulsar torpedoes damage', torpedo_healing: 'pulsar torpedoes healing' }, // no crit value
};

/** Both spellings are real: Tracer's tile says "FINAL BLOWS", Pharah's says "FINAL BLOW". */
export const FINAL_BLOWS_LABELS = ['final blows', 'final blow'];

export interface Tile { label: string; value: string; per10?: string; career_best?: boolean }

const lc = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

/** "33%" -> 33, "1,204" -> 1204, "5" -> 5. Anything else -> null. */
export function parseTileNumber(v: string): number | null {
  const m = String(v).trim().replace(/,/g, '').match(/^(\d+(?:\.\d+)?)\s*%?$/);
  return m ? Number(m[1]) : null;
}

function tileValue(tiles: Tile[], label: string): number | null {
  const t = tiles.find(x => lc(x.label) === label);
  return t ? parseTileNumber(t.value) : null;
}

export interface SlotValues { overall_acc: number | null; crit_acc: number | null; extra_acc: number | null; torpedo_damage: number | null; torpedo_healing: number | null }

/** Accuracy slot values for a hero, or null when the hero is not in the confirmed map. Never guesses. */
export function slotValues(hero: string, tiles: Tile[]): SlotValues | null {
  const map = HERO_TILE_MAP[hero];
  if (!map) return null;
  return {
    overall_acc: tileValue(tiles, map.overall),
    crit_acc: map.crit ? tileValue(tiles, map.crit) : null,
    extra_acc: map.extra ? tileValue(tiles, map.extra) : null,
    torpedo_damage: map.torpedo_damage ? tileValue(tiles, map.torpedo_damage) : null,
    torpedo_healing: map.torpedo_healing ? tileValue(tiles, map.torpedo_healing) : null,
  };
}

export function finalBlows(tiles: Tile[]): number | null {
  for (const l of FINAL_BLOWS_LABELS) {
    const v = tileValue(tiles, l);
    if (v != null) return v;
  }
  return null;
}
