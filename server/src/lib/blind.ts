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

// ── ABBA alternation ─────────────────────────────────────────────────────────
// Added 2026-09-23. Each live 2-stage set (ids 141-148, one per hero,
// batch_size 40) used to run all 40 games of stage 1 before any of stage 2.
// The 8 sets run concurrently over roughly an 85-day phase, so Sean's own
// improvement/patches/form drift over that span gets credited entirely to
// whichever stage happens to run second — a confound, not noise, since it
// has a direction. Alternating the two stages in chunks removes it.
//
// Order is A,B,B,A, not A,B,A,B. Picture a straight-line drift (Sean slowly
// getting better) drawn across the 8 chunks of a 40-game stage split into
// 4 chunks of 10: A,B,B,A repeated twice puts stage A's 4 chunks at
// positions {1,4,5,8} and stage B's at {2,3,6,7} — each pair is symmetric
// around the run's midpoint, so the drift's average contribution to A and
// to B is identical. A,B,A,B puts B's chunks at {2,4,6,8}, systematically
// later than A's {1,3,5,7} — B absorbs more of the drift, every time.
//
// "A" and "B" are literally stage_index 1 and 2. This is not a hidden
// label: this codebase's blind-trial mechanism has never hidden the
// physical sens/DPI value from Sean — he has to type it into Rawaccel, and
// SensLog.tsx (`active.sens.toFixed(2)`) and Prematch.tsx both show it
// plainly. lib/blind.ts's own original header comment already said so:
// "no blinding math (no shuffle, no relative-position tracking, no
// reveal)" — the scramble/reveal columns on blind_stage_sets
// (scramble_done, revealed_slot) are confirmed-dead leftovers from an
// earlier design that was never finished. "Blind" here has always meant
// Sean doesn't precompute which stage will win, not that the number is
// concealed. So alternating stages changes nothing about that: it was
// exactly this transparent before, and it is exactly this transparent now.
//
// Only meaningful for exactly 2 stages — callers fall back to the legacy
// contiguous behavior (set.chunk_size == null, or stages.length !== 2)
// rather than guessing at a pattern for more.
export function abbaStageFor(totalGamesCreditedBefore: number, chunkSize: number): 1 | 2 {
  const chunkIndex = Math.floor(totalGamesCreditedBefore / chunkSize);
  const pattern: [1, 2, 2, 1] = [1, 2, 2, 1];
  return pattern[chunkIndex % 4];
}
