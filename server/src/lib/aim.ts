// Sensitivity-study constants and helpers.
//
// DPI is fixed hardware config for this study and never changes, so in-game
// `sens` alone determines the two device-independent scales we analyse against:
// eDPI (a linear rescale) and cm/360 (centimeters of mouse travel per full
// 360° turn — the truly comparable, reproducible number).

// Default DPI. Non-blind study matches use this; blind-trial matches carry their
// own per-match dpi (the hidden variable), passed explicitly below.
export const MOUSE_DPI = 1600;

// Hard usability floor for in-game sens in any test bracket — Sean's call, not
// a data-derived value. Below this it feels sluggish/unplayable to him
// ("swimming in mud"), so no test set should ever ask him to play a stage
// below it, regardless of what a curve fit might suggest.
export const MIN_SENS = 2.5;

// Overwatch yaw constant: degrees of in-game turn per mouse count at sens 1.
const OW_YAW = 0.0066;

// eDPI and cm/360 are functions of BOTH dpi and sens. dpi defaults to MOUSE_DPI
// so every legacy caller (which only knows sens) is unchanged; blind-trial code
// passes the real per-match dpi.
export const eDPI = (sens: number, dpi: number = MOUSE_DPI): number => dpi * sens;

// cm/360 = (360° * 2.54 cm/in) / (deg-per-count * counts-per-inch)
//        = (360 * 2.54) / (OW_YAW * sens * dpi).  At 1600 dpi, sens 2.5 → ~34.6 cm.
export const cm360 = (sens: number, dpi: number = MOUSE_DPI): number =>
  (360 * 2.54) / (OW_YAW * sens * dpi);

// --- Curve fitting ---------------------------------------------------------
// Weighted least-squares quadratic fit (y = a*x^2 + b*x + c) over a hero's
// tested sens scales, so the analysis page can name a continuous "best" sens
// instead of just the best-performing point actually tested. Weighted by n
// (games logged at that scale) so a thin outlier scale doesn't out-vote a
// well-tested one.
export interface CurvePoint { x: number; y: number; w: number; }
export interface QuadraticFit { a: number; b: number; c: number; r2: number; }

