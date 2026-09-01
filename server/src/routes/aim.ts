import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';
import {
  cm360, eDPI, archetypeOf, deriveSessionPosition, deriveSensAdaptation, TimelineMatch, MOUSE_DPI,
  fitQuadraticPeak, CurvePoint,
} from '../lib/aim';
import { getCurveParams, setCurveParams } from '../lib/curveParams';

const router = Router();

// The Rawaccel Jump-curve params currently stamped on every match (see
// matches.ts) — editable here, not phase-staged, so a GET is just a read of
// what's already being written rather than a live/active-set query like
// /api/blind/state.
router.get('/curve', (_req: Request, res: Response) => {
  res.json(getCurveParams(getDb()));
});

// Updates the live curve params — takes effect on the next match logged, not
// retroactive (existing matches keep whatever was stamped at the time, same
// as dpi/sens history). Smooth is a 0-1 softening factor (0 = instant snap);
// Input is the threshold speed in counts/ms (>0); Output is the above-
// threshold multiplier (>=1, since <1 would mean acceleration slows you down).
//
// Refused outright while any stage-test set is active — same rule the
// SensLog.tsx curve card enforces client-side (its `locked` prop, derived
// from GET /api/blind/state's actives.length), repeated here so a stray
// direct API call can't drift the curve mid-test and silently invalidate
// whatever that test is measuring.
router.put('/curve', (req: Request, res: Response) => {
  const db = getDb();
  const activeCount = (db.prepare('SELECT COUNT(*) n FROM blind_stage_sets WHERE active = 1').get() as { n: number }).n;
  if (activeCount > 0) {
    res.status(409).json({ error: 'curve params are locked while a stage-test set is active' });
    return;
  }
  const smooth = Number(req.body.smooth);
  const input = Number(req.body.input);
  const output = Number(req.body.output);
  if (!(smooth >= 0 && smooth <= 1) || !(input > 0) || !(output >= 1)) {
    res.status(400).json({ error: 'invalid curve params (smooth 0-1, input > 0, output >= 1)' });
    return;
  }
  setCurveParams(db, { smooth, input, output });
  res.json(getCurveParams(db));
});

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
// Only study matches qualify — a match where ANY hero played (not just the
// one on m.hero/m.role, i.e. slot 1) was credited toward an active DPI
// stage-test. Gating on m.blind_trial alone used to miss matches where the
// starting hero had no active test but a hero switched to mid-match did —
// that hero's game would silently never surface here for stats entry, even
// though blind_credits/games_on_stage already counted it toward its stage.
// matches.ts's POST handler inserts a blind_credits row for the primary hero
// too whenever blind_trial is set, so this EXISTS check is a strict
// superset of the old m.blind_trial = 1 filter, not just an alternative to
// it. sens IS NOT NULL is not a safe proxy for "in the study" either way:
// the Match Tracker sends a sens value on every match regardless of queue
// mode, so QP games — which never feed the DPI study — would otherwise pad
// this backlog too.
router.get('/pending', (req: Request, res: Response) => {
  const db = getDb();
  const limit = parseInt((req.query.limit as string) ?? '20') || 20;
  const rows = db.prepare(`
    SELECT m.id, m.date, m.time, m.hero, m.role, m.map, m.game_type, m.queue_mode, m.win, m.sens,
           m.dpi, m.blind_trial, m.blind_set_id, m.stage_index
    FROM matches m
    LEFT JOIN aim_stats a ON a.match_id = m.id
    WHERE a.match_id IS NULL AND EXISTS (SELECT 1 FROM blind_credits bc WHERE bc.match_id = m.id)
    ORDER BY m.id DESC
    LIMIT :limit
  `).all({ limit }) as Record<string, unknown>[];
  // Every hero actually played (slot 1 = the one already on m.hero/m.role
  // above), so the combat-details form can ask for accuracy per hero instead
  // of assuming the match was played on one hero start to finish.
  const heroesStmt = db.prepare('SELECT hero, role FROM match_heroes WHERE match_id = :id ORDER BY slot');
  for (const row of rows) row.heroes = heroesStmt.all({ id: row.id as number });
  // Total backlog size irrespective of `limit` — the Trial HUD's backlog
  // counter needs the true count, not just how many rows this page returned.
  const { total } = db.prepare(`
    SELECT COUNT(*) AS total
    FROM matches m
    LEFT JOIN aim_stats a ON a.match_id = m.id
    WHERE a.match_id IS NULL AND EXISTS (SELECT 1 FROM blind_credits bc WHERE bc.match_id = m.id)
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

  // Per-hero accuracy (aim_stats_heroes), not the match-level aim_stats row —
  // a match with a mid-match switch contributes one reading per hero actually
  // played, each against its own hero baseline below, rather than one
  // match-level number duplicated across every hero in it.
  const rows = db.prepare(`
    SELECT m.id, ah.hero, m.sens, m.dpi, m.win, m.date, mh.feel, m.blind_trial, ah.overall_acc, ah.crit_acc, a.created_at
    FROM aim_stats_heroes ah
    JOIN aim_stats a ON a.match_id = ah.match_id
    JOIN matches m ON m.id = ah.match_id
    LEFT JOIN match_heroes mh ON mh.match_id = ah.match_id AND mh.hero = ah.hero
    WHERE m.sens IS NOT NULL AND ah.overall_acc IS NOT NULL
  `).all() as unknown as {
    id: number; hero: string; sens: number; dpi: number | null; win: 0 | 1; blind_trial: 0 | 1 | null;
    overall_acc: number; crit_acc: number | null; feel: number | null; created_at: string; date: string;
  }[];

  // Most recent aim_stats write among the rows actually feeding this analysis.
  // String comparison is safe: datetime('now') always formats as
  // 'YYYY-MM-DD HH:MM:SS'.
  const lastUpdated = rows.length
    ? rows.reduce((latest, r) => (r.created_at > latest ? r.created_at : latest), rows[0].created_at)
    : null;

  // Aggregate keyed on cm/360 (rounded to 0.1 cm) — the physically comparable
  // axis. This is world-agnostic: legacy fixed-dpi matches bucket exactly as they
  // would by sens, while blind trials (frozen sens, varied dpi) separate by their
  // real cm/360 instead of collapsing into one sens bucket.
  const cmBucket = (v: number) => Math.round(v * 10) / 10;

  const ptsRaw = rows.map(r => ({
    ...r,
    cm360: cm360(r.sens, r.dpi ?? MOUSE_DPI),
    archetype: archetypeOf(r.hero),
    cold: (posById.get(r.id) ?? 1) === 1,
    fresh: (sinceById.get(r.id) ?? 0) <= 2,
  }));

  // Absorb legacy near-2.5 sens points into the closest blind-trial cm/360
  // bucket rather than let each sit alone (see LEGACY_SENS_ABSORB above). Only
  // matches that were actually resolved as blind trials count as absorption
  // targets — a legacy point can't merge into another legacy point's bucket.
  // Runs BEFORE the per-hero baseline below so an absorbed legacy point counts
  // as the same scale as the blind bucket it merged into for baseline purposes,
  // not its own thin, separate near-2.5 scale.
  const blindCmBuckets = [...new Set(
    ptsRaw.filter(p => p.blind_trial === 1).map(p => cmBucket(p.cm360)),
  )];
  const nearestBlindCm = (cm: number): number | null =>
    blindCmBuckets.length === 0 ? null
      : blindCmBuckets.reduce((best, v) => (Math.abs(v - cm) < Math.abs(best - cm) ? v : best));

  const ptsAbsorbed = ptsRaw
    .map(p => {
      if (!LEGACY_SENS_ABSORB.includes(p.sens)) return { ...p, scaleBucket: cmBucket(p.cm360), absorbed: false };
      const nearest = nearestBlindCm(cmBucket(p.cm360));
      return nearest == null ? null : { ...p, cm360: nearest, scaleBucket: nearest, absorbed: true };
    })
    .filter((p): p is NonNullable<typeof p> => p != null);

  // Per-hero baseline, computed leave-one-scale-out: a match's delta is scored
  // against that hero's mean accuracy across the hero's OTHER tested scales
  // only, never including matches from its own scale bucket. Scoring a scale
  // against a baseline that includes its own matches lets whichever scale
  // gets the most reps pull its own baseline toward itself, shrinking its
  // delta by construction rather than reflecting real performance. A hero
  // with fewer than 2 distinct scale buckets has nothing to compare against
  // yet, so its points get a null delta rather than a fabricated one.
  const pts = (() => {
    const out: (typeof ptsAbsorbed[number] & { delta: number | null; critDelta: number | null })[] = [];
    for (const [, hrows] of groupBy(ptsAbsorbed, p => p.hero)) {
      const byBucket = groupBy(hrows, p => p.scaleBucket);
      const overallByBucket = new Map<number, { sum: number; n: number }>();
      const critByBucket = new Map<number, { sum: number; n: number }>();
      for (const [b, bpts] of byBucket) {
        overallByBucket.set(b as number, { sum: bpts.reduce((s, p) => s + p.overall_acc, 0), n: bpts.length });
        const c = bpts.filter(p => p.crit_acc != null);
        critByBucket.set(b as number, { sum: c.reduce((s, p) => s + (p.crit_acc as number), 0), n: c.length });
      }
      const totalOverall = [...overallByBucket.values()].reduce((a, v) => ({ sum: a.sum + v.sum, n: a.n + v.n }), { sum: 0, n: 0 });
      const totalCrit = [...critByBucket.values()].reduce((a, v) => ({ sum: a.sum + v.sum, n: a.n + v.n }), { sum: 0, n: 0 });
      for (const p of hrows) {
        const own = overallByBucket.get(p.scaleBucket)!;
        const otherN = totalOverall.n - own.n;
        const delta = otherN > 0 ? p.overall_acc - (totalOverall.sum - own.sum) / otherN : null;
        let critDelta: number | null = null;
        if (p.crit_acc != null) {
          const ownC = critByBucket.get(p.scaleBucket)!;
          const otherCn = totalCrit.n - ownC.n;
          critDelta = otherCn > 0 ? p.crit_acc - (totalCrit.sum - ownC.sum) / otherCn : null;
        }
        out.push({ ...p, delta, critDelta });
      }
    }
    return out;
  })();

  const byScale = (items: typeof pts) =>
    [...groupBy(items, p => cmBucket(p.cm360)).entries()]
      .map(([cm, ps]) => {
        // Prefer a blind-trial row's sens as the bucket's label — an absorbed
        // legacy point's own sens (e.g. 2.45) isn't what this bucket represents.
        const anchor = ps.find(p => p.blind_trial === 1) ?? ps[0];
        const accSorted = ps.map(p => p.overall_acc).sort((a, b) => a - b);
        const dates = ps.map(p => p.date);
        return {
          cm360: Number(cm),
          eDPI: Math.round(mean(ps.map(p => eDPI(p.sens, p.dpi ?? MOUSE_DPI))) ?? 0),
          sens: anchor.sens,
          n: ps.length,
          avgOverall: mean(ps.map(p => p.overall_acc)),
          avgCrit: mean(ps.filter(p => p.crit_acc != null).map(p => p.crit_acc as number)),
          avgFeel: mean(ps.filter(p => p.feel != null).map(p => p.feel as number)),
          avgDelta: mean(ps.filter(p => p.delta != null).map(p => p.delta as number)),
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
          // How many of this bucket's points are legacy fixed-sens matches
          // absorbed into it rather than tested at this scale directly (see
          // LEGACY_SENS_ABSORB above) — surfaced so a bucket's n doesn't read
          // as more directly-tested than it is.
          absorbedN: ps.filter(p => p.absorbed).length,
          // Date spread of this bucket's matches — a bucket built almost
          // entirely from one narrow window may reflect that session more
          // than a stable read on the scale itself.
          distinctDates: new Set(dates).size,
          dateSpanDays: Math.round((Date.parse(dates.reduce((a, b) => (b > a ? b : a))) - Date.parse(dates.reduce((a, b) => (b < a ? b : a)))) / 86400000),
        };
      })
      .sort((a, b) => a.cm360 - b.cm360);

  // Fits a quadratic across a set of already-bucketed scales (avgDelta vs.
  // sens @MOUSE_DPI, weighted by n) and locates its vertex — the best-guess
  // "true" optimal sens, as opposed to just whichever tested scale happened
  // to score best. avgDelta (not avgOverall) so heroes still mix fairly, same
  // reasoning as the rest of this page's normalization.
  const curveFitOf = (scales: ReturnType<typeof byScale>) => {
    const cpts: CurvePoint[] = scales
      .filter(s => s.avgDelta != null)
      .map(s => ({ x: s.eDPI / MOUSE_DPI, y: s.avgDelta as number, w: s.n }));
    const fit = fitQuadraticPeak(cpts);
    if (!fit) return null;
    return {
      points: fit.points, totalN: fit.totalN, r2: Math.round(fit.r2 * 1000) / 1000,
      optimalSens: fit.optimalX != null ? Math.round(fit.optimalX * 100) / 100 : null,
      predictedDelta: fit.predictedY != null ? Math.round(fit.predictedY * 10) / 10 : null,
      hasInteriorPeak: fit.hasInteriorPeak, inRange: fit.inRange,
      testedSensMin: Math.round(fit.xMin * 100) / 100, testedSensMax: Math.round(fit.xMax * 100) / 100,
      // Raw coefficients so the frontend can plot the fitted curve itself
      // (y = a*x^2 + b*x + c, x = sens @MOUSE_DPI), not just report its vertex.
      a: fit.a, b: fit.b, c: fit.c,
    };
  };

  const bucket = (items: typeof pts, label: string) => ({
    bucket: label,
    n: items.length,
    avgOverall: mean(items.map(p => p.overall_acc)),
    avgDelta: mean(items.filter(p => p.delta != null).map(p => p.delta as number)),
    avgFeel: mean(items.filter(p => p.feel != null).map(p => p.feel as number)),
    winRate: mult100(mean(items.map(p => p.win))),
  });

  res.json({
    summary: {
      n: pts.length,
      distinctScale: new Set(pts.map(p => cmBucket(p.cm360))).size,
      lastUpdated,
    },
    // Chronological, point-level feed (not aggregated by scale) so the
    // frontend can plot accuracy over time — every other view on this page
    // aggregates by scale bucket, which discards time order entirely and
    // can't distinguish "this scale is worse" from "I was still improving
    // when I tested it." Sorted by (date, id) since these rows carry no
    // time-of-day field.
    timeline: [...pts]
      .filter(p => p.delta != null)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id))
      .map(p => ({
        date: p.date, hero: p.hero, win: p.win,
        eDPI: eDPI(p.sens, p.dpi ?? MOUSE_DPI),
        cm360: p.scaleBucket, delta: p.delta,
      })),
    byScale: byScale(pts),
    overallCurveFit: curveFitOf(byScale(pts)),
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
          // Quadratic best-fit across those scales — null until a hero has
          // 3+ distinct tested scales (see fitQuadraticPeak).
          curveFit: curveFitOf(scales),
        };
      })
      .sort((a, b) => b.n - a.n),
  });
});

// Matches already logged with combat stats on a given day — the /sens app's
// record of what's been entered today, so the backfill form isn't a
// write-only funnel. Mirrors /pending's per-hero heroes[] shape, plus each
// hero's saved accuracy (aim_stats_heroes) so an edit form can prefill.
router.get('/today', (req: Request, res: Response) => {
  const db = getDb();
  const date = (req.query.date as string) ?? '';
  const rows = db.prepare(`
    SELECT m.id, m.date, m.time, m.hero, m.role, m.map, m.game_type, m.queue_mode, m.win, m.sens,
           m.dpi, m.blind_trial, m.blind_set_id, m.stage_index,
           a.elims, a.deaths, a.damage, a.healing, a.assists, a.duration_min
    FROM aim_stats a
    JOIN matches m ON m.id = a.match_id
    WHERE m.date = :date
    ORDER BY m.id DESC
  `).all({ date }) as Record<string, unknown>[];
  const heroesStmt = db.prepare('SELECT hero, role FROM match_heroes WHERE match_id = :id ORDER BY slot');
  const heroAccStmt = db.prepare('SELECT hero, overall_acc, crit_acc, extra_acc, duration_min FROM aim_stats_heroes WHERE match_id = :id');
  for (const row of rows) {
    row.heroes = heroesStmt.all({ id: row.id as number });
    row.heroAcc = heroAccStmt.all({ id: row.id as number });
  }
  res.json({ rows });
});

// Aim stats joined with their match, for the analysis view. Newest first.
router.get('/', (_req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare(`
    SELECT m.id, m.date, m.time, m.hero, m.role, m.map, m.game_type, m.queue_mode, m.win, m.sens,
           m.dpi, m.blind_trial, m.blind_set_id, m.stage_index, m.feel, m.notes,
           a.overall_acc, a.crit_acc, a.hero_stat_label, a.hero_stat_value,
           a.elims, a.final_blows, a.deaths, a.damage, a.assists, a.duration_min
    FROM aim_stats a
    JOIN matches m ON m.id = a.match_id
    ORDER BY m.id DESC
  `).all() as Record<string, unknown>[];
  res.json({ rows });
});

// Upsert aim stats for a match. match_id is the PK, so re-submitting the same
// match corrects a prior entry rather than erroring. Accuracy AND duration are
// per hero played (heroes[]) — see aim_stats_heroes in schema.ts; everything
// else here (combat totals) stays one match-level scoreboard entry.
// aim_stats.duration_min is kept as the sum of the per-hero durations, since
// the match-total rate stats (damage/elims/final_blows per 10 min) still
// operate on the whole match, not a single hero within it.
// final_blows is intentionally left out of both the insert and the update —
// the form stopped collecting it, and leaving it out of the UPDATE SET
// (rather than sending null) keeps any already-saved value on old rows intact.
router.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const { match_id, heroes, elims, deaths, damage, healing, assists } = req.body;

  if (match_id === undefined || match_id === null) {
    res.status(400).json({ error: 'match_id required' });
    return;
  }
  const match = db.prepare('SELECT id FROM matches WHERE id = :id').get({ id: match_id });
  if (!match) {
    res.status(404).json({ error: 'match not found' });
    return;
  }

  const heroList = (Array.isArray(heroes) ? heroes : []).filter(h => h?.hero);
  const durations = heroList.map(h => h.duration_min).filter((d): d is number => typeof d === 'number');
  const totalDuration = durations.length ? durations.reduce((a, b) => a + b, 0) : null;

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
    INSERT INTO aim_stats_heroes (match_id, hero, overall_acc, crit_acc, extra_acc, duration_min)
    VALUES (:match_id, :hero, :overall_acc, :crit_acc, :extra_acc, :duration_min)
    ON CONFLICT(match_id, hero) DO UPDATE SET
      overall_acc  = excluded.overall_acc,
      crit_acc     = excluded.crit_acc,
      extra_acc    = excluded.extra_acc,
      duration_min = excluded.duration_min
  `);
  for (const h of heroList) {
    insertHeroAcc.run({
      match_id, hero: h.hero, overall_acc: h.overall_acc ?? null, crit_acc: h.crit_acc ?? null,
      extra_acc: h.extra_acc ?? null, duration_min: h.duration_min ?? null,
    });
  }

  res.json({ ok: true });
});

export default router;
