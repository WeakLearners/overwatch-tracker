import { Router, Request, Response } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { getDb } from '../db/schema';

const router = Router();

const CACHE_TTL_DAYS = 7;
const MIN_GAMES_FOR_PICK = 3;

type QueueMode = 'qp_role' | 'comp_role' | 'comp_open';
// Coaching always surfaces both a DPS and a Support pick, side by side,
// regardless of queue mode — role queue only locks which role you queue AS
// for a given match, not which role's data is worth coaching on.
type AdvisorRole = 'DPS' | 'Support';
const ADVISOR_ROLES: AdvisorRole[] = ['DPS', 'Support'];

// Heroes the user has played enough to be considered "comfort pool".
const COMFORT_MIN_GAMES = 20;

interface HeroStat { hero: string; role: string; games: number; win_rate: number }
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
interface CachedPicks { byRole: Record<AdvisorRole, CachedRoleStretch> }

// The LLM stretch picks are cached per role (one LLM call covers both roles).
// Hero stats are recomputed live on every request (cheap, and reflects newly
// logged matches even on a cache hit). primary_hero/stretch_hero stay
// informational-only (DPS side) now that focus_json carries both roles' data.
function readCachedPicks(db: ReturnType<typeof getDb>, map: string, mode: QueueMode): CachedPicks | null {
  const row = db.prepare(`
    SELECT focus_json, created_at
    FROM advisor_cache WHERE map = ? AND queue_mode = ?
  `).get(map, mode) as any;
  if (!row) return null;
  const ageMs = Date.now() - new Date(row.created_at + 'Z').getTime();
  if (ageMs > CACHE_TTL_DAYS * 24 * 60 * 60 * 1000) return null;
  try {
    const parsed = JSON.parse(row.focus_json);
    if (!parsed?.byRole) return null; // old shape -> regenerate
    return { byRole: parsed.byRole };
  } catch { return null; }
}

function writeCache(db: ReturnType<typeof getDb>, map: string, mode: QueueMode, primaryDps: string | null, byRole: Record<AdvisorRole, CachedRoleStretch>) {
  db.prepare(`
    INSERT INTO advisor_cache (map, queue_mode, primary_hero, stretch_hero, focus_json, created_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(map, queue_mode) DO UPDATE SET
      primary_hero = excluded.primary_hero,
      stretch_hero = excluded.stretch_hero,
      focus_json   = excluded.focus_json,
      created_at   = excluded.created_at
  `).run(map, mode, primaryDps ?? '', byRole.DPS.stretch, JSON.stringify({ byRole }));
}

