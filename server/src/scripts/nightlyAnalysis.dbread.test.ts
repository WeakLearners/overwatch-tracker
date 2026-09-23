// stagePointsFor/stageSamplesFor exclude QP-credited rows from analysis
// (lib/blind.ts's isStudyQueueMode / NOT_QP_SQL) — Sean's 2026-09-23 decision
// that the 469 historical blind_credits rows written under the old
// QP-Support exception never feed a study analysis surface again. The rows
// themselves are never touched; this only checks what the read side reports.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb, closeDb } from '../db/schema';
import {
  insertMatch, insertHeroSlot, insertBlindSet, insertBlindStage, insertBlindCredit, insertAimStatsHero,
} from '../db/fixtures';
import { stagePointsFor, stageSamplesFor } from './nightlyAnalysis';

let tmpPath: string;
let db: ReturnType<typeof getDb>;

beforeEach(() => {
  tmpPath = path.join(os.tmpdir(), `overwatch-qpfilter-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = getDb(tmpPath);
});

afterEach(() => {
  closeDb();
  for (const f of [tmpPath, `${tmpPath}-wal`, `${tmpPath}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

// One credited game on a stage, either Competitive or QP — mirrors how the
// old (pre-2026-08-23) write path could tag a QP match's blind_credits row.
// The current write path (matches.ts) can no longer produce a QP-tagged
// credit at all, so this reaches straight into the DB the way a historical
// row actually looks, rather than trying to log one through the API.
function creditedGame(setId: number, stageIndex: number, opts: { queueMode: string; acc: number; win: 0 | 1 }) {
  const matchId = insertMatch(db, {
    date: '2026-08-01', hero: 'Ana', role: 'Support', win: opts.win,
    queue_mode: opts.queueMode, blind_trial: 1, blind_set_id: setId, stage_index: stageIndex,
  });
  insertHeroSlot(db, { match_id: matchId, slot: 1, hero: 'Ana', role: 'Support' });
  insertAimStatsHero(db, { match_id: matchId, hero: 'Ana', overall_acc: opts.acc });
  insertBlindCredit(db, { match_id: matchId, hero: 'Ana', blind_set_id: setId, stage_index: stageIndex });
  return matchId;
}

describe('stagePointsFor excludes QP-credited rows', () => {
  test('a QP credit is dropped from n/meanAcc/winRate while Competitive ones count', () => {
    const setId = insertBlindSet(db, { hero: 'Ana', batch_size: 10 });
    insertBlindStage(db, { set_id: setId, stage_index: 1, sens: 4.0 });

    creditedGame(setId, 1, { queueMode: 'comp_role', acc: 40, win: 1 });
    creditedGame(setId, 1, { queueMode: 'comp_role', acc: 50, win: 0 });
    // A historical QP-Support-era credit — must not move n, meanAcc, or winRate.
    creditedGame(setId, 1, { queueMode: 'qp_role', acc: 90, win: 1 });

    const [point] = stagePointsFor(db, setId);
    assert.equal(point.n, 2, 'the QP row must not be counted');
    assert.equal(point.meanAcc, 45, 'mean over the two comp rows only, not skewed by the 90 QP row');
    assert.equal(point.winRate, 0.5);
  });

  test('a stage with only QP credits reads as zero rows, not a crash', () => {
    const setId = insertBlindSet(db, { hero: 'Ana', batch_size: 10 });
    insertBlindStage(db, { set_id: setId, stage_index: 1, sens: 4.0 });
    creditedGame(setId, 1, { queueMode: 'qp_role', acc: 90, win: 1 });

    const points = stagePointsFor(db, setId);
    assert.equal(points.length, 0, 'GROUP BY over zero matching rows produces no row for the stage, not a zero-row');
  });
});

describe('stageSamplesFor excludes QP-credited rows', () => {
  test('the raw sample array used by the t-test omits QP accuracy values', () => {
    const setId = insertBlindSet(db, { hero: 'Ana', batch_size: 10 });
    insertBlindStage(db, { set_id: setId, stage_index: 1, sens: 4.0 });

    creditedGame(setId, 1, { queueMode: 'comp_role', acc: 40, win: 1 });
    creditedGame(setId, 1, { queueMode: 'comp_role', acc: 42, win: 0 });
    creditedGame(setId, 1, { queueMode: 'qp_role', acc: 99, win: 1 });

    const samples = stageSamplesFor(db, setId, 1);
    assert.deepEqual(samples.sort((a, b) => a - b), [40, 42]);
  });
});
