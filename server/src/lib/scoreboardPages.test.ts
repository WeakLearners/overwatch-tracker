// Three page types, groups, recovery, the tile map and the empty-only fill
// (Addendum 2, 2026-10-09). The vision readings below are the real Haiku output for
// Screenshots 49 (Summary), 51 (Tracer) and 52 (Pharah) of match 3842, 53-60 for the
// other mapped heroes. Dates are local time, so the zone is pinned.
process.env.TZ = 'America/New_York';
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { getDb, closeDb } from '../db/schema';
import { processFile, type ParsedScoreboard, type ParsedRow } from './scoreboard';
import { parseSummaryDate, rosterHero, rosterMap, normSummary, buildFill, fillEmptyAim, finalizeGroups, findOpenGroup, linkGroup, PAGE_GAP_MS } from './scoreboardPages';
import { HERO_TILE_MAP, slotValues, finalBlows, parseTileNumber } from './heroTileLabels';
import { syncMatchHeroStats, tilesToRows, normStat, statUnit } from './matchHeroStats';
import { organizeBoard, pageSuffix } from './scoreboardOrganize';

const T0 = Date.parse('2026-10-09T17:18:48.387Z'); // Screenshot (49) mtime
const E: Pick<ParsedScoreboard, 'rows'> = { rows: [] };
const emptySummary = { map: '', result: '', score_us: 0, score_them: 0, game_mode: '', date_text: '', game_length: '', heroes: [], elims: 0, assists: 0, deaths: 0 };
const SUMMARY_49: ParsedScoreboard = { is_scoreboard: false, page_type: 'summary', ...E, personal: { hero: '', tiles: [] },
  summary: { map: 'NEPAL', result: 'defeat', score_us: 0, score_them: 2, game_mode: 'CONTROL', date_text: '10/09/26 - 12:31', game_length: '8:47',
    heroes: [{ hero: 'TRACER', percent: 68, play_time: '05:28' }, { hero: 'PHARAH', percent: 32, play_time: '02:36' }], elims: 11, assists: 0, deaths: 5 } };
const personal = (hero: string, tiles: [string, string][]): ParsedScoreboard =>
  ({ is_scoreboard: false, page_type: 'personal', ...E, summary: emptySummary, personal: { hero, tiles: tiles.map(([label, value]) => ({ label, value })) } });
const TRACER_51 = personal('TRACER', [['PERCENT PLAYED', '68%'], ['PLAY TIME', '05:28'], ['WEAPON ACCURACY', '33%'], ['PULSE BOMB KILL', '1'], ['FINAL BLOWS', '5'], ['CRITICAL HIT ACCURACY', '10%'], ['PULSE BOMB ATTACH RATE', '0%'], ['SOLO KILLS', '2'], ['LOW HEALTH RECALLS', '0']]);
const PHARAH_52 = personal('PHARAH', [['PERCENT PLAYED', '32%'], ['PLAY TIME', '02:36'], ['WEAPON ACCURACY', '50%'], ['AIRTIME PERCENTAGE', '54%'], ['FINAL BLOW', '1'], ['DIRECT HIT ACCURACY', '21%'], ['KNOCKBACK KILLS', '0'], ['SOLO KILLS', '0'], ['LONG RANGE FINAL BLOWS', '0'], ['BARRAGE KILL', '1']]);

