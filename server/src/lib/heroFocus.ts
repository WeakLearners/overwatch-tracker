import type { getDb } from '../db/schema';

// Hero focus trial (play-trial item 3, 2026-11-08). Sean's rule: the app chooses the
// heroes and holds him to them, so he does not spread himself thin again.
//
// What the trial is: 200 competitive matches in 10 blocks of 20. At start the server picks
// 2 heroes per role (Tank, DPS, Support = 6) by a fixed rule and locks them. For each block
// there is one pick per role, taken from that role's 2 roster heroes in ABBA order
// (A B B A A B B A A B), so each hero gets 5 blocks and a drift in form is spread across both.
// The pick is a pure function of the block number: the advisor makes no model call for it.
//
// Roster rule (fixed, stated here and on the trial card):
//   data    matches with queue_mode comp_role or comp_open, crashed = 0, played in the last
//           12 months (matches.date >= today - 365 days). A hero is matches.hero (the
//           starting hero) and its role is matches.role.
//   p0      Sean's overall comp win rate over that same window.
//   shrunk  (wins + 30 * p0) / (n + 30)  - a beta prior worth 30 matches.
//   eligible n >= 30.
//   order   shrunk win rate desc, then n desc, then hero name asc. Top 2 per role.
//   short   a role with fewer than 2 eligible heroes is filled with its most-played heroes
//           (n desc) from the same window, then from all comp history if still short.
//
// Progress is counted live by match id (id > anchor, comp, not crashed), never by date and
// never with a stored counter. The roster is snapshotted at start and never recomputed.
type Db = ReturnType<typeof getDb>;

export const ROLES = ['Tank', 'DPS', 'Support'] as const;
export type FocusRole = typeof ROLES[number];
export const TRIAL_TARGET = 200;
export const BLOCK_SIZE = 20;
export const BLOCKS = TRIAL_TARGET / BLOCK_SIZE;
export const MIN_N = 30;
export const PRIOR_WEIGHT = 30;
export const WINDOW_DAYS = 365;
const ABBA = [0, 1, 1, 0, 0, 1, 1, 0, 0, 1];

export const RULE_TEXT =
  'Comp matches in the last 12 months. Eligible: 30 or more matches. Rank by win rate pulled toward your overall comp win rate ' +
  '(a prior worth 30 matches), ties by match count. Top 2 per role. A role with fewer than 2 eligible heroes is filled with its most-played heroes.';

export interface HeroStat { role: string; hero: string; n: number; wins: number }
export interface RosterEntry { role: FocusRole; hero: string; rank: number; basis: 'rank' | 'fill'; n: number; winRate: number | null; shrunkWr: number | null }

const shrunk = (wins: number, n: number, p0: number) => (wins + PRIOR_WEIGHT * p0) / (n + PRIOR_WEIGHT);

/** Pure roster rule. `windowed` and `allTime` are per-hero comp stats; p0 is the overall comp win rate (0..1). */
export function chooseRoster(windowed: HeroStat[], allTime: HeroStat[], p0: number): RosterEntry[] {
  const out: RosterEntry[] = [];
  for (const role of ROLES) {
    const inRole = windowed.filter(h => h.role === role);
    const eligible = inRole.filter(h => h.n >= MIN_N)
      .map(h => ({ h, s: shrunk(h.wins, h.n, p0) }))
      .sort((a, b) => b.s - a.s || b.h.n - a.h.n || a.h.hero.localeCompare(b.h.hero))
      .slice(0, 2);
    const picked: RosterEntry[] = eligible.map((e, i) => ({
      role, hero: e.h.hero, rank: i + 1, basis: 'rank', n: e.h.n,
      winRate: e.h.n ? e.h.wins / e.h.n : null, shrunkWr: e.s,
    }));
    if (picked.length < 2) {
      const have = new Set(picked.map(p => p.hero));
      const fillFrom = (rows: HeroStat[]) => rows.filter(h => h.role === role && !have.has(h.hero))
        .sort((a, b) => b.n - a.n || a.hero.localeCompare(b.hero));
      for (const h of [...fillFrom(inRole), ...fillFrom(allTime.filter(a => !inRole.some(w => w.hero === a.hero)))]) {
        if (picked.length >= 2) break;
        if (have.has(h.hero)) continue;
        have.add(h.hero);
        picked.push({ role, hero: h.hero, rank: picked.length + 1, basis: 'fill', n: h.n, winRate: h.n ? h.wins / h.n : null, shrunkWr: h.n ? shrunk(h.wins, h.n, p0) : null });
      }
    }
    out.push(...picked);
  }
  return out;
}

