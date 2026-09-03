import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';
import { getCurveParams } from '../lib/curveParams';

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

// Looks up the active stage-test set for a given hero (hero-tagged set takes
// priority over the shared ad-hoc, hero-less one) and its current stage.
// Shared by the POST insert path and the PUT roster-recompute path below —
// both need to know "if this hero logged a game right now, which stage would
// it credit."
function findActiveStage(db: ReturnType<typeof getDb>, hero: string, isCompetitive: boolean) {
  if (!isCompetitive) return undefined;
  const activeSet = db.prepare(`
    SELECT id, cur_rel, in_game_sens, curve_enabled FROM blind_stage_sets
    WHERE active = 1 AND hero = :hero
    UNION ALL
    SELECT id, cur_rel, in_game_sens, curve_enabled FROM blind_stage_sets
    WHERE active = 1 AND hero IS NULL AND NOT EXISTS (SELECT 1 FROM blind_stage_sets WHERE active = 1 AND hero = :hero)
    LIMIT 1
  `).get({ hero }) as { id: number; cur_rel: number; in_game_sens: number; curve_enabled: number } | undefined;
  if (!activeSet) return undefined;
  const stage = db.prepare('SELECT dpi, sens FROM blind_stages WHERE set_id = :sid AND stage_index = :si')
    .get({ sid: activeSet.id, si: activeSet.cur_rel }) as { dpi: number; sens: number | null } | undefined;
  if (!stage) return undefined;
  return {
    setId: activeSet.id, stageIdx: activeSet.cur_rel, dpi: stage.dpi, sens: stage.sens ?? activeSet.in_game_sens,
    curveEnabled: !!activeSet.curve_enabled,
  };
}

// Re-derives a stage credit for a hero that's still on a match's roster after
// an edit, preferring whatever set is currently active but falling back to a
// set this exact hero was already credited on for this exact match — even if
// that set has since retired. Without the fallback, editing the one match
// that pushes a set to its target (e.g. fixing a mid-match hero switch after
// the fact) permanently orphans that credit: syncStageCredits below always
// deletes-then-recomputes, and findActiveStage only sees active=1 sets, so a
// set that retired *because of this match* can never earn it back — the set
// gets stuck one game short forever even though it was genuinely completed.
// Safe to reuse here because we only reinstate a credit the hero is still
// actually rostered for, never resurrect an unrelated closed set.
function findStageForRecredit(
  db: ReturnType<typeof getDb>, hero: string, isCompetitive: boolean,
  priorCredit: { blind_set_id: number; stage_index: number } | undefined,
) {
  const active = findActiveStage(db, hero, isCompetitive);
  if (active) return active;
  // A queue_mode edit off comp (isCompetitive false) must drop the credit
  // outright — reusing priorCredit here would resurrect it every time,
  // silently undoing the very correction the edit was making.
  if (!isCompetitive || !priorCredit) return undefined;
  const set = db.prepare('SELECT id, in_game_sens, curve_enabled FROM blind_stage_sets WHERE id = :id')
    .get({ id: priorCredit.blind_set_id }) as { id: number; in_game_sens: number; curve_enabled: number } | undefined;
  if (!set) return undefined;
  const stage = db.prepare('SELECT dpi, sens FROM blind_stages WHERE set_id = :sid AND stage_index = :si')
    .get({ sid: set.id, si: priorCredit.stage_index }) as { dpi: number; sens: number | null } | undefined;
  if (!stage) return undefined;
  return {
    setId: set.id, stageIdx: priorCredit.stage_index, dpi: stage.dpi, sens: stage.sens ?? set.in_game_sens,
    curveEnabled: !!set.curve_enabled,
  };
}

