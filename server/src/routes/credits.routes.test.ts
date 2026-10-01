// Tier 3: the 2026-10-01 credit rules over real HTTP. One match can now hold a
// credit row for every hero that played enough: counts_minutes (>= 1 minute)
// feeds the block clock, counts_result (>= 1/3 of the match) is a game.
// The danger these pin: a minutes-only row leaking into a game count.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';
import { totalGamesOf, gamesOnStageOf, blockStateOf } from './blind';

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

async function makeSet(hero: string, senses = [2.0, 3.0]) {
  const r = await h.post('/api/blind/sets', { hero, batch_size: 5, senses });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.set_id as number;
}
async function logMatch(body: Record<string, unknown>) {
  const r = await h.post('/api/matches', {
    date: '2026-09-12', time: '12:00', hour: 12, map: 'Ilios', game_type: 'comp', win: true,
    queue_mode: 'comp_role', ...body,
  });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.id as number;
}
const saveAim = (id: number, heroes: { hero: string; duration_min: number }[]) =>
  h.post('/api/aim', { match_id: id, heroes: heroes.map(x => ({ ...x, overall_acc: 40 })) });
const rows = (id: number) =>
  (h.db.prepare('SELECT hero, blind_set_id, stage_index, counts_result, counts_minutes FROM blind_credits WHERE match_id = ? ORDER BY hero')
    .all(id) as any[]).map(r => `${r.hero}:${r.stage_index}:r${r.counts_result}m${r.counts_minutes}`);

describe('Aim Stats save credits every hero that played enough', () => {
  test('both heroes over a third: each takes the game on its own set', async () => {
    const ashe = await makeSet('Ashe'); const cass = await makeSet('Cassidy', [5.0, 6.0]);
    const id = await logMatch({ hero: 'Ashe', role: 'DPS', heroes: [{ hero: 'Cassidy', role: 'DPS' }] });
    assert.deepEqual(rows(id), ['Ashe:1:r1m1'], 'before the form is saved the slot-1 hero holds the credit');
    await saveAim(id, [{ hero: 'Ashe', duration_min: 6 }, { hero: 'Cassidy', duration_min: 4 }]);
    assert.deepEqual(rows(id), ['Ashe:1:r1m1', 'Cassidy:1:r1m1']);
    assert.equal(totalGamesOf(h.db as any, ashe), 1);
    assert.equal(totalGamesOf(h.db as any, cass), 1);
    assert.equal(blockStateOf(h.db as any, cass).openMinutes, 4);
  });

  test('a hero under a third but over a minute: minutes only, never a game', async () => {
    await makeSet('Ashe'); const cass = await makeSet('Cassidy', [5.0, 6.0]);
    const id = await logMatch({ hero: 'Ashe', role: 'DPS', heroes: [{ hero: 'Cassidy', role: 'DPS' }] });
    await saveAim(id, [{ hero: 'Ashe', duration_min: 10 }, { hero: 'Cassidy', duration_min: 1.5 }]);
    assert.deepEqual(rows(id), ['Ashe:1:r1m1', 'Cassidy:1:r0m1']);
    assert.equal(totalGamesOf(h.db as any, cass), 0, 'minutes-only row is not a game');
    assert.equal(gamesOnStageOf(h.db as any, cass, 1), 0);
    assert.equal(blockStateOf(h.db as any, cass).openMinutes, 1.5, 'but its minutes count on the clock');
    const state = (await h.get('/api/blind/state')).body.actives.find((a: any) => a.hero === 'Cassidy');
    assert.equal(state.totalGames, 0);
    assert.equal(state.games_on_stage, 0);
  });

  test('a hero under a minute and under a third gets no row (and a stale one is dropped)', async () => {
    await makeSet('Ashe'); const cass = await makeSet('Cassidy', [5.0, 6.0]);
    const id = await logMatch({ hero: 'Ashe', role: 'DPS', heroes: [{ hero: 'Cassidy', role: 'DPS' }] });
    await saveAim(id, [{ hero: 'Ashe', duration_min: 10 }, { hero: 'Cassidy', duration_min: 4 }]);
    assert.equal(rows(id).length, 2);
    await saveAim(id, [{ hero: 'Ashe', duration_min: 10 }, { hero: 'Cassidy', duration_min: 0.6 }]);
    assert.deepEqual(rows(id), ['Ashe:1:r1m1']);
    assert.equal(blockStateOf(h.db as any, cass).openMinutes, 0);
  });

  test('a correction keeps the stage the hero was credited on, even after the set moved on', async () => {
    const ashe = await makeSet('Ashe'); const cass = await makeSet('Cassidy', [5.0, 6.0]);
    const id = await logMatch({ hero: 'Ashe', role: 'DPS', heroes: [{ hero: 'Cassidy', role: 'DPS' }] });
    await saveAim(id, [{ hero: 'Ashe', duration_min: 6 }, { hero: 'Cassidy', duration_min: 4 }]);
    assert.equal(h.db.prepare('SELECT stage_index FROM blind_credits WHERE match_id = ? AND hero = ?').get(id, 'Cassidy')!.stage_index, 1);
    assert.equal((await h.post('/api/blind/advance', { set_id: cass, force: true })).status, 200);
    await saveAim(id, [{ hero: 'Ashe', duration_min: 7 }, { hero: 'Cassidy', duration_min: 4 }]);
    assert.deepEqual(rows(id), ['Ashe:1:r1m1', 'Cassidy:1:r1m1'], 'still stage 1, not today\'s stage 2');
    void ashe;
  });

  test('a hero credited for the first time lands on the stage its logged sens says, not today\'s', async () => {
    await makeSet('Ashe'); const cass = await makeSet('Cassidy', [5.0, 6.0]);
    const id = await logMatch({ hero: 'Ashe', role: 'DPS', heroes: [{ hero: 'Cassidy', role: 'DPS' }] });
    // Cassidy's set moves to stage 2 AFTER the match was logged at stage 1 (5.0).
    assert.equal((await h.post('/api/blind/advance', { set_id: cass, force: true })).status, 200);
    await saveAim(id, [{ hero: 'Ashe', duration_min: 6 }, { hero: 'Cassidy', duration_min: 4 }]);
    assert.deepEqual(rows(id), ['Ashe:1:r1m1', 'Cassidy:1:r1m1']);
  });

  test('Quick Play never earns a row', async () => {
    await makeSet('Ashe');
    const id = await logMatch({ hero: 'Ashe', role: 'DPS', queue_mode: 'qp_role' });
    await saveAim(id, [{ hero: 'Ashe', duration_min: 10 }]);
    assert.deepEqual(rows(id), []);
  });
});

