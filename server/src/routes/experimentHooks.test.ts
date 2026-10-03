// Stage 1.5 slice 4 (blocker B2): the boundary between the match tracker and
// the sensitivity-study controller. Three things are pinned: the tracker calls
// only the hooks (spy), the tracker still saves matches with the no-op hooks,
// and routes/matches.ts and routes/aim.ts import nothing from the study.
import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { startHarness, type Harness } from '../test/httpHarness';
import { setExperimentHooks, noopExperimentHooks, type ExperimentHooks } from '../lib/experimentHooks';

let h: Harness | undefined;
afterEach(async () => { await h?.close(); h = undefined; setExperimentHooks(); });

const base = {
  date: '2026-09-12', time: '12:00', hour: 12, map: 'Ilios', game_type: 'comp', win: true,
  queue_mode: 'comp_role', hero: 'Ashe', role: 'DPS',
};
const credits = (hh: Harness, id: number) =>
  hh.db.prepare('SELECT hero FROM blind_credits WHERE match_id = ?').all(id) as { hero: string }[];

describe('tracker calls the hooks', () => {
  test('POST, aim save, edit, heroes read and delete go through the hook methods', async () => {
    h = await startHarness();
    const calls: string[] = [];
    const spy: ExperimentHooks = {
      sensFor: (_db, hero, qm) => { calls.push(`sensFor:${hero}:${qm}`); return { dpi: 1600, sens: 4.25, curveEnabled: true, governsCurve: true, credit: { setId: 7, stageIdx: 2 } }; },
      onMatchSaved: (_db, m) => { calls.push(`saved:${m.hero}:${m.credit?.setId}:${m.credit?.stageIdx}`); },
      onAimStatsSaved: (_db, id) => { calls.push(`aim:${id}`); },
      onRosterEdited: (_db, id, o) => { calls.push(`edited:${id}:${o.sensProvided}`); },
      beforeMatchDelete: (_db, id) => { calls.push(`before:${id}`); return 'tok'; },
      afterMatchDelete: (_db, id, t) => { calls.push(`after:${id}:${t}`); },
      creditedHeroes: () => { calls.push('credited'); return ['Ashe']; },
    };
    setExperimentHooks(spy);

    const r = await h.post('/api/matches', { ...base, aim_stats: { heroes: [{ hero: 'Ashe', duration_min: 8, overall_acc: 40 }] } });
    const id = r.body.id as number;
    // The row is stamped from the assignment alone: sens, dpi, curve, stage.
    const row = h.db.prepare('SELECT sens, dpi, curve_enabled, blind_trial, blind_set_id, stage_index FROM matches WHERE id = ?').get(id) as any;
    assert.deepEqual({ ...row }, { sens: 4.25, dpi: 1600, curve_enabled: 1, blind_trial: 1, blind_set_id: 7, stage_index: 2 });
    assert.deepEqual(calls, ['sensFor:Ashe:comp_role', 'saved:Ashe:7:2', `aim:${id}`]);

    calls.length = 0;
    assert.equal((await h.put(`/api/matches/${id}`, { queue_mode: 'quick_play' })).status, 200);
    assert.deepEqual(calls, [`edited:${id}:false`]);

    calls.length = 0;
    assert.deepEqual((await h.get(`/api/matches/${id}/heroes`)).body.rows.map((x: any) => x.credited), [true]);
    assert.deepEqual(calls, ['credited']);

    calls.length = 0;
    await h.del(`/api/matches/${id}`);
    assert.deepEqual(calls, [`before:${id}`, `after:${id}:tok`]);
  });

  test('an assignment with no credit leaves the study columns empty, and a null assignment keeps the sent sens', async () => {
    h = await startHarness();
    const noCredit: ExperimentHooks = { ...noopExperimentHooks, sensFor: () => ({ dpi: 1600, sens: 3, curveEnabled: true, governsCurve: false, credit: null }) };
    setExperimentHooks(noCredit);
    const a = (await h.post('/api/matches', { ...base, sens: 9, curve_enabled: false })).body.id;
    const rowA = h.db.prepare('SELECT sens, dpi, curve_enabled, blind_trial, blind_set_id FROM matches WHERE id = ?').get(a) as any;
    // governsCurve false: the client's curve flag wins, as for a Designated Fallback.
    assert.deepEqual({ ...rowA }, { sens: 3, dpi: 1600, curve_enabled: 0, blind_trial: 0, blind_set_id: null });
  });
});

