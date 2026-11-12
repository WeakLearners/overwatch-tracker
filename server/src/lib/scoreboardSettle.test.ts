// OW-0010: a hand-saved match files the failed-read pages of its linked group like a good read.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb, closeDb } from '../db/schema';
import { linkGroup, settleFailedPages } from './scoreboardPages';
import { organizeAll, organizeGroup } from './scoreboardOrganize';
import { resetRows } from './scoreboardReset';

const NOW = Date.now();
const old = new Date(NOW - 10 * 60_000).toISOString();

describe('settleFailedPages + organizeGroup', () => {
  let tmp: string; let db: ReturnType<typeof getDb>; let root: string;
  beforeEach(() => {
    tmp = path.join(os.tmpdir(), `sb-settle-${process.pid}-${Date.now()}.db`); db = getDb(tmp);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-settle-'));
  });
  afterEach(() => { closeDb(); for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f); fs.rmSync(root, { recursive: true, force: true }); });

  const file = (name: string) => { const f = path.join(root, name); fs.writeFileSync(f, 'x'); fs.utimesSync(f, new Date(NOW - 600_000), new Date(NOW - 600_000)); return f; };
  const group = () => Number(db.prepare(`INSERT INTO scoreboard_groups (state, summary_mtime, last_mtime) VALUES ('live', ?, ?)`).run(old, old).lastInsertRowid);
  const row = (f: string, status: string, groupId: number | null, pageType: string | null, reason: string | null = null) =>
    Number(db.prepare(`INSERT INTO match_scoreboards (file_path, file_mtime, status, group_id, page_type, reason) VALUES (?, ?, ?, ?, ?, ?)`).run(f, old, status, groupId, pageType, reason).lastInsertRowid);
  const get = (id: number) => db.prepare(`SELECT status, reason, match_id, file_path FROM match_scoreboards WHERE id = ?`).get(id) as { status: string; reason: string; match_id: number | null; file_path: string };

  test('moves only the linked group failed pages to the date folder; keeps other pending pages; never deletes', () => {
    const m = Number(db.prepare(`INSERT INTO matches (date, hero, role, map, game_type, win, account) VALUES ('2026-11-11','Mizuki','Support','Numbani','Competitive',1,'Linx')`).run().lastInsertRowid);
    const g = group(); const other = group();
    const fBad = file('Screenshot (1).png'); const fOther = file('Screenshot (2).png'); const fOtherPend = file('Screenshot (3).png'); const fDup = file('Screenshot (4).png'); const fNoGroup = file('Screenshot (5).png');
    const rBad = row(fBad, 'error', g, 'personal', 'personal: bad tiles');
    const rOther = row(fOther, 'error', other, 'teams', 'x');
    const rOtherPend = row(fOtherPend, 'unmatched', other, 'personal');
    const rDup = row(fDup, 'dismissed', g, 'personal', 'second personal page for Mizuki');
    const rNoGroup = row(fNoGroup, 'error', null, null, 'vision call failed 3 times');
    linkGroup(db, g, m, 'linked', 'linked at submit', false);
    assert.equal(settleFailedPages(db, g), 1);
    assert.equal(organizeGroup(db, g, root), 1);
    const b = get(rBad);
    assert.equal(b.status, 'dismissed'); assert.match(b.reason, /^saved by hand: personal: bad tiles/);
    assert.equal(b.match_id, null, 'no match_id on the failed page, so Teams checks never count it');
    assert.equal(b.file_path, path.join(root, '2026', '11', '11', `${m} Numbani Mizuki - personal-unknown.png`));
    assert.ok(fs.existsSync(b.file_path)); assert.ok(!fs.existsSync(fBad));
    for (const [id, f, st] of [[rOther, fOther, 'error'], [rOtherPend, fOtherPend, 'unmatched'], [rDup, fDup, 'dismissed'], [rNoGroup, fNoGroup, 'error']] as const) {
      assert.equal(get(id).status, st); assert.equal(get(id).file_path, f); assert.ok(fs.existsSync(f), f);
    }
    assert.equal(resetRows(db, root).filter(r => r.id === rBad).length, 0, 'Reset skips a settled page');
    const placed = get(rBad).file_path;
    organizeAll(db, root);
    assert.equal(get(rBad).file_path, placed, 'the watcher pass leaves it in place (no ping-pong)');
  });

  test('a taken target name gets a (2) suffix, never an overwrite', () => {
    const m = Number(db.prepare(`INSERT INTO matches (date, hero, role, map, game_type, win, account) VALUES ('2026-11-11','Mizuki','Support','Numbani','Competitive',1,'Linx')`).run().lastInsertRowid);
    const g = group();
    fs.mkdirSync(path.join(root, '2026', '11', '11'), { recursive: true });
    const taken = path.join(root, '2026', '11', '11', `${m} Numbani Mizuki - teams.png`); fs.writeFileSync(taken, 'keep');
    const r = row(file('Screenshot (9).png'), 'error', g, 'teams', 'self row: none');
    linkGroup(db, g, m, 'linked', 'linked at submit', false); settleFailedPages(db, g); organizeGroup(db, g, root);
    assert.equal(fs.readFileSync(taken, 'utf8'), 'keep');
    assert.equal(path.basename(get(r).file_path), `${m} Numbani Mizuki - teams (2).png`);
  });
});
