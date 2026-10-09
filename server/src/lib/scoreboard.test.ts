import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb, closeDb } from '../db/schema';
import {
  decideMatch, MATCH_WINDOW_MIN, processFile, rematchRecent, validateParsed, callVision, resolveSelf, recomputeScoreboards, storeScoreboard, systemPrompt, SCHEMA,
  type MatchCandidate, type ParsedRow, type ParsedScoreboard, type SelfRow,
} from './scoreboard';
import { pollOnce } from './scoreboardWatcher';

const MTIME = Date.parse('2026-10-09T13:08:54Z');
const at = (minAfter: number) => new Date(MTIME + minAfter * 60_000).toISOString().slice(0, 19).replace('T', ' ');
const self: SelfRow = { name: 'LINX', role: 'support' };
const cand = (o: Partial<MatchCandidate> = {}): MatchCandidate =>
  ({ id: 1, created_at: at(5), account: 'Linx', role: 'Support', hasScoreboard: false, ...o });

describe('decideMatch window (fixed times)', () => {
  test('window constant is 10 minutes', () => assert.equal(MATCH_WINDOW_MIN, 10));
  test('inside the window matches', () => assert.equal(decideMatch(MTIME, self, [cand()]).matchId, 1));
  test('edges -10 and +10 min are inside', () => {
    assert.equal(decideMatch(MTIME, self, [cand({ created_at: at(-10) })]).matchId, 1);
    assert.equal(decideMatch(MTIME, self, [cand({ created_at: at(10) })]).matchId, 1);
  });
  test('log 5-21 s before the file matches (real 2026-10-09 pairs)', () => {
    for (const s of [5, 16, 11, 21]) assert.equal(decideMatch(MTIME, self, [cand({ created_at: at(-s / 60) })]).matchId, 1);
  });
  test('log 9 min after matches', () => assert.equal(decideMatch(MTIME, self, [cand({ created_at: at(9) })]).matchId, 1));
  test('11 min either side is outside', () => {
    assert.equal(decideMatch(MTIME, self, [cand({ created_at: at(-11) })]).matchId, null);
    assert.equal(decideMatch(MTIME, self, [cand({ created_at: at(11) })]).matchId, null);
  });
  test('two matches 13 min apart, screenshot 16 s after the second -> second', () => {
    const second = at(0) ; const first = at(-13);
    const d = decideMatch(MTIME + 16_000, self, [cand({ id: 1, created_at: first }), cand({ id: 2, created_at: second })]);
    assert.equal(d.matchId, 2);
  });
  test('screenshot halfway between two matches -> unmatched, never nearest', () => {
    const d = decideMatch(MTIME, self, [cand({ id: 1, created_at: at(-6) }), cand({ id: 2, created_at: at(6) })]);
    assert.equal(d.matchId, null);
  });
  test('other account is rejected', () => assert.equal(decideMatch(MTIME, self, [cand({ account: 'Pinx' })]).matchId, null));
  test('null account is never guessed', () => assert.equal(decideMatch(MTIME, self, [cand({ account: null })]).matchId, null));
  test('role mismatch is rejected', () => assert.equal(decideMatch(MTIME, self, [cand({ role: 'DPS' })]).matchId, null));
  test('hero plays no part: a candidate matches whatever hero was logged', () => {
    assert.equal(decideMatch(MTIME, self, [{ ...cand(), hero: 'Wrecking Ball' } as MatchCandidate]).matchId, 1);
  });
  test('two candidates -> unmatched', () => {
    const d = decideMatch(MTIME, self, [cand({ id: 1 }), cand({ id: 2, created_at: at(9) })]);
    assert.equal(d.matchId, null);
    assert.match(d.reason!, /2 logged matches/);
  });
  test('zero candidates -> unmatched', () => assert.equal(decideMatch(MTIME, self, []).matchId, null));
  test('a match that already has a scoreboard is not reused', () => assert.equal(decideMatch(MTIME, self, [cand({ hasScoreboard: true })]).matchId, null));
});

function row(team: 'us' | 'them', i: number, isSelf = false, over: Partial<ParsedRow> = {}): ParsedRow {
  return { team, role: 'support', is_self: isSelf, player_name: isSelf ? 'LINX' : `P${team}${i}`, e: 1, a: 2, d: 3, dmg: 4, h: 5, mit: 6, ...over };
}
function board(n = 6): ParsedScoreboard {
  return { is_scoreboard: true, rows: [...Array(n)].map((_, i) => row('us', i, i === n - 1)).concat([...Array(n)].map((_, i) => row('them', i))) };
}

