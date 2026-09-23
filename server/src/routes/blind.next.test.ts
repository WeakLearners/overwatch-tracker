// DB-integration tests for GET /api/blind/next. lib/nextTest.test.ts already
// covers the pure ranking/stint/cold logic exhaustively with plain data —
// this suite exists only to prove the wiring: that real blind_stage_sets/
// blind_credits/matches rows get turned into the right inputs for that
// function. See blind.routes.test.ts for the harness/makeSet conventions.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { startHarness, type Harness } from '../test/httpHarness';

let h: Harness;

beforeEach(async () => { h = await startHarness(); });
afterEach(async () => { await h.close(); });

async function playGames(hero: string, n: number, opts: { win?: boolean; queue_mode?: string } = {}) {
  for (let i = 0; i < n; i++) {
    const r = await h.post('/api/matches', {
      date: '2026-09-23', time: '12:00', hour: 12, hero, role: 'DPS',
      map: 'Ilios', game_type: 'comp', win: opts.win ?? (i % 2 === 0),
      queue_mode: opts.queue_mode ?? 'comp_role',
    });
    assert.equal(r.status, 200, `match failed: ${JSON.stringify(r.body)}`);
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
    // A full 5-game stint on Ana: reaches the boundary (position === 5), so
    // the card recomputes instead of staying locked on Ana.
    await playGames('Ana', 5);

    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.equal(r.body.isQuickplay, false);
    assert.equal(r.body.stint, null, 'landed exactly on a stint boundary');
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
  // chunk_size 1 makes every single game alternate stages (ABBA over
  // 1-game blocks), so batch_size 2 completes in exactly 4 games without
  // needing a manual /advance call — see lib/blind.ts's abbaStageFor.
  test('a hero that finished its batch on every stage shows as finished, not in the pick', async () => {
    await makeSet({ hero: 'Tracer', batch_size: 2, chunk_size: 1, phase: 'phaseA' });
    await makeSet({ hero: 'Ana', batch_size: 2, chunk_size: 1, phase: 'phaseA' });
    await playGames('Tracer', 4);

    // Tracer's own stint just hit its (short, 4-game) test target, but the
    // mid-stint lock only applies to a hero still pending — Tracer already
    // completed, so the card falls through to a full recompute rather than
    // staying locked on a finished hero.
    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.deepEqual(r.body.finishedHeroes, ['Tracer']);
    assert.equal(r.body.recommendedRole, 'Support');
  });

  test('every hero finished reports allFinished', async () => {
    await makeSet({ hero: 'Tracer', batch_size: 2, chunk_size: 1, phase: 'phaseA' });
    await playGames('Tracer', 4);
    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.equal(r.body.allFinished, true);
    assert.equal(r.body.recommendedRole, null);
  });
});

describe('GET /api/blind/next — stint (real match log)', () => {
  test('two comp matches in a row mid-stint locks the same hero', async () => {
    await makeSet({ hero: 'Tracer', batch_size: 40, phase: 'phaseA' });
    await makeSet({ hero: 'Ana', batch_size: 40, phase: 'phaseA' });
    await playGames('Tracer', 2);

    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.deepEqual(r.body.stint, { hero: 'Tracer', role: 'DPS', position: 2, length: 5 });
    assert.equal(r.body.recommendedRole, 'DPS');
    assert.deepEqual(r.body.orderedHeroes, []);
  });

  test('a Quickplay match in between does not break or advance the stint', async () => {
    await makeSet({ hero: 'Tracer', batch_size: 40, phase: 'phaseA' });
    await playGames('Tracer', 2);
    await playGames('Tracer', 1, { queue_mode: 'qp_role' }); // uncredited, must be invisible
    await playGames('Tracer', 1); // 3rd credited game

    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.equal(r.body.stint.position, 3, 'the QP game did not count toward or reset the stint');
  });

  test('at the 5th consecutive credited game, the card recomputes instead of staying', async () => {
    await makeSet({ hero: 'Tracer', batch_size: 40, phase: 'phaseA' });
    await makeSet({ hero: 'Ana', batch_size: 40, phase: 'phaseA' });
    await playGames('Tracer', 5);

    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.equal(r.body.stint, null);
  });
});

describe('GET /api/blind/next — going cold', () => {
  test('a hero unplayed 7+ days jumps to the top of its role even though it is MORE progressed', async () => {
    const oldId = await makeSet({ hero: 'Pharah', batch_size: 40, phase: 'phaseA' });
    await makeSet({ hero: 'Tracer', batch_size: 40, phase: 'phaseA' });
    // A full 5-game stint on Pharah: reaches the boundary, so the very next
    // call is a full recompute rather than a "stay on Pharah" lock.
    await playGames('Pharah', 5);
    // Backdate all 5 of Pharah's credited matches 10 days so it reads as
    // cold, while Tracer (never played) is not.
    h.db.prepare(`
      UPDATE matches SET created_at = datetime('now', '-10 days')
      WHERE id IN (SELECT match_id FROM blind_credits WHERE blind_set_id = ?)
    `).run(oldId);

    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.equal(r.body.stint, null, 'landed exactly on a stint boundary');
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
  // Both tests play exactly STINT_LENGTH (5) games so the call lands right
  // on a stint boundary and the card actually recomputes its ordered list
  // (mid-stint, orderedHeroes is deliberately empty — see the stint suite).
  test('an unchunked (legacy) set totals credits across both stages the same as a chunked one', async () => {
    await makeSet({ hero: 'Tracer', batch_size: 10, phase: 'phaseA' }); // no chunk_size
    await playGames('Tracer', 5);
    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.equal(r.body.stint, null);
    assert.equal(r.body.orderedHeroes[0].credited, 5);
    assert.equal(r.body.orderedHeroes[0].target, 20); // batch_size(10) x n_stages(2)
  });

  test('a chunked (ABBA) set totals credits the same way regardless of alternation', async () => {
    await makeSet({ hero: 'Tracer', batch_size: 10, chunk_size: 2, phase: 'phaseA' });
    await playGames('Tracer', 5);
    const r = await h.get('/api/blind/next?queue_mode=comp_role');
    assert.equal(r.body.stint, null);
    assert.equal(r.body.orderedHeroes[0].credited, 5);
    assert.equal(r.body.orderedHeroes[0].target, 20);
  });
});
