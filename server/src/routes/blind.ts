import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';
import { generateStages, clicksBetween, offsetFromReveal, absoluteSlot } from '../lib/blind';
import { cm360, eDPI } from '../lib/aim';

const router = Router();

interface SetRow {
  id: number; in_game_sens: number; base_dpi: number; created_at: string;
  batch_size: number; cur_rel: number; games_on_stage: number;
  scramble_done: number; resolved: number; revealed_slot: number | null;
  last_click_count: number;
}
interface StageRow { stage_index: number; dpi: number; pct_delta: number; }

const activeSet = (db: ReturnType<typeof getDb>) =>
  db.prepare('SELECT * FROM blind_stage_sets WHERE active = 1').get() as SetRow | undefined;

const stagesOf = (db: ReturnType<typeof getDb>, setId: number) =>
  db.prepare('SELECT stage_index, dpi, pct_delta FROM blind_stages WHERE set_id = :id ORDER BY stage_index')
    .all({ id: setId }) as unknown as StageRow[];

const maskedPending = (db: ReturnType<typeof getDb>) =>
  (db.prepare('SELECT COUNT(*) n FROM matches WHERE blind_trial = 1 AND revealed = 0').get() as { n: number }).n;

// ── Create a set ─────────────────────────────────────────────────────────────
// Shuffles n DPI values across the mouse slots and RETURNS them (in slot order)
// so the player can type them into the mouse. Seeing the values is unavoidable
// and harmless — the blind comes from not knowing your position among them.
router.post('/sets', (req: Request, res: Response) => {
  const db = getDb();
  const in_game_sens = Number(req.body.in_game_sens ?? 2.5);
  const base_dpi = Number(req.body.base_dpi ?? 1600);
  const pct_range = Number(req.body.pct_range ?? 10);
  const n_stages = Number(req.body.n_stages ?? 5);
  const batch_size = Number(req.body.batch_size ?? 6);
  if (!(in_game_sens > 0) || !(base_dpi > 0) || !(n_stages >= 2) || !(batch_size >= 1)) {
    res.status(400).json({ error: 'invalid set params' });
    return;
  }

  const stages = generateStages(base_dpi, pct_range, n_stages);
  db.exec('UPDATE blind_stage_sets SET active = 0 WHERE active = 1');
  const r = db.prepare(`
    INSERT INTO blind_stage_sets (in_game_sens, base_dpi, active, note, batch_size, cur_rel, games_on_stage, scramble_done, resolved)
    VALUES (:s, :d, 1, :note, :b, 0, 0, 0, 0)
  `).run({ s: in_game_sens, d: base_dpi, note: req.body.note ?? null, b: batch_size });
  const set_id = Number(r.lastInsertRowid);
  const ins = db.prepare('INSERT INTO blind_stages (set_id, stage_index, dpi, pct_delta) VALUES (:set_id, :stage_index, :dpi, :pct_delta)');
  for (const st of stages) ins.run({ set_id, ...st });

  // Values returned in slot order for one-time mouse configuration.
  res.json({ set_id, in_game_sens, base_dpi, n_stages, batch_size, stages });
});

// ── Loop state ───────────────────────────────────────────────────────────────
// Drives the whole page. Before scramble it includes the stage values (setup
// needs them); after scramble it never does.
router.get('/state', (_req: Request, res: Response) => {
  const db = getDb();
  const set = activeSet(db);
  if (!set) { res.json({ active: null, pendingReveal: maskedPending(db) }); return; }

  const n_stages = stagesOf(db, set.id).length;
  const body: Record<string, unknown> = {
    active: {
      set_id: set.id, in_game_sens: set.in_game_sens, base_dpi: set.base_dpi, created_at: set.created_at,
      batch_size: set.batch_size, cur_rel: set.cur_rel, games_on_stage: set.games_on_stage,
      last_click_count: set.last_click_count,
      scramble_done: !!set.scramble_done, resolved: !!set.resolved, n_stages,
    },
    needSwitch: !!set.scramble_done && !set.resolved && set.games_on_stage >= set.batch_size,
    pendingReveal: maskedPending(db),
  };
  // Setup values only while un-scrambled, so a page reload can re-show them.
  if (!set.scramble_done) body.stages = stagesOf(db, set.id);
  res.json(body);
});

