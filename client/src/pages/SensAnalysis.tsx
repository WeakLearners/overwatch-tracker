import {
  ResponsiveContainer, ScatterChart, Scatter, LabelList,
  ComposedChart, Bar, Line,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, ReferenceArea,
} from 'recharts';
import { useApi } from '../hooks/useApi';
import SensNav from '../components/SensNav';
import { MOUSE_DPI } from '../lib/aim';
import { useTodayHeroCounts, withHeroCount } from '../hooks/useHeroCounts';
// Per-hero stat-slot names, shared with the SensLog entry form. Without these
// this page printed Ana's sleep dart hit rate under a column headed "Crit".
import { critSlotShort, extraSlotShort, hasCrit } from '../lib/heroStatLabels';

interface ScaleRow {
  cm360: number; eDPI: number; sens: number; n: number;
  avgOverall: number | null; avgCrit: number | null;
  // avgCritDelta was computed and sent by the server all along but never
  // declared here — nothing on this page could read it. Declaring it now so
  // it can feed the co-primary "best scale" pick below (2026-09-17).
  avgCritDelta: number | null;
  // Ability-level stats at this scale. Each carries its own n because it's
  // far sparser than the bucket's overall-accuracy n — a bucket of 10 games
  // may hold only 3 readings of the signature stat.
  nExtra: number; avgExtra: number | null; avgExtraDelta: number | null;
  nHeroStat: number; avgHeroStat: number | null; avgHeroStatDelta: number | null;
  // Output rates (per 10 minutes on hero). nRate covers damage/elims/deaths;
  // healing carries its own n because only supports log it.
  nRate: number; nHeal: number;
  avgDmg10: number | null; avgDmg10Delta: number | null;
  avgHeal10: number | null; avgHeal10Delta: number | null;
  avgElims10: number | null; avgElims10Delta: number | null;
  avgDeaths10: number | null; avgDeaths10Delta: number | null;
  avgFeel: number | null; avgDelta: number | null; winRate: number | null;
  min: number | null; q1: number | null; median: number | null; q3: number | null; max: number | null;
  absorbedN: number; distinctDates: number; dateSpanDays: number;
  // n >= MIN_SCALE_N (5) on the server. A bucket below this is still
  // returned and shown — never hidden — but must not be picked as a "best"
  // scale or feed a curve fit / finding / recommendation. See RELIABLE_N.
  reliable: boolean;
  // Which curve setting(s) this bucket's games were actually played under
  // (2026-09-17). Length > 1 means this ONE scale bucket mixes matches from
  // different curve treatments (including curve-off vs. curve-on) — its
  // pooled averages above are not a clean single-variable comparison.
  curveVariants: CurveVariant[];
}
// One curve setting a set of matches was played under — curve off is its own
// variant, not "no data". See aim.ts's summarizeCurveVariants.
interface CurveVariant {
  curveEnabled: boolean; smooth: number | null; input: number | null; output: number | null;
  n: number; avgOverall: number | null; avgDelta: number | null;
}
interface Bucket {
  bucket: string; n: number;
  avgOverall: number | null; avgDelta: number | null; avgFeel: number | null; winRate: number | null;
}
export interface CurveFit {
  points: number; totalN: number; r2: number;
  optimalSens: number | null; predictedDelta: number | null;
  hasInteriorPeak: boolean; inRange: boolean;
  testedSensMin: number; testedSensMax: number;
  a: number; b: number; c: number;
}
// One metric's relationship with sens: the direction it moves, how much it
// moves across the whole tested range, and how tightly the points actually
// follow that line (r2, 0-1). A big spanDelta with a low r2 is scatter, not a
// finding — which is why the two are always reported together.
interface MetricTrend {
  key: string; label: string; unit: string;
  basis: 'raw' | 'normalized';
  lowerIsBetter: boolean;
  scales: number; totalN: number;
  slope: number | null; spanDelta: number | null; r2: number | null;
  sensMin: number | null; sensMax: number | null;
}
interface TimelinePoint {
  date: string; hero: string; win: 0 | 1; eDPI: number; cm360: number; delta: number;
}
interface HeroRow {
  hero: string; archetype: string; n: number;
  avgOverall: number | null; avgCrit: number | null; winRate: number | null;
  bestScaleEDPI: number | null; bestScaleN: number; bestScaleReliable: boolean;
  bestScaleOverallDelta: number | null; bestScaleCritDelta: number | null; bestScaleWinRate: number | null;
  bestScaleExtraDelta: number | null; bestScaleHeroStatDelta: number | null;
  // Signature stat (aim_stats.hero_stat_value). Its label is stored per match
  // rather than hardcoded client-side, so it arrives from the API.
  heroStatLabel: string | null; nHeroStat: number; avgHeroStat: number | null;
  nExtra: number; avgExtra: number | null;
  metricTrends: MetricTrend[];
  scales: ScaleRow[];
  curveFit: CurveFit | null;
  // Co-primary companion to curveFit (2026-09-17) — same quadratic fit, run
  // against this hero's own richest crit/extra/signature-stat channel
  // instead of accuracy. heroStatCurveChannel names which channel that was,
  // so the client can label the chart honestly rather than call it "Crit"
  // for a hero whose curve is actually its raw kill count.
  heroStatCurveFit: CurveFit | null;
  heroStatCurveChannel: 'crit' | 'extra' | 'heroStat' | null;
}
interface Analysis {
  summary: { n: number; distinctScale: number; lastUpdated: string | null };
  timeline: TimelinePoint[];
  byScale: ScaleRow[];
  // The Rawaccel curve currently live (2026-09-17) — same shape GET
  // /api/aim/curve returns, included here so this page can show what curve
  // is actually running without a second request.
  liveCurve: { smooth: number; input: number; output: number };
  // Roster-wide curve-variant breakdown (2026-09-17) — see CurveVariant.
  curveBreakdown: CurveVariant[];
  overallCurveFit: CurveFit | null;
  // Co-primary companion to overallCurveFit — same fit, run against
  // avgCritDelta pooled across the whole roster. See aim.ts's comment on why
  // crit specifically (the one hero-specific channel already pooled
  // roster-wide elsewhere).
  heroStatCurveFit: CurveFit | null;
  metricTrends: MetricTrend[];
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
function QuadrantTooltip({ active, payload }: { active?: boolean; payload?: { payload: ScaleRow & { sensAt1600: number; feelOff: number } }[] }) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div style={{ background: 'rgb(var(--ow-card))', border: '1px solid rgb(var(--ow-border))', borderRadius: 8, fontSize: 12, padding: '6px 10px' }}>
      <div style={{ fontWeight: 700 }}>{p.sensAt1600.toFixed(2)} sens @ {MOUSE_DPI} DPI</div>
      <div>Felt speed: <b style={{ fontWeight: 700 }}>{f1(p.avgFeel)}</b>/100 <span style={{ opacity: 0.7 }}>({f1(p.feelOff)} from neutral)</span></div>
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
      <h2 className="text-sm card-title">{title}</h2>
      <p className="text-xs text-[var(--faint)] mt-1 mb-4">{hint}</p>
      {children}
    </div>
  );
}

const axisStyle = { fontSize: 11, fill: 'var(--faint)' };

// Mirrors the server's MIN_SCALE_N (routes/aim.ts). Kept equal on purpose:
// "enough games at a scale to trust it" should mean one thing app-wide, and
// this page previously said 4 while SensLog said 3 and Prematch said nothing.
const RELIABLE_N = 5;

// ── Co-primary "best scale" selection ───────────────────────────────────────
// Sean's call, 2026-09-17: "hero stats should be co-primary, weight them
// equally." Combines by RANK, not raw magnitude — accuracy deltas are
// percentage points, a signature stat can be a raw per-match count, and
// averaging raw deltas would just let whichever channel has bigger numbers
// win. Ranking each channel among the candidates first makes "equal weight"
// hold regardless of units. Mirrors the identical helper in aim.ts — kept as
// two copies (server/client have no shared module) rather than one, but the
// logic must stay in step; if you change one, change the other.
function rankOf<T>(items: T[], valueOf: (t: T) => number | null): Map<T, number> {
  const withVal = items
    .map(it => ({ it, v: valueOf(it) }))
    .filter((x): x is { it: T; v: number } => x.v != null)
    .sort((a, b) => b.v - a.v); // descending: higher value = better = rank 1
  const ranks = new Map<T, number>();
  withVal.forEach((x, i) => ranks.set(x.it, i + 1));
  return ranks;
}

function coPrimaryBest<T>(
  items: T[],
  accuracyOf: (t: T) => number | null,
  heroStatChannels: ((t: T) => number | null)[],
): T | null {
  if (!items.length) return null;
  const accRank = rankOf(items, accuracyOf);
  const channelRanks = heroStatChannels.map(ch => rankOf(items, ch));
  let best: T | null = null;
  let bestScore = Infinity;
  for (const it of items) {
    const a = accRank.get(it) ?? null;
    const subRanks = channelRanks.map(r => r.get(it)).filter((r): r is number => r != null);
    const h = subRanks.length ? subRanks.reduce((s, r) => s + r, 0) / subRanks.length : null;
    const score = a != null && h != null ? (a + h) / 2 : (a ?? h);
    if (score != null && score < bestScore) { bestScore = score; best = it; }
  }
  return best ?? items[0];
}

