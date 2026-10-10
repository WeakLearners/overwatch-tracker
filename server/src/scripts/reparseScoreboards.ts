// One-off backfill (2026-10-09, Addendum 2): re-read stored 'not_scoreboard' images
// with the three-page classifier. Rows are updated IN PLACE (file_path is UNIQUE and
// ids are referenced), in file_mtime order so a Summary page opens its group before
// the pages that follow. Only rows whose status is 'not_scoreboard' are touched, and
// never a matches row.
//
// Usage (from server/, needs ANTHROPIC_API_KEY from server/.env; back up the DB first):
//   tsx --experimental-sqlite src/scripts/reparseScoreboards.ts 7 13 15 16
import path from 'path';
import dotenv from 'dotenv';
import fs from 'fs';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });
import { getDb } from '../db/schema';
import { processFile, callVision } from '../lib/scoreboard';
import { finalizeGroups } from '../lib/scoreboardPages';
import { organizeAll } from '../lib/scoreboardOrganize';
import { scoreboardDir } from '../lib/scoreboardWatcher';

async function main() {
  const ids = process.argv.slice(2).map(Number).filter(Number.isInteger);
  if (!ids.length) { console.error('give board ids'); process.exit(2); }
  const db = getDb();
  const rows = (db.prepare(`SELECT id, file_path, file_mtime, status FROM match_scoreboards WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY file_mtime, id`).all(...ids) as unknown as { id: number; file_path: string; file_mtime: string; status: string }[]);
  for (const r of rows) {
    if (r.status !== 'not_scoreboard') { console.log(`board ${r.id}: status ${r.status}, skipped`); continue; }
    if (!fs.existsSync(r.file_path)) { console.log(`board ${r.id}: file missing, skipped`); continue; }
    const out = await processFile(db, r.file_path, Date.parse(r.file_mtime), callVision, r.id);
    console.log(`board ${r.id}: ${out}`);
  }
  // The groups are old enough now: fill the empty aim fields and file the pages.
  console.log('groups filled:', finalizeGroups(db, Date.now()));
  const dir = scoreboardDir();
  console.log('files moved:', dir ? organizeAll(db, dir) : 'skipped (SCOREBOARD_DIR unset)');
}
main().catch(e => { console.error(e); process.exit(1); });
