import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseHeroes, parseMaps, parseSeason, buildDiff, checkForUpdates, LayoutChangedError, nameKey } from './blizzardUpdates';
import type { Roster } from './roster';
import type { Season } from './seasons';

const heroCard = (name: string, role: string) =>
  `<a class="hero-card" data-role="${role}" data-subrole="x" href="/heroes/${name.toLowerCase()}" id="${name}"><blz-image></blz-image><h2 slot="heading">${name}</h2></a>`;
const heroesPage = (extra: string[] = []) =>
  '<html>' + Array.from({ length: 24 }, (_, i) => heroCard(`Hero${i}`, i % 3 === 0 ? 'tank' : i % 3 === 1 ? 'damage' : 'support')).join('') + extra.join('') + '</html>';
const ratesPage = (maps: Record<string, string[]>) =>
  '<select id="filter-map-select"><option data-title="all_maps" value="all-maps">All Maps</option>' +
  Object.entries(maps).map(([mode, ms]) => `<optgroup label="${mode}">${ms.map(m => `<option data-title="${m}" value="x">${m}</option>`).join('')}</optgroup>`).join('') + '</select>';
const ELEVEN = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10', 'Esperan&#xE7;a'];

const roster: Roster = {
  heroes: Array.from({ length: 24 }, (_, i) => ({ name: `Hero${i}`, role: 'DPS', addedSeason: null })),
  maps: [...ELEVEN.slice(0, 10), 'Esperanca', 'Gone Map'].map(name => ({ name, short: name, mode: 'Control', retired: false })),
};
const seasons: Season[] = [{ label: '2026 S4', start: '2026-08-11', end: '2026-10-06' }, { label: '2026 S5', start: '2026-10-06', end: null }];

describe('parsers', () => {
  test('parseHeroes reads name and role from hero cards', () => {
    const h = parseHeroes(heroesPage([heroCard('Doctrine', 'support')]));
    assert.equal(h.length, 25);
    assert.deepEqual(h[0], { name: 'Hero0', role: 'Tank' });
    assert.deepEqual(h[24], { name: 'Doctrine', role: 'Support' });
  });
  test('parseHeroes refuses a page with no hero cards', () => {
    assert.throws(() => parseHeroes('<html>new layout</html>'), LayoutChangedError);
  });
  test('parseMaps reads names and modes from the optgroups, skipping "All Maps"', () => {
    const m = parseMaps(ratesPage({ Control: ELEVEN.slice(0, 6), Escort: ELEVEN.slice(6) }));
    assert.equal(m.length, 11);
    assert.deepEqual(m[10], { name: 'Esperança', mode: 'Escort' });
  });
  test('parseMaps refuses a page with no map select', () => {
    assert.throws(() => parseMaps('<html></html>'), LayoutChangedError);
  });
  test('parseSeason takes the highest numbered season named on the page', () => {
    const s = parseSeason('<h3>Feed Your Hunger in Reign of Talon – Season 5: A Grim Doctrine</h3><h3>Season 4 Midcycle Takes You</h3><h3>Season 4: Old Name</h3>');
    assert.deepEqual(s, { number: 5, name: 'A Grim Doctrine' });
    assert.equal(parseSeason('<html></html>'), null);
  });
});

describe('buildDiff', () => {
  const page = (season: { number: number; name: string } | null) => ({
    heroes: [...parseHeroes(heroesPage([heroCard('Doctrine', 'support')]))],
    maps: parseMaps(ratesPage({ Control: ELEVEN.slice(0, 6), Escort: ELEVEN.slice(6) })),
    season,
  });
  test('reports a new hero, a map absent from Blizzard, and no new season when numbers match', () => {
    const d = buildDiff(roster, seasons, page({ number: 5, name: 'A Grim Doctrine' }), '2026-10-06');
    assert.deepEqual(d.newHeroes, [{ name: 'Doctrine', role: 'Support' }]);
    assert.deepEqual(d.newMaps, []);          // Esperança matches Esperanca
    assert.deepEqual(d.absentMaps, ['Gone Map']);
    assert.equal(d.newSeason, null);
  });
  test('a retired map is not reported as absent', () => {
    const r = { ...roster, maps: roster.maps.map(m => (m.name === 'Gone Map' ? { ...m, retired: true } : m)) };
    assert.deepEqual(buildDiff(r, seasons, page(null), '2026-10-06').absentMaps, []);
  });
  test('a higher season number is a new season starting today', () => {
    const d = buildDiff(roster, seasons, page({ number: 6, name: 'Next' }), '2026-12-09');
    assert.deepEqual(d.newSeason, { label: '2026 S6', name: 'Next', start: '2026-12-09' });
  });
  test('nameKey ignores accents, case and punctuation', () => {
    assert.equal(nameKey('Esperança'), nameKey('esperanca'));
    assert.equal(nameKey('Soldier: 76'), nameKey('Soldier 76'));
  });
});

describe('checkForUpdates', () => {
  test('a failed parse throws and returns no partial diff', async () => {
    const fetcher = async (u: string) => (u.includes('/heroes/') ? '<html>changed</html>' : ratesPage({ Control: ELEVEN }));
    await assert.rejects(checkForUpdates(roster, seasons, '2026-10-06', fetcher), LayoutChangedError);
  });
});
