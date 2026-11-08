// Hero focus trial: the pure roster rule and the ABBA block pick.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { chooseRoster, pickFor, type HeroStat } from './heroFocus';

const h = (role: string, hero: string, n: number, wins: number): HeroStat => ({ role, hero, n, wins });

describe('chooseRoster', () => {
  test('ranks by win rate shrunk toward the overall rate, not by raw win rate', () => {
    // p0 0.5. A: 30 games 21 wins (raw .70, shrunk .60). B: 200 games 130 wins (raw .65, shrunk .652).
    const w = [h('DPS', 'A', 30, 21), h('DPS', 'B', 200, 130), h('DPS', 'C', 100, 40)];
    const r = chooseRoster(w, w, 0.5).filter(x => x.role === 'DPS');
    assert.deepEqual(r.map(x => x.hero), ['B', 'A']);
    assert.deepEqual(r.map(x => x.rank), [1, 2]);
    assert.ok(r.every(x => x.basis === 'rank'));
    assert.ok(Math.abs(r[0].shrunkWr! - (130 + 15) / 230) < 1e-9);
  });

  test('a hero under 30 matches is not eligible', () => {
    const w = [h('Support', 'Hot', 29, 29), h('Support', 'X', 40, 20), h('Support', 'Y', 60, 30)];
    const r = chooseRoster(w, w, 0.5).filter(x => x.role === 'Support');
    assert.deepEqual(r.map(x => x.hero).sort(), ['X', 'Y']);
  });

  test('ties on shrunk win rate go to the higher match count', () => {
    const w = [h('Tank', 'Small', 30, 15), h('Tank', 'Big', 60, 30), h('Tank', 'Third', 40, 12)];
    const r = chooseRoster(w, w, 0.5).filter(x => x.role === 'Tank');
    assert.deepEqual(r.map(x => x.hero), ['Big', 'Small']);
  });

  test('fewer than 2 eligible: fill with the most-played heroes of the role', () => {
    const w = [h('Tank', 'Elig', 50, 30), h('Tank', 'Few1', 12, 6), h('Tank', 'Few2', 20, 5)];
    const r = chooseRoster(w, w, 0.5).filter(x => x.role === 'Tank');
    assert.deepEqual(r.map(x => [x.hero, x.basis]), [['Elig', 'rank'], ['Few2', 'fill']]);
  });

  test('no eligible hero at all: two most-played, then falls back to all-time history', () => {
    const win = [h('Tank', 'W1', 10, 5)];
    const all = [h('Tank', 'W1', 10, 5), h('Tank', 'Old', 80, 40)];
    const r = chooseRoster(win, all, 0.5).filter(x => x.role === 'Tank');
    assert.deepEqual(r.map(x => x.hero), ['W1', 'Old']);
    assert.ok(r.every(x => x.basis === 'fill'));
  });

  test('a role with one hero ever, or none, does not throw', () => {
    const w = [h('Tank', 'Only', 5, 2)];
    const r = chooseRoster(w, w, 0.5);
    assert.deepEqual(r.filter(x => x.role === 'Tank').map(x => x.hero), ['Only']);
    assert.equal(r.filter(x => x.role === 'DPS').length, 0);
    assert.deepEqual(chooseRoster([], [], 0.5), []);
  });
});

describe('pickFor', () => {
  const roster = chooseRoster([h('DPS', 'A', 60, 40), h('DPS', 'B', 60, 30), h('Tank', 'T', 5, 2)], [], 0.5);
  test('block 1-20 pick is stable and ABBA across blocks gives each hero 5 of 10', () => {
    const seq = Array.from({ length: 10 }, (_, i) => pickFor(roster, 'DPS', i + 1));
    assert.deepEqual(seq, ['A', 'B', 'B', 'A', 'A', 'B', 'B', 'A', 'A', 'B']);
    assert.equal(seq.filter(x => x === 'A').length, 5);
  });
  test('a one-hero role always picks that hero; a role with none picks null', () => {
    assert.equal(pickFor(roster, 'Tank', 7), 'T');
    assert.equal(pickFor(roster, 'Support', 1), null);
  });
});
