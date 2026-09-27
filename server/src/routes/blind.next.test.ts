// DB-integration tests for GET /api/blind/next. lib/nextTest.test.ts already
// covers the pure ranking/block/cold logic exhaustively with plain data —
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
  opts: { win?: boolean; queue_mode?: string; durationMin?: number } = {},
) {
  for (let i = 0; i < n; i++) {
    const r = await h.post('/api/matches', {
      date: '2026-09-23', time: '12:00', hour: 12, hero, role: 'DPS',
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
  test('quickplay shows no roster at all', async () => {
    await makeSet({ hero: 'Tracer' });
    const r = await h.get('/api/blind/next?queue_mode=qp_role');
    assert.equal(r.status, 200);
    assert.equal(r.body.isQuickplay, true);
    assert.equal(r.body.orderedHeroes, undefined);
  });
});

describe('GET /api/blind/next — ordering and phase scoping', () => {
  test('recommends the role of the least-progressed hero in the current phase', async () => {
    await makeSet({ hero: 'Tracer', batch_size: 40, phase: 'phaseA' }); // DPS
    await makeSet({ hero: 'Ana', batch_size: 40, phase: 'phaseA' }); // Support
    // A full 60-minute block on Ana (5 games x 12 min): reaches the
    // boundary (openMinutes === 0), so the card recomputes instead of
    // staying locked on Ana.
    await playGames('Ana', 5);

    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.equal(r.body.isQuickplay, false);
    assert.equal(r.body.block, null, 'landed exactly on a block boundary');
    assert.equal(r.body.recommendedRole, 'DPS'); // Tracer (0 credited) beats Ana (5)
    assert.deepEqual(r.body.orderedHeroes.map((o: any) => o.hero), ['Tracer']);
  });

  test('a set from an OLDER phase is not part of the current-phase roster', async () => {
    await makeSet({ hero: 'Ana', batch_size: 4, phase: 'phaseOld' });
    await makeSet({ hero: 'Tracer', batch_size: 4, phase: 'phaseNew' });
    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.equal(r.body.phase, 'phaseNew');
    assert.deepEqual(r.body.orderedHeroes.map((o: any) => o.hero), ['Tracer']);
  });
});

describe('GET /api/blind/next — finished heroes', () => {
  // chunk_size (any nonzero value — it's just the ABBA-enabled flag now,
  // lib/blind.ts's block-model comment) plus a 60-minute duration per game
  // makes every single game close exactly one block, so STAGE_BLOCKS(8) x
  // n_stages(2) = 16 games complete both stages without needing a manual
  // /advance call — the fast-completing-fixture equivalent of the old
  // "chunk_size 1, batch_size 2" trick, sized to the fixed block-model
  // constants instead of an arbitrary small batch_size.
  test('a hero that finished its batch on every stage shows as finished, not in the pick', async () => {
    await makeSet({ hero: 'Tracer', batch_size: 10, chunk_size: 1, phase: 'phaseA' });
    await makeSet({ hero: 'Ana', batch_size: 10, chunk_size: 1, phase: 'phaseA' });
    await playGames('Tracer', 16, { durationMin: 60 });

    // Tracer's own block just hit its test target, but the mid-block lock
    // only applies to a hero still pending — Tracer already completed, so
    // the card falls through to a full recompute rather than staying
    // locked on a finished hero.
    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.deepEqual(r.body.finishedHeroes, ['Tracer']);
    assert.equal(r.body.recommendedRole, 'Support');
  });

  test('every hero finished reports allFinished', async () => {
    await makeSet({ hero: 'Tracer', batch_size: 10, chunk_size: 1, phase: 'phaseA' });
    await playGames('Tracer', 16, { durationMin: 60 });
    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.equal(r.body.allFinished, true);
    assert.equal(r.body.recommendedRole, null);
  });
});

describe('GET /api/blind/next — block (real match log)', () => {
  test('two comp matches in a row mid-block locks the same hero', async () => {
    await makeSet({ hero: 'Tracer', batch_size: 40, phase: 'phaseA' });
    await makeSet({ hero: 'Ana', batch_size: 40, phase: 'phaseA' });
    await playGames('Tracer', 2); // 2 games x 12 min = 24 min into the open block

    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.deepEqual(r.body.block, { hero: 'Tracer', role: 'DPS', openMinutes: 24 });
    assert.equal(r.body.recommendedRole, 'DPS');
    assert.deepEqual(r.body.orderedHeroes, []);
  });

  test('a Quickplay match in between does not break or advance the block', async () => {
    await makeSet({ hero: 'Tracer', batch_size: 40, phase: 'phaseA' });
    await playGames('Tracer', 2); // 24 min
    await playGames('Tracer', 1, { queue_mode: 'qp_role' }); // uncredited, must be invisible
    await playGames('Tracer', 1); // 3rd credited game -> 36 min

    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.equal(r.body.block.openMinutes, 36, 'the QP game did not count toward or reset the block');
  });

  test('at the 5th consecutive credited game (60 minutes), the card recomputes instead of staying', async () => {
    await makeSet({ hero: 'Tracer', batch_size: 40, phase: 'phaseA' });
    await makeSet({ hero: 'Ana', batch_size: 40, phase: 'phaseA' });
    await playGames('Tracer', 5); // exactly 60 min -> block closes

    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.equal(r.body.block, null);
  });
});

describe('GET /api/blind/next — going cold', () => {
  test('a hero unplayed 7+ days jumps to the top of its role even though it is MORE progressed', async () => {
    const oldId = await makeSet({ hero: 'Pharah', batch_size: 40, phase: 'phaseA' });
    await makeSet({ hero: 'Tracer', batch_size: 40, phase: 'phaseA' });
    // A full 60-minute block on Pharah (5 games): reaches the boundary, so
    // the very next call is a full recompute rather than a "stay on
    // Pharah" lock.
    await playGames('Pharah', 5);
    // Backdate all 5 of Pharah's credited matches 10 days so it reads as
    // cold, while Tracer (never played) is not.
    h.db.prepare(`
      UPDATE matches SET created_at = datetime('now', '-10 days')
      WHERE id IN (SELECT match_id FROM blind_credits WHERE blind_set_id = ?)
    `).run(oldId);

    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.equal(r.body.block, null, 'landed exactly on a block boundary');
    // Tracer (0 credited) is still the true least-progressed pick overall,
    // so DPS is still the recommended role...
    assert.equal(r.body.recommendedRole, 'DPS');
    // ...but WITHIN that role, cold Pharah (5 credited, 10 days stale)
    // jumps ahead of fresher, less-progressed Tracer (0 credited).
    assert.equal(r.body.orderedHeroes[0].hero, 'Pharah');
    assert.equal(r.body.orderedHeroes[0].cold, true);
    assert.equal(r.body.orderedHeroes[0].credited, 5);
    assert.equal(r.body.orderedHeroes[1].hero, 'Tracer');
    assert.equal(r.body.orderedHeroes[1].cold, false);
  });
});

describe('GET /api/blind/next — chunked (ABBA) vs unchunked sets', () => {
  // Both tests play exactly 5 games (60 minutes) so the call lands right on
  // a block boundary and the card actually recomputes its ordered list
  // (mid-block, orderedHeroes is deliberately empty — see the block suite).
  test('an unchunked (legacy) set reports progress in games, not blocks', async () => {
    await makeSet({ hero: 'Tracer', batch_size: 10, phase: 'phaseA' }); // no chunk_size
    await playGames('Tracer', 5);
    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.equal(r.body.block, null);
    assert.equal(r.body.orderedHeroes[0].credited, 5); // still a plain game count
    assert.equal(r.body.orderedHeroes[0].target, 20); // batch_size(10) x n_stages(2)
  });

  test('a chunked (ABBA) set reports progress in closed blocks, not games', async () => {
    await makeSet({ hero: 'Tracer', batch_size: 10, chunk_size: 2, phase: 'phaseA' });
    await playGames('Tracer', 5); // exactly 60 min -> exactly 1 closed block
    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.equal(r.body.block, null);
    assert.equal(r.body.orderedHeroes[0].credited, 1); // 1 closed block, not 5 games
    assert.equal(r.body.orderedHeroes[0].target, 16); // STAGE_BLOCKS(8) x n_stages(2) — batch_size is no longer the target for a chunked set
  });
});
