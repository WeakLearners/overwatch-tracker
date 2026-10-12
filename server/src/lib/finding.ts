// The lab "Finding": one rate, its interval, and a verdict that survives a
// multiple-comparison correction. Spec: design-language.md section 5.
//
// A group is compared with the rest of the same population (two-proportion z
// test). The correction is Bonferroni over the groups that were testable at
// all (n >= minN). Below minN the group is "thin" and is not tested.

// 'none' = tested, no difference at p < 0.05. The spec has no chip for it.
export type FindingVerdict = 'holds' | 'unreliable' | 'thin' | 'none';

export interface Finding {
  rate: number;          // percent, one decimal
  lo: number;            // 95% Wilson interval, percent
  hi: number;
  n: number;
  p: number | null;      // two-sided, uncorrected; null when thin
  threshold: number;     // 0.05 / groupsTested
  groupsTested: number;
  verdict: FindingVerdict;
}

export const FINDING_ALPHA = 0.05;
export const FINDING_MIN_N = 10;

const Z95 = 1.959964;

// Standard normal CDF (Abramowitz and Stegun 26.2.17, error under 1e-7).
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const tail = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z >= 0 ? 1 - tail : tail;
}

export function wilsonInterval(wins: number, n: number): { lo: number; hi: number } {
  if (n <= 0) return { lo: 0, hi: 0 };
  const p = wins / n;
  const z2 = Z95 * Z95;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (Z95 * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - half) * 100, hi: Math.min(1, centre + half) * 100 };
}

// Two-sided p for "this group's win rate differs from the rest of the games".
export function twoProportionP(wins: number, n: number, restWins: number, restN: number): number | null {
  if (n <= 0 || restN <= 0) return null;
  const pooled = (wins + restWins) / (n + restN);
  const se = Math.sqrt(pooled * (1 - pooled) * (1 / n + 1 / restN));
  if (se === 0) return 1;
  const z = (wins / n - restWins / restN) / se;
  return Math.min(1, 2 * (1 - normalCdf(Math.abs(z))));
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export function makeFinding(
  group: { wins: number; n: number },
  rest: { wins: number; n: number },
  groupsTested: number,
  minN: number = FINDING_MIN_N,
): Finding {
  const groups = Math.max(1, groupsTested);
  const threshold = FINDING_ALPHA / groups;
  const { lo, hi } = wilsonInterval(group.wins, group.n);
  const base = {
    rate: round1(group.n > 0 ? (group.wins / group.n) * 100 : 0),
    lo: round1(lo), hi: round1(hi), n: group.n, threshold, groupsTested: groups,
  };
  if (group.n < minN) return { ...base, p: null, verdict: 'thin' };
  const p = twoProportionP(group.wins, group.n, rest.wins, rest.n);
  if (p === null) return { ...base, p: null, verdict: 'thin' };
  const verdict: FindingVerdict = p < threshold ? 'holds' : p < FINDING_ALPHA ? 'unreliable' : 'none';
  return { ...base, p, verdict };
}
