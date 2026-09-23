// Tier 2, high-value test called out specifically in the task: routes/blind.ts's
// /state endpoint and scripts/nightlyReport.ts independently compute "which
// stage is this set on, and how many games into it" from blind_credits.
// They must agree — this test drives both real code paths (not a
// reimplementation of either) against the same fixture data and asserts
// they produce the same numbers.
//
// blind.ts's /state route was NOT extracted into a standalone function (that
// would risk conflating "test the route" with "test the compute" — the task
// scope is Tier 2 compute, not Tier 3 HTTP). Instead this test calls the
// exact same exported helpers (activeSets, gamesOnStageOf, totalGamesOf)
// the route itself calls, and reconstructs its return shape inline using
// its own formula (set.cur_rel, gamesOnStage >= batch_size, etc. — see
// routes/blind.ts's router.get('/state', ...) for the source of truth this
// mirrors). nightlyReport.ts's side is its own real exported function,
// computeStageStatus, called directly — a genuinely separate implementation
// (separate SQL, separate code path), not a shared helper. If the two ever
// disagree, that's a real bug in one of them, not a test bug — do not
// "fix" it by editing one side to match the other; report it.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb, closeDb } from '../db/schema';
import { insertMatch, insertHeroSlot, insertBlindSet, insertBlindStage, insertBlindCredit } from '../db/fixtures';
import { activeSets, gamesOnStageOf, totalGamesOf, liveStageIndex, needsSwitchNow, isSetComplete } from '../routes/blind';
import { computeStageStatus, ActiveSetRow } from './nightlyReport';

let tmpPath: string;
let db: ReturnType<typeof getDb>;

