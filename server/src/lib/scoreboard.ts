// Scoreboard screenshot ingest (build spec 2026-10-09). Sean presses Win+PrtScn
// on the post-match TEAMS tab; Drive for desktop syncs the PNG to the Mac mini;
// scoreboardWatcher.ts polls the folder and calls processFile() below.
//
// Rules that must not drift:
//  - Nothing here ever creates, edits or deletes a matches row.
//  - A scoreboard attaches to a match only when exactly ONE candidate passes
//    every test. Zero or 2+ -> 'unmatched'. Never guess.
//  - Files in the Drive folder may be MOVED and renamed (scoreboardOrganize.ts,
//    approved 2026-10-09) but never deleted or overwritten.
//  - Rule 1: a board whose rows equal a stored board is a copy -> 'dismissed'.
//  - Rule 2: with zero candidates in the window, link by exact stats (one hit only).
import { syncMatchHeroStats } from './matchHeroStats';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';
import type { DatabaseSync } from 'node:sqlite';
import { PATCH_BOUNDARIES } from './patchEra';
import {
  TEAMS_ONLY, parseDbUtc, normSummary, rosterHero, findOpenGroup, createGroup, touchGroup, linkGroup, groupSummaryMap,
  adoptLoosePages, recoveryCandidates, finalizeGroups, type RawSummary, type RawPersonal, type PageType, type GroupRow,
} from './scoreboardPages';
export { parseDbUtc };

export const SCOREBOARD_MODEL = 'claude-haiku-5-5';
/** A match's created_at (the log time) must fall within +/- this many minutes of the file mtime. Sean usually logs 5-21 s BEFORE the screenshot, but may log a few minutes after. */
export const MATCH_WINDOW_MIN = 10;
/** Unmatched rows younger than this are re-tried each poll (Sean may log late). */
export const REMATCH_GRACE_MIN = 45;
export const MAX_IMAGE_WIDTH = 1920;
const MAX_API_ATTEMPTS = 3;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg']);

export interface ParsedRow {
  team: 'us' | 'them';
  role: 'tank' | 'dps' | 'support';
  /** The model's highlight guess. Audit only (kept in raw_json); the stored is_self comes from the player name. */
  is_self: boolean;
  player_name: string;
  e: number; a: number; d: number; dmg: number; h: number; mit: number;
}
/**
 * One vision reading of one screenshot. page_type is the model's classification;
 * older stored readings and test stubs carry only is_scoreboard, which means
 * "teams" when true. summary and personal are filled for their page type only.
 */
export interface ParsedScoreboard {
  is_scoreboard: boolean; rows: ParsedRow[];
  page_type?: PageType; summary?: RawSummary; personal?: RawPersonal;
}

export interface MatchCandidate { id: number; created_at: string; account: string | null; role: string; hasScoreboard: boolean }
export interface SelfRow { name: string; role: string }
export interface MatchDecision { matchId: number | null; reason: string | null }

// ---------------------------------------------------------------- matching

export function decideMatch(mtimeMs: number, self: SelfRow, candidates: MatchCandidate[]): MatchDecision {
  const lo = mtimeMs - MATCH_WINDOW_MIN * 60_000;
  const hi = mtimeMs + MATCH_WINDOW_MIN * 60_000;
  const inWindow = candidates.filter(c => {
    const t = parseDbUtc(c.created_at);
    return t >= lo && t <= hi;
  });
  const sameAccount = inWindow.filter(c => c.account != null && c.account.toLowerCase() === self.name.toLowerCase());
  if (sameAccount.length === 0) {
    return { matchId: null, reason: inWindow.length ? `no match in the window for account "${self.name}"` : `no match logged within ${MATCH_WINDOW_MIN} min of the screenshot` };
  }
  const roleOk = sameAccount.filter(c => c.role.toLowerCase() === self.role.toLowerCase());
  if (roleOk.length === 0) return { matchId: null, reason: `role on the scoreboard (${self.role}) differs from the logged role` };
  if (roleOk.length > 1) return { matchId: null, reason: `${roleOk.length} logged matches fit the window` };
  if (roleOk[0].hasScoreboard) return { matchId: null, reason: 'that match already has a scoreboard' };
  return { matchId: roleOk[0].id, reason: null };
}

