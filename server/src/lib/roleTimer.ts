// Role timers: three independent clocks (Tank, DPS, Support), competitive only.
// Pure function. The route does the SQL, this does the counting.
//
// Rule (2026-10-08, Sean: "switch to 3 timer system, one for each role").
// This replaces the single role-run timer of 2026-10-02 (detour, real-switch and
// held-state rules, and the 2026-10-08 close-and-flip rule). All of those are gone.
//  1. Competitive only: every comp* queue mode counts, Quick Play adds nothing.
//  2. Per match, per role: minutes = the summed Aim Stats duration_min of the heroes
//     of that role (role from match_heroes). Only heroes with duration_min >=
//     MIN_CREDIT_MINUTES count (the same line as lib/credits.ts). One match can
//     add to two roles (a DPS + Support swap).
//  3. A match with no per-hero minutes yet (and a crashed match) adds the average
//     match minutes to matches.role, marked estimated.
//  4. Each role's clock sums its minutes, oldest to newest, since its own last reset.
//     When it reaches ROLE_THRESHOLD_MIN it resets to 0. The match that crosses the
//     line is the reset point. Minutes past the line are dropped.
//  5. Output: always all three roles, in the order Tank, DPS, Support.
import { MIN_CREDIT_MINUTES } from './credits';

export const ROLE_THRESHOLD_MIN = 240;
export const TIMER_ROLES = ['Tank', 'DPS', 'Support'] as const;
export type TimerRole = typeof TIMER_ROLES[number];

export interface RoleTimerMatch {
  date: string;
  /** matches.role: the role the match was queued as. */
  role: string;
  queue_mode: string | null;
  /** Per-hero Aim Stats minutes: one entry per hero, with the hero's role. Null or empty when no per-hero minutes exist yet. */
  heroes: { role: string; duration_min: number }[] | null;
}

export interface RoleClock {
  role: TimerRole;
  recordedMin: number;
  estimatedMin: number;
  totalMin: number;
  /** Matches since the last reset that gave this role >= 1 minute, or an estimate. */
  matches: number;
  /** Date of the last reset match, or of the first match that counted when never reset; null when empty. */
  since: string | null;
  /** Count of resets ever. */
  resets: number;
}

export interface RoleTimers { thresholdMin: number; roles: RoleClock[] }

/** The newest comp role-queue match (queue_mode comp_role): its matches.role and the roles whose clock it reset. */
export interface LastRoleQueueMatch { role: string; resetRoles: TimerRole[] }

const isComp = (m: RoleTimerMatch) => (m.queue_mode ?? '').startsWith('comp');
const round1 = (n: number) => Math.round(n * 10) / 10;

/** `matches` is newest first (the route's order), any queue mode. Filtered and reversed to oldest -> newest here. */
export function computeRoleTimers(matches: RoleTimerMatch[], avgMatchMin: number): RoleTimers {
  return replayRoleTimers(matches, avgMatchMin).timers;
}

/** Same replay as computeRoleTimers, plus what the newest comp role-queue match did (null when there is none). */
export function replayRoleTimers(matches: RoleTimerMatch[], avgMatchMin: number): { timers: RoleTimers; lastRoleQueue: LastRoleQueueMatch | null } {
  let lastRoleQueue: LastRoleQueueMatch | null = null;
  const clocks = new Map<TimerRole, { rec: number; est: number; n: number; since: string | null; resets: number }>();
  for (const r of TIMER_ROLES) clocks.set(r, { rec: 0, est: 0, n: 0, since: null, resets: 0 });

  const comp = matches.filter(isComp).reverse();
  for (const m of comp) {
    // role -> [recorded, estimated] this match adds
    const add = new Map<TimerRole, [number, number]>();
    if (m.heroes && m.heroes.length > 0) {
      for (const h of m.heroes) {
        if (h.duration_min < MIN_CREDIT_MINUTES || !clocks.has(h.role as TimerRole)) continue;
        const cur = add.get(h.role as TimerRole) ?? [0, 0];
        cur[0] += h.duration_min;
        add.set(h.role as TimerRole, cur);
      }
    } else if (clocks.has(m.role as TimerRole)) {
      add.set(m.role as TimerRole, [0, avgMatchMin]);
    }
    const resetRoles: TimerRole[] = [];
    for (const [role, [rec, est]] of add) {
      const c = clocks.get(role)!;
      c.rec += rec; c.est += est; c.n++;
      if (c.since === null) c.since = m.date;
      if (c.rec + c.est >= ROLE_THRESHOLD_MIN) {
        c.rec = 0; c.est = 0; c.n = 0; c.since = m.date; c.resets++;
        resetRoles.push(role);
      }
    }
    if (m.queue_mode === 'comp_role') lastRoleQueue = { role: m.role, resetRoles };
  }

  const timers: RoleTimers = {
    thresholdMin: ROLE_THRESHOLD_MIN,
    roles: TIMER_ROLES.map(role => {
      const c = clocks.get(role)!;
      return { role, recordedMin: round1(c.rec), estimatedMin: round1(c.est), totalMin: round1(c.rec + c.est), matches: c.n, since: c.since, resets: c.resets };
    }),
  };
  return { timers, lastRoleQueue };
}
