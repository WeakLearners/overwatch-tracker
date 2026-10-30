// Scoreboard trend card (2026-10-30): the first analytic reader of the
// scoreboard screenshot tables. Pure compute over the lab replica
// (lab/replica.ts); it holds no Request/Response and never imports db/schema.
//
// Population: competitive matches (queue_mode != 'qp_role'), crashed matches
// skipped, ONE Teams board per match. Per-10 figures use the summed play_time
// (seconds) from match_hero_stats and count only matches that have it. The
// shares and the death bins need only the board, so they use every board.
// Verdicts come from lib/finding.ts (makeFinding, Bonferroni over the testable
// groups); the means, shares and rank figures are descriptive.
import type { DatabaseSync } from 'node:sqlite';
import { makeFinding, FINDING_MIN_N, type Finding } from './finding';

/** A rank row whose rank_int is more than this far from BOTH neighbours is treated as an OCR misread. */
export const RANK_JUMP_LIMIT = 3;

export const DEATH_BINS = [
  { label: '0-4', lo: 0, hi: 4 },
  { label: '5-6', lo: 5, hi: 6 },
  { label: '7-8', lo: 7, hi: 8 },
  { label: '9-10', lo: 9, hi: 10 },
  { label: '11+', lo: 11, hi: Infinity },
] as const;

interface MatchBoard {
  match_id: number; date: string; win: number; role: string;
  e: number; d: number; dmg: number; h: number;
  team_d: number; team_dmg: number;
  play_s: number | null; // summed play_time seconds, null when none
}

