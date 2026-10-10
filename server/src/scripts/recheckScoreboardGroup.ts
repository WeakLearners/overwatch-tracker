// Free re-check of one scoreboard group from its stored Summary reading (no vision call).
// Usage (from server/): tsx --experimental-sqlite src/scripts/recheckScoreboardGroup.ts <groupId> [--dry-run]
// A real run first copies data/overwatch.db into data/backups/.
import path from 'path';
import fs from 'fs';
import { getDb, DB_PATH } from '../db/schema';
import { recheckGroup } from '../lib/scoreboard';

const args = process.argv.slice(2);
const dry = args.includes('--dry-run');
const gid = Number(args.find(a => /^\d+$/.test(a)));
if (!gid) { console.error('usage: recheckScoreboardGroup.ts <groupId> [--dry-run]'); process.exit(2); }
const db = getDb();
if (!dry) {
  const dbFile = DB_PATH;
  const dir = path.resolve(dbFile, '../backups');
  fs.mkdirSync(dir, { recursive: true });
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dest = path.join(dir, `overwatch-pre-recheck-group${gid}-${stamp}.db`);
  fs.copyFileSync(dbFile, dest);
  console.log('backup:', dest);
}
console.log(JSON.stringify(recheckGroup(db, gid, dry)));
