import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { sectionFor, SECTION_PATHS, DASHBOARD_PATHS } from './dashSections';

describe('sectionFor', () => {
  test('each section path maps back to its section', () => {
    for (const [id, p] of Object.entries(SECTION_PATHS)) assert.equal(sectionFor(p, ''), id);
  });
  test('/prematch and /log land on Match', () => {
    assert.equal(sectionFor('/prematch', ''), 'sec-match');
    assert.equal(sectionFor('/log', ''), 'sec-match');
  });
  test('old #sec-* hash still works', () => {
    assert.equal(sectionFor('/', '#sec-career'), 'sec-career');
  });
  test('top of page has no section', () => {
    assert.equal(sectionFor('/', ''), null);
  });
  test('every path is a dashboard path', () => {
    assert.ok(DASHBOARD_PATHS.includes('/trends') && DASHBOARD_PATHS.includes('/log'));
  });
});
