import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';
import { getCurveParams } from '../lib/curveParams';
import { getExperimentHooks } from '../lib/experimentHooks';
import { saveAimStatsRows, validateAimStats, type AimStatsPayload } from '../lib/aimStatsWrite';
import { CRASHED_HERO, CRASHED_EDITABLE } from '../lib/crashed';

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


// A crashed match is a result-only record (lib/crashed.ts, schema.ts `crashed`
// column): win/loss plus the facts that are not scoreboard data. Everything
// scoreboard-shaped from the payload is ignored on purpose, so a stale client
// cannot smuggle a hero, stats or deaths in. No match_heroes, blind_credits,
// aim_stats or match_deaths row is written, and no stage test is consulted —
// that absence IS the exclusion from every by-hero view and the sens study.
// sens/dpi/feel stay NULL: a guessed sens would read as a real observation.
function logCrashedMatch(db: ReturnType<typeof getDb>, body: Record<string, any>, res: Response) {
  const { date, time, day_of_week, hour, role, map, game_type, win, queue_mode, notes, leaver, leaver_side, player_rank, player_rank_start, lobby_low, lobby_high, placement, account } = body;
  if (!date || !map || !game_type || win === undefined || !['DPS', 'Tank', 'Support'].includes(role)) {
    res.status(400).json({ error: 'Missing required fields (crashed match needs date, role, map, game_type, win)' });
    return;
  }
  const result = db.prepare(`
    INSERT INTO matches (date, time, day_of_week, hour, hero, role, map, game_type, win, queue_mode, notes, curve_enabled, leaver, leaver_side, player_rank, player_rank_start, lobby_low, lobby_high, placement, account, crashed)
    VALUES (:date, :time, :day_of_week, :hour, :hero, :role, :map, :game_type, :win, :queue_mode, :notes, 0, :leaver, :leaver_side, :player_rank, :player_rank_start, :lobby_low, :lobby_high, :placement, :account, 1)
  `).run({
    date, time: time ?? null, day_of_week: day_of_week ?? null, hour: hour ?? null, hero: CRASHED_HERO, role, map, game_type,
    win: win ? 1 : 0, queue_mode: queue_mode ?? 'comp_role', notes: notes?.trim() || null,
    leaver: leaver ? 1 : null, leaver_side: leaver && (leaver_side === 'mine' || leaver_side === 'theirs') ? leaver_side : null,
    player_rank: player_rank ?? null, player_rank_start: player_rank_start ?? null,
    lobby_low: lobby_low ?? null, lobby_high: lobby_high ?? null, placement: placement ? 1 : null, account: account ?? null,
  });
  res.json({ id: result.lastInsertRowid as number });
}

