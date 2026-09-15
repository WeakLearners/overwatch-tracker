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
};

// Per-hero override for the crit_acc slot — heroes whose kit doesn't map
// cleanly onto "Crit %" repurpose the same underlying field.
export const CRIT_SLOT_LABEL: Record<string, { label: string; aria: string }> = {
  Ana: { label: 'Sleep Dart Accuracy %', aria: 'sleep dart accuracy' },
  Sojourn: { label: 'Charged Shot %', aria: 'charged shot accuracy' },
  Pharah: { label: 'Direct Hit %', aria: 'direct hit accuracy' },
  Zenyatta: { label: 'Charged Volley %', aria: 'charged volley accuracy' },
  Baptiste: { label: 'Healing %(+)', aria: 'healing accuracy' },
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
// their row entirely rather than relabelled (Juno's kit has no crit reading).
export const NO_CRIT_HEROES = new Set(['Juno']);

// Per-hero raw-count fields (NOT percentages) — whole numbers read straight
// off the endgame scoreboard, stored in their own columns rather than
// squeezed into the accuracy slots, which are averaged across heroes.
export const RAW_STAT_FIELDS: Record<string, { key: 'torpedo_damage' | 'torpedo_healing'; label: string }[]> = {
  Juno: [
    { key: 'torpedo_damage', label: 'Torpedo Damage' },
    { key: 'torpedo_healing', label: 'Torpedo Healing' },
  ],
};

export const overallSlot = (hero: string) =>
  OVERALL_SLOT_LABEL[hero] ?? { label: 'Overall %', aria: 'overall accuracy' };

export const critSlot = (hero: string) =>
  CRIT_SLOT_LABEL[hero] ?? { label: 'Crit %', aria: 'crit accuracy' };

export const hasCrit = (hero: string) => !NO_CRIT_HEROES.has(hero);

// Same as critSlot().label with the trailing unit stripped — for table cells
// and chips where "%" is already implied by the value next to it, so a column
// reads "Sleep Dart" rather than "Sleep Dart Accuracy %  41.4%".
export const critSlotShort = (hero: string) =>
  critSlot(hero).label.replace(/\s*(Accuracy\s*)?%\(?\+?\)?$/, '').trim();

export const extraSlotShort = (hero: string) => {
  const l = EXTRA_ACC_LABEL[hero];
  return l ? l.replace(/\s*(Accuracy\s*)?%$/, '').trim() : null;
};
