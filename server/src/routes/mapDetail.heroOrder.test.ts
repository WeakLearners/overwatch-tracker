// /api/stats/map-detail lists each role's heroes by games played, not by win rate.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';
import { insertSoloMatch } from '../test/dbFixtures';

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

function add(hero: string, wins: number, losses: number) {
  for (let i = 0; i < wins + losses; i++) {
    insertSoloMatch(h.db, { date: '2026-10-05', hero, role: 'Support', win: i < wins ? 1 : 0, map: 'Numbani', queue_mode: 'comp_role' } as any);
  }
}

test('heroes on a map are ordered by games, then win rate', async () => {
  add('Ana', 4, 0);        // 4 games, 100%
  add('Mercy', 6, 6);      // 12 games, 50%
  add('Lucio', 8, 2);      // 10 games, 80%
  const body = (await h.get('/api/stats/map-detail/Numbani')).body;
  assert.deepEqual(body.heroes.Support.map((x: any) => x.hero), ['Mercy', 'Lucio', 'Ana']);
});
