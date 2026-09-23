// Pure-function tests for lib/blind.ts — the DPI/sens stage-bracket builders.
// No DB. stagesFromSens is the live path (current test-plan creation);
// generateStages/stagesFromDpis are legacy paths still read by old sets, so
// coverage here is about not silently breaking historical-data reads, not
// about active feature work.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  stagesFromSens, generateStages, stagesFromDpis, LOCKED_DPI, abbaStageFor,
  chunkLabelFor, leftInCurrentChunk, chunkGaugeSegments,
} from './blind';

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

describe('abbaStageFor (2026-09-23 alternation)', () => {
  test('the first chunk_size games (before any are credited) land on A', () => {
    for (let n = 0; n < 10; n++) assert.equal(abbaStageFor(n, 10), 1);
  });

  test('the second chunk lands on B', () => {
    for (let n = 10; n < 20; n++) assert.equal(abbaStageFor(n, 10), 2);
  });

  test('the third chunk stays on B — ABBA, not ABAB', () => {
    for (let n = 20; n < 30; n++) assert.equal(abbaStageFor(n, 10), 2);
  });

  test('the fourth chunk returns to A', () => {
    for (let n = 30; n < 40; n++) assert.equal(abbaStageFor(n, 10), 1);
  });

  test('the pattern repeats for a second ABBA cycle (chunks 5-8)', () => {
    assert.equal(abbaStageFor(40, 10), 1); // chunk 5 (index 4) -> A again
    assert.equal(abbaStageFor(50, 10), 2); // chunk 6
    assert.equal(abbaStageFor(60, 10), 2); // chunk 7
    assert.equal(abbaStageFor(70, 10), 1); // chunk 8 -> A, completing 40/40 on each side
  });

  test('over one full 80-game set, each stage gets exactly 40', () => {
    let aCount = 0, bCount = 0;
    for (let n = 0; n < 80; n++) {
      if (abbaStageFor(n, 10) === 1) aCount++; else bCount++;
    }
    assert.equal(aCount, 40);
    assert.equal(bCount, 40);
  });

  test('a smaller chunk size (5) still alternates ABBA at its own boundaries', () => {
    assert.equal(abbaStageFor(0, 5), 1);
    assert.equal(abbaStageFor(5, 5), 2);
    assert.equal(abbaStageFor(10, 5), 2);
    assert.equal(abbaStageFor(15, 5), 1);
    assert.equal(abbaStageFor(20, 5), 1); // next cycle
  });
});

describe('chunkLabelFor (2026-09-23 stage badge)', () => {
  test('matches the exact sequence given in the brief for a 40/10 set', () => {
    // A1, B1, B2, A2, A3, B3, B4, A4 — one label per 10-game chunk (0-9,
    // 10-19, ..., 70-79), sampled at each chunk's own start.
    const expected = ['A1', 'B1', 'B2', 'A2', 'A3', 'B3', 'B4', 'A4'];
    const actual = expected.map((_, i) => chunkLabelFor(i * 10, 10));
    assert.deepEqual(actual, expected);
  });

  test('the label is stable across every game within one chunk', () => {
    for (let n = 20; n < 30; n++) assert.equal(chunkLabelFor(n, 10), 'B2');
  });

  test('a smaller chunk size (5) produces the same letter/ordinal pattern at its own scale', () => {
    assert.equal(chunkLabelFor(0, 5), 'A1');
    assert.equal(chunkLabelFor(5, 5), 'B1');
    assert.equal(chunkLabelFor(10, 5), 'B2');
    assert.equal(chunkLabelFor(15, 5), 'A2');
  });
});

describe('leftInCurrentChunk', () => {
  test('counts down within a chunk and resets at the boundary', () => {
    assert.equal(leftInCurrentChunk(0, 10), 10);
    assert.equal(leftInCurrentChunk(3, 10), 7);
    assert.equal(leftInCurrentChunk(9, 10), 1);
    assert.equal(leftInCurrentChunk(10, 10), 10); // fresh chunk, full again
  });
});

describe('chunkGaugeSegments', () => {
  test('a full chunk (10 left) is 5 full segments, no half', () => {
    assert.deepEqual(chunkGaugeSegments(10), { full: 5, half: false });
  });

  test('7 left is 3 full segments plus a half (matches the brief\'s "B3 · 7 left" example)', () => {
    assert.deepEqual(chunkGaugeSegments(7), { full: 3, half: true });
  });

  test('an even count has no half segment', () => {
    assert.deepEqual(chunkGaugeSegments(4), { full: 2, half: false });
  });

  test('1 left is 0 full segments plus a half — never fully empty while a game remains', () => {
    assert.deepEqual(chunkGaugeSegments(1), { full: 0, half: true });
  });

  test('0 left is fully empty', () => {
    assert.deepEqual(chunkGaugeSegments(0), { full: 0, half: false });
  });
});
