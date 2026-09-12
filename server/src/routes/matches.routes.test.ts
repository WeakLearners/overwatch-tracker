// Tier 3: the credit-writing path — POST /api/matches, PUT /api/matches/:id,
// DELETE /api/matches/:id — over real HTTP (see test/httpHarness.ts).
//
// blind_credits is the single source of truth for stage progress: every count
// the app shows (games_on_stage, totalGames, per-stage accuracy, the nightly
// bracket reads) is a COUNT(*) over this table. Nothing else writes it, so
// these three endpoints are the whole surface where study data can be created,
// misattributed, or lost. That makes the rules below worth pinning explicitly
// rather than inferring from the read side.
//
// Companion to blind.routes.test.ts, which covers stage advance and retirement.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';

let h: Harness;

beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

async function makeSet(opts: { hero?: string | null; batch_size?: number; senses?: number[] } = {}) {
  const r = await h.post('/api/blind/sets', {
    hero: opts.hero === undefined ? 'Ashe' : opts.hero,
    batch_size: opts.batch_size ?? 5,
    senses: opts.senses ?? [2.0, 3.0],
  });
  assert.equal(r.status, 200, `set creation failed: ${JSON.stringify(r.body)}`);
  return r.body.set_id as number;
}

async function logMatch(body: Record<string, unknown>) {
  const r = await h.post('/api/matches', {
    date: '2026-09-12', time: '12:00', hour: 12, map: 'Ilios',
    game_type: 'comp', win: true, queue_mode: 'comp_role', ...body,
  });
  assert.equal(r.status, 200, `match failed to log: ${JSON.stringify(r.body)}`);
  return r.body.id as number;
}

const credits = (matchId: number) =>
  (h.db.prepare('SELECT hero, blind_set_id, stage_index FROM blind_credits WHERE match_id = ? ORDER BY hero')
    .all(matchId) as unknown as { hero: string; blind_set_id: number; stage_index: number }[])
    .map(r => ({ hero: r.hero, blind_set_id: Number(r.blind_set_id), stage_index: Number(r.stage_index) }));

const matchRow = (matchId: number) =>
  h.db.prepare('SELECT hero, sens, dpi, blind_trial, blind_set_id, stage_index, queue_mode FROM matches WHERE id = ?')
    .get(matchId) as any;

const heroSlots = (matchId: number) =>
  (h.db.prepare('SELECT slot, hero, sens FROM match_heroes WHERE match_id = ? ORDER BY slot')
    .all(matchId) as unknown as { slot: number; hero: string; sens: number | null }[])
    .map(r => ({ slot: Number(r.slot), hero: r.hero, sens: r.sens }));

