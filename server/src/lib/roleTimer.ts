// Role timer: how long Sean has been playing the current role, competitive only. Pure function — the route does the SQL, this does the counting.
//
// Rule (2026-10-02). Take role-queue competitive matches oldest -> newest and
// group them into runs of consecutive same-role matches.
//  1. DETOUR: a run of length 1 whose neighbours on both sides are runs of the
//     same other role (S-D-S: the D). Dropped entirely: no minutes, and the
//     surrounding role's streak is not broken (the neighbours merge).
//  2. REAL SWITCH: a run of length >= 2 in a different role. It resets the old
//     role's clock; the new role's clock is that run's minutes.
//  3. PENDING: the newest match is a length-1 run in a new role (S-S-S-D). The
//     gauge shows that role with that one match, and `held` carries the previous
//     role's clock so the UI can say one more match resets it. The next match
//     resolves it as a detour (rule 1) or a real switch (rule 2).
// Queue modes: unchanged. Every comp* mode counts (open queue included, for
// now; mode-dependency is deferred until the 6v6 format is known). Quick Play
// adds no minutes and breaks no streak. Minutes: summed Aim Stats
// duration_min, average stand-in when absent.

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
  /** Newest match is a lone new-role match: the previous role's clock, still running. */
  held: { role: string; totalMin: number; matches: number } | null;
}

interface Run { role: string; since: string; recorded: number; estimated: number; count: number; }

const isComp = (m: RoleTimerMatch) => (m.queue_mode ?? '').startsWith('comp');
const round1 = (n: number) => Math.round(n * 10) / 10;

const empty = (): RoleTimer => ({ role: null, matches: 0, since: null, recordedMin: 0, estimatedMin: 0, totalMin: 0, thresholdMin: ROLE_THRESHOLD_MIN, reached: false, switchTo: null, held: null });

/** `matches` is any order of any queue mode; sorted/filtered here (oldest first by date string, input order is newest-first so we reverse). */
export function computeRoleTimer(matches: RoleTimerMatch[], avgMatchMin: number): RoleTimer {
  const comp = matches.filter(m => isComp(m) && m.role).reverse(); // oldest -> newest
  if (comp.length === 0) return empty();

  // Fold matches into runs, collapsing detours as soon as the closing run arrives.
  const runs: Run[] = [];
  for (const m of comp) {
    const r: Run = { role: m.role, since: m.date, recorded: m.minutes ?? 0, estimated: m.minutes == null ? avgMatchMin : 0, count: 1 };
    const last = runs[runs.length - 1];
    if (last && last.role === r.role) { last.recorded += r.recorded; last.estimated += r.estimated; last.count++; continue; }
    const prev = runs[runs.length - 2];
    if (last && last.count === 1 && prev && prev.role === r.role) {
      runs.pop(); // last was a detour: drop it, merge r into prev
      prev.recorded += r.recorded; prev.estimated += r.estimated; prev.count += r.count;
      continue;
    }
    runs.push(r);
  }

  const cur = runs[runs.length - 1];
  const before = runs[runs.length - 2];
  const total = cur.recorded + cur.estimated;
  const held = cur.count === 1 && before
    ? { role: before.role, totalMin: round1(before.recorded + before.estimated), matches: before.count }
    : null;
  return {
    role: cur.role, matches: cur.count, since: cur.since,
    recordedMin: round1(cur.recorded), estimatedMin: round1(cur.estimated), totalMin: round1(total),
    thresholdMin: ROLE_THRESHOLD_MIN,
    reached: total >= ROLE_THRESHOLD_MIN,
    switchTo: cur.role === 'DPS' ? 'Support' : cur.role === 'Support' ? 'DPS' : null,
    held,
  };
}