describe('validateParsed', () => {
  test('6v6 and 5v5 pass', () => { assert.equal(validateParsed(board(6)), null); assert.equal(validateParsed(board(5)), null); });
  test('uneven teams fail', () => { const b = board(6); b.rows.pop(); assert.match(validateParsed(b)!, /row counts/); });
  test('the model highlight is not validated (self comes from the name)', () => { const b = board(6); b.rows.forEach(r => (r.is_self = false)); assert.equal(validateParsed(b), null); });
});

describe('self row by name, hero removed', () => {
  const rows = (names: string[], team = 'us') => names.map(n => ({ team, player_name: n }));
  test('case-insensitive, trimmed match', () => assert.deepEqual(resolveSelf(rows(['A', ' lInx ', 'B']), ['Linx', 'Pinx']), { index: 1 }));
  test('other account names also work', () => assert.deepEqual(resolveSelf(rows(['A', 'PINX']), ['Linx', 'Pinx']), { index: 1 }));
  test('enemy team rows never count', () => assert.ok('error' in resolveSelf([{ team: 'us', player_name: 'A' }, { team: 'them', player_name: 'LINX' }], ['Linx'])));
  test('zero hits -> error', () => assert.match((resolveSelf(rows(['A', 'B']), ['Linx']) as any).error, /no row/));
  test('2+ hits -> error', () => assert.match((resolveSelf(rows(['LINX', 'PINX']), ['Linx', 'Pinx']) as any).error, /2 rows/));
  test('prompt and schema carry no hero field', () => {
    assert.ok(!('hero' in (SCHEMA as any).properties.rows.items.properties));
    assert.ok(!(SCHEMA as any).properties.rows.items.required.includes('hero'));
    assert.ok(!/hero name|portrait|Wrecking/i.test(systemPrompt().replace('Do not report hero names.', '')));
  });
});

