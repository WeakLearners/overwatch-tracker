import { getDb } from '../db/schema';
import { getCurveParams } from '../lib/curveParams';
import { syncSetActive, liveStageIndex, stagesOf } from '../routes/blind';
import { isStudyQueueMode, LOCKED_DPI } from '../lib/blind';
import { isDfHero, dfSensForHero } from '../lib/df';
import { creditFlagsFor, type CreditFlags } from '../lib/credits';
import type { ExperimentHooks, SensAssignment } from '../lib/experimentHooks';

// The sensitivity-study controller: the one implementation of ExperimentHooks
// (lib/experimentHooks.ts). Everything that knows about stage-test sets,
// blind_credits and play-time credit lives here, moved out of routes/matches.ts
// unchanged (Stage 1.5 slice 4, blocker B2). The tracker calls it only through
// the hooks, so the tracker still saves matches when this module is absent.

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
  loggedAt?: { sens: number | null; createdAt: string },
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

  // A hero that already holds a credit on this match keeps that exact set and
  // stage, even when the set is still active and has since moved on to a
  // different stage: correcting an old match must never move it onto
  // today's stage (2026-10-01 rules, item C). Only a set that no longer
  // exists falls through.
  if (priorCredit) {
    const set = db.prepare('SELECT id, in_game_sens, curve_enabled FROM blind_stage_sets WHERE id = :id')
      .get({ id: priorCredit.blind_set_id }) as { id: number; in_game_sens: number; curve_enabled: number } | undefined;
    const stage = set && db.prepare('SELECT dpi, sens FROM blind_stages WHERE set_id = :sid AND stage_index = :si')
      .get({ sid: set.id, si: priorCredit.stage_index }) as { dpi: number; sens: number | null } | undefined;
    if (set && stage) {
      return {
        setId: set.id, stageIdx: priorCredit.stage_index, dpi: stage.dpi, sens: stage.sens ?? set.in_game_sens,
        curveEnabled: !!set.curve_enabled,
      };
    }
  }

  const active = findActiveStage(db, hero);
  if (!active) return undefined;
  if (!loggedAt) return active;

  // A NEW credit on a match that was logged earlier (the Aim Stats form saved
  // later, giving a hero its minutes for the first time): the hero's set must
  // be credited at the stage it was on WHEN THE MATCH WAS LOGGED, not at
  // today's. match_heroes.sens records the sens actually played — the POST
  // path stamps each hero's own stage sens there — so the stage is the one
  // whose sens equals it. Strict on purpose: no sens, no unique match, or a
  // match older than the set itself gets no credit, rather than being pulled
  // onto whatever stage the set is on now.
  const set = db.prepare('SELECT created_at, in_game_sens FROM blind_stage_sets WHERE id = :id')
    .get({ id: active.setId }) as { created_at: string; in_game_sens: number } | undefined;
  if (!set || loggedAt.sens == null || loggedAt.createdAt < set.created_at) return undefined;
  const stages = db.prepare('SELECT stage_index, dpi, sens FROM blind_stages WHERE set_id = :sid')
    .all({ sid: active.setId }) as { stage_index: number; dpi: number; sens: number | null }[];
  const hits = stages.filter(st => Math.abs((st.sens ?? set.in_game_sens) - (loggedAt.sens as number)) < 1e-6);
  if (hits.length !== 1) return undefined;
  return {
    setId: active.setId, stageIdx: hits[0].stage_index, dpi: hits[0].dpi, sens: hits[0].sens ?? set.in_game_sens,
    curveEnabled: active.curveEnabled,
  };
}

// Which heroes earn what from this match — the 2026-10-01 rules, owned by
// lib/credits.ts (creditFlagsFor): every hero with >= 1 minute counts its
// minutes toward its own test's block clock, and every hero with >= 1/3 of the
// match's play time also takes the match's win/loss as a game. Replaces the
// 2026-09-24 pair (one hero with >= 2/3 got the credit; nobody if none did).
// `roster`, when given, limits it to heroes still on the match's roster (a
// roster edit can drop a hero whose minutes are still on file). Before the
// Aim Stats form is saved there are no minutes yet, so the slot-1 hero holds
// the credit — the normal state at insert time. A Designated Fallback hero
// still ends up with no credit, since findStageForRecredit refuses every DF.
function desiredCredits(
  db: ReturnType<typeof getDb>, matchId: number | string, slot1Hero: string, roster?: string[],
): CreditFlags[] {
  let rows = db.prepare('SELECT hero, duration_min FROM aim_stats_heroes WHERE match_id = :id AND duration_min > 0')
    .all({ id: matchId }) as { hero: string; duration_min: number }[];
  if (roster) rows = rows.filter(r => roster.includes(r.hero));
  return creditFlagsFor(rows, slot1Hero);
}

