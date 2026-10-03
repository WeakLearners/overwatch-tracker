// Tier 3: the v1 export API and the lab client, over real HTTP on a temp DB
// (never data/overwatch.db). Covers each route, the `since` paging cursor,
// the never-exported frozen column, owner scoping, and the version refusal.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';
import {
  insertMatch, insertHeroSlot, insertAimStats, insertAimStatsHero,
  insertBlindSet, insertBlindStage, insertBlindCredit, insertMatchDeath,
} from '../db/fixtures';
import { SCHEMA_VERSION } from './v1';
import { createLabClient, SchemaVersionError, ExportHttpError, majorOf } from '../lab/client';
import { setCurveParams } from '../lib/curveParams';

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

function seedMatches(n: number): number[] {
  const ids: number[] = [];
  for (let i = 0; i < n; i++) {
    const id = insertMatch(h.db, { date: `2026-10-0${i + 1}`, hero: 'Ana', role: 'Support', win: (i % 2) as 0 | 1, queue_mode: 'comp_role' });
    insertHeroSlot(h.db, { match_id: id, slot: 1, hero: 'Ana', role: 'Support' });
    ids.push(id);
  }
  return ids;
}

describe('GET /api/v1/export/matches', () => {
  test('carries schema_version, hero rows, and never the frozen deaths column', async () => {
    const [id] = seedMatches(1);
    h.db.prepare("UPDATE matches SET deaths = '[1,2]' WHERE id = :id").run({ id });
    const r = await h.get('/api/v1/export/matches');
    assert.equal(r.status, 200);
    assert.equal(r.body.schema_version, SCHEMA_VERSION);
    assert.equal(r.body.rows.length, 1);
    assert.equal('deaths' in r.body.rows[0], false);
    assert.equal(r.body.rows[0].heroes.length, 1);
    assert.equal(r.body.rows[0].heroes[0].hero, 'Ana');
    assert.equal('match_id' in r.body.rows[0].heroes[0], false);
  });

  test('since cursor pages in id order and is exclusive', async () => {
    const ids = seedMatches(5);
    const p1 = await h.get('/api/v1/export/matches?limit=2');
    assert.deepEqual(p1.body.rows.map((r: any) => r.id), ids.slice(0, 2));
    assert.equal(p1.body.has_more, true);
    assert.equal(p1.body.next_since, ids[1]);
    const p2 = await h.get(`/api/v1/export/matches?limit=2&since=${p1.body.next_since}`);
    assert.deepEqual(p2.body.rows.map((r: any) => r.id), ids.slice(2, 4));
    const p3 = await h.get(`/api/v1/export/matches?limit=2&since=${p2.body.next_since}`);
    assert.deepEqual(p3.body.rows.map((r: any) => r.id), ids.slice(4));
    assert.equal(p3.body.next_since, ids[4]);
    const p4 = await h.get(`/api/v1/export/matches?limit=2&since=${p3.body.next_since}`);
    assert.deepEqual(p4.body.rows, []);
    assert.equal(p4.body.has_more, false);
    assert.equal(p4.body.next_since, null);
  });

  test('fields narrows columns, always keeps id, and rejects unknown or frozen columns', async () => {
    seedMatches(1);
    const ok = await h.get('/api/v1/export/matches?fields=hero,win');
    assert.deepEqual(Object.keys(ok.body.rows[0]).sort(), ['hero', 'heroes', 'id', 'win']);
    assert.equal((await h.get('/api/v1/export/matches?fields=nope')).status, 400);
    assert.equal((await h.get('/api/v1/export/matches?fields=deaths')).status, 400);
  });

  test('bad since or limit is a 400', async () => {
    assert.equal((await h.get('/api/v1/export/matches?since=abc')).status, 400);
    assert.equal((await h.get('/api/v1/export/matches?limit=0')).status, 400);
    assert.equal((await h.get('/api/v1/export/matches?limit=999999')).status, 400);
  });
});

describe('GET /api/v1/export/deaths', () => {
  test('is scoped by owner_id and pages by row id', async () => {
    const [m] = seedMatches(1);
    insertMatchDeath(h.db, { match_id: m, seq: 1, killer: 'Genji', killer_role: 'DPS' });
    insertMatchDeath(h.db, { match_id: m, seq: 2, killer: 'Tracer', killer_role: 'DPS', ult: 1 });
    insertMatchDeath(h.db, { match_id: m, seq: 3, killer: 'Mei', killer_role: 'DPS', owner_id: 2 });
    const r = await h.get('/api/v1/export/deaths');
    assert.equal(r.body.schema_version, SCHEMA_VERSION);
    assert.deepEqual(r.body.rows.map((d: any) => d.killer), ['Genji', 'Tracer']);
    assert.equal('owner_id' in r.body.rows[0], false);
    const p = await h.get(`/api/v1/export/deaths?since=${r.body.rows[0].id}`);
    assert.deepEqual(p.body.rows.map((d: any) => d.killer), ['Tracer']);
  });
});

describe('GET /api/v1/export/aim', () => {
  test('returns aim_stats with nested per-hero rows, paged by match_id', async () => {
    const ids = seedMatches(2);
    for (const id of ids) insertAimStats(h.db, { match_id: id, overall_acc: 40 } as any);
    insertAimStatsHero(h.db, { match_id: ids[0], hero: 'Ana', overall_acc: 41 } as any);
    const r = await h.get('/api/v1/export/aim?limit=1');
    assert.equal(r.body.schema_version, SCHEMA_VERSION);
    assert.equal(r.body.rows[0].match_id, ids[0]);
    assert.equal(r.body.rows[0].heroes[0].hero, 'Ana');
    assert.equal(r.body.next_since, ids[0]);
    const p = await h.get(`/api/v1/export/aim?since=${r.body.next_since}`);
    assert.deepEqual(p.body.rows.map((a: any) => a.match_id), [ids[1]]);
    assert.deepEqual(p.body.rows[0].heroes, []);
  });
});

