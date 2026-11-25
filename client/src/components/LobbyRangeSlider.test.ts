import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowSlots, edgeStep, rowStartAfter } from './LobbyRangeSlider';
import { RANK_MIN, RANK_MAX } from '../types';

test('default window is 10 either side of the player', () => {
  const s = windowSlots(20, 0, null, null);
  assert.equal(s[0], 10);
  assert.equal(s[s.length - 1], 30);
});

test('default window is cut at the ends of the ladder', () => {
  const s = windowSlots(3, 0, null, null);
  assert.equal(s[0], 1);
  assert.equal(s.length, 13);
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

test('row slides one division, and keeps its full width', () => {
  assert.equal(rowStartAfter(20, 40, -1), 19);
  assert.equal(rowStartAfter(20, 40, 1), 21);
  const s = windowSlots(20, rowStartAfter(20, 40, 1) - (20 - 10), 25, 28);
  assert.equal(s.length, 21);
});

test('a row cut short by the ladder fills out to full width on its first step', () => {
  assert.equal(rowStartAfter(RANK_MIN, RANK_MIN + 12, 1), RANK_MIN);
  assert.equal(rowStartAfter(RANK_MAX - 12, RANK_MAX, -1), RANK_MAX - 20);
});

test('the row stays put once scrolled and the bar comes back inside the default window', () => {
  const scroll = 19 - (20 - 10); // row starts at 19
  const s = windowSlots(20, scroll, 22, 26);
  assert.equal(s[0], 19);
});
