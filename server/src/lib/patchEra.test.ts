import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { patchEra, eraCounts, withinEraDiff, eraAdjustedMeans, PATCH_BOUNDARIES } from './patchEra';

describe('patchEra', () => {
  test('boundary is 2026-10-06', () => assert.deepEqual([...PATCH_BOUNDARIES], ['2026-10-06']));
  test('10-05 is era 0', () => assert.equal(patchEra('2026-10-05'), 0));
  test('10-06 is era 1 (on the patch date counts as after)', () => assert.equal(patchEra('2026-10-06'), 1));
  test('10-07 is era 1', () => assert.equal(patchEra('2026-10-07'), 1));
  test('eraCounts splits dates', () => assert.deepEqual(eraCounts(['2026-10-05', '2026-10-06', '2026-10-09']), [1, 2]));
});

describe('withinEraDiff', () => {
  const mk = (era: number, vals: number[]) => vals.map(v => ({ era, v }));
  test('a constant era shift does not leak into the arm difference', () => {
    // True A-B difference is +2 in both eras; the patch shifts everything by -10.
    // A is mostly pre, B is mostly post, so a naive pooled mean would be badly off.
    const A = [...mk(0, [30, 32, 31, 29, 30, 31]), ...mk(1, [22, 20, 21])];
    const B = [...mk(0, [28, 29, 27]), ...mk(1, [18, 19, 17, 18, 19, 18])];
    const naive = A.reduce((s, o) => s + o.v, 0) / A.length - B.reduce((s, o) => s + o.v, 0) / B.length;
    assert.ok(Math.abs(naive - 2) > 3, 'naive pooled difference is confounded by era');
    const r = withinEraDiff(A, B);
    assert.equal(r.eras.length, 2);
    assert.ok(Math.abs((r.diff as number) - 2.5) < 1.0, `within-era diff ${r.diff}`);
    // Exact check: constant shift, identical shape per era.
    const A2 = [...mk(0, [32, 32, 32]), ...mk(1, [22, 22, 22])];
    const B2 = [...mk(0, [30, 30, 30, 30]), ...mk(1, [20, 20])];
    assert.equal(withinEraDiff(A2, B2).diff, 2);
  });
  test('an arm with data in one era is compared only in that era', () => {
    const r = withinEraDiff(mk(0, [30, 30]), [...mk(0, [28, 28]), ...mk(1, [10, 10])]);
    assert.equal(r.diff, 2);
    assert.equal(r.eras.length, 1);
  });
  test('no shared era gives null', () => {
    assert.equal(withinEraDiff(mk(0, [30]), mk(1, [10])).diff, null);
  });
});

describe('eraAdjustedMeans', () => {
  test('single era equals plain means', () => {
    const m = eraAdjustedMeans([{ arm: 'a', era: 0, v: 10 }, { arm: 'a', era: 0, v: 20 }, { arm: 'b', era: 0, v: 30 }]);
    assert.equal(m.get('a')!.mean, 15);
    assert.equal(m.get('b')!.mean, 30);
  });
  test('era shift removed; arm with no shared era is null', () => {
    const obs = [
      { arm: 'a', era: 0, v: 32 }, { arm: 'a', era: 1, v: 22 },
      { arm: 'b', era: 0, v: 30 }, { arm: 'b', era: 1, v: 20 },
      { arm: 'c', era: 2, v: 5 },
    ];
    const m = eraAdjustedMeans(obs);
    assert.equal(m.get('a')!.mean - m.get('b')!.mean, 2);
    assert.equal(m.get('c'), null);
  });
});
