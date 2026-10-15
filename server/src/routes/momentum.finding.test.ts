// /api/stats/momentum attaches a Finding to each established hero: the last
// 30 days against the 90 days before.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';
import { insertSoloMatch } from '../db/fixtures';

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

function daysAgo(n: number): string {
  const d = new Date(); d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
}
function add(hero: string, role: string, daysBack: number, wins: number, losses: number) {
  for (let i = 0; i < wins + losses; i++) {
    insertSoloMatch(h.db, { date: daysAgo(daysBack), hero, role, win: i < wins ? 1 : 0, map: 'Numbani', queue_mode: 'comp_role' } as any);
  }
}

test('a real climb holds up; a small one with thin windows does not', async () => {
  add('Ana', 'Support', 60, 4, 16);   // prior: 20 games, 20%
  add('Ana', 'Support', 5, 17, 3);    // recent: 20 games, 85%
  add('Mercy', 'Support', 60, 3, 2);  // prior: 5 games (baseline ok, too few to test)
  add('Mercy', 'Support', 5, 4, 1);   // recent: 5 games
  const rows = (await h.get('/api/stats/momentum')).body.byHero;
  const ana = rows.find((r: any) => r.hero === 'Ana');
  const mercy = rows.find((r: any) => r.hero === 'Mercy');
  assert.equal(ana.finding.verdict, 'holds');
  assert.equal(ana.finding.n, 20);
  assert.equal(ana.finding.groupsTested, 1);
  assert.equal(mercy.finding.verdict, 'thin');
  assert.equal(mercy.finding.p, null);
});

test('a hero with no prior baseline carries no finding', async () => {
  add('Lucio', 'Support', 5, 6, 4);
  const lucio = (await h.get('/api/stats/momentum')).body.byHero.find((r: any) => r.hero === 'Lucio');
  assert.equal(lucio.is_new, 1);
  assert.equal(lucio.finding, undefined);
});
