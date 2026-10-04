import { Router, Request, Response } from 'express';
import {
  computeHotHand,
  computePerformanceOutcome,
  computeQueueSwitchTax,
  computeCritAccuracy,
  computeKillSecure,
  computeFieldSplit,
  PerfFeatureKey,
} from '../lib/statsInsights';
import { studyTagFor } from '../lab/studyTags';
import { withReplica } from '../lab/replicaCache';

// Lab side of the stats routes (split plan slice 5c). The inferential layer:
// GET /split (field vs win rate / accuracy) and GET /insights (hot hand,
// performance vs outcome, switch tax, crit and kill-secure splits)
// all computed by lib/statsInsights.ts. They read the shared
// lab replica (lab/replicaCache.ts), never db/schema. routes/stats.ts keeps the
// descriptive endpoints and composes this router, so URLs do not change.
const router = Router();

function whereClause(q: Record<string, string>): [string, Record<string, string>] {
  const clauses: string[] = [];
  const params: Record<string, string> = {};
  if (q.from) { clauses.push('date >= :from'); params.from = q.from; }
  if (q.to) { clauses.push('date <= :to'); params.to = q.to; }
  if (q.role) { clauses.push('role = :role'); params.role = q.role; }
  if (q.queue_mode) { clauses.push('queue_mode = :queue_mode'); params.queue_mode = q.queue_mode; }
  return [clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params];
}

// GET /api/stats/split?by=<registry field id>[&from=&to=&role=&queue_mode=]
// The generic answer to "does this captured field move with anything" for
// any field with an entry in lab/studyTags.ts (2026-09-24; the tags moved from
// the tracker's field registry to the lab in split-plan slice 5b). `by` is
// looked up in that table; only a tagged field is accepted, and the actual SQL
// column comes from the tag's own `column` — never the raw query string.
// Same optional filters as the rest of this file (whereClause above).
router.get('/split', withReplica((req: Request, res: Response, db) => {
  const by = (req.query.by as string) ?? '';
  const tag = studyTagFor(by);
  if (!tag) {
    res.status(400).json({
      error: `'${by}' is not a whitelisted study field. Only a field with an entry in lab/studyTags.ts can be split.`,
    });
    return;
  }
  const [where, params] = whereClause(req.query as Record<string, string>);
  res.json(computeFieldSplit(db, tag.column, tag.metrics, where, params));
}));

