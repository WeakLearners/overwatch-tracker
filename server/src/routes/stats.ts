import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';

const router = Router();

function whereClause(q: Record<string, string>): [string, Record<string, string>] {
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  if (q.from) { clauses.push('date >= :from'); params.from = q.from; }
  if (q.to) { clauses.push('date <= :to'); params.to = q.to; }
  if (q.role) { clauses.push('role = :role'); params.role = q.role; }
  if (q.queue_mode) { clauses.push('queue_mode = :queue_mode'); params.queue_mode = q.queue_mode; }
  return [clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params];
}

router.get('/overview', (req: Request, res: Response) => {
  const db = getDb();
  const [where, params] = whereClause(req.query as Record<string, string>);
  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(win) as wins,
      ROUND(AVG(win) * 100, 1) as win_rate,
      COUNT(DISTINCT map) as maps_played
    FROM matches ${where}
  `).get(params) as Record<string, unknown>;
  // Distinct heroes played, including switches — from the hero-attribution
  // view, not raw matches, so a hero only ever played as a mid-match switch
  // still counts.
  const { heroes_played } = db.prepare(`
    SELECT COUNT(DISTINCT hero) as heroes_played FROM matches_by_hero ${where}
  `).get(params) as { heroes_played: number };
  res.json({ ...row, heroes_played });
});

router.get('/by-hero', (req: Request, res: Response) => {
  const db = getDb();
  const [where, params] = whereClause(req.query as Record<string, string>);
  const rows = db.prepare(`
    SELECT
      hero, role,
      COUNT(*) as games,
      SUM(win) as wins,
      ROUND(AVG(win) * 100, 1) as win_rate
    FROM matches_by_hero ${where}
    GROUP BY hero, role
    HAVING games >= 3
    ORDER BY games DESC
  `).all(params);
  res.json(rows);
});

router.get('/by-map', (req: Request, res: Response) => {
  const db = getDb();
  const [where, params] = whereClause(req.query as Record<string, string>);
  const rows = db.prepare(`
    SELECT
      map, game_type,
      COUNT(*) as games,
      SUM(win) as wins,
      ROUND(AVG(win) * 100, 1) as win_rate
    FROM matches ${where}
    GROUP BY map, game_type
    HAVING games >= 3
    ORDER BY game_type, map
  `).all(params);
  res.json(rows);
});

// Per-map match counts for a single day (used to annotate map names in the UI
// with "played N times today"). No HAVING floor — a single game still counts.
router.get('/map-counts', (req: Request, res: Response) => {
  const db = getDb();
  const date = (req.query.date as string) ?? '';
  const rows = db.prepare(`
    SELECT map, COUNT(*) as n
    FROM matches
    WHERE date = :date
    GROUP BY map
  `).all({ date }) as { map: string; n: number }[];
  const counts = Object.fromEntries(rows.map(r => [r.map, r.n]));
  res.json({ counts });
});

// Per-hero match counts for a single day (used to annotate hero names in the UI
// with "played N times today"). No HAVING floor — a single game still counts.
router.get('/hero-counts', (req: Request, res: Response) => {
  const db = getDb();
  const date = (req.query.date as string) ?? '';
  const rows = db.prepare(`
    SELECT hero, COUNT(*) as n
    FROM matches_by_hero
    WHERE date = :date
    GROUP BY hero
  `).all({ date }) as { hero: string; n: number }[];
  const counts = Object.fromEntries(rows.map(r => [r.hero, r.n]));
  res.json({ counts });
});

router.get('/by-hour', (req: Request, res: Response) => {
  const db = getDb();
  const [where, params] = whereClause(req.query as Record<string, string>);
  const whereWithHour = where
    ? where + ' AND hour IS NOT NULL'
    : 'WHERE hour IS NOT NULL';
  const rows = db.prepare(`
    SELECT
      hour,
      COUNT(*) as games,
      SUM(win) as wins,
      ROUND(AVG(win) * 100, 1) as win_rate,
      COUNT(CASE WHEN queue_mode = 'qp_role' THEN 1 END) as qp_games,
      ROUND(AVG(CASE WHEN queue_mode = 'qp_role' THEN win END) * 100, 1) as qp_win_rate,
      COUNT(CASE WHEN queue_mode IN ('comp_role', 'comp_open') THEN 1 END) as comp_games,
      ROUND(AVG(CASE WHEN queue_mode IN ('comp_role', 'comp_open') THEN win END) * 100, 1) as comp_win_rate
    FROM matches ${whereWithHour}
    GROUP BY hour
    ORDER BY hour
  `).all(params);
  res.json(rows);
});

router.get('/by-day', (req: Request, res: Response) => {
  const db = getDb();
  const [where, params] = whereClause(req.query as Record<string, string>);
  const whereWithDay = where
    ? where + ' AND day_of_week IS NOT NULL'
    : 'WHERE day_of_week IS NOT NULL';
  const rows = db.prepare(`
    SELECT
      day_of_week,
      COUNT(*) as games,
      SUM(win) as wins,
      ROUND(AVG(win) * 100, 1) as win_rate
    FROM matches ${whereWithDay}
    GROUP BY day_of_week
    ORDER BY MIN(CASE day_of_week
      WHEN 'Monday' THEN 1 WHEN 'Tuesday' THEN 2 WHEN 'Wednesday' THEN 3
      WHEN 'Thursday' THEN 4 WHEN 'Friday' THEN 5 WHEN 'Saturday' THEN 6
      WHEN 'Sunday' THEN 7 END)
  `).all(params);
  res.json(rows);
});

router.get('/by-type', (req: Request, res: Response) => {
  const db = getDb();
  const [where, params] = whereClause(req.query as Record<string, string>);
  const rows = db.prepare(`
    SELECT
      game_type,
      COUNT(*) as games,
      SUM(win) as wins,
      ROUND(AVG(win) * 100, 1) as win_rate
    FROM matches ${where}
    GROUP BY game_type
    ORDER BY games DESC
  `).all(params);
  res.json(rows);
});

router.get('/trends', (req: Request, res: Response) => {
  const db = getDb();
  const { window = '20' } = req.query as Record<string, string>;
  const w = Math.max(1, Math.min(100, parseInt(window)));
  const rows = db.prepare(`
    SELECT
      id, date, hero, map, game_type, win, queue_mode, player_rank,
      ROUND(AVG(win) OVER (ORDER BY date, time ROWS BETWEEN ${w - 1} PRECEDING AND CURRENT ROW) * 100, 1) as rolling_win_rate
    FROM matches
    ORDER BY date, time
  `).all({});
  res.json(rows);
});

router.get('/prematch', (req: Request, res: Response) => {
  const db = getDb();
  const { map, game_type, hour, day_of_week } = req.query as Record<string, string>;

  const byHero = map ? db.prepare(`
    SELECT hero, role, COUNT(*) as games, SUM(win) as wins,
           ROUND(AVG(win) * 100, 1) as win_rate
    FROM matches_by_hero WHERE map = :map ${game_type ? 'AND game_type = :game_type' : ''}
    GROUP BY hero ORDER BY win_rate DESC
  `).all({ map, ...(game_type ? { game_type } : {}) }) : [];

  const timeContext = db.prepare(`
    SELECT
      ROUND(AVG(CASE WHEN hour = :hour THEN win END) * 100, 1) as hour_win_rate,
      ROUND(AVG(CASE WHEN day_of_week = :day THEN win END) * 100, 1) as day_win_rate,
      COUNT(CASE WHEN hour = :hour THEN 1 END) as hour_games,
      COUNT(CASE WHEN day_of_week = :day THEN 1 END) as day_games
    FROM matches
  `).get({ hour: parseInt(hour ?? '-1'), day: day_of_week ?? '' });

  const bestHeroesRaw = db.prepare(`
    SELECT hero, role, COUNT(*) as games, SUM(win) as wins,
           ROUND(AVG(win) * 100, 1) as win_rate
    FROM matches_by_hero GROUP BY hero HAVING games >= 5
    ORDER BY role, win_rate DESC
  `).all({}) as any[];
  const roleCounts: Record<string, number> = {};
  const bestHeroes = bestHeroesRaw.filter(h => {
    roleCounts[h.role] = (roleCounts[h.role] ?? 0) + 1;
    return roleCounts[h.role] <= 3;
  });

  // Session: how many games played today, tilt detection, depth win rate
  const today = new Date().toISOString().slice(0, 10);
  const todayResults = db.prepare(
    `SELECT win FROM matches WHERE date = ? ORDER BY time DESC`
  ).all(today) as { win: number }[];

  const gamesPlayedToday = todayResults.length;
  const nextGamePos = gamesPlayedToday + 1;
  const onTilt = gamesPlayedToday >= 2 && todayResults[0].win === 0 && todayResults[1].win === 0;

  const depthRow = db.prepare(`
    SELECT ROUND(AVG(win)*100,1) as win_rate, COUNT(*) as games FROM (
      SELECT win, ROW_NUMBER() OVER (PARTITION BY date ORDER BY time) as pos
      FROM matches
    ) WHERE pos = ?
  `).get(nextGamePos) as { win_rate: number; games: number } | undefined;

  // Win rate historically when the previous 2 same-day games were losses
  const tiltRow = db.prepare(`
    WITH numbered AS (
      SELECT win,
             LAG(win,1) OVER (PARTITION BY date ORDER BY time) as prev1,
             LAG(win,2) OVER (PARTITION BY date ORDER BY time) as prev2
      FROM matches
    )
    SELECT ROUND(AVG(win)*100, 1) as win_rate, COUNT(*) as games
    FROM numbered WHERE prev1 = 0 AND prev2 = 0
  `).get({}) as { win_rate: number; games: number } | undefined;

  const session = {
    games_today: gamesPlayedToday,
    next_game_pos: nextGamePos,
    on_tilt: onTilt,
    last3: todayResults.slice(0, 3).map(r => r.win === 1),
    depth_win_rate: depthRow?.win_rate ?? null,
    depth_games: depthRow?.games ?? 0,
    tilt_win_rate: tiltRow?.win_rate ?? null,
    tilt_games: tiltRow?.games ?? 0,
  };

  // Best hero for the current game type (cross-type optimizer)
  const bestByGameType = game_type ? db.prepare(`
    SELECT hero, role, COUNT(*) as games, ROUND(AVG(win)*100,1) as win_rate
    FROM matches_by_hero WHERE game_type = :game_type
    GROUP BY hero HAVING games >= 5
    ORDER BY win_rate DESC LIMIT 1
  `).get({ game_type }) : null;

  res.json({ byHero, timeContext, bestHeroes, session, bestByGameType });
});

router.get('/momentum', (req: Request, res: Response) => {
  const db = getDb();

  // "Recent" = last 30 days. "Previous" = the 90 days before that (31-120 days ago).
  // Minimum 5 games in a window before we report it.
  const overall = db.prepare(`
    SELECT
      ROUND(AVG(CASE WHEN date >= date('now','-30 days') THEN win END)*100,1)                                              AS recent_wr,
      ROUND(AVG(CASE WHEN date >= date('now','-120 days') AND date < date('now','-30 days') THEN win END)*100,1)           AS prev_wr,
      COUNT(CASE WHEN date >= date('now','-30 days') THEN 1 END)                                                           AS recent_games,
      COUNT(CASE WHEN date >= date('now','-120 days') AND date < date('now','-30 days') THEN 1 END)                        AS prev_games
    FROM matches
  `).get({});

  // Heroes you're currently playing (>=5 recent games). Those without a solid
  // prior-window baseline (<5 prior games) get is_new=1 — shown as current form,
  // no trajectory arrow, since there's nothing reliable to compare against.
  // Established heroes (real before/after) sort first by trajectory delta.
  const byHero = db.prepare(`
    SELECT hero, role,
      ROUND(AVG(CASE WHEN date >= date('now','-30 days') THEN win END)*100,1)                                              AS recent_wr,
      ROUND(AVG(CASE WHEN date >= date('now','-120 days') AND date < date('now','-30 days') THEN win END)*100,1)           AS prev_wr,
      COUNT(CASE WHEN date >= date('now','-30 days') THEN 1 END)                                                           AS recent_games,
      COUNT(CASE WHEN date >= date('now','-120 days') AND date < date('now','-30 days') THEN 1 END)                        AS prev_games,
      CASE WHEN COUNT(CASE WHEN date >= date('now','-120 days') AND date < date('now','-30 days') THEN 1 END) >= 5 THEN 0 ELSE 1 END AS is_new
    FROM matches_by_hero
    GROUP BY hero
    HAVING recent_games >= 5
    ORDER BY is_new ASC, (COALESCE(recent_wr,0) - COALESCE(prev_wr,0)) DESC, recent_wr DESC
  `).all({});

  const byGameType = db.prepare(`
    SELECT game_type,
      ROUND(AVG(CASE WHEN date >= date('now','-30 days') THEN win END)*100,1)                                              AS recent_wr,
      ROUND(AVG(CASE WHEN date >= date('now','-120 days') AND date < date('now','-30 days') THEN win END)*100,1)           AS prev_wr,
      COUNT(CASE WHEN date >= date('now','-30 days') THEN 1 END)                                                           AS recent_games,
      COUNT(CASE WHEN date >= date('now','-120 days') AND date < date('now','-30 days') THEN 1 END)                        AS prev_games
    FROM matches
    GROUP BY game_type
    HAVING recent_games >= 5 AND prev_games >= 5
    ORDER BY (COALESCE(recent_wr,0) - COALESCE(prev_wr,0)) DESC
  `).all({});

  const byMap = db.prepare(`
    SELECT map, game_type,
      ROUND(AVG(CASE WHEN date >= date('now','-30 days') THEN win END)*100,1)                                              AS recent_wr,
      ROUND(AVG(CASE WHEN date >= date('now','-120 days') AND date < date('now','-30 days') THEN win END)*100,1)           AS prev_wr,
      COUNT(CASE WHEN date >= date('now','-30 days') THEN 1 END)                                                           AS recent_games,
      COUNT(CASE WHEN date >= date('now','-120 days') AND date < date('now','-30 days') THEN 1 END)                        AS prev_games
    FROM matches
    GROUP BY map, game_type
    HAVING recent_games >= 3 AND prev_games >= 10
    ORDER BY (COALESCE(recent_wr,0) - COALESCE(prev_wr,0)) DESC
  `).all({});

  // Win rate by game position within a session day (positions 1–12)
  const sessionDepth = db.prepare(`
    SELECT pos, COUNT(*) AS games, ROUND(AVG(win)*100,1) AS win_rate FROM (
      SELECT win, ROW_NUMBER() OVER (PARTITION BY date ORDER BY time) AS pos
      FROM matches
    ) WHERE pos <= 12
    GROUP BY pos
    HAVING games >= 15
    ORDER BY pos
  `).all({});

  res.json({ overall, byHero, byGameType, byMap, sessionDepth });
});

router.get('/weekly', (req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      strftime('%Y-%W', date) as week,
      MIN(date) as week_start,
      COUNT(*) as games,
      SUM(win) as wins,
      ROUND(AVG(win)*100, 1) as win_rate
    FROM matches
    GROUP BY week
    ORDER BY week DESC
    LIMIT 8
  `).all({});
  res.json((rows as any[]).reverse());
});

