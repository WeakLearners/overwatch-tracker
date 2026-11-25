// Own storage for the advisor's LLM cache (table advisor_cache). This file does
// not import db/schema: schema.getDb() runs the tracker migrations on open, and
// after the Stage 2 split a lab copy of this file must never do that to the
// live match database (CISO S4). The cache lives in its own small SQLite file,
// opened lazily, one shared connection. It is only a cache and refills on demand.
import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';
import type { AdvisorCacheStore } from '../routes/advisor';

// Same default data folder as db/schema.ts (<repo>/data), overridable by file.
const DEFAULT_PATH = path.join(__dirname, '../../../data/advisor-cache.db');
const cachePath = () => process.env.ADVISOR_CACHE_DB_PATH || DEFAULT_PATH;

let db: DatabaseSync | null = null;

function open(): DatabaseSync {
  if (db) return db;
  const file = cachePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  d.exec('PRAGMA journal_mode = WAL');
  d.exec(`
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
  db = d;
  return d;
}

/** Close the shared connection so the next call reopens (tests, path changes). */
export function closeAdvisorCache(): void {
  if (db) { db.close(); db = null; }
}

export const sqliteAdvisorCache: AdvisorCacheStore = {
  read(map, mode) {
    const row = open().prepare(`
      SELECT focus_json, created_at
      FROM advisor_cache WHERE map = ? AND queue_mode = ?
    `).get(map, mode) as { focus_json: string; created_at: string } | undefined;
    return row ?? null;
  },
  write(map, mode, primaryHero, stretchHero, focusJson) {
    open().prepare(`
      INSERT INTO advisor_cache (map, queue_mode, primary_hero, stretch_hero, focus_json, created_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(map, queue_mode) DO UPDATE SET
        primary_hero = excluded.primary_hero,
        stretch_hero = excluded.stretch_hero,
        focus_json   = excluded.focus_json,
        created_at   = excluded.created_at
    `).run(map, mode, primaryHero, stretchHero, focusJson);
  },
};