// ── Trends insights ──────────────────────────────────────────────────────────
// Pool of up to 10 one-sentence factoids for the Trends section's 4 random
// cards, drawn from the three analyses above. Only reliable splits (enough
// games on both sides) contribute a factoid — an unreliable one is silently
// dropped from the pool rather than shown as noise. The client draws 4
// distinct factoids from whatever the pool has on every page load.
router.get('/insights', withReplica((_req: Request, res: Response, db) => {
  const hotHand = computeHotHand(db);
  const perf = computePerformanceOutcome(db);
  const queueSwitch = computeQueueSwitchTax(db);
  const critAcc = computeCritAccuracy(db);
  const killSecure = computeKillSecure(db);

  // Each factoid is a list of parts rather than one string, so the client can
  // color just the stat numbers (green = the better outcome, red = the worse
  // one) without tinting the whole sentence.
  type Color = 'good' | 'bad';
  type Part = { text: string; color?: Color };
  const t = (text: string): Part => ({ text });
  const c = (text: string, color: Color): Part => ({ text, color });
  const factoids: { id: string; category: string; parts: Part[] }[] = [];

  if (hotHand.reliable && hotHand.gap !== null) {
    if (Math.abs(hotHand.gap) < 3) {
      // No real difference — coloring one side over the other would misstate
      // the finding, so both numbers stay neutral.
      factoids.push({
        id: 'hot-hand', category: 'Hot Hand',
        parts: [
          t(`Wins and losses don't carry over — about the same win rate whether the last game was a win (${hotHand.after_win.win_rate}%) or a loss (${hotHand.after_loss.win_rate}%).`),
        ],
      });
    } else if (hotHand.gap > 0) {
      factoids.push({
        id: 'hot-hand', category: 'Hot Hand',
        parts: [
          t('Momentum carries over: '), c(`${hotHand.after_win.win_rate}%`, 'good'),
          t(' win rate right after a win, vs. '), c(`${hotHand.after_loss.win_rate}%`, 'bad'),
          t(` right after a loss (+${hotHand.gap}pp).`),
        ],
      });
    } else {
      factoids.push({
        id: 'hot-hand', category: 'Hot Hand',
        parts: [
          t('Losses tend to compound: '), c(`${hotHand.after_loss.win_rate}%`, 'good'),
          t(' win rate right after a loss, vs. '), c(`${hotHand.after_win.win_rate}%`, 'bad'),
          t(` right after a win (${hotHand.gap}pp).`),
        ],
      });
    }
  }

  const PERF_UNIT: Record<PerfFeatureKey, string> = { overall_acc: '%', dmg10: '', elims10: '', fb10: '' };
  for (const f of perf.features) {
    if (!f.reliable || f.gap === null || f.baseline === null) continue;
    const aboveIsBetter = f.gap > 0;
    factoids.push({
      id: `perf-${f.key}`,
      category: `Performance · ${f.label}`,
      parts: [
        t(`${f.label} tracks winning ${Math.abs(f.gap) >= 30 ? 'hardest' : 'clearly'}: `),
        c(`${f.aboveWinRate}%`, aboveIsBetter ? 'good' : 'bad'),
        t(` win rate above your average of ${f.baseline}${PERF_UNIT[f.key as PerfFeatureKey]}, vs. just `),
        c(`${f.belowWinRate}%`, aboveIsBetter ? 'bad' : 'good'),
        t(' below it.'),
      ],
    });
  }

  if (perf.mismatch?.reliable) {
    const m = perf.mismatch;
    factoids.push({
      id: 'perf-mismatch',
      category: 'Performance Mismatch',
      parts: [
        t('Played above your own average on most tracked stats and still lost '),
        c(`${m.played_well_loss_rate}%`, 'bad'),
        t(` of the time (${m.played_well_losses} of ${m.played_well_games}). Played below average and still won `),
        c(`${m.played_poor_win_rate}%`, 'good'),
        t(` of the time (${m.played_poor_wins} of ${m.played_poor_games}).`),
      ],
    });
  }

  if (queueSwitch.reliable && queueSwitch.gap !== null) {
    factoids.push({
      id: 'queue-switch-tax',
      category: 'Queue-Mode Switch',
      parts: [
        t('Win rate drops after switching queue modes mid-session: '),
        c(`${queueSwitch.switched.win_rate}%`, 'bad'),
        t(' vs. '), c(`${queueSwitch.same.win_rate}%`, 'good'),
        t(` when staying in the same mode (${queueSwitch.switched.games} vs. ${queueSwitch.same.games} games).`),
      ],
    });
  }

  if (critAcc.reliable && critAcc.gap !== null && critAcc.baseline !== null) {
    const aboveIsBetter = critAcc.gap > 0;
    factoids.push({
      id: 'crit-accuracy',
      category: 'Crit Accuracy',
      parts: [
        t(`Your average crit accuracy is ${critAcc.baseline}%. Games above that win `),
        c(`${critAcc.aboveWinRate}%`, aboveIsBetter ? 'good' : 'bad'),
        t(', games below win '),
        c(`${critAcc.belowWinRate}%`, aboveIsBetter ? 'bad' : 'good'),
        t(` (${critAcc.aboveGames}/${critAcc.belowGames} games) — LOWER accuracy wins more, likely because tougher fights demand more precision, not a target to chase.`),
      ],
    });
  }

  if (killSecure.reliable && killSecure.gap !== null && killSecure.baseline !== null) {
    const aboveIsBetter = killSecure.gap > 0;
    factoids.push({
      id: 'kill-secure',
      category: 'Kill-Secure Rate',
      parts: [
        t(`Your average kill-secure rate (final blows per elim) is ${Math.round(killSecure.baseline * 100)}%. Games above that win `),
        c(`${killSecure.aboveWinRate}%`, aboveIsBetter ? 'good' : 'bad'),
        t(', games below win '),
        c(`${killSecure.belowWinRate}%`, aboveIsBetter ? 'bad' : 'good'),
        t(` (${killSecure.aboveGames}/${killSecure.belowGames} games) — probably reflects solo-closing kills when the team isn't there, not a skill signal.`),
      ],
    });
  }

  res.json({ factoids });
}));

export default router;
