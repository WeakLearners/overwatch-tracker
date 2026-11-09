// OW-0004: the test candidate list. Quick Play only, 25 to be eligible, roster heroes excluded.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';
import { candidateEligible, CANDIDATE_MIN_QP } from '../lib/testCandidates';

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

async function play(hero: string, n: number, queue_mode: string) {
  for (let i = 0; i < n; i++) {
    const r = await h.post('/api/matches', { date: '2026-11-01', time: '12:00', hour: 12, hero, role: 'DPS', map: 'Ilios', game_type: queue_mode === 'qp_role' ? 'qp' : 'comp', win: i % 2 === 0, queue_mode });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  }
}
const candidates = async () => (await h.get('/api/blind/candidates')).body as { min_qp: number; heroes: { hero: string; qp_matches: number; eligible: boolean }[] };

describe('candidateEligible', () => {
  test('the threshold is 25 and the boundary is 24 / 25', () => {
    assert.equal(CANDIDATE_MIN_QP, 25);
    assert.equal(candidateEligible(24), false);
    assert.equal(candidateEligible(25), true);
    assert.equal(candidateEligible(0), false);
  });
});

describe('GET /api/blind/candidates', () => {
  test('counts Quick Play only; comp games do not count; 24 refused, 25 eligible', async () => {
    await play('Sombra', 24, 'qp_role');
    await play('Sombra', 5, 'comp_role');
    await play('Mei', 25, 'qp_role');
    await play('Genji', 3, 'comp_role');
    const c = await candidates();
    assert.equal(c.min_qp, 25);
    const by = Object.fromEntries(c.heroes.map(x => [x.hero, x]));
    assert.deepEqual([by.Sombra.qp_matches, by.Sombra.eligible], [24, false]);
    assert.deepEqual([by.Mei.qp_matches, by.Mei.eligible], [25, true]);
    assert.deepEqual([by.Genji.qp_matches, by.Genji.eligible], [0, false]);
    assert.deepEqual(c.heroes.map(x => x.hero), ['Mei', 'Sombra', 'Genji']);
  });

  test('a hero with a live test set is not a candidate', async () => {
    await play('Ashe', 2, 'comp_role');
    await play('Mei', 2, 'qp_role');
    const mk = await h.post('/api/blind/sets', { hero: 'Ashe', batch_size: 5, senses: [2.0, 3.0] });
    assert.equal(mk.status, 200, JSON.stringify(mk.body));
    assert.deepEqual((await candidates()).heroes.map(x => x.hero), ['Mei']);
  });

  test('it only reads: no test set is created', async () => {
    await play('Mei', 30, 'qp_role');
    await candidates();
    const sets = (await h.get('/api/blind/sets')).body as unknown;
    assert.equal(JSON.stringify(sets).includes('Mei'), false);
  });
});
