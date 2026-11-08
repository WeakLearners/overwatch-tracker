import type { getDb } from '../db/schema';

// Tracker-side key/value settings (table app_settings). Values are text; the
// callers parse. A missing key reads as null, never as a default, so the caller
// decides what "never set" means.
type Db = ReturnType<typeof getDb>;

export function getSetting(db: Db, key: string): string | null {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = :key').get({ key }) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare(`
    INSERT INTO app_settings (key, value) VALUES (:key, :value)
    ON CONFLICT(key) DO UPDATE SET value = :value, updated_at = datetime('now')
  `).run({ key, value });
}
