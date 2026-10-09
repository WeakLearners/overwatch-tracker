// Game-patch eras for the sensitivity study (Sean, 2026-10-09).
//
// Accuracy before and after a patch that changes hitscan projectile size or hit
// volumes is not comparable, for ANY hero. So the study never compares an
// arm's accuracy from one era with another arm's accuracy from a different
// era. Every arm-vs-arm accuracy difference is computed inside one era, then
// pooled. See projects/overwatch-lab/game-changes.md.
//
// A patch date is a LOCAL match date (matches.date, 'YYYY-MM-DD'). A match on
// the patch date counts as after the patch. A future patch is one new entry.
export const PATCH_BOUNDARIES: readonly string[] = ['2026-10-06'];

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

export interface EraObs { era: number; v: number }

const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
const sampleVar = (xs: number[]) => {
  const m = mean(xs);
  return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
};

export interface EraDiff {
  // Pooled A minus B, or null when no era holds both arms.
  diff: number | null;
  // Eras that held both arms, with each era's own difference and counts.
  eras: { era: number; diff: number; nA: number; nB: number }[];
  // Pooled Welch t over the eras where both arms have >= 3 matches, else null.
  t: number | null;
}

// Within-era difference of two arms. The difference is taken inside each era
// where BOTH arms have data, then pooled. An arm that has data in only one era
// is compared only with the other arm's data in that same era; unmatched eras
// contribute nothing, so an era-wide shift cannot leak into the difference.
//
// Pooled difference: weights nA*nB/(nA+nB), a match-count weight (equal to the
// inverse variance when spread is equal). Pooled t: inverse-variance weights
// from each era's Welch standard error, eras with 3+ matches on both sides.
export function withinEraDiff(a: EraObs[], b: EraObs[]): EraDiff {
  const eras: EraDiff['eras'] = [];
  let wSum = 0, wdSum = 0;
  let ivSum = 0, ivdSum = 0, ivUsed = 0;
  for (let e = 0; e < ERA_COUNT; e++) {
    const va = a.filter(o => o.era === e).map(o => o.v);
    const vb = b.filter(o => o.era === e).map(o => o.v);
    if (!va.length || !vb.length) continue;
    const d = mean(va) - mean(vb);
    eras.push({ era: e, diff: d, nA: va.length, nB: vb.length });
    const w = (va.length * vb.length) / (va.length + vb.length);
    wSum += w; wdSum += w * d;
    if (va.length >= 3 && vb.length >= 3) {
      const se2 = sampleVar(va) / va.length + sampleVar(vb) / vb.length;
      if (isFinite(se2) && se2 > 0) { ivSum += 1 / se2; ivdSum += d / se2; ivUsed++; }
    }
  }
  return {
    diff: wSum > 0 ? wdSum / wSum : null,
    eras,
    t: ivUsed > 0 ? (ivdSum / ivSum) / Math.sqrt(1 / ivSum) : null,
  };
}

// Era-adjusted mean per arm, for fitting a curve through several arms. Each
// observation is shifted by its era's mean (over the arms that share that era)
// back to the overall mean of the used observations. With one era this is the
// plain arm mean. Only eras where 2+ arms have data are used, so an arm whose
// only data sits in an era no other arm shares gets null (no valid comparison).
export function eraAdjustedMeans<K>(obs: { arm: K; era: number; v: number }[]): Map<K, { n: number; mean: number } | null> {
  const arms = new Set(obs.map(o => o.arm));
  const usable = new Set<number>();
  for (let e = 0; e < ERA_COUNT; e++) {
    const inEra = new Set(obs.filter(o => o.era === e).map(o => o.arm));
    if (inEra.size >= 2 || arms.size === 1) usable.add(e);
  }
  const used = obs.filter(o => usable.has(o.era));
  const out = new Map<K, { n: number; mean: number } | null>();
  if (!used.length) { for (const k of arms) out.set(k, null); return out; }
  const grand = mean(used.map(o => o.v));
  const eraMean = new Map<number, number>();
  for (const e of usable) eraMean.set(e, mean(used.filter(o => o.era === e).map(o => o.v)));
  for (const k of arms) {
    const mine = used.filter(o => o.arm === k);
    out.set(k, mine.length ? { n: mine.length, mean: mean(mine.map(o => o.v - (eraMean.get(o.era) as number) + grand)) } : null);
  }
  return out;
}
