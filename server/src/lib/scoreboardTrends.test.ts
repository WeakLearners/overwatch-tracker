import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createReplicaSchema } from '../lab/replica';
import { computeScoreboardTrends, isoWeek } from './scoreboardTrends';

// Plain in-memory replica: the compute function reads only these tables.
function fresh() {
  const db = new DatabaseSync(':memory:');
  createReplicaSchema(db);
  let boardId = 0;
  let matchId = 0;
  const match = (o: { date?: string; time?: string; win: 0 | 1; role?: string; queue_mode?: string; crashed?: 0 | 1; account?: string }) => {
    const id = ++matchId;
    db.prepare(`INSERT INTO matches (id, date, time, win, role, queue_mode, crashed, account) VALUES (:id, :date, :time, :win, :role, :q, :c, :a)`)
      .run({ id, date: o.date ?? '2026-10-12', time: o.time ?? `2026-10-12T10:${String(id).padStart(2, '0')}:00`, win: o.win, role: o.role ?? 'DPS', q: o.queue_mode ?? 'comp_role', c: o.crashed ?? 0, a: o.account ?? 'Jinx' });
    return id;
  };
  const board = (match_id: number, own: { e?: number; d?: number; dmg?: number; h?: number }, teamMate = { d: 10, dmg: 10000 }, page_type: string | null = 'teams') => {
    const id = ++boardId;
    db.prepare(`INSERT INTO match_scoreboards (id, match_id, page_type) VALUES (:id, :m, :p)`).run({ id, m: match_id, p: page_type });
    const row = (slot: number, self: 0 | 1, v: { e: number; d: number; dmg: number; h: number }) =>
      db.prepare(`INSERT INTO scoreboard_rows (scoreboard_id, team, slot, is_self, role, hero, e, a, d, dmg, h, mit) VALUES (:b, 'us', :s, :self, 'dps', NULL, :e, 0, :d, :dmg, :h, 0)`)
        .run({ b: id, s: slot, self, ...v });
    row(1, 1, { e: own.e ?? 10, d: own.d ?? 5, dmg: own.dmg ?? 5000, h: own.h ?? 0 });
    row(2, 0, { e: 5, d: teamMate.d, dmg: teamMate.dmg, h: 0 });
    return id;
  };
  const play = (match_id: number, seconds: number, hero = 'Ana') =>
    db.prepare(`INSERT INTO match_hero_stats (match_id, hero, stat, value, unit, per10) VALUES (:m, :h, 'play_time', :v, 'amount', NULL)`).run({ m: match_id, h: hero, v: seconds });
  const rank = (match_id: number, rank_int: number | null, delta_pct: number | null, result: 'victory' | 'defeat') => {
    const id = ++boardId;
    db.prepare(`INSERT INTO match_scoreboards (id, match_id, page_type) VALUES (:id, :m, 'rank')`).run({ id, m: match_id });
    db.prepare(`INSERT INTO scoreboard_ranks (scoreboard_id, rank_int, progress_pct, delta_pct, result) VALUES (:id, :r, 50, :d, :res)`).run({ id, r: rank_int, d: delta_pct, res: result });
  };
  return { db, match, board, play, rank };
}

