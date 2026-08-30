import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';

const router = Router();

interface CustomPhaseRow { key: string; label: string; description: string; plan: string; created_at: string; }

// ── List all custom phases, oldest first (same order they were created —
// SensLog.tsx appends new ones to the end of the tab row). ──────────────────
router.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM custom_phases ORDER BY created_at, key').all() as unknown as CustomPhaseRow[];
  res.json({ phases: rows.map(r => ({ key: r.key, label: r.label, description: r.description, plan: JSON.parse(r.plan) })) });
});

// ── Create a custom phase ────────────────────────────────────────────────────
router.post('/', (req: Request, res: Response) => {
  const { key, label, description, plan } = req.body as { key?: string; label?: string; description?: string; plan?: unknown };
  if (!key || !label || !description || !Array.isArray(plan)) {
    res.status(400).json({ error: 'key, label, description, and plan (array) are required' });
    return;
  }
  const db = getDb();
  db.prepare('INSERT INTO custom_phases (key, label, description, plan) VALUES (:key, :label, :description, :plan)')
    .run({ key, label, description, plan: JSON.stringify(plan) });
  res.status(201).json({ ok: true });
});

// ── Delete a custom phase (tab/plan definition only — any test sets already
// created from it stay as-is, same as the old localStorage behavior). ───────
router.delete('/:key', (req: Request, res: Response) => {
  const db = getDb();
  db.prepare('DELETE FROM custom_phases WHERE key = :key').run({ key: req.params.key });
  res.json({ ok: true });
});

export default router;
