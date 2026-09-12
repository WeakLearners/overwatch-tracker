// Tier 0 verification: the DB path/singleton refactor that unblocks every
// future DB-backed test. Proves (a) tests can open a real, fully-migrated
// temp DB without ever touching data/overwatch.db, and (b) production's
// default path resolution is unchanged when OVERWATCH_DB_PATH is unset.
//
// These three tests were red on arrival: initSchema() crashed with "no such
// column: bss.phase" on a genuinely fresh DB file, because the one-time
// curve_enabled backfill ran before the ALTER that adds that column. The live
// DB never hit it (it migrated forward incrementally, so the backfill guard
// was already false by the time `phase` was added) — only a from-scratch
// bootstrap did, which is exactly what these tests do. Fixed 2026-09-12 by
// moving the backfill below the ALTER loop; keep these green, they are the
// regression guard for fresh-DB bootstrap.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb, closeDb, DB_PATH } from './schema';

let tmpPath: string;

beforeEach(() => {
  tmpPath = path.join(os.tmpdir(), `overwatch-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
});

afterEach(() => {
  closeDb();
  for (const f of [tmpPath, `${tmpPath}-wal`, `${tmpPath}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

describe('getDb() path isolation', () => {
  test('opening a temp path runs the real migration chain and creates the expected tables', () => {
    const db = getDb(tmpPath);
    assert.ok(fs.existsSync(tmpPath), 'temp DB file should have been created');
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as { name: string }[];
    const names = new Set(tables.map(t => t.name));
    for (const expected of ['matches', 'aim_stats', 'aim_stats_heroes', 'match_heroes', 'match_deaths', 'blind_stage_sets', 'blind_stages', 'blind_credits']) {
      assert.ok(names.has(expected), `expected table "${expected}" to exist after initSchema on a fresh temp DB`);
    }
  });

  test('a fresh temp DB is empty (no rows), safe for fixtures via plain INSERTs', () => {
    const db = getDb(tmpPath);
    const row = db.prepare(`SELECT COUNT(*) as n FROM matches`).get() as { n: number };
    assert.equal(row.n, 0);
  });

  test('closeDb() clears the singleton so the next getDb() call can open a different path', () => {
    const dbA = getDb(tmpPath);
    dbA.exec(`INSERT INTO matches (date, hero, role, map, game_type, win) VALUES ('2026-01-01', 'Ashe', 'DPS', 'Circuit Royale', 'comp', 1)`);
    closeDb();

    const tmpPath2 = `${tmpPath}.second`;
    const dbB = getDb(tmpPath2);
    const row = dbB.prepare(`SELECT COUNT(*) as n FROM matches`).get() as { n: number };
    assert.equal(row.n, 0, 'the second temp DB should not see rows inserted into the first');

    closeDb();
    for (const f of [tmpPath2, `${tmpPath2}-wal`, `${tmpPath2}-shm`]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  });

  test('without an explicit path or OVERWATCH_DB_PATH override, getDb() still resolves the production default path', () => {
    // Sanity check on the refactor itself: this does NOT call getDb() with no
    // args (that would actually open the real DB) — it only checks the
    // exported DB_PATH constant's resolution logic, matching what
    // schema.ts's production code path computes when the env var is unset.
    assert.equal(process.env.OVERWATCH_DB_PATH, undefined, 'this test assumes no override is set in the test env');
    assert.ok(DB_PATH.endsWith(path.join('data', 'overwatch.db')));
  });
});
