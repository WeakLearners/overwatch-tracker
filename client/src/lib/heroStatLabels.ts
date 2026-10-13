// What each hero's stat slots actually mean.
//
// The aim tables store four generic numeric slots — overall_acc, crit_acc,
// extra_acc (aim_stats_heroes) and hero_stat_value (aim_stats) — but what a
// slot MEANS is per hero: Ana's crit_acc is her sleep dart hit rate, Sojourn's
// is charged shot, Pharah's is direct hits. Until 2026-09-15 that mapping
// lived as four private consts inside SensLog.tsx, so it reached the entry
// form and nothing else. The analysis page read the same columns and printed
// them under the column header "Crit" — which for Ana is not a crit rate at
// all, and for Baptiste is a healing percentage.
//
// This module is the single place that mapping lives, so a label travels with
// its data to every surface that renders it.
//
// hero_stat_value is deliberately NOT in here: its label is stored per match
// in aim_stats.hero_stat_label and comes back off the API, so it's read from
// the data rather than hardcoded.

// Per-hero override for the overall_acc slot.
export const OVERALL_SLOT_LABEL: Record<string, { label: string; aria: string }> = {
  Ana: { label: 'Scoped Accuracy %', aria: 'scoped accuracy' },
  // Ashe has no WEAPON ACCURACY tile; her overall slot is SCOPED ACCURACY (screenshot tile map, 2026-10-09).
  Ashe: { label: 'Scoped Accuracy %', aria: 'scoped accuracy' },
};

// Per-hero override for the crit_acc slot — heroes whose kit doesn't map
// cleanly onto "Crit %" repurpose the same underlying field.
export const CRIT_SLOT_LABEL: Record<string, { label: string; aria: string }> = {
  Ana: { label: 'Sleep Dart Accuracy %', aria: 'sleep dart accuracy' },
  Sojourn: { label: 'Charged Shot %', aria: 'charged shot accuracy' },
  Pharah: { label: 'Direct Hit %', aria: 'direct hit accuracy' },
  Zenyatta: { label: 'Charged Volley %', aria: 'charged volley accuracy' },
  Baptiste: { label: 'Healing %(+)', aria: 'healing accuracy' },
  Mizuki: { label: 'Binding Chain %', aria: 'binding chain accuracy' },
  Ashe: { label: 'Scoped Crit %', aria: 'scoped critical hit accuracy' },
};

// Per-hero label for the optional 4th accuracy field (absent = this hero uses
// only the standard three slots).
export const EXTRA_ACC_LABEL: Record<string, string> = {
  Sojourn: 'Charged Shot Crit %',
  'Soldier: 76': 'Helix Rocket %',
  Baptiste: 'Crit %',
  Tracer: 'Pulse Bomb %',
};

// Heroes with no meaningful crit stat at all — the crit slot is dropped from
// their row entirely rather than relabelled (Juno's kit has no crit reading;
// Doctrine's Personal page has no crit tile, checked 2026-10-09).
export const NO_CRIT_HEROES = new Set(['Juno', 'Doctrine']);

// Per-hero raw-count fields (NOT percentages) — whole numbers read straight
// off the endgame scoreboard, stored in their own columns rather than
// squeezed into the accuracy slots, which are averaged across heroes.
export const RAW_STAT_FIELDS: Record<string, { key: 'torpedo_damage' | 'torpedo_healing'; label: string }[]> = {
  Juno: [
    { key: 'torpedo_damage', label: 'Torpedo Damage' },
    { key: 'torpedo_healing', label: 'Torpedo Healing' },
  ],
};

// Labels of tiles the user picked for a hero's slot (server: hero_tile_picks, GET /api/scoreboards/tile-picks).
// A pick wins over the static maps above, which stay the defaults for heroes nobody picked for. The picks are
// NOT held in a module variable: components load them with useTilePicks (a useApi hook, so revalidateAll
// refreshes it) and pass them in. A None pick has a null label and changes nothing.
export type SlotKey = 'overall' | 'crit' | 'extra';
export type TilePickLabels = Record<string, Partial<Record<SlotKey, string | null>>>;
export const picksToLabels = (rows: { hero: string; slot: SlotKey; label: string | null }[]): TilePickLabels => {
  const out: TilePickLabels = {};
  for (const r of rows) (out[r.hero] ??= {})[r.slot] = r.label;
  return out;
};
const pickLabel = (hero: string, slot: SlotKey, picks?: TilePickLabels) => picks?.[hero]?.[slot] ?? null;
const pickSlot = (label: string) => ({ label, aria: label.replace(/\s*%$/, '').toLowerCase() });

export const overallSlot = (hero: string, picks?: TilePickLabels) => {
  const p = pickLabel(hero, 'overall', picks);
  return p ? pickSlot(p) : OVERALL_SLOT_LABEL[hero] ?? { label: 'Overall %', aria: 'overall accuracy' };
};

export const critSlot = (hero: string, picks?: TilePickLabels) => {
  const p = pickLabel(hero, 'crit', picks);
  return p ? pickSlot(p) : CRIT_SLOT_LABEL[hero] ?? { label: 'Crit %', aria: 'crit accuracy' };
};

/** The 4th slot's label: a pick, else the static label, else null (the hero has no extra field). */
export const extraSlot = (hero: string, picks?: TilePickLabels): string | null =>
  pickLabel(hero, 'extra', picks) ?? EXTRA_ACC_LABEL[hero] ?? null;

export const hasCrit = (hero: string) => !NO_CRIT_HEROES.has(hero);

// Same as critSlot().label with the trailing unit stripped — for table cells
// and chips where "%" is already implied by the value next to it, so a column
// reads "Sleep Dart" rather than "Sleep Dart Accuracy %  41.4%".
export const critSlotShort = (hero: string, picks?: TilePickLabels) =>
  critSlot(hero, picks).label.replace(/\s*(Accuracy\s*)?%\(?\+?\)?$/, '').trim();

export const extraSlotShort = (hero: string, picks?: TilePickLabels) => {
  const l = extraSlot(hero, picks);
  return l ? l.replace(/\s*(Accuracy\s*)?%$/, '').trim() : null;
};
