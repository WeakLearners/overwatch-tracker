import { Router } from 'express';
import ingest from './aimIngest';
import analysis from './aimAnalysis';

// Composition only. Both halves keep their original /api/aim/* URLs. Stage 2
// mounts them separately, one per repo, and this file goes away.
export { computeAnalysis, MIN_SCALE_N } from './aimAnalysis';

const router = Router();
router.use(ingest);
router.use(analysis);
export default router;