function loadCandidates(db: DatabaseSync, mtimeMs: number): MatchCandidate[] {
  // Coarse SQL bound (a minute of slack each side); decideMatch applies the exact +/- window.
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const rows = db.prepare(`
    SELECT m.id, m.created_at, m.account, m.role,
           EXISTS(SELECT 1 FROM match_scoreboards s WHERE s.match_id = m.id AND ${TEAMS_ONLY}) AS has_sb
    FROM matches m
    WHERE m.created_at BETWEEN ? AND ?
  `).all(fmt(mtimeMs - (MATCH_WINDOW_MIN + 1) * 60_000), fmt(mtimeMs + (MATCH_WINDOW_MIN + 1) * 60_000)) as any[];
  return rows.map(r => ({ id: r.id, created_at: r.created_at, account: r.account, role: r.role, hasScoreboard: !!r.has_sb }));
}


// ---------------------------------------------------- rule 2: link by stats

export interface SelfStats { name: string; e: number; a: number; d: number; dmg: number; h: number }

/**
 * Rule 2 (2026-10-09). Only when NO logged match falls inside the +/- window:
 * find matches on/after the latest patch boundary (History resets each patch)
 * for the same account whose aim_stats elims/deaths/damage equal the board's
 * self row, plus assists/healing when those logged values are non-null, and
 * that have no scoreboard yet. Exactly one -> linked. Zero or 2+ -> null.
 */
export function decideByStats(db: DatabaseSync, mtimeMs: number, s: SelfStats): number | null {
  const inWindow = loadCandidates(db, mtimeMs).filter(c => Math.abs(parseDbUtc(c.created_at) - mtimeMs) <= MATCH_WINDOW_MIN * 60_000);
  if (inWindow.length > 0) return null;
  const since = PATCH_BOUNDARIES[PATCH_BOUNDARIES.length - 1] ?? '0000-00-00';
  const hits = db.prepare(`
    SELECT m.id FROM matches m JOIN aim_stats a ON a.match_id = m.id
    WHERE LOWER(TRIM(m.account)) = ? AND m.date >= ?
      AND a.elims = ? AND a.deaths = ? AND a.damage = ?
      AND (a.assists IS NULL OR a.assists = ?) AND (a.healing IS NULL OR a.healing = ?)
      AND NOT EXISTS (SELECT 1 FROM match_scoreboards s WHERE s.match_id = m.id AND ${TEAMS_ONLY})
  `).all(norm(s.name), since, s.e, s.d, s.dmg, s.a, s.h) as { id: number }[];
  return hits.length === 1 ? hits[0].id : null;
}

/** Window decision first; rule 2 only when that finds nothing. */
function decideFull(db: DatabaseSync, mtimeMs: number, s: SelfStats, role: string): MatchDecision {
  const d = decideMatch(mtimeMs, { name: s.name, role }, loadCandidates(db, mtimeMs));
  if (d.matchId != null) return d;
  const id = decideByStats(db, mtimeMs, s);
  return id != null ? { matchId: id, reason: 'linked by stats' } : d;
}

// ------------------------------------------------- rule 1: exact copies

const rowKey = (r: { team: string; e: number; a: number; d: number; dmg: number; h: number; mit: number }) =>
  `${r.team}|${r.e}|${r.a}|${r.d}|${r.dmg}|${r.h}|${r.mit}`;

/** Id of a stored board whose multiset of (team,e,a,d,dmg,h,mit) equals these rows, else null. Slot order is ignored. */
export function findCopyOf(db: DatabaseSync, rows: ParsedRow[]): number | null {
  if (!rows.length) return null;
  const want = rows.map(rowKey).sort().join(';');
  const r0 = rows[0];
  const cands = db.prepare(`SELECT DISTINCT scoreboard_id AS id FROM scoreboard_rows WHERE team = ? AND e = ? AND a = ? AND d = ? AND dmg = ? AND h = ? AND mit = ? ORDER BY scoreboard_id`)
    .all(r0.team, r0.e, r0.a, r0.d, r0.dmg, r0.h, r0.mit) as { id: number }[];
  for (const c of cands) {
    const got = (db.prepare(`SELECT team, e, a, d, dmg, h, mit FROM scoreboard_rows WHERE scoreboard_id = ?`).all(c.id) as any[]).map(rowKey).sort().join(';');
    if (got === want) return c.id;
  }
  return null;
}