beforeEach(() => {
  tmpPath = path.join(os.tmpdir(), `overwatch-stageagree-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = getDb(tmpPath);
});

afterEach(() => {
  closeDb();
  for (const f of [tmpPath, `${tmpPath}-wal`, `${tmpPath}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

// blind.ts's /state route's per-set derivation, reconstructed here from the
// SAME exported helpers the route calls (not reimplemented SQL) — see the
// module comment. Mirrors routes/blind.ts lines ~209-225 exactly.
function stateViaBlindRoute(db: ReturnType<typeof getDb>, set: ReturnType<typeof activeSets>[number]) {
  const totalGames = totalGamesOf(db, set.id);
  const n_stages = db.prepare('SELECT COUNT(*) n FROM blind_stages WHERE set_id = :id').get({ id: set.id }) as { n: number };
  // Chunked 2-stage sets: use the real exported helpers (liveStageIndex,
  // needsSwitchNow, isSetComplete) rather than a hand-rolled formula — the
  // ABBA derivation is intricate enough that reimplementing it a third
  // time here would just be a second copy to keep in sync, not a genuine
  // independent check. Legacy sets keep this test's original inline
  // reconstruction, unchanged, for exactly the independence reason in the
  // module comment above.
  const chunked = set.chunk_size != null && n_stages.n === 2;
  const curStage = chunked ? liveStageIndex(db, set, n_stages.n) : set.cur_rel;
  const gamesOnStage = gamesOnStageOf(db, set.id, curStage);
  const completed = chunked ? isSetComplete(db, set.id) : totalGames >= set.batch_size * n_stages.n;
  const needSwitch = chunked
    ? needsSwitchNow(db, set, n_stages.n, completed)
    : !completed && gamesOnStage >= set.batch_size;
  return { cur_stage: curStage, n_stages: n_stages.n, gamesOnStage, totalGames, completed, needSwitch };
}

// Credits `n` games onto a set at a given stage — the shared fact both
// implementations read (blind_credits), created via 3 real matches plus
// their match_heroes rows so the fixture matches what the app actually
// writes on a real credited match.
function creditGames(db: ReturnType<typeof getDb>, setId: number, hero: string, stageIndex: number, n: number, startDate: string) {
  for (let i = 0; i < n; i++) {
    const date = `${startDate.slice(0, 8)}${String(Number(startDate.slice(8, 10)) + i).padStart(2, '0')}`;
    const matchId = insertMatch(db, { date, hero, role: 'DPS', win: 1, blind_set_id: setId, stage_index: stageIndex });
    insertHeroSlot(db, { match_id: matchId, slot: 1, hero, role: 'DPS' });
    insertBlindCredit(db, { match_id: matchId, hero, blind_set_id: setId, stage_index: stageIndex });
  }
}

describe('stage-progress agreement: blind.ts /state vs. nightlyReport.ts', () => {
  test('mid-stage, not yet due to advance: both sides agree', () => {
    const setId = insertBlindSet(db, { hero: 'Ashe', batch_size: 5, cur_rel: 1 });
    for (let i = 1; i <= 3; i++) insertBlindStage(db, { set_id: setId, stage_index: i, dpi: 800 + i * 100, sens: 2.0 + i * 0.1 });
    creditGames(db, setId, 'Ashe', 1, 3, '2026-01-01'); // 3/5 games on stage 1

    const set = activeSets(db)[0];
    const viaBlind = stateViaBlindRoute(db, set);
    const viaNightly = computeStageStatus(db, set as unknown as ActiveSetRow);

    assert.equal(viaBlind.gamesOnStage, 3);
    assert.equal(viaNightly.gamesOnStage, 3, 'nightlyReport disagrees with blind.ts on games-on-stage');
    assert.equal(viaBlind.n_stages, viaNightly.n_stages);
    assert.equal(viaBlind.totalGames, viaNightly.totalGames);
    assert.equal(viaBlind.completed, viaNightly.completed);
    assert.equal(viaBlind.needSwitch, viaNightly.dueToAdvance, 'blind.ts needSwitch and nightlyReport dueToAdvance are the same concept and must agree');
  });

  test('exactly at batch_size: both sides flag due-to-advance / needSwitch identically', () => {
    const setId = insertBlindSet(db, { hero: 'Ashe', batch_size: 5, cur_rel: 1 });
    for (let i = 1; i <= 3; i++) insertBlindStage(db, { set_id: setId, stage_index: i, dpi: 800 + i * 100, sens: 2.0 + i * 0.1 });
    creditGames(db, setId, 'Ashe', 1, 5, '2026-01-01'); // exactly batch_size

    const set = activeSets(db)[0];
    const viaBlind = stateViaBlindRoute(db, set);
    const viaNightly = computeStageStatus(db, set as unknown as ActiveSetRow);

    assert.equal(viaBlind.gamesOnStage, 5);
    assert.equal(viaNightly.gamesOnStage, 5);
    assert.equal(viaBlind.needSwitch, true);
    assert.equal(viaNightly.dueToAdvance, true);
    assert.equal(viaBlind.completed, false, 'stage 1/3 done should not read as the whole set completed');
    assert.equal(viaNightly.completed, false);
  });

  test('final stage complete: both sides agree the set is fully completed', () => {
    const setId = insertBlindSet(db, { hero: 'Ashe', batch_size: 5, cur_rel: 3 });
    for (let i = 1; i <= 3; i++) insertBlindStage(db, { set_id: setId, stage_index: i, dpi: 800 + i * 100, sens: 2.0 + i * 0.1 });
    creditGames(db, setId, 'Ashe', 1, 5, '2026-01-01');
    creditGames(db, setId, 'Ashe', 2, 5, '2026-02-01');
    creditGames(db, setId, 'Ashe', 3, 5, '2026-03-01');

    const set = activeSets(db)[0];
    const viaBlind = stateViaBlindRoute(db, set);
    const viaNightly = computeStageStatus(db, set as unknown as ActiveSetRow);

    assert.equal(viaBlind.totalGames, 15);
    assert.equal(viaNightly.totalGames, 15);
    assert.equal(viaBlind.completed, true);
    assert.equal(viaNightly.completed, true);
  });

  test('reported known anomaly window (1-3 games against batch_size 5): both sides still agree, whatever they report', () => {
    // Per the task brief: stage-trial sets have been observed advancing at
    // 1-3 games against a batch_size of 5. This fixture deliberately sits in
    // that window. Not hunting the cause (Tier 3) — just confirming the two
    // independent stage-status implementations read blind_credits the same
    // way even at this specific, previously-anomalous game count.
    const setId = insertBlindSet(db, { hero: 'Ashe', batch_size: 5, cur_rel: 1 });
    for (let i = 1; i <= 2; i++) insertBlindStage(db, { set_id: setId, stage_index: i, dpi: 800 + i * 100, sens: 2.0 + i * 0.1 });
    creditGames(db, setId, 'Ashe', 1, 2, '2026-01-01'); // 2 games, well under batch_size 5

    const set = activeSets(db)[0];
    const viaBlind = stateViaBlindRoute(db, set);
    const viaNightly = computeStageStatus(db, set as unknown as ActiveSetRow);

    assert.equal(viaBlind.gamesOnStage, 2);
    assert.equal(viaNightly.gamesOnStage, 2);
    assert.equal(viaBlind.needSwitch, false, 'at 2/5 games, neither side should read this as due to advance');
    assert.equal(viaNightly.dueToAdvance, false);
    // This fixture, by itself, does NOT reproduce the anomaly (2 games stays
    // reported as 2 games on both sides, correctly not-yet-due) — it doesn't
    // advance on its own without an explicit /advance call or a bug in
    // credit attribution neither implementation here exhibits. No anomaly
    // found in this fixture; see the report for what would be needed to
    // chase it further (Tier 3 scope).
  });
});

describe('stage-progress agreement — ABBA chunk boundaries (2026-09-23)', () => {
  // Global chunk sequence for chunk_size=10, batch_size=40: A(0-9) B(10-19)
  // B(20-29) A(30-39) A(40-49) B(50-59) B(60-69) A(70-79). cur_rel here
  // always means "the stage the NEXT game will land on", per liveStageIndex.
  function makeChunkedSet(hero: string) {
    const setId = insertBlindSet(db, { hero, batch_size: 40, cur_rel: 1, chunk_size: 10 });
    insertBlindStage(db, { set_id: setId, stage_index: 1, dpi: 1600, sens: 2.40 });
    insertBlindStage(db, { set_id: setId, stage_index: 2, dpi: 1600, sens: 2.55 });
    return setId;
  }

  test('match 10: the next game switches from A to B', () => {
    const setId = makeChunkedSet('Sojourn');
    creditGames(db, setId, 'Sojourn', 1, 10, '2026-01-01'); // fills chunk 1 (A)

    const set = activeSets(db)[0];
    const viaBlind = stateViaBlindRoute(db, set);
    const viaNightly = computeStageStatus(db, set as unknown as ActiveSetRow);

    assert.equal(viaBlind.cur_stage, 2, 'after 10 games the next one lands on B');
    assert.equal(viaNightly.cur_rel, 2);
    assert.equal(viaBlind.needSwitch, true);
    assert.equal(viaNightly.dueToAdvance, true);
    assert.equal(viaBlind.gamesOnStage, 0, 'stage B has no games credited yet');
  });

  test('match 30: the next game switches back from B to A', () => {
    const setId = makeChunkedSet('Sojourn');
    creditGames(db, setId, 'Sojourn', 1, 10, '2026-01-01'); // chunk 1: A
    creditGames(db, setId, 'Sojourn', 2, 10, '2026-01-11'); // chunk 2: B
    creditGames(db, setId, 'Sojourn', 2, 10, '2026-01-21'); // chunk 3: B — no switch between chunk 2 and 3

    const set = activeSets(db)[0];
    const viaBlind = stateViaBlindRoute(db, set);
    const viaNightly = computeStageStatus(db, set as unknown as ActiveSetRow);

    assert.equal(viaBlind.cur_stage, 1, 'after 30 games (A,B,B) the next one returns to A');
    assert.equal(viaNightly.cur_rel, 1);
    assert.equal(viaBlind.needSwitch, true, 'switching back is still a real switch');
    assert.equal(viaNightly.dueToAdvance, true);
    assert.equal(viaBlind.gamesOnStage, 10, 'stage A already has its first chunk');
  });

  test('the chunk-3/chunk-4 boundary is both A — no false switch prompt', () => {
    const setId = makeChunkedSet('Sojourn');
    creditGames(db, setId, 'Sojourn', 1, 10, '2026-01-01'); // chunk 1: A
    creditGames(db, setId, 'Sojourn', 2, 10, '2026-01-11'); // chunk 2: B
    creditGames(db, setId, 'Sojourn', 2, 10, '2026-01-21'); // chunk 3: B
    creditGames(db, setId, 'Sojourn', 1, 10, '2026-01-31'); // chunk 4: A (30-39)

    const set = activeSets(db)[0];
    const viaBlind = stateViaBlindRoute(db, set);
    const viaNightly = computeStageStatus(db, set as unknown as ActiveSetRow);

    // At total=40, the next game (chunk 5, global index 4) is ALSO A — no
    // switch needed even though a chunk boundary was just crossed. This is
    // the case a naive "did total cross a multiple of chunk_size" check
    // would get wrong.
    assert.equal(viaBlind.cur_stage, 1);
    assert.equal(viaNightly.cur_rel, 1);
    assert.equal(viaBlind.needSwitch, false, 'chunk 3 and chunk 4 are both stage A — nothing to switch');
    assert.equal(viaNightly.dueToAdvance, false);
    assert.equal(viaBlind.gamesOnStage, 20, 'stage A has two 10-game chunks so far');
  });

  test('match 40 on a stage: that stage reads complete before the whole set does', () => {
    const setId = makeChunkedSet('Sojourn');
    // Global chunks 0-6 (70 games): A,B,B,A,A,B,B — stage B has now had
    // chunks 1,2,5,6 = 4 chunks = 40 games; stage A has had 0,3,4 = 3
    // chunks = 30 games. B is individually done; the set overall is not.
    creditGames(db, setId, 'Sojourn', 1, 10, '2026-01-01');
    creditGames(db, setId, 'Sojourn', 2, 10, '2026-01-11');
    creditGames(db, setId, 'Sojourn', 2, 10, '2026-01-21');
    creditGames(db, setId, 'Sojourn', 1, 10, '2026-01-31');
    creditGames(db, setId, 'Sojourn', 1, 10, '2026-02-10');
    creditGames(db, setId, 'Sojourn', 2, 10, '2026-02-20');
    creditGames(db, setId, 'Sojourn', 2, 10, '2026-03-01');

    const set = activeSets(db)[0];
    const gamesOnB = gamesOnStageOf(db, set.id, 2);
    const gamesOnA = gamesOnStageOf(db, set.id, 1);
    assert.equal(gamesOnB, 40, 'stage B individually complete');
    assert.equal(gamesOnA, 30, 'stage A still short');

    const viaBlind = stateViaBlindRoute(db, set);
    const viaNightly = computeStageStatus(db, set as unknown as ActiveSetRow);
    assert.equal(viaBlind.completed, false, 'the whole SET is not complete until both stages hit 40');
    assert.equal(viaNightly.completed, false);
  });

  test('all 80 games credited: both sides agree the whole set is complete', () => {
    const setId = makeChunkedSet('Sojourn');
    for (const [stageIdx, startDate] of [
      [1, '2026-01-01'], [2, '2026-01-11'], [2, '2026-01-21'], [1, '2026-01-31'],
      [1, '2026-02-10'], [2, '2026-02-20'], [2, '2026-03-01'], [1, '2026-03-11'],
    ] as [number, string][]) {
      creditGames(db, setId, 'Sojourn', stageIdx, 10, startDate);
    }

    const set = activeSets(db)[0];
    const viaBlind = stateViaBlindRoute(db, set);
    const viaNightly = computeStageStatus(db, set as unknown as ActiveSetRow);

    assert.equal(viaBlind.totalGames, 80);
    assert.equal(viaNightly.totalGames, 80);
    assert.equal(gamesOnStageOf(db, set.id, 1), 40);
    assert.equal(gamesOnStageOf(db, set.id, 2), 40);
    assert.equal(viaBlind.completed, true);
    assert.equal(viaNightly.completed, true);
  });
});
