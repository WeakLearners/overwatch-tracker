// Nightly sensitivity-study status report, posted to Slack.
//
// Run standalone (not through the Express app) via launchd, once a night
// (see com.sean.overwatch-sens-nightly-report.plist). Checks whether any
// matches were logged today; if none, exits quietly with no Slack post
// (low-noise by design — see projects/overwatch-sensitivity in the vault).
// If there was activity, posts a lightweight factual status: which heroes
// got new matches today, each active stage-trial set's current
// stage/batch progress and whether it's due to advance, and any matches
// today missing an accuracy entry.
//
// Deliberately reads the DB directly rather than hitting the HTTP API —
// this runs from launchd, independent of whether the dev server happens to
// be up, and getDb() here is the same schema module the server itself uses
// (same DB_PATH resolution, same migrations already applied by the running
// server), so there's no drift between what this script sees and what the
// app sees.
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(__dirname, '../../.env') });

import { getDb } from '../db/schema';
import {
  stagePointsFor, readBracket, describeBracket, stageSamplesFor,
  baselineFor, describeBaseline,
} from './nightlyAnalysis';

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;
// --dry-run prints the assembled report to stdout instead of posting it, so
// the output can be eyeballed without spending a real message on the channel.
const DRY_RUN = process.argv.includes('--dry-run');

// Local calendar date (matches.date is stored as local YYYY-MM-DD, not UTC —
// confirmed against live rows before writing this). Using UTC here would
// misfile any match played in the few hours around midnight.
function todayLocal(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export interface HeroMatchRow { match_id: number; hero: string; }
export interface ActiveSetRow {
  id: number; hero: string | null; phase: string | null;
  batch_size: number; cur_rel: number;
}
interface StageCountRow { n_stages: number; }

export interface StageStatus {
  hero: string | null;
  cur_rel: number;
  n_stages: number;
  gamesOnStage: number;
  totalGames: number;
  batchSize: number;
  completed: boolean;
  dueToAdvance: boolean;
}

// Independently re-derives "which stage is this set on, and how many games
// into it" from blind_credits — the same question routes/blind.ts's /state
// endpoint answers via its own activeSets/gamesOnStageOf/totalGamesOf
// helpers. Deliberately a second, separate query path (see the module
// comment above) rather than importing blind.ts's helpers, so this script
// doesn't couple to the HTTP layer. See db/schema.test.ts-adjacent
// stage-progress-agreement test for a check that the two independent
// implementations actually agree.
export function computeStageStatus(db: ReturnType<typeof getDb>, set: ActiveSetRow): StageStatus {
  const { n_stages } = db.prepare(
    `SELECT COUNT(*) n_stages FROM blind_stages WHERE set_id = :id`
  ).get({ id: set.id }) as unknown as StageCountRow;
  const gamesOnStage = (db.prepare(
    `SELECT COUNT(*) n FROM blind_credits WHERE blind_set_id = :id AND stage_index = :si`
  ).get({ id: set.id, si: set.cur_rel }) as { n: number }).n;
  const totalGames = (db.prepare(
    `SELECT COUNT(*) n FROM blind_credits WHERE blind_set_id = :id`
  ).get({ id: set.id }) as { n: number }).n;
  const completed = totalGames >= set.batch_size * n_stages;
  const dueToAdvance = !completed && gamesOnStage >= set.batch_size;
  return { hero: set.hero, cur_rel: set.cur_rel, n_stages, gamesOnStage, totalGames, batchSize: set.batch_size, completed, dueToAdvance };
}

async function postToSlack(text: string): Promise<void> {
  if (DRY_RUN) {
    console.log('--- DRY RUN (not posted) ---');
    console.log(text);
    console.log('--- end ---');
    return;
  }
  if (!SLACK_WEBHOOK_URL) {
    console.error('SLACK_WEBHOOK_URL not set in server/.env — cannot post.');
    process.exitCode = 1;
    return;
  }
  const res = await fetch(SLACK_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`Slack post failed: ${res.status} ${res.statusText} ${body}`);
    process.exitCode = 1;
    return;
  }
  console.log('Posted to Slack.');
}