describe('GET /api/v1/export/experiments', () => {
  test('returns sets (with paused_at), stages and credits', async () => {
    const [m] = seedMatches(1);
    const setId = insertBlindSet(h.db, { hero: 'Ana' });
    insertBlindStage(h.db, { set_id: setId, stage_index: 1 });
    insertBlindCredit(h.db, { match_id: m, hero: 'Ana', blind_set_id: setId, stage_index: 1 });
    const r = await h.get('/api/v1/export/experiments');
    assert.equal(r.body.schema_version, SCHEMA_VERSION);
    assert.equal(r.body.sets.length, 1);
    assert.ok('paused_at' in r.body.sets[0]);
    assert.equal(r.body.stages.length, 1);
    assert.equal(r.body.credits.length, 1);
  });
});

describe('GET /api/v1/export/curve', () => {
  test('null before the curve was ever saved, the raw row after', async () => {
    h.db.prepare('DELETE FROM curve_params').run();
    assert.equal((await h.get('/api/v1/export/curve')).body.curve, null);
    setCurveParams(h.db, { smooth: 0.3, input: 12, output: 1.4, lutSteps: 8, lutMaxSpeed: 40, lutPoints: null });
    const r = await h.get('/api/v1/export/curve');
    assert.equal(r.body.schema_version, SCHEMA_VERSION);
    assert.equal(r.body.curve.smooth, 0.3);
  });
});

describe('GET /api/v1/manifest', () => {
  test('lists enabled fields with type and category, plus hero and map lists', async () => {
    const r = await h.get('/api/v1/manifest');
    assert.equal(r.body.schema_version, SCHEMA_VERSION);
    const deaths = r.body.fields.find((f: any) => f.id === 'deaths');
    assert.equal(deaths.category, 'combat');
    assert.equal(deaths.type, 'death-logger');
    assert.ok(r.body.heroes.some((x: any) => x.hero === 'Ana' && x.role === 'Support'));
    assert.ok(r.body.maps.some((x: any) => x.map === "King's Row"));
    // study tags are lab knowledge and stay out of the contract
    assert.equal(r.body.fields.some((f: any) => 'study' in f), false);
  });

  test('a disabled category drops its fields from the manifest', async () => {
    await h.put('/api/config', { enabledCategories: [] });
    const r = await h.get('/api/v1/manifest');
    assert.equal(r.body.fields.some((f: any) => f.id === 'deaths'), false);
  });
});

describe('no write routes', () => {
  test('POST, PUT and DELETE under /api/v1 are not served', async () => {
    for (const p of ['/api/v1/export/matches', '/api/v1/manifest']) {
      assert.notEqual((await h.post(p, {})).status, 200);
      assert.notEqual((await h.put(p, {})).status, 200);
      assert.notEqual((await h.del(p)).status, 200);
    }
  });
});

describe('lab client', () => {
  function clientFor() {
    // The harness listens on a random port it does not expose; route fetch through it.
    const base = 'http://harness.invalid';
    const fetchImpl = (async (url: string, init?: any) => {
      const path = String(url).slice(base.length);
      const r = await h.get(path);
      return new Response(JSON.stringify(r.body), { status: r.status });
    }) as unknown as typeof fetch;
    return createLabClient({ baseUrl: base, fetchImpl });
  }

  test('matches() follows the cursor across pages', async () => {
    const ids = seedMatches(5);
    const rows = await clientFor().matches({ limit: 2 });
    assert.deepEqual(rows.map((r: any) => r.id), ids);
  });

  test('manifest() and experiments() pass the version check', async () => {
    const c = clientFor();
    assert.equal((await c.manifest()).schema_version, SCHEMA_VERSION);
    assert.equal((await c.experiments()).schema_version, SCHEMA_VERSION);
  });

  test('refuses an unknown major schema_version', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ schema_version: '2.0.0', rows: [] }), { status: 200 })) as unknown as typeof fetch;
    const c = createLabClient({ baseUrl: 'http://x', fetchImpl });
    await assert.rejects(() => c.manifest(), SchemaVersionError);
    await assert.rejects(() => c.matches(), SchemaVersionError);
  });

  test('refuses a response with no schema_version, and accepts a minor bump', async () => {
    const none = createLabClient({ baseUrl: 'http://x', fetchImpl: (async () => new Response('{"rows":[]}')) as unknown as typeof fetch });
    await assert.rejects(() => none.manifest(), SchemaVersionError);
    const minor = createLabClient({ baseUrl: 'http://x', fetchImpl: (async () => new Response('{"schema_version":"1.7.2"}')) as unknown as typeof fetch });
    assert.equal((await minor.manifest()).schema_version, '1.7.2');
    assert.equal(majorOf('1.7.2'), 1);
    assert.equal(majorOf('v1'), null);
  });

  test('a non-2xx response throws ExportHttpError', async () => {
    await assert.rejects(() => clientFor().matchesPage({ fields: ['nope'] }), ExportHttpError);
  });

  test('sends GET only', async () => {
    const methods: string[] = [];
    const fetchImpl = (async (_u: string, init?: any) => { methods.push(init?.method); return new Response('{"schema_version":"1.0.0","rows":[],"next_since":null,"has_more":false}'); }) as unknown as typeof fetch;
    const c = createLabClient({ baseUrl: 'http://x', fetchImpl });
    await c.matches(); await c.deaths(); await c.aim(); await c.manifest();
    assert.deepEqual([...new Set(methods)], ['GET']);
  });
});
