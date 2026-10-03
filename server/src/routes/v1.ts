// v1 export API: the read-only seam between the tracker and the lab
// (split-plan-2026-09-28.md section 2). Lab code reads ONLY through these
// routes (see lab/client.ts). Rules of the contract:
//   - every response carries `schema_version`
//   - GET only; there are no write routes under /api/v1
//   - scoped by OWNER. Only match_deaths (owner_id) and user_config (user_id)
//     have an owner column today, so those two are filtered by it. The other
//     tables are single-owner and are exported whole. Branch B adds owner
//     columns and changes the WHERE clauses here, not the response shape.
//   - the frozen matches.deaths JSON column is never exported
//   - paged routes use an id cursor: `since` is exclusive, rows come in id
//     order, `next_since` is the last id returned (null when the page is empty)
import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';
import { buildConfigPayload } from './config';
import { HEROES_BY_ROLE } from '../lib/heroes';
import { MAPS_BY_NAME } from '../lib/maps';

export const SCHEMA_VERSION = '1.0.0';

const router = Router();
const OWNER = 1;
const DEFAULT_LIMIT = 500;
const MAX_LIMIT = 2000;
// Columns that never leave the tracker. `deaths` is the frozen v1/v2/v3 JSON.
const MATCH_COLUMNS_NEVER_EXPORTED = new Set(['deaths']);

type DB = ReturnType<typeof getDb>;

function parseCursor(q: Request['query']): { since: number; limit: number } | { error: string } {
  const sinceRaw = q.since;
  const since = sinceRaw === undefined || sinceRaw === '' ? 0 : Number(sinceRaw);
  if (!Number.isInteger(since) || since < 0) return { error: 'since must be a non-negative integer id' };
  const limitRaw = q.limit;
  const limit = limitRaw === undefined || limitRaw === '' ? DEFAULT_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    return { error: `limit must be an integer from 1 to ${MAX_LIMIT}` };
  }
  return { since, limit };
}

function exportableMatchColumns(db: DB): string[] {
  return (db.prepare('PRAGMA table_info(matches)').all() as { name: string }[])
    .map(c => c.name)
    .filter(n => !MATCH_COLUMNS_NEVER_EXPORTED.has(n));
}

function page<T extends Record<string, any>>(res: Response, rows: T[], idKey: string, limit: number, extra: object = {}) {
  const next = rows.length ? rows[rows.length - 1][idKey] : null;
  res.json({ schema_version: SCHEMA_VERSION, rows, next_since: next, has_more: rows.length === limit, ...extra });
}

router.get('/manifest', (_req: Request, res: Response) => {
  const cfg = buildConfigPayload(getDb());
  res.json({
    schema_version: SCHEMA_VERSION,
    enabled_categories: cfg.enabledCategories,
    locked_categories: cfg.lockedCategories,
    categories: cfg.categories.map(c => ({ id: c.id, label: c.label })),
    // `study` tags and `feedsCards` are analysis/UI knowledge. They stay out of the contract.
    fields: cfg.fields.filter(f => f.enabled).map(f => ({
      id: f.id,
      label: f.label,
      category: f.category,
      type: f.control.kind,
      writes_to: f.writesTo,
      applies_to: f.appliesTo ?? null,
    })),
    heroes: Object.entries(HEROES_BY_ROLE).flatMap(([role, names]) => names.map(hero => ({ hero, role }))),
    maps: Object.entries(MAPS_BY_NAME).map(([map, mode]) => ({ map, mode })),
  });
});

