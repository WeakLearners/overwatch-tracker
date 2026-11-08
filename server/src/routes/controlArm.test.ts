// Play-trial item 2: the comp control arm. On: comp matches save as home sens and
// are never trials. QP still gets the blind trial's test sens. Off: unchanged.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

const log = (body: Record<string, unknown>) => h.post('/api/matches', {
  date: '2026-11-08', time: '12:00', hour: 12, map: 'Ilios', game_type: 'comp', win: true,
  queue_mode: 'comp_role', hero: 'Ashe', role: 'DPS', ...body,
});
const row = (id: number) => h.db.prepare('SELECT sens, dpi, blind_trial, blind_set_id, sens_kind, queue_mode FROM matches WHERE id = ?').get(id) as any;
const creditCount = () => Number((h.db.prepare('SELECT COUNT(*) n FROM blind_credits').get() as any).n);
const makeSet = async () => {
  const s = await h.post('/api/blind/sets', { hero: 'Ashe', batch_size: 5, senses: [2.0, 3.0] });
  assert.equal(s.status, 200);
};

describe('control arm settings', () => {
  test('starts off with no sens and n 0 of 150', async () => {
    const r = await h.get('/api/control-arm');
    assert.deepEqual(r.body, { on: false, sens: null, dpi: 1600, n: 0, target: 150 });
  });

  test('cannot turn on without a home sens', async () => {
    const r = await h.put('/api/control-arm', { on: true });
    assert.equal(r.status, 400);
    assert.equal((await h.get('/api/control-arm')).body.on, false);
  });

  test('rejects a bad sens and a non-boolean on', async () => {
    assert.equal((await h.put('/api/control-arm', { on: true, sens: -1 })).status, 400);
    assert.equal((await h.put('/api/control-arm', { on: true, sens: 500 })).status, 400);
    assert.equal((await h.put('/api/control-arm', { on: 'yes', sens: 3 })).status, 400);
  });

  test('saves the sens and keeps it when the arm is turned off', async () => {
    await h.put('/api/control-arm', { on: true, sens: 3.25 });
    const off = await h.put('/api/control-arm', { on: false });
    assert.equal(off.body.on, false);
    assert.equal(off.body.sens, 3.25);
  });
});

describe('control arm: saving matches', () => {
  test('arm on: a comp match saves as home at the home sens and is not a trial', async () => {
    await makeSet();
    await h.put('/api/control-arm', { on: true, sens: 3.5 });
    const r = await log({});
    const m = row(r.body.id);
    assert.equal(m.sens_kind, 'home');
    assert.equal(m.sens, 3.5);
    assert.equal(m.dpi, 1600);
    assert.equal(m.blind_trial, 0);
    assert.equal(m.blind_set_id, null);
    assert.equal(creditCount(), 0);
  });

  test('arm on: the page count goes to 1 of 150', async () => {
    await h.put('/api/control-arm', { on: true, sens: 3.5 });
    await log({});
    const r = await h.get('/api/control-arm');
    assert.equal(r.body.n, 1);
    assert.equal(r.body.target, 150);
  });

  test('arm on: a QP match still gets the trial sens and is not tagged home', async () => {
    await makeSet();
    await h.put('/api/control-arm', { on: true, sens: 3.5 });
    const r = await log({ queue_mode: 'qp_role' });
    const m = row(r.body.id);
    assert.equal(m.sens, 2.0);
    assert.equal(m.sens_kind, null);
    assert.equal(creditCount(), 0);
    assert.equal((await h.get('/api/control-arm')).body.n, 0);
  });

  test('arm off: a comp match is a trial again', async () => {
    await makeSet();
    await h.put('/api/control-arm', { on: true, sens: 3.5 });
    await h.put('/api/control-arm', { on: false });
    const r = await log({});
    const m = row(r.body.id);
    assert.equal(m.sens_kind, 'trial');
    assert.equal(m.blind_trial, 1);
    assert.equal(m.sens, 2.0);
    assert.equal(creditCount(), 1);
  });

  test('a home match gets no credit when its aim stats are saved later', async () => {
    await makeSet();
    await h.put('/api/control-arm', { on: true, sens: 3.5 });
    const r = await log({});
    h.db.prepare('INSERT INTO aim_stats_heroes (match_id, hero, duration_min) VALUES (?, ?, ?)').run(r.body.id, 'Ashe', 12);
    const { experimentController } = await import('../experiments/controller');
    experimentController.onAimStatsSaved(h.db, r.body.id);
    assert.equal(creditCount(), 0);
    assert.equal(row(r.body.id).blind_trial, 0);
  });

  test('editing a home match to another queue does not re-stamp its sens or credit it', async () => {
    await makeSet();
    await h.put('/api/control-arm', { on: true, sens: 3.5 });
    const r = await log({});
    const e = await h.put(`/api/matches/${r.body.id}`, { queue_mode: 'qp_role' });
    assert.equal(e.status, 200);
    const m = row(r.body.id);
    assert.equal(m.sens, 3.5);
    assert.equal(m.sens_kind, 'home');
    assert.equal(creditCount(), 0);
  });
});
