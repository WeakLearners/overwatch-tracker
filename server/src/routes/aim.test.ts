// Tier 2: DB-backed tests for aim.ts's /api/aim/analysis rollup. The route
// handler's body was extracted verbatim into computeAnalysis(db) so it's
// importable here without going through Express (Tier 3 territory) — no
// logic changed in the extraction, the route is now a one-line wrapper that
// calls this and returns the result as JSON. See the diff in aim.ts.
//
// cm360/eDPI/fitQuadraticPeak/deriveSessionPosition/deriveSensAdaptation
// (the primitives this rollup calls) already have exact hand-verified
// coverage in lib/aim.test.ts (Tier 1) — this file focuses on the
// aggregation logic specific to computeAnalysis itself: per-hero
// leave-one-scale-out baselines, legacy-sens absorption, and the sens
// IS NOT NULL filter — not on re-deriving curve-fit math already covered.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb, closeDb } from '../db/schema';
import { insertMatch, insertHeroSlot, insertAimStats, insertAimStatsHero } from '../db/fixtures';
import { computeAnalysis, MIN_SCALE_N } from './aim';
import { setCurveParams } from '../lib/curveParams';

let tmpPath: string;
let db: ReturnType<typeof getDb>;

beforeEach(() => {
  tmpPath = path.join(os.tmpdir(), `overwatch-aim-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = getDb(tmpPath);
});

afterEach(() => {
  closeDb();
  for (const f of [tmpPath, `${tmpPath}-wal`, `${tmpPath}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

// Inserts one fully-formed study data point: a match, its slot-1
// match_heroes row (with an explicit per-hero sens, as real switch-aware
// rows carry), and matching aim_stats/aim_stats_heroes rows. Mirrors what
// the real Match Tracker + Aim Stats form together produce for a single-hero
// match.
function insertStudyPoint(db: ReturnType<typeof getDb>, opts: {
  date: string; hero: string; role?: string; sens: number; dpi?: number;
  win: 0 | 1; blindTrial?: 0 | 1; overallAcc: number;
}) {
  const matchId = insertMatch(db, {
    date: opts.date, hero: opts.hero, role: opts.role ?? 'DPS', win: opts.win,
    sens: opts.sens, dpi: opts.dpi ?? 1600, blind_trial: opts.blindTrial ?? 0,
  });
  insertHeroSlot(db, { match_id: matchId, slot: 1, hero: opts.hero, role: opts.role ?? 'DPS', sens: opts.sens });
  insertAimStats(db, { match_id: matchId, overall_acc: opts.overallAcc, duration_min: 10 });
  insertAimStatsHero(db, { match_id: matchId, hero: opts.hero, overall_acc: opts.overallAcc });
  return matchId;
}

describe('computeAnalysis', () => {
  test('empty DB: no crash, all-empty shape, no NaN', () => {
    const r = computeAnalysis(db);
    assert.equal(r.summary.n, 0);
    assert.equal(r.summary.distinctScale, 0);
    assert.equal(r.summary.lastUpdated, null);
    assert.deepEqual(r.byScale, []);
    assert.equal(r.overallCurveFit, null);
    assert.deepEqual(r.byArchetype.hitscan, []);
    assert.deepEqual(r.byArchetype.projectile, []);
    assert.deepEqual(r.heroes, []);
    assert.deepEqual(r.timeline, []);
  });

  test('a match_heroes row with sens = NULL is excluded entirely (mh.sens IS NOT NULL)', () => {
    // A switch-hero row whose real sens couldn't be reconstructed
    // (scripts/backfill-hero-sens) — insertHeroSlot with sens omitted
    // leaves match_heroes.sens NULL for this row even though matches.sens
    // is set, exactly the case the WHERE clause is guarding against.
    const matchId = insertMatch(db, { date: '2026-01-01', hero: 'Ashe', role: 'DPS', win: 1, sens: 2.0, dpi: 1600 });
    insertHeroSlot(db, { match_id: matchId, slot: 1, hero: 'Ashe', role: 'DPS' }); // sens omitted -> NULL
    insertAimStats(db, { match_id: matchId, overall_acc: 50, duration_min: 10 });
    insertAimStatsHero(db, { match_id: matchId, hero: 'Ashe', overall_acc: 50 });
    const r = computeAnalysis(db);
    assert.equal(r.summary.n, 0, 'the null-sens row must not surface as a data point');
  });

  test('two blind-trial scales for one hero: hand-computed leave-one-scale-out deltas, win rates, thin buckets still shown in byScale', () => {
    // Bucket A: sens=2.0 @1600dpi -> cm360 = 914.4/(0.0066*2.0*1600) = 43.2955 -> rounds to 43.3.
    // Bucket B: sens=3.0 @1600dpi -> cm360 = 914.4/(0.0066*3.0*1600) = 28.8636 -> rounds to 28.9.
    // Bucket A: overall_acc 40,44,48 (mean 44), all losses (win=0).
    // Bucket B: overall_acc 52,56,60 (mean 56), all wins (win=1).
    // Leave-one-out baseline for A = B's mean (56); for B = A's mean (44).
    // deltaA = acc - 56 -> [-16,-12,-8], avgDelta = -12.
    // deltaB = acc - 44 -> [8,12,16], avgDelta = 12.
    for (const acc of [40, 44, 48]) insertStudyPoint(db, { date: '2026-01-01', hero: 'Ashe', sens: 2.0, win: 0, blindTrial: 1, overallAcc: acc });
    for (const acc of [52, 56, 60]) insertStudyPoint(db, { date: '2026-01-02', hero: 'Ashe', sens: 3.0, win: 1, blindTrial: 1, overallAcc: acc });

    const r = computeAnalysis(db);
    assert.equal(r.summary.n, 6);
    assert.equal(r.summary.distinctScale, 2);
    assert.equal(r.byScale.length, 2);

    const bucketA = r.byScale.find(s => s.cm360 === 43.3)!;
    const bucketB = r.byScale.find(s => s.cm360 === 28.9)!;
    assert.ok(bucketA, 'expected a 43.3 cm/360 bucket');
    assert.ok(bucketB, 'expected a 28.9 cm/360 bucket');

    // byScale itself is never gated (2026-09-17: "visible and excluded, not
    // visible and counted") — a 3-game bucket (below MIN_SCALE_N=5) is still
    // returned here, just flagged unreliable and excluded from curve
    // fits/findings/picks (see the minimum-n guard tests below).
    assert.equal(bucketA.n, 3);
    assert.equal(bucketB.n, 3);
    assert.equal(bucketA.reliable, false);
    assert.equal(bucketB.reliable, false);
    assert.equal(bucketA.avgOverall, 44);
    assert.equal(bucketB.avgOverall, 56);
    assert.equal(bucketA.avgDelta, -12);
    assert.equal(bucketB.avgDelta, 12);
    assert.equal(bucketA.winRate, 0);
    assert.equal(bucketB.winRate, 100);
    assert.equal(bucketA.absorbedN, 0);
    assert.equal(bucketB.absorbedN, 0);

    // Only 2 distinct x values -> fitQuadraticPeak needs >=3, so the overall
    // curve fit is correctly null (same guard verified directly in
    // lib/aim.test.ts's fitQuadraticPeak suite).
    assert.equal(r.overallCurveFit, null);

    // Ashe is hitscan (HERO_ARCHETYPE) -> both buckets land in byArchetype.hitscan, none in projectile.
    assert.equal(r.byArchetype.hitscan.length, 2);
    assert.equal(r.byArchetype.projectile.length, 0);

    assert.equal(r.heroes.length, 1);
    assert.equal(r.heroes[0].hero, 'Ashe');
    assert.equal(r.heroes[0].n, 6);
  });

  test('a legacy near-2.5 sens point is absorbed into the nearest blind-trial bucket, not left as its own bucket', () => {
    // Same two blind buckets as above (cm 43.3 for sens 2.0, cm 28.9 for
    // sens 3.0), plus one legacy point at sens=2.45 (one of
    // LEGACY_SENS_ABSORB's exact values), blind_trial=0.
    // cm360(2.45, 1600) = 914.4/(0.0066*2.45*1600) = 35.3532 -> rounds to 35.4.
    // |43.3-35.4| = 7.9 vs |28.9-35.4| = 6.5 -> nearest is 28.9 (bucket B).
    for (const acc of [40, 44, 48]) insertStudyPoint(db, { date: '2026-01-01', hero: 'Ashe', sens: 2.0, win: 0, blindTrial: 1, overallAcc: acc });
    for (const acc of [52, 56, 60]) insertStudyPoint(db, { date: '2026-01-02', hero: 'Ashe', sens: 3.0, win: 1, blindTrial: 1, overallAcc: acc });
    insertStudyPoint(db, { date: '2026-01-03', hero: 'Ashe', sens: 2.45, win: 1, blindTrial: 0, overallAcc: 58 });

    const r = computeAnalysis(db);
    assert.equal(r.summary.n, 7);
    // Still only 2 scale buckets -- the legacy point did not create a third.
    assert.equal(r.summary.distinctScale, 2);

    const bucketA = r.byScale.find(s => s.cm360 === 43.3)!;
    const bucketB = r.byScale.find(s => s.cm360 === 28.9)!;
    assert.equal(bucketA.n, 3);
    assert.equal(bucketA.absorbedN, 0);
    assert.equal(bucketB.n, 4, 'the legacy point should have joined bucket B');
    assert.equal(bucketB.absorbedN, 1);
  });

  test('a legacy near-2.5 sens point with no blind bucket to absorb into is dropped outright', () => {
    // Only a legacy point exists, no blind_trial=1 matches at all -> no
    // absorption target -> nearestBlindCm returns null -> the point is
    // filtered out of ptsAbsorbed entirely.
    insertStudyPoint(db, { date: '2026-01-01', hero: 'Ashe', sens: 2.45, win: 1, blindTrial: 0, overallAcc: 58 });
    const r = computeAnalysis(db);
    assert.equal(r.summary.n, 0, 'a legacy point with nothing to absorb into should not appear as its own bucket');
  });

  test('a hero with only 1 distinct scale bucket gets a null delta (nothing to compare against)', () => {
    for (const acc of [40, 44, 48]) insertStudyPoint(db, { date: '2026-01-01', hero: 'Ashe', sens: 2.0, win: 0, blindTrial: 1, overallAcc: acc });
    const r = computeAnalysis(db);
    assert.equal(r.byScale.length, 1);
    assert.equal(r.byScale[0].avgDelta, null, 'a single scale bucket has no "other scales" to score against');
  });
});

// --- MIN_SCALE_N guard (added 2026-09-12) -----------------------------------
// bestScale used to be `scales.reduce(highest avgOverall)` with no regard for
// sample size, so one lucky game at an otherwise-untested scale could be
// selected as a hero's best — and that pick drives a sens recommendation on
// the pre-match page. These tests pin the guard: thin scales are still
// RETURNED (data isn't hidden), they're just never SELECTED.
describe('computeAnalysis: bestScale n-guard', () => {
  // Builds one hero with a well-tested scale and a thin outlier scale whose
  // single game scores far higher than anything the tested scale ever did.
  function heroWithThinOutlier(hero: string, opts: { tested: number; outlier: number }) {
    // `tested` games at sens 2.50, all mediocre.
    for (let i = 0; i < opts.tested; i++) {
      insertStudyPoint(db, { date: `2026-08-${String(10 + i).padStart(2, '0')}`, hero, sens: 2.5, win: 1, overallAcc: 40 });
    }
    // `outlier` game(s) at sens 3.00, wildly better — the trap.
    for (let i = 0; i < opts.outlier; i++) {
      insertStudyPoint(db, { date: `2026-09-${String(1 + i).padStart(2, '0')}`, hero, sens: 3.0, win: 1, overallAcc: 95 });
    }
  }

  test('a single lucky game does not become the best scale', () => {
    heroWithThinOutlier('Sojourn', { tested: 8, outlier: 1 });
    const h = computeAnalysis(db).heroes.find(x => x.hero === 'Sojourn')!;
    assert.equal(h.bestScaleReliable, true);
    assert.equal(h.bestScaleN, 8, 'should select the 8-game scale, not the 1-game one');
    // The pre-match recommendation must point at the tested scale.
    assert.equal(h.bestScaleEDPI, Math.round(2.5 * 1600));
  });

  test('the thin scale is still returned, just not selected', () => {
    heroWithThinOutlier('Sojourn', { tested: 8, outlier: 1 });
    const h = computeAnalysis(db).heroes.find(x => x.hero === 'Sojourn')!;
    // Absorb-don't-delete: the outlier is visible in the per-scale breakdown.
    const thin = h.scales.find(s => s.n === 1);
    assert.ok(thin, 'thin scale should still appear in scales[]');
    assert.equal(thin!.reliable, false);
    assert.ok(h.scales.some(s => s.reliable), 'the tested scale should be marked reliable');
  });

  test('a hero with NO scale clearing the bar reports nulls, not a guess', () => {
    // Three scales, two games each — nothing reaches MIN_SCALE_N.
    for (const [i, sens] of [2.4, 2.5, 2.6].entries()) {
      for (let g = 0; g < 2; g++) {
        insertStudyPoint(db, { date: `2026-08-${String(10 + i * 2 + g).padStart(2, '0')}`, hero: 'Ana', role: 'Support', sens, win: 1, overallAcc: 40 + i * 10 });
      }
    }
    const h = computeAnalysis(db).heroes.find(x => x.hero === 'Ana')!;
    assert.equal(h.bestScaleReliable, false);
    assert.equal(h.bestScaleEDPI, null);
    assert.equal(h.bestScaleN, 0);
    assert.equal(h.bestScaleOverallDelta, null);
    assert.equal(h.bestScaleWinRate, null);
    // But the hero itself is still reported with its games.
    assert.equal(h.n, 6);
    assert.equal(h.scales.length, 3);
  });

  test('exactly MIN_SCALE_N games qualifies (boundary is inclusive)', () => {
    for (let i = 0; i < MIN_SCALE_N; i++) {
      insertStudyPoint(db, { date: `2026-08-${String(10 + i).padStart(2, '0')}`, hero: 'Tracer', sens: 2.5, win: 1, overallAcc: 40 });
    }
    const h = computeAnalysis(db).heroes.find(x => x.hero === 'Tracer')!;
    assert.equal(h.bestScaleReliable, true);
    assert.equal(h.bestScaleN, MIN_SCALE_N);
  });

  test('one game below MIN_SCALE_N does not qualify', () => {
    for (let i = 0; i < MIN_SCALE_N - 1; i++) {
      insertStudyPoint(db, { date: `2026-08-${String(10 + i).padStart(2, '0')}`, hero: 'Tracer', sens: 2.5, win: 1, overallAcc: 40 });
    }
    const h = computeAnalysis(db).heroes.find(x => x.hero === 'Tracer')!;
    assert.equal(h.bestScaleReliable, false);
    assert.equal(h.bestScaleEDPI, null);
  });

  test('between two reliable scales, the higher accuracy still wins', () => {
    // The guard must not change ordering among scales that both qualify.
    for (let i = 0; i < 6; i++) {
      insertStudyPoint(db, { date: `2026-08-${String(10 + i).padStart(2, '0')}`, hero: 'Ashe', sens: 2.5, win: 1, overallAcc: 38 });
    }
    for (let i = 0; i < 6; i++) {
      insertStudyPoint(db, { date: `2026-09-${String(1 + i).padStart(2, '0')}`, hero: 'Ashe', sens: 2.8, win: 1, overallAcc: 47 });
    }
    const h = computeAnalysis(db).heroes.find(x => x.hero === 'Ashe')!;
    assert.equal(h.bestScaleReliable, true);
    assert.equal(h.bestScaleEDPI, Math.round(2.8 * 1600));
  });
});

// ── Ability-level stat channels (wired into computeAnalysis 2026-09-15) ──────
// extra_acc and hero_stat_label/value were collected by the entry form from the
// start but never selected by this rollup, so 618 logged readings reached no
// analysis surface. These pin the three things that wiring has to get right:
// the values arrive per scale, the match-level signature stat is attributed to
// the match's PRIMARY hero only, and each channel reports its own n rather than
// borrowing the scale bucket's.
describe('computeAnalysis — ability-level stat channels', () => {
  // Two scales x two games, with a signature stat and an extra_acc reading on
  // every game, so each bucket's per-channel averages are hand-checkable.
  function insertAbilityPoint(opts: {
    date: string; hero: string; sens: number; win: 0 | 1;
    overallAcc: number; critAcc?: number; extraAcc?: number;
    statLabel?: string; statValue?: number; primaryHero?: string;
  }) {
    const primary = opts.primaryHero ?? opts.hero;
    const matchId = insertMatch(db, {
      date: opts.date, hero: primary, role: 'Support', win: opts.win,
      sens: opts.sens, dpi: 1600, blind_trial: 1,
    });
    insertHeroSlot(db, { match_id: matchId, slot: 1, hero: primary, role: 'Support', sens: opts.sens });
    if (primary !== opts.hero) {
      insertHeroSlot(db, { match_id: matchId, slot: 2, hero: opts.hero, role: 'Support', sens: opts.sens });
    }
    insertAimStats(db, {
      match_id: matchId, overall_acc: opts.overallAcc, duration_min: 10,
      hero_stat_label: opts.statLabel ?? null, hero_stat_value: opts.statValue ?? null,
    });
    insertAimStatsHero(db, {
      match_id: matchId, hero: opts.hero,
      overall_acc: opts.overallAcc, crit_acc: opts.critAcc ?? null, extra_acc: opts.extraAcc ?? null,
    });
    return matchId;
  }

  test('extra_acc and the signature stat surface per scale with their own averages', () => {
    // Scale 2.00: extra 10 and 20 -> 15. Scale 3.00: extra 30 and 50 -> 40.
    // Signature stat 4 and 6 -> 5, then 8 and 12 -> 10.
    insertAbilityPoint({ date: '2026-01-01', hero: 'Ana', sens: 2.0, win: 1, overallAcc: 50, extraAcc: 10, statLabel: 'Sleep Darts', statValue: 4 });
    insertAbilityPoint({ date: '2026-01-02', hero: 'Ana', sens: 2.0, win: 0, overallAcc: 50, extraAcc: 20, statLabel: 'Sleep Darts', statValue: 6 });
    insertAbilityPoint({ date: '2026-01-03', hero: 'Ana', sens: 3.0, win: 1, overallAcc: 60, extraAcc: 30, statLabel: 'Sleep Darts', statValue: 8 });
    insertAbilityPoint({ date: '2026-01-04', hero: 'Ana', sens: 3.0, win: 0, overallAcc: 60, extraAcc: 50, statLabel: 'Sleep Darts', statValue: 12 });

    const ana = computeAnalysis(db).heroes.find(h => h.hero === 'Ana');
    assert.ok(ana, 'Ana missing from heroes[]');
    assert.equal(ana.scales.length, 2);
    const [lo, hi] = ana.scales; // byScale sorts ascending by cm/360; 2.0 sens = larger cm/360
    const low = lo.sens === 2.0 ? lo : hi;
    const high = lo.sens === 2.0 ? hi : lo;

    assert.equal(low.avgExtra, 15);
    assert.equal(low.nExtra, 2);
    assert.equal(low.avgHeroStat, 5);
    assert.equal(low.nHeroStat, 2);
    assert.equal(high.avgExtra, 40);
    assert.equal(high.avgHeroStat, 10);

    // The label is read off the stored data, not hardcoded.
    assert.equal(ana.heroStatLabel, 'Sleep Darts');
    assert.equal(ana.nHeroStat, 4);
    assert.equal(ana.avgHeroStat, 7.5); // (4+6+8+12)/4
    assert.equal(ana.nExtra, 4);
  });

  test('the match-level signature stat is credited to the primary hero only', () => {
    // One match, Ana primary with a switch to Kiriko. hero_stat_value lives on
    // aim_stats (per match) and describes Ana; Kiriko must not inherit it.
    insertAbilityPoint({ date: '2026-01-01', hero: 'Ana', sens: 2.0, win: 1, overallAcc: 50, statLabel: 'Sleep Darts', statValue: 9 });
    insertAbilityPoint({ date: '2026-01-02', hero: 'Kiriko', sens: 2.0, win: 1, overallAcc: 50, statLabel: 'Sleep Darts', statValue: 9, primaryHero: 'Ana' });

    const heroes = computeAnalysis(db).heroes;
    const ana = heroes.find(h => h.hero === 'Ana');
    const kiriko = heroes.find(h => h.hero === 'Kiriko');
    assert.ok(ana && kiriko);
    assert.equal(ana.nHeroStat, 1, 'Ana should claim only her own match');
    assert.equal(kiriko.nHeroStat, 0, 'the switched-to hero must not inherit the primary hero\'s signature stat');
    assert.equal(kiriko.avgHeroStat, null);
    assert.equal(kiriko.heroStatLabel, null);
  });

  test("a channel's n is independent of the scale bucket's n", () => {
    // Three games at one scale, only one carrying an extra_acc reading. The
    // bucket reads n=3 while the channel honestly reads n=1 — the distinction
    // the UI needs so a single reading isn't presented as three games of evidence.
    insertAbilityPoint({ date: '2026-01-01', hero: 'Ana', sens: 2.0, win: 1, overallAcc: 50, extraAcc: 44 });
    insertAbilityPoint({ date: '2026-01-02', hero: 'Ana', sens: 2.0, win: 0, overallAcc: 50 });
    insertAbilityPoint({ date: '2026-01-03', hero: 'Ana', sens: 2.0, win: 1, overallAcc: 50 });

    const ana = computeAnalysis(db).heroes.find(h => h.hero === 'Ana');
    assert.ok(ana);
    assert.equal(ana.scales[0].n, 3);
    assert.equal(ana.scales[0].nExtra, 1);
    assert.equal(ana.scales[0].avgExtra, 44);
    assert.equal(ana.scales[0].nHeroStat, 0);
    assert.equal(ana.scales[0].avgHeroStat, null);
  });

  test('deltas for the new channels use the same leave-one-scale-out baseline as accuracy', () => {
    // Ana at two scales. extra_acc: scale A = 10,20 (mean 15); scale B = 40,60
    // (mean 50). A point at scale A is scored against scale B's mean only, so
    // 10 - 50 = -40 and 20 - 50 = -30, averaging -35 for the bucket.
    insertAbilityPoint({ date: '2026-01-01', hero: 'Ana', sens: 2.0, win: 1, overallAcc: 50, extraAcc: 10 });
    insertAbilityPoint({ date: '2026-01-02', hero: 'Ana', sens: 2.0, win: 0, overallAcc: 50, extraAcc: 20 });
    insertAbilityPoint({ date: '2026-01-03', hero: 'Ana', sens: 3.0, win: 1, overallAcc: 50, extraAcc: 40 });
    insertAbilityPoint({ date: '2026-01-04', hero: 'Ana', sens: 3.0, win: 0, overallAcc: 50, extraAcc: 60 });

    const ana = computeAnalysis(db).heroes.find(h => h.hero === 'Ana');
    assert.ok(ana);
    const low = ana.scales.find(s => s.sens === 2.0)!;
    const high = ana.scales.find(s => s.sens === 3.0)!;
    assert.equal(low.avgExtraDelta, -35);
    assert.equal(high.avgExtraDelta, 35); // 40-15=25, 60-15=45 -> 35
  });
});

// ── Output rates (damage/healing/elims/deaths per 10 min) ────────────────────
// These are raw match totals divided by time on hero. Three things have to be
// right or the numbers are quietly meaningless: the denominator is time on THIS
// hero (not match length), only the primary hero claims a match-level total,
// and a row with no usable duration contributes nothing rather than dividing
// by zero.
describe('computeAnalysis — output rates', () => {
  function insertRatePoint(opts: {
    date: string; hero: string; sens: number; win: 0 | 1; overallAcc: number;
    damage?: number; healing?: number; elims?: number; deaths?: number;
    matchMin?: number | null; heroMin?: number | null; primaryHero?: string;
  }) {
    const primary = opts.primaryHero ?? opts.hero;
    const matchId = insertMatch(db, {
      date: opts.date, hero: primary, role: 'Support', win: opts.win,
      sens: opts.sens, dpi: 1600, blind_trial: 1,
    });
    insertHeroSlot(db, { match_id: matchId, slot: 1, hero: primary, role: 'Support', sens: opts.sens });
    if (primary !== opts.hero) {
      insertHeroSlot(db, { match_id: matchId, slot: 2, hero: opts.hero, role: 'Support', sens: opts.sens });
    }
    insertAimStats(db, {
      match_id: matchId, overall_acc: opts.overallAcc,
      damage: opts.damage ?? null, healing: opts.healing ?? null,
      elims: opts.elims ?? null, deaths: opts.deaths ?? null,
      duration_min: opts.matchMin === undefined ? 10 : opts.matchMin,
    });
    insertAimStatsHero(db, {
      match_id: matchId, hero: opts.hero, overall_acc: opts.overallAcc,
      duration_min: opts.heroMin === undefined ? 10 : opts.heroMin,
    });
    return matchId;
  }

  test('rates are per 10 minutes of time on hero, not per match', () => {
    // 6000 damage in 20 minutes is 3000 per 10 — half what the raw total
    // suggests next to a 10-minute match.
    insertRatePoint({ date: '2026-01-01', hero: 'Ana', sens: 2.0, win: 1, overallAcc: 50, damage: 6000, elims: 20, deaths: 4, heroMin: 20 });
    const ana = computeAnalysis(db).heroes.find(h => h.hero === 'Ana')!;
    const sc = ana.scales[0];
    assert.equal(sc.avgDmg10, 3000);
    assert.equal(sc.avgElims10, 10);
    assert.equal(sc.avgDeaths10, 2);
    assert.equal(sc.nRate, 1);
  });

  test('time on hero beats match length when the two differ (mid-match switch)', () => {
    // The match ran 20 minutes; this hero was on screen for 5. Using the
    // match length would understate the rate fourfold.
    insertRatePoint({ date: '2026-01-01', hero: 'Ana', sens: 2.0, win: 1, overallAcc: 50, damage: 5000, matchMin: 20, heroMin: 5 });
    const ana = computeAnalysis(db).heroes.find(h => h.hero === 'Ana')!;
    assert.equal(ana.scales[0].avgDmg10, 10000);
  });

  test('a switched-to hero claims no share of the match-level totals', () => {
    insertRatePoint({ date: '2026-01-01', hero: 'Kiriko', sens: 2.0, win: 1, overallAcc: 50, damage: 8000, primaryHero: 'Ana' });
    const kiriko = computeAnalysis(db).heroes.find(h => h.hero === 'Kiriko')!;
    assert.equal(kiriko.scales[0].nRate, 0);
    assert.equal(kiriko.scales[0].avgDmg10, null);
  });

  test('healing carries its own n, separate from damage/elims', () => {
    // Two games; only one logged healing. Damage n = 2, healing n = 1.
    insertRatePoint({ date: '2026-01-01', hero: 'Ana', sens: 2.0, win: 1, overallAcc: 50, damage: 1000, healing: 9000 });
    insertRatePoint({ date: '2026-01-02', hero: 'Ana', sens: 2.0, win: 0, overallAcc: 50, damage: 3000 });
    const sc = computeAnalysis(db).heroes.find(h => h.hero === 'Ana')!.scales[0];
    assert.equal(sc.nRate, 2);
    assert.equal(sc.avgDmg10, 2000);
    assert.equal(sc.nHeal, 1);
    assert.equal(sc.avgHeal10, 9000);
  });

  test('a row with no usable duration contributes no rate rather than dividing by zero', () => {
    insertRatePoint({ date: '2026-01-01', hero: 'Ana', sens: 2.0, win: 1, overallAcc: 50, damage: 5000, matchMin: null, heroMin: null });
    const sc = computeAnalysis(db).heroes.find(h => h.hero === 'Ana')!.scales[0];
    assert.equal(sc.nRate, 0);
    assert.equal(sc.avgDmg10, null);
  });

  test('metricTrends reports a direction and an R2 per metric', () => {
    // Damage rising cleanly with sens across three scales. 5 games per scale
    // (not 3) — below MIN_SCALE_N (5), the 2026-09-17 minimum-n guard now
    // excludes a bucket from metricTrends entirely, so this fixture needs to
    // clear that bar to keep testing the trend-fitting logic itself.
    for (const [i, sens] of [2.0, 2.5, 3.0].entries()) {
      for (let g = 0; g < 5; g++) {
        insertRatePoint({ date: `2026-01-${String(i * 5 + g + 1).padStart(2, '0')}`, hero: 'Ana', sens, win: 1, overallAcc: 50, damage: 1000 * (i + 1), elims: 10 });
      }
    }
    const ana = computeAnalysis(db).heroes.find(h => h.hero === 'Ana')!;
    const dmg = ana.metricTrends.find(t => t.key === 'dmg10')!;
    assert.ok(dmg.slope != null && dmg.slope > 0, 'damage should trend up with sens');
    assert.equal(dmg.r2, 1); // perfectly linear by construction
    assert.equal(dmg.basis, 'raw'); // per-hero trends use the raw metric
    const deaths = ana.metricTrends.find(t => t.key === 'deaths10')!;
    assert.equal(deaths.lowerIsBetter, true);
  });

  // 2026-09-17, Sean's call: win rate no longer factors into the curve or any
  // "does sens move anything" finding — a match outcome is decided by four
  // other people, a map, and a comp, not by sens. winRate must stay OFF the
  // metricTrends list (both roster-wide and per-hero) while remaining a
  // plain, readable field on byScale/heroes rows (checked separately above).
  test('winRate is excluded from metricTrends (roster-wide and per-hero) but still present as a plain field', () => {
    insertRatePoint({ date: '2026-01-01', hero: 'Ana', sens: 2.0, win: 1, overallAcc: 50, damage: 1000, elims: 10 });
    insertRatePoint({ date: '2026-01-02', hero: 'Ana', sens: 2.5, win: 0, overallAcc: 55, damage: 1200, elims: 12 });
    const r = computeAnalysis(db);
    const ana = r.heroes.find(h => h.hero === 'Ana')!;
    // Cast to string: the METRICS key union itself no longer contains
    // 'winRate' at the type level, which is the compiler independently
    // confirming the same fact this test checks at runtime.
    assert.equal(r.metricTrends.some(t => (t.key as string) === 'winRate'), false, 'winRate must not appear in roster-wide metricTrends');
    assert.equal(ana.metricTrends.some(t => (t.key as string) === 'winRate'), false, 'winRate must not appear in per-hero metricTrends');
    // Still present as a plain readout on both byScale and heroes rows.
    assert.equal(typeof r.byScale[0].winRate, 'number');
    assert.equal(typeof ana.winRate, 'number');
  });
});

// ── Minimum-n guard on curve fits / trends / co-primary picks (2026-09-17) ──
// bestScale eligibility was already guarded (see "bestScale n-guard" above).
// This block covers what wasn't: curveFit, heroStatCurveFit and metricTrends
// — both roster-wide and per-hero — used to pull in EVERY scale regardless
// of n, including a 1-game bucket. Sean's instruction: visible everywhere
// (byScale/scales[] stay unfiltered), but excluded from anything that picks,
// fits, or recommends.
describe('computeAnalysis: minimum-n guard on curve fits and trends', () => {
  function insertPoint(opts: { date: string; hero: string; sens: number; overallAcc: number; critAcc?: number }) {
    const matchId = insertMatch(db, {
      date: opts.date, hero: opts.hero, role: 'DPS', win: 1,
      sens: opts.sens, dpi: 1600, blind_trial: 1,
    });
    insertHeroSlot(db, { match_id: matchId, slot: 1, hero: opts.hero, role: 'DPS', sens: opts.sens });
    insertAimStats(db, { match_id: matchId, overall_acc: opts.overallAcc, duration_min: 10 });
    insertAimStatsHero(db, { match_id: matchId, hero: opts.hero, overall_acc: opts.overallAcc, crit_acc: opts.critAcc ?? null });
  }

  // Three reliable (5-game) scales with accuracy climbing linearly, so a
  // clean quadratic/linear fit exists to compare against.
  function threeReliableScales(hero: string) {
    for (const [i, sens] of [2.0, 2.5, 3.0].entries()) {
      for (let g = 0; g < MIN_SCALE_N; g++) {
        insertPoint({ date: `2026-02-${String(i * MIN_SCALE_N + g + 1).padStart(2, '0')}`, hero, sens, overallAcc: 40 + i * 5, critAcc: 30 + i * 5 });
      }
    }
  }

  test('a below-threshold scale (n=4) does not feed the per-hero curve fit or metricTrends', () => {
    threeReliableScales('Ashe');
    for (let g = 0; g < MIN_SCALE_N - 1; g++) {
      // Sens 3.5 scores wildly higher — if this thin bucket fed the fit it
      // would visibly bend the curve/trend toward it.
      insertPoint({ date: `2026-03-${String(g + 1).padStart(2, '0')}`, hero: 'Ashe', sens: 3.5, overallAcc: 99, critAcc: 99 });
    }
    const h = computeAnalysis(db).heroes.find(x => x.hero === 'Ashe')!;
    assert.equal(h.scales.length, 4, 'the thin scale is still visible in scales[]');
    assert.equal(h.scales.find(s => s.n === 4)!.reliable, false);
    assert.equal(h.curveFit!.points, 3, 'only the 3 reliable scales fed the accuracy curve fit');
    assert.equal(h.heroStatCurveFit!.points, 3, 'only the 3 reliable scales fed the hero-stat curve fit');
    const overallTrend = h.metricTrends.find(t => t.key === 'overall')!;
    assert.equal(overallTrend.scales, 3, 'only the 3 reliable scales fed metricTrends');
  });

  test('boundary: raising that same scale to n=5 includes it in the fit', () => {
    threeReliableScales('Ashe');
    for (let g = 0; g < MIN_SCALE_N; g++) {
      insertPoint({ date: `2026-03-${String(g + 1).padStart(2, '0')}`, hero: 'Ashe', sens: 3.5, overallAcc: 99, critAcc: 99 });
    }
    const h = computeAnalysis(db).heroes.find(x => x.hero === 'Ashe')!;
    assert.equal(h.scales.length, 4);
    assert.equal(h.scales.filter(s => s.reliable).length, 4, 'all 4 scales are now at/above MIN_SCALE_N');
    assert.equal(h.curveFit!.points, 4, 'the now-reliable 4th scale joins the fit');
    assert.equal(h.heroStatCurveFit!.points, 4);
    const overallTrend = h.metricTrends.find(t => t.key === 'overall')!;
    assert.equal(overallTrend.scales, 4);
  });

  test('same guard applies roster-wide: a thin scale does not feed overallCurveFit, heroStatCurveFit, or roster metricTrends', () => {
    // Three reliable scales across two heroes (5 games each scale-hero pair
    // is overkill; 5 total per scale is what matters at roster grain).
    for (const [i, sens] of [2.0, 2.5, 3.0].entries()) {
      for (let g = 0; g < MIN_SCALE_N; g++) {
        insertPoint({ date: `2026-04-${String(i * MIN_SCALE_N + g + 1).padStart(2, '0')}`, hero: 'Ashe', sens, overallAcc: 40 + i * 5, critAcc: 30 + i * 5 });
      }
    }
    // One thin roster-level scale (3 games) at a distinct sens.
    for (let g = 0; g < 3; g++) {
      insertPoint({ date: `2026-05-0${g + 1}`, hero: 'Ashe', sens: 3.5, overallAcc: 99, critAcc: 99 });
    }
    const r = computeAnalysis(db);
    assert.equal(r.byScale.length, 4, 'the thin scale is still visible in byScale');
    assert.equal(r.byScale.find(s => s.n === 3)!.reliable, false);
    assert.equal(r.overallCurveFit!.points, 3);
    assert.equal(r.heroStatCurveFit!.points, 3);
    const overallTrend = r.metricTrends.find(t => t.key === 'overall')!;
    assert.equal(overallTrend.scales, 3);
  });
});

// ── Co-primary "best scale" selection (2026-09-17, Sean's call) ─────────────
// "hero stats should be co-primary, weight them equally" — a scale that is
// SECOND on accuracy but FIRST on the hero's own crit stat must be able to
// win the pick, not just place a footnote next to the accuracy leader.
describe('computeAnalysis: co-primary best-scale selection weighs hero stats equally', () => {
  function insertPoint(opts: { date: string; hero: string; sens: number; overallAcc: number; critAcc: number }) {
    const matchId = insertMatch(db, {
      date: opts.date, hero: opts.hero, role: 'DPS', win: 1,
      sens: opts.sens, dpi: 1600, blind_trial: 1,
    });
    insertHeroSlot(db, { match_id: matchId, slot: 1, hero: opts.hero, role: 'DPS', sens: opts.sens });
    insertAimStats(db, { match_id: matchId, overall_acc: opts.overallAcc, duration_min: 10 });
    insertAimStatsHero(db, { match_id: matchId, hero: opts.hero, overall_acc: opts.overallAcc, crit_acc: opts.critAcc });
  }

  test("a scale that's #1 on accuracy but worst on crit loses to a scale that's #2/#1", () => {
    // Scale A (sens 2.0): best accuracy (60), worst crit (30) -> ranks (1,3) -> avg 2.0
    // Scale B (sens 2.5): 2nd accuracy (55), best crit (50)    -> ranks (2,1) -> avg 1.5  <- wins
    // Scale C (sens 3.0): worst accuracy (50), 2nd crit (40)   -> ranks (3,2) -> avg 2.5
    const scales: [number, number, number][] = [[2.0, 60, 30], [2.5, 55, 50], [3.0, 50, 40]];
    for (const [i, [sens, overallAcc, critAcc]] of scales.entries()) {
      for (let g = 0; g < MIN_SCALE_N; g++) {
        insertPoint({ date: `2026-06-${String(i * MIN_SCALE_N + g + 1).padStart(2, '0')}`, hero: 'Widowmaker', sens, overallAcc, critAcc });
      }
    }
    const h = computeAnalysis(db).heroes.find(x => x.hero === 'Widowmaker')!;
    assert.equal(h.bestScaleReliable, true);
    // Pure accuracy-only ranking (the old behavior) would have picked sens
    // 2.0 (60% accuracy, the highest). Co-primary ranking picks 2.5 instead,
    // because it's #1 on crit and only narrowly #2 on accuracy.
    assert.equal(h.bestScaleEDPI, Math.round(2.5 * 1600), 'hero stats must be able to outweigh a pure-accuracy leader');
  });

  test('with no crit/extra/signature stat logged at all, the pick falls back to accuracy alone', () => {
    for (const [i, [sens, overallAcc]] of ([[2.0, 60], [2.5, 55], [3.0, 50]] as [number, number][]).entries()) {
      for (let g = 0; g < MIN_SCALE_N; g++) {
        insertPoint({ date: `2026-07-${String(i * MIN_SCALE_N + g + 1).padStart(2, '0')}`, hero: 'Reinhardt', sens, overallAcc, critAcc: 0 });
      }
    }
    // Overwrite crit_acc to null directly — insertPoint always writes a
    // number, and this test needs a hero with NO hero-stat channel at all
    // (extra_acc/hero_stat_value are null by construction, never set here).
    db.prepare("UPDATE aim_stats_heroes SET crit_acc = NULL WHERE hero = 'Reinhardt'").run();
    const h = computeAnalysis(db).heroes.find(x => x.hero === 'Reinhardt')!;
    assert.equal(h.bestScaleReliable, true);
    assert.equal(h.bestScaleEDPI, Math.round(2.0 * 1600), 'no hero-stat signal at all -> falls back to the accuracy leader');
  });
});

// 2026-09-17: Sean queried `matches` directly and found curve_enabled=1 pools
// three different curve settings, not one treatment. This section covers the
// breakdown that surfaces that on the analysis page — a presentation-layer
// addition, no existing metric's computation changed.
describe('computeAnalysis: curve breakdown (2026-09-17 confound)', () => {
  function insertPoint(opts: {
    date: string; hero: string; sens: number; overallAcc: number;
    curveEnabled?: 0 | 1; smooth?: number | null; input?: number | null; output?: number | null;
  }) {
    const matchId = insertMatch(db, {
      date: opts.date, hero: opts.hero, role: 'DPS', win: 1,
      sens: opts.sens, dpi: 1600, blind_trial: 1,
      curve_enabled: opts.curveEnabled ?? 0,
      curve_growth_rate: opts.smooth ?? null,
      curve_midpoint: opts.input ?? null,
      curve_motivity: opts.output ?? null,
    });
    insertHeroSlot(db, { match_id: matchId, slot: 1, hero: opts.hero, role: 'DPS', sens: opts.sens });
    insertAimStats(db, { match_id: matchId, overall_acc: opts.overallAcc, duration_min: 10 });
    insertAimStatsHero(db, { match_id: matchId, hero: opts.hero, overall_acc: opts.overallAcc });
  }

  test('curve-off and two distinct curve-on settings surface as three separate variants, not one pooled "curve on"', () => {
    for (let g = 0; g < 3; g++) insertPoint({ date: `2026-08-0${g + 1}`, hero: 'Ashe', sens: 2.0, overallAcc: 50 });
    for (let g = 0; g < 3; g++) insertPoint({ date: `2026-08-1${g + 1}`, hero: 'Ashe', sens: 2.0, overallAcc: 55, curveEnabled: 1, smooth: 0.25, input: 14, output: 1.15 });
    for (let g = 0; g < 2; g++) insertPoint({ date: `2026-08-2${g + 1}`, hero: 'Ashe', sens: 2.0, overallAcc: 60, curveEnabled: 1, smooth: 1.0, input: 12, output: null });

    const r = computeAnalysis(db);
    assert.equal(r.curveBreakdown.length, 3, 'curve-off + two distinct curve-on settings must not collapse into one bucket');
    const off = r.curveBreakdown.find(v => !v.curveEnabled)!;
    const onA = r.curveBreakdown.find(v => v.curveEnabled && v.smooth === 0.25)!;
    const onB = r.curveBreakdown.find(v => v.curveEnabled && v.smooth === 1.0)!;
    assert.equal(off.n, 3);
    assert.equal(onA.n, 3);
    assert.equal(onA.input, 14);
    assert.equal(onA.output, 1.15);
    assert.equal(onB.n, 2);
    assert.equal(onB.output, null, 'a variant with no recorded output must not be coerced to 0 or dropped');

    // Same breakdown must also be visible AT the scale bucket these points
    // share (2.0 sens / all one cm360 bucket at 1600 dpi) — a reader looking
    // at one row of the By Scale table needs to see the mix, not just a
    // roster-wide table elsewhere.
    const bucket = r.byScale.find(s => s.n === 8)!;
    assert.equal(bucket.curveVariants.length, 3);
  });

  test('two different LUTs are two variants, not one pooled "curve on" bucket', () => {
    // The whole reason curve_lut joins curveVariantKey. Both groups have all
    // three Jump columns null and curve_enabled = 1, so before the LUT was
    // part of the key these five matches were one indistinguishable bucket —
    // the exact confound the 2026-09-17 finding was about, re-created.
    const lutA = JSON.stringify([[1, 1], [16, 1], [32, 1.1]]);
    const lutB = JSON.stringify([[1, 1], [16, 1.05], [32, 1.2]]);
    for (const [i, lut] of [lutA, lutA, lutA, lutB, lutB].entries()) {
      const matchId = insertMatch(db, {
        date: `2026-07-0${i + 1}`, hero: 'Ashe', role: 'DPS', win: 1,
        sens: 2.5, dpi: 1600, blind_trial: 1, curve_enabled: 1, curve_lut: lut,
      });
      insertHeroSlot(db, { match_id: matchId, slot: 1, hero: 'Ashe', role: 'DPS', sens: 2.5 });
      insertAimStats(db, { match_id: matchId, overall_acc: 50, duration_min: 10 });
      insertAimStatsHero(db, { match_id: matchId, hero: 'Ashe', overall_acc: 50, crit_acc: null });
    }
    const r = computeAnalysis(db);
    assert.equal(r.curveBreakdown.length, 2, 'two distinct LUTs must not pool into one curve-on bucket');
    const a = r.curveBreakdown.find(v => v.n === 3)!;
    const b = r.curveBreakdown.find(v => v.n === 2)!;
    assert.deepEqual(a.lut, [[1, 1], [16, 1], [32, 1.1]]);
    assert.deepEqual(b.lut, [[1, 1], [16, 1.05], [32, 1.2]]);
    assert.equal(a.smooth, null, 'a LUT-era row carries no Jump params');
  });

  test('a match with no LUT on file reports lut null, not an empty table', () => {
    for (let g = 0; g < 5; g++) insertPoint({ date: `2026-06-0${g + 1}`, hero: 'Ashe', sens: 2.5, overallAcc: 50 });
    const r = computeAnalysis(db);
    assert.equal(r.curveBreakdown.length, 1);
    assert.equal(r.curveBreakdown[0].lut, null, 'absence of a table must read as null, never []');
  });

  test('a single-variant scale reports exactly one curve variant, not a false mix', () => {
    for (let g = 0; g < 5; g++) insertPoint({ date: `2026-08-0${g + 1}`, hero: 'Ashe', sens: 2.5, overallAcc: 50 });
    const r = computeAnalysis(db);
    const bucket = r.byScale.find(s => s.n === 5)!;
    assert.equal(bucket.curveVariants.length, 1);
    assert.equal(bucket.curveVariants[0].curveEnabled, false);
    assert.equal(bucket.curveVariants[0].n, 5);
  });

  test('liveCurve mirrors GET /api/aim/curve\'s own getCurveParams read', () => {
    setCurveParams(db, { smooth: 0.25, input: 14, output: 1.15, lutSteps: 8, lutMaxSpeed: 40, lutPoints: null });
    const r = computeAnalysis(db);
    assert.deepEqual({ ...r.liveCurve }, { smooth: 0.25, input: 14, output: 1.15, lutSteps: 8, lutMaxSpeed: 40, lutPoints: null });
  });
});