describe('page parsing helpers', () => {
  test('DATE is MM/DD/YY, 12-hour, nearest reading to the mtime wins', () => {
    const ms = parseSummaryDate('10/09/26 - 12:31', T0)!;
    assert.equal(new Date(ms).toISOString(), '2026-10-09T16:31:00.000Z'); // 12:31 local noon-ish, not 00:31
    assert.equal(new Date(parseSummaryDate('10/09/26 - 12:31', Date.parse('2026-10-09T05:00:00Z'))!).getHours(), 0); // mtime 01:00 local -> 00:31
    assert.equal(parseSummaryDate('10/09/26 - 12:31', T0), parseSummaryDate('10/09/2026 - 12:31', T0));
  });
  test('a day-first reading is never taken (10/09 is October 9, 09/10 would be September 10)', () => {
    assert.equal(new Date(parseSummaryDate('09/10/26 - 3:05', T0)!).getMonth(), 8);
  });
  test('unreadable DATE -> null', () => { assert.equal(parseSummaryDate('garbage', T0), null); assert.equal(parseSummaryDate('13/40/26 - 12:31', T0), null); });
  test('roster names match exactly after case, accent and quote folding; unknown -> null', () => {
    assert.equal(rosterHero('SOLDIER: 76'), 'Soldier: 76'); assert.equal(rosterHero('TRACER'), 'Tracer');
    assert.equal(rosterHero('ALL HEROES'), null); assert.equal(rosterHero('Trace'), null);
    assert.equal(rosterMap('NEPAL'), 'Nepal'); assert.equal(rosterMap('KING’S ROW'), "King's Row"); assert.equal(rosterMap('Nepa'), null);
  });
  test('Summary reading normalises (hero order by percent, seconds, result)', () => {
    const n = normSummary(SUMMARY_49.summary!, T0);
    assert.deepEqual([n.map, n.result, n.scoreUs, n.scoreThem, n.lengthSec, n.elims, n.deaths], ['Nepal', 'defeat', 0, 2, 527, 11, 5]);
    assert.deepEqual(n.heroes.map(h => [h.hero, h.seconds]), [['Tracer', 328], ['Pharah', 156]]);
  });
});

describe('tilesToRows', () => {
  test('normalises labels, parses values, skips unreadable ones', () => {
    assert.equal(normStat('Charged Shot Critical Accuracy', 'pct'), 'charged_shot_critical_accuracy');
    const r = tilesToRows([{ label: 'WEAPON ACCURACY', value: '33%' }, { label: 'JUNK', value: 'n/a' }, { label: 'AIRTIME', value: '54%', per10: '' }]);
    assert.deepEqual(r.map(x => [x.stat, x.value, x.unit, x.per10, x.career_best]), [['weapon_accuracy', 33, 'pct', null, 0], ['airtime', 54, 'pct', null, 0]]);
    assert.deepEqual(tilesToRows(undefined), []);
  });
  test('singular and plural labels give one key (the game singularises at 1)', () => {
    const pairs: [string, string][] = [['FINAL BLOW', 'final_blows'], ['FINAL BLOWS', 'final_blows'], ['SOLO KILL', 'solo_kills'], ['SOLO KILLS', 'solo_kills'],
      ['PULSE BOMB KILL', 'pulse_bomb_kills'], ['PULSE BOMB KILLS', 'pulse_bomb_kills'], ['BARRAGE KILL', 'barrage_kills'], ['CHARGED SHOT KILL', 'charged_shot_kills'], ['CHARGED SHOT KILLS', 'charged_shot_kills'],
      ['KNOCKBACK KILL', 'knockback_kills'], ['LOW HEALTH RECALL', 'low_health_recalls'], ['LOW HEALTH RECALLS', 'low_health_recalls']];
    for (const [label, key] of pairs) assert.equal(normStat(label, 'count'), key, label);
    // Not count nouns: left as they are.
    for (const [label, key] of [['ENEMY HINDERED', 'enemy_hindered'], ['ENEMY SLEPT', 'enemy_slept'], ['PLAYERS SAVED', 'players_saved'], ['WEAPON ACCURACY', 'weapon_accuracy'],
      ['PULSE BOMB ATTACH RATE', 'pulse_bomb_attach_rate'], ['PLAY TIME', 'play_time'], ['PERCENT PLAYED', 'percent_played'], ['AIRTIME PERCENTAGE', 'airtime_percentage'], ['AIRTIME', 'airtime']])
      assert.equal(normStat(label, statUnit(label, label === 'PLAY TIME' ? '05:28' : /ACCURACY|RATE|PERCENT|AIRTIME/.test(label) ? '5%' : '1')), key, label);
    assert.equal(normStat('AVERAGE AURA', 'pct'), 'average_aura');
    assert.equal(normStat('JOYRIDE DAMAGE DONE', 'amount'), 'joyride_damage_done');
    assert.deepEqual(tilesToRows([{ label: 'AVERAGE AURA', value: '36%' }, { label: 'JOYRIDE DAMAGE DONE', value: '1,519' }]).map(r => r.stat), ['average_aura', 'joyride_damage_done']);
  });
});

