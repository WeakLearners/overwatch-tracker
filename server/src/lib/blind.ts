// Blind-trial helpers: stage-set generation and row masking.
//
// The blinding contract: the true sensitivity of an unrevealed blind trial must
// never leave the server. generateStages() builds the hidden shuffle;
// maskMatchRow() strips the value fields from any row on the way out.

export interface StageSpec {
  stage_index: number;
  dpi: number;
  pct_delta: number;
}

// Generate N DPI values spread evenly across ±pctRange around baseDpi (rounded to
// the nearest 50), then shuffle them into stage slots so slot order ≠ speed order.
// A pluggable rand() keeps it testable; defaults to Math.random.
export function generateStages(
  baseDpi: number,
  pctRange: number,
  n: number,
  rand: () => number = Math.random,
): StageSpec[] {
  const vals: { dpi: number; pct: number }[] = [];
  for (let i = 0; i < n; i++) {
    const pct = n === 1 ? 0 : -pctRange + (2 * pctRange) * (i / (n - 1));
    const dpi = Math.round((baseDpi * (1 + pct / 100)) / 50) * 50;
    vals.push({ dpi, pct: Math.round(pct * 10) / 10 });
  }
  // Fisher–Yates shuffle so the physical slot carries no information about speed.
  for (let i = vals.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [vals[i], vals[j]] = [vals[j], vals[i]];
  }
  return vals.map((v, i) => ({ stage_index: i + 1, dpi: v.dpi, pct_delta: v.pct }));
}

// ── Relative-position math ──────────────────────────────────────────────────
// The player scrambles to an unknown absolute slot, which the app calls rel 0.
// It then tracks only relative position (clicks mod n). Absolute slots — and
// thus dpi — are unknown until reveal, when the player reports the currently
// active slot and we back-solve the constant offset.

const mod = (a: number, n: number) => ((a % n) + n) % n;

// Clicks to advance from one relative position to another (always 1..n-1 when
// the targets differ, since callers never re-select the current position).
export const clicksBetween = (cur: number, next: number, n: number): number => mod(next - cur, n);

// offset = absolute − relative, constant for a set. Derived at reveal from the
// player's reported current slot (1-indexed) and the app's current rel position.
export const offsetFromReveal = (currentSlot1: number, curRel: number, n: number): number =>
  mod((currentSlot1 - 1) - curRel, n);

// Resolve a trial's relative position to its absolute slot (1-indexed) given the
// offset — the inverse of the scramble.
export const absoluteSlot = (relPos: number, offset: number, n: number): number =>
  mod(relPos + offset, n) + 1;

type MaskableRow = {
  blind_trial?: number | null;
  revealed?: number | null;
  sens?: number | null;
  dpi?: number | null;
};

// Hide the true sensitivity of an unrevealed blind trial. Value fields go null;
// stage_index (if present) is left intact so the UI can still show "Stage N".
export function maskMatchRow<T extends MaskableRow>(row: T): T & { masked: boolean } {
  const masked = !!row.blind_trial && !row.revealed;
  if (!masked) return { ...row, masked: false };
  return { ...row, sens: null, dpi: null, masked: true };
}
