// Scoreboard pages and groups (Addendum 2, 2026-10-09). The post-match screen has
// three pages that Sean captures one after the other: SUMMARY, TEAMS and one
// PERSONAL page per hero. A Summary page opens a group; the Teams and Personal
// pages that follow within PAGE_GAP_MS of the group's last page join it.
//
// This module holds the pure parts (name matching, the DATE parse, the fill
// payload) and the group queries. It never imports scoreboard.ts, so the two
// files do not form a cycle. Rules that must not drift:
//  - A name that is not exactly in the roster becomes null. Never fuzzy-match.
//  - Accuracy slots fill only for heroes in HERO_TILE_MAP (heroTileLabels.ts).
//  - Recovery and submit fills only write NULL columns of rows that already exist.
import { syncMatchHeroStats } from './matchHeroStats';
import type { DatabaseSync } from 'node:sqlite';
import { HEROES_BY_ROLE, MAPS_BY_NAME } from './roster';
import { slotValues, finalBlows, type Tile } from './heroTileLabels';
import { emitTrackerWrite } from './trackerEvents';

export const PAGE_GAP_MS = 90_000;
/** A Summary DATE counts as the end of a logged match when created_at is within this many minutes. */
export const DATE_WINDOW_MIN = 10;
/** SQL fragment for the scoreboard table aliased `s`: only Teams pages count as "the match's scoreboard". Old rows have a NULL page_type and are Teams pages. */
export const TEAMS_ONLY = `(s.page_type IS NULL OR s.page_type = 'teams')`;

export type PageType = 'summary' | 'teams' | 'personal' | 'other';

/** SQLite datetime('now') is UTC without a zone marker. */
export function parseDbUtc(s: string): number {
  return Date.parse(s.replace(' ', 'T') + 'Z');
}
export const dbUtc = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');

// ---------------------------------------------------------------- raw pages

export interface RawSummary {
  map: string; result: string; score_us: number; score_them: number;
  game_mode: string; date_text: string; game_length: string;
  heroes: { hero: string; percent: number; play_time: string }[];
  elims: number; assists: number; deaths: number;
}
export interface RawPersonal { hero: string; tiles: Tile[] }

// -------------------------------------------------------------- name matching

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[‘’]/g, "'").trim().replace(/\s+/g, ' ').toLowerCase();

/** Exact roster name (case, accents and curly quotes folded), else null. */
export function rosterHero(name: string | null | undefined): string | null {
  if (!name) return null;
  const want = fold(name);
  for (const list of Object.values(HEROES_BY_ROLE)) for (const h of list) if (fold(h) === want) return h;
  return null;
}
export function rosterMap(name: string | null | undefined): string | null {
  if (!name) return null;
  const want = fold(name);
  return Object.keys(MAPS_BY_NAME).find(m => fold(m) === want) ?? null;
}

/** "05:28" -> 328, "1:02:03" -> 3723, else null. */
export function parseClock(s: string): number | null {
  const m = String(s).trim().match(/^(?:(\d{1,2}):)?(\d{1,3}):([0-5]\d)$/);
  return m ? (m[1] ? Number(m[1]) * 3600 : 0) + Number(m[2]) * 60 + Number(m[3]) : null;
}
const mss = (sec: number) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

// ------------------------------------------------------------------ the DATE

/**
 * Summary DATE is MM/DD/YY - hh:mm in the server's local time, 12-hour or 24-hour clock with
 * no AM/PM. Hours 0 and 13-23 are read as 24-hour. For hours 1-12 both readings are tried and the one closest to the file
 * mtime wins. Returns epoch ms, or null when the text does not parse.
 */
export function parseSummaryDate(text: string, mtimeMs: number): number | null {
  const m = String(text).match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*[-–—]?\s*(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const mo = Number(m[1]), d = Number(m[2]);
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const hr = Number(m[4]), min = Number(m[5]);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || hr > 23 || min > 59) return null;
  // 0 or 13-23 can only be a 24-hour time: use it directly.
  if (hr === 0 || hr >= 13) return new Date(y, mo - 1, d, hr, min).getTime();
  const h12 = hr % 12;
  const a = new Date(y, mo - 1, d, h12, min).getTime();
  const b = new Date(y, mo - 1, d, h12 + 12, min).getTime();
  return Math.abs(a - mtimeMs) <= Math.abs(b - mtimeMs) ? a : b;
}

