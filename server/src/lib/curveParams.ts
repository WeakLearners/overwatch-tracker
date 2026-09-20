// Rawaccel curve settings, editable from the "Rawaccel LUT" card on the
// testing page instead of being hardcoded — Sean's real Rawaccel config can
// drift over time as he retunes it, so the app should reflect whatever he's
// actually running rather than a frozen snapshot.
//
// smooth/input/output are the old Jump-curve params. Since 2026-09-20 they no
// longer describe Sean's live config (he moved to a Look Up Table) — they're
// kept only as the SHAPE the LUT's points get seeded from (see SensLog.tsx's
// seedLutPoints). lutSteps/lutMaxSpeed/lutPoints describe the LUT itself.
import { getDb } from '../db/schema';

export const DEFAULT_CURVE_SMOOTH = 0.2;
export const DEFAULT_CURVE_INPUT = 14; // counts/ms — the threshold speed
export const DEFAULT_CURVE_OUTPUT = 1.5; // multiplier applied above the threshold

export const DEFAULT_LUT_STEPS = 8;
export const DEFAULT_LUT_MAX_SPEED = 40; // counts/ms

export interface CurveParams {
  smooth: number; input: number; output: number;
  lutSteps: number | null; lutMaxSpeed: number | null; lutPoints: [number, number][] | null;
}

// Falls back to the defaults above when curve_params has no row yet (fresh
// install, or the DB predates this table). lutPoints stays null when absent
// (rather than defaulting to something) — that's the card's "not yet
// hand-edited, seed me" signal, same as lutSteps/lutMaxSpeed falling back to
// DEFAULT_LUT_STEPS/DEFAULT_LUT_MAX_SPEED for the seed math itself.
export function getCurveParams(db: ReturnType<typeof getDb>): CurveParams {
  const row = db.prepare('SELECT smooth, input, output, lut_steps, lut_max_speed, lut_points FROM curve_params WHERE id = 1')
    .get() as { smooth: number; input: number; output: number; lut_steps: number | null; lut_max_speed: number | null; lut_points: string | null } | undefined;
  if (!row) {
    return {
      smooth: DEFAULT_CURVE_SMOOTH, input: DEFAULT_CURVE_INPUT, output: DEFAULT_CURVE_OUTPUT,
      lutSteps: DEFAULT_LUT_STEPS, lutMaxSpeed: DEFAULT_LUT_MAX_SPEED, lutPoints: null,
    };
  }
  return {
    smooth: row.smooth, input: row.input, output: row.output,
    lutSteps: row.lut_steps ?? DEFAULT_LUT_STEPS,
    lutMaxSpeed: row.lut_max_speed ?? DEFAULT_LUT_MAX_SPEED,
    lutPoints: row.lut_points ? JSON.parse(row.lut_points) : null,
  };
}

export function setCurveParams(db: ReturnType<typeof getDb>, params: CurveParams): void {
  db.prepare(`
    INSERT INTO curve_params (id, smooth, input, output, lut_steps, lut_max_speed, lut_points)
    VALUES (1, :smooth, :input, :output, :lutSteps, :lutMaxSpeed, :lutPoints)
    ON CONFLICT(id) DO UPDATE SET smooth = :smooth, input = :input, output = :output,
      lut_steps = :lutSteps, lut_max_speed = :lutMaxSpeed, lut_points = :lutPoints
  `).run({
    smooth: params.smooth, input: params.input, output: params.output,
    lutSteps: params.lutSteps, lutMaxSpeed: params.lutMaxSpeed,
    lutPoints: params.lutPoints ? JSON.stringify(params.lutPoints) : null,
  });
}
