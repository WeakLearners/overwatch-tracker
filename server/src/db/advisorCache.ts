// Tracker-side storage for the advisor's LLM cache (table advisor_cache). The
// advisor (routes/advisor.ts, lab side) owns the data but does not import
// db/schema, so index.ts hands it this store. Stage 2: the lab gets its own
// storage and this file moves with it.
import { getDb } from './schema';
import type { AdvisorCacheStore } from '../routes/advisor';

export const sqliteAdvisorCache: AdvisorCacheStore = {
  read(map, mode) {
    const row = getDb().prepare(`
      SELECT focus_json, created_at
      FROM advisor_cache WHERE map = ? AND queue_mode = ?
    `).get(map, mode) as { focus_json: string; created_at: string } | undefined;
    return row ?? null;
  },
  write(map, mode, primaryHero, stretchHero, focusJson) {
    getDb().prepare(`
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
