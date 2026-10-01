// One-off recompute: re-credit study matches under the 2026-10-01 rules
// (lib/credits.ts) — minutes for every hero with >= 1 minute, the game for
// every hero with >= 1/3 of the match. Replaces the 2026-09-24 2/3 rule.
//
// It does NOT carry its own copy of the rule. Each match goes through
// matches.ts's applyPlayTimeCredit, the same function the Aim Stats save
// calls, so what this writes is by construction what the app would have
// written had the rules been live. A hero that already held a credit keeps its
// exact set and stage; a hero credited for the first time lands on the stage
// its logged sens says it was on (findStageForRecredit).
//
// Usage (from server/, DB chosen by OVERWATCH_DB_PATH):
//   tsx --experimental-sqlite src/scripts/recomputeMinutesCredits.ts [--since 2026-09-24] [--before 2026-09-24]
//        DRY RUN: copies the DB to a scratch file, recomputes there, prints
//        the before/after. Never writes the live DB (not even the migration).
//   ... --apply
//        Writes the live DB. Take a backup first; refuses to run without
//        --backup <path> naming an existing file.
//   --before D  instead of --since: simulate the rules on matches BEFORE D
//        (dry run only; used to report how many older matches would change).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DatabaseSync } from 'node:sqlite';
import { DB_PATH, getDb } from '../db/schema';
import { applyPlayTimeCredit } from '../routes/matches';
import {
  stagesOf, blockStateOf, blockStateOfStage, liveStageIndex, gamesOnStageOf, isSetComplete,
} from '../routes/blind';

