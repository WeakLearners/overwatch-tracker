import { Router, Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/schema';

const router = Router();

const CACHE_TTL_DAYS = 7;
const MIN_GAMES_FOR_PICK = 3;

// How many death-logged games a scope needs before we trust its breakdown.
// Death data is sparse (~100 games over 20+ maps), so we fall back map -> map_type -> overall.
const DEATH_GAMES_MIN_MAP = 3;
const DEATH_GAMES_MIN_TYPE = 5;

// Role queue (qp_role + comp_role) locks user to DPS. Open queue allows DPS + Support.
type QueueMode = 'qp_role' | 'comp_role' | 'comp_open';
function allowedRoles(mode: QueueMode): string[] {
  return mode === 'comp_open' ? ['DPS', 'Support'] : ['DPS'];
}

// Heroes the user has played enough to be considered "comfort pool".
const COMFORT_MIN_GAMES = 20;

interface HeroStat { hero: string; role: string; games: number; win_rate: number }
type DeathScope = 'map' | 'map_type' | 'overall';

// Factual death axes (v2 logging). Replaces the old subjective reason tags: the
// player records observable facts about a death, not a felt verdict at the moment
// of dying (which was biased toward "overextended" because that's how it felt).
type Trade = 'traded' | 'free';
type Timing = 'first' | 'middle' | 'last';
type Grouping = 'grouped' | 'alone';
type Awareness = 'saw' | 'caught';
interface DeathRecord { trade: Trade; timing: Timing; grouping: Grouping; awareness: Awareness }

interface AxisStats {
  games: number;   // matches that contributed at least one factual death
  deaths: number;  // total factual death records
  trade: Record<Trade, number>;
  timing: Record<Timing, number>;
  grouping: Record<Grouping, number>;
  awareness: Record<Awareness, number>;
  topPattern: { record: DeathRecord; count: number } | null;
}

// UI/LLM-facing shape: axis distributions as percentages of total deaths.
interface AxisPayload {
  deaths: number;
  games: number;
  trade: { free: number; traded: number };
  timing: { first: number; middle: number; last: number };
  grouping: { alone: number; grouped: number };
  awareness: { caught: number; saw: number };
  top_pattern: { label: string; count: number } | null;
}

function getComfortPool(db: ReturnType<typeof getDb>, mode: QueueMode): HeroStat[] {
  const roles = allowedRoles(mode);
  const placeholders = roles.map(() => '?').join(',');
  // Comfort = at least COMFORT_MIN_GAMES total games on this hero, regardless of mode.
  return db.prepare(`
    SELECT hero, role, COUNT(*) games, ROUND(AVG(win)*100, 1) win_rate
    FROM matches
    WHERE role IN (${placeholders})
    GROUP BY hero, role
    HAVING games >= ${COMFORT_MIN_GAMES}
    ORDER BY games DESC
  `).all(...roles) as unknown as HeroStat[];
}

function pickPrimary(db: ReturnType<typeof getDb>, map: string, mode: QueueMode, pool: HeroStat[]): HeroStat | null {
  if (pool.length === 0) return null;
  const heroNames = pool.map(h => h.hero);
  const placeholders = heroNames.map(() => '?').join(',');
  // Map-specific WR for comfort heroes (any mode — data is too thin to filter by mode for most).
  const onMap = db.prepare(`
    SELECT hero, role, COUNT(*) games, ROUND(AVG(win)*100, 1) win_rate
    FROM matches
    WHERE map = ? AND hero IN (${placeholders})
    GROUP BY hero
    HAVING games >= ${MIN_GAMES_FOR_PICK}
    ORDER BY win_rate DESC, games DESC
  `).all(map, ...heroNames) as unknown as HeroStat[];
  if (onMap.length > 0) return onMap[0];
  // Fallback: best in comfort pool overall.
  return [...pool].sort((a, b) => b.win_rate - a.win_rate)[0];
}

const TRADES: Trade[] = ['traded', 'free'];
const TIMINGS: Timing[] = ['first', 'middle', 'last'];
const GROUPINGS: Grouping[] = ['grouped', 'alone'];
const AWARENESSES: Awareness[] = ['saw', 'caught'];

function isDeathRecord(r: any): r is DeathRecord {
  return !!r && TRADES.includes(r.trade) && TIMINGS.includes(r.timing)
    && GROUPINGS.includes(r.grouping) && AWARENESSES.includes(r.awareness);
}

// Tally the player's factual death axes over a slice of matches. ONLY reads v2
// records — legacy {reasons} rows are deliberately ignored so coaching never
// reasons over the old, bias-prone self-labels we retired.
function axisStats(db: ReturnType<typeof getDb>, where: string, params: unknown[]): AxisStats {
  const rows = db.prepare(
    `SELECT deaths FROM matches WHERE deaths IS NOT NULL ${where}`
  ).all(...(params as any[])) as { deaths: string }[];
  const s: AxisStats = {
    games: 0, deaths: 0,
    trade: { traded: 0, free: 0 },
    timing: { first: 0, middle: 0, last: 0 },
    grouping: { grouped: 0, alone: 0 },
    awareness: { saw: 0, caught: 0 },
    topPattern: null,
  };
  const combos: Record<string, { count: number; record: DeathRecord }> = {};
  for (const r of rows) {
    let d: any;
    try { d = JSON.parse(r.deaths); } catch { continue; }
    if (d?.v !== 2 || !Array.isArray(d.deaths)) continue; // skip legacy reason-format rows
    let contributed = false;
    for (const rec of d.deaths) {
      if (!isDeathRecord(rec)) continue;
      s.deaths++;
      s.trade[rec.trade]++;
      s.timing[rec.timing]++;
      s.grouping[rec.grouping]++;
      s.awareness[rec.awareness]++;
      const key = `${rec.trade}|${rec.timing}|${rec.grouping}|${rec.awareness}`;
      (combos[key] ??= { count: 0, record: rec }).count++;
      contributed = true;
    }
    if (contributed) s.games++;
  }
  const top = Object.values(combos).sort((a, b) => b.count - a.count)[0];
  s.topPattern = top && top.count >= 2 ? top : null; // only surface a pattern that recurs
  return s;
}

// Most specific death slice with enough data to trust: this map -> map type -> overall.
function scopedAxis(db: ReturnType<typeof getDb>, map: string, gameType: string | null):
  { scope: DeathScope; stats: AxisStats } {
  const onMap = axisStats(db, 'AND map = ?', [map]);
  if (onMap.games >= DEATH_GAMES_MIN_MAP) return { scope: 'map', stats: onMap };
  if (gameType) {
    const onType = axisStats(db, 'AND game_type = ?', [gameType]);
    if (onType.games >= DEATH_GAMES_MIN_TYPE) return { scope: 'map_type', stats: onType };
  }
  return { scope: 'overall', stats: axisStats(db, '', []) };
}

// Plain-English summary of one death pattern, for the prompt and the UI.
function describeRecord(r: DeathRecord): string {
  const trade = r.trade === 'free' ? 'wasted' : 'got value';
  const timing = r.timing === 'first' ? 'died first' : r.timing === 'last' ? 'died last (stagger)' : 'died mid-fight';
  const group = r.grouping === 'alone' ? 'alone' : 'grouped';
  const aware = r.awareness === 'caught' ? 'caught out' : 'read it';
  return `${trade}, ${timing}, ${group}, ${aware}`;
}

function pct(n: number, total: number): number { return total ? Math.round((n / total) * 100) : 0; }

function toAxisPayload(s: AxisStats): AxisPayload {
  const t = s.deaths;
  return {
    deaths: s.deaths,
    games: s.games,
    trade: { free: pct(s.trade.free, t), traded: pct(s.trade.traded, t) },
    timing: { first: pct(s.timing.first, t), middle: pct(s.timing.middle, t), last: pct(s.timing.last, t) },
    grouping: { alone: pct(s.grouping.alone, t), grouped: pct(s.grouping.grouped, t) },
    awareness: { caught: pct(s.awareness.caught, t), saw: pct(s.awareness.saw, t) },
    top_pattern: s.topPattern ? { label: describeRecord(s.topPattern.record), count: s.topPattern.count } : null,
  };
}

function getMapContext(db: ReturnType<typeof getDb>, map: string): { games: number; win_rate: number | null; game_type: string | null } {
  const row = db.prepare(`
    SELECT COUNT(*) games, ROUND(AVG(win)*100,1) win_rate,
           (SELECT game_type FROM matches WHERE map = ? LIMIT 1) game_type
    FROM matches WHERE map = ?
  `).get(map, map) as any;
  return { games: row?.games ?? 0, win_rate: row?.win_rate ?? null, game_type: row?.game_type ?? null };
}

interface RecommendationPayload {
  primary: string;
  stretch: string | null;
  // true when `stretch` is a general-meta hero the player has NEVER played
  // (from the untested pool); false when grounded in their own stats.
  stretch_untested: boolean;
  insight: string;
  // Factual death-axis distribution for the chosen scope; null until the player
  // has logged matches with the new tagger (legacy data is never used here).
  death_axes: AxisPayload | null;
  death_scope: DeathScope;
  primary_stats: { games: number; win_rate: number } | null;
  user_map_stats: { games: number; win_rate: number | null };
  cached: boolean;
}

// Heroes the user has played at least once in the allowed roles for this mode.
// Intersected with the canonical roster so legacy/typo'd names don't leak through.
interface StretchCandidate {
  hero: string;
  role: string;
  career_games: number;
  career_win_rate: number;
  map_games: number;
  map_win_rate: number | null;
}

// Stretch candidates = heroes the user has actually played (in allowed roles)
// but that aren't already in their comfort pool. Enriched with career stats and
// this-map stats so the model can rank by the player's REAL performance instead
// of guessing a generic meta pick (which always collapsed onto Cassidy).
function getStretchCandidates(
  db: ReturnType<typeof getDb>,
  map: string,
  mode: QueueMode,
  poolHeroes: Set<string>,
): StretchCandidate[] {
  const roles = allowedRoles(mode);
  const placeholders = roles.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT hero, role,
      COUNT(*) career_games,
      ROUND(AVG(win)*100, 1) career_win_rate,
      SUM(CASE WHEN map = ? THEN 1 ELSE 0 END) map_games,
      ROUND(AVG(CASE WHEN map = ? THEN win*100.0 END), 1) map_win_rate
    FROM matches
    WHERE role IN (${placeholders})
    GROUP BY hero, role
    ORDER BY map_games DESC, career_games DESC
  `).all(map, map, ...roles) as unknown as StretchCandidate[];
  const canonical = new Set(ALL_HEROES_BY_ROLE(roles));
  return rows
    // Require a minimum sample so a 1-game fluke isn't sold as "grounded".
    // Thinner heroes fall through to the untested pool, which is labeled as such.
    .filter(r => canonical.has(r.hero) && !poolHeroes.has(r.hero) && r.career_games >= MIN_GAMES_FOR_PICK)
    .slice(0, 12);
}

// Heroes in the allowed roles the player has NEVER logged. These are pure
// general-meta suggestions (no personal stats exist), used only as a fallback
// when the grounded stretch pool is empty or weak. Picks from here are flagged
// "untested" so the UI can label them as out-of-data, not from the player's log.
function getUntestedMetaPool(
  db: ReturnType<typeof getDb>,
  mode: QueueMode,
  exclude: Set<string>,
): string[] {
  const roles = allowedRoles(mode);
  const placeholders = roles.map(() => '?').join(',');
  const played = new Set(
    (db.prepare(`SELECT DISTINCT hero FROM matches WHERE role IN (${placeholders})`)
      .all(...roles) as { hero: string }[]).map(r => r.hero),
  );
  return ALL_HEROES_BY_ROLE(roles).filter(h => !played.has(h) && !exclude.has(h));
}

// Only the LLM insight + stretch pick are cached. The death breakdown and
// hero stats are recomputed live on every request (cheap, and reflects newly
// logged matches even on a cache hit). focus_json now holds { insight }.
function readCachedInsight(db: ReturnType<typeof getDb>, map: string, mode: QueueMode): { insight: string; stretch: string | null; stretchUntested: boolean } | null {
  const row = db.prepare(`
    SELECT stretch_hero, focus_json, created_at
    FROM advisor_cache WHERE map = ? AND queue_mode = ?
  `).get(map, mode) as any;
  if (!row) return null;
  const ageMs = Date.now() - new Date(row.created_at + 'Z').getTime();
  if (ageMs > CACHE_TTL_DAYS * 24 * 60 * 60 * 1000) return null;
  try {
    const parsed = JSON.parse(row.focus_json);
    if (typeof parsed?.insight !== 'string') return null; // old array format -> regenerate
    return { insight: parsed.insight, stretch: row.stretch_hero ?? null, stretchUntested: parsed.stretchUntested === true };
  } catch { return null; }
}

function writeCache(db: ReturnType<typeof getDb>, map: string, mode: QueueMode, primary: string, stretch: string | null, stretchUntested: boolean, insight: string) {
  db.prepare(`
    INSERT INTO advisor_cache (map, queue_mode, primary_hero, stretch_hero, focus_json, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(map, queue_mode) DO UPDATE SET
      primary_hero = excluded.primary_hero,
      stretch_hero = excluded.stretch_hero,
      focus_json   = excluded.focus_json,
      created_at   = excluded.created_at
  `).run(map, mode, primary, stretch, JSON.stringify({ insight, stretchUntested }));
}

function buildSchema(hasStretchPool: boolean) {
  const props: any = {
    insight: {
      type: 'string',
      description: "One plain-English coaching insight, max 35 words, grounded in the player's death AXIS numbers. Name the dominant pattern with a percentage (e.g. 'X% of your deaths are wasted' or 'you die first in Y% of fights'), say whether it's a recurring habit or map-specific (compare deaths_here vs deaths_overall), and give one concrete BEHAVIORAL adjustment. If note_no_death_data is present, instead return one sentence saying death coaching unlocks once they tag a few matches. Never invent map geometry.",
    },
  };
  const required = ['insight'];
  if (hasStretchPool) {
    props.stretch = {
      type: 'string',
      description: "The stretch hero to suggest. PREFER candidate_stretch_pool (heroes the player has actually played, with stats): pick the entry with the strongest performance for this map+mode — rank by map_win_rate (weighted by map_games), falling back to career_win_rate when the this-map sample is thin. Only when candidate_stretch_pool is empty OR every grounded option is weak (career_win_rate below ~45% on a thin sample) may you instead pick from untested_meta_pool. Must exactly match a name from whichever pool you chose.",
    };
    props.stretch_untested = {
      type: 'boolean',
      description: 'true if `stretch` was taken from untested_meta_pool (a hero the player has NEVER played, suggested on general meta); false if taken from candidate_stretch_pool (grounded in their own stats).',
    };
    required.push('stretch', 'stretch_untested');
  }
  return { type: 'object', properties: props, required, additionalProperties: false };
}

const SYSTEM_PROMPT = `You are an Overwatch 2 coach writing ONE grounded insight for an intermediate-rank player before a match. You are given REAL statistics computed from this player's own logged deaths — use them.

HARD RULES — these override everything else:
- Ground every claim in the death AXIS numbers provided. Quote a percentage from the data.
- Do NOT invent map geometry: no lanes, rooms, ledges, high-ground callouts, choke names, or "slide to X" spots. You have no reliable map knowledge and the player found invented callouts useless and confusing.
- Coach the BEHAVIOR the axes point to, not a location.
- Compare deaths_here against deaths_overall: if the dominant pattern matches their overall pattern, name it a recurring habit; if it spikes only here, say it's map-specific.
- Plain, readable English. One full sentence. No cryptic shorthand.
- If note_no_death_data is present, do NOT invent any death analysis — return one short sentence telling the player death coaching unlocks once they tag a few matches with the new death logger.

Death axes (objective facts the player logged about each death — read them, do not relabel):
- trade: "traded" = the death GOT VALUE — a kill, real damage, a forced enemy cooldown/ult, OR space/pressure the team gained from the play (including a deliberate sacrifice like ulting to take space); "free" = WASTED — died and nothing shifted. A high free% means deaths are costing you for nothing. In your insight, call these "wasted" / "got value", not "free" / "traded".
- timing: "first" = died first in the fight (entering before the team / over-eager); "middle" = died mid-trade; "last" = died last or staggered (fighting a lost fight / bad disengage).
- grouping: "alone" = split off from the team when you died (isolated); "grouped" = died with the team around you.
- awareness: "caught" = died to information they did NOT have (an unseen flanker, a hidden teammate, an angle they never checked); "saw" = they HAD the full read and died anyway (lost a fair duel, or knowingly took a risky play).
Interpretation hints: free+alone+caught = dying isolated to info gaps (work pre-fight information and staying with the team); high first% = entry timing; high last% = disengage discipline; high caught% = recurring information/awareness gaps; high saw% = the reads were there — the loss was on fight selection or execution.

Stretch pick — you may be given two pools:
- candidate_stretch_pool (PREFERRED): heroes the player has actually played but doesn't main. Each entry has their own stats: career_games, career_win_rate, map_games (games on THIS map), map_win_rate (win rate on THIS map, null if none). Rank by performance ON THIS MAP first — highest map_win_rate backed by a meaningful map_games sample; fall back to career_win_rate when map sample is thin. This is grounded in real data; always prefer it.
- untested_meta_pool (FALLBACK ONLY): heroes the player has NEVER played, so there is no personal data. Only pick from here when candidate_stretch_pool is empty, or when every grounded option is weak (career_win_rate below ~45% on a thin sample). When you do, choose a hero you have genuine competitive knowledge of for this map and queue mode, and set stretch_untested=true. If you pick from the grounded pool, set stretch_untested=false.
- Never invent a hero outside the pools you were given.

Queue context:
- Open queue = 6v6, no role lock, expect double tank.
- Role queue = 5v5, one tank.`;

router.get('/recommend', async (req: Request, res: Response) => {
  const db = getDb();
  const map = (req.query.map as string | undefined)?.trim();
  const mode = (req.query.queue_mode as QueueMode | undefined) ?? 'comp_role';
  const refresh = req.query.refresh === '1';

  if (!map) {
    res.status(400).json({ error: 'map is required' });
    return;
  }
  if (!['qp_role', 'comp_role', 'comp_open'].includes(mode)) {
    res.status(400).json({ error: 'invalid queue_mode' });
    return;
  }

  const pool = getComfortPool(db, mode);
  const primary = pickPrimary(db, map, mode, pool);
  const mapCtx = getMapContext(db, map);

  if (!primary) {
    res.status(404).json({ error: `No comfort heroes available for ${mode}` });
    return;
  }

  // Death axes are recomputed live every request (cheap) so they always reflect
  // the latest logged matches, even when the LLM insight is cached.
  const { scope: deathScope, stats: axes } = scopedAxis(db, map, mapCtx.game_type);
  const hasDeathData = axes.deaths > 0;
  const deathFields = {
    death_axes: hasDeathData ? toAxisPayload(axes) : null,
    death_scope: deathScope,
  };
  const statFields = {
    primary_stats: { games: primary.games, win_rate: primary.win_rate },
    user_map_stats: { games: mapCtx.games, win_rate: mapCtx.win_rate },
  };

  // Cache check (skip on refresh)
  if (!refresh) {
    const cached = readCachedInsight(db, map, mode);
    if (cached) {
      res.json({
        primary: primary.hero,
        stretch: cached.stretch,
        stretch_untested: cached.stretchUntested,
        insight: cached.insight,
        ...deathFields,
        ...statFields,
        cached: true,
      } satisfies RecommendationPayload);
      return;
    }
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(503).json({
      error: 'ANTHROPIC_API_KEY not set. Add it to your environment to enable tactical recommendations.',
    });
    return;
  }

  // Overall pattern for the model to compare against (recurring habit vs. map spike).
  const overallAxes = axisStats(db, '', []);
  // Stretch candidates = heroes the user has ACTUALLY played in the allowed roles,
  // minus their comfort pool. Never recommends heroes they've never touched. Each
  // candidate carries career + this-map win rates so the pick is grounded in data.
  const poolHeroes = new Set(pool.map(h => h.hero));
  const stretchCandidates = getStretchCandidates(db, map, mode, poolHeroes);
  // Fallback pool of never-played meta heroes, so role-queue players with a
  // narrow hero pool still get a varied stretch suggestion (clearly flagged
  // "untested" since it isn't backed by their own data).
  const untestedMeta = getUntestedMetaPool(db, mode, poolHeroes);
  const hasStretch = stretchCandidates.length > 0 || untestedMeta.length > 0;

  const scopeLabel = deathScope === 'map'
    ? `this exact map (${map})`
    : deathScope === 'map_type'
      ? `${mapCtx.game_type} maps (not enough ${map} games logged)`
      : `all maps (not enough ${map}/${mapCtx.game_type} games logged)`;

  const userPayload: Record<string, unknown> = {
    map,
    game_type: mapCtx.game_type,
    queue_mode: mode,
    queue_mode_label: mode === 'comp_open' ? '6v6 Open Queue (no role lock)' : mode === 'qp_role' ? 'Quick Play Role Queue (5v5, DPS locked)' : 'Competitive Role Queue (5v5, DPS locked)',
    primary_hero: primary.hero,
    primary_role: primary.role,
    primary_stats: { career_games: primary.games, career_win_rate: primary.win_rate },
    user_map_win_rate: mapCtx.win_rate,
    user_map_games: mapCtx.games,
  };
  if (hasDeathData) {
    userPayload.deaths_here = { scope: scopeLabel, ...toAxisPayload(axes) };
    if (overallAxes.deaths > 0) userPayload.deaths_overall = toAxisPayload(overallAxes);
  } else {
    userPayload.note_no_death_data = 'No factual death tags logged yet. Do NOT invent death analysis — give a one-sentence note that death-pattern coaching appears once they tag a few matches with the new death logger.';
  }
  if (stretchCandidates.length > 0) {
    userPayload.candidate_stretch_pool = stretchCandidates.map(c => ({
      hero: c.hero,
      career_games: c.career_games,
      career_win_rate: c.career_win_rate,
      map_games: c.map_games,
      map_win_rate: c.map_win_rate,
    }));
  }
  if (untestedMeta.length > 0) {
    userPayload.untested_meta_pool = untestedMeta;
  }
  if (!hasStretch) {
    userPayload.note_no_stretch = 'User has no eligible stretch heroes — return only the insight.';
  }

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 600,
      system: SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: buildSchema(hasStretch) } } as any,
      messages: [{
        role: 'user',
        content: `Pre-match context:\n${JSON.stringify(userPayload, null, 2)}\n\nReturn ${hasStretch ? 'the stretch pick and ' : ''}one grounded insight.`,
      }],
    });

    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (!textBlock) throw new Error('No text response from model');
    const parsed = JSON.parse(textBlock.text) as { stretch?: string; insight: string };
    const insight = parsed.insight;
    // Trust the pools, not the model's self-label: derive grounded/untested from
    // which list the pick actually came from, and drop anything in neither pool.
    const groundedSet = new Set(stretchCandidates.map(c => c.hero));
    const untestedSet = new Set(untestedMeta);
    const rawStretch = parsed.stretch ?? null;
    const stretch = rawStretch && (groundedSet.has(rawStretch) || untestedSet.has(rawStretch)) ? rawStretch : null;
    const stretchUntested = stretch != null && !groundedSet.has(stretch);

    writeCache(db, map, mode, primary.hero, stretch, stretchUntested, insight);

    res.json({
      primary: primary.hero,
      stretch,
      stretch_untested: stretchUntested,
      insight,
      ...deathFields,
      ...statFields,
      cached: false,
    } satisfies RecommendationPayload);
  } catch (err: any) {
    console.error('[advisor] LLM call failed:', err?.message ?? err);
    res.status(502).json({ error: `Advisor LLM call failed: ${err?.message ?? 'unknown error'}` });
  }
});

// Static list of all heroes by role — kept in sync with the client's HEROES map.
// (Server-side so we don't depend on importing client code.)
const HEROES_BY_ROLE: Record<string, string[]> = {
  DPS: ['Anran', 'Ashe', 'Bastion', 'Cassidy', 'Echo', 'Emre', 'Freja', 'Genji', 'Hanzo', 'Junkrat', 'Mei', 'Pharah', 'Reaper', 'Shion', 'Sierra', 'Sojourn', 'Soldier: 76', 'Sombra', 'Symmetra', 'Torbjorn', 'Tracer', 'Vendetta', 'Venture', 'Widowmaker'],
  Support: ['Ana', 'Baptiste', 'Brigitte', 'Illari', 'Jetpack Cat', 'Juno', 'Kiriko', 'Lifeweaver', 'Lucio', 'Mercy', 'Mizuki', 'Moira', 'Wuyang', 'Zenyatta'],
  Tank: ['D.Va', 'Domina', 'Doomfist', 'Hazard', 'Junker Queen', 'Mauga', 'Orisa', 'Ramattra', 'Reinhardt', 'Roadhog', 'Sigma', 'Winston', 'Wrecking Ball', 'Zarya'],
};
function ALL_HEROES_BY_ROLE(roles: string[]): string[] {
  return roles.flatMap(r => HEROES_BY_ROLE[r] ?? []);
}

export default router;
