// One-time migration (2026-11-03): scoreboard folder YYYY-MM-DD/ -> YYYY/MM/DD/, delete _copies/ and _other/ files,
// flag rows whose file is gone. Idempotent. Dry run by default.
//
//   cd server && npx tsx --experimental-sqlite src/scripts/migrateScoreboardLayout.ts [--apply]
//        [--db <path>] [--root <scoreboard dir>] [--backup-dir <dir>]
//
// Defaults: --db ../data/overwatch.db, --root $SCOREBOARD_DIR or /Users/Sean/OWScreenshots, --backup-dir <db dir>/backups.
// --apply first writes a backup with VACUUM INTO (safe for a WAL database) and stops if that fails.
// Never touches: top-level images, _needs-attention/, _trash/, $RECYCLE.BIN, or any folder that is not YYYY-MM-DD.
import fs from 'fs';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';

const DAY_DIR = /^\d{4}-\d{2}-\d{2}$/;
const FLAG = /^file (missing|deleted)/;

function arg(name: string): string | undefined { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : undefined; }

export interface Summary { filesMoved: number; rowsUpdated: number; filesDeleted: number; rowsFlagged: number; foldersRemoved: number; skippedNoRow: number }

function listFiles(dir: string): string[] {
  try { return fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isFile() && e.name !== '.DS_Store').map(e => e.name).sort(); } catch { return []; }
}

