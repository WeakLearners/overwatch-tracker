// Tier 3: "Add aim stats now" — POST /api/matches with an optional aim_stats
// block saves the match and its aim stats in one transaction. Closed fold-out
// (no aim_stats) must leave behaviour exactly as before: the match waits in
// the backlog (/api/aim/pending).
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

async function makeSet(hero: string, senses = [2.0, 3.0]) {
  const r = await h.post('/api/blind/sets', { hero, batch_size: 5, senses });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.set_id as number;
}
const base = {
  date: '2026-09-12', time: '12:00', hour: 12, hero: 'Ashe', role: 'DPS',
  map: 'Ilios', game_type: 'comp', win: true, queue_mode: 'comp_role',
};
const count = (sql: string) => (h.db.prepare(sql).get() as any).n as number;
const pendingIds = async () => ((await h.get('/api/aim/pending')).body.rows as any[]).map(r => r.id);
const credits = (id: number) =>
  (h.db.prepare('SELECT hero, counts_result r, counts_minutes m FROM blind_credits WHERE match_id = ? ORDER BY hero').all(id) as any[])
    .map(r => `${r.hero}:r${r.r}m${r.m}`);

describe('POST /api/matches with aim_stats', () => {
  test('closed fold-out (no aim_stats): match lands in the backlog, no stats rows', async () => {
    await makeSet('Ashe');
    const r = await h.post('/api/matches', base);
    assert.equal(r.status, 200);
    assert.deepEqual(await pendingIds(), [r.body.id]);
    assert.equal(count('SELECT COUNT(*) n FROM aim_stats'), 0);
  });

  test('open and filled: match + stats saved together, credits settled, not in the backlog', async () => {
    await makeSet('Ashe'); await makeSet('Cassidy', [5.0, 6.0]);
    const r = await h.post('/api/matches', {
      ...base, heroes: [{ hero: 'Cassidy', role: 'DPS' }],
      aim_stats: {
        heroes: [
          { hero: 'Ashe', overall_acc: 41.2, crit_acc: 20, duration_min: 6 },
          { hero: 'Cassidy', overall_acc: 38, duration_min: 4 },
        ],
        elims: 20, deaths: 5, damage: 9000,
      },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const id = r.body.id as number;
    assert.deepEqual(await pendingIds(), [], 'saved stats keep it out of the backlog');
    const a = h.db.prepare('SELECT elims, damage, duration_min FROM aim_stats WHERE match_id = ?').get(id) as any;
    assert.deepEqual({ ...a }, { elims: 20, damage: 9000, duration_min: 10 });
    assert.equal(count(`SELECT COUNT(*) n FROM aim_stats_heroes WHERE match_id = ${id}`), 2);
    // Same credit path as the backlog: both heroes >= 1/3 of the match -> a game each.
    assert.deepEqual(credits(id), ['Ashe:r1m1', 'Cassidy:r1m1']);
  });

  test('invalid stats: 400 and nothing is saved (no half-saved match)', async () => {
    await makeSet('Ashe');
    const bad = [
      { heroes: [{ hero: 'Ashe', overall_acc: 40 }] },                                  // no duration
      { heroes: [{ hero: 'Ashe', duration_min: 5 }] },                                  // no overall acc
      { heroes: [{ hero: 'Ashe', overall_acc: 140, duration_min: 5 }] },                // out of range
      { heroes: [{ hero: 'Cassidy', overall_acc: 40, duration_min: 5 }] },              // not on roster
      { heroes: [] },
    ];
    for (const aim_stats of bad) {
      const r = await h.post('/api/matches', { ...base, aim_stats });
      assert.equal(r.status, 400, JSON.stringify(aim_stats));
    }
    assert.equal(count('SELECT COUNT(*) n FROM matches'), 0);
    assert.equal(count('SELECT COUNT(*) n FROM blind_credits'), 0);
    assert.equal(count('SELECT COUNT(*) n FROM aim_stats'), 0);
  });
});
