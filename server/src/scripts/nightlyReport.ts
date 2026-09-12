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

const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL;

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

interface HeroMatchRow { match_id: number; hero: string; }
interface ActiveSetRow {
  id: number; hero: string | null; phase: string | null;
  batch_size: number; cur_rel: number;
}
interface StageCountRow { n_stages: number; }

async function postToSlack(text: string): Promise<void> {
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
    .map(([hero, n]) => `• ${hero}: ${n} match${n === 1 ? '' : 'es'}`);

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
    const label = set.hero ?? '(ad-hoc set)';
    const status = completed ? 'COMPLETED' : dueToAdvance ? 'DUE TO ADVANCE' : 'in progress';
    stageLines.push(
      `• ${label}: stage ${set.cur_rel}/${n_stages}, ${gamesOnStage}/${set.batch_size} games this stage — ${status}`
    );
  }

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

  // 5. Assemble and post.
  const lines: string[] = [];
  lines.push(`*Overwatch Sensitivity Study — nightly status, ${today}*`);
  lines.push('');
  lines.push(`*New matches today (${matchIdsToday.length} match${matchIdsToday.length === 1 ? '' : 'es'}):*`);
  lines.push(...heroCountLines);
  lines.push('');
  if (stageLines.length > 0) {
    lines.push('*Stage-trial status (active sets):*');
    lines.push(...stageLines);
  } else {
    lines.push('*Stage-trial status:* no active sets.');
  }
  if (anomalyLines.length > 0) {
    lines.push('');
    lines.push('*Anomalies:*');
    lines.push(...anomalyLines);
  }

  await postToSlack(lines.join('\n'));
}

main().catch(err => {
  console.error('Nightly report failed:', err);
  process.exitCode = 1;
});
