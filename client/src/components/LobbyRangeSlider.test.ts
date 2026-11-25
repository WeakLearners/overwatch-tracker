import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowSlots, edgeStep } from './LobbyRangeSlider';
import { RANK_MIN, RANK_MAX } from '../types';

test('default window is 10 either side of the player', () => {
  const s = windowSlots(20, 0, null, null);
  assert.equal(s[0], 10);
  assert.equal(s[s.length - 1], 30);
});

test('default window is slid inside the ladder at the ends, still 21 pills', () => {
  const lo = windowSlots(3, 0, null, null);
  assert.equal(lo[0], RANK_MIN);
  assert.equal(lo.length, 21);
  const hi = windowSlots(RANK_MAX, 0, null, null);
  assert.equal(hi[hi.length - 1], RANK_MAX);
  assert.equal(hi.length, 21);
});

test('scrolling slides a full-width row along the ladder', () => {
  const s = windowSlots(20, 5, null, null);
  assert.equal(s[0], 15);
  assert.equal(s.length, 21);
  assert.equal(s[s.length - 1], 35);
});

test('scrolling stops at the top of the ladder', () => {
  const s = windowSlots(20, 100, null, null);
  assert.equal(s[s.length - 1], 45);
  assert.equal(s.length, 21);
});

test('a bar outside the default window pulls the row to it', () => {
  const s = windowSlots(20, 0, 32, 36);
  assert.ok(s.includes(32) && s.includes(36));
});

test('a bar below the default window pulls the row down to it', () => {
  const s = windowSlots(20, 0, 6, 12);
  assert.ok(s.includes(6) && s.includes(12));
});

// edgeStep: first=20, last=40 is a full 21-wide row mid-ladder.
test('edge step, move: bar at the left edge carries the row one lower', () => {
  assert.deepEqual(edgeStep('move', 20, 24, 20, 40, 'low'), { low: 19, high: 23 });
});

test('edge step, move: bar at the right edge carries the row one higher', () => {
  assert.deepEqual(edgeStep('move', 36, 40, 20, 40, 'high'), { low: 37, high: 41 });
});

test('edge step, move: no step when the bar is not against that edge', () => {
  assert.equal(edgeStep('move', 22, 26, 20, 40, 'low'), null);
  assert.equal(edgeStep('move', 22, 26, 20, 40, 'high'), null);
});

test('edge step, low handle: extends one lower at the left edge only', () => {
  assert.deepEqual(edgeStep('low', 20, 26, 20, 40, 'low'), { low: 19, high: 26 });
  assert.equal(edgeStep('low', 20, 26, 20, 40, 'high'), null);
});

test('edge step, high handle: extends one higher at the right edge only', () => {
  assert.deepEqual(edgeStep('high', 30, 40, 20, 40, 'high'), { low: 30, high: 41 });
  assert.equal(edgeStep('high', 30, 40, 20, 40, 'low'), null);
});

test('edge step: handles never scroll toward the inside', () => {
  assert.equal(edgeStep('low', 30, 40, 20, 40, 'high'), null);
  assert.equal(edgeStep('high', 20, 30, 20, 40, 'low'), null);
});

test('edge step: stops at both ends of the ladder', () => {
  assert.equal(edgeStep('move', RANK_MIN, RANK_MIN + 4, RANK_MIN, RANK_MIN + 20, 'low'), null);
  assert.equal(edgeStep('low', RANK_MIN, RANK_MIN + 4, RANK_MIN, RANK_MIN + 20, 'low'), null);
  assert.equal(edgeStep('move', RANK_MAX - 4, RANK_MAX, RANK_MAX - 20, RANK_MAX, 'high'), null);
  assert.equal(edgeStep('high', RANK_MAX - 4, RANK_MAX, RANK_MAX - 20, RANK_MAX, 'high'), null);
});

test('edge step: a handle may not push the far end out of the row', () => {
  assert.equal(edgeStep('low', 20, 40, 20, 40, 'low'), null);
  assert.equal(edgeStep('high', 20, 40, 20, 40, 'high'), null);
});

test('hold at an edge: row stays 21 pills, bar stays on the edge pill, reaches the ladder end (all 45 ranks)', () => {
  for (let player = RANK_MIN; player <= RANK_MAX; player++) {
    for (const side of ['low', 'high'] as const) {
      let scroll = 0;
      // Bar of 5 pills placed on the edge pill of the default row.
      let s0 = windowSlots(player, 0, null, null);
      let low = side === 'low' ? s0[0] : s0[20] - 4;
      let high = low + 4;
      let steps = 0;
      for (;;) {
        const slots = windowSlots(player, scroll, low, high);
        assert.equal(slots.length, 21, `rank ${player} ${side}`);
        const first = slots[0], last = slots[20];
        const step = edgeStep('move', low, high, first, last, side);
        if (!step) break;
        scroll = first + (side === 'low' ? -1 : 1) - (player - 10);
        low = step.low; high = step.high;
        const next = windowSlots(player, scroll, low, high);
        assert.equal(next.length, 21);
        assert.equal(side === 'low' ? low : high, side === 'low' ? next[0] : next[20], `bar left the edge: rank ${player} ${side}`);
        assert.ok(++steps < 100);
      }
      const end = windowSlots(player, scroll, low, high);
      assert.equal(side === 'low' ? end[0] : end[20], side === 'low' ? RANK_MIN : RANK_MAX);
    }
  }
});

test('the row stays put once scrolled and the bar comes back inside the default window', () => {
  const scroll = 19 - (20 - 10); // row starts at 19
  const s = windowSlots(20, scroll, 22, 26);
  assert.equal(s[0], 19);
});
