// A tiny tracker-side event: "tracker data may have changed". The tracker
// emits it after any write request finishes (index.ts mounts
// trackerWriteNotifier on /api). Lab code subscribes to drop its cached
// replica (lab/replicaCache.ts). The tracker knows nothing about who listens,
// and this file imports no lab code and no db/schema.
import type { Request, Response, NextFunction } from 'express';

type Listener = () => void;
const listeners = new Set<Listener>();

/** Subscribe. Returns an unsubscribe function. */
export function onTrackerWrite(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function emitTrackerWrite(): void {
  for (const fn of [...listeners]) fn();
}

/**
 * Express middleware: after any non-GET request finishes (the response is
 * sent, so the write has committed), emit. Covers every tracker write route
 * at once, so a new write route cannot forget to invalidate.
 */
export function trackerWriteNotifier(req: Request, res: Response, next: NextFunction): void {
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS') {
    res.on('finish', emitTrackerWrite);
  }
  next();
}
