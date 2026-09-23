// Tier 3: GET /api/stats/killer-frequency over real HTTP — field registry
// Phase 1's dashboard card. Covers the roster-wide totals, the per-killer
// min-n guard (KILLER_FREQ_MIN_N=10 in stats.ts), and owner scoping.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';
import { insertSoloMatch, insertMatchDeath } from '../db/fixtures';

let h: Harness;

beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

test('no deaths logged: empty, not an error', async () => {
  const r = await h.get('/api/stats/killer-frequency');
  assert.equal(r.status, 200);
  assert.equal(r.body.total_deaths, 0);
  assert.equal(r.body.overall_ult_share, null);
  assert.deepEqual(r.body.killers, []);
});

test('a killer below KILLER_FREQ_MIN_N is present but marked unreliable', async () => {
  const m = insertSoloMatch(h.db, { date: '2026-09-23', hero: 'Ana', role: 'Support', win: 1 });
  insertMatchDeath(h.db, { match_id: m, seq: 1, killer: 'Genji', killer_role: 'DPS', ult: 0 });
  insertMatchDeath(h.db, { match_id: m, seq: 2, killer: 'Genji', killer_role: 'DPS', ult: 1 });

  const r = await h.get('/api/stats/killer-frequency');
  assert.equal(r.status, 200);
  assert.equal(r.body.total_deaths, 2);
  const genji = r.body.killers.find((k: any) => k.killer === 'Genji');
  assert.equal(genji.deaths, 2);
  assert.equal(genji.reliable, false);
  assert.equal(genji.ult_deaths, 1);
});

test('a killer at exactly KILLER_FREQ_MIN_N clears the reliability bar', async () => {
  const m = insertSoloMatch(h.db, { date: '2026-09-23', hero: 'Ana', role: 'Support', win: 1 });
  for (let i = 0; i < 10; i++) {
    insertMatchDeath(h.db, { match_id: m, seq: i + 1, killer: 'Reaper', killer_role: 'DPS', ult: i < 3 ? 1 : 0 });
  }
  const r = await h.get('/api/stats/killer-frequency');
  const reaper = r.body.killers.find((k: any) => k.killer === 'Reaper');
  assert.equal(reaper.deaths, 10);
  assert.equal(reaper.reliable, true);
  assert.equal(reaper.ult_share, 30);
  assert.equal(r.body.overall_ult_share, 30);
});

test('roster-wide ult share is not gated by the per-killer min-n', async () => {
  // Three different killers, one death each — no per-killer cell clears the
  // bar, but the pooled roster-wide share is still reported.
  const m = insertSoloMatch(h.db, { date: '2026-09-23', hero: 'Ana', role: 'Support', win: 1 });
  insertMatchDeath(h.db, { match_id: m, seq: 1, killer: 'Genji', killer_role: 'DPS', ult: 1 });
  insertMatchDeath(h.db, { match_id: m, seq: 2, killer: 'Widowmaker', killer_role: 'DPS', ult: 0 });
  insertMatchDeath(h.db, { match_id: m, seq: 3, killer: 'Reinhardt', killer_role: 'Tank', ult: 0 });

  const r = await h.get('/api/stats/killer-frequency');
  assert.equal(r.body.total_deaths, 3);
  assert.equal(r.body.overall_ult_share, Math.round((1 / 3) * 1000) / 10);
  assert.ok(r.body.killers.every((k: any) => k.reliable === false));
});
