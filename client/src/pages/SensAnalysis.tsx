import {
  ResponsiveContainer, ScatterChart, Scatter, LabelList,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ReferenceLine,
} from 'recharts';
import { useApi } from '../hooks/useApi';
import SensNav from '../components/SensNav';
import { MOUSE_DPI } from '../lib/aim';
import { useTodayHeroCounts, withHeroCount } from '../hooks/useHeroCounts';

interface ScaleRow {
  cm360: number; eDPI: number; sens: number; n: number;
  avgOverall: number | null; avgCrit: number | null;
  avgFeel: number | null; avgDelta: number | null;
}
interface Bucket {
  bucket: string; n: number;
  avgOverall: number | null; avgDelta: number | null; avgFeel: number | null;
}
interface HeroRow {
  hero: string; archetype: string; n: number;
  avgOverall: number | null; avgCrit: number | null;
  bestScaleEDPI: number; bestScaleN: number;
  bestScaleOverallDelta: number | null; bestScaleCritDelta: number | null;
}
interface Analysis {
  summary: { n: number; distinctScale: number; maskedPending: number; lastUpdated: string | null };
  byScale: ScaleRow[];
  byArchetype: { hitscan: ScaleRow[]; projectile: ScaleRow[] };
  coldWarm: Bucket[];
  adaptation: Bucket[];
  heroes: HeroRow[];
}

const HITSCAN = '#3b82f6';
const PROJECTILE = '#ec4899';
const FEEL = '#8b5cf6';

// created_at is stored as a bare UTC datetime('now') string (no 'Z'); append
// it before parsing so the browser doesn't mistake it for local time.
const fmtUpdated = (iso: string | null) =>
  iso == null ? null : new Date(iso + 'Z').toLocaleString(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  });

const f1 = (x: number | null | undefined) => (x == null ? '—' : x.toFixed(1));
const signed = (x: number | null | undefined) =>
  x == null ? '—' : `${x > 0 ? '+' : ''}${x.toFixed(1)}`;
// -500 fails WCAG AA text contrast (4.5:1) on the light card surface — -700
// clears it; dark mode swaps back to -500/-400, which already clear it there.
const deltaColor = (x: number | null | undefined) =>
  x == null ? '' : x > 0 ? 'text-emerald-700 dark:text-emerald-500' : x < 0 ? 'text-red-700 dark:text-red-400' : '';

// A symmetric [-max, max] domain so 0 sits at the vertical center of a delta
// axis instead of wherever the data happens to land — makes "above vs. below
// baseline" a visual split down the middle rather than a number to compare.
const symmetricDomain = (vals: (number | null | undefined)[]): [number, number] => {
  const max = Math.max(0, ...vals.filter((v): v is number => v != null).map(v => Math.abs(v)));
  const padded = max * 1.1 || 1;
  return [-padded, padded];
};

// A domain centered on `center`, spanning the farthest point from it (+10%
// pad), so a crosshair drawn at `center` lands at the plot's midpoint — the
// basis for the four-quadrant Feel vs. Data view.
const centeredDomain = (vals: (number | null | undefined)[], center: number): [number, number] => {
  const r = Math.max(0, ...vals.filter((v): v is number => v != null).map(v => Math.abs(v - center)));
  const pad = r * 1.15 || 1;
  return [center - pad, center + pad];
};

// n-weighted mean of a bucket field — reconstructs the grand mean across the
// underlying matches from the per-scale aggregates (avg × n = bucket sum).
const wMean = (rows: ScaleRow[], key: 'avgFeel' | 'avgDelta'): number => {
  const valid = rows.filter(r => r[key] != null);
  const totalN = valid.reduce((s, r) => s + r.n, 0);
  return totalN ? valid.reduce((s, r) => s + (r[key] as number) * r.n, 0) / totalN : 0;
};

// Custom tooltip for the Feel vs. Data quadrant chart — the point identity is
// its sens scale, which neither axis carries, so the default two-axis readout
// isn't enough.
function QuadrantTooltip({ active, payload }: { active?: boolean; payload?: { payload: ScaleRow & { sensAt1600: number } }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div style={{ background: 'var(--ow-card)', border: '1px solid var(--ow-border)', borderRadius: 8, fontSize: 12, padding: '6px 10px' }}>
      <div style={{ fontWeight: 600 }}>{p.sensAt1600.toFixed(2)} sens @ {MOUSE_DPI} DPI</div>
      <div>Felt speed: {f1(p.avgFeel)}/10</div>
      <div>Accuracy Δ: {signed(p.avgDelta)}</div>
      <div style={{ opacity: 0.7 }}>n={p.n}</div>
    </div>
  );
}