// ── Blind-start ──────────────────────────────────────────────────────────────
// The player has mashed the DPI button an uncounted number of times; wherever
// they landed is now relative position 0.
router.post('/scramble', (_req: Request, res: Response) => {
  const db = getDb();
  const set = activeSet(db);
  if (!set) { res.status(409).json({ error: 'no active set' }); return; }
  db.prepare('UPDATE blind_stage_sets SET scramble_done = 1, cur_rel = 0, games_on_stage = 0, last_click_count = 0 WHERE id = :id').run({ id: set.id });
  res.json({ ok: true, cur_rel: 0 });
});

// ── Advance to the next stage ────────────────────────────────────────────────
// Picks a new relative position (count-balanced across positions, never the
// current one) and returns the click count to reach it.
router.post('/advance', (_req: Request, res: Response) => {
  const db = getDb();
  const set = activeSet(db);
  if (!set || !set.scramble_done) { res.status(409).json({ error: 'no scrambled active set' }); return; }
  const n = stagesOf(db, set.id).length;

  const counts = new Map<number, number>(Array.from({ length: n }, (_, i) => [i, 0]));
  const used = db.prepare('SELECT rel_pos, COUNT(*) c FROM matches WHERE blind_set_id = :id AND rel_pos IS NOT NULL GROUP BY rel_pos')
    .all({ id: set.id }) as { rel_pos: number; c: number }[];
  for (const u of used) counts.set(u.rel_pos, u.c);

  const candidates = [...counts.entries()].filter(([pos]) => pos !== set.cur_rel);
  const min = Math.min(...candidates.map(([, c]) => c));
  const pool = candidates.filter(([, c]) => c === min).map(([pos]) => pos);
  const next = pool[Math.floor(Math.random() * pool.length)];
  const click_count = clicksBetween(set.cur_rel, next, n);

  db.prepare('UPDATE blind_stage_sets SET cur_rel = :next, games_on_stage = 0, last_click_count = :cc WHERE id = :id').run({ next, cc: click_count, id: set.id });
  res.json({ click_count, cur_rel: next, n_stages: n });
});

// ── Reveal ───────────────────────────────────────────────────────────────────
// The player reports the currently-active slot (1-indexed, read from the mouse
// software). We back-solve the offset and resolve every trial's true dpi/sens.
router.post('/reveal', (req: Request, res: Response) => {
  const db = getDb();
  const set = activeSet(db);
  if (!set || !set.scramble_done) { res.status(409).json({ error: 'no scrambled active set' }); return; }
  const stages = stagesOf(db, set.id);
  const n = stages.length;
  const currentSlot = Number(req.body.current_slot);
  if (!(currentSlot >= 1 && currentSlot <= n)) { res.status(400).json({ error: `current_slot must be 1..${n}` }); return; }

  const offset = offsetFromReveal(currentSlot, set.cur_rel, n);
  const dpiBySlot = new Map(stages.map(s => [s.stage_index, s.dpi]));

  const trials = db.prepare('SELECT id, rel_pos FROM matches WHERE blind_set_id = :id AND blind_trial = 1 AND rel_pos IS NOT NULL')
    .all({ id: set.id }) as { id: number; rel_pos: number }[];
  const upd = db.prepare('UPDATE matches SET stage_index = :slot, dpi = :dpi, sens = :sens, revealed = 1 WHERE id = :mid');
  for (const t of trials) {
    const slot = absoluteSlot(t.rel_pos, offset, n);
    upd.run({ slot, dpi: dpiBySlot.get(slot) ?? null, sens: set.in_game_sens, mid: t.id });
  }
  db.prepare('UPDATE blind_stage_sets SET resolved = 1, revealed_slot = :cs WHERE id = :id').run({ cs: currentSlot, id: set.id });

  res.json({ ok: true, resolved: trials.length, set_id: set.id });
});

// ── Answer key + per-stage feel consistency (post-reveal) ────────────────────
router.get('/sets/:id', (req: Request, res: Response) => {
  const db = getDb();
  const set = db.prepare('SELECT id, in_game_sens, base_dpi, created_at, active, resolved, revealed_slot FROM blind_stage_sets WHERE id = :id')
    .get({ id: req.params.id }) as (SetRow & { active: number }) | undefined;
  if (!set) { res.status(404).json({ error: 'set not found' }); return; }
  const stages = stagesOf(db, set.id);

  const rows = stages.map(st => {
    const trials = db.prepare(`
      SELECT a.feel FROM matches m LEFT JOIN aim_stats a ON a.match_id = m.id
      WHERE m.blind_set_id = :sid AND m.stage_index = :si
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
      created_at: set.created_at, active: !!set.active, resolved: !!set.resolved, revealed_slot: set.revealed_slot,
    },
    stages: rows,
  });
});

export default router;
