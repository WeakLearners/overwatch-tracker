import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { computeHabits, describeHabits, holdingHabits, HABITS_GROUPS, type HabitMatch } from './habits';

let id = 0;
// One comp match. `min` is minutes after 08:00 on `date`.
const m = (date: string, min: number, win: number, mode = 'comp_role', time?: string | null, hero = 'H'): HabitMatch => {
  id += 1;
  const hh = String(8 + Math.floor(min / 60)).padStart(2, '0');
  const mm = String(min % 60).padStart(2, '0');
  return { id, date, time: time === undefined ? `${date}T${hh}:${mm}:00` : time, hero, win, queue_mode: mode };
};
// n matches on a date, 20 minutes apart (one session), with the given wins.
const day = (date: string, wins: number[]) => wins.map((w, i) => m(date, i * 20, w));
const dates = (n: number, from = '2026-06-01') => {
  const d = new Date(`${from}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => { const x = new Date(d); x.setUTCDate(x.getUTCDate() + i); return x.toISOString().slice(0, 10); });
};
const pattern = (n: number, winEvery: number) => Array.from({ length: n }, (_, i) => (i % winEvery === 0 ? 1 : 0));
const row = (r: ReturnType<typeof computeHabits>, id: string) => r.rows.find(x => x.id === id)!;

describe('computeHabits', () => {
  test('threshold is 0.05 over the groups shown', () => {
    const r = computeHabits(day('2026-06-01', [1, 0, 1]));
    assert.equal(r.groupsTested, HABITS_GROUPS);
    assert.equal(r.threshold, 0.05 / 10);
    assert.equal(row(r, 'form100').groups[0].finding.threshold, 0.05 / 10);
  });

  test('comp only: quick play is ignored, window is the last 300 comp matches', () => {
    id = 0;
    const rows = [...dates(10).flatMap(d => day(d, pattern(40, 2))), m('2026-06-20', 0, 1, 'qp_role')];
    const r = computeHabits(rows);
    assert.equal(r.window.n, 300);
    assert.equal(r.window.to, '2026-06-10');
  });

  test('form: holds when the last 100 sit far below the baseline', () => {
    id = 0;
    const base = dates(15, '2026-01-01').flatMap(d => day(d, pattern(20, 2)));        // 300 at 50%, 100 of them in the window
    const recent = dates(10, '2026-07-01').flatMap(d => day(d, pattern(20, 10)));     // 200 at 10%
    const r = computeHabits([...base, ...recent]);
    const f = row(r, 'form100');
    assert.equal(f.status, 'holds');
    assert.equal(f.groups[0].finding.n, 100);
    assert.equal(f.groups[0].rest.n, 200);
    assert.match(f.action ?? '', /below/);
  });

  test('form: no difference, no action text', () => {
    id = 0;
    const base = dates(10, '2026-01-01').flatMap(d => day(d, pattern(20, 2)));
    const recent = dates(10, '2026-07-01').flatMap(d => day(d, pattern(20, 2)));
    const f = row(computeHabits([...base, ...recent]), 'form200');
    assert.equal(f.status, 'none');
    assert.equal(f.action, null);
  });

  test('form: thin when the baseline has under 40 matches', () => {
    id = 0;
    const r = computeHabits(dates(5).flatMap(d => day(d, pattern(20, 2))));
    const f = row(r, 'form100');
    assert.equal(f.status, 'thin');
    assert.equal(f.groups[0].finding.p, null);
    assert.equal(f.action, null);
  });

  test('day load: holds when 9+ days lose and short days win', () => {
    id = 0;
    const longDays = dates(5).flatMap(d => day(d, pattern(10, 10)));           // 50 matches at 10%
    const shortDays = dates(8, '2026-07-01').flatMap(d => day(d, pattern(8, 2))); // 64 at 50%
    const r = computeHabits([...longDays, ...shortDays]);
    const d = row(r, 'dayLoad');
    assert.equal(d.status, 'holds');
    assert.equal(d.groups[0].finding.n, 50);
    assert.equal(d.groups[0].rest.n, 64);
    assert.match(d.action ?? '', /Stop at 8/);
  });

  test('day load: a day split by the window edge is still counted whole', () => {
    id = 0;
    // 305 matches: 5 days of 10 before, the window starts mid-day on the first long day.
    const rows = dates(31).flatMap(d => day(d, pattern(10, 2))).slice(-305);
    const r = computeHabits(rows);
    assert.equal(r.window.n, 300);
    assert.equal(row(r, 'dayLoad').groups[0].finding.n, 300);   // every day has 10, all are 9+
  });

  test('day load: no difference at equal rates; thin under 40', () => {
    id = 0;
    const eq = computeHabits([
      ...dates(5).flatMap(d => day(d, pattern(10, 2))),
      ...dates(8, '2026-07-01').flatMap(d => day(d, pattern(8, 2))),
    ]);
    assert.equal(row(eq, 'dayLoad').status, 'none');
    id = 0;
    const thin = computeHabits([
      ...dates(2).flatMap(d => day(d, pattern(10, 2))),                       // 20 long-day matches
      ...dates(8, '2026-07-01').flatMap(d => day(d, pattern(8, 2))),
    ]);
    assert.equal(row(thin, 'dayLoad').status, 'thin');
    assert.equal(row(thin, 'dayLoad').action, null);
  });

  test('position: a gap over 90 minutes starts a new session', () => {
    id = 0;
    // Day of 6: matches at 0,20,40 then a 100 minute gap, then 140,160,180.
    const rows = [0, 20, 40, 140, 160, 180].map(min => m('2026-06-01', min, 1));
    const r = computeHabits(rows);
    const pos = row(r, 'position');
    // Every match is position 1-3 (two sessions of three), none is 4+.
    assert.equal(pos.groups[0].finding.n, 6);
    assert.equal(pos.groups[1].finding.n, 0);
    assert.equal(pos.groups[2].finding.n, 0);
  });

  test('position: a gap of exactly 90 minutes stays in the session', () => {
    id = 0;
    const r = computeHabits([m('2026-06-01', 0, 1), m('2026-06-01', 90, 1), m('2026-06-01', 180, 1), m('2026-06-01', 270, 1)]);
    assert.equal(row(r, 'position').groups[1].finding.n, 1);   // fourth match is position 4
  });

  test('position: holds when matches 7+ lose', () => {
    id = 0;
    const days = dates(30).flatMap(d => day(d, [1, 0, 1, 0, 1, 0, 0, 0]));   // matches 1-6 at 50%, 7-8 at 0%
    const r = computeHabits(days);
    const pos = row(r, 'position');
    assert.equal(pos.groups[2].finding.n, 60);
    assert.equal(pos.status, 'holds');
    assert.match(pos.action ?? '', /Stop before match 7/);
  });

  test('position: no difference when every bin wins at the same rate', () => {
    id = 0;
    // Odd days win the odd positions, even days win the even ones: every position wins 50%.
    const r = computeHabits(dates(30).flatMap((d, i) => day(d, [0, 1, 0, 1, 0, 1, 0, 1].map(w => (i % 2 ? w : 1 - w)))));
    assert.equal(row(r, 'position').status, 'none');
    assert.equal(row(r, 'position').action, null);
  });

  test('position: thin when no bin reaches 40 matches', () => {
    id = 0;
    const r = computeHabits(dates(5).flatMap(d => day(d, [1, 0, 1, 0, 1, 0, 1, 0])));   // 7+ bin has 10, 1-3 has 15
    assert.equal(row(r, 'position').status, 'thin');
  });

  test('time quality: rows before 2026-03-01 and rows with no time are left out of position only', () => {
    id = 0;
    const old = dates(10, '2026-01-01').flatMap(d => day(d, pattern(8, 2)));        // 80, before the cut
    const noTime = dates(5, '2026-06-01').flatMap(d => [m(d, 0, 1, 'comp_role', null), m(d, 20, 0, 'comp_role', null)]); // 10
    const live = dates(5, '2026-07-01').flatMap(d => day(d, pattern(8, 2)));        // 40
    const r = computeHabits([...old, ...noTime, ...live]);
    assert.equal(r.window.n, 130);
    assert.equal(r.positionExcluded, 90);
    const total = row(r, 'position').groups[0].finding.n + row(r, 'position').groups[1].finding.n + row(r, 'position').groups[2].finding.n;
    assert.equal(total, 40);
    assert.equal(row(r, 'dayLoad').groups[0].finding.n + row(r, 'dayLoad').groups[0].rest.n, 130);   // day load keeps them
  });

  test('switch vs repeat: holds when switching loses; first of a session is excluded', () => {
    id = 0;
    // 20 days of 8 matches: heroes alternate A,B each match (all switches, win 10%) on even days,
    // all A (repeats, win 60%) on odd days.
    const rows = dates(20).flatMap((d, i) => Array.from({ length: 8 }, (_, k) =>
      m(d, k * 20, i % 2 ? (k % 5 < 3 ? 1 : 0) : (k === 3 ? 1 : 0), 'comp_role', undefined, i % 2 ? 'A' : (k % 2 ? 'B' : 'A'))));
    const r = computeHabits(rows);
    const s = row(r, 'switch');
    assert.equal(s.groups[0].finding.n, 70);      // 10 even days x 7 (first of session left out)
    assert.equal(s.groups[0].rest.n, 70);
    assert.equal(r.switchExcluded, 20);
    assert.equal(s.status, 'holds');
    assert.match(s.action ?? '', /Stay on a hero/);
  });

  test('switch vs repeat: thin with few switches, none at equal rates', () => {
    id = 0;
    const thin = computeHabits(dates(5).flatMap(d => day(d, pattern(8, 2))));   // all hero H, no switches
    assert.equal(row(thin, 'switch').status, 'thin');
    assert.equal(row(thin, 'switch').action, null);
  });

  test('hero experience: counts only the same hero in the prior 30 days', () => {
    id = 0;
    // Hero X once on day 1, again 31 days later: the first match is not in the 30-day count.
    const a = m('2026-06-01', 0, 1, 'comp_role', undefined, 'X');
    const b = m('2026-07-02', 0, 0, 'comp_role', undefined, 'X');
    const c = m('2026-07-02', 20, 0, 'comp_role', undefined, 'X');
    const r = computeHabits([a, b, c]);
    // b has 0 prior (a is 31 days back); c has 1. Both in the 0-4 bin.
    assert.equal(row(r, 'experience').groups[0].finding.n, 3);
  });

  test('hero experience: holds when the 20+ bin loses', () => {
    id = 0;
    // One hero played 25 per day for 4 days (first 20 of day 1 are 0-4 bin... later matches 20+), plus fresh heroes.
    const grind = dates(6).flatMap(d => Array.from({ length: 25 }, (_, k) => m(d, k * 3, k % 10 === 0 ? 1 : 0, 'comp_role', undefined, 'G')));
    const fresh = Array.from({ length: 60 }, (_, k) => m(dates(1, '2026-07-01')[0], k * 3, k % 2 ? 1 : 0, 'comp_role', undefined, `F${k}`));
    const r = computeHabits([...grind, ...fresh]);
    const e = row(r, 'experience');
    assert.equal(e.groups.length, 3);
    assert.equal(e.status, 'holds');
    assert.match(e.action ?? '', /prior 30 days/);
  });

  test('hero spread: descriptive only, distinct heroes per 20', () => {
    id = 0;
    const heroes = ['A', 'B', 'C', 'D'];
    const r = computeHabits(Array.from({ length: 40 }, (_, k) => m('2026-06-01', k, 1, 'comp_role', undefined, heroes[k % 4])));
    assert.equal(r.spread.window.perTwenty, 4);
    assert.equal(r.spread.window.topShare, 25);
    assert.equal(r.spread.baseline.perTwenty, null);
    assert.ok(!r.rows.some(x => x.id === ('spread' as string)));
  });
});

describe('Slack line and holding rows (S3)', () => {
  test('a row holds: the line carries its action text', () => {
    id = 0;
    const base = dates(15, '2026-01-01').flatMap(d => day(d, pattern(20, 2)));
    const recent = dates(10, '2026-06-01').flatMap(d => day(d, pattern(10, 10)));
    const r = computeHabits([...base, ...recent]);
    const held = holdingHabits(r);
    assert.ok(held.length > 0);
    const line = describeHabits(r);
    assert.ok(line.startsWith('*Play habits:*'));
    assert.ok(line.includes(held[0].action));
    assert.ok(!line.includes('\n'));
  });
  test('no row holds: the line says no finding', () => {
    id = 0;
    const r = computeHabits(day('2026-06-01', [1, 0, 1, 0]));
    assert.equal(holdingHabits(r).length, 0);
    assert.equal(describeHabits(r), '*Play habits:* no finding (last 4 comp, no row holds).');
  });
});
