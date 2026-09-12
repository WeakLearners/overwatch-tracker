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
import { computeAnalysis } from './aim';

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

  test('two blind-trial scales for one hero: hand-computed leave-one-scale-out deltas, win rates, and no minimum-n guard', () => {
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

    // No minimum-n guard on byScale (unlike every function in stats.test.ts)
    // — a 3-game bucket is reported the same as a 300-game one. Flagged in
    // the report rather than added here per the task's own instruction.
    assert.equal(bucketA.n, 3);
    assert.equal(bucketB.n, 3);
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
