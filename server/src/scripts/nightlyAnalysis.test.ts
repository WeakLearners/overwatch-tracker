// Tests for the nightly report's analysis layer. These matter more than most:
// this module decides when the study is allowed to claim a finding, and a bug
// here doesn't crash anything — it quietly reports noise as signal, which is
// the exact failure mode that got the old map/hour "key patterns" retired.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  welchT, readBracket, describeBracket, StagePoint,
  MIN_GAMES_PER_STAGE, MIN_TOTAL_FOR_READ,
} from './nightlyAnalysis';

const pt = (stage_index: number, sens: number, n: number, meanAcc: number): StagePoint =>
  ({ stage_index, sens, dpi: 1600, n, meanAcc, winRate: 0.5 });

describe('welchT', () => {
  test('returns null when either side has fewer than 3 samples', () => {
    assert.equal(welchT([1, 2], [3, 4, 5]), null);
    assert.equal(welchT([1, 2, 3], [4, 5]), null);
  });

  test('returns null on zero variance in both groups (se === 0)', () => {
    // Identical constants either side: no spread to test against, so the
    // t-statistic is undefined rather than infinite.
    assert.equal(welchT([40, 40, 40], [40, 40, 40]), null);
  });

  test('is ~0 for two samples drawn around the same mean', () => {
    const t = welchT([38, 40, 42, 39, 41], [41, 39, 40, 42, 38]);
    assert.ok(t !== null && Math.abs(t) < 0.5, `expected near-zero t, got ${t}`);
  });

  test('clears the |t| >= 2 reporting bar for a large, tight separation', () => {
    // ~10pt apart with ~1pt spread — unambiguous by construction.
    const t = welchT([50, 51, 49, 50, 51], [40, 41, 39, 40, 41]);
    assert.ok(t !== null && Math.abs(t) >= 2, `expected |t| >= 2, got ${t}`);
  });

  test('does NOT clear the bar for the same gap buried in wide spread', () => {
    // Same ~10pt difference in means as above, but the spread swamps it. This
    // is the case the study keeps getting burned by: a big-looking gap that
    // a wide distribution cannot support.
    const t = welchT([70, 30, 65, 35, 50], [60, 20, 55, 25, 40]);
    assert.ok(t !== null && Math.abs(t) < 2, `expected |t| < 2, got ${t}`);
  });

  test('sign follows argument order', () => {
    const hi = [50, 51, 49, 50, 51], lo = [40, 41, 39, 40, 41];
    const a = welchT(hi, lo)!, b = welchT(lo, hi)!;
    assert.ok(a > 0 && b < 0);
    assert.ok(Math.abs(a + b) < 1e-9);
  });
});

