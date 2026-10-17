// Scoreboard pages and groups (Addendum 2, 2026-10-09). The post-match screen has
// three pages that Sean captures one after the other: SUMMARY, TEAMS and one
// PERSONAL page per hero. A Summary page opens a group;
// Teams and Personal pages after it join it until the next Summary (no time limit; PAGE_GAP_MS only bounds rank-page adoption and group filling).
// A competitive match also shows a RANK page (2026-10-11) BEFORE the Summary. It joins
// the group of the Summary that follows it within PAGE_GAP_MS, in either arrival order.
//
// This module holds the pure parts (name matching, the DATE parse, the fill
// payload) and the group queries. It never imports scoreboard.ts, so the two
// files do not form a cycle. Rules that must not drift:
//  - A name that is not exactly in the roster becomes null. Never fuzzy-match.
//  - Accuracy slots: hand map (HERO_TILE_MAP) > saved pick (hero_tile_picks) > derived standard label (heroTileLabels.ts).
//  - Recovery and submit fills only write NULL columns of rows that already exist.
//  - A rank page fills matches.player_rank / player_rank_start only where they are NULL.
import { syncMatchHeroStats } from './matchHeroStats';
import type { DatabaseSync } from 'node:sqlite';
import { HEROES_BY_ROLE, MAPS_BY_NAME } from './roster';
import { parseTileNumber, slotValues, resolveSlots, pickableTiles, isAutoMapped, finalBlows, type Tile, type Slot, type SlotSource, type PickTile } from './heroTileLabels';
import { loadPicks } from './heroTilePicks';
import { emitTrackerWrite } from './trackerEvents';
import { syncLadderRank } from './ladderRank';


export const PAGE_GAP_MS = 90_000;
/** A Summary DATE counts as the end of a logged match when created_at is within this many minutes. */
export const DATE_WINDOW_MIN = 10;
/** SQL fragment for the scoreboard table aliased `s`: only Teams pages count as "the match's scoreboard". Old rows have a NULL page_type and are Teams pages. */
export const TEAMS_ONLY = `(s.page_type IS NULL OR s.page_type = 'teams')`;

export type PageType = 'summary' | 'teams' | 'personal' | 'rank' | 'other';

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
/** The rank progress screen, every value as shown (strings are parsed in normRank). */
export interface RawRank {
  result: string; rank_text: string; progress_text: string; change_text: string; percentile_text: string;
  modifiers: string[]; points_total: string; points_change: string; reward_progress: string;
  heroes: { name: string; sr: string; change: string }[];
}

// -------------------------------------------------------------- name matching

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[‘’]/g, "'").trim().replace(/\s+/g, ' ').toLowerCase();

/** The Personal page with the hero selector on ALL HEROES. It is not a hero: it holds the player's totals for the match. */
export const isAllHeroes = (name: string | null | undefined): boolean => !!name && fold(name) === 'all heroes';

// Tile labels on the ALL HEROES page, in priority order (first label present wins). Labels are matched exactly after fold; never fuzzy.
// ALL DAMAGE DONE is assumed to be the same figure as the Teams board's DMG column; no sample page existed when this was written (2026-10-16).
export const ALL_HEROES_DAMAGE_LABELS = ['all damage done', 'damage done', 'hero damage done'];
export const ALL_HEROES_HEALING_LABELS = ['healing done'];
/** Total damage and healing from the tiles of an ALL HEROES page; null for a missing or unreadable tile. */
export function allHeroesTotals(tiles: Tile[]): { damage: number | null; healing: number | null } {
  const pick = (labels: string[]) => {
    for (const l of labels) { const t = tiles.find(x => fold(x.label) === l); const v = t ? parseTileNumber(t.value) : null; if (v != null) return v; }
    return null;
  };
  return { damage: pick(ALL_HEROES_DAMAGE_LABELS), healing: pick(ALL_HEROES_HEALING_LABELS) };
}

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

// ------------------------------------------------------------------ rank page