// The three hero-specific channels available at ScaleRow grain (crit,
// extra_acc, and the pooled signature-stat delta) — passed to coPrimaryBest
// wherever a ScaleRow-shaped "best" pick needs to weigh hero stats equally.
const HERO_STAT_CHANNELS: ((r: ScaleRow) => number | null)[] = [
  r => r.avgCritDelta, r => r.avgExtraDelta, r => r.avgHeroStatDelta,
];
// Whichever hero-stat channel has a reading at a given scale — same fallback
// order the Recommendation card already uses (crit, then extra, then the raw
// signature stat) — pulled into one helper since tie-detection below needs it
// too.
const heroStatDeltaOf = (r: ScaleRow): number | null => r.avgCritDelta ?? r.avgExtraDelta ?? r.avgHeroStatDelta;

// Runner-up + near-tie check for a hero's "best" scale (2026-09-17, Sean's
// call — Zenyatta's pick moved from 2.18 to 2.50 on gaps of 0.3-0.1 points,
// which is the rank combine breaking an effective tie, not a finding; Soldier:
// 76's 2.65 vs 2.27 is a real result on both channels). Runs the SAME
// coPrimaryBest the server used to pick bestScale, a second time with the
// winner removed, so the page can say when the "best" pick barely edged out
// its nearest rival instead of only ever showing one confident-looking
// number. Needs no server change — h.scales already carries every reliable
// scale's full delta set.
function heroTieInfo(h: HeroRow): { best: ScaleRow | null; runnerUp: ScaleRow | null; isNearTie: boolean; accGap: number | null; heroStatGap: number | null } {
  const eligible = h.scales.filter(s => s.reliable);
  if (!eligible.length) return { best: null, runnerUp: null, isNearTie: false, accGap: null, heroStatGap: null };
  const best = coPrimaryBest(eligible, s => s.avgDelta, HERO_STAT_CHANNELS);
  const rest = eligible.filter(s => s !== best);
  const runnerUp = rest.length ? coPrimaryBest(rest, s => s.avgDelta, HERO_STAT_CHANNELS) : null;
  if (!best || !runnerUp) return { best, runnerUp: null, isNearTie: false, accGap: null, heroStatGap: null };
  const accGap = best.avgDelta != null && runnerUp.avgDelta != null ? Math.abs(best.avgDelta - runnerUp.avgDelta) : null;
  const bestHS = heroStatDeltaOf(best);
  const runnerHS = heroStatDeltaOf(runnerUp);
  const heroStatGap = bestHS != null && runnerHS != null ? Math.abs(bestHS - runnerHS) : null;
  // "Effectively tied" means NEITHER channel clears the same gap the rest of
  // this page already treats as meaningfully different — if even one channel
  // shows a real separation (like Soldier: 76's crit gap), it's a finding,
  // not a coin flip.
  const accClose = accGap == null || accGap < MEANINGFUL_DELTA_GAP;
  const hsClose = heroStatGap == null || heroStatGap < MEANINGFUL_DELTA_GAP;
  return { best, runnerUp, isNearTie: accClose && hsClose, accGap, heroStatGap };
}

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
// Below this R², a fit's slope/vertex is not trustworthy regardless of how
// many games or scales back it (2026-09-17, Sean's correction: "make the page
// enforce that rather than leaving it as a comment" — the comment being
// curveFitOf's own "scattered r2 is not a finding"). ONE shared constant for
// both the quadratic curve-fit gate below and the linear metric-trend gate in
// "Does Sens Move Anything?" — they used to be two independently-declared
// 0.25s (a local R2_REAL in "Does Sens Move Anything?" plus a separate
// WEAK_FIT_R2 here), the same failure shape as the duplicated rank logic in
// aim.ts/SensAnalysis.tsx. Same number, same meaning ("is this fit real or
// scatter"), so one name now, not two that happen to agree until someone
// changes only one.
export const R2_TRUST_BAR = 0.25;
// A quadratic curve fit has 3 coefficients (a, b, c). At exactly 3 tested
// points it has ZERO degrees of freedom — the parabola is forced through all
// three exactly, so R²=1.000 by construction for ANY three points, including
// pure noise. Found live (2026-09-17): Reaper (3 points) and Cassidy
// (3 points) both showed a perfect R²=1.0 and passed the R2_TRUST_BAR gate,
// while Sojourn's real 171-match, 11-scale fit (R²=0.173) was correctly
// suppressed — the gate was doing the OPPOSITE of its job on the two
// least-informative fits on the page. 5 gives 2 points of headroom past the
// 3 coefficients (df=2) before a fit is allowed to claim anything at all.
export const MIN_FIT_POINTS = 5;

// Whether a curve fit's R² is even meaningful, and — critically — WHY not
// when it isn't. Checked in this order because R² isn't meaningful at all
// without enough points to constrain it: a 3-point fit reporting R²=1.0 is
// not "a good fit that happens to be thin," it's a fit with no information
// content, and the page needs to say exactly that rather than a generic
// "not enough data."
export function curveFitReliability(fit: CurveFit): { trustworthy: boolean; reason: string | null } {
  if (fit.points < MIN_FIT_POINTS) {
    const df = fit.points - 3;
    return {
      trustworthy: false,
      reason: df <= 0
        ? `${fit.points} point${fit.points === 1 ? '' : 's'}, 3 coefficients — this fit is exact by construction (R²=1.00 no matter what the points actually show).`
        : `${fit.points} points against 3 coefficients (only ${df} degree${df === 1 ? '' : 's'} of freedom) — too little headroom for R² to mean anything yet.`,
    };
  }
  if (fit.r2 < R2_TRUST_BAR) {
    return {
      trustworthy: false,
      reason: `R²=${fit.r2.toFixed(2)} — the tested points don't follow a curve well enough to trust any estimated peak, no matter how many games are behind it.`,
    };
  }
  return { trustworthy: true, reason: null };
}

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

// A curve fit's tested points, at whatever grain it was fit on (roster or one
// hero) — only reliable scales, matching exactly what curveFitOf itself ran
// on, so a mini-chart never shows a dot the fit wasn't actually fit through.
interface MiniCurvePt { x: number; y: number; n: number }
function testedPointsFor(scales: ScaleRow[], valueOf: (s: ScaleRow) => number | null): MiniCurvePt[] {
  return bySpeed(scales.filter(s => s.reliable && valueOf(s) != null)).map(s => ({ x: s.sensAt1600, y: valueOf(s) as number, n: s.n }));
}
// Which channel a hero's OWN heroStatCurveFit actually ran on — mirrors the
// server's heroStatValueOf in aim.ts so the mini-chart's points match the fit
// exactly, not just "whichever hero-stat channel happens to be available."
const heroStatChannelValueOf = (channel: 'crit' | 'extra' | 'heroStat' | null): ((s: ScaleRow) => number | null) => {
  if (channel === 'crit') return s => s.avgCritDelta;
  if (channel === 'extra') return s => s.avgExtraDelta;
  if (channel === 'heroStat') return s => s.avgHeroStatDelta;
  return () => null;
};