describe('processFile + rematch on a temp DB', () => {
  let db: ReturnType<typeof getDb>; let tmp: string;
  beforeEach(() => { tmp = path.join(os.tmpdir(), `sb-test-${process.pid}-${Date.now()}.db`); db = getDb(tmp); });
  afterEach(() => { closeDb(); for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f); });
  const addMatch = (createdAt: string, account = 'Linx', role = 'Support') => Number(db.prepare(
    `INSERT INTO matches (date, hero, role, map, game_type, win, account, created_at) VALUES ('2026-10-09','Mizuki',?, 'Numbani','Competitive',1,?,?)`,
  ).run(role, account, createdAt).lastInsertRowid);

  test('exactly one candidate -> matched, 12 rows stored with slots', async () => {
    const id = addMatch(at(5));
    assert.equal(await processFile(db, '/x/a.png', MTIME, async () => board(6)), 'matched');
    const sb = db.prepare(`SELECT * FROM match_scoreboards`).get() as any;
    assert.equal(sb.match_id, id);
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM scoreboard_rows`).get() as any).n, 12);
    assert.equal((db.prepare(`SELECT slot FROM scoreboard_rows WHERE team='us' AND is_self=1`).get() as any).slot, 5);
  });
  test('highlight guess on another player: self is still the account-name row; hero stored NULL; raw_json keeps the guess', async () => {
    const id = addMatch(at(5));
    const b = board(6); b.rows.forEach((r, i) => { r.is_self = r.team === 'us' && i === 0; }); // model highlights row 0, LINX is the last us row
    assert.equal(await processFile(db, '/x/a.png', MTIME, async () => b), 'matched');
    assert.equal((db.prepare(`SELECT match_id FROM match_scoreboards`).get() as any).match_id, id);
    const selfRows = db.prepare(`SELECT player_name, slot FROM scoreboard_rows WHERE is_self = 1`).all() as any[];
    assert.deepEqual(selfRows.map(r => r.player_name), ['LINX']);
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM scoreboard_rows WHERE hero IS NOT NULL`).get() as any).n, 0);
    const raw = JSON.parse((db.prepare(`SELECT raw_json FROM match_scoreboards`).get() as any).raw_json);
    assert.equal(raw.rows[0].is_self, true);
  });
  test('no known account name on the top team -> error with a reason', async () => {
    addMatch(at(5));
    const b = board(6); b.rows.forEach(r => { if (r.is_self) r.player_name = 'STRANGER'; });
    assert.equal(await processFile(db, '/x/a.png', MTIME, async () => b), 'error');
    assert.match((db.prepare(`SELECT reason FROM match_scoreboards`).get() as any).reason, /self row/);
  });
  test('no candidate -> unmatched with a reason; matches table untouched', async () => {
    addMatch(at(120));
    const before = (db.prepare(`SELECT COUNT(*) n FROM matches`).get() as any).n;
    assert.equal(await processFile(db, '/x/a.png', MTIME, async () => board(5)), 'unmatched');
    assert.ok((db.prepare(`SELECT reason FROM match_scoreboards`).get() as any).reason);
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM matches`).get() as any).n, before);
  });
  test('late log: rematchRecent attaches once the match exists', async () => {
    addMatch(at(120));
    await processFile(db, '/x/a.png', MTIME, async () => board(6));
    const id = addMatch(at(8));
    assert.equal(rematchRecent(db, MTIME + 10 * 60_000), 1);
    assert.equal((db.prepare(`SELECT match_id FROM match_scoreboards`).get() as any).match_id, id);
  });
  test('rematchRecent leaves old unmatched rows alone', async () => {
    addMatch(at(120));
    await processFile(db, '/x/a.png', MTIME, async () => board(6));
    addMatch(at(8));
    assert.equal(rematchRecent(db, MTIME + 3 * 3600_000), 0);
  });
  test('recomputeScoreboards: self by name, hero nulled, rematch (stale rows from the 2026-10-09 bug)', () => {
    const m1 = addMatch(at(1)); const m2 = addMatch(at(31), 'Linx', 'DPS'); addMatch(at(61), 'Pinx');
    const old = (offsetMin: number, selfAt: number, role: 'support' | 'dps') => {
      const b = board(6); b.rows.forEach((r, i) => { r.role = role; r.is_self = r.team === 'us' && i === selfAt; });
      const id = storeScoreboard(db, { filePath: `/x/${offsetMin}.png`, mtimeMs: MTIME + offsetMin * 60_000, status: 'unmatched', reason: 'stale', raw: b, matchId: null, rows: b.rows });
      db.prepare(`UPDATE scoreboard_rows SET hero = 'Cassidy' WHERE scoreboard_id = ?`).run(id);
      return id;
    };
    const s1 = old(0, 0, 'support');      // highlight on the wrong row; match m1 expected
    const s2 = old(30, 2, 'dps');         // m2 expected
    const s3 = old(200, 5, 'support');    // nothing logged near -> stays unmatched
    db.prepare(`UPDATE match_scoreboards SET match_id = ?, status = 'matched' WHERE id = ?`).run(m2, s1); // stale wrong attach
    const out = recomputeScoreboards(db);
    assert.deepEqual(out.map(o => [o.id, o.status, o.matchId]), [[s1, 'matched', m1], [s2, 'matched', m2], [s3, 'unmatched', null]]);
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM scoreboard_rows WHERE hero IS NOT NULL`).get() as any).n, 0);
    for (const id of [s1, s2, s3]) assert.equal((db.prepare(`SELECT player_name FROM scoreboard_rows WHERE scoreboard_id = ? AND is_self = 1`).get(id) as any).player_name, 'LINX');
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM matches`).get() as any).n, 3);
  });
  test('not a scoreboard -> not_scoreboard, no rows', async () => {
    assert.equal(await processFile(db, '/x/b.png', MTIME, async () => ({ is_scoreboard: false, rows: [] })), 'not_scoreboard');
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM scoreboard_rows`).get() as any).n, 0);
  });
  test('vision failure retries twice, then stores error', async () => {
    const boom = async () => { throw new Error('api down'); };
    assert.equal(await processFile(db, '/x/c.png', MTIME, boom), null);
    assert.equal(await processFile(db, '/x/c.png', MTIME, boom), null);
    assert.equal(await processFile(db, '/x/c.png', MTIME, boom), 'error');
    assert.equal((db.prepare(`SELECT status FROM match_scoreboards`).get() as any).status, 'error');
  });
  test('pollOnce on an unreachable folder returns an error and never throws', async () => {
    const r = await pollOnce(db, '/nonexistent/Other computers/x', async () => board(6), 50);
    assert.ok(r.error);
    assert.equal(r.processed, 0);
  });
  test('pollOnce processes only new image files, once', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dir-'));
    fs.writeFileSync(path.join(dir, 'Screenshot (1).png'), 'x'); fs.writeFileSync(path.join(dir, 'notes.txt'), 'x');
    let calls = 0; const v = async () => { calls++; return { is_scoreboard: false, rows: [] }; };
    assert.equal((await pollOnce(db, dir, v)).processed, 1);
    assert.equal((await pollOnce(db, dir, v)).processed, 0);
    assert.equal(calls, 1);
    fs.rmSync(dir, { recursive: true });
  });
  test('pollOnce on a moved folder repoints file_path and makes no vision call', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-moved-'));
    const f = path.join(dir, 'Screenshot (7).png');
    fs.writeFileSync(f, 'x');
    const mt = fs.statSync(f).mtimeMs;
    db.prepare(`INSERT INTO match_scoreboards (match_id, file_path, file_mtime, status) VALUES (NULL, ?, ?, 'unmatched')`)
      .run('/old/place/Screenshot (7).png', new Date(mt).toISOString());
    let calls = 0; const v = async () => { calls++; return { is_scoreboard: false, rows: [] }; };
    assert.equal((await pollOnce(db, dir, v)).processed, 0);
    assert.equal(calls, 0);
    const rows = db.prepare(`SELECT file_path FROM match_scoreboards`).all() as { file_path: string }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].file_path, f);
    fs.rmSync(dir, { recursive: true });
  });
});

