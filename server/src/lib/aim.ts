// Sensitivity-study constants and helpers.
//
// DPI is fixed hardware config for this study and never changes, so in-game
// `sens` alone determines the two device-independent scales we analyse against:
// eDPI (a linear rescale) and cm/360 (centimeters of mouse travel per full
// 360° turn — the truly comparable, reproducible number).

// Default DPI. Non-blind study matches use this; blind-trial matches carry their
// own per-match dpi (the hidden variable), passed explicitly below.
export const MOUSE_DPI = 1600;

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
