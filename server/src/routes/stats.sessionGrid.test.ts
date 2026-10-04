// Slice 6a (split plan decision 5): the plain day x hour grid and the full map
// table are descriptive reads of the same `matches` rows as /by-hour, /by-day
// and /by-map. These tests pin that they agree for the same filters, and that
// crashed matches (result-only rows with a real map and hour) are counted.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';

let h: Harness;
beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

const DAYS = ['Monday', 'Tuesday'] as const;
let seq = 0;
async function log(o: { day: typeof DAYS[number]; hour: number; map: string; win: boolean; mode?: string; crashed?: boolean }) {
  seq += 1;
  const date = o.day === 'Monday' ? '2026-09-28' : '2026-09-29';
  const body: Record<string, unknown> = {
    date, time: `${date}T${String(o.hour).padStart(2, '0')}:${String(seq % 60).padStart(2, '0')}:00`,
    day_of_week: o.day, hour: o.hour, map: o.map, game_type: 'Control',
    queue_mode: o.mode ?? 'comp_role', role: 'DPS', win: o.win,
  };
  if (o.crashed) body.crashed = true; else body.hero = 'Ashe';
  const r = await h.post('/api/matches', body);
  assert.equal(r.status, 200, JSON.stringify(r.body));
}

async function seed() {
  // Mon 8: Ilios 2W 1L (one loss is a crashed match). Mon 20: Oasis 1W. Tue 8: Ilios 1L, Nepal 1W 1L (qp).
  await log({ day: 'Monday', hour: 8, map: 'Ilios', win: true });
  await log({ day: 'Monday', hour: 8, map: 'Ilios', win: true });
  await log({ day: 'Monday', hour: 8, map: 'Ilios', win: false, crashed: true });
  await log({ day: 'Monday', hour: 20, map: 'Oasis', win: true });
  await log({ day: 'Tuesday', hour: 8, map: 'Ilios', win: false });
  await log({ day: 'Tuesday', hour: 8, map: 'Nepal', win: true, mode: 'qp_role' });
  await log({ day: 'Tuesday', hour: 8, map: 'Nepal', win: false, mode: 'qp_role' });
}

describe('GET /api/stats/by-day-hour', () => {
  test('cells carry games, wins and win rate, crashed matches included, no floor', async () => {
    await seed();
    const r = await h.get('/api/stats/by-day-hour');
    assert.equal(r.status, 200);
    const cell = (d: string, hr: number) => r.body.find((c: any) => c.day_of_week === d && c.hour === hr);
    assert.deepEqual(
      { g: cell('Monday', 8).games, w: cell('Monday', 8).wins, wr: cell('Monday', 8).win_rate },
      { g: 3, w: 2, wr: 66.7 });
    assert.equal(cell('Monday', 20).games, 1);           // one game still shows (no HAVING)
    assert.equal(cell('Tuesday', 8).games, 3);
    assert.equal(r.body.length, 3);                       // only cells with a game
  });

  test('cells sum to /by-hour and /by-day for the same filters', async () => {
    await seed();
    for (const q of ['', '?queue_mode=comp_role', '?queue_mode=qp_role', '?from=2026-09-29']) {
      const grid = (await h.get(`/api/stats/by-day-hour${q}`)).body as any[];
      const byHour = (await h.get(`/api/stats/by-hour${q}`)).body as any[];
      const byDay = (await h.get(`/api/stats/by-day${q}`)).body as any[];
      for (const row of byHour) {
        const cells = grid.filter(c => c.hour === row.hour);
        assert.equal(cells.reduce((n, c) => n + c.games, 0), row.games, `hour ${row.hour} ${q}`);
        assert.equal(cells.reduce((n, c) => n + c.wins, 0), row.wins, `hour ${row.hour} wins ${q}`);
      }
      for (const row of byDay) {
        const cells = grid.filter(c => c.day_of_week === row.day_of_week);
        assert.equal(cells.reduce((n, c) => n + c.games, 0), row.games, `${row.day_of_week} ${q}`);
      }
    }
  });
});

describe('GET /api/stats/by-map min_games', () => {
  test('default keeps the floor of 3; min_games=1 lists every map and agrees where both show', async () => {
    await seed();
    const dflt = (await h.get('/api/stats/by-map')).body as any[];
    const all = (await h.get('/api/stats/by-map?min_games=1')).body as any[];
    assert.deepEqual(dflt.map(m => m.map), ['Ilios']);           // Ilios 4 games; Nepal 2, Oasis 1 under the floor
    assert.deepEqual(all.map(m => m.map).sort(), ['Ilios', 'Nepal', 'Oasis']);
    const ilios = all.find(m => m.map === 'Ilios');
    assert.deepEqual({ g: ilios.games, w: ilios.wins }, { g: 4, w: 2 });  // crashed match counted
    assert.deepEqual(dflt[0], ilios);
    // filter parity: total games over all maps equals /overview for the same filter
    const ov = (await h.get('/api/stats/overview?queue_mode=qp_role')).body;
    const allQp = (await h.get('/api/stats/by-map?min_games=1&queue_mode=qp_role')).body as any[];
    assert.equal(allQp.reduce((n, m) => n + m.games, 0), (Array.isArray(ov) ? ov[0] : ov).total);
  });

  test('a junk min_games falls back to the floor', async () => {
    await seed();
    const r = (await h.get('/api/stats/by-map?min_games=abc')).body as any[];
    assert.deepEqual(r.map(m => m.map), ['Ilios']);
  });
});

describe('session.loss_streak', () => {
  test('counts consecutive losses ending today, from the data', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const mk = (win: boolean, t: string) => h.post('/api/matches', {
      date: today, time: `${today}T${t}`, hour: 1, day_of_week: 'Monday', map: 'Ilios', game_type: 'Control',
      queue_mode: 'comp_role', role: 'DPS', hero: 'Ashe', win,
    });
    await mk(true, '01:00:00'); await mk(false, '01:10:00'); await mk(false, '01:20:00'); await mk(false, '01:30:00');
    const r = await h.get('/api/stats/prematch');
    assert.equal(r.body.session.on_tilt, true);
    assert.equal(r.body.session.loss_streak, 3);
  });
});