router.get('/streaks', (req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT id, date, win FROM matches ORDER BY date, time').all({}) as any[];

  let currentStreakType: 0 | 1 | null = null;
  let longestWin = 0;
  let longestLoss = 0;
  let tempLen = 0;

  for (const r of rows) {
    if (r.win === currentStreakType) {
      tempLen++;
    } else {
      tempLen = 1;
      currentStreakType = r.win as 0 | 1;
    }
    if (r.win === 1 && tempLen > longestWin) longestWin = tempLen;
    if (r.win === 0 && tempLen > longestLoss) longestLoss = tempLen;
  }

  let currentStreak = 0;
  let finalStreakType: 0 | 1 = 0;
  if (rows.length > 0) {
    finalStreakType = rows[rows.length - 1].win as 0 | 1;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].win === finalStreakType) currentStreak++;
      else break;
    }
  }

  res.json({ currentStreak, currentStreakType: finalStreakType, longestWin, longestLoss });
});

router.get('/map-voting', (req: Request, res: Response) => {
  const db = getDb();
  // "recent" = last 90 days; blended = 70% recent + 30% historical
  // Falls back to historical-only when fewer than 3 recent games on a map.
  // The 90-day "recent" window does double duty: it feeds blended_score here
  // and also ranks the Prematch best/worst quick-pick list, which shows
  // current form rather than all-time rate. A separate 100-day window was
  // tried and dropped — it covered 1166 matches against this one's 1146, a
  // 1.7% difference, which did not justify a second near-identical CTE.
  // Grouped by map alone (not map+game_type) — a handful of matches carry a
  // mistagged game_type for their map, and splitting on it let the same map
  // show up twice (once per game_type) with two different win rates, landing
  // in both the Best and Worst lists at once.
  const rows = db.prepare(`
    WITH historical AS (
      SELECT map,
             COUNT(*) AS total_games,
             ROUND(AVG(win) * 100, 1) AS historical_rate
      FROM matches
      WHERE map NOT IN ('Hanaoka', 'Anubis')
      GROUP BY map
      HAVING total_games >= 3
    ),
    recent AS (
      SELECT map,
             COUNT(*) AS recent_games,
             ROUND(AVG(win) * 100, 1) AS recent_rate
      FROM matches
      WHERE date >= date('now', '-90 days')
      GROUP BY map
    )
    SELECT
      h.map,
      h.total_games,
      h.historical_rate,
      COALESCE(r.recent_games, 0) AS recent_games,
      r.recent_rate,
      CASE
        WHEN COALESCE(r.recent_games, 0) >= 3
          THEN ROUND(0.7 * r.recent_rate + 0.3 * h.historical_rate, 1)
        ELSE h.historical_rate
      END AS blended_score
    FROM historical h
    LEFT JOIN recent r ON h.map = r.map
    ORDER BY blended_score DESC
  `).all({});

  res.json(rows);
});

