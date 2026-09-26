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
  h.db.prepare('SELECT hero, sens, dpi, blind_trial, blind_set_id, stage_index, queue_mode, player_rank, player_rank_start FROM matches WHERE id = ?')
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

  test('Quick Play never feeds the study, even on a hero under test — but still records that hero\'s real stage sens', async () => {
    await makeSet({ hero: 'Ashe', senses: [2.0, 3.0] });
    const id = await logMatch({ hero: 'Ashe', role: 'DPS', queue_mode: 'qp_role', sens: 9.9 });

    // The whole point of the comp-only rule: QP play must not dilute a stage's
    // sample. The match still logs — it just carries no credit. Fixed
    // 2026-09-24: "what sens was the hero at" and "does this count for the
    // study" are separate questions — a hero under an active test is at that
    // stage's sens whichever queue it's played in, so the match is still
    // stamped with the real stage sens (2.0), not whatever the client sent.
    assert.deepEqual(credits(id), []);
    const m = matchRow(id);
    assert.equal(m.blind_trial, 0);
    assert.equal(m.blind_set_id, null);
    assert.equal(m.sens, 2.0, 'QP still shows/records the hero\'s real current stage sens');
  });

  test('Quick Play on an untested hero keeps whatever sens the client sent (the 2.5 default)', async () => {
    await makeSet({ hero: 'Ashe' });
    const id = await logMatch({ hero: 'Genji', role: 'DPS', queue_mode: 'qp_role', sens: 2.5 });

    assert.deepEqual(credits(id), []);
    const m = matchRow(id);
    assert.equal(m.blind_trial, 0);
    assert.equal(m.sens, 2.5, 'no active set for Genji, so the client-sent/default sens stands');
  });

  test('Quick Play never feeds the study for Support either — the old QP-Support exception is gone', async () => {
    // Support briefly earned a QP credit while its data was still thin (see
    // lib/blind.ts's isStudyQueueMode); retired 2026-08-23 (commit 7d80e90)
    // and switched off again for good 2026-09-23 at Sean's request. Pin the
    // Support branch explicitly, not just DPS above — a role-specific
    // exception is exactly the kind of thing that regresses silently.
    await makeSet({ hero: 'Ana', senses: [4.0, 6.5] });
    const id = await logMatch({ hero: 'Ana', role: 'Support', queue_mode: 'qp_role', sens: 6.5 });

    assert.deepEqual(credits(id), []);
    const m = matchRow(id);
    assert.equal(m.blind_trial, 0);
    assert.equal(m.sens, 4.0, 'stamped with Ana\'s real stage sens, not the client-sent value');
  });

  test('a mid-match switch records the switched-to hero’s OWN sens but earns it NO credit', async () => {
    // Fixed 2026-09-24 (mid-match-switch build): only the starting hero
    // (slot 1) ever earns test credit now — a switch mid-match is a partial
    // game entered from behind, and crediting it the same as a full game
    // silently mixed 188 of 762 credits (25%, since Aug 1) into the study
    // this way before the fix. Cassidy's own stage sens still shows/records
    // correctly (display only), it just never moves Cassidy's counters.
    const ashe = await makeSet({ hero: 'Ashe', senses: [2.0, 3.0] });
    const cass = await makeSet({ hero: 'Cassidy', senses: [5.0, 6.0] });
    // Put Cassidy's set on stage 2 so the two sets disagree about which stage
    // "current" means — a shared/global stage pointer would show up here.
    // force, because stage 1 hasn't been played and the endpoint now refuses
    // to walk away from an unfinished stage without it.
    assert.equal((await h.post('/api/blind/advance', { set_id: cass, force: true })).status, 200);

    const id = await logMatch({ hero: 'Ashe', role: 'DPS', heroes: [{ hero: 'Cassidy', role: 'DPS' }] });

    assert.deepEqual(credits(id), [
      { hero: 'Ashe', blind_set_id: ashe, stage_index: 1 },
    ]);
    assert.equal(
      (h.db.prepare('SELECT COUNT(*) n FROM blind_credits WHERE blind_set_id = ?').get(cass) as any).n, 0,
      'Cassidy played this match only as a mid-match switch — no credit');
    // Each hero's slot still carries its own stage's sens, not the primary's —
    // recording "what sens was this hero at" is unchanged by the credit fix.
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

// A rank move is a property of the match that caused it, not of the gap
// between two matches. These pin both ends of that pair, because the whole
// point is that the row answers the question on its own — a later edit to
// some other row must not be able to change what this one says happened.
describe('POST /api/matches — the rank a match started and ended at', () => {
  test('both ends persist, so the row states the move by itself', async () => {
    const id = await logMatch({ hero: 'Ashe', role: 'DPS', player_rank_start: 15, player_rank: 14 });
    const m = matchRow(id);
    assert.equal(m.player_rank_start, 15, 'Gold 1 going in');
    assert.equal(m.player_rank, 14, 'Gold 2 coming out');
  });

  test('a match that moved nothing stores the same rank at both ends', async () => {
    const m = matchRow(await logMatch({ hero: 'Ashe', role: 'DPS', player_rank_start: 15, player_rank: 15 }));
    assert.equal(m.player_rank_start, 15);
    assert.equal(m.player_rank, 15);
  });

  test("a ladder's first match has no starting rank, and that reads as null", async () => {
    // Nothing recorded where this ladder stood before, so the app must not
    // invent one. Null here is what keeps the chart from drawing a move on
    // the day Sean merely began tracking.
    const m = matchRow(await logMatch({ hero: 'Ashe', role: 'DPS', player_rank: 15 }));
    assert.equal(m.player_rank_start, null);
    assert.equal(m.player_rank, 15);
  });

  test('quickplay stores neither end', async () => {
    const m = matchRow(await logMatch({ hero: 'Ashe', role: 'DPS', queue_mode: 'qp_role' }));
    assert.equal(m.player_rank_start, null);
    assert.equal(m.player_rank, null);
  });

  test('an edit can correct the start rank without touching any other row', async () => {
    const id = await logMatch({ hero: 'Ashe', role: 'DPS', player_rank_start: 15, player_rank: 14 });
    const other = await logMatch({ hero: 'Ashe', role: 'DPS', player_rank_start: 14, player_rank: 14 });
    const r = await h.put(`/api/matches/${id}`, { player_rank_start: 16 });
    assert.equal(r.status, 200);
    assert.equal(matchRow(id).player_rank_start, 16);
    assert.equal(matchRow(other).player_rank_start, 14, 'correcting one row must not disturb another');
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

  test('correcting queue_mode to Quick Play drops the credit entirely but keeps the real stage sens', async () => {
    const setId = await makeSet({ hero: 'Ashe', senses: [2.0, 3.0] });
    const id = await logMatch({ hero: 'Ashe', role: 'DPS' });
    assert.equal((h.db.prepare('SELECT COUNT(*) n FROM blind_credits WHERE blind_set_id = ?').get(setId) as any).n, 1);

    assert.equal((await h.put(`/api/matches/${id}`, { queue_mode: 'qp_role' })).status, 200);

    // This is the correction the recredit fallback must NOT undo — reinstating
    // a prior credit here would silently reverse the very edit being made.
    assert.deepEqual(credits(id), []);
    const m = matchRow(id);
    assert.equal(m.blind_trial, 0);
    assert.equal((h.db.prepare('SELECT COUNT(*) n FROM blind_credits WHERE blind_set_id = ?').get(setId) as any).n, 0);
    // Fixed 2026-09-24: dropping the credit is a crediting decision, not a
    // "what sens was the hero at" decision — Ashe is still on stage 1 (2.0)
    // after the flip, so the match keeps showing that, not the pre-fix
    // frozen-fallback value.
    assert.equal(m.sens, 2.0, 'the edit path still restamps the real stage sens even with no credit');
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

// ── leaver ───────────────────────────────────────────────────────────────────
// Added 2026-09-23 with the Leaver checkbox. The thing worth pinning is the
// denominator. Matches logged before the column existed hold NULL, meaning the
// question was never put to them. The overview stat must divide by the rows
// that were asked, not by every row ever logged — otherwise the rate drifts
// toward zero as the 3,489-match archive drowns out the answered ones.
describe('leaver: recorded on the match, rated only over answered matches', () => {
  test('the checkbox round-trips, and an unchecked box stores 0 rather than NULL', async () => {
    const yes = await logMatch({ hero: 'Ashe', role: 'Damage', leaver: true });
    const no = await logMatch({ hero: 'Ashe', role: 'Damage', leaver: false });
    const omitted = await logMatch({ hero: 'Ashe', role: 'Damage' });
    const leaverOf = (id: number) =>
      (h.db.prepare('SELECT leaver FROM matches WHERE id = ?').get(id) as { leaver: number | null }).leaver;
    assert.equal(leaverOf(yes), 1);
    assert.equal(leaverOf(no), 0);
    // A client that never sends the field still records "no leaver" — the form
    // always sends one, so this only covers older/other callers.
    assert.equal(leaverOf(omitted), 0);
  });

  test('a mis-click is fixable through PUT', async () => {
    const id = await logMatch({ hero: 'Ashe', role: 'Damage', leaver: true });
    const r = await h.put(`/api/matches/${id}`, { leaver: 0 });
    assert.equal(r.status, 200);
    assert.equal((h.db.prepare('SELECT leaver FROM matches WHERE id = ?').get(id) as { leaver: number }).leaver, 0);
  });

  test('overview counts leavers against answered matches, and skips NULL rows on both sides', async () => {
    // Three answered matches: one leaver (a loss), two clean (one win, one loss).
    await logMatch({ hero: 'Ashe', role: 'Damage', win: false, leaver: true });
    await logMatch({ hero: 'Ashe', role: 'Damage', win: true, leaver: false });
    await logMatch({ hero: 'Ashe', role: 'Damage', win: false, leaver: false });
    // One legacy row, written straight to the DB the way the archive holds it.
    const legacy = await logMatch({ hero: 'Ashe', role: 'Damage', win: true });
    h.db.prepare('UPDATE matches SET leaver = NULL WHERE id = ?').run(legacy);

    const r = await h.get('/api/stats/overview');
    assert.equal(r.status, 200);
    assert.equal(r.body.total, 4);
    // Asked: 3, not 4. The legacy row is silent, not a "no".
    assert.equal(r.body.leaver_logged, 3);
    assert.equal(r.body.leaver_games, 1);
    // Leaver-free win rate: the leaver loss drops out, leaving 1 win and 1
    // loss among answered rows plus the legacy win — 2 of 3 = 66.7%.
    assert.equal(r.body.win_rate_no_leaver, 66.7);
  });
});

// ── leaver_side ──────────────────────────────────────────────────────────────
// Added 2026-09-24: which team the leaver was on. Additive/nullable column —
// leaver keeps meaning exactly what it always meant, leaver_side only ever
// has a value when leaver is actually 1.
describe('leaver_side: which team, kept consistent with leaver', () => {
  test('round-trips mine/theirs, and is forced NULL when leaver is false regardless of what the client sends', async () => {
    const mine = await logMatch({ hero: 'Ashe', role: 'Damage', leaver: true, leaver_side: 'mine' });
    const theirs = await logMatch({ hero: 'Ashe', role: 'Damage', leaver: true, leaver_side: 'theirs' });
    const noLeaverButSideSent = await logMatch({ hero: 'Ashe', role: 'Damage', leaver: false, leaver_side: 'mine' });
    const sideOf = (id: number) =>
      (h.db.prepare('SELECT leaver_side FROM matches WHERE id = ?').get(id) as { leaver_side: string | null }).leaver_side;
    assert.equal(sideOf(mine), 'mine');
    assert.equal(sideOf(theirs), 'theirs');
    assert.equal(sideOf(noLeaverButSideSent), null);
  });

  test('editing leaver back to false through PUT clears a previously-set side', async () => {
    const id = await logMatch({ hero: 'Ashe', role: 'Damage', leaver: true, leaver_side: 'theirs' });
    const r = await h.put(`/api/matches/${id}`, { leaver: 0 });
    assert.equal(r.status, 200);
    const row = h.db.prepare('SELECT leaver, leaver_side FROM matches WHERE id = ?').get(id) as { leaver: number; leaver_side: string | null };
    assert.equal(row.leaver, 0);
    assert.equal(row.leaver_side, null);
  });

  test('editing leaver_side alone (leaver already 1) updates just the side', async () => {
    const id = await logMatch({ hero: 'Ashe', role: 'Damage', leaver: true, leaver_side: 'mine' });
    const r = await h.put(`/api/matches/${id}`, { leaver_side: 'theirs' });
    assert.equal(r.status, 200);
    const row = h.db.prepare('SELECT leaver, leaver_side FROM matches WHERE id = ?').get(id) as { leaver: number; leaver_side: string | null };
    assert.equal(row.leaver, 1);
    assert.equal(row.leaver_side, 'theirs');
  });

  test('overview breaks leaver_games down by side, unknown-side rows counted in neither', async () => {
    await logMatch({ hero: 'Ashe', role: 'Damage', leaver: true, leaver_side: 'mine' });
    await logMatch({ hero: 'Ashe', role: 'Damage', leaver: true, leaver_side: 'theirs' });
    await logMatch({ hero: 'Ashe', role: 'Damage', leaver: true, leaver_side: 'theirs' });
    // A pre-migration-style leaver row with no side on record.
    const unknown = await logMatch({ hero: 'Ashe', role: 'Damage', leaver: true });
    h.db.prepare('UPDATE matches SET leaver_side = NULL WHERE id = ?').run(unknown);

    const r = await h.get('/api/stats/overview');
    assert.equal(r.status, 200);
    assert.equal(r.body.leaver_games, 4);
    assert.equal(r.body.leaver_mine, 1);
    assert.equal(r.body.leaver_theirs, 2);
  });
});

// ── Only slot 1 earns credit (mid-match-switch build, 2026-09-24) ──────────
describe('slots 2/3 never earn test credit, on insert or on edit', () => {
  test('POST: a switched-to hero records its stage sens but blind_credits gets only the starting hero', async () => {
    const ashe = await makeSet({ hero: 'Ashe', senses: [2.0, 3.0] });
    const cass = await makeSet({ hero: 'Cassidy', senses: [5.0, 6.0] });
    const id = await logMatch({ hero: 'Ashe', role: 'DPS', heroes: [{ hero: 'Cassidy', role: 'DPS' }] });

    assert.deepEqual(credits(id), [{ hero: 'Ashe', blind_set_id: ashe, stage_index: 1 }]);
    assert.equal((h.db.prepare('SELECT COUNT(*) n FROM blind_credits WHERE blind_set_id = ?').get(cass) as any).n, 0);
    assert.deepEqual(heroSlots(id), [
      { slot: 1, hero: 'Ashe', sens: 2.0 },
      { slot: 2, hero: 'Cassidy', sens: 5.0 },
    ]);
  });

  test('PUT: replacing the switch roster never credits the new switched-to hero either', async () => {
    await makeSet({ hero: 'Ashe' });
    const cass = await makeSet({ hero: 'Cassidy', senses: [5.0, 6.0] });
    const id = await logMatch({ hero: 'Ashe', role: 'DPS' });

    assert.equal((await h.put(`/api/matches/${id}`, {
      heroes: [{ hero: 'Cassidy', role: 'DPS' }],
    })).status, 200);

    assert.equal((h.db.prepare('SELECT COUNT(*) n FROM blind_credits WHERE blind_set_id = ?').get(cass) as any).n, 0);
    assert.deepEqual(heroSlots(id), [
      { slot: 1, hero: 'Ashe', sens: 2.0 },
      { slot: 2, hero: 'Cassidy', sens: 5.0 },
    ]);
  });
});

// ── Designated Fallback (df_heroes) ─────────────────────────────────────────
// Soldier: 76 @ 2.645 is seeded by schema.ts's migration, so every test DB
// (a fresh temp file per test, per httpHarness) already carries the real row.
describe('Designated Fallback: Soldier: 76 never earns credit, always shows its own sens', () => {
  test('POST: an ad-hoc hero-less active set must not sweep the DF hero in', async () => {
    // Without the DF gate, findActiveStage's hero-IS-NULL fallback branch
    // would match ANY hero, including the DF — this is the exact "sweep-in
    // by accident" case sensStageFor's comment describes.
    const adhoc = await makeSet({ hero: null, senses: [7.0, 8.0] });
    const id = await logMatch({ hero: 'Soldier: 76', role: 'DPS' });

    assert.deepEqual(credits(id), []);
    assert.equal((h.db.prepare('SELECT COUNT(*) n FROM blind_credits WHERE blind_set_id = ?').get(adhoc) as any).n, 0);
    const m = matchRow(id);
    assert.equal(m.blind_trial, 0);
    assert.equal(m.sens, 2.645, 'DF always shows its own fixed sens, never the ad-hoc set’s');
    assert.equal(m.dpi, 1600);
  });

  test('PUT: correcting a match onto the DF hero drops any credit and restamps the DF sens', async () => {
    const ashe = await makeSet({ hero: 'Ashe', senses: [2.0, 3.0] });
    const id = await logMatch({ hero: 'Ashe', role: 'DPS' });
    assert.deepEqual(credits(id), [{ hero: 'Ashe', blind_set_id: ashe, stage_index: 1 }]);

    assert.equal((await h.put(`/api/matches/${id}`, { hero: 'Soldier: 76', role: 'DPS' })).status, 200);

    assert.deepEqual(credits(id), []);
    const m = matchRow(id);
    assert.equal(m.blind_trial, 0);
    assert.equal(m.sens, 2.645);
  });

  test('a switched-to DF hero (slot 2/3) still shows its fixed sens, and was never credited anyway', async () => {
    const ashe = await makeSet({ hero: 'Ashe', senses: [2.0, 3.0] });
    const id = await logMatch({ hero: 'Ashe', role: 'DPS', heroes: [{ hero: 'Soldier: 76', role: 'DPS' }] });

    assert.deepEqual(credits(id), [{ hero: 'Ashe', blind_set_id: ashe, stage_index: 1 }]);
    assert.deepEqual(heroSlots(id), [
      { slot: 1, hero: 'Ashe', sens: 2.0 },
      { slot: 2, hero: 'Soldier: 76', sens: 2.645 },
    ]);
  });

  test('a test set cannot be created on the DF hero', async () => {
    const r = await h.post('/api/blind/sets', { hero: 'Soldier: 76', batch_size: 5, senses: [2.0, 3.0] });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /Designated Fallback/);
    assert.equal((h.db.prepare('SELECT COUNT(*) n FROM blind_stage_sets WHERE hero = ?').get('Soldier: 76') as any).n, 0);
  });
});

// ── Switched-out rate (derived, not stored) ─────────────────────────────────
describe('GET /api/blind/sets/:id — switched-out rate per stage', () => {
  test('a stage’s switch-out rate counts only the starting hero’s own credited games', async () => {
    const setId = await makeSet({ hero: 'Ashe', senses: [2.0, 3.0] });
    await makeSet({ hero: 'Cassidy', senses: [5.0, 6.0] }); // the switched-to hero's own set
    // One clean game, one switched-out game — both still count toward the
    // stage's normal games/n, per the brief ("still counts normally").
    await logMatch({ hero: 'Ashe', role: 'DPS' });
    await logMatch({ hero: 'Ashe', role: 'DPS', heroes: [{ hero: 'Cassidy', role: 'DPS' }] });

    const r = await h.get(`/api/blind/sets/${setId}`);
    assert.equal(r.status, 200);
    const stage1 = r.body.stages.find((s: any) => s.stage_index === 1);
    assert.equal(stage1.n, 2, 'both games still count as trials on this stage');
    assert.equal(stage1.switchedOut, 1);
    assert.equal(stage1.switchedOutRate, 50);
  });

  test('no switches at all reads as 0%, not null', async () => {
    const setId = await makeSet({ hero: 'Ashe', senses: [2.0, 3.0] });
    await logMatch({ hero: 'Ashe', role: 'DPS' });

    const r = await h.get(`/api/blind/sets/${setId}`);
    const stage1 = r.body.stages.find((s: any) => s.stage_index === 1);
    assert.equal(stage1.switchedOut, 0);
    assert.equal(stage1.switchedOutRate, 0);
  });
});

// ── MatchEditDrawer: leaver + per-slot sens edits ───────────────────────────
// Added alongside the drawer's new Leaver control and per-hero-slot sens
// inputs (2026-09-24). The drawer's own logic (which fields to send, and
// when) lives client-side — these tests pin the server contract it depends
// on: PUT only ever touches the columns actually present in its body, an
// explicit sens is stored as sent rather than recomputed, and a sens edit
// never reaches into blind_credits.
describe('MatchEditDrawer: leaver set/clear via PUT', () => {
  test('a PUT can set leaver from unanswered to true with a side', async () => {
    const id = await logMatch({ hero: 'Ashe', role: 'Damage' });
    assert.equal((await h.put(`/api/matches/${id}`, { leaver: 1, leaver_side: 'mine' })).status, 200);
    const row = h.db.prepare('SELECT leaver, leaver_side FROM matches WHERE id = ?').get(id) as { leaver: number; leaver_side: string | null };
    assert.equal(row.leaver, 1);
    assert.equal(row.leaver_side, 'mine');
  });

  test('a PUT can clear leaver back to false, wiping the side', async () => {
    const id = await logMatch({ hero: 'Ashe', role: 'Damage', leaver: true, leaver_side: 'theirs' });
    assert.equal((await h.put(`/api/matches/${id}`, { leaver: 0, leaver_side: null })).status, 200);
    const row = h.db.prepare('SELECT leaver, leaver_side FROM matches WHERE id = ?').get(id) as { leaver: number; leaver_side: string | null };
    assert.equal(row.leaver, 0);
    assert.equal(row.leaver_side, null);
  });
});

describe('MatchEditDrawer: a historical unknown-side leaver row survives an unrelated PUT', () => {
  test('leaver_side stays NULL when a PUT touches only an unrelated field', async () => {
    const id = await logMatch({ hero: 'Ashe', role: 'Damage', leaver: true, leaver_side: 'mine' });
    // Simulate a pre-migration row: leaver=1, side never recorded.
    h.db.prepare('UPDATE matches SET leaver_side = NULL WHERE id = ?').run(id);

    // The drawer's "unknown historical" case never taps a sliver, so it must
    // not send leaver/leaver_side at all when the user only corrects the map —
    // this is the server-side half of that contract: fields not present in
    // the body are never touched.
    assert.equal((await h.put(`/api/matches/${id}`, { map: 'Ilios', game_type: 'control' })).status, 200);

    const row = h.db.prepare('SELECT leaver, leaver_side FROM matches WHERE id = ?').get(id) as { leaver: number; leaver_side: string | null };
    assert.equal(row.leaver, 1, 'leaver=1 must survive untouched');
    assert.equal(row.leaver_side, null, 'the unknown side must not be silently filled in');
  });
});

describe('MatchEditDrawer: per-slot sens edits are stored as sent, not re-stamped', () => {
  test('slot 1: an explicit sens PUT is stored even with no roster change', async () => {
    await makeSet({ hero: 'Ashe', senses: [2.0, 3.0] });
    const id = await logMatch({ hero: 'Ashe', role: 'DPS' });
    assert.equal(matchRow(id).sens, 2.0);

    assert.equal((await h.put(`/api/matches/${id}`, { sens: 2.75 })).status, 200);

    assert.equal(matchRow(id).sens, 2.75);
    assert.deepEqual(heroSlots(id), [{ slot: 1, hero: 'Ashe', sens: 2.75 }]);
  });

  test('slot 2: heroSens stores an explicit correction without touching hero/role', async () => {
    const id = await logMatch({ hero: 'Ashe', role: 'DPS', heroes: [{ hero: 'Cassidy', role: 'DPS', sens: 5.0 }] });
    assert.equal((await h.put(`/api/matches/${id}`, { heroSens: { Cassidy: 6.5 } })).status, 200);

    assert.deepEqual(heroSlots(id), [
      { slot: 1, hero: 'Ashe', sens: null },
      { slot: 2, hero: 'Cassidy', sens: 6.5 },
    ]);
  });

  test('a sens-only edit never touches blind_credits', async () => {
    const setId = await makeSet({ hero: 'Ashe', senses: [2.0, 3.0] });
    const id = await logMatch({ hero: 'Ashe', role: 'DPS' });
    const before = credits(id);
    assert.deepEqual(before, [{ hero: 'Ashe', blind_set_id: setId, stage_index: 1 }]);

    assert.equal((await h.put(`/api/matches/${id}`, { sens: 2.75 })).status, 200);

    assert.deepEqual(credits(id), before, 'the credit row is untouched by a sens-only edit');
  });

  test('an unrelated field edit after a sens correction does not re-stamp it back', async () => {
    await makeSet({ hero: 'Ashe', senses: [2.0, 3.0] });
    const id = await logMatch({ hero: 'Ashe', role: 'DPS' });
    assert.equal((await h.put(`/api/matches/${id}`, { sens: 2.75 })).status, 200);
    assert.equal(matchRow(id).sens, 2.75);

    // Map/game_type are not roster fields — this must not re-run
    // syncStageCredits and must not restamp sens back to the active stage's
    // 2.0.
    assert.equal((await h.put(`/api/matches/${id}`, { map: 'Ilios', game_type: 'control' })).status, 200);

    assert.equal(matchRow(id).sens, 2.75, 'an unrelated edit must not silently revert the hand-edited sens');
  });
});

// Fixing a forgotten promotion/demotion from the Today's Matches card. One
// match's end rank is the next one's start, so the fix has to carry forward.
describe('PUT /api/matches/:id/rank-outcome — correcting a missed rank change', () => {
  const ladder = async (rows: [number, number][]) => {
    const ids: number[] = [];
    for (const [i, [s, e]] of rows.entries()) {
      ids.push(await logMatch({ hero: 'Ashe', role: 'DPS', account: 'Pinx', time: `12:0${i}`, player_rank_start: s, player_rank: e }));
    }
    return ids;
  };

  test('a forgotten promotion shifts every later game and the live rank', async () => {
    const [a, b, c] = await ladder([[15, 15], [15, 15], [15, 14]]);
    await h.put('/api/ranks', { account: 'Pinx', role: 'DPS', rank: 14 });
    const r = await h.put(`/api/matches/${a}/rank-outcome`, { outcome: 'promoted' });
    assert.equal(r.status, 200);
    assert.deepEqual([matchRow(a), matchRow(b), matchRow(c)].map(m => [m.player_rank_start, m.player_rank]), [[15, 16], [16, 16], [16, 15]]);
    assert.equal((await h.get('/api/ranks')).body['Pinx|DPS'], 15, 'live badge follows');
    assert.equal(r.body.latestEnd, 15);
  });

  test('the carry stops at a game whose start was already fixed by hand', async () => {
    const [a, b, c] = await ladder([[15, 15], [16, 16], [16, 16]]);
    await h.put('/api/ranks', { account: 'Pinx', role: 'DPS', rank: 16 });
    const r = await h.put(`/api/matches/${a}/rank-outcome`, { outcome: 'promoted' });
    assert.deepEqual([matchRow(a), matchRow(b), matchRow(c)].map(m => [m.player_rank_start, m.player_rank]), [[15, 16], [16, 16], [16, 16]]);
    assert.equal((await h.get('/api/ranks')).body['Pinx|DPS'], 16, 'already right, untouched');
    assert.equal(r.body.latestEnd, null);
  });

  test('undoing a promotion to "none" walks the chain back down', async () => {
    const [a, b] = await ladder([[15, 16], [16, 16]]);
    await h.put('/api/ranks', { account: 'Pinx', role: 'DPS', rank: 16 });
    await h.put(`/api/matches/${a}/rank-outcome`, { outcome: 'none' });
    assert.deepEqual([matchRow(a), matchRow(b)].map(m => [m.player_rank_start, m.player_rank]), [[15, 15], [15, 15]]);
    assert.equal((await h.get('/api/ranks')).body['Pinx|DPS'], 15);
  });

  test('another ladder is never touched', async () => {
    const [a] = await ladder([[15, 15]]);
    const other = await logMatch({ hero: 'Kiriko', role: 'Support', account: 'Pinx', time: '12:05', player_rank_start: 15, player_rank: 15 });
    await h.put(`/api/matches/${a}/rank-outcome`, { outcome: 'demoted' });
    assert.equal(matchRow(a).player_rank, 14);
    assert.deepEqual([matchRow(other).player_rank_start, matchRow(other).player_rank], [15, 15]);
  });

  test('a match with no starting rank is refused, not guessed', async () => {
    const id = await logMatch({ hero: 'Ashe', role: 'DPS', account: 'Pinx', player_rank: 15 });
    assert.equal((await h.put(`/api/matches/${id}/rank-outcome`, { outcome: 'promoted' })).status, 400);
    assert.equal(matchRow(id).player_rank, 15);
  });
});