/** Sean's account names: the distinct non-null matches.account values. */
export function loadAccounts(db: DatabaseSync): string[] {
  return (db.prepare(`SELECT DISTINCT account FROM matches WHERE account IS NOT NULL AND TRIM(account) <> ''`).all() as { account: string }[]).map(r => r.account);
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * The self row is the ONE row on the "us" team whose player name equals a known
 * account name (case-insensitive, trimmed). The highlight is not used: the model
 * pointed at the wrong row on 2026-10-09. Zero or 2+ matches -> a reason string.
 */
export function resolveSelf(rows: { team: string; player_name: string }[], accounts: string[]): { index: number } | { error: string } {
  const known = new Set(accounts.map(norm));
  const hits = rows.map((r, i) => (r.team === 'us' && known.has(norm(r.player_name)) ? i : -1)).filter(i => i >= 0);
  if (hits.length === 0) return { error: 'no row on the top team has a known account name' };
  if (hits.length > 1) return { error: `${hits.length} rows on the top team have a known account name (${hits.map(i => rows[i].player_name).join(', ')})` };
  return { index: hits[0] };
}

// ------------------------------------------------------------- validation

/** Returns a problem description, or null when the parsed output is usable. */
export function validateParsed(p: ParsedScoreboard): string | null {
  const us = p.rows.filter(r => r.team === 'us');
  const them = p.rows.filter(r => r.team === 'them');
  if (us.length !== them.length || (us.length !== 5 && us.length !== 6)) return `unexpected row counts (us ${us.length}, them ${them.length})`;
  return null;
}

// ----------------------------------------------------------------- storage

export interface StoreArgs {
  filePath: string; mtimeMs: number;
  status: 'matched' | 'unmatched' | 'not_scoreboard' | 'error' | 'dismissed';
  reason: string | null; raw: unknown; matchId: number | null;
  rows: ParsedRow[]; // is_self already resolved by name; hero is never stored
  pageType?: PageType | null; groupId?: number | null; pageHero?: string | null;
  /** Re-read of a stored image (backfill): update that row in place, because file_path is UNIQUE and ids are referenced. */
  replaceId?: number;
}

export function storeScoreboard(db: DatabaseSync, args: StoreArgs): number {
  db.exec('BEGIN');
  try {
    const mtimeIso = new Date(args.mtimeMs).toISOString();
    const raw = args.raw == null ? null : JSON.stringify(args.raw);
    let id: number;
    if (args.replaceId != null) {
      id = args.replaceId;
      db.prepare(`DELETE FROM scoreboard_rows WHERE scoreboard_id = ?`).run(id);
      db.prepare(`
        UPDATE match_scoreboards SET match_id = ?, file_mtime = ?, status = ?, reason = ?, raw_json = ?, page_type = ?, group_id = ?, page_hero = ? WHERE id = ?
      `).run(args.matchId, mtimeIso, args.status, args.reason, raw, args.pageType ?? null, args.groupId ?? null, args.pageHero ?? null, id);
    } else {
      const info = db.prepare(`
        INSERT INTO match_scoreboards (match_id, file_path, file_mtime, status, reason, raw_json, page_type, group_id, page_hero)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(args.matchId, args.filePath, mtimeIso, args.status, args.reason, raw, args.pageType ?? null, args.groupId ?? null, args.pageHero ?? null);
      id = Number(info.lastInsertRowid);
    }
    const ins = db.prepare(`
      INSERT INTO scoreboard_rows (scoreboard_id, team, slot, is_self, role, hero, player_name, e, a, d, dmg, h, mit)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)
    `);
    const slots = { us: 0, them: 0 };
    for (const r of args.rows) {
      ins.run(id, r.team, slots[r.team]++, r.is_self ? 1 : 0, r.role, r.player_name, r.e, r.a, r.d, r.dmg, r.h, r.mit);
    }
    db.exec('COMMIT');
    if (args.matchId != null && args.pageType === 'personal' && args.status === 'matched') syncMatchHeroStats(db, args.matchId);
    return id;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Re-run matching for recent unmatched scoreboards (the match may be logged after the file lands). */
export function rematchRecent(db: DatabaseSync, nowMs: number = Date.now()): number {
  const cutoff = new Date(nowMs - REMATCH_GRACE_MIN * 60_000).toISOString();
  const pending = db.prepare(`SELECT id, file_mtime FROM match_scoreboards WHERE status = 'unmatched' AND group_id IS NULL AND file_mtime >= ?`).all(cutoff) as { id: number; file_mtime: string }[];
  let n = 0;
  for (const sb of pending) {
    const rows = db.prepare(`SELECT team, is_self, role, player_name, e, a, d, dmg, h FROM scoreboard_rows WHERE scoreboard_id = ?`).all(sb.id) as any[];
    const self = rows.find(r => r.team === 'us' && r.is_self);
    if (!self) continue;
    const mtimeMs = Date.parse(sb.file_mtime);
    const d = decideFull(db, mtimeMs, { name: self.player_name, e: self.e, a: self.a, d: self.d, dmg: self.dmg, h: self.h }, self.role);
    if (d.matchId != null) {
      db.prepare(`UPDATE match_scoreboards SET match_id = ?, status = 'matched', reason = ? WHERE id = ?`).run(d.matchId, d.reason, sb.id);
      n++;
    } else {
      db.prepare(`UPDATE match_scoreboards SET reason = ? WHERE id = ?`).run(d.reason, sb.id);
    }
  }
  return n;
}

/**
 * One-off repair (2026-10-09): recompute is_self from player names, null every
 * stored hero, and re-run matching for all matched/unmatched scoreboards in
 * file_mtime order. No vision calls. Never touches matches rows.
 */
export function recomputeScoreboards(db: DatabaseSync): { id: number; status: string; matchId: number | null; reason: string | null }[] {
  const accounts = loadAccounts(db);
  const boards = db.prepare(`SELECT id, file_mtime FROM match_scoreboards WHERE status IN ('matched','unmatched') AND group_id IS NULL AND (page_type IS NULL OR page_type = 'teams') ORDER BY file_mtime, id`).all() as { id: number; file_mtime: string }[];
  const out: { id: number; status: string; matchId: number | null; reason: string | null }[] = [];
  db.exec('BEGIN');
  try {
    // Release every match first so a board does not block its own re-attach.
    for (const b of boards) db.prepare(`UPDATE match_scoreboards SET match_id = NULL, status = 'unmatched' WHERE id = ?`).run(b.id);
    for (const b of boards) {
      db.prepare(`UPDATE scoreboard_rows SET hero = NULL, is_self = 0 WHERE scoreboard_id = ?`).run(b.id);
      const rows = db.prepare(`SELECT team, slot, role, player_name, e, a, d, dmg, h FROM scoreboard_rows WHERE scoreboard_id = ? ORDER BY team DESC, slot`).all(b.id) as any[];
      const found = resolveSelf(rows, accounts);
      if ('error' in found) {
        const reason = `self row: ${found.error}`;
        db.prepare(`UPDATE match_scoreboards SET status = 'error', reason = ? WHERE id = ?`).run(reason, b.id);
        out.push({ id: b.id, status: 'error', matchId: null, reason });
        continue;
      }
      const self = rows[found.index];
      db.prepare(`UPDATE scoreboard_rows SET is_self = 1 WHERE scoreboard_id = ? AND team = ? AND slot = ?`).run(b.id, self.team, self.slot);
      const mtimeMs = Date.parse(b.file_mtime);
      const d = decideFull(db, mtimeMs, { name: self.player_name, e: self.e, a: self.a, d: self.d, dmg: self.dmg, h: self.h }, self.role);
      if (d.matchId != null) db.prepare(`UPDATE match_scoreboards SET match_id = ?, status = 'matched', reason = ? WHERE id = ?`).run(d.matchId, d.reason, b.id);
      else db.prepare(`UPDATE match_scoreboards SET reason = ? WHERE id = ?`).run(d.reason, b.id);
      out.push({ id: b.id, status: d.matchId != null ? 'matched' : 'unmatched', matchId: d.matchId, reason: d.reason });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return out;
}

// ------------------------------------------------------------- vision call

const TILE = { type: 'object', additionalProperties: false, required: ['label', 'value', 'per10', 'career_best'], properties: { label: { type: 'string' }, value: { type: 'string' }, per10: { type: 'string' }, career_best: { type: 'boolean' } } };
export const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['page_type', 'rows', 'summary', 'personal'],
  properties: {
    page_type: { type: 'string', enum: ['summary', 'teams', 'personal', 'other'] },
    // Teams page only. Empty array for every other page type.
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['team', 'role', 'is_self', 'player_name', 'e', 'a', 'd', 'dmg', 'h', 'mit'],
        properties: {
          team: { type: 'string', enum: ['us', 'them'] },
          role: { type: 'string', enum: ['tank', 'dps', 'support'] },
          is_self: { type: 'boolean' },
          player_name: { type: 'string' },
          e: { type: 'integer' }, a: { type: 'integer' }, d: { type: 'integer' },
          dmg: { type: 'integer' }, h: { type: 'integer' }, mit: { type: 'integer' },
        },
      },
    },
    // Summary page only. Empty strings, zeros and an empty array otherwise.
    summary: {
      type: 'object',
      additionalProperties: false,
      required: ['map', 'result', 'score_us', 'score_them', 'game_mode', 'date_text', 'game_length', 'heroes', 'elims', 'assists', 'deaths'],
      properties: {
        map: { type: 'string' }, result: { type: 'string' },
        score_us: { type: 'integer' }, score_them: { type: 'integer' },
        game_mode: { type: 'string' }, date_text: { type: 'string' }, game_length: { type: 'string' },
        heroes: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, required: ['hero', 'percent', 'play_time'], properties: { hero: { type: 'string' }, percent: { type: 'integer' }, play_time: { type: 'string' } } },
        },
        elims: { type: 'integer' }, assists: { type: 'integer' }, deaths: { type: 'integer' },
      },
    },
    // Personal page only. Empty hero and empty tiles otherwise.
    personal: {
      type: 'object',
      additionalProperties: false,
      required: ['hero', 'tiles'],
      properties: { hero: { type: 'string' }, tiles: { type: 'array', items: TILE } },
    },
  },
};

/** The Teams-page rules. No hero field: the hero of a Teams row comes from a portrait and is never reported. */
export const TEAMS_PROMPT = [
  'For a teams page, return one entry in rows per player row. Top block is team "us" (the viewer\'s team, yellow), bottom block is team "them" (red). Keep the on-screen order within each team.',
  'Read the row count from the image: 6 per team in 6v6, 5 in 5v5. Do not assume it.',
  'is_self is your best guess of the single brighter highlighted row of the viewer on the top team, false for every other row.',
  'role comes from the role icon at the left of the row: tank, dps or support.',
  'Do not report hero names.',
  'player_name is the name text of the row. Numbers use thousands commas (7,772 is 7772). Return plain integers.',
  'Win or loss is not on this screen; do not report it.',
].join('\n');

export const SUMMARY_PROMPT = [
  'For a summary page, fill summary and leave rows empty.',
  'map is the map title text as shown (for example NEPAL). result is "victory", "defeat" or "draw" in lower case.',
  'score_us and score_them come from FINAL SCORE "A VS B"; A is the viewer\'s team.',
  'game_mode, date_text and game_length are the values after those labels, exactly as shown (date_text for example "10/09/26 - 12:31").',
  'heroes has one entry per hero in HEROES PLAYED: the hero name as shown, percent as an integer, play_time as shown (mm:ss).',
  'elims, assists and deaths are the three TOTAL PERFORMANCE numbers.',
].join('\n');

export const PERSONAL_PROMPT = [
  'For a personal page, fill personal and leave rows empty.',
  'hero is the hero name in the first tile, or "ALL HEROES" when that tab is selected.',
  'tiles has one entry per stat tile except the hero tile: label exactly as shown, value exactly as shown with the % sign when present, per10 the number on the tile\'s AVG PER 10 MIN line (empty string when the tile has no such line), career_best true only when the tile shows the green NEW CAREER BEST badge.',
].join('\n');

export function systemPrompt(): string {
  return [
    'You read Overwatch 2 post-match screenshots. First decide page_type from the lit tab at the top left:',
    '"teams" = the TEAMS tab: two teams of player rows with the columns E, A, D, DMG, H, MIT.',
    '"summary" = the SUMMARY tab: HEROES PLAYED, TOTAL PERFORMANCE, and a map panel with the result, FINAL SCORE, DATE, GAME MODE and GAME LENGTH.',
    '"personal" = the PERSONAL tab: a hero list at the left and stat tiles for one hero.',
    '"other" = any other image (desktop, other game, web page, in-match HUD, match history list). Fill nothing else.',
    'Fill the section of that page type only. Leave every other section empty (rows []; empty strings; zeros; empty arrays).',
    TEAMS_PROMPT, SUMMARY_PROMPT, PERSONAL_PROMPT,
    'Ignore any overlay at the top left (MSI Afterburner) and the stats bar at the top right.',
  ].join('\n');
}

/** Downscale to MAX_IMAGE_WIDTH with macOS sips; on any failure send the original bytes. */
async function prepareImage(filePath: string): Promise<{ data: Buffer; mediaType: 'image/png' | 'image/jpeg' }> {
  const ext = path.extname(filePath).toLowerCase();
  const mediaType = ext === '.png' ? 'image/png' : 'image/jpeg';
  const original = await fs.promises.readFile(filePath);
  const tmp = path.join(os.tmpdir(), `ow-sb-${process.pid}-${Date.now()}${ext}`);
  try {
    await new Promise<void>((resolve, reject) => {
      execFile('sips', ['--resampleWidth', String(MAX_IMAGE_WIDTH), filePath, '--out', tmp], { timeout: 30_000 }, err => (err ? reject(err) : resolve()));
    });
    const small = await fs.promises.readFile(tmp);
    return { data: small.length < original.length ? small : original, mediaType };
  } catch {
    return { data: original, mediaType };
  } finally {
    fs.promises.unlink(tmp).catch(() => {});
  }
}

export type VisionFn = (filePath: string) => Promise<ParsedScoreboard>;

/** Read errors from a file Drive has not finished syncing (EAGAIN = errno -11, ETIMEDOUT, EBUSY, FS timeout). */
export function isFileNotReady(err: unknown): boolean {
  const e = err as { code?: string; errno?: number; message?: string };
  return e?.errno === -11 || ['EAGAIN', 'ETIMEDOUT', 'EBUSY'].includes(e?.code ?? '')
    || /Unknown system error -11|timed out after/.test(e?.message ?? '');
}

export const callVision: VisionFn = async (filePath) => {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY not set');
  const img = await prepareImage(filePath);
  const client = new Anthropic();
  const response = await client.messages.create({
    model: SCOREBOARD_MODEL,
    max_tokens: 8192,
    system: systemPrompt(),
    output_config: { format: { type: 'json_schema', schema: SCHEMA }, effort: 'low' } as any,
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.data.toString('base64') } },
        { type: 'text', text: 'Parse this screenshot.' },
      ],
    }],
  });
  if (response.stop_reason === 'max_tokens') throw new Error('model output truncated');
  const block = response.content.find((b): b is Anthropic.TextBlock => b.type === 'text');
  if (!block) throw new Error('no text block in model response');
  return JSON.parse(block.text) as ParsedScoreboard;
};

// ------------------------------------------------------------ file pipeline

const attempts = new Map<string, number>();
export function resetAttempts(): void { attempts.clear(); }

/**
 * Process one image. Returns the new status, or null when the file was left for
 * a retry on the next poll. `replaceId` re-reads a stored image and updates its
 * row in place (the backfill); callers feed images in file_mtime order so a
 * Summary page opens its group before the pages that follow it.
 */
export async function processFile(
  db: DatabaseSync,
  filePath: string,
  mtimeMs: number,
  vision: VisionFn = callVision,
  replaceId?: number,
): Promise<string | null> {
  let parsed: ParsedScoreboard;
  try {
    parsed = await vision(filePath);
  } catch (err) {
    if (isFileNotReady(err)) {
      // Drive is still streaming the file. Not a vision failure: no attempt counted, nothing stored.
      console.warn(`[scoreboard] ${path.basename(filePath)}: file not ready (${(err as Error).message}); retry next poll`);
      return null;
    }
    const n = (attempts.get(filePath) ?? 0) + 1;
    attempts.set(filePath, n);
    const msg = (err as Error).message;
    if (n < MAX_API_ATTEMPTS) {
      console.warn(`[scoreboard] ${path.basename(filePath)}: attempt ${n} failed (${msg}); will retry`);
      return null;
    }
    storeScoreboard(db, { filePath, mtimeMs, status: 'error', reason: `vision call failed ${n} times: ${msg}`, raw: null, matchId: null, rows: [], replaceId });
    return 'error';
  }
  attempts.delete(filePath);

  const pageType: PageType = parsed.page_type ?? (parsed.is_scoreboard ? 'teams' : 'other');
  const base = { filePath, mtimeMs, replaceId };
  const store = (a: Omit<StoreArgs, 'filePath' | 'mtimeMs' | 'replaceId'>) => { storeScoreboard(db, { ...base, ...a }); return a.status; };

  if (pageType === 'other') return store({ status: 'not_scoreboard', reason: null, raw: parsed, matchId: null, rows: [], pageType: 'other' });
  if (pageType === 'summary') return processSummary(db, parsed, store, mtimeMs);
  if (pageType === 'personal') return processPersonal(db, parsed, store, mtimeMs);
  return processTeams(db, parsed, store, mtimeMs);
}

type Store = (a: Omit<StoreArgs, 'filePath' | 'mtimeMs' | 'replaceId'>) => StoreArgs['status'];

/** The one Summary decision, shared by a fresh read and a re-check. A logged match on the same map whose created_at is within 10 min of the DATE makes it a recovery. */
function decideSummary(db: DatabaseSync, parsed: ParsedScoreboard, mtimeMs: number): { state: GroupRow['state']; matchId: number | null; reason: string } {
  const norm = parsed.summary ? normSummary(parsed.summary, mtimeMs) : null;
  if (!norm || !norm.map || norm.endMs == null) {
    return { state: 'ambiguous', matchId: null, reason: `summary: ${!norm ? 'no summary read' : !norm.map ? `map "${norm.mapRaw}" is not in the roster` : 'DATE not readable'}` };
  }
  const cands = recoveryCandidates(db, norm.endMs, norm.map);
  if (cands.length === 1) return { state: 'recovery', matchId: cands[0], reason: `recovery of match ${cands[0]}` };
  if (cands.length === 0) return { state: 'live', matchId: null, reason: 'waiting for the match log' };
  return { state: 'ambiguous', matchId: null, reason: `${cands.length} logged matches fit the Summary DATE` };
}

/** A Summary page starts a group. */
function processSummary(db: DatabaseSync, parsed: ParsedScoreboard, store: Store, mtimeMs: number): string {
  const d = decideSummary(db, parsed, mtimeMs);
  const gid = createGroup(db, mtimeMs, d.state, d.matchId);
  store({ status: d.matchId != null ? 'matched' : 'unmatched', reason: d.reason, raw: parsed, matchId: d.matchId, rows: [], pageType: 'summary', groupId: gid });
  adoptLoosePages(db, gid);
  return d.matchId != null ? 'matched' : 'unmatched';
}

export interface RecheckResult { groupId: number; oldState: string; newState: string; matchId: number | null; changedRows: number[]; dryRun: boolean }

/**
 * Free re-check of a group from its stored Summary reading (no vision call, no new group).
 * Same decision as processSummary, applied in place, then the group's other pages follow it.
 * dryRun runs everything and rolls back.
 */
export function recheckGroup(db: DatabaseSync, groupId: number, dryRun = false, nowMs: number = Date.now()): RecheckResult {
  const g = db.prepare(`SELECT * FROM scoreboard_groups WHERE id = ?`).get(groupId) as GroupRow | undefined;
  if (!g) throw new Error(`group ${groupId} not found`);
  const sum = db.prepare(`SELECT id, raw_json, file_mtime FROM match_scoreboards WHERE group_id = ? AND page_type = 'summary' AND raw_json IS NOT NULL ORDER BY id LIMIT 1`).get(groupId) as { id: number; raw_json: string; file_mtime: string } | undefined;
  if (!sum) throw new Error(`group ${groupId} has no stored summary reading`);
  const snap = () => db.prepare(`SELECT id, status, match_id, reason FROM match_scoreboards WHERE group_id = ? ORDER BY id`).all(groupId) as { id: number }[];
  const before = JSON.stringify(snap());
  const beforeById = new Map(JSON.parse(before).map((r: { id: number }) => [r.id, JSON.stringify(r)]));
  db.exec('BEGIN');
  try {
    const d = decideSummary(db, JSON.parse(sum.raw_json), Date.parse(sum.file_mtime));
    db.prepare(`UPDATE scoreboard_groups SET state = ?, match_id = ? WHERE id = ?`).run(d.state, d.matchId, groupId);
    db.prepare(`UPDATE match_scoreboards SET status = ?, match_id = ?, reason = ? WHERE id = ?`).run(d.matchId != null ? 'matched' : 'unmatched', d.matchId, d.reason, sum.id);
    if (d.matchId != null) {
      linkGroup(db, groupId, d.matchId, 'recovery', 'recovery of match ' + d.matchId);
      if (!dryRun) finalizeGroups(db, nowMs, groupId);
    } else if (d.state === 'live') {
      db.prepare(`UPDATE match_scoreboards SET reason = 'waiting for the match log' WHERE group_id = ? AND status = 'unmatched' AND id <> ?`).run(groupId, sum.id);
    }
    const changedRows = snap().filter(r => beforeById.get(r.id) !== JSON.stringify(r)).map(r => r.id);
    const res: RecheckResult = { groupId, oldState: g.state, newState: d.state, matchId: d.matchId, changedRows, dryRun };
    db.exec(dryRun ? 'ROLLBACK' : 'COMMIT');
    return res;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

/** A Personal page joins the open group. A second page for the same hero, or the ALL HEROES tab, is kept but never counted. */
function processPersonal(db: DatabaseSync, parsed: ParsedScoreboard, store: Store, mtimeMs: number): string {
  const hero = rosterHero(parsed.personal?.hero);
  const g = findOpenGroup(db, mtimeMs);
  if (!g) return store({ status: 'unmatched', reason: 'personal page with no summary page before it', raw: parsed, matchId: null, rows: [], pageType: 'personal', pageHero: hero });
  touchGroup(db, g.id, mtimeMs);
  const dup = hero && db.prepare(`SELECT id FROM match_scoreboards WHERE group_id = ? AND page_type = 'personal' AND page_hero = ? AND status <> 'dismissed' AND file_mtime <> ?`)
    .get(g.id, hero, new Date(mtimeMs).toISOString()) as { id: number } | undefined;
  if (dup) return store({ status: 'dismissed', reason: `second personal page for ${hero} (page ${dup.id})`, raw: parsed, matchId: null, rows: [], pageType: 'personal', groupId: g.id, pageHero: hero });
  return store({
    status: g.match_id != null ? 'matched' : 'unmatched',
    reason: g.match_id != null ? (g.state === 'recovery' ? `recovery of match ${g.match_id}` : 'group page') : 'waiting for the match log',
    raw: parsed, matchId: g.match_id, rows: [], pageType: 'personal', groupId: g.id, pageHero: hero,
  });
}

/** Teams keeps today's path (rule 1 copies, window, rule 2 stats). Inside a group the group's match wins and a window or stats hit must agree with the Summary map. */
function processTeams(db: DatabaseSync, parsed: ParsedScoreboard, store: Store, mtimeMs: number): string {
  const g = findOpenGroup(db, mtimeMs);
  const gid = g?.id ?? null;
  const pageType: PageType = 'teams';
  const problem = validateParsed(parsed);
  if (problem) return store({ status: 'error', reason: problem, raw: parsed, matchId: null, rows: [], pageType, groupId: gid });
  const found = resolveSelf(parsed.rows, loadAccounts(db));
  if ('error' in found) return store({ status: 'error', reason: `self row: ${found.error}`, raw: parsed, matchId: null, rows: [], pageType, groupId: gid });
  const rows = parsed.rows.map((r, i) => ({ ...r, is_self: i === found.index }));
  const selfRow = rows[found.index];
  if (g) touchGroup(db, g.id, mtimeMs);

  const mapOk = (matchId: number) => {
    const want = g ? groupSummaryMap(db, g.id) : null;
    if (!want) return true;
    return (db.prepare(`SELECT map FROM matches WHERE id = ?`).get(matchId) as { map: string } | undefined)?.map === want;
  };
  const becomeRecovery = (matchId: number, why: string) => {
    if (g && g.state === 'live' && mapOk(matchId)) linkGroup(db, g.id, matchId, 'recovery', why);
  };

  const copyOf = findCopyOf(db, rows);
  if (copyOf != null) {
    const of = db.prepare(`SELECT match_id FROM match_scoreboards WHERE id = ?`).get(copyOf) as { match_id: number | null } | undefined;
    store({ status: 'dismissed', reason: `copy of board ${copyOf}`, raw: parsed, matchId: null, rows, pageType, groupId: gid });
    if (of?.match_id != null) becomeRecovery(of.match_id, `recovery of match ${of.match_id}`);
    return 'dismissed';
  }

  const stats = { name: selfRow.player_name, e: selfRow.e, a: selfRow.a, d: selfRow.d, dmg: selfRow.dmg, h: selfRow.h };
  if (g && g.match_id != null) {
    // The group is already linked: this page belongs to the group's match, unless that match has a Teams page.
    const has = db.prepare(`SELECT 1 FROM match_scoreboards s WHERE s.match_id = ? AND ${TEAMS_ONLY}`).get(g.match_id);
    if (has) return store({ status: 'unmatched', reason: 'that match already has a scoreboard', raw: parsed, matchId: null, rows, pageType, groupId: gid });
    return store({ status: 'matched', reason: g.state === 'recovery' ? `recovery of match ${g.match_id}` : 'group page', raw: parsed, matchId: g.match_id, rows, pageType, groupId: gid });
  }
  const decision = decideFull(db, mtimeMs, stats, selfRow.role);
  if (decision.matchId != null && mapOk(decision.matchId)) {
    store({ status: 'matched', reason: decision.reason, raw: parsed, matchId: decision.matchId, rows, pageType, groupId: gid });
    if (g && g.state === 'live') linkGroup(db, g.id, decision.matchId, 'recovery', 'recovery by teams page');
    return 'matched';
  }
  const reason = g && g.state === 'live' ? 'waiting for the match log' : decision.reason;
  return store({ status: 'unmatched', reason, raw: parsed, matchId: null, rows, pageType, groupId: gid });
}

export function isImageName(name: string): boolean {
  return IMAGE_EXT.has(path.extname(name).toLowerCase()) && !name.startsWith('.');
}