router.get('/hero-cards', (_req: Request, res: Response) => {
  const db = getDb();

  const heroes = db.prepare(`
    SELECT hero, role, COUNT(*) as games, ROUND(AVG(win)*100,1) as win_rate
    FROM matches_by_hero GROUP BY hero HAVING games >= 3 ORDER BY games DESC
  `).all({}) as any[];

  const maps = db.prepare(`
    SELECT hero, map, game_type, COUNT(*) as games, ROUND(AVG(win)*100,1) as win_rate
    FROM matches_by_hero GROUP BY hero, map HAVING games >= 3
  `).all({}) as any[];

  const types = db.prepare(`
    SELECT hero, game_type, COUNT(*) as games, ROUND(AVG(win)*100,1) as win_rate
    FROM matches_by_hero GROUP BY hero, game_type HAVING games >= 5
  `).all({}) as any[];

  // Per-queue-mode win rate for each hero (no min — column shows "—" when thin).
  const modes = db.prepare(`
    SELECT hero, queue_mode, COUNT(*) as games, ROUND(AVG(win)*100,1) as win_rate
    FROM matches_by_hero WHERE queue_mode IS NOT NULL GROUP BY hero, queue_mode
  `).all({}) as any[];

  // Last 60 matches per hero in chronological order for sparkline
  const history = db.prepare(`
    SELECT hero, win FROM matches_by_hero ORDER BY date, time
  `).all({}) as any[];

  const historyByHero: Record<string, number[]> = {};
  for (const row of history) {
    if (!historyByHero[row.hero]) historyByHero[row.hero] = [];
    historyByHero[row.hero].push(row.win);
  }

  // Divide career into equal buckets (min 5 games each) for a standardised sparkline.
  // Every hero ends up with the same noise level regardless of total games played.
  function bucketedRates(wins: number[]): number[] {
    const total   = wins.length;
    const buckets = Math.min(20, Math.floor(total / 5));
    if (buckets < 2) return [Math.round(wins.reduce((s, v) => s + v, 0) / total * 100)];
    const size = total / buckets;
    return Array.from({ length: buckets }, (_, i) => {
      const slice = wins.slice(Math.floor(i * size), Math.floor((i + 1) * size));
      return Math.round(slice.reduce((s, v) => s + v, 0) / slice.length * 100);
    });
  }

  const cards = heroes.map(h => {
    const heroMaps = maps
      .filter((m: any) => m.hero === h.hero)
      .sort((a: any, b: any) => b.win_rate - a.win_rate);
    const heroTypes = types
      .filter((t: any) => t.hero === h.hero)
      .sort((a: any, b: any) => b.win_rate - a.win_rate);
    const wins = historyByHero[h.hero] ?? [];
    const trend = bucketedRates(wins);
    const heroModes = modes.filter((m: any) => m.hero === h.hero);
    return {
      ...h,
      bestMaps:  heroMaps.slice(0, 2),
      worstMaps: [...heroMaps].reverse().slice(0, 2),
      bestType:  heroTypes[0] ?? null,
      worstType: heroTypes[heroTypes.length - 1] ?? null,
      modes: Object.fromEntries(heroModes.map((m: any) => [m.queue_mode, { games: m.games, win_rate: m.win_rate }])),
      trend,
    };
  });

  res.json(cards);
});

