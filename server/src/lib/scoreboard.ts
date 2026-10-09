// Scoreboard screenshot ingest (build spec 2026-10-09). Sean presses Win+PrtScn
// on the post-match TEAMS tab; Drive for desktop syncs the PNG to the Mac mini;
// scoreboardWatcher.ts polls the folder and calls processFile() below.
//
// Rules that must not drift:
//  - Nothing here ever creates, edits or deletes a matches row.
//  - A scoreboard attaches to a match only when exactly ONE candidate passes
//    every test. Zero or 2+ -> 'unmatched'. Never guess.
//  - The Drive folder is read-only to us: no move, rename or delete.
import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import Anthropic from '@anthropic-ai/sdk';
import type { DatabaseSync } from 'node:sqlite';
import { ALL_HEROES_BY_ROLE } from './heroes';

export const SCOREBOARD_MODEL = 'claude-haiku-5-5';
/** A match's created_at (the log time) must fall 0..20 min AFTER the file mtime. */
export const MATCH_WINDOW_MIN = 20;
/** Unmatched rows younger than this are re-tried each poll (Sean may log late). */
export const REMATCH_GRACE_MIN = 45;
export const MAX_IMAGE_WIDTH = 1920;
const MAX_API_ATTEMPTS = 3;
const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg']);

export interface ParsedRow {
  team: 'us' | 'them';
  role: 'tank' | 'dps' | 'support';
  is_self: boolean;
  hero: string | null;
  player_name: string;
  e: number; a: number; d: number; dmg: number; h: number; mit: number;
}
export interface ParsedScoreboard { is_scoreboard: boolean; rows: ParsedRow[] }

export interface MatchCandidate { id: number; created_at: string; account: string | null; role: string; hero: string; hasScoreboard: boolean }
export interface SelfRow { name: string; role: string; hero: string | null }
export interface MatchDecision { matchId: number | null; reason: string | null }

// ---------------------------------------------------------------- matching

/** SQLite datetime('now') is UTC without a zone marker. */
export function parseDbUtc(s: string): number {
  return Date.parse(s.replace(' ', 'T') + 'Z');
}

export function decideMatch(mtimeMs: number, self: SelfRow, candidates: MatchCandidate[]): MatchDecision {
  const lo = mtimeMs;
  const hi = mtimeMs + MATCH_WINDOW_MIN * 60_000;
  const inWindow = candidates.filter(c => {
    const t = parseDbUtc(c.created_at);
    return t >= lo && t <= hi;
  });
  const sameAccount = inWindow.filter(c => c.account != null && c.account.toLowerCase() === self.name.toLowerCase());
  if (sameAccount.length === 0) {
    return { matchId: null, reason: inWindow.length ? `no match in the window for account "${self.name}"` : `no match logged within ${MATCH_WINDOW_MIN} min after the screenshot` };
  }
  const roleOk = sameAccount.filter(c => c.role.toLowerCase() === self.role.toLowerCase());
  if (roleOk.length === 0) return { matchId: null, reason: `role on the scoreboard (${self.role}) differs from the logged role` };
  const heroOk = roleOk.filter(c => !self.hero || c.hero.toLowerCase() === self.hero.toLowerCase());
  if (heroOk.length === 0) return { matchId: null, reason: `hero on the scoreboard (${self.hero}) differs from the logged hero` };
  if (heroOk.length > 1) return { matchId: null, reason: `${heroOk.length} logged matches fit the window` };
  if (heroOk[0].hasScoreboard) return { matchId: null, reason: 'that match already has a scoreboard' };
  return { matchId: heroOk[0].id, reason: null };
}

