// Play-trial item 2: the comp control arm. On: comp matches save as home sens and
// are never trials. QP saves the same way (Sean 2026-11-14), but never counts toward the arm or the fit. Off: unchanged.
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
  test('starts off with no sens and 0 of 1620 min', async () => {
    const r = await h.get('/api/control-arm');
    assert.deepEqual(r.body, { on: false, sens: null, dpi: 1600, minutes: 0, waiting: 0, target: 1620 });
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

  test('arm on: a saved match waits for Aim Stats, then counts its play minutes', async () => {
    await h.put('/api/control-arm', { on: true, sens: 3.5 });
    const m = await log({});
    let r = await h.get('/api/control-arm');
    assert.equal(r.body.minutes, 0);
    assert.equal(r.body.waiting, 1);
    h.db.prepare('INSERT INTO aim_stats_heroes (match_id, hero, duration_min) VALUES (?, ?, ?)').run(m.body.id, 'Ashe', 11.5);
    r = await h.get('/api/control-arm');
    assert.equal(r.body.minutes, 11.5);
    assert.equal(r.body.waiting, 0);
    assert.equal(r.body.target, 1620);
  });

  test('arm on: a QP match saves as home at the home sens, with no credit', async () => {
    await makeSet();
    await h.put('/api/control-arm', { on: true, sens: 3.5 });
    const r = await log({ queue_mode: 'qp_role' });
    const m = row(r.body.id);
    assert.equal(m.sens, 3.5);
    assert.equal(m.dpi, 1600);
    assert.equal(m.sens_kind, 'home');
    assert.equal(m.blind_trial, 0);
    assert.equal(m.blind_set_id, null);
    assert.equal(creditCount(), 0);
    assert.equal((await h.get('/api/control-arm')).body.waiting, 0, 'QP does not add to the arm');
    assert.equal((await h.get('/api/aim/pending')).body.total, 0, 'a QP home match is not in the Awaiting Stats list');
  });

  test('arm off: a QP match keeps the stage sens, with no credit and no tag', async () => {
    await makeSet();
    const r = await log({ queue_mode: 'qp_role' });
    const m = row(r.body.id);
    assert.equal(m.sens, 2.0);
    assert.equal(m.sens_kind, null);
    assert.equal(m.blind_trial, 0);
    assert.equal(creditCount(), 0);
  });

  test('the fit rows drop a QP home match and keep a comp home match', async () => {
    await h.put('/api/control-arm', { on: true, sens: 3.5 });
    const addStats = (id: number) => {
      h.db.prepare('INSERT INTO aim_stats (match_id, duration_min) VALUES (?, ?)').run(id, 10);
      h.db.prepare('INSERT INTO aim_stats_heroes (match_id, hero, overall_acc, duration_min) VALUES (?, ?, ?, ?)').run(id, 'Ashe', 40, 10);
    };
    const qp = await log({ queue_mode: 'qp_role' });
    addStats(qp.body.id);
    const nIn = async () => ((await h.get('/api/aim/analysis')).body.byScale as any[]).reduce((n, s) => n + s.n, 0);
    assert.equal(await nIn(), 0);
    const comp = await log({});
    addStats(comp.body.id);
    assert.equal(await nIn(), 1);
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
    assert.equal((await h.get('/api/control-arm')).body.waiting, 0, 'a home match moved to QP no longer counts');
  });

  test('a home match waits in the Awaiting Stats backlog', async () => {
    await h.put('/api/control-arm', { on: true, sens: 3.5 });
    const r = await log({});
    const p = await h.get('/api/aim/pending');
    assert.deepEqual(p.body.rows.map((x: any) => x.id), [r.body.id]);
    assert.equal(p.body.total, 1);
  });

  test('editing a trial match to QP clears its trial tag; an old row stays NULL', async () => {
    await makeSet();
    const t = await log({});
    assert.equal(row(t.body.id).sens_kind, 'trial');
    await h.put(`/api/matches/${t.body.id}`, { queue_mode: 'qp_role' });
    assert.equal(row(t.body.id).sens_kind, null);
    h.db.prepare(`INSERT INTO matches (date, hero, role, map, game_type, win, blind_trial, created_at) VALUES ('2025-01-01','Ashe','DPS','Ilios','comp',1,1,'2025-01-01 00:00:00')`).run();
    const oldId = Number((h.db.prepare('SELECT MAX(id) id FROM matches').get() as any).id);
    await h.put(`/api/matches/${oldId}`, { queue_mode: 'comp_role' });
    assert.equal(row(oldId).sens_kind, null, 'an edit is not a backfill');
  });
});
