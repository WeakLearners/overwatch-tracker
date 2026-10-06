// Tier 3: /api/roster over real HTTP — the roster/season data files, the
// update check (Blizzard faked, never the network) and the confirmed apply.
import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-data-'));
const real = path.resolve(__dirname, '../../data');
process.env.OW_DATA_DIR = tmp;

import { startHarness, type Harness } from '../test/httpHarness';
import { setRosterFetcher } from './roster';
import { syncRosterViews, HEROES_BY_ROLE, MAPS_BY_NAME } from '../lib/roster';
import { loadSeasons, SEASONS } from '../lib/seasons';

let h: Harness;
beforeEach(async () => {
  for (const f of ['roster.json', 'seasons.json']) fs.copyFileSync(path.join(real, f), path.join(tmp, f));
  syncRosterViews(); loadSeasons();
  h = await startHarness();
});
afterEach(async () => { setRosterFetcher(undefined); await h.close(); });

const card = (n: string, r: string) => `<a class="hero-card" data-role="${r}" href="/heroes/x"><h2 slot="heading">${n}</h2></a>`;
function fakeBlizzard(opts: { newHero?: boolean; season?: number; breakHeroes?: boolean } = {}) {
  const r = JSON.parse(fs.readFileSync(path.join(tmp, 'roster.json'), 'utf8'));
  const role = (x: string) => ({ DPS: 'damage', Tank: 'tank', Support: 'support' } as any)[x];
  setRosterFetcher(async url => {
    if (url.includes('/heroes/')) {
      if (opts.breakHeroes) return '<html>new layout</html>';
      return r.heroes.map((x: any) => card(x.name, role(x.role))).join('') + (opts.newHero ? card('Doctrine', 'support') : '');
    }
    if (url.includes('/rates/')) {
      const open = r.maps.filter((m: any) => !m.retired);
      return '<select id="filter-map-select">' + ['Control', 'Hybrid', 'Escort', 'Push', 'Flashpoint'].map(mode =>
        `<optgroup label="${mode}">${open.filter((m: any) => m.mode === mode).map((m: any) => `<option data-title="${m.name}">x</option>`).join('')}</optgroup>`).join('') + '</select>';
    }
    return `<h3>Season ${opts.season ?? 5}: Some Name</h3>`;
  });
}

describe('GET /api/roster', () => {
  test('returns heroes, maps and seasons; Throne of Anubis is retired but still listed', async () => {
    const r = await h.get('/api/roster');
    assert.equal(r.status, 200);
    assert.equal(r.body.heroes.length, 53);
    assert.equal(r.body.maps.find((m: any) => m.name === 'Throne of Anubis').retired, true);
    assert.equal(r.body.seasons.at(-1).label, '2026 S5');
  });
});

describe('POST /api/roster/check', () => {
  test('a clean Blizzard page with nothing new gives an empty diff and writes nothing', async () => {
    fakeBlizzard();
    const before = fs.readFileSync(path.join(tmp, 'roster.json'), 'utf8');
    const r = await h.post('/api/roster/check');
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.newHeroes, r.body.newMaps, r.body.absentMaps, r.body.newSeason], [[], [], [], null]);
    assert.equal(fs.readFileSync(path.join(tmp, 'roster.json'), 'utf8'), before);
  });
  test('reports a new hero and a new season', async () => {
    fakeBlizzard({ newHero: true, season: 6 });
    const r = await h.post('/api/roster/check');
    assert.deepEqual(r.body.newHeroes, [{ name: 'Doctrine', role: 'Support' }]);
    assert.equal(r.body.newSeason.label.endsWith(' S6'), true);
  });
  test('a layout change is a 502 with the clear message and writes nothing', async () => {
    fakeBlizzard({ breakHeroes: true });
    const before = fs.readFileSync(path.join(tmp, 'roster.json'), 'utf8');
    const r = await h.post('/api/roster/check');
    assert.equal(r.status, 502);
    assert.match(r.body.error, /layout changed — no updates read/);
    assert.equal(fs.readFileSync(path.join(tmp, 'roster.json'), 'utf8'), before);
  });
});

