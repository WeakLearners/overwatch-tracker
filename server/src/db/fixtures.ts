// Tier 2 test fixtures: small, readable insert helpers for building DB-backed
// test scenarios against a temp DB (see schema.test.ts for the temp-file
// pattern). Not a .test.ts file itself — imported by the compute-function
// test suites in routes/*.test.ts and scripts/*.test.ts. Every helper takes
// an explicit db handle (never the module singleton) so callers stay bound
// to whatever temp file the test opened via getDb(tmpPath).
import type { getDb } from './schema';

type DB = ReturnType<typeof getDb>;

export interface MatchInput {
  date: string;
  time?: string | null;
  day_of_week?: string | null;
  hour?: number | null;
  hero: string;
  role: string;
  map?: string;
  game_type?: string;
  win: 0 | 1;
  queue_mode?: string | null;
  sens?: number | null;
  dpi?: number | null;
  feel?: number | null;
  blind_trial?: 0 | 1;
  blind_set_id?: number | null;
  stage_index?: number | null;
  // Rawaccel curve columns stamped per match (see matches.ts's insert). Named
  // curve_growth_rate/curve_midpoint/curve_motivity in the schema (legacy
  // names from an older curve model) but they hold smooth/input/output
  // respectively — see curveParams.ts and 2026-09-17's confound finding.
  curve_enabled?: 0 | 1;
  curve_growth_rate?: number | null;
  curve_midpoint?: number | null;
  curve_motivity?: number | null;
}

// Inserts a matches row. Does NOT insert the corresponding match_heroes
// slot-1 row — schema.ts only backfills that automatically for rows that
// existed before match_heroes was introduced; real app writes (matches.ts)
// insert both explicitly, so fixtures do the same via insertHeroSlot below.
export function insertMatch(db: DB, m: MatchInput): number {
  const info = db.prepare(`
    INSERT INTO matches (date, time, day_of_week, hour, hero, role, map, game_type, win, queue_mode, sens, dpi, feel, blind_trial, blind_set_id, stage_index, curve_enabled, curve_growth_rate, curve_midpoint, curve_motivity)
    VALUES (:date, :time, :day_of_week, :hour, :hero, :role, :map, :game_type, :win, :queue_mode, :sens, :dpi, :feel, :blind_trial, :blind_set_id, :stage_index, :curve_enabled, :curve_growth_rate, :curve_midpoint, :curve_motivity)
  `).run({
    date: m.date,
    time: m.time ?? null,
    day_of_week: m.day_of_week ?? null,
    hour: m.hour ?? null,
    hero: m.hero,
    role: m.role,
    map: m.map ?? 'Test Map',
    game_type: m.game_type ?? 'comp',
    win: m.win,
    queue_mode: m.queue_mode ?? null,
    sens: m.sens ?? null,
    dpi: m.dpi ?? null,
    feel: m.feel ?? null,
    blind_trial: m.blind_trial ?? 0,
    blind_set_id: m.blind_set_id ?? null,
    stage_index: m.stage_index ?? null,
    curve_enabled: m.curve_enabled ?? 0,
    curve_growth_rate: m.curve_growth_rate ?? null,
    curve_midpoint: m.curve_midpoint ?? null,
    curve_motivity: m.curve_motivity ?? null,
  });
  return Number(info.lastInsertRowid);
}

export interface HeroSlotInput {
  match_id: number;
  slot: 1 | 2 | 3;
  hero: string;
  role: string;
  feel?: number | null;
  sens?: number | null;
}

export function insertHeroSlot(db: DB, h: HeroSlotInput): void {
  db.prepare(`
    INSERT INTO match_heroes (match_id, slot, hero, role, feel, sens)
    VALUES (:match_id, :slot, :hero, :role, :feel, :sens)
  `).run({
    match_id: h.match_id, slot: h.slot, hero: h.hero, role: h.role,
    feel: h.feel ?? null, sens: h.sens ?? null,
  });
}

// Convenience: inserts a match plus its slot-1 match_heroes row together
// (the common case — a match played start-to-finish on one hero, no switch).
// sens on match_heroes defaults to the match's own sens field, matching how
// real matches.ts writes work.
export function insertSoloMatch(db: DB, m: MatchInput & { mhSens?: number | null }): number {
  const matchId = insertMatch(db, m);
  insertHeroSlot(db, {
    match_id: matchId, slot: 1, hero: m.hero, role: m.role,
    feel: m.feel ?? null, sens: m.mhSens !== undefined ? m.mhSens : (m.sens ?? null),
  });
  return matchId;
}

