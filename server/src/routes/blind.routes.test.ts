// Tier 3: stage-advance semantics over real HTTP (see test/httpHarness.ts).
//
// This suite exists to chase one specific anomaly: stage sets that moved on
// with only 1–3 games credited to the stage they left. Tier 2 proved the READ
// path is innocent — blind.ts and nightlyReport.ts agree on clean fixtures and
// the anomaly did not reproduce there. So it had to be the write path, and it
// is. Three defects were found here, all reproduced first as `BUG:` tests and
// then fixed on 2026-09-12 once Sean ruled on the study-design question behind
// them. The assertions below now pin the FIXED behavior; the history is kept in
// the comments because the failure modes are subtle and worth not relearning.
//
//   1 — POST /api/blind/advance had no batch guard at all. It checked that the
//   set was active and that a next stage existed, then incremented cur_rel.
//   Whether the stage being abandoned got its batch_size games was never
//   consulted, even though GET /api/blind/state already computes exactly that
//   (`needSwitch`) to drive the button. The UI knew; the endpoint didn't ask.
//   Now it refuses, and `force` is the deliberate way through.
//
//   2 — retirement fired on the TOTAL credit count (batch_size * n_stages), not
//   on every stage individually. A 2-stage/batch-5 set that took 2 games on
//   stage 1 and 8 on stage 2 reached 10 and was marked `completed: true`. Ten
//   games were played, so the total was honest — but it is not the 5-vs-5
//   comparison the set was created to run, and nothing downstream was told the
//   difference. Completion is per stage now (blind.ts isSetComplete).
//
//   3 — retirement was a one-way UPDATE. Deleting a match out of a finished set
//   dropped it below target and left it shut, so it could neither be advanced
//   (409, inactive) nor credited (findActiveStage skips inactive sets). The
//   flag is derived from the credits in both directions now (syncSetActive).
//
// The four historically uneven live sets — 15, 16, 85 Cassidy, 86 Reaper — are
// grandfathered closed via blind_stage_sets.legacy_closed rather than springing
// back to life under the new rule; see that column's note in schema.ts.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';

let h: Harness;

beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

// Logs n competitive matches on one hero through the real POST /api/matches —
// the only path that writes blind_credits. Alternating win/loss so no test
// accidentally depends on an all-wins fixture.
async function playGames(hero: string, n: number) {
  for (let i = 0; i < n; i++) {
    const r = await h.post('/api/matches', {
      date: '2026-09-12', time: '12:00', hour: 12, hero, role: 'DPS',
      map: 'Ilios', game_type: 'comp', win: i % 2 === 0, queue_mode: 'comp_role',
    });
    assert.equal(r.status, 200, `match ${i + 1} failed to log: ${JSON.stringify(r.body)}`);
  }
}

async function makeSet(opts: { hero?: string | null; batch_size?: number; senses?: number[] } = {}) {
  const r = await h.post('/api/blind/sets', {
    hero: opts.hero ?? 'Ashe',
    batch_size: opts.batch_size ?? 5,
    senses: opts.senses ?? [2.0, 3.0],
  });
  assert.equal(r.status, 200, `set creation failed: ${JSON.stringify(r.body)}`);
  return r.body.set_id as number;
}

const stateOf = async (setId: number) => {
  const { body } = await h.get('/api/blind/state');
  return body.actives.find((a: any) => a.set_id === setId) ?? null;
};

// node:sqlite hands back null-prototype row objects, which deepStrictEqual
// refuses to match against plain object literals even when every key and value
// is identical. Rebuild each row as a plain object so the assertions below can
// compare the whole distribution at once rather than field by field.
const creditsByStage = (setId: number): { stage_index: number; n: number }[] =>
  (h.db.prepare('SELECT stage_index, COUNT(*) n FROM blind_credits WHERE blind_set_id = ? GROUP BY stage_index ORDER BY stage_index')
    .all(setId) as unknown as { stage_index: number; n: number }[])
    .map(r => ({ stage_index: Number(r.stage_index), n: Number(r.n) }));

