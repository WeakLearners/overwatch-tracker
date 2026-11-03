import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { migrate } from './migrateScoreboardLayout';

test('migrate: moves day folders, deletes _copies/_other, flags missing, is idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sbmig-'));
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE match_scoreboards (id INTEGER PRIMARY KEY, file_path TEXT NOT NULL UNIQUE, status TEXT, reason TEXT)`);
  const add = (rel: string, status: string, create = true) => {
    const p = path.join(root, rel);
    if (create) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x'); }
    db.prepare(`INSERT INTO match_scoreboards (file_path, status) VALUES (?, ?)`).run(p, status);
  };
  add('2026-10-12/1 a.png', 'matched'); add('_copies/c.png', 'dismissed'); add('_other/o.png', 'not_scoreboard');
  add('Screenshot (9).png', 'unmatched', false); add('_needs-attention/n.png', 'error');
  fs.writeFileSync(path.join(root, 'Screenshot (1046).png'), 'unread');
  const log = () => {};
  const s = migrate(db, root, false, log);
  assert.equal(fs.existsSync(path.join(root, '2026-10-12')), true); // dry run touches nothing
  assert.deepEqual([s.filesMoved, s.filesDeleted, s.rowsFlagged, s.foldersRemoved], [1, 2, 1, 1]);
  const a = migrate(db, root, true, log);
  assert.deepEqual([a.filesMoved, a.rowsUpdated, a.filesDeleted, a.rowsFlagged, a.foldersRemoved], [1, 1, 2, 1, 1]);
  assert.ok(fs.existsSync(path.join(root, '2026/10/12/1 a.png')) && !fs.existsSync(path.join(root, '2026-10-12')));
  assert.ok(fs.existsSync(path.join(root, 'Screenshot (1046).png')) && fs.existsSync(path.join(root, '_needs-attention/n.png')));
  const r9 = db.prepare(`SELECT status, reason, file_path FROM match_scoreboards WHERE id = 4`).get() as any;
  assert.equal(r9.status, 'dismissed'); assert.match(r9.reason, /^file missing/); assert.ok(!r9.file_path.endsWith('/Screenshot (9).png'));
  assert.equal(db.prepare(`SELECT count(*) c FROM match_scoreboards`).get()!.c, 5);
  const b = migrate(db, root, true, log);
  assert.deepEqual([b.filesMoved, b.filesDeleted, b.rowsFlagged, b.foldersRemoved], [0, 0, 0, 0]);
  fs.mkdirSync(path.join(root, '2026-10-13')); fs.mkdirSync(path.join(root, '2026/10/13'), { recursive: true });
  fs.writeFileSync(path.join(root, '2026-10-13/z.png'), 'a'); fs.writeFileSync(path.join(root, '2026/10/13/z.png'), 'b');
  assert.throws(() => migrate(db, root, true, log), /collision/);
});
