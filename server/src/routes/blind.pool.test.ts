// Removing a hero from the tested pool = pausing its set (POST
// /api/blind/sets/:id/pause) — never a delete. These tests pin the contract:
// data survives, a paused hero earns no credit and is never ranked, re-adding
// resumes the SAME set, and nothing (credit edits, a create call) quietly
// undoes the pause. See blind.routes.test.ts for the harness conventions.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

async function playGames(hero: string, n: number) {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = await h.post('/api/matches', {
      date: '2026-10-03', time: '12:00', hour: 12, hero, role: 'DPS',
      map: 'Ilios', game_type: 'comp', win: i % 2 === 0, queue_mode: 'comp_role',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    ids.push(r.body.id);
  }
  return ids;
}

async function makeSet(hero: string, phase = 'phaseA', batch_size = 5) {
  const r = await h.post('/api/blind/sets', { hero, batch_size, senses: [2.0, 3.0], phase });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.set_id as number;
}

const creditCount = (setId: number) =>
  Number((h.db.prepare('SELECT COUNT(*) n FROM blind_credits WHERE blind_set_id = ?').get(setId) as { n: number }).n);
const setRow = async (setId: number) =>
  (await h.get('/api/blind/sets')).body.sets.find((s: any) => s.set_id === setId);

describe('pause (remove from pool)', () => {
  test('keeps every row, stops crediting, drops out of state and the ranking', async () => {
    const ashe = await makeSet('Ashe');
    const tracer = await makeSet('Tracer');
    await playGames('Ashe', 2);

    const r = await h.post(`/api/blind/sets/${ashe}/pause`, {});
    assert.equal(r.status, 200);

    const s = await setRow(ashe);
    assert.equal(s.paused, true);
    assert.equal(s.active, false);
    assert.equal(s.totalGames, 2, 'credits stay readable');
    assert.equal(Number((h.db.prepare('SELECT COUNT(*) n FROM blind_stages WHERE set_id = ?').get(ashe) as any).n), 2);

    const state = (await h.get('/api/blind/state')).body;
    assert.deepEqual(state.actives.map((a: any) => a.set_id), [tracer]);

    // New Ashe games no longer credit the paused set.
    await playGames('Ashe', 1);
    assert.equal(creditCount(ashe), 2);

    const next = (await h.get('/api/blind/next?queue_mode=comp_role')).body;
    assert.deepEqual(next.heroes.map((x: any) => x.hero), ['Tracer']);
    assert.deepEqual(next.pausedHeroes, ['Ashe']);
    assert.equal(next.allPaused, false);
  });

  test('pool with every hero removed reports allPaused, not "finished"', async () => {
    const ashe = await makeSet('Ashe');
    await h.post(`/api/blind/sets/${ashe}/pause`, {});
    const next = (await h.get('/api/blind/next?queue_mode=comp_role')).body;
    assert.equal(next.allPaused, true);
    assert.deepEqual(next.heroes, []);
  });

  test('a completed set cannot be paused; unknown set is 404', async () => {
    const id = await makeSet('Ashe');
    h.db.prepare('UPDATE blind_stage_sets SET active = 0, legacy_closed = 1 WHERE id = ?').run(id);
    assert.equal((await h.post(`/api/blind/sets/${id}/pause`, {})).status, 409);
    assert.equal((await h.post('/api/blind/sets/99999/pause', {})).status, 404);
  });

  test('creating a set for a paused hero in the same phase is refused; another phase is allowed', async () => {
    const id = await makeSet('Ashe', 'phaseA');
    await h.post(`/api/blind/sets/${id}/pause`, {});
    const same = await h.post('/api/blind/sets', { hero: 'Ashe', batch_size: 5, senses: [2, 3], phase: 'phaseA' });
    assert.equal(same.status, 409);
    assert.equal(same.body.pausedSetId, id);
    const other = await h.post('/api/blind/sets', { hero: 'Ashe', batch_size: 5, senses: [2, 3], phase: 'phaseB' });
    assert.equal(other.status, 200);
  });

  test('a credit edit or delete does not wake a paused set', async () => {
    const id = await makeSet('Ashe');
    const ids = await playGames('Ashe', 2);
    await h.post(`/api/blind/sets/${id}/pause`, {});
    assert.equal((await h.del(`/api/matches/${ids[1]}`)).status, 200);
    const s = await setRow(id);
    assert.equal(s.paused, true);
    assert.equal(s.active, false);
  });

  test('the sens-study config lock releases only when no set is running', async () => {
    const a = await makeSet('Ashe');
    const t = await makeSet('Tracer');
    await h.post(`/api/blind/sets/${a}/pause`, {});
    assert.equal((await h.get('/api/config')).body.lockedCategories.length, 1, 'Tracer still running');
    await h.post(`/api/blind/sets/${t}/pause`, {});
    assert.equal((await h.get('/api/config')).body.lockedCategories.length, 0);
    await h.post(`/api/blind/sets/${t}/resume`, {});
    assert.equal((await h.get('/api/config')).body.lockedCategories.length, 1);
  });
});

describe('resume (add back to pool)', () => {
  test('resumes the same set with its credits and crediting restarts', async () => {
    const id = await makeSet('Ashe');
    await playGames('Ashe', 2);
    await h.post(`/api/blind/sets/${id}/pause`, {});
    await playGames('Ashe', 1);   // uncredited while paused

    const r = await h.post(`/api/blind/sets/${id}/resume`, {});
    assert.equal(r.status, 200);
    const s = await setRow(id);
    assert.equal(s.paused, false);
    assert.equal(s.active, true);
    assert.equal(s.totalGames, 2);

    await playGames('Ashe', 1);
    assert.equal(creditCount(id), 3);
    assert.equal(Number((h.db.prepare('SELECT COUNT(*) n FROM blind_stage_sets WHERE hero = ?').get('Ashe') as any).n), 1, 'no second set');
  });

  test('refuses when the set is not paused, or another active set owns the hero', async () => {
    const id = await makeSet('Ashe');
    assert.equal((await h.post(`/api/blind/sets/${id}/resume`, {})).status, 409);
    await h.post(`/api/blind/sets/${id}/pause`, {});
    // A rival can only appear via direct DB access (the create route refuses it); simulate it.
    h.db.prepare("INSERT INTO blind_stage_sets (in_game_sens, base_dpi, active, hero, phase) VALUES (2.5, 1600, 1, 'Ashe', 'phaseZ')").run();
    assert.equal((await h.post(`/api/blind/sets/${id}/resume`, {})).status, 409);
  });
});
