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

// ── Block model (added 2026-09-27) ──────────────────────────────────────────
// A "block" is 60 minutes of play on one hero (that hero's own
// aim_stats_heroes.duration_min on each credited match — a mid-match switch
// credits each hero its own minutes, not the whole match's length). It
// replaces the old fixed "5 games" stint/chunk-unit: minutes vary game to
// game, so this counts UP a running total and closes a block the instant it
// reaches 60, discarding whatever's left over (a game that ends a block at
// 63 minutes doesn't carry 3 minutes into the next one — see
// deriveBlockState). Blocks are the new atomic unit both the ABBA schedule
// below and nextTest.ts's "stay on X" reminder are built from — see that
// file for why a hero's own block persists across an interruption (playing
// something else and coming back) instead of resetting.
//
// Chosen size: a chunk (the ABBA alternation unit just below) is 2 blocks,
// same as it was 2 stints (10 games) before. A stage is 8 blocks per
// physical stage (4 chunks), same as it was 8 stints (40 games) before —
// this is a straight swap of the old fixed-game-count "stint" unit for a
// fixed-minutes one, not a change to the schedule's shape. The original
// stint rationale still holds and is worth restating here since it now
// governs something that runs on a clock instead of a scoreboard: this is
// a play-experience choice, not a statistical one. Across 905 matches, the
// first game on a hero each day scored -0.27 accuracy points versus later
// same-day games on the same hero (SE 0.46) — indistinguishable from zero.
// Switching heroes carries no measurable warm-up cost in this data. Do not
// shrink BLOCK_MINUTES to "optimize" it — there is nothing here to
// optimize; it exists purely so a session doesn't feel like hero roulette,
// and 60 minutes at Sean's typical per-match length lands in almost exactly
// the same real-world cadence the old 5-game stint did.
export const BLOCK_MINUTES = 60;

// Chunk = 2 blocks (sens flips only at a chunk boundary — never mid-block).
// Stage = 8 blocks per physical stage = 4 chunks, mirroring the old 8
// stints x 5 games = 40-game batch_size for one stage.
export const CHUNK_BLOCKS = 2;
export const STAGE_BLOCKS = 8;

export interface BlockState {
  closedBlocks: number;   // completed 60-minute blocks, in order
  openMinutes: number;    // minutes accumulated in the still-open (partial) block; 0 if none open
  openMatchCount: number; // credited matches contributing to that open block
}

// Walks a hero's own credited matches in chronological order, accumulating
// minutes per match (a missing duration_min — 2 of 1,181 historical rows —
// counts as 0, never as a skip) until the running total reaches
// BLOCK_MINUTES, at which point the block closes and the overflow above 60
// is dropped rather than seeded into the next block. Whatever's left after
// the last row is the current open (partial) block — 0 minutes/0 matches if
// the most recent credited match closed a block exactly, or if there have
// been none yet.
export function deriveBlockState(durationsInOrder: (number | null | undefined)[]): BlockState {
  let closedBlocks = 0, minutes = 0, count = 0;
  for (const d of durationsInOrder) {
    minutes += d ?? 0;
    count += 1;
    if (minutes >= BLOCK_MINUTES) {
      closedBlocks += 1;
      minutes = 0;
      count = 0;
    }
  }
  return { closedBlocks, openMinutes: minutes, openMatchCount: count };
}

// ── ABBA alternation ─────────────────────────────────────────────────────────
// Added 2026-09-23, converted from game-counted to block-counted 2026-09-27
// (see the block-model comment above — the schedule's shape didn't change,
// only the unit it counts in). Each live 2-stage set (ids 141-148, one per
// hero) used to run all of stage 1 before any of stage 2. The 8 sets run
// concurrently over roughly an 85-day phase, so Sean's own
// improvement/patches/form drift over that span gets credited entirely to
// whichever stage happens to run second — a confound, not noise, since it
// has a direction. Alternating the two stages in chunks removes it.
//
// Order is A,B,B,A, not A,B,A,B. Picture a straight-line drift (Sean slowly
// getting better) drawn across the 8 chunks of an 8-block stage split into
// 4 chunks of 2: A,B,B,A repeated twice puts stage A's 4 chunks at
// positions {1,4,5,8} and stage B's at {2,3,6,7} — each pair is symmetric
// around the run's midpoint, so the drift's average contribution to A and
// to B is identical. A,B,A,B puts B's chunks at {2,4,6,8}, systematically
// later than A's {1,3,5,7} — B absorbs more of the drift, every time.
//
// "A" and "B" are literally stage_index 1 and 2. This is not a hidden
// label: this codebase's blind-trial mechanism has never hidden the
// physical sens/DPI value from Sean — he has to type it into Overwatch's own
// in-game sensitivity setting (Rawaccel only carries the separate
// mouse-acceleration curve, curve_params/LUT — not this value), and
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
// Generic over its unit — the caller passes CHUNK_BLOCKS/closedBlocks now
// (routes/blind.ts, scripts/nightlyReport.ts) instead of the game counts it
// took before 2026-09-27; the math is identical either way. Only meaningful
// for exactly 2 stages — callers fall back to the legacy contiguous
// behavior (set.chunk_size == null, or stages.length !== 2) rather than
// guessing at a pattern for more.
export function abbaStageFor(unitsCreditedBefore: number, chunkSize: number): 1 | 2 {
  const chunkIndex = Math.floor(unitsCreditedBefore / chunkSize);
  const pattern: [1, 2, 2, 1] = [1, 2, 2, 1];
  return pattern[chunkIndex % 4];
}