describe('tile map (confirmed heroes only)', () => {
  test('exactly the ten confirmed heroes', () => {
    assert.deepEqual(Object.keys(HERO_TILE_MAP).sort(), ['Ana', 'Ashe', 'Doctrine', 'Juno', 'Mizuki', 'Shion', 'Sojourn', 'Sombra', 'Tracer', 'Pharah'].sort());
    assert.equal(HERO_TILE_MAP.Baptiste, undefined);
  });
  const tiles = (o: Record<string, string>) => Object.entries(o).map(([label, value]) => ({ label, value }));
  test('Tracer and Pharah from the real pages', () => {
    assert.deepEqual(slotValues('Tracer', TRACER_51.personal!.tiles), { overall_acc: 33, crit_acc: 10, extra_acc: 0, torpedo_damage: null, torpedo_healing: null });
    assert.deepEqual(slotValues('Pharah', PHARAH_52.personal!.tiles), { overall_acc: 50, crit_acc: 21, extra_acc: null, torpedo_damage: null, torpedo_healing: null });
  });
  test('Ashe overall comes from SCOPED ACCURACY, Juno gets torpedoes and no crit, Sojourn extra', () => {
    assert.deepEqual(slotValues('Ashe', tiles({ 'SCOPED ACCURACY': '38%', 'SCOPED CRITICAL HIT ACCURACY': '8%' })), { overall_acc: 38, crit_acc: 8, extra_acc: null, torpedo_damage: null, torpedo_healing: null });
    assert.deepEqual(slotValues('Juno', tiles({ 'WEAPON ACCURACY': '35%', 'PULSAR TORPEDOES DAMAGE': '585', 'PULSAR TORPEDOES HEALING': '711' })), { overall_acc: 35, crit_acc: null, extra_acc: null, torpedo_damage: 585, torpedo_healing: 711 });
    assert.equal(slotValues('Sojourn', tiles({ 'WEAPON ACCURACY': '29%', 'CHARGED SHOT ACCURACY': '60%', 'CHARGED SHOT CRITICAL ACCURACY': '20%' }))!.extra_acc, 20);
    assert.equal(slotValues('Ana', tiles({ 'SCOPED ACCURACY': '53%', 'SLEEP DART ACCURACY': '9%' }))!.crit_acc, 9);
  });
  test('an unconfirmed hero gets no slots, never a guess; Ana with only a weapon tile reads null', () => {
    assert.equal(slotValues('Reaper', tiles({ 'WEAPON ACCURACY': '40%' })), null);
    assert.equal(slotValues('Ana', tiles({ 'WEAPON ACCURACY': '40%' }))!.overall_acc, null);
  });
  test('FINAL BLOW and FINAL BLOWS count, LONG RANGE FINAL BLOWS does not', () => {
    assert.equal(finalBlows(TRACER_51.personal!.tiles), 5); assert.equal(finalBlows(PHARAH_52.personal!.tiles), 1);
    assert.equal(finalBlows(tiles({ 'LONG RANGE FINAL BLOWS': '3' })), null);
    assert.equal(parseTileNumber('1,519'), 1519); assert.equal(parseTileNumber('x'), null);
  });
});