router.get('/hero-detail/:hero', (req: Request, res: Response) => {
  const db   = getDb();
  const hero = req.params.hero;

  const overall = db.prepare(`
    SELECT COUNT(*) as games, SUM(win) as wins, SUM(1 - win) as losses,
           ROUND(AVG(win) * 100, 1) as win_rate
    FROM matches_by_hero WHERE hero = :hero
  `).get({ hero }) as any;

  const momentum = db.prepare(`
    SELECT
      ROUND(AVG(CASE WHEN date >= date('now','-30 days') THEN win END) * 100, 1)                                    AS recent_wr,
      ROUND(AVG(CASE WHEN date >= date('now','-120 days') AND date < date('now','-30 days') THEN win END) * 100, 1) AS prev_wr,
      COUNT(CASE WHEN date >= date('now','-30 days') THEN 1 END)                                                    AS recent_games,
      COUNT(CASE WHEN date >= date('now','-120 days') AND date < date('now','-30 days') THEN 1 END)                 AS prev_games
    FROM matches_by_hero WHERE hero = :hero
  `).get({ hero }) as any;

  const maps = db.prepare(`
    SELECT map, game_type, COUNT(*) as games, ROUND(AVG(win) * 100, 1) as win_rate
    FROM matches_by_hero WHERE hero = :hero GROUP BY map HAVING COUNT(*) >= 3
    ORDER BY win_rate DESC
  `).all({ hero }) as any[];

  const types = db.prepare(`
    SELECT game_type, COUNT(*) as games, ROUND(AVG(win) * 100, 1) as win_rate
    FROM matches_by_hero WHERE hero = :hero GROUP BY game_type HAVING COUNT(*) >= 5
    ORDER BY win_rate DESC
  `).all({ hero }) as any[];

  const recent10 = db.prepare(`
    SELECT win, map, date FROM matches_by_hero
    WHERE hero = :hero ORDER BY date DESC, id DESC LIMIT 10
  `).all({ hero }) as any[];

  res.json({
    overall, momentum,
    bestMaps:  maps.slice(0, 3),
    worstMaps: [...maps].reverse().slice(0, 3),
    bestType:  types[0] ?? null,
    worstType: types[types.length - 1] ?? null,
    recent10,
  });
});

