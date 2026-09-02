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
  `);

  // Everything below is schema setup + one-time data migrations, run on every
  // startup. Wrapped in a single transaction so a crash/restart partway
  // through can't leave things partially applied — e.g. a column ALTERed in
  // but its one-time backfill UPDATE never run (the guard below only checks
  // column presence, so a skipped backfill would otherwise be silently
  // abandoned forever), or the feel ×10 rescale (guarded by PRAGMA
  // user_version) committing its UPDATEs without the version bump and
  // re-applying a second time on the next start. SQLite's DDL (CREATE TABLE,
  // ALTER TABLE, CREATE INDEX) and PRAGMA user_version are both transactional,
  // so this is safe to wrap as a whole.
  db.exec('BEGIN');
  try {
  db.exec(`
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

  // curve_growth_rate / curve_midpoint / curve_motivity: Rawaccel curve params
  // active when the match was played (see lib/curveParams.ts's getCurveParams
  // — editable in-app since 2026-09-01, was hardcoded constants before that).
  // Originally a Motivity (sigmoid) curve — growth_rate/midpoint/motivity;
  // switched to Rawaccel's Jump (step) curve on 2026-09-01, whose real params
  // are Smooth/Input/Output, stored in these same three columns (renaming a
  // live SQLite column isn't worth the risk, and the columns were never
  // exposed outside this app). Rows logged 2026-08-25 through 2026-08-31 hold
  // real Motivity values; rows from 2026-09-01 on hold Jump values instead —
  // treat this column's meaning as dependent on when the row was logged. Null
  // on every row logged before the mouse-acceleration testing phase started —
  // no backfill, since flat per-hero sens (no curve at all) isn't a curve
  // value of "0", it's the absence of one.
  if (!cols.find(c => c.name === 'curve_growth_rate')) {
    db.exec(`ALTER TABLE matches ADD COLUMN curve_growth_rate REAL`);
  }
  if (!cols.find(c => c.name === 'curve_midpoint')) {
    db.exec(`ALTER TABLE matches ADD COLUMN curve_midpoint REAL`);
  }
  if (!cols.find(c => c.name === 'curve_motivity')) {
    db.exec(`ALTER TABLE matches ADD COLUMN curve_motivity REAL`);
  }

  // curve_enabled: whether mouse acceleration was actually active for this
  // match — ground truth, distinct from curve_growth_rate/curve_midpoint
  // above. Those two got stamped with the same constant on every match
  // logged from 2026-08-25 onward regardless of whether acceleration was
  // really on, which made them useless as a signal. Column added here
  // (matches table is defined this early); one-time backfill deferred until
  // after blind_stage_sets/blind_credits exist — see below, near the end of
  // this function.
  const needsCurveEnabledBackfill = !cols.find(c => c.name === 'curve_enabled');
  if (needsCurveEnabledBackfill) {
    db.exec(`ALTER TABLE matches ADD COLUMN curve_enabled INTEGER NOT NULL DEFAULT 0`);
  }

  // DPI stage-trial bookkeeping. blind_trial flags a match logged while a
  // stage-trial set was active for its hero; blind_set_id + stage_index say
  // which set/stage. The stage's DPI is shown on screen the whole time — there
  // is no hiding or reveal step. rel_pos and revealed are unused leftovers from
  // an earlier hidden-DPI design and are kept only because dropping columns
  // from a live SQLite DB isn't worth the risk; nothing reads or writes them
  // meaningfully anymore.
  for (const [col, ddl] of [
    ['blind_trial', `ALTER TABLE matches ADD COLUMN blind_trial INTEGER DEFAULT 0`],
    ['blind_set_id', `ALTER TABLE matches ADD COLUMN blind_set_id INTEGER`],
    ['rel_pos', `ALTER TABLE matches ADD COLUMN rel_pos INTEGER`],
    ['stage_index', `ALTER TABLE matches ADD COLUMN stage_index INTEGER`],
    ['revealed', `ALTER TABLE matches ADD COLUMN revealed INTEGER DEFAULT 0`],
  ] as const) {
    if (!cols.find(c => c.name === col)) db.exec(ddl);
  }
  // No startup backfill for revealed — it's a confirmed-dead leftover from
  // an earlier hidden-DPI design (nothing reads it), so there's no reason to
  // scan and rewrite the whole matches table on every app start to keep it
  // "correct."

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

  // healing: endgame scoreboard total, support heroes only (2026-08-08, added
  // alongside per-hero accuracy below). Sits with the other combat-output
  // columns above rather than per-hero — it's one match-level scoreboard
  // number, same as elims/deaths/damage.
  if (!aimCols.find(c => c.name === 'healing')) {
    db.exec(`ALTER TABLE aim_stats ADD COLUMN healing INTEGER`);
  }

  // assists: endgame scoreboard total, support heroes only (same rationale as
  // healing above) — sits alongside it as another match-level combat-output number.
  if (!aimCols.find(c => c.name === 'assists')) {
    db.exec(`ALTER TABLE aim_stats ADD COLUMN assists INTEGER`);
  }

  // aim_stats_heroes: one accuracy reading per hero actually played in the
  // match (mirrors match_heroes — see there for why a match can have more
  // than one hero). aim_stats.overall_acc/crit_acc above are kept for
  // existing rows (harmless, additive-only) but are no longer written to —
  // this table is the column of record for accuracy going forward, entered
  // once per hero rather than once per match. hero_stat_label/value and the
  // combat totals stay match-level on aim_stats; those are the endgame
  // scoreboard, not per-hero.
  db.exec(`
    CREATE TABLE IF NOT EXISTS aim_stats_heroes (
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      hero TEXT NOT NULL,
      overall_acc REAL,
      crit_acc REAL,
      PRIMARY KEY (match_id, hero)
    )
  `);

  // duration_min: how long THIS hero was actually played, entered per hero
  // row in the Aim Stats form (a mid-match switch can leave one hero on
  // screen for 2 minutes and another for 15 — a single match-wide duration
  // hid that). aim_stats.duration_min stays the column of record for the
  // match-total rate stats (damage/elims/final_blows per 10 min are still
  // match-level scoreboard totals) — it's kept in sync as the sum of the
  // per-hero durations below, not replaced by them.
  const heroCols = db.prepare(`PRAGMA table_info(aim_stats_heroes)`).all() as { name: string }[];
  if (!heroCols.find(c => c.name === 'duration_min')) {
    db.exec(`ALTER TABLE aim_stats_heroes ADD COLUMN duration_min INTEGER`);
  }

  // extra_acc: optional 4th accuracy reading for heroes whose kit needs more
  // than overall/crit to describe (Sojourn's Charged Shot Crit %, Soldier: 76's
  // Helix Rocket %, ...) — the label is chosen per hero in the form, this
  // column just holds whatever number that hero's 4th field produced.
  if (heroCols.find(c => c.name === 'charged_crit_acc') && !heroCols.find(c => c.name === 'extra_acc')) {
    db.exec(`ALTER TABLE aim_stats_heroes RENAME COLUMN charged_crit_acc TO extra_acc`);
  } else if (!heroCols.find(c => c.name === 'extra_acc')) {
    db.exec(`ALTER TABLE aim_stats_heroes ADD COLUMN extra_acc REAL`);
  }

  db.exec(`
    INSERT INTO aim_stats_heroes (match_id, hero, overall_acc, crit_acc, duration_min)
    SELECT a.match_id, m.hero, a.overall_acc, a.crit_acc, a.duration_min
    FROM aim_stats a JOIN matches m ON m.id = a.match_id
    WHERE a.match_id NOT IN (SELECT match_id FROM aim_stats_heroes)
  `);
  // One-time carry-forward for rows already backfilled above (before this
  // column existed) — only safe for single-hero matches, where the old
  // match-total duration unambiguously belongs to that one hero.
  db.exec(`
    UPDATE aim_stats_heroes SET duration_min = (
      SELECT a.duration_min FROM aim_stats a WHERE a.match_id = aim_stats_heroes.match_id
    )
    WHERE duration_min IS NULL
      AND match_id IN (SELECT match_id FROM aim_stats_heroes GROUP BY match_id HAVING COUNT(*) = 1)
      AND EXISTS (SELECT 1 FROM aim_stats a WHERE a.match_id = aim_stats_heroes.match_id AND a.duration_min IS NOT NULL)
  `);

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

  // team_rating: perceived teammate quality, 0–5 stars in half-star steps.
  // Captured live in the Match Log alongside feel, same rationale: the
  // impression fades fast, so it has to be logged in the moment.
  if (!cols.find(c => c.name === 'team_rating')) {
    db.exec(`ALTER TABLE matches ADD COLUMN team_rating REAL`);
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

  // match_heroes: which hero(es) were actually played during a match, in
  // order (slot 1 = the hero the match started on, 2/3 = switches made
  // mid-match). matches.hero/role stay the column of record for slot 1 (every
  // existing query keeps working unchanged); this table is additive-only and
  // exists so by-hero stats can attribute a match's win/loss to every hero
  // played, not just the first. Backfilled once per hero-less legacy row below
  // — the WHERE NOT IN guard makes this a no-op on every later start.
  db.exec(`
    CREATE TABLE IF NOT EXISTS match_heroes (
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      slot INTEGER NOT NULL CHECK(slot IN (1, 2, 3)),
      hero TEXT NOT NULL,
      role TEXT NOT NULL,
      PRIMARY KEY (match_id, slot)
    );
    CREATE INDEX IF NOT EXISTS idx_match_heroes_hero ON match_heroes(hero);
  `);
  db.exec(`
    INSERT INTO match_heroes (match_id, slot, hero, role)
    SELECT id, 1, hero, role FROM matches
    WHERE id NOT IN (SELECT match_id FROM match_heroes WHERE slot = 1)
  `);

  // feel: same per-hero split as aim_stats_heroes.duration_min above, for the
  // same reason — a mid-match switch means the sens felt a certain way on one
  // hero and possibly differently on another, so one match-wide value hid
  // that. Captured once per hero actually played (LogMatch's Feel slider),
  // rather than once per match. matches.feel stays the column of record for
  // the *tested* hero specifically (slot 1 — the hero a stage-test set's
  // hero lookup in matches.ts is always keyed on) since blind.ts's per-stage
  // feelMean/feelVar reads it directly; this table is what per-hero analysis
  // (aim.ts /analysis) reads instead of duplicating matches.feel across every
  // hero in a switch match.
  const mhCols = db.prepare(`PRAGMA table_info(match_heroes)`).all() as { name: string }[];
  if (!mhCols.find(c => c.name === 'feel')) {
    db.exec(`ALTER TABLE match_heroes ADD COLUMN feel INTEGER`);
    db.exec(`
      UPDATE match_heroes SET feel = (
        SELECT m.feel FROM matches m WHERE m.id = match_heroes.match_id
      )
      WHERE slot = 1 AND feel IS NULL
        AND EXISTS (SELECT 1 FROM matches m WHERE m.id = match_heroes.match_id AND m.feel IS NOT NULL)
    `);
  }

  // sens: per-hero, same split as feel above and for a sharper reason — in
  // Overwatch, sensitivity is a genuinely independent per-hero setting (unlike
  // DPI, which is a single hardware value), so a mid-match switch really was
  // played at two different sens values, not just perceived differently at
  // one. matches.sens stays the column of record for slot 1 (the hero a
  // stage-test's lookup is keyed on — see findActiveStage in matches.ts),
  // since blind.ts/aim.ts's legacy per-match reads still key off it; this
  // column is what per-hero analysis (aim.ts /analysis) and matches_by_hero
  // read instead of duplicating matches.sens across every hero in a switch.
  // Backfilled for slot 1 only (that value was always correct); slots 2/3 on
  // existing rows are backfilled separately, once, by a one-off script
  // (scripts/backfill-hero-sens — see its header) that reconstructs each
  // historical switch-hero's real sens from the surrounding credited matches
  // for that same hero, rather than guessing here. Left NULL where that
  // reconstruction couldn't resolve one confidently — NULL correctly drops
  // those rows out of per-hero sens analysis instead of attributing them to
  // a sens they were never confirmed to have been played at.
  if (!mhCols.find(c => c.name === 'sens')) {
    db.exec(`ALTER TABLE match_heroes ADD COLUMN sens REAL`);
    db.exec(`
      UPDATE match_heroes SET sens = (
        SELECT m.sens FROM matches m WHERE m.id = match_heroes.match_id
      )
      WHERE slot = 1 AND sens IS NULL
        AND EXISTS (SELECT 1 FROM matches m WHERE m.id = match_heroes.match_id AND m.sens IS NOT NULL)
    `);
  }

  // matches_by_hero: one row per (match, hero played) — the hero-attribution
  // view every by-hero stats query reads from instead of `matches` directly,
  // so a match with a mid-match switch counts toward every hero it touched.
  // Recreated on every start (cheap) rather than migrated, so it always
  // reflects whatever columns `matches` currently has. sens comes from
  // match_heroes (per hero), not matches (primary hero only) — see the sens
  // column comment above.
  db.exec(`DROP VIEW IF EXISTS matches_by_hero`);
  db.exec(`
    CREATE VIEW matches_by_hero AS
    SELECT m.id, m.date, m.time, m.day_of_week, m.hour, mh.hero, mh.role, m.map, m.game_type, m.win,
           m.created_at, m.deaths, m.queue_mode, mh.sens, m.dpi, m.blind_trial, m.blind_set_id,
           m.rel_pos, m.stage_index, m.revealed, m.feel, m.team_rating, m.notes, mh.slot
    FROM matches m JOIN match_heroes mh ON mh.match_id = m.id
  `);

  // DPI stage-trial sets. Each set is N DPI values (blind_stages: stage_index →
  // dpi) shown plainly on screen — no hiding, no shuffle. The player types
  // those values into the mouse in order, plays batch_size games per stage
  // (games_on_stage counts toward it), then advances cur_rel to the next stage.
  // Several sets can be active at once (one per hero, plus at most one ad-hoc
  // set) so heroes can be tested in parallel. scramble_done, resolved,
  // revealed_slot, last_click_count are unused leftovers from an earlier
  // hidden-DPI design, kept only because dropping columns from a live SQLite DB
  // isn't worth the risk.
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

  // blind_credits: one row per (match, hero) that actually counted toward a
  // DPI/sens stage-test — the source of truth for games_on_stage/totalGames,
  // instead of matches.blind_set_id. matches.blind_set_id only ever tracked
  // slot 1 (the hero the match started on), so a hero played only as a
  // mid-match switch (match_heroes slot 2/3) never credited its own active
  // test even though it was genuinely played at that hero's current stage.
  // matches.blind_set_id/stage_index/sens/dpi/blind_trial stay as-is (still
  // slot 1's credit, read directly by other code); this table adds the
  // credits those columns structurally can't hold — one match can now credit
  // more than one hero's set at once.
  db.exec(`
    CREATE TABLE IF NOT EXISTS blind_credits (
      match_id INTEGER NOT NULL REFERENCES matches(id) ON DELETE CASCADE,
      hero TEXT NOT NULL,
      blind_set_id INTEGER NOT NULL REFERENCES blind_stage_sets(id) ON DELETE CASCADE,
      stage_index INTEGER NOT NULL,
      PRIMARY KEY (match_id, hero)
    );
    CREATE INDEX IF NOT EXISTS idx_blind_credits_set ON blind_credits(blind_set_id);
  `);
  // Backfill slot-1 credits for every match logged before this table existed,
  // so existing sets' totalGames/games_on_stage counts don't shift under
  // them the moment this ships — same 1:1 primary-hero attribution as today.
  db.exec(`
    INSERT OR IGNORE INTO blind_credits (match_id, hero, blind_set_id, stage_index)
    SELECT id, hero, blind_set_id, stage_index FROM matches
    WHERE blind_set_id IS NOT NULL AND stage_index IS NOT NULL
  `);

  // One-time curve_enabled backfill (column added earlier, above — deferred
  // to here since it needs blind_credits/blind_stage_sets to exist). Phase 7
  // (2026-08-26 to 2026-08-31, phase key 'custom-1787763963436') was played
  // with mouse acceleration genuinely on — confirmed 2026-08-31 — and is the
  // only window it's ever been on, so its credited matches are the only rows
  // that get curve_enabled=1; everything else defaults to 0 from the ALTER
  // TABLE above and needs no explicit UPDATE.
  if (needsCurveEnabledBackfill) {
    db.exec(`
      UPDATE matches SET curve_enabled = 1
      WHERE id IN (
        SELECT bc.match_id FROM blind_credits bc
        JOIN blind_stage_sets bss ON bss.id = bc.blind_set_id
        WHERE bss.phase = 'custom-1787763963436'
      )
    `);
  }

  // sens: per-stage varying in-game sensitivity, added when mouse DPI was
  // locked at 1600 permanently (2026-08-08) in favor of testing finer sens
  // increments instead (the mouse config app floored DPI at 50-unit steps).
  // Null on stages from sets created before the lock (those vary dpi instead,
  // with sens frozen at blind_stage_sets.in_game_sens); populated on stages
  // from sets created after — dpi on those rows is just the fixed 1600
  // constant. Which axis a set varies is inferred per-stage from whether this
  // column is null, not stored as a separate flag.
  const stageCols = db.prepare(`PRAGMA table_info(blind_stages)`).all() as { name: string }[];
  if (!stageCols.find(c => c.name === 'sens')) {
    db.exec(`ALTER TABLE blind_stages ADD COLUMN sens REAL`);
  }

  // sens_low / sens_high (2026-08-31 through 2026-09-01 only): a short-lived
  // "ranged" Motivity-curve stage design — floor/ceiling instead of one flat
  // sens value. Superseded the same day by a switch to Rawaccel's Jump curve,
  // which needs no derived range at all (Jump's two settings ARE two flat
  // sens values, tested the normal way). No real games were ever logged
  // against a ranged stage (only a smoketest set, deleted). Left as dead,
  // always-null columns on any DB that already ran the old migration —
  // dropping columns from a live SQLite table isn't worth the risk for
  // columns nothing reads anymore.

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
    // Optional phase tag: which SensLog.tsx plan tab (PlanTab.key) this set
    // was created from — e.g. 'phase2' or a generated 'custom-<timestamp>'.
    // Null for ad-hoc sets (CreateTestCard) and for every set created before
    // this column existed. Lets statusForHero scope a set to its own phase
    // instead of matching any historical set with the same hero/values,
    // which let an unrelated completed round from an earlier phase read as
    // "already completed" for a brand-new phase that reused the same
    // bracket (see 2026-08-26 log). Sets from before this column existed
    // are intentionally left untagged rather than backfilled — the four
    // legacy PLAN_TABS reference phases keep matching by shape alone.
    ['phase', `ALTER TABLE blind_stage_sets ADD COLUMN phase TEXT`],
    // curve_enabled: whether mouse acceleration (Rawaccel's Motivity curve)
    // was on for this ENTIRE set — a phase-wide constant chosen when the set
    // is created, same as in_game_sens defaulting the fallback value, not a
    // per-match toggle. Matches credited to an active set with this flag set
    // get curve_enabled/curve_growth_rate/curve_midpoint auto-stamped from
    // it server-side (routes/matches.ts findActiveStage), the same way
    // dpi/sens already are — LogMatch's manual toggle only matters when no
    // active set governs the match at all. Default 0 (existing sets/phases
    // predate this and were never accel-tested, except Phase 7 below).
    ['curve_enabled', `ALTER TABLE blind_stage_sets ADD COLUMN curve_enabled INTEGER NOT NULL DEFAULT 0`],
  ] as const) {
    if (!setCols.find(c => c.name === col)) db.exec(ddl);
  }
  // One-time retroactive fix: Phase 7 (phase key 'custom-1787763963436') was
  // genuinely played with acceleration on for its entire run (confirmed
  // 2026-08-31 — see the curve_enabled backfill on matches above), so its
  // sets should read as accel-on too, not just the individual matches.
  db.exec(`UPDATE blind_stage_sets SET curve_enabled = 1 WHERE phase = 'custom-1787763963436' AND curve_enabled = 0`);

  // Custom DPI/sens test-plan phases, built through SensLog.tsx's "+ Add new
  // phase" form. Previously persisted to browser localStorage (session-only,
  // never synced across devices) — moved server-side 2026-08-30 so a phase
  // built on one device shows up everywhere, same as the hardcoded PLAN_TABS
  // phases already do. `key` matches the `phase` tag on blind_stage_sets
  // (e.g. 'custom-1787763963436'); `plan` is the PlanHero[] array as JSON.
  db.exec(`
    CREATE TABLE IF NOT EXISTS custom_phases (
      key TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      description TEXT NOT NULL,
      plan TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  // curve_enabled: same phase-wide "was acceleration on" flag as
  // blind_stage_sets above, mirrored here so the "+ Add new phase" form and
  // phase-tab display can show/set it without needing to inspect a set that
  // may not exist yet. The two flags are set together whenever this skill's
  // phase-builder creates sets for a phase's roster (setBodyFor in
  // SensLog.tsx passes the phase's curve_enabled into every hero's set).
  const customPhaseCols = db.prepare(`PRAGMA table_info(custom_phases)`).all() as { name: string }[];
  if (!customPhaseCols.find(c => c.name === 'curve_enabled')) {
    db.exec(`ALTER TABLE custom_phases ADD COLUMN curve_enabled INTEGER NOT NULL DEFAULT 0`);
    db.exec(`UPDATE custom_phases SET curve_enabled = 1 WHERE key = 'custom-1787763963436'`);
  }

  // curve_params: the Rawaccel Jump-curve settings Sean is actually running
  // right now — Smooth/Input/Output, editable from the "Mouse acceleration
  // curve" card on the testing page (GET/PUT /api/aim/curve, lib/curveParams.ts)
  // instead of being hardcoded constants. Single row, id fixed at 1. No row
  // yet (fresh install, or before this table existed) falls back to
  // lib/curveParams.ts's DEFAULT_CURVE_* — see getCurveParams there.
  db.exec(`
    CREATE TABLE IF NOT EXISTS curve_params (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      smooth REAL NOT NULL,
      input REAL NOT NULL,
      output REAL NOT NULL
    )
  `);

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
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
