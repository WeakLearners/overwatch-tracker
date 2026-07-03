import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';

const router = Router();

router.get('/', (req: Request, res: Response) => {
  const db = getDb();
  const { hero, map, game_type, queue_mode, from, to, limit = '200', offset = '0' } = req.query as Record<string, string>;

  let sql = 'SELECT * FROM matches WHERE 1=1';
  const params: Record<string, string | number> = {};
  let idx = 1;

  if (hero) { sql += ` AND hero = ?${idx}`; params[`${idx++}`] = hero; }
  if (map) { sql += ` AND map = ?${idx}`; params[`${idx++}`] = map; }
  if (game_type) { sql += ` AND game_type = ?${idx}`; params[`${idx++}`] = game_type; }
  if (queue_mode) { sql += ` AND queue_mode = ?${idx}`; params[`${idx++}`] = queue_mode; }
  if (from) { sql += ` AND date >= ?${idx}`; params[`${idx++}`] = from; }
  if (to) { sql += ` AND date <= ?${idx}`; params[`${idx++}`] = to; }

  const countSql = sql.replace('SELECT *', 'SELECT COUNT(*) as n');
  const total = (db.prepare(countSql).get(params) as any)?.n ?? 0;

  sql += ` ORDER BY date DESC, time DESC LIMIT ?${idx} OFFSET ?${idx + 1}`;
  params[`${idx}`] = parseInt(limit);
  params[`${idx + 1}`] = parseInt(offset);

  const rows = db.prepare(sql).all(params);
  res.json({ rows, total });
});

router.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const { date, time, day_of_week, hour, hero, role, map, game_type, win, deaths, queue_mode, allied_tank } = req.body;

  if (!date || !hero || !role || !map || !game_type || win === undefined) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  const deathsJson = deaths ? JSON.stringify(deaths) : null;

  const result = db.prepare(`
    INSERT INTO matches (date, time, day_of_week, hour, hero, role, map, game_type, win, deaths, queue_mode, allied_tank)
    VALUES (:date, :time, :day_of_week, :hour, :hero, :role, :map, :game_type, :win, :deaths, :queue_mode, :allied_tank)
  `).run({ date, time: time ?? null, day_of_week: day_of_week ?? null, hour: hour ?? null, hero, role, map, game_type, win: win ? 1 : 0, deaths: deathsJson, queue_mode: queue_mode ?? 'comp_role', allied_tank: allied_tank ?? null });

  res.json({ id: result.lastInsertRowid });
});

// Partial update of a logged match. Only the columns present in the body are
// touched, so callers can fix a single field (e.g. the queue mode) without
// resending the whole record.
const EDITABLE = ['date', 'time', 'day_of_week', 'hour', 'hero', 'role', 'map', 'game_type', 'win', 'queue_mode', 'allied_tank'] as const;

router.put('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const fields = EDITABLE.filter(k => k in req.body);
  if (fields.length === 0) {
    res.status(400).json({ error: 'No editable fields provided' });
    return;
  }

  const params: Record<string, string | number | null> = { id: req.params.id };
  for (const k of fields) {
    const v = req.body[k];
    params[k] = k === 'win' ? (v ? 1 : 0) : v ?? null;
  }
  const setClause = fields.map(k => `${k} = :${k}`).join(', ');

  const result = db.prepare(`UPDATE matches SET ${setClause} WHERE id = :id`).run(params);
  if (result.changes === 0) {
    res.status(404).json({ error: 'Match not found' });
    return;
  }
  res.json({ ok: true });
});

router.delete('/:id', (req: Request, res: Response) => {
  const db = getDb();
  db.prepare('DELETE FROM matches WHERE id = :id').run({ id: req.params.id });
  res.json({ ok: true });
});

export default router;
