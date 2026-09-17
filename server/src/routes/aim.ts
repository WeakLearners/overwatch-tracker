import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';
import {
  cm360, eDPI, archetypeOf, deriveSessionPosition, deriveSensAdaptation, TimelineMatch, MOUSE_DPI,
  fitQuadraticPeak, fitLinearTrend, CurvePoint,
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
  const heroesStmt = db.prepare('SELECT hero, role, sens FROM match_heroes WHERE match_id = :id ORDER BY slot');
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

// Extracted from the /analysis route handler so it's callable directly from
// tests without going through Express (Tier 2 DB-backed compute coverage) —
// the route below is now a thin wrapper that just calls this with the live
// db and returns the result as JSON. No logic changed in the extraction.
// Minimum games at a single tested scale before that scale is allowed to be
// selected as a hero's "best". Set to the stage batch_size the blind test
// design already uses (5) — the study's own declared unit of evidence for
// "we have tested this value", so reusing it keeps one definition of enough
// rather than inventing a second.
//
// This lives on the SERVER deliberately. The guard used to exist only in the
// clients, at three different thresholds (SensAnalysis 4, SensLog 3, Prematch
// none at all) — so one hero could be simultaneously too thin to nudge toward
// on one page and a confident recommendation on another. Selection is guarded
// once, here; clients decide presentation, not validity.
export const MIN_SCALE_N = 5;

export function computeAnalysis(db: ReturnType<typeof getDb>) {
  // Full timeline (incl. matches without stats) drives the session + sens-run
  // derivations; they need the gaps between every match, not just logged ones.
  const timeline = db.prepare('SELECT id, time, date, sens, dpi FROM matches').all() as unknown as TimelineMatch[];
  const posById = deriveSessionPosition(timeline);
  const sinceById = deriveSensAdaptation(timeline);

  // Per-hero accuracy (aim_stats_heroes), not the match-level aim_stats row —
  // a match with a mid-match switch contributes one reading per hero actually
  // played, each against its own hero baseline below, rather than one
  // match-level number duplicated across every hero in it. sens comes from
  // match_heroes (mh.sens), not matches (m.sens) — Overwatch sensitivity is a
  // real per-hero setting, so a switched-to hero's sens can differ from the
  // match's primary hero (see schema.ts's comment on match_heroes.sens).
  // Filtering on mh.sens IS NOT NULL (not m.sens) is what drops the handful
  // of historical switch-hero rows whose true sens couldn't be reconstructed
  // (scripts/backfill-hero-sens.py) instead of silently misattributing them
  // to the primary hero's sens.
  // extra_acc and hero_stat_label/value join the projection here (2026-09-15).
  // Both were write-only before: the entry form collected them and the
  // backlog/day GETs read them back so the form could be edited, but
  // computeAnalysis selected overall_acc/crit_acc alone, so 618 logged
  // ability-level readings never reached any analysis surface.
  //
  // The two live at different grains, which is why they're handled
  // differently below. extra_acc is on aim_stats_heroes — per hero actually
  // played, so it lines up with this query's row directly. hero_stat_value is
  // on aim_stats — one row per MATCH, describing the match's primary hero
  // only. m.hero comes along as primary_hero so it can be attributed to that
  // hero and nulled on every other hero in the same match; without that guard
  // a mid-match switch would credit the primary hero's signature stat to
  // whoever was switched to.
  const rows = db.prepare(`
    SELECT m.id, ah.hero, mh.sens, m.dpi, m.win, m.date, mh.feel, m.blind_trial,
           ah.overall_acc, ah.crit_acc, ah.extra_acc, ah.duration_min AS hero_duration_min,
           a.hero_stat_label, a.hero_stat_value, m.hero AS primary_hero, a.created_at,
           -- Output stats. All live on aim_stats, which is one row per MATCH,
           -- so like hero_stat_value they describe the primary hero and are
           -- attributed below rather than shared across a switched match.
           a.damage, a.healing, a.elims, a.deaths, a.assists, a.final_blows,
           a.duration_min AS match_duration_min
    FROM aim_stats_heroes ah
    JOIN aim_stats a ON a.match_id = ah.match_id
    JOIN matches m ON m.id = ah.match_id
    LEFT JOIN match_heroes mh ON mh.match_id = ah.match_id AND mh.hero = ah.hero
    WHERE mh.sens IS NOT NULL AND ah.overall_acc IS NOT NULL
  `).all() as unknown as {
    id: number; hero: string; sens: number; dpi: number | null; win: 0 | 1; blind_trial: 0 | 1 | null;
    overall_acc: number; crit_acc: number | null; extra_acc: number | null;
    hero_stat_label: string | null; hero_stat_value: number | null; primary_hero: string;
    damage: number | null; healing: number | null; elims: number | null;
    deaths: number | null; assists: number | null; final_blows: number | null;
    hero_duration_min: number | null; match_duration_min: number | null;
    feel: number | null; created_at: string; date: string;
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

  // Per-10-minute rates for one row, or nulls when the row can't support them
  // (no duration, or this hero wasn't the match's primary).
  const rate10 = (r: typeof rows[number]) => {
    const mins = (r.hero_duration_min && r.hero_duration_min > 0)
      ? r.hero_duration_min
      : (r.match_duration_min && r.match_duration_min > 0 ? r.match_duration_min : null);
    const own = r.hero === r.primary_hero;
    const per10 = (v: number | null) => (mins == null || !own || v == null ? null : (v * 10) / mins);
    return {
      durationMin: own ? mins : null,
      dmg10: per10(r.damage),
      heal10: per10(r.healing),
      elims10: per10(r.elims),
      deaths10: per10(r.deaths),
      assists10: per10(r.assists),
      fb10: per10(r.final_blows),
    };
  };

  const ptsRaw = rows.map(r => ({
    ...r,
    cm360: cm360(r.sens, r.dpi ?? MOUSE_DPI),
    archetype: archetypeOf(r.hero),
    cold: (posById.get(r.id) ?? 1) === 1,
    fresh: (sinceById.get(r.id) ?? 0) <= 2,
    // Match-level signature stat, claimed only by the match's primary hero
    // (see the query's note). Every other hero in a switched match reads null
    // here rather than inheriting a number that isn't about them.
    heroStat: r.hero === r.primary_hero ? r.hero_stat_value : null,
    heroStatLabel: r.hero === r.primary_hero ? r.hero_stat_label : null,
    // ── Output rates ─────────────────────────────────────────────────────
    // Damage, healing, elims, deaths and assists are raw totals for a whole
    // match, so comparing them directly is comparing match lengths as much as
    // performance: a 17-minute grind out-damages a 6-minute stomp no matter
    // how anyone aimed. Dividing by time on hero removes that, giving a rate
    // that is comparable across matches — which is what makes these usable
    // against sens at all.
    //
    // Denominator is aim_stats_heroes.duration_min (time on THIS hero) with
    // the match-level duration as fallback. On a switched match those differ,
    // and using the match's length for a hero who played four minutes of it
    // would understate their rate by a factor of three.
    //
    // Like hero_stat_value these totals live on the match row, so only the
    // primary hero claims them; a hero switched to mid-match gets null rather
    // than credit for someone else's damage.
    ...rate10(r),
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
  // One leave-one-scale-out pass over an arbitrary stat, so overall accuracy,
  // the crit slot, extra_acc and the signature stat all get their delta the
  // same way rather than each re-deriving it. Points where the stat is null
  // simply don't contribute to any bucket and get a null delta back.
  const losoDeltas = <T extends { scaleBucket: number }>(
    hrows: T[], valueOf: (p: T) => number | null,
  ): Map<T, number | null> => {
    const byBucket = new Map<number, { sum: number; n: number }>();
    for (const p of hrows) {
      const v = valueOf(p);
      if (v == null) continue;
      const cur = byBucket.get(p.scaleBucket) ?? { sum: 0, n: 0 };
      byBucket.set(p.scaleBucket, { sum: cur.sum + v, n: cur.n + 1 });
    }
    const total = [...byBucket.values()].reduce((a, v) => ({ sum: a.sum + v.sum, n: a.n + v.n }), { sum: 0, n: 0 });
    const out = new Map<T, number | null>();
    for (const p of hrows) {
      const v = valueOf(p);
      if (v == null) { out.set(p, null); continue; }
      const own = byBucket.get(p.scaleBucket)!;
      const otherN = total.n - own.n;
      out.set(p, otherN > 0 ? v - (total.sum - own.sum) / otherN : null);
    }
    return out;
  };

  const pts = (() => {
    type Pt = typeof ptsAbsorbed[number];
    const out: (Pt & {
      delta: number | null; critDelta: number | null;
      extraDelta: number | null; heroStatDelta: number | null;
      dmg10Delta: number | null; heal10Delta: number | null;
      elims10Delta: number | null; deaths10Delta: number | null;
    })[] = [];
    for (const [, hrows] of groupBy(ptsAbsorbed, p => p.hero)) {
      const overall = losoDeltas(hrows, p => p.overall_acc);
      const crit = losoDeltas(hrows, p => p.crit_acc);
      const extra = losoDeltas(hrows, p => p.extra_acc);
      // Only normalized against itself when the stat is a percentage. A raw
      // count (Shion's "Execution kills", Reaper's "Death Blossom Kills")
      // still gets a delta, and it's still a like-for-like comparison of this
      // hero against itself across scales — but see the nHeroStat/label
      // caveat surfaced to the client: counts are per match and therefore
      // confounded by match length, which percentages aren't.
      const heroStat = losoDeltas(hrows, p => p.heroStat);
      const dmg = losoDeltas(hrows, p => p.dmg10);
      const heal = losoDeltas(hrows, p => p.heal10);
      const elim = losoDeltas(hrows, p => p.elims10);
      const death = losoDeltas(hrows, p => p.deaths10);
      for (const p of hrows) {
        out.push({
          ...p,
          delta: overall.get(p) ?? null,
          critDelta: crit.get(p) ?? null,
          extraDelta: extra.get(p) ?? null,
          heroStatDelta: heroStat.get(p) ?? null,
          dmg10Delta: dmg.get(p) ?? null,
          heal10Delta: heal.get(p) ?? null,
          elims10Delta: elim.get(p) ?? null,
          deaths10Delta: death.get(p) ?? null,
        });
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
          // Whether this bucket has enough games to be treated as a tested
          // result rather than an anecdote. Buckets below the bar are still
          // returned in full — thin data is shown, just never selected as a
          // winner or used to recommend anything.
          reliable: ps.length >= MIN_SCALE_N,
          avgOverall: mean(ps.map(p => p.overall_acc)),
          avgCrit: mean(ps.filter(p => p.crit_acc != null).map(p => p.crit_acc as number)),
          avgFeel: mean(ps.filter(p => p.feel != null).map(p => p.feel as number)),
          avgDelta: mean(ps.filter(p => p.delta != null).map(p => p.delta as number)),
          avgCritDelta: mean(ps.filter(p => p.critDelta != null).map(p => p.critDelta as number)),
          // Ability-level stats at this scale. Each carries its own n because
          // it is almost always sparser than the bucket's overall-accuracy n —
          // extra_acc exists for 4 heroes, the signature stat for 7 — and a
          // reader who sees only the bucket's n would badly overrate them.
          nExtra: ps.filter(p => p.extra_acc != null).length,
          avgExtra: mean(ps.filter(p => p.extra_acc != null).map(p => p.extra_acc as number)),
          avgExtraDelta: mean(ps.filter(p => p.extraDelta != null).map(p => p.extraDelta as number)),
          nHeroStat: ps.filter(p => p.heroStat != null).length,
          avgHeroStat: mean(ps.filter(p => p.heroStat != null).map(p => p.heroStat as number)),
          avgHeroStatDelta: mean(ps.filter(p => p.heroStatDelta != null).map(p => p.heroStatDelta as number)),
          // Output rates at this scale, each with its own n. Damage/elims are
          // logged on essentially every study point; healing only on supports,
          // which is why its n is separate rather than assumed.
          nRate: ps.filter(p => p.dmg10 != null).length,
          avgDmg10: mean(ps.filter(p => p.dmg10 != null).map(p => p.dmg10 as number)),
          avgDmg10Delta: mean(ps.filter(p => p.dmg10Delta != null).map(p => p.dmg10Delta as number)),
          nHeal: ps.filter(p => p.heal10 != null).length,
          avgHeal10: mean(ps.filter(p => p.heal10 != null).map(p => p.heal10 as number)),
          avgHeal10Delta: mean(ps.filter(p => p.heal10Delta != null).map(p => p.heal10Delta as number)),
          avgElims10: mean(ps.filter(p => p.elims10 != null).map(p => p.elims10 as number)),
          avgElims10Delta: mean(ps.filter(p => p.elims10Delta != null).map(p => p.elims10Delta as number)),
          avgDeaths10: mean(ps.filter(p => p.deaths10 != null).map(p => p.deaths10 as number)),
          avgDeaths10Delta: mean(ps.filter(p => p.deaths10Delta != null).map(p => p.deaths10Delta as number)),
          // RETIRED PREMISE (2026-09-17, Sean's call): this used to read "win
          // rate, not just accuracy — accuracy is a proxy for the scale that
          // actually matters: which sens wins more." That's backwards. A win
          // is decided by five teammates, five opponents, map, comp, and
          // matchmaking rating — sens is buried under all of that. Accuracy
          // is the thing sens actually moves, so accuracy (plus the hero's
          // own signature/crit stat) is now what this study measures. winRate
          // stays as a plain readout — never as curve-fit input, never as a
          // ranking or recommendation signal. See METRICS below, where it has
          // been removed from the set that drives metricTrends/findings.
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

  // Fits a quadratic across a set of already-bucketed scales (some value vs.
  // sens @MOUSE_DPI, weighted by n) and locates its vertex — the best-guess
  // "true" optimal sens, as opposed to just whichever tested scale happened
  // to score best. Defaults to avgDelta (accuracy, not avgOverall, so heroes
  // still mix fairly — same reasoning as the rest of this page's
  // normalization) but takes valueOf so the identical fit can be run against
  // a hero-specific channel instead (see heroStatCurveFit below) — the
  // accuracy curve and the hero-stat curve are two separate, unit-consistent
  // fits shown with equal standing, not one blended line (blending percentage
  // deltas with a raw per-match count like Shion's "Execution kills" would
  // make the y-axis mean nothing).
  const curveFitOf = (
    scales: ReturnType<typeof byScale>,
    valueOf: (s: ReturnType<typeof byScale>[number]) => number | null = s => s.avgDelta,
  ) => {
    const cpts: CurvePoint[] = scales
      .filter(s => valueOf(s) != null)
      .map(s => ({ x: s.eDPI / MOUSE_DPI, y: valueOf(s) as number, w: s.n }));
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

  // ── Co-primary "best scale" selection ─────────────────────────────────────
  // Sean's call, 2026-09-17: "hero stats should be co-primary, weight them
  // equally." Every place that picks a single "best" scale — a hero's own
  // best sens, the roster-wide recommendation — used to rank by accuracy
  // alone. This ranks by RANK, not raw magnitude: accuracy deltas are
  // percentage points, but a signature stat can be a raw per-match count, so
  // averaging raw deltas would just let whichever channel has bigger numbers
  // win. Ranking each channel among the candidates first, then averaging the
  // ranks, makes "equal weight" hold regardless of units — a hero-stat
  // channel that's merely SECOND-best still pulls the combined score exactly
  // as hard as accuracy being second-best would.
  function rankOf<T>(items: T[], valueOf: (t: T) => number | null): Map<T, number> {
    const withVal = items
      .map(it => ({ it, v: valueOf(it) }))
      .filter((x): x is { it: T; v: number } => x.v != null)
      .sort((a, b) => b.v - a.v); // descending: higher value = better = rank 1
    const ranks = new Map<T, number>();
    withVal.forEach((x, i) => ranks.set(x.it, i + 1));
    return ranks;
  }

  // accuracyOf is the one always-available channel; heroStatChannels are
  // whichever hero-specific deltas exist for these items (crit/extra/
  // signature stat) — they're pooled into ONE "hero stats" rank by averaging
  // their own ranks first, so the hero-stat coalition counts once against
  // accuracy, not three times just because three channels happen to exist.
  // Falls back to whichever single arm has data when the other is entirely
  // absent (e.g. a hero with no crit/extra/signature stat logged at all), and
  // falls back to the first item when NEITHER arm has data for anything —
  // same "always return something" contract a plain reduce() has.
  function coPrimaryBest<T>(
    items: T[],
    accuracyOf: (t: T) => number | null,
    heroStatChannels: ((t: T) => number | null)[],
  ): T | null {
    if (!items.length) return null;
    const accRank = rankOf(items, accuracyOf);
    const channelRanks = heroStatChannels.map(ch => rankOf(items, ch));
    let best: T | null = null;
    let bestScore = Infinity;
    for (const it of items) {
      const a = accRank.get(it) ?? null;
      const subRanks = channelRanks.map(r => r.get(it)).filter((r): r is number => r != null);
      const h = subRanks.length ? subRanks.reduce((s, r) => s + r, 0) / subRanks.length : null;
      const score = a != null && h != null ? (a + h) / 2 : (a ?? h);
      if (score != null && score < bestScore) { bestScore = score; best = it; }
    }
    return best ?? items[0];
  }

  // ── Does this metric actually move with sens? ────────────────────────────
  // The rest of this rollup reports values per scale and leaves the reader to
  // eyeball whether a pattern exists. Eyeballing is exactly how the retired
  // map/hour "key patterns" happened: pick the highest bucket out of eight and
  // it will always look like something. This asks the question numerically
  // instead, for EVERY metric rather than accuracy alone.
  //
  // A weighted straight line is fitted through the scales (see fitLinearTrend)
  // and reported with three things the reader needs together: which direction
  // it points, how much it predicts across the whole tested range, and how
  // well the line actually matches the points (r2). A steep slope with a
  // scattered r2 is not a finding, and reporting the slope alone would hide
  // that. Nothing here is a verdict — it's the evidence, stated honestly.
  //
  // Two bases, and picking the wrong one is the difference between a finding
  // and a mirage. `raw` is the metric itself — right when the trend is scoped
  // to ONE hero, where the hero is held constant by construction. `normalized`
  // is the same metric expressed as that hero's own leave-one-scale-out delta,
  // and it's mandatory when pooling the whole roster: Pharah averages ~13,500
  // damage per 10 minutes and Ana ~4,700, so a pooled raw trend across scales
  // mostly measures WHICH HEROES happened to be tested where, not sens. Same
  // reason the existing curve fit uses avgDelta rather than avgOverall.
  // winRate is deliberately absent from this list (2026-09-17, Sean's call —
  // see the retired-premise comment on byScale's winRate field above). It is
  // not one of the outcomes this study fits a trend to, and it can't earn a
  // spot in the "Does Sens Move Anything?" findings section, because a match
  // outcome is dominated by four other people, a map, and a comp, not by
  // Sean's crosshair. It still exists on every scale/hero row as a plain,
  // clearly-labeled readout — this list only controls curve-fit/finding
  // inputs, not what's displayed.
  const METRICS = [
    { key: 'overall', label: 'Overall accuracy', unit: '%', pick: (sc: any) => sc.avgOverall, norm: (sc: any) => sc.avgDelta, n: (sc: any) => sc.n },
    { key: 'crit', label: 'Signature/crit stat', unit: '%', pick: (sc: any) => sc.avgCrit, norm: (sc: any) => sc.avgCritDelta, n: (sc: any) => sc.n },
    { key: 'dmg10', label: 'Damage per 10 min', unit: '', pick: (sc: any) => sc.avgDmg10, norm: (sc: any) => sc.avgDmg10Delta, n: (sc: any) => sc.nRate },
    { key: 'heal10', label: 'Healing per 10 min', unit: '', pick: (sc: any) => sc.avgHeal10, norm: (sc: any) => sc.avgHeal10Delta, n: (sc: any) => sc.nHeal },
    { key: 'elims10', label: 'Elims per 10 min', unit: '', pick: (sc: any) => sc.avgElims10, norm: (sc: any) => sc.avgElims10Delta, n: (sc: any) => sc.nRate },
    { key: 'deaths10', label: 'Deaths per 10 min', unit: '', pick: (sc: any) => sc.avgDeaths10, norm: (sc: any) => sc.avgDeaths10Delta, n: (sc: any) => sc.nRate },
  ] as const;

  // Deaths are the one metric here where DOWN is good. Stated as data rather
  // than left to the reader, so a client can't accidentally paint a rising
  // death rate green just because every other metric rises in the good
  // direction.
  const LOWER_IS_BETTER = new Set(['deaths10']);

  const trendsOf = (scales: ReturnType<typeof byScale>, basis: 'raw' | 'normalized' = 'raw') =>
    METRICS.map(m => {
      const valueOf = basis === 'normalized' ? m.norm : m.pick;
      const cpts: CurvePoint[] = scales
        .map(sc => ({ x: sc.eDPI / MOUSE_DPI, y: valueOf(sc as any), w: m.n(sc as any) }))
        .filter((pt): pt is CurvePoint => pt.y != null && pt.w > 0)
        .map(pt => ({ x: pt.x, y: pt.y as number, w: pt.w }));
      const fit = fitLinearTrend(cpts);
      return {
        key: m.key,
        label: m.label,
        unit: m.unit,
        basis,
        lowerIsBetter: LOWER_IS_BETTER.has(m.key),
        scales: cpts.length,
        totalN: fit?.totalN ?? cpts.reduce((a, b) => a + b.w, 0),
        slope: fit ? Math.round(fit.slope * 1000) / 1000 : null,
        spanDelta: fit ? Math.round(fit.spanDelta * 100) / 100 : null,
        r2: fit ? Math.round(fit.r2 * 1000) / 1000 : null,
        sensMin: fit ? Math.round(fit.xMin * 100) / 100 : null,
        sensMax: fit ? Math.round(fit.xMax * 100) / 100 : null,
      };
    });

  const bucket = (items: typeof pts, label: string) => ({
    bucket: label,
    n: items.length,
    avgOverall: mean(items.map(p => p.overall_acc)),
    avgDelta: mean(items.filter(p => p.delta != null).map(p => p.delta as number)),
    avgFeel: mean(items.filter(p => p.feel != null).map(p => p.feel as number)),
    winRate: mult100(mean(items.map(p => p.win))),
  });

  // MIN_SCALE_N guard applied at roster scope (2026-09-17, Sean's call) — a
  // below-threshold bucket must not feed a curve fit, finding, or pick.
  const reliableRosterScales = byScale(pts).filter(s => s.reliable);

  return {
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
    // byScale itself stays UNFILTERED — every scale is shown, including thin
    // ones (the client greys them out and labels them). Only the curve fits
    // and metricTrends below, which each pick/estimate a result, are scoped
    // to reliableRosterScales — visible and excluded, not visible and
    // counted (2026-09-17, Sean's minimum-n call).
    byScale: byScale(pts),
    overallCurveFit: curveFitOf(reliableRosterScales),
    // Co-primary companion to overallCurveFit (2026-09-17, Sean's call) — the
    // same quadratic fit run against avgCritDelta instead of avgDelta. Crit
    // is the roster-level channel this uses (not extra_acc or the signature
    // stat) because it's the one hero-specific channel already pooled across
    // the whole roster elsewhere (metricTrends' 'crit' key) — extra_acc only
    // exists for 4 heroes and hero_stat_value mixes percentages with raw
    // per-match counts across different heroes, neither of which fit cleanly
    // into one roster-wide curve.
    heroStatCurveFit: curveFitOf(reliableRosterScales, s => s.avgCritDelta),
    // Every metric's relationship with sens across the whole roster.
    metricTrends: trendsOf(reliableRosterScales, 'normalized'),
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
        // Only scales at or above MIN_SCALE_N are eligible to win: picking the
        // highest average across ALL buckets meant one lucky game at an
        // otherwise-untested scale could outrank a scale with 30 games behind
        // it — and that pick is surfaced as a sens RECOMMENDATION downstream.
        // With no eligible scale the honest answer is "not enough data",
        // expressed as nulls rather than a fabricated best guess.
        const scales = byScale(ps);
        const eligible = scales.filter(s => s.reliable);
        // Co-primary pick (2026-09-17, Sean's call): used to rank by
        // avgOverall (accuracy) alone. Now ranks accuracy and this hero's own
        // crit/extra/signature-stat channels equally — see coPrimaryBest
        // above. Raw per-scale values, not deltas: every candidate here is
        // already the SAME hero, so there's no cross-hero baseline to correct
        // for, and raw values stay defined even for a hero with only one
        // eligible scale (where a LOSO delta would be null).
        const bestScale = coPrimaryBest(
          eligible,
          s => s.avgOverall,
          [s => s.avgCrit, s => s.avgExtra, s => s.avgHeroStat],
        );
        // Richest available hero-stat channel for THIS hero, by how many
        // readings back it — used for heroStatCurveFit below so the fit runs
        // on one unit-consistent channel rather than blending percentages
        // with a raw per-match count.
        const nCrit = ps.filter(p => p.crit_acc != null).length;
        const nExtra = ps.filter(p => p.extra_acc != null).length;
        const nHeroStatReadings = ps.filter(p => p.heroStat != null).length;
        const heroStatChannel: 'crit' | 'extra' | 'heroStat' | null =
          nCrit === 0 && nExtra === 0 && nHeroStatReadings === 0 ? null
            : nCrit >= nExtra && nCrit >= nHeroStatReadings ? 'crit'
            : nExtra >= nHeroStatReadings ? 'extra' : 'heroStat';
        const heroStatValueOf: ((s: ReturnType<typeof byScale>[number]) => number | null) | null =
          heroStatChannel === 'crit' ? (s => s.avgCritDelta)
            : heroStatChannel === 'extra' ? (s => s.avgExtraDelta)
            : heroStatChannel === 'heroStat' ? (s => s.avgHeroStatDelta)
            : null;
        return {
          hero: hero as string,
          archetype: ps[0].archetype,
          n: ps.length,
          avgOverall: mean(ps.map(p => p.overall_acc)),
          avgCrit: mean(ps.filter(p => p.crit_acc != null).map(p => p.crit_acc as number)),
          // The signature stat's own name, read off the data rather than
          // hardcoded — hero_stat_label is stored per match, so the server can
          // say "Charged Shot Accuracy %" instead of leaving the client to
          // guess what hero_stat_value means. Most recent non-null label wins
          // if a hero's label was ever renamed mid-study.
          heroStatLabel: [...ps].reverse().find(p => p.heroStatLabel != null)?.heroStatLabel ?? null,
          nHeroStat: ps.filter(p => p.heroStat != null).length,
          avgHeroStat: mean(ps.filter(p => p.heroStat != null).map(p => p.heroStat as number)),
          nExtra: ps.filter(p => p.extra_acc != null).length,
          avgExtra: mean(ps.filter(p => p.extra_acc != null).map(p => p.extra_acc as number)),
          winRate: mult100(mean(ps.map(p => p.win))),
          // Null when no scale clears MIN_SCALE_N — consumers must handle the
          // "no reliable best yet" case rather than render a thin pick.
          bestScaleReliable: bestScale != null,
          bestScaleEDPI: bestScale?.eDPI ?? null,
          bestScaleN: bestScale?.n ?? 0,
          bestScaleOverallDelta: bestScale?.avgDelta ?? null,
          bestScaleCritDelta: bestScale?.avgCritDelta ?? null,
          bestScaleExtraDelta: bestScale?.avgExtraDelta ?? null,
          bestScaleHeroStatDelta: bestScale?.avgHeroStatDelta ?? null,
          bestScaleWinRate: bestScale?.winRate ?? null,
          // Full per-scale curve (not just the best one) so the analysis page
          // can trace this hero's accuracy across every sens it's actually
          // been tested at, ascending by cm/360 — UNFILTERED, thin scales
          // included (visible, greyed out client-side). `eligible` (n>=
          // MIN_SCALE_N) is what feeds curveFit/heroStatCurveFit/metricTrends
          // below, same "visible and excluded, not visible and counted" rule
          // as the roster level.
          scales,
          // Quadratic best-fit across those scales — null until a hero has
          // 3+ RELIABLE tested scales (see fitQuadraticPeak). Accuracy-based.
          curveFit: curveFitOf(eligible),
          // Co-primary companion to curveFit (2026-09-17, Sean's call) — the
          // SAME quadratic fit, run against this hero's own richest
          // hero-specific channel instead of accuracy, so the page can show
          // "where accuracy peaks" and "where this hero's own stat peaks"
          // with equal standing rather than only ever fitting a curve to
          // accuracy. null when the hero has no crit/extra/signature-stat
          // readings at all (heroStatChannel null) — nothing to fit.
          heroStatCurveFit: heroStatValueOf ? curveFitOf(eligible, heroStatValueOf) : null,
          heroStatCurveChannel: heroStatChannel,
          // Same trend question asked for this hero alone.
          metricTrends: trendsOf(eligible),
        };
      })
      .sort((a, b) => b.n - a.n),
  };
}

router.get('/analysis', (_req: Request, res: Response) => {
  res.json(computeAnalysis(getDb()));
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
  const heroesStmt = db.prepare('SELECT hero, role, sens FROM match_heroes WHERE match_id = :id ORDER BY slot');
  const heroAccStmt = db.prepare('SELECT hero, overall_acc, crit_acc, extra_acc, torpedo_damage, torpedo_healing, duration_min FROM aim_stats_heroes WHERE match_id = :id');
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

  // The payload is the complete roster for this match, not a patch — the same
  // way an omitted FIELD on a hero clears that field rather than keeping the
  // old value. So a hero missing from heroes[] means "this hero wasn't
  // played," and its row goes. Without the delete there was no way at all to
  // withdraw a mis-entered hero through the API: the row survived every
  // correction, kept feeding per-hero accuracy for a match it was never in,
  // and left aim_stats.duration_min disagreeing with the per-hero sum by
  // exactly that hero's minutes. Wrapped with the writes below so a failure
  // partway can't leave the roster half-deleted.
  db.exec('BEGIN');
  try {
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
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  res.json({ ok: true });
});

export default router;