function loadCandidates(db: DatabaseSync, mtimeMs: number): MatchCandidate[] {
  // Coarse SQL bound (a minute of slack each side); decideMatch applies the exact window.
  const fmt = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
  const rows = db.prepare(`
    SELECT m.id, m.created_at, m.account, m.role, m.hero,
           EXISTS(SELECT 1 FROM match_scoreboards s WHERE s.match_id = m.id) AS has_sb
    FROM matches m
    WHERE m.created_at BETWEEN ? AND ?
  `).all(fmt(mtimeMs - 60_000), fmt(mtimeMs + (MATCH_WINDOW_MIN + 1) * 60_000)) as any[];
  return rows.map(r => ({ id: r.id, created_at: r.created_at, account: r.account, role: r.role, hero: r.hero, hasScoreboard: !!r.has_sb }));
}

function selfOf(rows: ParsedRow[]): SelfRow | null {
  const r = rows.find(x => x.team === 'us' && x.is_self);
  return r ? { name: r.player_name, role: r.role, hero: r.hero } : null;
}

// ------------------------------------------------------------- validation

/** Returns a problem description, or null when the parsed output is usable. */
export function validateParsed(p: ParsedScoreboard): string | null {
  const us = p.rows.filter(r => r.team === 'us');
  const them = p.rows.filter(r => r.team === 'them');
  if (us.length !== them.length || (us.length !== 5 && us.length !== 6)) return `unexpected row counts (us ${us.length}, them ${them.length})`;
  if (us.filter(r => r.is_self).length !== 1) return 'did not find exactly one self row on the top team';
  if (them.some(r => r.is_self)) return 'self row marked on the enemy team';
  return null;
}

// ----------------------------------------------------------------- storage

export function storeScoreboard(
  db: DatabaseSync,
  args: { filePath: string; mtimeMs: number; status: 'matched' | 'unmatched' | 'not_scoreboard' | 'error'; reason: string | null; raw: unknown; matchId: number | null; rows: ParsedRow[] },
): number {
  db.exec('BEGIN');
  try {
    const info = db.prepare(`
      INSERT INTO match_scoreboards (match_id, file_path, file_mtime, status, reason, raw_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(args.matchId, args.filePath, new Date(args.mtimeMs).toISOString(), args.status, args.reason, args.raw == null ? null : JSON.stringify(args.raw));
    const id = Number(info.lastInsertRowid);
    const ins = db.prepare(`
      INSERT INTO scoreboard_rows (scoreboard_id, team, slot, is_self, role, hero, player_name, e, a, d, dmg, h, mit)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const slots = { us: 0, them: 0 };
    for (const r of args.rows) {
      ins.run(id, r.team, slots[r.team]++, r.is_self ? 1 : 0, r.role, r.hero, r.player_name, r.e, r.a, r.d, r.dmg, r.h, r.mit);
    }
    db.exec('COMMIT');
    return id;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Re-run matching for recent unmatched scoreboards (the match may be logged after the file lands). */
export function rematchRecent(db: DatabaseSync, nowMs: number = Date.now()): number {
  const cutoff = new Date(nowMs - REMATCH_GRACE_MIN * 60_000).toISOString();
  const pending = db.prepare(`SELECT id, file_mtime FROM match_scoreboards WHERE status = 'unmatched' AND file_mtime >= ?`).all(cutoff) as { id: number; file_mtime: string }[];
  let n = 0;
  for (const sb of pending) {
    const rows = db.prepare(`SELECT team, is_self, role, hero, player_name FROM scoreboard_rows WHERE scoreboard_id = ?`).all(sb.id) as any[];
    const self = rows.find(r => r.team === 'us' && r.is_self);
    if (!self) continue;
    const mtimeMs = Date.parse(sb.file_mtime);
    const d = decideMatch(mtimeMs, { name: self.player_name, role: self.role, hero: self.hero }, loadCandidates(db, mtimeMs));
    if (d.matchId != null) {
      db.prepare(`UPDATE match_scoreboards SET match_id = ?, status = 'matched', reason = NULL WHERE id = ?`).run(d.matchId, sb.id);
      n++;
    } else {
      db.prepare(`UPDATE match_scoreboards SET reason = ? WHERE id = ?`).run(d.reason, sb.id);
    }
  }
  return n;
}

// ------------------------------------------------------------- vision call

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['is_scoreboard', 'rows'],
  properties: {
    is_scoreboard: { type: 'boolean' },
    rows: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['team', 'role', 'is_self', 'hero', 'player_name', 'e', 'a', 'd', 'dmg', 'h', 'mit'],
        properties: {
          team: { type: 'string', enum: ['us', 'them'] },
          role: { type: 'string', enum: ['tank', 'dps', 'support'] },
          is_self: { type: 'boolean' },
          hero: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          player_name: { type: 'string' },
          e: { type: 'integer' }, a: { type: 'integer' }, d: { type: 'integer' },
          dmg: { type: 'integer' }, h: { type: 'integer' }, mit: { type: 'integer' },
        },
      },
    },
  },
};

