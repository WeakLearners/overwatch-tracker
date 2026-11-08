import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';
import { trialState, startTrial, endTrial } from '../lib/heroFocus';

// Hero focus trial (Dashboard card, Prematch strip, Log Match hold). Tracker-side.
// There is no route that edits a roster: the server picks it at start and it is locked.
const router = Router();

router.get('/', (_req: Request, res: Response) => { res.json(trialState(getDb())); });

router.post('/start', (_req: Request, res: Response) => {
  const db = getDb();
  const r = startTrial(db);
  if ('error' in r) { res.status(409).json({ error: r.error }); return; }
  res.json(trialState(db));
});

// Body: { reason: string }. The reason is required and the end is logged.
router.post('/end', (req: Request, res: Response) => {
  const db = getDb();
  const r = endTrial(db, req.body?.reason);
  if ('error' in r) { res.status(400).json({ error: r.error }); return; }
  res.json(trialState(db));
});

export default router;
