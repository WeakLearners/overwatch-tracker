import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';
import { getDfHeroes } from '../lib/df';

const router = Router();

// GET /api/df — every role's Designated Fallback hero, as { DPS: { hero,
// sens }, ... }. A role with no row simply has no key — same "absence is the
// signal" convention player_ranks uses for an unset ladder. Every surface
// that needs to know "is X the fallback" or "what's the fallback's sens"
// reads this instead of hardcoding Soldier: 76, so a future DF change (a
// different hero, a different role) is a data change, not a code change.
router.get('/', (_req: Request, res: Response) => {
  const rows = getDfHeroes(getDb());
  const out: Record<string, { hero: string; sens: number }> = {};
  for (const r of rows) out[r.role] = { hero: r.hero, sens: r.sens };
  res.json(out);
});

// PUT /api/df — set or clear a role's DF. hero: null clears the role's DF
// entirely (row deleted) rather than being stored as a null hero, since a
// DF row with no hero name is meaningless — mirrors player_ranks' "delete
// vs. null" choice being made explicit here instead.
router.put('/', (req: Request, res: Response) => {
  const role = typeof req.body.role === 'string' ? req.body.role.trim() : '';
  if (!role) {
    res.status(400).json({ error: 'role is required' });
    return;
  }
  const db = getDb();
  if (req.body.hero == null) {
    db.prepare('DELETE FROM df_heroes WHERE role = :role').run({ role });
    res.json({ role, hero: null, sens: null });
    return;
  }
  const hero = typeof req.body.hero === 'string' ? req.body.hero.trim() : '';
  const sens = Number(req.body.sens);
  if (!hero || !(sens > 0)) {
    res.status(400).json({ error: 'hero and a positive sens are required' });
    return;
  }
  db.prepare(`
    INSERT INTO df_heroes (role, hero, sens) VALUES (:role, :hero, :sens)
    ON CONFLICT(role) DO UPDATE SET hero = :hero, sens = :sens
  `).run({ role, hero, sens });
  res.json({ role, hero, sens });
});

export default router;