router.get('/export/matches', (req: Request, res: Response) => {
  const db = getDb();
  const cur = parseCursor(req.query);
  if ('error' in cur) { res.status(400).json({ error: cur.error }); return; }

  const allowed = exportableMatchColumns(db);
  let cols = allowed;
  if (typeof req.query.fields === 'string' && req.query.fields !== '') {
    const asked = req.query.fields.split(',').map(s => s.trim()).filter(Boolean);
    const unknown = asked.filter(f => !allowed.includes(f));
    if (unknown.length) { res.status(400).json({ error: `unknown field(s): ${unknown.join(', ')}` }); return; }
    cols = ['id', ...asked.filter(f => f !== 'id')];
  }

  const rows = db.prepare(`SELECT ${cols.map(c => `"${c}"`).join(', ')} FROM matches WHERE id > :since ORDER BY id ASC LIMIT :limit`)
    .all({ since: cur.since, limit: cur.limit }) as Record<string, any>[];

  if (rows.length) {
    const heroes = db.prepare(
      `SELECT * FROM match_heroes WHERE match_id >= :lo AND match_id <= :hi ORDER BY match_id, slot`,
    ).all({ lo: rows[0].id, hi: rows[rows.length - 1].id }) as Record<string, any>[];
    const byMatch = new Map<number, Record<string, any>[]>();
    for (const h of heroes) {
      const { match_id, ...rest } = h;
      (byMatch.get(match_id) ?? byMatch.set(match_id, []).get(match_id)!).push(rest);
    }
    for (const r of rows) r.heroes = byMatch.get(r.id) ?? [];
  }
  page(res, rows, 'id', cur.limit);
});

router.get('/export/deaths', (req: Request, res: Response) => {
  const cur = parseCursor(req.query);
  if ('error' in cur) { res.status(400).json({ error: cur.error }); return; }
  const rows = getDb().prepare(
    `SELECT id, match_id, seq, killer, killer_role, ult FROM match_deaths
     WHERE owner_id = :owner AND id > :since ORDER BY id ASC LIMIT :limit`,
  ).all({ owner: OWNER, since: cur.since, limit: cur.limit }) as Record<string, any>[];
  page(res, rows, 'id', cur.limit);
});

router.get('/export/aim', (req: Request, res: Response) => {
  const db = getDb();
  const cur = parseCursor(req.query);
  if ('error' in cur) { res.status(400).json({ error: cur.error }); return; }
  // Cursor is match_id: aim_stats has one row per match.
  const rows = db.prepare(
    `SELECT * FROM aim_stats WHERE match_id > :since ORDER BY match_id ASC LIMIT :limit`,
  ).all({ since: cur.since, limit: cur.limit }) as Record<string, any>[];
  if (rows.length) {
    const heroes = db.prepare(
      `SELECT * FROM aim_stats_heroes WHERE match_id >= :lo AND match_id <= :hi ORDER BY match_id, hero`,
    ).all({ lo: rows[0].match_id, hi: rows[rows.length - 1].match_id }) as Record<string, any>[];
    const byMatch = new Map<number, Record<string, any>[]>();
    for (const h of heroes) {
      const { match_id, ...rest } = h;
      (byMatch.get(match_id) ?? byMatch.set(match_id, []).get(match_id)!).push(rest);
    }
    for (const r of rows) r.heroes = byMatch.get(r.match_id) ?? [];
  }
  page(res, rows, 'match_id', cur.limit);
});

// Read-only view of the experiment controller. Not paged: sets are few.
router.get('/export/experiments', (_req: Request, res: Response) => {
  const db = getDb();
  const sets = db.prepare('SELECT * FROM blind_stage_sets ORDER BY id').all() as Record<string, any>[];
  const stages = db.prepare('SELECT * FROM blind_stages ORDER BY set_id, stage_index').all() as Record<string, any>[];
  const credits = db.prepare('SELECT * FROM blind_credits ORDER BY blind_set_id, match_id, hero').all() as Record<string, any>[];
  res.json({ schema_version: SCHEMA_VERSION, sets, stages, credits });
});

// Rawaccel curve row (curve_params stays tracker-owned; the lab reads it here).
// Single row, id 1; null before it was ever saved.
router.get('/export/curve', (_req: Request, res: Response) => {
  const curve = getDb().prepare('SELECT * FROM curve_params WHERE id = 1').get() ?? null;
  res.json({ schema_version: SCHEMA_VERSION, curve });
});

export default router;
