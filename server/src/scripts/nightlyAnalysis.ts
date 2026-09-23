// Analysis layer for the nightly Slack report.
//
// The report used to be a pure state dump (who played what, how far each set
// has progressed). That answers "what happened" but not the only question the
// study actually exists to answer: *is the bracket telling us anything yet, and
// is it trustworthy?* Everything here is built to answer that WITHOUT
// manufacturing signal — this study has already had one round of map/hour
// "key patterns" retired as small-sample noise, so every claim below carries
// its own n and refuses to speak when the n is too thin.
//
// Two framing rules are load-bearing, not stylistic:
//   1. Sensitivity is a Goldilocks problem, not a "faster is better" gradient.
//      A bracket with no interior peak is UNRESOLVED, never "trending toward
//      the fast end" — that phrasing invents a direction the data doesn't have.
//   2. Bracket changes must be data-justified. This module reports what the
//      curve looks like; it never recommends narrowing or recentering on
//      convention alone.
import { fitQuadraticPeak, CurvePoint } from '../lib/aim';
import { NOT_QP_SQL } from '../lib/blind';

// A stage needs this many credited games before its mean accuracy is stable
// enough to be a point in the fit. Below it the point is dropped from the
// curve (not zero-filled — an absent stage is missing data, not a low score).
export const MIN_GAMES_PER_STAGE = 3;
// A quadratic through 3 points with almost no weight behind them will fit
// perfectly and mean nothing. Require real volume before reporting any read.
export const MIN_TOTAL_FOR_READ = 12;
// Trailing window for "is today unusual for this hero", and the minimum
// baseline sample before today's number gets compared to anything at all.
export const BASELINE_DAYS = 30;
export const MIN_BASELINE_N = 8;

export interface StagePoint {
  stage_index: number;
  sens: number | null;
  dpi: number;
  n: number;
  meanAcc: number | null;
  winRate: number | null;
}

// Per-stage aggregates for one set, joining the credited games to their stage's
// tested sens/dpi and to whatever accuracy was logged for that hero in that
// match. LEFT JOIN on aim_stats_heroes deliberately: a match with no accuracy
// row still counts toward the stage's game count (it really was played), it
// just contributes nothing to the accuracy mean.
// Excludes QP-credited rows (lib/blind.ts's isStudyQueueMode / NOT_QP_SQL) —
// see the 469-row note on that function. This feeds readBracket, so a
// historical set's bracket read never counts a QP-credited game as if it
// were Competitive.
export function stagePointsFor(db: any, setId: number): StagePoint[] {
  return db.prepare(`
    SELECT bs.stage_index      AS stage_index,
           bs.sens             AS sens,
           bs.dpi              AS dpi,
           COUNT(*)            AS n,
           AVG(ash.overall_acc) AS meanAcc,
           AVG(m.win)          AS winRate
    FROM blind_credits bc
    JOIN blind_stages bs
      ON bs.set_id = bc.blind_set_id AND bs.stage_index = bc.stage_index
    JOIN matches m ON m.id = bc.match_id
    LEFT JOIN aim_stats_heroes ash
      ON ash.match_id = bc.match_id AND ash.hero = bc.hero
    WHERE bc.blind_set_id = :setId AND ${NOT_QP_SQL}
    GROUP BY bs.stage_index, bs.sens, bs.dpi
    ORDER BY bs.stage_index
  `).all({ setId }) as unknown as StagePoint[];
}

// Raw per-match accuracy values for one stage, needed for a real two-sample
// test — means alone can't tell a 4-point gap backed by tight spread from a
// 4-point gap that's pure coin-flip.
// Same QP exclusion as stagePointsFor above, so the two-sample Welch's t-test
// in readBracket sees the same population its means were computed from.
export function stageSamplesFor(db: any, setId: number, stageIndex: number): number[] {
  return (db.prepare(`
    SELECT ash.overall_acc AS acc
    FROM blind_credits bc
    JOIN aim_stats_heroes ash
      ON ash.match_id = bc.match_id AND ash.hero = bc.hero
    JOIN matches m ON m.id = bc.match_id
    WHERE bc.blind_set_id = :setId AND bc.stage_index = :si
      AND ash.overall_acc IS NOT NULL AND ${NOT_QP_SQL}
  `).all({ setId, si: stageIndex }) as { acc: number }[]).map(r => r.acc);
}