const INSERT_CREDIT_SQL =
  'INSERT OR IGNORE INTO blind_credits (match_id, hero, blind_set_id, stage_index, counts_result, counts_minutes) VALUES (:match_id, :hero, :sid, :si, :cr, :cm)';

// matches.blind_trial / blind_set_id / stage_index are the match row's own
// summary of its credits (read by the "stage N" badge and by the analysis's
// blind-trial flag). With one row per qualifying hero they now point at the
// slot-1 hero's credit when it has one, else the first hero that earned the
// game, else any credit. blind_trial is 1 whenever the match holds any credit.
function syncMatchStageColumns(db: ReturnType<typeof getDb>, matchId: number | string) {
  const pick = db.prepare(`
    SELECT bc.blind_set_id, bc.stage_index FROM blind_credits bc
    LEFT JOIN match_heroes mh ON mh.match_id = bc.match_id AND mh.hero = bc.hero
    WHERE bc.match_id = :id
    ORDER BY (mh.slot = 1) DESC, bc.counts_result DESC, COALESCE(mh.slot, 99), bc.hero
    LIMIT 1
  `).get({ id: matchId }) as { blind_set_id: number; stage_index: number } | undefined;
  db.prepare('UPDATE matches SET blind_trial = :bt, blind_set_id = :sid, stage_index = :si WHERE id = :id')
    .run({ id: matchId, bt: pick ? 1 : 0, sid: pick?.blind_set_id ?? null, si: pick?.stage_index ?? null });
}