// ── Stage badge label ("A1".."B4") ──────────────────────────────────────────
// Added 2026-09-23 alongside the stint/gauge rework below, converted to
// blocks 2026-09-27. The HUD used to show a bare stage number (1 or 2) in a
// circle next to the gauge — useless once two stages alternate in chunks,
// since "stage 1" no longer tells Sean which of the (up to) four A-chunks
// or four B-chunks he's actually on. The letter is just abbaStageFor's own
// 1/2 relabeled A/B; the ordinal counts how many chunks of THAT letter have
// occurred up to and including the current one. Deliberately built by
// walking abbaStageFor chunk-by-chunk (bounded — at most
// STAGE_BLOCKS/CHUNK_BLOCKS chunks, 4 for every live set) rather than a
// closed-form formula, so this label can never drift from the alternation
// pattern the switch-prompt/completion logic (liveStageIndex, needsSwitchNow
// in routes/blind.ts) already derives the same way. Takes closed-block
// counts now, not game counts — see the block-model comment above.
export function chunkLabelFor(unitsCreditedBefore: number, chunkSize: number): string {
  const chunkIndex = Math.floor(unitsCreditedBefore / chunkSize);
  let aCount = 0, bCount = 0;
  for (let i = 0; i <= chunkIndex; i++) {
    if (abbaStageFor(i * chunkSize, chunkSize) === 1) aCount++; else bCount++;
  }
  return abbaStageFor(chunkIndex * chunkSize, chunkSize) === 1 ? `A${aCount}` : `B${bCount}`;
}

// Closed blocks left in the CURRENT chunk (not the whole stage) — used for
// the chunk/stage progress text on the HUD (SensLog.tsx). The gauge itself
// no longer counts this down (2026-09-27: it's a single continuous 0-60min
// fill of the hero's OPEN block instead, driven directly by
// BlockState.openMinutes) but the chunk-of-4 progress line still wants "how
// many closed blocks until the next switch."
export function leftInCurrentChunk(unitsCreditedBefore: number, chunkSize: number): number {
  return chunkSize - (unitsCreditedBefore % chunkSize);
}

// ── Queue-mode study eligibility ────────────────────────────────────────────
// Switched off 2026-09-23 at Sean's request: from now on ONLY Competitive
// matches earn a stage-test credit, for every role. Support briefly had a QP
// exception (added while support data was still thin, retired 2026-08-23 via
// commit 7d80e90 once support was on the same comp-only phase DPS already
// was) — before that, both DPS and Support QP matches credited a stage.
// matches.ts's insert and roster-recompute paths both call this at write
// time to decide whether to look up an active stage at all.
//
// The same condition also has to run at READ time: 469 blind_credits rows
// (2026-07-14 -> 2026-08-21, spanning both the pre-retirement DPS-only era
// and the brief Support-QP-exception era) were written under the old rule
// and are QP. Never delete or modify those rows — every analysis surface
// that reads blind_credits (SensAnalysis/byScale, curve fit, per-stage
// accuracy, findings/sweep, nightly report's bracket reads) calls this same
// function, joined to the match's queue_mode, to exclude them from the
// numbers without touching the rows themselves. Sean's decision 2026-09-23;
// reverse by removing the call sites that apply this filter to a read.
export function isStudyQueueMode(queueMode: string | null | undefined): boolean {
  return (queueMode ?? 'comp_role') !== 'qp_role';
}

// Same condition as isStudyQueueMode above, as a raw SQL fragment for the
// read-path queries that filter blind_credits in SQL rather than in JS
// (an in-process filter can't call a JS function from inside a prepared
// statement). Every query that interpolates this must alias the joined
// matches row as `m`. Kept textually identical to isStudyQueueMode on
// purpose — if one changes, the other must too.
export const NOT_QP_SQL = "COALESCE(m.queue_mode, 'comp_role') != 'qp_role'";
