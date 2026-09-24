// Pure, DB-reading compute functions extracted from routes/stats.ts.
// Moved here 2026-09-23 (modularization slice 1) — no logic changed, only
// location. These take a `db` handle and return data; they hold no
// Request/Response and are called only by stats.ts's `/insights` route,
// which is why they were the lowest-risk piece of that file to split out.
// Covered by server/src/routes/stats.test.ts's "Tier 2" suite.
import { getDb } from '../db/schema';

// ── Hot hand ─────────────────────────────────────────────────────────────────
// Does winning actually predict winning your next game, beyond what a coin
// flip would produce — or does losing compound? Splits same-day games by
// whether the immediately prior game (same session) was a win or a loss, and
// compares win rates. The existing tilt check in /prematch only looks at a
// specific 2-loss pattern for a live nudge; this is the general, all-history
// version of the same question, reported as a trend rather than a live flag.
const HOT_HAND_MIN_GAMES = 10;
export function computeHotHand(db: ReturnType<typeof getDb>) {
  const row = db.prepare(`
    WITH numbered AS (
      SELECT win, LAG(win,1) OVER (PARTITION BY date ORDER BY time) AS prev1
      FROM matches
    )
    SELECT
      ROUND(AVG(CASE WHEN prev1 = 1 THEN win END)*100,1) AS after_win_wr,
      COUNT(CASE WHEN prev1 = 1 THEN 1 END)              AS after_win_games,
      ROUND(AVG(CASE WHEN prev1 = 0 THEN win END)*100,1) AS after_loss_wr,
      COUNT(CASE WHEN prev1 = 0 THEN 1 END)              AS after_loss_games
    FROM numbered WHERE prev1 IS NOT NULL
  `).get({}) as { after_win_wr: number | null; after_win_games: number; after_loss_wr: number | null; after_loss_games: number };

  const reliable = row.after_win_games >= HOT_HAND_MIN_GAMES && row.after_loss_games >= HOT_HAND_MIN_GAMES;
  const gap = reliable && row.after_win_wr !== null && row.after_loss_wr !== null
    ? Math.round((row.after_win_wr - row.after_loss_wr) * 10) / 10
    : null;

  return {
    after_win:  { win_rate: row.after_win_wr,  games: row.after_win_games },
    after_loss: { win_rate: row.after_loss_wr, games: row.after_loss_games },
    reliable,
    gap,
  };
}

// ── Performance-outcome mismatch ────────────────────────────────────────────
// How much of winning is actually in your control? For every match with
// combat stats logged, compares accuracy, damage/10min, elims/10min, and
// final-blows/10min against your own personal average on each — then checks
// how often playing above your own average on most of them still lost, and
// playing below still won. Also reports which single feature actually tracks
// winning best, since raw accuracy is assumed to matter most but may not be
// the real driver — elims/10min turns out to separate wins/losses far harder.
interface PerfRow { win: number; overall_acc: number; damage: number; elims: number; final_blows: number; duration_min: number }
const PERF_FEATURES = [
  { key: 'overall_acc', label: 'Accuracy' },
  { key: 'dmg10',   label: 'Damage /10min' },
  { key: 'elims10', label: 'Elims /10min' },
  { key: 'fb10',    label: 'Final Blows /10min' },
] as const;
export type PerfFeatureKey = typeof PERF_FEATURES[number]['key'];
const PERF_MIN_GAMES = 8;

// Explicit return type only (no logic change) — without it, TypeScript's
// inference across this function's two differently-shaped `return`
// statements (the early empty-DB return vs. the general-case return) was
// producing unusable types for callers narrowing on `sample_size` before
// reading `mismatch`/`strongest` (see stats.test.ts). Pinning the shape here
// is a type-only annotation; the runtime values it describes are unchanged.
export interface PerfFeatureResult {
  key: PerfFeatureKey; label: string; baseline: number | null;
  aboveGames: number; aboveWinRate: number | null;
  belowGames: number; belowWinRate: number | null;
  reliable: boolean; gap: number | null;
}
export interface PerfMismatch {
  played_well_games: number; played_well_losses: number; played_well_loss_rate: number | null;
  played_poor_games: number; played_poor_wins: number; played_poor_win_rate: number | null;
  reliable: boolean;
}
export interface PerfOutcomeResult {
  features: PerfFeatureResult[];
  strongest: PerfFeatureResult | null;
  mismatch: PerfMismatch | null;
  sample_size: number;
}