router.post('/', (req: Request, res: Response) => {
  const db = getDb();
  const { date, time, day_of_week, hour, hero, role, map, game_type, win, queue_mode, sens, feel, team_rating, notes, heroes, curve_enabled, match_deaths, match_quality, result_driver, leaver, leaver_side, player_rank, player_rank_start, lobby_low, lobby_high, placement, account, aim_stats, crashed } = req.body;
  if (crashed === true || crashed === 1) { logCrashedMatch(db, req.body, res); return; }

  // leaver_side only ever means something when leaver is actually set — a
  // side with no leaver would be a contradiction on the row. Normalized to
  // NULL rather than trusting the client not to send one.
  const finalLeaverSide: 'mine' | 'theirs' | null =
    leaver && (leaver_side === 'mine' || leaver_side === 'theirs') ? leaver_side : null;

  if (!date || !hero || !role || !map || !game_type || win === undefined) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
  }

  // Optional aim stats sent with the match (Log Match's "Add aim stats now"
  // fold-out). Validated up front, before anything is written, so bad stats
  // can't leave a half-saved match behind; the write itself happens inside
  // the match transaction below.
  const aimStatsIn: AimStatsPayload | null = aim_stats && typeof aim_stats === 'object' ? aim_stats : null;
  if (aimStatsIn) {
    const roster = [hero, ...(Array.isArray(heroes) ? heroes.filter((h: any) => h?.hero && h?.role).slice(0, 2).map((h: any) => h.hero) : [])];
    const aimError = validateAimStats(aimStatsIn, roster);
    if (aimError) {
      res.status(400).json({ error: `aim_stats: ${aimError}` });
      return;
    }
  }

  // matches.deaths is frozen historical data (v1/v2/v3 axis records) — new
  // matches always write NULL there. Per-death facts now live in
  // match_deaths, inserted below, inside the same transaction as the match row.
  const deathsJson = null;

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

  // Which experiment (if any) governs this hero is the hooks' business —
  // lib/experimentHooks.ts. The assignment answers "what sens was this hero
  // at" for any mode (so a QP match on a tested hero still records its real
  // sens); `assign.credit` is set only when the match also counts for the
  // study (Competitive, not a Designated Fallback), and decides blind_trial/
  // blind_set_id/stage_index below. With no controller installed there is no
  // assignment and the match keeps whatever sens/dpi the client sent.
  const hooks = getExperimentHooks();
  const assign = hooks.sensFor(db, hero, queue_mode);
  if (assign) {
    finalDpi = assign.dpi;
    finalSens = assign.sens;
  }
  if (assign?.credit) {
    isStudy = 1;
    setId = assign.credit.setId;
    stageIdx = assign.credit.stageIdx;
  }
  // Whether acceleration was on is a phase-wide constant on the active set
  // (blind_stage_sets.curve_enabled), same as dpi/sens above — it overrides
  // whatever LogMatch's manual toggle sent whenever a set actually governs
  // this match. The manual toggle only matters as the fallback for matches
  // with no active test at all (no hero-tagged or ad-hoc set running).
  const finalCurveEnabled = assign?.governsCurve ? assign.curveEnabled : (curve_enabled === true || curve_enabled === 1);

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
    // back to LogMatch's manual toggle when no set is active at all.
    //
    // curve_growth_rate/curve_midpoint/curve_motivity (the Jump-curve params)
    // stopped being stamped 2026-09-20 — Sean moved his real Rawaccel config
    // to a Look Up Table, so those three columns would no longer describe
    // what any new match actually ran under. curve_enabled stays live: a LUT
    // is still acceleration, so a match played under one is still curve-on.
    // That makes LUT matches their own variant in curveVariantKey (all three
    // Jump columns null) distinct from every past Jump-curve variant, which
    // is correct — they ARE a different treatment, not a continuation of the
    // old one. Existing rows keep whatever was stamped at the time.
    //
    // curve_lut replaces them as the record of what ran. It is stamped only
    // when a real table is on file (curve_params.lut_points non-null) AND
    // acceleration was actually on — never from the card's seeded
    // approximation, which would put a fabricated table where a measurement
    // belongs. Null means no table on file, same honest-absence convention
    // the Jump columns already use for pre-2026-08-25 rows.
    const liveLut = finalCurveEnabled ? getCurveParams(db).lutPoints : null;
    const curveLutJson = liveLut ? JSON.stringify(liveLut) : null;
    const result = db.prepare(`
      INSERT INTO matches (date, time, day_of_week, hour, hero, role, map, game_type, win, deaths, queue_mode, sens, dpi, blind_trial, blind_set_id, stage_index, feel, team_rating, notes, curve_enabled, curve_growth_rate, curve_midpoint, curve_motivity, curve_lut, match_quality, result_driver, leaver, leaver_side, player_rank, player_rank_start, lobby_low, lobby_high, placement, account)
      VALUES (:date, :time, :day_of_week, :hour, :hero, :role, :map, :game_type, :win, :deaths, :queue_mode, :sens, :dpi, :blind_trial, :blind_set_id, :stage_index, :feel, :team_rating, :notes, :curve_enabled, :curve_growth_rate, :curve_midpoint, :curve_motivity, :curve_lut, :match_quality, :result_driver, :leaver, :leaver_side, :player_rank, :player_rank_start, :lobby_low, :lobby_high, :placement, :account)
    `).run({ date, time: time ?? null, day_of_week: day_of_week ?? null, hour: hour ?? null, hero, role, map, game_type, win: win ? 1 : 0, deaths: deathsJson, queue_mode: queue_mode ?? 'comp_role', sens: finalSens, dpi: finalDpi, blind_trial: isStudy, blind_set_id: setId, stage_index: stageIdx, feel: feel ?? null, team_rating: team_rating ?? null, notes: notes?.trim() || null, curve_enabled: finalCurveEnabled ? 1 : 0, curve_growth_rate: null, curve_midpoint: null, curve_motivity: null, curve_lut: curveLutJson, match_quality: match_quality ?? null, result_driver: result_driver ?? null, leaver: leaver ? 1 : 0, leaver_side: finalLeaverSide, player_rank: player_rank ?? null, player_rank_start: player_rank_start ?? null, lobby_low: lobby_low ?? null, lobby_high: lobby_high ?? null, placement: placement ? 1 : null, account: account ?? null });

    matchId = result.lastInsertRowid as number;

    // Per-death facts (who killed Sean, whether it was an ult) — seq is
    // 1-based in the order the client buffered them, matching the order
    // deaths actually happened in the match.
    const insertDeath = db.prepare(
      'INSERT INTO match_deaths (match_id, seq, killer, killer_role, ult) VALUES (:match_id, :seq, :killer, :killer_role, :ult)'
    );
    const deathRows = Array.isArray(match_deaths) ? match_deaths : [];
    let skippedDeaths = 0;
    deathRows.forEach((d: any, i: number) => {
      if (!d?.killer || !d?.killer_role) { skippedDeaths++; return; }
      insertDeath.run({ match_id: matchId, seq: i + 1, killer: d.killer, killer_role: d.killer_role, ult: d.ult ? 1 : 0 });
    });
    // The client always builds entries from the HEROES map, so a malformed one
    // means the payload shape has drifted — say so loudly. Dropping deaths
    // silently is how the old `matches.deaths` column rotted unnoticed: the
    // save still looked like it succeeded while the data went nowhere.
    if (skippedDeaths > 0) {
      console.error(
        `[matches] match ${matchId}: dropped ${skippedDeaths}/${deathRows.length} death rows — missing killer/killer_role. Client payload shape has likely changed.`
      );
    }

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
    // Only slot 1 (the starting hero) holds credit at insert time (no minutes
    // yet — see the credit block below). A switched-to hero still records
    // its own real sens (via sensStageFor — DF-aware, same lookup the
    // primary hero above uses); `stage` here is display-only: its credit
    // arrives with the Aim Stats save (applyPlayTimeCredit), which matches
    // the hero's logged sens back to the stage it was on.
    const extraHeroStages = (Array.isArray(heroes) ? heroes.filter((h: any) => h?.hero && h?.role).slice(0, 2) : [])
      .map((h: any) => ({ hero: h.hero, role: h.role, feel: h.feel, sens: h.sens, stage: hooks.sensFor(db, h.hero, queue_mode) }));
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

    // At insert time only the starting hero (slot 1) holds test credit: no
    // per-hero minutes exist yet. When the Aim Stats form later saves them,
    // the controller's play-time credit gives every hero its own row under the
    // 2026-10-01 rules. QP and Designated Fallback heroes arrive here with
    // credit null, so they earn nothing.
    hooks.onMatchSaved(db, { matchId, hero, credit: assign?.credit ?? null });
    // Aim stats ride in the same transaction as the match. Written after the
    // slot-1 credit above so the play-time credit hook re-derives credits
    // from the real minutes — the one credit path the backlog form uses too.
    if (aimStatsIn) saveAimStatsRows(db, matchId, aimStatsIn);
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
const EDITABLE = ['date', 'time', 'day_of_week', 'hour', 'hero', 'role', 'map', 'game_type', 'win', 'queue_mode', 'sens', 'feel', 'team_rating', 'notes', 'curve_enabled', 'curve_growth_rate', 'curve_midpoint', 'curve_motivity', 'match_quality', 'result_driver', 'leaver', 'leaver_side', 'player_rank', 'player_rank_start', 'lobby_low', 'lobby_high', 'account'] as const;

// A single match's full row — added for MatchEditDrawer.tsx's sens/leaver
// controls, which need fields (leaver, leaver_side, sens, blind_trial) that
// the list route's TrendPoint-shaped chart data never carried. Plain
// SELECT *, same as the list route above.
// Same last-5 map history as /:id/map-history, but keyed on map NAME instead
// of an existing match — Prematch's voting chips need the strip before any
// match has been logged, so there's no id to hang it off. Batched
// (?maps=A,B,C) so a full set of voting picks costs one request, not three.
// Rows come back oldest-first to match the by-id route's shape. Registered
// before /:id, or /:id would catch it as a match id.
router.get('/map-history', (req: Request, res: Response) => {
  const db = getDb();
  const maps = String(req.query.maps ?? '').split(',').map(s => s.trim()).filter(Boolean).slice(0, 10);

  const stmt = db.prepare(`
    SELECT win, queue_mode FROM matches
    WHERE map = :map
    ORDER BY id DESC LIMIT 5
  `);
  const byMap: Record<string, { win: 0 | 1; queue_mode: string }[]> = {};
  for (const map of maps) {
    byMap[map] = (stmt.all({ map }) as { win: 0 | 1; queue_mode: string }[]).reverse();
  }
  res.json({ byMap });
});

router.get('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM matches WHERE id = :id').get({ id: req.params.id }) as Record<string, unknown> | undefined;
  if (!row) { res.status(404).json({ error: 'Match not found' }); return; }
  res.json({ row });
});

