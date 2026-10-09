// Keeps the Drive "OW Game Logs" folder tidy (approved by Sean 2026-10-09:
// "my brain needs it to be organized"). Moves and renames only; NEVER deletes
// and never overwrites. Layout:
//   top level          unprocessed files, and unmatched files inside the rematch grace
//   YYYY-MM-DD/        matched: "<matchId> <Map> <Hero>.<ext>" (the match's local date)
//   _needs-attention/  unmatched past the grace window, and error rows
//   _copies/           exact copies and hand-dismissed rows
//   _other/            not_scoreboard
// A move happens only after the DB row is committed and the file is >= 60 s old.
// The rename and the file_path update are one step: a failed update renames back.
import fs from 'fs';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { REMATCH_GRACE_MIN } from './scoreboard';

export const MIN_FILE_AGE_MS = 60_000;

/** Replace characters Windows forbids in file names, and trailing dots/spaces. */
export function windowsSafe(s: string): string {
  return s.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/[. ]+$/, '').trim();
}

/** `<dir>/<stem><ext>`, or `<stem> (2)<ext>`, `(3)`... when taken. Never returns an existing path. */
export function uniqueDest(dir: string, stem: string, ext: string): string {
  let cand = path.join(dir, `${stem}${ext}`);
  for (let n = 2; fs.existsSync(cand); n++) cand = path.join(dir, `${stem} (${n})${ext}`);
  return cand;
}

interface BoardRow { id: number; match_id: number | null; file_path: string; file_mtime: string; status: string }

/** Target folder (absolute) and desired file stem for a board, or null to leave it where it is. */
function target(db: DatabaseSync, root: string, b: BoardRow, nowMs: number): { dir: string; stem: string | null } | null {
  switch (b.status) {
    case 'matched': {
      const m = db.prepare(`SELECT date, map, hero FROM matches WHERE id = ?`).get(b.match_id) as { date: string; map: string; hero: string } | undefined;
      if (!m || !m.date) return null;
      return { dir: path.join(root, windowsSafe(m.date)), stem: windowsSafe(`${b.match_id} ${m.map} ${m.hero}`) };
    }
    case 'not_scoreboard': return { dir: path.join(root, '_other'), stem: null };
    case 'dismissed': return { dir: path.join(root, '_copies'), stem: null };
    case 'error': return { dir: path.join(root, '_needs-attention'), stem: null };
    case 'unmatched':
      // Stays on top while rematchRecent can still retry it.
      return nowMs - Date.parse(b.file_mtime) >= REMATCH_GRACE_MIN * 60_000 ? { dir: path.join(root, '_needs-attention'), stem: null } : null;
    default: return null;
  }
}

/**
 * Move one board's file to its place. Returns the new path, or null when it was
 * left alone (already placed, too fresh, outside root, missing, or a move error).
 * Never throws.
 */
export function organizeBoard(db: DatabaseSync, id: number, root: string, nowMs: number = Date.now()): string | null {
  try {
    const b = db.prepare(`SELECT id, match_id, file_path, file_mtime, status FROM match_scoreboards WHERE id = ?`).get(id) as BoardRow | undefined;
    if (!b) return null;
    const rel = path.relative(root, b.file_path);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null; // never touch files outside the folder
    const t = target(db, root, b, nowMs);
    if (!t) return null;
    const ext = path.extname(b.file_path);
    const curDir = path.dirname(b.file_path);
    const curBase = path.basename(b.file_path, ext);
    if (curDir === t.dir) {
      // Already in place. A matched file also needs its name; "(2)" suffixes count as in place.
      if (t.stem == null || curBase === t.stem || curBase.replace(/ \(\d+\)$/, '') === t.stem) return null;
    }
    let st: fs.Stats;
    try { st = fs.statSync(b.file_path); } catch { return null; } // file gone: leave the row, stay quiet (this runs every poll)
    if (!st.isFile()) return null;
    if (nowMs - st.mtimeMs < MIN_FILE_AGE_MS) return null; // Drive may still be writing it
    fs.mkdirSync(t.dir, { recursive: true });
    const dest = uniqueDest(t.dir, t.stem ?? path.basename(b.file_path, ext), ext);
    fs.renameSync(b.file_path, dest);
    try {
      db.prepare(`UPDATE match_scoreboards SET file_path = ? WHERE id = ?`).run(dest, id);
    } catch (e) {
      try { fs.renameSync(dest, b.file_path); } catch { /* leave it; the watcher repoints by basename+mtime only at top level */ }
      throw e;
    }
    console.log(`[scoreboard] moved board ${id}: ${path.relative(root, dest)}`);
    return dest;
  } catch (e) {
    console.warn(`[scoreboard] organize board ${id} failed: ${(e as Error).message}; retry next poll`);
    return null;
  }
}

/** One pass over every board. Returns how many files moved. */
export function organizeAll(db: DatabaseSync, root: string, nowMs: number = Date.now()): number {
  let moved = 0;
  const ids = db.prepare(`SELECT id FROM match_scoreboards ORDER BY id`).all() as { id: number }[];
  for (const { id } of ids) if (organizeBoard(db, id, root, nowMs)) moved++;
  return moved;
}
