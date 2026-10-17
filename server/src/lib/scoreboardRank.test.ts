// Rank progress page (2026-10-11, Phase 1): classification, parse, grouping in both arrival
// orders, start-rank derivation and the NULL-only fill. The reading below is what the screen
// of Screenshot (114) shows: PLATINUM 3, 25%, +44%, three hero SR entries.
process.env.TZ = 'America/New_York';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb, closeDb } from '../db/schema';
import { processFile, systemPrompt, SCHEMA, type ParsedScoreboard } from './scoreboard';
import { buildFill, normRank, rankInt, deriveStartRank, PAGE_GAP_MS, type RawRank } from './scoreboardPages';
import { pageSuffix } from './scoreboardOrganize';

const T0 = Date.parse('2026-10-09T17:18:48.387Z');
const emptySummary = { map: '', result: '', score_us: 0, score_them: 0, game_mode: '', date_text: '', game_length: '', heroes: [], elims: 0, assists: 0, deaths: 0 };
const SUMMARY: ParsedScoreboard = { is_scoreboard: false, page_type: 'summary', rows: [], personal: { hero: '', tiles: [] },
  summary: { map: 'NEPAL', result: 'victory', score_us: 2, score_them: 1, game_mode: 'CONTROL', date_text: '10/09/26 - 12:31', game_length: '8:47',
    heroes: [{ hero: 'TRACER', percent: 100, play_time: '08:47' }], elims: 11, assists: 0, deaths: 5 } };
const RAW_114: RawRank = {
  result: 'VICTORY', rank_text: 'PLATINUM 3', progress_text: '25%', change_text: '+44%', percentile_text: '50%',
  modifiers: ['VARIANCE', 'UPHILL BATTLE', 'VICTORY'], points_total: '2605', points_change: '+10', reward_progress: '3/30',
  heroes: [{ name: 'SOLDIER: 76', sr: '1421', change: '' }, { name: 'SOJOURN', sr: '1618', change: '+96' }, { name: 'ASHE', sr: '1000', change: '+101' }],
};
const rankReading = (over: Partial<RawRank> = {}): ParsedScoreboard => ({ is_scoreboard: false, page_type: 'rank', rows: [], summary: emptySummary, personal: { hero: '', tiles: [] }, rank: { ...RAW_114, ...over } });

describe('rank encoding and parse', () => {
  test('tier + division use the 1-45 ladder of matches.player_rank (Bronze 5 = 1, Platinum 3 = 18, Champion 1 = 45)', () => {
    assert.equal(rankInt('Bronze', 5), 1); assert.equal(rankInt('Gold', 5), 11); assert.equal(rankInt('Platinum', 3), 18);
    assert.equal(rankInt('platinum', 4), 17); assert.equal(rankInt('Champion', 1), 45); assert.equal(rankInt('Platinum', 6), null); assert.equal(rankInt('Wood', 3), null);
  });
  test('Screenshot (114) reading normalises', () => {
    const n = normRank(RAW_114);
    assert.deepEqual([n.rankInt, n.tier, n.division, n.progressPct, n.deltaPct, n.result, n.percentile, n.cpTotal, n.cpDelta, n.rewardProgress, n.rewardTotal],
      [18, 'Platinum', 3, 25, 44, 'victory', 50, 2605, 10, 3, 30]);
    assert.deepEqual(n.modifiers, ['VARIANCE', 'UPHILL BATTLE', 'VICTORY']);
    assert.deepEqual(n.heroes.map(h => [h.hero, h.rawName, h.sr, h.srDelta]), [['Soldier: 76', 'SOLDIER: 76', 1421, null], ['Sojourn', 'SOJOURN', 1618, 96], ['Ashe', 'ASHE', 1000, 101]]);
  });
  test('a loss, a unicode minus, an unknown hero and missing values', () => {
    const n = normRank({ ...RAW_114, result: 'DEFEAT', change_text: '−30%', points_change: '-8', heroes: [{ name: 'SOJOURNN', sr: '1,500', change: '−12' }], percentile_text: '', reward_progress: '' });
    assert.deepEqual([n.result, n.deltaPct, n.cpDelta, n.percentile, n.rewardProgress], ['defeat', -30, -8, null, null]);
    assert.deepEqual(n.heroes.map(h => [h.hero, h.rawName, h.sr, h.srDelta]), [[null, 'SOJOURNN', 1500, -12]]);
    const bad = normRank({ ...RAW_114, rank_text: 'WOOD 9', change_text: '', progress_text: '' });
    assert.deepEqual([bad.rankInt, bad.tier, bad.deltaPct, bad.progressPct], [null, null, null, null]);
  });
});

