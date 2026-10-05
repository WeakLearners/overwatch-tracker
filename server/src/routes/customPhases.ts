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

// ── Delete a custom phase (tab/plan definition only — any test sets already
// created from it stay as-is, same as the old localStorage behavior). ───────
router.delete('/:key', (req: Request, res: Response) => {
  const db = getDb();
  db.prepare('DELETE FROM custom_phases WHERE key = :key').run({ key: req.params.key });
  res.json({ ok: true });
});

export default router;
