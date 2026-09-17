// curveFitReliability decides whether a curve fit's R² is even meaningful
// enough to show an estimated sens/result at all. Found live 2026-09-17: a
// 3-point quadratic fit (Reaper, Cassidy) reports R²=1.000 by construction —
// 3 tested scales, 3 coefficients (a, b, c), zero degrees of freedom, so the
// parabola is forced through every point exactly regardless of whether they
// reflect anything real. The old gate (R² alone) let those two through while
// correctly suppressing Sojourn's real 171-match, 11-scale fit at R²=0.173 —
// the opposite of its job. These tests lock the boundary that fixed it: a
// fit must be suppressed once points < MIN_FIT_POINTS, even at a perfect R².
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { curveFitReliability, MIN_FIT_POINTS, R2_TRUST_BAR, CurveFit } from './SensAnalysis';

// Fills in the CurveFit fields curveFitReliability doesn't inspect, so each
// test only has to state points/r2 — the two inputs the gate actually cares
// about.
function fit(overrides: Partial<CurveFit>): CurveFit {
  return {
    points: 5, totalN: 25, r2: 0.6,
    optimalSens: 2.5, predictedDelta: 3, hasInteriorPeak: true, inRange: true,
    testedSensMin: 2.0, testedSensMax: 3.0, a: -1, b: 4, c: 1,
    ...overrides,
  };
}

test('a 3-point fit is suppressed even at a perfect R²=1.0 — the exact-fit-by-construction case', () => {
  const r = curveFitReliability(fit({ points: 3, r2: 1.0 }));
  assert.equal(r.trustworthy, false, 'a quadratic through exactly 3 points is an exact fit, not evidence');
  assert.match(r.reason ?? '', /exact by construction/, 'the page must state the real reason, not a generic "not enough data"');
});

test('a 4-point fit is still suppressed — 1 degree of freedom is too little headroom', () => {
  const r = curveFitReliability(fit({ points: 4, r2: 0.9 }));
  assert.equal(r.trustworthy, false);
  assert.match(r.reason ?? '', /degree.*freedom/i);
});

test(`a fit with exactly MIN_FIT_POINTS (${MIN_FIT_POINTS}) points and a strong R² is trustworthy`, () => {
  const r = curveFitReliability(fit({ points: MIN_FIT_POINTS, r2: 0.6 }));
  assert.equal(r.trustworthy, true);
  assert.equal(r.reason, null);
});

test(`enough points but R² below ${R2_TRUST_BAR} is still suppressed — scattered points, not a thin sample`, () => {
  const r = curveFitReliability(fit({ points: 11, r2: 0.173 }));
  assert.equal(r.trustworthy, false, "Sojourn's real case: 171 matches, 11 scales, R²=0.173 — thin evidence isn't the problem, the fit just doesn't hold");
  assert.match(r.reason ?? '', /R²=0\.17/);
});

test('enough points and R² above the bar is trustworthy regardless of a high point count', () => {
  const r = curveFitReliability(fit({ points: 13, r2: 0.437 }));
  assert.equal(r.trustworthy, true);
});
