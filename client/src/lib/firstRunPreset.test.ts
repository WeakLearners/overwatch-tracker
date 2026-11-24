import { test } from 'node:test';
import assert from 'node:assert/strict';
import { showFirstRunPreset } from './firstRunPreset.ts';

const base = { demo: false, loading: false, needsPreset: true, presetCount: 3 };

test('shows when no config row exists and presets were sent', () => {
  assert.equal(showFirstRunPreset(base), true);
});

test('hidden when a config row exists (needsPreset false)', () => {
  assert.equal(showFirstRunPreset({ ...base, needsPreset: false }), false);
});

test('hidden while the config is still loading', () => {
  assert.equal(showFirstRunPreset({ ...base, loading: true }), false);
});

test('hidden in the static demo build', () => {
  assert.equal(showFirstRunPreset({ ...base, demo: true }), false);
});

test('hidden when the server sent no presets', () => {
  assert.equal(showFirstRunPreset({ ...base, presetCount: 0 }), false);
});
