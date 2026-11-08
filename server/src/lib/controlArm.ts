import type { getDb } from '../db/schema';
import { getSetting, setSetting } from './appSettings';
import { LOCKED_DPI } from './blind';
import { NOT_QP_SQL } from './queueMode';

// Comp control arm (play-trial item 2, 2026-11-08). While it is on, a competitive
// match is played at ONE game-wide home sens for every hero. It saves with
// matches.sens_kind = 'home', blind_trial = 0 and no blind_credits row, so it never
// counts as a trial. The blind trial keeps assigning stage sens to QP matches, which
// never earn a credit (lib/queueMode.ts). Off restores the normal behaviour.
type Db = ReturnType<typeof getDb>;

export const CONTROL_ARM_TARGET = 150;
const KEY_ON = 'control_arm_on';
const KEY_SENS = 'control_arm_sens';

export interface ControlArm { on: boolean; sens: number | null; dpi: number }

export function getControlArm(db: Db): ControlArm {
  const sens = Number(getSetting(db, KEY_SENS));
  return { on: getSetting(db, KEY_ON) === '1', sens: sens > 0 ? sens : null, dpi: LOCKED_DPI };
}

export function setControlArm(db: Db, input: { on: boolean; sens?: number | null }): string | null {
  const cur = getControlArm(db);
  const sens = input.sens === undefined ? cur.sens : input.sens;
  if (sens != null && !(typeof sens === 'number' && sens > 0 && sens <= 100)) return 'sens must be a number above 0 and at most 100';
  if (input.on && sens == null) return 'set the home sens before turning the arm on';
  if (sens != null) setSetting(db, KEY_SENS, String(sens));
  setSetting(db, KEY_ON, input.on ? '1' : '0');
  return null;
}

/** Comp matches saved as home sens. A home match later edited to QP stops counting; crashed records never do. */
export function controlArmCount(db: Db): number {
  const row = db.prepare(`SELECT COUNT(*) n FROM matches m WHERE m.sens_kind = 'home' AND m.crashed = 0 AND ${NOT_QP_SQL}`).get() as { n: number };
  return Number(row.n);
}

export function controlArmState(db: Db) {
  const arm = getControlArm(db);
  return { ...arm, n: controlArmCount(db), target: CONTROL_ARM_TARGET };
}