function systemPrompt(): string {
  const heroes = ALL_HEROES_BY_ROLE(['Tank', 'DPS', 'Support']).join(', ');
  return [
    'You read Overwatch 2 post-match scoreboard screenshots.',
    'First decide is_scoreboard: true only for the post-match TEAMS tab with two teams of player rows and the columns E, A, D, DMG, H, MIT. Any other image (desktop, other game, web page, in-match HUD) is false, with rows as an empty array.',
    'If it is a scoreboard, return one entry per player row. Top block is team "us" (the viewer\'s team, yellow), bottom block is team "them" (red). Keep the on-screen order within each team.',
    'Read the row count from the image: 6 per team in 6v6, 5 in 5v5. Do not assume it.',
    'is_self is true for the single brighter highlighted row of the viewer on the top team, false for every other row.',
    'role comes from the role icon at the left of the row: tank, dps or support.',
    'There is no hero name text on the screen. Identify the hero from the portrait only. Use exactly one of these names: ' + heroes + '. If you are not sure, return null. Do not guess.',
    'player_name is the name text of the row. Numbers use thousands commas (7,772 is 7772). Return plain integers.',
    'Ignore any overlay at the top left (MSI Afterburner) and the stats bar at the top right. Win or loss is not on this screen; do not report it.',
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
 * Process one image that is not yet in match_scoreboards. Returns the new
 * status, or null when the file was left for a retry on the next poll.
 */
export async function processFile(
  db: DatabaseSync,
  filePath: string,
  mtimeMs: number,
  vision: VisionFn = callVision,
): Promise<string | null> {
  let parsed: ParsedScoreboard;
  try {
    parsed = await vision(filePath);
  } catch (err) {
    const n = (attempts.get(filePath) ?? 0) + 1;
    attempts.set(filePath, n);
    const msg = (err as Error).message;
    if (n < MAX_API_ATTEMPTS) {
      console.warn(`[scoreboard] ${path.basename(filePath)}: attempt ${n} failed (${msg}); will retry`);
      return null;
    }
    storeScoreboard(db, { filePath, mtimeMs, status: 'error', reason: `vision call failed ${n} times: ${msg}`, raw: null, matchId: null, rows: [] });
    return 'error';
  }
  attempts.delete(filePath);

  if (!parsed.is_scoreboard) {
    storeScoreboard(db, { filePath, mtimeMs, status: 'not_scoreboard', reason: null, raw: parsed, matchId: null, rows: [] });
    return 'not_scoreboard';
  }
  const problem = validateParsed(parsed);
  if (problem) {
    storeScoreboard(db, { filePath, mtimeMs, status: 'error', reason: problem, raw: parsed, matchId: null, rows: [] });
    return 'error';
  }
  const self = selfOf(parsed.rows)!;
  const decision = decideMatch(mtimeMs, self, loadCandidates(db, mtimeMs));
  const status = decision.matchId != null ? 'matched' : 'unmatched';
  storeScoreboard(db, { filePath, mtimeMs, status, reason: decision.reason, raw: parsed, matchId: decision.matchId, rows: parsed.rows });
  return status;
}

export function isImageName(name: string): boolean {
  return IMAGE_EXT.has(path.extname(name).toLowerCase()) && !name.startsWith('.');
}