describe('POST /api/matches — who gets credited', () => {
  test('a competitive match on a hero with an active set is credited and stamped', async () => {
    const setId = await makeSet({ hero: 'Ashe', senses: [2.0, 3.0] });
    const id = await logMatch({ hero: 'Ashe', role: 'DPS' });

    assert.deepEqual(credits(id), [{ hero: 'Ashe', blind_set_id: setId, stage_index: 1 }]);
    const m = matchRow(id);
    // The tracker sends no sens/dpi — the server writes stage 1's values.
    assert.equal(m.sens, 2.0);
    assert.equal(m.dpi, 1600, 'DPI locked at LOCKED_DPI on sens-varying sets');
    assert.equal(m.blind_trial, 1);
    assert.equal(Number(m.blind_set_id), setId);
    assert.equal(m.stage_index, 1);
  });

  test('a hero with no active set is not credited and keeps whatever sens was sent', async () => {
    await makeSet({ hero: 'Ashe' });
    const id = await logMatch({ hero: 'Genji', role: 'DPS', sens: 4.2 });

    assert.deepEqual(credits(id), [], 'Ashe’s set must not absorb a Genji game');
    const m = matchRow(id);
    assert.equal(m.sens, 4.2);
    assert.equal(m.blind_trial, 0);
    assert.equal(m.blind_set_id, null);
  });

  test('Quick Play never feeds the study, even on a hero under test', async () => {
    await makeSet({ hero: 'Ashe' });
    const id = await logMatch({ hero: 'Ashe', role: 'DPS', queue_mode: 'qp_role', sens: 9.9 });

    // The whole point of the comp-only rule: QP play must not dilute a stage's
    // sample. The match still logs — it just carries no credit.
    assert.deepEqual(credits(id), []);
    const m = matchRow(id);
    assert.equal(m.blind_trial, 0);
    assert.equal(m.sens, 9.9, 'and the stage does not overwrite the sens either');
  });

  test('a mid-match switch credits the switched-to hero’s OWN set at its OWN stage', async () => {
    const ashe = await makeSet({ hero: 'Ashe', senses: [2.0, 3.0] });
    const cass = await makeSet({ hero: 'Cassidy', senses: [5.0, 6.0] });
    // Put Cassidy's set on stage 2 so the two sets disagree about which stage
    // "current" means — a shared/global stage pointer would show up here.
    await h.post('/api/blind/advance', { set_id: cass });

    const id = await logMatch({ hero: 'Ashe', role: 'DPS', heroes: [{ hero: 'Cassidy', role: 'DPS' }] });

    assert.deepEqual(credits(id), [
      { hero: 'Ashe', blind_set_id: ashe, stage_index: 1 },
      { hero: 'Cassidy', blind_set_id: cass, stage_index: 2 },
    ]);
    // Each hero's slot carries its own stage's sens, not the primary's.
    assert.deepEqual(heroSlots(id), [
      { slot: 1, hero: 'Ashe', sens: 2.0 },
      { slot: 2, hero: 'Cassidy', sens: 6.0 },
    ]);
  });

  test('switching back to the starting hero credits once, not twice', async () => {
    const setId = await makeSet({ hero: 'Ashe' });
    const id = await logMatch({
      hero: 'Ashe', role: 'DPS',
      heroes: [{ hero: 'Cassidy', role: 'DPS' }, { hero: 'Ashe', role: 'DPS' }],
    });

    // One game played is one game credited. The (match_id, hero) primary key
    // plus INSERT OR IGNORE is what enforces this — a double credit here would
    // silently inflate a stage's n by one game per switch-back.
    assert.deepEqual(credits(id), [{ hero: 'Ashe', blind_set_id: setId, stage_index: 1 }]);
    assert.equal(
      (h.db.prepare('SELECT COUNT(*) n FROM blind_credits WHERE blind_set_id = ?').get(setId) as any).n, 1);
  });

  test('a hero-tagged set takes priority over the ad-hoc one', async () => {
    const adhoc = await makeSet({ hero: null, senses: [7.0, 8.0] });
    const ashe = await makeSet({ hero: 'Ashe', senses: [2.0, 3.0] });

    const asheId = await logMatch({ hero: 'Ashe', role: 'DPS' });
    assert.deepEqual(credits(asheId), [{ hero: 'Ashe', blind_set_id: ashe, stage_index: 1 }]);
    assert.equal(matchRow(asheId).sens, 2.0);

    // A hero with no set of its own still falls through to the ad-hoc set.
    const genjiId = await logMatch({ hero: 'Genji', role: 'DPS' });
    assert.deepEqual(credits(genjiId), [{ hero: 'Genji', blind_set_id: adhoc, stage_index: 1 }]);
    assert.equal(matchRow(genjiId).sens, 7.0);
  });

  test('a second active set for the same hero is refused — auto-tagging must stay unambiguous', async () => {
    await makeSet({ hero: 'Ashe' });
    const r = await h.post('/api/blind/sets', { hero: 'Ashe', batch_size: 5, senses: [4.0, 5.0] });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /already has an active test/);
  });

  test('missing required fields are rejected before anything is written', async () => {
    const r = await h.post('/api/matches', { date: '2026-09-12', hero: 'Ashe' });
    assert.equal(r.status, 400);
    assert.equal((h.db.prepare('SELECT COUNT(*) n FROM matches').get() as any).n, 0);
  });
});

