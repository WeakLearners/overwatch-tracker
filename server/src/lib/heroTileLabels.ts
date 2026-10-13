// Which Personal-page tile fills which accuracy slot, per hero.
//
// The aim tables hold three generic accuracy slots (overall_acc, crit_acc,
// extra_acc), and what a slot MEANS depends on the hero (see
// client/src/lib/heroStatLabels.ts: Ana's overall slot is Scoped Accuracy, her
// crit slot is Sleep Dart). A tile read into the wrong slot corrupts the sens
// study without any warning, so a hero is in this map ONLY after a real
// Personal page confirmed its tile labels (Addendum 2, 2026-10-09).
//
// Confirmed 2026-10-09 (Soldier: 76 and Cassidy added 2026-10-13), each hero checked against the values Sean typed for a
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
  'Soldier: 76': { overall: 'weapon accuracy', crit: 'critical hit accuracy', extra: 'helix rocket accuracy' }, // checked against board 165 (2026-10-13): 35 / 6 / 53
  Cassidy: { overall: 'weapon accuracy', crit: 'critical hit accuracy' }, // no extra value; checked against board 166 (2026-10-13): 45 / 5
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

/**
 * Heroes whose slot the CLIENT gives a special meaning (client/src/lib/heroStatLabels.ts:
 * OVERALL_SLOT_LABEL, CRIT_SLOT_LABEL, EXTRA_ACC_LABEL, NO_CRIT_HEROES). The derive must never write a
 * standard label into such a slot: Zenyatta's crit slot is Charged Volley and Baptiste's is Healing, so a
 * derived "critical hit accuracy" would corrupt it silently. The server cannot import the client file (rootDir),
 * so the keys are copied here. heroTileLabels.test.ts reads the client file and fails if the lists drift.
 */
export const CLIENT_SLOT_OVERRIDES = {
  overall: ['Ana', 'Ashe'],
  crit: ['Ana', 'Sojourn', 'Pharah', 'Zenyatta', 'Baptiste', 'Mizuki', 'Ashe'],
  extra: ['Sojourn', 'Soldier: 76', 'Baptiste', 'Tracer'],
} as const;
export const CLIENT_NO_CRIT_HEROES = ['Juno', 'Doctrine'] as const;

/** True when the client already gives (hero, slot) its own meaning, so no standard label may fill it. */
export function clientOverrides(hero: string, slot: 'overall' | 'crit' | 'extra'): boolean {
  return (CLIENT_SLOT_OVERRIDES[slot] as readonly string[]).includes(hero)
    || (slot === 'crit' && (CLIENT_NO_CRIT_HEROES as readonly string[]).includes(hero));
}

/**
 * Fallback for heroes NOT in HERO_TILE_MAP. Exact standard labels only; extra is never derived
 * because ability tiles mean different things per hero. A slot the client overrides for this hero
 * (see CLIENT_SLOT_OVERRIDES) is left out. Null when no slot can be derived.
 */
export function deriveSlotTiles(tiles: Tile[], hero?: string): Partial<SlotTiles> | null {
  const has = (label: string) => tiles.some(x => lc(x.label) === label);
  const out: Partial<SlotTiles> = {};
  if (!(hero && clientOverrides(hero, 'overall'))) {
    const overall = has('weapon accuracy') ? 'weapon accuracy' : has('scoped accuracy') ? 'scoped accuracy' : null;
    if (overall) out.overall = overall;
  }
  if (!(hero && clientOverrides(hero, 'crit'))) {
    const crit = has('critical hit accuracy') ? 'critical hit accuracy' : has('scoped critical hit accuracy') ? 'scoped critical hit accuracy' : undefined;
    if (crit) out.crit = crit;
  }
  return out.overall || out.crit ? out : null;
}

/** True when the hero has no hand-map entry, so its slots come from deriveSlotTiles. */
export const isAutoMapped = (hero: string) => !Object.prototype.hasOwnProperty.call(HERO_TILE_MAP, hero);

