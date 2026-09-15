// Pure-function tests for lib/aim.ts. No DB — everything here is math or
// array plumbing over plain objects. Real expected values throughout, not
// smoke tests: see the module comment for why fitQuadraticPeak in particular
// is worth pinning down (it locates the "best sens" peak every study
// conclusion downstream depends on).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  fitQuadraticPeak,
  deriveSessionPosition,
  deriveSensAdaptation,
  eDPI,
  cm360,
  archetypeOf,
  SESSION_GAP_MIN,
  TimelineMatch,
  fitLinearTrend,
} from './aim';

describe('fitQuadraticPeak', () => {
  test('recovers the known vertex of a clean synthetic parabola', () => {
    // y = -(x-3)^2 + 10 — vertex at (3, 10), opens downward (a < 0).
    const pts = [1, 2, 3, 4, 5].map(x => ({ x, y: -((x - 3) ** 2) + 10, w: 1 }));
    const fit = fitQuadraticPeak(pts);
    assert.ok(fit, 'expected a fit for a clean 5-point parabola');
    assert.ok(Math.abs(fit!.optimalX! - 3) < 1e-6, `optimalX ${fit!.optimalX} not within tolerance of 3`);
    assert.ok(Math.abs(fit!.predictedY! - 10) < 1e-6, `predictedY ${fit!.predictedY} not within tolerance of 10`);
    assert.equal(fit!.hasInteriorPeak, true);
    assert.equal(fit!.inRange, true);
    assert.ok(fit!.r2 > 0.999, `r2 ${fit!.r2} should be ~1 for an exact fit`);
    assert.equal(fit!.points, 5);
    assert.equal(fit!.totalN, 5);
  });

  test('returns null for fewer than 3 distinct x values', () => {
    assert.equal(fitQuadraticPeak([{ x: 1, y: 1, w: 1 }, { x: 2, y: 2, w: 1 }]), null);
    assert.equal(fitQuadraticPeak([{ x: 1, y: 1, w: 1 }]), null);
    assert.equal(fitQuadraticPeak([]), null);
  });

  test('returns null when every x value is identical (distinctX check catches it before the singular matrix)', () => {
    const pts = [{ x: 1, y: 1, w: 1 }, { x: 1, y: 2, w: 1 }, { x: 1, y: 3, w: 1 }];
    assert.equal(fitQuadraticPeak(pts), null);
  });

  test('returns null, not NaN, when all weights are zero (singular normal-equations matrix)', () => {
    const pts = [{ x: 1, y: 1, w: 0 }, { x: 2, y: 5, w: 0 }, { x: 3, y: 1, w: 0 }];
    assert.equal(fitQuadraticPeak(pts), null);
  });

  test('upward-opening parabola (a >= 0): hasInteriorPeak is false and optimalX/predictedY/inRange are null/false, even though the fit itself is exact', () => {
    // y = (x-3)^2 — a trough, not a peak. r2 is still ~1: the fit is real,
    // it's just not a "best sens" in the sense callers care about.
    const pts = [1, 2, 3, 4, 5].map(x => ({ x, y: (x - 3) ** 2, w: 1 }));
    const fit = fitQuadraticPeak(pts);
    assert.ok(fit);
    assert.equal(fit!.hasInteriorPeak, false);
    assert.equal(fit!.optimalX, null);
    assert.equal(fit!.predictedY, null);
    assert.equal(fit!.inRange, false);
    assert.ok(fit!.r2 > 0.999);
  });

  test('r2 is low for noisy, non-parabolic data', () => {
    const pts = [
      { x: 1, y: 5, w: 1 }, { x: 2, y: 1, w: 1 }, { x: 3, y: 8, w: 1 },
      { x: 4, y: 2, w: 1 }, { x: 5, y: 9, w: 1 },
    ];
    const fit = fitQuadraticPeak(pts);
    assert.ok(fit);
    assert.ok(fit!.r2 < 0.5, `expected a poor fit (r2 < 0.5) for sawtooth noise, got ${fit!.r2}`);
  });

  test('BUG (reported, not fixed): negative weights are not rejected — they silently produce a fit with a negative totalN instead of null', () => {
    // totalN is documented/used elsewhere as "games logged" (a count), and is
    // always w>=1 per real call site (weight = games at that sens point) — so
    // this path is believed unreachable in production. But the function
    // itself has no guard: solveWeightedQuadratic only returns null when the
    // 3x3 normal-equations determinant is ~0, which a uniform negative weight
    // does not trigger (it just flips every term's sign symmetrically). The
    // task spec called for "null rather than a garbage fit" here — this
    // pins down the ACTUAL current behavior (a fit object with totalN: -3,
    // which is nonsensical for a sample count) so a future change to this
    // function has to touch this test deliberately rather than silently
    // reintroducing/removing the gap.
    const pts = [{ x: 1, y: 1, w: -1 }, { x: 2, y: 5, w: -1 }, { x: 3, y: 1, w: -1 }];
    const fit = fitQuadraticPeak(pts);
    assert.ok(fit, 'current behavior: negative weights do NOT return null');
    assert.equal(fit!.totalN, -3, 'totalN is the raw (negative) weight sum — not a valid sample count');
  });
});

