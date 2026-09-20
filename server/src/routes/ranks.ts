import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';

const router = Router();

// The current rank of every ladder, as one server-side fact.
//
// Rank used to live in the browser's localStorage, one key per account+role.
// That worked while one page owned it. It stopped working the moment a second
// surface wanted to change it: the Pre-Match drum and the log page's
// promote/demote row would each hold their own copy, and whichever rendered
// last would look right. A rank badge that disagrees with the rank being
// written onto a match is worse than no badge.
//
// One row per ladder, rank nullable so "not set yet" stays distinct from any
// real rank. Account may be absent on old data, so the empty string stands
// for "no account", matching the drum key the dashboard already uses.

export type RankMap = Record<string, number>;

const KEY = (account: string, role: string) => `${account}|${role}`;

router.get('/', (_req: Request, res: Response) => {
  const rows = getDb().prepare('SELECT account, role, rank FROM player_ranks WHERE rank IS NOT NULL')
    .all() as { account: string; role: string; rank: number }[];
  const out: RankMap = {};
  for (const r of rows) out[KEY(r.account, r.role)] = r.rank;
  res.json(out);
});

// Upsert one ladder. rank null clears it, which is how a slot goes back to
// "not set" without deleting the row and losing the fact it was ever used.
router.put('/', (req: Request, res: Response) => {
  const account = typeof req.body.account === 'string' ? req.body.account : '';
  const role = typeof req.body.role === 'string' ? req.body.role : '';
  if (!role) {
    res.status(400).json({ error: 'role is required' });
    return;
  }
  const raw = req.body.rank;
  let rank: number | null = null;
  if (raw != null) {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 45) {
      res.status(400).json({ error: 'rank must be an integer 1-45, or null to clear' });
      return;
    }
    rank = n;
  }
  getDb().prepare(`
    INSERT INTO player_ranks (account, role, rank) VALUES (:account, :role, :rank)
    ON CONFLICT(account, role) DO UPDATE SET rank = :rank
  `).run({ account, role, rank });
  res.json({ account, role, rank });
});

export default router;
