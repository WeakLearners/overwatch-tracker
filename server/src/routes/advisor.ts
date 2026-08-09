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

type QueueMode = 'qp_role' | 'comp_role' | 'comp_open';
// Coaching always surfaces both a DPS and a Support pick, side by side,
// regardless of queue mode — role queue only locks which role you queue AS
// for a given match, not which role's data is worth coaching on.
type AdvisorRole = 'DPS' | 'Support';
const ADVISOR_ROLES: AdvisorRole[] = ['DPS', 'Support'];

// Heroes the user has played enough to be considered "comfort pool".
const COMFORT_MIN_GAMES = 20;

interface HeroStat { hero: string; role: string; games: number; win_rate: number }
type DeathScope = 'map' | 'map_type' | 'overall';

// Factual death axes (v2 logging). Replaces the old subjective reason tags: the
// player records observable facts about a death, not a felt verdict at the moment
// of dying (which was biased toward "overextended" because that's how it felt).
// v3: the player rates ONE axis per death on a 0–1 spectrum. Each axis is
// aggregated independently (its own mean + sample count), so a short match that
// only touched one axis still contributes clean data.
type DeathAxisKey = 'trade' | 'timing' | 'grouping' | 'awareness';
interface DeathRecord { axis: DeathAxisKey; value: number }

// Legacy v2: fully-specified 4-axis record. Still read, decomposed into one
// endpoint sample (0 or 1, or 0.5 for mid timing) per axis — no data loss.
type Trade = 'traded' | 'free';
type Timing = 'first' | 'middle' | 'last';
type Grouping = 'grouped' | 'alone';
type Awareness = 'saw' | 'caught';
interface LegacyDeathRecord { trade: Trade; timing: Timing; grouping: Grouping; awareness: Awareness }

const AXIS_KEYS: DeathAxisKey[] = ['trade', 'timing', 'grouping', 'awareness'];
// Endpoint wording, value→0 (low) and value→1 (high), for the strongest-lean label.
const AXIS_POLES: Record<DeathAxisKey, { low: string; high: string }> = {
  trade:     { low: 'wasted',     high: 'got value' },
  timing:    { low: 'died first', high: 'died last (stagger)' },
  grouping:  { low: 'alone',      high: 'grouped' },
  awareness: { low: 'caught out', high: 'read it' },
};
// An axis needs this many samples, and a mean this far from neutral (0.5),
// before we call it the player's strongest lean.
const STRONG_LEAN_MIN_N = 3;
const STRONG_LEAN_MIN_DIST = 0.1;

interface AxisStats {
  games: number;   // matches that contributed at least one factual death
  deaths: number;  // total factual death records (v2 + v3)
  sums: Record<DeathAxisKey, number>;   // sum of values per axis
  counts: Record<DeathAxisKey, number>; // samples per axis
}

// UI/LLM-facing shape: per-axis mean position (0–1) + sample count.
interface AxisPayload {
  deaths: number;
  games: number;
  axes: Record<DeathAxisKey, { mean: number; n: number }>;
  strongest_lean: { axis: DeathAxisKey; mean: number; n: number; label: string } | null;
}

// Heroes with a currently-active (in-testing) DPI stage set — every
// recommendation surface (Prematch hero picker, Log Match dropdowns, and this
// advisor) is scoped to these so a pick always feeds a running test.
function getInTestingHeroes(db: ReturnType<typeof getDb>): Set<string> {
  const rows = db.prepare(
    `SELECT DISTINCT hero FROM blind_stage_sets WHERE active = 1 AND hero IS NOT NULL`,
  ).all() as { hero: string }[];
  return new Set(rows.map(r => r.hero));
}

function getComfortPool(db: ReturnType<typeof getDb>, role: AdvisorRole, inTesting: Set<string>): HeroStat[] {
  if (inTesting.size === 0) return [];
  const heroPlaceholders = [...inTesting].map(() => '?').join(',');
  // Comfort = at least COMFORT_MIN_GAMES total games on this hero, regardless of mode.
  return db.prepare(`
    SELECT hero, role, COUNT(*) games, ROUND(AVG(win)*100, 1) win_rate
    FROM matches
    WHERE role = ? AND hero IN (${heroPlaceholders})
    GROUP BY hero, role
    HAVING games >= ${COMFORT_MIN_GAMES}
    ORDER BY games DESC
  `).all(role, ...inTesting) as unknown as HeroStat[];
}