router.get('/:id/heroes', (req: Request, res: Response) => {
  const db = getDb();
  // `credited` flags whether this slot's hero has a blind_credits row for
  // THIS match — only ever true for slot 1 (only the starting hero can earn
  // test credit, see the 2026-09-24 rule threaded through this file), but
  // computed by an actual join rather than assumed, so it stays honest if
  // that rule ever changes. MatchEditDrawer's sens-edit warning ("Test game —
  // credit stays on its stage") reads this instead of duplicating the rule.
  const creditedHeroes = new Set(getExperimentHooks().creditedHeroes(db, req.params.id));
  const rows = (db.prepare('SELECT hero, role, feel, sens FROM match_heroes WHERE match_id = :id ORDER BY slot')
    .all({ id: req.params.id }) as { hero: string; role: string; feel: number | null; sens: number | null }[])
    .map(r => ({ ...r, credited: creditedHeroes.has(r.hero) }));
  res.json({ rows });
});

// Last 5 matches played on this match's own (primary) hero, including this
// match itself — id order as the "point in time" tiebreak, same convention
// stats.ts's recent10 uses. Powers the win/mode history strip shown under a
// match row's hero pill (Today's Matches, Logged Today) instead of a static
// timestamp.
router.get('/:id/hero-history', (req: Request, res: Response) => {
  const db = getDb();
  const match = db.prepare('SELECT hero FROM matches WHERE id = :id').get({ id: req.params.id }) as { hero: string } | undefined;
  if (!match) { res.status(404).json({ error: 'match not found' }); return; }

  const rows = db.prepare(`
    SELECT win, queue_mode FROM matches_by_hero
    WHERE hero = :hero AND id <= :id
    ORDER BY id DESC LIMIT 5
  `).all({ hero: match.hero, id: req.params.id }) as { win: 0 | 1; queue_mode: string }[];
  res.json({ rows: rows.reverse() });
});

