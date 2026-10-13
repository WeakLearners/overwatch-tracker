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
  const act = (hero: string, sens: number | null, last_sens: number | null, last_match_id: number | null) => ({ hero, sens, last_sens, last_match_id });
  const none = new Set<string>();
  test('differs from last game -> needed', () => {
    const r = sensChangesNeeded(['Soldier: 76'], [act('Soldier: 76', 5.1, 4.2, 9)], 'comp_role', none);
    assert.deepEqual(r, [{ hero: 'Soldier: 76', target: '5.10', last: '4.20', ackKey: 'Soldier: 76|5.10|9' }]);
  });
  test('same at 2 decimals -> not needed', () => {
    assert.equal(sensChangesNeeded(['Ana'], [act('Ana', 5.1, 5.1004, 3)], 'comp_role', none).length, 0);
  });
  test('no earlier game -> needed with last null', () => {
    const r = sensChangesNeeded(['Ana'], [act('Ana', 5.1, null, null)], 'comp_role', none);
    assert.equal(r[0].last, null);
    assert.equal(r[0].ackKey, 'Ana|5.10|none');
  });
  test('quickplay -> never', () => {
    assert.equal(sensChangesNeeded(['Ana'], [act('Ana', 5.1, 4, 1)], 'qp_role', none).length, 0);
  });
  test('hero without active test or sens -> skipped', () => {
    assert.equal(sensChangesNeeded(['Ana', 'Zen'], [act('Zen', null, 4, 1)], 'comp_role', none).length, 0);
  });
  test('ack hides that triple only; new last match re-arms', () => {
    const acked = new Set(['Ana|5.10|1']);
    assert.equal(sensChangesNeeded(['Ana'], [act('Ana', 5.1, 4, 1)], 'comp_role', acked).length, 0);
    assert.equal(sensChangesNeeded(['Ana'], [act('Ana', 5.1, 4, 2)], 'comp_role', acked).length, 1);
    assert.equal(sensChangesNeeded(['Ana'], [act('Ana', 5.2, 4, 1)], 'comp_role', acked).length, 1);
  });
  test('several heroes listed in pick order', () => {
    const r = sensChangesNeeded(['Zen', 'Ana'], [act('Ana', 5, 4, 1), act('Zen', 6, 4, 2)], 'comp_role', none);
    assert.deepEqual(r.map(x => x.hero), ['Zen', 'Ana']);
  });
});
