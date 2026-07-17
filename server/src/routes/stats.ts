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
      COUNT(DISTINCT hero) as heroes_played,
      COUNT(DISTINCT map) as maps_played
    FROM matches ${where}
  `).get(params);
  res.json(row);
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
    FROM matches ${where}
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
      ROUND(AVG(win) * 100, 1) as win_rate
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
      id, date, hero, map, game_type, win, queue_mode,
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
    FROM matches WHERE map = :map ${game_type ? 'AND game_type = :game_type' : ''}
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
    FROM matches GROUP BY hero HAVING games >= 5
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
    FROM matches WHERE game_type = :game_type
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
    FROM matches
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
  const rows = db.prepare(`
    WITH historical AS (
      SELECT map, game_type,
             COUNT(*) AS total_games,
             ROUND(AVG(win) * 100, 1) AS historical_rate
      FROM matches
      WHERE map NOT IN ('Hanaoka', 'Anubis')
      GROUP BY map, game_type
      HAVING total_games >= 3
    ),
    recent AS (
      SELECT map, game_type,
             COUNT(*) AS recent_games,
             ROUND(AVG(win) * 100, 1) AS recent_rate
      FROM matches
      WHERE date >= date('now', '-90 days')
      GROUP BY map, game_type
    )
    SELECT
      h.map,
      h.game_type,
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
    LEFT JOIN recent r ON h.map = r.map AND h.game_type = r.game_type
    ORDER BY blended_score DESC
  `).all({});

  res.json(rows);
});

router.get('/hero-cards', (_req: Request, res: Response) => {
  const db = getDb();

  const heroes = db.prepare(`
    SELECT hero, role, COUNT(*) as games, ROUND(AVG(win)*100,1) as win_rate
    FROM matches GROUP BY hero HAVING games >= 3 ORDER BY games DESC
  `).all({}) as any[];

  const maps = db.prepare(`
    SELECT hero, map, game_type, COUNT(*) as games, ROUND(AVG(win)*100,1) as win_rate
    FROM matches GROUP BY hero, map HAVING games >= 3
  `).all({}) as any[];

  const types = db.prepare(`
    SELECT hero, game_type, COUNT(*) as games, ROUND(AVG(win)*100,1) as win_rate
    FROM matches GROUP BY hero, game_type HAVING games >= 5
  `).all({}) as any[];

  // Per-queue-mode win rate for each hero (no min — column shows "—" when thin).
  const modes = db.prepare(`
    SELECT hero, queue_mode, COUNT(*) as games, ROUND(AVG(win)*100,1) as win_rate
    FROM matches WHERE queue_mode IS NOT NULL GROUP BY hero, queue_mode
  `).all({}) as any[];

  // Last 60 matches per hero in chronological order for sparkline
  const history = db.prepare(`
    SELECT hero, win FROM matches ORDER BY date, time
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
    FROM matches WHERE hero = :hero
  `).get({ hero }) as any;

  const momentum = db.prepare(`
    SELECT
      ROUND(AVG(CASE WHEN date >= date('now','-30 days') THEN win END) * 100, 1)                                    AS recent_wr,
      ROUND(AVG(CASE WHEN date >= date('now','-120 days') AND date < date('now','-30 days') THEN win END) * 100, 1) AS prev_wr,
      COUNT(CASE WHEN date >= date('now','-30 days') THEN 1 END)                                                    AS recent_games,
      COUNT(CASE WHEN date >= date('now','-120 days') AND date < date('now','-30 days') THEN 1 END)                 AS prev_games
    FROM matches WHERE hero = :hero
  `).get({ hero }) as any;

  const maps = db.prepare(`
    SELECT map, game_type, COUNT(*) as games, ROUND(AVG(win) * 100, 1) as win_rate
    FROM matches WHERE hero = :hero GROUP BY map HAVING COUNT(*) >= 3
    ORDER BY win_rate DESC
  `).all({ hero }) as any[];

  const types = db.prepare(`
    SELECT game_type, COUNT(*) as games, ROUND(AVG(win) * 100, 1) as win_rate
    FROM matches WHERE hero = :hero GROUP BY game_type HAVING COUNT(*) >= 5
    ORDER BY win_rate DESC
  `).all({ hero }) as any[];

  const recent10 = db.prepare(`
    SELECT win, map, date FROM matches
    WHERE hero = :hero ORDER BY date DESC, id DESC LIMIT 10
  `).all({ hero }) as any[];

  res.json({
    overall, momentum,
    bestMaps:  maps.slice(0, 3),
    worstMaps: [...maps].reverse().slice(0, 3),
    bestType:  types[0] ?? null,
    worstType: types[types.length - 1] ?? null,
    recent10,
    deaths: deathInsights(db, 'AND hero = :hero', { hero }),
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
    FROM matches WHERE map = :map AND hero IS NOT NULL AND role IS NOT NULL
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

  res.json({ overall, momentum, heroes, recent5, deaths: deathInsights(db, 'AND map = :map', { map }) });
});

// Death insights for an arbitrary slice of matches (by hero, by map, or all).
// `where`/`params` are appended to the base "deaths IS NOT NULL" filter.
// Powers the hero/map drawers and the Trends comparison view from one place.
//   - breakdown:  reason -> % of tagged deaths (sum of reason counts)
//   - reasons:    per-reason loss correlation (how much more it shows up in losses)
//   - deaths/game: avg total deaths in wins vs losses (does losing = dying more?)
interface DeathInsights {
  tagged_games: number;
  win_games: number;
  loss_games: number;
  total_deaths: number;
  breakdown: { reason: string; count: number; pct: number }[];
  reasons: { reason: string; in_wins: number; in_losses: number; win_per_match: number; loss_per_match: number; loss_multiplier: number | null }[];
  deaths_per_win: number | null;
  deaths_per_loss: number | null;
  has_outcome_split: boolean;
}

function deathInsights(db: ReturnType<typeof getDb>, where: string, params: Record<string, string>): DeathInsights {
  const rows = (db.prepare(
    `SELECT deaths, win FROM matches WHERE deaths IS NOT NULL ${where}`
  ).all(params) as { deaths: string; win: number }[])
    // Legacy reason-format rows only. New factual-axis (v2) rows are excluded —
    // this view shows the frozen historical death data, not the new tagging.
    .filter(r => { try { return !!JSON.parse(r.deaths)?.reasons; } catch { return false; } });

  const tally: Record<string, { total: number; wins: number; losses: number }> = {};
  let totalDeaths = 0, winGames = 0, lossGames = 0, deathsInWins = 0, deathsInLosses = 0;

  for (const r of rows) {
    let d: any;
    try { d = JSON.parse(r.deaths); } catch { continue; }
    const isWin = r.win === 1;
    if (isWin) winGames++; else lossGames++;
    const gameTotal = typeof d.total === 'number' ? d.total : 0;
    if (isWin) deathsInWins += gameTotal; else deathsInLosses += gameTotal;
    for (const [reason, count] of Object.entries(d.reasons ?? {}) as [string, number][]) {
      if (count <= 0) continue;
      if (!tally[reason]) tally[reason] = { total: 0, wins: 0, losses: 0 };
      tally[reason].total += count;
      tally[reason][isWin ? 'wins' : 'losses'] += count;
      totalDeaths += count;
    }
  }

  const breakdown = Object.entries(tally)
    .sort((a, b) => b[1].total - a[1].total)
    .map(([reason, t]) => ({ reason, count: t.total, pct: totalDeaths ? Math.round((t.total / totalDeaths) * 100) : 0 }));

  const reasons = Object.entries(tally).map(([reason, t]) => {
    const winPer  = winGames  > 0 ? +(t.wins   / winGames).toFixed(2)  : 0;
    const lossPer = lossGames > 0 ? +(t.losses / lossGames).toFixed(2) : 0;
    const multiplier = winPer > 0 ? +(lossPer / winPer).toFixed(2) : null;
    return { reason, in_wins: t.wins, in_losses: t.losses, win_per_match: winPer, loss_per_match: lossPer, loss_multiplier: multiplier };
  }).sort((a, b) => (b.loss_multiplier ?? 0) - (a.loss_multiplier ?? 0));

  return {
    tagged_games: rows.length,
    win_games: winGames,
    loss_games: lossGames,
    total_deaths: totalDeaths,
    breakdown,
    reasons,
    deaths_per_win:  winGames  > 0 ? +(deathsInWins  / winGames).toFixed(1)  : null,
    deaths_per_loss: lossGames > 0 ? +(deathsInLosses / lossGames).toFixed(1) : null,
    has_outcome_split: winGames >= 2 && lossGames >= 2,
  };
}

router.get('/death-trends', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = (db.prepare('SELECT deaths, win FROM matches WHERE deaths IS NOT NULL').all({}) as any[])
    // Legacy reason-format rows only — new factual-axis (v2) rows have no `reasons`.
    .filter(r => { try { return !!JSON.parse(r.deaths)?.reasons; } catch { return false; } });

  if (rows.length === 0) { res.json(null); return; }

  const winMatches  = rows.filter(r => r.win === 1).length;
  const lossMatches = rows.filter(r => r.win === 0).length;
  const totals: Record<string, { total: number; wins: number; losses: number }> = {};

  for (const row of rows) {
    const d = JSON.parse(row.deaths);
    const outcome = row.win === 1 ? 'wins' : 'losses';
    for (const [reason, count] of Object.entries(d.reasons) as [string, number][]) {
      if (!totals[reason]) totals[reason] = { total: 0, wins: 0, losses: 0 };
      totals[reason].total  += count;
      totals[reason][outcome] += count;
    }
  }

  const reasons = Object.entries(totals).map(([reason, t]) => {
    const winRate  = winMatches  > 0 ? +(t.wins  / winMatches).toFixed(2)  : 0;
    const lossRate = lossMatches > 0 ? +(t.losses / lossMatches).toFixed(2) : 0;
    const multiplier = winRate > 0 ? +(lossRate / winRate).toFixed(2) : null;
    return { reason, total: t.total, in_wins: t.wins, in_losses: t.losses, win_per_match: winRate, loss_per_match: lossRate, loss_multiplier: multiplier };
  }).sort((a, b) => (b.loss_multiplier ?? 0) - (a.loss_multiplier ?? 0));

  res.json({ total_matches: rows.length, win_matches: winMatches, loss_matches: lossMatches, reasons });
});

// Heroes and maps that have enough tagged-death data to analyze, each with its
// full death-insight payload. Powers the Trends comparison dropdowns.
const SEGMENT_MIN_TAGGED = 4;
router.get('/death-segments', (_req: Request, res: Response) => {
  const db = getDb();

  const heroRows = db.prepare(`
    SELECT hero, role, COUNT(*) AS n FROM matches WHERE deaths IS NOT NULL
    GROUP BY hero HAVING n >= ${SEGMENT_MIN_TAGGED} ORDER BY n DESC
  `).all({}) as { hero: string; role: string }[];
  // Re-filter on legacy tagged_games: the SQL count includes new factual-axis
  // rows, but deathInsights only counts legacy reason rows, so a segment can fall
  // below the threshold once v2 rows are excluded.
  const heroes = heroRows
    .map(h => ({
      key: h.hero, label: h.hero, role: h.role,
      insights: deathInsights(db, 'AND hero = :hero', { hero: h.hero }),
    }))
    .filter(h => h.insights.tagged_games >= SEGMENT_MIN_TAGGED);

  const mapRows = db.prepare(`
    SELECT map, game_type, COUNT(*) AS n FROM matches WHERE deaths IS NOT NULL
    GROUP BY map HAVING n >= ${SEGMENT_MIN_TAGGED} ORDER BY n DESC
  `).all({}) as { map: string; game_type: string }[];
  const maps = mapRows
    .map(m => ({
      key: m.map, label: m.map, game_type: m.game_type,
      insights: deathInsights(db, 'AND map = :map', { map: m.map }),
    }))
    .filter(m => m.insights.tagged_games >= SEGMENT_MIN_TAGGED);

  res.json({ heroes, maps });
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
      COUNT(DISTINCT hero) as heroes_played,
      COUNT(DISTINCT map) as maps_played
    FROM matches
    WHERE queue_mode IS NOT NULL
    GROUP BY queue_mode
  `).all({}) as any[];

  // Most-played hero per mode (ties broken by win rate).
  const topHeroes = db.prepare(`
    SELECT queue_mode, hero, role, games, win_rate FROM (
      SELECT
        queue_mode, hero, role,
        COUNT(*) as games,
        ROUND(AVG(win) * 100, 1) as win_rate,
        ROW_NUMBER() OVER (
          PARTITION BY queue_mode ORDER BY COUNT(*) DESC, AVG(win) DESC
        ) as rn
      FROM matches
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
    heroes_played: m.heroes_played,
    maps_played: m.maps_played,
    top_hero: topByMode[m.queue_mode] ?? null,
  })));
});

export default router;