export function backupDb(db: DatabaseSync, dir: string, now = new Date()): string {
  const p2 = (n: number) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}-${p2(now.getHours())}${p2(now.getMinutes())}`;
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `overwatch-${stamp}.db`);
  if (fs.existsSync(dest)) throw new Error(`backup ${dest} already exists`);
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
  return dest;
}

export function migrate(db: DatabaseSync, root: string, apply: boolean, log: (s: string) => void = console.log): Summary {
  const sum: Summary = { filesMoved: 0, rowsUpdated: 0, filesDeleted: 0, rowsFlagged: 0, foldersRemoved: 0, skippedNoRow: 0 };
  const rowByPath = db.prepare(`SELECT id, status, reason FROM match_scoreboards WHERE file_path = ?`);
  const setPath = db.prepare(`UPDATE match_scoreboards SET file_path = ? WHERE id = ?`);
  const tag = (s: string) => (apply ? s : `[dry] ${s}`);

  // Rows whose file is gone, found BEFORE any move or delete: only rows still unflagged, under root, outside _trash.
  const missing = (db.prepare(`SELECT id, file_path, status, reason FROM match_scoreboards ORDER BY id`).all() as { id: number; file_path: string; status: string; reason: string | null }[])
    .filter(r => r.file_path.startsWith(root + path.sep) && !fs.existsSync(r.file_path)
      && !FLAG.test(r.reason ?? '') && path.dirname(r.file_path) !== path.join(root, '_trash'));
  const copiesOther = ['_copies', '_other'].flatMap(d => listFiles(path.join(root, d)).map(n => path.join(root, d, n)));
  const toDelete = copiesOther.filter(f => rowByPath.get(f));
  sum.skippedNoRow += copiesOther.length - toDelete.length;
  const deleteSet = new Set(copiesOther);

  // 1. Moves, folder by folder.
  const dayDirs = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory() && DAY_DIR.test(e.name)).map(e => e.name).sort();
  const plan: { from: string; to: string }[] = [];
  for (const d of dayDirs) {
    const [y, m, dd] = d.split('-');
    for (const n of listFiles(path.join(root, d))) plan.push({ from: path.join(root, d, n), to: path.join(root, y, m, dd, n) });
  }
  const clash = plan.filter(p => fs.existsSync(p.to));
  if (clash.length) throw new Error(`name collision, nothing moved: ${clash.slice(0, 5).map(c => c.to).join(', ')}${clash.length > 5 ? ` (+${clash.length - 5} more)` : ''}`);
  if (new Set(plan.map(p => p.to)).size !== plan.length) throw new Error('two files map to the same destination, nothing moved');

  for (const d of dayDirs) {
    const [y, m, dd] = d.split('-');
    const files = plan.filter(p => path.dirname(p.from) === path.join(root, d));
    if (!files.length) continue;
    if (!apply) { sum.filesMoved += files.length; sum.rowsUpdated += files.filter(f => rowByPath.get(f.from)).length; continue; }
    fs.mkdirSync(path.join(root, y, m, dd), { recursive: true });
    const done: { from: string; to: string }[] = [];
    db.exec('BEGIN');
    try {
      for (const f of files) {
        fs.renameSync(f.from, f.to); done.push(f);
        const row = rowByPath.get(f.from) as { id: number } | undefined;
        if (row) { setPath.run(f.to, row.id); sum.rowsUpdated++; }
      }
      db.exec('COMMIT');
      sum.filesMoved += files.length;
    } catch (e) {
      try { db.exec('ROLLBACK'); } catch { /* ignore */ }
      for (const f of done.reverse()) { try { fs.renameSync(f.to, f.from); } catch { /* report below */ } }
      throw new Error(`folder ${d} failed (${(e as Error).message}); rolled back, stopped`);
    }
  }
  log(tag(`moved ${sum.filesMoved} files, ${sum.rowsUpdated} rows`));

  // 2. Delete _copies/ and _other/ files; rows stay, marked.
  const mark = db.prepare(`UPDATE match_scoreboards SET reason = ? WHERE id = ?`);
  const today = new Date().toISOString().slice(0, 10);
  if (apply) db.exec('BEGIN');
  try {
    for (const f of toDelete) {
      const row = rowByPath.get(f) as { id: number; reason: string | null };
      if (apply) {
        fs.unlinkSync(f);
        mark.run(`file deleted on purpose ${today}${row.reason ? ` | ${row.reason}` : ''}`, row.id);
      }
      sum.filesDeleted++;
    }

    // 3. Flag rows whose file is missing. Their path is freed (moved under _deleted/) when it was top level,
    //    so a new "Screenshot (N).png" with a reused number is not mistaken for a known file.
    const flag = db.prepare(`UPDATE match_scoreboards SET status = ?, reason = ?, file_path = ? WHERE id = ?`);
    for (const r of missing) {
      if (deleteSet.has(r.file_path)) continue;
      const status = r.status === 'unmatched' || r.status === 'error' ? 'dismissed' : r.status;
      const freed = path.dirname(r.file_path) === root ? path.join(root, '_deleted', `${r.id} ${path.basename(r.file_path)}`) : r.file_path;
      if (apply) flag.run(status, `file missing ${today}${r.reason ? ` | ${r.reason}` : ''}`, freed, r.id);
      sum.rowsFlagged++;
    }
    if (apply) db.exec('COMMIT');
  } catch (e) {
    if (apply) { try { db.exec('ROLLBACK'); } catch { /* ignore */ } }
    throw e;
  }
  log(tag(`deleted ${sum.filesDeleted} files in _copies/_other (${sum.skippedNoRow} left: no DB row); flagged ${sum.rowsFlagged} missing-file rows`));

  // 4. Remove emptied old folders.
  for (const d of dayDirs) {
    const p = path.join(root, d);
    if (!apply) { if (fs.readdirSync(p).every(n => n === '.DS_Store' || plan.some(x => x.from === path.join(p, n)))) sum.foldersRemoved++; continue; }
    try { fs.rmSync(path.join(p, '.DS_Store'), { force: true }); fs.rmdirSync(p); sum.foldersRemoved++; } catch { log(`kept ${d}: not empty`); }
  }
  return sum;
}

function main() {
  const apply = process.argv.includes('--apply');
  const dbPath = path.resolve(arg('--db') ?? path.join(__dirname, '../../../data/overwatch.db'));
  const root = path.resolve(arg('--root') ?? process.env.SCOREBOARD_DIR ?? '/Users/Sean/OWScreenshots');
  const db = new DatabaseSync(dbPath, apply ? {} : { readOnly: true });
  if (apply) {
    db.exec('PRAGMA busy_timeout = 5000');
    const b = backupDb(db, path.resolve(arg('--backup-dir') ?? path.join(path.dirname(dbPath), 'backups')));
    console.log(`backup written: ${b}`);
  }
  console.log(`${apply ? 'APPLY' : 'DRY RUN'}  db=${dbPath}  root=${root}`);
  const s = migrate(db, root, apply);
  console.log(`summary: files moved ${s.filesMoved}, rows updated ${s.rowsUpdated}, files deleted ${s.filesDeleted}, rows flagged ${s.rowsFlagged}, folders removed ${s.foldersRemoved}`);
  db.close();
}
if (require.main === module) main();
