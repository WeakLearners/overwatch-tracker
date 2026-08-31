import {
  ResponsiveContainer, ScatterChart, Scatter, LabelList,
  ComposedChart, Bar, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ReferenceArea,
} from 'recharts';
import { useApi } from '../hooks/useApi';
import SensNav from '../components/SensNav';
import { MOUSE_DPI } from '../lib/aim';
import { useTodayHeroCounts, withHeroCount } from '../hooks/useHeroCounts';

interface ScaleRow {
  cm360: number; eDPI: number; sens: number; n: number;
  avgOverall: number | null; avgCrit: number | null;
  avgFeel: number | null; avgDelta: number | null; winRate: number | null;
  min: number | null; q1: number | null; median: number | null; q3: number | null; max: number | null;
  absorbedN: number; distinctDates: number; dateSpanDays: number;
}
interface Bucket {
  bucket: string; n: number;
  avgOverall: number | null; avgDelta: number | null; avgFeel: number | null; winRate: number | null;
}
interface CurveFit {
  points: number; totalN: number; r2: number;
  optimalSens: number | null; predictedDelta: number | null;
  hasInteriorPeak: boolean; inRange: boolean;
  testedSensMin: number; testedSensMax: number;
  a: number; b: number; c: number;
}
interface TimelinePoint {
  date: string; hero: string; win: 0 | 1; eDPI: number; cm360: number; delta: number;
}
interface HeroRow {
  hero: string; archetype: string; n: number;
  avgOverall: number | null; avgCrit: number | null; winRate: number | null;
  bestScaleEDPI: number; bestScaleN: number;
  bestScaleOverallDelta: number | null; bestScaleCritDelta: number | null; bestScaleWinRate: number | null;
  scales: ScaleRow[];
  curveFit: CurveFit | null;
}
interface Analysis {
  summary: { n: number; distinctScale: number; lastUpdated: string | null };
  timeline: TimelinePoint[];
  byScale: ScaleRow[];
  overallCurveFit: CurveFit | null;
  byArchetype: { hitscan: ScaleRow[]; projectile: ScaleRow[] };
  coldWarm: Bucket[];
  adaptation: Bucket[];
  heroes: HeroRow[];
}

const FEEL = '#F7931E';

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

// A domain centered on `center`, spanning the farthest point from it (+10%
// pad), so a crosshair drawn at `center` lands at the plot's midpoint — the
// basis for the four-quadrant Feel vs. Data view.
const centeredDomain = (vals: (number | null | undefined)[], center: number): [number, number] => {
  const r = Math.max(0, ...vals.filter((v): v is number => v != null).map(v => Math.abs(v - center)));
  const pad = r * 1.15 || 1;
  return [center - pad, center + pad];
};

// Fixed-step gridline positions across a domain (independent of the axis's
// own — often sparse, label-driven — ticks), rounded to kill float drift
// from repeated addition (e.g. 2.2 + 0.1 + 0.1... landing on 2.4000000000000004).
const gridTicks = (min: number, max: number, step: number): number[] => {
  const start = Math.ceil(min / step) * step;
  const count = Math.max(0, Math.floor((max - start) / step + 1e-9) + 1);
  return Array.from({ length: count }, (_, i) => Math.round((start + i * step) * 1000) / 1000);
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
    <div style={{ background: 'rgb(var(--ow-card))', border: '1px solid rgb(var(--ow-border))', borderRadius: 8, fontSize: 12, padding: '6px 10px' }}>
      <div style={{ fontWeight: 700 }}>{p.sensAt1600.toFixed(2)} sens @ {MOUSE_DPI} DPI</div>
      <div>Felt speed: <b style={{ fontWeight: 700 }}>{f1(p.avgFeel)}</b>/100</div>
      <div>Accuracy vs. your average: <b style={{ fontWeight: 700 }}>{signed(p.avgDelta)}</b></div>
      <div style={{ opacity: 0.7 }}>{p.n} game{p.n === 1 ? '' : 's'}</div>
    </div>
  );
}

// Tooltip for the Peak Sens by Category chart — each point is a different
// category (Overall/Hitscan/Projectile/hero), so its label carries the
// identity neither axis does.
function SpreadTooltip({ active, payload }: { active?: boolean; payload?: { payload: SpreadPoint }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div style={{ background: 'rgb(var(--ow-card))', border: '1px solid rgb(var(--ow-border))', borderRadius: 8, fontSize: 12, padding: '6px 10px' }}>
      <div style={{ fontWeight: 700 }}>{p.label}{p.archetype ? ` (${p.archetype})` : ''}</div>
      <div><b style={{ fontWeight: 700 }}>{p.sens.toFixed(2)}</b> sens @ {MOUSE_DPI} DPI</div>
      <div>Accuracy: <b style={{ fontWeight: 700 }}>{f1(p.raw)}</b>% (<b style={{ fontWeight: 700 }}>{signed(p.delta)}</b> vs. your average)</div>
      <div style={{ opacity: 0.7 }}>{p.n} game{p.n === 1 ? '' : 's'}</div>
    </div>
  );
}

// Page-wide standard of measure: in-game sens once the mouse is back at
// MOUSE_DPI. DPI is the varied test variable — the mouse settles at MOUSE_DPI
// once a result is committed to, so eDPI ÷ MOUSE_DPI is the sens that will
// actually get dialed in. Also fixes cm/360's backwards direction (there,
// lower means faster); this way, higher = faster.
const sensAt1600 = (r: { eDPI: number }) => r.eDPI / MOUSE_DPI;
const fmtScale = (r: { eDPI: number }) => `${sensAt1600(r).toFixed(2)} sens (@${MOUSE_DPI} DPI)`;
function bySpeed<T extends { eDPI: number }>(rows: T[]): (T & { sensAt1600: number })[] {
  return rows.map(r => ({ ...r, sensAt1600: sensAt1600(r) })).sort((a, b) => a.sensAt1600 - b.sensAt1600);
}

interface TimelineChartPoint extends TimelinePoint {
  index: number; sensAt1600: number; rollingDelta: number | null;
}

// Chronological feed -> chart-ready points: adds a sequential index (evenly
// spaced x-axis, so a burst of same-day games doesn't compress into an
// unreadable cluster the way a real date axis would) and a trailing rolling
// average of delta, so a secular drift (e.g. practice effect improving
// accuracy independent of scale) is visible as a trend line under the noisy
// per-match points instead of only showing up as a scale-vs-scale artifact.
const TIMELINE_WINDOW = 8;
function buildTimelineChartData(timeline: TimelinePoint[]): TimelineChartPoint[] {
  return timeline.map((p, i) => {
    const windowSlice = timeline.slice(Math.max(0, i - TIMELINE_WINDOW + 1), i + 1);
    const rollingDelta = windowSlice.length >= 3 ? mean(windowSlice.map(w => w.delta)) : null;
    return { ...p, index: i, sensAt1600: p.eDPI / MOUSE_DPI, rollingDelta };
  });
}
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

// Samples the fitted quadratic (y = a*x^2 + b*x + c) across the tested sens
// range so it can be drawn as a smooth Line instead of just reporting its
// vertex in a table.
function buildCurveLine(fit: CurveFit, steps = 40): { x: number; y: number }[] {
  const { a, b, c, testedSensMin: xMin, testedSensMax: xMax } = fit;
  if (xMax <= xMin) return [{ x: xMin, y: a * xMin * xMin + b * xMin + c }];
  return Array.from({ length: steps + 1 }, (_, i) => {
    const x = xMin + ((xMax - xMin) * i) / steps;
    return { x: Math.round(x * 1000) / 1000, y: a * x * x + b * x + c };
  });
}

// Card wrapper with a title and one-line explanation of how to read it.
function Section({ title, hint, children, dataInspectId }: { title: string; hint: string; children: React.ReactNode; dataInspectId?: string }) {
  return (
    <div className="card" data-inspect-id={dataInspectId}>
      <h2 className="text-sm heading-display text-[var(--ink)]">{title}</h2>
      <p className="text-xs text-[var(--faint)] mt-1 mb-4">{hint}</p>
      {children}
    </div>
  );
}

