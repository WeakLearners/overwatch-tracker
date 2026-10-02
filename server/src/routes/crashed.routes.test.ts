// "Game crashed" matches: result-only records (lib/crashed.ts). Pins the
// exclusion contract end to end over real HTTP: the result counts where
// win/loss is the question, and nowhere a hero or a scoreboard stat is.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';
import { CRASHED_HERO } from '../lib/crashed';

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

const base = { date: '2026-10-02', time: '2026-10-02T08:00:00', hour: 8, map: 'Ilios', game_type: 'Control', queue_mode: 'comp_role' };

async function normal(extra: Record<string, unknown> = {}) {
  const r = await h.post('/api/matches', { ...base, hero: 'Ashe', role: 'DPS', win: true, ...extra });
  assert.equal(r.status, 200);
  return r.body.id as number;
}
async function crashed(extra: Record<string, unknown> = {}) {
  const r = await h.post('/api/matches', { ...base, crashed: true, role: 'DPS', win: false, ...extra });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.id as number;
}
const count = (sql: string, id: number) => Number((h.db.prepare(sql).get(id) as any).n);

describe('logging a crashed match', () => {
  test('writes a result-only row: no heroes, credits, stats, deaths, sens', async () => {
    // an active stage test on Ashe must not touch it, even when a hero is smuggled in
    const set = await h.post('/api/blind/sets', { hero: 'Ashe', batch_size: 5, senses: [2.0, 3.0] });
    assert.equal(set.status, 200);
    const id = await crashed({ hero: 'Ashe', sens: 2.5, feel: 80, match_quality: 'stomp', result_driver: 'me',
      match_deaths: [{ killer: 'Genji', killer_role: 'DPS', ult: false }], heroes: [{ hero: 'Mercy', role: 'Support' }] });
    const row = h.db.prepare('SELECT hero, role, win, crashed, sens, feel, match_quality, result_driver, blind_trial FROM matches WHERE id = ?').get(id) as any;
    assert.equal(row.hero, CRASHED_HERO);
    assert.equal(row.crashed, 1);
    assert.equal(row.role, 'DPS');
    assert.equal(row.win, 0);
    assert.equal(row.sens, null);
    assert.equal(row.feel, null);
    assert.equal(row.match_quality, null);
    assert.equal(row.result_driver, null);
    assert.equal(row.blind_trial, 0);
    assert.equal(count('SELECT COUNT(*) n FROM match_heroes WHERE match_id = ?', id), 0);
    assert.equal(count('SELECT COUNT(*) n FROM blind_credits WHERE match_id = ?', id), 0);
    assert.equal(count('SELECT COUNT(*) n FROM match_deaths WHERE match_id = ?', id), 0);
    assert.equal(count('SELECT COUNT(*) n FROM aim_stats WHERE match_id = ?', id), 0);
  });

  test('needs a real role, a map and a result; hero is not required', async () => {
    assert.equal((await h.post('/api/matches', { ...base, crashed: true, win: true })).status, 400);
    assert.equal((await h.post('/api/matches', { ...base, crashed: true, role: 'DPS' })).status, 400);
    assert.equal((await h.post('/api/matches', { ...base, crashed: true, role: 'Wizard', win: true })).status, 400);
  });

  test('never enters the sens backlog', async () => {
    await h.post('/api/blind/sets', { hero: 'Ashe', batch_size: 5, senses: [2.0, 3.0] });
    const id = await crashed();
    const pending = await h.get('/api/aim/pending');
    assert.equal(pending.status, 200);
    assert.ok(!JSON.stringify(pending.body).includes(`"id":${id},`) && !JSON.stringify(pending.body).includes(`"match_id":${id}`));
  });

  test('rejects aim stats posted against it', async () => {
    const id = await crashed();
    const r = await h.post('/api/aim', { match_id: id, heroes: [{ hero: 'Ashe', duration_min: 8, overall_acc: 40 }] });
    assert.equal(r.status, 400);
    assert.equal(count('SELECT COUNT(*) n FROM aim_stats_heroes WHERE match_id = ?', id), 0);
  });

  test('a restart backfill does not give it a hero row', async () => {
    const id = await crashed();
    const { closeDb } = await import('../db/schema');
    // re-running initSchema (every server start) must leave it hero-less
    const path = (h.db.prepare('PRAGMA database_list').get() as any).file as string;
    closeDb();
    const { getDb } = await import('../db/schema');
    const db = getDb(path);
    assert.equal(Number((db.prepare('SELECT COUNT(*) n FROM match_heroes WHERE match_id = ?').get(id) as any).n), 0);
  });
});

