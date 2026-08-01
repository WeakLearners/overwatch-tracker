import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';
import { generateStages, stagesFromDpis } from '../lib/blind';
import { cm360, eDPI } from '../lib/aim';

const router = Router();

interface SetRow {
  id: number; in_game_sens: number; base_dpi: number; created_at: string;
  batch_size: number; cur_rel: number; games_on_stage: number; hero: string | null;
}
interface StageRow { stage_index: number; dpi: number; pct_delta: number; }

const activeSets = (db: ReturnType<typeof getDb>) =>
  db.prepare('SELECT * FROM blind_stage_sets WHERE active = 1 ORDER BY id').all() as unknown as SetRow[];

const stagesOf = (db: ReturnType<typeof getDb>, setId: number) =>
  db.prepare('SELECT stage_index, dpi, pct_delta FROM blind_stages WHERE set_id = :id ORDER BY stage_index')
    .all({ id: setId }) as unknown as StageRow[];

// Total games ever logged against a set, across all its stages combined —
// distinct from games_on_stage, which only counts toward the current stage.
const totalGamesOf = (db: ReturnType<typeof getDb>, setId: number) =>
  (db.prepare('SELECT COUNT(*) n FROM matches WHERE blind_set_id = :id').get({ id: setId }) as { n: number }).n;

