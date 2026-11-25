import { test } from 'node:test';
import assert from 'node:assert/strict';
import { windowSlots } from './LobbyRangeSlider';

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