async function main() {
  const db = getDb();
  const today = todayLocal();

  // 1. Any activity today at all?
  const todaysHeroRows = db.prepare(`
    SELECT mh.match_id, mh.hero
    FROM match_heroes mh
    JOIN matches m ON m.id = mh.match_id
    WHERE m.date = :today
    ORDER BY mh.match_id, mh.slot
  `).all({ today }) as unknown as HeroMatchRow[];

  if (todaysHeroRows.length === 0) {
    console.log(`No matches logged for ${today} — skipping Slack post (low-noise).`);
    return;
  }

  const matchIdsToday = [...new Set(todaysHeroRows.map(r => r.match_id))];

  // 2. Per-hero new-match counts today (distinct match, so a mid-match
  // switch counts once per hero actually played, not once per match).
  const heroCounts = new Map<string, number>();
  for (const row of todaysHeroRows) {
    heroCounts.set(row.hero, (heroCounts.get(row.hero) ?? 0) + 1);
  }
  const heroCountLines = [...heroCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([hero, n]) => `${hero} ${n}`);

  // 3. Stage-trial status per active set — same source of truth as
  // blind.ts's /state endpoint (blind_credits, not the stale
  // games_on_stage column), reimplemented here as plain queries since this
  // script doesn't run through Express.
  const activeSets = db.prepare(`
    SELECT id, hero, phase, batch_size, cur_rel
    FROM blind_stage_sets WHERE active = 1 ORDER BY id
  `).all() as unknown as ActiveSetRow[];

  const stageLines: string[] = [];
  for (const set of activeSets) {
    const status = computeStageStatus(db, set);
    const label = status.hero ?? '(ad-hoc set)';
    const statusLabel = status.completed ? 'COMPLETED' : status.dueToAdvance ? 'DUE TO ADVANCE' : 'in progress';
    stageLines.push(
      `• ${label}: stage ${status.cur_rel}/${status.n_stages}, ${status.gamesOnStage}/${status.batchSize} games this stage — ${statusLabel}`
    );
  }

  // 3b. Bracket reads — the analytical core. For each active set, what does
  // the accuracy-vs-sens curve actually say? readBracket refuses to speak when
  // the sample is thin and never reports a direction when there's no interior
  // peak, so a quiet night reads as "unresolved", not as a finding.
  const bracketLines = activeSets.map(set => {
    const points = stagePointsFor(db, set.id);
    // Raw samples per stage, so a 2-stage A/B can be tested rather than just
    // ranked by mean.
    const samples: Record<number, number[]> = {};
    for (const p of points) samples[p.stage_index] = stageSamplesFor(db, set.id, p.stage_index);
    return describeBracket(set.hero, readBracket(points, samples));
  });

  // 3c. Today against each hero's own trailing baseline, so a day's accuracy
  // has something to mean. Only heroes actually played today.
  const baselineLines = [...heroCounts.keys()].map(hero =>
    describeBaseline(baselineFor(db, hero, today))
  );

  // 4. Anomalies: matches logged today for a hero with an active stage-trial
  // (or any hero, really) but no accuracy row in aim_stats_heroes yet.
  const missingAccRows = db.prepare(`
    SELECT mh.match_id, mh.hero
    FROM match_heroes mh
    JOIN matches m ON m.id = mh.match_id
    WHERE m.date = :today
      AND NOT EXISTS (
        SELECT 1 FROM aim_stats_heroes ash
        WHERE ash.match_id = mh.match_id AND ash.hero = mh.hero
      )
    ORDER BY mh.match_id
  `).all({ today }) as unknown as HeroMatchRow[];

  const anomalyLines = missingAccRows.map(r => `• match ${r.match_id} — ${r.hero}: no accuracy logged`);

  // 5. Assemble and post. Ordered analysis-first: what the study is learning
  // leads, and the raw activity/progress counts follow as supporting detail.
  // A report that opens with "6 matches logged" buries its own point.
  const lines: string[] = [];
  lines.push(`*Overwatch Sensitivity Study — nightly analysis, ${today}*`);
  lines.push('');

  lines.push('*Bracket reads — what the curves say:*');
  lines.push(...(bracketLines.length > 0 ? bracketLines : ['• no active sets to read.']));
  lines.push('');

  lines.push('*Today in context:*');
  lines.push(...baselineLines);
  lines.push('');

  // Header counts DISTINCT matches; the per-hero detail counts hero slots, and
  // a mid-match hero switch makes one match into two slots. Show both numbers
  // whenever they disagree, otherwise the per-hero list appears to sum to more
  // than the stated match total.
  const slotsToday = todaysHeroRows.length;
  const matchLabel = `${matchIdsToday.length} match${matchIdsToday.length === 1 ? '' : 'es'}`;
  const countLabel = slotsToday === matchIdsToday.length
    ? matchLabel
    : `${matchLabel} / ${slotsToday} hero slots`;
  lines.push(`*Activity:* ${countLabel} — ${heroCountLines.join(', ')}`);
  lines.push('');

  if (stageLines.length > 0) {
    lines.push('*Stage-trial progress:*');
    lines.push(...stageLines);
  } else {
    lines.push('*Stage-trial progress:* no active sets.');
  }
  if (anomalyLines.length > 0) {
    lines.push('');
    lines.push('*Data gaps:*');
    lines.push(...anomalyLines);
  }

  await postToSlack(lines.join('\n'));
}

// Guarded so importing this module (e.g. from a test, to reach
// computeStageStatus) doesn't also fire a real Slack post / DB open as a
// side effect of the import. tsx compiles this file as CommonJS
// (server/tsconfig.json), so require.main is the direct entrypoint check —
// true only when this file is executed directly, not when require()'d.
if (require.main === module) {
  main().catch(err => {
    console.error('Nightly report failed:', err);
    process.exitCode = 1;
  });
}
