// Hero focus trial over HTTP: start, lock, early end with a reason, off-roster flag, block change.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

const today = new Date().toISOString().slice(0, 10);
// Seed comp history directly (the live DB is never touched; this is a temp file).
function seed(role: string, hero: string, n: number, wins: number) {
  const ins = h.db.prepare(`INSERT INTO matches (date, hero, role, map, game_type, win, queue_mode, crashed) VALUES (?, ?, ?, 'Ilios', 'comp', ?, 'comp_role', 0)`);
  for (let i = 0; i < n; i++) ins.run(today, hero, role, i < wins ? 1 : 0);
}
function seedHistory() {
  seed('Tank', 'Reinhardt', 60, 33); seed('Tank', 'Orisa', 40, 18);
  seed('DPS', 'Ashe', 80, 44); seed('DPS', 'Cassidy', 50, 24); seed('DPS', 'Sojourn', 35, 10);
  seed('Support', 'Mercy', 70, 38); seed('Support', 'Ana', 45, 21);
}
const log = (body: Record<string, unknown>) => h.post('/api/matches', {
  date: today, time: '12:00', hour: 12, map: 'Ilios', game_type: 'comp', win: true,
  queue_mode: 'comp_role', hero: 'Ashe', role: 'DPS', ...body,
});
const row = (id: number) => h.db.prepare('SELECT hero, off_roster, advisor_hero FROM matches WHERE id = ?').get(id) as any;

describe('start and lock', () => {
  test('with no trial the state shows a preview roster of 2 per role and the rule', async () => {
    seedHistory();
    const r = await h.get('/api/hero-focus');
    assert.equal(r.body.trial, null);
    assert.equal(r.body.preview.roster.length, 6);
    assert.ok(r.body.rule.text.includes('30'));
  });

  test('start saves the roster the server chose; a second start is refused; no route edits it', async () => {
    seedHistory();
    const s = await h.post('/api/hero-focus/start', {});
    assert.equal(s.status, 200);
    assert.equal(s.body.trial.status, 'active');
    assert.equal(s.body.trial.roster.length, 6);
    assert.deepEqual(s.body.trial.roster.filter((x: any) => x.role === 'Tank').map((x: any) => x.hero).sort(), ['Orisa', 'Reinhardt']);
    // A client-sent roster is ignored.
    const again = await h.post('/api/hero-focus/start', { roster: ['Genji'] });
    assert.equal(again.status, 409);
    assert.equal((await h.put('/api/hero-focus', { roster: [] })).status, 404);
    assert.equal((await h.get('/api/hero-focus')).body.trial.roster.length, 6);
  });

  test('start is refused when a role has no comp history at all', async () => {
    seed('DPS', 'Ashe', 40, 20);
    const s = await h.post('/api/hero-focus/start', {});
    assert.equal(s.status, 409);
  });
});

describe('early end', () => {
  test('needs a reason, then ends, is logged on the trial, and the hold is released', async () => {
    seedHistory();
    await h.post('/api/hero-focus/start', {});
    assert.equal((await h.post('/api/hero-focus/end', {})).status, 400);
    assert.equal((await h.post('/api/hero-focus/end', { reason: '  ' })).status, 400);
    const e = await h.post('/api/hero-focus/end', { reason: 'tilted, need a break' });
    assert.equal(e.status, 200);
    assert.equal(e.body.trial.status, 'ended');
    assert.equal(e.body.trial.endReason, 'tilted, need a break');
    assert.ok(e.body.trial.endedAt);
    // Off-roster hero now saves with no confirm and no flag.
    const r = await log({ hero: 'Sojourn' });
    assert.equal(r.status, 200);
    assert.equal(row(r.body.id).off_roster, null);
    // And a new trial can start.
    assert.equal((await h.post('/api/hero-focus/start', {})).status, 200);
  });

  test('ending with no running trial is refused', async () => {
    assert.equal((await h.post('/api/hero-focus/end', { reason: 'nothing to end' })).status, 400);
  });
});