type Db = ReturnType<typeof getDb>;
const arg = (n: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const APPLY = process.argv.includes('--apply');
const SINCE = arg('--since');
const BEFORE = arg('--before');
if (APPLY && BEFORE) { console.error('--before is dry-run only'); process.exit(2); }
const since = SINCE ?? (BEFORE ? undefined : '2026-09-24');

interface CreditRow { match_id: number; hero: string; blind_set_id: number; stage_index: number; counts_result: number; counts_minutes: number }
const keyOf = (r: { match_id: number; hero: string }) => `${r.match_id}|${r.hero}`;
const fmt = (r?: CreditRow) => r ? `set ${r.blind_set_id}/stage ${r.stage_index} result=${r.counts_result} min=${r.counts_minutes}` : '-';

function creditRows(db: Db): CreditRow[] {
  return db.prepare('SELECT match_id, hero, blind_set_id, stage_index, counts_result, counts_minutes FROM blind_credits ORDER BY match_id, hero').all() as unknown as CreditRow[];
}
function matchCols(db: Db) {
  return new Map((db.prepare('SELECT id, blind_trial, blind_set_id, stage_index FROM matches').all() as any[]).map(r => [r.id as number, r]));
}

interface SetState {
  id: number; hero: string | null; active: number; completed: boolean;
  closedBlocks: number; openMinutes: number; curStage: number; gamesOnCurStage: number;
  stageBlocks: Record<number, number>; stageWL: Record<number, string>;
}
function setStates(db: Db, ids: number[]): Map<number, SetState> {
  const out = new Map<number, SetState>();
  for (const id of ids) {
    const set = db.prepare('SELECT id, hero, active, chunk_size, cur_rel, batch_size FROM blind_stage_sets WHERE id = :id').get({ id }) as any;
    if (!set) continue;
    const stages = stagesOf(db, id);
    const whole = blockStateOf(db, id);
    const cur = liveStageIndex(db, set, stages.length);
    const stageBlocks: Record<number, number> = {}, stageWL: Record<number, string> = {};
    for (const st of stages) {
      stageBlocks[st.stage_index] = blockStateOfStage(db, id, st.stage_index).closedBlocks;
      const wl = db.prepare(`
        SELECT SUM(m.win) w, COUNT(*) n FROM blind_credits bc JOIN matches m ON m.id = bc.match_id
        WHERE bc.blind_set_id = :id AND bc.stage_index = :si AND bc.counts_result = 1 AND COALESCE(m.queue_mode,'comp_role') != 'qp_role'
      `).get({ id, si: st.stage_index }) as { w: number | null; n: number };
      stageWL[st.stage_index] = `${wl.w ?? 0}-${wl.n - (wl.w ?? 0)}`;
    }
    out.set(id, {
      id, hero: set.hero, active: set.active, completed: isSetComplete(db, id),
      closedBlocks: whole.closedBlocks, openMinutes: Math.round(whole.openMinutes * 100) / 100,
      curStage: cur, gamesOnCurStage: gamesOnStageOf(db, id, cur), stageBlocks, stageWL,
    });
  }
  return out;
}

function main() {
  const livePath = DB_PATH;
  let db: Db;
  let scratch: string | null = null;
  if (APPLY) {
    const backup = arg('--backup');
    if (!backup || !fs.existsSync(backup)) { console.error('--apply needs --backup <existing backup file>'); process.exit(2); }
    console.log(`APPLY on ${livePath} (backup: ${backup})`);
    db = getDb(livePath);
  } else {
    scratch = path.join(os.tmpdir(), `ow-recompute-dry-${Date.now()}.db`);
    const src = new DatabaseSync(livePath, { readOnly: true });
    src.exec(`VACUUM INTO '${scratch}'`);
    src.close();
    console.log(`DRY RUN — recomputing on a scratch copy (${scratch}); live DB untouched.`);
    db = getDb(scratch);
  }

  const where = BEFORE ? `m.date < '${BEFORE}'` : `m.date >= '${since}'`;
  // Study matches only (QP never feeds the test) that either already hold a
  // credit or have per-hero minutes on file. A match with neither has nothing
  // to recompute.
  const ids = (db.prepare(`
    SELECT m.id FROM matches m
    WHERE ${where} AND COALESCE(m.queue_mode,'comp_role') != 'qp_role'
      AND (EXISTS (SELECT 1 FROM blind_credits bc WHERE bc.match_id = m.id)
        OR EXISTS (SELECT 1 FROM aim_stats_heroes a WHERE a.match_id = m.id))
    ORDER BY m.created_at, m.id
  `).all() as { id: number }[]).map(r => r.id);

  const beforeCredits = creditRows(db), beforeCols = matchCols(db);
  const watchSets = (db.prepare('SELECT id FROM blind_stage_sets WHERE active = 1').all() as { id: number }[]).map(r => r.id);
  const beforeSets = setStates(db, watchSets);

  db.exec('BEGIN');
  try {
    for (const id of ids) applyPlayTimeCredit(db, id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }

  const afterCredits = creditRows(db), afterCols = matchCols(db);
  const touchedSetIds = new Set<number>(watchSets);
  for (const r of [...beforeCredits, ...afterCredits]) touchedSetIds.add(r.blind_set_id);
  const afterSets = setStates(db, [...touchedSetIds]);

  const bm = new Map(beforeCredits.map(r => [keyOf(r), r])), am = new Map(afterCredits.map(r => [keyOf(r), r]));
  const inScope = new Set(ids);
  const inserted: CreditRow[] = [], removed: CreditRow[] = [], changed: [CreditRow, CreditRow][] = [];
  for (const [k, a] of am) { const b = bm.get(k); if (!b) inserted.push(a); else if (fmt(a) !== fmt(b)) changed.push([b, a]); }
  for (const [k, b] of bm) if (!am.has(k)) removed.push(b);

  console.log(`\nMatches recomputed: ${ids.length} (${BEFORE ? `before ${BEFORE}` : `since ${since}`})`);
  console.log(`\n== Credit rows INSERTED (${inserted.length}) ==`);
  for (const r of inserted) console.log(`  match ${r.match_id}  ${r.hero}: ${fmt(r)}`);
  console.log(`\n== Credit rows CHANGED (${changed.length}) ==`);
  for (const [b, a] of changed) console.log(`  match ${a.match_id}  ${a.hero}: ${fmt(b)}  ->  ${fmt(a)}`);
  console.log(`\n== Credit rows REMOVED (${removed.length}) ==`);
  for (const r of removed) console.log(`  match ${r.match_id}  ${r.hero}: ${fmt(r)}`);
  const colChanges = [...afterCols].filter(([id, a]) => { const b = beforeCols.get(id); return b && (b.blind_trial !== a.blind_trial || b.blind_set_id !== a.blind_set_id || b.stage_index !== a.stage_index); });
  console.log(`\n== matches.blind_trial/blind_set_id/stage_index CHANGED (${colChanges.length}) ==`);
  for (const [id, a] of colChanges) { const b = beforeCols.get(id); console.log(`  match ${id}: trial ${b.blind_trial} set ${b.blind_set_id} stage ${b.stage_index}  ->  trial ${a.blind_trial} set ${a.blind_set_id} stage ${a.stage_index}`); }

  let flips = 0, closures = 0, completions = 0, deactivated = 0;
  console.log('\n== Per-set before -> after (active sets + any set with a changed row) ==');
  for (const id of [...touchedSetIds].sort((x, y) => x - y)) {
    const b = beforeSets.get(id) ?? setStates(db, [id]).get(id)!, a = afterSets.get(id)!;
    const changedRows = [...inserted, ...removed, ...changed.map(c => c[1])].some(r => r.blind_set_id === id) || changed.some(c => c[0].blind_set_id === id);
    if (!changedRows && !beforeSets.has(id)) continue;
    const flip = b.curStage !== a.curStage, closed = a.closedBlocks !== b.closedBlocks;
    if (flip) flips++; if (closed) closures++; if (!b.completed && a.completed) completions++; if (b.active && !a.active) deactivated++;
    console.log(`  set ${id} ${a.hero ?? '(ad hoc)'}${changedRows ? '' : '  [no row changes]'}`);
    console.log(`     openMinutes ${b.openMinutes} -> ${a.openMinutes}   closedBlocks ${b.closedBlocks} -> ${a.closedBlocks}${closed ? '   <== BLOCK COUNT CHANGED' : ''}`);
    console.log(`     current stage ${b.curStage} -> ${a.curStage}${flip ? '   <== STAGE FLIP' : ''}   games_on_stage(current) ${b.gamesOnCurStage} -> ${a.gamesOnCurStage}   active ${b.active} -> ${a.active}   completed ${b.completed} -> ${a.completed}`);
    for (const si of Object.keys(a.stageBlocks)) {
      console.log(`     stage ${si}: blocks ${b.stageBlocks[+si]} -> ${a.stageBlocks[+si]}   W-L ${b.stageWL[+si]} -> ${a.stageWL[+si]}`);
    }
  }
  console.log(`\nSUMMARY: stage flips=${flips}  sets whose closed-block count changed=${closures}  sets newly complete=${completions}  sets deactivated=${deactivated}  inserted=${inserted.length} changed=${changed.length} removed=${removed.length}  (in-scope credit rows touched: ${[...inserted, ...removed].filter(r => inScope.has(r.match_id)).length + changed.length})`);
  if (scratch) { db.close(); for (const s of ['', '-wal', '-shm']) fs.rmSync(scratch + s, { force: true }); }
}
main();
