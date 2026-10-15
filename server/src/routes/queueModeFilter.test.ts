// The vote advice rates follow the selected queue mode: /api/stats/map-voting
// and /api/advisor/test-pick take an optional queue_mode that filters every
// figure they return. Absent = all modes (unchanged). Fixture db only.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';
import { insertMatch, insertHeroSlot, insertBlindSet } from '../db/fixtures';
import { configureReplicaCache } from '../lab/replicaCache';

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

const TODAY = new Date().toISOString().slice(0, 10);

function games(n: number, wins: number, queue: string, map = 'Ilios', hero = 'Ana') {
  for (let i = 0; i < n; i++) {
    const id = insertMatch(h.db, { date: TODAY, hero, role: 'Support', map, win: i < wins ? 1 : 0, queue_mode: queue });
    insertHeroSlot(h.db, { match_id: id, slot: 1, hero, role: 'Support' });
  }
}

// Ilios: 4 comp_role games (3 wins), 5 qp_role games (1 win), 0 comp_open.
function seed() {
  insertBlindSet(h.db, { hero: 'Ana', batch_size: 6 });
  games(4, 3, 'comp_role');
  games(5, 1, 'qp_role');
  games(2, 1, 'comp_role', 'Nepal');
  games(1, 0, 'qp_role', 'Nepal');
}

async function viaDb(url: string) {
  configureReplicaCache({ baseUrl: h.baseUrl, source: async () => h.db });
  const r = await h.get(url);
  configureReplicaCache({ baseUrl: h.baseUrl });
  return r;
}

describe('GET /api/stats/map-voting queue_mode', () => {
  test('without it all modes pool; with it only that mode counts', async () => {
    seed();
    const all = (await h.get('/api/stats/map-voting')).body.find((r: any) => r.map === 'Ilios');
    assert.equal(all.total_games, 9);
    const comp = (await h.get('/api/stats/map-voting?queue_mode=comp_role')).body.find((r: any) => r.map === 'Ilios');
    assert.equal(comp.total_games, 4);
    assert.equal(comp.historical_rate, 75);
    assert.equal(comp.recent_games, 4);
    const qp = (await h.get('/api/stats/map-voting?queue_mode=qp_role')).body.find((r: any) => r.map === 'Ilios');
    assert.equal(qp.total_games, 5);
    assert.equal(qp.historical_rate, 20);
  });
  test('a mode with no games returns no rows, and an unknown mode is a 400', async () => {
    seed();
    assert.deepEqual((await h.get('/api/stats/map-voting?queue_mode=comp_open')).body, []);
    assert.equal((await h.get('/api/stats/map-voting?queue_mode=bogus')).status, 400);
  });
});

describe('GET /api/advisor/test-pick queue_mode', () => {
  test('without it all modes pool; with it only that mode counts', async () => {
    seed();
    const all = (await viaDb('/api/advisor/test-pick?role=Support&maps=Ilios')).body;
    assert.equal(all.picks[0].games, 9);
    const comp = (await viaDb('/api/advisor/test-pick?role=Support&maps=Ilios&queue_mode=comp_role')).body;
    assert.equal(comp.picks[0].games, 4);
    assert.equal(comp.picks[0].win_rate, 75);
    assert.equal(comp.picks[0].sample_size, 'strong');
    // Nepal: 2 comp_role + 1 qp_role. All modes = 3 games (strong); comp only = 2 (thin).
    const nAll = (await viaDb('/api/advisor/test-pick?role=Support&maps=Nepal')).body;
    assert.deepEqual([nAll.picks[0].games, nAll.picks[0].sample_size], [3, 'strong']);
    const nComp = (await viaDb('/api/advisor/test-pick?role=Support&maps=Nepal&queue_mode=comp_role')).body;
    assert.deepEqual([nComp.picks[0].games, nComp.picks[0].sample_size], [2, 'thin']);
    const qp = (await viaDb('/api/advisor/test-pick?role=Support&maps=Ilios&queue_mode=qp_role')).body;
    assert.equal(qp.picks[0].games, 5);
    assert.equal(qp.picks[0].win_rate, 20);
  });
  test('a mode with no games says no_data, and an unknown mode is a 400', async () => {
    seed();
    const open = (await viaDb('/api/advisor/test-pick?role=Support&maps=Ilios&queue_mode=comp_open')).body;
    assert.equal(open.available, false);
    assert.equal(open.reason, 'no_data');
    assert.equal((await viaDb('/api/advisor/test-pick?role=Support&maps=Ilios&queue_mode=bogus')).status, 400);
  });
});
