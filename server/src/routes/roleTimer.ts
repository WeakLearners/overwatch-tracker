import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';
import { computeRoleTimer, RoleTimerMatch } from '../lib/roleTimer';

const router = Router();

// Read-only. Competitive matches newest first, each with its summed per-hero
// minutes (NULL when Aim Stats hasn't been entered yet), plus the average
// per-match minutes across every match that has any — the estimate stand-in.
router.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const matches = db.prepare(`
    SELECT m.date, m.role, m.queue_mode,
      (SELECT SUM(h.duration_min) FROM aim_stats_heroes h WHERE h.match_id = m.id) AS minutes
    FROM matches m
    WHERE m.queue_mode LIKE 'comp%'
    ORDER BY m.date DESC, m.time DESC, m.id DESC
  `).all() as unknown as RoleTimerMatch[];
  const avg = db.prepare(`
    SELECT AVG(s) AS avg FROM (
      SELECT SUM(duration_min) AS s FROM aim_stats_heroes WHERE duration_min IS NOT NULL GROUP BY match_id
    )
  `).get() as unknown as { avg: number | null };
  res.json(computeRoleTimer(matches, avg.avg ?? 0));
});

export default router;