// Page-wide standard of measure: in-game sens once the mouse is back at
// MOUSE_DPI. DPI is only ever the hidden variable for blinding (a physical
// mouse-stage switch is easier to hide than an in-game sens change) — the
// mouse settles at MOUSE_DPI once a result is committed to, so eDPI ÷
// MOUSE_DPI is the sens that will actually get dialed in. Also fixes cm/360's
// backwards direction (there, lower means faster); this way, higher = faster.
const sensAt1600 = (r: { eDPI: number }) => r.eDPI / MOUSE_DPI;
const fmtScale = (r: { eDPI: number }) => `${sensAt1600(r).toFixed(2)} sens (@${MOUSE_DPI} DPI)`;
function bySpeed<T extends { eDPI: number }>(rows: T[]): (T & { sensAt1600: number })[] {
  return rows.map(r => ({ ...r, sensAt1600: sensAt1600(r) })).sort((a, b) => a.sensAt1600 - b.sensAt1600);
}

// Card wrapper with a title and one-line explanation of how to read it.
function Section({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <div className="card">
      <h2 className="text-sm heading-display text-[var(--ink)]">{title}</h2>
      <p className="text-xs text-[var(--faint)] mt-1 mb-4">{hint}</p>
      {children}
    </div>
  );
}

const axisStyle = { fontSize: 11, fill: 'var(--faint)' };

const RELIABLE_N = 4;
const CONFIDENT_N = 8;

interface Recommendation {
  verdict: 'continue' | 'narrow';
  headline: string;
  points: string[];
}

// Suggests a DPI from the current data and decides whether the test should
// keep exploring or converge. "Continue" fires when the leading scale sits at
// the edge of what's been tried (no bracketed peak yet), is still thin (n <
// CONFIDENT_N), or is only narrowly ahead of a runner-up. "Narrow" only fires
// once a scale is beaten on both sides by worse-but-reliable neighbors.
function buildRecommendation(data: Analysis): Recommendation {
  const reliable = bySpeed(data.byScale.filter(r => r.n >= RELIABLE_N)); // ascending: slowest -> fastest

  if (reliable.length < 3) {
    return {
      verdict: 'continue',
      headline: 'Not enough tested scales yet to recommend a DPI.',
      points: [
        `Only ${reliable.length} scale${reliable.length === 1 ? '' : 's'} ${reliable.length === 1 ? 'has' : 'have'} n≥${RELIABLE_N} logged games — spread more reps across scales before narrowing in.`,
      ],
    };
  }

  const best = reliable.reduce((a, b) => ((b.avgDelta ?? -Infinity) > (a.avgDelta ?? -Infinity) ? b : a));
  const bestIdx = reliable.indexOf(best);
  const isSlowEdge = bestIdx === 0;
  const isFastEdge = bestIdx === reliable.length - 1;
  const dpi = Math.round(best.eDPI / best.sens);

  const points: string[] = [];

  if (isSlowEdge || isFastEdge) {
    points.push(
      `That's the ${isFastEdge ? 'fastest' : 'slowest'} scale you've tried — you haven't bracketed a peak yet. Try a ${isFastEdge ? 'higher' : 'lower'} DPI stage in your next blind set to see whether it keeps improving or turns over.`,
    );
  }

  if (best.n < CONFIDENT_N) {
    points.push(`Only n=${best.n} games on it so far — above the noise floor but still thin. A few more reps would firm it up.`);
  }

  const runnerUp = [...reliable].filter(r => r !== best).sort((a, b) => (b.avgDelta ?? -Infinity) - (a.avgDelta ?? -Infinity))[0];
  const gap = runnerUp ? (best.avgDelta ?? 0) - (runnerUp.avgDelta ?? 0) : Infinity;
  if (runnerUp && gap < 2) {
    points.push(
      `${fmtScale(runnerUp)} is close behind at ${signed(runnerUp.avgDelta)}% (n=${runnerUp.n}) — not clearly worse yet, worth keeping in the rotation.`,
    );
  }

  const clearlyWorse = reliable.filter(r => r !== best && r !== runnerUp && (r.avgDelta ?? 0) < -1.5 && r.n >= CONFIDENT_N);
  if (clearlyWorse.length > 0) {
    points.push(
      `${clearlyWorse.map(r => fmtScale(r)).join(', ')} ${clearlyWorse.length === 1 ? 'has' : 'have'} enough reps to call ${clearlyWorse.length === 1 ? 'it' : 'them'} clearly worse (${clearlyWorse.map(r => signed(r.avgDelta)).join(', ')}) — safe to drop from the rotation.`,
    );
  }

  const verdict: 'continue' | 'narrow' =
    isSlowEdge || isFastEdge || best.n < CONFIDENT_N || gap < 2 ? 'continue' : 'narrow';

  if (verdict === 'narrow') {
    points.push('Nothing above contradicts it — worth converging future sessions on this scale and its immediate neighbors to confirm before calling it final.');
  }

  return {
    verdict,
    headline: `Best guess right now: ${fmtScale(best)} (tested at DPI ${dpi}) — ${signed(best.avgDelta)}% vs. baseline, n=${best.n}.`,
    points,
  };
}