describe('POST /api/blind/advance — batch completion', () => {
  test('refuses to advance with ZERO games on the current stage', async () => {
    const setId = await makeSet();
    const before = await stateOf(setId);
    assert.equal(before.games_on_stage, 0);
    assert.equal(before.needSwitch, false, 'state says no switch is due');

    const r = await h.post('/api/blind/advance', { set_id: setId });
    assert.equal(r.status, 409, 'the endpoint now asks the same question the UI does');
    assert.match(r.body.error, /not finished/);
    assert.equal(r.body.games_on_stage, 0);
    assert.equal(r.body.batch_size, 5);
    assert.equal((await stateOf(setId)).cur_stage, 1, 'still on stage 1');
  });

  test('refuses mid-batch at 2 of 5', async () => {
    const setId = await makeSet({ batch_size: 5 });
    await playGames('Ashe', 2);

    const before = await stateOf(setId);
    assert.equal(before.games_on_stage, 2);
    assert.equal(before.needSwitch, false);

    const r = await h.post('/api/blind/advance', { set_id: setId });
    assert.equal(r.status, 409);
    assert.equal(r.body.games_on_stage, 2);
    assert.deepEqual(creditsByStage(setId), [{ stage_index: 1, n: 2 }], 'nothing moved');
  });

  test('allows the advance at exactly batch_size', async () => {
    const setId = await makeSet({ batch_size: 5 });
    await playGames('Ashe', 5);
    const r = await h.post('/api/blind/advance', { set_id: setId });
    assert.equal(r.status, 200);
    assert.equal(r.body.cur_stage, 2);
    assert.equal(r.body.sens, 3);
  });

  test('force bails out of a short stage, and marks it abandoned', async () => {
    const setId = await makeSet({ batch_size: 5 });
    await playGames('Ashe', 2);

    const r = await h.post('/api/blind/advance', { set_id: setId, force: true });
    assert.equal(r.status, 200, 'the deliberate escape hatch still works');
    assert.equal(r.body.cur_stage, 2);

    const stage1 = h.db.prepare('SELECT abandoned FROM blind_stages WHERE set_id = ? AND stage_index = 1')
      .get(setId) as { abandoned: number };
    assert.equal(Number(stage1.abandoned), 1, 'the shortfall is on the record, not swallowed');
  });

  test('a force-abandoned stage never refills — later games credit only cur_rel', async () => {
    const setId = await makeSet({ batch_size: 5 });
    await playGames('Ashe', 2);
    await h.post('/api/blind/advance', { set_id: setId, force: true });
    await playGames('Ashe', 3);

    // This irreversibility is why the guard has to be a refusal rather than a
    // warning. If an early advance merely deferred games, the stage would catch
    // up later. It cannot: findActiveStage credits cur_rel and cur_rel only
    // moves up.
    assert.deepEqual(creditsByStage(setId), [
      { stage_index: 1, n: 2 },
      { stage_index: 2, n: 3 },
    ]);
  });

  test('a 2/8 split is NOT complete on the total alone — every stage has to be finished', async () => {
    const setId = await makeSet({ batch_size: 5, senses: [2.0, 3.0] });
    await playGames('Ashe', 2);
    // Unforced, so stage 1 is short but NOT marked abandoned — this is the
    // shape the old code produced, minus the guard, and the one the old rule
    // called finished.
    await h.post('/api/blind/advance', { set_id: setId, force: true });
    h.db.prepare('UPDATE blind_stages SET abandoned = 0 WHERE set_id = ?').run(setId);
    await playGames('Ashe', 8);

    const { body } = await h.get('/api/blind/sets');
    const set = body.sets.find((s: any) => s.set_id === setId);
    assert.equal(set.totalGames, 10, '2 + 8 = batch_size * n_stages, which used to be enough');
    assert.equal(set.completed, false, 'but stage 1 only ever saw 2 of its 5');
    assert.equal(set.active, true, 'so it stays open rather than reporting a result it never ran');
    assert.deepEqual(creditsByStage(setId), [
      { stage_index: 1, n: 2 },
      { stage_index: 2, n: 8 },
    ]);
  });

  test('an abandoned stage does let the set finish — otherwise it would block the hero forever', async () => {
    const setId = await makeSet({ batch_size: 5, senses: [2.0, 3.0] });
    await playGames('Ashe', 2);
    await h.post('/api/blind/advance', { set_id: setId, force: true });
    await playGames('Ashe', 5);

    const { body } = await h.get('/api/blind/sets');
    const set = body.sets.find((s: any) => s.set_id === setId);
    assert.equal(set.completed, true, 'stage 1 was written off on purpose; stage 2 is full');
    assert.equal(set.active, false, 'retires, freeing Ashe for a new test');
    // The shortfall is still legible — the count is real and the flag is set.
    assert.deepEqual(creditsByStage(setId), [
      { stage_index: 1, n: 2 },
      { stage_index: 2, n: 5 },
    ]);
  });

  test('an evenly played set completes and retires', async () => {
    const setId = await makeSet({ batch_size: 5 });
    await playGames('Ashe', 5);
    const mid = await stateOf(setId);
    assert.equal(mid.needSwitch, true, 'switch is due at exactly batch_size');
    await h.post('/api/blind/advance', { set_id: setId });
    await playGames('Ashe', 5);

    const { body } = await h.get('/api/blind/sets');
    const set = body.sets.find((s: any) => s.set_id === setId);
    assert.equal(set.completed, true);
    assert.equal(set.active, false);
    assert.equal(set.totalGames, 10);
    assert.deepEqual(creditsByStage(setId), [
      { stage_index: 1, n: 5 },
      { stage_index: 2, n: 5 },
    ]);
  });

  test('refuses to advance past the last stage', async () => {
    const setId = await makeSet({ batch_size: 5, senses: [2.0, 3.0] });
    assert.equal((await h.post('/api/blind/advance', { set_id: setId, force: true })).status, 200);
    const r = await h.post('/api/blind/advance', { set_id: setId, force: true });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /last stage/, 'the last-stage check runs before the batch check');
  });

  test('refuses an unknown set id', async () => {
    const r = await h.post('/api/blind/advance', { set_id: 9999 });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /no such active set/);
  });

  test('refuses a retired set — advance is gated on active, just not on batch', async () => {
    const setId = await makeSet({ batch_size: 5 });
    await playGames('Ashe', 5);
    await h.post('/api/blind/advance', { set_id: setId });
    await playGames('Ashe', 5);
    const r = await h.post('/api/blind/advance', { set_id: setId });
    assert.equal(r.status, 409, 'the set retired, so this is refused for the one reason that IS checked');
  });
});

