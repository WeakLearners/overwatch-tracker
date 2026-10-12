import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFinding, wilsonInterval, twoProportionP } from './finding';

test('wilson interval brackets the rate and stays inside 0-100', () => {
  const { lo, hi } = wilsonInterval(84, 168);
  assert.ok(lo < 50 && hi > 50);
  assert.ok(lo > 40 && hi < 60);
  const edge = wilsonInterval(10, 10);
  assert.ok(edge.hi <= 100 && edge.lo > 60);
});

test('equal rates give p of 1', () => {
  assert.ok(Math.abs(twoProportionP(10, 20, 50, 100)! - 1) < 1e-6);
});

test('below minN is thin and untested', () => {
  const f = makeFinding({ wins: 5, n: 5 }, { wins: 10, n: 40 }, 4);
  assert.equal(f.verdict, 'thin');
  assert.equal(f.p, null);
});

test('a large gap holds up after correction', () => {
  const f = makeFinding({ wins: 45, n: 60 }, { wins: 40, n: 140 }, 3);
  assert.equal(f.verdict, 'holds');
  assert.equal(f.rate, 75);
  assert.ok(f.p! < f.threshold);
});

test('the same gap fails when many groups are tested: not reliable', () => {
  const g = { wins: 17, n: 25 };           // 68% vs 40%
  const r = { wins: 40, n: 100 };
  const few = makeFinding(g, r, 1);
  const many = makeFinding(g, r, 40);
  assert.ok(few.p === many.p);
  assert.equal(few.verdict, 'holds');
  assert.equal(many.verdict, 'unreliable');
  assert.equal(many.threshold, 0.05 / 40);
});

test('no difference gives none', () => {
  assert.equal(makeFinding({ wins: 12, n: 25 }, { wins: 50, n: 100 }, 5).verdict, 'none');
});