export function computePerformanceOutcome(db: ReturnType<typeof getDb>): PerfOutcomeResult {
  const rows = db.prepare(`
    SELECT m.win, a.overall_acc, a.damage, a.elims, a.final_blows, a.duration_min
    FROM aim_stats a JOIN matches m ON m.id = a.match_id
    WHERE a.overall_acc IS NOT NULL AND a.damage IS NOT NULL AND a.elims IS NOT NULL
      AND a.final_blows IS NOT NULL AND a.duration_min IS NOT NULL AND a.duration_min > 0
  `).all({}) as unknown as PerfRow[];

  if (rows.length === 0) return { features: [], strongest: null, mismatch: null, sample_size: 0 };

  // Normalize output-volume stats by game length so a long grindy win doesn't
  // just look "better" than a short decisive one on raw totals.
  const derived = rows.map(r => ({
    win: r.win,
    overall_acc: r.overall_acc,
    dmg10:   r.damage      / r.duration_min * 10,
    elims10: r.elims       / r.duration_min * 10,
    fb10:    r.final_blows / r.duration_min * 10,
  }));

  const baseline = {} as Record<PerfFeatureKey, number>;
  for (const f of PERF_FEATURES) {
    baseline[f.key] = derived.reduce((s, r) => s + r[f.key], 0) / derived.length;
  }

  const features = PERF_FEATURES.map(f => {
    const above = derived.filter(r => r[f.key] > baseline[f.key]);
    const below = derived.filter(r => r[f.key] <= baseline[f.key]);
    const aboveWinRate = above.length ? Math.round((above.filter(r => r.win).length / above.length) * 1000) / 10 : null;
    const belowWinRate = below.length ? Math.round((below.filter(r => r.win).length / below.length) * 1000) / 10 : null;
    const reliable = above.length >= PERF_MIN_GAMES && below.length >= PERF_MIN_GAMES;
    const gap = reliable && aboveWinRate !== null && belowWinRate !== null
      ? Math.round((aboveWinRate - belowWinRate) * 10) / 10
      : null;
    return {
      key: f.key, label: f.label,
      baseline: Math.round(baseline[f.key] * 10) / 10,
      aboveGames: above.length, aboveWinRate,
      belowGames: below.length, belowWinRate,
      reliable, gap,
    };
  });

  const strongest = features
    .filter(f => f.reliable && f.gap !== null)
    .sort((a, b) => Math.abs(b.gap!) - Math.abs(a.gap!))[0] ?? null;

  // Mismatch: played above your own average on most tracked features but
  // still lost, or below average on most but still won — the direct measure
  // of how much of the outcome was actually in your hands.
  const aboveCounts = derived.map(r => PERF_FEATURES.filter(f => r[f.key] > baseline[f.key]).length);
  const playedWell = derived.filter((_, i) => aboveCounts[i] >= 3);
  const playedPoor = derived.filter((_, i) => aboveCounts[i] <= 1);
  const mismatchReliable = playedWell.length >= PERF_MIN_GAMES && playedPoor.length >= PERF_MIN_GAMES;

  const mismatch = {
    played_well_games: playedWell.length,
    played_well_losses: playedWell.filter(r => !r.win).length,
    played_well_loss_rate: playedWell.length
      ? Math.round((playedWell.filter(r => !r.win).length / playedWell.length) * 1000) / 10 : null,
    played_poor_games: playedPoor.length,
    played_poor_wins: playedPoor.filter(r => r.win).length,
    played_poor_win_rate: playedPoor.length
      ? Math.round((playedPoor.filter(r => r.win).length / playedPoor.length) * 1000) / 10 : null,
    reliable: mismatchReliable,
  };

  return { features, strongest, mismatch, sample_size: rows.length };
}

