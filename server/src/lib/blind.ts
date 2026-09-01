// Staged sensitivity-test helpers: stage-set generation. Values are never
// hidden — each stage's setting is shown on the test page the whole time, so
// there's no blinding math (no shuffle, no relative-position tracking, no
// reveal).
//
// Mouse DPI is locked at 1600 permanently (2026-08-08) — the mouse config
// app floored DPI changes at 50-unit steps, which was too coarse. In-game
// sens has no such floor, so it's now the varying axis instead; `dpi` on
// every stage is just the fixed 1600 constant (MOUSE_DPI in lib/aim.ts),
// kept on each row so old and new stages share one shape and the DB's
// dpi NOT NULL constraint still holds. `sens` is null on legacy DPI-varying
// stages and the varying value on current sens-varying ones.

export const LOCKED_DPI = 1600;

export interface StageSpec {
  stage_index: number;
  dpi: number;
  sens: number | null;
  pct_delta: number;
}

// Generate N DPI values spread evenly across ±pctRange around baseDpi
// (rounded to the nearest 50), in ascending stage order. Legacy path, kept
// for sets created before the DPI-lock — no longer used by new test plans.
export function generateStages(baseDpi: number, pctRange: number, n: number): StageSpec[] {
  const stages: StageSpec[] = [];
  for (let i = 0; i < n; i++) {
    const pct = n === 1 ? 0 : -pctRange + (2 * pctRange) * (i / (n - 1));
    const dpi = Math.round((baseDpi * (1 + pct / 100)) / 50) * 50;
    stages.push({ stage_index: i + 1, dpi, sens: null, pct_delta: Math.round(pct * 10) / 10 });
  }
  return stages;
}

// Build stages from explicit, hand-picked DPI values (e.g. levels chosen per
// hero from prior analysis), in the order given. pct_delta is computed against
// the list's own mean purely as an informational label. Legacy path.
export function stagesFromDpis(dpis: number[]): StageSpec[] {
  const baseDpi = dpis.reduce((a, b) => a + b, 0) / dpis.length;
  return dpis.map((dpi, i) => ({
    stage_index: i + 1, dpi, sens: null, pct_delta: Math.round(((dpi - baseDpi) / baseDpi) * 1000) / 10,
  }));
}

// Build stages from explicit, hand-picked in-game sens values, in the order
// given. DPI is fixed at LOCKED_DPI on every stage. pct_delta is computed
// against the list's own mean purely as an informational label.
export function stagesFromSens(senses: number[]): StageSpec[] {
  const baseSens = senses.reduce((a, b) => a + b, 0) / senses.length;
  return senses.map((sens, i) => ({
    stage_index: i + 1, dpi: LOCKED_DPI, sens, pct_delta: Math.round(((sens - baseSens) / baseSens) * 1000) / 10,
  }));
}