router.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const { date, time, day_of_week, hour, hero, role, map, game_type, win, deaths, queue_mode, sens, feel, team_rating, notes, heroes, curve_enabled } = req.body;

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

  // Quick Play games are loggable but normally never feed the DPI study —
  // only Competitive matches move a stage-test's counters, so QP play
  // doesn't dilute the data. Support used to get a QP exception while its
  // data was still being gathered; retired 2026-08-23 now that support is on
  // the same comp-only phase DPS was already in.
  const isCompetitive = (queue_mode ?? 'comp_role') !== 'qp_role';

  // Every hero actually played gets checked against its own active set, not
  // just slot 1 — the primary hero's lookup also determines the sens/dpi
  // stamped onto the match row itself.
  const primaryStage = findActiveStage(db, hero, isCompetitive);
  if (primaryStage) {
    finalDpi = primaryStage.dpi;
    finalSens = primaryStage.sens;
    isStudy = 1;
    setId = primaryStage.setId;
    stageIdx = primaryStage.stageIdx;
  }
  // Whether acceleration was on is a phase-wide constant on the active set
  // (blind_stage_sets.curve_enabled), same as dpi/sens above — it overrides
  // whatever LogMatch's manual toggle sent whenever a set actually governs
  // this match. The manual toggle only matters as the fallback for matches
  // with no active test at all (no hero-tagged or ad-hoc set running).
  const finalCurveEnabled = primaryStage ? primaryStage.curveEnabled : (curve_enabled === true || curve_enabled === 1);

  // Match row + heroes + blind_credits + games_on_stage all describe one
  // logged match together — wrapped in a transaction so a mid-request error
  // can't leave the match durable with blind_trial/blind_set_id set but no
  // matching blind_credits row (see blind.ts's set-creation insert for the
  // same rationale).
  let matchId: number;
  db.exec('BEGIN');
  try {
    // revealed is a confirmed-dead leftover from an earlier hidden-DPI
    // design (schema.ts's comment on the column) — left off here rather
    // than hardcoded to 1 on every insert, since nothing reads it either way.
    // curve_enabled is ground truth for whether acceleration was on — derived
    // above (finalCurveEnabled) from the active stage-test set's phase-wide
    // flag when one governs this match, same priority as dpi/sens; only falls
    // back to LogMatch's manual toggle when no set is active at all. The two
    // curve params themselves are whatever's live right now (getCurveParams,
    // editable from the testing page — see lib/curveParams.ts) but are only
    // written when curve_enabled is actually true, so "not recorded" reads
    // as null, not a false 0/default like sens=null already does for dpi.
    const curveParams = finalCurveEnabled ? getCurveParams(db) : null;
    const result = db.prepare(`
      INSERT INTO matches (date, time, day_of_week, hour, hero, role, map, game_type, win, deaths, queue_mode, sens, dpi, blind_trial, blind_set_id, stage_index, feel, team_rating, notes, curve_enabled, curve_growth_rate, curve_midpoint, curve_motivity)
      VALUES (:date, :time, :day_of_week, :hour, :hero, :role, :map, :game_type, :win, :deaths, :queue_mode, :sens, :dpi, :blind_trial, :blind_set_id, :stage_index, :feel, :team_rating, :notes, :curve_enabled, :curve_growth_rate, :curve_midpoint, :curve_motivity)
    `).run({ date, time: time ?? null, day_of_week: day_of_week ?? null, hour: hour ?? null, hero, role, map, game_type, win: win ? 1 : 0, deaths: deathsJson, queue_mode: queue_mode ?? 'comp_role', sens: finalSens, dpi: finalDpi, blind_trial: isStudy, blind_set_id: setId, stage_index: stageIdx, feel: feel ?? null, team_rating: team_rating ?? null, notes: notes?.trim() || null, curve_enabled: finalCurveEnabled ? 1 : 0, curve_growth_rate: curveParams?.smooth ?? null, curve_midpoint: curveParams?.input ?? null, curve_motivity: curveParams?.output ?? null });

    matchId = result.lastInsertRowid as number;

    // Slot 1 is always the hero/role already written to the match row above.
    // `heroes` carries any additional heroes switched to mid-match (slots 2/3),
    // sent as {hero, role, feel} tuples the same way the primary one is —
    // win/loss then attributes to every hero actually played, not just the
    // first (see matches_by_hero in schema.ts). feel is per hero (LogMatch
    // shows one slider per hero played) — slot 1's feel also mirrors into
    // matches.feel above since that's what blind.ts's per-stage analysis reads.
    // sens is per hero too, and for the same "own active stage wins" priority
    // as the primary hero's finalSens above: Overwatch's in-game sens is a
    // real per-hero setting, so a switched-to hero's own active stage (not
    // the primary's) is authoritative when one exists; otherwise fall back
    // to whatever LogMatch sent for that hero (its own manual/display value —
    // see LogMatch.tsx's displaySensForHero), never the primary's sens.
    const extraHeroStages = (Array.isArray(heroes) ? heroes.filter((h: any) => h?.hero && h?.role).slice(0, 2) : [])
      .map((h: any) => ({ hero: h.hero, role: h.role, feel: h.feel, sens: h.sens, stage: findActiveStage(db, h.hero, isCompetitive) }));
    const heroSlots: { hero: string; role: string; feel: number | null; sens: number | null }[] = [
      { hero, role, feel: typeof feel === 'number' ? feel : null, sens: finalSens },
      ...extraHeroStages.map(h => ({
        hero: h.hero, role: h.role, feel: typeof h.feel === 'number' ? h.feel : null,
        sens: h.stage ? h.stage.sens : (typeof h.sens === 'number' ? h.sens : null),
      })),
    ];
    const insertHeroSlot = db.prepare(
      'INSERT INTO match_heroes (match_id, slot, hero, role, feel, sens) VALUES (:match_id, :slot, :hero, :role, :feel, :sens)'
    );
    heroSlots.forEach((h, i) => insertHeroSlot.run({ match_id: matchId, slot: i + 1, hero: h.hero, role: h.role, feel: h.feel, sens: h.sens }));

    const insertCredit = db.prepare(
      'INSERT OR IGNORE INTO blind_credits (match_id, hero, blind_set_id, stage_index) VALUES (:match_id, :hero, :blind_set_id, :stage_index)'
    );
    // Credit every hero actually played, not just the primary — a hero played
    // only as a mid-match switch (slot 2/3) still logged games at its own
    // active test's current stage, and needs its own set's counters moved.
    // Primary and extras both reuse the lookups already done above rather
    // than re-querying.
    const creditsToApply = [
      ...(primaryStage ? [{ hero, ...primaryStage }] : []),
      ...extraHeroStages.flatMap(h => (h.stage ? [{ hero: h.hero, ...h.stage }] : [])),
    ];

    for (const credit of creditsToApply) {
      // Guards against double-crediting if the same hero somehow appears twice
      // in heroSlots (e.g. switched back to the match's starting hero) — the
      // (match_id, hero) PK means only the first insert actually lands.
      const { changes } = insertCredit.run({ match_id: matchId, hero: credit.hero, blind_set_id: credit.setId, stage_index: credit.stageIdx });
      if (changes === 0) continue;
      // Multiple sets can be active at once now (one per hero), so nothing else
      // retires a finished set the way the old single-active-slot model used to
      // when a new set took over. Retire it here instead, the moment its last
      // stage hits its game target — otherwise it would stay active forever
      // (DELETE refuses completed sets) and permanently block this hero from
      // starting a fresh test.
      const set = db.prepare('SELECT batch_size FROM blind_stage_sets WHERE id = :id').get({ id: credit.setId }) as { batch_size: number };
      const nStages = (db.prepare('SELECT COUNT(*) n FROM blind_stages WHERE set_id = :id').get({ id: credit.setId }) as { n: number }).n;
      const totalGames = (db.prepare('SELECT COUNT(*) n FROM blind_credits WHERE blind_set_id = :id').get({ id: credit.setId }) as { n: number }).n;
      if (totalGames >= set.batch_size * nStages) {
        db.prepare('UPDATE blind_stage_sets SET active = 0 WHERE id = :id').run({ id: credit.setId });
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  res.json({ id: matchId });
});

// Partial update of a logged match. Only the columns present in the body are
// touched, so callers can fix a single field (e.g. the queue mode) without
// resending the whole record.
const EDITABLE = ['date', 'time', 'day_of_week', 'hour', 'hero', 'role', 'map', 'game_type', 'win', 'queue_mode', 'sens', 'feel', 'team_rating', 'notes', 'curve_enabled', 'curve_growth_rate', 'curve_midpoint', 'curve_motivity'] as const;

// Re-derives which stage-test set(s) (if any) a match's current hero roster
// credits, after an edit changes hero/role/queue_mode/heroes. A match logged
// mid-test can move onto a different active set, off a test entirely, or
// (rarely) onto one for the first time — in every case the old blind_credits
// rows are stale and would silently overcount/undercount a stage's trial
// batch. Drops the old credits, then re-runs the same lookup+credit+retire
// logic the POST insert path uses. games_on_stage/totalGames are both
// derived live from blind_credits (blind.ts's gamesOnStageOf/totalGamesOf) —
// deleting/inserting rows here is the only bookkeeping needed; there's no
// separate counter to keep in sync. `sensProvided` is true when this same
// request also set matches.sens directly — in that case the caller's
// explicit value wins over whatever the recomputed stage would have stamped.
function syncStageCredits(db: ReturnType<typeof getDb>, matchId: string, sensProvided: boolean) {
  const match = db.prepare('SELECT hero, role, queue_mode FROM matches WHERE id = :id')
    .get({ id: matchId }) as { hero: string; role: string; queue_mode: string } | undefined;
  if (!match) return;
  const heroSlots = db.prepare('SELECT hero, role FROM match_heroes WHERE match_id = :id ORDER BY slot')
    .all({ id: matchId }) as { hero: string; role: string }[];

  const oldCredits = db.prepare('SELECT hero, blind_set_id, stage_index FROM blind_credits WHERE match_id = :id')
    .all({ id: matchId }) as { hero: string; blind_set_id: number; stage_index: number }[];
  const oldCreditByHero = new Map(oldCredits.map(c => [c.hero, c]));
  db.prepare('DELETE FROM blind_credits WHERE match_id = :id').run({ id: matchId });

  const isCompetitive = (match.queue_mode ?? 'comp_role') !== 'qp_role';
  const insertCredit = db.prepare(
    'INSERT OR IGNORE INTO blind_credits (match_id, hero, blind_set_id, stage_index) VALUES (:match_id, :hero, :blind_set_id, :stage_index)'
  );

  let primaryStage: ReturnType<typeof findActiveStage> | undefined;
  heroSlots.forEach((slot, i) => {
    const stage = findStageForRecredit(db, slot.hero, isCompetitive, oldCreditByHero.get(slot.hero));
    if (i === 0) primaryStage = stage;
    // Slot 1's match_heroes.sens mirrors matches.sens below instead (honoring
    // `sensProvided` — an explicit sens in this same request beats a
    // recomputed stage for the primary hero). Slots 2/3 have no such manual-
    // override concept on a roster edit, so an active stage is authoritative
    // here whenever one exists, same priority as the POST insert path.
    if (stage && i > 0) {
      db.prepare('UPDATE match_heroes SET sens = :sens WHERE match_id = :id AND slot = :slot')
        .run({ id: matchId, slot: i + 1, sens: stage.sens });
    }
    if (!stage) return;
    const { changes } = insertCredit.run({ match_id: matchId, hero: slot.hero, blind_set_id: stage.setId, stage_index: stage.stageIdx });
    if (changes === 0) return;
    const set = db.prepare('SELECT batch_size FROM blind_stage_sets WHERE id = :id').get({ id: stage.setId }) as { batch_size: number };
    const nStages = (db.prepare('SELECT COUNT(*) n FROM blind_stages WHERE set_id = :id').get({ id: stage.setId }) as { n: number }).n;
    const totalGames = (db.prepare('SELECT COUNT(*) n FROM blind_credits WHERE blind_set_id = :id').get({ id: stage.setId }) as { n: number }).n;
    if (totalGames >= set.batch_size * nStages) {
      db.prepare('UPDATE blind_stage_sets SET active = 0 WHERE id = :id').run({ id: stage.setId });
    }
  });

  // Keep the match row's own stage bookkeeping (the "stage N" badge, and the
  // blind_set_id/stage_index the by-stage rows key off of) in sync with the
  // primary hero's recomputed credit.
  db.prepare('UPDATE matches SET blind_trial = :bt, blind_set_id = :sid, stage_index = :si WHERE id = :id')
    .run({ id: matchId, bt: primaryStage ? 1 : 0, sid: primaryStage?.setId ?? null, si: primaryStage?.stageIdx ?? null });
  if (primaryStage && !sensProvided) {
    db.prepare('UPDATE matches SET dpi = :dpi, sens = :sens WHERE id = :id')
      .run({ id: matchId, dpi: primaryStage.dpi, sens: primaryStage.sens });
    db.prepare('UPDATE match_heroes SET sens = :sens WHERE match_id = :id AND slot = 1')
      .run({ id: matchId, sens: primaryStage.sens });
  }
  // Same priority as dpi/sens above: a set's phase-wide curve_enabled flag
  // overrides whatever was recorded before, whenever a set actually governs
  // this match after the edit. No "provided" exception (unlike sens) — curve
  // fields are never sent as part of a roster/queue_mode edit, only ever
  // corrected directly via their own EDITABLE fields, so there's no risk of
  // clobbering a value this same request just set on purpose.
  if (primaryStage) {
    const curveParams = primaryStage.curveEnabled ? getCurveParams(db) : null;
    db.prepare('UPDATE matches SET curve_enabled = :ce, curve_growth_rate = :cgr, curve_midpoint = :cm, curve_motivity = :cmot WHERE id = :id')
      .run({
        id: matchId, ce: primaryStage.curveEnabled ? 1 : 0,
        cgr: curveParams?.smooth ?? null,
        cm: curveParams?.input ?? null,
        cmot: curveParams?.output ?? null,
      });
  }
}

router.get('/:id/heroes', (req: Request, res: Response) => {
  const db = getDb();
  const rows = db.prepare('SELECT hero, role, feel, sens FROM match_heroes WHERE match_id = :id ORDER BY slot')
    .all({ id: req.params.id }) as Record<string, unknown>[];
  res.json({ rows });
});

router.put('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const fields = EDITABLE.filter(k => k in req.body);
  const heroesProvided = Array.isArray(req.body.heroes);
  const heroSensProvided = !!(req.body.heroSens && typeof req.body.heroSens === 'object');
  if (fields.length === 0 && !heroesProvided && !heroSensProvided) {
    res.status(400).json({ error: 'No editable fields provided' });
    return;
  }

  if (fields.length > 0) {
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
    // sync whenever the primary hero/role/sens is corrected via edit. sens
    // mirrors the same way feel/duration never needed to (they're captured
    // per hero from the start) — matches.sens is still slot 1's column of
    // record, so any direct edit to it (e.g. the /sens backfill form on a
    // single-hero match) needs to reach match_heroes too, or per-hero
    // analysis (which reads match_heroes.sens, not matches.sens) would keep
    // showing the pre-edit value.
    if (fields.includes('hero') || fields.includes('role') || fields.includes('sens')) {
      db.prepare(`
        UPDATE match_heroes SET hero = COALESCE(:hero, hero), role = COALESCE(:role, role),
          sens = CASE WHEN :sensProvided THEN :sens ELSE sens END
        WHERE match_id = :id AND slot = 1
      `).run({
        id: req.params.id, hero: fields.includes('hero') ? params.hero : null, role: fields.includes('role') ? params.role : null,
        sensProvided: fields.includes('sens') ? 1 : 0, sens: fields.includes('sens') ? params.sens : null,
      });
    }
  }

  // Slots 2/3 (heroes switched to mid-match) are edited as a full replace —
  // the drawer always sends the complete additional-heroes list, so stale
  // slots from a previous save don't linger.
  if (heroesProvided) {
    const extra = (req.body.heroes as any[]).filter(h => h?.hero && h?.role).slice(0, 2);
    db.prepare('DELETE FROM match_heroes WHERE match_id = :id AND slot > 1').run({ id: req.params.id });
    const insertHeroSlot = db.prepare(
      'INSERT INTO match_heroes (match_id, slot, hero, role, feel, sens) VALUES (:match_id, :slot, :hero, :role, :feel, :sens)'
    );
    extra.forEach((h, i) => insertHeroSlot.run({
      match_id: req.params.id, slot: i + 2, hero: h.hero, role: h.role,
      feel: typeof h.feel === 'number' ? h.feel : null,
      sens: typeof h.sens === 'number' ? h.sens : null,
    }));
  }

  // Standalone per-hero sens correction, keyed by hero name rather than slot —
  // what the /sens backfill form (SensLog.tsx) sends for a match with a
  // mid-match switch, since it's only ever correcting sens for stats already
  // entered, never touching the roster/feel the way the edit-match drawer's
  // `heroes` replace above does. Separate from `heroes` so it can target a
  // single hero's sens without having to resend the whole roster.
  if (req.body.heroSens && typeof req.body.heroSens === 'object') {
    const updHeroSens = db.prepare('UPDATE match_heroes SET sens = :sens WHERE match_id = :id AND hero = :hero');
    for (const [heroName, val] of Object.entries(req.body.heroSens as Record<string, unknown>)) {
      if (typeof val === 'number') updHeroSens.run({ id: req.params.id, hero: heroName, sens: val });
    }
  }

  // Hero/role/queue_mode/roster edits can move this match onto a different
  // active stage-test set (or off one entirely) — recompute its credits so
  // games_on_stage stays accurate rather than reflecting the pre-edit hero.
  const rosterChanged = fields.includes('hero') || fields.includes('role') || fields.includes('queue_mode') || heroesProvided;
  if (rosterChanged) {
    db.exec('BEGIN');
    try {
      syncStageCredits(db, req.params.id, fields.includes('sens'));
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }

  res.json({ ok: true });
});

router.delete('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const matchId = req.params.id;

  // blind_credits rows for this match cascade-delete with it (schema.ts's
  // ON DELETE CASCADE), which keeps both totalGamesOf and gamesOnStageOf
  // (COUNT(*) queries on blind_credits — blind.ts) self-healing automatically.
  // No separate counter to decrement.
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM matches WHERE id = :id').run({ id: matchId });
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  res.json({ ok: true });
});

export default router;
