// Split plan slice 5c proof. The lab's dashboard readers (aimAnalysis, statsLab,
// advisor) read the shared replica built through lab/client.ts, not db/schema.
// For every repointed endpoint this runs the SAME handler twice on one fixture:
// once on the replica (the production path) and once on the tracker's own
// database handle (the old direct path, through the `source` test seam), and
// requires the two response bodies to be deeply equal. The fixture carries a
// chunked blind set, a crashed match, a mid-match hero switch and a QP study
// credit, because those are the shapes that broke the replica before.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startHarness, type Harness } from '../test/httpHarness';
import {
  insertMatch, insertHeroSlot, insertAimStats, insertAimStatsHero,
  insertBlindSet, insertBlindStage, insertBlindCredit,
} from '../db/fixtures';
import { setCurveParams, getCurveParams } from '../lib/curveParams';
import { configureReplicaCache, getReplica } from '../lab/replicaCache';
import { TABLES } from '../lab/replica';
import { computeAnalysis } from './aimAnalysis';
import { getInTestingHeroes, getComfortPool, pickPrimary, getMapContext, getStretchCandidates, getUntestedMetaPool, computeTestPick } from './advisor';

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

const TODAY = '2026-10-03';
const day = (n: number) => new Date(Date.UTC(2026, 9, 3 - n)).toISOString().slice(0, 10);

function set(id: number, cols: Record<string, string | number | null>) {
  const keys = Object.keys(cols);
  h.db.prepare(`UPDATE matches SET ${keys.map(k => `${k} = :${k}`).join(', ')} WHERE id = :id`).run({ id, ...cols });
}

let seq = 0;
function game(o: {
  date: string; hero: string; role: string; win: 0 | 1; sens: number; acc?: number | null; map?: string;
  setId?: number; stage?: number; queue?: string; mins?: number; withAim?: boolean;
}) {
  const n = seq++;
  const id = insertMatch(h.db, {
    date: o.date, time: `${String(10 + (n % 12)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`,
    day_of_week: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'][n % 5], hour: 10 + (n % 12),
    hero: o.hero, role: o.role, win: o.win, sens: o.sens, dpi: 800, map: o.map ?? ['Ilios', 'Lijiang Tower', 'Nepal'][n % 3],
    queue_mode: o.queue ?? 'comp_role', blind_trial: o.setId ? 1 : 0, blind_set_id: o.setId ?? null, stage_index: o.stage ?? null,
    feel: 1 + (n % 5),
  });
  insertHeroSlot(h.db, { match_id: id, slot: 1, hero: o.hero, role: o.role, sens: o.sens, feel: 1 + (n % 5) });
  set(id, {
    leaver: n % 4 === 0 ? 1 : 0, leaver_side: n % 4 === 0 ? (n % 8 === 0 ? 'mine' : 'theirs') : null,
    team_rating: 1 + (n % 5), match_quality: 1 + (n % 3), result_driver: ['me', 'team', 'enemy'][n % 3],
    notes: n % 7 === 0 ? 'note' : null,
  });
  if (o.withAim !== false && o.acc !== null && o.acc !== undefined) {
    insertAimStats(h.db, {
      match_id: id, overall_acc: o.acc, crit_acc: 20 + (n % 9), elims: 10 + (n % 15), final_blows: 4 + (n % 6),
      deaths: 3 + (n % 5), damage: 7000 + n * 130, healing: o.role === 'Support' ? 6000 + n * 90 : 0, duration_min: o.mins ?? 10 + (n % 4),
      hero_stat_label: 'Hero stat', hero_stat_value: 30 + (n % 11),
    });
    h.db.prepare('UPDATE aim_stats SET assists = :a WHERE match_id = :id').run({ a: n % 9, id });
    insertAimStatsHero(h.db, { match_id: id, hero: o.hero, overall_acc: o.acc, crit_acc: 22 + (n % 7), extra_acc: n % 3 ? 40 + (n % 10) : null, duration_min: o.mins ?? 10 + (n % 4) });
  }
  if (o.setId) insertBlindCredit(h.db, { match_id: id, hero: o.hero, blind_set_id: o.setId, stage_index: o.stage ?? 1 });
  return id;
}