// "Meaningfully different" bar for comparing two peak sens values: 20% of the
// spread across all reliably-tested scales, floored at 0.05 sens so a couple
// of thin, closely-tested scales don't read as "different" from rounding
// noise alone. Undefined (Infinity) when there isn't a tested range to judge against.
function sensGapThreshold(reliable: (ScaleRow & { sensAt1600: number })[]): number {
  if (reliable.length < 2) return Infinity;
  const spread = reliable[reliable.length - 1].sensAt1600 - reliable[0].sensAt1600;
  return Math.max(spread * 0.2, 0.05);
}

interface SplitVerdict {
  verdict: 'insufficient' | 'shared' | 'split';
  headline: string;
}

// Answers "would hitscan and projectile benefit from separate sens" — not
// "which one is better." Compares each aim type's own best-performing scale;
// close peaks mean one setting covers both, far-apart peaks mean a split is
// worth testing.
function buildArchetypeVerdict(data: Analysis): SplitVerdict {
  const hit = bySpeed(data.byArchetype.hitscan.filter(r => r.n >= RELIABLE_N));
  const proj = bySpeed(data.byArchetype.projectile.filter(r => r.n >= RELIABLE_N));

  if (hit.length === 0 || proj.length === 0) {
    const which = hit.length === 0 && proj.length === 0 ? 'Hitscan and projectile both' : hit.length === 0 ? 'Hitscan' : 'Projectile';
    return {
      verdict: 'insufficient',
      headline: `${which} still need more reps (n≥${RELIABLE_N} per scale) before a split can be judged.`,
    };
  }

  const bestHit = hit.reduce((a, b) => ((b.avgDelta ?? -Infinity) > (a.avgDelta ?? -Infinity) ? b : a));
  const bestProj = proj.reduce((a, b) => ((b.avgDelta ?? -Infinity) > (a.avgDelta ?? -Infinity) ? b : a));
  const threshold = sensGapThreshold(bySpeed(data.byScale.filter(r => r.n >= RELIABLE_N)));
  const diff = Math.abs(bestHit.sensAt1600 - bestProj.sensAt1600);

  if (diff <= threshold) {
    return {
      verdict: 'shared',
      headline: `Hitscan peaks at ${fmtScale(bestHit)} (${signed(bestHit.avgDelta)}%) and projectile at ${fmtScale(bestProj)} (${signed(bestProj.avgDelta)}%) — close enough that one sens looks like it covers both.`,
    };
  }
  return {
    verdict: 'split',
    headline: `Hitscan peaks at ${fmtScale(bestHit)} (${signed(bestHit.avgDelta)}%) but projectile peaks at ${fmtScale(bestProj)} (${signed(bestProj.avgDelta)}%) — far enough apart that a dedicated sens per aim type may be worth testing.`,
  };
}

interface HeroDivergenceRow { hero: string; archetype: string; sens: number; n: number; delta: number | null; diff: number }
interface HeroDivergence {
  verdict: 'insufficient' | 'uniform' | 'diverge';
  headline: string;
  diverging: HeroDivergenceRow[];
}

// Same split-worth-it question, one level below aim type: every hero aims
// differently, so this checks each hero's OWN best-performing scale against
// the overall best rather than assuming archetype is the only axis that matters.
function buildHeroDivergence(data: Analysis): HeroDivergence {
  const reliable = bySpeed(data.byScale.filter(r => r.n >= RELIABLE_N));
  const eligible = data.heroes.filter(h => h.bestScaleN >= RELIABLE_N);

  if (reliable.length < 2 || eligible.length === 0) {
    return {
      verdict: 'insufficient',
      headline: `No hero has n≥${RELIABLE_N} on its own best scale yet — keep logging before drawing per-hero conclusions.`,
      diverging: [],
    };
  }

  const globalBest = reliable.reduce((a, b) => ((b.avgDelta ?? -Infinity) > (a.avgDelta ?? -Infinity) ? b : a));
  const threshold = sensGapThreshold(reliable);

  const diverging = eligible
    .map(h => ({
      hero: h.hero, archetype: h.archetype, n: h.bestScaleN,
      sens: h.bestScaleEDPI / MOUSE_DPI, delta: h.bestScaleOverallDelta,
      diff: Math.abs(h.bestScaleEDPI / MOUSE_DPI - globalBest.sensAt1600),
    }))
    .filter(h => h.diff > threshold)
    .sort((a, b) => b.diff - a.diff);

  if (diverging.length === 0) {
    return {
      verdict: 'uniform',
      headline: `Every hero with enough data (n≥${RELIABLE_N}) peaks close to your overall best (${fmtScale(globalBest)}) — no hero is asking for its own sens yet.`,
      diverging: [],
    };
  }

  return {
    verdict: 'diverge',
    headline: `${diverging.length} hero${diverging.length === 1 ? '' : 'es'} peak${diverging.length === 1 ? 's' : ''} at a noticeably different sens than your overall best (${fmtScale(globalBest)}) — worth testing a dedicated sens for them.`,
    diverging,
  };
}

