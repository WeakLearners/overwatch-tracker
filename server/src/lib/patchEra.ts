// Game-patch eras for the sensitivity study.
//
// RULE (Sean, 2026-10-10, reversing the 2026-10-09 split): the study compares
// arms and stages as if every match were on the same patch. All matches are
// pooled as one period. No comparison is restricted to one era, and no
// baseline is cut at a patch date. A game patch can still change accuracy (for
// example 2026-10-06 changed hitbox and projectile size), so this file keeps
// the boundaries as a NOTE, not a gate: the before/after match counts
// (eraCounts) and a short label per boundary (PATCH_BOUNDARIES). Wherever a
// comparison holds matches from both sides of a boundary, the UI and the
// nightly report print the label for that boundary (spannedPatchNotes).
// See projects/overwatch-lab/game-changes.md.
//
// A patch date is a LOCAL match date (matches.date, 'YYYY-MM-DD'). A match on
// the patch date counts as after the patch. A future patch is one new entry in
// PATCH_BOUNDARIES and one in PATCH_LABELS (same index).
export const PATCH_BOUNDARIES: readonly string[] = ['2026-10-06'];

// What changed at each boundary, same order as PATCH_BOUNDARIES. This is the
// ONE place the patch description lives.
export const PATCH_LABELS: readonly string[] = ['hitbox and projectile size change'];

// 0 = before the first boundary, 1 = on/after it, 2 = on/after the second...
export function patchEra(date: string): number {
  let era = 0;
  for (const b of PATCH_BOUNDARIES) if (date >= b) era++;
  return era;
}

export const ERA_COUNT = PATCH_BOUNDARIES.length + 1;

// Match counts per era, e.g. [120, 8] = 120 before, 8 on/after the patch.
export function eraCounts(dates: Iterable<string>): number[] {
  const out = new Array<number>(ERA_COUNT).fill(0);
  for (const d of dates) out[patchEra(d)]++;
  return out;
}

export function eraSplitLabel(counts: number[]): string {
  return counts.join(' / ');
}

// "10-06" from "2026-10-06", for short labels.
const mmdd = (iso: string) => iso.slice(5);

// One short note per boundary that has matches on BOTH sides, e.g.
// ["Spans the 10-06 patch (hitbox and projectile size change)"]. Empty when
// every match is on one side.
export function spannedPatchNotes(counts: number[]): string[] {
  const out: string[] = [];
  PATCH_BOUNDARIES.forEach((b, i) => {
    const before = counts.slice(0, i + 1).reduce((s, n) => s + n, 0);
    const after = counts.slice(i + 1).reduce((s, n) => s + n, 0);
    if (before > 0 && after > 0) out.push(`Spans the ${mmdd(b)} patch (${PATCH_LABELS[i]})`);
  });
  return out;
}

// "before/after 10-06: 5/0", for the nightly report.
export function eraCountsText(counts: number[]): string {
  const ds = PATCH_BOUNDARIES.map(mmdd).join(', ');
  return `before/after ${ds}: ${counts.join('/')}`;
}