/** Tier order of the 1-45 ladder. Must stay in step with RANK_TIERS in client/src/types/index.ts. */
export const RANK_TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Emerald', 'Diamond', 'Master', 'Grandmaster', 'Champion'] as const;
export const RANK_MAX = RANK_TIERS.length * 5;

/** Bronze 5 = 1 ... Champion 1 = 45 (client rankFromParts). Null when the tier or division is not on the ladder. */
export function rankInt(tier: string, division: number): number | null {
  const i = RANK_TIERS.findIndex(t => fold(t) === fold(tier));
  return i < 0 || !Number.isInteger(division) || division < 1 || division > 5 ? null : i * 5 + (5 - division) + 1;
}

export interface NormRankHero { hero: string | null; rawName: string; sr: number; srDelta: number | null }
export interface NormRank {
  rankInt: number | null; tier: string | null; division: number | null;
  progressPct: number | null; deltaPct: number | null; result: 'victory' | 'defeat' | 'draw' | null; percentile: number | null;
  cpTotal: number | null; cpDelta: number | null; rewardProgress: number | null; rewardTotal: number | null;
  modifiers: string[]; heroes: NormRankHero[];
}
/** "+44%", "-12", "−12", "76" -> number; no digits -> null. */
function signedInt(s: unknown): number | null {
  const m = String(s ?? '').replace(/[−–—]/g, '-').match(/([+-])?\s*(\d[\d,]*)/);
  if (!m) return null;
  const n = Number(m[2].replace(/,/g, ''));
  return m[1] === '-' ? -n : n;
}

export function normRank(raw: RawRank): NormRank {
  const rt = String(raw.rank_text ?? '').match(/([A-Za-z]+)\s*([1-5])\b/);
  const tierName = rt ? RANK_TIERS.find(t => fold(t) === fold(rt[1])) ?? null : null;
  const division = rt && tierName ? Number(rt[2]) : null;
  const res = fold(raw.result ?? '').match(/victory|defeat|draw/)?.[0] as NormRank['result'] | undefined;
  const reward = String(raw.reward_progress ?? '').match(/(\d+)\s*\/\s*(\d+)/);
  const pct = (s: unknown) => { const n = signedInt(s); return n != null && n >= 0 && n <= 100 ? n : null; };
  return {
    rankInt: tierName && division ? rankInt(tierName, division) : null, tier: tierName, division,
    progressPct: pct(raw.progress_text), deltaPct: signedInt(raw.change_text), result: res ?? null, percentile: pct(raw.percentile_text),
    cpTotal: signedInt(raw.points_total), cpDelta: signedInt(raw.points_change),
    rewardProgress: reward ? Number(reward[1]) : null, rewardTotal: reward ? Number(reward[2]) : null,
    modifiers: (raw.modifiers ?? []).map(m => String(m).trim().replace(/\s+/g, ' ')).filter(Boolean),
    heroes: (raw.heroes ?? []).map(h => ({ hero: rosterHero(h.name), rawName: String(h.name ?? '').trim(), sr: signedInt(h.sr) as number, srDelta: signedInt(h.change) }))
      .filter(h => h.rawName && Number.isFinite(h.sr)),
  };
}

/**
 * The rank and progress the match STARTED at, from the end rank (rankInt), end progress and the change bar.
 * progress - change < 0 on a gain: it began in the division below, at 100 + that value.
 * progress - change > 100 on a loss: it began in the division above, at that value - 100.
 * Null when a value is missing, the readings disagree (a gain that "started" above 100) or the ladder ends.
 */
export function deriveStartRank(endRank: number | null, progressPct: number | null, deltaPct: number | null): { rankInt: number; progressPct: number } | null {
  if (endRank == null || progressPct == null || deltaPct == null) return null;
  const start = progressPct - deltaPct;
  let r = endRank, p = start;
  if (start < 0) { if (deltaPct <= 0) return null; r = endRank - 1; p = 100 + start; }
  else if (start > 100) { if (deltaPct >= 0) return null; r = endRank + 1; p = start - 100; }
  return r < 1 || r > RANK_MAX || p < 0 || p > 100 ? null : { rankInt: r, progressPct: p };
}