// Only roles with a non-empty stretch pool get stretch fields.
function buildSchema(roleHasStretchPool: Partial<Record<AdvisorRole, boolean>>) {
  const props: any = {};
  const required: string[] = [];
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

const SYSTEM_PROMPT = `You are an Overwatch 2 coach picking a stretch hero for an intermediate-rank player before a match. You are given REAL statistics from this player's own logged matches — use them.

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

  const buildPayload = (role: AdvisorRole, stretch: string | null, stretchUntested: boolean, cached: boolean): RecommendationPayload | null => {
    const primary = roleInfo[role].primary;
    if (!primary) return null;
    return {
      primary: primary.hero,
      stretch,
      stretch_untested: stretchUntested,
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
    const cached = readCachedPicks(db, map, mode);
    const stillFresh = cached && ADVISOR_ROLES.every(role => {
      if (!roleInfo[role].primary) return true; // no column to validate
      const s = cached.byRole[role]?.stretch ?? null;
      return s === null || inTesting.has(s);
    });
    if (cached && stillFresh) {
      res.json(Object.fromEntries(ADVISOR_ROLES.map(role => [
        role, buildPayload(role, cached!.byRole[role]?.stretch ?? null, cached!.byRole[role]?.stretchUntested ?? false, true),
      ])));
      return;
    }
  }

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

  const roleHasStretchPool: Partial<Record<AdvisorRole, boolean>> = {};
  for (const role of ADVISOR_ROLES) {
    if (!roleInfo[role].primary) continue;
    roleHasStretchPool[role] = stretchInfo[role].candidates.length > 0 || stretchInfo[role].untested.length > 0;
  }

  // No stretch pool anywhere means nothing for the model to pick — answer
  // from the stats alone instead of spending a call.
  if (!Object.values(roleHasStretchPool).some(Boolean)) {
    res.json(Object.fromEntries(ADVISOR_ROLES.map(role => [role, buildPayload(role, null, false, false)])));
    return;
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(503).json({
      error: 'ANTHROPIC_API_KEY not set. Add it to your environment to enable tactical recommendations.',
    });
    return;
  }

  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 700,
      system: SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: buildSchema(roleHasStretchPool) } } as any,
      messages: [{
        role: 'user',
        content: `Pre-match context:\n${JSON.stringify(userPayload, null, 2)}\n\nReturn the stretch pick(s).`,
      }],
    });

    const textBlock = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
    if (!textBlock) throw new Error('No text response from model');
    const parsed = JSON.parse(textBlock.text) as Record<string, unknown>;

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

    writeCache(db, map, mode, roleInfo.DPS.primary?.hero ?? null, byRole);

    res.json(Object.fromEntries(ADVISOR_ROLES.map(role => [
      role, buildPayload(role, byRole[role].stretch, byRole[role].stretchUntested, false),
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
  Tank: ['D.Mon', 'D.Va', 'Domina', 'Doomfist', 'Hazard', 'Junker Queen', 'Mauga', 'Orisa', 'Ramattra', 'Reinhardt', 'Roadhog', 'Sigma', 'Winston', 'Wrecking Ball', 'Zarya'],
};
function ALL_HEROES_BY_ROLE(roles: string[]): string[] {
  return roles.flatMap(r => HEROES_BY_ROLE[r] ?? []);
}

interface TestPickCombo { map: string; hero: string; games: number; win_rate: number; sample_size: 'strong' | 'thin' }

// ── Test Pick: top 3 (map, hero) combos ranked by win rate, across the cross
// product of the specific maps the in-game vote screen offered Sean this
// match × every hero CURRENTLY ACTIVE in testing for the selected role —
// feeds a recommendation panel that only appears once maps are entered (map
// voting is a vote among 3 fixed candidates, so a single "best map overall"
// pick doesn't help him vote differently; a hero-choice layer ranked across
// all 3 candidates does). The caller passes those maps (up to 3, however
// many have been entered so far) via `maps`, reusing whatever the existing
// Map Voting card's picker already captured. The role roster here is
// getInTestingHeroes ONLY (active=1) — deliberately narrower than the full
// current-phase roster (active AND already-finished heroes, which is what
// the client's /api/blind/sets-backed Select Your Hero "Done" badges use).
// Once every hero in a phase finishes and none are active, roleHeroes is
// empty and this falls through to 'no_phase_heroes', which the client reads
// as "no test data" and falls back to the plain map-only blended-score
// recommendation —
// i.e. testing-phase-aware picks only during an active phase; a generic
// recommendation at the end of one, by design.
//
// Ranking (sparse-data handling applied PER combo, not as one global
// cascade): only combos with at least 1 logged game are ranked at all — a
// combo with zero games has no win rate to rank by, so it's left out rather
// than padded in as filler. Sort key: games >= MIN_GAMES_FOR_PICK (3) first
// ("strong" beats "thin" regardless of win rate — a fluky 1-game 100% combo
// shouldn't outrank an established 8/10), then win_rate desc, then games
// desc, then map name asc, then hero name asc as the final tie-break. Top 3
// after that sort are returned, each tagged with its own sample_size.
//
// available: false cases: reason 'no_maps_selected' (maps param empty),
// 'no_phase_heroes' (no hero currently active in testing for this role —
// e.g. the phase is finished, or none has ever started), 'no_data' (every
// candidate combo across the active hero pool has zero games logged).
router.get('/test-pick', (req: Request, res: Response) => {
  const db = getDb();
  const roleParam = req.query.role as string | undefined;
  if (!roleParam || !ADVISOR_ROLES.includes(roleParam as AdvisorRole)) {
    res.status(400).json({ error: `role must be one of ${ADVISOR_ROLES.join(', ')}` });
    return;
  }
  const role = roleParam as AdvisorRole;

  const mapsParam = (req.query.maps as string | undefined) ?? '';
  const candidateMaps = [...new Set(mapsParam.split(',').map(m => m.trim()).filter(Boolean))].slice(0, 3);
  if (candidateMaps.length === 0) {
    res.json({ role, available: false, reason: 'no_maps_selected', picks: [] });
    return;
  }

  const inTesting = getInTestingHeroes(db);
  const roleHeroes = ALL_HEROES_BY_ROLE([role]).filter(h => inTesting.has(h));
  if (roleHeroes.length === 0) {
    res.json({ role, available: false, reason: 'no_phase_heroes', picks: [] });
    return;
  }
  const heroPlaceholders = roleHeroes.map(() => '?').join(',');
  const mapPlaceholders = candidateMaps.map(() => '?').join(',');

  const rows = db.prepare(`
    SELECT map, hero, COUNT(*) games, ROUND(AVG(win) * 100, 1) win_rate
    FROM matches_by_hero
    WHERE hero IN (${heroPlaceholders}) AND map IN (${mapPlaceholders})
    GROUP BY map, hero
  `).all(...roleHeroes, ...candidateMaps) as unknown as { map: string; hero: string; games: number; win_rate: number }[];
  const statsByKey = new Map(rows.map(r => [`${r.map}|${r.hero}`, r]));

  // Cross product: every (candidate map) x (role's currently-active testing
  // hero), keeping only ones with real games to rank. Bounded by however
  // many heroes are active right now (usually 1, up to the role's phase
  // size), not a fixed 5 — see getInTestingHeroes above.
  const scored: TestPickCombo[] = [];
  for (const map of candidateMaps) {
    for (const hero of roleHeroes) {
      const stat = statsByKey.get(`${map}|${hero}`);
      if (!stat || stat.games === 0) continue;
      scored.push({ map, hero, games: stat.games, win_rate: stat.win_rate, sample_size: stat.games >= MIN_GAMES_FOR_PICK ? 'strong' : 'thin' });
    }
  }

  if (scored.length === 0) {
    res.json({ role, available: false, reason: 'no_data', picks: [] });
    return;
  }

  scored.sort((a, b) => {
    const tierA = a.sample_size === 'strong' ? 0 : 1;
    const tierB = b.sample_size === 'strong' ? 0 : 1;
    if (tierA !== tierB) return tierA - tierB;
    if (b.win_rate !== a.win_rate) return b.win_rate - a.win_rate;
    if (b.games !== a.games) return b.games - a.games;
    if (a.map !== b.map) return a.map < b.map ? -1 : 1;
    return a.hero < b.hero ? -1 : 1;
  });

  res.json({ role, available: true, picks: scored.slice(0, 3) });
});

export default router;