// ------------------------------------------------------- normalised summary

export interface SummaryHero { hero: string | null; heroRaw: string; percent: number; seconds: number | null }
export interface NormSummary {
  map: string | null; mapRaw: string; result: 'victory' | 'defeat' | 'draw' | null;
  scoreUs: number | null; scoreThem: number | null; gameMode: string;
  endMs: number | null; lengthSec: number | null;
  heroes: SummaryHero[]; elims: number | null; assists: number | null; deaths: number | null;
}
const intOrNull = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);

export function normSummary(raw: RawSummary, mtimeMs: number): NormSummary {
  const r = fold(raw.result ?? '');
  return {
    map: rosterMap(raw.map), mapRaw: raw.map ?? '',
    result: r === 'victory' || r === 'defeat' || r === 'draw' ? r : null,
    scoreUs: intOrNull(raw.score_us), scoreThem: intOrNull(raw.score_them),
    gameMode: (raw.game_mode ?? '').trim(),
    endMs: parseSummaryDate(raw.date_text ?? '', mtimeMs),
    lengthSec: parseClock(raw.game_length ?? ''),
    heroes: (raw.heroes ?? []).map(h => ({ hero: rosterHero(h.hero), heroRaw: h.hero, percent: h.percent, seconds: parseClock(h.play_time) }))
      .sort((a, b) => b.percent - a.percent),
    elims: intOrNull(raw.elims), assists: intOrNull(raw.assists), deaths: intOrNull(raw.deaths),
  };
}

// ----------------------------------------------------------------- groups

export interface GroupRow { id: number; state: 'live' | 'linked' | 'recovery' | 'ambiguous'; match_id: number | null; summary_mtime: string; last_mtime: string; filled_at: string | null }

/** The group a page taken at mtimeMs joins: the latest Summary at or before it, if the chain of pages has no gap over PAGE_GAP_MS. */
export function findOpenGroup(db: DatabaseSync, mtimeMs: number): GroupRow | null {
  const g = db.prepare(`SELECT * FROM scoreboard_groups WHERE summary_mtime <= ? ORDER BY summary_mtime DESC, id DESC LIMIT 1`)
    .get(new Date(mtimeMs).toISOString()) as GroupRow | undefined;
  if (!g) return null;
  return mtimeMs - Date.parse(g.last_mtime) <= PAGE_GAP_MS ? g : null;
}

export function createGroup(db: DatabaseSync, summaryMtimeMs: number, state: GroupRow['state'], matchId: number | null): number {
  const iso = new Date(summaryMtimeMs).toISOString();
  return Number(db.prepare(`INSERT INTO scoreboard_groups (state, match_id, summary_mtime, last_mtime) VALUES (?, ?, ?, ?)`).run(state, matchId, iso, iso).lastInsertRowid);
}

export function touchGroup(db: DatabaseSync, id: number, mtimeMs: number): void {
  const iso = new Date(mtimeMs).toISOString();
  db.prepare(`UPDATE scoreboard_groups SET last_mtime = ? WHERE id = ? AND last_mtime < ?`).run(iso, id, iso);
}

/** Logged matches on this map whose created_at is within DATE_WINDOW_MIN of the Summary's end time. */
export function recoveryCandidates(db: DatabaseSync, endMs: number, map: string): number[] {
  const w = DATE_WINDOW_MIN * 60_000;
  return (db.prepare(`SELECT id FROM matches WHERE map = ? AND created_at BETWEEN ? AND ? ORDER BY id`).all(map, dbUtc(endMs - w), dbUtc(endMs + w)) as { id: number }[]).map(r => r.id);
}

