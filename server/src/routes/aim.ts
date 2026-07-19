import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';
import {
  cm360, eDPI, archetypeOf, deriveSessionPosition, deriveSensAdaptation, TimelineMatch, MOUSE_DPI,
} from '../lib/aim';
import { maskMatchRow } from '../lib/blind';

const router = Router();

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

function groupBy<T>(items: T[], key: (t: T) => string | number): Map<string | number, T[]> {
  const g = new Map<string | number, T[]>();
  for (const it of items) {
    const k = key(it);
    (g.get(k) ?? g.set(k, []).get(k)!).push(it);
  }
  return g;
}

// The "pending" queue the /sens app fills at match end: matches that have a
// row logged by the match app but no aim_stats yet. Most recent first, capped.
//
// Only study matches qualify. A match is a study match if it carries a sens
// (logged via the odometer) OR is a blind trial (sens is NULL by design until
// reveal — the DPI is hidden, not missing). Pre-study matches (sens IS NULL and
// not blind) predate the odometer and can never get aim stats — the OW client
// wipes match stats on every update — so including them would leave thousands of
// un-fillable rows cluttering the queue forever. This filter keeps blind and
// non-blind study matches in the one queue while excluding that legacy backlog.
router.get('/pending', (req: Request, res: Response) => {
  const db = getDb();
  const limit = parseInt((req.query.limit as string) ?? '20') || 20;
  const rows = (db.prepare(`
    SELECT m.id, m.date, m.time, m.hero, m.role, m.map, m.game_type, m.queue_mode, m.win, m.sens,
           m.dpi, m.blind_trial, m.blind_set_id, m.stage_index, m.revealed
    FROM matches m
    LEFT JOIN aim_stats a ON a.match_id = m.id
    WHERE a.match_id IS NULL AND (m.sens IS NOT NULL OR m.blind_trial = 1)
    ORDER BY m.id DESC
    LIMIT :limit
  `).all({ limit }) as Record<string, unknown>[]).map(maskMatchRow);
  // Total backlog size irrespective of `limit` — the Blind Trial HUD's backlog
  // counter needs the true count, not just how many rows this page returned.
  const { total } = db.prepare(`
    SELECT COUNT(*) AS total
    FROM matches m
    LEFT JOIN aim_stats a ON a.match_id = m.id
    WHERE a.match_id IS NULL AND (m.sens IS NOT NULL OR m.blind_trial = 1)
  `).get() as { total: number };
  res.json({ rows, total });
});

