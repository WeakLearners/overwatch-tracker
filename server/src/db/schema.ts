import { DatabaseSync } from 'node:sqlite';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.join(__dirname, '../../../data/overwatch.db');

let _db: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!_db) {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    _db = new DatabaseSync(DB_PATH);
    initSchema(_db);
  }
  return _db;
}

function initSchema(db: DatabaseSync) {
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS matches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      time TEXT,
      day_of_week TEXT,
      hour INTEGER,
      hero TEXT NOT NULL,
      role TEXT NOT NULL,
      map TEXT NOT NULL,
      game_type TEXT NOT NULL,
      win INTEGER NOT NULL CHECK(win IN (0, 1)),
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(date);
    CREATE INDEX IF NOT EXISTS idx_matches_hero ON matches(hero);
    CREATE INDEX IF NOT EXISTS idx_matches_map ON matches(map);
  `);

  // Safe migration: add deaths column if it doesn't exist yet
  const cols = db.prepare(`PRAGMA table_info(matches)`).all() as { name: string }[];
  if (!cols.find(c => c.name === 'deaths')) {
    db.exec(`ALTER TABLE matches ADD COLUMN deaths TEXT`);
  }

  // queue_mode: 'qp_role' | 'comp_role' | 'comp_open'.
  // Backfill existing rows as 'comp_role' — that was the only mode played before this column existed.
  if (!cols.find(c => c.name === 'queue_mode')) {
    db.exec(`ALTER TABLE matches ADD COLUMN queue_mode TEXT`);
    db.exec(`UPDATE matches SET queue_mode = 'comp_role' WHERE queue_mode IS NULL`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_matches_queue_mode ON matches(queue_mode)`);
  }

  // Cache for LLM-generated tactical recommendations, keyed by map+queue_mode.
  db.exec(`
    CREATE TABLE IF NOT EXISTS advisor_cache (
      map TEXT NOT NULL,
      queue_mode TEXT NOT NULL,
      primary_hero TEXT NOT NULL,
      stretch_hero TEXT,
      focus_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (map, queue_mode)
    )
  `);
}