describe('deriveSessionPosition (SESSION_GAP_MIN boundary)', () => {
  const base = Date.parse('2026-01-01T10:00:00Z');
  const mk = (id: number, offsetMs: number): TimelineMatch => ({
    id, time: new Date(base + offsetMs).toISOString(), date: '2026-01-01', sens: 2.0,
  });

  test('SESSION_GAP_MIN constant is 35', () => {
    assert.equal(SESSION_GAP_MIN, 35);
  });

  test('34-minute gap: same session (position continues to 2)', () => {
    const pos = deriveSessionPosition([mk(1, 0), mk(2, 34 * 60_000)]);
    assert.deepEqual([...pos.entries()], [[1, 1], [2, 2]]);
  });

  test('exactly 35-minute gap: still counts as the same session (check is strictly ">")', () => {
    const pos = deriveSessionPosition([mk(1, 0), mk(2, 35 * 60_000)]);
    assert.deepEqual([...pos.entries()], [[1, 1], [2, 2]]);
  });

  test('36-minute gap: new session (position resets to 1)', () => {
    const pos = deriveSessionPosition([mk(1, 0), mk(2, 36 * 60_000)]);
    assert.deepEqual([...pos.entries()], [[1, 1], [2, 1]]);
  });

  test('sorts out-of-order input chronologically before bucketing', () => {
    const early = mk(1, 0);
    const late = mk(2, 10 * 60_000);
    const pos = deriveSessionPosition([late, early]); // passed in reverse order
    assert.deepEqual([...pos.entries()], [[1, 1], [2, 2]]);
  });

  test('ties on identical timestamps break by ascending id', () => {
    const a = mk(5, 0);
    const b = mk(2, 0);
    const pos = deriveSessionPosition([a, b]);
    // id 2 sorts before id 5 at the same timestamp, so it gets position 1.
    assert.deepEqual([...pos.entries()].sort((x, y) => x[0] - y[0]), [[2, 1], [5, 2]]);
  });
});

describe('deriveSensAdaptation', () => {
  const base = Date.parse('2026-01-01T10:00:00Z');
  const mk = (id: number, offsetMs: number, sens: number | null, dpi = 1600): TimelineMatch => ({
    id, time: new Date(base + offsetMs).toISOString(), date: '2026-01-01', sens, dpi,
  });

  test('counts matches since the last eDPI change, resetting to 0 on a change', () => {
    const matches = [
      mk(1, 0, 2.0), mk(2, 60_000, 2.0), // same eDPI as #1
      mk(3, 120_000, 2.5),               // changed -> resets
      mk(4, 180_000, 2.5),               // same as #3
    ];
    const out = deriveSensAdaptation(matches);
    assert.deepEqual([...out.entries()], [[1, 0], [2, 1], [3, 0], [4, 1]]);
  });

  test('sens-null matches are skipped entirely (not counted, not present in the map)', () => {
    const matches = [mk(1, 0, 2.0), mk(2, 60_000, null), mk(3, 120_000, 2.0)];
    const out = deriveSensAdaptation(matches);
    assert.equal(out.has(2), false);
    assert.deepEqual([...out.entries()], [[1, 0], [3, 1]]);
  });

  test('a DPI-only change (sens held constant) still counts as a change, since it is measured on eDPI', () => {
    const matches = [mk(1, 0, 2.0, 1600), mk(2, 60_000, 2.0, 800)]; // eDPI 3200 -> 1600
    const out = deriveSensAdaptation(matches);
    assert.deepEqual([...out.entries()], [[1, 0], [2, 0]]);
  });

  test('sorts out-of-order input chronologically before bucketing', () => {
    const m1 = mk(1, 0, 2.0);
    const m2 = mk(2, 60_000, 2.0);
    const m3 = mk(3, 120_000, 2.5);
    const out = deriveSensAdaptation([m3, m1, m2]); // reverse order
    assert.deepEqual([...out.entries()], [[1, 0], [2, 1], [3, 0]]);
  });
});