const COMP = `m.queue_mode IN ('comp_role', 'comp_open') AND m.crashed = 0`;

function heroStats(db: Db, sinceDate: string | null): HeroStat[] {
  return db.prepare(`
    SELECT m.role AS role, m.hero AS hero, COUNT(*) AS n, SUM(m.win) AS wins
    FROM matches m WHERE ${COMP} AND m.hero IS NOT NULL ${sinceDate ? 'AND m.date >= :since' : ''}
    GROUP BY m.role, m.hero
  `).all(sinceDate ? { since: sinceDate } : {}).map((r: any) => ({ role: r.role, hero: r.hero, n: Number(r.n), wins: Number(r.wins) }));
}

export function computeRosterPreview(db: Db, today: Date = new Date()) {
  const since = new Date(today.getTime() - WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const windowed = heroStats(db, since);
  const allTime = heroStats(db, null);
  const n = windowed.reduce((a, h) => a + h.n, 0);
  const wins = windowed.reduce((a, h) => a + h.wins, 0);
  const p0 = n ? wins / n : 0.5;
  return { overallWr: n ? p0 : null, windowMatches: n, roster: chooseRoster(windowed, allTime, p0) };
}

interface TrialRow {
  id: number; started_at: string; anchor_match_id: number; target: number; block_size: number;
  overall_wr: number | null; ended_at: string | null; end_match_id: number | null; end_reason: string | null;
}

export function latestTrial(db: Db): TrialRow | null {
  return (db.prepare('SELECT * FROM hero_focus_trials ORDER BY id DESC LIMIT 1').get() as TrialRow | undefined) ?? null;
}

function rosterOf(db: Db, trialId: number): RosterEntry[] {
  return (db.prepare('SELECT role, hero, rank, basis, n, win_rate, shrunk_wr FROM hero_focus_roster WHERE trial_id = :id ORDER BY role, rank')
    .all({ id: trialId }) as any[]).map(r => ({
      role: r.role, hero: r.hero, rank: Number(r.rank), basis: r.basis, n: Number(r.n),
      winRate: r.win_rate, shrunkWr: r.shrunk_wr,
    }));
}

function progress(db: Db, t: TrialRow) {
  const row = db.prepare(`
    SELECT COUNT(*) AS n, COALESCE(SUM(CASE WHEN m.off_roster = 1 THEN 1 ELSE 0 END), 0) AS off
    FROM matches m WHERE ${COMP} AND m.id > :anchor ${t.end_match_id != null ? 'AND m.id <= :end' : ''}
  `).get(t.end_match_id != null ? { anchor: t.anchor_match_id, end: t.end_match_id } : { anchor: t.anchor_match_id }) as { n: number; off: number };
  return { n: Math.min(Number(row.n), t.target), offRoster: Number(row.off) };
}

/** The roster hero for a block (1-based) and role. ABBA over the role's two heroes. */
export function pickFor(roster: RosterEntry[], role: FocusRole, block: number): string | null {
  const heroes = roster.filter(r => r.role === role).sort((a, b) => a.rank - b.rank);
  if (heroes.length === 0) return null;
  return heroes[heroes.length > 1 ? ABBA[(Math.max(1, Math.min(block, BLOCKS)) - 1) % ABBA.length] : 0].hero;
}

export type TrialStatus = 'active' | 'ended' | 'complete';

function trialView(db: Db, t: TrialRow) {
  const roster = rosterOf(db, t.id);
  const { n, offRoster } = progress(db, t);
  const status: TrialStatus = t.ended_at ? 'ended' : n >= t.target ? 'complete' : 'active';
  const block = Math.min(Math.floor(n / t.block_size) + 1, t.target / t.block_size);
  const picks = Object.fromEntries(ROLES.map(r => [r, pickFor(roster, r, block)])) as Record<FocusRole, string | null>;
  return {
    id: t.id, status, startedAt: t.started_at, endedAt: t.ended_at, endReason: t.end_reason,
    target: t.target, blockSize: t.block_size, blocks: t.target / t.block_size,
    n, block, matchInBlock: status === 'complete' ? t.block_size : (n % t.block_size) + 1,
    offRoster, overallWr: t.overall_wr, roster, picks,
  };
}

export function trialState(db: Db) {
  const t = latestTrial(db);
  const rule = { text: RULE_TEXT, windowMonths: 12, minN: MIN_N, priorWeight: PRIOR_WEIGHT };
  const trial = t ? trialView(db, t) : null;
  return { rule, trial, preview: trial?.status === 'active' ? null : computeRosterPreview(db) };
}

/** The active trial (not ended, not complete) with its roster, block and picks; null otherwise. */
export function activeTrial(db: Db) {
  const t = latestTrial(db);
  const v = t ? trialView(db, t) : null;
  return v && v.status === 'active' ? v : null;
}

export function startTrial(db: Db): { error: string } | { id: number } {
  if (activeTrial(db)) return { error: 'a hero focus trial is already running' };
  const { roster, overallWr } = computeRosterPreview(db);
  const missing = ROLES.filter(r => !roster.some(x => x.role === r));
  if (missing.length) return { error: `no comp history for ${missing.join(', ')}, so no roster can be chosen` };
  const anchor = Number((db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM matches').get() as any).id);
  db.exec('BEGIN');
  try {
    const id = Number(db.prepare(`
      INSERT INTO hero_focus_trials (anchor_match_id, target, block_size, overall_wr) VALUES (:a, :t, :b, :wr)
    `).run({ a: anchor, t: TRIAL_TARGET, b: BLOCK_SIZE, wr: overallWr }).lastInsertRowid);
    const ins = db.prepare(`
      INSERT INTO hero_focus_roster (trial_id, role, hero, rank, basis, n, win_rate, shrunk_wr)
      VALUES (:id, :role, :hero, :rank, :basis, :n, :wr, :s)
    `);
    for (const r of roster) ins.run({ id, role: r.role, hero: r.hero, rank: r.rank, basis: r.basis, n: r.n, wr: r.winRate, s: r.shrunkWr });
    db.exec('COMMIT');
    return { id };
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

export function endTrial(db: Db, reason: unknown): { error: string } | { ok: true } {
  const text = typeof reason === 'string' ? reason.trim() : '';
  if (text.length < 3) return { error: 'a reason is required to end the trial early' };
  const t = activeTrial(db);
  if (!t) return { error: 'no hero focus trial is running' };
  const maxId = Number((db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM matches').get() as any).id);
  db.prepare(`UPDATE hero_focus_trials SET ended_at = datetime('now'), end_match_id = :m, end_reason = :r WHERE id = :id`)
    .run({ m: maxId, r: text.slice(0, 500), id: t.id });
  console.log(`[hero-focus] trial ${t.id} ended early at ${t.n} of ${t.target}: ${text}`);
  return { ok: true };
}

/** For POST /api/matches: how a comp match counts against the active trial, or null when none governs it. */
export function governFor(db: Db, queueMode: string | undefined, hero: string, role: string) {
  if ((queueMode ?? 'comp_role') === 'qp_role') return null;
  const t = activeTrial(db);
  if (!t) return null;
  const onRoster = t.roster.some(r => r.hero === hero);
  const r = (['Tank', 'DPS', 'Support'] as const).find(x => x === role);
  return { onRoster, pick: r ? t.picks[r] : null };
}

/** Lab-side advisor seam: DPS and Support block picks while a trial runs in comp, else null. */
export function advisorFocusPicks(db: Db): Partial<Record<'DPS' | 'Support', string>> | null {
  const t = activeTrial(db);
  if (!t) return null;
  const out: Partial<Record<'DPS' | 'Support', string>> = {};
  if (t.picks.DPS) out.DPS = t.picks.DPS;
  if (t.picks.Support) out.Support = t.picks.Support;
  return out;
}
