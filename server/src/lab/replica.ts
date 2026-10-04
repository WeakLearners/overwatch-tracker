// Lab replica: builds a throwaway in-memory SQLite copy of the tracker data the
// nightly analysis reads, filled ONLY through lab/client.ts (the v1 export API).
// The analysis code (stagePointsFor, baselineFor, computeAnalysis and so on)
// takes a db handle, so a replica lets it run unchanged and produce the same
// numbers as it did against the tracker's own file. This module must never
// import db/schema; it declares only the columns the lab reads, which is the
// lab's side of the contract. A column the tracker stops exporting reads null.
import { DatabaseSync } from 'node:sqlite';
import type { LabClient } from './client';

interface TableSpec { cols: string[]; pk: string[] }

// Primary keys mirror the tracker's, so scans and joins resolve the same way.
export const TABLES: Record<string, TableSpec> = {
  matches: {
    pk: ['id'],
    cols: ['id', 'time', 'date', 'hero', 'win', 'sens', 'dpi', 'blind_trial', 'queue_mode', 'crashed',
      'curve_enabled', 'curve_growth_rate', 'curve_midpoint', 'curve_motivity', 'curve_lut', 'leaver', 'leaver_side',
      'created_at',
      // Added in slice 5c for the dashboard readers (aimAnalysis, statsLab, advisor).
      'role', 'map', 'game_type', 'day_of_week', 'hour', 'feel', 'notes', 'blind_set_id', 'stage_index',
      'team_rating', 'match_quality', 'result_driver'],
  },
  match_heroes: { pk: ['match_id', 'slot'], cols: ['match_id', 'slot', 'hero', 'role', 'sens', 'feel'] },
  aim_stats: {
    pk: ['match_id'],
    cols: ['match_id', 'overall_acc', 'crit_acc', 'hero_stat_label', 'hero_stat_value', 'damage', 'healing', 'elims',
      'deaths', 'assists', 'final_blows', 'duration_min', 'created_at'],
  },
  aim_stats_heroes: {
    pk: ['match_id', 'hero'],
    cols: ['match_id', 'hero', 'overall_acc', 'crit_acc', 'extra_acc', 'torpedo_damage', 'torpedo_healing', 'duration_min'],
  },
  blind_stage_sets: { pk: ['id'], cols: ['id', 'hero', 'phase', 'batch_size', 'cur_rel', 'chunk_size', 'active'] },
  blind_stages: { pk: ['set_id', 'stage_index'], cols: ['set_id', 'stage_index', 'sens', 'dpi'] },
  blind_credits: {
    pk: ['match_id', 'hero'],
    cols: ['match_id', 'hero', 'blind_set_id', 'stage_index', 'counts_result', 'counts_minutes'],
  },
  curve_params: {
    pk: ['id'],
    cols: ['id', 'smooth', 'input', 'output', 'lut_steps', 'lut_max_speed', 'lut_points'],
  },
};

function create(db: DatabaseSync): void {
  for (const [name, t] of Object.entries(TABLES)) {
    db.exec(`CREATE TABLE ${name} (${t.cols.join(', ')}, PRIMARY KEY (${t.pk.join(', ')}))`);
  }
  // Lab-side copy of the tracker's matches_by_hero view, limited to the columns
  // the lab reads (the advisor's test-pick). The share rule below must stay
  // textually the same as the tracker's (db/schema.ts); an equivalence test
  // compares the two on a fixture that includes a mid-match switch.
  db.exec(`
    CREATE VIEW matches_by_hero AS
    SELECT m.id, m.date, mh.hero, mh.role, m.map, m.game_type, m.win, m.queue_mode, mh.sens, mh.slot
    FROM matches m JOIN match_heroes mh ON mh.match_id = m.id
    LEFT JOIN aim_stats_heroes ash ON ash.match_id = m.id AND ash.hero = mh.hero
    WHERE ash.duration_min IS NULL
       OR ash.duration_min * 3 >= (
         SELECT SUM(a2.duration_min) FROM aim_stats_heroes a2 WHERE a2.match_id = m.id
       )
  `);
}

function insert(db: DatabaseSync, table: string, rows: Record<string, any>[]): void {
  const t = TABLES[table];
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO ${table} (${t.cols.join(', ')}) VALUES (${t.cols.map(c => ':' + c).join(', ')})`,
  );
  for (const r of rows) {
    const p: Record<string, any> = {};
    for (const c of t.cols) p[c] = r[c] ?? null;
    stmt.run(p);
  }
}

export async function buildReplica(client: LabClient): Promise<DatabaseSync> {
  const matches = await client.matches({ fields: TABLES.matches.cols.filter(c => c !== 'id') });
  const aim = await client.aim();
  const exp = await client.experiments();
  const curve = await client.curve();

  const db = new DatabaseSync(':memory:');
  create(db);
  db.exec('BEGIN');
  try {
    insert(db, 'matches', matches);
    insert(db, 'match_heroes', matches.flatMap(m => (m.heroes ?? []).map((h: any) => ({ ...h, match_id: m.id }))));
    insert(db, 'aim_stats', aim);
    insert(db, 'aim_stats_heroes', aim.flatMap(a => (a.heroes ?? []).map((h: any) => ({ ...h, match_id: a.match_id }))));
    insert(db, 'blind_stage_sets', exp.sets);
    insert(db, 'blind_stages', exp.stages);
    insert(db, 'blind_credits', exp.credits);
    if (curve.curve) insert(db, 'curve_params', [curve.curve]);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return db;
}