export type Slot = 'overall' | 'crit' | 'extra';
export const SLOTS: readonly Slot[] = ['overall', 'crit', 'extra'];
export type SlotSource = 'map' | 'pick' | 'derived' | null;
/** A saved pick per slot: a lowercase tile label, or null = "None for this hero". A missing key = no pick yet. */
export type HeroPicks = Partial<Record<Slot, string | null>>;
export interface ResolvedSlot { tile: string | null; source: SlotSource }
export interface PickTile { label: string; value: string }

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * Which tile fills each slot. Precedence per hero and slot: hand map (HERO_TILE_MAP) > saved pick >
 * derived standard label (only for heroes outside the hand map, and never into a client-overridden slot) > empty.
 * A pick of null ("None for this hero") resolves to empty with source null, so the menu stays away.
 */
export function resolveSlots(hero: string, tiles: Tile[], picks: HeroPicks = {}): Record<Slot, ResolvedSlot> {
  const inMap = hasOwn(HERO_TILE_MAP, hero);
  const map: Partial<SlotTiles> = inMap ? HERO_TILE_MAP[hero] : {};
  const derived = inMap ? null : deriveSlotTiles(tiles, hero);
  const one = (slot: Slot): ResolvedSlot => {
    if (map[slot]) return { tile: map[slot]!, source: 'map' };
    if (hasOwn(picks, slot)) { const t = picks[slot] ?? null; return t ? { tile: lc(t), source: 'pick' } : { tile: null, source: null }; }
    if (derived?.[slot]) return { tile: derived[slot]!, source: 'derived' };
    return { tile: null, source: null };
  };
  return { overall: one('overall'), crit: one('crit'), extra: one('extra') };
}

/** Accuracy slot values for a hero (precedence in resolveSlots). Null for a hero outside the hand map when no slot resolves. Never guesses. */
export function slotValues(hero: string, tiles: Tile[], picks: HeroPicks = {}): SlotValues | null {
  const r = resolveSlots(hero, tiles, picks);
  const inMap = hasOwn(HERO_TILE_MAP, hero);
  if (!inMap && !SLOTS.some(s => r[s].tile)) return null;
  const map: Partial<SlotTiles> = inMap ? HERO_TILE_MAP[hero] : {};
  return {
    overall_acc: r.overall.tile ? tileValue(tiles, r.overall.tile) : null,
    crit_acc: r.crit.tile ? tileValue(tiles, r.crit.tile) : null,
    extra_acc: r.extra.tile ? tileValue(tiles, r.extra.tile) : null,
    torpedo_damage: map.torpedo_damage ? tileValue(tiles, map.torpedo_damage) : null,
    torpedo_healing: map.torpedo_healing ? tileValue(tiles, map.torpedo_healing) : null,
  };
}

/**
 * Menu options for the slots nothing fills yet. Only heroes outside the hand map get a menu: a mapped hero's
 * empty slot (Cassidy extra, Juno crit) was checked against a real page and is empty on purpose.
 * Options: PERCENT tiles of this hero's Personal page (value ends in %, not PERCENT PLAYED), minus tiles another
 * slot of the hero already uses. Slots with a saved pick (None included) get no menu. A slot the client already names (clientOverrides, no-crit heroes included) never does.
 */
export function pickableTiles(hero: string, tiles: Tile[], picks: HeroPicks = {}): Partial<Record<Slot, PickTile[]>> {
  if (hasOwn(HERO_TILE_MAP, hero)) return {};
  const r = resolveSlots(hero, tiles, picks);
  const used = new Set(SLOTS.map(s => r[s].tile).filter((t): t is string => !!t));
  const options = tiles
    .filter(t => /%\s*$/.test(t.value) && lc(t.label) !== 'percent played' && !used.has(lc(t.label)))
    .map(t => ({ label: t.label.trim(), value: t.value.trim() }));
  const out: Partial<Record<Slot, PickTile[]>> = {};
  for (const slot of SLOTS) {
    if (r[slot].source != null || hasOwn(picks, slot)) continue;
    if (clientOverrides(hero, slot)) continue; // the app already names this slot; a pick would relabel old rows
    if (options.length) out[slot] = options;
  }
  return out;
}

/** "sleep dart accuracy" -> "Sleep Dart Accuracy %": the form label a picked tile gets (the unit suffix matches the static labels). */
export const pickFormLabel = (tileLabel: string) =>
  `${lc(tileLabel).split(' ').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')} %`;

export const normTileLabel = lc;

export function finalBlows(tiles: Tile[]): number | null {
  for (const l of FINAL_BLOWS_LABELS) {
    const v = tileValue(tiles, l);
    if (v != null) return v;
  }
  return null;
}
