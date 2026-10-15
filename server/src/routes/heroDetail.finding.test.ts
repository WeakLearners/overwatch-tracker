// /api/stats/hero-detail attaches a Finding to every map and mode row.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';
import { insertSoloMatch } from '../db/fixtures';

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

function add(map: string, wins: number, losses: number) {
  for (let i = 0; i < wins + losses; i++) {
    insertSoloMatch(h.db, { date: '2026-10-05', hero: 'Ana', role: 'Support', win: i < wins ? 1 : 0, map, queue_mode: 'comp_role' } as any);
  }
}

test('map rows carry a finding; the Bonferroni count is the testable maps', async () => {
  add('Numbani', 18, 2);       // 20 games, strong
  add('Hanamura', 5, 15);      // 20 games, weak
  add('Dorado', 2, 1);         // 3 games: listed, too few to test
  const body = (await h.get('/api/stats/hero-detail/Ana')).body;
  const rows = [...body.bestMaps, ...body.worstMaps];
  const numbani = rows.find((m: any) => m.map === 'Numbani');
  const dorado = rows.find((m: any) => m.map === 'Dorado');
  assert.equal(numbani.finding.n, 20);
  assert.equal(numbani.finding.groupsTested, 2);
  assert.equal(numbani.finding.verdict, 'holds');
  assert.equal(dorado.finding.verdict, 'thin');
  assert.equal(dorado.finding.p, null);
});

test('mode rows carry a finding', async () => {
  add('Numbani', 12, 8);
  const body = (await h.get('/api/stats/hero-detail/Ana')).body;
  assert.ok(body.bestType.finding);
  assert.equal(body.bestType.finding.n, body.bestType.games);
});
