// Split plan B6 proof: the nightly report built from a replica filled through
// lab/client.ts (v1 API over real HTTP) must be byte-identical to the report
// built straight from the tracker's own database file, on the same fixture.
// The test never posts to Slack: it only calls buildReport.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';
import {
  insertMatch, insertHeroSlot, insertAimStats, insertAimStatsHero,
  insertBlindSet, insertBlindStage, insertBlindCredit,
} from '../db/fixtures';
import { createLabClient } from '../lab/client';
import { buildReplica } from '../lab/replica';
import { buildReport } from './nightlyReport';
import { setCurveParams } from '../lib/curveParams';

let h: Harness;
beforeEach(async () => {
  h = await startHarness();
});
afterEach(async () => { await h.close(); });

// The harness has no port accessor, so lab-client fetches go through h.get
// (real HTTP to the real v1 router) instead of a raw URL.
async function client() {
  const fetchImpl = (async (url: string) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    const r = await h.get(path);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, text: async () => JSON.stringify(r.body) } as Response;
  }) as unknown as typeof fetch;
  return createLabClient({ baseUrl: 'http://tracker.invalid', fetchImpl });
}

const TODAY = '2026-10-03';

function day(offset: number): string {
  const d = new Date(Date.UTC(2026, 9, 3 - offset));
  return d.toISOString().slice(0, 10);
}

// One logged game with a hero slot, match-level stats and a per-hero accuracy row.
function game(o: {
  date: string; hero: string; sens: number | null; acc: number | null; win?: 0 | 1;
  setId?: number; stage?: number; queue?: string; dmg?: number; mins?: number;
}) {
  const id = insertMatch(h.db, {
    date: o.date, hero: o.hero, role: 'DPS', win: o.win ?? 1, sens: o.sens, dpi: 800, queue_mode: o.queue ?? 'comp_role',
    blind_trial: o.setId ? 1 : 0, blind_set_id: o.setId ?? null, stage_index: o.stage ?? null,
  });
  insertHeroSlot(h.db, { match_id: id, slot: 1, hero: o.hero, role: 'DPS', sens: o.sens });
  if (o.acc !== null) {
    insertAimStats(h.db, { match_id: id, overall_acc: o.acc, damage: o.dmg ?? 9000, elims: 20, deaths: 5, duration_min: o.mins ?? 10 });
    insertAimStatsHero(h.db, { match_id: id, hero: o.hero, overall_acc: o.acc, duration_min: o.mins ?? 10 });
  }
  if (o.setId) insertBlindCredit(h.db, { match_id: id, hero: o.hero, blind_set_id: o.setId, stage_index: o.stage ?? 1 });
  return id;
}

async function both() {
  const direct = buildReport(h.db, TODAY);
  const replica = await buildReplica(await client());
  const viaClient = buildReport(replica, TODAY);
  return { direct, viaClient };
}

describe('nightly report: direct database path vs lab client path', () => {
  test('rich fixture: same text, and the sweep section is not vacuous', async () => {
    setCurveParams(h.db, { smooth: 0.3, input: 12, output: 1.4, lutSteps: 8, lutMaxSpeed: 40, lutPoints: null });
    // Sweep input: 4 sens scales x 10 games, accuracy rising with sens, with spread.
    const scales = [2.0, 2.5, 3.0, 3.5];
    scales.forEach((s, i) => {
      for (let k = 0; k < 10; k++) game({ date: day(1 + ((i * 10 + k) % 20)), hero: 'Ana', sens: s, acc: 30 + i * 4 + (k % 3), win: (k % 2) as 0 | 1, dmg: 8000 + i * 500 + k * 10 });
    });
    // Active 3-stage set with credits (bracket peak path) plus a QP credit that must be excluded.
    const set = insertBlindSet(h.db, { hero: 'Ana', batch_size: 6 });
    [[1, 2.4], [2, 2.8], [3, 3.2]].forEach(([si, sens]) => insertBlindStage(h.db, { set_id: set, stage_index: si, sens }));
    [[1, 40], [2, 47], [3, 41]].forEach(([si, acc]) => {
      for (let k = 0; k < 5; k++) game({ date: day(2), hero: 'Ana', sens: 2.5, acc: acc + (k % 3), setId: set, stage: si });
    });
    game({ date: day(2), hero: 'Ana', sens: 2.5, acc: 90, setId: set, stage: 2, queue: 'qp_role' });
    // Active 2-stage set (head-to-head path).
    const set2 = insertBlindSet(h.db, { hero: 'Ashe', batch_size: 4 });
    [[1, 3.0], [2, 3.4]].forEach(([si, sens]) => insertBlindStage(h.db, { set_id: set2, stage_index: si, sens }));
    [[1, 44], [2, 38]].forEach(([si, acc]) => { for (let k = 0; k < 4; k++) game({ date: day(3), hero: 'Ashe', sens: 3.0, acc: acc + k, setId: set2, stage: si }); });
    // Today: two heroes, one switch match, one with no accuracy, one crashed.
    game({ date: TODAY, hero: 'Ana', sens: 3.0, acc: 55 });
    game({ date: TODAY, hero: 'Ashe', sens: 3.0, acc: 31 });
    game({ date: TODAY, hero: 'Ana', sens: 3.0, acc: null });
    const sw = game({ date: TODAY, hero: 'Ana', sens: 3.0, acc: 41 });
    insertHeroSlot(h.db, { match_id: sw, slot: 2, hero: 'Mercy', role: 'Support', sens: 2.8 });
    insertAimStatsHero(h.db, { match_id: sw, hero: 'Mercy', overall_acc: 25, duration_min: 4 });
    const crashed = insertMatch(h.db, { date: TODAY, hero: 'Ana', role: 'DPS', win: 0 });
    h.db.prepare('UPDATE matches SET crashed = 1 WHERE id = :id').run({ id: crashed });

    const { direct, viaClient } = await both();
    assert.ok(direct, 'fixture must produce a report');
    assert.equal(viaClient, direct);
    assert.match(direct!, /Bracket reads/);
    assert.match(direct!, /\*Ana\* — /, 'sweep must report at least one finding so the comparison covers it');
    assert.match(direct!, /Data gaps/);
  });

  test('quiet fixture: same "nothing clears the bar" text', async () => {
    game({ date: TODAY, hero: 'Ana', sens: 3.0, acc: 50 });
    const { direct, viaClient } = await both();
    assert.ok(direct);
    assert.match(direct!, /nothing clears the bar/);
    assert.equal(viaClient, direct);
  });

  test('no matches today: both paths return null (no Slack post)', async () => {
    game({ date: day(1), hero: 'Ana', sens: 3.0, acc: 50 });
    const { direct, viaClient } = await both();
    assert.equal(direct, null);
    assert.equal(viaClient, null);
  });
});