// Solves the 3x3 weighted-normal-equations system via Cramer's rule. Returns
// null if the system is singular (e.g. every point at the same x).
function solveWeightedQuadratic(pts: CurvePoint[]): QuadraticFit | null {
  let Sw = 0, Swx = 0, Swx2 = 0, Swx3 = 0, Swx4 = 0, Swy = 0, Swxy = 0, Swx2y = 0;
  for (const { x, y, w } of pts) {
    const x2 = x * x, x3 = x2 * x, x4 = x2 * x2;
    Sw += w; Swx += w * x; Swx2 += w * x2; Swx3 += w * x3; Swx4 += w * x4;
    Swy += w * y; Swxy += w * x * y; Swx2y += w * x2 * y;
  }
  // [Swx4 Swx3 Swx2] [a]   [Swx2y]
  // [Swx3 Swx2 Swx ] [b] = [Swxy ]
  // [Swx2 Swx  Sw  ] [c]   [Swy  ]
  const det3 = (m: number[][]) =>
    m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
    - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
    + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const M = [[Swx4, Swx3, Swx2], [Swx3, Swx2, Swx], [Swx2, Swx, Sw]];
  const D = det3(M);
  if (!Number.isFinite(D) || Math.abs(D) < 1e-9) return null;
  const B = [Swx2y, Swxy, Swy];
  const withCol = (col: number) => M.map((row, i) => row.map((v, j) => (j === col ? B[i] : v)));
  const [a, b, c] = [0, 1, 2].map(col => det3(withCol(col)) / D);

  const yMean = Sw ? Swy / Sw : 0;
  let ssRes = 0, ssTot = 0;
  for (const { x, y, w } of pts) {
    const yhat = a * x * x + b * x + c;
    ssRes += w * (y - yhat) ** 2;
    ssTot += w * (y - yMean) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;
  return { a, b, c, r2 };
}

export interface CurveFitResult {
  points: number; totalN: number;
  a: number; b: number; c: number; r2: number;
  optimalX: number | null; predictedY: number | null;
  hasInteriorPeak: boolean; inRange: boolean;
  xMin: number; xMax: number;
}

// Fits a quadratic to (x, y, weight) points and locates its vertex, framed
// against the actually-tested x-range. Needs 3+ distinct x values — a
// quadratic through 2 points is underdetermined (infinite solutions).
// `hasInteriorPeak` is false when the parabola opens upward (a >= 0, i.e. a
// trough rather than a peak) — there the vertex is a worst point, not a best
// one, so callers should treat optimalX as meaningless in that case.
export function fitQuadraticPeak(pts: CurvePoint[]): CurveFitResult | null {
  const distinctX = new Set(pts.map(p => p.x)).size;
  if (distinctX < 3) return null;
  const fit = solveWeightedQuadratic(pts);
  if (!fit) return null;
  const { a, b, c, r2 } = fit;
  const xMin = Math.min(...pts.map(p => p.x));
  const xMax = Math.max(...pts.map(p => p.x));
  const hasInteriorPeak = a < 0;
  const optimalX = hasInteriorPeak ? -b / (2 * a) : null;
  const predictedY = optimalX != null ? a * optimalX * optimalX + b * optimalX + c : null;
  const inRange = optimalX != null && optimalX >= xMin && optimalX <= xMax;
  return {
    points: distinctX, totalN: pts.reduce((s, p) => s + p.w, 0),
    a, b, c, r2, optimalX, predictedY, hasInteriorPeak, inRange, xMin, xMax,
  };
}

// Rawaccel Motivity (sigmoid) curve params. Curve and per-hero in-game sens
// are separate, multiplicative layers (curve output × hero sens = final
// speed) — the curve doesn't replace per-hero sens switching, it's layered
// on top for within-hero dynamic scaling by raw mouse speed. Enabled per
// phase/test-set (blind_stage_sets.curve_enabled — see routes/blind.ts and
// SensLog.tsx's "+ Add new phase" toggle), first genuinely used in Phase 7
// (2026-08-26).
//
// CURVE_MOTIVITY/CURVE_GROWTH_RATE/CURVE_MIDPOINT below are the fixed
// fallback values used by flat-value curve-enabled stages (a stage with one
// sens value, curve applied uniformly on top). MOTIVITY was derived from
// real per-hero converged-sens spread (fastest hero ÷ slowest hero);
// GROWTH_RATE and MIDPOINT are still unvalidated placeholders — MIDPOINT
// especially needs a real per-player calibration (play at a very high
// midpoint to isolate/confirm base sens feel, then lower it until fast
// flicks start getting boosted — see Raw Accel's own guide) that hasn't
// been run yet.
//
// "Ranged" stages (blind_stages.sens_low/sens_high both set) are the newer,
// per-stage-varying alternative: instead of one flat sens number, a stage
// defines the curve's floor and ceiling directly, and MOTIVITY is derived
// per stage via deriveMotivity below instead of using the fixed constant —
// GROWTH_RATE/MIDPOINT still come from the fixed constants either way, since
// those are closer to fixed properties of the player's hand/mouse than
// something a sens bracket can determine.
export const CURVE_MOTIVITY = 1.30; // cap multiplier: Shion/Reaper's 2.76 ÷ Zenyatta's 2.13
export const CURVE_GROWTH_RATE = 1.0; // unvalidated placeholder
export const CURVE_MIDPOINT = 12; // unvalidated placeholder, counts/ms — needs real calibration

// A Motivity curve maps mouse speed to a sensitivity multiplier that's 1×
// exactly at the midpoint speed, dropping toward 1/motivity below it and
// rising toward motivity above it. So if a "ranged" stage wants its slow-speed
// floor to land on `low` and its fast-speed ceiling to land on `high` (both
// real, absolute sens values — not multipliers), solving
// base/motivity = low and base*motivity = high gives:
export const deriveBaseSens = (low: number, high: number): number => Math.sqrt(low * high);
export const deriveMotivity = (low: number, high: number): number => Math.sqrt(high / low);

// Aim archetype per hero. Governs how strongly crit/overall accuracy reflects
// raw sensitivity fit. Only DPS heroes whose accuracy is clearly sens-dominated
// are tagged hitscan or projectile; everything else (tanks, supports, spread/
// utility DPS, and heroes whose aim signal is too noisy) is 'other' and is
// excluded from the hitscan-vs-projectile split. This is a deliberate starting
// point — tune it as the data comes in.
export type Archetype = 'hitscan' | 'projectile' | 'other';

export const HERO_ARCHETYPE: Record<string, Archetype> = {
  // Hitscan — flick/tracking precision, crit accuracy is the clean signal.
  Ashe: 'hitscan',
  Cassidy: 'hitscan',
  Shion: 'hitscan',
  'Soldier: 76': 'hitscan',
  Sojourn: 'hitscan',
  Sombra: 'hitscan',
  Tracer: 'hitscan',
  Widowmaker: 'hitscan',
  // Projectile — leads/arcs, accuracy is prediction-heavy but still sens-linked.
  Echo: 'projectile',
  Genji: 'projectile',
  Hanzo: 'projectile',
  Junkrat: 'projectile',
  Mei: 'projectile',
  Pharah: 'projectile',
  Venture: 'projectile',
};

export const archetypeOf = (hero: string): Archetype =>
  HERO_ARCHETYPE[hero] ?? 'other';

// --- Timeline derivations -------------------------------------------------
// The matches table stores no per-session counter and no "sens changed here"
// flag, so both are derived from the ordered match timeline at read time.

// A run of matches with less than this many minutes between them counts as one
// play session. Match #1 of a session is "cold"; later matches are "warm".
export const SESSION_GAP_MIN = 35;

export interface TimelineMatch {
  id: number;
  time: string | null;
  date: string;
  sens: number | null;
  dpi?: number | null;
}

// Chronological ordering key — prefer the full timestamp, fall back to date.
const chronoMs = (m: TimelineMatch): number => {
  const ms = Date.parse(m.time ?? `${m.date}T00:00:00`);
  return Number.isNaN(ms) ? 0 : ms;
};

const chronological = (ms: TimelineMatch[]): TimelineMatch[] =>
  [...ms].sort((a, b) => chronoMs(a) - chronoMs(b) || a.id - b.id);

// 1-based position of each match within its session (1 = cold / first game).
export function deriveSessionPosition(matches: TimelineMatch[]): Map<number, number> {
  const pos = new Map<number, number>();
  let prevMs: number | null = null;
  let n = 0;
  for (const m of chronological(matches)) {
    const ms = chronoMs(m);
    if (prevMs === null || (ms - prevMs) / 60000 > SESSION_GAP_MIN) n = 1;
    else n += 1;
    pos.set(m.id, n);
    prevMs = ms;
  }
  return pos;
}

// Sens-bearing matches played since the sensitivity last changed (0 = the match
// the change landed on, or the first sens-bearing match). Lets analysis tell a
// still-adapting run from a settled one. Only sens-bearing matches are counted.
//
// "Changed" is measured on eDPI (dpi × sens), not raw sens — blind trials hold
// sens frozen and move dpi, so keying off sens alone would miss every change.
export function deriveSensAdaptation(matches: TimelineMatch[]): Map<number, number> {
  const out = new Map<number, number>();
  let lastEdpi: number | null = null;
  let since = 0;
  for (const m of chronological(matches)) {
    if (m.sens == null) continue;
    const e = eDPI(m.sens, m.dpi ?? MOUSE_DPI);
    if (lastEdpi === null || e !== lastEdpi) { since = 0; lastEdpi = e; }
    else since += 1;
    out.set(m.id, since);
  }
  return out;
}