describe('POST /api/roster/apply', () => {
  test('writes a ticked hero and season, and the server views update without a restart', async () => {
    const r = await h.post('/api/roster/apply', { heroes: [{ name: 'Doctrine', role: 'Support' }], season: { label: '2026 S6', start: '2026-12-09' } });
    assert.equal(r.status, 200);
    assert.ok(HEROES_BY_ROLE.Support.includes('Doctrine'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'roster.json'), 'utf8')).heroes.find((x: any) => x.name === 'Doctrine').addedSeason, '2026 S6');
    const s = JSON.parse(fs.readFileSync(path.join(tmp, 'seasons.json'), 'utf8'));
    assert.deepEqual(s.slice(-2), [{ label: '2026 S5', start: '2026-10-06', end: '2026-12-09' }, { label: '2026 S6', start: '2026-12-09', end: null }]);
    assert.equal(SEASONS.at(-1)!.label, '2026 S6');
  });
  test('a hero without a valid role rejects the whole request; nothing is written', async () => {
    const before = fs.readFileSync(path.join(tmp, 'roster.json'), 'utf8');
    const r = await h.post('/api/roster/apply', { heroes: [{ name: 'Doctrine', role: 'Healer' }], season: { label: '2026 S6', start: '2026-12-09' } });
    assert.equal(r.status, 400);
    assert.equal(fs.readFileSync(path.join(tmp, 'roster.json'), 'utf8'), before);
    assert.equal(SEASONS.at(-1)!.label, '2026 S5');
  });
  test('a duplicate hero, a bad season date and an unknown retire target are rejected', async () => {
    assert.equal((await h.post('/api/roster/apply', { heroes: [{ name: 'Ana', role: 'Support' }] })).status, 400);
    assert.equal((await h.post('/api/roster/apply', { season: { label: '2026 S6', start: '2026-10-06' } })).status, 400);
    assert.equal((await h.post('/api/roster/apply', { retireMaps: ['Nowhere'] })).status, 400);
  });
  test('retiring a ticked map keeps it in MAPS_BY_NAME', async () => {
    await h.post('/api/roster/apply', { retireMaps: ['Busan'] });
    assert.equal(MAPS_BY_NAME.Busan, 'Control');
    assert.equal(JSON.parse(fs.readFileSync(path.join(tmp, 'roster.json'), 'utf8')).maps.find((m: any) => m.name === 'Busan').retired, true);
  });
});

describe('portraits', () => {
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('x')]);
  const page = () => JSON.parse(fs.readFileSync(path.join(tmp, 'roster.json'), 'utf8')).heroes
    .map((x: any) => `<a class="hero-card" data-role="damage" href="/h"><blz-image class="heroCardPortrait" slot="media" src="https://d15f34w2p8l1cc.cloudfront.net/o/${x.name.length}.png"></blz-image><h2 slot="heading">${x.name}</h2></a>`).join('');
  beforeEach(() => fs.rmSync(path.join(tmp, 'assets'), { recursive: true, force: true }));

  test('apply with images:true caches portraits; /api/roster then lists them; the check counts the rest as missing', async () => {
    assert.equal((await h.get('/api/roster')).body.images.heroes.length, 0);
    setRosterFetcher(async () => page(), async () => PNG);
    const r = await h.post('/api/roster/apply', { images: true });
    assert.equal(r.status, 200);
    assert.deepEqual([r.body.images.downloaded, r.body.images.matched, r.body.images.total], [53, 53, 53]);
    const g = await h.get('/api/roster');
    assert.equal(g.body.images.heroes.length, 53);
    assert.ok(g.body.images.heroes.includes('dva') && g.body.images.heroes.includes('soldier76'));
  });
  test('with OW_BLIZZARD_IMAGES=off nothing is downloaded or listed', async () => {
    process.env.OW_BLIZZARD_IMAGES = 'off';
    try {
      setRosterFetcher(async () => page(), async () => PNG);
      const r = await h.post('/api/roster/apply', { images: true });
      assert.equal(r.body.images, null);
      assert.deepEqual((await h.get('/api/roster')).body.images, { enabled: false, heroes: [] });
    } finally { delete process.env.OW_BLIZZARD_IMAGES; }
  });
});

describe('roster data matches the old hard-coded shapes', () => {
  test('HEROES_BY_ROLE counts and MAPS_BY_NAME size', () => {
    assert.deepEqual(Object.fromEntries(Object.entries(HEROES_BY_ROLE).map(([k, v]) => [k, v.length])), { DPS: 24, Support: 14, Tank: 15 });
    assert.equal(Object.keys(MAPS_BY_NAME).length, 31);
  });
});
