// Tier 3 test harness: spins up the real Express app — the actual routers,
// the actual express.json() body parser, the actual status codes — over a
// throwaway SQLite file, and talks to it with real HTTP.
//
// Why real HTTP rather than importing the handlers and calling them with fake
// req/res objects: Tier 2 already proved the *read* path's compute functions
// agree on clean fixtures, and the stage-advance anomaly still didn't
// reproduce. That points at the write path — and the write path's behavior
// depends on things a hand-rolled req/res stub silently gets right by
// accident: body parsing, the 400/404/409 branches, and above all the fact
// that POST /api/matches wraps its inserts in a BEGIN/COMMIT that a thrown
// error rolls back. Those are the mechanics under suspicion, so the test has
// to exercise them rather than substitute for them.
//
// Not a *.test.ts file — imported by the route suites, never run on its own.
// Zero new dependencies: node:http + global fetch, same as the rest of the
// suite's zero-dep posture.
import express from 'express';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb, closeDb } from '../db/schema';
import matchesRouter from '../routes/matches';
import aimRouter from '../routes/aim';
import blindRouter from '../routes/blind';
import statsRouter from '../routes/stats';

export interface ApiResponse<T = any> {
  status: number;
  body: T;
}

export interface Harness {
  db: ReturnType<typeof getDb>;
  get<T = any>(p: string): Promise<ApiResponse<T>>;
  post<T = any>(p: string, body?: unknown): Promise<ApiResponse<T>>;
  put<T = any>(p: string, body?: unknown): Promise<ApiResponse<T>>;
  del<T = any>(p: string): Promise<ApiResponse<T>>;
  close(): Promise<void>;
}

// The routers call getDb() with no argument, so they resolve the module-level
// singleton. Seeding that singleton with the temp path FIRST is what keeps the
// whole suite off data/overwatch.db — every route this harness serves would
// otherwise open the real database. closeDb() in close() clears it again so
// the next test's getDb(tmp) actually opens its own file instead of handing
// back the previous test's connection.
export async function startHarness(): Promise<Harness> {
  const tmpPath = path.join(
    os.tmpdir(),
    `overwatch-route-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`,
  );
  const db = getDb(tmpPath);

  const app = express();
  app.use(express.json());
  app.use('/api/matches', matchesRouter);
  app.use('/api/aim', aimRouter);
  app.use('/api/blind', blindRouter);
  app.use('/api/stats', statsRouter);

  const server = http.createServer(app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('harness: no port');
  const base = `http://127.0.0.1:${addr.port}`;

  const call = async <T>(method: string, p: string, body?: unknown): Promise<ApiResponse<T>> => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: body === undefined ? {} : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let parsed: any = null;
    // A 500 from an express handler is an HTML stack page, not JSON. Keep the
    // raw text instead of throwing here so a test that hits an unexpected 500
    // fails on its own assertion with the body visible, rather than on a
    // confusing JSON.parse error inside the harness.
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
    return { status: res.status, body: parsed };
  };

  return {
    db,
    get: (p) => call('GET', p),
    post: (p, body) => call('POST', p, body ?? {}),
    put: (p, body) => call('PUT', p, body ?? {}),
    del: (p) => call('DELETE', p),
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        server.close(err => (err ? reject(err) : resolve())));
      closeDb();
      for (const f of [tmpPath, `${tmpPath}-wal`, `${tmpPath}-shm`]) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
    },
  };
}
