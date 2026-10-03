// The lab's study tag table must agree with the tracker registry about which
// column each tagged field writes, and the registry must no longer carry `study`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { STUDY_TAGS, studyTagFor } from './studyTags';
import { FIELD_REGISTRY, fieldById } from '../lib/fieldRegistry';

test('every tag points at a registry field that writes that matches column', () => {
  for (const [id, tag] of Object.entries(STUDY_TAGS)) {
    const f = fieldById(id);
    assert.ok(f, `${id} is not in the tracker registry`);
    assert.equal(f.writesTo.table, 'matches');
    assert.equal(f.writesTo.columns[0], tag.column);
  }
});

test('the five tags are exactly the ones the registry carried before slice 5b', () => {
  assert.deepEqual(Object.keys(STUDY_TAGS).sort(), ['leaver', 'leaver_side', 'match_quality', 'result_driver', 'team_rating']);
  assert.deepEqual(studyTagFor('result_driver')?.metrics, ['accuracy']);
  assert.deepEqual(studyTagFor('leaver')?.metrics, ['win_rate', 'accuracy']);
});

test('lookup ignores inherited object keys', () => {
  assert.equal(studyTagFor('constructor'), undefined);
  assert.equal(studyTagFor('lobby_low'), undefined);
});

test('the tracker registry carries no study tag', () => {
  assert.ok(FIELD_REGISTRY.every(f => !('study' in f)));
});
