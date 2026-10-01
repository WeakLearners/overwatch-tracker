// Role timer: how long Sean has been playing the current role, competitive only.
// A "run" is the unbroken streak of competitive matches in one role, counted
// back from the newest. Quick Play is invisible: it neither adds minutes nor
// ends a run. Pure function — the route does the SQL, this does the counting.

export const ROLE_THRESHOLD_MIN = 240;

export interface RoleTimerMatch {
  date: string;
  role: string;
  queue_mode: string | null;
  /** Summed aim_stats_heroes.duration_min; null when no per-hero rows exist yet. */
  minutes: number | null;
}

export interface RoleTimer {
  role: string | null;
  matches: number;
  since: string | null;
  recordedMin: number;
  estimatedMin: number;
  totalMin: number;
  thresholdMin: number;
  reached: boolean;
  switchTo: 'DPS' | 'Support' | null;
}

const isComp = (m: RoleTimerMatch) => (m.queue_mode ?? '').startsWith('comp');
const round1 = (n: number) => Math.round(n * 10) / 10;

/** `matches` must be newest-first (any queue mode). */
export function computeRoleTimer(matches: RoleTimerMatch[], avgMatchMin: number): RoleTimer {
  const comp = matches.filter(isComp);
  if (comp.length === 0) {
    return { role: null, matches: 0, since: null, recordedMin: 0, estimatedMin: 0, totalMin: 0, thresholdMin: ROLE_THRESHOLD_MIN, reached: false, switchTo: null };
  }
  const role = comp[0].role;
  let recorded = 0, estimated = 0, count = 0, since = comp[0].date;
  for (const m of comp) {
    if (m.role !== role) break;
    count++;
    since = m.date;
    if (m.minutes != null) recorded += m.minutes; else estimated += avgMatchMin;
  }
  const total = recorded + estimated;
  return {
    role, matches: count, since,
    recordedMin: round1(recorded), estimatedMin: round1(estimated), totalMin: round1(total),
    thresholdMin: ROLE_THRESHOLD_MIN,
    reached: total >= ROLE_THRESHOLD_MIN,
    switchTo: role === 'DPS' ? 'Support' : role === 'Support' ? 'DPS' : null,
  };
}