// Study analysis. Enriches each logged data point with derived fields (cm/360,
// archetype, cold/warm session position, matches-since-sens-change, and overall
// accuracy normalized against the hero's own baseline) then aggregates into the
// views the analysis page renders. All computed fresh so it reflects the latest
// entries — the "reevaluate on loop" behaviour.
router.get('/analysis', (_req: Request, res: Response) => {
  const db = getDb();

  // Full timeline (incl. matches without stats) drives the session + sens-run
  // derivations; they need the gaps between every match, not just logged ones.
  const timeline = db.prepare('SELECT id, time, date, sens, dpi FROM matches').all() as unknown as TimelineMatch[];
  const posById = deriveSessionPosition(timeline);
  const sinceById = deriveSensAdaptation(timeline);

  // Unrevealed blind trials are excluded so nothing here can de-anonymize a
  // hidden stage before Sean chooses to reveal it.
  const rows = db.prepare(`
    SELECT m.id, m.hero, m.sens, m.dpi, m.win, m.feel, a.overall_acc, a.crit_acc, a.created_at
    FROM aim_stats a JOIN matches m ON m.id = a.match_id
    WHERE m.sens IS NOT NULL AND a.overall_acc IS NOT NULL
      AND (m.blind_trial = 0 OR m.blind_trial IS NULL OR m.revealed = 1)
  `).all() as unknown as {
    id: number; hero: string; sens: number; dpi: number | null; win: 0 | 1;
    overall_acc: number; crit_acc: number | null; feel: number | null; created_at: string;
  }[];

  // Most recent aim_stats write among the rows actually feeding this analysis —
  // stat entries on still-masked blind trials don't count until revealed, same
  // as maskedPending below. String comparison is safe: datetime('now') always
  // formats as 'YYYY-MM-DD HH:MM:SS'.
  const lastUpdated = rows.length
    ? rows.reduce((latest, r) => (r.created_at > latest ? r.created_at : latest), rows[0].created_at)
    : null;

  // Per-hero baseline = that hero's mean overall accuracy across logged matches.
  // Normalizing each match against it keeps cross-hero pooling honest, so a
  // sens doesn't look better just because more easy-to-aim heroes were played on it.
  // Crit gets its own baseline since not every match logs a crit stat.
  const heroMeans = new Map<string, number>();
  const heroCritMeans = new Map<string, number>();
  for (const [hero, hrows] of groupBy(rows, r => r.hero)) {
    const m = mean(hrows.map(r => r.overall_acc));
    if (m != null) heroMeans.set(hero as string, m);
    const c = mean(hrows.filter(r => r.crit_acc != null).map(r => r.crit_acc as number));
    if (c != null) heroCritMeans.set(hero as string, c);
  }

  const pts = rows.map(r => ({
    ...r,
    cm360: cm360(r.sens, r.dpi ?? MOUSE_DPI),
    archetype: archetypeOf(r.hero),
    delta: heroMeans.has(r.hero) ? r.overall_acc - heroMeans.get(r.hero)! : 0,
    critDelta: (r.crit_acc != null && heroCritMeans.has(r.hero)) ? r.crit_acc - heroCritMeans.get(r.hero)! : null,
    cold: (posById.get(r.id) ?? 1) === 1,
    fresh: (sinceById.get(r.id) ?? 0) <= 2,
  }));

  // Aggregate keyed on cm/360 (rounded to 0.1 cm) — the physically comparable
  // axis. This is world-agnostic: legacy fixed-dpi matches bucket exactly as they
  // would by sens, while blind trials (frozen sens, varied dpi) separate by their
  // real cm/360 instead of collapsing into one sens bucket.
  const cmBucket = (v: number) => Math.round(v * 10) / 10;

  const byScale = (items: typeof pts) =>
    [...groupBy(items, p => cmBucket(p.cm360)).entries()]
      .map(([cm, ps]) => ({
        cm360: Number(cm),
        eDPI: Math.round(mean(ps.map(p => eDPI(p.sens, p.dpi ?? MOUSE_DPI))) ?? 0),
        sens: ps[0].sens,
        n: ps.length,
        avgOverall: mean(ps.map(p => p.overall_acc)),
        avgCrit: mean(ps.filter(p => p.crit_acc != null).map(p => p.crit_acc as number)),
        avgFeel: mean(ps.filter(p => p.feel != null).map(p => p.feel as number)),
        avgDelta: mean(ps.map(p => p.delta)),
        avgCritDelta: mean(ps.filter(p => p.critDelta != null).map(p => p.critDelta as number)),
      }))
      .sort((a, b) => a.cm360 - b.cm360);

  const bucket = (items: typeof pts, label: string) => ({
    bucket: label,
    n: items.length,
    avgOverall: mean(items.map(p => p.overall_acc)),
    avgDelta: mean(items.map(p => p.delta)),
    avgFeel: mean(items.filter(p => p.feel != null).map(p => p.feel as number)),
  });

  // How many blind trials are still masked — surfaced so the analysis page can
  // show a chip and Sean knows unrevealed data is being held out.
  const maskedPending = (db.prepare(
    'SELECT COUNT(*) n FROM matches WHERE blind_trial = 1 AND revealed = 0',
  ).get() as { n: number }).n;

  res.json({
    summary: {
      n: pts.length,
      distinctScale: new Set(pts.map(p => cmBucket(p.cm360))).size,
      maskedPending,
      lastUpdated,
    },
    byScale: byScale(pts),
    byArchetype: {
      hitscan: byScale(pts.filter(p => p.archetype === 'hitscan')),
      projectile: byScale(pts.filter(p => p.archetype === 'projectile')),
    },
    coldWarm: [
      bucket(pts.filter(p => p.cold), 'Cold (1st of session)'),
      bucket(pts.filter(p => !p.cold), 'Warm (later)'),
    ],
    adaptation: [
      bucket(pts.filter(p => p.fresh), 'Fresh (≤2 since change)'),
      bucket(pts.filter(p => !p.fresh), 'Settled (3+ since change)'),
    ],
    heroes: [...groupBy(pts, p => p.hero).entries()]
      .map(([hero, ps]) => {
        // Best-performing scale for this hero alone — same byScale bucketing,
        // just scoped to one hero's matches instead of the whole roster.
        const bestScale = byScale(ps).reduce((a, b) => ((b.avgOverall ?? -Infinity) > (a.avgOverall ?? -Infinity) ? b : a));
        return {
          hero: hero as string,
          archetype: ps[0].archetype,
          n: ps.length,
          avgOverall: mean(ps.map(p => p.overall_acc)),
          avgCrit: mean(ps.filter(p => p.crit_acc != null).map(p => p.crit_acc as number)),
          bestScaleEDPI: bestScale.eDPI,
          bestScaleN: bestScale.n,
          bestScaleOverallDelta: bestScale.avgDelta,
          bestScaleCritDelta: bestScale.avgCritDelta,
        };
      })
      .sort((a, b) => b.n - a.n),
  });
});