const axisStyle = { fontSize: 11, fill: 'var(--faint)' };

const RELIABLE_N = 4;
const CONFIDENT_N = 8;
// Distinct tested scales required before a curve fit's R² gets the confident
// "good" tone — a 3-point quadratic has 3 free parameters, so it can hit a
// high R² on degrees-of-freedom alone at the threshold where it's least
// trustworthy, not because it detected real curvature.
const CONFIDENT_SCALES = 5;
// Percentage-point accuracy-delta gap treated as "meaningfully worse," not
// noise — shared between the Recommendation card's "clearly worse" call and
// the Insights "weakest reliable scale" callout so both use the same bar.
const MEANINGFUL_DELTA_GAP = 1.5;

// One color per hero, assigned by a stable hash of the hero's name (not
// array position, so a hero keeps its color across reloads) via a
// golden-angle hue step — degrades gracefully as the roster of tested heroes
// grows, unlike a fixed-size palette + modulo, which silently assigns two
// unrelated heroes the same color once the roster exceeds the palette size.
const heroColor = (hero: string): string => {
  let hash = 0;
  for (let i = 0; i < hero.length; i++) hash = (hash * 31 + hero.charCodeAt(i)) >>> 0;
  const hue = (hash * 137.508) % 360;
  return `hsl(${hue.toFixed(1)}, 65%, 55%)`;
};

// Same stable-hash/golden-angle scheme as heroColor, keyed on the scale
// instead of the hero — used only by the timeline chart's per-point coloring.
const scaleColor = (cm360: number): string => heroColor(cm360.toFixed(1));

const fmtDate = (iso: string) => new Date(iso + 'T00:00:00').toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// Tooltip for the Accuracy Over Time chart — identifies a point by date, hero
// and scale, none of which either axis (index, delta) carries on its own.
function TimelineTooltip({ active, payload }: { active?: boolean; payload?: { payload: TimelineChartPoint }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div style={{ background: 'rgb(var(--ow-card))', border: '1px solid rgb(var(--ow-border))', borderRadius: 8, fontSize: 12, padding: '6px 10px' }}>
      <div style={{ fontWeight: 700 }}>{fmtDate(p.date)} · {p.hero}</div>
      <div><b style={{ fontWeight: 700 }}>{p.sensAt1600.toFixed(2)}</b> sens @ {MOUSE_DPI} DPI</div>
      <div>Accuracy vs. your average: <b style={{ fontWeight: 700 }}>{signed(p.delta)}</b>{p.win ? ' · win' : ' · loss'}</div>
      {p.rollingDelta != null && <div style={{ opacity: 0.7 }}>Recent trend ({TIMELINE_WINDOW} games): <b style={{ fontWeight: 700 }}>{signed(p.rollingDelta)}</b></div>}
    </div>
  );
}

// Tooltip for the fitted-curve chart — a sampled curve point carries no
// tested-n, so distinguish it in the readout from an actual tested scale.
function CurveTooltip({ active, payload }: { active?: boolean; payload?: { payload: { x: number; y: number; n?: number; isFit?: boolean } }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div style={{ background: 'rgb(var(--ow-card))', border: '1px solid rgb(var(--ow-border))', borderRadius: 8, fontSize: 12, padding: '6px 10px' }}>
      <div style={{ fontWeight: 700 }}>{p.x.toFixed(2)} sens @ {MOUSE_DPI} DPI</div>
      <div>{p.n != null ? 'Actual result' : 'Estimated'}: <b style={{ fontWeight: 700 }}>{signed(p.y)}</b> vs. your average</div>
      {p.n != null && <div style={{ opacity: 0.7 }}>{p.n} game{p.n === 1 ? '' : 's'}</div>}
    </div>
  );
}

interface HeroBoxStats { min: number; q1: number; median: number; q3: number; max: number; n: number }
interface HeroBoxRow { cm360: number; label: string; sensAt1600: number; heroes: Record<string, HeroBoxStats | undefined> }

// Pivots byScale (global sens buckets) x heroes into one row per sens, each
// carrying whichever heroes were actually tested at that scale — the shape
// a grouped box-plot chart (one cluster of hero-boxes per x category) needs.
function buildHeroBoxRows(data: Analysis): HeroBoxRow[] {
  const categories = bySpeed(data.byScale);
  return categories.map(cat => {
    const heroesAtScale: Record<string, HeroBoxStats | undefined> = {};
    for (const h of data.heroes) {
      const s = h.scales.find(sc => sc.cm360 === cat.cm360);
      if (s && s.n >= 2 && s.min != null && s.q1 != null && s.median != null && s.q3 != null && s.max != null) {
        heroesAtScale[h.hero] = { min: s.min, q1: s.q1, median: s.median, q3: s.q3, max: s.max, n: s.n };
      }
    }
    return { cm360: cat.cm360, label: cat.sensAt1600.toFixed(2), sensAt1600: cat.sensAt1600, heroes: heroesAtScale };
  });
}

// Recharts hands the shared Tooltip one payload entry per Bar series present
// at the hovered category, each carrying the whole row (not narrowed to its
// own hero) — pull each series's stats out of row.heroes by its own name and
// drop any hero that wasn't actually tested at this sens.
function HeroBoxTooltip({ active, payload, label }: { active?: boolean; payload?: { name?: string; payload: HeroBoxRow }[]; label?: string }) {
  if (!active || !payload?.length) return null;
  const row = payload[0].payload;
  const entries = payload
    .map(p => ({ hero: p.name ?? '', stats: row.heroes[p.name ?? ''] }))
    .filter((e): e is { hero: string; stats: HeroBoxStats } => e.stats != null);
  if (!entries.length) return null;
  return (
    <div style={{ background: 'rgb(var(--ow-card))', border: '1px solid rgb(var(--ow-border))', borderRadius: 8, fontSize: 12, padding: '6px 10px' }}>
      <div style={{ fontWeight: 700 }}>{label} sens (@{MOUSE_DPI} DPI)</div>
      {entries.map(e => (
        <div key={e.hero} style={{ marginTop: 4 }}>
          <div style={{ fontWeight: 600, color: heroColor(e.hero), textTransform: 'uppercase', letterSpacing: '0.02em' }}>{e.hero}</div>
          <div>Typical <b style={{ fontWeight: 700 }}>{f1(e.stats.median)}</b>% (middle half between <b style={{ fontWeight: 700 }}>{f1(e.stats.q1)}</b>–<b style={{ fontWeight: 700 }}>{f1(e.stats.q3)}</b>%)</div>
          <div style={{ opacity: 0.7 }}>Range <b style={{ fontWeight: 700 }}>{f1(e.stats.min)}</b>–<b style={{ fontWeight: 700 }}>{f1(e.stats.max)}</b>% · {e.stats.n} game{e.stats.n === 1 ? '' : 's'}</div>
        </div>
      ))}
    </div>
  );
}

