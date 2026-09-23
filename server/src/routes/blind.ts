import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';
import {
  generateStages, stagesFromDpis, stagesFromSens, LOCKED_DPI, abbaStageFor, isStudyQueueMode, NOT_QP_SQL,
  chunkLabelFor, leftInCurrentChunk,
} from '../lib/blind';
import { cm360, eDPI } from '../lib/aim';
import { computeNextTest, projectPhaseFinish, type HeroTestProgress, type StintInfo } from '../lib/nextTest';
import { HEROES_BY_ROLE } from './advisor';

const router = Router();

export interface SetRow {
  id: number; in_game_sens: number; base_dpi: number; created_at: string;
  batch_size: number; cur_rel: number; games_on_stage: number; hero: string | null;
  phase: string | null; curve_enabled: number; chunk_size: number | null;
}
export interface StageRow {
  stage_index: number; dpi: number; sens: number | null; pct_delta: number; abandoned: number;
}

export const activeSets = (db: ReturnType<typeof getDb>) =>
  db.prepare('SELECT * FROM blind_stage_sets WHERE active = 1 ORDER BY id').all() as unknown as SetRow[];

export const stagesOf = (db: ReturnType<typeof getDb>, setId: number) =>
  db.prepare('SELECT stage_index, dpi, sens, pct_delta, abandoned FROM blind_stages WHERE set_id = :id ORDER BY stage_index')
    .all({ id: setId }) as unknown as StageRow[];

// Total games ever logged against a set, across all its stages combined —
// distinct from games_on_stage, which only counts toward the current stage.
// Reads blind_credits (one row per hero actually credited, including
// mid-match switches into this hero), not matches.blind_set_id — that column
// only ever reflects the match's slot-1/primary hero.
export const totalGamesOf = (db: ReturnType<typeof getDb>, setId: number) =>
  (db.prepare('SELECT COUNT(*) n FROM blind_credits WHERE blind_set_id = :id').get({ id: setId }) as { n: number }).n;

// Games credited toward one specific stage — derived live from blind_credits
// (same source of truth as totalGamesOf above), not from the stored
// blind_stage_sets.games_on_stage column. That column used to be a
// hand-maintained running counter with its own increment/decrement call
// sites in matches.ts, which could drift from the live blind_credits count
// (e.g. a credit landing on a stage index games_on_stage's writers didn't
// expect) and produce contradictory "0 left in test" / "1 left in stage"
// numbers on the HUD. Computing both from the same table keeps them
// consistent by construction. The column itself is left in the schema,
// unused, per this codebase's no-drop-columns convention.
export const gamesOnStageOf = (db: ReturnType<typeof getDb>, setId: number, stageIndex: number) =>
  (db.prepare('SELECT COUNT(*) n FROM blind_credits WHERE blind_set_id = :id AND stage_index = :si')
    .get({ id: setId, si: stageIndex }) as { n: number }).n;

// ── Live stage resolution (legacy cur_rel, or ABBA-derived) ─────────────────
// The physical stage_index that the NEXT credited game for this set will
// land on — the single thing every caller that used to read `cur_rel`
// directly (findActiveStage in matches.ts, /state, nightlyReport.ts's
// computeStageStatus) now asks this function instead.
//
// Legacy/contiguous sets (chunk_size null, or anything other than exactly
// 2 stages — ABBA is only defined for 2) keep reading the stored, manually
// advanced cur_rel column exactly as before: this function is a no-op for
// them.
//
// Chunked 2-stage sets have no manual advance at all — cur_rel is never
// written for them and stays at its insert-time value of 1, unused. The
// current stage is derived live from totalGamesOf, the same "derive from
// blind_credits, never trust a hand-maintained counter" rule this file
// already applies to gamesOnStageOf/totalGamesOf above.
export type StageResolvableSet = Pick<SetRow, 'id' | 'chunk_size' | 'cur_rel' | 'batch_size'>;

export function liveStageIndex(db: ReturnType<typeof getDb>, set: StageResolvableSet, nStages: number): number {
  if (set.chunk_size == null || nStages !== 2) return set.cur_rel;
  return abbaStageFor(totalGamesOf(db, set.id), set.chunk_size);
}