describe('groups on a temp DB (match 3842 is a recovery)', () => {
  let db: ReturnType<typeof getDb>; let tmp: string;
  beforeEach(() => { tmp = path.join(os.tmpdir(), `sbp-test-${process.pid}-${Date.now()}.db`); db = getDb(tmp); });
  afterEach(() => { closeDb(); for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f); });
  const addMatch = (createdAt: string, map = 'Nepal', hero = 'Tracer', role = 'DPS') => Number(db.prepare(
    `INSERT INTO matches (date, hero, role, map, game_type, win, account, created_at) VALUES ('2026-10-09', ?, ?, ?, 'Control', 0, 'Linx', ?)`).run(hero, role, map, createdAt).lastInsertRowid);
  const addAim = (id: number) => {
    db.prepare(`INSERT INTO match_heroes (match_id, slot, hero, role) VALUES (?, 1, 'Tracer', 'DPS'), (?, 2, 'Pharah', 'DPS')`).run(id, id);
    db.prepare(`INSERT INTO aim_stats (match_id, elims, deaths, damage, duration_min) VALUES (?, 11, 5, 6347, 8.0667)`).run(id);
    db.prepare(`INSERT INTO aim_stats_heroes (match_id, hero, overall_acc, crit_acc, extra_acc, duration_min) VALUES (?, 'Tracer', 33, 10, 0, 5.4667), (?, 'Pharah', 50, 21, NULL, 2.6)`).run(id, id);
  };
  const feed = async (reading: ParsedScoreboard, file: string, offsetS: number, replaceId?: number) =>
    processFile(db, `/x/${file}.png`, T0 + offsetS * 1000, async () => reading, replaceId);
  const pages = () => db.prepare(`SELECT id, page_type, page_hero, status, match_id, group_id FROM match_scoreboards ORDER BY id`).all() as any[];

  test('Summary + Personal pages for an already logged match: recovery group, final_blows 6, typed values stay', async () => {
    const mid = addMatch('2026-10-09 16:35:14'); addAim(mid);
    assert.equal(await feed(SUMMARY_49, '49', 0), 'matched');
    assert.equal(await feed(TRACER_51, '51', 5), 'matched');
    assert.equal(await feed(PHARAH_52, '52', 6), 'matched');
    const g = db.prepare(`SELECT * FROM scoreboard_groups`).get() as any;
    assert.deepEqual([g.state, g.match_id], ['recovery', mid]);
    assert.deepEqual(pages().map(p => [p.page_type, p.status, p.match_id, p.group_id]), [['summary', 'matched', mid, g.id], ['personal', 'matched', mid, g.id], ['personal', 'matched', mid, g.id]]);
    assert.equal(finalizeGroups(db, T0 + 10_000), 0, 'a group still receiving pages is not filled yet');
    assert.equal(finalizeGroups(db, T0 + 6000 + PAGE_GAP_MS), 1);
    const aim = db.prepare(`SELECT elims, deaths, damage, final_blows, duration_min, assists, healing FROM aim_stats WHERE match_id = ?`).get(mid) as any;
    assert.deepEqual({ ...aim }, { elims: 11, deaths: 5, damage: 6347, final_blows: 6, duration_min: 8.0667, assists: null, healing: null });
    const heroes = db.prepare(`SELECT hero, overall_acc, crit_acc, extra_acc FROM aim_stats_heroes WHERE match_id = ? ORDER BY hero`).all(mid);
    assert.deepEqual(heroes.map(h => ({ ...h })), [{ hero: 'Pharah', overall_acc: 50, crit_acc: 21, extra_acc: null }, { hero: 'Tracer', overall_acc: 33, crit_acc: 10, extra_acc: 0 }]);
    assert.equal(finalizeGroups(db, T0 + 999_999), 0, 'filled once');
  });
  test('match_hero_stats: one row per Personal tile, per10 and career_best kept, nothing stored for a missing tile', async () => {
    const mid = addMatch('2026-10-09 16:35:14'); addAim(mid);
    await feed(SUMMARY_49, '49', 0);
    await feed(TRACER_51, '51', 5);
    const withBadge = personal('PHARAH', [['WEAPON ACCURACY', '50%'], ['DAMAGE DEALT', '7,772'], ['FINAL BLOW', '1']]);
    withBadge.personal!.tiles[1] = { label: 'DAMAGE DEALT', value: '7,772', per10: '9,100', career_best: true };
    await feed(withBadge, '52', 6);
    const rows = db.prepare(`SELECT hero, stat, label, value, unit, per10, career_best, scoreboard_id FROM match_hero_stats WHERE match_id = ? ORDER BY hero, rowid`).all(mid) as any[];
    assert.equal(rows.filter(r => r.hero === 'Tracer').length, 9, 'all 9 Tracer tiles');
    assert.deepEqual(rows.filter(r => r.hero === 'Tracer' && ['pulse_bomb_attach_rate', 'play_time', 'final_blows'].includes(r.stat)).map(r => [r.stat, r.value, r.unit]),
      [['play_time', 328, 'amount'], ['final_blows', 5, 'count'], ['pulse_bomb_attach_rate', 0, 'pct']]);
    const dmg = rows.find(r => r.hero === 'Pharah' && r.stat === 'damage_dealt');
    assert.deepEqual([dmg.value, dmg.unit, dmg.per10, dmg.career_best], [7772, 'amount', 9100, 1]);
    assert.equal(rows.find(r => r.hero === 'Tracer' && r.stat === 'weapon_accuracy').per10, null, 'per10 not shown is NULL, not 0');
    assert.equal(rows.find(r => r.hero === 'Pharah' && r.stat === 'solo_kills'), undefined, 'a tile not on the page has no row');
    // Idempotent re-sync, and the accuracy slots are untouched.
    assert.equal(syncMatchHeroStats(db, mid), 12);
    assert.equal((db.prepare(`SELECT COUNT(*) c FROM match_hero_stats`).get() as any).c, 12);
  });

  test('recovery never overwrites: a typed final_blows stays, a typed 0 extra_acc stays', async () => {
    const mid = addMatch('2026-10-09 16:35:14'); addAim(mid);
    db.prepare(`UPDATE aim_stats SET final_blows = 9 WHERE match_id = ?`).run(mid);
    await feed(SUMMARY_49, '49', 0); await feed(TRACER_51, '51', 5); await feed(PHARAH_52, '52', 6);
    finalizeGroups(db, T0 + 200_000);
    assert.equal((db.prepare(`SELECT final_blows FROM aim_stats WHERE match_id = ?`).get(mid) as any).final_blows, 9);
  });
  test('recovery inserts nothing: a match with no aim_stats row gets none, and no hero row appears', async () => {
    const mid = addMatch('2026-10-09 16:35:14');
    await feed(SUMMARY_49, '49', 0); await feed(TRACER_51, '51', 5); await feed(PHARAH_52, '52', 6);
    finalizeGroups(db, T0 + 200_000);
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM aim_stats`).get() as any).n, 0);
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM aim_stats_heroes`).get() as any).n, 0);
  });
  test('a Summary whose map differs from the logged match is not a recovery', async () => {
    addMatch('2026-10-09 16:35:14', 'Numbani');
    await feed(SUMMARY_49, '49', 0);
    assert.equal((db.prepare(`SELECT state FROM scoreboard_groups`).get() as any).state, 'live');
  });
  test('2 logged matches fit the DATE -> ambiguous, never lights, never links', async () => {
    addMatch('2026-10-09 16:33:00'); addMatch('2026-10-09 16:36:00');
    assert.equal(await feed(SUMMARY_49, '49', 0), 'unmatched');
    assert.equal((db.prepare(`SELECT state FROM scoreboard_groups`).get() as any).state, 'ambiguous');
  });
  test('no logged match: live group; fill payload carries the tile map; final_blows needs a Personal page for every hero', async () => {
    assert.equal(await feed(SUMMARY_49, '49', 0), 'unmatched');
    await feed(TRACER_51, '51', 5);
    const gid = (db.prepare(`SELECT id FROM scoreboard_groups`).get() as any).id;
    let f = buildFill(db, gid)!;
    assert.equal(f.final_blows, null); assert.deepEqual(f.pages.personal, ['Tracer']);
    await feed(PHARAH_52, '52', 6);
    f = buildFill(db, gid)!;
    assert.deepEqual([f.map, f.win, f.score_us, f.score_them, f.elims, f.assists, f.deaths, f.final_blows], ['Nepal', 0, 0, 2, 11, 0, 5, 6]);
    assert.deepEqual(f.heroes.map(h => [h.hero, h.duration, h.overall_acc, h.crit_acc, h.extra_acc]), [['Tracer', '5:28', 33, 10, 0], ['Pharah', '2:36', 50, 21, null]]);
    assert.equal(f.duration_min, (328 + 156) / 60, 'sum of hero play times, not the 8:47 game length');
  });
  test('submit link: group becomes linked, pages move to the new match, only final_blows is filled', async () => {
    await feed(SUMMARY_49, '49', 0); await feed(TRACER_51, '51', 5); await feed(PHARAH_52, '52', 6);
    const g = (db.prepare(`SELECT id FROM scoreboard_groups`).get() as any).id;
    const mid = addMatch('2026-10-09 16:40:00'); addAim(mid);
    db.prepare(`UPDATE aim_stats SET elims = NULL WHERE match_id = ?`).run(mid);
    linkGroup(db, g, mid, 'linked', 'linked at submit');
    assert.ok(pages().every(p => p.status === 'matched' && p.match_id === mid));
    finalizeGroups(db, T0 + 200_000);
    const aim = db.prepare(`SELECT elims, final_blows FROM aim_stats WHERE match_id = ?`).get(mid) as any;
    assert.deepEqual({ ...aim }, { elims: null, final_blows: 6 }, 'the form owns every other field');
  });
  test('Summary starts a new group; pages join only within the gap; a page with no Summary stays standalone', async () => {
    await feed(SUMMARY_49, '49', 0);
    assert.ok(findOpenGroup(db, T0 + 60_000));
    assert.equal(findOpenGroup(db, T0 + PAGE_GAP_MS + 1000), null);
    await feed(SUMMARY_49, '49b', 300);
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM scoreboard_groups`).get() as any).n, 2);
    await feed(TRACER_51, 'late', 900);
    const late = db.prepare(`SELECT status, group_id, reason FROM match_scoreboards WHERE file_path = '/x/late.png'`).get() as any;
    assert.equal(late.group_id, null); assert.match(late.reason, /no summary/);
  });
  test('a second Personal page for the same hero is kept but never counted', async () => {
    await feed(SUMMARY_49, '49', 0); await feed(TRACER_51, '51', 5); await feed(TRACER_51, '51b', 7);
    assert.equal((db.prepare(`SELECT COUNT(*) n FROM match_scoreboards WHERE status = 'dismissed'`).get() as any).n, 1);
  });
  test('ALL HEROES personal page joins the group but supplies no hero data', async () => {
    await feed(SUMMARY_49, '49', 0); await feed(personal('ALL HEROES', [['FINAL BLOWS', '99']]), 'all', 4);
    const gid = (db.prepare(`SELECT id FROM scoreboard_groups`).get() as any).id;
    assert.equal(buildFill(db, gid)!.final_blows, null);
  });
  test('Teams in a live group is not linked to a nearby match on another map (window rule guarded by the Summary map)', async () => {
    addMatch('2026-10-09 17:15:00', 'Numbani', 'Mizuki', 'Support');
    await feed(SUMMARY_49, '49', 0);
    const b: ParsedScoreboard = { is_scoreboard: true, page_type: 'teams', rows: [...Array(5)].map((_, i) => row('us', i, i === 4)).concat([...Array(5)].map((_, i) => row('them', i))) };
    assert.equal(await feed(b, 'teams', 3), 'unmatched');
    assert.equal((db.prepare(`SELECT state FROM scoreboard_groups`).get() as any).state, 'live');
  });
  test('Teams that is an exact copy of a matched board turns the group into a recovery of that match', async () => {
    const mid = addMatch('2026-10-09 16:35:14', 'Nepal', 'Tracer', 'DPS');
    const b: ParsedScoreboard = { is_scoreboard: true, rows: [...Array(5)].map((_, i) => row('us', i, i === 4)).concat([...Array(5)].map((_, i) => row('them', i))) };
    // an older board already linked to the match (a pre-page-type row, NULL page_type)
    assert.equal(await processFile(db, '/x/old.png', T0 - 3_600_000, async () => b), 'unmatched');
    db.prepare(`UPDATE match_scoreboards SET match_id = ?, status = 'matched' WHERE file_path = '/x/old.png'`).run(mid);
    // a Summary DATE too far from the log to recover on its own
    const far = { ...SUMMARY_49, summary: { ...SUMMARY_49.summary!, date_text: '10/09/26 - 1:50' } };
    await feed(far, '49', 0);
    assert.equal((db.prepare(`SELECT state FROM scoreboard_groups`).get() as any).state, 'live');
    assert.equal(await feed({ ...b, page_type: 'teams' }, 'teams', 3), 'dismissed');
    const g = db.prepare(`SELECT state, match_id FROM scoreboard_groups`).get() as any;
    assert.deepEqual([g.state, g.match_id], ['recovery', mid]);
  });
  test('backfill: replaceId updates the row in place and adopts earlier loose pages', async () => {
    const mid = addMatch('2026-10-09 16:35:14'); addAim(mid);
    // old world: all three stored as not_scoreboard, Teams copy dismissed in between
    const old = (name: string, off: number, status: string) => Number(db.prepare(`INSERT INTO match_scoreboards (file_path, file_mtime, status) VALUES (?, ?, ?)`).run(`/x/${name}.png`, new Date(T0 + off * 1000).toISOString(), status).lastInsertRowid);
    const a = old('49', 0, 'not_scoreboard'), t = old('50', 3, 'dismissed'), b = old('51', 5, 'not_scoreboard'), c = old('52', 6, 'not_scoreboard');
    await feed(SUMMARY_49, '49', 0, a); await feed(TRACER_51, '51', 5, b); await feed(PHARAH_52, '52', 6, c);
    const ids = pages().map(p => p.id);
    assert.deepEqual(ids, [a, t, b, c]);
    const g = (db.prepare(`SELECT id, state FROM scoreboard_groups`).get() as any);
    assert.equal(g.state, 'recovery');
    assert.deepEqual(pages().map(p => p.group_id), [g.id, g.id, g.id, g.id]);
    assert.equal(pages()[1].status, 'dismissed'); assert.equal(pages()[1].page_type, 'teams');
    finalizeGroups(db, T0 + 200_000);
    assert.equal((db.prepare(`SELECT final_blows FROM aim_stats WHERE match_id = ?`).get(mid) as any).final_blows, 6);
  });
});

function row(team: 'us' | 'them', i: number, isSelf = false): ParsedRow {
  return { team, role: 'dps', is_self: isSelf, player_name: isSelf ? 'LINX' : `P${team}${i}`, e: 1 + i, a: 2, d: 3, dmg: 4 + i, h: 5, mit: 6 };
}

describe('file names', () => {
  test('page suffix', () => {
    assert.equal(pageSuffix('summary', null), ' - summary'); assert.equal(pageSuffix('teams', null), ' - teams');
    assert.equal(pageSuffix('personal', 'Tracer'), ' - personal-Tracer'); assert.equal(pageSuffix(null, null), '');
  });
  test('a matched Summary page moves to YYYY-MM-DD/<id> <Map> <Hero> - summary.png and never overwrites', () => {
    const tmp = path.join(os.tmpdir(), `sbn-test-${process.pid}-${Date.now()}.db`); const db = getDb(tmp);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-org-'));
    try {
      const mid = Number(db.prepare(`INSERT INTO matches (date, hero, role, map, game_type, win, account) VALUES ('2026-10-09','Tracer','DPS','Nepal','Control',0,'Linx')`).run().lastInsertRowid);
      const mk = (n: string) => { const f = path.join(root, n); fs.writeFileSync(f, n); fs.utimesSync(f, new Date(T0 - 3_600_000), new Date(T0 - 3_600_000)); return f; };
      const ins = (f: string, type: string, hero: string | null) => Number(db.prepare(`INSERT INTO match_scoreboards (match_id, file_path, file_mtime, status, page_type, page_hero) VALUES (?, ?, ?, 'matched', ?, ?)`).run(mid, f, new Date(T0).toISOString(), type, hero).lastInsertRowid);
      const s1 = ins(mk('a.png'), 'summary', null), p1 = ins(mk('b.png'), 'personal', 'Pharah');
      fs.mkdirSync(path.join(root, '2026-10-09')); fs.writeFileSync(path.join(root, '2026-10-09', `${mid} Nepal Tracer - summary.png`), 'existing');
      organizeBoard(db, s1, root); organizeBoard(db, p1, root);
      assert.equal(fs.readFileSync(path.join(root, '2026-10-09', `${mid} Nepal Tracer - summary.png`), 'utf8'), 'existing');
      assert.ok(fs.existsSync(path.join(root, '2026-10-09', `${mid} Nepal Tracer - summary (2).png`)));
      assert.ok(fs.existsSync(path.join(root, '2026-10-09', `${mid} Nepal Tracer - personal-Pharah.png`)));
    } finally { closeDb(); fs.rmSync(root, { recursive: true }); for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) if (fs.existsSync(f)) fs.unlinkSync(f); }
  });
});

describe('HTTP: light and submit link', () => {
  test('GET /live is green for a fresh live group, POST /api/matches with scoreboard_group_id links it, light goes off', async () => {
    const { startHarness } = await import('../test/httpHarness');
    const h = await startHarness();
    try {
      const nowMs = Date.now();
      const feedNow = async (r: ParsedScoreboard, f: string, off: number) => processFile(h.db, `/x/${f}.png`, nowMs - 120_000 + off * 1000, async () => r);
      // The Summary DATE must be near now to avoid a recovery; match none are logged, so it is live regardless.
      await feedNow(SUMMARY_49, 'h49', 0); await feedNow(TRACER_51, 'h51', 5); await feedNow(PHARAH_52, 'h52', 6);
      const live = (await h.get('/api/scoreboards/live')).body;
      assert.equal(live.light, 'green'); assert.equal(live.fill.final_blows, 6); assert.equal(live.fill.map, 'Nepal');
      assert.equal((await h.get('/api/scoreboards/unmatched')).body.items.length, 0, 'live group pages stay out of the inbox');
      const res = await h.post('/api/matches', { date: '2026-10-09', hero: 'Tracer', role: 'DPS', map: 'Nepal', game_type: 'Control', win: false, scoreboard_group_id: live.group_id });
      assert.equal(res.status, 200);
      const rows = h.db.prepare(`SELECT status, match_id FROM match_scoreboards`).all() as any[];
      assert.ok(rows.every(r => r.status === 'matched' && r.match_id === res.body.id));
      assert.equal((await h.get('/api/scoreboards/live')).body.light, 'off');
      // a stale or unknown id never fails the log
      assert.equal((await h.post('/api/matches', { date: '2026-10-09', hero: 'Tracer', role: 'DPS', map: 'Nepal', game_type: 'Control', win: false, scoreboard_group_id: 9999 })).status, 200);
    } finally { await h.close(); }
  });
});