describe('off-roster hold', () => {
  test('a roster hero saves with off_roster 0; an off-roster hero needs the confirm and saves with 1', async () => {
    seedHistory();
    await h.post('/api/hero-focus/start', {});
    const on = await log({ hero: 'Ashe' });
    assert.equal(on.status, 200);
    assert.equal(row(on.body.id).off_roster, 0);

    const refused = await log({ hero: 'Sojourn' });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'off_roster_unconfirmed');

    const ok = await log({ hero: 'Sojourn', off_roster: true });
    assert.equal(ok.status, 200);
    assert.equal(row(ok.body.id).off_roster, 1);
    const st = (await h.get('/api/hero-focus')).body.trial;
    assert.equal(st.offRoster, 1);
    assert.equal(st.waiting, 2);
    assert.equal(st.minutes, 0);
  });

  test('QP is never limited and never flagged', async () => {
    seedHistory();
    await h.post('/api/hero-focus/start', {});
    const r = await log({ hero: 'Sojourn', queue_mode: 'qp_role' });
    assert.equal(r.status, 200);
    assert.equal(row(r.body.id).off_roster, null);
    assert.equal((await h.get('/api/hero-focus')).body.trial.minutes, 0);
  });

  test('the saved advisor_hero is the block pick for the hero role, not the client value', async () => {
    seedHistory();
    const s = await h.post('/api/hero-focus/start', {});
    const pick = s.body.trial.picks.DPS;
    const r = await log({ hero: 'Ashe', advisor_hero: 'Genji' });
    assert.equal(row(r.body.id).advisor_hero, pick);
  });
});

// Minutes arrive with the Aim Stats form: one aim_stats_heroes row per hero played.
function playMatch(hero: string, role: string, minutes: number | null, withAim = true) {
  const id = Number(h.db.prepare(`INSERT INTO matches (date, hero, role, map, game_type, win, queue_mode, crashed) VALUES (?, ?, ?, 'Ilios', 'comp', 1, 'comp_role', 0)`).run(today, hero, role).lastInsertRowid);
  if (withAim) h.db.prepare('INSERT INTO aim_stats_heroes (match_id, hero, duration_min) VALUES (?, ?, ?)').run(id, hero, minutes);
  return id;
}

describe('blocks (play minutes)', () => {
  test('a block is 60 role-hero minutes: the pick holds, overflow is dropped, the pick flips at close', async () => {
    seedHistory();
    const s = await h.post('/api/hero-focus/start', {});
    const t0 = s.body.trial;
    const first = t0.picks.DPS;
    const other = t0.roster.filter((x: any) => x.role === 'DPS' && x.hero !== first)[0].hero;
    assert.equal(t0.target, 2160);
    assert.equal(t0.blockMinutes, 60);
    assert.equal(t0.blocks, 36);
    playMatch('Ashe', 'DPS', 50);
    let t = (await h.get('/api/hero-focus')).body.trial;
    assert.equal(t.picks.DPS, first);
    assert.equal(t.roles.DPS.openMinutes, 50);
    assert.equal(t.minutes, 50);
    playMatch('Ashe', 'DPS', 25);              // 75 -> closes block 1, 15 overflow dropped
    t = (await h.get('/api/hero-focus')).body.trial;
    assert.equal(t.roles.DPS.closedBlocks, 1);
    assert.equal(t.roles.DPS.openMinutes, 0);
    assert.equal(t.picks.DPS, other);
    assert.equal(t.roles.Tank.block, 1, 'another role has its own clock');
    assert.equal(t.minutes, 75, 'the trial total counts every minute, overflow included');
  });

  test('off-roster minutes count toward the total but not toward a role block; a match with no aim row waits', async () => {
    seedHistory();
    await h.post('/api/hero-focus/start', {});
    playMatch('Sojourn', 'DPS', 40);           // off roster
    playMatch('Ashe', 'DPS', 0, false);        // no Aim Stats yet
    const t = (await h.get('/api/hero-focus')).body.trial;
    assert.equal(t.minutes, 40);
    assert.equal(t.roles.DPS.openMinutes, 0);
    assert.equal(t.waiting, 1);
  });

  test('the advisor shows the block picks in comp and makes no model call', async () => {
    seedHistory();
    const s = await h.post('/api/hero-focus/start', {});
    const r = await h.get('/api/advisor/recommend?map=Ilios&queue_mode=comp_role');
    assert.equal(r.status, 200);
    assert.equal(r.body.DPS.primary, s.body.trial.picks.DPS);
    assert.equal(r.body.DPS.focus, true);
    assert.equal(r.body.Support.primary, s.body.trial.picks.Support);
    const qp = await h.get('/api/advisor/recommend?map=Ilios&queue_mode=qp_role');
    assert.notEqual(qp.body.DPS?.focus, true, 'QP keeps the normal advisor');
  });

  test('the trial completes at 2160 minutes and releases the hold', async () => {
    seedHistory();
    await h.post('/api/hero-focus/start', {});
    for (let i = 0; i < 36; i++) playMatch('Ashe', 'DPS', 60);
    const st = (await h.get('/api/hero-focus')).body.trial;
    assert.equal(st.status, 'complete');
    assert.equal(st.minutes, 2160);
    assert.equal((await log({ hero: 'Sojourn' })).status, 200);
  });
});