describe('GET /api/blind/state — needSwitch boundary', () => {
  // needSwitch is the signal the advance endpoint should be consulting and
  // isn't. Pinning its boundary makes the gap concrete: the correct answer is
  // already computed one HTTP call away.
  test('false at batch_size - 1', async () => {
    const setId = await makeSet({ batch_size: 5 });
    await playGames('Ashe', 4);
    assert.equal((await stateOf(setId)).needSwitch, false);
  });

  test('true at exactly batch_size', async () => {
    const setId = await makeSet({ batch_size: 5 });
    await playGames('Ashe', 5);
    assert.equal((await stateOf(setId)).needSwitch, true);
  });

  test('false once the set is complete — nothing left to switch to', async () => {
    const setId = await makeSet({ batch_size: 5 });
    await playGames('Ashe', 5);
    await h.post('/api/blind/advance', { set_id: setId });
    await playGames('Ashe', 4);
    assert.equal((await stateOf(setId)).needSwitch, false, '4 of 5 on the last stage');
    await playGames('Ashe', 1);
    assert.equal(await stateOf(setId), null, 'retired at the target rather than flagging a switch');
  });
});

describe('set retirement is derived, in both directions', () => {
  // Play a 2-stage/batch-5 set all the way through, evenly.
  async function finishedSet() {
    const setId = await makeSet({ batch_size: 5 });
    await playGames('Ashe', 5);
    await h.post('/api/blind/advance', { set_id: setId });
    await playGames('Ashe', 5);
    assert.equal(await stateOf(setId), null, 'retired at 10');
    return setId;
  }

  test('deleting a credited match reopens the set', async () => {
    const setId = await finishedSet();

    const lastId = (h.db.prepare('SELECT MAX(id) id FROM matches').get() as { id: number }).id;
    assert.equal((await h.del(`/api/matches/${lastId}`)).status, 200);

    const { body } = await h.get('/api/blind/sets');
    const set = body.sets.find((s: any) => s.set_id === setId);
    assert.equal(set.totalGames, 9);
    assert.equal(set.completed, false, 'no longer meets its own completion rule');
    // ...and the active flag follows it back. Retirement used to be a one-way
    // UPDATE with no inverse, which left the set permanently unfinishable: it
    // could never be advanced (409, inactive) and never be credited again
    // (findActiveStage skips inactive sets). That is the most likely history
    // behind live set 86 (Reaper, 5+1 of 10) — retired legitimately at 10, then
    // had matches deleted.
    assert.equal(set.active, true);
    assert.equal((await stateOf(setId)).games_on_stage, 4, 'back on stage 2, one short');
  });

  test('a reopened set can be played to completion again', async () => {
    const setId = await finishedSet();
    const lastId = (h.db.prepare('SELECT MAX(id) id FROM matches').get() as { id: number }).id;
    await h.del(`/api/matches/${lastId}`);

    await playGames('Ashe', 1);
    assert.equal(await stateOf(setId), null, 'closes again on its own');
    assert.deepEqual(creditsByStage(setId), [
      { stage_index: 1, n: 5 },
      { stage_index: 2, n: 5 },
    ]);
  });

  test('a set does NOT reopen if a newer set already owns the hero', async () => {
    const oldId = await finishedSet();
    const newId = await makeSet({ batch_size: 5 });   // only allowed because oldId retired

    const lastId = (h.db.prepare('SELECT MAX(id) id FROM matches').get() as { id: number }).id;
    await h.del(`/api/matches/${lastId}`);

    // Reopening would leave two active Ashe sets and findActiveStage no way to
    // choose between them. The newer one keeps the slot.
    const { body } = await h.get('/api/blind/sets');
    assert.equal(body.sets.find((s: any) => s.set_id === oldId).active, false);
    assert.equal(body.sets.find((s: any) => s.set_id === newId).active, true);
  });

  test('a legacy_closed set stays closed no matter what its stages say', async () => {
    // The grandfathering decision, in one assertion: the four uneven live sets
    // (15, 16, 85 Cassidy, 86 Reaper) keep reading as completed instead of
    // coming back to ask for games nothing downstream would read.
    const setId = await makeSet({ batch_size: 5 });
    await playGames('Ashe', 2);
    h.db.prepare('UPDATE blind_stage_sets SET active = 0, legacy_closed = 1 WHERE id = ?').run(setId);

    const { body } = await h.get('/api/blind/sets');
    const set = body.sets.find((s: any) => s.set_id === setId);
    assert.equal(set.totalGames, 2, 'nowhere near its target');
    assert.equal(set.completed, true);
    assert.equal(set.active, false);

    const lastId = (h.db.prepare('SELECT MAX(id) id FROM matches').get() as { id: number }).id;
    await h.del(`/api/matches/${lastId}`);
    assert.equal(await stateOf(setId), null, 'a deletion does not wake it either');
  });
});

