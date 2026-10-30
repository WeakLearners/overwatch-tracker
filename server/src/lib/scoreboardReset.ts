// "Reset all" on Log Match (2026-10-30). Moves the screenshots of the CURRENT, not-yet-saved match to the
// `_trash/` subfolder of the scoreboard folder (S:\_trash on the gaming PC; the watcher scans only the top level, so it never
// reads _trash/) and marks their rows 'dismissed'. Never unlinks, never deletes a row.
// SCOPE RULE (a file is in only if it is directly in the top level of the scoreboard folder, and one of):
//   1. an image with no match_scoreboards row (new, not read yet)
//   2. a row with match_id NULL and status 'unmatched' or 'error' whose group is the current live group
//      (the newest live group inside the rematch grace, the one the light shows) or has no group
// OUT, always: a row with a match_id or status 'matched', 'not_scoreboard' or 'dismissed'; any file in a
// subfolder (_other/, _needs-attention/, _copies/, dated folders); any file outside the folder (old Drive boards);
// rows of any other group.
import fs from 'fs';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { REMATCH_GRACE_MIN, isImageName } from './scoreboard';
import { uniqueDest } from './scoreboardOrganize';

/** The newest live group inside the grace window: the one the Log Match light shows. */
export function currentLiveGroupId(db: DatabaseSync, nowMs: number = Date.now()): number | null {
  const cutoff = new Date(nowMs - REMATCH_GRACE_MIN * 60_000).toISOString();
  const g = db.prepare(`SELECT id FROM scoreboard_groups WHERE state = 'live' AND last_mtime >= ? ORDER BY summary_mtime DESC, id DESC LIMIT 1`).get(cutoff) as { id: number } | undefined;
  return g?.id ?? null;
}

/** Rows of the current match whose file is at the top level of `dir`. */
export function resetRows(db: DatabaseSync, dir: string, nowMs: number = Date.now()): { id: number; file_path: string }[] {
  const gid = currentLiveGroupId(db, nowMs);
  const rows = db.prepare(`
    SELECT id, file_path FROM match_scoreboards
    WHERE match_id IS NULL AND status IN ('unmatched', 'error') AND (group_id IS NULL OR group_id = ?)
  `).all(gid ?? -1) as { id: number; file_path: string }[];
  return rows.filter(r => path.dirname(r.file_path) === dir);
}

/** Top-level images with no row at all. */
export function resetUnreadFiles(db: DatabaseSync, dir: string): string[] {
  const known = new Set((db.prepare(`SELECT file_path FROM match_scoreboards`).all() as { file_path: string }[]).map(r => r.file_path));
  return fs.readdirSync(dir).filter(isImageName).map(n => path.join(dir, n))
    .filter(p => !known.has(p) && fs.statSync(p, { throwIfNoEntry: false })?.isFile());
}

export const TRASH_DIR = '_trash';

export interface ResetResult { moved: number; failed: number; rowsDismissed: number }

/**
 * Move the in-scope files to `trashDir`, then mark the moved rows dismissed with file_path = the _trash path
 * (a new screenshot that reuses the old file name must not look "known"). A failed move leaves that row alone.
 * The live group, if any, becomes 'ambiguous' so the light goes off and nothing re-links it.
 */
export function resetCurrentMatch(db: DatabaseSync, dir: string, trashDir: string = path.join(dir, TRASH_DIR), nowMs: number = Date.now()): ResetResult {
  const gid = currentLiveGroupId(db, nowMs);
  const rows = resetRows(db, dir, nowMs);
  const unread = resetUnreadFiles(db, dir);
  const out: ResetResult = { moved: 0, failed: 0, rowsDismissed: 0 };
  const toTrash = (file: string): string | null => {
    try {
      fs.mkdirSync(trashDir, { recursive: true });
      const ext = path.extname(file);
      const dest = uniqueDest(trashDir, path.basename(file, ext), ext);
      fs.renameSync(file, dest);
      return dest;
    } catch (e) {
      console.warn(`[scoreboard] reset: cannot move ${path.basename(file)} to _trash: ${(e as Error).message}`);
      return null;
    }
  };
  for (const f of unread) { if (toTrash(f)) out.moved++; else out.failed++; }
  for (const r of rows) {
    // A row whose file is already gone still gets dismissed (nothing to move).
    const dest = fs.existsSync(r.file_path) ? toTrash(r.file_path) : r.file_path;
    if (dest == null) { out.failed++; continue; }
    if (dest !== r.file_path) out.moved++;
    db.prepare(`UPDATE match_scoreboards SET status = 'dismissed', reason = 'reset by hand', file_path = ? WHERE id = ?`).run(dest, r.id);
    out.rowsDismissed++;
  }
  if (gid != null && out.failed === 0) db.prepare(`UPDATE scoreboard_groups SET state = 'ambiguous' WHERE id = ?`).run(gid);
  return out;
}
