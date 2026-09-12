// Tier 3: POST /api/aim upsert semantics over real HTTP (see
// test/httpHarness.ts). Named aim.upsert.test.ts rather than aim.routes.test.ts
// so it reads as a companion to the existing aim.test.ts (Tier 2, the pure
// computeAnalysis tests) instead of appearing to supersede it.
//
// match_id is the primary key on aim_stats and (match_id, hero) on
// aim_stats_heroes, so re-submitting the form corrects a prior entry instead of
// erroring. That makes correction the normal path, not an edge case — and
// correction is where the defect below lives:
//
//   BUG — the upsert writes every hero in the payload but never removes a hero
//   that has DISAPPEARED from it. Correcting a match down to the heroes that
//   were actually played leaves the mistaken hero's accuracy row behind, still
//   attached to the match, still feeding per-hero aim analysis. There is no way
//   to withdraw it through the API at all.
//
// Verified read-only against the live database on 2026-09-12: zero orphaned
// rows today (no aim_stats_heroes row lacks a matching match_heroes slot), so
// this has never actually fired in production — it is latent, not historical.
// No data repair is implied by these tests.
//
// Pins current behavior per this repo's CLAUDE.md: a test that finds a real bug
// reports it rather than quietly fixing it. Flip the marked assertion when the
// fix lands.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';

let h: Harness;

beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

async function logMatch(body: Record<string, unknown> = {}) {
  const r = await h.post('/api/matches', {
    date: '2026-09-12', time: '12:00', hour: 12, hero: 'Ashe', role: 'DPS',
    map: 'Ilios', game_type: 'comp', win: true, queue_mode: 'comp_role', ...body,
  });
  assert.equal(r.status, 200);
  return r.body.id as number;
}

const heroStats = (matchId: number) =>
  (h.db.prepare('SELECT hero, overall_acc, crit_acc, duration_min FROM aim_stats_heroes WHERE match_id = ? ORDER BY hero')
    .all(matchId) as unknown as any[])
    .map(r => ({ hero: r.hero, overall_acc: r.overall_acc, crit_acc: r.crit_acc, duration_min: r.duration_min }));

const matchStats = (matchId: number) =>
  h.db.prepare('SELECT elims, deaths, damage, healing, assists, duration_min FROM aim_stats WHERE match_id = ?')
    .get(matchId) as any;

describe('POST /api/aim — validation', () => {
  test('400 when match_id is missing', async () => {
    const r = await h.post('/api/aim', { heroes: [] });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /match_id required/);
  });

  test('404 for a match that does not exist — no orphan stats row is created', async () => {
    const r = await h.post('/api/aim', { match_id: 99999, heroes: [{ hero: 'Ashe', overall_acc: 40 }] });
    assert.equal(r.status, 404);
    assert.equal((h.db.prepare('SELECT COUNT(*) n FROM aim_stats').get() as any).n, 0);
    assert.equal((h.db.prepare('SELECT COUNT(*) n FROM aim_stats_heroes').get() as any).n, 0);
  });

  test('an entry with no hero name is dropped rather than written as a nameless row', async () => {
    const id = await logMatch();
    await h.post('/api/aim', {
      match_id: id,
      heroes: [{ hero: 'Ashe', overall_acc: 40 }, { overall_acc: 55 }, { hero: '', overall_acc: 60 }],
    });
    assert.deepEqual(heroStats(id).map(r => r.hero), ['Ashe']);
  });
});

describe('POST /api/aim — upsert on resubmit', () => {
  test('resubmitting updates in place instead of duplicating', async () => {
    const id = await logMatch();
    await h.post('/api/aim', { match_id: id, elims: 20, damage: 9000, heroes: [{ hero: 'Ashe', overall_acc: 40, crit_acc: 20 }] });
    await h.post('/api/aim', { match_id: id, elims: 22, damage: 9500, heroes: [{ hero: 'Ashe', overall_acc: 41, crit_acc: 21 }] });

    assert.deepEqual(heroStats(id), [{ hero: 'Ashe', overall_acc: 41, crit_acc: 21, duration_min: null }]);
    const m = matchStats(id);
    assert.equal(m.elims, 22);
    assert.equal(m.damage, 9500);
    assert.equal((h.db.prepare('SELECT COUNT(*) n FROM aim_stats WHERE match_id = ?').get(id) as any).n, 1);
  });

  test('omitted combat fields are cleared, not silently carried forward', async () => {
    const id = await logMatch();
    await h.post('/api/aim', { match_id: id, elims: 20, deaths: 5, damage: 9000, healing: 100, assists: 7, heroes: [] });
    await h.post('/api/aim', { match_id: id, elims: 20, heroes: [] });

    // The UPDATE SET lists these columns explicitly, so a resubmit that leaves
    // them out writes null. Worth pinning: it means a partial resubmit is a
    // full replacement of the scoreboard, not a patch.
    const m = matchStats(id);
    assert.equal(m.elims, 20);
    assert.equal(m.deaths, null);
    assert.equal(m.damage, null);
    assert.equal(m.healing, null);
    assert.equal(m.assists, null);
  });

  test('match-level duration is the sum of the per-hero durations', async () => {
    const id = await logMatch({ heroes: [{ hero: 'Cassidy', role: 'DPS' }] });
    await h.post('/api/aim', {
      match_id: id,
      heroes: [{ hero: 'Ashe', overall_acc: 40, duration_min: 6 }, { hero: 'Cassidy', overall_acc: 50, duration_min: 4 }],
    });
    assert.equal(matchStats(id).duration_min, 10, 'rate stats operate on the whole match');
  });

  test('duration is null, not 0, when no hero reported one', async () => {
    const id = await logMatch();
    await h.post('/api/aim', { match_id: id, heroes: [{ hero: 'Ashe', overall_acc: 40 }] });
    // 0 would read as "played for zero minutes" and divide into the per-10-min
    // rate stats; null correctly reads as "not recorded".
    assert.equal(matchStats(id).duration_min, null);
  });
});

