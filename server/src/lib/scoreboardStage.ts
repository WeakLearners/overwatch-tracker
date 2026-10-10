// The stage of the screenshot pipeline, for the light in the Recording-as row.
// GET /api/scoreboards/live sends it; the client only draws it. Rules:
//   detected  a file is queued or being read by the vision model right now
//   problem   the newest real screenshot in the grace window ended as `error`
//   ready     a live group with a Summary page is waiting (the green light)
//   partial   Teams/Personal pages are read but no Summary page opened a group
//   idle      none of the above
// The watcher only looks at the folder once a poll (every 60 s), so `detected`
// shows for the length of one poll's vision calls, not for the wait before it.
import type { DatabaseSync } from 'node:sqlite';
import { REMATCH_GRACE_MIN } from './scoreboard';

export type Stage = 'idle' | 'detected' | 'partial' | 'ready' | 'problem';
export interface StageInfo {
  stage: Stage;
  /** files queued or in the vision call (stage detected) */
  reading: number;
  /** pages known for the current group or loose pages (stages ready and partial) */
  pages: { summary: boolean; teams: boolean; personal: number } | null;
  /** short reason (stage problem) */
  reason: string | null;
  /** non-scoreboard images in the grace window; informational, never changes the stage */
  ignored: number;
}

/** Loose pages older than this no longer count as "waiting for a Summary". */
export const PARTIAL_WINDOW_MIN = 10;

// Module-level set of files the watcher has queued or is reading. Nothing else
// records an in-flight file: a row is only written after the vision call ends.
const inFlight = new Set<string>();
export const markInFlight = (paths: string[]) => { for (const p of paths) inFlight.add(p); };
export const clearInFlight = (path: string) => { inFlight.delete(path); };
export const inFlightCount = () => inFlight.size;

export function computeStage(db: DatabaseSync, readyGroup: { id: number } | null, readyPages: StageInfo['pages'], nowMs: number = Date.now()): StageInfo {
  const graceIso = new Date(nowMs - REMATCH_GRACE_MIN * 60_000).toISOString();
  const ignored = (db.prepare(`SELECT COUNT(*) n FROM match_scoreboards WHERE status = 'not_scoreboard' AND file_mtime >= ?`).get(graceIso) as { n: number }).n;
  const base = { reading: 0, pages: null, reason: null, ignored };

  if (inFlight.size > 0) return { ...base, stage: 'detected', reading: inFlight.size };

  const last = db.prepare(`SELECT status, reason FROM match_scoreboards WHERE file_mtime >= ? AND status NOT IN ('not_scoreboard', 'dismissed') ORDER BY file_mtime DESC, id DESC LIMIT 1`).get(graceIso) as { status: string; reason: string | null } | undefined;
  if (last?.status === 'error') return { ...base, stage: 'problem', reason: last.reason ?? 'unreadable screenshot' };

  if (readyGroup) return { ...base, stage: 'ready', pages: readyPages };

  const partialIso = new Date(nowMs - PARTIAL_WINDOW_MIN * 60_000).toISOString();
  const loose = db.prepare(`SELECT page_type FROM match_scoreboards WHERE group_id IS NULL AND status = 'unmatched' AND (page_type IS NULL OR page_type IN ('teams', 'personal')) AND file_mtime >= ?`).all(partialIso) as { page_type: string | null }[];
  if (loose.length) {
    return { ...base, stage: 'partial', pages: { summary: false, teams: loose.some(l => l.page_type !== 'personal'), personal: loose.filter(l => l.page_type === 'personal').length } };
  }
  return { ...base, stage: 'idle' };
}