// GET /api/blind/sets/:id — per-stage accuracy summary excludes QP-credited
// rows (Sean's decision 2026-09-23, lib/blind.ts's isStudyQueueMode /
// NOT_QP_SQL). The current write path (matches.ts) can no longer produce a
// QP-tagged blind_credits row at all, so this reaches directly into the DB
// to reproduce what a historical (pre-2026-08-23) row actually looks like.
describe('GET /api/blind/sets/:id excludes QP-credited rows from the per-stage summary', () => {
  test('a QP-credited game does not move n, feelMean, winRate, or accMean', async () => {
    const setId = await makeSet({ batch_size: 10 }); // default 2 stages, senses [2.0, 3.0]
    await playGames('Ashe', 2); // 2 Competitive-credited games on stage 1 (batch_size 10 keeps them there)

    const lastCompId = (h.db.prepare('SELECT MAX(id) id FROM matches').get() as { id: number }).id;
    // Give the two comp games a known feel/acc so the QP row's effect (or
    // lack of it) is checkable, then add one historical QP-credited row.
    h.db.prepare('UPDATE match_heroes SET feel = 4 WHERE match_id <= ?').run(lastCompId);
    const qpMatch = h.db.prepare(`
      INSERT INTO matches (date, hero, role, map, game_type, win, queue_mode, blind_trial, blind_set_id, stage_index)
      VALUES ('2026-08-01', 'Ashe', 'DPS', 'Test Map', 'comp', 1, 'qp_role', 1, ?, 1)
    `).run(setId).lastInsertRowid as number;
    h.db.prepare(`INSERT INTO match_heroes (match_id, slot, hero, role, feel) VALUES (?, 1, 'Ashe', 'DPS', 1)`).run(qpMatch);
    h.db.prepare(`INSERT INTO blind_credits (match_id, hero, blind_set_id, stage_index) VALUES (?, 'Ashe', ?, 1)`).run(qpMatch, setId);

    const { body } = await h.get(`/api/blind/sets/${setId}`);
    const stage1 = body.stages.find((s: any) => s.stage_index === 1);
    assert.equal(stage1.n, 2, 'the QP-credited row must not count toward n');
    assert.equal(stage1.feelMean, 4, 'a feel=1 QP row must not pull the mean down');
    assert.equal(stage1.games, 2, 'perf query must also exclude the QP row');
  });
});
