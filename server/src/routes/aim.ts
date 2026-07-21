import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';
import {
  cm360, eDPI, archetypeOf, deriveSessionPosition, deriveSensAdaptation, TimelineMatch, MOUSE_DPI,
} from '../lib/aim';
import { maskMatchRow } from '../lib/blind';

const router = Router();

const mean = (xs: number[]): number | null =>
  xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

// Linear-interpolation quantile (same convention as numpy's default) over a
// pre-sorted ascending array. Used for the per-scale box-plot stats below.
const quantile = (sorted: number[], q: number): number | null => {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base];
};

// win is stored 0/1, so mean() of it is already a fraction — this just puts it
// on the same 0–100 scale as the accuracy fields it sits next to.
const mult100 = (frac: number | null): number | null => (frac == null ? null : frac * 100);

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
// Legacy in-game sens values logged before blind-DPI testing started (fine
// tuning around 2.5 before the study locked sens and began varying DPI
// instead). Each is stuck at very low n and no longer under active test, so on
// its own it would form a thin, noisy near-2.5 bucket that skews the by-scale
// analysis. Rather than discard that data, each point below gets absorbed into
// whichever blind-trial cm/360 bucket it's physically closest to — the real
// stand-in for the scale it would have tested under the current protocol —
// adding to that bucket's n instead of diluting the picture with its own. A
// legacy point only gets dropped outright if there's no blind bucket at all to
// absorb it into yet.
const LEGACY_SENS_ABSORB = [2.45, 2.47, 2.48, 2.55];

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
    SELECT m.id, m.hero, m.sens, m.dpi, m.win, m.feel, m.blind_trial, a.overall_acc, a.crit_acc, a.created_at
    FROM aim_stats a JOIN matches m ON m.id = a.match_id
    WHERE m.sens IS NOT NULL AND a.overall_acc IS NOT NULL
      AND (m.blind_trial = 0 OR m.blind_trial IS NULL OR m.revealed = 1)
  `).all() as unknown as {
    id: number; hero: string; sens: number; dpi: number | null; win: 0 | 1; blind_trial: 0 | 1 | null;
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

  const ptsRaw = rows.map(r => ({
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

  // Absorb legacy near-2.5 sens points into the closest blind-trial cm/360
  // bucket rather than let each sit alone (see LEGACY_SENS_ABSORB above). Only
  // matches that were actually resolved as blind trials count as absorption
  // targets — a legacy point can't merge into another legacy point's bucket.
  const blindCmBuckets = [...new Set(
    ptsRaw.filter(p => p.blind_trial === 1).map(p => cmBucket(p.cm360)),
  )];
  const nearestBlindCm = (cm: number): number | null =>
    blindCmBuckets.length === 0 ? null
      : blindCmBuckets.reduce((best, v) => (Math.abs(v - cm) < Math.abs(best - cm) ? v : best));

  const pts = ptsRaw
    .map(p => {
      if (!LEGACY_SENS_ABSORB.includes(p.sens)) return p;
      const nearest = nearestBlindCm(cmBucket(p.cm360));
      return nearest == null ? null : { ...p, cm360: nearest };
    })
    .filter((p): p is NonNullable<typeof p> => p != null);

  const byScale = (items: typeof pts) =>
    [...groupBy(items, p => cmBucket(p.cm360)).entries()]
      .map(([cm, ps]) => {
        // Prefer a blind-trial row's sens as the bucket's label — an absorbed
        // legacy point's own sens (e.g. 2.45) isn't what this bucket represents.
        const anchor = ps.find(p => p.blind_trial === 1) ?? ps[0];
        const accSorted = ps.map(p => p.overall_acc).sort((a, b) => a - b);
        return {
          cm360: Number(cm),
          eDPI: Math.round(mean(ps.map(p => eDPI(p.sens, p.dpi ?? MOUSE_DPI))) ?? 0),
          sens: anchor.sens,
          n: ps.length,
          avgOverall: mean(ps.map(p => p.overall_acc)),
          avgCrit: mean(ps.filter(p => p.crit_acc != null).map(p => p.crit_acc as number)),
          avgFeel: mean(ps.filter(p => p.feel != null).map(p => p.feel as number)),
          avgDelta: mean(ps.map(p => p.delta)),
          avgCritDelta: mean(ps.filter(p => p.critDelta != null).map(p => p.critDelta as number)),
          // Win rate, not just accuracy — accuracy is a proxy for the scale
          // that actually matters: which sens wins more.
          winRate: mult100(mean(ps.map(p => p.win))),
          // Box-plot stats over raw overall accuracy at this scale.
          min: accSorted[0] ?? null,
          q1: quantile(accSorted, 0.25),
          median: quantile(accSorted, 0.5),
          q3: quantile(accSorted, 0.75),
          max: accSorted[accSorted.length - 1] ?? null,
        };
      })
      .sort((a, b) => a.cm360 - b.cm360);

  const bucket = (items: typeof pts, label: string) => ({
    bucket: label,
    n: items.length,
    avgOverall: mean(items.map(p => p.overall_acc)),
    avgDelta: mean(items.map(p => p.delta)),
    avgFeel: mean(items.filter(p => p.feel != null).map(p => p.feel as number)),
    winRate: mult100(mean(items.map(p => p.win))),
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
        const scales = byScale(ps);
        const bestScale = scales.reduce((a, b) => ((b.avgOverall ?? -Infinity) > (a.avgOverall ?? -Infinity) ? b : a));
        return {
          hero: hero as string,
          archetype: ps[0].archetype,
          n: ps.length,
          avgOverall: mean(ps.map(p => p.overall_acc)),
          avgCrit: mean(ps.filter(p => p.crit_acc != null).map(p => p.crit_acc as number)),
          winRate: mult100(mean(ps.map(p => p.win))),
          bestScaleEDPI: bestScale.eDPI,
          bestScaleN: bestScale.n,
          bestScaleOverallDelta: bestScale.avgDelta,
          bestScaleCritDelta: bestScale.avgCritDelta,
          bestScaleWinRate: bestScale.winRate,
          // Full per-scale curve (not just the best one) so the analysis page
          // can trace this hero's accuracy across every sens it's actually
          // been tested at, ascending by cm/360.
          scales,
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
