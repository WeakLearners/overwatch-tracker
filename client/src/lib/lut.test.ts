// parseLutString turns the text Rawaccel shows for a lookup table into the
// points the app stores against every match. It is deliberately strict.
//
// The reason is the 2026-09-17 confound finding: curve_enabled=1 had pooled
// three different live settings into one label, so a "curve on vs off" read
// was comparing a mixture against a baseline. matches.curve_lut exists to stop
// that happening again — but only if what lands in it is really the table that
// was running. A table that parses "wrong but plausibly" is worse than one
// that refuses to parse, because nothing downstream can tell it is wrong.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLutString, formatLut } from './lut';

const ok = (raw: string) => {
  const r = parseLutString(raw);
  assert.ok('points' in r, `expected ${raw} to parse, got: ${'error' in r ? r.error : '?'}`);
  return r.points;
};
const err = (raw: string) => {
  const r = parseLutString(raw);
  assert.ok('error' in r, `expected ${raw} to be rejected`);
  return r.error;
};

test("Sean's real Rawaccel staircase round-trips exactly", () => {
  assert.deepEqual(
    ok('1,1; 16,1; 16.1,1.02; 32,1.02; 32.1,1.1; 140,1.1'),
    [[1, 1], [16, 1], [16.1, 1.02], [32, 1.02], [32.1, 1.1], [140, 1.1]],
  );
});

test('whitespace and a trailing semicolon are tolerated, since a paste carries both', () => {
  assert.deepEqual(ok('  1,1 ;16,1;  32 , 1.1 ;  '), [[1, 1], [16, 1], [32, 1.1]]);
});

test('a single point is refused — one row is not a curve', () => {
  assert.match(err('1,1'), /at least 2/);
});

test('more than 32 points is refused, matching the server bound', () => {
  const many = Array.from({ length: 33 }, (_, i) => `${i + 1},1`).join(';');
  assert.match(err(many), /Too many points \(33\)/);
});

test('a non-numeric value is refused rather than silently becoming NaN', () => {
  assert.match(err('1,1; 16,abc'), /not a number/);
});

test('a three-part chunk is refused rather than dropping the third value', () => {
  assert.match(err('1,1; 16,1,2'), /not an x,y pair/);
});

test('speeds must increase — an out-of-order table would misdescribe the curve', () => {
  assert.match(err('1,1; 32,1.1; 16,1'), /must increase/);
});

test('a repeated speed is refused too — two multipliers at one speed is ambiguous', () => {
  assert.match(err('1,1; 16,1; 16,1.1'), /must increase/);
});

test('an empty string is refused, so a cleared box cannot save an empty table', () => {
  assert.match(err(''), /at least 2/);
});

// The round trip is the reason both functions live in one file. The testing
// page formats a stored table back into the edit box; if parse could not read
// what format wrote, editing a saved table would fail on open.
test('formatLut output parses back to the identical points', () => {
  const pts: [number, number][] = [[1, 1], [16, 1], [16.1, 1.02], [32, 1.02], [32.1, 1.1], [140, 1.1]];
  assert.deepEqual(ok(formatLut(pts)), pts);
});

test('the copy separator drops the space, for pasting back into Rawaccel', () => {
  assert.equal(formatLut([[1, 1], [16, 1], [32, 1.1]], ';'), '1,1;16,1;32,1.1');
});

test('the tight form still parses back, so a copy can be re-pasted here', () => {
  assert.deepEqual(ok(formatLut([[1, 1], [16, 1], [32, 1.1]], ';')), [[1, 1], [16, 1], [32, 1.1]]);
});