describe('eDPI / cm360 / archetypeOf', () => {
  test('eDPI defaults to MOUSE_DPI (1600) when dpi is omitted', () => {
    assert.equal(eDPI(2.0), 3200);
  });

  test('eDPI uses an explicit dpi when given', () => {
    assert.equal(eDPI(2.0, 800), 1600);
  });

  test('cm360 matches the documented reference value (sens 2.5 @ 1600 dpi -> ~34.6 cm)', () => {
    const result = cm360(2.5);
    assert.ok(Math.abs(result - 34.6) < 0.1, `cm360(2.5) = ${result}, expected ~34.6`);
  });

  test('cm360 with an explicit dpi', () => {
    // cm/360 = (360 * 2.54) / (0.0066 * sens * dpi)
    const expected = (360 * 2.54) / (0.0066 * 2.0 * 800);
    assert.ok(Math.abs(cm360(2.0, 800) - expected) < 1e-9);
  });

  test('archetypeOf returns the tagged archetype for known heroes', () => {
    assert.equal(archetypeOf('Ashe'), 'hitscan');
    assert.equal(archetypeOf('Widowmaker'), 'hitscan');
    assert.equal(archetypeOf('Pharah'), 'projectile');
    assert.equal(archetypeOf('Hanzo'), 'projectile');
  });

  test('archetypeOf falls back to "other" for untagged heroes (tanks, supports, etc.)', () => {
    assert.equal(archetypeOf('Reinhardt'), 'other');
    assert.equal(archetypeOf('Ana'), 'other');
    assert.equal(archetypeOf('Not A Real Hero'), 'other');
  });
});

// ── fitLinearTrend ──────────────────────────────────────────────────────────
// Hand-verified against lines whose slope and R² are known by construction, so
// a regression shows up as a wrong number rather than a plausible-looking one.
describe('fitLinearTrend', () => {
  test('a perfect line returns its exact slope and R2 = 1', () => {
    const fit = fitLinearTrend([
      { x: 1, y: 10, w: 1 }, { x: 2, y: 20, w: 1 }, { x: 3, y: 30, w: 1 },
    ]);
    assert.ok(fit);
    assert.equal(Math.round(fit.slope * 1e9) / 1e9, 10);
    assert.equal(Math.round(fit.r2 * 1e9) / 1e9, 1);
    assert.equal(fit.points, 3);
    assert.equal(fit.totalN, 3);
    // spanDelta: slope * (xMax - xMin) = 10 * 2
    assert.equal(Math.round(fit.spanDelta * 1e9) / 1e9, 20);
  });

  test('a descending line reports a negative slope', () => {
    const fit = fitLinearTrend([
      { x: 2.0, y: 50, w: 1 }, { x: 2.5, y: 40, w: 1 }, { x: 3.0, y: 30, w: 1 },
    ]);
    assert.ok(fit);
    assert.equal(Math.round(fit.slope * 1e6) / 1e6, -20);
    assert.equal(Math.round(fit.spanDelta * 1e6) / 1e6, -20);
  });

  test('scatter with no correlation to x gives slope 0 and R2 0', () => {
    // Symmetric about the mean x, so the x-y covariance is exactly zero: the
    // points vary a lot, but none of that variation is explained by x.
    // (A 10,0,10,0 zigzag would NOT do — over ascending x that has a real
    // slope of -2 and R2 of 0.2, which is the kind of accident this fit needs
    // to keep reporting honestly rather than rounding away.)
    const fit = fitLinearTrend([
      { x: 1, y: 0, w: 1 }, { x: 2, y: 10, w: 1 }, { x: 3, y: 10, w: 1 }, { x: 4, y: 0, w: 1 },
    ]);
    assert.ok(fit);
    assert.equal(Math.round(fit.slope * 1e9) / 1e9, 0);
    assert.equal(Math.round(fit.r2 * 1e9) / 1e9, 0);
  });

  test('weights pull the line toward the better-sampled points', () => {
    // Three points; the outlier at x=3 carries 1 game, the others 50 each.
    const light = fitLinearTrend([
      { x: 1, y: 10, w: 1 }, { x: 2, y: 20, w: 1 }, { x: 3, y: 100, w: 1 },
    ])!;
    const heavy = fitLinearTrend([
      { x: 1, y: 10, w: 50 }, { x: 2, y: 20, w: 50 }, { x: 3, y: 100, w: 1 },
    ])!;
    assert.ok(heavy.slope < light.slope,
      `down-weighting the outlier must flatten the slope (light ${light.slope}, heavy ${heavy.slope})`);
  });

  test('fewer than 3 points returns null (2 points fit any line exactly)', () => {
    assert.equal(fitLinearTrend([{ x: 1, y: 1, w: 1 }, { x: 2, y: 2, w: 1 }]), null);
    assert.equal(fitLinearTrend([]), null);
  });

  test('all points at one x returns null rather than an infinite slope', () => {
    assert.equal(fitLinearTrend([
      { x: 2.5, y: 10, w: 1 }, { x: 2.5, y: 20, w: 1 }, { x: 2.5, y: 30, w: 1 },
    ]), null);
  });
});
