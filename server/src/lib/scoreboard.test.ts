import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb, closeDb } from '../db/schema';
import {
  decideMatch, MATCH_WINDOW_MIN, processFile, rematchRecent, validateParsed, callVision, resolveSelf, recomputeScoreboards, storeScoreboard, systemPrompt, SCHEMA, TEAMS_PROMPT,
  type MatchCandidate, type ParsedRow, type ParsedScoreboard, type SelfRow,
} from './scoreboard';
import { pollOnce } from './scoreboardWatcher';
import { organizeBoard, organizeAll, windowsSafe, uniqueDest } from './scoreboardOrganize';
import { PATCH_BOUNDARIES } from './patchEra';

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
    // Only the Teams rules carry the no-hero guard; the Summary and Personal pages name heroes on purpose.
    assert.ok(!/hero name|portrait|Wrecking/i.test(TEAMS_PROMPT.replace('Do not report hero names.', '')));
    assert.ok(systemPrompt().includes(TEAMS_PROMPT));
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
  test('file-not-ready read errors never count as vision attempts and store nothing', async () => {
    const notReady = async () => { throw Object.assign(new Error('Unknown system error -11: Unknown system error -11, read'), { errno: -11, code: 'Unknown' }); };
    for (let i = 0; i < 5; i++) assert.equal(await processFile(db, '/x/d.png', MTIME, notReady), null);
    assert.equal((db.prepare(`SELECT count(*) n FROM match_scoreboards`).get() as any).n, 0);
    const boom = async () => { throw new Error('api down'); };
    assert.equal(await processFile(db, '/x/d.png', MTIME, boom), null);
    assert.equal(await processFile(db, '/x/d.png', MTIME, boom), null);
    assert.equal(await processFile(db, '/x/d.png', MTIME, boom), 'error');
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
  test('pollOnce leaves a file younger than minAgeMs for a later tick (Drive may still be writing it)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dir-'));
    fs.writeFileSync(path.join(dir, 'Screenshot (1).png'), 'x');
    let calls = 0; const v = async () => { calls++; return { is_scoreboard: false, rows: [] }; };
    assert.equal((await pollOnce(db, dir, v, 50, 5_000)).processed, 0);
    assert.equal(calls, 0);
    assert.equal((await pollOnce(db, dir, v, 50, 5_000, Date.now() + 6_000)).processed, 1);
    fs.rmSync(dir, { recursive: true });
  });
  test('pollOnce does not retry a file whose vision call failed until the backoff has passed', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dir-'));
    fs.writeFileSync(path.join(dir, 'Screenshot (1).png'), 'x');
    let calls = 0; const bad = async () => { calls++; throw new Error('api down'); };
    await pollOnce(db, dir, bad); assert.equal(calls, 1);
    await pollOnce(db, dir, bad); assert.equal(calls, 1, 'second tick inside the backoff makes no vision call');
    await pollOnce(db, dir, bad, 50, 0, Date.now() + 61_000); assert.equal(calls, 2);
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

describe('dismissed scoreboards', () => {
  test('POST dismiss: ok from unmatched/error, 409 from matched, hidden from list, counted as ignored', async () => {
    const { startHarness } = await import('../test/httpHarness');
    const h = await startHarness();
    try {
      const ins = (p: string, st: string) => Number(h.db.prepare(`INSERT INTO match_scoreboards (file_path, file_mtime, status) VALUES (?, ?, ?)`).run(p, new Date(MTIME).toISOString(), st).lastInsertRowid);
      const u = ins('/x/u.png', 'unmatched'), e = ins('/x/e.png', 'error'), m = ins('/x/m.png', 'matched');
      assert.equal((await h.post(`/api/scoreboards/${m}/dismiss`, {})).status, 409);
      assert.equal((await h.post(`/api/scoreboards/${u}/dismiss`, {})).status, 200);
      assert.equal((await h.post(`/api/scoreboards/${e}/dismiss`, {})).status, 200);
      assert.equal((await h.post(`/api/scoreboards/${u}/dismiss`, {})).status, 409);
      assert.equal((await h.post(`/api/scoreboards/9999/dismiss`, {})).status, 404);
      const row = h.db.prepare(`SELECT status, reason FROM match_scoreboards WHERE id = ?`).get(u) as any;
      assert.deepEqual({ ...row }, { status: 'dismissed', reason: 'dismissed by hand' });
      const list = await h.get('/api/scoreboards/unmatched');
      assert.equal(list.body.items.length, 0);
      assert.equal(list.body.ignored, 2);
    } finally { await h.close(); }
  });
  test('watcher skips a dismissed file; rematch and recompute leave it alone', async () => {
    const tmp = path.join(os.tmpdir(), `sb-dis-${process.pid}-${Date.now()}.db`);
    const db = getDb(tmp);
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-dis-dir-'));
      const f = path.join(dir, 'Screenshot (44).png');
      fs.writeFileSync(f, 'x');
      const mt = new Date(fs.statSync(f).mtimeMs).toISOString();
      const id = Number(db.prepare(`INSERT INTO match_scoreboards (file_path, file_mtime, status, reason) VALUES (?, ?, 'dismissed', 'dismissed by hand')`).run(f, mt).lastInsertRowid);
      db.prepare(`INSERT INTO matches (date, hero, role, map, game_type, win, account, created_at) VALUES ('2026-10-09','Mizuki','Support','Numbani','Competitive',1,'Linx',?)`).run(mt.replace('T', ' ').slice(0, 19));
      let calls = 0;
      assert.equal((await pollOnce(db, dir, async () => { calls++; return board(6); })).processed, 0);
      assert.equal(calls, 0);
      rematchRecent(db);
      recomputeScoreboards(db);
      const row = db.prepare(`SELECT status, match_id, reason FROM match_scoreboards WHERE id = ?`).get(id) as any;
      assert.deepEqual({ ...row }, { status: 'dismissed', match_id: null, reason: 'dismissed by hand' });
      fs.rmSync(dir, { recursive: true });
    } finally { closeDb(); for (const x of [tmp, `${tmp}-wal`, `${tmp}-shm`]) if (fs.existsSync(x)) fs.unlinkSync(x); }
  });
});

