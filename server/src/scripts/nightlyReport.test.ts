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
import { activeSets, gamesOnStageOf, totalGamesOf } from '../routes/blind';
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
  const gamesOnStage = gamesOnStageOf(db, set.id, set.cur_rel);
  const n_stages = db.prepare('SELECT COUNT(*) n FROM blind_stages WHERE set_id = :id').get({ id: set.id }) as { n: number };
  const target = set.batch_size * n_stages.n;
  const completed = totalGames >= target;
  return {
    cur_stage: set.cur_rel, n_stages: n_stages.n, gamesOnStage, totalGames,
    completed, needSwitch: !completed && gamesOnStage >= set.batch_size,
  };
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