// Welch's t-test (unequal variances) — the honest test for "are these two
// stages actually different", not just "is one number bigger". Returns null
// when either side is too small to have a variance worth testing. No p-value
// lookup table here: |t| >= 2 is the reporting bar, roughly p<0.05 at these
// sample sizes, and deliberately blunt because anything finer would imply a
// precision this data doesn't have.
export function welchT(a: number[], b: number[]): number | null {
  if (a.length < 3 || b.length < 3) return null;
  const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
  const varOf = (xs: number[]) => {
    const m = mean(xs);
    return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
  };
  const va = varOf(a), vb = varOf(b);
  const se = Math.sqrt(va / a.length + vb / b.length);
  if (!isFinite(se) || se === 0) return null;
  return (mean(a) - mean(b)) / se;
}

export type BracketVerdict =
  | { kind: 'thin'; totalN: number; usableStages: number }
  | { kind: 'head2head'; totalN: number; hi: StagePoint; lo: StagePoint; t: number | null }
  | { kind: 'unresolved'; totalN: number; reason: string }
  | { kind: 'peak'; totalN: number; optimalX: number; r2: number; inRange: boolean };

// Reads the accuracy-vs-sens curve for one set. Returns a verdict, never a
// recommendation — deciding what to do about a peak is Sean's call, and a
// bracket change needs its own evidence beyond "the curve moved".
export function readBracket(
  points: StagePoint[],
  samples?: Record<number, number[]>,
): BracketVerdict {
  // Only stages that (a) vary a sens value we can put on an x-axis and (b)
  // have enough games and an actual accuracy mean can enter the fit.
  const usable = points.filter(
    p => p.sens != null && p.n >= MIN_GAMES_PER_STAGE && p.meanAcc != null
  );
  const totalN = usable.reduce((s, p) => s + p.n, 0);
  // A 2-stage bracket is an A/B test, not a curve — fitQuadraticPeak needs 3+
  // distinct x values and would reject it forever. Test it as what it is.
  // Caller supplies the raw samples; without them we can only compare means.
  if (usable.length === 2) {
    const [x, y] = usable;
    const [hi, lo] = (x.meanAcc as number) >= (y.meanAcc as number) ? [x, y] : [y, x];
    const t = samples
      ? welchT(samples[hi.stage_index] ?? [], samples[lo.stage_index] ?? [])
      : null;
    return { kind: 'head2head', totalN, hi, lo, t };
  }
  if (usable.length < 3 || totalN < MIN_TOTAL_FOR_READ) {
    return { kind: 'thin', totalN, usableStages: usable.length };
  }
  // Weight each stage by its game count so a stage with 10 games pulls harder
  // than one with 3 — the same weighting the in-app curve fit uses.
  const pts: CurvePoint[] = usable.map(p => ({
    x: p.sens as number, y: p.meanAcc as number, w: p.n,
  }));
  const fit = fitQuadraticPeak(pts);
  if (!fit) {
    return { kind: 'unresolved', totalN, reason: 'curve fit failed (degenerate spread)' };
  }
  if (!fit.hasInteriorPeak) {
    // a >= 0: the parabola opens upward, so its vertex is the WORST point in
    // the range, not the best. There is no peak here to report. Saying the
    // bracket "leans fast" or "leans slow" would be inventing a direction.
    return {
      kind: 'unresolved', totalN,
      reason: 'no interior peak — the tested range does not bracket a best value yet',
    };
  }
  return {
    kind: 'peak', totalN,
    optimalX: fit.optimalX as number, r2: fit.r2, inRange: fit.inRange,
  };
}

