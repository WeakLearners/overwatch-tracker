// Play-time shares (2026-10-10): a match with a linked Summary credits each hero by its
// share; a match without one credits the start hero 1.0. Reads are over real HTTP.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';
import { insertSoloMatch } from '../db/fixtures';
import { heroShares, sharesFromSummary } from './heroShares';

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

let n = 0;
function addSummary(matchId: number, heroes: { hero: string; percent: number; play_time?: string }[], status = 'matched') {
  const raw = { is_scoreboard: false, page_type: 'summary', rows: [], personal: { hero: '', tiles: [] },
    summary: { map: 'Nepal', result: 'victory', score_us: 2, score_them: 0, game_mode: 'CONTROL', date_text: '10/10/26 - 12:00', game_length: '10:00',
      heroes: heroes.map(x => ({ play_time: '05:00', ...x })), elims: 1, assists: 0, deaths: 0 } };
  h.db.prepare(`INSERT INTO match_scoreboards (match_id, file_path, file_mtime, status, page_type, raw_json) VALUES (?, ?, ?, ?, 'summary', ?)`)
    .run(matchId, `/x/s${++n}.png`, '2026-10-10T16:00:00.000Z', status, JSON.stringify(raw));
}
const mk = (hero: string, role: string, win: 0 | 1, date = '2026-10-10') => insertSoloMatch(h.db, { date, hero, role, win, queue_mode: 'comp_role', game_type: 'Hybrid', map: 'Nepal' });
const rowOf = (rows: any[], hero: string) => rows.find(r => r.hero === hero);

describe('heroShares', () => {
  test('Pharah 97 / Ashe 3, logged Ashe: credits Pharah 0.97 and Ashe 0.03', () => {
    const id = mk('Ashe', 'DPS', 1);
    addSummary(id, [{ hero: 'PHARAH', percent: 97 }, { hero: 'ASHE', percent: 3 }]);
    const s = heroShares(h.db, [id]).get(id)!;
    assert.deepEqual(s.map(x => x.hero), ['Pharah', 'Ashe']);
    assert.ok(Math.abs(s[0].share - 0.97) < 1e-9 && Math.abs(s[1].share - 0.03) < 1e-9);
  });
  test('no Summary: the start hero gets 1.0', () => {
    const id = mk('Ashe', 'DPS', 1);
    assert.deepEqual(heroShares(h.db, [id]).get(id), [{ hero: 'Ashe', share: 1 }]);
    assert.deepEqual(heroShares(h.db).get(id), [{ hero: 'Ashe', share: 1 }]);
  });
  test('an unmapped hero is dropped and the rest renormalise', () => {
    assert.deepEqual(sharesFromSummary([{ hero: 'Pharah', percent: 60 }, { hero: null, percent: 20 }, { hero: 'Ashe', percent: 20 }]),
      [{ hero: 'Pharah', share: 0.75 }, { hero: 'Ashe', share: 0.25 }]);
    const id = mk('Ashe', 'DPS', 1);
    addSummary(id, [{ hero: 'PHARAH', percent: 60 }, { hero: 'NOTAHERO', percent: 20 }, { hero: 'ASHE', percent: 20 }]);
    const s = heroShares(h.db, [id]).get(id)!;
    assert.equal(s.reduce((t, x) => t + x.share, 0), 1);
    assert.deepEqual(s.map(x => [x.hero, x.share]), [['Pharah', 0.75], ['Ashe', 0.25]]);
  });
  test('nothing maps, or a dismissed Summary: falls back to the start hero', () => {
    const a = mk('Ashe', 'DPS', 1); addSummary(a, [{ hero: 'NOTAHERO', percent: 100 }]);
    const b = mk('Ashe', 'DPS', 1); addSummary(b, [{ hero: 'PHARAH', percent: 100 }], 'dismissed');
    assert.deepEqual(heroShares(h.db, [a, b]).get(a), [{ hero: 'Ashe', share: 1 }]);
    assert.deepEqual(heroShares(h.db, [a, b]).get(b), [{ hero: 'Ashe', share: 1 }]);
  });
});

describe('GET /api/stats by-hero and hero-detail use the shares', () => {
  test('weighted games and wins; whole numbers stay integers; a no-Summary match counts 1', async () => {
    const win = mk('Ashe', 'DPS', 1); addSummary(win, [{ hero: 'PHARAH', percent: 97 }, { hero: 'ASHE', percent: 3 }]);
    const loss = mk('Ashe', 'DPS', 0); addSummary(loss, [{ hero: 'PHARAH', percent: 50 }, { hero: 'ASHE', percent: 50 }]);
    for (let i = 0; i < 3; i++) mk('Ashe', 'DPS', 1);   // plain Ashe matches, share 1
    for (let i = 0; i < 3; i++) mk('Pharah', 'DPS', 0); // plain Pharah matches
    const r = await h.get('/api/stats/by-hero');
    const ashe = rowOf(r.body, 'Ashe'), pharah = rowOf(r.body, 'Pharah');
    // Ashe: 0.03 + 0.5 + 3 = 3.53 -> 3.5 shown; wins 0.03 + 3 = 3.03 -> 3
    assert.deepEqual([ashe.games, ashe.wins], [3.5, 3]);
    assert.equal(ashe.win_rate, Math.round(3.03 / 3.53 * 1000) / 10);
    // Pharah: 0.97 + 0.5 + 3 = 4.47 -> 4.5; wins 0.97 -> 1
    assert.deepEqual([pharah.games, pharah.wins], [4.5, 1]);
    assert.equal(pharah.win_rate, Math.round(0.97 / 4.47 * 1000) / 10);
    const d = await h.get('/api/stats/hero-detail/Pharah');
    assert.deepEqual([d.body.overall.games, d.body.overall.wins, d.body.overall.losses], [4.5, 1, 3.5]);
    // The queue filter still applies to the weighted rows.
    const none = await h.get('/api/stats/by-hero?queue_mode=qp_role');
    assert.deepEqual(none.body, []);
  });
  test('a whole-number total prints as an integer', async () => {
    const a = mk('Ashe', 'DPS', 1); addSummary(a, [{ hero: 'ASHE', percent: 100 }]);
    mk('Ashe', 'DPS', 0); mk('Ashe', 'DPS', 1);
    const r = await h.get('/api/stats/by-hero');
    assert.equal(rowOf(r.body, 'Ashe').games, 3);
  });
  test('matches.hero is untouched', async () => {
    const id = mk('Ashe', 'DPS', 1); addSummary(id, [{ hero: 'PHARAH', percent: 97 }, { hero: 'ASHE', percent: 3 }]);
    await h.get('/api/stats/by-hero');
    assert.equal((h.db.prepare('SELECT hero FROM matches WHERE id = ?').get(id) as any).hero, 'Ashe');
  });
});
