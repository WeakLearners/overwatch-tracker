// Tile picks: precedence (map > pick > derived > empty), the menu rules, the fixed-once-saved rule,
// and the label travelling through the API.
process.env.TZ = 'America/New_York';
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSlots, slotValues, pickableTiles, pickFormLabel, type Tile } from './heroTileLabels';
import { processFile, type ParsedScoreboard } from './scoreboard';
import { insertMatch, insertAimStatsHero } from '../db/fixtures';

const tiles = (o: Record<string, string>): Tile[] => Object.entries(o).map(([label, value]) => ({ label, value }));
const NEW = tiles({ 'PERCENT PLAYED': '100%', 'PLAY TIME': '05:00', 'WEAPON ACCURACY': '41%', 'CRITICAL HIT ACCURACY': '7%', 'AIRTIME PERCENTAGE': '54%', 'MYSTERY ABILITY ACCURACY': '60%', 'FINAL BLOWS': '4' });

describe('precedence: hand map > saved pick > derived > empty', () => {
  test('the hand map beats a pick', () => {
    const r = resolveSlots('Pharah', tiles({ 'WEAPON ACCURACY': '50%', 'DIRECT HIT ACCURACY': '21%', 'AIRTIME PERCENTAGE': '54%' }), { crit: 'airtime percentage' });
    assert.deepEqual([r.crit.tile, r.crit.source], ['direct hit accuracy', 'map']);
  });
  test('a pick beats the derived label', () => {
    const r = resolveSlots('Newhero', NEW, { crit: 'mystery ability accuracy' });
    assert.deepEqual([r.crit.tile, r.crit.source, r.overall.source], ['mystery ability accuracy', 'pick', 'derived']);
    assert.equal(slotValues('Newhero', NEW, { crit: 'mystery ability accuracy' })!.crit_acc, 60);
  });
  test('no pick: derived, then empty; extra is never derived', () => {
    const r = resolveSlots('Newhero', NEW);
    assert.deepEqual([r.overall.source, r.crit.source, r.extra.source], ['derived', 'derived', null]);
  });
  test('a pick fills a hero whose page has no overall tile (new hero, extra only)', () => {
    const t = tiles({ 'AIRTIME PERCENTAGE': '54%', 'FINAL BLOWS': '2' });
    assert.equal(slotValues('Newhero', t), null);
    assert.equal(slotValues('Newhero', t, { extra: 'airtime percentage' })!.extra_acc, 54);
  });
  test('Zenyatta crit stays empty without a pick, and takes a pick', () => {
    assert.equal(slotValues('Zenyatta', NEW)!.crit_acc, null);
    assert.equal(slotValues('Zenyatta', NEW, { crit: 'mystery ability accuracy' })!.crit_acc, 60);
  });
});

describe('menu rules', () => {
  test('percent tiles only, no PERCENT PLAYED, no tile another slot uses', () => {
    const p = pickableTiles('Newhero', NEW);
    assert.deepEqual(p.extra!.map(o => o.label), ['AIRTIME PERCENTAGE', 'MYSTERY ABILITY ACCURACY']);
    assert.deepEqual(p.extra!.map(o => o.value), ['54%', '60%']);
    assert.equal(p.overall, undefined); assert.equal(p.crit, undefined);
  });
  test('None pick suppresses the menu for that slot only', () => {
    const p = pickableTiles('Newhero', NEW, { extra: null });
    assert.equal(p.extra, undefined);
    assert.deepEqual(resolveSlots('Newhero', NEW, { extra: null }).extra, { tile: null, source: null });
  });
  test('a pick removes its tile from the other slots menus', () => {
    const p = pickableTiles('Newhero', tiles({ 'WEAPON ACCURACY': '41%', 'AIRTIME PERCENTAGE': '54%', 'MYSTERY ABILITY ACCURACY': '60%' }), { extra: 'mystery ability accuracy' });
    assert.equal(p.extra, undefined);
    assert.deepEqual(p.crit!.map(o => o.label), ['AIRTIME PERCENTAGE']);
  });
  test('never for a slot the client already names: Zenyatta crit, Baptiste crit and extra', () => {
    assert.equal(pickableTiles('Zenyatta', NEW).crit, undefined);
    assert.equal(pickableTiles('Baptiste', NEW).crit, undefined);
    assert.equal(pickableTiles('Baptiste', NEW).extra, undefined);
    assert.ok(pickableTiles('Baptiste', NEW).overall === undefined); // overall is derived
  });
  test('never for a hand-map hero, never crit for a no-crit hero', () => {
    assert.deepEqual(pickableTiles('Cassidy', NEW), {});
    assert.equal(pickableTiles('Juno', NEW).crit, undefined);
  });
  test('form label is the title-cased tile label plus a unit', () => assert.equal(pickFormLabel('helix rocket accuracy'), 'Helix Rocket Accuracy %'));
});