export function describeBracket(hero: string | null, v: BracketVerdict): string {
  const who = hero ?? 'unnamed set';
  switch (v.kind) {
    case 'head2head': {
      const gap = (v.hi.meanAcc as number) - (v.lo.meanAcc as number);
      const hiS = v.hi.sens != null ? v.hi.sens.toFixed(3) : `dpi ${v.hi.dpi}`;
      const loS = v.lo.sens != null ? v.lo.sens.toFixed(3) : `dpi ${v.lo.dpi}`;
      // Two stages can only ever say "this one looks better", never "the best
      // value is here" — the peak could sit outside both. Say so explicitly.
      if (v.t == null) {
        return `• ${who}: ${hiS} leads ${loS} by ${gap.toFixed(1)}pt (n=${v.hi.n} vs ${v.lo.n}) — too thin to test, treat as noise for now.`;
      }
      const verdict = Math.abs(v.t) >= 2
        ? `separating (t=${v.t.toFixed(1)})`
        : `NOT separating (t=${v.t.toFixed(1)}) — indistinguishable so far`;
      return `• ${who}: ${hiS} over ${loS} by ${gap.toFixed(1)}pt (n=${v.hi.n} vs ${v.lo.n}) — ${verdict}. 2-stage A/B: ranks the two tested values, cannot locate a peak.`;
    }
    case 'thin':
      return `• ${who}: not enough yet to read — ${v.usableStages} stage${v.usableStages === 1 ? '' : 's'} with ${MIN_GAMES_PER_STAGE}+ games (n=${v.totalN}).`;
    case 'unresolved':
      return `• ${who}: unresolved (n=${v.totalN}) — ${v.reason}.`;
    case 'peak': {
      const conf = v.r2 >= 0.5 ? 'clean fit' : 'loose fit';
      return v.inRange
        ? `• ${who}: peak near sens ${v.optimalX.toFixed(3)} (r²=${v.r2.toFixed(2)}, ${conf}, n=${v.totalN}).`
        : `• ${who}: vertex falls OUTSIDE the tested range (r²=${v.r2.toFixed(2)}, n=${v.totalN}) — treat as unresolved, the bracket may not contain the best value.`;
    }
  }
}

export interface BaselineRead {
  hero: string;
  todayN: number;
  todayAcc: number | null;
  baseN: number;
  baseAcc: number | null;
  baseSd: number | null;
  unusual: 'high' | 'low' | null;
}

// "Was today weird for this hero?" — today's mean accuracy against the same
// hero's trailing baseline. Flags an outlier only at 1.5+ standard deviations
// AND with a real baseline behind it; anything less is day-to-day variance and
// gets reported as normal rather than dressed up as a trend.
export function baselineFor(db: any, hero: string, today: string): BaselineRead {
  const t = db.prepare(`
    SELECT COUNT(ash.overall_acc) n, AVG(ash.overall_acc) acc
    FROM aim_stats_heroes ash
    JOIN matches m ON m.id = ash.match_id
    WHERE m.date = :today AND ash.hero = :hero
  `).get({ today, hero }) as { n: number; acc: number | null };

  const rows = db.prepare(`
    SELECT ash.overall_acc AS acc
    FROM aim_stats_heroes ash
    JOIN matches m ON m.id = ash.match_id
    WHERE ash.hero = :hero
      AND ash.overall_acc IS NOT NULL
      AND m.date < :today
      AND m.date >= date(:today, :window)
  `).all({ hero, today, window: `-${BASELINE_DAYS} days` }) as { acc: number }[];

  const baseN = rows.length;
  let baseAcc: number | null = null, baseSd: number | null = null;
  if (baseN > 0) {
    baseAcc = rows.reduce((s, r) => s + r.acc, 0) / baseN;
    baseSd = Math.sqrt(rows.reduce((s, r) => s + (r.acc - (baseAcc as number)) ** 2, 0) / baseN);
  }
  let unusual: 'high' | 'low' | null = null;
  if (t.acc != null && baseAcc != null && baseSd != null && baseSd > 0 && baseN >= MIN_BASELINE_N) {
    const z = (t.acc - baseAcc) / baseSd;
    if (z >= 1.5) unusual = 'high';
    else if (z <= -1.5) unusual = 'low';
  }
  return { hero, todayN: t.n, todayAcc: t.acc, baseN, baseAcc, baseSd, unusual };
}