// One small, self-contained curve-fit card (2026-09-17, Sean's correction:
// "make the fitted accuracy/sens curve a first-class object... for the roster
// fit and per hero" — both accuracy and hero-stat curves, all legible, not
// just the roster accuracy curve as one big chart with everything else
// reduced to a table row). A weak fit (see curveFitReliability) is drawn as a faint
// dashed line and says plainly that its peak isn't trustworthy, no matter how
// many games sit behind it — enforcing "scattered r2 is not a finding" in the
// UI instead of leaving it as a code comment.
function MiniCurveChart({ fit, points, label }: { fit: CurveFit | null; points: MiniCurvePt[]; label: string }) {
  if (!fit) {
    return (
      <div className="border border-ow-border rounded-lg p-2.5" data-inspect-id="sensAnalysis-mini-curve-chart">
        <div className="text-[11px] font-bold text-[var(--ink)] mb-1 truncate" title={label}>{label}</div>
        <p className="text-[10px] text-[var(--faint-2)]">Needs 3+ reliable scales.</p>
      </div>
    );
  }
  const rel = curveFitReliability(fit);
  const weak = !rel.trustworthy;
  const line = buildCurveLine(fit);
  const r2Class = weak ? 'text-red-600 dark:text-red-400' : fit.r2 >= 0.5 ? 'text-emerald-700 dark:text-emerald-500' : 'text-[var(--faint-2)]';
  return (
    <div className="border border-ow-border rounded-lg p-2.5" data-inspect-id="sensAnalysis-mini-curve-chart">
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <span className="text-[11px] font-bold text-[var(--ink)] truncate" title={label}>{label}</span>
        <span className={`text-[10px] font-bold shrink-0 ${r2Class}`}>R²={fit.r2.toFixed(2)}</span>
      </div>
      <ResponsiveContainer width="100%" height={100}>
        <ComposedChart margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
          <XAxis dataKey="x" type="number" domain={['dataMin', 'dataMax']} hide />
          <YAxis dataKey="y" type="number" hide />
          <ReferenceLine y={0} stroke="var(--faint-2)" strokeDasharray="3 3" />
          <Line data={line} dataKey="y" stroke={weak ? 'var(--faint-2)' : FEEL} strokeWidth={weak ? 1 : 2} strokeDasharray={weak ? '3 3' : undefined} dot={false} isAnimationActive={false} />
          <Scatter data={points} dataKey="y" fill="var(--ink)" />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="text-[10px] text-[var(--faint-2)] mt-1" title={rel.reason ?? undefined}>
        {fit.points} scales · {fit.totalN} games
        {weak && ` · ${rel.reason}`}
        {!weak && fit.hasInteriorPeak && fit.inRange && ` · peak ≈ ${fit.optimalSens?.toFixed(2)}`}
        {!weak && !fit.hasInteriorPeak && ' · still climbing, no interior peak'}
        {!weak && fit.hasInteriorPeak && !fit.inRange && ' · peak estimated outside tested range'}
      </div>
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
  // .reliable is the server's MIN_SCALE_N (5) guard — a below-threshold
  // scale is never dropped from the payload (see the By Scale table, where
  // it's shown greyed out), but it must not be eligible to win a pick here.
  const reliable = bySpeed(data.byScale.filter(r => r.reliable)); // ascending: slowest -> fastest

  if (reliable.length < 3) {
    return {
      verdict: 'continue',
      headline: 'Not enough tested scales yet to recommend a DPI.',
      points: [
        `Only ${reliable.length} scale${reliable.length === 1 ? '' : 's'} ${reliable.length === 1 ? 'has' : 'have'} ${RELIABLE_N}+ logged games — spread more reps across scales before narrowing in.`,
      ],
    };
  }

  // Co-primary pick (2026-09-17, Sean's call): accuracy and hero stats
  // weighted equally, not accuracy alone. See coPrimaryBest above.
  const best = coPrimaryBest(reliable, r => r.avgDelta, HERO_STAT_CHANNELS)!;
  const bestIdx = reliable.indexOf(best);
  const isSlowEdge = bestIdx === 0;
  const isFastEdge = bestIdx === reliable.length - 1;
  const dpi = Math.round(best.eDPI / best.sens);

  const points: string[] = [];

  // State the co-primary basis plainly rather than leaving it implicit in
  // the ranking math — whichever hero-stat channel has a reading at the
  // chosen scale gets its own line, with equal billing to the accuracy
  // figure in the headline below.
  const heroStatAtBest = best.avgCritDelta ?? best.avgExtraDelta ?? best.avgHeroStatDelta;
  if (heroStatAtBest != null) {
    points.push(
      `Hero-specific stats at that scale: ${signed(heroStatAtBest)}% vs. each hero's own average — weighed equally with accuracy in this pick, not just a supporting detail.`,
    );
  }

  if (isSlowEdge || isFastEdge) {
    points.push(
      `That's the ${isFastEdge ? 'fastest' : 'slowest'} scale you've tried — you don't know yet if it's actually the best, or just the best of what you've tried so far. Try a ${isFastEdge ? 'higher' : 'lower'} DPI stage in your next test set to see whether it keeps improving or starts getting worse.`,
    );
  }

  if (best.n < CONFIDENT_N) {
    points.push(`Only ${best.n} games on it so far — enough to take seriously, but still thin. A few more would help confirm it.`);
  }

  // These two caveats are specifically about the ACCURACY reading at nearby
  // scales, not a re-ranking — the pick above already weighed hero stats in;
  // this is a secondary confidence check on one of its two inputs, labeled
  // as such rather than implied to be the ranking criterion.
  const runnerUp = [...reliable].filter(r => r !== best).sort((a, b) => (b.avgDelta ?? -Infinity) - (a.avgDelta ?? -Infinity))[0];
  const gap = runnerUp ? (best.avgDelta ?? 0) - (runnerUp.avgDelta ?? 0) : Infinity;
  if (runnerUp && gap < 2) {
    points.push(
      `By accuracy alone, ${fmtScale(runnerUp)} is close behind at ${signed(runnerUp.avgDelta)}% (${runnerUp.n} games) — not clearly worse yet, worth keeping in the rotation.`,
    );
  }

  const clearlyWorse = reliable.filter(r => r !== best && r !== runnerUp && (r.avgDelta ?? 0) < -MEANINGFUL_DELTA_GAP && r.n >= CONFIDENT_N);
  if (clearlyWorse.length > 0) {
    points.push(
      `By accuracy alone, ${clearlyWorse.map(r => fmtScale(r)).join(', ')} ${clearlyWorse.length === 1 ? 'has' : 'have'} enough reps to call ${clearlyWorse.length === 1 ? 'it' : 'them'} clearly worse (${clearlyWorse.map(r => signed(r.avgDelta)).join(', ')}) — safe to drop from the rotation.`,
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
      headline: `No single best DPI yet — heroes are peaking at different scales. Overall best guess (accuracy and hero stats weighed equally) is ${fmtScale(best)} (${signed(best.avgDelta)}% accuracy, ${best.n} games), but treat it as provisional.`,
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
    headline: `Best guess right now (accuracy and hero stats weighed equally): ${fmtScale(best)} (tested at DPI ${dpi}) — ${signed(best.avgDelta)}% accuracy vs. your average, over ${best.n} games.`,
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
  // Below-threshold scales stay visible everywhere else on the page but
  // can't win a "peak" pick — same MIN_SCALE_N guard as buildRecommendation.
  const allOverall = bySpeed(data.byScale.filter(r => r.reliable));
  const threshold = sensGapThreshold(allOverall);
  const points: SpreadPoint[] = [];

  // Co-primary pick (2026-09-17): accuracy and hero stats weighted equally,
  // not accuracy alone — see coPrimaryBest above.
  if (allOverall.length > 0) {
    const best = coPrimaryBest(allOverall, r => r.avgDelta, HERO_STAT_CHANNELS)!;
    points.push({ label: 'Overall', kind: 'overall', sens: best.sensAt1600, raw: best.avgOverall, delta: best.avgDelta, n: best.n });
  }

  const hit = bySpeed(data.byArchetype.hitscan.filter(r => r.reliable));
  if (hit.length > 0) {
    const best = coPrimaryBest(hit, r => r.avgDelta, HERO_STAT_CHANNELS)!;
    points.push({ label: 'Hitscan', kind: 'hitscan', sens: best.sensAt1600, raw: best.avgOverall, delta: best.avgDelta, n: best.n });
  }

  const proj = bySpeed(data.byArchetype.projectile.filter(r => r.reliable));
  if (proj.length > 0) {
    const best = coPrimaryBest(proj, r => r.avgDelta, HERO_STAT_CHANNELS)!;
    points.push({ label: 'Projectile', kind: 'projectile', sens: best.sensAt1600, raw: best.avgOverall, delta: best.avgDelta, n: best.n });
  }

  for (const h of data.heroes) {
    // Heroes with no scale clearing MIN_SCALE_N have no trustworthy point on
    // the sens axis — plotting them anyway put an unsupported dot on the chart
    // at whatever scale happened to score highest.
    if (!h.bestScaleReliable || h.bestScaleEDPI == null) continue;
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

  const reliable = byScale.filter(r => r.reliable);
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
      `Your best performer by accuracy is ${fmtScale(bestByData)} (${signed(bestByData.avgDelta)}% vs. your average, over ${bestByData.n} games), which felt ${f1(bestByData.avgFeel)}/100 for speed — accuracy peaks at the scale that's right for you, not at whichever end of the speed range you tested.`,
    );
    if (fastestFeel.cm360 !== bestByData.cm360 && fastestFeel.avgFeel != null) {
      notes.push(
        `${fmtScale(fastestFeel)} felt fastest to you (${f1(fastestFeel.avgFeel)}/100), but it isn't your top performer (${signed(fastestFeel.avgDelta)}% vs. your average, ${fastestFeel.n} games) — feeling fast doesn't mean it's the right sens.`,
      );
    }
    // Win rate is shown, never ranked on — a match outcome is decided by four
    // other people, a map, and a comp, not by sens (Sean's call, 2026-09-17).
    // Reported here purely as a readout at the scale accuracy already picked,
    // not as a competing pick of its own.
    if (bestByData.winRate != null) {
      notes.push(
        `For reference, win rate at that same scale was ${f1(bestByData.winRate)}% (${bestByData.n} games) — not a factor in the pick above, just too noisy a signal on its own (five teammates, five opponents, map, and comp all outweigh sens).`,
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

  const projReliable = byArchetype.projectile.filter(r => r.reliable).length;
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

// Shape this page needs from GET /api/blind/state — the SAME endpoint
// SensLog/the testing page already reads to show stage-test progress. Reusing
// it here (2026-09-17, Sean's request) means no server change: it's already
// correct and already used for exactly this purpose, just not visible
// anywhere someone reading FINDINGS would think to look for it.
interface ActiveStudySet {
  set_id: number; hero: string | null; phase: string | null;
  cur_stage: number; n_stages: number; games_on_stage: number; batch_size: number;
  totalGames: number; completed: boolean; curveEnabled: boolean;
}

export default function SensAnalysis() {
  const { data, loading } = useApi<Analysis>('/api/aim/analysis');
  const { data: blindState } = useApi<{ actives: ActiveStudySet[] }>('/api/blind/state');
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

  // Feel vs. Data quadrant: each scale plotted at (how far its felt speed sat
  // from neutral, accuracy delta).
  //
  // The X axis is FOLDED to |avgFeel - 50| rather than plotting avgFeel raw.
  // A scale rated 25 and a scale rated 75 are equally far from feeling neutral,
  // one slow and one fast, but the raw axis put them at opposite extremes. That
  // invited reading left-to-right as a preference ranking ("over-rated" vs
  // "under-rated") when the only thing the axis can actually support is the
  // SIZE of the mismatch between how a scale felt and how it scored.
  //
  // The crosshair sits at Sean's own n-weighted mean of the folded value, not
  // at 0. At 0 every point would land on one side and the four quadrants would
  // collapse into two. Centering on his own mean also matches every other chart
  // on this page, which compares him against himself rather than an absolute.
  const FEEL_NEUTRAL = 50;
  const feelPts = byScaleSpeed
    .filter(r => r.avgFeel != null && r.avgDelta != null)
    .map(r => ({ ...r, feelOff: Math.abs((r.avgFeel as number) - FEEL_NEUTRAL) }));
  const feelOffTotalN = feelPts.reduce((s, r) => s + r.n, 0);
  const meanFeelOff = feelOffTotalN
    ? feelPts.reduce((s, r) => s + r.feelOff * r.n, 0) / feelOffTotalN
    : 0;
  const meanDelta = wMean(byScaleSpeed, 'avgDelta');
  const feelXDomain = centeredDomain(feelPts.map(r => r.feelOff), meanFeelOff);
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
  // Filtered to r.reliable (2026-09-17) — the server's fit only ever ran on
  // reliableRosterScales, so a thin scale plotted here would show a dot the
  // curve wasn't actually fit through.
  const curveLine = data.overallCurveFit ? buildCurveLine(data.overallCurveFit) : null;
  const curveTestedPts = bySpeed(byScale.filter(r => r.reliable && r.avgDelta != null)).map(r => ({ x: r.sensAt1600, y: r.avgDelta as number, n: r.n }));

  // Curve confound (2026-09-17): every DISTINCT curve-on variant found in the
  // study's own logged data. More than one means "curve on" is not a single
  // treatment — see aim.ts's summarizeCurveVariants and Sean's 2026-09-17
  // finding (0.25/14/1.15 x134, 1.0/12/null x58, 0.25/14/1.5 x11).
  const curveOnVariants = data.curveBreakdown.filter(v => v.curveEnabled);
  const curveOffVariant = data.curveBreakdown.find(v => !v.curveEnabled) ?? null;
  const curveIsConfounded = curveOnVariants.length > 1;

  // Study progress (2026-09-17) — the same /api/blind/state feed the testing
  // page already shows, just not previously visible anywhere on the page
  // someone reads findings from.
  const activeStudySets = blindState?.actives ?? [];

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

      {/* Phase 10 (and any other active stage-test) progress — previously
          only visible on the Testing page, never here where findings are
          actually read (2026-09-17, Sean's request). */}
      {activeStudySets.length > 0 && (
        <Section
          title="Study Progress"
          hint="Active stage-test sets right now — same feed the Testing page's HUD reads. A finding above drawn from a stage that's still filling in is provisional by definition."
          dataInspectId="sensAnalysis-study-progress"
        >
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
            {activeStudySets.map(s => (
              <div key={s.set_id} className="rounded-lg bg-ow-darker border border-ow-border p-3" data-inspect-id="sensAnalysis-study-progress-set">
                <div className="text-xs hero-name text-[var(--ink)] font-bold">{s.hero ?? 'Roster set'}</div>
                <div className="text-[11px] text-[var(--faint)] mt-0.5">
                  Stage <b className="text-[var(--ink)]">{s.cur_stage}</b> of <b className="text-[var(--ink)]">{s.n_stages}</b>
                  {' · '}{s.games_on_stage}/{s.batch_size} games on stage
                </div>
                <div className="text-[11px] text-[var(--faint-2)] mt-1">
                  {s.totalGames} games total{s.curveEnabled ? ' · curve on' : ''}{s.completed ? ' · complete' : ''}
                </div>
              </div>
            ))}
          </div>
        </Section>
      )}

      {/* DPI recommendation + continue-vs-narrow call */}
      <Section
        title="Recommendation"
        hint="A DPI suggestion plus a call on whether to keep exploring or start converging — recomputed from the same scale data below."
        dataInspectId="sensAnalysis-recommendation-card"
      >
        <div className="flex items-start gap-3 flex-wrap">
          <span data-inspect-id="sensAnalysis-recommendation-verdict-badge" className={`inline-flex items-center rounded-lg px-2 py-0.5 text-[11px] font-semibold ${recommendation.verdict === 'narrow' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-ow-accent/15 text-ow-accent'}`}>
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
          hint={`Each dot is a tested scale. Left/right is how far its felt speed sat from neutral — a scale you rated 25 and one you rated 75 both read as equally far off, one slow and one fast. Up/down is how well you actually aimed on it. The crosshair marks your own averages for both. Bottom-right = the scales that felt furthest from neutral are also the ones you aim worst on. Top-right = a scale feels strongly one way and you aim better on it anyway, so the feeling is worth keeping.`}
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
                  <XAxis type="number" dataKey="feelOff" name="Distance from neutral feel" domain={feelXDomain} tick={false} tickLine={false} axisLine={false} />
                  <YAxis type="number" dataKey="avgDelta" name="Accuracy vs. avg" domain={feelYDomain} tick={false} tickLine={false} axisLine={false} width={4} />
                  <Tooltip content={<QuadrantTooltip />} cursor={{ strokeDasharray: '3 3' }} />
                  <ReferenceLine x={meanFeelOff} stroke="var(--faint-2)" strokeDasharray="4 4" />
                  <ReferenceLine y={meanDelta} stroke="var(--faint-2)" strokeDasharray="4 4" />
                  <Scatter dataKey="avgDelta" fill={FEEL}>
                    <LabelList dataKey="sensAt1600" position="top" formatter={(v: number) => v.toFixed(2)} style={{ fontSize: 10, fill: 'var(--faint)' }} />
                  </Scatter>
                </ScatterChart>
              </ResponsiveContainer>
              <div className="flex justify-between text-[10px] text-[var(--faint-2)] px-0.5">
                <span>Felt close to neutral</span><span>Felt far from neutral</span>
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
            <span data-inspect-id="sensAnalysis-peak-sens-verdict-badge" className={`inline-flex items-center rounded-lg px-2 py-0.5 text-[11px] font-semibold ${spread.verdict === 'scattered' ? 'bg-amber-500/15 text-amber-500' : spread.verdict === 'grouped' ? 'bg-emerald-500/15 text-emerald-500' : 'bg-ow-accent/15 text-ow-accent'}`}>
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
      <Section title={`By Scale (sens @${MOUSE_DPI} DPI)`} hint={`Every scale you've tested, shown as in-game sens at ${MOUSE_DPI} DPI, with its eDPI and averages. Win % is shown for reference only — it is NOT a factor in any pick or recommendation on this page, because a match outcome is decided by four other people, a map, and a comp, not by sens. Accuracy is what sens actually moves, so accuracy (and each hero's own signature/crit stat) drives everything below. "vs. Avg" is accuracy compared to how you usually do. "Sens" is the raw in-game value used during testing (it stayed fixed while DPI changed between test stages).`} dataInspectId="sensAnalysis-by-scale-table">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] text-[var(--muted)] uppercase tracking-wider text-left">
                <th className="py-1.5 pr-3">{`Sens @${MOUSE_DPI}`}</th><th className="py-1.5 pr-3">eDPI</th><th className="py-1.5 pr-3">Sens</th><th className="py-1.5 pr-3">n</th>
                <th className="py-1.5 pr-3" title="Reference only — not a factor in any pick or recommendation on this page">Win % <span className="text-[9px] font-normal text-[var(--faint-2)]">(info only)</span></th><th className="py-1.5 pr-3">Overall</th><th className="py-1.5 pr-3">Crit</th><th className="py-1.5 pr-3">Felt speed</th><th className="py-1.5">vs. Avg</th>
              </tr>
            </thead>
            <tbody className="font-bold">
              {byScaleSpeed.map(r => (
                <tr
                  key={r.cm360}
                  className={`border-t border-ow-border ${r.reliable ? 'text-[var(--ink-2)]' : 'text-[var(--faint-2)] opacity-60'}`}
                  title={r.reliable ? undefined : `Below ${RELIABLE_N} games — shown for visibility, excluded from every pick, curve fit, and finding on this page`}
                >
                  <td className="py-1.5 pr-3 text-[var(--ink)]">{r.sensAt1600.toFixed(2)}</td>
                  <td className="py-1.5 pr-3">{r.eDPI}</td>
                  <td className="py-1.5 pr-3">{r.sens}</td>
                  <td className="py-1.5 pr-3">
                    {r.n}
                    {!r.reliable && (
                      <span className="text-[10px] font-normal ml-1">thin — not used in picks/fits</span>
                    )}
                    {r.absorbedN > 0 && (
                      <span className="text-[10px] font-normal text-[var(--faint-2)] ml-1">({r.absorbedN} absorbed)</span>
                    )}
                    {r.reliable && r.dateSpanDays < 3 && (
                      <span
                        className="text-[10px] font-normal text-amber-600 dark:text-amber-400 ml-1"
                        title={`Tested across only ${r.distinctDates} distinct date${r.distinctDates === 1 ? '' : 's'} over ${r.dateSpanDays} day${r.dateSpanDays === 1 ? '' : 's'} — may reflect that session more than a stable read`}
                      >
                        ⚠
                      </span>
                    )}
                    {r.curveVariants.length > 1 && (
                      <span
                        className="text-[10px] font-normal text-amber-600 dark:text-amber-400 ml-1"
                        title={`Mixes ${r.curveVariants.length} different curve settings: ${r.curveVariants.map(v => `${v.curveEnabled ? `on ${v.smooth}/${v.input}/${v.output}` : 'off'} (n=${v.n})`).join(', ')} — see Curve Confound above`}
                      >
                        ⎘
                      </span>
                    )}
                  </td>
                  <td className="py-1.5 pr-3 font-normal text-[var(--faint-2)]">{f1(r.winRate)}%</td>
                  <td className="py-1.5 pr-3">{f1(r.avgOverall)}%</td>
                  <td className="py-1.5 pr-3">{f1(r.avgCrit)}%</td>
                  <td className="py-1.5 pr-3">{f1(r.avgFeel)}/100</td>
                  <td className={`py-1.5 ${r.reliable ? deltaColor(r.avgDelta) : ''}`}>{signed(r.avgDelta)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Section>

      {/* By hero */}
      <Section title="By Hero" hint={`Games logged per hero — a small number here isn't trustworthy yet. Best Sens is the sens (@${MOUSE_DPI} DPI) where that hero's own accuracy is highest, with the game count in parens — treat it as unreliable below ${RELIABLE_N} games. Win % is shown for reference only — it plays no part in picking a hero's best sens. "vs. Avg" columns compare that scale's accuracy to how the hero usually does. Signature Stat is a DIFFERENT stat per hero (Ana's is sleep dart accuracy, Sojourn's charged shot) — each cell names its own; see Ability Stats by Sens below for the per-sens breakdown. "✓" next to Best Sens means it clearly beat the runner-up (gap ≥ ${MEANINGFUL_DELTA_GAP} pts on both accuracy and hero stat); "≈ tie" means the rank math had to break a near-tie — treat the runner-up as a live option too, not a loser.`} dataInspectId="sensAnalysis-by-hero-table">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] text-[var(--muted)] uppercase tracking-wider text-left">
                <th className="py-1.5 pr-3">Hero</th><th className="py-1.5 pr-3">Type</th><th className="py-1.5 pr-3">n</th>
                <th className="py-1.5 pr-3" title="Reference only — plays no part in picking Best Sens">Win % <span className="text-[9px] font-normal text-[var(--faint-2)]">(info only)</span></th><th className="py-1.5 pr-3">Overall</th><th className="py-1.5 pr-3">Signature Stat</th><th className="py-1.5 pr-3">Best Sens</th>
                <th className="py-1.5 pr-3">Overall vs. Avg</th><th className="py-1.5">Signature vs. Avg</th>
              </tr>
            </thead>
            <tbody>
              {heroes.map(h => {
                const tie = heroTieInfo(h);
                return (
                <tr key={h.hero} className="border-t border-ow-border text-[var(--ink-2)]">
                  <td className="py-1.5 pr-3 text-xs hero-name text-[var(--ink)]">{withHeroCount(h.hero, heroCounts)}</td>
                  <td className="py-1.5 pr-3 capitalize text-[var(--faint)]">{h.archetype}</td>
                  <td className="py-1.5 pr-3 font-bold">{h.n}</td>
                  <td className="py-1.5 pr-3 font-normal text-[var(--faint-2)]">{f1(h.winRate)}%</td>
                  <td className="py-1.5 pr-3 font-bold">{f1(h.avgOverall)}%</td>
                  {/* The crit_acc column is a different stat per hero — Ana's
                      is sleep dart, Sojourn's charged shot — so the cell names
                      itself rather than inheriting a header that is wrong for
                      most rows. Heroes with no crit reading at all (Juno) say
                      so instead of printing a hyphen that looks like missing
                      data. */}
                  <td className="py-1.5 pr-3 font-bold">
                    {hasCrit(h.hero) ? (
                      <>
                        {f1(h.avgCrit)}%
                        <span className="ml-1.5 text-[10px] font-normal text-[var(--faint-2)]">{critSlotShort(h.hero)}</span>
                      </>
                    ) : (
                      <span className="text-[var(--faint-2)] text-[10px] font-normal">no crit stat</span>
                    )}
                  </td>
                  <td className={!h.bestScaleReliable ? 'py-1.5 pr-3 text-[var(--faint)] font-bold' : 'py-1.5 pr-3 font-bold'}>
                    {h.bestScaleEDPI != null
                      ? <>{(h.bestScaleEDPI / MOUSE_DPI).toFixed(2)} <span className="text-[10px] text-[var(--faint-2)]">(n={h.bestScaleN})</span></>
                      : <span className="text-[var(--faint-2)]">— <span className="text-[10px]">(no scale with {RELIABLE_N}+ games)</span></span>}
                    {tie.runnerUp && (tie.isNearTie ? (
                      <span
                        className="ml-1.5 inline-flex items-center rounded px-1 py-0 text-[9px] font-semibold bg-amber-500/15 text-amber-600 dark:text-amber-400"
                        title={`Effectively tied with ${(tie.runnerUp.eDPI / MOUSE_DPI).toFixed(2)} sens (accuracy gap ${tie.accGap != null ? tie.accGap.toFixed(2) : '—'} pts${tie.heroStatGap != null ? `, hero-stat gap ${tie.heroStatGap.toFixed(2)} pts` : ''}) — the rank math had to break a near-tie, not identify a clear winner.`}
                      >
                        ≈ tie
                      </span>
                    ) : (
                      <span
                        className="ml-1.5 text-[9px] text-emerald-600 dark:text-emerald-500"
                        title={`Clearly ahead of runner-up ${(tie.runnerUp.eDPI / MOUSE_DPI).toFixed(2)} sens (accuracy gap ${tie.accGap != null ? tie.accGap.toFixed(2) : '—'} pts${tie.heroStatGap != null ? `, hero-stat gap ${tie.heroStatGap.toFixed(2)} pts` : ''})`}
                      >
                        ✓
                      </span>
                    ))}
                  </td>
                  <td className={`py-1.5 pr-3 font-bold ${deltaColor(h.bestScaleOverallDelta)}`}>{signed(h.bestScaleOverallDelta)}</td>
                  <td className={`py-1.5 font-bold ${deltaColor(h.bestScaleCritDelta)}`}>{hasCrit(h.hero) ? signed(h.bestScaleCritDelta) : <span className="text-[var(--faint-2)]">—</span>}</td>
                </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      {/* Ability-level stats per tested sens — the question the By Hero table
          above can't answer, because it collapses each hero to one best-scale
          summary. Three channels feed it, and they are NOT interchangeable:
            - the crit_acc slot, whose meaning is per hero (Ana = sleep dart),
            - extra_acc, an optional 4th accuracy reading (4 heroes),
            - hero_stat_value, the signature stat, whose label is stored with
              the data and can be a COUNT rather than a percentage.
          All three were collected from the start and read by nothing until
          2026-09-15 — extra_acc and hero_stat_value weren't even selected by
          computeAnalysis. */}
      {(() => {
        const CHANNEL_MIN_N = 3; // below this a cell is shown but greyed
        const abilityHeroes = heroes
          .map(h => {
            const critName = hasCrit(h.hero) ? critSlotShort(h.hero) : null;
            const extraName = extraSlotShort(h.hero);
            const hasCritData = critName != null && h.scales.some(s => s.avgCrit != null);
            const hasExtraData = extraName != null && h.scales.some(s => s.nExtra > 0);
            const hasStatData = h.nHeroStat > 0;
            return { h, critName, extraName, hasCritData, hasExtraData, hasStatData };
          })
          .filter(r => r.hasCritData || r.hasExtraData || r.hasStatData);

        if (abilityHeroes.length === 0) return null;

        // A signature stat that is a raw count (Shion's "Execution kills")
        // rather than a percentage can't be compared across match lengths the
        // way an accuracy can. Flagged rather than silently normalized.
        const anyCountStat = abilityHeroes.some(r =>
          r.hasStatData && r.h.heroStatLabel != null && !/%/.test(r.h.heroStatLabel));

        return (
          <Section
            title="Ability Stats by Sens"
            hint={`For each hero, how its own ability-level stats came out at every sens actually tested (@${MOUSE_DPI} DPI). Each cell shows the average with that stat's own game count in parens — a stat is often logged for fewer games than the sens bucket itself, so read the small n, not the bucket's. Cells below ${CHANNEL_MIN_N} readings are greyed out.${anyCountStat ? ' Signature stats that are counts rather than percentages are per match, so a longer match inflates them — compare those cautiously.' : ''}`}
            dataInspectId="sensAnalysis-ability-stats-by-sens"
          >
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              {abilityHeroes.map(({ h, critName, extraName, hasCritData, hasExtraData, hasStatData }) => {
                const cell = (value: number | null, n: number, pct: boolean) => {
                  if (value == null || n === 0) return <span className="text-[var(--faint-2)]">—</span>;
                  return (
                    <span className={n < CHANNEL_MIN_N ? 'text-[var(--faint-2)]' : 'font-bold'}>
                      {value.toFixed(1)}{pct ? '%' : ''}
                      <span className="ml-1 text-[10px] font-normal text-[var(--faint-2)]">({n})</span>
                    </span>
                  );
                };
                return (
                  <div key={h.hero} className="border border-ow-border rounded-lg p-3" data-inspect-id="sensAnalysis-ability-stat-hero-card">
                    <div className="flex items-baseline justify-between mb-2">
                      <span className="text-xs hero-name text-[var(--ink)]">{withHeroCount(h.hero, heroCounts)}</span>
                      <span className="text-[10px] text-[var(--faint-2)]">{h.n} games</span>
                    </div>
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-[10px] text-[var(--muted)] uppercase tracking-wider text-left">
                          <th className="py-1 pr-2">Sens</th>
                          <th className="py-1 pr-2">Overall</th>
                          {hasCritData && <th className="py-1 pr-2">{critName}</th>}
                          {hasExtraData && <th className="py-1 pr-2">{extraName}</th>}
                          {hasStatData && <th className="py-1">{h.heroStatLabel ?? 'Signature'}</th>}
                        </tr>
                      </thead>
                      <tbody>
                        {h.scales.map(sc => (
                          <tr key={sc.cm360} className="border-t border-ow-border text-[var(--ink-2)]">
                            <td className="py-1 pr-2 font-bold text-[var(--ink)]">
                              {(sc.eDPI / MOUSE_DPI).toFixed(2)}
                              <span className="ml-1 text-[10px] font-normal text-[var(--faint-2)]">({sc.n})</span>
                            </td>
                            <td className={`py-1 pr-2 ${sc.n < CHANNEL_MIN_N ? 'text-[var(--faint-2)]' : 'font-bold'}`}>
                              {sc.avgOverall != null ? `${sc.avgOverall.toFixed(1)}%` : '—'}
                            </td>
                            {hasCritData && <td className="py-1 pr-2">{cell(sc.avgCrit, sc.n, true)}</td>}
                            {hasExtraData && <td className="py-1 pr-2">{cell(sc.avgExtra, sc.nExtra, true)}</td>}
                            {hasStatData && (
                              <td className="py-1">
                                {cell(sc.avgHeroStat, sc.nHeroStat, /%/.test(h.heroStatLabel ?? ''))}
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                );
              })}
            </div>
          </Section>
        );
      })()}

      {/* Does sens move anything? — the page's one proactive section. Every
          other view reports numbers and leaves the reader to spot a pattern,
          which is exactly how the retired map/hour "key patterns" happened:
          eyeball eight buckets, the highest always looks like something. This
          asks the question numerically, for every metric rather than accuracy
          alone, and says plainly when the answer is "nothing here". */}
      {(() => {
        const trends: MetricTrend[] = data.metricTrends ?? [];
        if (!trends.length) return null;

        // Bars a trend must clear to be called a finding rather than scatter.
        // R2_TRUST_BAR is deliberately modest — this is noisy human
        // performance data, not a physics experiment — but it is a bar, and
        // the section says so out loud rather than presenting every slope as
        // a result. Shared with the quadratic curve-fit gate below (one
        // constant, not two 0.25s declared independently — see its own
        // comment for why that used to be a bug waiting to happen).
        const MIN_N = 30;
        const MIN_SCALES = 4;

        const fmtVal = (v: number, unit: string) =>
          `${v > 0 ? '+' : ''}${Math.abs(v) >= 100 ? Math.round(v).toLocaleString() : v.toFixed(2)}${unit}`;

        // A finding is good or bad depending on the metric — more deaths is
        // not an improvement. lowerIsBetter comes from the server so this
        // can't drift from the definition the numbers were computed under.
        const toneOf = (t: MetricTrend) => {
          if (t.spanDelta == null || t.r2 == null || t.r2 < R2_TRUST_BAR) return '';
          const good = t.lowerIsBetter ? t.spanDelta < 0 : t.spanDelta > 0;
          return good ? 'text-emerald-700 dark:text-emerald-500' : 'text-red-700 dark:text-red-400';
        };

        const heroFindings = heroes.flatMap(h =>
          (h.metricTrends ?? [])
            .filter(t => t.r2 != null && t.r2 >= R2_TRUST_BAR && t.totalN >= MIN_N && t.scales >= MIN_SCALES)
            .map(t => ({ hero: h.hero, t })),
        ).sort((a, b) => (b.t.r2 ?? 0) - (a.t.r2 ?? 0));

        const rosterFindings = trends.filter(t => t.r2 != null && t.r2 >= R2_TRUST_BAR && t.totalN >= MIN_N);

        return (
          <Section
            title="Does Sens Move Anything?"
            hint={`Every metric fitted against sens with a weighted straight line. "Across range" is how much the line predicts the metric changes from your lowest tested sens to your highest; R² is how closely the points actually follow that line, 0 to 1. A large change with a low R² is scatter, not a result — both are shown together for that reason. Roster-wide rows are normalized against each hero's own baseline first, otherwise the comparison would mostly measure which heroes were tested where. Nothing below R²=${R2_TRUST_BAR} is treated as a finding.`}
            dataInspectId="sensAnalysis-metric-trends"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] text-[var(--muted)] uppercase tracking-wider text-left">
                    <th className="py-1.5 pr-3">Metric</th>
                    <th className="py-1.5 pr-3">Games</th>
                    <th className="py-1.5 pr-3">Scales</th>
                    <th className="py-1.5 pr-3">Across range</th>
                    <th className="py-1.5">R²</th>
                  </tr>
                </thead>
                <tbody>
                  {trends.map(t => (
                    <tr key={t.key} className="border-t border-ow-border text-[var(--ink-2)]">
                      <td className="py-1.5 pr-3 text-[var(--ink)]">
                        {t.label}
                        {t.lowerIsBetter && <span className="ml-1.5 text-[10px] text-[var(--faint-2)]">(lower is better)</span>}
                      </td>
                      <td className="py-1.5 pr-3 font-bold">{t.totalN}</td>
                      <td className="py-1.5 pr-3">{t.scales}</td>
                      <td className={`py-1.5 pr-3 font-bold ${toneOf(t)}`}>
                        {t.spanDelta != null ? fmtVal(t.spanDelta, t.unit) : '—'}
                      </td>
                      <td className={`py-1.5 font-bold ${t.r2 != null && t.r2 >= R2_TRUST_BAR ? '' : 'text-[var(--faint-2)]'}`}>
                        {t.r2 != null ? t.r2.toFixed(3) : '—'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="mt-4 pt-3 border-t border-ow-border/60">
              {rosterFindings.length === 0 && (
                <p className="text-xs text-[var(--faint)] mb-2">
                  <span className="font-bold text-[var(--ink)]">Roster-wide: nothing clears the bar.</span>{' '}
                  Across every hero pooled, no metric tracks sensitivity strongly enough to act on. That is a
                  real answer, not missing data — it means whatever sens is doing, it is doing per hero rather
                  than to you overall.
                </p>
              )}
              {heroFindings.length === 0 ? (
                <p className="text-xs text-[var(--faint)]">
                  No individual hero clears R²={R2_TRUST_BAR} with at least {MIN_N} games over {MIN_SCALES}+ tested
                  scales either. Keep logging — the bar exists so a thin run of luck can't read as a discovery.
                </p>
              ) : (
                <>
                  <p className="text-xs text-[var(--faint)] mb-2">
                    <span className="font-bold text-[var(--ink)]">Per-hero findings</span> — cleared R²={R2_TRUST_BAR},
                    {' '}{MIN_N}+ games, {MIN_SCALES}+ tested scales. Still worth reading as leads, not verdicts.
                  </p>
                  <ul className="space-y-1">
                    {heroFindings.map(({ hero, t }) => (
                      <li key={`${hero}-${t.key}`} className="text-xs text-[var(--ink-2)]" data-inspect-id="sensAnalysis-metric-trend-finding">
                        <span className="hero-name text-[var(--ink)]">{hero}</span>
                        {' — '}{t.label}{' '}
                        <span className={`font-bold ${toneOf(t)}`}>
                          {t.spanDelta != null ? fmtVal(t.spanDelta, t.unit) : '—'}
                        </span>
                        {' '}from {t.sensMin?.toFixed(2)} to {t.sensMax?.toFixed(2)} sens
                        <span className="text-[var(--faint-2)]"> (R²={t.r2?.toFixed(2)}, n={t.totalN})</span>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          </Section>
        );
      })()}

      {/* Curve fit — a quadratic (a*x^2 + b*x + c) fit across each hero's
          tested scales (avgDelta vs. sens, weighted by n), naming a
          continuous best-guess optimal sens rather than just whichever
          tested point happened to score best. */}
      {(() => {
        const rows: { label: string; fit: CurveFit | null; hero: HeroRow | null }[] = [
          { label: 'Overall', fit: data.overallCurveFit, hero: null },
          ...heroes.map(h => ({ label: h.hero, fit: h.curveFit, hero: h })),
        ];
        const withFit = rows.filter(r => r.fit != null);
        // Co-primary companion rows (2026-09-17): the SAME kind of curve,
        // fit against hero-specific stats instead of accuracy — equal
        // standing, not a footnote. Each hero's own richest channel
        // (heroStatCurveChannel) names itself rather than being called
        // "Crit" for a hero whose curve is actually a raw kill count.
        const heroStatChannelLabel = (h: HeroRow): string => {
          if (h.heroStatCurveChannel === 'crit') return hasCrit(h.hero) ? critSlotShort(h.hero) : 'crit stat';
          if (h.heroStatCurveChannel === 'extra') return extraSlotShort(h.hero) ?? 'extra accuracy';
          if (h.heroStatCurveChannel === 'heroStat') return h.heroStatLabel ?? 'signature stat';
          return 'hero stat';
        };
        const heroStatRows: { label: string; fit: CurveFit | null; hero: HeroRow | null }[] = [
          { label: 'Overall (crit, pooled)', fit: data.heroStatCurveFit, hero: null },
          ...heroes.map(h => ({ label: `${h.hero} (${heroStatChannelLabel(h)})`, fit: h.heroStatCurveFit, hero: h })),
        ];
        const heroStatWithFit = heroStatRows.filter(r => r.fit != null);
        // 2026-09-17, Sean's correction: "a quadratic through scattered
        // points has a vertex, and that vertex is meaningless when r² is
        // low... make the page enforce that rather than leaving it as a
        // comment." The weak-fit branch fires BEFORE hasInteriorPeak/inRange
        // are even consulted, and the table cells below gate the numeric
        // best-sens/result on it too — a weak fit shows no number at all,
        // not a confident one wrapped in a caveat.
        const fitNote = (fit: CurveFit, subject: string): { text: string; tone: 'good' | 'warn' | 'bad' | 'neutral' } => {
          const rel = curveFitReliability(fit);
          if (!rel.trustworthy) {
            return { text: `${rel.reason} Treat this as no finding, not a rough guess.`, tone: 'bad' };
          }
          if (!fit.hasInteriorPeak) {
            return { text: `${subject} is still climbing toward one edge of what you’ve tested, not leveling off in the middle — try testing further past that edge.`, tone: 'warn' };
          }
          if (!fit.inRange) {
            return { text: `The estimated best sens falls outside what you’ve actually tested (${fit.testedSensMin.toFixed(2)}–${fit.testedSensMax.toFixed(2)}) — it’s a guess based on the trend, not something you’ve tried. Treat it as a direction to test toward, not a final answer.`, tone: 'warn' };
          }
          if (fit.r2 >= 0.5 && fit.totalN >= CONFIDENT_N && fit.points >= CONFIDENT_SCALES) {
            return { text: `Fits your results well, and you’ve logged enough games and scales behind it — a reasonably solid guess.`, tone: 'good' };
          }
          return { text: `R²=${fit.r2.toFixed(2)} — a real but modest fit. Only ${fit.totalN} games across ${fit.points} scales so far — worth taking seriously, still thin. Keep logging.`, tone: 'neutral' };
        };
        return (
          <Section
            title="Estimated Sweet Spot"
            hint={`Draws a smooth curve through each category's tested scales to guess where the peak actually is, instead of just picking whichever tested scale happened to score best. Two curves, equal standing: accuracy, and each hero's own crit/extra/signature stat. A quadratic ALWAYS has a vertex — at fewer than ${MIN_FIT_POINTS} tested scales it doesn't have enough degrees of freedom for R² to mean anything (3 scales = 3 coefficients = an exact, meaningless R²=1.00), and below R²=${R2_TRUST_BAR} the points just don't follow that shape. Either way, the row (or mini-chart) shows no estimated sens or result, on purpose, instead of a confident-looking number built on scatter or an exact fit with no information in it.`}
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
            <h3 className="text-xs font-bold text-[var(--ink)] mb-2">Every Category's Curve — Accuracy</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-6" data-inspect-id="sensAnalysis-mini-curve-grid-accuracy">
              {rows.map(r => (
                <MiniCurveChart
                  key={r.label}
                  fit={r.fit}
                  points={r.hero ? testedPointsFor(r.hero.scales, s => s.avgDelta) : curveTestedPts}
                  label={r.label === 'Overall' ? r.label : withHeroCount(r.label, heroCounts)}
                />
              ))}
            </div>

            <h3 className="text-xs font-bold text-[var(--ink)] mb-2">By Accuracy</h3>
            {withFit.length ? (
              <div className="overflow-x-auto mb-6">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] text-[var(--muted)] uppercase tracking-wider text-left">
                      <th className="py-1.5 pr-3">Category</th><th className="py-1.5 pr-3">Scales Tested</th><th className="py-1.5 pr-3">Games Logged</th>
                      <th className="py-1.5 pr-3">R²</th><th className="py-1.5 pr-3">Estimated Best Sens</th><th className="py-1.5 pr-3">Estimated Result</th><th className="py-1.5">Read</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map(r => {
                      if (!r.fit) {
                        return (
                          <tr key={r.label} className="border-t border-ow-border text-[var(--faint)]">
                            <td className="py-1.5 pr-3 hero-name text-[var(--ink)]">{r.label === 'Overall' ? r.label : withHeroCount(r.label, heroCounts)}</td>
                            <td className="py-1.5 pr-3" colSpan={5}>Needs at least 3 reliable tested scales to draw a curve.</td>
                          </tr>
                        );
                      }
                      const note = fitNote(r.fit, 'Accuracy');
                      const weak = !curveFitReliability(r.fit).trustworthy;
                      const toneClass = note.tone === 'good' ? 'text-emerald-700 dark:text-emerald-500' : note.tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : note.tone === 'bad' ? 'text-red-600 dark:text-red-400' : 'text-[var(--faint)]';
                      return (
                        <tr key={r.label} className="border-t border-ow-border text-[var(--ink-2)] align-top">
                          <td className="py-1.5 pr-3 hero-name text-[var(--ink)] font-bold whitespace-nowrap">{r.label === 'Overall' ? r.label : withHeroCount(r.label, heroCounts)}</td>
                          <td className="py-1.5 pr-3 font-bold">{r.fit.points}</td>
                          <td className="py-1.5 pr-3 font-bold">{r.fit.totalN}</td>
                          <td className={`py-1.5 pr-3 font-bold ${weak ? 'text-red-600 dark:text-red-400' : r.fit.r2 >= 0.5 ? 'text-emerald-700 dark:text-emerald-500' : ''}`}>{r.fit.r2.toFixed(2)}</td>
                          <td className="py-1.5 pr-3 font-bold text-[var(--ink)] whitespace-nowrap">
                            {!weak && r.fit.hasInteriorPeak ? r.fit.optimalSens?.toFixed(2) : '—'}
                          </td>
                          <td className={`py-1.5 pr-3 font-bold ${!weak ? deltaColor(r.fit.predictedDelta) : ''}`}>{!weak && r.fit.hasInteriorPeak ? signed(r.fit.predictedDelta) : '—'}</td>
                          <td className={`py-1.5 text-xs ${toneClass}`}>{note.text}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-[var(--faint)] mb-6">No category has 3+ reliable tested scales yet — keep spreading games across scales.</p>
            )}

            {/* Co-primary companion (2026-09-17): same kind of curve, same
                table shape, same section — hero-specific stats get equal
                standing, not a scroll below. Units vary per hero (a
                percentage for crit/extra, sometimes a raw per-match count
                for a signature stat) — read each row against its own name,
                not against the accuracy table above it. */}
            <h3 className="text-xs font-bold text-[var(--ink)] mb-2">Every Category's Curve — Hero-Specific Stat</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3 mb-6" data-inspect-id="sensAnalysis-mini-curve-grid-hero-stat">
              {heroStatRows.map(r => (
                <MiniCurveChart
                  key={r.label}
                  fit={r.fit}
                  points={r.hero ? testedPointsFor(r.hero.scales, heroStatChannelValueOf(r.hero.heroStatCurveChannel)) : testedPointsFor(byScale, s => s.avgCritDelta)}
                  label={r.label}
                />
              ))}
            </div>

            <h3 className="text-xs font-bold text-[var(--ink)] mb-2">By Hero-Specific Stat</h3>
            {heroStatWithFit.length ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-[11px] text-[var(--muted)] uppercase tracking-wider text-left">
                      <th className="py-1.5 pr-3">Category (channel)</th><th className="py-1.5 pr-3">Scales Tested</th><th className="py-1.5 pr-3">Games Logged</th>
                      <th className="py-1.5 pr-3">R²</th><th className="py-1.5 pr-3">Estimated Best Sens</th><th className="py-1.5 pr-3">Estimated Result</th><th className="py-1.5">Read</th>
                    </tr>
                  </thead>
                  <tbody>
                    {heroStatRows.map(r => {
                      if (!r.fit) {
                        return (
                          <tr key={r.label} className="border-t border-ow-border text-[var(--faint)]">
                            <td className="py-1.5 pr-3 hero-name text-[var(--ink)]">{r.label}</td>
                            <td className="py-1.5 pr-3" colSpan={5}>Needs at least 3 reliable tested scales, or no crit/extra/signature stat logged for this hero yet.</td>
                          </tr>
                        );
                      }
                      const note = fitNote(r.fit, 'This stat');
                      const weak = !curveFitReliability(r.fit).trustworthy;
                      const toneClass = note.tone === 'good' ? 'text-emerald-700 dark:text-emerald-500' : note.tone === 'warn' ? 'text-amber-600 dark:text-amber-400' : note.tone === 'bad' ? 'text-red-600 dark:text-red-400' : 'text-[var(--faint)]';
                      return (
                        <tr key={r.label} className="border-t border-ow-border text-[var(--ink-2)] align-top">
                          <td className="py-1.5 pr-3 hero-name text-[var(--ink)] font-bold whitespace-nowrap">{r.label}</td>
                          <td className="py-1.5 pr-3 font-bold">{r.fit.points}</td>
                          <td className="py-1.5 pr-3 font-bold">{r.fit.totalN}</td>
                          <td className={`py-1.5 pr-3 font-bold ${weak ? 'text-red-600 dark:text-red-400' : r.fit.r2 >= 0.5 ? 'text-emerald-700 dark:text-emerald-500' : ''}`}>{r.fit.r2.toFixed(2)}</td>
                          <td className="py-1.5 pr-3 font-bold text-[var(--ink)] whitespace-nowrap">
                            {!weak && r.fit.hasInteriorPeak ? r.fit.optimalSens?.toFixed(2) : '—'}
                          </td>
                          <td className={`py-1.5 pr-3 font-bold ${!weak ? deltaColor(r.fit.predictedDelta) : ''}`}>{!weak && r.fit.hasInteriorPeak ? signed(r.fit.predictedDelta) : '—'}</td>
                          <td className={`py-1.5 text-xs ${toneClass}`}>{note.text}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <p className="text-xs text-[var(--faint)]">No category has 3+ reliable tested scales on a hero-specific stat yet.</p>
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

      {/* Mouse-accel curve confound (2026-09-17) — SECONDARY to the fitted
          accuracy/sens curve above, per Sean's own correction mid-task: he'd
          forgotten the Rawaccel accel curve existed when he asked for "the
          curve" and meant the fitted curve, not this one. Kept, demoted, and
          placed low on the page rather than as a headline section. Still a
          real finding: curve_enabled=1 pools three distinct curve settings,
          and Sean's actual Rawaccel setup is a LUT (lookup-table) staircase
          — 1,1;16,1;16.1,1.02;32,1.02;32.1,1.1;140,1.1 — while this app only
          ever recorded a smoothed Jump curve (smooth/input/output). Those are
          different MECHANISMS (a staircase has no smoothing and is capped at
          1.1x; the app's model has a soft transition and currently reads
          1.15x-1.5x), not just different numbers, so the 203 curve_enabled=1
          matches may not accurately describe what was actually running.
          Investigated, not fixed: the schema has no way to store a LUT
          (curve_params/matches only ever hold three scalars) — representing
          one would need a new column shape or table, out of scope here per
          Sean's explicit no-schema-change instruction. */}
      {(() => {
        const c = data.liveCurve;
        return (
          <Section
            title="Mouse-Accel Curve — Confound Check"
            hint={`Secondary to the fitted curve above (Sean's own correction, 2026-09-17). Every distinct curve setting actually found in this page's data — curve OFF is its own row. ${curveIsConfounded ? `${curveOnVariants.length} different "curve on" settings exist — any curve-on-vs-off read is mixing that many interventions into one label.` : 'Only one setting on record so far.'}`}
            dataInspectId="sensAnalysis-curve-confound"
          >
            <p className="text-xs text-[var(--faint)] rounded-lg bg-ow-darker border border-ow-border px-3 py-2 mb-3">
              App-recorded live curve (Jump model): <b className="text-[var(--ink)] num-display">{c.smooth}</b> smooth /{' '}
              <b className="text-[var(--ink)] num-display">{c.input}</b> input /{' '}
              <b className="text-[var(--ink)] num-display">{c.output}</b> output. Sean's actual Rawaccel setup is a
              LUT staircase (1,1; 16,1; 16.1,1.02; 32,1.02; 32.1,1.1; 140,1.1) — a different mechanism (no smoothing,
              capped at 1.1×) than the Jump model above. This app cannot represent a LUT; the columns it writes are
              Jump parameters that approximate, but do not exactly describe, what was actually running.
            </p>
            {curveIsConfounded && (
              <p className="text-xs rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-700 dark:text-amber-400 px-3 py-2 mb-3" data-inspect-id="sensAnalysis-curve-confound-warning">
                <b>{curveOnVariants.length} different "curve on" settings</b> show up in this data — it is NOT one
                treatment. Any curve-on-vs-off read elsewhere on this page (or in past reports) pools all of them
                together. Treat curve findings as unresolved until scoped to one specific setting.
              </p>
            )}
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] text-[var(--muted)] uppercase tracking-wider text-left">
                    <th className="py-1.5 pr-3">Curve</th><th className="py-1.5 pr-3">n</th><th className="py-1.5 pr-3">Overall</th><th className="py-1.5">vs. Avg</th>
                  </tr>
                </thead>
                <tbody>
                  {curveOffVariant && (
                    <tr className="border-t border-ow-border text-[var(--ink-2)]">
                      <td className="py-1.5 pr-3 text-[var(--ink)] font-bold">Off</td>
                      <td className="py-1.5 pr-3 font-bold">{curveOffVariant.n}</td>
                      <td className="py-1.5 pr-3">{f1(curveOffVariant.avgOverall)}%</td>
                      <td className={`py-1.5 ${deltaColor(curveOffVariant.avgDelta)}`}>{signed(curveOffVariant.avgDelta)}</td>
                    </tr>
                  )}
                  {curveOnVariants.map((v, i) => (
                    <tr key={i} className="border-t border-ow-border text-[var(--ink-2)]">
                      <td className="py-1.5 pr-3 text-[var(--ink)] font-bold">
                        On — {v.smooth ?? '—'}/{v.input ?? '—'}/{v.output ?? '—'}
                        <span className="ml-1 text-[10px] font-normal text-[var(--faint-2)]">(smooth/input/output)</span>
                      </td>
                      <td className="py-1.5 pr-3 font-bold">{v.n}</td>
                      <td className="py-1.5 pr-3">{f1(v.avgOverall)}%</td>
                      <td className={`py-1.5 ${deltaColor(v.avgDelta)}`}>{signed(v.avgDelta)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        );
      })()}

      {/* Hero-stat coverage (2026-09-17) — which heroes actually have a
          crit/extra/signature stat logged, and which fall back to
          accuracy-only in every co-primary pick above without any visible
          flag that they were weaker inputs. Zenyatta is the concrete case:
          heroStatLabel is null for him, so his co-primary pick falls back to
          crit alone — one channel instead of two, same as every hero below. */}
      {(() => {
        const coverage = heroes.map(h => {
          const crit = hasCrit(h.hero) ? critSlotShort(h.hero) : null;
          const extra = extraSlotShort(h.hero);
          const sig = h.heroStatLabel;
          const none = crit == null && extra == null && sig == null;
          return { h, crit, extra, sig, none };
        });
        const missing = coverage.filter(c => c.none);
        return (
          <Section
            title="Hero-Stat Coverage"
            hint={`Which heroes have a crit/extra/signature stat logged at all — the co-primary picks above weigh hero stats equally with accuracy, but only for heroes that HAVE one. ${missing.length} of ${heroes.length} heroes have no hero-stat channel${missing.length ? ` (${missing.map(m => m.h.hero).join(', ')})` : ''} — their best-sens pick and curve fit are accuracy-only, a weaker version of the same analysis, with no other flag on the page saying so.`}
            dataInspectId="sensAnalysis-hero-stat-coverage"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] text-[var(--muted)] uppercase tracking-wider text-left">
                    <th className="py-1.5 pr-3">Hero</th><th className="py-1.5 pr-3">Crit slot</th><th className="py-1.5 pr-3">Extra slot</th><th className="py-1.5 pr-3">Signature stat</th><th className="py-1.5">Co-primary basis</th>
                  </tr>
                </thead>
                <tbody>
                  {coverage.map(c => (
                    <tr key={c.h.hero} className={`border-t border-ow-border ${c.none ? 'text-amber-600 dark:text-amber-400' : 'text-[var(--ink-2)]'}`}>
                      <td className="py-1.5 pr-3 text-xs hero-name text-[var(--ink)]">{withHeroCount(c.h.hero, heroCounts)}</td>
                      <td className="py-1.5 pr-3">{c.crit ?? '—'}</td>
                      <td className="py-1.5 pr-3">{c.extra ?? '—'}</td>
                      <td className="py-1.5 pr-3">{c.sig ? `${c.sig} (n=${c.h.nHeroStat})` : '—'}</td>
                      <td className="py-1.5 font-bold">{c.none ? 'Accuracy only' : 'Accuracy + hero stat'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        );
      })()}

      {/* Where the minimum-n guard is biting (2026-09-17) — RELIABLE_N (5)
          excludes a scale from every pick/fit/finding on this page, but
          nothing previously said how MANY of a hero's tested scales actually
          sit below that bar. A hero could look thoroughly tested by total n
          while most of that n is scattered across thin, excluded buckets. */}
      {(() => {
        const rows = heroes.map(h => {
          const total = h.scales.length;
          const reliable = h.scales.filter(s => s.reliable).length;
          return { hero: h.hero, total, reliable, thin: total - reliable };
        });
        const rosterTotal = byScale.length;
        const rosterReliable = byScale.filter(s => s.reliable).length;
        return (
          <Section
            title="Where the Minimum-N Guard Is Biting"
            hint={`Scales need ${RELIABLE_N}+ games before they can win a pick or feed a curve fit or finding (MIN_SCALE_N). Roster-wide, ${rosterTotal - rosterReliable} of ${rosterTotal} tested scales are still below that bar. This breaks it down per hero, so "thoroughly tested" by total games doesn't hide a hero whose games are mostly scattered across thin, excluded scales.`}
            dataInspectId="sensAnalysis-min-n-coverage"
          >
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-[11px] text-[var(--muted)] uppercase tracking-wider text-left">
                    <th className="py-1.5 pr-3">Hero</th><th className="py-1.5 pr-3">Scales tested</th><th className="py-1.5 pr-3">Reliable (n≥{RELIABLE_N})</th><th className="py-1.5">Thin (excluded)</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.hero} className="border-t border-ow-border text-[var(--ink-2)]">
                      <td className="py-1.5 pr-3 text-xs hero-name text-[var(--ink)]">{withHeroCount(r.hero, heroCounts)}</td>
                      <td className="py-1.5 pr-3 font-bold">{r.total}</td>
                      <td className="py-1.5 pr-3 font-bold text-emerald-700 dark:text-emerald-500">{r.reliable}</td>
                      <td className={`py-1.5 font-bold ${r.thin > 0 ? 'text-amber-600 dark:text-amber-400' : ''}`}>{r.thin}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Section>
        );
      })()}

    </div>,
  );
}