describe('/api/aim/pending lists each study match once', () => {
  test('a match holding two credit rows still appears once, and the total counts it once', async () => {
    await makeSet('Ashe'); await makeSet('Cassidy', [5.0, 6.0]);
    const id = await logMatch({ hero: 'Ashe', role: 'DPS', heroes: [{ hero: 'Cassidy', role: 'DPS' }] });
    h.db.prepare("INSERT INTO blind_credits (match_id, hero, blind_set_id, stage_index, counts_result, counts_minutes) SELECT ?, 'Cassidy', id, 1, 0, 1 FROM blind_stage_sets WHERE hero = 'Cassidy'").run(id);
    const r = (await h.get('/api/aim/pending')).body;
    assert.equal(r.rows.filter((x: any) => x.id === id).length, 1);
    assert.equal(r.total, 1);
  });
});

describe('matches_by_hero: the one-third share rule replaces the 20% cameo rule', () => {
  const view = (id: number) => (h.db.prepare('SELECT hero FROM matches_by_hero WHERE id = ? ORDER BY hero').all(id) as any[]).map(r => r.hero);
  test('exactly one third stays; a hair under drops; 25% (kept by the old 20% rule) now drops', async () => {
    const a = await logMatch({ hero: 'Ashe', role: 'DPS', heroes: [{ hero: 'Cassidy', role: 'DPS' }] });
    await saveAim(a, [{ hero: 'Ashe', duration_min: 10 }, { hero: 'Cassidy', duration_min: 5 }]);
    assert.deepEqual(view(a), ['Ashe', 'Cassidy']);
    const b = await logMatch({ hero: 'Ashe', role: 'DPS', heroes: [{ hero: 'Cassidy', role: 'DPS' }] });
    await saveAim(b, [{ hero: 'Ashe', duration_min: 10 }, { hero: 'Cassidy', duration_min: 4.9 }]);
    assert.deepEqual(view(b), ['Ashe']);
    const c = await logMatch({ hero: 'Ashe', role: 'DPS', heroes: [{ hero: 'Cassidy', role: 'DPS' }] });
    await saveAim(c, [{ hero: 'Ashe', duration_min: 15 }, { hero: 'Cassidy', duration_min: 5 }]);
    assert.deepEqual(view(c), ['Ashe'], '25% share: the old rule kept it, the new one does not');
  });
  test('a match with no minutes keeps every hero (current behaviour)', async () => {
    const id = await logMatch({ hero: 'Ashe', role: 'DPS', heroes: [{ hero: 'Cassidy', role: 'DPS' }] });
    assert.deepEqual(view(id), ['Ashe', 'Cassidy']);
  });
});