/**
 * Link a group to a logged match and move its waiting pages with it. Teams pages
 * link only when the match has no Teams page yet; Summary and Personal pages always do.
 */
export function linkGroup(db: DatabaseSync, groupId: number, matchId: number, state: 'linked' | 'recovery', reason: string): void {
  db.prepare(`UPDATE scoreboard_groups SET state = ?, match_id = ? WHERE id = ?`).run(state, matchId, groupId);
  db.prepare(`
    UPDATE match_scoreboards SET match_id = ?, status = 'matched', reason = ?
    WHERE group_id = ? AND status = 'unmatched' AND (
      page_type IN ('summary', 'personal')
      OR NOT EXISTS (SELECT 1 FROM match_scoreboards s WHERE s.match_id = ? AND ${TEAMS_ONLY} AND s.id <> match_scoreboards.id)
    )
  `).run(matchId, reason, groupId, matchId);
  syncMatchHeroStats(db, matchId);
}

/** The Summary map (roster name) of a group, or null. */
export function groupSummaryMap(db: DatabaseSync, groupId: number): string | null {
  const p = db.prepare(`SELECT raw_json, file_mtime FROM match_scoreboards WHERE group_id = ? AND page_type = 'summary' ORDER BY id LIMIT 1`).get(groupId) as { raw_json: string | null; file_mtime: string } | undefined;
  if (!p?.raw_json) return null;
  try { return normSummary(JSON.parse(p.raw_json).summary, Date.parse(p.file_mtime)).map; } catch { return null; }
}

/**
 * Pull pages into a new group that landed before their Summary (Drive can
 * deliver files in any order, and the backfill re-reads old rows). Walks forward
 * from the Summary while the gap stays within PAGE_GAP_MS. A pre-change Teams row
 * (NULL page_type) becomes a Teams page of the group.
 */
export function adoptLoosePages(db: DatabaseSync, groupId: number): number {
  const g = db.prepare(`SELECT * FROM scoreboard_groups WHERE id = ?`).get(groupId) as unknown as GroupRow;
  const loose = db.prepare(`
    SELECT id, file_mtime, page_type FROM match_scoreboards
    WHERE group_id IS NULL AND file_mtime >= ? AND status <> 'not_scoreboard' AND (page_type IS NULL OR page_type IN ('teams', 'personal'))
    ORDER BY file_mtime, id
  `).all(g.summary_mtime) as { id: number; file_mtime: string; page_type: string | null }[];
  let last = Date.parse(g.last_mtime), n = 0;
  for (const p of loose) {
    const t = Date.parse(p.file_mtime);
    if (t - last > PAGE_GAP_MS) break;
    db.prepare(`UPDATE match_scoreboards SET group_id = ?, page_type = COALESCE(page_type, 'teams') WHERE id = ?`).run(groupId, p.id);
    last = Math.max(last, t); n++;
  }
  if (n) touchGroup(db, groupId, last);
  if (n && g.match_id != null) linkGroup(db, groupId, g.match_id, g.state === 'linked' ? 'linked' : 'recovery', 'group page');
  return n;
}

// ------------------------------------------------------------- fill payload

export interface FillHero {
  hero: string; percent: number; seconds: number | null; duration: string;
  overall_acc: number | null; crit_acc: number | null; extra_acc: number | null;
  torpedo_damage: number | null; torpedo_healing: number | null;
  /** true when the hero is in HERO_TILE_MAP, so the accuracy slots were read. */
  mapped: boolean; final_blows: number | null; has_personal: boolean;
}
export interface FormFill {
  group_id: number; state: GroupRow['state'];
  map: string | null; win: 0 | 1 | null; score_us: number | null; score_them: number | null;
  heroes: FillHero[];
  elims: number | null; assists: number | null; deaths: number | null;
  damage: number | null; healing: number | null; mitigation: number | null;
  /** Sum over the heroes played; null unless every hero played has a Personal page with a final-blows tile. */
  final_blows: number | null;
  /** aim_stats.duration_min: the sum of hero play times in minutes, NOT the game length. */
  duration_min: number | null;
  game_length_sec: number | null;
  pages: { summary: boolean; teams: boolean; personal: string[] };
}

