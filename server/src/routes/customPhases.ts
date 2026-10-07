import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';

const router = Router();

interface CustomPhaseRow { key: string; label: string; description: string; plan: string; curve_enabled: number; created_at: string; }

// ── List all custom phases, oldest first (same order they were created —
// SensLog.tsx appends new ones to the end of the tab row). ──────────────────
router.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM custom_phases ORDER BY created_at, key').all() as unknown as CustomPhaseRow[];
  res.json({ phases: rows.map(r => ({ key: r.key, label: r.label, description: r.description, plan: JSON.parse(r.plan), curveEnabled: !!r.curve_enabled })) });
});

// ── Create a custom phase ────────────────────────────────────────────────────
router.post('/', (req: Request, res: Response) => {
  const { key, label, description, plan, curveEnabled } = req.body as { key?: string; label?: string; description?: string; plan?: unknown; curveEnabled?: boolean };
  if (!key || !label || !description || !Array.isArray(plan)) {
    res.status(400).json({ error: 'key, label, description, and plan (array) are required' });
    return;
  }
  const db = getDb();
  db.prepare('INSERT INTO custom_phases (key, label, description, plan, curve_enabled) VALUES (:key, :label, :description, :plan, :curve_enabled)')
    .run({ key, label, description, plan: JSON.stringify(plan), curve_enabled: curveEnabled ? 1 : 0 });
  res.status(201).json({ ok: true });
});

// ── Update a custom phase's plan/description in place (e.g. recomputing
// brackets after a rule change like the MIN_SENS floor removal). Any test
// sets already created from the old plan stay as-is — this only edits the
// phase definition itself, not history. ─────────────────────────────────────
router.patch('/:key', (req: Request, res: Response) => {
  const { plan, description } = req.body as { plan?: unknown; description?: string };
  if (plan === undefined && description === undefined) {
    res.status(400).json({ error: 'at least one of plan or description is required' });
    return;
  }
  const db = getDb();
  const existing = db.prepare('SELECT * FROM custom_phases WHERE key = :key').get({ key: req.params.key }) as unknown as CustomPhaseRow | undefined;
  if (!existing) {
    res.status(404).json({ error: 'no custom phase with that key' });
    return;
  }
  const nextPlan = plan !== undefined ? JSON.stringify(plan) : existing.plan;
  const nextDescription = description !== undefined ? description : existing.description;
  db.prepare('UPDATE custom_phases SET plan = :plan, description = :description WHERE key = :key')
    .run({ key: req.params.key, plan: nextPlan, description: nextDescription });
  res.json({ ok: true });
});

// Phases from Phase 11 (custom-1790013747540) on use the minutes model: 8 blocks
// of 60 min per stage. Mirrors MINUTES_CUTOVER_TS in client SensLog.tsx.
const MINUTES_CUTOVER_TS = 1790013747540;
const STAGE_MINUTES = 8 * 60;
const isMinutesPhase = (key: string) => key.startsWith('custom-') && Number(key.slice(7)) >= MINUTES_CUTOVER_TS;

// ── Append one hero to the END of a custom phase's plan (plan order is rank
// order, so the new hero is lowest priority in its role). gamesPerSlot is
// optional: a new hero copies the phase's first hero (same block length as the
// rest of the phase). Rewrites the "N heroes × S stages, G games total." lead
// of the description to match (minutes for a minutes-model phase); any
// trailing text (e.g. the mouse-accel note) is kept. ────────────────────────
router.post('/:key/heroes', (req: Request, res: Response) => {
  const h = req.body as { hero?: string; archetype?: string; gamesPerSlot?: number; note?: string; senses?: unknown };
  const senses = h.senses;
  if (!h.hero || typeof h.hero !== 'string' || !Array.isArray(senses) || senses.length < 2
    || !senses.every(v => typeof v === 'number' && Number.isFinite(v) && v > 0)
    || (h.gamesPerSlot !== undefined && !(Number.isInteger(h.gamesPerSlot) && (h.gamesPerSlot as number) >= 1))) {
    res.status(400).json({ error: 'hero and senses (>=2 positive numbers) are required; gamesPerSlot, if given, must be an integer >= 1' });
    return;
  }
  if (!(senses[0] < senses[senses.length - 1])) {
    res.status(400).json({ error: 'low sens must be less than high sens' });
    return;
  }
  const db = getDb();
  const existing = db.prepare('SELECT * FROM custom_phases WHERE key = :key').get({ key: req.params.key }) as unknown as CustomPhaseRow | undefined;
  if (!existing) {
    res.status(404).json({ error: 'no custom phase with that key' });
    return;
  }
  const plan = JSON.parse(existing.plan) as Array<{ hero: string; gamesPerSlot: number; senses?: number[]; dpis?: number[] }>;
  if (plan.some(p => p.hero === h.hero)) {
    res.status(409).json({ error: 'hero is already in this phase' });
    return;
  }
  plan.push({ hero: h.hero, archetype: h.archetype || 'Unknown', gamesPerSlot: h.gamesPerSlot ?? plan[0]?.gamesPerSlot ?? 40, note: h.note ?? '', senses } as never);
  const stageCount = (p: { senses?: number[]; dpis?: number[] }) => (p.senses ?? p.dpis ?? []).length;
  const total = isMinutesPhase(req.params.key)
    ? `${plan.reduce((sum, p) => sum + stageCount(p) * STAGE_MINUTES, 0)} min`
    : `${plan.reduce((sum, p) => sum + stageCount(p) * p.gamesPerSlot, 0)} games`;
  const lead = `${plan.length} heroes × ${stageCount(plan[0])} stages, ${total} total.`;
  const description = existing.description.replace(/^\d+ heroes [x×] \d+ stages, \d+ (?:games|min) total\./, lead);
  db.prepare('UPDATE custom_phases SET plan = :plan, description = :description WHERE key = :key')
    .run({ key: req.params.key, plan: JSON.stringify(plan), description });
  res.status(201).json({ ok: true, description });
});