export interface AimStatsInput {
  match_id: number;
  overall_acc?: number | null;
  crit_acc?: number | null;
  hero_stat_label?: string | null;
  hero_stat_value?: number | null;
  healing?: number | null;
  elims?: number | null;
  final_blows?: number | null;
  deaths?: number | null;
  damage?: number | null;
  duration_min?: number | null;
}

export function insertAimStats(db: DB, a: AimStatsInput): void {
  db.prepare(`
    INSERT INTO aim_stats (match_id, overall_acc, crit_acc, hero_stat_label, hero_stat_value, elims, final_blows, deaths, damage, healing, duration_min)
    VALUES (:match_id, :overall_acc, :crit_acc, :hero_stat_label, :hero_stat_value, :elims, :final_blows, :deaths, :damage, :healing, :duration_min)
  `).run({
    match_id: a.match_id,
    overall_acc: a.overall_acc ?? null,
    crit_acc: a.crit_acc ?? null,
    hero_stat_label: a.hero_stat_label ?? null,
    hero_stat_value: a.hero_stat_value ?? null,
    elims: a.elims ?? null,
    final_blows: a.final_blows ?? null,
    deaths: a.deaths ?? null,
    damage: a.damage ?? null,
    healing: a.healing ?? null,
    duration_min: a.duration_min ?? null,
  });
}

export interface AimStatsHeroInput {
  match_id: number;
  hero: string;
  overall_acc?: number | null;
  crit_acc?: number | null;
  extra_acc?: number | null;
  duration_min?: number | null;
}

export function insertAimStatsHero(db: DB, a: AimStatsHeroInput): void {
  db.prepare(`
    INSERT INTO aim_stats_heroes (match_id, hero, overall_acc, crit_acc, extra_acc, duration_min)
    VALUES (:match_id, :hero, :overall_acc, :crit_acc, :extra_acc, :duration_min)
  `).run({
    match_id: a.match_id, hero: a.hero,
    overall_acc: a.overall_acc ?? null,
    crit_acc: a.crit_acc ?? null,
    extra_acc: a.extra_acc ?? null,
    duration_min: a.duration_min ?? null,
  });
}

export interface BlindSetInput {
  in_game_sens?: number;
  base_dpi?: number;
  active?: 0 | 1;
  hero?: string | null;
  phase?: string | null;
  batch_size?: number;
  cur_rel?: number;
}

export function insertBlindSet(db: DB, s: BlindSetInput = {}): number {
  const info = db.prepare(`
    INSERT INTO blind_stage_sets (in_game_sens, base_dpi, active, hero, phase, batch_size, cur_rel)
    VALUES (:in_game_sens, :base_dpi, :active, :hero, :phase, :batch_size, :cur_rel)
  `).run({
    in_game_sens: s.in_game_sens ?? 2.5,
    base_dpi: s.base_dpi ?? 800,
    active: s.active ?? 1,
    hero: s.hero ?? null,
    phase: s.phase ?? null,
    batch_size: s.batch_size ?? 5,
    cur_rel: s.cur_rel ?? 1,
  });
  return Number(info.lastInsertRowid);
}

export interface BlindStageInput {
  set_id: number;
  stage_index: number;
  dpi?: number;
  sens?: number | null;
  pct_delta?: number | null;
}

export function insertBlindStage(db: DB, st: BlindStageInput): void {
  db.prepare(`
    INSERT INTO blind_stages (set_id, stage_index, dpi, sens, pct_delta)
    VALUES (:set_id, :stage_index, :dpi, :sens, :pct_delta)
  `).run({
    set_id: st.set_id, stage_index: st.stage_index,
    dpi: st.dpi ?? 800, sens: st.sens ?? null, pct_delta: st.pct_delta ?? null,
  });
}

export function insertBlindCredit(db: DB, c: { match_id: number; hero: string; blind_set_id: number; stage_index: number }): void {
  db.prepare(`
    INSERT INTO blind_credits (match_id, hero, blind_set_id, stage_index)
    VALUES (:match_id, :hero, :blind_set_id, :stage_index)
  `).run(c);
}
