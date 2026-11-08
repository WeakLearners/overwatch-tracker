// Play-trial story S4: every saved match records the advisor pick shown at save
// time and a sens tag. Old rows (no value) stay NULL = unknown.
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
const row = (id: number) => h.db.prepare('SELECT advisor_hero, sens_kind, blind_trial FROM matches WHERE id = ?').get(id) as any;

describe('S4: advisor_hero and sens_kind', () => {
  test('a trial match saves sens_kind trial and the advisor pick', async () => {
    const s = await h.post('/api/blind/sets', { hero: 'Ashe', batch_size: 5, senses: [2.0, 3.0] });
    assert.equal(s.status, 200);
    const r = await log({ advisor_hero: 'Soldier: 76' });
    assert.equal(r.status, 200);
    const m = row(r.body.id);
    assert.equal(m.advisor_hero, 'Soldier: 76');
    assert.equal(m.sens_kind, 'trial');
    assert.equal(m.blind_trial, 1);
  });

  test('no pick shown and no trial: both fields are NULL', async () => {
    const r = await log({});
    const m = row(r.body.id);
    assert.equal(m.advisor_hero, null);
    assert.equal(m.sens_kind, null);
  });

  test('a blank advisor_hero string is stored as NULL', async () => {
    const r = await log({ advisor_hero: '   ' });
    assert.equal(row(r.body.id).advisor_hero, null);
  });

  test('old rows read as unknown and the list route exposes both fields', async () => {
    h.db.prepare(`INSERT INTO matches (date, hero, role, map, game_type, win) VALUES ('2026-01-01','Ashe','DPS','Ilios','comp',1)`).run();
    const r = await h.get('/api/matches?limit=5');
    assert.equal(r.status, 200);
    const old = r.body.rows.find((x: any) => x.date === '2026-01-01');
    assert.ok('advisor_hero' in old && 'sens_kind' in old);
    assert.equal(old.advisor_hero, null);
    assert.equal(old.sens_kind, null);
  });

  test('the v1 export carries both columns for the lab replica', async () => {
    await log({ advisor_hero: 'Mercy' });
    const r = await h.get('/api/v1/export/matches');
    assert.equal(r.status, 200);
    assert.equal(r.body.rows[0].advisor_hero, 'Mercy');
    assert.ok('sens_kind' in r.body.rows[0]);
  });
});