function seedFixture() {
  setCurveParams(h.db, { smooth: 0.3, input: 12, output: 1.4, lutSteps: 8, lutMaxSpeed: 40, lutPoints: [[0, 1], [10, 1.2]] });
  // Chunked set for Ana (ABBA, chunk_size 2) and a plain set for Ashe.
  const anaSet = insertBlindSet(h.db, { hero: 'Ana', batch_size: 6, chunk_size: 2 });
  const asheSet = insertBlindSet(h.db, { hero: 'Ashe', batch_size: 5 });
  [[1, 2.4], [2, 2.8]].forEach(([si, s]) => insertBlindStage(h.db, { set_id: anaSet, stage_index: si, sens: s }));
  [[1, 3.0], [2, 3.4]].forEach(([si, s]) => insertBlindStage(h.db, { set_id: asheSet, stage_index: si, sens: s }));
  // 36 Ana + 36 Ashe games over 12 days, accuracy and result both varying.
  for (let k = 0; k < 36; k++) {
    game({ date: day(1 + (k % 12)), hero: 'Ana', role: 'Support', win: (k % 3 === 0 ? 0 : 1) as 0 | 1, sens: k % 2 ? 2.4 : 2.8, acc: 30 + (k % 9) * 2, setId: anaSet, stage: 1 + (k % 2) });
    game({ date: day(1 + (k % 12)), hero: 'Ashe', role: 'DPS', win: (k % 2) as 0 | 1, sens: k % 2 ? 3.0 : 3.4, acc: 35 + (k % 7) * 2, setId: asheSet, stage: 1 + (k % 2) });
  }
  // A QP study credit (must be filtered out of analysis) and non-study games on a third hero.
  game({ date: day(2), hero: 'Ana', role: 'Support', win: 1, sens: 2.4, acc: 80, setId: anaSet, stage: 1, queue: 'qp_role' });
  for (let k = 0; k < 6; k++) game({ date: day(3 + k), hero: 'Mercy', role: 'Support', win: (k % 2) as 0 | 1, sens: 2.55, acc: 25 + k });
  // Study matches with no aim stats yet (they show in /pending).
  game({ date: TODAY, hero: 'Ana', role: 'Support', win: 1, sens: 2.4, acc: null, setId: anaSet, stage: 2 });
  game({ date: TODAY, hero: 'Ashe', role: 'DPS', win: 0, sens: 3.0, acc: null, setId: asheSet, stage: 1 });
  // Mid-match switch: Ashe then Mercy, with per-hero minutes.
  const sw = game({ date: TODAY, hero: 'Ashe', role: 'DPS', win: 1, sens: 3.0, acc: 41, mins: 8, setId: asheSet, stage: 1 });
  insertHeroSlot(h.db, { match_id: sw, slot: 2, hero: 'Mercy', role: 'Support', sens: 2.8 });
  insertAimStatsHero(h.db, { match_id: sw, hero: 'Mercy', overall_acc: 25, duration_min: 4 });
  // Crashed match: result-only, no sens, no hero stats.
  const cr = insertMatch(h.db, { date: TODAY, hero: 'Ana', role: 'Support', win: 0, queue_mode: 'comp_role' });
  insertHeroSlot(h.db, { match_id: cr, slot: 1, hero: 'Ana', role: 'Support' });
  set(cr, { crashed: 1 });
  // Aim stats logged today (shows in /today).
  game({ date: TODAY, hero: 'Ana', role: 'Support', win: 1, sens: 2.8, acc: 52 });
}

async function bothPaths(url: string) {
  const viaReplica = await h.get(url);
  configureReplicaCache({ baseUrl: h.baseUrl, source: async () => h.db });
  const direct = await h.get(url);
  configureReplicaCache({ baseUrl: h.baseUrl });
  return { viaReplica, direct };
}

