// DB-integration tests for GET /api/blind/next. lib/nextTest.test.ts already
// covers the pure pick/tie/role logic exhaustively with plain data —
// this suite exists only to prove the wiring: that real blind_stage_sets/
// blind_credits/matches rows get turned into the right inputs for that
// function. See blind.routes.test.ts for the harness/makeSet conventions.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';

let h: Harness;

beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

// Each game also gets an aim_stats_heroes.duration_min reading (written
// directly against the DB — there's no HTTP endpoint that bundles duration
// into the match-create call), defaulting to 12 minutes so 5 games close
// exactly one 60-minute block (BLOCK_MINUTES, lib/blind.ts) — a 1:1
// stand-in for the old fixed "5 games = 1 stint" unit that keeps this
// suite's game counts meaningful under the 2026-09-27 block model. A test
// that wants a fast-completing chunked set passes durationMin: 60 (1
// game = 1 block) instead.
async function playGames(
  hero: string, n: number,
  opts: { win?: boolean; queue_mode?: string; durationMin?: number; role?: string } = {},
) {
  for (let i = 0; i < n; i++) {
    const r = await h.post('/api/matches', {
      date: '2026-09-23', time: '12:00', hour: 12, hero, role: opts.role ?? 'DPS',
      map: 'Ilios', game_type: 'comp', win: opts.win ?? (i % 2 === 0),
      queue_mode: opts.queue_mode ?? 'comp_role',
    });
    assert.equal(r.status, 200, `match failed: ${JSON.stringify(r.body)}`);
    h.db.prepare(
      'INSERT INTO aim_stats_heroes (match_id, hero, duration_min) VALUES (:match_id, :hero, :duration_min)',
    ).run({ match_id: r.body.id, hero, duration_min: opts.durationMin ?? 12 });
  }
}

async function makeSet(opts: { hero: string; batch_size?: number; chunk_size?: number; phase?: string; senses?: number[] }) {
  const r = await h.post('/api/blind/sets', {
    hero: opts.hero, batch_size: opts.batch_size ?? 4,
    senses: opts.senses ?? [2.0, 3.0], phase: opts.phase ?? 'phaseA',
    ...(opts.chunk_size != null ? { chunk_size: opts.chunk_size } : {}),
  });
  assert.equal(r.status, 200, `set creation failed: ${JSON.stringify(r.body)}`);
  return r.body.set_id as number;
}

describe('GET /api/blind/next — quickplay', () => {
  test('quickplay shows the roster but no pick', async () => {
    await makeSet({ hero: 'Tracer' });
    const r = await h.get('/api/blind/next?queue_mode=qp_role');
    assert.equal(r.status, 200);
    assert.equal(r.body.isQuickplay, true);
    assert.equal(r.body.picks, undefined);
  });
});

// chunk_size 2 makes a set report playedMinutes, which is what the pick ranks on.
const CH = { batch_size: 40, chunk_size: 2, phase: 'phaseA' };

describe('GET /api/blind/next — role queue', () => {
  test('no comp match yet: lower clock wins (tie -> DPS), least-minutes hero in that role', async () => {
    await makeSet({ hero: 'Tracer', ...CH });
    await makeSet({ hero: 'Ana', ...CH });
    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.equal(r.body.isQuickplay, false);
    assert.equal(r.body.recommendedRole, 'DPS');
    assert.deepEqual(r.body.picks, [{ hero: 'Tracer', role: 'DPS' }]);
  });

  test('role comes from the newest comp role-queue match, and the pick is the least-minutes hero of that role', async () => {
    await makeSet({ hero: 'Tracer', ...CH });
    await makeSet({ hero: 'Pharah', ...CH });
    await makeSet({ hero: 'Ana', ...CH });
    await playGames('Tracer', 3);                   // 36 min
    await playGames('Ana', 1, { role: 'Support' }); // newest: Support
    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.equal(r.body.recommendedRole, 'Support');
    assert.deepEqual(r.body.picks, [{ hero: 'Ana', role: 'Support' }]);
    // Newest match is DPS instead: the role goes back to DPS, and Tracer's open block (48 min) holds.
    await playGames('Tracer', 1);
    const r2 = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.equal(r2.body.recommendedRole, 'DPS');
    assert.deepEqual(r2.body.picks, [{ hero: 'Tracer', role: 'DPS' }]);
  });

  test('flips to the other role after the newest match crosses 240 minutes', async () => {
    await makeSet({ hero: 'Tracer', ...CH });
    await makeSet({ hero: 'Ana', ...CH });
    await playGames('Tracer', 2, { durationMin: 120 }); // 240 on the DPS clock: reset
    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.equal(r.body.recommendedRole, 'Support');
    assert.deepEqual(r.body.picks, [{ hero: 'Ana', role: 'Support' }]);
  });

  test('block lock: a hero mid-block is held while another has fewer minutes', async () => {
    await makeSet({ hero: 'Tracer', ...CH });
    await makeSet({ hero: 'Pharah', ...CH });
    await playGames('Tracer', 2); // Tracer 24 min mid-block, Pharah 0
    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.deepEqual(r.body.picks, [{ hero: 'Tracer', role: 'DPS' }]);
    assert.deepEqual(r.body.block, { hero: 'Tracer', role: 'DPS', openMinutes: 24 });
    assert.equal(r.body.justClosed, null);
  });

  test('a block close recomputes by least minutes and reports justClosed', async () => {
    await makeSet({ hero: 'Tracer', ...CH });
    await makeSet({ hero: 'Pharah', ...CH });
    await playGames('Tracer', 5); // exactly 60 min
    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.equal(r.body.block, null);
    assert.deepEqual(r.body.justClosed, { hero: 'Tracer' });
    assert.deepEqual(r.body.picks, [{ hero: 'Pharah', role: 'DPS' }]);
  });

  test('a role flip overrides an open block', async () => {
    await makeSet({ hero: 'Tracer', ...CH });
    await makeSet({ hero: 'Ana', ...CH });
    await playGames('Genji', 1, { durationMin: 230 }); // DPS clock 230, no credit (no set)
    await playGames('Tracer', 1);                       // 12 more: DPS clock 242 -> reset; Tracer block 12 min open
    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.equal(r.body.block, null, 'the flip overrides the open block');
    assert.equal(r.body.recommendedRole, 'Support');
    assert.deepEqual(r.body.picks, [{ hero: 'Ana', role: 'Support' }]);
  });

  test('a Quickplay match does not move the role', async () => {
    await makeSet({ hero: 'Tracer', ...CH });
    await makeSet({ hero: 'Ana', ...CH });
    await playGames('Tracer', 1);
    await playGames('Ana', 1, { role: 'Support', queue_mode: 'qp_role' });
    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.equal(r.body.recommendedRole, 'DPS');
  });
});

