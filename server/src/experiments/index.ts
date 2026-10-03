import { setExperimentHooks } from '../lib/experimentHooks';
import { experimentController } from './controller';

export { applyPlayTimeCredit } from './controller';

// Installs the sensitivity-study controller behind the tracker's hooks.
// EXPERIMENTS_DISABLED=1 leaves the no-op in place: matches save, no stage
// is assigned, no credit is written.
export function installExperiments(): boolean {
  if (process.env.EXPERIMENTS_DISABLED === '1') { setExperimentHooks(); return false; }
  setExperimentHooks(experimentController);
  return true;
}
