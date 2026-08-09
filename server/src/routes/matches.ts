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

  const rows = db.prepare(sql).all(params) as Record<string, unknown>[];
  res.json({ rows, total });
});

router.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const { date, time, day_of_week, hour, hero, role, map, game_type, win, deaths, queue_mode, sens, feel, team_rating, notes, heroes } = req.body;

  if (!date || !hero || !role || !map || !game_type || win === undefined) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  const deathsJson = deaths ? JSON.stringify(deaths) : null;

  // The Match Tracker is a dumb logger — it sends no DPI/sens and no set
  // flag. The server alone decides: if a stage-test set is running for this
  // hero (or an ad-hoc, hero-less set with no hero-specific test in the way),
  // this match is on its current stage, so we look up that stage's
  // dpi/sens and write it directly — the sens page shows the same value on
  // screen while it's being played, so there's no hidden state and nothing
  // to reveal later. Several heroes can have sets active at once, so the
  // lookup is scoped by hero — a hero-tagged set takes priority over the
  // ad-hoc set. No matching active set → a plain match with whatever
  // sens/dpi was sent (or none). Either way the log always succeeds.
  //
  // Mouse DPI locked at 1600 permanently 2026-08-08 — sets created since then
  // vary in-game sens per stage instead (blind_stages.sens populated, dpi
  // fixed at 1600 on every row). Sets created before that keep the old
  // shape (sens frozen on the set, dpi varies per stage) and are read the
  // same way until they finish — a stage's `sens` being null is what marks
  // it as one of those legacy rows.
  let finalSens: number | null = sens ?? null;
  let finalDpi: number | null = req.body.dpi ?? null;
  let isStudy = 0;
  let setId: number | null = null;
  let stageIdx: number | null = null;

  // Quick Play games are loggable but never feed the DPI study — only
  // Competitive matches move a stage-test's counters, so QP play doesn't
  // dilute the data.
  const isCompetitive = (queue_mode ?? 'comp_role') !== 'qp_role';

  const activeSet = isCompetitive ? db.prepare(`
    SELECT id, cur_rel, in_game_sens FROM blind_stage_sets
    WHERE active = 1 AND hero = :hero
    UNION ALL
    SELECT id, cur_rel, in_game_sens FROM blind_stage_sets
    WHERE active = 1 AND hero IS NULL AND NOT EXISTS (SELECT 1 FROM blind_stage_sets WHERE active = 1 AND hero = :hero)
    LIMIT 1
  `).get({ hero }) as { id: number; cur_rel: number; in_game_sens: number } | undefined : undefined;
  if (activeSet) {
    const stage = db.prepare('SELECT dpi, sens FROM blind_stages WHERE set_id = :sid AND stage_index = :si')
      .get({ sid: activeSet.id, si: activeSet.cur_rel }) as { dpi: number; sens: number | null } | undefined;
    if (stage) {
      if (stage.sens != null) {
        finalDpi = stage.dpi;
        finalSens = stage.sens;
      } else {
        finalDpi = stage.dpi;
        finalSens = activeSet.in_game_sens;
      }
      isStudy = 1;
      setId = activeSet.id;
      stageIdx = activeSet.cur_rel;
    }
  }

  const result = db.prepare(`
    INSERT INTO matches (date, time, day_of_week, hour, hero, role, map, game_type, win, deaths, queue_mode, sens, dpi, blind_trial, blind_set_id, stage_index, revealed, feel, team_rating, notes)
    VALUES (:date, :time, :day_of_week, :hour, :hero, :role, :map, :game_type, :win, :deaths, :queue_mode, :sens, :dpi, :blind_trial, :blind_set_id, :stage_index, 1, :feel, :team_rating, :notes)
  `).run({ date, time: time ?? null, day_of_week: day_of_week ?? null, hour: hour ?? null, hero, role, map, game_type, win: win ? 1 : 0, deaths: deathsJson, queue_mode: queue_mode ?? 'comp_role', sens: finalSens, dpi: finalDpi, blind_trial: isStudy, blind_set_id: setId, stage_index: stageIdx, feel: feel ?? null, team_rating: team_rating ?? null, notes: notes?.trim() || null });

  const matchId = result.lastInsertRowid as number;

  // Slot 1 is always the hero/role already written to the match row above.
  // `heroes` carries any additional heroes switched to mid-match (slots 2/3),
  // sent as {hero, role, feel} tuples the same way the primary one is —
  // win/loss then attributes to every hero actually played, not just the
  // first (see matches_by_hero in schema.ts). feel is per hero (LogMatch
  // shows one slider per hero played) — slot 1's feel also mirrors into
  // matches.feel above since that's what blind.ts's per-stage analysis reads.
  const heroSlots: { hero: string; role: string; feel: number | null }[] = [
    { hero, role, feel: typeof feel === 'number' ? feel : null },
    ...(Array.isArray(heroes) ? heroes.filter((h: any) => h?.hero && h?.role).slice(0, 2).map((h: any) => ({
      hero: h.hero, role: h.role, feel: typeof h.feel === 'number' ? h.feel : null,
    })) : []),
  ];
  const insertHeroSlot = db.prepare(
    'INSERT INTO match_heroes (match_id, slot, hero, role, feel) VALUES (:match_id, :slot, :hero, :role, :feel)'
  );
  heroSlots.forEach((h, i) => insertHeroSlot.run({ match_id: matchId, slot: i + 1, hero: h.hero, role: h.role, feel: h.feel }));

  if (isStudy && setId != null) {
    db.prepare('UPDATE blind_stage_sets SET games_on_stage = games_on_stage + 1 WHERE id = :id').run({ id: setId });
    // Multiple sets can be active at once now (one per hero), so nothing else
    // retires a finished set the way the old single-active-slot model used to
    // when a new set took over. Retire it here instead, the moment its last
    // stage hits its game target — otherwise it would stay active forever
    // (DELETE refuses completed sets) and permanently block this hero from
    // starting a fresh test.
    const set = db.prepare('SELECT batch_size FROM blind_stage_sets WHERE id = :id').get({ id: setId }) as { batch_size: number };
    const nStages = (db.prepare('SELECT COUNT(*) n FROM blind_stages WHERE set_id = :id').get({ id: setId }) as { n: number }).n;
    const totalGames = (db.prepare('SELECT COUNT(*) n FROM matches WHERE blind_set_id = :id').get({ id: setId }) as { n: number }).n;
    if (totalGames >= set.batch_size * nStages) {
      db.prepare('UPDATE blind_stage_sets SET active = 0 WHERE id = :id').run({ id: setId });
    }
  }

  res.json({ id: result.lastInsertRowid });
});

// Partial update of a logged match. Only the columns present in the body are
// touched, so callers can fix a single field (e.g. the queue mode) without
// resending the whole record.
const EDITABLE = ['date', 'time', 'day_of_week', 'hour', 'hero', 'role', 'map', 'game_type', 'win', 'queue_mode', 'sens', 'feel', 'team_rating', 'notes'] as const;

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
  // Keep match_heroes' slot-1 row (the by-hero stats attribution source) in
  // sync whenever the primary hero/role is corrected via edit.
  if (fields.includes('hero') || fields.includes('role')) {
    db.prepare(`
      UPDATE match_heroes SET hero = COALESCE(:hero, hero), role = COALESCE(:role, role)
      WHERE match_id = :id AND slot = 1
    `).run({ id: req.params.id, hero: fields.includes('hero') ? params.hero : null, role: fields.includes('role') ? params.role : null });
  }
  res.json({ ok: true });
});

router.delete('/:id', (req: Request, res: Response) => {
  const db = getDb();
  db.prepare('DELETE FROM matches WHERE id = :id').run({ id: req.params.id });
  res.json({ ok: true });
});

export default router;