describe('lab readers: replica path equals direct-database path', () => {
  test('aimAnalysis endpoints', async () => {
    seedFixture();
    for (const url of [
      '/api/aim/curve', '/api/aim/pending', '/api/aim/pending?limit=1', '/api/aim/analysis',
      `/api/aim/today?date=${TODAY}`, '/api/aim',
    ]) {
      const { viaReplica, direct } = await bothPaths(url);
      assert.equal(direct.status, 200, url);
      assert.equal(viaReplica.status, 200, url);
      assert.deepEqual(viaReplica.body, direct.body, url);
    }
    // Not vacuous: each surface carries data.
    const pending = (await h.get('/api/aim/pending')).body;
    assert.ok(pending.rows.length >= 2 && pending.total >= 2);
    assert.ok((await h.get(`/api/aim/today?date=${TODAY}`)).body.rows.length >= 2);
    const analysis = (await h.get('/api/aim/analysis')).body;
    assert.ok(analysis.heroes.length >= 2, 'analysis must cover both study heroes');
    assert.deepEqual((await h.get('/api/aim/curve')).body, getCurveParams(h.db));
    // computeAnalysis straight on the tracker db equals the endpoint body.
    assert.deepEqual(analysis, JSON.parse(JSON.stringify(computeAnalysis(h.db))));
  });

  test('statsLab endpoints: /insights and /split', async () => {
    seedFixture();
    const urls = [
      '/api/stats/insights',
      '/api/stats/split?by=leaver', '/api/stats/split?by=leaver_side', '/api/stats/split?by=match_quality',
      '/api/stats/split?by=result_driver', '/api/stats/split?by=team_rating',
      '/api/stats/split?by=leaver&role=Support', `/api/stats/split?by=match_quality&from=${day(6)}&to=${TODAY}&queue_mode=comp_role`,
    ];
    for (const url of urls) {
      const { viaReplica, direct } = await bothPaths(url);
      assert.equal(direct.status, 200, url);
      assert.deepEqual(viaReplica.body, direct.body, url);
    }
    assert.ok((await h.get('/api/stats/insights')).body.factoids.length >= 3, 'insights must produce factoids');
    const split = (await h.get('/api/stats/split?by=match_quality')).body;
    assert.ok(split.groups.length >= 2);
    assert.equal((await h.get('/api/stats/split?by=nope')).status, 400);
  });

  test('advisor: helper queries, /test-pick and cached /recommend', async () => {
    seedFixture();
    const replica = await getReplica();
    for (const role of ['DPS', 'Support'] as const) {
      const a = getInTestingHeroes(h.db); const b = getInTestingHeroes(replica);
      assert.deepEqual([...a].sort(), [...b].sort());
      const poolA = getComfortPool(h.db, role, a); const poolB = getComfortPool(replica, role, b);
      assert.deepEqual(poolB, poolA);
      assert.deepEqual(pickPrimary(replica, 'Ilios', poolB), pickPrimary(h.db, 'Ilios', poolA));
      const pool = new Set(poolA.map(p => p.hero));
      assert.deepEqual(getStretchCandidates(replica, 'Ilios', role, pool, b), getStretchCandidates(h.db, 'Ilios', role, pool, a));
      assert.deepEqual(getUntestedMetaPool(replica, role, pool, b), getUntestedMetaPool(h.db, role, pool, a));
    }
    assert.deepEqual(getMapContext(replica, 'Ilios'), getMapContext(h.db, 'Ilios'));
    // matches_by_hero: the lab copy of the view returns the tracker's rows for what the lab reads.
    const q = 'SELECT id, hero, map, win FROM matches_by_hero ORDER BY id, hero';
    assert.deepEqual(replica.prepare(q).all(), h.db.prepare(q).all());

    for (const url of ['/api/advisor/test-pick?role=DPS&maps=Ilios,Nepal', '/api/advisor/test-pick?role=Support&maps=Ilios,Lijiang%20Tower,Nepal',
      '/api/advisor/test-pick?role=DPS&maps=Atlantis', '/api/advisor/test-pick?role=DPS']) {
      const { viaReplica, direct } = await bothPaths(url);
      assert.equal(viaReplica.status, 200, url);
      assert.deepEqual(viaReplica.body, direct.body, url);
    }
    const tp = (await h.get('/api/advisor/test-pick?role=DPS&maps=Ilios,Nepal')).body;
    assert.equal(tp.available, true);
    assert.deepEqual(tp, JSON.parse(JSON.stringify(computeTestPick(h.db, 'DPS', ['Ilios', 'Nepal']))));
    assert.equal((await h.get('/api/advisor/test-pick?role=Tank&maps=Ilios')).status, 400);
  });

  test('advisor /recommend on a cache hit: same body on both paths, and it reads fresh hero stats', async () => {
    await h.close();
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const focus = JSON.stringify({ byRole: { DPS: { stretch: null, stretchUntested: false }, Support: { stretch: null, stretchUntested: false } } });
    h = await startHarness({ advisorStore: { read: () => ({ focus_json: focus, created_at: now }), write: () => { throw new Error('must not write on a hit'); } } });
    seedFixture();
    const { viaReplica, direct } = await bothPaths('/api/advisor/recommend?map=Ilios&queue_mode=comp_role');
    assert.equal(viaReplica.status, 200, JSON.stringify(viaReplica.body));
    assert.deepEqual(viaReplica.body, direct.body);
    assert.equal(viaReplica.body.DPS.cached, true);
    assert.equal(viaReplica.body.DPS.primary, 'Ashe');
    assert.equal(viaReplica.body.Support.primary, 'Ana');
  });
});