describe('GET /api/blind/next — open queue', () => {
  test('one open block holds its hero; the other role takes its least-minutes hero', async () => {
    await makeSet({ hero: 'Tracer', ...CH });
    await makeSet({ hero: 'Pharah', ...CH });
    await makeSet({ hero: 'Ana', ...CH });
    await makeSet({ hero: 'Juno', ...CH });
    await playGames('Ana', 1, { role: 'Support' });
    await playGames('Tracer', 2); // newest: Tracer mid-block (24 min)
    const r = await h.get('/api/blind/next?queue_mode=comp_open');
    assert.equal(r.body.recommendedRole, null);
    assert.deepEqual(r.body.picks, [{ hero: 'Tracer', role: 'DPS' }, { hero: 'Juno', role: 'Support' }]);
  });

  test('no open block: least-minutes DPS and Support hero', async () => {
    await makeSet({ hero: 'Tracer', ...CH });
    await makeSet({ hero: 'Pharah', ...CH });
    await makeSet({ hero: 'Ana', ...CH });
    await makeSet({ hero: 'Juno', ...CH });
    await playGames('Tracer', 5); // closes a block: nothing open
    await playGames('Ana', 5, { role: 'Support' });
    const r = await h.get('/api/blind/next?queue_mode=comp_open');
    assert.deepEqual(r.body.picks, [{ hero: 'Pharah', role: 'DPS' }, { hero: 'Juno', role: 'Support' }]);
  });
});

describe('GET /api/blind/next — roster annotation', () => {
  test('heroes carry rank and cold; rank 0 is the top pick overall', async () => {
    await makeSet({ hero: 'Tracer', ...CH });
    await makeSet({ hero: 'Ana', ...CH });
    await playGames('Tracer', 1);
    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    const byHero = Object.fromEntries(r.body.heroes.map((x: any) => [x.hero, x]));
    assert.equal(byHero.Ana.rank, 0);
    assert.equal(byHero.Tracer.rank, 1);
    assert.equal(byHero.Ana.cold, false);
  });
});

describe('GET /api/blind/next — phase scoping and finished heroes', () => {
  test('a set from an OLDER phase is not part of the current-phase roster', async () => {
    await makeSet({ hero: 'Ana', batch_size: 4, phase: 'phaseOld' });
    await makeSet({ hero: 'Tracer', batch_size: 4, phase: 'phaseNew' });
    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.equal(r.body.phase, 'phaseNew');
    assert.deepEqual(r.body.picks.map((o: any) => o.hero), ['Tracer']);
  });

  // chunk_size plus a 60-minute duration per game makes every game close one
  // block, so STAGE_BLOCKS(8) x n_stages(2) = 16 games complete a set.
  test('a finished hero shows as finished and is not picked', async () => {
    await makeSet({ hero: 'Tracer', batch_size: 10, chunk_size: 1, phase: 'phaseA' });
    await makeSet({ hero: 'Ana', batch_size: 10, chunk_size: 1, phase: 'phaseA' });
    await playGames('Tracer', 16, { durationMin: 60 });
    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.deepEqual(r.body.finishedHeroes, ['Tracer']);
    assert.equal(r.body.recommendedRole, 'Support');
    assert.deepEqual(r.body.picks, [{ hero: 'Ana', role: 'Support' }]);
  });

  test('every hero finished reports allFinished', async () => {
    await makeSet({ hero: 'Tracer', batch_size: 10, chunk_size: 1, phase: 'phaseA' });
    await playGames('Tracer', 16, { durationMin: 60 });
    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.equal(r.body.allFinished, true);
    assert.equal(r.body.recommendedRole, null);
    assert.deepEqual(r.body.picks, []);
  });
});

describe('GET /api/blind/next — chunked (ABBA) vs unchunked sets', () => {
  test('an unchunked (legacy) set reports progress in games, not blocks', async () => {
    await makeSet({ hero: 'Tracer', batch_size: 10, phase: 'phaseA' }); // no chunk_size
    await playGames('Tracer', 5);
    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    const t = r.body.heroes[0];
    assert.equal(t.credited, 5); // still a plain game count
    assert.equal(t.target, 20); // batch_size(10) x n_stages(2)
  });

  test('a chunked (ABBA) set reports progress in closed blocks, not games', async () => {
    await makeSet({ hero: 'Tracer', batch_size: 10, chunk_size: 2, phase: 'phaseA' });
    await playGames('Tracer', 5); // exactly 60 min -> exactly 1 closed block
    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    const t = r.body.heroes[0];
    assert.equal(t.credited, 1); // 1 closed block, not 5 games
    assert.equal(t.target, 16); // STAGE_BLOCKS(8) x n_stages(2)
    assert.equal(t.playedMinutes, 60);
  });
});
