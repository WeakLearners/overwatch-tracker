import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';
import { controlArmState, setControlArm } from '../lib/controlArm';

// Comp control arm settings and progress (Sens page card). Tracker-side.
const router = Router();

router.get('/', (_req: Request, res: Response) => {
  res.json(controlArmState(getDb()));
});

// Body: { on: boolean, sens?: number }. sens is the in-game sens; DPI stays locked.
router.put('/', (req: Request, res: Response) => {
  const db = getDb();
  const { on, sens } = req.body ?? {};
  if (typeof on !== 'boolean') { res.status(400).json({ error: 'on must be true or false' }); return; }
  if (sens !== undefined && sens !== null && typeof sens !== 'number') { res.status(400).json({ error: 'sens must be a number' }); return; }
  const err = setControlArm(db, { on, sens: sens === null ? undefined : sens });
  if (err) { res.status(400).json({ error: err }); return; }
  res.json(controlArmState(db));
});

export default router;
