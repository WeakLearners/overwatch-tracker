// Pure-function tests for lib/blind.ts — the DPI/sens stage-bracket builders.
// No DB. stagesFromSens is the live path (current test-plan creation);
// generateStages/stagesFromDpis are legacy paths still read by old sets, so
// coverage here is about not silently breaking historical-data reads, not
// about active feature work.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { stagesFromSens, generateStages, stagesFromDpis, LOCKED_DPI } from './blind';

describe('stagesFromSens', () => {
  test('every stage carries dpi === LOCKED_DPI', () => {
    const stages = stagesFromSens([2.0, 2.5, 3.0]);
    for (const s of stages) assert.equal(s.dpi, LOCKED_DPI);
  });

  test('stage_index is 1-based and follows input order', () => {
    const stages = stagesFromSens([2.0, 2.5, 3.0]);
    assert.deepEqual(stages.map(s => s.stage_index), [1, 2, 3]);
    assert.deepEqual(stages.map(s => s.sens), [2.0, 2.5, 3.0]);
  });

  test('pct_delta is computed against the list\'s own mean, not a fixed baseline', () => {
    // mean of [2.0, 2.5, 3.0] = 2.5
    const stages = stagesFromSens([2.0, 2.5, 3.0]);
    assert.equal(stages[0].pct_delta, -20); // (2.0-2.5)/2.5 = -20%
    assert.equal(stages[1].pct_delta, 0);
    assert.equal(stages[2].pct_delta, 20);
  });

  test('pct_delta recenters correctly for an asymmetric bracket', () => {
    // mean of [2.0, 2.2, 3.2] = 2.4666...
    const stages = stagesFromSens([2.0, 2.2, 3.2]);
    const mean = (2.0 + 2.2 + 3.2) / 3;
    stages.forEach((s, i) => {
      const senses = [2.0, 2.2, 3.2];
      const expected = Math.round(((senses[i] - mean) / mean) * 1000) / 10;
      assert.equal(s.pct_delta, expected);
    });
  });

  test('a single-sens list has pct_delta 0 (equal to its own mean)', () => {
    const stages = stagesFromSens([2.5]);
    assert.equal(stages.length, 1);
    assert.equal(stages[0].pct_delta, 0);
    assert.equal(stages[0].dpi, LOCKED_DPI);
  });
});

describe('generateStages (legacy DPI-percent-range path)', () => {
  test('spreads n values evenly across +/-pctRange around baseDpi, rounded to nearest 50', () => {
    const stages = generateStages(800, 20, 5);
    assert.deepEqual(stages.map(s => s.dpi), [650, 700, 800, 900, 950]);
    assert.deepEqual(stages.map(s => s.sens), [null, null, null, null, null]);
    assert.deepEqual(stages.map(s => s.stage_index), [1, 2, 3, 4, 5]);
  });

  test('a single stage (n=1) sits exactly at baseDpi with pct_delta 0', () => {
    const stages = generateStages(800, 20, 1);
    assert.equal(stages.length, 1);
    assert.equal(stages[0].dpi, 800);
    assert.equal(stages[0].pct_delta, 0);
  });

  test('pct_delta values are evenly spaced across the requested range', () => {
    const stages = generateStages(800, 20, 5);
    assert.deepEqual(stages.map(s => s.pct_delta), [-20, -10, 0, 10, 20]);
  });
});

describe('stagesFromDpis (legacy explicit-DPI-list path)', () => {
  test('preserves input order and stamps sens null throughout', () => {
    const stages = stagesFromDpis([700, 800, 900]);
    assert.deepEqual(stages.map(s => s.dpi), [700, 800, 900]);
    assert.deepEqual(stages.map(s => s.sens), [null, null, null]);
    assert.deepEqual(stages.map(s => s.stage_index), [1, 2, 3]);
  });

  test('pct_delta is computed against the list\'s own mean', () => {
    const stages = stagesFromDpis([700, 800, 900]); // mean 800
    assert.equal(stages[0].pct_delta, -12.5);
    assert.equal(stages[1].pct_delta, 0);
    assert.equal(stages[2].pct_delta, 12.5);
  });
});
