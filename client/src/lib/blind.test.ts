// Client mirror of server/src/lib/blind.test.ts's coverage for the same
// condition — see lib/blind.ts's isStudyQueueMode for why this exists (Sean's
// 2026-09-23 decision to drop Support's QP exception for good).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isStudyQueueMode } from './blind';

describe('isStudyQueueMode', () => {
  test('Competitive Role Queue counts', () => {
    assert.equal(isStudyQueueMode('comp_role'), true);
  });
  test('Competitive Open Queue counts', () => {
    assert.equal(isStudyQueueMode('comp_open'), true);
  });
  test('Quick Play never counts, regardless of role', () => {
    assert.equal(isStudyQueueMode('qp_role'), false);
  });
  test('missing queue_mode defaults to comp_role (counts)', () => {
    assert.equal(isStudyQueueMode(null), true);
    assert.equal(isStudyQueueMode(undefined), true);
  });
});

import { sensChangesNeeded } from './blind';

describe('sensChangesNeeded', () => {
  // actives come from GET /api/blind/state fetched AFTER the match save.
  const act = (hero: string, sens: number | null, last_sens: number | null) => ({ hero, sens, last_sens });
  test('stage advanced: target differs from the sens just logged -> needed', () => {
    const r = sensChangesNeeded(['Soldier: 76'], [act('Soldier: 76', 5.1, 4.2)], 'comp_role');
    assert.deepEqual(r, [{ hero: 'Soldier: 76', target: '5.10', last: '4.20' }]);
  });
  test('stage did not advance: target equals the sens just logged -> not needed', () => {
    assert.equal(sensChangesNeeded(['Ana'], [act('Ana', 5.1, 5.1004)], 'comp_role').length, 0);
  });
  test('no earlier game -> needed with last null', () => {
    assert.equal(sensChangesNeeded(['Ana'], [act('Ana', 5.1, null)], 'comp_role')[0].last, null);
  });
  test('quickplay -> never', () => {
    assert.equal(sensChangesNeeded(['Ana'], [act('Ana', 5.1, 4)], 'qp_role').length, 0);
  });
  test('hero without active test or sens -> skipped', () => {
    assert.equal(sensChangesNeeded(['Ana', 'Zen'], [act('Zen', null, 4)], 'comp_role').length, 0);
  });
  test('only heroes of the logged match are checked', () => {
    assert.equal(sensChangesNeeded(['Ana'], [act('Zen', 6, 4)], 'comp_role').length, 0);
  });
  test('several logged heroes listed in logged order', () => {
    const r = sensChangesNeeded(['Zen', 'Ana'], [act('Ana', 5, 4), act('Zen', 6, 4)], 'comp_role');
    assert.deepEqual(r.map(x => x.hero), ['Zen', 'Ana']);
  });
});
