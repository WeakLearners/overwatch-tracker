import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Stage 1.5 slice 5 (B3): routes/aim.ts is cut into aimIngest (tracker, writes)
// and aimAnalysis (lab, read-only). These tests pin the seam.
const src = (f: string) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const specifiers = (code: string) =>
  [...code.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]);

describe('aim route boundary', () => {
  test('aimIngest imports nothing from the analysis side', () => {
    const bad = specifiers(src('aimIngest.ts')).filter(s =>
      /(^|\/)aimAnalysis$/.test(s) || /(^|\/)lib\/aim$/.test(s) || /(^|\/)lib\/blind$/.test(s) ||
      /(^|\/)experiments(\/|$)/.test(s) || /(^|\/)matches$/.test(s));
    assert.deepEqual(bad, []);
  });

  test('aimAnalysis imports nothing from the ingest side', () => {
    const bad = specifiers(src('aimAnalysis.ts')).filter(s =>
      /(^|\/)aimIngest$/.test(s) || /aimStatsWrite$/.test(s) || /(^|\/)matches$/.test(s));
    assert.deepEqual(bad, []);
  });

  test('aimAnalysis is read-only: no write routes, no SQL writes', () => {
    const code = src('aimAnalysis.ts');
    assert.equal(/router\.(post|put|patch|delete)\(/.test(code), false);
    assert.equal(/\b(INSERT|UPDATE|DELETE)\s/.test(code.replace(/\/\/.*$/gm, '')), false);
    assert.equal(/setCurveParams/.test(code), false);
  });

  test('aimIngest owns exactly the write routes', () => {
    const routes = [...src('aimIngest.ts').matchAll(/router\.(get|post|put|patch|delete)\('([^']*)'/g)]
      .map(m => `${m[1].toUpperCase()} ${m[2]}`);
    assert.deepEqual(routes, ['PUT /curve', 'POST /']);
  });

  test('aimAnalysis owns exactly the read routes', () => {
    const routes = [...src('aimAnalysis.ts').matchAll(/router\.(get|post|put|patch|delete)\('([^']*)'/g)]
      .map(m => `${m[1].toUpperCase()} ${m[2]}`);
    assert.deepEqual(routes, ['GET /curve', 'GET /pending', 'GET /analysis', 'GET /today', 'GET /']);
  });
});
