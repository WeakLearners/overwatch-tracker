import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-assets-'));
process.env.OW_DATA_DIR = tmp;

import { downloadHeroImages, cachedHeroKeys, missingHeroImages, imagesEnabled } from './assets';
import { parsePortraits } from './blizzardUpdates';
import type { Roster } from './roster';

const roster: Roster = { heroes: ['Ana', 'Lúcio', 'Soldier: 76', 'Ghost'].map(name => ({ name, role: 'DPS', addedSeason: null })), maps: [] };
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.from('data')]);
const OK = 'https://d15f34w2p8l1cc.cloudfront.net/overwatch/x.png';
const page = (n: string) => ({ name: n, url: OK });

beforeEach(() => { fs.rmSync(path.join(tmp, 'assets'), { recursive: true, force: true }); delete process.env.OW_BLIZZARD_IMAGES; });
afterEach(() => { delete process.env.OW_BLIZZARD_IMAGES; });

describe('downloadHeroImages', () => {
  test('matches by accent-free name key, saves PNGs, reports unmatched heroes', async () => {
    const r = await downloadHeroImages(roster, [page('Ana'), page('Lucio'), page('Soldier: 76')], async () => PNG);
    assert.deepEqual([r.matched, r.total, r.downloaded], [3, 4, 3]);
    assert.deepEqual(r.unmatched, ['Ghost']);
    assert.deepEqual(cachedHeroKeys().sort(), ['ana', 'lucio', 'soldier76']);
    assert.deepEqual(missingHeroImages(roster), ['Ghost']);
  });
  test('rejects a host that is not Blizzard\'s, and a body that is not a PNG', async () => {
    const r = await downloadHeroImages(roster, [{ name: 'Ana', url: 'https://evil.example/a.png' }, page('Lúcio')], async () => Buffer.from('<html>'));
    assert.deepEqual(r.failed.sort(), ['Ana', 'Lúcio']);
    assert.equal(r.downloaded, 0);
    assert.deepEqual(cachedHeroKeys(), []);
  });
  test('the off switch downloads nothing', async () => {
    process.env.OW_BLIZZARD_IMAGES = 'off';
    assert.equal(imagesEnabled(), false);
    const r = await downloadHeroImages(roster, [page('Ana')], async () => PNG);
    assert.equal(r.downloaded, 0);
    assert.deepEqual(cachedHeroKeys(), []);
  });
});

test('parsePortraits reads the card portrait, not the role icon or card background', () => {
  const html = '<a class="hero-card" data-role="support" href="/heroes/ana"><blz-card icon="https://blz-contentstack-images.akamaized.net/role.svg"><blz-image class="heroCardPortrait" alt="ana" slot="media" src="https://d15f34w2p8l1cc.cloudfront.net/overwatch/ana.png" style="--cardbg:url(https://x/bg.jpg);"></blz-image><h2 slot="heading">Ana</h2></blz-card></a>';
  assert.deepEqual(parsePortraits(html), [{ name: 'Ana', url: 'https://d15f34w2p8l1cc.cloudfront.net/overwatch/ana.png' }]);
});