router.get('/map-detail/:map', (req: Request, res: Response) => {
  const db  = getDb();
  const map = req.params.map;

  const overall = db.prepare(`
    SELECT COUNT(*) as games, SUM(win) as wins, SUM(1 - win) as losses,
           ROUND(AVG(win) * 100, 1) as win_rate
    FROM matches WHERE map = :map
  `).get({ map }) as any;

  const momentum = db.prepare(`
    SELECT
      ROUND(AVG(CASE WHEN date >= date('now','-30 days') THEN win END) * 100, 1)                                    AS recent_wr,
      ROUND(AVG(CASE WHEN date >= date('now','-120 days') AND date < date('now','-30 days') THEN win END) * 100, 1) AS prev_wr,
      COUNT(CASE WHEN date >= date('now','-30 days') THEN 1 END)                                                    AS recent_games,
      COUNT(CASE WHEN date >= date('now','-120 days') AND date < date('now','-30 days') THEN 1 END)                 AS prev_games
    FROM matches WHERE map = :map
  `).get({ map }) as any;

  const heroRows = db.prepare(`
    SELECT hero, role, COUNT(*) as games, ROUND(AVG(win) * 100, 1) as win_rate
    FROM matches_by_hero WHERE map = :map
    GROUP BY hero, role HAVING COUNT(*) >= 3
    ORDER BY win_rate DESC
  `).all({ map }) as any[];

  const heroes: Record<string, any[]> = { DPS: [], Tank: [], Support: [] };
  for (const h of heroRows) {
    if (heroes[h.role]) heroes[h.role].push(h);
  }
  for (const role of Object.keys(heroes)) heroes[role] = heroes[role].slice(0, 3);

  const recent5 = db.prepare(`
    SELECT win, hero, date FROM matches
    WHERE map = :map ORDER BY date DESC, id DESC LIMIT 10
  `).all({ map }) as any[];

  res.json({ overall, momentum, heroes, recent5 });
});

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
type PerfFeatureKey = typeof PERF_FEATURES[number]['key'];
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
function formatHour(h: number): string {
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

// ── Trends insights ──────────────────────────────────────────────────────────
// Pool of up to 10 one-sentence factoids for the Trends section's 4 random
// cards, drawn from the three analyses above. Only reliable splits (enough
// games on both sides) contribute a factoid — an unreliable one is silently
// dropped from the pool rather than shown as noise. The client draws 4
// distinct factoids from whatever the pool has on every page load.
router.get('/insights', (_req: Request, res: Response) => {
  const db = getDb();
  const hotHand = computeHotHand(db);
  const perf = computePerformanceOutcome(db);
  const queueSwitch = computeQueueSwitchTax(db);
  const critAcc = computeCritAccuracy(db);
  const killSecure = computeKillSecure(db);
  const dayHour = computeDayHourWindow(db);

  // Each factoid is a list of parts rather than one string, so the client can
  // color just the stat numbers (green = the better outcome, red = the worse
  // one) without tinting the whole sentence.
  type Color = 'good' | 'bad';
  type Part = { text: string; color?: Color };
  const t = (text: string): Part => ({ text });
  const c = (text: string, color: Color): Part => ({ text, color });
  const factoids: { id: string; category: string; parts: Part[] }[] = [];

  if (hotHand.reliable && hotHand.gap !== null) {
    if (Math.abs(hotHand.gap) < 3) {
      // No real difference — coloring one side over the other would misstate
      // the finding, so both numbers stay neutral.
      factoids.push({
        id: 'hot-hand', category: 'Hot Hand',
        parts: [
          t(`Wins and losses don't carry over — about the same win rate whether the last game was a win (${hotHand.after_win.win_rate}%) or a loss (${hotHand.after_loss.win_rate}%).`),
        ],
      });
    } else if (hotHand.gap > 0) {
      factoids.push({
        id: 'hot-hand', category: 'Hot Hand',
        parts: [
          t('Momentum carries over: '), c(`${hotHand.after_win.win_rate}%`, 'good'),
          t(' win rate right after a win, vs. '), c(`${hotHand.after_loss.win_rate}%`, 'bad'),
          t(` right after a loss (+${hotHand.gap}pp).`),
        ],
      });
    } else {
      factoids.push({
        id: 'hot-hand', category: 'Hot Hand',
        parts: [
          t('Losses tend to compound: '), c(`${hotHand.after_loss.win_rate}%`, 'good'),
          t(' win rate right after a loss, vs. '), c(`${hotHand.after_win.win_rate}%`, 'bad'),
          t(` right after a win (${hotHand.gap}pp).`),
        ],
      });
    }
  }

  const PERF_UNIT: Record<PerfFeatureKey, string> = { overall_acc: '%', dmg10: '', elims10: '', fb10: '' };
  for (const f of perf.features) {
    if (!f.reliable || f.gap === null || f.baseline === null) continue;
    const aboveIsBetter = f.gap > 0;
    factoids.push({
      id: `perf-${f.key}`,
      category: `Performance · ${f.label}`,
      parts: [
        t(`${f.label} tracks winning ${Math.abs(f.gap) >= 30 ? 'hardest' : 'clearly'}: `),
        c(`${f.aboveWinRate}%`, aboveIsBetter ? 'good' : 'bad'),
        t(` win rate above your average of ${f.baseline}${PERF_UNIT[f.key as PerfFeatureKey]}, vs. just `),
        c(`${f.belowWinRate}%`, aboveIsBetter ? 'bad' : 'good'),
        t(' below it.'),
      ],
    });
  }

  if (perf.mismatch?.reliable) {
    const m = perf.mismatch;
    factoids.push({
      id: 'perf-mismatch',
      category: 'Performance Mismatch',
      parts: [
        t('Played above your own average on most tracked stats and still lost '),
        c(`${m.played_well_loss_rate}%`, 'bad'),
        t(` of the time (${m.played_well_losses} of ${m.played_well_games}). Played below average and still won `),
        c(`${m.played_poor_win_rate}%`, 'good'),
        t(` of the time (${m.played_poor_wins} of ${m.played_poor_games}).`),
      ],
    });
  }

  if (queueSwitch.reliable && queueSwitch.gap !== null) {
    factoids.push({
      id: 'queue-switch-tax',
      category: 'Queue-Mode Switch',
      parts: [
        t('Win rate drops after switching queue modes mid-session: '),
        c(`${queueSwitch.switched.win_rate}%`, 'bad'),
        t(' vs. '), c(`${queueSwitch.same.win_rate}%`, 'good'),
        t(` when staying in the same mode (${queueSwitch.switched.games} vs. ${queueSwitch.same.games} games).`),
      ],
    });
  }

  if (critAcc.reliable && critAcc.gap !== null && critAcc.baseline !== null) {
    const aboveIsBetter = critAcc.gap > 0;
    factoids.push({
      id: 'crit-accuracy',
      category: 'Crit Accuracy',
      parts: [
        t(`Your average crit accuracy is ${critAcc.baseline}%. Games above that win `),
        c(`${critAcc.aboveWinRate}%`, aboveIsBetter ? 'good' : 'bad'),
        t(', games below win '),
        c(`${critAcc.belowWinRate}%`, aboveIsBetter ? 'bad' : 'good'),
        t(` (${critAcc.aboveGames}/${critAcc.belowGames} games) — LOWER accuracy wins more, likely because tougher fights demand more precision, not a target to chase.`),
      ],
    });
  }

  if (killSecure.reliable && killSecure.gap !== null && killSecure.baseline !== null) {
    const aboveIsBetter = killSecure.gap > 0;
    factoids.push({
      id: 'kill-secure',
      category: 'Kill-Secure Rate',
      parts: [
        t(`Your average kill-secure rate (final blows per elim) is ${Math.round(killSecure.baseline * 100)}%. Games above that win `),
        c(`${killSecure.aboveWinRate}%`, aboveIsBetter ? 'good' : 'bad'),
        t(', games below win '),
        c(`${killSecure.belowWinRate}%`, aboveIsBetter ? 'bad' : 'good'),
        t(` (${killSecure.aboveGames}/${killSecure.belowGames} games) — probably reflects solo-closing kills when the team isn't there, not a skill signal.`),
      ],
    });
  }

  if (dayHour.reliable && dayHour.best && dayHour.worst) {
    factoids.push({
      id: 'day-hour-window',
      category: 'Session Window',
      parts: [
        t(`Your best session window is ${dayHour.best.day_of_week} at ${formatHour(dayHour.best.hour)} — `),
        c(`${dayHour.best.wr}%`, 'good'),
        t(` win rate over ${dayHour.best.n} games. Your worst is ${dayHour.worst.day_of_week} at ${formatHour(dayHour.worst.hour)} — `),
        c(`${dayHour.worst.wr}%`, 'bad'),
        t(` over ${dayHour.worst.n} games.`),
      ],
    });
  }

  res.json({ factoids });
});

// Per-queue-mode summary for the side-by-side mode comparison.
// One row per mode the user has actually played, plus that mode's most-played hero.
router.get('/mode-comparison', (_req: Request, res: Response) => {
  const db = getDb();

  const totals = db.prepare(`
    SELECT
      queue_mode,
      COUNT(*) as games,
      SUM(win) as wins,
      ROUND(AVG(win) * 100, 1) as win_rate,
      COUNT(DISTINCT map) as maps_played
    FROM matches
    WHERE queue_mode IS NOT NULL
    GROUP BY queue_mode
  `).all({}) as any[];

  // Distinct heroes played per mode, including switches.
  const heroesPlayedByMode = db.prepare(`
    SELECT queue_mode, COUNT(DISTINCT hero) as heroes_played
    FROM matches_by_hero WHERE queue_mode IS NOT NULL GROUP BY queue_mode
  `).all({}) as { queue_mode: string; heroes_played: number }[];
  const heroesPlayedMap: Record<string, number> = {};
  for (const h of heroesPlayedByMode) heroesPlayedMap[h.queue_mode] = h.heroes_played;

  // Most-played hero per mode (ties broken by win rate), counting switches too.
  const topHeroes = db.prepare(`
    SELECT queue_mode, hero, role, games, win_rate FROM (
      SELECT
        queue_mode, hero, role,
        COUNT(*) as games,
        ROUND(AVG(win) * 100, 1) as win_rate,
        ROW_NUMBER() OVER (
          PARTITION BY queue_mode ORDER BY COUNT(*) DESC, AVG(win) DESC
        ) as rn
      FROM matches_by_hero
      WHERE queue_mode IS NOT NULL
      GROUP BY queue_mode, hero
    ) WHERE rn = 1
  `).all({}) as any[];

  const topByMode: Record<string, any> = {};
  for (const t of topHeroes) {
    topByMode[t.queue_mode] = { hero: t.hero, role: t.role, games: t.games, win_rate: t.win_rate };
  }

  // Recent-form win rate per mode: the headline number on each card. Comp Role
  // has thousands of games, so its all-time rate barely moves per match.
  //
  // We use a trailing TIME window (not a fixed game count): a freshly logged
  // game always lands inside it, so the rate reliably shifts on every log. A
  // fixed N-game window slides — a new game pushes out the Nth-oldest, and if
  // they share a result the average is unchanged, so ~half of logs wouldn't move.
  const RECENT_WINDOW_DAYS = 10;
  const cutoff = new Date(Date.now() - RECENT_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const recent = db.prepare(`
    SELECT queue_mode,
           ROUND(AVG(win) * 100, 1) as recent_win_rate,
           COUNT(*) as recent_games,
           SUM(win) as recent_wins
    FROM matches
    WHERE queue_mode IS NOT NULL AND date >= :cutoff
    GROUP BY queue_mode
  `).all({ cutoff }) as any[];
  const recentByMode: Record<string, any> = {};
  for (const r of recent) recentByMode[r.queue_mode] = r;

  res.json(totals.map(m => ({
    queue_mode: m.queue_mode,
    games: m.games,
    wins: m.wins,
    losses: m.games - m.wins,
    win_rate: m.win_rate,
    recent_win_rate: recentByMode[m.queue_mode]?.recent_win_rate ?? null,
    recent_games: recentByMode[m.queue_mode]?.recent_games ?? 0,
    recent_wins: recentByMode[m.queue_mode]?.recent_wins ?? 0,
    recent_window: RECENT_WINDOW_DAYS,
    heroes_played: heroesPlayedMap[m.queue_mode] ?? 0,
    maps_played: m.maps_played,
    top_hero: topByMode[m.queue_mode] ?? null,
  })));
});

export default router;
