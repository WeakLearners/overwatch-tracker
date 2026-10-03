import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';
import { getCurveParams, setCurveParams } from '../lib/curveParams';
import { saveAimStatsRows } from '../lib/aimStatsWrite';

// Tracker side of the aim routes (split plan B3): everything that WRITES.
// Must not import from aimAnalysis.ts or lib/aim.ts (see aimBoundary.test.ts).
const router = Router();


// Updates the live curve params — takes effect on the next match logged, not
// retroactive (existing matches keep whatever was stamped at the time, same
// as dpi/sens history). Smooth is a 0-1 softening factor (0 = instant snap);
// Input is the threshold speed in counts/ms (>0); Output is the above-
// threshold multiplier (>=1, since <1 would mean acceleration slows you down).
// lutSteps/lutMaxSpeed/lutPoints describe the LUT built from that shape —
// steps an integer 2-32, maxSpeed > 0, points (when present) exactly `steps`
// numeric [x, y] pairs.
//
// The stage-test lock that used to sit here was removed 2026-09-20 when Sean
// moved his real Rawaccel config from the Jump curve to a Look Up Table. The
// lock existed because smooth/input/output WERE the live config, and editing
// them mid-test would silently confound whatever the test was measuring
// (see the 2026-09-17 finding: curve_enabled=1 had pooled three different
// live settings as one treatment because this exact thing happened). Now
// that the LUT is the real config and these three fields are just the shape
// its points get seeded from, editing them no longer changes what any match
// actually ran under — so there's nothing left for the lock to protect.
router.put('/curve', (req: Request, res: Response) => {
  const db = getDb();
  const smooth = Number(req.body.smooth);
  const input = Number(req.body.input);
  const output = Number(req.body.output);
  if (!(smooth >= 0 && smooth <= 1) || !(input > 0) || !(output >= 1)) {
    res.status(400).json({ error: 'invalid curve params (smooth 0-1, input > 0, output >= 1)' });
    return;
  }
  const lutSteps = Number(req.body.lutSteps);
  const lutMaxSpeed = Number(req.body.lutMaxSpeed);
  if (!Number.isInteger(lutSteps) || lutSteps < 2 || lutSteps > 32) {
    res.status(400).json({ error: 'lutSteps must be an integer 2-32' });
    return;
  }
  if (!(lutMaxSpeed > 0)) {
    res.status(400).json({ error: 'lutMaxSpeed must be > 0' });
    return;
  }
  let lutPoints: [number, number][] | null = null;
  if (req.body.lutPoints != null) {
    const pts = req.body.lutPoints;
    const valid = Array.isArray(pts) && pts.length === lutSteps &&
      pts.every((p: unknown) => Array.isArray(p) && p.length === 2 && p.every(n => typeof n === 'number' && Number.isFinite(n)));
    if (!valid) {
      res.status(400).json({ error: `lutPoints must be an array of exactly ${lutSteps} numeric [x, y] pairs` });
      return;
    }
    lutPoints = pts as [number, number][];
  }
  setCurveParams(db, { smooth, input, output, lutSteps, lutMaxSpeed, lutPoints });
  res.json(getCurveParams(db));
});

// Upsert aim stats for a match. match_id is the PK, so re-submitting the same
// match corrects a prior entry rather than erroring. Accuracy AND duration are
// per hero played (heroes[]) — see aim_stats_heroes in schema.ts; everything
// else here (combat totals) stays one match-level scoreboard entry.
// aim_stats.duration_min is kept as the sum of the per-hero durations, since
// the match-total rate stats (damage/elims/final_blows per 10 min) still
// operate on the whole match, not a single hero within it.
// final_blows is intentionally left out of both the insert and the update —
// the form stopped collecting it, and leaving it out of the UPDATE SET
// (rather than sending null) keeps any already-saved value on old rows intact.
router.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const { match_id, heroes, elims, deaths, damage, healing, assists } = req.body;

  if (match_id === undefined || match_id === null) {
    res.status(400).json({ error: 'match_id required' });
    return;
  }
  const match = db.prepare('SELECT id, crashed FROM matches WHERE id = :id').get({ id: match_id }) as { id: number; crashed: number } | undefined;
  if (!match) {
    res.status(404).json({ error: 'match not found' });
    return;
  }
  if (match.crashed) {
    res.status(400).json({ error: 'match crashed: result-only, takes no scoreboard stats' });
    return;
  }

  db.exec('BEGIN');
  try {
    saveAimStatsRows(db, match_id, { heroes, elims, deaths, damage, healing, assists });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  res.json({ ok: true });
});


export default router;