export function describeBaseline(b: BaselineRead): string {
  if (b.todayAcc == null || b.todayN === 0) {
    return `• ${b.hero}: no accuracy logged today — nothing to compare.`;
  }
  if (b.baseN < MIN_BASELINE_N) {
    return `• ${b.hero}: ${b.todayAcc.toFixed(1)}% today (n=${b.todayN}) — baseline too thin to compare (${b.baseN} prior games in ${BASELINE_DAYS}d).`;
  }
  const delta = b.todayAcc - (b.baseAcc as number);
  const sign = delta >= 0 ? '+' : '';
  const tail = b.unusual
    ? ` — ${b.unusual === 'high' ? 'unusually high' : 'unusually low'} vs the ${BASELINE_DAYS}d baseline`
    : ' — within normal range';
  return `• ${b.hero}: ${b.todayAcc.toFixed(1)}% today (n=${b.todayN}) vs ${(b.baseAcc as number).toFixed(1)}% baseline (n=${b.baseN}), ${sign}${delta.toFixed(1)}pt${tail}.`;
}

// ── Whole-metric sweep ──────────────────────────────────────────────────────
// Everything above reads ONE thing: the accuracy bracket. That is the study's
// headline question, but it is not the only question the logged data can
// answer — damage, healing, elims and deaths per 10 minutes are recorded on
// roughly a thousand study points and relate to sens just as legitimately.
//
// This sweep exists so nobody has to think to ask. It runs every metric
// against sens for every hero on every nightly pass and reports whatever
// clears the bar. The alternative — waiting for someone to wonder whether
// healing rate might track sensitivity — is exactly how 618 ability readings
// sat unanalysed for months.
//
// The bar is deliberately conservative. This study has already retired one
// round of map/hour "key patterns" as small-sample noise, and a sweep across
// many metrics x many heroes is precisely the setup that manufactures false
// findings: test enough pairs and something always looks significant. Hence
// all three gates below, together, and a finding is still phrased as a lead.
export const SWEEP_MIN_R2 = 0.25;     // below this the line explains nothing
export const SWEEP_MIN_N = 30;        // games behind the fit
export const SWEEP_MIN_SCALES = 4;    // distinct tested sens values

export interface SweepFinding {
  hero: string; metric: string; spanDelta: number; r2: number; n: number;
  sensMin: number; sensMax: number; lowerIsBetter: boolean;
}

// Takes the already-computed analysis object rather than a db handle, so the
// nightly job and the analysis page can never disagree about what a finding is.
export function sweepFindings(analysis: {
  heroes: { hero: string; metricTrends: {
    key: string; label: string; spanDelta: number | null; r2: number | null;
    totalN: number; scales: number; sensMin: number | null; sensMax: number | null;
    lowerIsBetter: boolean;
  }[] }[];
}): SweepFinding[] {
  return analysis.heroes.flatMap(h =>
    (h.metricTrends ?? [])
      .filter(t => t.r2 != null && t.r2 >= SWEEP_MIN_R2
        && t.totalN >= SWEEP_MIN_N && t.scales >= SWEEP_MIN_SCALES
        && t.spanDelta != null && t.sensMin != null && t.sensMax != null)
      .map(t => ({
        hero: h.hero, metric: t.label,
        spanDelta: t.spanDelta as number, r2: t.r2 as number,
        n: t.totalN, sensMin: t.sensMin as number, sensMax: t.sensMax as number,
        lowerIsBetter: t.lowerIsBetter,
      })),
  ).sort((a, b) => b.r2 - a.r2);
}

export function describeSweep(findings: SweepFinding[]): string[] {
  if (findings.length === 0) {
    return [`• nothing clears the bar (R²≥${SWEEP_MIN_R2}, n≥${SWEEP_MIN_N}, ${SWEEP_MIN_SCALES}+ scales). No metric is tracking sens strongly enough to act on.`];
  }
  return findings.map(f => {
    const dir = f.spanDelta > 0 ? 'rises' : 'falls';
    const good = f.lowerIsBetter ? f.spanDelta < 0 : f.spanDelta > 0;
    const mag = Math.abs(f.spanDelta) >= 100
      ? Math.round(Math.abs(f.spanDelta)).toLocaleString()
      : Math.abs(f.spanDelta).toFixed(2);
    return `• *${f.hero}* — ${f.metric} ${dir} by ${mag} from ${f.sensMin.toFixed(2)} to ${f.sensMax.toFixed(2)} sens ${good ? '✅' : '⚠️'} (R²=${f.r2.toFixed(2)}, n=${f.n}). Lead, not a verdict.`;
  });
}
