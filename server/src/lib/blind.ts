// Staged DPI-test helpers: stage-set generation. Values are never hidden —
// each stage's DPI is shown on the test page the whole time, so there's no
// blinding math (no shuffle, no relative-position tracking, no reveal).

export interface StageSpec {
  stage_index: number;
  dpi: number;
  pct_delta: number;
}

// Generate N DPI values spread evenly across ±pctRange around baseDpi
// (rounded to the nearest 50), in ascending stage order.
export function generateStages(baseDpi: number, pctRange: number, n: number): StageSpec[] {
  const stages: StageSpec[] = [];
  for (let i = 0; i < n; i++) {
    const pct = n === 1 ? 0 : -pctRange + (2 * pctRange) * (i / (n - 1));
    const dpi = Math.round((baseDpi * (1 + pct / 100)) / 50) * 50;
    stages.push({ stage_index: i + 1, dpi, pct_delta: Math.round(pct * 10) / 10 });
  }
  return stages;
}

// Build stages from explicit, hand-picked DPI values (e.g. levels chosen per
// hero from prior analysis), in the order given. pct_delta is computed against
// the list's own mean purely as an informational label.
export function stagesFromDpis(dpis: number[]): StageSpec[] {
  const baseDpi = dpis.reduce((a, b) => a + b, 0) / dpis.length;
  return dpis.map((dpi, i) => ({
    stage_index: i + 1, dpi, pct_delta: Math.round(((dpi - baseDpi) / baseDpi) * 1000) / 10,
  }));
}
