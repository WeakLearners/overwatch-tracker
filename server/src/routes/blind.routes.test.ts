// Tier 3: stage-advance semantics over real HTTP (see test/httpHarness.ts).
//
// This suite exists to chase one specific anomaly: stage sets that moved on
// with only 1–3 games credited to the stage they left. Tier 2 proved the READ
// path is innocent — blind.ts and nightlyReport.ts agree on clean fixtures and
// the anomaly did not reproduce there. So it had to be the write path, and it
// is. Two independent defects, both reproduced below:
//
//   BUG 1 — POST /api/blind/advance has no batch guard at all. It checks that
//   the set is active and that a next stage exists, then increments cur_rel.
//   Whether the stage being abandoned got its batch_size games is never
//   consulted, even though GET /api/blind/state already computes exactly that
//   (`needSwitch`) to drive the button. The UI knows; the endpoint doesn't ask.
//
//   BUG 2 — retirement fires on the TOTAL credit count (batch_size * n_stages),
//   not on every stage individually. A 2-stage/batch-5 set that took 2 games on
//   stage 1 and 8 on stage 2 reaches 10 and is marked `completed: true`. Ten
//   games were played, so the total is honest — but it is not the 5-vs-5
//   comparison the set was created to run, and nothing downstream is told the
//   difference.
//
// Together they are one failure: a set can be advanced early and then reported
// complete, with a stage nothing will ever return to (findActiveStage only ever
// credits cur_rel, which never moves backward).
//
// These tests PIN CURRENT BEHAVIOR — they pass against the code as it stands,
// and each one that encodes a defect says so in its name. Per this repo's
// CLAUDE.md, a test that finds a real bug reports it rather than quietly fixing
// it: how an early advance should be handled (refuse it, allow it with a
// recorded reason, or let the analysis layer weight it) is a study-design call,
// not a cleanup. Flip the assertion when that call is made.
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
  test('BUG: advances with ZERO games on the current stage', async () => {
    const setId = await makeSet();
    const before = await stateOf(setId);
    assert.equal(before.games_on_stage, 0);
    assert.equal(before.needSwitch, false, 'state correctly says no switch is due');

    const r = await h.post('/api/blind/advance', { set_id: setId });
    // Current behavior: accepted. Stage 1 now has zero games and cur_rel is 2,
    // so stage 1 is permanently empty — nothing credits a stage below cur_rel.
    assert.equal(r.status, 200);
    assert.equal(r.body.cur_stage, 2);
    assert.deepEqual(creditsByStage(setId), [], 'stage 1 was left with no data at all');
  });

  test('BUG: advances mid-batch at 2 of 5, stranding stage 1 under-sampled', async () => {
    const setId = await makeSet({ batch_size: 5 });
    await playGames('Ashe', 2);

    const before = await stateOf(setId);
    assert.equal(before.games_on_stage, 2);
    assert.equal(before.needSwitch, false, 'the endpoint has the same information the UI does');

    const r = await h.post('/api/blind/advance', { set_id: setId });
    assert.equal(r.status, 200, 'no guard — needSwitch:false does not block the advance');
    assert.equal(r.body.cur_stage, 2);
    assert.equal(r.body.sens, 3, 'and the set is now genuinely being played at stage 2');
  });

  test('a stage left behind never refills — later games credit only cur_rel', async () => {
    const setId = await makeSet({ batch_size: 5 });
    await playGames('Ashe', 2);
    await h.post('/api/blind/advance', { set_id: setId });
    await playGames('Ashe', 3);

    // This is the irreversibility that makes the missing guard matter. If an
    // early advance merely deferred games, the stage would catch up later.
    // It cannot: findActiveStage credits cur_rel and cur_rel only moves up.
    assert.deepEqual(creditsByStage(setId), [
      { stage_index: 1, n: 2 },
      { stage_index: 2, n: 3 },
    ]);
  });

  test('BUG: a 2/8 split retires as "completed" — the total is right, the comparison is not', async () => {
    const setId = await makeSet({ batch_size: 5, senses: [2.0, 3.0] });
    await playGames('Ashe', 2);
    await h.post('/api/blind/advance', { set_id: setId });
    await playGames('Ashe', 8);

    // 2 + 8 = 10 = batch_size * n_stages, so the retire condition in
    // matches.ts fires and the set drops off the active list.
    assert.equal(await stateOf(setId), null, 'no longer active');

    const { body } = await h.get('/api/blind/sets');
    const set = body.sets.find((s: any) => s.set_id === setId);
    assert.equal(set.totalGames, 10);
    assert.equal(set.completed, true, 'reported complete');
    assert.equal(set.active, false);

    // ...while the thing it was built to measure — 5 games at 2.0 against 5
    // games at 3.0 — never happened. Nothing in the /sets payload exposes this;
    // `completed` is computed from totalGames alone, so a consumer reading that
    // flag sees a finished A/B test rather than a 2-vs-8.
    assert.deepEqual(creditsByStage(setId), [
      { stage_index: 1, n: 2 },
      { stage_index: 2, n: 8 },
    ]);
  });

  test('an evenly played set reaches the same "completed" state — the flag cannot tell them apart', async () => {
    const setId = await makeSet({ batch_size: 5 });
    await playGames('Ashe', 5);
    const mid = await stateOf(setId);
    assert.equal(mid.needSwitch, true, 'switch is due at exactly batch_size');
    await h.post('/api/blind/advance', { set_id: setId });
    await playGames('Ashe', 5);

    const { body } = await h.get('/api/blind/sets');
    const set = body.sets.find((s: any) => s.set_id === setId);
    assert.equal(set.completed, true);
    assert.equal(set.totalGames, 10);
    assert.deepEqual(creditsByStage(setId), [
      { stage_index: 1, n: 5 },
      { stage_index: 2, n: 5 },
    ]);
    // Same totalGames, same completed:true, same active:false as the 2/8 set
    // above. Only the per-stage distribution distinguishes a real result from
    // a spoiled one, and only blind_credits carries it.
  });

  test('refuses to advance past the last stage', async () => {
    const setId = await makeSet({ batch_size: 5, senses: [2.0, 3.0] });
    assert.equal((await h.post('/api/blind/advance', { set_id: setId })).status, 200);
    const r = await h.post('/api/blind/advance', { set_id: setId });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /last stage/);
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

describe('set retirement is one-way', () => {
  test('BUG: deleting a credited match drops the set below target but it stays retired', async () => {
    const setId = await makeSet({ batch_size: 5 });
    await playGames('Ashe', 5);
    await h.post('/api/blind/advance', { set_id: setId });
    await playGames('Ashe', 5);
    assert.equal(await stateOf(setId), null, 'retired at 10');

    const lastId = (h.db.prepare('SELECT MAX(id) id FROM matches').get() as { id: number }).id;
    assert.equal((await h.del(`/api/matches/${lastId}`)).status, 200);

    // The credit cascade-deletes, so every count blind.ts derives goes down...
    const { body } = await h.get('/api/blind/sets');
    const set = body.sets.find((s: any) => s.set_id === setId);
    assert.equal(set.totalGames, 9);
    assert.equal(set.completed, false, 'no longer meets its own completion rule');
    // ...but active stays 0. Retirement is a one-way UPDATE with no inverse, so
    // the set is now permanently unfinishable: it can never be advanced (409,
    // inactive) and can never be credited again (findActiveStage skips it).
    // This is the most likely history behind live set 86 (Reaper, 5+1 of 10,
    // inactive) — retired legitimately at 10, then had matches deleted.
    assert.equal(set.active, false);
    assert.equal(await stateOf(setId), null);
  });
});
