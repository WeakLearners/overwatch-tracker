// player_ranks is the single source of truth for where each ladder stands.
//
// It exists because two surfaces now change rank: the Pre-Match drum and the
// log page's promote/demote row. While rank lived in one browser's
// localStorage each surface held a private copy, so the badge could disagree
// with the rank being written onto a match. These tests pin the contract both
// surfaces depend on.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

describe('GET/PUT /api/ranks — one rank per ladder', () => {
  test('an unseen ladder is simply absent, not zero', async () => {
    const r = await h.get('/api/ranks');
    assert.equal(r.status, 200);
    assert.equal(r.body['Pinx|DPS'], undefined, 'never set must not read as a rank');
  });

  test('a write is readable back under its account|role key', async () => {
    await h.put('/api/ranks', { account: 'Pinx', role: 'DPS', rank: 15 });
    assert.equal((await h.get('/api/ranks')).body['Pinx|DPS'], 15);
  });

  test('two ladders do not touch each other', async () => {
    await h.put('/api/ranks', { account: 'Pinx', role: 'DPS', rank: 15 });
    await h.put('/api/ranks', { account: 'Pinx', role: 'Support', rank: 24 });
    await h.put('/api/ranks', { account: 'Jinx', role: 'DPS', rank: 30 });
    const m = (await h.get('/api/ranks')).body;
    assert.deepEqual(m, { 'Pinx|DPS': 15, 'Pinx|Support': 24, 'Jinx|DPS': 30 });
  });

  test('writing the same ladder twice replaces rather than duplicates', async () => {
    await h.put('/api/ranks', { account: 'Pinx', role: 'DPS', rank: 15 });
    await h.put('/api/ranks', { account: 'Pinx', role: 'DPS', rank: 14 });
    const m = (await h.get('/api/ranks')).body;
    assert.deepEqual(m, { 'Pinx|DPS': 14 }, 'a demotion replaces the rank, it does not add a row');
  });

  test('null clears a ladder back to unset', async () => {
    await h.put('/api/ranks', { account: 'Pinx', role: 'DPS', rank: 15 });
    await h.put('/api/ranks', { account: 'Pinx', role: 'DPS', rank: null });
    assert.equal((await h.get('/api/ranks')).body['Pinx|DPS'], undefined);
  });

  test('a missing account is its own ladder, matching pre-account match rows', async () => {
    await h.put('/api/ranks', { role: 'DPS', rank: 15 });
    assert.equal((await h.get('/api/ranks')).body['|DPS'], 15);
  });

  test('an out-of-range rank is refused, not clamped', async () => {
    // Clamping would silently record a rank Sean never chose. 46 is above
    // Champion 1, so the only honest answer is to reject the write.
    for (const bad of [0, 46, 2.5, 'Gold']) {
      const r = await h.put('/api/ranks', { account: 'Pinx', role: 'DPS', rank: bad });
      assert.equal(r.status, 400, `rank ${bad} should be refused`);
    }
    assert.equal((await h.get('/api/ranks')).body['Pinx|DPS'], undefined, 'no partial write');
  });

  test('a write with no role is refused', async () => {
    assert.equal((await h.put('/api/ranks', { account: 'Pinx', rank: 15 })).status, 400);
  });
});
