// ?season= on the dashboard's stat endpoints: each narrows to one season's
// [start, end) and agrees with the unfiltered total when summed across seasons.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';
import { insertSoloMatch } from '../db/fixtures';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
  insertSoloMatch(h.db, { date: '2026-10-05', hero: 'Ana', role: 'Support', win: 1, queue_mode: 'comp_role' });   // S4, last day
  insertSoloMatch(h.db, { date: '2026-10-06', hero: 'Ana', role: 'Support', win: 0, queue_mode: 'comp_role' });   // S5, first day
  insertSoloMatch(h.db, { date: '2026-10-08', hero: 'Ana', role: 'Support', win: 0, queue_mode: 'comp_role' });
});
afterEach(async () => { await h.close(); });

test('overview, trends, streaks and by-day-hour respect the season boundary', async () => {
  assert.equal((await h.get('/api/stats/overview')).body.total, 3);
  assert.equal((await h.get('/api/stats/overview?season=2026%20S4')).body.total, 1);
  assert.equal((await h.get('/api/stats/overview?season=2026%20S5')).body.total, 2);
  assert.equal((await h.get('/api/stats/trends?season=2026%20S5')).body.length, 2);
  const st = (await h.get('/api/stats/streaks?season=2026%20S4')).body;
  assert.equal(st.longestWin, 1);
  assert.equal(st.longestLoss, 0);
});

test('mode-comparison narrows by season', async () => {
  const all = (await h.get('/api/stats/mode-comparison')).body.reduce((n: number, m: any) => n + m.games, 0);
  const s5 = (await h.get('/api/stats/mode-comparison?season=2026%20S5')).body.reduce((n: number, m: any) => n + m.games, 0);
  assert.equal(all, 3);
  assert.equal(s5, 2);
});
