// Tier 2: DB-backed tests for lib/statsInsights.ts's compute functions
// (computeHotHand, computePerformanceOutcome, computeQueueSwitchTax,
// computeCritAccuracy, computeKillSecure, computeDayHourWindow). These lived
// in stats.ts until the 2026-09-23 modularization slice moved them into
// their own module — no logic changed in that move, only location and this
// import path.
//
// Every fixture's expected values are computed by hand in the comment above
// it, not asserted against whatever the function happens to return, per this
// tier's whole reason for existing (see the bss.phase bug this suite's
// predecessor caught). Each of these six functions carries its own
// minimum-sample-size guard (all currently 8 or 10) — every function gets a
// test at n-1 (below threshold: not reliable) and at exactly n (boundary:
// reliable), not just an arbitrary large-n case.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb, closeDb } from '../db/schema';
import { insertMatch, insertAimStats } from '../db/fixtures';
import {
  computeHotHand,
  computePerformanceOutcome,
  computeQueueSwitchTax,
  computeCritAccuracy,
  computeKillSecure,
  computeDayHourWindow,
} from '../lib/statsInsights';

let tmpPath: string;
let db: ReturnType<typeof getDb>;

beforeEach(() => {
  tmpPath = path.join(os.tmpdir(), `overwatch-stats-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  db = getDb(tmpPath);
});

afterEach(() => {
  closeDb();
  for (const f of [tmpPath, `${tmpPath}-wal`, `${tmpPath}-shm`]) {
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }
});

// ── computeHotHand ───────────────────────────────────────────────────────────
describe('computeHotHand', () => {
  test('empty DB: no crash, no NaN, reliable false', () => {
    const r = computeHotHand(db);
    assert.equal(r.after_win.games, 0);
    assert.equal(r.after_loss.games, 0);
    assert.equal(r.after_win.win_rate, null);
    assert.equal(r.after_loss.win_rate, null);
    assert.equal(r.reliable, false);
    assert.equal(r.gap, null);
  });

  test('a single match has no "previous game" — same degenerate shape as empty', () => {
    insertMatch(db, { date: '2026-01-01', time: '00:00', hero: 'Ashe', role: 'DPS', win: 1 });
    const r = computeHotHand(db);
    assert.equal(r.after_win.games, 0);
    assert.equal(r.after_loss.games, 0);
    assert.equal(r.reliable, false);
  });

  test('below MIN_GAMES (10) on both sides: unreliable even though the pattern is clean', () => {
    // 5 games alternating win,loss,win,loss,win on one date/session.
    // prev-defined rows: i=1..4 -> after_win: i=1,3 (2 games); after_loss: i=2,4 (2 games).
    const wins = [1, 0, 1, 0, 1];
    wins.forEach((w, i) => insertMatch(db, { date: '2026-01-01', time: `00:${String(i).padStart(2, '0')}`, hero: 'Ashe', role: 'DPS', win: w as 0 | 1 }));
    const r = computeHotHand(db);
    assert.equal(r.after_win.games, 2);
    assert.equal(r.after_loss.games, 2);
    assert.equal(r.reliable, false);
    assert.equal(r.gap, null);
  });

  test('exactly at MIN_GAMES (10/10): reliable, with a hand-computed gap', () => {
    // 21 games, strictly alternating win,loss,win,loss,...,loss (win at even
    // index, loss at odd index). For i=1..20 (20 prev-defined games),
    // prev(i)=win(i-1) alternates too, giving exactly 10 after_win + 10
    // after_loss games. Because the sequence strictly alternates, every
    // after_win game's OWN result is a loss (0), and every after_loss game's
    // own result is a win (1) — so after_win_wr = 0%, after_loss_wr = 100%,
    // gap = -100.
    for (let i = 0; i <= 20; i++) {
      const win = (i % 2 === 0 ? 1 : 0) as 0 | 1;
      insertMatch(db, { date: '2026-01-01', time: `00:${String(i).padStart(2, '0')}`, hero: 'Ashe', role: 'DPS', win });
    }
    const r = computeHotHand(db);
    assert.equal(r.after_win.games, 10);
    assert.equal(r.after_loss.games, 10);
    assert.equal(r.after_win.win_rate, 0);
    assert.equal(r.after_loss.win_rate, 100);
    assert.equal(r.reliable, true);
    assert.equal(r.gap, -100);
  });

  test('LAG is partitioned by date — the first game of a new date never counts as "after" anything', () => {
    // Two separate one-game "days": neither has a predecessor, so both are
    // excluded from both buckets regardless of win/loss.
    insertMatch(db, { date: '2026-01-01', time: '00:00', hero: 'Ashe', role: 'DPS', win: 1 });
    insertMatch(db, { date: '2026-01-02', time: '00:00', hero: 'Ashe', role: 'DPS', win: 0 });
    const r = computeHotHand(db);
    assert.equal(r.after_win.games, 0);
    assert.equal(r.after_loss.games, 0);
  });
});

// ── computeQueueSwitchTax ────────────────────────────────────────────────────
describe('computeQueueSwitchTax', () => {
  test('empty DB: no crash, reliable false', () => {
    const r = computeQueueSwitchTax(db);
    assert.equal(r.same.games, 0);
    assert.equal(r.switched.games, 0);
    assert.equal(r.reliable, false);
    assert.equal(r.gap, null);
  });

  test('exactly at MIN_GAMES (10/10): reliable, with a hand-computed gap', () => {
    // 21 games, queue_mode in blocks of 2 (comp,comp,qp,qp,comp,comp,qp,qp,...)
    // so mode[i] = (floor(i/2) % 2 === 0) ? 'comp' : 'qp'. For i=1..20, the
    // same/switch transition type strictly alternates starting with "same"
    // at i=1 (comp,comp) — 10 same, 10 switch. win[i] = 1 for odd i (the
    // "same" games), 0 for even i>=2 (the "switch" games), so same_wr=100,
    // switch_wr=0, gap=100.
    for (let i = 0; i <= 20; i++) {
      const mode = Math.floor(i / 2) % 2 === 0 ? 'comp' : 'qp';
      const win = (i === 0 ? 1 : (i % 2 === 1 ? 1 : 0)) as 0 | 1;
      insertMatch(db, { date: '2026-01-01', time: `00:${String(i).padStart(2, '0')}`, hero: 'Ashe', role: 'DPS', win, queue_mode: mode });
    }
    const r = computeQueueSwitchTax(db);
    assert.equal(r.same.games, 10);
    assert.equal(r.switched.games, 10);
    assert.equal(r.same.win_rate, 100);
    assert.equal(r.switched.win_rate, 0);
    assert.equal(r.reliable, true);
    assert.equal(r.gap, 100);
  });

  test('below MIN_GAMES: unreliable', () => {
    insertMatch(db, { date: '2026-01-01', time: '00:00', hero: 'Ashe', role: 'DPS', win: 1, queue_mode: 'comp' });
    insertMatch(db, { date: '2026-01-01', time: '00:01', hero: 'Ashe', role: 'DPS', win: 0, queue_mode: 'qp' });
    insertMatch(db, { date: '2026-01-01', time: '00:02', hero: 'Ashe', role: 'DPS', win: 1, queue_mode: 'qp' });
    const r = computeQueueSwitchTax(db);
    assert.equal(r.switched.games, 1); // qp after comp
    assert.equal(r.same.games, 1);     // qp after qp
    assert.equal(r.reliable, false);
    assert.equal(r.gap, null);
  });
});

// ── computeCritAccuracy ──────────────────────────────────────────────────────
describe('computeCritAccuracy', () => {
  test('empty DB: no crash, no NaN, reliable false', () => {
    const r = computeCritAccuracy(db);
    assert.equal(r.reliable, false);
    assert.equal(r.baseline, null);
    assert.equal(r.aboveGames, 0);
    assert.equal(r.belowGames, 0);
    assert.equal(r.gap, null);
  });

  test('null crit_acc rows are excluded entirely (not treated as 0)', () => {
    const m = insertMatch(db, { date: '2026-01-01', hero: 'Ashe', role: 'DPS', win: 1 });
    insertAimStats(db, { match_id: m, crit_acc: null });
    const r = computeCritAccuracy(db);
    assert.equal(r.reliable, false);
    assert.equal(r.baseline, null); // 0 rows survive the IS NOT NULL filter
  });

  test('exactly at MIN_GAMES (10/10): reliable, with a hand-computed gap', () => {
    // 20 rows, crit_acc = 1..20 (mean = 10.5). Above (>10.5): 11..20 (10
    // rows), all win=1. Below (<=10.5): 1..10 (10 rows), all win=0.
    // aboveWinRate=100, belowWinRate=0, gap=100.
    for (let v = 1; v <= 20; v++) {
      const win = (v > 10 ? 1 : 0) as 0 | 1;
      const m = insertMatch(db, { date: '2026-01-01', hero: 'Ashe', role: 'DPS', win });
      insertAimStats(db, { match_id: m, crit_acc: v });
    }
    const r = computeCritAccuracy(db);
    assert.equal(r.baseline, 10.5);
    assert.equal(r.aboveGames, 10);
    assert.equal(r.belowGames, 10);
    assert.equal(r.aboveWinRate, 100);
    assert.equal(r.belowWinRate, 0);
    assert.equal(r.reliable, true);
    assert.equal(r.gap, 100);
  });

  test('one below MIN_GAMES (9/11): unreliable despite a clean split existing', () => {
    // Same shape as above but only 18 rows (1..18, mean 9.5): above (>9.5)
    // = 10..18 (9 rows) < the 10-game guard, so unreliable even though the
    // split itself is well-defined.
    for (let v = 1; v <= 18; v++) {
      const win = (v > 9 ? 1 : 0) as 0 | 1;
      const m = insertMatch(db, { date: '2026-01-01', hero: 'Ashe', role: 'DPS', win });
      insertAimStats(db, { match_id: m, crit_acc: v });
    }
    const r = computeCritAccuracy(db);
    assert.equal(r.aboveGames, 9);
    assert.equal(r.belowGames, 9);
    assert.equal(r.reliable, false);
    assert.equal(r.gap, null);
  });
});

// ── computeKillSecure ────────────────────────────────────────────────────────
describe('computeKillSecure', () => {
  test('empty DB: no crash, reliable false', () => {
    const r = computeKillSecure(db);
    assert.equal(r.reliable, false);
    assert.equal(r.baseline, null);
  });

  test('elims = 0 rows are excluded (would otherwise divide by zero)', () => {
    const m = insertMatch(db, { date: '2026-01-01', hero: 'Ashe', role: 'DPS', win: 1 });
    insertAimStats(db, { match_id: m, elims: 0, final_blows: 0 });
    const r = computeKillSecure(db);
    assert.equal(r.reliable, false);
    assert.equal(r.baseline, null, 'the elims=0 row must not have produced a 0/0 baseline');
  });

  test('exactly at MIN_GAMES (10/10): reliable, with a hand-computed gap', () => {
    // 20 rows, elims fixed at 10, final_blows = 1..20 -> ratio = 0.1..2.0,
    // mean ratio = 1.05. Above (>1.05): fb=11..20 (10 rows, ratio 1.1-2.0),
    // all win=1. Below (<=1.05): fb=1..10 (10 rows, ratio 0.1-1.0), all win=0.
    for (let fb = 1; fb <= 20; fb++) {
      const win = (fb > 10 ? 1 : 0) as 0 | 1;
      const m = insertMatch(db, { date: '2026-01-01', hero: 'Ashe', role: 'DPS', win });
      insertAimStats(db, { match_id: m, elims: 10, final_blows: fb });
    }
    const r = computeKillSecure(db);
    assert.equal(r.baseline, 1.05);
    assert.equal(r.aboveGames, 10);
    assert.equal(r.belowGames, 10);
    assert.equal(r.aboveWinRate, 100);
    assert.equal(r.belowWinRate, 0);
    assert.equal(r.reliable, true);
    assert.equal(r.gap, 100);
  });
});

// ── computeDayHourWindow ─────────────────────────────────────────────────────
describe('computeDayHourWindow', () => {
  test('empty DB: no crash, reliable false, best/worst null', () => {
    const r = computeDayHourWindow(db);
    assert.equal(r.reliable, false);
    assert.equal(r.best, null);
    assert.equal(r.worst, null);
  });

  test('a cell below MIN_GAMES (10) is dropped by the HAVING clause, not just marked unreliable', () => {
    // One cell at n=9 (below the guard) and one at n=10 (at the guard).
    // Only one cell survives the HAVING n>=10 filter, so rows.length < 2 and
    // the whole result is unreliable — the n=9 cell isn't merely excluded
    // from being "best", it's invisible to the function entirely.
    for (let i = 0; i < 9; i++) {
      insertMatch(db, { date: '2026-01-01', hero: 'Ashe', role: 'DPS', win: 1, day_of_week: 'Monday', hour: 9 });
    }
    for (let i = 0; i < 10; i++) {
      insertMatch(db, { date: '2026-01-02', hero: 'Ashe', role: 'DPS', win: 0, day_of_week: 'Tuesday', hour: 12 });
    }
    const r = computeDayHourWindow(db);
    assert.equal(r.reliable, false);
  });

  test('two cells at/above MIN_GAMES: reliable, best/worst correctly identified by win rate', () => {
    for (let i = 0; i < 10; i++) {
      insertMatch(db, { date: '2026-01-01', hero: 'Ashe', role: 'DPS', win: 1, day_of_week: 'Monday', hour: 17 });
    }
    for (let i = 0; i < 10; i++) {
      insertMatch(db, { date: '2026-01-02', hero: 'Ashe', role: 'DPS', win: 0, day_of_week: 'Tuesday', hour: 12 });
    }
    const r = computeDayHourWindow(db);
    assert.equal(r.reliable, true);
    assert.equal(r.best!.day_of_week, 'Monday');
    assert.equal(r.best!.hour, 17);
    assert.equal(r.best!.wr, 100);
    assert.equal(r.best!.n, 10);
    assert.equal(r.worst!.day_of_week, 'Tuesday');
    assert.equal(r.worst!.hour, 12);
    assert.equal(r.worst!.wr, 0);
  });
});

// ── computePerformanceOutcome ────────────────────────────────────────────────
describe('computePerformanceOutcome', () => {
  test('empty DB: no crash, empty features, no strongest/mismatch', () => {
    const r = computePerformanceOutcome(db);
    assert.deepEqual(r.features, []);
    assert.equal(r.strongest, null);
    assert.equal(r.mismatch, null);
    assert.equal(r.sample_size, 0);
  });

  test('a single row: every "above" split is empty (value is never > its own baseline)', () => {
    const m = insertMatch(db, { date: '2026-01-01', hero: 'Ashe', role: 'DPS', win: 1 });
    insertAimStats(db, { match_id: m, overall_acc: 50, damage: 500, elims: 10, final_blows: 5, duration_min: 10 });
    const r = computePerformanceOutcome(db);
    assert.equal(r.sample_size, 1);
    for (const f of r.features) {
      assert.equal(f.aboveGames, 0, `${f.key}: a single row equals its own mean, so "above" (strictly >) must be empty`);
      assert.equal(f.belowGames, 1);
      assert.equal(f.reliable, false);
    }
    assert.equal(r.strongest, null);
    // aboveCounts for the lone row is 0 on every feature (never strictly >
    // its own baseline) -> playedPoor (<=1), not playedWell.
    assert.ok(r.mismatch, 'expected a mismatch object for a non-empty result');
    const mismatch = r.mismatch;
    assert.equal(mismatch.played_well_games, 0);
    assert.equal(mismatch.played_poor_games, 1);
    assert.equal(mismatch.reliable, false);
  });

  test('below MIN_GAMES (8) on both sides: every feature unreliable, strongest null', () => {
    for (let i = 0; i < 6; i++) {
      const m = insertMatch(db, { date: '2026-01-01', hero: 'Ashe', role: 'DPS', win: (i % 2) as 0 | 1 });
      insertAimStats(db, { match_id: m, overall_acc: 40 + i, damage: 400, elims: 10, final_blows: 5, duration_min: 10 });
    }
    const r = computePerformanceOutcome(db);
    for (const f of r.features) assert.equal(f.reliable, false);
    assert.equal(r.strongest, null);
  });

  test('exactly at MIN_GAMES (8/8) on every feature: hand-computed strongest + mismatch', () => {
    // 16 rows, duration_min=10 for every row so the /duration_min*10
    // normalization is a no-op (raw value === per-10min value) and the
    // arithmetic stays exact. Four groups of 4 identical rows:
    //   rows 1-4:   win=1, acc=80, dmg=800, elims=20, fb=8
    //   rows 5-8:   win=1, acc=20, dmg=200, elims=20, fb=2
    //   rows 9-12:  win=0, acc=80, dmg=800, elims=5,  fb=8
    //   rows 13-16: win=0, acc=20, dmg=200, elims=5,  fb=2
    // Baselines: acc=50, dmg=500, elims=12.5, fb=5 (mean of the 4 group
    // values, 4 rows each).
    // acc/dmg/fb all split "above" = {rows 1-4, 9-12} (8 rows: 4 win + 4
    // loss) vs "below" = {rows 5-8, 13-16} (8 rows: 4 win + 4 loss) -> 50%
    // win rate on both sides of each split -> gap 0, but reliable (8/8).
    // elims splits "above" = {rows 1-8} (exactly the win=1 rows, 8 wins) vs
    // "below" = {rows 9-16} (exactly the win=0 rows, 8 losses) -> 100% vs 0%
    // -> gap 100, the clear strongest.
    const rows: { win: 0 | 1; acc: number; dmg: number; elims: number; fb: number }[] = [
      ...Array(4).fill({ win: 1, acc: 80, dmg: 800, elims: 20, fb: 8 }),
      ...Array(4).fill({ win: 1, acc: 20, dmg: 200, elims: 20, fb: 2 }),
      ...Array(4).fill({ win: 0, acc: 80, dmg: 800, elims: 5, fb: 8 }),
      ...Array(4).fill({ win: 0, acc: 20, dmg: 200, elims: 5, fb: 2 }),
    ];
    for (const row of rows) {
      const m = insertMatch(db, { date: '2026-01-01', hero: 'Ashe', role: 'DPS', win: row.win });
      insertAimStats(db, { match_id: m, overall_acc: row.acc, damage: row.dmg, elims: row.elims, final_blows: row.fb, duration_min: 10 });
    }
    const r = computePerformanceOutcome(db);
    assert.equal(r.sample_size, 16);

    const byKey = Object.fromEntries(r.features.map(f => [f.key, f]));
    assert.equal(byKey.overall_acc.baseline, 50);
    assert.equal(byKey.overall_acc.gap, 0);
    assert.equal(byKey.overall_acc.reliable, true);

    assert.equal(byKey.dmg10.baseline, 500);
    assert.equal(byKey.dmg10.gap, 0);

    assert.equal(byKey.fb10.baseline, 5);
    assert.equal(byKey.fb10.gap, 0);

    assert.equal(byKey.elims10.baseline, 12.5);
    assert.equal(byKey.elims10.aboveGames, 8);
    assert.equal(byKey.elims10.belowGames, 8);
    assert.equal(byKey.elims10.aboveWinRate, 100);
    assert.equal(byKey.elims10.belowWinRate, 0);
    assert.equal(byKey.elims10.gap, 100);
    assert.equal(byKey.elims10.reliable, true);

    assert.ok(r.strongest, 'expected a strongest feature');
    assert.equal(r.strongest!.key, 'elims10');
    assert.equal(r.strongest!.gap, 100);

    // Mismatch: rows 1-4 and 9-12 are above baseline on 4/4 and 3/4 features
    // respectively (>=3 -> "played well"); rows 5-8 are above on 1/4 (elims
    // only) and rows 13-16 on 0/4 (both <=1 -> "played poor").
    assert.equal(r.mismatch!.played_well_games, 8);
    assert.equal(r.mismatch!.played_well_losses, 4); // rows 9-12: played well, lost
    assert.equal(r.mismatch!.played_well_loss_rate, 50);
    assert.equal(r.mismatch!.played_poor_games, 8);
    assert.equal(r.mismatch!.played_poor_wins, 4); // rows 5-8: played poor, won
    assert.equal(r.mismatch!.played_poor_win_rate, 50);
    assert.equal(r.mismatch!.reliable, true);
  });
});
