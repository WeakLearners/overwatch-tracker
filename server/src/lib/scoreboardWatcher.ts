// Polls the Drive "OW Game Logs" folder (My Drive, Drive for desktop, Stream
// mode) every 10 s (was 60 s until 2026-10-10). It moved from "Other computers/My Computer" on 2026-10-09
// because that path synced up to 2 hours late. After each poll it files processed
// images into subfolders (scoreboardOrganize.ts: moves and renames, never deletes).
// Only the TOP LEVEL is scanned for new files. Listing a
// Drive tree can hang for minutes after sign-in, so every
// filesystem call is raced against a timeout, caught, logged and retried on the
// next poll. Nothing in here may throw out of a tick.
import fs from 'fs';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { organizeAll } from './scoreboardOrganize';
import { markInFlight, clearInFlight } from './scoreboardStage';
import { finalizeGroups } from './scoreboardPages';
import { processFile, rematchRecent, isImageName, type VisionFn, callVision } from './scoreboard';

export const POLL_MS = 10_000;
/** A file whose mtime is younger than this is left for the next tick (Drive may still be writing it). */
export const MIN_INTAKE_AGE_MS = 5_000;
/** After a failed vision call (processFile returned null) the same file waits this long, so the 3-attempt cap in
 *  scoreboard.ts still spans about 3 minutes at a 10 s poll instead of 30 s. */
export const RETRY_BACKOFF_MS = 60_000;
const retryAfter = new Map<string, number>();
export const FS_TIMEOUT_MS = 30_000;
/** Scoreboard folder, from SCOREBOARD_DIR in the gitignored server/.env. Unset means the watcher stays off. */
export const scoreboardDir = (): string | null => process.env.SCOREBOARD_DIR || null;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  const timeout = new Promise<never>((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms} ms`)), ms); });
  return Promise.race([p, timeout]).finally(() => clearTimeout(t));
}

let running = false;

/** One poll. Exported for tests; never throws. */
export async function pollOnce(
  db: DatabaseSync,
  dir: string,
  vision: VisionFn = callVision,
  fsTimeoutMs: number = FS_TIMEOUT_MS,
  minAgeMs: number = 0,
  nowMs: number = Date.now(),
): Promise<{ processed: number; error: string | null }> {
  let processed = 0;
  try {
    try { rematchRecent(db); } catch (e) { console.error('[scoreboard] rematch failed:', (e as Error).message); }
    let names: string[];
    try {
      names = await withTimeout(fs.promises.readdir(dir), fsTimeoutMs, 'folder listing');
    } catch (e) {
      const msg = (e as Error).message;
      console.warn(`[scoreboard] cannot list folder (${msg}); retry next poll`);
      return { processed, error: msg };
    }
    const known = new Set((db.prepare(`SELECT file_path FROM match_scoreboards`).all() as { file_path: string }[]).map(r => r.file_path));
    const byMove = db.prepare(`SELECT id, file_path FROM match_scoreboards WHERE file_mtime = ?`);
    // New files go in file_mtime order, so a Summary page opens its group before the
    // Teams and Personal pages taken after it (name order breaks at "(99)" -> "(100)").
    const fresh: { name: string; full: string; st: fs.Stats }[] = [];
    for (const name of names.filter(isImageName).sort()) {
      const full = path.join(dir, name);
      if (known.has(full)) continue;
      if ((retryAfter.get(full) ?? 0) > nowMs) continue;
      try {
        const st = await withTimeout(fs.promises.stat(full), fsTimeoutMs, 'stat');
        if (st.isFile() && st.size > 0 && (minAgeMs <= 0 || nowMs - st.mtimeMs >= minAgeMs)) fresh.push({ name, full, st });
      } catch (e) {
        console.warn(`[scoreboard] ${name}: ${(e as Error).message}; retry next poll`);
      }
    }
    fresh.sort((a, b) => a.st.mtimeMs - b.st.mtimeMs || a.name.localeCompare(b.name));
    markInFlight(fresh.map(f => f.full));
    for (const { name, full, st } of fresh) {
      try {
        // Folder moved: same basename and mtime already stored, so only repoint file_path.
        const moved = (byMove.all(new Date(st.mtimeMs).toISOString()) as { id: number; file_path: string }[])
          .find(r => path.basename(r.file_path) === name);
        if (moved) {
          db.prepare(`UPDATE match_scoreboards SET file_path = ? WHERE id = ?`).run(full, moved.id);
          known.add(full);
          console.log(`[scoreboard] ${name}: already stored (id ${moved.id}); file_path updated`);
          continue;
        }
        const status = await processFile(db, full, st.mtimeMs, vision);
        if (status) { processed++; retryAfter.delete(full); console.log(`[scoreboard] ${name}: ${status}`); }
        else retryAfter.set(full, Date.now() + RETRY_BACKOFF_MS);
      } catch (e) {
        console.warn(`[scoreboard] ${name}: ${(e as Error).message}; retry next poll`);
      } finally { clearInFlight(full); }
    }
    try { finalizeGroups(db); } catch (e) { console.error('[scoreboard] group fill failed:', (e as Error).message); }
    try { organizeAll(db, dir); } catch (e) { console.error('[scoreboard] organize failed:', (e as Error).message); }
    return { processed, error: null };
  } catch (e) {
    console.error('[scoreboard] poll failed:', (e as Error).message);
    return { processed, error: (e as Error).message };
  }
}

export function startScoreboardWatcher(db: DatabaseSync, dir: string | null = scoreboardDir()): NodeJS.Timeout | null {
  if (!dir) { console.log('[scoreboard] SCOREBOARD_DIR not set; watcher off'); return null; }
  console.log(`[scoreboard] watching ${dir} every ${POLL_MS / 1000}s`);
  const tick = () => {
    if (running) return;
    running = true;
    pollOnce(db, dir, callVision, FS_TIMEOUT_MS, MIN_INTAKE_AGE_MS).catch(e => console.error('[scoreboard] tick failed:', (e as Error).message)).finally(() => { running = false; });
  };
  tick();
  return setInterval(tick, POLL_MS);
}
