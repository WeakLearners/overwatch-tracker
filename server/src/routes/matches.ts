import { Router, Request, Response } from 'express';
import { getDb } from '../db/schema';
import { getCurveParams } from '../lib/curveParams';
import { syncSetActive, liveStageIndex, stagesOf } from './blind';
import { isStudyQueueMode, LOCKED_DPI } from '../lib/blind';
import { isDfHero, dfSensForHero } from '../lib/df';

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
// both need to know "what sens/dpi is this hero actually at right now."
//
// Deliberately mode-agnostic (fixed 2026-09-24). "What sens was this hero
// at" and "does this match count for the study" are two different
// questions — a hero under an active stage test is at that stage's sens
// whether the match is Competitive or QP; only crediting (blind_trial,
// blind_credits, games_on_stage) is Competitive-only, and that gate lives
// at each call site below via isCompetitive, not in this lookup. Before the
// fix, this function itself refused to look anything up off Competitive, so
// every QP match on a tested hero silently fell back to the frozen 2.5
// default instead of showing/recording the hero's real current sens.
function findActiveStage(db: ReturnType<typeof getDb>, hero: string) {
  const activeSet = db.prepare(`
    SELECT id, cur_rel, in_game_sens, curve_enabled, chunk_size, batch_size FROM blind_stage_sets
    WHERE active = 1 AND hero = :hero
    UNION ALL
    SELECT id, cur_rel, in_game_sens, curve_enabled, chunk_size, batch_size FROM blind_stage_sets
    WHERE active = 1 AND hero IS NULL AND NOT EXISTS (SELECT 1 FROM blind_stage_sets WHERE active = 1 AND hero = :hero)
    LIMIT 1
  `).get({ hero }) as { id: number; cur_rel: number; in_game_sens: number; curve_enabled: number; chunk_size: number | null; batch_size: number } | undefined;
  if (!activeSet) return undefined;
  // Chunked 2-stage sets derive the live stage from total credits so far
  // (ABBA — see blind.ts's liveStageIndex/abbaStageFor) instead of trusting
  // cur_rel, which is never written for them. stagesOf's length is the
  // n_stages guard liveStageIndex needs to fall back correctly for
  // anything other than a real 2-stage chunked set.
  const nStages = stagesOf(db, activeSet.id).length;
  const stageIdx = liveStageIndex(db, activeSet, nStages);
  const stage = db.prepare('SELECT dpi, sens FROM blind_stages WHERE set_id = :sid AND stage_index = :si')
    .get({ sid: activeSet.id, si: stageIdx }) as { dpi: number; sens: number | null } | undefined;
  if (!stage) return undefined;
  return {
    setId: activeSet.id, stageIdx, dpi: stage.dpi, sens: stage.sens ?? activeSet.in_game_sens,
    curveEnabled: !!activeSet.curve_enabled,
  };
}