describe('computeScoreboardTrends', () => {
  test('comp only, crashed skipped, one board per match', () => {
    const t = fresh();
    const a = t.match({ win: 1 });
    t.board(a, { d: 3 });
    t.board(a, { d: 3 }, undefined, null); // second board, same match: counts once
    const q = t.match({ win: 1, queue_mode: 'qp_role' });
    t.board(q, { d: 3 });
    const c = t.match({ win: 0, crashed: 1 });
    t.board(c, { d: 3 });
    const r = computeScoreboardTrends(t.db);
    assert.equal(r.scope.matches, 1);
    assert.equal(r.death_bins[0].n, 1);
    assert.equal(r.win_loss.wins.n, 1);
  });

  test('a match with a board but no own row is skipped', () => {
    const t = fresh();
    const m = t.match({ win: 1 });
    const id = t.board(m, {});
    t.db.prepare(`UPDATE scoreboard_rows SET is_self = 0 WHERE scoreboard_id = :id`).run({ id });
    assert.equal(computeScoreboardTrends(t.db).scope.matches, 0);
  });

  test('death bins edges: 4 and 5, 10 and 11 fall in different bins', () => {
    const t = fresh();
    for (const d of [4, 5, 6, 7, 10, 11, 20]) t.board(t.match({ win: 1 }), { d });
    const n = Object.fromEntries(computeScoreboardTrends(t.db).death_bins.map(b => [b.label, b.n]));
    assert.deepEqual(n, { '0-4': 1, '5-6': 2, '7-8': 1, '9-10': 1, '11+': 2 });
  });

  test('death bins carry a finding; a bin under 10 games is thin', () => {
    const t = fresh();
    for (let i = 0; i < 12; i++) t.board(t.match({ win: 1 }), { d: 2 });
    for (let i = 0; i < 12; i++) t.board(t.match({ win: 0 }), { d: 8 });
    for (let i = 0; i < 3; i++) t.board(t.match({ win: 0 }), { d: 12 });
    const bins = computeScoreboardTrends(t.db).death_bins;
    assert.equal(bins[0].finding.verdict, 'holds');
    assert.equal(bins[0].finding.groupsTested, 2);
    assert.equal(bins[4].finding.verdict, 'thin');
    assert.equal(bins[1].finding.verdict, 'thin'); // 0 games
  });

  test('per-10 figures use play_time and count only matches that have it', () => {
    const t = fresh();
    const a = t.match({ win: 1 });
    t.board(a, { e: 20, d: 4, dmg: 6000, h: 3000 });
    t.play(a, 300, 'Ana'); t.play(a, 300, 'Mercy'); // 600 s = 10 min in total
    const b = t.match({ win: 1 });
    t.board(b, { e: 999, d: 999, dmg: 999999, h: 999999 }); // no play_time: left out of per-10
    const r = computeScoreboardTrends(t.db);
    assert.equal(r.scope.matches, 2);
    assert.equal(r.scope.per10_covered, 1);
    assert.equal(r.win_loss.wins.per10_n, 1);
    assert.equal(r.win_loss.wins.elims10, 20);
    assert.equal(r.win_loss.wins.deaths10, 4);
    assert.equal(r.win_loss.wins.damage10, 6000);
    assert.equal(r.win_loss.wins.healing10, 3000);
  });

  test('shares divide own deaths and damage by the team total', () => {
    const t = fresh();
    t.board(t.match({ win: 0 }), { d: 5, dmg: 2000 }, { d: 15, dmg: 8000 }); // team 20 deaths, 10000 damage
    const l = computeScoreboardTrends(t.db).win_loss.losses;
    assert.equal(l.death_share, 25);
    assert.equal(l.damage_share, 20);
    assert.equal(l.per10_n, 0);
    assert.equal(l.deaths10, null);
  });

  test('rank break-even: mean delta per result, loss/(win+loss), actual win rate', () => {
    const t = fresh();
    const seq: [number, number, 'victory' | 'defeat'][] = [[15, 30, 'victory'], [15, 40, 'victory'], [15, -20, 'defeat'], [15, -30, 'defeat'], [15, -25, 'defeat']];
    for (const [r, d, res] of seq) t.rank(t.match({ win: res === 'victory' ? 1 : 0 }), r, d, res);
    t.rank(t.match({ win: 1, queue_mode: 'comp_open' }), 17, null, 'victory'); // open queue: no delta
    const k = computeScoreboardTrends(t.db).rank;
    assert.equal(k.victory.mean_delta, 35);
    assert.equal(k.defeat.mean_delta, -25);
    assert.equal(k.break_even_wr, 41.7); // 25 / 60
    assert.equal(k.actual_wr, 40);       // 2 of 5
    assert.equal(k.used, 5);
    assert.equal(k.no_delta, 1);
  });

  test('rank outlier: far from BOTH neighbours on the same ladder is excluded', () => {
    const t = fresh();
    const ids = [14, 23, 14].map((r, i) => {
      const m = t.match({ win: i === 1 ? 1 : 0, time: `2026-10-12T10:0${i}:00` });
      t.rank(m, r, i === 1 ? 500 : -20, i === 1 ? 'victory' : 'defeat');
      return m;
    });
    const k = computeScoreboardTrends(t.db).rank;
    assert.equal(ids.length, 3);
    assert.equal(k.excluded, 1);
    assert.equal(k.victory.n, 0); // the bogus +500 row is gone
    assert.equal(k.defeat.mean_delta, -20);
  });

  test('a jump of exactly 3 is kept, and a jump seen only on one side is kept', () => {
    const t = fresh();
    [14, 17, 14].forEach((r, i) => t.rank(t.match({ win: 0, time: `2026-10-12T10:0${i}:00` }), r, -20, 'defeat'));
    assert.equal(computeScoreboardTrends(t.db).rank.excluded, 0);
    const u = fresh();
    [14, 14, 23].forEach((r, i) => u.rank(u.match({ win: 0, time: `2026-10-12T10:0${i}:00` }), r, -20, 'defeat'));
    assert.equal(computeScoreboardTrends(u.db).rank.excluded, 0); // end of the line: one neighbour only
  });

  test('different ladders are not neighbours (Support 23 between two DPS 14 rows is real)', () => {
    const t = fresh();
    t.rank(t.match({ win: 0, role: 'DPS', time: '2026-10-12T10:00:00' }), 14, -20, 'defeat');
    t.rank(t.match({ win: 0, role: 'Support', time: '2026-10-12T10:10:00' }), 23, -20, 'defeat');
    t.rank(t.match({ win: 0, role: 'DPS', time: '2026-10-12T10:20:00' }), 14, -20, 'defeat');
    assert.equal(computeScoreboardTrends(t.db).rank.excluded, 0);
  });

  test('weeks split by role with n, ISO week labels', () => {
    const t = fresh();
    t.board(t.match({ win: 1, date: '2026-10-12', role: 'DPS' }), {});
    t.board(t.match({ win: 0, date: '2026-10-13', role: 'Support' }), {});
    t.board(t.match({ win: 0, date: '2026-10-19', role: 'DPS' }), {});
    const w = computeScoreboardTrends(t.db).weeks;
    assert.deepEqual(w.map(x => `${x.week} ${x.role} ${x.n}`), ['2026-W42 dps 1', '2026-W42 support 1', '2026-W43 dps 1']);
    assert.equal(w[0].finding.verdict, 'thin');
  });

  test('isoWeek handles year edges', () => {
    assert.equal(isoWeek('2026-01-01'), '2026-W01');
    assert.equal(isoWeek('2024-12-30'), '2025-W01');
    assert.equal(isoWeek('2027-01-03'), '2026-W53');
  });

  test('empty data returns nulls, not NaN', () => {
    const r = computeScoreboardTrends(fresh().db);
    assert.equal(r.scope.matches, 0);
    assert.equal(r.scope.win_rate, null);
    assert.equal(r.rank.break_even_wr, null);
    assert.deepEqual(r.weeks, []);
  });
});
