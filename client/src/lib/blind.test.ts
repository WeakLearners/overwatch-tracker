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
