// Tier 3: GET/PUT /api/config over real HTTP (see test/httpHarness.ts) —
// field registry Phase 1 (modular-tracking-roadmap.md). Covers the default
// state, a plain toggle, the dependency auto-enable, the refused disable,
// and the sens-study lock.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';
import { insertBlindSet } from '../db/fixtures';

let h: Harness;

beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

describe('GET /api/config', () => {
  test('with no saved row, every category is on — adding the switches changes nothing for an existing user', async () => {
    const r = await h.get('/api/config');
    assert.equal(r.status, 200);
    assert.deepEqual([...r.body.enabledCategories].sort(), ['combat', 'core', 'mouse-settings', 'rank', 'sens-study', 'subjective']);
    assert.deepEqual(r.body.lockedCategories, []);
    // The Log Match Deaths card must stay visible for the existing user.
    const deaths = r.body.fields.find((f: any) => f.id === 'deaths');
    assert.equal(deaths.enabled, true);
  });

  test('reflects a saved PUT', async () => {
    await h.put('/api/config', { enabledCategories: ['combat'] });
    const r = await h.get('/api/config');
    assert.ok(r.body.enabledCategories.includes('combat'));
    assert.ok(r.body.enabledCategories.includes('core'));
    const deaths = r.body.fields.find((f: any) => f.id === 'deaths');
    assert.equal(deaths.enabled, true);
  });
});

describe('PUT /api/config — plain toggle', () => {
  test('enabling combat turns the deaths field on', async () => {
    const r = await h.put('/api/config', { enabledCategories: ['combat'] });
    assert.equal(r.status, 200);
    assert.ok(r.body.enabledCategories.includes('combat'));
  });

  test('an unknown category id is rejected', async () => {
    const r = await h.put('/api/config', { enabledCategories: ['not-a-real-category'] });
    assert.equal(r.status, 400);
  });
});

describe('PUT /api/config — dependency auto-enable', () => {
  test('enabling sens-study alone also enables mouse-settings', async () => {
    // Start from everything off. With no saved row every category is on, so
    // mouse-settings would already be on and there'd be nothing to auto-enable.
    const off = await h.put('/api/config', { enabledCategories: [] });
    assert.equal(off.status, 200);
    const r = await h.put('/api/config', { enabledCategories: ['sens-study'] });
    assert.equal(r.status, 200);
    assert.ok(r.body.enabledCategories.includes('sens-study'));
    assert.ok(r.body.enabledCategories.includes('mouse-settings'));
  });
});

describe('PUT /api/config — refused disable', () => {
  test('disabling mouse-settings while sens-study stays requested is refused', async () => {
    await h.put('/api/config', { enabledCategories: ['sens-study', 'mouse-settings'] });
    const r = await h.put('/api/config', { enabledCategories: ['sens-study'] });
    // sens-study requested without mouse-settings, but mouse-settings was
    // already ON from the previous call — refused, not silently kept.
    assert.equal(r.status, 409);
    assert.equal(r.body.category, 'mouse-settings');

    // Confirm the refusal didn't change stored state.
    const check = await h.get('/api/config');
    assert.ok(check.body.enabledCategories.includes('mouse-settings'));
    assert.ok(check.body.enabledCategories.includes('sens-study'));
  });
});

describe('PUT /api/config — sens-study lock', () => {
  test('an open blind stage set locks sens-study and refuses to disable it', async () => {
    await h.put('/api/config', { enabledCategories: ['sens-study', 'mouse-settings'] });
    insertBlindSet(h.db, { active: 1 });

    const locked = await h.get('/api/config');
    assert.deepEqual(locked.body.lockedCategories, [
      { id: 'sens-study', reason: 'locked — a sensitivity study stage is running' },
    ]);

    const r = await h.put('/api/config', { enabledCategories: ['mouse-settings'] });
    assert.equal(r.status, 409);
    assert.equal(r.body.category, 'sens-study');
  });

  test('unlocks once no blind stage set is active', async () => {
    await h.put('/api/config', { enabledCategories: ['sens-study', 'mouse-settings'] });
    const setId = insertBlindSet(h.db, { active: 1 });
    h.db.prepare('UPDATE blind_stage_sets SET active = 0 WHERE id = :id').run({ id: setId });

    const r = await h.put('/api/config', { enabledCategories: ['mouse-settings'] });
    assert.equal(r.status, 200);
    assert.ok(!r.body.enabledCategories.includes('sens-study'));
  });
});

describe('POST /api/config/preset — first-run presets', () => {
  const sorted = (a: string[]) => [...a].sort();

  test('a fresh database asks for a preset, and GET still reports every category on', async () => {
    const r = await h.get('/api/config');
    assert.equal(r.body.needsPreset, true);
    assert.deepEqual(r.body.presets.map((p: any) => p.id), ['casual', 'improver', 'scientist']);
  });

  test('casual turns on core and rank only: 4 registry fields', async () => {
    const r = await h.post('/api/config/preset', { preset: 'casual' });
    assert.equal(r.status, 200);
    assert.deepEqual(sorted(r.body.enabledCategories), ['core', 'rank']);
    assert.equal(r.body.needsPreset, false);
    assert.equal(r.body.fields.filter((f: any) => f.enabled).length, 4);
  });

  test('improver adds subjective and combat: 9 registry fields, feel off', async () => {
    const r = await h.post('/api/config/preset', { preset: 'improver' });
    assert.deepEqual(sorted(r.body.enabledCategories), ['combat', 'core', 'rank', 'subjective']);
    assert.equal(r.body.fields.filter((f: any) => f.enabled).length, 9);
    assert.equal(r.body.fields.find((f: any) => f.id === 'feel').enabled, false);
  });

  test('scientist is every category: 10 registry fields', async () => {
    const r = await h.post('/api/config/preset', { preset: 'scientist' });
    assert.deepEqual(sorted(r.body.enabledCategories), ['combat', 'core', 'mouse-settings', 'rank', 'sens-study', 'subjective']);
    assert.equal(r.body.fields.filter((f: any) => f.enabled).length, 10);
  });

  test('a user who already has a saved row is refused and keeps their setup', async () => {
    await h.put('/api/config', { enabledCategories: ['combat'] });
    const r = await h.post('/api/config/preset', { preset: 'casual' });
    assert.equal(r.status, 409);
    const check = await h.get('/api/config');
    assert.ok(check.body.enabledCategories.includes('combat'));
    assert.ok(!check.body.enabledCategories.includes('rank'));
  });

  test('an unknown preset is rejected', async () => {
    const r = await h.post('/api/config/preset', { preset: 'nope' });
    assert.equal(r.status, 400);
  });

  test('a running sens study keeps sens-study on, with its prerequisite, under casual', async () => {
    insertBlindSet(h.db, { active: 1 });
    const r = await h.post('/api/config/preset', { preset: 'casual' });
    assert.equal(r.status, 200);
    assert.ok(r.body.enabledCategories.includes('sens-study'));
    assert.ok(r.body.enabledCategories.includes('mouse-settings'));
  });
});