// ── Edit one hero entry of a custom phase. Hero, senses and dpis are the test
// definition: once ANY test set exists for the hero in this phase (testing,
// paused or completed), changing them would put the study data under a bracket
// it was not collected at, so the route answers 409. archetype and note are
// labels and stay editable. gamesPerSlot and the stage count never change here,
// so the description's totals stay correct. ────────────────────────────────
router.patch('/:key/heroes/:hero', (req: Request, res: Response) => {
  const b = req.body as { hero?: unknown; archetype?: unknown; note?: unknown; senses?: unknown };
  const db = getDb();
  const existing = db.prepare('SELECT * FROM custom_phases WHERE key = :key').get({ key: req.params.key }) as unknown as CustomPhaseRow | undefined;
  if (!existing) {
    res.status(404).json({ error: 'no custom phase with that key' });
    return;
  }
  const plan = JSON.parse(existing.plan) as Array<{ hero: string; archetype: string; note: string; gamesPerSlot: number; senses?: number[]; dpis?: number[] }>;
  const idx = plan.findIndex(p => p.hero === req.params.hero);
  if (idx < 0) {
    res.status(404).json({ error: 'hero is not in this phase' });
    return;
  }
  const cur = plan[idx];
  if ((b.archetype !== undefined && typeof b.archetype !== 'string') || (b.note !== undefined && typeof b.note !== 'string')
    || (b.hero !== undefined && (typeof b.hero !== 'string' || !b.hero.trim()))) {
    res.status(400).json({ error: 'hero, archetype and note must be strings (hero not empty)' });
    return;
  }
  const heroChanged = b.hero !== undefined && b.hero !== cur.hero;
  let sensChanged = false;
  let nextSenses: number[] | undefined;
  if (b.senses !== undefined) {
    const sn = b.senses;
    if (!cur.senses) {
      res.status(400).json({ error: 'this hero uses dpis, not senses; its bracket cannot be edited here' });
      return;
    }
    if (!Array.isArray(sn) || sn.length !== cur.senses.length || !sn.every(v => typeof v === 'number' && Number.isFinite(v) && v > 0)) {
      res.status(400).json({ error: `senses must be ${cur.senses.length} positive numbers (the stage count does not change)` });
      return;
    }
    if (!(sn[0] < sn[sn.length - 1])) {
      res.status(400).json({ error: 'low sens must be less than high sens' });
      return;
    }
    nextSenses = sn as number[];
    sensChanged = nextSenses.some((v, i) => Math.abs(v - cur.senses![i]) > 1e-9);
  }
  if (heroChanged || sensChanged) {
    const locked = db.prepare('SELECT id FROM blind_stage_sets WHERE hero = :hero AND phase IS :phase LIMIT 1')
      .get({ hero: cur.hero, phase: req.params.key });
    if (locked) {
      res.status(409).json({ error: 'a test set exists for this hero in this phase; only archetype and note can change' });
      return;
    }
    if (heroChanged && plan.some(p => p.hero === b.hero)) {
      res.status(409).json({ error: 'hero is already in this phase' });
      return;
    }
  }
  if (heroChanged) cur.hero = (b.hero as string).trim();
  if (sensChanged && nextSenses) cur.senses = nextSenses;
  if (b.archetype !== undefined) cur.archetype = (b.archetype as string).trim() || 'Unknown';
  if (b.note !== undefined) cur.note = (b.note as string).trim();
  db.prepare('UPDATE custom_phases SET plan = :plan WHERE key = :key')
    .run({ key: req.params.key, plan: JSON.stringify(plan) });
  res.json({ ok: true, hero: cur });
});

// ── Delete a custom phase (tab/plan definition only — any test sets already
// created from it stay as-is, same as the old localStorage behavior). ───────
router.delete('/:key', (req: Request, res: Response) => {
  const db = getDb();
  db.prepare('DELETE FROM custom_phases WHERE key = :key').run({ key: req.params.key });
  res.json({ ok: true });
});

export default router;