describe('seam: lab files read tracker data only through lab/client', () => {
  const root = path.join(__dirname, '..');
  const specifiers = (code: string) =>
    [...code.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
  test('none of the lab reader files imports db/schema', () => {
    for (const f of ['routes/aimAnalysis.ts', 'routes/statsLab.ts', 'routes/advisor.ts', 'lib/statsInsights.ts', 'lib/curveParams.ts',
      'lab/replicaCache.ts', 'lab/replica.ts', 'lab/client.ts']) {
      const bad = specifiers(fs.readFileSync(path.join(root, f), 'utf8')).filter(x => /(^|\/)db\/schema$/.test(x));
      assert.deepEqual(bad, [], f);
    }
  });
});

describe('replica cache', () => {
  test('a match saved through POST /api/matches shows in a lab endpoint at once', async () => {
    await h.close();
    h = await startHarness({ freshReads: false });
    const before = (await h.get(`/api/aim/today?date=${TODAY}`)).body.rows.length;
    assert.equal(before, 0);
    // Warm the cache, then write through the real tracker write route.
    const posted = await h.post('/api/matches', {
      date: TODAY, time: '12:00', hero: 'Ana', role: 'Support', map: 'Ilios', game_type: 'comp', win: 1, queue_mode: 'comp_role', sens: 2.5, dpi: 800,
      heroes: [{ hero: 'Ana', role: 'Support', sens: 2.5 }],
    });
    assert.equal(posted.status, 200, JSON.stringify(posted.body));
    const id = posted.body.id;
    const aim = await h.post('/api/aim', { match_id: id, elims: 10, deaths: 3, damage: 9000, heroes: [{ hero: 'Ana', overall_acc: 44, duration_min: 12 }] });
    assert.ok(aim.status >= 200 && aim.status < 300, JSON.stringify(aim.body));
    const after = (await h.get(`/api/aim/today?date=${TODAY}`)).body.rows;
    assert.equal(after.length, 1);
    assert.equal(after[0].id, id);
  });

  test('reads inside the TTL reuse one build; a tracker write drops it', async () => {
    await h.close();
    let calls = 0;
    h = await startHarness({ freshReads: false });
    const baseFetch = fetch;
    configureReplicaCache({ baseUrl: h.baseUrl, fetchImpl: ((u: any, i: any) => { calls++; return baseFetch(u, i); }) as typeof fetch });
    await h.get('/api/aim/curve');
    const afterFirst = calls;
    assert.ok(afterFirst > 0);
    await h.get('/api/aim/curve'); await h.get('/api/aim');
    assert.equal(calls, afterFirst, 'second and third read must not rebuild');
    await h.put('/api/aim/curve', { smooth: 0.1, input: 10, output: 2, lutSteps: 8, lutMaxSpeed: 40, lutPoints: null });
    const c = await h.get('/api/aim/curve');
    assert.ok(calls > afterFirst, 'a write must trigger a rebuild');
    assert.equal(c.body.smooth, 0.1, 'the new curve shows at once');
  });

  test('replica contract: every declared column exists in the tracker schema', () => {
    for (const [table, spec] of Object.entries(TABLES)) {
      const real = (h.db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(r => r.name);
      for (const c of spec.cols) assert.ok(real.includes(c), `${table}.${c} missing in tracker schema`);
    }
  });
});
