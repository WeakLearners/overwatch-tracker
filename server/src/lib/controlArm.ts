import type { getDb } from '../db/schema';
import { getSetting, setSetting } from './appSettings';
import { LOCKED_DPI } from './blind';
import { NOT_QP_SQL } from './queueMode';

// Comp control arm (play-trial item 2, 2026-11-08). While it is on, a competitive
// match is played at ONE game-wide home sens for every hero. It saves with
// matches.sens_kind = 'home', blind_trial = 0 and no blind_credits row, so it never
// counts as a trial. A QP match is saved the same way while the arm is on (Sean
// 2026-11-14), but it never counts toward the arm or the fit (lib/queueMode.ts).
// Off restores the normal behaviour.
type Db = ReturnType<typeof getDb>;

// Play minutes, same unit as the sens study (Sean 2026-11-08). 1620 min is about 150 matches at
// 10.8 min, so the power estimate is unchanged. Minutes come from aim_stats_heroes.duration_min
// (every hero row of the match, NULL = 0); a match with no aim stats row counts 0 until the Aim
// Stats form is saved.
export const CONTROL_ARM_TARGET = 1620;
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

/** Comp play minutes saved as home sens, plus the matches still waiting for Aim Stats. A home match later edited to QP stops counting; crashed records never do. */
export function controlArmProgress(db: Db): { minutes: number; waiting: number } {
  const row = db.prepare(`
    SELECT COALESCE(SUM((SELECT SUM(COALESCE(ah.duration_min, 0)) FROM aim_stats_heroes ah WHERE ah.match_id = m.id)), 0) AS minutes,
           COALESCE(SUM(CASE WHEN NOT EXISTS (SELECT 1 FROM aim_stats_heroes x WHERE x.match_id = m.id) THEN 1 ELSE 0 END), 0) AS waiting
    FROM matches m WHERE m.sens_kind = 'home' AND m.crashed = 0 AND ${NOT_QP_SQL}
  `).get() as { minutes: number; waiting: number };
  return { minutes: Math.round(Number(row.minutes) * 10) / 10, waiting: Number(row.waiting) };
}

export function controlArmState(db: Db) {
  const arm = getControlArm(db);
  const { minutes, waiting } = controlArmProgress(db);
  return { ...arm, minutes, waiting, target: CONTROL_ARM_TARGET };
}