describe('deriveStartRank', () => {
  test('same division: progress - change inside 0..100', () => assert.deepEqual(deriveStartRank(18, 60, 20), { rankInt: 18, progressPct: 40 }));
  test('promotion crossed a division (Screenshot 114: 25% after +44% began in Platinum 4 at 81%)', () => assert.deepEqual(deriveStartRank(18, 25, 44), { rankInt: 17, progressPct: 81 }));
  test('demotion crossed a division on a loss: ended Platinum 4 at 80% after -30% began in Platinum 3 at 10%', () => assert.deepEqual(deriveStartRank(17, 80, -30), { rankInt: 18, progressPct: 10 }));
  test('exact edges stay in the division', () => { assert.deepEqual(deriveStartRank(18, 0, 0), { rankInt: 18, progressPct: 0 }); assert.deepEqual(deriveStartRank(18, 50, -50), { rankInt: 18, progressPct: 100 }); });
  test('missing values, an out-of-range reading and the ladder ends give null', () => {
    assert.equal(deriveStartRank(18, 25, null), null); assert.equal(deriveStartRank(null, 25, 44), null); assert.equal(deriveStartRank(18, null, 44), null);
    assert.equal(deriveStartRank(18, 120, 10), null, 'progress over 100 is a misread');
    assert.equal(deriveStartRank(1, 10, 30), null, 'would start below Bronze 5');
    assert.equal(deriveStartRank(45, 90, -40), null, 'would start above Champion 1');
  });
});