// Renders one hero's box-and-whiskers for a Bar whose dataKey already
// resolved to the [q1, q3] range (so x/y/width/height are the box itself,
// correctly scaled against the y-axis regardless of its domain). Min/median/
// max aren't part of that range, so they're extrapolated from the box's own
// pixel geometry: pxPerUnit = height / (q3 - q1), then walked out from the
// box's top (q3) edge.
function heroBoxShape(hero: string) {
  return (props: any) => {
    const stats: HeroBoxStats | undefined = props.payload?.heroes?.[hero];
    if (!stats) return <g />;
    const { x, y, width, height } = props;
    const color = heroColor(hero);
    const pxPerUnit = stats.q3 !== stats.q1 ? height / (stats.q3 - stats.q1) : 0;
    const yFor = (v: number) => y + (stats.q3 - v) * pxPerUnit;
    const cx = x + width / 2;
    const capHalf = width * 0.3;
    const boxH = Math.max(height, 1);
    return (
      <g>
        <line x1={cx} x2={cx} y1={yFor(stats.min)} y2={yFor(stats.q1)} stroke={color} strokeWidth={1.5} />
        <line x1={cx} x2={cx} y1={yFor(stats.q3)} y2={yFor(stats.max)} stroke={color} strokeWidth={1.5} />
        <line x1={cx - capHalf} x2={cx + capHalf} y1={yFor(stats.min)} y2={yFor(stats.min)} stroke={color} strokeWidth={1.5} />
        <line x1={cx - capHalf} x2={cx + capHalf} y1={yFor(stats.max)} y2={yFor(stats.max)} stroke={color} strokeWidth={1.5} />
        <rect x={x} y={y} width={width} height={boxH} fill={color} fillOpacity={0.3} stroke={color} strokeWidth={1.5} rx={2} />
        <line x1={x} x2={x + width} y1={yFor(stats.median)} y2={yFor(stats.median)} stroke={color} strokeWidth={2.5} />
      </g>
    );
  };
}

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
function buildRecommendation(data: Analysis, spread: SensSpread): Recommendation {
  const reliable = bySpeed(data.byScale.filter(r => r.n >= RELIABLE_N)); // ascending: slowest -> fastest

  if (reliable.length < 3) {
    return {
      verdict: 'continue',
      headline: 'Not enough tested scales yet to recommend a DPI.',
      points: [
        `Only ${reliable.length} scale${reliable.length === 1 ? '' : 's'} ${reliable.length === 1 ? 'has' : 'have'} ${RELIABLE_N}+ logged games — spread more reps across scales before narrowing in.`,
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
      `That's the ${isFastEdge ? 'fastest' : 'slowest'} scale you've tried — you don't know yet if it's actually the best, or just the best of what you've tried so far. Try a ${isFastEdge ? 'higher' : 'lower'} DPI stage in your next test set to see whether it keeps improving or starts getting worse.`,
    );
  }

  if (best.n < CONFIDENT_N) {
    points.push(`Only ${best.n} games on it so far — enough to take seriously, but still thin. A few more would help confirm it.`);
  }

  const runnerUp = [...reliable].filter(r => r !== best).sort((a, b) => (b.avgDelta ?? -Infinity) - (a.avgDelta ?? -Infinity))[0];
  const gap = runnerUp ? (best.avgDelta ?? 0) - (runnerUp.avgDelta ?? 0) : Infinity;
  if (runnerUp && gap < 2) {
    points.push(
      `${fmtScale(runnerUp)} is close behind at ${signed(runnerUp.avgDelta)}% (${runnerUp.n} games) — not clearly worse yet, worth keeping in the rotation.`,
    );
  }

  const clearlyWorse = reliable.filter(r => r !== best && r !== runnerUp && (r.avgDelta ?? 0) < -MEANINGFUL_DELTA_GAP && r.n >= CONFIDENT_N);
  if (clearlyWorse.length > 0) {
    points.push(
      `${clearlyWorse.map(r => fmtScale(r)).join(', ')} ${clearlyWorse.length === 1 ? 'has' : 'have'} enough reps to call ${clearlyWorse.length === 1 ? 'it' : 'them'} clearly worse (${clearlyWorse.map(r => signed(r.avgDelta)).join(', ')}) — safe to drop from the rotation.`,
    );
  }

  // Hero-level peaks genuinely diverging (spread.verdict === 'scattered')
  // contradicts converging on one pooled DPI — never claim "narrow focus"
  // while that's true, no matter how confident the pooled numbers alone
  // would otherwise look.
  if (spread.verdict === 'scattered') {
    points.unshift(
      `${spread.headline} A single pooled DPI may not fit every hero yet — see "Peak Sens by Category" below before committing.`,
    );
    return {
      verdict: 'continue',
      headline: `No single best DPI yet — heroes are peaking at different scales. Overall best guess is ${fmtScale(best)} (${signed(best.avgDelta)}%, ${best.n} games), but treat it as provisional.`,
      points,
    };
  }

  const verdict: 'continue' | 'narrow' =
    isSlowEdge || isFastEdge || best.n < CONFIDENT_N || gap < 2 ? 'continue' : 'narrow';

  if (verdict === 'narrow') {
    points.push('Nothing above contradicts it — worth converging future sessions on this scale and its immediate neighbors to confirm before calling it final.');
  }

  return {
    verdict,
    headline: `Best guess right now: ${fmtScale(best)} (tested at DPI ${dpi}) — ${signed(best.avgDelta)}% vs. your average, over ${best.n} games.`,
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

interface SpreadPoint {
  label: string; kind: 'overall' | 'hitscan' | 'projectile' | 'hero';
  sens: number; raw: number | null; delta: number | null; n: number; archetype?: string;
}
interface SensSpread {
  verdict: 'insufficient' | 'grouped' | 'scattered';
  headline: string;
  points: SpreadPoint[];
  anchor: number | null;
  threshold: number;
  baseline: number | null;
}

// n-weighted grand mean of every hero's own average accuracy — the single
// "overall mean accuracy" reference line for the chart. Each hero's
// avgOverall is already that hero's mean across all of its own points, so
// weighting by hero n here reconstructs the true grand mean across every
// logged point (same trick as wMean, just over heroes instead of scales).
function grandMeanAccuracy(heroes: HeroRow[]): number | null {
  const valid = heroes.filter(h => h.avgOverall != null);
  const totalN = valid.reduce((s, h) => s + h.n, 0);
  return totalN ? valid.reduce((s, h) => s + (h.avgOverall as number) * h.n, 0) / totalN : null;
}

// One point per category (Overall, Hitscan, Projectile, each hero) — the
// scale where that category's own accuracy peaks, whatever its sample size.
// "Peak" is still selected by highest DELTA (accuracy vs. each match's own
// hero baseline) — the fairness normalization the whole page uses — but the
// plotted/labeled value is the RAW accuracy at that peak scale, so the chart
// reads in real percentages instead of an abstract delta.
function buildSensSpread(data: Analysis): SensSpread {
  const allOverall = bySpeed(data.byScale);
  const threshold = sensGapThreshold(allOverall);
  const points: SpreadPoint[] = [];

  if (allOverall.length > 0) {
    const best = allOverall.reduce((a, b) => ((b.avgDelta ?? -Infinity) > (a.avgDelta ?? -Infinity) ? b : a));
    points.push({ label: 'Overall', kind: 'overall', sens: best.sensAt1600, raw: best.avgOverall, delta: best.avgDelta, n: best.n });
  }

  const hit = bySpeed(data.byArchetype.hitscan);
  if (hit.length > 0) {
    const best = hit.reduce((a, b) => ((b.avgDelta ?? -Infinity) > (a.avgDelta ?? -Infinity) ? b : a));
    points.push({ label: 'Hitscan', kind: 'hitscan', sens: best.sensAt1600, raw: best.avgOverall, delta: best.avgDelta, n: best.n });
  }

  const proj = bySpeed(data.byArchetype.projectile);
  if (proj.length > 0) {
    const best = proj.reduce((a, b) => ((b.avgDelta ?? -Infinity) > (a.avgDelta ?? -Infinity) ? b : a));
    points.push({ label: 'Projectile', kind: 'projectile', sens: best.sensAt1600, raw: best.avgOverall, delta: best.avgDelta, n: best.n });
  }

  for (const h of data.heroes) {
    // A hero's raw peak accuracy isn't stored directly — reconstruct it from
    // the hero's own baseline (avgOverall) plus its best scale's delta.
    const raw = h.avgOverall != null && h.bestScaleOverallDelta != null ? h.avgOverall + h.bestScaleOverallDelta : null;
    points.push({
      label: h.hero, kind: 'hero', n: h.bestScaleN, archetype: h.archetype,
      sens: h.bestScaleEDPI / MOUSE_DPI, raw, delta: h.bestScaleOverallDelta,
    });
  }

  const baseline = grandMeanAccuracy(data.heroes);
  const anchorPoint = points.find(p => p.kind === 'overall') ?? points[0] ?? null;
  const anchor = anchorPoint ? anchorPoint.sens : null;

  if (points.length < 2 || anchor == null) {
    return {
      verdict: 'insufficient',
      headline: `Not enough categories yet to judge whether sens should split — keep logging.`,
      points, anchor, threshold, baseline,
    };
  }

  const outliers = points.filter(p => p !== anchorPoint && Math.abs(p.sens - anchor) > threshold);

  if (outliers.length === 0) {
    return {
      verdict: 'grouped',
      headline: `All ${points.length} categories peak within ${threshold.toFixed(2)} sens of each other — one sens looks like it covers everything.`,
      points, anchor, threshold, baseline,
    };
  }

  return {
    verdict: 'scattered',
    headline: `${outliers.length} of ${points.length} categories peak more than ${threshold.toFixed(2)} sens from the rest (${outliers.map(o => o.label).join(', ')}) — worth testing a dedicated sens for ${outliers.length === 1 ? 'it' : 'them'}.`,
    points, anchor, threshold, baseline,
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
    const bestByWin = reliable.reduce((a, b) => ((b.winRate ?? -Infinity) > (a.winRate ?? -Infinity) ? b : a));

    // Win rate leads — it's the outcome that actually matters, not a proxy for
    // it like accuracy is. Called out on its own, then checked against the
    // accuracy-best scale so a disagreement between them doesn't get buried.
    if (bestByWin.winRate != null) {
      notes.push(
        `Your highest win rate is at ${fmtScale(bestByWin)} — ${f1(bestByWin.winRate)}% (${bestByWin.n} games).`,
      );
      if (bestByWin.cm360 !== bestByData.cm360) {
        notes.push(
          `That's a different scale than your top performer by accuracy (${fmtScale(bestByData)}, ${signed(bestByData.avgDelta)}% vs. your average) — win rate and accuracy aren't pointing the same way yet, so treat both as provisional until more games narrow it down.`,
        );
      }
    }

    // Lead with the best performer on its own terms — it's the "just right"
    // scale, not necessarily the fastest- or slowest-feeling one tested. Only
    // call out the fastest-feeling scale when it's a DIFFERENT scale, and frame
    // it as a correction ("feeling fast isn't the same as performing well"),
    // never as a virtue in its own right.
    notes.push(
      `Your best performer by accuracy is ${fmtScale(bestByData)} (${signed(bestByData.avgDelta)}% vs. your average, over ${bestByData.n} games), which felt ${f1(bestByData.avgFeel)}/100 for speed — accuracy peaks at the scale that's right for you, not at whichever end of the speed range you tested.`,
    );
    if (fastestFeel.cm360 !== bestByData.cm360 && fastestFeel.avgFeel != null) {
      notes.push(
        `${fmtScale(fastestFeel)} felt fastest to you (${f1(fastestFeel.avgFeel)}/100), but it isn't your top performer (${signed(fastestFeel.avgDelta)}% vs. your average, ${fastestFeel.n} games) — feeling fast doesn't mean it's the right sens.`,
      );
    }

    // Only call out a "weakest" scale once its gap from the best performer
    // clears the same bar the Recommendation card uses to call a scale
    // "clearly worse" — otherwise this fires for any different bucket, even
    // one that's not really distinguishable from the best.
    const worstGap = (bestByData.avgDelta ?? 0) - (worst.avgDelta ?? 0);
    if (worst.cm360 !== bestByData.cm360 && worstGap >= MEANINGFUL_DELTA_GAP) {
      notes.push(
        `Weakest scale with enough games to trust: ${fmtScale(worst)} runs ${signed(worst.avgDelta)}% vs. your average — felt speed ${f1(worst.avgFeel)}/100, ${worst.n} games.`,
      );
    }
  }

  const [cold, warm] = coldWarm;
  if (cold?.avgDelta != null && warm?.avgDelta != null) {
    const diff = cold.avgDelta - warm.avgDelta;
    if (Math.abs(diff) >= 1) {
      const winner = diff > 0 ? 'Cold starts' : 'Warmed-up games';
      notes.push(
        `${winner} perform better so far — cold ${signed(cold.avgDelta)}% vs. warm ${signed(warm.avgDelta)}%. Felt speed: cold ${f1(cold.avgFeel)}/100, warm ${f1(warm.avgFeel)}/100.`,
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
      `Hitscan vs. projectile isn't a fair comparison yet — projectile is just ${projGames} game${projGames === 1 ? '' : 's'}${projHero ? ` (${withHeroCount(projHero.hero, heroCounts).toUpperCase()})` : ''}, spread thin across scales.`,
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
      <SensNav dataInspectId="sensAnalysis-sensnav" />
      <div className="mb-6">
        <h1 data-inspect-id="sensAnalysis-header sensAnalysis-page-title" className="text-2xl heading-display text-[var(--ink)]">Sensitivity Analysis</h1>
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
      <div className="card" data-inspect-id="sensAnalysis-empty-state-banner sensAnalysis-no-data-banner">
        <p className="text-sm text-[var(--ink)]">No aim data yet.</p>
        <p className="text-xs text-[var(--faint)] mt-1.5">
          Log matches with their sensitivity, then record each one's stats on the{' '}
          <span className="text-ow-accent">Enter Stats</span> tab. Once a few sens values
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

  // Peak Sens by Category: one point per category, positioned by its own
  // best-performing scale — see buildSensSpread for why only peaks (not
  // every tested scale) are plotted.
  const spread = buildSensSpread(data);
  const spreadSensValues = spread.points.map(p => p.sens);
  // X domain hugs the tested points exactly (±0.05 sens) instead of an
  // auto-padded range — ticks are drawn only at each point's own sens value
  // (see the XAxis `ticks` prop below), so there's no "arbitrary" tick to pad for.
  const spreadXDomain: [number, number] = spreadSensValues.length
    ? [Math.min(...spreadSensValues) - 0.05, Math.max(...spreadSensValues) + 0.05]
    : [0, 1];
  // Y domain hugs the actual raw-accuracy values (plus the baseline, so the
  // reference line is always in view) instead of starting from 0 — these are
  // real percentages that cluster in a narrow band, not deltas anchored at a
  // fixed origin.
  const spreadRawValues = [...spread.points.map(p => p.raw), spread.baseline].filter((v): v is number => v != null);
  const spreadYDomain: [number, number] = spreadRawValues.length
    ? (() => {
        const lo = Math.min(...spreadRawValues);
        const hi = Math.max(...spreadRawValues);
        const pad = (hi - lo) * 0.15 || 1;
        return [lo - pad, hi + pad];
      })()
    : [0, 1];
  // Gridlines every 0.1 sens / 5 accuracy points — denser than the sparse,
  // label-driven axis ticks (one per category), so the plot area isn't bare.
  const spreadGridX = gridTicks(spreadXDomain[0], spreadXDomain[1], 0.1);
  const spreadGridY = gridTicks(spreadYDomain[0], spreadYDomain[1], 5);

  // Feel vs. Data quadrant: each scale plotted at (felt speed, accuracy delta),
  // with the crosshair sitting at Sean's own mean of each — so the four
  // quadrants read as above/below-average feel × above/below-average accuracy.
  const feelPts = byScaleSpeed.filter(r => r.avgFeel != null && r.avgDelta != null);
  const meanFeel = wMean(byScaleSpeed, 'avgFeel');
  const meanDelta = wMean(byScaleSpeed, 'avgDelta');
  const feelXDomain = centeredDomain(feelPts.map(r => r.avgFeel), meanFeel);
  const feelYDomain = centeredDomain(feelPts.map(r => r.avgDelta), meanDelta);

  const insights = buildInsights(data, heroCounts);
  const recommendation = buildRecommendation(data, spread);

  // Accuracy Over Time: chronological feed, not aggregated by scale — every
  // other chart on this page loses time order by aggregating, so a secular
  // drift (e.g. a practice effect improving accuracy independent of which
  // scale is active) would otherwise be invisible.
  const timelineData = buildTimelineChartData(data.timeline);
  const timelineScales = [...new Set(timelineData.map(p => p.cm360))].sort((a, b) => a - b);
  const timelineDeltaVals = timelineData.map(p => p.delta);
  const timelineYDomain: [number, number] = timelineDeltaVals.length
    ? (() => {
        const lo = Math.min(0, ...timelineDeltaVals);
        const hi = Math.max(0, ...timelineDeltaVals);
        const pad = (hi - lo) * 0.1 || 1;
        return [lo - pad, hi + pad];
      })()
    : [-1, 1];
  // One tick per ~6 points, so the date axis stays readable regardless of
  // how many matches have been logged.
  const timelineTickEvery = Math.max(1, Math.ceil(timelineData.length / 8));
  const timelineTicks = timelineData.filter((_, i) => i % timelineTickEvery === 0).map(p => p.index);

  // Curve Fit chart: sample the fitted quadratic across the tested range and
  // overlay the actual tested (sens, avgDelta) points it was fit through.
  const curveLine = data.overallCurveFit ? buildCurveLine(data.overallCurveFit) : null;
  const curveTestedPts = bySpeed(byScale.filter(r => r.avgDelta != null)).map(r => ({ x: r.sensAt1600, y: r.avgDelta as number, n: r.n }));

  return wrap(
    <div className="space-y-6">
      <p className="text-xs text-[var(--faint)]" data-inspect-id="sensAnalysis-summary-banner">
        <span className="text-[var(--ink)] font-bold">{summary.n}</span> logged matches across{' '}
        <span className="text-[var(--ink)] font-bold" data-inspect-id="sensAnalysis-summary-line">{summary.distinctScale}</span> different sens (@{MOUSE_DPI} DPI) scales.
        Accuracy is shown as how far above or below your own average you did on each hero, so heroes compare fairly.
        <br />
        <span className="text-[var(--faint-2)]">
          {fmtUpdated(summary.lastUpdated) ? `Last updated ${fmtUpdated(summary.lastUpdated)}` : 'Not yet updated'} —
          {' '}refreshes whenever a study match's stats are submitted on the Enter Stats tab.
        </span>
      </p>

      <p className="text-xs text-[var(--faint)] rounded-lg bg-ow-darker border border-ow-border px-3 py-2" data-inspect-id="sensAnalysis-standard-of-measure-banner">
        <span className="text-[var(--ink)] font-semibold">How scales are shown:</span> every scale on this page is
        shown as <span className="text-[var(--ink)]">in-game sens at {MOUSE_DPI} DPI</span> (eDPI ÷ {MOUSE_DPI}), not
        cm/360 or the raw DPI tested. DPI is what's actually being varied in testing, and your mouse settles back at
        {MOUSE_DPI} DPI once you commit to a result — so this is the number you'd actually dial in.
      </p>

      {/* DPI recommendation + continue-vs-narrow call */}
      <Section
        title="Recommendation"
        hint="A DPI suggestion plus a call on whether to keep exploring or start converging — recomputed from the same scale data below."
        dataInspectId="sensAnalysis-recommendation-card"
      >
        <div className="flex items-start gap-3 flex-wrap">
          <span data-inspect-id="sensAnalysis-recommendation-verdict-badge" className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold ${recommendation.verdict === 'narrow' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-ow-accent/15 text-ow-accent'}`}>
            <span data-inspect-id="sensAnalysis-recommendation-badge">{recommendation.verdict === 'narrow' ? 'Narrow focus' : 'Continue testing'}</span>
          </span>
          <p className="text-sm text-[var(--ink)] font-semibold flex-1 min-w-[200px]">{recommendation.headline}</p>
        </div>
        {recommendation.points.length > 0 && (
          <ul className="space-y-2 text-sm text-[var(--ink-2)] list-disc list-inside marker:text-ow-accent mt-3" data-inspect-id="sensAnalysis-recommendation-points-list">
            {recommendation.points.map((p, i) => <li key={i}>{p}</li>)}
          </ul>
        )}
      </Section>

      {/* Plain-language read of the charts below */}
      <Section
        title="What the Data Shows"
        hint="Auto-generated from the same numbers as the charts below — recomputed every time you log a match."
        dataInspectId="sensAnalysis-data-shows-card"
      >
        {insights.length > 0 ? (
          <ul className="space-y-2.5 text-sm text-[var(--ink-2)] list-disc list-inside marker:text-ow-accent" data-inspect-id="sensAnalysis-insights-list">
            {insights.map((note, i) => <li key={i}>{note}</li>)}
          </ul>
        ) : (
          <p className="text-xs text-[var(--faint)]">Not enough data yet for a confident read — keep logging.</p>
        )}
      </Section>

      {/* Feel vs Data + Peak Sens by Category, side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section
          title="Feel vs. Data"
          hint={`Each dot is a tested scale — how fast it felt (left/right) against how well you actually did (up/down). The crosshair marks your own averages. Bottom-right = feels fast but aims worse than usual (it's over-rated); top-left = feels slow but aims better (it's under-rated).`}
          dataInspectId="sensAnalysis-feel-vs-data-card"
        >
          <div className="flex gap-2">
            <div className="flex flex-col justify-between text-[10px] text-[var(--faint-2)] py-3 w-12 shrink-0 text-right">
              <span>More accurate</span>
              <span>Less accurate</span>
            </div>
            <div className="flex-1 min-w-0" data-inspect-id="sensAnalysis-feel-vs-data-chart">
              <ResponsiveContainer width="100%" height={280}>
                <ScatterChart data={feelPts} margin={{ top: 12, right: 12, bottom: 4, left: 0 }}>
                  <CartesianGrid stroke="rgb(var(--ow-border))" />
                  <XAxis type="number" dataKey="avgFeel" name="Felt speed" domain={feelXDomain} tick={false} tickLine={false} axisLine={false} />
                  <YAxis type="number" dataKey="avgDelta" name="Accuracy vs. avg" domain={feelYDomain} tick={false} tickLine={false} axisLine={false} width={4} />
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

        {/* Peak Sens by Category — one point per category (Overall, Hitscan,
            Projectile, each hero) at that category's own best-performing scale.
            Tight cluster = one sens fits everything; scattered = worth splitting. */}
        <Section
          title="Peak Sens by Category"
          hint={`One point per category — Overall, Hitscan, Projectile, and each hero — placed at that category's own best-performing scale (not every tested scale, just the peak). The shaded band marks "close enough" to Overall${Number.isFinite(spread.threshold) ? ` (±${spread.threshold.toFixed(2)} sens)` : ''}; points inside it don't need their own sens, points outside might.`}
          dataInspectId="sensAnalysis-peak-sens-by-category-chart sensAnalysis-peak-sens-card"
        >
          <div className="flex items-start gap-3 flex-wrap mb-3">
            <span data-inspect-id="sensAnalysis-peak-sens-verdict-badge" className={`inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold ${spread.verdict === 'scattered' ? 'bg-amber-500/15 text-amber-500' : spread.verdict === 'grouped' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-ow-accent/15 text-ow-accent'}`}>
              <span data-inspect-id="sensAnalysis-peak-sens-badge">{spread.verdict === 'scattered' ? 'Split may help' : spread.verdict === 'grouped' ? 'One sens fits all' : 'Not enough data'}</span>
            </span>
            <p className="text-sm text-[var(--ink)] font-semibold flex-1 min-w-[200px]">{spread.headline}</p>
          </div>
          {spread.points.length >= 2 ? (
            <div className="flex-1 min-w-0" data-inspect-id="sensAnalysis-peak-sens-chart">
              <ResponsiveContainer width="100%" height={280}>
                <ScatterChart data={spread.points} margin={{ top: 16, right: 16, bottom: 24, left: 10 }}>
                  <CartesianGrid stroke="rgb(var(--ow-border))" strokeOpacity={0.5} strokeDasharray="3 3" verticalValues={spreadGridX} horizontalValues={spreadGridY} />
                  <XAxis
                    dataKey="sens" type="number" name="Sens" domain={spreadXDomain}
                    ticks={spreadSensValues} tickFormatter={(v: number) => v.toFixed(2)}
                    tick={axisStyle} tickLine={{ stroke: 'rgb(var(--ow-border))' }} axisLine={{ stroke: 'rgb(var(--ow-border))' }}
                    label={{ value: `In-game Sens (@${MOUSE_DPI} dpi)`, position: 'insideBottom', offset: -8, style: { fill: 'var(--faint)', fontSize: 11 } }}
                  />
                  {/* tick={false} would hide the numbers, but it also silently
                      drops CartesianGrid's horizontalValues lines entirely in
                      this Recharts version — render an empty tick instead. */}
                  <YAxis
                    dataKey="raw" type="number" domain={spreadYDomain} tick={() => <g />}
                    tickLine={{ stroke: 'rgb(var(--ow-border))' }} axisLine={{ stroke: 'rgb(var(--ow-border))' }} width={60}
                    label={{ value: 'Accuracy (%)', angle: -90, position: 'insideLeft', style: { textAnchor: 'middle', fill: 'var(--faint)', fontSize: 11 } }}
                  />
                  <Tooltip content={<SpreadTooltip />} cursor={{ strokeDasharray: '3 3' }} />
                  {spread.anchor != null && Number.isFinite(spread.threshold) && (
                    <ReferenceArea x1={spread.anchor - spread.threshold} x2={spread.anchor + spread.threshold} fill={FEEL} fillOpacity={0.08} stroke="none" />
                  )}
                  {spread.anchor != null && <ReferenceLine x={spread.anchor} stroke="var(--faint-2)" strokeDasharray="4 4" />}
                  {/* Baseline = the overall mean accuracy across every logged
                      point (n-weighted across heroes) — the reference every
                      category's peak is measured against. */}
                  {spread.baseline != null && (
                    <ReferenceLine
                      y={spread.baseline} stroke="var(--faint-2)" strokeDasharray="4 4"
                      label={{ value: `Your average: ${f1(spread.baseline)}%`, position: 'insideBottomLeft', fill: 'var(--faint)', fontSize: 10 }}
                    />
                  )}
                  {/* Drop line from each point down to the baseline, so its
                      x-axis tick reads as "this category's peak lands here." */}
                  {spread.points.map((p, i) => p.raw != null && spread.baseline != null && (
                    <ReferenceLine key={i} segment={[{ x: p.sens, y: spread.baseline }, { x: p.sens, y: p.raw }]} stroke="var(--faint-2)" strokeOpacity={0.5} strokeDasharray="3 3" />
                  ))}
                  <Scatter dataKey="raw" fill={FEEL}>
                    {/* Points are identified by name label rather than color —
                        with a dozen-plus categories/heroes, distinct colors
                        stopped being distinguishable at a glance. */}
                    <LabelList
                      dataKey="raw"
                      content={(props: any) => {
                        const { x, y, index } = props;
                        const p = spread.points[index];
                        if (p?.raw == null) return null;
                        return (
                          <g>
                            <text x={x + 8} y={y - 8} textAnchor="start" fontSize={10} fontWeight={600} fill="var(--ink)">{p.label}</text>
                            <text x={x + 8} y={y + 4} textAnchor="start" fontSize={9} fontWeight={700} fill="var(--faint)">{p.raw.toFixed(1)}%</text>
                          </g>
                        );
                      }}
                    />
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <p className="text-xs text-[var(--faint)]">Not enough categories yet to plot — keep logging.</p>
          )}
        </Section>
      </div>

      {/* Accuracy Over Time — chronological, not aggregated by scale, so a
          secular drift (practice effect) shows up as a trend independent of
          whichever scale happens to be active. */}
      <Section
        title="Accuracy Over Time"
        hint={`Every logged point in the order it was played (not grouped by scale) — color marks which scale (@${MOUSE_DPI} DPI sens) was active. The dashed line is a trailing ${TIMELINE_WINDOW}-game average: if it drifts up over the whole study regardless of color, that's practice improving your aim, not any one scale winning.`}
        dataInspectId="sensAnalysis-accuracy-over-time-chart"
      >
        {timelineData.length >= 3 ? (
          <>
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart data={timelineData} margin={{ top: 12, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid stroke="rgb(var(--ow-border))" strokeOpacity={0.5} strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="index" type="number" domain={[0, timelineData.length - 1]} ticks={timelineTicks}
                  tickFormatter={(i: number) => fmtDate(timelineData[i]?.date ?? '')}
                  tick={axisStyle} tickLine={{ stroke: 'rgb(var(--ow-border))' }} axisLine={{ stroke: 'rgb(var(--ow-border))' }}
                />
                <YAxis
                  domain={timelineYDomain} tick={axisStyle} tickLine={{ stroke: 'rgb(var(--ow-border))' }} axisLine={{ stroke: 'rgb(var(--ow-border))' }} width={40}
                  label={{ value: 'Accuracy vs. avg', angle: -90, position: 'insideLeft', style: { textAnchor: 'middle', fill: 'var(--faint)', fontSize: 11 } }}
                />
                <Tooltip content={<TimelineTooltip />} cursor={{ strokeDasharray: '3 3' }} />
                <ReferenceLine y={0} stroke="var(--faint-2)" strokeDasharray="4 4" />
                <Scatter
                  dataKey="delta" isAnimationActive={false}
                  shape={(props: any) => <circle cx={props.cx} cy={props.cy} r={3} fill={scaleColor(props.payload.cm360)} />}
                />
                <Line type="monotone" dataKey="rollingDelta" stroke={FEEL} strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
              </ComposedChart>
            </ResponsiveContainer>
            <div className="flex items-center gap-3 text-[10px] text-[var(--faint-2)] mt-2 flex-wrap">
              {timelineScales.map(s => (
                <span key={s} className="inline-flex items-center gap-1">
                  <span className="inline-block w-2 h-2 rounded-full" style={{ background: scaleColor(s) }} />
                  {timelineData.find(p => p.cm360 === s)?.sensAt1600.toFixed(2)} sens
                </span>
              ))}
              <span className="inline-flex items-center gap-1"><span className="inline-block w-3 h-0.5" style={{ background: FEEL }} />{TIMELINE_WINDOW}-game trend</span>
            </div>
          </>
        ) : (
          <p className="text-xs text-[var(--faint)]">Not enough logged points yet to chart a timeline.</p>
        )}
      </Section>

      {/* Cold vs Warm + Adaptation */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Section title="Cold vs. Warm" hint="First game of a session vs. later ones — is a sens good from the jump, or only once warmed up?" dataInspectId="sensAnalysis-cold-warm-card">
          <div className="grid grid-cols-2 gap-3" data-inspect-id="sensAnalysis-cold-warm-stat-grid sensAnalysis-cold-warm-tiles">
            {coldWarm.map(b => (
              <div key={b.bucket} className="rounded-lg bg-ow-darker border border-ow-border p-3">
                <div className="text-[11px] text-[var(--faint)] mb-1">{b.bucket}</div>
                <div className="text-2xl num-display text-[var(--ink)]">{f1(b.avgOverall)}<span className="text-xs text-[var(--faint)] ml-0.5">%</span></div>
                <div className="text-[11px] text-[var(--faint-2)] mt-1 font-bold">{signed(b.avgDelta)} vs. avg · felt speed {f1(b.avgFeel)}/100 · {b.n} game{b.n === 1 ? '' : 's'}</div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Adaptation" hint="Just after a sens change vs. once settled — separates a genuinely worse sens from one you hadn't adjusted to yet." dataInspectId="sensAnalysis-adaptation-card">
          <div className="grid grid-cols-2 gap-3" data-inspect-id="sensAnalysis-adaptation-stat-grid sensAnalysis-adaptation-tiles">
            {adaptation.map(b => (
              <div key={b.bucket} className="rounded-lg bg-ow-darker border border-ow-border p-3">
                <div className="text-[11px] text-[var(--faint)] mb-1">{b.bucket}</div>
                <div className="text-2xl num-display text-[var(--ink)]">{f1(b.avgOverall)}<span className="text-xs text-[var(--faint)] ml-0.5">%</span></div>
                <div className="text-[11px] text-[var(--faint-2)] mt-1 font-bold">{signed(b.avgDelta)} vs. avg · felt speed {f1(b.avgFeel)}/100 · {b.n} game{b.n === 1 ? '' : 's'}</div>
              </div>
            ))}
          </div>
        </Section>
      </div>

      {/* Per-scale table */}
      <Section title={`By Scale (sens @${MOUSE_DPI} DPI)`} hint={`Every scale you've tested, shown as in-game sens at ${MOUSE_DPI} DPI, with its eDPI and averages. Win % is your actual win rate at that scale — what really matters, vs. accuracy which is just a stand-in for it. "vs. Avg" is accuracy compared to how you usually do. "Sens" is the raw in-game value used during testing (it stayed fixed while DPI changed between test stages).`} dataInspectId="sensAnalysis-by-scale-table">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] text-[var(--muted)] uppercase tracking-wider text-left">
                <th className="py-1.5 pr-3">{`Sens @${MOUSE_DPI}`}</th><th className="py-1.5 pr-3">eDPI</th><th className="py-1.5 pr-3">Sens</th><th className="py-1.5 pr-3">n</th>
                <th className="py-1.5 pr-3">Win %</th><th className="py-1.5 pr-3">Overall</th><th className="py-1.5 pr-3">Crit</th><th className="py-1.5 pr-3">Felt speed</th><th className="py-1.5">vs. Avg</th>
              </tr>
            </thead>
            <tbody className="font-bold">
              {byScaleSpeed.map(r => (
                <tr key={r.cm360} className="border-t border-ow-border text-[var(--ink-2)]">
                  <td className="py-1.5 pr-3 text-[var(--ink)]">{r.sensAt1600.toFixed(2)}</td>
                  <td className="py-1.5 pr-3">{r.eDPI}</td>
                  <td className="py-1.5 pr-3">{r.sens}</td>
                  <td className="py-1.5 pr-3">
                    {r.n}
                    {r.absorbedN > 0 && (
                      <span className="text-[10px] font-normal text-[var(--faint-2)] ml-1">({r.absorbedN} absorbed)</span>
                    )}
                    {r.n >= RELIABLE_N && r.dateSpanDays < 3 && (
                      <span
                        className="text-[10px] font-normal text-amber-600 dark:text-amber-400 ml-1"
                        title="Tested mostly in one short window — may reflect that session more than a stable read"
                      >
                        ⚠
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 text-[var(--ink)]">{f1(r.winRate)}%</td>
                  <td className="py-1.5 pr-3">{f1(r.avgOverall)}%</td>
                  <td className="py-1.5 pr-3">{f1(r.avgCrit)}%</td>
                  <td className="py-1.5 pr-3">{f1(r.avgFeel)}/100</td>
                  <td className={`py-1.5 ${deltaColor(r.avgDelta)}`}>{signed(r.avgDelta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* By hero */}
      <Section title="By Hero" hint={`Games logged per hero — a small number here isn't trustworthy yet. Best Sens is the sens (@${MOUSE_DPI} DPI) where that hero's own accuracy is highest, with the game count in parens — treat it as unreliable below ${RELIABLE_N} games. "vs. Avg" columns compare that scale's accuracy to how the hero usually does.`} dataInspectId="sensAnalysis-by-hero-table">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] text-[var(--muted)] uppercase tracking-wider text-left">
                <th className="py-1.5 pr-3">Hero</th><th className="py-1.5 pr-3">Type</th><th className="py-1.5 pr-3">n</th>
                <th className="py-1.5 pr-3">Win %</th><th className="py-1.5 pr-3">Overall</th><th className="py-1.5 pr-3">Crit</th><th className="py-1.5 pr-3">Best Sens</th>
                <th className="py-1.5 pr-3">Overall vs. Avg</th><th className="py-1.5">Crit vs. Avg</th>
              </tr>
            </thead>
            <tbody>
              {heroes.map(h => (
                <tr key={h.hero} className="border-t border-ow-border text-[var(--ink-2)]">
                  <td className="py-1.5 pr-3 text-xs hero-name text-[var(--ink)]">{withHeroCount(h.hero, heroCounts)}</td>
                  <td className="py-1.5 pr-3 capitalize text-[var(--faint)]">{h.archetype}</td>
                  <td className="py-1.5 pr-3 font-bold">{h.n}</td>
                  <td className="py-1.5 pr-3 font-bold text-[var(--ink)]">{f1(h.winRate)}%</td>
                  <td className="py-1.5 pr-3 font-bold">{f1(h.avgOverall)}%</td>
                  <td className="py-1.5 pr-3 font-bold">{f1(h.avgCrit)}%</td>
                  <td className={h.bestScaleN < RELIABLE_N ? 'py-1.5 pr-3 text-[var(--faint)] font-bold' : 'py-1.5 pr-3 font-bold'}>
                    {(h.bestScaleEDPI / MOUSE_DPI).toFixed(2)} <span className="text-[10px] text-[var(--faint-2)]">(n={h.bestScaleN})</span>
                  </td>
                  <td className={`py-1.5 pr-3 font-bold ${deltaColor(h.bestScaleOverallDelta)}`}>{signed(h.bestScaleOverallDelta)}</td>
                  <td className={`py-1.5 font-bold ${deltaColor(h.bestScaleCritDelta)}`}>{signed(h.bestScaleCritDelta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Curve fit — a quadratic (a*x^2 + b*x + c) fit across each hero's
          tested scales (avgDelta vs. sens, weighted by n), naming a
          continuous best-guess optimal sens rather than just whichever
          tested point happened to score best. */}
      {(() => {
        const rows: { label: string; fit: CurveFit | null }[] = [
          { label: 'Overall', fit: data.overallCurveFit },
          ...heroes.map(h => ({ label: h.hero, fit: h.curveFit })),
        ];
        const withFit = rows.filter(r => r.fit != null);
        const fitNote = (fit: CurveFit): { text: string; tone: 'good' | 'warn' | 'neutral' } => {
          if (!fit.hasInteriorPeak) {
            return { text: 'Accuracy is still climbing toward one edge of what you’ve tested, not leveling off in the middle — try testing further past that edge.', tone: 'warn' };
          }
          if (!fit.inRange) {
            return { text: `The estimated best sens falls outside what you’ve actually tested (${fit.testedSensMin.toFixed(2)}–${fit.testedSensMax.toFixed(2)}) — it’s a guess based on the trend, not something you’ve tried. Treat it as a direction to test toward, not a final answer.`, tone: 'warn' };
          }
          if (fit.r2 >= 0.5 && fit.totalN >= CONFIDENT_N && fit.points >= CONFIDENT_SCALES) {
            return { text: `Fits your results well, and you’ve logged enough games and scales behind it — a reasonably solid guess.`, tone: 'good' };
          }
          return { text: `Only ${fit.totalN} games across ${fit.points} scales so far — a rough guess, still thin. Keep logging.`, tone: 'neutral' };
        };
        return (
          <Section
            title="Estimated Sweet Spot"
            hint="Draws a smooth curve through each category's tested scales to guess where accuracy actually peaks, instead of just picking whichever tested scale happened to score best. Needs at least 3 different tested scales to draw a curve at all."
            dataInspectId="sensAnalysis-curve-fit-card"
          >
            {curveLine && curveTestedPts.length >= 3 && (
              <div className="mb-5" data-inspect-id="sensAnalysis-curve-fit-chart">
                <ResponsiveContainer width="100%" height={240}>
                  <ComposedChart margin={{ top: 12, right: 16, bottom: 4, left: 0 }}>
                    <CartesianGrid stroke="rgb(var(--ow-border))" strokeOpacity={0.5} strokeDasharray="3 3" />
                    <XAxis
                      dataKey="x" type="number" domain={['dataMin', 'dataMax']} allowDuplicatedCategory={false}
                      tickFormatter={(v: number) => v.toFixed(2)} tick={axisStyle}
                      tickLine={{ stroke: 'rgb(var(--ow-border))' }} axisLine={{ stroke: 'rgb(var(--ow-border))' }}
                      label={{ value: `In-game Sens (@${MOUSE_DPI} dpi)`, position: 'insideBottom', offset: -4, style: { fill: 'var(--faint)', fontSize: 11 } }}
                    />
                    <YAxis
                      dataKey="y" type="number" tick={axisStyle} width={44}
                      tickLine={{ stroke: 'rgb(var(--ow-border))' }} axisLine={{ stroke: 'rgb(var(--ow-border))' }}
                      label={{ value: 'Accuracy vs. avg', angle: -90, position: 'insideLeft', style: { textAnchor: 'middle', fill: 'var(--faint)', fontSize: 11 } }}
                    />
                    <Tooltip content={<CurveTooltip />} />
                    <ReferenceLine y={0} stroke="var(--faint-2)" strokeDasharray="4 4" />
                    {data.overallCurveFit?.hasInteriorPeak && data.overallCurveFit.optimalSens != null && (
                      <ReferenceLine
                        x={data.overallCurveFit.optimalSens} stroke={FEEL} strokeDasharray="4 4"
                        label={{ value: `estimated peak ${data.overallCurveFit.optimalSens.toFixed(2)}`, position: 'top', fill: FEEL, fontSize: 10 }}
                      />
                    )}
                    <Line data={curveLine} dataKey="y" stroke={FEEL} strokeWidth={2} dot={false} isAnimationActive={false} name="Estimated curve" />
                    <Scatter data={curveTestedPts} dataKey="y" fill="var(--ink)" name="Tested scales" />
                  </ComposedChart>
                </ResponsiveContainer>
                <p className="text-[10px] text-[var(--faint-2)] mt-1">Orange line: the estimated curve. Dark dots: your actual tested scales it's based on (Overall only).</p>
              </div>
            )}
            {withFit.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] text-[var(--muted)] uppercase tracking-wider text-left">
                      <th className="py-1.5 pr-3">Category</th><th className="py-1.5 pr-3">Scales Tested</th><th className="py-1.5 pr-3">Games Logged</th>
                      <th className="py-1.5 pr-3">Estimated Best Sens</th><th className="py-1.5 pr-3">Estimated Result</th><th className="py-1.5">Read</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => {
                      if (!r.fit) {
                        return (
                          <tr key={r.label} className="border-t border-ow-border text-[var(--faint)]">
                            <td className="py-1.5 pr-3 hero-name text-[var(--ink)]">{r.label === 'Overall' ? r.label : withHeroCount(r.label, heroCounts)}</td>
                            <td className="py-1.5 pr-3" colSpan={4}>Needs at least 3 different tested scales to draw a curve.</td>
                          </tr>
                        );
                      }
                      const note = fitNote(r.fit);
                      const toneClass = note.tone === 'good' ? 'text-emerald-700 dark:text-emerald-500' : note.tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : 'text-[var(--faint)]';
                      return (
                        <tr key={r.label} className="border-t border-ow-border text-[var(--ink-2)] align-top">
                          <td className="py-1.5 pr-3 hero-name text-[var(--ink)] font-bold whitespace-nowrap">{r.label === 'Overall' ? r.label : withHeroCount(r.label, heroCounts)}</td>
                          <td className="py-1.5 pr-3 font-bold">{r.fit.points}</td>
                          <td className="py-1.5 pr-3 font-bold">{r.fit.totalN}</td>
                          <td className="py-1.5 pr-3 font-bold text-[var(--ink)] whitespace-nowrap">
                            {r.fit.hasInteriorPeak ? r.fit.optimalSens?.toFixed(2) : '—'}
                          </td>
                          <td className={`py-1.5 pr-3 font-bold ${deltaColor(r.fit.predictedDelta)}`}>{r.fit.hasInteriorPeak ? signed(r.fit.predictedDelta) : '—'}</td>
                          <td className={`py-1.5 text-xs ${toneClass}`}>{note.text}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-[var(--faint)]">No category has 3+ different tested scales yet — keep spreading games across scales.</p>
            )}
          </Section>
        );
      })()}

      {/* Accuracy by Sens, per hero — one unified box plot: sens on x, accuracy
          on y, one color-coded box (min/Q1/median/Q3/max) per hero per scale. */}
      {(() => {
        const boxRows = buildHeroBoxRows(data);
        const testedHeroes = heroes.filter(h => boxRows.some(row => row.heroes[h.hero] != null));
        const allStats = boxRows.flatMap(row => Object.values(row.heroes)).filter((s): s is HeroBoxStats => s != null);
        const yPad = 3;
        const yDomain: [number, number] = allStats.length
          ? [Math.max(0, Math.min(...allStats.map(s => s.min)) - yPad), Math.min(100, Math.max(...allStats.map(s => s.max)) + yPad)]
          : [0, 100];
        const skipped = heroes.length - testedHeroes.length;
        return (
          <Section
            title="Accuracy by Sens — Per Hero"
            hint={`Sens (@${MOUSE_DPI} DPI) left to right, accuracy up the side — one box per hero per scale it's been tested at (needs 2+ logged games there). Each box covers the middle half of that hero's results, with a line for the typical result and whiskers reaching to the best/worst game.${skipped ? ` ${skipped} hero${skipped === 1 ? '' : 's'} skipped — never tested at 2+ games on the same scale.` : ''}`}
            dataInspectId="sensAnalysis-accuracy-by-sens-per-hero-chart"
          >
            {testedHeroes.length ? (
              <>
                <ResponsiveContainer width="100%" height={340}>
                  <ComposedChart data={boxRows} margin={{ top: 8, right: 16, bottom: 24, left: 10 }} barGap={2} barCategoryGap="20%">
                    <CartesianGrid stroke="rgb(var(--ow-border))" strokeOpacity={0.5} strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="label" tick={axisStyle} tickLine={{ stroke: 'rgb(var(--ow-border))' }} axisLine={{ stroke: 'rgb(var(--ow-border))' }}
                      label={{ value: `In-game Sens (@${MOUSE_DPI} dpi)`, position: 'insideBottom', offset: -8, style: { fill: 'var(--faint)', fontSize: 11 } }}
                    />
                    <YAxis
                      domain={yDomain} tick={axisStyle} tickLine={{ stroke: 'rgb(var(--ow-border))' }} axisLine={{ stroke: 'rgb(var(--ow-border))' }}
                      label={{ value: 'Accuracy (%)', angle: -90, position: 'insideLeft', style: { textAnchor: 'middle', fill: 'var(--faint)', fontSize: 11 } }}
                    />
                    <Tooltip content={<HeroBoxTooltip />} cursor={{ fill: 'var(--faint-2)', fillOpacity: 0.08 }} />
                    {testedHeroes.map(h => (
                      <Bar
                        key={h.hero} name={h.hero}
                        dataKey={(row: HeroBoxRow) => { const s = row.heroes[h.hero]; return s ? [s.q1, s.q3] : [0, 0]; }}
                        shape={heroBoxShape(h.hero)} isAnimationActive={false}
                      />
                    ))}
                  </ComposedChart>
                </ResponsiveContainer>
                <div className="flex items-center gap-4 text-[10px] text-[var(--faint-2)] mt-2 flex-wrap">
                  {testedHeroes.map(h => (
                    <span key={h.hero} className="inline-flex items-center gap-1 name-caps">
                      <span className="inline-block w-2 h-2 rounded-full" style={{ background: heroColor(h.hero) }} />
                      {h.hero}
                    </span>
                  ))}
                </div>
              </>
            ) : (
              <p className="text-xs text-[var(--faint)]">Not enough per-hero, per-scale samples yet — keep logging games so a scale can build up 2+ per hero.</p>
            )}
          </Section>
        );
      })()}

    </div>,
  );
}