describe('readBracket', () => {
  test('a stage below MIN_GAMES_PER_STAGE is dropped, not zero-filled', () => {
    // Absent data must not be read as a low score. Two real stages plus one
    // starved stage should be treated as a 2-stage A/B, not a 3-point curve.
    const v = readBracket([
      pt(1, 2.5, 5, 40), pt(2, 2.6, 5, 42), pt(3, 2.7, MIN_GAMES_PER_STAGE - 1, 10),
    ]);
    assert.equal(v.kind, 'head2head');
  });

  test('two usable stages read as an A/B, never as a curve', () => {
    const v = readBracket([pt(1, 2.5, 6, 40), pt(2, 2.6, 6, 44)]);
    assert.equal(v.kind, 'head2head');
    if (v.kind !== 'head2head') return;
    assert.equal(v.hi.meanAcc, 44); // higher mean is 'hi' regardless of order
    assert.equal(v.lo.meanAcc, 40);
    assert.equal(v.t, null);        // no raw samples supplied -> untestable
  });

  test('A/B orders hi/lo by accuracy, not by stage index', () => {
    const v = readBracket([pt(1, 2.5, 6, 48), pt(2, 2.6, 6, 41)]);
    assert.equal(v.kind, 'head2head');
    if (v.kind !== 'head2head') return;
    assert.equal(v.hi.stage_index, 1);
  });

  test('A/B runs a real test when raw samples are supplied', () => {
    const v = readBracket(
      [pt(1, 2.5, 5, 50), pt(2, 2.6, 5, 40)],
      { 1: [50, 51, 49, 50, 51], 2: [40, 41, 39, 40, 41] },
    );
    assert.equal(v.kind, 'head2head');
    if (v.kind !== 'head2head') return;
    assert.ok(v.t !== null && Math.abs(v.t) >= 2);
  });

  test('fewer than 2 usable stages is thin, not a verdict', () => {
    const v = readBracket([pt(1, 2.5, 9, 40)]);
    assert.equal(v.kind, 'thin');
  });

  test('empty input is thin and does not throw or produce NaN', () => {
    const v = readBracket([]);
    assert.equal(v.kind, 'thin');
    assert.equal(v.totalN, 0);
  });

  test('three thin stages stay thin below MIN_TOTAL_FOR_READ', () => {
    // 3 distinct x values, but barely any games behind them: a quadratic would
    // fit near-perfectly and mean nothing.
    const v = readBracket([pt(1, 2.5, 3, 40), pt(2, 2.6, 3, 44), pt(3, 2.7, 3, 41)]);
    assert.ok(v.totalN < MIN_TOTAL_FOR_READ);
    assert.equal(v.kind, 'thin');
  });

  test('an upward-opening curve is unresolved, never a direction', () => {
    // U-shaped: the vertex is the WORST value, not the best. Reporting a
    // "best" here — or a "leans fast/slow" — would invent a finding.
    const v = readBracket([
      pt(1, 2.4, 6, 45), pt(2, 2.5, 6, 38), pt(3, 2.6, 6, 46),
    ]);
    assert.equal(v.kind, 'unresolved');
    if (v.kind !== 'unresolved') return;
    assert.match(v.reason, /no interior peak/);
  });

  test('a clean inverted-U recovers a peak inside the tested range', () => {
    const v = readBracket([
      pt(1, 2.4, 6, 38), pt(2, 2.5, 6, 46), pt(3, 2.6, 6, 39),
    ]);
    assert.equal(v.kind, 'peak');
    if (v.kind !== 'peak') return;
    assert.ok(v.inRange);
    assert.ok(v.optimalX > 2.4 && v.optimalX < 2.6, `peak at ${v.optimalX}`);
  });

  test('stages with null sens cannot be placed on an axis and are excluded', () => {
    const nulled: StagePoint[] = [
      { stage_index: 1, sens: null, dpi: 1500, n: 6, meanAcc: 40, winRate: 0.5 },
      { stage_index: 2, sens: null, dpi: 1600, n: 6, meanAcc: 44, winRate: 0.5 },
    ];
    assert.equal(readBracket(nulled).kind, 'thin');
  });
});

describe('describeBracket wording', () => {
  test('never claims a direction when there is no interior peak', () => {
    const line = describeBracket('Tracer', readBracket([
      pt(1, 2.4, 6, 45), pt(2, 2.5, 6, 38), pt(3, 2.6, 6, 46),
    ]));
    assert.match(line, /unresolved/);
    assert.doesNotMatch(line, /faster|slower|higher is|lower is/i);
  });

  test('an A/B line states it cannot locate a peak', () => {
    const line = describeBracket('Ana', readBracket(
      [pt(1, 2.5, 5, 50), pt(2, 2.6, 5, 40)],
      { 1: [50, 51, 49, 50, 51], 2: [40, 41, 39, 40, 41] },
    ));
    assert.match(line, /cannot locate a peak/);
  });

  test('a non-separating gap is labelled as such, not reported as a lead', () => {
    const line = describeBracket('Soldier: 76', readBracket(
      [pt(1, 2.61, 5, 44), pt(2, 2.67, 5, 40)],
      { 1: [70, 30, 65, 35, 20], 2: [60, 20, 55, 25, 40] },
    ));
    assert.match(line, /NOT separating|too thin to test/);
  });
});
