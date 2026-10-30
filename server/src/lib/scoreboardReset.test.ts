import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb, closeDb } from '../db/schema';
import { resetCurrentMatch, resetRows, resetUnreadFiles } from './scoreboardReset';
import { pollOnce, countTick, getUnreadCount } from './scoreboardWatcher';
import { organizeAll } from './scoreboardOrganize';

const NOW = Date.now();
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();

describe('Reset all: scope rule and _trash', () => {
  let tmp: string; let db: ReturnType<typeof getDb>; let root: string;
  beforeEach(() => {
    tmp = path.join(os.tmpdir(), `sb-reset-${process.pid}-${Date.now()}.db`); db = getDb(tmp);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-reset-'));
  });
  afterEach(() => { closeDb(); for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f); fs.rmSync(root, { recursive: true, force: true }); });

  const file = (rel: string) => { const f = path.join(root, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); return f; };
  const group = (state: string, ageMs = 60_000) => Number(db.prepare(`INSERT INTO scoreboard_groups (state, summary_mtime, last_mtime) VALUES (?, ?, ?)`).run(state, iso(ageMs), iso(ageMs)).lastInsertRowid);
  const row = (f: string, status: string, matchId: number | null, groupId: number | null) =>
    Number(db.prepare(`INSERT INTO match_scoreboards (file_path, file_mtime, status, match_id, group_id) VALUES (?, ?, ?, ?, ?)`).run(f, iso(60_000), status, matchId, groupId).lastInsertRowid);
  const status = (id: number) => db.prepare(`SELECT status, file_path FROM match_scoreboards WHERE id = ?`).get(id) as { status: string; file_path: string };

  test('moves only the current unsaved match; leaves saved boards, _other, dated folders, other groups and outside files', async () => {
    const m = Number(db.prepare(`INSERT INTO matches (date, hero, role, map, game_type, win, account) VALUES ('2026-10-30','Mizuki','Support','Numbani','Competitive',1,'Linx')`).run().lastInsertRowid);
    const live = group('live'); const oldLive = group('live', 3 * 3_600_000); const linked = group('linked');
    const unread = file('Screenshot (1).png');
    const livePage = file('Screenshot (2).png'); const liveErr = file('Screenshot (3).png'); const loose = file('Screenshot (4).png');
    const saved = file('2026-10-30/1 Numbani Mizuki - summary.png');
    const other = file('_other/o.png'); const attention = file('_needs-attention/a.png');
    const otherGroupPage = file('Screenshot (5).png'); const matchedTop = file('Screenshot (6).png'); const dismissedTop = file('Screenshot (7).png');
    const outside = path.join(os.tmpdir(), `drive-${process.pid}.png`); fs.writeFileSync(outside, 'x');
    const rLive = row(livePage, 'unmatched', null, live); const rErr = row(liveErr, 'error', null, live); const rLoose = row(loose, 'unmatched', null, null);
    const rSaved = row(saved, 'matched', m, linked); const rOther = row(other, 'not_scoreboard', null, null); const rAtt = row(attention, 'unmatched', null, oldLive);
    const rOg = row(otherGroupPage, 'unmatched', null, oldLive); const rMt = row(matchedTop, 'matched', m, linked); const rDt = row(dismissedTop, 'dismissed', null, live);
    const rOut = row(outside, 'unmatched', null, live);

    assert.deepEqual(resetUnreadFiles(db, root), [unread]);
    const out = resetCurrentMatch(db, root, undefined, NOW);
    assert.deepEqual(out, { moved: 4, failed: 0, rowsDismissed: 3 });
    for (const id of [rLive, rErr, rLoose]) {
      const s = status(id); assert.equal(s.status, 'dismissed'); assert.equal(path.dirname(s.file_path), path.join(root, '_trash')); assert.ok(fs.existsSync(s.file_path));
    }
    for (const f of [unread, livePage, liveErr, loose]) assert.ok(!fs.existsSync(f), f);
    assert.ok(fs.existsSync(path.join(root, '_trash', 'Screenshot (1).png')));
    for (const [id, st, f] of [[rSaved, 'matched', saved], [rOther, 'not_scoreboard', other], [rAtt, 'unmatched', attention], [rOg, 'unmatched', otherGroupPage], [rMt, 'matched', matchedTop], [rDt, 'dismissed', dismissedTop], [rOut, 'unmatched', outside]] as const) {
      assert.equal(status(id).status, st); assert.equal(status(id).file_path, f); assert.ok(fs.existsSync(f), f);
    }
    assert.equal((db.prepare(`SELECT state FROM scoreboard_groups WHERE id = ?`).get(live) as any).state, 'ambiguous');
    assert.equal((db.prepare(`SELECT state FROM scoreboard_groups WHERE id = ?`).get(oldLive) as any).state, 'live');
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM match_scoreboards`).get() as any).n, 10, 'no row deleted');
    fs.unlinkSync(outside);
  });

  test('name collisions in _trash get a suffix; a new file with a reused name is not "known"', async () => {
    file('_trash/Screenshot (1).png');
    file('Screenshot (1).png');
    resetCurrentMatch(db, root, undefined, NOW);
    assert.ok(fs.existsSync(path.join(root, '_trash', 'Screenshot (1) (2).png')));
    const again = file('Screenshot (1).png'); // Windows reuses the number
    assert.deepEqual(resetUnreadFiles(db, root), [again]);
  });

  test('_trash is never read or organized again', async () => {
    const live = group('live'); const f = file('Screenshot (2).png'); const id = row(f, 'unmatched', null, live);
    resetCurrentMatch(db, root, undefined, NOW);
    let calls = 0; const v = async () => { calls++; return { is_scoreboard: false, rows: [] }; };
    assert.equal((await pollOnce(db, root, v)).processed, 0);
    assert.equal(organizeAll(db, root, NOW + 3_600_000), 0);
    assert.equal(calls, 0);
    assert.equal(path.dirname(status(id).file_path), path.join(root, '_trash'));
    assert.equal(resetRows(db, root, NOW).length, 0);
  });
});

describe('watcher no longer reads by itself', () => {
  let tmp: string; let db: ReturnType<typeof getDb>; let root: string;
  beforeEach(() => { tmp = path.join(os.tmpdir(), `sb-cnt-${process.pid}-${Date.now()}.db`); db = getDb(tmp); root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-cnt-')); });
  afterEach(() => { closeDb(); for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f); fs.rmSync(root, { recursive: true, force: true }); });

  test('the interval tick counts old-enough new images and makes no vision call; Read (pollOnce read mode) then reads them', async () => {
    const old = path.join(root, 'Screenshot (1).png'); const young = path.join(root, 'Screenshot (2).png');
    fs.writeFileSync(old, 'x'); fs.writeFileSync(young, 'x');
    const t = Date.now() / 1000; fs.utimesSync(old, t - 60, t - 60); // young keeps now = under the 5 s skip
    let calls = 0; const v = async () => { calls++; return { is_scoreboard: false, rows: [] }; };
    await countTick(db, root, v);
    assert.equal(calls, 0); assert.equal(getUnreadCount(), 1, 'the 5 s file-age skip still applies');
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM match_scoreboards`).get() as any).n, 0);
    const r = await pollOnce(db, root, v, 50, 5_000);
    assert.equal(r.processed, 1); assert.equal(calls, 1);
  });
});