const EMPTY_SUMMARY = { map: '', result: '', score_us: 0, score_them: 0, game_mode: '', date_text: '', game_length: '', heroes: [], elims: 0, assists: 0, deaths: 0 };
const SUMMARY: ParsedScoreboard = { is_scoreboard: false, page_type: 'summary', rows: [], personal: { hero: '', tiles: [] },
  summary: { map: 'NEPAL', result: 'defeat', score_us: 0, score_them: 2, game_mode: 'CONTROL', date_text: '10/09/26 - 12:31', game_length: '8:47',
    heroes: [{ hero: 'REAPER', percent: 100, play_time: '05:00' }], elims: 11, assists: 0, deaths: 5 } };
const REAPER: ParsedScoreboard = { is_scoreboard: false, page_type: 'personal', rows: [], summary: EMPTY_SUMMARY,
  personal: { hero: 'REAPER', tiles: NEW.map(t => ({ label: t.label, value: t.value })) } };

describe('HTTP: pick, fill, label, fixed, reset', () => {
  test('POST saves and returns the filled payload; GET carries the label; a second POST is 409; reset refuses while rows exist', async () => {
    const { startHarness } = await import('../test/httpHarness');
    const h = await startHarness();
    try {
      const nowMs = Date.now();
      await processFile(h.db, '/x/p1.png', nowMs - 120_000, async () => SUMMARY);
      await processFile(h.db, '/x/p2.png', nowMs - 115_000, async () => REAPER);
      const live = (await h.get('/api/scoreboards/live')).body;
      const hero = live.fill.heroes[0];
      assert.equal(hero.hero, 'Reaper');
      assert.deepEqual(hero.slot_source, { overall: 'derived', crit: 'derived', extra: null });
      assert.deepEqual(hero.pickable.extra.map((o: any) => o.label), ['AIRTIME PERCENTAGE', 'MYSTERY ABILITY ACCURACY']);
      assert.equal(hero.extra_acc, null);

      const bad = await h.post('/api/scoreboards/tile-picks', { group_id: live.group_id, hero: 'Reaper', slot: 'extra', tile_label: 'NOT ON THE PAGE' });
      assert.equal(bad.status, 400);
      assert.equal((await h.post('/api/scoreboards/tile-picks', { group_id: live.group_id, hero: 'Reaper', slot: 'crit', tile_label: 'AIRTIME PERCENTAGE' })).status, 409, 'crit is derived, no menu');

      for (const [hr, sl] of [['Zenyatta', 'crit'], ['Baptiste', 'crit'], ['Baptiste', 'extra']]) {
        assert.equal((await h.post('/api/scoreboards/tile-picks', { group_id: live.group_id, hero: hr, slot: sl, tile_label: 'AIRTIME PERCENTAGE' })).status, 409, `${hr} ${sl}`);
      }
      assert.equal((h.db.prepare(`SELECT COUNT(*) n FROM hero_tile_picks`).get() as { n: number }).n, 0);
      const ok = await h.post('/api/scoreboards/tile-picks', { group_id: live.group_id, hero: 'Reaper', slot: 'extra', tile_label: 'MYSTERY ABILITY ACCURACY' });
      assert.equal(ok.status, 200);
      assert.equal(ok.body.fill.heroes[0].extra_acc, 60);
      assert.equal(ok.body.fill.heroes[0].slot_source.extra, 'pick');
      assert.deepEqual(ok.body.fill.heroes[0].pickable, {});

      const picks = (await h.get('/api/scoreboards/tile-picks')).body.picks;
      assert.deepEqual(picks, [{ hero: 'Reaper', slot: 'extra', tile_label: 'mystery ability accuracy', label: 'Mystery Ability Accuracy %' }]);

      assert.equal((await h.post('/api/scoreboards/tile-picks', { group_id: live.group_id, hero: 'Reaper', slot: 'extra', tile_label: 'AIRTIME PERCENTAGE' })).status, 409, 'fixed once saved');

      // reset: allowed while no logged row holds a value in the slot, refused after
      const mid = insertMatch(h.db, { date: '2026-10-09', hero: 'Reaper', role: 'DPS', map: 'Nepal', game_type: 'Control', win: 0 } as any);
      insertAimStatsHero(h.db, { match_id: mid, hero: 'Reaper', overall_acc: 41, extra_acc: 60 });
      const refused = await h.post('/api/scoreboards/tile-picks/reset', { hero: 'Reaper', slot: 'extra' });
      assert.equal(refused.status, 409);
      assert.equal((await h.get('/api/scoreboards/tile-picks')).body.picks.length, 1);
      h.db.prepare(`UPDATE aim_stats_heroes SET extra_acc = NULL`).run();
      assert.equal((await h.post('/api/scoreboards/tile-picks/reset', { hero: 'Reaper', slot: 'extra' })).status, 200);
      assert.equal((await h.get('/api/scoreboards/tile-picks')).body.picks.length, 0);

      // None is saved too and the menu does not come back
      const none = await h.post('/api/scoreboards/tile-picks', { group_id: live.group_id, hero: 'Reaper', slot: 'extra', tile_label: null });
      assert.equal(none.status, 200);
      assert.equal(none.body.fill.heroes[0].pickable.extra, undefined);
      assert.equal((await h.get('/api/scoreboards/tile-picks')).body.picks[0].label, null);
    } finally { await h.close(); }
  });
});