describe('rank page on a temp DB', () => {
  let db: ReturnType<typeof getDb>; let tmp: string;
  beforeEach(() => { tmp = path.join(os.tmpdir(), `sbr-test-${process.pid}-${Date.now()}.db`); db = getDb(tmp); });
  afterEach(() => { closeDb(); for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f); });
  const addMatch = (o: { win?: number; queue?: string; rank?: number | null; start?: number | null } = {}) => Number(db.prepare(
    `INSERT INTO matches (date, hero, role, map, game_type, win, account, queue_mode, player_rank, player_rank_start, created_at) VALUES ('2026-10-09', 'Tracer', 'DPS', 'Nepal', 'Control', ?, 'Linx', ?, ?, ?, '2026-10-09 16:35:14')`)
    .run(o.win ?? 1, o.queue ?? 'comp_role', o.rank ?? null, o.start ?? null).lastInsertRowid);
  const feed = (r: ParsedScoreboard, file: string, offsetS: number, replaceId?: number) => processFile(db, `/x/${file}.png`, T0 + offsetS * 1000, async () => r, replaceId);
  const pages = () => db.prepare(`SELECT id, page_type, status, match_id, group_id FROM match_scoreboards ORDER BY id`).all() as any[];
  const ranks = (m: number) => db.prepare(`SELECT player_rank, player_rank_start FROM matches WHERE id = ?`).get(m) as any;

  test('classification: a rank page is stored as page_type rank, not other, and the prompt and schema know it', async () => {
    assert.equal(await feed(rankReading(), 'r', 0), 'unmatched');
    const row = db.prepare(`SELECT page_type, status, group_id, reason FROM match_scoreboards`).get() as any;
    assert.deepEqual([row.page_type, row.status, row.group_id], ['rank', 'unmatched', null]);
    assert.ok(systemPrompt().includes('"rank" = the RANK PROGRESS screen'));
    assert.ok((SCHEMA.properties.page_type.enum as string[]).includes('rank') && SCHEMA.required.includes('rank'));
    assert.equal(pageSuffix('rank', null), ' - rank');
  });
  test('rank rows are stored by page id before any match is linked', async () => {
    await feed(rankReading(), 'r', 0);
    const id = (db.prepare(`SELECT id FROM match_scoreboards`).get() as any).id;
    const r = db.prepare(`SELECT * FROM scoreboard_ranks WHERE scoreboard_id = ?`).get(id) as any;
    assert.deepEqual([r.rank_int, r.tier, r.division, r.progress_pct, r.delta_pct, r.result, r.percentile, r.cp_total, r.cp_delta, r.reward_progress, r.reward_total, r.modifiers],
      [18, 'Platinum', 3, 25, 44, 'victory', 50, 2605, 10, 3, 30, '["VARIANCE","UPHILL BATTLE","VICTORY"]']);
    const h = db.prepare(`SELECT slot, hero, raw_name, sr, sr_delta FROM scoreboard_rank_heroes WHERE scoreboard_id = ? ORDER BY slot`).all(id) as any[];
    assert.deepEqual(h.map(x => [x.slot, x.hero, x.raw_name, x.sr, x.sr_delta]), [[0, 'Soldier: 76', 'SOLDIER: 76', 1421, null], [1, 'Sojourn', 'SOJOURN', 1618, 96], [2, 'Ashe', 'ASHE', 1000, 101]]);
    // a re-read in place replaces the rows, it never doubles them
    await feed(rankReading({ rank_text: 'PLATINUM 2' }), 'r', 0, id);
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM scoreboard_rank_heroes`).get() as any).n, 3);
    assert.equal((db.prepare(`SELECT rank_int FROM scoreboard_ranks`).get() as any).rank_int, 19);
  });
  test('order A: rank page, then its Summary 14 s later -> same group', async () => {
    await feed(rankReading(), 'r', 0); await feed(SUMMARY, 's', 14);
    const g = db.prepare(`SELECT id FROM scoreboard_groups`).get() as any;
    assert.deepEqual(pages().map(p => [p.page_type, p.group_id]), [['rank', g.id], ['summary', g.id]]);
  });
  test('order B: Summary first (out-of-order delivery), then the rank page -> same group', async () => {
    await feed(SUMMARY, 's', 14); await feed(rankReading(), 'r', 0);
    const g = db.prepare(`SELECT id FROM scoreboard_groups`).get() as any;
    assert.deepEqual(pages().map(p => [p.page_type, p.group_id]), [['summary', g.id], ['rank', g.id]]);
  });
  test('a rank page more than PAGE_GAP_MS before the Summary, or after it, stays loose', async () => {
    await feed(rankReading(), 'r1', 0); await feed(SUMMARY, 's', PAGE_GAP_MS / 1000 + 1);
    assert.equal(pages()[0].group_id, null);
    await feed(rankReading(), 'r2', PAGE_GAP_MS / 1000 + 5);
    assert.equal(pages()[2].group_id, null, 'a rank page taken after the Summary is not its rank page');
  });
  test('two rank pages before one Summary: the later one joins, the earlier stays loose', async () => {
    await feed(rankReading(), 'r1', 0); await feed(rankReading({ progress_text: '30%' }), 'r2', 10); await feed(SUMMARY, 's', 20);
    assert.deepEqual(pages().map(p => p.group_id !== null), [false, true, true]);
  });
  test('Summary and Teams/Personal grouping is unchanged by a rank page in front', async () => {
    await feed(rankReading(), 'r', 0); await feed(SUMMARY, 's', 14);
    await feed({ is_scoreboard: false, page_type: 'personal', rows: [], summary: emptySummary, personal: { hero: 'TRACER', tiles: [] } }, 'p', 20);
    const g = (db.prepare(`SELECT id, last_mtime, summary_mtime FROM scoreboard_groups`).get() as any);
    assert.equal(g.summary_mtime, new Date(T0 + 14_000).toISOString());
    assert.equal(g.last_mtime, new Date(T0 + 20_000).toISOString());
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM match_scoreboards WHERE group_id = ?`).get(g.id) as any).n, 3);
  });

  test('the live payload carries the rank page with the derived start; no rank page -> null', async () => {
    await feed(SUMMARY, 's0', -300); const g0 = (db.prepare(`SELECT id FROM scoreboard_groups`).get() as any).id;
    assert.equal(buildFill(db, g0)!.rank, null);
    await feed(rankReading(), 'r', 0); await feed({ ...SUMMARY }, 's', 14);
    const g = (db.prepare(`SELECT id FROM scoreboard_groups ORDER BY id DESC`).get() as any).id;
    assert.deepEqual(buildFill(db, g)!.rank, { rank_int: 18, progress_pct: 25, delta_pct: 44, result: 'victory', start_rank_int: 17, start_progress_pct: 81 });
  });

  describe('fill on link (NULL only)', () => {
    test('recovery link at ingest (match already logged): both columns fill, crossing the division', async () => {
      const m = addMatch();
      await feed(rankReading(), 'r', 0); await feed(SUMMARY, 's', 14);
      assert.deepEqual({ ...ranks(m) }, { player_rank: 18, player_rank_start: 17 });
      assert.deepEqual(pages().map(p => [p.status, p.match_id]), [['matched', m], ['matched', m]]);
    });
    test('live group linked later (form submit) fills then; nothing is written before', async () => {
      await feed(rankReading(), 'r', 0); await feed(SUMMARY, 's', 14);
      const m = addMatch();
      assert.deepEqual({ ...ranks(m) }, { player_rank: null, player_rank_start: null });
      const { linkGroup } = await import('./scoreboardPages');
      const gid = (db.prepare(`SELECT id FROM scoreboard_groups`).get() as any).id;
      linkGroup(db, gid, m, 'linked', 'linked at submit');
      assert.deepEqual({ ...ranks(m) }, { player_rank: 18, player_rank_start: 17 });
      assert.equal(pages()[0].status, 'matched');
    });
    test('rank page that arrives after an already linked Summary fills too', async () => {
      const m = addMatch();
      await feed(SUMMARY, 's', 14); await feed(rankReading(), 'r', 0);
      assert.deepEqual({ ...ranks(m) }, { player_rank: 18, player_rank_start: 17 });
    });
    test('a hand-entered rank is never overwritten; the other NULL column still fills', async () => {
      const m = addMatch({ rank: 19 });
      await feed(rankReading(), 'r', 0); await feed(SUMMARY, 's', 14);
      assert.deepEqual({ ...ranks(m) }, { player_rank: 19, player_rank_start: 17 });
      const m2 = addMatch({ rank: 18, start: 18 });
      const { fillRankFromGroup } = await import('./scoreboardPages');
      const gid = (db.prepare(`SELECT id FROM scoreboard_groups`).get() as any).id;
      assert.equal(fillRankFromGroup(db, gid, m2), false);
      assert.deepEqual({ ...ranks(m2) }, { player_rank: 18, player_rank_start: 18 });
    });
    test('a quick play match, or a match whose result disagrees with the rank page, is left alone', async () => {
      const qp = addMatch({ queue: 'quick_play' }), lost = addMatch({ win: 0 });
      await feed(rankReading(), 'r', 0); await feed(SUMMARY, 's', 14);
      const { fillRankFromGroup } = await import('./scoreboardPages');
      const gid = (db.prepare(`SELECT id FROM scoreboard_groups`).get() as any).id;
      assert.equal(fillRankFromGroup(db, gid, qp), false); assert.equal(fillRankFromGroup(db, gid, lost), false);
      assert.deepEqual([{ ...ranks(qp) }, { ...ranks(lost) }], [{ player_rank: null, player_rank_start: null }, { player_rank: null, player_rank_start: null }]);
    });
    test('a promotion filled from the rank page moves player_ranks 17 -> 18 (one source of truth for the drum)', async () => {
      db.prepare(`INSERT INTO player_ranks (account, role, rank) VALUES ('Linx', 'DPS', 17)`).run();
      const m = addMatch();
      await feed(rankReading(), 'r', 0); await feed(SUMMARY, 's', 14);
      assert.equal(ranks(m).player_rank, 18);
      assert.equal((db.prepare(`SELECT rank FROM player_ranks WHERE account = 'Linx' AND role = 'DPS'`).get() as any).rank, 18);
    });
    test('no change bar read: end rank fills, start stays NULL', async () => {
      const m = addMatch();
      await feed(rankReading({ change_text: '' }), 'r', 0); await feed(SUMMARY, 's', 14);
      assert.deepEqual({ ...ranks(m) }, { player_rank: 18, player_rank_start: null });
    });
  });
});