// Whether Sean needs to switch his physical setting before the NEXT game.
// For a chunked set this compares the stage the next game would land on
// against the stage the last-credited game landed on — not just "did we
// cross a multiple of chunk_size," because two consecutive chunks can
// legitimately share a stage (A,B,B,A's 3rd and 4th chunks, both A, run
// back to back with no switch between them) and that must not fire a
// false prompt. For a legacy set this is the original rule, unchanged:
// the current stage's own running total has reached the full batch_size.
export function needsSwitchNow(
  db: ReturnType<typeof getDb>, set: StageResolvableSet, nStages: number, completed: boolean,
): boolean {
  if (completed) return false;
  if (set.chunk_size == null || nStages !== 2) {
    return gamesOnStageOf(db, set.id, set.cur_rel) >= set.batch_size;
  }
  const total = totalGamesOf(db, set.id);
  if (total === 0) return false;
  return abbaStageFor(total, set.chunk_size) !== abbaStageFor(total - 1, set.chunk_size);
}

// ── Completion, per stage ────────────────────────────────────────────────────
// A set is finished when EVERY stage has its batch_size games — not when the
// running total happens to reach batch_size * n_stages. Those two agree only
// when the games landed evenly, and the whole point of a staged set is the
// comparison between stages: a 2-stage/batch-5 set that took 2 games on stage
// one and 8 on stage two also totals 10, and under the old total-count rule
// reported itself finished, indistinguishable from a real 5-and-5. Nothing
// downstream could tell them apart, because the distribution only ever lived
// in blind_credits. Checking the stages individually is the same query the
// HUD already runs for needSwitch, just applied to all of them at once.
//
// legacy_closed short-circuits this for the sets retired before the rule
// changed — see the column's note in schema.ts.
export function isSetComplete(db: ReturnType<typeof getDb>, setId: number): boolean {
  const set = db.prepare('SELECT batch_size, legacy_closed FROM blind_stage_sets WHERE id = :id')
    .get({ id: setId }) as { batch_size: number; legacy_closed: number } | undefined;
  if (!set) return false;
  if (set.legacy_closed) return true;
  const stages = stagesOf(db, setId);
  if (!stages.length) return false;
  return stages.every(s => s.abandoned || gamesOnStageOf(db, setId, s.stage_index) >= set.batch_size);
}

// Recompute a set's active flag from its credits. Two-way on purpose:
// retirement used to be a one-way UPDATE with no inverse, so deleting a match
// out of a finished set left it short of its target AND permanently shut —
// it could no longer be advanced (409, inactive) or credited (findActiveStage
// only sees active=1), which is exactly how set 86 (Reaper) ended up stranded
// at 5+1 of 10 with no way back. Deriving the flag instead means a deletion
// reopens the set on its own.
//
// The one thing reopening must not do is break the invariant that at most one
// active set owns a given hero (or the ad-hoc, hero-less slot) — findActiveStage
// would have no way to choose between them. If a newer set has already taken
// the slot, the old one stays closed.
export function syncSetActive(db: ReturnType<typeof getDb>, setId: number) {
  const set = db.prepare('SELECT id, hero, active FROM blind_stage_sets WHERE id = :id')
    .get({ id: setId }) as { id: number; hero: string | null; active: number } | undefined;
  if (!set) return;

  if (isSetComplete(db, setId)) {
    if (set.active) db.prepare('UPDATE blind_stage_sets SET active = 0 WHERE id = :id').run({ id: setId });
    return;
  }
  if (set.active) return;

  const rival = set.hero === null
    ? db.prepare('SELECT id FROM blind_stage_sets WHERE active = 1 AND hero IS NULL AND id != :id').get({ id: setId })
    : db.prepare('SELECT id FROM blind_stage_sets WHERE active = 1 AND hero = :hero AND id != :id').get({ id: setId, hero: set.hero });
  if (rival) return;

  db.prepare('UPDATE blind_stage_sets SET active = 1 WHERE id = :id').run({ id: setId });
}