export interface BinRow { label: string; n: number; wins: number; win_rate: number | null; finding: Finding }
export interface SideStats {
  n: number; per10_n: number;
  elims10: number | null; deaths10: number | null; damage10: number | null; healing10: number | null;
  death_share: number | null; damage_share: number | null;
}
export interface WeekRow {
  week: string; role: string; n: number; wins: number; win_rate: number; per10_n: number;
  deaths10: number | null; elims10: number | null; finding: Finding;
}
export interface RankTrend {
  rows: number; excluded: number; no_delta: number; used: number;
  victory: { n: number; mean_delta: number | null };
  defeat: { n: number; mean_delta: number | null };
  break_even_wr: number | null; actual_wr: number | null;
}
export interface ScoreboardTrends {
  scope: { matches: number; first_date: string | null; last_date: string | null; win_rate: number | null; per10_covered: number };
  death_bins: BinRow[];
  win_loss: { wins: SideStats; losses: SideStats };
  rank: RankTrend;
  weeks: WeekRow[];
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const pct = (w: number, n: number) => (n > 0 ? round1((w / n) * 100) : null);

/** ISO 8601 week label ("2026-W44") for a YYYY-MM-DD date. */
export function isoWeek(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  const dow = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dow); // Thursday of this week
  const yearStart = Date.UTC(t.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((t.getTime() - yearStart) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/** One board per match: the newest board that has the player's own row. Returns the boards' rows summed. */
function loadMatchBoards(db: DatabaseSync): MatchBoard[] {
  const boards = db.prepare(`
    SELECT s.id AS board_id, s.match_id, m.date, m.win, m.role
    FROM match_scoreboards s JOIN matches m ON m.id = s.match_id
    WHERE COALESCE(m.queue_mode, 'comp_role') != 'qp_role' AND COALESCE(m.crashed, 0) = 0
      AND (s.page_type = 'teams' OR s.page_type IS NULL)
      AND EXISTS (SELECT 1 FROM scoreboard_rows r WHERE r.scoreboard_id = s.id AND r.team = 'us' AND r.is_self = 1)
    ORDER BY s.id DESC
  `).all() as { board_id: number; match_id: number; date: string; win: number; role: string }[];

  const chosen = new Map<number, (typeof boards)[number]>();
  for (const b of boards) if (!chosen.has(b.match_id)) chosen.set(b.match_id, b);

  const self = db.prepare(`SELECT e, d, dmg, h FROM scoreboard_rows WHERE scoreboard_id = :id AND team = 'us' AND is_self = 1 ORDER BY slot LIMIT 1`);
  const team = db.prepare(`SELECT SUM(d) AS d, SUM(dmg) AS dmg FROM scoreboard_rows WHERE scoreboard_id = :id AND team = 'us'`);
  const play = db.prepare(`SELECT SUM(value) AS s FROM match_hero_stats WHERE match_id = :id AND stat = 'play_time'`);

  const out: MatchBoard[] = [];
  for (const b of chosen.values()) {
    const s = self.get({ id: b.board_id }) as { e: number; d: number; dmg: number; h: number };
    const t = team.get({ id: b.board_id }) as { d: number; dmg: number };
    const p = (play.get({ id: b.match_id }) as { s: number | null }).s;
    out.push({
      match_id: b.match_id, date: b.date, win: b.win, role: String(b.role ?? '').toLowerCase(),
      e: s.e, d: s.d, dmg: s.dmg, h: s.h, team_d: t.d, team_dmg: t.dmg,
      play_s: p !== null && p > 0 ? p : null,
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.match_id - b.match_id);
}

function sideStats(ms: MatchBoard[]): SideStats {
  const cov = ms.filter(m => m.play_s !== null);
  const mins = cov.reduce((a, m) => a + (m.play_s as number), 0) / 60;
  const per10 = (f: (m: MatchBoard) => number) => (mins > 0 ? round1((cov.reduce((a, m) => a + f(m), 0) / mins) * 10) : null);
  const share = (own: (m: MatchBoard) => number, team: (m: MatchBoard) => number) => {
    const ok = ms.filter(m => team(m) > 0);
    return ok.length ? round1((ok.reduce((a, m) => a + own(m) / team(m), 0) / ok.length) * 100) : null;
  };
  return {
    n: ms.length, per10_n: cov.length,
    elims10: per10(m => m.e), deaths10: per10(m => m.d), damage10: per10(m => m.dmg), healing10: per10(m => m.h),
    death_share: share(m => m.d, m => m.team_d), damage_share: share(m => m.dmg, m => m.team_dmg),
  };
}

function computeRank(db: DatabaseSync): RankTrend {
  const raw = db.prepare(`
    SELECT s.id AS board_id, s.match_id, m.date, m.time, COALESCE(m.account, '') AS account,
           CASE WHEN m.queue_mode = 'comp_open' THEN 'Open' ELSE m.role END AS slot,
           k.rank_int, k.delta_pct, k.result
    FROM scoreboard_ranks k
    JOIN match_scoreboards s ON s.id = k.scoreboard_id
    JOIN matches m ON m.id = s.match_id
    WHERE COALESCE(m.queue_mode, 'comp_role') != 'qp_role' AND COALESCE(m.crashed, 0) = 0
    ORDER BY s.id DESC
  `).all() as { board_id: number; match_id: number; date: string; time: string | null; account: string; slot: string; rank_int: number | null; delta_pct: number | null; result: string | null }[];
  const byMatch = new Map<number, (typeof raw)[number]>();
  for (const r of raw) if (!byMatch.has(r.match_id)) byMatch.set(r.match_id, r); // newest rank page per match
  const rows = [...byMatch.values()];

  // Outlier rule: rank_int more than RANK_JUMP_LIMIT away from BOTH neighbours on the same ladder.
  const ladders = new Map<string, typeof rows>();
  for (const r of rows) {
    const k = `${r.account}|${r.slot}`;
    (ladders.get(k) ?? ladders.set(k, []).get(k)!).push(r);
  }
  const excluded = new Set<number>();
  for (const list of ladders.values()) {
    list.sort((a, b) => a.date.localeCompare(b.date) || (a.time ?? '').localeCompare(b.time ?? '') || a.match_id - b.match_id);
    const ranked = list.filter(r => r.rank_int !== null);
    for (let i = 1; i < ranked.length - 1; i++) {
      const v = ranked[i].rank_int as number;
      if (Math.abs(v - (ranked[i - 1].rank_int as number)) > RANK_JUMP_LIMIT && Math.abs(v - (ranked[i + 1].rank_int as number)) > RANK_JUMP_LIMIT) {
        excluded.add(ranked[i].match_id);
      }
    }
  }

  const used = rows.filter(r => !excluded.has(r.match_id) && r.delta_pct !== null && (r.result === 'victory' || r.result === 'defeat'));
  const wins = used.filter(r => r.result === 'victory');
  const losses = used.filter(r => r.result === 'defeat');
  const mean = (xs: typeof used) => (xs.length ? round1(xs.reduce((a, r) => a + (r.delta_pct as number), 0) / xs.length) : null);
  const mw = mean(wins), ml = mean(losses);
  // Loss is a negative delta, so the break-even rate is |loss| / (win + |loss|).
  const breakEven = mw !== null && ml !== null && mw + Math.abs(ml) > 0 ? round1((Math.abs(ml) / (mw + Math.abs(ml))) * 100) : null;
  return {
    rows: rows.length, excluded: excluded.size,
    no_delta: rows.filter(r => !excluded.has(r.match_id) && r.delta_pct === null).length,
    used: used.length,
    victory: { n: wins.length, mean_delta: mw }, defeat: { n: losses.length, mean_delta: ml },
    break_even_wr: breakEven, actual_wr: pct(wins.length, used.length),
  };
}

export function computeScoreboardTrends(db: DatabaseSync): ScoreboardTrends {
  const ms = loadMatchBoards(db);
  const wins = ms.filter(m => m.win === 1).length;

  const binned = DEATH_BINS.map(b => {
    const g = ms.filter(m => m.d >= b.lo && m.d <= b.hi);
    return { b, n: g.length, w: g.filter(m => m.win === 1).length };
  });
  const tested = binned.filter(x => x.n >= FINDING_MIN_N).length;
  const death_bins: BinRow[] = binned.map(x => ({
    label: x.b.label, n: x.n, wins: x.w, win_rate: pct(x.w, x.n),
    finding: makeFinding({ wins: x.w, n: x.n }, { wins: wins - x.w, n: ms.length - x.n }, tested),
  }));

  const cells = new Map<string, MatchBoard[]>();
  for (const m of ms) {
    const k = `${isoWeek(m.date)}|${m.role}`;
    (cells.get(k) ?? cells.set(k, []).get(k)!).push(m);
  }
  const roleTotals = new Map<string, { n: number; w: number }>();
  for (const m of ms) {
    const t = roleTotals.get(m.role) ?? roleTotals.set(m.role, { n: 0, w: 0 }).get(m.role)!;
    t.n++; if (m.win === 1) t.w++;
  }
  const weekTested = [...cells.values()].filter(c => c.length >= FINDING_MIN_N).length;
  const weeks: WeekRow[] = [...cells.entries()].map(([k, g]) => {
    const [week, role] = k.split('|');
    const w = g.filter(m => m.win === 1).length;
    const s = sideStats(g);
    const rt = roleTotals.get(role)!;
    return {
      week, role, n: g.length, wins: w, win_rate: pct(w, g.length) as number, per10_n: s.per10_n,
      deaths10: s.deaths10, elims10: s.elims10,
      // Each week-role cell is compared with every other game of the same role.
      finding: makeFinding({ wins: w, n: g.length }, { wins: rt.w - w, n: rt.n - g.length }, weekTested),
    };
  }).sort((a, b) => a.week.localeCompare(b.week) || a.role.localeCompare(b.role));

  return {
    scope: {
      matches: ms.length, first_date: ms[0]?.date ?? null, last_date: ms[ms.length - 1]?.date ?? null,
      win_rate: pct(wins, ms.length), per10_covered: ms.filter(m => m.play_s !== null).length,
    },
    death_bins,
    win_loss: { wins: sideStats(ms.filter(m => m.win === 1)), losses: sideStats(ms.filter(m => m.win === 0)) },
    rank: computeRank(db),
    weeks,
  };
}