// Aim stats joined with their match, for the analysis view. Newest first.
router.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = (db.prepare(`
    SELECT m.id, m.date, m.time, m.hero, m.role, m.map, m.game_type, m.queue_mode, m.win, m.sens,
           m.dpi, m.blind_trial, m.blind_set_id, m.stage_index, m.revealed, m.feel, m.notes,
           a.overall_acc, a.crit_acc, a.hero_stat_label, a.hero_stat_value,
           a.elims, a.final_blows, a.deaths, a.damage, a.duration_min
    FROM aim_stats a
    JOIN matches m ON m.id = a.match_id
    ORDER BY m.id DESC
  `).all() as Record<string, unknown>[]).map(maskMatchRow);
  res.json({ rows });
});

// Upsert aim stats for a match. match_id is the PK, so re-submitting the same
// match corrects a prior entry rather than erroring.
router.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const { match_id, overall_acc, crit_acc, hero_stat_label, hero_stat_value,
    elims, final_blows, deaths, damage, duration_min } = req.body;

  if (match_id === undefined || match_id === null) {
    res.status(400).json({ error: 'match_id required' });
    return;
  }
  const match = db.prepare('SELECT id FROM matches WHERE id = :id').get({ id: match_id });
  if (!match) {
    res.status(404).json({ error: 'match not found' });
    return;
  }

  db.prepare(`
    INSERT INTO aim_stats (match_id, overall_acc, crit_acc, hero_stat_label, hero_stat_value,
                           elims, final_blows, deaths, damage, duration_min)
    VALUES (:match_id, :overall_acc, :crit_acc, :hero_stat_label, :hero_stat_value,
            :elims, :final_blows, :deaths, :damage, :duration_min)
    ON CONFLICT(match_id) DO UPDATE SET
      overall_acc     = excluded.overall_acc,
      crit_acc        = excluded.crit_acc,
      hero_stat_label = excluded.hero_stat_label,
      hero_stat_value = excluded.hero_stat_value,
      elims           = excluded.elims,
      final_blows     = excluded.final_blows,
      deaths          = excluded.deaths,
      damage          = excluded.damage,
      duration_min    = excluded.duration_min,
      created_at      = datetime('now')
  `).run({
    match_id,
    overall_acc: overall_acc ?? null,
    crit_acc: crit_acc ?? null,
    hero_stat_label: hero_stat_label ?? null,
    hero_stat_value: hero_stat_value ?? null,
    elims: elims ?? null,
    final_blows: final_blows ?? null,
    deaths: deaths ?? null,
    damage: damage ?? null,
    duration_min: duration_min ?? null,
  });

  res.json({ ok: true });
});

export default router;