// ── Create a set ─────────────────────────────────────────────────────────────
// Stages are shown plainly — no shuffle, no scramble step. Three ways to
// specify them: pass `senses` (explicit, hand-picked in-game sens values —
// the current path, mouse DPI locked at LOCKED_DPI/1600 on every stage), or
// the legacy `dpis` path (explicit DPI values, sens frozen), or omit both and
// fall back to the legacy auto-generated ±pct_range DPI spread around
// base_dpi. cur_rel starts at 1 — the set is playable immediately at its
// first stage.
//
// Multiple sets can be active at once — each match auto-tags to the active set
// matching its own hero (or the ad-hoc, hero-less set, if one is running), so
// heroes test independently and can be run in parallel. The only restriction
// is one active, unfinished set per hero (or per the ad-hoc slot) at a time —
// a second one would leave match auto-tagging ambiguous.
router.post('/sets', (req: Request, res: Response) => {
  const db = getDb();
  const batch_size = Number(req.body.batch_size ?? 10);
  const hero = typeof req.body.hero === 'string' && req.body.hero.trim() ? req.body.hero.trim() : null;
  const phase = typeof req.body.phase === 'string' && req.body.phase.trim() ? req.body.phase.trim() : null;
  if (!(batch_size >= 1)) {
    res.status(400).json({ error: 'invalid set params' });
    return;
  }

  const dupe = db.prepare('SELECT id FROM blind_stage_sets WHERE active = 1 AND hero IS :hero').get({ hero }) as { id: number } | undefined;
  if (dupe) {
    res.status(409).json({ error: hero ? `${hero} already has an active test running` : 'an ad-hoc test is already active' });
    return;
  }

  // chunk_size: optional, per-set, ABBA alternation block length (see
  // lib/blind.ts's abbaStageFor). Only meaningful for exactly 2 stages —
  // rejected outright for anything else rather than silently ignored,
  // since a silently-ignored chunk_size would look configured but do
  // nothing. Must evenly divide batch_size or a stage would never land on
  // a clean chunk boundary.
  const chunkSizeInput = req.body.chunk_size != null ? Number(req.body.chunk_size) : null;

  const curveEnabled = req.body.curve_enabled === true || req.body.curve_enabled === 1;
  const sensesInput: number[] | null = Array.isArray(req.body.senses) ? (req.body.senses as unknown[]).map(Number) : null;
  const dpisInput: number[] | null = Array.isArray(req.body.dpis) ? (req.body.dpis as unknown[]).map(Number) : null;
  let stages: ReturnType<typeof generateStages>;
  let base_dpi: number;
  let in_game_sens: number;
  let n_stages: number;

  if (sensesInput) {
    if (sensesInput.length < 2 || sensesInput.some(s => !(s > 0))) {
      res.status(400).json({ error: 'senses must have 2+ positive values' });
      return;
    }
    stages = stagesFromSens(sensesInput);
    base_dpi = LOCKED_DPI;
    in_game_sens = Math.round((sensesInput.reduce((a, b) => a + b, 0) / sensesInput.length) * 1000) / 1000;
    n_stages = sensesInput.length;
  } else if (dpisInput) {
    if (dpisInput.length < 2 || dpisInput.some(d => !(d > 0))) {
      res.status(400).json({ error: 'dpis must have 2+ positive values' });
      return;
    }
    in_game_sens = Number(req.body.in_game_sens ?? 2.5);
    if (!(in_game_sens > 0)) {
      res.status(400).json({ error: 'in_game_sens must be > 0' });
      return;
    }
    stages = stagesFromDpis(dpisInput);
    base_dpi = Math.round(dpisInput.reduce((a, b) => a + b, 0) / dpisInput.length);
    n_stages = dpisInput.length;
  } else {
    base_dpi = Number(req.body.base_dpi ?? 1600);
    const pct_range = Number(req.body.pct_range ?? 10);
    n_stages = Number(req.body.n_stages ?? 5);
    in_game_sens = Number(req.body.in_game_sens ?? 2.5);
    if (!(base_dpi > 0) || !(n_stages >= 2) || !(in_game_sens > 0)) {
      res.status(400).json({ error: 'invalid set params (in_game_sens must be > 0)' });
      return;
    }
    stages = generateStages(base_dpi, pct_range, n_stages);
  }

  if (chunkSizeInput != null) {
    if (n_stages !== 2) {
      res.status(400).json({ error: 'chunk_size only applies to a 2-stage set' });
      return;
    }
    if (!(chunkSizeInput > 0) || !Number.isInteger(chunkSizeInput) || batch_size % chunkSizeInput !== 0) {
      res.status(400).json({ error: 'chunk_size must be a positive integer that evenly divides batch_size' });
      return;
    }
  }

  // Insert-set + insert-stages must land together — if a restart or error
  // interrupts between them, an uncommitted transaction rolls back cleanly
  // instead of leaving a set with no stages.
  let set_id: number;
  db.exec('BEGIN');
  try {
    // scramble_done/resolved are confirmed-dead leftovers from an earlier
    // hidden-DPI design (schema.ts's comment on these columns) — left off
    // here rather than hardcoded on every set, since nothing reads them.
    const r = db.prepare(`
      INSERT INTO blind_stage_sets (in_game_sens, base_dpi, active, note, batch_size, cur_rel, games_on_stage, hero, phase, curve_enabled, chunk_size)
      VALUES (:s, :d, 1, :note, :b, 1, 0, :hero, :phase, :curve_enabled, :chunk_size)
    `).run({ s: in_game_sens, d: base_dpi, note: req.body.note ?? null, b: batch_size, hero, phase, curve_enabled: curveEnabled ? 1 : 0, chunk_size: chunkSizeInput });
    set_id = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO blind_stages (set_id, stage_index, dpi, sens, pct_delta) VALUES (:set_id, :stage_index, :dpi, :sens, :pct_delta)');
    for (const st of stages) ins.run({ set_id, stage_index: st.stage_index, dpi: st.dpi, sens: st.sens, pct_delta: st.pct_delta });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  res.json({ set_id, in_game_sens, base_dpi, n_stages, batch_size, hero, phase, stages, curve_enabled: curveEnabled, chunk_size: chunkSizeInput });
});

// ── Cancel a set ─────────────────────────────────────────────────────────────
// Abandons a test: deletes the set (blind_stages, blind_credits cascade) plus
// any matches that started on this hero while it was active. A match where
// this hero was only a mid-match switch (its blind_credits row, not its
// primary blind_set_id) keeps its own match row — only the now-orphaned
// credit toward this set disappears — since deleting the whole match would
// destroy that match's actual primary hero's data too. Completed sets (every
// stage hit its game target) are refused outright — that's finished,
// load-bearing history, not an in-progress attempt to discard.
router.delete('/sets/:id', (req: Request, res: Response) => {
  const db = getDb();
  const set = db.prepare('SELECT id, batch_size FROM blind_stage_sets WHERE id = :id')
    .get({ id: req.params.id }) as { id: number; batch_size: number } | undefined;
  if (!set) { res.status(404).json({ error: 'set not found' }); return; }

  const gameCount = totalGamesOf(db, set.id);
  if (isSetComplete(db, set.id)) { res.status(409).json({ error: 'cannot cancel a completed set' }); return; }

  // Safety net against an accidental cancel wiping real data: if games have been
  // logged against this set, refuse unless the caller explicitly opts in with
  // ?force=1. The client only sends that after a typed confirmation.
  const force = req.query.force === '1' || req.query.force === 'true';
  if (gameCount > 0 && !force) {
    res.status(409).json({ error: 'set has logged games; retry with force to confirm', gameCount });
    return;
  }

  const { changes: deletedMatches } = db.prepare('DELETE FROM matches WHERE blind_set_id = :id').run({ id: set.id });
  db.prepare('DELETE FROM blind_stage_sets WHERE id = :id').run({ id: set.id });
  res.json({ ok: true, deletedMatches });
});

// ── List sets ────────────────────────────────────────────────────────────────
// All sets (active or not), each with its hero tag and total games logged —
// lets the UI show a hero's test as "completed" even after a newer set for a
// different hero has taken over as active.
router.get('/sets', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, hero, phase, active, batch_size, created_at, curve_enabled
    FROM blind_stage_sets ORDER BY id ASC
  `).all() as { id: number; hero: string | null; phase: string | null; active: number; batch_size: number; created_at: string; curve_enabled: number }[];
  const sets = rows.map(row => {
    const stages = stagesOf(db, row.id);
    const totalGames = totalGamesOf(db, row.id);
    return {
      set_id: row.id, hero: row.hero, phase: row.phase, active: !!row.active,
      completed: isSetComplete(db, row.id),
      batch_size: row.batch_size, n_stages: stages.length, totalGames, created_at: row.created_at,
      values: stages.map(s => s.sens ?? s.dpi), curveEnabled: !!row.curve_enabled,
    };
  });
  res.json({ sets });
});

// ── Loop state ───────────────────────────────────────────────────────────────
// Drives the whole page. Stages (and the current one's DPI) are always
// visible — there's nothing to hide. Multiple sets can be active at once (one
// per hero, plus at most one ad-hoc/hero-less set), so this returns all of
// them — the UI renders one progress card per active set.
router.get('/state', (_req: Request, res: Response) => {
  const db = getDb();
  const sets = activeSets(db);

  const actives = sets.map(set => {
    const stages = stagesOf(db, set.id);
    const n_stages = stages.length;
    const curRel = liveStageIndex(db, set, n_stages);
    const curStage = stages.find(s => s.stage_index === curRel) ?? stages[0];
    const totalGames = totalGamesOf(db, set.id);
    const completed = isSetComplete(db, set.id);
    const gamesOnStage = gamesOnStageOf(db, set.id, curRel);

    // Chunk-local display, only meaningful when this set is actually
    // chunked. gamesOnStage always counts in complete chunk_size blocks in
    // order for a chunked set (chunk_size divides batch_size evenly), so
    // "which chunk, how far into it" is a plain division — no need to
    // track a separate running chunk index anywhere.
    //
    // label/left (added 2026-09-23) replace the plain
    // stage-number badge and stage-wide gauge on the Select Your Hero HUD
    // for a chunked set: `label` is the "A1".."B4" chunk badge
    // (chunkLabelFor — built from the same abbaStageFor the switch-prompt
    // logic already uses, not a parallel counter), and `left` counts down
    // the CURRENT chunk rather than the whole 40-match stage. The client
    // draws one gauge bar per match, chunk_size bars in all.
    const chunkLeft = set.chunk_size != null ? leftInCurrentChunk(totalGames, set.chunk_size) : 0;
    const chunkInfo = (set.chunk_size != null && n_stages === 2)
      ? {
          chunk_size: set.chunk_size,
          n_chunks_per_stage: Math.ceil(set.batch_size / set.chunk_size),
          chunk_number: gamesOnStage > 0 ? Math.ceil(gamesOnStage / set.chunk_size) : 1,
          chunk_position: gamesOnStage > 0 ? ((gamesOnStage - 1) % set.chunk_size) + 1 : 0,
          label: chunkLabelFor(totalGames, set.chunk_size),
          left: chunkLeft,
        }
      : null;

    return {
      set_id: set.id, in_game_sens: set.in_game_sens, base_dpi: set.base_dpi, created_at: set.created_at,
      batch_size: set.batch_size, cur_stage: curRel, games_on_stage: gamesOnStage,
      dpi: curStage?.dpi ?? null, sens: curStage?.sens ?? null, n_stages, hero: set.hero, phase: set.phase, totalGames, completed,
      needSwitch: needsSwitchNow(db, set, n_stages, completed),
      stages, curveEnabled: !!set.curve_enabled, chunk: chunkInfo,
    };
  });

  res.json({ actives });
});

// ── Advance a set to its next stage ─────────────────────────────────────────
// Sequential — stage order is exactly the order the DPIs were entered in.
// Takes set_id since several sets may be active at once.
//
// Refuses to leave a stage that hasn't had its batch_size games, because
// cur_rel only ever moves up: findActiveStage credits cur_rel and nothing
// walks it back, so a stage abandoned early can never refill and the set is
// permanently lopsided. This is the same condition /state already computes as
// needSwitch to light up the button — the endpoint simply wasn't asking.
// ?force=1 (or force in the body) is the deliberate out for a stage worth
// abandoning — bad session, wrong hero — and the client only sends it behind
// a confirm, mirroring how DELETE /sets/:id guards a destructive restart.
router.post('/advance', (req: Request, res: Response) => {
  const db = getDb();
  const set_id = Number(req.body.set_id);
  const set = db.prepare('SELECT * FROM blind_stage_sets WHERE id = :id AND active = 1').get({ id: set_id }) as SetRow | undefined;
  if (!set) { res.status(409).json({ error: 'no such active set' }); return; }
  const stages = stagesOf(db, set.id);
  const n = stages.length;

  // Chunked sets have no manual step at all — see liveStageIndex/
  // needsSwitchNow above. cur_rel is never written for them (stays at its
  // insert-time 1, unused), so honoring a call here would silently do
  // nothing useful while looking like it worked.
  if (set.chunk_size != null && n === 2) {
    res.status(409).json({ error: 'chunked sets alternate automatically — there is no manual advance step' });
    return;
  }

  if (set.cur_rel >= n) { res.status(409).json({ error: 'already at the last stage' }); return; }

  const force = req.body?.force === true || req.body?.force === 1
    || req.query.force === '1' || req.query.force === 'true';
  const gamesOnStage = gamesOnStageOf(db, set.id, set.cur_rel);
  if (gamesOnStage < set.batch_size && !force) {
    res.status(409).json({
      error: 'stage is not finished; retry with force to confirm',
      games_on_stage: gamesOnStage, batch_size: set.batch_size,
    });
    return;
  }

  const next = set.cur_rel + 1;
  // Record the shortfall rather than silently swallowing it — see the
  // abandoned column's note in schema.ts for why the set needs this to be
  // able to finish at all.
  if (gamesOnStage < set.batch_size) {
    db.prepare('UPDATE blind_stages SET abandoned = 1 WHERE set_id = :id AND stage_index = :si')
      .run({ id: set.id, si: set.cur_rel });
  }
  db.prepare('UPDATE blind_stage_sets SET cur_rel = :next WHERE id = :id').run({ next, id: set.id });
  const stage = stages.find(s => s.stage_index === next);
  res.json({ cur_stage: next, dpi: stage?.dpi ?? null, sens: stage?.sens ?? null, n_stages: n });
});

// ── Per-stage summary (feel consistency etc) ──────────────────────────────────
router.get('/sets/:id', (req: Request, res: Response) => {
  const db = getDb();
  const set = db.prepare('SELECT id, in_game_sens, base_dpi, created_at, active FROM blind_stage_sets WHERE id = :id')
    .get({ id: req.params.id }) as (SetRow & { active: number }) | undefined;
  if (!set) { res.status(404).json({ error: 'set not found' }); return; }
  const stages = stagesOf(db, set.id);

  const rows = stages.map(st => {
    // Reads blind_credits (one row per hero actually credited to this
    // stage, including mid-match switches), not matches.blind_set_id/
    // stage_index directly — those columns only ever reflect the match's
    // slot-1/primary hero (see totalGamesOf above) and would undercount
    // this stage's trial rows exactly like they undercounted games_on_stage
    // before blind_credits existed. feel is read per credited hero via
    // match_heroes rather than matches.feel, since match_heroes has its own
    // per-hero feel value for every slot (matches.feel only mirrors slot 1's).
    // Excludes QP-credited rows (lib/blind.ts's isStudyQueueMode) — see the
    // 469-row note on that function; this "per-stage accuracy" summary is
    // one of the analysis surfaces those historical credits are filtered
    // out of, without touching the blind_credits rows themselves.
    const trials = db.prepare(`
      SELECT mh.feel FROM blind_credits bc
      JOIN match_heroes mh ON mh.match_id = bc.match_id AND mh.hero = bc.hero
      JOIN matches m ON m.id = bc.match_id
      WHERE bc.blind_set_id = :sid AND bc.stage_index = :si AND ${NOT_QP_SQL}
    `).all({ sid: set.id, si: st.stage_index }) as { feel: number | null }[];
    const feels = trials.map(t => t.feel).filter((f): f is number => f != null);
    const feelMean = feels.length ? feels.reduce((a, b) => a + b, 0) / feels.length : null;
    const feelVar = feels.length > 1 ? feels.reduce((a, b) => a + (b - (feelMean as number)) ** 2, 0) / feels.length : null;

    // Win rate, accuracy, and output-per-10min for this stage — the same
    // signals the hand-written phase notes cite ("led on accuracy and
    // elims/min") — so the "+ Add new phase" form can narrow toward whichever
    // stage actually performed better instead of just shrinking blindly
    // around the old midpoint. overall_acc is per-hero (aim_stats_heroes);
    // elims/damage/duration are match-level (aim_stats) like the rest of the
    // codebase's per-10min rate stats (see stats.ts computePerformanceOutcome).
    // Same QP exclusion as `trials` above — one shared condition, applied at
    // both query sites in this endpoint.
    const perf = db.prepare(`
      SELECT m.win, ah.overall_acc, a.elims, a.damage, a.duration_min
      FROM blind_credits bc
      JOIN matches m ON m.id = bc.match_id
      LEFT JOIN aim_stats_heroes ah ON ah.match_id = bc.match_id AND ah.hero = bc.hero
      LEFT JOIN aim_stats a ON a.match_id = bc.match_id
      WHERE bc.blind_set_id = :sid AND bc.stage_index = :si AND ${NOT_QP_SQL}
    `).all({ sid: set.id, si: st.stage_index }) as {
      win: number; overall_acc: number | null; elims: number | null; damage: number | null; duration_min: number | null;
    }[];
    const winRate = perf.length ? Math.round((perf.filter(p => p.win).length / perf.length) * 1000) / 10 : null;
    const accVals = perf.map(p => p.overall_acc).filter((v): v is number => v != null);
    const accMean = accVals.length ? Math.round((accVals.reduce((a, b) => a + b, 0) / accVals.length) * 10) / 10 : null;
    const rateRows = perf.filter((p): p is typeof p & { elims: number; damage: number; duration_min: number } =>
      p.elims != null && p.damage != null && p.duration_min != null && p.duration_min > 0);
    const elimsPer10 = rateRows.length
      ? Math.round((rateRows.reduce((s, p) => s + p.elims / p.duration_min * 10, 0) / rateRows.length) * 10) / 10 : null;
    const dmgPer10 = rateRows.length
      ? Math.round((rateRows.reduce((s, p) => s + p.damage / p.duration_min * 10, 0) / rateRows.length) * 10) / 10 : null;

    // Legacy stages (sens null) vary dpi with sens frozen on the set; current
    // stages (sens populated) vary sens with dpi frozen at LOCKED_DPI.
    const stageSens = st.sens ?? set.in_game_sens;
    return {
      stage_index: st.stage_index, dpi: st.dpi, sens: st.sens, pct_delta: st.pct_delta,
      eDPI: eDPI(stageSens, st.dpi), cm360: Math.round(cm360(stageSens, st.dpi) * 100) / 100,
      n: trials.length, feelMean, feelVar,
      games: perf.length, winRate, accMean, elimsPer10, dmgPer10,
    };
  });

  res.json({
    set: {
      set_id: set.id, in_game_sens: set.in_game_sens, base_dpi: set.base_dpi,
      created_at: set.created_at, active: !!set.active,
    },
    stages: rows,
  });
});

// ── Next-test recommender ────────────────────────────────────────────────────
// GET /api/blind/next?queue_mode=... — see lib/nextTest.ts for the actual
// decision logic (round-robin pick, stint math, cold guard). Everything
// below is just gathering that function's plain-data inputs from the DB;
// nothing here is stored or computed ahead of time — it's all derived fresh
// on every call, same as /state above.

function roleOfHero(hero: string): string | null {
  for (const [role, heroes] of Object.entries(HEROES_BY_ROLE)) {
    if (heroes.includes(hero)) return role;
  }
  return null;
}

// Same "which phase is current" rule the client already applies to GET
// /api/blind/sets's response (Prematch.tsx's currentPhase: the LAST set, by
// id, that carries a phase tag at all). Kept identical on purpose — this
// endpoint and the Select Your Hero picker must agree on which 8 heroes are
// "the current phase," or the recommender could point at a phase that
// picker isn't even showing.
function currentPhaseKey(db: ReturnType<typeof getDb>): string | null {
  const rows = db.prepare('SELECT phase FROM blind_stage_sets ORDER BY id ASC').all() as { phase: string | null }[];
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].phase) return rows[i].phase;
  }
  return null;
}

function heroProgressForPhase(db: ReturnType<typeof getDb>, phase: string): HeroTestProgress[] {
  const rows = db.prepare('SELECT id, hero FROM blind_stage_sets WHERE phase = :phase AND hero IS NOT NULL')
    .all({ phase }) as { id: number; hero: string }[];
  const now = Date.now();
  return rows.map(row => {
    const role = roleOfHero(row.hero) ?? 'DPS';
    const nStages = stagesOf(db, row.id).length;
    const credited = totalGamesOf(db, row.id);
    const batch = (db.prepare('SELECT batch_size FROM blind_stage_sets WHERE id = :id').get({ id: row.id }) as { batch_size: number }).batch_size;
    const last = db.prepare(`
      SELECT MAX(m.created_at) last FROM blind_credits bc JOIN matches m ON m.id = bc.match_id
      WHERE bc.blind_set_id = :id
    `).get({ id: row.id }) as { last: string | null };
    // Same UTC-parse convention as advisor.ts's cache-age check: created_at
    // is sqlite's `datetime('now')`, which has no timezone suffix of its
    // own but is always UTC — appending 'Z' is what tells JS's Date that.
    const daysSinceLastPlayed = last.last
      ? Math.floor((now - new Date(last.last + 'Z').getTime()) / 86_400_000)
      : null;
    return {
      hero: row.hero, role, credited, target: batch * nStages,
      daysSinceLastPlayed, completed: isSetComplete(db, row.id),
    };
  });
}

// The stint: how many of the most recent test-credited matches, in a row,
// share the same PRIMARY hero (matches.hero — the hero Sean queued as, not
// a mid-match switch). Reads straight off the match log, no stored state —
// per the brief, a non-test match (no blind_credits row for its primary
// hero) neither breaks nor advances this count, so it's simplest to just
// never fetch them: the query below already filters to test-credited rows
// only, so consecutive ROWS here are already consecutive TEST matches, with
// any ordinary/QP matches in between invisibly skipped.
function currentStint(db: ReturnType<typeof getDb>): StintInfo | null {
  const rows = db.prepare(`
    SELECT m.hero FROM matches m
    JOIN blind_credits bc ON bc.match_id = m.id AND bc.hero = m.hero
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 200
  `).all() as { hero: string }[];
  if (rows.length === 0) return null;
  const hero = rows[0].hero;
  let count = 0;
  for (const r of rows) {
    if (r.hero !== hero) break;
    count++;
  }
  return { hero, count };
}

router.get('/next', (req: Request, res: Response) => {
  const db = getDb();
  const queueMode = typeof req.query.queue_mode === 'string' ? req.query.queue_mode : null;

  // Quickplay earns no test credit for any role (be23788) — the recommender
  // has nothing to recommend, and showing a role/hero list here would imply
  // otherwise. Same shared rule the write path uses, so this can never
  // disagree with what actually gets credited.
  if (!isStudyQueueMode(queueMode)) {
    res.json({ isQuickplay: true });
    return;
  }

  const phase = currentPhaseKey(db);
  if (!phase) {
    res.json({
      isQuickplay: false, phase: null, heroes: [], projection: { ratePerDay: 0, projectedDays: null },
      allFinished: true, finishedHeroes: [], stint: null, recommendedRole: null, orderedHeroes: [],
    });
    return;
  }

  const heroes = heroProgressForPhase(db, phase);
  const stint = currentStint(db);
  const rec = computeNextTest(heroes, stint);

  // Phase-wide projection (the /sens overview's job, not Prematch's card —
  // included here rather than a second endpoint since it's the same roster
  // query with one more aggregate on top). Trailing 14 days, phase-wide
  // across every hero's set, not just the recommended role.
  const PROJECTION_WINDOW_DAYS = 14;
  const setIds = db.prepare('SELECT id FROM blind_stage_sets WHERE phase = :phase AND hero IS NOT NULL')
    .all({ phase }) as { id: number }[];
  const gamesInWindow = setIds.length ? (db.prepare(`
    SELECT COUNT(*) n FROM blind_credits bc JOIN matches m ON m.id = bc.match_id
    WHERE bc.blind_set_id IN (${setIds.map(() => '?').join(',')})
      AND m.created_at >= datetime('now', '-${PROJECTION_WINDOW_DAYS} days')
  `).get(...setIds.map(s => s.id)) as { n: number }).n : 0;
  const remaining = heroes.reduce((sum, h) => sum + Math.max(0, h.target - h.credited), 0);
  // Divide by the days the phase has actually run, capped at the window.
  // A 2-day-old phase divided by 14 read 18 games as 1.3/day (~484 days).
  const phaseStart = db.prepare('SELECT MIN(created_at) s FROM blind_stage_sets WHERE phase = :phase')
    .get({ phase }) as { s: string | null };
  const daysRunning = phaseStart.s ? (Date.now() - new Date(phaseStart.s + 'Z').getTime()) / 86_400_000 : PROJECTION_WINDOW_DAYS;
  const windowDays = Math.min(PROJECTION_WINDOW_DAYS, Math.max(1, daysRunning));
  const projection = projectPhaseFinish(remaining, gamesInWindow, windowDays);

  res.json({ isQuickplay: false, phase, heroes, projection, ...rec });
});

export default router;
