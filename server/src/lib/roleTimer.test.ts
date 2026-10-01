import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeRoleTimer, ROLE_THRESHOLD_MIN, RoleTimerMatch } from './roleTimer';

const m = (role: string, minutes: number | null, queue_mode = 'comp_role', date = '2026-10-01'): RoleTimerMatch =>
  ({ date, role, queue_mode, minutes });

describe('computeRoleTimer (newest first)', () => {
  test('a role switch ends the run', () => {
    const t = computeRoleTimer([m('DPS', 10), m('DPS', 10, 'comp_open', '2026-09-30'), m('Support', 50), m('DPS', 60)], 9.4);
    assert.equal(t.role, 'DPS');
    assert.equal(t.matches, 2);
    assert.equal(t.recordedMin, 20);
    assert.equal(t.since, '2026-09-30');
    assert.equal(t.switchTo, 'Support');
  });

  test('Quick Play neither counts nor breaks the run', () => {
    const t = computeRoleTimer([m('DPS', 10), m('Support', 99, 'qp_role'), m('DPS', 10), m('DPS', 5, 'qp_role')], 9.4);
    assert.equal(t.matches, 2);
    assert.equal(t.recordedMin, 20);
  });

  test('matches with no minutes use the average and report it separately', () => {
    const t = computeRoleTimer([m('Support', null), m('Support', 10)], 9.5);
    assert.equal(t.recordedMin, 10);
    assert.equal(t.estimatedMin, 9.5);
    assert.equal(t.totalMin, 19.5);
  });

  test('crossing 240 sets reached; one minute short does not', () => {
    assert.equal(computeRoleTimer([m('DPS', ROLE_THRESHOLD_MIN - 1)], 9.4).reached, false);
    const t = computeRoleTimer([m('DPS', ROLE_THRESHOLD_MIN)], 9.4);
    assert.equal(t.reached, true);
    assert.equal(t.thresholdMin, 240);
  });

  test('no competitive matches at all: empty timer, never reached', () => {
    const t = computeRoleTimer([m('DPS', 10, 'qp_role')], 9.4);
    assert.equal(t.role, null);
    assert.equal(t.reached, false);
    assert.equal(t.switchTo, null);
  });
});
