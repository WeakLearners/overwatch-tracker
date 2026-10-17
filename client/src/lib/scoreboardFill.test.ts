import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fillPatch, fillSignature, rankPageSupplies, heroMismatch, type FormFill, type FormSnapshot } from './scoreboardFill';
import { emptyStats } from '../components/AimStatsFields';

const hero = (h: string, o: object = {}) => ({ hero: h, percent: 50, seconds: 100, duration: '1:40', overall_acc: null, crit_acc: null, extra_acc: null, torpedo_damage: null, torpedo_healing: null, mapped: false, ...o });
// Match 3842: Tracer 5:28, Pharah 2:36 (Summary + Personal pages).
const fill: FormFill = {
  group_id: 7, map: 'Nepal', win: 0, score_us: 0, score_them: 2,
  heroes: [hero('Tracer', { duration: '5:28', overall_acc: 33, crit_acc: 10, extra_acc: 0, mapped: true }), hero('Pharah', { duration: '2:36', overall_acc: 50, crit_acc: 21, mapped: true })],
  elims: 11, assists: 0, deaths: 5, damage: 6347, healing: 0,
  pages: { summary: true, teams: true, personal: ['Tracer', 'Pharah'] },
};
const blank = (o: Partial<FormSnapshot> = {}): FormSnapshot => ({ hero: '', switchHeroes: ['', ''], win: '', map: '', scoreUs: '', scoreThem: '', aimStats: emptyStats([]), ...o });

describe('fillPatch leaver side', () => {
  const sb = { ...fill, leaver_side: 'theirs' as const, short_board: true };
  test('a short board ticks the side on a blank form', () => assert.equal(fillPatch(blank(), sb).leaverSide, 'theirs'));
  test("Sean's pick is never replaced, even in overwrite mode", () => {
    assert.equal(fillPatch(blank({ leaverSide: 'mine' }), sb).leaverSide, undefined);
    assert.equal(fillPatch(blank({ leaverSide: 'mine' }), sb, { overwrite: true }).leaverSide, undefined);
  });
  test('no side from the board (full board, or both sides equally short) leaves the form alone', () => {
    assert.equal(fillPatch(blank(), fill).leaverSide, undefined);
    assert.equal(fillPatch(blank(), { ...fill, leaver_side: null, short_board: true }).leaverSide, undefined);
  });
});