describe('where it counts and where it does not', () => {
  test('overall record, map and hour breakdowns include it', async () => {
    await normal();
    await crashed();
    const o = await h.get('/api/stats/overview');
    assert.equal(o.body.total, 2);
    assert.equal(o.body.wins, 1);
    const byMap = await h.get('/api/stats/by-map');
    assert.equal(byMap.body.find((m: any) => m.map === 'Ilios') ? 1 : 0, 0); // HAVING games >= 3: 2 games is below the floor
    const trends = await h.get('/api/stats/trends');
    assert.equal(trends.body.length, 2);
    const streaks = await h.get('/api/stats/streaks');
    assert.equal(streaks.status, 200);
  });

  test('no by-hero view sees it, and no hero is credited', async () => {
    await normal();
    await crashed();
    // by-hero has a games floor, so push the crashed result well past it: if it were credited it would show
    for (let i = 0; i < 4; i++) await crashed();
    const byHero = await h.get('/api/stats/by-hero');
    assert.ok(!JSON.stringify(byHero.body).includes(CRASHED_HERO));
    const counts = await h.get('/api/stats/hero-counts?date=2026-10-02');
    assert.ok(JSON.stringify(counts.body).includes('Ashe'));
    assert.ok(!JSON.stringify(counts.body).includes(CRASHED_HERO));
    const cards = await h.get('/api/stats/hero-cards');
    assert.ok(!JSON.stringify(cards.body).includes(CRASHED_HERO));
    assert.equal((await h.get('/api/stats/overview')).body.heroes_played, 1);
  });

  test('field splits ignore it (study fields are null on it by design)', async () => {
    await normal({ match_quality: 'stomp' });
    await crashed();
    const r = await h.get('/api/stats/split?by=match_quality');
    assert.equal(r.status, 200);
    assert.equal(r.body.unasked, 0);
    assert.equal(r.body.groups.reduce((a: number, g: any) => a + g.n, 0), 1);
  });

  test('sens analysis timeline omits it', async () => {
    await normal();
    await crashed();
    const a = await h.get('/api/aim/analysis');
    assert.equal(a.status, 200);
    assert.ok(!JSON.stringify(a.body).includes(CRASHED_HERO));
  });

  test('role timer counts it as competitive time at the average match length', async () => {
    // one match with recorded minutes sets the average at 10
    const id = await normal();
    h.db.prepare('INSERT INTO aim_stats (match_id) VALUES (?)').run(id);
    h.db.prepare('INSERT INTO aim_stats_heroes (match_id, hero, duration_min, overall_acc) VALUES (?, ?, 10, 40)').run(id, 'Ashe');
    await crashed({ time: '2026-10-02T09:00:00' });
    const t = await h.get('/api/role-timer');
    assert.equal(t.body.matches, 2);
    assert.equal(t.body.recordedMin, 10);
    assert.equal(t.body.estimatedMin, 10);
    assert.equal(t.body.totalMin, 20);
  });
});

describe('editing a crashed match', () => {
  test('result and context edit; hero, sens, roster, deaths and credits do not', async () => {
    await h.post('/api/blind/sets', { hero: 'Ashe', batch_size: 5, senses: [2.0, 3.0] });
    const id = await crashed();
    const r = await h.put(`/api/matches/${id}`, {
      win: true, map: 'Lijiang Tower', hero: 'Ashe', sens: 3, queue_mode: 'comp_role',
      heroes: [{ hero: 'Mercy', role: 'Support' }], match_deaths: [{ killer: 'Genji', killer_role: 'DPS', ult: false }],
    });
    assert.equal(r.status, 200);
    const row = h.db.prepare('SELECT hero, win, map, sens FROM matches WHERE id = ?').get(id) as any;
    assert.equal(row.win, 1);
    assert.equal(row.map, 'Lijiang Tower');
    assert.equal(row.hero, CRASHED_HERO);
    assert.equal(row.sens, null);
    assert.equal(count('SELECT COUNT(*) n FROM match_heroes WHERE match_id = ?', id), 0);
    assert.equal(count('SELECT COUNT(*) n FROM match_deaths WHERE match_id = ?', id), 0);
    assert.equal(count('SELECT COUNT(*) n FROM blind_credits WHERE match_id = ?', id), 0);
  });
});