// ── Create a set ─────────────────────────────────────────────────────────────
// Stages are shown plainly — no shuffle, no scramble step. Two ways to specify
// them: pass `dpis` (explicit, hand-picked values — e.g. levels chosen per hero
// from prior analysis) or omit it and fall back to the auto-generated
// ±pct_range spread around base_dpi. cur_rel starts at 1 — the set is playable
// immediately at its first stage.
//
// Multiple sets can be active at once — each match auto-tags to the active set
// matching its own hero (or the ad-hoc, hero-less set, if one is running), so
// heroes test independently and can be run in parallel. The only restriction
// is one active, unfinished set per hero (or per the ad-hoc slot) at a time —
// a second one would leave match auto-tagging ambiguous.
router.post('/sets', (req: Request, res: Response) => {
  const db = getDb();
  const in_game_sens = Number(req.body.in_game_sens ?? 2.5);
  const batch_size = Number(req.body.batch_size ?? 10);
  const hero = typeof req.body.hero === 'string' && req.body.hero.trim() ? req.body.hero.trim() : null;
  if (!(in_game_sens > 0) || !(batch_size >= 1)) {
    res.status(400).json({ error: 'invalid set params' });
    return;
  }

  const dupe = db.prepare('SELECT id FROM blind_stage_sets WHERE active = 1 AND hero IS :hero').get({ hero }) as { id: number } | undefined;
  if (dupe) {
    res.status(409).json({ error: hero ? `${hero} already has an active test running` : 'an ad-hoc test is already active' });
    return;
  }

  const dpisInput: number[] | null = Array.isArray(req.body.dpis) ? (req.body.dpis as unknown[]).map(Number) : null;
  let stages: ReturnType<typeof generateStages>;
  let base_dpi: number;
  let n_stages: number;

  if (dpisInput) {
    if (dpisInput.length < 2 || dpisInput.some(d => !(d > 0))) {
      res.status(400).json({ error: 'dpis must have 2+ positive values' });
      return;
    }
    stages = stagesFromDpis(dpisInput);
    base_dpi = Math.round(dpisInput.reduce((a, b) => a + b, 0) / dpisInput.length);
    n_stages = dpisInput.length;
  } else {
    base_dpi = Number(req.body.base_dpi ?? 1600);
    const pct_range = Number(req.body.pct_range ?? 10);
    n_stages = Number(req.body.n_stages ?? 5);
    if (!(base_dpi > 0) || !(n_stages >= 2)) {
      res.status(400).json({ error: 'invalid set params' });
      return;
    }
    stages = generateStages(base_dpi, pct_range, n_stages);
  }

  // Insert-set + insert-stages must land together — if a restart or error
  // interrupts between them, an uncommitted transaction rolls back cleanly
  // instead of leaving a set with no stages.
  let set_id: number;
  db.exec('BEGIN');
  try {
    const r = db.prepare(`
      INSERT INTO blind_stage_sets (in_game_sens, base_dpi, active, note, batch_size, cur_rel, games_on_stage, scramble_done, resolved, hero)
      VALUES (:s, :d, 1, :note, :b, 1, 0, 1, 0, :hero)
    `).run({ s: in_game_sens, d: base_dpi, note: req.body.note ?? null, b: batch_size, hero });
    set_id = Number(r.lastInsertRowid);
    const ins = db.prepare('INSERT INTO blind_stages (set_id, stage_index, dpi, pct_delta) VALUES (:set_id, :stage_index, :dpi, :pct_delta)');
    for (const st of stages) ins.run({ set_id, ...st });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  res.json({ set_id, in_game_sens, base_dpi, n_stages, batch_size, hero, stages });
});

// ── Cancel a set ─────────────────────────────────────────────────────────────
// Abandons a test: deletes the set (blind_stages cascades) plus any matches
// logged against it. Completed sets (every stage hit its game target) are
// refused outright — that's finished, load-bearing history, not an
// in-progress attempt to discard.
router.delete('/sets/:id', (req: Request, res: Response) => {
  const db = getDb();
  const set = db.prepare('SELECT id, batch_size FROM blind_stage_sets WHERE id = :id')
    .get({ id: req.params.id }) as { id: number; batch_size: number } | undefined;
  if (!set) { res.status(404).json({ error: 'set not found' }); return; }

  const n_stages = stagesOf(db, set.id).length;
  const gameCount = totalGamesOf(db, set.id);
  const completed = gameCount >= set.batch_size * n_stages;
  if (completed) { res.status(409).json({ error: 'cannot cancel a completed set' }); return; }

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
    SELECT id, hero, active, batch_size, created_at
    FROM blind_stage_sets ORDER BY id ASC
  `).all() as { id: number; hero: string | null; active: number; batch_size: number; created_at: string }[];
  const sets = rows.map(row => {
    const n_stages = stagesOf(db, row.id).length;
    const totalGames = totalGamesOf(db, row.id);
    return {
      set_id: row.id, hero: row.hero, active: !!row.active,
      completed: totalGames >= row.batch_size * n_stages,
      batch_size: row.batch_size, n_stages, totalGames, created_at: row.created_at,
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
    const curStage = stages.find(s => s.stage_index === set.cur_rel) ?? stages[0];
    const totalGames = totalGamesOf(db, set.id);
    const target = set.batch_size * n_stages;
    const completed = totalGames >= target;

    return {
      set_id: set.id, in_game_sens: set.in_game_sens, base_dpi: set.base_dpi, created_at: set.created_at,
      batch_size: set.batch_size, cur_stage: set.cur_rel, games_on_stage: set.games_on_stage,
      dpi: curStage?.dpi ?? null, n_stages, hero: set.hero, totalGames, completed,
      needSwitch: !completed && set.games_on_stage >= set.batch_size,
      stages,
    };
  });

  res.json({ actives });
});

// ── Advance a set to its next stage ─────────────────────────────────────────
// Sequential — stage order is exactly the order the DPIs were entered in.
// Takes set_id since several sets may be active at once.
router.post('/advance', (req: Request, res: Response) => {
  const db = getDb();
  const set_id = Number(req.body.set_id);
  const set = db.prepare('SELECT * FROM blind_stage_sets WHERE id = :id AND active = 1').get({ id: set_id }) as SetRow | undefined;
  if (!set) { res.status(409).json({ error: 'no such active set' }); return; }
  const stages = stagesOf(db, set.id);
  const n = stages.length;
  if (set.cur_rel >= n) { res.status(409).json({ error: 'already at the last stage' }); return; }

  const next = set.cur_rel + 1;
  db.prepare('UPDATE blind_stage_sets SET cur_rel = :next, games_on_stage = 0 WHERE id = :id').run({ next, id: set.id });
  const stage = stages.find(s => s.stage_index === next);
  res.json({ cur_stage: next, dpi: stage?.dpi ?? null, n_stages: n });
});

// ── Per-stage summary (feel consistency etc) ──────────────────────────────────
router.get('/sets/:id', (req: Request, res: Response) => {
  const db = getDb();
  const set = db.prepare('SELECT id, in_game_sens, base_dpi, created_at, active FROM blind_stage_sets WHERE id = :id')
    .get({ id: req.params.id }) as (SetRow & { active: number }) | undefined;
  if (!set) { res.status(404).json({ error: 'set not found' }); return; }
  const stages = stagesOf(db, set.id);

  const rows = stages.map(st => {
    const trials = db.prepare(`
      SELECT feel FROM matches WHERE blind_set_id = :sid AND stage_index = :si
    `).all({ sid: set.id, si: st.stage_index }) as { feel: number | null }[];
    const feels = trials.map(t => t.feel).filter((f): f is number => f != null);
    const feelMean = feels.length ? feels.reduce((a, b) => a + b, 0) / feels.length : null;
    const feelVar = feels.length > 1 ? feels.reduce((a, b) => a + (b - (feelMean as number)) ** 2, 0) / feels.length : null;
    return {
      stage_index: st.stage_index, dpi: st.dpi, pct_delta: st.pct_delta,
      eDPI: eDPI(set.in_game_sens, st.dpi), cm360: Math.round(cm360(set.in_game_sens, st.dpi) * 100) / 100,
      n: trials.length, feelMean, feelVar,
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

export default router;
