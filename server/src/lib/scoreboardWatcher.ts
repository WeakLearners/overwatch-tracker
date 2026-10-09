// Polls the Drive "OW Game Logs" folder (Drive for desktop, Stream mode) every
// 60 s. Read-only: never moves, renames or deletes anything there. Listing the
// "Other computers" tree can hang for minutes after sign-in, so every
// filesystem call is raced against a timeout, caught, logged and retried on the
// next poll. Nothing in here may throw out of a tick.
import fs from 'fs';
import path from 'path';
import type { DatabaseSync } from 'node:sqlite';
import { processFile, rematchRecent, isImageName, type VisionFn, callVision } from './scoreboard';

export const POLL_MS = 60_000;
export const FS_TIMEOUT_MS = 30_000;
export const DEFAULT_SCOREBOARD_DIR =
  '/Users/Sean/Library/CloudStorage/GoogleDrive-skim2636@gmail.com/Other computers/My Computer/OW Game Logs';

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
    for (const name of names.filter(isImageName).sort()) {
      const full = path.join(dir, name);
      if (known.has(full)) continue;
      try {
        const st = await withTimeout(fs.promises.stat(full), fsTimeoutMs, 'stat');
        if (!st.isFile() || st.size === 0) continue;
        const status = await processFile(db, full, st.mtimeMs, vision);
        if (status) { processed++; console.log(`[scoreboard] ${name}: ${status}`); }
      } catch (e) {
        console.warn(`[scoreboard] ${name}: ${(e as Error).message}; retry next poll`);
      }
    }
    return { processed, error: null };
  } catch (e) {
    console.error('[scoreboard] poll failed:', (e as Error).message);
    return { processed, error: (e as Error).message };
  }
}

export function startScoreboardWatcher(db: DatabaseSync, dir: string = process.env.SCOREBOARD_DIR || DEFAULT_SCOREBOARD_DIR): NodeJS.Timeout {
  console.log(`[scoreboard] watching ${dir} every ${POLL_MS / 1000}s`);
  const tick = () => {
    if (running) return;
    running = true;
    pollOnce(db, dir).catch(e => console.error('[scoreboard] tick failed:', (e as Error).message)).finally(() => { running = false; });
  };
  tick();
  return setInterval(tick, POLL_MS);
}