interface PageRow { id: number; page_type: string | null; page_hero: string | null; status: string; raw_json: string | null; file_mtime: string }

export function buildFill(db: DatabaseSync, groupId: number): FormFill | null {
  const g = db.prepare(`SELECT * FROM scoreboard_groups WHERE id = ?`).get(groupId) as GroupRow | undefined;
  if (!g) return null;
  const pages = db.prepare(`SELECT id, page_type, page_hero, status, raw_json, file_mtime FROM match_scoreboards WHERE group_id = ? AND status NOT IN ('error') ORDER BY file_mtime, id`).all(groupId) as unknown as PageRow[];
  const parse = (p: PageRow) => { try { return p.raw_json ? JSON.parse(p.raw_json) : null; } catch { return null; } };

  const sp = [...pages].reverse().find(p => p.page_type === 'summary');
  const sum = sp ? (() => { const j = parse(sp); return j?.summary ? normSummary(j.summary, Date.parse(sp.file_mtime)) : null; })() : null;

  // One Personal page per hero (the newest wins); the ALL HEROES tab has no roster hero and is left out.
  const personal = new Map<string, Tile[]>();
  for (const p of pages) {
    if (p.page_type !== 'personal') continue;
    const hero = rosterHero(p.page_hero);
    const tiles = parse(p)?.personal?.tiles;
    if (hero && Array.isArray(tiles) && p.status !== 'dismissed') personal.set(hero, tiles);
  }

  const tp = [...pages].reverse().find(p => (p.page_type === 'teams' || p.page_type == null) && db.prepare(`SELECT 1 FROM scoreboard_rows WHERE scoreboard_id = ? AND is_self = 1`).get(p.id));
  const self = tp ? db.prepare(`SELECT dmg, h, mit FROM scoreboard_rows WHERE scoreboard_id = ? AND is_self = 1`).get(tp.id) as { dmg: number; h: number; mit: number } | undefined : undefined;

  const heroes: FillHero[] = (sum?.heroes ?? []).filter(h => h.hero).slice(0, 3).map(h => {
    const tiles = personal.get(h.hero!);
    const slots = tiles ? slotValues(h.hero!, tiles) : null;
    return {
      hero: h.hero!, percent: h.percent, seconds: h.seconds, duration: h.seconds != null ? mss(h.seconds) : '',
      overall_acc: slots?.overall_acc ?? null, crit_acc: slots?.crit_acc ?? null, extra_acc: slots?.extra_acc ?? null,
      torpedo_damage: slots?.torpedo_damage ?? null, torpedo_healing: slots?.torpedo_healing ?? null,
      mapped: slots != null, final_blows: tiles ? finalBlows(tiles) : null, has_personal: !!tiles,
    };
  });
  const everyFb = heroes.length > 0 && heroes.every(h => h.final_blows != null);
  const secs = heroes.map(h => h.seconds);
  return {
    group_id: g.id, state: g.state,
    map: sum?.map ?? null,
    win: sum?.result === 'victory' ? 1 : sum?.result === 'defeat' ? 0 : null,
    score_us: sum?.scoreUs ?? null, score_them: sum?.scoreThem ?? null,
    heroes,
    elims: sum?.elims ?? null, assists: sum?.assists ?? null, deaths: sum?.deaths ?? null,
    damage: self?.dmg ?? null, healing: self?.h ?? null, mitigation: self?.mit ?? null,
    final_blows: everyFb ? heroes.reduce((a, h) => a + (h.final_blows ?? 0), 0) : null,
    duration_min: heroes.length && secs.every(s => s != null) ? secs.reduce((a, s) => a + (s as number), 0) / 60 : null,
    game_length_sec: sum?.lengthSec ?? null,
    pages: { summary: !!sum, teams: !!self, personal: [...personal.keys()] },
  };
}

// -------------------------------------------------- fill only the empty fields