// Same idea as hero-history above, keyed on this match's map instead of its
// hero — reads straight off `matches` rather than matches_by_hero since a map
// result isn't per-hero, so a mid-match switch shouldn't multiply it.
router.get('/:id/map-history', (req: Request, res: Response) => {
  const db = getDb();
  const match = db.prepare('SELECT map FROM matches WHERE id = :id').get({ id: req.params.id }) as { map: string } | undefined;
  if (!match) { res.status(404).json({ error: 'match not found' }); return; }

  const rows = db.prepare(`
    SELECT win, queue_mode FROM matches
    WHERE map = :map AND id <= :id
    ORDER BY id DESC LIMIT 5
  `).all({ map: match.map, id: req.params.id }) as { win: 0 | 1; queue_mode: string }[];
  res.json({ rows: rows.reverse() });
});

// Fix a forgotten promotion/demotion after the fact (Today's Matches card,
// 2026-09-26). A match's end rank is the next match's start rank, so a wrong
// outcome on one game leaves every later game on that ladder, and the live
// badge in player_ranks, off by the same amount. This rewrites the whole
// chain in one transaction:
//   1. this match's end = start ± 1 (or = start for "none");
//   2. each later ranked match on the same account+role whose start equals
//      the previous match's OLD end is shifted by the same delta, start and
//      end both. The walk stops at the first row that doesn't chain — that
//      game's start was already hand-corrected, so the fix is absorbed there;
//   3. if the walk reached the ladder's latest match, player_ranks moves too,
//      but only if it still equals that match's old end (i.e. the drum wasn't
//      already fixed by hand).
router.put('/:id/rank-outcome', (req: Request, res: Response) => {
  const db = getDb();
  const outcome = req.body?.outcome;
  if (outcome !== 'promoted' && outcome !== 'demoted' && outcome !== 'none') {
    res.status(400).json({ error: "outcome must be 'promoted', 'demoted' or 'none'" });
    return;
  }
  const m = db.prepare(`SELECT id, account, CASE WHEN queue_mode = 'comp_open' THEN 'Open' ELSE role END AS role, date, time, player_rank, player_rank_start FROM matches WHERE id = :id`)
    .get({ id: req.params.id }) as { id: number; account: string | null; role: string; date: string; time: string | null; player_rank: number | null; player_rank_start: number | null } | undefined;
  if (!m) { res.status(404).json({ error: 'match not found' }); return; }
  if (m.player_rank_start == null) {
    res.status(400).json({ error: 'this match has no starting rank to move from' });
    return;
  }
  const clamp = (r: number) => Math.min(45, Math.max(1, r));
  const step = outcome === 'promoted' ? 1 : outcome === 'demoted' ? -1 : 0;
  const oldEnd = m.player_rank ?? m.player_rank_start;
  const newEnd = clamp(m.player_rank_start + step);
  const delta = newEnd - oldEnd;
  const shifted: number[] = [];
  let rank: number | null = null;
  let reachedLatest = true;
  let prevOldEnd = oldEnd;

  db.exec('BEGIN');
  try {
    db.prepare('UPDATE matches SET player_rank = :r WHERE id = :id').run({ r: newEnd, id: m.id });

    if (delta !== 0) {
      const later = db.prepare(`
        SELECT id, player_rank, player_rank_start FROM matches
        WHERE account IS :account AND (CASE WHEN queue_mode = 'comp_open' THEN 'Open' ELSE role END) = :role AND id != :id
          AND (player_rank_start IS NOT NULL OR player_rank IS NOT NULL)
          AND (date, COALESCE(time, ''), id) > (:date, :time, :id)
        ORDER BY date, COALESCE(time, ''), id
      `).all({ account: m.account, role: m.role, id: m.id, date: m.date, time: m.time ?? '' }) as { id: number; player_rank: number | null; player_rank_start: number | null }[];
      const upd = db.prepare('UPDATE matches SET player_rank_start = :s, player_rank = :e WHERE id = :id');
      for (const r of later) {
        if (r.player_rank_start !== prevOldEnd) { reachedLatest = false; break; }
        const end = r.player_rank ?? r.player_rank_start;
        upd.run({ id: r.id, s: clamp(r.player_rank_start + delta), e: clamp(end + delta) });
        shifted.push(r.id);
        prevOldEnd = end;
      }
      if (reachedLatest && m.account != null) {
        const live = db.prepare('SELECT rank FROM player_ranks WHERE account = :a AND role = :r')
          .get({ a: m.account, r: m.role }) as { rank: number | null } | undefined;
        if (live?.rank === prevOldEnd) {
          rank = clamp(prevOldEnd + delta);
          db.prepare('UPDATE player_ranks SET rank = :rank WHERE account = :a AND role = :r')
            .run({ rank, a: m.account, r: m.role });
        }
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  // rank: the live ladder's new value when it moved, else null (untouched).
  // latestEnd: the ladder's latest match's new end rank, when the fix reached
  // it (null otherwise) — the client's "rank at last log" follows it.
  res.json({ id: m.id, player_rank: newEnd, shifted, rank, latestEnd: reachedLatest ? prevOldEnd + delta : null, account: m.account, role: m.role });
});

router.put('/:id', (req: Request, res: Response) => {
  const db = getDb();
  // A crashed match stays result-only: scoreboard-shaped edits (hero, sens,
  // feel, roster, deaths) are ignored, and credits are never recomputed — an
  // edit must not be able to give it a hero or a stage credit.
  const isCrashed = !!(db.prepare('SELECT crashed FROM matches WHERE id = :id').get({ id: req.params.id }) as { crashed: number } | undefined)?.crashed;
  const fields = EDITABLE.filter(k => k in req.body && (!isCrashed || (CRASHED_EDITABLE as readonly string[]).includes(k)));
  const heroesProvided = !isCrashed && Array.isArray(req.body.heroes);
  const heroSensProvided = !isCrashed && !!(req.body.heroSens && typeof req.body.heroSens === 'object');
  const deathsProvided = !isCrashed && Array.isArray(req.body.match_deaths);
  if (fields.length === 0 && !heroesProvided && !heroSensProvided && !deathsProvided) {
    res.status(400).json({ error: 'No editable fields provided' });
    return;
  }

  if (fields.length > 0) {
    const params: Record<string, string | number | null> = { id: req.params.id };
    for (const k of fields) {
      const v = req.body[k];
      params[k] = k === 'win' ? (v ? 1 : 0) : v ?? null;
    }
    // Clearing leaver on an edit (turning the checkbox back off) must also
    // clear leaver_side — otherwise a stale 'mine'/'theirs' from before the
    // edit would survive on a row that no longer claims a leaver happened.
    // If leaver_side is being edited on its own (leaver not in this PUT's
    // body), it's trusted as sent — the caller already knows leaver=1 holds.
    const clearLeaverSide = fields.includes('leaver') && !req.body.leaver && !fields.includes('leaver_side');
    if (clearLeaverSide) params.leaver_side = null;
    const setClause = [...fields, ...(clearLeaverSide ? ['leaver_side'] : [])].map(k => `${k} = :${k}`).join(', ');

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

  // Per-death rows are edited as a full replace, same as slots 2/3 above —
  // the drawer always sends the complete death list, and seq is positional
  // (1-based, in the order the deaths happened), so patching individual rows
  // would leave gaps/duplicates in the sequence. Sending an empty array is a
  // legitimate edit meaning "this match had no deaths recorded"; omitting
  // match_deaths entirely leaves the existing rows untouched.
  if (deathsProvided) {
    db.prepare('DELETE FROM match_deaths WHERE match_id = :id').run({ id: req.params.id });
    const insertDeath = db.prepare(
      'INSERT INTO match_deaths (match_id, seq, killer, killer_role, ult) VALUES (:match_id, :seq, :killer, :killer_role, :ult)'
    );
    const deathRows = req.body.match_deaths as any[];
    let skippedDeaths = 0;
    deathRows.forEach((d: any, i: number) => {
      if (!d?.killer || !d?.killer_role) { skippedDeaths++; return; }
      insertDeath.run({ match_id: req.params.id, seq: i + 1, killer: d.killer, killer_role: d.killer_role, ult: d.ult ? 1 : 0 });
    });
    // Same loud failure as the POST insert path — a malformed entry means the
    // client payload shape has drifted, and silently dropping deaths is
    // exactly how the old `matches.deaths` column rotted unnoticed.
    if (skippedDeaths > 0) {
      console.error(
        `[matches] match ${req.params.id}: dropped ${skippedDeaths}/${deathRows.length} death rows on edit — missing killer/killer_role. Client payload shape has likely changed.`
      );
    }
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
  const rosterChanged = !isCrashed && (fields.includes('hero') || fields.includes('role') || fields.includes('queue_mode') || heroesProvided);
  if (rosterChanged) {
    db.exec('BEGIN');
    try {
      getExperimentHooks().onRosterEdited(db, req.params.id, { sensProvided: fields.includes('sens') });
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
  //
  // The active flag isn't derived at read time, though, so it needs an
  // explicit nudge: read the affected set ids BEFORE the cascade takes the
  // rows away, then re-derive each one after. Without this a deletion out of
  // a finished set leaves it short of target and still retired, which is the
  // dead end set 86 (Reaper) sat in — unadvanceable and uncreditable.
  const hooks = getExperimentHooks();
  const deleteToken = hooks.beforeMatchDelete(db, matchId);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM matches WHERE id = :id').run({ id: matchId });
    hooks.afterMatchDelete(db, matchId, deleteToken);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  res.json({ ok: true });
});

export default router;
