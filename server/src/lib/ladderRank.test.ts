// syncLadderRank: player_ranks follows the newest comp match on its ladder (account + role, or 'Open').
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb, closeDb } from '../db/schema';
import { syncLadderRank } from './ladderRank';

describe('syncLadderRank on a temp DB', () => {
  let db: ReturnType<typeof getDb>; let tmp: string;
  beforeEach(() => { tmp = path.join(os.tmpdir(), `ladder-test-${process.pid}-${Date.now()}.db`); db = getDb(tmp); });
  afterEach(() => { closeDb(); for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f); });
  const add = (o: { date?: string; queue?: string; role?: string; rank?: number | null; account?: string | null }) => Number(db.prepare(
    `INSERT INTO matches (date, hero, role, map, game_type, win, account, queue_mode, player_rank) VALUES (?, 'Tracer', ?, 'Nepal', 'Control', 1, ?, ?, ?)`)
    .run(o.date ?? '2026-10-09', o.role ?? 'DPS', o.account === undefined ? 'Jinx' : o.account, o.queue ?? 'comp_role', o.rank ?? null).lastInsertRowid);
  const live = (account: string, role: string) => (db.prepare(`SELECT rank FROM player_ranks WHERE account = ? AND role = ?`).get(account, role) as any)?.rank;

  test('the newest comp match moves the stored rank (promotion 14 -> 15)', () => {
    db.prepare(`INSERT INTO player_ranks (account, role, rank) VALUES ('Jinx', 'DPS', 14)`).run();
    const m = add({ rank: 15 });
    assert.equal(syncLadderRank(db, m), true);
    assert.equal(live('Jinx', 'DPS'), 15);
    assert.equal(syncLadderRank(db, m), false, 'a second call changes nothing');
  });
  test('editing an older match does not move the stored rank', () => {
    const old = add({ date: '2026-10-01', rank: 12 });
    add({ date: '2026-10-09', rank: 15 });
    db.prepare(`INSERT INTO player_ranks (account, role, rank) VALUES ('Jinx', 'DPS', 15)`).run();
    db.prepare(`UPDATE matches SET player_rank = 13 WHERE id = ?`).run(old);
    assert.equal(syncLadderRank(db, old), false);
    assert.equal(live('Jinx', 'DPS'), 15);
  });
  test('open queue writes the Open slot, not the role slot; quick play writes nothing', () => {
    assert.equal(syncLadderRank(db, add({ queue: 'comp_open', role: 'DPS', rank: 16 })), true);
    assert.equal(live('Jinx', 'Open'), 16);
    assert.equal(live('Jinx', 'DPS'), undefined);
    assert.equal(syncLadderRank(db, add({ queue: 'qp_role', rank: 30 })), false);
    assert.equal(live('Jinx', 'DPS'), undefined);
  });
  test('a newest match with no rank (placement) leaves the stored rank alone; no account uses the empty key', () => {
    db.prepare(`INSERT INTO player_ranks (account, role, rank) VALUES ('Jinx', 'Support', 9)`).run();
    assert.equal(syncLadderRank(db, add({ role: 'Support', rank: null })), false);
    assert.equal(live('Jinx', 'Support'), 9);
    assert.equal(syncLadderRank(db, add({ account: null, rank: 5 })), true);
    assert.equal(live('', 'DPS'), 5);
  });
});
