// Rawaccel Jump-curve settings, editable from the "Mouse acceleration curve"
// card on the testing page instead of being hardcoded — Sean's real Rawaccel
// config can drift over time as he retunes it, so the app should reflect
// whatever he's actually running rather than a frozen snapshot.
import { getDb } from '../db/schema';

export const DEFAULT_CURVE_SMOOTH = 0.2;
export const DEFAULT_CURVE_INPUT = 14; // counts/ms — the threshold speed
export const DEFAULT_CURVE_OUTPUT = 1.5; // multiplier applied above the threshold

export interface CurveParams { smooth: number; input: number; output: number }

// Falls back to the defaults above when curve_params has no row yet (fresh
// install, or the DB predates this table).
export function getCurveParams(db: ReturnType<typeof getDb>): CurveParams {
  const row = db.prepare('SELECT smooth, input, output FROM curve_params WHERE id = 1').get() as CurveParams | undefined;
  return row ?? { smooth: DEFAULT_CURVE_SMOOTH, input: DEFAULT_CURVE_INPUT, output: DEFAULT_CURVE_OUTPUT };
}

export function setCurveParams(db: ReturnType<typeof getDb>, params: CurveParams): void {
  db.prepare(`
    INSERT INTO curve_params (id, smooth, input, output) VALUES (1, :smooth, :input, :output)
    ON CONFLICT(id) DO UPDATE SET smooth = :smooth, input = :input, output = :output
  `).run({ smooth: params.smooth, input: params.input, output: params.output });
}