describe('rule 1 copies, rule 2 link by stats, file organizing', () => {
  let db: ReturnType<typeof getDb>; let tmp: string; let root: string;
  beforeEach(() => {
    tmp = path.join(os.tmpdir(), `sb-org-${process.pid}-${Date.now()}.db`); db = getDb(tmp);
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-root-'));
  });
  afterEach(() => { closeDb(); fs.rmSync(root, { recursive: true, force: true }); for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f); });
  const SINCE = PATCH_BOUNDARIES[PATCH_BOUNDARIES.length - 1];
  const addMatch = (createdAt: string, o: { date?: string; hero?: string; map?: string; account?: string } = {}) => Number(db.prepare(
    `INSERT INTO matches (date, hero, role, map, game_type, win, account, created_at) VALUES (?,?,'Support',?,'Competitive',1,?,?)`,
  ).run(o.date ?? '2026-10-09', o.hero ?? 'Mizuki', o.map ?? 'Numbani', o.account ?? 'Linx', createdAt).lastInsertRowid);
  // self row of board(): e1 a2 d3 dmg4 h5
  const addAim = (matchId: number, v: { elims: number | null; deaths: number | null; damage: number | null; assists: number | null; healing: number | null }) =>
    db.prepare(`INSERT INTO aim_stats (match_id, elims, deaths, damage, assists, healing) VALUES (?,?,?,?,?,?)`).run(matchId, v.elims, v.deaths, v.damage, v.assists, v.healing);
  const FAR = at(600); // no match logged near MTIME
  const mk = (name: string, ageMs = 5 * 60_000) => { const f = path.join(root, name); fs.writeFileSync(f, 'x'); const t = (Date.now() - ageMs) / 1000; fs.utimesSync(f, t, t); return f; };

  test('rule 1: same multiset in a different row order is a copy -> dismissed, no match, reason names the original', async () => {
    addMatch(at(5));
    assert.equal(await processFile(db, '/x/a.png', MTIME, async () => board(6)), 'matched');
    const b2 = board(6); b2.rows.reverse();
    assert.equal(await processFile(db, '/x/b.png', MTIME + 1000, async () => b2), 'dismissed');
    const sb = db.prepare(`SELECT status, reason, match_id FROM match_scoreboards WHERE file_path = '/x/b.png'`).get() as any;
    assert.deepEqual({ ...sb }, { status: 'dismissed', reason: 'copy of board 1', match_id: null });
  });
  test('rule 1: one differing value is not a copy', async () => {
    addMatch(at(5));
    await processFile(db, '/x/a.png', MTIME, async () => board(6));
    const b2 = board(6); b2.rows[0].dmg += 1;
    assert.notEqual(await processFile(db, '/x/b.png', MTIME + 1000, async () => b2), 'dismissed');
  });
  test('rule 2: zero window candidates, exactly one stats hit -> matched, linked by stats', async () => {
    const id = addMatch(FAR, { date: SINCE });
    addAim(id, { elims: 1, deaths: 3, damage: 4, assists: 2, healing: 5 });
    assert.equal(await processFile(db, '/x/a.png', MTIME, async () => board(6)), 'matched');
    assert.deepEqual({ ...(db.prepare(`SELECT match_id, reason FROM match_scoreboards`).get() as any) }, { match_id: id, reason: 'linked by stats' });
  });
  test('rule 2: null assists and healing are not compared', async () => {
    const id = addMatch(FAR, { date: SINCE });
    addAim(id, { elims: 1, deaths: 3, damage: 4, assists: null, healing: null });
    assert.equal(await processFile(db, '/x/a.png', MTIME, async () => board(6)), 'matched');
    assert.equal((db.prepare(`SELECT match_id FROM match_scoreboards`).get() as any).match_id, id);
  });
  test('rule 2: non-null assists that differ -> unmatched', async () => {
    const id = addMatch(FAR, { date: SINCE });
    addAim(id, { elims: 1, deaths: 3, damage: 4, assists: 99, healing: 5 });
    assert.equal(await processFile(db, '/x/a.png', MTIME, async () => board(6)), 'unmatched');
  });
  test('rule 2: zero hits -> unmatched', async () => {
    addMatch(FAR, { date: SINCE }); // gives the account a name; no aim_stats row
    assert.equal(await processFile(db, '/x/a.png', MTIME, async () => board(6)), 'unmatched');
  });
  test('rule 2: two hits -> unmatched, never nearest', async () => {
    for (const t of [FAR, at(700)]) addAim(addMatch(t, { date: SINCE }), { elims: 1, deaths: 3, damage: 4, assists: 2, healing: 5 });
    assert.equal(await processFile(db, '/x/a.png', MTIME, async () => board(6)), 'unmatched');
  });
  test('rule 2 ignores matches before the latest patch boundary and ones that already have a scoreboard', async () => {
    const old = addMatch(FAR, { date: '2026-10-05' });
    addAim(old, { elims: 1, deaths: 3, damage: 4, assists: 2, healing: 5 });
    assert.equal(await processFile(db, '/x/a.png', MTIME, async () => board(6)), 'unmatched');
    const ok = addMatch(at(700), { date: SINCE });
    addAim(ok, { elims: 1, deaths: 3, damage: 4, assists: 2, healing: 5 });
    db.prepare(`INSERT INTO match_scoreboards (match_id, file_path, file_mtime, status) VALUES (?, '/x/z.png', ?, 'matched')`).run(ok, new Date(MTIME).toISOString());
    assert.equal(await processFile(db, '/x/b.png', MTIME + 5000, async () => { const b = board(6); b.rows[0].e = 5; return b; }), 'unmatched');
  });
  test('rule 2 applies in rematchRecent', async () => {
    addMatch(at(900), { date: '2026-10-01' }); // gives the account a name
    await processFile(db, '/x/a.png', MTIME, async () => board(6));
    assert.equal((db.prepare(`SELECT status FROM match_scoreboards`).get() as any).status, 'unmatched');
    const id = addMatch(FAR, { date: SINCE });
    addAim(id, { elims: 1, deaths: 3, damage: 4, assists: 2, healing: 5 });
    assert.equal(rematchRecent(db, MTIME + 60_000), 1);
    assert.deepEqual({ ...(db.prepare(`SELECT match_id, reason FROM match_scoreboards`).get() as any) }, { match_id: id, reason: 'linked by stats' });
  });

  test('Windows-safe names and collision suffix', () => {
    assert.equal(windowsSafe('3836 Numbani Soldier: 76'), '3836 Numbani Soldier- 76');
    assert.equal(windowsSafe('a<b>c:d"e/f\\g|h?i*j'), 'a-b-c-d-e-f-g-h-i-j');
    fs.writeFileSync(path.join(root, 'x.png'), '1');
    assert.equal(path.basename(uniqueDest(root, 'x', '.png')), 'x (2).png');
    fs.writeFileSync(path.join(root, 'x (2).png'), '1');
    assert.equal(path.basename(uniqueDest(root, 'x', '.png')), 'x (3).png');
  });
  test('matched file moves to <match date>/<id> <Map> <Hero>.png and file_path follows', () => {
    const m = addMatch(at(5), { hero: 'Soldier: 76', map: 'King\'s Row' });
    const f = mk('Screenshot (1).png');
    db.prepare(`INSERT INTO match_scoreboards (match_id, file_path, file_mtime, status) VALUES (?, ?, ?, 'matched')`).run(m, f, new Date(MTIME).toISOString());
    const dest = organizeBoard(db, 1, root);
    assert.equal(dest, path.join(root, '2026-10-09', `${m} King's Row Soldier- 76.png`));
    assert.ok(fs.existsSync(dest!) && !fs.existsSync(f));
    assert.equal((db.prepare(`SELECT file_path FROM match_scoreboards`).get() as any).file_path, dest);
    assert.equal(organizeBoard(db, 1, root), null); // idempotent
  });
  test('name collision gets (2); statuses route to _other, _copies, _needs-attention', () => {
    const m = addMatch(at(5)); const m2 = addMatch(at(6));
    fs.mkdirSync(path.join(root, '2026-10-09'));
    fs.writeFileSync(path.join(root, '2026-10-09', `${m} Numbani Mizuki.png`), 'taken');
    const ins = (name: string, st: string, mid: number | null, mtime = new Date(MTIME).toISOString()) =>
      db.prepare(`INSERT INTO match_scoreboards (match_id, file_path, file_mtime, status) VALUES (?, ?, ?, ?)`).run(mid, mk(name), mtime, st);
    ins('a.png', 'matched', m); ins('b.png', 'not_scoreboard', null); ins('c.png', 'dismissed', null); ins('d.png', 'error', null);
    ins('e.png', 'unmatched', null); // MTIME is past the grace window versus now
    ins('f.png', 'unmatched', null, new Date().toISOString()); // fresh: stays on top
    ins('g.png', 'matched', m2);
    assert.equal(organizeAll(db, root), 6);
    const find = (n: string) => path.relative(root, (db.prepare(`SELECT file_path p FROM match_scoreboards WHERE file_path LIKE ?`).get(`%${n}`) as any)?.p ?? '');
    assert.equal(fs.readFileSync(path.join(root, '2026-10-09', `${m} Numbani Mizuki.png`), 'utf8'), 'taken');
    assert.ok(fs.existsSync(path.join(root, '2026-10-09', `${m} Numbani Mizuki (2).png`)));
    assert.ok(fs.existsSync(path.join(root, '2026-10-09', `${m2} Numbani Mizuki.png`)));
    assert.ok(fs.existsSync(path.join(root, '_other', 'b.png')));
    assert.ok(fs.existsSync(path.join(root, '_copies', 'c.png')));
    assert.ok(fs.existsSync(path.join(root, '_needs-attention', 'd.png')));
    assert.ok(fs.existsSync(path.join(root, '_needs-attention', 'e.png')));
    assert.ok(fs.existsSync(path.join(root, 'f.png')));
    assert.equal(find('f.png'), 'f.png');
  });
  test('move skipped when the file mtime is under 60 s', () => {
    const m = addMatch(at(5));
    const f = mk('fresh.png', 10_000);
    db.prepare(`INSERT INTO match_scoreboards (match_id, file_path, file_mtime, status) VALUES (?, ?, ?, 'matched')`).run(m, f, new Date(MTIME).toISOString());
    assert.equal(organizeBoard(db, 1, root), null);
    assert.ok(fs.existsSync(f));
    assert.equal((db.prepare(`SELECT file_path FROM match_scoreboards`).get() as any).file_path, f);
  });
  test('move failure leaves file and row unchanged', () => {
    const m = addMatch(at(5));
    const f = mk('stuck.png');
    db.prepare(`INSERT INTO match_scoreboards (match_id, file_path, file_mtime, status) VALUES (?, ?, ?, 'matched')`).run(m, f, new Date(MTIME).toISOString());
    fs.writeFileSync(path.join(root, '2026-10-09'), 'a file where the folder should be'); // mkdir/rename must fail
    assert.equal(organizeBoard(db, 1, root), null);
    assert.ok(fs.existsSync(f));
    assert.equal((db.prepare(`SELECT file_path FROM match_scoreboards`).get() as any).file_path, f);
  });
  test('row update failure renames the file back', () => {
    const m = addMatch(at(5));
    const f = mk('back.png');
    db.prepare(`INSERT INTO match_scoreboards (match_id, file_path, file_mtime, status) VALUES (?, ?, ?, 'matched')`).run(m, f, new Date(MTIME).toISOString());
    db.prepare(`INSERT INTO match_scoreboards (match_id, file_path, file_mtime, status) VALUES (NULL, ?, ?, 'error')`).run(path.join(root, '2026-10-09', `${m} Numbani Mizuki.png`), new Date(MTIME).toISOString()); // UNIQUE clash on the new path
    assert.equal(organizeBoard(db, 1, root), null);
    assert.ok(fs.existsSync(f));
    assert.equal((db.prepare(`SELECT file_path FROM match_scoreboards WHERE id = 1`).get() as any).file_path, f);
  });
  test('files outside the folder are never moved', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-out-'));
    const f = path.join(outside, 'o.png'); fs.writeFileSync(f, 'x'); fs.utimesSync(f, 1000, 1000);
    db.prepare(`INSERT INTO match_scoreboards (file_path, file_mtime, status) VALUES (?, ?, 'error')`).run(f, new Date(MTIME).toISOString());
    assert.equal(organizeBoard(db, 1, root), null);
    assert.ok(fs.existsSync(f));
    fs.rmSync(outside, { recursive: true });
  });
  test('watcher scans only the top level: an unknown image inside a subfolder is ignored', async () => {
    fs.mkdirSync(path.join(root, '_other'));
    const f = path.join(root, '_other', 'hidden.png'); fs.writeFileSync(f, 'x');
    let calls = 0;
    const r = await pollOnce(db, root, async () => { calls++; return { is_scoreboard: false, rows: [] }; });
    assert.equal(r.processed, 0); assert.equal(calls, 0);
  });
  test('pollOnce files a processed image after it is old enough, and does not reprocess it', async () => {
    const f = mk('Screenshot (9).png');
    let calls = 0; const v = async () => { calls++; return { is_scoreboard: false, rows: [] }; };
    assert.equal((await pollOnce(db, root, v)).processed, 1);
    assert.ok(fs.existsSync(path.join(root, '_other', 'Screenshot (9).png')) && !fs.existsSync(f));
    assert.equal((await pollOnce(db, root, v)).processed, 0);
    assert.equal(calls, 1);
  });
  test('HTTP attach moves the file to the date folder; dismiss moves it to _copies', async () => {
    process.env.SCOREBOARD_DIR = root;
    const { startHarness } = await import('../test/httpHarness');
    const h = await startHarness();
    try {
      const mid = Number(h.db.prepare(`INSERT INTO matches (date, hero, role, map, game_type, win, account, created_at) VALUES ('2026-10-09','Mizuki','Support','Numbani','Competitive',1,'Linx','2026-10-09 20:00:00')`).run().lastInsertRowid);
      const f1 = mk('one.png'), f2 = mk('two.png');
      const ins = (p: string) => Number(h.db.prepare(`INSERT INTO match_scoreboards (file_path, file_mtime, status) VALUES (?, ?, 'unmatched')`).run(p, new Date(MTIME).toISOString()).lastInsertRowid);
      const a = ins(f1), d = ins(f2);
      assert.equal((await h.post(`/api/scoreboards/${a}/attach`, { match_id: mid })).status, 200);
      assert.ok(fs.existsSync(path.join(root, '2026-10-09', `${mid} Numbani Mizuki.png`)) && !fs.existsSync(f1));
      assert.equal((await h.post(`/api/scoreboards/${d}/dismiss`, {})).status, 200);
      assert.ok(fs.existsSync(path.join(root, '_copies', 'two.png')) && !fs.existsSync(f2));
    } finally { delete process.env.SCOREBOARD_DIR; await h.close(); }
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
