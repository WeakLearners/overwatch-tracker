// Shared lab replica. Lab routes (aimAnalysis, statsLab, advisor) read tracker
// data through ONE in-memory replica built via lab/client.ts (the v1 export
// API), not through db/schema. Measured 2026-10-04 against the live tracker:
// a full build is about 120-150 ms for ~3,700 matches, so the choice is a TTL
// cache plus invalidation, not an incremental refresh:
//   - the replica is built lazily on the first request, never at boot (inside
//     the server process the tracker is this same server, so a boot-time build
//     would call a port that is not listening yet)
//   - it is reused for TTL_MS, and dropped at once when the tracker emits a
//     write (lib/trackerEvents.ts), so a just-logged match shows immediately
//   - the TTL also covers writes that do not go through HTTP (maintenance
//     scripts that open the database file directly)
//   - concurrent requests share one build (single flight)
// This file must never import db/schema.
import type { Request, Response, NextFunction } from 'express';
import type { DatabaseSync } from 'node:sqlite';
import { createLabClient } from './client';
import { buildReplica } from './replica';
import { loadLabConfig } from './config';
import { onTrackerWrite } from '../lib/trackerEvents';

export const TTL_MS = 15_000;

interface Options {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  /** Test seam: replaces the replica with any handle, so a test can run the same
   *  handlers on the tracker's own database and compare. Never set in production. */
  source?: () => Promise<DatabaseSync>;
}
let options: Options = {};

let current: { db: DatabaseSync; builtAt: number } | null = null;
let inflight: { p: Promise<DatabaseSync>; gen: number } | null = null;
// Bumped on every invalidation. A build that started before a bump may have
// read pre-write data, so its result serves the callers waiting on it but is
// not kept.
let generation = 0;

export function configureReplicaCache(o: Options): void {
  options = o;
  invalidateReplica();
}

export function invalidateReplica(): void {
  generation++;
  current = null;
}

export function resetReplicaCache(): void {
  options = {};
  invalidateReplica();
  inflight = null;
}

onTrackerWrite(invalidateReplica);

async function build(): Promise<DatabaseSync> {
  const baseUrl = options.baseUrl ?? loadLabConfig().trackerUrl;
  const client = createLabClient({ baseUrl, fetchImpl: options.fetchImpl });
  return buildReplica(client);
}

export async function getReplica(): Promise<DatabaseSync> {
  if (options.source) return options.source();
  const ttl = options.ttlMs ?? TTL_MS;
  if (current && Date.now() - current.builtAt < ttl) return current.db;
  // Join a build only if no write happened since it started.
  if (inflight && inflight.gen === generation) return inflight.p;
  const startedAt = generation;
  const entry: { p: Promise<DatabaseSync>; gen: number } = {
    gen: startedAt,
    p: build().then(db => {
      if (startedAt === generation) current = { db, builtAt: Date.now() };
      return db;
    }).finally(() => { if (inflight === entry) inflight = null; }),
  };
  inflight = entry;
  return entry.p;
}

/** Express wrapper: run a read handler against the shared replica. */
export function withReplica(handler: (req: Request, res: Response, db: DatabaseSync) => void | Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    getReplica().then(db => handler(req, res, db)).catch(next);
  };
}
