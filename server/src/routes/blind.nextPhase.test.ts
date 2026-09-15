// Pins the contract Prematch's per-hero "Next" button depends on. That button
// (client/src/pages/Prematch.tsx, data-inspect-id
// prematch-hero-picker-next-phase-button) moves one hero onto the newest phase
// plan by POSTing the plan's bracket straight to /api/blind/sets — the same
// body SensLog's "Create test set" builds, just issued from the pre-match
// screen instead. Nothing else in the suite asserts that a phase-tagged,
// curve-enabled, sens-path creation round-trips with its tag intact, and the
// button is only correct if it does: the phase tag is what every "is this hero
// already on the next phase / done with its current one" read keys off.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';

let h: Harness;

beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

// Byte-for-byte the body startNextPhase() sends for a sens-path plan row.
const nextPhaseBody = (hero: string, phase: string) => ({
  senses: [2.43, 2.49],
  batch_size: 5,
  hero,
  phase,
  curve_enabled: true,
});

describe('POST /api/blind/sets — Prematch "start next phase" button contract', () => {
  test('creates a phase-tagged set whose stages come from the plan bracket', async () => {
    const r = await h.post('/api/blind/sets', nextPhaseBody('Baptiste', 'custom-9999'));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.hero, 'Baptiste');
    assert.equal(r.body.phase, 'custom-9999');
    assert.equal(r.body.batch_size, 5);
    assert.equal(r.body.n_stages, 2);
    assert.equal(r.body.curve_enabled, true);
    assert.deepEqual(r.body.stages.map((s: any) => s.sens), [2.43, 2.49]);
  });

  // The button's enabled condition is "no set for (hero, newest phase) yet AND
  // this hero's latest set is completed" — which implies no active set, so the
  // dupe guard should never fire in practice. Asserted anyway because the
  // button ignores the response body entirely (same as SensLog's version), so a
  // 409 here would be a silent no-op in the UI rather than a visible error.
  test('refuses a second active set for the same hero', async () => {
    const first = await h.post('/api/blind/sets', nextPhaseBody('Baptiste', 'custom-9998'));
    assert.equal(first.status, 200);
    const second = await h.post('/api/blind/sets', nextPhaseBody('Baptiste', 'custom-9999'));
    assert.equal(second.status, 409);
  });

  // GET /api/blind/sets is what Prematch reads back to decide whether a hero is
  // already on the next phase; the tag has to survive that round trip too.
  test('the new set comes back from GET /api/blind/sets carrying its phase tag', async () => {
    const created = await h.post('/api/blind/sets', nextPhaseBody('Ana', 'custom-9999'));
    assert.equal(created.status, 200);
    const { body } = await h.get('/api/blind/sets');
    const row = body.sets.find((s: any) => s.set_id === created.body.set_id);
    assert.ok(row, 'created set missing from GET /api/blind/sets');
    assert.equal(row.phase, 'custom-9999');
    assert.equal(row.hero, 'Ana');
    assert.equal(row.completed, false);
    assert.equal(row.active, true);
  });
});