describe('PUT /api/matches/:id — credits follow the edit', () => {
  test('correcting the hero moves the credit to the new hero’s set', async () => {
    const ashe = await makeSet({ hero: 'Ashe', senses: [2.0, 3.0] });
    const cass = await makeSet({ hero: 'Cassidy', senses: [5.0, 6.0] });
    const id = await logMatch({ hero: 'Ashe', role: 'DPS' });
    assert.deepEqual(credits(id), [{ hero: 'Ashe', blind_set_id: ashe, stage_index: 1 }]);

    assert.equal((await h.put(`/api/matches/${id}`, { hero: 'Cassidy' })).status, 200);

    // Ashe's stage must give the game back, not keep it alongside Cassidy's.
    assert.deepEqual(credits(id), [{ hero: 'Cassidy', blind_set_id: cass, stage_index: 1 }]);
    assert.equal((h.db.prepare('SELECT COUNT(*) n FROM blind_credits WHERE blind_set_id = ?').get(ashe) as any).n, 0);
    const m = matchRow(id);
    assert.equal(Number(m.blind_set_id), cass);
    assert.equal(m.sens, 5.0, 'sens is restamped from the new hero’s stage');
  });

  test('correcting queue_mode to Quick Play drops the credit entirely', async () => {
    const setId = await makeSet({ hero: 'Ashe' });
    const id = await logMatch({ hero: 'Ashe', role: 'DPS' });
    assert.equal((h.db.prepare('SELECT COUNT(*) n FROM blind_credits WHERE blind_set_id = ?').get(setId) as any).n, 1);

    assert.equal((await h.put(`/api/matches/${id}`, { queue_mode: 'qp_role' })).status, 200);

    // This is the correction the recredit fallback must NOT undo — reinstating
    // a prior credit here would silently reverse the very edit being made.
    assert.deepEqual(credits(id), []);
    assert.equal(matchRow(id).blind_trial, 0);
    assert.equal((h.db.prepare('SELECT COUNT(*) n FROM blind_credits WHERE blind_set_id = ?').get(setId) as any).n, 0);
  });

  test('an explicit sens in the same edit beats the recomputed stage value', async () => {
    await makeSet({ hero: 'Ashe', senses: [2.0, 3.0] });
    const id = await logMatch({ hero: 'Ashe', role: 'DPS' });
    assert.equal(matchRow(id).sens, 2.0);

    assert.equal((await h.put(`/api/matches/${id}`, { hero: 'Ashe', sens: 2.75 })).status, 200);

    // The stage would have restamped 2.0; the caller said 2.75 in the same
    // request, so the caller wins — and match_heroes must agree, since per-hero
    // analysis reads that column, not matches.sens.
    assert.equal(matchRow(id).sens, 2.75);
    assert.deepEqual(heroSlots(id), [{ slot: 1, hero: 'Ashe', sens: 2.75 }]);
  });

  test('an edit that retired a set can still re-credit that set (no orphaned last game)', async () => {
    const setId = await makeSet({ hero: 'Ashe', batch_size: 2, senses: [2.0, 3.0] });
    await logMatch({ hero: 'Ashe', role: 'DPS' });
    await logMatch({ hero: 'Ashe', role: 'DPS' });
    await h.post('/api/blind/advance', { set_id: setId });
    await logMatch({ hero: 'Ashe', role: 'DPS' });
    const lastId = await logMatch({ hero: 'Ashe', role: 'DPS' });
    assert.equal((h.db.prepare('SELECT active FROM blind_stage_sets WHERE id = ?').get(setId) as any).active, 0,
      'set retired on its 4th game');

    // Editing that 4th match re-runs syncStageCredits, which deletes the credit
    // first. findActiveStage only sees active sets, so without the recredit
    // fallback the set that retired BECAUSE of this match could never earn the
    // game back — it would sit one short forever, uncompletable.
    assert.equal((await h.put(`/api/matches/${lastId}`, { hero: 'Ashe' })).status, 200);
    assert.deepEqual(credits(lastId), [{ hero: 'Ashe', blind_set_id: setId, stage_index: 2 }]);
  });

  test('a no-op edit with no editable fields is rejected rather than silently recomputing', async () => {
    await makeSet({ hero: 'Ashe' });
    const id = await logMatch({ hero: 'Ashe', role: 'DPS' });
    const r = await h.put(`/api/matches/${id}`, { not_a_field: 1 });
    assert.equal(r.status, 400);
    assert.deepEqual(credits(id), [{ hero: 'Ashe', blind_set_id: 1, stage_index: 1 }]);
  });
});

describe('DELETE /api/matches/:id — credits cascade', () => {
  test('deleting a match removes its credit and the stage count self-heals', async () => {
    const setId = await makeSet({ hero: 'Ashe', batch_size: 5 });
    const first = await logMatch({ hero: 'Ashe', role: 'DPS' });
    await logMatch({ hero: 'Ashe', role: 'DPS' });

    const stateBefore = (await h.get('/api/blind/state')).body.actives[0];
    assert.equal(stateBefore.games_on_stage, 2);

    assert.equal((await h.del(`/api/matches/${first}`)).status, 200);

    // No counter to decrement — games_on_stage is derived live from
    // blind_credits, so the cascade is the entire bookkeeping.
    assert.deepEqual(credits(first), []);
    const stateAfter = (await h.get('/api/blind/state')).body.actives[0];
    assert.equal(stateAfter.games_on_stage, 1);
    assert.equal(stateAfter.totalGames, 1);
    assert.equal((h.db.prepare('SELECT COUNT(*) n FROM blind_credits WHERE blind_set_id = ?').get(setId) as any).n, 1);
  });

  test('deleting a match takes its per-hero slots with it', async () => {
    await makeSet({ hero: 'Ashe' });
    const id = await logMatch({ hero: 'Ashe', role: 'DPS', heroes: [{ hero: 'Cassidy', role: 'DPS' }] });
    assert.equal(heroSlots(id).length, 2);

    await h.del(`/api/matches/${id}`);
    assert.deepEqual(heroSlots(id), []);
  });
});