// ── Queue-mode switch tax ───────────────────────────────────────────────────
// Context-switching cost: win rate on the first game after switching queue
// mode (qp/comp/open) mid-session, vs. staying in the same mode as the prior
// same-day game. Session openers (no prior game) are excluded from both sides.
const QUEUE_SWITCH_MIN_GAMES = 10;
export function computeQueueSwitchTax(db: ReturnType<typeof getDb>) {
  const row = db.prepare(`
    WITH numbered AS (
      SELECT win, queue_mode, LAG(queue_mode) OVER (PARTITION BY date ORDER BY time) AS prev_mode
      FROM matches
    )
    SELECT
      ROUND(AVG(CASE WHEN prev_mode = queue_mode THEN win END)*100,1)                          AS same_wr,
      COUNT(CASE WHEN prev_mode = queue_mode THEN 1 END)                                       AS same_games,
      ROUND(AVG(CASE WHEN prev_mode IS NOT NULL AND prev_mode != queue_mode THEN win END)*100,1) AS switch_wr,
      COUNT(CASE WHEN prev_mode IS NOT NULL AND prev_mode != queue_mode THEN 1 END)             AS switch_games
    FROM numbered
  `).get({}) as { same_wr: number | null; same_games: number; switch_wr: number | null; switch_games: number };

  const reliable = row.same_games >= QUEUE_SWITCH_MIN_GAMES && row.switch_games >= QUEUE_SWITCH_MIN_GAMES;
  const gap = reliable && row.same_wr !== null && row.switch_wr !== null
    ? Math.round((row.same_wr - row.switch_wr) * 10) / 10
    : null;

  return {
    same:    { win_rate: row.same_wr,   games: row.same_games },
    switched: { win_rate: row.switch_wr, games: row.switch_games },
    reliable, gap,
  };
}

// ── Crit accuracy vs. outcome ───────────────────────────────────────────────
// A standalone check outside the normalized-rate performance features: does
// crit accuracy above your own average actually correlate with winning?
const CRIT_ACC_MIN_GAMES = 10;
export function computeCritAccuracy(db: ReturnType<typeof getDb>) {
  const rows = db.prepare(`
    SELECT m.win, a.crit_acc FROM aim_stats a JOIN matches m ON m.id = a.match_id
    WHERE a.crit_acc IS NOT NULL
  `).all({}) as { win: number; crit_acc: number }[];
  if (rows.length === 0) return { reliable: false, baseline: null, aboveWinRate: null, aboveGames: 0, belowWinRate: null, belowGames: 0, gap: null };

  const avg = rows.reduce((s, r) => s + r.crit_acc, 0) / rows.length;
  const above = rows.filter(r => r.crit_acc > avg);
  const below = rows.filter(r => r.crit_acc <= avg);
  const aboveWinRate = above.length ? Math.round((above.filter(r => r.win).length / above.length) * 1000) / 10 : null;
  const belowWinRate = below.length ? Math.round((below.filter(r => r.win).length / below.length) * 1000) / 10 : null;
  const reliable = above.length >= CRIT_ACC_MIN_GAMES && below.length >= CRIT_ACC_MIN_GAMES;
  const gap = reliable && aboveWinRate !== null && belowWinRate !== null
    ? Math.round((aboveWinRate - belowWinRate) * 10) / 10 : null;

  return { reliable, baseline: Math.round(avg * 10) / 10, aboveWinRate, aboveGames: above.length, belowWinRate, belowGames: below.length, gap };
}

// ── Kill-secure rate vs. outcome ────────────────────────────────────────────
// final_blows ÷ elims — how much of your own kill participation you personally
// close out, vs. how often that correlates with winning. Not assumed to be
// "more closing = better" going in; the ratio is just compared to your own
// average like the other splits.
const KILL_SECURE_MIN_GAMES = 10;
export function computeKillSecure(db: ReturnType<typeof getDb>) {
  const rows = db.prepare(`
    SELECT m.win, a.final_blows, a.elims FROM aim_stats a JOIN matches m ON m.id = a.match_id
    WHERE a.elims IS NOT NULL AND a.elims > 0 AND a.final_blows IS NOT NULL
  `).all({}) as { win: number; final_blows: number; elims: number }[];
  if (rows.length === 0) return { reliable: false, baseline: null, aboveWinRate: null, aboveGames: 0, belowWinRate: null, belowGames: 0, gap: null };

  const derived = rows.map(r => ({ win: r.win, ratio: r.final_blows / r.elims }));
  const avg = derived.reduce((s, r) => s + r.ratio, 0) / derived.length;
  const above = derived.filter(r => r.ratio > avg);
  const below = derived.filter(r => r.ratio <= avg);
  const aboveWinRate = above.length ? Math.round((above.filter(r => r.win).length / above.length) * 1000) / 10 : null;
  const belowWinRate = below.length ? Math.round((below.filter(r => r.win).length / below.length) * 1000) / 10 : null;
  const reliable = above.length >= KILL_SECURE_MIN_GAMES && below.length >= KILL_SECURE_MIN_GAMES;
  const gap = reliable && aboveWinRate !== null && belowWinRate !== null
    ? Math.round((aboveWinRate - belowWinRate) * 10) / 10 : null;

  return { reliable, baseline: Math.round(avg * 1000) / 1000, aboveWinRate, aboveGames: above.length, belowWinRate, belowGames: below.length, gap };
}