function pickPrimary(db: ReturnType<typeof getDb>, map: string, pool: HeroStat[]): HeroStat | null {
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

function isV3Record(r: any): r is DeathRecord {
  return !!r && AXIS_KEYS.includes(r.axis)
    && typeof r.value === 'number' && r.value >= 0 && r.value <= 1;
}

function isLegacyRecord(r: any): r is LegacyDeathRecord {
  return !!r && TRADES.includes(r.trade) && TIMINGS.includes(r.timing)
    && GROUPINGS.includes(r.grouping) && AWARENESSES.includes(r.awareness);
}

// Decompose a legacy 4-axis record into one 0–1 sample per axis, so historical
// v2 data keeps contributing to the same per-axis means as new v3 data.
function legacyToSamples(r: LegacyDeathRecord): Record<DeathAxisKey, number> {
  return {
    trade: r.trade === 'free' ? 0 : 1,
    timing: r.timing === 'first' ? 0 : r.timing === 'last' ? 1 : 0.5,
    grouping: r.grouping === 'alone' ? 0 : 1,
    awareness: r.awareness === 'caught' ? 0 : 1,
  };
}

// Aggregate the player's factual death axes over a slice of matches. Reads both
// v3 (one axis per death) and v2 (full record, decomposed) rows. Legacy {reasons}
// rows are ignored so coaching never reasons over the old, bias-prone self-labels.
function axisStats(db: ReturnType<typeof getDb>, where: string, params: unknown[]): AxisStats {
  const rows = db.prepare(
    `SELECT deaths FROM matches WHERE deaths IS NOT NULL ${where}`
  ).all(...(params as any[])) as { deaths: string }[];
  const s: AxisStats = {
    games: 0, deaths: 0,
    sums: { trade: 0, timing: 0, grouping: 0, awareness: 0 },
    counts: { trade: 0, timing: 0, grouping: 0, awareness: 0 },
  };
  const addSample = (axis: DeathAxisKey, value: number) => {
    s.sums[axis] += value;
    s.counts[axis] += 1;
  };
  for (const r of rows) {
    let d: any;
    try { d = JSON.parse(r.deaths); } catch { continue; }
    if (!Array.isArray(d?.deaths)) continue;
    let contributed = false;
    if (d.v === 3) {
      for (const rec of d.deaths) {
        if (!isV3Record(rec)) continue;
        s.deaths++;
        addSample(rec.axis, rec.value);
        contributed = true;
      }
    } else if (d.v === 2) {
      for (const rec of d.deaths) {
        if (!isLegacyRecord(rec)) continue;
        s.deaths++;
        const samples = legacyToSamples(rec);
        for (const k of AXIS_KEYS) addSample(k, samples[k]);
        contributed = true;
      }
    } else {
      continue; // legacy reason-format rows
    }
    if (contributed) s.games++;
  }
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

// Word an axis mean toward its nearer pole (or "balanced" near 0.5).
function leanPhrase(axis: DeathAxisKey, mean: number): string {
  const poles = AXIS_POLES[axis];
  if (mean > 0.55) return poles.high;
  if (mean < 0.45) return poles.low;
  return 'balanced';
}

function toAxisPayload(s: AxisStats): AxisPayload {
  const axes = {} as Record<DeathAxisKey, { mean: number; n: number }>;
  for (const k of AXIS_KEYS) {
    const n = s.counts[k];
    axes[k] = { mean: n ? +(s.sums[k] / n).toFixed(2) : 0, n };
  }
  // Strongest lean = the axis whose mean sits furthest from neutral, given
  // enough samples and a meaningful tilt.
  let strongest_lean: AxisPayload['strongest_lean'] = null;
  let bestDist = STRONG_LEAN_MIN_DIST;
  for (const k of AXIS_KEYS) {
    const { mean, n } = axes[k];
    if (n < STRONG_LEAN_MIN_N) continue;
    const dist = Math.abs(mean - 0.5);
    if (dist >= bestDist) {
      bestDist = dist;
      strongest_lean = { axis: k, mean, n, label: leanPhrase(k, mean) };
    }
  }
  return { deaths: s.deaths, games: s.games, axes, strongest_lean };
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
  role: AdvisorRole,
  poolHeroes: Set<string>,
  inTesting: Set<string>,
): StretchCandidate[] {
  if (inTesting.size === 0) return [];
  const rows = db.prepare(`
    SELECT hero, role,
      COUNT(*) career_games,
      ROUND(AVG(win)*100, 1) career_win_rate,
      SUM(CASE WHEN map = ? THEN 1 ELSE 0 END) map_games,
      ROUND(AVG(CASE WHEN map = ? THEN win*100.0 END), 1) map_win_rate
    FROM matches
    WHERE role = ?
    GROUP BY hero, role
    ORDER BY map_games DESC, career_games DESC
  `).all(map, map, role) as unknown as StretchCandidate[];
  const canonical = new Set(ALL_HEROES_BY_ROLE([role]));
  return rows
    // Require a minimum sample so a 1-game fluke isn't sold as "grounded".
    // Thinner heroes fall through to the untested pool, which is labeled as such.
    .filter(r => canonical.has(r.hero) && !poolHeroes.has(r.hero) && r.career_games >= MIN_GAMES_FOR_PICK && inTesting.has(r.hero))
    .slice(0, 12);
}

// Heroes in the allowed roles the player has NEVER logged. These are pure
// general-meta suggestions (no personal stats exist), used only as a fallback
// when the grounded stretch pool is empty or weak. Picks from here are flagged
// "untested" so the UI can label them as out-of-data, not from the player's log.
function getUntestedMetaPool(
  db: ReturnType<typeof getDb>,
  role: AdvisorRole,
  exclude: Set<string>,
  inTesting: Set<string>,
): string[] {
  const played = new Set(
    (db.prepare(`SELECT DISTINCT hero FROM matches WHERE role = ?`)
      .all(role) as { hero: string }[]).map(r => r.hero),
  );
  return ALL_HEROES_BY_ROLE([role]).filter(h => !played.has(h) && !exclude.has(h) && inTesting.has(h));
}

interface CachedRoleStretch { stretch: string | null; stretchUntested: boolean }
interface CachedInsight { insight: string; byRole: Record<AdvisorRole, CachedRoleStretch> }

// Only the LLM insight + stretch picks are cached (one LLM call covers both
// roles — the insight is about death patterns, which don't depend on which
// role you're coaching). The death breakdown and hero stats are recomputed
// live on every request (cheap, and reflects newly logged matches even on a
// cache hit). primary_hero/stretch_hero stay informational-only (DPS side)
// now that focus_json carries both roles' stretch picks.
function readCachedInsight(db: ReturnType<typeof getDb>, map: string, mode: QueueMode): CachedInsight | null {
  const row = db.prepare(`
    SELECT focus_json, created_at
    FROM advisor_cache WHERE map = ? AND queue_mode = ?
  `).get(map, mode) as any;
  if (!row) return null;
  const ageMs = Date.now() - new Date(row.created_at + 'Z').getTime();
  if (ageMs > CACHE_TTL_DAYS * 24 * 60 * 60 * 1000) return null;
  try {
    const parsed = JSON.parse(row.focus_json);
    if (typeof parsed?.insight !== 'string' || !parsed?.byRole) return null; // old shape -> regenerate
    return { insight: parsed.insight, byRole: parsed.byRole };
  } catch { return null; }
}

function writeCache(db: ReturnType<typeof getDb>, map: string, mode: QueueMode, primaryDps: string | null, insight: string, byRole: Record<AdvisorRole, CachedRoleStretch>) {
  db.prepare(`
    INSERT INTO advisor_cache (map, queue_mode, primary_hero, stretch_hero, focus_json, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(map, queue_mode) DO UPDATE SET
      primary_hero = excluded.primary_hero,
      stretch_hero = excluded.stretch_hero,
      focus_json   = excluded.focus_json,
      created_at   = excluded.created_at
  `).run(map, mode, primaryDps ?? '', byRole.DPS.stretch, JSON.stringify({ insight, byRole }));
}

// roleHasStretchPool flags which of DPS/Support have a non-empty stretch pool
// to offer — a role with no primary hero at all is excluded entirely (its key
// simply isn't in the map), a role with a primary but no eligible stretch
// pool is included as false (insight-only, no stretch fields required for it).
function buildSchema(roleHasStretchPool: Partial<Record<AdvisorRole, boolean>>) {
  const props: any = {
    insight: {
      type: 'string',
      description: "One plain-English coaching insight, max 35 words, grounded in the player's death AXIS numbers. Each axis has a mean from 0.0 to 1.0 and a sample count n. Name the strongest lean in words (e.g. 'your deaths lean wasted' or 'you tend to die first'), say whether it's a recurring habit or map-specific (compare deaths_here vs deaths_overall), and give one concrete BEHAVIORAL adjustment. If note_no_death_data is present, instead return one sentence saying death coaching unlocks once they tag a few matches. Never invent map geometry. This single insight covers BOTH roles below — it's about the player's death patterns, not role-specific tactics.",
    },
  };
  const required = ['insight'];
  for (const role of ADVISOR_ROLES) {
    if (!roleHasStretchPool[role]) continue;
    const key = role.toLowerCase();
    props[`stretch_${key}`] = {
      type: 'string',
      description: `The stretch ${role} hero to suggest. PREFER candidate_stretch_pool_${key} (heroes the player has actually played, with stats): pick the entry with the strongest performance for this map+mode — rank by map_win_rate (weighted by map_games), falling back to career_win_rate when the this-map sample is thin. Only when candidate_stretch_pool_${key} is empty OR every grounded option is weak (career_win_rate below ~45% on a thin sample) may you instead pick from untested_meta_pool_${key}. Must exactly match a name from whichever pool you chose.`,
    };
    props[`stretch_${key}_untested`] = {
      type: 'boolean',
      description: `true if stretch_${key} was taken from untested_meta_pool_${key} (a hero the player has NEVER played, suggested on general meta); false if taken from candidate_stretch_pool_${key} (grounded in their own stats).`,
    };
    required.push(`stretch_${key}`, `stretch_${key}_untested`);
  }
  return { type: 'object', properties: props, required, additionalProperties: false };
}

const SYSTEM_PROMPT = `You are an Overwatch 2 coach writing ONE grounded insight for an intermediate-rank player before a match. You are given REAL statistics computed from this player's own logged deaths — use them.

HARD RULES — these override everything else:
- Ground every claim in the death AXIS numbers provided. Each axis is a mean from 0.0 to 1.0 with a sample count n; describe the lean in words, and trust an axis less when its n is small.
- Do NOT invent map geometry: no lanes, rooms, ledges, high-ground callouts, choke names, or "slide to X" spots. You have no reliable map knowledge and the player found invented callouts useless and confusing.
- Coach the BEHAVIOR the axes point to, not a location.
- Compare deaths_here against deaths_overall: if the dominant lean matches their overall lean, name it a recurring habit; if it spikes only here, say it's map-specific.
- Plain, readable English. One full sentence. No cryptic shorthand. Do not quote raw decimals at the player — translate them ("lean heavily toward…", "slightly more often…").
- If note_no_death_data is present, do NOT invent any death analysis — return one short sentence telling the player death coaching unlocks once they tag a few matches with the new death logger.

Death axes (each is a spectrum the player rated 0.0–1.0, with a sample count n; strongest_lean flags the axis furthest from neutral):
- trade (0 = wasted, 1 = got value): "got value" = the death earned a kill, real damage, a forced enemy cooldown/ult, OR space/pressure for the team (including a deliberate sacrifice like ulting to take space); "wasted" = died and nothing shifted. A low mean means deaths are costing you for nothing.
- timing (0 = died first, 0.5 = mid-fight, 1 = died last): low = entering before the team / over-eager; high = died last or staggered (fighting a lost fight / bad disengage).
- grouping (0 = alone, 1 = grouped): low = split off from the team when you died (isolated); high = died with the team around you.
- awareness (0 = caught out, 1 = read it): low = died to information you did NOT have (an unseen flanker, a hidden teammate, an angle you never checked); high = you HAD the full read and died anyway (lost a fair duel, or knowingly took a risky play).
Interpretation hints: low trade + low grouping + low awareness = dying isolated to info gaps (work pre-fight information and staying with the team); low timing = entry timing; high timing = disengage discipline; low awareness = recurring information/awareness gaps; high awareness = the reads were there, the loss was on fight selection or execution.

Stretch pick — you're coaching DPS and Support independently, each with its own pair of pools (candidate_stretch_pool_dps/untested_meta_pool_dps, and the _support equivalents), present only for whichever role(s) you were asked for:
- candidate_stretch_pool_<role> (PREFERRED): heroes the player has actually played but doesn't main, in that role. Each entry has their own stats: career_games, career_win_rate, map_games (games on THIS map), map_win_rate (win rate on THIS map, null if none). Rank by performance ON THIS MAP first — highest map_win_rate backed by a meaningful map_games sample; fall back to career_win_rate when map sample is thin. This is grounded in real data; always prefer it.
- untested_meta_pool_<role> (FALLBACK ONLY): heroes the player has NEVER played in that role, so there is no personal data. Only pick from here when candidate_stretch_pool_<role> is empty, or when every grounded option is weak (career_win_rate below ~45% on a thin sample). When you do, choose a hero you have genuine competitive knowledge of for this map and queue mode, and set stretch_<role>_untested=true. If you pick from the grounded pool, set stretch_<role>_untested=false.
- Never invent a hero outside the pools you were given, and never cross roles (a stretch_support pick must come from a support pool, never a dps one).

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

  const inTesting = getInTestingHeroes(db);
  const mapCtx = getMapContext(db, map);

  // Independent primary pick per role — Coaching always shows a DPS column and
  // a Support column side by side, so this is computed for both regardless of
  // queue mode. A role with no in-testing hero meeting COMFORT_MIN_GAMES just
  // gets a null primary (that column renders empty, not an error) unless
  // BOTH roles come back empty, in which case there's nothing to coach at all.
  const roleInfo = Object.fromEntries(ADVISOR_ROLES.map(role => {
    const pool = getComfortPool(db, role, inTesting);
    const primary = pickPrimary(db, map, pool);
    return [role, { pool, primary }];
  })) as Record<AdvisorRole, { pool: HeroStat[]; primary: HeroStat | null }>;

  if (ADVISOR_ROLES.every(r => !roleInfo[r].primary)) {
    res.status(404).json({ error: 'No heroes with an active DPI test available' });
    return;
  }

  // Death axes are role-independent (about the player's death patterns on this
  // map, not which hero/role they're playing) — computed once, shared by both
  // columns. Recomputed live every request (cheap) so it always reflects the
  // latest logged matches, even when the LLM insight is cached.
  const { scope: deathScope, stats: axes } = scopedAxis(db, map, mapCtx.game_type);
  const hasDeathData = axes.deaths > 0;
  const deathFields = {
    death_axes: hasDeathData ? toAxisPayload(axes) : null,
    death_scope: deathScope,
  };

  const buildPayload = (role: AdvisorRole, stretch: string | null, stretchUntested: boolean, insight: string, cached: boolean): RecommendationPayload | null => {
    const primary = roleInfo[role].primary;
    if (!primary) return null;
    return {
      primary: primary.hero,
      stretch,
      stretch_untested: stretchUntested,
      insight,
      ...deathFields,
      primary_stats: { games: primary.games, win_rate: primary.win_rate },
      user_map_stats: { games: mapCtx.games, win_rate: mapCtx.win_rate },
      cached,
    };
  };

  // Cache check (skip on refresh). A cached stretch pick from before its hero's
  // test wrapped up (or before this filter existed) would otherwise keep
  // surfacing a no-longer-in-testing hero for up to CACHE_TTL_DAYS — drop the
  // whole cached entry (both roles) rather than trust a stale pick.
  if (!refresh) {
    const cached = readCachedInsight(db, map, mode);
    const stillFresh = cached && ADVISOR_ROLES.every(role => {
      if (!roleInfo[role].primary) return true; // no column to validate
      const s = cached.byRole[role]?.stretch ?? null;
      return s === null || inTesting.has(s);
    });
    if (cached && stillFresh) {
      res.json(Object.fromEntries(ADVISOR_ROLES.map(role => [
        role, buildPayload(role, cached!.byRole[role]?.stretch ?? null, cached!.byRole[role]?.stretchUntested ?? false, cached!.insight, true),
      ])));
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

  // Stretch pools per role — heroes the user has ACTUALLY played in that role,
  // minus that role's comfort pool. Never recommends heroes they've never
  // touched. Each candidate carries career + this-map win rates so the pick is
  // grounded in data.
  const stretchInfo = Object.fromEntries(ADVISOR_ROLES.map(role => {
    if (!roleInfo[role].primary) return [role, { candidates: [], untested: [] }];
    const poolHeroes = new Set(roleInfo[role].pool.map(h => h.hero));
    const candidates = getStretchCandidates(db, map, role, poolHeroes, inTesting);
    // Fallback pool of never-played meta heroes, so a narrow hero pool still
    // gets a varied stretch suggestion (clearly flagged "untested").
    const untested = getUntestedMetaPool(db, role, poolHeroes, inTesting);
    return [role, { candidates, untested }];
  })) as Record<AdvisorRole, { candidates: StretchCandidate[]; untested: string[] }>;

  const scopeLabel = deathScope === 'map'
    ? `this exact map (${map})`
    : deathScope === 'map_type'
      ? `${mapCtx.game_type} maps (not enough ${map} games logged)`
      : `all maps (not enough ${map}/${mapCtx.game_type} games logged)`;

  const userPayload: Record<string, unknown> = {
    map,
    game_type: mapCtx.game_type,
    queue_mode: mode,
    queue_mode_label: mode === 'comp_open' ? '6v6 Open Queue (no role lock)' : mode === 'qp_role' ? 'Quick Play Role Queue (5v5)' : 'Competitive Role Queue (5v5)',
  };
  for (const role of ADVISOR_ROLES) {
    const primary = roleInfo[role].primary;
    if (!primary) continue;
    const key = role.toLowerCase();
    userPayload[`primary_${key}`] = primary.hero;
    userPayload[`primary_${key}_stats`] = { career_games: primary.games, career_win_rate: primary.win_rate };
    if (stretchInfo[role].candidates.length > 0) {
      userPayload[`candidate_stretch_pool_${key}`] = stretchInfo[role].candidates.map(c => ({
        hero: c.hero,
        career_games: c.career_games,
        career_win_rate: c.career_win_rate,
        map_games: c.map_games,
        map_win_rate: c.map_win_rate,
      }));
    }
    if (stretchInfo[role].untested.length > 0) {
      userPayload[`untested_meta_pool_${key}`] = stretchInfo[role].untested;
    }
  }
  userPayload.user_map_win_rate = mapCtx.win_rate;
  userPayload.user_map_games = mapCtx.games;
  if (hasDeathData) {
    userPayload.deaths_here = { scope: scopeLabel, ...toAxisPayload(axes) };
    if (overallAxes.deaths > 0) userPayload.deaths_overall = toAxisPayload(overallAxes);
  } else {
    userPayload.note_no_death_data = 'No factual death tags logged yet. Do NOT invent death analysis — give a one-sentence note that death-pattern coaching appears once they tag a few matches with the new death logger.';
  }

  const roleHasStretchPool: Partial<Record<AdvisorRole, boolean>> = {};
  for (const role of ADVISOR_ROLES) {
    if (!roleInfo[role].primary) continue;
    roleHasStretchPool[role] = stretchInfo[role].candidates.length > 0 || stretchInfo[role].untested.length > 0;
  }
  const anyStretch = Object.values(roleHasStretchPool).some(Boolean);

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 700,
      system: SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: buildSchema(roleHasStretchPool) } } as any,
      messages: [{
        role: 'user',
        content: `Pre-match context:\n${JSON.stringify(userPayload, null, 2)}\n\nReturn ${anyStretch ? 'the stretch pick(s) and ' : ''}one grounded insight.`,
      }],
    });

    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (!textBlock) throw new Error('No text response from model');
    const parsed = JSON.parse(textBlock.text) as Record<string, unknown> & { insight: string };
    const insight = parsed.insight;

    const byRole = {} as Record<AdvisorRole, CachedRoleStretch>;
    for (const role of ADVISOR_ROLES) {
      const key = role.toLowerCase();
      // Trust the pools, not the model's self-label: derive grounded/untested
      // from which list the pick actually came from, dropping anything in
      // neither pool (or any role that wasn't asked for at all).
      const groundedSet = new Set(stretchInfo[role]?.candidates.map(c => c.hero) ?? []);
      const untestedSet = new Set(stretchInfo[role]?.untested ?? []);
      const rawStretch = (parsed[`stretch_${key}`] as string | undefined) ?? null;
      const stretch = rawStretch && (groundedSet.has(rawStretch) || untestedSet.has(rawStretch)) ? rawStretch : null;
      byRole[role] = { stretch, stretchUntested: stretch != null && !groundedSet.has(stretch) };
    }

    writeCache(db, map, mode, roleInfo.DPS.primary?.hero ?? null, insight, byRole);

    res.json(Object.fromEntries(ADVISOR_ROLES.map(role => [
      role, buildPayload(role, byRole[role].stretch, byRole[role].stretchUntested, insight, false),
    ])));
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
