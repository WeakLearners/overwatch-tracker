// Stage 1.5 slice 7: the lab side reads tracker data only through lab/client
// and shares only neutral libs with the tracker. This test fails when a lab
// file imports a tracker-side module. Test files and src/test/ are exempt.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';

const root = path.join(__dirname, '..');
const specifiers = (code: string) =>
  [...code.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

const labDir = fs.readdirSync(path.join(root, 'lab'))
  .filter(f => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map(f => `lab/${f}`);
const LAB_FILES = [
  ...labDir,
  'routes/aimAnalysis.ts', 'routes/statsLab.ts', 'routes/advisor.ts',
  'lib/statsInsights.ts', 'lib/curveParams.ts',
  'scripts/nightlyReport.ts', 'scripts/nightlyAnalysis.ts',
];

// Tracker-side modules: the DB handle, the write routes, the experiment
// controller and the credit writers.
const BANNED = [
  /(^|\/)db\/schema$/,
  /(^|\/)experiments(\/|$)/,
  /(^|\/)routes\/(matches|blind|aimIngest)$/,
  /(^|\/)lib\/(credits|aimStatsWrite)$/,
];

describe('import ban: lab files', () => {
  test('the lab file list is not empty', () => {
    assert.ok(LAB_FILES.length >= 12, LAB_FILES.join(', '));
  });

  for (const f of LAB_FILES) {
    test(`${f} imports no tracker-side module`, () => {
      const bad = specifiers(read(f)).filter(s => BANNED.some(re => re.test(s)));
      assert.deepEqual(bad, []);
    });
  }
});

describe('import ban: neutral libs', () => {
  test('lib/queueMode.ts imports nothing', () => {
    assert.deepEqual(specifiers(read('lib/queueMode.ts')), []);
  });

  test('lib/blind.ts gets the queue-mode rule from lib/queueMode', () => {
    assert.ok(specifiers(read('lib/blind.ts')).includes('./queueMode'));
  });

  test('only test files import the DB fixtures, and they live in src/test/', () => {
    assert.ok(!fs.existsSync(path.join(root, 'db/fixtures.ts')));
    assert.ok(fs.existsSync(path.join(root, 'test/dbFixtures.ts')));
    const walk = (d: string): string[] => fs.readdirSync(path.join(root, d), { withFileTypes: true })
      .flatMap(e => e.isDirectory() ? walk(`${d}/${e.name}`) : [`${d}/${e.name}`]);
    const users = walk('.').filter(f => f.endsWith('.ts') && f !== './lab/importBan.test.ts')
      .filter(f => specifiers(read(f)).some(s => /(^|\/)test\/dbFixtures$/.test(s)));
    const nonTest = users.filter(f => !f.endsWith('.test.ts') && !f.startsWith('./test/'));
    assert.deepEqual(nonTest, []);
    assert.ok(users.length > 0);
  });
});