describe('POST /api/aim — removing a hero on correction', () => {
  test('BUG: a hero dropped from the payload keeps its accuracy row forever', async () => {
    const id = await logMatch({ heroes: [{ hero: 'Cassidy', role: 'DPS' }] });
    await h.post('/api/aim', {
      match_id: id,
      heroes: [{ hero: 'Ashe', overall_acc: 40, duration_min: 6 }, { hero: 'Cassidy', overall_acc: 50, duration_min: 4 }],
    });
    assert.deepEqual(heroStats(id).map(r => r.hero), ['Ashe', 'Cassidy']);

    // The correction: Cassidy was entered by mistake, so resubmit with Ashe
    // alone and the full 10 minutes.
    await h.post('/api/aim', { match_id: id, heroes: [{ hero: 'Ashe', overall_acc: 41, duration_min: 10 }] });

    // Ashe updates correctly...
    assert.deepEqual(heroStats(id).find(r => r.hero === 'Ashe'),
      { hero: 'Ashe', overall_acc: 41, crit_acc: null, duration_min: 10 });
    // ...and Cassidy survives the correction untouched. <-- THE BUG. The loop
    // only ever INSERTs or UPDATEs the heroes present in the payload; nothing
    // deletes the ones that left. Flip this to assert Cassidy is gone once the
    // handler deletes rows absent from the submitted list.
    assert.deepEqual(heroStats(id).find(r => r.hero === 'Cassidy'),
      { hero: 'Cassidy', overall_acc: 50, crit_acc: null, duration_min: 4 },
      'stale hero row survives — correcting the match cannot remove it');
  });

  test('BUG: the stale row makes match duration disagree with the per-hero sum', async () => {
    const id = await logMatch({ heroes: [{ hero: 'Cassidy', role: 'DPS' }] });
    await h.post('/api/aim', {
      match_id: id,
      heroes: [{ hero: 'Ashe', overall_acc: 40, duration_min: 6 }, { hero: 'Cassidy', overall_acc: 50, duration_min: 4 }],
    });
    await h.post('/api/aim', { match_id: id, heroes: [{ hero: 'Ashe', overall_acc: 41, duration_min: 10 }] });

    // aim_stats.duration_min is recomputed from the payload (10), but the
    // surviving hero rows now sum to 14. The two are documented as the same
    // quantity, so any consumer that trusts either one is reading a different
    // match length depending on which table it asked.
    const perHeroSum = heroStats(id).reduce((s, r) => s + (r.duration_min ?? 0), 0);
    assert.equal(matchStats(id).duration_min, 10);
    assert.equal(perHeroSum, 14);
    assert.notEqual(matchStats(id).duration_min, perHeroSum, 'the two disagree by exactly the removed hero');
  });

  test('BUG: the phantom hero is still attached to a match it was never played in', async () => {
    const id = await logMatch({ heroes: [{ hero: 'Cassidy', role: 'DPS' }] });
    await h.post('/api/aim', {
      match_id: id,
      heroes: [{ hero: 'Ashe', overall_acc: 40 }, { hero: 'Cassidy', overall_acc: 95 }],
    });
    // Fix the roster too, the way the edit drawer would — Cassidy was never played.
    assert.equal((await h.put(`/api/matches/${id}`, { heroes: [] })).status, 200);
    await h.post('/api/aim', { match_id: id, heroes: [{ hero: 'Ashe', overall_acc: 40 }] });

    const slots = (h.db.prepare('SELECT hero FROM match_heroes WHERE match_id = ?').all(id) as unknown as any[]).map(r => r.hero);
    assert.deepEqual(slots, ['Ashe'], 'the roster edit worked — Cassidy is off the match');

    // But the aim row remains, now with no slot to belong to. This is the
    // shape the live-DB audit searched for and found zero of; it is reachable
    // purely through the API, with no direct SQL involved.
    const orphans = heroStats(id).filter(r => !slots.includes(r.hero));
    assert.deepEqual(orphans.map(r => r.hero), ['Cassidy'],
      'aim_stats_heroes row outlives the roster entry that justified it');
  });
});