// ── Best/worst session window ───────────────────────────────────────────────
// The existing by-hour view only shows the marginal (averaged across every
// day). This finds the single best and worst day+hour cell directly, which
// can look nothing like the marginal pattern — a bad hour overall can still
// be a great hour on one specific day.
const DAY_HOUR_MIN_GAMES = 10;
export function formatHour(h: number): string {
  const period = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${period}`;
}
export function computeDayHourWindow(db: ReturnType<typeof getDb>) {
  const rows = db.prepare(`
    SELECT day_of_week, hour, COUNT(*) AS n, ROUND(AVG(win)*100,1) AS wr
    FROM matches WHERE day_of_week IS NOT NULL AND hour IS NOT NULL
    GROUP BY day_of_week, hour HAVING n >= ${DAY_HOUR_MIN_GAMES}
  `).all({}) as { day_of_week: string; hour: number; n: number; wr: number }[];

  if (rows.length < 2) return { reliable: false, best: null, worst: null };
  const sorted = [...rows].sort((a, b) => b.wr - a.wr);
  return { reliable: true, best: sorted[0], worst: sorted[sorted.length - 1] };
}

// ── Generic field split ─────────────────────────────────────────────────────
// The registry-driven answer to "does this captured field actually move with
// anything" for any field tagged `study` in lib/fieldRegistry.ts (added
// 2026-09-24, the field-registry prerequisite to Phase 2 — see
// modular-tracking-roadmap.md). Before this, each study (aim.ts, this file,
// nightlyAnalysis.ts) had to hand-write its own query per field; a captured
// column with no bespoke query for it just sat there. This is that query,
// written once, parameterized on which column and which metrics.
//
// SECURITY NOTE: `column` is interpolated directly into the SQL text below,
// which is normally exactly what NOT to do with a request-derived value.
// It's safe ONLY because the caller (routes/stats.ts's GET /split) never
// passes through the raw query string — it looks the requested field up in
// FIELD_REGISTRY first and only calls this function with that field's own
// `writesTo.columns[0]`, which is a whitelist fixed in code, not user input.
// Do not call this function with an unvalidated string.
export interface SplitGroup {
  value: string | number | null;
  n: number;
  win_rate: number | null;
  n_acc: number;
  mean_acc: number | null;
}
export interface SplitResult {
  by: string;
  metrics: ('win_rate' | 'accuracy')[];
  unasked: number;
  groups: SplitGroup[];
}
export function computeFieldSplit(
  db: ReturnType<typeof getDb>,
  column: string,
  metrics: ('win_rate' | 'accuracy')[],
  where: string,
  params: Record<string, string>
): SplitResult {
  const needsWin = metrics.includes('win_rate');
  const needsAcc = metrics.includes('accuracy');

  // NULL-means-not-asked, same convention as the `leaver` column comment in
  // db/schema.ts: rows where the field was never captured are excluded from
  // the groups and reported separately as `unasked`, not folded into either
  // side of a split.
  const whereNull = where ? `${where} AND matches.${column} IS NULL` : `WHERE matches.${column} IS NULL`;
  const whereValue = where ? `${where} AND matches.${column} IS NOT NULL` : `WHERE matches.${column} IS NOT NULL`;

  const { unasked } = db.prepare(`SELECT COUNT(*) as unasked FROM matches ${whereNull}`)
    .get(params) as { unasked: number };

  // Accuracy = aim_stats_heroes.overall_acc for the match's PRIMARY hero only
  // (ash.hero = matches.hero) — a mid-match switch's other heroes are a
  // different question this split isn't asking.
  const groups = db.prepare(`
    SELECT matches.${column} as value,
      COUNT(*) as n,
      ${needsWin ? 'ROUND(AVG(matches.win)*100,1)' : 'NULL'} as win_rate,
      ${needsAcc ? 'COUNT(ash.overall_acc)' : '0'} as n_acc,
      ${needsAcc ? 'ROUND(AVG(ash.overall_acc),1)' : 'NULL'} as mean_acc
    FROM matches
    ${needsAcc ? 'LEFT JOIN aim_stats_heroes ash ON ash.match_id = matches.id AND ash.hero = matches.hero' : ''}
    ${whereValue}
    GROUP BY matches.${column}
    ORDER BY matches.${column}
  `).all(params) as unknown as SplitGroup[];

  return { by: column, metrics, unasked, groups };
}