describe('no-op hooks (module absent or disabled)', () => {
  test('matches still save with the client sens, and no credit is written', async () => {
    h = await startHarness({ experiments: false });
    const mk = await h.post('/api/blind/sets', { hero: 'Ashe', batch_size: 5, senses: [2.0, 3.0] });
    assert.equal(mk.status, 200);
    const r = await h.post('/api/matches', {
      ...base, sens: 5.5, heroes: [{ hero: 'Cassidy', role: 'DPS' }],
      aim_stats: { heroes: [{ hero: 'Ashe', duration_min: 8, overall_acc: 40 }] },
    });
    assert.equal(r.status, 200);
    const id = r.body.id as number;
    const row = h.db.prepare('SELECT sens, blind_trial, blind_set_id, stage_index FROM matches WHERE id = ?').get(id) as any;
    assert.deepEqual({ ...row }, { sens: 5.5, blind_trial: 0, blind_set_id: null, stage_index: null });
    assert.equal(credits(h, id).length, 0);
    // Aim stats landed even though no credit hook ran.
    assert.equal((h.db.prepare('SELECT COUNT(*) AS n FROM aim_stats_heroes WHERE match_id = ?').get(id) as any).n, 1);
    // Edit, heroes read, delete all work.
    assert.equal((await h.put(`/api/matches/${id}`, { hero: 'Cassidy' })).status, 200);
    assert.deepEqual((await h.get(`/api/matches/${id}/heroes`)).body.rows.map((x: any) => x.credited), [false, false]);
    assert.equal((await h.del(`/api/matches/${id}`)).status, 200);
  });

  test('the real controller does credit the same match (control for the test above)', async () => {
    h = await startHarness();
    await h.post('/api/blind/sets', { hero: 'Ashe', batch_size: 5, senses: [2.0, 3.0] });
    const id = (await h.post('/api/matches', { ...base, sens: 5.5 })).body.id as number;
    assert.equal(credits(h, id).length, 1);
    const row = h.db.prepare('SELECT blind_trial FROM matches WHERE id = ?').get(id) as any;
    assert.equal(row.blind_trial, 1);
  });
});

describe('import boundary', () => {
  const src = (f: string) => fs.readFileSync(path.join(__dirname, f), 'utf8');
  const specifiers = (code: string) =>
    [...code.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);

  test('routes/matches.ts imports nothing from the study', () => {
    const bad = specifiers(src('matches.ts')).filter(s =>
      /(^|\/)blind$/.test(s) || /(^|\/)experiments(\/|$)/.test(s) || /(^|\/)lib\/(credits|df)$/.test(s));
    assert.deepEqual(bad, []);
  });

  // aim.ts keeps lib/blind (isStudyQueueMode, analysis side) until slice 5 cuts it.
  test('routes/aim.ts does not import the controller', () => {
    const bad = specifiers(src('aim.ts')).filter(s => /(^|\/)blind$/.test(s) && !/lib\/blind$/.test(s) || /(^|\/)experiments(\/|$)/.test(s));
    assert.deepEqual(bad, []);
  });

  test('routes/aim.ts does not import from routes/matches.ts', () => {
    assert.deepEqual(specifiers(src('aim.ts')).filter(s => /(^|\/)matches$/.test(s)), []);
  });

  test('routes/matches.ts reaches the study only through lib/experimentHooks', () => {
    const own = specifiers(src('matches.ts')).filter(s => /experimentHooks/.test(s));
    assert.deepEqual(own, ['../lib/experimentHooks']);
  });
});
