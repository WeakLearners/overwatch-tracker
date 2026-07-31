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

  // sens: in-game mouse sensitivity used for the match (one value per match).
  // Written by the match logger; DPI is a fixed 1600 constant (see lib/aim.ts),
  // so sens alone determines eDPI and cm/360.
  if (!cols.find(c => c.name === 'sens')) {
    db.exec(`ALTER TABLE matches ADD COLUMN sens REAL`);
  }

  // dpi: per-match mouse DPI. Historically a fixed 1600 constant (see lib/aim.ts),
  // but blind-trial mode varies DPI while holding in-game sens frozen, so DPI is
  // now real per-match data. Legacy rows backfill to 1600 so eDPI/cm360 stay
  // identical for everything logged before blind mode existed.
  if (!cols.find(c => c.name === 'dpi')) {
    db.exec(`ALTER TABLE matches ADD COLUMN dpi INTEGER`);
    db.exec(`UPDATE matches SET dpi = 1600 WHERE dpi IS NULL`);
  }

  // Blind-trial bookkeeping. blind_trial flags a match whose sensitivity was set
  // via a hidden DPI stage. rel_pos is the mouse position RELATIVE to the
  // scramble start (clicks mod n) — the only thing known at log time, since the
  // absolute slot (and thus dpi) stays unknown until reveal back-solves the
  // offset. stage_index + dpi are filled in at reveal. revealed gates whether the
  // resolved dpi/sens may leave the API. Non-blind rows are revealed=1.
  for (const [col, ddl] of [
    ['blind_trial', `ALTER TABLE matches ADD COLUMN blind_trial INTEGER DEFAULT 0`],
    ['blind_set_id', `ALTER TABLE matches ADD COLUMN blind_set_id INTEGER`],
    ['rel_pos', `ALTER TABLE matches ADD COLUMN rel_pos INTEGER`],
    ['stage_index', `ALTER TABLE matches ADD COLUMN stage_index INTEGER`],
    ['revealed', `ALTER TABLE matches ADD COLUMN revealed INTEGER DEFAULT 0`],
  ] as const) {
    if (!cols.find(c => c.name === col)) db.exec(ddl);
  }
  db.exec(`UPDATE matches SET revealed = 1 WHERE revealed IS NULL OR blind_trial = 0 OR blind_trial IS NULL`);

  // Per-match aim stats for the sensitivity study. One-to-one with a match,
  // entered separately at match end via the /sens app.
  db.exec(`
    CREATE TABLE IF NOT EXISTS aim_stats (
      match_id INTEGER PRIMARY KEY REFERENCES matches(id) ON DELETE CASCADE,
      overall_acc REAL,
      crit_acc REAL,
      hero_stat_label TEXT,
      hero_stat_value REAL,
      feel INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      elims INTEGER,
      final_blows INTEGER,
      deaths INTEGER,
      damage INTEGER,
      duration_min INTEGER
    )
  `);

  // Combat-output columns (endgame scoreboard) — added to existing aim_stats
  // tables. elims/final_blows/damage measure output; deaths and duration_min
  // (whole minutes) let us normalize them into length-robust per-death and
  // per-minute rates for the sens→output→win chain.
  const aimCols = db.prepare(`PRAGMA table_info(aim_stats)`).all() as { name: string }[];
  for (const col of ['elims', 'final_blows', 'deaths', 'damage', 'duration_min']) {
    if (!aimCols.find(c => c.name === col)) {
      db.exec(`ALTER TABLE aim_stats ADD COLUMN ${col} INTEGER`);
    }
  }

  // feel: perceived sens speed, 0 (felt slow) to 100 (felt fast) — not a quality
  // rating. Captured live in the Match Log at log time (moved 2026-07-17 from a
  // combat-detail backfilled at /sens; that flow lost the sensation by the time
  // the next match started). Lives on the match itself, like sens/dpi, not on
  // aim_stats — it's an immediate perception, not a post-hoc combat stat. The
  // old aim_stats.feel column above is kept (harmless, additive-only migrations)
  // but no longer written to — this is the column of record going forward.
  if (!cols.find(c => c.name === 'feel')) {
    db.exec(`ALTER TABLE matches ADD COLUMN feel INTEGER`);
    // One-time carry-forward of anything already captured under the old flow.
    db.exec(`
      UPDATE matches SET feel = (SELECT feel FROM aim_stats WHERE aim_stats.match_id = matches.id)
      WHERE feel IS NULL AND EXISTS (
        SELECT 1 FROM aim_stats WHERE aim_stats.match_id = matches.id AND aim_stats.feel IS NOT NULL
      )
    `);
  }

  // Slider widened 0–10 → 0–100 (2026-07-31). Rescale every feel value already
  // on disk (both the column of record and the legacy aim_stats copy) ×10 so
  // old and new matches sit on the same scale for averages/analysis. Guarded
  // by PRAGMA user_version, not column presence, since the feel column already
  // exists by this point — this runs exactly once.
  const feelScaleVersion = (db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version;
  if (feelScaleVersion < 1) {
    db.exec(`UPDATE matches SET feel = feel * 10 WHERE feel IS NOT NULL`);
    db.exec(`UPDATE aim_stats SET feel = feel * 10 WHERE feel IS NOT NULL`);
    db.exec(`PRAGMA user_version = 1`);
  }

  // notes: freeform per-match note (fatigue, warmup, just switched stage, etc).
  // Captured live in the Match Log at log time (moved 2026-07-19 from a
  // combat-detail backfilled at /sens, same rationale as feel above — the
  // context is gone by the time aim stats get backfilled). Lives on the match
  // itself, like feel/sens/dpi, not on aim_stats. The old aim_stats.notes
  // column is kept (harmless, additive-only migrations) but no longer written
  // to — this is the column of record going forward.
  if (!cols.find(c => c.name === 'notes')) {
    db.exec(`ALTER TABLE matches ADD COLUMN notes TEXT`);
    // One-time carry-forward of anything already captured under the old flow.
    db.exec(`
      UPDATE matches SET notes = (SELECT notes FROM aim_stats WHERE aim_stats.match_id = matches.id)
      WHERE notes IS NULL AND EXISTS (
        SELECT 1 FROM aim_stats WHERE aim_stats.match_id = matches.id AND aim_stats.notes IS NOT NULL
      )
    `);
  }

  // Blind-trial stage sets. Each set is one shuffle of N DPI values across the
  // mouse's physical slots (blind_stages: slot stage_index → dpi). The player
  // types those values into the mouse, then "scrambles" (mashes the DPI button
  // uncounted) so neither they nor the app knows the absolute slot. From then on
  // the app tracks only cur_rel — the position RELATIVE to the scramble start —
  // and directs relative moves. batch_size games are played per stage before a
  // switch; games_on_stage counts toward it. At reveal the player reports the
  // currently-active slot, which back-solves the offset and resolves every
  // trial's true dpi at once (resolved=1, revealed_slot recorded).
  db.exec(`
    CREATE TABLE IF NOT EXISTS blind_stage_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      in_game_sens REAL NOT NULL,
      base_dpi INTEGER NOT NULL,
      active INTEGER NOT NULL DEFAULT 1,
      note TEXT,
      batch_size INTEGER NOT NULL DEFAULT 10,
      cur_rel INTEGER NOT NULL DEFAULT 0,
      games_on_stage INTEGER NOT NULL DEFAULT 0,
      scramble_done INTEGER NOT NULL DEFAULT 0,
      resolved INTEGER NOT NULL DEFAULT 0,
      revealed_slot INTEGER,
      last_click_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS blind_stages (
      set_id INTEGER NOT NULL REFERENCES blind_stage_sets(id) ON DELETE CASCADE,
      stage_index INTEGER NOT NULL,
      dpi INTEGER NOT NULL,
      pct_delta REAL,
      PRIMARY KEY (set_id, stage_index)
    );
  `);

  // Migrate blind_stage_sets created before the guided-loop columns existed.
  const setCols = db.prepare(`PRAGMA table_info(blind_stage_sets)`).all() as { name: string }[];
  for (const [col, ddl] of [
    ['batch_size', `ALTER TABLE blind_stage_sets ADD COLUMN batch_size INTEGER NOT NULL DEFAULT 10`],
    ['cur_rel', `ALTER TABLE blind_stage_sets ADD COLUMN cur_rel INTEGER NOT NULL DEFAULT 0`],
    ['games_on_stage', `ALTER TABLE blind_stage_sets ADD COLUMN games_on_stage INTEGER NOT NULL DEFAULT 0`],
    ['scramble_done', `ALTER TABLE blind_stage_sets ADD COLUMN scramble_done INTEGER NOT NULL DEFAULT 0`],
    ['resolved', `ALTER TABLE blind_stage_sets ADD COLUMN resolved INTEGER NOT NULL DEFAULT 0`],
    ['revealed_slot', `ALTER TABLE blind_stage_sets ADD COLUMN revealed_slot INTEGER`],
    ['last_click_count', `ALTER TABLE blind_stage_sets ADD COLUMN last_click_count INTEGER NOT NULL DEFAULT 0`],
    // Optional hero tag: which hero's dedicated block this set represents
    // (e.g. a Phase 2 per-hero card). Null for sets created ad hoc.
    ['hero', `ALTER TABLE blind_stage_sets ADD COLUMN hero TEXT`],
  ] as const) {
    if (!setCols.find(c => c.name === col)) db.exec(ddl);
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