// Turns the analysis payload into a plain-language read, so the charts below
// aren't the only way to find out what they say. Recomputed from the same
// numbers on every load — nothing here is written per data point.
function buildInsights(data: Analysis, heroCounts: Record<string, number>): string[] {
  const { byScale, byArchetype, coldWarm, adaptation, heroes } = data;
  const notes: string[] = [];

  const reliable = byScale.filter(r => r.n >= RELIABLE_N);
  const thin = byScale.length - reliable.length;

  if (reliable.length >= 2) {
    const bestByData = reliable.reduce((a, b) => ((b.avgDelta ?? -Infinity) > (a.avgDelta ?? -Infinity) ? b : a));
    const fastestFeel = reliable.reduce((a, b) => ((b.avgFeel ?? -Infinity) > (a.avgFeel ?? -Infinity) ? b : a));
    const worst = reliable.reduce((a, b) => ((b.avgDelta ?? Infinity) < (a.avgDelta ?? Infinity) ? b : a));

    // Lead with the best performer on its own terms — it's the "just right"
    // scale, not necessarily the fastest- or slowest-feeling one tested. Only
    // call out the fastest-feeling scale when it's a DIFFERENT scale, and frame
    // it as a correction ("feeling fast isn't the same as performing well"),
    // never as a virtue in its own right.
    notes.push(
      `Your best performer is ${fmtScale(bestByData)} (${signed(bestByData.avgDelta)}% vs. baseline, n=${bestByData.n}), which felt ${f1(bestByData.avgFeel)}/10 for speed — accuracy peaks at the scale that's right for you, not at whichever end of the speed range you tested.`,
    );
    if (fastestFeel.cm360 !== bestByData.cm360 && fastestFeel.avgFeel != null) {
      notes.push(
        `${fmtScale(fastestFeel)} felt fastest to you (${f1(fastestFeel.avgFeel)}/10), but it isn't your top performer (${signed(fastestFeel.avgDelta)}% vs. baseline, n=${fastestFeel.n}) — feeling fast doesn't mean it's the right sens.`,
      );
    }

    if (worst.cm360 !== bestByData.cm360) {
      notes.push(
        `Weakest reliable scale: ${fmtScale(worst)} runs ${signed(worst.avgDelta)}% vs. baseline — felt speed ${f1(worst.avgFeel)}/10, n=${worst.n}.`,
      );
    }
  }

  const [cold, warm] = coldWarm;
  if (cold?.avgDelta != null && warm?.avgDelta != null) {
    const diff = cold.avgDelta - warm.avgDelta;
    if (Math.abs(diff) >= 1) {
      const winner = diff > 0 ? 'Cold starts' : 'Warmed-up games';
      notes.push(
        `${winner} perform better so far — cold ${signed(cold.avgDelta)}% vs. warm ${signed(warm.avgDelta)}%. Felt speed: cold ${f1(cold.avgFeel)}/10, warm ${f1(warm.avgFeel)}/10.`,
      );
    } else {
      notes.push(`Cold vs. warm isn't showing up in accuracy yet (${signed(cold.avgDelta)}% vs. ${signed(warm.avgDelta)}%).`);
    }
  }

  const [fresh, settled] = adaptation;
  if (fresh?.avgDelta != null && settled?.avgDelta != null) {
    const diff = settled.avgDelta - fresh.avgDelta;
    if (Math.abs(diff) >= 1) {
      notes.push(
        `Adaptation matters: settled games (3+ since a sens change) run ${signed(diff)}% ${diff > 0 ? 'better' : 'worse'} than fresh-off-a-change games — give a new scale a few games before judging it.`,
      );
    } else {
      notes.push(`No adaptation penalty yet — fresh-off-a-change (${signed(fresh.avgDelta)}%) and settled (${signed(settled.avgDelta)}%) games perform about the same.`);
    }
  }

  const projReliable = byArchetype.projectile.filter(r => r.n >= RELIABLE_N).length;
  if (byArchetype.projectile.length > 0 && projReliable === 0) {
    const projHero = heroes.find(h => h.archetype === 'projectile');
    const projGames = byArchetype.projectile.reduce((s, r) => s + r.n, 0);
    notes.push(
      `Hitscan vs. projectile isn't a fair comparison yet — projectile is just ${projGames} game${projGames === 1 ? '' : 's'}${projHero ? ` (${withHeroCount(projHero.hero, heroCounts)})` : ''}, spread thin across scales.`,
    );
  }

  if (thin > 0) {
    notes.push(`${thin} of ${byScale.length} scales still have fewer than ${RELIABLE_N} games logged — treat those as noise for now.`);
  }

  return notes;
}

