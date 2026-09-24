// Tier 3: GET /api/stats/split over real HTTP (see test/httpHarness.ts) —
// the generic, registry-driven field split added 2026-09-24 as the
// field-registry prerequisite to Phase 2 (modular-tracking-roadmap.md).
//
// insertMatch's MatchInput doesn't carry match_quality/result_driver/
// leaver_side/team_rating (they're not needed by the other Tier 2/3 suites
// that use it), so these tests set them with a direct UPDATE after insert
// rather than growing that shared fixture for one test file.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';
import { insertMatch, insertAimStatsHero } from '../db/fixtures';

let h: Harness;

beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

function setField(h: Harness, id: number, col: string, value: string | number | null) {
  h.db.prepare(`UPDATE matches SET ${col} = :value WHERE id = :id`).run({ id, value });
}

describe('GET /api/stats/split', () => {
  test('unknown field is rejected with 400 and a reason', async () => {
    const r = await h.get('/api/stats/split?by=not_a_real_field');
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not_a_real_field/);
  });

  test('a registry field with no study tag is rejected with 400 (lobby_low is deliberately untagged)', async () => {
    const r = await h.get('/api/stats/split?by=lobby_low');
    assert.equal(r.status, 400);
  });

  test('leaver_side: whitelisted field returns groups, win_rate and accuracy both present', async () => {
    const m1 = insertMatch(h.db, { date: '2026-01-01', hero: 'Ashe', role: 'DPS', win: 1 });
    setField(h, m1, 'leaver_side', 'mine');
    insertAimStatsHero(h.db, { match_id: m1, hero: 'Ashe', overall_acc: 40 });

    const m2 = insertMatch(h.db, { date: '2026-01-02', hero: 'Ashe', role: 'DPS', win: 0 });
    setField(h, m2, 'leaver_side', 'theirs');
    insertAimStatsHero(h.db, { match_id: m2, hero: 'Ashe', overall_acc: 30 });

    // No leaver at all on this one — leaver_side stays NULL (never asked).
    const m3 = insertMatch(h.db, { date: '2026-01-03', hero: 'Ashe', role: 'DPS', win: 1 });

    const r = await h.get('/api/stats/split?by=leaver_side');
    assert.equal(r.status, 200);
    assert.equal(r.body.by, 'leaver_side');
    assert.deepEqual([...r.body.metrics].sort(), ['accuracy', 'win_rate']);
    assert.equal(r.body.unasked, 1);

    const mine = r.body.groups.find((g: any) => g.value === 'mine');
    assert.equal(mine.n, 1);
    assert.equal(mine.win_rate, 100);
    assert.equal(mine.n_acc, 1);
    assert.equal(mine.mean_acc, 40);

    const theirs = r.body.groups.find((g: any) => g.value === 'theirs');
    assert.equal(theirs.n, 1);
    assert.equal(theirs.win_rate, 0);
    assert.equal(theirs.mean_acc, 30);
  });

  test('result_driver: accuracy-only field — win_rate is null, mean_acc is populated', async () => {
    const m1 = insertMatch(h.db, { date: '2026-01-01', hero: 'Ana', role: 'Support', win: 1 });
    setField(h, m1, 'result_driver', 'me');
    insertAimStatsHero(h.db, { match_id: m1, hero: 'Ana', overall_acc: 50 });

    const r = await h.get('/api/stats/split?by=result_driver');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.metrics, ['accuracy']);
    const me = r.body.groups.find((g: any) => g.value === 'me');
    assert.equal(me.win_rate, null);
    assert.equal(me.n_acc, 1);
    assert.equal(me.mean_acc, 50);
  });

  test('rows with the field NULL are excluded from groups and counted in unasked', async () => {
    const m1 = insertMatch(h.db, { date: '2026-01-01', hero: 'Ashe', role: 'DPS', win: 1 });
    setField(h, m1, 'match_quality', 'stomp');
    const m2 = insertMatch(h.db, { date: '2026-01-02', hero: 'Ashe', role: 'DPS', win: 0 });
    // match_quality left NULL on m2.

    const r = await h.get('/api/stats/split?by=match_quality');
    assert.equal(r.status, 200);
    assert.equal(r.body.unasked, 1);
    assert.equal(r.body.groups.length, 1);
    assert.equal(r.body.groups[0].value, 'stomp');
    assert.equal(r.body.groups[0].n, 1);
  });
});
