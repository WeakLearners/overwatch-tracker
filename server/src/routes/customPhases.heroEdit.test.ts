// PATCH /api/custom-phases/:key/heroes/:hero — edit one hero of a custom phase.
// Hero and sens lock once a test set exists (study data must not move under a
// live or finished test); archetype and note stay editable.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';

let h: Harness;
const KEY = 'custom-1790999999999';
beforeEach(async () => {
  h = await startHarness();
  await h.post('/api/custom-phases', {
    key: KEY, label: 'Phase X', description: '2 heroes × 2 stages, 1920 min total. Note.',
    plan: [
      { hero: 'Ashe', archetype: 'Hitscan', gamesPerSlot: 40, note: '', senses: [2.5, 2.65] },
      { hero: 'Ana', archetype: 'Projectile', gamesPerSlot: 40, note: '', senses: [2.2, 2.35] },
    ],
  });
});
afterEach(async () => { await h.close(); });

const planOf = async () => (await h.get(`/api/custom-phases`)).body.phases.find((p: any) => p.key === KEY);
const lockHero = (hero: string) => h.db.prepare(
  `INSERT INTO blind_stage_sets (in_game_sens, base_dpi, active, batch_size, hero, phase) VALUES (2.5, 1600, 1, 40, :hero, :phase)`,
).run({ hero, phase: KEY });

describe('PATCH custom-phases hero edit', () => {
  test('no test set: hero, archetype, senses and note all change', async () => {
    const r = await h.patch(`/api/custom-phases/${KEY}/heroes/Ashe`, { hero: 'Soldier: 76', archetype: 'Hybrid', note: ' hi ', senses: [2.4, 2.6] });
    assert.equal(r.status, 200);
    const p = await planOf();
    assert.deepEqual(p.plan[0], { hero: 'Soldier: 76', archetype: 'Hybrid', gamesPerSlot: 40, note: 'hi', senses: [2.4, 2.6] });
    assert.equal(p.description, '2 heroes × 2 stages, 1920 min total. Note.');
  });

  test('test set exists: hero and sens changes answer 409, plan unchanged', async () => {
    lockHero('Ashe');
    assert.equal((await h.patch(`/api/custom-phases/${KEY}/heroes/Ashe`, { hero: 'Genji' })).status, 409);
    assert.equal((await h.patch(`/api/custom-phases/${KEY}/heroes/Ashe`, { senses: [2.4, 2.6] })).status, 409);
    const p = await planOf();
    assert.equal(p.plan[0].hero, 'Ashe');
    assert.deepEqual(p.plan[0].senses, [2.5, 2.65]);
  });

  test('test set exists: archetype and note still save, unchanged senses accepted', async () => {
    lockHero('Ashe');
    const r = await h.patch(`/api/custom-phases/${KEY}/heroes/Ashe`, { archetype: 'Hybrid', note: 'x', senses: [2.5, 2.65] });
    assert.equal(r.status, 200);
    const p = await planOf();
    assert.equal(p.plan[0].archetype, 'Hybrid');
    assert.equal(p.plan[0].note, 'x');
  });

  test('validation: low >= high, wrong stage count, duplicate hero, unknown hero/phase', async () => {
    const u = `/api/custom-phases/${KEY}/heroes/Ashe`;
    assert.equal((await h.patch(u, { senses: [2.6, 2.5] })).status, 400);
    assert.equal((await h.patch(u, { senses: [0, 2.5] })).status, 400);
    assert.equal((await h.patch(u, { senses: [2.4, 2.5, 2.6] })).status, 400);
    assert.equal((await h.patch(u, { hero: 'Ana' })).status, 409);
    assert.equal((await h.patch(`/api/custom-phases/${KEY}/heroes/Nobody`, { note: 'x' })).status, 404);
    assert.equal((await h.patch(`/api/custom-phases/nope/heroes/Ashe`, { note: 'x' })).status, 404);
  });
});