describe('GET/POST /api/scoreboards', () => {
  test('unmatched list and manual attach', async () => {
    const { startHarness } = await import('../test/httpHarness');
    const h = await startHarness();
    try {
      const id = Number(h.db.prepare(`INSERT INTO matches (date, hero, role, map, game_type, win, account, created_at) VALUES ('2026-10-09','Mizuki','Support','Numbani','Competitive',1,'Linx','2026-10-09 20:00:00')`).run().lastInsertRowid);
      await processFile(h.db, '/x/a.png', MTIME, async () => board(6));
      const list = await h.get('/api/scoreboards/unmatched');
      assert.equal(list.body.items.length, 1);
      assert.equal(list.body.items[0].file_name, 'a.png');
      assert.ok(list.body.matches.some((m: any) => m.id === id));
      assert.equal((await h.post(`/api/scoreboards/${list.body.items[0].id}/attach`, { match_id: 99999 })).status, 404);
      assert.equal((await h.post(`/api/scoreboards/${list.body.items[0].id}/attach`, { match_id: id })).status, 200);
      assert.equal((await h.get('/api/scoreboards/unmatched')).body.items.length, 0);
      const bm = await h.get(`/api/scoreboards/by-match/${id}`);
      assert.equal(bm.body.rows.length, 12);
    } finally { await h.close(); }
  });
});

// ------------------------------------------------------------ fixture test
// Ground truth read off the real screenshot by Sean (spec 2026-10-09).
const FIXTURE = path.join(__dirname, '../test/fixtures/scoreboard-36.png');
const TRUTH: [string, string, number, number, number, number, number, number][] = [
  ['us', 'RAY', 22, 9, 3, 7772, 0, 6284], ['us', 'XDD', 21, 15, 2, 10082, 0, 4712],
  ['us', 'BELLASBLOOD', 18, 2, 2, 7592, 0, 771], ['us', 'THISGAMEBUNS', 16, 0, 2, 8394, 0, 0],
  ['us', 'KEROSENE', 12, 20, 1, 2343, 8421, 454], ['us', 'LINX', 12, 20, 1, 2352, 7618, 1045],
  ['them', 'SAVIOR', 9, 2, 6, 6844, 12, 8554], ['them', 'TURKEYSAUCE1', 6, 4, 5, 4099, 3831, 2172],
  ['them', 'DIMARIA', 7, 6, 5, 3739, 1521, 1150], ['them', 'KLAUS', 10, 0, 6, 4348, 825, 0],
  ['them', 'ELLISICA', 6, 9, 3, 1756, 11674, 0], ['them', 'PSYCHOBUN', 5, 7, 4, 2918, 5049, 830],
];

describe('scoreboard fixture (Screenshot (36).png)', () => {
  test('fixture is a PNG on disk', () => {
    const b = fs.readFileSync(FIXTURE);
    assert.equal(b.subarray(1, 4).toString(), 'PNG');
  });
  // Calls the real Haiku API once. Opt in: SCOREBOARD_LIVE=1 npm test
  test('live: Haiku parses the 12 rows to the ground truth', { skip: process.env.SCOREBOARD_LIVE !== '1' }, async () => {
    const p = await callVision(FIXTURE);
    console.log('LIVE_PARSE ' + JSON.stringify(p));
    assert.equal(p.is_scoreboard, true);
    assert.equal(validateParsed(p), null);
    const got = p.rows.map(r => [r.team, r.player_name.toUpperCase(), r.e, r.a, r.d, r.dmg, r.h, r.mit]);
    assert.deepEqual(got, TRUTH);
    assert.ok(p.rows.every(r => !('hero' in r)), 'no hero field is requested any more');
    const found = resolveSelf(p.rows, ['Linx']);
    assert.ok('index' in found && p.rows[found.index].player_name.toUpperCase() === 'LINX');
  });
});