describe('fillPatch', () => {
  test('empty form takes everything', () => {
    const p = fillPatch(blank(), fill);
    assert.equal(p.map, 'Nepal'); assert.equal(p.hero, 'Tracer'); assert.deepEqual(p.switchHeroes, ['Pharah', '']);
    assert.equal(p.win, '0'); assert.equal(p.scoreUs, '0'); assert.equal(p.scoreThem, '2');
    assert.equal(p.aimOpen, true);
    assert.equal(p.aimStats!.elims, '11'); assert.equal(p.aimStats!.damage, '6347');
    assert.equal(p.aimStats!.healing, '', 'DPS roster: healing stays empty');
    const t = p.aimStats!.heroAcc[0];
    assert.deepEqual([t.hero, t.duration_min, t.overall_acc, t.crit_acc, t.extra_acc], ['Tracer', '5:28', '33', '10', '0']);
    assert.deepEqual([p.aimStats!.heroAcc[1].hero, p.aimStats!.heroAcc[1].crit_acc], ['Pharah', '21']);
  });
  test('Pre-Match picks stay: map and hero already set are not overwritten', () => {
    const p = fillPatch(blank({ map: 'Numbani', hero: 'Tracer' }), fill);
    assert.equal(p.map, undefined); assert.equal(p.hero, undefined); assert.equal(p.win, '0');
  });
  test('a typed value is never overwritten, a typed 0 stays', () => {
    const a = emptyStats([{ hero: 'Tracer' }, { hero: 'Pharah' }]); a.elims = '9'; a.heroAcc[0].extra_acc = '3';
    const p = fillPatch(blank({ hero: 'Tracer', switchHeroes: ['Pharah', ''], aimStats: a, win: '1', scoreUs: '1', scoreThem: '1' }), fill);
    assert.equal(p.aimStats!.elims, '9'); assert.equal(p.aimStats!.heroAcc[0].extra_acc, '3');
    assert.equal(p.win, undefined); assert.equal(p.scoreUs, undefined);
  });
  test('3847: picker Ashe, scoreboard Pharah 97 / Ashe 3 fills both heroes, Pharah takes a switch slot, no marker', () => {
    const f3: FormFill = { ...fill, heroes: [hero('Pharah', { percent: 97, duration: '8:00', overall_acc: 40, mapped: true }), hero('Ashe', { percent: 3, duration: '0:15' })] };
    const p = fillPatch(blank({ hero: 'Ashe' }), f3);
    assert.equal(p.hero, undefined, 'start hero stays');
    assert.deepEqual(p.switchHeroes, ['Pharah', '']);
    assert.equal(p.aimStats!.elims, '11');
    assert.deepEqual(p.aimStats!.heroAcc.map(r => [r.hero, r.duration_min]), [['Ashe', '0:15'], ['Pharah', '8:00']]);
    assert.equal(heroMismatch(['Ashe', ...p.switchHeroes!], f3), null);
  });
  test('a picked hero missing from the scoreboard still fills stats and raises the marker', () => {
    const p = fillPatch(blank({ hero: 'Reaper' }), fill);
    assert.equal(p.hero, undefined); assert.equal(p.aimStats!.elims, '11'); assert.equal(p.win, '0');
    assert.deepEqual(p.switchHeroes, ['Tracer', 'Pharah']);
    const m = heroMismatch(['Reaper', ...p.switchHeroes!], fill)!;
    assert.deepEqual([m.notOnBoard, m.notPicked], [['Reaper'], []]);
  });
  test('scoreboard hero with no free slot gets no accuracy row and is named by the marker', () => {
    const p = fillPatch(blank({ hero: 'Reaper', switchHeroes: ['Genji', 'Sombra'] }), fill);
    assert.equal(p.switchHeroes, undefined);
    assert.deepEqual(p.aimStats!.heroAcc.map(r => r.hero), ['Reaper', 'Genji', 'Sombra']);
    assert.deepEqual(heroMismatch(['Reaper', 'Genji', 'Sombra'], fill)!.notPicked, ['Tracer', 'Pharah']);
  });
  test('filled switch slots are never overwritten by the auto-fill', () => {
    const p = fillPatch(blank({ hero: 'Tracer', switchHeroes: ['Genji', ''] }), fill);
    assert.deepEqual(p.switchHeroes, ['Genji', 'Pharah']);
  });
  test('overwrite: scoreboard fields replace typed ones, start hero stays, nothing outside the scoreboard is in the patch', () => {
    const a = emptyStats([{ hero: 'Tracer' }, { hero: 'Pharah' }]); a.elims = '9'; a.heroAcc[0].extra_acc = '3'; a.heroAcc[0].overall_acc = '99';
    const p = fillPatch(blank({ hero: 'Tracer', switchHeroes: ['Genji', ''], aimStats: a, map: 'Numbani', win: '1', scoreUs: '1', scoreThem: '1' }), fill, { overwrite: true });
    assert.equal(p.hero, undefined);
    assert.deepEqual(p.switchHeroes, ['Pharah', '']);
    assert.equal(p.map, 'Nepal'); assert.equal(p.win, '0'); assert.deepEqual([p.scoreUs, p.scoreThem], ['0', '2']);
    assert.equal(p.aimStats!.elims, '11'); assert.equal(p.aimStats!.heroAcc[0].extra_acc, '0'); assert.equal(p.aimStats!.heroAcc[0].overall_acc, '33');
    assert.deepEqual(Object.keys(p).sort(), ['aimOpen', 'aimStats', 'map', 'scoreThem', 'scoreUs', 'switchHeroes', 'win']);
  });
  test('a hero outside the tile map keeps blank accuracy slots', () => {
    const f2: FormFill = { ...fill, heroes: [hero('Reaper', { duration: '4:00' })] };
    const p = fillPatch(blank(), f2);
    assert.deepEqual([p.aimStats!.heroAcc[0].duration_min, p.aimStats!.heroAcc[0].overall_acc], ['4:00', '']);
  });
  test('signature changes when a page lands', () => {
    assert.notEqual(fillSignature(fill), fillSignature({ ...fill, pages: { ...fill.pages, personal: ['Tracer'] } }));
  });
});

describe('fillPatch / rankPageSupplies: rank page', () => {
  // Screenshot (114): PLATINUM 3 (18) at 25% after +44% -> started Platinum 4 (17) at 81%.
  const win: FormFill = { ...fill, win: 1, rank: { rank_int: 18, progress_pct: 25, delta_pct: 44, result: 'victory', start_rank_int: 17, start_progress_pct: 81 } };
  test('the fill never carries a rank: the drum and player_ranks are not the scoreboard\'s to set', () => {
    const p = fillPatch(blank(), win, { overwrite: true }) as Record<string, unknown>;
    for (const k of ['playerRank', 'rankOutcome', 'rankStart']) assert.equal(k in p, false, k);
  });
  test('a rank page supplies the match rank only while the rank field is fillable', () => {
    assert.equal(rankPageSupplies(true, win), true);
    assert.equal(rankPageSupplies(false, win), false, 'quick play, placement or rank field off');
  });
  test('no rank page, no fill, or a result that disagrees: nothing supplied', () => {
    assert.equal(rankPageSupplies(true, fill), false);
    assert.equal(rankPageSupplies(true, null), false);
    assert.equal(rankPageSupplies(true, { ...win, win: 0 }), false, 'victory page on a lost scoreboard is a wrong link');
  });
  test('a late rank page changes the signature so the form fills again', () => {
    assert.notEqual(fillSignature(fill), fillSignature(win));
    assert.equal(fillSignature(win), fillSignature({ ...win }));
  });
});
