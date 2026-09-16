// nextStateFor decides whether the per-hero "Next stage/phase" button on
// Prematch's hero picker is enabled, and which of the two moves it makes
// (see the doc comment above nextStateFor in Prematch.tsx for the full
// stage-vs-phase rule). This is the function whose bug started the
// 2026-09-16 session: a hero with a full stage batch came back DISABLED
// because the "next phase" branch, not the "next stage" branch, was the one
// wired to the button. Each case below is a fixture at the exact boundary
// nextStateFor checks, not an arbitrary example.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextStateFor } from './Prematch';

const PHASE_PLAN = {
  key: 'phase2',
  label: 'Phase 2',
  plan: [{ hero: 'Ana', gamesPerSlot: 5, senses: [1, 2, 3] }],
  curveEnabled: false,
};

test('cur_stage < n_stages and games_on_stage >= batch_size: ENABLED, stage-advance action', () => {
  const activeSets = [
    { set_id: 42, hero: 'Ana', cur_stage: 1, n_stages: 2, totalGames: 5, batch_size: 5, games_on_stage: 5, dpi: null, sens: 2.6 },
  ];
  const result = nextStateFor(activeSets, [], null, 'Ana');
  assert.equal(result.enabled, true);
  assert.deepEqual(result.action, { kind: 'advance', setId: 42 });
  assert.equal(result.label, 'Next stage →');
  assert.equal(result.title, 'Move Ana to stage 2 of 2');
});

test('games still owed on the current stage: disabled, "games left" reason', () => {
  const activeSets = [
    { set_id: 42, hero: 'Ana', cur_stage: 1, n_stages: 2, totalGames: 3, batch_size: 5, games_on_stage: 3, dpi: null, sens: 2.6 },
  ];
  const result = nextStateFor(activeSets, [], null, 'Ana');
  assert.equal(result.enabled, false);
  assert.equal(result.action, null);
  assert.equal(result.label, 'Next stage →');
  assert.equal(result.title, '2 more games on stage 1 of 2 before Ana can move to the next stage');
});

test('stage complete but a phase plan is waiting: enabled, phase-advance action', () => {
  const allSets = [
    { set_id: 10, hero: 'Ana', phase: 'phase1', active: false, completed: true },
  ];
  const result = nextStateFor([], allSets, PHASE_PLAN, 'Ana');
  assert.equal(result.enabled, true);
  assert.deepEqual(result.action, { kind: 'phase' });
  assert.equal(result.label, 'Next phase →');
  assert.equal(result.title, 'Start Phase 2 for Ana');
});

test('no further phase available: disabled', () => {
  const allSets = [
    { set_id: 10, hero: 'Ana', phase: 'phase1', active: false, completed: true },
  ];
  const result = nextStateFor([], allSets, null, 'Ana');
  assert.equal(result.enabled, false);
  assert.equal(result.action, null);
  assert.equal(result.label, 'Next phase →');
  assert.equal(result.title, 'No further test phase for this hero — build one on the Sens Log page');
});