// Re-applies the credit rules after the Aim Stats form saves (aim.ts).
// Narrower than syncStageCredits on purpose: it moves only credits, and
// never re-stamps sens/dpi/curve. An old match's details can be corrected
// long after its stage has moved on, and those facts describe what was
// played then. A hero that already held a credit keeps its exact set and
// stage (only the flags are re-derived), so a correction can't shift an old
// match onto today's stage; a hero credited for the first time lands on the
// stage its sens says it was played at (findStageForRecredit's loggedAt).
// Safe to call repeatedly — it converges to the same rows.
export function applyPlayTimeCredit(db: ReturnType<typeof getDb>, matchId: number | string) {
  const match = db.prepare('SELECT hero, queue_mode, created_at FROM matches WHERE id = :id')
    .get({ id: matchId }) as { hero: string; queue_mode: string; created_at: string } | undefined;
  if (!match) return;
  const oldCredits = db.prepare('SELECT hero, blind_set_id, stage_index FROM blind_credits WHERE match_id = :id')
    .all({ id: matchId }) as { hero: string; blind_set_id: number; stage_index: number }[];
  const oldByHero = new Map(oldCredits.map(c => [c.hero, c]));
  const sensByHero = new Map(
    (db.prepare('SELECT hero, sens FROM match_heroes WHERE match_id = :id').all({ id: matchId }) as { hero: string; sens: number | null }[])
      .map(r => [r.hero, r.sens]),
  );
  const isComp = isStudyQueueMode(match.queue_mode);

  db.prepare('DELETE FROM blind_credits WHERE match_id = :id').run({ id: matchId });
  const touched = new Set(oldCredits.map(c => c.blind_set_id));
  const insert = db.prepare(INSERT_CREDIT_SQL);
  for (const d of desiredCredits(db, matchId, match.hero)) {
    const stage = findStageForRecredit(db, d.hero, isComp, oldByHero.get(d.hero),
      { sens: sensByHero.get(d.hero) ?? null, createdAt: match.created_at });
    if (!stage) continue;
    insert.run({ match_id: matchId, hero: d.hero, sid: stage.setId, si: stage.stageIdx, cr: d.countsResult, cm: d.countsMinutes });
    touched.add(stage.setId);
  }
  syncMatchStageColumns(db, matchId);
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
  const insertCredit = db.prepare(INSERT_CREDIT_SQL);

  // Two lookups per slot (fixed 2026-09-24, same split as the POST path):
  // sensStage answers "what sens was this hero at" (any mode, DF-aware via
  // sensStageFor); findStageForRecredit answers "does this match count for
  // the study" (Competitive only, itself DF-gated). primarySensStage drives
  // the dpi/sens/curve facts stamped onto the match row; the credit rows
  // themselves drive blind_trial/blind_set_id/stage_index (below).
  //
  // Which heroes earn a credit follows the 2026-10-01 rules (desiredCredits
  // above): minutes for every hero with >= 1 minute, the game for every hero
  // with >= 1/3 of the match. Without this, any roster edit would hand the
  // credit straight back to the starting hero alone.
  let primarySensStage: ReturnType<typeof sensStageFor> | undefined;
  const touchedSets = new Set<number>(oldCredits.map(c => c.blind_set_id));
  const desired = new Map(desiredCredits(db, matchId, match.hero, heroSlots.map(s => s.hero)).map(d => [d.hero, d]));
  heroSlots.forEach((slot, i) => {
    const sensStage = sensStageFor(db, slot.hero);
    if (i === 0) primarySensStage = sensStage;
    const want = desired.get(slot.hero);
    if (want) {
      const creditStage = findStageForRecredit(db, slot.hero, isCompetitive, oldCreditByHero.get(slot.hero));
      if (creditStage) {
        const { changes } = insertCredit.run({
          match_id: matchId, hero: slot.hero, sid: creditStage.setId, si: creditStage.stageIdx,
          cr: want.countsResult, cm: want.countsMinutes,
        });
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
  // recomputed credits.
  syncMatchStageColumns(db, matchId);
  // dpi/sens/curve below use primarySensStage, not primaryStage — these are
  // "what was the hero at" facts (mode-agnostic), while the credit rows above
  // are the "does this count" answer (Competitive-only). A QP edit on a
  // tested hero must still show/stamp the real current sens even though
  // no credit is written and blind_trial stays 0.
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

export const experimentController: ExperimentHooks = {
  sensFor(db, hero, queueMode): SensAssignment | null {
    const st = sensStageFor(db, hero);
    if (!st) return null;
    // A Designated Fallback comes back without a setId: it records its own
    // fixed sens/dpi but never governs the curve flag and never earns credit.
    if (!('setId' in st)) return { dpi: st.dpi, sens: st.sens, curveEnabled: st.curveEnabled, governsCurve: false, credit: null };
    return {
      dpi: st.dpi, sens: st.sens, curveEnabled: st.curveEnabled, governsCurve: true,
      credit: isStudyQueueMode(queueMode) ? { setId: st.setId, stageIdx: st.stageIdx } : null,
    };
  },

  onMatchSaved(db, { matchId, hero, credit }) {
    if (!credit) return;
    // Guards against double-crediting (the (match_id, hero) PK means only the
    // first insert lands).
    const { changes } = db.prepare(
      'INSERT OR IGNORE INTO blind_credits (match_id, hero, blind_set_id, stage_index) VALUES (:match_id, :hero, :blind_set_id, :stage_index)'
    ).run({ match_id: matchId, hero, blind_set_id: credit.setId, stage_index: credit.stageIdx });
    if (changes === 0) return;
    // Multiple sets can be active at once (one per hero), so nothing else
    // retires a finished set. Retire it the moment every stage has its games,
    // or it would stay active forever and block a fresh test on this hero.
    syncSetActive(db, credit.setId);
  },

  onAimStatsSaved(db, matchId) { applyPlayTimeCredit(db, matchId); },

  onRosterEdited(db, matchId, opts) { syncStageCredits(db, matchId, opts.sensProvided); },

  beforeMatchDelete(db, matchId) {
    // Read the affected set ids BEFORE the cascade takes the rows away.
    return (db.prepare('SELECT DISTINCT blind_set_id FROM blind_credits WHERE match_id = :id')
      .all({ id: matchId }) as { blind_set_id: number }[]).map(r => r.blind_set_id);
  },

  afterMatchDelete(db, _matchId, token) {
    for (const setId of token as number[]) syncSetActive(db, setId);
  },

  creditedHeroes(db, matchId) {
    return (db.prepare('SELECT hero FROM blind_credits WHERE match_id = :id').all({ id: matchId }) as { hero: string }[])
      .map(r => r.hero);
  },
};