export default function SensAnalysis() {
  const { data, loading } = useApi<Analysis>('/api/aim/analysis');
  const heroCounts = useTodayHeroCounts();

  const wrap = (children: React.ReactNode) => (
    <div className="mt-2">
      <SensNav />
      <div className="mb-6">
        <h1 className="text-2xl heading-display text-[var(--ink)]">Sensitivity Analysis</h1>
        <p className="text-sm text-[var(--faint)] mt-1">
          What the numbers say — and where they agree or disagree with how it felt.
        </p>
      </div>
      {children}
    </div>
  );

  if (loading || !data) return wrap(<p className="text-xs text-[var(--faint)]">Loading…</p>);

  if (data.summary.n === 0) {
    return wrap(
      <div className="card">
        <p className="text-sm text-[var(--ink)]">No aim data yet.</p>
        <p className="text-xs text-[var(--faint)] mt-1.5">
          Log matches with their sensitivity, then record each one's stats on the{' '}
          <span className="text-violet-500">Enter Stats</span> tab. Once a few sens values
          are on the board, this page fills in — the sens→performance curve, the
          feel-vs-data comparison, and the hitscan/projectile split.
        </p>
      </div>,
    );
  }

  const { byScale, byArchetype, coldWarm, adaptation, heroes, summary } = data;

  // Every chart on this page keys on sensAt1600, not cm/360 or the raw tested
  // DPI — see the sensAt1600/fmtScale note above for why.
  const byScaleSpeed = bySpeed(byScale);
  const hitscanBySpeed = bySpeed(byArchetype.hitscan);
  const projectileBySpeed = bySpeed(byArchetype.projectile);
  const archSpeeds = [...new Set([
    ...hitscanBySpeed.map(r => r.sensAt1600),
    ...projectileBySpeed.map(r => r.sensAt1600),
  ])].sort((a, b) => a - b);
  const archData = archSpeeds.map(s => ({
    sensAt1600: s,
    hitscan: hitscanBySpeed.find(r => r.sensAt1600 === s)?.avgDelta ?? null,
    projectile: projectileBySpeed.find(r => r.sensAt1600 === s)?.avgDelta ?? null,
  }));
  const hasArch = byArchetype.hitscan.length > 0 || byArchetype.projectile.length > 0;
  const archDeltaDomain = symmetricDomain(archData.flatMap(r => [r.hitscan, r.projectile]));

  // Same quadrant treatment as Feel vs. Data: y=0 is the fixed, meaningful
  // baseline (delta is already "vs. your own average"), but sens has no
  // universal center, so the vertical crosshair sits at this data's own
  // n-weighted mean sens instead — mirroring how meanFeel is derived.
  const archAllPts = [...hitscanBySpeed, ...projectileBySpeed];
  const archTotalN = archAllPts.reduce((s, r) => s + r.n, 0);
  const meanArchSens = archTotalN ? archAllPts.reduce((s, r) => s + r.sensAt1600 * r.n, 0) / archTotalN : 0;
  const archXDomain = centeredDomain(archAllPts.map(r => r.sensAt1600), meanArchSens);

  // Feel vs. Data quadrant: each scale plotted at (felt speed, accuracy delta),
  // with the crosshair sitting at Sean's own mean of each — so the four
  // quadrants read as above/below-average feel × above/below-average accuracy.
  const feelPts = byScaleSpeed.filter(r => r.avgFeel != null && r.avgDelta != null);
  const meanFeel = wMean(byScaleSpeed, 'avgFeel');
  const meanDelta = wMean(byScaleSpeed, 'avgDelta');
  const feelXDomain = centeredDomain(feelPts.map(r => r.avgFeel), meanFeel);
  const feelYDomain = centeredDomain(feelPts.map(r => r.avgDelta), meanDelta);

  const insights = buildInsights(data, heroCounts);
  const recommendation = buildRecommendation(data);
  const archetypeVerdict = buildArchetypeVerdict(data);
  const heroDivergence = buildHeroDivergence(data);

  return wrap(
    <div className="space-y-6">
      <p className="text-xs text-[var(--faint)]">
        <span className="text-[var(--ink)] font-semibold">{summary.n}</span> logged matches across{' '}
        <span className="text-[var(--ink)] font-semibold">{summary.distinctScale}</span> distinct sens (@{MOUSE_DPI} DPI) scales.
        Accuracy is shown as a delta vs. your own average on each hero, so heroes mix fairly.
        {summary.maskedPending > 0 && (
          <span className="ml-2 inline-flex items-center gap-1 rounded-md bg-violet-500/15 text-violet-500 px-2 py-0.5 text-[11px] font-semibold">
            🔒 {summary.maskedPending} blind trial{summary.maskedPending === 1 ? '' : 's'} held out until revealed
          </span>
        )}
        <br />
        <span className="text-[var(--faint-2)]">
          {fmtUpdated(summary.lastUpdated) ? `Last updated ${fmtUpdated(summary.lastUpdated)}` : 'Not yet updated'} —
          {' '}refreshes whenever a study match's stats are submitted on the Enter Stats tab.
        </span>
      </p>

      <p className="text-xs text-[var(--faint)] rounded-lg bg-ow-darker border border-ow-border px-3 py-2">
        <span className="text-[var(--ink)] font-semibold">Standard of measure:</span> every scale on this page is
        shown as <span className="text-[var(--ink)]">in-game sens at {MOUSE_DPI} DPI</span> (eDPI ÷ {MOUSE_DPI}), not
        cm/360 or the raw DPI tested. DPI was only ever the hidden variable for blinding — a physical mouse-stage
        switch is easier to hide than an in-game sens change — and the mouse settles back at {MOUSE_DPI} DPI once
        you commit to a result, so this is the number you'd actually dial in.
      </p>

      {/* DPI recommendation + continue-vs-narrow call */}
      <Section
        title="Recommendation"
        hint="A DPI suggestion plus a call on whether to keep exploring or start converging — recomputed from the same scale data below."
      >
        <div className="flex items-start gap-3 flex-wrap">
          <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold ${recommendation.verdict === 'narrow' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-violet-500/15 text-violet-500'}`}>
            {recommendation.verdict === 'narrow' ? 'Narrow focus' : 'Continue testing'}
          </span>
          <p className="text-sm text-[var(--ink)] font-semibold flex-1 min-w-[200px]">{recommendation.headline}</p>
        </div>
        {recommendation.points.length > 0 && (
          <ul className="space-y-2 text-sm text-[var(--ink-2)] list-disc list-inside marker:text-violet-500 mt-3">
            {recommendation.points.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        )}
      </Section>

      {/* Plain-language read of the charts below */}
      <Section
        title="What the Data Shows"
        hint="Auto-generated from the same numbers as the charts below — recomputed every time you log a match."
      >
        {insights.length > 0 ? (
          <ul className="space-y-2.5 text-sm text-[var(--ink-2)] list-disc list-inside marker:text-violet-500">
            {insights.map((note, i) => <li key={i}>{note}</li>)}
          </ul>
        ) : (
          <p className="text-xs text-[var(--faint)]">Not enough data yet for a confident read — keep logging.</p>
        )}
      </Section>

      {/* Feel vs Data + Hitscan vs Projectile, side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section
          title="Feel vs. Data"
          hint={`Each dot is a tested scale, placed by how fast it felt (x) against how it actually performed (y). The crosshair sits at your own averages, so the four quadrants split above/below-average feel × above/below-average accuracy. Bottom-right = feels fast but aims worse than average (gut over-rates it); top-left = feels slow but aims better (underrated).`}
        >
          <div className="flex gap-2">
            <div className="flex flex-col justify-between text-[10px] text-[var(--faint-2)] py-3 w-12 shrink-0 text-right">
              <span>More accurate</span>
              <span>Less accurate</span>
            </div>
            <div className="flex-1 min-w-0">
              <ResponsiveContainer width="100%" height={280}>
                <ScatterChart data={feelPts} margin={{ top: 12, right: 12, bottom: 4, left: 0 }}>
                  <CartesianGrid stroke="var(--ow-border)" />
                  <XAxis type="number" dataKey="avgFeel" name="Felt speed" domain={feelXDomain} tick={false} tickLine={false} axisLine={false} />
                  <YAxis type="number" dataKey="avgDelta" name="Accuracy Δ" domain={feelYDomain} tick={false} tickLine={false} axisLine={false} width={4} />
                  <Tooltip content={<QuadrantTooltip />} cursor={{ strokeDasharray: '3 3' }} />
                  <ReferenceLine x={meanFeel} stroke="var(--faint-2)" strokeDasharray="4 4" />
                  <ReferenceLine y={meanDelta} stroke="var(--faint-2)" strokeDasharray="4 4" />
                  <Scatter dataKey="avgDelta" fill={FEEL}>
                    <LabelList dataKey="sensAt1600" position="top" formatter={(v: number) => v.toFixed(2)} style={{ fontSize: 10, fill: 'var(--faint)' }} />
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
              <div className="flex justify-between text-[10px] text-[var(--faint-2)] px-0.5">
                <span>Slower</span><span>Faster</span>
              </div>
            </div>
          </div>
        </Section>

        {hasArch && (
          <Section
            title="Hitscan vs. Projectile"
            hint={`Not a leaderboard — the question is whether hitscan and projectile are worth separate sens. Each dot is a tested scale, split by aim type; the vertical crosshair sits at the mean sens tested, the horizontal at zero (your own baseline).`}
          >
            <div className="flex items-start gap-3 flex-wrap mb-3">
              <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold ${archetypeVerdict.verdict === 'split' ? 'bg-amber-500/15 text-amber-500' : archetypeVerdict.verdict === 'shared' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-violet-500/15 text-violet-500'}`}>
                {archetypeVerdict.verdict === 'split' ? 'Split may help' : archetypeVerdict.verdict === 'shared' ? 'One sens fits both' : 'Not enough data'}
              </span>
              <p className="text-sm text-[var(--ink)] font-semibold flex-1 min-w-[200px]">{archetypeVerdict.headline}</p>
            </div>
            <div className="flex gap-2">
              <div className="flex flex-col justify-between text-[10px] text-[var(--faint-2)] py-3 w-12 shrink-0 text-right">
                <span>More accurate</span>
                <span>Less accurate</span>
              </div>
              <div className="flex-1 min-w-0">
                <ResponsiveContainer width="100%" height={280}>
                  <ScatterChart data={archData} margin={{ top: 12, right: 12, bottom: 4, left: 0 }}>
                    <CartesianGrid stroke="var(--ow-border)" />
                    <XAxis dataKey="sensAt1600" type="number" domain={archXDomain} tick={false} tickLine={false} axisLine={false} />
                    <YAxis domain={archDeltaDomain} tick={false} tickLine={false} axisLine={false} width={4} />
                    <Tooltip
                      contentStyle={{ background: 'var(--ow-card)', border: '1px solid var(--ow-border)', borderRadius: 8, fontSize: 12 }}
                      formatter={(v: number, name: string) => [signed(v), name]}
                      labelFormatter={(l: number) => `${l.toFixed(2)} sens @ ${MOUSE_DPI} DPI`}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <ReferenceLine x={meanArchSens} stroke="var(--faint-2)" strokeDasharray="4 4" />
                    <ReferenceLine y={0} stroke="var(--faint-2)" strokeDasharray="4 4" />
                    <Scatter dataKey="hitscan" name="Hitscan" fill={HITSCAN}>
                      <LabelList dataKey="sensAt1600" position="top" formatter={(v: number) => v.toFixed(2)} style={{ fontSize: 10, fill: 'var(--faint)' }} />
                    </Scatter>
                    <Scatter dataKey="projectile" name="Projectile" fill={PROJECTILE}>
                      <LabelList dataKey="sensAt1600" position="top" formatter={(v: number) => v.toFixed(2)} style={{ fontSize: 10, fill: 'var(--faint)' }} />
                    </Scatter>
                  </ScatterChart>
                </ResponsiveContainer>
                <div className="flex justify-between text-[10px] text-[var(--faint-2)] px-0.5">
                  <span>Slower</span><span>Faster</span>
                </div>
              </div>
            </div>
          </Section>
        )}
      </div>

      {/* Per-hero sens divergence — same split-worth-it question, one level deeper */}
      <Section
        title="Does Each Hero Need Its Own Sens?"
        hint={`Every hero aims differently, so this goes past aim type: checks each hero's own best-performing scale (from By Hero below) against your overall best. Only heroes with n≥${RELIABLE_N} on their own best scale are judged — thin heroes are left out rather than guessed at.`}
      >
        <div className="flex items-start gap-3 flex-wrap">
          <span className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold ${heroDivergence.verdict === 'diverge' ? 'bg-amber-500/15 text-amber-500' : heroDivergence.verdict === 'uniform' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-violet-500/15 text-violet-500'}`}>
            {heroDivergence.verdict === 'diverge' ? 'Some heroes diverge' : heroDivergence.verdict === 'uniform' ? 'One sens fits all' : 'Not enough data'}
          </span>
          <p className="text-sm text-[var(--ink)] font-semibold flex-1 min-w-[200px]">{heroDivergence.headline}</p>
        </div>
        {heroDivergence.diverging.length > 0 && (
          <ul className="space-y-2 text-sm text-[var(--ink-2)] list-disc list-inside marker:text-amber-500 mt-3">
            {heroDivergence.diverging.map(h => (
              <li key={h.hero}>
                {withHeroCount(h.hero, heroCounts)} <span className="text-[var(--faint)] capitalize">({h.archetype})</span> peaks at {h.sens.toFixed(2)} sens ({signed(h.delta)}%, n={h.n}) — {h.diff.toFixed(2)} sens away from your overall best.
              </li>
            ))}
          </ul>
        )}
      </Section>

      {/* Cold vs Warm + Adaptation */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Cold vs. Warm" hint="First game of a session vs. later ones — is a sens good from the jump, or only once warmed up?">
          <div className="grid grid-cols-2 gap-3">
            {coldWarm.map(b => (
              <div key={b.bucket} className="rounded-lg bg-ow-darker border border-ow-border p-3">
                <div className="text-[11px] text-[var(--faint)] mb-1">{b.bucket}</div>
                <div className="text-2xl num-display text-[var(--ink)]">{f1(b.avgOverall)}<span className="text-xs text-[var(--faint)] ml-0.5">%</span></div>
                <div className="text-[11px] text-[var(--faint-2)] mt-1">Δ {signed(b.avgDelta)} · felt speed {f1(b.avgFeel)}/10 · n={b.n}</div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Adaptation" hint="Just after a sens change vs. once settled — separates a genuinely worse sens from one you hadn't adjusted to yet.">
          <div className="grid grid-cols-2 gap-3">
            {adaptation.map(b => (
              <div key={b.bucket} className="rounded-lg bg-ow-darker border border-ow-border p-3">
                <div className="text-[11px] text-[var(--faint)] mb-1">{b.bucket}</div>
                <div className="text-2xl num-display text-[var(--ink)]">{f1(b.avgOverall)}<span className="text-xs text-[var(--faint)] ml-0.5">%</span></div>
                <div className="text-[11px] text-[var(--faint-2)] mt-1">Δ {signed(b.avgDelta)} · felt speed {f1(b.avgFeel)}/10 · n={b.n}</div>
              </div>
            ))}
          </div>
        </Section>
      </div>

      {/* Per-scale table */}
      <Section title={`By Scale (sens @${MOUSE_DPI} DPI)`} hint={`Every tested scale, expressed as in-game sens at ${MOUSE_DPI} DPI, with its eDPI and averages. Δ is accuracy vs. your hero baseline. "Sens" is the raw in-game value actually used during testing (near-constant across blind trials, since DPI was the hidden variable there).`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] text-[var(--muted)] uppercase tracking-wider text-left">
                <th className="py-1.5 pr-3">{`Sens @${MOUSE_DPI}`}</th><th className="py-1.5 pr-3">eDPI</th><th className="py-1.5 pr-3">Sens</th><th className="py-1.5 pr-3">n</th>
                <th className="py-1.5 pr-3">Overall</th><th className="py-1.5 pr-3">Crit</th><th className="py-1.5 pr-3">Felt speed</th><th className="py-1.5">Δ</th>
              </tr>
            </thead>
            <tbody>
              {byScaleSpeed.map(r => (
                <tr key={r.cm360} className="border-t border-ow-border text-[var(--ink-2)]">
                  <td className="py-1.5 pr-3 font-semibold text-[var(--ink)]">{r.sensAt1600.toFixed(2)}</td>
                  <td className="py-1.5 pr-3">{r.eDPI}</td>
                  <td className="py-1.5 pr-3">{r.sens}</td>
                  <td className="py-1.5 pr-3">{r.n}</td>
                  <td className="py-1.5 pr-3">{f1(r.avgOverall)}%</td>
                  <td className="py-1.5 pr-3">{f1(r.avgCrit)}%</td>
                  <td className="py-1.5 pr-3">{f1(r.avgFeel)}/10</td>
                  <td className={`py-1.5 ${deltaColor(r.avgDelta)}`}>{signed(r.avgDelta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* By hero */}
      <Section title="By Hero" hint={`Sample size per hero — thin rows are noise until they build up. Optimal Sens is the sens (@${MOUSE_DPI} DPI) scale where that hero's own accuracy peaks, with its n in parens — treat it as noise below n=${RELIABLE_N}. Δ Overall/Crit compare that scale's accuracy to the hero's own Overall/Crit average.`}>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] text-[var(--muted)] uppercase tracking-wider text-left">
                <th className="py-1.5 pr-3">Hero</th><th className="py-1.5 pr-3">Type</th><th className="py-1.5 pr-3">n</th>
                <th className="py-1.5 pr-3">Overall</th><th className="py-1.5 pr-3">Crit</th><th className="py-1.5 pr-3">Optimal Sens</th>
                <th className="py-1.5 pr-3">Δ Overall</th><th className="py-1.5">Δ Crit</th>
              </tr>
            </thead>
            <tbody>
              {heroes.map(h => (
                <tr key={h.hero} className="border-t border-ow-border text-[var(--ink-2)]">
                  <td className="py-1.5 pr-3 font-semibold text-[var(--ink)]">{withHeroCount(h.hero, heroCounts)}</td>
                  <td className="py-1.5 pr-3 capitalize text-[var(--faint)]">{h.archetype}</td>
                  <td className="py-1.5 pr-3">{h.n}</td>
                  <td className="py-1.5 pr-3">{f1(h.avgOverall)}%</td>
                  <td className="py-1.5 pr-3">{f1(h.avgCrit)}%</td>
                  <td className={h.bestScaleN < RELIABLE_N ? 'py-1.5 pr-3 text-[var(--faint)]' : 'py-1.5 pr-3'}>
                    {(h.bestScaleEDPI / MOUSE_DPI).toFixed(2)} <span className="text-[10px] text-[var(--faint-2)]">(n={h.bestScaleN})</span>
                  </td>
                  <td className={`py-1.5 pr-3 ${deltaColor(h.bestScaleOverallDelta)}`}>{signed(h.bestScaleOverallDelta)}</td>
                  <td className={`py-1.5 ${deltaColor(h.bestScaleCritDelta)}`}>{signed(h.bestScaleCritDelta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>
    </div>,
  );
}