/** Write (or rewrite) the rank rows of one rank page. Keyed by the page id, so they exist before any match is linked. */
export function storeRank(db: DatabaseSync, scoreboardId: number, n: NormRank): void {
  db.prepare(`DELETE FROM scoreboard_rank_heroes WHERE scoreboard_id = ?`).run(scoreboardId);
  db.prepare(`DELETE FROM scoreboard_ranks WHERE scoreboard_id = ?`).run(scoreboardId);
  db.prepare(`
    INSERT INTO scoreboard_ranks (scoreboard_id, rank_int, tier, division, progress_pct, delta_pct, result, percentile, cp_total, cp_delta, reward_progress, reward_total, modifiers)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(scoreboardId, n.rankInt, n.tier, n.division, n.progressPct, n.deltaPct, n.result, n.percentile, n.cpTotal, n.cpDelta, n.rewardProgress, n.rewardTotal, JSON.stringify(n.modifiers));
  const ins = db.prepare(`INSERT INTO scoreboard_rank_heroes (scoreboard_id, slot, hero, raw_name, sr, sr_delta) VALUES (?, ?, ?, ?, ?, ?)`);
  n.heroes.forEach((h, i) => ins.run(scoreboardId, i, h.hero, h.rawName, h.sr, h.srDelta));
}

/** The Summary group a rank page taken at mtimeMs belongs to: the earliest Summary within PAGE_GAP_MS AFTER it that has no other rank page. */
export function findGroupAfterRank(db: DatabaseSync, mtimeMs: number): GroupRow | null {
  return (db.prepare(`
    SELECT * FROM scoreboard_groups g WHERE summary_mtime >= ? AND summary_mtime <= ?
      AND NOT EXISTS (SELECT 1 FROM match_scoreboards s WHERE s.group_id = g.id AND s.page_type = 'rank' AND s.status <> 'dismissed' AND s.file_mtime <> ?)
    ORDER BY summary_mtime, id LIMIT 1
  `).get(new Date(mtimeMs).toISOString(), new Date(mtimeMs + PAGE_GAP_MS).toISOString(), new Date(mtimeMs).toISOString()) as GroupRow | undefined) ?? null;
}

/**
 * Fill matches.player_rank and player_rank_start from the group's rank page, each ONLY where it is NULL
 * (a hand-entered rank is never overwritten). Skips a match that is not competitive or whose win/loss
 * disagrees with the rank page's result (a wrong link must not write a rank). Returns true when a column changed.
 */
export function fillRankFromGroup(db: DatabaseSync, groupId: number, matchId: number): boolean {
  const r = db.prepare(`
    SELECT r.rank_int, r.progress_pct, r.delta_pct, r.result FROM scoreboard_ranks r JOIN match_scoreboards s ON s.id = r.scoreboard_id
    WHERE s.group_id = ? AND s.page_type = 'rank' AND s.status <> 'dismissed' ORDER BY s.file_mtime DESC, s.id DESC LIMIT 1
  `).get(groupId) as { rank_int: number | null; progress_pct: number | null; delta_pct: number | null; result: string | null } | undefined;
  if (!r || r.rank_int == null) return false;
  const m = db.prepare(`SELECT queue_mode, win FROM matches WHERE id = ?`).get(matchId) as { queue_mode: string | null; win: number | null } | undefined;
  if (!m || !String(m.queue_mode ?? '').startsWith('comp')) return false;
  if ((r.result === 'victory' && m.win !== 1) || (r.result === 'defeat' && m.win !== 0)) return false;
  const start = deriveStartRank(r.rank_int, r.progress_pct, r.delta_pct);
  let wrote = db.prepare(`UPDATE matches SET player_rank = ? WHERE id = ? AND player_rank IS NULL`).run(r.rank_int, matchId).changes > 0;
  if (start) wrote = db.prepare(`UPDATE matches SET player_rank_start = ? WHERE id = ? AND player_rank_start IS NULL`).run(start.rankInt, matchId).changes > 0 || wrote;
  if (wrote) syncLadderRank(db, matchId);
  return wrote;
}

// ----------------------------------------------------------------- groups

export interface GroupRow { id: number; state: 'live' | 'linked' | 'recovery' | 'ambiguous'; match_id: number | null; summary_mtime: string; last_mtime: string; filled_at: string | null }

/** The group a Teams or Personal page taken at mtimeMs joins: the group of the newest Summary at or before it. No time limit; the next Summary closes it. */
export function findOpenGroup(db: DatabaseSync, mtimeMs: number): GroupRow | null {
  const g = db.prepare(`SELECT * FROM scoreboard_groups WHERE summary_mtime <= ? ORDER BY summary_mtime DESC, id DESC LIMIT 1`)
    .get(new Date(mtimeMs).toISOString()) as GroupRow | undefined;
  if (!g) return null;
  return g;
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
 * link only when the match has no Teams page yet; Summary, Personal and Rank pages always do. A Rank page also fills the match's NULL rank columns.
 */
export function linkGroup(db: DatabaseSync, groupId: number, matchId: number, state: 'linked' | 'recovery', reason: string, syncLeaver = true): void {
  db.prepare(`UPDATE scoreboard_groups SET state = ?, match_id = ? WHERE id = ?`).run(state, matchId, groupId);
  db.prepare(`
    UPDATE match_scoreboards SET match_id = ?, status = 'matched', reason = ?
    WHERE group_id = ? AND status = 'unmatched' AND (
      page_type IN ('summary', 'personal', 'rank')
      OR NOT EXISTS (SELECT 1 FROM match_scoreboards s WHERE s.match_id = ? AND ${TEAMS_ONLY} AND s.id <> match_scoreboards.id)
    )
  `).run(matchId, reason, groupId, matchId);
  syncMatchHeroStats(db, matchId);
  if (fillRankFromGroup(db, groupId, matchId)) emitTrackerWrite();
  // The log form always answers the leaver question (an unticked box is Sean's "no"), so the submit path passes syncLeaver=false.
  if (syncLeaver) syncLeaverFromBoard(db, matchId);
}


// ------------------------------------------------ leaver from a short board

/** Side of the leaver from Teams row counts. Comp has no backfill: the game removes a leaver's row. A side is short when it holds fewer than 5 rows or fewer than the other side. Both short -> the side with fewer rows; equal -> null (unknowable). */
export function leaverSideFromCounts(us: number, them: number): 'mine' | 'theirs' | null {
  const usShort = us < Math.max(5, them), themShort = them < Math.max(5, us);
  if (usShort && themShort) return us === them ? null : us < them ? 'mine' : 'theirs';
  if (usShort) return 'mine';
  if (themShort) return 'theirs';
  return null;
}

/** Leaver implied by a stored Teams board, or null when the board is not short. side is null when both sides are equally short. */
export function leaverFromBoard(db: DatabaseSync, scoreboardId: number): { side: 'mine' | 'theirs' | null } | null {
  const sb = db.prepare(`SELECT short FROM match_scoreboards WHERE id = ?`).get(scoreboardId) as { short: number } | undefined;
  if (!sb || !sb.short) return null;
  const c = db.prepare(`SELECT SUM(team = 'us') AS us, SUM(team = 'them') AS them FROM scoreboard_rows WHERE scoreboard_id = ?`).get(scoreboardId) as { us: number | null; them: number | null };
  return { side: leaverSideFromCounts(c.us ?? 0, c.them ?? 0) };
}

/**
 * Called wherever a Teams board gets a match. Sets matches.leaver / leaver_side from a short
 * board, but never overrides an answer: leaver NULL -> set; leaver 1 with no side -> fill the side;
 * leaver 1 with a side, or leaver 0 (Sean's own answer) -> untouched (the UI shows a note for 0).
 * Returns what happened.
 */
export function syncLeaverFromBoard(db: DatabaseSync, matchId: number): 'set' | 'kept' | 'conflict' | 'none' {
  const sb = db.prepare(`SELECT s.id FROM match_scoreboards s WHERE s.match_id = ? AND s.status = 'matched' AND ${TEAMS_ONLY} AND s.short = 1 ORDER BY s.id DESC LIMIT 1`).get(matchId) as { id: number } | undefined;
  if (!sb) return 'none';
  const lv = leaverFromBoard(db, sb.id);
  if (!lv) return 'none';
  const m = db.prepare(`SELECT leaver, leaver_side FROM matches WHERE id = ?`).get(matchId) as { leaver: number | null; leaver_side: string | null } | undefined;
  if (!m) return 'none';
  if (m.leaver === 0) return 'conflict';
  if (m.leaver == null) {
    db.prepare(`UPDATE matches SET leaver = 1, leaver_side = ? WHERE id = ?`).run(lv.side, matchId);
    emitTrackerWrite();
    return 'set';
  }
  if (m.leaver_side == null && lv.side) {
    db.prepare(`UPDATE matches SET leaver_side = ? WHERE id = ?`).run(lv.side, matchId);
    emitTrackerWrite();
    return 'set';
  }
  return 'kept';
}

/** Ids among these matches that have a short Teams board while Sean's saved answer is leaver = 0 (drives the note on the match). */
export function shortBoardConflicts(db: DatabaseSync, ids: number[]): Set<number> {
  if (!ids.length) return new Set();
  const rows = db.prepare(`SELECT DISTINCT m.id FROM matches m JOIN match_scoreboards s ON s.match_id = m.id AND s.status = 'matched' AND s.short = 1 AND ${TEAMS_ONLY} WHERE m.leaver = 0 AND m.id IN (${ids.map(() => '?').join(',')})`).all(...ids) as { id: number }[];
  return new Set(rows.map(r => r.id));
}

/** The Summary map (roster name) of a group, or null. */
export function groupSummaryMap(db: DatabaseSync, groupId: number): string | null {
  const p = db.prepare(`SELECT raw_json, file_mtime FROM match_scoreboards WHERE group_id = ? AND page_type = 'summary' ORDER BY id LIMIT 1`).get(groupId) as { raw_json: string | null; file_mtime: string } | undefined;
  if (!p?.raw_json) return null;
  try { return normSummary(JSON.parse(p.raw_json).summary, Date.parse(p.file_mtime)).map; } catch { return null; }
}

/** Roster heroes listed on a group's Summary page. */
export function groupSummaryHeroes(db: DatabaseSync, groupId: number): string[] {
  const p = db.prepare(`SELECT raw_json, file_mtime FROM match_scoreboards WHERE group_id = ? AND page_type = 'summary' AND status <> 'dismissed' ORDER BY id DESC LIMIT 1`).get(groupId) as { raw_json: string | null; file_mtime: string } | undefined;
  if (!p?.raw_json) return [];
  try { return normSummary(JSON.parse(p.raw_json).summary, Date.parse(p.file_mtime)).heroes.map(h => h.hero).filter((h): h is string => !!h); } catch { return []; }
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
  // A rank page comes BEFORE the Summary: the latest loose one within PAGE_GAP_MS before it. It never moves last_mtime.
  const hasRank = db.prepare(`SELECT 1 FROM match_scoreboards WHERE group_id = ? AND page_type = 'rank' AND status <> 'dismissed'`).get(groupId);
  const rank = hasRank ? undefined : db.prepare(`
    SELECT id FROM match_scoreboards WHERE group_id IS NULL AND page_type = 'rank' AND status <> 'not_scoreboard' AND file_mtime <= ? AND file_mtime >= ?
    ORDER BY file_mtime DESC, id DESC LIMIT 1
  `).get(g.summary_mtime, new Date(Date.parse(g.summary_mtime) - PAGE_GAP_MS).toISOString()) as { id: number } | undefined;
  if (rank) { db.prepare(`UPDATE match_scoreboards SET group_id = ? WHERE id = ?`).run(groupId, rank.id); n++; }
  if (n && g.match_id != null) linkGroup(db, groupId, g.match_id, g.state === 'linked' ? 'linked' : 'recovery', 'group page');
  return n;
}

// ------------------------------------------------------------- fill payload

export interface FillHero {
  hero: string; percent: number; seconds: number | null; duration: string;
  overall_acc: number | null; crit_acc: number | null; extra_acc: number | null;
  torpedo_damage: number | null; torpedo_healing: number | null;
  /** true when the hero is in HERO_TILE_MAP, so the accuracy slots were read. */
  mapped: boolean; auto_mapped?: boolean; final_blows: number | null; has_personal: boolean;
  /** Where each slot's tile came from: the hand map, a saved pick, the derived standard label, or nothing. */
  slot_source: Record<Slot, SlotSource>;
  /** Menu options per slot that nothing fills yet (see pickableTiles); empty object = no menu. */
  pickable: Partial<Record<Slot, PickTile[]>>;
}
export interface FormFill {
  group_id: number; state: GroupRow['state'];
  map: string | null; win: 0 | 1 | null; score_us: number | null; score_them: number | null;
  heroes: FillHero[];
  elims: number | null; assists: number | null; deaths: number | null;
  damage: number | null; healing: number | null; mitigation: number | null;
  /** Leaver implied by a short Teams board (comp: the game removes the leaver's row); short_board true with a null side means both sides are equally short. */
  leaver_side: 'mine' | 'theirs' | null; short_board: boolean;
  /** Sum over the heroes played; null unless every hero played has a Personal page with a final-blows tile. */
  final_blows: number | null;
  /** aim_stats.duration_min: the sum of hero play times in minutes, NOT the game length. */
  duration_min: number | null;
  game_length_sec: number | null;
  pages: { summary: boolean; teams: boolean; personal: string[]; /** an ALL HEROES page with a damage or healing tile was read (it is not a hero) */ all_heroes?: boolean };
  /** The group's rank page (the form fills the rank selector and outcome from it), or null. start_* come from deriveStartRank. */
  rank: { rank_int: number; progress_pct: number | null; delta_pct: number | null; result: 'victory' | 'defeat' | 'draw' | null; start_rank_int: number | null; start_progress_pct: number | null } | null;
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
  let allHeroesTiles: Tile[] | null = null;
  for (const p of pages) {
    if (p.page_type !== 'personal') continue;
    if (isAllHeroes(parse(p)?.personal?.hero)) {
      const t = parse(p)?.personal?.tiles;
      if (Array.isArray(t) && p.status !== 'dismissed') allHeroesTiles = t;
      continue;
    }
    const hero = rosterHero(p.page_hero);
    const tiles = parse(p)?.personal?.tiles;
    if (hero && Array.isArray(tiles) && p.status !== 'dismissed') personal.set(hero, tiles);
  }

  const tp = [...pages].reverse().find(p => (p.page_type === 'teams' || p.page_type == null) && db.prepare(`SELECT 1 FROM scoreboard_rows WHERE scoreboard_id = ? AND is_self = 1`).get(p.id));
  const self = tp ? db.prepare(`SELECT dmg, h, mit FROM scoreboard_rows WHERE scoreboard_id = ? AND is_self = 1`).get(tp.id) as { dmg: number; h: number; mit: number } | undefined : undefined;

  const totals = allHeroesTiles ? allHeroesTotals(allHeroesTiles) : null;

  const boardLeaver = tp ? leaverFromBoard(db, tp.id) : null;
  const picks = loadPicks(db);
  const heroes: FillHero[] = (sum?.heroes ?? []).filter(h => h.hero).slice(0, 3).map(h => {
    const tiles = personal.get(h.hero!);
    const hp = picks.get(h.hero!) ?? {};
    const slots = tiles ? slotValues(h.hero!, tiles, hp) : null;
    const rs = tiles ? resolveSlots(h.hero!, tiles, hp) : null;
    return {
      hero: h.hero!, percent: h.percent, seconds: h.seconds, duration: h.seconds != null ? mss(h.seconds) : '',
      overall_acc: slots?.overall_acc ?? null, crit_acc: slots?.crit_acc ?? null, extra_acc: slots?.extra_acc ?? null,
      torpedo_damage: slots?.torpedo_damage ?? null, torpedo_healing: slots?.torpedo_healing ?? null,
      mapped: slots != null, ...(slots != null && isAutoMapped(h.hero!) ? { auto_mapped: true } : {}), final_blows: tiles ? finalBlows(tiles) : null, has_personal: !!tiles,
      slot_source: { overall: rs?.overall.source ?? null, crit: rs?.crit.source ?? null, extra: rs?.extra.source ?? null },
      pickable: tiles ? pickableTiles(h.hero!, tiles, hp) : {},
    };
  });
  const rk = db.prepare(`
    SELECT r.rank_int, r.progress_pct, r.delta_pct, r.result FROM scoreboard_ranks r JOIN match_scoreboards s ON s.id = r.scoreboard_id
    WHERE s.group_id = ? AND s.page_type = 'rank' AND s.status NOT IN ('dismissed', 'error') ORDER BY s.file_mtime DESC, s.id DESC LIMIT 1
  `).get(groupId) as { rank_int: number | null; progress_pct: number | null; delta_pct: number | null; result: 'victory' | 'defeat' | 'draw' | null } | undefined;
  const start = rk ? deriveStartRank(rk.rank_int, rk.progress_pct, rk.delta_pct) : null;
  const rank: FormFill['rank'] = rk && rk.rank_int != null
    ? { rank_int: rk.rank_int, progress_pct: rk.progress_pct, delta_pct: rk.delta_pct, result: rk.result, start_rank_int: start?.rankInt ?? null, start_progress_pct: start?.progressPct ?? null } : null;
  const everyFb = heroes.length > 0 && heroes.every(h => h.final_blows != null);
  const secs = heroes.map(h => h.seconds);
  return {
    group_id: g.id, state: g.state,
    map: sum?.map ?? null,
    win: sum?.result === 'victory' ? 1 : sum?.result === 'defeat' ? 0 : null,
    score_us: sum?.scoreUs ?? null, score_them: sum?.scoreThem ?? null,
    heroes,
    elims: sum?.elims ?? null, assists: sum?.assists ?? null, deaths: sum?.deaths ?? null,
    damage: totals?.damage ?? self?.dmg ?? null, healing: totals?.healing ?? self?.h ?? null, mitigation: self?.mit ?? null,
    final_blows: everyFb ? heroes.reduce((a, h) => a + (h.final_blows ?? 0), 0) : null,
    duration_min: heroes.length && secs.every(s => s != null) ? secs.reduce((a, s) => a + (s as number), 0) / 60 : null,
    game_length_sec: sum?.lengthSec ?? null,
    pages: { summary: !!sum, teams: !!self, personal: [...personal.keys()], all_heroes: !!totals },
    rank,
    leaver_side: boardLeaver?.side ?? null, short_board: !!boardLeaver,
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
export function finalizeGroups(db: DatabaseSync, nowMs: number = Date.now(), onlyGroup?: number): number {
  const due = (db.prepare(`SELECT * FROM scoreboard_groups WHERE state IN ('recovery', 'linked') AND match_id IS NOT NULL AND filled_at IS NULL`).all() as unknown as GroupRow[]).filter(g => onlyGroup == null || g.id === onlyGroup);
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
