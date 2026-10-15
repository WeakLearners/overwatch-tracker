// /api/stats/prematch attaches a Finding to each byHero row: the hero against
// the games on the other heroes in the same scope.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';
import { insertSoloMatch } from '../db/fixtures';

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

function add(hero: string, role: string, map: string, wins: number, losses: number) {
  for (let i = 0; i < wins + losses; i++) {
    insertSoloMatch(h.db, { date: '2026-10-01', hero, role, win: i < wins ? 1 : 0, map, queue_mode: 'comp_role' } as any);
  }
}

test('a hero far above the rest holds up; a thin hero is not tested', async () => {
  add('Ana', 'Support', 'Numbani', 18, 2);
  add('Mercy', 'Support', 'Numbani', 5, 15);
  add('Lucio', 'Support', 'Numbani', 3, 1);
  const rows = (await h.get('/api/stats/prematch?map=Numbani')).body.byHero;
  const ana = rows.find((r: any) => r.hero === 'Ana');
  const lucio = rows.find((r: any) => r.hero === 'Lucio');
  assert.equal(ana.finding.verdict, 'holds');
  assert.equal(ana.finding.n, 20);
  assert.equal(ana.finding.groupsTested, 2);
  assert.equal(lucio.finding.verdict, 'thin');
  assert.equal(lucio.finding.p, null);
});

test('the scope follows the map filter', async () => {
  add('Ana', 'Support', 'Numbani', 18, 2);
  add('Mercy', 'Support', 'Numbani', 5, 15);
  add('Ana', 'Support', 'Busan', 1, 9);
  add('Mercy', 'Support', 'Busan', 9, 1);
  const rows = (await h.get('/api/stats/prematch?map=Busan')).body.byHero;
  const ana = rows.find((r: any) => r.hero === 'Ana');
  assert.equal(ana.finding.n, 10);
  assert.notEqual(ana.finding.verdict, 'thin');
});
