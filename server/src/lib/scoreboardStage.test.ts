// Pipeline stage for the scoreboard light (GET /api/scoreboards/live).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb, closeDb } from '../db/schema';
import { storeScoreboard, type StoreArgs } from './scoreboard';
import { createGroup } from './scoreboardPages';
import { computeStage, markInFlight, clearInFlight, inFlightCount, resetStageActivity, DETECTED_HOLD_MS } from './scoreboardStage';

const NOW = Date.parse('2026-10-10T15:00:00Z');
const min = (m: number) => NOW - m * 60_000;

describe('computeStage', () => {
  let db: ReturnType<typeof getDb>; let tmp: string; let n = 0;
  beforeEach(() => { resetStageActivity(); tmp = path.join(os.tmpdir(), `sbs-test-${process.pid}-${Date.now()}.db`); db = getDb(tmp); });
  afterEach(() => {
    closeDb(); for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f);
    clearInFlight('/x/a.png'); clearInFlight('/x/b.png');
  });
  const store = (a: Partial<StoreArgs> & Pick<StoreArgs, 'status' | 'mtimeMs'>) =>
    storeScoreboard(db, { filePath: `/x/s${++n}.png`, reason: null, raw: null, matchId: null, rows: [], ...a });
  const ready = { summary: true, teams: false, personal: 0 };

  test('nothing recorded -> idle', () => {
    assert.deepEqual(computeStage(db, null, null, NOW), { stage: 'idle', reading: 0, pages: null, reason: null, ignored: 0 });
  });
  test('a queued file -> detected with the count, and it beats every other stage', () => {
    store({ status: 'error', mtimeMs: min(1), reason: 'boom' });
    markInFlight(['/x/a.png', '/x/b.png']);
    assert.equal(inFlightCount(), 2);
    const s = computeStage(db, { id: 1 }, ready, NOW);
    assert.equal(s.stage, 'detected'); assert.equal(s.reading, 2);
    clearInFlight('/x/a.png'); clearInFlight('/x/b.png');
    resetStageActivity(); // drop the hold; the hold has its own tests below
    assert.equal(computeStage(db, null, null, NOW).stage, 'problem');
  });
  test('detected holds for 15 s after the last file finishes, with the batch size', () => {
    markInFlight(['/x/a.png', '/x/b.png']);
    clearInFlight('/x/a.png'); clearInFlight('/x/b.png');
    const t = Date.now();
    const s = computeStage(db, { id: 1 }, ready, t + 1_000);
    assert.equal(s.stage, 'detected'); assert.equal(s.reading, 2);
    assert.equal(computeStage(db, { id: 1 }, ready, t + DETECTED_HOLD_MS + 1_000).stage, 'ready');
    assert.equal(computeStage(db, null, null, t + DETECTED_HOLD_MS + 1_000).stage, 'idle');
  });
  test('a problem wins over the hold', () => {
    const t = Date.now();
    store({ status: 'error', mtimeMs: t - 1_000, reason: 'boom' });
    markInFlight(['/x/a.png']); clearInFlight('/x/a.png');
    const s = computeStage(db, null, null, t + 1_000);
    assert.equal(s.stage, 'problem'); assert.equal(s.reason, 'boom');
  });
  test('a live group -> ready, pages passed through', () => {
    assert.deepEqual(computeStage(db, { id: 1 }, ready, NOW).pages, ready);
    assert.equal(computeStage(db, { id: 1 }, ready, NOW).stage, 'ready');
  });
  test('loose Teams and Personal pages with no Summary -> partial, counted by type', () => {
    store({ status: 'unmatched', mtimeMs: min(2), pageType: 'teams' });
    store({ status: 'unmatched', mtimeMs: min(1), pageType: 'personal', pageHero: 'Tracer' });
    const s = computeStage(db, null, null, NOW);
    assert.equal(s.stage, 'partial'); assert.deepEqual(s.pages, { summary: false, teams: true, personal: 1 });
  });
  test('loose pages older than the partial window, or already in a group, are not partial', () => {
    store({ status: 'unmatched', mtimeMs: min(30), pageType: 'teams' });
    const gid = createGroup(db, min(1), 'live', null);
    store({ status: 'unmatched', mtimeMs: min(1), pageType: 'personal', pageHero: 'Tracer', groupId: gid });
    assert.equal(computeStage(db, null, null, NOW).stage, 'idle');
  });
  test('newest real screenshot is an error -> problem with its reason; a later good page clears it', () => {
    store({ status: 'error', mtimeMs: min(3), reason: 'vision call failed 3 times: x' });
    const s = computeStage(db, null, null, NOW);
    assert.equal(s.stage, 'problem'); assert.match(s.reason!, /vision call failed/);
    assert.equal(computeStage(db, { id: 1 }, ready, NOW).stage, 'problem', 'an error on the newest page shows even over a live group');
    store({ status: 'unmatched', mtimeMs: min(1), pageType: 'teams' });
    assert.equal(computeStage(db, null, null, NOW).stage, 'partial');
  });
  test('an error older than the grace window is ignored', () => {
    store({ status: 'error', mtimeMs: min(60), reason: 'old' });
    assert.equal(computeStage(db, null, null, NOW).stage, 'idle');
  });
  test('not_scoreboard images are counted but never change the stage or hide an error', () => {
    store({ status: 'error', mtimeMs: min(3), reason: 'e' });
    store({ status: 'not_scoreboard', mtimeMs: min(1), pageType: 'other' });
    const s = computeStage(db, null, null, NOW);
    assert.equal(s.stage, 'problem'); assert.equal(s.ignored, 1);
  });
});