/**
 * Write screenshot values into a logged match's aim rows, NULL columns only.
 * Never inserts a row (an aim_stats row means the match left the Awaiting Stats
 * backlog, and a hero row changes test credit), never overwrites a typed value
 * (a typed 0 stays 0), and never touches duration columns (they feed credits).
 * Assists and healing are support-only columns, so they fill only when the match
 * had a Support hero. `only` limits the columns (the form submit passes final_blows).
 */
export function fillEmptyAim(db: DatabaseSync, matchId: number, fill: FormFill, only?: string[]): { filled: string[]; skipped: string | null } {
  const aim = db.prepare(`SELECT * FROM aim_stats WHERE match_id = ?`).get(matchId) as Record<string, unknown> | undefined;
  if (!aim) return { filled: [], skipped: 'no aim_stats row' };
  const filled: string[] = [];
  const want = (k: string) => !only || only.includes(k);
  const hasSupport = !!db.prepare(`SELECT 1 FROM match_heroes WHERE match_id = ? AND role = 'Support'`).get(matchId);
  const cols: [string, number | null][] = [
    ['elims', fill.elims], ['deaths', fill.deaths], ['damage', fill.damage], ['final_blows', fill.final_blows],
    ...(hasSupport ? ([['assists', fill.assists], ['healing', fill.healing]] as [string, number | null][]) : []),
  ];
  for (const [col, v] of cols) {
    if (!want(col) || v == null || aim[col] != null) continue;
    db.prepare(`UPDATE aim_stats SET ${col} = ? WHERE match_id = ? AND ${col} IS NULL`).run(v, matchId);
    filled.push(col);
  }
  if (want('hero_slots')) {
    for (const h of fill.heroes) {
      if (!h.mapped) continue;
      const row = db.prepare(`SELECT overall_acc, crit_acc, extra_acc, torpedo_damage, torpedo_healing FROM aim_stats_heroes WHERE match_id = ? AND hero = ?`).get(matchId, h.hero) as Record<string, unknown> | undefined;
      if (!row) continue;
      for (const col of ['overall_acc', 'crit_acc', 'extra_acc', 'torpedo_damage', 'torpedo_healing'] as const) {
        const v = h[col];
        if (v == null || row[col] != null) continue;
        db.prepare(`UPDATE aim_stats_heroes SET ${col} = ? WHERE match_id = ? AND hero = ? AND ${col} IS NULL`).run(v, matchId, h.hero);
        filled.push(`${h.hero}.${col}`);
      }
    }
  }
  return { filled, skipped: null };
}

/**
 * Once a linked group has been quiet for PAGE_GAP_MS (every page is in), fill the
 * empty aim fields of its match. Recovery groups fill everything fillEmptyAim
 * allows; a group the form linked at submit fills final_blows only (the form
 * already sent the rest, and it has no field for final blows).
 */
export function finalizeGroups(db: DatabaseSync, nowMs: number = Date.now()): number {
  const due = db.prepare(`SELECT * FROM scoreboard_groups WHERE state IN ('recovery', 'linked') AND match_id IS NOT NULL AND filled_at IS NULL`).all() as unknown as GroupRow[];
  let n = 0, wrote = false;
  for (const g of due) {
    if (nowMs - Date.parse(g.last_mtime) < PAGE_GAP_MS) continue;
    const fill = buildFill(db, g.id);
    if (fill) {
      const r = fillEmptyAim(db, g.match_id!, fill, g.state === 'linked' ? ['final_blows'] : ['elims', 'deaths', 'damage', 'final_blows', 'assists', 'healing', 'hero_slots']);
      if (r.filled.length) wrote = true;
      if (r.filled.length) console.log(`[scoreboard] group ${g.id} -> match ${g.match_id}: filled ${r.filled.join(', ')}`);
    }
    db.prepare(`UPDATE scoreboard_groups SET filled_at = datetime('now') WHERE id = ?`).run(g.id);
    n++;
  }
  // The watcher writes outside an /api request, so tell the lab cache itself (trackerEvents.ts).
  if (wrote) emitTrackerWrite();
  return n;
}
