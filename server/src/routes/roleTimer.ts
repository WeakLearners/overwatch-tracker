import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';
import { computeRoleTimers, RoleTimerMatch } from '../lib/roleTimer';

const router = Router();

// Read-only. Competitive matches newest first, each with its per-hero Aim Stats
// minutes (hero role from match_heroes, falling back to matches.role when the
// match has no match_heroes row), plus the average per-match minutes across every
// match that has any: the estimate stand-in for matches without minutes yet.
router.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const matches = db.prepare(`
    SELECT m.id, m.date, m.role, m.queue_mode
    FROM matches m
    WHERE m.queue_mode LIKE 'comp%'
    ORDER BY m.date DESC, m.time DESC, m.id DESC
  `).all() as unknown as (RoleTimerMatch & { id: number })[];
  const heroRows = db.prepare(`
    SELECT h.match_id, COALESCE(mh.role, m.role) AS role, h.duration_min
    FROM aim_stats_heroes h
    JOIN matches m ON m.id = h.match_id
    LEFT JOIN match_heroes mh ON mh.match_id = h.match_id AND mh.hero = h.hero
    WHERE m.queue_mode LIKE 'comp%' AND h.duration_min IS NOT NULL
  `).all() as unknown as { match_id: number; role: string; duration_min: number }[];
  const byMatch = new Map<number, { role: string; duration_min: number }[]>();
  for (const r of heroRows) {
    const list = byMatch.get(r.match_id) ?? [];
    list.push({ role: r.role, duration_min: r.duration_min });
    byMatch.set(r.match_id, list);
  }
  for (const m of matches) m.heroes = byMatch.get(m.id) ?? null;
  const avg = db.prepare(`
    SELECT AVG(s) AS avg FROM (
      SELECT SUM(duration_min) AS s FROM aim_stats_heroes WHERE duration_min IS NOT NULL GROUP BY match_id
    )
  `).get() as unknown as { avg: number | null };
  res.json(computeRoleTimers(matches, avg.avg ?? 0));
});

export default router;
