import { getDb } from '../db/schema';
import { getExperimentHooks } from './experimentHooks';

// Writes one match's aim stats (match-level scoreboard + per-hero rows) and
// settles its test credits. The caller owns the transaction: POST /api/aim
// wraps it alone, POST /api/matches wraps it together with the match insert,
// so the Log Match "Add aim stats now" fold-out saves both or neither.
export interface AimStatsPayload {
  heroes?: any[]; elims?: number | null; deaths?: number | null; damage?: number | null;
  healing?: number | null; assists?: number | null;
}
export function saveAimStatsRows(db: ReturnType<typeof getDb>, match_id: number | string, payload: AimStatsPayload) {
  const { heroes, elims, deaths, damage, healing, assists } = payload;
  const heroList = (Array.isArray(heroes) ? heroes : []).filter(h => h?.hero);
  const durations = heroList.map(h => h.duration_min).filter((d): d is number => typeof d === 'number');
  const totalDuration = durations.length ? durations.reduce((a, b) => a + b, 0) : null;

  // The payload is the complete roster for this match, not a patch — the same
  // way an omitted FIELD on a hero clears that field rather than keeping the
  // old value. So a hero missing from heroes[] means "this hero wasn't
  // played," and its row goes. Without the delete there was no way at all to
  // withdraw a mis-entered hero through the API: the row survived every
  // correction, kept feeding per-hero accuracy for a match it was never in,
  // and left aim_stats.duration_min disagreeing with the per-hero sum by
  // exactly that hero's minutes. Wrapped with the writes below so a failure
  // partway can't leave the roster half-deleted.
  db.prepare(`
    INSERT INTO aim_stats (match_id, elims, deaths, damage, healing, assists, duration_min)
    VALUES (:match_id, :elims, :deaths, :damage, :healing, :assists, :duration_min)
    ON CONFLICT(match_id) DO UPDATE SET
      elims           = excluded.elims,
      deaths          = excluded.deaths,
      damage          = excluded.damage,
      healing         = excluded.healing,
      assists         = excluded.assists,
      duration_min    = excluded.duration_min,
      created_at      = datetime('now')
  `).run({
    match_id,
    elims: elims ?? null,
    deaths: deaths ?? null,
    damage: damage ?? null,
    healing: healing ?? null,
    assists: assists ?? null,
    duration_min: totalDuration,
  });

  const insertHeroAcc = db.prepare(`
    INSERT INTO aim_stats_heroes (match_id, hero, overall_acc, crit_acc, extra_acc, torpedo_damage, torpedo_healing, duration_min)
    VALUES (:match_id, :hero, :overall_acc, :crit_acc, :extra_acc, :torpedo_damage, :torpedo_healing, :duration_min)
    ON CONFLICT(match_id, hero) DO UPDATE SET
      overall_acc     = excluded.overall_acc,
      crit_acc        = excluded.crit_acc,
      extra_acc       = excluded.extra_acc,
      torpedo_damage  = excluded.torpedo_damage,
      torpedo_healing = excluded.torpedo_healing,
      duration_min    = excluded.duration_min
  `);
  for (const h of heroList) {
    insertHeroAcc.run({
      match_id, hero: h.hero, overall_acc: h.overall_acc ?? null, crit_acc: h.crit_acc ?? null,
      extra_acc: h.extra_acc ?? null, torpedo_damage: h.torpedo_damage ?? null,
      torpedo_healing: h.torpedo_healing ?? null, duration_min: h.duration_min ?? null,
    });
  }

  // Drop the heroes this submission left out. Runs after the inserts so a
  // hero that's still present is never momentarily missing.
  const keep = heroList.map(h => String(h.hero));
  if (keep.length) {
    db.prepare(
      `DELETE FROM aim_stats_heroes WHERE match_id = :match_id
         AND hero NOT IN (${keep.map((_, i) => `:h${i}`).join(', ')})`
    ).run({ match_id, ...Object.fromEntries(keep.map((h, i) => [`h${i}`, h])) });
  } else {
    db.prepare('DELETE FROM aim_stats_heroes WHERE match_id = :match_id').run({ match_id });
  }
  // Per-hero minutes decide who earns what from the match (2026-10-01 rules:
  // minutes for every hero with >= 1 minute, the game for every hero with
  // >= 1/3 of the match — lib/credits.ts's creditFlagsFor). This form is
  // where those minutes first arrive, so the credits are settled here, in
  // the same transaction (the experiment hook's play-time credit).
  getExperimentHooks().onAimStatsSaved(db, match_id);
}

// Shape check for aim stats arriving with a new match. Mirrors what the
// backlog form enforces client-side (every hero has a duration; the first
// hero has an overall accuracy) plus ranges, since here the server is the
// only thing standing between bad stats and a half-saved match.
export function validateAimStats(p: AimStatsPayload, roster: string[]): string | null {
  const heroes = Array.isArray(p.heroes) ? p.heroes : [];
  if (heroes.length === 0) return 'heroes required';
  const seen = new Set<string>();
  for (let i = 0; i < heroes.length; i++) {
    const h = heroes[i];
    if (!h?.hero || !roster.includes(h.hero)) return `hero ${h?.hero ?? '?'} was not played in this match`;
    if (seen.has(h.hero)) return `hero ${h.hero} listed twice`;
    seen.add(h.hero);
    if (typeof h.duration_min !== 'number' || !Number.isFinite(h.duration_min) || h.duration_min <= 0) return `${h.hero}: duration_min must be > 0`;
    if (i === 0 && !(typeof h.overall_acc === 'number' && h.overall_acc >= 0)) return `${h.hero}: overall_acc required`;
    for (const k of ['overall_acc', 'crit_acc', 'extra_acc'] as const) {
      const v = h[k];
      if (v != null && !(typeof v === 'number' && v >= 0 && v <= 100)) return `${h.hero}: ${k} must be 0-100`;
    }
  }
  for (const k of ['elims', 'deaths', 'damage', 'healing', 'assists'] as const) {
    const v = p[k];
    if (v != null && !(typeof v === 'number' && Number.isFinite(v) && v >= 0)) return `${k} must be >= 0`;
  }
  return null;
}