// "What sens is this hero at" for any hero, DF-aware — the same
// mode-agnostic question findActiveStage answers, except a Designated
// Fallback (lib/df.ts) short-circuits it entirely: a DF is never under a
// stage test (set creation on it is refused server-side — see blind.ts's
// POST /sets), so without this an ad-hoc, hero-less active set would still
// sweep it in via findActiveStage's hero-IS-NULL fallback branch, and the
// DF would show that set's sens instead of its own fixed one. DPI is
// LOCKED_DPI for a DF for the same reason every current stage-test row is —
// there's no meaningful "DF DPI" to report otherwise.
function sensStageFor(db: ReturnType<typeof getDb>, hero: string) {
  const dfSens = dfSensForHero(db, hero);
  if (dfSens != null) return { dpi: LOCKED_DPI, sens: dfSens, curveEnabled: false };
  return findActiveStage(db, hero);
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
// This function answers "does this match count for the study" (crediting),
// not "what sens was the hero at" — so it stays Competitive-only in full,
// unlike the mode-agnostic findActiveStage it wraps.
function findStageForRecredit(
  db: ReturnType<typeof getDb>, hero: string, isCompetitive: boolean,
  priorCredit: { blind_set_id: number; stage_index: number } | undefined,
) {
  // A queue_mode edit off comp (isCompetitive false) must drop the credit
  // outright — reusing priorCredit here would resurrect it every time,
  // silently undoing the very correction the edit was making. A Designated
  // Fallback hero is refused the same way, unconditionally — it can never be
  // credited in any mode, and a stale priorCredit shouldn't resurrect one
  // either (defensive: a hero can't normally become DF while mid-history,
  // but this keeps the "DF never earns credit" rule enforced at every path
  // rather than relying on findActiveStage never matching it).
  if (!isCompetitive || isDfHero(db, hero)) return undefined;
  const active = findActiveStage(db, hero);
  if (active) return active;
  if (!priorCredit) return undefined;
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
  const { date, time, day_of_week, hour, hero, role, map, game_type, win, queue_mode, sens, feel, team_rating, notes, heroes, curve_enabled, match_deaths, match_quality, result_driver, leaver, leaver_side, player_rank, player_rank_start, lobby_low, lobby_high, account } = req.body;

  // leaver_side only ever means something when leaver is actually set — a
  // side with no leaver would be a contradiction on the row. Normalized to
  // NULL rather than trusting the client not to send one.
  const finalLeaverSide: 'mine' | 'theirs' | null =
    leaver && (leaver_side === 'mine' || leaver_side === 'theirs') ? leaver_side : null;

  if (!date || !hero || !role || !map || !game_type || win === undefined) {
    res.status(400).json({ error: 'Missing required fields' });
    return;
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

  // Quick Play games are loggable but never feed the DPI study — only
  // Competitive matches move a stage-test's counters, for every role. See
  // lib/blind.ts's isStudyQueueMode for the history (Support had a QP
  // exception until 2026-08-23) and why this must be the one place the
  // condition lives.
  const isCompetitive = isStudyQueueMode(queue_mode);

  // Every hero actually played gets checked against its own active set, not
  // just slot 1 — the primary hero's lookup also determines the sens/dpi
  // stamped onto the match row itself. Looked up unconditionally (mode
  // doesn't change what sens the hero was actually at) — isStudy/setId/
  // stageIdx (the crediting fields) are gated on isCompetitive separately
  // just below, so a QP match on a tested hero shows/records that hero's
  // real sens but still never earns a stage credit.
  // Designated Fallback (lib/df.ts): skip findActiveStage entirely rather
  // than gate its result afterward — an ad-hoc, hero-less active set would
  // otherwise still match a DF hero through findActiveStage's fallback
  // branch and hand it that set's sens/dpi, which is exactly the "sweep in
  // by accident" case sensStageFor's comment above describes. A DF always
  // shows/records its own fixed sens, never a study value.
  const heroIsDf = isDfHero(db, hero);
  const primaryStage = heroIsDf ? undefined : findActiveStage(db, hero);
  if (heroIsDf) {
    finalDpi = LOCKED_DPI;
    finalSens = dfSensForHero(db, hero) ?? finalSens;
  } else if (primaryStage) {
    finalDpi = primaryStage.dpi;
    finalSens = primaryStage.sens;
  }
  if (primaryStage && isCompetitive) {
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
      INSERT INTO matches (date, time, day_of_week, hour, hero, role, map, game_type, win, deaths, queue_mode, sens, dpi, blind_trial, blind_set_id, stage_index, feel, team_rating, notes, curve_enabled, curve_growth_rate, curve_midpoint, curve_motivity, curve_lut, match_quality, result_driver, leaver, leaver_side, player_rank, player_rank_start, lobby_low, lobby_high, account)
      VALUES (:date, :time, :day_of_week, :hour, :hero, :role, :map, :game_type, :win, :deaths, :queue_mode, :sens, :dpi, :blind_trial, :blind_set_id, :stage_index, :feel, :team_rating, :notes, :curve_enabled, :curve_growth_rate, :curve_midpoint, :curve_motivity, :curve_lut, :match_quality, :result_driver, :leaver, :leaver_side, :player_rank, :player_rank_start, :lobby_low, :lobby_high, :account)
    `).run({ date, time: time ?? null, day_of_week: day_of_week ?? null, hour: hour ?? null, hero, role, map, game_type, win: win ? 1 : 0, deaths: deathsJson, queue_mode: queue_mode ?? 'comp_role', sens: finalSens, dpi: finalDpi, blind_trial: isStudy, blind_set_id: setId, stage_index: stageIdx, feel: feel ?? null, team_rating: team_rating ?? null, notes: notes?.trim() || null, curve_enabled: finalCurveEnabled ? 1 : 0, curve_growth_rate: null, curve_midpoint: null, curve_motivity: null, curve_lut: curveLutJson, match_quality: match_quality ?? null, result_driver: result_driver ?? null, leaver: leaver ? 1 : 0, leaver_side: finalLeaverSide, player_rank: player_rank ?? null, player_rank_start: player_rank_start ?? null, lobby_low: lobby_low ?? null, lobby_high: lobby_high ?? null, account: account ?? null });

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
    // Only slot 1 (the starting hero) can ever earn test credit — fixed
    // 2026-09-24 (mid-match-switch build). A switched-to hero still records
    // its own real sens (via sensStageFor — DF-aware, same lookup the
    // primary hero above uses), but `stage` here is display-only now: no
    // credit is ever applied off it, so it no longer needs to carry
    // setId/stageIdx the way it used to when extras could be credited too.
    const extraHeroStages = (Array.isArray(heroes) ? heroes.filter((h: any) => h?.hero && h?.role).slice(0, 2) : [])
      .map((h: any) => ({ hero: h.hero, role: h.role, feel: h.feel, sens: h.sens, stage: sensStageFor(db, h.hero) }));
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
    // Only the starting hero (slot 1) earns test credit — fixed 2026-09-24.
    // Before this, a mid-match switch (slot 2/3) credited its own active
    // test too, which meant 25% of all credits (188 of 762 since Aug 1) went
    // to heroes entered from behind, partial games. Background/rationale
    // recorded in modular-tracking-roadmap.md under Sean's 2026-09-24
    // additions; the 188 pre-existing credits are left as-is (see that doc —
    // excluding them from analysis is a separate open decision for Sean).
    // Gated on isCompetitive here (not inside the lookup) — a QP match's
    // heroSlots/sens above are stamped with the real stage sens same as
    // Competitive, but QP earns no credit at all. primaryStage is already
    // undefined for a Designated Fallback hero (see above), so this also
    // enforces "DF never earns credit" with no separate check needed here.
    const creditsToApply = (isCompetitive && primaryStage) ? [{ hero, ...primaryStage }] : [];

    for (const credit of creditsToApply) {
      // Guards against double-crediting if the same hero somehow appears twice
      // in heroSlots (e.g. switched back to the match's starting hero) — the
      // (match_id, hero) PK means only the first insert actually lands.
      const { changes } = insertCredit.run({ match_id: matchId, hero: credit.hero, blind_set_id: credit.setId, stage_index: credit.stageIdx });
      if (changes === 0) continue;
      // Multiple sets can be active at once now (one per hero), so nothing else
      // retires a finished set the way the old single-active-slot model used to
      // when a new set took over. Retire it here instead, the moment every
      // stage has its games — otherwise it would stay active forever (DELETE
      // refuses completed sets) and permanently block this hero from starting
      // a fresh test. syncSetActive owns that decision now, per stage rather
      // than on the running total; see blind.ts.
      syncSetActive(db, credit.setId);
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
const EDITABLE = ['date', 'time', 'day_of_week', 'hour', 'hero', 'role', 'map', 'game_type', 'win', 'queue_mode', 'sens', 'feel', 'team_rating', 'notes', 'curve_enabled', 'curve_growth_rate', 'curve_midpoint', 'curve_motivity', 'match_quality', 'result_driver', 'leaver', 'leaver_side', 'player_rank', 'player_rank_start', 'lobby_low', 'lobby_high', 'account'] as const;

// Which hero earns this match's test credit — the play-time rule, added
// 2026-09-24. Credit goes to the hero Sean spent at least two-thirds of the
// match on, from the per-hero minutes in the Aim Stats form. A 5-minute
// cameo on the tested hero no longer counts as a game on that sens.
// Returns the slot-1 hero when no minutes are on file yet (the match is
// logged before its details, so this is the normal state at insert time),
// and null when minutes exist but nobody reached two-thirds — a split game
// credits no one. A Designated Fallback winner also ends up with no credit,
// since findStageForRecredit refuses every DF hero.
function creditHeroFor(db: ReturnType<typeof getDb>, matchId: number | string, slot1Hero: string): string | null {
  const rows = db.prepare('SELECT hero, duration_min FROM aim_stats_heroes WHERE match_id = :id AND duration_min > 0')
    .all({ id: matchId }) as { hero: string; duration_min: number }[];
  const total = rows.reduce((a, r) => a + r.duration_min, 0);
  if (total === 0) return slot1Hero;
  // Integer compare, not a 0.667 float: 10 of 15 minutes is exactly 2/3 and
  // must pass, but 10/15 = 0.6666… would fail a >= 0.667 check.
  const winner = rows.find(r => r.duration_min * 3 >= total * 2);
  return winner ? winner.hero : null;
}

// Re-applies the play-time rule after the Aim Stats form saves (aim.ts).
// Narrower than syncStageCredits on purpose: it moves only the credit, and
// never re-stamps sens/dpi/curve. An old match's details can be corrected
// long after its stage has moved on, and those facts describe what was
// played then. The credited hero keeps its prior credit when it already
// had one, so a correction can't shift an old match onto today's stage.
export function applyPlayTimeCredit(db: ReturnType<typeof getDb>, matchId: number | string) {
  const match = db.prepare('SELECT hero, queue_mode FROM matches WHERE id = :id')
    .get({ id: matchId }) as { hero: string; queue_mode: string } | undefined;
  if (!match) return;
  const oldCredits = db.prepare('SELECT hero, blind_set_id, stage_index FROM blind_credits WHERE match_id = :id')
    .all({ id: matchId }) as { hero: string; blind_set_id: number; stage_index: number }[];
  const creditHero = creditHeroFor(db, matchId, match.hero);
  if (oldCredits.length === 1 && oldCredits[0].hero === creditHero) return;
  if (oldCredits.length === 0 && creditHero === null) return;

  const prior = creditHero ? oldCredits.find(c => c.hero === creditHero) : undefined;
  const stage = creditHero
    ? findStageForRecredit(db, creditHero, isStudyQueueMode(match.queue_mode), prior)
    : undefined;
  db.prepare('DELETE FROM blind_credits WHERE match_id = :id').run({ id: matchId });
  if (stage && creditHero) {
    db.prepare('INSERT INTO blind_credits (match_id, hero, blind_set_id, stage_index) VALUES (:match_id, :hero, :sid, :si)')
      .run({ match_id: matchId, hero: creditHero, sid: stage.setId, si: stage.stageIdx });
  }
  db.prepare('UPDATE matches SET blind_trial = :bt, blind_set_id = :sid, stage_index = :si WHERE id = :id')
    .run({ id: matchId, bt: stage ? 1 : 0, sid: stage?.setId ?? null, si: stage?.stageIdx ?? null });
  const touched = new Set(oldCredits.map(c => c.blind_set_id));
  if (stage) touched.add(stage.setId);
  for (const setId of touched) syncSetActive(db, setId);
}

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

  const isCompetitive = isStudyQueueMode(match.queue_mode);
  const insertCredit = db.prepare(
    'INSERT OR IGNORE INTO blind_credits (match_id, hero, blind_set_id, stage_index) VALUES (:match_id, :hero, :blind_set_id, :stage_index)'
  );

  // Two lookups per slot now (fixed 2026-09-24, same split as the POST
  // path): sensStage answers "what sens was this hero at" (any mode, DF-
  // aware via sensStageFor); creditStage answers "does this match count for
  // the study" (Competitive only, via findStageForRecredit — itself DF-gated
  // now too). primaryStage below drives the credit bookkeeping
  // (blind_trial/blind_set_id/stage_index); primarySensStage drives the
  // dpi/sens/curve facts stamped onto the match row.
  //
  // Only slot 0 (the starting hero) is ever looked up for credit at all —
  // fixed 2026-09-24, same rule as the POST insert path above. Before this,
  // every slot got its own creditStage lookup and could insert a credit;
  // now a switched-to hero (i > 0) only ever gets its match_heroes.sens kept
  // current, never a blind_credits row.
  let primaryStage: ReturnType<typeof findActiveStage> | undefined;
  let primarySensStage: ReturnType<typeof sensStageFor> | undefined;
  const touchedSets = new Set<number>(oldCredits.map(c => c.blind_set_id));
  // Which slot is looked up for credit follows the play-time rule
  // (creditHeroFor above) — without this, any roster edit would hand the
  // credit straight back to the starting hero.
  const creditHero = creditHeroFor(db, matchId, match.hero);
  const creditIdx = creditHero === null ? -1 : heroSlots.findIndex(s => s.hero === creditHero);
  heroSlots.forEach((slot, i) => {
    const sensStage = sensStageFor(db, slot.hero);
    if (i === 0) primarySensStage = sensStage;
    if (i === creditIdx) {
      const creditStage = findStageForRecredit(db, slot.hero, isCompetitive, oldCreditByHero.get(slot.hero));
      primaryStage = creditStage;
      if (creditStage) {
        const { changes } = insertCredit.run({ match_id: matchId, hero: slot.hero, blind_set_id: creditStage.setId, stage_index: creditStage.stageIdx });
        if (changes > 0) touchedSets.add(creditStage.setId);
      }
    }
    if (i === 0) return;
    // Slot 1's match_heroes.sens mirrors matches.sens below instead (honoring
    // `sensProvided` — an explicit sens in this same request beats a
    // recomputed stage for the primary hero). Slots 2/3 have no such manual-
    // override concept on a roster edit, so the hero's real active-stage sens
    // is authoritative here whenever one exists, same priority as the POST
    // insert path — and, same as that path, not gated on isCompetitive.
    if (sensStage) {
      db.prepare('UPDATE match_heroes SET sens = :sens WHERE match_id = :id AND slot = :slot')
        .run({ id: matchId, slot: i + 1, sens: sensStage.sens });
    }
  });

  // Re-derive active for every set this edit touched, including the ones it
  // took a credit AWAY from — correcting a hero, or flipping a match to QP,
  // can drop a finished set back under target, and the flag has to be able to
  // move in that direction too. Done after the loop rather than inside it so
  // reopening one set can't change which stage a later slot resolves to
  // mid-pass.
  for (const setId of touchedSets) syncSetActive(db, setId);

  // Keep the match row's own stage bookkeeping (the "stage N" badge, and the
  // blind_set_id/stage_index the by-stage rows key off of) in sync with the
  // primary hero's recomputed credit.
  db.prepare('UPDATE matches SET blind_trial = :bt, blind_set_id = :sid, stage_index = :si WHERE id = :id')
    .run({ id: matchId, bt: primaryStage ? 1 : 0, sid: primaryStage?.setId ?? null, si: primaryStage?.stageIdx ?? null });
  // dpi/sens/curve below use primarySensStage, not primaryStage — these are
  // "what was the hero at" facts (mode-agnostic), while primaryStage above
  // is the "does this count" credit (Competitive-only). A QP edit on a
  // tested hero must still show/stamp the real current sens even though
  // primaryStage is undefined and blind_trial stays 0.
  if (primarySensStage && !sensProvided) {
    db.prepare('UPDATE matches SET dpi = :dpi, sens = :sens WHERE id = :id')
      .run({ id: matchId, dpi: primarySensStage.dpi, sens: primarySensStage.sens });
    db.prepare('UPDATE match_heroes SET sens = :sens WHERE match_id = :id AND slot = 1')
      .run({ id: matchId, sens: primarySensStage.sens });
  }
  // Same priority as dpi/sens above: a set's phase-wide curve_enabled flag
  // overrides whatever was recorded before, whenever a set actually governs
  // this match after the edit. No "provided" exception (unlike sens) — curve
  // fields are never sent as part of a roster/queue_mode edit, only ever
  // corrected directly via their own EDITABLE fields, so there's no risk of
  // clobbering a value this same request just set on purpose.
  //
  // curve_growth_rate/curve_midpoint/curve_motivity go null here too, same
  // reason and same date as the POST insert above — the Jump-curve params
  // they'd otherwise re-stamp no longer describe Sean's real config now that
  // he's on a LUT. curve_lut is re-stamped on the same rule the POST uses:
  // the live table when one is on file and this stage says acceleration was
  // on, null otherwise.
  if (primarySensStage) {
    const lut = primarySensStage.curveEnabled ? getCurveParams(db).lutPoints : null;
    db.prepare('UPDATE matches SET curve_enabled = :ce, curve_growth_rate = :cgr, curve_midpoint = :cm, curve_motivity = :cmot, curve_lut = :clut WHERE id = :id')
      .run({
        id: matchId, ce: primarySensStage.curveEnabled ? 1 : 0,
        cgr: null, cm: null, cmot: null,
        clut: lut ? JSON.stringify(lut) : null,
      });
  }
}

// A single match's full row — added for MatchEditDrawer.tsx's sens/leaver
// controls, which need fields (leaver, leaver_side, sens, blind_trial) that
// the list route's TrendPoint-shaped chart data never carried. Plain
// SELECT *, same as the list route above.
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
  const creditedHeroes = new Set(
    (db.prepare('SELECT hero FROM blind_credits WHERE match_id = :id').all({ id: req.params.id }) as { hero: string }[])
      .map(r => r.hero)
  );
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

// Same last-5 map history as /:id/map-history, but keyed on map NAME instead
// of an existing match — Prematch's voting chips need the strip before any
// match has been logged, so there's no id to hang it off. Batched
// (?maps=A,B,C) so a full set of voting picks costs one request, not three.
// Rows come back oldest-first to match the by-id route's shape.
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

router.put('/:id', (req: Request, res: Response) => {
  const db = getDb();
  const fields = EDITABLE.filter(k => k in req.body);
  const heroesProvided = Array.isArray(req.body.heroes);
  const heroSensProvided = !!(req.body.heroSens && typeof req.body.heroSens === 'object');
  const deathsProvided = Array.isArray(req.body.match_deaths);
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
  //
  // The active flag isn't derived at read time, though, so it needs an
  // explicit nudge: read the affected set ids BEFORE the cascade takes the
  // rows away, then re-derive each one after. Without this a deletion out of
  // a finished set leaves it short of target and still retired, which is the
  // dead end set 86 (Reaper) sat in — unadvanceable and uncreditable.
  const affectedSets = db.prepare('SELECT DISTINCT blind_set_id FROM blind_credits WHERE match_id = :id')
    .all({ id: matchId }) as { blind_set_id: number }[];
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM matches WHERE id = :id').run({ id: matchId });
    for (const { blind_set_id } of affectedSets) syncSetActive(db, blind_set_id);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }

  res.json({ ok: true });
});

export default router;
